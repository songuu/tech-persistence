#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FAILURE_DIAGNOSTIC,
  JOB_SCHEMA,
  enqueueTranscript,
  inspectTranscript,
  jobAddress,
  startTranscriptSyncWorker,
} = require('./codex-transcript-outbox');

const SESSION_ID = '019f7d0d-9c40-7d72-8e5d-e4119e20fd20';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-codex-outbox-'));
  const codexHome = path.join(root, '.codex');
  const sessionsRoot = path.join(codexHome, 'sessions');
  const transcriptDir = path.join(sessionsRoot, '2026', '08', '25');
  const transcriptPath = path.join(transcriptDir, `rollout-${SESSION_ID}.jsonl`);
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(
    transcriptPath,
    '{"type":"session_meta","payload":{"session_id":"sensitive-body-id"}}\n'
  );
  try {
    fn({ root, codexHome, sessionsRoot, transcriptPath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
}

function isolatedOptions(options = {}) {
  return {
    ...options,
    workerLauncher: () => ({ status: 'started' }),
  };
}

function writeTranscriptSyncConfig(home) {
  const runtimeRoot = path.join(home, 'runtime');
  const worker = path.join(runtimeRoot, 'scripts', 'sync-codex-transcripts.js');
  const envFile = path.join(home, 'transcripts.env');
  const configDir = path.join(home, '.tech-persistence');
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(worker, '#!/usr/bin/env node\n');
  fs.writeFileSync(envFile, 'TRANSCRIPT_POSTGRES_URL=redacted\n');
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    transcriptSync: {
      enabled: true,
      runtimeRoot,
      envFile,
      watchSeconds: 17,
      reconcileAfter: '2026-08-25T06:00:00.000Z',
    },
  }));
}

test('SessionEnd queues one O(1) v2 content-addressed 0600 job without transcript content', () => {
  withFixture(({ codexHome, transcriptPath }) => {
    const chmodModes = [];
    let fsyncCalls = 0;
    const directoryDescriptors = new Map();
    let nextDirectoryDescriptor = 900_000;
    const observingFileSystem = {
      ...fs,
      realpathSync: fs.realpathSync,
      openSync(file, flags, mode) {
        if ((file === codexHome || file === path.join(codexHome, 'transcript-outbox'))
            && flags === 'r') {
          const descriptor = nextDirectoryDescriptor++;
          directoryDescriptors.set(descriptor, file);
          return descriptor;
        }
        return fs.openSync(file, flags, mode);
      },
      closeSync(descriptor) {
        if (directoryDescriptors.has(descriptor)) return;
        return fs.closeSync(descriptor);
      },
      fchmodSync(descriptor, mode) {
        chmodModes.push(mode);
        return fs.fchmodSync(descriptor, mode);
      },
      fsyncSync(descriptor) {
        fsyncCalls += 1;
        if (directoryDescriptors.has(descriptor)) return;
        return fs.fsyncSync(descriptor);
      },
    };
    observingFileSystem.realpathSync.native = fs.realpathSync.native;
    const result = enqueueTranscript({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      cwd: 'C:/must-not-persist',
      last_assistant_message: 'must-not-persist',
    }, isolatedOptions({
      codexHome,
      fileSystem: observingFileSystem,
      platform: 'linux',
      queuedAt: '2026-08-25T01:02:03.004Z',
    }));

    assert.strictEqual(result.status, 'queued');
    assert.deepStrictEqual(chmodModes, [0o600]);
    assert.strictEqual(fsyncCalls, 3);
    assert.deepStrictEqual([...directoryDescriptors.values()], [
      codexHome,
      path.join(codexHome, 'transcript-outbox'),
    ]);
    assert.match(path.basename(result.file), /^[a-f0-9]{64}\.json$/);
    const raw = fs.readFileSync(result.file, 'utf8');
    const job = JSON.parse(raw);
    assert.strictEqual(path.basename(result.file), `${jobAddress(job)}.json`);
    assert.deepStrictEqual(Object.keys(job), [
      'schema',
      'runtime',
      'root_session_id',
      'transcript_path',
      'path_hash',
      'file_identity_hash',
      'observed_size',
      'mtime',
      'queued_at',
    ]);
    assert.strictEqual(job.schema, JOB_SCHEMA);
    assert.strictEqual(job.runtime, 'codex');
    assert.strictEqual(job.root_session_id, SESSION_ID);
    assert.strictEqual(job.transcript_path, fs.realpathSync.native(transcriptPath));
    assert.match(job.path_hash, /^[a-f0-9]{64}$/);
    assert.match(job.file_identity_hash, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(job.observed_size));
    assert(job.observed_size > 0);
    assert(!Object.hasOwn(job, 'queued_prefix_sha256'));
    assert.strictEqual(job.queued_at, '2026-08-25T01:02:03.004Z');
    assert(!raw.includes('sensitive-body-id'));
    assert(!raw.includes('must-not-persist'));
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(result.file).mode & 0o777, 0o600);
    }
  });
});

test('v2 observation is O(1) and never reads transcript bytes', () => {
  withFixture(({ sessionsRoot, transcriptPath }) => {
    const metadataOnlyFileSystem = {
      ...fs,
      realpathSync: fs.realpathSync,
      readSync() {
        throw new Error('transcript bytes must not be read by SessionEnd');
      },
    };
    metadataOnlyFileSystem.realpathSync.native = fs.realpathSync.native;

    const observation = inspectTranscript(
      transcriptPath,
      sessionsRoot,
      metadataOnlyFileSystem
    );
    assert.strictEqual(observation.observedSize, fs.statSync(transcriptPath).size);
    assert(!Object.hasOwn(observation, 'queuedPrefixSha256'));
  });
});

test('jobAddress remains compatible with legacy v1 jobs', () => {
  const legacyJob = {
    schema: 'codex-transcript-outbox/v1',
    runtime: 'codex',
    root_session_id: SESSION_ID,
    transcript_path: 'C:\\legacy\\rollout.jsonl',
    path_hash: 'a'.repeat(64),
    file_identity_hash: 'b'.repeat(64),
    observed_size: 42,
    mtime: '2026-08-25T01:02:03.004Z',
    queued_prefix_sha256: 'c'.repeat(64),
    queued_at: '2026-08-25T01:02:03.004Z',
  };
  const expectedProjection = {
    schema: legacyJob.schema,
    runtime: legacyJob.runtime,
    root_session_id: legacyJob.root_session_id,
    transcript_path: legacyJob.transcript_path,
    path_hash: legacyJob.path_hash,
    file_identity_hash: legacyJob.file_identity_hash,
    observed_size: legacyJob.observed_size,
    mtime: legacyJob.mtime,
    queued_prefix_sha256: legacyJob.queued_prefix_sha256,
  };
  assert.strictEqual(
    jobAddress(legacyJob),
    crypto.createHash('sha256').update(JSON.stringify(expectedProjection)).digest('hex')
  );
});

test('replayed SessionEnd is create-once and preserves the first queued_at', () => {
  withFixture(({ codexHome, transcriptPath }) => {
    const first = enqueueTranscript({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
    }, isolatedOptions({
      codexHome,
      queuedAt: '2026-08-25T01:02:03.004Z',
    }));
    const replay = enqueueTranscript({
      session_id: SESSION_ID.toUpperCase(),
      transcript_path: transcriptPath,
    }, isolatedOptions({
      codexHome,
      queuedAt: '2099-01-01T00:00:00.000Z',
    }));

    assert.strictEqual(first.status, 'queued');
    assert.strictEqual(replay.status, 'duplicate');
    assert.strictEqual(replay.file, first.file);
    assert.deepStrictEqual(jsonFiles(path.dirname(first.file)), [path.basename(first.file)]);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(first.file, 'utf8')).queued_at,
      '2026-08-25T01:02:03.004Z'
    );
  });
});

test('a pre-existing content-addressed job with extra content is rejected', () => {
  withFixture(({ codexHome, transcriptPath }) => {
    const first = enqueueTranscript({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
    }, isolatedOptions({
      codexHome,
      queuedAt: '2026-08-25T01:02:03.004Z',
    }));
    const existing = JSON.parse(fs.readFileSync(first.file, 'utf8'));
    fs.writeFileSync(first.file, JSON.stringify({
      ...existing,
      transcript_body: 'must-never-enter-outbox',
    }));

    assert.throws(
      () => enqueueTranscript({
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
      }, isolatedOptions({ codexHome })),
      /does not match|content address/i
    );
  });
});

test('official bounded session ids and an absolute plain transcript below the configured root are accepted', () => {
  withFixture(({ root, codexHome, sessionsRoot, transcriptPath }) => {
    const official = enqueueTranscript({
      session_id: 'thr_123',
      transcript_path: transcriptPath,
    }, isolatedOptions({ codexHome, queuedAt: '2026-08-25T01:02:03.004Z' }));
    assert.strictEqual(
      JSON.parse(fs.readFileSync(official.file, 'utf8')).root_session_id,
      'thr_123'
    );
    assert.throws(() => enqueueTranscript({
      session_id: 'thr_123\nsecret',
      transcript_path: transcriptPath,
    }, isolatedOptions({ codexHome })), /session_id/i);
    assert.throws(() => enqueueTranscript({
      session_id: `thr_${'x'.repeat(300)}`,
      transcript_path: transcriptPath,
    }, isolatedOptions({ codexHome })), /session_id/i);
    assert.throws(
      () => enqueueTranscript({ session_id: SESSION_ID, transcript_path: 'relative.jsonl' }, isolatedOptions({ codexHome })),
      /absolute/i
    );

    const outside = path.join(root, 'outside.jsonl');
    fs.writeFileSync(outside, '{}\n');
    assert.throws(
      () => enqueueTranscript({ session_id: SESSION_ID, transcript_path: outside }, isolatedOptions({ codexHome })),
      /transcripts root/i
    );
    assert.throws(
      () => enqueueTranscript({
        session_id: SESSION_ID,
        transcript_path: path.dirname(transcriptPath),
      }, isolatedOptions({ codexHome })),
      /plain file/i
    );

    const link = path.join(sessionsRoot, 'linked.jsonl');
    try {
      fs.symlinkSync(transcriptPath, link, 'file');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      return;
    }
    assert.throws(
      () => enqueueTranscript({ session_id: SESSION_ID, transcript_path: link }, isolatedOptions({ codexHome })),
      /symbolic link|plain file/i
    );
  });
});

test('nullable official transcript_path still launches full reconciliation', () => {
  withFixture(({ codexHome }) => {
    let launches = 0;
    const result = enqueueTranscript({
      session_id: 'thr_nullable_path',
      transcript_path: null,
    }, {
      codexHome,
      workerLauncher: () => {
        launches += 1;
        return { status: 'started' };
      },
    });
    assert.strictEqual(result.status, 'reconcile-only');
    assert.strictEqual(result.worker.status, 'started');
    assert.strictEqual(launches, 1);
    assert.strictEqual(fs.existsSync(path.join(codexHome, 'transcript-outbox')), false);
  });
});

test('an explicit CODEX_TRANSCRIPTS_ROOT is accepted without weakening containment', () => {
  withFixture(({ root, codexHome }) => {
    const transcriptsRoot = path.join(root, 'custom-transcripts');
    const transcriptPath = path.join(transcriptsRoot, 'custom.jsonl');
    fs.mkdirSync(transcriptsRoot);
    fs.writeFileSync(transcriptPath, '{}\n');
    const result = enqueueTranscript({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
    }, isolatedOptions({
      codexHome,
      env: { CODEX_TRANSCRIPTS_ROOT: transcriptsRoot },
      queuedAt: '2026-08-25T01:02:03.004Z',
    }));
    assert.strictEqual(result.status, 'queued');

    const outside = path.join(root, 'outside-custom-root.jsonl');
    fs.writeFileSync(outside, '{}\n');
    assert.throws(
      () => enqueueTranscript({ session_id: SESSION_ID, transcript_path: outside }, isolatedOptions({
        codexHome,
        env: { CODEX_TRANSCRIPTS_ROOT: transcriptsRoot },
      })),
      /transcripts root/i
    );
  });
});

test('fd identity verification rejects a transcript path replaced after open', () => {
  withFixture(({ sessionsRoot, transcriptPath }) => {
    const displaced = `${transcriptPath}.opened`;
    let replaced = false;
    const racingFileSystem = {
      ...fs,
      realpathSync: fs.realpathSync,
      openSync(...args) {
        const fd = fs.openSync(...args);
        if (!replaced) {
          replaced = true;
          fs.renameSync(transcriptPath, displaced);
          fs.writeFileSync(transcriptPath, 'replacement\n');
        }
        return fd;
      },
    };
    racingFileSystem.realpathSync.native = fs.realpathSync.native;

    assert.throws(
      () => inspectTranscript(transcriptPath, sessionsRoot, racingFileSystem),
      /replaced|identity/i
    );
  });
});

test('valid transcriptSync config launches the fixed worker detached without a shell', () => {
  withFixture(({ root }) => {
    const runtimeRoot = path.join(root, 'runtime');
    const worker = path.join(runtimeRoot, 'scripts', 'sync-codex-transcripts.js');
    const envFile = path.join(root, 'transcripts.env');
    const configDir = path.join(root, '.tech-persistence');
    const configPath = path.join(configDir, 'config.json');
    fs.mkdirSync(path.dirname(worker), { recursive: true });
    fs.mkdirSync(configDir);
    fs.writeFileSync(worker, '#!/usr/bin/env node\n');
    fs.writeFileSync(envFile, 'TRANSCRIPT_POSTGRES_URL=redacted\n');
    fs.writeFileSync(configPath, JSON.stringify({
      transcriptSync: {
        enabled: true,
        runtimeRoot,
        envFile,
        watchSeconds: 17,
        reconcileSeconds: 901,
        reconcileAfter: '2026-08-25T06:00:00.000Z',
      },
    }));

    const calls = [];
    let unrefCalls = 0;
    const result = startTranscriptSyncWorker({
      env: { TECH_PERSISTENCE_CONFIG: configPath },
      processExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return {
          pid: 12345,
          once() {},
          unref() { unrefCalls += 1; },
        };
      },
    });

    assert.deepStrictEqual(result, { status: 'started' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepStrictEqual(calls[0].args, [
      fs.realpathSync.native(worker),
      '--watch-seconds',
      '17',
      '--reconcile-seconds',
      '901',
      '--reconcile-after',
      '2026-08-25T06:00:00.000Z',
      '--env-file',
      fs.realpathSync.native(envFile),
    ]);
    assert.deepStrictEqual(calls[0].options, {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    assert.strictEqual(unrefCalls, 1);
  });
});

test('worker rejects a missing or non-canonical reconciliation baseline', () => {
  withFixture(({ root }) => {
    const runtimeRoot = path.join(root, 'runtime');
    const worker = path.join(runtimeRoot, 'scripts', 'sync-codex-transcripts.js');
    const envFile = path.join(root, 'transcripts.env');
    const configPath = path.join(root, 'config.json');
    fs.mkdirSync(path.dirname(worker), { recursive: true });
    fs.writeFileSync(worker, '#!/usr/bin/env node\n');
    fs.writeFileSync(envFile, 'TRANSCRIPT_POSTGRES_URL=redacted\n');

    const base = { enabled: true, runtimeRoot, envFile, watchSeconds: 17 };
    fs.writeFileSync(configPath, JSON.stringify({ transcriptSync: base }));
    assert.deepStrictEqual(startTranscriptSyncWorker({ configPath }), { status: 'failed' });

    fs.writeFileSync(configPath, JSON.stringify({
      transcriptSync: { ...base, reconcileAfter: '2026-08-25T14:00:00+08:00' },
    }));
    assert.deepStrictEqual(startTranscriptSyncWorker({ configPath }), { status: 'failed' });
  });
});

test('invalid config and spawn failure retain the durable outbox job', () => {
  withFixture(({ root, codexHome, transcriptPath }) => {
    const missingConfig = path.join(root, 'missing-config.json');
    const missing = enqueueTranscript({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
    }, {
      codexHome,
      configPath: missingConfig,
      queuedAt: '2026-08-25T01:02:03.004Z',
    });
    assert.strictEqual(missing.worker.status, 'failed');
    assert(fs.existsSync(missing.file));

    const runtimeRoot = path.join(root, 'runtime');
    const worker = path.join(runtimeRoot, 'scripts', 'sync-codex-transcripts.js');
    const envFile = path.join(root, 'transcripts.env');
    const configPath = path.join(root, 'config.json');
    fs.mkdirSync(path.dirname(worker), { recursive: true });
    fs.writeFileSync(worker, '#!/usr/bin/env node\n');
    fs.writeFileSync(envFile, 'TRANSCRIPT_POSTGRES_URL=redacted\n');
    fs.writeFileSync(configPath, JSON.stringify({
      transcriptSync: {
        enabled: true,
        runtimeRoot,
        envFile,
        watchSeconds: 17,
        reconcileAfter: '2026-08-25T06:00:00.000Z',
      },
    }));
    const failedSpawn = enqueueTranscript({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
    }, {
      codexHome,
      configPath,
      spawn() { throw new Error('secret spawn path'); },
      queuedAt: '2026-08-25T01:02:03.004Z',
    });
    assert.strictEqual(failedSpawn.worker.status, 'failed');
    assert(fs.existsSync(failedSpawn.file));
  });
});

test('CLI accepts the official SessionEnd fields and queues through stdin', () => {
  withFixture(({ root, codexHome, sessionsRoot, transcriptPath }) => {
    writeTranscriptSyncConfig(root);
    const child = childProcess.spawnSync(process.execPath, [
      path.join(__dirname, 'codex-transcript-outbox.js'),
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        CODEX_HOME: codexHome,
        CODEX_TRANSCRIPTS_ROOT: sessionsRoot,
      },
      input: JSON.stringify({
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
        hook_event_name: 'SessionEnd',
      }),
    });
    if (child.error) throw child.error;
    assert.strictEqual(child.status, 0);
    assert.strictEqual(child.stdout, '');
    assert.strictEqual(child.stderr, '');
    assert.strictEqual(
      jsonFiles(path.join(codexHome, 'transcript-outbox')).length,
      1
    );
  });
});

test('CLI keeps the queued job and emits only the fixed diagnostic when config is missing', () => {
  withFixture(({ root, codexHome, sessionsRoot, transcriptPath }) => {
    const child = childProcess.spawnSync(process.execPath, [
      path.join(__dirname, 'codex-transcript-outbox.js'),
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        CODEX_HOME: codexHome,
        CODEX_TRANSCRIPTS_ROOT: sessionsRoot,
      },
      input: JSON.stringify({
        session_id: 'thr_missing_config',
        transcript_path: transcriptPath,
        hook_event_name: 'SessionEnd',
      }),
    });
    if (child.error) throw child.error;
    assert.strictEqual(child.status, 0);
    assert.strictEqual(child.stdout, '');
    assert.strictEqual(child.stderr, FAILURE_DIAGNOSTIC);
    assert.strictEqual(jsonFiles(path.join(codexHome, 'transcript-outbox')).length, 1);
  });
});

test('CLI fails open and emits only the fixed diagnostic for sensitive invalid input', () => {
  withFixture(({ codexHome, sessionsRoot }) => {
    const secret = 'C:/secret/customer/private-transcript.jsonl';
    const child = childProcess.spawnSync(process.execPath, [
      path.join(__dirname, 'codex-transcript-outbox.js'),
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_TRANSCRIPTS_ROOT: sessionsRoot,
      },
      input: JSON.stringify({
        session_id: SESSION_ID,
        transcript_path: secret,
        transcript_body: 'private body',
      }),
    });
    if (child.error) throw child.error;
    assert.strictEqual(child.status, 0);
    assert.strictEqual(child.stdout, '');
    assert.strictEqual(child.stderr, FAILURE_DIAGNOSTIC);
    assert(!child.stderr.includes(secret));
    assert(!child.stderr.includes('private body'));
  });
});

if (process.exitCode) process.exit(process.exitCode);
console.log(`\nResults: ${passed} passed, 0 failed`);
