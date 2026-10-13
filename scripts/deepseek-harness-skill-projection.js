#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CODEX_SKILL_NAMES,
  INVENTORY_SHA256,
} = require('./lib/managed-plugin-inventory');

const OWNER = 'tech-persistence';
const PROJECTION = 'deepseek-harness-skills';
const RECEIPT_FILE = '.tech-persistence-projection.json';
const LOCK_FILE = '.tech-persistence-projection.lock';
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class DeepSeekHarnessSkillProjectionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'DeepSeekHarnessSkillProjectionError';
    this.code = code;
  }
}

function projectionError(code, message, options) {
  return new DeepSeekHarnessSkillProjectionError(code, message, options);
}

function defaultOptions() {
  const repoRoot = path.resolve(__dirname, '..');
  return {
    sourceRoot: path.join(repoRoot, 'plugins', OWNER, 'codex-skills'),
    pluginManifestPath: path.join(repoRoot, 'plugins', OWNER, '.codex-plugin', 'plugin.json'),
    targetRoot: path.join(os.homedir(), '.dsh', 'skills'),
  };
}

function normalizedOptions(options = {}) {
  const defaults = defaultOptions();
  return {
    sourceRoot: path.resolve(options.sourceRoot || defaults.sourceRoot),
    pluginManifestPath: path.resolve(options.pluginManifestPath || defaults.pluginManifestPath),
    targetRoot: path.resolve(options.targetRoot || defaults.targetRoot),
    now: options.now || new Date().toISOString(),
  };
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertPlainDirectory(target, label, code) {
  const info = lstatIfPresent(target);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw projectionError(code, `${label} must be a plain directory: ${target}`);
  }
  return info;
}

function readJsonFile(target, label, code, maxBytes = MAX_RECEIPT_BYTES) {
  const info = lstatIfPresent(target);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw projectionError(code, `${label} must be a bounded plain JSON file: ${target}`);
  }
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw projectionError(code, `${label} is not valid JSON: ${target}`, { cause: error });
  }
}

function readPluginVersion(pluginManifestPath) {
  const manifest = readJsonFile(
    pluginManifestPath,
    'Tech Persistence plugin manifest',
    'DEEPSEEK_SKILL_SOURCE_INVALID'
  );
  if (manifest.name !== OWNER || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw projectionError(
      'DEEPSEEK_SKILL_SOURCE_INVALID',
      `unexpected Tech Persistence plugin identity at ${pluginManifestPath}`
    );
  }
  return manifest.version;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2
      && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSkillFrontmatter(skillPath, expectedName) {
  const info = lstatIfPresent(skillPath);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > MAX_SKILL_BYTES) {
    throw projectionError(
      'DEEPSEEK_SKILL_SOURCE_INVALID',
      `DeepSeek Harness skill must have a bounded plain SKILL.md: ${skillPath}`
    );
  }
  const raw = fs.readFileSync(skillPath, 'utf8');
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') {
    throw projectionError(
      'DEEPSEEK_SKILL_SOURCE_INVALID',
      `DeepSeek Harness skill frontmatter is missing: ${skillPath}`
    );
  }
  const end = lines.slice(1).findIndex((line) => line === '---');
  if (end < 0) {
    throw projectionError(
      'DEEPSEEK_SKILL_SOURCE_INVALID',
      `DeepSeek Harness skill frontmatter is unterminated: ${skillPath}`
    );
  }
  const fields = new Map();
  for (const line of lines.slice(1, end + 1)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/);
    if (match && !fields.has(match[1])) fields.set(match[1], parseScalar(match[2]));
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (name !== expectedName || !SKILL_NAME.test(name || '')) {
    throw projectionError(
      'DEEPSEEK_SKILL_SOURCE_INVALID',
      `DeepSeek Harness skill name must match its top-level directory (${expectedName}): ${skillPath}`
    );
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw projectionError(
      'DEEPSEEK_SKILL_SOURCE_INVALID',
      `DeepSeek Harness skill description is required: ${skillPath}`
    );
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (!fields.has(key)) continue;
    if (!/^(?:true|false|yes|no|on|off|1|0)$/i.test(fields.get(key))) {
      throw projectionError(
        'DEEPSEEK_SKILL_SOURCE_INVALID',
        `DeepSeek Harness skill ${key} must be boolean: ${skillPath}`
      );
    }
  }
  return { name, description };
}

function treeEntries(root, code, label) {
  assertPlainDirectory(root, label, code);
  const entries = [];
  function visit(directory, relativeDirectory) {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.join(relativeDirectory, child.name).split(path.sep).join('/');
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) {
        throw projectionError(code, `${label} contains a symbolic link: ${absolute}`);
      }
      if (info.isDirectory()) {
        entries.push({ kind: 'directory', relative, absolute, mode: info.mode & 0o777 });
        visit(absolute, relative);
      } else if (info.isFile()) {
        entries.push({ kind: 'file', relative, absolute, mode: info.mode & 0o777, size: info.size });
      } else {
        throw projectionError(code, `${label} contains an unsupported entry: ${absolute}`);
      }
    }
  }
  visit(root, '');
  return entries;
}

function hashTree(root, code = 'DEEPSEEK_SKILL_DRIFT', label = 'skill tree') {
  const hash = crypto.createHash('sha256');
  for (const entry of treeEntries(root, code, label)) {
    hash.update(`${entry.kind}\0${entry.relative}\0`);
    if (entry.kind === 'file') {
      hash.update(`${entry.size}\0`);
      hash.update(fs.readFileSync(entry.absolute));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

function copyPlainTree(source, destination) {
  fs.mkdirSync(destination, { recursive: false });
  for (const entry of treeEntries(
    source,
    'DEEPSEEK_SKILL_SOURCE_INVALID',
    'Tech Persistence skill source'
  )) {
    const target = path.join(destination, ...entry.relative.split('/'));
    if (entry.kind === 'directory') {
      fs.mkdirSync(target, { recursive: false });
      try { fs.chmodSync(target, entry.mode); } catch (_) { /* Windows may ignore POSIX modes. */ }
    } else {
      fs.copyFileSync(entry.absolute, target, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(target, entry.mode); } catch (_) { /* Windows may ignore POSIX modes. */ }
    }
  }
}

function sourceSnapshot(options) {
  assertPlainDirectory(
    options.sourceRoot,
    'Tech Persistence Codex skill source',
    'DEEPSEEK_SKILL_SOURCE_INVALID'
  );
  const actualNames = fs.readdirSync(options.sourceRoot, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw projectionError(
          'DEEPSEEK_SKILL_SOURCE_INVALID',
          `Codex skill source contains a non-directory entry: ${entry.name}`
        );
      }
      return entry.name;
    })
    .sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...CODEX_SKILL_NAMES])) {
    throw projectionError(
      'DEEPSEEK_SKILL_SOURCE_INVALID',
      `Codex skill source inventory differs from the managed inventory at ${options.sourceRoot}`
    );
  }
  const skills = {};
  for (const name of CODEX_SKILL_NAMES) {
    const skillRoot = path.join(options.sourceRoot, name);
    parseSkillFrontmatter(path.join(skillRoot, 'SKILL.md'), name);
    skills[name] = { sha256: hashTree(
      skillRoot,
      'DEEPSEEK_SKILL_SOURCE_INVALID',
      `Tech Persistence skill source ${name}`
    ) };
  }
  return {
    sourceVersion: readPluginVersion(options.pluginManifestPath),
    inventorySha256: INVENTORY_SHA256,
    skillNames: [...CODEX_SKILL_NAMES],
    skills,
  };
}

function receiptPath(targetRoot) {
  return path.join(targetRoot, RECEIPT_FILE);
}

function readReceipt(targetRoot) {
  const target = receiptPath(targetRoot);
  if (!lstatIfPresent(target)) return undefined;
  const receipt = readJsonFile(
    target,
    'DeepSeek Harness skill projection receipt',
    'DEEPSEEK_SKILL_RECEIPT_INVALID'
  );
  if (receipt.schemaVersion !== 1
      || receipt.owner !== OWNER
      || receipt.projection !== PROJECTION
      || typeof receipt.sourceVersion !== 'string'
      || typeof receipt.inventorySha256 !== 'string'
      || !Array.isArray(receipt.skillNames)
      || !receipt.skills
      || typeof receipt.skills !== 'object'
      || Array.isArray(receipt.skills)) {
    throw projectionError(
      'DEEPSEEK_SKILL_RECEIPT_INVALID',
      `invalid DeepSeek Harness skill projection receipt: ${target}`
    );
  }
  const names = [...receipt.skillNames];
  if (names.some((name) => typeof name !== 'string' || !SKILL_NAME.test(name))
      || new Set(names).size !== names.length
      || JSON.stringify(names) !== JSON.stringify([...names].sort())) {
    throw projectionError(
      'DEEPSEEK_SKILL_RECEIPT_INVALID',
      `invalid skill inventory in DeepSeek Harness projection receipt: ${target}`
    );
  }
  for (const name of names) {
    const record = receipt.skills[name];
    if (!record || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw projectionError(
        'DEEPSEEK_SKILL_RECEIPT_INVALID',
        `invalid ${name} hash in DeepSeek Harness projection receipt: ${target}`
      );
    }
  }
  if (Object.keys(receipt.skills).sort().join('\0') !== names.join('\0')) {
    throw projectionError(
      'DEEPSEEK_SKILL_RECEIPT_INVALID',
      `receipt skill records do not match its inventory: ${target}`
    );
  }
  return receipt;
}

function pathKind(target) {
  const info = lstatIfPresent(target);
  if (!info) return 'missing';
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isDirectory()) return 'directory';
  if (info.isFile()) return 'file';
  return 'unsupported';
}

function inspectDeepSeekHarnessSkillProjection(input = {}) {
  const options = normalizedOptions(input);
  const source = sourceSnapshot(options);
  const targetInfo = lstatIfPresent(options.targetRoot);
  if (targetInfo && (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())) {
    throw projectionError(
      'DEEPSEEK_SKILL_TARGET_INVALID',
      `DeepSeek Harness skill root must be a plain directory: ${options.targetRoot}`
    );
  }
  const receipt = targetInfo ? readReceipt(options.targetRoot) : undefined;
  const receiptNames = new Set(receipt ? receipt.skillNames : []);
  const collisions = [];
  const drift = [];

  for (const name of source.skillNames) {
    const target = path.join(options.targetRoot, name);
    if (pathKind(target) !== 'missing' && !receiptNames.has(name)) collisions.push(name);
  }
  if (receipt) {
    for (const name of receipt.skillNames) {
      const target = path.join(options.targetRoot, name);
      if (pathKind(target) !== 'directory') {
        drift.push(name);
        continue;
      }
      let actual;
      try {
        actual = hashTree(target, 'DEEPSEEK_SKILL_DRIFT', `installed DeepSeek Harness skill ${name}`);
      } catch (error) {
        if (error instanceof DeepSeekHarnessSkillProjectionError) {
          drift.push(name);
          continue;
        }
        throw error;
      }
      if (actual !== receipt.skills[name].sha256) drift.push(name);
    }
  }

  const receiptMatchesSource = Boolean(receipt)
    && receipt.sourceVersion === source.sourceVersion
    && receipt.inventorySha256 === source.inventorySha256
    && JSON.stringify(receipt.skillNames) === JSON.stringify(source.skillNames)
    && source.skillNames.every((name) => receipt.skills[name].sha256 === source.skills[name].sha256);
  let status = 'install-required';
  if (collisions.length > 0) status = 'collision';
  else if (drift.length > 0) status = 'drift';
  else if (receiptMatchesSource) status = 'unchanged';
  else if (receipt) status = 'update-required';

  return {
    status,
    sourceRoot: options.sourceRoot,
    targetRoot: options.targetRoot,
    sourceVersion: source.sourceVersion,
    inventorySha256: source.inventorySha256,
    skillNames: source.skillNames,
    skillCount: source.skillNames.length,
    skills: source.skills,
    collisions,
    drift,
    receipt,
  };
}

function assertInstallable(inspection) {
  if (inspection.collisions.length > 0) {
    throw projectionError(
      'DEEPSEEK_SKILL_COLLISION',
      `refusing to overwrite unmanaged DeepSeek Harness skills: ${inspection.collisions.join(', ')}`
    );
  }
  if (inspection.drift.length > 0) {
    throw projectionError(
      'DEEPSEEK_SKILL_DRIFT',
      `managed DeepSeek Harness skills changed outside the projection: ${inspection.drift.join(', ')}`
    );
  }
}

function writeExclusiveJson(target, value) {
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function removeIfPresent(target) {
  if (lstatIfPresent(target)) fs.rmSync(target, { recursive: true, force: true });
}

function installDeepSeekHarnessSkillProjection(input = {}) {
  const options = normalizedOptions(input);
  fs.mkdirSync(options.targetRoot, { recursive: true });
  assertPlainDirectory(
    options.targetRoot,
    'DeepSeek Harness skill root',
    'DEEPSEEK_SKILL_TARGET_INVALID'
  );
  const lockPath = path.join(options.targetRoot, LOCK_FILE);
  let lock;
  try {
    lock = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    throw projectionError(
      'DEEPSEEK_SKILL_LOCKED',
      `another DeepSeek Harness skill projection is active: ${lockPath}`,
      { cause: error }
    );
  }

  try {
    const inspection = inspectDeepSeekHarnessSkillProjection(options);
    assertInstallable(inspection);
    if (inspection.status === 'unchanged') {
      return {
        status: 'unchanged',
        targetRoot: options.targetRoot,
        sourceVersion: inspection.sourceVersion,
        inventorySha256: inspection.inventorySha256,
        skillCount: inspection.skillCount,
      };
    }

    const token = crypto.randomUUID();
    const stageRoot = path.join(options.targetRoot, `.tech-persistence-stage-${token}`);
    const backupRoot = path.join(options.targetRoot, `.tech-persistence-backup-${token}`);
    const previousReceipt = inspection.receipt;
    const nextReceipt = {
      schemaVersion: 1,
      owner: OWNER,
      projection: PROJECTION,
      sourceVersion: inspection.sourceVersion,
      inventorySha256: inspection.inventorySha256,
      skillNames: inspection.skillNames,
      skills: inspection.skills,
      updatedAt: options.now,
    };
    const stagedReceipt = path.join(stageRoot, RECEIPT_FILE);
    const backupReceipt = path.join(backupRoot, RECEIPT_FILE);
    const installedNames = [];
    const backedUpNames = [];
    let receiptBackedUp = false;
    let committed = false;

    try {
      fs.mkdirSync(stageRoot, { recursive: false });
      fs.mkdirSync(backupRoot, { recursive: false });
      for (const name of inspection.skillNames) {
        const staged = path.join(stageRoot, name);
        copyPlainTree(path.join(options.sourceRoot, name), staged);
        const stagedHash = hashTree(
          staged,
          'DEEPSEEK_SKILL_SOURCE_INVALID',
          `staged DeepSeek Harness skill ${name}`
        );
        if (stagedHash !== inspection.skills[name].sha256) {
          throw projectionError(
            'DEEPSEEK_SKILL_SOURCE_INVALID',
            `DeepSeek Harness skill changed while staging: ${name}`
          );
        }
      }
      writeExclusiveJson(stagedReceipt, nextReceipt);

      for (const name of previousReceipt ? previousReceipt.skillNames : []) {
        const target = path.join(options.targetRoot, name);
        const backup = path.join(backupRoot, name);
        fs.renameSync(target, backup);
        backedUpNames.push(name);
        const claimedHash = hashTree(
          backup,
          'DEEPSEEK_SKILL_DRIFT',
          `claimed DeepSeek Harness skill ${name}`
        );
        if (claimedHash !== previousReceipt.skills[name].sha256) {
          throw projectionError(
            'DEEPSEEK_SKILL_DRIFT',
            `managed DeepSeek Harness skill changed during update: ${name}`
          );
        }
      }

      for (const name of inspection.skillNames) {
        fs.renameSync(path.join(stageRoot, name), path.join(options.targetRoot, name));
        installedNames.push(name);
      }

      const currentReceipt = receiptPath(options.targetRoot);
      if (previousReceipt) {
        fs.renameSync(currentReceipt, backupReceipt);
        receiptBackedUp = true;
      }
      fs.renameSync(stagedReceipt, currentReceipt);
      committed = true;
    } catch (error) {
      if (!committed) {
        const rollbackErrors = [];
        for (const name of [...installedNames].reverse()) {
          const target = path.join(options.targetRoot, name);
          try {
            if (pathKind(target) === 'directory'
                && hashTree(target) === inspection.skills[name].sha256) {
              fs.rmSync(target, { recursive: true, force: true });
            } else if (pathKind(target) !== 'missing') {
              rollbackErrors.push(new Error(`installed skill changed during rollback: ${name}`));
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        for (const name of [...backedUpNames].reverse()) {
          try {
            const target = path.join(options.targetRoot, name);
            if (pathKind(target) !== 'missing') {
              rollbackErrors.push(new Error(`cannot restore occupied skill target: ${name}`));
              continue;
            }
            fs.renameSync(path.join(backupRoot, name), target);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (receiptBackedUp) {
          try {
            if (pathKind(receiptPath(options.targetRoot)) === 'missing') {
              fs.renameSync(backupReceipt, receiptPath(options.targetRoot));
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw projectionError(
            'DEEPSEEK_SKILL_RECOVERY_REQUIRED',
            `DeepSeek Harness skill projection failed and rollback was incomplete; recovery is preserved at ${backupRoot}`,
            { cause: new AggregateError([error, ...rollbackErrors]) }
          );
        }
      }
      throw error;
    } finally {
      if (committed) removeIfPresent(backupRoot);
      removeIfPresent(stageRoot);
    }

    const verified = verifyDeepSeekHarnessSkillProjection(options);
    return {
      ...verified,
      status: previousReceipt ? 'updated' : 'installed',
    };
  } finally {
    if (lock !== undefined) fs.closeSync(lock);
    try { fs.unlinkSync(lockPath); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function verifyDeepSeekHarnessSkillProjection(input = {}) {
  const inspection = inspectDeepSeekHarnessSkillProjection(input);
  assertInstallable(inspection);
  if (!inspection.receipt) {
    throw projectionError(
      'DEEPSEEK_SKILL_NOT_INSTALLED',
      `DeepSeek Harness skill projection is not installed at ${inspection.targetRoot}`
    );
  }
  if (inspection.status !== 'unchanged') {
    throw projectionError(
      'DEEPSEEK_SKILL_OUTDATED',
      `DeepSeek Harness skill projection does not match source ${inspection.sourceVersion}`
    );
  }
  return {
    status: 'verified',
    targetRoot: inspection.targetRoot,
    sourceVersion: inspection.sourceVersion,
    inventorySha256: inspection.inventorySha256,
    skillCount: inspection.skillCount,
  };
}

function parseCli(argv) {
  const action = argv[0];
  if (!['inspect', 'install', 'verify'].includes(action)) {
    throw projectionError(
      'DEEPSEEK_SKILL_USAGE',
      'usage: deepseek-harness-skill-projection.js <inspect|install|verify> [--source-root <path>] [--plugin-manifest <path>] [--target-root <path>]'
    );
  }
  const options = {};
  const mapping = {
    '--source-root': 'sourceRoot',
    '--plugin-manifest': 'pluginManifestPath',
    '--target-root': 'targetRoot',
  };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = mapping[flag];
    if (!key || value === undefined || value.startsWith('--') || options[key] !== undefined) {
      throw projectionError('DEEPSEEK_SKILL_USAGE', `invalid or repeated option: ${String(flag)}`);
    }
    options[key] = value;
  }
  return { action, options };
}

function main(argv = process.argv.slice(2)) {
  const { action, options } = parseCli(argv);
  if (action === 'inspect') return inspectDeepSeekHarnessSkillProjection(options);
  if (action === 'install') return installDeepSeekHarnessSkillProjection(options);
  return verifyDeepSeekHarnessSkillProjection(options);
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main())}\n`);
  } catch (error) {
    const code = error && error.code ? error.code : 'DEEPSEEK_SKILL_PROJECTION_FAILED';
    process.stderr.write(`[${code}] ${error && error.message ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  DeepSeekHarnessSkillProjectionError,
  defaultOptions,
  hashTree,
  inspectDeepSeekHarnessSkillProjection,
  installDeepSeekHarnessSkillProjection,
  main,
  parseCli,
  verifyDeepSeekHarnessSkillProjection,
};
