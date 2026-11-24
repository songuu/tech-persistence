#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

// The wrapper starts before the child; include that startup in the host budget.
const PROMPT_WRAPPER_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1000);
const IS_CODEX_PROJECTION = false;
const ALLOWED_SCRIPT_NAMES = new Set(["caveman-activate.js","codex-behavior-hook.js","codex-lifecycle-evidence.js","evaluate-session.js","guard-handoff-path-codex.js","guard-handoff-path.js","inject-context-codex.js","inject-context.js","observe.js","prompt-submit.js"]);
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
  if (IS_CODEX_PROJECTION) return 'codex';
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude';
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

function reportFailure(code, scriptName) {
  writeDiagnostic(code);
  // Only the Claude prompt hook is configured as an authoritative handoff.
  // Other Claude hooks and all Codex hooks retain the existing fail-open contract.
  if (scriptName === 'prompt-submit.js' && !IS_CODEX_PROJECTION) process.exitCode = 1;
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
  const childEnv = { ...process.env };
  // Never trust an inherited timing hint. Only the Claude prompt child may
  // receive a hint, computed from this actual wrapper process.
  delete childEnv.TP_PROMPT_HOOK_STARTED_AT_MS;
  if (!IS_CODEX_PROJECTION && scriptName === 'prompt-submit.js') {
    childEnv.TP_PROMPT_HOOK_STARTED_AT_MS = String(PROMPT_WRAPPER_STARTED_AT_MS);
  }
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: childEnv,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    reportFailure('SPAWN_FAILED', scriptName);
    return;
  }
  if (result.signal || result.status !== 0) {
    reportFailure('CHILD_FAILED', scriptName);
    return;
  }
  if (result.stdout && result.stdout.length > 0) process.stdout.write(result.stdout);
}

process.exitCode = 0;
try {
  main();
} catch {
  reportFailure('WRAPPER_FAILED', process.argv[2]);
}
