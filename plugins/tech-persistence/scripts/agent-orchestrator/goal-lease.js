'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const controlStore = require('./control-store');
const runLock = require('./run-lock');

const GOAL_LEASE_FILE = 'goal-lease.json';
const RUNTIMES = new Set(['codex', 'claude']);

function nowIso(value) {
  return value || new Date().toISOString();
}

function objectiveHash(objective) {
  const normalized = String(objective || '').trim();
  if (!normalized) throw new Error('goal objective is required');
  return `sha256:${crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('goal lease input is required');
  if (!String(input.runId || '').trim()) throw new Error('goal lease runId is required');
  if (!RUNTIMES.has(input.ownerRuntime)) {
    throw new Error('goal lease ownerRuntime must be codex or claude');
  }
  if (!String(input.hostRef || '').trim() || String(input.hostRef).length > 4096) {
    throw new Error('goal lease hostRef must be a non-empty opaque string up to 4096 characters');
  }
  return {
    runId: String(input.runId),
    ownerRuntime: input.ownerRuntime,
    objectiveHash: objectiveHash(input.objective),
    hostRef: String(input.hostRef),
  };
}

function previousLeaseSummary(lease) {
  if (!lease) return null;
  return {
    ownerRuntime: lease.ownerRuntime,
    objectiveHash: lease.objectiveHash,
    hostRef: lease.hostRef,
    releasedAt: lease.releasedAt || null,
  };
}

function acquireGoalLease(existing, input) {
  const validated = validateInput(input);
  const at = nowIso(input.now);
  if (existing && existing.status === 'active') {
    if (existing.runId !== validated.runId) {
      throw new Error(`active goal lease belongs to run ${existing.runId}`);
    }
    if (existing.ownerRuntime !== validated.ownerRuntime) {
      throw new Error(`active goal lease is owned by ${existing.ownerRuntime}`);
    }
    if (existing.objectiveHash !== validated.objectiveHash) {
      throw new Error('active goal lease objective hash differs');
    }
    if (existing.hostRef !== validated.hostRef) {
      throw new Error('active goal lease hostRef differs; release before rebinding');
    }
    return {
      ...existing,
      revision: Number.isInteger(existing.revision) ? existing.revision : 1,
      updatedAt: at,
    };
  }

  return {
    schemaVersion: 'native-goal-lease-v1',
    runId: validated.runId,
    ownerRuntime: validated.ownerRuntime,
    objectiveHash: validated.objectiveHash,
    hostRef: validated.hostRef,
    status: 'active',
    createdAt: at,
    updatedAt: at,
    revision: (existing && Number.isInteger(existing.revision) ? existing.revision : 0) + 1,
    previousLease: previousLeaseSummary(existing),
  };
}

function releaseGoalLease(existing, options = {}) {
  if (!existing) throw new Error('no goal lease exists');
  if (existing.status === 'released') return existing;
  if (existing.status !== 'active') {
    throw new Error(`cannot release goal lease with status ${existing.status}`);
  }
  const at = nowIso(options.now);
  return {
    ...existing,
    status: 'released',
    releaseReason: String(options.reason || 'released'),
    releasedAt: at,
    updatedAt: at,
    revision: (Number.isInteger(existing.revision) ? existing.revision : 1) + 1,
  };
}

function goalLeasePath(runDir, options = {}) {
  return path.join(controlStore.controlRunDir(runDir, options), GOAL_LEASE_FILE);
}

function goalLeaseProjection(existing) {
  if (!existing) return null;
  return {
    schemaVersion: 'native-goal-lease-projection-v1',
    authority: 'external-control-store',
    runId: existing.runId,
    ownerRuntime: existing.ownerRuntime,
    objectiveHash: existing.objectiveHash,
    status: existing.status,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
    revision: existing.revision,
    releasedAt: existing.releasedAt || null,
  };
}

function projectionPath(runDir) {
  return path.join(path.resolve(runDir), GOAL_LEASE_FILE);
}

function writeJsonAtomic(file, value, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  if (typeof options.beforeWrite === 'function') options.beforeWrite();
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  if (typeof options.beforeWrite === 'function') options.beforeWrite();
  fs.renameSync(temp, file);
}

function readGoalLease(runDir, options = {}) {
  const controlDir = controlStore.ensureControlRunDir(runDir, options);
  controlStore.assertAuthoritativeControlPath(runDir, controlDir, options);
  const file = path.join(controlDir, GOAL_LEASE_FILE);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function writeGoalLease(runDir, lease, options = {}) {
  const controlDir = controlStore.ensureControlRunDir(runDir, options);
  const file = path.join(controlDir, GOAL_LEASE_FILE);
  const assertAuthority = () => {
    controlStore.assertAuthoritativeControlPath(runDir, controlDir, options);
    return controlStore.assertAuthoritativeControlPath(runDir, file, options);
  };
  writeJsonAtomic(file, lease, { beforeWrite: assertAuthority });
  writeJsonAtomic(projectionPath(runDir), goalLeaseProjection(lease));
  return file;
}

function validateGoalLeaseForDispatch(existing, input = {}) {
  if (!existing || existing.status === 'released') return null;
  if (existing.status !== 'active') {
    throw new Error(`goal lease status ${existing.status} cannot authorize provider dispatch`);
  }
  if (existing.runId !== String(input.runId || '')) {
    throw new Error(`goal lease run conflict: expected ${existing.runId}`);
  }
  if (!RUNTIMES.has(input.providerRuntime)) {
    throw new Error('goal lease providerRuntime must be codex or claude');
  }
  const expectedRuntime = input.orchestrationOwner === 'codex-host'
    ? 'codex'
    : input.orchestrationOwner === 'claude-host'
      ? 'claude'
      : null;
  if (input.orchestrationOwner !== 'tp' && !expectedRuntime) {
    throw new Error(`goal lease owner conflict: unknown orchestration owner ${input.orchestrationOwner}`);
  }
  if (expectedRuntime && existing.ownerRuntime !== expectedRuntime) {
    throw new Error(
      `goal lease owner conflict: ${input.orchestrationOwner} requires a ${expectedRuntime} native Goal`
    );
  }
  if (existing.objectiveHash !== objectiveHash(input.objective)) {
    throw new Error('goal lease objective conflict: active lease objective differs from run requirement');
  }
  return existing;
}

function assertExpectedRevision(existing, expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null) return;
  const actual = existing && Number.isInteger(existing.revision) ? existing.revision : 0;
  if (Number(expectedRevision) !== actual) {
    throw new Error(
      `goal lease revision conflict: expected ${expectedRevision}, current ${actual}`
    );
  }
}

function goalLockOptions(options = {}) {
  const merged = { ...(options.lockOptions || {}) };
  if (options.controlRoot !== undefined) merged.controlRoot = options.controlRoot;
  if (options.providerRoot !== undefined) merged.providerRoot = options.providerRoot;
  return merged;
}

function bindGoalLease(runDir, input, options = {}) {
  return runLock.withRunLock(
    runDir,
    'goal-lease-update',
    { command: 'goal-bind', runId: input && input.runId },
    () => {
      const existing = readGoalLease(runDir, options);
      assertExpectedRevision(existing, options.expectedRevision);
      const lease = acquireGoalLease(existing, input);
      writeGoalLease(runDir, lease, options);
      return lease;
    },
    goalLockOptions(options)
  );
}

function releaseStoredGoalLease(runDir, options = {}) {
  return runLock.withRunLock(
    runDir,
    'goal-lease-update',
    { command: 'goal-release' },
    () => {
      const existing = readGoalLease(runDir, options);
      assertExpectedRevision(existing, options.expectedRevision);
      const lease = releaseGoalLease(existing, options);
      writeGoalLease(runDir, lease, options);
      return lease;
    },
    goalLockOptions(options)
  );
}

function withValidatedGoalLease(runDir, input = {}, callback, options = {}) {
  if (typeof callback !== 'function') {
    throw new Error('goal lease acceptance callback is required');
  }
  return runLock.withRunLock(
    runDir,
    'goal-lease-update',
    { command: 'goal-accept', runId: input.runId },
    () => {
      const existing = readGoalLease(runDir, options);
      assertExpectedRevision(existing, input.expectedRevision);
      if (input.dispatchContext) {
        validateGoalLeaseForDispatch(existing, input.dispatchContext);
      }
      // The caller's canonical result, acceptance, and exclusive accepted
      // record are committed before this lock is released. Dispatch callers
      // already hold provider-dispatch, establishing the only nested order:
      // provider-dispatch -> goal-lease-update.
      return callback(existing);
    },
    goalLockOptions(options)
  );
}

module.exports = {
  GOAL_LEASE_FILE,
  goalLeasePath,
  goalLeaseProjection,
  objectiveHash,
  acquireGoalLease,
  releaseGoalLease,
  readGoalLease,
  writeGoalLease,
  bindGoalLease,
  releaseStoredGoalLease,
  withValidatedGoalLease,
  assertExpectedRevision,
  validateGoalLeaseForDispatch,
};
