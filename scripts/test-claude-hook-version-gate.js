'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const bash = process.env.GIT_BASH || (process.platform === 'win32' ? 'C:/App/Git/bin/bash.exe' : 'bash');

function run(script, args, version, powershell = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-claude-version-gate-'));
  try {
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    fs.copyFileSync(path.join(root, script), path.join(temp, script));
    const plugin = path.join(temp, 'plugins', 'tech-persistence');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'scripts'));
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), '{}');
    fs.writeFileSync(path.join(plugin, 'scripts', 'build-codex-plugin.js'), '');
    fs.writeFileSync(path.join(temp, 'scripts', 'validate-codex-plugin.js'), '');
    fs.writeFileSync(path.join(temp, 'scripts', 'init-obsidian-vault.js'), '');
    fs.writeFileSync(path.join(bin, 'claude'), '#!/usr/bin/env bash\nprintf "%s\\n" "$TEST_CLAUDE_VERSION"\n', { mode: 0o755 });
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\necho %TEST_CLAUDE_VERSION%\r\n');
    }
    const shell = powershell ? 'pwsh' : bash;
    const shellArgs = powershell
      ? ['-NoProfile', '-File', path.join(temp, script), ...args]
      : [path.join(temp, script), ...args];
    const result = spawnSync(shell, shellArgs, {
      cwd: temp,
      env: { ...process.env, HOME: temp, USERPROFILE: temp, TEST_CLAUDE_VERSION: version,
        PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8', windowsHide: true,
    });
    return { ...result, createdClaudeDirectory: fs.existsSync(path.join(temp, '.claude')) };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

for (const [script, arg, ps] of [
  ['install.sh', '--hooks-only', false],
  ['install.sh', '--project', false],
  ['install-plugin.sh', null, false],
  ['install.ps1', '-HooksOnly', true],
  ['install.ps1', '-Project', true],
  ['install-plugin.ps1', '-All', true],
]) {
  test(`${script} refuses unsupported and unparseable Claude versions before writing`, () => {
    for (const version of ['2.1.294 (Claude Code)', '2.1.295-beta', 'unexpected version']) {
      const result = run(script, arg ? [arg] : [], version, ps);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr + result.stdout, /2\.1\.295/);
      assert.equal(result.createdClaudeDirectory, false);
    }
  });
}

test('help does not require a working Claude version', () => {
  for (const [script, arg, ps] of [
    ['install.sh', '--help', false], ['install-plugin.sh', '--help', false],
    ['install.ps1', '-Help', true], ['install-plugin.ps1', '-Help', true],
  ]) {
    const result = run(script, [arg], 'unexpected version', ps);
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test('minimum and newer stable Claude versions pass the plugin preflight', () => {
  for (const [script, arg, ps] of [
    ['install-plugin.sh', null, false], ['install-plugin.ps1', '-All', true],
  ]) {
    for (const version of ['2.1.295 (Claude Code)', '3.0.0 (Claude Code)']) {
      const result = run(script, arg ? [arg] : [], version, ps);
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
  }
});

test('Obsidian-only setup does not require Claude', () => {
  for (const [script, arg, ps] of [
    ['install.sh', '--obsidian', false], ['install.ps1', '-Obsidian', true],
  ]) {
    const result = run(script, [arg], 'unavailable', ps);
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});
