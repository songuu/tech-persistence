#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const goalLease = require('./agent-orchestrator/goal-lease');
const turnTransaction = require('./agent-orchestrator/turn-transaction');

const orchestrator = path.join(__dirname, 'agent-orchestrator.js');
const APPLIED_STATE_HASH = `sha256:${'a'.repeat(64)}`;
const SECRET_HOST_REF = 'codex-thread:secret-scheduler-host-ref';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function invoke(command, common, args = []) {
  return spawnSync(process.execPath, [
    orchestrator,
    command,
    ...common,
    ...args,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function expectOk(command, common, args) {
  const result = invoke(command, common, args);
  assert.strictEqual(
    result.status,
    0,
    `${command} failed: ${result.stderr || result.stdout}`
  );
  return result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) : result.stdout;
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-scheduler-cli-'));
const workdir = path.join(tempRoot, 'workspace');
const controlRoot = path.join(tempRoot, 'control');
const runId = 'run-scheduler-cli';
const runDir = path.join(workdir, '.agent-runs', runId);
const common = [
  '--run', runId,
  '--workdir', workdir,
  '--control-root', controlRoot,
];

try {
  const state = {
    runId,
    runDir,
    workdir,
    mode: 'classic',
    status: 'blocked',
    createdAt: '2026-08-05T01:00:00.000Z',
    updatedAt: '2026-08-05T01:05:00.000Z',
    orchestrationOwner: 'codex-host',
    executionPolicy: {
      schemaVersion: 'execution-policy-v1',
      orchestrationOwner: 'codex-host',
      capabilityRouter: { mode: 'shadow' },
      adapterPolicy: { claude: 'print', codex: 'exec' },
      allowExperimentalAppServer: false,
    },
    files: {},
    providerRuns: [],
  };
  writeJson(path.join(runDir, 'state.json'), state);
  fs.writeFileSync(path.join(runDir, 'requirement.md'), 'scheduler cli contract\n');
  writeJson(path.join(runDir, 'queue.json'), {
    pending: [],
    ready: [],
    running: [],
    completed: [],
    blocked: [{ id: 'blocked-work', reason: 'operator evidence required' }],
    rejected: [],
    abandoned: [],
  });

  const identity = {
    runId,
    stage: 'implementation',
    taskRef: 'task:scheduler-cli',
    providerRef: 'codex:implementation:codex-exec',
  };
  const legacyFile = path.join(runDir, 'contracts', 'implementation.turn-journal.json');
  const phases = [
    ['host-execute', { status: 'completed', providerRef: identity.providerRef }],
    ['typed-result', { material: true, resultRef: 'result:scheduler-cli' }],
    ['validation', { status: 'passed', validationHash: `sha256:${'b'.repeat(64)}` }],
    ['durable-writeback', {
      status: 'committed',
      acceptedResultHash: `sha256:${'c'.repeat(64)}`,
    }],
  ];
  phases.forEach(([phase, payload], index) => {
    turnTransaction.recordTurnPhase(legacyFile, {
      identity,
      phase,
      payload,
      createdAt: '2026-08-05T01:01:00.000Z',
      at: `2026-08-05T01:01:0${index + 1}.000Z`,
    });
  });

  const initial = expectOk('status', common, ['--json']);
  assert.strictEqual(initial.turnReceipt.nextPhase, 'scheduler-apply');
  assert.strictEqual(initial.turnControl.authority, 'legacy-run-artifact');
  assert.strictEqual(initial.goalLease.status, 'unbound');
  assert.strictEqual(initial.goalLease.revision, 0);
  assert.strictEqual(
    fs.existsSync(controlRoot),
    false,
    'read-only status must not initialize external control state'
  );
  const leaseStoreOptions = {
    controlRoot,
    providerRoot: workdir,
    expectedRevision: initial.goalLease.revision,
  };
  const activeLease = goalLease.bindGoalLease(runDir, {
    runId,
    ownerRuntime: 'codex',
    objective: 'scheduler cli Goal binding contract',
    hostRef: SECRET_HOST_REF,
    now: '2026-08-05T01:06:00.000Z',
  }, leaseStoreOptions);
  assert.strictEqual(activeLease.status, 'active');
  assert.strictEqual(activeLease.revision, 1);

  const receipt = initial.turnReceipt;
  const hint = initial.operatorReviewPacket.schedulerHint;
  const applyArgs = [
    '--turn-key', receipt.turnKey,
    '--scheduler-owner', 'codex-host',
    '--scheduler-ref', 'windows-task:agent-loop-scheduler-cli',
    '--action', hint.action,
    '--reset-token', hint.resetToken,
    '--applied-state-hash', APPLIED_STATE_HASH,
    '--expected-journal-revision', String(receipt.journalRevision),
    '--expected-journal-hash', receipt.journalHash,
    '--expected-goal-lease-revision', String(activeLease.revision),
    '--json',
  ];

  const wrongToken = invoke('scheduler-apply', common, applyArgs.map((value, index) => (
    index > 0 && applyArgs[index - 1] === '--reset-token'
      ? `reset:${'d'.repeat(64)}`
      : value
  )));
  assert.notStrictEqual(wrongToken.status, 0);
  assert.match(wrongToken.stderr, /reset token conflict/);

  const applied = expectOk('scheduler-apply', common, applyArgs);
  assert.strictEqual(applied.turnReceipt.nextPhase, 'scheduler-ack');
  assert.strictEqual(applied.turnControl.authority, 'external-control-store');
  assert.match(applied.turnControl.ref, /^control:turn-journals\//);

  const duplicateApply = expectOk('scheduler-apply', common, applyArgs);
  assert.strictEqual(duplicateApply.turnReceipt.receiptHash, applied.turnReceipt.receiptHash);

  const applyRecord = applied.turnReceipt.phaseRecords.find(
    (entry) => entry.phase === 'scheduler-apply'
  );
  assert.strictEqual(applyRecord.payload.goalLeaseBinding.status, 'active');
  assert.strictEqual(applyRecord.payload.goalLeaseBinding.revision, activeLease.revision);
  assert.ok(!JSON.stringify(applyRecord.payload).includes(SECRET_HOST_REF));
  const ackArgs = [
    '--turn-key', receipt.turnKey,
    '--scheduler-owner', 'codex-host',
    '--scheduler-ref', applyRecord.payload.schedulerRef,
    '--apply-payload-hash', applyRecord.payloadHash,
    '--observed-state-hash', APPLIED_STATE_HASH,
    '--expected-journal-revision', String(applied.turnReceipt.journalRevision),
    '--expected-journal-hash', applied.turnReceipt.journalHash,
    '--expected-goal-lease-revision', String(activeLease.revision),
    '--json',
  ];
  const wrongReadback = invoke('scheduler-ack', common, ackArgs.map((value, index) => (
    index > 0 && ackArgs[index - 1] === '--observed-state-hash'
      ? `sha256:${'e'.repeat(64)}`
      : value
  )));
  assert.notStrictEqual(wrongReadback.status, 0);
  assert.match(wrongReadback.stderr, /readback conflict/);

  const acked = expectOk('scheduler-ack', common, ackArgs);
  assert.strictEqual(acked.turnReceipt.status, 'committed');
  assert.strictEqual(acked.turnReceipt.nextPhase, null);
  const duplicateAck = expectOk('scheduler-ack', common, ackArgs);
  assert.strictEqual(duplicateAck.turnReceipt.receiptHash, acked.turnReceipt.receiptHash);

  const ackRecord = acked.turnReceipt.phaseRecords.find(
    (entry) => entry.phase === 'scheduler-ack'
  );
  assert.deepStrictEqual(
    ackRecord.payload.goalLeaseBinding,
    applyRecord.payload.goalLeaseBinding
  );
  assert.ok(!JSON.stringify(acked.turnReceipt).includes(SECRET_HOST_REF));

  const releasedLease = goalLease.releaseStoredGoalLease(runDir, {
    ...leaseStoreOptions,
    expectedRevision: activeLease.revision,
    reason: 'rotate scheduler host Goal',
    now: '2026-08-05T01:07:00.000Z',
  });
  assert.strictEqual(releasedLease.status, 'released');
  assert.strictEqual(releasedLease.revision, activeLease.revision + 1);
  const withReleasedRevision = (args) => args.map((value, index) => (
    index > 0 && args[index - 1] === '--expected-goal-lease-revision'
      ? String(releasedLease.revision)
      : value
  ));

  const changedLeaseApply = invoke(
    'scheduler-apply',
    common,
    withReleasedRevision(applyArgs)
  );
  assert.notStrictEqual(changedLeaseApply.status, 0);
  assert.match(changedLeaseApply.stderr, /scheduler-apply conflict: different payload/);

  const changedLeaseAck = invoke(
    'scheduler-ack',
    common,
    withReleasedRevision(ackArgs)
  );
  assert.notStrictEqual(changedLeaseAck.status, 0);
  assert.match(
    changedLeaseAck.stderr,
    /Goal lease binding conflict with scheduler-apply record/
  );
  const finalStatus = expectOk('status', common, ['--json']);
  assert.strictEqual(finalStatus.turnReceipt.status, 'committed');
  assert.strictEqual(finalStatus.turnControl.authority, 'external-control-store');
  assert.strictEqual(finalStatus.turnReceipt.receiptHash, acked.turnReceipt.receiptHash);
  assert.strictEqual(finalStatus.goalLease.status, 'released');
  assert.strictEqual(finalStatus.goalLease.revision, releasedLease.revision);
  assert.ok(!JSON.stringify(finalStatus.turnReceipt).includes(SECRET_HOST_REF));
  assert.strictEqual(
    JSON.parse(fs.readFileSync(legacyFile, 'utf8')).revision,
    4,
    'provider-visible legacy journal is a migration source, not authority'
  );

  console.log('[OK] scheduler apply/ack CLI binds host apply and readback to the turn journal');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
