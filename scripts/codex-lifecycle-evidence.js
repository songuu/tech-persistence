#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  adaptExplicitBehaviorEvent,
  deriveBehaviorEventIdentity,
  journalActorForEvent,
} = require('./lib/behavior-events');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const {
  assertActionEnabled,
  resolveLearningContext,
} = require('./lib/self-learning-service');
const { normalizeTimestamp } = require('./lib/self-learning-canonical');
const {
  getOrAppendBehaviorEventReceipt,
  LIFECYCLE_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
} = require('./lib/self-learning-store');

const SUPPORTED_EVENTS = Object.freeze([
  'SubagentStart',
  'SubagentStop',
  'PostCompact',
  'SessionEnd',
]);
const SUPPORTED_EVENT_SET = new Set(SUPPORTED_EVENTS);
const EVIDENCE_DIR_NAME = 'native-lifecycle-evidence';
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 256;
const MAX_RUN_DIR_CHARS = 4096;
const MAX_EVIDENCE_FILES = 4096;

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function boundedString(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value
    .slice(0, MAX_FIELD_CHARS)
    .replace(/[\u0000-\u001f\u007f]/g, '?');
}

function addString(target, key, value) {
  const bounded = boundedString(value);
  if (bounded !== null) target[key] = bounded;
}

function serializedSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function buildEvidenceProjection(payload) {
  const event = payload.hook_event_name;
  const refs = {};
  const attributes = {};

  addString(refs, 'sessionId', payload.session_id);
  addString(refs, 'turnId', payload.turn_id);
  addString(attributes, 'model', payload.model);
  addString(attributes, 'permissionMode', payload.permission_mode);

  if (event === 'SubagentStart' || event === 'SubagentStop') {
    addString(refs, 'agentId', payload.agent_id);
    addString(refs, 'agentType', payload.agent_type);
  }
  if (event === 'SubagentStop' && typeof payload.stop_hook_active === 'boolean') {
    attributes.stopHookActive = payload.stop_hook_active;
  }
  if (event === 'PostCompact') addString(attributes, 'trigger', payload.trigger);
  if (event === 'SessionEnd') addString(attributes, 'reason', payload.reason);

  return {
    version: 1,
    kind: 'native-runtime-lifecycle',
    runtime: 'codex',
    event,
    refs,
    attributes,
  };
}

function projectionIdempotencyKey(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(buildEvidenceProjection(payload)))
    .digest('hex');
}

function assertExplicitRunDir(runDir, runsDir = null) {
  if (typeof runDir !== 'string' || runDir.length === 0) {
    throw new Error('explicit runDir must be a non-empty absolute path');
  }
  if (runDir.length > MAX_RUN_DIR_CHARS) {
    throw new Error(`explicit runDir exceeds ${MAX_RUN_DIR_CHARS} characters`);
  }
  if (!path.isAbsolute(runDir)) {
    throw new Error(`explicit runDir must be absolute: ${runDir}`);
  }

  const resolved = path.resolve(runDir);
  let runsRoot;
  if (runsDir === null || runsDir === undefined || runsDir === '') {
    runsRoot = path.dirname(resolved);
    if (path.basename(runsRoot).toLowerCase() !== '.agent-runs') {
      throw new Error(`explicit runDir must be directly under .agent-runs unless runsDir is supplied: ${resolved}`);
    }
  } else {
    if (typeof runsDir !== 'string' || !path.isAbsolute(runsDir)) {
      throw new Error(`explicit runsDir must be an absolute path: ${runsDir}`);
    }
    runsRoot = path.resolve(runsDir);
    if (path.dirname(resolved) !== runsRoot) {
      throw new Error(`explicit runDir must be directly under explicit runsDir: ${resolved}`);
    }
  }

  const rootStat = fs.lstatSync(runsRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`runs root must be a plain directory: ${runsRoot}`);
  }
  const runStat = fs.lstatSync(resolved);
  if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
    throw new Error(`explicit runDir must be a plain directory: ${resolved}`);
  }

  const realRunsRoot = fs.realpathSync.native(runsRoot);
  const realRunDir = fs.realpathSync.native(resolved);
  if (path.dirname(realRunDir) !== realRunsRoot) {
    throw new Error(`explicit runDir resolves outside its runs root: ${resolved}`);
  }
  return { runDir: resolved, realRunDir };
}

function ensureEvidenceDir(run) {
  const evidenceDir = path.join(run.runDir, EVIDENCE_DIR_NAME);
  if (!pathExists(evidenceDir)) {
    try {
      fs.mkdirSync(evidenceDir, { mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
  }
  const stat = fs.lstatSync(evidenceDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`lifecycle evidence target must be a plain directory, not a symbolic link or junction: ${evidenceDir}`);
  }
  const realEvidenceDir = fs.realpathSync.native(evidenceDir);
  if (!pathIsInside(run.realRunDir, realEvidenceDir)) {
    throw new Error(`lifecycle evidence target resolves outside explicit runDir: ${evidenceDir}`);
  }
  return evidenceDir;
}

function countEvidenceFiles(evidenceDir) {
  let count = 0;
  const directory = fs.opendirSync(evidenceDir);
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        count += 1;
        if (count >= MAX_EVIDENCE_FILES) return count;
      }
    }
    return count;
  } finally {
    directory.closeSync();
  }
}

function existingEvidenceIsPlainFile(file) {
  if (!pathExists(file)) return false;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`lifecycle evidence entry must be a plain file: ${file}`);
  }
  return true;
}

function recordLifecycleEvidence(payload, options = {}) {
  if (!options.runDir) return { status: 'noop', reason: 'missing-run-dir' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'noop', reason: 'invalid-payload' };
  }
  if (!SUPPORTED_EVENT_SET.has(payload.hook_event_name)) {
    return { status: 'noop', reason: 'unsupported-event' };
  }
  if (serializedSize(payload) > MAX_INPUT_BYTES) {
    return { status: 'noop', reason: 'payload-too-large' };
  }

  const run = assertExplicitRunDir(options.runDir, options.runsDir);
  const projection = buildEvidenceProjection(payload);
  const idempotencyKey = projectionIdempotencyKey(payload);
  const evidenceDir = ensureEvidenceDir(run);
  const file = path.join(evidenceDir, `${idempotencyKey}.json`);

  if (existingEvidenceIsPlainFile(file)) {
    return { status: 'duplicate', idempotencyKey, file };
  }
  if (countEvidenceFiles(evidenceDir) >= MAX_EVIDENCE_FILES) {
    return { status: 'noop', reason: 'evidence-cap-reached' };
  }

  const evidence = {
    ...projection,
    idempotencyKey,
    recordedAt: options.recordedAt || new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, `${JSON.stringify(evidence)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error && error.code === 'EEXIST' && existingEvidenceIsPlainFile(file)) {
      return { status: 'duplicate', idempotencyKey, file };
    }
    throw error;
  }
  return {
    status: 'recorded',
    idempotencyKey,
    file,
    receiptRecordedAt: evidence.recordedAt,
  };
}

function deriveLifecycleSourceEventId(payload, options = {}) {
  const sourceEventBase = options.sourceEventBase || options.sourceEventId;
  if (typeof sourceEventBase !== 'string' || sourceEventBase.trim() === '') {
    throw new Error('lifecycle source event base is required');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !SUPPORTED_EVENT_SET.has(payload.hook_event_name)) {
    throw new Error('supported lifecycle hook identity is required');
  }
  const evidenceKey = projectionIdempotencyKey(payload);
  const digest = crypto
    .createHash('sha256')
    .update(sourceEventBase)
    .update('\0')
    .update(payload.hook_event_name)
    .update('\0')
    .update(evidenceKey)
    .digest('hex');
  return `codex-lifecycle:${digest}`;
}

function managedIdentityIsPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Validate host-owned identity before either the run receipt or the governed
 * journal can be touched. The run artifact is evidence, so writing it before
 * this check would preserve a payload under the wrong managed session/project.
 */
function validateManagedLifecycleIdentity(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'skipped', reason: 'invalid-payload' };
  }

  if (managedIdentityIsPresent(options.sessionId)) {
    if (typeof options.sessionId !== 'string' || options.sessionId.trim() === '') {
      return { status: 'skipped', reason: 'session-identity-mismatch' };
    }
    if (typeof payload.session_id !== 'string' || payload.session_id.trim() === '') {
      return { status: 'skipped', reason: 'missing-native-session-id' };
    }
    if (payload.session_id !== options.sessionId) {
      return { status: 'skipped', reason: 'session-identity-mismatch' };
    }
  }

  if (managedIdentityIsPresent(options.projectId)) {
    try {
      if (typeof options.projectId !== 'string' || options.projectId.trim() === '') {
        throw new Error('managed project identity is invalid');
      }
      const trustedCwd = path.resolve(options.cwd || process.cwd());
      if (detectStableProjectIdentity(trustedCwd).id !== options.projectId
          || typeof payload.cwd !== 'string'
          || detectStableProjectIdentity(payload.cwd).id !== options.projectId) {
        throw new Error('managed project identity mismatch');
      }
    } catch {
      return { status: 'error', reason: 'project-identity-mismatch' };
    }
  }

  return { status: 'ready' };
}

/**
 * Project one of the actually registered Codex lifecycle hooks into the
 * self-learning journal. This module does not synthesize UserPromptSubmit,
 * PreToolUse, PostToolUse, or Stop records; those current-release events use
 * the separate codex-behavior-hook.js receipt adapter.
 *
 * Every attribution field is explicit. A cwd, timestamp, or run directory is
 * never promoted into a project/task/source identity.
 */
function recordLifecycleBehavior(payload, options = {}) {
  const sourceEventBase = options.sourceEventBase || options.sourceEventId;
  const required = [
    options.baseDir,
    options.projectId,
    options.taskRef,
    sourceEventBase,
  ];
  if (required.some((value) => typeof value !== 'string' || value.trim() === '')) {
    return { status: 'skipped', reason: 'missing-explicit-learning-identity' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'skipped', reason: 'invalid-payload' };
  }
  if (!SUPPORTED_EVENT_SET.has(payload.hook_event_name)) {
    return { status: 'skipped', reason: 'unsupported-event' };
  }
  if (typeof payload.session_id !== 'string' || payload.session_id.trim() === '') {
    return { status: 'skipped', reason: 'missing-native-session-id' };
  }
  const managedIdentity = validateManagedLifecycleIdentity(payload, options);
  if (managedIdentity.status !== 'ready') return managedIdentity;

  try {
    if (!path.isAbsolute(options.baseDir)) {
      throw new Error('explicit self-learning baseDir must be absolute');
    }
    const trustedCwd = path.resolve(options.cwd || process.cwd());
    const projection = buildEvidenceProjection(payload);
    const sourceEventId = deriveLifecycleSourceEventId(payload, {
      sourceEventBase,
    });
    const identity = deriveBehaviorEventIdentity({
      project_id: options.projectId,
      runtime: 'codex',
      source: 'codex_cli',
      source_event_id: sourceEventId,
      event_type: 'system.lifecycle',
    });
    const context = resolveLearningContext({
      base_dir: options.baseDir,
      project_id: options.projectId,
      cwd: trustedCwd,
    }, { require_explicit_base_dir: true });
    assertActionEnabled('record', context);
    let event;
    const buildEvent = (occurredAt) => adaptExplicitBehaviorEvent({
        source_event_id: sourceEventId,
        occurred_at: occurredAt,
        project_id: options.projectId,
        session_id: payload.session_id,
        task_ref: options.taskRef,
        turn_ref: payload.turn_id || null,
        parent_event_id: null,
        actor: { kind: 'runtime', id: 'codex', role: null },
        runtime: 'codex',
        source: 'codex_cli',
        event_type: 'system.lifecycle',
        signal_strength: 'weak',
        status: 'observed',
        final_disposition: 'unknown',
        fact_status: 'fact',
        details: {
          hook_event_name: projection.event,
          refs: projection.refs,
          attributes: projection.attributes,
          lifecycle_evidence_idempotency_key: projectionIdempotencyKey(payload),
        },
        input_value: null,
        output_value: null,
        evidence_refs: [],
      });
    const write = getOrAppendBehaviorEventReceipt(context.store_dir, {
      record_id: identity.event_id,
      ...(options.occurredAt ? { first_occurred_at: options.occurredAt } : {}),
    }, ({ occurred_at: occurredAt, existing }) => {
      if (!existing && !options.occurredAt) {
        const error = new Error('first lifecycle receipt requires trusted in-memory occurrence time');
        error.code = 'SELF_LEARNING_UNTRUSTED_EVIDENCE_RECEIPT';
        throw error;
      }
      event = buildEvent(occurredAt);
      return {
        record_type: 'behavior_event',
        record_id: event.event_id,
        entity_id: event.event_id,
        actor: journalActorForEvent(event),
        occurred_at: event.occurred_at,
        payload: event,
      };
    }, { retry_timeout_ms: LIFECYCLE_RECEIPT_LOCK_RETRY_TIMEOUT_MS });
    return {
      status: write.changed ? 'recorded' : 'duplicate',
      event_id: write.record.record_id,
      record_hash: write.record.record_hash,
    };
  } catch (error) {
    if (error && error.code === 'SELF_LEARNING_WRITER_DISABLED') {
      return { status: 'skipped', reason: 'writer-disabled' };
    }
    if (error && error.code === 'SELF_LEARNING_PROJECT_MISMATCH') {
      return { status: 'error', reason: 'project-identity-mismatch' };
    }
    if (error && error.code === 'SELF_LEARNING_UNTRUSTED_EVIDENCE_RECEIPT') {
      return { status: 'error', reason: 'untrusted-evidence-receipt' };
    }
    return { status: 'error', reason: 'capture-failed' };
  }
}

function currentReceiptOccurrence(result) {
  if (!result || result.status !== 'recorded'
      || typeof result.receiptRecordedAt !== 'string') return null;
  try {
    return normalizeTimestamp(result.receiptRecordedAt, 'lifecycle receipt recordedAt');
  } catch {
    return null;
  }
}

function projectLifecycleBehavior(payload, evidenceResult, options = {}) {
  return recordLifecycleBehavior(payload, {
    ...options,
    // A duplicate on-disk artifact is evidence only, never time/source
    // authority. New receipt time is trusted in-memory; replay time comes
    // exclusively from the append-only journal.
    occurredAt: currentReceiptOccurrence(evidenceResult),
  });
}

function captureManagedLifecycle(payload, options = {}) {
  const identity = validateManagedLifecycleIdentity(payload, options);
  if (identity.status !== 'ready') {
    return {
      ...identity,
      evidence: { status: 'skipped', reason: identity.reason },
      behavior: { ...identity },
    };
  }

  const evidence = recordLifecycleEvidence(payload, {
    runDir: options.runDir,
    runsDir: options.runsDir,
    ...(options.recordedAt ? { recordedAt: options.recordedAt } : {}),
  });
  if (evidence.status !== 'recorded' && evidence.status !== 'duplicate') {
    const reason = evidence.reason || 'evidence-not-recorded';
    return {
      status: 'skipped',
      reason,
      evidence,
      behavior: { status: 'skipped', reason },
    };
  }

  const behavior = projectLifecycleBehavior(payload, evidence, options);
  return {
    status: behavior.status,
    ...(behavior.reason ? { reason: behavior.reason } : {}),
    evidence,
    behavior,
  };
}

function writeLifecycleDiagnostic(reason) {
  const code = String(reason || 'projection-failed')
    .replace(/[^a-z0-9-]/gi, '-')
    .slice(0, 96);
  process.stderr.write(`[codex-lifecycle-evidence] ${code}\n`.slice(0, 160));
}

function readStdinBounded(maxBytes = MAX_INPUT_BYTES) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(4096);
  let total = 0;
  while (true) {
    const read = fs.readSync(0, buffer, 0, buffer.length, null);
    if (read === 0) break;
    total += read;
    if (total > maxBytes) return { oversized: true, text: '' };
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return { oversized: false, text: Buffer.concat(chunks).toString('utf8') };
}

function main() {
  try {
    const input = readStdinBounded();
    if (input.oversized || input.text.trim() === '') return 0;
    let payload;
    try {
      payload = JSON.parse(input.text);
    } catch {
      return 0;
    }
    const capture = captureManagedLifecycle(payload, {
      runDir: process.env.TP_AGENT_RUN_DIR,
      runsDir: process.env.TP_AGENT_RUNS_DIR,
      baseDir: process.env.TP_SELF_LEARNING_BASE_DIR,
      projectId: process.env.TP_SELF_LEARNING_PROJECT_ID,
      sessionId: process.env.TP_SELF_LEARNING_SESSION_ID,
      taskRef: process.env.TP_SELF_LEARNING_TASK_REF,
      sourceEventBase: process.env.TP_SELF_LEARNING_SOURCE_EVENT_BASE
        || process.env.TP_SELF_LEARNING_SOURCE_EVENT_ID,
    });
    if (capture.status === 'error'
        || capture.reason === 'session-identity-mismatch') {
      writeLifecycleDiagnostic(capture.reason);
    }
  } catch (error) {
    // Evidence collection must fail open: lifecycle hooks never steer or block
    // the host runtime. Exception values are excluded because they may contain
    // payload content or absolute paths.
    const code = error && typeof error.code === 'string'
      ? error.code.replace(/[^A-Z0-9_-]/gi, '').slice(0, 64)
      : error && typeof error.name === 'string'
        ? error.name.replace(/[^A-Z0-9_-]/gi, '').slice(0, 64)
        : null;
    process.stderr.write(
      `[codex-lifecycle-evidence] runtime-failed${code ? ` (${code})` : ''}\n`
        .slice(0, 256)
    );
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  EVIDENCE_DIR_NAME,
  MAX_EVIDENCE_FILES,
  MAX_FIELD_CHARS,
  MAX_INPUT_BYTES,
  SUPPORTED_EVENTS,
  buildEvidenceProjection,
  captureManagedLifecycle,
  deriveLifecycleSourceEventId,
  main,
  projectLifecycleBehavior,
  recordLifecycleBehavior,
  recordLifecycleEvidence,
  validateManagedLifecycleIdentity,
};
