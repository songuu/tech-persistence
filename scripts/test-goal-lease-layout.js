#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const goalLease = require('./agent-orchestrator/goal-lease');
const controlStore = require('./agent-orchestrator/control-store');
const runLock = require('./agent-orchestrator/run-lock');

const LAYOUT_FILE = 'goal-lease.layout-v2.json';
const AUDIT_DIR = 'goal-lease.audit-v2';

function fixture() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-layout-run-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-layout-control-'));
  const options = { controlRoot };
  const lease = goalLease.bindGoalLease(runDir, {
    runId: 'layout-v2',
    ownerRuntime: 'codex',
    objective: 'Keep Goal reads independent of audit history size',
    hostRef: 'thread:layout-v2',
  }, options);
  const controlDir = path.dirname(goalLease.goalLeasePath(runDir, options));
  return { runDir, controlRoot, controlDir, options, lease };
}

function cleanup(value) {
  fs.rmSync(value.runDir, { recursive: true, force: true });
  fs.rmSync(value.controlRoot, { recursive: true, force: true });
}

function crashPrivateFenceAt(stage, runDir, controlRoot) {
  const modulePath = path.join(__dirname, 'agent-orchestrator', 'goal-lease.js');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const goalLease = require(process.env.TP_GOAL_MODULE);
    const stage = process.env.TP_GOAL_STAGE;
    const originalLink = fs.linkSync;
    const originalRename = fs.renameSync;
    fs.linkSync = (source, destination) => {
      const result = originalLink(source, destination);
      const basename = path.basename(String(destination));
      if ((stage === 'pending' && basename === '.pending-fence')
          || (stage === 'complete' && basename === 'complete.json'
            && String(destination).includes(goalLease.GOAL_LEASE_AUDIT_DIR))) {
        process.exit(83);
      }
      return result;
    };
    fs.renameSync = (source, destination) => {
      const result = originalRename(source, destination);
      if (path.basename(String(destination)) === '.' + stage + '-fence') {
        process.exit(83);
      }
      return result;
    };
    goalLease.bindGoalLease(process.env.TP_RUN_DIR, {
      runId: 'private-fence-' + stage,
      ownerRuntime: 'codex',
      objective: 'Recover private fence crash ' + stage,
      hostRef: 'thread:private-fence-' + stage,
    }, { controlRoot: process.env.TP_CONTROL_ROOT });
    process.exit(84);
  `;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TP_GOAL_MODULE: modulePath,
      TP_GOAL_STAGE: stage,
      TP_RUN_DIR: runDir,
      TP_CONTROL_ROOT: controlRoot,
    },
  });
}

function crashIncompleteFenceStageAt(stage, runDir, controlRoot) {
  const modulePath = path.join(__dirname, 'agent-orchestrator', 'goal-lease.js');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const goalLease = require(process.env.TP_GOAL_MODULE);
    const stage = process.env.TP_GOAL_STAGE;
    const opened = new Set();
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    fs.openSync = (file, flags, mode) => {
      const descriptor = originalOpen(file, flags, mode);
      if (path.basename(String(file)).startsWith(goalLease.GOAL_LEASE_TRANSACTION_FILE)
          && path.basename(String(file)).endsWith('.tmp')) {
        opened.add(descriptor);
        if (stage === 'open') process.exit(85);
      }
      return descriptor;
    };
    fs.writeFileSync = (target, bytes, ...args) => {
      if (opened.has(target) && stage === 'write') {
        originalWrite(target, Buffer.from(bytes).subarray(0, 11), ...args);
        process.exit(85);
      }
      return originalWrite(target, bytes, ...args);
    };
    goalLease.bindGoalLease(process.env.TP_RUN_DIR, {
      runId: 'incomplete-fence-' + stage,
      ownerRuntime: 'codex',
      objective: 'Recover incomplete fence staging ' + stage,
      hostRef: 'thread:incomplete-fence-' + stage,
    }, { controlRoot: process.env.TP_CONTROL_ROOT });
    process.exit(86);
  `;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TP_GOAL_MODULE: modulePath,
      TP_GOAL_STAGE: stage,
      TP_RUN_DIR: runDir,
      TP_CONTROL_ROOT: controlRoot,
    },
  });
}

function crashCanonicalFenceAtPublication(runDir, controlRoot) {
  const modulePath = path.join(__dirname, 'agent-orchestrator', 'goal-lease.js');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const goalLease = require(process.env.TP_GOAL_MODULE);
    const originalLink = fs.linkSync;
    fs.linkSync = (source, destination) => {
      const result = originalLink(source, destination);
      if (path.basename(String(destination)) === goalLease.GOAL_LEASE_TRANSACTION_FILE) {
        process.exit(87);
      }
      return result;
    };
    goalLease.bindGoalLease(process.env.TP_RUN_DIR, {
      runId: 'legacy-cold-audit',
      ownerRuntime: 'codex',
      objective: 'Persist a legacy finalized fence bundle',
      hostRef: 'thread:legacy-cold-audit',
    }, { controlRoot: process.env.TP_CONTROL_ROOT });
    process.exit(88);
  `;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TP_GOAL_MODULE: modulePath,
      TP_RUN_DIR: runDir,
      TP_CONTROL_ROOT: controlRoot,
    },
  });
}

function withPosixDirectorySyncTrace(callback) {
  const tracePath = (file) => {
    const resolved = path.resolve(String(file));
    try {
      return fs.realpathSync.native(resolved);
    } catch (_) {
      // Windows short/long aliases must compare as the same directory, even
      // when the final rename destination has not been created yet.
      return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
    }
  };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originals = {
    openSync: fs.openSync,
    fsyncSync: fs.fsyncSync,
    closeSync: fs.closeSync,
    mkdtempSync: fs.mkdtempSync,
    mkdirSync: fs.mkdirSync,
    renameSync: fs.renameSync,
  };
  const descriptors = new Map();
  const fakeDescriptors = new Set();
  const events = [];
  let nextFakeDescriptor = -1000;
  try {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      enumerable: platform.enumerable,
      get: () => (
        String(new Error().stack || '').includes('syncDirectory')
          ? 'linux'
          : platform.value
      ),
    });
    fs.openSync = (file, flags, mode) => {
      const resolved = tracePath(file);
      let directory = false;
      try {
        directory = fs.lstatSync(resolved).isDirectory();
      } catch (_) {
        // Let the native open report missing or unsafe paths.
      }
      if (directory) {
        const descriptor = nextFakeDescriptor--;
        descriptors.set(descriptor, resolved);
        fakeDescriptors.add(descriptor);
        return descriptor;
      }
      const actualFlags = path.basename(resolved) === '.aborted-staging'
        && flags === fs.constants.O_RDONLY ? fs.constants.O_RDWR : flags;
      const descriptor = originals.openSync(file, actualFlags, mode);
      descriptors.set(descriptor, resolved);
      return descriptor;
    };
    fs.fsyncSync = (descriptor) => {
      if (!fakeDescriptors.has(descriptor)) originals.fsyncSync(descriptor);
      events.push({
        type: fakeDescriptors.has(descriptor) ? 'directory-sync' : 'file-sync',
        path: descriptors.get(descriptor),
      });
    };
    fs.closeSync = (descriptor) => {
      try {
        return fakeDescriptors.has(descriptor) ? undefined : originals.closeSync(descriptor);
      } finally {
        descriptors.delete(descriptor);
        fakeDescriptors.delete(descriptor);
      }
    };
    fs.mkdtempSync = (prefix, options) => {
      const result = originals.mkdtempSync(prefix, options);
      events.push({ type: 'generation-create', path: tracePath(result) });
      return result;
    };
    fs.mkdirSync = (directory, options) => {
      const resolved = tracePath(directory);
      const existed = fs.existsSync(resolved);
      const result = originals.mkdirSync(directory, options);
      if (!existed && fs.existsSync(resolved)) {
        events.push({ type: 'directory-create', path: resolved });
      }
      return result;
    };
    fs.renameSync = (source, destination) => {
      events.push({
        type: 'rename',
        source: tracePath(source),
        destination: tracePath(destination),
      });
      return originals.renameSync(source, destination);
    };
    const result = callback(events);
    return { events, result };
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.assign(fs, originals);
  }
}

function assertGenerationDurableBeforeRename(events, destinationBasename, label) {
  const renameIndex = events.findIndex((event) => (
    event.type === 'rename'
    && path.basename(event.destination) === destinationBasename
  ));
  assert.notStrictEqual(renameIndex, -1, `${label}: destructive rename was not observed`);
  const generation = path.dirname(events[renameIndex].destination);
  const parent = path.dirname(generation);
  const generationIndex = events.findIndex((event, index) => (
    index < renameIndex
    && event.type === 'generation-create'
    && event.path === generation
  ));
  assert.notStrictEqual(generationIndex, -1, `${label}: generation creation was not observed`);
  const beforeRename = events.slice(generationIndex + 1, renameIndex);
  assert.strictEqual(
    beforeRename.some((event) => event.type === 'file-sync'
      && path.dirname(event.path || '') === generation),
    true,
    `${label}: manifest bytes must be fsynced before destructive rename`
  );
  assert.strictEqual(
    beforeRename.some((event) => event.type === 'directory-sync'
      && event.path === generation),
    true,
    `${label}: generation manifest entry must be synced before destructive rename`
  );
  assert.strictEqual(
    beforeRename.some((event) => event.type === 'directory-sync'
      && event.path === parent),
    true,
    `${label}: generation parent entry must be synced before destructive rename`
  );
  const afterRename = events.slice(renameIndex + 1);
  for (const directory of [path.dirname(events[renameIndex].source), generation, parent]) {
    assert.strictEqual(
      afterRename.some((event) => event.type === 'directory-sync'
        && event.path === directory),
      true,
      `${label}: ${directory} must be synced after destructive rename`
    );
  }
}

function assertCreatedDirectoryParentSynced(events, directoryBasename, label) {
  const createdIndex = events.findIndex((event) => (
    event.type === 'directory-create'
    && path.basename(event.path) === directoryBasename
  ));
  assert.notStrictEqual(createdIndex, -1, `${label}: directory creation was not observed`);
  const directory = events[createdIndex].path;
  const nextGenerationIndex = events.findIndex((event, index) => (
    index > createdIndex
    && event.type === 'generation-create'
    && path.dirname(event.path) === directory
  ));
  assert.notStrictEqual(nextGenerationIndex, -1, `${label}: child generation was not observed`);
  assert.strictEqual(
    events.slice(createdIndex + 1, nextGenerationIndex).some((event) => (
      event.type === 'directory-sync'
      && event.path === path.dirname(directory)
    )),
    true,
    `${label}: new private directory entry must be synced before child generation creation`
  );
}

test('a missing layout marker forces one locked legacy migration before stable reads', () => {
  const value = fixture();
  const marker = path.join(value.controlDir, LAYOUT_FILE);
  const originalWithRunLock = runLock.withRunLock;
  let lockEntries = 0;
  try {
    fs.rmSync(marker, { force: true });
    runLock.withRunLock = (...args) => {
      lockEntries += 1;
      return originalWithRunLock(...args);
    };
    assert.deepStrictEqual(goalLease.readGoalLease(value.runDir, value.options), value.lease);
    assert.strictEqual(lockEntries, 1, 'markerless layouts must not use the unlocked fast path');
    assert.strictEqual(fs.existsSync(marker), true, 'locked migration must publish the v2 marker last');
  } finally {
    runLock.withRunLock = originalWithRunLock;
    cleanup(value);
  }
});

test('the public write API acquires the Goal update lock before reconciliation', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-public-write-run-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-public-write-control-'));
  const originalWithRunLock = runLock.withRunLock;
  let lockEntries = 0;
  try {
    runLock.withRunLock = (lockedRunDir, lockName, metadata, callback, options) => {
      if (lockName === 'goal-lease-update') lockEntries += 1;
      return originalWithRunLock(lockedRunDir, lockName, metadata, callback, options);
    };
    const lease = goalLease.acquireGoalLease(null, {
      runId: 'public-write-lock',
      ownerRuntime: 'codex',
      objective: 'Public writes reconcile only while holding the Goal update lock',
      hostRef: 'thread:public-write-lock',
    });
    goalLease.writeGoalLease(runDir, lease, { controlRoot });
    assert.strictEqual(lockEntries, 1, 'the public write API must acquire exactly one update lock');
  } finally {
    runLock.withRunLock = originalWithRunLock;
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('stable reads are O(1) with 10k cold audit records and unrelated control entries', () => {
  const value = fixture();
  const auditDir = path.join(value.controlDir, AUDIT_DIR);
  const originalReaddirSync = fs.readdirSync;
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    for (let index = 0; index < 10_000; index += 1) {
      fs.writeFileSync(path.join(auditDir, `historical-${index}.json`), '{}\n');
    }
    for (let index = 0; index < 64; index += 1) {
      fs.writeFileSync(path.join(value.controlDir, `unrelated-${index}.json`), '{}\n');
    }
    fs.readdirSync = (directory, ...args) => {
      const resolved = path.resolve(String(directory));
      if (resolved === path.resolve(value.controlDir) || resolved === path.resolve(auditDir)) {
        throw new Error(`stable Goal read enumerated ${resolved}`);
      }
      return originalReaddirSync(directory, ...args);
    };
    assert.deepStrictEqual(goalLease.readGoalLease(value.runDir, value.options), value.lease);
  } finally {
    fs.readdirSync = originalReaddirSync;
    cleanup(value);
  }
});

test('legacy migration fails closed on a corrupt unresolved transaction artifact', () => {
  const value = fixture();
  const marker = path.join(value.controlDir, LAYOUT_FILE);
  const corrupt = path.join(value.controlDir, 'goal-lease.txn.json.corrupt-unresolved');
  try {
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(corrupt, '{not-json}\n');
    assert.throws(
      () => goalLease.readGoalLease(value.runDir, value.options),
      /recovery required|invalid/i
    );
    assert.strictEqual(fs.existsSync(marker), false, 'failed migration must not publish layout-v2');
    assert.strictEqual(fs.existsSync(corrupt), true, 'unknown evidence must be preserved');
  } finally {
    cleanup(value);
  }
});

test('completed transactions keep no variable transaction evidence in the hot control directory', () => {
  const value = fixture();
  try {
    const hotEntries = fs.readdirSync(value.controlDir)
      .filter((entry) => entry.startsWith(`${goalLease.GOAL_LEASE_TRANSACTION_FILE}.`));
    assert.deepStrictEqual(hotEntries, []);
    const generations = fs.readdirSync(
      path.join(value.controlDir, AUDIT_DIR),
      { withFileTypes: true }
    ).filter((entry) => entry.isDirectory() && entry.name.startsWith('generation-'));
    assert.strictEqual(generations.length >= 1, true);
    assert.strictEqual(
      generations.some((entry) => fs.existsSync(path.join(
        value.controlDir,
        AUDIT_DIR,
        entry.name,
        'complete.json'
      ))),
      true,
      'a finalized bundle must be durably completed in cold audit'
    );
  } finally {
    cleanup(value);
  }
});

test('rollback claims use a private random generation instead of a predictable sibling target', () => {
  const value = fixture();
  const authority = goalLease.goalLeasePath(value.runDir, value.options);
  const originalRenameSync = fs.renameSync;
  let claimDestination = null;
  let injected = false;
  try {
    fs.renameSync = (source, destination) => {
      if (!injected && path.resolve(destination) === path.resolve(authority)) {
        const result = originalRenameSync(source, destination);
        injected = true;
        throw new Error('injected post-authority-rename failure');
      }
      if (path.resolve(source) === path.resolve(authority)
          && path.basename(String(destination)) === '.rollback-authority-claim') {
        claimDestination = String(destination);
      }
      return originalRenameSync(source, destination);
    };
    assert.throws(
      () => goalLease.releaseStoredGoalLease(value.runDir, {
        ...value.options,
        expectedRevision: value.lease.revision,
      }),
      /injected post-authority-rename failure/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    assert.strictEqual(injected, true);
    assert.ok(claimDestination, 'authority rollback must produce a durable private claim');
    assert.strictEqual(path.basename(claimDestination), '.rollback-authority-claim');
    assert.match(path.basename(path.dirname(claimDestination)), /^generation-/);
    assert.strictEqual(
      path.basename(path.dirname(path.dirname(claimDestination))),
      'goal-lease.claims-v2'
    );
    assert.strictEqual(
      fs.existsSync(path.join(path.dirname(claimDestination), 'manifest.json')),
      true
    );
    assert.deepStrictEqual(
      goalLease.readGoalLease(value.runDir, value.options),
      value.lease
    );
  } finally {
    cleanup(value);
  }
});

test('rollback claim generation is durable before and after its destructive rename', () => {
  const value = fixture();
  const authority = goalLease.goalLeasePath(value.runDir, value.options);
  try {
    const { events } = withPosixDirectorySyncTrace(() => {
      const tracedRename = fs.renameSync;
      let injected = false;
      fs.renameSync = (source, destination) => {
        const result = tracedRename(source, destination);
        if (!injected && path.resolve(String(destination)) === path.resolve(authority)) {
          injected = true;
          throw new Error('force rollback claim durability path');
        }
        return result;
      };
      assert.throws(
        () => goalLease.releaseStoredGoalLease(value.runDir, {
          ...value.options,
          expectedRevision: value.lease.revision,
        }),
        /force rollback claim durability path/
      );
    });
    assertCreatedDirectoryParentSynced(
      events,
      'goal-lease.claims-v2',
      'rollback claim root'
    );
    assertGenerationDurableBeforeRename(
      events,
      '.rollback-authority-claim',
      'rollback claim generation'
    );
  } finally {
    cleanup(value);
  }
});

test('private fence generation parent is durable around the resolution rename', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-fence-sync-run-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-fence-sync-control-'));
  try {
    const { events } = withPosixDirectorySyncTrace(() => goalLease.bindGoalLease(runDir, {
      runId: 'private-fence-parent-sync',
      ownerRuntime: 'codex',
      objective: 'Persist private fence generation parent entries',
      hostRef: 'thread:private-fence-parent-sync',
    }, { controlRoot }));
    assertCreatedDirectoryParentSynced(events, AUDIT_DIR, 'cold audit root');
    assertGenerationDurableBeforeRename(
      events,
      '.resolved-fence',
      'private fence generation'
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('an occupied private fence destination fails closed without overwriting the occupant', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-occupied-run-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-occupied-control-'));
  const options = { controlRoot };
  const originalLinkSync = fs.linkSync;
  let occupied = null;
  try {
    fs.linkSync = (source, destination) => {
      if (!occupied && path.basename(String(destination)) === '.pending-fence') {
        occupied = String(destination);
        fs.writeFileSync(occupied, 'foreign occupant\n', { flag: 'wx' });
      }
      return originalLinkSync(source, destination);
    };
    assert.throws(
      () => goalLease.bindGoalLease(runDir, {
        runId: 'occupied-private-fence',
        ownerRuntime: 'codex',
        objective: 'Do not overwrite occupied private fence destinations',
        hostRef: 'thread:occupied-private-fence',
      }, options),
      /foreign|occupied|recovery required/
    );
  } finally {
    fs.linkSync = originalLinkSync;
  }
  try {
    assert.ok(occupied);
    assert.strictEqual(fs.readFileSync(occupied, 'utf8'), 'foreign occupant\n');
    assert.strictEqual(
      fs.existsSync(path.join(
        path.dirname(goalLease.goalLeasePath(runDir, options)),
        goalLease.GOAL_LEASE_TRANSACTION_FILE
      )),
      true,
      'canonical recovery fencing must remain visible'
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('a crash after cold-audit completion is recovered before the next stable read', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-audit-crash-run-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-audit-crash-control-'));
  const modulePath = path.join(__dirname, 'agent-orchestrator', 'goal-lease.js');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const goalLease = require(process.env.TP_GOAL_MODULE);
    const original = fs.linkSync;
    fs.linkSync = (source, destination) => {
      const result = original(source, destination);
      if (path.basename(String(destination)) === 'complete.json') process.exit(83);
      return result;
    };
    goalLease.bindGoalLease(process.env.TP_RUN_DIR, {
      runId: 'audit-crash',
      ownerRuntime: 'codex',
      objective: 'Recover a crash after cold audit completion',
      hostRef: 'thread:audit-crash',
    }, { controlRoot: process.env.TP_CONTROL_ROOT });
    process.exit(84);
  `;
  try {
    const crashed = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TP_GOAL_MODULE: modulePath,
        TP_RUN_DIR: runDir,
        TP_CONTROL_ROOT: controlRoot,
      },
    });
    assert.strictEqual(crashed.status, 83, crashed.stderr);
    const recovered = goalLease.readGoalLease(runDir, { controlRoot });
    assert.strictEqual(recovered.runId, 'audit-crash');
    const controlDir = path.dirname(goalLease.goalLeasePath(runDir, { controlRoot }));
    const marker = JSON.parse(fs.readFileSync(path.join(controlDir, LAYOUT_FILE), 'utf8'));
    assert.strictEqual(marker.status, 'clean');
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('legacy cold-audit generation parent is durable around evidence archival', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-cold-sync-run-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-cold-sync-control-'));
  try {
    const crashed = crashCanonicalFenceAtPublication(runDir, controlRoot);
    assert.strictEqual(crashed.status, 87, crashed.stderr);
    const controlDir = path.dirname(goalLease.goalLeasePath(runDir, { controlRoot }));
    const fence = path.join(controlDir, goalLease.GOAL_LEASE_TRANSACTION_FILE);
    const transaction = JSON.parse(fs.readFileSync(fence, 'utf8'));
    const stat = fs.lstatSync(fence, { bigint: true });
    const suffix = `${transaction.transactionId}-${stat.dev}-${stat.ino}`;
    const resolved = `${fence}.resolved-${suffix}`;
    const done = `${fence}.done-${suffix}`;
    fs.renameSync(fence, resolved);
    fs.linkSync(resolved, done);

    const { events, result } = withPosixDirectorySyncTrace(
      () => goalLease.readGoalLease(runDir, { controlRoot })
    );
    assert.strictEqual(result, null);
    assertGenerationDurableBeforeRename(
      events,
      '.resolved-evidence-0',
      'legacy cold-audit generation'
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('private fence generations recover every durable claim crash boundary', () => {
  for (const stage of ['pending', 'resolved', 'done']) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `tp-goal-${stage}-run-`));
    const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tp-goal-${stage}-control-`));
    try {
      const crashed = crashPrivateFenceAt(stage, runDir, controlRoot);
      assert.strictEqual(crashed.status, 83, `${stage}: ${crashed.stderr}`);
      const recovered = goalLease.readGoalLease(runDir, { controlRoot });
      if (stage === 'pending') {
        assert.strictEqual(recovered, null, 'pending evidence precedes the commit marker');
      } else {
        assert.strictEqual(recovered.runId, `private-fence-${stage}`);
      }
      const controlDir = path.dirname(goalLease.goalLeasePath(runDir, { controlRoot }));
      const marker = JSON.parse(fs.readFileSync(path.join(controlDir, LAYOUT_FILE), 'utf8'));
      assert.strictEqual(marker.status, 'clean');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.rmSync(controlRoot, { recursive: true, force: true });
    }
  }
});

test('projection claims reject a pre-existing junction before chmod or writes', () => {
  const value = fixture();
  const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-claim-foreign-'));
  const claimRoot = path.join(
    fs.realpathSync.native(value.runDir),
    '.goal-lease.claims-v2'
  );
  const sentinel = path.join(foreignRoot, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'untouched\n');
  fs.symlinkSync(foreignRoot, claimRoot, 'junction');
  const authority = goalLease.goalLeasePath(value.runDir, value.options);
  const originalRenameSync = fs.renameSync;
  const originalChmodSync = fs.chmodSync;
  let authorityCommitted = false;
  let foreignChmodAttempted = false;
  try {
    fs.renameSync = (source, destination) => {
      if (!authorityCommitted && path.resolve(destination) === path.resolve(authority)) {
        const result = originalRenameSync(source, destination);
        authorityCommitted = true;
        throw new Error('force projection rollback claim');
      }
      return originalRenameSync(source, destination);
    };
    fs.chmodSync = (target, mode) => {
      if (path.resolve(String(target)) === path.resolve(claimRoot)) {
        foreignChmodAttempted = true;
      }
      return originalChmodSync(target, mode);
    };
    assert.throws(
      () => goalLease.releaseStoredGoalLease(value.runDir, {
        ...value.options,
        expectedRevision: value.lease.revision,
      }),
      /claim root|symbolic link|reparse|recovery required/i
    );
  } finally {
    fs.renameSync = originalRenameSync;
    fs.chmodSync = originalChmodSync;
  }
  try {
    assert.strictEqual(authorityCommitted, true);
    assert.strictEqual(
      foreignChmodAttempted,
      false,
      'a provider-controlled junction must be rejected before chmod'
    );
    assert.deepStrictEqual(fs.readdirSync(foreignRoot), ['sentinel.txt']);
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'untouched\n');
  } finally {
    cleanup(value);
    fs.rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test('cold audit rejects a pre-existing junction before directory mutations', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-audit-link-run-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-audit-link-control-'));
  const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-audit-link-foreign-'));
  const options = { controlRoot };
  const controlDir = controlStore.ensureControlRunDir(runDir, options);
  const auditRoot = path.join(controlDir, AUDIT_DIR);
  const sentinel = path.join(foreignRoot, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'untouched\n');
  fs.symlinkSync(foreignRoot, auditRoot, 'junction');
  const originalMkdirSync = fs.mkdirSync;
  const originalChmodSync = fs.chmodSync;
  const originalOpenSync = fs.openSync;
  let auditMutationAttempted = false;
  try {
    fs.mkdirSync = (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(auditRoot)) {
        auditMutationAttempted = true;
      }
      return originalMkdirSync(target, ...args);
    };
    fs.chmodSync = (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(auditRoot)) {
        auditMutationAttempted = true;
      }
      return originalChmodSync(target, ...args);
    };
    fs.openSync = (target, ...args) => {
      if (typeof target === 'string'
          && path.resolve(target).startsWith(`${path.resolve(auditRoot)}${path.sep}`)) {
        auditMutationAttempted = true;
      }
      return originalOpenSync(target, ...args);
    };
    assert.throws(
      () => goalLease.bindGoalLease(runDir, {
        runId: 'audit-link',
        ownerRuntime: 'codex',
        objective: 'Reject a linked cold audit root before mutation',
        hostRef: 'thread:audit-link',
      }, options),
      /cold audit directory|symbolic link|reparse point|escaped/i
    );
  } finally {
    fs.mkdirSync = originalMkdirSync;
    fs.chmodSync = originalChmodSync;
    fs.openSync = originalOpenSync;
  }
  try {
    assert.strictEqual(auditMutationAttempted, false);
    assert.deepStrictEqual(fs.readdirSync(foreignRoot), ['sentinel.txt']);
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'untouched\n');
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test('open and partial-write crashes archive unready staging before recovery', () => {
  for (const stage of ['open', 'write']) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `tp-goal-unready-${stage}-run-`));
    const controlRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `tp-goal-unready-${stage}-control-`)
    );
    try {
      const crashed = crashIncompleteFenceStageAt(stage, runDir, controlRoot);
      assert.strictEqual(crashed.status, 85, `${stage}: ${crashed.stderr}`);
      assert.strictEqual(
        goalLease.readGoalLease(runDir, { controlRoot }),
        null,
        'an unready staging file must not become authoritative'
      );
      const controlDir = path.dirname(goalLease.goalLeasePath(runDir, { controlRoot }));
      assert.deepStrictEqual(
        fs.readdirSync(controlDir).filter((entry) => (
          entry.startsWith(`${goalLease.GOAL_LEASE_TRANSACTION_FILE}.`)
          && entry.endsWith('.tmp')
        )),
        [],
        'unready staging must leave the hot control directory'
      );
      const aborted = fs.readdirSync(path.join(controlDir, AUDIT_DIR), {
        withFileTypes: true,
      }).filter((entry) => entry.isDirectory()).filter((entry) => (
        fs.existsSync(path.join(controlDir, AUDIT_DIR, entry.name, '.aborted-staging'))
      ));
      assert.strictEqual(aborted.length, 1, 'cold audit must retain the aborted bytes');
      const rebound = goalLease.bindGoalLease(runDir, {
        runId: `incomplete-fence-${stage}`,
        ownerRuntime: 'codex',
        objective: `Recover incomplete fence staging ${stage}`,
        hostRef: `thread:incomplete-fence-${stage}`,
      }, { controlRoot });
      assert.strictEqual(rebound.status, 'active');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.rmSync(controlRoot, { recursive: true, force: true });
    }
  }
});

test('aborted staging bytes are fsynced before durable completion is published', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-aborted-sync-run-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-aborted-sync-control-'));
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  const originalCloseSync = fs.closeSync;
  const originalLinkSync = fs.linkSync;
  const opened = new Map();
  let abortedBytesSynced = false;
  let completionPublished = false;
  let completionFollowedDataSync = false;
  try {
    const crashed = crashIncompleteFenceStageAt('write', runDir, controlRoot);
    assert.strictEqual(crashed.status, 85, crashed.stderr);
    fs.openSync = (file, flags, mode) => {
      const descriptor = originalOpenSync(file, flags, mode);
      opened.set(descriptor, String(file));
      return descriptor;
    };
    fs.fsyncSync = (descriptor) => {
      const result = originalFsyncSync(descriptor);
      if (path.basename(opened.get(descriptor) || '') === '.aborted-staging') {
        abortedBytesSynced = true;
      }
      return result;
    };
    fs.closeSync = (descriptor) => {
      try {
        return originalCloseSync(descriptor);
      } finally {
        opened.delete(descriptor);
      }
    };
    fs.linkSync = (source, destination) => {
      if (path.basename(String(destination)) === 'complete.json') {
        completionPublished = true;
        completionFollowedDataSync = abortedBytesSynced;
      }
      return originalLinkSync(source, destination);
    };

    assert.strictEqual(goalLease.readGoalLease(runDir, { controlRoot }), null);
    assert.strictEqual(completionPublished, true, 'recovery must publish a completion marker');
    assert.strictEqual(
      completionFollowedDataSync,
      true,
      'cold aborted bytes must be fsynced before the completion marker'
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
    fs.closeSync = originalCloseSync;
    fs.linkSync = originalLinkSync;
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('aborted staging generation parent is durable around archival rename', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-aborted-parent-run-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-aborted-parent-control-'));
  try {
    const crashed = crashIncompleteFenceStageAt('write', runDir, controlRoot);
    assert.strictEqual(crashed.status, 85, crashed.stderr);
    const { events, result } = withPosixDirectorySyncTrace(
      () => goalLease.readGoalLease(runDir, { controlRoot })
    );
    assert.strictEqual(result, null);
    assertGenerationDurableBeforeRename(
      events,
      '.aborted-staging',
      'aborted staging generation'
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});

test('syntactically complete corrupt staging remains fail-closed', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-corrupt-stage-run-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-goal-corrupt-stage-control-'));
  try {
    const crashed = crashIncompleteFenceStageAt('open', runDir, controlRoot);
    assert.strictEqual(crashed.status, 85, crashed.stderr);
    const controlDir = path.dirname(goalLease.goalLeasePath(runDir, { controlRoot }));
    const [staging] = fs.readdirSync(controlDir).filter((entry) => (
      entry.startsWith(`${goalLease.GOAL_LEASE_TRANSACTION_FILE}.`)
      && entry.endsWith('.tmp')
    ));
    assert.ok(staging, 'the deterministic open crash must leave its staging file');
    fs.writeFileSync(
      path.join(controlDir, staging),
      `${JSON.stringify({ schemaVersion: 'foreign-ready-staging-v1' })}\n`
    );

    assert.throws(
      () => goalLease.readGoalLease(runDir, { controlRoot }),
      /recovery required|transaction fence schema|live marker identifies/i
    );
    assert.strictEqual(
      fs.existsSync(path.join(controlDir, staging)),
      true,
      'complete corrupt evidence must remain hot and fail closed'
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
});
