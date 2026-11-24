'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { adaptClaudeHookEvent } = require('./lib/behavior-events');
const { hashObject } = require('./lib/self-learning-canonical');
const store = require('./lib/self-learning-store');

// These fixtures live in a per-device temporary directory only.
process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT = os.tmpdir();
const localRecovery = require('./lib/self-learning-local-recovery-guard')
  .isEnabledForStore(path.join(os.tmpdir(), 'test-recovery-capability'));

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-prompt-batch-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return store.resolveStoreDir(base, 'project-1');
}

function item(replay, prompt = 'example prompt', session = 'session-1') {
  const spec = {
    project_id: 'project-1', session_id: session,
    transcript_ref: hashObject({ session }), replay_ref: hashObject({ replay }),
  };
  return {
    spec,
    buildRecordInput: ({ source_event_id, occurred_at, receipt }) => {
      const event = adaptClaudeHookEvent({
        hook_event_name: 'UserPromptSubmit', session_id: session, prompt,
      }, { project_id: spec.project_id, session_id: session, source_event_id, occurred_at });
      event.details = { ...event.details, prompt_receipt: receipt };
      return {
        record_type: 'behavior_event', record_id: event.event_id, entity_id: event.event_id,
        actor: { kind: 'user', id: event.actor.id, runtime: 'claude', authority_ref: source_event_id },
        occurred_at, payload: event,
      };
    },
  };
}

test('batch preserves stream ordering, cross-stream identity and idempotent replay', (t) => {
  const dir = fixture(t);
  const first = item('1');
  const second = item('2');
  const other = item('1', 'other stream', 'session-2');
  const result = store.getOrAppendPromptReceipts(dir, [first, second, first, other]);
  assert.deepEqual(result.results.map((entry) => entry.changed), [true, true, false, true]);
  assert.deepEqual(result.results.map((entry) => entry.receipt.occurrence), [1, 2, 1, 1]);
  assert.equal(result.journal.revision, 3);
  const replay = store.getOrAppendPromptReceipts(dir, [first, second, other]);
  assert.deepEqual(replay.results.map((entry) => entry.changed), [false, false, false]);
  assert.equal(replay.journal.revision, 3);
});

test('partial write stays durable and replay resumes without duplication', (t) => {
  const dir = fixture(t);
  const first = item('1');
  const second = item('2');
  const fail = { ...second, buildRecordInput() { throw new Error('injected interruption'); } };
  assert.throws(() => store.getOrAppendPromptReceipts(dir, [first, fail]), /injected interruption/);
  assert.equal(store.readJournal(dir).revision, 1);
  const result = store.getOrAppendPromptReceipts(dir, [first, second]);
  assert.deepEqual(result.results.map((entry) => entry.changed), [false, true]);
  assert.deepEqual(result.results.map((entry) => entry.receipt.occurrence), [1, 2]);
  assert.equal(store.readJournal(dir).revision, 2);
});

test('conflicting replay is rejected and existing history is retained', (t) => {
  const dir = fixture(t);
  const first = item('1');
  store.getOrAppendPromptReceipts(dir, [first]);
  assert.throws(() => store.getOrAppendPromptReceipts(dir, [item('1', 'different prompt')]),
    (error) => error.code === 'SELF_LEARNING_ID_CONFLICT');
  assert.equal(store.readJournal(dir).revision, 1);
});

test('corrupted history fails closed before any batch write', (t) => {
  const dir = fixture(t);
  const first = store.getOrAppendPromptReceipts(dir, [item('1')]);
  fs.writeFileSync(first.results[0].file, '{}');
  assert.throws(() => store.getOrAppendPromptReceipts(dir, [item('2')]),
    (error) => error.code === 'SELF_LEARNING_CORRUPT');
  const names = fs.readdirSync(path.join(dir, store.JOURNAL_DIR_NAME));
  assert.equal(names.length, 1);
});

test('batch readback detects history changed during a partial commit', (t) => {
  const dir = fixture(t);
  const first = store.getOrAppendPromptReceipts(dir, [item('1')]);
  const recordFile = first.results[0].file;
  const second = item('2');
  const tamper = {
    ...second,
    buildRecordInput(context) {
      fs.writeFileSync(recordFile, '{}');
      return second.buildRecordInput(context);
    },
  };
  assert.throws(() => store.getOrAppendPromptReceipts(dir, [tamper]),
    (error) => error.code === 'SELF_LEARNING_CORRUPT');
  assert.throws(() => store.readJournal(dir), (error) => error.code === 'SELF_LEARNING_CORRUPT');
});

test('multiple new entries use one full journal read and one full readback', (t) => {
  const dir = fixture(t);
  const first = store.getOrAppendPromptReceipts(dir, [item('1')]);
  const recordFile = first.results[0].file;
  const originalRead = fs.readFileSync;
  let count = 0;
  try {
    fs.readFileSync = function (file, ...args) {
      if (String(file) === recordFile) count += 1;
      return originalRead.call(this, file, ...args);
    };
    store.getOrAppendPromptReceipts(dir, [item('2'), item('3'), item('4')]);
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(count, 2);
});

test('hard termination during record staging does not poison the journal', { skip: !localRecovery }, (t) => {
  const dir = fixture(t);
  const script = `
    const fs = require('node:fs');
    const store = require(process.argv[1]);
    const open = fs.openSync;
    const write = fs.writeFileSync;
    let staged;
    fs.openSync = function (file, ...args) {
      const descriptor = open.call(this, file, ...args);
      if (typeof file === 'string' && /\\.record-[a-f0-9]+\\.tmp$|\\.journal-record-[a-f0-9]+\\.tmp$/.test(file)) staged = descriptor;
      return descriptor;
    };
    fs.writeFileSync = function (target, ...args) {
      const result = write.call(this, target, ...args);
      if (target === staged) process.exit(77);
      return result;
    };
    store.appendRecord(process.argv[2], {
      record_type: 'behavior_event', record_id: 'event-1', entity_id: 'event-1',
      actor: { kind: 'user', id: 'user', runtime: null, authority_ref: null },
      occurred_at: '2026-01-01T00:00:00.000Z', payload: { event_type: 'user.prompt' },
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('./lib/self-learning-store'), dir], {
    encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(child.status, 77, child.stderr);
  const lock = store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 5000 });
  lock.release();
  assert.equal(store.readJournal(dir).revision, 0);
  assert.equal(store.getOrAppendPromptReceipts(dir, [item('resume')]).journal.revision, 1);
});

test('OS termination during staging recovers the journal and removes the dead owner’s staging file', { skip: !localRecovery }, async (t) => {
  const dir = fixture(t);
  const marker = path.join(path.dirname(dir), 'staging-started');
  const script = `
    const fs = require('node:fs');
    const store = require(process.argv[1]);
    const open = fs.openSync;
    const write = fs.writeFileSync;
    let staged;
    fs.openSync = function (file, ...args) {
      const descriptor = open.call(this, file, ...args);
      if (typeof file === 'string' && /\\.journal-record-[a-f0-9]+\\.tmp$/.test(file)) staged = descriptor;
      return descriptor;
    };
    fs.writeFileSync = function (target, ...args) {
      const result = write.call(this, target, ...args);
      if (target === staged) {
        write.call(this, process.argv[3], 'ready');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      }
      return result;
    };
    store.appendRecord(process.argv[2], {
      record_type: 'behavior_event', record_id: 'event-1', entity_id: 'event-1',
      actor: { kind: 'user', id: 'user', runtime: null, authority_ref: null },
      occurred_at: '2026-01-01T00:00:00.000Z', payload: { event_type: 'user.prompt', summary: 'private' },
    });
  `;
  const child = spawn(process.execPath, ['-e', script, require.resolve('./lib/self-learning-store'), dir, marker], {
    stdio: 'ignore', env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const deadline = Date.now() + 10000;
  try {
    while (!fs.existsSync(marker) && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(marker), true, 'child did not reach staging');
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
  const lock = store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 5000 });
  lock.release();
  assert.equal(store.readJournal(dir).revision, 0);
  assert(!fs.readdirSync(dir).some((name) => /^\.journal-record-[a-f0-9]+\.tmp$/.test(name)));
});

test('dead-owner recovery preserves a staging file with another hard link', { skip: !localRecovery }, (t) => {
  const dir = fixture(t);
  const journalDir = path.join(dir, store.JOURNAL_DIR_NAME);
  fs.mkdirSync(journalDir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const token = 'a'.repeat(32);
  fs.writeFileSync(path.join(journalDir, store.LOCK_FILE_NAME), JSON.stringify({
    schema_version: store.LOCK_SCHEMA_VERSION, token, pid: dead.pid,
    operation: 'test', acquired_at: '2000-01-01T00:00:00.000Z',
  }));
  const victim = path.join(path.dirname(dir), 'victim');
  fs.writeFileSync(victim, 'user data');
  const stage = path.join(dir, `.journal-record-${token}.tmp`);
  fs.linkSync(victim, stage);
  assert.throws(() => store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 20 }),
    (error) => error.code === 'SELF_LEARNING_LOCK_CORRUPT');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'user data');
  assert.equal(fs.readFileSync(stage, 'utf8'), 'user data');
  assert(fs.existsSync(path.join(journalDir, store.LOCK_FILE_NAME)));
});

test('hard termination before the lock contents are written leaves no corrupt published lock', (t) => {
  const dir = fixture(t);
  const script = `
    const fs = require('node:fs');
    const store = require(process.argv[1]);
    const open = fs.openSync;
    fs.openSync = function (file, ...args) {
      const descriptor = open.call(this, file, ...args);
      if (typeof file === 'string' && /LOCK\\.json$|\\.journal-lock-[a-f0-9]+\\.tmp$/.test(file)) process.exit(77);
      return descriptor;
    };
    store.acquireJournalLock(process.argv[2]);
  `;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('./lib/self-learning-store'), dir], {
    encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(child.status, 77, child.stderr);
  const lock = store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 100 });
  lock.release();
  assert.equal(store.readJournal(dir).revision, 0);
});

test('hard termination after publishing a complete lock can be recovered', { skip: !localRecovery }, (t) => {
  const dir = fixture(t);
  const script = `
    const fs = require('node:fs');
    const store = require(process.argv[1]);
    const link = fs.linkSync;
    fs.linkSync = function (source, target) {
      const result = link.call(this, source, target);
      if (typeof target === 'string' && /LOCK\\.json$/.test(target)) process.exit(77);
      return result;
    };
    store.acquireJournalLock(process.argv[2]);
  `;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('./lib/self-learning-store'), dir], {
    encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(child.status, 77, child.stderr);
  const lock = store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 5000 });
  lock.release();
  assert.equal(store.readJournal(dir).revision, 0);
});

test('a recovery claim appearing during lock publication prevents a writer from entering', (t) => {
  const dir = fixture(t);
  const journalDir = path.join(dir, store.JOURNAL_DIR_NAME);
  const lockFile = path.join(journalDir, store.LOCK_FILE_NAME);
  const claimFile = path.join(dir, store.LOCK_RECOVERY_CLAIM_FILE_NAME);
  const originalLink = fs.linkSync;
  let injected = false;
  try {
    fs.linkSync = function (existing, target) {
      const result = originalLink.call(this, existing, target);
      if (target === lockFile && !injected) {
        injected = true;
        fs.writeFileSync(claimFile, 'active recovery');
      }
      return result;
    };
    assert.throws(() => store.acquireJournalLock(dir, { retry_timeout_ms: 20 }),
      (error) => error.code === (localRecovery ? 'SELF_LEARNING_LOCK_CORRUPT' : 'SELF_LEARNING_LOCKED'));
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(injected, true);
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(fs.readFileSync(claimFile, 'utf8'), 'active recovery');
});

test('a filesystem without hard-link support reports an explicit capability failure', (t) => {
  const dir = fixture(t);
  const originalLink = fs.linkSync;
  try {
    fs.linkSync = () => {
      const error = new Error('hard links unsupported');
      error.code = 'ENOTSUP';
      throw error;
    };
    assert.throws(() => store.acquireJournalLock(dir, { retry_timeout_ms: 0 }),
      (error) => error.code === 'SELF_LEARNING_LOCK_UNSUPPORTED_FS'
        && error.cause && error.cause.code === 'ENOTSUP');
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(store.readJournal(dir).revision, 0);
});
