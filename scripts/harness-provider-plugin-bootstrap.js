#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
const {
  CODEX_SKILL_NAMES,
  INVENTORY_SHA256,
} = require('./lib/managed-plugin-inventory');

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertDirectory(target, label) {
  if (!path.isAbsolute(target)) throw new Error(`${label} must be absolute`);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return fs.realpathSync.native(target);
}

function assertPathChainNoSymlinks(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside its trusted root`);
  }
  let cursor = root;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symbolic link: ${cursor}`);
  }
}

function assertNoSymlinks(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`provider plugin state contains a symbolic link: ${root}`);
  if (!stat.isDirectory()) return;
  for (const name of fs.readdirSync(root)) assertNoSymlinks(path.join(root, name));
}

function treeSha256(root) {
  const base = assertDirectory(root, 'plugin tree');
  const records = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(base, absolute).replace(/\\/g, '/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`plugin tree contains a symbolic link: ${absolute}`);
      if (stat.isDirectory()) {
        records.push(`d:${relative}`);
        walk(absolute);
      } else if (stat.isFile()) {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        records.push(`f:${relative}:${digest}`);
      } else {
        throw new Error(`plugin tree contains an unsupported entry: ${absolute}`);
      }
    }
  }
  walk(base);
  return crypto.createHash('sha256').update(records.join('\n')).digest('hex');
}

function readJson(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function writeBootstrapReceipt(file, receipt, options = {}) {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  assertDirectory(parent, 'bootstrap receipt parent');
  assertPathChainNoSymlinks(path.parse(parent).root, parent, 'bootstrap receipt parent');
  if (fs.existsSync(absolute)) {
    if (options.replace !== true) throw new Error('bootstrap receipt already exists');
    const existing = fs.lstatSync(absolute);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
      throw new Error('existing bootstrap receipt must be one regular unlinked file');
    }
    fs.unlinkSync(absolute);
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(absolute, flags, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform !== 'win32') fs.chmodSync(absolute, 0o600);
}

function validateRuntimeSource(runtimeRoot, requireImmutableRuntime) {
  const realRuntimeRoot = assertDirectory(runtimeRoot, 'runtime root');
  const runtimeStat = fs.statSync(realRuntimeRoot);
  if (requireImmutableRuntime && (runtimeStat.uid !== 0 || (runtimeStat.mode & 0o022) !== 0)) {
    throw new Error('runtime root must be root-owned and not group/world writable');
  }
  const marketplacePath = path.join(realRuntimeRoot, '.agents', 'plugins', 'marketplace.json');
  assertPathChainNoSymlinks(realRuntimeRoot, marketplacePath, 'runtime marketplace manifest');
  const marketplace = readJson(marketplacePath, 'runtime marketplace manifest');
  if (marketplace.name !== 'tech-persistence-local' || !Array.isArray(marketplace.plugins)) {
    throw new Error('runtime marketplace manifest has an unexpected identity');
  }
  const entry = marketplace.plugins.find((item) => item && item.name === 'tech-persistence');
  if (!entry || !entry.source || entry.source.source !== 'local' || typeof entry.source.path !== 'string') {
    throw new Error('runtime marketplace is missing the local tech-persistence plugin');
  }
  const pluginRoot = path.resolve(realRuntimeRoot, entry.source.path);
  if (!isPathInside(realRuntimeRoot, pluginRoot)) {
    throw new Error('runtime marketplace plugin source resolves outside runtime root');
  }
  assertPathChainNoSymlinks(realRuntimeRoot, pluginRoot, 'runtime plugin root');
  const realPluginRoot = assertDirectory(pluginRoot, 'runtime plugin root');
  if (!isPathInside(realRuntimeRoot, realPluginRoot)) {
    throw new Error('runtime marketplace plugin source resolves outside runtime root');
  }
  // Reject linked content before the plugin CLI consumes any source-controlled path.
  assertNoSymlinks(realPluginRoot);
  const manifest = readJson(
    path.join(realPluginRoot, '.codex-plugin', 'plugin.json'),
    'runtime plugin manifest'
  );
  if (manifest.name !== 'tech-persistence' || typeof manifest.version !== 'string') {
    throw new Error('runtime plugin manifest has an unexpected identity');
  }
  validateSkillInventory(realPluginRoot, 'runtime plugin');
  return { realRuntimeRoot, realPluginRoot, marketplace, manifest };
}

function validateSkillInventory(pluginRoot, label) {
  const skillRoot = path.join(pluginRoot, 'codex-skills');
  const stat = fs.lstatSync(skillRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} codex-skills must be a directory`);
  const actual = fs.readdirSync(skillRoot, { withFileTypes: true }).map((entry) => {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`${label} contains an unsupported codex-skills entry: ${entry.name}`);
    }
    const skillFile = path.join(skillRoot, entry.name, 'SKILL.md');
    const skillStat = fs.lstatSync(skillFile);
    if (skillStat.isSymbolicLink() || !skillStat.isFile()) {
      throw new Error(`${label} skill is missing a regular SKILL.md: ${entry.name}`);
    }
    return entry.name;
  }).sort();
  const missing = CODEX_SKILL_NAMES.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !CODEX_SKILL_NAMES.includes(name));
  if (missing.length || extra.length) {
    throw new Error(`${label} skill inventory mismatch; missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'}`);
  }
}

function runCodexPluginCli(codexCliPath, args, env, spawnSyncImpl, stage) {
  const result = spawnSyncImpl(process.execPath, [codexCliPath, ...args], {
    encoding: 'utf8',
    env,
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`${stage} failed to start: ${result.error.message}`);
  if (result.signal || result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 512);
    throw new Error(
      `${stage} failed with exit ${String(result.status)}${result.signal ? ` signal ${result.signal}` : ''}`
      + (diagnostic ? `: ${diagnostic}` : '')
    );
  }
  try {
    return JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw new Error(`${stage} returned invalid JSON: ${error.message}`);
  }
}

function findInstalledPluginRoots(root, matches = []) {
  if (!fs.existsSync(root)) return matches;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`installed plugin cache contains a symbolic link: ${root}`);
  if (!stat.isDirectory()) return matches;
  const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = readJson(manifestPath, 'installed plugin manifest');
    if (manifest.name === 'tech-persistence') matches.push({ root, manifest });
    return matches;
  }
  for (const name of fs.readdirSync(root)) findInstalledPluginRoots(path.join(root, name), matches);
  return matches;
}

function inspectProviderPluginState(options) {
  if (!options || typeof options !== 'object') throw new TypeError('provider plugin inspection options are required');
  const providerHome = assertDirectory(path.resolve(options.providerHome), 'provider home');
  const source = validateRuntimeSource(
    path.resolve(options.runtimeRoot),
    options.requireImmutableRuntime === true
  );
  if (isPathInside(source.realRuntimeRoot, providerHome)) {
    throw new Error('provider home must be outside the immutable runtime root');
  }
  const codexHome = assertDirectory(path.join(providerHome, '.codex'), 'provider Codex home');
  const pluginStateRoot = path.join(codexHome, 'plugins');
  assertNoSymlinks(pluginStateRoot);
  const installed = findInstalledPluginRoots(path.join(pluginStateRoot, 'cache'));
  if (installed.length !== 1) {
    throw new Error(`installed plugin cache must contain exactly one tech-persistence plugin; found ${installed.length}`);
  }
  if (installed[0].manifest.version !== source.manifest.version) {
    throw new Error('installed plugin version does not match the immutable runtime source');
  }
  validateSkillInventory(installed[0].root, 'installed plugin');
  const sourcePluginSha256 = treeSha256(source.realPluginRoot);
  const installedPluginSha256 = treeSha256(installed[0].root);
  if (installedPluginSha256 !== sourcePluginSha256) {
    throw new Error('installed plugin bytes do not match the immutable runtime source');
  }
  return Object.freeze({
    schemaVersion: 'harness-provider-plugin-bootstrap-v1',
    pluginName: 'tech-persistence',
    marketplace: 'tech-persistence-local',
    version: source.manifest.version,
    inventorySha256: INVENTORY_SHA256,
    pluginSha256: sourcePluginSha256,
    installedPluginRoot: path.relative(providerHome, installed[0].root).replace(/\\/g, '/'),
  });
}

function verifyProviderPluginReceipt(options) {
  const expected = inspectProviderPluginState(options);
  const receiptStat = fs.lstatSync(path.resolve(options.receiptPath));
  if (receiptStat.isSymbolicLink() || !receiptStat.isFile() || receiptStat.nlink !== 1) {
    throw new Error('provider plugin bootstrap receipt must be one regular unlinked file');
  }
  const receipt = readJson(path.resolve(options.receiptPath), 'provider plugin bootstrap receipt');
  if (!isDeepStrictEqual(receipt, expected)) {
    throw new Error('provider plugin bootstrap receipt does not match installed plugin state');
  }
  return expected;
}

function bootstrapProviderPlugin(options) {
  if (!options || typeof options !== 'object') throw new TypeError('bootstrap options are required');
  const providerHome = assertDirectory(path.resolve(options.providerHome), 'provider home');
  const codexCliPath = path.resolve(options.codexCliPath);
  const source = validateRuntimeSource(
    path.resolve(options.runtimeRoot),
    options.requireImmutableRuntime === true
  );
  if (isPathInside(source.realRuntimeRoot, providerHome)) {
    throw new Error('provider home must be outside the immutable runtime root');
  }
  const codexHome = path.join(providerHome, '.codex');
  if (!fs.existsSync(codexHome)) {
    fs.mkdirSync(codexHome, { recursive: false, mode: 0o700 });
  } else {
    const codexHomeStat = fs.lstatSync(codexHome);
    if (codexHomeStat.isSymbolicLink() || !codexHomeStat.isDirectory()) {
      throw new Error('provider Codex home must be a real directory');
    }
  }
  const resetEntries = [
    'plugins',
    'config.toml',
    'tech-persistence-bootstrap.json',
    'skills',
    'agents',
    'AGENTS.md',
    'hooks.json',
  ];
  for (const relative of resetEntries) {
    const target = path.join(codexHome, relative);
    if (!fs.existsSync(target)) continue;
    assertNoSymlinks(target);
    fs.rmSync(target, { recursive: true, force: false });
  }

  const env = {
    ...process.env,
    HOME: providerHome,
    USERPROFILE: providerHome,
    CODEX_HOME: codexHome,
  };
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  runCodexPluginCli(
    codexCliPath,
    ['plugin', 'marketplace', 'add', source.realRuntimeRoot, '--json'],
    env,
    spawnSyncImpl,
    'plugin marketplace add'
  );
  runCodexPluginCli(
    codexCliPath,
    ['plugin', 'add', 'tech-persistence@tech-persistence-local', '--json'],
    env,
    spawnSyncImpl,
    'plugin add'
  );
  const listed = runCodexPluginCli(
    codexCliPath,
    ['plugin', 'list', '--json'],
    env,
    spawnSyncImpl,
    'plugin list readback'
  );
  const installedEntries = Array.isArray(listed)
    ? listed
    : (listed && Array.isArray(listed.installed) ? listed.installed : []);
  const listedOwners = installedEntries.filter((entry) => (
    entry
    && entry.name === 'tech-persistence'
    && entry.installed !== false
    && entry.enabled !== false
    && (
      entry.pluginId === 'tech-persistence@tech-persistence-local'
      || entry.marketplaceName === 'tech-persistence-local'
      || entry.marketplace === 'tech-persistence-local'
    )
  ));
  if (listedOwners.length !== 1) {
    throw new Error('plugin list readback did not confirm tech-persistence@tech-persistence-local');
  }

  const receipt = inspectProviderPluginState({
    providerHome,
    runtimeRoot: source.realRuntimeRoot,
    requireImmutableRuntime: options.requireImmutableRuntime === true,
  });
  writeBootstrapReceipt(path.join(codexHome, 'tech-persistence-bootstrap.json'), receipt);
  return Object.freeze(receipt);
}

function parseCli(argv, required, optional = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith('--') || value === undefined) throw new Error('invalid bootstrap CLI arguments');
    options[key.slice(2)] = value;
  }
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(options).some((key) => !allowed.has(key))
      || required.some((key) => !Object.prototype.hasOwnProperty.call(options, key))) {
    throw new Error('invalid provider plugin bootstrap arguments');
  }
  return options;
}

function main() {
  const argv = process.argv.slice(2);
  let result;
  if (argv[0] === 'verify') {
    const options = parseCli(argv.slice(1), ['provider-home', 'runtime-root', 'receipt']);
    result = verifyProviderPluginReceipt({
      providerHome: options['provider-home'],
      runtimeRoot: options['runtime-root'],
      receiptPath: options.receipt,
      requireImmutableRuntime: true,
    });
  } else {
    const options = parseCli(
      argv,
      ['provider-home', 'runtime-root', 'codex-cli'],
      ['require-immutable-runtime', 'output-receipt']
    );
    if (options['require-immutable-runtime'] !== undefined
        && options['require-immutable-runtime'] !== 'true') {
      throw new Error('--require-immutable-runtime only accepts true');
    }
    result = bootstrapProviderPlugin({
      providerHome: options['provider-home'],
      runtimeRoot: options['runtime-root'],
      codexCliPath: options['codex-cli'],
      requireImmutableRuntime: options['require-immutable-runtime'] === 'true',
    });
    if (options['output-receipt']) {
      writeBootstrapReceipt(options['output-receipt'], result, { replace: true });
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`provider plugin bootstrap failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  bootstrapProviderPlugin,
  findInstalledPluginRoots,
  inspectProviderPluginState,
  validateRuntimeSource,
  validateSkillInventory,
  verifyProviderPluginReceipt,
  writeBootstrapReceipt,
  treeSha256,
};
