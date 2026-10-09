'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const controlStore = require('./control-store');

const LOCK_SCHEMA_VERSION = 'run-lock-v1';
const MOVE_INTENT_SCHEMA_VERSION = 'run-lock-move-intent-v1';
const STALE_GENERATION_MARKER_SCHEMA_VERSION = 'run-lock-stale-generation-v1';
const LOCK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNKNOWN_OWNER_STALE_MS = 5 * 60 * 1000;

function assertLockName(name) {
  if (!LOCK_NAME_PATTERN.test(String(name || ''))) {
    throw new Error(`invalid run lock name: ${name}`);
  }
}

function lockPathInControlDir(controlDir, name) {
  assertLockName(name);
  return path.join(path.resolve(controlDir), `.${name}.lock`);
}

function lockPath(runDir, name, options = {}) {
  return lockPathInControlDir(controlStore.controlRunDir(runDir, options), name);
}

function ownerPath(lockDir) {
  return path.join(lockDir, 'owner.json');
}

function readOwner(lockDir) {
  const file = ownerPath(lockDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function readOwnerState(lockDir) {
  const file = ownerPath(lockDir);
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        exists: false,
        raw: null,
        owner: null,
      };
    }
    throw error;
  }

  let owner = null;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    owner = parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    owner = null;
  }
  return {
    exists: true,
    raw,
    owner,
  };
}

function sameOwnerState(left, right) {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return left.raw.equals(right.raw);
}

function assertOwnerState(lockDir, expected, message) {
  const current = readOwnerState(lockDir);
  if (!sameOwnerState(current, expected)) throw new Error(message);
  return current;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function lockAgeMs(lockDir, nowMs) {
  try {
    return Math.max(0, nowMs - fs.statSync(lockDir).mtimeMs);
  } catch (_) {
    return 0;
  }
}

function canRecover(lockDir, owner, options) {
  const alive = options.isProcessAlive || isProcessAlive;
  if (owner && Number.isInteger(owner.pid)) return !alive(owner.pid);
  const staleAfterMs = Number.isFinite(options.unknownOwnerStaleMs)
    ? options.unknownOwnerStaleMs
    : UNKNOWN_OWNER_STALE_MS;
  return lockAgeMs(lockDir, options.nowMs || Date.now()) >= staleAfterMs;
}

function assertAuthority(runDir, candidate, options) {
  return controlStore.assertAuthoritativeControlPath(runDir, candidate, options);
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function capturePinnedDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const lexicalStat = fs.lstatSync(resolved, { bigint: true });
  if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink() || lexicalStat.ino === 0n) {
    throw new Error(`${label} must be an identity-bearing ordinary directory`);
  }
  const canonicalPath = fs.realpathSync.native(resolved);
  const stat = fs.lstatSync(canonicalPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) {
    throw new Error(`${label} must be an identity-bearing ordinary directory`);
  }
  if (lexicalStat.dev !== stat.dev || lexicalStat.ino !== stat.ino) {
    throw new Error(`${label} changed while its canonical identity was captured`);
  }
  return {
    canonicalPath,
    normalizedPath: normalizePath(canonicalPath),
    device: stat.dev,
    inode: stat.ino,
  };
}

function assertPinnedDirectory(directory, pin, label, options = {}) {
  const current = capturePinnedDirectory(directory, label);
  if ((!options.allowMoved && current.normalizedPath !== pin.normalizedPath)
      || current.device !== pin.device
      || current.inode !== pin.inode) {
    throw new Error(`${label} identity changed`);
  }
  return current;
}

function entryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function rawHash(raw) {
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function sameFileSnapshotIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readOptionalStableFile(file, label) {
  let before;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.ino === 0n) {
    throw new Error(`${label} must be an identity-bearing ordinary file`);
  }
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Preserve the identity captured before the path disappeared. Callers that
      // understand immutable retirement can require the exact inode in their
      // audit log; all other callers continue to fail closed on this ENOENT.
      error.stableFileIdentity = {
        device: before.dev,
        inode: before.ino,
        size: before.size,
      };
    }
    throw error;
  }
  let after;
  try {
    after = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      error.stableFileIdentity = {
        device: before.dev,
        inode: before.ino,
        size: before.size,
      };
    }
    throw error;
  }
  if (!sameFileSnapshotIdentity(before, after) || BigInt(raw.length) !== after.size) {
    throw new Error(`${label} changed during read`);
  }
  return {
    raw,
    hash: rawHash(raw),
    device: after.dev,
    inode: after.ino,
    size: after.size,
    mtimeNs: after.mtimeNs,
    ctimeNs: after.ctimeNs,
  };
}

function sameStableFile(left, right) {
  return Boolean(left && right)
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.raw.equals(right.raw);
}

function sameClaimedStableFile(left, right) {
  return Boolean(left && right)
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.raw.equals(right.raw);
}

function recoveryFencePath(lockDir) {
  return `${lockDir}.recovery-required`;
}

function assertNoRecoveryFence(lockDir, name) {
  if (entryExists(recoveryFencePath(lockDir))) {
    throw new Error(`${name} lock recovery required`);
  }
}

function publishRecoveryFence(controlDir, controlPin, lockDir, recoveryPath, lockPin,
  ownerState, name, cause) {
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  const file = recoveryFencePath(lockDir);
  const record = Buffer.from(`${JSON.stringify({
    schemaVersion: 'run-lock-recovery-v1',
    name,
    lockDir,
    recoveryPath,
    expectedDevice: lockPin ? lockPin.device.toString() : null,
    expectedInode: lockPin ? lockPin.inode.toString() : null,
    expectedToken: ownerState && ownerState.owner && ownerState.owner.token
      ? String(ownerState.owner.token)
      : null,
    reason: cause.message,
    detectedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(descriptor, record);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    syncDirectory(controlDir);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (error.code !== 'EEXIST') throw error;
  }
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  if (!entryExists(file)) {
    throw new Error(`${name} stale recovery fence publication failed`);
  }
}

function lockClaimPath(lockDir, purpose, lockPin, ownerState) {
  const ownerToken = ownerState.owner && typeof ownerState.owner.token === 'string'
    ? ownerState.owner.token
    : '';
  const ownerDigest = ownerState.exists
    ? crypto.createHash('sha256').update(ownerState.raw).digest('hex')
    : 'missing';
  const identity = [
    lockPin.device.toString(16),
    lockPin.inode.toString(16),
    ownerToken,
    ownerDigest,
  ].join(':');
  const claimId = crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 40);
  return `${lockDir}.${purpose}-${claimId}`;
}

function assertClaimedLock(
  controlDir,
  controlPin,
  claimedDir,
  lockPin,
  ownerState,
  name,
  phase
) {
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  assertPinnedDirectory(claimedDir, lockPin, `${name} lock ${phase}`, {
    allowMoved: true,
  });
  assertOwnerState(
    claimedDir,
    ownerState,
    `${name} lock ownership changed during ${phase}`
  );
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  assertPinnedDirectory(claimedDir, lockPin, `${name} lock ${phase}`, {
    allowMoved: true,
  });
}

function assertReleaseClaimOrFence(controlDir, controlPin, lockDir, tombstone,
  lockPin, ownerState, name) {
  try {
    assertClaimedLock(
      controlDir,
      controlPin,
      tombstone,
      lockPin,
      ownerState,
      name,
      'tombstone'
    );
  } catch (error) {
    publishRecoveryFence(
      controlDir,
      controlPin,
      lockDir,
      tombstone,
      lockPin,
      ownerState,
      name,
      error
    );
    throw new Error(`${name} lock recovery required after an ambiguous release claim`, {
      cause: error,
    });
  }
}

function moveIntentPath(lockDir) {
  return `${lockDir}.move-intent.json`;
}

function moveAuditDirectoryPath(lockDir) {
  return `${lockDir}.move-audit`;
}

function moveStagingDirectoryPath(lockDir) {
  return `${lockDir}.move-staging`;
}

function moveAuditPath(lockDir, intentId, outcome) {
  return path.join(
    moveAuditDirectoryPath(lockDir),
    `${outcome}-${intentId}.json`
  );
}

function inspectMoveAuditDirectory(controlDir, controlPin, lockDir, name, create) {
  const directory = moveAuditDirectoryPath(lockDir);
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  if (create) {
    try {
      fs.mkdirSync(directory);
      syncDirectory(controlDir);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } else if (!entryExists(directory)) {
    return null;
  }
  const pin = capturePinnedDirectory(directory, `${name} move audit directory`);
  if (normalizePath(path.dirname(pin.canonicalPath)) !== normalizePath(controlDir)) {
    throw new Error(`${name} move audit directory escaped its pinned control directory`);
  }
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  return { directory, pin };
}

function inspectMoveStagingDirectory(controlDir, controlPin, lockDir, name) {
  const directory = moveStagingDirectoryPath(lockDir);
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  try {
    fs.mkdirSync(directory);
    syncDirectory(controlDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const pin = capturePinnedDirectory(directory, `${name} move staging directory`);
  if (normalizePath(path.dirname(pin.canonicalPath)) !== normalizePath(controlDir)) {
    throw new Error(`${name} move staging directory escaped its pinned control directory`);
  }
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  return { directory, pin };
}

function publishCanonicalFromPrivateStage(
  controlDir,
  controlPin,
  lockDir,
  canonicalFile,
  raw,
  name,
  label,
  options = {}
) {
  const staging = inspectMoveStagingDirectory(
    controlDir,
    controlPin,
    lockDir,
    name
  );
  const stage = path.join(
    staging.directory,
    `${path.basename(canonicalFile)}.stage-${process.pid}-${crypto.randomBytes(16).toString('hex')}`
  );
  let descriptor = null;
  descriptor = fs.openSync(stage, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, raw);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  syncDirectory(staging.directory);
  const staged = readOptionalStableFile(stage, `${name} private ${label} stage`);
  if (!staged || !staged.raw.equals(raw) || staged.hash !== rawHash(raw)) {
    throw new Error(`${name} private ${label} stage differs after fsync`);
  }

  if (typeof options.assertTarget === 'function') options.assertTarget();
  let linked = false;
  try {
    fs.linkSync(stage, canonicalFile);
    linked = true;
    syncDirectory(path.dirname(canonicalFile));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (typeof options.assertTarget === 'function') options.assertTarget();
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);

  const readPublishedSnapshot = () => {
    let current = null;
    let readError = null;
    try {
      current = readOptionalStableFile(canonicalFile, `${name} canonical ${label}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      readError = error;
    }
    if (linked && !sameClaimedStableFile(current, staged)
        && typeof options.readRetiredPublication === 'function') {
      // Only exact retired evidence can explain a missing or newer canonical generation.
      const retired = options.readRetiredPublication(staged);
      if (retired) return retired;
    }
    if (readError) throw readError;
    return current;
  };
  const canonical = readPublishedSnapshot();
  if (!canonical || !canonical.raw.equals(raw) || canonical.hash !== staged.hash) {
    const error = new Error(`${name} canonical ${label} differs from its private stage`);
    if (!linked) error.code = 'EEXIST';
    throw error;
  }
  if (linked
      && (canonical.device !== staged.device || canonical.inode !== staged.inode)) {
    throw new Error(`${name} canonical ${label} was not linked from its private stage`);
  }
  if (!linked && !options.acceptEquivalentExisting) {
    const error = new Error(`${name} canonical ${label} already exists`);
    error.code = 'EEXIST';
    throw error;
  }

  // The random stage name is private to this publisher. Cleanup is best-effort;
  // an interrupted or ambiguous cleanup leaves cold evidence that is never read
  // as canonical state.
  try {
    const cleanupStage = readOptionalStableFile(stage, `${name} private ${label} stage`);
    if (cleanupStage
        && cleanupStage.raw.equals(raw)
        && (!linked
          || (cleanupStage.device === canonical.device
            && cleanupStage.inode === canonical.inode))) {
      fs.unlinkSync(stage);
      syncDirectory(staging.directory);
    }
  } catch (_) {
    // Retaining a private stage is safer than path-based cleanup after ambiguity.
  }
  assertPinnedDirectory(
    staging.directory,
    staging.pin,
    `${name} move staging directory`
  );
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  const finalCanonical = readPublishedSnapshot();
  if (!sameClaimedStableFile(finalCanonical, canonical)) {
    throw new Error(`${name} canonical ${label} changed during stage cleanup`);
  }
  return finalCanonical;
}

function ownerToken(ownerState) {
  return ownerState.owner && typeof ownerState.owner.token === 'string'
    ? ownerState.owner.token
    : null;
}

function staleGenerationMarkerPath(directory, transaction) {
  const intentHash = transaction.snapshot.hash.replace(/^sha256:/, '').slice(0, 16);
  return path.join(
    directory,
    `.stale-generation-${transaction.value.intentId}-${intentHash}.json`
  );
}

function staleGenerationMarkerRaw(transaction) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: STALE_GENERATION_MARKER_SCHEMA_VERSION,
    intentId: transaction.value.intentId,
    intentHash: transaction.snapshot.hash,
    sourceDevice: transaction.lockPin.device.toString(),
    sourceInode: transaction.lockPin.inode.toString(),
  }, null, 2)}\n`, 'utf8');
}

function assertStaleGenerationMarker(directory, transaction, name) {
  if (transaction.value.operation !== 'stale') return;
  const marker = readOptionalStableFile(
    staleGenerationMarkerPath(directory, transaction),
    `${name} stale generation marker`
  );
  if (!marker || !marker.raw.equals(staleGenerationMarkerRaw(transaction))) {
    throw new Error(`${name} stale generation marker does not match its move intent`);
  }
}

function ensureCommittedStaleGenerationMarker(
  controlDir,
  controlPin,
  lockDir,
  transaction,
  name
) {
  if (transaction.value.operation !== 'stale') return;
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  assertClaimedLock(
    controlDir,
    controlPin,
    transaction.destination,
    transaction.lockPin,
    transaction.ownerState,
    name,
    'before committed stale generation marker'
  );

  const file = staleGenerationMarkerPath(transaction.destination, transaction);
  const raw = staleGenerationMarkerRaw(transaction);
  const assertTarget = () => assertClaimedLock(
    controlDir,
    controlPin,
    transaction.destination,
    transaction.lockPin,
    transaction.ownerState,
    name,
    'during committed stale generation marker publication'
  );
  publishCanonicalFromPrivateStage(
    controlDir,
    controlPin,
    lockDir,
    file,
    raw,
    name,
    'stale generation marker',
    {
      acceptEquivalentExisting: true,
      assertTarget,
    }
  );
  assertTarget();
  assertStaleGenerationMarker(transaction.destination, transaction, name);
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
}

function createMoveIntentValue(controlDir, controlPin, lockDir, destination,
  lockPin, ownerState, name, operation) {
  const ownerRaw = ownerState.exists ? ownerState.raw : null;
  return {
    schemaVersion: MOVE_INTENT_SCHEMA_VERSION,
    intentId: crypto.randomBytes(16).toString('hex'),
    operation,
    name,
    creatorPid: process.pid,
    controlDirectory: path.resolve(controlDir),
    controlDevice: controlPin.device.toString(),
    controlInode: controlPin.inode.toString(),
    source: path.resolve(lockDir),
    destination: path.resolve(destination),
    sourceCanonicalPath: lockPin.canonicalPath,
    sourceDevice: lockPin.device.toString(),
    sourceInode: lockPin.inode.toString(),
    ownerExists: ownerState.exists,
    ownerRaw: ownerRaw ? ownerRaw.toString('base64') : null,
    ownerHash: ownerRaw ? rawHash(ownerRaw) : null,
    ownerToken: ownerToken(ownerState),
    createdAt: new Date().toISOString(),
  };
}

function parseMoveIntent(snapshot, controlDir, controlPin, lockDir, name) {
  let value;
  try {
    value = JSON.parse(snapshot.raw.toString('utf8'));
  } catch (error) {
    throw new Error(`${name} lock move intent JSON is invalid`, { cause: error });
  }
  if (!value || value.schemaVersion !== MOVE_INTENT_SCHEMA_VERSION
      || !/^[a-f0-9]{32}$/.test(value.intentId || '')
      || !['release', 'stale'].includes(value.operation)
      || value.name !== name
      || !Number.isInteger(value.creatorPid)
      || typeof value.controlDirectory !== 'string'
      || !/^\d+$/.test(value.controlDevice || '')
      || !/^[1-9]\d*$/.test(value.controlInode || '')
      || typeof value.source !== 'string'
      || typeof value.destination !== 'string'
      || typeof value.sourceCanonicalPath !== 'string'
      || !/^\d+$/.test(value.sourceDevice || '')
      || !/^[1-9]\d*$/.test(value.sourceInode || '')
      || typeof value.ownerExists !== 'boolean'
      || typeof value.createdAt !== 'string') {
    throw new Error(`${name} lock move intent schema is invalid`);
  }
  if (normalizePath(value.controlDirectory) !== normalizePath(controlDir)
      || BigInt(value.controlDevice) !== controlPin.device
      || BigInt(value.controlInode) !== controlPin.inode
      || normalizePath(value.source) !== normalizePath(lockDir)
      || normalizePath(path.dirname(value.destination)) !== normalizePath(controlDir)) {
    throw new Error(`${name} lock move intent escaped its pinned control generation`);
  }

  let raw = null;
  let owner = null;
  if (value.ownerExists) {
    if (typeof value.ownerRaw !== 'string'
        || typeof value.ownerHash !== 'string') {
      throw new Error(`${name} lock move intent owner proof is incomplete`);
    }
    raw = Buffer.from(value.ownerRaw, 'base64');
    if (rawHash(raw) !== value.ownerHash) {
      throw new Error(`${name} lock move intent owner hash is invalid`);
    }
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      owner = parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      owner = null;
    }
    if (ownerToken({ exists: true, raw, owner }) !== value.ownerToken) {
      throw new Error(`${name} lock move intent owner token is invalid`);
    }
  } else if (value.ownerRaw !== null || value.ownerHash !== null
      || value.ownerToken !== null) {
    throw new Error(`${name} lock move intent has unexpected owner proof`);
  }
  if (value.operation === 'release' && (!owner || value.ownerToken === null)) {
    throw new Error(`${name} release intent requires an exact owner token`);
  }

  const lockPin = {
    canonicalPath: value.sourceCanonicalPath,
    normalizedPath: normalizePath(value.sourceCanonicalPath),
    device: BigInt(value.sourceDevice),
    inode: BigInt(value.sourceInode),
  };
  const ownerState = {
    exists: value.ownerExists,
    raw,
    owner,
  };
  const expectedDestination = lockClaimPath(
    lockDir,
    value.operation,
    lockPin,
    ownerState
  );
  if (normalizePath(expectedDestination) !== normalizePath(value.destination)) {
    throw new Error(`${name} lock move intent destination is not generation-bound`);
  }
  return {
    value,
    raw: snapshot.raw,
    snapshot,
    lockPin,
    ownerState,
    destination: expectedDestination,
  };
}

function publishMoveIntent(controlDir, controlPin, lockDir, destination,
  lockPin, ownerState, name, operation) {
  const file = moveIntentPath(lockDir);
  const value = createMoveIntentValue(
    controlDir,
    controlPin,
    lockDir,
    destination,
    lockPin,
    ownerState,
    name,
    operation
  );
  const raw = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let snapshot;
  try {
    snapshot = publishCanonicalFromPrivateStage(
      controlDir,
      controlPin,
      lockDir,
      file,
      raw,
      name,
      'move intent',
      {
        readRetiredPublication: (staged) => {
          const transaction = parseMoveIntent(staged, controlDir, controlPin, lockDir, name);
          const audit = intentAuditState(controlDir, controlPin, lockDir, transaction, name);
          return audit ? audit.snapshot : null;
        },
      }
    );
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`${name} lock move operation is already in progress`, { cause: error });
    }
    if (entryExists(file)) {
      publishRecoveryFence(
        controlDir,
        controlPin,
        lockDir,
        file,
        lockPin,
        ownerState,
        name,
        error
      );
    }
    throw error;
  }
  return parseMoveIntent(snapshot, controlDir, controlPin, lockDir, name);
}

function readRetiredMoveIntent(controlDir, controlPin, lockDir, name, identity) {
  const auditDirectory = inspectMoveAuditDirectory(
    controlDir,
    controlPin,
    lockDir,
    name,
    false
  );
  if (!auditDirectory) return null;

  const matches = [];
  const auditNamePattern = /^(committed|aborted)-([a-f0-9]{32})\.json$/;
  for (const entry of fs.readdirSync(auditDirectory.directory, { withFileTypes: true })) {
    const match = auditNamePattern.exec(entry.name);
    if (!match) continue;
    const file = path.join(auditDirectory.directory, entry.name);
    let candidate;
    try {
      candidate = fs.lstatSync(file, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!candidate.isFile() || candidate.isSymbolicLink()
        || candidate.dev !== identity.device
        || candidate.ino !== identity.inode
        || candidate.size !== identity.size) {
      continue;
    }
    const snapshot = readOptionalStableFile(file, `${name} retired lock move intent`);
    if (!snapshot
        || snapshot.device !== identity.device
        || snapshot.inode !== identity.inode
        || snapshot.size !== identity.size) {
      continue;
    }
    const transaction = parseMoveIntent(snapshot, controlDir, controlPin, lockDir, name);
    if (transaction.value.intentId !== match[2]) {
      throw new Error(`${name} retired lock move intent audit name is invalid`);
    }
    matches.push({ outcome: match[1], transaction });
  }
  if (matches.length > 1) {
    throw new Error(`${name} retired lock move intent has multiple audit outcomes`);
  }
  assertPinnedDirectory(
    auditDirectory.directory,
    auditDirectory.pin,
    `${name} move audit directory`
  );
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  return matches.length === 1 ? matches[0] : null;
}

function readMoveIntent(controlDir, controlPin, lockDir, name) {
  const file = moveIntentPath(lockDir);
  let snapshot;
  try {
    snapshot = readOptionalStableFile(file, `${name} lock move intent`);
    return snapshot ? parseMoveIntent(snapshot, controlDir, controlPin, lockDir, name) : null;
  } catch (error) {
    let failure = error;
    if (error.code === 'ENOENT' && error.stableFileIdentity) {
      try {
        const retired = readRetiredMoveIntent(
          controlDir,
          controlPin,
          lockDir,
          name,
          error.stableFileIdentity
        );
        if (retired) {
          return {
            ...retired.transaction,
            retiredAuditOutcome: retired.outcome,
          };
        }
      } catch (auditError) {
        failure = auditError;
      }
    }
    publishRecoveryFence(
      controlDir,
      controlPin,
      lockDir,
      file,
      null,
      null,
      name,
      failure
    );
    throw new Error(`${name} lock recovery required for an invalid move intent`, {
      cause: failure,
    });
  }
}

function generationState(controlDir, controlPin, file, transaction, name, phase) {
  if (!entryExists(file)) return 'absent';
  try {
    assertClaimedLock(
      controlDir,
      controlPin,
      file,
      transaction.lockPin,
      transaction.ownerState,
      name,
      phase
    );
    return 'exact';
  } catch (_) {
    return 'foreign';
  }
}

function inspectMoveState(controlDir, controlPin, lockDir, transaction, name) {
  let source = generationState(
    controlDir,
    controlPin,
    lockDir,
    transaction,
    name,
    'move source'
  );
  const destination = generationState(
    controlDir,
    controlPin,
    transaction.destination,
    transaction,
    name,
    'move destination'
  );
  // A peer can rename between these snapshots; recheck before declaring a collision.
  if (source === 'exact' && destination === 'exact') {
    source = generationState(
      controlDir, controlPin, lockDir, transaction, name, 'move source after destination'
    );
  }
  return { source, destination };
}

function intentAuditState(controlDir, controlPin, lockDir, transaction, name) {
  const auditDirectory = inspectMoveAuditDirectory(
    controlDir,
    controlPin,
    lockDir,
    name,
    false
  );
  if (!auditDirectory) return null;
  const results = [];
  for (const outcome of ['committed', 'aborted']) {
    const file = moveAuditPath(lockDir, transaction.value.intentId, outcome);
    const snapshot = readOptionalStableFile(file, `${name} lock move audit`);
    if (snapshot) results.push({ outcome, file, snapshot });
  }
  if (results.length > 1) {
    throw new Error(`${name} lock move intent has multiple audit outcomes`);
  }
  if (results.length === 1
      && (!results[0].snapshot.raw.equals(transaction.raw)
        || results[0].snapshot.device !== transaction.snapshot.device
        || results[0].snapshot.inode !== transaction.snapshot.inode)) {
    throw new Error(`${name} lock move audit captured a foreign intent`);
  }
  assertPinnedDirectory(
    auditDirectory.directory,
    auditDirectory.pin,
    `${name} move audit directory`
  );
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  return results[0] || null;
}

function archiveMoveIntent(controlDir, controlPin, lockDir, transaction, name, outcome) {
  const file = moveIntentPath(lockDir);
  const auditDirectory = inspectMoveAuditDirectory(
    controlDir,
    controlPin,
    lockDir,
    name,
    true
  );
  const audit = moveAuditPath(lockDir, transaction.value.intentId, outcome);
  const existingAudit = intentAuditState(
    controlDir,
    controlPin,
    lockDir,
    transaction,
    name
  );
  if (existingAudit) {
    const currentLive = readOptionalStableFile(file, `${name} lock move intent`);
    if (existingAudit.outcome !== outcome
        || (currentLive && currentLive.raw.equals(transaction.raw))) {
      throw new Error(`${name} lock move audit outcome is ambiguous`);
    }
    return existingAudit;
  }
  const live = readOptionalStableFile(file, `${name} lock move intent`);
  if (!sameStableFile(live, transaction.snapshot)) {
    const racedAudit = intentAuditState(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name
    );
    if (racedAudit
        && racedAudit.outcome === outcome
        && (!live || !live.raw.equals(transaction.raw))) {
      return racedAudit;
    }
    throw new Error(`${name} lock move intent changed before audit publication`);
  }
  assertPinnedDirectory(
    auditDirectory.directory,
    auditDirectory.pin,
    `${name} move audit directory`
  );
  try {
    fs.renameSync(file, audit);
    syncDirectory(auditDirectory.directory);
    syncDirectory(controlDir);
  } catch (error) {
    const afterLive = readOptionalStableFile(file, `${name} lock move intent`);
    const afterAudit = readOptionalStableFile(audit, `${name} lock move audit`);
    if ((afterLive && afterLive.raw.equals(transaction.raw))
        || !sameClaimedStableFile(afterAudit, transaction.snapshot)) {
      throw error;
    }
  }
  const committedAudit = readOptionalStableFile(audit, `${name} lock move audit`);
  const finalLive = readOptionalStableFile(file, `${name} lock move intent`);
  if (!sameClaimedStableFile(committedAudit, transaction.snapshot)
      || (finalLive && finalLive.raw.equals(transaction.raw))) {
    throw new Error(`${name} lock move audit publication is ambiguous`);
  }
  assertPinnedDirectory(
    auditDirectory.directory,
    auditDirectory.pin,
    `${name} move audit directory`
  );
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  return { outcome, file: audit, snapshot: committedAudit };
}

function failMoveIntent(controlDir, controlPin, lockDir, transaction, name, message, cause) {
  const error = cause instanceof Error ? cause : new Error(message);
  publishRecoveryFence(
    controlDir,
    controlPin,
    lockDir,
    transaction ? transaction.destination : moveIntentPath(lockDir),
    transaction ? transaction.lockPin : null,
    transaction ? transaction.ownerState : null,
    name,
    error
  );
  throw new Error(`${name} lock recovery required: ${message}`, { cause: error });
}

function finishCommittedMove(controlDir, controlPin, lockDir, transaction, name, message) {
  try {
    ensureCommittedStaleGenerationMarker(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name
    );
    archiveMoveIntent(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name,
      'committed'
    );
  } catch (error) {
    failMoveIntent(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name,
      message,
      error
    );
  }
  return { status: 'committed', operation: transaction.value.operation };
}

function reconcileMoveIntent(controlDir, controlPin, lockDir, name, options = {}, expected = null) {
  let transaction = readMoveIntent(controlDir, controlPin, lockDir, name);
  if (!transaction) {
    if (!expected) return { status: 'clean', operation: null };
    try {
      const audit = intentAuditState(
        controlDir,
        controlPin,
        lockDir,
        expected,
        name
      );
      if (audit) return { status: audit.outcome, operation: expected.value.operation };
    } catch (error) {
      failMoveIntent(
        controlDir,
        controlPin,
        lockDir,
        expected,
        name,
        'move audit differs from the expected intent',
        error
      );
    }
    failMoveIntent(
      controlDir,
      controlPin,
      lockDir,
      expected,
      name,
      'expected move intent disappeared without audit evidence'
    );
  }
  if (expected && !sameStableFile(transaction.snapshot, expected.snapshot)) {
    try {
      const audit = intentAuditState(
        controlDir,
        controlPin,
        lockDir,
        expected,
        name
      );
      if (audit) return { status: audit.outcome, operation: expected.value.operation };
    } catch (error) {
      failMoveIntent(
        controlDir,
        controlPin,
        lockDir,
        expected,
        name,
        'move audit differs from the expected intent',
        error
      );
    }
    failMoveIntent(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name,
      'live move intent differs from its creator proof'
    );
  }

  if (transaction.retiredAuditOutcome) {
    let audit;
    try {
      audit = intentAuditState(
        controlDir,
        controlPin,
        lockDir,
        transaction,
        name
      );
    } catch (error) {
      failMoveIntent(
        controlDir,
        controlPin,
        lockDir,
        transaction,
        name,
        'retired move audit differs from the recovered intent',
        error
      );
    }
    if (!audit || audit.outcome !== transaction.retiredAuditOutcome) {
      failMoveIntent(
        controlDir,
        controlPin,
        lockDir,
        transaction,
        name,
        'retired move intent lost its exact terminal audit'
      );
    }
    if (audit.outcome === 'committed') {
      return finishCommittedMove(
        controlDir,
        controlPin,
        lockDir,
        transaction,
        name,
        'committed retired move intent could not be verified'
      );
    }
    return { status: 'aborted', operation: transaction.value.operation };
  }

  const owned = Boolean(expected
    && transaction.value.intentId === expected.value.intentId);
  let state = inspectMoveState(controlDir, controlPin, lockDir, transaction, name);
  if (state.destination === 'foreign') {
    failMoveIntent(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name,
      'move destination contains a foreign generation'
    );
  }
  if (state.destination === 'exact') {
    if (state.source === 'exact') {
      failMoveIntent(
        controlDir,
        controlPin,
        lockDir,
        transaction,
        name,
        'move source and destination both contain the recorded generation'
      );
    }
    return finishCommittedMove(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name,
      'committed move intent could not be archived'
    );
  }
  if (state.source !== 'exact') {
    failMoveIntent(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name,
      state.source === 'absent'
        ? 'move source and destination are both absent'
        : 'move source contains a foreign generation without its destination'
    );
  }

  const alive = options.isProcessAlive || isProcessAlive;
  if (!owned && alive(transaction.value.creatorPid)) {
    throw new Error(`${name} lock operation in progress: move intent is active`);
  }

  const live = readMoveIntent(controlDir, controlPin, lockDir, name);
  if (!live || !sameStableFile(live.snapshot, transaction.snapshot)) {
    failMoveIntent(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name,
      'move intent changed before generation rename'
    );
  }
  state = inspectMoveState(controlDir, controlPin, lockDir, transaction, name);
  if (state.destination === 'exact' && state.source !== 'exact') {
    return finishCommittedMove(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name,
      'peer-completed move intent could not be archived'
    );
  }
  if (state.source !== 'exact' || state.destination !== 'absent') {
    failMoveIntent(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name,
      'move generation changed before rename'
    );
  }

  let renameError = null;
  try {
    fs.renameSync(lockDir, transaction.destination);
    syncDirectory(controlDir);
  } catch (error) {
    renameError = error;
  }
  state = inspectMoveState(controlDir, controlPin, lockDir, transaction, name);
  if (state.destination === 'exact' && state.source !== 'exact') {
    return finishCommittedMove(
      controlDir,
      controlPin,
      lockDir,
      transaction,
      name,
      'completed move intent could not be archived'
    );
  }
  if (state.source === 'exact' && state.destination === 'absent' && renameError) {
    try {
      archiveMoveIntent(
        controlDir,
        controlPin,
        lockDir,
        transaction,
        name,
        'aborted'
      );
    } catch (error) {
      failMoveIntent(
        controlDir,
        controlPin,
        lockDir,
        transaction,
        name,
        'uncommitted move intent could not be archived',
        error
      );
    }
    return {
      status: 'aborted',
      operation: transaction.value.operation,
      error: renameError,
    };
  }
  failMoveIntent(
    controlDir,
    controlPin,
    lockDir,
    transaction,
    name,
    'generation rename reached an unknown terminal state',
    renameError
  );
}

function recoverLock(controlDir, controlPin, lockDir, lockPin, ownerState, name, options) {
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);
  assertPinnedDirectory(lockDir, lockPin, `${name} lock directory`);
  assertOwnerState(
    lockDir,
    ownerState,
    `${name} lock ownership changed before stale recovery`
  );
  assertPinnedDirectory(lockDir, lockPin, `${name} lock directory`);
  assertPinnedDirectory(controlDir, controlPin, `${name} control directory`);

  const recoveryPath = lockClaimPath(lockDir, 'stale', lockPin, ownerState);
  if (entryExists(recoveryPath)) {
    throw new Error(`${name} stale lock tombstone already exists`);
  }
  const transaction = publishMoveIntent(
    controlDir,
    controlPin,
    lockDir,
    recoveryPath,
    lockPin,
    ownerState,
    name,
    'stale'
  );
  const result = reconcileMoveIntent(
    controlDir,
    controlPin,
    lockDir,
    name,
    options,
    transaction
  );
  if (result.status !== 'committed') throw result.error;
  return recoveryPath;
}

function acquireRunLock(runDir, name, metadata = {}, options = {}) {
  assertLockName(name);
  let controlDir;
  try {
    controlDir = controlStore.ensureControlRunDir(runDir, options);
  } catch (error) {
    throw new Error(
      `failed to initialize external control store for ${name} lock: ${error.message}`
    );
  }
  const fixedControlDir = fs.realpathSync.native(path.resolve(controlDir));
  const controlPin = capturePinnedDirectory(fixedControlDir, `${name} control directory`);
  const lockDir = lockPathInControlDir(fixedControlDir, name);
  assertNoRecoveryFence(lockDir, name);
  assertAuthority(runDir, controlDir, options);
  const initialMoveRecovery = reconcileMoveIntent(
    fixedControlDir,
    controlPin,
    lockDir,
    name,
    options
  );
  assertNoRecoveryFence(lockDir, name);
  const token = crypto.randomBytes(16).toString('hex');
  const owner = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    name,
    token,
    pid: Number.isInteger(metadata.pid) ? metadata.pid : process.pid,
    command: metadata.command ? String(metadata.command) : null,
    runId: metadata.runId ? String(metadata.runId) : null,
    acquiredAt: metadata.now || new Date().toISOString(),
  };
  const ownerRaw = Buffer.from(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  let recovered = initialMoveRecovery.status === 'committed'
    && initialMoveRecovery.operation === 'stale';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      assertNoRecoveryFence(lockDir, name);
      assertAuthority(runDir, controlDir, options);
      assertPinnedDirectory(fixedControlDir, controlPin, `${name} control directory`);
      // Release tombstones are immutable evidence. Reusing a directory through
      // path-only rename cannot distinguish committed-EIO from a concurrent
      // winner on every filesystem, and POSIX may replace an empty destination.
      fs.mkdirSync(lockDir);
      created = true;
      const lockPin = capturePinnedDirectory(lockDir, `${name} lock directory`);
      assertAuthority(runDir, lockDir, options);
      assertPinnedDirectory(fixedControlDir, controlPin, `${name} control directory`);
      fs.writeFileSync(ownerPath(lockDir), ownerRaw, {
        flag: 'wx',
      });
      assertPinnedDirectory(fixedControlDir, controlPin, `${name} control directory`);
      assertPinnedDirectory(lockDir, lockPin, `${name} lock directory`);
      const ownerState = readOwnerState(lockDir);
      if (!ownerState.exists || !ownerState.raw.equals(ownerRaw)) {
        throw new Error(`${name} lock ownership changed during acquisition`);
      }
      assertPinnedDirectory(lockDir, lockPin, `${name} lock directory`);
      const tombstone = lockClaimPath(lockDir, 'release', lockPin, ownerState);

      let released = false;
      let releaseTransaction = null;
      return {
        lockDir,
        owner,
        recovered,
        release() {
          if (released) return false;
          assertPinnedDirectory(fixedControlDir, controlPin, `${name} control directory`);

          if (releaseTransaction) {
            const resumed = reconcileMoveIntent(
              fixedControlDir,
              controlPin,
              lockDir,
              name,
              options,
              releaseTransaction
            );
            if (resumed.status === 'committed') {
              released = true;
              return true;
            }
            releaseTransaction = null;
            throw resumed.error;
          }

          // A prior rename may have committed even when renameSync surfaced an
          // I/O error. The identity-bound tombstone is the durable completion
          // record for this handle; validating it makes a later retry safe.
          if (entryExists(tombstone)) {
            assertReleaseClaimOrFence(
              fixedControlDir,
              controlPin,
              lockDir,
              tombstone,
              lockPin,
              ownerState,
              name
            );
            released = true;
            return true;
          }

          assertPinnedDirectory(lockDir, lockPin, `${name} lock directory`);
          const current = readOwnerState(lockDir);
          if (!current.exists || !current.owner) {
            throw new Error(`${name} lock owner metadata is missing during release`);
          }
          if (current.owner.token !== token || !sameOwnerState(current, ownerState)) {
            throw new Error(`${name} lock ownership changed before release`);
          }
          assertPinnedDirectory(fixedControlDir, controlPin, `${name} control directory`);
          assertPinnedDirectory(lockDir, lockPin, `${name} lock directory`);
          assertOwnerState(
            lockDir,
            ownerState,
            `${name} lock ownership changed before release`
          );
          if (entryExists(tombstone)) {
            throw new Error(`${name} lock release tombstone already exists`);
          }
          releaseTransaction = publishMoveIntent(
            fixedControlDir,
            controlPin,
            lockDir,
            tombstone,
            lockPin,
            ownerState,
            name,
            'release'
          );
          const result = reconcileMoveIntent(
            fixedControlDir,
            controlPin,
            lockDir,
            name,
            options,
            releaseTransaction
          );
          if (result.status !== 'committed') {
            releaseTransaction = null;
            throw result.error;
          }
          released = true;
          return true;
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST' || created) throw error;
      assertAuthority(runDir, lockDir, options);
      assertPinnedDirectory(fixedControlDir, controlPin, `${name} control directory`);
      const stalePin = capturePinnedDirectory(lockDir, `${name} lock directory`);
      const staleOwnerState = readOwnerState(lockDir);
      assertPinnedDirectory(lockDir, stalePin, `${name} lock directory`);
      assertOwnerState(
        lockDir,
        staleOwnerState,
        `${name} lock ownership changed while checking staleness`
      );
      if (!canRecover(lockDir, staleOwnerState.owner, options)) {
        const ownerSummary = staleOwnerState.owner && staleOwnerState.owner.pid
          ? ` by pid ${staleOwnerState.owner.pid}`
          : '';
        throw new Error(`${name} lock is active${ownerSummary}`);
      }
      recoverLock(
        fixedControlDir,
        controlPin,
        lockDir,
        stalePin,
        staleOwnerState,
        name,
        options
      );
      recovered = true;
    }
  }

  throw new Error(`failed to acquire ${name} lock after stale recovery`);
}

function withRunLock(runDir, name, metadata, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('run lock callback is required');
  const lock = acquireRunLock(runDir, name, metadata, options);
  try {
    return callback(lock);
  } finally {
    lock.release();
  }
}

module.exports = {
  LOCK_SCHEMA_VERSION,
  UNKNOWN_OWNER_STALE_MS,
  acquireRunLock,
  isProcessAlive,
  lockPath,
  readOwner,
  withRunLock,
};
