#!/usr/bin/env node

/**
 * prompt-submit.js — UserPromptSubmit Hook
 *
 * 在用户每轮 prompt 提交时，按 prompt 内容召回相关 Memory v5 entries / sessions / instincts，
 * 通过 hookSpecificOutput.additionalContext 注入当前轮。
 *
 * 失败模式：
 *   - 开启行为采集时，无法持久入队的 prompt 以结构化决策阻止并提示重试
 *   - 显式关闭行为采集时，prompt 不因采集失败被阻止
 *   - 已成功入队后的记忆检索失败只影响召回，不撤销 prompt
 *   - 匹配低于阈值 → 不输出
 *   - env TECH_PERSISTENCE_DISABLE_PROMPT_RECALL=1 → 跳过记忆召回
 *   - 自指防护：不输出已经在 prompt 中包含的 verbatim 内容
 *
 * Hook 不写 legacy observations，避免 prompt-recall 制造自指；但会把原始
 * UserPromptSubmit 事实双写为统一 BehaviorEvent。该写入不消费 recall 输出。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { resolveBaseDir } = require('./lib/runtime-paths');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const {
  adaptClaudeHookEvent,
} = require('./lib/behavior-events');
const {
  parseAcceptanceConfirmationControl,
} = require('./lib/acceptance-user-confirmation-control');
const { hashObject } = require('./lib/self-learning-canonical');
const { loadSelfLearningPolicy } = require('./lib/self-learning-service');
const { getOrAppendPromptReceipt, resolveStoreDir } = require('./lib/self-learning-store');
const { resolvePromptTranscriptBinding } = require('./lib/prompt-transcript-binding');
const { enqueuePromptReceipt, hasPromptReceiptWorkerFailure } = require('./lib/prompt-receipt-outbox');
const { startPromptReceiptWorker } = require('./lib/prompt-receipt-worker');

const DEFAULT_TIMEOUT_MS = 1500;
const MIN_PROMPT_LENGTH = 8;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const RECALL_TOTAL_BUDGET_MS = 2500;
const RECALL_WORKER_MAX_MS = 1200;
const MAX_RECALL_OUTPUT_BYTES = 16 * 1024;

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

function promptSourceEventId(payload) {
  const value = payload && (
    payload.prompt_id
    || payload.promptId
    || payload.message_id
    || payload.messageId
    || payload.turn_id
  );
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
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

function receiptError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function promptSessionId(payload, options = {}) {
  const payloadSession = payload.session_id || payload.sessionId || null;
  const env = options.env || process.env;
  const trustedSession = options.sessionId || env.CLAUDE_SESSION_ID || null;
  if (payloadSession && trustedSession && payloadSession !== trustedSession) {
    throw receiptError('SELF_LEARNING_SESSION_MISMATCH', 'hook session identity mismatch');
  }
  const sessionId = trustedSession || payloadSession;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) return null;
  return sessionId;
}

function promptTranscriptPath(payload) {
  return payload && (payload.transcript_path || payload.transcriptPath || null);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

/**
 * Read only a bounded transcript tail through an fd, then re-check both fd
 * and path identity. Transcript bytes and paths are never returned or logged.
 */
function snapshotTrustedTranscript(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw receiptError('SELF_LEARNING_TRANSCRIPT_UNSAFE', 'trusted transcript path is required');
  }
  const resolved = path.resolve(candidate);
  let beforePath;
  let descriptor;
  try {
    const parent = path.dirname(resolved);
    const root = path.parse(parent).root;
    let current = root;
    for (const segment of parent.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const parentStat = fs.lstatSync(current);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw receiptError('SELF_LEARNING_TRANSCRIPT_UNSAFE', 'trusted transcript parent must be a plain directory');
      }
    }
    beforePath = fs.lstatSync(resolved);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1) {
      throw receiptError('SELF_LEARNING_TRANSCRIPT_UNSAFE', 'trusted transcript must be an unlinked regular file');
    }
    descriptor = fs.openSync(resolved, 'r');
    const beforeFd = fs.fstatSync(descriptor);
    if (!beforeFd.isFile() || beforeFd.nlink !== 1 || !sameFileIdentity(beforePath, beforeFd)) {
      throw receiptError('SELF_LEARNING_TRANSCRIPT_UNSAFE', 'trusted transcript identity changed before read');
    }
    const length = Math.min(beforeFd.size, MAX_TRANSCRIPT_TAIL_BYTES);
    const tail = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const bytes = fs.readSync(
        descriptor,
        tail,
        read,
        length - read,
        beforeFd.size - length + read
      );
      if (bytes === 0) break;
      read += bytes;
    }
    if (read !== length) {
      throw receiptError('SELF_LEARNING_TRANSCRIPT_UNSAFE', 'trusted transcript tail read was incomplete');
    }
    const afterFd = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(resolved);
    if (!afterPath.isFile()
        || afterPath.isSymbolicLink()
        || afterPath.nlink !== 1
        || !sameFileIdentity(beforeFd, afterFd)
        || !sameFileIdentity(afterFd, afterPath)) {
      throw receiptError('SELF_LEARNING_TRANSCRIPT_UNSAFE', 'trusted transcript identity changed during read');
    }
    const normalizedPath = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    return {
      transcript_ref: hashObject({
        schema_version: 'claude-transcript-ref-v1',
        normalized_path: normalizedPath,
        file_identity: {
          dev: afterFd.dev,
          ino: afterFd.ino,
          birthtime_ms: afterFd.birthtimeMs,
        },
      }),
      cursor_ref: hashObject({
        schema_version: 'claude-transcript-cursor-v1',
        size: afterFd.size,
        tail_digest: `sha256:${crypto.createHash('sha256').update(tail).digest('hex')}`,
      }),
    };
  } catch (error) {
    if (error && error.code === 'SELF_LEARNING_TRANSCRIPT_UNSAFE') throw error;
    if (error && error.code === 'ENOENT' && !beforePath) {
      throw receiptError('SELF_LEARNING_TRANSCRIPT_MISSING', 'trusted transcript does not yet exist');
    }
    throw receiptError('SELF_LEARNING_TRANSCRIPT_UNSAFE', 'trusted transcript could not be read safely');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function promptReceiptSpec(payload, projectId, sessionId, storeDir) {
  const nativeSourceId = promptSourceEventId(payload);
  const transcriptPath = promptTranscriptPath(payload);
  let transcript;
  if (transcriptPath) {
    transcript = resolvePromptTranscriptBinding({
      storeDir,
      projectId,
      sessionId,
      transcriptPath,
      nativePromptId: nativeSourceId,
      inspectTranscript: () => snapshotTrustedTranscript(transcriptPath),
    });
  } else if (nativeSourceId) {
    // Older/native test hosts may provide a stable prompt id without a
    // transcript path. This compatibility path remains idempotent but is not
    // used to invent identity when the native id is absent.
    transcript = {
      transcript_ref: hashObject({
        schema_version: 'claude-native-prompt-stream-v1', project_id: projectId, session_id: sessionId,
      }),
      cursor_ref: null,
    };
  } else {
    throw receiptError('SELF_LEARNING_TRANSCRIPT_UNSAFE', 'prompt receipt lacks a safe transcript cursor');
  }
  return {
    project_id: projectId,
    session_id: sessionId,
    transcript_ref: transcript.transcript_ref,
    replay_ref: nativeSourceId
      ? hashObject({ schema_version: 'claude-native-prompt-replay-v1', source_event_id: nativeSourceId })
      : transcript.cursor_ref,
  };
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
      `[prompt-submit:self-learning] ${safeReason}${errorType ? ` (${errorType})` : ''}\n`
        .slice(0, 256)
    );
  } catch {}
}

function isLegacyReaderEnabled(baseDir) {
  try {
    return loadSelfLearningPolicy(baseDir).legacy_reader_enabled === true;
  } catch {
    return false;
  }
}

/** Persist a sanitized native event before allowing the slow journal work to run. */
function enqueuePromptBehavior(payload, options = {}) {
  let baseDir;
  try {
    baseDir = resolveLearningBaseDir(options.baseDir);
    const policy = loadSelfLearningPolicy(baseDir);
    if (!policy.enabled || !policy.writer_enabled || policy.mode === 'off') {
      return { status: 'skipped', reason: 'writer-disabled' };
    }
  } catch (error) {
    learningDiagnostic('invalid-policy', error, options);
    return { status: 'error', reason: 'invalid-policy' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { status: 'skipped', reason: 'invalid-payload' };
  if (payload.hook_event_name && payload.hook_event_name !== 'UserPromptSubmit') return { status: 'skipped', reason: 'unsupported-hook-event' };
  const prompt = extractPrompt(payload);
  if (!prompt) return { status: 'skipped', reason: 'missing-prompt' };
  const control = parseAcceptanceConfirmationControl(prompt);
  if (control.status === 'invalid') return { status: 'skipped', reason: control.reason };
  try {
    const sessionId = promptSessionId(payload, options);
    if (!sessionId) return { status: 'skipped', reason: 'missing-session-id' };
    const { project } = resolveHookProject(payload, options);
    const receiptSpec = promptReceiptSpec(payload, project.id, sessionId, resolveStoreDir(baseDir, project.id));
    // Identity and time are assigned by the journal during replay, not by this
    // temporary draft. Stable placeholders make duplicate queue comparison safe.
    const eventDraft = adaptClaudeHookEvent({ ...payload, hook_event_name: 'UserPromptSubmit' }, {
      project_id: project.id,
      session_id: sessionId,
      source_event_id: hashObject(receiptSpec),
      task_ref: options.taskRef || (options.env || process.env).TP_SELF_LEARNING_TASK_REF || null,
      occurred_at: '2000-01-01T00:00:00.000Z',
    });
    const outboxDir = path.join(resolveStoreDir(baseDir, project.id), 'prompt-outbox');
    let result;
    try {
      result = enqueuePromptReceipt(outboxDir, { receipt_spec: receiptSpec, event_draft: eventDraft });
    } catch (error) {
      if (error && error.code === 'PROMPT_OUTBOX_FULL') {
        try { (options.workerLauncher || startPromptReceiptWorker)(baseDir, project.id); } catch {}
      }
      throw error;
    }
    let notice = null;
    try {
      if (hasPromptReceiptWorkerFailure(outboxDir)) {
        learningDiagnostic('previous-worker-failed', null, options);
        notice = 'A previous prompt event could not be processed; queued events are retained for retry.';
      }
    } catch (error) {
      learningDiagnostic('worker-status-unavailable', error, options);
      notice = 'The prompt event queue status could not be checked.';
    }
    const launch = options.workerLauncher || startPromptReceiptWorker;
    let launched;
    try { launched = launch(baseDir, project.id); } catch { launched = { status: 'failed' }; }
    if (!launched || launched.status === 'failed') {
      learningDiagnostic('worker-start-failed', null, options);
      notice = 'The prompt event worker could not start; queued events are retained for retry.';
    }
    return notice ? { ...result, notice } : result;
  } catch (error) {
    if (error && error.code === 'PROMPT_OUTBOX_FULL') {
      learningDiagnostic('capture-queue-full', error, options);
      return { status: 'error', reason: 'capture-queue-full' };
    }
    if (error && error.code === 'SELF_LEARNING_RECOVERY_UNAVAILABLE') {
      learningDiagnostic('local-recovery-unavailable', error, options);
      return { status: 'error', reason: 'local-recovery-unavailable' };
    }
    if (error && error.code === 'SELF_LEARNING_CONFIG_INVALID') return { status: 'skipped', reason: 'invalid-policy' };
    if (error && error.code === 'SELF_LEARNING_PROJECT_MISMATCH') {
      learningDiagnostic('project-identity-mismatch', error, options);
      return { status: 'error', reason: 'project-identity-mismatch' };
    }
    if (error && error.code === 'SELF_LEARNING_SESSION_MISMATCH') {
      learningDiagnostic('session-identity-mismatch', error, options);
      return { status: 'error', reason: 'session-identity-mismatch' };
    }
    if (error && error.code === 'SELF_LEARNING_TRANSCRIPT_UNSAFE') {
      learningDiagnostic('transcript-receipt-needs-review', error, options);
      return {
        status: 'skipped',
        reason: 'untrusted-transcript',
        notice: 'The prompt transcript could not be safely verified; this event was not queued.',
      };
    }
    learningDiagnostic('capture-queue-failed', error, options);
    return { status: 'error', reason: 'capture-queue-failed' };
  }
}

/**
 * Append a Claude UserPromptSubmit event to the authoritative journal.
 *
 * Native prompt ids are preferred. Older official payloads without one use a
 * bounded trusted-transcript cursor. Prompt text and wall-clock time are never
 * used as idempotency keys.
 */
function capturePromptBehavior(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'skipped', reason: 'invalid-payload' };
  }
  if (payload.hook_event_name && payload.hook_event_name !== 'UserPromptSubmit') {
    return { status: 'skipped', reason: 'unsupported-hook-event' };
  }
  const prompt = extractPrompt(payload);
  if (!prompt) return { status: 'skipped', reason: 'missing-prompt' };
  const promptControl = parseAcceptanceConfirmationControl(prompt);
  if (promptControl.status === 'invalid') {
    return { status: 'skipped', reason: promptControl.reason };
  }
  let sessionId;
  try {
    sessionId = promptSessionId(payload, options);
  } catch (error) {
    learningDiagnostic('session-identity-mismatch', error, options);
    return { status: 'error', reason: 'session-identity-mismatch' };
  }
  if (!sessionId) {
    return { status: 'skipped', reason: 'missing-session-id' };
  }
  try {
    const baseDir = resolveLearningBaseDir(options.baseDir);
    const { project } = resolveHookProject(payload, options);
    const policy = loadSelfLearningPolicy(baseDir);
    if (!policy.enabled || !policy.writer_enabled || policy.mode === 'off') {
      return { status: 'skipped', reason: 'writer-disabled' };
    }
    const receiptSpec = promptReceiptSpec(payload, project.id, sessionId, resolveStoreDir(baseDir, project.id));
    const write = getOrAppendPromptReceipt(
      resolveStoreDir(baseDir, project.id),
      receiptSpec,
      ({ source_event_id: sourceEventId, occurred_at: occurredAt, receipt }) => {
        const event = adaptClaudeHookEvent({
          ...payload,
          hook_event_name: 'UserPromptSubmit',
        }, {
          project_id: project.id,
          session_id: sessionId,
          source_event_id: sourceEventId,
          task_ref: options.taskRef || (options.env || process.env).TP_SELF_LEARNING_TASK_REF || null,
          occurred_at: occurredAt,
        });
        event.details = { ...event.details, prompt_receipt: receipt };
        return {
          record_type: 'behavior_event',
          record_id: event.event_id,
          entity_id: event.event_id,
          actor: {
            kind: 'user', id: event.actor.id, runtime: 'claude', authority_ref: sourceEventId,
          },
          occurred_at: occurredAt,
          payload: event,
        };
      }
    );
    return {
      status: write.changed ? 'recorded' : 'duplicate',
      event_id: write.record.payload.event_id,
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
    if (error && error.code === 'SELF_LEARNING_TRANSCRIPT_UNSAFE') {
      learningDiagnostic('transcript-receipt-needs-review', error, options);
      return { status: 'skipped', reason: 'untrusted-transcript' };
    }
    learningDiagnostic('capture-failed', error, options);
    return { status: 'error', reason: 'capture-failed' };
  }
}

function readStdinSync(timeoutMs) {
  try {
    const fd = 0;
    const chunks = [];
    const buf = Buffer.alloc(8192);
    let total = 0;
    const start = Date.now();
    while (true) {
      if (Date.now() - start > timeoutMs) break;
      let bytes;
      try {
        bytes = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (err) {
        if (err.code === 'EAGAIN') continue;
        break;
      }
      if (bytes === 0) break;
      total += bytes;
      if (total > MAX_STDIN_BYTES) {
        return { status: 'too-large', raw: '' };
      }
      chunks.push(Buffer.from(buf.slice(0, bytes)));
    }
    return { status: 'ok', raw: Buffer.concat(chunks).toString('utf-8') };
  } catch {
    return { status: 'error', raw: '' };
  }
}

function extractPrompt(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.input,
    payload.message,
    payload.text,
    payload.content,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function extractTouchedFiles(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.touched_files,
    payload.touchedFiles,
    payload.files,
    payload.context_files,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value.filter((item) => typeof item === 'string');
    }
  }
  return [];
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function emitHookOutput(notice, context) {
  if (!notice && !context) return;
  const output = {};
  if (notice) output.systemMessage = notice;
  if (context) output.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: context };
  const encoded = safeStringify(output);
  if (encoded) process.stdout.write(encoded);
}

function emitPromptBlock(reason) {
  const output = {
    decision: 'block',
    reason,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
  };
  process.stdout.write(JSON.stringify(output));
}

function promptWriterRequired() {
  try {
    const policy = loadSelfLearningPolicy(resolveLearningBaseDir());
    return Boolean(policy.enabled && policy.writer_enabled && policy.mode !== 'off');
  } catch {
    // Invalid or unavailable policy is not evidence that the user disabled capture.
    return true;
  }
}

function blockUncapturedPrompt(reason) {
  if (promptWriterRequired()) emitPromptBlock(reason);
}

function wrapperElapsedBeforeHook() {
  const raw = process.env.TP_PROMPT_HOOK_STARTED_AT_MS;
  if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) return 0;
  const wrapperStart = Number(raw);
  const now = Date.now();
  if (!Number.isSafeInteger(wrapperStart) || wrapperStart < 1 || wrapperStart > now) return 0;
  const hookStart = now - process.uptime() * 1000;
  // A caller-supplied value can only shorten the budget, never extend it.
  return Math.max(0, hookStart - wrapperStart);
}

function boundedPromptRecall(payload, wrapperElapsedMs) {
  const remaining = Math.floor(RECALL_TOTAL_BUDGET_MS - (process.uptime() * 1000 + wrapperElapsedMs));
  if (remaining <= 0) return null;
  try {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'lib', 'prompt-recall-worker.js')], {
      input: JSON.stringify({ prompt: extractPrompt(payload), touchedFiles: extractTouchedFiles(payload) }),
      encoding: 'utf8',
      timeout: Math.min(remaining, RECALL_WORKER_MAX_MS),
      maxBuffer: MAX_RECALL_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
    });
    if (child.error || child.signal || child.status !== 0) {
      learningDiagnostic('legacy-recall-failed', child.error, { diagnostic: true });
      return null;
    }
    if (!child.stdout) return null;
    const output = JSON.parse(child.stdout);
    if (!output || typeof output.context !== 'string' || output.context.length > 4096) return null;
    return output.context;
  } catch (error) {
    learningDiagnostic('legacy-recall-failed', error, { diagnostic: true });
    return null;
  }
}

function main() {
  const wrapperElapsedMs = wrapperElapsedBeforeHook();
  const input = readStdinSync(DEFAULT_TIMEOUT_MS);
  if (input.status === 'too-large') {
    learningDiagnostic(
      'hook-payload-too-large',
      { code: 'SELF_LEARNING_INPUT_TOO_LARGE' },
      { diagnostic: true }
    );
    return blockUncapturedPrompt('The prompt event was too large to record safely. Please retry with a shorter message.');
  }
  const raw = input.raw;
  if (!raw.trim()) {
    return blockUncapturedPrompt('The prompt event could not be read safely. Please retry.');
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return blockUncapturedPrompt('The prompt event could not be parsed safely. Please retry.');
  }

  // Recall and capture have separate controls. Disabling recall must not erase
  // an otherwise valid native behavior event.
  const capture = enqueuePromptBehavior(payload, {
    diagnostic: true,
    taskRef: process.env.TP_SELF_LEARNING_TASK_REF || null,
  });
  const captured = capture.status === 'queued' || capture.status === 'duplicate';
  const intentionallyDisabled = capture.status === 'skipped' && capture.reason === 'writer-disabled';
  if (!captured && !intentionallyDisabled) {
    const reason = capture.reason === 'capture-queue-full'
      ? 'The prompt event queue is full. Please wait for recovery and retry.'
      : capture.reason === 'local-recovery-unavailable'
        ? 'Confirm this is a device-local store on a Windows fixed volume with Node built-in node:sqlite available and enabled, set TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT on this device, then retry.'
      : capture.reason === 'untrusted-transcript'
        ? 'The prompt transcript could not be safely verified. Please retry.'
        : 'The prompt event could not be recorded safely. Please check the runtime and retry.';
    return emitPromptBlock(reason);
  }
  const notice = capture.notice || (capture.reason === 'capture-queue-full'
    ? 'The prompt event queue is full; this event was not queued and existing events are retained.'
    : capture.reason === 'capture-queue-failed'
      ? 'The prompt event could not be queued; check the self-learning runtime.'
      : null);
  if (capture.reason === 'invalid-policy') {
    learningDiagnostic('invalid-policy', { code: 'SELF_LEARNING_CONFIG_INVALID' }, {
      diagnostic: true,
    });
    return emitHookOutput(notice);
  }
  if (capture.reason === 'project-identity-mismatch') {
    return emitHookOutput(notice);
  }
  let baseDir;
  let policy;
  try {
    baseDir = resolveLearningBaseDir();
    policy = loadSelfLearningPolicy(baseDir);
  } catch (error) {
    learningDiagnostic(
      error && error.code === 'SELF_LEARNING_CONFIG_INVALID'
        ? 'invalid-policy'
        : 'runtime-config-failed',
      error,
      { diagnostic: true }
    );
    return emitHookOutput(notice);
  }
  if (process.env.TECH_PERSISTENCE_DISABLE_PROMPT_RECALL === '1'
      || policy.legacy_reader_enabled !== true) {
    return emitHookOutput(notice);
  }

  const prompt = extractPrompt(payload);
  if (!prompt || prompt.length < MIN_PROMPT_LENGTH) {
    return emitHookOutput(notice);
  }

  emitHookOutput(notice, boundedPromptRecall(payload, wrapperElapsedMs));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    learningDiagnostic('runtime-failed', error, { diagnostic: true });
    blockUncapturedPrompt('The prompt event could not be recorded safely. Please check the runtime and retry.');
  }
  process.exitCode = 0;
}

module.exports = {
  capturePromptBehavior,
  enqueuePromptBehavior,
  extractPrompt,
  extractTouchedFiles,
  isLegacyReaderEnabled,
  main,
};
