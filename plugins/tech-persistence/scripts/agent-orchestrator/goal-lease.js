'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const controlStore = require('./control-store');
const runLock = require('./run-lock');

const GOAL_LEASE_FILE = 'goal-lease.json';
const GOAL_LEASE_TRANSACTION_FILE = 'goal-lease.txn.json';
const GOAL_LEASE_TRANSACTION_SCHEMA = 'native-goal-lease-transaction-v1';
const GOAL_LEASE_LAYOUT_FILE = 'goal-lease.layout-v2.json';
const GOAL_LEASE_LAYOUT_SCHEMA = 'native-goal-lease-layout-v2';
const GOAL_LEASE_AUDIT_DIR = 'goal-lease.audit-v2';
const GOAL_LEASE_AUDIT_SCHEMA = 'native-goal-lease-audit-generation-v1';
const GOAL_LEASE_FENCE_GENERATION_SCHEMA = 'native-goal-lease-fence-generation-v1';
const GOAL_LEASE_CLAIM_SCHEMA = 'native-goal-lease-private-claim-v1';
const GOAL_LEASE_ABORTED_STAGE_SCHEMA = 'native-goal-lease-aborted-staging-v1';
const RUNTIMES = new Set(['codex', 'claude']);

// Security boundary: controlRoot is owned by the runtime principal, lives
// outside every provider workspace, and is writable only by coordinated
// authority-side collaborators. Private 0700 generations prevent predictable
// destination replacement; they do not claim to defend against a hostile
// process already running as that same authority principal.

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

function readOptionalRawSnapshot(file) {
  let before;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.ino === 0n) {
    throw new Error(`Goal lease transaction encountered an unsafe file: ${file}`);
  }
  const raw = fs.readFileSync(file);
  const after = fs.lstatSync(file, { bigint: true });
  if (!sameFileSnapshotIdentity(before, after) || BigInt(raw.length) !== after.size) {
    throw new Error(`Goal lease transaction file changed during read: ${file}`);
  }
  return {
    raw,
    hash: rawHash(raw),
    device: after.dev.toString(),
    inode: after.ino.toString(),
    size: after.size.toString(),
    mtimeNs: after.mtimeNs.toString(),
    ctimeNs: after.ctimeNs.toString(),
  };
}

function sameRawSnapshot(left, right) {
  return Boolean(left && right)
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.raw.equals(right.raw);
}

function sameClaimedFile(left, right) {
  return Boolean(left && right)
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.raw.equals(right.raw);
}

function syncPinnedRawFile(file, expected, label) {
  const before = readOptionalRawSnapshot(file);
  if (!sameClaimedFile(before, expected)) {
    throw new Error(`${label} changed before data sync`);
  }
  // Windows FlushFileBuffers requires a writable handle; POSIX can fsync a
  // read-only no-follow descriptor without granting a mutation window.
  let flags = process.platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
  if (process.platform !== 'win32' && Number.isInteger(fs.constants.O_NOFOLLOW)) {
    flags |= fs.constants.O_NOFOLLOW;
  }
  const descriptor = fs.openSync(file, flags);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
        || opened.dev.toString() !== expected.device
        || opened.ino.toString() !== expected.inode
        || opened.size.toString() !== expected.size) {
      throw new Error(`${label} identity changed before data sync`);
    }
    fs.fsyncSync(descriptor);
    const synced = fs.fstatSync(descriptor, { bigint: true });
    if (!synced.isFile()
        || synced.dev.toString() !== expected.device
        || synced.ino.toString() !== expected.inode
        || synced.size.toString() !== expected.size) {
      throw new Error(`${label} identity changed during data sync`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const after = readOptionalRawSnapshot(file);
  if (!sameClaimedFile(after, expected)) {
    throw new Error(`${label} bytes changed during data sync`);
  }
  return after;
}

function readOptionalRaw(file) {
  const snapshot = readOptionalRawSnapshot(file);
  return snapshot ? snapshot.raw : null;
}

function serializeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function syncRenameDirectories(source, destination, generationParent = null) {
  const sourceDirectory = path.dirname(source);
  const destinationDirectory = path.dirname(destination);
  syncDirectory(sourceDirectory);
  if (path.resolve(destinationDirectory) !== path.resolve(sourceDirectory)) {
    syncDirectory(destinationDirectory);
  }
  if (generationParent) syncDirectory(generationParent);
}

function writeRawAtomic(file, raw, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor = null;
  try {
    if (typeof options.beforeWrite === 'function') options.beforeWrite();
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, raw);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (typeof options.beforeWrite === 'function') options.beforeWrite();
    fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function publishRawExclusive(file, raw, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor = null;
  try {
    if (typeof options.beforeWrite === 'function') options.beforeWrite();
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, raw);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (typeof options.beforeWrite === 'function') options.beforeWrite();
    try {
      fs.linkSync(temp, file);
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        throw new Error(`goal lease transaction recovery required: ${file}`, { cause: error });
      }
      throw error;
    }
    if (typeof options.afterPublish === 'function') options.afterPublish();
    syncDirectory(path.dirname(file));
    if (!fs.readFileSync(file).equals(raw)) {
      throw new Error('published Goal lease transaction fence changed unexpectedly');
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function captureDirectoryIdentity(directory, label) {
  const canonicalDirectory = fs.realpathSync.native(path.resolve(directory));
  const stat = fs.lstatSync(canonicalDirectory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) {
    throw new Error(`${label} must resolve to an identity-bearing ordinary directory`);
  }
  return {
    directory: canonicalDirectory,
    canonicalDirectory: controlStore.canonicalPotentialPath(canonicalDirectory),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
}

function sameDirectoryIdentity(left, right) {
  return left.canonicalDirectory === right.canonicalDirectory
    && left.device === right.device
    && left.inode === right.inode;
}

function assertPinnedDirectory(pin, label) {
  let current;
  try {
    current = captureDirectoryIdentity(pin.directory, label);
  } catch (error) {
    throw new Error(`${label} identity changed: ${error.message}`, { cause: error });
  }
  if (!sameDirectoryIdentity(current, pin)) {
    throw new Error(`${label} identity changed`);
  }
  return current;
}

function securePrivateDirectory(directory, parentPin, label) {
  assertPinnedDirectory(parentPin, `${label} parent directory`);
  let lexical;
  try {
    lexical = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    throw new Error(`${label} cannot be inspected safely: ${error.message}`, {
      cause: error,
    });
  }
  if (!lexical.isDirectory() || lexical.isSymbolicLink() || lexical.ino === 0n) {
    throw new Error(`${label} must be an ordinary directory, not a symbolic link or reparse point`);
  }
  const pin = captureDirectoryIdentity(directory, label);
  if (path.dirname(pin.canonicalDirectory) !== parentPin.canonicalDirectory
      || pin.device !== lexical.dev.toString()
      || pin.inode !== lexical.ino.toString()) {
    throw new Error(`${label} escaped its pinned parent directory`);
  }
  assertPinnedDirectory(parentPin, `${label} parent directory`);

  // POSIX can bind the permission change to the already-opened directory.
  // Windows mode bits do not provide the ACL boundary and opening directories
  // this way is not portable, so the independently ACL-protected controlRoot
  // remains the security boundary there.
  if (process.platform !== 'win32'
      && Number.isInteger(fs.constants.O_NOFOLLOW)
      && Number.isInteger(fs.constants.O_DIRECTORY)) {
    const descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY
    );
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory()
          || opened.dev.toString() !== pin.device
          || opened.ino.toString() !== pin.inode) {
        throw new Error(`${label} changed before permission hardening`);
      }
      fs.fchmodSync(descriptor, 0o700);
      const hardened = fs.fstatSync(descriptor, { bigint: true });
      if (hardened.dev.toString() !== pin.device
          || hardened.ino.toString() !== pin.inode) {
        throw new Error(`${label} changed during permission hardening`);
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }
  assertPinnedDirectory(parentPin, `${label} parent directory`);
  assertPinnedDirectory(pin, label);
  return pin;
}

function ensurePrivateDirectory(directory, parentPin, label) {
  assertPinnedDirectory(parentPin, `${label} parent directory`);
  let existing = null;
  try {
    existing = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(`${label} must not be a symbolic link or reparse point`);
  }
  if (!existing) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
  }
  const pin = securePrivateDirectory(directory, parentPin, label);
  // A synced child does not persist its name in the parent on POSIX.
  if (!existing) syncDirectory(parentPin.directory);
  assertPinnedDirectory(parentPin, `${label} parent directory`);
  return pin;
}

function createPrivateGeneration(parentPin, label) {
  assertPinnedDirectory(parentPin, `${label} parent directory`);
  const generation = fs.mkdtempSync(path.join(parentPin.directory, 'generation-'));
  const pin = securePrivateDirectory(generation, parentPin, label);
  // Persist the destination directory before any unique evidence is moved into it.
  syncDirectory(parentPin.directory);
  assertPinnedDirectory(parentPin, `${label} parent directory`);
  assertPinnedDirectory(pin, label);
  return pin;
}

function resolveProjectionTarget(runDir) {
  if (!String(runDir || '').trim()) throw new Error('goal lease runDir is required');
  const identity = captureDirectoryIdentity(
    path.resolve(String(runDir)),
    'goal lease projection target'
  );
  return {
    ...identity,
    file: path.join(identity.directory, GOAL_LEASE_FILE),
    canonicalRunDirAtCreation: controlStore.canonicalRunDir(identity.directory),
  };
}

function prepareProjectionTarget(runDir) {
  const resolved = path.resolve(String(runDir || ''));
  if (!String(runDir || '').trim()) throw new Error('goal lease runDir is required');
  fs.mkdirSync(resolved, { recursive: true });
  return resolveProjectionTarget(resolved);
}

function controlBindingSnapshot(binding) {
  return {
    schemaVersion: binding.schemaVersion,
    controlKey: binding.controlKey,
    runLocator: binding.runLocator,
    canonicalRunDirAtCreation: binding.canonicalRunDirAtCreation,
    runIdentity: binding.runIdentity,
  };
}

function sameControlBinding(left, right) {
  return left.schemaVersion === right.schemaVersion
    && left.controlKey === right.controlKey
    && left.runLocator === right.runLocator
    && left.canonicalRunDirAtCreation === right.canonicalRunDirAtCreation
    && left.runIdentity === right.runIdentity;
}

function captureGoalReadBinding(runDir, options = {}) {
  const binding = controlBindingSnapshot(
    controlStore.readControlRunBinding(runDir, options)
  );
  const runTarget = resolveProjectionTarget(runDir);
  if (binding.canonicalRunDirAtCreation !== runTarget.canonicalRunDirAtCreation) {
    throw new Error('goal lease read binding does not match the current run identity');
  }
  return { binding, runTarget };
}

function assertGoalReadBinding(runDir, options, expected) {
  const current = captureGoalReadBinding(runDir, options);
  if (!sameControlBinding(current.binding, expected.binding)
      || !sameDirectoryIdentity(current.runTarget, expected.runTarget)
      || current.runTarget.canonicalRunDirAtCreation
        !== expected.runTarget.canonicalRunDirAtCreation) {
    throw new Error('goal lease read binding changed during authority read');
  }
  return current;
}

function assertProjectionTargetBinding(runDir, target, options, expectedBinding = null) {
  let current;
  let fixed;
  try {
    current = resolveProjectionTarget(runDir);
    fixed = resolveProjectionTarget(target.directory);
  } catch (error) {
    throw new Error(
      `goal lease projection target changed before authoritative commit: ${error.message}`,
      { cause: error }
    );
  }
  if (!sameDirectoryIdentity(current, target)
      || !sameDirectoryIdentity(fixed, target)
      || current.canonicalRunDirAtCreation !== target.canonicalRunDirAtCreation
      || fixed.canonicalRunDirAtCreation !== target.canonicalRunDirAtCreation) {
    throw new Error('goal lease projection target changed before authoritative commit');
  }
  const binding = controlBindingSnapshot(controlStore.readControlRunBinding(runDir, options));
  if (binding.canonicalRunDirAtCreation !== target.canonicalRunDirAtCreation) {
    throw new Error('goal lease projection target does not match its authoritative control binding');
  }
  if (expectedBinding && !sameControlBinding(binding, expectedBinding)) {
    throw new Error('goal lease authoritative control binding changed before commit');
  }
  return binding;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function encodeRaw(raw) {
  return raw === null ? null : raw.toString('base64');
}

function decodeBoundRaw(encoded, hash, label) {
  if (encoded === null) {
    if (hash !== null) throw new Error(`${label} hash must be null when raw bytes are absent`);
    return null;
  }
  if (typeof encoded !== 'string') throw new Error(`${label} must be base64 or null`);
  const raw = Buffer.from(encoded, 'base64');
  if (raw.toString('base64') !== encoded) throw new Error(`${label} is not canonical base64`);
  if (rawHash(raw) !== assertDigest(hash, `${label} hash`)) {
    throw new Error(`${label} hash does not match its raw bytes`);
  }
  return raw;
}

function createGoalLeaseTransaction(binding, target, beforeAuthority, afterAuthority,
  beforeProjection, afterProjection) {
  return {
    schemaVersion: GOAL_LEASE_TRANSACTION_SCHEMA,
    transactionId: crypto.randomBytes(16).toString('hex'),
    authorityFile: GOAL_LEASE_FILE,
    binding,
    beforeRaw: encodeRaw(beforeAuthority),
    beforeHash: beforeAuthority === null ? null : rawHash(beforeAuthority),
    afterHash: rawHash(afterAuthority),
    projection: {
      directory: target.directory,
      canonicalRunDirAtCreation: target.canonicalRunDirAtCreation,
      canonicalDirectory: target.canonicalDirectory,
      device: target.device,
      inode: target.inode,
      beforeRaw: encodeRaw(beforeProjection),
      beforeHash: beforeProjection === null ? null : rawHash(beforeProjection),
      afterHash: rawHash(afterProjection),
    },
    createdAt: new Date().toISOString(),
  };
}

function parseGoalLeaseTransaction(raw) {
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`Goal lease transaction fence is invalid JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!value || value.schemaVersion !== GOAL_LEASE_TRANSACTION_SCHEMA
      || typeof value.transactionId !== 'string'
      || !/^[a-f0-9]{32}$/.test(value.transactionId)
      || value.authorityFile !== GOAL_LEASE_FILE
      || !value.binding || typeof value.binding !== 'object'
      || !value.projection || typeof value.projection !== 'object') {
    throw new Error('Goal lease transaction fence schema is invalid');
  }
  const binding = controlBindingSnapshot(value.binding);
  if (Object.values(binding).some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error('Goal lease transaction control binding is invalid');
  }
  if (!path.isAbsolute(value.projection.directory)
      || typeof value.projection.canonicalRunDirAtCreation !== 'string'
      || typeof value.projection.canonicalDirectory !== 'string'
      || !/^\d+$/.test(String(value.projection.device || ''))
      || !/^[1-9]\d*$/.test(String(value.projection.inode || ''))) {
    throw new Error('Goal lease transaction projection identity is invalid');
  }
  const beforeAuthority = decodeBoundRaw(value.beforeRaw, value.beforeHash, 'beforeRaw');
  const beforeProjection = decodeBoundRaw(
    value.projection.beforeRaw,
    value.projection.beforeHash,
    'projection.beforeRaw'
  );
  assertDigest(value.afterHash, 'afterHash');
  assertDigest(value.projection.afterHash, 'projection.afterHash');
  return {
    value,
    binding,
    beforeAuthority,
    beforeProjection,
  };
}

function transactionPath(controlDir) {
  return path.join(controlDir, GOAL_LEASE_TRANSACTION_FILE);
}

function layoutPath(controlDir) {
  return path.join(controlDir, GOAL_LEASE_LAYOUT_FILE);
}

function auditPath(controlDir) {
  return path.join(controlDir, GOAL_LEASE_AUDIT_DIR);
}

function parseLayoutMarker(raw) {
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`Goal lease layout marker is invalid JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!value || value.schemaVersion !== GOAL_LEASE_LAYOUT_SCHEMA
      || !['clean', 'live'].includes(value.status)
      || typeof value.epoch !== 'string'
      || !/^[a-f0-9]{32}$/.test(value.epoch)
      || (value.status === 'live' && (
        typeof value.transactionId !== 'string'
        || !/^[a-f0-9]{32}$/.test(value.transactionId)
      ))
      || (value.status === 'clean' && value.transactionId !== null)) {
    throw new Error('Goal lease layout marker schema is invalid');
  }
  return value;
}

function readLayoutMarkerSnapshot(controlDir) {
  const snapshot = readOptionalRawSnapshot(layoutPath(controlDir));
  if (!snapshot) return null;
  return { snapshot, value: parseLayoutMarker(snapshot.raw) };
}

function assertLiveMarkerTransaction(marker, transactionId) {
  if (marker && marker.value.status === 'live'
      && marker.value.transactionId !== transactionId) {
    throw new Error('Goal lease live marker identifies a different transaction');
  }
}

function writeLayoutMarker(controlDir, controlPin, status, transactionId = null) {
  const markerFile = layoutPath(controlDir);
  assertPinnedControlFile(controlPin, markerFile, 'Goal lease layout marker');
  const value = {
    schemaVersion: GOAL_LEASE_LAYOUT_SCHEMA,
    status,
    epoch: crypto.randomBytes(16).toString('hex'),
    transactionId: status === 'live' ? transactionId : null,
  };
  const raw = serializeJson(value);
  writeRawAtomic(markerFile, raw, {
    beforeWrite: () => assertPinnedControlFile(
      controlPin,
      markerFile,
      'Goal lease layout marker'
    ),
  });
  const published = readOptionalRawSnapshot(markerFile);
  if (!published || !published.raw.equals(raw)) {
    throw new Error('Goal lease layout marker publication is ambiguous; recovery required');
  }
  return { snapshot: published, value };
}

function ensureAuditDirectory(controlDir, controlPin) {
  const directory = auditPath(controlDir);
  assertPinnedControlFile(controlPin, directory, 'Goal lease cold audit directory');
  return ensurePrivateDirectory(
    directory,
    controlPin,
    'Goal lease cold audit directory'
  );
}

function archiveEntrySnapshot(controlDir, group, state, file, index) {
  const snapshot = readOptionalRawSnapshot(file);
  if (!snapshot || snapshot.device !== group.device || snapshot.inode !== group.inode) {
    throw new Error(`Goal lease ${state} audit evidence has unknown identity`);
  }
  const relative = path.relative(controlDir, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || path.dirname(relative) !== '.') {
    throw new Error('Goal lease audit evidence escaped the hot control directory');
  }
  return {
    source: relative,
    destination: `.${state}-evidence-${index}`,
    hash: snapshot.hash,
    device: snapshot.device,
    inode: snapshot.inode,
    size: snapshot.size,
  };
}

function archiveManifestForGroup(controlDir, group) {
  if (!isFinalizedFenceGroup(group)) {
    throw new Error(`goal lease transaction recovery required: ${group.firstPath}`);
  }
  const entries = [];
  for (const state of ['pending', 'resolved', 'done']) {
    if (group[state]) {
      entries.push(archiveEntrySnapshot(
        controlDir,
        group,
        state,
        group[state],
        entries.length
      ));
    }
  }
  for (const stagingFile of group.staging || []) {
    entries.push(archiveEntrySnapshot(
      controlDir,
      group,
      'staging',
      stagingFile,
      entries.length
    ));
  }
  return {
    schemaVersion: GOAL_LEASE_AUDIT_SCHEMA,
    transactionId: group.transactionId,
    fenceDevice: group.device,
    fenceInode: group.inode,
    entries,
  };
}

function parseAuditManifest(raw) {
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`Goal lease audit manifest is invalid JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!value || value.schemaVersion !== GOAL_LEASE_AUDIT_SCHEMA
      || typeof value.transactionId !== 'string'
      || !/^[a-f0-9]{32}$/.test(value.transactionId)
      || !/^\d+$/.test(String(value.fenceDevice || ''))
      || !/^[1-9]\d*$/.test(String(value.fenceInode || ''))
      || !Array.isArray(value.entries)
      || value.entries.length < 2) {
    throw new Error('Goal lease audit manifest schema is invalid');
  }
  for (const entry of value.entries) {
    if (!entry || typeof entry.source !== 'string'
        || path.dirname(entry.source) !== '.'
        || typeof entry.destination !== 'string'
        || path.dirname(entry.destination) !== '.'
        || !entry.destination.startsWith('.')
        || typeof entry.hash !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(entry.hash)
        || !/^\d+$/.test(String(entry.device || ''))
        || !/^[1-9]\d*$/.test(String(entry.inode || ''))
        || !/^\d+$/.test(String(entry.size || ''))) {
      throw new Error('Goal lease audit manifest entry is invalid');
    }
  }
  return value;
}

function sameAuditEntry(snapshot, entry) {
  return Boolean(snapshot)
    && snapshot.hash === entry.hash
    && snapshot.device === entry.device
    && snapshot.inode === entry.inode
    && snapshot.size === entry.size;
}

function completeAuditGeneration(controlDir, controlPin, generation, manifest) {
  const generationPin = captureDirectoryIdentity(
    generation,
    'Goal lease cold audit generation'
  );
  const auditPin = ensureAuditDirectory(controlDir, controlPin);
  if (path.dirname(generationPin.canonicalDirectory) !== auditPin.canonicalDirectory) {
    throw new Error('Goal lease audit generation escaped the cold audit directory');
  }
  for (const entry of manifest.entries) {
    assertPinnedDirectory(generationPin, 'Goal lease cold audit generation');
    assertPinnedDirectory(controlPin, 'Goal lease authoritative control directory');
    const source = path.join(controlDir, entry.source);
    const destination = path.join(generation, entry.destination);
    const sourceSnapshot = readOptionalRawSnapshot(source);
    const destinationSnapshot = readOptionalRawSnapshot(destination);
    if (sourceSnapshot && destinationSnapshot) {
      throw new Error('Goal lease audit move has both hot and cold occupants; recovery required');
    }
    if (destinationSnapshot) {
      if (!sameAuditEntry(destinationSnapshot, entry)) {
        throw new Error('Goal lease cold audit evidence has unknown identity; recovery required');
      }
      continue;
    }
    if (!sameAuditEntry(sourceSnapshot, entry)) {
      throw new Error('Goal lease hot audit evidence changed before archival; recovery required');
    }
    try {
      fs.renameSync(source, destination);
    } catch (error) {
      const afterSource = readOptionalRawSnapshot(source);
      const afterDestination = readOptionalRawSnapshot(destination);
      if (afterSource || !sameAuditEntry(afterDestination, entry)) throw error;
    }
    const archived = readOptionalRawSnapshot(destination);
    if (!sameAuditEntry(archived, entry) || readOptionalRawSnapshot(source)) {
      throw new Error('Goal lease audit move captured a foreign object; recovery required');
    }
    syncRenameDirectories(source, destination, auditPin.directory);
  }
  syncDirectory(controlDir);
  syncDirectory(generation);
  const completeFile = path.join(generation, 'complete.json');
  const completeRaw = serializeJson({
    schemaVersion: 'native-goal-lease-audit-complete-v1',
    transactionId: manifest.transactionId,
    manifestHash: rawHash(serializeJson(manifest)),
  });
  const existing = readOptionalRawSnapshot(completeFile);
  if (existing) {
    if (!existing.raw.equals(completeRaw)) {
      throw new Error('Goal lease audit completion marker has foreign bytes');
    }
  } else {
    publishRawExclusive(completeFile, completeRaw, {
      beforeWrite: () => assertPinnedDirectory(
        generationPin,
        'Goal lease cold audit generation'
      ),
    });
  }
  return true;
}

function resumeAuditGenerations(controlDir, controlPin, preparedAuditPin = null) {
  const auditPin = preparedAuditPin || ensureAuditDirectory(controlDir, controlPin);
  for (const entry of fs.readdirSync(auditPin.directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('generation-')) continue;
    const generation = securePrivateDirectory(
      path.join(auditPin.directory, entry.name),
      auditPin,
      'Goal lease cold audit generation'
    ).directory;
    const manifestSnapshot = readOptionalRawSnapshot(path.join(generation, 'manifest.json'));
    if (!manifestSnapshot) continue;
    const manifest = parseAuditManifest(manifestSnapshot.raw);
    completeAuditGeneration(controlDir, controlPin, generation, manifest);
  }
}

function archiveFinalizedFenceGroup(controlDir, controlPin, group) {
  if (group.privateGeneration) {
    const auditPin = ensureAuditDirectory(controlDir, controlPin);
    const generationPin = captureDirectoryIdentity(
      group.privateGeneration,
      'Goal lease private fence generation'
    );
    if (path.dirname(generationPin.canonicalDirectory) !== auditPin.canonicalDirectory) {
      throw new Error('Goal lease private fence generation escaped the cold audit directory');
    }
    const manifestSnapshot = readOptionalRawSnapshot(
      path.join(group.privateGeneration, 'fence-generation.json')
    );
    if (!manifestSnapshot) {
      throw new Error('Goal lease private fence generation manifest is missing');
    }
    for (const [index, stagingFile] of (group.staging || []).entries()) {
      if (path.dirname(stagingFile) === group.privateGeneration) continue;
      const source = readOptionalRawSnapshot(stagingFile);
      if (!source || source.device !== group.device || source.inode !== group.inode) {
        throw new Error('Goal lease staged fence evidence changed before cold archival');
      }
      const destination = path.join(
        group.privateGeneration,
        `.staging-evidence-${index}`
      );
      if (fs.existsSync(destination)) {
        throw new Error('Goal lease staged fence audit destination is occupied');
      }
      try {
        fs.renameSync(stagingFile, destination);
      } catch (error) {
        const afterSource = readOptionalRawSnapshot(stagingFile);
        const afterDestination = readOptionalRawSnapshot(destination);
        if (afterSource || !sameClaimedFile(afterDestination, source)) throw error;
      }
      const archived = readOptionalRawSnapshot(destination);
      if (!sameClaimedFile(archived, source) || fs.existsSync(stagingFile)) {
        throw new Error('Goal lease staged fence archival captured a foreign object');
      }
      syncRenameDirectories(stagingFile, destination, auditPin.directory);
    }
    const completeRaw = serializeJson({
      schemaVersion: 'native-goal-lease-fence-generation-complete-v1',
      transactionId: group.transactionId,
      manifestHash: manifestSnapshot.hash,
    });
    publishRawExclusive(
      path.join(group.privateGeneration, 'complete.json'),
      completeRaw,
      {
        beforeWrite: () => assertPinnedDirectory(
          generationPin,
          'Goal lease private fence generation'
        ),
      }
    );
    syncDirectory(group.privateGeneration);
    return;
  }
  const auditPin = ensureAuditDirectory(controlDir, controlPin);
  const generationPin = createPrivateGeneration(
    auditPin,
    'Goal lease cold audit generation'
  );
  const generation = generationPin.directory;
  const manifest = archiveManifestForGroup(controlDir, group);
  const manifestRaw = serializeJson(manifest);
  publishRawExclusive(path.join(generation, 'manifest.json'), manifestRaw, {
    beforeWrite: () => assertPinnedDirectory(
      generationPin,
      'Goal lease cold audit generation'
    ),
  });
  completeAuditGeneration(controlDir, controlPin, generation, manifest);
}

function archiveFinalizedFenceGroups(controlDir, controlPin, groups) {
  for (const group of groups.values()) {
    if (isFinalizedFenceGroup(group)) {
      archiveFinalizedFenceGroup(controlDir, controlPin, group);
    }
  }
}

function parseAbortedStagingManifest(raw) {
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error('Goal lease aborted staging manifest is invalid JSON', {
      cause: error,
    });
  }
  if (!value || value.schemaVersion !== GOAL_LEASE_ABORTED_STAGE_SCHEMA
      || typeof value.transactionId !== 'string'
      || !/^[a-f0-9]{32}$/.test(value.transactionId)
      || typeof value.source !== 'string'
      || !/^goal-lease\.txn\.json\.\d+\.[a-f0-9]{16}\.tmp$/.test(value.source)
      || typeof value.hash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(value.hash)
      || !/^\d+$/.test(String(value.device || ''))
      || !/^[1-9]\d*$/.test(String(value.inode || ''))
      || !/^\d+$/.test(String(value.size || ''))) {
    throw new Error('Goal lease aborted staging manifest schema is invalid');
  }
  return value;
}

function sameAbortedStaging(snapshot, manifest) {
  return Boolean(snapshot)
    && snapshot.hash === manifest.hash
    && snapshot.device === manifest.device
    && snapshot.inode === manifest.inode
    && snapshot.size === manifest.size;
}

function completeAbortedStagingGeneration(
  controlDir,
  controlPin,
  auditPin,
  generation,
  manifest
) {
  const generationPin = securePrivateDirectory(
    generation,
    auditPin,
    'Goal lease aborted staging generation'
  );
  const source = path.join(controlDir, manifest.source);
  const destination = path.join(generationPin.directory, '.aborted-staging');
  const sourceSnapshot = readOptionalRawSnapshot(source);
  const destinationSnapshot = readOptionalRawSnapshot(destination);
  let archivedSnapshot = destinationSnapshot;
  if (sourceSnapshot && destinationSnapshot) {
    throw new Error('Goal lease aborted staging has both hot and cold occupants');
  }
  if (destinationSnapshot) {
    if (!sameAbortedStaging(destinationSnapshot, manifest)) {
      throw new Error('Goal lease aborted staging cold evidence has unknown identity');
    }
  } else {
    if (!sameAbortedStaging(sourceSnapshot, manifest)) {
      throw new Error('Goal lease aborted staging changed before archival');
    }
    try {
      fs.renameSync(source, destination);
    } catch (error) {
      const afterSource = readOptionalRawSnapshot(source);
      const afterDestination = readOptionalRawSnapshot(destination);
      if (afterSource || !sameAbortedStaging(afterDestination, manifest)) throw error;
    }
    if (readOptionalRawSnapshot(source)
        || !sameAbortedStaging(readOptionalRawSnapshot(destination), manifest)) {
      throw new Error('Goal lease aborted staging archival captured a foreign object');
    }
    syncRenameDirectories(source, destination, auditPin.directory);
    archivedSnapshot = readOptionalRawSnapshot(destination);
  }
  const durableSnapshot = syncPinnedRawFile(
    destination,
    archivedSnapshot,
    'Goal lease aborted staging cold evidence'
  );
  if (!sameAbortedStaging(durableSnapshot, manifest)) {
    throw new Error('Goal lease aborted staging changed before durable completion');
  }
  assertPinnedDirectory(controlPin, 'Goal lease authoritative control directory');
  assertPinnedDirectory(auditPin, 'Goal lease cold audit directory');
  assertPinnedDirectory(generationPin, 'Goal lease aborted staging generation');
  syncDirectory(generationPin.directory);
  syncDirectory(auditPin.directory);
  syncDirectory(controlPin.directory);
  const manifestSnapshot = readOptionalRawSnapshot(
    path.join(generationPin.directory, 'aborted-staging.json')
  );
  if (!manifestSnapshot) {
    throw new Error('Goal lease aborted staging manifest disappeared');
  }
  const completeRaw = serializeJson({
    schemaVersion: 'native-goal-lease-aborted-staging-complete-v1',
    transactionId: manifest.transactionId,
    manifestHash: manifestSnapshot.hash,
  });
  const completeFile = path.join(generationPin.directory, 'complete.json');
  const existing = readOptionalRawSnapshot(completeFile);
  if (existing) {
    if (!existing.raw.equals(completeRaw)) {
      throw new Error('Goal lease aborted staging completion has foreign bytes');
    }
  } else {
    publishRawExclusive(completeFile, completeRaw, {
      beforeWrite: () => {
        assertPinnedDirectory(controlPin, 'Goal lease authoritative control directory');
        assertPinnedDirectory(auditPin, 'Goal lease cold audit directory');
        assertPinnedDirectory(generationPin, 'Goal lease aborted staging generation');
      },
    });
  }
}

function assertAbortedStagingRecoveryWindow(controlDir, controlPin, marker) {
  assertPinnedDirectory(controlPin, 'Goal lease authoritative control directory');
  const currentMarker = readLayoutMarkerSnapshot(controlDir);
  if (!marker || marker.value.status !== 'live'
      || !currentMarker
      || currentMarker.value.status !== 'live'
      || !sameRawSnapshot(currentMarker.snapshot, marker.snapshot)) {
    throw new Error('Goal lease aborted staging live marker changed before archival');
  }
  const fenceFile = transactionPath(controlDir);
  assertPinnedControlFile(controlPin, fenceFile, 'Goal lease transaction fence');
  if (readOptionalRawSnapshot(fenceFile)) {
    throw new Error('Goal lease transaction fence appeared before aborted staging archival');
  }
}

function resumeAbortedStagingGenerations(controlDir, controlPin, auditPin, marker) {
  for (const entry of fs.readdirSync(auditPin.directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('generation-')) continue;
    const generation = securePrivateDirectory(
      path.join(auditPin.directory, entry.name),
      auditPin,
      'Goal lease aborted staging generation'
    ).directory;
    const manifestSnapshot = readOptionalRawSnapshot(
      path.join(generation, 'aborted-staging.json')
    );
    if (!manifestSnapshot) continue;
    const manifest = parseAbortedStagingManifest(manifestSnapshot.raw);
    const completed = readOptionalRawSnapshot(path.join(generation, 'complete.json'));
    if (completed && manifest.transactionId !== marker.value.transactionId) continue;
    if (manifest.transactionId !== marker.value.transactionId) {
      throw new Error('Goal lease aborted staging belongs to a different live transaction');
    }
    assertAbortedStagingRecoveryWindow(controlDir, controlPin, marker);
    completeAbortedStagingGeneration(
      controlDir,
      controlPin,
      auditPin,
      generation,
      manifest
    );
  }
}

function archiveAbortedStaging(controlDir, controlPin, auditPin, marker, group) {
  const snapshot = group.unreadyStaging;
  if (!snapshot || !marker || marker.value.status !== 'live') {
    throw new Error('Goal lease unready staging cannot be archived without a live marker');
  }
  assertAbortedStagingRecoveryWindow(controlDir, controlPin, marker);
  assertPinnedControlFile(controlPin, group.firstPath, 'Goal lease unready staging');
  if (!sameRawSnapshot(readOptionalRawSnapshot(group.firstPath), snapshot)) {
    throw new Error('Goal lease unready staging changed before archival');
  }
  const generationPin = createPrivateGeneration(
    auditPin,
    'Goal lease aborted staging generation'
  );
  const manifest = {
    schemaVersion: GOAL_LEASE_ABORTED_STAGE_SCHEMA,
    transactionId: marker.value.transactionId,
    source: path.basename(group.firstPath),
    hash: snapshot.hash,
    device: snapshot.device,
    inode: snapshot.inode,
    size: snapshot.size,
  };
  publishRawExclusive(
    path.join(generationPin.directory, 'aborted-staging.json'),
    serializeJson(manifest),
    {
      beforeWrite: () => {
        assertPinnedDirectory(controlPin, 'Goal lease authoritative control directory');
        assertPinnedDirectory(generationPin, 'Goal lease aborted staging generation');
      },
    }
  );
  completeAbortedStagingGeneration(
    controlDir,
    controlPin,
    auditPin,
    generationPin.directory,
    manifest
  );
}

function fenceArtifactPath(fenceFile, state, transactionId, snapshot) {
  return `${fenceFile}.${state}-${transactionId}-${snapshot.device}-${snapshot.inode}`;
}

function privateFencePath(generation, state) {
  return path.join(generation, `.${state}-fence`);
}

function parseFenceGenerationManifest(raw) {
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error('Goal lease private fence manifest is invalid JSON', { cause: error });
  }
  if (!value || value.schemaVersion !== GOAL_LEASE_FENCE_GENERATION_SCHEMA
      || typeof value.transactionId !== 'string'
      || !/^[a-f0-9]{32}$/.test(value.transactionId)
      || typeof value.hash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(value.hash)
      || !/^\d+$/.test(String(value.device || ''))
      || !/^[1-9]\d*$/.test(String(value.inode || ''))
      || !/^\d+$/.test(String(value.size || ''))) {
    throw new Error('Goal lease private fence manifest schema is invalid');
  }
  return value;
}

function fenceGenerationMatches(manifest, transaction, snapshot) {
  return manifest.transactionId === transaction.value.transactionId
    && manifest.hash === snapshot.hash
    && manifest.device === snapshot.device
    && manifest.inode === snapshot.inode
    && manifest.size === snapshot.size;
}

function validateFenceGenerationComplete(generation, manifestSnapshot, manifest) {
  const completeSnapshot = readOptionalRawSnapshot(path.join(generation, 'complete.json'));
  if (!completeSnapshot) return false;
  let complete;
  try {
    complete = JSON.parse(completeSnapshot.raw.toString('utf8'));
  } catch (error) {
    throw new Error('Goal lease private fence completion marker is invalid JSON', {
      cause: error,
    });
  }
  if (!complete
      || complete.schemaVersion !== 'native-goal-lease-fence-generation-complete-v1'
      || complete.transactionId !== manifest.transactionId
      || complete.manifestHash !== manifestSnapshot.hash) {
    throw new Error('Goal lease private fence completion marker is invalid');
  }
  return true;
}

function findPrivateFenceGeneration(auditPin, transaction, snapshot) {
  const matches = [];
  assertPinnedDirectory(auditPin, 'Goal lease cold audit directory');
  for (const entry of fs.readdirSync(auditPin.directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('generation-')) continue;
    const generation = path.join(auditPin.directory, entry.name);
    const generationPin = securePrivateDirectory(
      generation,
      auditPin,
      'Goal lease private fence generation'
    );
    const manifestSnapshot = readOptionalRawSnapshot(
      path.join(generationPin.directory, 'fence-generation.json')
    );
    if (!manifestSnapshot) continue;
    const manifest = parseFenceGenerationManifest(manifestSnapshot.raw);
    if (manifest.transactionId !== transaction.value.transactionId) continue;
    if (!fenceGenerationMatches(manifest, transaction, snapshot)) {
      throw new Error('Goal lease private fence generation has conflicting identity');
    }
    if (!validateFenceGenerationComplete(
      generationPin.directory,
      manifestSnapshot,
      manifest
    )) {
      matches.push(generationPin.directory);
    }
  }
  assertPinnedDirectory(auditPin, 'Goal lease cold audit directory');
  if (matches.length > 1) {
    throw new Error('Goal lease transaction has multiple live private fence generations');
  }
  return matches[0] || null;
}

function ensurePrivateFenceGeneration(controlDir, controlPin, transaction, snapshot) {
  const auditPin = ensureAuditDirectory(controlDir, controlPin);
  const existing = findPrivateFenceGeneration(auditPin, transaction, snapshot);
  if (existing) return existing;
  const generationPin = createPrivateGeneration(
    auditPin,
    'Goal lease private fence generation'
  );
  const generation = generationPin.directory;
  const manifest = {
    schemaVersion: GOAL_LEASE_FENCE_GENERATION_SCHEMA,
    transactionId: transaction.value.transactionId,
    hash: snapshot.hash,
    device: snapshot.device,
    inode: snapshot.inode,
    size: snapshot.size,
  };
  publishRawExclusive(
    path.join(generation, 'fence-generation.json'),
    serializeJson(manifest),
    {
      beforeWrite: () => assertPinnedDirectory(
        generationPin,
        'Goal lease private fence generation'
      ),
    }
  );
  return generation;
}

function mergePrivateFenceArtifactGroups(auditPin, groups) {
  assertPinnedDirectory(auditPin, 'Goal lease cold audit directory');
  for (const entry of fs.readdirSync(auditPin.directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('generation-')) continue;
    const generation = securePrivateDirectory(
      path.join(auditPin.directory, entry.name),
      auditPin,
      'Goal lease cold audit generation'
    ).directory;
    const manifestFile = path.join(generation, 'fence-generation.json');
    if (!fs.existsSync(manifestFile)) continue;
    try {
      const manifestSnapshot = readOptionalRawSnapshot(manifestFile);
      const manifest = parseFenceGenerationManifest(manifestSnapshot.raw);
      if (validateFenceGenerationComplete(generation, manifestSnapshot, manifest)) continue;
      const key = `${manifest.transactionId}:${manifest.device}:${manifest.inode}`;
      const group = groups.get(key) || {
        transactionId: manifest.transactionId,
        device: manifest.device,
        inode: manifest.inode,
        firstPath: manifestFile,
      };
      if (group.privateGeneration && group.privateGeneration !== generation) {
        group.invalid = true;
      }
      group.privateGeneration = generation;
      for (const state of ['pending', 'resolved', 'done']) {
        const file = privateFencePath(generation, state);
        if (!fs.existsSync(file)) continue;
        if (group[state] && group[state] !== file) group.invalid = true;
        group[state] = file;
      }
      groups.set(key, group);
    } catch (_) {
      groups.set(`unknown-private:${entry.name}`, {
        firstPath: manifestFile,
        invalid: true,
      });
    }
  }
  assertPinnedDirectory(auditPin, 'Goal lease cold audit directory');
  return groups;
}

function readFenceArtifactGroups(controlDir, auditPin) {
  const groups = new Map();
  if (!fs.existsSync(controlDir)) return groups;
  const escaped = GOAL_LEASE_TRANSACTION_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^${escaped}\\.(pending|resolved|done)-([a-f0-9]{32})-(\\d+)-([1-9]\\d*)$`
  );
  for (const entry of fs.readdirSync(controlDir)) {
    if (!entry.startsWith(`${GOAL_LEASE_TRANSACTION_FILE}.`)) continue;
    const file = path.join(controlDir, entry);
    const match = pattern.exec(entry);
    if (!match && /^goal-lease\.txn\.json\.\d+\.[a-f0-9]{16}\.tmp$/.test(entry)) {
      let snapshot;
      try {
        snapshot = readOptionalRawSnapshot(file);
      } catch (_) {
        groups.set(`unknown:${entry}`, { firstPath: file, invalid: true });
        continue;
      }
      let syntacticallyComplete = false;
      try {
        JSON.parse(snapshot.raw.toString('utf8'));
        syntacticallyComplete = true;
        const transaction = parseGoalLeaseTransaction(snapshot.raw);
        const key = `${transaction.value.transactionId}:${snapshot.device}:${snapshot.inode}`;
        const group = groups.get(key) || {
          transactionId: transaction.value.transactionId,
          device: snapshot.device,
          inode: snapshot.inode,
          firstPath: file,
        };
        group.staging = group.staging || [];
        group.staging.push(file);
        groups.set(key, group);
      } catch (_) {
        if (syntacticallyComplete) {
          groups.set(`unknown:${entry}`, { firstPath: file, invalid: true });
        } else {
          groups.set(`unready:${entry}`, {
            firstPath: file,
            unreadyStaging: snapshot,
          });
        }
      }
      continue;
    }
    if (!match) {
      groups.set(`unknown:${entry}`, { firstPath: file, invalid: true });
      continue;
    }
    const [, state, transactionId, device, inode] = match;
    const key = `${transactionId}:${device}:${inode}`;
    const group = groups.get(key) || {
      transactionId,
      device,
      inode,
      firstPath: file,
    };
    if (group[state]) group.invalid = true;
    group[state] = file;
    groups.set(key, group);
  }
  return mergePrivateFenceArtifactGroups(auditPin, groups);
}

function readFenceArtifact(group, state) {
  const file = group[state];
  if (!file) return null;
  const snapshot = readOptionalRawSnapshot(file);
  if (!snapshot || snapshot.device !== group.device || snapshot.inode !== group.inode) {
    throw new Error(`Goal lease ${state} fence claim has unknown identity`);
  }
  const transaction = parseGoalLeaseTransaction(snapshot.raw);
  if (transaction.value.transactionId !== group.transactionId) {
    throw new Error(`Goal lease ${state} fence claim has unknown transaction bytes`);
  }
  return snapshot;
}

function isFinalizedFenceGroup(group) {
  if (group.invalid || group.pending || !group.resolved || !group.done) return false;
  try {
    const resolved = readFenceArtifact(group, 'resolved');
    const done = readFenceArtifact(group, 'done');
    return sameClaimedFile(resolved, done)
      && (group.staging || []).every((file) => sameClaimedFile(
        readOptionalRawSnapshot(file),
        resolved
      ));
  } catch (_) {
    return false;
  }
}

function assertNoGoalLeaseTransaction(controlDir) {
  const file = transactionPath(controlDir);
  if (fs.existsSync(file)) {
    throw new Error(`goal lease transaction recovery required: ${file}`);
  }
  const marker = readLayoutMarkerSnapshot(controlDir);
  if (!marker || marker.value.status !== 'clean') {
    throw new Error('goal lease layout migration or transaction recovery is required');
  }
}

function assertPinnedControlFile(controlPin, file, label) {
  assertPinnedDirectory(controlPin, 'Goal lease authoritative control directory');
  if (path.dirname(controlStore.canonicalPotentialPath(file)) !== controlPin.canonicalDirectory) {
    throw new Error(`${label} escaped the pinned authoritative control directory`);
  }
}

function snapshotState(snapshot, beforeRaw, afterHash) {
  if (snapshot === null) return beforeRaw === null ? 'before' : 'unknown';
  if (beforeRaw !== null && snapshot.raw.equals(beforeRaw)) return 'before';
  if (snapshot.hash === afterHash) return 'after';
  return 'unknown';
}

function claimRootName(purpose) {
  return purpose === 'rollback-projection'
    ? '.goal-lease.claims-v2'
    : 'goal-lease.claims-v2';
}

function ensurePrivateClaimRoot(file, purpose, assertPin) {
  assertPin();
  const sourceDirectoryPin = captureDirectoryIdentity(
    path.dirname(file),
    `Goal lease ${purpose} source directory`
  );
  const root = path.join(path.dirname(file), claimRootName(purpose));
  assertPin();
  return ensurePrivateDirectory(
    root,
    sourceDirectoryPin,
    `Goal lease ${purpose} claim root`
  );
}

function parseClaimManifest(raw, purpose, transactionId, sourceBasename, expectedHash) {
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`Goal lease ${purpose} claim manifest is invalid JSON`, {
      cause: error,
    });
  }
  if (!value || value.schemaVersion !== GOAL_LEASE_CLAIM_SCHEMA
      || value.purpose !== purpose
      || value.transactionId !== transactionId
      || value.sourceBasename !== sourceBasename
      || value.hash !== expectedHash
      || !/^\d+$/.test(String(value.device || ''))
      || !/^[1-9]\d*$/.test(String(value.inode || ''))
      || !/^\d+$/.test(String(value.size || ''))) {
    throw new Error(`Goal lease ${purpose} claim manifest is invalid; recovery required`);
  }
  return value;
}

function claimDestination(generation, purpose) {
  return path.join(generation, `.${purpose}-claim`);
}

function validateClaimSnapshot(file, purpose, transactionId, expectedHash) {
  const generation = path.dirname(file);
  const manifestSnapshot = readOptionalRawSnapshot(path.join(generation, 'manifest.json'));
  if (!manifestSnapshot) {
    throw new Error(`Goal lease ${purpose} claim manifest is missing; recovery required`);
  }
  const manifest = parseClaimManifest(
    manifestSnapshot.raw,
    purpose,
    transactionId,
    GOAL_LEASE_FILE,
    expectedHash
  );
  const snapshot = readOptionalRawSnapshot(file);
  if (!snapshot || snapshot.hash !== expectedHash
      || snapshot.device !== manifest.device
      || snapshot.inode !== manifest.inode
      || snapshot.size !== manifest.size
      || path.resolve(file) !== path.resolve(claimDestination(generation, purpose))) {
    throw new Error(`Goal lease ${purpose} claim has unknown identity or bytes; recovery required`);
  }
  return snapshot;
}

function findClaim(file, purpose, transactionId, expectedHash, assertPin) {
  assertPin();
  const root = path.join(path.dirname(file), claimRootName(purpose));
  if (!fs.existsSync(root)) return null;
  const rootPin = ensurePrivateClaimRoot(file, purpose, assertPin);
  const matches = [];
  for (const entry of fs.readdirSync(rootPin.directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('generation-')) continue;
    const generation = path.join(rootPin.directory, entry.name);
    const manifestSnapshot = readOptionalRawSnapshot(path.join(generation, 'manifest.json'));
    if (!manifestSnapshot) continue;
    let manifest;
    try {
      manifest = JSON.parse(manifestSnapshot.raw.toString('utf8'));
    } catch (_) {
      throw new Error(`Goal lease ${purpose} claim manifest is invalid; recovery required`);
    }
    if (manifest.purpose !== purpose || manifest.transactionId !== transactionId) continue;
    parseClaimManifest(
      manifestSnapshot.raw,
      purpose,
      transactionId,
      path.basename(file),
      expectedHash
    );
    const destination = claimDestination(generation, purpose);
    if (fs.existsSync(destination)) matches.push(destination);
  }
  if (matches.length > 1) {
    throw new Error(`Goal lease ${purpose} has multiple recovery claims`);
  }
  return matches[0] || null;
}

function renameSnapshotToClaim(file, purpose, transactionId, expected, assertPin) {
  const rootPin = ensurePrivateClaimRoot(file, purpose, assertPin);
  const generationPin = createPrivateGeneration(
    rootPin,
    `Goal lease ${purpose} private claim generation`
  );
  const generation = generationPin.directory;
  const manifest = {
    schemaVersion: GOAL_LEASE_CLAIM_SCHEMA,
    purpose,
    transactionId,
    sourceBasename: path.basename(file),
    hash: expected.hash,
    device: expected.device,
    inode: expected.inode,
    size: expected.size,
  };
  publishRawExclusive(
    path.join(generation, 'manifest.json'),
    serializeJson(manifest),
    {
      beforeWrite: () => {
        assertPin();
        assertPinnedDirectory(
          generationPin,
          `Goal lease ${purpose} private claim generation`
        );
      },
    }
  );
  const destination = claimDestination(generation, purpose);
  const verifySource = () => {
    assertPin();
    assertPinnedDirectory(
      generationPin,
      `Goal lease ${purpose} private claim generation`
    );
    const current = readOptionalRawSnapshot(file);
    if (!sameRawSnapshot(current, expected)) {
      throw new Error(`Goal lease ${purpose} changed before atomic recovery claim`);
    }
    if (fs.existsSync(destination)) {
      throw new Error(`Goal lease ${purpose} private claim destination is occupied`);
    }
  };
  verifySource();
  try {
    fs.renameSync(file, destination);
  } catch (error) {
    if (fs.existsSync(file) || !fs.existsSync(destination)) throw error;
  }
  assertPin();
  assertPinnedDirectory(
    generationPin,
    `Goal lease ${purpose} private claim generation`
  );
  const claimed = readOptionalRawSnapshot(destination);
  if (!sameClaimedFile(claimed, expected)) {
    throw new Error(`Goal lease ${purpose} claim captured a foreign object; recovery required`);
  }
  syncRenameDirectories(file, destination, rootPin.directory);
  return { file: destination, snapshot: claimed };
}

function publishBeforeRaw(file, beforeRaw, assertPin, label) {
  assertPin();
  if (beforeRaw === null) {
    if (readOptionalRawSnapshot(file) !== null) {
      throw new Error(`${label} reappeared during rollback; recovery required`);
    }
    return;
  }
  const existing = readOptionalRawSnapshot(file);
  if (existing && existing.raw.equals(beforeRaw)) return;
  if (existing) throw new Error(`${label} contains foreign bytes; recovery required`);
  try {
    publishRawExclusive(file, beforeRaw, {
      beforeWrite: () => {
        assertPin();
        if (readOptionalRawSnapshot(file) !== null) {
          throw new Error(`${label} reappeared during rollback; recovery required`);
        }
      },
    });
  } catch (error) {
    const after = readOptionalRawSnapshot(file);
    if (!after || !after.raw.equals(beforeRaw)) throw error;
  }
}

function rollbackFileCompareAndSwap({
  file,
  beforeRaw,
  afterHash,
  transactionId,
  purpose,
  label,
  assertPin,
}) {
  assertPin();
  let claim = findClaim(file, purpose, transactionId, afterHash, assertPin);
  let current = readOptionalRawSnapshot(file);

  if (claim) {
    validateClaimSnapshot(claim, purpose, transactionId, afterHash);
    const state = current === null ? 'missing' : snapshotState(current, beforeRaw, afterHash);
    if (state === 'after' || state === 'unknown') {
      throw new Error(`${label} has unknown bytes beside its recovery claim; recovery required`);
    }
    if (state === 'missing') publishBeforeRaw(file, beforeRaw, assertPin, label);
  } else {
    const state = snapshotState(current, beforeRaw, afterHash);
    if (state === 'unknown') {
      throw new Error(`${label} has unknown bytes; recovery required`);
    }
    if (state === 'after') {
      const claimed = renameSnapshotToClaim(
        file,
        purpose,
        transactionId,
        current,
        assertPin
      );
      claim = claimed.file;
      publishBeforeRaw(file, beforeRaw, assertPin, label);
    }
  }

  assertPin();
  current = readOptionalRawSnapshot(file);
  if (snapshotState(current, beforeRaw, afterHash) !== 'before') {
    throw new Error(`${label} rollback verification failed; recovery required`);
  }
  if (claim) validateClaimSnapshot(claim, purpose, transactionId, afterHash);
}

function rollbackAuthorityCompareAndSwap(file, transaction, controlPin) {
  rollbackFileCompareAndSwap({
    file,
    beforeRaw: transaction.beforeAuthority,
    afterHash: transaction.value.afterHash,
    transactionId: transaction.value.transactionId,
    purpose: 'rollback-authority',
    label: 'Goal lease authority',
    assertPin: () => assertPinnedControlFile(controlPin, file, 'Goal lease authority'),
  });
}

function projectionTargetFromTransaction(transaction) {
  return {
    directory: transaction.value.projection.directory,
    file: path.join(transaction.value.projection.directory, GOAL_LEASE_FILE),
    canonicalRunDirAtCreation: transaction.value.projection.canonicalRunDirAtCreation,
    canonicalDirectory: transaction.value.projection.canonicalDirectory,
    device: transaction.value.projection.device,
    inode: transaction.value.projection.inode,
  };
}

function projectionPinStillMatches(target) {
  try {
    return sameDirectoryIdentity(resolveProjectionTarget(target.directory), target);
  } catch (_) {
    return false;
  }
}

function rollbackProjectionCompareAndSwap(transaction) {
  const target = projectionTargetFromTransaction(transaction);
  const assertPin = () => {
    if (!projectionPinStillMatches(target)) {
      throw new Error('Goal lease projection target changed; identity recovery required');
    }
  };
  rollbackFileCompareAndSwap({
    file: target.file,
    beforeRaw: transaction.beforeProjection,
    afterHash: transaction.value.projection.afterHash,
    transactionId: transaction.value.transactionId,
    purpose: 'rollback-projection',
    label: 'Goal lease projection',
    assertPin,
  });
  return true;
}

function assertTransactionMetadata(transaction) {
  if (transaction.binding.canonicalRunDirAtCreation
      !== transaction.value.projection.canonicalRunDirAtCreation) {
    throw new Error('Goal lease transaction binding and projection identities differ');
  }
}

function terminalStateMatches(state, beforeRaw, afterHash, terminal) {
  if (state === terminal) return true;
  return terminal === 'after'
    && state === 'before'
    && beforeRaw !== null
    && rawHash(beforeRaw) === afterHash;
}

function assertTransactionTerminal(transaction, authorityFile, terminal, controlPin) {
  assertTransactionMetadata(transaction);
  assertPinnedControlFile(controlPin, authorityFile, 'Goal lease authority');
  const target = projectionTargetFromTransaction(transaction);
  if (!projectionPinStillMatches(target)) {
    throw new Error('Goal lease projection target changed; identity recovery required');
  }
  const authorityState = snapshotState(
    readOptionalRawSnapshot(authorityFile),
    transaction.beforeAuthority,
    transaction.value.afterHash
  );
  const projectionState = snapshotState(
    readOptionalRawSnapshot(target.file),
    transaction.beforeProjection,
    transaction.value.projection.afterHash
  );
  if (!terminalStateMatches(
    authorityState,
    transaction.beforeAuthority,
    transaction.value.afterHash,
    terminal
  ) || !terminalStateMatches(
    projectionState,
    transaction.beforeProjection,
    transaction.value.projection.afterHash,
    terminal
  )) {
    throw new Error(
      `Goal lease transaction is not in its ${terminal.toUpperCase()} terminal state; recovery required`
    );
  }
}

function restoreCanonicalFence(fenceFile, authenticFile) {
  if (fs.existsSync(fenceFile) || !authenticFile || !fs.existsSync(authenticFile)) return;
  try {
    fs.linkSync(authenticFile, fenceFile);
    syncDirectory(path.dirname(fenceFile));
  } catch (_) {
    // The canonical fence must never be overwritten. A concurrent occupant is
    // itself fail-closed evidence, while the authentic claim remains durable.
  }
}

function finalizeFenceClaim(fenceFile, expectedRaw, controlPin, transaction, terminalVerifier) {
  assertPinnedControlFile(controlPin, fenceFile, 'Goal lease transaction fence');
  const initial = readOptionalRawSnapshot(fenceFile);
  if (!initial || !initial.raw.equals(expectedRaw)) {
    throw new Error('Goal lease transaction fence changed before atomic resolution');
  }
  const generation = ensurePrivateFenceGeneration(
    path.dirname(fenceFile),
    controlPin,
    transaction,
    initial
  );
  const generationPin = captureDirectoryIdentity(
    generation,
    'Goal lease private fence generation'
  );
  const pending = privateFencePath(generation, 'pending');
  const resolved = privateFencePath(generation, 'resolved');
  const done = privateFencePath(generation, 'done');

  let pendingSnapshot = readOptionalRawSnapshot(pending);
  if (pendingSnapshot) {
    if (!sameClaimedFile(pendingSnapshot, initial)) {
      throw new Error('Goal lease pending fence claim has foreign identity; recovery required');
    }
  } else {
    if (fs.existsSync(resolved) || fs.existsSync(done)) {
      throw new Error('Goal lease private fence generation has an occupied destination');
    }
    terminalVerifier();
    assertPinnedDirectory(generationPin, 'Goal lease private fence generation');
    const current = readOptionalRawSnapshot(fenceFile);
    if (!sameRawSnapshot(current, initial)) {
      throw new Error('Goal lease transaction fence changed before evidence publication');
    }
    try {
      fs.linkSync(fenceFile, pending);
    } catch (error) {
      pendingSnapshot = readOptionalRawSnapshot(pending);
      if (!pendingSnapshot) throw error;
    }
    pendingSnapshot = readOptionalRawSnapshot(pending);
    if (!sameClaimedFile(pendingSnapshot, initial)) {
      throw new Error('Goal lease pending fence claim captured a foreign object');
    }
    syncDirectory(generation);
  }

  terminalVerifier();
  assertPinnedDirectory(generationPin, 'Goal lease private fence generation');
  const beforeRename = readOptionalRawSnapshot(fenceFile);
  // Publishing the pending hardlink legitimately changes ctime/link metadata;
  // the inode plus exact bytes are the ownership proof for the rename claim.
  if (!sameClaimedFile(beforeRename, initial) || fs.existsSync(resolved)) {
    throw new Error('Goal lease transaction fence changed before atomic resolution claim');
  }
  try {
    fs.renameSync(fenceFile, resolved);
  } catch (error) {
    if (fs.existsSync(fenceFile) || !fs.existsSync(resolved)) throw error;
  }
  let resolvedSnapshot = readOptionalRawSnapshot(resolved);
  pendingSnapshot = readOptionalRawSnapshot(pending);
  if (!sameClaimedFile(resolvedSnapshot, initial)
      || !sameClaimedFile(pendingSnapshot, initial)
      || !sameClaimedFile(resolvedSnapshot, pendingSnapshot)) {
    const authentic = sameClaimedFile(pendingSnapshot, initial) ? pending : null;
    restoreCanonicalFence(fenceFile, authentic);
    throw new Error('Goal lease resolution claim captured a foreign fence; recovery required');
  }
  syncRenameDirectories(fenceFile, resolved, path.dirname(generation));

  terminalVerifier();
  assertPinnedDirectory(generationPin, 'Goal lease private fence generation');
  if (fs.existsSync(done)) {
    restoreCanonicalFence(fenceFile, resolved);
    throw new Error('Goal lease completed fence marker already exists; recovery required');
  }
  try {
    fs.renameSync(pending, done);
  } catch (error) {
    if (fs.existsSync(pending) || !fs.existsSync(done)) {
      restoreCanonicalFence(fenceFile, resolved);
      throw error;
    }
  }
  const doneSnapshot = readOptionalRawSnapshot(done);
  resolvedSnapshot = readOptionalRawSnapshot(resolved);
  if (!sameClaimedFile(doneSnapshot, initial)
      || !sameClaimedFile(resolvedSnapshot, initial)
      || !sameClaimedFile(doneSnapshot, resolvedSnapshot)) {
    restoreCanonicalFence(fenceFile, sameClaimedFile(resolvedSnapshot, initial) ? resolved : null);
    throw new Error('Goal lease completed fence marker captured a foreign object; recovery required');
  }
  syncRenameDirectories(pending, done, path.dirname(generation));
  try {
    terminalVerifier();
  } catch (error) {
    restoreCanonicalFence(fenceFile, resolved);
    throw error;
  }
  assertPinnedDirectory(generationPin, 'Goal lease private fence generation');
  syncDirectory(generation);
  syncDirectory(path.dirname(fenceFile));
}

function finishInterruptedFenceClaim(group, controlPin, authorityFile) {
  if (group.invalid || !group.pending || !group.resolved || group.done) {
    throw new Error(`goal lease transaction recovery required: ${group.firstPath}`);
  }
  const pending = readFenceArtifact(group, 'pending');
  const resolved = readFenceArtifact(group, 'resolved');
  const generationPin = group.privateGeneration
    ? captureDirectoryIdentity(
      group.privateGeneration,
      'Goal lease private fence generation'
    )
    : null;
  if (!sameClaimedFile(pending, resolved)) {
    throw new Error('Goal lease interrupted fence claims have different identities');
  }
  const transaction = parseGoalLeaseTransaction(resolved.raw);
  assertTransactionMetadata(transaction);
  const target = projectionTargetFromTransaction(transaction);
  if (!projectionPinStillMatches(target)) {
    throw new Error('Goal lease projection target changed; identity recovery required');
  }
  const authorityState = snapshotState(
    readOptionalRawSnapshot(authorityFile),
    transaction.beforeAuthority,
    transaction.value.afterHash
  );
  const projectionState = snapshotState(
    readOptionalRawSnapshot(target.file),
    transaction.beforeProjection,
    transaction.value.projection.afterHash
  );
  const terminal = terminalStateMatches(
    authorityState,
    transaction.beforeAuthority,
    transaction.value.afterHash,
    'before'
  ) && terminalStateMatches(
    projectionState,
    transaction.beforeProjection,
    transaction.value.projection.afterHash,
    'before'
  ) ? 'before' : terminalStateMatches(
    authorityState,
    transaction.beforeAuthority,
    transaction.value.afterHash,
    'after'
  ) && terminalStateMatches(
    projectionState,
    transaction.beforeProjection,
    transaction.value.projection.afterHash,
    'after'
  ) ? 'after' : null;
  if (!terminal) {
    throw new Error('Goal lease interrupted fence claim has non-terminal business state');
  }
  const terminalVerifier = () => assertTransactionTerminal(
    transaction,
    authorityFile,
    terminal,
    controlPin
  );
  terminalVerifier();
  if (generationPin) {
    assertPinnedDirectory(generationPin, 'Goal lease private fence generation');
  }
  const done = group.privateGeneration
    ? privateFencePath(group.privateGeneration, 'done')
    : fenceArtifactPath(
      transactionPath(path.dirname(authorityFile)),
      'done',
      group.transactionId,
      pending
    );
  try {
    fs.renameSync(group.pending, done);
  } catch (error) {
    if (fs.existsSync(group.pending) || !fs.existsSync(done)) {
      restoreCanonicalFence(transactionPath(path.dirname(authorityFile)), group.resolved);
      throw error;
    }
  }
  const doneSnapshot = readOptionalRawSnapshot(done);
  const resolvedSnapshot = readOptionalRawSnapshot(group.resolved);
  if (generationPin) {
    assertPinnedDirectory(generationPin, 'Goal lease private fence generation');
  }
  if (!sameClaimedFile(doneSnapshot, pending)
      || !sameClaimedFile(resolvedSnapshot, pending)) {
    restoreCanonicalFence(transactionPath(path.dirname(authorityFile)), group.resolved);
    throw new Error('Goal lease interrupted fence completion captured a foreign object');
  }
  syncRenameDirectories(group.pending, done);
  try {
    terminalVerifier();
  } catch (error) {
    restoreCanonicalFence(transactionPath(path.dirname(authorityFile)), group.resolved);
    throw error;
  }
  if (group.privateGeneration) syncDirectory(group.privateGeneration);
}

function restoreStagedFence(group, controlPin, fenceFile, runDir, options) {
  if (group.invalid || group.pending || group.resolved || group.done
      || !group.staging || group.staging.length !== 1) {
    throw new Error(`goal lease transaction recovery required: ${group.firstPath}`);
  }
  const stagingFile = group.staging[0];
  assertPinnedControlFile(controlPin, stagingFile, 'Goal lease staged transaction fence');
  assertPinnedControlFile(controlPin, fenceFile, 'Goal lease transaction fence');
  const staged = readOptionalRawSnapshot(stagingFile);
  if (!staged || staged.device !== group.device || staged.inode !== group.inode) {
    throw new Error('Goal lease staged transaction fence identity changed');
  }
  const transaction = parseGoalLeaseTransaction(staged.raw);
  if (transaction.value.transactionId !== group.transactionId) {
    throw new Error('Goal lease staged transaction fence bytes changed');
  }
  assertTransactionMetadata(transaction);
  const currentBinding = controlBindingSnapshot(
    controlStore.readControlRunBinding(runDir, options)
  );
  if (!sameControlBinding(currentBinding, transaction.binding)) {
    throw new Error('Goal lease staged transaction control binding differs');
  }
  const target = projectionTargetFromTransaction(transaction);
  const currentTarget = resolveProjectionTarget(runDir);
  if (!projectionPinStillMatches(target)
      || !sameDirectoryIdentity(currentTarget, target)
      || currentTarget.canonicalRunDirAtCreation
        !== target.canonicalRunDirAtCreation) {
    throw new Error('Goal lease staged transaction projection target differs');
  }
  const verified = readOptionalRawSnapshot(stagingFile);
  if (!sameRawSnapshot(verified, staged) || fs.existsSync(fenceFile)) {
    throw new Error('Goal lease staged transaction fence changed before publication');
  }
  try {
    fs.linkSync(stagingFile, fenceFile);
  } catch (error) {
    if (!fs.existsSync(fenceFile)) throw error;
  }
  const canonical = readOptionalRawSnapshot(fenceFile);
  const afterStaging = readOptionalRawSnapshot(stagingFile);
  if (!sameClaimedFile(canonical, staged)
      || !sameClaimedFile(afterStaging, staged)
      || !sameClaimedFile(canonical, afterStaging)) {
    throw new Error('Goal lease staged transaction publication captured a foreign object');
  }
  syncDirectory(path.dirname(fenceFile));
}

function reconcileGoalLeaseTransactionLocked(runDir, options = {}, prepared = null) {
  const controlDir = prepared
    ? prepared.controlDir
    : controlStore.ensureControlRunDir(runDir, options);
  if (!prepared) controlStore.assertAuthoritativeControlPath(runDir, controlDir, options);
  const controlPin = prepared
    ? prepared.controlPin
    : captureDirectoryIdentity(controlDir, 'Goal lease authoritative control directory');
  const authorityFile = path.join(controlDir, GOAL_LEASE_FILE);
  const fenceFile = transactionPath(controlDir);
  const marker = readLayoutMarkerSnapshot(controlDir);
  const fenceSnapshot = readOptionalRawSnapshot(fenceFile);

  if (marker && marker.value.status === 'clean' && !fenceSnapshot) {
    return { status: 'clean' };
  }

  const auditPin = ensureAuditDirectory(controlDir, controlPin);
  resumeAuditGenerations(controlDir, controlPin, auditPin);
  if (!fenceSnapshot && marker && marker.value.status === 'live') {
    resumeAbortedStagingGenerations(controlDir, controlPin, auditPin, marker);
  }
  const groups = readFenceArtifactGroups(controlDir, auditPin);

  if (!fenceSnapshot) {
    const unresolved = [...groups.values()].filter((group) => !isFinalizedFenceGroup(group));
    if (unresolved.length === 0) {
      archiveFinalizedFenceGroups(controlDir, controlPin, groups);
      const remaining = readFenceArtifactGroups(controlDir, auditPin);
      if (remaining.size !== 0) {
        throw new Error('Goal lease hot transaction evidence remains after archival');
      }
      writeLayoutMarker(controlDir, controlPin, 'clean');
      return { status: marker ? 'reconciled' : 'migrated' };
    }
    if (unresolved.length !== 1) {
      throw new Error('multiple Goal lease transactions require recovery');
    }
    const [group] = unresolved;
    if (group.unreadyStaging) {
      if (!marker || marker.value.status !== 'live'
          || group.invalid || group.pending || group.resolved || group.done
          || group.staging || group.transactionId) {
        throw new Error(`goal lease transaction recovery required: ${group.firstPath}`);
      }
      archiveAbortedStaging(controlDir, controlPin, auditPin, marker, group);
      return reconcileGoalLeaseTransactionLocked(
        runDir,
        options,
        { controlDir, controlPin }
      );
    }
    assertLiveMarkerTransaction(marker, group.transactionId);
    if (!group.invalid && !group.pending && !group.resolved && !group.done
        && group.staging && group.staging.length === 1) {
      restoreStagedFence(group, controlPin, fenceFile, runDir, options);
      return reconcileGoalLeaseTransactionLocked(
        runDir,
        options,
        { controlDir, controlPin }
      );
    }
    finishInterruptedFenceClaim(group, controlPin, authorityFile);
    return reconcileGoalLeaseTransactionLocked(
      runDir,
      options,
      { controlDir, controlPin }
    );
  }

  const transaction = parseGoalLeaseTransaction(fenceSnapshot.raw);
  assertLiveMarkerTransaction(marker, transaction.value.transactionId);
  assertTransactionMetadata(transaction);
  const expectedPending = fenceArtifactPath(
    fenceFile,
    'pending',
    transaction.value.transactionId,
    fenceSnapshot
  );
  for (const group of groups.values()) {
    if (isFinalizedFenceGroup(group)) continue;
    const stagingMatchesFence = (group.staging || []).every((file) => sameClaimedFile(
      readOptionalRawSnapshot(file),
      fenceSnapshot
    ));
    const pendingMatches = !group.pending
      || group.pending === expectedPending
      || (group.privateGeneration
        && group.pending === privateFencePath(group.privateGeneration, 'pending'));
    if (!group.invalid && !group.resolved && !group.done
        && pendingMatches
        && stagingMatchesFence
        && group.transactionId === transaction.value.transactionId
        && group.device === fenceSnapshot.device
        && group.inode === fenceSnapshot.inode) {
      continue;
    }
    throw new Error(`goal lease transaction recovery required: ${group.firstPath}`);
  }

  rollbackAuthorityCompareAndSwap(authorityFile, transaction, controlPin);
  rollbackProjectionCompareAndSwap(transaction);
  const verifyBefore = () => assertTransactionTerminal(
    transaction,
    authorityFile,
    'before',
    controlPin
  );
  verifyBefore();
  finalizeFenceClaim(fenceFile, fenceSnapshot.raw, controlPin, transaction, verifyBefore);
  return reconcileGoalLeaseTransactionLocked(
    runDir,
    options,
    { controlDir, controlPin }
  );
}

function readGoalLeaseUnlocked(runDir, options = {}) {
  const controlDir = controlStore.ensureControlRunDir(runDir, options);
  controlStore.assertAuthoritativeControlPath(runDir, controlDir, options);
  const readBinding = captureGoalReadBinding(runDir, options);
  assertNoGoalLeaseTransaction(controlDir);
  const file = path.join(controlDir, GOAL_LEASE_FILE);
  const snapshot = readOptionalRawSnapshot(file);
  assertNoGoalLeaseTransaction(controlDir);
  assertGoalReadBinding(runDir, options, readBinding);
  return snapshot ? JSON.parse(snapshot.raw.toString('utf8')) : null;
}

function transactionArtifactsRequireLock(controlDir) {
  if (fs.existsSync(transactionPath(controlDir))) return true;
  const marker = readLayoutMarkerSnapshot(controlDir);
  return !marker || marker.value.status !== 'clean';
}

function sameOptionalRawSnapshot(left, right) {
  return (left === null && right === null) || sameRawSnapshot(left, right);
}

function tryReadStableGoalLease(runDir, options = {}) {
  const controlDir = controlStore.ensureControlRunDir(runDir, options);
  controlStore.assertAuthoritativeControlPath(runDir, controlDir, options);
  const readBinding = captureGoalReadBinding(runDir, options);
  const controlPin = captureDirectoryIdentity(
    controlDir,
    'Goal lease authoritative control directory'
  );
  const file = path.join(controlDir, GOAL_LEASE_FILE);
  assertPinnedControlFile(controlPin, file, 'Goal lease authority');
  if (transactionArtifactsRequireLock(controlDir)) return null;
  const firstMarker = readLayoutMarkerSnapshot(controlDir);
  const first = readOptionalRawSnapshot(file);
  if (transactionArtifactsRequireLock(controlDir)) return null;
  const second = readOptionalRawSnapshot(file);
  const secondMarker = readLayoutMarkerSnapshot(controlDir);
  if (transactionArtifactsRequireLock(controlDir)) return null;
  assertGoalReadBinding(runDir, options, readBinding);
  controlStore.assertAuthoritativeControlPath(runDir, controlDir, options);
  assertPinnedControlFile(controlPin, file, 'Goal lease authority');
  if (!firstMarker || !secondMarker
      || !sameRawSnapshot(firstMarker.snapshot, secondMarker.snapshot)
      || !sameOptionalRawSnapshot(first, second)) return null;
  return {
    stable: true,
    value: second ? JSON.parse(second.raw.toString('utf8')) : null,
  };
}

function readGoalLease(runDir, options = {}) {
  const fastRead = tryReadStableGoalLease(runDir, options);
  if (fastRead) return fastRead.value;
  return runLock.withRunLock(
    runDir,
    'goal-lease-update',
    { command: 'goal-read' },
    () => {
      reconcileGoalLeaseTransactionLocked(runDir, options);
      return readGoalLeaseUnlocked(runDir, options);
    },
    goalLockOptions(options)
  );
}

function writeGoalLeaseLocked(runDir, lease, options = {}, preparedProjectionTarget = null) {
  // Fix the provider-visible target before any authoritative lease mutation.
  // After commit, the lexical runDir may be provider-retargeted and must never
  // be resolved again for the non-authoritative projection.
  const projectionTarget = preparedProjectionTarget || prepareProjectionTarget(runDir);
  const controlDir = controlStore.ensureControlRunDir(runDir, options);
  const controlPin = captureDirectoryIdentity(
    controlDir,
    'Goal lease authoritative control directory'
  );
  const file = path.join(controlDir, GOAL_LEASE_FILE);
  const fenceFile = transactionPath(controlDir);
  reconcileGoalLeaseTransactionLocked(
    runDir,
    options,
    { controlDir, controlPin }
  );
  const initialBinding = assertProjectionTargetBinding(runDir, projectionTarget, options);
  const assertBeforeAuthorityCommit = () => {
    controlStore.assertAuthoritativeControlPath(runDir, controlDir, options);
    controlStore.assertAuthoritativeControlPath(runDir, file, options);
    controlStore.assertAuthoritativeControlPath(runDir, fenceFile, options);
    assertPinnedControlFile(controlPin, file, 'Goal lease authority');
    assertProjectionTargetBinding(runDir, projectionTarget, options, initialBinding);
  };
  assertNoGoalLeaseTransaction(controlDir);
  assertBeforeAuthorityCommit();

  const beforeAuthority = readOptionalRaw(file);
  const beforeProjection = readOptionalRaw(projectionTarget.file);
  const afterAuthority = serializeJson(lease);
  const afterProjection = serializeJson(goalLeaseProjection(lease));
  const transactionValue = createGoalLeaseTransaction(
    initialBinding,
    projectionTarget,
    beforeAuthority,
    afterAuthority,
    beforeProjection,
    afterProjection
  );
  const transactionRaw = serializeJson(transactionValue);
  let fencePublished = false;

  try {
    writeLayoutMarker(
      controlDir,
      controlPin,
      'live',
      transactionValue.transactionId
    );
    publishRawExclusive(fenceFile, transactionRaw, {
      beforeWrite: assertBeforeAuthorityCommit,
      afterPublish: () => {
        fencePublished = true;
      },
    });

    // The projection is non-authoritative, but it must be complete before the
    // authority can change. No provider path is written after authority commit.
    writeRawAtomic(projectionTarget.file, afterProjection, {
      beforeWrite: assertBeforeAuthorityCommit,
    });
    assertBeforeAuthorityCommit();
    writeRawAtomic(file, afterAuthority, {
      beforeWrite: assertBeforeAuthorityCommit,
    });

    // This read-only validation closes rename-time retargeting. Atomically
    // moving the canonical fence into its identity-bound resolved evidence is
    // the commit marker; no provider path is touched after authority commit.
    assertPinnedControlFile(controlPin, file, 'Goal lease authority');
    assertProjectionTargetBinding(runDir, projectionTarget, options, initialBinding);
    const committedAuthority = readOptionalRaw(file);
    if (committedAuthority === null || !committedAuthority.equals(afterAuthority)) {
      throw new Error('Goal lease authority changed before transaction commit');
    }
    const transaction = parseGoalLeaseTransaction(transactionRaw);
    const verifyAfter = () => assertTransactionTerminal(
      transaction,
      file,
      'after',
      controlPin
    );
    verifyAfter();
    finalizeFenceClaim(fenceFile, transactionRaw, controlPin, transaction, verifyAfter);
    reconcileGoalLeaseTransactionLocked(
      runDir,
      options,
      { controlDir, controlPin }
    );
    return file;
  } catch (error) {
    try {
      reconcileGoalLeaseTransactionLocked(runDir, options, { controlDir, controlPin });
      const committed = readOptionalRawSnapshot(file);
      if (fencePublished
          && !fs.existsSync(fenceFile)
          && committed
          && committed.raw.equals(afterAuthority)) {
        assertNoGoalLeaseTransaction(controlDir);
        return file;
      }
    } catch (rollbackError) {
      throw new Error(
        `goal lease transaction recovery required after rollback failure: ${rollbackError.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}

function writeGoalLease(runDir, lease, options = {}) {
  const projectionTarget = prepareProjectionTarget(runDir);
  return runLock.withRunLock(
    runDir,
    'goal-lease-update',
    { command: 'goal-write', runId: lease && lease.runId },
    () => writeGoalLeaseLocked(runDir, lease, options, projectionTarget),
    goalLockOptions(options)
  );
}

function validateGoalLeaseForDispatch(existing, input = {}) {
  if (!existing || existing.status === 'released') return null;
  if (existing.status !== 'active') {
    throw new Error(`goal lease status ${existing.status} cannot authorize provider dispatch`);
  }
  if (existing.runId !== String(input.runId || '')) {
    throw new Error(`goal lease run conflict: expected ${existing.runId}`);
  }
  if (!RUNTIMES.has(input.providerRuntime) && !(input.providerRuntime === 'openai-compatible' && input.providerIntent === 'read-only')) {
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
  validateInput(input);
  const projectionTarget = prepareProjectionTarget(runDir);
  return runLock.withRunLock(
    runDir,
    'goal-lease-update',
    { command: 'goal-bind', runId: input && input.runId },
    () => {
      reconcileGoalLeaseTransactionLocked(runDir, options);
      const existing = readGoalLeaseUnlocked(runDir, options);
      assertExpectedRevision(existing, options.expectedRevision);
      const lease = acquireGoalLease(existing, input);
      writeGoalLeaseLocked(runDir, lease, options, projectionTarget);
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
      reconcileGoalLeaseTransactionLocked(runDir, options);
      const existing = readGoalLeaseUnlocked(runDir, options);
      assertExpectedRevision(existing, options.expectedRevision);
      const lease = releaseGoalLease(existing, options);
      writeGoalLeaseLocked(runDir, lease, options);
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
      reconcileGoalLeaseTransactionLocked(runDir, options);
      const existing = readGoalLeaseUnlocked(runDir, options);
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
  GOAL_LEASE_TRANSACTION_FILE,
  GOAL_LEASE_LAYOUT_FILE,
  GOAL_LEASE_AUDIT_DIR,
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
