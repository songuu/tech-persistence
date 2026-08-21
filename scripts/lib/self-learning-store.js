'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  assertExactKeys,
  assertRedactionStableString,
  canonicalize,
  hashObject,
  isPlainObject,
  normalizeTimestamp,
  redactCanonicalValue,
  resolveInside,
  validateHash,
  validateIdentifier,
  validatePathSegment,
} = require('./self-learning-canonical');

const JOURNAL_RECORD_SCHEMA_VERSION = 'self-learning-journal-record-v1';
const JOURNAL_VIEW_SCHEMA_VERSION = 'self-learning-journal-view-v1';
const PROJECTION_SCHEMA_VERSION = 'self-learning-projection-v1';
const LOCK_SCHEMA_VERSION = 'self-learning-journal-lock-v1';
const TOMBSTONE_SCHEMA_VERSION = 'self-learning-tombstone-v1';
const PROMPT_RECEIPT_SCHEMA_VERSION = 'self-learning-prompt-receipt-v1';
const JOURNAL_DIR_NAME = 'journal';
const LOCK_FILE_NAME = 'LOCK.json';
const LOCK_RECOVERY_CLAIM_FILE_NAME = '.journal-lock-recovery.claim';
const RECORD_TYPES = Object.freeze([
  'behavior_event',
  'evidence_ref',
  'behavior_episode',
  'learning_candidate',
  'candidate_transition',
  'candidate_evaluation',
  'approval_receipt',
  'tombstone',
]);
const ACTOR_KINDS = Object.freeze(['user', 'agent', 'hook', 'system', 'operator', 'legacy']);
const RECORD_KEYS = Object.freeze([
  'schema_version',
  'sequence',
  'record_type',
  'record_id',
  'entity_id',
  'actor',
  'occurred_at',
  'payload_hash',
  'previous_hash',
  'record_hash',
  'payload',
]);
const ACTOR_KEYS = Object.freeze(['kind', 'id', 'runtime', 'authority_ref']);
const LOCK_KEYS = Object.freeze([
  'schema_version',
  'token',
  'pid',
  'operation',
  'acquired_at',
]);
const TOMBSTONE_KEYS = Object.freeze([
  'schema_version',
  'target_id',
  'target_hash',
  'reason',
  'replacement_id',
]);
const PROMPT_RECEIPT_KEYS = Object.freeze([
  'schema_version',
  'stream_ref',
  'transcript_ref',
  'replay_ref',
  'occurrence',
]);
const RECORD_FILE_PATTERN = /^(\d{12})-([a-f0-9]{64})\.json$/;
const DEFAULT_LOCK_RETRY_TIMEOUT_MS = 15000;
const DEFAULT_STALE_LOCK_AGE_MS = 30000;
const PROMPT_RECEIPT_LOCK_RETRY_TIMEOUT_MS = 1500;
const TOOL_RECEIPT_LOCK_RETRY_TIMEOUT_MS = 750;
const LIFECYCLE_RECEIPT_LOCK_RETRY_TIMEOUT_MS = 1500;
const LOCK_RETRY_MIN_MS = 4;
const LOCK_RETRY_MAX_MS = 32;
const TRANSIENT_LOCK_OPEN_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function storeError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function resolveStoreDir(baseDir, projectId) {
  validatePathSegment(projectId, 'project id');
  return resolveInside(path.resolve(baseDir), 'projects', projectId, 'self-learning', 'v1');
}

function assertNoLinks(candidate) {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw storeError(
        'SELF_LEARNING_UNSAFE_PATH',
        `self-learning store path contains a symbolic link, junction, or reparse point: ${current}`
      );
    }
  }
  return resolved;
}

function assertStoreDirectory(storeDir) {
  if (typeof storeDir !== 'string' || storeDir.trim() === '') {
    throw storeError('SELF_LEARNING_INVALID_PATH', 'self-learning store directory is required');
  }
  const resolved = assertNoLinks(storeDir);
  if (fs.existsSync(resolved) && !fs.lstatSync(resolved).isDirectory()) {
    throw storeError('SELF_LEARNING_INVALID_PATH', `self-learning store is not a directory: ${resolved}`);
  }
  return resolved;
}

function resolveJournalDir(storeDir) {
  const resolvedStore = assertStoreDirectory(storeDir);
  return resolveInside(resolvedStore, JOURNAL_DIR_NAME);
}

function ensureJournalDir(storeDir) {
  const resolvedStore = assertStoreDirectory(storeDir);
  const journalDir = resolveInside(resolvedStore, JOURNAL_DIR_NAME);
  fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  assertNoLinks(resolvedStore);
  assertNoLinks(journalDir);
  if (!fs.lstatSync(journalDir).isDirectory()) {
    throw storeError('SELF_LEARNING_INVALID_PATH', `self-learning journal is not a directory: ${journalDir}`);
  }
  return journalDir;
}

function recordFileName(sequence, recordHash) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999999999999) {
    throw storeError('SELF_LEARNING_INVALID_SEQUENCE', 'journal sequence is outside the supported range');
  }
  validateHash(recordHash, 'record hash');
  return `${String(sequence).padStart(12, '0')}-${recordHash.slice('sha256:'.length)}.json`;
}

function fsyncDirectoryBestEffort(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const unsupported = new Set(['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'EPERM']);
    if (!error || !unsupported.has(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function normalizeActor(value) {
  assertExactKeys(value, ACTOR_KEYS, 'journal actor');
  if (!ACTOR_KINDS.includes(value.kind)) {
    throw storeError('SELF_LEARNING_INVALID_ACTOR', `unsupported journal actor kind: ${value.kind}`);
  }
  const actor = {
    kind: value.kind,
    id: assertRedactionStableString(
      validateIdentifier(value.id, 'journal actor id'),
      'journal actor id'
    ),
    runtime: value.runtime,
    authority_ref: value.authority_ref,
  };
  for (const field of ['runtime', 'authority_ref']) {
    if (actor[field] !== null && (typeof actor[field] !== 'string' || actor[field].trim() === '')) {
      throw storeError(
        'SELF_LEARNING_INVALID_ACTOR',
        `journal actor ${field} must be a non-empty string or null`
      );
    }
    if (typeof actor[field] === 'string') {
      actor[field] = assertRedactionStableString(actor[field].trim(), `journal actor ${field}`);
    }
  }
  return canonicalize(actor);
}

function validateRecordType(value) {
  if (!RECORD_TYPES.includes(value)) {
    throw storeError('SELF_LEARNING_INVALID_RECORD', `unsupported self-learning record type: ${value}`);
  }
  return value;
}

function normalizeRecordInput(input) {
  assertExactKeys(
    input,
    ['record_type', 'record_id', 'entity_id', 'actor', 'occurred_at', 'payload'],
    'append record input'
  );
  if (!isPlainObject(input.payload)) {
    throw storeError('SELF_LEARNING_INVALID_RECORD', 'append record payload must be an object');
  }
  return {
    record_type: validateRecordType(input.record_type),
    record_id: validateIdentifier(input.record_id, 'record id'),
    entity_id: validateIdentifier(input.entity_id, 'entity id'),
    actor: normalizeActor(input.actor),
    occurred_at: normalizeTimestamp(input.occurred_at, 'record occurred_at'),
    payload: redactCanonicalValue(input.payload, 'record payload'),
  };
}

function validateTombstonePayload(payload, label = 'tombstone payload') {
  assertExactKeys(payload, TOMBSTONE_KEYS, label);
  if (payload.schema_version !== TOMBSTONE_SCHEMA_VERSION) {
    throw storeError('SELF_LEARNING_INVALID_TOMBSTONE', `${label} schema_version is unsupported`);
  }
  validateIdentifier(payload.target_id, `${label} target_id`);
  validateHash(payload.target_hash, `${label} target_hash`);
  if (typeof payload.reason !== 'string' || payload.reason.trim() === '' || payload.reason.length > 1000) {
    throw storeError('SELF_LEARNING_INVALID_TOMBSTONE', `${label} reason is invalid`);
  }
  if (payload.replacement_id !== null) {
    validateIdentifier(payload.replacement_id, `${label} replacement_id`);
    if (payload.replacement_id === payload.target_id) {
      throw storeError('SELF_LEARNING_INVALID_TOMBSTONE', `${label} replacement_id must differ from target_id`);
    }
  }
  return payload;
}

function recordCore(input) {
  return {
    schema_version: JOURNAL_RECORD_SCHEMA_VERSION,
    sequence: input.sequence,
    record_type: input.record_type,
    record_id: input.record_id,
    entity_id: input.entity_id,
    actor: input.actor,
    occurred_at: input.occurred_at,
    payload_hash: input.payload_hash,
    previous_hash: input.previous_hash,
    payload: input.payload,
  };
}

function createRecord(input, sequence, previousHash) {
  const core = recordCore({
    ...input,
    sequence,
    previous_hash: previousHash,
    payload_hash: hashObject(input.payload),
  });
  return canonicalize({ ...core, record_hash: hashObject(core) });
}

function semanticIdentityHash(value) {
  return hashObject({
    record_type: value.record_type,
    record_id: value.record_id,
    entity_id: value.entity_id,
    actor: value.actor,
    occurred_at: value.occurred_at,
    payload_hash: Object.prototype.hasOwnProperty.call(value, 'payload_hash')
      ? value.payload_hash
      : hashObject(value.payload),
  });
}

function validateRecord(record, expectedSequence, expectedPreviousHash, fileName) {
  assertExactKeys(record, RECORD_KEYS, `journal record ${expectedSequence}`);
  if (record.schema_version !== JOURNAL_RECORD_SCHEMA_VERSION) {
    throw storeError(
      'SELF_LEARNING_CORRUPT',
      `journal record ${expectedSequence} has unsupported schema_version`
    );
  }
  if (record.sequence !== expectedSequence) {
    throw storeError(
      'SELF_LEARNING_CORRUPT',
      `journal sequence gap: expected ${expectedSequence}, got ${record.sequence}`
    );
  }
  validateRecordType(record.record_type);
  validateIdentifier(record.record_id, `journal record ${expectedSequence} record_id`);
  validateIdentifier(record.entity_id, `journal record ${expectedSequence} entity_id`);
  const actor = normalizeActor(record.actor);
  if (JSON.stringify(actor) !== JSON.stringify(canonicalize(record.actor))) {
    throw storeError('SELF_LEARNING_CORRUPT', `journal record ${expectedSequence} actor is not normalized`);
  }
  normalizeTimestamp(record.occurred_at, `journal record ${expectedSequence} occurred_at`);
  validateHash(record.payload_hash, `journal record ${expectedSequence} payload_hash`);
  validateHash(record.previous_hash, `journal record ${expectedSequence} previous_hash`, { nullable: true });
  validateHash(record.record_hash, `journal record ${expectedSequence} record_hash`);
  if (record.previous_hash !== expectedPreviousHash) {
    throw storeError(
      'SELF_LEARNING_CORRUPT',
      `journal previous hash mismatch at sequence ${expectedSequence}`
    );
  }
  if (!isPlainObject(record.payload)) {
    throw storeError('SELF_LEARNING_CORRUPT', `journal record ${expectedSequence} payload is not an object`);
  }
  const redactedPayload = redactCanonicalValue(record.payload, `journal record ${expectedSequence} payload`);
  if (JSON.stringify(redactedPayload) !== JSON.stringify(canonicalize(record.payload))) {
    throw storeError(
      'SELF_LEARNING_CORRUPT',
      `journal record ${expectedSequence} contains unredacted sensitive data`
    );
  }
  if (hashObject(record.payload) !== record.payload_hash) {
    throw storeError('SELF_LEARNING_CORRUPT', `journal payload hash mismatch at sequence ${expectedSequence}`);
  }
  const { record_hash: ignored, ...core } = record;
  if (hashObject(core) !== record.record_hash) {
    throw storeError('SELF_LEARNING_CORRUPT', `journal record hash mismatch at sequence ${expectedSequence}`);
  }
  const expectedFileName = recordFileName(expectedSequence, record.record_hash);
  if (fileName !== expectedFileName) {
    throw storeError(
      'SELF_LEARNING_CORRUPT',
      `journal filename does not match record hash at sequence ${expectedSequence}`
    );
  }
  if (record.record_type === 'tombstone') {
    validateTombstonePayload(record.payload, `journal tombstone ${record.record_id}`);
    if (record.entity_id !== record.payload.target_id) {
      throw storeError('SELF_LEARNING_CORRUPT', 'journal tombstone entity_id does not match target_id');
    }
  }
  return record;
}

function validateRecordSemantics(records) {
  const recordIds = new Set();
  const latestByEntity = new Map();
  const tombstoned = new Map();
  for (const record of records) {
    if (recordIds.has(record.record_id)) {
      throw storeError('SELF_LEARNING_CORRUPT', `duplicate journal record id: ${record.record_id}`);
    }
    recordIds.add(record.record_id);
    if (record.record_type === 'tombstone') {
      const target = latestByEntity.get(record.payload.target_id);
      if (!target) {
        throw storeError(
          'SELF_LEARNING_CORRUPT',
          `tombstone references unknown target: ${record.payload.target_id}`
        );
      }
      if (tombstoned.has(record.payload.target_id)) {
        throw storeError(
          'SELF_LEARNING_CORRUPT',
          `entity is already tombstoned: ${record.payload.target_id}`
        );
      }
      if (target.record_hash !== record.payload.target_hash) {
        throw storeError(
          'SELF_LEARNING_CORRUPT',
          `tombstone target hash does not match latest entity record: ${record.payload.target_id}`
        );
      }
      tombstoned.set(record.payload.target_id, record);
      continue;
    }
    if (tombstoned.has(record.entity_id)) {
      throw storeError(
        'SELF_LEARNING_CORRUPT',
        `journal attempts to resurrect tombstoned entity: ${record.entity_id}`
      );
    }
    latestByEntity.set(record.entity_id, record);
  }
  return { latestByEntity, tombstoned };
}

function parseLockBytes(bytes, lockFile) {
  try {
    const lock = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
    assertExactKeys(lock, LOCK_KEYS, 'journal lock');
    if (lock.schema_version !== LOCK_SCHEMA_VERSION
        || typeof lock.token !== 'string' || !/^[a-f0-9]{32}$/.test(lock.token)
        || !Number.isSafeInteger(lock.pid) || lock.pid <= 0
        || typeof lock.operation !== 'string' || lock.operation.trim() === '') {
      throw storeError('SELF_LEARNING_LOCK_CORRUPT', `self-learning journal lock is invalid: ${lockFile}`);
    }
    normalizeTimestamp(lock.acquired_at, 'journal lock acquired_at');
    return lock;
  } catch (error) {
    if (error && error.code === 'SELF_LEARNING_LOCK_CORRUPT') throw error;
    throw storeError('SELF_LEARNING_LOCK_CORRUPT', `self-learning journal lock is corrupt: ${lockFile}`, error);
  }
}

function readLockFile(lockFile) {
  return parseLockBytes(fs.readFileSync(lockFile), lockFile);
}

function lockSnapshot(lockFile) {
  const stat = fs.lstatSync(lockFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw storeError('SELF_LEARNING_LOCK_CORRUPT', `self-learning journal lock is not a regular file: ${lockFile}`);
  }
  const bytes = fs.readFileSync(lockFile);
  return {
    bytes,
    identity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      birthtimeMs: stat.birthtimeMs,
      nlink: stat.nlink,
    },
  };
}

function sameLockSnapshot(left, right) {
  return left.bytes.equals(right.bytes)
    && Object.keys(left.identity).every((key) => left.identity[key] === right.identity[key]);
}

function samePinnedLock(left, right) {
  return left.bytes.equals(right.bytes)
    && ['dev', 'ino', 'size', 'mtimeMs', 'birthtimeMs']
      .every((key) => left.identity[key] === right.identity[key]);
}

function isProcessDefinitelyDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return Boolean(error && error.code === 'ESRCH');
  }
}

function sleepForLockRetry(attempt, deadline) {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) return;
  const delay = Math.min(
    remaining,
    LOCK_RETRY_MAX_MS,
    LOCK_RETRY_MIN_MS + Math.min(attempt, 7) * 4 + (process.pid % 5)
  );
  Atomics.wait(LOCK_SLEEP_BUFFER, 0, 0, delay);
}

function normalizeLockTimingOption(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > 120000) {
    throw storeError('SELF_LEARNING_INVALID_OPTIONS', `${label} must be an integer from 0 to 120000`);
  }
  return value;
}

function inspectExistingLock(lockFile) {
  const snapshot = lockSnapshot(lockFile);
  return { snapshot, lock: parseLockBytes(snapshot.bytes, lockFile) };
}

function restoreQuarantinedLock(quarantineFile, lockFile, journalDir) {
  try {
    // Hard-link restore is no-overwrite. If another writer already owns a new
    // LOCK, preserve it and leave the quarantined inode untouched for audit.
    fs.linkSync(quarantineFile, lockFile);
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
  fsyncDirectoryBestEffort(journalDir);
  fs.rmSync(quarantineFile);
  return true;
}

function recoverDeadLock(lockFile, journalDir, observed) {
  const storeDir = path.dirname(journalDir);
  const claimFile = path.join(storeDir, LOCK_RECOVERY_CLAIM_FILE_NAME);
  const quarantineFile = path.join(
    storeDir,
    `.journal-lock-stale-${crypto.randomBytes(16).toString('hex')}.json`
  );
  let claimCreated = false;
  let moved = false;
  try {
    // `link` is the no-overwrite recovery claim. It pins the exact lock inode,
    // so only one contender may perform the destructive rename and all other
    // writers remain blocked by the fixed claim path.
    fs.linkSync(lockFile, claimFile);
    claimCreated = true;
  } catch (error) {
    if (error && ['EEXIST', 'ENOENT'].includes(error.code)) return false;
    throw storeError(
      'SELF_LEARNING_LOCK_FAILED',
      `failed to claim stale journal lock at ${lockFile}`,
      error
    );
  }
  try {
    const claimed = inspectExistingLock(claimFile);
    const confirmed = inspectExistingLock(lockFile);
    if (!samePinnedLock(observed.snapshot, confirmed.snapshot)
        || !sameLockSnapshot(claimed.snapshot, confirmed.snapshot)
        || confirmed.lock.token !== observed.lock.token
        || confirmed.lock.pid !== observed.lock.pid
        || !isProcessDefinitelyDead(confirmed.lock.pid)) {
      return false;
    }

    // Rename is the atomic destructive boundary. A new live LOCK may only be
    // created after the recovery claim is removed, and cleanup targets only
    // this unique quarantine path, never whatever may later occupy LOCK.json.
    fs.renameSync(lockFile, quarantineFile);
    moved = true;
    fsyncDirectoryBestEffort(journalDir);
    fsyncDirectoryBestEffort(storeDir);
    const quarantined = inspectExistingLock(quarantineFile);
    const claimedAfterMove = inspectExistingLock(claimFile);
    if (!samePinnedLock(confirmed.snapshot, quarantined.snapshot)
        || !sameLockSnapshot(quarantined.snapshot, claimedAfterMove.snapshot)
        || quarantined.lock.token !== observed.lock.token
        || quarantined.lock.pid !== observed.lock.pid
        || !isProcessDefinitelyDead(quarantined.lock.pid)) {
      if (restoreQuarantinedLock(quarantineFile, lockFile, journalDir)) moved = false;
      return false;
    }
    fs.rmSync(quarantineFile);
    moved = false;
    fsyncDirectoryBestEffort(storeDir);
    return true;
  } finally {
    if (moved && fs.existsSync(quarantineFile) && !fs.existsSync(lockFile)) {
      try {
        if (restoreQuarantinedLock(quarantineFile, lockFile, journalDir)) moved = false;
      } catch (_) {}
    }
    if (claimCreated && fs.existsSync(claimFile)) {
      try {
        fs.rmSync(claimFile);
        fsyncDirectoryBestEffort(storeDir);
      } catch (_) {}
    }
  }
}

function emptyJournalView() {
  return {
    schema_version: JOURNAL_VIEW_SCHEMA_VERSION,
    revision: 0,
    head_hash: null,
    records: [],
  };
}

function readJournalInternal(storeDir, options = {}) {
  const resolvedStore = assertStoreDirectory(storeDir);
  const journalDir = resolveInside(resolvedStore, JOURNAL_DIR_NAME);
  if (!fs.existsSync(journalDir)) return emptyJournalView();
  assertNoLinks(journalDir);
  if (!fs.lstatSync(journalDir).isDirectory()) {
    throw storeError('SELF_LEARNING_CORRUPT', `self-learning journal is not a directory: ${journalDir}`);
  }

  const recordEntries = [];
  for (const entry of fs.readdirSync(journalDir, { withFileTypes: true })) {
    const file = path.join(journalDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw storeError('SELF_LEARNING_CORRUPT', `journal contains a symbolic link or junction: ${file}`);
    }
    if (entry.name === LOCK_FILE_NAME) {
      const lock = readLockFile(file);
      if (!options.lockToken || lock.token !== options.lockToken) {
        throw storeError('SELF_LEARNING_LOCKED', `self-learning journal is locked: ${file}`);
      }
      continue;
    }
    if (!entry.isFile() || !RECORD_FILE_PATTERN.test(entry.name)) {
      throw storeError('SELF_LEARNING_CORRUPT', `unexpected journal entry or residual transaction: ${file}`);
    }
    recordEntries.push(entry.name);
  }
  recordEntries.sort();

  const records = [];
  let previousHash = null;
  for (let index = 0; index < recordEntries.length; index += 1) {
    const fileName = recordEntries[index];
    const match = fileName.match(RECORD_FILE_PATTERN);
    const expectedSequence = index + 1;
    if (Number(match[1]) !== expectedSequence) {
      throw storeError(
        'SELF_LEARNING_CORRUPT',
        `journal sequence gap in filename: expected ${expectedSequence}, got ${Number(match[1])}`
      );
    }
    const file = path.join(journalDir, fileName);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw storeError('SELF_LEARNING_CORRUPT', `invalid journal JSON at ${file}`, error);
    }
    try {
      validateRecord(record, expectedSequence, previousHash, fileName);
    } catch (error) {
      if (error && error.code === 'SELF_LEARNING_CORRUPT') throw error;
      throw storeError(
        'SELF_LEARNING_CORRUPT',
        `journal record validation failed at sequence ${expectedSequence}: ${error.message}`,
        error
      );
    }
    records.push(record);
    previousHash = record.record_hash;
  }
  validateRecordSemantics(records);
  return {
    schema_version: JOURNAL_VIEW_SCHEMA_VERSION,
    revision: records.length,
    head_hash: previousHash,
    records,
  };
}

function readJournal(storeDir) {
  try {
    return readJournalInternal(storeDir);
  } catch (error) {
    if (error && /^SELF_LEARNING_/.test(error.code || '')) throw error;
    throw storeError(
      'SELF_LEARNING_CORRUPT',
      `failed to read self-learning journal at ${path.resolve(String(storeDir || ''))}: ${error.message}`,
      error
    );
  }
}

function acquireJournalLock(storeDir, options = {}) {
  const journalDir = ensureJournalDir(storeDir);
  const lockFile = path.join(journalDir, LOCK_FILE_NAME);
  const recoveryClaimFile = path.join(path.dirname(journalDir), LOCK_RECOVERY_CLAIM_FILE_NAME);
  const retryTimeoutMs = normalizeLockTimingOption(
    options.retry_timeout_ms,
    DEFAULT_LOCK_RETRY_TIMEOUT_MS,
    'journal lock retry_timeout_ms'
  );
  const staleLockAgeMs = normalizeLockTimingOption(
    options.stale_lock_age_ms,
    DEFAULT_STALE_LOCK_AGE_MS,
    'journal lock stale_lock_age_ms'
  );
  const token = crypto.randomBytes(16).toString('hex');
  const lock = {
    schema_version: LOCK_SCHEMA_VERSION,
    token,
    pid: process.pid,
    operation: typeof options.operation === 'string' && options.operation.trim()
      ? options.operation.trim()
      : 'append-record',
    acquired_at: options.acquired_at || new Date().toISOString(),
  };
  normalizeTimestamp(lock.acquired_at, 'journal lock acquired_at');
  const deadline = Date.now() + retryTimeoutMs;
  let attempt = 0;
  let lastExistingError = null;
  while (true) {
    if (fs.existsSync(recoveryClaimFile)) {
      if (Date.now() >= deadline) {
        throw storeError(
          'SELF_LEARNING_LOCKED',
          `self-learning journal lock recovery is already claimed: ${lockFile}`
        );
      }
      sleepForLockRetry(attempt, deadline);
      attempt += 1;
      continue;
    }
    let descriptor;
    let createdIdentity;
    try {
      descriptor = fs.openSync(lockFile, 'wx', 0o600);
      const stat = fs.fstatSync(descriptor);
      createdIdentity = { dev: stat.dev, ino: stat.ino };
      fs.writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectoryBestEffort(journalDir);
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) {}
      }
      const transientOpenRace = !createdIdentity
        && error
        && TRANSIENT_LOCK_OPEN_CODES.has(error.code);
      if (!error || (error.code !== 'EEXIST' && !transientOpenRace)) {
        if (createdIdentity) {
          try {
            const stat = fs.lstatSync(lockFile);
            if (stat.dev === createdIdentity.dev && stat.ino === createdIdentity.ino) {
              fs.rmSync(lockFile);
              fsyncDirectoryBestEffort(journalDir);
            }
          } catch (_) {}
        }
        throw storeError(
          'SELF_LEARNING_LOCK_FAILED',
          `failed to acquire journal lock at ${lockFile}`,
          error
        );
      }

      if (transientOpenRace && !fs.existsSync(lockFile)) {
        if (Date.now() >= deadline) {
          throw storeError(
            'SELF_LEARNING_LOCK_FAILED',
            `failed to acquire journal lock at ${lockFile}`,
            error
          );
        }
        sleepForLockRetry(attempt, deadline);
        attempt += 1;
        continue;
      }

      try {
        const observed = inspectExistingLock(lockFile);
        lastExistingError = null;
        const acquiredAt = Date.parse(observed.lock.acquired_at);
        const isOld = Number.isFinite(acquiredAt) && Date.now() - acquiredAt >= staleLockAgeMs;
        if (isOld && isProcessDefinitelyDead(observed.lock.pid)) {
          if (recoverDeadLock(lockFile, journalDir, observed)) continue;
        }
      } catch (inspectionError) {
        if (inspectionError && inspectionError.code === 'ENOENT') continue;
        lastExistingError = inspectionError;
      }

      if (Date.now() >= deadline) {
        if (lastExistingError && lastExistingError.code === 'SELF_LEARNING_LOCK_CORRUPT') {
          throw lastExistingError;
        }
        throw storeError(
          'SELF_LEARNING_LOCKED',
          `self-learning journal is already locked: ${lockFile}`,
          error
        );
      }
      sleepForLockRetry(attempt, deadline);
      attempt += 1;
    }
  }
  const persisted = readLockFile(lockFile);
  if (persisted.token !== token) {
    throw storeError('SELF_LEARNING_LOCK_CORRUPT', 'journal lock readback token does not match');
  }
  let released = false;
  return {
    file: lockFile,
    token,
    value: persisted,
    release() {
      if (released) return false;
      try {
        const current = readLockFile(lockFile);
        if (current.token !== token) {
          throw storeError('SELF_LEARNING_LOCK_OWNERSHIP', 'journal lock ownership changed before release');
        }
        assertNoLinks(lockFile);
        fs.rmSync(lockFile);
        fsyncDirectoryBestEffort(journalDir);
        released = true;
        return true;
      } catch (error) {
        if (error && /^SELF_LEARNING_/.test(error.code || '')) throw error;
        throw storeError(
          'SELF_LEARNING_LOCK_RELEASE_FAILED',
          `failed to release self-learning journal lock at ${lockFile}: ${error.message}`,
          error
        );
      }
    },
  };
}

function assertExpectedState(journal, options) {
  if (options.expected_revision !== undefined
      && options.expected_revision !== journal.revision) {
    throw storeError(
      'SELF_LEARNING_REVISION_CONFLICT',
      `journal revision conflict: expected ${options.expected_revision}, current ${journal.revision}`
    );
  }
  if (options.expected_head_hash !== undefined
      && options.expected_head_hash !== journal.head_hash) {
    throw storeError(
      'SELF_LEARNING_HASH_CONFLICT',
      `journal head hash conflict: expected ${options.expected_head_hash}, current ${journal.head_hash}`
    );
  }
}

function normalizeAppendOptions(options) {
  if (!isPlainObject(options)) {
    throw storeError('SELF_LEARNING_INVALID_OPTIONS', 'append options must be an object');
  }
  const allowed = new Set(['expected_revision', 'expected_head_hash']);
  const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw storeError(
      'SELF_LEARNING_INVALID_OPTIONS',
      `append options fields are unsupported: ${unexpected.sort().join(', ')}`
    );
  }
  const normalized = {};
  if (Object.prototype.hasOwnProperty.call(options, 'expected_revision')) {
    if (!Number.isSafeInteger(options.expected_revision) || options.expected_revision < 0) {
      throw storeError(
        'SELF_LEARNING_INVALID_OPTIONS',
        'append options expected_revision must be a non-negative safe integer'
      );
    }
    normalized.expected_revision = options.expected_revision;
  }
  if (Object.prototype.hasOwnProperty.call(options, 'expected_head_hash')) {
    validateHash(options.expected_head_hash, 'append options expected_head_hash', { nullable: true });
    normalized.expected_head_hash = options.expected_head_hash;
  }
  return normalized;
}

function writeRecordAtomically(journalDir, record, lockToken) {
  const finalFile = path.join(journalDir, recordFileName(record.sequence, record.record_hash));
  const temporary = path.join(journalDir, `.record-${lockToken}.tmp`);
  let descriptor;
  try {
    if (fs.existsSync(finalFile)) {
      throw storeError('SELF_LEARNING_CONFLICT', `journal record file already exists: ${finalFile}`);
    }
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertNoLinks(journalDir);
    fs.renameSync(temporary, finalFile);
    fsyncDirectoryBestEffort(journalDir);
    return finalFile;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    if (fs.existsSync(temporary)) {
      try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    }
    throw error;
  }
}

function runJournalTransaction(storeDir, operation, transaction, lockOptions = {}) {
  const lock = acquireJournalLock(storeDir, { ...lockOptions, operation });
  let operationError;
  try {
    return transaction(lock);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      lock.release();
    } catch (releaseError) {
      if (!operationError) throw releaseError;
      operationError.release_error = releaseError;
    }
  }
}

function appendNormalizedRecordLocked(storeDir, normalized, journal, lock, appendOptions = {}) {
  assertExpectedState(journal, appendOptions);
  const semantics = validateRecordSemantics(journal.records);
  if (normalized.record_type !== 'tombstone' && semantics.tombstoned.has(normalized.entity_id)) {
    throw storeError(
      'SELF_LEARNING_TOMBSTONED',
      `cannot resurrect tombstoned entity: ${normalized.entity_id}`
    );
  }
  if (normalized.record_type === 'tombstone') validateTombstonePayload(normalized.payload);
  const record = createRecord(normalized, journal.revision + 1, journal.head_hash);
  validateRecordSemantics([...journal.records, record]);
  const file = writeRecordAtomically(resolveJournalDir(storeDir), record, lock.token);
  const readback = readJournalInternal(storeDir, { lockToken: lock.token });
  const persisted = readback.records[readback.records.length - 1];
  if (readback.revision !== record.sequence || persisted.record_hash !== record.record_hash) {
    throw storeError('SELF_LEARNING_READBACK_FAILED', 'journal append readback does not match committed record');
  }
  return { changed: true, record: persisted, file, journal: readback };
}

function appendRecord(storeDir, input, options = {}) {
  const normalized = normalizeRecordInput(input);
  const appendOptions = normalizeAppendOptions(options);
  return runJournalTransaction(storeDir, `append:${normalized.record_type}`, (lock) => {
    const journal = readJournalInternal(storeDir, { lockToken: lock.token });
    const existing = journal.records.find((record) => record.record_id === normalized.record_id);
    if (existing) {
      if (semanticIdentityHash(existing) !== semanticIdentityHash(normalized)) {
        throw storeError(
          'SELF_LEARNING_ID_CONFLICT',
          `journal record id conflict for ${normalized.record_id}: normalized semantic content differs`
        );
      }
      return { changed: false, record: existing, file: path.join(
        resolveJournalDir(storeDir),
        recordFileName(existing.sequence, existing.record_hash)
      ), journal };
    }
    return appendNormalizedRecordLocked(storeDir, normalized, journal, lock, appendOptions);
  });
}

function normalizeBehaviorEventReceiptSpec(input) {
  if (!isPlainObject(input)) {
    throw storeError('SELF_LEARNING_INVALID_RECEIPT', 'behavior event receipt spec must be an object');
  }
  const allowed = new Set(['record_id', 'first_occurred_at']);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw storeError(
      'SELF_LEARNING_INVALID_RECEIPT',
      `behavior event receipt spec has unexpected fields: ${unexpected.sort().join(', ')}`
    );
  }
  validateIdentifier(input.record_id, 'behavior event receipt record_id');
  return {
    record_id: input.record_id,
    first_occurred_at: input.first_occurred_at === undefined
      ? null
      : normalizeTimestamp(input.first_occurred_at, 'behavior event receipt first_occurred_at'),
  };
}

/**
 * Resolve first-receipt time, idempotent replay, conflict detection, and append
 * under one journal lock. Runtime adapters remain responsible for constructing
 * the domain event and its actor mapping; this function owns only the durable
 * receipt boundary. The record builder receives the latest verified journal
 * snapshot while the same lock remains held so callers can make atomic
 * authority decisions without a second read/lock cycle.
 */
function getOrAppendBehaviorEventReceipt(
  storeDir,
  input,
  buildRecordInput,
  options = {}
) {
  const spec = normalizeBehaviorEventReceiptSpec(input);
  if (typeof buildRecordInput !== 'function') {
    throw storeError(
      'SELF_LEARNING_INVALID_RECEIPT',
      'behavior event receipt record builder is required'
    );
  }
  if (!isPlainObject(options)
      || Object.keys(options).some((key) => key !== 'retry_timeout_ms')) {
    throw storeError(
      'SELF_LEARNING_INVALID_OPTIONS',
      'behavior event receipt options may contain only retry_timeout_ms'
    );
  }
  const lockOptions = options.retry_timeout_ms === undefined
    ? {}
    : { retry_timeout_ms: options.retry_timeout_ms };
  return runJournalTransaction(storeDir, 'append:behavior-event-receipt', (lock) => {
    const journal = readJournalInternal(storeDir, { lockToken: lock.token });
    const matches = journal.records.filter((record) => record.record_id === spec.record_id);
    if (matches.length > 1) {
      throw storeError(
        'SELF_LEARNING_CORRUPT',
        `behavior event receipt has duplicate record ids: ${spec.record_id}`
      );
    }
    const existing = matches[0] || null;
    const occurredAt = existing
      ? existing.occurred_at
      : spec.first_occurred_at || new Date().toISOString();
    const built = buildRecordInput({ occurred_at: occurredAt, existing, journal });
    const normalized = normalizeRecordInput(built);
    if (normalized.record_type !== 'behavior_event'
        || normalized.record_id !== spec.record_id
        || normalized.entity_id !== spec.record_id
        || !isPlainObject(normalized.payload)
        || normalized.payload.event_id !== spec.record_id
        || normalized.payload.occurred_at !== occurredAt) {
      throw storeError(
        'SELF_LEARNING_INVALID_RECEIPT',
        'behavior event receipt builder output is not identity/time bound'
      );
    }
    if (existing) {
      if (semanticIdentityHash(existing) !== semanticIdentityHash(normalized)) {
        throw storeError(
          'SELF_LEARNING_ID_CONFLICT',
          `behavior event receipt id conflict for ${spec.record_id}: normalized semantic content differs`
        );
      }
      return {
        changed: false,
        record: existing,
        file: path.join(
          resolveJournalDir(storeDir),
          recordFileName(existing.sequence, existing.record_hash)
        ),
        journal,
      };
    }
    return appendNormalizedRecordLocked(storeDir, normalized, journal, lock);
  }, lockOptions);
}

function normalizePromptReceiptSpec(input) {
  assertExactKeys(
    input,
    ['project_id', 'session_id', 'transcript_ref', 'replay_ref'],
    'prompt receipt spec'
  );
  for (const [field, maximum] of [['project_id', 256], ['session_id', 256]]) {
    if (typeof input[field] !== 'string'
        || input[field].trim() === ''
        || input[field].length > maximum) {
      throw storeError('SELF_LEARNING_INVALID_RECEIPT', `prompt receipt ${field} is invalid`);
    }
    assertRedactionStableString(input[field], `prompt receipt ${field}`);
  }
  validateHash(input.transcript_ref, 'prompt receipt transcript_ref');
  validateHash(input.replay_ref, 'prompt receipt replay_ref');
  const normalized = canonicalize({
    project_id: input.project_id,
    session_id: input.session_id,
    transcript_ref: input.transcript_ref,
    replay_ref: input.replay_ref,
  });
  normalized.stream_ref = hashObject({
    schema_version: PROMPT_RECEIPT_SCHEMA_VERSION,
    project_id: normalized.project_id,
    session_id: normalized.session_id,
    transcript_ref: normalized.transcript_ref,
  });
  return normalized;
}

function promptReceiptSourceEventId(receipt) {
  const stream = receipt.stream_ref.slice('sha256:'.length);
  const replay = receipt.replay_ref.slice('sha256:'.length);
  return `claude-prompt-receipt:${stream}:${replay}:${String(receipt.occurrence).padStart(12, '0')}`;
}

function validatePromptReceipt(receipt, label = 'prompt receipt') {
  assertExactKeys(receipt, PROMPT_RECEIPT_KEYS, label);
  if (receipt.schema_version !== PROMPT_RECEIPT_SCHEMA_VERSION) {
    throw storeError('SELF_LEARNING_CORRUPT', `${label} schema_version is unsupported`);
  }
  validateHash(receipt.stream_ref, `${label} stream_ref`);
  validateHash(receipt.transcript_ref, `${label} transcript_ref`);
  validateHash(receipt.replay_ref, `${label} replay_ref`);
  if (!Number.isSafeInteger(receipt.occurrence) || receipt.occurrence < 1) {
    throw storeError('SELF_LEARNING_CORRUPT', `${label} occurrence is invalid`);
  }
  return receipt;
}

function promptReceiptsForStream(records, spec) {
  const receipts = [];
  for (const record of records) {
    const detail = record && record.payload && record.payload.details;
    const receipt = detail && detail.prompt_receipt;
    if (receipt === undefined) continue;
    try {
      validatePromptReceipt(receipt, `prompt receipt at journal sequence ${record.sequence}`);
    } catch (error) {
      if (error && error.code === 'SELF_LEARNING_CORRUPT') throw error;
      throw storeError(
        'SELF_LEARNING_CORRUPT',
        `prompt receipt at journal sequence ${record.sequence} is invalid`,
        error
      );
    }
    if (receipt.stream_ref !== spec.stream_ref) continue;
    if (receipt.transcript_ref !== spec.transcript_ref
        || record.record_type !== 'behavior_event'
        || record.payload.project_id !== spec.project_id
        || record.payload.session_id !== spec.session_id
        || record.payload.source_event_id !== promptReceiptSourceEventId(receipt)
        || record.payload.occurred_at !== record.occurred_at
        || record.payload.runtime !== 'claude'
        || record.payload.source !== 'claude_hook'
        || record.payload.source_assurance !== 'observed'
        || record.payload.event_type !== 'user.prompt'
        || !record.payload.actor || record.payload.actor.kind !== 'user'
        || record.actor.kind !== 'user'
        || record.actor.runtime !== 'claude'
        || record.actor.authority_ref !== record.payload.source_event_id) {
      throw storeError(
        'SELF_LEARNING_CORRUPT',
        `prompt receipt at journal sequence ${record.sequence} is not bound to its trusted prompt event`
      );
    }
    receipts.push({ record, receipt });
  }
  receipts.sort((left, right) => left.receipt.occurrence - right.receipt.occurrence);
  receipts.forEach(({ receipt }, index) => {
    if (receipt.occurrence !== index + 1) {
      throw storeError('SELF_LEARNING_CORRUPT', 'prompt receipt stream occurrence is not monotonic');
    }
  });
  return receipts;
}

function assertBuiltPromptReceiptRecord(input, spec, receipt, sourceEventId, occurredAt) {
  if (!isPlainObject(input)
      || input.record_type !== 'behavior_event'
      || input.record_id !== input.entity_id
      || !isPlainObject(input.actor)
      || input.actor.kind !== 'user'
      || input.actor.runtime !== 'claude'
      || input.actor.authority_ref !== sourceEventId
      || !isPlainObject(input.payload)
      || input.record_id !== input.payload.event_id
      || input.payload.project_id !== spec.project_id
      || input.payload.session_id !== spec.session_id
      || input.payload.source_event_id !== sourceEventId
      || input.payload.occurred_at !== occurredAt
      || input.payload.runtime !== 'claude'
      || input.payload.source !== 'claude_hook'
      || input.payload.source_assurance !== 'observed'
      || input.payload.event_type !== 'user.prompt'
      || !isPlainObject(input.payload.actor)
      || input.payload.actor.kind !== 'user'
      || !isPlainObject(input.payload.details)
      || !isPlainObject(input.payload.details.prompt_receipt)
      || hashObject(input.payload.details.prompt_receipt) !== hashObject(receipt)) {
    throw storeError(
      'SELF_LEARNING_INVALID_RECEIPT',
      'prompt receipt builder output is not bound to the journal-owned receipt'
    );
  }
}

/**
 * Allocate or replay a Claude prompt receipt under the journal's single lock.
 * The caller supplies only hashed transcript/replay references; the journal
 * owns occurrence and first-receipt time so prompt text and wall time never
 * become idempotency keys.
 */
function getOrAppendPromptReceipt(storeDir, input, buildRecordInput) {
  const spec = normalizePromptReceiptSpec(input);
  if (typeof buildRecordInput !== 'function') {
    throw storeError('SELF_LEARNING_INVALID_RECEIPT', 'prompt receipt record builder is required');
  }
  return runJournalTransaction(storeDir, 'append:prompt-receipt', (lock) => {
    const journal = readJournalInternal(storeDir, { lockToken: lock.token });
    const stream = promptReceiptsForStream(journal.records, spec);
    const matches = stream.filter(({ receipt }) => receipt.replay_ref === spec.replay_ref);
    if (matches.length > 1) {
      throw storeError('SELF_LEARNING_CORRUPT', 'prompt replay reference has duplicate receipts');
    }
    const existing = matches[0] || null;
    const receipt = existing ? existing.receipt : canonicalize({
      schema_version: PROMPT_RECEIPT_SCHEMA_VERSION,
      stream_ref: spec.stream_ref,
      transcript_ref: spec.transcript_ref,
      replay_ref: spec.replay_ref,
      occurrence: stream.length + 1,
    });
    const sourceEventId = promptReceiptSourceEventId(receipt);
    const occurredAt = existing ? existing.record.occurred_at : new Date().toISOString();
    const built = buildRecordInput({
      source_event_id: sourceEventId,
      occurred_at: occurredAt,
      occurrence: receipt.occurrence,
      receipt,
    });
    assertBuiltPromptReceiptRecord(built, spec, receipt, sourceEventId, occurredAt);
    const normalized = normalizeRecordInput(built);
    if (existing) {
      if (semanticIdentityHash(existing.record) !== semanticIdentityHash(normalized)) {
        throw storeError(
          'SELF_LEARNING_ID_CONFLICT',
          `prompt receipt id conflict for ${sourceEventId}: normalized semantic content differs`
        );
      }
      return {
        changed: false,
        record: existing.record,
        file: path.join(
          resolveJournalDir(storeDir),
          recordFileName(existing.record.sequence, existing.record.record_hash)
        ),
        journal,
        receipt,
      };
    }
    const result = appendNormalizedRecordLocked(storeDir, normalized, journal, lock);
    return { ...result, receipt };
  }, {
    // UserPromptSubmit is configured with a five-second host timeout. Leave
    // budget for parsing and recall instead of inheriting the 15-second
    // general writer wait.
    retry_timeout_ms: PROMPT_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
  });
}

function projectJournal(storeDir) {
  const journal = readJournal(storeDir);
  const { latestByEntity, tombstoned } = validateRecordSemantics(journal.records);
  const active = [...latestByEntity.entries()]
    .filter(([entityId]) => !tombstoned.has(entityId))
    .map(([, record]) => record)
    .sort((left, right) => left.sequence - right.sequence);
  const tombstonedRecords = [...tombstoned.entries()]
    .map(([entityId, record]) => ({
      entity_id: entityId,
      target_hash: record.payload.target_hash,
      tombstone_record_id: record.record_id,
      tombstone_hash: record.record_hash,
      reason: record.payload.reason,
      replacement_id: record.payload.replacement_id,
    }))
    .sort((left, right) => left.entity_id.localeCompare(right.entity_id));
  const core = {
    schema_version: PROJECTION_SCHEMA_VERSION,
    journal_revision: journal.revision,
    journal_head_hash: journal.head_hash,
    active,
    tombstoned: tombstonedRecords,
  };
  return { ...core, projection_hash: hashObject(core) };
}

function tombstoneEntity(storeDir, input, options = {}) {
  assertExactKeys(
    input,
    ['record_id', 'target_id', 'target_hash', 'actor', 'occurred_at', 'reason']
      .concat(Object.prototype.hasOwnProperty.call(input, 'replacement_id') ? ['replacement_id'] : []),
    'tombstone input'
  );
  const targetId = validateIdentifier(input.target_id, 'tombstone target id');
  validateHash(input.target_hash, 'tombstone target hash');
  if (typeof input.reason !== 'string' || input.reason.trim() === '') {
    throw storeError('SELF_LEARNING_INVALID_TOMBSTONE', 'tombstone reason is required');
  }
  const replacementId = input.replacement_id === undefined ? null : input.replacement_id;
  if (replacementId !== null) validateIdentifier(replacementId, 'tombstone replacement id');
  return appendRecord(storeDir, {
    record_type: 'tombstone',
    record_id: validateIdentifier(input.record_id, 'tombstone record id'),
    entity_id: targetId,
    actor: input.actor,
    occurred_at: input.occurred_at,
    payload: {
      schema_version: TOMBSTONE_SCHEMA_VERSION,
      target_id: targetId,
      target_hash: input.target_hash,
      reason: input.reason.trim(),
      replacement_id: replacementId,
    },
  }, options);
}

const verifyJournal = readJournal;

module.exports = {
  ACTOR_KINDS,
  JOURNAL_DIR_NAME,
  JOURNAL_RECORD_SCHEMA_VERSION,
  JOURNAL_VIEW_SCHEMA_VERSION,
  LOCK_FILE_NAME,
  LOCK_RECOVERY_CLAIM_FILE_NAME,
  LOCK_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
  RECORD_TYPES,
  TOMBSTONE_SCHEMA_VERSION,
  PROMPT_RECEIPT_SCHEMA_VERSION,
  PROMPT_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
  TOOL_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
  LIFECYCLE_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
  acquireJournalLock,
  appendRecord,
  getOrAppendBehaviorEventReceipt,
  getOrAppendPromptReceipt,
  projectJournal,
  readJournal,
  recordFileName,
  resolveJournalDir,
  resolveStoreDir,
  tombstoneEntity,
  verifyJournal,
};
