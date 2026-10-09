#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
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

function captureFailure(fn) {
  try {
    fn();
  } catch (error) {
    return { code: error && error.code, message: error && error.message };
  }
  return { code: '', message: '' };
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeCanonicalJson(root, relative, value) {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const serialized = `${JSON.stringify(value)}\n`;
  fs.writeFileSync(absolute, serialized);
  return { relative, serialized, sha256: hash(serialized) };
}

function snapshotWorkspace(root) {
  const entries = [];
  const visit = (relative) => {
    const absolute = relative ? path.join(root, ...relative.split('/')) : root;
    const stat = fs.lstatSync(absolute, { bigint: true });
    const kind = stat.isDirectory() ? 'directory'
      : (stat.isFile() ? 'file' : (stat.isSymbolicLink() ? 'symlink' : 'other'));
    entries.push({
      path: relative || '.',
      kind,
      mode: String(stat.mode),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      content: stat.isFile() ? hash(fs.readFileSync(absolute)) : '',
    });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(relative ? `${relative}/${name}` : name);
      }
    }
  };
  visit('');
  return entries;
}

function setCliOption(args, flag, value) {
  const updated = [...args];
  const index = updated.indexOf(flag);
  assert.notStrictEqual(index, -1, `missing CLI option ${flag}`);
  updated[index + 1] = value;
  return updated;
}

function supersedeFixture(root) {
  const sourcePlan = 'docs/plans/source.md';
  const targetPlan = 'docs/plans/target.md';
  const targetNext = 'Run successor Think phase';
  const approvalMessageSha256 = hash('必须全部完成');
  const sourceTasks = Array.from({ length: 18 }, (_, index) => `T${index}`);
  const targetTasks = [
    ...Array.from({ length: 10 }, (_, index) => `W${index}`),
    'T16', 'T17', 'R18',
  ];
  const sourcePlanRaw = [
    '---',
    'type: sprint',
    'status: in-progress',
    'tasks_completed: 16',
    'tasks_total: 18',
    `task_ids: ${JSON.stringify(sourceTasks)}`,
    'open_task_ids: ["T16","T17"]',
    '---',
    '# Source',
    ...sourceTasks.map((id) => `| ${id} | source task |`),
    '',
  ].join('\n');
  const targetPlanRaw = [
    '---',
    'type: sprint',
    'status: draft',
    'tasks_completed: 0',
    'tasks_total: 13',
    `task_ids: ${JSON.stringify(targetTasks)}`,
    `open_task_ids: ${JSON.stringify(targetTasks)}`,
    '---',
    '# Target',
    ...targetTasks.map((id) => `| ${id} | target task |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, sourcePlan), sourcePlanRaw);
  fs.writeFileSync(path.join(root, targetPlan), targetPlanRaw);
  sprint.initActiveSprint({ cwd: root, plan: sourcePlan, next: 'Start source' });
  reach(root, 'compound');
  sprint.blockActiveSprint({
    cwd: root,
    expectedPhase: 'compound',
    reason: 'Approved successor is required',
    next: 'Prepare supersession',
    now: '2026-09-09T10:00:00.000Z',
  });
  const pointerRaw = fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8');
  const mapping = writeCanonicalJson(root, 'docs/plans/.handoff/task-map.json', {
    schema_version: 'sprint-task-map/v1',
    source: {
      plan: sourcePlan,
      plan_sha256: hash(sourcePlanRaw),
      tasks_completed: 16,
      tasks_total: 18,
    },
    target: {
      plan: targetPlan,
      plan_sha256: hash(targetPlanRaw),
      tasks_completed: 0,
      tasks_total: 13,
    },
    source_tasks: sourceTasks.map((id, index) => ({
      id,
      disposition: index < 16 ? 'preserved_completed' : 'migrated_open',
      target_ids: index < 16 ? [] : [id],
    })),
    target_tasks: targetTasks.map((id) => ({
      id,
      status: 'open',
      origin: id === 'T16' || id === 'T17' ? 'migrated' : 'added',
      source_ids: id === 'T16' || id === 'T17' ? [id] : [],
    })),
    goal_preserved: true,
  });
  const approval = writeCanonicalJson(root, 'docs/plans/.handoff/owner-approval.json', {
    schema_version: 'sprint-owner-approval/v2',
    decision: 'approve_supersede',
    trust_boundary: 'local_host_observation',
    cryptographic_verification: false,
    source_assurance: 'explicit',
    message_locator: {
      schema_version: 'sprint-message-locator/v1',
      thread_id: 'test-thread',
      locator: `thread:test-thread#message-sha256:${approvalMessageSha256}`,
      message_sha256: approvalMessageSha256,
      hash_profile: 'sha256-utf8-v1',
    },
    issued_at: '2020-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    source: {
      pointer_sha256: hash(pointerRaw),
      plan: sourcePlan,
      plan_sha256: hash(sourcePlanRaw),
      phase: 'compound',
      status: 'blocked',
      tasks_completed: 16,
      tasks_total: 18,
      open_task_ids: ['T16', 'T17'],
    },
    target: {
      plan: targetPlan,
      plan_sha256: hash(targetPlanRaw),
      phase: 'think',
      status: 'active',
      acceptance_protocol: 'v1',
      tasks_completed: 0,
      tasks_total: 13,
      next: targetNext,
    },
    task_map_sha256: mapping.sha256,
    goal_preserved: true,
  });
  const fixture = {
    approval,
    mapping,
    pointerRaw,
    sourcePlan,
    sourcePlanRaw,
    sourcePlanSha256: hash(sourcePlanRaw),
    targetPlan,
    targetPlanRaw,
    targetPlanSha256: hash(targetPlanRaw),
    input: {
      cwd: root,
      expectedPhase: 'compound',
      expectedPointerSha256: hash(pointerRaw),
      oldPlanSha256: hash(sourcePlanRaw),
      plan: targetPlan,
      newPlanSha256: hash(targetPlanRaw),
      taskMap: mapping.relative,
      taskMapSha256: mapping.sha256,
      approvalReceipt: approval.relative,
      approvalSha256: approval.sha256,
      next: targetNext,
    },
  };
  fixture.input = prepareSupersedeInput(root, fixture.input);
  return fixture;
}

function rewriteFixtureApproval(root, fixture, mutate) {
  const value = JSON.parse(fixture.approval.serialized);
  mutate(value);
  return writeCanonicalJson(root, fixture.approval.relative, value);
}

function migrationReceiptPath(root, digest) {
  return path.join(
    root,
    'docs',
    'plans',
    '.handoff',
    `active-sprint.migration-receipt-${digest}.json`
  );
}

function prepareSupersedeInput(root, input, { preparedAt = new Date().toISOString() } = {}) {
  const pointerRaw = fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8');
  const pointer = JSON.parse(pointerRaw);
  const taskMapPath = path.join(root, ...input.taskMap.split('/'));
  const approvalPath = path.join(root, ...input.approvalReceipt.split('/'));
  const taskMapRaw = fs.readFileSync(taskMapPath, 'utf8');
  const approvalRaw = fs.readFileSync(approvalPath, 'utf8');
  const taskMap = JSON.parse(taskMapRaw);
  const approval = JSON.parse(approvalRaw);
  const openTaskIds = taskMap.source_tasks
    .filter((task) => task.disposition === 'migrated_open')
    .map((task) => task.id);
  const value = {
    schema_version: 'sprint-migration-receipt/v2',
    kind: 'supersede_with_open_tasks',
    source: {
      status: 'superseded_with_open_tasks',
      pointer_sha256: hash(pointerRaw),
      pointer_raw: pointerRaw,
      pointer,
      plan: taskMap.source.plan,
      plan_sha256: taskMap.source.plan_sha256,
      tasks_completed: taskMap.source.tasks_completed,
      tasks_total: taskMap.source.tasks_total,
      open_task_ids: openTaskIds,
    },
    target: {
      plan: taskMap.target.plan,
      plan_sha256: taskMap.target.plan_sha256,
      phase: 'think',
      status: 'active',
      acceptance_protocol: 'v1',
      tasks_completed: taskMap.target.tasks_completed,
      tasks_total: taskMap.target.tasks_total,
      next: input.next,
    },
    task_map: {
      path: input.taskMap,
      sha256: hash(taskMapRaw),
      value: taskMap,
    },
    approval: {
      path: input.approvalReceipt,
      sha256: hash(approvalRaw),
      value: approval,
    },
    previous_migration_receipt_sha256: pointer.migration_receipt_sha256 || null,
    prepared_at: preparedAt,
    goal_preserved: true,
  };
  const serialized = `${JSON.stringify(value)}\n`;
  const digest = hash(serialized);
  const relative = `docs/plans/.handoff/active-sprint.migration-receipt-${digest}.json`;
  fs.writeFileSync(path.join(root, ...relative.split('/')), serialized);
  return {
    ...input,
    migrationReceipt: relative,
    migrationReceiptSha256: digest,
  };
}

function supersedeCliArgs(fixture) {
  return [
    cliPath,
    'supersede',
    '--expected', fixture.input.expectedPhase,
    '--expected-pointer-sha256', fixture.input.expectedPointerSha256,
    '--old-plan-sha256', fixture.input.oldPlanSha256,
    '--plan', fixture.input.plan,
    '--new-plan-sha256', fixture.input.newPlanSha256,
    '--task-map', fixture.input.taskMap,
    '--task-map-sha256', fixture.input.taskMapSha256,
    '--approval-receipt', fixture.input.approvalReceipt,
    '--approval-sha256', fixture.input.approvalSha256,
    '--migration-receipt', fixture.input.migrationReceipt,
    '--migration-receipt-sha256', fixture.input.migrationReceiptSha256,
    '--next', fixture.input.next,
  ];
}

function supersedeProposalCliArgs(fixture) {
  return [
    cliPath,
    'prepare-supersede-proposal',
    '--expected', fixture.input.expectedPhase,
    '--expected-pointer-sha256', fixture.input.expectedPointerSha256,
    '--old-plan-sha256', fixture.input.oldPlanSha256,
    '--plan', fixture.input.plan,
    '--new-plan-sha256', fixture.input.newPlanSha256,
    '--task-map', fixture.input.taskMap,
    '--task-map-sha256', fixture.input.taskMapSha256,
    '--approval-receipt', fixture.input.approvalReceipt,
    '--approval-sha256', fixture.input.approvalSha256,
    '--next', fixture.input.next,
  ];
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

function leavePartialPublishTransaction(mutate, code = 'ENOSPC', candidateBytes = null) {
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
      originalWrite(
        target,
        candidateBytes === null ? bytes.subarray(0, prefixLength) : candidateBytes
      );
      const error = new Error(`simulated partial publish ${code}`);
      error.code = code;
      throw error;
    }
    return originalWrite(target, data, ...args);
  };
  try {
    expectCode(mutate, 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.openSync = originalOpen;
    fs.writeFileSync = originalWrite;
  }
  assert.strictEqual(injected, true);
}

function isTransactionStagePath(target) {
  return /^\.active-sprint\.transaction\.json\.stage-[a-f0-9]{32}-[a-f0-9]{32}\.tmp$/
    .test(path.basename(String(target)));
}

function writeCompletedPlan(root, name = 'completed.md') {
  const plan = `docs/plans/${name}`;
  fs.writeFileSync(path.join(root, plan), [
    '---',
    'status: completed',
    'tasks_completed: 1',
    'tasks_total: 1',
    'task_ids: ["T0"]',
    'open_task_ids: []',
    '---',
    '# Completed plan',
    '',
  ].join('\n'));
  return plan;
}

function transactionClaimEvidence(root) {
  const stateDirectory = path.join(root, 'docs', 'plans', '.handoff');
  const name = fs.readdirSync(stateDirectory)
    .find((entry) => /^active-sprint\.claim-[a-f0-9]{32}-transaction$/.test(entry));
  if (!name) return null;
  const slotPath = path.join(stateDirectory, name);
  const evidenceName = ['value', 'delete-tombstone']
    .find((entry) => fs.existsSync(path.join(slotPath, entry)));
  return {
    slotPath,
    raw: evidenceName ? fs.readFileSync(path.join(slotPath, evidenceName), 'utf8') : null,
  };
}

function leavePartialInitTransaction(root, plan, code = 'ENOSPC') {
  leavePartialPublishTransaction(
    () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
    code
  );
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

test('unbound v1 sprint resumes from blocked plan without requiring Harness', () => withWorkspace((root) => {
  const plan = writePlan(root);
  sprint.initActiveSprint({
    cwd: root,
    plan,
    restorePhase: 'plan',
    next: 'Plan',
    acceptanceProtocol: 'v1',
  });
  sprint.blockActiveSprint({
    cwd: root,
    expectedPhase: 'plan',
    reason: 'optional Harness is unavailable',
    next: 'Continue with current host',
  });

  sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'plan',
    toPhase: 'work',
    next: 'Implement with current host',
  });
  sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'work',
    toPhase: 'review',
    next: 'Review with current host',
  });
  sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'review',
    toPhase: 'compound',
    next: 'Compound verified results',
  });

  const active = sprint.readActiveSprint(root);
  assert.strictEqual(active.phase, 'compound');
  assert.strictEqual(active.status, 'active');
  assert.strictEqual(active.acceptanceProtocol, 'v1');
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
    (pointer) => { pointer.migration_receipt_sha256 = 'ABC'; },
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
    if (!injected
        && /active-sprint\.claim-/.test(String(target))
        && path.basename(String(target)) === 'value') {
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

function withSyntheticPreciseStats(identityForPath, fn) {
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalLstat = fs.lstatSync;
  const originalFstat = fs.fstatSync;
  const openPaths = new Map();
  const decorate = (stat, identity, bigint) => {
    if (!identity) return stat;
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'dev') return bigint ? identity.dev : Number(identity.dev);
        if (property === 'ino') return bigint ? identity.ino : Number(identity.ino);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  fs.openSync = (target, ...args) => {
    const handle = originalOpen(target, ...args);
    if (typeof target !== 'number') openPaths.set(handle, path.resolve(String(target)));
    return handle;
  };
  fs.closeSync = (handle) => {
    try {
      return originalClose(handle);
    } finally {
      openPaths.delete(handle);
    }
  };
  fs.lstatSync = (target, options, ...args) => {
    const stat = originalLstat(target, options, ...args);
    const resolved = path.resolve(String(target));
    const bigint = Boolean(options && typeof options === 'object' && options.bigint);
    return decorate(stat, identityForPath(resolved), bigint);
  };
  fs.fstatSync = (handle, options, ...args) => {
    const stat = originalFstat(handle, options, ...args);
    const bigint = Boolean(options && typeof options === 'object' && options.bigint);
    return decorate(stat, identityForPath(openPaths.get(handle)), bigint);
  };
  try {
    return fn();
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.lstatSync = originalLstat;
    fs.fstatSync = originalFstat;
  }
}

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

test('private claim intent write-before and partial failures remain exactly retryable', () => {
  for (const mode of ['before', 'partial']) {
    withWorkspace((root) => {
      const token = mode === 'before'
        ? '18181818181818181818181818181818'
        : '19191919191919191919191919191919';
      const fixture = privateDeleteFixture(root, token);
      const originalOpen = fs.openSync;
      const originalWrite = fs.writeFileSync;
      let intentHandle;
      let injected = false;
      fs.openSync = (target, flags, ...args) => {
        const handle = originalOpen(target, flags, ...args);
        if (String(flags).includes('x')
            && path.basename(String(target)).startsWith(
              `.intent.json.stage-${token}-`
            )) {
          intentHandle = handle;
        }
        return handle;
      };
      fs.writeFileSync = (target, data, ...args) => {
        if (!injected && target === intentHandle) {
          injected = true;
          if (mode === 'partial') {
            const bytes = Buffer.from(String(data), args[0] || 'utf8');
            originalWrite(target, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 3))));
          }
          const error = new Error(`simulated claim intent ${mode} write failure`);
          error.code = 'EIO';
          throw error;
        }
        return originalWrite(target, data, ...args);
      };
      try {
        expectCode(() => claimPrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
      } finally {
        fs.openSync = originalOpen;
        fs.writeFileSync = originalWrite;
      }
      assert.strictEqual(injected, true, mode);
      assert.strictEqual(
        fs.readFileSync(fixture.sourcePath, 'utf8'),
        fixture.bytes.toString('utf8'),
        mode
      );
      assert.strictEqual(removePrivateDeleteFixture(fixture), true, mode);
      assert.strictEqual(fs.existsSync(fixture.slotPath), false, mode);
    });
  }
});

test('private claim intent stage cleanup failure does not poison exact retry', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '20202020202020202020202020202020');
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeFileSync;
  const originalUnlink = fs.unlinkSync;
  let intentStagePath = null;
  let writeInjected = false;
  let cleanupInjected = false;
  fs.openSync = (target, flags, ...args) => {
    const handle = originalOpen(target, flags, ...args);
    if (String(flags).includes('x')
        && path.basename(String(target)).startsWith(
          `.intent.json.stage-${fixture.token}-`
        )) {
      intentStagePath = path.resolve(String(target));
    }
    return handle;
  };
  fs.writeFileSync = (target, data, ...args) => {
    if (!writeInjected && intentStagePath !== null && typeof target === 'number') {
      writeInjected = true;
      const bytes = Buffer.from(String(data), args[0] || 'utf8');
      originalWrite(target, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 3))));
      const error = new Error('simulated claim intent partial write failure');
      error.code = 'EIO';
      throw error;
    }
    return originalWrite(target, data, ...args);
  };
  fs.unlinkSync = (target) => {
    if (!cleanupInjected && intentStagePath !== null
        && path.resolve(String(target)) === intentStagePath) {
      cleanupInjected = true;
      const error = new Error('simulated claim intent stage cleanup failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    expectCode(() => claimPrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.openSync = originalOpen;
    fs.writeFileSync = originalWrite;
    fs.unlinkSync = originalUnlink;
  }
  assert.strictEqual(writeInjected, true);
  assert.strictEqual(cleanupInjected, true);
  assert.strictEqual(
    fs.readFileSync(fixture.sourcePath, 'utf8'),
    fixture.bytes.toString('utf8')
  );
  assert.strictEqual(removePrivateDeleteFixture(fixture), true);
  assert.strictEqual(fs.existsSync(fixture.slotPath), false);
  assert.strictEqual(path.dirname(intentStagePath), path.resolve(fixture.paths.stateDirectory));
  assert.strictEqual(fs.existsSync(intentStagePath), true);
}));

test('staged exclusive EEXIST retry fsyncs the final parent before success', () =>
  withWorkspace((root) => {
    const paths = privateClaim.ensureStateDirectory(root);
    const slotPath = path.join(paths.stateDirectory, 'manual-staged-exclusive-parent');
    fs.mkdirSync(slotPath);
    const finalPath = path.join(slotPath, 'intent.json');
    const token = '21212121212121212121212121212121';
    const raw = 'durable staged intent\n';
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const originalClose = fs.closeSync;
    const directoryHandles = new Map();
    let firstFinalParentFsyncFailed = false;
    let retryFinalParentFsyncSucceeded = false;
    fs.openSync = (target, flags, ...args) => {
      const handle = originalOpen(target, flags, ...args);
      if (String(flags) === 'r') {
        directoryHandles.set(handle, path.resolve(String(target)));
      }
      return handle;
    };
    fs.fsyncSync = (handle) => {
      if (directoryHandles.get(handle) === path.resolve(slotPath)
          && fs.existsSync(finalPath)) {
        if (!firstFinalParentFsyncFailed) {
          firstFinalParentFsyncFailed = true;
          const error = new Error('simulated first final-parent fsync failure');
          error.code = 'EIO';
          throw error;
        }
        retryFinalParentFsyncSucceeded = true;
      }
      return originalFsync(handle);
    };
    fs.closeSync = (handle) => {
      try {
        return originalClose(handle);
      } finally {
        directoryHandles.delete(handle);
      }
    };
    try {
      expectCode(
        () => privateClaim.writeDurableStagedExclusive(
          finalPath,
          raw,
          paths.stateDirectory,
          token
        ),
        'EIO'
      );
      privateClaim.writeDurableStagedExclusive(
        finalPath,
        raw,
        paths.stateDirectory,
        token
      );
    } finally {
      fs.openSync = originalOpen;
      fs.fsyncSync = originalFsync;
      fs.closeSync = originalClose;
    }
    assert.strictEqual(firstFinalParentFsyncFailed, true);
    assert.strictEqual(retryFinalParentFsyncSucceeded, true);
    assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), raw);
  }));

test('private claim rename fsyncs destination before source parent', () =>
  withWorkspace((root) => {
    const fixture = privateDeleteFixture(
      root,
      '23232323232323232323232323232323'
    );
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const originalClose = fs.closeSync;
    const originalRename = fs.renameSync;
    const directoryHandles = new Map();
    const fsyncOrderAfterMove = [];
    let moved = false;
    fs.openSync = (target, flags, ...args) => {
      const handle = originalOpen(target, flags, ...args);
      if (String(flags) === 'r') {
        directoryHandles.set(handle, path.resolve(String(target)));
      }
      return handle;
    };
    fs.fsyncSync = (handle) => {
      if (moved && fsyncOrderAfterMove.length < 2) {
        fsyncOrderAfterMove.push(directoryHandles.get(handle));
      }
      return originalFsync(handle);
    };
    fs.closeSync = (handle) => {
      try {
        return originalClose(handle);
      } finally {
        directoryHandles.delete(handle);
      }
    };
    fs.renameSync = (source, target) => {
      const result = originalRename(source, target);
      if (path.resolve(String(source)) === path.resolve(fixture.sourcePath)
          && slash(target).endsWith('-completion-stage/value')) {
        moved = true;
      }
      return result;
    };
    let claim;
    try {
      claim = claimPrivateDeleteFixture(fixture);
    } finally {
      fs.openSync = originalOpen;
      fs.fsyncSync = originalFsync;
      fs.closeSync = originalClose;
      fs.renameSync = originalRename;
    }
    assert.deepStrictEqual(fsyncOrderAfterMove, [
      path.resolve(fixture.slotPath),
      path.resolve(fixture.paths.stateDirectory),
    ]);
    privateClaim.deletePrivateClaimValue(fixture.paths, claim, { sync: true });
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

test('private claim restores the exact source inode moved by a pre-rename replacement', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '20202020202020202020202020202020');
  const replacement = 'source replacement moved by rename\n';
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target, ...args) => {
    if (!injected
        && path.resolve(source) === path.resolve(fixture.sourcePath)
        && slash(target).endsWith('-completion-stage/value')) {
      injected = true;
      fs.unlinkSync(source);
      fs.writeFileSync(source, replacement);
    }
    return originalRename(source, target, ...args);
  };
  try {
    expectCode(() => claimPrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(injected, true);
  assert.strictEqual(fs.readFileSync(fixture.sourcePath, 'utf8'), replacement);
  assert.strictEqual(fs.existsSync(fixture.slotPath), false);

  const retryFailure = captureFailure(() => removePrivateDeleteFixture(fixture));
  assert.strictEqual(retryFailure.code, 'SPRINT_RECOVERY_REQUIRED');
  assert.match(retryFailure.message, /recovery file changed before cleanup/);
  assert.doesNotMatch(retryFailure.message, /claim value does not match immutable intent/);
  assert.strictEqual(fs.readFileSync(fixture.sourcePath, 'utf8'), replacement);
  assert.strictEqual(fs.existsSync(fixture.slotPath), false);
}));

test('private claim stable recheck rejects a stale snapshot without moving its successor', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '24242424242424242424242424242424');
  const successor = 'source changed before private claim\n';
  fs.writeFileSync(fixture.sourcePath, successor);
  const originalRename = fs.renameSync;
  let renamed = false;
  fs.renameSync = (source, target, ...args) => {
    if (path.resolve(source) === path.resolve(fixture.sourcePath)
        && slash(target).endsWith('-completion-stage/value')) {
      renamed = true;
    }
    return originalRename(source, target, ...args);
  };
  try {
    expectCode(() => claimPrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(renamed, false);
  assert.strictEqual(fs.readFileSync(fixture.sourcePath, 'utf8'), successor);
  assert.strictEqual(fs.existsSync(fixture.slotPath), false);
}));

test('private claim mismatch preserves both the moved inode and an existing source successor', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '21212121212121212121212121212121');
  const moved = 'source replacement moved into claim\n';
  const successor = 'concurrent canonical successor\n';
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target, ...args) => {
    if (!injected
        && path.resolve(source) === path.resolve(fixture.sourcePath)
        && slash(target).endsWith('-completion-stage/value')) {
      injected = true;
      fs.unlinkSync(source);
      fs.writeFileSync(source, moved);
      const result = originalRename(source, target, ...args);
      fs.writeFileSync(source, successor);
      return result;
    }
    return originalRename(source, target, ...args);
  };
  try {
    expectCode(() => claimPrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(injected, true);
  assert.strictEqual(fs.readFileSync(fixture.sourcePath, 'utf8'), successor);
  assert.strictEqual(
    fs.readFileSync(path.join(fixture.slotPath, 'value'), 'utf8'),
    moved
  );
  assert.strictEqual(fs.existsSync(path.join(fixture.slotPath, 'intent.json')), true);
  expectCode(() => removePrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
  assert.strictEqual(fs.readFileSync(fixture.sourcePath, 'utf8'), successor);
  assert.strictEqual(fs.readFileSync(path.join(fixture.slotPath, 'value'), 'utf8'), moved);
}));

test('private claim rejects a same-bytes successor hidden by Number inode rounding', () =>
  withWorkspace((root) => {
    const token = '24242424242424242424242424242424';
    const paths = privateClaim.ensureStateDirectory(root);
    const sourcePath = path.join(
      paths.stateDirectory,
      `active-sprint.completed-${token}.tmp`
    );
    const valuePath = path.join(
      paths.stateDirectory,
      privateClaim.claimSlotName(token, 'completion-stage'),
      'value'
    );
    const restoreGuardPath = path.join(path.dirname(valuePath), 'restore-guard');
    const bytes = Buffer.from('same bytes, distinct precise inode\n');
    const originalIdentity = { dev: 37n, ino: 9007199254740992n };
    const successorIdentity = { dev: 37n, ino: 9007199254740993n };
    assert.strictEqual(Number(originalIdentity.ino), Number(successorIdentity.ino));
    let sourceIsSuccessor = false;
    const identityForPath = (candidate) => {
      if (candidate === path.resolve(valuePath)
          || candidate === path.resolve(restoreGuardPath)) {
        return originalIdentity;
      }
      if (candidate === path.resolve(sourcePath)) {
        return sourceIsSuccessor ? successorIdentity : originalIdentity;
      }
      return null;
    };

    withSyntheticPreciseStats(identityForPath, () => {
      fs.writeFileSync(sourcePath, bytes);
      const snapshot = privateClaim.readStableRecoverySnapshot(sourcePath);
      const claim = privateClaim.createPrivateClaim(paths, {
        scopeToken: token,
        artifact: 'completion-stage',
        sourcePath,
        snapshot,
      });
      sourceIsSuccessor = true;
      fs.writeFileSync(sourcePath, bytes, { flag: 'wx' });

      assert.strictEqual(
        privateClaim.restorePrivateClaim(paths, claim, sourcePath),
        false
      );
      assert.strictEqual(fs.readFileSync(sourcePath, 'utf8'), bytes.toString('utf8'));
      assert.strictEqual(fs.readFileSync(valuePath, 'utf8'), bytes.toString('utf8'));
      assert.strictEqual(fs.existsSync(claim.slotPath), true);
    });
  }));

test('private claim mismatch never overwrites a successor racing its exclusive restore', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '23232323232323232323232323232323');
  const moved = 'source replacement moved into claim\n';
  const successor = 'successor won exclusive restore race\n';
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  let renamed = false;
  let linked = false;
  fs.renameSync = (source, target, ...args) => {
    if (!renamed
        && path.resolve(source) === path.resolve(fixture.sourcePath)
        && slash(target).endsWith('-completion-stage/value')) {
      renamed = true;
      fs.unlinkSync(source);
      fs.writeFileSync(source, moved);
    }
    return originalRename(source, target, ...args);
  };
  fs.linkSync = (source, target, ...args) => {
    if (!linked
        && slash(source).endsWith('-completion-stage/value')
        && path.resolve(target) === path.resolve(fixture.sourcePath)) {
      linked = true;
      fs.writeFileSync(target, successor, { flag: 'wx' });
    }
    return originalLink(source, target, ...args);
  };
  try {
    expectCode(() => claimPrivateDeleteFixture(fixture), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.renameSync = originalRename;
    fs.linkSync = originalLink;
  }
  assert.strictEqual(renamed, true);
  assert.strictEqual(linked, true);
  assert.strictEqual(fs.readFileSync(fixture.sourcePath, 'utf8'), successor);
  assert.strictEqual(fs.readFileSync(path.join(fixture.slotPath, 'value'), 'utf8'), moved);
  assert.strictEqual(fs.existsSync(path.join(fixture.slotPath, 'intent.json')), true);
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

test('private delete preserves same-inode bytes changed during value release', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '35353535353535353535353535353535');
  const claim = claimPrivateDeleteFixture(fixture);
  const tombstonePath = path.join(claim.slotPath, 'delete-tombstone');
  const foreign = 'foreign same-inode bytes\n';
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target, ...args) => {
    if (!injected && path.resolve(target) === path.resolve(claim.valuePath)) {
      injected = true;
      fs.writeFileSync(target, foreign);
    }
    return originalUnlink(target, ...args);
  };
  try {
    expectCode(
      () => privateClaim.deletePrivateClaimValue(fixture.paths, claim, { sync: true }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.strictEqual(injected, true);
  assert.strictEqual(fs.readFileSync(claim.valuePath, 'utf8'), foreign);
  assert.strictEqual(fs.readFileSync(tombstonePath, 'utf8'), foreign);
  assert.strictEqual(fs.existsSync(claim.intentPath), true);

  const retryFailure = captureFailure(() => removePrivateDeleteFixture(fixture));
  assert.strictEqual(retryFailure.code, 'SPRINT_RECOVERY_REQUIRED');
  assert.match(retryFailure.message, /recovery file changed before cleanup/);
  assert.strictEqual(fs.readFileSync(fixture.sourcePath, 'utf8'), foreign);
  assert.strictEqual(fs.existsSync(claim.slotPath), false);
}));

test('private delete resumes from a durable tombstone-only crash phase', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '36363636363636363636363636363636');
  const claim = claimPrivateDeleteFixture(fixture);
  const tombstonePath = path.join(claim.slotPath, 'delete-tombstone');
  fs.linkSync(claim.valuePath, tombstonePath);
  fs.unlinkSync(claim.valuePath);

  assert.strictEqual(fs.readFileSync(tombstonePath, 'utf8'), fixture.bytes.toString('utf8'));
  assert.strictEqual(removePrivateDeleteFixture(fixture), true);
  assert.strictEqual(fs.existsSync(claim.slotPath), false);
}));

test('private delete verifier failure preserves value, guard, and intent', () => withWorkspace((root) => {
  const fixture = privateDeleteFixture(root, '37373737373737373737373737373737');
  const claim = claimPrivateDeleteFixture(fixture);
  const tombstonePath = path.join(claim.slotPath, 'delete-tombstone');
  const verificationError = new Error('simulated final commit verification failure');
  let verifications = 0;

  assert.throws(
    () => privateClaim.deletePrivateClaimValue(fixture.paths, claim, {
      sync: true,
      verifyBeforeDestroy: () => {
        verifications += 1;
        if (verifications === 2) throw verificationError;
      },
    }),
    (error) => error === verificationError
  );
  assert.strictEqual(verifications, 2);
  assert.strictEqual(fs.readFileSync(claim.valuePath, 'utf8'), fixture.bytes.toString('utf8'));
  assert.strictEqual(fs.readFileSync(tombstonePath, 'utf8'), fixture.bytes.toString('utf8'));
  assert.strictEqual(fs.existsSync(claim.intentPath), true);

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
  assert.strictEqual(fs.readFileSync(claim.valuePath, 'utf8'), fixture.bytes.toString('utf8'));
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
  assert.strictEqual(injected, true);
  assert.strictEqual(fs.readFileSync(sourcePath, 'utf8'), 'restore successor\n');
  assert.strictEqual(fs.existsSync(claim.intentPath), true);
  assert.strictEqual(fs.readFileSync(claim.valuePath, 'utf8'), 'owned pointer\n');
}));

test('private restore resumes from a durable guard-only crash phase', () => withWorkspace((root) => {
  const paths = privateClaim.ensureStateDirectory(root);
  const token = 'bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc';
  const sourcePath = path.join(paths.stateDirectory, 'active-sprint.json');
  fs.writeFileSync(sourcePath, 'owned guarded pointer\n');
  const snapshot = privateClaim.readStableRecoverySnapshot(sourcePath);
  const claim = privateClaim.createPrivateClaim(paths, {
    scopeToken: token,
    artifact: 'pointer',
    sourcePath,
    snapshot,
  });
  const guardPath = path.join(claim.slotPath, 'restore-guard');
  fs.linkSync(claim.valuePath, sourcePath);
  fs.linkSync(claim.valuePath, guardPath);
  fs.unlinkSync(claim.valuePath);

  assert.strictEqual(fs.readFileSync(guardPath, 'utf8'), 'owned guarded pointer\n');
  assert.strictEqual(privateClaim.restorePrivateClaim(paths, claim, sourcePath), true);
  assert.strictEqual(fs.readFileSync(sourcePath, 'utf8'), 'owned guarded pointer\n');
  assert.strictEqual(fs.existsSync(claim.slotPath), false);
}));

test('private claim staged symlinks and foreign hardlinks fail closed', () => {
  for (const stageName of ['restore-guard', 'delete-tombstone']) {
    withWorkspace((root) => {
      const token = stageName === 'restore-guard'
        ? 'bdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbd'
        : 'bebebebebebebebebebebebebebebebe';
      const fixture = privateDeleteFixture(root, token);
      const claim = claimPrivateDeleteFixture(fixture);
      const stagePath = path.join(claim.slotPath, stageName);
      const outside = path.join(root, `${stageName}.txt`);
      fs.writeFileSync(outside, 'foreign staged bytes\n');
      try {
        fs.symlinkSync(outside, stagePath, 'file');
      } catch (error) {
        if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          fs.linkSync(outside, stagePath);
        } else {
          throw error;
        }
      }
      expectCode(
        () => privateClaim.readPrivateClaimSlot(
          fixture.paths,
          token,
          'completion-stage',
          { allowMissing: false }
        ),
        'SPRINT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.readFileSync(claim.valuePath, 'utf8'), fixture.bytes.toString('utf8'));
      assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'foreign staged bytes\n');
      assert.strictEqual(fs.existsSync(claim.intentPath), true);
    });
  }
});

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

test('v3 replace partial candidate is claimed and exact retry rebuilds it', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'v3-replace-partial.md');
    init(root, plan);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
    const mutation = () => sprint.advanceActiveSprint({
      cwd: root,
      expectedPhase: 'think',
      toPhase: 'plan',
      next: 'Plan exact retry',
      now: '2026-08-01T00:00:00.000Z',
    });

    leavePartialPublishTransaction(mutation, 'ENOSPC');
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    const partialPath = path.join(
      path.dirname(transactionPath),
      ...transaction.partial.split('/')
    );
    const intentPath = path.join(path.dirname(partialPath), 'intent.json');
    const partial = fs.readFileSync(partialPath);
    const partialStat = fs.lstatSync(partialPath, { bigint: true });
    const intent = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    const replacement = Buffer.from(transaction.replacement_raw, 'utf8');
    assert.strictEqual(transaction.version, 3);
    assert.strictEqual(transaction.operation, 'replace');
    assert.strictEqual(intent.expected_dev, String(partialStat.dev));
    assert.strictEqual(intent.expected_ino, String(partialStat.ino));
    assert(partial.length > 0 && partial.length < replacement.length);
    assert(partial.equals(replacement.subarray(0, partial.length)));
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);

    const retried = mutation();
    assert.strictEqual(retried.action, 'advance');
    assert.strictEqual(raw(root).phase, 'plan');
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(fs.existsSync(path.dirname(partialPath)), false);
  }));

test('v3 replace partial ownership rejects mismatched bytes and a replaced inode', () => {
  for (const mode of ['mismatched-prefix', 'replaced-inode']) {
    withWorkspace((root) => {
      const plan = writePlan(root, `v3-replace-${mode}.md`);
      init(root, plan);
      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
      const mutate = () => sprint.advanceActiveSprint({
        cwd: root,
        expectedPhase: 'think',
        toPhase: 'plan',
        next: `Reject ${mode}`,
        now: '2026-08-01T00:00:00.000Z',
      });

      if (mode === 'mismatched-prefix') {
        leavePartialPublishTransaction(mutate, 'EIO', Buffer.from('foreign-prefix\n'));
      } else {
        const originalOpen = fs.openSync;
        const originalWrite = fs.writeFileSync;
        const originalClose = fs.closeSync;
        let publishHandle;
        let publishPath;
        let prefix;
        let injected = false;
        fs.openSync = (target, ...args) => {
          const handle = originalOpen(target, ...args);
          if (/active-sprint\.publish-/.test(String(target))) {
            publishHandle = handle;
            publishPath = String(target);
          }
          return handle;
        };
        fs.writeFileSync = (target, data, ...args) => {
          if (target === publishHandle) {
            const bytes = Buffer.isBuffer(data)
              ? data : Buffer.from(String(data), args[0] || 'utf8');
            prefix = bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 3)));
            return originalWrite(target, prefix);
          }
          return originalWrite(target, data, ...args);
        };
        fs.closeSync = (handle) => {
          const result = originalClose(handle);
          if (!injected && handle === publishHandle) {
            injected = true;
            fs.unlinkSync(publishPath);
            fs.writeFileSync(publishPath, prefix);
            const error = new Error('simulated publish inode replacement');
            error.code = 'EIO';
            throw error;
          }
          return result;
        };
        try {
          expectCode(mutate, 'SPRINT_RECOVERY_REQUIRED');
        } finally {
          fs.openSync = originalOpen;
          fs.writeFileSync = originalWrite;
          fs.closeSync = originalClose;
        }
        assert.strictEqual(injected, true);
      }

      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
      const publishPath = path.join(path.dirname(transactionPath), transaction.publish);
      const candidate = fs.readFileSync(publishPath);
      if (mode === 'mismatched-prefix') {
        assert.strictEqual(candidate.toString('utf8'), 'foreign-prefix\n');
      } else {
        const replacement = Buffer.from(transaction.replacement_raw, 'utf8');
        assert(candidate.equals(replacement.subarray(0, candidate.length)));
      }
      expectCode(mutate, 'SPRINT_RECOVERY_REQUIRED');
      assert.strictEqual(fs.readFileSync(publishPath).equals(candidate), true);
      assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
      assert.strictEqual(fs.existsSync(transactionPath), true);
    });
  }
});

test('v3 replace partial recovery preserves foreign and symlink source successors', () => {
  for (const mode of ['foreign', 'symlink']) {
    withWorkspace((root) => {
      const plan = writePlan(root, `v3-replace-source-${mode}.md`);
      init(root, plan);
      const mutate = () => sprint.advanceActiveSprint({
        cwd: root,
        expectedPhase: 'think',
        toPhase: 'plan',
        next: `Preserve ${mode}`,
        now: '2026-08-01T00:00:00.000Z',
      });
      leavePartialPublishTransaction(mutate, 'ENOSPC');
      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
      const stateDirectory = path.dirname(transactionPath);
      const publishPath = path.join(stateDirectory, transaction.publish);
      const partialPath = path.join(stateDirectory, ...transaction.partial.split('/'));
      const foreign = path.join(root, `outside-${mode}.txt`);
      fs.writeFileSync(foreign, 'foreign publish successor\n');
      if (mode === 'foreign') {
        fs.writeFileSync(publishPath, 'foreign publish successor\n');
      } else {
        try {
          fs.symlinkSync(foreign, publishPath, 'file');
        } catch (error) {
          if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
          throw error;
        }
      }

      expectCode(mutate, 'SPRINT_RECOVERY_REQUIRED');
      assert.strictEqual(fs.existsSync(partialPath), true);
      assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'foreign publish successor\n');
      if (mode === 'foreign') {
        assert.strictEqual(fs.readFileSync(publishPath, 'utf8'), 'foreign publish successor\n');
      } else {
        assert.strictEqual(fs.lstatSync(publishPath).isSymbolicLink(), true);
      }
      assert.strictEqual(fs.existsSync(transactionPath), true);
    });
  }
});

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
      originalRmdir(target, ...args);
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
  assert.ok(
    !fs.existsSync(publishPath) || fs.existsSync(slotPath),
    'partial source must not outlive all ownership evidence'
  );

  const result = sprint.initActiveSprint({ cwd: root, plan, next: 'Think' });
  assert.strictEqual(result.action, 'init');
  assert.strictEqual(fs.existsSync(slotPath), false);
  assert.strictEqual(fs.existsSync(publishPath), false);
  assert.strictEqual(sprint.readActiveSprint(root).active, true);
}));

test('v3 empty partial keeps evidence until its owned prefix is durably retired', () => withWorkspace((root) => {
  const fixture = emptyV3PartialFixture(root, 'v3-empty-partial-durable-adopt.md');
  fs.writeFileSync(fixture.publishPath, fixture.prefix);
  const originalRmdir = fs.rmdirSync;
  let injected = false;
  fs.rmdirSync = (target, ...args) => {
    if (!injected && path.resolve(target) === path.resolve(fixture.slotPath)) {
      injected = true;
      originalRmdir(target, ...args);
      const error = new Error('simulated crash after empty partial metadata removal');
      error.code = 'EIO';
      throw error;
    }
    return originalRmdir(target, ...args);
  };
  try {
    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan: fixture.plan, next: 'Think' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
  } finally {
    fs.rmdirSync = originalRmdir;
  }
  assert.strictEqual(injected, true);
  assert.ok(
    !fs.existsSync(fixture.publishPath) || fs.existsSync(fixture.slotPath),
    'empty partial source must not outlive all ownership evidence'
  );

  const result = sprint.initActiveSprint({ cwd: root, plan: fixture.plan, next: 'Think' });
  assert.strictEqual(result.action, 'init');
  assert.strictEqual(fs.existsSync(fixture.slotPath), false);
  assert.strictEqual(fs.existsSync(fixture.publishPath), false);
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

test('legacy v1 and v2 uncommitted completion WALs fail closed and preserve evidence', () => {
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
      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      const claimPath = path.join(stateDirectory, value.claim);
      const transactionRaw = `${JSON.stringify(value)}\n`;
      fs.writeFileSync(transactionPath, transactionRaw);
      fs.renameSync(pointerPath, claimPath);

      expectCode(
        () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
        'SPRINT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), transactionRaw);
      assert.strictEqual(fs.readFileSync(claimPath, 'utf8'), expectedRaw);
      assert.strictEqual(fs.existsSync(path.join(root, sprint.COMPLETION_RELATIVE_PATH)), false);
      assert.strictEqual(fs.existsSync(pointerPath), false);
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
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
test('legacy v1 and v2 completion WALs converge only with an exact published v1 record', () => {
  for (const version of [1, 2]) {
    withWorkspace((root) => {
      const plan = writePlan(root, `legacy-published-v${version}.md`);
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
      const claimPath = path.join(stateDirectory, value.claim);
      fs.writeFileSync(transactionPath, `${JSON.stringify(value)}\n`);
      fs.renameSync(pointerPath, claimPath);
      const completion = {
        version: 1,
        token,
        plan,
        phase: 'compound',
        expected_sha256: hash(expectedRaw),
        completed_at: '2026-07-24T03:00:01.000Z',
      };
      const completionRaw = `${JSON.stringify(completion)}\n`;
      fs.writeFileSync(path.join(root, sprint.COMPLETION_RELATIVE_PATH), completionRaw);

      const recovered = sprint.completeActiveSprint({
        cwd: root,
        expectedPhase: 'compound',
      });
      assert.strictEqual(recovered.recovered, true);
      assert.strictEqual(fs.readFileSync(
        path.join(root, sprint.COMPLETION_RELATIVE_PATH),
        'utf8'
      ), completionRaw);
      assert.strictEqual(fs.existsSync(transactionPath), false);
      assert.strictEqual(fs.existsSync(claimPath), false);
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

test('prepare-supersede-proposal CLI is read-only and its exact bytes supersede end to end', () =>
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const originalReceiptPath = path.join(
      root,
      ...fixture.input.migrationReceipt.split('/')
    );
    fs.unlinkSync(originalReceiptPath);
    const stateDirectory = path.dirname(path.join(root, sprint.POINTER_RELATIVE_PATH));
    const snapshotState = () => fs.readdirSync(stateDirectory).sort().map((name) => {
      const file = path.join(stateDirectory, name);
      const stat = fs.lstatSync(file);
      return [
        name,
        stat.isFile() ? fs.readFileSync(file).toString('base64') : '<directory>',
      ];
    });
    const before = snapshotState();

    const prepared = spawnSync(
      process.execPath,
      supersedeProposalCliArgs(fixture),
      { cwd: root, encoding: 'utf8' }
    );
    assert.strictEqual(prepared.status, 0, prepared.stderr);
    const proposal = JSON.parse(prepared.stdout);
    assert.strictEqual(prepared.stdout, `${JSON.stringify(proposal)}\n`);
    assert.strictEqual(proposal.action, 'prepare-supersede-proposal');
    assert.strictEqual(
      proposal.receipt.raw,
      `${JSON.stringify(proposal.receipt.value)}\n`
    );
    assert.strictEqual(hash(proposal.receipt.raw), proposal.receipt.sha256);
    assert.strictEqual(
      proposal.receipt.path,
      `docs/plans/.handoff/active-sprint.migration-receipt-${proposal.receipt.sha256}.json`
    );
    assert.deepStrictEqual(snapshotState(), before);
    const receiptPath = path.join(root, ...proposal.receipt.path.split('/'));
    assert.strictEqual(fs.existsSync(receiptPath), false);

    fs.writeFileSync(receiptPath, proposal.receipt.raw, { flag: 'wx' });
    const executionFixture = {
      ...fixture,
      input: {
        ...fixture.input,
        migrationReceipt: proposal.receipt.path,
        migrationReceiptSha256: proposal.receipt.sha256,
      },
    };
    const superseded = spawnSync(
      process.execPath,
      supersedeCliArgs(executionFixture),
      { cwd: root, encoding: 'utf8' }
    );
    assert.strictEqual(superseded.status, 0, superseded.stderr);
    assert.strictEqual(JSON.parse(superseded.stdout).action, 'supersede');
    assert.strictEqual(raw(root).plan, fixture.targetPlan);
    assert.strictEqual(
      raw(root).migration_receipt_sha256,
      proposal.receipt.sha256
    );
    assert.strictEqual(fs.readFileSync(receiptPath, 'utf8'), proposal.receipt.raw);
    assert.strictEqual(fs.existsSync(path.join(root, sprint.TRANSACTION_RELATIVE_PATH)), false);
  }));

test('supersede proposal and execution reject self-supersession without writes', () => {
  const cases = [
    ['proposal API', 'proposal-api'],
    ['proposal CLI', 'proposal-cli'],
    ['execution API', 'execution-api'],
    ['execution CLI', 'execution-cli'],
  ];
  for (const [label, mode] of cases) {
    withWorkspace((root) => {
      const fixture = supersedeFixture(root);
      const identicalInput = {
        ...fixture.input,
        plan: fixture.sourcePlan,
        newPlanSha256: fixture.sourcePlanSha256,
      };
      const before = snapshotWorkspace(root);
      let failure;
      if (mode === 'proposal-api') {
        failure = captureFailure(() => sprint.prepareSupersessionProposal(identicalInput));
      } else if (mode === 'execution-api') {
        failure = captureFailure(() => sprint.supersedeActiveSprint(identicalInput));
      } else {
        const baseArgs = mode === 'proposal-cli'
          ? supersedeProposalCliArgs(fixture)
          : supersedeCliArgs(fixture);
        const args = setCliOption(
          setCliOption(baseArgs, '--plan', fixture.sourcePlan),
          '--new-plan-sha256',
          fixture.sourcePlanSha256
        );
        const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
        const match = /^\[([^\]]+)\] ([\s\S]*?)\n?$/.exec(result.stderr);
        failure = {
          code: match ? match[1] : '',
          message: match ? match[2] : result.stderr,
          status: result.status,
        };
      }
      assert.deepStrictEqual(snapshotWorkspace(root), before, `${label} mutated the workspace`);
      if (Object.hasOwn(failure, 'status')) assert.strictEqual(failure.status, 1, label);
      assert.strictEqual(failure.code, 'ILLEGAL_SPRINT_SUPERSESSION', label);
      assert.match(
        failure.message,
        /supersede source and target plans must be distinct files/,
        label
      );
    });
  }
});

test('supersede rejects distinct plan paths backed by the same hardlink identity', () => {
  for (const mode of ['proposal', 'execution']) {
    withWorkspace((root) => {
      const fixture = supersedeFixture(root);
      const sourcePath = path.join(root, ...fixture.sourcePlan.split('/'));
      const targetPath = path.join(root, ...fixture.targetPlan.split('/'));
      fs.unlinkSync(targetPath);
      try {
        fs.linkSync(sourcePath, targetPath);
      } catch (error) {
        fs.writeFileSync(targetPath, fixture.targetPlanRaw);
        if (['EACCES', 'EPERM', 'ENOSYS', 'EXDEV', 'ENOTSUP'].includes(error && error.code)) return;
        throw error;
      }
      const sourceStat = fs.statSync(sourcePath, { bigint: true });
      const targetStat = fs.statSync(targetPath, { bigint: true });
      assert.strictEqual(String(sourceStat.dev), String(targetStat.dev));
      assert.strictEqual(String(sourceStat.ino), String(targetStat.ino));
      const input = {
        ...fixture.input,
        newPlanSha256: fixture.sourcePlanSha256,
      };
      const before = snapshotWorkspace(root);
      const failure = captureFailure(() => (
        mode === 'proposal'
          ? sprint.prepareSupersessionProposal(input)
          : sprint.supersedeActiveSprint(input)
      ));
      assert.deepStrictEqual(snapshotWorkspace(root), before, `${mode} mutated the workspace`);
      assert.strictEqual(failure.code, 'ILLEGAL_SPRINT_SUPERSESSION', mode);
      assert.match(
        failure.message,
        /supersede source and target plans must be distinct files/,
        mode
      );
    });
  }
});

test('supersede accepts distinct plans whose NTFS inodes collide as Numbers', () =>
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const sourcePath = path.resolve(root, fixture.sourcePlan);
    const targetPath = path.resolve(root, fixture.targetPlan);
    const sourceIdentity = { dev: 41n, ino: 9007199254740992n };
    const targetIdentity = { dev: 41n, ino: 9007199254740993n };
    assert.strictEqual(Number(sourceIdentity.ino), Number(targetIdentity.ino));
    const result = withSyntheticPreciseStats((candidate) => {
      if (candidate === sourcePath) return sourceIdentity;
      if (candidate === targetPath) return targetIdentity;
      return null;
    }, () => sprint.supersedeActiveSprint(fixture.input));

    assert.strictEqual(result.action, 'supersede');
    assert.strictEqual(result.pointer.plan, fixture.targetPlan);
    assert.strictEqual(sprint.readActiveSprint(root).plan, fixture.targetPlan);
  }));

test('supersede preserves open work in an immutable receipt and activates think', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const result = sprint.supersedeActiveSprint(fixture.input);
  const pointer = raw(root);
  assert.strictEqual(result.action, 'supersede');
  assert.strictEqual(pointer.plan, fixture.targetPlan);
  assert.strictEqual(pointer.phase, 'think');
  assert.strictEqual(pointer.status, 'active');
  assert.strictEqual(pointer.acceptance_protocol, 'v1');
  assert.match(pointer.migration_receipt_sha256, /^[a-f0-9]{64}$/);
  const receiptPath = migrationReceiptPath(root, pointer.migration_receipt_sha256);
  const receiptRaw = fs.readFileSync(receiptPath, 'utf8');
  assert.strictEqual(hash(receiptRaw), pointer.migration_receipt_sha256);
  const receipt = JSON.parse(receiptRaw);
  assert.strictEqual(receipt.source.status, 'superseded_with_open_tasks');
  assert.deepStrictEqual(receipt.source.open_task_ids, ['T16', 'T17']);
  assert.strictEqual(receipt.goal_preserved, true);
  assert.strictEqual(fs.readFileSync(path.join(root, fixture.sourcePlan), 'utf8'), fixture.sourcePlanRaw);
  assert.strictEqual(fs.existsSync(path.join(root, sprint.COMPLETION_RELATIVE_PATH)), false);
  const status = sprint.readActiveSprint(root);
  assert.strictEqual(status.active, true);
  assert.strictEqual(status.migrationReceiptSha256, pointer.migration_receipt_sha256);
}));

test('supersede rejects a stale raw pointer hash without mutation', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  expectCode(
    () => sprint.supersedeActiveSprint({
      ...fixture.input,
      expectedPointerSha256: '0'.repeat(64),
    }),
    'SPRINT_STATE_CONFLICT'
  );
  assert.strictEqual(
    fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
    fixture.pointerRaw
  );
}));

test('supersede rejects a task map that drops an open source task', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const mappingValue = JSON.parse(fixture.mapping.serialized);
  mappingValue.source_tasks = mappingValue.source_tasks.filter((task) => task.id !== 'T16');
  const mapping = writeCanonicalJson(root, fixture.mapping.relative, mappingValue);
  const approvalValue = JSON.parse(fixture.approval.serialized);
  approvalValue.task_map_sha256 = mapping.sha256;
  const approval = writeCanonicalJson(root, fixture.approval.relative, approvalValue);
  expectCode(
    () => sprint.supersedeActiveSprint({
      ...fixture.input,
      taskMapSha256: mapping.sha256,
      approvalSha256: approval.sha256,
    }),
    'INVALID_SPRINT_TASK_MAP'
  );
  assert.strictEqual(
    fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
    fixture.pointerRaw
  );
}));

test('supersede rejects count-preserving substitution of approved open task identities', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const mappingValue = JSON.parse(fixture.mapping.serialized);
  const sourceById = new Map(mappingValue.source_tasks.map((task) => [task.id, task]));
  sourceById.set('T0', { id: 'T0', disposition: 'migrated_open', target_ids: ['T16'] });
  sourceById.set('T1', { id: 'T1', disposition: 'migrated_open', target_ids: ['T17'] });
  sourceById.set('T16', { id: 'T16', disposition: 'preserved_completed', target_ids: [] });
  sourceById.set('T17', { id: 'T17', disposition: 'preserved_completed', target_ids: [] });
  mappingValue.source_tasks = [...sourceById.values()];
  mappingValue.target_tasks.find((task) => task.id === 'T16').source_ids = ['T0'];
  mappingValue.target_tasks.find((task) => task.id === 'T17').source_ids = ['T1'];
  const mapping = writeCanonicalJson(root, fixture.mapping.relative, mappingValue);
  const approval = rewriteFixtureApproval(root, fixture, (value) => {
    value.task_map_sha256 = mapping.sha256;
    value.source.open_task_ids = ['T0', 'T1'];
  });

  expectCode(
    () => sprint.supersedeActiveSprint(prepareSupersedeInput(root, {
      ...fixture.input,
      taskMapSha256: mapping.sha256,
      approvalSha256: approval.sha256,
    })),
    'INVALID_SPRINT_TASK_MAP'
  );
  assert.strictEqual(
    fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
    fixture.pointerRaw
  );
}));

test('supersede uses explicit task metadata and ignores annotated Markdown tables', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const sourceTasks = Array.from({ length: 18 }, (_, index) => `T${index}`);
  const sourcePlanRaw = [
    '---',
    'type: sprint',
    'status: in-progress',
    'tasks_completed: 16',
    'tasks_total: 18',
    `task_ids: ${JSON.stringify(sourceTasks)}`,
    'open_task_ids: ["T16","T17"]',
    '---',
    '# Source',
    '## Tasks',
    '| ID | Task |',
    '| --- | --- |',
    ...sourceTasks.map((id) => (
      ['T2', 'T3'].includes(id)
        ? `| ${id} \`[P]\` | source task |`
        : `| ${id} | source task |`
    )),
    '',
    '## Review inputs',
    '| ID | Evidence |',
    '| --- | --- |',
    '| R18 | later review item, not a source task |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, fixture.sourcePlan), sourcePlanRaw);
  const mappingValue = JSON.parse(fixture.mapping.serialized);
  mappingValue.source.plan_sha256 = hash(sourcePlanRaw);
  const mapping = writeCanonicalJson(root, fixture.mapping.relative, mappingValue);
  const approval = rewriteFixtureApproval(root, fixture, (value) => {
    value.source.plan_sha256 = hash(sourcePlanRaw);
    value.task_map_sha256 = mapping.sha256;
  });

  const result = sprint.supersedeActiveSprint(prepareSupersedeInput(root, {
    ...fixture.input,
    oldPlanSha256: hash(sourcePlanRaw),
    taskMapSha256: mapping.sha256,
    approvalSha256: approval.sha256,
  }));
  const receipt = JSON.parse(fs.readFileSync(
    migrationReceiptPath(root, result.pointer.migration_receipt_sha256),
    'utf8'
  ));
  assert.deepStrictEqual(receipt.source.open_task_ids, ['T16', 'T17']);
}));

test('supersede accepts repeated plan tables with the same ordered task identities', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const sourceTasks = Array.from({ length: 18 }, (_, index) => `T${index}`);
  const sourcePlanRaw = [
    fixture.sourcePlanRaw.trimEnd(),
    '',
    '## Verification summary',
    ...sourceTasks.map((id) => `| ${id} | verified status |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, fixture.sourcePlan), sourcePlanRaw);
  const mappingValue = JSON.parse(fixture.mapping.serialized);
  mappingValue.source.plan_sha256 = hash(sourcePlanRaw);
  const mapping = writeCanonicalJson(root, fixture.mapping.relative, mappingValue);
  const approval = rewriteFixtureApproval(root, fixture, (value) => {
    value.source.plan_sha256 = hash(sourcePlanRaw);
    value.task_map_sha256 = mapping.sha256;
  });

  const result = sprint.supersedeActiveSprint(prepareSupersedeInput(root, {
    ...fixture.input,
    oldPlanSha256: hash(sourcePlanRaw),
    taskMapSha256: mapping.sha256,
    approvalSha256: approval.sha256,
  }));
  assert.strictEqual(result.action, 'supersede');
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(
      migrationReceiptPath(root, result.pointer.migration_receipt_sha256),
      'utf8'
    )).source.open_task_ids,
    ['T16', 'T17']
  );
}));

test('supersede exact retry is idempotent', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const first = sprint.supersedeActiveSprint(fixture.input);
  const pointerAfterFirst = fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8');
  const second = sprint.supersedeActiveSprint(fixture.input);
  assert.strictEqual(second.action, 'supersede');
  assert.strictEqual(second.alreadySuperseded, true);
  assert.strictEqual(second.pointer.migration_receipt_sha256, first.pointer.migration_receipt_sha256);
  assert.strictEqual(
    fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
    pointerAfterFirst
  );
}));

test('advance and block preserve supersession lineage', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  sprint.supersedeActiveSprint(fixture.input);
  const receiptSha = raw(root).migration_receipt_sha256;
  sprint.advanceActiveSprint({
    cwd: root,
    expectedPhase: 'think',
    toPhase: 'plan',
    next: 'Plan successor',
  });
  assert.strictEqual(raw(root).migration_receipt_sha256, receiptSha);
  sprint.blockActiveSprint({
    cwd: root,
    expectedPhase: 'plan',
    reason: 'Await review',
    next: 'Resume plan',
  });
  assert.strictEqual(raw(root).migration_receipt_sha256, receiptSha);
}));

test('CLI supersede uses the runtime clock and rejects caller-controlled --now', () => {
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const result = spawnSync(process.execPath, supersedeCliArgs(fixture), {
      cwd: root,
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.action, 'supersede');
    assert.strictEqual(parsed.pointer.phase, 'think');
    assert.match(parsed.pointer.migration_receipt_sha256, /^[a-f0-9]{64}$/);
  });
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const result = spawnSync(process.execPath, [
      ...supersedeCliArgs(fixture),
      '--now', fixture.input.now,
    ], { cwd: root, encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /\[INVALID_SPRINT_COMMAND\]/);
  });
});

test('supersede rejects stale plan hashes and expired approval evidence', () => {
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    expectCode(
      () => sprint.supersedeActiveSprint({
        ...fixture.input,
        newPlanSha256: '0'.repeat(64),
      }),
      'INVALID_SPRINT_PLAN'
    );
    assert.strictEqual(fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'), fixture.pointerRaw);
  });
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const approval = rewriteFixtureApproval(root, fixture, (value) => {
      value.expires_at = '2020-01-02T00:00:00.000Z';
    });
    expectCode(
      () => sprint.supersedeActiveSprint({
        ...fixture.input,
        approvalSha256: approval.sha256,
      }),
      'INVALID_SPRINT_APPROVAL'
    );
    assert.strictEqual(fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'), fixture.pointerRaw);
  });
});

test('supersede rejects unknown approval fields and duplicate task identities', () => {
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const approvalValue = JSON.parse(fixture.approval.serialized);
    approvalValue.claimed_verified = true;
    const approval = writeCanonicalJson(root, fixture.approval.relative, approvalValue);
    expectCode(
      () => sprint.supersedeActiveSprint({
        ...fixture.input,
        approvalSha256: approval.sha256,
      }),
      'INVALID_SPRINT_APPROVAL'
    );
  });
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const mappingValue = JSON.parse(fixture.mapping.serialized);
    mappingValue.source_tasks[1].id = mappingValue.source_tasks[0].id;
    const mapping = writeCanonicalJson(root, fixture.mapping.relative, mappingValue);
    const approvalValue = JSON.parse(fixture.approval.serialized);
    approvalValue.task_map_sha256 = mapping.sha256;
    const approval = writeCanonicalJson(root, fixture.approval.relative, approvalValue);
    expectCode(
      () => sprint.supersedeActiveSprint({
        ...fixture.input,
        taskMapSha256: mapping.sha256,
        approvalSha256: approval.sha256,
      }),
      'INVALID_SPRINT_TASK_MAP'
    );
  });
});

test('supersede approval v2 validates bounded local audit metadata without claiming authentication', () => {
  const invalidApprovals = [
    ['legacy schema replay', (value) => { value.schema_version = 'sprint-owner-approval/v1'; }],
    ['ambiguous trust boundary', (value) => { value.trust_boundary = 'host_observed'; }],
    ['false cryptographic claim', (value) => { value.cryptographic_verification = true; }],
    ['non-explicit assurance', (value) => { value.source_assurance = 'claimed'; }],
    ['missing stable message locator', (value) => { delete value.message_locator; }],
    ['wrong locator schema', (value) => {
      value.message_locator.schema_version = 'sprint-message-locator/v0';
    }],
    ['wrong locator hash profile', (value) => {
      value.message_locator.hash_profile = 'sha256-text-v0';
    }],
    ['locator belongs to another message', (value) => {
      value.message_locator.locator = [
        'thread:other-thread#message-sha256:',
        value.message_locator.message_sha256,
      ].join('');
    }],
  ];
  for (const [label, mutate] of invalidApprovals) {
    withWorkspace((root) => {
      const fixture = supersedeFixture(root);
      const approval = rewriteFixtureApproval(root, fixture, mutate);
      assert.throws(
        () => sprint.supersedeActiveSprint({
          ...fixture.input,
          approvalSha256: approval.sha256,
        }),
        (error) => error && error.code === 'INVALID_SPRINT_APPROVAL',
        label
      );
      assert.strictEqual(
        fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
        fixture.pointerRaw
      );
    });
  }
});

test('supersede rejects a successor next action not bound by owner approval', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  expectCode(
    () => sprint.supersedeActiveSprint({
      ...fixture.input,
      next: 'Unapproved successor action',
    }),
    'INVALID_SPRINT_APPROVAL'
  );
  assert.strictEqual(
    fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
    fixture.pointerRaw
  );
}));

test('migration receipt embeds the complete approval and survives source evidence removal', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const result = sprint.supersedeActiveSprint(fixture.input);
  const receiptRaw = fs.readFileSync(
    migrationReceiptPath(root, result.pointer.migration_receipt_sha256),
    'utf8'
  );
  const receipt = JSON.parse(receiptRaw);
  fs.unlinkSync(path.join(root, ...fixture.approval.relative.split('/')));

  const status = sprint.readActiveSprint(root);
  assert.strictEqual(status.active, true);
  assert.deepStrictEqual(
    Object.keys(receipt.approval).sort(),
    ['path', 'sha256', 'value']
  );
  assert.deepStrictEqual(receipt.approval.value, JSON.parse(fixture.approval.serialized));
  assert.strictEqual(
    hash(`${JSON.stringify(receipt.approval.value)}\n`),
    receipt.approval.sha256
  );
  assert.strictEqual(receipt.approval.value.trust_boundary, 'local_host_observation');
  assert.strictEqual(receipt.approval.value.cryptographic_verification, false);
}));

test('v5 supersede partial candidate is claimed and exact retry converges', () =>
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
    leavePartialPublishTransaction(
      () => sprint.supersedeActiveSprint(fixture.input),
      'ENOSPC'
    );

    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    const stateDirectory = path.dirname(transactionPath);
    const publishPath = path.join(stateDirectory, transaction.publish);
    const partialPath = path.join(stateDirectory, ...transaction.partial.split('/'));
    const partial = fs.readFileSync(partialPath);
    const replacement = Buffer.from(transaction.replacement_raw, 'utf8');
    assert.strictEqual(transaction.version, 5);
    assert.strictEqual(transaction.operation, 'supersede');
    assert.strictEqual(fs.existsSync(publishPath), false);
    assert(partial.length > 0 && partial.length < replacement.length);
    assert(partial.equals(replacement.subarray(0, partial.length)));
    assert.strictEqual(hash(transaction.replacement_raw), transaction.replacement_sha256);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);

    const retried = sprint.supersedeActiveSprint(fixture.input);
    assert.strictEqual(retried.action, 'supersede');
    assert.strictEqual(raw(root).plan, fixture.targetPlan);
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(fs.existsSync(path.dirname(partialPath)), false);
  }));

test('v5 supersede partial recovery validates replacement_raw before cleanup', () =>
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
    leavePartialPublishTransaction(
      () => sprint.supersedeActiveSprint(fixture.input),
      'ENOSPC'
    );
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    const partialPath = path.join(
      path.dirname(transactionPath),
      ...transaction.partial.split('/')
    );
    const partialBefore = fs.readFileSync(partialPath);
    transaction.replacement_raw = `${transaction.replacement_raw} `;
    fs.writeFileSync(transactionPath, `${JSON.stringify(transaction)}\n`);

    expectCode(
      () => sprint.supersedeActiveSprint(fixture.input),
      'SPRINT_RECOVERY_REQUIRED'
    );
    assert.strictEqual(fs.readFileSync(partialPath).equals(partialBefore), true);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
    assert.strictEqual(fs.existsSync(transactionPath), true);
  }));

test('pending supersede rejects every other mutation and exact retry recovers', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const originalOpen = fs.openSync;
  let injected = false;
  fs.openSync = (target, flags, ...args) => {
    if (!injected && /active-sprint\.publish-[a-f0-9]{32}\.json$/.test(slash(target))) {
      injected = true;
      const error = new Error('simulated failure after supersede WAL validation');
      error.code = 'EIO';
      throw error;
    }
    return originalOpen(target, flags, ...args);
  };
  try {
    expectCode(() => sprint.supersedeActiveSprint(fixture.input), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.openSync = originalOpen;
  }
  assert.strictEqual(injected, true);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
  const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
  const transactionBefore = fs.readFileSync(transactionPath, 'utf8');
  const pendingTransaction = JSON.parse(transactionBefore);
  assert.strictEqual(pendingTransaction.version, 5);
  assert.strictEqual(pendingTransaction.operation, 'supersede');
  assert.strictEqual(pendingTransaction.migration_receipt.mode, 'reference');
  assert.strictEqual(
    pendingTransaction.migration_receipt.sha256,
    fixture.input.migrationReceiptSha256
  );
  assert.strictEqual(
    pendingTransaction.migration_receipt.path,
    fixture.input.migrationReceipt
  );
  const receiptBefore = fs.readFileSync(
    path.join(root, ...fixture.input.migrationReceipt.split('/')),
    'utf8'
  );
  const otherPlan = writePlan(root, 'must-not-init.md');
  const mutations = [
    () => sprint.advanceActiveSprint({
      cwd: root,
      expectedPhase: 'review',
      toPhase: 'compound',
      next: 'must not advance',
    }),
    () => sprint.blockActiveSprint({
      cwd: root,
      expectedPhase: 'compound',
      reason: 'must not replace supersede recovery',
      next: 'must not block',
    }),
    () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
    () => sprint.initActiveSprint({ cwd: root, plan: otherPlan, next: 'must not init' }),
  ];
  for (const mutate of mutations) {
    expectCode(mutate, 'SPRINT_RECOVERY_REQUIRED');
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
    assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), transactionBefore);
    assert.strictEqual(fs.existsSync(completionPath), false);
    assert.strictEqual(
      fs.readFileSync(path.join(root, ...fixture.input.migrationReceipt.split('/')), 'utf8'),
      receiptBefore
    );
  }
  expectCode(
    () => sprint.supersedeActiveSprint({
      ...fixture.input,
      next: 'different recovery parameters',
    }),
    'SPRINT_STATE_CONFLICT'
  );
  assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
  assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), transactionBefore);
  const retried = sprint.supersedeActiveSprint(fixture.input);
  assert.strictEqual(retried.action, 'supersede');
  assert.strictEqual(raw(root).plan, fixture.targetPlan);
  assert.strictEqual(fs.existsSync(completionPath), false);
}));

test('v5 supersede detects target-plan drift immediately after WAL persistence', () =>
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const targetPath = path.join(root, fixture.targetPlan);
    const driftedTargetRaw = `${fixture.targetPlanRaw}<!-- drift after WAL -->\n`;
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let transactionHandle;
    let injected = false;
    fs.openSync = (target, flags, ...args) => {
      const handle = originalOpen(target, flags, ...args);
      if (/^\.active-sprint\.transaction\.json\.stage-[a-f0-9]{32}-[a-f0-9]{32}\.tmp$/
        .test(path.basename(String(target)))
          && String(flags).includes('x')) {
        transactionHandle = handle;
      }
      return handle;
    };
    fs.closeSync = (handle) => {
      const result = originalClose(handle);
      if (!injected && handle === transactionHandle) {
        injected = true;
        fs.writeFileSync(targetPath, driftedTargetRaw);
      }
      return result;
    };
    try {
      expectCode(
        () => sprint.supersedeActiveSprint(fixture.input),
        'SPRINT_RECOVERY_REQUIRED'
      );
    } finally {
      fs.openSync = originalOpen;
      fs.closeSync = originalClose;
    }

    const transactionBefore = fs.readFileSync(transactionPath, 'utf8');
    assert.strictEqual(injected, true);
    assert.strictEqual(
      fs.readFileSync(pointerPath, 'utf8'),
      fixture.pointerRaw
    );
    assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), driftedTargetRaw);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
    assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), transactionBefore);

    fs.writeFileSync(targetPath, fixture.targetPlanRaw);
    const recovered = sprint.supersedeActiveSprint(fixture.input);
    assert.strictEqual(recovered.action, 'supersede');
    assert.strictEqual(raw(root).plan, fixture.targetPlan);
    assert.strictEqual(fs.existsSync(transactionPath), false);
  }));

test('pending v5 supersede rejects source or target plan drift until exact bytes return', () => {
  for (const mode of ['source', 'target']) {
    withWorkspace((root) => {
      const fixture = supersedeFixture(root);
      const originalOpen = fs.openSync;
      let injected = false;
      fs.openSync = (target, flags, ...args) => {
        if (!injected
            && /active-sprint\.publish-[a-f0-9]{32}\.json$/.test(slash(target))) {
          injected = true;
          const error = new Error('leave a pending v5 supersede WAL');
          error.code = 'EIO';
          throw error;
        }
        return originalOpen(target, flags, ...args);
      };
      try {
        expectCode(
          () => sprint.supersedeActiveSprint(fixture.input),
          'SPRINT_RECOVERY_REQUIRED'
        );
      } finally {
        fs.openSync = originalOpen;
      }
      assert.strictEqual(injected, true, mode);

      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
      const transactionBefore = fs.readFileSync(transactionPath, 'utf8');
      const planPath = path.join(
        root,
        mode === 'source' ? fixture.sourcePlan : fixture.targetPlan
      );
      const exactRaw = mode === 'source'
        ? fixture.sourcePlanRaw : fixture.targetPlanRaw;
      const driftedRaw = `${exactRaw}<!-- pending ${mode} drift -->\n`;
      fs.writeFileSync(planPath, driftedRaw);

      expectCode(
        () => sprint.supersedeActiveSprint(fixture.input),
        'SPRINT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), pointerBefore, mode);
      assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), transactionBefore, mode);
      assert.strictEqual(fs.readFileSync(planPath, 'utf8'), driftedRaw, mode);
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required', mode);

      fs.writeFileSync(planPath, exactRaw);
      const recovered = sprint.supersedeActiveSprint(fixture.input);
      assert.strictEqual(recovered.action, 'supersede', mode);
      assert.strictEqual(raw(root).plan, fixture.targetPlan, mode);
      assert.strictEqual(fs.existsSync(transactionPath), false, mode);
    });
  }
});

test('supersede runtime never opens the pre-created receipt for writing', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const originalOpen = fs.openSync;
  let receiptWriteAttempted = false;
  fs.openSync = (target, flags, ...args) => {
    if (slash(target) === slash(path.join(root, ...fixture.input.migrationReceipt.split('/')))
        && String(flags).includes('w')) {
      receiptWriteAttempted = true;
      const error = new Error('receipt write path must be unreachable');
      error.code = 'EACCES';
      throw error;
    }
    return originalOpen(target, flags, ...args);
  };
  try {
    const result = sprint.supersedeActiveSprint(fixture.input);
    assert.strictEqual(result.action, 'supersede');
  } finally {
    fs.openSync = originalOpen;
  }
  assert.strictEqual(receiptWriteAttempted, false);
}));

test('partial pre-created receipt is preserved and rejected before WAL creation', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const receiptPath = path.join(root, ...fixture.input.migrationReceipt.split('/'));
  const prefix = fs.readFileSync(receiptPath).subarray(0, 17);
  fs.writeFileSync(receiptPath, prefix);
  expectCode(() => sprint.supersedeActiveSprint(fixture.input), 'INVALID_SPRINT_MIGRATION_RECEIPT');
  assert.deepStrictEqual(fs.readFileSync(receiptPath), prefix);
  assert.strictEqual(fs.existsSync(path.join(root, sprint.TRANSACTION_RELATIVE_PATH)), false);
  assert.strictEqual(
    fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
    fixture.pointerRaw
  );
}));

test('missing or wrongly named pre-created receipt is rejected without reconstruction', () => {
  for (const mode of ['missing', 'wrong-name']) {
    withWorkspace((root) => {
      const fixture = supersedeFixture(root);
      const receiptPath = path.join(root, ...fixture.input.migrationReceipt.split('/'));
      const wrongPath = `${receiptPath}.wrong`;
      if (mode === 'missing') fs.unlinkSync(receiptPath);
      else fs.renameSync(receiptPath, wrongPath);
      expectCode(
        () => sprint.supersedeActiveSprint(fixture.input),
        'INVALID_SPRINT_MIGRATION_RECEIPT'
      );
      assert.strictEqual(fs.existsSync(receiptPath), false);
      if (mode === 'wrong-name') assert.strictEqual(fs.existsSync(wrongPath), true);
      assert.strictEqual(fs.existsSync(path.join(root, sprint.TRANSACTION_RELATIVE_PATH)), false);
    });
  }
});

test('supersede rejects a historical receipt when approval is expired at the real clock', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const approval = rewriteFixtureApproval(root, fixture, (value) => {
    value.issued_at = '2020-01-01T00:00:00.000Z';
    value.expires_at = '2021-01-01T00:00:00.000Z';
  });
  const input = prepareSupersedeInput(root, {
    ...fixture.input,
    approvalSha256: approval.sha256,
  }, { preparedAt: '2020-06-01T00:00:00.000Z' });
  expectCode(() => sprint.supersedeActiveSprint(input), 'INVALID_SPRINT_APPROVAL');
  assert.strictEqual(fs.existsSync(path.join(root, sprint.TRANSACTION_RELATIVE_PATH)), false);
  assert.strictEqual(
    fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
    fixture.pointerRaw
  );
}));

test('supersede rejects a stale prepared_at even while approval remains valid', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const input = prepareSupersedeInput(
    root,
    fixture.input,
    { preparedAt: '2020-06-01T00:00:00.000Z' }
  );
  expectCode(
    () => sprint.supersedeActiveSprint(input),
    'INVALID_SPRINT_MIGRATION_RECEIPT'
  );
  assert.strictEqual(fs.existsSync(path.join(root, sprint.TRANSACTION_RELATIVE_PATH)), false);
}));

test('supersede rejects a receipt path whose basename is not derived from its digest', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const canonicalPath = path.join(root, ...fixture.input.migrationReceipt.split('/'));
  const wrongRelative = 'docs/plans/.handoff/migration-receipt-copy.json';
  fs.copyFileSync(canonicalPath, path.join(root, ...wrongRelative.split('/')));
  expectCode(
    () => sprint.supersedeActiveSprint({
      ...fixture.input,
      migrationReceipt: wrongRelative,
    }),
    'INVALID_SPRINT_MIGRATION_RECEIPT'
  );
  assert.strictEqual(fs.existsSync(path.join(root, sprint.TRANSACTION_RELATIVE_PATH)), false);
}));

test('complete rejects a compound plan that still declares open tasks', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  expectCode(
    () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
    'ILLEGAL_SPRINT_COMPLETION'
  );
  assert.strictEqual(
    fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
    fixture.pointerRaw
  );
  assert.strictEqual(fs.existsSync(path.join(root, sprint.COMPLETION_RELATIVE_PATH)), false);
}));

test('completion task counts and open identities fail closed unless they prove terminal state', () => {
  const invalidPlans = [
    ['space-indented counts', [
      '  tasks_completed: 0',
      '  tasks_total: 2',
    ]],
    ['tab-indented counts', [
      '\ttasks_completed: 0',
      '\ttasks_total: 2',
    ]],
    ['space-indented identities', [
      'tasks_completed: 1',
      'tasks_total: 1',
      '  task_ids: ["T0"]',
      '  open_task_ids: ["T0"]',
    ]],
    ['missing tasks_total', [
      'tasks_completed: 1',
    ]],
    ['missing tasks_completed', [
      'tasks_total: 1',
    ]],
    ['leading-zero count', [
      'tasks_completed: 01',
      'tasks_total: 1',
    ]],
    ['fractional count', [
      'tasks_completed: 1.0',
      'tasks_total: 1',
    ]],
    ['completed greater than total', [
      'tasks_completed: 2',
      'tasks_total: 1',
    ]],
    ['incomplete count', [
      'tasks_completed: 0',
      'tasks_total: 1',
    ]],
    ['non-empty open_task_ids', [
      'tasks_completed: 1',
      'tasks_total: 1',
      'task_ids: ["T0"]',
      'open_task_ids: ["T0"]',
    ]],
  ];
  for (const [label, metadata] of invalidPlans) {
    withWorkspace((root) => {
      const plan = 'docs/plans/invalid-completion.md';
      fs.writeFileSync(path.join(root, plan), [
        '---',
        'status: in-progress',
        ...metadata,
        '---',
        `# Invalid completion: ${label}`,
        '',
      ].join('\n'));
      sprint.initActiveSprint({
        cwd: root,
        plan,
        restorePhase: 'compound',
        next: 'Audit terminal state',
      });
      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const pointerBefore = fs.readFileSync(pointerPath, 'utf8');

      expectCode(
        () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
        'ILLEGAL_SPRINT_COMPLETION'
      );
      assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), pointerBefore, label);
      assert.strictEqual(
        fs.existsSync(path.join(root, sprint.TRANSACTION_RELATIVE_PATH)),
        false,
        label
      );
      assert.strictEqual(
        fs.existsSync(path.join(root, sprint.COMPLETION_RELATIVE_PATH)),
        false,
        label
      );
    });
  }
});

test('completion accepts a structured one-of-one plan with an empty open-task set', () =>
  withWorkspace((root) => {
    const plan = 'docs/plans/structured-complete.md';
    fs.writeFileSync(path.join(root, plan), [
      '---',
      'status: completed',
      'tasks_completed: 1',
      'tasks_total: 1',
      'task_ids: ["T0"]',
      'open_task_ids: []',
      '---',
      '# Structured completion',
      '',
    ].join('\n'));
    sprint.initActiveSprint({
      cwd: root,
      plan,
      restorePhase: 'compound',
      next: 'Publish completion',
    });

    const result = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
    const completion = JSON.parse(fs.readFileSync(
      path.join(root, sprint.COMPLETION_RELATIVE_PATH),
      'utf8'
    ));
    assert.strictEqual(result.action, 'complete');
    assert.strictEqual(completion.version, 2);
    assert.deepStrictEqual(completion.completion_plan, {
      mode: 'declared',
      sha256: hash(fs.readFileSync(path.join(root, plan))),
      tasks_completed: 1,
      tasks_total: 1,
    });
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
  }));

test('v6 completion commit verification preserves WAL when the record changes during claim cleanup', () => {
  for (const mode of ['missing', 'tampered', 'timestamp']) {
    withWorkspace((root) => {
      const plan = 'docs/plans/completion-record-commit-check.md';
      fs.writeFileSync(path.join(root, plan), [
        '---',
        'status: completed',
        'tasks_completed: 1',
        'tasks_total: 1',
        'task_ids: ["T0"]',
        'open_task_ids: []',
        '---',
        '# Completion record commit check',
        '',
      ].join('\n'));
      sprint.initActiveSprint({
        cwd: root,
        plan,
        restorePhase: 'compound',
        next: 'Complete',
      });
      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      const originalUnlink = fs.unlinkSync;
      let completionRaw;
      let injected = false;
      fs.unlinkSync = (target) => {
        if (!injected && slash(target).endsWith('-pointer/value')) {
          injected = true;
          completionRaw = fs.readFileSync(completionPath, 'utf8');
          if (mode === 'missing') {
            originalUnlink(completionPath);
          } else if (mode === 'tampered') {
            const value = JSON.parse(completionRaw);
            const first = value.expected_sha256[0] === '0' ? '1' : '0';
            value.expected_sha256 = `${first}${value.expected_sha256.slice(1)}`;
            fs.writeFileSync(completionPath, `${JSON.stringify(value)}\n`);
          } else {
            const value = JSON.parse(completionRaw);
            value.completed_at = new Date(Date.parse(value.completed_at) + 1000).toISOString();
            fs.writeFileSync(completionPath, `${JSON.stringify(value)}\n`);
          }
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

      assert.strictEqual(injected, true, mode);
      assert.strictEqual(fs.existsSync(pointerPath), false, mode);
      assert.strictEqual(fs.existsSync(transactionPath), true, mode);
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required', mode);
      if (mode === 'timestamp') {
        const forgedRaw = fs.readFileSync(completionPath, 'utf8');
        expectCode(
          () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
          'SPRINT_RECOVERY_REQUIRED'
        );
        assert.strictEqual(fs.readFileSync(completionPath, 'utf8'), forgedRaw);
        assert.strictEqual(fs.existsSync(transactionPath), true);
      }
      if (mode === 'missing') fs.writeFileSync(completionPath, completionRaw, { flag: 'wx' });
      else fs.writeFileSync(completionPath, completionRaw);

      const recovered = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
      assert.strictEqual(recovered.recovered, true, mode);
      assert.strictEqual(fs.existsSync(transactionPath), false, mode);
      assert.strictEqual(fs.readFileSync(completionPath, 'utf8'), completionRaw, mode);
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint', mode);
    });
  }
});

test('v6 completion commit verification catches plan drift during claim cleanup', () =>
  withWorkspace((root) => {
    const plan = 'docs/plans/completion-plan-commit-check.md';
    const completeRaw = [
      '---',
      'status: completed',
      'tasks_completed: 1',
      'tasks_total: 1',
      'task_ids: ["T0"]',
      'open_task_ids: []',
      '---',
      '# Completion plan commit check',
      '',
    ].join('\n');
    const driftedRaw = completeRaw
      .replace('status: completed', 'status: in-progress')
      .replace('tasks_completed: 1', 'tasks_completed: 0')
      .replace('open_task_ids: []', 'open_task_ids: ["T0"]');
    const planPath = path.join(root, plan);
    fs.writeFileSync(planPath, completeRaw);
    sprint.initActiveSprint({
      cwd: root,
      plan,
      restorePhase: 'compound',
      next: 'Complete',
    });
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const originalUnlink = fs.unlinkSync;
    let injected = false;
    fs.unlinkSync = (target) => {
      const result = originalUnlink(target);
      if (!injected && slash(target).endsWith('-pointer/value')) {
        injected = true;
        fs.writeFileSync(planPath, driftedRaw);
      }
      return result;
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
    assert.strictEqual(fs.existsSync(pointerPath), false);
    assert.strictEqual(fs.existsSync(completionPath), true);
    assert.strictEqual(fs.existsSync(transactionPath), true);
    assert.strictEqual(fs.readFileSync(planPath, 'utf8'), driftedRaw);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');

    fs.writeFileSync(planPath, completeRaw);
    const recovered = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
  }));

test('completion retry replaces only its strict-prefix partial stage', () =>
  withWorkspace((root) => {
    const plan = 'docs/plans/completion-stage-partial-write.md';
    fs.writeFileSync(path.join(root, plan), [
      '---',
      'status: completed',
      'tasks_completed: 1',
      'tasks_total: 1',
      'task_ids: ["T0"]',
      'open_task_ids: []',
      '---',
      '# Completion stage partial write',
      '',
    ].join('\n'));
    sprint.initActiveSprint({
      cwd: root,
      plan,
      restorePhase: 'compound',
      next: 'Complete',
    });
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    let stageHandle;
    let intendedRaw;
    let injected = false;
    fs.openSync = (target, flags, ...args) => {
      const handle = originalOpen(target, flags, ...args);
      if (/^active-sprint\.completed-[a-f0-9]{32}\.tmp$/.test(path.basename(String(target)))
          && String(flags).includes('x')) {
        stageHandle = handle;
      }
      return handle;
    };
    fs.writeFileSync = (target, data, ...args) => {
      if (!injected && target === stageHandle) {
        injected = true;
        intendedRaw = Buffer.from(String(data), 'utf8');
        originalWrite(target, intendedRaw.subarray(0, Math.floor(intendedRaw.length / 3)));
        const error = new Error('simulated completion stage partial write');
        error.code = 'EIO';
        throw error;
      }
      return originalWrite(target, data, ...args);
    };
    try {
      expectCode(
        () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
        'SPRINT_RECOVERY_REQUIRED'
      );
    } finally {
      fs.openSync = originalOpen;
      fs.writeFileSync = originalWrite;
    }

    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    const stagePath = path.join(
      path.dirname(transactionPath),
      `active-sprint.completed-${transaction.token}.tmp`
    );
    const partial = fs.readFileSync(stagePath);
    assert.strictEqual(injected, true);
    assert.ok(partial.length > 0);
    assert.ok(partial.length < intendedRaw.length);
    assert.deepStrictEqual(partial, intendedRaw.subarray(0, partial.length));
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');

    const recovered = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(fs.existsSync(stagePath), false);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
  }));

test('completion plan drift after WAL creation preserves the pointer and recovery evidence', () =>
  withWorkspace((root) => {
    const plan = 'docs/plans/completion-drift-after-wal.md';
    const completeRaw = [
      '---',
      'status: completed',
      'tasks_completed: 1',
      'tasks_total: 1',
      'task_ids: ["T0"]',
      'open_task_ids: []',
      '---',
      '# Complete before WAL',
      '',
    ].join('\n');
    const reopenedRaw = completeRaw
      .replace('status: completed', 'status: in-progress')
      .replace('tasks_completed: 1', 'tasks_completed: 0')
      .replace('open_task_ids: []', 'open_task_ids: ["T0"]');
    fs.writeFileSync(path.join(root, plan), completeRaw);
    sprint.initActiveSprint({
      cwd: root,
      plan,
      restorePhase: 'compound',
      next: 'Complete',
    });
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let transactionHandle;
    let injected = false;
    fs.openSync = (target, flags, ...args) => {
      const handle = originalOpen(target, flags, ...args);
      if (/^\.active-sprint\.transaction\.json\.stage-[a-f0-9]{32}-[a-f0-9]{32}\.tmp$/
        .test(path.basename(String(target)))
          && String(flags).includes('x')) {
        transactionHandle = handle;
      }
      return handle;
    };
    fs.closeSync = (handle) => {
      const result = originalClose(handle);
      if (!injected && handle === transactionHandle) {
        injected = true;
        fs.writeFileSync(path.join(root, plan), reopenedRaw);
      }
      return result;
    };
    try {
      expectCode(
        () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
        'SPRINT_RECOVERY_REQUIRED'
      );
    } finally {
      fs.openSync = originalOpen;
      fs.closeSync = originalClose;
    }

    assert.strictEqual(injected, true);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
    assert.strictEqual(fs.readFileSync(path.join(root, plan), 'utf8'), reopenedRaw);
    assert.strictEqual(fs.existsSync(transactionPath), true);
    assert.strictEqual(fs.existsSync(path.join(root, sprint.COMPLETION_RELATIVE_PATH)), false);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  }));

test('completion retry publishes a durable stage after final-link EIO', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'completion-stage-link-eio.md');
    sprint.initActiveSprint({
      cwd: root,
      plan,
      restorePhase: 'compound',
      next: 'Complete',
    });
    const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const originalLink = fs.linkSync;
    let injected = false;
    fs.linkSync = (source, target) => {
      if (!injected
          && /^active-sprint\.completed-[a-f0-9]{32}\.tmp$/.test(path.basename(String(source)))
          && path.resolve(String(target)) === path.resolve(completionPath)) {
        injected = true;
        const error = new Error('simulated completion final-link failure');
        error.code = 'EIO';
        throw error;
      }
      return originalLink(source, target);
    };
    try {
      expectCode(
        () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
        'SPRINT_RECOVERY_REQUIRED'
      );
    } finally {
      fs.linkSync = originalLink;
    }

    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    const stagePath = path.join(
      path.dirname(transactionPath),
      `active-sprint.completed-${transaction.token}.tmp`
    );
    assert.strictEqual(injected, true);
    assert.strictEqual(fs.existsSync(stagePath), true);
    assert.strictEqual(fs.existsSync(completionPath), false);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');

    const retried = sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
    assert.strictEqual(retried.recovered, true);
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(fs.existsSync(stagePath), false);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
  }));

test('completion EEXIST preserves a valid foreign v1 record and all local evidence', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'completion-foreign-v1.md');
    sprint.initActiveSprint({
      cwd: root,
      plan,
      restorePhase: 'compound',
      next: 'Complete',
    });
    const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const originalLink = fs.linkSync;
    let foreignRaw;
    let stagePath;
    let injected = false;
    fs.linkSync = (source, target) => {
      if (!injected
          && /^active-sprint\.completed-[a-f0-9]{32}\.tmp$/.test(path.basename(String(source)))
          && path.resolve(String(target)) === path.resolve(completionPath)) {
        injected = true;
        stagePath = String(source);
        const staged = JSON.parse(fs.readFileSync(stagePath, 'utf8'));
        const foreignToken = staged.token === 'a'.repeat(32)
          ? 'b'.repeat(32) : 'a'.repeat(32);
        foreignRaw = `${JSON.stringify({
          version: 1,
          token: foreignToken,
          plan: staged.plan,
          phase: staged.phase,
          expected_sha256: staged.expected_sha256,
          completed_at: staged.completed_at,
        })}\n`;
        fs.writeFileSync(completionPath, foreignRaw, { flag: 'wx' });
      }
      return originalLink(source, target);
    };
    try {
      expectCode(
        () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
        'SPRINT_RECOVERY_REQUIRED'
      );
    } finally {
      fs.linkSync = originalLink;
    }

    assert.strictEqual(injected, true);
    assert.strictEqual(fs.readFileSync(completionPath, 'utf8'), foreignRaw);
    assert.strictEqual(fs.existsSync(transactionPath), true);
    assert.strictEqual(fs.existsSync(stagePath), true);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
    expectCode(
      () => sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
    assert.strictEqual(fs.readFileSync(completionPath, 'utf8'), foreignRaw);
    assert.strictEqual(fs.existsSync(transactionPath), true);
    assert.strictEqual(fs.existsSync(stagePath), true);
  }));

test('status fails closed for non-canonical or malformed completion records', () => {
  const mutations = [
    ['unknown field', (value) => `${JSON.stringify({ ...value, unexpected: true })}\n`],
    ['pretty JSON', (value) => `${JSON.stringify(value, null, 2)}\n`],
    ['plan with surrounding whitespace', (value) => `${JSON.stringify({
      ...value,
      plan: ` ${value.plan} `,
    })}\n`],
    ['plan with Windows separators', (value) => `${JSON.stringify({
      ...value,
      plan: value.plan.replace(/\//g, '\\'),
    })}\n`],
    ['invalid completed_at', (value) => `${JSON.stringify({
      ...value,
      completed_at: 'not-a-timestamp',
    })}\n`],
  ];
  for (const [label, mutate] of mutations) {
    withWorkspace((root) => {
      const plan = writePlan(root, 'invalid-completion-status.md');
      sprint.initActiveSprint({
        cwd: root,
        plan,
        restorePhase: 'compound',
        next: 'Complete',
      });
      sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
      const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
      const value = JSON.parse(fs.readFileSync(completionPath, 'utf8'));
      const malformedRaw = mutate(value);
      fs.writeFileSync(completionPath, malformedRaw);

      const status = sprint.readActiveSprint(root);
      assert.strictEqual(status.reason, 'sprint-recovery-required', label);
      const cliStatus = spawnSync(
        process.execPath,
        [cliPath, 'status'],
        { cwd: root, encoding: 'utf8' }
      );
      assert.strictEqual(cliStatus.status, 0, cliStatus.stderr);
      assert.strictEqual(
        JSON.parse(cliStatus.stdout).reason,
        'sprint-recovery-required',
        label
      );
      assert.strictEqual(fs.readFileSync(completionPath, 'utf8'), malformedRaw, label);
    });
  }
});

test('init refuses to hide a completed plan that drifted after completion', () =>
  withWorkspace((root) => {
    const completedPlan = 'docs/plans/completed-before-drift.md';
    const completeRaw = [
      '---',
      'status: completed',
      'tasks_completed: 1',
      'tasks_total: 1',
      'task_ids: ["T0"]',
      'open_task_ids: []',
      '---',
      '# Completed',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, completedPlan), completeRaw);
    sprint.initActiveSprint({
      cwd: root,
      plan: completedPlan,
      restorePhase: 'compound',
      next: 'Complete',
    });
    sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
    const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
    const completionBefore = fs.readFileSync(completionPath, 'utf8');
    fs.writeFileSync(
      path.join(root, completedPlan),
      completeRaw
        .replace('status: completed', 'status: in-progress')
        .replace('tasks_completed: 1', 'tasks_completed: 0')
        .replace('open_task_ids: []', 'open_task_ids: ["T0"]')
    );
    const nextPlan = writePlan(root, 'must-not-publish.md');

    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan: nextPlan, next: 'Think' }),
      'SPRINT_RECOVERY_REQUIRED'
    );
    assert.strictEqual(fs.existsSync(path.join(root, sprint.POINTER_RELATIVE_PATH)), false);
    assert.strictEqual(fs.existsSync(path.join(root, sprint.TRANSACTION_RELATIVE_PATH)), false);
    assert.strictEqual(fs.readFileSync(completionPath, 'utf8'), completionBefore);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  }));

test('status validates migration lineage before reporting a completed plan', () => withWorkspace((root) => {
  const plan = writePlan(root, 'completed-invalid-lineage.md');
  init(root, plan);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  pointer.migration_receipt_sha256 = '1'.repeat(64);
  fs.writeFileSync(pointerPath, `${JSON.stringify(pointer)}\n`);
  fs.writeFileSync(
    path.join(root, plan),
    '---\nstatus: completed\n---\n# Completed but invalid lineage\n'
  );
  const status = sprint.readActiveSprint(root);
  assert.strictEqual(status.active, false);
  assert.strictEqual(status.reason, 'invalid-migration-receipt');
}));

test('legacy v4 supersede recovery fails closed until an operator restores its WAL receipt', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const originalOpen = fs.openSync;
  let injected = false;
  fs.openSync = (target, flags, ...args) => {
    if (!injected && /active-sprint\.publish-[a-f0-9]{32}\.json$/.test(slash(target))) {
      injected = true;
      const error = new Error('leave a pending supersede WAL');
      error.code = 'EIO';
      throw error;
    }
    return originalOpen(target, flags, ...args);
  };
  try {
    expectCode(() => sprint.supersedeActiveSprint(fixture.input), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.openSync = originalOpen;
  }
  assert.strictEqual(injected, true);
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  transaction.version = 4;
  transaction.operation = 'replace';
  transaction.migration_receipt = {
    mode: 'prepare',
    sha256: transaction.migration_receipt.sha256,
    raw: transaction.migration_receipt.raw,
    stage: null,
  };
  const legacyRaw = `${JSON.stringify(transaction)}\n`;
  fs.writeFileSync(transactionPath, legacyRaw);
  const receiptPath = path.join(root, ...fixture.input.migrationReceipt.split('/'));
  const receiptRaw = fs.readFileSync(receiptPath, 'utf8');
  fs.unlinkSync(receiptPath);

  const beforeInspection = fs.readFileSync(transactionPath, 'utf8');
  const inspected = sprint.inspectPendingV4Supersession(root);
  assert.strictEqual(inspected.action, 'inspect-v4-supersede-recovery');
  assert.strictEqual(inspected.receipt.path, fixture.input.migrationReceipt);
  assert.strictEqual(inspected.receipt.sha256, fixture.input.migrationReceiptSha256);
  assert.strictEqual(inspected.receipt.raw, receiptRaw);
  assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), beforeInspection);
  const cliInspection = spawnSync(
    process.execPath,
    [cliPath, 'inspect-v4-supersede-recovery'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.strictEqual(cliInspection.status, 0, cliInspection.stderr);
  assert.deepStrictEqual(JSON.parse(cliInspection.stdout).receipt, inspected.receipt);
  assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), beforeInspection);

  expectCode(() => sprint.supersedeActiveSprint(fixture.input), 'SPRINT_RECOVERY_REQUIRED');
  assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), legacyRaw);
  assert.strictEqual(
    fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
    fixture.pointerRaw
  );

  fs.writeFileSync(receiptPath, inspected.receipt.raw);
  const recovered = sprint.supersedeActiveSprint(fixture.input);
  assert.strictEqual(recovered.action, 'supersede');
  assert.strictEqual(raw(root).plan, fixture.targetPlan);
}));

test('published legacy v4 successor keeps WAL until its exact receipt is restored', () =>
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const receiptPath = path.join(root, ...fixture.input.migrationReceipt.split('/'));
    const receiptRaw = fs.readFileSync(receiptPath, 'utf8');
    const originalLink = fs.linkSync;
    let injected = false;
    fs.linkSync = (source, target) => {
      const result = originalLink(source, target);
      if (!injected
          && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(path.basename(String(source)))
          && path.resolve(String(target)) === path.resolve(pointerPath)) {
        injected = true;
        fs.unlinkSync(receiptPath);
      }
      return result;
    };
    try {
      expectCode(
        () => sprint.supersedeActiveSprint(fixture.input),
        'SPRINT_RECOVERY_REQUIRED'
      );
    } finally {
      fs.linkSync = originalLink;
    }
    assert.strictEqual(injected, true);
    const successorRaw = fs.readFileSync(pointerPath, 'utf8');
    assert.strictEqual(JSON.parse(successorRaw).plan, fixture.targetPlan);

    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    transaction.version = 4;
    transaction.operation = 'replace';
    transaction.migration_receipt = {
      mode: 'prepare',
      sha256: transaction.migration_receipt.sha256,
      raw: transaction.migration_receipt.raw,
      stage: null,
    };
    const legacyRaw = `${JSON.stringify(transaction)}\n`;
    fs.writeFileSync(transactionPath, legacyRaw);

    expectCode(
      () => sprint.supersedeActiveSprint(fixture.input),
      'SPRINT_RECOVERY_REQUIRED'
    );
    assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), legacyRaw);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), successorRaw);
    assert.strictEqual(fs.existsSync(receiptPath), false);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');

    fs.writeFileSync(receiptPath, receiptRaw, { flag: 'wx' });
    const recovered = sprint.supersedeActiveSprint(fixture.input);
    assert.strictEqual(recovered.action, 'supersede');
    assert.strictEqual(recovered.alreadySuperseded, true);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), successorRaw);
    assert.strictEqual(fs.readFileSync(receiptPath, 'utf8'), receiptRaw);
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(sprint.readActiveSprint(root).active, true);
  }));

test('v4 recovery inspection rejects v5, corrupt, and symlink WAL without mutation', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const originalOpen = fs.openSync;
  let injected = false;
  fs.openSync = (target, flags, ...args) => {
    if (!injected && /active-sprint\.publish-[a-f0-9]{32}\.json$/.test(slash(target))) {
      injected = true;
      const error = new Error('leave v5 WAL for inspection rejection');
      error.code = 'EIO';
      throw error;
    }
    return originalOpen(target, flags, ...args);
  };
  try {
    expectCode(() => sprint.supersedeActiveSprint(fixture.input), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.openSync = originalOpen;
  }
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const v5Raw = fs.readFileSync(transactionPath, 'utf8');
  expectCode(() => sprint.inspectPendingV4Supersession(root), 'SPRINT_RECOVERY_REQUIRED');
  assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), v5Raw);

  const corruptRaw = '{not-canonical-json\n';
  fs.writeFileSync(transactionPath, corruptRaw);
  expectCode(() => sprint.inspectPendingV4Supersession(root), 'SPRINT_RECOVERY_REQUIRED');
  assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), corruptRaw);

  const outside = path.join(root, 'outside-v4-wal.json');
  fs.writeFileSync(outside, v5Raw);
  fs.unlinkSync(transactionPath);
  try {
    fs.symlinkSync(outside, transactionPath, 'file');
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
    throw error;
  }
  expectCode(() => sprint.inspectPendingV4Supersession(root), 'SPRINT_RECOVERY_REQUIRED');
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), v5Raw);
  assert.strictEqual(fs.lstatSync(transactionPath).isSymbolicLink(), true);
}));

test('a second supersede accepts normal plan progress while preserving receipt ancestry', () => withWorkspace((root) => {
  const firstFixture = supersedeFixture(root);
  const first = sprint.supersedeActiveSprint(firstFixture.input);
  const sourceTaskIds = [
    ...Array.from({ length: 10 }, (_, index) => `W${index}`),
    'T16', 'T17', 'R18',
  ];
  const evolvedSourceRaw = firstFixture.targetPlanRaw
    .replace('status: draft', 'status: in-progress')
    .replace('tasks_completed: 0', 'tasks_completed: 12')
    .replace(
      `open_task_ids: ${JSON.stringify(sourceTaskIds)}`,
      'open_task_ids: ["R18"]'
    );
  fs.writeFileSync(path.join(root, firstFixture.targetPlan), evolvedSourceRaw);
  reach(root, 'compound');
  sprint.blockActiveSprint({
    cwd: root,
    expectedPhase: 'compound',
    reason: 'One task remains',
    next: 'Supersede with the remaining task',
  });

  const sourcePointerRaw = fs.readFileSync(
    path.join(root, sprint.POINTER_RELATIVE_PATH),
    'utf8'
  );
  const nextPlan = 'docs/plans/next.md';
  const nextPlanRaw = [
    '---',
    'type: sprint',
    'status: draft',
    'tasks_completed: 0',
    'tasks_total: 1',
    'task_ids: ["R18"]',
    'open_task_ids: ["R18"]',
    '---',
    '# Next',
    '| R18 | remaining task |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, nextPlan), nextPlanRaw);
  const mapping = writeCanonicalJson(root, 'docs/plans/.handoff/task-map-second.json', {
    schema_version: 'sprint-task-map/v1',
    source: {
      plan: firstFixture.targetPlan,
      plan_sha256: hash(evolvedSourceRaw),
      tasks_completed: 12,
      tasks_total: 13,
    },
    target: {
      plan: nextPlan,
      plan_sha256: hash(nextPlanRaw),
      tasks_completed: 0,
      tasks_total: 1,
    },
    source_tasks: sourceTaskIds.map((id, index) => ({
      id,
      disposition: index < 12 ? 'preserved_completed' : 'migrated_open',
      target_ids: index < 12 ? [] : ['R18'],
    })),
    target_tasks: [{
      id: 'R18',
      status: 'open',
      origin: 'migrated',
      source_ids: ['R18'],
    }],
    goal_preserved: true,
  });
  const messageSha256 = hash('approve second supersede');
  const nextAction = 'Run the second successor Think phase';
  const approval = writeCanonicalJson(root, 'docs/plans/.handoff/owner-approval-second.json', {
    schema_version: 'sprint-owner-approval/v2',
    decision: 'approve_supersede',
    trust_boundary: 'local_host_observation',
    cryptographic_verification: false,
    source_assurance: 'explicit',
    message_locator: {
      schema_version: 'sprint-message-locator/v1',
      thread_id: 'test-thread',
      locator: `thread:test-thread#message-sha256:${messageSha256}`,
      message_sha256: messageSha256,
      hash_profile: 'sha256-utf8-v1',
    },
    issued_at: '2020-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    source: {
      pointer_sha256: hash(sourcePointerRaw),
      plan: firstFixture.targetPlan,
      plan_sha256: hash(evolvedSourceRaw),
      phase: 'compound',
      status: 'blocked',
      tasks_completed: 12,
      tasks_total: 13,
      open_task_ids: ['R18'],
    },
    target: {
      plan: nextPlan,
      plan_sha256: hash(nextPlanRaw),
      phase: 'think',
      status: 'active',
      acceptance_protocol: 'v1',
      tasks_completed: 0,
      tasks_total: 1,
      next: nextAction,
    },
    task_map_sha256: mapping.sha256,
    goal_preserved: true,
  });

  const second = sprint.supersedeActiveSprint(prepareSupersedeInput(root, {
    cwd: root,
    expectedPhase: 'compound',
    expectedPointerSha256: hash(sourcePointerRaw),
    oldPlanSha256: hash(evolvedSourceRaw),
    plan: nextPlan,
    newPlanSha256: hash(nextPlanRaw),
    taskMap: mapping.relative,
    taskMapSha256: mapping.sha256,
    approvalReceipt: approval.relative,
    approvalSha256: approval.sha256,
    next: nextAction,
  }));
  const secondReceipt = JSON.parse(fs.readFileSync(
    migrationReceiptPath(root, second.pointer.migration_receipt_sha256),
    'utf8'
  ));
  assert.strictEqual(secondReceipt.previous_migration_receipt_sha256, first.migrationReceiptSha256);
  assert.notStrictEqual(secondReceipt.source.plan_sha256, firstFixture.targetPlanSha256);
}));

test('completion retains successor migration lineage without completing the predecessor', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  sprint.supersedeActiveSprint(fixture.input);
  const receiptSha256 = raw(root).migration_receipt_sha256;
  for (const [expectedPhase, toPhase] of [
    ['think', 'plan'],
    ['plan', 'work'],
    ['work', 'review'],
    ['review', 'compound'],
  ]) {
    sprint.advanceActiveSprint({
      cwd: root,
      expectedPhase,
      toPhase,
      next: `Continue ${toPhase}`,
    });
  }
  const completedPlanRaw = fs.readFileSync(path.join(root, fixture.targetPlan), 'utf8')
    .replace('status: draft', 'status: completed')
    .replace('tasks_completed: 0', 'tasks_completed: 13')
    .replace(
      /open_task_ids: \[[^\r\n]*\]/,
      'open_task_ids: []'
    );
  fs.writeFileSync(path.join(root, fixture.targetPlan), completedPlanRaw);
  sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });

  const completion = JSON.parse(fs.readFileSync(
    path.join(root, sprint.COMPLETION_RELATIVE_PATH),
    'utf8'
  ));
  assert.strictEqual(completion.plan, fixture.targetPlan);
  assert.strictEqual(completion.migration_receipt_sha256, receiptSha256);
  assert.strictEqual(fs.readFileSync(path.join(root, fixture.sourcePlan), 'utf8'), fixture.sourcePlanRaw);
  const status = sprint.readActiveSprint(root);
  assert.strictEqual(status.reason, 'completed-sprint');
  assert.strictEqual(status.plan, fixture.targetPlan);
  assert.strictEqual(status.migrationReceiptSha256, receiptSha256);
}));

test('status fails closed when a committed migration receipt is missing or tampered', () => {
  for (const mode of ['missing', 'tampered']) {
    withWorkspace((root) => {
      const fixture = supersedeFixture(root);
      sprint.supersedeActiveSprint(fixture.input);
      const digest = raw(root).migration_receipt_sha256;
      const receiptPath = migrationReceiptPath(root, digest);
      if (mode === 'missing') fs.unlinkSync(receiptPath);
      else fs.appendFileSync(receiptPath, 'tamper');
      const status = sprint.readActiveSprint(root);
      assert.strictEqual(status.active, false);
      assert.strictEqual(status.reason, 'invalid-migration-receipt');
      expectCode(
        () => sprint.advanceActiveSprint({
          cwd: root,
          expectedPhase: 'think',
          toPhase: 'plan',
          next: 'must not advance',
        }),
        'INVALID_SPRINT_MIGRATION_RECEIPT'
      );
    });
  }
});

test('v5 supersede keeps its WAL after post-link receipt loss and exact bytes recover it', () => {
  for (const mode of ['missing', 'tampered']) {
    withWorkspace((root) => {
      const fixture = supersedeFixture(root);
      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      const receiptPath = path.join(root, ...fixture.input.migrationReceipt.split('/'));
      const receiptRaw = fs.readFileSync(receiptPath, 'utf8');
      const originalLink = fs.linkSync;
      let injected = false;
      fs.linkSync = (source, target) => {
        const result = originalLink(source, target);
        if (!injected
            && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(path.basename(String(source)))
            && path.resolve(String(target)) === path.resolve(pointerPath)) {
          injected = true;
          if (mode === 'missing') fs.unlinkSync(receiptPath);
          else fs.appendFileSync(receiptPath, 'tampered-after-pointer-link');
        }
        return result;
      };
      try {
        expectCode(
          () => sprint.supersedeActiveSprint(fixture.input),
          'SPRINT_RECOVERY_REQUIRED'
        );
      } finally {
        fs.linkSync = originalLink;
      }

      const transactionBefore = fs.readFileSync(transactionPath, 'utf8');
      const successorBefore = fs.readFileSync(pointerPath, 'utf8');
      assert.strictEqual(injected, true, mode);
      assert.strictEqual(JSON.parse(successorBefore).plan, fixture.targetPlan, mode);
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required', mode);
      assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), transactionBefore, mode);

      fs.writeFileSync(receiptPath, receiptRaw);
      const recovered = sprint.supersedeActiveSprint(fixture.input);
      assert.strictEqual(recovered.action, 'supersede', mode);
      assert.strictEqual(recovered.alreadySuperseded, true, mode);
      assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), successorBefore, mode);
      assert.strictEqual(fs.readFileSync(receiptPath, 'utf8'), receiptRaw, mode);
      assert.strictEqual(fs.existsSync(transactionPath), false, mode);
      assert.strictEqual(sprint.readActiveSprint(root).active, true, mode);
    });
  }
});

test('supersede rejects a completed successor even when every digest matches', () => withWorkspace((root) => {
  const fixture = supersedeFixture(root);
  const completedRaw = fixture.targetPlanRaw.replace('status: draft', 'status: completed');
  fs.writeFileSync(path.join(root, fixture.targetPlan), completedRaw);
  const mappingValue = JSON.parse(fixture.mapping.serialized);
  mappingValue.target.plan_sha256 = hash(completedRaw);
  const mapping = writeCanonicalJson(root, fixture.mapping.relative, mappingValue);
  const approvalValue = JSON.parse(fixture.approval.serialized);
  approvalValue.target.plan_sha256 = hash(completedRaw);
  approvalValue.task_map_sha256 = mapping.sha256;
  const approval = writeCanonicalJson(root, fixture.approval.relative, approvalValue);
  expectCode(
    () => sprint.supersedeActiveSprint({
      ...fixture.input,
      newPlanSha256: hash(completedRaw),
      taskMapSha256: mapping.sha256,
      approvalSha256: approval.sha256,
    }),
    'ILLEGAL_SPRINT_SUPERSESSION'
  );
}));

test('migration receipt readback rejects identical source and target plan paths', () =>
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    const result = sprint.supersedeActiveSprint(fixture.input);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const pointer = raw(root);
    const receipt = JSON.parse(fs.readFileSync(
      migrationReceiptPath(root, result.pointer.migration_receipt_sha256),
      'utf8'
    ));
    receipt.target.plan = receipt.source.plan;
    const receiptRaw = `${JSON.stringify(receipt)}\n`;
    const receiptSha256 = hash(receiptRaw);
    fs.writeFileSync(migrationReceiptPath(root, receiptSha256), receiptRaw);
    pointer.migration_receipt_sha256 = receiptSha256;
    fs.writeFileSync(pointerPath, `${JSON.stringify(pointer)}\n`);

    const status = sprint.readActiveSprint(root);
    assert.strictEqual(status.reason, 'invalid-migration-receipt');
    assert.match(status.detail, /supersede source and target plans must be distinct files/);
  }));

test('ordinary commit verifier preserves WAL for missing or tampered pointer and exact retry succeeds', () => {
  for (const mode of ['missing', 'tampered']) {
    withWorkspace((root) => {
      const plan = writePlan(root, `ordinary-${mode}.md`);
      init(root, plan);
      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const request = {
        cwd: root,
        expectedPhase: 'think',
        toPhase: 'plan',
        next: 'Exact recovered plan request',
        now: '2026-09-11T01:02:03.000Z',
      };
      const originalUnlink = fs.unlinkSync;
      let replacementRaw;
      let injected = false;
      fs.unlinkSync = (target) => {
        if (!injected && slash(target).endsWith('-transaction/value')) {
          injected = true;
          replacementRaw = fs.readFileSync(pointerPath, 'utf8');
          if (mode === 'missing') {
            originalUnlink(pointerPath);
          } else {
            const foreign = JSON.parse(replacementRaw);
            foreign.next = 'Foreign committed pointer';
            fs.writeFileSync(pointerPath, `${JSON.stringify(foreign)}\n`);
          }
        }
        return originalUnlink(target);
      };
      try {
        expectCode(() => sprint.advanceActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
      } finally {
        fs.unlinkSync = originalUnlink;
      }

      assert.strictEqual(injected, true, mode);
      const evidence = transactionClaimEvidence(root);
      assert.ok(evidence && evidence.raw, mode);
      const transaction = JSON.parse(evidence.raw);
      assert.strictEqual(transaction.operation, 'replace', mode);
      assert.strictEqual(transaction.replacement_raw, replacementRaw, mode);
      assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required', mode);

      fs.writeFileSync(pointerPath, replacementRaw, mode === 'missing' ? { flag: 'wx' } : undefined);
      const recovered = sprint.advanceActiveSprint(request);
      assert.strictEqual(recovered.action, 'advance', mode);
      assert.strictEqual(recovered.recovered, true, mode);
      assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), replacementRaw, mode);
      assert.strictEqual(transactionClaimEvidence(root), null, mode);
    });
  }
});

test('ordinary commit preserves every WAL claim anchor when terminal drift occurs at tombstone release', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'ordinary-final-tombstone-verifier.md');
    init(root, plan);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const request = {
      cwd: root,
      expectedPhase: 'think',
      toPhase: 'plan',
      next: 'Recover after final tombstone verification',
      now: '2026-09-11T01:12:13.000Z',
    };
    const originalLstat = fs.lstatSync;
    let tombstoneReads = 0;
    let replacementRaw;
    let injected = false;
    fs.lstatSync = (target, ...args) => {
      const result = originalLstat(target, ...args);
      if (slash(target).endsWith('-transaction/delete-tombstone')) {
        tombstoneReads += 1;
        if (!injected && tombstoneReads === 4) {
          injected = true;
          replacementRaw = fs.readFileSync(pointerPath, 'utf8');
          const foreign = JSON.parse(replacementRaw);
          foreign.next = 'Foreign pointer at final tombstone boundary';
          fs.writeFileSync(pointerPath, `${JSON.stringify(foreign)}\n`);
        }
      }
      return result;
    };
    try {
      expectCode(() => sprint.advanceActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.lstatSync = originalLstat;
    }

    assert.strictEqual(injected, true);
    const evidence = transactionClaimEvidence(root);
    assert.ok(evidence && evidence.raw);
    assert.strictEqual(fs.existsSync(path.join(evidence.slotPath, 'value')), true);
    assert.strictEqual(
      fs.existsSync(path.join(evidence.slotPath, 'delete-tombstone')),
      true
    );
    assert.strictEqual(fs.existsSync(path.join(evidence.slotPath, 'intent.json')), true);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(pointerPath, 'utf8')).next,
      'Foreign pointer at final tombstone boundary'
    );
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');

    fs.writeFileSync(pointerPath, replacementRaw);
    const recovered = sprint.advanceActiveSprint(request);
    assert.strictEqual(recovered.action, 'advance');
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), replacementRaw);
    assert.strictEqual(transactionClaimEvidence(root), null);
  }));

test('ordinary recovery commits WAL but rejects a different retry request', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'ordinary-different-retry.md');
    init(root, plan);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const request = {
      cwd: root,
      expectedPhase: 'think',
      toPhase: 'plan',
      next: 'Original request',
      now: '2026-09-11T02:03:04.000Z',
    };
    const originalUnlink = fs.unlinkSync;
    let replacementRaw;
    fs.unlinkSync = (target) => {
      if (!replacementRaw && slash(target).endsWith('-transaction/value')) {
        replacementRaw = fs.readFileSync(pointerPath, 'utf8');
        const foreign = JSON.parse(replacementRaw);
        foreign.next = 'Temporary foreign pointer';
        fs.writeFileSync(pointerPath, `${JSON.stringify(foreign)}\n`);
      }
      return originalUnlink(target);
    };
    try {
      expectCode(() => sprint.advanceActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    fs.writeFileSync(pointerPath, replacementRaw);

    expectCode(
      () => sprint.advanceActiveSprint({ ...request, next: 'Different request' }),
      'SPRINT_PHASE_CONFLICT'
    );
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), replacementRaw);
    assert.strictEqual(transactionClaimEvidence(root), null);
  }));

test('transaction-bound WAL claim retry never bypasses the terminal verifier', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'transaction-verifier-retry.md');
    init(root, plan);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const request = {
      cwd: root,
      expectedPhase: 'think',
      toPhase: 'plan',
      next: 'Verify every WAL destroy attempt',
      now: '2026-09-11T03:04:05.000Z',
    };
    const originalUnlink = fs.unlinkSync;
    let replacementRaw;
    let injections = 0;
    fs.unlinkSync = (target) => {
      if (slash(target).endsWith('-transaction/value')) {
        injections += 1;
        replacementRaw = replacementRaw || fs.readFileSync(pointerPath, 'utf8');
        const foreign = JSON.parse(replacementRaw);
        foreign.next = `Verifier drift ${injections}`;
        fs.writeFileSync(pointerPath, `${JSON.stringify(foreign)}\n`);
      }
      return originalUnlink(target);
    };
    try {
      expectCode(() => sprint.advanceActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
      const firstEvidence = transactionClaimEvidence(root);
      assert.ok(firstEvidence && firstEvidence.raw);
      fs.writeFileSync(pointerPath, replacementRaw);

      expectCode(() => sprint.advanceActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
      const secondEvidence = transactionClaimEvidence(root);
      assert.ok(secondEvidence && secondEvidence.raw);
      assert.strictEqual(secondEvidence.raw, firstEvidence.raw);
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.strictEqual(injections, 2);
    fs.writeFileSync(pointerPath, replacementRaw);
    const recovered = sprint.advanceActiveSprint(request);
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(transactionClaimEvidence(root), null);
  }));

test('canonical WAL staged-exclusive failures never publish partial JSON and exact retry converges', () => {
  for (const mode of ['write-before', 'partial', 'write-after', 'fsync', 'close']) {
    withWorkspace((root) => {
      const plan = writePlan(root, `wal-${mode}.md`);
      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      const originalOpen = fs.openSync;
      const originalWrite = fs.writeFileSync;
      const originalFsync = fs.fsyncSync;
      const originalClose = fs.closeSync;
      let stageHandle;
      let injected = false;
      fs.openSync = (target, flags, ...args) => {
        const handle = originalOpen(target, flags, ...args);
        if (isTransactionStagePath(target) && String(flags).includes('x')) stageHandle = handle;
        return handle;
      };
      fs.writeFileSync = (target, data, ...args) => {
        if (!injected && target === stageHandle
            && ['write-before', 'partial', 'write-after'].includes(mode)) {
          injected = true;
          const bytes = Buffer.from(String(data), args[0] || 'utf8');
          if (mode === 'partial') {
            originalWrite(target, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 3))));
          } else if (mode === 'write-after') {
            originalWrite(target, data, ...args);
          }
          const error = new Error(`simulated WAL ${mode}`);
          error.code = 'EIO';
          throw error;
        }
        return originalWrite(target, data, ...args);
      };
      fs.fsyncSync = (handle) => {
        if (!injected && mode === 'fsync' && handle === stageHandle) {
          injected = true;
          const error = new Error('simulated WAL fsync');
          error.code = 'EIO';
          throw error;
        }
        return originalFsync(handle);
      };
      fs.closeSync = (handle) => {
        if (!injected && mode === 'close' && handle === stageHandle) {
          const result = originalClose(handle);
          injected = true;
          const error = new Error('simulated WAL close');
          error.code = 'EIO';
          error.result = result;
          throw error;
        }
        return originalClose(handle);
      };
      try {
        expectCode(() => sprint.initActiveSprint({
          cwd: root,
          plan,
          next: 'Exact staged retry',
          now: '2026-09-11T04:05:06.000Z',
        }), 'SPRINT_RECOVERY_REQUIRED');
      } finally {
        fs.openSync = originalOpen;
        fs.writeFileSync = originalWrite;
        fs.fsyncSync = originalFsync;
        fs.closeSync = originalClose;
      }

      assert.strictEqual(injected, true, mode);
      assert.strictEqual(fs.existsSync(transactionPath), false, mode);
      const recovered = sprint.initActiveSprint({
        cwd: root,
        plan,
        next: 'Exact staged retry',
        now: '2026-09-11T04:05:06.000Z',
      });
      assert.strictEqual(recovered.action, 'init', mode);
      assert.strictEqual(sprint.readActiveSprint(root).plan, plan, mode);
    });
  }
});

test('init preserves the prior completion through WAL, publish, and pointer-link failures', () => {
  for (const mode of ['wal', 'publish', 'link']) {
    withWorkspace((root) => {
      const completedPlan = writeCompletedPlan(root, `prior-${mode}.md`);
      sprint.initActiveSprint({
        cwd: root,
        plan: completedPlan,
        restorePhase: 'compound',
        next: 'Complete prior sprint',
        now: '2026-09-11T05:00:00.000Z',
      });
      sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
      const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
      const completionRaw = fs.readFileSync(completionPath, 'utf8');
      const nextPlan = writePlan(root, `next-${mode}.md`);
      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const originalOpen = fs.openSync;
      const originalLink = fs.linkSync;
      let injected = false;
      fs.openSync = (target, ...args) => {
        if (!injected && (mode === 'wal' && isTransactionStagePath(target)
            || mode === 'publish'
              && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(
                path.basename(String(target))
              ))) {
          injected = true;
          const error = new Error(`simulated init ${mode} failure`);
          error.code = 'EIO';
          throw error;
        }
        return originalOpen(target, ...args);
      };
      fs.linkSync = (source, target) => {
        if (!injected && mode === 'link'
            && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(
              path.basename(String(source))
            )
            && path.resolve(String(target)) === path.resolve(pointerPath)) {
          injected = true;
          const error = new Error('simulated init pointer link failure');
          error.code = 'EIO';
          throw error;
        }
        return originalLink(source, target);
      };
      try {
        expectCode(() => sprint.initActiveSprint({
          cwd: root,
          plan: nextPlan,
          next: 'Start next sprint',
          now: '2026-09-11T05:01:00.000Z',
        }), 'SPRINT_RECOVERY_REQUIRED');
      } finally {
        fs.openSync = originalOpen;
        fs.linkSync = originalLink;
      }

      assert.strictEqual(injected, true, mode);
      assert.strictEqual(fs.readFileSync(completionPath, 'utf8'), completionRaw, mode);
    });
  }
});

test('init consumes an exact prior completion only after the new pointer commits', () =>
  withWorkspace((root) => {
    const completedPlan = writeCompletedPlan(root, 'prior-success.md');
    sprint.initActiveSprint({
      cwd: root,
      plan: completedPlan,
      restorePhase: 'compound',
      next: 'Complete prior sprint',
      now: '2026-09-11T05:10:00.000Z',
    });
    sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
    const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
    assert.strictEqual(fs.existsSync(completionPath), true);
    const nextPlan = writePlan(root, 'next-success.md');

    const result = sprint.initActiveSprint({
      cwd: root,
      plan: nextPlan,
      next: 'Start committed next sprint',
      now: '2026-09-11T05:11:00.000Z',
    });
    assert.strictEqual(result.action, 'init');
    assert.strictEqual(fs.existsSync(completionPath), false);
    assert.strictEqual(sprint.readActiveSprint(root).plan, nextPlan);
  }));

test('v7 init restores the prior completion when terminal drift occurs at tombstone release', () =>
  withWorkspace((root) => {
    const completedPlan = writeCompletedPlan(root, 'prior-final-tombstone-verifier.md');
    sprint.initActiveSprint({
      cwd: root,
      plan: completedPlan,
      restorePhase: 'compound',
      next: 'Complete prior sprint',
      now: '2026-09-11T05:12:00.000Z',
    });
    sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
    const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
    const completionRaw = fs.readFileSync(completionPath, 'utf8');
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const nextPlan = writePlan(root, 'next-final-tombstone-verifier.md');
    const request = {
      cwd: root,
      plan: nextPlan,
      next: 'Recover prior completion after final tombstone verification',
      now: '2026-09-11T05:13:00.000Z',
    };
    const originalLstat = fs.lstatSync;
    let tombstoneReads = 0;
    let intendedPointerRaw;
    let injected = false;
    fs.lstatSync = (target, ...args) => {
      const result = originalLstat(target, ...args);
      if (slash(target).endsWith('-prior-completion/delete-tombstone')) {
        tombstoneReads += 1;
        if (!injected && tombstoneReads === 4) {
          injected = true;
          intendedPointerRaw = fs.readFileSync(pointerPath, 'utf8');
          const foreign = JSON.parse(intendedPointerRaw);
          foreign.next = 'Foreign committed init pointer at final tombstone boundary';
          fs.writeFileSync(pointerPath, `${JSON.stringify(foreign)}\n`);
        }
      }
      return result;
    };
    try {
      expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.lstatSync = originalLstat;
    }

    assert.strictEqual(injected, true);
    const stateDirectory = path.dirname(transactionPath);
    const claimName = fs.readdirSync(stateDirectory).find((entry) =>
      /^active-sprint\.claim-[a-f0-9]{32}-prior-completion$/.test(entry));
    assert.strictEqual(claimName, undefined);
    assert.strictEqual(fs.existsSync(transactionPath), true);
    assert.strictEqual(fs.readFileSync(completionPath, 'utf8'), completionRaw);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(pointerPath, 'utf8')).next,
      'Foreign committed init pointer at final tombstone boundary'
    );
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');

    fs.writeFileSync(pointerPath, intendedPointerRaw);
    const recovered = sprint.initActiveSprint(request);
    assert.strictEqual(recovered.action, 'init');
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(fs.existsSync(completionPath), false);
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(sprint.readActiveSprint(root).plan, nextPlan);
  }));

test('ordinary abort restore preserves old pointer bytes across final anchor race', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'restore-anchor-race.md');
    const successorPlan = writePlan(root, 'restore-anchor-successor.md');
    init(root, plan);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
    const successorRaw = `${JSON.stringify(pointerFor(
      successorPlan,
      'think',
      'Concurrent restore successor'
    ))}\n`;
    const request = {
      cwd: root,
      expectedPhase: 'think',
      toPhase: 'plan',
      next: 'Restore with a durable anchor',
      now: '2026-09-11T02:30:00.000Z',
    };
    const originalLink = fs.linkSync;
    let publishBlocked = false;
    fs.linkSync = (source, target) => {
      if (!publishBlocked
          && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(
            path.basename(String(source))
          )
          && path.resolve(String(target)) === path.resolve(pointerPath)) {
        publishBlocked = true;
        const error = new Error('leave replace pending before pointer publish');
        error.code = 'EIO';
        throw error;
      }
      return originalLink(source, target);
    };
    try {
      expectCode(() => sprint.advanceActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.linkSync = originalLink;
    }
    assert.strictEqual(publishBlocked, true);
    assert.strictEqual(fs.existsSync(pointerPath), false);
    assert.strictEqual(fs.existsSync(transactionPath), true);

    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    const claimValuePath = path.join(
      path.dirname(transactionPath),
      ...transaction.claim.split('/')
    );
    const restoreGuardPath = path.join(path.dirname(claimValuePath), 'restore-guard');
    const originalRead = fs.readFileSync;
    const originalUnlink = fs.unlinkSync;
    let sourceReplaced = false;
    let anchoredSourceReads = 0;
    fs.readFileSync = (target, ...args) => {
      if (!sourceReplaced
          && typeof target !== 'number'
          && path.resolve(String(target)) === path.resolve(pointerPath)
          && fs.existsSync(restoreGuardPath)
          && !fs.existsSync(claimValuePath)) {
        anchoredSourceReads += 1;
      }
      if (!sourceReplaced && anchoredSourceReads === 3) {
        sourceReplaced = true;
        originalUnlink(pointerPath);
        fs.writeFileSync(pointerPath, successorRaw, { flag: 'wx' });
      }
      return originalRead(target, ...args);
    };
    try {
      expectCode(() => sprint.advanceActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.strictEqual(sourceReplaced, true);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), successorRaw);
    assert.strictEqual(fs.existsSync(transactionPath), true);
    assert.strictEqual(fs.readFileSync(claimValuePath, 'utf8'), pointerBefore);
    assert.strictEqual(fs.readFileSync(restoreGuardPath, 'utf8'), pointerBefore);
  }));

test('v7 abort restore preserves prior completion bytes across final anchor race', () =>
  withWorkspace((root) => {
    const completedPlan = writeCompletedPlan(root, 'prior-restore-anchor-race.md');
    sprint.initActiveSprint({
      cwd: root,
      plan: completedPlan,
      restorePhase: 'compound',
      next: 'Complete prior sprint',
      now: '2026-09-11T05:42:00.000Z',
    });
    sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
    const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
    const completionBefore = fs.readFileSync(completionPath, 'utf8');
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const paths = privateClaim.ensureStateDirectory(root);
    const nextPlan = writePlan(root, 'next-restore-anchor-race.md');
    const request = {
      cwd: root,
      plan: nextPlan,
      next: 'Abort with a durable prior completion anchor',
      now: '2026-09-11T05:43:00.000Z',
    };
    const originalLink = fs.linkSync;
    let publishBlocked = false;
    fs.linkSync = (source, target) => {
      if (!publishBlocked
          && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(
            path.basename(String(source))
          )
          && path.resolve(String(target)) === path.resolve(pointerPath)) {
        publishBlocked = true;
        const error = new Error('leave v7 init pending before pointer publish');
        error.code = 'EIO';
        throw error;
      }
      return originalLink(source, target);
    };
    try {
      expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.linkSync = originalLink;
    }
    assert.strictEqual(publishBlocked, true);
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    assert.strictEqual(transaction.version, 7);
    fs.unlinkSync(path.join(paths.stateDirectory, transaction.publish));
    const completionSnapshot = privateClaim.readStableRecoverySnapshot(completionPath);
    const priorClaim = privateClaim.createPrivateClaim(paths, {
      scopeToken: transaction.token,
      artifact: 'prior-completion',
      sourcePath: completionPath,
      snapshot: completionSnapshot,
    });
    assert.strictEqual(fs.existsSync(completionPath), false);

    const successorRaw = `${JSON.stringify({
      version: 2,
      token: 'f'.repeat(32),
      plan: completedPlan,
      phase: 'compound',
      expected_sha256: 'e'.repeat(64),
      completed_at: '2026-09-11T05:42:30.000Z',
      completion_plan: {
        mode: 'declared',
        sha256: hash(fs.readFileSync(path.join(root, completedPlan))),
        tasks_completed: 1,
        tasks_total: 1,
      },
    })}\n`;
    const originalRead = fs.readFileSync;
    const originalUnlink = fs.unlinkSync;
    let sourceReplaced = false;
    let anchoredSourceReads = 0;
    fs.readFileSync = (target, ...args) => {
      if (!sourceReplaced
          && typeof target !== 'number'
          && path.resolve(String(target)) === path.resolve(completionPath)
          && fs.existsSync(priorClaim.restoreGuardPath)
          && !fs.existsSync(priorClaim.valuePath)) {
        anchoredSourceReads += 1;
      }
      if (!sourceReplaced && anchoredSourceReads === 3) {
        sourceReplaced = true;
        originalUnlink(completionPath);
        fs.writeFileSync(completionPath, successorRaw, { flag: 'wx' });
      }
      return originalRead(target, ...args);
    };
    try {
      expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.strictEqual(sourceReplaced, true);
    assert.strictEqual(fs.readFileSync(completionPath, 'utf8'), successorRaw);
    assert.strictEqual(fs.existsSync(transactionPath), true);
    assert.strictEqual(fs.readFileSync(priorClaim.valuePath, 'utf8'), completionBefore);
    assert.strictEqual(
      fs.readFileSync(priorClaim.restoreGuardPath, 'utf8'),
      completionBefore
    );
  }));

test('replace and supersede retries merge a duplicated pointer claim source', () => {
  for (const mode of ['replace', 'supersede']) {
    withWorkspace((root) => {
      let mutate;
      let expectedAction;
      let expectedPlan;
      if (mode === 'replace') {
        const plan = writePlan(root, 'duplicate-replace-pointer.md');
        init(root, plan);
        mutate = () => sprint.advanceActiveSprint({
          cwd: root,
          expectedPhase: 'think',
          toPhase: 'plan',
          next: 'Merge duplicated pointer claim',
          now: '2026-09-11T00:30:00.000Z',
        });
        expectedAction = 'advance';
        expectedPlan = plan;
      } else {
        const fixture = supersedeFixture(root);
        mutate = () => sprint.supersedeActiveSprint(fixture.input);
        expectedAction = 'supersede';
        expectedPlan = fixture.targetPlan;
      }
      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      const originalLink = fs.linkSync;
      let injected = false;
      fs.linkSync = (source, target) => {
        if (!injected
            && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(
              path.basename(String(source))
            )
            && path.resolve(String(target)) === path.resolve(pointerPath)) {
          injected = true;
          const error = new Error(`leave ${mode} pending before pointer publish`);
          error.code = 'EIO';
          throw error;
        }
        return originalLink(source, target);
      };
      try {
        expectCode(mutate, 'SPRINT_RECOVERY_REQUIRED');
      } finally {
        fs.linkSync = originalLink;
      }
      assert.strictEqual(injected, true, mode);
      const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
      const stateDirectory = path.dirname(transactionPath);
      const claimPath = path.join(stateDirectory, ...transaction.claim.split('/'));
      const claimSlotPath = path.dirname(claimPath);
      const publishPath = path.join(stateDirectory, transaction.publish);
      fs.linkSync(claimPath, pointerPath);
      const claimStat = fs.lstatSync(claimPath);
      const pointerStat = fs.lstatSync(pointerPath);
      assert.strictEqual(
        `${claimStat.dev}:${claimStat.ino}`,
        `${pointerStat.dev}:${pointerStat.ino}`,
        mode
      );

      const recovered = mutate();
      assert.strictEqual(recovered.action, expectedAction, mode);
      assert.strictEqual(sprint.readActiveSprint(root).plan, expectedPlan, mode);
      assert.strictEqual(fs.existsSync(transactionPath), false, mode);
      assert.strictEqual(fs.existsSync(claimSlotPath), false, mode);
      assert.strictEqual(fs.existsSync(publishPath), false, mode);
    });
  }
});

test('completion retry continues from a duplicated pointer claim source', () =>
  withWorkspace((root) => {
    const plan = writeCompletedPlan(root, 'duplicate-completion-pointer.md');
    sprint.initActiveSprint({
      cwd: root,
      plan,
      restorePhase: 'compound',
      next: 'Complete after duplicate recovery',
      now: '2026-09-11T00:40:00.000Z',
    });
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const originalRename = fs.renameSync;
    let duplicated = false;
    fs.renameSync = (source, target, ...args) => {
      const result = originalRename(source, target, ...args);
      if (!duplicated
          && path.resolve(String(source)) === path.resolve(pointerPath)
          && slash(target).endsWith('-pointer/value')) {
        duplicated = true;
        fs.linkSync(target, source);
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
    assert.strictEqual(duplicated, true);
    assert.strictEqual(fs.existsSync(pointerPath), true);
    assert.strictEqual(fs.existsSync(transactionPath), true);

    const recovered = sprint.completeActiveSprint({
      cwd: root,
      expectedPhase: 'compound',
    });
    assert.strictEqual(recovered.action, 'complete');
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(fs.existsSync(pointerPath), false);
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'completed-sprint');
  }));

test('v3 partial retry merges a duplicated partial claim source', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'v3-partial-duplicate-source.md');
    leavePartialInitTransaction(root, plan, 'ENOSPC');
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    const stateDirectory = path.dirname(transactionPath);
    const publishPath = path.join(stateDirectory, transaction.publish);
    const partialPath = path.join(stateDirectory, ...transaction.partial.split('/'));
    const slotPath = path.dirname(partialPath);
    fs.linkSync(partialPath, publishPath);
    const partialStat = fs.lstatSync(partialPath);
    const publishStat = fs.lstatSync(publishPath);
    assert.strictEqual(
      `${partialStat.dev}:${partialStat.ino}`,
      `${publishStat.dev}:${publishStat.ino}`
    );

    const recovered = sprint.initActiveSprint({ cwd: root, plan, next: 'Think' });
    assert.strictEqual(recovered.action, 'init');
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(fs.existsSync(slotPath), false);
    assert.strictEqual(fs.existsSync(publishPath), false);
    assert.strictEqual(sprint.readActiveSprint(root).plan, plan);
  }));

function v7PriorCompletionDuplicateFixture(root, { committed }) {
  const completedPlan = writeCompletedPlan(
    root,
    committed ? 'prior-duplicate-committed.md' : 'prior-duplicate-pre-commit.md'
  );
  sprint.initActiveSprint({
    cwd: root,
    plan: completedPlan,
    restorePhase: 'compound',
    next: 'Complete prior sprint',
    now: '2026-09-11T05:12:00.000Z',
  });
  sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
  const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
  const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
  const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
  const paths = privateClaim.ensureStateDirectory(root);
  const nextPlan = writePlan(
    root,
    committed ? 'next-duplicate-committed.md' : 'next-duplicate-pre-commit.md'
  );
  const request = {
    cwd: root,
    plan: nextPlan,
    next: committed ? 'Recover committed duplicate' : 'Recover pre-commit duplicate',
    now: '2026-09-11T05:13:00.000Z',
  };
  const originalLink = fs.linkSync;
  let linkInjected = false;
  fs.linkSync = (source, target) => {
    if (!linkInjected
        && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(path.basename(String(source)))
        && path.resolve(String(target)) === path.resolve(pointerPath)) {
      linkInjected = true;
      const error = new Error('leave v7 init pending before pointer link');
      error.code = 'EIO';
      throw error;
    }
    return originalLink(source, target);
  };
  try {
    expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
  } finally {
    fs.linkSync = originalLink;
  }
  assert.strictEqual(linkInjected, true);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  assert.strictEqual(transaction.version, 7);
  const completionSnapshot = privateClaim.readStableRecoverySnapshot(completionPath);
  const claim = privateClaim.createPrivateClaim(paths, {
    scopeToken: transaction.token,
    artifact: 'prior-completion',
    sourcePath: completionPath,
    snapshot: completionSnapshot,
  });
  fs.linkSync(claim.valuePath, completionPath);
  const duplicateSnapshot = privateClaim.readStableRecoverySnapshot(completionPath);
  assert.strictEqual(
    `${duplicateSnapshot.stat.dev}:${duplicateSnapshot.stat.ino}`,
    `${claim.value.stat.dev}:${claim.value.stat.ino}`
  );
  const publishPath = path.join(paths.stateDirectory, transaction.publish);
  if (committed) fs.linkSync(publishPath, pointerPath);
  return {
    claim,
    completionPath,
    pointerPath,
    publishPath,
    request,
    transactionPath,
  };
}

test('v7 pre-commit retry converges a duplicated prior-completion rename prefix', () =>
  withWorkspace((root) => {
    const fixture = v7PriorCompletionDuplicateFixture(root, { committed: false });
    const recovered = sprint.initActiveSprint(fixture.request);
    assert.strictEqual(recovered.action, 'init');
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(fs.existsSync(fixture.completionPath), false);
    assert.strictEqual(fs.existsSync(fixture.claim.slotPath), false);
    assert.strictEqual(fs.existsSync(fixture.transactionPath), false);
  }));

test('v7 committed retry converges a duplicated prior-completion rename prefix', () =>
  withWorkspace((root) => {
    const fixture = v7PriorCompletionDuplicateFixture(root, { committed: true });
    const recovered = sprint.initActiveSprint(fixture.request);
    assert.strictEqual(recovered.action, 'init');
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(fs.existsSync(fixture.completionPath), false);
    assert.strictEqual(fs.existsSync(fixture.claim.slotPath), false);
    assert.strictEqual(fs.existsSync(fixture.transactionPath), false);
    assert.strictEqual(fs.existsSync(fixture.publishPath), false);
    assert.strictEqual(sprint.readActiveSprint(root).plan, fixture.request.plan);
  }));

test('init WAL survives committed-pointer prior-completion cleanup failure and plan drift', () =>
  withWorkspace((root) => {
    const completedPlan = writeCompletedPlan(root, 'prior-cleanup-recovery.md');
    sprint.initActiveSprint({
      cwd: root,
      plan: completedPlan,
      restorePhase: 'compound',
      next: 'Complete prior sprint',
      now: '2026-09-11T05:20:00.000Z',
    });
    sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
    const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const nextPlan = writePlan(root, 'next-cleanup-recovery.md');
    const request = {
      cwd: root,
      plan: nextPlan,
      next: 'Recover committed init cleanup',
      now: '2026-09-11T05:21:00.000Z',
    };
    const originalUnlink = fs.unlinkSync;
    let injected = false;
    fs.unlinkSync = (target) => {
      const normalized = slash(target);
      if (!injected
          && /-(?:prior-)?completion\/value$/.test(normalized)
          && fs.existsSync(pointerPath)
          && JSON.parse(fs.readFileSync(pointerPath, 'utf8')).plan === nextPlan) {
        injected = true;
        const error = new Error('simulated committed init prior-completion cleanup failure');
        error.code = 'EIO';
        throw error;
      }
      return originalUnlink(target);
    };
    try {
      expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.unlinkSync = originalUnlink;
    }

    assert.strictEqual(injected, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(pointerPath, 'utf8')).plan, nextPlan);
    assert.strictEqual(fs.existsSync(transactionPath), true);
    fs.appendFileSync(path.join(root, completedPlan), '\npost-commit historical drift\n');

    const recovered = sprint.initActiveSprint(request);
    assert.strictEqual(recovered.action, 'init');
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(sprint.readActiveSprint(root).plan, nextPlan);
    assert.strictEqual(fs.existsSync(completionPath), false);
    assert.strictEqual(fs.existsSync(transactionPath), false);
  }));

test('committed init exact retry converges after prior-completion metadata cleanup prefixes', () => {
  for (const mode of ['intent-before', 'intent-after', 'rmdir-before', 'rmdir-after']) {
    withWorkspace((root) => {
      const completedPlan = writeCompletedPlan(root, `prior-metadata-${mode}.md`);
      sprint.initActiveSprint({
        cwd: root,
        plan: completedPlan,
        restorePhase: 'compound',
        next: 'Complete prior sprint',
        now: '2026-09-11T05:30:00.000Z',
      });
      sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
      const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
      const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
      const nextPlan = writePlan(root, `next-metadata-${mode}.md`);
      const request = {
        cwd: root,
        plan: nextPlan,
        next: `Recover metadata prefix ${mode}`,
        now: '2026-09-11T05:31:00.000Z',
      };
      const originalUnlink = fs.unlinkSync;
      const originalRmdir = fs.rmdirSync;
      const originalFsync = fs.fsyncSync;
      let injected = false;
      let afterEffect = false;
      const pointerCommitted = () => fs.existsSync(pointerPath)
        && JSON.parse(fs.readFileSync(pointerPath, 'utf8')).plan === nextPlan;
      fs.unlinkSync = (target) => {
        if (!injected && pointerCommitted()
            && /-prior-completion\/intent\.json$/.test(slash(target))
            && mode.startsWith('intent-')) {
          if (mode === 'intent-before') {
            injected = true;
            const error = new Error('simulated prior-completion intent unlink failure');
            error.code = 'EIO';
            throw error;
          }
          const result = originalUnlink(target);
          afterEffect = true;
          return result;
        }
        return originalUnlink(target);
      };
      fs.rmdirSync = (target) => {
        if (!injected && pointerCommitted()
            && /-prior-completion$/.test(slash(target))
            && mode.startsWith('rmdir-')) {
          if (mode === 'rmdir-before') {
            injected = true;
            const error = new Error('simulated prior-completion slot rmdir failure');
            error.code = 'EIO';
            throw error;
          }
          const result = originalRmdir(target);
          afterEffect = true;
          return result;
        }
        return originalRmdir(target);
      };
      fs.fsyncSync = (handle) => {
        if (!injected && afterEffect) {
          injected = true;
          afterEffect = false;
          const error = new Error('simulated metadata after-effect fsync failure');
          error.code = 'EIO';
          throw error;
        }
        return originalFsync(handle);
      };
      try {
        expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
      } finally {
        fs.unlinkSync = originalUnlink;
        fs.rmdirSync = originalRmdir;
        fs.fsyncSync = originalFsync;
      }
      assert.strictEqual(injected, true, mode);
      assert.strictEqual(fs.existsSync(transactionPath), true, mode);
      fs.appendFileSync(path.join(root, completedPlan), `\nmetadata drift ${mode}\n`);

      const recovered = sprint.initActiveSprint(request);
      assert.strictEqual(recovered.recovered, true, mode);
      assert.strictEqual(sprint.readActiveSprint(root).plan, nextPlan, mode);
      assert.strictEqual(fs.existsSync(transactionPath), false, mode);
    });
  }
});

test('v7 init abort preserves WAL when restored prior completion changes during cleanup', () =>
  withWorkspace((root) => {
    const completedPlan = writeCompletedPlan(root, 'prior-abort-verifier.md');
    sprint.initActiveSprint({
      cwd: root,
      plan: completedPlan,
      restorePhase: 'compound',
      next: 'Complete prior sprint',
      now: '2026-09-11T05:40:00.000Z',
    });
    sprint.completeActiveSprint({ cwd: root, expectedPhase: 'compound' });
    const completionPath = path.join(root, sprint.COMPLETION_RELATIVE_PATH);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const stateDirectory = path.dirname(transactionPath);
    const nextPlan = writePlan(root, 'next-abort-verifier.md');
    const request = {
      cwd: root,
      plan: nextPlan,
      next: 'Abort only with exact prior completion',
      now: '2026-09-11T05:41:00.000Z',
    };
    const originalLink = fs.linkSync;
    let linkInjected = false;
    fs.linkSync = (source, target) => {
      if (!linkInjected
          && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(
            path.basename(String(source))
          )
          && path.resolve(String(target)) === path.resolve(pointerPath)) {
        linkInjected = true;
        const error = new Error('leave v7 init pending before pointer link');
        error.code = 'EIO';
        throw error;
      }
      return originalLink(source, target);
    };
    try {
      expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.linkSync = originalLink;
    }
    assert.strictEqual(linkInjected, true);
    assert.strictEqual(fs.existsSync(completionPath), true);
    const publishName = fs.readdirSync(stateDirectory)
      .find((name) => /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(name));
    assert.ok(publishName);
    fs.unlinkSync(path.join(stateDirectory, publishName));

    const originalUnlink = fs.unlinkSync;
    let completionTampered = false;
    fs.unlinkSync = (target) => {
      if (!completionTampered && /-transaction\/value$/.test(slash(target))) {
        completionTampered = true;
        originalUnlink(completionPath);
      }
      return originalUnlink(target);
    };
    try {
      expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.strictEqual(completionTampered, true);
    assert.strictEqual(fs.existsSync(pointerPath), false);
    assert.ok(
      fs.existsSync(transactionPath) || transactionClaimEvidence(root),
      'exact WAL evidence must survive a failed abort verifier'
    );
  }));

test('init recovery rejects foreign EEXIST pointer and exact intended retry converges', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'init-eexist-intended.md');
    const foreignPlan = writePlan(root, 'init-eexist-foreign.md');
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const stateDirectory = path.dirname(transactionPath);
    const request = {
      cwd: root,
      plan,
      next: 'Exact intended init',
      now: '2026-09-11T06:00:00.000Z',
    };
    const originalLink = fs.linkSync;
    let initialFailure = false;
    fs.linkSync = (source, target) => {
      if (!initialFailure
          && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(
            path.basename(String(source))
          )
          && path.resolve(String(target)) === path.resolve(pointerPath)) {
        initialFailure = true;
        const error = new Error('leave pending init before pointer link');
        error.code = 'EIO';
        throw error;
      }
      return originalLink(source, target);
    };
    try {
      expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.linkSync = originalLink;
    }
    assert.strictEqual(initialFailure, true);
    const transactionRaw = fs.readFileSync(transactionPath, 'utf8');
    const publishName = fs.readdirSync(stateDirectory)
      .find((name) => /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(name));
    assert.ok(publishName);
    const publishPath = path.join(stateDirectory, publishName);
    const publishRaw = fs.readFileSync(publishPath, 'utf8');
    const foreignRaw = `${JSON.stringify(pointerFor(
      foreignPlan,
      'think',
      'Foreign EEXIST pointer'
    ))}\n`;

    let raced = false;
    fs.linkSync = (source, target) => {
      if (!raced
          && path.resolve(String(source)) === path.resolve(publishPath)
          && path.resolve(String(target)) === path.resolve(pointerPath)) {
        raced = true;
        fs.writeFileSync(pointerPath, foreignRaw, { flag: 'wx' });
      }
      return originalLink(source, target);
    };
    try {
      expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.linkSync = originalLink;
    }
    assert.strictEqual(raced, true);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), foreignRaw);
    assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), transactionRaw);
    assert.strictEqual(fs.readFileSync(publishPath, 'utf8'), publishRaw);

    fs.unlinkSync(pointerPath);
    let copiedRaced = false;
    fs.linkSync = (source, target) => {
      if (!copiedRaced
          && path.resolve(String(source)) === path.resolve(publishPath)
          && path.resolve(String(target)) === path.resolve(pointerPath)) {
        copiedRaced = true;
        fs.writeFileSync(pointerPath, publishRaw, { flag: 'wx' });
      }
      return originalLink(source, target);
    };
    try {
      expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.linkSync = originalLink;
    }
    assert.strictEqual(copiedRaced, true);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), publishRaw);
    assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), transactionRaw);
    assert.strictEqual(fs.readFileSync(publishPath, 'utf8'), publishRaw);
    const copiedPointerStat = fs.lstatSync(pointerPath);
    const ownedPublishStat = fs.lstatSync(publishPath);
    assert.notStrictEqual(
      `${copiedPointerStat.dev}:${copiedPointerStat.ino}`,
      `${ownedPublishStat.dev}:${ownedPublishStat.ino}`
    );

    fs.unlinkSync(pointerPath);
    let exactRaced = false;
    fs.linkSync = (source, target) => {
      if (!exactRaced
          && path.resolve(String(source)) === path.resolve(publishPath)
          && path.resolve(String(target)) === path.resolve(pointerPath)) {
        exactRaced = true;
        originalLink(source, target);
      }
      return originalLink(source, target);
    };
    let recovered;
    try {
      recovered = sprint.initActiveSprint(request);
    } finally {
      fs.linkSync = originalLink;
    }
    assert.strictEqual(exactRaced, true);
    assert.strictEqual(recovered.action, 'init');
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), publishRaw);
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(fs.existsSync(publishPath), false);
  }));

test('atomic publish rejects a swapped candidate inode and preserves WAL plus predecessor claim', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'publish-swap.md');
    init(root, plan);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const predecessorRaw = fs.readFileSync(pointerPath, 'utf8');
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const stateDirectory = path.dirname(transactionPath);
    const foreign = pointerFor(plan, 'plan', 'Swapped foreign candidate');
    foreign.updated_at = '2026-09-11T06:10:00.000Z';
    const foreignRaw = `${JSON.stringify(foreign)}\n`;
    const originalLink = fs.linkSync;
    const originalUnlink = fs.unlinkSync;
    let swapped = false;
    fs.linkSync = (source, target) => {
      if (!swapped
          && /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(
            path.basename(String(source))
          )
          && path.resolve(String(target)) === path.resolve(pointerPath)) {
        swapped = true;
        originalUnlink(source);
        fs.writeFileSync(source, foreignRaw, { flag: 'wx' });
      }
      return originalLink(source, target);
    };
    try {
      expectCode(() => sprint.advanceActiveSprint({
        cwd: root,
        expectedPhase: 'think',
        toPhase: 'plan',
        next: 'Intended candidate',
        now: '2026-09-11T06:11:00.000Z',
      }), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.linkSync = originalLink;
    }

    assert.strictEqual(swapped, true);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), foreignRaw);
    const transactionRaw = fs.readFileSync(transactionPath, 'utf8');
    const transaction = JSON.parse(transactionRaw);
    assert.notStrictEqual(transaction.replacement_raw, foreignRaw);
    assert.strictEqual(
      fs.readFileSync(path.join(stateDirectory, ...transaction.claim.split('/')), 'utf8'),
      predecessorRaw
    );
    assert.strictEqual(
      fs.readFileSync(path.join(stateDirectory, transaction.publish), 'utf8'),
      foreignRaw
    );
    assert.strictEqual(sprint.readActiveSprint(root).reason, 'sprint-recovery-required');
  }));

test('valid WAL recovery cleans an unrelated standalone delete claim', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'valid-wal-unrelated-claim.md');
    leaveUnpublishedInitTransaction(root, plan);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const transactionRaw = fs.readFileSync(transactionPath, 'utf8');
    const fixture = privateDeleteFixture(root, '71717171717171717171717171717171');
    const unrelated = claimPrivateDeleteFixture(fixture);
    assert.strictEqual(fs.existsSync(unrelated.slotPath), true);

    const recovered = sprint.initActiveSprint({
      cwd: root,
      plan,
      next: 'Recover valid WAL',
      now: '2026-09-11T06:20:00.000Z',
    });
    assert.strictEqual(recovered.action, 'init');
    assert.strictEqual(fs.existsSync(unrelated.slotPath), false);
    assert.notStrictEqual(
      fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
      transactionRaw
    );
  }));

test('invalid canonical WAL does not clean any private claim', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'invalid-wal-preserves-claim.md');
    const fixture = privateDeleteFixture(root, '72727272727272727272727272727272');
    const claim = claimPrivateDeleteFixture(fixture);
    const intentRaw = fs.readFileSync(claim.intentPath, 'utf8');
    const valueRaw = fs.readFileSync(claim.valuePath, 'utf8');
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    fs.writeFileSync(transactionPath, '{invalid WAL\n');

    expectCode(() => sprint.initActiveSprint({
      cwd: root,
      plan,
      next: 'Must not clean claims',
    }), 'SPRINT_RECOVERY_REQUIRED');
    assert.strictEqual(fs.readFileSync(transactionPath, 'utf8'), '{invalid WAL\n');
    assert.strictEqual(fs.readFileSync(claim.intentPath, 'utf8'), intentRaw);
    assert.strictEqual(fs.readFileSync(claim.valuePath, 'utf8'), valueRaw);
    assert.strictEqual(fs.existsSync(fixture.sourcePath), false);
  }));

test('unpublished init rechecks absent mutation evidence at the WAL destroy boundary', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'unpublished-init-destroy-race.md');
    leaveUnpublishedInitTransaction(root, plan);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const transactionRaw = fs.readFileSync(transactionPath, 'utf8');
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const successorRaw = `${JSON.stringify(pointerFor(
      plan,
      'think',
      'Concurrent init successor'
    ))}\n`;
    const originalUnlink = fs.unlinkSync;
    let injected = false;
    fs.unlinkSync = (target) => {
      if (!injected && slash(target).endsWith('-transaction/value')) {
        injected = true;
        fs.writeFileSync(pointerPath, successorRaw, { flag: 'wx' });
      }
      return originalUnlink(target);
    };
    try {
      expectCode(() => sprint.initActiveSprint({
        cwd: root,
        plan,
        next: 'Think',
      }), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.strictEqual(injected, true);
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), successorRaw);
    const evidence = transactionClaimEvidence(root);
    assert.ok(evidence && evidence.raw);
    assert.strictEqual(evidence.raw, transactionRaw);

    fs.unlinkSync(pointerPath);
    const recovered = sprint.initActiveSprint({ cwd: root, plan, next: 'Think' });
    assert.strictEqual(recovered.action, 'init');
    assert.strictEqual(transactionClaimEvidence(root), null);
    assert.strictEqual(sprint.readActiveSprint(root).plan, plan);
  }));

test('legacy v1 committed pointer recovers after publish cleanup left only WAL', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'legacy-v1-publish-cleaned.md');
    leaveUnpublishedInitTransaction(root, plan);
    const transactionPath = path.join(root, sprint.TRANSACTION_RELATIVE_PATH);
    const pointerPath = path.join(root, sprint.POINTER_RELATIVE_PATH);
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    const replacementRaw = transaction.replacement_raw;
    delete transaction.partial;
    delete transaction.replacement_raw;
    transaction.version = 1;
    fs.writeFileSync(transactionPath, `${JSON.stringify(transaction)}\n`);
    fs.writeFileSync(pointerPath, replacementRaw, { flag: 'wx' });

    expectCode(
      () => sprint.initActiveSprint({ cwd: root, plan, next: 'Think' }),
      'SPRINT_ALREADY_ACTIVE'
    );
    assert.strictEqual(fs.readFileSync(pointerPath, 'utf8'), replacementRaw);
    assert.strictEqual(fs.existsSync(transactionPath), false);
    assert.strictEqual(sprint.readActiveSprint(root).plan, plan);
  }));

test('modern init exact retry succeeds after publish cleanup and WAL destroy failure', () =>
  withWorkspace((root) => {
    const plan = writePlan(root, 'modern-init-wal-destroy.md');
    const request = {
      cwd: root,
      plan,
      next: 'Exact modern init retry',
      now: '2026-09-11T06:30:00.000Z',
    };
    const originalUnlink = fs.unlinkSync;
    let injected = false;
    fs.unlinkSync = (target) => {
      if (!injected && slash(target).endsWith('-transaction/value')) {
        injected = true;
        const error = new Error('simulated init WAL destroy failure');
        error.code = 'EIO';
        throw error;
      }
      return originalUnlink(target);
    };
    try {
      expectCode(() => sprint.initActiveSprint(request), 'SPRINT_RECOVERY_REQUIRED');
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.strictEqual(injected, true);
    const evidence = transactionClaimEvidence(root);
    assert.ok(evidence && evidence.raw);
    const transaction = JSON.parse(evidence.raw);
    assert.strictEqual(transaction.operation, 'init');
    const stateDirectory = path.dirname(path.join(root, sprint.TRANSACTION_RELATIVE_PATH));
    assert.strictEqual(
      fs.readdirSync(stateDirectory)
        .some((name) => /^active-sprint\.publish-[a-f0-9]{32}\.json$/.test(name)),
      false
    );

    const recovered = sprint.initActiveSprint(request);
    assert.strictEqual(recovered.action, 'init');
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(transactionClaimEvidence(root), null);
    assert.strictEqual(
      fs.readFileSync(path.join(root, sprint.POINTER_RELATIVE_PATH), 'utf8'),
      transaction.replacement_raw
    );
  }));

test('migration receipt readback rejects source and target plan hardlinks', () =>
  withWorkspace((root) => {
    const fixture = supersedeFixture(root);
    sprint.supersedeActiveSprint(fixture.input);
    const sourcePath = path.join(root, ...fixture.sourcePlan.split('/'));
    const targetPath = path.join(root, ...fixture.targetPlan.split('/'));
    fs.unlinkSync(targetPath);
    try {
      fs.linkSync(sourcePath, targetPath);
    } catch (error) {
      fs.writeFileSync(targetPath, fixture.targetPlanRaw);
      if (['EACCES', 'EPERM', 'ENOSYS', 'EXDEV', 'ENOTSUP'].includes(error && error.code)) return;
      throw error;
    }

    const status = sprint.readActiveSprint(root);
    assert.strictEqual(status.reason, 'invalid-migration-receipt');
    assert.match(status.detail, /supersede source and target plans must be distinct files/);
  }));

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const { name, error } of failures) {
    console.error(`\n  [${name}]\n  ${error.stack || error.message}`);
  }
  process.exit(1);
}
