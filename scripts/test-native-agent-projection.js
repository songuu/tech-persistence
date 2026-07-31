#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const builder = require(path.join(
  root,
  'plugins',
  'tech-persistence',
  'scripts',
  'build-codex-plugin.js'
));

function files(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .sort();
}

function main() {
  assert.strictEqual(typeof builder.copyClaudeAgents, 'function');
  assert.strictEqual(typeof builder.copyCodexAgents, 'function');

  const projectConfig = fs.readFileSync(
    path.join(root, '.codex', 'config.toml'),
    'utf8'
  );
  for (const role of ['explorer', 'implementer', 'reviewer']) {
    assert.match(projectConfig, new RegExp(`\\[agents\\.tp_${role}\\]`));
    assert.match(
      projectConfig,
      new RegExp(`config_file = "\\.\\./codex-native/agents/${role}\\.toml"`)
    );
  }

  const temporaryPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-native-agents-'));
  try {
    assert.strictEqual(builder.copyClaudeAgents(temporaryPluginRoot), 3);
    assert.strictEqual(builder.copyCodexAgents(temporaryPluginRoot), 3);
    assert.deepStrictEqual(files(path.join(temporaryPluginRoot, 'agents'), '.md'), [
      'claude-explorer.md',
      'claude-implementer.md',
      'claude-reviewer.md',
    ]);
    assert.deepStrictEqual(files(path.join(temporaryPluginRoot, 'codex-agents'), '.toml'), [
      'config.example.toml',
      'explorer.toml',
      'implementer.toml',
      'reviewer.toml',
    ]);
    assert(fs.existsSync(path.join(
      temporaryPluginRoot,
      'codex-agents',
      'config.example.toml'
    )));
  } finally {
    fs.rmSync(temporaryPluginRoot, { recursive: true, force: true });
  }

  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'plugins', 'tech-persistence', '.codex-plugin', 'plugin.json'),
    'utf8'
  ));
  assert.strictEqual(manifest.agents, undefined, 'Codex manifest does not support agents');
  console.log('[OK] native agent projection tests passed');
}

main();
