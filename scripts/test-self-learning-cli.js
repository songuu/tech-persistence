#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run: runCli } = require('./self-learning');
const {
  executeLearningAction,
  resolveLearningContext,
} = require('./lib/self-learning-service');
const { appendBehaviorEvent } = require('./lib/behavior-events');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { appendRecord, resolveStoreDir } = require('./lib/self-learning-store');
const { addCase } = require('./lib/skill-eval-cases');
const { stageEvaluationArtifactAuthority } = require('./lib/self-learning-evaluation-artifacts');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${error.stack || error.message}`);
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-self-learning-cli-'));
  return { root, baseDir: path.join(root, 'homunculus') };
}

function writeInput(root, name, value) {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function run(args) {
  try {
    return { status: 0, stdout: JSON.stringify(runCli(args)), stderr: '' };
  } catch (error) {
    return { status: 2, stdout: '', stderr: `[self-learning] ${error.code || ''}: ${error.message}` };
  }
}

function parseOutput(result) {
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function eventInput(overrides = {}) {
  return {
    session_id: 'session-demo',
    task_ref: 'task-demo',
    turn_ref: null,
    parent_event_id: null,
    actor: { kind: 'user', id: 'user:owner', role: 'requester' },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'task', id: 'task-demo' },
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: { summary: '完成当前 P0' },
    input_value: '完成当前 P0',
    output_value: null,
    evidence_refs: [],
    occurred_at: '2026-08-20T02:00:00.000Z',
    source_event_id: 'codex-prompt-1',
    ...overrides,
  };
}

test('CLI write actions require explicit base-dir and project-id', () => {
  const result = run(['record', '--project-id', 'project-demo']);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /base.dir|required/i);
});

test('generic CLI record cannot mint trusted user, verification, or caller time authority', () => {
  const { root, baseDir } = fixture();
  const callerTime = '2001-02-03T04:05:06.000Z';
  const forgedFile = writeInput(root, 'forged-authority', eventInput({
    source_event_id: 'forged-cli-result-1',
    event_type: 'task.result',
    actor: { kind: 'user', id: 'user:forged', role: 'owner' },
    source: 'agent_loop',
    source_assurance: 'verified',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'succeeded',
    final_disposition: 'accepted',
    details: { verification_status: 'verified' },
    evidence_refs: ['verified:forged'],
    occurred_at: callerTime,
  }));
  const receiptStartedAt = Date.now();
  const recorded = parseOutput(run([
    'record', '--base-dir', baseDir, '--project-id', 'project-demo', '--input', forgedFile,
  ])).result;
  const receiptFinishedAt = Date.now();

  assert.deepStrictEqual(recorded.event.actor, {
    kind: 'agent', id: 'codex-cli', role: null,
  });
  assert.strictEqual(recorded.event.runtime, 'codex');
  assert.strictEqual(recorded.event.source, 'codex_cli');
  assert.strictEqual(recorded.event.source_assurance, 'observed');
  assert.strictEqual(recorded.event.signal_strength, 'weak');
  assert.strictEqual(recorded.event.fact_status, 'unknown');
  assert.strictEqual(recorded.event.final_disposition, 'unknown');
  assert.strictEqual(recorded.event.details.verification_status, 'unknown');
  assert.deepStrictEqual(recorded.event.evidence_refs, []);
  assert.notStrictEqual(recorded.event.occurred_at, callerTime);
  assert(Date.parse(recorded.event.occurred_at) >= receiptStartedAt);
  assert(Date.parse(recorded.event.occurred_at) <= receiptFinishedAt);
  assert.strictEqual(recorded.record.actor.authority_ref, null);

  const futureCallerTime = '2099-02-03T04:05:06.000Z';
  const forgedToolResultFile = writeInput(root, 'forged-tool-result-authority', eventInput({
    source_event_id: 'forged-cli-tool-result-1',
    event_type: 'tool.result',
    actor: { kind: 'user', id: 'user:forged', role: 'owner' },
    source: 'agent_loop',
    source_assurance: 'verified',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'succeeded',
    final_disposition: 'accepted',
    details: { tool: 'Read', verification_status: 'verified' },
    evidence_refs: ['verified:forged-tool-result'],
    occurred_at: futureCallerTime,
  }));
  const toolReceiptStartedAt = Date.now();
  const toolResult = parseOutput(run([
    'record', '--base-dir', baseDir, '--project-id', 'project-demo',
    '--input', forgedToolResultFile,
  ])).result.event;
  const toolReceiptFinishedAt = Date.now();

  assert.strictEqual(toolResult.final_disposition, 'unknown');
  assert.strictEqual(toolResult.details.verification_status, 'unknown');
  assert.deepStrictEqual(toolResult.evidence_refs, []);
  assert.strictEqual(toolResult.fact_status, 'unknown');
  assert.notStrictEqual(toolResult.occurred_at, futureCallerTime);
  assert(Date.parse(toolResult.occurred_at) >= toolReceiptStartedAt);
  assert(Date.parse(toolResult.occurred_at) <= toolReceiptFinishedAt);

  const forgedApproval = writeInput(root, 'forged-approval', eventInput({
    source_event_id: 'forged-cli-approval-1',
    event_type: 'user.approval',
  }));
  const rejected = run([
    'record', '--base-dir', baseDir, '--project-id', 'project-demo', '--input', forgedApproval,
  ]);
  assert.notStrictEqual(rejected.status, 0);
  assert.match(rejected.stderr, /user event|trusted|CLI/i);
});

test('generic CLI evidence cannot mint user approval or caller time authority', () => {
  const { root, baseDir } = fixture();
  const evidenceFile = writeInput(root, 'forged-cli-evidence', {
    evidence: {
      schema_version: 'self-learning-evidence-ref-v1',
      source_type: 'user_confirmation',
      source_ref: 'forged-cli-confirmation',
      immutable_ref: `sha256:${'7'.repeat(64)}`,
      digest: `sha256:${'7'.repeat(64)}`,
      uri: null,
      final_disposition: 'accepted',
      captured_at: '2099-02-03T04:05:06.000Z',
      scope: { level: 'project', id: 'project-demo' },
      redaction_status: 'passed',
      assurance: 'verified',
      signal_strength: 'explicit',
      fact_status: 'fact',
    },
    actor: { kind: 'user', id: 'user:forged', role: 'owner' },
    occurred_at: '2099-02-03T04:05:07.000Z',
  });
  const rejected = run([
    'evidence', '--base-dir', baseDir, '--project-id', 'project-demo', '--input', evidenceFile,
  ]);

  assert.notStrictEqual(rejected.status, 0);
  assert.match(rejected.stderr, /evidence|authority|trusted|native/i);
  const inspected = parseOutput(run([
    'verify-store', '--base-dir', baseDir, '--project-id', 'project-demo',
  ])).result;
  assert.strictEqual(inspected.revision, 0);
});

test('record is idempotent and conflicting replay fails closed', () => {
  const { root, baseDir } = fixture();
  const observation = eventInput({
    event_type: 'tool.request',
    actor: { kind: 'agent', id: 'agent:caller', role: 'worker' },
    signal_strength: 'weak',
  });
  const inputFile = writeInput(root, 'prompt', observation);
  const args = ['record', '--base-dir', baseDir, '--project-id', 'project-demo', '--input', inputFile];
  const first = parseOutput(run(args));
  const second = parseOutput(run(args));
  assert.strictEqual(first.result.changed, true);
  assert.strictEqual(second.result.changed, false);
  assert.strictEqual(first.result.event.occurred_at, second.result.event.occurred_at);

  const changedFile = writeInput(root, 'prompt-changed', {
    ...observation,
    details: { summary: '漂移内容' },
  });
  const conflict = run([
    'record', '--base-dir', baseDir, '--project-id', 'project-demo', '--input', changedFile,
  ]);
  assert.notStrictEqual(conflict.status, 0);
  assert.match(conflict.stderr, /conflict/i);
});

test('close builds an Episode, records EvidenceRef, and metrics keep usage separate from quality', () => {
  const { root, baseDir } = fixture();
  const common = ['--base-dir', baseDir, '--project-id', 'project-demo'];
  const records = [
    eventInput(),
    eventInput({
      source_event_id: 'codex-tool-1',
      occurred_at: '2026-08-20T02:01:00.000Z',
      actor: { kind: 'agent', id: 'agent:worker', role: 'executor' },
      source_assurance: 'observed',
      event_type: 'tool.request',
      signal_strength: 'weak',
      fact_status: 'inference',
      details: { tool: 'exec', retry: false, invalid_call: false },
      input_value: { command_family: 'test' },
    }),
    eventInput({
      source_event_id: 'managed-result-1',
      occurred_at: '2026-08-20T02:02:00.000Z',
      actor: { kind: 'system', id: 'agent-loop', role: 'verifier' },
      source: 'agent_loop',
      source_assurance: 'verified',
      event_type: 'task.result',
      signal_strength: 'inferred',
      fact_status: 'fact',
      status: 'failed',
      final_disposition: 'rejected',
      details: { verification_status: 'failed' },
      input_value: null,
      output_value: { outcome: 'failed' },
    }),
  ];
  records.forEach((event) => {
    executeLearningAction('record', {
      base_dir: baseDir,
      project_id: 'project-demo',
      input: event,
    }, { require_explicit_base_dir: true });
  });

  const closeFile = writeInput(root, 'close', {
    session_id: 'session-demo',
    task_ref: 'task-demo',
    created_at: '2026-08-20T02:03:00.000Z',
    actor: { kind: 'system', id: 'episode-builder', runtime: 'codex', authority_ref: null },
  });
  const closed = parseOutput(run(['close', ...common, '--input', closeFile]));
  assert.strictEqual(closed.result.episode.completeness, 'complete');
  assert.strictEqual(closed.result.episode.verification_status, 'failed');
  assert.strictEqual(closed.evidence.evidence.source_type, 'behavior_episode');

  const metrics = parseOutput(run(['metrics', ...common]));
  assert.strictEqual(metrics.result.behavior.usage.tool_call_count, 1);
  assert.strictEqual(metrics.result.behavior.quality.task_verification_rate.status, 'measured');
  assert.strictEqual(metrics.result.behavior.quality.task_verification_rate.value, 0);
  assert.strictEqual(metrics.result.interpretation.tool_calls_are_usage_not_quality, true);
});

test('verify-store reads an empty authority journal without inventing usage', () => {
  const { baseDir } = fixture();
  const result = parseOutput(run([
    'verify-store', '--base-dir', baseDir, '--project-id', 'project-demo',
  ]));
  assert.strictEqual(result.result.revision, 0);
  assert.deepStrictEqual(result.result.records, []);
});

test('context exposes only promoted automatic context and separates shadow suggestions', () => {
  const { baseDir } = fixture();
  const result = parseOutput(run([
    'context', '--base-dir', baseDir, '--project-id', 'project-demo',
  ]));
  assert.deepStrictEqual(result.result.automatic_context, []);
  assert.deepStrictEqual(result.result.shadow_suggestions, []);
  assert.strictEqual(result.result.policy.automatic_context_status, 'promoted');
  assert.strictEqual(result.result.policy.shadow_auto_injection, false);
  assert.strictEqual(result.result.policy.runtime_write_performed, false);
});

test('writer and reader kill switches fail closed without hiding inspection', () => {
  const { root, baseDir } = fixture();
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
    self_learning: {
      enabled: true,
      writer_enabled: false,
      reader_enabled: false,
      mode: 'shadow',
    },
  }));
  const inputFile = writeInput(root, 'disabled-prompt', eventInput());
  const writeResult = run([
    'record', '--base-dir', baseDir, '--project-id', 'project-demo', '--input', inputFile,
  ]);
  assert.notStrictEqual(writeResult.status, 0);
  assert.match(writeResult.stderr, /writer.disabled|disabled by policy/i);

  const contextResult = run([
    'context', '--base-dir', baseDir, '--project-id', 'project-demo',
  ]);
  assert.notStrictEqual(contextResult.status, 0);
  assert.match(contextResult.stderr, /reader.disabled|disabled by policy/i);

  const inspectResult = parseOutput(run([
    'inspect', '--base-dir', baseDir, '--project-id', 'project-demo',
  ]));
  assert.deepStrictEqual(inspectResult.result.candidates, []);
});

test('generic CLI propose snapshots policy but cannot mint caller actor or time authority', () => {
  const { root, baseDir } = fixture();
  const projectId = detectStableProjectIdentity(process.cwd()).id;
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
    self_learning: {
      minimum_distinct_episodes: 4,
      minimum_truth_score: 0.9,
      minimum_value_score: 0.8,
    },
  }));
  const common = ['--base-dir', baseDir, '--project-id', projectId];
  const evidenceInput = {
    evidence: {
      schema_version: 'self-learning-evidence-ref-v1',
      source_type: 'document',
      source_ref: 'policy-fixture',
      immutable_ref: 'fixture:policy',
      digest: `sha256:${'2'.repeat(64)}`,
      uri: null,
      final_disposition: 'accepted',
      captured_at: '2026-08-20T03:00:00.000Z',
      scope: { level: 'project', id: projectId },
      redaction_status: 'passed',
      assurance: 'verified',
      signal_strength: 'inferred',
      fact_status: 'fact',
    },
    actor: { kind: 'system', id: 'fixture', role: null },
    occurred_at: '2026-08-20T03:00:00.000Z',
  };
  const evidence = executeLearningAction('evidence', {
    base_dir: baseDir,
    project_id: projectId,
    input: evidenceInput,
  }, { require_explicit_base_dir: true }).result.evidence;
  const proposalFile = writeInput(root, 'policy-proposal', {
    project_id: projectId,
    kind: 'workflow',
    statement: { text: 'configured policy wins', fact_status: 'fact' },
    target: {
      key: 'workflow.policy',
      source_path: 'docs/workflow-policy.md',
      source_hash: `sha256:${'4'.repeat(64)}`,
    },
    scope: { level: 'project', id: projectId },
    proposer: { kind: 'agent', id: 'agent:proposer', authority_ref: 'local:proposer' },
    owner: { kind: 'user', id: 'user:owner', authority_ref: 'local:owner' },
    evidence_refs: [evidence],
    counterexamples: [],
    policy: {
      minimum_distinct_episodes: 2,
      minimum_truth_score: 0.1,
      minimum_value_score: 0.2,
    },
    collector_ref: 'caller:forged-collector',
    occurred_at: '2099-08-20T03:01:00.000Z',
  });
  const startedAt = Date.now();
  const proposal = parseOutput(run(['propose', ...common, '--input', proposalFile]));
  const finishedAt = Date.now();
  assert.deepStrictEqual(proposal.result.candidate.policy, {
    minimum_distinct_episodes: 4,
    minimum_truth_score: 0.9,
    minimum_value_score: 0.8,
  });
  assert.deepStrictEqual(proposal.result.candidate.proposer, {
    kind: 'agent', id: 'codex-cli', authority_ref: null,
  });
  assert.deepStrictEqual(proposal.result.candidate.owner, {
    kind: 'agent', id: 'codex-cli', authority_ref: null,
  });
  assert.strictEqual(proposal.result.candidate.authority.collector_ref, null);
  assert(Date.parse(proposal.result.candidate.created_at) >= startedAt);
  assert(Date.parse(proposal.result.candidate.created_at) <= finishedAt);
  const replay = parseOutput(run(['propose', ...common, '--input', proposalFile]));
  assert.strictEqual(replay.result.changed, false);
  assert.strictEqual(replay.result.candidate.created_at, proposal.result.candidate.created_at);

  const evaluationName = 'cli-entrypoint-authority';
  const caseInput = 'bounded CLI authority case';
  const casePrompt = appendBehaviorEvent(resolveStoreDir(baseDir, projectId), {
    project_id: projectId,
    session_id: 'cli-evaluation-case-session',
    task_ref: null,
    turn_ref: 'cli-evaluation-case-turn',
    parent_event_id: null,
    actor: { kind: 'user', id: 'user:cli-evaluation-case', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'session', id: 'cli-evaluation-case-session' },
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: { fixture: 'self-learning-cli-evaluation-authority' },
    input_value: caseInput,
    output_value: null,
    evidence_refs: [],
    occurred_at: '2026-08-20T03:01:30.000Z',
    source_event_id: 'cli-evaluation-case-prompt',
  });
  addCase(evaluationName, {
    id: 'case-1',
    input: caseInput,
    source_event_ref: casePrompt.event.event_id,
  }, { baseDir, projectId, cwd: process.cwd() });
  stageEvaluationArtifactAuthority(
    evaluationName,
    proposal.result.candidate.candidate_id,
    [{ case_id: 'case-1', passed: true }],
    { baseDir, projectId, cwd: process.cwd() }
  );
  const evaluationFile = writeInput(root, 'cli-evaluation-authority', {
    expected_candidate_hash: proposal.result.candidate.candidate_hash,
    rubric_version: 'tv-v1',
    truth_score: 0.9,
    value_score: 0.9,
    assessor: { kind: 'agent', id: 'agent:forged-evaluator', authority_ref: 'forged:evaluator' },
    evidence_ref_ids: proposal.result.candidate.evidence_refs.map((item) => item.evidence_id),
    evaluation_artifact_ref: { name: evaluationName },
    counterexamples_reviewed: true,
    assessed_at: '2099-08-20T03:02:00.000Z',
  });
  const evaluationStartedAt = Date.now();
  const evaluated = parseOutput(run([
    'evaluate', ...common, '--candidate-id', proposal.result.candidate.candidate_id,
    '--input', evaluationFile,
  ])).result.candidate;
  const evaluationFinishedAt = Date.now();
  assert.deepStrictEqual(evaluated.evaluation.assessor, {
    kind: 'agent', id: 'codex-cli-evaluator', authority_ref: null,
  });
  assert(Date.parse(evaluated.evaluation.assessed_at) >= evaluationStartedAt);
  assert(Date.parse(evaluated.evaluation.assessed_at) <= evaluationFinishedAt);
});

test('verify-store rejects a hash-valid record with an invalid domain payload', () => {
  const { baseDir } = fixture();
  const context = resolveLearningContext({ base_dir: baseDir, project_id: 'project-demo' });
  appendRecord(context.store_dir, {
    record_type: 'behavior_event',
    record_id: 'malformed-event',
    entity_id: 'malformed-event',
    actor: { kind: 'hook', id: 'fixture', runtime: 'claude', authority_ref: null },
    occurred_at: '2026-08-20T03:00:00.000Z',
    payload: { schema_version: 'malformed-but-hash-valid' },
  });
  const result = run([
    'verify-store', '--base-dir', baseDir, '--project-id', 'project-demo',
  ]);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /behavior.event|domain|schema/i);
});

test('verify-store rejects a hash-valid approval receipt with a malformed wrapper', () => {
  const { baseDir } = fixture();
  const context = resolveLearningContext({ base_dir: baseDir, project_id: 'project-demo' });
  appendRecord(context.store_dir, {
    record_type: 'approval_receipt',
    record_id: 'receipt:approval-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    entity_id: 'approval-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    actor: {
      kind: 'user',
      id: 'user:publisher',
      runtime: 'codex',
      authority_ref: 'local:publisher',
    },
    occurred_at: '2026-08-20T03:00:00.000Z',
    payload: {
      schema_version: 'self-learning-approval-record-v1',
      receipt: {},
      unexpected: 'sensitive-value-must-not-be-trusted',
    },
  });
  const result = run([
    'verify-store', '--base-dir', baseDir, '--project-id', 'project-demo',
  ]);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /approval.receipt|exact.wrapper|domain/i);
});

test('legacy_inputs=off keeps legacy evidence auditable but blocks candidate ingestion', () => {
  const { root, baseDir } = fixture();
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
    self_learning: { legacy_inputs: 'off' },
  }));
  const common = ['--base-dir', baseDir, '--project-id', 'project-demo'];
  const evidenceInput = {
    evidence: {
      schema_version: 'self-learning-evidence-ref-v1',
      source_type: 'legacy_observation',
      source_ref: 'legacy-observation-1',
      immutable_ref: 'legacy:observation:1',
      digest: `sha256:${'3'.repeat(64)}`,
      uri: null,
      final_disposition: 'unknown',
      captured_at: '2026-08-20T04:00:00.000Z',
      scope: { level: 'project', id: 'project-demo' },
      redaction_status: 'passed',
      assurance: 'legacy_unverified',
      signal_strength: 'weak',
      fact_status: 'unknown',
    },
    actor: { kind: 'system', id: 'legacy-import', role: null },
    occurred_at: '2026-08-20T04:00:00.000Z',
  };
  const evidence = executeLearningAction('evidence', {
    base_dir: baseDir,
    project_id: 'project-demo',
    input: evidenceInput,
  }, { require_explicit_base_dir: true }).result.evidence;
  const proposalFile = writeInput(root, 'legacy-proposal', {
    project_id: 'project-demo',
    kind: 'workflow',
    statement: { text: 'legacy-only idea', fact_status: 'unknown' },
    target: {
      key: 'workflow.legacy',
      source_path: 'docs/workflow-legacy.md',
      source_hash: `sha256:${'5'.repeat(64)}`,
    },
    scope: { level: 'project', id: 'project-demo' },
    proposer: { kind: 'agent', id: 'agent:proposer', authority_ref: 'local:proposer' },
    owner: { kind: 'user', id: 'user:owner', authority_ref: 'local:owner' },
    evidence_refs: [evidence],
    counterexamples: [],
    occurred_at: '2026-08-20T04:01:00.000Z',
  });
  const proposal = run(['propose', ...common, '--input', proposalFile]);
  assert.notStrictEqual(proposal.status, 0);
  assert.match(proposal.stderr, /legacy.*disabled/i);
  const inspection = parseOutput(run(['inspect', ...common]));
  assert.strictEqual(inspection.result.candidates.length, 0);
  assert.strictEqual(parseOutput(run(['verify-store', ...common])).result.domain_verified, true);
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
