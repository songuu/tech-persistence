'use strict';

const fs = require('fs');
const path = require('path');

const { resolveBaseDir } = require('./runtime-paths');
const { detectStableProjectIdentity } = require('./project-identity');
const { canonicalStringify } = require('./self-learning-canonical');
const {
  getOrAppendBehaviorEventReceipt,
  projectJournal,
  readJournal,
  resolveStoreDir,
  tombstoneEntity,
  verifyJournal,
} = require('./self-learning-store');
const {
  appendBehaviorEvent,
  appendEvidenceRef,
  createBehaviorEvent,
  journalActorForEvent,
  normalizeBehaviorEvent,
  normalizeEvidenceRef,
  verifyEvidenceRef,
} = require('./behavior-events');
const {
  assessEpisodeJournal,
  buildBehaviorMetrics,
  closeBehaviorEpisode,
  normalizeBehaviorEpisode,
} = require('./behavior-episodes');
const {
  assertApprovalReceiptIntegrity,
  assertCandidateIntegrity,
  approveCandidate,
  evaluateCandidate,
  governCandidate,
  inspectCandidateStore,
  promoteCandidate,
  proposeCandidate,
  transitionCandidate,
} = require('./learning-candidates');
const {
  readEvaluationArtifactAuthority,
} = require('./self-learning-evaluation-artifacts');

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_SELF_LEARNING_POLICY = Object.freeze({
  enabled: true,
  writer_enabled: true,
  reader_enabled: true,
  mode: 'shadow',
  promotion: 'manual',
  minimum_distinct_episodes: 2,
  minimum_truth_score: 0.75,
  minimum_value_score: 0.6,
  retention_days: DEFAULT_RETENTION_DAYS,
  legacy_inputs: 'needs-review',
  legacy_writer_enabled: true,
  legacy_reader_enabled: true,
});
const SELF_LEARNING_POLICY_KEYS = Object.freeze(Object.keys(DEFAULT_SELF_LEARNING_POLICY));
const CANDIDATE_POLICY_KEYS = Object.freeze([
  'minimum_distinct_episodes',
  'minimum_truth_score',
  'minimum_value_score',
]);
const CONTEXT_IDENTITY_KEYS = new Set([
  'session_id', 'task_ref', 'personal_id', 'global_id', 'team_id', 'now',
]);
const WRITE_ACTIONS = new Set([
  'record', 'evidence', 'close', 'propose', 'evaluate', 'shadow',
  'approve', 'promote', 'govern', 'retention', 'artifact-stage', 'result-record',
]);

function serviceError(code, message) {
  const error = new Error(`self-learning-service: ${message}`);
  error.code = code;
  throw error;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    serviceError('SELF_LEARNING_INPUT_INVALID', `${label} must be an object`);
  }
  return value;
}

function assertExactKeys(
  value,
  allowed,
  label,
  code = 'SELF_LEARNING_CONFIG_INVALID'
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    serviceError(code, `${label} must be an object`);
  }
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
  if (unexpected.length > 0) {
    serviceError(
      code,
      `${label} has unexpected field(s): ${unexpected.join(', ')}`
    );
  }
}

function normalizeUnitScore(value, label, code = 'SELF_LEARNING_CONFIG_INVALID') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    serviceError(code, `${label} must be a finite number in [0,1]`);
  }
  return value;
}

function normalizePositiveInteger(
  value,
  label,
  minimum = 1,
  code = 'SELF_LEARNING_CONFIG_INVALID'
) {
  if (!Number.isInteger(value) || value < minimum) {
    serviceError(code, `${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function loadSelfLearningPolicy(baseDir) {
  const configFile = path.join(baseDir, 'config.json');
  if (!fs.existsSync(configFile)) return { ...DEFAULT_SELF_LEARNING_POLICY };
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    serviceError('SELF_LEARNING_CONFIG_INVALID', `cannot read ${configFile}: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    serviceError('SELF_LEARNING_CONFIG_INVALID', 'config.json root must be an object');
  }
  if (config && config.self_learning !== undefined && config.selfLearning !== undefined) {
    serviceError('SELF_LEARNING_CONFIG_INVALID', 'configure self_learning only once');
  }
  const configured = config && (config.self_learning !== undefined
    ? config.self_learning
    : config.selfLearning);
  if (configured === undefined) return { ...DEFAULT_SELF_LEARNING_POLICY };
  assertExactKeys(configured, SELF_LEARNING_POLICY_KEYS, 'self_learning config');
  const policy = { ...DEFAULT_SELF_LEARNING_POLICY };
  for (const key of [
    'enabled', 'writer_enabled', 'reader_enabled',
    'legacy_writer_enabled', 'legacy_reader_enabled',
  ]) {
    if (configured[key] !== undefined) {
      if (typeof configured[key] !== 'boolean') {
        serviceError('SELF_LEARNING_CONFIG_INVALID', `self_learning.${key} must be boolean`);
      }
      policy[key] = configured[key];
    }
  }
  if (configured.mode !== undefined) {
    if (!['shadow', 'off'].includes(configured.mode)) {
      serviceError('SELF_LEARNING_CONFIG_INVALID', 'self_learning.mode must be shadow or off');
    }
    policy.mode = configured.mode;
  }
  if (configured.promotion !== undefined) {
    if (configured.promotion !== 'manual') {
      serviceError('SELF_LEARNING_CONFIG_INVALID', 'self_learning.promotion must be manual');
    }
    policy.promotion = configured.promotion;
  }
  if (configured.minimum_distinct_episodes !== undefined) {
    policy.minimum_distinct_episodes = normalizePositiveInteger(
      configured.minimum_distinct_episodes,
      'self_learning.minimum_distinct_episodes',
      2
    );
  }
  for (const key of ['minimum_truth_score', 'minimum_value_score']) {
    if (configured[key] !== undefined) {
      policy[key] = normalizeUnitScore(configured[key], `self_learning.${key}`);
    }
  }
  if (configured.retention_days !== undefined) {
    policy.retention_days = normalizePositiveInteger(
      configured.retention_days,
      'self_learning.retention_days'
    );
  }
  if (configured.legacy_inputs !== undefined) {
    if (!['needs-review', 'off'].includes(configured.legacy_inputs)) {
      serviceError(
        'SELF_LEARNING_CONFIG_INVALID',
        'self_learning.legacy_inputs must be needs-review or off'
      );
    }
    policy.legacy_inputs = configured.legacy_inputs;
  }
  return policy;
}

function assertActionEnabled(action, context) {
  const policy = context.policy;
  if (WRITE_ACTIONS.has(action)
      && (!policy.enabled || !policy.writer_enabled || policy.mode === 'off')) {
    serviceError('SELF_LEARNING_WRITER_DISABLED', `write action "${action}" is disabled by policy`);
  }
  if (action === 'context'
      && (!policy.enabled || !policy.reader_enabled || policy.mode === 'off')) {
    serviceError('SELF_LEARNING_READER_DISABLED', 'automatic learning context is disabled by policy');
  }
}

function resolveLearningContext(options = {}, policy = {}) {
  const suppliedBase = options.base_dir || options.baseDir;
  if (policy.require_explicit_base_dir === true && !suppliedBase) {
    serviceError('SELF_LEARNING_BASE_DIR_REQUIRED', 'an explicit base_dir is required for this entry point');
  }
  const baseDir = path.resolve(suppliedBase || resolveBaseDir());
  const detected = detectStableProjectIdentity(options.cwd || process.cwd());
  const projectId = options.project_id || options.projectId || detected.id;
  if (typeof projectId !== 'string' || !projectId.trim()) {
    serviceError('SELF_LEARNING_PROJECT_REQUIRED', 'project_id is required');
  }
  return {
    base_dir: baseDir,
    project_id: projectId,
    project: options.project_id || options.projectId
      ? { id: projectId, source: 'explicit' }
      : detected,
    store_dir: resolveStoreDir(baseDir, projectId),
    policy: loadSelfLearningPolicy(baseDir),
  };
}

function bindProject(input, context) {
  const value = { ...requireObject(input, 'input') };
  if (value.project_id != null && value.project_id !== context.project_id) {
    serviceError(
      'SELF_LEARNING_PROJECT_MISMATCH',
      `input project_id ${value.project_id} does not match context ${context.project_id}`
    );
  }
  value.project_id = context.project_id;
  return value;
}

function untrustedRecordEntrypoint(policy) {
  if (policy.entrypoint === 'mcp') {
    return {
      actor_id: 'codex-mcp',
      code: 'SELF_LEARNING_MCP_AUTHORITY_FORBIDDEN',
      label: 'MCP',
      source: 'codex_mcp',
      runtime: 'codex',
      server_time: true,
    };
  }
  if (policy.entrypoint === 'cli') {
    return {
      actor_id: 'codex-cli',
      code: 'SELF_LEARNING_CLI_AUTHORITY_FORBIDDEN',
      label: 'CLI',
      source: 'codex_cli',
      runtime: 'codex',
      server_time: true,
    };
  }
  return null;
}

function bindRecordAuthority(input, context, policy, occurredAt = null) {
  const value = bindProject(input, context);
  const entrypoint = untrustedRecordEntrypoint(policy);
  if (!entrypoint) return value;
  if (typeof value.event_type === 'string' && value.event_type.startsWith('user.')) {
    serviceError(
      entrypoint.code,
      `${entrypoint.label} observations cannot create trusted user events; use a trusted native host capture`
    );
  }
  const details = value.details && typeof value.details === 'object' && !Array.isArray(value.details)
    ? { ...value.details }
    : {};
  if (value.event_type === 'task.result' || details.verification_status != null) {
    details.verification_status = 'unknown';
  }
  return {
    ...value,
    actor: { kind: 'agent', id: entrypoint.actor_id, role: null },
    ...(entrypoint.runtime ? { runtime: entrypoint.runtime } : {}),
    source: entrypoint.source,
    source_assurance: 'observed',
    signal_strength: 'weak',
    fact_status: 'unknown',
    occurred_at: entrypoint.server_time
      ? (occurredAt || new Date().toISOString())
      : value.occurred_at,
    details,
    final_disposition: 'unknown',
    evidence_refs: [],
  };
}

function appendAuthorityBoundBehaviorEvent(context, input, policy) {
  const entrypoint = untrustedRecordEntrypoint(policy);
  if (!entrypoint || !entrypoint.server_time) {
    return appendBehaviorEvent(
      context.store_dir,
      bindRecordAuthority(input, context, policy)
    );
  }

  const initialEvent = createBehaviorEvent(bindRecordAuthority(input, context, policy));
  let event = initialEvent;
  const result = getOrAppendBehaviorEventReceipt(
    context.store_dir,
    { record_id: initialEvent.event_id },
    ({ occurred_at: occurredAt }) => {
      event = createBehaviorEvent(bindRecordAuthority(input, context, policy, occurredAt));
      return {
        record_type: 'behavior_event',
        record_id: event.event_id,
        entity_id: event.event_id,
        actor: journalActorForEvent(event),
        occurred_at: event.occurred_at,
        payload: event,
      };
    }
  );
  return { ...result, event };
}

function normalizeCandidatePolicyOverlay(input) {
  if (input === undefined) return null;
  assertExactKeys(
    input,
    CANDIDATE_POLICY_KEYS,
    'candidate policy',
    'SELF_LEARNING_INPUT_INVALID'
  );
  for (const key of CANDIDATE_POLICY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      serviceError('SELF_LEARNING_INPUT_INVALID', `candidate policy.${key} is required`);
    }
  }
  return {
    minimum_distinct_episodes: normalizePositiveInteger(
      input.minimum_distinct_episodes,
      'candidate policy.minimum_distinct_episodes',
      2,
      'SELF_LEARNING_INPUT_INVALID'
    ),
    minimum_truth_score: normalizeUnitScore(
      input.minimum_truth_score,
      'candidate policy.minimum_truth_score',
      'SELF_LEARNING_INPUT_INVALID'
    ),
    minimum_value_score: normalizeUnitScore(
      input.minimum_value_score,
      'candidate policy.minimum_value_score',
      'SELF_LEARNING_INPUT_INVALID'
    ),
  };
}

function bindCandidatePolicy(input, context) {
  const value = bindProject(input, context);
  const evidence = [
    ...(Array.isArray(value.evidence_refs) ? value.evidence_refs : []),
    ...(Array.isArray(value.counterexamples)
      ? value.counterexamples.map((item) => item && item.evidence_ref).filter(Boolean)
      : []),
  ];
  const legacyEvidence = evidence.filter((item) => item
    && (item.source_type === 'legacy_observation' || item.assurance === 'legacy_unverified'));
  if (legacyEvidence.length > 0 && context.policy.legacy_inputs === 'off') {
    serviceError('SELF_LEARNING_LEGACY_DISABLED', 'legacy evidence inputs are disabled by policy');
  }
  for (const item of legacyEvidence) {
    if (item.source_type !== 'legacy_observation'
        || item.assurance !== 'legacy_unverified'
        || item.signal_strength !== 'weak'
        || item.fact_status !== 'unknown'
        || item.final_disposition !== 'unknown') {
      serviceError(
        'SELF_LEARNING_LEGACY_INVALID',
        'legacy evidence must remain legacy_unverified, weak, unknown, and unresolved'
      );
    }
  }
  const requested = normalizeCandidatePolicyOverlay(value.policy);
  const configured = {
    minimum_distinct_episodes: context.policy.minimum_distinct_episodes,
    minimum_truth_score: context.policy.minimum_truth_score,
    minimum_value_score: context.policy.minimum_value_score,
  };
  value.policy = requested === null ? configured : {
    minimum_distinct_episodes: Math.max(
      requested.minimum_distinct_episodes,
      configured.minimum_distinct_episodes
    ),
    minimum_truth_score: Math.max(
      requested.minimum_truth_score,
      configured.minimum_truth_score
    ),
    minimum_value_score: Math.max(
      requested.minimum_value_score,
      configured.minimum_value_score
    ),
  };
  return value;
}

function bindProposalAuthority(input, context, policy) {
  const value = bindCandidatePolicy(input, context);
  const entrypoint = untrustedRecordEntrypoint(policy);
  if (!entrypoint) return value;
  const proposer = {
    kind: 'agent',
    id: entrypoint.actor_id,
    authority_ref: null,
  };
  return {
    ...value,
    proposer,
    owner: { ...proposer },
    collector_ref: null,
    occurred_at: new Date().toISOString(),
  };
}

function bindEvaluationArtifact(input, context, candidateId) {
  const value = { ...requireObject(input, 'evaluation input') };
  for (const field of [
    'evaluation_artifact_authority',
    'case_set_hash', 'case_results_hash', 'case_count', 'passed_count', 'pass_rate',
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      serviceError(
        'SELF_LEARNING_EVALUATION_AUTHORITY_REQUIRED',
        `evaluation ${field} is caller-controlled; provide evaluation_artifact_ref instead`
      );
    }
  }
  const ref = value.evaluation_artifact_ref;
  assertExactKeys(
    ref,
    ['name'],
    'evaluation_artifact_ref',
    'SELF_LEARNING_EVALUATION_AUTHORITY_REQUIRED'
  );
  if (typeof ref.name !== 'string' || !ref.name.trim()) {
    serviceError(
      'SELF_LEARNING_EVALUATION_AUTHORITY_REQUIRED',
      'evaluation_artifact_ref.name is required'
    );
  }
  delete value.evaluation_artifact_ref;
  value.evaluation_artifact_authority = readEvaluationArtifactAuthority(
    ref.name.trim(),
    candidateId,
    { baseDir: context.base_dir, projectId: context.project_id }
  );
  return value;
}

function entrypointRoleActor(entrypoint, role) {
  return {
    kind: 'agent',
    id: `${entrypoint.actor_id}-${role}`,
    authority_ref: null,
  };
}

function bindEvaluationAuthority(input, context, candidateId, policy) {
  const value = bindEvaluationArtifact(input, context, candidateId);
  const entrypoint = untrustedRecordEntrypoint(policy);
  if (!entrypoint) return value;
  return {
    ...value,
    assessor: entrypointRoleActor(entrypoint, 'evaluator'),
    assessed_at: new Date().toISOString(),
  };
}

function bindShadowAuthority(input, policy) {
  const value = { ...requireObject(input, 'shadow input') };
  const entrypoint = untrustedRecordEntrypoint(policy);
  if (!entrypoint) return value;
  return {
    ...value,
    actor: entrypointRoleActor(entrypoint, 'shadow'),
    occurred_at: new Date().toISOString(),
  };
}

function normalizedContextIdentity(input = {}) {
  requireObject(input, 'context input');
  const unexpected = Object.keys(input).filter((key) => !CONTEXT_IDENTITY_KEYS.has(key)).sort();
  if (unexpected.length > 0) {
    serviceError(
      'SELF_LEARNING_INPUT_INVALID',
      `context input has unexpected field(s): ${unexpected.join(', ')}`
    );
  }
  const identity = {};
  for (const key of ['session_id', 'task_ref', 'personal_id', 'global_id', 'team_id']) {
    const value = input[key];
    if (value === undefined || value === null) {
      identity[key] = null;
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      serviceError('SELF_LEARNING_INPUT_INVALID', `context input.${key} must be non-empty`);
    }
    identity[key] = value.trim();
  }
  const now = input.now === undefined ? new Date().toISOString() : input.now;
  const parsed = new Date(now);
  if (typeof now !== 'string' || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== now) {
    serviceError('SELF_LEARNING_INPUT_INVALID', 'context input.now must be normalized ISO time');
  }
  identity.now = now;
  return identity;
}

function candidateExpiryTime(candidate, retentionDays) {
  if (!candidate || !candidate.retention || candidate.retention.tombstoned !== false) return null;
  if (candidate.retention.expires_at !== null) {
    const explicit = new Date(candidate.retention.expires_at);
    if (Number.isNaN(explicit.getTime())
        || explicit.toISOString() !== candidate.retention.expires_at) return null;
    return explicit.getTime();
  }
  const anchor = candidate.updated_at || candidate.created_at;
  const parsed = new Date(anchor);
  if (typeof anchor !== 'string' || Number.isNaN(parsed.getTime())
      || parsed.toISOString() !== anchor) return null;
  return parsed.getTime() + retentionDays * 24 * 60 * 60 * 1000;
}

function candidateScopeMatches(candidate, identity) {
  if (!candidate || !candidate.scope || typeof candidate.scope !== 'object') return false;
  const expectedByLevel = {
    project: identity.project_id,
    session: identity.session_id,
    task: identity.task_ref,
    personal: identity.personal_id,
    global: identity.global_id,
    team: identity.team_id,
  };
  const expected = expectedByLevel[candidate.scope.level];
  return typeof expected === 'string' && expected.length > 0 && candidate.scope.id === expected;
}

function filterCandidatesForContext(candidates, input = {}) {
  if (!Array.isArray(candidates)) return [];
  const identity = {
    project_id: typeof input.project_id === 'string' ? input.project_id : null,
    session_id: typeof input.session_id === 'string' ? input.session_id : null,
    task_ref: typeof input.task_ref === 'string' ? input.task_ref : null,
    personal_id: typeof input.personal_id === 'string' ? input.personal_id : null,
    global_id: typeof input.global_id === 'string' ? input.global_id : null,
    team_id: typeof input.team_id === 'string' ? input.team_id : null,
  };
  const now = new Date(input.now);
  const retentionDays = Number.isInteger(input.retention_days) && input.retention_days >= 1
    ? input.retention_days
    : DEFAULT_RETENTION_DAYS;
  if (typeof input.now !== 'string' || Number.isNaN(now.getTime())
      || now.toISOString() !== input.now) return [];
  return candidates.filter((candidate) => {
    if (!candidateScopeMatches(candidate, identity)) return false;
    const expiry = candidateExpiryTime(candidate, retentionDays);
    return expiry !== null && expiry > now.getTime();
  });
}

function storeActor(input, runtime = 'unknown') {
  requireObject(input, 'actor');
  const allowed = new Set(['user', 'agent', 'hook', 'system', 'operator', 'legacy']);
  if (!allowed.has(input.kind)) serviceError('SELF_LEARNING_ACTOR_INVALID', `unsupported actor kind ${input.kind}`);
  if (typeof input.id !== 'string' || !input.id.trim()) {
    serviceError('SELF_LEARNING_ACTOR_INVALID', 'actor.id is required');
  }
  return {
    kind: input.kind,
    id: input.id,
    runtime: input.runtime == null ? runtime : input.runtime,
    authority_ref: input.authority_ref == null ? null : input.authority_ref,
  };
}

function episodeScope(episode) {
  if (episode.task_ref) return { level: 'task', id: episode.task_ref };
  return { level: 'session', id: episode.session_id };
}

function recordEpisodeEvidence(context, episodeResult, actor) {
  const { episode, record } = episodeResult;
  const evidence = normalizeEvidenceRef({
    schema_version: 'self-learning-evidence-ref-v1',
    source_type: 'behavior_episode',
    source_ref: episode.episode_id,
    immutable_ref: `journal-record:${record.record_hash}`,
    digest: record.payload_hash,
    uri: null,
    final_disposition: episode.final_disposition,
    captured_at: episode.created_at,
    scope: episodeScope(episode),
    redaction_status: 'passed',
    assurance: ['verified', 'failed'].includes(episode.verification_status)
      ? 'verified'
      : 'observed',
    signal_strength: episode.explicit_feedback.length > 0 ? 'explicit' : 'inferred',
    fact_status: ['verified', 'failed'].includes(episode.verification_status) ? 'fact' : 'unknown',
  });
  return appendEvidenceRef(context.store_dir, evidence, {
    actor: {
      kind: actor.kind === 'operator' ? 'user' : actor.kind,
      id: actor.id,
      role: null,
    },
    occurred_at: episode.created_at,
  });
}

function activeEpisodeProjection(storeDir) {
  const journal = readJournal(storeDir);
  return assessEpisodeJournal(journal).episodes
    .filter((item) => item.episode !== null)
    .map((item) => ({
      episode: item.episode,
      effective_status: item.effective_status,
      invalidated_event_ids: item.invalidated_event_ids,
    }));
}

function activeEpisodes(storeDir) {
  return activeEpisodeProjection(storeDir).map((item) => item.episode);
}

function candidateCounts(candidates) {
  return candidates.reduce((counts, candidate) => {
    const status = candidate.effective_status || candidate.status;
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function inspectLearning(context, input = {}) {
  const candidates = inspectCandidateStore(context.store_dir);
  const episodes = activeEpisodeProjection(context.store_dir);
  const filteredCandidates = input.candidate_id
    ? candidates.candidates.filter((candidate) => candidate.candidate_id === input.candidate_id)
    : candidates.candidates;
  return {
    schema_version: 'self-learning-inspection-v1',
    project_id: context.project_id,
    journal: {
      revision: candidates.journal_revision,
      head_hash: candidates.journal_head_hash,
    },
    candidates: filteredCandidates,
    tombstoned: candidates.tombstoned,
    receipts: candidates.receipts,
    context: candidates.context,
    episodes: episodes.map((item) => ({
      ...item.episode,
      effective_status: item.effective_status,
      invalidated_event_ids: item.invalidated_event_ids,
    })),
  };
}

function readLearningContext(context, input = {}) {
  const identity = normalizedContextIdentity(input);
  const projection = inspectCandidateStore(context.store_dir);
  const selection = {
    ...identity,
    project_id: context.project_id,
    retention_days: context.policy.retention_days,
  };
  return {
    schema_version: 'self-learning-context-v1',
    project_id: context.project_id,
    journal: {
      revision: projection.journal_revision,
      head_hash: projection.journal_head_hash,
    },
    automatic_context: filterCandidatesForContext(projection.context.promoted, selection),
    shadow_suggestions: filterCandidatesForContext(projection.context.shadow, selection),
    policy: {
      automatic_context_status: 'promoted',
      shadow_auto_injection: false,
      runtime_write_performed: false,
      evaluated_at: identity.now,
    },
  };
}

function learningMetrics(context) {
  const candidateView = inspectCandidateStore(context.store_dir);
  const episodeProjection = activeEpisodeProjection(context.store_dir);
  const episodes = episodeProjection.map((item) => item.episode);
  return {
    schema_version: 'self-learning-metrics-v1',
    project_id: context.project_id,
    behavior: buildBehaviorMetrics(episodes, {
      quality_excluded_episode_ids: episodeProjection
        .filter((item) => item.effective_status === 'needs_review'
          && item.invalidated_event_ids.length > 0)
        .map((item) => item.episode.episode_id),
    }),
    candidates: {
      total: candidateView.candidates.length,
      by_status: candidateCounts(candidateView.candidates),
      promoted_context_count: candidateView.context.promoted.length,
      shadow_suggestion_count: candidateView.context.shadow.length,
      tombstoned_count: candidateView.tombstoned.length,
    },
    interpretation: {
      tool_calls_are_usage_not_quality: true,
      unknown_denominators_remain_unknown: true,
    },
  };
}

function governEntity(context, input) {
  requireObject(input, 'govern input');
  if (!input.actor || input.actor.kind !== 'user') {
    serviceError('SELF_LEARNING_HUMAN_REQUIRED', 'entity tombstone requires a user actor');
  }
  const journal = readJournal(context.store_dir);
  const active = projectJournal(context.store_dir).active;
  const target = active.find((record) => record.entity_id === input.entity_id);
  if (!target) serviceError('SELF_LEARNING_ENTITY_NOT_FOUND', `active entity not found: ${input.entity_id}`);
  if (!input.expected_record_hash || input.expected_record_hash !== target.record_hash) {
    serviceError('SELF_LEARNING_HASH_CONFLICT', 'expected_record_hash does not match active entity');
  }
  return tombstoneEntity(context.store_dir, {
    record_id: input.record_id || `tombstone:${input.entity_id}:${journal.revision + 1}`,
    target_id: input.entity_id,
    target_hash: target.record_hash,
    actor: storeActor(input.actor, input.runtime || 'unknown'),
    occurred_at: input.occurred_at,
    reason: input.reason,
    ...(input.replacement_id === undefined ? {} : { replacement_id: input.replacement_id }),
  }, {
    expected_revision: journal.revision,
    expected_head_hash: journal.head_hash,
  });
}

function applyRetention(context, input) {
  requireObject(input, 'retention input');
  if (!input.actor || !['user', 'operator'].includes(input.actor.kind)) {
    serviceError('SELF_LEARNING_HUMAN_REQUIRED', 'retention requires a user/operator actor');
  }
  const retentionRequester = storeActor(input.actor, input.runtime || 'unknown');
  const now = new Date(input.now);
  if (Number.isNaN(now.getTime()) || now.toISOString() !== input.now) {
    serviceError('SELF_LEARNING_INPUT_INVALID', 'retention now must be normalized ISO time');
  }
  const days = input.retention_days == null
    ? context.policy.retention_days
    : input.retention_days;
  if (!Number.isInteger(days) || days < 1) {
    serviceError('SELF_LEARNING_INPUT_INVALID', 'retention_days must be an integer >= 1');
  }
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const candidateView = inspectCandidateStore(context.store_dir);
  const expirableStatuses = new Set([
    'proposed', 'evaluated', 'shadow', 'approved', 'promoted', 'needs-review',
  ]);
  const dueCandidates = candidateView.candidates.filter((candidate) => {
    if (!expirableStatuses.has(candidate.status)) return false;
    const expiresAt = candidateExpiryTime(candidate, days);
    return expiresAt !== null && expiresAt <= now.getTime();
  });
  const expiredCandidates = [];
  for (const candidate of dueCandidates) {
    const expiresAt = new Date(candidateExpiryTime(candidate, days)).toISOString();
    expiredCandidates.push(transitionCandidate(
      context.store_dir,
      candidate.candidate_id,
      'expired',
      {
        expected_candidate_hash: candidate.candidate_hash,
        actor: {
          kind: 'system',
          id: 'self-learning-retention',
          authority_ref: 'local:retention-policy',
        },
        occurred_at: input.now,
        reason: `retention expired at ${expiresAt} under ${days}-day policy; requested by ${retentionRequester.kind}:${retentionRequester.id}`,
      }
    ));
  }
  const eligibleTypes = new Set(['behavior_event', 'evidence_ref', 'behavior_episode']);
  const targets = projectJournal(context.store_dir).active.filter((record) =>
    eligibleTypes.has(record.record_type)
    && new Date(record.occurred_at).getTime() < cutoff
  );
  const results = [];
  for (const target of targets) {
    const current = readJournal(context.store_dir);
    results.push(tombstoneEntity(context.store_dir, {
      record_id: `retention:${target.entity_id}:${current.revision + 1}`,
      target_id: target.entity_id,
      target_hash: target.record_hash,
      actor: retentionRequester,
      occurred_at: input.now,
      reason: `retention expired after ${days} days`,
    }, {
      expected_revision: current.revision,
      expected_head_hash: current.head_hash,
    }));
  }
  return {
    schema_version: 'self-learning-retention-result-v1',
    cutoff: new Date(cutoff).toISOString(),
    retention_days: days,
    expired_candidate_count: expiredCandidates.length,
    expired_candidate_ids: expiredCandidates.map((result) => result.candidate.candidate_id),
    tombstoned_count: results.length,
    physical_purge_performed: false,
  };
}

function verifyDomainJournal(context) {
  const journal = verifyJournal(context.store_dir);
  const receiptRecords = new Map();
  for (const record of journal.records) {
    try {
      if (record.record_type === 'behavior_event') {
        const event = normalizeBehaviorEvent(record.payload);
        if (record.record_id !== event.event_id || record.entity_id !== event.event_id) {
          throw new Error('journal identity does not match event_id');
        }
        if (event.project_id !== context.project_id) {
          throw new Error('event project_id does not match authority store');
        }
        if (record.occurred_at !== event.occurred_at) {
          throw new Error('journal occurred_at does not match event occurred_at');
        }
        if (canonicalStringify(record.actor) !== canonicalStringify(journalActorForEvent(event))) {
          throw new Error('journal actor does not match event authority');
        }
      } else if (record.record_type === 'evidence_ref') {
        const verification = verifyEvidenceRef(record.payload);
        if (!verification.valid) throw new Error(verification.errors[0]);
        const evidence = normalizeEvidenceRef(record.payload);
        if ((evidence.source_type === 'legacy_observation'
            || evidence.assurance === 'legacy_unverified')
            && (evidence.source_type !== 'legacy_observation'
              || evidence.assurance !== 'legacy_unverified'
              || evidence.signal_strength !== 'weak'
              || evidence.fact_status !== 'unknown'
              || evidence.final_disposition !== 'unknown')) {
          throw new Error('legacy evidence has invalid assurance semantics');
        }
        if (record.record_id !== evidence.evidence_id || record.entity_id !== evidence.evidence_id) {
          throw new Error('journal identity does not match evidence_id');
        }
        if (evidence.scope.level === 'project' && evidence.scope.id !== context.project_id) {
          throw new Error('evidence project scope does not match authority store');
        }
      } else if (record.record_type === 'behavior_episode') {
        const episode = normalizeBehaviorEpisode(record.payload);
        if (record.entity_id !== episode.episode_id
            || record.record_id !== `${episode.episode_id}:r${episode.revision}`) {
          throw new Error('journal identity does not match episode revision');
        }
        if (episode.project_id !== context.project_id) {
          throw new Error('episode project_id does not match authority store');
        }
        if (record.occurred_at !== episode.created_at) {
          throw new Error('journal occurred_at does not match episode created_at');
        }
      } else if (record.record_type === 'approval_receipt') {
        const payloadKeys = record.payload && typeof record.payload === 'object'
          && !Array.isArray(record.payload)
          ? Object.keys(record.payload).sort()
          : [];
        if (canonicalStringify(payloadKeys)
            !== canonicalStringify(['receipt', 'schema_version'])) {
          throw new Error('approval receipt journal payload must have an exact wrapper');
        }
        if (record.payload.schema_version !== 'self-learning-approval-record-v1') {
          throw new Error('approval receipt journal wrapper schema is invalid');
        }
        const receipt = assertApprovalReceiptIntegrity(record.payload.receipt);
        if (record.record_id !== `receipt:${receipt.receipt_id}`
            || record.entity_id !== receipt.receipt_id) {
          throw new Error('journal identity does not match approval receipt');
        }
        if (record.occurred_at !== receipt.approved_at) {
          throw new Error('journal occurred_at does not match approval receipt');
        }
        if (record.actor.kind !== receipt.publisher.kind
            || record.actor.id !== receipt.publisher.id
            || record.actor.authority_ref !== receipt.publisher.authority_ref) {
          throw new Error('journal actor does not match approval receipt publisher authority');
        }
        receiptRecords.set(receipt.receipt_id, receipt);
      } else if ([
        'learning_candidate', 'candidate_transition', 'candidate_evaluation',
      ].includes(record.record_type)) {
        const candidate = record.payload && record.payload.candidate;
        assertCandidateIntegrity(candidate);
        if (candidate.project_id !== context.project_id) {
          throw new Error('candidate project_id does not match authority store');
        }
        if (record.entity_id !== candidate.candidate_id
            || record.record_id !== `candidate:${candidate.candidate_id}:r${candidate.revision}`) {
          throw new Error('journal identity does not match candidate revision');
        }
      }
    } catch (error) {
      serviceError(
        'SELF_LEARNING_DOMAIN_INVALID',
        `${record.record_type} record ${record.record_id} failed domain verification: ${error.message}`
      );
    }
  }
  const episodeAssessment = assessEpisodeJournal(journal, { project_id: context.project_id });
  if (episodeAssessment.errors.length > 0) {
    serviceError(
      'SELF_LEARNING_DOMAIN_INVALID',
      `episode journal failed domain verification: ${episodeAssessment.errors[0]}`
    );
  }
  let candidates;
  try {
    candidates = inspectCandidateStore(context.store_dir);
  } catch (error) {
    serviceError(
      'SELF_LEARNING_DOMAIN_INVALID',
      `candidate projection failed domain verification: ${error.message}`
    );
  }
  try {
    for (const receipt of candidates.receipts || []) {
      const stored = receiptRecords.get(receipt.receipt_id);
      if (!stored || canonicalStringify(stored) !== canonicalStringify(receipt)) {
        throw new Error(`projected approval receipt ${receipt.receipt_id} is not journal-bound`);
      }
      const candidate = candidates.candidates.find(
        (item) => item.candidate_id === receipt.candidate_id
      );
      if (!candidate || candidate.project_id !== context.project_id) {
        throw new Error(`approval receipt ${receipt.receipt_id} candidate project mismatch`);
      }
      const approvalBound = candidate.approval
        && candidate.approval.receipt_id === receipt.receipt_id
        && candidate.approval.receipt_hash === receipt.receipt_hash;
      const promotionBound = candidate.promotion
        && candidate.promotion.approval_receipt_id === receipt.receipt_id
        && candidate.promotion.approval_receipt_hash === receipt.receipt_hash;
      if (!approvalBound && !promotionBound) {
        throw new Error(`approval receipt ${receipt.receipt_id} is not candidate-bound`);
      }
    }
  } catch (error) {
    serviceError(
      'SELF_LEARNING_DOMAIN_INVALID',
      `approval receipt projection failed domain verification: ${error.message}`
    );
  }
  return {
    ...journal,
    domain_verified: true,
    domain_record_count: journal.records.length,
    candidate_projection_revision: candidates.journal_revision,
  };
}

function executeLearningAction(action, args = {}, policy = {}) {
  const context = resolveLearningContext(args, policy);
  assertActionEnabled(action, context);
  const input = args.input || {};
  switch (action) {
    case 'record':
      return {
        context,
        result: appendAuthorityBoundBehaviorEvent(context, input, policy),
      };
    case 'evidence': {
      const entrypoint = untrustedRecordEntrypoint(policy);
      if (entrypoint) {
        serviceError(
          entrypoint.code,
          `${entrypoint.label} evidence cannot establish trusted authority; use a trusted native host capture`
        );
      }
      const evidenceInput = input.evidence || input;
      const evidenceActor = args.actor || input.actor;
      const occurredAt = args.occurred_at || input.occurred_at || evidenceInput.captured_at;
      return {
        context,
        result: appendEvidenceRef(context.store_dir, evidenceInput, {
          actor: evidenceActor,
          occurred_at: occurredAt,
        }),
      };
    }
    case 'close': {
      const closeInput = bindProject(input, context);
      const result = closeBehaviorEpisode(context.store_dir, closeInput);
      const evidence = recordEpisodeEvidence(context, result, closeInput.actor);
      return { context, result, evidence };
    }
    case 'propose':
      return { context, result: proposeCandidate(
        context.store_dir,
        bindProposalAuthority(input, context, policy)
      ) };
    case 'evaluate':
      return {
        context,
        result: evaluateCandidate(
          context.store_dir,
          args.candidate_id,
          bindEvaluationAuthority(input, context, args.candidate_id, policy)
        ),
      };
    case 'shadow':
      return { context, result: transitionCandidate(
        context.store_dir,
        args.candidate_id,
        'shadow',
        bindShadowAuthority(input, policy)
      ) };
    case 'approve':
      return { context, result: approveCandidate(context.store_dir, args.candidate_id, input) };
    case 'promote':
      return { context, result: promoteCandidate(context.store_dir, args.candidate_id, input) };
    case 'inspect':
      return { context, result: inspectLearning(context, { ...input, candidate_id: args.candidate_id }) };
    case 'context':
      return { context, result: readLearningContext(context, input) };
    case 'metrics':
      return { context, result: learningMetrics(context) };
    case 'govern':
      return {
        context,
        result: args.candidate_id
          ? governCandidate(context.store_dir, args.candidate_id, input)
          : governEntity(context, input),
      };
    case 'retention':
      return { context, result: applyRetention(context, input) };
    case 'verify-store':
      return { context, result: verifyDomainJournal(context) };
    default:
      serviceError('SELF_LEARNING_ACTION_INVALID', `unknown action "${action}"`);
  }
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SELF_LEARNING_POLICY,
  activeEpisodes,
  applyRetention,
  assertActionEnabled,
  bindCandidatePolicy,
  executeLearningAction,
  filterCandidatesForContext,
  governEntity,
  inspectLearning,
  learningMetrics,
  loadSelfLearningPolicy,
  readLearningContext,
  recordEpisodeEvidence,
  resolveLearningContext,
  verifyDomainJournal,
};
