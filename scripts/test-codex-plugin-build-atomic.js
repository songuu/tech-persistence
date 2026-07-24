#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isMainThread,
  Worker,
  workerData,
} = require('worker_threads');
const { hashPath } = require('./codex-runtime-doctor');
const {
  acquireBuildLock,
  publishFileAtomically,
  publishProjectionTransaction,
  recoverProjectionTransaction,
  SOURCE_PROJECTION_CONTRACT,
  syncManagedDirectory,
} = require('../plugins/tech-persistence/scripts/build-codex-plugin');

const CHILD_MODE = 'publish-fixture';

function safeRemoveTemporaryRoot(root) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(root);
  if (!resolved.startsWith(`${temporaryRoot}${path.sep}`)) {
    throw new Error(`refusing unsafe test cleanup: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function withWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-codex-build-atomic-'));
  try {
    return fn(root);
  } finally {
    safeRemoveTemporaryRoot(root);
  }
}

function writeFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function runFixturePublisher({
  allowedRoot,
  stageDir,
  targetDir,
  lockPath,
  failAfterPublish,
  hardExitAfterPublish,
  hardExitAfterCommit,
  hardExitAfterClaim,
  hardExitAfterClaimSyscall,
  hardExitAfterInstallSyscall,
  hardExitAfterTemporaryCopy,
  hardExitAfterParentMkdir,
  hardExitAfterShadowWrite,
  hardExitDuringInitialSnapshot,
  hardExitDuringRecoveryCleanup,
}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: {
        mode: CHILD_MODE,
        allowedRoot,
        stageDir,
        targetDir,
        lockPath,
        failAfterPublish,
        hardExitAfterPublish,
        hardExitAfterCommit,
        hardExitAfterClaim,
        hardExitAfterClaimSyscall,
        hardExitAfterInstallSyscall,
        hardExitAfterTemporaryCopy,
        hardExitAfterParentMkdir,
        hardExitAfterShadowWrite,
        hardExitDuringInitialSnapshot,
        hardExitDuringRecoveryCleanup,
      },
    });
    worker.on('error', reject);
    worker.on('exit', (status) => resolve({ status }));
  });
}

function runChildMode() {
  process.env.NODE_ENV = 'test';
  if (workerData.hardExitAfterClaimSyscall) {
    const originalRenameSync = fs.renameSync;
    fs.renameSync = function crashAfterClaimRename(source, target) {
      const result = originalRenameSync.apply(this, arguments);
      if (path.basename(target) === 'value') process.exit(90);
      return result;
    };
  }
  if (workerData.hardExitAfterInstallSyscall) {
    const originalLinkSync = fs.linkSync;
    fs.linkSync = function crashAfterInstallLink(source, target) {
      const result = originalLinkSync.apply(this, arguments);
      if (path.resolve(target).startsWith(`${path.resolve(workerData.targetDir)}${path.sep}`)) {
        process.exit(91);
      }
      return result;
    };
  }
  if (workerData.hardExitAfterTemporaryCopy) {
    const originalCopyFileSync = fs.copyFileSync;
    fs.copyFileSync = function crashAfterTemporaryCopy(source, target) {
      const result = originalCopyFileSync.apply(this, arguments);
      if (path.basename(target).includes('.tp-publish-')) process.exit(94);
      return result;
    };
  }
  if (workerData.hardExitAfterParentMkdir) {
    const originalMkdirSync = fs.mkdirSync;
    const nestedParent = path.resolve(workerData.targetDir, 'nested');
    fs.mkdirSync = function crashAfterParentMkdir(target) {
      const result = originalMkdirSync.apply(this, arguments);
      if (path.resolve(target) === nestedParent) process.exit(95);
      return result;
    };
  }
  if (workerData.hardExitAfterShadowWrite) {
    const originalCopyFileSync = fs.copyFileSync;
    const manifestPath = path.join(
      path.resolve(workerData.allowedRoot),
      '.tech-persistence-publish-recovery',
      'manifest.json'
    );
    fs.copyFileSync = function crashAfterShadowWrite(source, target) {
      const result = originalCopyFileSync.apply(this, arguments);
      const normalized = String(target).replace(/\\/g, '/');
      if (fs.existsSync(manifestPath)
        && normalized.includes('/.tech-persistence-publish-recovery/snapshots/expected/')) {
        process.exit(96);
      }
      return result;
    };
  }
  if (workerData.hardExitDuringInitialSnapshot) {
    const originalCopyFileSync = fs.copyFileSync;
    fs.copyFileSync = function crashDuringInitialSnapshot(source, target) {
      const result = originalCopyFileSync.apply(this, arguments);
      const normalized = String(target).replace(/\\/g, '/');
      if (normalized.includes('/.tech-persistence-publish-recovery/snapshots/')) process.exit(92);
      return result;
    };
  }
  if (workerData.hardExitDuringRecoveryCleanup) {
    const originalRmSync = fs.rmSync;
    const recoveryRoot = path.join(
      path.resolve(workerData.allowedRoot),
      '.tech-persistence-publish-recovery'
    );
    fs.rmSync = function crashDuringRecoveryCleanup(target, options) {
      if (path.resolve(target) === recoveryRoot && options && options.recursive) {
        const manifestPath = path.join(recoveryRoot, 'manifest.json');
        if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
        process.exit(93);
      }
      return originalRmSync.apply(this, arguments);
    };
  }
  if (workerData.failAfterPublish) {
    process.env.TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH = String(workerData.failAfterPublish);
  }
  if (workerData.hardExitAfterPublish) {
    process.env.TECH_PERSISTENCE_BUILD_TEST_HARD_EXIT_AFTER_PUBLISH = String(workerData.hardExitAfterPublish);
  }
  if (workerData.hardExitAfterCommit) {
    process.env.TECH_PERSISTENCE_BUILD_TEST_HARD_EXIT_AFTER_COMMIT = '1';
  }
  if (workerData.hardExitAfterClaim) {
    process.env.TECH_PERSISTENCE_BUILD_TEST_HARD_EXIT_AFTER_CLAIM = '1';
  }
  const releaseLock = acquireBuildLock({
    lockPath: workerData.lockPath,
    timeoutMs: 5000,
    staleMs: 60000,
  });
  try {
    publishProjectionTransaction({
      allowedRoot: workerData.allowedRoot,
      directories: [{
        stageDir: workerData.stageDir,
        targetDir: workerData.targetDir,
      }],
    });
  } finally {
    releaseLock();
  }
}

async function createHardCrashFixture(prefix = 'tp-codex-build-recovery-', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const allowedRoot = path.join(root, 'target-root');
  const targetDir = path.join(allowedRoot, 'projection');
  const stageDir = path.join(root, 'stage');
  const lockPath = path.join(root, 'build.lock');
  writeFile(path.join(targetDir, 'a.txt'), 'old-a');
  writeFile(path.join(targetDir, 'b.txt'), 'old-b');
  writeFile(path.join(stageDir, 'a.txt'), 'new-a');
  writeFile(path.join(stageDir, 'b.txt'), 'new-b');
  if (options.includeNestedStage) writeFile(path.join(stageDir, 'nested', 'c.txt'), 'new-c');
  const result = await runFixturePublisher({
    allowedRoot,
    stageDir,
    targetDir,
    lockPath,
    hardExitAfterPublish: options.hardExitAfterPublish,
    hardExitAfterCommit: options.hardExitAfterCommit,
    hardExitAfterClaim: options.hardExitAfterClaim,
    hardExitAfterClaimSyscall: options.hardExitAfterClaimSyscall,
    hardExitAfterInstallSyscall: options.hardExitAfterInstallSyscall,
    hardExitAfterTemporaryCopy: options.hardExitAfterTemporaryCopy,
    hardExitAfterParentMkdir: options.hardExitAfterParentMkdir,
    hardExitAfterShadowWrite: options.hardExitAfterShadowWrite,
    hardExitDuringInitialSnapshot: options.hardExitDuringInitialSnapshot,
    hardExitDuringRecoveryCleanup: options.hardExitDuringRecoveryCleanup,
  });
  const recoveryRoot = path.join(allowedRoot, '.tech-persistence-publish-recovery');
  const manifestPath = path.join(recoveryRoot, 'manifest.json');
  return {
    root,
    allowedRoot,
    targetDir,
    stageDir,
    lockPath,
    recoveryRoot,
    manifestPath,
    result,
  };
}

function withTestEnvironment(values, fn) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of previous.entries()) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected operation to throw');
}

function assertRetainedRollbackEvidence(error) {
  assert.match(error.message, /backup retained at/i);
  assert.strictEqual(typeof error.backupRoot, 'string');
  assert.strictEqual(typeof error.evidencePath, 'string');
  assert.strictEqual(typeof error.manifestPath, 'string');
  assert(fs.existsSync(error.backupRoot), 'retained backup root must exist');
  assert(fs.existsSync(error.evidencePath), 'rollback evidence must exist');
  assert(fs.existsSync(error.manifestPath), 'durable recovery manifest must exist');
  const evidence = JSON.parse(fs.readFileSync(error.evidencePath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(error.manifestPath, 'utf8'));
  assert.strictEqual(evidence.backupRoot, error.backupRoot);
  assert(evidence.publishFailure && evidence.publishFailure.message);
  assert(evidence.rollbackFailure && evidence.rollbackFailure.message);
  assert.strictEqual(manifest.phase, 'rollback-failed');
  assert(Array.isArray(manifest.snapshots) && manifest.snapshots.length > 0);
  return evidence;
}

async function testRejectsJunctionBeforeWriting() {
  withWorkspace((root) => {
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(root, 'target');
    const outsideDir = path.join(root, 'outside');
    writeFile(path.join(stageDir, 'nested', 'payload.txt'), 'payload');
    fs.mkdirSync(targetDir);
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, path.join(targetDir, 'nested'), 'junction');

    assert.throws(
      () => syncManagedDirectory(stageDir, targetDir, { allowedRoot: targetDir }),
      /symbolic link|junction|reparse/i
    );
    assert.strictEqual(
      fs.existsSync(path.join(outsideDir, 'payload.txt')),
      false,
      'target junction must be rejected before the first escaped write'
    );
  });
}

async function testRejectsLexicalEscapeBeforeWriting() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'allowed');
    const stageDir = path.join(root, 'stage');
    const escapedTarget = path.join(root, 'outside', 'projection');
    writeFile(path.join(stageDir, 'payload.txt'), 'payload');
    fs.mkdirSync(allowedRoot);

    assert.throws(
      () => syncManagedDirectory(stageDir, escapedTarget, { allowedRoot }),
      /outside allowed publish root/i
    );
    assert.strictEqual(fs.existsSync(escapedTarget), false);
  });
}

async function testTransientManifestRenameRetriesWithoutRecovery() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(allowedRoot, 'projection');
    const target = path.join(targetDir, 'a.txt');
    writeFile(path.join(stageDir, 'a.txt'), 'new-a');
    writeFile(target, 'old-a');

    const originalRenameSync = fs.renameSync;
    let transientFailures = 0;
    fs.renameSync = function failTransientManifestRename(source, destination) {
      if (transientFailures < 2
        && path.basename(destination) === 'manifest.json'
        && path.basename(source).startsWith('.manifest.json.tmp-')) {
        transientFailures += 1;
        const failure = new Error('injected transient manifest rename failure');
        failure.code = 'EPERM';
        throw failure;
      }
      return originalRenameSync.apply(this, arguments);
    };
    try {
      const result = publishProjectionTransaction({
        allowedRoot,
        directories: [{ stageDir, targetDir }],
      });
      assert.strictEqual(result.changedTargets, 1);
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.strictEqual(transientFailures, 2);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new-a');
    assert.strictEqual(
      fs.existsSync(path.join(allowedRoot, '.tech-persistence-publish-recovery')),
      false
    );
  });
}

async function testRollbackRestoresWholeSnapshot() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const firstStage = path.join(root, 'stage-first');
    const secondStage = path.join(root, 'stage-second');
    const firstTarget = path.join(allowedRoot, 'first');
    const secondTarget = path.join(allowedRoot, 'second');
    writeFile(path.join(firstStage, 'a.txt'), 'new-a');
    writeFile(path.join(firstStage, 'new-only.txt'), 'new-only');
    writeFile(path.join(secondStage, 'b.txt'), 'new-b');
    writeFile(path.join(firstTarget, 'a.txt'), 'old-a');
    writeFile(path.join(secondTarget, 'b.txt'), 'old-b');
    const before = hashPath(allowedRoot);
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFailurePoint = process.env.TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH;
    process.env.NODE_ENV = 'test';
    process.env.TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH = '1';
    try {
      assert.throws(
        () => publishProjectionTransaction({
          allowedRoot,
          directories: [
            { stageDir: firstStage, targetDir: firstTarget },
            { stageDir: secondStage, targetDir: secondTarget },
          ],
        }),
        /injected publish failure/
      );
    } finally {
      if (previousFailurePoint === undefined) {
        delete process.env.TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH;
      } else {
        process.env.TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH = previousFailurePoint;
      }
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
    assert.strictEqual(hashPath(allowedRoot), before, 'rollback must restore every old byte');
    assert.deepStrictEqual(
      fs.readdirSync(firstTarget).sort(),
      ['a.txt'],
      'rollback must not leave transaction artifacts'
    );
  });
}

async function testRollbackRemovesNewProjectionTree() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(allowedRoot, 'new-projection');
    fs.mkdirSync(allowedRoot);
    writeFile(path.join(stageDir, 'nested', 'a.txt'), 'new-a');
    const error = withTestEnvironment({
      NODE_ENV: 'test',
      TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH: '1',
    }, () => captureError(() => publishProjectionTransaction({
      allowedRoot,
      directories: [{ stageDir, targetDir }],
    })));
    assert.match(error.message, /injected publish failure/);
    assert.strictEqual(fs.existsSync(targetDir), false, 'rollback must remove a newly created projection tree');
  });
}

async function testRollbackFailureRetainsBackupAndEvidence() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(allowedRoot, 'projection');
    writeFile(path.join(stageDir, 'a.txt'), 'new-a');
    writeFile(path.join(targetDir, 'a.txt'), 'old-a');
    let error;
    try {
      error = withTestEnvironment({
        NODE_ENV: 'test',
        TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH: '1',
      }, () => captureError(() => publishProjectionTransaction({
        allowedRoot,
        directories: [{ stageDir, targetDir }],
        testHooks: {
          beforeRollbackOperation() {
            throw new Error('injected rollback operation failure');
          },
        },
      })));
      const evidence = assertRetainedRollbackEvidence(error);
      assert.match(evidence.rollbackFailure.message, /injected rollback operation failure/);
      assert.strictEqual(fs.readFileSync(path.join(error.backupRoot, '0', 'a.txt'), 'utf8'), 'old-a');
      assert.strictEqual(fs.readFileSync(path.join(targetDir, 'a.txt'), 'utf8'), 'new-a');
    } finally {
      if (error && error.backupRoot && fs.existsSync(error.backupRoot)) {
        safeRemoveTemporaryRoot(error.backupRoot);
      }
    }
  });
}

async function testRollbackFailureJournalPreservesInterruptedOperation() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(allowedRoot, 'projection');
    const target = path.join(targetDir, 'a.txt');
    writeFile(path.join(stageDir, 'a.txt'), 'new-a');
    writeFile(target, 'old-a');

    const originalRenameSync = fs.renameSync;
    let injectedFailures = 0;
    let error;
    fs.renameSync = function failBeforeClaimReleaseCheckpoint(source, destination) {
      if (path.basename(destination) === 'manifest.json'
        && path.basename(source).startsWith('.manifest.json.tmp-')) {
        const pending = JSON.parse(fs.readFileSync(source, 'utf8'));
        if (pending.phase === 'publish write:before-claim-release') {
          injectedFailures += 1;
          const failure = new Error('injected manifest rename failure');
          failure.code = 'EPERM';
          throw failure;
        }
      }
      return originalRenameSync.apply(this, arguments);
    };
    try {
      error = captureError(() => publishProjectionTransaction({
        allowedRoot,
        directories: [{ stageDir, targetDir }],
      }));
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.strictEqual(injectedFailures, 20);
    assertRetainedRollbackEvidence(error);
    const manifest = JSON.parse(fs.readFileSync(error.manifestPath, 'utf8'));
    const operation = manifest.currentOperation;
    assert.strictEqual(manifest.phase, 'rollback-failed');
    assert.strictEqual(operation.state, 'before-claim-release');
    assert.strictEqual(operation.kind, 'claim-release');
    assert.strictEqual(operation.target, path.resolve(target));
    assert.strictEqual(
      operation.sourceFingerprint,
      `file:${crypto.createHash('sha256').update('new-a').digest('hex')}`
    );
    assert.strictEqual(
      operation.expectedFingerprint,
      `file:${crypto.createHash('sha256').update('old-a').digest('hex')}`
    );
    assert.strictEqual(typeof operation.claimPath, 'string');
    assert(fs.existsSync(operation.claimPath));

    const recovery = recoverProjectionTransaction(allowedRoot);
    assert.strictEqual(recovery.action, 'restored-original');
    assert.strictEqual(fs.existsSync(error.recoveryRoot), false);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old-a');
  });
}

async function testWriteDriftFailsClosed() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(allowedRoot, 'projection');
    const target = path.join(targetDir, 'a.txt');
    writeFile(path.join(stageDir, 'a.txt'), 'builder-new');
    writeFile(target, 'old');
    let injected = false;
    let error;
    try {
      error = withTestEnvironment({ NODE_ENV: 'test' }, () => captureError(
        () => publishProjectionTransaction({
          allowedRoot,
          directories: [{ stageDir, targetDir }],
          testHooks: {
            beforeTargetClaimRename(context) {
              if (injected || context.phase !== 'publish write' || context.target !== target) return;
              injected = true;
              fs.writeFileSync(target, 'external-write');
            },
          },
        })
      ));
      assert.strictEqual(injected, true);
      assert.strictEqual(error.cause && error.cause.code, 'TECH_PERSISTENCE_TARGET_DRIFT');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-write');
      assertRetainedRollbackEvidence(error);
    } finally {
      if (error && error.backupRoot && fs.existsSync(error.backupRoot)) {
        safeRemoveTemporaryRoot(error.backupRoot);
      }
    }
  });
}

async function testNewWriteUsesCreateIfAbsentWithoutClobbering() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(allowedRoot, 'projection');
    const target = path.join(targetDir, 'new.txt');
    writeFile(path.join(stageDir, 'new.txt'), 'builder-new');
    fs.mkdirSync(allowedRoot);
    let injected = false;
    let error;
    try {
      error = withTestEnvironment({ NODE_ENV: 'test' }, () => captureError(
        () => publishProjectionTransaction({
          allowedRoot,
          directories: [{ stageDir, targetDir }],
          testHooks: {
            beforeNoClobberInstall(context) {
              if (injected || context.phase !== 'publish write' || context.target !== target) return;
              injected = true;
              fs.writeFileSync(target, 'external-create');
            },
          },
        })
      ));
      assert.strictEqual(injected, true);
      assert.strictEqual(error.cause && error.cause.code, 'TECH_PERSISTENCE_TARGET_DRIFT');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-create');
      assertRetainedRollbackEvidence(error);
    } finally {
      if (error && error.backupRoot && fs.existsSync(error.backupRoot)) {
        safeRemoveTemporaryRoot(error.backupRoot);
      }
    }
  });
}

async function testRemoveDriftFailsClosed() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(allowedRoot, 'projection');
    const obsolete = path.join(targetDir, 'obsolete.txt');
    writeFile(path.join(stageDir, 'keep.txt'), 'keep');
    writeFile(path.join(targetDir, 'keep.txt'), 'keep');
    writeFile(obsolete, 'old-obsolete');
    let injected = false;
    let error;
    try {
      error = withTestEnvironment({ NODE_ENV: 'test' }, () => captureError(
        () => publishProjectionTransaction({
          allowedRoot,
          directories: [{ stageDir, targetDir }],
          testHooks: {
            beforeTargetClaimRename(context) {
              if (injected || context.phase !== 'publish remove' || context.target !== obsolete) return;
              injected = true;
              fs.writeFileSync(obsolete, 'external-remove-race');
            },
          },
        })
      ));
      assert.strictEqual(injected, true);
      assert.strictEqual(error.cause && error.cause.code, 'TECH_PERSISTENCE_TARGET_DRIFT');
      assert.strictEqual(fs.readFileSync(obsolete, 'utf8'), 'external-remove-race');
      assertRetainedRollbackEvidence(error);
    } finally {
      if (error && error.backupRoot && fs.existsSync(error.backupRoot)) {
        safeRemoveTemporaryRoot(error.backupRoot);
      }
    }
  });
}

async function testRollbackDriftFailsClosed() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(allowedRoot, 'projection');
    const target = path.join(targetDir, 'a.txt');
    writeFile(path.join(stageDir, 'a.txt'), 'new-a');
    writeFile(target, 'old-a');
    let injected = false;
    let error;
    try {
      error = withTestEnvironment({
        NODE_ENV: 'test',
        TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH: '1',
      }, () => captureError(() => publishProjectionTransaction({
        allowedRoot,
        directories: [{ stageDir, targetDir }],
        testHooks: {
          beforeTargetClaimRename(context) {
            if (injected || context.phase !== 'rollback write' || context.target !== target) return;
            injected = true;
            fs.writeFileSync(target, 'external-during-rollback');
          },
        },
      })));
      assert.strictEqual(injected, true);
      assert.strictEqual(error.rollbackCause && error.rollbackCause.code, 'TECH_PERSISTENCE_TARGET_DRIFT');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-during-rollback');
      assertRetainedRollbackEvidence(error);
    } finally {
      if (error && error.backupRoot && fs.existsSync(error.backupRoot)) {
        safeRemoveTemporaryRoot(error.backupRoot);
      }
    }
  });
}

async function testRollbackDirectoryClaimRetainsExternalData() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(allowedRoot, 'new-projection');
    writeFile(path.join(stageDir, 'a.txt'), 'new-a');
    fs.mkdirSync(allowedRoot);
    let injected = false;
    let error;
    try {
      error = withTestEnvironment({
        NODE_ENV: 'test',
        TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH: '1',
      }, () => captureError(() => publishProjectionTransaction({
        allowedRoot,
        directories: [{ stageDir, targetDir }],
        testHooks: {
          beforeTargetClaimRename(context) {
            if (injected || context.phase !== 'rollback directory remove' || context.target !== targetDir) return;
            injected = true;
            fs.writeFileSync(path.join(targetDir, 'external.txt'), 'external-during-directory-remove');
          },
        },
      })));
      assert.strictEqual(injected, true);
      assert.strictEqual(error.rollbackCause && error.rollbackCause.code, 'TECH_PERSISTENCE_TARGET_DRIFT');
      assert.strictEqual(
        fs.readFileSync(path.join(targetDir, 'external.txt'), 'utf8'),
        'external-during-directory-remove'
      );
      assertRetainedRollbackEvidence(error);
    } finally {
      if (error && error.backupRoot && fs.existsSync(error.backupRoot)) {
        safeRemoveTemporaryRoot(error.backupRoot);
      }
    }
  });
}

async function testRollbackRestoresEntrypointLast() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'target');
    const stageDir = path.join(root, 'stage');
    const targetDir = path.join(allowedRoot, 'projection');
    writeFile(path.join(stageDir, 'hook.js'), 'new-hook');
    writeFile(path.join(stageDir, 'hooks.json'), `${JSON.stringify({ script: 'hook.js', version: 'new' })}\n`);
    writeFile(path.join(targetDir, 'hook.js'), 'old-hook');
    writeFile(path.join(targetDir, 'hooks.json'), `${JSON.stringify({ script: 'hook.js', version: 'old' })}\n`);
    const rollbackOrder = [];
    const error = withTestEnvironment({
      NODE_ENV: 'test',
      TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH: '2',
    }, () => captureError(() => publishProjectionTransaction({
      allowedRoot,
      directories: [{ stageDir, targetDir }],
      testHooks: {
        beforeTargetClaimRename(context) {
          if (context.phase === 'rollback write') rollbackOrder.push(path.basename(context.target));
        },
      },
    })));
    assert.match(error.message, /injected publish failure/);
    assert.deepStrictEqual(rollbackOrder, ['hook.js', 'hooks.json']);
    assert.strictEqual(fs.readFileSync(path.join(targetDir, 'hook.js'), 'utf8'), 'old-hook');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(targetDir, 'hooks.json'), 'utf8')).version, 'old');
  });
}

async function testFinalCheckJunctionSwapFailsClosed() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'allowed');
    const source = path.join(root, 'stage', 'payload.txt');
    const nested = path.join(allowedRoot, 'managed', 'nested');
    const moved = path.join(allowedRoot, 'managed', 'nested-original');
    const target = path.join(nested, 'payload.txt');
    const outside = path.join(root, 'outside');
    const outsideTarget = path.join(outside, 'payload.txt');
    writeFile(source, 'builder-new');
    writeFile(target, 'old');
    writeFile(outsideTarget, 'outside-sentinel');
    let swapped = false;
    let error;
    try {
      error = withTestEnvironment({ NODE_ENV: 'test' }, () => captureError(
        () => publishFileAtomically(source, target, {
          allowedRoot,
          testHooks: {
            beforeTargetClaimRename() {
              if (swapped) return;
              swapped = true;
              fs.renameSync(nested, moved);
              fs.symlinkSync(outside, nested, 'junction');
            },
          },
        })
      ));
      assert.strictEqual(swapped, true);
      assert.match(error.message, /parent changed|symbolic link|junction/i);
      assert.strictEqual(fs.readFileSync(outsideTarget, 'utf8'), 'outside-sentinel');
    } finally {
      if (fs.existsSync(nested) && fs.lstatSync(nested).isSymbolicLink()) fs.unlinkSync(nested);
      if (fs.existsSync(moved)) fs.renameSync(moved, nested);
    }
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old');
  });
}

async function testInstallHookJunctionSwapFailsBeforeLink() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'allowed');
    const source = path.join(root, 'stage', 'payload.txt');
    const nested = path.join(allowedRoot, 'managed', 'nested');
    const moved = path.join(allowedRoot, 'managed', 'nested-original');
    const target = path.join(nested, 'payload.txt');
    const outside = path.join(root, 'outside');
    const outsideTarget = path.join(outside, 'payload.txt');
    writeFile(source, 'builder-new');
    fs.mkdirSync(nested, { recursive: true });
    writeFile(path.join(outside, 'sentinel.txt'), 'outside-sentinel');
    let swapped = false;
    try {
      const error = withTestEnvironment({ NODE_ENV: 'test' }, () => captureError(
        () => publishFileAtomically(source, target, {
          allowedRoot,
          testHooks: {
            beforeNoClobberInstall() {
              swapped = true;
              fs.renameSync(nested, moved);
              fs.symlinkSync(outside, nested, 'junction');
            },
          },
        })
      ));
      assert.strictEqual(swapped, true);
      assert.match(error.message, /parent changed|symbolic link|junction/i);
      assert.strictEqual(fs.existsSync(outsideTarget), false, 'link syscall must not enter the replacement junction');
      assert.strictEqual(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside-sentinel');
    } finally {
      if (fs.existsSync(nested) && fs.lstatSync(nested).isSymbolicLink()) fs.unlinkSync(nested);
      if (fs.existsSync(moved)) fs.renameSync(moved, nested);
    }
    assert.strictEqual(fs.existsSync(target), false);
  });
}

async function testLiveOldLockCannotBeStolen() {
  withWorkspace((root) => {
    const lockPath = path.join(root, 'build.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live-owner' }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    assert.throws(
      () => acquireBuildLock({ lockPath, staleMs: 1, timeoutMs: 75 }),
      /timed out waiting/
    );
    assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'live-owner');
  });
}

async function testDeadOwnerLockIsRecovered() {
  withWorkspace((root) => {
    const lockPath = path.join(root, 'build.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
    const releaseLock = acquireBuildLock({ lockPath, staleMs: 60_000, timeoutMs: 500 });
    try {
      assert.notStrictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'dead-owner');
    } finally {
      releaseLock();
    }
  });
}

async function testSourceProjectionContractIsExplicitlyOffline() {
  assert.deepStrictEqual(SOURCE_PROJECTION_CONTRACT, {
    mode: 'offline-source-projection',
    activeRuntime: 'installer-cache-only',
    liveReaderAtomicity: false,
  });
}

async function testJsEntrypointPublishesAfterItsDependencyClosure() {
  withWorkspace((root) => {
    const allowedRoot = path.join(root, 'plugin');
    const stageRoot = path.join(root, 'stage');
    const stageDependencies = path.join(stageRoot, 'scripts', 'agent-orchestrator');
    const targetDependencies = path.join(allowedRoot, 'scripts', 'agent-orchestrator');
    const stageEntrypoint = path.join(stageRoot, 'scripts', 'agent-orchestrator.js');
    const targetEntrypoint = path.join(allowedRoot, 'scripts', 'agent-orchestrator.js');
    const stageDependency = path.join(stageDependencies, 'pipeline.js');
    const targetDependency = path.join(targetDependencies, 'pipeline.js');
    writeFile(stageDependency, 'module.exports = "new-dependency";\n');
    writeFile(targetDependency, 'module.exports = "old-dependency";\n');
    writeFile(stageEntrypoint, 'module.exports = require("./agent-orchestrator/pipeline");\n');
    writeFile(targetEntrypoint, 'module.exports = "old-entrypoint";\n');

    const publishOrder = [];
    const rollbackOrder = [];
    const error = withTestEnvironment({
      NODE_ENV: 'test',
      TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH: '2',
    }, () => captureError(() => publishProjectionTransaction({
      allowedRoot,
      directories: [{ stageDir: stageDependencies, targetDir: targetDependencies }],
      files: [{ source: stageEntrypoint, target: targetEntrypoint }],
      testHooks: {
        beforeTargetClaimRename(context) {
          const relative = path.relative(allowedRoot, context.target).replace(/\\/g, '/');
          if (context.phase === 'publish write') publishOrder.push(relative);
          if (context.phase === 'rollback write') rollbackOrder.push(relative);
        },
      },
    })));

    assert.match(error.message, /injected publish failure/);
    assert.deepStrictEqual(publishOrder, [
      'scripts/agent-orchestrator/pipeline.js',
      'scripts/agent-orchestrator.js',
    ]);
    assert.deepStrictEqual(rollbackOrder, [
      'scripts/agent-orchestrator/pipeline.js',
      'scripts/agent-orchestrator.js',
    ]);
    assert.strictEqual(fs.readFileSync(targetDependency, 'utf8'), 'module.exports = "old-dependency";\n');
    assert.strictEqual(fs.readFileSync(targetEntrypoint, 'utf8'), 'module.exports = "old-entrypoint";\n');
  });
}

async function testHardCrashCanRestoreProvenPartialStateAndRerun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-codex-build-hard-crash-'));
  try {
    const allowedRoot = path.join(root, 'target-root');
    const targetDir = path.join(allowedRoot, 'projection');
    const stageDir = path.join(root, 'stage');
    const lockPath = path.join(root, 'build.lock');
    writeFile(path.join(targetDir, 'a.txt'), 'old-a');
    writeFile(path.join(targetDir, 'b.txt'), 'old-b');
    writeFile(path.join(stageDir, 'a.txt'), 'new-a');
    writeFile(path.join(stageDir, 'b.txt'), 'new-b');

    const result = await runFixturePublisher({
      allowedRoot,
      stageDir,
      targetDir,
      lockPath,
      hardExitAfterPublish: 1,
    });
    assert.strictEqual(result.status, 86, 'fixture must terminate without running rollback/finally');

    const recoveryRoot = path.join(allowedRoot, '.tech-persistence-publish-recovery');
    const manifestPath = path.join(recoveryRoot, 'manifest.json');
    assert(fs.existsSync(manifestPath), 'hard crash must retain a durable recovery manifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.allowedRoot, path.resolve(allowedRoot));
    assert.match(manifest.phase, /^publish/);
    assert(Number.isInteger(manifest.sequence) && manifest.sequence > 0);
    assert.strictEqual(manifest.snapshots.length, 1);
    assert.strictEqual(manifest.snapshots[0].target, path.resolve(targetDir));
    assert.strictEqual(typeof manifest.snapshots[0].originalFingerprint, 'string');
    assert(fs.existsSync(manifest.snapshots[0].backup));
    assert(Array.isArray(manifest.claims) && manifest.claims.length > 0);
    assert(manifest.claims.some((claim) => claim.target === path.resolve(path.join(targetDir, 'a.txt'))));
    assert.strictEqual(manifest.currentOperation.target, path.resolve(path.join(targetDir, 'a.txt')));

    const partialFingerprint = hashPath(targetDir);
    const restartError = captureError(() => publishProjectionTransaction({
      allowedRoot,
      directories: [{ stageDir, targetDir }],
    }));
    assert.strictEqual(restartError.code, 'TECH_PERSISTENCE_RECOVERY_REQUIRED');
    assert.strictEqual(restartError.manifestPath, manifestPath);
    assert.strictEqual(hashPath(targetDir), partialFingerprint, 'restart must not adopt or mutate partial state');

    const recovery = recoverProjectionTransaction(allowedRoot);
    assert.strictEqual(recovery.action, 'restored-original');
    assert.strictEqual(fs.existsSync(recoveryRoot), false, 'successful recovery must remove its evidence tree');
    assert.strictEqual(fs.readFileSync(path.join(targetDir, 'a.txt'), 'utf8'), 'old-a');
    assert.strictEqual(fs.readFileSync(path.join(targetDir, 'b.txt'), 'utf8'), 'old-b');

    const rerun = publishProjectionTransaction({
      allowedRoot,
      directories: [{ stageDir, targetDir }],
    });
    assert.strictEqual(rerun.changedTargets, 1);
    assert.strictEqual(fs.readFileSync(path.join(targetDir, 'a.txt'), 'utf8'), 'new-a');
    assert.strictEqual(fs.readFileSync(path.join(targetDir, 'b.txt'), 'utf8'), 'new-b');
  } finally {
    safeRemoveTemporaryRoot(root);
  }
}

async function testHardCrashAfterCommitFinalizesWithoutRollback() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-codex-build-hard-commit-'));
  try {
    const allowedRoot = path.join(root, 'target-root');
    const targetDir = path.join(allowedRoot, 'projection');
    const stageDir = path.join(root, 'stage');
    const lockPath = path.join(root, 'build.lock');
    writeFile(path.join(targetDir, 'a.txt'), 'old-a');
    writeFile(path.join(stageDir, 'a.txt'), 'new-a');

    const result = await runFixturePublisher({
      allowedRoot,
      stageDir,
      targetDir,
      lockPath,
      hardExitAfterCommit: true,
    });
    assert.strictEqual(result.status, 87);
    const recoveryRoot = path.join(allowedRoot, '.tech-persistence-publish-recovery');
    const manifest = JSON.parse(fs.readFileSync(path.join(recoveryRoot, 'manifest.json'), 'utf8'));
    assert.strictEqual(manifest.phase, 'committed');
    assert.strictEqual(fs.readFileSync(path.join(targetDir, 'a.txt'), 'utf8'), 'new-a');

    const recovery = recoverProjectionTransaction(allowedRoot);
    assert.strictEqual(recovery.action, 'finalized');
    assert.strictEqual(fs.existsSync(recoveryRoot), false);
    assert.strictEqual(fs.readFileSync(path.join(targetDir, 'a.txt'), 'utf8'), 'new-a');
    assert.deepStrictEqual(publishProjectionTransaction({
      allowedRoot,
      directories: [{ stageDir, targetDir }],
    }), { published: 0, removed: 0, changedTargets: 0 });
  } finally {
    safeRemoveTemporaryRoot(root);
  }
}

function assertRecoveryFailsClosed(fixture, pattern) {
  const error = captureError(() => recoverProjectionTransaction(fixture.allowedRoot));
  assert.strictEqual(error.code, 'TECH_PERSISTENCE_RECOVERY_REQUIRED');
  if (pattern) assert.match(error.message, pattern);
  assert(fs.existsSync(fixture.recoveryRoot), 'failed recovery must preserve all evidence');
  assert(fs.existsSync(fixture.manifestPath), 'failed recovery must preserve its manifest');
  return error;
}

async function testTamperedManifestPathFailsClosed() {
  const fixture = await createHardCrashFixture('tp-codex-build-manifest-tamper-', {
    hardExitAfterPublish: 1,
  });
  try {
    assert.strictEqual(fixture.result.status, 86);
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
    manifest.snapshots[0].target = path.join(fixture.root, 'outside-target');
    fs.writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assertRecoveryFailsClosed(fixture, /outside|overlaps|snapshot/i);
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testTamperedLiveTargetFailsClosed() {
  const fixture = await createHardCrashFixture('tp-codex-build-target-tamper-', {
    hardExitAfterPublish: 1,
  });
  try {
    assert.strictEqual(fixture.result.status, 86);
    const target = path.join(fixture.targetDir, 'b.txt');
    fs.writeFileSync(target, 'external-target-drift');
    assertRecoveryFailsClosed(fixture, /checkpoint|not a provable checkpointed partial state/i);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-target-drift');
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testTamperedBackupFailsClosed() {
  const fixture = await createHardCrashFixture('tp-codex-build-backup-tamper-', {
    hardExitAfterPublish: 1,
  });
  try {
    assert.strictEqual(fixture.result.status, 86);
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
    fs.writeFileSync(path.join(manifest.snapshots[0].backup, 'a.txt'), 'tampered-backup');
    assertRecoveryFailsClosed(fixture, /backup hash does not match/i);
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testRecoveryRejectsLiveTargetJunction() {
  const fixture = await createHardCrashFixture('tp-codex-build-target-link-', {
    hardExitAfterPublish: 1,
  });
  try {
    assert.strictEqual(fixture.result.status, 86);
    const original = path.join(fixture.allowedRoot, 'projection-original');
    const outside = path.join(fixture.root, 'outside');
    fs.mkdirSync(outside);
    writeFile(path.join(outside, 'sentinel.txt'), 'outside-sentinel');
    fs.renameSync(fixture.targetDir, original);
    fs.symlinkSync(outside, fixture.targetDir, 'junction');
    assertRecoveryFailsClosed(fixture, /symbolic link|junction|live target validation/i);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside-sentinel');
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testTamperedClaimHashFailsClosed() {
  const fixture = await createHardCrashFixture('tp-codex-build-claim-tamper-', {
    hardExitAfterClaim: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 88);
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
    const claimed = manifest.claims.find((claim) => claim.status === 'claimed');
    assert(claimed && fs.existsSync(claimed.claimPath), 'claim crash must preserve claimed bytes');
    fs.writeFileSync(claimed.claimPath, 'tampered-claim');
    assertRecoveryFailsClosed(fixture, /claim \d+ hash does not match/i);
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testCrashAfterClaimRenameBeforeCheckpointRecoversAndReruns() {
  const fixture = await createHardCrashFixture('tp-codex-build-claim-syscall-', {
    hardExitAfterClaimSyscall: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 90);
    assert.strictEqual(fs.existsSync(path.join(fixture.targetDir, 'a.txt')), false);
    const recovery = recoverProjectionTransaction(fixture.allowedRoot);
    assert.strictEqual(recovery.action, 'restored-original');
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'old-a');
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'b.txt'), 'utf8'), 'old-b');
    const rerun = publishProjectionTransaction({
      allowedRoot: fixture.allowedRoot,
      directories: [{ stageDir: fixture.stageDir, targetDir: fixture.targetDir }],
    });
    assert.strictEqual(rerun.changedTargets, 1);
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'new-a');
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'b.txt'), 'utf8'), 'new-b');
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testCrashAfterInstallLinkBeforeCheckpointRecoversAndReruns() {
  const fixture = await createHardCrashFixture('tp-codex-build-install-syscall-', {
    hardExitAfterInstallSyscall: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 91);
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'new-a');
    const recovery = recoverProjectionTransaction(fixture.allowedRoot);
    assert.strictEqual(recovery.action, 'restored-original');
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'old-a');
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'b.txt'), 'utf8'), 'old-b');
    const rerun = publishProjectionTransaction({
      allowedRoot: fixture.allowedRoot,
      directories: [{ stageDir: fixture.stageDir, targetDir: fixture.targetDir }],
    });
    assert.strictEqual(rerun.changedTargets, 1);
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

function rewriteAsLegacyGenericRollbackFailure(fixture) {
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  if (manifest.currentOperation && manifest.currentOperation.temporary) {
    fs.rmSync(manifest.currentOperation.temporary, { force: true });
  }
  const claim = manifest.claims.find((candidate) => (
    fs.existsSync(candidate.claimPath)
    && candidate.target === path.resolve(path.join(fixture.targetDir, 'a.txt'))
  ));
  assert(claim, 'fixture must retain the old target in a durable claim');
  claim.status = 'before-claim-release';
  claim.updatedAt = new Date().toISOString();
  manifest.phase = 'rollback-failed';
  manifest.sequence += 1;
  manifest.updatedAt = new Date().toISOString();
  manifest.currentOperation = {
    state: 'failed',
    kind: 'rollback',
    publishFailure: 'injected manifest checkpoint failure',
    rollbackFailure: 'injected rollback preflight drift',
    evidencePath: path.join(fixture.recoveryRoot, 'snapshots', 'rollback-evidence.json'),
  };
  fs.writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, claim };
}

async function testLegacyGenericRollbackFailureInfersUniqueClaimAndRecovers() {
  const fixture = await createHardCrashFixture('tp-codex-build-legacy-rollback-', {
    hardExitAfterInstallSyscall: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 91);
    rewriteAsLegacyGenericRollbackFailure(fixture);
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'new-a');

    const recovery = recoverProjectionTransaction(fixture.allowedRoot);
    assert.strictEqual(recovery.action, 'restored-original');
    assert.strictEqual(fs.existsSync(fixture.recoveryRoot), false);
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'old-a');
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'b.txt'), 'utf8'), 'old-b');

    const rerun = publishProjectionTransaction({
      allowedRoot: fixture.allowedRoot,
      directories: [{ stageDir: fixture.stageDir, targetDir: fixture.targetDir }],
    });
    assert.strictEqual(rerun.changedTargets, 1);
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testLegacyGenericRollbackFailureRejectsUnexplainedExternalDrift() {
  const fixture = await createHardCrashFixture('tp-codex-build-legacy-drift-', {
    hardExitAfterInstallSyscall: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 91);
    rewriteAsLegacyGenericRollbackFailure(fixture);
    const external = path.join(fixture.targetDir, 'b.txt');
    fs.writeFileSync(external, 'external-drift');
    const before = hashPath(fixture.targetDir);

    assertRecoveryFailsClosed(fixture, /unexplained|checkpoint|ambiguous/i);
    assert.strictEqual(hashPath(fixture.targetDir), before);
    assert.strictEqual(fs.readFileSync(external, 'utf8'), 'external-drift');
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testLegacyGenericRollbackFailureRejectsAmbiguousClaims() {
  const fixture = await createHardCrashFixture('tp-codex-build-legacy-ambiguous-', {
    hardExitAfterInstallSyscall: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 91);
    const { manifest } = rewriteAsLegacyGenericRollbackFailure(fixture);
    const secondTarget = path.resolve(path.join(fixture.targetDir, 'b.txt'));
    const secondClaimDir = fs.mkdtempSync(path.join(fixture.recoveryRoot, 'claims', 'claim-'));
    const secondClaimPath = path.join(secondClaimDir, 'value');
    fs.renameSync(secondTarget, secondClaimPath);
    fs.writeFileSync(secondTarget, 'new-b');
    const secondFingerprint = `file:${crypto.createHash('sha256').update('old-b').digest('hex')}`;
    manifest.claims.push({
      target: secondTarget,
      claimPath: secondClaimPath,
      expectedFingerprint: secondFingerprint,
      claimFingerprint: secondFingerprint,
      phase: 'publish write',
      status: 'before-claim-release',
      updatedAt: new Date().toISOString(),
    });
    manifest.sequence += 1;
    manifest.updatedAt = new Date().toISOString();
    fs.writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = hashPath(fixture.targetDir);

    assertRecoveryFailsClosed(fixture, /ambiguous|unexplained/i);
    assert.strictEqual(hashPath(fixture.targetDir), before);
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'new-a');
    assert.strictEqual(fs.readFileSync(secondTarget, 'utf8'), 'new-b');
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testCrashAfterTemporaryCopyBeforeCheckpointRecoversAndReruns() {
  const fixture = await createHardCrashFixture('tp-codex-build-temporary-syscall-', {
    hardExitAfterTemporaryCopy: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 94);
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
    assert.strictEqual(manifest.currentOperation.state, 'before-temporary-create');
    assert(fs.existsSync(manifest.currentOperation.temporary));
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'old-a');
    const recovery = recoverProjectionTransaction(fixture.allowedRoot);
    assert.strictEqual(recovery.action, 'restored-original');
    assert.strictEqual(
      fs.readdirSync(fixture.targetDir).some((name) => name.includes('.tp-publish-')),
      false,
      'recovery must remove the checkpointed adjacent temporary file'
    );
    const rerun = publishProjectionTransaction({
      allowedRoot: fixture.allowedRoot,
      directories: [{ stageDir: fixture.stageDir, targetDir: fixture.targetDir }],
    });
    assert.strictEqual(rerun.changedTargets, 1);
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testCrashAfterParentMkdirBeforeCheckpointRecoversAndReruns() {
  const fixture = await createHardCrashFixture('tp-codex-build-parent-mkdir-', {
    hardExitAfterParentMkdir: true,
    includeNestedStage: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 95);
    const nested = path.join(fixture.targetDir, 'nested');
    assert.strictEqual(fs.existsSync(nested), true);
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
    assert.strictEqual(manifest.currentOperation.state, 'before-directory-create');
    assert.strictEqual(manifest.currentOperation.target, path.resolve(nested));
    const recovery = recoverProjectionTransaction(fixture.allowedRoot);
    assert.strictEqual(recovery.action, 'restored-original');
    assert.strictEqual(fs.existsSync(nested), false);
    const rerun = publishProjectionTransaction({
      allowedRoot: fixture.allowedRoot,
      directories: [{ stageDir: fixture.stageDir, targetDir: fixture.targetDir }],
    });
    assert.strictEqual(rerun.changedTargets, 1);
    assert.strictEqual(fs.readFileSync(path.join(nested, 'c.txt'), 'utf8'), 'new-c');
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testCrashAfterShadowWriteBeforeCheckpointRecoversAndReruns() {
  const fixture = await createHardCrashFixture('tp-codex-build-shadow-write-', {
    hardExitAfterShadowWrite: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 96);
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'new-a');
    const recovery = recoverProjectionTransaction(fixture.allowedRoot);
    assert.strictEqual(recovery.action, 'restored-original');
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'old-a');
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'b.txt'), 'utf8'), 'old-b');
    const rerun = publishProjectionTransaction({
      allowedRoot: fixture.allowedRoot,
      directories: [{ stageDir: fixture.stageDir, targetDir: fixture.targetDir }],
    });
    assert.strictEqual(rerun.changedTargets, 1);
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testCrashBeforeInitialManifestRemovesOnlyCanonicalOrphanAndReruns() {
  const fixture = await createHardCrashFixture('tp-codex-build-initial-manifest-', {
    hardExitDuringInitialSnapshot: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 92);
    assert.strictEqual(fs.existsSync(fixture.manifestPath), false);
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'old-a');
    const recovery = recoverProjectionTransaction(fixture.allowedRoot);
    assert.strictEqual(recovery.action, 'removed-pre-manifest-recovery');
    const rerun = publishProjectionTransaction({
      allowedRoot: fixture.allowedRoot,
      directories: [{ stageDir: fixture.stageDir, targetDir: fixture.targetDir }],
    });
    assert.strictEqual(rerun.changedTargets, 1);
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testCrashDuringCommittedCleanupFinalizesOrphanAndReruns() {
  const fixture = await createHardCrashFixture('tp-codex-build-cleanup-crash-', {
    hardExitDuringRecoveryCleanup: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 93);
    assert.strictEqual(fs.existsSync(fixture.manifestPath), false);
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'a.txt'), 'utf8'), 'new-a');
    assert.strictEqual(fs.readFileSync(path.join(fixture.targetDir, 'b.txt'), 'utf8'), 'new-b');
    const recovery = recoverProjectionTransaction(fixture.allowedRoot);
    assert.strictEqual(recovery.action, 'finalized-manifest-less-cleanup');
    assert.deepStrictEqual(publishProjectionTransaction({
      allowedRoot: fixture.allowedRoot,
      directories: [{ stageDir: fixture.stageDir, targetDir: fixture.targetDir }],
    }), { published: 0, removed: 0, changedTargets: 0 });
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testUnknownManifestlessRecoveryContentFailsClosed() {
  const fixture = await createHardCrashFixture('tp-codex-build-unknown-orphan-', {
    hardExitDuringInitialSnapshot: true,
  });
  try {
    assert.strictEqual(fixture.result.status, 92);
    writeFile(
      path.join(fixture.recoveryRoot, 'unknown.txt'),
      'external-data'
    );

    const before = hashPath(fixture.targetDir);
    const error = captureError(() => recoverProjectionTransaction(fixture.allowedRoot));
    assert.strictEqual(error.code, 'TECH_PERSISTENCE_RECOVERY_REQUIRED');
    assert.match(error.message, /unknown entries/);
    assert.strictEqual(hashPath(fixture.targetDir), before);
    assert.strictEqual(
      fs.readFileSync(path.join(fixture.recoveryRoot, 'unknown.txt'), 'utf8'),
      'external-data'
    );
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function testExternallyDeletedActiveManifestFailsClosed() {
  const fixture = await createHardCrashFixture('tp-codex-build-deleted-active-manifest-', {
    hardExitAfterPublish: 1,
  });
  try {
    assert.strictEqual(fixture.result.status, 86);
    const recoveryRootHash = hashPath(fixture.recoveryRoot);
    const liveHash = hashPath(fixture.targetDir);
    fs.unlinkSync(fixture.manifestPath);
    const error = captureError(() => recoverProjectionTransaction(fixture.allowedRoot));
    assert.strictEqual(error.code, 'TECH_PERSISTENCE_RECOVERY_REQUIRED');
    assert.match(error.message, /active recovery transaction lost its manifest/i);
    assert.strictEqual(hashPath(fixture.targetDir), liveHash);
    assert(fs.existsSync(fixture.recoveryRoot));
    assert.notStrictEqual(recoveryRootHash, 'absent');
    assert(fs.existsSync(path.join(fixture.recoveryRoot, 'snapshots', '0')));
  } finally {
    safeRemoveTemporaryRoot(fixture.root);
  }
}

async function main() {
  const tests = [
    ['junction targets fail closed before writes', testRejectsJunctionBeforeWriting],
    ['lexical target escapes fail closed before writes', testRejectsLexicalEscapeBeforeWriting],
    ['transient manifest rename retries without recovery', testTransientManifestRenameRetriesWithoutRecovery],
    ['injected publish failure restores the complete old snapshot', testRollbackRestoresWholeSnapshot],
    ['rollback removes a newly created projection tree', testRollbackRemovesNewProjectionTree],
    ['rollback failure retains the only backup and evidence', testRollbackFailureRetainsBackupAndEvidence],
    ['rollback failure journal preserves the interrupted operation', testRollbackFailureJournalPreservesInterruptedOperation],
    ['write drift fails closed without overwriting external data', testWriteDriftFailsClosed],
    ['new writes use create-if-absent without clobbering', testNewWriteUsesCreateIfAbsentWithoutClobbering],
    ['remove drift fails closed without deleting external data', testRemoveDriftFailsClosed],
    ['rollback drift fails closed without overwriting external data', testRollbackDriftFailsClosed],
    ['rollback directory claim retains external data', testRollbackDirectoryClaimRetainsExternalData],
    ['rollback restores dependencies before its entrypoint', testRollbackRestoresEntrypointLast],
    ['final-check junction replacement fails closed', testFinalCheckJunctionSwapFailsClosed],
    ['install-hook junction replacement fails before link', testInstallHookJunctionSwapFailsBeforeLink],
    ['live old locks are never stolen by age', testLiveOldLockCannotBeStolen],
    ['dead lock owners are recovered', testDeadOwnerLockIsRecovered],
    ['source projection contract is explicitly offline', testSourceProjectionContractIsExplicitlyOffline],
    ['JavaScript entrypoint publishes after its dependency closure', testJsEntrypointPublishesAfterItsDependencyClosure],
    ['hard crash restores a proven partial state and permits rerun', testHardCrashCanRestoreProvenPartialStateAndRerun],
    ['hard crash after commit finalizes without rollback', testHardCrashAfterCommitFinalizesWithoutRollback],
    ['tampered recovery manifest path fails closed', testTamperedManifestPathFailsClosed],
    ['tampered live target fails closed', testTamperedLiveTargetFailsClosed],
    ['tampered recovery backup fails closed', testTamperedBackupFailsClosed],
    ['live target junction fails closed during recovery', testRecoveryRejectsLiveTargetJunction],
    ['tampered recovery claim hash fails closed', testTamperedClaimHashFailsClosed],
    ['claim rename syscall crash recovers and permits rerun', testCrashAfterClaimRenameBeforeCheckpointRecoversAndReruns],
    ['install link syscall crash recovers and permits rerun', testCrashAfterInstallLinkBeforeCheckpointRecoversAndReruns],
    ['legacy generic rollback failure infers one claim and recovers', testLegacyGenericRollbackFailureInfersUniqueClaimAndRecovers],
    ['legacy generic rollback failure preserves unexplained external drift', testLegacyGenericRollbackFailureRejectsUnexplainedExternalDrift],
    ['legacy generic rollback failure rejects ambiguous claims', testLegacyGenericRollbackFailureRejectsAmbiguousClaims],
    ['temporary copy syscall crash recovers and permits rerun', testCrashAfterTemporaryCopyBeforeCheckpointRecoversAndReruns],
    ['parent mkdir syscall crash recovers and permits rerun', testCrashAfterParentMkdirBeforeCheckpointRecoversAndReruns],
    ['shadow write syscall crash recovers and permits rerun', testCrashAfterShadowWriteBeforeCheckpointRecoversAndReruns],
    ['initial-manifest crash removes only canonical orphan and permits rerun', testCrashBeforeInitialManifestRemovesOnlyCanonicalOrphanAndReruns],
    ['committed cleanup crash finalizes orphan and permits rerun', testCrashDuringCommittedCleanupFinalizesOrphanAndReruns],
    ['unknown manifest-less recovery content fails closed', testUnknownManifestlessRecoveryContentFailsClosed],
    ['externally deleted active manifest preserves evidence and fails closed', testExternallyDeletedActiveManifestFailsClosed],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    await fn();
    passed += 1;
    process.stdout.write(`[OK] ${name}\n`);
  }
  process.stdout.write(`\nResults: ${passed} passed, 0 failed\n`);
}

if (!isMainThread && workerData && workerData.mode === CHILD_MODE) {
  try {
    runChildMode();
  } catch (error) {
    if (!workerData.failAfterPublish) console.error(error.stack || error.message);
    process.exitCode = 1;
  }
} else {
  main().catch((error) => {
    console.error(`[FAIL] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
