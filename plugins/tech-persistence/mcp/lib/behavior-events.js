'use strict';

const {
  assertExactKeys,
  assertRedactionStableString,
  canonicalStringify,
  hashObject,
  normalizeTimestamp,
  redactCanonicalValue,
  validateHash,
  validateIdentifier,
} = require('./self-learning-canonical');

const EVIDENCE_REF_SCHEMA_VERSION = 'self-learning-evidence-ref-v1';
const BEHAVIOR_EVENT_SCHEMA_VERSION = 'self-learning-behavior-event-v1';
const IDEMPOTENCY_RE = /^idem:[a-f0-9]{64}$/;
const MAX_DETAILS_BYTES = 16 * 1024;
const MAX_SUMMARY_CHARS = 1200;

const RUNTIMES = new Set(['claude', 'codex', 'unknown']);
const ACTOR_KINDS = new Set(['user', 'agent', 'tool', 'runtime', 'system']);
const SCOPE_LEVELS = new Set(['session', 'task', 'project', 'global', 'team']);
const SOURCES = new Set(['claude_hook', 'codex_cli', 'codex_mcp', 'agent_loop', 'legacy_unverified']);
const ASSURANCES = new Set(['verified', 'explicit', 'observed', 'legacy_unverified']);
const FACT_STATUSES = new Set(['fact', 'inference', 'unknown']);
const SIGNAL_STRENGTHS = new Set(['explicit', 'weak', 'inferred']);
const EVENT_STATUSES = new Set(['observed', 'succeeded', 'failed', 'blocked', 'unknown']);
const FINAL_DISPOSITIONS = new Set(['accepted', 'rejected', 'reverted', 'superseded', 'unknown']);
const EVENT_TYPES = new Set([
  'user.prompt', 'user.feedback', 'user.correction', 'user.approval',
  'tool.request', 'tool.result', 'task.result', 'system.lifecycle',
]);
const EVIDENCE_SOURCE_TYPES = new Set([
  'behavior_event', 'behavior_episode', 'trace', 'document', 'task_envelope',
  'result_envelope', 'acceptance_receipt', 'user_confirmation', 'test', 'log',
  'external', 'legacy_observation',
]);
const REDACTION_STATUSES = new Set(['passed', 'rejected']);

const EVIDENCE_KEYS = Object.freeze([
  'schema_version', 'evidence_id', 'source_type', 'source_ref', 'immutable_ref',
  'digest', 'uri', 'final_disposition', 'captured_at', 'scope',
  'redaction_status', 'assurance', 'signal_strength', 'fact_status',
]);
const EVENT_KEYS = Object.freeze([
  'schema_version', 'event_id', 'source_event_id', 'idempotency_key',
  'project_id', 'session_id', 'task_ref', 'turn_ref', 'parent_event_id',
  'actor', 'runtime', 'source', 'source_assurance', 'scope', 'event_type',
  'signal_strength', 'fact_status', 'status', 'final_disposition', 'details',
  'input_digest', 'output_digest', 'evidence_refs', 'occurred_at',
]);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertAllowedKeys(value, allowed, label) {
  assertObject(value, label);
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length > 0) throw new Error(`${label} has unexpected key(s): ${extra.join(', ')}`);
}

function normalizeEnum(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} is unsupported: ${String(value)}`);
  return value;
}

function normalizeNullableIdentifier(value, label) {
  if (value === null) return null;
  return validateIdentifier(value, label);
}

function normalizeRequiredText(value, label, maximum = 2048) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  if (/\p{Cc}/u.test(value)) throw new Error(`${label} must not contain control characters`);
  return value;
}

function hashHex(value) {
  return hashObject(value).slice('sha256:'.length);
}

function normalizeActor(value) {
  assertExactKeys(value, ['kind', 'id', 'role'], 'actor');
  const id = validateIdentifier(value.id, 'actor.id');
  assertRedactionStableString(id, 'actor.id');
  const role = normalizeNullableIdentifier(value.role, 'actor.role');
  if (role !== null) assertRedactionStableString(role, 'actor.role');
  return {
    kind: normalizeEnum(value.kind, ACTOR_KINDS, 'actor.kind'),
    id,
    role,
  };
}

function normalizeScope(value, { projectId, sessionId, taskRef }) {
  assertExactKeys(value, ['level', 'id'], 'scope');
  const level = normalizeEnum(value.level, SCOPE_LEVELS, 'scope.level');
  const id = value.id === null ? null : normalizeRequiredText(value.id, 'scope.id', 256);
  if (level === 'task' && (!taskRef || id !== taskRef)) {
    throw new Error('task scope.id must match task_ref');
  }
  if (level === 'session' && id !== sessionId) {
    throw new Error('session scope.id must match session_id');
  }
  if (level === 'project' && id !== projectId) {
    throw new Error('project scope.id must match project_id');
  }
  if ((level === 'global' || level === 'team') && id !== null) {
    throw new Error(`${level} scope.id must be null`);
  }
  return { level, id };
}

function redactDetails(value, label = 'details') {
  const source = value === undefined ? {} : value;
  assertObject(source, label);
  const redacted = redactCanonicalValue(source, label);
  const size = Buffer.byteLength(canonicalStringify(redacted), 'utf8');
  if (size > MAX_DETAILS_BYTES) throw new Error(`${label} exceeds ${MAX_DETAILS_BYTES} bytes`);
  return redacted;
}

function normalizeDigest(value, supplied, label) {
  if (value === undefined || value === null) {
    if (supplied === undefined || supplied === null) return null;
    return validateHash(supplied, label);
  }
  const digest = hashObject(redactCanonicalValue(value, label));
  if (supplied !== undefined && supplied !== null && validateHash(supplied, label) !== digest) {
    throw new Error(`${label} does not match the redacted canonical value`);
  }
  return digest;
}

function assertRedactionStable(value, label) {
  if (canonicalStringify(redactCanonicalValue(value, label)) !== canonicalStringify(value)) {
    throw new Error(`${label} contains sensitive content outside a redacted payload field`);
  }
  return value;
}

function normalizeEvidenceIdList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('evidence_refs must be an array');
  const ids = value.map((item) => {
    if (typeof item === 'string') return validateIdentifier(item, 'evidence_refs item');
    return normalizeEvidenceRef(item).evidence_id;
  });
  return [...new Set(ids)].sort();
}

function normalizeEvidenceRef(input) {
  assertAllowedKeys(input, EVIDENCE_KEYS, 'EvidenceRef');
  const schemaVersion = input.schema_version || EVIDENCE_REF_SCHEMA_VERSION;
  if (schemaVersion !== EVIDENCE_REF_SCHEMA_VERSION) {
    throw new Error(`unsupported EvidenceRef schema_version: ${schemaVersion}`);
  }
  const sourceType = normalizeEnum(input.source_type, EVIDENCE_SOURCE_TYPES, 'source_type');
  const sourceRef = validateIdentifier(input.source_ref, 'source_ref');
  const immutableRef = normalizeRequiredText(input.immutable_ref, 'immutable_ref');
  const digest = validateHash(input.digest, 'digest');
  const uri = input.uri === null ? null : normalizeRequiredText(input.uri, 'uri', 4096);
  const finalDisposition = normalizeEnum(input.final_disposition, FINAL_DISPOSITIONS, 'final_disposition');
  const capturedAt = normalizeTimestamp(input.captured_at, 'captured_at');
  const scope = normalizeScope(input.scope, {
    projectId: input.scope && input.scope.level === 'project' ? input.scope.id : '__not-project__',
    sessionId: input.scope && input.scope.level === 'session' ? input.scope.id : '__not-session__',
    taskRef: input.scope && input.scope.level === 'task' ? input.scope.id : null,
  });
  const redactionStatus = normalizeEnum(input.redaction_status, REDACTION_STATUSES, 'redaction_status');
  const assurance = normalizeEnum(input.assurance, ASSURANCES, 'assurance');
  const signalStrength = normalizeEnum(input.signal_strength, SIGNAL_STRENGTHS, 'signal_strength');
  const factStatus = normalizeEnum(input.fact_status, FACT_STATUSES, 'fact_status');
  const evidenceId = `evidence:${hashHex({
    schema_version: schemaVersion,
    source_type: sourceType,
    source_ref: sourceRef,
    immutable_ref: immutableRef,
    digest,
  })}`;
  if (input.evidence_id !== undefined && input.evidence_id !== evidenceId) {
    throw new Error('evidence_id does not match its content-bound identity');
  }
  return assertRedactionStable({
    schema_version: schemaVersion,
    evidence_id: evidenceId,
    source_type: sourceType,
    source_ref: sourceRef,
    immutable_ref: immutableRef,
    digest,
    uri,
    final_disposition: finalDisposition,
    captured_at: capturedAt,
    scope,
    redaction_status: redactionStatus,
    assurance,
    signal_strength: signalStrength,
    fact_status: factStatus,
  }, 'EvidenceRef');
}

function verifyEvidenceRef(input) {
  const errors = [];
  try {
    assertExactKeys(input, EVIDENCE_KEYS, 'EvidenceRef');
    normalizeEvidenceRef(input);
  } catch (error) {
    errors.push(error.message);
  }
  return { valid: errors.length === 0, errors };
}

function deriveBehaviorEventIdentity({ project_id: projectId, runtime, source, source_event_id: sourceEventId, event_type: eventType }) {
  if (sourceEventId === null || sourceEventId === undefined || sourceEventId === '') {
    throw new Error('source_event_id is required for stable behavior identity');
  }
  const normalizedSourceId = validateIdentifier(sourceEventId, 'source_event_id');
  const hex = hashHex({
    schema_version: BEHAVIOR_EVENT_SCHEMA_VERSION,
    project_id: projectId,
    runtime,
    source,
    source_event_id: normalizedSourceId,
    event_type: eventType,
  });
  return { event_id: `behavior-event:${hex}`, idempotency_key: `idem:${hex}` };
}

function normalizeEventInput(input, persistedOnly) {
  const constructionKeys = [...EVENT_KEYS, 'input_value', 'output_value'];
  if (persistedOnly) assertExactKeys(input, EVENT_KEYS, 'BehaviorEvent');
  else assertAllowedKeys(input, constructionKeys, 'BehaviorEvent input');
  const schemaVersion = input.schema_version || BEHAVIOR_EVENT_SCHEMA_VERSION;
  if (schemaVersion !== BEHAVIOR_EVENT_SCHEMA_VERSION) {
    throw new Error(`unsupported BehaviorEvent schema_version: ${schemaVersion}`);
  }
  const projectId = normalizeRequiredText(input.project_id, 'project_id', 256);
  const sessionId = normalizeRequiredText(input.session_id, 'session_id', 256);
  const taskRef = input.task_ref === null ? null : normalizeRequiredText(input.task_ref, 'task_ref', 256);
  const turnRef = normalizeNullableIdentifier(input.turn_ref, 'turn_ref');
  const parentEventId = normalizeNullableIdentifier(input.parent_event_id, 'parent_event_id');
  const actor = normalizeActor(input.actor);
  const runtime = normalizeEnum(input.runtime, RUNTIMES, 'runtime');
  const source = normalizeEnum(input.source, SOURCES, 'source');
  const sourceAssurance = normalizeEnum(input.source_assurance, ASSURANCES, 'source_assurance');
  const scope = normalizeScope(input.scope, { projectId, sessionId, taskRef });
  const eventType = normalizeEnum(input.event_type, EVENT_TYPES, 'event_type');
  const signalStrength = normalizeEnum(input.signal_strength, SIGNAL_STRENGTHS, 'signal_strength');
  if (eventType.startsWith('user.') && actor.kind !== 'user') {
    throw new Error(`${eventType} is a user event and requires a user actor`);
  }
  if (['user.feedback', 'user.correction', 'user.approval'].includes(eventType)
      && signalStrength === 'explicit'
      && sourceAssurance !== 'explicit') {
    throw new Error(`explicit ${eventType} requires explicit user source assurance`);
  }
  if (['user.feedback', 'user.correction'].includes(eventType)
      && signalStrength === 'explicit'
      && source !== 'codex_cli') {
    throw new Error(`${source} self-report cannot assert explicit ${eventType}; use the trusted codex_cli entry`);
  }
  const factStatus = normalizeEnum(input.fact_status, FACT_STATUSES, 'fact_status');
  const status = normalizeEnum(input.status, EVENT_STATUSES, 'status');
  const finalDisposition = normalizeEnum(input.final_disposition, FINAL_DISPOSITIONS, 'final_disposition');
  const details = redactDetails(input.details);
  const inputDigest = normalizeDigest(input.input_value, input.input_digest, 'input_digest');
  const outputDigest = normalizeDigest(input.output_value, input.output_digest, 'output_digest');
  const evidenceRefs = normalizeEvidenceIdList(input.evidence_refs);
  const occurredAt = normalizeTimestamp(input.occurred_at, 'occurred_at');
  const sourceEventId = input.source_event_id;
  const identity = deriveBehaviorEventIdentity({
    project_id: projectId, runtime, source, source_event_id: sourceEventId, event_type: eventType,
  });
  if (input.event_id !== undefined && input.event_id !== identity.event_id) {
    throw new Error('event_id does not match stable source identity');
  }
  if (input.idempotency_key !== undefined && input.idempotency_key !== null) {
    if (!IDEMPOTENCY_RE.test(input.idempotency_key) || input.idempotency_key !== identity.idempotency_key) {
      throw new Error('idempotency_key does not match stable source identity');
    }
  }
  return assertRedactionStable({
    schema_version: schemaVersion,
    event_id: identity.event_id,
    source_event_id: validateIdentifier(sourceEventId, 'source_event_id'),
    idempotency_key: identity.idempotency_key,
    project_id: projectId,
    session_id: sessionId,
    task_ref: taskRef,
    turn_ref: turnRef,
    parent_event_id: parentEventId,
    actor,
    runtime,
    source,
    source_assurance: sourceAssurance,
    scope,
    event_type: eventType,
    signal_strength: signalStrength,
    fact_status: factStatus,
    status,
    final_disposition: finalDisposition,
    details,
    input_digest: inputDigest,
    output_digest: outputDigest,
    evidence_refs: evidenceRefs,
    occurred_at: occurredAt,
  }, 'BehaviorEvent');
}

function createBehaviorEvent(input) {
  return normalizeEventInput(input, false);
}
function normalizeBehaviorEvent(input) {
  return normalizeEventInput(input, true);
}
function verifyBehaviorEvent(input) {
  const errors = [];
  try { normalizeBehaviorEvent(input); } catch (error) { errors.push(error.message); }
  return { valid: errors.length === 0, errors };
}

function boundedSummary(value) {
  if (value === undefined || value === null) return null;
  const redacted = redactCanonicalValue(value, 'summary');
  const text = typeof redacted === 'string' ? redacted : canonicalStringify(redacted);
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS) || null;
}
function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}
function explicitStatus(payload) {
  const exitCode = firstDefined(payload.exit_code, payload.exitCode, payload.statusCode);
  if (Number.isInteger(exitCode)) return exitCode === 0 ? 'succeeded' : 'failed';
  if (payload.is_error === true || payload.success === false || payload.ok === false) return 'failed';
  if (payload.is_error === false || payload.success === true || payload.ok === true) return 'succeeded';
  const status = String(payload.status || '').toLowerCase();
  if (EVENT_STATUSES.has(status)) return status;
  if (status === 'success') return 'succeeded';
  if (status === 'error') return 'failed';
  return 'unknown';
}
function claudeSourceId(payload, hookName, context) {
  if (context.source_event_id) return context.source_event_id;
  if (hookName === 'UserPromptSubmit') {
    return firstDefined(payload.prompt_id, payload.promptId, payload.message_id, payload.messageId, payload.turn_id);
  }
  if (hookName === 'PreToolUse' || hookName === 'PostToolUse') {
    return firstDefined(payload.tool_use_id, payload.toolUseId);
  }
  if (hookName === 'Stop') return firstDefined(payload.stop_id, payload.stopId);
  return null;
}
function claudeToolInput(payload) {
  return firstDefined(payload.tool_input, payload.toolInput, payload.input, payload.arguments, payload.args);
}
function claudeToolOutput(payload) {
  return firstDefined(
    payload.tool_response, payload.toolResponse, payload.tool_output, payload.toolOutput,
    payload.output, payload.result, payload.error
  );
}

function adaptClaudeHookEvent(payload, context = {}) {
  assertObject(payload, 'Claude hook payload');
  const hookName = payload.hook_event_name || context.hook_event_name;
  if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(hookName)) {
    throw new Error(`unsupported Claude hook: ${String(hookName)}`);
  }
  const sourceEventId = claudeSourceId(payload, hookName, context);
  if (!sourceEventId) throw new Error(`${hookName} requires a stable source_event_id`);
  const projectId = context.project_id || payload.project_id;
  const sessionId = payload.session_id || payload.sessionId || context.session_id;
  const taskRef = context.task_ref === undefined ? (payload.task_ref || null) : context.task_ref;
  const turnRef = payload.turn_id || payload.turnId || context.turn_ref || null;
  const occurredAt = context.occurred_at || payload.timestamp || payload.occurred_at;
  const base = {
    source_event_id: sourceEventId,
    project_id: projectId,
    session_id: sessionId,
    task_ref: taskRef,
    turn_ref: turnRef,
    runtime: 'claude',
    source: 'claude_hook',
    source_assurance: 'observed',
    scope: taskRef ? { level: 'task', id: taskRef } : { level: 'session', id: sessionId },
    fact_status: 'fact',
    evidence_refs: [],
    occurred_at: occurredAt,
  };
  if (hookName === 'UserPromptSubmit') {
    const prompt = firstDefined(
      payload.prompt, payload.user_prompt, payload.userPrompt, payload.input,
      payload.message, payload.text, payload.content
    );
    return createBehaviorEvent({
      ...base,
      parent_event_id: null,
      actor: { kind: 'user', id: 'user', role: null },
      event_type: 'user.prompt',
      signal_strength: 'explicit',
      status: 'observed',
      final_disposition: 'unknown',
      details: { summary: boundedSummary(prompt) },
      input_value: prompt,
      output_value: null,
    });
  }
  if (hookName === 'PreToolUse' || hookName === 'PostToolUse') {
    const isPost = hookName === 'PostToolUse';
    const toolInput = claudeToolInput(payload);
    const toolOutput = claudeToolOutput(payload);
    const parentEventId = isPost ? deriveBehaviorEventIdentity({
      project_id: projectId,
      runtime: 'claude',
      source: 'claude_hook',
      source_event_id: sourceEventId,
      event_type: 'tool.request',
    }).event_id : null;
    return createBehaviorEvent({
      ...base,
      parent_event_id: parentEventId,
      actor: isPost
        ? { kind: 'tool', id: 'claude-tool', role: null }
        : { kind: 'agent', id: 'claude', role: null },
      event_type: isPost ? 'tool.result' : 'tool.request',
      signal_strength: 'weak',
      status: isPost ? explicitStatus(payload) : 'observed',
      final_disposition: 'unknown',
      details: {
        hook_event_name: hookName,
        tool: boundedSummary(firstDefined(payload.tool_name, payload.toolName, payload.name)) || 'unknown',
        input_summary: boundedSummary(toolInput),
        output_summary: isPost ? boundedSummary(toolOutput) : null,
      },
      input_value: toolInput,
      output_value: isPost ? toolOutput : null,
    });
  }
  return createBehaviorEvent({
    ...base,
    parent_event_id: null,
    actor: { kind: 'runtime', id: 'claude', role: null },
    event_type: 'system.lifecycle',
    signal_strength: 'weak',
    status: 'observed',
    final_disposition: 'unknown',
    details: { hook_event_name: hookName, reason: boundedSummary(payload.reason) },
    input_value: null,
    output_value: null,
  });
}

function adaptExplicitBehaviorEvent(input) {
  assertObject(input, 'explicit behavior input');
  if (!input.source_event_id) throw new Error('explicit behavior input requires source_event_id');
  const taskRef = input.task_ref === undefined ? null : input.task_ref;
  const eventType = input.event_type;
  const source = input.source || (input.runtime === 'codex' ? 'codex_cli' : 'legacy_unverified');
  const explicitUserEvent = typeof eventType === 'string' && eventType.startsWith('user.');
  return createBehaviorEvent({
    source_event_id: input.source_event_id,
    project_id: input.project_id,
    session_id: input.session_id,
    task_ref: taskRef,
    turn_ref: input.turn_ref || null,
    parent_event_id: input.parent_event_id || null,
    actor: input.actor || { kind: 'user', id: 'user', role: null },
    runtime: input.runtime,
    source,
    source_assurance: 'explicit',
    scope: input.scope || (taskRef ? { level: 'task', id: taskRef } : { level: 'session', id: input.session_id }),
    event_type: eventType,
    signal_strength: input.signal_strength || (explicitUserEvent ? 'explicit' : 'weak'),
    fact_status: input.fact_status || 'unknown',
    status: input.status || 'unknown',
    final_disposition: input.final_disposition || 'unknown',
    details: input.details || {},
    input_value: input.input_value,
    output_value: input.output_value,
    input_digest: input.input_digest,
    output_digest: input.output_digest,
    evidence_refs: input.evidence_refs || [],
    occurred_at: input.occurred_at,
  });
}

function managedRuntime(input) {
  const nativeRuntime = input.result && input.result.native && input.result.native.runtime;
  if (nativeRuntime === 'claude' || nativeRuntime === 'codex') return nativeRuntime;
  const refs = input.result && input.result.runtimeRefs || {};
  if (refs.codexThread) return 'codex';
  if (refs.claudeSession) return 'claude';
  throw new Error('managed runtime evidence has no supported runtime identity');
}
function evidenceScope(taskRef) {
  return taskRef ? { level: 'task', id: taskRef } : { level: 'global', id: null };
}
function buildManagedRuntimeEvidenceRefs(input) {
  assertObject(input, 'managed runtime input');
  const task = assertObject(input.task, 'managed task');
  const result = assertObject(input.result, 'managed result');
  const acceptance = assertObject(input.acceptance, 'managed acceptance');
  const capturedAt = normalizeTimestamp(input.occurred_at, 'occurred_at');
  const taskRef = normalizeRequiredText(task.ref, 'task.ref', 256);
  validateHash(task.hash, 'task.hash');
  validateHash(result.hash, 'result.hash');
  const accepted = acceptance.accepted === true
    && result.native && result.native.nativeAccepted === true
    && result.status === 'succeeded';
  const disposition = accepted ? 'accepted' : 'unknown';
  const factStatus = accepted ? 'fact' : 'unknown';
  const acceptanceHash = hashObject(redactCanonicalValue(acceptance, 'acceptance'));
  return [
    normalizeEvidenceRef({
      source_type: 'task_envelope', source_ref: taskRef, immutable_ref: task.hash,
      digest: task.hash, uri: null, final_disposition: 'unknown', captured_at: capturedAt,
      scope: evidenceScope(taskRef), redaction_status: 'passed', assurance: 'verified',
      signal_strength: 'weak', fact_status: 'fact',
    }),
    normalizeEvidenceRef({
      source_type: 'result_envelope', source_ref: normalizeRequiredText(result.ref, 'result.ref', 256),
      immutable_ref: result.hash, digest: result.hash, uri: null,
      final_disposition: disposition, captured_at: capturedAt, scope: evidenceScope(taskRef),
      redaction_status: 'passed', assurance: accepted ? 'verified' : 'observed',
      signal_strength: 'weak', fact_status: factStatus,
    }),
    normalizeEvidenceRef({
      source_type: 'acceptance_receipt', source_ref: `acceptance:${result.ref}`,
      immutable_ref: acceptanceHash, digest: acceptanceHash, uri: null,
      final_disposition: disposition, captured_at: capturedAt, scope: evidenceScope(taskRef),
      redaction_status: 'passed', assurance: accepted ? 'verified' : 'observed',
      signal_strength: 'weak', fact_status: factStatus,
    }),
  ];
}
function assertManagedIdentity(input) {
  const task = assertObject(input.task, 'managed task');
  const result = assertObject(input.result, 'managed result');
  validateIdentifier(task.ref, 'task.ref');
  validateHash(task.hash, 'task.hash');
  if (typeof task.idempotencyKey !== 'string' || !IDEMPOTENCY_RE.test(task.idempotencyKey)) {
    throw new Error('task.idempotencyKey is invalid');
  }
  validateIdentifier(result.ref, 'result.ref');
  validateHash(result.hash, 'result.hash');
  if (typeof result.idempotencyKey !== 'string' || !IDEMPOTENCY_RE.test(result.idempotencyKey)) {
    throw new Error('result.idempotencyKey is invalid');
  }
  if (result.taskRef !== task.ref || result.taskHash !== task.hash
      || result.taskIdempotencyKey !== task.idempotencyKey) {
    throw new Error('managed result task identity mismatch; result does not belong to task');
  }
}
function adaptManagedRuntimeEvent(input) {
  assertManagedIdentity(input);
  const task = input.task;
  const result = input.result;
  const acceptance = assertObject(input.acceptance, 'managed acceptance');
  const runtime = managedRuntime(input);
  const runtimeRefs = result.runtimeRefs || {};
  const sessionId = input.session_id || runtimeRefs.codexThread || runtimeRefs.claudeSession;
  const evidence = buildManagedRuntimeEvidenceRefs(input);
  const accepted = acceptance.accepted === true
    && result.native && result.native.nativeAccepted === true
    && result.status === 'succeeded';
  let disposition = 'unknown';
  if (accepted) disposition = 'accepted';
  else if (result.status === 'failed' || result.status === 'blocked') disposition = 'rejected';
  const factStatus = disposition === 'unknown' ? 'unknown' : 'fact';
  return createBehaviorEvent({
    source_event_id: result.idempotencyKey,
    project_id: input.project_id,
    session_id: sessionId,
    task_ref: task.ref,
    turn_ref: runtimeRefs.codexTurn || null,
    parent_event_id: input.parent_event_id || null,
    actor: { kind: 'agent', id: runtime, role: null },
    runtime,
    source: 'agent_loop',
    source_assurance: 'verified',
    scope: { level: 'task', id: task.ref },
    event_type: 'task.result',
    signal_strength: 'weak',
    fact_status: factStatus,
    status: EVENT_STATUSES.has(result.status) ? result.status : 'unknown',
    final_disposition: disposition,
    details: {
      provider_ref: boundedSummary(result.providerRef),
      effects_state: result.effects && result.effects.state || 'unknown',
      system_accepted: acceptance.accepted === true,
      native_accepted: Boolean(result.native && result.native.nativeAccepted),
      user_approved: false,
      acceptance_error_count: Array.isArray(acceptance.errors) ? acceptance.errors.length : 0,
    },
    input_digest: task.hash,
    output_digest: result.hash,
    evidence_refs: evidence.map((item) => item.evidence_id),
    occurred_at: input.occurred_at,
  });
}

function adaptLegacyObservation(observation, context = {}) {
  assertObject(observation, 'legacy observation');
  if (!context.source_event_id) {
    throw new Error('legacy observation requires an explicit stable source_event_id');
  }
  const projectId = context.project_id || (observation.project && observation.project.id);
  const sessionId = context.session_id || observation.session_id;
  const phase = observation.phase === 'pre' ? 'pre' : 'post';
  return createBehaviorEvent({
    source_event_id: context.source_event_id,
    project_id: projectId,
    session_id: sessionId,
    task_ref: null,
    turn_ref: null,
    parent_event_id: null,
    actor: phase === 'pre'
      ? { kind: 'agent', id: 'legacy-agent', role: null }
      : { kind: 'tool', id: 'legacy-tool', role: null },
    runtime: observation.runtime === 'claude' || observation.runtime === 'codex' ? observation.runtime : 'unknown',
    source: 'legacy_unverified',
    source_assurance: 'legacy_unverified',
    scope: { level: 'session', id: sessionId },
    event_type: phase === 'pre' ? 'tool.request' : 'tool.result',
    signal_strength: 'weak',
    fact_status: 'unknown',
    status: explicitStatus(observation),
    final_disposition: 'unknown',
    details: {
      phase,
      tool: boundedSummary(observation.tool),
      input_summary: boundedSummary(observation.input_summary),
      output_summary: boundedSummary(observation.output_summary),
    },
    input_value: observation.input_summary,
    output_value: observation.output_summary,
    evidence_refs: [],
    occurred_at: observation.timestamp,
  });
}

function trustedUserAuthorityKind(event) {
  if (!event || event.actor.kind !== 'user' || event.signal_strength !== 'explicit') return null;
  if (event.source === 'codex_cli'
      && event.source_assurance === 'explicit'
      && typeof event.event_type === 'string'
      && event.event_type.startsWith('user.')) {
    return 'codex_cli';
  }
  if (event.source === 'claude_hook'
      && event.source_assurance === 'observed'
      && event.event_type === 'user.prompt') {
    return 'claude_prompt';
  }
  return null;
}

function isTrustedUserAuthorityEvent(input, purpose = 'general') {
  const event = input && input.schema_version === BEHAVIOR_EVENT_SCHEMA_VERSION
    ? normalizeBehaviorEvent(input) : createBehaviorEvent(input);
  const authorityKind = trustedUserAuthorityKind(event);
  if (purpose === 'approval') {
    return authorityKind === 'codex_cli' && event.event_type === 'user.approval';
  }
  if (purpose === 'memory') {
    return event.event_type === 'user.prompt'
      && (authorityKind === 'claude_prompt' || authorityKind === 'codex_cli');
  }
  return authorityKind !== null;
}

function journalActorForEvent(input) {
  const event = input && input.schema_version === BEHAVIOR_EVENT_SCHEMA_VERSION
    ? normalizeBehaviorEvent(input) : createBehaviorEvent(input);
  let kind = event.actor.kind;
  if (kind === 'tool') kind = 'hook';
  if (kind === 'runtime') kind = 'system';
  const hasExplicitUserAuthority = isTrustedUserAuthorityEvent(event);
  const hasManagedAuthority = event.source === 'agent_loop'
    && event.source_assurance === 'verified';
  return {
    kind,
    id: event.actor.id,
    runtime: event.runtime,
    authority_ref: hasExplicitUserAuthority || hasManagedAuthority
      ? event.source_event_id
      : null,
  };
}

function journalActorForEvidence(evidenceInput, actorInput) {
  const evidence = normalizeEvidenceRef(evidenceInput);
  const actor = normalizeActor(actorInput);
  let kind = actor.kind;
  if (kind === 'tool') kind = 'hook';
  if (kind === 'runtime') kind = 'system';
  const hasManagedAuthority = evidence.assurance === 'verified'
    && ['task_envelope', 'result_envelope', 'acceptance_receipt'].includes(evidence.source_type);
  return {
    kind,
    id: actor.id,
    runtime: null,
    authority_ref: hasManagedAuthority
      ? evidence.source_ref
      : null,
  };
}

function appendBehaviorEvent(storeDir, input) {
  const { appendRecord } = require('./self-learning-store');
  const event = input && input.schema_version === BEHAVIOR_EVENT_SCHEMA_VERSION
    ? normalizeBehaviorEvent(input) : createBehaviorEvent(input);
  const result = appendRecord(storeDir, {
    record_type: 'behavior_event', record_id: event.event_id, entity_id: event.event_id,
    actor: journalActorForEvent(event), occurred_at: event.occurred_at, payload: event,
  });
  return { ...result, event };
}

function appendEvidenceRef(storeDir, input, options) {
  assertExactKeys(options, ['actor', 'occurred_at'], 'append EvidenceRef options');
  const { appendRecord } = require('./self-learning-store');
  const evidence = normalizeEvidenceRef(input);
  const occurredAt = normalizeTimestamp(options.occurred_at, 'occurred_at');
  const result = appendRecord(storeDir, {
    record_type: 'evidence_ref',
    record_id: evidence.evidence_id,
    entity_id: evidence.evidence_id,
    actor: journalActorForEvidence(evidence, options.actor),
    occurred_at: occurredAt,
    payload: evidence,
  });
  return { ...result, evidence };
}

module.exports = {
  ACTOR_KINDS,
  ASSURANCES,
  BEHAVIOR_EVENT_SCHEMA_VERSION,
  EVIDENCE_REF_SCHEMA_VERSION,
  EVIDENCE_SOURCE_TYPES,
  EVENT_STATUSES,
  EVENT_TYPES,
  FACT_STATUSES,
  FINAL_DISPOSITIONS,
  RUNTIMES,
  SCOPE_LEVELS,
  SIGNAL_STRENGTHS,
  SOURCES,
  adaptClaudeHookEvent,
  adaptExplicitBehaviorEvent,
  adaptLegacyObservation,
  adaptManagedRuntimeEvent,
  appendBehaviorEvent,
  appendEvidenceRef,
  buildManagedRuntimeEvidenceRefs,
  createBehaviorEvent,
  deriveBehaviorEventIdentity,
  journalActorForEvent,
  journalActorForEvidence,
  isTrustedUserAuthorityEvent,
  normalizeBehaviorEvent,
  normalizeEvidenceRef,
  verifyBehaviorEvent,
  verifyEvidenceRef,
};
