'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detectProjectIdentity } = require('./lib/memory-v5');
const { resolveStoreDir } = require('./lib/self-learning-store');
const { detectStableProjectIdentity } = require('./lib/project-identity');

function staged(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-bounded-recall-'));
  const workspace = path.join(root, 'workspace');
  const baseDir = path.join(root, 'base');
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(workspace);
  fs.mkdirSync(baseDir);
  fs.mkdirSync(scripts);
  fs.cpSync(path.join(__dirname, 'lib'), path.join(scripts, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'prompt-submit.js'), path.join(scripts, 'prompt-submit.js'));
  fs.copyFileSync(path.join(__dirname, 'inject-context.js'), path.join(scripts, 'inject-context.js'));
  try { fn({ root, scripts, workspace, baseDir }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function invoke({ scripts, workspace, baseDir }, prompt, options = {}) {
  return spawnSync(process.execPath, [...(options.nodeArgs || []), path.join(scripts, 'prompt-submit.js')], {
    cwd: workspace,
    env: { ...process.env, TP_SELF_LEARNING_BASE_DIR: baseDir, TECH_PERSISTENCE_HOME: baseDir, TECH_PERSISTENCE_RUNTIME: 'claude', ...(options.env || {}) },
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1', session_id: 's-1', cwd: workspace, prompt }),
    encoding: 'utf8', timeout: 6500, windowsHide: true,
  });
}

test('slow synchronous recall is stopped without blocking an already queued prompt', () => staged((ctx) => {
  fs.writeFileSync(path.join(ctx.baseDir, 'config.json'), JSON.stringify({ self_learning: { legacy_reader_enabled: true } }));
  fs.writeFileSync(path.join(ctx.scripts, 'lib', 'prompt-receipt-worker.js'), "module.exports = { startPromptReceiptWorker() { return { status: 'failed' }; } };\n");
  fs.writeFileSync(path.join(ctx.scripts, 'lib', 'memory-search.js'), `
    module.exports.searchMemory = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); return {}; };
    module.exports.hasUsefulResults = () => false;
    module.exports.formatRecallContext = () => '';
  `);
  const secret = `glpat-${'Y'.repeat(24)}`;
  const started = Date.now();
  const result = invoke(ctx, `runtime paths ${secret}`);
  assert.equal(result.status, 0, result.error && result.error.message);
  assert(Date.now() - started < 5000, 'hook exceeded the host budget');
  const output = JSON.parse(result.stdout);
  assert.notEqual(output.decision, 'block');
  assert(!result.stdout.includes(secret));
  assert(!result.stderr.includes(secret));
  const project = detectStableProjectIdentity(ctx.workspace);
  assert.equal(fs.readdirSync(path.join(resolveStoreDir(ctx.baseDir, project.id), 'prompt-outbox', 'jobs')).filter((x) => x.endsWith('.json')).length, 1);
}));

test('expired wrapper budget skips spawning recall', () => staged((ctx) => {
  fs.writeFileSync(path.join(ctx.baseDir, 'config.json'), JSON.stringify({ self_learning: { writer_enabled: false, legacy_reader_enabled: true } }));
  const marker = path.join(ctx.root, 'recall-started');
  fs.writeFileSync(path.join(ctx.scripts, 'lib', 'prompt-recall-worker.js'), "require('fs').writeFileSync(process.env.TP_TEST_RECALL_MARKER, 'started');\n");
  const result = invoke(ctx, 'normal memory query', { env: { TP_PROMPT_HOOK_STARTED_AT_MS: String(Date.now() - 8000), TP_TEST_RECALL_MARKER: marker } });
  assert.equal(result.status, 0, result.error && result.error.message);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(marker), false);
}));

test('time spent during Node startup consumes recall budget', () => staged((ctx) => {
  fs.writeFileSync(path.join(ctx.baseDir, 'config.json'), JSON.stringify({ self_learning: { writer_enabled: false, legacy_reader_enabled: true } }));
  const marker = path.join(ctx.root, 'recall-started');
  const preload = path.join(ctx.root, 'startup-delay.js');
  fs.writeFileSync(preload, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);\n');
  fs.writeFileSync(path.join(ctx.scripts, 'lib', 'prompt-recall-worker.js'), "require('fs').writeFileSync(process.env.TP_TEST_RECALL_MARKER, 'started');\n");
  const result = invoke(ctx, 'normal memory query', {
    nodeArgs: ['--require', preload],
    env: { TP_TEST_RECALL_MARKER: marker, TP_PROMPT_HOOK_STARTED_AT_MS: String(Date.now() + 60000) },
  });
  assert.equal(result.status, 0, result.error && result.error.message);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(marker), false);
}));

test('bounded child preserves useful memory recall and does not echo unrelated private input', () => staged((ctx) => {
  fs.writeFileSync(path.join(ctx.baseDir, 'config.json'), JSON.stringify({ self_learning: { writer_enabled: false, legacy_reader_enabled: true } }));
  const project = detectProjectIdentity(ctx.workspace);
  const dir = path.join(ctx.baseDir, 'projects', project.id, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'architecture.md'), '# Architecture\n\n<!-- memory:v5:1111 -->\n- 2026-05-13 [0.8] runtime-paths.js is the dual-runtime boundary and must preserve both runtimes.\n');
  const secret = `glpat-${'Z'.repeat(24)}`;
  const result = invoke(ctx, `how should I handle runtime-paths.js ${secret}`);
  assert.equal(result.status, 0, result.error && result.error.message);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /dual-runtime boundary/);
  assert(!result.stdout.includes(secret));
  assert(!result.stderr.includes(secret));
}));
