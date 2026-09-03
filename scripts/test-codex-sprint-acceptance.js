#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const acceptanceEvaluator = require('./agent-orchestrator/acceptance-evaluator');
const validationRunner = require('./agent-orchestrator/validation-runner');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');
const { stableHash } = require('./lib/self-learning-canonical');
const sprint = require('./lib/codex-active-sprint');
const sprintAcceptance = require('./lib/codex-sprint-acceptance');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sprint-acceptance-workspace-'));
const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sprint-acceptance-control-'));

try {
  const plansDir = path.join(workspace, 'docs', 'plans');
  const planFile = path.join(plansDir, 'demo.md');
  const runDir = path.join(workspace, '.runs', 'sprint-contract');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'pass.js'), 'process.exitCode = 0;\n');
  fs.writeFileSync(planFile, [
    '# Demo',
    sprintAcceptance.START_MARKER,
    '- [ ] sprint output passes validation',
    sprintAcceptance.END_MARKER,
    '',
  ].join('\n'));

  const source = {
    goal: 'demo sprint',
    globalAcceptance: ['sprint output passes validation'],
    acceptanceContract: {
      criteria: [{
        id: 'ac-sprint-pass',
        statement: 'sprint output passes validation',
        sourceRefs: ['global-contract.json#/globalAcceptance/0'],
        oracle: {
          type: 'command',
          procedure: 'node pass.js',
          expected: 'exit code is zero',
        },
      }],
    },
  };
  const controlStoreOptions = { providerRoot: workspace, controlRoot };
  const recorded = acceptanceEvaluator.recordAcceptanceContract({
    kind: 'global-contract',
    workdir: workspace,
    runDir,
    source,
    controlStoreOptions,
  });
  assert.strictEqual(recorded.status, 'written');

  sprint.initActiveSprint({
    cwd: workspace,
    plan: 'docs/plans/demo.md',
    restorePhase: 'plan',
    next: 'bind acceptance',
    acceptanceProtocol: 'v1',
    now: '2026-09-01T00:00:00.000Z',
  });
  sprintAcceptance.bindSprintAcceptance({
    cwd: workspace,
    plan: 'docs/plans/demo.md',
    runDir,
    controlRoot,
  });
  sprint.advanceActiveSprint({
    cwd: workspace,
    expectedPhase: 'plan',
    toPhase: 'work',
    next: 'implement',
    controlRoot,
    now: '2026-09-01T00:00:01.000Z',
  });
  sprint.advanceActiveSprint({
    cwd: workspace,
    expectedPhase: 'work',
    toPhase: 'review',
    next: 'evaluate receipt',
    now: '2026-09-01T00:00:02.000Z',
  });
  assert.throws(() => sprint.advanceActiveSprint({
    cwd: workspace,
    expectedPhase: 'review',
    toPhase: 'compound',
    next: 'compound',
    controlRoot,
    now: '2026-09-01T00:00:03.000Z',
  }), /authority readback is incomplete|passed authoritative Receipt/);

  const validation = validationRunner.runValidationCommands(['node pass.js'], {
    workdir: workspace,
    runDir,
    attemptId: 'sprint-pass',
  });
  const workspaceSnapshot = {
    headSha: stableHash('head'),
    changedFilesHash: stableHash([]),
    diffHash: stableHash(''),
  };
  const validationSeal = acceptanceEvaluator.sealValidationEvidence({
    workdir: workspace,
    runDir,
    contract: recorded.contract,
    validation,
    workspaceSnapshot,
    controlStoreOptions,
  });
  const subject = {
    ref: 'result:sprint-contract:review',
    schemaVersion: 'sprint-review-subject-v1',
    workspaceSnapshot,
  };
  const receipt = acceptanceEvaluator.recordShadowAcceptance({
    workdir: workspace,
    runDir,
    relativeDir: '.',
    controlStoreOptions,
    validationSeal,
    subjectRef: subject.ref,
    subject,
    createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
  });
  assert.strictEqual(receipt.status, 'written', JSON.stringify(receipt));
  assert.strictEqual(receipt.receipt.overallStatus, 'passed');

  sprint.advanceActiveSprint({
    cwd: workspace,
    expectedPhase: 'review',
    toPhase: 'compound',
    next: 'compound',
    controlRoot,
    now: '2026-09-01T00:00:04.000Z',
  });
  assert.strictEqual(sprint.readActiveSprint(workspace).phase, 'compound');

  fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf8').replace(
    'sprint output passes validation',
    'tampered acceptance statement'
  ));
  assert.throws(() => sprintAcceptance.verifySprintAcceptance({
    cwd: workspace,
    plan: 'docs/plans/demo.md',
    controlRoot,
  }), /stale|do not match/);

  console.log('[OK] Codex Sprint v1 binds freeze authority and gates compound on durable Receipt');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(controlRoot, { recursive: true, force: true });
}
