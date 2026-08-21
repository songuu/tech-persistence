#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stableHash } = require('./lib/self-learning-canonical');
const { appendBehaviorEvent } = require('./lib/behavior-events');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { resolveStoreDir } = require('./lib/self-learning-store');
const { addCase } = require('./lib/skill-eval-cases');
const { stageEvaluationArtifactAuthority } = require('./lib/self-learning-evaluation-artifacts');

const {
  CANDIDATE_KINDS,
  createLearningCandidate,
  evaluateCandidateState,
  transitionCandidateState,
  createApprovalReceipt,
  correctCandidateScope,
} = require('./lib/learning-candidates');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

const proposer = Object.freeze({ kind: 'agent', id: 'agent:learner', authority_ref: 'local:agent' });
const evaluator = Object.freeze({ kind: 'agent', id: 'agent:evaluator', authority_ref: 'local:evaluator' });
const publisher = Object.freeze({ kind: 'user', id: 'user:owner', authority_ref: 'local:user-confirmation' });
const defaultProjectId = detectStableProjectIdentity(process.cwd()).id;
const scope = Object.freeze({ level: 'project', id: defaultProjectId });

function frozenTarget(key = 'testing.order') {
  return {
    key,
    source_path: 'docs/testing-order.md',
    source_hash: stableHash({ target: key, version: 1 }),
  };
}

function episodeRef(id, options = {}) {
  return {
    schema_version: 'self-learning-evidence-ref-v1',
    source_type: 'behavior_episode',
    source_ref: id,
    immutable_ref: `journal:${id}`,
    digest: `sha256:${crypto.createHash('sha256').update(String(id)).digest('hex')}`,
    uri: null,
    final_disposition: 'accepted',
    captured_at: '2026-08-20T00:00:00.000Z',
    scope: { level: 'project', id: defaultProjectId },
    redaction_status: 'passed',
    assurance: options.assurance || 'verified',
    fact_status: options.fact_status || 'fact',
    signal_strength: options.signal_strength || 'explicit',
  };
}

function makeCandidate(overrides = {}) {
  return createLearningCandidate({
    project_id: defaultProjectId,
    kind: 'strategy',
    statement: {
      text: '先运行定向测试，再运行全量测试',
      fact_status: 'inference',
    },
    target: frozenTarget(),
    scope,
    proposer,
    evidence_refs: [episodeRef('episode-a'), episodeRef('episode-b')],
    counterexamples: [],
    occurred_at: '2026-08-20T00:00:00.000Z',
    ...overrides,
  });
}

function evaluate(candidate, overrides = {}) {
  const { _outcomes = [true, true], ...inputOverrides } = overrides;
  return evaluateCandidateState(candidate, {
    expected_candidate_hash: candidate.candidate_hash,
    rubric_version: 'tv-v1',
    truth_score: 0.9,
    value_score: 0.8,
    assessor: evaluator,
    evidence_ref_ids: candidate.evidence_refs.map((ref) => ref.evidence_id),
    evaluation_artifact_authority: brandedEvaluationAuthority(candidate, _outcomes),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T00:01:00.000Z',
    ...inputOverrides,
  });
}

let evaluationAuthoritySequence = 0;
function brandedEvaluationAuthority(candidate, outcomes = [true, true], options = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-candidate-evaluation-authority-'));
  const name = 'candidate-eval';
  const cwd = options.cwd || process.cwd();
  const projectId = options.projectId || candidate.project_id;
  outcomes.forEach((_passed, index) => {
    evaluationAuthoritySequence += 1;
    const input = `case input ${index + 1}`;
    const recorded = appendBehaviorEvent(resolveStoreDir(baseDir, projectId), {
      project_id: projectId,
      session_id: `candidate-eval-session-${evaluationAuthoritySequence}`,
      task_ref: null,
      turn_ref: `candidate-eval-turn-${evaluationAuthoritySequence}`,
      parent_event_id: null,
      actor: { kind: 'user', id: 'user:candidate-eval', role: null },
      runtime: 'codex',
      source: 'codex_cli',
      source_assurance: 'explicit',
      scope: { level: 'session', id: `candidate-eval-session-${evaluationAuthoritySequence}` },
      event_type: 'user.prompt',
      signal_strength: 'explicit',
      fact_status: 'fact',
      status: 'observed',
      final_disposition: 'unknown',
      details: { fixture: 'learning-candidate-evaluation-authority' },
      input_value: input,
      output_value: null,
      evidence_refs: [],
      occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, evaluationAuthoritySequence)).toISOString(),
      source_event_id: `candidate-eval-prompt-${evaluationAuthoritySequence}`,
    });
    addCase(name, {
      id: `case-${index + 1}`,
      input,
      source_event_ref: recorded.event.event_id,
    }, { baseDir, cwd, projectId });
  });
  return stageEvaluationArtifactAuthority(name, candidate.candidate_id, outcomes.map((passed, index) => ({
    case_id: `case-${index + 1}`,
    passed,
  })), { baseDir, cwd, projectId }).authority;
}

test('candidate taxonomy is frozen to six learning asset kinds', () => {
  assert.deepStrictEqual(CANDIDATE_KINDS, [
    'preference',
    'environment_fact',
    'strategy',
    'workflow',
    'boundary',
    'anti_pattern',
  ]);
});

test('proposal is content-addressed, shadow-first, and recursively redacted', () => {
  const first = makeCandidate({
    statement: {
      text: '使用 password=supersecretvalue <private>never persist</private>',
      fact_status: 'inference',
    },
  });
  const second = makeCandidate({
    statement: {
      text: '使用 password=supersecretvalue <private>never persist</private>',
      fact_status: 'inference',
    },
  });
  assert.strictEqual(first.status, 'proposed');
  assert.strictEqual(first.candidate_id, second.candidate_id);
  assert.strictEqual(first.candidate_hash, second.candidate_hash);
  assert.ok(!first.statement.text.includes('supersecretvalue'));
  assert.ok(!first.statement.text.includes('never persist'));
});

test('candidate target is exact, source-bound, and skill/command paths are allowlisted', () => {
  assert.throws(() => makeCandidate({ target: { key: 'testing.order' } }), /source_path|source_hash|target/i);
  assert.throws(() => makeCandidate({
    target: { ...frozenTarget('skill:sprint'), source_path: '../sprint/SKILL.md' },
  }), /source_path|relative|traversal|target/i);
  assert.throws(() => makeCandidate({
    target: { ...frozenTarget('skill:sprint'), source_path: 'docs/sprint.md' },
  }), /skill.*source_path|allowlist|target/i);
  const first = makeCandidate({ target: frozenTarget() });
  const changed = makeCandidate({
    target: { ...frozenTarget(), source_hash: stableHash({ target: 'testing.order', version: 2 }) },
  });
  assert.notStrictEqual(first.candidate_id, changed.candidate_id);
  assert.notStrictEqual(first.candidate_hash, changed.candidate_hash);
});

test('proposal without evidence fails closed', () => {
  assert.throws(
    () => makeCandidate({ evidence_refs: [] }),
    /at least one evidence reference/i
  );
});

test('proposal policy is an exact three-field snapshot', () => {
  const candidate = makeCandidate({
    policy: {
      minimum_distinct_episodes: 3,
      minimum_truth_score: 0.8,
      minimum_value_score: 0.7,
    },
  });
  assert.deepStrictEqual(candidate.policy, {
    minimum_distinct_episodes: 3,
    minimum_truth_score: 0.8,
    minimum_value_score: 0.7,
  });
  assert.throws(() => makeCandidate({
    policy: { minimum_distinct_episodes: 2 },
  }), /policy.*exact|missing/i);
  assert.throws(() => makeCandidate({
    policy: {
      minimum_distinct_episodes: 2,
      minimum_truth_score: 0.75,
      minimum_value_score: 0.6,
      bypass: true,
    },
  }), /policy.*exact|unexpected/i);
  assert.throws(() => makeCandidate({
    policy: {
      minimum_distinct_episodes: 2,
      minimum_truth_score: 1.1,
      minimum_value_score: 0.6,
    },
  }), /minimum_truth_score/i);
});

test('project-scoped candidate must bind scope id to project identity', () => {
  assert.throws(() => makeCandidate({
    scope: { level: 'project', id: 'different-project' },
  }), /project.*scope|scope.*project/i);
});

test('evaluation binds rubric, assessor, evidence, and current candidate hash', () => {
  const candidate = makeCandidate();
  const subjectArtifactHash = 'sha256:' + 'd'.repeat(64);
  const evaluated = evaluate(candidate, { subject_artifact_hash: subjectArtifactHash });
  assert.strictEqual(evaluated.status, 'evaluated');
  assert.strictEqual(evaluated.revision, 2);
  assert.strictEqual(evaluated.evaluation.candidate_hash, candidate.candidate_hash);
  assert.strictEqual(evaluated.evaluation.rubric_version, 'tv-v1');
  assert.strictEqual(evaluated.evaluation.subject_artifact_hash, subjectArtifactHash);
  assert.strictEqual(evaluated.evaluation.case_count, 2);
  assert.strictEqual(evaluated.evaluation.passed_count, 2);
  assert.strictEqual(evaluated.evaluation.pass_rate, 1);
  assert.match(evaluated.evaluation.case_results_hash, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(evaluated.evaluation.eligibility.sample_count, 0);
  assert.strictEqual(evaluated.evaluation.eligibility.eligible, false);
  assert.ok(evaluated.evaluation.eligibility.reasons.includes(
    'authoritative-journal-evidence-required'
  ));
  assert.notStrictEqual(evaluated.candidate_hash, candidate.candidate_hash);
});

test('live evaluation consumes only branded exact case authority and rejects serialized summaries', () => {
  const candidate = makeCandidate();
  const authority = brandedEvaluationAuthority(candidate, [true, false]);
  const input = {
    expected_candidate_hash: candidate.candidate_hash,
    rubric_version: 'tv-v1',
    truth_score: 0.9,
    value_score: 0.8,
    assessor: evaluator,
    evidence_ref_ids: candidate.evidence_refs.map((ref) => ref.evidence_id),
    evaluation_artifact_authority: authority,
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T00:01:00.000Z',
  };
  const evaluated = evaluateCandidateState(candidate, input);
  assert.strictEqual(evaluated.evaluation.case_count, 2);
  assert.strictEqual(evaluated.evaluation.passed_count, 1);
  assert.strictEqual(evaluated.evaluation.pass_rate, 0.5);
  assert.strictEqual(evaluated.evaluation.case_set_hash, authority.case_set_hash);
  assert.strictEqual(evaluated.evaluation.case_results_hash, authority.case_results_hash);
  assert.throws(
    () => evaluateCandidateState(candidate, {
      ...input,
      evaluation_artifact_authority: JSON.parse(JSON.stringify(authority)),
    }),
    /brand|artifact authority/i
  );
  assert.throws(() => evaluateCandidateState(candidate, {
    ...input,
    case_count: 999,
    passed_count: 999,
    pass_rate: 1,
    case_results_hash: stableHash({ forged: true }),
  }), /caller|raw|case_count|case_results/i);
});

test('evaluation authority is bound to the candidate project', () => {
  const projectACwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-candidate-project-a-'));
  const projectBCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-candidate-project-b-'));
  const projectAId = detectStableProjectIdentity(projectACwd).id;
  const projectId = detectStableProjectIdentity(projectBCwd).id;
  const candidate = makeCandidate({
    project_id: projectId,
    scope: { level: 'project', id: projectId },
    evidence_refs: [episodeRef('project-b-a'), episodeRef('project-b-b')].map((ref) => ({
      ...ref,
      scope: { level: 'project', id: projectId },
    })),
  });
  const projectAAuthority = brandedEvaluationAuthority(candidate, [true, true], {
    cwd: projectACwd,
    projectId: projectAId,
  });
  assert.throws(
    () => evaluateCandidateState(candidate, {
      expected_candidate_hash: candidate.candidate_hash,
      rubric_version: 'tv-v1',
      truth_score: 0.9,
      value_score: 0.8,
      assessor: evaluator,
      evidence_ref_ids: candidate.evidence_refs.map((ref) => ref.evidence_id),
      evaluation_artifact_authority: projectAAuthority,
      counterexamples_reviewed: true,
      assessed_at: '2026-08-20T00:01:00.000Z',
    }),
    /evaluation artifact authority project_id mismatch/i
  );
});

test('evaluation case aggregate is artifact-derived and raw overrides fail closed', () => {
  const candidate = makeCandidate();
  assert.throws(() => evaluate(candidate, {
    case_results_hash: stableHash({ forged: true }),
    case_count: 2,
    passed_count: 2,
    pass_rate: 1,
  }), /caller-provided raw case summary/i);
  const half = evaluate(candidate, { _outcomes: [true, false] });
  assert.strictEqual(half.evaluation.pass_rate, 0.5);
});

test('evaluation subject artifact hash is exact sha256 or null', () => {
  assert.strictEqual(evaluate(makeCandidate()).evaluation.subject_artifact_hash, null);
  assert.throws(() => evaluate(makeCandidate(), {
    subject_artifact_hash: 'not-a-digest',
  }), /subject_artifact_hash/i);
});

test('stale candidate identity fails closed', () => {
  const candidate = makeCandidate();
  assert.throws(
    () => evaluate(candidate, { expected_candidate_hash: 'sha256:' + 'f'.repeat(64) }),
    /candidate hash mismatch/i
  );
});

test('candidate proposer cannot act as its independent evaluator', () => {
  const candidate = makeCandidate();
  assert.throws(
    () => evaluate(candidate, { assessor: proposer }),
    /independent evaluator/i
  );
  assert.throws(
    () => evaluate(candidate, {
      assessor: { ...proposer, authority_ref: 'local:changed-label' },
    }),
    /independent evaluator/i
  );
  assert.throws(
    () => evaluate(candidate, {
      assessor: { ...evaluator, authority_ref: proposer.authority_ref },
    }),
    /independent evaluator/i
  );
});

test('single sample and weak-only evidence cannot become promotion eligible', () => {
  const candidate = makeCandidate({
    evidence_refs: [episodeRef('episode-one', { signal_strength: 'weak' })],
  });
  const evaluated = evaluate(candidate);
  assert.strictEqual(evaluated.evaluation.eligibility.eligible, false);
  assert.ok(evaluated.evaluation.eligibility.reasons.includes('minimum-distinct-episodes'));
  assert.ok(evaluated.evaluation.eligibility.reasons.includes('explicit-user-signal-required'));
  assert.ok(evaluated.evaluation.eligibility.reasons.includes(
    'authoritative-journal-evidence-required'
  ));
});

test('evaluation counts only selected accepted verified fact Episode evidence', () => {
  const candidate = makeCandidate({
    evidence_refs: [
      episodeRef('episode-a'),
      episodeRef('episode-b'),
      episodeRef('episode-unverified', { assurance: 'observed', fact_status: 'unknown' }),
    ],
  });
  const selectedOne = evaluate(candidate, {
    evidence_ref_ids: [candidate.evidence_refs[0].evidence_id],
  });
  assert.strictEqual(selectedOne.evaluation.eligibility.sample_count, 0);
  assert.strictEqual(selectedOne.evaluation.eligibility.eligible, false);
  assert.ok(selectedOne.evaluation.eligibility.reasons.includes(
    'authoritative-journal-evidence-required'
  ));

  const includesUnverified = evaluate(candidate);
  assert.strictEqual(includesUnverified.evaluation.eligibility.sample_count, 0);
  assert.ok(includesUnverified.evaluation.eligibility.reasons.includes(
    'authoritative-journal-evidence-required'
  ));
  assert.strictEqual(includesUnverified.evaluation.eligibility.eligible, false);
});

test('inferred and weak evidence cannot independently satisfy the strong signal gate', () => {
  for (const signalStrength of ['inferred', 'weak']) {
    const candidate = makeCandidate({
      evidence_refs: [
        episodeRef(`episode-${signalStrength}-a`, { signal_strength: signalStrength }),
        episodeRef(`episode-${signalStrength}-b`, { signal_strength: signalStrength }),
      ],
    });
    const evaluated = evaluate(candidate);
    assert.strictEqual(evaluated.evaluation.eligibility.eligible, false);
    assert.ok(evaluated.evaluation.eligibility.reasons.includes('explicit-user-signal-required'));
    assert.ok(evaluated.evaluation.eligibility.reasons.includes(
      'authoritative-journal-evidence-required'
    ));
  }
});

test('needs-review evaluation cannot transition into shadow', () => {
  const evaluated = evaluate(makeCandidate({
    evidence_refs: [episodeRef('episode-only')],
  }));
  assert.throws(() => transitionCandidateState(evaluated, 'shadow', {
    expected_candidate_hash: evaluated.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T00:02:00.000Z',
  }), /promotion eligible|needs-review/i);
});

test('unresolved counterexample blocks eligibility', () => {
  const candidate = makeCandidate({
    counterexamples: [{
      evidence_ref: episodeRef('episode-counter'),
      disposition: 'unresolved',
    }],
  });
  const evaluated = evaluate(candidate);
  assert.strictEqual(evaluated.evaluation.eligibility.eligible, false);
  assert.ok(evaluated.evaluation.eligibility.reasons.includes('unresolved-counterexample'));
});

test('counterexample supporting rejection blocks eligibility', () => {
  const candidate = makeCandidate({
    counterexamples: [{
      evidence_ref: episodeRef('episode-rejection-counter'),
      disposition: 'supports-rejection',
    }],
  });
  const evaluated = evaluate(candidate);
  assert.strictEqual(evaluated.evaluation.eligibility.eligible, false);
  assert.ok(evaluated.evaluation.eligibility.reasons.includes('counterexample-supports-rejection'));
});

test('candidate cannot skip evaluated or shadow lifecycle stages', () => {
  const proposed = makeCandidate();
  assert.throws(
    () => transitionCandidateState(proposed, 'shadow', {
      expected_candidate_hash: proposed.candidate_hash,
      actor: evaluator,
      occurred_at: '2026-08-20T00:02:00.000Z',
    }),
    /invalid lifecycle transition/i
  );
  const evaluated = evaluate(proposed);
  assert.throws(
    () => transitionCandidateState(evaluated, 'approved', {
      expected_candidate_hash: evaluated.candidate_hash,
      actor: publisher,
      occurred_at: '2026-08-20T00:02:00.000Z',
    }),
    /invalid lifecycle transition/i
  );
});

test('raw EvidenceRefs cannot self-sign a shadow or reach approval helpers', () => {
  const evaluated = evaluate(makeCandidate());
  assert.strictEqual(evaluated.evaluation.decision, 'needs-review');
  assert.ok(evaluated.evaluation.eligibility.reasons.includes(
    'authoritative-journal-evidence-required'
  ));
  assert.throws(() => transitionCandidateState(evaluated, 'shadow', {
    expected_candidate_hash: evaluated.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T00:02:00.000Z',
  }), /needs-review|promotion eligible/i);
  assert.throws(() => createApprovalReceipt(evaluated, {
    expected_candidate_hash: evaluated.candidate_hash,
  }), /invalid lifecycle.*approved/i);
});

test('expiry is valid at creation and blocks evaluation and shadow gates at action time', () => {
  assert.throws(() => makeCandidate({
    expires_at: '2026-08-19T23:59:59.000Z',
  }), /expires_at.*created_at|expiry/i);

  const evaluationExpiry = makeCandidate({ expires_at: '2026-08-20T00:01:00.000Z' });
  assert.throws(() => evaluate(evaluationExpiry), /expired|expire/i);

  const shadowExpiry = makeCandidate({ expires_at: '2026-08-20T00:02:00.000Z' });
  const shadowEvaluation = evaluate(shadowExpiry);
  assert.throws(() => transitionCandidateState(shadowEvaluation, 'shadow', {
    expected_candidate_hash: shadowEvaluation.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T00:02:00.000Z',
  }), /expired|expire/i);
});

test('candidate actor identity rejects sensitive values before hashing', () => {
  assert.throws(() => makeCandidate({
    proposer: { kind: 'agent', id: `AKIA${'A'.repeat(16)}`, authority_ref: 'local:agent' },
  }), /sensitive|secret|redact/i);
});

test('scope correction invalidates evaluation and returns to proposed', () => {
  const evaluated = evaluate(makeCandidate());
  const corrected = correctCandidateScope(evaluated, {
    expected_candidate_hash: evaluated.candidate_hash,
    scope: { level: 'task', id: 'task:only-this' },
    actor: publisher,
    reason: '用户纠正：只对本任务有效',
    occurred_at: '2026-08-20T00:05:00.000Z',
  });
  assert.strictEqual(corrected.status, 'proposed');
  assert.strictEqual(corrected.scope.level, 'task');
  assert.strictEqual(corrected.evaluation, null);
  assert.ok(corrected.governance_history.some((item) => item.action === 'scope-corrected'));
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, err }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${err.stack || err.message}`);
  });
  process.exit(1);
}
