#!/usr/bin/env node
'use strict';

/**
 * Current Codex release hook adapter for governed behavior capture.
 *
 * This entry point deliberately accepts only fields documented for the
 * UserPromptSubmit, PreToolUse, PostToolUse, and Stop release contracts. Native
 * turn_id/tool_use_id values own replay identity; payload time and Claude-only
 * aliases never do. UserPromptSubmit receipt identity is fixed to native
 * session + turn + hook; prompt/control semantics can only replay or conflict.
 * Hook failures remain fail-open for the Codex turn.
 */

const fs = require('fs');
const path = require('path');

const { resolveBaseDir } = require('./lib/runtime-paths');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const {
  assertExactKeys,
  canonicalStringify,
  hashObject,
  redactCanonicalValue,
  validateHash,
  validateIdentifier,
} = require('./lib/self-learning-canonical');
const {
  createBehaviorEvent,
  deriveBehaviorEventIdentity,
  journalActorForEvent,
} = require('./lib/behavior-events');
const { normalizeBehaviorEpisode } = require('./lib/behavior-episodes');
const {
  buildCandidateProjection,
} = require('./lib/learning-candidates');
const {
  executeLearningAction,
  loadSelfLearningPolicy,
} = require('./lib/self-learning-service');
const {
  TOOL_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
  getOrAppendBehaviorEventReceipt,
  readJournal,
  resolveStoreDir,
} = require('./lib/self-learning-store');

const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const MAX_CONTROL_INPUT_BYTES = 4096;
const MAX_SUMMARY_CHARS = 1200;
const CODEX_CONTROL_PREFIX = 'TP_SELF_LEARNING_CONTROL_V1:';
const CANDIDATE_ID_PATTERN = /^lc-[a-f0-9]{32}$/;
const SUPPORTED_EVENTS = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
]);
const PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
]);

function resolveLearningBaseDir(explicit = null, env = process.env) {
  const managed = explicit || env.TP_SELF_LEARNING_BASE_DIR;
  if (!managed) return resolveBaseDir();
  if (typeof managed !== 'string' || !path.isAbsolute(managed)) {
    const error = new Error('managed self-learning base directory must be absolute');
    error.code = 'SELF_LEARNING_BASE_DIR_INVALID';
    throw error;
  }
  return path.resolve(managed);
}

function authorityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function optionalManagedIdentity(value, label) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return validateIdentifier(value, label);
  } catch {
    throw authorityError('SELF_LEARNING_AUTHORITY_INVALID', `${label} is invalid`);
  }
}

function requiredNativeIdentity(value, label, missingReason) {
  if (value === undefined || value === null || value === '') {
    return { status: 'skipped', reason: missingReason };
  }
  try {
    return { status: 'ready', value: validateIdentifier(value, label) };
  } catch {
    return { status: 'skipped', reason: `invalid-${missingReason.slice('missing-'.length)}` };
  }
}

function validateReleasePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'skipped', reason: 'invalid-payload' };
  }
  if (!SUPPORTED_EVENTS.has(payload.hook_event_name)) {
    return { status: 'skipped', reason: 'unsupported-hook-event' };
  }
  if (typeof payload.cwd !== 'string' || !path.isAbsolute(payload.cwd)) {
    return { status: 'skipped', reason: 'missing-cwd' };
  }
  if (typeof payload.model !== 'string' || !payload.model.trim()) {
    return { status: 'skipped', reason: 'missing-model' };
  }
  if (!PERMISSION_MODES.has(payload.permission_mode)) {
    return { status: 'skipped', reason: 'invalid-permission-mode' };
  }
  if (payload.transcript_path !== null
      && (typeof payload.transcript_path !== 'string'
        || !path.isAbsolute(payload.transcript_path))) {
    return { status: 'skipped', reason: 'invalid-transcript-path' };
  }

  const session = requiredNativeIdentity(payload.session_id, 'Codex session_id', 'missing-session-id');
  if (session.status !== 'ready') return session;
  const turn = requiredNativeIdentity(payload.turn_id, 'Codex turn_id', 'missing-turn-id');
  if (turn.status !== 'ready') return turn;

  if (payload.hook_event_name === 'UserPromptSubmit'
      && (typeof payload.prompt !== 'string' || !payload.prompt.trim())) {
    return { status: 'skipped', reason: 'missing-prompt' };
  }
  if (payload.hook_event_name === 'PreToolUse'
      || payload.hook_event_name === 'PostToolUse') {
    const toolUse = requiredNativeIdentity(
      payload.tool_use_id,
      'Codex tool_use_id',
      'missing-tool-use-id'
    );
    if (toolUse.status !== 'ready') return toolUse;
    if (typeof payload.tool_name !== 'string' || !payload.tool_name.trim()) {
      return { status: 'skipped', reason: 'missing-tool-name' };
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'tool_input')) {
      return { status: 'skipped', reason: 'missing-tool-input' };
    }
    if (payload.hook_event_name === 'PostToolUse'
        && !Object.prototype.hasOwnProperty.call(payload, 'tool_response')) {
      return { status: 'skipped', reason: 'missing-tool-response' };
    }
    return {
      status: 'ready',
      sessionId: session.value,
      turnId: turn.value,
      toolUseId: toolUse.value,
    };
  }
  if (payload.hook_event_name === 'Stop') {
    if (typeof payload.stop_hook_active !== 'boolean') {
      return { status: 'skipped', reason: 'missing-stop-hook-active' };
    }
    if (typeof payload.last_assistant_message !== 'string') {
      return { status: 'skipped', reason: 'missing-last-assistant-message' };
    }
  }
  return { status: 'ready', sessionId: session.value, turnId: turn.value };
}

function resolveCodexAuthority(payload, options = {}) {
  const validated = validateReleasePayload(payload);
  if (validated.status !== 'ready') return validated;
  const env = options.env || process.env;
  const trustedCwd = path.resolve(options.cwd || process.cwd());
  const trustedProject = detectStableProjectIdentity(trustedCwd);
  const payloadProject = detectStableProjectIdentity(payload.cwd);
  if (payloadProject.id !== trustedProject.id) {
    throw authorityError('SELF_LEARNING_PROJECT_MISMATCH', 'Codex payload cwd project mismatch');
  }

  const managedProjectId = optionalManagedIdentity(
    options.projectId || env.TP_SELF_LEARNING_PROJECT_ID,
    'managed project id'
  );
  if (managedProjectId && managedProjectId !== trustedProject.id) {
    throw authorityError('SELF_LEARNING_PROJECT_MISMATCH', 'managed project identity mismatch');
  }
  const explicitSession = optionalManagedIdentity(options.sessionId, 'managed session id');
  const environmentSession = optionalManagedIdentity(env.CODEX_SESSION_ID, 'CODEX_SESSION_ID');
  if (explicitSession && environmentSession && explicitSession !== environmentSession) {
    throw authorityError('SELF_LEARNING_SESSION_MISMATCH', 'managed session identities conflict');
  }
  const managedSession = explicitSession || environmentSession;
  if (managedSession && managedSession !== validated.sessionId) {
    throw authorityError('SELF_LEARNING_SESSION_MISMATCH', 'Codex session identity mismatch');
  }

  const explicitTask = optionalManagedIdentity(options.taskRef, 'managed task ref');
  const environmentTask = optionalManagedIdentity(
    env.TP_SELF_LEARNING_TASK_REF,
    'TP_SELF_LEARNING_TASK_REF'
  );
  if (explicitTask && environmentTask && explicitTask !== environmentTask) {
    throw authorityError('SELF_LEARNING_TASK_MISMATCH', 'managed task identities conflict');
  }

  return {
    status: 'ready',
    project: trustedProject,
    projectId: managedProjectId || trustedProject.id,
    sessionId: managedSession || validated.sessionId,
    taskRef: explicitTask || environmentTask,
    turnId: validated.turnId,
    toolUseId: validated.toolUseId || null,
    trustedCwd,
  };
}

function boundedSummary(value) {
  if (value === undefined || value === null) return null;
  const redacted = redactCanonicalValue(value, 'Codex hook summary');
  const text = typeof redacted === 'string' ? redacted : canonicalStringify(redacted);
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS) || null;
}

function invalidControl(reason) {
  return { status: 'invalid', reason };
}

function isBoundedControlSummary(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SUMMARY_CHARS
    && value.trim() === value;
}

function isBoundedRememberBody(value) {
  return isBoundedControlSummary(value) && !/[\r\n]/.test(value);
}

/**
 * Parse an explicit user control without natural-language interpretation.
 * Requiring the canonical JSON bytes makes duplicate keys, alternate key order,
 * trailing prose, and invisible whitespace fail closed under one simple rule.
 */
function parseCodexControlEnvelope(prompt) {
  if (typeof prompt !== 'string' || !prompt.startsWith(CODEX_CONTROL_PREFIX)) {
    return { status: 'ordinary' };
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_CONTROL_INPUT_BYTES) {
    return invalidControl('control-envelope-too-large');
  }
  const encoded = prompt.slice(CODEX_CONTROL_PREFIX.length);
  let semantic;
  try {
    semantic = JSON.parse(encoded);
  } catch {
    return invalidControl('control-json-invalid');
  }
  try {
    if (canonicalStringify(semantic) !== encoded) {
      return invalidControl('control-json-noncanonical');
    }
  } catch {
    return invalidControl('control-json-invalid');
  }

  try {
    if (semantic.action === 'approve') {
      assertExactKeys(
        semantic,
        ['accepted', 'action', 'candidate_hash', 'candidate_id'],
        'approval control'
      );
      if (semantic.accepted !== true
          || !CANDIDATE_ID_PATTERN.test(semantic.candidate_id)) {
        return invalidControl('control-shape-invalid');
      }
      validateHash(semantic.candidate_hash, 'approval control candidate_hash');
      return {
        status: 'control',
        event_type: 'user.approval',
        final_disposition: 'accepted',
        details: { ...semantic },
        semantic: { ...semantic },
      };
    }
    if (semantic.action === 'feedback') {
      assertExactKeys(semantic, ['accepted', 'action', 'summary'], 'feedback control');
      if (typeof semantic.accepted !== 'boolean' || !isBoundedControlSummary(semantic.summary)) {
        return invalidControl('control-shape-invalid');
      }
      return {
        status: 'control',
        event_type: 'user.feedback',
        final_disposition: semantic.accepted ? 'accepted' : 'rejected',
        details: { ...semantic },
        semantic: { ...semantic },
      };
    }
    if (semantic.action === 'correct') {
      assertExactKeys(semantic, ['action', 'summary'], 'correction control');
      if (!isBoundedControlSummary(semantic.summary)) {
        return invalidControl('control-shape-invalid');
      }
      return {
        status: 'control',
        event_type: 'user.correction',
        final_disposition: 'unknown',
        details: { ...semantic },
        semantic: { ...semantic },
      };
    }
    if (semantic.action === 'remember') {
      assertExactKeys(semantic, ['action', 'body'], 'remember control');
      if (!isBoundedRememberBody(semantic.body)) {
        return invalidControl('control-shape-invalid');
      }
      return {
        status: 'control',
        event_type: 'user.prompt',
        final_disposition: 'accepted',
        details: { ...semantic },
        semantic: { ...semantic },
      };
    }
  } catch {
    return invalidControl('control-shape-invalid');
  }
  return invalidControl('control-action-invalid');
}

function promptSourceEventId(sessionId, turnId) {
  const receiptDigest = hashObject({
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    turn_id: turnId,
  });
  return `codex-prompt:${receiptDigest.slice('sha256:'.length)}`;
}

function eventTypeForHook(eventName, promptControl = null) {
  if (eventName === 'UserPromptSubmit') {
    return promptControl && promptControl.status === 'control'
      ? promptControl.event_type
      : 'user.prompt';
  }
  if (eventName === 'PreToolUse') return 'tool.request';
  if (eventName === 'PostToolUse') return 'tool.result';
  return 'system.lifecycle';
}

function sourceEventIdForHook(payload, authority) {
  return payload.hook_event_name === 'PreToolUse'
    || payload.hook_event_name === 'PostToolUse'
    ? authority.toolUseId
    : payload.hook_event_name === 'UserPromptSubmit'
      ? promptSourceEventId(authority.sessionId, authority.turnId)
      : authority.turnId;
}

function buildCodexBehaviorEvent(payload, authority, occurredAt, promptControl = null) {
  const eventName = payload.hook_event_name;
  const eventType = eventTypeForHook(eventName, promptControl);
  const sourceEventId = sourceEventIdForHook(payload, authority);
  const scope = authority.taskRef
    ? { level: 'task', id: authority.taskRef }
    : { level: 'session', id: authority.sessionId };
  const common = {
    source_event_id: sourceEventId,
    project_id: authority.projectId,
    session_id: authority.sessionId,
    task_ref: authority.taskRef || null,
    turn_ref: authority.turnId,
    runtime: 'codex',
    source: 'codex_cli',
    scope,
    event_type: eventType,
    fact_status: 'fact',
    final_disposition: 'unknown',
    evidence_refs: [],
    occurred_at: occurredAt,
  };

  if (eventName === 'UserPromptSubmit') {
    if (promptControl && promptControl.status === 'control') {
      return createBehaviorEvent({
        ...common,
        parent_event_id: null,
        actor: { kind: 'user', id: 'user', role: null },
        source_assurance: 'explicit',
        signal_strength: 'explicit',
        fact_status: 'fact',
        status: 'observed',
        final_disposition: promptControl.final_disposition,
        details: promptControl.details,
        input_value: promptControl.semantic,
        output_value: null,
      });
    }
    return createBehaviorEvent({
      ...common,
      parent_event_id: null,
      actor: { kind: 'user', id: 'user', role: null },
      source_assurance: 'explicit',
      signal_strength: 'explicit',
      status: 'observed',
      details: {
        hook_event_name: eventName,
        model: boundedSummary(payload.model),
        permission_mode: payload.permission_mode,
        prompt_summary: boundedSummary(payload.prompt),
      },
      input_value: payload.prompt,
      output_value: null,
    });
  }

  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    const isPost = eventName === 'PostToolUse';
    const parentEventId = isPost ? deriveBehaviorEventIdentity({
      project_id: authority.projectId,
      runtime: 'codex',
      source: 'codex_cli',
      source_event_id: authority.toolUseId,
      event_type: 'tool.request',
    }).event_id : null;
    return createBehaviorEvent({
      ...common,
      parent_event_id: parentEventId,
      actor: isPost
        ? { kind: 'tool', id: 'codex-tool', role: null }
        : { kind: 'agent', id: 'codex', role: null },
      source_assurance: 'observed',
      signal_strength: 'weak',
      // tool_response is a documented JSON value, but its inner status fields
      // are tool-specific. Never infer success from PostToolUse firing.
      status: isPost ? 'unknown' : 'observed',
      details: {
        hook_event_name: eventName,
        model: boundedSummary(payload.model),
        permission_mode: payload.permission_mode,
        tool: boundedSummary(payload.tool_name),
        input_summary: boundedSummary(payload.tool_input),
        output_summary: isPost ? boundedSummary(payload.tool_response) : null,
      },
      input_value: payload.tool_input,
      output_value: isPost ? payload.tool_response : null,
    });
  }

  return createBehaviorEvent({
    ...common,
    parent_event_id: null,
    actor: { kind: 'runtime', id: 'codex', role: null },
    source_assurance: 'observed',
    signal_strength: 'weak',
    status: 'unknown',
    details: {
      hook_event_name: eventName,
      model: boundedSummary(payload.model),
      permission_mode: payload.permission_mode,
      stop_hook_active: payload.stop_hook_active === true,
      last_assistant_summary: boundedSummary(payload.last_assistant_message),
    },
    input_value: null,
    output_value: null,
  });
}

function approvalControlMatchesLiveShadow(promptControl, journal, projectId = null) {
  if (!promptControl || promptControl.event_type !== 'user.approval') return true;
  const projection = buildCandidateProjection(journal);
  const current = projection.candidates.find(
    (candidate) => candidate.candidate_id === promptControl.semantic.candidate_id
  );
  return Boolean(current
    && (!projectId || current.project_id === projectId)
    && current.candidate_hash === promptControl.semantic.candidate_hash
    && current.status === 'shadow'
    && current.effective_status === 'shadow');
}

function promptReceiptRecord(journal, authority, sourceEventId) {
  const matches = journal.records.filter((record) => (
    record.record_type === 'behavior_event'
    && record.payload
    && record.payload.project_id === authority.projectId
    && record.payload.session_id === authority.sessionId
    && record.payload.turn_ref === authority.turnId
    && record.payload.runtime === 'codex'
    && record.payload.source === 'codex_cli'
    && record.payload.source_event_id === sourceEventId
  ));
  if (matches.length > 1) {
    throw authorityError(
      'SELF_LEARNING_CORRUPT',
      `Codex UserPromptSubmit receipt is duplicated for ${sourceEventId}`
    );
  }
  return matches[0] || null;
}

function assertPromptReceiptIdentity(journal, authority, sourceEventId, existing) {
  const receiptRecord = promptReceiptRecord(journal, authority, sourceEventId);
  if (receiptRecord && (!existing || receiptRecord.record_id !== existing.record_id)) {
    throw authorityError(
      'SELF_LEARNING_ID_CONFLICT',
      `Codex UserPromptSubmit receipt identity conflict for ${sourceEventId}`
    );
  }
}

function hasEpisodeContaining(storeDir, authority, eventId) {
  return readJournal(storeDir).records.some((record) => {
    if (record.record_type !== 'behavior_episode') return false;
    const episode = normalizeBehaviorEpisode(record.payload);
    return episode.project_id === authority.projectId
      && episode.session_id === authority.sessionId
      && episode.task_ref === authority.taskRef
      && episode.event_refs.some((ref) => ref.event_id === eventId);
  });
}

function closeManagedStopEpisode(context) {
  if (!context.authority.taskRef) {
    return { status: 'skipped', reason: 'session-unassigned' };
  }
  if (hasEpisodeContaining(context.storeDir, context.authority, context.stopEvent.event_id)) {
    return { status: 'duplicate' };
  }
  const close = () => executeLearningAction('close', {
    base_dir: context.baseDir,
    project_id: context.authority.projectId,
    cwd: context.authority.trustedCwd,
    input: {
      session_id: context.authority.sessionId,
      task_ref: context.authority.taskRef,
      created_at: context.stopEvent.occurred_at,
      actor: {
        kind: 'system',
        id: 'codex-stop',
        runtime: 'codex',
        authority_ref: null,
      },
    },
  }, { require_explicit_base_dir: true });
  try {
    const response = close();
    return {
      status: response.result.episode.status,
      episode_id: response.result.episode.episode_id,
      revision: response.result.episode.revision,
    };
  } catch (error) {
    if (['SELF_LEARNING_HASH_CONFLICT', 'SELF_LEARNING_ID_CONFLICT'].includes(error && error.code)
        && hasEpisodeContaining(context.storeDir, context.authority, context.stopEvent.event_id)) {
      return { status: 'duplicate' };
    }
    return {
      status: 'needs_review',
      reason: 'episode-close-failed',
      ...(error && typeof error.code === 'string' ? { error_code: error.code } : {}),
    };
  }
}

function captureCodexBehavior(payload, options = {}) {
  let authority;
  try {
    authority = resolveCodexAuthority(payload, options);
  } catch (error) {
    if (error && error.code === 'SELF_LEARNING_PROJECT_MISMATCH') {
      return { status: 'error', reason: 'project-identity-mismatch' };
    }
    if (error && error.code === 'SELF_LEARNING_SESSION_MISMATCH') {
      return { status: 'error', reason: 'session-identity-mismatch' };
    }
    if (error && error.code === 'SELF_LEARNING_TASK_MISMATCH') {
      return { status: 'error', reason: 'task-identity-mismatch' };
    }
    return { status: 'error', reason: 'authority-invalid' };
  }
  if (authority.status !== 'ready') return authority;

  let baseDir;
  try {
    baseDir = resolveLearningBaseDir(options.baseDir, options.env || process.env);
    const policy = loadSelfLearningPolicy(baseDir);
    if (!policy.enabled || !policy.writer_enabled || policy.mode === 'off') {
      return { status: 'skipped', reason: 'writer-disabled' };
    }
  } catch (error) {
    if (error && error.code === 'SELF_LEARNING_CONFIG_INVALID') {
      return { status: 'skipped', reason: 'invalid-policy' };
    }
    return { status: 'error', reason: 'runtime-config-failed' };
  }

  let storeDir;
  try {
    storeDir = resolveStoreDir(baseDir, authority.projectId);
  } catch {
    return { status: 'error', reason: 'capture-failed' };
  }

  let promptControl = null;
  if (payload.hook_event_name === 'UserPromptSubmit') {
    const parsed = parseCodexControlEnvelope(payload.prompt);
    if (parsed.status === 'invalid') {
      return { status: 'skipped', reason: parsed.reason };
    }
    if (parsed.status === 'control') promptControl = parsed;
  }

  const eventType = eventTypeForHook(payload.hook_event_name, promptControl);
  const sourceEventId = sourceEventIdForHook(payload, authority);
  const identity = deriveBehaviorEventIdentity({
    project_id: authority.projectId,
    runtime: 'codex',
    source: 'codex_cli',
    source_event_id: sourceEventId,
    event_type: eventType,
  });
  const receipt = { record_id: identity.event_id };
  if (options.occurredAt !== undefined) receipt.first_occurred_at = options.occurredAt;
  let write;
  try {
    if (typeof options.beforeReceiptAppend === 'function') options.beforeReceiptAppend();
    write = getOrAppendBehaviorEventReceipt(
      storeDir,
      receipt,
      ({ occurred_at: occurredAt, existing, journal }) => {
        if (payload.hook_event_name === 'UserPromptSubmit') {
          assertPromptReceiptIdentity(journal, authority, sourceEventId, existing);
        }
        if (!existing
            && promptControl
            && promptControl.event_type === 'user.approval'
            && !approvalControlMatchesLiveShadow(promptControl, journal, authority.projectId)) {
          throw authorityError(
            'SELF_LEARNING_CONTROL_AUTHORITY_INVALID',
            'approval control does not match the live shadow candidate'
          );
        }
        const event = buildCodexBehaviorEvent(payload, authority, occurredAt, promptControl);
        return {
          record_type: 'behavior_event',
          record_id: event.event_id,
          entity_id: event.event_id,
          actor: journalActorForEvent(event),
          occurred_at: event.occurred_at,
          payload: event,
        };
      },
      { retry_timeout_ms: TOOL_RECEIPT_LOCK_RETRY_TIMEOUT_MS }
    );
  } catch (error) {
    if (error && error.code === 'SELF_LEARNING_ID_CONFLICT') {
      return { status: 'error', reason: 'identity-conflict' };
    }
    if (error && error.code === 'SELF_LEARNING_CONTROL_AUTHORITY_INVALID') {
      return { status: 'skipped', reason: 'control-authority-invalid' };
    }
    if (error && error.code === 'SELF_LEARNING_WRITER_DISABLED') {
      return { status: 'skipped', reason: 'writer-disabled' };
    }
    return { status: 'error', reason: 'capture-failed' };
  }

  const result = {
    status: write.changed ? 'recorded' : 'duplicate',
    event_id: write.record.payload.event_id,
    record_hash: write.record.record_hash,
  };
  if (payload.hook_event_name === 'Stop') {
    try {
      result.episode = closeManagedStopEpisode({
        authority,
        baseDir,
        storeDir,
        stopEvent: write.record.payload,
      });
    } catch (error) {
      result.episode = {
        status: 'needs_review',
        reason: 'episode-close-failed',
        ...(error && typeof error.code === 'string' ? { error_code: error.code } : {}),
      };
    }
  }
  return result;
}

function readHookInputBounded(maximumBytes = MAX_HOOK_INPUT_BYTES) {
  try {
    const chunks = [];
    const buffer = Buffer.allocUnsafe(4096);
    let total = 0;
    while (true) {
      const read = fs.readSync(0, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > maximumBytes) return { ok: true, oversized: true, text: '' };
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    return { ok: true, oversized: false, text: Buffer.concat(chunks).toString('utf8') };
  } catch {
    return { ok: false, oversized: false, text: '' };
  }
}

function writeDiagnostic(reason) {
  const safe = String(reason || 'runtime-error')
    .replace(/[^a-z0-9-]/gi, '-')
    .slice(0, 96);
  try { process.stderr.write(`[codex-behavior-hook] ${safe}\n`.slice(0, 160)); } catch {}
}

function main(options = {}) {
  const input = options.input === undefined
    ? readHookInputBounded()
    : {
        ok: true,
        oversized: Buffer.byteLength(String(options.input), 'utf8') > MAX_HOOK_INPUT_BYTES,
        text: String(options.input),
      };
  if (!input.ok || input.oversized || !input.text.trim()) {
    if (input.oversized) writeDiagnostic('hook-payload-too-large');
    return { status: 'skipped', reason: input.oversized ? 'hook-payload-too-large' : 'missing-payload' };
  }
  let payload;
  try {
    payload = JSON.parse(input.text);
  } catch {
    return { status: 'skipped', reason: 'invalid-json' };
  }
  const result = captureCodexBehavior(payload, options);
  if (result.status === 'error'
      || (typeof result.reason === 'string' && result.reason.startsWith('control-'))) {
    writeDiagnostic(result.reason);
  }
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch {
    writeDiagnostic('runtime-failed');
  }
  process.exitCode = 0;
}

module.exports = {
  CODEX_CONTROL_PREFIX,
  MAX_CONTROL_INPUT_BYTES,
  MAX_HOOK_INPUT_BYTES,
  SUPPORTED_EVENTS,
  approvalControlMatchesLiveShadow,
  buildCodexBehaviorEvent,
  captureCodexBehavior,
  main,
  parseCodexControlEnvelope,
  promptSourceEventId,
  readHookInputBounded,
  resolveCodexAuthority,
  validateReleasePayload,
};
