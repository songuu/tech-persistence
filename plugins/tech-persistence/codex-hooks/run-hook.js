#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const ALLOWED_SCRIPT_NAMES = new Set(["caveman-activate.js","codex-behavior-hook.js","codex-lifecycle-evidence.js","codex-transcript-outbox.js","evaluate-session.js","guard-handoff-path-codex.js","guard-handoff-path.js","inject-context-codex.js","inject-context.js","observe.js","prompt-submit.js"]);
const DIAGNOSTIC_MAX_BYTES = 128;
const DIAGNOSTIC_CODES = new Set([
  'SCRIPT_NOT_ALLOWED',
  'SPAWN_FAILED',
  'CHILD_FAILED',
  'WRAPPER_FAILED',
]);

function writeDiagnostic(code) {
  const safeCode = DIAGNOSTIC_CODES.has(code) ? code : 'WRAPPER_FAILED';
  const bytes = Buffer.from('[run-hook] ' + safeCode + '\n', 'utf8');
  try {
    process.stderr.write(bytes.subarray(0, DIAGNOSTIC_MAX_BYTES));
  } catch {}
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

function main() {
  const [, , scriptName, ...scriptArgs] = process.argv;
  if (!scriptName) return;
  if (!ALLOWED_SCRIPT_NAMES.has(scriptName)) {
    writeDiagnostic('SCRIPT_NOT_ALLOWED');
    return;
  }

  process.env.TECH_PERSISTENCE_RUNTIME = inferRuntime();
  const scriptPath = path.join(__dirname, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    writeDiagnostic('SPAWN_FAILED');
    return;
  }
  if (result.signal || result.status !== 0) {
    writeDiagnostic('CHILD_FAILED');
    return;
  }
  if (result.stdout && result.stdout.length > 0) process.stdout.write(result.stdout);
}

try {
  main();
} catch {
  writeDiagnostic('WRAPPER_FAILED');
}
process.exitCode = 0;
