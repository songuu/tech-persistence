#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  defaultRunCodex,
  resolveCodexInvocation,
} = require('./codex-plugin-cli');
const {
  hashPath,
  normalizePluginOwners,
} = require('./codex-runtime-doctor');
const {
  marketplaceExpectationFromRaw,
  publishTextCompareAndSwap,
  reconcilePublishJournal,
  stripLeadingBom,
  transformMarketplaceText,
} = require('./update-codex-marketplace');

const SCHEMA_VERSION = 1;
const PLUGIN_NAME = 'tech-persistence';
const DEFAULT_CANONICAL_OWNER = 'tech-persistence@local-plugins';
const DEFAULT_MARKETPLACE_NAME = 'local-plugins';
const LOCK_RELEASE_FAILURE_DISPOSITIONS = Object.freeze({
  committed: 'committed-lock-release-failed',
  'rolled-back': 'rolled-back-lock-release-failed',
  'recovery-required': 'recovery-required-lock-release-failed',
  'prepare-failed': 'prepare-failed-lock-release-failed',
});
const TERMINAL_STATES = new Set([
  'committed',
  'rolled-back',
  'recovery-required',
  'prepare-failed',
  'prepare-abandoned',
]);

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizePath(value) {
  let normalized = String(value || '');
  if (process.platform === 'win32' && normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4);
  }
  normalized = path.resolve(normalized);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNoLinkComponents(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!pathIsInside(resolvedRoot, resolvedCandidate)) {
    throw new Error(`${label} escapes the canonical user root: ${resolvedCandidate}`);
  }
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (pathExists(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} crosses a symbolic link or junction: ${current}`);
    }
  }
}

function assertTransactionBoundaries(inputs, evidenceRoot) {
  const codexHome = path.resolve(inputs.codexHome);
  const userHome = path.dirname(codexHome);
  const canonicalEvidenceRoot = path.join(codexHome, 'installer-transactions');
  const resolvedEvidence = path.resolve(evidenceRoot);
  const evidenceRelative = path.relative(canonicalEvidenceRoot, resolvedEvidence);
  const evidenceSegments = evidenceRelative.split(path.sep).filter(Boolean);
  if (
    path.basename(codexHome) !== '.codex'
    || !samePath(inputs.pluginTarget, path.join(userHome, 'plugins', PLUGIN_NAME))
    || !samePath(inputs.marketplaceRoot, userHome)
    || !samePath(
      inputs.marketplacePath,
      path.join(userHome, '.agents', 'plugins', 'marketplace.json')
    )
    || inputs.marketplaceName !== DEFAULT_MARKETPLACE_NAME
    || inputs.canonicalOwner !== DEFAULT_CANONICAL_OWNER
    || !pathIsInside(canonicalEvidenceRoot, resolvedEvidence)
    || evidenceSegments.length > 1
    || (
      evidenceSegments.length === 1
      && !/^[0-9]{17}-[0-9]+-[0-9a-f]{8}$/.test(evidenceSegments[0])
    )
  ) {
    throw new Error('Codex user-install transaction paths do not match the canonical user-home layout');
  }
  assertNoLinkComponents(userHome, inputs.codexHome, 'Codex home');
  assertNoLinkComponents(userHome, inputs.pluginTarget, 'plugin target');
  assertNoLinkComponents(userHome, inputs.marketplacePath, 'marketplace file');
  assertNoLinkComponents(userHome, resolvedEvidence, 'transaction evidence');
}

function assertPlainRoot(target, label) {
  if (!pathExists(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link or junction: ${target}`);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`${label} has an unsupported filesystem type: ${target}`);
  }
}

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  syncDirectory(path.dirname(target));
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EPERM', 'EISDIR', 'EINVAL', 'EBADF', 'ENOTSUP'].includes(error && error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function copyPath(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    fs.cpSync(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      dereference: false,
    });
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  } else {
    throw new Error(`cannot snapshot unsupported path type: ${source}`);
  }
}

function fsyncTree(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`cannot durably snapshot a symbolic link: ${target}`);
  if (stat.isFile()) {
    const descriptor = fs.openSync(target, process.platform === 'win32' ? 'r+' : 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    return;
  }
  if (!stat.isDirectory()) throw new Error(`cannot durably snapshot unsupported path type: ${target}`);
  for (const entry of fs.readdirSync(target)) fsyncTree(path.join(target, entry));
  syncDirectory(target);
}

function pathKind(target) {
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'unsupported';
}

function posixMode(target) {
  if (process.platform === 'win32' || !pathExists(target)) return null;
  return fs.lstatSync(target).mode & 0o777;
}

function snapshotPath(target, backup, label) {
  assertPlainRoot(target, label);
  if (!pathExists(target)) {
    return {
      label,
      target: path.resolve(target),
      existed: false,
      kind: null,
      sha256: null,
      posixMode: null,
      backup: null,
    };
  }
  const record = {
    label,
    target: path.resolve(target),
    existed: true,
    kind: pathKind(target),
    sha256: hashPath(target),
    posixMode: posixMode(target),
    backup: path.resolve(backup),
  };
  copyPath(target, backup);
  fsyncTree(backup);
  if (hashPath(backup) !== record.sha256 || pathKind(backup) !== record.kind) {
    throw new Error(`${label} snapshot verification failed: ${target}`);
  }
  return record;
}

function verifySnapshot(record) {
  if (!record.existed) return true;
  if (!record.backup || !pathExists(record.backup)) {
    throw new Error(`${record.label} verified backup is missing: ${record.backup || '<none>'}`);
  }
  if (pathKind(record.backup) !== record.kind || hashPath(record.backup) !== record.sha256) {
    throw new Error(`${record.label} verified backup changed: ${record.backup}`);
  }
  if (record.posixMode !== null && posixMode(record.backup) !== record.posixMode) {
    throw new Error(`${record.label} verified backup mode changed: ${record.backup}`);
  }
  return true;
}

function currentPathRecord(target) {
  if (!pathExists(target)) {
    return { target: path.resolve(target), existed: false, kind: null, sha256: null, posixMode: null };
  }
  return {
    target: path.resolve(target),
    existed: true,
    kind: pathKind(target),
    sha256: hashPath(target),
    posixMode: posixMode(target),
  };
}

function uniqueSibling(target, marker, transactionId) {
  const base = `${target}.${marker}.${transactionId}`;
  if (!pathExists(base)) return base;
  return `${base}.${crypto.randomBytes(4).toString('hex')}`;
}

function restorePath(record, transactionId, options = {}) {
  verifySnapshot(record);
  const target = record.target;
  const current = currentPathRecord(target);
  if (
    current.existed === record.existed
    && (!record.existed || (
      current.kind === record.kind
      && current.sha256 === record.sha256
      && (record.posixMode === null || current.posixMode === record.posixMode)
    ))
  ) {
    return { ok: true, noop: true, target };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const preserved = current.existed
    ? options.preserveRoot
      ? path.join(
        path.resolve(options.preserveRoot),
        `${sha256(normalizePath(target)).slice(0, 16)}-${crypto.randomBytes(4).toString('hex')}`
      )
      : uniqueSibling(target, 'failed-install', transactionId)
    : null;
  const stage = record.existed
    ? uniqueSibling(target, 'restore-stage', transactionId)
    : null;

  if (record.existed) {
    copyPath(record.backup, stage);
    if (pathKind(stage) !== record.kind || hashPath(stage) !== record.sha256) {
      throw new Error(`${record.label} restore stage verification failed: ${stage}`);
    }
    if (record.posixMode !== null) fs.chmodSync(stage, record.posixMode);
  }

  try {
    if (preserved && options.preserveRoot) {
      fs.mkdirSync(path.dirname(preserved), { recursive: true, mode: 0o700 });
    }
    if (current.existed) fs.renameSync(target, preserved);
    if (record.existed) fs.renameSync(stage, target);
  } catch (error) {
    if (stage && pathExists(stage) && !pathExists(target)) {
      // Keep the verified restore stage as evidence until the original path is put back.
    }
    if (preserved && pathExists(preserved) && !pathExists(target)) {
      try { fs.renameSync(preserved, target); } catch { /* fail closed below */ }
    }
    throw new Error(`${record.label} atomic restore failed: ${error.message}`);
  }

  const restored = currentPathRecord(target);
  if (
    restored.existed !== record.existed
    || (record.existed && (
      restored.kind !== record.kind
      || restored.sha256 !== record.sha256
      || (record.posixMode !== null && restored.posixMode !== record.posixMode)
    ))
  ) {
    throw new Error(`${record.label} restored state does not match the verified snapshot`);
  }
  return {
    ok: true,
    noop: false,
    target,
    preservedFailedState: preserved,
    restoredSha256: record.sha256,
  };
}

function pathRecordFromSnapshot(record) {
  return {
    target: path.resolve(record.target),
    existed: record.existed,
    kind: record.kind,
    sha256: record.sha256,
    posixMode: record.posixMode,
  };
}

function pathRecordPayloadMatches(actual, expected) {
  return Boolean(actual) && Boolean(expected)
    && actual.existed === expected.existed
    && (!expected.existed || (
      actual.kind === expected.kind
      && actual.sha256 === expected.sha256
      && (expected.posixMode === null || actual.posixMode === expected.posixMode)
    ));
}

function createRestoreOperation(record, step, transactionId, preserveRoot, gateBefore) {
  verifySnapshot(record);
  const before = currentPathRecord(record.target);
  if (!pathRecordsMatch(before, gateBefore)) {
    throw new Error(`${record.label} changed after the rollback ownership gate`);
  }
  const desired = pathRecordFromSnapshot(record);
  const noop = pathRecordsMatch(before, desired);
  const preserved = !noop && before.existed
    ? path.join(
      path.resolve(preserveRoot),
      `${sha256(normalizePath(record.target)).slice(0, 16)}-${crypto.randomBytes(4).toString('hex')}`
    )
    : null;
  const stage = !noop && record.existed
    ? uniqueSibling(record.target, 'restore-stage', transactionId)
    : null;
  return {
    schemaVersion: 1,
    step,
    target: path.resolve(record.target),
    preserveRoot: path.resolve(preserveRoot),
    preserved,
    stage,
    before,
    gateBefore,
    desired,
    noop,
    status: noop ? 'complete' : 'planned',
    planningEvidence: [],
    createdAt: new Date().toISOString(),
  };
}

function persistRestoreOperation(operation, options) {
  if (typeof options.persist === 'function') options.persist(operation);
}

function assertRestorePreserveRoot(operation, transactionRoot, create = false) {
  assertNoLinkComponents(transactionRoot, operation.preserveRoot, 'rollback preserve root');
  if (create) {
    fs.mkdirSync(operation.preserveRoot, { recursive: true, mode: 0o700 });
    syncDirectory(path.dirname(operation.preserveRoot));
  }
  assertNoLinkComponents(transactionRoot, operation.preserveRoot, 'rollback preserve root');
  assertPlainRoot(operation.preserveRoot, 'rollback preserve root');
  if (!fs.lstatSync(operation.preserveRoot).isDirectory()) {
    throw new Error(`rollback preserve root must be a directory: ${operation.preserveRoot}`);
  }
}

function recoverPartialStageEvidence(operation, options) {
  const pendingEntries = operation.planningEvidence.filter((entry) => entry.status === 'planned');
  if (pendingEntries.length > 1) {
    throw new Error(`rollback planning has multiple pending evidence moves: ${operation.step}`);
  }
  for (const entry of operation.planningEvidence.filter((candidate) => candidate.status === 'moved')) {
    if (!pathRecordPayloadMatches(pathRecordAtArtifact(entry.to), entry.observed)) {
      throw new Error(`rollback planning evidence contains external drift: ${entry.to}`);
    }
  }
  const pending = pendingEntries[0];
  if (!pending) return;
  const stageNow = pathRecordAtArtifact(pending.from);
  const evidenceNow = pathRecordAtArtifact(pending.to);
  if (!stageNow && pathRecordPayloadMatches(evidenceNow, pending.observed)) {
    fsyncTree(pending.to);
    pending.status = 'moved';
    pending.movedAt = new Date().toISOString();
    persistRestoreOperation(operation, options);
    return;
  }
  if (!pathRecordPayloadMatches(stageNow, pending.observed) || evidenceNow) {
    throw new Error(`rollback planning evidence contains external drift: ${pending.from}`);
  }
  fs.renameSync(pending.from, pending.to);
  fsyncTree(pending.to);
  syncDirectory(path.dirname(pending.from));
  syncDirectory(path.dirname(pending.to));
  pending.status = 'moved';
  pending.movedAt = new Date().toISOString();
  persistRestoreOperation(operation, options);
}

function materializeRestoreOperation(operation, record, options = {}) {
  validateRestoreOperation(operation, record, options.transactionRoot);
  if (operation.noop) return operation;
  if (operation.status !== 'planned') {
    const staged = pathRecordAtArtifact(operation.stage);
    if (
      (operation.status === 'prepared' || (operation.status === 'claimed' && record.existed))
      && !pathRecordPayloadMatches(staged, operation.desired)
    ) {
      throw new Error(`${record.label} prepared restore stage contains external drift`);
    }
    return operation;
  }
  assertRestorePreserveRoot(operation, options.transactionRoot, true);
  recoverPartialStageEvidence(operation, options);
  if (!record.existed) {
    operation.status = 'prepared';
    persistRestoreOperation(operation, options);
    return operation;
  }
  if (pathExists(operation.stage)) {
    const staged = currentPathRecord(operation.stage);
    if (pathRecordPayloadMatches(staged, operation.desired)) {
      fsyncTree(operation.stage);
      operation.status = 'prepared';
      persistRestoreOperation(operation, options);
      return operation;
    }
    const partialEvidence = path.join(
      operation.preserveRoot,
      `planning-partial-${operation.step}-${String(operation.planningEvidence.length).padStart(4, '0')}`
    );
    if (pathExists(partialEvidence)) {
      throw new Error(`rollback planning evidence path already exists: ${partialEvidence}`);
    }
    operation.planningEvidence.push({
      from: operation.stage,
      to: partialEvidence,
      observed: staged,
      status: 'planned',
      plannedAt: new Date().toISOString(),
    });
    persistRestoreOperation(operation, options);
    recoverPartialStageEvidence(operation, options);
  }
  copyPath(record.backup, operation.stage);
  const staged = currentPathRecord(operation.stage);
  if (!pathRecordPayloadMatches(staged, operation.desired)) {
    throw new Error(`${record.label} restore stage verification failed: ${operation.stage}`);
  }
  if (record.posixMode !== null) fs.chmodSync(operation.stage, record.posixMode);
  fsyncTree(operation.stage);
  operation.status = 'prepared';
  persistRestoreOperation(operation, options);
  return operation;
}

function validateRestoreOperation(operation, record, transactionRoot) {
  const transactionId = path.basename(path.resolve(transactionRoot));
  const stageBase = `${path.resolve(record.target)}.restore-stage.${transactionId}`;
  const preserveGroup = operation?.step === 'restore-plugin-target'
    || operation?.step === 'restore-marketplace-file'
    ? 'filesystem'
    : /^restore-plugin-cache-[0-9]{4}$/.test(operation?.step || '')
      ? 'plugin-cache'
      : null;
  const expectedPreserveRoot = preserveGroup
    ? path.join(path.resolve(transactionRoot), 'rollback-preserved', preserveGroup)
    : null;
  const preservedBasenamePrefix = `${sha256(normalizePath(record.target)).slice(0, 16)}-`;
  const stagePathIsBound = !operation?.stage || (
    path.dirname(path.resolve(operation.stage)) === path.dirname(path.resolve(record.target))
    && (
      samePath(operation.stage, stageBase)
      || (
        path.basename(operation.stage).startsWith(`${path.basename(stageBase)}.`)
        && /^[0-9a-f]{8}$/.test(
          path.basename(operation.stage).slice(path.basename(stageBase).length + 1)
        )
      )
    )
  );
  const preservedPathIsBound = !operation?.preserved || (
    expectedPreserveRoot
    && path.dirname(path.resolve(operation.preserved)) === path.resolve(expectedPreserveRoot)
    && path.basename(operation.preserved).startsWith(preservedBasenamePrefix)
    && /^[0-9a-f]{8}$/.test(
      path.basename(operation.preserved).slice(preservedBasenamePrefix.length)
    )
  );
  if (
    !operation
    || operation.schemaVersion !== 1
    || operation.target !== path.resolve(record.target)
    || !expectedPreserveRoot
    || !samePath(operation.preserveRoot, expectedPreserveRoot)
    || !preservedPathIsBound
    || (operation.preserved && !pathIsInside(operation.preserveRoot, operation.preserved))
    || !stagePathIsBound
    || (!operation.noop && record.existed && !operation.stage)
    || ((!record.existed || operation.noop) && operation.stage)
    || (!operation.noop && operation.before.existed && !operation.preserved)
    || ((operation.noop || !operation.before.existed) && operation.preserved)
    || !pathRecordsMatch(operation.before, operation.gateBefore)
    || !pathRecordsMatch(operation.desired, pathRecordFromSnapshot(record))
    || !['planned', 'prepared', 'claimed', 'published', 'complete'].includes(operation.status)
    || !Array.isArray(operation.planningEvidence)
    || operation.planningEvidence.some((entry, index) => (
      !entry
      || !['planned', 'moved'].includes(entry.status)
      || path.resolve(entry.from || '') !== path.resolve(operation.stage || '')
      || !samePath(
        entry.to || '',
        path.join(
          operation.preserveRoot,
          `planning-partial-${operation.step}-${String(index).padStart(4, '0')}`
        )
      )
      || path.resolve(entry.observed?.target || '') !== path.resolve(operation.stage || '')
    ))
    || (operation.noop && (
      !pathRecordsMatch(operation.before, operation.desired)
      || operation.preserved
      || operation.stage
      || operation.status !== 'complete'
      || operation.planningEvidence.length !== 0
    ))
  ) {
    throw new Error(`rollback restore operation is invalid for ${record.label}`);
  }
  verifySnapshot(record);
}

function pathRecordAtArtifact(target) {
  if (!target || !pathExists(target)) return null;
  return currentPathRecord(target);
}

function executeRestoreOperation(operation, record, options = {}) {
  validateRestoreOperation(operation, record, options.transactionRoot);
  const beforeNow = currentPathRecord(operation.target);
  if (operation.noop) {
    if (!pathRecordsMatch(beforeNow, operation.desired)) {
      throw new Error(`${record.label} changed after its rollback noop was durably bound`);
    }
    return { ok: true, noop: true, target: operation.target };
  }
  const preservedNow = pathRecordAtArtifact(operation.preserved);
  const stageNow = pathRecordAtArtifact(operation.stage);
  const desired = operation.desired;

  if (pathRecordsMatch(beforeNow, desired)) {
    if (operation.before.existed && !pathRecordPayloadMatches(preservedNow, operation.before)) {
      throw new Error(`${record.label} published rollback has drifted preserved evidence`);
    }
    operation.status = 'complete';
    persistRestoreOperation(operation, options);
    if (typeof options.afterComplete === 'function') options.afterComplete(operation.step);
    return {
      ok: true,
      noop: false,
      recovered: true,
      target: operation.target,
      preservedFailedState: operation.preserved,
      restoredSha256: record.sha256,
    };
  }

  const beforeStillCanonical = pathRecordsMatch(beforeNow, operation.before);
  const beforeClaimed = !beforeNow.existed
    && (!operation.before.existed || pathRecordPayloadMatches(preservedNow, operation.before));
  const stageReady = !record.existed || pathRecordPayloadMatches(stageNow, desired);
  if (!stageReady || (!beforeStillCanonical && !beforeClaimed)) {
    throw new Error(`${record.label} rollback restore artifacts contain external drift`);
  }

  fs.mkdirSync(path.dirname(operation.target), { recursive: true });
  assertRestorePreserveRoot(operation, options.transactionRoot, true);
  if (beforeStillCanonical && operation.before.existed) {
    if (typeof options.beforeMutation === 'function') options.beforeMutation(operation.step, 'claim');
    assertRestorePreserveRoot(operation, options.transactionRoot);
    if (
      !pathRecordsMatch(currentPathRecord(operation.target), operation.before)
      || pathExists(operation.preserved)
      || (record.existed && !pathRecordPayloadMatches(pathRecordAtArtifact(operation.stage), desired))
    ) {
      throw new Error(`${record.label} changed immediately before its rollback claim`);
    }
    fs.renameSync(operation.target, operation.preserved);
    syncDirectory(path.dirname(operation.target));
    syncDirectory(path.dirname(operation.preserved));
    operation.status = 'claimed';
    persistRestoreOperation(operation, options);
    if (typeof options.afterClaim === 'function') options.afterClaim(operation.step);
  }
  if (record.existed && !pathExists(operation.target)) {
    if (typeof options.beforeMutation === 'function') options.beforeMutation(operation.step, 'publish');
    assertRestorePreserveRoot(operation, options.transactionRoot);
    if (
      pathExists(operation.target)
      || !pathRecordPayloadMatches(pathRecordAtArtifact(operation.stage), desired)
      || (operation.before.existed && !pathRecordPayloadMatches(pathRecordAtArtifact(operation.preserved), operation.before))
    ) {
      throw new Error(`${record.label} changed immediately before its rollback publish`);
    }
    fs.renameSync(operation.stage, operation.target);
    syncDirectory(path.dirname(operation.target));
    operation.status = 'published';
    persistRestoreOperation(operation, options);
    if (typeof options.afterPublish === 'function') options.afterPublish(operation.step);
  }
  const restored = currentPathRecord(operation.target);
  if (!pathRecordsMatch(restored, desired)) {
    throw new Error(`${record.label} restored state does not match the verified snapshot`);
  }
  operation.status = 'complete';
  persistRestoreOperation(operation, options);
  if (typeof options.afterComplete === 'function') options.afterComplete(operation.step);
  return {
    ok: true,
    noop: false,
    target: operation.target,
    preservedFailedState: operation.preserved,
    restoredSha256: record.sha256,
  };
}

function pluginVersion(pluginRoot) {
  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return typeof manifest.version === 'string' ? manifest.version : null;
}

function pluginBundleRecord(pluginRoot) {
  assertPlainRoot(pluginRoot, 'plugin target');
  if (!pathExists(pluginRoot)) throw new Error(`plugin target is missing: ${pluginRoot}`);
  if (pathExists(path.join(pluginRoot, 'commands'))) {
    throw new Error(`Codex plugin target contains forbidden legacy commands: ${pluginRoot}`);
  }
  const version = pluginVersion(pluginRoot);
  if (!version) throw new Error(`plugin target has no valid version: ${pluginRoot}`);
  return {
    target: path.resolve(pluginRoot),
    sha256: hashPath(pluginRoot),
    bundleSha256: hashPath(pluginRoot, { ignoreTopLevel: ['commands'] }),
    version,
  };
}

function pluginSourceRecord(pluginRoot) {
  assertPlainRoot(pluginRoot, 'plugin source');
  if (!pathExists(pluginRoot)) throw new Error(`plugin source is missing: ${pluginRoot}`);
  const version = pluginVersion(pluginRoot);
  if (!version) throw new Error(`plugin source has no valid version: ${pluginRoot}`);
  return {
    target: path.resolve(pluginRoot),
    sha256: hashPath(pluginRoot),
    bundleSha256: hashPath(pluginRoot, { ignoreTopLevel: ['commands'] }),
    version,
  };
}

function assertSafePathSegment(value, label) {
  if (
    typeof value !== 'string'
    || !value
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
  ) {
    throw new Error(`unsafe ${label}: ${value}`);
  }
  return value;
}

function marketplaceFromPluginId(pluginId) {
  const prefix = `${PLUGIN_NAME}@`;
  if (typeof pluginId !== 'string' || !pluginId.startsWith(prefix)) {
    throw new Error(`unsafe plugin id for cache resolution: ${pluginId}`);
  }
  return assertSafePathSegment(pluginId.slice(prefix.length), 'marketplace cache segment');
}

function pluginCacheRoot(codexHome) {
  return path.join(path.resolve(codexHome), 'plugins', 'cache');
}

function cachePathFor(codexHome, marketplaceName, version) {
  return path.join(
    pluginCacheRoot(codexHome),
    assertSafePathSegment(marketplaceName, 'marketplace cache segment'),
    PLUGIN_NAME,
    assertSafePathSegment(version, 'plugin cache version')
  );
}

function cachePathForOwner(codexHome, owner) {
  return cachePathFor(codexHome, marketplaceFromPluginId(owner.pluginId), owner.version);
}

function discoverPluginCaches(codexHome) {
  const root = pluginCacheRoot(codexHome);
  if (!pathExists(root)) return [];
  const userHome = path.dirname(path.resolve(codexHome));
  assertNoLinkComponents(userHome, root, 'plugin cache root');
  assertPlainRoot(root, 'plugin cache root');
  const records = [];
  for (const marketplaceEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (marketplaceEntry.isSymbolicLink()) {
      throw new Error(`plugin cache marketplace must not be a symbolic link or junction: ${marketplaceEntry.name}`);
    }
    if (!marketplaceEntry.isDirectory()) continue;
    const marketplaceName = assertSafePathSegment(
      marketplaceEntry.name,
      'marketplace cache segment'
    );
    const pluginRoot = path.join(root, marketplaceName, PLUGIN_NAME);
    if (!pathExists(pluginRoot)) continue;
    assertNoLinkComponents(userHome, pluginRoot, 'plugin cache path');
    assertPlainRoot(pluginRoot, 'plugin cache path');
    if (!fs.lstatSync(pluginRoot).isDirectory()) {
      throw new Error(`plugin cache root is not a directory: ${pluginRoot}`);
    }
    for (const versionEntry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
      if (versionEntry.isSymbolicLink()) {
        throw new Error(`plugin cache version must not be a symbolic link or junction: ${versionEntry.name}`);
      }
      if (!versionEntry.isDirectory()) continue;
      const version = assertSafePathSegment(versionEntry.name, 'plugin cache version');
      const cachePath = path.join(pluginRoot, version);
      assertNoLinkComponents(userHome, cachePath, 'plugin cache path');
      assertPlainRoot(cachePath, 'plugin cache path');
      records.push({
        marketplaceName,
        version,
        path: path.resolve(cachePath),
        sha256: hashPath(cachePath),
      });
    }
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function cacheStateByPath(caches) {
  return new Map(caches.map((cache) => [normalizePath(cache.path), cache]));
}

function enrichOwnersWithCache(owners, codexHome, caches = discoverPluginCaches(codexHome)) {
  const byPath = cacheStateByPath(caches);
  return owners.map((owner) => {
    const cachePath = cachePathForOwner(codexHome, owner);
    const cache = byPath.get(normalizePath(cachePath));
    if (!cache) {
      throw new Error(`enabled owner cache is missing: ${owner.pluginId} ${owner.version}`);
    }
    return {
      ...owner,
      cachePath: path.resolve(cachePath),
      cacheSha256: cache.sha256,
    };
  });
}

function snapshotPluginCaches(codexHome, owners, canonicalVersion, transactionRoot) {
  const discovered = discoverPluginCaches(codexHome);
  const paths = new Map(discovered.map((cache) => [normalizePath(cache.path), {
    path: cache.path,
    marketplaceName: cache.marketplaceName,
    version: cache.version,
  }]));
  const candidates = [
    ...owners.map((owner) => ({
      path: cachePathForOwner(codexHome, owner),
      marketplaceName: marketplaceFromPluginId(owner.pluginId),
      version: owner.version,
    })),
    {
      path: cachePathFor(codexHome, DEFAULT_MARKETPLACE_NAME, canonicalVersion),
      marketplaceName: DEFAULT_MARKETPLACE_NAME,
      version: canonicalVersion,
    },
  ];
  for (const candidate of candidates) paths.set(normalizePath(candidate.path), candidate);

  return [...paths.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((cache, index) => ({
      marketplaceName: cache.marketplaceName,
      version: cache.version,
      snapshot: snapshotPath(
        cache.path,
        path.join(transactionRoot, 'pre', 'plugin-cache', String(index).padStart(4, '0')),
        `plugin cache ${cache.marketplaceName}/${cache.version}`
      ),
    }));
}

function cacheStateFromSnapshots(cacheSnapshots) {
  return cacheSnapshots
    .filter((entry) => entry.snapshot.existed)
    .map((entry) => ({
      marketplaceName: entry.marketplaceName,
      version: entry.version,
      path: path.resolve(entry.snapshot.target),
      sha256: entry.snapshot.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function currentRuntimeState(inputs, runCodex, commands, stepPrefix) {
  const owners = probeOwners(runCodex, commands, `${stepPrefix}-owners`);
  const marketplaceRegistration = probeMarketplace(
    runCodex,
    inputs.marketplaceName,
    commands,
    `${stepPrefix}-marketplace`
  );
  const caches = discoverPluginCaches(inputs.codexHome);
  return {
    target: currentPathRecord(inputs.pluginTarget),
    marketplaceFile: currentPathRecord(inputs.marketplacePath),
    owners: enrichOwnersWithCache(owners, inputs.codexHome, caches),
    marketplaceRegistration,
    caches,
  };
}

function pathRecordsMatch(actual, expected) {
  return Boolean(actual) && Boolean(expected)
    && samePath(actual.target, expected.target)
    && actual.existed === expected.existed
    && (!expected.existed || (
      actual.kind === expected.kind
      && actual.sha256 === expected.sha256
      && (expected.posixMode === null || actual.posixMode === expected.posixMode)
    ));
}

function cacheStatesMatch(actual, expected) {
  if (actual.length !== expected.length) return false;
  const expectedByPath = cacheStateByPath(expected);
  return actual.every((cache) => {
    const match = expectedByPath.get(normalizePath(cache.path));
    return Boolean(match)
      && cache.marketplaceName === match.marketplaceName
      && cache.version === match.version
      && cache.sha256 === match.sha256;
  });
}

function runtimeStatesMatch(actual, expected) {
  return pathRecordsMatch(actual.target, expected.target)
    && pathRecordsMatch(actual.marketplaceFile, expected.marketplaceFile)
    && ownersMatch(actual.owners, expected.owners)
    && registrationsMatch(actual.marketplaceRegistration, expected.marketplaceRegistration)
    && cacheStatesMatch(actual.caches, expected.caches);
}

function expectedRegistration(inputs) {
  return {
    name: inputs.marketplaceName,
    root: inputs.marketplaceRoot,
    sourceType: 'local',
  };
}

function canonicalOwnerState(manifest, target) {
  return {
    pluginId: manifest.inputs.canonicalOwner,
    version: target.version,
    sourcePath: path.resolve(manifest.inputs.pluginTarget),
    enabled: true,
    cachePath: cachePathFor(
      manifest.inputs.codexHome,
      manifest.inputs.marketplaceName,
      target.version
    ),
    cacheSha256: target.sha256,
  };
}

function expectedCachePhaseState(manifest, previousState, target) {
  const canonicalOwner = canonicalOwnerState(manifest, target);
  const owners = manifest.pre.runtimeState.owners
    .filter((owner) => owner.pluginId !== canonicalOwner.pluginId)
    .concat(canonicalOwner)
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  const cacheByPath = cacheStateByPath(previousState.caches);
  cacheByPath.set(normalizePath(canonicalOwner.cachePath), {
    marketplaceName: manifest.inputs.marketplaceName,
    version: target.version,
    path: path.resolve(canonicalOwner.cachePath),
    sha256: target.sha256,
  });
  return {
    target: previousState.target,
    marketplaceFile: previousState.marketplaceFile,
    owners,
    marketplaceRegistration: previousState.marketplaceRegistration,
    caches: [...cacheByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function cacheRefreshStateMatches(manifest, actual, expected) {
  const expectedByPath = cacheStateByPath(expected);
  const actualByPath = cacheStateByPath(actual);
  for (const cache of actual) {
    const match = expectedByPath.get(normalizePath(cache.path));
    if (!match || match.sha256 !== cache.sha256) return false;
  }
  const removablePreOwnerCaches = new Set(
    manifest.pre.runtimeState.owners.map((owner) => normalizePath(owner.cachePath))
  );
  for (const cache of expected) {
    if (!actualByPath.has(normalizePath(cache.path))
      && !removablePreOwnerCaches.has(normalizePath(cache.path))) {
      return false;
    }
  }
  return true;
}

function stateSurfacesMatch(actual, expected, surfaces) {
  return surfaces.every((surface) => {
    if (surface === 'target' || surface === 'marketplaceFile') {
      return pathRecordsMatch(actual[surface], expected[surface]);
    }
    if (surface === 'owners') return ownersMatch(actual.owners, expected.owners);
    if (surface === 'marketplaceRegistration') {
      return registrationsMatch(actual.marketplaceRegistration, expected.marketplaceRegistration);
    }
    if (surface === 'caches') return cacheStatesMatch(actual.caches, expected.caches);
    throw new Error(`unknown runtime-state surface: ${surface}`);
  });
}

function assertStateSurfaces(actual, expected, surfaces, label) {
  if (!stateSurfacesMatch(actual, expected, surfaces)) {
    throw new Error(`${label} changed an out-of-scope runtime surface`);
  }
}

function latestCheckpoint(manifest) {
  const checkpoints = Array.isArray(manifest.checkpoints) ? manifest.checkpoints : [];
  return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
}

function invokeCodex(runCodex, args) {
  let result;
  try {
    result = runCodex(args);
  } catch (error) {
    result = { status: null, stdout: '', stderr: '', error };
  }
  return {
    args: ['codex', ...args],
    status: Number.isInteger(result && result.status) ? result.status : null,
    stdout: String((result && result.stdout) || ''),
    stderr: String((result && result.stderr) || ''),
    error: result && result.error ? String(result.error.message || result.error) : null,
  };
}

function commandRecord(step, invocation) {
  return {
    step,
    command: invocation.args,
    status: invocation.status,
    stdoutSha256: sha256(invocation.stdout),
    stderr: invocation.stderr.slice(0, 2000),
    error: invocation.error,
    ok: invocation.status === 0 && !invocation.error,
    at: new Date().toISOString(),
  };
}

function assertInvocation(invocation, label) {
  if (invocation.status !== 0 || invocation.error) {
    throw new Error(
      `${label} failed: ${invocation.error || invocation.stderr.trim() || `exit ${invocation.status}`}`
    );
  }
}

function parseJsonOutput(invocation, label) {
  assertInvocation(invocation, label);
  try {
    return JSON.parse(invocation.stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function ownerSnapshot(pluginList) {
  const owners = normalizePluginOwners(pluginList, PLUGIN_NAME).map((owner) => ({
    pluginId: owner.pluginId,
    version: typeof owner.version === 'string' ? owner.version : null,
    sourcePath: owner.source && typeof owner.source.path === 'string'
      ? path.resolve(owner.source.path)
      : null,
    enabled: owner.enabled !== false,
  }));
  for (const owner of owners) {
    if (typeof owner.pluginId !== 'string' || !owner.pluginId.startsWith(`${PLUGIN_NAME}@`)) {
      throw new Error(`official Codex owner probe returned an unsafe plugin id: ${owner.pluginId}`);
    }
  }
  if (new Set(owners.map((owner) => owner.pluginId)).size !== owners.length) {
    throw new Error('official Codex owner probe returned duplicate plugin ids');
  }
  return owners;
}

function normalizeMarketplaceList(value) {
  const marketplaces = Array.isArray(value)
    ? value
    : Array.isArray(value && value.marketplaces) ? value.marketplaces : [];
  return marketplaces.filter((entry) => entry && typeof entry.name === 'string');
}

function marketplaceSnapshot(value, marketplaceName) {
  const matches = normalizeMarketplaceList(value)
    .filter((entry) => entry.name === marketplaceName);
  if (matches.length > 1) {
    throw new Error(`official Codex marketplace list returned duplicate ${marketplaceName} entries`);
  }
  if (matches.length === 0) return null;
  const entry = matches[0];
  if (typeof entry.root !== 'string' || !entry.root.trim()) {
    throw new Error(`official Codex marketplace ${marketplaceName} has no restorable root`);
  }
  return {
    name: entry.name,
    root: path.resolve(entry.root),
    sourceType: entry.marketplaceSource && entry.marketplaceSource.sourceType
      ? entry.marketplaceSource.sourceType
      : 'local',
  };
}

function probeOwners(runCodex, commands, step) {
  const invocation = invokeCodex(runCodex, ['plugin', 'list', '--json']);
  commands.push(commandRecord(step, invocation));
  return ownerSnapshot(parseJsonOutput(invocation, 'official Codex plugin owner probe'));
}

function probeMarketplace(runCodex, marketplaceName, commands, step) {
  const invocation = invokeCodex(runCodex, ['plugin', 'marketplace', 'list', '--json']);
  commands.push(commandRecord(step, invocation));
  return marketplaceSnapshot(
    parseJsonOutput(invocation, 'official Codex marketplace probe'),
    marketplaceName
  );
}

function ownersMatch(actual, expected) {
  const actualById = new Map(actual.map((owner) => [owner.pluginId, owner]));
  const expectedById = new Map(expected.map((owner) => [owner.pluginId, owner]));
  if (actualById.size !== expectedById.size) return false;
  for (const [pluginId, expectedOwner] of expectedById) {
    const actualOwner = actualById.get(pluginId);
    if (!actualOwner) return false;
    if (expectedOwner.version !== null && actualOwner.version !== expectedOwner.version) return false;
    if (expectedOwner.sourcePath !== null && !samePath(actualOwner.sourcePath, expectedOwner.sourcePath)) {
      return false;
    }
    if (expectedOwner.cachePath && !samePath(actualOwner.cachePath, expectedOwner.cachePath)) {
      return false;
    }
    if (expectedOwner.cacheSha256 && actualOwner.cacheSha256 !== expectedOwner.cacheSha256) {
      return false;
    }
    if (actualOwner.enabled !== expectedOwner.enabled) return false;
  }
  return true;
}

function registrationsMatch(actual, expected) {
  if (!actual && !expected) return true;
  if (!actual || !expected) return false;
  return actual.name === expected.name
    && actual.sourceType === expected.sourceType
    && samePath(actual.root, expected.root);
}

function readManifest(manifestPath) {
  const resolved = path.resolve(manifestPath);
  const manifest = JSON.parse(readPlainFileBytes(resolved, 'transaction manifest').toString('utf8'));
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.kind !== 'codex-user-install') {
    throw new Error(`unsupported Codex user-install transaction manifest: ${resolved}`);
  }
  if (path.resolve(manifest.manifestPath) !== resolved) {
    throw new Error(`transaction manifest path mismatch: ${resolved}`);
  }
  if (!/^[0-9]{17}-[0-9]+-[0-9a-f]{8}$/.test(manifest.transactionId || '')) {
    throw new Error(`transaction manifest has an invalid id: ${resolved}`);
  }
  if (
    path.resolve(manifest.transactionRoot) !== path.dirname(resolved)
    || path.basename(path.resolve(manifest.transactionRoot)) !== manifest.transactionId
    || !Number.isSafeInteger(manifest.ownerPid)
    || manifest.ownerPid <= 0
    || !pathIsInside(manifest.transactionRoot, manifest.pre?.pluginTarget?.backup || manifest.transactionRoot)
    || !pathIsInside(manifest.transactionRoot, manifest.pre?.marketplaceFile?.backup || manifest.transactionRoot)
  ) {
    throw new Error(`transaction manifest backup paths escape their evidence root: ${resolved}`);
  }
  if (
    !manifest.inputs
    || !manifest.pre?.pluginTarget?.target
    || !manifest.pre?.marketplaceFile?.target
    || path.resolve(manifest.pre.pluginTarget.target) !== path.resolve(manifest.inputs.pluginTarget)
    || path.resolve(manifest.pre.marketplaceFile.target) !== path.resolve(manifest.inputs.marketplacePath)
    || path.dirname(path.resolve(manifest.lockPath)) !== path.dirname(manifest.transactionRoot)
    || path.basename(manifest.lockPath) !== 'active-user-install.json'
  ) {
    throw new Error(`transaction manifest target or lock binding is invalid: ${resolved}`);
  }
  const cacheRoot = pluginCacheRoot(manifest.inputs.codexHome);
  const cacheSnapshots = Array.isArray(manifest.pre.cacheSnapshots)
    ? manifest.pre.cacheSnapshots
    : [];
  const seenCacheTargets = new Set();
  for (const entry of cacheSnapshots) {
    const snapshot = entry && entry.snapshot;
    if (
      !snapshot
      || !pathIsInside(cacheRoot, snapshot.target)
      || (snapshot.backup && !pathIsInside(manifest.transactionRoot, snapshot.backup))
    ) {
      throw new Error(`transaction cache snapshot escapes its bound roots: ${resolved}`);
    }
    const cacheTarget = normalizePath(snapshot.target);
    if (seenCacheTargets.has(cacheTarget)) {
      throw new Error(`transaction cache snapshot contains duplicate targets: ${resolved}`);
    }
    seenCacheTargets.add(cacheTarget);
  }
  return { manifestPath: resolved, manifest };
}

function writeManifest(manifestPath, manifest) {
  manifest.updatedAt = new Date().toISOString();
  atomicWriteJson(manifestPath, manifest);
}

function persistErrorBestEffort(manifestPath, manifest, field, error) {
  manifest[field] = {
    message: error.message,
    at: new Date().toISOString(),
  };
  try {
    writeManifest(manifestPath, manifest);
  } catch (evidenceError) {
    error.message = `${error.message}; evidence write failed: ${evidenceError.message}`;
  }
}

function readPlainFileBytes(target, label) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a plain file: ${target}`);
  }
  return fs.readFileSync(target);
}

function restoreClaimedLock(claimPath, lockPath) {
  try {
    fs.linkSync(claimPath, lockPath);
    syncDirectory(path.dirname(lockPath));
    fs.unlinkSync(claimPath);
    syncDirectory(path.dirname(lockPath));
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
}

function claimAndRemoveLock(lockPath, expectedRaw, unlinkLock = fs.unlinkSync) {
  const claimPath = `${lockPath}.release-claim.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  fs.renameSync(lockPath, claimPath);
  syncDirectory(path.dirname(lockPath));
  let claimedRaw;
  try {
    claimedRaw = readPlainFileBytes(claimPath, 'claimed transaction lock');
  } catch (error) {
    try { restoreClaimedLock(claimPath, lockPath); } catch { }
    throw error;
  }
  if (!claimedRaw.equals(expectedRaw)) {
    const restored = restoreClaimedLock(claimPath, lockPath);
    const preserved = restored ? lockPath : claimPath;
    throw new Error(
      `transaction lock changed before atomic claim and was ${restored ? 'restored' : `preserved at ${claimPath}`}: ${preserved}`
    );
  }
  try {
    unlinkLock(claimPath);
    syncDirectory(path.dirname(lockPath));
  } catch (error) {
    let restoreError = null;
    try {
      if (pathExists(claimPath) && !restoreClaimedLock(claimPath, lockPath)) {
        restoreError = new Error(`a replacement lock exists; owned claim preserved at ${claimPath}`);
      }
    } catch (caught) {
      restoreError = caught;
    }
    if (restoreError) error.message = `${error.message}; ${restoreError.message}`;
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') return true;
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function validateLockEnvelope(evidenceRoot, lockPath, lock) {
  assertPlainRoot(evidenceRoot, 'transaction evidence root');
  if (!fs.lstatSync(evidenceRoot).isDirectory()) {
    throw new Error(`transaction evidence root must be a directory: ${evidenceRoot}`);
  }
  if (
    !lock
    || lock.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(lock.pid)
    || lock.pid <= 0
    || !/^[0-9a-f]{32}$/.test(lock.token || '')
    || typeof lock.manifestPath !== 'string'
    || !pathIsInside(evidenceRoot, lock.manifestPath)
  ) {
    throw new Error(`installer transaction lock has an invalid envelope: ${lockPath}`);
  }
  const manifestPath = path.resolve(lock.manifestPath);
  const transactionRoot = path.dirname(manifestPath);
  const transactionId = path.basename(transactionRoot);
  if (
    path.basename(manifestPath) !== 'manifest.json'
    || path.dirname(transactionRoot) !== path.resolve(evidenceRoot)
    || !/^[0-9]{17}-[0-9]+-[0-9a-f]{8}$/.test(transactionId)
    || !pathExists(transactionRoot)
  ) {
    throw new Error(`installer transaction lock has an invalid manifest binding: ${lockPath}`);
  }
  assertNoLinkComponents(evidenceRoot, transactionRoot, 'transaction root');
  assertPlainRoot(transactionRoot, 'transaction root');
  if (!fs.lstatSync(transactionRoot).isDirectory()) {
    throw new Error(`transaction root must be a directory: ${transactionRoot}`);
  }
  assertNoLinkComponents(evidenceRoot, manifestPath, 'transaction manifest');
  return { manifestPath, transactionRoot, transactionId };
}

function readLockedManifest(evidenceRoot, lockPath, lock) {
  const { manifestPath } = validateLockEnvelope(evidenceRoot, lockPath, lock);
  reconcilePublishJournal(manifestPath);
  assertNoLinkComponents(evidenceRoot, manifestPath, 'transaction manifest');
  const raw = readPlainFileBytes(manifestPath, 'transaction manifest');
  const manifest = JSON.parse(raw.toString('utf8'));
  if (
    manifest.schemaVersion !== SCHEMA_VERSION
    || manifest.kind !== 'codex-user-install'
    || path.resolve(manifest.manifestPath || '') !== manifestPath
    || path.resolve(manifest.transactionRoot || '') !== path.dirname(manifestPath)
    || path.dirname(path.resolve(manifest.transactionRoot || '')) !== path.resolve(evidenceRoot)
    || manifest.lockToken !== lock.token
    || manifest.ownerPid !== lock.pid
  ) {
    throw new Error(`installer transaction lock/manifest binding is invalid: ${lockPath}`);
  }
  return { manifestPath, manifest, raw, posixMode: posixMode(manifestPath) };
}

function atomicCreateJsonNoReplace(target, value) {
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const temporary = `${target}.create.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, target);
    syncDirectory(path.dirname(target));
  } finally {
    if (pathExists(temporary)) fs.unlinkSync(temporary);
  }
}

function abandonMissingPreparingManifest(evidenceRoot, lockPath, lockRaw, lock, unlinkLock = fs.unlinkSync) {
  const envelope = validateLockEnvelope(evidenceRoot, lockPath, lock);
  if (processIsAlive(lock.pid)) {
    throw new Error(`active Codex user install pid=${lock.pid} still owns ${lockPath}`);
  }
  if (pathExists(envelope.manifestPath)) {
    throw new Error(`transaction manifest appeared during missing-manifest reconciliation: ${envelope.manifestPath}`);
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'codex-user-install',
    transactionId: envelope.transactionId,
    transactionRoot: envelope.transactionRoot,
    manifestPath: envelope.manifestPath,
    lockPath,
    lockToken: lock.token,
    ownerPid: lock.pid,
    state: 'prepare-abandoned',
    prepareAbandonedAt: new Date().toISOString(),
    prepareAbandonedReason: `owning process pid=${lock.pid} died before the initial manifest write`,
    abandonedLockRawBase64: lockRaw.toString('base64'),
    terminalDisposition: 'prepare-abandoned',
  };
  atomicCreateJsonNoReplace(envelope.manifestPath, manifest);
  claimAndRemoveLock(lockPath, lockRaw, unlinkLock);
  return { manifestPath: envelope.manifestPath, manifest };
}

function abandonPreparingTransaction(evidenceRoot, lockPath, lockRaw, lock, unlinkLock = fs.unlinkSync) {
  if (processIsAlive(lock.pid)) {
    throw new Error(`active Codex user install pid=${lock.pid} still owns ${lockPath}`);
  }
  const loaded = readLockedManifest(evidenceRoot, lockPath, lock);
  if (loaded.manifest.state !== 'preparing') {
    throw new Error(`interrupted transaction state=${loaded.manifest.state} requires explicit reconcile: ${loaded.manifestPath}`);
  }
  loaded.manifest.state = 'prepare-abandoned';
  loaded.manifest.prepareAbandonedAt = new Date().toISOString();
  loaded.manifest.prepareAbandonedReason = `owning process pid=${lock.pid || '<invalid>'} is not alive`;
  loaded.manifest.terminalDisposition = 'prepare-abandoned';
  const content = `${JSON.stringify({
    ...loaded.manifest,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  publishTextCompareAndSwap(
    loaded.manifestPath,
    content,
    marketplaceExpectationFromRaw(loaded.raw, loaded.posixMode),
    { previousLabel: 'prepare-abandon', retainPrevious: true }
  );
  loaded.manifest = JSON.parse(content);
  claimAndRemoveLock(lockPath, lockRaw, unlinkLock);
  return loaded;
}

function acquireLock(evidenceRoot, manifestPath, ownerPid = process.pid) {
  const lockPath = path.join(evidenceRoot, 'active-user-install.json');
  if (pathExists(lockPath)) {
    let previous;
    let previousRaw;
    try {
      previousRaw = readPlainFileBytes(lockPath, 'installer transaction lock');
      previous = JSON.parse(previousRaw.toString('utf8'));
    } catch (error) {
      throw new Error(`installer transaction lock is invalid and was preserved: ${lockPath}: ${error.message}`);
    }
    const envelope = validateLockEnvelope(evidenceRoot, lockPath, previous);
    if (processIsAlive(previous.pid)) {
      throw new Error(
        `active Codex user install pid=${previous.pid} owns ${lockPath}; manifest=${envelope.manifestPath}`
      );
    }
    reconcilePublishJournal(envelope.manifestPath);
    if (!pathExists(envelope.manifestPath)) {
      abandonMissingPreparingManifest(evidenceRoot, lockPath, previousRaw, previous);
    } else {
      const old = readLockedManifest(evidenceRoot, lockPath, previous);
      if (!TERMINAL_STATES.has(old.manifest.state)) {
        if (old.manifest.state === 'preparing') {
          abandonPreparingTransaction(evidenceRoot, lockPath, previousRaw, previous);
        } else {
          throw new Error(
            `interrupted Codex user install state=${old.manifest.state} requires explicit reconcile: ${old.manifestPath}`
          );
        }
      } else {
        claimAndRemoveLock(lockPath, previousRaw);
      }
    }
  }
  const token = crypto.randomBytes(16).toString('hex');
  const lock = {
    schemaVersion: SCHEMA_VERSION,
    manifestPath: path.resolve(manifestPath),
    token,
    pid: ownerPid,
    createdAt: new Date().toISOString(),
  };
  const descriptor = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== 'win32') fs.chmodSync(lockPath, 0o600);
  syncDirectory(evidenceRoot);
  return { lockPath, token };
}

function assertLockOwned(manifest) {
  if (!manifest.lockPath || !pathExists(manifest.lockPath)) {
    throw new Error(`transaction lock is missing: ${manifest.lockPath || '<none>'}`);
  }
  const raw = readPlainFileBytes(manifest.lockPath, 'transaction lock');
  const lock = JSON.parse(raw.toString('utf8'));
  if (
    path.resolve(lock.manifestPath || '') !== path.resolve(manifest.manifestPath)
    || !manifest.lockToken
    || lock.token !== manifest.lockToken
    || lock.pid !== manifest.ownerPid
  ) {
    throw new Error(`transaction lock is owned by another manifest: ${manifest.lockPath}`);
  }
  return { lock, raw };
}

function releaseLock(manifest, unlinkLock = fs.unlinkSync) {
  try {
    const owned = assertLockOwned(manifest);
    claimAndRemoveLock(manifest.lockPath, owned.raw, unlinkLock);
    return null;
  } catch (error) {
    return error.message;
  }
}

function finalizeTerminalLock(manifestPath, manifest, disposition, unlinkLock) {
  manifest.lockReleaseError = releaseLock(manifest, unlinkLock || fs.unlinkSync);
  manifest.terminalDisposition = manifest.lockReleaseError
    ? LOCK_RELEASE_FAILURE_DISPOSITIONS[disposition] || `${disposition}-lock-release-failed`
    : disposition;
  manifest.lockReleasedAt = manifest.lockReleaseError ? null : new Date().toISOString();
  try {
    writeManifest(manifestPath, manifest);
  } catch (evidenceError) {
    manifest.terminalEvidenceWarning = evidenceError.message;
  }
  return manifest.terminalDisposition;
}

function prepareTransaction(options = {}) {
  const runCodex = options.runCodex || defaultRunCodex;
  const pluginTarget = path.resolve(options.pluginTarget);
  const pluginSource = path.resolve(options.pluginSource);
  const marketplacePath = path.resolve(options.marketplacePath);
  const marketplaceRoot = path.resolve(options.marketplaceRoot);
  const codexHome = path.resolve(options.codexHome);
  const marketplaceName = options.marketplaceName || DEFAULT_MARKETPLACE_NAME;
  const canonicalOwner = options.canonicalOwner || DEFAULT_CANONICAL_OWNER;
  const ownerPid = options.ownerPid === undefined ? process.pid : Number(options.ownerPid);
  const evidenceRoot = path.resolve(
    options.evidenceRoot || path.join(codexHome, 'installer-transactions')
  );
  const userHome = path.dirname(codexHome);
  const transactionInputs = {
    pluginTarget,
    pluginSource,
    marketplacePath,
    marketplaceRoot,
    marketplaceName,
    canonicalOwner,
    codexHome,
  };

  assertSafePathSegment(marketplaceName, 'marketplace name');
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !processIsAlive(ownerPid)) {
    throw new Error(`Codex user-install owner PID is not a live process: ${options.ownerPid}`);
  }
  if (canonicalOwner !== `${PLUGIN_NAME}@${marketplaceName}`) {
    throw new Error(`invalid canonical owner id: ${canonicalOwner}`);
  }
  if (
    path.basename(codexHome) !== '.codex'
    || !samePath(pluginTarget, path.join(userHome, 'plugins', PLUGIN_NAME))
    || !samePath(marketplaceRoot, userHome)
    || !samePath(marketplacePath, path.join(userHome, '.agents', 'plugins', 'marketplace.json'))
    || !samePath(evidenceRoot, path.join(codexHome, 'installer-transactions'))
  ) {
    throw new Error('Codex user-install transaction paths do not match the canonical user-home layout');
  }
  if (!pathExists(pluginSource)) throw new Error(`plugin source is missing: ${pluginSource}`);
  assertPlainRoot(pluginSource, 'plugin source');
  assertTransactionBoundaries(transactionInputs, evidenceRoot);

  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  assertTransactionBoundaries(transactionInputs, evidenceRoot);
  const transactionId = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const transactionRoot = path.join(evidenceRoot, transactionId);
  fs.mkdirSync(transactionRoot, { recursive: false, mode: 0o700 });
  const manifestPath = path.join(transactionRoot, 'manifest.json');
  const acquiredLock = acquireLock(evidenceRoot, manifestPath, ownerPid);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'codex-user-install',
    transactionId,
    transactionRoot,
    manifestPath,
    lockPath: acquiredLock.lockPath,
    lockToken: acquiredLock.token,
    ownerPid,
    state: 'preparing',
    preparedAt: new Date().toISOString(),
    inputs: transactionInputs,
    commands: [],
    rollbackResults: [],
    checkpoints: [],
  };

  try {
    writeManifest(manifestPath, manifest);
    const sourceBundle = pluginSourceRecord(pluginSource);
    const pluginTargetSnapshot = snapshotPath(
      pluginTarget,
      path.join(transactionRoot, 'pre', 'plugin-target'),
      'plugin target'
    );
    if (pluginTargetSnapshot.existed && pluginTargetSnapshot.kind !== 'directory') {
      throw new Error(`plugin target must be a directory or absent: ${pluginTarget}`);
    }
    const marketplaceFileSnapshot = snapshotPath(
      marketplacePath,
      path.join(transactionRoot, 'pre', 'marketplace.json'),
      'marketplace file'
    );
    if (marketplaceFileSnapshot.existed && marketplaceFileSnapshot.kind !== 'file') {
      throw new Error(`marketplace path must be a file or absent: ${marketplacePath}`);
    }
    marketplaceFileSnapshot.rawBase64 = marketplaceFileSnapshot.existed
      ? fs.readFileSync(marketplaceFileSnapshot.backup).toString('base64')
      : null;
    if (
      marketplaceFileSnapshot.existed
      && sha256(Buffer.from(marketplaceFileSnapshot.rawBase64, 'base64')) !== marketplaceFileSnapshot.sha256
    ) {
      throw new Error('marketplace raw expectation differs from its verified snapshot hash');
    }
    const owners = probeOwners(runCodex, manifest.commands, 'probe-owners-before-install');
    if (owners.some((owner) => !owner.version || !owner.sourcePath)) {
      throw new Error('official Codex owner snapshot omitted version/source data; cache rollback cannot be verified');
    }
    if (
      owners.length > 1
      || owners.some((owner) => owner.pluginId !== canonicalOwner)
    ) {
      throw new Error(
        `unsafe pre-install owner state; automatic owner cleanup is disabled because the official Codex CLI has no version/source CAS: ${JSON.stringify(owners)}`
      );
    }
    const marketplaceRegistration = probeMarketplace(
      runCodex,
      marketplaceName,
      manifest.commands,
      'probe-marketplace-before-install'
    );
    if (marketplaceRegistration && marketplaceRegistration.sourceType !== 'local') {
      throw new Error(
        `canonical marketplace has a non-local source that cannot be restored safely: ${marketplaceRegistration.sourceType}`
      );
    }
    const cacheSnapshots = snapshotPluginCaches(
      codexHome,
      owners,
      sourceBundle.version,
      transactionRoot
    );
    const caches = discoverPluginCaches(codexHome);
    const snapshottedCaches = cacheStateFromSnapshots(cacheSnapshots);
    if (!cacheStatesMatch(caches, snapshottedCaches)) {
      throw new Error('plugin cache inventory or bytes changed while pre-install snapshots were captured');
    }
    const ownersWithCache = enrichOwnersWithCache(owners, codexHome, caches);
    const snapshottedRuntimeState = {
      target: pathRecordFromSnapshot(pluginTargetSnapshot),
      marketplaceFile: pathRecordFromSnapshot(marketplaceFileSnapshot),
      owners: ownersWithCache,
      marketplaceRegistration,
      caches: snapshottedCaches,
    };
    const verifiedRuntimeState = currentRuntimeState(
      manifest.inputs,
      runCodex,
      manifest.commands,
      'verify-prepared-snapshots'
    );
    if (!runtimeStatesMatch(verifiedRuntimeState, snapshottedRuntimeState)) {
      throw new Error('pre-install runtime changed while its verified snapshots were captured');
    }
    manifest.pre = {
      sourceBundle,
      pluginTarget: pluginTargetSnapshot,
      marketplaceFile: marketplaceFileSnapshot,
      cacheSnapshots,
      owners: ownersWithCache,
      marketplaceRegistration,
      runtimeState: snapshottedRuntimeState,
      preparedGate: {
        state: verifiedRuntimeState,
        verifiedAt: new Date().toISOString(),
      },
    };
    manifest.state = 'prepared';
    writeManifest(manifestPath, manifest);
    return { manifestPath, manifest };
  } catch (error) {
    manifest.state = 'prepare-failed';
    manifest.prepareError = error.message;
    manifest.lockReleaseError = releaseLock(manifest, options.unlinkLock || fs.unlinkSync);
    manifest.terminalDisposition = manifest.lockReleaseError
      ? 'prepare-failed-lock-release-failed'
      : 'prepare-failed';
    try {
      writeManifest(manifestPath, manifest);
    } catch (manifestError) {
      error.message = `${error.message}; prepare evidence write failed: ${manifestError.message}`;
    }
    error.evidencePath = manifestPath;
    throw error;
  }
}

function activationGate(manifestPath, phase, options = {}) {
  const runCodex = options.runCodex || defaultRunCodex;
  const loaded = readManifest(manifestPath);
  const { manifest } = loaded;
  if (manifest.state !== 'prepared') {
    throw new Error(`transaction activation gate requires state=prepared; state=${manifest.state}`);
  }
  if (!['before-claim', 'claimed'].includes(phase)) {
    throw new Error(`invalid transaction activation-gate phase: ${phase || '<none>'}`);
  }
  assertLockOwned(manifest);
  assertTransactionBoundaries(manifest.inputs, manifest.transactionRoot);
  verifySnapshot(manifest.pre.pluginTarget);

  const current = currentRuntimeState(
    manifest.inputs,
    runCodex,
    manifest.commands,
    `activation-gate-${phase}`
  );
  assertStateSurfaces(
    current,
    manifest.pre.runtimeState,
    ['marketplaceFile', 'owners', 'marketplaceRegistration', 'caches'],
    `activation gate ${phase}`
  );

  let claimedPath = null;
  let claimedRecord = null;
  if (phase === 'before-claim') {
    if (options.claimedPath) {
      throw new Error('before-claim activation gate must not receive a claimed path');
    }
    if (!pathRecordsMatch(current.target, manifest.pre.runtimeState.target)) {
      throw new Error('activation before-claim target differs from the verified pre-install snapshot');
    }
  } else {
    if (current.target.existed) {
      throw new Error('activation claimed gate requires the canonical plugin target to be absent');
    }
    if (manifest.pre.pluginTarget.existed) {
      if (!options.claimedPath) {
        throw new Error('activation claimed gate requires the preserved plugin claim path');
      }
      claimedPath = path.resolve(options.claimedPath);
      const pluginRoot = path.dirname(path.resolve(manifest.inputs.pluginTarget));
      if (!pathIsInside(pluginRoot, claimedPath) || samePath(pluginRoot, claimedPath)) {
        throw new Error(`activation claimed path escapes the canonical plugin root: ${claimedPath}`);
      }
      assertNoLinkComponents(pluginRoot, claimedPath, 'activation claimed path');
      assertPlainRoot(claimedPath, 'activation claimed path');
      claimedRecord = currentPathRecord(claimedPath);
      if (!pathRecordPayloadMatches(claimedRecord, manifest.pre.pluginTarget)) {
        throw new Error('activation claimed payload differs from the verified pre-install snapshot');
      }
    } else if (options.claimedPath) {
      throw new Error('activation claimed path is invalid because the pre-install target was absent');
    }
  }

  if (!Array.isArray(manifest.activationGates)) manifest.activationGates = [];
  manifest.activationGates.push({
    phase,
    target: current.target,
    claimedPath,
    claimedRecord,
    checkedAt: new Date().toISOString(),
  });
  writeManifest(loaded.manifestPath, manifest);
  return { manifestPath: loaded.manifestPath, manifest };
}

function markActivated(manifestPath, options = {}) {
  const runCodex = options.runCodex || defaultRunCodex;
  const loaded = readManifest(manifestPath);
  const { manifest } = loaded;
  if (manifest.state !== 'prepared') {
    throw new Error(`transaction must be prepared before activation snapshot; state=${manifest.state}`);
  }
  assertLockOwned(manifest);
  assertTransactionBoundaries(manifest.inputs, manifest.transactionRoot);
  try {
    const target = pluginBundleRecord(manifest.inputs.pluginTarget);
    if (target.bundleSha256 !== manifest.pre.sourceBundle.bundleSha256) {
      throw new Error('activated plugin bundle does not match the verified source bundle');
    }
    const state = currentRuntimeState(
      manifest.inputs,
      runCodex,
      manifest.commands,
      'capture-activated'
    );
    const expected = {
      ...manifest.pre.runtimeState,
      target: currentPathRecord(manifest.inputs.pluginTarget),
    };
    assertStateSurfaces(
      state,
      expected,
      ['marketplaceFile', 'owners', 'marketplaceRegistration', 'caches'],
      'plugin activation'
    );
    manifest.afterActivation = {
      target,
      state,
      capturedAt: new Date().toISOString(),
    };
    manifest.checkpoints.push({
      phase: 'activated',
      state,
      capturedAt: new Date().toISOString(),
    });
    manifest.state = 'activated';
    writeManifest(loaded.manifestPath, manifest);
    return { manifestPath: loaded.manifestPath, manifest };
  } catch (error) {
    if (manifest.state === 'prepared') {
      persistErrorBestEffort(loaded.manifestPath, manifest, 'activationError', error);
    }
    throw error;
  }
}

function checkpointTransaction(manifestPath, phase, options = {}) {
  const runCodex = options.runCodex || defaultRunCodex;
  const loaded = readManifest(manifestPath);
  const { manifest } = loaded;
  if (manifest.state !== 'activated') {
    throw new Error(`transaction must be activated before a checkpoint; state=${manifest.state}`);
  }
  assertLockOwned(manifest);
  assertTransactionBoundaries(manifest.inputs, manifest.transactionRoot);
  const order = ['activated', 'marketplace-file', 'marketplace', 'cache', 'doctor'];
  const previous = latestCheckpoint(manifest);
  const expectedIndex = order.indexOf(previous && previous.phase) + 1;
  if (!phase || order[expectedIndex] !== phase) {
    throw new Error(
      `invalid transaction checkpoint order: previous=${previous?.phase || '<none>'} requested=${phase || '<none>'}`
    );
  }

  try {
    const target = pluginBundleRecord(manifest.inputs.pluginTarget);
    if (
      target.sha256 !== manifest.afterActivation.target.sha256
      || target.bundleSha256 !== manifest.pre.sourceBundle.bundleSha256
    ) {
      throw new Error(`plugin target changed before ${phase} checkpoint`);
    }
    const state = currentRuntimeState(
      manifest.inputs,
      runCodex,
      manifest.commands,
      `capture-${phase}`
    );
    if (phase === 'marketplace-file') {
      if (!canonicalMarketplaceFileMatches(manifest, state)) {
        throw new Error('marketplace-file checkpoint differs from the exact installer transformation');
      }
      assertStateSurfaces(
        state,
        previous.state,
        ['target', 'owners', 'marketplaceRegistration', 'caches'],
        phase
      );
    } else if (phase === 'marketplace') {
      assertStateSurfaces(
        state,
        previous.state,
        ['target', 'marketplaceFile', 'owners', 'caches'],
        phase
      );
      if (!registrationsMatch(state.marketplaceRegistration, expectedRegistration(manifest.inputs))) {
        throw new Error('marketplace checkpoint does not own the canonical registration');
      }
    } else if (phase === 'cache') {
      assertStateSurfaces(
        state,
        previous.state,
        ['target', 'marketplaceFile', 'marketplaceRegistration'],
        phase
      );
      const expected = expectedCachePhaseState(manifest, previous.state, target);
      if (
        !ownersMatch(state.owners, expected.owners)
        || !cacheRefreshStateMatches(manifest, state.caches, expected.caches)
      ) {
        throw new Error(
          `cache checkpoint byte mismatch: expected=${JSON.stringify(expected)} actual=${JSON.stringify(state)}`
        );
      }
    } else if (phase === 'doctor') {
      assertStateSurfaces(
        state,
        previous.state,
        ['target', 'marketplaceFile', 'marketplaceRegistration'],
        phase
      );
      const canonicalOwner = canonicalOwnerState(manifest, target);
      if (!ownersMatch(state.owners, [canonicalOwner])) {
        throw new Error('doctor checkpoint does not have exactly one canonical owner/cache');
      }
      if (!cacheStatesMatch(state.caches, previous.state.caches)) {
        throw new Error('doctor checkpoint changed plugin-cache inventory or bytes');
      }
      const canonicalCache = state.caches.find((cache) => samePath(cache.path, canonicalOwner.cachePath));
      if (!canonicalCache || canonicalCache.sha256 !== target.sha256) {
        throw new Error('doctor checkpoint canonical cache bytes differ from the activated target');
      }
    }
    manifest.checkpoints.push({
      phase,
      state,
      capturedAt: new Date().toISOString(),
    });
    writeManifest(loaded.manifestPath, manifest);
    return { manifestPath: loaded.manifestPath, manifest };
  } catch (error) {
    persistErrorBestEffort(loaded.manifestPath, manifest, 'checkpointError', error);
    throw error;
  }
}

function validateMarketplaceFile(manifest) {
  const marketplacePath = manifest.inputs.marketplacePath;
  const root = JSON.parse(stripLeadingBom(fs.readFileSync(marketplacePath, 'utf8')));
  if (root.name !== manifest.inputs.marketplaceName || !Array.isArray(root.plugins)) {
    throw new Error(`marketplace file has an invalid ${manifest.inputs.marketplaceName} schema`);
  }
  const entries = root.plugins.filter((entry) => entry && entry.name === PLUGIN_NAME);
  if (entries.length !== 1) {
    throw new Error(`marketplace file must contain exactly one ${PLUGIN_NAME} entry`);
  }
  const source = entries[0].source;
  if (!source || source.source !== 'local' || source.path !== `./plugins/${PLUGIN_NAME}`) {
    throw new Error(`marketplace ${PLUGIN_NAME} entry does not point to the canonical local plugin`);
  }
}

function commitTransaction(manifestPath, options = {}) {
  const runCodex = options.runCodex || defaultRunCodex;
  const loaded = readManifest(manifestPath);
  const { manifest } = loaded;
  if (manifest.state !== 'activated') {
    throw new Error(`transaction must have an activation snapshot before commit; state=${manifest.state}`);
  }
  assertLockOwned(manifest);
  assertTransactionBoundaries(manifest.inputs, manifest.transactionRoot);
  try {
    const target = pluginBundleRecord(manifest.inputs.pluginTarget);
    if (
      target.sha256 !== manifest.afterActivation.target.sha256
      || target.bundleSha256 !== manifest.pre.sourceBundle.bundleSha256
    ) {
      throw new Error('plugin target changed after the activation snapshot');
    }
    validateMarketplaceFile(manifest);
    const checkpoint = latestCheckpoint(manifest);
    if (!checkpoint || checkpoint.phase !== 'doctor') {
      throw new Error('transaction commit requires a verified doctor checkpoint');
    }
    const state = currentRuntimeState(
      manifest.inputs,
      runCodex,
      manifest.commands,
      'verify-before-commit'
    );
    if (!runtimeStatesMatch(state, checkpoint.state)) {
      throw new Error(
        `final runtime/cache bytes changed after doctor checkpoint: expected=${JSON.stringify(checkpoint.state)} actual=${JSON.stringify(state)}`
      );
    }
    const canonicalOwner = canonicalOwnerState(manifest, target);
    if (!ownersMatch(state.owners, [canonicalOwner])) {
      throw new Error('final enabled owner/cache mismatch');
    }

    manifest.post = {
      target,
      runtimeState: state,
      marketplaceFile: state.marketplaceFile,
      owners: state.owners,
      marketplaceRegistration: state.marketplaceRegistration,
      caches: state.caches,
      verifiedAt: new Date().toISOString(),
    };
    manifest.state = 'committed';
    manifest.committedAt = new Date().toISOString();
    writeManifest(loaded.manifestPath, manifest);
    const disposition = finalizeTerminalLock(
      loaded.manifestPath,
      manifest,
      'committed',
      options.unlinkLock
    );
    return { manifestPath: loaded.manifestPath, manifest, disposition };
  } catch (error) {
    if (manifest.state === 'activated') {
      persistErrorBestEffort(loaded.manifestPath, manifest, 'commitError', error);
    }
    throw error;
  }
}

function expectedMarketplaceText(manifest) {
  let existingText = null;
  if (manifest.pre.marketplaceFile.existed) {
    verifySnapshot(manifest.pre.marketplaceFile);
    try {
      existingText = fs.readFileSync(manifest.pre.marketplaceFile.backup, 'utf8');
      const existing = JSON.parse(stripLeadingBom(existingText));
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        existingText = null;
      }
    } catch {
      existingText = null;
    }
  }
  return transformMarketplaceText(existingText, {
    pluginName: PLUGIN_NAME,
    marketplaceName: manifest.inputs.marketplaceName,
    marketplaceDisplayName: 'Local Plugins',
  });
}

function canonicalMarketplaceFileMatches(manifest, state) {
  try {
    validateMarketplaceFile(manifest);
    if (!pathRecordsMatch(
      state.marketplaceFile,
      currentPathRecord(manifest.inputs.marketplacePath)
    )) return false;
    const actualText = fs.readFileSync(manifest.inputs.marketplacePath, 'utf8');
    return actualText === expectedMarketplaceText(manifest);
  } catch {
    return false;
  }
}

function doctorCachesAreOwned(actualCaches, expectedCaches, canonicalOwner) {
  const expectedByPath = cacheStateByPath(expectedCaches);
  const canonical = actualCaches.find((cache) => samePath(cache.path, canonicalOwner.cachePath));
  if (!canonical || canonical.sha256 !== canonicalOwner.cacheSha256) return false;
  return cacheStatesMatch(actualCaches, expectedCaches)
    && actualCaches.every((cache) => {
      const expected = expectedByPath.get(normalizePath(cache.path));
      return Boolean(expected) && expected.sha256 === cache.sha256;
    });
}

function classifyInstallerOwnedState(manifest, current) {
  if (runtimeStatesMatch(current, manifest.pre.runtimeState)) return 'pre-install';
  for (const checkpoint of manifest.checkpoints || []) {
    if (checkpoint.state && runtimeStatesMatch(current, checkpoint.state)) {
      return `checkpoint:${checkpoint.phase}`;
    }
  }

  const pre = manifest.pre.runtimeState;
  const nonTargetPre = stateSurfacesMatch(
    current,
    pre,
    ['marketplaceFile', 'owners', 'marketplaceRegistration', 'caches']
  );
  if (!current.target.existed && nonTargetPre) return 'activation-transition';
  if (!current.target.existed || current.target.sha256 !== manifest.pre.sourceBundle.bundleSha256) {
    return null;
  }
  let target;
  try {
    target = pluginBundleRecord(manifest.inputs.pluginTarget);
  } catch {
    return null;
  }
  if (nonTargetPre) return 'activated-uncheckpointed';
  if (!canonicalMarketplaceFileMatches(manifest, current)) return null;

  const filePhase = {
    ...pre,
    target: current.target,
    marketplaceFile: current.marketplaceFile,
  };
  if (stateSurfacesMatch(
    current,
    filePhase,
    ['owners', 'marketplaceRegistration', 'caches']
  )) return 'marketplace-file-uncheckpointed';

  const registrationPhase = {
    ...filePhase,
    marketplaceRegistration: expectedRegistration(manifest.inputs),
  };
  if (stateSurfacesMatch(current, registrationPhase, ['owners', 'caches'])
    && registrationsMatch(current.marketplaceRegistration, registrationPhase.marketplaceRegistration)) {
    return 'marketplace-uncheckpointed';
  }

  const cachePhase = expectedCachePhaseState(manifest, registrationPhase, target);
  if (
    stateSurfacesMatch(
      current,
      cachePhase,
      ['target', 'marketplaceFile', 'marketplaceRegistration', 'owners']
    )
    && cacheRefreshStateMatches(manifest, current.caches, cachePhase.caches)
  ) return 'cache-uncheckpointed';
  const canonicalOwner = canonicalOwnerState(manifest, target);
  if (
    stateSurfacesMatch(
      current,
      cachePhase,
      ['target', 'marketplaceFile', 'marketplaceRegistration']
    )
    && ownersMatch(current.owners, [canonicalOwner])
    && doctorCachesAreOwned(current.caches, cachePhase.caches, canonicalOwner)
  ) {
    return 'doctor-uncheckpointed';
  }
  return null;
}

function ownerMetadataOnly(owners) {
  return owners.map(({ cachePath: _cachePath, cacheSha256: _cacheSha256, ...owner }) => owner);
}

function rollbackSnapshotEntries(manifest) {
  return [
    ['restore-plugin-target', manifest.pre.pluginTarget, 'filesystem'],
    ['restore-marketplace-file', manifest.pre.marketplaceFile, 'filesystem'],
    ...manifest.pre.cacheSnapshots.map((entry, index) => [
      `restore-plugin-cache-${String(index).padStart(4, '0')}`,
      entry.snapshot,
      'plugin-cache',
    ]),
  ];
}

function gateBeforeForRollbackEntry(gatedState, step, snapshot) {
  if (step === 'restore-plugin-target') return gatedState.target;
  if (step === 'restore-marketplace-file') return gatedState.marketplaceFile;
  return pathRecordFromSnapshot(snapshot);
}

function operationCanonicalState(operation) {
  const canonical = currentPathRecord(operation.target);
  const preserved = pathRecordAtArtifact(operation.preserved);
  const stage = pathRecordAtArtifact(operation.stage);
  const before = pathRecordsMatch(canonical, operation.before);
  const desired = pathRecordsMatch(canonical, operation.desired);
  const preservedBefore = operation.noop
    || !operation.before.existed
    || pathRecordPayloadMatches(preserved, operation.before);
  const stageDesired = !operation.desired.existed
    || pathRecordPayloadMatches(stage, operation.desired);
  return {
    before,
    desired: desired && preservedBefore,
    claimed: !canonical.existed && preservedBefore && stageDesired,
    published: desired && preservedBefore,
  };
}

function assertRollbackPlanCanonicalStates(manifest) {
  let recoveryIndex = -1;
  let sawIncomplete = false;
  for (let index = 0; index < manifest.rollbackPlan.operations.length; index += 1) {
    const entry = manifest.rollbackPlan.operations[index];
    const operation = entry.operation;
    const state = operationCanonicalState(operation);
    if (operation.noop) {
      if (!state.desired) {
        throw new Error(`rollback noop canonical state contains external drift at ${entry.step}`);
      }
      continue;
    }
    if (operation.status === 'complete') {
      if (sawIncomplete) {
        throw new Error(`rollback durable completion is not a contiguous prefix at ${entry.step}`);
      }
      if (!state.desired) {
        throw new Error(`rollback completed state contains external drift at ${entry.step}`);
      }
      continue;
    }
    sawIncomplete = true;
    if (recoveryIndex < 0) recoveryIndex = index;
    const isRecovery = index === recoveryIndex;
    const ok = isRecovery
      ? ['planned', 'prepared', 'claimed', 'published'].includes(operation.status)
        && (state.before || state.claimed || state.published || state.desired)
      : ['planned', 'prepared'].includes(operation.status) && state.before;
    if (!ok) {
      throw new Error(`rollback canonical state contains external drift at ${entry.step}`);
    }
  }
  return recoveryIndex;
}

function verifyRollbackControlSurfaces(manifest, manifestPath, runCodex, label, options = {}) {
  assertTransactionBoundaries(manifest.inputs, manifest.transactionRoot);
  const owners = probeOwners(runCodex, manifest.rollbackResults, `${label}-owners`);
  const expectedOwners = ownerMetadataOnly(manifest.pre.runtimeState.owners);
  const registration = probeMarketplace(
    runCodex,
    manifest.inputs.marketplaceName,
    manifest.rollbackResults,
    `${label}-marketplace`
  );
  const marketplaceRestore = manifest.rollbackPlan?.operations?.find(
    (entry) => entry.step === 'restore-marketplace-file'
  );
  const claimedMarketplaceGap = Boolean(
    options.allowClaimedMarketplaceGap
    && registration === null
    && marketplaceRestore?.operation?.status === 'claimed'
    && operationCanonicalState(marketplaceRestore.operation).claimed
  );
  const expectedOwnersDuringGap = expectedOwners.filter(
    (owner) => !owner.pluginId.endsWith(`@${manifest.inputs.marketplaceName}`)
  );
  if (
    !ownersMatch(owners, expectedOwners)
    && !(claimedMarketplaceGap && ownersMatch(owners, expectedOwnersDuringGap))
  ) {
    throw new Error(
      `rollback owner metadata drift: expected=${JSON.stringify(expectedOwners)} actual=${JSON.stringify(owners)}`
    );
  }
  if (
    !registrationsMatch(registration, manifest.pre.runtimeState.marketplaceRegistration)
    && !claimedMarketplaceGap
  ) {
    throw new Error(
      `rollback marketplace registration drift: expected=${JSON.stringify(manifest.pre.runtimeState.marketplaceRegistration)} actual=${JSON.stringify(registration)}`
    );
  }
  const caches = discoverPluginCaches(manifest.inputs.codexHome);
  const known = new Set(
    manifest.pre.cacheSnapshots.map((entry) => normalizePath(entry.snapshot.target))
  );
  const unknown = caches.find((cache) => !known.has(normalizePath(cache.path)));
  if (unknown) {
    throw new Error(`rollback detected an external plugin cache path: ${unknown.path}`);
  }
  writeManifest(manifestPath, manifest);
}

function initializeRollbackPlan(manifestPath, manifest, gatedState, gateLabel, reason) {
  const preflightErrors = [];
  for (const [step, snapshot] of rollbackSnapshotEntries(manifest)) {
    const result = { step: `preflight-${step}`, ok: false, at: new Date().toISOString() };
    try {
      verifySnapshot(snapshot);
      result.ok = true;
      result.sha256 = snapshot.sha256;
    } catch (error) {
      result.error = error.message;
      preflightErrors.push(`${result.step}: ${error.message}`);
    }
    manifest.rollbackResults.push(result);
  }
  if (preflightErrors.length > 0) throw new Error(preflightErrors.join('; '));
  manifest.state = 'rolling-back';
  manifest.rollbackReason = String(reason || 'unspecified user-install failure').slice(0, 2000);
  manifest.rollbackStartedAt = manifest.rollbackStartedAt || new Date().toISOString();
  manifest.rollbackPlan = {
    schemaVersion: 1,
    state: 'preparing',
    phase: 'planning',
    gateLabel,
    gateState: gatedState,
    operations: [],
    createdAt: new Date().toISOString(),
  };
  writeManifest(manifestPath, manifest);
}

function ensureRollbackPlanPrepared(manifestPath, manifest, runCodex) {
  const plan = manifest.rollbackPlan;
  const snapshots = rollbackSnapshotEntries(manifest);
  if (
    !plan
    || plan.schemaVersion !== 1
    || !Array.isArray(plan.operations)
    || plan.operations.length > snapshots.length
  ) {
    throw new Error('durable rollback plan is missing or invalid');
  }
  if (plan.phase === 'planning') {
    for (let index = 0; index < snapshots.length; index += 1) {
      const [step, snapshot, preserveGroup] = snapshots[index];
      let entry = plan.operations[index];
      const gateBefore = gateBeforeForRollbackEntry(plan.gateState, step, snapshot);
      if (!entry) {
        assertTransactionBoundaries(manifest.inputs, manifest.transactionRoot);
        const operation = createRestoreOperation(
          snapshot,
          step,
          manifest.transactionId,
          path.join(manifest.transactionRoot, 'rollback-preserved', preserveGroup),
          gateBefore
        );
        entry = {
          step,
          snapshotTarget: path.resolve(snapshot.target),
          operation,
          result: null,
        };
        plan.operations.push(entry);
        writeManifest(manifestPath, manifest);
      }
      if (
        entry.step !== step
        || path.resolve(entry.snapshotTarget || '') !== path.resolve(snapshot.target)
        || !pathRecordsMatch(entry.operation.gateBefore, gateBefore)
      ) {
        throw new Error(`durable rollback plan binding differs at ${step}`);
      }
    }
    verifyRollbackControlSurfaces(manifest, manifestPath, runCodex, 'plan-materialization');
    assertRollbackPlanCanonicalStates(manifest);
    for (let index = 0; index < snapshots.length; index += 1) {
      const [step, snapshot] = snapshots[index];
      const entry = plan.operations[index];
      assertTransactionBoundaries(manifest.inputs, manifest.transactionRoot);
      assertRollbackPlanCanonicalStates(manifest);
      materializeRestoreOperation(entry.operation, snapshot, {
        transactionRoot: manifest.transactionRoot,
        transactionId: manifest.transactionId,
        persist() {
          plan.lastOperation = step;
          plan.lastPersistedAt = new Date().toISOString();
          writeManifest(manifestPath, manifest);
        },
      });
    }
    plan.phase = 'ready';
    plan.state = 'ready';
    plan.preparedAt = new Date().toISOString();
    writeManifest(manifestPath, manifest);
  }
  if (
    !['ready', 'executing'].includes(plan.phase)
    || plan.operations.length !== snapshots.length
  ) {
    throw new Error('durable rollback plan is not executable');
  }
  for (let index = 0; index < snapshots.length; index += 1) {
    const [step, snapshot] = snapshots[index];
    const entry = plan.operations[index];
    const gateBefore = gateBeforeForRollbackEntry(plan.gateState, step, snapshot);
    if (
      entry.step !== step
      || path.resolve(entry.snapshotTarget || '') !== path.resolve(snapshot.target)
      || !pathRecordsMatch(entry.operation.gateBefore, gateBefore)
    ) {
      throw new Error(`durable rollback plan binding differs at ${step}`);
    }
    if (!['prepared', 'claimed', 'published', 'complete'].includes(entry.operation.status)) {
      throw new Error(`durable rollback operation has invalid status at ${step}`);
    }
    validateRestoreOperation(entry.operation, snapshot, manifest.transactionRoot);
  }
  return snapshots;
}

function resumeDurableRollback(manifestPath, manifest, options = {}) {
  const runCodex = options.runCodex || defaultRunCodex;
  try {
    const snapshots = ensureRollbackPlanPrepared(manifestPath, manifest, runCodex);
    manifest.state = 'rolling-back';
    manifest.rollbackPlan.state = 'running';
    manifest.rollbackPlan.phase = 'executing';
    delete manifest.rollbackErrors;
    delete manifest.rollbackFailedAt;
    writeManifest(manifestPath, manifest);
    for (let index = 0; index < snapshots.length; index += 1) {
      const [step, snapshot] = snapshots[index];
      const entry = manifest.rollbackPlan.operations[index];
      verifySnapshot(snapshot);
      verifyRollbackControlSurfaces(
        manifest,
        manifestPath,
        runCodex,
        `resume-${step}`,
        { allowClaimedMarketplaceGap: true }
      );
      assertRollbackPlanCanonicalStates(manifest);
      if (entry.operation.status === 'complete') {
        if (!entry.result) {
          entry.result = {
            step,
            ok: true,
            recovered: true,
            target: entry.operation.target,
            at: new Date().toISOString(),
          };
        }
        if (!manifest.rollbackResults.some((item) => item.step === step && item.ok)) {
          manifest.rollbackResults.push(entry.result);
        }
        manifest.rollbackPlan.completedCount = index + 1;
        writeManifest(manifestPath, manifest);
        continue;
      }
      const result = executeRestoreOperation(entry.operation, snapshot, {
        transactionRoot: manifest.transactionRoot,
        persist() {
          manifest.rollbackPlan.lastOperation = step;
          manifest.rollbackPlan.lastPersistedAt = new Date().toISOString();
          writeManifest(manifestPath, manifest);
        },
        beforeMutation(_operationStep, mutationPhase) {
          assertTransactionBoundaries(manifest.inputs, manifest.transactionRoot);
          verifyRollbackControlSurfaces(
            manifest,
            manifestPath,
            runCodex,
            `pre-mutation-${step}-${mutationPhase}`,
            { allowClaimedMarketplaceGap: true }
          );
          assertRollbackPlanCanonicalStates(manifest);
        },
        afterClaim: options.afterRestoreClaim,
        afterPublish: options.afterRestorePublish,
        afterComplete: options.afterRestoreComplete,
      });
      entry.result = { ...result, step, ok: true, at: new Date().toISOString() };
      manifest.rollbackPlan.completedCount = index + 1;
      if (!manifest.rollbackResults.some((item) => item.step === step && item.ok)) {
        manifest.rollbackResults.push(entry.result);
      }
      writeManifest(manifestPath, manifest);
      assertRollbackPlanCanonicalStates(manifest);
    }
    assertRollbackPlanCanonicalStates(manifest);
    verifyRollbackControlSurfaces(manifest, manifestPath, runCodex, 'resume-final-control');
    for (const [, snapshot] of snapshots) verifySnapshot(snapshot);
    const finalState = currentRuntimeState(
      manifest.inputs,
      runCodex,
      manifest.rollbackResults,
      'verify-final-rollback'
    );
    if (!runtimeStatesMatch(finalState, manifest.pre.runtimeState)) {
      throw new Error(
        `final rollback state differs from byte-exact pre-install state: expected=${JSON.stringify(manifest.pre.runtimeState)} actual=${JSON.stringify(finalState)}`
      );
    }
    manifest.rollbackFinalState = finalState;
    manifest.rollbackPlan.state = 'complete';
    manifest.rollbackPlan.phase = 'complete';
    manifest.rollbackPlan.completedAt = new Date().toISOString();
    manifest.state = 'rolled-back';
    manifest.rolledBackAt = new Date().toISOString();
    writeManifest(manifestPath, manifest);
    const disposition = finalizeTerminalLock(
      manifestPath,
      manifest,
      'rolled-back',
      options.unlinkLock
    );
    return { manifestPath, manifest, disposition };
  } catch (error) {
    manifest.state = 'rollback-failed';
    if (manifest.rollbackPlan) manifest.rollbackPlan.state = 'failed';
    manifest.rollbackErrors = [error.message];
    manifest.rollbackFailedAt = new Date().toISOString();
    try {
      writeManifest(manifestPath, manifest);
    } catch (evidenceError) {
      error.message = `${error.message}; rollback evidence write failed: ${evidenceError.message}`;
    }
    const failure = new Error(
      `Codex user-install rollback failed closed; evidence retained at ${manifestPath}: ${error.message}`
    );
    failure.evidencePath = manifestPath;
    throw failure;
  }
}

function rollbackTransaction(manifestPath, options = {}) {
  const runCodex = options.runCodex || defaultRunCodex;
  const loaded = readManifest(manifestPath);
  const { manifest } = loaded;
  if (!['prepared', 'activated', 'rollback-failed', 'rolling-back'].includes(manifest.state)) {
    throw new Error(`transaction cannot be rolled back from state=${manifest.state}`);
  }
  assertLockOwned(manifest);
  assertTransactionBoundaries(manifest.inputs, manifest.transactionRoot);
  const errors = [];
  const failClosed = () => {
    manifest.state = 'rollback-failed';
    manifest.rollbackErrors = errors;
    manifest.rollbackFailedAt = new Date().toISOString();
    writeManifest(loaded.manifestPath, manifest);
    const error = new Error(
      `Codex user-install rollback failed closed; evidence retained at ${loaded.manifestPath}: ${errors.join('; ')}`
    );
    error.evidencePath = loaded.manifestPath;
    throw error;
  };

  if (manifest.rollbackPlan) {
    return resumeDurableRollback(loaded.manifestPath, manifest, options);
  }

  let gatedState;
  let gateLabel;
  let recoverySurfaces = [];
  try {
    gatedState = currentRuntimeState(
      manifest.inputs,
      runCodex,
      manifest.rollbackResults,
      'rollback-ownership-gate'
    );
    gateLabel = classifyInstallerOwnedState(manifest, gatedState);
    if (!gateLabel) {
      throw new Error('current runtime is not an exact installer-owned pre/checkpoint/transition state');
    }
    if (!ownersMatch(gatedState.owners, manifest.pre.runtimeState.owners)) {
      recoverySurfaces.push('owners');
    }
    if (!cacheStatesMatch(gatedState.caches, manifest.pre.runtimeState.caches)) {
      recoverySurfaces.push('caches');
    }
    if (!registrationsMatch(
      gatedState.marketplaceRegistration,
      manifest.pre.runtimeState.marketplaceRegistration
    )) {
      recoverySurfaces.push('marketplaceRegistration');
    }
    manifest.rollbackGate = {
      ok: true,
      label: gateLabel,
      state: gatedState,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    manifest.rollbackGate = {
      ok: false,
      error: error.message,
      checkedAt: new Date().toISOString(),
    };
    errors.push(`rollback ownership gate: ${error.message}`);
    failClosed();
  }

  if (recoverySurfaces.length > 0) {
    try {
      const reason = String(
        options.reason || 'unspecified failure after the irreversible Codex CLI commit point'
      ).slice(0, 2000);
      manifest.state = 'recovery-required';
      manifest.recovery = {
        reason,
        commitPoint: gateLabel,
        irreversibleSurfaces: recoverySurfaces,
        currentState: gatedState,
        detectedAt: new Date().toISOString(),
        instruction: 'Rerun the Codex user installer to finish the canonical owner/cache state; do not restore filesystem snapshots manually while the installer-owned state remains active.',
      };
      manifest.rollbackResults.push({
        step: 'commit-point-recovery-required',
        ok: true,
        recoveryRequired: true,
        commitPoint: gateLabel,
        irreversibleSurfaces: recoverySurfaces,
        at: new Date().toISOString(),
      });
      writeManifest(loaded.manifestPath, manifest);
      const disposition = finalizeTerminalLock(
        loaded.manifestPath,
        manifest,
        'recovery-required',
        options.unlinkLock
      );
      return {
        manifestPath: loaded.manifestPath,
        manifest,
        disposition,
      };
    } catch (error) {
      errors.push(`commit-point recovery evidence failed: ${error.message}`);
      failClosed();
    }
  }

  try {
    initializeRollbackPlan(
      loaded.manifestPath,
      manifest,
      gatedState,
      gateLabel,
      options.reason
    );
  } catch (error) {
    errors.push(`durable rollback plan: ${error.message}`);
    failClosed();
  }
  return resumeDurableRollback(loaded.manifestPath, manifest, options);
}

function reconcileTransaction(manifestPath, options = {}) {
  const resolved = path.resolve(manifestPath);
  reconcilePublishJournal(resolved);
  const transactionRoot = path.dirname(resolved);
  const evidenceRoot = path.dirname(transactionRoot);
  const lockPath = path.join(evidenceRoot, 'active-user-install.json');

  if (!pathExists(resolved)) {
    if (!pathExists(lockPath)) {
      throw new Error(`interrupted transaction manifest and lock are both missing: ${resolved}`);
    }
    const lockRaw = readPlainFileBytes(lockPath, 'installer transaction lock');
    const lock = JSON.parse(lockRaw.toString('utf8'));
    const envelope = validateLockEnvelope(evidenceRoot, lockPath, lock);
    if (envelope.manifestPath !== resolved) {
      throw new Error(`active lock belongs to a different transaction: ${envelope.manifestPath}`);
    }
    if (processIsAlive(lock.pid)) {
      throw new Error(`active Codex user install pid=${lock.pid} cannot be reconciled`);
    }
    const abandoned = abandonMissingPreparingManifest(
      evidenceRoot,
      lockPath,
      lockRaw,
      lock,
      options.unlinkLock || fs.unlinkSync
    );
    return {
      manifestPath: abandoned.manifestPath,
      manifest: abandoned.manifest,
      disposition: 'prepare-abandoned',
    };
  }

  const rawManifest = JSON.parse(
    readPlainFileBytes(resolved, 'transaction manifest').toString('utf8')
  );
  if (
    rawManifest.schemaVersion !== SCHEMA_VERSION
    || rawManifest.kind !== 'codex-user-install'
    || path.resolve(rawManifest.manifestPath || '') !== resolved
    || path.resolve(rawManifest.transactionRoot || '') !== transactionRoot
    || path.dirname(transactionRoot) !== evidenceRoot
  ) {
    throw new Error(`cannot reconcile an invalid transaction manifest: ${resolved}`);
  }
  if (!pathExists(lockPath)) {
    if (TERMINAL_STATES.has(rawManifest.state)) {
      return {
        manifestPath: resolved,
        manifest: rawManifest,
        disposition: rawManifest.terminalDisposition || rawManifest.state,
      };
    }
    throw new Error(`interrupted transaction lock is missing; evidence preserved: ${resolved}`);
  }

  const lockRaw = readPlainFileBytes(lockPath, 'installer transaction lock');
  const lock = JSON.parse(lockRaw.toString('utf8'));
  const loaded = readLockedManifest(evidenceRoot, lockPath, lock);
  if (loaded.manifestPath !== resolved) {
    throw new Error(`active lock belongs to a different transaction: ${loaded.manifestPath}`);
  }
  if (processIsAlive(lock.pid)) {
    throw new Error(`active Codex user install pid=${lock.pid} cannot be reconciled`);
  }
  if (loaded.manifest.state === 'preparing') {
    const abandoned = abandonPreparingTransaction(
      evidenceRoot,
      lockPath,
      lockRaw,
      lock,
      options.unlinkLock || fs.unlinkSync
    );
    return {
      manifestPath: abandoned.manifestPath,
      manifest: abandoned.manifest,
      disposition: 'prepare-abandoned',
    };
  }
  if (TERMINAL_STATES.has(loaded.manifest.state)) {
    claimAndRemoveLock(lockPath, lockRaw, options.unlinkLock || fs.unlinkSync);
    loaded.manifest.lockReleaseError = null;
    loaded.manifest.lockReleasedAt = new Date().toISOString();
    loaded.manifest.terminalDisposition = loaded.manifest.state;
    writeManifest(loaded.manifestPath, loaded.manifest);
    return {
      manifestPath: loaded.manifestPath,
      manifest: loaded.manifest,
      disposition: loaded.manifest.terminalDisposition,
    };
  }
  if (!['prepared', 'activated', 'rollback-failed', 'rolling-back'].includes(loaded.manifest.state)) {
    throw new Error(`transaction state=${loaded.manifest.state} cannot be reconciled safely`);
  }
  return rollbackTransaction(loaded.manifestPath, {
    ...options,
    reason: options.reason || `resume interrupted transaction state=${loaded.manifest.state}`,
  });
}

function parseArgs(argv) {
  const options = { action: argv[0] || null };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if ([
      '--manifest',
      '--plugin-target',
      '--plugin-source',
      '--marketplace-path',
      '--marketplace-root',
      '--marketplace-name',
      '--canonical-owner',
      '--codex-home',
      '--evidence-root',
      '--phase',
      '--reason',
      '--owner-pid',
      '--claimed-path',
    ].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      options[key] = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function showHelp() {
  console.log([
    'Usage:',
    '  node scripts/codex-user-install-transaction.js prepare --plugin-target <path> --plugin-source <path>',
    '    --marketplace-path <path> --marketplace-root <path> --codex-home <path>',
    '    [--owner-pid <installer-process-pid>]',
    '  node scripts/codex-user-install-transaction.js activation-gate --manifest <manifest.json>',
    '    --phase <before-claim|claimed> [--claimed-path <preserved-plugin-path>]',
    '  node scripts/codex-user-install-transaction.js activated --manifest <manifest.json>',
    '  node scripts/codex-user-install-transaction.js checkpoint --manifest <manifest.json> --phase <phase>',
    '  node scripts/codex-user-install-transaction.js commit --manifest <manifest.json>',
    '  node scripts/codex-user-install-transaction.js rollback --manifest <manifest.json> --reason <text>',
    '  node scripts/codex-user-install-transaction.js reconcile --manifest <manifest.json> [--reason <text>]',
  ].join('\n'));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.action) {
    showHelp();
    return 0;
  }
  let result;
  if (options.action === 'prepare') result = prepareTransaction(options);
  else if (options.action === 'activation-gate') {
    result = activationGate(options.manifest, options.phase, options);
  }
  else if (options.action === 'activated') result = markActivated(options.manifest, options);
  else if (options.action === 'checkpoint') {
    result = checkpointTransaction(options.manifest, options.phase, options);
  }
  else if (options.action === 'commit') result = commitTransaction(options.manifest, options);
  else if (options.action === 'rollback') result = rollbackTransaction(options.manifest, options);
  else if (options.action === 'reconcile') result = reconcileTransaction(options.manifest, options);
  else throw new Error(`unknown action: ${options.action}`);
  process.stdout.write(`${result.manifestPath}\n`);
  if (result.disposition && result.disposition.endsWith('-lock-release-failed')) {
    console.error(
      `[FAIL] transaction reached ${result.manifest.state}, but its active lock was not released: ${result.manifest.lockReleaseError}; evidence=${result.manifestPath}`
    );
    return 2;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    const evidence = error.evidencePath ? ` evidence=${error.evidencePath}` : '';
    console.error(`[FAIL] ${error.message}${evidence}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_CANONICAL_OWNER,
  DEFAULT_MARKETPLACE_NAME,
  activationGate,
  claimAndRemoveLock,
  checkpointTransaction,
  commitTransaction,
  defaultRunCodex,
  markActivated,
  ownerSnapshot,
  ownersMatch,
  prepareTransaction,
  reconcileTransaction,
  registrationsMatch,
  resolveCodexInvocation,
  restorePath,
  rollbackTransaction,
};
