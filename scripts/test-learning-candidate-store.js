#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  appendRecord,
  resolveStoreDir,
  readJournal,
  tombstoneEntity,
} = require('./lib/self-learning-store');
const { appendBehaviorEvent, normalizeEvidenceRef } = require('./lib/behavior-events');
const { closeBehaviorEpisode } = require('./lib/behavior-episodes');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { addCase, readCases, resolveCasesFile } = require('./lib/skill-eval-cases');
const { stageEvaluationArtifactAuthority } = require('./lib/self-learning-evaluation-artifacts');
const {
  proposeCandidate,
  evaluateCandidate,
  transitionCandidate,
  approveCandidate,
  promoteCandidate,
  governCandidate,
  inspectCandidateStore,
  buildCandidateProjection,
  candidateHash,
  createApprovalReceipt,
} = require('./lib/learning-candidates');

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

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

const TEST_PROJECT_ID = detectStableProjectIdentity(process.cwd()).id;

function authorityBaseDir(storeDir) {
  return path.resolve(storeDir, '..', '..', '..', '..');
}

function caseResults(storeDir, candidate, passedCount = 2, caseCount = 2) {
  const baseDir = authorityBaseDir(storeDir);
  const name = `eval-${candidate.candidate_id.slice(3, 15)}`;
  if (!fs.existsSync(resolveCasesFile(name, baseDir))) {
    for (let index = 0; index < caseCount; index += 1) {
      const input = `case input ${index + 1}`;
      const prompt = appendBehaviorEvent(storeDir, eventInput(
        `eval-${candidate.candidate_id}-${index + 1}`,
        0,
        {
          project_id: candidate.project_id,
          input_value: input,
          source_event_id: `eval-prompt-${candidate.candidate_id}-${index + 1}`,
        }
      ));
      addCase(name, {
        id: `case-${index + 1}`,
        input,
        source_event_ref: prompt.event.event_id,
      }, { baseDir, cwd: process.cwd(), projectId: candidate.project_id });
    }
  }
  const results = Array.from({ length: caseCount }, (_unused, index) => ({
    case_id: `case-${index + 1}`,
    passed: index < passedCount,
  }));
  return {
    evaluation_artifact_authority: stageEvaluationArtifactAuthority(
      name,
      candidate.candidate_id,
      results,
      { baseDir, cwd: process.cwd(), projectId: candidate.project_id }
    ).authority,
  };
}

function frozenTarget(key, sourcePath = 'docs/self-learning-target.md') {
  return { key, source_path: sourcePath, source_hash: digest(`target:${key}:${sourcePath}`) };
}

function makeStore() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-candidate-store-'));
  return resolveStoreDir(baseDir, TEST_PROJECT_ID);
}

const agent = { kind: 'agent', id: 'agent:learner', authority_ref: 'local:agent' };
const evaluator = { kind: 'agent', id: 'agent:evaluator', authority_ref: 'local:evaluator' };
const user = { kind: 'user', id: 'user:owner', authority_ref: 'local:user' };

function eventInput(id, index, overrides = {}) {
  const sessionId = `session-${id}`;
  const taskRef = `task-${id}`;
  return {
    project_id: TEST_PROJECT_ID,
    session_id: sessionId,
    task_ref: taskRef,
    turn_ref: `turn-${id}-${index}`,
    parent_event_id: null,
    actor: { kind: index === 0 ? 'user' : 'agent', id: index === 0 ? 'user:seed' : 'agent:seed', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'task', id: taskRef },
    event_type: index === 0 ? 'user.prompt' : 'tool.request',
    signal_strength: index === 0 ? 'explicit' : 'inferred',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: {},
    input_value: { id, index },
    output_value: null,
    evidence_refs: [],
    occurred_at: `2026-08-20T01:00:0${index}.000Z`,
    source_event_id: `source-${id}-${index}`,
    ...overrides,
  };
}

function seedEvidence(storeDir, id, options = {}) {
  appendBehaviorEvent(storeDir, eventInput(id, 0));
  appendBehaviorEvent(storeDir, eventInput(id, 1));
  if (options.complete !== false) {
    appendBehaviorEvent(storeDir, eventInput(id, 2, {
      event_type: 'task.result',
      source: 'agent_loop',
      source_assurance: 'verified',
      status: 'succeeded',
      final_disposition: 'accepted',
      evidence_refs: [`evidence:${'c'.repeat(64)}`],
    }));
  }
  if (options.explicitFeedback !== false) {
    appendBehaviorEvent(storeDir, eventInput(id, 3, {
      actor: { kind: 'user', id: 'user:seed', role: null },
      event_type: options.correction === true ? 'user.correction' : 'user.feedback',
      signal_strength: 'explicit',
      source_assurance: 'explicit',
      status: 'observed',
      final_disposition: options.correction === true ? 'superseded' : 'accepted',
      details: options.correction === true ? { counterexample: true } : {},
    }));
  }
  const episodeResult = closeBehaviorEpisode(storeDir, {
    project_id: TEST_PROJECT_ID,
    session_id: `session-${id}`,
    task_ref: `task-${id}`,
    created_at: '2026-08-20T01:00:04.000Z',
    actor: { kind: 'system', id: 'episode-builder', runtime: 'codex', authority_ref: 'local:episode-builder' },
  });
  const episodeRecord = episodeResult;
  const episodeId = episodeResult.episode.episode_id;
  const evidence = normalizeEvidenceRef({
    schema_version: 'self-learning-evidence-ref-v1',
    source_type: 'behavior_episode',
    source_ref: episodeId,
    immutable_ref: `journal:${episodeId}`,
    digest: episodeRecord.record.payload_hash,
    uri: null,
    final_disposition: 'accepted',
    captured_at: '2026-08-20T01:00:00.000Z',
    scope: { level: 'project', id: TEST_PROJECT_ID },
    redaction_status: 'passed',
    assurance: 'verified',
    signal_strength: 'explicit',
    fact_status: 'fact',
  });
  appendRecord(storeDir, {
    record_type: 'evidence_ref',
    record_id: evidence.evidence_id,
    entity_id: evidence.evidence_id,
    actor: { kind: 'system', id: 'evidence-builder', runtime: 'unknown', authority_ref: null },
    occurred_at: evidence.captured_at,
    payload: evidence,
  });
  return evidence;
}

function reviseEpisode(storeDir, id) {
  appendBehaviorEvent(storeDir, eventInput(id, 4, {
    event_type: 'tool.result',
    status: 'succeeded',
    final_disposition: 'unknown',
  }));
  return closeBehaviorEpisode(storeDir, {
    project_id: TEST_PROJECT_ID,
    session_id: `session-${id}`,
    task_ref: `task-${id}`,
    created_at: '2026-08-20T01:00:05.000Z',
    actor: { kind: 'system', id: 'episode-builder', runtime: 'codex', authority_ref: 'local:episode-builder' },
  });
}

function proposalInput(storeDir) {
  return {
    project_id: TEST_PROJECT_ID,
    kind: 'workflow',
    statement: { text: '先验证身份，再执行目标操作', fact_status: 'inference' },
    target: frozenTarget('workflow.identity-first'),
    scope: { level: 'project', id: TEST_PROJECT_ID },
    proposer: agent,
    evidence_refs: [seedEvidence(storeDir, 'episode-a'), seedEvidence(storeDir, 'episode-b')],
    counterexamples: [],
    occurred_at: '2026-08-20T01:00:00.000Z',
  };
}

test('proposal appends one authoritative record and replay is idempotent', () => {
  const storeDir = makeStore();
  const input = proposalInput(storeDir);
  const first = proposeCandidate(storeDir, input);
  const second = proposeCandidate(storeDir, input);
  assert.strictEqual(first.changed, true);
  assert.strictEqual(second.changed, false);
  assert.strictEqual(first.candidate.candidate_hash, second.candidate.candidate_hash);
  assert.strictEqual(readJournal(storeDir).revision, 13);
});

test('semantic duplicate proposal enriches evidence as a new proposed revision and exact replay is a no-op', () => {
  const storeDir = makeStore();
  const input = proposalInput(storeDir);
  const first = proposeCandidate(storeDir, input).candidate;
  const evaluated = evaluateCandidate(storeDir, first.candidate_id, {
    expected_candidate_hash: first.candidate_hash,
    rubric_version: 'tv-v1', truth_score: 0.9, value_score: 0.9,
    ...caseResults(storeDir, first),
    assessor: evaluator,
    evidence_ref_ids: first.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T01:01:00.000Z',
  }).candidate;
  const extraEvidence = seedEvidence(storeDir, 'episode-c');
  const enriched = proposeCandidate(storeDir, {
    ...input,
    evidence_refs: [...input.evidence_refs, extraEvidence],
    occurred_at: '2026-08-20T01:02:00.000Z',
  });
  assert.strictEqual(enriched.changed, true);
  assert.strictEqual(enriched.candidate.revision, evaluated.revision + 1);
  assert.strictEqual(enriched.candidate.previous_candidate_hash, evaluated.candidate_hash);
  assert.strictEqual(enriched.candidate.status, 'proposed');
  assert.strictEqual(enriched.candidate.evidence_refs.length, 3);
  assert.strictEqual(enriched.candidate.evaluation, null);
  assert.strictEqual(enriched.candidate.approval, null);
  assert.strictEqual(enriched.candidate.promotion, null);

  const replay = proposeCandidate(storeDir, {
    ...input,
    evidence_refs: [...input.evidence_refs, extraEvidence],
    occurred_at: '2026-08-20T01:03:00.000Z',
  });
  assert.strictEqual(replay.changed, false);
  assert.strictEqual(replay.candidate.candidate_hash, enriched.candidate.candidate_hash);
});

test('semantic proposal revision tightens policy and expiry but never lowers or extends them', () => {
  const storeDir = makeStore();
  const input = {
    ...proposalInput(storeDir),
    expires_at: '2026-09-10T00:00:00.000Z',
  };
  const first = proposeCandidate(storeDir, input).candidate;
  const tightenedPolicy = proposeCandidate(storeDir, {
    ...input,
    policy: {
      minimum_distinct_episodes: 3,
      minimum_truth_score: 0.85,
      minimum_value_score: 0.7,
    },
    occurred_at: '2026-08-20T01:01:00.000Z',
  });
  assert.strictEqual(tightenedPolicy.changed, true);
  assert.strictEqual(tightenedPolicy.candidate.revision, first.revision + 1);
  assert.deepStrictEqual(tightenedPolicy.candidate.policy, {
    minimum_distinct_episodes: 3,
    minimum_truth_score: 0.85,
    minimum_value_score: 0.7,
  });

  const lowerAndLater = proposeCandidate(storeDir, {
    ...input,
    policy: {
      minimum_distinct_episodes: 2,
      minimum_truth_score: 0.7,
      minimum_value_score: 0.5,
    },
    expires_at: '2026-09-20T00:00:00.000Z',
    occurred_at: '2026-08-20T01:02:00.000Z',
  });
  assert.strictEqual(lowerAndLater.changed, false);
  assert.deepStrictEqual(lowerAndLater.candidate.policy, tightenedPolicy.candidate.policy);
  assert.strictEqual(lowerAndLater.candidate.retention.expires_at, '2026-09-10T00:00:00.000Z');

  const earlierExpiry = proposeCandidate(storeDir, {
    ...input,
    policy: tightenedPolicy.candidate.policy,
    expires_at: '2026-09-01T00:00:00.000Z',
    occurred_at: '2026-08-20T01:03:00.000Z',
  });
  assert.strictEqual(earlierExpiry.changed, true);
  assert.strictEqual(earlierExpiry.candidate.retention.expires_at, '2026-09-01T00:00:00.000Z');
  assert.deepStrictEqual(earlierExpiry.candidate.policy, tightenedPolicy.candidate.policy);
});

test('semantic proposal enrichment rejects proposer or owner impersonation', () => {
  const storeDir = makeStore();
  const input = proposalInput(storeDir);
  proposeCandidate(storeDir, input);
  assert.throws(() => proposeCandidate(storeDir, {
    ...input,
    proposer: { kind: 'agent', id: 'agent:impostor', authority_ref: 'local:impostor' },
  }), /proposer|authority|identity/i);
  assert.throws(() => proposeCandidate(storeDir, {
    ...input,
    owner: { kind: 'user', id: 'user:impostor', authority_ref: 'local:impostor' },
  }), /owner|authority|identity/i);
});

test('counterexample enrichment is monotonic and cannot resolve adverse evidence', () => {
  const storeDir = makeStore();
  const input = proposalInput(storeDir);
  const counterEvidence = seedEvidence(storeDir, 'episode-monotonic-counter');
  const unresolved = proposeCandidate(storeDir, {
    ...input,
    counterexamples: [{ evidence_ref: counterEvidence, disposition: 'unresolved' }],
  }).candidate;
  assert.throws(() => proposeCandidate(storeDir, {
    ...input,
    counterexamples: [{ evidence_ref: counterEvidence, disposition: 'resolved' }],
    occurred_at: '2026-08-20T01:01:00.000Z',
  }), /counterexample|monotonic|resolved/i);
  const tightened = proposeCandidate(storeDir, {
    ...input,
    counterexamples: [{ evidence_ref: counterEvidence, disposition: 'supports-rejection' }],
    occurred_at: '2026-08-20T01:02:00.000Z',
  });
  assert.strictEqual(tightened.changed, true);
  assert.strictEqual(tightened.candidate.revision, unresolved.revision + 1);
  assert.strictEqual(tightened.candidate.counterexamples[0].disposition, 'supports-rejection');
  assert.throws(() => proposeCandidate(storeDir, {
    ...input,
    counterexamples: [{ evidence_ref: counterEvidence, disposition: 'resolved' }],
    occurred_at: '2026-08-20T01:03:00.000Z',
  }), /counterexample|monotonic|resolved/i);
});

test('proposal rejects evidence that was not committed to the authority journal', () => {
  const storeDir = makeStore();
  const otherStore = makeStore();
  const uncommittedHere = proposalInput(otherStore);
  assert.throws(
    () => proposeCandidate(storeDir, uncommittedHere),
    /missing from the authoritative journal/i
  );
  assert.strictEqual(readJournal(storeDir).revision, 0);
});

test('self-asserted EvidenceRef strength cannot replace authoritative explicit user feedback', () => {
  const storeDir = makeStore();
  const evidenceRefs = [
    seedEvidence(storeDir, 'self-signed-a', { explicitFeedback: false }),
    seedEvidence(storeDir, 'self-signed-b', { explicitFeedback: false }),
  ];
  assert(evidenceRefs.every((ref) => ref.signal_strength === 'explicit'));
  const proposed = proposeCandidate(storeDir, {
    project_id: TEST_PROJECT_ID,
    kind: 'workflow',
    statement: { text: 'Do not trust self-asserted evidence semantics', fact_status: 'fact' },
    target: frozenTarget('authority.recompute-evidence'),
    scope: { level: 'project', id: TEST_PROJECT_ID },
    proposer: agent,
    evidence_refs: evidenceRefs,
    counterexamples: [],
    occurred_at: '2026-08-20T01:00:10.000Z',
  }).candidate;
  const evaluated = evaluateCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: proposed.candidate_hash,
    rubric_version: 'tv-v1', truth_score: 1, value_score: 1,
    ...caseResults(storeDir, proposed),
    assessor: evaluator,
    evidence_ref_ids: proposed.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T01:01:00.000Z',
  }).candidate;
  assert.strictEqual(evaluated.evaluation.eligibility.eligible, false);
  assert.ok(evaluated.evaluation.eligibility.reasons.includes('explicit-user-signal-required'));
  assert.throws(() => transitionCandidate(storeDir, proposed.candidate_id, 'shadow', {
    expected_candidate_hash: evaluated.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T01:02:00.000Z',
  }), /needs-review|eligible/i);
});

test('verified corrections require exact evaluator relations; support can qualify and refutation blocks', () => {
  function correctionProposal(storeDir, kind, target) {
    return proposeCandidate(storeDir, {
      project_id: TEST_PROJECT_ID,
      kind,
      statement: { text: `Correction-derived ${kind}`, fact_status: 'fact' },
      target: frozenTarget(target),
      scope: { level: 'project', id: TEST_PROJECT_ID },
      proposer: agent,
      evidence_refs: [
        seedEvidence(storeDir, `${kind}-correction-a`, { correction: true }),
        seedEvidence(storeDir, `${kind}-correction-b`, { correction: true }),
      ],
      counterexamples: [],
      occurred_at: '2026-08-20T01:00:10.000Z',
    }).candidate;
  }
  function relations(candidate, relation) {
    return candidate.evidence_refs.map((ref) => ({
      evidence_ref_id: ref.evidence_id,
      episode_id: ref.source_ref,
      candidate_id: candidate.candidate_id,
      candidate_hash: candidate.candidate_hash,
      relation,
    }));
  }
  function assess(storeDir, candidate, relation) {
    return evaluateCandidate(storeDir, candidate.candidate_id, {
      expected_candidate_hash: candidate.candidate_hash,
      rubric_version: 'tv-v1', truth_score: 1, value_score: 1,
      ...caseResults(storeDir, candidate),
      assessor: evaluator,
      evidence_ref_ids: candidate.evidence_refs.map((ref) => ref.evidence_id),
      evidence_relations: relation ? relations(candidate, relation) : [],
      counterexamples_reviewed: true,
      assessed_at: '2026-08-20T01:01:00.000Z',
    }).candidate;
  }

  const boundaryStore = makeStore();
  const boundaryCandidate = correctionProposal(
    boundaryStore, 'boundary', 'boundary.correction-derived'
  );
  const unresolvedBoundary = assess(boundaryStore, boundaryCandidate, null);
  assert.strictEqual(unresolvedBoundary.evaluation.eligibility.eligible, false);
  assert.ok(unresolvedBoundary.evaluation.eligibility.reasons.some((reason) =>
    reason.startsWith('unresolved-correction-relation:')));

  const supportedBoundaryStore = makeStore();
  const supportedBoundaryCandidate = correctionProposal(
    supportedBoundaryStore, 'boundary', 'boundary.correction-supported'
  );
  const boundary = assess(supportedBoundaryStore, supportedBoundaryCandidate, 'supports');
  assert.strictEqual(boundary.evaluation.eligibility.eligible, true);
  assert.strictEqual(transitionCandidate(supportedBoundaryStore, boundary.candidate_id, 'shadow', {
    expected_candidate_hash: boundary.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T01:02:00.000Z',
  }).candidate.status, 'shadow');

  const antiPatternStore = makeStore();
  const antiPattern = assess(
    antiPatternStore,
    correctionProposal(antiPatternStore, 'anti_pattern', 'anti-pattern.correction-derived'),
    'supports'
  );
  assert.strictEqual(antiPattern.evaluation.eligibility.eligible, true);

  const strategyStore = makeStore();
  const strategy = assess(
    strategyStore,
    correctionProposal(strategyStore, 'strategy', 'strategy.old-behavior'),
    'refutes'
  );
  assert.strictEqual(strategy.evaluation.eligibility.eligible, false);
  assert.ok(strategy.evaluation.eligibility.reasons.some((reason) =>
    reason.startsWith('correction-refutes-candidate:')));
  assert.throws(() => transitionCandidate(strategyStore, strategy.candidate_id, 'shadow', {
    expected_candidate_hash: strategy.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T01:02:00.000Z',
  }), /needs-review|eligible|correction/i);

  const forgedStore = makeStore();
  const forgedCandidate = correctionProposal(
    forgedStore, 'boundary', 'boundary.forged-relation'
  );
  assert.throws(() => evaluateCandidate(forgedStore, forgedCandidate.candidate_id, {
    expected_candidate_hash: forgedCandidate.candidate_hash,
    rubric_version: 'tv-v1', truth_score: 1, value_score: 1,
    ...caseResults(forgedStore, forgedCandidate),
    assessor: evaluator,
    evidence_ref_ids: forgedCandidate.evidence_refs.map((ref) => ref.evidence_id),
    evidence_relations: relations(forgedCandidate, 'supports').map((item) => ({
      ...item, candidate_hash: digest('forged-candidate-hash'),
    })),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T01:01:00.000Z',
  }), /evidence_relations|candidate_hash|relation/i);
});

test('store projection enforces full lifecycle and exposes only promoted context', () => {
  const storeDir = makeStore();
  const initialInput = proposalInput(storeDir);
  const proposed = proposeCandidate(storeDir, initialInput).candidate;
  const evaluated = evaluateCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: proposed.candidate_hash,
    rubric_version: 'tv-v1', truth_score: 0.9, value_score: 0.9,
    ...caseResults(storeDir, proposed),
    assessor: evaluator,
    evidence_ref_ids: proposed.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T01:01:00.000Z',
  }).candidate;
  const shadow = transitionCandidate(storeDir, proposed.candidate_id, 'shadow', {
    expected_candidate_hash: evaluated.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T01:02:00.000Z',
  }).candidate;
  let view = inspectCandidateStore(storeDir);
  assert.strictEqual(view.candidates[0].status, 'shadow');
  assert.strictEqual(view.context.promoted.length, 0);
  const postPromotionEvidence = seedEvidence(storeDir, 'episode-after-promotion');

  const malformedApproval = appendRecord(storeDir, {
    record_type: 'behavior_event',
    record_id: 'malformed-approval-event',
    entity_id: 'malformed-approval-event',
    actor: { kind: 'user', id: user.id, runtime: 'codex', authority_ref: 'unvalidated' },
    occurred_at: '2026-08-20T01:02:15.000Z',
    payload: {
      event_id: 'malformed-approval-event',
      event_type: 'user.approval',
      signal_strength: 'explicit',
      actor: user,
      details: { action: 'approve', candidate_id: shadow.candidate_id, candidate_hash: shadow.candidate_hash },
    },
  });
  assert.throws(() => approveCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: {
      event_id: 'malformed-approval-event',
      event_hash: malformedApproval.record.payload_hash,
    },
    publisher: user,
    approved_at: '2026-08-20T01:02:20.000Z',
  }), /valid BehaviorEvent/i);

  const approvalResult = appendBehaviorEvent(storeDir, {
    project_id: TEST_PROJECT_ID,
    session_id: 'session-approval',
    task_ref: 'task-approval',
    turn_ref: null,
    parent_event_id: null,
    actor: { kind: 'user', id: user.id, role: 'publisher' },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'task', id: 'task-approval' },
    event_type: 'user.approval',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'accepted',
    details: { action: 'approve', candidate_id: shadow.candidate_id, candidate_hash: shadow.candidate_hash },
    input_value: null,
    output_value: null,
    evidence_refs: [],
    occurred_at: '2026-08-20T01:02:30.000Z',
    source_event_id: 'approval-event-1',
  });
  const approvalEvent = {
    ...approvalResult.event,
    event_hash: approvalResult.record.payload_hash,
  };
  const approvalPublisher = { ...user, authority_ref: approvalResult.record.actor.authority_ref };

  const crossProjectResult = appendBehaviorEvent(storeDir, {
    project_id: 'different-project',
    session_id: 'session-cross-project-approval',
    task_ref: 'task-cross-project-approval',
    turn_ref: null,
    parent_event_id: null,
    actor: { kind: 'user', id: user.id, role: 'publisher' },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'task', id: 'task-cross-project-approval' },
    event_type: 'user.approval',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'accepted',
    details: { action: 'approve', candidate_id: shadow.candidate_id, candidate_hash: shadow.candidate_hash },
    input_value: null,
    output_value: null,
    evidence_refs: [],
    occurred_at: '2026-08-20T01:02:35.000Z',
    source_event_id: 'approval-cross-project-1',
  });
  assert.throws(() => approveCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: {
      ...crossProjectResult.event,
      event_hash: crossProjectResult.record.payload_hash,
    },
    publisher: { ...user, authority_ref: crossProjectResult.record.actor.authority_ref },
    approved_at: '2026-08-20T01:02:40.000Z',
  }), /project/i);
  assert.throws(() => approveCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: { ...approvalEvent, event_hash: digest('not-stored') },
    publisher: approvalPublisher,
    approved_at: '2026-08-20T01:03:00.000Z',
  }), /authoritative journal/i);
  const approvedResult = approveCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: approvalEvent,
    publisher: approvalPublisher,
    approved_at: '2026-08-20T01:03:00.000Z',
  });
  const promoted = promoteCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: approvedResult.candidate.candidate_hash,
    approval_receipt: approvedResult.receipt,
    publisher: approvalPublisher,
    promoted_at: '2026-08-20T01:04:00.000Z',
  }).candidate;
  assert.strictEqual(promoted.status, 'promoted');
  view = inspectCandidateStore(storeDir);
  assert.strictEqual(view.context.promoted.length, 1);
  assert.strictEqual(view.context.shadow.length, 0);
  assert.throws(() => proposeCandidate(storeDir, {
    ...initialInput,
    evidence_refs: [...proposed.evidence_refs, postPromotionEvidence],
    occurred_at: '2026-08-20T01:05:00.000Z',
  }), /promoted|terminal|lifecycle/i);
});

test('evaluation authority fails closed when a case source is tombstoned before candidate append', () => {
  const storeDir = makeStore();
  const proposed = proposeCandidate(storeDir, proposalInput(storeDir)).candidate;
  const evaluationCases = caseResults(storeDir, proposed);
  const baseDir = authorityBaseDir(storeDir);
  const name = `eval-${proposed.candidate_id.slice(3, 15)}`;
  const sourceEventRef = readCases(name, { baseDir })[0].source_trace.source_event_ref;
  const sourceRecord = readJournal(storeDir).records.find((record) =>
    record.record_type === 'behavior_event' && record.entity_id === sourceEventRef);
  assert(sourceRecord, 'case source BehaviorEvent fixture must exist');

  tombstoneEntity(storeDir, {
    record_id: `tombstone:${sourceEventRef}:evaluation-race`,
    target_id: sourceEventRef,
    target_hash: sourceRecord.record_hash,
    actor: { kind: 'user', id: user.id, runtime: 'codex', authority_ref: user.authority_ref },
    occurred_at: '2026-08-20T01:00:30.000Z',
    reason: 'case source withdrawn before evaluation commit',
  });

  assert.throws(() => evaluateCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: proposed.candidate_hash,
    rubric_version: 'tv-v1', truth_score: 1, value_score: 1,
    ...evaluationCases,
    assessor: evaluator,
    evidence_ref_ids: proposed.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T01:01:00.000Z',
  }), /evaluation artifact authority.*journal|revision conflict|head hash conflict/i);

  const projected = inspectCandidateStore(storeDir).candidates.find((candidate) =>
    candidate.candidate_id === proposed.candidate_id);
  assert.strictEqual(projected.revision, proposed.revision);
  assert.strictEqual(projected.status, 'proposed');
  assert.strictEqual(projected.evaluation, null);
  assert.strictEqual(readJournal(storeDir).records.filter((record) =>
    record.record_type === 'candidate_evaluation'
      && record.entity_id === proposed.candidate_id).length, 0);
});

test('forward gates fail closed when Episode state is incomplete, stale, or tombstoned', () => {
  const incompleteStore = makeStore();
  const incompleteInput = proposalInput(incompleteStore);
  incompleteInput.evidence_refs[1] = seedEvidence(incompleteStore, 'episode-incomplete', { complete: false });
  const incomplete = proposeCandidate(incompleteStore, incompleteInput).candidate;
  const reviewed = evaluateCandidate(incompleteStore, incomplete.candidate_id, {
    expected_candidate_hash: incomplete.candidate_hash,
    rubric_version: 'tv-v1', truth_score: 1, value_score: 1,
    ...caseResults(incompleteStore, incomplete),
    assessor: evaluator,
    evidence_ref_ids: incomplete.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T01:01:00.000Z',
  }).candidate;
  assert.strictEqual(reviewed.evaluation.eligibility.eligible, false);
  assert.ok(reviewed.evaluation.eligibility.reasons.some((reason) => /incomplete|unverified/.test(reason)));
  assert.throws(() => transitionCandidate(incompleteStore, incomplete.candidate_id, 'shadow', {
    expected_candidate_hash: reviewed.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T01:02:00.000Z',
  }), /needs-review|eligible/i);

  const staleStore = makeStore();
  const stale = proposeCandidate(staleStore, proposalInput(staleStore)).candidate;
  const staleEvaluated = evaluateCandidate(staleStore, stale.candidate_id, {
    expected_candidate_hash: stale.candidate_hash,
    rubric_version: 'tv-v1', truth_score: 1, value_score: 1,
    ...caseResults(staleStore, stale),
    assessor: evaluator,
    evidence_ref_ids: stale.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T01:01:00.000Z',
  }).candidate;
  reviseEpisode(staleStore, 'episode-a');
  assert.throws(() => transitionCandidate(staleStore, stale.candidate_id, 'shadow', {
    expected_candidate_hash: staleEvaluated.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T01:02:00.000Z',
  }), /digest mismatch|needs-review/i);

  const tombstoneStore = makeStore();
  const tombstoned = proposeCandidate(tombstoneStore, proposalInput(tombstoneStore)).candidate;
  const tombstoneEvaluated = evaluateCandidate(tombstoneStore, tombstoned.candidate_id, {
    expected_candidate_hash: tombstoned.candidate_hash,
    rubric_version: 'tv-v1', truth_score: 1, value_score: 1,
    ...caseResults(tombstoneStore, tombstoned),
    assessor: evaluator,
    evidence_ref_ids: tombstoned.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T01:01:00.000Z',
  }).candidate;
  const journal = readJournal(tombstoneStore);
  const evidenceRecord = journal.records.find((record) => record.entity_id === tombstoned.evidence_refs[0].evidence_id);
  tombstoneEntity(tombstoneStore, {
    record_id: 'tombstone:evidence-a',
    target_id: evidenceRecord.entity_id,
    target_hash: evidenceRecord.record_hash,
    actor: { kind: 'user', id: user.id, runtime: 'codex', authority_ref: user.authority_ref },
    occurred_at: '2026-08-20T01:01:30.000Z',
    reason: 'evidence withdrawn',
  });
  assert.throws(() => transitionCandidate(tombstoneStore, tombstoned.candidate_id, 'shadow', {
    expected_candidate_hash: tombstoneEvaluated.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T01:02:00.000Z',
  }), /tombstoned|needs-review/i);

  const eventTombstoneStore = makeStore();
  const eventTombstoned = proposeCandidate(
    eventTombstoneStore,
    proposalInput(eventTombstoneStore)
  ).candidate;
  const eventTombstoneEvaluated = evaluateCandidate(
    eventTombstoneStore,
    eventTombstoned.candidate_id,
    {
      expected_candidate_hash: eventTombstoned.candidate_hash,
      rubric_version: 'tv-v1', truth_score: 1, value_score: 1,
      ...caseResults(eventTombstoneStore, eventTombstoned),
      assessor: evaluator,
      evidence_ref_ids: eventTombstoned.evidence_refs.map((ref) => ref.evidence_id),
      counterexamples_reviewed: true,
      assessed_at: '2026-08-20T01:01:00.000Z',
    }
  ).candidate;
  const eventJournal = readJournal(eventTombstoneStore);
  const feedbackRecord = eventJournal.records.find((record) =>
    record.record_type === 'behavior_event'
      && record.payload.event_type === 'user.feedback');
  tombstoneEntity(eventTombstoneStore, {
    record_id: 'tombstone:explicit-feedback-event',
    target_id: feedbackRecord.entity_id,
    target_hash: feedbackRecord.record_hash,
    actor: { kind: 'user', id: user.id, runtime: 'codex', authority_ref: user.authority_ref },
    occurred_at: '2026-08-20T01:01:30.000Z',
    reason: 'explicit feedback withdrawn',
  });
  assert.strictEqual(
    inspectCandidateStore(eventTombstoneStore).candidates[0].effective_status,
    'needs-review'
  );
  assert.throws(() => transitionCandidate(
    eventTombstoneStore,
    eventTombstoned.candidate_id,
    'shadow',
    {
      expected_candidate_hash: eventTombstoneEvaluated.candidate_hash,
      actor: evaluator,
      occurred_at: '2026-08-20T01:02:00.000Z',
    }
  ), /tombstoned|needs-review|feedback/i);
});

test('projection rejects a low-level forged promoted state', () => {
  const storeDir = makeStore();
  const proposed = proposeCandidate(storeDir, proposalInput(storeDir)).candidate;
  const forged = {
    ...proposed,
    status: 'promoted',
    revision: proposed.revision + 1,
    previous_candidate_hash: proposed.candidate_hash,
    updated_at: '2026-08-20T01:01:00.000Z',
  };
  forged.candidate_hash = candidateHash(forged);
  appendRecord(storeDir, {
    record_type: 'candidate_transition',
    record_id: `candidate:${forged.candidate_id}:r${forged.revision}`,
    entity_id: forged.candidate_id,
    actor: { kind: 'user', id: user.id, runtime: 'codex', authority_ref: user.authority_ref },
    occurred_at: forged.updated_at,
    payload: {
      schema_version: 'self-learning-candidate-state-v1',
      action: 'promoted',
      candidate: forged,
    },
  });
  assert.throws(() => buildCandidateProjection(readJournal(storeDir)), /invalid lifecycle|forged|invariant|audit entry/i);
});

test('approval authority is journal-bound and orphan receipt recovery stays private until state binding', () => {
  const storeDir = makeStore();
  const proposed = proposeCandidate(storeDir, proposalInput(storeDir)).candidate;
  const evaluated = evaluateCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: proposed.candidate_hash,
    rubric_version: 'tv-v1', truth_score: 1, value_score: 1,
    ...caseResults(storeDir, proposed),
    assessor: evaluator,
    evidence_ref_ids: proposed.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T01:01:00.000Z',
  }).candidate;
  const shadow = transitionCandidate(storeDir, proposed.candidate_id, 'shadow', {
    expected_candidate_hash: evaluated.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T01:02:00.000Z',
  }).candidate;
  const untrustedApproval = appendBehaviorEvent(storeDir, {
    project_id: TEST_PROJECT_ID, session_id: 'session-mcp-approval', task_ref: 'task-mcp-approval',
    turn_ref: null, parent_event_id: null,
    actor: { kind: 'user', id: user.id, role: 'publisher' }, runtime: 'codex', source: 'codex_mcp',
    source_assurance: 'explicit', scope: { level: 'task', id: 'task-mcp-approval' },
    event_type: 'user.approval', signal_strength: 'explicit', fact_status: 'fact', status: 'observed',
    final_disposition: 'accepted',
    details: { action: 'approve', candidate_id: shadow.candidate_id, candidate_hash: shadow.candidate_hash },
    input_value: null, output_value: null, evidence_refs: [],
    occurred_at: '2026-08-20T01:02:10.000Z', source_event_id: 'mcp-self-reported-approval',
  });
  assert.throws(() => approveCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: { ...untrustedApproval.event, event_hash: untrustedApproval.record.payload_hash },
    publisher: { ...user, authority_ref: 'mcp-self-reported-approval' },
    approved_at: '2026-08-20T01:02:20.000Z',
  }), /trusted|codex_cli|authority/i);
  const approvalResult = appendBehaviorEvent(storeDir, {
    project_id: TEST_PROJECT_ID, session_id: 'session-approval-recovery', task_ref: 'task-approval-recovery',
    turn_ref: null, parent_event_id: null,
    actor: { kind: 'user', id: user.id, role: 'publisher' }, runtime: 'codex', source: 'codex_cli',
    source_assurance: 'explicit', scope: { level: 'task', id: 'task-approval-recovery' },
    event_type: 'user.approval', signal_strength: 'explicit', fact_status: 'fact', status: 'observed',
    final_disposition: 'accepted',
    details: { action: 'approve', candidate_id: shadow.candidate_id, candidate_hash: shadow.candidate_hash },
    input_value: null, output_value: null, evidence_refs: [],
    occurred_at: '2026-08-20T01:02:30.000Z', source_event_id: 'approval-recovery-1',
  });
  const approvalPublisher = { ...user, authority_ref: approvalResult.record.actor.authority_ref };
  const approvalEvent = { ...approvalResult.event, event_hash: approvalResult.record.payload_hash };
  assert.throws(() => approveCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: approvalEvent,
    publisher: user,
    approved_at: '2026-08-20T01:03:00.000Z',
  }), /authority/i);

  const receipt = createApprovalReceipt(shadow, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: { ...approvalEvent, actor: approvalPublisher },
    publisher: approvalPublisher,
    approved_at: '2026-08-20T01:03:00.000Z',
  });
  appendRecord(storeDir, {
    record_type: 'approval_receipt',
    record_id: `receipt:${receipt.receipt_id}`,
    entity_id: receipt.receipt_id,
    actor: { ...approvalPublisher, runtime: 'unknown' },
    occurred_at: receipt.approved_at,
    payload: { schema_version: 'self-learning-approval-record-v1', receipt },
  });
  assert.deepStrictEqual(inspectCandidateStore(storeDir).receipts, []);

  const recovered = approveCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: approvalEvent,
    publisher: approvalPublisher,
    approved_at: '2026-08-20T01:03:00.000Z',
  });
  assert.strictEqual(recovered.candidate.status, 'approved');
  assert.strictEqual(inspectCandidateStore(storeDir).receipts.length, 1);
  assert.strictEqual(inspectCandidateStore(storeDir).receipts[0].receipt_hash, receipt.receipt_hash);

  const approvalRecord = readJournal(storeDir).records.find((record) =>
    record.record_type === 'behavior_event' && record.entity_id === approvalEvent.event_id
  );
  tombstoneEntity(storeDir, {
    record_id: 'tombstone:approval-recovery-1',
    target_id: approvalRecord.entity_id,
    target_hash: approvalRecord.record_hash,
    actor: { kind: 'user', id: user.id, runtime: 'codex', authority_ref: approvalPublisher.authority_ref },
    occurred_at: '2026-08-20T01:03:30.000Z',
    reason: 'approval withdrawn',
  });
  assert.strictEqual(inspectCandidateStore(storeDir).candidates[0].effective_status, 'needs-review');
  assert.throws(() => promoteCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: recovered.candidate.candidate_hash,
    approval_receipt: recovered.receipt,
    publisher: approvalPublisher,
    promoted_at: '2026-08-20T01:04:00.000Z',
  }), /needs-review|tombstoned|approval/i);
});

test('tombstoned orphan receipt retry fails before approved append and leaves replay valid', () => {
  const storeDir = makeStore();
  const proposed = proposeCandidate(storeDir, proposalInput(storeDir)).candidate;
  const evaluated = evaluateCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: proposed.candidate_hash,
    rubric_version: 'tv-v1', truth_score: 1, value_score: 1,
    ...caseResults(storeDir, proposed),
    assessor: evaluator,
    evidence_ref_ids: proposed.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-20T01:01:00.000Z',
  }).candidate;
  const shadow = transitionCandidate(storeDir, proposed.candidate_id, 'shadow', {
    expected_candidate_hash: evaluated.candidate_hash,
    actor: evaluator,
    occurred_at: '2026-08-20T01:02:00.000Z',
  }).candidate;
  const eventResult = appendBehaviorEvent(storeDir, {
    project_id: TEST_PROJECT_ID, session_id: 'session-tombstoned-receipt', task_ref: 'task-tombstoned-receipt',
    turn_ref: null, parent_event_id: null,
    actor: { kind: 'user', id: user.id, role: 'publisher' }, runtime: 'codex', source: 'codex_cli',
    source_assurance: 'explicit', scope: { level: 'task', id: 'task-tombstoned-receipt' },
    event_type: 'user.approval', signal_strength: 'explicit', fact_status: 'fact', status: 'observed',
    final_disposition: 'accepted',
    details: { action: 'approve', candidate_id: shadow.candidate_id, candidate_hash: shadow.candidate_hash },
    input_value: null, output_value: null, evidence_refs: [],
    occurred_at: '2026-08-20T01:02:30.000Z', source_event_id: 'approval-tombstoned-receipt-1',
  });
  const publisher = { ...user, authority_ref: eventResult.record.actor.authority_ref };
  const approvalEvent = { ...eventResult.event, event_hash: eventResult.record.payload_hash };
  const receipt = createApprovalReceipt(shadow, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: { ...approvalEvent, actor: publisher },
    publisher,
    approved_at: '2026-08-20T01:03:00.000Z',
  });
  const receiptRecord = appendRecord(storeDir, {
    record_type: 'approval_receipt',
    record_id: `receipt:${receipt.receipt_id}`,
    entity_id: receipt.receipt_id,
    actor: { ...publisher, runtime: 'unknown' },
    occurred_at: receipt.approved_at,
    payload: { schema_version: 'self-learning-approval-record-v1', receipt },
  }).record;
  tombstoneEntity(storeDir, {
    record_id: 'tombstone:orphan-receipt',
    target_id: receipt.receipt_id,
    target_hash: receiptRecord.record_hash,
    actor: { kind: 'user', id: user.id, runtime: 'codex', authority_ref: publisher.authority_ref },
    occurred_at: '2026-08-20T01:03:30.000Z',
    reason: 'withdraw orphan receipt',
  });
  const before = readJournal(storeDir).revision;
  assert.throws(() => approveCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: approvalEvent,
    publisher,
    approved_at: '2026-08-20T01:03:00.000Z',
  }), /receipt.*tombstoned|tombstoned.*receipt/i);
  assert.strictEqual(readJournal(storeDir).revision, before);
  const projection = inspectCandidateStore(storeDir);
  assert.strictEqual(projection.candidates[0].status, 'shadow');
  assert.strictEqual(projection.receipts.length, 0);
});

test('govern tombstone hides candidate but preserves immutable journal', () => {
  const storeDir = makeStore();
  const proposed = proposeCandidate(storeDir, proposalInput(storeDir)).candidate;
  const result = governCandidate(storeDir, proposed.candidate_id, {
    action: 'tombstone',
    expected_candidate_hash: proposed.candidate_hash,
    actor: user,
    reason: '用户要求删除该学习项',
    occurred_at: '2026-08-20T01:05:00.000Z',
  });
  assert.strictEqual(result.changed, true);
  const view = inspectCandidateStore(storeDir);
  assert.strictEqual(view.candidates.length, 0);
  assert.strictEqual(view.tombstoned.length, 1);
  assert.strictEqual(readJournal(storeDir).revision, 14);
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
