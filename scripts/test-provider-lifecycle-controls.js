#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
