#!/usr/bin/env node

const path = require('path');

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
  if (process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_PROJECT_DIR) {
    return 'claude';
  }
  return 'codex';
}

process.env.TECH_PERSISTENCE_RUNTIME = inferRuntime();

const scriptPath = path.join(__dirname, scriptName);
process.argv = [process.argv[0], scriptPath, ...scriptArgs];
require(scriptPath);
