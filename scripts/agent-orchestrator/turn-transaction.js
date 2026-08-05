'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const controlStore = require('./control-store');
const runLock = require('./run-lock');
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
const TURN_JOURNALS_DIRECTORY = 'turn-journals';
const TURN_JOURNAL_UPDATE_LOCK = 'turn-journal-update';

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

function assertHash(value, label) {
  const normalized = nonEmptyString(value, label);
  if (!HASH_PATTERN.test(normalized)) {
    throw new Error(label + ' must be a sha256 hash');
  }
  return normalized;
}

function assertSchedulerApplyPayload(payload) {
  nonEmptyString(payload.schedulerOwner, 'scheduler-apply payload.schedulerOwner');
  nonEmptyString(payload.schedulerRef, 'scheduler-apply payload.schedulerRef');
  const hint = canonicalObject(payload.hint, 'scheduler-apply payload.hint');
  if (hint.permission !== 'none') {
    throw new Error('scheduler-apply payload.hint.permission must be none');
  }
  const hintHash = assertHash(
    payload.hintHash,
    'scheduler-apply payload.hintHash'
  );
  if (hintHash !== stableHash(hint)) {
    throw new Error('scheduler-apply payload.hintHash does not match hint');
  }
  assertHash(
    payload.appliedStateHash,
    'scheduler-apply payload.appliedStateHash'
  );
}

function assertSchedulerAckPayload(entries, payload) {
  if (payload.status !== 'confirmed') {
    throw new Error('scheduler-ack payload.status must be confirmed');
  }
  const schedulerRef = nonEmptyString(
    payload.schedulerRef,
    'scheduler-ack payload.schedulerRef'
  );
  const applyPayloadHash = assertHash(
    payload.applyPayloadHash,
    'scheduler-ack payload.applyPayloadHash'
  );
  const observedStateHash = assertHash(
    payload.observedStateHash,
    'scheduler-ack payload.observedStateHash'
  );
  const apply = entries.find((entry) => entry.phase === 'scheduler-apply');
  if (!apply) {
    throw new Error('scheduler-ack requires scheduler-apply');
  }
  if (schedulerRef !== apply.payload.schedulerRef) {
    throw new Error('scheduler-ack schedulerRef does not match scheduler-apply');
  }
  if (applyPayloadHash !== apply.payloadHash) {
    throw new Error('scheduler-ack applyPayloadHash does not match scheduler-apply');
  }
  if (observedStateHash !== apply.payload.appliedStateHash) {
    throw new Error(
      'scheduler-ack observedStateHash does not match appliedStateHash'
    );
  }
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
      throw new Error(phase + ' requires durable-writeback');
    }
  }
  if (phase === 'scheduler-apply') {
    assertSchedulerApplyPayload(payload);
  }
  if (phase === 'scheduler-ack') {
    assertSchedulerAckPayload(entries, payload);
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

function normalizedTurnKey(value, label = 'turnKey') {
  const turnKey = nonEmptyString(value, label);
  if (!HASH_PATTERN.test(turnKey)) {
    throw new Error(label + ' must be a sha256 hash');
  }
  return turnKey;
}

function authorityRefForTurn(turnKey) {
  return 'control:' + TURN_JOURNALS_DIRECTORY + '/'
    + turnKey.slice('sha256:'.length) + '.json';
}

function authorityLocation(runDir, turnKey, options = {}, ensure = false) {
  const normalizedRunDir = path.resolve(nonEmptyString(runDir, 'runDir'));
  const validatedTurnKey = normalizedTurnKey(turnKey);
  const controlDir = ensure
    ? controlStore.ensureControlRunDir(normalizedRunDir, options)
    : controlStore.controlRunDir(normalizedRunDir, options);
  controlStore.assertAuthoritativeControlPath(
    normalizedRunDir,
    controlDir,
    options
  );
  const journalsDir = path.join(controlDir, TURN_JOURNALS_DIRECTORY);
  const authorityFile = path.join(
    journalsDir,
    validatedTurnKey.slice('sha256:'.length) + '.json'
  );
  controlStore.assertAuthoritativeControlPath(
    normalizedRunDir,
    journalsDir,
    options
  );
  controlStore.assertAuthoritativeControlPath(
    normalizedRunDir,
    authorityFile,
    options
  );
  return {
    runDir: normalizedRunDir,
    controlDir,
    journalsDir,
    authorityFile,
    authorityRef: authorityRefForTurn(validatedTurnKey),
    turnKey: validatedTurnKey,
  };
}

function assertAuthorityLocation(location, options) {
  controlStore.assertAuthoritativeControlPath(
    location.runDir,
    location.controlDir,
    options
  );
  controlStore.assertAuthoritativeControlPath(
    location.runDir,
    location.journalsDir,
    options
  );
  controlStore.assertAuthoritativeControlPath(
    location.runDir,
    location.authorityFile,
    options
  );
}

function turnJournalAuthorityEnabled(location, options) {
  assertAuthorityLocation(location, options);
  if (!fs.existsSync(location.journalsDir)) return false;
  const stat = fs.lstatSync(location.journalsDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('authoritative turn journal directory is invalid');
  }

  let validJournals = 0;
  const entries = fs.readdirSync(location.journalsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile() || !/^[a-f0-9]{64}[.]json$/.test(entry.name)) {
      throw new Error(
        'invalid authoritative turn journal entry ' + entry.name
      );
    }
    const turnKey = 'sha256:' + entry.name.slice(0, -'.json'.length);
    const candidate = authorityLocation(
      location.runDir,
      turnKey,
      options,
      false
    );
    readAuthoritativeFile(candidate, options);
    validJournals += 1;
  }
  assertAuthorityLocation(location, options);
  return validJournals > 0;
}

function bestEffortFsyncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (_) {
    // Some filesystems do not support fsync on directories.
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_) {
        // Directory fsync is best-effort.
      }
    }
  }
}

function readAuthoritativeFile(location, options) {
  assertAuthorityLocation(location, options);
  const journal = readTurnJournal(location.authorityFile);
  assertAuthorityLocation(location, options);
  if (journal.turnKey !== location.turnKey) {
    throw new Error('authoritative turn journal filename does not match turnKey');
  }
  return journal;
}

function writeAuthoritativeJournalAtomic(location, journal, options) {
  let temporary = null;
  let descriptor = null;
  try {
    replayTurnJournal(journal);
    assertAuthorityLocation(location, options);
    fs.mkdirSync(location.journalsDir, { recursive: true });
    assertAuthorityLocation(location, options);
    temporary = location.authorityFile + '.' + process.pid + '.'
      + crypto.randomBytes(8).toString('hex') + '.tmp';
    controlStore.assertAuthoritativeControlPath(
      location.runDir,
      temporary,
      options
    );
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    controlStore.assertAuthoritativeControlPath(
      location.runDir,
      temporary,
      options
    );
    fs.writeFileSync(
      descriptor,
      JSON.stringify(journal, null, 2) + String.fromCharCode(10),
      'utf8'
    );
    fs.fsyncSync(descriptor);
    controlStore.assertAuthoritativeControlPath(
      location.runDir,
      temporary,
      options
    );
    fs.closeSync(descriptor);
    descriptor = null;
    controlStore.assertAuthoritativeControlPath(
      location.runDir,
      temporary,
      options
    );
    controlStore.assertAuthoritativeControlPath(
      location.runDir,
      location.authorityFile,
      options
    );
    fs.renameSync(temporary, location.authorityFile);
    temporary = null;
    assertAuthorityLocation(location, options);
    bestEffortFsyncDirectory(location.journalsDir);
    assertAuthorityLocation(location, options);
    const persisted = readAuthoritativeFile(location, options);
    if (persisted.journalHash !== journal.journalHash) {
      throw new Error('authoritative turn journal readback hash mismatch');
    }
    return persisted;
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
        controlStore.assertAuthoritativeControlPath(
          location.runDir,
          temporary,
          options
        );
        fs.rmSync(temporary, { force: true });
      } catch (_) {
        // Preserve the original write error.
      }
    }
    throw new Error(
      'failed to atomically write authoritative turn journal '
      + location.authorityRef + ': ' + error.message
    );
  }
}

function journalRecord(input) {
  const journal = input.journal;
  const receipt = replayTurnJournal(journal);
  const last = journal.entries[journal.entries.length - 1];
  return {
    source: input.source,
    ref: input.ref,
    authorityRef: input.authorityRef || null,
    authorityFile: input.authorityFile || null,
    legacyRef: input.legacyRef || null,
    legacyFile: input.legacyFile || null,
    recordedAt: last ? last.recordedAt : journal.createdAt,
    journal,
    receipt,
    changed: input.changed === true,
  };
}

function assertExpectedJournalState(journal, input, fresh) {
  if (input.expectedRevision === undefined
      || input.expectedRevision === null
      || input.expectedRevision === true
      || input.expectedRevision === false
      || String(input.expectedRevision).trim() === '') {
    throw new Error('expected journal revision is required');
  }
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expected journal revision must be a non-negative integer');
  }
  if (expectedRevision !== journal.revision) {
    throw new Error(
      'journal revision conflict: expected ' + expectedRevision
      + ', current ' + journal.revision
    );
  }
  if (input.expectedJournalHash === undefined
      || input.expectedJournalHash === null) {
    if (fresh) return;
    throw new Error('expected journal hash is required');
  }
  const expectedHash = assertHash(
    input.expectedJournalHash,
    'expected journal hash'
  );
  if (expectedHash !== journal.journalHash) {
    throw new Error(
      'journal hash conflict: expected ' + expectedHash
      + ', current ' + journal.journalHash
    );
  }
}

function turnJournalLockOptions(options = {}) {
  const merged = { ...(options.lockOptions || {}) };
  if (options.controlRoot !== undefined) merged.controlRoot = options.controlRoot;
  if (options.providerRoot !== undefined) merged.providerRoot = options.providerRoot;
  return merged;
}

function legacyFilePath(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  return journalPath(value);
}

function safeLegacyRef(runDir, file) {
  const relative = path.relative(path.resolve(runDir), path.resolve(file));
  if (relative !== ''
      && relative !== '..'
      && !relative.startsWith('..' + path.sep)
      && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return 'legacy:' + path.basename(file);
}

function recordAuthoritativeTurnPhase(
  runDir,
  legacyFile,
  input = {},
  options = {}
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('record authoritative turn phase input must be an object');
  }
  const identity = canonicalObject(
    input.identity,
    'turn identity',
    { nonEmpty: true }
  );
  const expectedTurnKey = deriveTurnKey(identity);
  if (input.turnKey !== undefined
      && normalizedTurnKey(input.turnKey, 'provided turnKey') !== expectedTurnKey) {
    throw new Error('provided turnKey does not match turn identity');
  }
  return runLock.withRunLock(
    runDir,
    TURN_JOURNAL_UPDATE_LOCK,
    {
      command: 'record-authoritative-turn-phase',
      runId: identity.runId,
    },
    () => {
      const location = authorityLocation(
        runDir,
        expectedTurnKey,
        options,
        true
      );
      assertAuthorityLocation(location, options);
      const authorityEnabled = turnJournalAuthorityEnabled(location, options);
      const hasAuthority = fs.existsSync(location.authorityFile);
      const migrationFile = authorityEnabled ? null : legacyFilePath(legacyFile);
      const hasMigration = Boolean(
        migrationFile && fs.existsSync(migrationFile)
      );
      const journal = hasAuthority
        ? readAuthoritativeFile(location, options)
        : hasMigration
          ? readTurnJournal(migrationFile)
          : createTurnJournal({
            identity,
            turnKey: expectedTurnKey,
            at: input.createdAt || input.at,
          });
      if (journal.turnKey !== expectedTurnKey) {
        throw new Error(
          'turn journal identity conflict: expected ' + expectedTurnKey
          + ', found ' + journal.turnKey
        );
      }

      const phase = normalizePhase(input.phase);
      const payload = normalizePayload(input.payload);
      const payloadHash = stableHash(payload);
      const existing = journal.entries.find((entry) => entry.phase === phase);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new Error(
            'turn ' + journal.turnKey + ' phase ' + phase
            + ' conflict: different payload'
          );
        }
        const persisted = hasAuthority
          ? journal
          : writeAuthoritativeJournalAtomic(location, journal, options);
        return journalRecord({
          source: 'authority',
          ref: location.authorityRef,
          authorityRef: location.authorityRef,
          authorityFile: location.authorityFile,
          journal: persisted,
          changed: false,
        });
      }

      assertExpectedJournalState(journal, input, !hasAuthority && !hasMigration);
      const advanced = advanceTurnJournal(journal, {
        ...input,
        identity,
        phase,
        payload,
      });
      const persisted = writeAuthoritativeJournalAtomic(
        location,
        advanced.journal,
        options
      );
      return journalRecord({
        source: 'authority',
        ref: location.authorityRef,
        authorityRef: location.authorityRef,
        authorityFile: location.authorityFile,
        journal: persisted,
        changed: true,
      });
    },
    turnJournalLockOptions(options)
  );
}

function configuredLegacyFiles(runDir, options = {}) {
  const files = [];
  if (options.legacyFile !== undefined && options.legacyFile !== null) {
    files.push(options.legacyFile);
  }
  if (options.legacyFiles !== undefined) {
    if (!Array.isArray(options.legacyFiles)) {
      throw new Error('legacyFiles must be an array');
    }
    files.push(...options.legacyFiles);
  } else {
    const contractsDir = path.join(path.resolve(runDir), 'contracts');
    if (fs.existsSync(contractsDir)) {
      for (const entry of fs.readdirSync(contractsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.turn-journal.json')) {
          files.push(path.join(contractsDir, entry.name));
        }
      }
    }
  }
  return [...new Set(files
    .filter((file) => file !== undefined && file !== null)
    .map((file) => journalPath(file)))];
}

function readLegacyJournalRecords(runDir, options = {}) {
  const records = [];
  for (const file of configuredLegacyFiles(runDir, options)) {
    try {
      const journal = readTurnJournal(file);
      const legacyRef = safeLegacyRef(runDir, file);
      records.push(journalRecord({
        source: 'legacy',
        ref: legacyRef,
        legacyRef,
        legacyFile: file,
        journal,
        changed: false,
      }));
    } catch (_) {
      // A corrupt legacy projection is non-authoritative and can be skipped.
    }
  }
  return records;
}

function compareJournalRecords(left, right) {
  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt > right.recordedAt ? -1 : 1;
  }
  if (left.journal.turnKey === right.journal.turnKey) {
    return left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0;
  }
  return left.journal.turnKey < right.journal.turnKey ? -1 : 1;
}

function readAuthoritativeTurnJournal(runDir, turnKey, options = {}) {
  const location = authorityLocation(runDir, turnKey, options, false);
  const authorityEnabled = turnJournalAuthorityEnabled(location, options);
  if (fs.existsSync(location.authorityFile)) {
    return journalRecord({
      source: 'authority',
      ref: location.authorityRef,
      authorityRef: location.authorityRef,
      authorityFile: location.authorityFile,
      journal: readAuthoritativeFile(location, options),
      changed: false,
    });
  }
  if (authorityEnabled) return null;
  const legacy = readLegacyJournalRecords(runDir, options)
    .filter((record) => record.journal.turnKey === location.turnKey)
    .sort(compareJournalRecords);
  if (turnJournalAuthorityEnabled(location, options)) {
    return readAuthoritativeTurnJournal(runDir, turnKey, options);
  }
  return legacy[0] || null;
}

function listAuthoritativeTurnJournals(runDir, options = {}) {
  const probeTurnKey = 'sha256:' + '0'.repeat(64);
  const probe = authorityLocation(runDir, probeTurnKey, options, false);
  if (!turnJournalAuthorityEnabled(probe, options)) {
    const legacy = readLegacyJournalRecords(runDir, options);
    if (turnJournalAuthorityEnabled(probe, options)) {
      return listAuthoritativeTurnJournals(runDir, options);
    }
    return legacy.sort(compareJournalRecords);
  }

  const records = [];
  const entries = fs.readdirSync(probe.journalsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}[.]json$/.test(entry.name))
    .sort((left, right) => left.name < right.name ? -1 : 1);
  for (const entry of entries) {
    const turnKey = 'sha256:' + entry.name.slice(0, -'.json'.length);
    const location = authorityLocation(runDir, turnKey, options, false);
    records.push(journalRecord({
      source: 'authority',
      ref: location.authorityRef,
      authorityRef: location.authorityRef,
      authorityFile: location.authorityFile,
      journal: readAuthoritativeFile(location, options),
      changed: false,
    }));
  }
  assertAuthorityLocation(probe, options);
  return records.sort(compareJournalRecords);
}
module.exports = {
  TURN_JOURNAL_SCHEMA_VERSION,
  TURN_KEY_SCHEMA_VERSION,
  TURN_PHASES,
  TURN_RECEIPT_SCHEMA_VERSION,
  advanceTurnJournal,
  createTurnJournal,
  deriveTurnKey,
  listAuthoritativeTurnJournals,
  readAuthoritativeTurnJournal,
  readTurnJournal,
  recordAuthoritativeTurnPhase,
  recordTurnPhase,
  replayTurnJournal,
  writeTurnJournalAtomic,
};
