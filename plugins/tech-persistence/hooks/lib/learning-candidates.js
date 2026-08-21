'use strict';

const {
  assertExactKeys,
  assertRedactionStableString,
  canonicalize,
  stableHash,
  normalizeTimestamp,
  redactCanonicalValue,
} = require('./self-learning-canonical');
const {
  appendRecord,
  readJournal,
  tombstoneEntity,
} = require('./self-learning-store');
const {
  journalActorForEvent,
  isTrustedUserAuthorityEvent,
  normalizeBehaviorEvent,
  normalizeEvidenceRef: normalizeUnifiedEvidenceRef,
} = require('./behavior-events');
const {
  assessEpisodeJournal,
} = require('./behavior-episodes');
const {
  assertEvaluationArtifactAuthority,
  evaluationAuthorityAppendOptions,
} = require('./self-learning-evaluation-artifacts');

const CANDIDATE_SCHEMA_VERSION = 'self-learning-candidate-v1';
const CANDIDATE_EVALUATION_SCHEMA_VERSION = 'self-learning-candidate-evaluation-v1';
const APPROVAL_RECEIPT_SCHEMA_VERSION = 'self-learning-approval-receipt-v1';
const TV_RUBRIC_VERSION = 'tv-v1';
const CANDIDATE_KINDS = Object.freeze([
  'preference',
  'environment_fact',
  'strategy',
  'workflow',
  'boundary',
  'anti_pattern',
]);
const FACT_STATUSES = new Set(['fact', 'inference', 'unknown']);
const SCOPE_LEVELS = new Set(['session', 'task', 'project', 'personal', 'global', 'team']);
const ACTOR_KINDS = new Set(['user', 'agent', 'system', 'tool']);
const SIGNAL_STRENGTHS = new Set(['explicit', 'weak', 'inferred']);
const TERMINAL_STATUSES = new Set(['rejected', 'expired', 'tombstoned']);
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_POLICY = Object.freeze({
  minimum_distinct_episodes: 2,
  minimum_truth_score: 0.75,
  minimum_value_score: 0.6,
});
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const CANDIDATE_STATE_RECORD_SCHEMA_VERSION = 'self-learning-candidate-state-v1';
const APPROVAL_RECORD_SCHEMA_VERSION = 'self-learning-approval-record-v1';
const CANDIDATE_KEYS = Object.freeze([
  'schema_version', 'candidate_id', 'candidate_hash', 'project_id', 'kind',
  'statement', 'target', 'scope', 'proposer', 'owner', 'evidence_refs',
  'counterexamples', 'confidence', 'policy', 'status', 'revision',
  'previous_candidate_hash', 'evaluation', 'approval', 'promotion', 'retention',
  'authority', 'governance_history', 'created_at', 'updated_at',
]);
const EVALUATION_KEYS = Object.freeze([
  'schema_version', 'evaluation_id', 'evaluation_hash', 'candidate_id',
  'candidate_hash', 'rubric_version', 'truth_score', 'value_score', 'assessor',
  'evidence_ref_ids', 'evidence_relations', 'evidence_set_hash', 'baseline_hash', 'case_set_hash',
  'subject_artifact_hash', 'case_results_hash', 'case_count', 'passed_count',
  'pass_rate', 'evaluator_hash', 'seed', 'counterexamples_reviewed',
  'assessed_at', 'eligibility', 'decision',
]);
const ELIGIBILITY_KEYS = Object.freeze([
  'eligible', 'reasons', 'sample_count', 'minimum_distinct_episodes',
]);
const APPROVAL_RECEIPT_KEYS = Object.freeze([
  'schema_version', 'receipt_id', 'receipt_hash', 'candidate_id', 'candidate_hash',
  'evaluation_hash', 'approval_event_ref', 'publisher', 'approved_at',
  'authority_semantics',
]);
const APPROVAL_EVENT_REF_KEYS = Object.freeze(['event_id', 'event_hash']);
const ACTOR_KEYS = Object.freeze(['kind', 'id', 'authority_ref']);
const EVIDENCE_RELATION_KEYS = Object.freeze([
  'evidence_ref_id', 'episode_id', 'candidate_id', 'candidate_hash', 'relation',
]);
const EVIDENCE_RELATIONS = new Set(['supports', 'refutes']);
const CANDIDATE_ID_RE = /^lc-[a-f0-9]{32}$/;
const EVALUATION_ID_RE = /^eval-[a-f0-9]{32}$/;
const RECEIPT_ID_RE = /^approval-[a-f0-9]{32}$/;
const POLICY_KEYS = Object.freeze([
  'minimum_distinct_episodes',
  'minimum_truth_score',
  'minimum_value_score',
]);
const FORWARD_ACTIONS = new Set(['evaluated', 'shadow', 'approved', 'promoted']);
const LIFECYCLE_TRANSITIONS = Object.freeze({
  proposed: new Set(['rejected', 'expired', 'needs-review']),
  evaluated: new Set(['shadow', 'rejected', 'expired', 'needs-review']),
  shadow: new Set(['approved', 'rejected', 'expired', 'needs-review']),
  approved: new Set(['promoted', 'rejected', 'expired', 'needs-review']),
  promoted: new Set(['expired', 'tombstoned', 'needs-review']),
  'needs-review': new Set(['proposed', 'rejected', 'expired', 'tombstoned']),
});
const AUTHORITATIVE_EVIDENCE_TOKEN = Symbol('authoritative-evidence-token');
const EVALUATION_REPLAY_TOKEN = Symbol('evaluation-replay-token');
const RAW_CASE_SUMMARY_FIELDS = Object.freeze([
  'case_set_hash', 'case_results_hash', 'case_count', 'passed_count', 'pass_rate',
]);

function fail(message) {
  const error = new Error(`learning-candidates: ${message}`);
  error.code = 'SELF_LEARNING_CANDIDATE_INVALID';
  throw error;
}

function assertNonEmptyString(value, field, maxLength = 4096) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  if (value.length > maxLength) fail(`${field} exceeds ${maxLength} characters`);
  return value.trim();
}

function assertEnum(value, values, field) {
  if (!values.has(value)) fail(`${field} has unsupported value "${value}"`);
  return value;
}

function asSha256(value) {
  const raw = stableHash(value);
  return String(raw).startsWith('sha256:') ? String(raw) : `sha256:${raw}`;
}

function assertDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    fail(`${field} must be a sha256 digest`);
  }
  return value;
}

function clone(value) {
  return canonicalize(value);
}

function normalizeCaseAggregate(input, fieldPrefix = 'candidate evaluation') {
  const caseResultsHash = assertDigest(input.case_results_hash, `${fieldPrefix}.case_results_hash`);
  const caseCount = input.case_count;
  const passedCount = input.passed_count;
  if (!Number.isInteger(caseCount) || caseCount < 1) {
    fail(`${fieldPrefix}.case_count must be an integer >= 1`);
  }
  if (!Number.isInteger(passedCount) || passedCount < 0 || passedCount > caseCount) {
    fail(`${fieldPrefix}.passed_count must be a nonnegative integer not greater than case_count`);
  }
  if (typeof input.pass_rate !== 'number' || !Number.isFinite(input.pass_rate)
      || input.pass_rate < 0 || input.pass_rate > 1) {
    fail(`${fieldPrefix}.pass_rate must be a finite number in [0,1]`);
  }
  const expectedPassRate = passedCount / caseCount;
  if (!Object.is(input.pass_rate, expectedPassRate)) {
    fail(`${fieldPrefix}.pass_rate must be derived from passed_count/case_count`);
  }
  return {
    case_results_hash: caseResultsHash,
    case_count: caseCount,
    passed_count: passedCount,
    pass_rate: expectedPassRate,
  };
}

function authoritativeCaseSummary(candidate, input) {
  if (input._evaluation_replay_token === EVALUATION_REPLAY_TOKEN) {
    const replay = input._evaluation_replay_summary;
    if (!replay || typeof replay !== 'object') fail('evaluation replay summary is missing');
    return {
      case_set_hash: assertDigest(replay.case_set_hash, 'evaluation replay.case_set_hash'),
      ...normalizeCaseAggregate(replay, 'evaluation replay'),
    };
  }
  const suppliedRawFields = RAW_CASE_SUMMARY_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(input, field));
  if (suppliedRawFields.length > 0) {
    fail(`caller-provided raw case summary is forbidden: ${suppliedRawFields.join(', ')}`);
  }
  let authority;
  try {
    authority = assertEvaluationArtifactAuthority(input.evaluation_artifact_authority);
  } catch (error) {
    fail(`evaluation artifact authority is invalid: ${error.message}`);
  }
  if (authority.candidate_id !== candidate.candidate_id) {
    fail('evaluation artifact authority candidate_id mismatch');
  }
  if (authority.project_id !== candidate.project_id) {
    fail('evaluation artifact authority project_id mismatch');
  }
  const targetName = /^(?:skill|command):([a-z][a-z0-9-]{0,63})$/.exec(candidate.target.key);
  if (targetName && authority.name !== targetName[1]) {
    fail('evaluation artifact authority name does not match candidate target');
  }
  return {
    case_set_hash: assertDigest(authority.case_set_hash, 'evaluation artifact.case_set_hash'),
    ...normalizeCaseAggregate(authority, 'evaluation artifact'),
  };
}

function normalizeEvidenceRelations(candidate, input, referenced) {
  if (!Array.isArray(input)) fail('evidence_relations must be an array');
  const evidenceById = new Map(candidate.evidence_refs.map((ref) => [ref.evidence_id, ref]));
  const seen = new Set();
  return input.map((item, index) => {
    try {
      assertExactKeys(item, EVIDENCE_RELATION_KEYS, `evidence_relations[${index}]`);
    } catch (error) {
      fail(`evidence_relations[${index}] exact shape is invalid: ${error.message}`);
    }
    const evidenceRefId = assertNonEmptyString(
      item.evidence_ref_id,
      `evidence_relations[${index}].evidence_ref_id`,
      256
    );
    if (seen.has(evidenceRefId)) fail(`duplicate evidence relation for ${evidenceRefId}`);
    seen.add(evidenceRefId);
    if (!referenced.has(evidenceRefId)) {
      fail(`evidence relation ${evidenceRefId} is not selected by evidence_ref_ids`);
    }
    const evidence = evidenceById.get(evidenceRefId);
    if (!evidence || evidence.source_type !== 'behavior_episode') {
      fail(`evidence relation ${evidenceRefId} must reference candidate BehaviorEpisode evidence`);
    }
    if (item.episode_id !== evidence.source_ref) {
      fail(`evidence relation ${evidenceRefId} episode_id mismatch`);
    }
    if (item.candidate_id !== candidate.candidate_id
        || item.candidate_hash !== candidate.candidate_hash) {
      fail(`evidence relation ${evidenceRefId} candidate_id/candidate_hash mismatch`);
    }
    return {
      evidence_ref_id: evidenceRefId,
      episode_id: evidence.source_ref,
      candidate_id: candidate.candidate_id,
      candidate_hash: candidate.candidate_hash,
      relation: assertEnum(
        item.relation,
        EVIDENCE_RELATIONS,
        `evidence_relations[${index}].relation`
      ),
    };
  }).sort((left, right) => left.evidence_ref_id.localeCompare(right.evidence_ref_id));
}

function assertPersistedEvidenceRelations(evaluation) {
  const candidate = {
    candidate_id: evaluation.candidate_id,
    candidate_hash: evaluation.candidate_hash,
    evidence_refs: evaluation.evidence_relations.map((item) => ({
      evidence_id: item.evidence_ref_id,
      source_type: 'behavior_episode',
      source_ref: item.episode_id,
    })),
  };
  return normalizeEvidenceRelations(
    candidate,
    evaluation.evidence_relations,
    new Set(evaluation.evidence_ref_ids)
  );
}

function normalizeActor(input, field = 'actor', options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${field} is required`);
  const actorKeys = options.allow_runtime === true ? [...ACTOR_KEYS, 'runtime'] : ACTOR_KEYS;
  try {
    assertExactKeys(input, actorKeys, field);
  } catch (error) {
    fail(`${field} must have an exact actor shape: ${error.message}`);
  }
  const kind = assertEnum(input.kind, ACTOR_KINDS, `${field}.kind`);
  const id = assertRedactionStableString(
    assertNonEmptyString(input.id, `${field}.id`, 256),
    `${field}.id`
  );
  const authorityRef = input.authority_ref == null
    ? null
    : assertRedactionStableString(
      assertNonEmptyString(input.authority_ref, `${field}.authority_ref`, 512),
      `${field}.authority_ref`
    );
  return { kind, id, authority_ref: authorityRef };
}

function normalizeScope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('scope is required');
  return {
    level: assertEnum(input.level, SCOPE_LEVELS, 'scope.level'),
    id: assertRedactionStableString(
      assertNonEmptyString(input.id, 'scope.id', 512),
      'scope.id'
    ),
  };
}

function normalizePolicy(input) {
  if (input == null) return clone(DEFAULT_POLICY);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('policy must be an exact object');
  }
  try {
    assertExactKeys(input, POLICY_KEYS, 'policy');
  } catch (error) {
    fail(`policy must contain exact fields: ${error.message}`);
  }
  const minimumDistinctEpisodes = Number(input.minimum_distinct_episodes);
  if (!Number.isInteger(minimumDistinctEpisodes) || minimumDistinctEpisodes < 2) {
    fail('policy.minimum_distinct_episodes must be an integer >= 2');
  }
  return {
    minimum_distinct_episodes: minimumDistinctEpisodes,
    minimum_truth_score: normalizeScore(input.minimum_truth_score, 'policy.minimum_truth_score'),
    minimum_value_score: normalizeScore(input.minimum_value_score, 'policy.minimum_value_score'),
  };
}

function normalizeStatement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('statement is required');
  return {
    text: assertNonEmptyString(redactCanonicalValue(input.text), 'statement.text', 8000),
    fact_status: assertEnum(input.fact_status, FACT_STATUSES, 'statement.fact_status'),
  };
}

function normalizeTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('target is required');
  try {
    assertExactKeys(input, ['key', 'source_path', 'source_hash'], 'candidate target');
  } catch (error) {
    fail(`target must contain exact key/source_path/source_hash fields: ${error.message}`);
  }
  const key = assertRedactionStableString(
    assertNonEmptyString(redactCanonicalValue(input.key), 'target.key', 512),
    'target.key'
  );
  const sourcePath = assertRedactionStableString(
    assertNonEmptyString(redactCanonicalValue(input.source_path), 'target.source_path', 1024),
    'target.source_path'
  );
  const segments = sourcePath.split('/');
  if (sourcePath.includes('\\')
      || sourcePath.startsWith('/')
      || /^[A-Za-z]:/.test(sourcePath)
      || !/^[A-Za-z0-9._/-]+$/.test(sourcePath)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('target.source_path must be a canonical repository-relative path without traversal');
  }
  const skillMatch = /^skill:([a-z][a-z0-9-]{0,63})$/.exec(key);
  if (skillMatch) {
    const name = skillMatch[1];
    const allowed = new Set([
      `codex-native/skills/${name}/SKILL.md`,
      `user-level/skills/${name}/SKILL.md`,
    ]);
    if (!allowed.has(sourcePath)) {
      fail('skill target.source_path is outside the frozen skill source allowlist');
    }
  }
  const commandMatch = /^command:([a-z][a-z0-9-]{0,63})$/.exec(key);
  if (commandMatch && sourcePath !== `user-level/commands/${commandMatch[1]}.md`) {
    fail('command target.source_path is outside the frozen command source allowlist');
  }
  return {
    key,
    source_path: sourcePath,
    source_hash: assertDigest(input.source_hash, 'target.source_hash'),
  };
}

function normalizeEvidenceRef(input, index = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(`evidence_refs[${index}] must be an object`);
  }
  try {
    return normalizeUnifiedEvidenceRef(input);
  } catch (error) {
    fail(`evidence_refs[${index}] is invalid: ${error.message}`);
  }
}

function normalizeCounterexample(input, index = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(`counterexamples[${index}] must be an object`);
  }
  const dispositions = new Set(['unresolved', 'resolved', 'supports-rejection']);
  return {
    evidence_ref: normalizeEvidenceRef(input.evidence_ref, index),
    disposition: assertEnum(input.disposition, dispositions, `counterexamples[${index}].disposition`),
  };
}

function candidateHash(candidate) {
  const core = clone(candidate);
  delete core.candidate_hash;
  return asSha256(core);
}

function withCandidateHash(candidate) {
  const normalized = clone(candidate);
  normalized.candidate_hash = candidateHash(normalized);
  return normalized;
}

function assertEvaluation(evaluation) {
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
    fail('candidate evaluation is required');
  }
  try {
    assertExactKeys(evaluation, EVALUATION_KEYS, 'candidate evaluation');
  } catch (error) {
    fail(`candidate evaluation exact shape is invalid: ${error.message}`);
  }
  if (evaluation.schema_version !== CANDIDATE_EVALUATION_SCHEMA_VERSION) {
    fail('unsupported candidate evaluation schema version');
  }
  if (typeof evaluation.evaluation_id !== 'string'
      || !EVALUATION_ID_RE.test(evaluation.evaluation_id)) {
    fail('candidate evaluation_id is invalid');
  }
  if (typeof evaluation.candidate_id !== 'string'
      || !CANDIDATE_ID_RE.test(evaluation.candidate_id)) {
    fail('candidate evaluation candidate_id is invalid');
  }
  assertDigest(evaluation.candidate_hash, 'candidate.evaluation.candidate_hash');
  if (evaluation.rubric_version !== TV_RUBRIC_VERSION) {
    fail('candidate evaluation rubric_version is unsupported');
  }
  normalizeScore(evaluation.truth_score, 'candidate.evaluation.truth_score');
  normalizeScore(evaluation.value_score, 'candidate.evaluation.value_score');
  const assessor = normalizeActor(evaluation.assessor, 'candidate evaluation assessor');
  if (!Array.isArray(evaluation.evidence_ref_ids)
      || evaluation.evidence_ref_ids.length === 0
      || new Set(evaluation.evidence_ref_ids).size !== evaluation.evidence_ref_ids.length
      || evaluation.evidence_ref_ids.some((id) =>
        typeof id !== 'string' || !/^evidence:[a-f0-9]{64}$/.test(id))) {
    fail('candidate evaluation evidence_ref_ids are invalid');
  }
  if (!Array.isArray(evaluation.evidence_relations)) {
    fail('candidate evaluation evidence_relations must be an array');
  }
  if (!canonicalEqual(
    assertPersistedEvidenceRelations(evaluation),
    evaluation.evidence_relations
  )) {
    fail('candidate evaluation evidence_relations are not canonical');
  }
  assertDigest(evaluation.evidence_set_hash, 'candidate.evaluation.evidence_set_hash');
  for (const field of ['baseline_hash', 'subject_artifact_hash']) {
    if (evaluation[field] !== null) assertDigest(evaluation[field], `candidate.evaluation.${field}`);
  }
  assertDigest(evaluation.case_set_hash, 'candidate.evaluation.case_set_hash');
  normalizeCaseAggregate(evaluation);
  const expectedEvaluatorHash = asSha256({ assessor, rubric_version: evaluation.rubric_version });
  if (evaluation.evaluator_hash !== expectedEvaluatorHash) {
    fail('candidate evaluation evaluator_hash mismatch');
  }
  if (evaluation.seed !== null && typeof evaluation.seed !== 'string') {
    fail('candidate evaluation seed must be a string or null');
  }
  if (typeof evaluation.counterexamples_reviewed !== 'boolean') {
    fail('candidate evaluation counterexamples_reviewed must be boolean');
  }
  normalizeTimestamp(evaluation.assessed_at, 'candidate evaluation assessed_at');
  try {
    assertExactKeys(evaluation.eligibility, ELIGIBILITY_KEYS, 'candidate evaluation eligibility');
  } catch (error) {
    fail(`candidate evaluation eligibility exact shape is invalid: ${error.message}`);
  }
  if (typeof evaluation.eligibility.eligible !== 'boolean'
      || !Array.isArray(evaluation.eligibility.reasons)
      || new Set(evaluation.eligibility.reasons).size !== evaluation.eligibility.reasons.length
      || evaluation.eligibility.reasons.some((reason) =>
        typeof reason !== 'string' || reason.length === 0)
      || !Number.isInteger(evaluation.eligibility.sample_count)
      || evaluation.eligibility.sample_count < 0
      || !Number.isInteger(evaluation.eligibility.minimum_distinct_episodes)
      || evaluation.eligibility.minimum_distinct_episodes < 2) {
    fail('candidate evaluation eligibility is invalid');
  }
  const expectedDecision = evaluation.eligibility.eligible ? 'pass' : 'needs-review';
  if (evaluation.decision !== expectedDecision) fail('candidate evaluation decision mismatch');
  assertDigest(evaluation.evaluation_hash, 'candidate.evaluation.evaluation_hash');
  const identityCore = clone(evaluation);
  delete identityCore.evaluation_hash;
  identityCore.evaluation_id = '';
  const expectedEvaluationId = `eval-${asSha256(identityCore).slice(7, 39)}`;
  if (evaluation.evaluation_id !== expectedEvaluationId) {
    fail('candidate evaluation_id content binding mismatch');
  }
  if (evaluationHash(evaluation) !== evaluation.evaluation_hash) {
    fail('candidate evaluation hash mismatch');
  }
  return evaluation;
}

function assertCandidateIntegrity(candidate) {
  if (!candidate || typeof candidate !== 'object') fail('candidate is required');
  assertExactKeys(candidate, CANDIDATE_KEYS, 'LearningCandidate');
  if (candidate.schema_version !== CANDIDATE_SCHEMA_VERSION) fail('unsupported candidate schema version');
  if (!CANDIDATE_KINDS.includes(candidate.kind)) fail('candidate kind is unsupported');
  if (!Number.isInteger(candidate.revision) || candidate.revision < 1) fail('candidate revision is invalid');
  if (candidate.previous_candidate_hash !== null) {
    assertDigest(candidate.previous_candidate_hash, 'candidate.previous_candidate_hash');
  }
  assertDigest(candidate.candidate_hash, 'candidate.candidate_hash');
  if (candidate.evaluation !== null) {
    assertEvaluation(candidate.evaluation);
    if (candidate.evaluation.candidate_id !== candidate.candidate_id) {
      fail('candidate evaluation candidate_id mismatch');
    }
    for (const relation of candidate.evaluation.evidence_relations) {
      const evidence = candidate.evidence_refs.find((ref) =>
        ref.evidence_id === relation.evidence_ref_id);
      if (!evidence
          || evidence.source_type !== 'behavior_episode'
          || evidence.source_ref !== relation.episode_id) {
        fail('candidate evaluation evidence_relations do not match candidate evidence');
      }
    }
  }
  const actual = candidateHash(candidate);
  if (actual !== candidate.candidate_hash) {
    fail(`candidate hash mismatch: expected ${candidate.candidate_hash}, computed ${actual}`);
  }
  return candidate;
}

function assertExpectedHash(candidate, expectedHash) {
  assertCandidateIntegrity(candidate);
  if (!expectedHash || expectedHash !== candidate.candidate_hash) {
    fail(`candidate hash mismatch: expected current ${candidate.candidate_hash}, got ${expectedHash || '(missing)'}`);
  }
}

function normalizeConfidence(input, evidenceRefs) {
  if (input == null) {
    const explicit = evidenceRefs.filter((ref) => ref.signal_strength === 'explicit').length;
    const managed = evidenceRefs.filter((ref) => ref.assurance === 'verified').length;
    return {
      score: Math.min(0.95, 0.2 + explicit * 0.2 + managed * 0.15),
      basis: explicit > 0 ? 'explicit-evidence' : managed > 0 ? 'verified-evidence' : 'weak-signal',
    };
  }
  if (!input || typeof input !== 'object') fail('confidence must be an object');
  const score = Number(input.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) fail('confidence.score must be in [0,1]');
  return {
    score,
    basis: assertNonEmptyString(
      redactCanonicalValue(input.basis),
      'confidence.basis',
      256
    ),
  };
}

function createLearningCandidate(input = {}) {
  const kind = CANDIDATE_KINDS.includes(input.kind)
    ? input.kind
    : fail(`kind must be one of ${CANDIDATE_KINDS.join(', ')}`);
  const projectId = assertRedactionStableString(
    assertNonEmptyString(input.project_id, 'project_id', 256),
    'project_id'
  );
  const statement = normalizeStatement(input.statement);
  const target = normalizeTarget(input.target);
  const candidateScope = normalizeScope(input.scope);
  if (candidateScope.level === 'project' && candidateScope.id !== projectId) {
    fail('project scope.id must match candidate project_id');
  }
  const candidateProposer = normalizeActor(input.proposer, 'proposer');
  const evidenceRefs = Array.isArray(input.evidence_refs)
    ? input.evidence_refs.map(normalizeEvidenceRef)
    : fail('evidence_refs must be an array');
  if (evidenceRefs.length === 0) {
    fail('evidence_refs must contain at least one evidence reference');
  }
  const counterexamples = Array.isArray(input.counterexamples || [])
    ? (input.counterexamples || []).map(normalizeCounterexample)
    : fail('counterexamples must be an array');
  const createdAt = normalizeTimestamp(input.occurred_at, 'occurred_at');
  const expiresAt = input.expires_at == null
    ? null
    : normalizeTimestamp(input.expires_at, 'expires_at');
  if (expiresAt !== null && Date.parse(expiresAt) < Date.parse(createdAt)) {
    fail('expires_at must not be earlier than created_at');
  }
  const identityCore = { project_id: projectId, kind, statement, target, scope: candidateScope };
  const idHash = asSha256(identityCore).slice('sha256:'.length, 'sha256:'.length + 32);
  const policy = normalizePolicy(input.policy);
  return withCandidateHash({
    schema_version: CANDIDATE_SCHEMA_VERSION,
    candidate_id: `lc-${idHash}`,
    project_id: projectId,
    kind,
    statement,
    target,
    scope: candidateScope,
    proposer: candidateProposer,
    owner: normalizeActor(input.owner || input.proposer, 'owner'),
    evidence_refs: evidenceRefs,
    counterexamples,
    confidence: normalizeConfidence(input.confidence, evidenceRefs),
    policy,
    status: 'proposed',
    revision: 1,
    previous_candidate_hash: null,
    evaluation: null,
    approval: null,
    promotion: null,
    retention: {
      expires_at: expiresAt,
      tombstoned: false,
    },
    authority: {
      collector_ref: input.collector_ref == null
        ? null
        : assertRedactionStableString(
          assertNonEmptyString(input.collector_ref, 'collector_ref', 512),
          'collector_ref'
        ),
      proposer_ref: candidateProposer.authority_ref,
      evaluator_ref: null,
      publisher_ref: null,
    },
    governance_history: [],
    created_at: createdAt,
    updated_at: createdAt,
  });
}

function normalizeScore(value, field) {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) fail(`${field} must be in [0,1]`);
  return score;
}

function candidateExpiryTimestamp(candidate, retentionDays = null) {
  if (!candidate || !candidate.retention || candidate.retention.tombstoned !== false) {
    fail('candidate retention is missing, tombstoned, or invalid');
  }
  if (candidate.retention.expires_at !== null) {
    return normalizeTimestamp(candidate.retention.expires_at, 'candidate retention expires_at');
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    if (retentionDays === null) return null;
    fail('default retention_days must be an integer >= 1');
  }
  const anchor = normalizeTimestamp(
    candidate.updated_at || candidate.created_at,
    'candidate default retention anchor'
  );
  const expiresAt = new Date(Date.parse(anchor) + retentionDays * MILLISECONDS_PER_DAY);
  if (Number.isNaN(expiresAt.getTime())) fail('candidate default expiry is outside the supported date range');
  return expiresAt.toISOString();
}

function assertCandidateNotExpiredAt(candidate, timestamp, action, retentionDays = null) {
  const checkedAt = normalizeTimestamp(timestamp, `${action} checked_at`);
  const expiresAt = candidateExpiryTimestamp(candidate, retentionDays);
  if (expiresAt !== null && Date.parse(checkedAt) >= Date.parse(expiresAt)) {
    fail(`candidate expired before ${action} at ${expiresAt}; append an audited expired transition`);
  }
  return expiresAt;
}

function buildEligibility(candidate, evaluation, authoritativeReasons = [], authorityFacts = null) {
  const reasons = [...authoritativeReasons];
  const referenced = new Set(evaluation.evidence_ref_ids || []);
  const relationByEvidence = new Map(
    evaluation.evidence_relations.map((item) => [item.evidence_ref_id, item])
  );
  const episodeIds = new Set();
  let hasStrongEvidence = false;
  if (!authorityFacts) {
    reasons.push('authoritative-journal-evidence-required');
  } else {
    const factsByEvidence = new Map(authorityFacts.map((fact) => [fact.evidence_id, fact]));
    for (const fact of authorityFacts.filter((item) => item.has_correction === true)) {
      const relation = relationByEvidence.get(fact.evidence_id);
      if (!referenced.has(fact.evidence_id) || !relation) {
        reasons.push(`unresolved-correction-relation:${fact.episode_id}`);
      } else if (relation.relation === 'refutes') {
        reasons.push(`correction-refutes-candidate:${fact.episode_id}`);
      }
    }
    for (const relation of evaluation.evidence_relations) {
      const fact = factsByEvidence.get(relation.evidence_ref_id);
      if (!fact || fact.has_correction !== true) {
        reasons.push(`relation-without-correction:${relation.episode_id}`);
      }
    }
    for (const fact of authorityFacts.filter((item) => referenced.has(item.evidence_id))) {
      const relation = relationByEvidence.get(fact.evidence_id);
      const qualifying = fact.has_correction === true
        ? Boolean(relation
          && relation.relation === 'supports'
          && fact.correction_qualifying === true)
        : fact.ordinary_qualifying === true;
      if (!qualifying) continue;
      episodeIds.add(fact.episode_id);
      if (fact.explicit_user_signal === true) hasStrongEvidence = true;
    }
  }
  if (episodeIds.size < candidate.policy.minimum_distinct_episodes) {
    reasons.push('minimum-distinct-episodes');
  }
  if (!hasStrongEvidence) {
    reasons.push('explicit-user-signal-required');
  }
  if (candidate.statement.fact_status === 'unknown') reasons.push('unknown-statement');
  if (evaluation.truth_score < candidate.policy.minimum_truth_score) reasons.push('truth-threshold');
  if (evaluation.value_score < candidate.policy.minimum_value_score) reasons.push('value-threshold');
  if (!evaluation.counterexamples_reviewed) reasons.push('counterexamples-not-reviewed');
  if (candidate.counterexamples.some((item) => item.disposition === 'unresolved')) {
    reasons.push('unresolved-counterexample');
  }
  if (candidate.counterexamples.some((item) => item.disposition === 'supports-rejection')) {
    reasons.push('counterexample-supports-rejection');
  }
  return {
    eligible: new Set(reasons).size === 0,
    reasons: [...new Set(reasons)].sort(),
    sample_count: episodeIds.size,
    minimum_distinct_episodes: candidate.policy.minimum_distinct_episodes,
  };
}

function evaluationHash(evaluation) {
  const core = clone(evaluation);
  delete core.evaluation_hash;
  return asSha256(core);
}

function evaluateCandidateState(candidate, input = {}) {
  assertExpectedHash(candidate, input.expected_candidate_hash);
  if (!['proposed', 'evaluated', 'needs-review'].includes(candidate.status)) {
    fail(`invalid lifecycle transition ${candidate.status} -> evaluated`);
  }
  const assessor = normalizeActor(input.assessor, 'assessor');
  const sharesProposerId = assessor.id === candidate.proposer.id;
  const sharesProposerAuthority = assessor.authority_ref !== null
    && candidate.proposer.authority_ref !== null
    && assessor.authority_ref === candidate.proposer.authority_ref;
  if (sharesProposerId || sharesProposerAuthority) {
    fail('candidate evaluation requires an independent evaluator');
  }
  const rubricVersion = assertNonEmptyString(input.rubric_version, 'rubric_version', 128);
  if (rubricVersion !== TV_RUBRIC_VERSION) fail(`unsupported rubric version "${rubricVersion}"`);
  const referenced = new Set(Array.isArray(input.evidence_ref_ids) ? input.evidence_ref_ids : []);
  if (referenced.size === 0) fail('evaluation must reference evidence');
  const available = new Set(candidate.evidence_refs.map((ref) => ref.evidence_id));
  for (const refId of referenced) {
    if (!available.has(refId)) fail(`evaluation references unknown evidence "${refId}"`);
  }
  const evidenceRelations = normalizeEvidenceRelations(
    candidate,
    input.evidence_relations === undefined ? [] : input.evidence_relations,
    referenced
  );
  const assessedAt = normalizeTimestamp(input.assessed_at, 'assessed_at');
  assertCandidateNotExpiredAt(candidate, assessedAt, 'evaluation');
  const caseSummary = authoritativeCaseSummary(candidate, input);
  const evaluation = {
    schema_version: CANDIDATE_EVALUATION_SCHEMA_VERSION,
    evaluation_id: '',
    candidate_id: candidate.candidate_id,
    candidate_hash: candidate.candidate_hash,
    rubric_version: rubricVersion,
    truth_score: normalizeScore(input.truth_score, 'truth_score'),
    value_score: normalizeScore(input.value_score, 'value_score'),
    assessor,
    evidence_ref_ids: [...referenced].sort(),
    evidence_relations: evidenceRelations,
    evidence_set_hash: asSha256(candidate.evidence_refs
      .filter((ref) => referenced.has(ref.evidence_id))
      .map((ref) => ({ evidence_id: ref.evidence_id, digest: ref.digest }))
      .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id))),
    baseline_hash: input.baseline_hash == null ? null : assertDigest(input.baseline_hash, 'baseline_hash'),
    case_set_hash: caseSummary.case_set_hash,
    subject_artifact_hash: input.subject_artifact_hash == null
      ? null
      : assertDigest(input.subject_artifact_hash, 'subject_artifact_hash'),
    case_results_hash: caseSummary.case_results_hash,
    case_count: caseSummary.case_count,
    passed_count: caseSummary.passed_count,
    pass_rate: caseSummary.pass_rate,
    evaluator_hash: asSha256({ assessor, rubric_version: rubricVersion }),
    seed: input.seed == null
      ? null
      : assertRedactionStableString(String(input.seed), 'seed'),
    counterexamples_reviewed: input.counterexamples_reviewed === true,
    assessed_at: assessedAt,
  };
  const authoritativeReasons = Array.isArray(input._authoritative_eligibility_reasons)
    ? input._authoritative_eligibility_reasons.map((reason) =>
      assertNonEmptyString(reason, 'authoritative eligibility reason', 512))
    : [];
  const authorityFacts = input._authoritative_evidence_token === AUTHORITATIVE_EVIDENCE_TOKEN
    && Array.isArray(input._authoritative_evidence_facts)
    ? input._authoritative_evidence_facts
    : null;
  evaluation.eligibility = buildEligibility(
    candidate,
    evaluation,
    authoritativeReasons,
    authorityFacts
  );
  evaluation.decision = evaluation.eligibility.eligible ? 'pass' : 'needs-review';
  evaluation.evaluation_id = `eval-${asSha256(evaluation).slice(7, 39)}`;
  evaluation.evaluation_hash = evaluationHash(evaluation);

  return withCandidateHash({
    ...clone(candidate),
    status: 'evaluated',
    revision: candidate.revision + 1,
    previous_candidate_hash: candidate.candidate_hash,
    evaluation,
    approval: null,
    promotion: null,
    authority: {
      ...candidate.authority,
      evaluator_ref: assessor.authority_ref,
      publisher_ref: null,
    },
    updated_at: assessedAt,
  });
}

function receiptHash(receipt) {
  const core = clone(receipt);
  delete core.receipt_hash;
  return asSha256(core);
}

function assertApprovalEvent(candidate, event, publisher) {
  if (!event || typeof event !== 'object') fail('explicit user approval event required');
  if (event.event_type !== 'user.approval'
      || event.source !== 'codex_cli'
      || event.source_assurance !== 'explicit'
      || event.signal_strength !== 'explicit') {
    fail('explicit native codex_cli user approval event required');
  }
  if (event.final_disposition !== 'accepted') {
    fail('explicit user approval event must be accepted');
  }
  if (event.project_id !== candidate.project_id) {
    fail('approval event project_id must match candidate project_id');
  }
  const eventActor = normalizeActor(event.actor, 'approval_event.actor');
  if (eventActor.kind !== 'user' || publisher.kind !== 'user' || eventActor.id !== publisher.id) {
    fail('approval event must be emitted by the publishing user');
  }
  if (eventActor.authority_ref !== null
      && eventActor.authority_ref !== publisher.authority_ref) {
    fail('approval event authority must match publisher authority');
  }
  assertDigest(event.event_hash, 'approval_event.event_hash');
  const details = event.details;
  if (!details || details.action !== 'approve'
    || details.candidate_id !== candidate.candidate_id
    || details.candidate_hash !== candidate.candidate_hash) {
    fail('approval event is not bound to the current candidate hash');
  }
  return {
    event_id: assertRedactionStableString(
      assertNonEmptyString(event.event_id, 'approval_event.event_id', 256),
      'approval_event.event_id'
    ),
    event_hash: event.event_hash,
  };
}

function createApprovalReceipt(candidate, input = {}) {
  assertExpectedHash(candidate, input.expected_candidate_hash);
  if (candidate.status !== 'shadow') fail(`invalid lifecycle transition ${candidate.status} -> approved`);
  if (!candidate.evaluation || !candidate.evaluation.eligibility.eligible) {
    fail('candidate is not promotion eligible');
  }
  const receiptPublisher = normalizeActor(input.publisher, 'publisher');
  if (receiptPublisher.kind !== 'user' || !receiptPublisher.authority_ref) {
    fail('publisher must be an auditable user authority');
  }
  const approvalEventRef = assertApprovalEvent(candidate, input.approval_event, receiptPublisher);
  const approvedAt = normalizeTimestamp(input.approved_at, 'approved_at');
  assertCandidateNotExpiredAt(candidate, approvedAt, 'approval');
  const receipt = {
    schema_version: APPROVAL_RECEIPT_SCHEMA_VERSION,
    receipt_id: '',
    candidate_id: candidate.candidate_id,
    candidate_hash: candidate.candidate_hash,
    evaluation_hash: candidate.evaluation.evaluation_hash,
    approval_event_ref: approvalEventRef,
    publisher: receiptPublisher,
    approved_at: approvedAt,
    authority_semantics: 'auditable-local-protocol',
  };
  receipt.receipt_id = `approval-${asSha256(receipt).slice(7, 39)}`;
  receipt.receipt_hash = receiptHash(receipt);
  return clone(receipt);
}

function assertReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') fail('approval receipt required');
  try {
    assertExactKeys(receipt, APPROVAL_RECEIPT_KEYS, 'approval receipt');
  } catch (error) {
    fail(`approval receipt exact shape is invalid: ${error.message}`);
  }
  if (receipt.schema_version !== APPROVAL_RECEIPT_SCHEMA_VERSION) {
    fail('unsupported approval receipt schema version');
  }
  if (typeof receipt.receipt_id !== 'string' || !RECEIPT_ID_RE.test(receipt.receipt_id)) {
    fail('approval receipt_id is invalid');
  }
  if (typeof receipt.candidate_id !== 'string' || !CANDIDATE_ID_RE.test(receipt.candidate_id)) {
    fail('approval receipt candidate_id is invalid');
  }
  assertDigest(receipt.candidate_hash, 'approval_receipt.candidate_hash');
  assertDigest(receipt.evaluation_hash, 'approval_receipt.evaluation_hash');
  try {
    assertExactKeys(receipt.approval_event_ref, APPROVAL_EVENT_REF_KEYS, 'approval_event_ref');
  } catch (error) {
    fail(`approval receipt approval_event_ref is invalid: ${error.message}`);
  }
  assertRedactionStableString(
    assertNonEmptyString(receipt.approval_event_ref.event_id, 'approval_event_ref.event_id', 256),
    'approval_event_ref.event_id'
  );
  assertDigest(receipt.approval_event_ref.event_hash, 'approval_event_ref.event_hash');
  const publisher = normalizeActor(receipt.publisher, 'approval receipt publisher');
  if (publisher.kind !== 'user' || publisher.authority_ref === null) {
    fail('approval receipt publisher must be an auditable user authority');
  }
  normalizeTimestamp(receipt.approved_at, 'approval receipt approved_at');
  if (receipt.authority_semantics !== 'auditable-local-protocol') {
    fail('approval receipt authority_semantics is invalid');
  }
  assertDigest(receipt.receipt_hash, 'approval_receipt.receipt_hash');
  const identityCore = clone(receipt);
  delete identityCore.receipt_hash;
  identityCore.receipt_id = '';
  const expectedReceiptId = `approval-${asSha256(identityCore).slice(7, 39)}`;
  if (receipt.receipt_id !== expectedReceiptId) fail('approval receipt_id content binding mismatch');
  const actual = receiptHash(receipt);
  if (actual !== receipt.receipt_hash) fail('approval receipt hash mismatch');
  return clone(receipt);
}

function transitionCandidateState(candidate, nextStatus, input = {}) {
  assertExpectedHash(candidate, input.expected_candidate_hash);
  if (!LIFECYCLE_TRANSITIONS[candidate.status]
      || !LIFECYCLE_TRANSITIONS[candidate.status].has(nextStatus)) {
    fail(`invalid lifecycle transition ${candidate.status} -> ${nextStatus}`);
  }
  if (TERMINAL_STATUSES.has(candidate.status)) {
    fail(`invalid lifecycle transition from terminal status ${candidate.status}`);
  }
  const actor = normalizeActor(input.actor, 'transition.actor');
  const occurredAt = normalizeTimestamp(input.occurred_at, 'occurred_at');
  if (FORWARD_ACTIONS.has(nextStatus)) {
    assertCandidateNotExpiredAt(candidate, occurredAt, nextStatus);
  }
  if (nextStatus === 'shadow'
      && (!candidate.evaluation
        || candidate.evaluation.decision !== 'pass'
        || !candidate.evaluation.eligibility.eligible)) {
    fail('candidate is needs-review and not promotion eligible');
  }
  let approval = candidate.approval;
  let publisherRef = candidate.authority.publisher_ref;
  if (nextStatus === 'approved') {
    const receipt = assertReceipt(input.approval_receipt);
    if (candidate.status !== 'shadow'
      || receipt.candidate_id !== candidate.candidate_id
      || receipt.candidate_hash !== candidate.candidate_hash
      || receipt.evaluation_hash !== candidate.evaluation.evaluation_hash) {
      fail('approval receipt is stale or belongs to another candidate');
    }
    if (actor.kind !== 'user'
        || actor.id !== receipt.publisher.id
        || actor.authority_ref !== receipt.publisher.authority_ref) {
      fail('approved transition actor authority must match receipt publisher');
    }
    approval = {
      receipt_id: receipt.receipt_id,
      receipt_hash: receipt.receipt_hash,
      candidate_hash: receipt.candidate_hash,
      approval_event_ref: receipt.approval_event_ref,
      approved_at: receipt.approved_at,
    };
    publisherRef = receipt.publisher.authority_ref;
  }
  return withCandidateHash({
    ...clone(candidate),
    status: nextStatus,
    revision: candidate.revision + 1,
    previous_candidate_hash: candidate.candidate_hash,
    approval,
    authority: {
      ...candidate.authority,
      publisher_ref: publisherRef,
    },
    governance_history: [
      ...candidate.governance_history,
      {
        action: nextStatus,
        actor,
        reason: input.reason == null ? null : redactCanonicalValue(String(input.reason)),
        occurred_at: occurredAt,
      },
    ],
    updated_at: occurredAt,
  });
}

function promoteCandidateState(candidate, input = {}) {
  assertExpectedHash(candidate, input.expected_candidate_hash);
  if (candidate.status !== 'approved') fail(`invalid lifecycle transition ${candidate.status} -> promoted`);
  if (!candidate.evaluation || !candidate.evaluation.eligibility.eligible) {
    fail('candidate is not promotion eligible');
  }
  const receipt = assertReceipt(input.approval_receipt);
  if (!candidate.approval
    || candidate.approval.receipt_hash !== receipt.receipt_hash
    || candidate.approval.candidate_hash !== receipt.candidate_hash) {
    fail('approval receipt does not match approved candidate state');
  }
  const promotionPublisher = normalizeActor(input.publisher, 'publisher');
  if (promotionPublisher.kind !== 'user'
    || promotionPublisher.id !== receipt.publisher.id
    || promotionPublisher.authority_ref !== receipt.publisher.authority_ref) {
    fail('publisher does not match approval receipt');
  }
  const promotedAt = normalizeTimestamp(input.promoted_at, 'promoted_at');
  assertCandidateNotExpiredAt(candidate, promotedAt, 'promotion');
  const transitioned = transitionCandidateState(candidate, 'promoted', {
    expected_candidate_hash: candidate.candidate_hash,
    actor: promotionPublisher,
    occurred_at: promotedAt,
    reason: 'manual approval receipt satisfied',
  });
  return withCandidateHash({
    ...transitioned,
    promotion: {
      approval_receipt_id: receipt.receipt_id,
      approval_receipt_hash: receipt.receipt_hash,
      publisher: promotionPublisher,
      promoted_at: promotedAt,
      runtime_written: false,
      semantics: 'eligible-for-reader-not-runtime-published',
    },
  });
}

function correctCandidateScope(candidate, input = {}) {
  assertExpectedHash(candidate, input.expected_candidate_hash);
  if (TERMINAL_STATUSES.has(candidate.status)) {
    fail(`cannot correct terminal candidate status ${candidate.status}`);
  }
  const newScope = normalizeScope(input.scope);
  if (newScope.level === 'project' && newScope.id !== candidate.project_id) {
    fail('project scope.id must match candidate project_id');
  }
  const actor = normalizeActor(input.actor, 'actor');
  if (actor.kind !== 'user') fail('scope correction requires a user actor');
  const occurredAt = normalizeTimestamp(input.occurred_at, 'occurred_at');
  return withCandidateHash({
    ...clone(candidate),
    scope: newScope,
    status: 'proposed',
    revision: candidate.revision + 1,
    previous_candidate_hash: candidate.candidate_hash,
    evaluation: null,
    approval: null,
    promotion: null,
    authority: {
      ...candidate.authority,
      evaluator_ref: null,
      publisher_ref: null,
    },
    governance_history: [
      ...candidate.governance_history,
      {
        action: 'scope-corrected',
        actor,
        reason: assertNonEmptyString(
          redactCanonicalValue(input.reason),
          'scope correction reason',
          2000
        ),
        occurred_at: occurredAt,
      },
    ],
    updated_at: occurredAt,
  });
}

function journalActor(actor, runtime = 'unknown') {
  const normalized = normalizeActor(actor, 'journal actor', {
    allow_runtime: Object.prototype.hasOwnProperty.call(actor || {}, 'runtime'),
  });
  if (normalized.kind === 'tool') fail('tool cannot act as candidate journal authority');
  return {
    kind: normalized.kind,
    id: normalized.id,
    runtime: typeof actor.runtime === 'string' && actor.runtime.trim()
      ? actor.runtime.trim()
      : runtime,
    authority_ref: normalized.authority_ref,
  };
}

function candidateRecordPayload(action, candidate) {
  assertCandidateIntegrity(candidate);
  return {
    schema_version: CANDIDATE_STATE_RECORD_SCHEMA_VERSION,
    action,
    candidate,
  };
}

function appendCandidateState(storeDir, candidate, action, actor, occurredAt, options = {}) {
  const recordType = action === 'proposed'
    ? 'learning_candidate'
    : action === 'evaluated'
      ? 'candidate_evaluation'
      : 'candidate_transition';
  return appendRecord(storeDir, {
    record_type: recordType,
    record_id: `candidate:${candidate.candidate_id}:r${candidate.revision}`,
    entity_id: candidate.candidate_id,
    actor: journalActor(actor, options.runtime),
    occurred_at: normalizeTimestamp(occurredAt, 'candidate record occurred_at'),
    payload: candidateRecordPayload(action, candidate),
  }, options.store_options || {});
}

function validateCandidateRecordPayload(record) {
  assertExactKeys(record.payload, ['schema_version', 'action', 'candidate'], 'candidate journal payload');
  if (record.payload.schema_version !== CANDIDATE_STATE_RECORD_SCHEMA_VERSION) {
    fail(`unsupported candidate state record schema in ${record.record_id}`);
  }
  const candidate = record.payload.candidate;
  assertCandidateIntegrity(candidate);
  if (candidate.candidate_id !== record.entity_id) {
    fail(`candidate record ${record.record_id} entity mismatch`);
  }
  return candidate;
}

function canonicalEqual(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function assertActorAuthority(actual, expected, label) {
  const normalizedExpected = normalizeActor(expected, label);
  if (actual.kind !== normalizedExpected.kind
      || actual.id !== normalizedExpected.id
      || actual.authority_ref !== normalizedExpected.authority_ref) {
    fail(`${label} does not match journal actor authority`);
  }
}

function tombstonedIdsFrom(journal) {
  return new Set(journal.records
    .filter((record) => record.record_type === 'tombstone')
    .map((record) => record.entity_id));
}

function latestEntityRecord(journal, recordType, entityId) {
  return journal.records
    .filter((record) => record.record_type === recordType && record.entity_id === entityId)
    .slice(-1)[0] || null;
}

function authoritativeExplicitUserSignal(event, record) {
  if (!['user.feedback', 'user.correction'].includes(event.event_type)
      || event.fact_status !== 'fact'
      || !isTrustedUserAuthorityEvent(event)) {
    return false;
  }
  const expectedActor = journalActorForEvent(event);
  return expectedActor.kind === 'user'
    && expectedActor.authority_ref !== null
    && canonicalEqual(record.actor, expectedActor);
}

function assessCandidateEvidenceJournal(journal, candidate) {
  const tombstonedIds = tombstonedIdsFrom(journal);
  const episodeAssessments = new Map(assessEpisodeJournal(journal, {
    project_id: candidate.project_id,
  }).episodes.map((item) => [item.record.entity_id, item]));
  const errors = [];
  const eligibilityReasons = [];
  const invalidatedEvidenceIds = [];
  const authoritativeEvidenceFacts = [];
  const evidenceRefs = [
    ...candidate.evidence_refs,
    ...candidate.counterexamples.map((item) => item.evidence_ref),
  ];
  for (const evidenceRef of evidenceRefs) {
    try {
      if (!canonicalEqual(normalizeEvidenceRef(evidenceRef), evidenceRef)) {
        errors.push(`evidence ${evidenceRef.evidence_id || '(unknown)'} is not canonical`);
        invalidatedEvidenceIds.push(evidenceRef.evidence_id || evidenceRef.source_ref || '(unknown)');
        continue;
      }
    } catch (error) {
      errors.push(`candidate evidence is invalid: ${error.message}`);
      invalidatedEvidenceIds.push(evidenceRef.evidence_id || evidenceRef.source_ref || '(unknown)');
      continue;
    }
    if (tombstonedIds.has(evidenceRef.evidence_id) || tombstonedIds.has(evidenceRef.source_ref)) {
      errors.push(`evidence ${evidenceRef.evidence_id} is tombstoned`);
      invalidatedEvidenceIds.push(
        tombstonedIds.has(evidenceRef.evidence_id) ? evidenceRef.evidence_id : evidenceRef.source_ref
      );
      continue;
    }
    const evidenceRecord = latestEntityRecord(journal, 'evidence_ref', evidenceRef.evidence_id);
    if (!evidenceRecord) {
      errors.push(`evidence ${evidenceRef.evidence_id} is missing from the authoritative journal`);
      invalidatedEvidenceIds.push(evidenceRef.evidence_id);
      continue;
    }
    if (!canonicalEqual(evidenceRecord.payload, evidenceRef)) {
      errors.push(`evidence ${evidenceRef.evidence_id} does not match the authoritative journal`);
      invalidatedEvidenceIds.push(evidenceRef.evidence_id);
      continue;
    }
    if (!['behavior_event', 'behavior_episode'].includes(evidenceRef.source_type)) continue;
    const sourceRecord = latestEntityRecord(journal, evidenceRef.source_type, evidenceRef.source_ref);
    if (!sourceRecord) {
      errors.push(`evidence source ${evidenceRef.source_ref} is missing from the authoritative journal`);
      invalidatedEvidenceIds.push(evidenceRef.evidence_id);
      continue;
    }
    if (sourceRecord.payload_hash !== evidenceRef.digest) {
      errors.push(`evidence source ${evidenceRef.source_ref} digest mismatch with latest source revision`);
      invalidatedEvidenceIds.push(evidenceRef.evidence_id);
      continue;
    }
    if (evidenceRef.source_type === 'behavior_event') {
      try {
        const event = normalizeBehaviorEvent(sourceRecord.payload);
        if (sourceRecord.record_id !== event.event_id
            || sourceRecord.entity_id !== event.event_id
            || sourceRecord.payload_hash !== evidenceRef.digest
            || event.project_id !== candidate.project_id
            || !canonicalEqual(sourceRecord.actor, journalActorForEvent(event))) {
          errors.push(`evidence source ${evidenceRef.source_ref} Event identity/project/actor mismatch`);
          invalidatedEvidenceIds.push(evidenceRef.evidence_id);
        }
      } catch (error) {
        errors.push(`evidence source ${evidenceRef.source_ref} is not a valid BehaviorEvent`);
        invalidatedEvidenceIds.push(evidenceRef.evidence_id);
      }
      continue;
    }
    if (evidenceRef.source_type !== 'behavior_episode') continue;

    const episodeAssessment = episodeAssessments.get(evidenceRef.source_ref);
    if (!episodeAssessment
        || !episodeAssessment.episode
        || episodeAssessment.record.record_hash !== sourceRecord.record_hash) {
      errors.push(`evidence source ${evidenceRef.source_ref} is not an active authoritative BehaviorEpisode`);
      invalidatedEvidenceIds.push(evidenceRef.evidence_id);
      continue;
    }
    const { episode } = episodeAssessment;
    if (episodeAssessment.errors.length > 0) {
      errors.push(...episodeAssessment.errors);
      invalidatedEvidenceIds.push(evidenceRef.evidence_id);
    }
    const authoritativeEvents = episodeAssessment.authoritative_events;
    const eventSetValid = episodeAssessment.errors.length === 0;
    const explicitSignals = authoritativeEvents.filter(({ event, record }) =>
      authoritativeExplicitUserSignal(event, record));
    const corrections = explicitSignals.filter(({ event }) =>
      event.event_type === 'user.correction');
    const correctionEventIds = new Set(corrections.map(({ event }) => event.event_id));
    const adverseEvents = episode.event_refs.filter((ref) =>
      ref.counterexample && !correctionEventIds.has(ref.event_id));
    const ordinaryQualifying = episode.completeness === 'complete'
      && episode.verification_status === 'verified'
      && episode.final_disposition === 'accepted'
      && episode.status === 'closed'
      && corrections.length === 0
      && adverseEvents.length === 0;
    const hasTaskFlow = episode.task_ref !== null
      && episode.goals.length > 0
      && episode.actions.length > 0
      && episode.results.some((ref) => ref.event_type === 'task.result');
    const correctionQualifying = corrections.length > 0
      && episode.verification_status === 'verified'
      && hasTaskFlow
      && adverseEvents.length === 0;
    authoritativeEvidenceFacts.push({
      evidence_id: evidenceRef.evidence_id,
      episode_id: episode.episode_id,
      ordinary_qualifying: eventSetValid && ordinaryQualifying,
      correction_qualifying: eventSetValid && correctionQualifying,
      has_correction: corrections.length > 0,
      explicit_user_signal: eventSetValid && explicitSignals.length > 0,
    });
    if (episode.verification_status !== 'verified') {
      eligibilityReasons.push(`unverified-episode:${episode.episode_id}`);
    }
    if (adverseEvents.length > 0) {
      eligibilityReasons.push(`episode-counterexamples:${episode.episode_id}`);
    }
    if (corrections.length > 0 && !hasTaskFlow) {
      eligibilityReasons.push(`incomplete-correction-episode:${episode.episode_id}`);
    }
    if (corrections.length === 0) {
      if (episode.completeness !== 'complete') {
        eligibilityReasons.push(`incomplete-episode:${episode.episode_id}`);
      }
      if (episode.final_disposition !== 'accepted' || episode.status !== 'closed') {
        eligibilityReasons.push(`unknown-or-unaccepted-episode:${episode.episode_id}`);
      }
    }
  }
  if (candidate.evaluation) {
    const relations = new Map(candidate.evaluation.evidence_relations
      .map((item) => [item.evidence_ref_id, item]));
    for (const fact of authoritativeEvidenceFacts.filter((item) => item.has_correction)) {
      const relation = relations.get(fact.evidence_id);
      if (!relation) {
        eligibilityReasons.push(`unresolved-correction-relation:${fact.episode_id}`);
      } else if (relation.relation === 'refutes') {
        eligibilityReasons.push(`correction-refutes-candidate:${fact.episode_id}`);
      }
    }
  }
  return {
    errors: [...new Set(errors)],
    eligibility_reasons: [...new Set(eligibilityReasons)].sort(),
    invalidated_evidence_ids: [...new Set(invalidatedEvidenceIds)].sort(),
    authoritative_evidence_facts: authoritativeEvidenceFacts
      .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
  };
}

function verifyCandidateEvidenceJournal(journal, candidate) {
  const assessment = assessCandidateEvidenceJournal(journal, candidate);
  if (assessment.errors.length > 0) fail(assessment.errors[0]);
  return assessment;
}

function requireForwardAuthority(journal, candidate, action) {
  const assessment = verifyCandidateEvidenceJournal(journal, candidate);
  if (action !== 'evaluated' && assessment.eligibility_reasons.length > 0) {
    fail(`candidate effective needs-review: ${assessment.eligibility_reasons.join(', ')}`);
  }
  if (candidate.status === 'needs-review'
      || (candidate.evaluation && candidate.evaluation.decision === 'needs-review')) {
    fail('candidate effective needs-review prohibits forward lifecycle progress');
  }
  return assessment;
}

function mergeEvidenceRefs(existingRefs, incomingRefs) {
  const bySource = new Map(existingRefs.map((ref) => [`${ref.source_type}\u0000${ref.source_ref}`, ref]));
  incomingRefs.forEach((ref) => bySource.set(`${ref.source_type}\u0000${ref.source_ref}`, ref));
  return [...bySource.values()].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}

function mergeCounterexamples(existingItems, incomingItems) {
  const bySource = new Map(existingItems.map((item) => [
    `${item.evidence_ref.source_type}\u0000${item.evidence_ref.source_ref}`,
    item,
  ]));
  const dispositionRank = { resolved: 0, unresolved: 1, 'supports-rejection': 2 };
  incomingItems.forEach((item) => {
    const key = `${item.evidence_ref.source_type}\u0000${item.evidence_ref.source_ref}`;
    const existing = bySource.get(key);
    if (existing && dispositionRank[item.disposition] < dispositionRank[existing.disposition]) {
      fail(`counterexample disposition cannot loosen ${existing.disposition} -> ${item.disposition}`);
    }
    bySource.set(key, item);
  });
  return [...bySource.values()].sort((left, right) =>
    left.evidence_ref.evidence_id.localeCompare(right.evidence_ref.evidence_id)
  );
}

function mergeStricterPolicy(previous, incoming) {
  return {
    minimum_distinct_episodes: Math.max(
      previous.minimum_distinct_episodes,
      incoming.minimum_distinct_episodes
    ),
    minimum_truth_score: Math.max(previous.minimum_truth_score, incoming.minimum_truth_score),
    minimum_value_score: Math.max(previous.minimum_value_score, incoming.minimum_value_score),
  };
}

function mergeTighterExpiry(previousExpiry, incomingExpiry) {
  if (previousExpiry === null) return incomingExpiry;
  if (incomingExpiry === null) return previousExpiry;
  return Date.parse(previousExpiry) <= Date.parse(incomingExpiry)
    ? previousExpiry
    : incomingExpiry;
}

function buildEvidenceEnrichedRevision(previous, incoming, occurredAt) {
  if (TERMINAL_STATUSES.has(previous.status) || previous.status === 'promoted') {
    fail(`cannot enrich terminal candidate status ${previous.status}`);
  }
  if (!canonicalEqual(previous.proposer, incoming.proposer)) {
    fail('semantic proposal proposer identity/authority mismatch');
  }
  if (!canonicalEqual(previous.owner, incoming.owner)) {
    fail('semantic proposal owner identity/authority mismatch');
  }
  const evidenceRefs = mergeEvidenceRefs(previous.evidence_refs, incoming.evidence_refs);
  const counterexamples = mergeCounterexamples(previous.counterexamples, incoming.counterexamples);
  const previousEvidence = [...previous.evidence_refs]
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
  const previousCounterexamples = [...previous.counterexamples]
    .sort((left, right) => left.evidence_ref.evidence_id.localeCompare(right.evidence_ref.evidence_id));
  const policy = mergeStricterPolicy(previous.policy, incoming.policy);
  const expiresAt = mergeTighterExpiry(
    previous.retention.expires_at,
    incoming.retention.expires_at
  );
  const changed = !canonicalEqual(evidenceRefs, previousEvidence)
    || !canonicalEqual(counterexamples, previousCounterexamples)
    || !canonicalEqual(policy, previous.policy)
    || expiresAt !== previous.retention.expires_at;
  if (!changed) return null;
  const updatedAt = normalizeTimestamp(occurredAt, 'evidence enrichment occurred_at');
  return withCandidateHash({
    ...clone(previous),
    evidence_refs: evidenceRefs,
    counterexamples,
    confidence: normalizeConfidence(null, evidenceRefs),
    policy,
    status: 'proposed',
    revision: previous.revision + 1,
    previous_candidate_hash: previous.candidate_hash,
    evaluation: null,
    approval: null,
    promotion: null,
    retention: {
      ...previous.retention,
      expires_at: expiresAt,
    },
    authority: {
      ...previous.authority,
      evaluator_ref: null,
      publisher_ref: null,
    },
    updated_at: updatedAt,
  });
}

function candidateFromInitialState(candidate) {
  return createLearningCandidate({
    project_id: candidate.project_id,
    kind: candidate.kind,
    statement: candidate.statement,
    target: candidate.target,
    scope: candidate.scope,
    proposer: candidate.proposer,
    owner: candidate.owner,
    evidence_refs: candidate.evidence_refs,
    counterexamples: candidate.counterexamples,
    confidence: candidate.confidence,
    policy: candidate.policy,
    occurred_at: candidate.created_at,
    expires_at: candidate.retention.expires_at,
    collector_ref: candidate.authority.collector_ref,
  });
}

function resolveApprovalEventFromJournal(journal, eventRef, publisher, candidate) {
  if (!eventRef || typeof eventRef !== 'object' || !eventRef.event_id) {
    fail('explicit user approval event required');
  }
  const tombstonedIds = tombstonedIdsFrom(journal);
  if (tombstonedIds.has(eventRef.event_id)) fail('approval event is tombstoned');
  const record = latestEntityRecord(journal, 'behavior_event', eventRef.event_id);
  if (!record) fail('approval event must exist in the authoritative journal');
  let event;
  try {
    event = normalizeBehaviorEvent(record.payload);
  } catch (error) {
    fail(`approval event is not a valid BehaviorEvent: ${error.message}`);
  }
  if (record.record_id !== event.event_id
      || record.entity_id !== event.event_id
      || record.actor.kind !== 'user'
      || record.actor.id !== event.actor.id
      || !canonicalEqual(record.actor, journalActorForEvent(event))) {
    fail('approval event journal identity/actor mismatch');
  }
  if (!isTrustedUserAuthorityEvent(event, 'approval')
      || event.final_disposition !== 'accepted') {
    fail('approval event must be a trusted native codex_cli user approval and accepted');
  }
  const normalizedPublisher = normalizeActor(publisher, 'publisher');
  if (!record.actor.authority_ref
      || record.actor.authority_ref !== normalizedPublisher.authority_ref) {
    fail('publisher authority does not match approval event journal authority');
  }
  if (eventRef.event_hash && eventRef.event_hash !== record.payload_hash) {
    fail('approval event hash mismatch with authoritative journal');
  }
  const authoritativeEvent = {
    ...clone(event),
    actor: {
      kind: event.actor.kind,
      id: event.actor.id,
      authority_ref: record.actor.authority_ref,
    },
    event_hash: record.payload_hash,
  };
  assertApprovalEvent(candidate, authoritativeEvent, normalizedPublisher);
  return authoritativeEvent;
}

function assertReceiptAuthority(journal, receipt, candidate) {
  assertReceipt(receipt);
  if (tombstonedIdsFrom(journal).has(receipt.receipt_id)) {
    fail('approval receipt is tombstoned');
  }
  if (receipt.candidate_id !== candidate.candidate_id) {
    fail('approval receipt candidate identity mismatch');
  }
  const approvalSubject = {
    candidate_id: candidate.candidate_id,
    candidate_hash: receipt.candidate_hash,
    project_id: candidate.project_id,
  };
  resolveApprovalEventFromJournal(
    journal,
    receipt.approval_event_ref,
    receipt.publisher,
    approvalSubject
  );
  return receipt;
}

function publicBoundReceipts(candidates, receipts, tombstoned = new Map()) {
  const bound = new Set();
  candidates.forEach((candidate) => {
    if (candidate.approval) bound.add(candidate.approval.receipt_id);
    if (candidate.promotion) bound.add(candidate.promotion.approval_receipt_id);
  });
  return [...receipts.values()]
    .filter((receipt) => bound.has(receipt.receipt_id) && !tombstoned.has(receipt.receipt_id))
    .sort((left, right) => left.receipt_id.localeCompare(right.receipt_id));
}

function buildCandidateProjection(journal) {
  if (!journal || !Array.isArray(journal.records)) fail('journal view is invalid');
  const current = new Map();
  const records = new Map();
  const receipts = new Map();
  const tombstoned = new Map();
  for (let index = 0; index < journal.records.length; index += 1) {
    const record = journal.records[index];
    const priorJournal = {
      schema_version: journal.schema_version,
      revision: index,
      head_hash: index === 0 ? null : journal.records[index - 1].record_hash,
      records: journal.records.slice(0, index),
    };
    if (record.record_type === 'approval_receipt') {
      assertExactKeys(record.payload, ['schema_version', 'receipt'], 'approval receipt journal payload');
      if (record.payload.schema_version !== APPROVAL_RECORD_SCHEMA_VERSION) {
        fail(`unsupported approval record schema in ${record.record_id}`);
      }
      const receipt = assertReceipt(record.payload.receipt);
      if (receipt.receipt_id !== record.entity_id
          || record.record_id !== `receipt:${receipt.receipt_id}`) {
        fail('approval receipt entity mismatch');
      }
      assertActorAuthority(record.actor, receipt.publisher, 'approval receipt publisher');
      const candidate = current.get(receipt.candidate_id);
      if (!candidate
          || candidate.status !== 'shadow'
          || candidate.candidate_hash !== receipt.candidate_hash
          || !candidate.evaluation
          || candidate.evaluation.evaluation_hash !== receipt.evaluation_hash) {
        fail('approval receipt is not bound to the current shadow candidate');
      }
      assertReceiptAuthority(priorJournal, receipt, candidate);
      receipts.set(receipt.receipt_id, receipt);
      continue;
    }
    if (record.record_type === 'tombstone') {
      tombstoned.set(record.entity_id, {
        entity_id: record.entity_id,
        target_hash: record.payload.target_hash,
        reason: record.payload.reason,
        replacement_id: record.payload.replacement_id,
        record_hash: record.record_hash,
      });
      continue;
    }
    if (!['learning_candidate', 'candidate_evaluation', 'candidate_transition'].includes(record.record_type)) {
      continue;
    }
    const candidate = validateCandidateRecordPayload(record);
    const previous = current.get(candidate.candidate_id);
    const action = record.payload.action;
    let expected;
    let expectedActor;
    if (!previous) {
      if (record.record_type !== 'learning_candidate'
        || action !== 'proposed'
        || candidate.revision !== 1
        || candidate.previous_candidate_hash !== null
        || candidate.status !== 'proposed') {
        fail(`candidate ${candidate.candidate_id} does not start with a valid proposal`);
      }
      verifyCandidateEvidenceJournal(priorJournal, candidate);
      expected = candidateFromInitialState(candidate);
      expectedActor = candidate.proposer;
    } else {
      if (candidate.revision !== previous.revision + 1
        || candidate.previous_candidate_hash !== previous.candidate_hash) {
        fail(`candidate ${candidate.candidate_id} revision/hash chain is corrupt`);
      }
      if (action === 'proposed') {
        if (record.record_type !== 'learning_candidate' || candidate.status !== 'proposed') {
          fail(`candidate evidence enrichment record ${record.record_id} is invalid`);
        }
        expected = buildEvidenceEnrichedRevision(previous, candidate, record.occurred_at);
        if (!expected) fail('candidate evidence enrichment revision is a semantic no-op');
        verifyCandidateEvidenceJournal(priorJournal, expected);
        expectedActor = previous.proposer;
      } else if (action === 'evaluated') {
        if (record.record_type !== 'candidate_evaluation' || candidate.status !== 'evaluated') {
          fail(`candidate evaluation record ${record.record_id} has non-evaluated state`);
        }
        const authority = requireForwardAuthority(priorJournal, previous, action);
        const evaluation = candidate.evaluation;
        if (!evaluation) fail('candidate evaluation record is missing evaluation');
        expected = evaluateCandidateState(previous, {
          expected_candidate_hash: previous.candidate_hash,
          rubric_version: evaluation.rubric_version,
          truth_score: evaluation.truth_score,
          value_score: evaluation.value_score,
          assessor: evaluation.assessor,
          evidence_ref_ids: evaluation.evidence_ref_ids,
          evidence_relations: evaluation.evidence_relations,
          baseline_hash: evaluation.baseline_hash,
          subject_artifact_hash: evaluation.subject_artifact_hash,
          _evaluation_replay_summary: {
            case_set_hash: evaluation.case_set_hash,
            case_results_hash: evaluation.case_results_hash,
            case_count: evaluation.case_count,
            passed_count: evaluation.passed_count,
            pass_rate: evaluation.pass_rate,
          },
          _evaluation_replay_token: EVALUATION_REPLAY_TOKEN,
          seed: evaluation.seed,
          counterexamples_reviewed: evaluation.counterexamples_reviewed,
          assessed_at: evaluation.assessed_at,
          _authoritative_eligibility_reasons: authority.eligibility_reasons,
          _authoritative_evidence_facts: authority.authoritative_evidence_facts,
          _authoritative_evidence_token: AUTHORITATIVE_EVIDENCE_TOKEN,
        });
        expectedActor = evaluation.assessor;
      } else if (action === 'scope-corrected') {
        if (record.record_type !== 'candidate_transition' || candidate.status !== 'proposed') {
          fail(`candidate scope correction record ${record.record_id} is invalid`);
        }
        const entry = candidate.governance_history[candidate.governance_history.length - 1];
        if (!entry || entry.action !== 'scope-corrected') fail('scope correction audit entry missing');
        expected = correctCandidateScope(previous, {
          expected_candidate_hash: previous.candidate_hash,
          scope: candidate.scope,
          actor: entry.actor,
          reason: entry.reason,
          occurred_at: entry.occurred_at,
        });
        expectedActor = entry.actor;
      } else {
        if (record.record_type !== 'candidate_transition' || action !== candidate.status) {
          fail(`candidate transition ${record.record_id} action/status/type mismatch`);
        }
        if (FORWARD_ACTIONS.has(action)) requireForwardAuthority(priorJournal, previous, action);
        const entry = candidate.governance_history[candidate.governance_history.length - 1];
        if (!entry || entry.action !== action) fail(`candidate ${action} audit entry missing`);
        if (action === 'approved') {
          if (!candidate.approval) fail('approved candidate is missing approval binding');
          const receipt = receipts.get(candidate.approval.receipt_id);
          if (!receipt) fail('approved candidate references an unavailable approval receipt');
          assertReceiptAuthority(priorJournal, receipt, previous);
          expected = transitionCandidateState(previous, 'approved', {
            expected_candidate_hash: previous.candidate_hash,
            actor: entry.actor,
            approval_receipt: receipt,
            occurred_at: entry.occurred_at,
            reason: entry.reason,
          });
        } else if (action === 'promoted') {
          if (!candidate.promotion) fail('promoted candidate is missing promotion binding');
          const receipt = receipts.get(candidate.promotion.approval_receipt_id);
          if (!receipt) fail('promoted candidate references an unavailable approval receipt');
          assertReceiptAuthority(priorJournal, receipt, previous);
          expected = promoteCandidateState(previous, {
            expected_candidate_hash: previous.candidate_hash,
            approval_receipt: receipt,
            publisher: candidate.promotion.publisher,
            promoted_at: candidate.promotion.promoted_at,
          });
        } else {
          expected = transitionCandidateState(previous, action, {
            expected_candidate_hash: previous.candidate_hash,
            actor: entry.actor,
            occurred_at: entry.occurred_at,
            reason: entry.reason,
          });
        }
        expectedActor = entry.actor;
      }
    }
    if (!canonicalEqual(candidate, expected)) {
      fail(`candidate ${candidate.candidate_id} ${action} replay invariant mismatch`);
    }
    assertActorAuthority(record.actor, expectedActor, `candidate ${action} actor`);
    current.set(candidate.candidate_id, candidate);
    records.set(candidate.candidate_id, record);
  }

  const candidates = [];
  for (const candidate of [...current.values()].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id))) {
    if (tombstoned.has(candidate.candidate_id)) continue;
    const assessment = assessCandidateEvidenceJournal(journal, candidate);
    let approvalCredentialInvalid = false;
    if (candidate.approval) {
      const receipt = receipts.get(candidate.approval.receipt_id);
      try {
        if (!receipt
            || receipt.receipt_hash !== candidate.approval.receipt_hash
            || receipt.candidate_hash !== candidate.approval.candidate_hash) {
          fail('candidate approval binding does not match an authoritative receipt');
        }
        assertReceiptAuthority(journal, receipt, candidate);
      } catch (_) {
        approvalCredentialInvalid = true;
      }
    }
    const effectiveNeedsReview = candidate.status === 'needs-review'
      || (candidate.evaluation && candidate.evaluation.decision === 'needs-review')
      || assessment.errors.length > 0
      || (candidate.status !== 'proposed' && assessment.eligibility_reasons.length > 0)
      || approvalCredentialInvalid;
    candidates.push({
      ...clone(candidate),
      effective_status: effectiveNeedsReview ? 'needs-review' : candidate.status,
      invalidated_evidence_ids: assessment.invalidated_evidence_ids,
    });
  }
  const promoted = candidates.filter((item) => item.effective_status === 'promoted');
  const shadow = candidates.filter((item) => item.effective_status === 'shadow');
  return {
    schema_version: 'self-learning-candidate-projection-v1',
    journal_revision: journal.revision,
    journal_head_hash: journal.head_hash,
    candidates,
    tombstoned: [...tombstoned.values()].sort((a, b) => a.entity_id.localeCompare(b.entity_id)),
    receipts: publicBoundReceipts(candidates, receipts, tombstoned),
    context: {
      promoted,
      shadow,
    },
    _candidate_records: records,
    _receipt_records: receipts,
  };
}

function inspectCandidateStore(storeDir, options = {}) {
  const projection = buildCandidateProjection(readJournal(storeDir));
  if (options.internal === true) return projection;
  const {
    _candidate_records: ignored,
    _receipt_records: ignoredReceipts,
    ...publicProjection
  } = projection;
  return publicProjection;
}

function getCandidate(storeDir, candidateId) {
  const projection = inspectCandidateStore(storeDir, { internal: true });
  const projected = projection.candidates.find((item) => item.candidate_id === candidateId);
  if (!projected) fail(`candidate not found or inactive: ${candidateId}`);
  const { effective_status: effectiveStatus, invalidated_evidence_ids: ignoredEvidence, ...candidate } = projected;
  return { candidate, effective_status: effectiveStatus, projection };
}

function storeOptionsAt(journal, supplied = {}) {
  const options = supplied && typeof supplied === 'object' ? supplied : {};
  return {
    ...options,
    expected_revision: Object.prototype.hasOwnProperty.call(options, 'expected_revision')
      ? options.expected_revision
      : journal.revision,
    expected_head_hash: Object.prototype.hasOwnProperty.call(options, 'expected_head_hash')
      ? options.expected_head_hash
      : journal.head_hash,
  };
}

function appendOptionsAt(journal, options = {}) {
  return {
    ...options,
    store_options: storeOptionsAt(journal, options.store_options),
  };
}

function proposeCandidate(storeDir, input = {}, options = {}) {
  const incoming = createLearningCandidate(input);
  const journal = readJournal(storeDir);
  verifyCandidateEvidenceJournal(journal, incoming);
  const existingProjection = buildCandidateProjection(journal);
  const existing = existingProjection.candidates.find((item) => item.candidate_id === incoming.candidate_id);
  if (existing) {
    const { effective_status: ignored, invalidated_evidence_ids: ignoredEvidence, ...canonical } = existing;
    const enriched = buildEvidenceEnrichedRevision(canonical, incoming, incoming.created_at);
    if (!enriched) {
      return {
        changed: false,
        candidate: canonical,
        record: existingProjection._candidate_records.get(incoming.candidate_id),
      };
    }
    verifyCandidateEvidenceJournal(journal, enriched);
    const enrichedResult = appendCandidateState(
      storeDir,
      enriched,
      'proposed',
      canonical.proposer,
      enriched.updated_at,
      appendOptionsAt(journal, options)
    );
    return { ...enrichedResult, candidate: enriched };
  }
  const result = appendCandidateState(
    storeDir,
    incoming,
    'proposed',
    incoming.proposer,
    incoming.created_at,
    appendOptionsAt(journal, options)
  );
  return { ...result, candidate: incoming };
}

function evaluateCandidate(storeDir, candidateId, input = {}, options = {}) {
  const { candidate, projection } = getCandidate(storeDir, candidateId);
  const journal = readJournal(storeDir);
  if (journal.revision !== projection.journal_revision
      || journal.head_hash !== projection.journal_head_hash) {
    fail('candidate journal changed while preparing evaluation');
  }
  let authorityStoreOptions;
  try {
    authorityStoreOptions = evaluationAuthorityAppendOptions(
      input.evaluation_artifact_authority,
      storeDir,
      candidate.project_id
    );
  } catch (error) {
    fail(`evaluation artifact authority journal binding is invalid: ${error.message}`);
  }
  if (journal.revision !== authorityStoreOptions.expected_revision
      || journal.head_hash !== authorityStoreOptions.expected_head_hash) {
    fail('evaluation artifact authority canonical journal changed before candidate append');
  }
  const authority = requireForwardAuthority(journal, candidate, 'evaluated');
  const evaluated = evaluateCandidateState(candidate, {
    ...input,
    _authoritative_eligibility_reasons: authority.eligibility_reasons,
    _authoritative_evidence_facts: authority.authoritative_evidence_facts,
    _authoritative_evidence_token: AUTHORITATIVE_EVIDENCE_TOKEN,
  });
  const result = appendCandidateState(
    storeDir,
    evaluated,
    'evaluated',
    input.assessor,
    evaluated.updated_at,
    appendOptionsAt(journal, {
      ...options,
      store_options: {
        ...(options.store_options && typeof options.store_options === 'object'
          ? options.store_options
          : {}),
        ...authorityStoreOptions,
      },
    })
  );
  return { ...result, candidate: evaluated };
}

function transitionCandidate(storeDir, candidateId, nextStatus, input = {}, options = {}) {
  const { candidate, effective_status: effectiveStatus, projection } = getCandidate(storeDir, candidateId);
  const journal = readJournal(storeDir);
  if (journal.revision !== projection.journal_revision
      || journal.head_hash !== projection.journal_head_hash) {
    fail('candidate journal changed while preparing transition');
  }
  if (FORWARD_ACTIONS.has(nextStatus)) {
    if (effectiveStatus === 'needs-review') {
      fail('candidate effective needs-review prohibits forward lifecycle progress');
    }
    requireForwardAuthority(journal, candidate, nextStatus);
  }
  const transitioned = transitionCandidateState(candidate, nextStatus, input);
  const result = appendCandidateState(
    storeDir,
    transitioned,
    nextStatus,
    input.actor,
    transitioned.updated_at,
    appendOptionsAt(journal, options)
  );
  return { ...result, candidate: transitioned };
}

function appendApprovalReceipt(storeDir, receipt, options = {}) {
  assertReceipt(receipt);
  return appendRecord(storeDir, {
    record_type: 'approval_receipt',
    record_id: `receipt:${receipt.receipt_id}`,
    entity_id: receipt.receipt_id,
    actor: journalActor(receipt.publisher, options.runtime),
    occurred_at: receipt.approved_at,
    payload: {
      schema_version: APPROVAL_RECORD_SCHEMA_VERSION,
      receipt,
    },
  }, options.store_options || {});
}

function resolveStoredApprovalEvent(storeDir, input) {
  const journal = readJournal(storeDir);
  return resolveApprovalEventFromJournal(journal, input.event_ref, input.publisher, input.candidate);
}

function approveCandidate(storeDir, candidateId, input = {}, options = {}) {
  const { candidate, effective_status: effectiveStatus, projection } = getCandidate(storeDir, candidateId);
  const initialJournal = readJournal(storeDir);
  if (initialJournal.revision !== projection.journal_revision
      || initialJournal.head_hash !== projection.journal_head_hash) {
    fail('candidate journal changed while preparing approval');
  }
  if (candidate.status === 'approved'
      && candidate.approval
      && candidate.approval.candidate_hash === input.expected_candidate_hash) {
    const existingReceipt = projection._receipt_records.get(candidate.approval.receipt_id);
    if (!existingReceipt) fail('approved candidate receipt is missing');
    const retryPublisher = normalizeActor(input.publisher, 'publisher');
    if (!canonicalEqual(retryPublisher, existingReceipt.publisher)
        || !input.approval_event
        || input.approval_event.event_id !== existingReceipt.approval_event_ref.event_id
        || (input.approval_event.event_hash
          && input.approval_event.event_hash !== existingReceipt.approval_event_ref.event_hash)
        || normalizeTimestamp(input.approved_at, 'approved_at') !== existingReceipt.approved_at) {
      fail('approval retry does not match the authoritative bound receipt');
    }
    assertReceiptAuthority(initialJournal, existingReceipt, candidate);
    return {
      changed: false,
      candidate,
      receipt: existingReceipt,
      record: projection._candidate_records.get(candidateId),
      journal: initialJournal,
    };
  }
  if (effectiveStatus === 'needs-review') {
    fail('candidate effective needs-review prohibits approval');
  }
  requireForwardAuthority(initialJournal, candidate, 'approved');
  const storedApprovalEvent = resolveStoredApprovalEvent(storeDir, {
    event_ref: input.approval_event,
    publisher: input.publisher,
    candidate,
  });
  const receipt = createApprovalReceipt(candidate, {
    ...input,
    approval_event: storedApprovalEvent,
  });
  const receiptResult = appendApprovalReceipt(
    storeDir,
    receipt,
    appendOptionsAt(initialJournal, options)
  );
  const afterReceiptJournal = receiptResult.journal;
  const afterReceipt = getCandidate(storeDir, candidateId);
  if (afterReceipt.candidate.candidate_hash !== candidate.candidate_hash
      || afterReceipt.effective_status === 'needs-review') {
    fail('candidate changed or became needs-review while binding approval receipt');
  }
  assertReceiptAuthority(afterReceiptJournal, receipt, afterReceipt.candidate);
  requireForwardAuthority(afterReceiptJournal, afterReceipt.candidate, 'approved');
  const approved = transitionCandidateState(candidate, 'approved', {
    expected_candidate_hash: candidate.candidate_hash,
    actor: input.publisher,
    approval_receipt: receipt,
    occurred_at: receipt.approved_at,
    reason: 'explicit user approval event',
  });
  const result = appendCandidateState(
    storeDir,
    approved,
    'approved',
    input.publisher,
    approved.updated_at,
    appendOptionsAt(afterReceiptJournal, { ...options, store_options: {} })
  );
  return { ...result, candidate: approved, receipt };
}

function promoteCandidate(storeDir, candidateId, input = {}, options = {}) {
  const { candidate, effective_status: effectiveStatus, projection } = getCandidate(storeDir, candidateId);
  const journal = readJournal(storeDir);
  if (journal.revision !== projection.journal_revision
      || journal.head_hash !== projection.journal_head_hash) {
    fail('candidate journal changed while preparing promotion');
  }
  if (effectiveStatus === 'needs-review') {
    fail('candidate effective needs-review prohibits promotion');
  }
  requireForwardAuthority(journal, candidate, 'promoted');
  const storedReceipt = candidate.approval
    ? projection._receipt_records.get(candidate.approval.receipt_id)
    : null;
  if (!storedReceipt || !canonicalEqual(storedReceipt, input.approval_receipt)) {
    fail('promotion requires the authoritative stored approval receipt');
  }
  assertReceiptAuthority(journal, storedReceipt, candidate);
  const promoted = promoteCandidateState(candidate, input);
  const result = appendCandidateState(
    storeDir,
    promoted,
    'promoted',
    input.publisher,
    promoted.updated_at,
    appendOptionsAt(journal, options)
  );
  return { ...result, candidate: promoted };
}

function governCandidate(storeDir, candidateId, input = {}, options = {}) {
  const { candidate, projection } = getCandidate(storeDir, candidateId);
  assertExpectedHash(candidate, input.expected_candidate_hash);
  if (input.action === 'tombstone') {
    if (!input.actor || input.actor.kind !== 'user') fail('tombstone requires a user actor');
    const record = projection._candidate_records.get(candidateId);
    const result = tombstoneEntity(storeDir, {
      record_id: `tombstone:${candidateId}:r${candidate.revision}`,
      target_id: candidateId,
      target_hash: record.record_hash,
      actor: journalActor(input.actor, options.runtime),
      occurred_at: normalizeTimestamp(input.occurred_at, 'tombstone occurred_at'),
      reason: assertNonEmptyString(redactCanonicalValue(input.reason), 'tombstone reason', 1000),
    }, options.store_options || {});
    return { ...result, candidate_id: candidateId };
  }
  if (input.action === 'scope-correct') {
    const corrected = correctCandidateScope(candidate, input);
    const result = appendCandidateState(
      storeDir,
      corrected,
      'scope-corrected',
      input.actor,
      corrected.updated_at,
      options
    );
    return { ...result, candidate: corrected };
  }
  const statusByAction = {
    reject: 'rejected',
    expire: 'expired',
    'needs-review': 'needs-review',
  };
  const nextStatus = statusByAction[input.action];
  if (!nextStatus) fail(`unsupported governance action "${input.action}"`);
  return transitionCandidate(storeDir, candidateId, nextStatus, {
    expected_candidate_hash: candidate.candidate_hash,
    actor: input.actor,
    occurred_at: input.occurred_at,
    reason: input.reason,
  }, options);
}

module.exports = {
  APPROVAL_RECEIPT_SCHEMA_VERSION,
  CANDIDATE_EVALUATION_SCHEMA_VERSION,
  CANDIDATE_KINDS,
  CANDIDATE_SCHEMA_VERSION,
  DEFAULT_POLICY,
  FACT_STATUSES,
  TV_RUBRIC_VERSION,
  assertApprovalReceiptIntegrity: assertReceipt,
  assertCandidateIntegrity,
  assertCandidateNotExpiredAt,
  candidateHash,
  candidateExpiryTimestamp,
  createApprovalReceipt,
  createLearningCandidate,
  correctCandidateScope,
  approveCandidate,
  buildCandidateProjection,
  evaluateCandidateState,
  evaluateCandidate,
  governCandidate,
  inspectCandidateStore,
  promoteCandidate,
  promoteCandidateState,
  proposeCandidate,
  transitionCandidate,
  transitionCandidateState,
};
