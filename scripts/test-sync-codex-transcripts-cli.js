#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  acquireWatchLease,
  discoverTranscriptFiles,
  formatFatalDiagnostic,
  loadEnvFile,
  main,
  parseArgs,
  readOutboxJobs,
  refreshWatchLease,
  releaseWatchLease,
  runOnce,
  runWatch,
} = require('./sync-codex-transcripts');
const { enqueueTranscript, jobAddress } = require('./codex-transcript-outbox');
const { inspectTranscriptFile } = require('./lib/codex-transcript-projection');

let passed = 0;
let failed = 0;
const failures = [];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function outboxJob(overrides = {}) {
  return {
    schema: 'codex-transcript-outbox/v1',
    runtime: 'codex',
    root_session_id: '01a0376a-348a-79a1-a661-b2d08726726b',
    transcript_path: 'C:\\sessions\\rollout-01a0376a-348a-79a1-a661-b2d08726726b.jsonl',
    path_hash: 'a'.repeat(64),
    file_identity_hash: 'b'.repeat(64),
    observed_size: 100,
    queued_prefix_sha256: 'c'.repeat(64),
    mtime: '2026-08-25T05:35:01.000Z',
    queued_at: '2026-08-25T05:35:02.000Z',
    ...overrides,
  };
}

function writeOutboxJob(outbox, job, address = jobAddress(job)) {
  const file = path.join(outbox, `${address}.json`);
  fs.writeFileSync(file, JSON.stringify(job));
  return file;
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

test('CLI parser defaults to durable outbox and rejects conflicting source modes', () => {
  assert.strictEqual(parseArgs([]).mode, 'outbox');
  assert.strictEqual(parseArgs(['--all']).mode, 'all');
  assert.strictEqual(parseArgs(['--file', 'C:\\sessions\\one.jsonl']).mode, 'files');
  assert.throws(() => parseArgs(['--all', '--file', 'one.jsonl']), /choose only one/i);
  assert.throws(() => parseArgs(['--watch-seconds', '0']), /positive integer/i);
  assert.strictEqual(parseArgs([]).reconcileSeconds, 900);
  assert.strictEqual(parseArgs([]).reconcileAfter, null);
  assert.strictEqual(parseArgs(['--reconcile-seconds', '60']).reconcileSeconds, 60);
  assert.strictEqual(
    parseArgs(['--reconcile-after', '2026-08-25T06:00:00.000Z']).reconcileAfter,
    '2026-08-25T06:00:00.000Z'
  );
  assert.throws(() => parseArgs(['--reconcile-seconds', '0']), /positive integer/i);
  assert.throws(
    () => parseArgs(['--reconcile-after', '2026-08-25T14:00:00+08:00']),
    /reconcile-after.*UTC/i
  );
});

test('all discovery applies an inclusive activation cutoff while an omitted cutoff stays full', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-cutoff-'));
  try {
    const oldTranscript = path.join(root, 'old.jsonl');
    const boundaryTranscript = path.join(root, 'boundary.jsonl');
    const newTranscript = path.join(root, 'nested', 'new.jsonl');
    fs.mkdirSync(path.dirname(newTranscript), { recursive: true });
    for (const file of [oldTranscript, boundaryTranscript, newTranscript]) {
      fs.writeFileSync(file, '{}\n');
    }
    fs.utimesSync(oldTranscript, new Date('2026-08-25T05:59:59.000Z'), new Date('2026-08-25T05:59:59.000Z'));
    fs.utimesSync(boundaryTranscript, new Date('2026-08-25T06:00:00.000Z'), new Date('2026-08-25T06:00:00.000Z'));
    fs.utimesSync(newTranscript, new Date('2026-08-25T06:00:01.000Z'), new Date('2026-08-25T06:00:01.000Z'));

    assert.deepStrictEqual(
      discoverTranscriptFiles(root),
      [boundaryTranscript, newTranscript, oldTranscript].sort()
    );
    assert.deepStrictEqual(
      discoverTranscriptFiles(root, '2026-08-25T06:00:00.000Z'),
      [boundaryTranscript, newTranscript].sort()
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('all mode wires the activation cutoff into discovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-cutoff-run-'));
  try {
    const oldTranscript = path.join(root, 'old.jsonl');
    const recentTranscript = path.join(root, 'recent.jsonl');
    fs.writeFileSync(oldTranscript, '{}\n');
    fs.writeFileSync(recentTranscript, '{}\n');
    fs.utimesSync(oldTranscript, new Date('2026-08-25T05:59:59.000Z'), new Date('2026-08-25T05:59:59.000Z'));
    fs.utimesSync(recentTranscript, new Date('2026-08-25T06:00:00.000Z'), new Date('2026-08-25T06:00:00.000Z'));
    const synced = [];
    const result = await runOnce({
      mode: 'all',
      files: [],
      sessionsRoot: root,
      reconcileAfter: '2026-08-25T06:00:00.000Z',
      dryRun: false,
    }, {
      env: {},
      openPostgres: async () => ({ writer: {}, reader: {}, close: async () => {} }),
      syncFile: async (file) => {
        synced.push(file);
        return {
          verified: true,
          transcriptId: path.basename(file),
          eventCount: 1,
          insertedEvents: 1,
          trailingBytes: 0,
        };
      },
    });
    assert.strictEqual(result.attempted, 1);
    assert.deepStrictEqual(synced, [recentTranscript]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('outbox reader accepts v2 snapshot jobs without a queued prefix hash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-outbox-v2-'));
  try {
    const job = outboxJob({
      schema: 'codex-transcript-outbox/v2',
      root_session_id: 'thr_123',
      queued_prefix_sha256: undefined,
    });
    delete job.queued_prefix_sha256;
    writeOutboxJob(root, job);
    const jobs = readOutboxJobs(root);
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].job.schema, 'codex-transcript-outbox/v2');
    assert.strictEqual(jobs[0].job.root_session_id, 'thr_123');
    assert.strictEqual(jobs[0].job.queued_prefix_sha256, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('configured env file is authoritative for transcript PostgreSQL settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-env-'));
  try {
    const file = path.join(root, '.env');
    fs.writeFileSync(file, [
      '# private runtime values',
      'TRANSCRIPTS_POSTGRES_WRITE_URL=postgresql://writer:secret@127.0.0.1/db',
      'TRANSCRIPTS_POSTGRES_SSL=false',
    ].join('\n'));
    const target = {
      TRANSCRIPTS_POSTGRES_URL: 'postgresql://legacy:wrong@remote.example/db',
      TRANSCRIPTS_POSTGRES_READ_URL: 'postgresql://reader:wrong@remote.example/db',
      TRANSCRIPTS_POSTGRES_WRITE_URL: 'postgresql://writer:wrong@remote.example/db',
      TRANSCRIPTS_POSTGRES_SSL: 'true',
      UNRELATED_SETTING: 'preserved',
    };
    loadEnvFile(file, target);
    assert.strictEqual(
      target.TRANSCRIPTS_POSTGRES_WRITE_URL,
      'postgresql://writer:secret@127.0.0.1/db'
    );
    assert.strictEqual(target.TRANSCRIPTS_POSTGRES_SSL, 'false');
    assert.strictEqual(target.TRANSCRIPTS_POSTGRES_READ_URL, undefined);
    assert.strictEqual(target.TRANSCRIPTS_POSTGRES_URL, undefined);
    assert.strictEqual(target.UNRELATED_SETTING, 'preserved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('outbox reader accepts only bounded plain JSON job files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-outbox-read-'));
  try {
    const job = outboxJob();
    writeOutboxJob(root, job);
    fs.writeFileSync(path.join(root, 'ignore.txt'), 'not a job');
    const jobs = readOutboxJobs(root);
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].job.root_session_id, job.root_session_id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('outbox reader enforces the bounded official session id and filename content address', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-outbox-address-'));
  try {
    const invalidSessionId = outboxJob({
      root_session_id: 'thr_123\nsecret',
    });
    writeOutboxJob(root, invalidSessionId);
    assert.throws(() => readOutboxJobs(root), /root_session_id is invalid/i);
    fs.rmSync(path.join(root, `${jobAddress(invalidSessionId)}.json`));

    const validJob = outboxJob({ root_session_id: 'thr_123' });
    writeOutboxJob(root, validJob, 'c'.repeat(64));
    assert.throws(() => readOutboxJobs(root), /content address/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified complete outbox sync acknowledges the job only after readback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-outbox-drain-'));
  try {
    const sessionsRoot = path.join(root, 'sessions');
    const outbox = path.join(root, 'outbox');
    fs.mkdirSync(sessionsRoot);
    fs.mkdirSync(outbox);
    const transcript = path.join(sessionsRoot, 'rollout.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const queuedMtime = '2026-08-25T05:35:01.000Z';
    const jobFile = writeOutboxJob(outbox, outboxJob({
      transcript_path: transcript,
      observed_size: 3,
      queued_prefix_sha256: sha256('{}\n'),
      mtime: queuedMtime,
    }));
    const closeCalls = [];
    const result = await runOnce({
      mode: 'outbox',
      outbox,
      sessionsRoot,
      reconcileAfter: '2099-01-01T00:00:00.000Z',
    }, {
      env: {},
      openPostgres: async () => ({
        writer: {}, reader: {}, separateReader: true,
        close: async () => closeCalls.push('closed'),
      }),
      syncFile: async (_file, options) => {
        assert.strictEqual(options.expectedRootSessionId, '01a0376a-348a-79a1-a661-b2d08726726b');
        assert.strictEqual(options.expectedObservedSize, 3);
        assert.strictEqual(options.expectedMtime, queuedMtime);
        assert.strictEqual(options.expectedQueuedPrefixSha256, sha256('{}\n'));
        return {
          verified: true,
          transcriptId: 'physical-thread',
          eventCount: 2,
          insertedEvents: 2,
          nextByteOffset: 3,
          observedSize: 3,
          sourceMtimeMs: Date.parse(queuedMtime),
          trailingBytes: 0,
        };
      },
    });
    assert.strictEqual(result.verified, 1);
    assert.strictEqual(fs.existsSync(jobFile), false);
    assert.deepStrictEqual(closeCalls, ['closed']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v2 verified snapshot acknowledges without applying the v1 prefix contract', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-v2-drain-'));
  try {
    const sessionsRoot = path.join(root, 'sessions');
    const outbox = path.join(root, 'outbox');
    fs.mkdirSync(sessionsRoot);
    fs.mkdirSync(outbox);
    const transcript = path.join(sessionsRoot, 'rollout.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const job = outboxJob({
      schema: 'codex-transcript-outbox/v2',
      transcript_path: transcript,
      observed_size: 3,
      queued_prefix_sha256: undefined,
    });
    delete job.queued_prefix_sha256;
    const jobFile = writeOutboxJob(outbox, job);
    const result = await runOnce({ mode: 'outbox', outbox, sessionsRoot }, {
      env: {},
      openPostgres: async () => ({ writer: {}, reader: {}, close: async () => {} }),
      syncFile: async (_file, options) => {
        assert.strictEqual(options.expectedQueuedPrefixSha256, undefined);
        assert.strictEqual(options.expectedObservedSize, 3);
        return {
          verified: true,
          transcriptId: 'physical-thread',
          eventCount: 1,
          insertedEvents: 1,
          nextByteOffset: 3,
          observedSize: 3,
          sourceMtimeMs: Date.parse(job.mtime),
          trailingBytes: 0,
        };
      },
    });
    assert.strictEqual(result.verified, 1);
    assert.strictEqual(fs.existsSync(jobFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watch lease rejects a fresh owner and recovers dead or stale PID-reused owners atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-watch-lease-'));
  try {
    const first = acquireWatchLease(root, {
      pid: 101,
      hostname: 'host-a',
      isProcessAlive: (pid) => pid === 101,
      token: 'a'.repeat(32),
    });
    assert.strictEqual(first.acquired, true);
    const blocked = acquireWatchLease(root, {
      pid: 202,
      hostname: 'host-a',
      isProcessAlive: (pid) => pid === 101,
      token: 'b'.repeat(32),
    });
    assert.strictEqual(blocked.acquired, false);
    releaseWatchLease(first);

    const dead = acquireWatchLease(root, {
      pid: 303,
      hostname: 'host-a',
      isProcessAlive: () => false,
      token: 'c'.repeat(32),
    });
    assert.strictEqual(dead.acquired, true);
    const ownerFile = path.join(dead.directory, 'owner.json');
    fs.writeFileSync(ownerFile, JSON.stringify({
      pid: 404,
      hostname: 'host-a',
      token: 'd'.repeat(32),
      acquired_at: '2026-08-25T00:00:00.000Z',
    }));
    const recovered = acquireWatchLease(root, {
      pid: 505,
      hostname: 'host-a',
      isProcessAlive: () => false,
      token: 'e'.repeat(32),
    });
    assert.strictEqual(recovered.acquired, true);
    releaseWatchLease(recovered);

    const reused = acquireWatchLease(root, {
      pid: 606,
      hostname: 'host-a',
      isProcessAlive: () => true,
      token: 'f'.repeat(32),
    });
    assert.strictEqual(reused.acquired, true);
    const reusedOwnerFile = path.join(reused.directory, 'owner.json');
    const staleAt = new Date(Date.now() - (10 * 60 * 1000));
    fs.utimesSync(reusedOwnerFile, staleAt, staleAt);
    const pidReusedRecovery = acquireWatchLease(root, {
      pid: 707,
      hostname: 'host-a',
      isProcessAlive: () => true,
      token: '1'.repeat(32),
    });
    assert.strictEqual(pidReusedRecovery.acquired, true);
    const beforeHeartbeat = fs.statSync(
      path.join(pidReusedRecovery.directory, 'owner.json')
    ).mtimeMs;
    const heartbeatAt = new Date(beforeHeartbeat + 1_000);
    assert.strictEqual(refreshWatchLease(pidReusedRecovery, { now: () => heartbeatAt }), true);
    assert.strictEqual(
      fs.statSync(path.join(pidReusedRecovery.directory, 'owner.json')).mtimeMs,
      heartbeatAt.getTime()
    );
    releaseWatchLease(pidReusedRecovery);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watch lease does not steal a freshly-created lock before owner publication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-watch-publish-'));
  try {
    const directory = path.join(root, '.sync-worker-lease');
    fs.mkdirSync(directory);
    const blocked = acquireWatchLease(root, {
      pid: 551,
      hostname: 'host-a',
      isProcessAlive: () => false,
      token: '5'.repeat(32),
    });
    assert.strictEqual(blocked.acquired, false);

    fs.utimesSync(directory, new Date(0), new Date(0));
    const recovered = acquireWatchLease(root, {
      pid: 552,
      hostname: 'host-a',
      isProcessAlive: () => false,
      token: '6'.repeat(32),
    });
    assert.strictEqual(recovered.acquired, true);
    releaseWatchLease(recovered);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watch drains first, reconciles all sessions, and retries fatal cycles with backoff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-watch-retry-'));
  try {
    const outbox = path.join(root, 'outbox');
    const sessionsRoot = path.join(root, 'sessions');
    fs.mkdirSync(outbox);
    fs.mkdirSync(sessionsRoot);
    const calls = [];
    const waits = [];
    const outputs = [];
    let outboxAttempts = 0;
    const result = await runWatch({
      mode: 'outbox', files: [], outbox, sessionsRoot, watchSeconds: 2,
      reconcileSeconds: 900, dryRun: false, json: true, keepJobs: false,
    }, {
      env: {},
      maxIterations: 3,
      wait: async (milliseconds) => waits.push(milliseconds),
      now: () => 0,
      output: (line) => outputs.push(line),
      runOnce: async (cycleArgs) => {
        calls.push(cycleArgs.mode);
        if (cycleArgs.mode === 'outbox') {
          outboxAttempts += 1;
          if (outboxAttempts === 1) throw new Error('postgresql://writer:secret@private/db');
        }
        return {
          attempted: 1, verified: 1, pending: 0, failed: 0,
          insertedEvents: 1, storedEvents: 1, separateReader: true, results: [],
        };
      },
      leaseOptions: {
        pid: 606,
        hostname: 'host-a',
        isProcessAlive: () => false,
        token: 'f'.repeat(32),
      },
    });
    assert.strictEqual(result.status, 'stopped');
    assert.deepStrictEqual(calls, ['outbox', 'all', 'outbox', 'outbox']);
    assert.deepStrictEqual(waits, [2000, 2000]);
    assert.strictEqual(outputs.length, 3);
    assert.strictEqual(outputs.join('\n').includes('secret'), false);
    assert.strictEqual(outputs.join('\n').includes(root), false);
    assert.match(outputs[0], /E_TRANSCRIPT_SYNC_FATAL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watch keeps retrying failed jobs and uses exponential failure backoff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-watch-job-failure-'));
  try {
    const outbox = path.join(root, 'outbox');
    const sessionsRoot = path.join(root, 'sessions');
    fs.mkdirSync(outbox);
    fs.mkdirSync(sessionsRoot);
    const waits = [];
    let iteration = 0;
    await runWatch({
      mode: 'outbox', files: [], outbox, sessionsRoot, watchSeconds: 3,
      reconcileSeconds: 900, dryRun: false, json: false, keepJobs: false,
    }, {
      env: {},
      maxIterations: 3,
      wait: async (milliseconds) => waits.push(milliseconds),
      now: () => 0,
      output: () => {},
      runOnce: async (cycleArgs) => {
        if (cycleArgs.mode === 'all') {
          return { attempted: 0, verified: 0, pending: 0, failed: 0, insertedEvents: 0, results: [] };
        }
        iteration += 1;
        return {
          attempted: 1,
          verified: iteration === 3 ? 1 : 0,
          pending: 0,
          failed: iteration === 3 ? 0 : 1,
          insertedEvents: 0,
          results: [],
        };
      },
      leaseOptions: {
        pid: 707,
        hostname: 'host-a',
        isProcessAlive: () => false,
        token: '1'.repeat(32),
      },
    });
    assert.deepStrictEqual(waits, [3000, 6000]);
    assert.strictEqual(iteration, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watch reconciliation repeats on schedule and recursive discovery includes subagents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-watch-reconcile-'));
  try {
    const outbox = path.join(root, 'outbox');
    const sessionsRoot = path.join(root, 'sessions');
    const subagents = path.join(sessionsRoot, '2026', '08', '25', 'subagents');
    fs.mkdirSync(outbox);
    fs.mkdirSync(subagents, { recursive: true });
    const rootTranscript = path.join(sessionsRoot, 'root.jsonl');
    const subagentTranscript = path.join(subagents, 'agent-child.jsonl');
    fs.writeFileSync(rootTranscript, '{}\n');
    fs.writeFileSync(subagentTranscript, '{}\n');
    assert.deepStrictEqual(
      discoverTranscriptFiles(sessionsRoot),
      [rootTranscript, subagentTranscript].sort()
    );

    const modes = [];
    const times = [0, 899_000, 900_000];
    await runWatch({
      mode: 'outbox', files: [], outbox, sessionsRoot, watchSeconds: 1,
      reconcileSeconds: 900, dryRun: false, json: false, keepJobs: false,
    }, {
      env: {},
      maxIterations: 3,
      wait: async () => {},
      now: () => times.shift(),
      output: () => {},
      runOnce: async (cycleArgs) => {
        modes.push(cycleArgs.mode);
        return { attempted: 0, verified: 0, pending: 0, failed: 0, insertedEvents: 0, results: [] };
      },
      leaseOptions: {
        pid: 750,
        hostname: 'host-a',
        isProcessAlive: () => false,
        token: '4'.repeat(32),
      },
    });
    assert.deepStrictEqual(modes, ['outbox', 'all', 'outbox', 'outbox', 'all']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('main watch exits successfully when another live worker owns the outbox', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-watch-main-'));
  try {
    const outbox = path.join(root, 'outbox');
    fs.mkdirSync(outbox);
    const owner = acquireWatchLease(outbox, {
      pid: 808,
      hostname: 'host-a',
      isProcessAlive: () => false,
      token: '2'.repeat(32),
    });
    const output = [];
    const code = await main(['--watch', '--outbox', outbox], {}, {
      output: (line) => output.push(line),
      leaseOptions: {
        pid: 909,
        hostname: 'host-a',
        isProcessAlive: (pid) => pid === 808,
        token: '3'.repeat(32),
      },
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, ['[codex-transcript-sync] worker=already-running']);
    releaseWatchLease(owner);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('partial or unverified outbox sync retains the durable job', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-outbox-retry-'));
  try {
    const sessionsRoot = path.join(root, 'sessions');
    const outbox = path.join(root, 'outbox');
    fs.mkdirSync(sessionsRoot);
    fs.mkdirSync(outbox);
    const transcript = path.join(sessionsRoot, 'rollout.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const job = outboxJob({
      transcript_path: transcript,
      observed_size: 3,
      queued_prefix_sha256: sha256('{}\n'),
    });
    let jobFile = writeOutboxJob(outbox, job);
    const result = await runOnce({ mode: 'outbox', outbox, sessionsRoot }, {
      env: {},
      openPostgres: async () => ({ writer: {}, reader: {}, close: async () => {} }),
      syncFile: async () => ({
        verified: true,
        transcriptId: 'physical-thread',
        eventCount: 1,
        insertedEvents: 1,
        nextByteOffset: 3,
        observedSize: 8,
        sourceMtimeMs: Date.parse(job.mtime),
        trailingBytes: 5,
      }),
    });
    assert.strictEqual(result.pending, 1);
    assert.strictEqual(fs.existsSync(jobFile), true);

    fs.rmSync(jobFile);
    jobFile = writeOutboxJob(outbox, job);
    const unverified = await runOnce({ mode: 'outbox', outbox, sessionsRoot }, {
      env: {},
      openPostgres: async () => ({ writer: {}, reader: {}, close: async () => {} }),
      syncFile: async () => ({
        verified: false,
        transcriptId: 'physical-thread',
        eventCount: 1,
        insertedEvents: 1,
        nextByteOffset: 3,
        observedSize: 3,
        sourceMtimeMs: Date.parse(job.mtime),
        trailingBytes: 0,
      }),
    });
    assert.strictEqual(unverified.verified, 0);
    assert.strictEqual(unverified.pending, 1);
    assert.strictEqual(fs.existsSync(jobFile), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified outbox sync retains the job until it covers queued size and mtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-outbox-coverage-'));
  try {
    const sessionsRoot = path.join(root, 'sessions');
    const outbox = path.join(root, 'outbox');
    fs.mkdirSync(sessionsRoot);
    fs.mkdirSync(outbox);
    const transcript = path.join(sessionsRoot, 'rollout.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const job = outboxJob({
      transcript_path: transcript,
      observed_size: 3,
      queued_prefix_sha256: sha256('{}\n'),
    });
    const jobFile = writeOutboxJob(outbox, job);
    const database = () => ({ writer: {}, reader: {}, close: async () => {} });
    const result = await runOnce({ mode: 'outbox', outbox, sessionsRoot }, {
      env: {},
      openPostgres: async () => database(),
      syncFile: async () => ({
        verified: true,
        transcriptId: 'physical-thread',
        eventCount: 1,
        insertedEvents: 1,
        nextByteOffset: 2,
        observedSize: 3,
        sourceMtimeMs: Date.parse(job.mtime),
        trailingBytes: 0,
      }),
    });
    assert.strictEqual(result.pending, 1);
    assert.strictEqual(fs.existsSync(jobFile), true);

    const staleMtime = await runOnce({ mode: 'outbox', outbox, sessionsRoot }, {
      env: {},
      openPostgres: async () => database(),
      syncFile: async () => ({
        verified: true,
        transcriptId: 'physical-thread',
        eventCount: 1,
        insertedEvents: 0,
        nextByteOffset: 3,
        observedSize: 3,
        sourceMtimeMs: Date.parse(job.mtime) - 1,
        trailingBytes: 0,
      }),
    });
    assert.strictEqual(staleMtime.pending, 1);
    assert.strictEqual(fs.existsSync(jobFile), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('same-inode queued prefix rewrite fails closed and retains the job', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-prefix-rewrite-'));
  try {
    const sessionsRoot = path.join(root, 'sessions');
    const outbox = path.join(root, 'outbox');
    fs.mkdirSync(sessionsRoot);
    fs.mkdirSync(outbox);
    const transcript = path.join(sessionsRoot, 'rollout.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const job = outboxJob({
      transcript_path: transcript,
      observed_size: 3,
      queued_prefix_sha256: sha256('{}\n'),
    });
    const jobFile = writeOutboxJob(outbox, job);
    fs.writeFileSync(transcript, '[]\n');
    let syncCalled = false;
    const result = await runOnce({ mode: 'outbox', outbox, sessionsRoot }, {
      env: {},
      openPostgres: async () => ({ writer: {}, reader: {}, close: async () => {} }),
      syncFile: async () => {
        syncCalled = true;
        return { verified: true, trailingBytes: 0 };
      },
    });
    assert.strictEqual(syncCalled, false);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.results[0].errorCode, 'E_TRANSCRIPT_SYNC_FAILED');
    assert.strictEqual(fs.existsSync(jobFile), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failure summaries expose only stable codes and source references', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-safe-errors-'));
  try {
    const sessionsRoot = path.join(root, 'sessions');
    fs.mkdirSync(sessionsRoot);
    const transcript = path.join(sessionsRoot, 'sensitive-session.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const result = await runOnce({ mode: 'files', files: [transcript], sessionsRoot }, {
      env: {},
      openPostgres: async () => ({ writer: {}, reader: {}, close: async () => {} }),
      syncFile: async () => {
        throw new Error(`database rejected ${transcript} below ${sessionsRoot}`);
      },
    });
    const serialized = JSON.stringify(result);
    assert.strictEqual(result.results[0].errorCode, 'E_TRANSCRIPT_SYNC_FAILED');
    assert.strictEqual(serialized.includes(transcript), false);
    assert.strictEqual(serialized.includes(sessionsRoot), false);
    assert.match(result.results[0].sourceRef, /^[a-f0-9]{12}$/);
    assert.strictEqual(formatFatalDiagnostic(new Error(`missing ${sessionsRoot}`)),
      '[codex-transcript-sync] E_TRANSCRIPT_SYNC_FATAL\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real SessionEnd producer contract is consumable without identity drift', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-outbox-contract-'));
  try {
    const codexHome = path.join(root, '.codex');
    const sessionsRoot = path.join(codexHome, 'sessions');
    const day = path.join(sessionsRoot, '2026', '08', '25');
    fs.mkdirSync(day, { recursive: true });
    const sessionId = '019f7d0d-9c40-7d72-8e5d-e4119e20fd20';
    const transcript = path.join(day, `rollout-${sessionId}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify({
      ordinal: 0,
      timestamp: '2026-08-25T05:35:02.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        session_id: sessionId,
        timestamp: '2026-08-25T05:35:02.000Z',
        cwd: 'C:\\project\\example',
        originator: 'Codex Desktop',
        cli_version: '0.149.0',
        source: 'vscode',
        model_provider: 'openai',
      },
    })}\n`);
    enqueueTranscript({ session_id: sessionId, transcript_path: transcript }, {
      codexHome,
      queuedAt: '2026-08-25T05:36:00.000Z',
      workerLauncher: () => ({ status: 'disabled' }),
    });
    const header = inspectTranscriptFile(transcript, { sessionsRoot });
    const result = await runOnce({
      mode: 'outbox',
      outbox: path.join(codexHome, 'transcript-outbox'),
      sessionsRoot,
    }, {
      env: { CODEX_HOME: codexHome },
      openPostgres: async () => ({ writer: {}, reader: {}, close: async () => {} }),
      syncFile: async (_file, options) => {
        assert.strictEqual(options.expectedRootSessionId, sessionId);
        assert.strictEqual(options.expectedPathHash, header.pathHash);
        assert.strictEqual(options.expectedFileIdentityHash, header.fileIdentityHash);
        return {
          verified: true,
          transcriptId: sessionId,
          eventCount: 1,
          insertedEvents: 1,
          nextByteOffset: header.observedSize,
          observedSize: header.observedSize,
          sourceMtimeMs: header.sourceMtimeMs,
          trailingBytes: 0,
        };
      },
    });
    assert.strictEqual(result.verified, 1);
    assert.deepStrictEqual(
      fs.readdirSync(path.join(codexHome, 'transcript-outbox')).filter((name) => name.endsWith('.json')),
      []
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const { name, error } of failures) {
      console.error(`\n[${name}]\n${error.stack || error.message}`);
    }
    process.exitCode = 1;
  }
})();
