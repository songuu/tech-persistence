#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const store = require('./lib/self-learning-store');
const { detectStableProjectIdentity } = require('./lib/project-identity');

if (process.argv[2] === '--worker') {
  const storeDir = process.argv[3];
  const value = process.argv[4];
  const startAt = Number(process.argv[5]);
  const recordId = process.argv[6] === 'unique' ? `race-record-${value}` : 'race-record';
  while (Date.now() < startAt) {}
  try {
    store.appendRecord(storeDir, {
      record_type: 'behavior_event',
      record_id: recordId,
      entity_id: recordId,
      actor: { kind: 'hook', id: `worker-${value}`, runtime: 'codex', authority_ref: null },
      occurred_at: '2026-08-20T01:02:03.000Z',
      payload: { value },
    });
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.code || 'SELF_LEARNING_UNKNOWN'}\n`);
    process.exit(2);
  }
}

if (process.argv[2] === '--partial-lock-holder') {
  const storeDir = process.argv[3];
  const journalDir = path.join(storeDir, store.JOURNAL_DIR_NAME);
  const lockFile = path.join(journalDir, store.LOCK_FILE_NAME);
  fs.mkdirSync(journalDir, { recursive: true });
  const descriptor = fs.openSync(lockFile, 'wx', 0o600);
  fs.writeSync(descriptor, '{', null, 'utf8');
  fs.fsyncSync(descriptor);
  process.stdout.write('partial-ready\n');
  setTimeout(() => {
    const lock = `${JSON.stringify({
      schema_version: store.LOCK_SCHEMA_VERSION,
      token: 'a'.repeat(32),
      pid: process.pid,
      operation: 'partial-lock-test',
      acquired_at: new Date().toISOString(),
    }, null, 2)}\n`;
    const bytes = Buffer.from(lock, 'utf8');
    fs.writeSync(descriptor, bytes, 0, bytes.length, 0);
    fs.ftruncateSync(descriptor, bytes.length);
    fs.fsyncSync(descriptor);
    setTimeout(() => {
      fs.closeSync(descriptor);
      fs.rmSync(lockFile);
      process.exit(0);
    }, 120);
  }, 120);
}

if (process.argv[2] === '--recover-worker') {
  const storeDir = process.argv[3];
  const startAt = Number(process.argv[4]);
  const label = process.argv[5];
  while (Date.now() < startAt) {}
  try {
    const lock = store.acquireJournalLock(storeDir, {
      operation: `recovery-contender-${label}`,
      retry_timeout_ms: 2000,
      stale_lock_age_ms: 0,
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    lock.release();
    process.stdout.write(`recovered:${label}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.code || 'SELF_LEARNING_UNKNOWN'}\n`);
    process.exit(2);
  }
}

function attempt(storeDir, value, startAt, mode = 'conflict') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      __filename, '--worker', storeDir, value, String(startAt), mode,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

function attemptPromptHook(baseDir, workspace, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'prompt-submit.js')], {
      cwd: workspace,
      env: {
        ...process.env,
        TECH_PERSISTENCE_HOME: baseDir,
        TP_SELF_LEARNING_BASE_DIR: baseDir,
        TP_SELF_LEARNING_PROJECT_ID: detectStableProjectIdentity(workspace).id,
        TECH_PERSISTENCE_DISABLE_PROMPT_RECALL: '1',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify(payload));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function attemptObserveHook(baseDir, workspace, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'observe.js'), 'post'], {
      cwd: workspace,
      env: {
        ...process.env,
        TECH_PERSISTENCE_HOME: baseDir,
        TP_SELF_LEARNING_BASE_DIR: baseDir,
        TP_SELF_LEARNING_PROJECT_ID: detectStableProjectIdentity(workspace).id,
        CLAUDE_SESSION_ID: payload.session_id,
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify(payload));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function attemptRecovery(storeDir, startAt, label) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      __filename, '--recover-worker', storeDir, String(startAt), label,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function exitedChildPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const pid = child.pid;
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`pid fixture exited ${code}`));
      else resolve(pid);
    });
  });
}

function startPartialLockHolder(storeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--partial-lock-holder', storeDir], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('partial-ready')) resolve(child);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!stdout.includes('partial-ready')) {
        reject(new Error(`partial lock holder exited ${code}: ${stderr}`));
      }
    });
  });
}

async function main() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-self-learning-concurrency-'));
  try {
    const storeDir = store.resolveStoreDir(baseDir, 'project-race-conflict');
    const startAt = Date.now() + 400;
    const results = await Promise.all([
      attempt(storeDir, 'left', startAt),
      attempt(storeDir, 'right', startAt),
    ]);
    assert.strictEqual(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
    assert.strictEqual(results.filter((result) => result.code !== 0).length, 1, JSON.stringify(results));
    assert.match(results.find((result) => result.code !== 0).stderr, /SELF_LEARNING_ID_CONFLICT/);
    const journal = store.readJournal(storeDir);
    assert.strictEqual(journal.revision, 1);
    assert.strictEqual(journal.records[0].record_id, 'race-record');

    const uniqueStoreDir = store.resolveStoreDir(baseDir, 'project-race-unique');
    const uniqueStartAt = Date.now() + 800;
    const uniqueResults = await Promise.all(
      Array.from({ length: 24 }, (_, index) => (
        attempt(uniqueStoreDir, String(index).padStart(2, '0'), uniqueStartAt, 'unique')
      ))
    );
    assert.strictEqual(
      uniqueResults.filter((result) => result.code === 0).length,
      24,
      JSON.stringify(uniqueResults)
    );
    const uniqueJournal = store.readJournal(uniqueStoreDir);
    assert.strictEqual(uniqueJournal.revision, 24);
    assert.strictEqual(new Set(uniqueJournal.records.map((record) => record.record_id)).size, 24);

    const partialStoreDir = store.resolveStoreDir(baseDir, 'project-race-partial-lock');
    const holder = await startPartialLockHolder(partialStoreDir);
    const partialResult = store.appendRecord(partialStoreDir, {
      record_type: 'behavior_event',
      record_id: 'after-partial-lock',
      entity_id: 'after-partial-lock',
      actor: { kind: 'hook', id: 'partial-test', runtime: 'codex', authority_ref: null },
      occurred_at: '2026-08-20T01:02:03.000Z',
      payload: { value: 'after-partial-lock' },
    });
    assert.strictEqual(partialResult.changed, true);
    await new Promise((resolve) => holder.once('close', resolve));
    assert.strictEqual(store.readJournal(partialStoreDir).revision, 1);

    const recoveryStoreDir = store.resolveStoreDir(baseDir, 'project-stale-recovery-race');
    const recoveryJournalDir = path.join(recoveryStoreDir, store.JOURNAL_DIR_NAME);
    fs.mkdirSync(recoveryJournalDir, { recursive: true });
    const deadPid = await exitedChildPid();
    fs.writeFileSync(path.join(recoveryJournalDir, store.LOCK_FILE_NAME), `${JSON.stringify({
      schema_version: store.LOCK_SCHEMA_VERSION,
      token: 'f'.repeat(32),
      pid: deadPid,
      operation: 'stale-recovery-fixture',
      acquired_at: '2000-01-01T00:00:00.000Z',
    }, null, 2)}\n`);
    const recoveryStart = Date.now() + 400;
    const recoveryResults = await Promise.all([
      attemptRecovery(recoveryStoreDir, recoveryStart, 'left'),
      attemptRecovery(recoveryStoreDir, recoveryStart, 'right'),
    ]);
    assert.strictEqual(
      recoveryResults.filter((result) => result.code === 0).length,
      2,
      JSON.stringify(recoveryResults)
    );
    assert.strictEqual(fs.existsSync(path.join(recoveryJournalDir, store.LOCK_FILE_NAME)), false);
    assert.strictEqual(
      fs.existsSync(path.join(recoveryStoreDir, store.LOCK_RECOVERY_CLAIM_FILE_NAME)),
      false
    );
    assert.strictEqual(store.readJournal(recoveryStoreDir).revision, 0);

    const hookRoot = path.join(baseDir, 'real-hook-race');
    const hookBaseDir = path.join(hookRoot, 'homunculus');
    const workspace = path.join(hookRoot, 'workspace');
    const transcripts = path.join(hookRoot, 'transcripts');
    fs.mkdirSync(hookBaseDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(hookBaseDir, 'config.json'), JSON.stringify({
      self_learning: {
        enabled: true,
        writer_enabled: true,
        reader_enabled: false,
        mode: 'shadow',
        legacy_writer_enabled: false,
        legacy_reader_enabled: false,
      },
    }));
    const projectId = detectStableProjectIdentity(workspace).id;
    const hookResults = await Promise.all(Array.from({ length: 24 }, (_, index) => {
      const sessionId = `hook-session-${String(index).padStart(2, '0')}`;
      const transcriptPath = path.join(transcripts, `${sessionId}.jsonl`);
      fs.writeFileSync(transcriptPath, `{"type":"assistant","index":${index}}\n`);
      return attemptPromptHook(hookBaseDir, workspace, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: workspace,
        prompt: 'same text across distinct trusted turns',
      });
    }));
    assert.strictEqual(
      hookResults.filter((result) => result.code === 0 && result.stderr === '').length,
      24,
      JSON.stringify(hookResults)
    );
    const hookJournal = store.readJournal(store.resolveStoreDir(hookBaseDir, projectId));
    assert.strictEqual(hookJournal.revision, 24);
    assert.strictEqual(
      new Set(hookJournal.records.map((record) => record.record_id)).size,
      24
    );

    const replayRoot = path.join(baseDir, 'real-hook-replay-race');
    const replayBaseDir = path.join(replayRoot, 'homunculus');
    const replayWorkspace = path.join(replayRoot, 'workspace');
    const replayTranscript = path.join(replayRoot, 'replay-session.jsonl');
    fs.mkdirSync(replayBaseDir, { recursive: true });
    fs.mkdirSync(replayWorkspace, { recursive: true });
    fs.writeFileSync(replayTranscript, '{"type":"assistant","state":"stable"}\n');
    fs.writeFileSync(path.join(replayBaseDir, 'config.json'), JSON.stringify({
      self_learning: {
        enabled: true,
        writer_enabled: true,
        reader_enabled: false,
        mode: 'shadow',
        legacy_writer_enabled: false,
        legacy_reader_enabled: false,
      },
    }));
    const replayPayload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'replay-session',
      transcript_path: replayTranscript,
      cwd: replayWorkspace,
      prompt: 'one trusted prompt replayed concurrently',
    };
    const replayResults = await Promise.all(Array.from(
      { length: 24 },
      () => attemptPromptHook(replayBaseDir, replayWorkspace, replayPayload)
    ));
    assert.strictEqual(
      replayResults.filter((result) => result.code === 0 && result.stderr === '').length,
      24,
      JSON.stringify(replayResults)
    );
    const replayProjectId = detectStableProjectIdentity(replayWorkspace).id;
    const replayJournal = store.readJournal(store.resolveStoreDir(replayBaseDir, replayProjectId));
    assert.strictEqual(replayJournal.revision, 1);
    assert.strictEqual(replayJournal.records[0].payload.details.prompt_receipt.occurrence, 1);

    const toolRoot = path.join(baseDir, 'real-tool-hook-race');
    const toolBaseDir = path.join(toolRoot, 'homunculus');
    const toolWorkspace = path.join(toolRoot, 'workspace');
    fs.mkdirSync(toolBaseDir, { recursive: true });
    fs.mkdirSync(toolWorkspace, { recursive: true });
    fs.writeFileSync(path.join(toolBaseDir, 'config.json'), JSON.stringify({
      self_learning: {
        enabled: true,
        writer_enabled: true,
        reader_enabled: false,
        mode: 'shadow',
        legacy_writer_enabled: false,
        legacy_reader_enabled: false,
      },
    }));
    const toolResults = await Promise.all(Array.from({ length: 16 }, (_, index) => (
      attemptObserveHook(toolBaseDir, toolWorkspace, {
        hook_event_name: 'PostToolUse',
        tool_use_id: `tool-concurrent-${String(index).padStart(2, '0')}`,
        session_id: 'tool-concurrent-session',
        cwd: toolWorkspace,
        tool_name: 'Read',
        tool_response: { index },
        success: true,
      })
    )));
    assert.strictEqual(
      toolResults.filter((result) => result.code === 0 && result.stderr === '').length,
      16,
      JSON.stringify(toolResults)
    );
    const toolProjectId = detectStableProjectIdentity(toolWorkspace).id;
    const toolJournal = store.readJournal(store.resolveStoreDir(toolBaseDir, toolProjectId));
    assert.strictEqual(toolJournal.revision, 16);

    const toolReplayPayload = {
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tool-concurrent-replay',
      session_id: 'tool-concurrent-session',
      cwd: toolWorkspace,
      tool_name: 'Read',
      tool_response: { stable: true },
      success: true,
    };
    const toolReplayResults = await Promise.all(Array.from(
      { length: 16 },
      () => attemptObserveHook(toolBaseDir, toolWorkspace, toolReplayPayload)
    ));
    assert.strictEqual(
      toolReplayResults.filter((result) => result.code === 0 && result.stderr === '').length,
      16,
      JSON.stringify(toolReplayResults)
    );
    const toolReplayJournal = store.readJournal(store.resolveStoreDir(toolBaseDir, toolProjectId));
    assert.strictEqual(toolReplayJournal.revision, 17);
    console.log('self-learning concurrency tests passed');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

if (!['--worker', '--partial-lock-holder', '--recover-worker'].includes(process.argv[2])) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
