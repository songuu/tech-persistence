#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const controlStore = require('./agent-orchestrator/control-store');
const runLock = require('./agent-orchestrator/run-lock');
const goalLease = require('./agent-orchestrator/goal-lease');
const nativeControl = require('./agent-orchestrator/native-execution-control');

let passed = 0;

function test(name, run) {
  run();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

function makeRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-provider-lifecycle-'));
}

function replaceJunction(link, target) {
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link, 'junction');
}

function goalLeaseArtifacts(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((entry) => (
    entry === goalLease.GOAL_LEASE_FILE
    || entry.startsWith(`${goalLease.GOAL_LEASE_FILE}.`)
  ));
}

function authorityArtifacts(controlRoot, basename) {
  const runsDir = path.join(controlRoot, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(runsDir, entry.name, basename);
    return entry.isDirectory() && fs.existsSync(file) ? [file] : [];
  });
}

function authorityArtifactsMatching(controlRoot, predicate) {
  const runsDir = path.join(controlRoot, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const directory = path.join(runsDir, entry.name);
    return fs.readdirSync(directory)
      .filter(predicate)
      .map((name) => path.join(directory, name));
  });
}

function crashGoalLeaseAt(stage, runDir, controlRoot, providerRoot) {
  const modulePath = path.join(__dirname, 'agent-orchestrator', 'goal-lease.js');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const goalLease = require(process.env.TP_TEST_GOAL_MODULE);
    const stage = process.env.TP_TEST_CRASH_STAGE;
    const runDir = process.env.TP_TEST_RUN_DIR;
    const controlRoot = process.env.TP_TEST_CONTROL_ROOT;
    const providerRoot = process.env.TP_TEST_PROVIDER_ROOT;
    const canonicalProviderRoot = fs.realpathSync.native(providerRoot);
    if (stage === 'fence-staged') {
      const opened = new Map();
      const originalOpen = fs.openSync;
      const originalFsync = fs.fsyncSync;
      fs.openSync = (file, flags, mode) => {
        const descriptor = originalOpen(file, flags, mode);
        if (path.basename(String(file)).startsWith(goalLease.GOAL_LEASE_TRANSACTION_FILE)
            && path.basename(String(file)).endsWith('.tmp')) {
          opened.set(descriptor, String(file));
        }
        return descriptor;
      };
      fs.fsyncSync = (descriptor) => {
        const result = originalFsync(descriptor);
        if (opened.has(descriptor)) process.exit(81);
        return result;
      };
    } else if (stage === 'fence-only') {
      const original = fs.linkSync;
      fs.linkSync = (source, destination) => {
        const result = original(source, destination);
        if (path.basename(destination) === goalLease.GOAL_LEASE_TRANSACTION_FILE) process.exit(81);
        return result;
      };
    } else {
      const original = fs.renameSync;
      fs.renameSync = (source, destination) => {
        const result = original(source, destination);
        const isGoal = path.basename(destination) === goalLease.GOAL_LEASE_FILE;
        const relative = path.relative(
          canonicalProviderRoot,
          fs.realpathSync.native(destination)
        );
        const inProvider = relative === '' || (
          relative !== '..'
          && !relative.startsWith('..' + path.sep)
          && !path.isAbsolute(relative)
        );
        if (isGoal && ((stage === 'projection' && inProvider)
            || (stage === 'authority' && !inProvider))) process.exit(81);
        return result;
      };
    }
    goalLease.bindGoalLease(runDir, {
      runId: 'crash-' + stage,
      ownerRuntime: 'codex',
      objective: 'Recover the ' + stage + ' Goal transaction window',
      hostRef: 'thread:crash-' + stage,
      now: '2026-09-13T00:00:00.000Z',
    }, { controlRoot, providerRoot });
    process.stderr.write('requested Goal crash hook was not reached');
    process.exit(82);
  `;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TP_TEST_GOAL_MODULE: modulePath,
      TP_TEST_CRASH_STAGE: stage,
      TP_TEST_RUN_DIR: runDir,
      TP_TEST_CONTROL_ROOT: controlRoot,
      TP_TEST_PROVIDER_ROOT: providerRoot,
    },
  });
}

function runLockMoveIntentPath(lockDir) {
  return `${lockDir}.move-intent.json`;
}

function runLockGenerationMarkerFiles(lockDir) {
  const intentFile = runLockMoveIntentPath(lockDir);
  const intent = fs.existsSync(intentFile)
    ? JSON.parse(fs.readFileSync(intentFile, 'utf8'))
    : null;
  const directories = [lockDir, intent && intent.destination].filter(Boolean);
  return directories.flatMap((directory) => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((entry) => entry === '.stale-generation.json'
        || entry.startsWith('.stale-generation-'))
      .map((entry) => path.join(directory, entry));
  });
}

function runLockMoveAuditRecords(lockDir) {
  const auditDirectory = `${lockDir}.move-audit`;
  if (!fs.existsSync(auditDirectory)) return [];
  return fs.readdirSync(auditDirectory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(auditDirectory, entry), 'utf8')));
}

function crashRunLockMoveAt(operation, runDir, controlRoot, lockDir, crashPoint = 'after') {
  const modulePath = path.join(__dirname, 'agent-orchestrator', 'run-lock.js');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const runLock = require(process.env.TP_TEST_RUN_LOCK_MODULE);
    const operation = process.env.TP_TEST_MOVE_OPERATION;
    const crashPoint = process.env.TP_TEST_MOVE_CRASH_POINT;
    const lockDir = process.env.TP_TEST_LOCK_DIR;
    const originalRenameSync = fs.renameSync;
    let hookHit = false;
    fs.renameSync = (source, destination) => {
      const matchesMove = !hookHit
        && path.resolve(source).toLowerCase() === path.resolve(lockDir).toLowerCase()
        && String(destination).includes('.' + operation + '-');
      if (matchesMove && crashPoint === 'before') {
        hookHit = true;
        process.exit(81);
      }
      const result = originalRenameSync(source, destination);
      if (matchesMove) {
        hookHit = true;
        process.exit(81);
      }
      return result;
    };
    if (operation === 'release') {
      const lock = runLock.acquireRunLock(
        process.env.TP_TEST_RUN_DIR,
        'provider-dispatch',
        { command: 'crash-release', pid: process.pid },
        { controlRoot: process.env.TP_TEST_CONTROL_ROOT }
      );
      lock.release();
    } else {
      runLock.acquireRunLock(
        process.env.TP_TEST_RUN_DIR,
        'provider-dispatch',
        { command: 'crash-stale', pid: process.pid },
        {
          controlRoot: process.env.TP_TEST_CONTROL_ROOT,
          unknownOwnerStaleMs: 0,
          nowMs: Date.now() + 60_000,
          isProcessAlive: () => false,
        }
      );
    }
    process.stderr.write('requested run-lock move crash hook was not reached');
    process.exit(hookHit ? 81 : 82);
  `;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TP_TEST_RUN_LOCK_MODULE: modulePath,
      TP_TEST_MOVE_OPERATION: operation,
      TP_TEST_MOVE_CRASH_POINT: crashPoint,
      TP_TEST_RUN_DIR: runDir,
      TP_TEST_CONTROL_ROOT: controlRoot,
      TP_TEST_LOCK_DIR: lockDir,
    },
  });
}

function crashRunLockPublicationAt(kind, runDir, controlRoot, lockDir) {
  const modulePath = path.join(__dirname, 'agent-orchestrator', 'run-lock.js');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const runLock = require(process.env.TP_TEST_RUN_LOCK_MODULE);
    const kind = process.env.TP_TEST_PUBLICATION_KIND;
    const lockDir = process.env.TP_TEST_LOCK_DIR;
    const intentName = path.basename(lockDir) + '.move-intent.json';
    const markerName = '.stale-generation.json';
    const originalOpenSync = fs.openSync;
    let hookHit = false;
    fs.openSync = (file, flags, mode) => {
      const descriptor = originalOpenSync(file, flags, mode);
      const basename = path.basename(String(file));
      const matchesTarget = kind === 'intent'
        ? (basename === intentName || basename.startsWith(intentName + '.stage-'))
        : (basename === markerName
          || basename.startsWith(markerName + '.stage-')
          || basename.startsWith('.stale-generation-'));
      if (!hookHit
          && String(flags).includes('w')
          && matchesTarget) {
        hookHit = true;
        process.exit(83);
      }
      return descriptor;
    };
    runLock.acquireRunLock(
      process.env.TP_TEST_RUN_DIR,
      'provider-dispatch',
      { command: 'crash-' + kind + '-publication', pid: process.pid },
      {
        controlRoot: process.env.TP_TEST_CONTROL_ROOT,
        unknownOwnerStaleMs: 0,
        nowMs: Date.now() + 60_000,
        isProcessAlive: () => false,
      }
    );
    process.stderr.write('requested run-lock publication crash hook was not reached');
    process.exit(hookHit ? 83 : 82);
  `;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TP_TEST_RUN_LOCK_MODULE: modulePath,
      TP_TEST_PUBLICATION_KIND: kind,
      TP_TEST_RUN_DIR: runDir,
      TP_TEST_CONTROL_ROOT: controlRoot,
      TP_TEST_LOCK_DIR: lockDir,
    },
  });
}

test('the next Goal mutation reconciles every deterministic transaction crash window', () => {
  for (const stage of ['fence-staged', 'fence-only', 'projection', 'authority']) {
    const fixtureRoot = makeRunDir();
    const controlRoot = makeRunDir();
    const providerRoot = path.join(fixtureRoot, 'repo');
    const runDir = path.join(providerRoot, '.agent-runs', `crash-${stage}`);
    fs.mkdirSync(runDir, { recursive: true });
    try {
      const crashed = crashGoalLeaseAt(stage, runDir, controlRoot, providerRoot);
      assert.strictEqual(
        crashed.status,
        81,
        `${stage} child must terminate in the requested crash window: ${crashed.stderr}`
      );
      const fenceFiles = authorityArtifacts(
        controlRoot,
        goalLease.GOAL_LEASE_TRANSACTION_FILE
      );
      if (stage === 'fence-staged') {
        assert.strictEqual(fenceFiles.length, 0, 'pre-link crash must not publish canonical fence');
        const stagedFiles = fs.readdirSync(path.join(controlRoot, 'runs'), {
          withFileTypes: true,
        }).flatMap((entry) => {
          const directory = path.join(controlRoot, 'runs', entry.name);
          return entry.isDirectory()
            ? fs.readdirSync(directory)
              .filter((name) => name.startsWith(`${goalLease.GOAL_LEASE_TRANSACTION_FILE}.`)
                && name.endsWith('.tmp'))
              .map((name) => path.join(directory, name))
            : [];
        });
        assert.strictEqual(stagedFiles.length, 1, 'pre-link crash must retain one durable staging file');
      } else {
        assert.strictEqual(fenceFiles.length, 1, `${stage} must leave the recovery fence`);
      }

      assert.strictEqual(
        goalLease.readGoalLease(runDir, { controlRoot, providerRoot }),
        null,
        `${stage} must be reconciled by the public read used before dispatch`
      );

      const lease = goalLease.bindGoalLease(runDir, {
        runId: `crash-${stage}`,
        ownerRuntime: 'codex',
        objective: `Recover the ${stage} Goal transaction window`,
        hostRef: `thread:crash-${stage}`,
        now: '2026-09-13T00:00:00.000Z',
      }, { controlRoot, providerRoot });

      assert.strictEqual(lease.status, 'active');
      assert.deepStrictEqual(
        goalLease.readGoalLease(runDir, { controlRoot, providerRoot }),
        lease
      );
      assert.strictEqual(
        goalLease.withValidatedGoalLease(
          runDir,
          {
            runId: `crash-${stage}`,
            expectedRevision: lease.revision,
            dispatchContext: {
              runId: `crash-${stage}`,
              providerRuntime: 'claude',
              orchestrationOwner: 'codex-host',
              objective: `Recover the ${stage} Goal transaction window`,
            },
          },
          (current) => current.revision,
          { controlRoot, providerRoot }
        ),
        lease.revision,
        `${stage} recovery must permit the subsequent dispatch acceptance path`
      );
      assert.deepStrictEqual(
        authorityArtifacts(controlRoot, goalLease.GOAL_LEASE_TRANSACTION_FILE),
        [],
        `${stage} must resolve the canonical recovery fence`
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fs.rmSync(controlRoot, { recursive: true, force: true });
    }
  }
});

test('a valid-JSON staged Goal fence cannot redirect recovery to a foreign target', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const runDir = path.join(providerRoot, '.agent-runs', 'staged-binding-run');
  const foreignTarget = path.join(providerRoot, 'foreign-target');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(foreignTarget, { recursive: true });
  const foreignGoal = path.join(foreignTarget, goalLease.GOAL_LEASE_FILE);
  fs.writeFileSync(foreignGoal, 'foreign sentinel\n');
  try {
    const crashed = crashGoalLeaseAt('fence-staged', runDir, controlRoot, providerRoot);
    assert.strictEqual(crashed.status, 81);
    const stagedFiles = authorityArtifactsMatching(controlRoot, (name) => (
      name.startsWith(`${goalLease.GOAL_LEASE_TRANSACTION_FILE}.`)
      && name.endsWith('.tmp')
    ));
    assert.strictEqual(stagedFiles.length, 1);
    const transaction = JSON.parse(fs.readFileSync(stagedFiles[0], 'utf8'));
    const foreignStat = fs.lstatSync(fs.realpathSync.native(foreignTarget), { bigint: true });
    const foreignCanonical = controlStore.canonicalRunDir(foreignTarget);
    transaction.binding.canonicalRunDirAtCreation = foreignCanonical;
    transaction.projection.directory = fs.realpathSync.native(foreignTarget);
    transaction.projection.canonicalDirectory = controlStore.canonicalPotentialPath(foreignTarget);
    transaction.projection.canonicalRunDirAtCreation = foreignCanonical;
    transaction.projection.device = foreignStat.dev.toString();
    transaction.projection.inode = foreignStat.ino.toString();
    fs.writeFileSync(stagedFiles[0], `${JSON.stringify(transaction, null, 2)}\n`);

    assert.throws(
      () => goalLease.readGoalLease(runDir, { controlRoot, providerRoot }),
      /control binding differs|projection target differs|recovery required/
    );
    assert.strictEqual(
      authorityArtifacts(controlRoot, goalLease.GOAL_LEASE_TRANSACTION_FILE).length,
      0,
      'forged staging bytes must never be hardlinked into canonical authority'
    );
    assert.strictEqual(fs.readFileSync(foreignGoal, 'utf8'), 'foreign sentinel\n');
    assert.deepStrictEqual(fs.readdirSync(foreignTarget), [goalLease.GOAL_LEASE_FILE]);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('run-scoped dispatch lock rejects a live concurrent owner and releases after errors', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  try {
    const first = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'resume',
      pid: process.pid,
    }, { controlRoot });
    assert.strictEqual(
      path.relative(runDir, first.lockDir).startsWith(`..${path.sep}`),
      true,
      'authoritative dispatch lock must be outside the provider-visible runDir'
    );

    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(runDir, '.provider-dispatch.lock'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, '.provider-dispatch.lock', 'owner.json'),
      `${JSON.stringify({
        schemaVersion: 'run-lock-v1',
        name: 'provider-dispatch',
        token: 'forged-local-owner',
        pid: 2147483647,
      })}\n`
    );
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'resume',
        pid: process.pid,
      }, { controlRoot }),
      /provider-dispatch lock is active/
    );
    first.release();

    assert.throws(() => runLock.withRunLock(
      runDir,
      'provider-dispatch',
      { command: 'run', pid: process.pid },
      () => {
        throw new Error('provider exploded');
      },
      { controlRoot }
    ), /provider exploded/);

    const recovered = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'resume',
      pid: process.pid,
    }, { controlRoot });
    recovered.release();
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('replacing a logical run junction cannot derive a second dispatch lock identity', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const linksRoot = path.join(providerRoot, '.agent-runs');
  const targetA = path.join(providerRoot, 'target-a');
  const targetB = path.join(providerRoot, 'target-b');
  const runDir = path.join(linksRoot, 'logical-run');
  fs.mkdirSync(linksRoot, { recursive: true });
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.symlinkSync(targetA, runDir, 'junction');
  try {
    const stableKey = controlStore.controlRunKey(runDir);
    const first = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'resume',
      pid: process.pid,
    }, { controlRoot, providerRoot });

    fs.rmSync(runDir, { recursive: true, force: true });
    fs.symlinkSync(targetB, runDir, 'junction');
    assert.strictEqual(
      controlStore.controlRunKey(runDir),
      stableKey,
      'the control key must be independent of the junction target current realpath'
    );
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'resume',
        pid: process.pid,
      }, { controlRoot, providerRoot }),
      /run identity changed|run locator changed|provider-dispatch lock is active/
    );
    assert.strictEqual(
      fs.readdirSync(path.join(controlRoot, 'runs')).length,
      1,
      'junction replacement must not create a second authoritative control directory'
    );
    first.release();
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('two junction aliases for one canonical run share dispatch and Goal authority', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const linksRoot = path.join(providerRoot, '.agent-runs');
  const target = path.join(providerRoot, 'canonical-run');
  const aliasA = path.join(linksRoot, 'alias-a');
  const aliasB = path.join(linksRoot, 'alias-b');
  fs.mkdirSync(linksRoot, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, aliasA, 'junction');
  fs.symlinkSync(target, aliasB, 'junction');
  let first;
  let second;
  let goalUpdate;
  try {
    assert.notStrictEqual(
      controlStore.controlRunKey(aliasA),
      controlStore.controlRunKey(aliasB),
      'lexical locator keys remain distinct so each alias can detect retargeting'
    );
    assert.strictEqual(
      controlStore.canonicalRunDir(aliasA),
      controlStore.canonicalRunDir(aliasB)
    );
    first = runLock.acquireRunLock(aliasA, 'provider-dispatch', {
      command: 'resume',
      pid: process.pid,
    }, { controlRoot, providerRoot });
    const authorityDir = path.dirname(first.lockDir);
    assert.throws(
      () => runLock.acquireRunLock(aliasB, 'provider-dispatch', {
        command: 'resume',
        pid: process.pid,
      }, { controlRoot, providerRoot }),
      /provider-dispatch lock is active/
    );
    first.release();
    first = null;

    second = runLock.acquireRunLock(aliasB, 'provider-dispatch', {
      command: 'resume',
      pid: process.pid,
    }, { controlRoot, providerRoot });
    assert.strictEqual(path.dirname(second.lockDir), authorityDir);
    second.release();
    second = null;

    goalUpdate = runLock.acquireRunLock(aliasA, 'goal-lease-update', {
      command: 'goal-bind',
      pid: process.pid,
    }, { controlRoot, providerRoot });
    assert.throws(
      () => goalLease.bindGoalLease(aliasB, {
        runId: 'alias-run',
        ownerRuntime: 'codex',
        objective: 'Share one canonical Goal authority',
        hostRef: 'thread:alias',
      }, { controlRoot, providerRoot }),
      /goal-lease-update lock is active/
    );
    goalUpdate.release();
    goalUpdate = null;

    const lease = goalLease.bindGoalLease(aliasA, {
      runId: 'alias-run',
      ownerRuntime: 'codex',
      objective: 'Share one canonical Goal authority',
      hostRef: 'thread:alias',
    }, { controlRoot, providerRoot });
    assert.deepStrictEqual(
      goalLease.readGoalLease(aliasB, { controlRoot, providerRoot }),
      lease
    );
    assert.strictEqual(fs.readdirSync(path.join(controlRoot, 'runs')).length, 1);
    assert.strictEqual(fs.readdirSync(path.join(controlRoot, 'identities')).length, 1);
    assert.strictEqual(fs.readdirSync(path.join(controlRoot, 'locators')).length, 2);
  } finally {
    if (goalUpdate) goalUpdate.release();
    if (second) second.release();
    if (first) first.release();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('Goal authority is not committed when its junction is retargeted before commit', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const linksRoot = path.join(providerRoot, '.agent-runs');
  const targetA = path.join(providerRoot, 'target-a');
  const targetB = path.join(providerRoot, 'target-b');
  const runDir = path.join(linksRoot, 'logical-run');
  fs.mkdirSync(linksRoot, { recursive: true });
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.symlinkSync(targetA, runDir, 'junction');
  const originalOpenSync = fs.openSync;
  let authorityStaged = false;
  try {
    fs.openSync = (file, flags, mode) => {
      const result = originalOpenSync(file, flags, mode);
      const basename = path.basename(String(file));
      if (!authorityStaged
          && basename.startsWith(`${goalLease.GOAL_LEASE_FILE}.`)
          && basename.endsWith('.tmp')
          && !path.resolve(String(file)).startsWith(path.resolve(providerRoot))) {
        authorityStaged = true;
        replaceJunction(runDir, targetB);
      }
      return result;
    };
    assert.throws(
      () => goalLease.bindGoalLease(runDir, {
        runId: 'precommit-retarget',
        ownerRuntime: 'codex',
        objective: 'Reject a changed projection identity before authority commit',
        hostRef: 'thread:precommit-retarget',
      }, { controlRoot, providerRoot }),
      /projection target changed|canonical identity|run identity changed/
    );

    assert.strictEqual(authorityStaged, true, 'test hook must retarget before authority commit');
    const authorityLeaseFiles = fs.readdirSync(path.join(controlRoot, 'runs'), {
      withFileTypes: true,
    }).flatMap((entry) => {
      const file = path.join(controlRoot, 'runs', entry.name, goalLease.GOAL_LEASE_FILE);
      return entry.isDirectory() && fs.existsSync(file) ? [file] : [];
    });
    assert.deepStrictEqual(
      authorityLeaseFiles,
      [],
      'a pre-commit identity change must not leave an active authoritative lease'
    );
    assert.strictEqual(fs.existsSync(path.join(targetA, goalLease.GOAL_LEASE_FILE)), false);
    assert.strictEqual(fs.existsSync(path.join(targetB, goalLease.GOAL_LEASE_FILE)), false);
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('Goal bind compensates when its logical junction is retargeted inside authority rename', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const linksRoot = path.join(providerRoot, '.agent-runs');
  const targetA = path.join(providerRoot, 'target-a');
  const targetB = path.join(providerRoot, 'target-b');
  const runDir = path.join(linksRoot, 'logical-run');
  fs.mkdirSync(linksRoot, { recursive: true });
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.symlinkSync(targetA, runDir, 'junction');
  const originalRenameSync = fs.renameSync;
  let authorityCommitted = false;
  try {
    fs.renameSync = (source, destination) => {
      if (!authorityCommitted
          && path.basename(destination) === goalLease.GOAL_LEASE_FILE
          && !path.resolve(destination).startsWith(path.resolve(providerRoot))) {
        authorityCommitted = true;
        replaceJunction(runDir, targetB);
      }
      originalRenameSync(source, destination);
    };
    assert.throws(
      () => goalLease.bindGoalLease(runDir, {
        runId: 'retargeted-projection',
        ownerRuntime: 'codex',
        objective: 'Keep the projection on its authority-bound run identity',
        hostRef: 'thread:retargeted-projection',
      }, { controlRoot, providerRoot }),
      /projection target changed|transaction aborted/
    );

    assert.strictEqual(authorityCommitted, true, 'test hook must retarget after authority commit');
    assert.deepStrictEqual(
      authorityArtifacts(controlRoot, goalLease.GOAL_LEASE_FILE),
      [],
      'a failed initial bind must remove its newly committed authority'
    );
    assert.deepStrictEqual(
      authorityArtifacts(controlRoot, goalLease.GOAL_LEASE_TRANSACTION_FILE),
      [],
      'successful compensation must remove the recovery fence'
    );
    assert.deepStrictEqual(goalLeaseArtifacts(targetA), []);
    assert.deepStrictEqual(goalLeaseArtifacts(targetB), []);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('Goal bind compensates without touching a replacement of its canonical target', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const linksRoot = path.join(providerRoot, '.agent-runs');
  const targetA = path.join(providerRoot, 'target-a');
  const targetB = path.join(providerRoot, 'target-b');
  const runDir = path.join(linksRoot, 'logical-run');
  fs.mkdirSync(linksRoot, { recursive: true });
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.symlinkSync(targetA, runDir, 'junction');
  const originalRenameSync = fs.renameSync;
  let authorityCommitted = false;
  try {
    fs.renameSync = (source, destination) => {
      const result = originalRenameSync(source, destination);
      if (!authorityCommitted
          && path.basename(destination) === goalLease.GOAL_LEASE_FILE
          && !path.resolve(destination).startsWith(path.resolve(providerRoot))) {
        authorityCommitted = true;
        fs.rmSync(targetA, { recursive: true, force: true });
        fs.symlinkSync(targetB, targetA, 'junction');
      }
      return result;
    };
    assert.throws(
      () => goalLease.bindGoalLease(runDir, {
        runId: 'replaced-canonical-target',
        ownerRuntime: 'codex',
        objective: 'Never follow a replacement of the pinned canonical target',
        hostRef: 'thread:replaced-canonical-target',
      }, { controlRoot, providerRoot }),
      /projection target changed|transaction aborted/
    );

    assert.strictEqual(authorityCommitted, true);
    assert.deepStrictEqual(authorityArtifacts(controlRoot, goalLease.GOAL_LEASE_FILE), []);
    assert.strictEqual(
      authorityArtifacts(controlRoot, goalLease.GOAL_LEASE_TRANSACTION_FILE).length,
      1,
      'an unverifiable replacement target must retain the fail-closed recovery fence'
    );
    assert.deepStrictEqual(goalLeaseArtifacts(targetB), []);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('failed Goal update and release restore exact prior authority and projection bytes', () => {
  for (const operation of ['update', 'release']) {
    const fixtureRoot = makeRunDir();
    const controlRoot = makeRunDir();
    const providerRoot = path.join(fixtureRoot, 'repo');
    const linksRoot = path.join(providerRoot, '.agent-runs');
    const targetA = path.join(providerRoot, 'target-a');
    const targetB = path.join(providerRoot, 'target-b');
    const runDir = path.join(linksRoot, 'logical-run');
    fs.mkdirSync(linksRoot, { recursive: true });
    fs.mkdirSync(targetA, { recursive: true });
    fs.mkdirSync(targetB, { recursive: true });
    fs.symlinkSync(targetA, runDir, 'junction');
    const lease = goalLease.bindGoalLease(runDir, {
      runId: `${operation}-compensation`,
      ownerRuntime: 'codex',
      objective: 'Restore exact prior Goal bytes after a failed mutation',
      hostRef: `thread:${operation}-compensation`,
      now: '2026-09-13T00:00:00.000Z',
    }, { controlRoot, providerRoot });
    const authorityPath = goalLease.goalLeasePath(runDir, { controlRoot, providerRoot });
    const transactionPath = path.join(
      path.dirname(authorityPath),
      goalLease.GOAL_LEASE_TRANSACTION_FILE
    );
    const priorAuthority = fs.readFileSync(authorityPath);
    const priorProjection = fs.readFileSync(path.join(targetA, goalLease.GOAL_LEASE_FILE));
    const originalRenameSync = fs.renameSync;
    let authorityCommitted = false;
    try {
      fs.renameSync = (source, destination) => {
        if (!authorityCommitted && path.resolve(destination) === path.resolve(authorityPath)) {
          authorityCommitted = true;
          replaceJunction(runDir, targetB);
        }
        return originalRenameSync(source, destination);
      };
      const mutate = operation === 'update'
        ? () => goalLease.bindGoalLease(runDir, {
          runId: `${operation}-compensation`,
          ownerRuntime: 'codex',
          objective: 'Restore exact prior Goal bytes after a failed mutation',
          hostRef: `thread:${operation}-compensation`,
          now: '2026-09-13T00:01:00.000Z',
        }, { controlRoot, providerRoot, expectedRevision: lease.revision })
        : () => goalLease.releaseStoredGoalLease(runDir, {
          controlRoot,
          providerRoot,
          expectedRevision: lease.revision,
          reason: 'test rollback',
          now: '2026-09-13T00:01:00.000Z',
        });
      assert.throws(mutate, /projection target changed|transaction aborted/);
    } finally {
      fs.renameSync = originalRenameSync;
    }
    try {
      replaceJunction(runDir, targetA);
      assert.strictEqual(authorityCommitted, true, `${operation} must reach authority commit`);
      assert.deepStrictEqual(fs.readFileSync(authorityPath), priorAuthority);
      assert.deepStrictEqual(
        fs.readFileSync(path.join(targetA, goalLease.GOAL_LEASE_FILE)),
        priorProjection
      );
      assert.strictEqual(fs.existsSync(transactionPath), false);
      assert.strictEqual(
        goalLease.readGoalLease(runDir, { controlRoot, providerRoot }).revision,
        lease.revision
      );
      assert.deepStrictEqual(goalLeaseArtifacts(targetB), []);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fs.rmSync(controlRoot, { recursive: true, force: true });
    }
  }
});

test('failed authority rollback retains its fence until the next locked recovery', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const linksRoot = path.join(providerRoot, '.agent-runs');
  const targetA = path.join(providerRoot, 'target-a');
  const targetB = path.join(providerRoot, 'target-b');
  const runDir = path.join(linksRoot, 'logical-run');
  fs.mkdirSync(linksRoot, { recursive: true });
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.symlinkSync(targetA, runDir, 'junction');
  const lease = goalLease.bindGoalLease(runDir, {
    runId: 'rollback-fence',
    ownerRuntime: 'codex',
    objective: 'Retain recovery evidence when authority rollback fails',
    hostRef: 'thread:rollback-fence',
    now: '2026-09-13T00:00:00.000Z',
  }, { controlRoot, providerRoot });
  const authorityPath = goalLease.goalLeasePath(runDir, { controlRoot, providerRoot });
  const transactionPath = path.join(
    path.dirname(authorityPath),
    goalLease.GOAL_LEASE_TRANSACTION_FILE
  );
  const originalRenameSync = fs.renameSync;
  let authorityCommitted = false;
  let rollbackClaimAttempted = false;
  try {
    fs.renameSync = (source, destination) => {
      if (!authorityCommitted && path.resolve(destination) === path.resolve(authorityPath)) {
        authorityCommitted = true;
        replaceJunction(runDir, targetB);
      }
      if (path.resolve(source) === path.resolve(authorityPath)
          && String(destination).includes('.rollback-authority-')) {
        rollbackClaimAttempted = true;
        throw new Error('injected authority rollback claim failure');
      }
      return originalRenameSync(source, destination);
    };
    assert.throws(
      () => goalLease.releaseStoredGoalLease(runDir, {
        controlRoot,
        providerRoot,
        expectedRevision: lease.revision,
        reason: 'force rollback',
      }),
      /recovery required|rollback failure/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    replaceJunction(runDir, targetA);
    assert.strictEqual(authorityCommitted, true);
    assert.strictEqual(rollbackClaimAttempted, true);
    assert.strictEqual(fs.existsSync(transactionPath), true);
    assert.deepStrictEqual(
      goalLease.readGoalLease(runDir, { controlRoot, providerRoot }),
      lease,
      'the public read must acquire the Goal lock and finish the safe rollback'
    );
    assert.strictEqual(fs.existsSync(transactionPath), false);
    let acceptanceRan = false;
    assert.strictEqual(
      goalLease.withValidatedGoalLease(
        runDir,
        { runId: 'rollback-fence', expectedRevision: lease.revision },
        () => {
          acceptanceRan = true;
          return lease.revision;
        },
        { controlRoot, providerRoot }
      ),
      lease.revision
    );
    assert.strictEqual(acceptanceRan, true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('Goal rollback claim rejects an ABA replacement and preserves all evidence', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const targetA = path.join(providerRoot, 'target-a');
  const targetB = path.join(providerRoot, 'target-b');
  const runDir = path.join(providerRoot, '.agent-runs', 'logical-run');
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.symlinkSync(targetA, runDir, 'junction');
  const lease = goalLease.bindGoalLease(runDir, {
    runId: 'authority-rollback-aba',
    ownerRuntime: 'codex',
    objective: 'Preserve foreign authority bytes during rollback ABA',
    hostRef: 'thread:authority-rollback-aba',
  }, { controlRoot, providerRoot });
  const authorityPath = goalLease.goalLeasePath(runDir, { controlRoot, providerRoot });
  const fencePath = path.join(path.dirname(authorityPath), goalLease.GOAL_LEASE_TRANSACTION_FILE);
  const parked = `${authorityPath}.expected-after-parked`;
  const originalRenameSync = fs.renameSync;
  let rollbackClaim = null;
  try {
    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === path.resolve(authorityPath)) {
        const result = originalRenameSync(source, destination);
        replaceJunction(runDir, targetB);
        return result;
      }
      if (!rollbackClaim
          && path.resolve(source) === path.resolve(authorityPath)
          && String(destination).includes('.rollback-authority-')) {
        rollbackClaim = destination;
        const foreignRaw = fs.readFileSync(source);
        originalRenameSync(source, parked);
        fs.writeFileSync(source, foreignRaw);
      }
      return originalRenameSync(source, destination);
    };
    assert.throws(
      () => goalLease.releaseStoredGoalLease(runDir, {
        expectedRevision: lease.revision,
        reason: 'exercise authority ABA rollback',
        controlRoot,
        providerRoot,
      }),
      /foreign object|recovery required/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    replaceJunction(runDir, targetA);
    assert.strictEqual(fs.existsSync(fencePath), true);
    assert.strictEqual(fs.existsSync(parked), true);
    assert.strictEqual(Boolean(rollbackClaim && fs.existsSync(rollbackClaim)), true);
    assert.deepStrictEqual(fs.readFileSync(rollbackClaim), fs.readFileSync(parked));
    assert.throws(
      () => goalLease.readGoalLease(runDir, { controlRoot, providerRoot }),
      /unknown identity|recovery required/
    );
    assert.strictEqual(fs.existsSync(rollbackClaim), true, 'foreign claim must not be deleted');
    assert.strictEqual(fs.existsSync(fencePath), true, 'fence must remain fail-closed');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('Goal fence claim rejects an ABA replacement and restores fail-closed fencing', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const authorityPath = goalLease.goalLeasePath(runDir, { controlRoot });
  const fencePath = path.join(path.dirname(authorityPath), goalLease.GOAL_LEASE_TRANSACTION_FILE);
  const parked = `${fencePath}.authentic-parked`;
  const originalRenameSync = fs.renameSync;
  let foreignResolved = null;
  try {
    fs.renameSync = (source, destination) => {
      if (!foreignResolved
          && path.resolve(source) === path.resolve(fencePath)
          && String(destination).includes('.resolved-')) {
        foreignResolved = destination;
        const foreignRaw = fs.readFileSync(source);
        originalRenameSync(source, parked);
        fs.writeFileSync(source, foreignRaw);
      }
      return originalRenameSync(source, destination);
    };
    assert.throws(
      () => goalLease.bindGoalLease(runDir, {
        runId: 'fence-resolution-aba',
        ownerRuntime: 'codex',
        objective: 'Never remove a foreign fence object through ABA',
        hostRef: 'thread:fence-resolution-aba',
      }, { controlRoot }),
      /foreign fence|recovery required/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    assert.strictEqual(fs.existsSync(fencePath), true, 'canonical fencing must be restored');
    assert.strictEqual(fs.existsSync(parked), true, 'authentic bytes must remain recoverable');
    assert.strictEqual(Boolean(foreignResolved && fs.existsSync(foreignResolved)), true);
    assert.deepStrictEqual(fs.readFileSync(foreignResolved), fs.readFileSync(parked));
    assert.throws(
      () => goalLease.readGoalLease(runDir, { controlRoot }),
      /recovery required|foreign identity/
    );
    assert.strictEqual(fs.existsSync(foreignResolved), true, 'foreign fence must be preserved');
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('run lock release uses its pinned external identity after the logical alias changes', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const targetA = path.join(providerRoot, 'target-a');
  const runDir = path.join(providerRoot, '.agent-runs', 'logical-run');
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  fs.mkdirSync(targetA, { recursive: true });
  fs.symlinkSync(targetA, runDir, 'junction');
  let lock;
  try {
    lock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'run',
      pid: process.pid,
    }, { controlRoot, providerRoot });
    replaceJunction(runDir, path.dirname(controlRoot));
    assert.doesNotThrow(() => lock.release());
    lock = null;
  } finally {
    if (lock) {
      replaceJunction(runDir, targetA);
      lock.release();
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('run lock release rejects a same-token replacement lock directory', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'run',
    pid: process.pid,
  }, { controlRoot });
  const parked = `${lock.lockDir}.parked`;
  try {
    fs.renameSync(lock.lockDir, parked);
    fs.mkdirSync(lock.lockDir);
    fs.writeFileSync(
      path.join(lock.lockDir, 'owner.json'),
      `${JSON.stringify(lock.owner, null, 2)}\n`
    );
    assert.throws(() => lock.release(), /lock directory identity changed/);
    assert.strictEqual(fs.existsSync(parked), true);
    assert.strictEqual(fs.existsSync(lock.lockDir), true);

    fs.rmSync(lock.lockDir, { recursive: true, force: true });
    fs.renameSync(parked, lock.lockDir);
    assert.strictEqual(lock.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('run lock release rejects replacement of its pinned control directory', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'run',
    pid: process.pid,
  }, { controlRoot });
  const controlDir = path.dirname(lock.lockDir);
  const parked = `${controlDir}.parked`;
  try {
    fs.renameSync(controlDir, parked);
    fs.mkdirSync(lock.lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lock.lockDir, 'owner.json'),
      `${JSON.stringify(lock.owner, null, 2)}\n`
    );
    assert.throws(() => lock.release(), /control directory identity changed/);
    assert.strictEqual(fs.existsSync(parked), true);
    assert.strictEqual(fs.existsSync(controlDir), true);

    fs.rmSync(controlDir, { recursive: true, force: true });
    fs.renameSync(parked, controlDir);
    assert.strictEqual(lock.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('run lock release preserves a foreign directory swapped inside its tombstone rename', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'run',
    pid: process.pid,
  }, { controlRoot });
  const parked = `${lock.lockDir}.parked`;
  const originalRenameSync = fs.renameSync;
  let tombstone = null;
  try {
    fs.renameSync = (source, destination) => {
      if (!tombstone && path.resolve(source) === path.resolve(lock.lockDir)) {
        tombstone = destination;
        originalRenameSync(source, parked);
        fs.mkdirSync(source);
        fs.writeFileSync(
          path.join(source, 'owner.json'),
          `${JSON.stringify(lock.owner, null, 2)}\n`
        );
      }
      return originalRenameSync(source, destination);
    };
    assert.throws(() => lock.release(), /lock tombstone identity changed|recovery required/);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    assert.strictEqual(fs.existsSync(parked), true);
    assert.strictEqual(Boolean(tombstone && fs.existsSync(tombstone)), true);
    assert.strictEqual(
      fs.existsSync(`${lock.lockDir}.recovery-required`),
      true,
      'an ambiguous release claim must leave a durable recovery fence'
    );
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'must-not-bypass-release-aba',
        pid: process.pid,
      }, { controlRoot }),
      /recovery required/,
      'a later acquire must not bypass the displaced foreign owner'
    );
    fs.rmSync(tombstone, { recursive: true, force: true });
    fs.renameSync(parked, lock.lockDir);
    assert.strictEqual(lock.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('run lock release compares unsafe-size inode values as BigInt', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const originalLstatSync = fs.lstatSync;
  let releasePhase = false;
  fs.lstatSync = (file, options) => {
    const stat = originalLstatSync(file, options);
    if (String(file).includes('.provider-dispatch.lock') && options?.bigint === true) {
      return new Proxy(stat, {
        get(target, property) {
          if (property === 'ino') {
            return releasePhase ? 9007199254740993n : 9007199254740992n;
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    return stat;
  };
  let lock;
  try {
    lock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'run',
      pid: process.pid,
    }, { controlRoot });
    releasePhase = true;
    assert.throws(() => lock.release(), /lock directory identity changed/);
    releasePhase = false;
    assert.strictEqual(lock.release(), true);
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  try {
    assert.strictEqual(lock.release(), false);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('run lock release rejects a changed token and is idempotent only after success', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'run',
    pid: process.pid,
  }, { controlRoot });
  const ownerFile = path.join(lock.lockDir, 'owner.json');
  try {
    fs.writeFileSync(ownerFile, `${JSON.stringify({
      ...lock.owner,
      token: 'foreign-token',
    }, null, 2)}\n`);
    assert.throws(() => lock.release(), /lock ownership changed before release/);
    assert.strictEqual(fs.existsSync(lock.lockDir), true);
    fs.writeFileSync(ownerFile, `${JSON.stringify(lock.owner, null, 2)}\n`);
    assert.strictEqual(lock.release(), true);
    assert.strictEqual(lock.release(), false);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('run lock release resumes after rename committed but surfaced EIO', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'run',
    pid: process.pid,
  }, { controlRoot });
  const originalRenameSync = fs.renameSync;
  let tombstone = null;
  let injected = false;
  try {
    fs.renameSync = (source, destination) => {
      if (!injected
          && path.resolve(source) === path.resolve(lock.lockDir)
          && String(destination).includes('.release-')) {
        injected = true;
        tombstone = destination;
        originalRenameSync(source, destination);
        const error = new Error('injected post-rename EIO');
        error.code = 'EIO';
        throw error;
      }
      return originalRenameSync(source, destination);
    };
    assert.strictEqual(
      lock.release(),
      true,
      'a committed release must validate and complete in the same call'
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    assert.strictEqual(injected, true, 'the post-rename failure hook must run');
    assert.strictEqual(fs.existsSync(lock.lockDir), false);
    assert.strictEqual(Boolean(tombstone && fs.existsSync(tombstone)), true);
    assert.strictEqual(lock.release(), false, 'the reconciled release must already be terminal');
    assert.strictEqual(fs.existsSync(tombstone), true, 'verified tombstones are retained');
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('run lock release fences a foreign tombstone after committed rename surfaced EIO', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'release-eio-foreign',
    pid: process.pid,
  }, { controlRoot });
  const originalRenameSync = fs.renameSync;
  let tombstone = null;
  let parked = null;
  let hookHit = false;
  try {
    fs.renameSync = (source, destination) => {
      if (!hookHit
          && path.resolve(source) === path.resolve(lock.lockDir)
          && String(destination).includes('.release-')) {
        hookHit = true;
        tombstone = destination;
        parked = `${destination}.authentic-parked`;
        originalRenameSync(source, destination);
        originalRenameSync(destination, parked);
        fs.mkdirSync(destination);
        fs.writeFileSync(
          path.join(destination, 'owner.json'),
          `${JSON.stringify(lock.owner, null, 2)}\n`
        );
        const error = new Error('injected foreign tombstone after committed EIO');
        error.code = 'EIO';
        throw error;
      }
      return originalRenameSync(source, destination);
    };
    assert.throws(() => lock.release(), /recovery required/);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    assert.strictEqual(hookHit, true, 'the committed-EIO replacement hook must run');
    assert.strictEqual(Boolean(parked && fs.existsSync(parked)), true);
    assert.strictEqual(Boolean(tombstone && fs.existsSync(tombstone)), true);
    assert.strictEqual(fs.existsSync(`${lock.lockDir}.recovery-required`), true);
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'must-not-bypass-committed-eio-ambiguity',
        pid: process.pid,
      }, { controlRoot }),
      /recovery required/
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('two concurrent acquirers cannot both win the fresh lock mkdir', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const seed = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'seed-mkdir-race',
    pid: process.pid,
  }, { controlRoot });
  assert.strictEqual(seed.release(), true);
  const originalMkdirSync = fs.mkdirSync;
  let winner = null;
  let hookHit = false;
  try {
    fs.mkdirSync = (directory, options) => {
      if (!hookHit
          && path.resolve(directory) === path.resolve(seed.lockDir)) {
        hookHit = true;
        winner = runLock.acquireRunLock(runDir, 'provider-dispatch', {
          command: 'mkdir-race-winner',
          pid: process.pid,
        }, { controlRoot });
      }
      return originalMkdirSync(directory, options);
    };
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'mkdir-race-loser',
        pid: process.pid,
      }, { controlRoot }),
      /lock is active/
    );
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
  try {
    assert.strictEqual(hookHit, true, 'the competing mkdir hook must run');
    assert.ok(winner, 'one competing acquirer must own the fresh lock');
    assert.strictEqual(runLock.readOwner(seed.lockDir).token, winner.owner.token);
    assert.strictEqual(winner.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('release tombstones are never recycled into an active lock directory', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const seed = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'seed-no-recycle',
    pid: process.pid,
  }, { controlRoot });
  assert.strictEqual(seed.release(), true);
  const originalRenameSync = fs.renameSync;
  let recycleAttempted = false;
  try {
    fs.renameSync = (source, destination) => {
      if (String(source).includes('.provider-dispatch.lock.release-')
          && path.resolve(destination) === path.resolve(seed.lockDir)) {
        recycleAttempted = true;
      }
      return originalRenameSync(source, destination);
    };
    const next = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'fresh-after-release',
      pid: process.pid,
    }, { controlRoot });
    assert.strictEqual(runLock.readOwner(next.lockDir).token, next.owner.token);
    assert.strictEqual(next.release(), true);
    assert.strictEqual(
      recycleAttempted,
      false,
      'no platform may rename a release tombstone back onto the active path'
    );
    const releaseTombstones = fs.readdirSync(path.dirname(seed.lockDir)).filter((entry) => (
      entry.startsWith(`${path.basename(seed.lockDir)}.release-`)
    ));
    assert.strictEqual(releaseTombstones.length, 2);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('stable Goal reads do not acquire or release an update lock', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lease = goalLease.bindGoalLease(runDir, {
    runId: 'stable-read-fast-path',
    ownerRuntime: 'codex',
    objective: 'Read a stable Goal without producing lock tombstones',
    hostRef: 'thread:stable-read-fast-path',
  }, { controlRoot });
  const originalWithRunLock = runLock.withRunLock;
  let goalReadLocks = 0;
  try {
    runLock.withRunLock = (...args) => {
      if (args[1] === 'goal-lease-update' && args[2]?.command === 'goal-read') {
        goalReadLocks += 1;
      }
      return originalWithRunLock(...args);
    };
    for (let index = 0; index < 40; index += 1) {
      assert.deepStrictEqual(goalLease.readGoalLease(runDir, { controlRoot }), lease);
    }
    assert.strictEqual(goalReadLocks, 0, 'clean stable reads must use the lock-free double read');
  } finally {
    runLock.withRunLock = originalWithRunLock;
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('stable Goal read rejects a run junction retargeted after both authority snapshots', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const targetA = path.join(providerRoot, 'target-a');
  const targetB = path.join(providerRoot, 'target-b');
  const runDir = path.join(providerRoot, '.agent-runs', 'read-binding-fast');
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.symlinkSync(targetA, runDir, 'junction');
  goalLease.bindGoalLease(runDir, {
    runId: 'read-binding-fast',
    ownerRuntime: 'codex',
    objective: 'Reject a retargeted stable Goal read',
    hostRef: 'thread:read-binding-fast',
  }, { controlRoot, providerRoot });
  const authority = goalLease.goalLeasePath(runDir, { controlRoot, providerRoot });
  const originalReadFileSync = fs.readFileSync;
  let authorityReads = 0;
  try {
    fs.readFileSync = (file, ...args) => {
      const result = originalReadFileSync(file, ...args);
      if (path.resolve(String(file)).toLowerCase() === path.resolve(authority).toLowerCase()) {
        authorityReads += 1;
        if (authorityReads === 2) replaceJunction(runDir, targetB);
      }
      return result;
    };
    assert.throws(
      () => goalLease.readGoalLease(runDir, { controlRoot, providerRoot }),
      /binding|canonical|identity|changed/
    );
    assert.strictEqual(authorityReads, 2, 'the retarget hook must run after both snapshots');
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('locked Goal read rejects a run junction retargeted after its authority snapshot', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const targetA = path.join(providerRoot, 'target-a');
  const targetB = path.join(providerRoot, 'target-b');
  const runDir = path.join(providerRoot, '.agent-runs', 'read-binding-locked');
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.symlinkSync(targetA, runDir, 'junction');
  const lease = goalLease.bindGoalLease(runDir, {
    runId: 'read-binding-locked',
    ownerRuntime: 'codex',
    objective: 'Reject a retargeted locked Goal read',
    hostRef: 'thread:read-binding-locked',
  }, { controlRoot, providerRoot });
  const authority = goalLease.goalLeasePath(runDir, { controlRoot, providerRoot });
  const originalReadFileSync = fs.readFileSync;
  let authorityReads = 0;
  let callbackRan = false;
  try {
    fs.readFileSync = (file, ...args) => {
      const result = originalReadFileSync(file, ...args);
      if (path.resolve(String(file)).toLowerCase() === path.resolve(authority).toLowerCase()) {
        authorityReads += 1;
        if (authorityReads === 1) replaceJunction(runDir, targetB);
      }
      return result;
    };
    assert.throws(
      () => goalLease.withValidatedGoalLease(
        runDir,
        { runId: lease.runId, expectedRevision: lease.revision },
        () => {
          callbackRan = true;
        },
        { controlRoot, providerRoot }
      ),
      /binding|canonical|identity|changed/
    );
    assert.strictEqual(authorityReads, 1, 'the locked retarget hook must run');
    assert.strictEqual(callbackRan, false, 'a retargeted read must not reach its callback');
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('binding a Goal lease precreates a missing run directory before authority commit', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const runDir = path.join(providerRoot, '.agent-runs', 'missing-run');
  try {
    const lease = goalLease.bindGoalLease(runDir, {
      runId: 'missing-run',
      ownerRuntime: 'codex',
      objective: 'Create the provider-visible projection target before authority commit',
      hostRef: 'thread:missing-run',
    }, { controlRoot, providerRoot });

    assert.strictEqual(lease.status, 'active');
    assert.strictEqual(fs.statSync(runDir).isDirectory(), true);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(runDir, goalLease.GOAL_LEASE_FILE), 'utf8')),
      goalLease.goalLeaseProjection(lease)
    );
    assert.deepStrictEqual(
      goalLease.readGoalLease(runDir, { controlRoot, providerRoot }),
      lease
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('Goal bind precreate failure leaves no authority, transaction, or projection', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo-file');
  const runDir = path.join(providerRoot, '.agent-runs', 'cannot-exist');
  fs.writeFileSync(providerRoot, 'not a directory\n');
  try {
    assert.throws(
      () => goalLease.bindGoalLease(runDir, {
        runId: 'precreate-failure',
        ownerRuntime: 'codex',
        objective: 'Do not partially commit when run directory creation fails',
        hostRef: 'thread:precreate-failure',
      }, { controlRoot, providerRoot }),
      /ENOTDIR|EEXIST/
    );
    assert.deepStrictEqual(authorityArtifacts(controlRoot, goalLease.GOAL_LEASE_FILE), []);
    assert.deepStrictEqual(
      authorityArtifacts(controlRoot, goalLease.GOAL_LEASE_TRANSACTION_FILE),
      []
    );
    assert.strictEqual(fs.existsSync(runDir), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('dead-owner dispatch locks are recovered atomically', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  try {
    const lockDir = runLock.lockPath(runDir, 'provider-dispatch', { controlRoot });
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify({
      schemaVersion: 'run-lock-v1',
      name: 'provider-dispatch',
      token: 'stale-token',
      pid: 2147483647,
      acquiredAt: '2020-01-01T00:00:00.000Z',
    })}\n`);

    const recovered = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'resume',
      pid: process.pid,
    }, { controlRoot });
    assert.strictEqual(recovered.recovered, true);
    recovered.release();
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('a durable stale intent prevents two recoverers from moving a fresh generation', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lockDir = runLock.lockPath(runDir, 'provider-dispatch', { controlRoot });
  fs.mkdirSync(lockDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockDir, old, old);
  const originalRenameSync = fs.renameSync;
  let hookHit = false;
  let competing = null;
  let competingError = null;
  let recovered = null;
  try {
    fs.renameSync = (source, destination) => {
      if (!hookHit
          && path.resolve(source).toLowerCase() === path.resolve(lockDir).toLowerCase()
          && String(destination).includes('.stale-')) {
        hookHit = true;
        try {
          competing = runLock.acquireRunLock(runDir, 'provider-dispatch', {
            command: 'competing-stale-recoverer',
            pid: process.pid,
          }, {
            controlRoot,
            unknownOwnerStaleMs: 0,
            nowMs: Date.now() + 60_000,
          });
        } catch (error) {
          competingError = error;
        }
      }
      return originalRenameSync(source, destination);
    };
    assert.doesNotThrow(() => {
      recovered = runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'primary-stale-recoverer',
        pid: process.pid,
      }, {
        controlRoot,
        unknownOwnerStaleMs: 0,
        nowMs: Date.now() + 60_000,
      });
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    assert.strictEqual(hookHit, true, 'the second recoverer must run before stale rename');
    assert.strictEqual(competing, null, 'the competing recoverer must not create a new generation');
    assert.match(String(competingError && competingError.message), /operation in progress|intent|recovery/);
    assert.ok(recovered, 'the intent owner must complete stale recovery');
    assert.strictEqual(runLock.readOwner(lockDir).token, recovered.owner.token);
    assert.strictEqual(recovered.release(), true);
  } finally {
    if (competing) competing.release();
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('a late dead-owner recoverer cannot rename the fresh generation acquired by its peer', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lockDir = runLock.lockPath(runDir, 'provider-dispatch', { controlRoot });
  fs.mkdirSync(lockDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockDir, old, old);
  const crashed = crashRunLockMoveAt('stale', runDir, controlRoot, lockDir, 'before');
  assert.strictEqual(
    crashed.status,
    81,
    `stale creator must crash after intent publication but before rename: ${crashed.stderr}`
  );
  assert.strictEqual(fs.existsSync(runLockMoveIntentPath(lockDir)), true);

  const originalRenameSync = fs.renameSync;
  let lateHookHit = false;
  let first = null;
  let lateError = null;
  try {
    fs.renameSync = (source, destination) => {
      if (!lateHookHit
          && path.resolve(source).toLowerCase() === path.resolve(lockDir).toLowerCase()
          && String(destination).includes('.stale-')) {
        lateHookHit = true;
        first = runLock.acquireRunLock(runDir, 'provider-dispatch', {
          command: 'first-dead-owner-recoverer',
          pid: process.pid,
        }, {
          controlRoot,
          unknownOwnerStaleMs: 0,
          isProcessAlive: (pid) => pid === process.pid,
        });

        // Windows refuses replacing a directory, while POSIX permits replacing
        // an empty one. Emulate only that POSIX case so this regression remains
        // deterministic on both platforms.
        if (fs.readdirSync(destination).length === 0) {
          originalRenameSync(destination, `${destination}.posix-replaced`);
        }
      }
      return originalRenameSync(source, destination);
    };
    try {
      runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'late-dead-owner-recoverer',
        pid: process.pid,
      }, {
        controlRoot,
        unknownOwnerStaleMs: 0,
        isProcessAlive: (pid) => pid === process.pid,
      });
    } catch (error) {
      lateError = error;
    }
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    assert.strictEqual(lateHookHit, true, 'the first recoverer must win at the late rename boundary');
    assert.ok(first, 'the winning recoverer must acquire a fresh generation');
    assert.ok(lateError, 'the late recoverer must not acquire the same lock');
    assert.strictEqual(fs.existsSync(lockDir), true, 'the fresh generation must remain at the live path');
    assert.strictEqual(runLock.readOwner(lockDir).token, first.owner.token);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('a stale rename crash is reconciled from its durable intent before reacquire', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lockDir = runLock.lockPath(runDir, 'provider-dispatch', { controlRoot });
  fs.mkdirSync(lockDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockDir, old, old);
  try {
    const crashed = crashRunLockMoveAt('stale', runDir, controlRoot, lockDir);
    assert.strictEqual(
      crashed.status,
      81,
      `stale child must crash immediately after rename: ${crashed.stderr}`
    );
    assert.strictEqual(
      fs.existsSync(runLockMoveIntentPath(lockDir)),
      true,
      'stale rename must have a durable intent before it can move the lock'
    );
    const next = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'after-stale-crash',
      pid: process.pid,
    }, { controlRoot, unknownOwnerStaleMs: 0 });
    assert.strictEqual(next.recovered, true);
    assert.strictEqual(fs.existsSync(runLockMoveIntentPath(lockDir)), false);
    assert.strictEqual(
      runLockMoveAuditRecords(lockDir).some((record) => record.operation === 'stale'),
      true,
      'reconciled stale intent must become immutable audit evidence'
    );
    assert.strictEqual(next.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('an intent open-write crash never exposes a partial canonical move intent', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lockDir = runLock.lockPath(runDir, 'provider-dispatch', { controlRoot });
  fs.mkdirSync(lockDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockDir, old, old);
  try {
    const crashed = crashRunLockPublicationAt('intent', runDir, controlRoot, lockDir);
    assert.strictEqual(
      crashed.status,
      83,
      `intent child must crash after private open but before write: ${crashed.stderr}`
    );
    assert.strictEqual(
      fs.existsSync(runLockMoveIntentPath(lockDir)),
      false,
      'an incomplete intent must never become the canonical recovery record'
    );
    const next = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'after-intent-publication-crash',
      pid: process.pid,
    }, {
      controlRoot,
      unknownOwnerStaleMs: 0,
      isProcessAlive: () => false,
    });
    assert.strictEqual(next.recovered, true);
    assert.strictEqual(next.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('a marker open-write crash never exposes a partial canonical generation marker', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lockDir = runLock.lockPath(runDir, 'provider-dispatch', { controlRoot });
  fs.mkdirSync(lockDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockDir, old, old);
  try {
    const crashed = crashRunLockPublicationAt('marker', runDir, controlRoot, lockDir);
    assert.strictEqual(
      crashed.status,
      83,
      `marker child must crash after private open but before write: ${crashed.stderr}`
    );
    assert.strictEqual(
      runLockGenerationMarkerFiles(lockDir).length,
      0,
      'an incomplete marker must never become the canonical generation proof'
    );
    const next = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'after-marker-publication-crash',
      pid: process.pid,
    }, {
      controlRoot,
      unknownOwnerStaleMs: 0,
      isProcessAlive: () => false,
    });
    assert.strictEqual(next.recovered, true);
    assert.strictEqual(next.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('a delayed stale marker publisher never writes into a replacement fresh generation', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lockDir = runLock.lockPath(runDir, 'provider-dispatch', { controlRoot });
  fs.mkdirSync(lockDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockDir, old, old);
  const crashed = crashRunLockPublicationAt('marker', runDir, controlRoot, lockDir);
  assert.strictEqual(
    crashed.status,
    83,
    `marker creator must leave a durable intent without canonical marker: ${crashed.stderr}`
  );

  const originalLinkSync = fs.linkSync;
  let hookHit = false;
  let first = null;
  let lateError = null;
  try {
    fs.linkSync = (source, destination) => {
      const basename = path.basename(String(destination));
      if (!hookHit
          && (basename === '.stale-generation.json'
            || basename.startsWith('.stale-generation-'))) {
        hookHit = true;
        first = runLock.acquireRunLock(runDir, 'provider-dispatch', {
          command: 'first-marker-publisher',
          pid: process.pid,
        }, {
          controlRoot,
          unknownOwnerStaleMs: 0,
          isProcessAlive: (pid) => pid === process.pid,
        });
      }
      return originalLinkSync(source, destination);
    };
    try {
      runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'delayed-marker-publisher',
        pid: process.pid,
      }, {
        controlRoot,
        unknownOwnerStaleMs: 0,
        isProcessAlive: (pid) => pid === process.pid,
      });
    } catch (error) {
      lateError = error;
    }
  } finally {
    fs.linkSync = originalLinkSync;
  }
  try {
    assert.strictEqual(hookHit, true, 'peer must acquire while the delayed marker link is paused');
    assert.ok(first, 'the winning marker publisher must acquire a fresh generation');
    assert.ok(lateError, 'the delayed publisher must not acquire the same fresh lock');
    assert.strictEqual(runLock.readOwner(lockDir).token, first.owner.token);
    assert.deepStrictEqual(
      fs.readdirSync(lockDir).filter((entry) => entry === '.stale-generation.json'
        || entry.startsWith('.stale-generation-')),
      [],
      'the delayed old-generation marker must not be linked into the fresh lock'
    );
    assert.strictEqual(first.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('a release rename crash is reconciled from its durable intent before reacquire', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lockDir = runLock.lockPath(runDir, 'provider-dispatch', { controlRoot });
  try {
    const crashed = crashRunLockMoveAt('release', runDir, controlRoot, lockDir);
    assert.strictEqual(
      crashed.status,
      81,
      `release child must crash immediately after rename: ${crashed.stderr}`
    );
    assert.strictEqual(
      fs.existsSync(runLockMoveIntentPath(lockDir)),
      true,
      'release rename must have a durable intent before it can move the lock'
    );
    const next = runLock.acquireRunLock(runDir, 'provider-dispatch', {
      command: 'after-release-crash',
      pid: process.pid,
    }, { controlRoot });
    assert.strictEqual(fs.existsSync(runLockMoveIntentPath(lockDir)), false);
    assert.strictEqual(
      runLockMoveAuditRecords(lockDir).some((record) => record.operation === 'release'),
      true,
      'reconciled release intent must become immutable audit evidence'
    );
    assert.strictEqual(next.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('concurrent committed-move reconcilers accept one exact audit publication', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'audit-publication-owner',
    pid: process.pid,
  }, { controlRoot });
  const lockDir = lock.lockDir;
  const auditDirectory = `${lockDir}.move-audit`;
  const originalLstatSync = fs.lstatSync;
  let hookHit = false;
  let peer = null;
  try {
    fs.lstatSync = (file, options) => {
      try {
        return originalLstatSync(file, options);
      } catch (error) {
        if (!hookHit
            && error.code === 'ENOENT'
            && path.resolve(path.dirname(String(file))).toLowerCase()
              === path.resolve(auditDirectory).toLowerCase()
            && path.basename(String(file)).startsWith('aborted-')) {
          hookHit = true;
          peer = runLock.acquireRunLock(runDir, 'provider-dispatch', {
            command: 'audit-publication-peer',
            pid: process.pid,
          }, { controlRoot });
        }
        throw error;
      }
    };
    assert.doesNotThrow(() => lock.release());
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  try {
    assert.strictEqual(hookHit, true, 'peer must publish audit after the first absent scan');
    assert.ok(peer, 'peer must reconcile the committed move and acquire the next generation');
    assert.strictEqual(runLock.readOwner(lockDir).token, peer.owner.token);
    assert.strictEqual(peer.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('release rename between recovery snapshots does not fence the next generation', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const options = { controlRoot };
  const name = 'provider-dispatch';
  const lock = runLock.acquireRunLock(runDir, name, {}, options);
  const originalLink = fs.linkSync;
  const originalLstat = fs.lstatSync;
  const originalRename = fs.renameSync;
  let injected = false;
  let moved = false;
  let peer = null;
  let peerError = null;
  try {
    fs.linkSync = (source, destination) => {
      const result = originalLink(source, destination);
      if (!injected && String(destination).endsWith('.move-intent.json')) {
        injected = true;
        const intent = JSON.parse(fs.readFileSync(destination, 'utf8'));
        fs.lstatSync = (file, ...args) => {
          if (!moved && path.resolve(String(file)) === path.resolve(intent.destination)) {
            moved = true;
            originalRename(intent.source, intent.destination);
          }
          return originalLstat(file, ...args);
        };
        try {
          peer = runLock.acquireRunLock(runDir, name, {}, options);
        } catch (error) {
          peerError = error;
        } finally {
          fs.lstatSync = originalLstat;
        }
      }
      return result;
    };
    assert.strictEqual(lock.release(), true);
  } finally {
    fs.linkSync = originalLink;
    fs.lstatSync = originalLstat;
  }
  try {
    assert.strictEqual(injected && moved, true, 'rename must occur between recovery snapshots');
    assert.ifError(peerError);
    assert.ok(peer, 'peer must acquire a fresh generation');
    assert.strictEqual(peer.release(), true);
    const next = runLock.acquireRunLock(runDir, name, {}, options);
    assert.strictEqual(next.release(), true);
    assert.strictEqual(fs.existsSync(`${lock.lockDir}.recovery-required`), false);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('committed release intent retirement between lstat and path read does not fence the fresh generation', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const options = { controlRoot };
  const name = 'provider-dispatch';
  const lockDir = runLock.lockPath(runDir, name, options);
  const intentPath = runLockMoveIntentPath(lockDir);
  const originalLstat = fs.lstatSync;
  let injected = false;
  let peer = null;
  let competingError = null;
  try {
    const crashed = crashRunLockMoveAt('release', runDir, controlRoot, lockDir);
    assert.strictEqual(
      crashed.status,
      81,
      `release child must leave a committed intent for the read race: ${crashed.stderr}`
    );
    assert.strictEqual(fs.existsSync(intentPath), true);

    fs.lstatSync = (file, ...args) => {
      const snapshot = originalLstat(file, ...args);
      if (!injected && path.basename(String(file)) === path.basename(intentPath)) {
        // A has captured the canonical intent identity. B retires that exact inode
        // to the audit log and acquires the next generation before A reads by path.
        injected = true;
        peer = runLock.acquireRunLock(runDir, name, {
          command: 'intent-retirement-peer',
          pid: process.pid,
        }, options);
      }
      return snapshot;
    };
    try {
      runLock.acquireRunLock(runDir, name, {
        command: 'intent-retirement-delayed-reader',
        pid: process.pid,
      }, options);
    } catch (error) {
      competingError = error;
    }
  } finally {
    fs.lstatSync = originalLstat;
  }
  try {
    assert.strictEqual(
      injected,
      true,
      `peer must retire the intent after A captures its identity: ${competingError && competingError.stack}`
    );
    assert.ok(peer, 'peer must archive the committed intent and acquire a fresh generation');
    assert.ok(competingError, 'the delayed reader must observe the peer-owned fresh lock');
    assert.match(String(competingError.message), /lock is active/);
    assert.doesNotMatch(String(competingError.message), /recovery required/);
    assert.strictEqual(
      fs.existsSync(`${lockDir}.recovery-required`),
      false,
      'an exact retirement race must not publish a recovery fence'
    );
    assert.strictEqual(runLock.readOwner(lockDir).token, peer.owner.token);
    assert.strictEqual(peer.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('aborted intent retirement between lstat and path read ignores a replacement fresh generation', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const options = { controlRoot };
  const name = 'provider-dispatch';
  const lock = runLock.acquireRunLock(runDir, name, {
    command: 'aborted-intent-owner',
    pid: process.pid,
  }, options);
  const lockDir = lock.lockDir;
  const intentPath = runLockMoveIntentPath(lockDir);
  const auditDirectory = `${lockDir}.move-audit`;
  const retiredSource = `${lockDir}.retired-aborted-source`;
  const originalRename = fs.renameSync;
  const originalLstat = fs.lstatSync;
  let injectedRenameFailure = false;
  let injectedReadRace = false;
  let peer = null;
  let competingError = null;
  try {
    fs.renameSync = (source, destination) => {
      if (!injectedRenameFailure
          && path.basename(String(source)) === path.basename(lockDir)
          && String(destination).includes('.release-')) {
        injectedRenameFailure = true;
        const error = new Error('simulated release rename failure');
        error.code = 'EACCES';
        throw error;
      }
      return originalRename(source, destination);
    };
    assert.throws(() => lock.release(), /simulated release rename failure/);
  } finally {
    fs.renameSync = originalRename;
  }

  try {
    assert.strictEqual(injectedRenameFailure, true);
    const abortedName = fs.readdirSync(auditDirectory)
      .find((entry) => entry.startsWith('aborted-') && entry.endsWith('.json'));
    assert.ok(abortedName, 'failed release must persist an aborted terminal audit');
    const abortedAudit = path.join(auditDirectory, abortedName);
    // Recreate the exact preemption window: A sees the canonical inode first;
    // B then retires that same inode to its already-validated aborted outcome.
    originalRename(abortedAudit, intentPath);

    fs.lstatSync = (file, ...args) => {
      const snapshot = originalLstat(file, ...args);
      if (!injectedReadRace
          && path.basename(String(file)) === path.basename(intentPath)) {
        injectedReadRace = true;
        originalRename(file, abortedAudit);
        originalRename(lockDir, retiredSource);
        peer = runLock.acquireRunLock(runDir, name, {
          command: 'aborted-intent-fresh-owner',
          pid: process.pid,
        }, options);
      }
      return snapshot;
    };
    try {
      runLock.acquireRunLock(runDir, name, {
        command: 'aborted-intent-delayed-reader',
        pid: process.pid,
      }, options);
    } catch (error) {
      competingError = error;
    }
  } finally {
    fs.lstatSync = originalLstat;
  }

  try {
    assert.strictEqual(injectedReadRace, true);
    assert.ok(peer, 'peer must acquire the replacement fresh generation');
    assert.ok(competingError, 'delayed reader must observe the peer-owned fresh lock');
    assert.match(String(competingError.message), /lock is active/);
    assert.doesNotMatch(String(competingError.message), /recovery required/);
    assert.strictEqual(
      fs.existsSync(`${lockDir}.recovery-required`),
      false,
      'an exact aborted terminal audit must not fence the replacement generation'
    );
    assert.strictEqual(runLock.readOwner(lockDir).token, peer.owner.token);
    assert.strictEqual(peer.release(), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('move intent disappearance without exact audit evidence remains fail-closed', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const options = { controlRoot };
  const name = 'provider-dispatch';
  const lockDir = runLock.lockPath(runDir, name, options);
  const intentPath = runLockMoveIntentPath(lockDir);
  const originalLstat = fs.lstatSync;
  let injected = false;
  try {
    const crashed = crashRunLockMoveAt('release', runDir, controlRoot, lockDir);
    assert.strictEqual(
      crashed.status,
      81,
      `release child must leave an intent for the missing-evidence test: ${crashed.stderr}`
    );
    fs.lstatSync = (file, ...args) => {
      const snapshot = originalLstat(file, ...args);
      if (!injected && path.basename(String(file)) === path.basename(intentPath)) {
        injected = true;
        fs.unlinkSync(file);
      }
      return snapshot;
    };
    assert.throws(
      () => runLock.acquireRunLock(runDir, name, {
        command: 'intent-missing-without-audit',
        pid: process.pid,
      }, options),
      /recovery required for an invalid move intent/
    );
  } finally {
    fs.lstatSync = originalLstat;
  }
  try {
    assert.strictEqual(injected, true);
    assert.strictEqual(
      fs.existsSync(`${lockDir}.recovery-required`),
      true,
      'unexplained intent loss must retain the recovery fence'
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

for (const tamperAudit of [false, true]) {
  test(`move intent retirement during readback ${tamperAudit ? 'rejects foreign audit bytes' : 'converges'}`, () => {
    const runDir = makeRunDir();
    const controlRoot = makeRunDir();
    const options = { controlRoot };
    const name = 'provider-dispatch';
    const lock = runLock.acquireRunLock(runDir, name, {}, options);
    const intentPath = runLockMoveIntentPath(lock.lockDir);
    const originalRead = fs.readFileSync;
    let injected = false;
    let peer = null;
    try {
      fs.readFileSync = (file, ...args) => {
        if (!injected && path.resolve(String(file)) === path.resolve(intentPath)) {
          injected = true;
          const intent = JSON.parse(originalRead(file, 'utf8'));
          fs.renameSync(intent.source, intent.destination);
          peer = runLock.acquireRunLock(runDir, name, {}, options);
          if (tamperAudit) {
            const audit = path.join(`${lock.lockDir}.move-audit`, `committed-${intent.intentId}.json`);
            fs.writeFileSync(audit, '{}\n');
          }
        }
        return originalRead(file, ...args);
      };
      if (tamperAudit) {
        assert.throws(() => lock.release(), /foreign intent/);
      } else {
        assert.strictEqual(lock.release(), true);
      }
    } finally {
      fs.readFileSync = originalRead;
    }
    try {
      assert.strictEqual(injected, true);
      assert.ok(peer);
      assert.strictEqual(runLock.readOwner(lock.lockDir).token, peer.owner.token);
      assert.strictEqual(peer.release(), true);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.rmSync(controlRoot, { recursive: true, force: true });
    }
  });
}

test('stale lock recovery rejects an ABA live replacement without deleting it', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  const lockDir = runLock.lockPath(runDir, 'provider-dispatch', { controlRoot });
  fs.mkdirSync(lockDir, { recursive: true });
  const staleOwner = {
    schemaVersion: 'run-lock-v1',
    name: 'provider-dispatch',
    token: 'stale-aba-token',
    pid: 2147483647,
    acquiredAt: '2020-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify(staleOwner, null, 2)}\n`);
  const parked = `${lockDir}.stale-authentic-parked`;
  const originalRenameSync = fs.renameSync;
  let tombstone = null;
  try {
    fs.renameSync = (source, destination) => {
      if (!tombstone
          && path.resolve(source).toLowerCase() === path.resolve(lockDir).toLowerCase()
          && String(destination).includes('.stale-')) {
        tombstone = destination;
        originalRenameSync(source, parked);
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'owner.json'), `${JSON.stringify({
          ...staleOwner,
          token: 'foreign-live-token',
          pid: process.pid,
        }, null, 2)}\n`);
      }
      return originalRenameSync(source, destination);
    };
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'resume',
        pid: process.pid,
      }, { controlRoot }),
      /stale tombstone identity changed|ownership changed during stale tombstone|recovery required/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    assert.strictEqual(fs.existsSync(parked), true, 'the authentic stale lock is preserved');
    assert.strictEqual(Boolean(tombstone && fs.existsSync(tombstone)), true);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(tombstone, 'owner.json'), 'utf8')).token,
      'foreign-live-token'
    );
    assert.strictEqual(fs.existsSync(lockDir), false);
    assert.strictEqual(
      fs.existsSync(`${lockDir}.recovery-required`),
      true,
      'an ambiguous stale claim must leave a durable recovery fence'
    );
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'second-resume',
        pid: process.pid,
      }, { controlRoot }),
      /recovery required/,
      'future acquisition must not bypass the displaced live owner'
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('unavailable external control root fails closed without a local lock fallback', () => {
  const runDir = makeRunDir();
  const fixtureRoot = makeRunDir();
  const controlRoot = path.join(fixtureRoot, 'not-a-directory');
  fs.writeFileSync(controlRoot, 'file blocks control root creation\n');
  try {
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'run',
        pid: process.pid,
      }, { controlRoot }),
      /failed to initialize external control store/
    );
    assert.strictEqual(
      fs.existsSync(path.join(runDir, '.provider-dispatch.lock')),
      false,
      'runDir fallback would let a provider delete the authoritative lock'
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('provider-workspace control roots are rejected in both containment directions', () => {
  const fixtureRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const runDir = path.join(providerRoot, '.agent-runs', 'run-001');
  const repoLocalControlRoot = path.join(providerRoot, '.agent-control');
  fs.mkdirSync(runDir, { recursive: true });
  try {
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'run',
        pid: process.pid,
      }, { controlRoot: repoLocalControlRoot, providerRoot }),
      /controlRoot must be outside the provider workspace/
    );
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'run',
        pid: process.pid,
      }, { controlRoot: fixtureRoot, providerRoot }),
      /controlRoot must be outside the provider workspace/
    );
    assert.throws(
      () => goalLease.bindGoalLease(runDir, {
        runId: 'run-001',
        ownerRuntime: 'codex',
        objective: 'Keep coordinator authority external',
        hostRef: 'thread:opaque',
      }, { controlRoot: repoLocalControlRoot, providerRoot }),
      /controlRoot must be outside the provider workspace/
    );
    assert.strictEqual(fs.existsSync(repoLocalControlRoot), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('a missing control directory below a junction into the provider workspace is rejected', () => {
  const fixtureRoot = makeRunDir();
  const outsideRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const runDir = path.join(providerRoot, '.agent-runs', 'run-junction');
  const junction = path.join(outsideRoot, 'repo-link');
  fs.mkdirSync(runDir, { recursive: true });
  fs.symlinkSync(providerRoot, junction, 'junction');
  const controlRoot = path.join(junction, 'not-created-yet');
  try {
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'run',
        pid: process.pid,
      }, { controlRoot, providerRoot }),
      /controlRoot must be outside the provider workspace/
    );
    assert.strictEqual(fs.existsSync(path.join(providerRoot, 'not-created-yet')), false);
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('a controlRoot runs junction into the provider workspace is rejected before binding writes', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const runDir = path.join(providerRoot, '.agent-runs', 'run-runs-junction');
  const attackerTarget = path.join(providerRoot, 'forged-authority');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(attackerTarget, { recursive: true });
  fs.symlinkSync(attackerTarget, path.join(controlRoot, 'runs'), 'junction');
  try {
    assert.throws(
      () => runLock.acquireRunLock(runDir, 'provider-dispatch', {
        command: 'run',
        pid: process.pid,
      }, { controlRoot, providerRoot }),
      /authoritative control path/
    );
    assert.deepStrictEqual(
      fs.readdirSync(attackerTarget),
      [],
      'no authoritative binding or lock may be written through the runs junction'
    );
  } finally {
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('a run-specific control junction into the provider workspace is rejected before lock writes', () => {
  const fixtureRoot = makeRunDir();
  const controlRoot = makeRunDir();
  const providerRoot = path.join(fixtureRoot, 'repo');
  const runDir = path.join(providerRoot, '.agent-runs', 'run-key-junction');
  const attackerTarget = path.join(providerRoot, 'forged-run-authority');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(attackerTarget, { recursive: true });
  fs.mkdirSync(path.join(controlRoot, 'runs'), { recursive: true });
  fs.symlinkSync(
    attackerTarget,
    path.join(controlRoot, 'runs', controlStore.controlRunKey(runDir)),
    'junction'
  );
  try {
    assert.throws(
      () => goalLease.bindGoalLease(runDir, {
        runId: 'run-key-junction',
        ownerRuntime: 'codex',
        objective: 'Reject provider-writable Goal authority',
        hostRef: 'thread:opaque',
      }, { controlRoot, providerRoot }),
      /authoritative control path/
    );
    assert.deepStrictEqual(
      fs.readdirSync(attackerTarget),
      [],
      'no Goal lock, binding, or lease may be written through the run junction'
    );
  } finally {
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('goal lease is a host lease and permits cross-runtime provider stages', () => {
  const runDir = makeRunDir();
  const controlRoot = makeRunDir();
  try {
    const lease = goalLease.bindGoalLease(runDir, {
      runId: 'run-lease',
      ownerRuntime: 'codex',
      objective: 'Ship the bounded migration',
      hostRef: 'thread:opaque',
      now: '2026-07-30T00:00:00.000Z',
    }, { controlRoot });
    assert.strictEqual(lease.revision, 1);
    assert.strictEqual(
      goalLease.readGoalLease(runDir, { controlRoot }).hostRef,
      'thread:opaque'
    );

    assert.doesNotThrow(() => goalLease.validateGoalLeaseForDispatch(lease, {
      runId: 'run-lease',
      providerRuntime: 'codex',
      orchestrationOwner: 'codex-host',
      objective: 'Ship the bounded migration',
    }));
    assert.doesNotThrow(() => goalLease.validateGoalLeaseForDispatch(lease, {
      runId: 'run-lease',
      providerRuntime: 'claude',
      orchestrationOwner: 'codex-host',
      objective: 'Ship the bounded migration',
    }));
    assert.doesNotThrow(() => goalLease.validateGoalLeaseForDispatch(lease, {
      runId: 'run-lease',
      providerRuntime: 'claude',
      orchestrationOwner: 'tp',
      objective: 'Ship the bounded migration',
    }));
    assert.throws(() => goalLease.validateGoalLeaseForDispatch(lease, {
      runId: 'run-lease',
      providerRuntime: 'codex',
      orchestrationOwner: 'codex-host',
      objective: 'Different objective',
    }), /objective conflict/);

    const released = goalLease.releaseStoredGoalLease(runDir, {
      reason: 'handoff',
      expectedRevision: 1,
      now: '2026-07-30T00:01:00.000Z',
      controlRoot,
    });
    assert.strictEqual(released.status, 'released');
    assert.strictEqual(released.revision, 2);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('host-specific orchestration owners must match the native Goal runtime', () => {
  const claudeLease = goalLease.acquireGoalLease(null, {
    runId: 'run-claude-host',
    ownerRuntime: 'claude',
    objective: 'Review and implement one bounded run',
    hostRef: 'session:opaque',
  });
  assert.doesNotThrow(() => goalLease.validateGoalLeaseForDispatch(claudeLease, {
    runId: 'run-claude-host',
    providerRuntime: 'codex',
    orchestrationOwner: 'claude-host',
    objective: 'Review and implement one bounded run',
  }));
  assert.throws(() => goalLease.validateGoalLeaseForDispatch(claudeLease, {
    runId: 'run-claude-host',
    providerRuntime: 'claude',
    orchestrationOwner: 'codex-host',
    objective: 'Review and implement one bounded run',
  }), /owner conflict/);
});

test('persisted execution policy is inherited and explicit conflicts fail closed', () => {
  const persisted = nativeControl.executionPolicy({
    'orchestration-owner': 'codex-host',
    'capability-router': 'enforce',
    'claude-adapter': 'bare',
    'codex-adapter': 'exec',
  });
  const inherited = nativeControl.resolveExecutionPolicyOptions({}, persisted);
  assert.strictEqual(inherited['orchestration-owner'], 'codex-host');
  assert.strictEqual(inherited['capability-router'], 'enforce');
  assert.strictEqual(inherited['claude-adapter'], 'bare');
  assert.strictEqual(inherited['codex-adapter'], 'exec');

  const same = nativeControl.resolveExecutionPolicyOptions({
    'claude-adapter': 'bare',
  }, persisted);
  assert.strictEqual(same['orchestration-owner'], 'codex-host');
  assert.throws(
    () => nativeControl.resolveExecutionPolicyOptions({
      'claude-adapter': 'print',
    }, persisted),
    /execution policy conflict.*claude adapter/
  );
});

test('partial-effect recovery only permits the same provider and stage', () => {
  const recovery = {
    required: true,
    providerRef: 'codex:implementation:codex-exec',
    providerKey: 'implementation',
    runtime: 'codex',
    stage: 'implementation',
    effectsState: 'partial',
  };
  assert.doesNotThrow(() => nativeControl.validateProviderRecovery(recovery, {
    providerRef: 'codex:implementation:codex-exec',
    profile: { runtime: 'codex' },
  }, {
    providerKey: 'implementation',
    stage: 'implementation',
  }));
  assert.throws(() => nativeControl.validateProviderRecovery(recovery, {
    providerRef: 'claude:implementation:claude-bare',
    profile: { runtime: 'claude' },
  }, {
    providerKey: 'implementation',
    stage: 'implementation',
  }), /same provider resume is required/);
  assert.throws(() => nativeControl.validateProviderRecovery(recovery, {
    providerRef: 'codex:implementation:codex-exec',
    profile: { runtime: 'codex' },
  }, {
    providerKey: 'review',
    stage: 'review',
  }), /same provider resume is required/);
});

console.log(`provider-lifecycle-controls: ${passed} passed`);
