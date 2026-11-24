'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { adaptClaudeHookEvent } = require('./lib/behavior-events');
const { hashObject } = require('./lib/self-learning-canonical');
const { resolveStoreDir } = require('./lib/self-learning-store');
const { enqueuePromptReceipt, drainPromptReceipts } = require('./lib/prompt-receipt-outbox');
const { inspectPromptOutbox } = require('./lib/prompt-receipt-recovery');
const { enqueuePromptBehavior } = require('./prompt-submit');
const { drainProjectPromptReceipts } = require('./lib/prompt-receipt-worker');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { readJournal } = require('./lib/self-learning-store');
const localRecovery = require('./lib/self-learning-local-recovery-guard');

function fixture(callback, local = false) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'tp-prompt-status-'));
  const previous = process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT;
  if (local) process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT = root;
  try { callback(root); }
  finally {
    if (previous === undefined) delete process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT;
    else process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function sample(projectId, prompt) {
  const spec = { project_id: projectId, session_id: 'session-a', transcript_ref: hashObject('transcript'), replay_ref: hashObject('replay') };
  const draft = adaptClaudeHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 'session-a', prompt }, {
    project_id: projectId, session_id: 'session-a', source_event_id: 'source', occurred_at: '2000-01-01T00:00:00.000Z',
  });
  return { receipt_spec: spec, event_draft: draft };
}

test('status distinguishes absent, pending, and blocked queues without revealing content', () => fixture((baseDir) => {
  const projectId = 'project-status';
  const outbox = path.join(resolveStoreDir(baseDir, projectId), 'prompt-outbox');
  assert.deepEqual(inspectPromptOutbox(baseDir, projectId), { state: 'absent', pending: 0, blocked: 0, worker_failure: false, conflicts: [] });
  const secret = `glpat-${'S'.repeat(24)}`;
  enqueuePromptReceipt(outbox, sample(projectId, `private ${secret}`));
  const pending = inspectPromptOutbox(baseDir, projectId);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.pending, 1);
  assert.equal(pending.blocked, 0);
  drainPromptReceipts(outbox, () => ['conflict']);
  const status = inspectPromptOutbox(baseDir, projectId);
  assert.equal(status.state, 'blocked');
  assert.equal(status.pending, 1);
  assert.equal(status.blocked, 1);
  assert.equal(status.worker_failure, true);
  assert.match(status.conflicts[0], /^\d{12}-[a-f0-9]{64}$/);
  assert(!JSON.stringify(status).includes(secret));
  assert(!JSON.stringify(status).includes(baseDir));
}));

test('CLI emits only a fixed error on invalid status input', () => fixture((baseDir) => {
  const privatePath = path.join(baseDir, 'private-secret-directory');
  const cli = path.join(__dirname, 'lib', 'prompt-receipt-recovery.js');
  const result = spawnSync(process.execPath, [cli, 'status', '--base-dir', privatePath, '--project-id', '../unsafe'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert(!result.stdout.includes(privatePath));
  assert(!result.stderr.includes(privatePath));
  assert(!result.stderr.includes('../unsafe'));
  assert.match(result.stderr, /prompt-receipt-recovery.*failed/i);
}));

test('read-only status rejects unmatched conflict markers without modifying data', () => fixture((baseDir) => {
  const projectId = 'project-status';
  const jobs = path.join(resolveStoreDir(baseDir, projectId), 'prompt-outbox', 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const marker = `.blocked-000000000001-${'a'.repeat(64)}`;
  fs.writeFileSync(path.join(jobs, marker), '');
  assert.throws(() => inspectPromptOutbox(baseDir, projectId), /invalid|inconsistent/i);
  assert.deepEqual(fs.readdirSync(jobs), [marker]);
}));

test('status rejects duplicate sequence numbers rather than reporting a healthy queue', () => fixture((baseDir) => {
  const projectId = 'project-status';
  const jobs = path.join(resolveStoreDir(baseDir, projectId), 'prompt-outbox', 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, `000000000001-${'a'.repeat(64)}.json`), '{}');
  fs.writeFileSync(path.join(jobs, `000000000001-${'b'.repeat(64)}.json`), '{}');
  assert.throws(() => inspectPromptOutbox(baseDir, projectId), /invalid|inconsistent/i);
}));

test('status CLI prints only JSON and never reports stored prompt text or base path', () => fixture((baseDir) => {
  const projectId = 'project-status';
  const outbox = path.join(resolveStoreDir(baseDir, projectId), 'prompt-outbox');
  const prompt = 'private-message-sentinel';
  enqueuePromptReceipt(outbox, sample(projectId, prompt));
  const cli = path.join(__dirname, 'lib', 'prompt-receipt-recovery.js');
  const result = spawnSync(process.execPath, [cli, 'status', '--base-dir', baseDir, '--project-id', projectId], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).pending, 1);
  assert(!result.stdout.includes(prompt));
  assert(!result.stdout.includes(baseDir));
}));

function conflictingQueue(baseDir) {
  const workspace = path.join(baseDir, 'workspace');
  fs.mkdirSync(workspace);
  const project = detectStableProjectIdentity(workspace);
  const opts = { baseDir, project, cwd: workspace, workerLauncher: () => ({ status: 'started' }) };
  const payload = { hook_event_name: 'UserPromptSubmit', prompt_id: 'one', session_id: 's1', cwd: workspace, prompt: 'first value' };
  assert.equal(enqueuePromptBehavior(payload, opts).status, 'queued');
  drainProjectPromptReceipts(baseDir, project.id);
  assert.equal(enqueuePromptBehavior({ ...payload, prompt: 'different value' }, opts).status, 'queued');
  assert.equal(enqueuePromptBehavior({ ...payload, prompt_id: 'two', prompt: 'next value' }, opts).status, 'queued');
  assert.equal(drainProjectPromptReceipts(baseDir, project.id).status, 'blocked');
  const status = inspectPromptOutbox(baseDir, project.id);
  return { workspace, project, conflict: status.conflicts[0], outbox: path.join(resolveStoreDir(baseDir, project.id), 'prompt-outbox') };
}

test('explicit rejection preserves conflicting evidence and lets the stream continue', () => fixture((baseDir) => {
  const { rejectPromptConflict } = require('./lib/prompt-receipt-recovery');
  const { project, conflict, outbox } = conflictingQueue(baseDir);
  const result = rejectPromptConflict(baseDir, project.id, conflict);
  assert.equal(result.status, 'rejected');
  const archive = fs.readdirSync(path.join(outbox, 'conflict-archive'));
  assert.deepEqual(archive, [`${conflict}.json`]);
  const evidence = JSON.parse(fs.readFileSync(path.join(outbox, 'conflict-archive', archive[0]), 'utf8'));
  assert.equal(evidence.decision, 'reject_conflicting_duplicate');
  assert.equal(evidence.job.event_draft.details.summary, 'different value');
  assert.equal(inspectPromptOutbox(baseDir, project.id).blocked, 0);
  drainProjectPromptReceipts(baseDir, project.id);
  assert.equal(readJournal(resolveStoreDir(baseDir, project.id)).revision, 2);
}));

test('rejection refuses an unverified marker and preserves its job', () => fixture((baseDir) => {
  const { rejectPromptConflict } = require('./lib/prompt-receipt-recovery');
  const project = 'project-status';
  const outbox = path.join(resolveStoreDir(baseDir, project), 'prompt-outbox');
  enqueuePromptReceipt(outbox, sample(project, 'never committed'));
  drainPromptReceipts(outbox, () => ['conflict']);
  const id = inspectPromptOutbox(baseDir, project).conflicts[0];
  assert.throws(() => rejectPromptConflict(baseDir, project, id), /conflict|journal/i);
  assert.equal(inspectPromptOutbox(baseDir, project).blocked, 1);
}));

test('partial archived evidence can be resumed without discarding the pending job', () => fixture((baseDir) => {
  const { rejectPromptConflict } = require('./lib/prompt-receipt-recovery');
  const { project, conflict, outbox } = conflictingQueue(baseDir);
  const originalWrite = fs.writeSync;
  let injected = false;
  try {
    fs.writeSync = function (fd, buffer, offset, length, position) {
      if (!injected && Buffer.isBuffer(buffer) && buffer.includes(Buffer.from('reject_conflicting_duplicate'))) {
        injected = true;
        originalWrite.call(fs, fd, buffer, offset, Math.min(length, 32), position);
        const error = new Error('simulated interruption'); error.code = 'EIO'; throw error;
      }
      return originalWrite.apply(fs, arguments);
    };
    assert.throws(() => rejectPromptConflict(baseDir, project.id, conflict), /interruption/);
  } finally { fs.writeSync = originalWrite; }
  assert.equal(injected, true);
  assert.equal(inspectPromptOutbox(baseDir, project.id).blocked, 1);
  assert.equal(rejectPromptConflict(baseDir, project.id, conflict).status, 'rejected');
  assert.equal(inspectPromptOutbox(baseDir, project.id).blocked, 0);
  assert.equal(fs.readdirSync(path.join(outbox, 'conflict-archive')).length, 1);
}));

for (const stage of ['archive-write', 'archive-link', 'marker-unlink', 'job-unlink']) {
  test(`hard termination at ${stage} preserves evidence and allows operator retry`, (t) => fixture((baseDir) => {
    if (!localRecovery.isEnabledForStore(path.join(baseDir, 'probe'))) {
      t.skip('local recovery capability unavailable');
      return;
    }
    const { rejectPromptConflict } = require('./lib/prompt-receipt-recovery');
    const { project, conflict, outbox } = conflictingQueue(baseDir);
    const recoveryFile = path.join(__dirname, 'lib', 'prompt-receipt-recovery.js');
    const killMarker = path.join(baseDir, `reached-${stage}`);
    const source = `
      const fs = require('fs'); const path = require('path');
      const [base, project, conflict, stage, recovery, marker] = process.argv.slice(1);
      const link = fs.linkSync, unlink = fs.unlinkSync, open = fs.openSync, write = fs.writeSync;
      function terminate() { fs.writeFileSync(marker, stage, { flag: 'wx' }); process.kill(process.pid, 'SIGKILL'); }
      let archiveFd = null;
      fs.openSync = function (target) {
        const fd = open.apply(fs, arguments);
        if (stage === 'archive-write' && String(target).includes(path.sep + 'conflict-archive' + path.sep)
            && path.basename(String(target)).startsWith('.pending-')) archiveFd = fd;
        return fd;
      };
      fs.writeSync = function (fd, buffer, offset, length, position) {
        if (stage === 'archive-write' && fd === archiveFd && Buffer.isBuffer(buffer)) {
          write.call(fs, fd, buffer, offset, Math.min(length, 32), position);
          terminate();
        }
        return write.apply(fs, arguments);
      };
      fs.linkSync = function (src, dst) {
        const value = link.apply(fs, arguments);
        if (stage === 'archive-link' && String(dst).includes(path.sep + 'conflict-archive' + path.sep)) terminate();
        return value;
      };
      fs.unlinkSync = function (target) {
        const value = unlink.apply(fs, arguments);
        const name = path.basename(String(target));
        if (stage === 'marker-unlink' && name === '.blocked-' + conflict) terminate();
        if (stage === 'job-unlink' && name === conflict + '.json' && String(target).includes(path.sep + 'jobs' + path.sep)) terminate();
        return value;
      };
      require(recovery).rejectPromptConflict(base, project, conflict);
    `;
    const terminated = spawnSync(process.execPath, ['-e', source, baseDir, project.id, conflict, stage, recoveryFile, killMarker], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.equal(terminated.error, undefined, 'child must start and terminate without timeout');
    assert.notEqual(terminated.status, 0);
    assert.equal(fs.readFileSync(killMarker, 'utf8'), stage, 'child must reach the intended termination point');
    const result = rejectPromptConflict(baseDir, project.id, conflict);
    assert(['rejected', 'already-rejected'].includes(result.status));
    const files = fs.readdirSync(path.join(outbox, 'conflict-archive'));
    assert.deepEqual(files, [`${conflict}.json`]);
    assert.equal(inspectPromptOutbox(baseDir, project.id).blocked, 0);
    drainProjectPromptReceipts(baseDir, project.id);
    assert.equal(readJournal(resolveStoreDir(baseDir, project.id)).revision, 2);
  }, true));
}

test('an undeclared local store preserves its dead lock and refuses recovery', () => fixture((baseDir) => {
  delete process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT;
  const store = require('./lib/self-learning-store');
  const dir = path.join(baseDir, 'store');
  const child = spawnSync(process.execPath, ['-e',
    'require(process.argv[1]).acquireJournalLock(process.argv[2], { retry_timeout_ms: 500 }); process.exit(71);',
    path.join(__dirname, 'lib', 'self-learning-store.js'), dir], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 71);
  const lockPath = path.join(dir, store.JOURNAL_DIR_NAME, store.LOCK_FILE_NAME);
  const original = fs.readFileSync(lockPath);
  assert.throws(() => store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 50 }),
    (error) => error.code === 'SELF_LEARNING_RECOVERY_UNAVAILABLE');
  assert.deepEqual(fs.readFileSync(lockPath), original);
}));

test('cleanup refuses a conflict staging file linked to a user file', () => fixture((baseDir) => {
  const { rejectPromptConflict } = require('./lib/prompt-receipt-recovery');
  const { project, conflict, outbox } = conflictingQueue(baseDir);
  const archive = path.join(outbox, 'conflict-archive');
  fs.mkdirSync(archive);
  const userFile = path.join(baseDir, 'user-owned.txt');
  fs.writeFileSync(userFile, 'untouched');
  const staged = path.join(archive, `.pending-${conflict}-${'a'.repeat(32)}.tmp`);
  fs.linkSync(userFile, staged);
  assert.throws(() => rejectPromptConflict(baseDir, project.id, conflict), /staging|archive|unsafe/i);
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'untouched');
  assert.equal(fs.existsSync(staged), true);
  assert.equal(inspectPromptOutbox(baseDir, project.id).blocked, 1);
}));

test('cleanup refuses a nonmatching conflict staging file and preserves it', () => fixture((baseDir) => {
  const { rejectPromptConflict } = require('./lib/prompt-receipt-recovery');
  const { project, conflict, outbox } = conflictingQueue(baseDir);
  const archive = path.join(outbox, 'conflict-archive');
  fs.mkdirSync(archive);
  const staged = path.join(archive, `.pending-${conflict}-${'b'.repeat(32)}.tmp`);
  fs.writeFileSync(staged, 'not an archive prefix');
  assert.throws(() => rejectPromptConflict(baseDir, project.id, conflict), /staging|archive|unsafe/i);
  assert.equal(fs.readFileSync(staged, 'utf8'), 'not an archive prefix');
  assert.equal(inspectPromptOutbox(baseDir, project.id).blocked, 1);
}));
