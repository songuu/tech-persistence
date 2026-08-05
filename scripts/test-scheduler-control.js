#!/usr/bin/env node
'use strict';

const assert = require('assert');

const schedulerControl = require('./agent-orchestrator/scheduler-control');
const { stableHash } = require('./agent-orchestrator/runtime-capabilities');

const TURN_KEY = `sha256:${'1'.repeat(64)}`;
const JOURNAL_HASH_4 = `sha256:${'2'.repeat(64)}`;
const JOURNAL_HASH_5 = `sha256:${'3'.repeat(64)}`;
const APPLIED_STATE_HASH = `sha256:${'4'.repeat(64)}`;
const hint = {
  schemaVersion: 'scheduler-hint-v1',
  permission: 'none',
  action: 'backoff',
  reason: 'waiting for fresh evidence',
  retryAfterMs: 60_000,
  resetToken: `reset:${'5'.repeat(64)}`,
};
const state = {
  runId: 'run-scheduler-control',
  executionPolicy: { orchestrationOwner: 'codex-host' },
};
const ACTIVE_GOAL_LEASE = {
  schemaVersion: 'native-goal-lease-v1',
  runId: state.runId,
  ownerRuntime: 'codex',
  objectiveHash: `sha256:${'a'.repeat(64)}`,
  hostRef: 'codex-thread:secret-host-reference',
  status: 'active',
  createdAt: '2026-08-05T01:00:00.000Z',
  updatedAt: '2026-08-05T01:00:00.000Z',
  revision: 7,
  previousLease: null,
};
const RELEASED_GOAL_LEASE = {
  ...ACTIVE_GOAL_LEASE,
  status: 'released',
  releaseReason: 'handoff',
  releasedAt: '2026-08-05T01:05:00.000Z',
  updatedAt: '2026-08-05T01:05:00.000Z',
  revision: 8,
};
const durableReceipt = {
  turnKey: TURN_KEY,
  nextPhase: 'scheduler-apply',
  journalRevision: 4,
  journalHash: JOURNAL_HASH_4,
  phaseRecords: [],
};

function prepareApply(overrides = {}) {
  return schedulerControl.prepareSchedulerApply({
    goalLease: ACTIVE_GOAL_LEASE,
    expectedGoalLeaseRevision: ACTIVE_GOAL_LEASE.revision,
    ...overrides,
  });
}

function prepareAck(overrides = {}) {
  return schedulerControl.prepareSchedulerAck({
    goalLease: ACTIVE_GOAL_LEASE,
    expectedGoalLeaseRevision: ACTIVE_GOAL_LEASE.revision,
    ...overrides,
  });
}

const activeBinding = schedulerControl.schedulerGoalLeaseBinding(
  ACTIVE_GOAL_LEASE,
  state.runId
);
const releasedBinding = schedulerControl.schedulerGoalLeaseBinding(
  RELEASED_GOAL_LEASE,
  state.runId
);
const refreshedBinding = schedulerControl.schedulerGoalLeaseBinding(
  { ...ACTIVE_GOAL_LEASE, updatedAt: '2026-08-05T01:01:00.000Z' },
  state.runId
);
assert.deepStrictEqual(refreshedBinding, activeBinding);
assert.strictEqual(releasedBinding.identityHash, activeBinding.identityHash);
assert.notStrictEqual(releasedBinding.leaseHash, activeBinding.leaseHash);
assert.ok(schedulerControl.HASH_PATTERN.test(activeBinding.identityHash));
assert.ok(schedulerControl.HASH_PATTERN.test(activeBinding.leaseHash));
assert.ok(!JSON.stringify(activeBinding).includes(ACTIVE_GOAL_LEASE.hostRef));

const unboundBinding = schedulerControl.schedulerGoalLeaseBinding(null, state.runId);
assert.strictEqual(unboundBinding.status, 'unbound');
assert.strictEqual(unboundBinding.revision, 0);
assert.deepStrictEqual(unboundBinding, schedulerControl.schedulerGoalLeaseBinding(null, state.runId));
const apply = prepareApply({
  state,
  receipt: durableReceipt,
  turnKey: TURN_KEY,
  hint,
  schedulerOwner: 'codex-host',
  schedulerRef: 'windows-task:agent-loop-run-scheduler-control',
  action: 'backoff',
  resetToken: hint.resetToken,
  appliedStateHash: APPLIED_STATE_HASH,
  expectedJournalRevision: 4,
  expectedJournalHash: JOURNAL_HASH_4,
});

assert.deepStrictEqual(apply, {
  expectedRevision: 4,
  expectedJournalHash: JOURNAL_HASH_4,
  payload: {
    schedulerOwner: 'codex-host',
    schedulerRef: 'windows-task:agent-loop-run-scheduler-control',
    hint,
    hintHash: stableHash(hint),
    appliedStateHash: APPLIED_STATE_HASH,
    goalLeaseBinding: activeBinding,
  },
});

assert.throws(
  () => prepareApply({
    state,
    receipt: durableReceipt,
    turnKey: TURN_KEY,
    hint: { ...hint, permission: 'write' },
    schedulerOwner: 'codex-host',
    schedulerRef: 'scheduler-ref',
    action: 'backoff',
    resetToken: hint.resetToken,
    appliedStateHash: APPLIED_STATE_HASH,
    expectedJournalRevision: 4,
    expectedJournalHash: JOURNAL_HASH_4,
  }),
  /permission must remain none/
);

assert.throws(
  () => prepareApply({
    state,
    receipt: durableReceipt,
    turnKey: TURN_KEY,
    hint,
    schedulerOwner: 'tp',
    schedulerRef: 'scheduler-ref',
    action: 'backoff',
    resetToken: hint.resetToken,
    appliedStateHash: APPLIED_STATE_HASH,
    expectedJournalRevision: 4,
    expectedJournalHash: JOURNAL_HASH_4,
  }),
  /scheduler owner conflict/
);

assert.throws(
  () => prepareApply({
    state,
    receipt: durableReceipt,
    turnKey: TURN_KEY,
    hint,
    schedulerOwner: 'codex-host',
    schedulerRef: 'scheduler-ref',
    action: 'run-now',
    resetToken: hint.resetToken,
    appliedStateHash: APPLIED_STATE_HASH,
    expectedJournalRevision: 4,
    expectedJournalHash: JOURNAL_HASH_4,
  }),
  /scheduler action conflict/
);

assert.throws(
  () => prepareApply({
    state,
    receipt: durableReceipt,
    turnKey: TURN_KEY,
    hint,
    schedulerOwner: 'codex-host',
    schedulerRef: 'scheduler-ref',
    action: 'backoff',
    resetToken: `reset:${'6'.repeat(64)}`,
    appliedStateHash: APPLIED_STATE_HASH,
    expectedJournalRevision: 4,
    expectedJournalHash: JOURNAL_HASH_4,
  }),
  /reset token conflict/
);

assert.throws(
  () => prepareApply({
    state,
    receipt: durableReceipt,
    turnKey: TURN_KEY,
    hint,
    schedulerOwner: 'codex-host',
    schedulerRef: 'scheduler-ref',
    action: 'backoff',
    resetToken: hint.resetToken,
    appliedStateHash: APPLIED_STATE_HASH,
    expectedJournalRevision: 3,
    expectedJournalHash: JOURNAL_HASH_4,
  }),
  /journal revision conflict/
);

const stopHint = {
  schemaVersion: 'scheduler-hint-v1',
  permission: 'none',
  action: 'stop',
  reason: 'run is terminal',
};
assert.doesNotThrow(() => prepareApply({
  state,
  receipt: durableReceipt,
  turnKey: TURN_KEY,
  hint: stopHint,
  schedulerOwner: 'codex-host',
  schedulerRef: 'scheduler-ref',
  action: 'stop',
  appliedStateHash: APPLIED_STATE_HASH,
  expectedJournalRevision: 4,
  expectedJournalHash: JOURNAL_HASH_4,
}));
assert.throws(() => prepareApply({
  state,
  receipt: durableReceipt,
  turnKey: TURN_KEY,
  hint: stopHint,
  schedulerOwner: 'codex-host',
  schedulerRef: 'scheduler-ref',
  action: 'stop',
  resetToken: hint.resetToken,
  appliedStateHash: APPLIED_STATE_HASH,
  expectedJournalRevision: 4,
  expectedJournalHash: JOURNAL_HASH_4,
}), /stop hint must not carry a reset token/);

const applyPayload = apply.payload;
const applyPayloadHash = stableHash(applyPayload);
const appliedReceipt = {
  turnKey: TURN_KEY,
  nextPhase: 'scheduler-ack',
  journalRevision: 5,
  journalHash: JOURNAL_HASH_5,
  phaseRecords: [{
    sequence: 5,
    phase: 'scheduler-apply',
    payload: applyPayload,
    payloadHash: applyPayloadHash,
    recordedAt: '2026-08-05T02:00:00.000Z',
  }],
};

const duplicateApply = prepareApply({
  state,
  receipt: appliedReceipt,
  turnKey: TURN_KEY,
  hint,
  schedulerOwner: 'codex-host',
  schedulerRef: applyPayload.schedulerRef,
  action: 'backoff',
  resetToken: hint.resetToken,
  appliedStateHash: APPLIED_STATE_HASH,
  // A host retry may still carry the pre-apply CAS token. The authoritative
  // journal decides idempotency from the already-recorded payload.
  expectedJournalRevision: 4,
  expectedJournalHash: JOURNAL_HASH_4,
});
assert.deepStrictEqual(duplicateApply, apply);
function retryApplyFor(goalLease, expectedGoalLeaseRevision) {
  return prepareApply({
    state,
    receipt: appliedReceipt,
    turnKey: TURN_KEY,
    hint,
    schedulerOwner: 'codex-host',
    schedulerRef: applyPayload.schedulerRef,
    action: 'backoff',
    resetToken: hint.resetToken,
    appliedStateHash: APPLIED_STATE_HASH,
    expectedJournalRevision: 4,
    expectedJournalHash: JOURNAL_HASH_4,
    goalLease,
    expectedGoalLeaseRevision,
  });
}

const refreshedActiveLease = {
  ...ACTIVE_GOAL_LEASE,
  updatedAt: '2026-08-05T01:01:00.000Z',
};
assert.deepStrictEqual(
  retryApplyFor(refreshedActiveLease, refreshedActiveLease.revision),
  apply
);
assert.throws(
  () => retryApplyFor({
    ...ACTIVE_GOAL_LEASE,
    hostRef: 'codex-thread:different-host-reference',
  }, ACTIVE_GOAL_LEASE.revision),
  /scheduler-apply conflict: different payload/
);
assert.throws(
  () => retryApplyFor(RELEASED_GOAL_LEASE, RELEASED_GOAL_LEASE.revision),
  /scheduler-apply conflict: different payload/
);

const ack = prepareAck({
  state,
  receipt: appliedReceipt,
  turnKey: TURN_KEY,
  schedulerOwner: 'codex-host',
  schedulerRef: applyPayload.schedulerRef,
  applyPayloadHash,
  observedStateHash: APPLIED_STATE_HASH,
  expectedJournalRevision: 5,
  expectedJournalHash: JOURNAL_HASH_5,
});
assert.deepStrictEqual(ack, {
  expectedRevision: 5,
  expectedJournalHash: JOURNAL_HASH_5,
  payload: {
    status: 'confirmed',
    schedulerRef: applyPayload.schedulerRef,
    applyPayloadHash,
    observedStateHash: APPLIED_STATE_HASH,
    goalLeaseBinding: activeBinding,
  },
});
function ackFor(goalLease, expectedGoalLeaseRevision) {
  return prepareAck({
    state,
    receipt: appliedReceipt,
    turnKey: TURN_KEY,
    schedulerOwner: 'codex-host',
    schedulerRef: applyPayload.schedulerRef,
    applyPayloadHash,
    observedStateHash: APPLIED_STATE_HASH,
    expectedJournalRevision: 5,
    expectedJournalHash: JOURNAL_HASH_5,
    goalLease,
    expectedGoalLeaseRevision,
  });
}

assert.deepStrictEqual(
  ackFor(refreshedActiveLease, refreshedActiveLease.revision),
  ack
);
assert.throws(
  () => ackFor(RELEASED_GOAL_LEASE, RELEASED_GOAL_LEASE.revision),
  /Goal lease binding conflict with scheduler-apply record/
);
assert.throws(
  () => ackFor({
    ...ACTIVE_GOAL_LEASE,
    hostRef: 'codex-thread:different-host-reference',
  }, ACTIVE_GOAL_LEASE.revision),
  /Goal lease binding conflict with scheduler-apply record/
);
assert.throws(
  () => ackFor(ACTIVE_GOAL_LEASE, ACTIVE_GOAL_LEASE.revision + 1),
  /Goal lease revision conflict/
);

const ackPayloadHash = stableHash(ack.payload);
const committedReceipt = {
  ...appliedReceipt,
  nextPhase: null,
  journalRevision: 6,
  journalHash: `sha256:${'8'.repeat(64)}`,
  phaseRecords: [
    ...appliedReceipt.phaseRecords,
    {
      sequence: 6,
      phase: 'scheduler-ack',
      payload: ack.payload,
      payloadHash: ackPayloadHash,
      recordedAt: '2026-08-05T02:00:01.000Z',
    },
  ],
};
assert.deepStrictEqual(prepareAck({
  state,
  receipt: committedReceipt,
  turnKey: TURN_KEY,
  schedulerOwner: 'codex-host',
  schedulerRef: applyPayload.schedulerRef,
  applyPayloadHash,
  observedStateHash: APPLIED_STATE_HASH,
  expectedJournalRevision: 5,
  expectedJournalHash: JOURNAL_HASH_5,
}), ack);

assert.throws(() => prepareAck({
  state,
  receipt: appliedReceipt,
  turnKey: TURN_KEY,
  schedulerOwner: 'codex-host',
  schedulerRef: 'different-ref',
  applyPayloadHash,
  observedStateHash: APPLIED_STATE_HASH,
  expectedJournalRevision: 5,
  expectedJournalHash: JOURNAL_HASH_5,
}), /scheduler ref conflict/);

assert.throws(() => prepareAck({
  state,
  receipt: appliedReceipt,
  turnKey: TURN_KEY,
  schedulerOwner: 'codex-host',
  schedulerRef: applyPayload.schedulerRef,
  applyPayloadHash,
  observedStateHash: `sha256:${'7'.repeat(64)}`,
  expectedJournalRevision: 5,
  expectedJournalHash: JOURNAL_HASH_5,
}), /scheduler readback conflict/);

assert.throws(() => prepareAck({
  state,
  receipt: { ...appliedReceipt, nextPhase: null },
  turnKey: TURN_KEY,
  schedulerOwner: 'codex-host',
  schedulerRef: applyPayload.schedulerRef,
  applyPayloadHash,
  observedStateHash: APPLIED_STATE_HASH,
  expectedJournalRevision: 5,
  expectedJournalHash: JOURNAL_HASH_5,
}), /expected scheduler-ack/);

console.log('scheduler control tests passed');
