#!/usr/bin/env node

/**
 * observe.js — PreToolUse / PostToolUse 观察 Hook
 *
 * 灵感来源：
 *   - ECC continuous-learning-v2: 100% 确定性 Hook 捕获
 *   - Claude-Mem: PostToolUse 观察 + 异步压缩
 *
 * 工作原理：
 *   1. Hook 触发时保留脱敏后的 legacy observations.jsonl
 *   2. 有原生 tool_use_id 时同步双写统一 BehaviorEvent journal
 *   3. 任一学习侧故障都不得阻塞 Claude Code；legacy evaluator 继续兼容运行
 *
 * 使用方式（在 settings.json 中配置）：
 *   "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <path>/observe.js pre" }] }]
 *   "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <path>/observe.js post" }] }]
 */

const fs = require('fs');
const path = require('path');
const { resolveBaseDir, resolveSessionId } = require('./lib/runtime-paths');
const { MEMORY_VERSION, detectProjectIdentity, normalizeHookPayload } = require('./lib/memory-v5');
const { redactObservation, stripPrivateTags } = require('./lib/redaction');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const {
  adaptClaudeHookEvent,
  deriveBehaviorEventIdentity,
  journalActorForEvent,
} = require('./lib/behavior-events');
const {
  assertActionEnabled,
  loadSelfLearningPolicy,
  resolveLearningContext,
} = require('./lib/self-learning-service');
const {
  getOrAppendBehaviorEventReceipt,
  TOOL_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
} = require('./lib/self-learning-store');

const MAX_HOOK_INPUT_BYTES = 64 * 1024;

function resolveLearningBaseDir(explicit = null) {
  const managed = explicit || process.env.TP_SELF_LEARNING_BASE_DIR;
  if (!managed) return resolveBaseDir();
  if (typeof managed !== 'string' || !path.isAbsolute(managed)) {
    const error = new Error('managed self-learning base directory must be absolute');
    error.code = 'SELF_LEARNING_BASE_DIR_INVALID';
    throw error;
  }
  return path.resolve(managed);
}

// ─── 存储路径 ───
function getObservationPath(project, homunculusDir = resolveBaseDir()) {
  // 项目级观察
  const projectDir = path.join(homunculusDir, 'projects', project.id);
  fs.mkdirSync(projectDir, { recursive: true });
  return path.join(projectDir, 'observations.jsonl');
}

function toolSourceEventId(payload) {
  return payload && (payload.tool_use_id || payload.toolUseId);
}

function projectMismatch() {
  const error = new Error('hook project identity mismatch');
  error.code = 'SELF_LEARNING_PROJECT_MISMATCH';
  return error;
}

function resolveHookProject(payload, options = {}) {
  const env = options.env || process.env;
  const trustedCwd = path.resolve(options.cwd || process.cwd());
  const injectedProject = options.project && options.project.id ? options.project : null;
  const managedProjectId = options.projectId || env.TP_SELF_LEARNING_PROJECT_ID || null;
  if (managedProjectId && injectedProject && managedProjectId !== injectedProject.id) {
    throw projectMismatch();
  }
  let project = injectedProject || detectStableProjectIdentity(trustedCwd);
  if (managedProjectId) {
    const trustedProject = detectStableProjectIdentity(trustedCwd);
    if (trustedProject.id !== managedProjectId) throw projectMismatch();
    project = { ...trustedProject, id: managedProjectId };
  }
  if (payload.cwd !== undefined) {
    if (typeof payload.cwd !== 'string'
        || detectStableProjectIdentity(payload.cwd).id !== project.id) {
      throw projectMismatch();
    }
  }
  const payloadProjectIds = [payload.project_id, payload.projectId]
    .filter((value) => value !== undefined);
  if (payloadProjectIds.some((value) => typeof value !== 'string' || value !== project.id)) {
    throw projectMismatch();
  }
  return { project, trustedCwd };
}

function sessionMismatch() {
  const error = new Error('hook session identity mismatch');
  error.code = 'SELF_LEARNING_SESSION_MISMATCH';
  return error;
}

function resolveHookSession(payload, options = {}) {
  const payloadSessions = [payload && payload.session_id, payload && payload.sessionId]
    .filter((value) => value !== undefined && value !== null);
  if (payloadSessions.some((value) => typeof value !== 'string' || value.trim() === '')
      || new Set(payloadSessions).size > 1) {
    throw sessionMismatch();
  }
  const env = options.env || process.env;
  const trustedSessions = [options.sessionId, env.CLAUDE_SESSION_ID]
    .filter((value) => value !== undefined && value !== null && value !== '');
  if (trustedSessions.some((value) => typeof value !== 'string' || value.trim() === '')
      || new Set(trustedSessions).size > 1) {
    throw sessionMismatch();
  }
  const payloadSession = payloadSessions[0] || null;
  const trustedSession = trustedSessions[0] || null;
  if (payloadSession && trustedSession && payloadSession !== trustedSession) {
    throw sessionMismatch();
  }
  const sessionId = trustedSession || payloadSession;
  if (!sessionId || sessionId.length > 256) return null;
  return sessionId;
}

function learningDiagnostic(reason, error, options = {}) {
  const enabled = options.diagnostic === true
    || options.debug === true
    || process.env.TECH_PERSISTENCE_SELF_LEARNING_DEBUG === '1';
  if (!enabled) return;
  const safeReason = String(reason || 'runtime-error')
    .replace(/[^a-z0-9-]/gi, '-')
    .slice(0, 96);
  const errorType = error && typeof error.code === 'string'
    ? String(error.code).replace(/[^a-z0-9_-]/gi, '').slice(0, 64)
    : error && error.name
      ? String(error.name).replace(/[^a-z0-9_-]/gi, '').slice(0, 64)
      : null;
  try {
    process.stderr.write(
      `[observe:self-learning] ${safeReason}${errorType ? ` (${errorType})` : ''}\n`
        .slice(0, 256)
    );
  } catch {}
}

/**
 * Project a native Claude tool hook into the unified append-only journal.
 * The hook phase determines the registered event name, but never supplies a
 * substitute tool_use_id. Missing native identity remains explicitly skipped.
 */
function captureToolBehavior(payload, phase, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'skipped', reason: 'invalid-payload' };
  }
  if (!['pre', 'post'].includes(phase)) {
    return { status: 'skipped', reason: 'unsupported-phase' };
  }
  const hookEventName = phase === 'pre' ? 'PreToolUse' : 'PostToolUse';
  if (payload.hook_event_name && payload.hook_event_name !== hookEventName) {
    return { status: 'skipped', reason: 'hook-phase-mismatch' };
  }
  if (!toolSourceEventId(payload)) {
    return { status: 'skipped', reason: 'missing-source-event-id' };
  }
  let sessionId;
  try {
    sessionId = resolveHookSession(payload, options);
  } catch (error) {
    learningDiagnostic('session-identity-mismatch', error, options);
    return { status: 'error', reason: 'session-identity-mismatch' };
  }
  if (!sessionId) {
    return { status: 'skipped', reason: 'missing-session-id' };
  }
  try {
    const baseDir = resolveLearningBaseDir(options.baseDir);
    const { project, trustedCwd } = resolveHookProject(payload, options);
    const sourceEventId = toolSourceEventId(payload);
    const eventType = phase === 'pre' ? 'tool.request' : 'tool.result';
    const identity = deriveBehaviorEventIdentity({
      project_id: project.id,
      runtime: 'claude',
      source: 'claude_hook',
      source_event_id: sourceEventId,
      event_type: eventType,
    });
    const context = resolveLearningContext({
      base_dir: baseDir,
      project_id: project.id,
      cwd: trustedCwd,
    }, { require_explicit_base_dir: true });
    assertActionEnabled('record', context);
    let event;
    const buildEvent = (occurredAt) => adaptClaudeHookEvent({
        ...payload,
        session_id: sessionId,
        hook_event_name: hookEventName,
      }, {
        project_id: project.id,
        session_id: sessionId,
        task_ref: options.taskRef || (options.env || process.env).TP_SELF_LEARNING_TASK_REF || null,
        // Official Claude tool hook payloads have no timestamp. Receipt time
        // is authoritative only for the first append; journal time owns replay.
        occurred_at: occurredAt,
      });
    const write = getOrAppendBehaviorEventReceipt(context.store_dir, {
      record_id: identity.event_id,
      ...(options.occurredAt ? { first_occurred_at: options.occurredAt } : {}),
    }, ({ occurred_at: occurredAt }) => {
      event = buildEvent(occurredAt);
      return {
        record_type: 'behavior_event',
        record_id: event.event_id,
        entity_id: event.event_id,
        actor: journalActorForEvent(event),
        occurred_at: event.occurred_at,
        payload: event,
      };
    }, { retry_timeout_ms: TOOL_RECEIPT_LOCK_RETRY_TIMEOUT_MS });
    return {
      status: write.changed ? 'recorded' : 'duplicate',
      event_id: write.record.record_id,
      record_hash: write.record.record_hash,
    };
  } catch (error) {
    if (error && error.code === 'SELF_LEARNING_WRITER_DISABLED') {
      return { status: 'skipped', reason: 'writer-disabled' };
    }
    if (error && error.code === 'SELF_LEARNING_CONFIG_INVALID') {
      return { status: 'skipped', reason: 'invalid-policy' };
    }
    if (error && error.code === 'SELF_LEARNING_PROJECT_MISMATCH') {
      learningDiagnostic('project-identity-mismatch', error, options);
      return { status: 'error', reason: 'project-identity-mismatch' };
    }
    if (error && error.code === 'SELF_LEARNING_SESSION_MISMATCH') {
      learningDiagnostic('session-identity-mismatch', error, options);
      return { status: 'error', reason: 'session-identity-mismatch' };
    }
    learningDiagnostic('capture-failed', error, options);
    return { status: 'error', reason: 'capture-failed' };
  }
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
    return {
      ok: true,
      oversized: false,
      text: Buffer.concat(chunks).toString('utf8'),
    };
  } catch {
    return { ok: false, oversized: false, text: '' };
  }
}

// ─── 主逻辑 ───
function main(options = {}) {
  const phase = options.phase || process.argv[2] || 'post'; // pre | post
  const inputResult = options.input === undefined
    ? readHookInputBounded()
    : {
        ok: true,
        oversized: Buffer.byteLength(String(options.input), 'utf8') > MAX_HOOK_INPUT_BYTES,
        text: String(options.input),
      };
  if (!inputResult.ok) {
    return {
      legacy: { status: 'error', reason: 'capture-input-read-failed' },
      self_learning: { status: 'error', reason: 'capture-input-read-failed' },
    };
  }
  if (inputResult.oversized) {
    return {
      legacy: { status: 'error', reason: 'hook-payload-too-large' },
      self_learning: { status: 'error', reason: 'hook-payload-too-large' },
    };
  }
  const input = inputResult.text;
  if (!input.trim()) {
    return {
      legacy: { status: 'skipped', reason: 'missing-payload' },
      self_learning: { status: 'skipped', reason: 'missing-payload' },
    };
  }
  const sanitizedInput = stripPrivateTags(input);
  const normalized = normalizeHookPayload(sanitizedInput, phase);
  let hookPayload = null;
  try {
    const parsed = JSON.parse(sanitizedInput);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) hookPayload = parsed;
  } catch {}

  let hookSessionId = null;
  if (hookPayload) {
    try {
      hookSessionId = resolveHookSession(hookPayload, options);
    } catch (error) {
      learningDiagnostic('session-identity-mismatch', error, options);
      return {
        legacy: { status: 'error', reason: 'session-identity-mismatch' },
        self_learning: { status: 'error', reason: 'session-identity-mismatch' },
      };
    }
  }

  let baseDir;
  let learningPolicy;
  let policyError = false;
  try {
    baseDir = resolveLearningBaseDir(options.baseDir);
    learningPolicy = loadSelfLearningPolicy(baseDir);
  } catch {
    baseDir = options.baseDir || null;
    learningPolicy = null;
    policyError = true;
  }

  if (policyError) {
    return {
      legacy: { status: 'skipped', reason: 'invalid-policy' },
      self_learning: { status: 'skipped', reason: 'invalid-policy' },
    };
  }

  let hookAuthority = null;
  if (hookPayload) {
    try {
      hookAuthority = resolveHookProject(hookPayload, {
        cwd: options.cwd,
        project: options.project,
        projectId: options.projectId,
        env: options.env,
      });
    } catch (error) {
      if (error && error.code === 'SELF_LEARNING_PROJECT_MISMATCH') {
        return {
          legacy: { status: 'error', reason: 'project-identity-mismatch' },
          self_learning: { status: 'error', reason: 'project-identity-mismatch' },
        };
      }
      return {
        legacy: { status: 'error', reason: 'runtime-project-identity-failed' },
        self_learning: { status: 'error', reason: 'runtime-project-identity-failed' },
      };
    }
  }

  let project;
  let obsPath;
  try {
    if (!learningPolicy || learningPolicy.legacy_writer_enabled !== true) throw new Error('disabled');
    project = detectProjectIdentity(
      hookAuthority ? hookAuthority.trustedCwd : options.cwd || process.cwd()
    );
    obsPath = getObservationPath(project, baseDir);
  } catch {
    project = null;
    obsPath = null;
  }

  const observation = redactObservation({
    schema_version: MEMORY_VERSION,
    timestamp: options.observedAt || new Date().toISOString(),
    phase, // pre | post
    session_id: hookSessionId
      || resolveSessionId(),
    project: project,
    runtime: process.env.TECH_PERSISTENCE_RUNTIME || 'auto',
    tool: normalized.tool,
    input_summary: normalized.input_summary,
    output_summary: phase === 'post' ? normalized.output_summary : undefined,
    input_paths: normalized.input_paths,
    command: normalized.command || undefined,
    command_family: normalized.command_family || undefined,
    status: normalized.status,
    error_signal: normalized.error_signal,
    payload_format: normalized.payload_format,
    payload_keys: normalized.payload_keys,
    cwd: options.cwd || process.cwd(),
  });

  let legacy = {
    status: 'skipped',
    reason: policyError
      ? 'invalid-policy'
      : learningPolicy && learningPolicy.legacy_writer_enabled === false
        ? 'legacy-writer-disabled'
        : 'legacy-path-unavailable',
  };
  if (obsPath) {
    // 追加写入 JSONL（fire-and-forget，不阻塞）
    try {
      fs.appendFileSync(obsPath, JSON.stringify(observation) + '\n');
      legacy = { status: 'recorded', file: obsPath };
    } catch {
      legacy = { status: 'error', reason: 'legacy-write-failed' };
    }
  }

  // 限制文件大小：超过 10MB 时归档
  if (obsPath) {
    try {
      const stats = fs.statSync(obsPath);
      if (stats.size > 10 * 1024 * 1024) {
        const archiveDir = path.join(path.dirname(obsPath), 'archive');
        fs.mkdirSync(archiveDir, { recursive: true });
        const archiveName = `observations-${Date.now()}.jsonl`;
        fs.renameSync(obsPath, path.join(archiveDir, archiveName));
      }
    } catch {}
  }

  const selfLearning = hookPayload
    ? captureToolBehavior(hookPayload, phase, {
        baseDir,
        cwd: hookAuthority ? hookAuthority.trustedCwd : options.cwd,
        occurredAt: options.occurredAt,
        project: hookAuthority ? hookAuthority.project : options.project,
        projectId: options.projectId,
        env: options.env,
        sessionId: hookSessionId,
        taskRef: options.taskRef || process.env.TP_SELF_LEARNING_TASK_REF || null,
        debug: options.debug,
        diagnostic: options.diagnostic,
      })
    : { status: 'skipped', reason: 'invalid-payload' };
  return { legacy, self_learning: selfLearning };
}

if (require.main === module) {
  try {
    const result = main({ diagnostic: true });
    const reasons = new Set([
      result && result.legacy && result.legacy.reason,
      result && result.self_learning && result.self_learning.reason,
    ]);
    for (const reason of reasons) {
      if ([
        'invalid-policy',
        'legacy-write-failed',
        'capture-input-read-failed',
        'hook-payload-too-large',
        'project-identity-mismatch',
        'session-identity-mismatch',
      ].includes(reason)) {
        learningDiagnostic(reason, reason === 'invalid-policy'
          ? { code: 'SELF_LEARNING_CONFIG_INVALID' }
          : null, { diagnostic: true });
      }
    }
  } catch (error) {
    learningDiagnostic('runtime-failed', error, { diagnostic: true });
  }
  process.exitCode = 0;
}

module.exports = {
  MAX_HOOK_INPUT_BYTES,
  captureToolBehavior,
  getObservationPath,
  main,
  readHookInputBounded,
  resolveHookSession,
};
