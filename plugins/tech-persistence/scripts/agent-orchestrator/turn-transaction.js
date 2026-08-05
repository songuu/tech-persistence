'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  canonicalize,
  stableHash,
} = require('./runtime-capabilities');

const TURN_KEY_SCHEMA_VERSION = 'turn-key-v1';
const TURN_JOURNAL_SCHEMA_VERSION = 'turn-journal-v1';
const TURN_RECEIPT_SCHEMA_VERSION = 'turn-receipt-v1';
const TURN_PHASES = Object.freeze([
  'host-execute',
  'typed-result',
  'validation',
  'durable-writeback',
  'scheduler-apply',
  'scheduler-ack',
]);
const VALIDATION_STATUSES = new Set(['passed', 'failed', 'skipped']);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalObject(value, label, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const normalized = canonicalize(value, new Set(), label);
  if (options.nonEmpty === true && Object.keys(normalized).length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function normalizeTimestamp(value, label) {
  const timestamp = value === undefined || value === null
    ? new Date()
    : new Date(nonEmptyString(value, label));
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`${label} must be an ISO-compatible date-time`);
  }
  return timestamp.toISOString();
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields do not match ${wanted.join(', ')}`);
  }
}

function deriveTurnKey(identity) {
  const normalized = canonicalObject(identity, 'turn identity', { nonEmpty: true });
  return stableHash({
    schemaVersion: TURN_KEY_SCHEMA_VERSION,
    identity: normalized,
  });
}

function journalCore(input) {
  return {
    schemaVersion: TURN_JOURNAL_SCHEMA_VERSION,
    kind: 'turn-journal',
    turnKey: input.turnKey,
    identity: input.identity,
    createdAt: input.createdAt,
    revision: input.revision,
    entries: input.entries,
  };
}

function signJournal(core) {
  return {
    ...core,
    journalHash: stableHash(core),
  };
}

function createTurnJournal(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('turn journal input must be an object');
  }
  const identity = canonicalObject(
    input.identity,
    'turn identity',
    { nonEmpty: true }
  );
  const expectedTurnKey = deriveTurnKey(identity);
  const turnKey = input.turnKey === undefined
    ? expectedTurnKey
    : nonEmptyString(input.turnKey, 'turnKey');
  if (turnKey !== expectedTurnKey) {
    throw new Error('turnKey does not match turn identity');
  }
  return signJournal(journalCore({
    turnKey,
    identity,
    createdAt: normalizeTimestamp(input.at, 'turn journal createdAt'),
    revision: 0,
    entries: [],
  }));
}

function phaseIndex(phase) {
  return TURN_PHASES.indexOf(phase);
}

function normalizePhase(value) {
  const phase = nonEmptyString(value, 'turn phase');
  if (phaseIndex(phase) === -1) {
    throw new Error(`unsupported turn phase ${phase}`);
  }
  return phase;
}

function normalizePayload(value) {
  return canonicalObject(value, 'turn phase payload');
}

function assertPhaseSemantics(entries, phase, payload) {
  if (phase === 'typed-result' && typeof payload.material !== 'boolean') {
    throw new Error('typed-result payload.material must be a boolean');
  }

  if (phase === 'validation') {
    if (!VALIDATION_STATUSES.has(payload.status)) {
      throw new Error('validation payload.status must be passed, failed, or skipped');
    }
    const typedResult = entries.find((entry) => entry.phase === 'typed-result');
    if (typedResult && typedResult.payload.material === true
        && payload.status === 'skipped') {
      throw new Error(
        'material typed result requires validation and cannot be skipped'
      );
    }
  }

  if (phase === 'durable-writeback') {
    const typedResult = entries.find((entry) => entry.phase === 'typed-result');
    const validation = entries.find((entry) => entry.phase === 'validation');
    if (typedResult && typedResult.payload.material === true
        && (!validation || validation.payload.status !== 'passed')) {
      throw new Error(
        'material typed result requires passed validation before durable-writeback'
      );
    }
  }

  if (phase === 'scheduler-apply' || phase === 'scheduler-ack') {
    const writeback = entries.find((entry) => entry.phase === 'durable-writeback');
    if (!writeback) {
      throw new Error(`${phase} requires durable-writeback`);
    }
  }
}

function validateJournalEnvelope(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
    throw new Error('turn journal must be an object');
  }
  assertExactKeys(journal, [
    'schemaVersion',
    'kind',
    'turnKey',
    'identity',
    'createdAt',
    'revision',
    'entries',
    'journalHash',
  ], 'turn journal');
  if (journal.schemaVersion !== TURN_JOURNAL_SCHEMA_VERSION) {
    throw new Error(
      `turn journal schemaVersion must be ${TURN_JOURNAL_SCHEMA_VERSION}`
    );
  }
  if (journal.kind !== 'turn-journal') {
    throw new Error('turn journal kind must be turn-journal');
  }
  if (!HASH_PATTERN.test(String(journal.turnKey || ''))) {
    throw new Error('turn journal turnKey must be a sha256 hash');
  }
  const identity = canonicalObject(
    journal.identity,
    'turn identity',
    { nonEmpty: true }
  );
  if (deriveTurnKey(identity) !== journal.turnKey) {
    throw new Error('turn journal turnKey does not match turn identity');
  }
  const createdAt = normalizeTimestamp(journal.createdAt, 'turn journal createdAt');
  if (createdAt !== journal.createdAt) {
    throw new Error('turn journal createdAt must be normalized ISO date-time');
  }
  if (!Number.isInteger(journal.revision)
      || journal.revision < 0
      || journal.revision > TURN_PHASES.length) {
    throw new Error('turn journal revision is invalid');
  }
  if (!Array.isArray(journal.entries)) {
    throw new Error('turn journal entries must be an array');
  }
  if (journal.revision !== journal.entries.length) {
    throw new Error('turn journal revision must match entry count');
  }
  if (!HASH_PATTERN.test(String(journal.journalHash || ''))) {
    throw new Error('turn journal journalHash must be a sha256 hash');
  }
  const { journalHash, ...core } = journal;
  if (stableHash(core) !== journalHash) {
    throw new Error('turn journal hash does not match');
  }
  return { identity, createdAt };
}

function validateJournalEntry(entry, index, acceptedEntries) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`turn journal entries[${index}] must be an object`);
  }
  assertExactKeys(entry, [
    'sequence',
    'phase',
    'payload',
    'payloadHash',
    'recordedAt',
  ], `turn journal entries[${index}]`);
  const expectedSequence = index + 1;
  if (entry.sequence !== expectedSequence) {
    throw new Error(
      `turn journal sequence violation: expected ${expectedSequence}, got ${entry.sequence}`
    );
  }
  const phase = normalizePhase(entry.phase);
  const expectedPhase = TURN_PHASES[index];
  if (phase !== expectedPhase) {
    throw new Error(
      `turn journal phase order violation: expected ${expectedPhase}, got ${phase}`
    );
  }
  const payload = normalizePayload(entry.payload);
  if (!HASH_PATTERN.test(String(entry.payloadHash || ''))
      || stableHash(payload) !== entry.payloadHash) {
    throw new Error(`turn journal ${phase} payload hash does not match`);
  }
  const recordedAt = normalizeTimestamp(
    entry.recordedAt,
    `turn journal ${phase} recordedAt`
  );
  if (recordedAt !== entry.recordedAt) {
    throw new Error(`turn journal ${phase} recordedAt must be normalized ISO date-time`);
  }
  assertPhaseSemantics(acceptedEntries, phase, payload);
  return {
    sequence: expectedSequence,
    phase,
    payload,
    payloadHash: entry.payloadHash,
    recordedAt,
  };
}

function replayTurnJournal(journal) {
  const { identity, createdAt } = validateJournalEnvelope(journal);
  const entries = [];
  for (let index = 0; index < journal.entries.length; index += 1) {
    entries.push(validateJournalEntry(journal.entries[index], index, entries));
  }
  const completedPhases = entries.map((entry) => entry.phase);
  const currentPhase = completedPhases.length > 0
    ? completedPhases[completedPhases.length - 1]
    : null;
  const nextPhase = TURN_PHASES[completedPhases.length] || null;
  const typedResult = entries.find((entry) => entry.phase === 'typed-result');
  const validation = entries.find((entry) => entry.phase === 'validation');
  const core = {
    schemaVersion: TURN_RECEIPT_SCHEMA_VERSION,
    kind: 'turn-receipt',
    turnKey: journal.turnKey,
    identity,
    createdAt,
    status: completedPhases.length === 0
      ? 'pending'
      : nextPhase === null
        ? 'committed'
        : 'in-progress',
    completedPhases,
    currentPhase,
    nextPhase,
    journalRevision: journal.revision,
    journalHash: journal.journalHash,
    material: typedResult ? typedResult.payload.material : null,
    validationStatus: validation ? validation.payload.status : null,
    phaseRecords: entries,
  };
  return {
    ...core,
    receiptHash: stableHash(core),
  };
}

function advanceTurnJournal(journal, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('turn phase input must be an object');
  }
  const receipt = replayTurnJournal(journal);
  const phase = normalizePhase(input.phase);
  const payload = normalizePayload(input.payload);
  const payloadHash = stableHash(payload);
  const existing = journal.entries.find((entry) => entry.phase === phase);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new Error(
        `turn ${journal.turnKey} phase ${phase} conflict: different payload`
      );
    }
    return { journal, receipt, changed: false };
  }

  const expectedPhase = TURN_PHASES[journal.entries.length] || null;
  if (phase !== expectedPhase) {
    throw new Error(
      `turn ${journal.turnKey} phase order violation: expected ${expectedPhase || 'no further phase'} before ${phase}`
    );
  }
  assertPhaseSemantics(journal.entries, phase, payload);
  const entry = {
    sequence: journal.entries.length + 1,
    phase,
    payload,
    payloadHash,
    recordedAt: normalizeTimestamp(input.at, `${phase} recordedAt`),
  };
  const nextJournal = signJournal(journalCore({
    turnKey: journal.turnKey,
    identity: journal.identity,
    createdAt: journal.createdAt,
    revision: journal.revision + 1,
    entries: [...journal.entries, entry],
  }));
  return {
    journal: nextJournal,
    receipt: replayTurnJournal(nextJournal),
    changed: true,
  };
}

function journalPath(value) {
  return path.resolve(nonEmptyString(value, 'turn journal file'));
}

function readTurnJournal(file) {
  let resolved;
  try {
    resolved = journalPath(file);
    const journal = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    replayTurnJournal(journal);
    return journal;
  } catch (error) {
    const context = resolved || String(file || '<missing>');
    throw new Error(
      `failed to read turn journal at ${context}: ${error.message}`
    );
  }
}

function writeTurnJournalAtomic(file, journal) {
  let resolved;
  let temporary = null;
  let descriptor = null;
  try {
    resolved = journalPath(file);
    replayTurnJournal(journal);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    temporary = `${resolved}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, resolved);
    temporary = null;
    return resolved;
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_) {
        // Preserve the original write error.
      }
    }
    if (temporary !== null) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch (_) {
        // Preserve the original write error.
      }
    }
    const context = resolved || String(file || '<missing>');
    throw new Error(
      `failed to atomically write turn journal at ${context}: ${error.message}`
    );
  }
}

function recordTurnPhase(file, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('record turn phase input must be an object');
  }
  const resolved = journalPath(file);
  const identity = canonicalObject(
    input.identity,
    'turn identity',
    { nonEmpty: true }
  );
  const expectedTurnKey = deriveTurnKey(identity);
  if (input.turnKey !== undefined
      && nonEmptyString(input.turnKey, 'provided turnKey') !== expectedTurnKey) {
    throw new Error('provided turnKey does not match turn identity');
  }
  const journal = fs.existsSync(resolved)
    ? readTurnJournal(resolved)
    : createTurnJournal({
      identity,
      turnKey: input.turnKey,
      at: input.createdAt || input.at,
    });
  if (journal.turnKey !== expectedTurnKey) {
    throw new Error(
      `turn journal identity conflict at ${resolved}: expected ${expectedTurnKey}, found ${journal.turnKey}`
    );
  }
  const advanced = advanceTurnJournal(journal, input);
  if (advanced.changed) {
    writeTurnJournalAtomic(resolved, advanced.journal);
  }
  return { ...advanced, file: resolved };
}

module.exports = {
  TURN_JOURNAL_SCHEMA_VERSION,
  TURN_KEY_SCHEMA_VERSION,
  TURN_PHASES,
  TURN_RECEIPT_SCHEMA_VERSION,
  advanceTurnJournal,
  createTurnJournal,
  deriveTurnKey,
  readTurnJournal,
  recordTurnPhase,
  replayTurnJournal,
  writeTurnJournalAtomic,
};
