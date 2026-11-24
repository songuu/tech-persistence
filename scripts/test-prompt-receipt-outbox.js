'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Test fixtures are created under this device-local temporary root.
process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT = os.tmpdir();
const localRecovery = require('./lib/self-learning-local-recovery-guard')
  .isEnabledForStore(path.join(os.tmpdir(), 'test-recovery-capability'));
const { spawn, spawnSync } = require('node:child_process');
const { adaptClaudeHookEvent } = require('./lib/behavior-events');
const {
  enqueuePromptReceipt, drainPromptReceipts, reportPromptReceiptWorkerFailure,
  hasPromptReceiptWorkerFailure, clearPromptReceiptWorkerFailure, MAX_PENDING_JOBS,
} = require('./lib/prompt-receipt-outbox');

function sample(id = 'a', prompt = 'A nonsecret user request') {
  const receipt_spec = {
    project_id: 'project-a', session_id: 'session-a',
    transcript_ref: `sha256:${'1'.repeat(64)}`,
    replay_ref: `sha256:${id.repeat(64)}`,
  };
  const event_draft = adaptClaudeHookEvent({
    hook_event_name: 'UserPromptSubmit', session_id: 'session-a', prompt,
  }, {
    project_id: 'project-a', session_id: 'session-a',
    source_event_id: `test:${id}`, occurred_at: '2026-01-01T00:00:00.000Z',
  });
  return { receipt_spec, event_draft };
}

function anotherStream(id) {
  const job = sample(id);
  job.receipt_spec.session_id = 'session-b';
  job.event_draft = adaptClaudeHookEvent({
    hook_event_name: 'UserPromptSubmit', session_id: 'session-b', prompt: 'Another stream request',
  }, { project_id: 'project-a', session_id: 'session-b', source_event_id: `test:${id}`, occurred_at: '2026-01-01T00:00:00.000Z' });
  return job;
}

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-outbox-test-'));
  try { fn(path.join(dir, 'nested', 'outbox')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('enqueue is durable, deduplicates replay and rejects conflicting semantics', () => withDir((dir) => {
  assert.equal(enqueuePromptReceipt(dir, sample()).status, 'queued');
  assert.equal(enqueuePromptReceipt(dir, sample()).status, 'duplicate');
  assert.throws(() => enqueuePromptReceipt(dir, sample('a', 'different user request')), /conflict/i);
  let jobs;
  drainPromptReceipts(dir, (batch) => { jobs = batch; });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].receipt_spec, sample().receipt_spec);
  assert.equal(jobs[0].event_draft.source_event_id, undefined);
  assert.equal(jobs[0].event_draft.input_digest, sample().event_draft.input_digest);
  assert.equal(drainPromptReceipts(dir, () => assert.fail('queue must be empty')).count, 0);
}));

test('failure preserves queued jobs, replay is ordered, and ack happens only after success', () => withDir((dir) => {
  enqueuePromptReceipt(dir, sample('a'));
  enqueuePromptReceipt(dir, sample('b'));
  assert.throws(() => drainPromptReceipts(dir, () => { throw Error('interrupted'); }), /interrupted/);
  const seen = [];
  const result = drainPromptReceipts(dir, (jobs) => { seen.push(...jobs.map((job) => job.receipt_spec.replay_ref)); });
  assert.deepEqual(seen, [sample('a').receipt_spec.replay_ref, sample('b').receipt_spec.replay_ref]);
  assert.equal(result.count, 2);
}));

test('rejects unexpected event fields, unsafe paths and malformed receipt', () => withDir((dir) => {
  const job = sample(); job.receipt_spec.transcript_path = 'sensitive/path';
  assert.throws(() => enqueuePromptReceipt(dir, job));
  const invalid = sample(); invalid.event_draft.input_value = 'raw prompt';
  assert.throws(() => enqueuePromptReceipt(dir, invalid));
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  const target = path.join(parent, 'target'); fs.mkdirSync(target);
  try { fs.symlinkSync(target, dir, 'junction'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
  assert.throws(() => enqueuePromptReceipt(dir, sample()), /link|path/i);
}));

test('interrupted publication is recovered and malformed jobs are retained', () => withDir((dir) => {
  enqueuePromptReceipt(dir, sample());
  const jobsDir = path.join(dir, 'jobs');
  const final = fs.readdirSync(jobsDir).find((name) => name.endsWith('.json'));
  fs.linkSync(path.join(jobsDir, final), path.join(jobsDir, `.pending-${'a'.repeat(32)}.tmp`));
  let seen = 0;
  drainPromptReceipts(dir, (jobs) => { seen += jobs.length; });
  assert.equal(seen, 1);
  enqueuePromptReceipt(dir, sample('b'));
  const damaged = path.join(jobsDir, fs.readdirSync(jobsDir).find((name) => name.endsWith('.json')));
  fs.writeFileSync(damaged, '{}');
  assert.throws(() => drainPromptReceipts(dir, () => assert.fail('must not deliver damaged job')));
  assert.equal(fs.existsSync(damaged), true);
}));

test('parallel processes preserve every receipt', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-outbox-parallel-'));
  const dir = path.join(parent, 'outbox');
  const modulePath = require.resolve('./lib/prompt-receipt-outbox');
  const jobs = 'abcdef'.split('').map((id) => sample(id));
  try {
    await Promise.all(jobs.map((job) => new Promise((resolve, reject) => {
      const code = 'const q=require(process.argv[1]);q.enqueuePromptReceipt(process.argv[2],JSON.parse(process.argv[3]));';
      const child = spawn(process.execPath, ['-e', code, modulePath, dir, JSON.stringify(job)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = ''; child.stderr.on('data', (chunk) => { error += chunk; });
      child.on('error', reject);
      child.on('close', (status) => status === 0 ? resolve() : reject(Error(error)));
    })));
    const seen = [];
    drainPromptReceipts(dir, (batch) => { seen.push(...batch.map((job) => job.receipt_spec.replay_ref)); });
    assert.equal(seen.length, jobs.length);
    assert.deepEqual(new Set(seen), new Set(jobs.map((job) => job.receipt_spec.replay_ref)));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('consumer crash leaves jobs available and recovers the dead lock', { skip: !localRecovery }, () => withDir((dir) => {
  enqueuePromptReceipt(dir, sample());
  const modulePath = require.resolve('./lib/prompt-receipt-outbox');
  const code = 'require(process.argv[1]).drainPromptReceipts(process.argv[2],()=>process.exit(17));';
  const dead = spawnSync(process.execPath, ['-e', code, modulePath, dir]);
  assert.equal(dead.status, 17);
  let count = 0;
  const recovered = drainPromptReceipts(dir, (jobs) => { count += jobs.length; });
  assert.equal(recovered.status, 'drained');
  assert.equal(count, 1);
}));

test('worker failure marker is bounded, idempotent and contains no error values', () => withDir((dir) => {
  assert.equal(hasPromptReceiptWorkerFailure(dir), false);
  reportPromptReceiptWorkerFailure(dir);
  reportPromptReceiptWorkerFailure(dir);
  assert.equal(hasPromptReceiptWorkerFailure(dir), true);
  assert.equal(fs.readFileSync(path.join(dir, 'worker-failure'), 'utf8'), 'worker-failure\n');
  clearPromptReceiptWorkerFailure(dir);
  clearPromptReceiptWorkerFailure(dir);
  assert.equal(hasPromptReceiptWorkerFailure(dir), false);
}));

test('capacity rejects new jobs while preserving existing jobs and accepts duplicates', () => withDir((dir) => {
  enqueuePromptReceipt(dir, sample());
  const jobsDir = path.join(dir, 'jobs');
  const original = fs.readdirSync(jobsDir)[0];
  for (let sequence = 2; sequence <= MAX_PENDING_JOBS; sequence += 1) {
    const name = `${String(sequence).padStart(12, '0')}-${sequence.toString(16).padStart(64, '0')}.json`;
    fs.writeFileSync(path.join(jobsDir, name), '{}');
  }
  assert.equal(enqueuePromptReceipt(dir, sample()).status, 'duplicate');
  assert.throws(() => enqueuePromptReceipt(dir, sample('b')), { code: 'PROMPT_OUTBOX_FULL' });
  assert.equal(fs.existsSync(path.join(jobsDir, original)), true);
  assert.equal(fs.readdirSync(jobsDir).length, MAX_PENDING_JOBS);
}));

test('enqueue racing the empty check is consumed by its newly launched worker', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-outbox-handoff-'));
  const dir = path.join(parent, 'outbox');
  const jobsDir = path.join(dir, 'jobs');
  const marker = path.join(parent, 'child-started');
  const completed = path.join(parent, 'child-completed');
  const modulePath = require.resolve('./lib/prompt-receipt-outbox');
  const originalReadDir = fs.readdirSync;
  let child;
  try {
    enqueuePromptReceipt(dir, sample());
    drainPromptReceipts(dir, () => {});
    fs.readdirSync = function wrapped(name, ...args) {
      const entries = originalReadDir.call(fs, name, ...args);
      if (!child && path.resolve(String(name)) === jobsDir && entries.length === 0) {
        const code = [
          'const fs=require("fs");',
          'const store=require(process.argv[6]);',
          'const acquire=store.acquireJournalLock;',
          'store.acquireJournalLock=(dir,options)=>{',
          'if(options.operation==="prompt-outbox-enqueue")fs.writeFileSync(process.argv[4],"started");',
          'return acquire(dir,options);};',
          'const q=require(process.argv[1]);',
          'q.enqueuePromptReceipt(process.argv[2], JSON.parse(process.argv[3]));',
          'const result=q.drainPromptReceipts(process.argv[2],()=>{});',
          'fs.writeFileSync(process.argv[5],JSON.stringify(result));',
        ].join('');
        child = spawn(process.execPath, ['-e', code, modulePath, dir, JSON.stringify(sample('b')), marker, completed, require.resolve('./lib/self-learning-store')], { stdio: 'ignore' });
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(marker) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        if (!fs.existsSync(marker)) throw Error('child did not start');
      }
      return entries;
    };
    assert.equal(drainPromptReceipts(dir, () => assert.fail('queue initially empty')).status, 'drained');
    fs.readdirSync = originalReadDir;
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(completed, 'utf8')), { status: 'drained', count: 1 });
    assert.equal(originalReadDir(jobsDir).length, 0);
  } finally {
    fs.readdirSync = originalReadDir;
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a later worker failure marker survives a prior consumer empty check', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-outbox-failure-race-'));
  const dir = path.join(parent, 'outbox');
  const jobsDir = path.join(dir, 'jobs');
  const started = path.join(parent, 'child-started');
  const originalReadDir = fs.readdirSync;
  let child;
  try {
    reportPromptReceiptWorkerFailure(dir);
    fs.readdirSync = function wrapped(name, ...args) {
      const entries = originalReadDir.call(fs, name, ...args);
      if (!child && path.resolve(String(name)) === jobsDir && entries.length === 0) {
        const code = [
          'const fs=require("fs"),store=require(process.argv[4]);',
          'const acquire=store.acquireJournalLock;',
          'store.acquireJournalLock=(dir,options)=>{',
          'if(options.operation==="prompt-outbox-enqueue")fs.writeFileSync(process.argv[3],"started");',
          'return acquire(dir,options);};',
          'require(process.argv[1]).reportPromptReceiptWorkerFailure(process.argv[2]);',
        ].join('');
        child = spawn(process.execPath, ['-e', code, require.resolve('./lib/prompt-receipt-outbox'), dir, started, require.resolve('./lib/self-learning-store')], { stdio: 'ignore' });
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(started) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        if (!fs.existsSync(started)) throw Error('child did not start');
      }
      return entries;
    };
    assert.equal(drainPromptReceipts(dir, () => assert.fail('queue is empty')).status, 'drained');
    fs.readdirSync = originalReadDir;
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(status, 0);
    assert.equal(hasPromptReceiptWorkerFailure(dir), true);
  } finally {
    fs.readdirSync = originalReadDir;
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a conflicting receipt is retained and blocks only later events in its stream', () => withDir((dir) => {
  enqueuePromptReceipt(dir, sample('a'));
  enqueuePromptReceipt(dir, sample('b'));
  enqueuePromptReceipt(dir, anotherStream('c'));
  const result = drainPromptReceipts(dir, (jobs) => {
    assert.deepEqual(jobs.map((job) => job.receipt_spec.session_id), ['session-a', 'session-a', 'session-b']);
    return ['conflict', 'deferred', 'committed'];
  });
  assert.deepEqual(result, { status: 'blocked', count: 1 });
  assert.equal(hasPromptReceiptWorkerFailure(dir), true);
  const entries = fs.readdirSync(path.join(dir, 'jobs'));
  assert.equal(entries.filter((entry) => entry.endsWith('.json')).length, 2);
  assert.equal(entries.filter((entry) => entry.startsWith('.blocked-')).length, 1);
  enqueuePromptReceipt(dir, anotherStream('d'));
  const next = drainPromptReceipts(dir, (jobs) => {
    assert.deepEqual(jobs.map((job) => job.receipt_spec.session_id), ['session-b']);
    return ['committed'];
  });
  assert.deepEqual(next, { status: 'blocked', count: 1 });
  assert.equal(hasPromptReceiptWorkerFailure(dir), true);
}));

test('rejects outcomes that would cross a same-stream conflict', () => withDir((dir) => {
  enqueuePromptReceipt(dir, sample('a'));
  enqueuePromptReceipt(dir, sample('b'));
  assert.throws(() => drainPromptReceipts(dir, () => ['conflict', 'committed']), /overtakes/);
  assert.equal(fs.readdirSync(path.join(dir, 'jobs')).filter((entry) => entry.endsWith('.json')).length, 2);
}));

test('slow consumer job reads do not hold the producer lock', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-outbox-slow-read-'));
  const dir = path.join(parent, 'outbox');
  const marker = path.join(parent, 'child-completed');
  const originalOpen = fs.openSync;
  let child;
  try {
    enqueuePromptReceipt(dir, sample('a'));
    fs.openSync = function wrapped(file, ...args) {
      if (!child && String(file).endsWith('.json') && path.dirname(String(file)) === path.join(dir, 'jobs')) {
        const code = [
          'const q=require(process.argv[1]);',
          'q.enqueuePromptReceipt(process.argv[2], JSON.parse(process.argv[3]));',
          'require("fs").writeFileSync(process.argv[4],"completed");',
        ].join('');
        child = spawn(process.execPath, ['-e', code, require.resolve('./lib/prompt-receipt-outbox'), dir, JSON.stringify(sample('b')), marker], { stdio: 'ignore' });
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(marker) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        if (!fs.existsSync(marker)) throw Error('producer was blocked by consumer read');
      }
      return originalOpen.call(fs, file, ...args);
    };
    const seen = [];
    const result = drainPromptReceipts(dir, (jobs) => { seen.push(...jobs.map((job) => job.receipt_spec.replay_ref)); });
    fs.openSync = originalOpen;
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(status, 0);
    assert.equal(result.count, 2);
    assert.deepEqual(seen, [sample('a').receipt_spec.replay_ref, sample('b').receipt_spec.replay_ref]);
  } finally {
    fs.openSync = originalOpen;
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('failed consumer marks failure before another consumer can succeed', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-outbox-failed-consumer-'));
  const dir = path.join(parent, 'outbox');
  const marker = path.join(parent, 'child-result');
  const originalOpen = fs.openSync;
  let child;
  try {
    enqueuePromptReceipt(dir, sample('a'));
    fs.openSync = function wrapped(file, ...args) {
      if (!child && String(file) === path.join(dir, 'worker-failure')) {
        const code = [
          'const q=require(process.argv[1]);',
          'const result=q.drainPromptReceipts(process.argv[2],()=>{});',
          'require("fs").writeFileSync(process.argv[3],JSON.stringify(result));',
        ].join('');
        child = spawn(process.execPath, ['-e', code, require.resolve('./lib/prompt-receipt-outbox'), dir, marker], { stdio: 'ignore' });
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(marker) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        if (!fs.existsSync(marker)) throw Error('later worker did not run');
      }
      return originalOpen.call(fs, file, ...args);
    };
    assert.throws(() => drainPromptReceipts(dir, () => { throw Error('injected failure'); }), /injected failure/);
    fs.openSync = originalOpen;
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(status, 0);
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).status, 'busy');
    assert.equal(hasPromptReceiptWorkerFailure(dir), true);
    assert.equal(drainPromptReceipts(dir, () => {}).status, 'drained');
    assert.equal(hasPromptReceiptWorkerFailure(dir), false);
  } finally {
    fs.openSync = originalOpen;
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
