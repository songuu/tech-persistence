#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sprint = require('./lib/codex-active-sprint');

const cliPath = path.join(__dirname, 'codex-active-sprint-state.js');
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

function withWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-codex-sprint-state-'));
  fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writePlan(root, name = 'demo.md') {
  const relative = `docs/plans/${name}`;
  fs.writeFileSync(path.join(root, relative), '---\nstatus: in-progress\n---\n# Demo\n');
  return relative;
}

function pointerFor(plan, phase, next = 'Continue') {
  return {
    version: 1,
    plan,
    phase,
    status: 'active',
    updated_at: '2026-07-24T02:00:00.000Z',
    next,
  };
}

function raw(root) {
  return JSON.parse(fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'));
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

function init(root, plan = writePlan(root)) {
  return sprint.initActiveSprint({ cwd: root, plan, next: 'Think' });
}

function reach(root, phase) {
  const sequence = ['think', 'plan', 'work', 'review', 'compound'];
  for (let index = 0; sequence[index] !== phase; index += 1) {
    sprint.advanceActiveSprint({
      cwd: root,
      expectedPhase: sequence[index],
      toPhase: sequence[index + 1],
      next: sequence[index + 1],
    });
  }
}

function leaveUnpublishedInitTransaction(root, plan) {
  const originalOpen = fs.openSync;
  let injected = false;
  fs.openSync = (target, ...args) => {
    if (!injected && /active-sprint\.publish-/.test(String(target))) {
      injected = true;
      const error = new Error('simulated publish candidate open failure');
      error.code = 'EIO';
      throw error;
    }
    return originalOpen(target, ...args);
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.strictEqual(injected, true);
}

function leavePartialInitTransaction(root, plan, code = 'ENOSPC') {
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeFileSync;
  let publishHandle;
  let injected = false;
  fs.openSync = (target, ...args) => {
    const handle = originalOpen(target, ...args);
    if (/active-sprint\.publish-/.test(String(target))) publishHandle = handle;
    return handle;
  };
  fs.writeFileSync = (target, data, ...args) => {
    if (!injected && target === publishHandle) {
      injected = true;
      const bytes = Buffer.isBuffer(data)
        ? data : Buffer.from(String(data), args[0] || 'utf8');
      const prefixLength = Math.max(1, Math.floor(bytes.length / 3));
      originalWrite(target, bytes.subarray(0, prefixLength));
      const error = new Error(`simulated partial publish ${code}`);
      error.code = code;
      throw error;
    }
    return originalWrite(target, data, ...args);
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.openSync = originalOpen;
    fs.writeFileSync = originalWrite;
  }
  assert.strictEqual(injected, true);
}

test('init writes one canonical pointer atomically', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const result = sprint.initActiveSprint({
    cwd: root,
    plan,
    next: 'Confirm scope',
    now: '2026-07-24T00:00:00.000Z',
  });
  assert.strictEqual(result.action, 'init');
  assert.deepStrictEqual(raw(root), {
    version: 1,
    plan,
    phase: 'think',
    status: 'active',
    updated_at: '2026-07-24T00:00:00.000Z',
    next: 'Confirm scope',
  });
  const names = fs.readdirSync(path.dirname(path.join(root, sprint.POINTER_RELATIVE_PATH)));
  assert(!names.some((name) => name.includes('.tmp-') || name.endsWith('.lock')));
}));

test('init refuses to replace an active pointer', () => withWorkspace((root) => {
  const first = writePlan(root, 'first.md');
  const second = writePlan(root, 'second.md');
  init(root, first);
  const before = fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8');
  expectCode(() => init(root, second), 'SPRINT_ALREADY_ACTIVE');
  assert.strictEqual(fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'), before);
}));

test('init requires a bounded regular plan', () => withWorkspace((root) => {
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan: 'docs/plans/missing.md', next: 'Nope' }),
    'INVALID_SPRINT_PLAN'
  );
  fs.writeFileSync(path.join(root, 'outside.md'), '# outside\n');
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan: 'outside.md', next: 'Nope' }),
    'INVALID_SPRINT_PLAN'
  );
}));

test('advance accepts the canonical adjacent sequence', () => withWorkspace((root) => {
  init(root);
  reach(root, 'compound');
  assert.strictEqual(raw(root).phase, 'compound');
  assert.strictEqual(raw(root).status, 'active');
}));

test('review may return to work for remediation', () => withWorkspace((root) => {
  init(root);
  reach(root, 'review');
  sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'review',
    toPhase: 'work',
    next: 'Fix P1',
  });
  assert.strictEqual(raw(root).phase, 'work');
}));

test('non-adjacent transitions fail without mutation', () => withWorkspace((root) => {
  init(root);
  const before = fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8');
  expectCode(() => sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    toPhase: 'work',
    next: 'Skip plan',
  }), 'ILLEGAL_SPRINT_TRANSITION');
  assert.strictEqual(fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'), before);
}));

test('unknown phases fail closed', () => withWorkspace((root) => {
  init(root);
  expectCode(() => sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    toPhase: 'unknown',
    next: 'Unknown',
  }), 'INVALID_SPRINT_PHASE');
}));

test('expected-current-phase CAS rejects stale writers', () => withWorkspace((root) => {
  init(root);
  sprint.advanceActiveSprint({ cwd: root, expectedPhase: 'think', toPhase: 'plan', next: 'Plan' });
  expectCode(() => sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    toPhase: 'plan',
    next: 'Stale',
  }), 'SPRINT_PHASE_CONFLICT');
  assert.strictEqual(raw(root).next, 'Plan');
}));

test('block holds phase and advance clears blocked state', () => withWorkspace((root) => {
  init(root);
  sprint.blockActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    reason: 'Waiting for contract',
    next: 'Ask owner',
    now: '2026-07-24T01:00:00.000Z',
  });
  assert.strictEqual(raw(root).phase, 'think');
  assert.strictEqual(raw(root).status, 'blocked');
  assert.strictEqual(raw(root).block_reason, 'Waiting for contract');
  sprint.advanceActiveSprint({ cwd: root, expectedPhase: 'think', toPhase: 'plan', next: 'Continue' });
  assert.strictEqual(raw(root).status, 'active');
  assert.strictEqual(raw(root).block_reason, undefined);
}));

test('block uses expected-phase CAS', () => withWorkspace((root) => {
  init(root);
  sprint.advanceActiveSprint({ cwd: root, expectedPhase: 'think', toPhase: 'plan', next: 'Plan' });
  expectCode(() => sprint.blockActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    reason: 'Stale',
    next: 'Wait',
  }), 'SPRINT_PHASE_CONFLICT');
  assert.strictEqual(raw(root).status, 'active');
}));

test('complete requires compound and clears pointer', () => withWorkspace((root) => {
  init(root);
  expectCode(
    () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'think' }),
    'ILLEGAL_SPRINT_COMPLETION'
  );
  reach(root, 'compound');
  const result = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
  assert.strictEqual(result.action, 'complete');
  assert.strictEqual(sprint.readActiveSprintPointer(root).reason, 'missing-pointer');
}));

test('complete CAS rejects stale expected phase', () => withWorkspace((root) => {
  init(root);
  sprint.advanceActiveSprint({ cwd: root, expectedPhase: 'think', toPhase: 'plan', next: 'Plan' });
  expectCode(
    () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'think' }),
    'SPRINT_PHASE_CONFLICT'
  );
  assert.strictEqual(raw(root).phase, 'plan');
}));


test('lock acquisition failure removes the lock it created', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    const error = new Error('simulated fsync failure');
    error.code = 'EIO';
    throw error;
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
      'EIO'
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.strictEqual(fs.existsSync(path.join(root, sprint.LOCK_RELATIVE_PATH)), false);
  assert.strictEqual(sprint.readActiveSprintPointer(root).reason, 'missing-pointer');
}));
test('state lock collision fails closed', () => withWorkspace((root) => {
  init(root);
  const lockPath = path.join(root, sprint.LOCK_RELATIVE_PATH);
  fs.writeFileSync(lockPath, 'another writer');
  expectCode(() => sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    toPhase: 'plan',
    next: 'Plan',
  }), 'SPRINT_STATE_LOCKED');
  assert.strictEqual(raw(root).phase, 'think');
}));

test('state text fields reject controls and oversize values', () => withWorkspace((root) => {
  const plan = writePlan(root);
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'bad\nnext' }),
    'INVALID_SPRINT_TEXT'
  );
  init(root, plan);
  expectCode(() => sprint.blockActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    reason: 'x'.repeat(501),
    next: 'Wait',
  }), 'INVALID_SPRINT_TEXT');
}));


test('init restore-phase can rebuild a missing pointer from validated handoff state', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const result = sprint.initActiveSprint({
    cwd: root,
    plan,
    restorePhase: 'work',
    next: 'Resume focused test',
  });
  assert.strictEqual(result.pointer.phase, 'work');
}));

test('init restore-phase rejects unknown phases', () => withWorkspace((root) => {
  const plan = writePlan(root);
  expectCode(() => sprint.initActiveSprint({
    cwd: root, plan, restorePhase: 'unknown', next: 'Resume',
  }), 'INVALID_SPRINT_PHASE');
}));

test('CLI status validates that the target plan still exists', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  fs.unlinkSync(path.join(root, plan));
  const status = spawnSync(process.execPath, [cliPath, 'status'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(status.status, 0, status.stderr);
  assert.strictEqual(JSON.parse(status.stdout).reason, 'missing-plan');
}));

test('CLI status reports completed-plan for explicit cleanup routing', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  fs.writeFileSync(path.join(root, plan), '---\nstatus: completed\n---\n# Done\n');
  const status = spawnSync(process.execPath, [cliPath, 'status'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(status.status, 0, status.stderr);
  assert.strictEqual(JSON.parse(status.stdout).reason, 'completed-plan');
  assert.strictEqual(JSON.parse(status.stdout).phase, 'think');
}));

test('completed compound plan can be explicitly cleared through the CLI', () => withWorkspace((root) => {
  const plan = writePlan(root);
  sprint.initActiveSprint({ cwd: root, plan, restorePhase: 'compound', next: 'Audit completion' });
  fs.writeFileSync(path.join(root, plan), '---\nstatus: completed\n---\n# Done\n');
  const status = spawnSync(process.execPath, [cliPath, 'status'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(status.stdout).phase, 'compound');
  const cleared = spawnSync(process.execPath, [
    cliPath, 'complete', '--expected', 'compound',
  ], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(cleared.status, 0, cleared.stderr);
  assert.strictEqual(sprint.readActiveSprintPointer(root).reason, 'missing-pointer');
}));
test('CLI exposes mechanical commands and JSON status', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const created = spawnSync(process.execPath, [
    cliPath, 'init', '--plan', plan, '--next', 'Think',
  ], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(created.status, 0, created.stderr);
  assert.strictEqual(JSON.parse(created.stdout).pointer.phase, 'think');
  const moved = spawnSync(process.execPath, [
    cliPath, 'advance', '--expected', 'think', '--to', 'plan', '--next', 'Plan',
  ], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(moved.status, 0, moved.stderr);
  const stale = spawnSync(process.execPath, [
    cliPath, 'block', '--expected', 'think', '--reason', 'stale', '--next', 'wait',
  ], { cwd: root, encoding: 'utf8' });
  assert.notStrictEqual(stale.status, 0);
  assert.match(stale.stderr, /SPRINT_PHASE_CONFLICT/);
  const status = spawnSync(process.execPath, [cliPath, 'status'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(status.status, 0, status.stderr);
  assert.strictEqual(JSON.parse(status.stdout).phase, 'plan');
}));

test('pointer schema rejects malformed required and conditional fields', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const malformed = [
    (pointer) => { pointer.status = 'paused'; },
    (pointer) => { delete pointer.next; },
    (pointer) => { pointer.next = 'bad\nnext'; },
    (pointer) => { pointer.updated_at = 'not-an-iso-timestamp'; },
    (pointer) => { pointer.status = 'blocked'; },
    (pointer) => { pointer.block_reason = 'not allowed while active'; },
    (pointer) => { pointer.unexpected = true; },
  ];
  for (const mutate of malformed) {
    const pointer = pointerFor(plan, 'think');
    mutate(pointer);
    fs.writeFileSync(pointerPath, `${JSON.stringify(pointer)}\n`);
    assert.strictEqual(sprint.readActiveSprintPointer(root).reason, 'invalid-pointer-schema');
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'invalid-pointer-schema');
  }
  const blocked = pointerFor(plan, 'think', 'Wait');
  blocked.status = 'blocked';
  blocked.block_reason = 'Waiting for owner';
  fs.writeFileSync(pointerPath, `${JSON.stringify(blocked)}\n`);
  assert.strictEqual(sprint.readActiveSprintPointer(root).status, 'blocked');
}));

test('completion unlink failure exposes recovery-required and retry closes it', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  reach(root, 'compound');
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && /active-sprint\.claim-/.test(String(target))) {
      injected = true;
      const error = new Error('simulated claim unlink failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    expectCode(
      () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.strictEqual(sprint.readActiveSprintPointer(root).reason, 'missing-pointer');
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  const recoveryStatus = spawnSync(process.execPath, [cliPath, 'status'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.strictEqual(recoveryStatus.status, 0, recoveryStatus.stderr);
  assert.strictEqual(JSON.parse(recoveryStatus.stdout).reason, 'sprint-recovery-required');
  const retried = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
  assert.strictEqual(retried.recovered, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
  const completedStatus = spawnSync(process.execPath, [cliPath, 'status'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.strictEqual(completedStatus.status, 0, completedStatus.stderr);
  assert.strictEqual(JSON.parse(completedStatus.stdout).reason, 'completed-sprint');
}));

test('dual transaction markers with different inode or bytes fail closed', () => {
  for (const releaseRaw of ['{}\n', '{"different":true}\n']) {
    withWorkspace((root) => {
      const plan = writePlan(root);
      init(root, plan);
      reach(root, 'compound');
      const transactionPath = path.join(
        root,
        'docs',
        'plans',
        '.handoff',
        'active-sprint.transaction.json'
      );
      const releasePath = `${transactionPath}.release.tmp`;
      fs.writeFileSync(transactionPath, '{}\n');
      fs.writeFileSync(releasePath, releaseRaw);
      const transactionStat = fs.lstatSync(transactionPath);
      const releaseStat = fs.lstatSync(releasePath);
      assert.notStrictEqual(
        `${transactionStat.dev}:${transactionStat.ino}`,
        `${releaseStat.dev}:${releaseStat.ino}`
      );
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
      expectCode(
        () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
        'SPRINT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), '{}\n');
      assert.strictEqual(fs.readFileSync(releasePath, 'utf8'), releaseRaw);
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
    });
  }
});

test('completion fsync failure after unlink remains recoverable and retry closes it', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  reach(root, 'compound');
  const originalUnlink = fs.unlinkSync;
  const originalFsync = fs.fsyncSync;
  let claimRemoved = false;
  let injected = false;
  fs.unlinkSync = (target) => {
    const result = originalUnlink(target);
    if (/active-sprint\.claim-/.test(String(target))) claimRemoved = true;
    return result;
  };
  fs.fsyncSync = (handle) => {
    if (claimRemoved && !injected) {
      injected = true;
      claimRemoved = false;
      const error = new Error('simulated directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync(handle);
  };
  try {
    expectCode(
      () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.unlinkSync = originalUnlink;
    fs.fsyncSync = originalFsync;
  }
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  const retried = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
  assert.strictEqual(retried.recovered, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
  const nextPlan = writePlan(root, 'next.md');
  sprint.initActiveSprint({ cwd: root, plan: nextPlan, next: 'Think' });
  assert.strictEqual(sprint.readActiveSprint(root).plan, nextPlan);
}));

test('status reports recovery before a valid canonical pointer when transaction is pending', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    if (!injected && source === pointerPath && /active-sprint\.claim-/.test(String(target))) {
      injected = true;
      const error = new Error('simulated pre-claim interruption');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(source, target);
  };
  try {
    expectCode(() => sprint.advanceActiveSprint({
      cwd: root,
      expectedPhase: 'think',
      toPhase: 'plan',
      next: 'Plan',
    }), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(sprint.readActiveSprintPointer(root).active, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  const status = spawnSync(process.execPath, [cliPath, 'status'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(status.status, 0, status.stderr);
  assert.strictEqual(JSON.parse(status.stdout).reason, 'sprint-recovery-required');
  const transactionPath = path.join(
    root,
    'docs',
    'plans',
    '.handoff',
    'active-sprint.transaction.json'
  );
  fs.renameSync(transactionPath, `${transactionPath}.release.tmp`);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    toPhase: 'plan',
    next: 'Plan after recovery',
  });
  assert.strictEqual(sprint.readActiveSprint(root).phase, 'plan');
}));

test('status reports recovery before canonical pointer when transaction is corrupt', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    if (!injected && source === pointerPath && /active-sprint\.claim-/.test(String(target))) {
      injected = true;
      const error = new Error('simulated pre-claim interruption');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(source, target);
  };
  try {
    expectCode(() => sprint.advanceActiveSprint({
      cwd: root,
      expectedPhase: 'think',
      toPhase: 'plan',
      next: 'Plan',
    }), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.renameSync = originalRename;
  }
  fs.writeFileSync(
    path.join(root, 'docs', 'plans', '.handoff', 'active-sprint.transaction.json'),
    '{corrupt\n'
  );
  assert.strictEqual(sprint.readActiveSprintPointer(root).active, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  expectCode(() => sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    toPhase: 'plan',
    next: 'Must not hide corruption',
  }), 'SPRINT_RECOVERY_REQUIRED');
}));
test('init publish candidate open failure aborts safely and permits retry', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const stateDirectory = path.dirname(transactionPath);
  leaveUnpublishedInitTransaction(root, plan);
  assert.strictEqual(sprint.readActiveSprintPointer(root).reason, 'missing-pointer');
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  assert.strictEqual(fs.existsSync(transactionPath), true);
  assert.strictEqual(
    fs.readdirSync(stateDirectory).some((name) => name.startsWith('active-sprint.publish-')),
    false
  );
  const retried = sprint.initActiveSprint({ cwd: root, plan, next: 'Think' });
  assert.strictEqual(retried.action, 'init');
  assert.strictEqual(sprint.readActiveSprint(root).active, true);
  assert.strictEqual(sprint.readActiveSprint(root).plan, plan);
  assert.strictEqual(fs.existsSync(transactionPath), false);
}));

test('init publish candidate fsync failure is recovered on retry', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const stateDirectory = path.dirname(transactionPath);
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  let publishHandle;
  let injected = false;
  fs.openSync = (target, ...args) => {
    const handle = originalOpen(target, ...args);
    if (/active-sprint\.publish-/.test(String(target))) publishHandle = handle;
    return handle;
  };
  fs.fsyncSync = (handle) => {
    if (!injected && handle === publishHandle) {
      injected = true;
      const error = new Error('simulated publish candidate fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync(handle);
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
  }
  assert.strictEqual(injected, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  assert.strictEqual(
    fs.readdirSync(stateDirectory).some((name) => name.startsWith('active-sprint.publish-')),
    true
  );
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    'SPRINT_ALREADY_ACTIVE'
  );
  const recovered = sprint.readActiveSprint(root);
  assert.strictEqual(recovered.active, true);
  assert.strictEqual(recovered.plan, plan);
  assert.strictEqual(recovered.phase, 'think');
  assert.strictEqual(fs.existsSync(transactionPath), false);
  assert.strictEqual(
    fs.readdirSync(stateDirectory).some((name) => name.startsWith('active-sprint.publish-')),
    false
  );
}));

test('init publish candidate close failure is recovered on retry', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let publishHandle;
  let injected = false;
  fs.openSync = (target, ...args) => {
    const handle = originalOpen(target, ...args);
    if (/active-sprint\.publish-/.test(String(target))) publishHandle = handle;
    return handle;
  };
  fs.closeSync = (handle) => {
    const result = originalClose(handle);
    if (!injected && handle === publishHandle) {
      injected = true;
      const error = new Error('simulated publish candidate close failure');
      error.code = 'EIO';
      throw error;
    }
    return result;
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }
  assert.strictEqual(injected, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    'SPRINT_ALREADY_ACTIVE'
  );
  assert.strictEqual(sprint.readActiveSprint(root).active, true);
}));

test('unknown token candidate is preserved and remains fail-closed', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  leaveUnpublishedInitTransaction(root, plan);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const publishPath = path.join(path.dirname(transactionPath), transaction.publish);
  const unknown = 'external-unknown-candidate\n';
  fs.writeFileSync(publishPath, unknown);
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.readFileSync(publishPath, 'utf8'), unknown);
  assert.strictEqual(fs.existsSync(transactionPath), true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

test('partial init recovery preserves external canonical successor and evidence', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const successorPlan = writePlan(root, 'partial-successor.md');
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  leavePartialInitTransaction(root, plan, 'ENOSPC');
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const partialPath = path.join(path.dirname(transactionPath), transaction.partial);
  const successorRaw = `${JSON.stringify(pointerFor(successorPlan, 'review', 'External successor'))}\n`;
  fs.writeFileSync(pointerPath, successorRaw);
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), successorRaw);
  assert.strictEqual(fs.existsSync(transactionPath), true);
  assert.strictEqual(fs.existsSync(partialPath), true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

test('legacy v1 init transaction with valid candidate keeps prior recovery semantics', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  leaveUnpublishedInitTransaction(root, plan);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const replacementRaw = transaction.replacement_raw;
  const publishPath = path.join(path.dirname(transactionPath), transaction.publish);
  delete transaction.partial;
  delete transaction.replacement_raw;
  transaction.version = 1;
  fs.writeFileSync(transactionPath, `${JSON.stringify(transaction)}\n`);
  fs.writeFileSync(publishPath, replacementRaw);
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    'SPRINT_ALREADY_ACTIVE'
  );
  const recovered = sprint.readActiveSprint(root);
  assert.strictEqual(recovered.active, true);
  assert.strictEqual(recovered.plan, plan);
  assert.strictEqual(fs.existsSync(transactionPath), false);
  assert.strictEqual(fs.existsSync(publishPath), false);
}));

test('legacy v1 mismatched candidate remains fail-closed and preserved', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  leaveUnpublishedInitTransaction(root, plan);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const publishPath = path.join(path.dirname(transactionPath), transaction.publish);
  delete transaction.partial;
  delete transaction.replacement_raw;
  transaction.version = 1;
  fs.writeFileSync(transactionPath, `${JSON.stringify(transaction)}\n`);
  fs.writeFileSync(publishPath, 'legacy-unknown-candidate\n');
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.readFileSync(publishPath, 'utf8'), 'legacy-unknown-candidate\n');
  assert.strictEqual(fs.existsSync(transactionPath), true);
}));

test('v3 transaction payload proof rejects field, hash, and size drift', () => {
  for (const mode of ['field', 'hash', 'size']) {
    withWorkspace((root) => {
      const plan = writePlan(root);
      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      leaveUnpublishedInitTransaction(root, plan);
      const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
      if (mode === 'field') transaction.unknown = true;
      if (mode === 'hash') transaction.replacement_raw = `${transaction.replacement_raw} `;
      const rawValue = mode === 'size'
        ? `${JSON.stringify(transaction)}${'x'.repeat(40 * 1024)}\n`
        : `${JSON.stringify(transaction)}\n`;
      fs.writeFileSync(transactionPath, rawValue);
      expectCode(
        () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
        'SPRINT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
    });
  }
});

const privateClaim = sprint.__privateClaimTesting;

function slash(value) {
  return String(value).replace(/\\/g, '/');
}

function privateDeleteFixture(root, token = '11111111111111111111111111111111') {
  const paths = privateClaim.ensureStateDirectory(root);
  const sourcePath = path.join(paths.stateDirectory, `active-sprint.completed-${token}.tmp`);
  const bytes = Buffer.from('owned completion stage\n');
  fs.writeFileSync(sourcePath, bytes);
  const snapshot = privateClaim.readStableRecoverySnapshot(sourcePath);
  const slotPath = path.join(
    paths.stateDirectory,
    privateClaim.claimSlotName(token, 'completion-stage')
  );
  return { paths, token, sourcePath, bytes, snapshot, slotPath };
}

function claimPrivateDeleteFixture(fixture) {
  return privateClaim.createPrivateClaim(fixture.paths, {
    scopeToken: fixture.token,
    artifact: 'completion-stage',
    sourcePath: fixture.sourcePath,
    snapshot: fixture.snapshot,
  });
}

function removePrivateDeleteFixture(fixture) {
  return privateClaim.removeVerifiedRecoveryFile(
    fixture.sourcePath,
    privateClaim.sha256(fixture.bytes),
    fixture.paths.stateDirectory,
    {
      sync: true,
      scopeToken: fixture.token,
      artifact: 'completion-stage',
    }
  );
}

test('private claim helper writes a 0700 slot and canonical immutable intent', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root);
  const claim = claimPrivateDeleteFixture(fixture);
  assert.strictEqual(fs.existsSync(fixture.sourcePath), false);
  assert.strictEqual(fs.readFileSync(claim.valuePath, 'utf8'), fixture.bytes.toString('utf8'));
  const intentRaw = fs.readFileSync(claim.intentPath, 'utf8');
  const intent = JSON.parse(intentRaw);
  assert.strictEqual(`${JSON.stringify(intent)}\n`, intentRaw);
  assert.strictEqual(intent.parent, '.handoff');
  assert.strictEqual(intent.source, path.basename(fixture.sourcePath));
  assert.strictEqual(intent.sha256, privateClaim.sha256(fixture.bytes));
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.lstatSync(claim.slotPath).mode & 0o777, 0o700);
    assert.strictEqual(fs.lstatSync(claim.intentPath).mode & 0o777, 0o600);
  }
  privateClaim.deletePrivateClaimValue(fixture.paths, claim, { sync: true });
  assert.strictEqual(fs.existsSync(claim.slotPath), false);
}));

test('private delete intent-only state cleans metadata and retries the source claim', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '22222222222222222222222222222222');
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    if (!injected && source === fixture.sourcePath && slash(target).endsWith('-completion-stage/value')) {
      injected = true;
      const error = new Error('simulated pre-claim rename failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(source, target);
  };
  try {
    expectCode(() => claimPrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(injected, true);
  assert.strictEqual(fs.existsSync(fixture.sourcePath), true);
  assert.deepStrictEqual(fs.readdirSync(fixture.slotPath), ['intent.json']);
  assert.strictEqual(removePrivateDeleteFixture(fixture), true);
  assert.strictEqual(fs.existsSync(fixture.sourcePath), false);
  assert.strictEqual(fs.existsSync(fixture.slotPath), false);
}));

test('private delete claimed state survives value unlink failure and converges', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '33333333333333333333333333333333');
  const claim = claimPrivateDeleteFixture(fixture);
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && path.resolve(target) === path.resolve(claim.valuePath)) {
      injected = true;
      const error = new Error('simulated private value delete failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    expectCode(
      () => privateClaim.deletePrivateClaimValue(fixture.paths, claim, { sync: true }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.strictEqual(fs.existsSync(claim.valuePath), true);
  assert.strictEqual(removePrivateDeleteFixture(fixture), true);
  assert.strictEqual(fs.existsSync(claim.slotPath), false);
}));

test('private delete intent metadata failure is retryable after value deletion', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '44444444444444444444444444444444');
  const claim = claimPrivateDeleteFixture(fixture);
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && path.resolve(target) === path.resolve(claim.intentPath)) {
      injected = true;
      const error = new Error('simulated intent metadata failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    expectCode(
      () => privateClaim.deletePrivateClaimValue(fixture.paths, claim, { sync: true }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.strictEqual(fs.existsSync(claim.valuePath), false);
  assert.strictEqual(fs.existsSync(claim.intentPath), true);
  assert.strictEqual(removePrivateDeleteFixture(fixture), true);
  assert.strictEqual(fs.existsSync(claim.slotPath), false);
}));

test('private delete empty-slot metadata failure is retryable after intent deletion', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '55555555555555555555555555555555');
  const claim = claimPrivateDeleteFixture(fixture);
  const originalRmdir = fs.rmdirSync;
  let injected = false;
  fs.rmdirSync = (target, ...args) => {
    if (!injected && path.resolve(target) === path.resolve(claim.slotPath)) {
      injected = true;
      const error = new Error('simulated slot metadata failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRmdir(target, ...args);
  };
  try {
    expectCode(
      () => privateClaim.deletePrivateClaimValue(fixture.paths, claim, { sync: true }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.rmdirSync = originalRmdir;
  }
  assert.deepStrictEqual(fs.readdirSync(claim.slotPath), []);
  assert.strictEqual(removePrivateDeleteFixture(fixture), false);
  assert.strictEqual(fs.existsSync(claim.slotPath), false);
}));

test('private delete preserves a source successor and keeps recovery visible', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '66666666666666666666666666666666');
  const claim = claimPrivateDeleteFixture(fixture);
  const successor = 'external source successor\n';
  fs.writeFileSync(fixture.sourcePath, successor);
  expectCode(
    () => privateClaim.deletePrivateClaimValue(fixture.paths, claim, { sync: true }),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.readFileSync(fixture.sourcePath, 'utf8'), successor);
  assert.strictEqual(fs.existsSync(claim.valuePath), false);
  assert.strictEqual(fs.existsSync(claim.intentPath), true);
  expectCode(() => removePrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

test('private slot collision fails before rename on every platform', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '77777777777777777777777777777777');
  fs.mkdirSync(fixture.slotPath, { mode: 0o700 });
  fs.writeFileSync(path.join(fixture.slotPath, 'value'), 'collision evidence\n');
  const originalRename = fs.renameSync;
  let renamed = false;
  fs.renameSync = (...args) => {
    renamed = true;
    return originalRename(...args);
  };
  try {
    expectCode(() => claimPrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(renamed, false);
  assert.strictEqual(fs.readFileSync(fixture.sourcePath, 'utf8'), fixture.bytes.toString('utf8'));
  assert.strictEqual(fs.readFileSync(path.join(fixture.slotPath, 'value'), 'utf8'), 'collision evidence\n');
}));

test('private claim unknown entry and mutated intent fail closed', () => {
  for (const mode of ['unknown-entry', 'intent-parent']) {
    withWorkspace((root) => {
      const token = mode === 'unknown-entry'
        ? '88888888888888888888888888888888'
        : '99999999999999999999999999999999';
      const fixture = privateDeleteFixture(root, token);
      const claim = claimPrivateDeleteFixture(fixture);
      if (mode === 'unknown-entry') {
        fs.writeFileSync(path.join(claim.slotPath, 'intruder'), 'external\n');
      } else {
        const intent = JSON.parse(fs.readFileSync(claim.intentPath, 'utf8'));
        intent.parent_dev = String(BigInt(intent.parent_dev) + 1n);
        fs.writeFileSync(claim.intentPath, `${JSON.stringify(intent)}\n`);
      }
      expectCode(
        () => privateClaim.readPrivateClaimSlot(fixture.paths, token, 'completion-stage'),
        'SPRINT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.existsSync(claim.valuePath), true);
    });
  }
});

test('private claim slot symlink is rejected without following it', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const outside = path.join(root, 'outside-claim');
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, fixture.slotPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
    throw error;
  }
  expectCode(() => claimPrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
  expectCode(
    () => privateClaim.readPrivateClaimSlot(
      fixture.paths,
      fixture.token,
      'completion-stage',
      { allowMissing: false }
    ),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.existsSync(fixture.sourcePath), true);
}));

test('private restore rechecks canonical source around value release', () => withWorkspace((root) => {
  const paths = privateClaim.ensureStateDirectory(root);
  const token = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const sourcePath = path.join(paths.stateDirectory, 'active-sprint.json');
  fs.writeFileSync(sourcePath, 'owned pointer\n');
  const snapshot = privateClaim.readStableRecoverySnapshot(sourcePath);
  const claim = privateClaim.createPrivateClaim(paths, {
    scopeToken: token,
    artifact: 'pointer',
    sourcePath,
    snapshot,
  });
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && path.resolve(target) === path.resolve(claim.valuePath)) {
      injected = true;
      originalUnlink(sourcePath);
      fs.writeFileSync(sourcePath, 'restore successor\n');
    }
    return originalUnlink(target);
  };
  try {
    expectCode(
      () => privateClaim.restorePrivateClaim(paths, claim, sourcePath),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.strictEqual(fs.readFileSync(sourcePath, 'utf8'), 'restore successor\n');
  assert.strictEqual(fs.existsSync(claim.intentPath), true);
}));

test('pointer-only startup never scans private claims but full status does', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  const stateDirectory = path.dirname(path.join(root, sprint.POINTER_RELATIVE_PATH));
  const slotPath = path.join(
    stateDirectory,
    'active-sprint.claim-cccccccccccccccccccccccccccccccc-transaction'
  );
  fs.mkdirSync(slotPath, { mode: 0o700 });
  fs.writeFileSync(path.join(slotPath, 'intruder'), 'corrupt evidence\n');
  const originalReaddir = fs.readdirSync;
  fs.readdirSync = (target, ...args) => {
    if (path.resolve(target) === path.resolve(stateDirectory)) {
      throw new Error('pointer-only path must not scan state directory');
    }
    return originalReaddir(target, ...args);
  };
  try {
    assert.strictEqual(sprint.readActiveSprintPointer(root).active, true);
  } finally {
    fs.readdirSync = originalReaddir;
  }
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

test('ordinary pointer claim preserves a successor and requires recovery', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const externalPlan = writePlan(root, 'external-pointer.md');
  init(root, plan);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const successor = `${JSON.stringify(pointerFor(externalPlan, 'review', 'External successor'))}\n`;
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    const result = originalRename(source, target);
    if (!injected && source === pointerPath && slash(target).endsWith('-pointer/value')) {
      injected = true;
      fs.writeFileSync(pointerPath, successor);
    }
    return result;
  };
  try {
    expectCode(() => sprint.advanceActiveSprint({
      cwd: root,
      expectedPhase: 'think',
      toPhase: 'plan',
      next: 'Plan',
    }), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), successor);
  assert.strictEqual(sprint.readActiveSprintPointer(root).plan, externalPlan);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

test('exclusive publish successor remains visible with pointer claim evidence', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const externalPlan = writePlan(root, 'exclusive-successor.md');
  init(root, plan);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const successor = `${JSON.stringify(pointerFor(externalPlan, 'work', 'External successor'))}\n`;
  const originalLink = fs.linkSync;
  let injected = false;
  fs.linkSync = (source, target) => {
    if (!injected && target === pointerPath && /active-sprint\.publish-/.test(String(source))) {
      injected = true;
      fs.writeFileSync(pointerPath, successor);
    }
    return originalLink(source, target);
  };
  try {
    expectCode(() => sprint.advanceActiveSprint({
      cwd: root,
      expectedPhase: 'think',
      toPhase: 'plan',
      next: 'Plan',
    }), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.linkSync = originalLink;
  }
  assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), successor);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

test('completion private claim preserves a concurrent pointer successor', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const successorPlan = writePlan(root, 'completion-successor.md');
  init(root, plan);
  reach(root, 'compound');
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const successor = `${JSON.stringify(pointerFor(successorPlan, 'think', 'Next sprint'))}\n`;
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    const result = originalRename(source, target);
    if (!injected && source === pointerPath && slash(target).endsWith('-pointer/value')) {
      injected = true;
      fs.writeFileSync(pointerPath, successor);
    }
    return result;
  };
  try {
    expectCode(
      () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), successor);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

test('transaction private value delete failure is recovered on completion retry', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  reach(root, 'compound');
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && slash(target).endsWith('-transaction/value')) {
      injected = true;
      const error = new Error('simulated transaction private value failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    expectCode(
      () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  const retried = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
  assert.strictEqual(retried.recovered, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
}));

test('transaction private intent delete failure is recovered on completion retry', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  reach(root, 'compound');
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && slash(target).endsWith('-transaction/intent.json')) {
      injected = true;
      const error = new Error('simulated transaction intent failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    expectCode(
      () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  const retried = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
  assert.strictEqual(retried.alreadyCompleted, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
}));

test('legacy transaction release hard link converges through private delete adapter', () => withWorkspace((root) => {
  const plan = writePlan(root);
  leaveUnpublishedInitTransaction(root, plan);
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const releasePath = `${transactionPath}.release.tmp`;
  fs.linkSync(transactionPath, releasePath);
  const result = sprint.initActiveSprint({ cwd: root, plan, next: 'Think' });
  assert.strictEqual(result.action, 'init');
  assert.strictEqual(fs.existsSync(releasePath), false);
  assert.strictEqual(sprint.readActiveSprint(root).active, true);
}));

test('legacy transaction release private delete failure is retryable', () => withWorkspace((root) => {
  const plan = writePlan(root);
  leaveUnpublishedInitTransaction(root, plan);
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const releasePath = `${transactionPath}.release.tmp`;
  fs.linkSync(transactionPath, releasePath);
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && slash(target).endsWith('-transaction-release/value')) {
      injected = true;
      const error = new Error('simulated legacy release private delete failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  const result = sprint.initActiveSprint({ cwd: root, plan, next: 'Think' });
  assert.strictEqual(result.action, 'init');
}));

test('v3 partial candidate uses a private hold slot and retries cleanly', () => withWorkspace((root) => {
  const plan = writePlan(root);
  leavePartialInitTransaction(root, plan, 'ENOSPC');
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const partialPath = path.join(path.dirname(transactionPath), ...transaction.partial.split('/'));
  const replacement = Buffer.from(transaction.replacement_raw, 'utf8');
  const partial = fs.readFileSync(partialPath);
  assert.strictEqual(transaction.version, 3);
  assert(slash(transaction.partial).endsWith('-partial/value'));
  assert(partial.length > 0 && partial.length < replacement.length);
  assert(partial.equals(replacement.subarray(0, partial.length)));
  const result = sprint.initActiveSprint({ cwd: root, plan, next: 'Think' });
  assert.strictEqual(result.action, 'init');
  assert.strictEqual(fs.existsSync(path.dirname(partialPath)), false);
}));

test('v3 partial private value delete failure is fail-closed and retryable', () => withWorkspace((root) => {
  const plan = writePlan(root);
  leavePartialInitTransaction(root, plan, 'EIO');
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && slash(target).endsWith('-partial/value')) {
      injected = true;
      const error = new Error('simulated partial private value failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  assert.strictEqual(
    sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }).action,
    'init'
  );
}));

test('v3 partial source successor is preserved with evidence', () => withWorkspace((root) => {
  const plan = writePlan(root);
  leavePartialInitTransaction(root, plan, 'ENOSPC');
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const publishPath = path.join(path.dirname(transactionPath), transaction.publish);
  const successor = 'external publish successor\n';
  fs.writeFileSync(publishPath, successor);
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.readFileSync(publishPath, 'utf8'), successor);
  const partialPath = path.join(path.dirname(transactionPath), ...transaction.partial.split('/'));
  assert.strictEqual(fs.existsSync(partialPath), true);
}));

function emptyV3PartialFixture(root, name) {
  const plan = writePlan(root, name);
  leavePartialInitTransaction(root, plan, 'ENOSPC');
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const stateDirectory = path.dirname(transactionPath);
  const publishPath = path.join(stateDirectory, transaction.publish);
  const partialPath = path.join(stateDirectory, ...transaction.partial.split('/'));
  const slotPath = path.dirname(partialPath);
  const intentPath = path.join(slotPath, 'intent.json');
  const prefix = fs.readFileSync(partialPath);
  fs.unlinkSync(partialPath);
  fs.unlinkSync(intentPath);
  assert.deepStrictEqual(fs.readdirSync(slotPath), []);
  return {
    plan,
    transaction,
    transactionPath,
    publishPath,
    partialPath,
    slotPath,
    prefix,
  };
}

test('v3 partial double fault converges from empty slot plus owned prefix', () => withWorkspace((root) => {
  const plan = writePlan(root, 'v3-partial-double-fault.md');
  const originalRename = fs.renameSync;
  let renameInjected = false;
  fs.renameSync = (source, target, ...args) => {
    if (!renameInjected
        && /active-sprint\.publish-/.test(String(source))
        && slash(target).endsWith('-partial/value')) {
      renameInjected = true;
      const error = new Error('simulated publish to partial claim rename failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(source, target, ...args);
  };
  try {
    leavePartialInitTransaction(root, plan, 'ENOSPC');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(renameInjected, true);

  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const stateDirectory = path.dirname(transactionPath);
  const publishPath = path.join(stateDirectory, transaction.publish);
  const partialPath = path.join(stateDirectory, ...transaction.partial.split('/'));
  const slotPath = path.dirname(partialPath);
  assert.strictEqual(fs.existsSync(publishPath), true);
  assert.strictEqual(fs.existsSync(partialPath), false);
  assert.strictEqual(fs.existsSync(path.join(slotPath, 'intent.json')), true);

  const originalRmdir = fs.rmdirSync;
  let rmdirInjected = false;
  fs.rmdirSync = (target, ...args) => {
    if (!rmdirInjected && path.resolve(target) === path.resolve(slotPath)) {
      rmdirInjected = true;
      const error = new Error('simulated partial slot metadata removal failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRmdir(target, ...args);
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.rmdirSync = originalRmdir;
  }
  assert.strictEqual(rmdirInjected, true);
  assert.deepStrictEqual(fs.readdirSync(slotPath), []);
  assert.strictEqual(fs.existsSync(publishPath), true);

  const result = sprint.initActiveSprint({ cwd: root, plan, next: 'Think' });
  assert.strictEqual(result.action, 'init');
  assert.strictEqual(fs.existsSync(slotPath), false);
  assert.strictEqual(fs.existsSync(publishPath), false);
  assert.strictEqual(sprint.readActiveSprint(root).active, true);
}));

test('v3 empty partial slot with missing publish aborts and permits init retry', () => withWorkspace((root) => {
  const fixture = emptyV3PartialFixture(root, 'v3-empty-partial-missing.md');
  assert.strictEqual(fs.existsSync(fixture.publishPath), false);
  const result = sprint.initActiveSprint({ cwd: root, plan: fixture.plan, next: 'Think' });
  assert.strictEqual(result.action, 'init');
  assert.strictEqual(fs.existsSync(fixture.slotPath), false);
}));

test('v3 empty partial slot with full publish finishes the interrupted init', () => withWorkspace((root) => {
  const fixture = emptyV3PartialFixture(root, 'v3-empty-partial-full.md');
  fs.writeFileSync(fixture.publishPath, fixture.transaction.replacement_raw);
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan: fixture.plan, next: 'Think' }),
    'SPRINT_ALREADY_ACTIVE'
  );
  assert.strictEqual(fs.existsSync(fixture.slotPath), false);
  assert.strictEqual(fs.existsSync(fixture.publishPath), false);
  assert.strictEqual(sprint.readActiveSprint(root).plan, fixture.plan);
}));

test('v3 empty partial slot preserves an unknown publish candidate fail closed', () => withWorkspace((root) => {
  const fixture = emptyV3PartialFixture(root, 'v3-empty-partial-unknown.md');
  const foreign = 'foreign partial publish candidate\n';
  fs.writeFileSync(fixture.publishPath, foreign);
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan: fixture.plan, next: 'Think' }),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.existsSync(fixture.slotPath), false);
  assert.strictEqual(fs.readFileSync(fixture.publishPath, 'utf8'), foreign);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

test('v3 empty partial slot preserves a source successor during re-claim', () => withWorkspace((root) => {
  const fixture = emptyV3PartialFixture(root, 'v3-empty-partial-successor.md');
  fs.writeFileSync(fixture.publishPath, fixture.prefix);
  const successor = 'external partial publish successor\n';
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target, ...args) => {
    const result = originalRename(source, target, ...args);
    if (!injected
        && path.resolve(source) === path.resolve(fixture.publishPath)
        && path.resolve(target) === path.resolve(fixture.partialPath)) {
      injected = true;
      fs.writeFileSync(source, successor);
    }
    return result;
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan: fixture.plan, next: 'Think' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(injected, true);
  assert.strictEqual(fs.readFileSync(fixture.publishPath, 'utf8'), successor);
  assert.strictEqual(fs.existsSync(fixture.partialPath), true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

test('lock private claim preserves a successor lock and reports recovery', () => withWorkspace((root) => {
  const plan = writePlan(root);
  const lockPath = path.join(root, sprint.LOCK_RELATIVE_PATH);
  const successor = 'external lock successor\n';
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    const result = originalRename(source, target);
    if (!injected && source === lockPath && slash(target).endsWith('-lock/value')) {
      injected = true;
      fs.writeFileSync(lockPath, successor);
    }
    return result;
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
      'SPRINT_LOCK_RELEASE_CONFLICT'
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), successor);
  assert.strictEqual(sprint.readActiveSprintPointer(root).active, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

function rewritePendingInitAsV2(root, mutate = () => {}) {
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  transaction.version = 2;
  transaction.partial = `active-sprint.publish-${transaction.token}.partial`;
  mutate(transaction, transactionPath);
  fs.writeFileSync(transactionPath, `${JSON.stringify(transaction)}\n`);
  return { transaction, transactionPath, stateDirectory: path.dirname(transactionPath) };
}

test('legal v2 init candidate keeps payload-proof recovery semantics', () => withWorkspace((root) => {
  const plan = writePlan(root);
  leaveUnpublishedInitTransaction(root, plan);
  const { transaction, stateDirectory } = rewritePendingInitAsV2(root);
  fs.writeFileSync(path.join(stateDirectory, transaction.publish), transaction.replacement_raw);
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    'SPRINT_ALREADY_ACTIVE'
  );
  assert.strictEqual(sprint.readActiveSprint(root).plan, plan);
}));

test('legal v2 partial prefix is privately deleted and retried', () => withWorkspace((root) => {
  const plan = writePlan(root);
  leaveUnpublishedInitTransaction(root, plan);
  const { transaction, stateDirectory } = rewritePendingInitAsV2(root);
  const partialPath = path.join(stateDirectory, transaction.partial);
  const replacement = Buffer.from(transaction.replacement_raw, 'utf8');
  fs.writeFileSync(partialPath, replacement.subarray(0, Math.floor(replacement.length / 3)));
  assert.strictEqual(
    sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }).action,
    'init'
  );
  assert.strictEqual(fs.existsSync(partialPath), false);
}));

test('v2 partial mismatch remains preserved and fail-closed', () => withWorkspace((root) => {
  const plan = writePlan(root);
  leaveUnpublishedInitTransaction(root, plan);
  const { transaction, stateDirectory } = rewritePendingInitAsV2(root);
  const partialPath = path.join(stateDirectory, transaction.partial);
  fs.writeFileSync(partialPath, 'foreign v2 partial\n');
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.readFileSync(partialPath, 'utf8'), 'foreign v2 partial\n');
}));

function legacyTransactionValue({ version, token, operation, expectedRaw, replacementRaw, plan, phase }) {
  const value = {
    version,
    token,
    operation,
    claim: operation === 'init' ? null : `active-sprint.claim-${token}.json`,
    publish: operation === 'complete' ? null : `active-sprint.publish-${token}.json`,
    expected_sha256: expectedRaw === null ? null : privateClaim.sha256(expectedRaw),
    replacement_sha256: replacementRaw === null ? null : privateClaim.sha256(replacementRaw),
    plan,
    phase,
    started_at: '2026-07-24T03:00:00.000Z',
    partial: operation === 'complete' ? null : `active-sprint.publish-${token}.partial`,
    replacement_raw: replacementRaw,
  };
  if (version === 1) {
    delete value.partial;
    delete value.replacement_raw;
  }
  return value;
}

test('legal v2 replace flat claim restores through the private adapter', () => withWorkspace((root) => {
  const plan = writePlan(root);
  init(root, plan);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const expectedRaw = fs.readFileSync(pointerPath, 'utf8');
  const replacementRaw = `${JSON.stringify(pointerFor(plan, 'plan', 'Plan'))}\n`;
  const token = 'dddddddddddddddddddddddddddddddd';
  const value = legacyTransactionValue({
    version: 2,
    token,
    operation: 'replace',
    expectedRaw,
    replacementRaw,
    plan,
    phase: 'plan',
  });
  const stateDirectory = path.dirname(pointerPath);
  fs.writeFileSync(path.join(root, sprint.TRANSACTION_RELATIVE_PATH), `${JSON.stringify(value)}\n`);
  fs.renameSync(pointerPath, path.join(stateDirectory, value.claim));
  fs.writeFileSync(path.join(stateDirectory, value.publish), replacementRaw);
  const result = sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    toPhase: 'plan',
    next: 'Plan',
  });
  assert.strictEqual(result.action, 'advance');
  assert.strictEqual(sprint.readActiveSprint(root).phase, 'plan');
}));

test('legal v1 and v2 complete flat claims finish through private adapters', () => {
  for (const version of [1, 2]) {
    withWorkspace((root) => {
      const plan = writePlan(root, `complete-v${version}.md`);
      init(root, plan);
      reach(root, 'compound');
      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const expectedRaw = fs.readFileSync(pointerPath, 'utf8');
      const token = version === 1
        ? 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
        : 'ffffffffffffffffffffffffffffffff';
      const value = legacyTransactionValue({
        version,
        token,
        operation: 'complete',
        expectedRaw,
        replacementRaw: null,
        plan,
        phase: 'compound',
      });
      const stateDirectory = path.dirname(pointerPath);
      fs.writeFileSync(path.join(root, sprint.TRANSACTION_RELATIVE_PATH), `${JSON.stringify(value)}\n`);
      fs.renameSync(pointerPath, path.join(stateDirectory, value.claim));
      const result = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
      assert.strictEqual(result.action, 'complete');
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
    });
  }
});
test('private claim value identity drift is preserved and rejected before delete', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '12121212121212121212121212121212');
  const claim = claimPrivateDeleteFixture(fixture);
  fs.unlinkSync(claim.valuePath);
  fs.writeFileSync(claim.valuePath, 'foreign replacement value\n');
  expectCode(
    () => privateClaim.deletePrivateClaimValue(fixture.paths, claim, { sync: true }),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.readFileSync(claim.valuePath, 'utf8'), 'foreign replacement value\n');
  assert.strictEqual(fs.existsSync(claim.intentPath), true);
}));

test('private claim intent and value symlinks are rejected without deletion', () => {
  for (const mode of ['intent', 'value']) {
    withWorkspace((root) => {
      const token = mode === 'intent'
        ? '13131313131313131313131313131313'
        : '14141414141414141414141414141414';
      const fixture = privateDeleteFixture(root, token);
      const claim = claimPrivateDeleteFixture(fixture);
      const targetPath = mode === 'intent' ? claim.intentPath : claim.valuePath;
      const outside = path.join(root, `${mode}-outside.txt`);
      fs.writeFileSync(outside, 'outside symlink target\n');
      fs.unlinkSync(targetPath);
      try {
        fs.symlinkSync(outside, targetPath, 'file');
      } catch (error) {
        if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
        throw error;
      }
      expectCode(
        () => privateClaim.readPrivateClaimSlot(fixture.paths, token, 'completion-stage'),
        'SPRINT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside symlink target\n');
    });
  }
});
test('v2 ambiguous partial markers are preserved and fail closed', () => withWorkspace((root) => {
  const plan = writePlan(root);
  leaveUnpublishedInitTransaction(root, plan);
  const { transaction, stateDirectory } = rewritePendingInitAsV2(root);
  const partialPath = path.join(stateDirectory, transaction.partial);
  const releasePath = `${partialPath}.release.tmp`;
  const replacement = Buffer.from(transaction.replacement_raw, 'utf8');
  const prefix = replacement.subarray(0, Math.floor(replacement.length / 3));
  fs.writeFileSync(partialPath, prefix);
  fs.writeFileSync(releasePath, prefix);
  expectCode(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.readFileSync(partialPath).equals(prefix), true);
  assert.strictEqual(fs.readFileSync(releasePath).equals(prefix), true);
}));
test('v1 and v2 complete recover after legacy claim intent cleanup failure', () => {
  for (const version of [1, 2]) {
    withWorkspace((root) => {
      const plan = writePlan(root, `legacy-metadata-v${version}.md`);
      init(root, plan);
      reach(root, 'compound');
      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const expectedRaw = fs.readFileSync(pointerPath, 'utf8');
      const token = version === 1
        ? '15151515151515151515151515151515'
        : '16161616161616161616161616161616';
      const value = legacyTransactionValue({
        version,
        token,
        operation: 'complete',
        expectedRaw,
        replacementRaw: null,
        plan,
        phase: 'compound',
      });
      const stateDirectory = path.dirname(pointerPath);
      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      fs.writeFileSync(transactionPath, `${JSON.stringify(value)}\n`);
      fs.renameSync(pointerPath, path.join(stateDirectory, value.claim));
      const originalUnlink = fs.unlinkSync;
      let injected = false;
      fs.unlinkSync = (target) => {
        if (!injected && slash(target).endsWith('-legacy-pointer/intent.json')) {
          injected = true;
          const error = new Error('simulated legacy pointer intent cleanup failure');
          error.code = 'EIO';
          throw error;
        }
        return originalUnlink(target);
      };
      try {
        expectCode(
          () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
          'SPRINT_RECOVERY_REQUIRED'
        );
      } finally {
        fs.unlinkSync = originalUnlink;
      }
      assert.strictEqual(injected, true);
      assert.strictEqual(fs.existsSync(path.join(root, sprint.COMPLETION_RELATIVE_PATH)), true);
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
      const retried = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
      assert.strictEqual(retried.recovered, true);
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
    });
  }
});

test('orphan legacy flat claim blocks mutation and remains preserved', () => withWorkspace((root) => {
  const plan = writePlan(root, 'orphan-legacy-claim.md');
  init(root, plan);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
  const stateDirectory = path.dirname(pointerPath);
  const claimPath = path.join(
    stateDirectory,
    'active-sprint.claim-17171717171717171717171717171717.json'
  );
  const orphanRaw = 'orphan legacy claim evidence\n';
  fs.writeFileSync(claimPath, orphanRaw);

  expectCode(
    () => sprint.advanceActiveSprint({
      cwd: root,
      expectedPhase: 'think',
      toPhase: 'plan',
      next: 'Plan',
    }),
    'SPRINT_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
  assert.strictEqual(fs.readFileSync(claimPath, 'utf8'), orphanRaw);
  assert.strictEqual(sprint.readActiveSprintPointer(root).active, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
}));

test('v3 complete recovers after private pointer slot removal failure', () => withWorkspace((root) => {
  const plan = writePlan(root, 'v3-completion-empty-slot.md');
  init(root, plan);
  reach(root, 'compound');
  const originalRmdir = fs.rmdirSync;
  let injected = false;
  fs.rmdirSync = (target, ...args) => {
    const normalized = slash(target);
    if (!injected
        && normalized.includes('/active-sprint.claim-')
        && normalized.endsWith('-pointer')) {
      injected = true;
      const error = new Error('simulated private pointer slot removal failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRmdir(target, ...args);
  };
  try {
    expectCode(
      () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.rmdirSync = originalRmdir;
  }

  assert.strictEqual(injected, true);
  assert.strictEqual(fs.existsSync(path.join(root, sprint.COMPLETION_RELATIVE_PATH)), true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  const retried = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
  assert.strictEqual(retried.recovered, true);
  assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
}));

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const { name, error } of failures) {
    console.error(`\n  [${name}]\n  ${error.stack || error.message}`);
  }
  process.exit(1);
}
