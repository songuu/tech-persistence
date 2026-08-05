'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const controlStore = require('./control-store');
const runLock = require('./run-lock');
const { stableHash } = require('./runtime-capabilities');
const { TURN_PHASES, deriveTurnKey } = require('./turn-transaction');

const TURN_BUDGET_SCHEMA_VERSION = 'agent-loop-turn-budget-v1';
const TURN_BUDGET_PROJECTION_SCHEMA_VERSION =
  'agent-loop-turn-budget-projection-v1';
const TURN_BUDGET_KIND = 'turn-budget-ledger';
const TURN_BUDGET_FILE = 'turn-budget.json';
const TURN_BUDGET_LOCK = 'turn-budget-update';
const MAX_TURN_BUDGET_SLOTS = 10_000;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TURN_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'turnKey',
  'identity',
  'createdAt',
  'status',
  'completedPhases',
  'currentPhase',
  'nextPhase',
  'journalRevision',
  'journalHash',
  'material',
  'validationStatus',
  'phaseRecords',
  'receiptHash',
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields do not match ${wanted.join(', ')}`);
  }
}

function normalizeHash(value, label) {
  if (!HASH_PATTERN.test(String(value || ''))) {
    throw new Error(`${label} must be a sha256 hash`);
  }
  return String(value);
}

function normalizeTimestamp(value, label, options = {}) {
  const source = value === undefined && options.defaultNow === true
    ? new Date()
    : new Date(value);
  if (Number.isNaN(source.getTime())) {
    throw new Error(`${label} must be an ISO-compatible date-time`);
  }
  const normalized = source.toISOString();
  if (options.requireNormalized === true && normalized !== value) {
    throw new Error(`${label} must be a normalized ISO date-time`);
  }
  return normalized;
}

function normalizeMaxSlots(value) {
  if (value === undefined || value === null || value === false) return null;
  if (value === true || (typeof value === 'string' && value.trim() === '')) {
    throw new Error('turn budget maxSlots must be a positive integer');
  }
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error('turn budget maxSlots must be a positive integer');
  }
  if (normalized > MAX_TURN_BUDGET_SLOTS) {
    throw new Error(
      `turn budget maxSlots must not exceed ${MAX_TURN_BUDGET_SLOTS}`
    );
  }
  return normalized;
}

function normalizeRunId(value, label = 'turn budget runId') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizePolicy(policy) {
  if (policy === undefined || policy === null || policy === false) {
    return { enabled: false, maxSlots: null };
  }
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    const maxSlots = normalizeMaxSlots(policy);
    return { enabled: true, maxSlots };
  }

  const maxSlots = normalizeMaxSlots(policy.maxSlots);
  const enabled = policy.enabled === undefined ? maxSlots !== null : policy.enabled;
  if (typeof enabled !== 'boolean') {
    throw new Error('turn budget policy enabled must be a boolean');
  }
  if (!enabled) {
    if (maxSlots !== null) {
      throw new Error('disabled turn budget policy must not define maxSlots');
    }
    return { enabled: false, maxSlots: null };
  }
  if (maxSlots === null) {
    throw new Error('enabled turn budget policy requires maxSlots');
  }
  return { enabled: true, maxSlots };
}

function validateReceiptRecord(entry, index) {
  object(entry, `durable receipt phaseRecords[${index}]`);
  assertExactKeys(entry, [
    'sequence',
    'phase',
    'payload',
    'payloadHash',
    'recordedAt',
  ], `durable receipt phaseRecords[${index}]`);
  if (entry.sequence !== index + 1) {
    throw new Error('durable receipt phase record sequence is invalid');
  }
  if (entry.phase !== TURN_PHASES[index]) {
    throw new Error('durable receipt phase order is invalid');
  }
  object(entry.payload, `durable receipt ${entry.phase} payload`);
  normalizeHash(entry.payloadHash, `durable receipt ${entry.phase} payloadHash`);
  if (stableHash(entry.payload) !== entry.payloadHash) {
    throw new Error(`durable receipt ${entry.phase} payload hash does not match`);
  }
  normalizeTimestamp(entry.recordedAt, `durable receipt ${entry.phase} recordedAt`, {
    requireNormalized: true,
  });
  return entry;
}

function normalizeDurableEvidence(input) {
  const source = object(input, 'turn budget spend input');
  const receipt = source.durableReceipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('durable receipt is required to spend a turn budget slot');
  }
  assertExactKeys(receipt, TURN_RECEIPT_KEYS, 'durable receipt');
  if (receipt.schemaVersion !== 'turn-receipt-v1'
      || receipt.kind !== 'turn-receipt') {
    throw new Error('durable receipt must be a turn-receipt-v1 envelope');
  }
  normalizeHash(receipt.turnKey, 'durable receipt turnKey');
  const identity = object(receipt.identity, 'durable receipt identity');
  const runId = normalizeRunId(identity.runId, 'durable receipt identity.runId');
  if (Object.keys(identity).length === 0 || deriveTurnKey(identity) !== receipt.turnKey) {
    throw new Error('durable receipt turnKey does not match its identity');
  }
  normalizeTimestamp(receipt.createdAt, 'durable receipt createdAt', {
    requireNormalized: true,
  });
  normalizeHash(receipt.journalHash, 'durable receipt journalHash');
  normalizeHash(receipt.receiptHash, 'durable receipt receiptHash');

  if (!Array.isArray(receipt.completedPhases)
      || !Array.isArray(receipt.phaseRecords)
      || receipt.completedPhases.length !== receipt.phaseRecords.length
      || receipt.completedPhases.length > TURN_PHASES.length) {
    throw new Error('durable receipt phase records are invalid');
  }
  for (let index = 0; index < receipt.completedPhases.length; index += 1) {
    if (receipt.completedPhases[index] !== TURN_PHASES[index]) {
      throw new Error('durable receipt completed phase order is invalid');
    }
    validateReceiptRecord(receipt.phaseRecords[index], index);
  }
  if (receipt.journalRevision !== receipt.phaseRecords.length) {
    throw new Error('durable receipt journal revision is invalid');
  }
  const expectedCurrent = receipt.completedPhases.length === 0
    ? null
    : receipt.completedPhases[receipt.completedPhases.length - 1];
  const expectedNext = TURN_PHASES[receipt.completedPhases.length] || null;
  const expectedStatus = receipt.completedPhases.length === 0
    ? 'pending'
    : expectedNext === null
      ? 'committed'
      : 'in-progress';
  if (receipt.currentPhase !== expectedCurrent
      || receipt.nextPhase !== expectedNext
      || receipt.status !== expectedStatus) {
    throw new Error('durable receipt status does not match its phase records');
  }

  const typedResult = receipt.phaseRecords.find(
    (entry) => entry.phase === 'typed-result'
  );
  const validation = receipt.phaseRecords.find(
    (entry) => entry.phase === 'validation'
  );
  const durable = receipt.phaseRecords.find(
    (entry) => entry.phase === 'durable-writeback'
  );
  if (!durable) {
    throw new Error('durable receipt must include durable-writeback');
  }
  const expectedMaterial = typedResult ? typedResult.payload.material : null;
  const expectedValidationStatus = validation ? validation.payload.status : null;
  if (receipt.material !== expectedMaterial
      || receipt.validationStatus !== expectedValidationStatus) {
    throw new Error('durable receipt result or validation summary is invalid');
  }
  if (receipt.validationStatus === 'failed') {
    throw new Error('durable receipt with failed validation cannot spend a slot');
  }
  if (!['passed', 'skipped'].includes(receipt.validationStatus)) {
    throw new Error('durable receipt must contain successful validation evidence');
  }
  if (receipt.material === true && receipt.validationStatus !== 'passed') {
    throw new Error('material durable receipt requires passed validation');
  }
  if (durable.payload.status !== 'committed') {
    throw new Error('durable receipt writeback must be committed');
  }

  const acceptedResultHash = normalizeHash(
    source.acceptedResultHash,
    'acceptedResultHash'
  );
  if (durable.payload.acceptedResultHash !== acceptedResultHash) {
    throw new Error('durable receipt accepted result hash conflict');
  }
  const { receiptHash, ...receiptCore } = receipt;
  if (stableHash(receiptCore) !== receiptHash) {
    throw new Error('durable receipt hash does not match');
  }
  return {
    runId,
    turnKey: receipt.turnKey,
    durableReceiptHash: receiptHash,
    acceptedResultHash,
  };
}

function spendCore(value) {
  return {
    sequence: value.sequence,
    turnKey: value.turnKey,
    durableReceiptHash: value.durableReceiptHash,
    acceptedResultHash: value.acceptedResultHash,
    spentAt: value.spentAt,
  };
}

function signSpend(value) {
  const core = spendCore(value);
  return { ...core, spendHash: stableHash(core) };
}

function ledgerCore(value) {
  return {
    schemaVersion: TURN_BUDGET_SCHEMA_VERSION,
    kind: TURN_BUDGET_KIND,
    runId: value.runId,
    enabled: value.enabled,
    maxSlots: value.maxSlots,
    revision: value.revision,
    spends: value.spends,
  };
}

function signLedger(value) {
  const core = ledgerCore(value);
  return { ...core, ledgerHash: stableHash(core) };
}

function createEmptyLedger(runId, policy) {
  const normalized = normalizePolicy(policy);
  return signLedger({
    runId: normalizeRunId(runId),
    enabled: normalized.enabled,
    maxSlots: normalized.maxSlots,
    revision: 0,
    spends: [],
  });
}

function validateSpend(entry, index) {
  object(entry, `turn budget spends[${index}]`);
  assertExactKeys(entry, [
    'sequence',
    'turnKey',
    'durableReceiptHash',
    'acceptedResultHash',
    'spentAt',
    'spendHash',
  ], `turn budget spends[${index}]`);
  if (entry.sequence !== index + 1) {
    throw new Error(
      `turn budget spend sequence violation: expected ${index + 1}, got ${entry.sequence}`
    );
  }
  normalizeHash(entry.turnKey, `turn budget spends[${index}].turnKey`);
  normalizeHash(
    entry.durableReceiptHash,
    `turn budget spends[${index}].durableReceiptHash`
  );
  normalizeHash(
    entry.acceptedResultHash,
    `turn budget spends[${index}].acceptedResultHash`
  );
  normalizeTimestamp(entry.spentAt, `turn budget spends[${index}].spentAt`, {
    requireNormalized: true,
  });
  normalizeHash(entry.spendHash, `turn budget spends[${index}].spendHash`);
  if (stableHash(spendCore(entry)) !== entry.spendHash) {
    throw new Error(`turn budget spends[${index}] spend hash does not match`);
  }
  return entry;
}

function validateTurnBudgetLedger(ledger) {
  object(ledger, 'turn budget ledger');
  assertExactKeys(ledger, [
    'schemaVersion',
    'kind',
    'runId',
    'enabled',
    'maxSlots',
    'revision',
    'spends',
    'ledgerHash',
  ], 'turn budget ledger');
  if (ledger.schemaVersion !== TURN_BUDGET_SCHEMA_VERSION) {
    throw new Error(
      `turn budget ledger schemaVersion must be ${TURN_BUDGET_SCHEMA_VERSION}`
    );
  }
  if (ledger.kind !== TURN_BUDGET_KIND) {
    throw new Error(`turn budget ledger kind must be ${TURN_BUDGET_KIND}`);
  }
  normalizeRunId(ledger.runId);
  if (typeof ledger.enabled !== 'boolean') {
    throw new Error('turn budget ledger enabled must be a boolean');
  }
  const policy = normalizePolicy({
    enabled: ledger.enabled,
    maxSlots: ledger.maxSlots,
  });
  if (policy.maxSlots !== ledger.maxSlots) {
    throw new Error('turn budget ledger maxSlots is invalid');
  }
  if (!Number.isSafeInteger(ledger.revision) || ledger.revision < 0) {
    throw new Error('turn budget ledger revision must be a non-negative integer');
  }
  if (!Array.isArray(ledger.spends)) {
    throw new Error('turn budget ledger spends must be an array');
  }
  if (!ledger.enabled && ledger.spends.length !== 0) {
    throw new Error('disabled turn budget ledger must not contain spends');
  }
  if (ledger.enabled && ledger.spends.length > ledger.maxSlots) {
    throw new Error('turn budget ledger spends exceed maxSlots');
  }
  if (ledger.revision !== ledger.spends.length) {
    throw new Error('turn budget ledger revision must match spend count');
  }
  const turnKeys = new Set();
  ledger.spends.forEach((entry, index) => {
    validateSpend(entry, index);
    if (turnKeys.has(entry.turnKey)) {
      throw new Error(`turn budget ledger contains duplicate turnKey ${entry.turnKey}`);
    }
    turnKeys.add(entry.turnKey);
  });
  normalizeHash(ledger.ledgerHash, 'turn budget ledgerHash');
  if (stableHash(ledgerCore(ledger)) !== ledger.ledgerHash) {
    throw new Error('turn budget ledger hash does not match');
  }
  return ledger;
}

function turnBudgetPath(runDir, options = {}) {
  const controlDir = controlStore.controlRunDir(runDir, options);
  controlStore.assertAuthoritativeControlPath(runDir, controlDir, options);
  const file = path.join(controlDir, TURN_BUDGET_FILE);
  controlStore.assertAuthoritativeControlPath(runDir, file, options);
  return file;
}

function readTurnBudgetLedger(runDir, options = {}) {
  const file = turnBudgetPath(runDir, options);
  if (!fs.existsSync(file)) return null;
  try {
    controlStore.assertAuthoritativeControlPath(runDir, file, options);
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    controlStore.assertAuthoritativeControlPath(runDir, file, options);
    return validateTurnBudgetLedger(ledger);
  } catch (error) {
    throw new Error(`invalid authoritative turn budget ledger: ${error.message}`);
  }
}

function turnBudgetProjection(ledger, persistedPolicy) {
  if (!ledger) {
    if (persistedPolicy !== undefined) {
      normalizePolicy(persistedPolicy);
      throw new Error(
        'authoritative turn budget ledger is missing for a persisted policy'
      );
    }
    return {
      schemaVersion: TURN_BUDGET_PROJECTION_SCHEMA_VERSION,
      authority: 'legacy-disabled-default',
      enabled: false,
      max: null,
      used: 0,
      remaining: null,
      exhausted: false,
      revision: 0,
    };
  }
  validateTurnBudgetLedger(ledger);
  const normalized = { enabled: ledger.enabled, maxSlots: ledger.maxSlots };
  const used = ledger.spends.length;
  const remaining = normalized.enabled ? normalized.maxSlots - used : null;
  return {
    schemaVersion: TURN_BUDGET_PROJECTION_SCHEMA_VERSION,
    authority: 'external-control-store',
    enabled: normalized.enabled,
    max: normalized.enabled ? normalized.maxSlots : null,
    used,
    remaining,
    exhausted: normalized.enabled ? remaining === 0 : false,
    revision: ledger.revision,
  };
}

function exhaustedError(projection) {
  const error = new Error(
    `turn budget exhausted: used ${projection.used} of ${projection.max} slots`
  );
  error.code = 'TURN_BUDGET_EXHAUSTED';
  error.projection = projection;
  return error;
}

function assertLedgerRunId(ledger, runId) {
  const normalizedRunId = normalizeRunId(runId);
  if (ledger.runId !== normalizedRunId) {
    throw new Error(
      `turn budget runId conflict: ledger=${ledger.runId}, requested=${normalizedRunId}`
    );
  }
  return normalizedRunId;
}

function assertCanRun(runDir, runId, options = {}) {
  const ledger = readTurnBudgetLedger(runDir, options);
  if (!ledger) throw new Error('authoritative turn budget ledger is missing');
  assertLedgerRunId(ledger, runId);
  const projection = turnBudgetProjection(ledger);
  if (projection.exhausted) throw exhaustedError(projection);
  return projection;
}

function initializeTurnBudget(runDir, runId, policy, options = {}) {
  const normalizedRunId = normalizeRunId(runId);
  const normalizedPolicy = normalizePolicy(policy);
  return runLock.withRunLock(
    runDir,
    TURN_BUDGET_LOCK,
    { command: 'turn-budget-initialize', runId: normalizedRunId },
    () => {
      const existing = readTurnBudgetLedger(runDir, options);
      if (existing) {
        assertLedgerRunId(existing, normalizedRunId);
        if (existing.enabled !== normalizedPolicy.enabled
            || existing.maxSlots !== normalizedPolicy.maxSlots) {
          throw new Error(
            `turn budget policy conflict: ledger=${JSON.stringify({ enabled: existing.enabled, maxSlots: existing.maxSlots })}, requested=${JSON.stringify(normalizedPolicy)}`
          );
        }
        return {
          changed: false,
          ledger: existing,
          projection: turnBudgetProjection(existing),
        };
      }
      const persisted = writeTurnBudgetLedgerAtomic(
        runDir,
        createEmptyLedger(normalizedRunId, normalizedPolicy),
        options
      );
      return {
        changed: true,
        ledger: persisted,
        projection: turnBudgetProjection(persisted),
      };
    },
    turnBudgetLockOptions(options)
  );
}

function ensureTurnBudgetForResume(
  runDir,
  runId,
  persistedPolicy,
  options = {}
) {
  const normalizedRunId = normalizeRunId(runId);
  const existing = readTurnBudgetLedger(runDir, options);
  if (existing) {
    assertLedgerRunId(existing, normalizedRunId);
    return {
      changed: false,
      ledger: existing,
      projection: turnBudgetProjection(existing),
    };
  }
  if (persistedPolicy !== undefined) {
    const claimed = normalizePolicy(persistedPolicy);
    throw new Error(
      `authoritative turn budget ledger is missing for persisted policy ${JSON.stringify(claimed)}`
    );
  }
  return initializeTurnBudget(
    runDir,
    normalizedRunId,
    { enabled: false, maxSlots: null },
    options
  );
}

function assertAuthority(runDir, candidate, options) {
  return controlStore.assertAuthoritativeControlPath(runDir, candidate, options);
}

function writeTurnBudgetLedgerAtomic(runDir, ledger, options = {}) {
  validateTurnBudgetLedger(ledger);
  const controlDir = controlStore.ensureControlRunDir(runDir, options);
  const file = path.join(controlDir, TURN_BUDGET_FILE);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor = null;
  let temporaryExists = false;
  try {
    assertAuthority(runDir, controlDir, options);
    assertAuthority(runDir, file, options);
    assertAuthority(runDir, temporary, options);
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    temporaryExists = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    assertAuthority(runDir, temporary, options);
    assertAuthority(runDir, file, options);
    fs.renameSync(temporary, file);
    temporaryExists = false;
    assertAuthority(runDir, file, options);
    const readback = readTurnBudgetLedger(runDir, options);
    if (!readback
        || readback.ledgerHash !== ledger.ledgerHash
        || stableHash(readback) !== stableHash(ledger)) {
      throw new Error('turn budget ledger readback hash verification failed');
    }
    assertAuthority(runDir, file, options);
    return readback;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_) {
        // Preserve the original write failure.
      }
    }
    if (temporaryExists) {
      try {
        assertAuthority(runDir, temporary, options);
        fs.rmSync(temporary, { force: true });
      } catch (_) {
        // Preserve the original write failure.
      }
    }
  }
}

function turnBudgetLockOptions(options = {}) {
  const merged = { ...(options.lockOptions || {}) };
  if (options.controlRoot !== undefined) merged.controlRoot = options.controlRoot;
  if (options.providerRoot !== undefined) merged.providerRoot = options.providerRoot;
  return merged;
}

function spendSlot(runDir, input = {}, options = {}) {
  const source = object(input, 'turn budget spend input');
  const runId = normalizeRunId(source.runId);
  const evidence = normalizeDurableEvidence(source);
  if (evidence.runId !== runId) {
    throw new Error(
      `turn budget receipt runId conflict: requested=${runId}, receipt=${evidence.runId}`
    );
  }
  const spentAt = normalizeTimestamp(source.spentAt, 'turn budget spentAt', {
    defaultNow: true,
  });

  return runLock.withRunLock(
    runDir,
    TURN_BUDGET_LOCK,
    { command: 'turn-budget-spend', runId },
    () => {
      const ledger = readTurnBudgetLedger(runDir, options);
      if (!ledger) throw new Error('authoritative turn budget ledger is missing');
      assertLedgerRunId(ledger, runId);
      if (!ledger.enabled) {
        throw new Error('turn budget is disabled and cannot spend a slot');
      }
      const duplicate = ledger.spends.find(
        (entry) => entry.turnKey === evidence.turnKey
      );
      if (duplicate) {
        if (duplicate.durableReceiptHash !== evidence.durableReceiptHash
            || duplicate.acceptedResultHash !== evidence.acceptedResultHash) {
          throw new Error(
            `turn budget spend conflict for turnKey ${evidence.turnKey}`
          );
        }
        return {
          changed: false,
          spend: duplicate,
          ledger,
          projection: turnBudgetProjection(ledger),
        };
      }

      const projection = turnBudgetProjection(ledger);
      if (projection.exhausted) throw exhaustedError(projection);
      const spend = signSpend({
        sequence: ledger.spends.length + 1,
        ...evidence,
        spentAt,
      });
      const nextLedger = signLedger({
        runId: ledger.runId,
        enabled: ledger.enabled,
        maxSlots: ledger.maxSlots,
        revision: ledger.revision + 1,
        spends: [...ledger.spends, spend],
      });
      const persisted = writeTurnBudgetLedgerAtomic(runDir, nextLedger, options);
      return {
        changed: true,
        spend,
        ledger: persisted,
        projection: turnBudgetProjection(persisted),
      };
    },
    turnBudgetLockOptions(options)
  );
}

module.exports = {
  HASH_PATTERN,
  MAX_TURN_BUDGET_SLOTS,
  TURN_BUDGET_FILE,
  TURN_BUDGET_KIND,
  TURN_BUDGET_LOCK,
  TURN_BUDGET_PROJECTION_SCHEMA_VERSION,
  TURN_BUDGET_SCHEMA_VERSION,
  assertCanRun,
  createEmptyLedger,
  ensureTurnBudgetForResume,
  initializeTurnBudget,
  normalizeMaxSlots,
  normalizePolicy,
  normalizeRunId,
  normalizeTurnBudgetPolicy: normalizePolicy,
  readLedger: readTurnBudgetLedger,
  readTurnBudgetLedger,
  spendSlot,
  turnBudgetPath,
  turnBudgetProjection,
  validateTurnBudgetLedger,
};
