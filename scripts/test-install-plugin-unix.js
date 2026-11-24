'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bash = process.env.GIT_BASH || (process.platform === 'win32'
  ? 'C:/App/Git/bin/bash.exe' : 'bash');
const source = path.join(__dirname, '..', 'install-plugin.sh');

function runInstall(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-plugin-install-test-'));
  try {
    const plugin = path.join(root, 'plugins', 'tech-persistence');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), '{}');
    fs.writeFileSync(path.join(plugin, 'scripts', 'build-codex-plugin.js'), '');
    fs.writeFileSync(path.join(root, 'scripts', 'validate-codex-plugin.js'), '');
    fs.copyFileSync(source, path.join(root, 'install-plugin.sh'));
    const log = path.join(root, 'calls');
    const fake = (name, content) => {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/usr/bin/env bash\n${content}\n`, { mode: 0o755 });
      fs.chmodSync(file, 0o755);
    };
    fake('node', 'printf "node:%s\\n" "$*" >> "$TEST_INSTALL_LOG"\nif [[ "${TEST_FAIL_BUILD:-}" == 1 && "$1" == *build-codex-plugin.js ]]; then exit 2; fi\nif [[ "${TEST_FAIL_VALIDATE:-}" == 1 && "$1" == *validate-codex-plugin.js ]]; then exit 3; fi');
    fake('claude', 'if [[ "$1" == --version ]]; then printf "2.1.319 (Claude Code)\\n"; exit 0; fi\nprintf "claude:%s\\n" "$*" >> "$TEST_INSTALL_LOG"\nif [[ "${TEST_FAIL_UPDATE:-}" == 1 && "$*" == "plugin update "* ]]; then exit 1; fi');
    const result = spawnSync(bash, [path.join(root, 'install-plugin.sh')], {
      env: { ...process.env, ...extraEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TEST_INSTALL_LOG: log },
      encoding: 'utf8', windowsHide: true,
    });
    return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('unix plugin installer builds and validates before updating existing plugin', () => {
  const result = runInstall();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 5, result.calls.join('\n'));
  assert.match(result.calls[0], /^node:.*build-codex-plugin\.js$/);
  assert.match(result.calls[1], /^node:.*validate-codex-plugin\.js$/);
  assert.match(result.calls[2], /^claude:plugin validate /);
  assert.match(result.calls[3], /^claude:plugin marketplace add /);
  assert.equal(result.calls[4], 'claude:plugin update tech-persistence@tech-persistence-local');
});

test('projection build failure never reaches Claude plugin mutation', () => {
  const result = runInstall({ TEST_FAIL_BUILD: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 1, result.calls.join('\n'));
  assert.match(result.calls[0], /^node:.*build-codex-plugin\.js$/);
});

test('projection validation failure never reaches Claude plugin mutation', () => {
  const result = runInstall({ TEST_FAIL_VALIDATE: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 2, result.calls.join('\n'));
  assert.match(result.calls[1], /^node:.*validate-codex-plugin\.js$/);
});

test('installer falls back to install when update is unavailable', () => {
  const result = runInstall({ TEST_FAIL_UPDATE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.at(-2), 'claude:plugin update tech-persistence@tech-persistence-local');
  assert.equal(result.calls.at(-1), 'claude:plugin install tech-persistence@tech-persistence-local');
});
