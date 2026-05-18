#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const [, , scriptName, ...scriptArgs] = process.argv;

if (!scriptName) {
  process.exit(0);
}

function inferRuntime() {
  if (process.env.TECH_PERSISTENCE_RUNTIME) {
    return process.env.TECH_PERSISTENCE_RUNTIME.toLowerCase();
  }
  if (process.env.CODEX_HOME || process.env.CODEX_SESSION_ID || process.env.CODEX_PROJECT_DIR) {
    return 'codex';
  }
  if (
    process.env.CLAUDE_PLUGIN_ROOT
    || process.env.CLAUDE_SESSION_ID
    || process.env.CLAUDE_CONFIG_DIR
    || process.env.CLAUDE_PROJECT_DIR
  ) {
    return 'claude';
  }
  return 'codex';
}

process.env.TECH_PERSISTENCE_RUNTIME = inferRuntime();

const scriptPath = path.join(__dirname, scriptName);
const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  try {
    process.stderr.write(`[run-hook] failed to launch ${scriptName}: ${result.error.message}\n`);
  } catch {}
  process.exit(0);
}

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(result.signal ? 1 : 0);
