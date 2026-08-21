#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const canonical = require('./lib/self-learning-canonical');
const store = require('./lib/self-learning-store');

const AT = '2026-08-20T01:02:03.000Z';
const ACTOR = { kind: 'user', id: 'user-local', runtime: null, authority_ref: null };

function fixture() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-self-learning-store-'));
  return { baseDir, storeDir: store.resolveStoreDir(baseDir, 'project-1') };
}

function input(overrides = {}) {
  return {
    record_type: 'behavior_event',
    record_id: 'event-1',
    entity_id: 'event-1',
    actor: ACTOR,
    occurred_at: AT,
    payload: { event_type: 'user.feedback', details: { accepted: true } },
    ...overrides,
  };
}

function assertErrorCode(action, code) {
  assert.throws(action, (error) => {
    assert.strictEqual(error.code, code, error.stack || error.message);
    return true;
  });
}

function writeLock(storeDir, overrides = {}) {
  const journalDir = path.join(storeDir, store.JOURNAL_DIR_NAME);
  fs.mkdirSync(journalDir, { recursive: true });
  const lockFile = path.join(journalDir, store.LOCK_FILE_NAME);
  const lock = {
    schema_version: store.LOCK_SCHEMA_VERSION,
    token: 'a'.repeat(32),
    pid: process.pid,
    operation: 'test-lock',
    acquired_at: '2000-01-01T00:00:00.000Z',
    ...overrides,
  };
  const bytes = `${JSON.stringify(lock, null, 2)}\n`;
  fs.writeFileSync(lockFile, bytes);
  return { journalDir, lockFile, lock, bytes };
}

{
  const { baseDir, storeDir } = fixture();
  try {
    assert.deepStrictEqual(store.readJournal(storeDir), {
      schema_version: store.JOURNAL_VIEW_SCHEMA_VERSION,
      revision: 0,
      head_hash: null,
      records: [],
    });
    assert.strictEqual(fs.existsSync(storeDir), false, 'read must not create store');

    const first = store.appendRecord(storeDir, input());
    assert.strictEqual(first.changed, true);
    assert.strictEqual(first.record.sequence, 1);
    assert.strictEqual(first.record.previous_hash, null);
    assert.strictEqual(first.record.payload_hash, canonical.hashObject(first.record.payload));
    assert.strictEqual(first.record.record_hash, canonical.hashObject(
      Object.fromEntries(Object.entries(first.record).filter(([key]) => key !== 'record_hash'))
    ));
    assert.match(path.basename(first.file), /^000000000001-[a-f0-9]{64}\.json$/);

    const persisted = store.readJournal(storeDir);
    assert.strictEqual(persisted.revision, 1);
    assert.strictEqual(persisted.head_hash, first.record.record_hash);
    assert.deepStrictEqual(persisted.records[0], first.record);

    const retry = store.appendRecord(storeDir, input());
    assert.strictEqual(retry.changed, false);
    assert.strictEqual(retry.record.record_hash, first.record.record_hash);
    assert.strictEqual(store.readJournal(storeDir).revision, 1);

    assert.throws(
      () => store.appendRecord(storeDir, input({ payload: { changed: true } })),
      /record id conflict/i
    );
    for (const conflictingIdentity of [
      { entity_id: 'different-entity' },
      { record_type: 'evidence_ref' },
      { actor: { kind: 'agent', id: 'agent-local', runtime: 'codex', authority_ref: null } },
      { occurred_at: '2026-08-20T01:02:04.000Z' },
    ]) {
      assert.throws(
        () => store.appendRecord(storeDir, input(conflictingIdentity)),
        /record id conflict/i,
        'same record_id is idempotent only when the full normalized semantic core matches'
      );
    }

    const second = store.appendRecord(storeDir, input({
      record_id: 'event-2',
      entity_id: 'event-2',
      payload: { event_type: 'tool.result', status: 'unknown' },
    }));
    assert.strictEqual(second.record.sequence, 2);
    assert.strictEqual(second.record.previous_hash, first.record.record_hash);
    assert.strictEqual(store.verifyJournal(storeDir).revision, 2);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  const originalOpenSync = fs.openSync;
  let injected = false;
  try {
    fs.openSync = (target, flags, ...args) => {
      if (!injected
          && path.basename(String(target)) === store.LOCK_FILE_NAME
          && flags === 'wx') {
        injected = true;
        const error = new Error('simulated Windows lock create race');
        error.code = 'EPERM';
        throw error;
      }
      return originalOpenSync(target, flags, ...args);
    };
    const written = store.appendRecord(storeDir, input({
      record_id: 'after-transient-open-race',
      entity_id: 'after-transient-open-race',
    }));
    assert.strictEqual(injected, true);
    assert.strictEqual(written.changed, true);
    assert.strictEqual(store.readJournal(storeDir).revision, 1);
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  const transcriptRef = canonical.hashObject({ transcript: 'trusted-session-1' });
  const firstReplayRef = canonical.hashObject({ cursor: 'first' });
  const secondReplayRef = canonical.hashObject({ cursor: 'second' });
  const spec = (replayRef) => ({
    project_id: 'project-1',
    session_id: 'session-1',
    transcript_ref: transcriptRef,
    replay_ref: replayRef,
  });
  const build = (summary) => ({ source_event_id, occurred_at: occurredAt, receipt }) => ({
    record_type: 'behavior_event',
    record_id: source_event_id,
    entity_id: source_event_id,
    actor: {
      kind: 'user', id: 'user', runtime: 'claude', authority_ref: source_event_id,
    },
    occurred_at: occurredAt,
    payload: {
      event_id: source_event_id,
      project_id: 'project-1',
      session_id: 'session-1',
      source_event_id,
      occurred_at: occurredAt,
      runtime: 'claude',
      source: 'claude_hook',
      source_assurance: 'observed',
      event_type: 'user.prompt',
      actor: { kind: 'user', id: 'user' },
      details: { summary, prompt_receipt: receipt },
    },
  });
  try {
    const first = store.getOrAppendPromptReceipt(storeDir, spec(firstReplayRef), build('same'));
    const replay = store.getOrAppendPromptReceipt(storeDir, spec(firstReplayRef), build('same'));
    assert.strictEqual(first.changed, true);
    assert.strictEqual(replay.changed, false);
    assert.strictEqual(replay.record.record_hash, first.record.record_hash);
    assert.strictEqual(first.receipt.occurrence, 1);
    assert.strictEqual(first.record.occurred_at, replay.record.occurred_at);

    assertErrorCode(
      () => store.getOrAppendPromptReceipt(storeDir, spec(firstReplayRef), build('changed')),
      'SELF_LEARNING_ID_CONFLICT'
    );
    const second = store.getOrAppendPromptReceipt(storeDir, spec(secondReplayRef), build('same'));
    assert.strictEqual(second.changed, true);
    assert.strictEqual(second.receipt.occurrence, 2);
    assert.notStrictEqual(second.record.record_id, first.record.record_id);
    assert.strictEqual(store.readJournal(storeDir).revision, 2);

    const thirdReplayRef = canonical.hashObject({ cursor: 'third' });
    assertErrorCode(
      () => store.getOrAppendPromptReceipt(storeDir, spec(thirdReplayRef), (context) => ({
        ...build('same')(context),
        actor: { kind: 'agent', id: 'forged', runtime: 'claude', authority_ref: null },
      })),
      'SELF_LEARNING_INVALID_RECEIPT'
    );
    assert.strictEqual(store.readJournal(storeDir).revision, 2);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  const contexts = [];
  const build = (summary) => ({ occurred_at: occurredAt, existing, journal }) => {
    contexts.push({ occurredAt, existing, journal });
    return input({
      record_id: 'event-receipt-1',
      entity_id: 'event-receipt-1',
      occurred_at: occurredAt,
      payload: {
        event_id: 'event-receipt-1',
        occurred_at: occurredAt,
        event_type: 'tool.result',
        summary,
      },
    });
  };
  try {
    const first = store.getOrAppendBehaviorEventReceipt(storeDir, {
      record_id: 'event-receipt-1',
      first_occurred_at: '2026-08-20T01:02:04.000Z',
    }, build('same'), {
      retry_timeout_ms: store.TOOL_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
    });
    const replay = store.getOrAppendBehaviorEventReceipt(storeDir, {
      record_id: 'event-receipt-1',
    }, build('same'), {
      retry_timeout_ms: store.TOOL_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
    });
    assert.strictEqual(first.changed, true);
    assert.strictEqual(replay.changed, false);
    assert.strictEqual(replay.record.record_hash, first.record.record_hash);
    assert.strictEqual(contexts[0].occurredAt, '2026-08-20T01:02:04.000Z');
    assert.strictEqual(contexts[0].existing, null);
    assert.strictEqual(contexts[0].journal.revision, 0);
    assert.strictEqual(contexts[1].occurredAt, '2026-08-20T01:02:04.000Z');
    assert.strictEqual(contexts[1].existing.record_hash, first.record.record_hash);
    assert.strictEqual(contexts[1].journal.revision, 1);
    assertErrorCode(
      () => store.getOrAppendBehaviorEventReceipt(
        storeDir,
        { record_id: 'event-receipt-1' },
        build('changed')
      ),
      'SELF_LEARNING_ID_CONFLICT'
    );
    assert.strictEqual(store.readJournal(storeDir).revision, 1);
    assert(
      store.TOOL_RECEIPT_LOCK_RETRY_TIMEOUT_MS < 2000,
      'Claude tool receipt lock budget must remain below the two-second host timeout'
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      windowsHide: true,
    });
    assert.strictEqual(exited.status, 0, exited.error && exited.error.message);
    const freshDead = writeLock(storeDir, {
      pid: exited.pid,
      acquired_at: new Date().toISOString(),
    });
    assertErrorCode(
      () => store.acquireJournalLock(storeDir, {
        operation: 'fresh-dead-lock-must-settle',
        retry_timeout_ms: 25,
      }),
      'SELF_LEARNING_LOCKED'
    );
    assert.strictEqual(fs.readFileSync(freshDead.lockFile, 'utf8'), freshDead.bytes);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      windowsHide: true,
    });
    assert.strictEqual(exited.status, 0, exited.error && exited.error.message);
    assert(Number.isSafeInteger(exited.pid) && exited.pid > 0);
    const stale = writeLock(storeDir, { pid: exited.pid });
    const written = store.appendRecord(storeDir, input({
      record_id: 'after-dead-lock',
      entity_id: 'after-dead-lock',
    }));
    assert.strictEqual(written.changed, true);
    assert.strictEqual(fs.existsSync(stale.lockFile), false);
    assert.strictEqual(store.readJournal(storeDir).revision, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const live = writeLock(storeDir, { pid: process.pid });
    assertErrorCode(
      () => store.acquireJournalLock(storeDir, {
        operation: 'must-not-steal-live-lock',
        retry_timeout_ms: 25,
      }),
      'SELF_LEARNING_LOCKED'
    );
    assert.strictEqual(fs.readFileSync(live.lockFile, 'utf8'), live.bytes);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const corrupt = writeLock(storeDir);
    fs.writeFileSync(corrupt.lockFile, '{"unexpected":true}\n');
    const before = fs.readFileSync(corrupt.lockFile, 'utf8');
    assertErrorCode(
      () => store.acquireJournalLock(storeDir, {
        operation: 'corrupt-lock-fails-closed',
        retry_timeout_ms: 25,
      }),
      'SELF_LEARNING_LOCK_CORRUPT'
    );
    assert.strictEqual(fs.readFileSync(corrupt.lockFile, 'utf8'), before);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  const originalReadFileSync = fs.readFileSync;
  try {
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      windowsHide: true,
    });
    assert.strictEqual(exited.status, 0, exited.error && exited.error.message);
    const stale = writeLock(storeDir, { pid: exited.pid, token: 'b'.repeat(32) });
    const liveReplacement = {
      ...stale.lock,
      token: 'c'.repeat(32),
      pid: process.pid,
      operation: 'replacement-live-lock',
    };
    const replacementBytes = `${JSON.stringify(liveReplacement, null, 2)}\n`;
    let lockReads = 0;
    fs.readFileSync = (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(stale.lockFile)) {
        lockReads += 1;
        if (lockReads === 2) fs.writeFileSync(stale.lockFile, replacementBytes);
      }
      return originalReadFileSync(target, ...args);
    };
    assertErrorCode(
      () => store.acquireJournalLock(storeDir, {
        operation: 'stale-lock-cas-test',
        retry_timeout_ms: 40,
      }),
      'SELF_LEARNING_LOCKED'
    );
    fs.readFileSync = originalReadFileSync;
    assert(lockReads >= 2, `expected identity/bytes recheck, got ${lockReads} reads`);
    assert.strictEqual(fs.readFileSync(stale.lockFile, 'utf8'), replacementBytes);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  const originalRmSync = fs.rmSync;
  const originalRenameSync = fs.renameSync;
  try {
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      windowsHide: true,
    });
    assert.strictEqual(exited.status, 0, exited.error && exited.error.message);
    const stale = writeLock(storeDir, { pid: exited.pid, token: 'd'.repeat(32) });
    const liveReplacement = {
      ...stale.lock,
      token: 'e'.repeat(32),
      pid: process.pid,
      operation: 'replacement-after-confirmation',
      acquired_at: new Date().toISOString(),
    };
    const replacementBytes = `${JSON.stringify(liveReplacement, null, 2)}\n`;
    let injected = false;
    const injectReplacement = (target) => {
      if (!injected && path.resolve(String(target)) === path.resolve(stale.lockFile)) {
        injected = true;
        fs.writeFileSync(stale.lockFile, replacementBytes);
      }
    };
    fs.rmSync = (target, options) => {
      injectReplacement(target);
      return originalRmSync(target, options);
    };
    fs.renameSync = (source, destination) => {
      injectReplacement(source);
      return originalRenameSync(source, destination);
    };
    assertErrorCode(
      () => store.acquireJournalLock(storeDir, {
        operation: 'stale-lock-post-confirmation-race',
        retry_timeout_ms: 50,
      }),
      'SELF_LEARNING_LOCKED'
    );
    fs.rmSync = originalRmSync;
    fs.renameSync = originalRenameSync;
    assert.strictEqual(injected, true);
    assert.strictEqual(fs.readFileSync(stale.lockFile, 'utf8'), replacementBytes);
  } finally {
    fs.rmSync = originalRmSync;
    fs.renameSync = originalRenameSync;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  const originalRenameSync = fs.renameSync;
  try {
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      windowsHide: true,
    });
    assert.strictEqual(exited.status, 0, exited.error && exited.error.message);
    const stale = writeLock(storeDir, { pid: exited.pid, token: '1'.repeat(32) });
    const liveReplacement = {
      ...stale.lock,
      token: '2'.repeat(32),
      pid: process.pid,
      operation: 'replacement-after-atomic-claim',
      acquired_at: new Date().toISOString(),
    };
    const replacementBytes = `${JSON.stringify(liveReplacement, null, 2)}\n`;
    let injected = false;
    fs.renameSync = (source, destination) => {
      const result = originalRenameSync(source, destination);
      if (!injected && path.resolve(String(source)) === path.resolve(stale.lockFile)) {
        injected = true;
        fs.writeFileSync(stale.lockFile, replacementBytes);
      }
      return result;
    };
    assertErrorCode(
      () => store.acquireJournalLock(storeDir, {
        operation: 'new-live-lock-after-claim',
        retry_timeout_ms: 50,
      }),
      'SELF_LEARNING_LOCKED'
    );
    fs.renameSync = originalRenameSync;
    assert.strictEqual(injected, true);
    assert.strictEqual(fs.readFileSync(stale.lockFile, 'utf8'), replacementBytes);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const first = store.appendRecord(storeDir, input(), {
      expected_revision: 0,
      expected_head_hash: null,
    });
    assert.strictEqual(first.changed, true);
    assertErrorCode(
      () => store.appendRecord(storeDir, input({
        record_id: 'event-2',
        entity_id: 'event-2',
      }), { expected_revision: 0 }),
      'SELF_LEARNING_REVISION_CONFLICT'
    );
    assertErrorCode(
      () => store.appendRecord(storeDir, input({
        record_id: 'event-2',
        entity_id: 'event-2',
      }), { expected_head_hash: `sha256:${'0'.repeat(64)}` }),
      'SELF_LEARNING_HASH_CONFLICT'
    );
    assert.throws(
      () => store.appendRecord(storeDir, input({
        record_id: 'event-2',
        entity_id: 'event-2',
      }), { expectedRevision: 1 }),
      /append options.*fields/i
    );
    assert.throws(
      () => store.appendRecord(storeDir, input({
        record_id: 'event-2',
        entity_id: 'event-2',
      }), { expected_head_hash: 'not-a-hash' }),
      /sha256/i
    );
    assert.strictEqual(store.readJournal(storeDir).revision, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const written = store.appendRecord(storeDir, input());
    const original = JSON.parse(fs.readFileSync(written.file, 'utf8'));

    fs.writeFileSync(written.file, `${JSON.stringify({ ...original, unexpected: true })}\n`);
    assert.throws(() => store.readJournal(storeDir), /fields do not match/i);
    fs.writeFileSync(written.file, `${JSON.stringify(original)}\n`);

    const wrongName = path.join(path.dirname(written.file), `000000000001-${'0'.repeat(64)}.json`);
    fs.renameSync(written.file, wrongName);
    assert.throws(() => store.readJournal(storeDir), /filename.*hash/i);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const written = store.appendRecord(storeDir, input());
    const original = JSON.parse(fs.readFileSync(written.file, 'utf8'));
    fs.writeFileSync(written.file, `${JSON.stringify({
      ...original,
      record_type: 'unsupported_record_type',
    })}\n`);
    assertErrorCode(() => store.readJournal(storeDir), 'SELF_LEARNING_CORRUPT');

    fs.writeFileSync(written.file, '{"truncated":');
    assertErrorCode(() => store.readJournal(storeDir), 'SELF_LEARNING_CORRUPT');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const first = store.appendRecord(storeDir, input());
    const second = store.appendRecord(storeDir, input({
      record_id: 'event-2',
      entity_id: 'event-2',
    }));
    const secondRecord = JSON.parse(fs.readFileSync(second.file, 'utf8'));
    fs.writeFileSync(second.file, `${JSON.stringify({
      ...secondRecord,
      previous_hash: `sha256:${'0'.repeat(64)}`,
    })}\n`);
    assertErrorCode(() => store.readJournal(storeDir), 'SELF_LEARNING_CORRUPT');

    fs.writeFileSync(second.file, `${JSON.stringify(secondRecord)}\n`);
    fs.rmSync(first.file);
    assertErrorCode(() => store.readJournal(storeDir), 'SELF_LEARNING_CORRUPT');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const written = store.appendRecord(storeDir, input());
    fs.writeFileSync(path.join(path.dirname(written.file), '.abandoned.tmp'), 'partial');
    assert.throws(() => store.readJournal(storeDir), /unexpected journal entry|residual/i);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const journalDir = path.join(storeDir, store.JOURNAL_DIR_NAME);
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, store.LOCK_FILE_NAME), '{"unexpected":true}\n');
    assertErrorCode(() => store.readJournal(storeDir), 'SELF_LEARNING_LOCK_CORRUPT');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  try {
    const lock = store.acquireJournalLock(storeDir, { operation: 'test' });
    assert.throws(() => store.readJournal(storeDir), /locked/i);
    lock.release();
    assert.strictEqual(store.readJournal(storeDir).revision, 0);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

{
  const { baseDir, storeDir } = fixture();
  const originalRmSync = fs.rmSync;
  try {
    store.appendRecord(storeDir, input());
    fs.rmSync = (target, options) => {
      if (path.basename(String(target)) === store.LOCK_FILE_NAME) {
        const error = new Error('simulated lock release denial');
        error.code = 'EACCES';
        throw error;
      }
      return originalRmSync(target, options);
    };
    let caught;
    try {
      store.appendRecord(storeDir, input({ payload: { changed: true } }));
    } catch (error) {
      caught = error;
    }
    assert(caught, 'conflicting append must fail');
    assert.strictEqual(caught.code, 'SELF_LEARNING_ID_CONFLICT');
    assert.strictEqual(caught.release_error.code, 'SELF_LEARNING_LOCK_RELEASE_FAILED');
  } finally {
    fs.rmSync = originalRmSync;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

console.log('self-learning store tests passed');
