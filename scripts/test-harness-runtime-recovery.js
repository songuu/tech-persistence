'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./test-harness-runtime-wiring');
const { captureInvocation, captureEvent, durableCreate } = require('./lib/runtime-transcript-spool');
const { runWorker } = require('./lib/runtime-transcript-worker');
const { readBoundedContext } = require('./agent-orchestrator/bounded-context-reader');
const goal = require('./agent-orchestrator/goal-lease');
const { assertCompleteDiff } = require('./agent-orchestrator/external-runtime-invocation');
async function main() {
  const root = fs.mkdtempSync(path.join(__dirname, '..', '.runtime-recovery-test-'));
  try {
    const f = fixture(root);
    const spoolModule = require('./lib/runtime-transcript-spool');
    const { runProcess } = require('./agent-orchestrator');
    const realCapture = spoolModule.captureEvent;
    let launches = 0;
    const settings = { runtime: 'openai-compatible', adapter: 'openai-compatible-chat', cwd: f.workdir, options: f.options,
      taskEnvelopeHash: `sha256:${'a'.repeat(64)}`, routeDecisionHash: `sha256:${'b'.repeat(64)}`,
      stdin: JSON.stringify({ baseUrl: f.config.baseUrl, model: f.config.model, sessionId: '9'.repeat(64), requestId: 'fault-test' }),
      spawnSyncImpl: (_command, _args, options) => { launches++; assert.equal(options.env.NODE_OPTIONS, undefined); return { status: 0, stdout: '{}', stderr: '' }; } };
    const launch = { command: process.execPath, shell: false, resolvedFrom: 'checked-in-transport' };
    const launchArgs = [path.join(__dirname, 'external-runtime-transport.js')];
    try {
      spoolModule.captureEvent = () => { throw new Error('request persistence failed'); };
      assert.throws(() => runProcess('fault-test', launch, launchArgs, settings), /request persistence failed/); assert.equal(launches, 0);
      spoolModule.captureEvent = (root, input, type) => { if (type === 'terminal') throw new Error('terminal failed'); return realCapture(root, input, type); };
      const partial = runProcess('fault-test', launch, launchArgs, settings);
      assert.equal(launches, 1); assert.equal(partial.record.transcript.status, 'capture-incomplete');
    } finally { spoolModule.captureEvent = realCapture; }
    assertCompleteDiff('diff --git a/x b/x\n+text');
    for (const content of ['Not a git repository; diff unavailable.', '{"schemaVersion":"git-diff-output-overflow-v1"}', 'GIT binary patch',
      ...['oversized-new-file', 'binary-new-file', 'generated'].map(reason => 'Diff omitted; content summary: ' + JSON.stringify({ schemaVersion: 'omitted-diff-content-v1', reason }))]) assert.throws(() => assertCompleteDiff(content), /diff/);
    assertCompleteDiff('Diff omitted; content summary: ' + JSON.stringify({ schemaVersion: 'omitted-diff-content-v1', reason: 'tracked-content-binding' }));
    const input = { sessionId: 'd'.repeat(64), requestId: 'one', taskHash: `sha256:${'a'.repeat(64)}`, routeHash: `sha256:${'b'.repeat(64)}`,
      modelHash: 'c'.repeat(64), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), succeeded: true, requestBytes: 'a', responseBytes: 'b' };
    captureInvocation(f.spoolRoot, input);
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(f.spoolRoot, 'jobs', `sha256-${String(i).padStart(64, '0')}.json`), '{', { mode: 0o600 });
    const pending = path.join(f.spoolRoot, 'jobs', '.pending-00000000-0000-0000-0000-000000000001');
    fs.writeFileSync(pending, '{', { mode: 0o600 });
    const sync = async ({ job }) => ({ verified: true, jobHash: job.jobHash, transcriptId: `openai-compatible:${job.sessionId}` });
    let acknowledged = 0;
    for (let i = 0; i < 5; i++) acknowledged += (await runWorker({ root: f.spoolRoot, sync, maxJobs: 2 })).acknowledged;
    assert.ok(acknowledged >= 2, 'healthy jobs must progress past poison jobs'); assert.ok(fs.existsSync(pending));
    const ack = path.join(f.spoolRoot, 'acks', fs.readdirSync(path.join(f.spoolRoot, 'acks'))[0]);
    fs.writeFileSync(ack, '{'); captureInvocation(f.spoolRoot, { ...input, requestId: 'two' });
    const isolated = await runWorker({ root: f.spoolRoot, sync }); assert.ok(isolated.failed > 0); assert.ok(isolated.acknowledged > 0);
    const short = { ...input, sessionId: 'f'.repeat(64) }, realWrite = fs.writeSync;
    fs.writeSync = (fd, buffer, ...args) => args.length === 0 ? realWrite(fd, buffer.subarray(0, 10)) : realWrite(fd, buffer, ...args);
    try { assert.throws(() => captureEvent(f.spoolRoot, short, 'request'), /incomplete transcript append/); }
    finally { fs.writeSync = realWrite; }
    assert.throws(() => captureEvent(f.spoolRoot, short, 'request'), /incomplete transcript tail/);
    const originalLink = fs.linkSync;
    fs.linkSync = () => { throw Object.assign(new Error('simulated interruption'), { code: 'EIO' }); };
    const final = path.join(f.authority, 'never-published.json');
    try { assert.throws(() => durableCreate(final, { safe: true }), /simulated/); }
    finally { fs.linkSync = originalLink; }
    assert.equal(fs.existsSync(final), false);
    const lease = { runId: 'run', status: 'active', ownerRuntime: 'codex', objectiveHash: goal.objectiveHash('read') };
    const dispatch = { runId: 'run', objective: 'read', orchestrationOwner: 'codex-host', providerRuntime: 'openai-compatible', providerIntent: 'read-only' };
    assert.equal(goal.validateGoalLeaseForDispatch(lease, dispatch), lease);
    assert.throws(() => goal.validateGoalLeaseForDispatch(lease, { ...dispatch, providerIntent: 'write' }), /providerRuntime/);
    assert.throws(() => goal.validateGoalLeaseForDispatch(lease, { ...dispatch, objective: 'different' }), /objective conflict/);
    assert.throws(() => goal.validateGoalLeaseForDispatch(lease, { ...dispatch, orchestrationOwner: 'claude-host' }), /owner conflict/);
    assert.equal(goal.validateGoalLeaseForDispatch({ ...lease, status: 'released' }, dispatch), null);
    const context = path.join(f.workdir, 'context.txt'); fs.writeFileSync(context, 'bounded');
    if (process.platform === 'linux') {
      assert.equal(readBoundedContext(f.workdir, 'context.txt'), 'bounded');
      assert.throws(() => readBoundedContext(f.workdir, 'context.txt', 2), /size/);
      const secret = path.join(f.authority, 'private.txt'); fs.writeFileSync(secret, 'must-never-read', { mode: 0o600 });
      const realOpen = fs.openSync;
      fs.openSync = (file, ...args) => { if (file === context) { fs.renameSync(context, context + '.original'); fs.symlinkSync(secret, context); } return realOpen(file, ...args); };
      try { assert.throws(() => readBoundedContext(f.workdir, 'context.txt')); }
      finally { fs.openSync = realOpen; }
    } else assert.throws(() => readBoundedContext(f.workdir, 'context.txt'), /Linux/);
    console.log('Harness recovery: fair retry/corrupt ack/partial frame/atomic publish/goal lease/context checks passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
