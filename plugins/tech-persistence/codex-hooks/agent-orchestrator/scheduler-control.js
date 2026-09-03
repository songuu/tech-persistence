'use strict';

const { ORCHESTRATION_OWNERS } = require('./capability-router');
const { stableHash } = require('./runtime-capabilities');

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RESET_TOKEN_PATTERN = /^reset:[a-f0-9]{64}$/;
const SCHEDULER_ACTIONS = new Set(['run-now', 'backoff', 'wait', 'stop']);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function nonEmptyString(value, label, maxLength = 4096) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} must not exceed ${maxLength} characters`);
  }
  return normalized;
}

function hash(value, label) {
  const normalized = nonEmptyString(value, label, 71);
  if (!HASH_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a sha256 hash`);
  }
  return normalized;
}

function revision(value, label) {
  if (value === true || value === false || value === null || value === undefined
      || String(value).trim() === '') {
    throw new Error(`${label} is required`);
  }
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return normalized;
}
function schedulerGoalLeaseBinding(existing, runId) {
  const expectedRunId = nonEmptyString(runId, 'Goal lease runId', 240);
  if (existing === null || existing === undefined) {
    const identityHash = stableHash({
      schemaVersion: 'scheduler-goal-lease-identity-v1',
      runId: expectedRunId,
      status: 'unbound',
    });
    return {
      schemaVersion: 'scheduler-goal-lease-binding-v1',
      status: 'unbound',
      revision: 0,
      identityHash,
      leaseHash: stableHash({
        schemaVersion: 'scheduler-goal-lease-semantic-v1',
        identityHash,
        status: 'unbound',
        revision: 0,
      }),
    };
  }

  const lease = object(existing, 'Goal lease');
  if (lease.schemaVersion !== 'native-goal-lease-v1') {
    throw new Error('Goal lease schemaVersion must be native-goal-lease-v1');
  }
  const leaseRunId = nonEmptyString(lease.runId, 'Goal lease runId', 240);
  if (leaseRunId !== expectedRunId) {
    throw new Error(
      `Goal lease run conflict: expected ${expectedRunId}, current ${leaseRunId}`
    );
  }
  if (lease.ownerRuntime !== 'codex' && lease.ownerRuntime !== 'claude') {
    throw new Error('Goal lease ownerRuntime must be codex or claude');
  }
  const objectiveHash = hash(lease.objectiveHash, 'Goal lease objective hash');
  const hostRef = nonEmptyString(lease.hostRef, 'Goal lease host ref');
  const createdAt = nonEmptyString(lease.createdAt, 'Goal lease createdAt', 64);
  if (lease.status !== 'active' && lease.status !== 'released') {
    throw new Error(`unsupported Goal lease status ${lease.status}`);
  }
  const leaseRevision = revision(lease.revision, 'Goal lease revision');
  const identityHash = stableHash({
    schemaVersion: 'scheduler-goal-lease-identity-v1',
    runId: leaseRunId,
    ownerRuntime: lease.ownerRuntime,
    objectiveHash,
    createdAt,
    hostRefHash: stableHash({
      schemaVersion: 'scheduler-goal-host-ref-v1',
      runId: leaseRunId,
      hostRef,
    }),
  });
  const released = lease.status === 'released';
  const previousLeaseHash = lease.previousLease === null
      || lease.previousLease === undefined
    ? null
    : stableHash(object(lease.previousLease, 'Goal lease previousLease'));
  const semanticCore = {
    schemaVersion: 'scheduler-goal-lease-semantic-v1',
    identityHash,
    status: lease.status,
    revision: leaseRevision,
    previousLeaseHash,
    releaseReason: released
      ? nonEmptyString(lease.releaseReason, 'Goal lease releaseReason', 240)
      : null,
    releasedAt: released
      ? nonEmptyString(lease.releasedAt, 'Goal lease releasedAt', 64)
      : null,
  };
  return {
    schemaVersion: 'scheduler-goal-lease-binding-v1',
    status: lease.status,
    revision: leaseRevision,
    identityHash,
    leaseHash: stableHash(semanticCore),
  };
}

function currentGoalLeaseBinding(input) {
  const state = object(input.state, 'run state');
  const binding = schedulerGoalLeaseBinding(input.goalLease, state.runId);
  const expectedRevision = revision(
    input.expectedGoalLeaseRevision,
    'expected Goal lease revision'
  );
  if (binding.revision !== expectedRevision) {
    throw new Error(
      `Goal lease revision conflict: expected ${expectedRevision}, current ${binding.revision}`
    );
  }
  return binding;
}

function normalizeGoalLeaseBinding(value, label) {
  const binding = object(value, label);
  if (binding.schemaVersion !== 'scheduler-goal-lease-binding-v1') {
    throw new Error(`${label} schemaVersion is invalid`);
  }
  if (!['active', 'released', 'unbound'].includes(binding.status)) {
    throw new Error(`${label} status is invalid`);
  }
  const normalized = {
    schemaVersion: binding.schemaVersion,
    status: binding.status,
    revision: revision(binding.revision, `${label} revision`),
    identityHash: hash(binding.identityHash, `${label} identity hash`),
    leaseHash: hash(binding.leaseHash, `${label} lease hash`),
  };
  if (stableHash(normalized) !== stableHash(binding)) {
    throw new Error(`${label} contains unsupported fields`);
  }
  return normalized;
}

function assertSameGoalLeaseBinding(current, recorded) {
  const normalized = normalizeGoalLeaseBinding(
    recorded,
    'scheduler-apply Goal lease binding'
  );
  if (stableHash(current) !== stableHash(normalized)) {
    throw new Error('Goal lease binding conflict with scheduler-apply record');
  }
  return normalized;
}

function activeSchedulerOwner(state) {
  const source = object(state, 'run state');
  const owner = source.executionPolicy && source.executionPolicy.orchestrationOwner
    ? source.executionPolicy.orchestrationOwner
    : source.orchestrationOwner;
  const normalized = nonEmptyString(owner, 'active scheduler owner', 64);
  if (!ORCHESTRATION_OWNERS.includes(normalized)) {
    throw new Error(`unsupported active scheduler owner ${normalized}`);
  }
  return normalized;
}

function assertSchedulerOwner(state, requestedOwner) {
  const active = activeSchedulerOwner(state);
  const requested = nonEmptyString(requestedOwner, 'scheduler owner', 64);
  if (!ORCHESTRATION_OWNERS.includes(requested)) {
    throw new Error(`unsupported scheduler owner ${requested}`);
  }
  if (requested !== active) {
    throw new Error(
      `scheduler owner conflict: active=${active}, requested=${requested}`
    );
  }
  return requested;
}

function receiptContext(input) {
  const receipt = object(input.receipt, 'turn receipt');
  const turnKey = hash(input.turnKey, 'turnKey');
  if (receipt.turnKey !== turnKey) {
    throw new Error(
      `turn receipt conflict: expected ${turnKey}, current ${receipt.turnKey || '<missing>'}`
    );
  }
  const expectedRevision = revision(
    input.expectedJournalRevision,
    'expected journal revision'
  );
  const expectedJournalHash = hash(
    input.expectedJournalHash,
    'expected journal hash'
  );
  return { receipt, expectedRevision, expectedJournalHash };
}

function assertNewPhase(context, nextPhase) {
  const { receipt, expectedRevision, expectedJournalHash } = context;
  if (receipt.nextPhase !== nextPhase) {
    throw new Error(
      `turn phase conflict: expected ${nextPhase}, current ${receipt.nextPhase || 'committed'}`
    );
  }
  if (receipt.journalRevision !== expectedRevision) {
    throw new Error(
      `journal revision conflict: expected ${expectedRevision}, current ${receipt.journalRevision}`
    );
  }
  if (receipt.journalHash !== expectedJournalHash) {
    throw new Error(
      `journal hash conflict: expected ${expectedJournalHash}, current ${receipt.journalHash}`
    );
  }
}

function existingPhaseRecord(receipt, phase) {
  const records = Array.isArray(receipt.phaseRecords) ? receipt.phaseRecords : [];
  return records.find((entry) => entry && entry.phase === phase) || null;
}

function assertIdempotentPhase(existing, payload, phase) {
  const payloadHash = hash(existing.payloadHash, `${phase} payload hash`);
  if (stableHash(object(existing.payload, `${phase} payload`)) !== payloadHash
      || stableHash(payload) !== payloadHash) {
    throw new Error(`${phase} conflict: different payload`);
  }
}

function normalizeHint(value) {
  const hint = object(value, 'scheduler hint');
  if (hint.schemaVersion !== 'scheduler-hint-v1') {
    throw new Error('scheduler hint schemaVersion must be scheduler-hint-v1');
  }
  if (hint.permission !== 'none') {
    throw new Error('scheduler hint permission must remain none');
  }
  if (!SCHEDULER_ACTIONS.has(hint.action)) {
    throw new Error(`unsupported scheduler action ${hint.action}`);
  }
  nonEmptyString(hint.reason, 'scheduler hint reason', 240);
  if (hint.action === 'backoff') {
    if (!Number.isInteger(hint.retryAfterMs)
        || hint.retryAfterMs < 1_000
        || hint.retryAfterMs > 86_400_000) {
      throw new Error('backoff scheduler hint retryAfterMs is invalid');
    }
  }
  if (hint.action !== 'stop') {
    if (!RESET_TOKEN_PATTERN.test(String(hint.resetToken || ''))) {
      throw new Error('scheduler hint resetToken is invalid');
    }
  } else if (hint.resetToken !== undefined) {
    throw new Error('stop scheduler hint must not carry a reset token');
  }
  return hint;
}

function prepareSchedulerApply(input = {}) {
  const context = receiptContext(input);
  const { receipt, expectedRevision, expectedJournalHash } = context;
  const schedulerOwner = assertSchedulerOwner(input.state, input.schedulerOwner);
  const goalLeaseBinding = currentGoalLeaseBinding(input);
  const hint = normalizeHint(input.hint);
  const action = nonEmptyString(input.action, 'scheduler action', 32);
  if (action !== hint.action) {
    throw new Error(
      `scheduler action conflict: hint=${hint.action}, requested=${action}`
    );
  }
  if (hint.action === 'stop') {
    if (input.resetToken !== undefined && input.resetToken !== null) {
      throw new Error('stop hint must not carry a reset token');
    }
  } else {
    const requestedResetToken = nonEmptyString(
      input.resetToken,
      'scheduler reset token',
      70
    );
    if (requestedResetToken !== hint.resetToken) {
      throw new Error('scheduler reset token conflict');
    }
  }
  const schedulerRef = nonEmptyString(
    input.schedulerRef,
    'scheduler ref'
  );
  const appliedStateHash = hash(input.appliedStateHash, 'applied scheduler state hash');
  const result = {
    expectedRevision,
    expectedJournalHash,
    payload: {
      schedulerOwner,
      schedulerRef,
      hint,
      hintHash: stableHash(hint),
      appliedStateHash,
      goalLeaseBinding,
    },
  };
  const existing = existingPhaseRecord(receipt, 'scheduler-apply');
  if (existing) {
    assertIdempotentPhase(existing, result.payload, 'scheduler-apply');
    return result;
  }
  assertNewPhase(context, 'scheduler-apply');
  return result;
}

function schedulerApplyRecord(receipt) {
  const records = Array.isArray(receipt.phaseRecords) ? receipt.phaseRecords : [];
  const record = records.find((entry) => entry && entry.phase === 'scheduler-apply');
  if (!record) throw new Error('scheduler-ack requires a scheduler-apply phase record');
  const payload = object(record.payload, 'scheduler-apply payload');
  const payloadHash = hash(record.payloadHash, 'scheduler-apply payload hash');
  if (stableHash(payload) !== payloadHash) {
    throw new Error('scheduler-apply payload hash conflict');
  }
  return { record, payload, payloadHash };
}

function prepareSchedulerAck(input = {}) {
  const context = receiptContext(input);
  const { receipt, expectedRevision, expectedJournalHash } = context;
  const schedulerOwner = assertSchedulerOwner(input.state, input.schedulerOwner);
  const goalLeaseBinding = currentGoalLeaseBinding(input);
  const apply = schedulerApplyRecord(receipt);
  assertSameGoalLeaseBinding(goalLeaseBinding, apply.payload.goalLeaseBinding);
  if (apply.payload.schedulerOwner !== schedulerOwner) {
    throw new Error('scheduler owner conflict with scheduler-apply record');
  }
  const schedulerRef = nonEmptyString(input.schedulerRef, 'scheduler ref');
  if (schedulerRef !== apply.payload.schedulerRef) {
    throw new Error('scheduler ref conflict with scheduler-apply record');
  }
  const requestedApplyHash = hash(input.applyPayloadHash, 'apply payload hash');
  if (requestedApplyHash !== apply.payloadHash) {
    throw new Error('scheduler apply payload hash conflict');
  }
  const observedStateHash = hash(
    input.observedStateHash,
    'observed scheduler state hash'
  );
  if (observedStateHash !== apply.payload.appliedStateHash) {
    throw new Error('scheduler readback conflict with applied scheduler state');
  }
  const result = {
    expectedRevision,
    expectedJournalHash,
    payload: {
      status: 'confirmed',
      schedulerRef,
      applyPayloadHash: apply.payloadHash,
      observedStateHash,
      goalLeaseBinding,
    },
  };
  const existing = existingPhaseRecord(receipt, 'scheduler-ack');
  if (existing) {
    assertIdempotentPhase(existing, result.payload, 'scheduler-ack');
    return result;
  }
  assertNewPhase(context, 'scheduler-ack');
  return result;
}

module.exports = {
  HASH_PATTERN,
  activeSchedulerOwner,
  assertSchedulerOwner,
  prepareSchedulerAck,
  prepareSchedulerApply,
  schedulerGoalLeaseBinding,
};
