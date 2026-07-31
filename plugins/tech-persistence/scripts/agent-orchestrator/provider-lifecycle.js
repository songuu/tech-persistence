'use strict';

const fs = require('fs');
const path = require('path');

const { stableHash } = require('./runtime-capabilities');

function normalizeSnapshot(input = {}) {
  return {
    headSha: input.headSha || null,
    changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles : [],
    changedFilesHash: input.changedFilesHash
      || stableHash(Array.isArray(input.changedFiles) ? input.changedFiles : []),
    diffHash: input.diffHash || stableHash(String(input.diffText || '')),
  };
}

function createEffectSnapshot(beforeInput, afterInput, options = {}) {
  const before = normalizeSnapshot(beforeInput);
  const after = normalizeSnapshot(afterInput);
  const beforeHash = stableHash(before);
  const afterHash = stableHash(after);
  const inheritedRecovery = options.inheritedRecovery
    && options.inheritedRecovery.required === true
    ? options.inheritedRecovery
    : null;
  const partial = beforeHash !== afterHash || Boolean(inheritedRecovery);
  const snapshot = {
    schemaVersion: 'provider-effects-snapshot-v1',
    state: partial ? 'partial' : 'none',
    before,
    after,
    inheritedRecovery: inheritedRecovery
      ? {
        providerRef: inheritedRecovery.providerRef,
        stage: inheritedRecovery.stage,
        effectsRef: inheritedRecovery.effectsRef || null,
      }
      : null,
  };
  const snapshotHash = stableHash(snapshot);
  return {
    ...snapshot,
    snapshotHash,
    refs: partial ? [snapshotHash] : [],
  };
}

function resolveArtifactPath(runDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('provider artifact path must be a non-empty relative path');
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`provider artifact path must be relative: ${relativePath}`);
  }
  const root = path.resolve(runDir);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`provider artifact path escapes run directory: ${relativePath}`);
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch (error) {
    throw new Error(`provider artifact run directory cannot be resolved: ${root}: ${error.message}`);
  }

  // For a path that does not exist yet, resolving the nearest existing ancestor
  // catches a junction/symlink before a later write follows it outside runDir.
  let existing = resolved;
  while (true) {
    let stat;
    try {
      stat = fs.lstatSync(existing);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw new Error(`provider artifact path cannot be inspected: ${relativePath}: ${error.message}`);
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new Error(`provider artifact path has no resolvable ancestor: ${relativePath}`);
      }
      existing = parent;
      continue;
    }
    if (!stat) {
      throw new Error(`provider artifact path cannot be inspected: ${relativePath}`);
    }
    break;
  }

  let realExisting;
  try {
    realExisting = fs.realpathSync.native(existing);
  } catch (error) {
    throw new Error(
      `provider artifact path traverses an unresolved link: ${relativePath}: ${error.message}`
    );
  }
  const realRelative = path.relative(realRoot, realExisting);
  if (realRelative === '..'
      || realRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(realRelative)) {
    throw new Error(`provider artifact path escapes run directory through a link: ${relativePath}`);
  }
  return {
    absolutePath: resolved,
    relativePath: relative.replace(/\\/g, '/'),
  };
}

function artifactHash(file, format) {
  if (!fs.existsSync(file)) throw new Error(`provider artifact is missing: ${file}`);
  if (format === 'json') {
    return stableHash(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  if (format === 'text') {
    return stableHash(fs.readFileSync(file, 'utf8'));
  }
  throw new Error(`unsupported provider artifact format: ${format}`);
}

function createArtifactManifest(runDir, definitions, evidence = {}) {
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
    throw new Error('provider artifact definitions must be an object');
  }
  const artifacts = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (!definition || definition.enabled === false) continue;
    const evidenceKey = definition.evidenceKey;
    const expectedHash = evidenceKey ? evidence[evidenceKey] : null;
    if (!expectedHash && definition.required !== false) {
      throw new Error(`provider artifact ${name} is missing ${evidenceKey} evidence`);
    }
    if (!expectedHash) continue;
    const resolved = resolveArtifactPath(runDir, definition.path);
    const actualHash = artifactHash(resolved.absolutePath, definition.format);
    if (actualHash !== expectedHash) {
      throw new Error(
        `provider artifact ${name} hash mismatch: evidence=${expectedHash}, actual=${actualHash}`
      );
    }
    artifacts[name] = {
      path: resolved.relativePath,
      format: definition.format,
      evidenceKey,
      hash: actualHash,
    };
  }
  return {
    schemaVersion: 'provider-artifact-manifest-v1',
    artifacts,
    manifestHash: stableHash(artifacts),
  };
}

function verifyArtifactManifest(runDir, manifest, evidence = {}) {
  if (!manifest || manifest.schemaVersion !== 'provider-artifact-manifest-v1') {
    throw new Error('provider artifact manifest is missing or unsupported');
  }
  const artifacts = manifest.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error('provider artifact manifest entries are missing');
  }
  if (stableHash(artifacts) !== manifest.manifestHash) {
    throw new Error('provider artifact manifest hash mismatch');
  }
  for (const [name, entry] of Object.entries(artifacts)) {
    const resolved = resolveArtifactPath(runDir, entry.path);
    const expectedHash = evidence[entry.evidenceKey];
    if (!expectedHash || expectedHash !== entry.hash) {
      throw new Error(`provider artifact ${name} evidence hash mismatch`);
    }
    const actualHash = artifactHash(resolved.absolutePath, entry.format);
    if (actualHash !== entry.hash) {
      throw new Error(
        `provider artifact ${name} content hash mismatch: recorded=${entry.hash}, actual=${actualHash}`
      );
    }
  }
  return true;
}

function providerRecoveryRecord(input = {}) {
  if (!input.attempt || !input.effects) return null;
  const runtime = input.attempt.profile.runtime;
  const sourceRefs = input.runtimeRefs && typeof input.runtimeRefs === 'object'
    ? input.runtimeRefs
    : {};
  const runtimeRefs = runtime === 'claude'
    ? {
      ...(sourceRefs.sessionId || sourceRefs.claudeSession
        ? { sessionId: String(sourceRefs.sessionId || sourceRefs.claudeSession) }
        : {}),
    }
    : {
      ...(sourceRefs.threadId || sourceRefs.codexThread
        ? { threadId: String(sourceRefs.threadId || sourceRefs.codexThread) }
        : {}),
      ...(sourceRefs.turnId || sourceRefs.codexTurn
        ? { turnId: String(sourceRefs.turnId || sourceRefs.codexTurn) }
        : {}),
    };
  const nativeRefAvailable = runtime === 'claude'
    ? Boolean(runtimeRefs.sessionId)
    : Boolean(runtimeRefs.threadId);
  const reconcileRequired = input.forceReconcile === true
    || (input.effects.state === 'partial' && !nativeRefAvailable);
  const resumeMode = nativeRefAvailable
    ? (reconcileRequired ? 'reconcile' : 'native')
    : (reconcileRequired ? 'reconcile' : 'restart');
  return {
    schemaVersion: 'provider-recovery-v1',
    required: true,
    runId: input.runId,
    providerRef: input.attempt.providerRef,
    providerKey: input.providerKey,
    runtime,
    adapter: input.attempt.capabilitySnapshot.adapter,
    stage: input.stage,
    taskRef: input.attempt.task.ref,
    effectsState: input.effects.state,
    effectsRef: input.effects.snapshotHash,
    runtimeRefs,
    resumeMode,
    reconcileRequired,
    failureKind: input.failureKind || 'provider-failure',
    failedAt: input.failedAt || new Date().toISOString(),
  };
}

function providerResumeRefs(recovery, input = {}) {
  if (!recovery || recovery.required !== true || recovery.resumeMode !== 'native') return {};
  if (recovery.runtime !== input.runtime
      || recovery.providerKey !== input.providerKey
      || recovery.stage !== input.stage) {
    return {};
  }
  return recovery.runtimeRefs && typeof recovery.runtimeRefs === 'object'
    ? { ...recovery.runtimeRefs }
    : {};
}

module.exports = {
  artifactHash,
  createArtifactManifest,
  createEffectSnapshot,
  normalizeSnapshot,
  providerRecoveryRecord,
  providerResumeRefs,
  resolveArtifactPath,
  verifyArtifactManifest,
};
