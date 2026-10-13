#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CODEX_SKILL_NAMES, INVENTORY_SHA256 } = require('./lib/managed-plugin-inventory');
const {
  bootstrapProviderPlugin,
  verifyProviderPluginReceipt,
  writeBootstrapReceipt,
} = require('./harness-provider-plugin-bootstrap');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createRuntime(root) {
  const pluginRoot = path.join(root, 'plugins', 'tech-persistence');
  writeJson(path.join(root, '.agents', 'plugins', 'marketplace.json'), {
    name: 'tech-persistence-local',
    plugins: [{
      name: 'tech-persistence',
      source: { source: 'local', path: './plugins/tech-persistence' },
    }],
  });
  writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: 'tech-persistence',
    version: '1.0.8',
    skills: './codex-skills/',
  });
  for (const name of CODEX_SKILL_NAMES) {
    const skill = path.join(pluginRoot, 'codex-skills', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, `---\nname: ${name}\n---\n`);
  }
  return pluginRoot;
}

function fakeCodex(pluginRoot, calls, options = {}) {
  return (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], env: { ...spawnOptions.env } });
    if (options.failAt && args.join(' ').includes(options.failAt)) {
      return { status: 9, signal: null, stdout: '', stderr: 'unsupported plugin command' };
    }
    if (args.includes('add') && args.includes('tech-persistence@tech-persistence-local')) {
      const installed = path.join(
        spawnOptions.env.CODEX_HOME,
        'plugins',
        'cache',
        'tech-persistence-local',
        'tech-persistence',
        '1.0.8'
      );
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.cpSync(pluginRoot, installed, { recursive: true });
      if (options.tamperInstalled) {
        fs.appendFileSync(path.join(installed, 'codex-skills', 'work', 'SKILL.md'), 'tampered\n');
      }
    }
    return {
      status: 0,
      signal: null,
      stdout: args.includes('list')
        ? JSON.stringify(options.listPayload || { installed: [{
          pluginId: 'tech-persistence@tech-persistence-local',
          name: 'tech-persistence',
          marketplaceName: 'tech-persistence-local',
          installed: true,
          enabled: true,
        }] })
        : '{}',
      stderr: '',
    };
  };
}

function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-provider-bootstrap-'));
  try {
    const runtimeRoot = path.join(temporary, 'runtime');
    const providerHome = path.join(temporary, 'provider-home');
    fs.mkdirSync(providerHome);
    const pluginRoot = createRuntime(runtimeRoot);
    const calls = [];
    const result = bootstrapProviderPlugin({
      providerHome,
      runtimeRoot,
      codexCliPath: path.join(temporary, 'codex.js'),
      spawnSyncImpl: fakeCodex(pluginRoot, calls),
    });

    assert.strictEqual(result.pluginName, 'tech-persistence');
    assert.strictEqual(result.version, '1.0.8');
    assert.strictEqual(result.inventorySha256, INVENTORY_SHA256);
    assert.match(result.pluginSha256, /^[a-f0-9]{64}$/);
    assert.match(result.installedPluginRoot, /^\.codex\/plugins\/cache\//);
    assert.deepStrictEqual(
      calls.map((call) => call.args.slice(1)),
      [
        ['plugin', 'marketplace', 'add', fs.realpathSync.native(runtimeRoot), '--json'],
        ['plugin', 'add', 'tech-persistence@tech-persistence-local', '--json'],
        ['plugin', 'list', '--json'],
      ]
    );
    const realProviderHome = fs.realpathSync.native(providerHome);
    assert(calls.every((call) => call.env.HOME === realProviderHome));
    assert(calls.every((call) => call.env.CODEX_HOME === path.join(realProviderHome, '.codex')));
    const receiptPath = path.join(providerHome, '.codex', 'tech-persistence-bootstrap.json');
    assert.deepStrictEqual(verifyProviderPluginReceipt({
      providerHome,
      runtimeRoot,
      receiptPath,
    }), result);
    const originalReceipt = fs.readFileSync(receiptPath, 'utf8');
    const forgedReceipt = { ...result, pluginSha256: '0'.repeat(64) };
    fs.writeFileSync(receiptPath, `${JSON.stringify(forgedReceipt)}\n`);
    assert.throws(() => verifyProviderPluginReceipt({
      providerHome,
      runtimeRoot,
      receiptPath,
    }), /receipt does not match/i);
    fs.writeFileSync(receiptPath, originalReceipt);
    const publicReceipt = path.join(temporary, 'provider-output', 'plugin-bootstrap.json');
    fs.mkdirSync(path.dirname(publicReceipt));
    writeBootstrapReceipt(publicReceipt, result, { replace: true });
    assert.deepStrictEqual(verifyProviderPluginReceipt({
      providerHome,
      runtimeRoot,
      receiptPath: publicReceipt,
    }), result);

    const sessions = path.join(providerHome, '.codex', 'sessions');
    fs.mkdirSync(sessions);
    fs.writeFileSync(path.join(sessions, 'preserved'), 'session');
    const injectedSkill = path.join(providerHome, '.codex', 'skills', 'sprint', 'SKILL.md');
    fs.mkdirSync(path.dirname(injectedSkill), { recursive: true });
    fs.writeFileSync(injectedSkill, 'untrusted direct skill');
    fs.writeFileSync(path.join(providerHome, '.codex', 'AGENTS.md'), 'untrusted global instructions');
    fs.writeFileSync(path.join(providerHome, '.codex', 'plugins', 'stale'), 'stale');
    const secondCalls = [];
    bootstrapProviderPlugin({
      providerHome,
      runtimeRoot,
      codexCliPath: path.join(temporary, 'codex.js'),
      spawnSyncImpl: fakeCodex(pluginRoot, secondCalls),
    });
    assert.strictEqual(fs.existsSync(path.join(providerHome, '.codex', 'plugins', 'stale')), false);
    assert.strictEqual(fs.readFileSync(path.join(sessions, 'preserved'), 'utf8'), 'session');
    assert.strictEqual(fs.existsSync(injectedSkill), false);
    assert.strictEqual(fs.existsSync(path.join(providerHome, '.codex', 'AGENTS.md')), false);
    const installedSkill = path.join(
      secondCalls[1].env.CODEX_HOME,
      'plugins', 'cache', 'tech-persistence-local', 'tech-persistence', '1.0.8',
      'codex-skills', 'work', 'SKILL.md'
    );
    fs.appendFileSync(installedSkill, 'post-bootstrap tamper\n');
    assert.throws(() => verifyProviderPluginReceipt({
      providerHome,
      runtimeRoot,
      receiptPath,
    }), /installed plugin bytes/i);

    assert.throws(() => bootstrapProviderPlugin({
      providerHome,
      runtimeRoot,
      codexCliPath: path.join(temporary, 'codex.js'),
      spawnSyncImpl: fakeCodex(pluginRoot, [], { failAt: 'marketplace add' }),
    }), /marketplace add.*exit 9/i);

    assert.throws(() => bootstrapProviderPlugin({
      providerHome,
      runtimeRoot,
      codexCliPath: path.join(temporary, 'codex.js'),
      spawnSyncImpl: fakeCodex(pluginRoot, [], { tamperInstalled: true }),
    }), /installed plugin bytes/i);

    assert.throws(() => bootstrapProviderPlugin({
      providerHome,
      runtimeRoot,
      codexCliPath: path.join(temporary, 'codex.js'),
      spawnSyncImpl: fakeCodex(pluginRoot, [], {
        listPayload: { installed: [], note: 'tech-persistence@tech-persistence-local' },
      }),
    }), /plugin list readback/i);

    const escapedRuntime = path.join(temporary, 'escaped-runtime');
    createRuntime(escapedRuntime);
    const manifest = path.join(escapedRuntime, '.agents', 'plugins', 'marketplace.json');
    const escaped = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    escaped.plugins[0].source.path = '../outside';
    writeJson(manifest, escaped);
    assert.throws(() => bootstrapProviderPlugin({
      providerHome,
      runtimeRoot: escapedRuntime,
      codexCliPath: path.join(temporary, 'codex.js'),
      spawnSyncImpl: fakeCodex(pluginRoot, []),
    }), /outside runtime root/i);

    assert.throws(() => bootstrapProviderPlugin({
      providerHome: fs.mkdtempSync(path.join(runtimeRoot, 'nested-home-')),
      runtimeRoot,
      codexCliPath: path.join(temporary, 'codex.js'),
      spawnSyncImpl: fakeCodex(pluginRoot, []),
    }), /provider home must be outside/i);

    const linkedRuntime = path.join(temporary, 'linked-runtime');
    createRuntime(linkedRuntime);
    const outsideAgents = path.join(temporary, 'outside-agents');
    fs.renameSync(path.join(linkedRuntime, '.agents'), outsideAgents);
    let linkedPathSupported = true;
    try {
      fs.symlinkSync(outsideAgents, path.join(linkedRuntime, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      linkedPathSupported = false;
    }
    if (linkedPathSupported) {
      const linkedCalls = [];
      assert.throws(() => bootstrapProviderPlugin({
        providerHome,
        runtimeRoot: linkedRuntime,
        codexCliPath: path.join(temporary, 'codex.js'),
        spawnSyncImpl: fakeCodex(pluginRoot, linkedCalls),
      }), /symbolic link/i);
      assert.strictEqual(linkedCalls.length, 0, 'linked runtime input must fail before invoking Codex');
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  console.log('[OK] Harness provider plugin bootstrap tests passed');
}

main();
