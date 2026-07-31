#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const goalLease = require('./agent-orchestrator/goal-lease');
const controlStore = require('./agent-orchestrator/control-store');
const runLock = require('./agent-orchestrator/run-lock');

const first = goalLease.acquireGoalLease(null, {
  runId: 'run-1',
  ownerRuntime: 'codex',
  objective: 'Finish the migration with tests green',
  hostRef: 'thr_opaque-1',
  now: '2026-07-30T00:00:00.000Z',
});
assert.strictEqual(first.status, 'active');
assert.strictEqual(first.ownerRuntime, 'codex');
assert.strictEqual(first.hostRef, 'thr_opaque-1');
assert.match(first.objectiveHash, /^sha256:[a-f0-9]{64}$/);

const same = goalLease.acquireGoalLease(first, {
  runId: 'run-1',
  ownerRuntime: 'codex',
  objective: 'Finish the migration with tests green',
  hostRef: 'thr_opaque-1',
  now: '2026-07-30T00:01:00.000Z',
});
assert.strictEqual(same.createdAt, first.createdAt);
assert.strictEqual(same.updatedAt, '2026-07-30T00:01:00.000Z');

assert.throws(() => goalLease.acquireGoalLease(first, {
  runId: 'run-1',
  ownerRuntime: 'claude',
  objective: 'Finish the migration with tests green',
  hostRef: 'session-2',
}), /active goal lease is owned by codex/);

assert.throws(() => goalLease.acquireGoalLease(first, {
  runId: 'run-1',
  ownerRuntime: 'codex',
  objective: 'A different objective',
  hostRef: 'thr_opaque-1',
}), /objective hash differs/);

const released = goalLease.releaseGoalLease(first, {
  reason: 'handoff to another runtime',
  now: '2026-07-30T00:02:00.000Z',
});
assert.strictEqual(released.status, 'released');
assert.strictEqual(released.releaseReason, 'handoff to another runtime');

const second = goalLease.acquireGoalLease(released, {
  runId: 'run-1',
  ownerRuntime: 'claude',
  objective: 'Finish the migration with tests green',
  hostRef: 'session-2',
  now: '2026-07-30T00:03:00.000Z',
});
assert.strictEqual(second.ownerRuntime, 'claude');
assert.strictEqual(second.previousLease.ownerRuntime, 'codex');
assert.doesNotThrow(() => goalLease.assertExpectedRevision(second, 3));
assert.doesNotThrow(() => goalLease.assertExpectedRevision(null, 0));
assert.throws(
  () => goalLease.assertExpectedRevision(second, 2),
  /goal lease revision conflict/
);
assert.throws(
  () => goalLease.assertExpectedRevision(first, 0),
  /goal lease revision conflict/
);

assert.throws(() => goalLease.acquireGoalLease(null, {
  runId: 'run-1',
  ownerRuntime: 'other',
  objective: 'x',
  hostRef: 'ref',
}), /ownerRuntime/);
assert.throws(() => goalLease.acquireGoalLease(null, {
  runId: 'run-1',
  ownerRuntime: 'codex',
  objective: '',
  hostRef: 'ref',
}), /objective/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-lease-'));
const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-control-'));
goalLease.writeGoalLease(tempRoot, second, { controlRoot });
assert.deepStrictEqual(goalLease.readGoalLease(tempRoot, { controlRoot }), second);
const authorityPath = goalLease.goalLeasePath(tempRoot, { controlRoot });
assert.strictEqual(authorityPath.startsWith(path.resolve(tempRoot)), false);
assert.strictEqual(
  authorityPath.toLowerCase().startsWith(path.resolve(controlRoot).toLowerCase()),
  true,
  'authoritative lease must live under the external control root'
);
assert.strictEqual(
  controlStore.controlRunKey(tempRoot),
  controlStore.controlRunKey(path.resolve(tempRoot)),
  'control key must bind the canonical absolute run directory'
);
const projectionText = fs.readFileSync(path.join(tempRoot, 'goal-lease.json'), 'utf8');
assert.doesNotMatch(projectionText, /thr_opaque-1|session-2|tp-goal-control/);
fs.rmSync(path.join(tempRoot, 'goal-lease.json'));
assert.strictEqual(
  goalLease.readGoalLease(tempRoot, { controlRoot }).hostRef,
  'session-2',
  'provider-visible projection deletion must not remove authority'
);
fs.rmSync(tempRoot, { recursive: true, force: true });
fs.rmSync(controlRoot, { recursive: true, force: true });

const acceptanceRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-acceptance-'));
const acceptanceControlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-acceptance-control-'));
try {
  const acceptanceLease = goalLease.bindGoalLease(acceptanceRunDir, {
    runId: 'run-acceptance',
    ownerRuntime: 'codex',
    objective: 'Commit canonical acceptance under the Goal revision CAS',
    hostRef: 'thread:acceptance',
  }, { controlRoot: acceptanceControlRoot });
  const acceptanceFile = path.join(acceptanceRunDir, 'canonical.accepted.json');
  const acceptedRevision = runLock.withRunLock(
    acceptanceRunDir,
    'provider-dispatch',
    { command: 'resume', runId: 'run-acceptance' },
    () => goalLease.withValidatedGoalLease(
      acceptanceRunDir,
      {
        runId: 'run-acceptance',
        expectedRevision: acceptanceLease.revision,
        dispatchContext: {
          runId: 'run-acceptance',
          providerRuntime: 'claude',
          orchestrationOwner: 'codex-host',
          objective: 'Commit canonical acceptance under the Goal revision CAS',
        },
      },
      (current) => {
        assert.throws(
          () => goalLease.releaseStoredGoalLease(acceptanceRunDir, {
            expectedRevision: current.revision,
            controlRoot: acceptanceControlRoot,
          }),
          /goal-lease-update lock is active/,
          'concurrent Goal mutation must not enter the acceptance CAS interval'
        );
        fs.writeFileSync(acceptanceFile, '{"accepted":true}\n', { flag: 'wx' });
        return current.revision;
      },
      { controlRoot: acceptanceControlRoot }
    ),
    { controlRoot: acceptanceControlRoot }
  );
  assert.strictEqual(acceptedRevision, 1);
  assert.strictEqual(fs.existsSync(acceptanceFile), true);

  const mutatedLease = goalLease.releaseStoredGoalLease(acceptanceRunDir, {
    expectedRevision: acceptanceLease.revision,
    controlRoot: acceptanceControlRoot,
  });
  assert.strictEqual(mutatedLease.revision, 2);
  let staleAcceptanceRan = false;
  assert.throws(
    () => goalLease.withValidatedGoalLease(
      acceptanceRunDir,
      {
        runId: 'run-acceptance',
        expectedRevision: acceptanceLease.revision,
      },
      () => {
        staleAcceptanceRan = true;
      },
      { controlRoot: acceptanceControlRoot }
    ),
    /goal lease revision conflict/
  );
  assert.strictEqual(staleAcceptanceRan, false);
} finally {
  fs.rmSync(acceptanceRunDir, { recursive: true, force: true });
  fs.rmSync(acceptanceControlRoot, { recursive: true, force: true });
}

console.log('goal-lease: 29 passed');
