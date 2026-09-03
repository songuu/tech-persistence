#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const acceptanceEvaluator = require('./agent-orchestrator/acceptance-evaluator');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');
const validationRunner = require('./agent-orchestrator/validation-runner');
const feedback = require('./lib/acceptance-feedback');
const behavior = require('./lib/behavior-events');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { resolveStoreDir } = require('./lib/self-learning-store');
const { stableHash } = require('./lib/self-learning-canonical');
const { readCases } = require('./lib/skill-eval-cases');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-feedback-workspace-'));
const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-feedback-control-'));
const baseDir = path.join(
  process.cwd(),
  `.tmp-acceptance-feedback-store-${process.pid}-${Date.now()}`
);
fs.mkdirSync(baseDir, { recursive: true });

try {
  for (const args of [
    ['init'],
    ['config', 'user.email', 'feedback@example.invalid'],
    ['config', 'user.name', 'Acceptance Feedback Test'],
  ]) {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  }
  fs.writeFileSync(path.join(workspace, 'fail.js'), 'process.exitCode = 1;\n');
  const runDir = path.join(workspace, '.runs', 'failed-run');
  fs.mkdirSync(runDir, { recursive: true });
  const contractRecord = acceptanceEvaluator.recordAcceptanceContract({
    kind: 'global-contract',
    workdir: workspace,
    runDir,
    source: {
      goal: 'feedback fixture',
      globalAcceptance: ['the fixed behavior passes'],
      acceptanceContract: {
        criteria: [{
          id: 'ac-fixed-behavior',
          statement: 'the fixed behavior passes',
          sourceRefs: ['global-contract.json#/globalAcceptance/0'],
          oracle: {
            type: 'command',
            procedure: 'node fail.js',
            expected: 'exit code is zero',
          },
        }],
      },
    },
    controlStoreOptions: { providerRoot: workspace, controlRoot },
  });
  assert.strictEqual(contractRecord.status, 'written');
  const validation = validationRunner.runValidationCommands(['node fail.js'], {
    workdir: workspace,
    runDir,
    attemptId: 'feedback-fail',
  });
  const snapshot = {
    headSha: stableHash('head'),
    changedFilesHash: stableHash([]),
    diffHash: stableHash(''),
  };
  const seal = acceptanceEvaluator.sealValidationEvidence({
    workdir: workspace,
    runDir,
    contract: contractRecord.contract,
    validation,
    workspaceSnapshot: snapshot,
    controlStoreOptions: { providerRoot: workspace, controlRoot },
  });
  const subject = { ref: 'result:failed-run:review', snapshot };
  const receiptRecord = acceptanceEvaluator.recordShadowAcceptance({
    workdir: workspace,
    runDir,
    relativeDir: '.',
    controlStoreOptions: { providerRoot: workspace, controlRoot },
    validationSeal: seal,
    subjectRef: subject.ref,
    subject,
    createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
  });
  assert.strictEqual(receiptRecord.receipt.overallStatus, 'failed');

  const project = detectStableProjectIdentity(workspace);
  const taskInput = 'Fix the behavior and keep it covered by a regression case.';
  const prompt = behavior.createBehaviorEvent({
    source_event_id: 'acceptance-feedback-prompt',
    project_id: project.id,
    session_id: 'acceptance-feedback-session',
    task_ref: null,
    turn_ref: 'acceptance-feedback-turn',
    parent_event_id: null,
    actor: { kind: 'user', id: 'user', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'session', id: 'acceptance-feedback-session' },
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: { fixture: 'acceptance-feedback' },
    input_value: taskInput,
    output_value: null,
    evidence_refs: [],
    occurred_at: '2026-09-01T00:00:00.000Z',
  });
  behavior.appendBehaviorEvent(resolveStoreDir(baseDir, project.id), prompt);

  const recorded = feedback.recordAcceptanceFeedback({
    cwd: workspace,
    runDir,
    controlRoot,
    baseDir,
    projectId: project.id,
    input: taskInput,
    sourcePromptEventRef: prompt.event_id,
  });
  assert.strictEqual(recorded.event.event_type, 'task.result');
  assert.strictEqual(recorded.event.status, 'failed');
  assert.match(recorded.expectation, /ac-fixed-behavior.*exit code is zero/);
  assert.strictEqual(feedback.recordAcceptanceFeedback({
    cwd: workspace,
    runDir,
    controlRoot,
    baseDir,
    projectId: project.id,
    input: taskInput,
    sourcePromptEventRef: prompt.event_id,
  }).replayed, true);

  const promotion = {
    cwd: workspace,
    runDir,
    controlRoot,
    baseDir,
    projectId: project.id,
    input: taskInput,
    sourcePromptEventRef: prompt.event_id,
    feedbackEventRef: recorded.event.event_id,
    skillName: 'acceptance-regression',
    caseId: 'case-failed-receipt',
  };
  assert.throws(() => feedback.promoteAcceptanceFeedbackCase(promotion), /explicit promotion/);
  feedback.promoteAcceptanceFeedbackCase({ ...promotion, promote: true });
  const cases = readCases('acceptance-regression', { baseDir });
  assert.strictEqual(cases.length, 1);
  assert.match(cases[0].expectation, /the fixed behavior passes/);
  assert(cases[0].tags.includes('acceptance-eval'));
  assert(!cases[0].tags.includes('model-canary'));
  assert.throws(() => feedback.targetEvidence({
    cwd: workspace,
    runDir,
    controlRoot,
    receiptHash: stableHash('forged'),
  }), /not authoritative/);
  assert.throws(() => feedback.promoteAcceptanceFeedbackCase({
    ...promotion,
    promote: true,
    projectId: 'project-forged',
  }), /project|match|journal/i);

  console.log('[OK] failed Receipt feedback is durable, criterion-derived, and explicitly promoted');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(controlRoot, { recursive: true, force: true });
  fs.rmSync(baseDir, { recursive: true, force: true });
}
