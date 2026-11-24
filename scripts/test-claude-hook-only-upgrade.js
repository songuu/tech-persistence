'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourceRoot = path.resolve(__dirname, '..');
const bash = process.env.GIT_BASH || (process.platform === 'win32' ? 'C:/App/Git/bin/bash.exe' : 'bash');

function runUpgrade(powershell, includeProject, omitPrompt = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-hook-only-upgrade-'));
  try {
    const bin = path.join(root, 'bin');
    const scripts = path.join(root, 'scripts');
    const project = path.join(root, 'project');
    fs.mkdirSync(bin); fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(root, 'user-level', 'homunculus'), { recursive: true });
    fs.writeFileSync(path.join(root, 'user-level', 'homunculus', 'config.json'), '{}');
    for (const file of ['install.sh', 'install.ps1']) fs.copyFileSync(path.join(sourceRoot, file), path.join(root, file));
    fs.copyFileSync(path.join(sourceRoot, 'scripts', 'merge-claude-settings-hooks.js'), path.join(scripts, 'merge-claude-settings-hooks.js'));
    fs.copyFileSync(path.join(sourceRoot, 'scripts', 'lib', 'hook-registry.js'), path.join(scripts, 'lib', 'hook-registry.js'));
    for (const file of ['inject-context.js', 'observe.js', 'evaluate-session.js', 'prompt-submit.js']) fs.writeFileSync(path.join(scripts, file), '');
    const existingHook = path.join(root, '.claude', 'skills', 'continuous-learning', 'hooks', 'prompt-submit.js');
    if (omitPrompt) {
      fs.mkdirSync(path.dirname(existingHook), { recursive: true });
      fs.writeFileSync(existingHook, 'old-hook');
      fs.unlinkSync(path.join(scripts, 'prompt-submit.js'));
    }
    fs.writeFileSync(path.join(bin, 'claude'), '#!/usr/bin/env bash\necho "2.1.319 (Claude Code)"\n', { mode: 0o755 });
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\necho 2.1.319 (Claude Code)\r\n');
    const settings = { env: { SECRET: 'sentinel' }, hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'custom-start', timeout: 13 }] }],
      UserPromptSubmit: [{ hooks: [
        { type: 'command', command: 'node "/foreign/prompt-submit.js" || true', timeout: 13 },
        { type: 'command', command: `node "${path.join(root, '.claude', 'skills', 'continuous-learning', 'hooks', 'prompt-submit.js').replace(/\\/g, '/')}" || true`, timeout: 120 },
      ] }],
    } };
    const userSettings = path.join(root, '.claude', 'settings.json');
    fs.writeFileSync(userSettings, JSON.stringify(settings));
    const projectSettings = path.join(project, '.claude', 'settings.json');
    if (includeProject) { fs.mkdirSync(path.dirname(projectSettings)); fs.writeFileSync(projectSettings, JSON.stringify(settings)); }
    const shell = powershell ? 'pwsh' : bash;
    const args = powershell ? ['-NoProfile', '-File', path.join(root, 'install.ps1'), '-HooksOnly']
      : [path.join(root, 'install.sh'), '--hooks-only'];
    const result = spawnSync(shell, args, { cwd: project, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, HOME: root, USERPROFILE: root, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    if (omitPrompt) {
      assert.notEqual(result.status, 0, result.stdout);
      assert.equal(fs.readFileSync(existingHook, 'utf8'), 'old-hook');
    } else assert.equal(result.status, 0, result.stderr);
    for (const file of [userSettings, ...(includeProject ? [projectSettings] : [])]) {
      const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(updated.env, settings.env);
      assert.deepEqual(updated.hooks.SessionStart, settings.hooks.SessionStart);
      assert.deepEqual(updated.hooks.UserPromptSubmit[0].hooks[0], settings.hooks.UserPromptSubmit[0].hooks[0]);
      const managed = updated.hooks.UserPromptSubmit[0].hooks[1];
      assert.equal(managed.onFailure, 'block');
      assert.equal(managed.timeout, 120);
      assert.doesNotMatch(managed.command, /\|\|\s*true\s*$/);
    }
    if (!includeProject) assert.equal(fs.existsSync(projectSettings), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const powershell of [false, true]) for (const includeProject of [false, true]) {
  test(`${powershell ? 'PowerShell' : 'Bash'} hooks-only upgrades existing prompt hooks; project settings ${includeProject ? 'present' : 'absent'}`,
    () => runUpgrade(powershell, includeProject));
}

for (const powershell of [false, true]) {
  test(`${powershell ? 'PowerShell' : 'Bash'} updates failure policy before a failed entrypoint copy`,
    () => runUpgrade(powershell, false, true));
}
