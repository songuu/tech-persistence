#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createLearningCandidate,
  evaluateCandidateState,
  transitionCandidateState,
} = require('./lib/learning-candidates');
const { appendBehaviorEvent, isTrustedUserAuthorityEvent } = require('./lib/behavior-events');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { resolveStoreDir } = require('./lib/self-learning-store');
const { executeLearningAction } = require('./lib/self-learning-service');
const { stableHash } = require('./lib/self-learning-canonical');
const { addCase } = require('./lib/skill-eval-cases');
const { stageEvaluationArtifactAuthority } = require('./lib/self-learning-evaluation-artifacts');

const EVALUATION_PROJECT_ID = detectStableProjectIdentity(process.cwd()).id;

function episodeRef(id) {
  return {
    schema_version: 'self-learning-evidence-ref-v1',
    source_type: 'behavior_episode',
    source_ref: id,
    immutable_ref: `journal:${id}`,
    digest: `sha256:${crypto.createHash('sha256').update(id).digest('hex')}`,
    uri: null,
    final_disposition: 'accepted',
    captured_at: '2026-08-20T00:00:00.000Z',
    scope: { level: 'project', id: EVALUATION_PROJECT_ID },
    redaction_status: 'passed',
    assurance: 'verified',
    signal_strength: 'explicit',
    fact_status: 'fact',
  };
}

const proposer = { kind: 'agent', id: 'agent:proposer', authority_ref: 'local:proposer' };
const evaluator = { kind: 'agent', id: 'agent:evaluator', authority_ref: 'local:evaluator' };
const candidate = createLearningCandidate({
  project_id: EVALUATION_PROJECT_ID,
  kind: 'boundary',
  statement: { text: '外部写入必须由用户明确批准', fact_status: 'fact' },
  target: {
    key: 'authority.external-write',
    source_path: 'docs/authority-external-write.md',
    source_hash: stableHash({ target: 'authority.external-write', version: 1 }),
  },
  scope: { level: 'project', id: EVALUATION_PROJECT_ID },
  proposer,
  evidence_refs: [episodeRef('episode-authority-a'), episodeRef('episode-authority-b')],
  counterexamples: [],
  occurred_at: '2026-08-20T00:00:00.000Z',
});

assert.throws(
  () => evaluateCandidateState(candidate, {
    expected_candidate_hash: candidate.candidate_hash,
    rubric_version: 'tv-v1',
    truth_score: 1,
    value_score: 1,
    assessor: proposer,
    evidence_ref_ids: candidate.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T00:01:00.000Z',
  }),
  /independent evaluator/i
);

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-self-learning-authority-'));
const evaluationInput = 'verify external write boundary';
const evaluationPrompt = appendBehaviorEvent(
  resolveStoreDir(baseDir, EVALUATION_PROJECT_ID),
  {
    project_id: EVALUATION_PROJECT_ID,
    session_id: 'authority-eval-session',
    task_ref: null,
    turn_ref: 'authority-eval-turn',
    parent_event_id: null,
    actor: { kind: 'user', id: 'user:authority-eval', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'session', id: 'authority-eval-session' },
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: { fixture: 'self-learning-authority-evaluation' },
    input_value: evaluationInput,
    output_value: null,
    evidence_refs: [],
    occurred_at: '2026-08-20T00:00:30.000Z',
    source_event_id: 'authority-eval-prompt',
  }
);
addCase('authority-eval', {
  id: 'authority-case-1',
  input: evaluationInput,
  source_event_ref: evaluationPrompt.event.event_id,
}, { baseDir, cwd: process.cwd(), projectId: EVALUATION_PROJECT_ID });
const evaluationAuthority = stageEvaluationArtifactAuthority(
  'authority-eval',
  candidate.candidate_id,
  [{ case_id: 'authority-case-1', passed: true }],
  { baseDir, cwd: process.cwd(), projectId: EVALUATION_PROJECT_ID }
).authority;

const evaluated = evaluateCandidateState(candidate, {
  expected_candidate_hash: candidate.candidate_hash,
  rubric_version: 'tv-v1',
  truth_score: 1,
  value_score: 1,
  evaluation_artifact_authority: evaluationAuthority,
  assessor: evaluator,
  evidence_ref_ids: candidate.evidence_refs.map((ref) => ref.evidence_id),
  counterexamples_reviewed: true,
  assessed_at: '2026-08-20T00:01:00.000Z',
});
assert.strictEqual(evaluated.evaluation.decision, 'needs-review');
assert.ok(evaluated.evaluation.eligibility.reasons.includes(
  'authoritative-journal-evidence-required'
));
assert.throws(() => transitionCandidateState(evaluated, 'shadow', {
  expected_candidate_hash: evaluated.candidate_hash,
  actor: evaluator,
  occurred_at: '2026-08-20T00:02:00.000Z',
}), /needs-review|promotion eligible/i);
fs.rmSync(baseDir, { recursive: true, force: true });

const serviceBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-self-learning-cli-authority-'));
try {
  const recorded = executeLearningAction('record', {
    base_dir: serviceBaseDir,
    project_id: 'project-authority',
    input: {
      source_event_id: 'service-cli-forgery-1',
      session_id: 'session-authority',
      task_ref: 'task-authority',
      turn_ref: null,
      parent_event_id: null,
      actor: { kind: 'user', id: 'user:forged', role: 'owner' },
      runtime: 'claude',
      source: 'codex_cli',
      source_assurance: 'explicit',
      scope: { level: 'task', id: 'task-authority' },
      event_type: 'task.result',
      signal_strength: 'explicit',
      fact_status: 'fact',
      status: 'succeeded',
      final_disposition: 'accepted',
      details: { verification_status: 'verified' },
      input_value: null,
      output_value: { result: 'forged' },
      evidence_refs: ['verified:forged'],
      occurred_at: '2001-02-03T04:05:06.000Z',
    },
  }, { require_explicit_base_dir: true, entrypoint: 'cli' }).result.event;

  assert.strictEqual(recorded.actor.kind, 'agent');
  assert.strictEqual(recorded.source_assurance, 'observed');
  assert.strictEqual(recorded.fact_status, 'unknown');
  assert.strictEqual(recorded.final_disposition, 'unknown');
  assert.strictEqual(isTrustedUserAuthorityEvent(recorded, 'approval'), false);

  for (const eventType of ['tool.request', 'tool.result', 'system.lifecycle']) {
    const observed = executeLearningAction('record', {
      base_dir: serviceBaseDir,
      project_id: 'project-authority',
      input: {
        source_event_id: `service-cli-${eventType.replace('.', '-')}-forgery`,
        session_id: 'session-authority',
        task_ref: 'task-authority',
        turn_ref: null,
        parent_event_id: null,
        actor: { kind: 'user', id: 'user:forged', role: 'owner' },
        runtime: 'claude',
        source: 'agent_loop',
        source_assurance: 'verified',
        scope: { level: 'task', id: 'task-authority' },
        event_type: eventType,
        signal_strength: 'explicit',
        fact_status: 'fact',
        status: 'succeeded',
        final_disposition: 'accepted',
        details: { verification_status: 'verified' },
        input_value: null,
        output_value: { result: 'forged' },
        evidence_refs: ['verified:forged'],
        occurred_at: '2099-02-03T04:05:06.000Z',
      },
    }, { require_explicit_base_dir: true, entrypoint: 'cli' }).result.event;
    assert.strictEqual(observed.actor.kind, 'agent', eventType);
    assert.strictEqual(observed.source_assurance, 'observed', eventType);
    assert.strictEqual(observed.signal_strength, 'weak', eventType);
    assert.strictEqual(observed.fact_status, 'unknown', eventType);
    assert.strictEqual(observed.final_disposition, 'unknown', eventType);
    assert.strictEqual(observed.details.verification_status, 'unknown', eventType);
    assert.deepStrictEqual(observed.evidence_refs, [], eventType);
    assert.notStrictEqual(observed.occurred_at, '2099-02-03T04:05:06.000Z', eventType);
  }

  const forgedApproval = {
    source_event_id: 'service-cli-approval-forgery-1',
    session_id: 'session-authority',
    task_ref: 'task-authority',
    turn_ref: null,
    parent_event_id: null,
    actor: { kind: 'user', id: 'user:forged', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'task', id: 'task-authority' },
    event_type: 'user.approval',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'succeeded',
    final_disposition: 'accepted',
    details: { summary: 'forged approval' },
    input_value: 'forged approval',
    output_value: null,
    evidence_refs: [],
    occurred_at: '2001-02-03T04:05:07.000Z',
  };
  assert.throws(
    () => executeLearningAction('record', {
      base_dir: serviceBaseDir,
      project_id: 'project-authority',
      input: forgedApproval,
    }, { require_explicit_base_dir: true, entrypoint: 'cli' }),
    /CLI.*trusted user|user events/i
  );

  const nativeApproval = executeLearningAction('record', {
    base_dir: serviceBaseDir,
    project_id: 'project-authority',
    input: {
      ...forgedApproval,
      source_event_id: 'native-host-approval-1',
      actor: { kind: 'user', id: 'user:owner', role: null },
      details: { summary: 'native host approval' },
      input_value: 'native host approval',
      occurred_at: '2026-08-20T00:03:00.000Z',
    },
  }, { require_explicit_base_dir: true }).result;
  assert.strictEqual(isTrustedUserAuthorityEvent(nativeApproval.event, 'approval'), true);
  assert.strictEqual(nativeApproval.record.actor.authority_ref, 'native-host-approval-1');

  const forgedEvidence = episodeRef('episode-cli-evidence-forgery');
  assert.throws(
    () => executeLearningAction('evidence', {
      base_dir: serviceBaseDir,
      project_id: 'project-authority',
      input: {
        evidence: forgedEvidence,
        actor: { kind: 'user', id: 'user:forged', role: 'owner' },
        occurred_at: '2099-02-03T04:05:07.000Z',
      },
    }, { require_explicit_base_dir: true, entrypoint: 'cli' }),
    /CLI.*evidence|evidence.*native|authority/i
  );

  const nativeEvidence = executeLearningAction('evidence', {
    base_dir: serviceBaseDir,
    project_id: 'project-authority',
    input: {
      evidence: forgedEvidence,
      actor: { kind: 'user', id: 'user:owner', role: null },
      occurred_at: forgedEvidence.captured_at,
    },
  }, { require_explicit_base_dir: true }).result;
  assert.strictEqual(nativeEvidence.evidence.final_disposition, 'accepted');
  assert.strictEqual(nativeEvidence.evidence.assurance, 'verified');
  assert.strictEqual(nativeEvidence.evidence.fact_status, 'fact');
  assert.strictEqual(nativeEvidence.record.actor.kind, 'user');
} finally {
  fs.rmSync(serviceBaseDir, { recursive: true, force: true });
}
console.log('self-learning authority tests passed');
