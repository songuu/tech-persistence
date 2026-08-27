'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  canonicalStringify,
  redactCanonicalValue,
} = require('./self-learning-canonical');

const POSITION_KIND_ORDINAL = 'ordinal';
const POSITION_KIND_LINE = 'line';
const PROJECTION_VERSION = 'codex-transcript-projection-v1';
const REDACTION_VERSION = 'tech-persistence-redaction-v1';
const INTERNAL_OMISSION = '[INTERNAL CONTENT OMITTED]';
const MAX_STORED_STRING_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const DEFAULT_BATCH_BYTES = 4 * 1024 * 1024;
const DEFAULT_BATCH_EVENTS = 100;
const MAX_SESSION_ID_BYTES = 256;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const INTERNAL_KEYS = new Set([
  'base_instructions',
  'developer_instructions',
  'developer_prompt',
  'encrypted_content',
  'instructions',
  'system_instructions',
  'system_prompt',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uuid(value, label, options = {}) {
  if (options.nullable === true && (value === null || value === undefined || value === '')) {
    return null;
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function sessionIdentifier(value, label) {
  if (typeof value !== 'string'
      || value.trim() === ''
      || value !== value.trim()
      || Buffer.byteLength(value, 'utf8') > MAX_SESSION_ID_BYTES
      || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} must be a bounded non-empty identifier`);
  }
  return UUID_PATTERN.test(value) ? value.toLowerCase() : value;
}

function optionalString(value, maximum = 4096) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, maximum);
}

function normalizedPathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function statIdentity(stat, realPath) {
  const birth = typeof stat.birthtimeNs === 'bigint'
    ? stat.birthtimeNs.toString()
    : String(Math.trunc(Number(stat.birthtimeMs || 0) * 1e6));
  return sha256(JSON.stringify({
    path_hash: sha256(normalizedPathKey(realPath)),
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime_ns: birth,
  }));
}

function sameFileIdentity(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.birthtimeMs) === String(right.birthtimeMs);
}

/**
 * Open a transcript only after both the configured sessions root and the file
 * have resolved to plain, non-link filesystem objects. The fd is rechecked so
 * a path swap cannot redirect bytes after validation.
 */
function openTrustedTranscript(filePath, options = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error('Codex transcript path must be absolute');
  }
  const sessionsRoot = path.resolve(options.sessionsRoot || '');
  if (!options.sessionsRoot || !path.isAbsolute(options.sessionsRoot)) {
    throw new Error('trusted Codex sessions root must be absolute');
  }
  const rootStat = fs.lstatSync(sessionsRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('trusted Codex sessions root must be a plain directory');
  }
  const realRoot = fs.realpathSync.native(sessionsRoot);
  const resolved = path.resolve(filePath);
  const before = fs.lstatSync(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Codex transcript must be a plain regular file');
  }
  const realPath = fs.realpathSync.native(resolved);
  if (!pathIsInside(realRoot, realPath)) {
    throw new Error('Codex transcript is outside the trusted Codex sessions root');
  }
  const fd = fs.openSync(realPath, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const after = fs.lstatSync(resolved, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)
        || !sameFileIdentity(opened, after)) {
      throw new Error('Codex transcript identity changed while opening');
    }
    const observedSize = Number(opened.size);
    if (!Number.isSafeInteger(observedSize) || observedSize < 0) {
      throw new Error('Codex transcript size is unsupported');
    }
    const source = {
      fd,
      realPath,
      sessionsRoot: realRoot,
      observedSize,
      sourceMtimeMs: Number(opened.mtimeMs),
      pathHash: sha256(normalizedPathKey(realPath)),
      fileIdentityHash: statIdentity(opened, realPath),
      openedStat: opened,
    };
    if (options.expectedPathHash && options.expectedPathHash !== source.pathHash) {
      throw new Error('Codex transcript path does not match the expected snapshot');
    }
    if (options.expectedFileIdentityHash
        && options.expectedFileIdentityHash !== source.fileIdentityHash) {
      throw new Error('Codex transcript file identity does not match the expected snapshot');
    }
    return source;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function closeTrustedTranscript(source) {
  if (!source || !Number.isInteger(source.fd)) return;
  fs.closeSync(source.fd);
  source.fd = null;
}

function assertSnapshotIdentity(source) {
  const current = fs.fstatSync(source.fd, { bigint: true });
  if (!current.isFile() || !sameFileIdentity(source.openedStat, current)) {
    throw new Error('Codex transcript identity changed during snapshot read');
  }
  if (Number(current.size) < source.observedSize) {
    throw new Error('Codex transcript was truncated during snapshot read');
  }
}

function cloneAllowedContent(value) {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= MAX_STORED_STRING_BYTES) return value;
    return `[LARGE CONTENT OMITTED bytes=${bytes} sha256=${sha256(value)}]`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneAllowedContent(entry));
  }
  if (!isObject(value)) return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (INTERNAL_KEYS.has(key)) {
      result[key] = INTERNAL_OMISSION;
      continue;
    }
    result[key] = cloneAllowedContent(child);
  }
  return result;
}

function copyAllowed(source, keys) {
  const result = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = cloneAllowedContent(source[key]);
    }
  }
  return result;
}

function markOmittedIfPresent(target, source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = INTERNAL_OMISSION;
  }
  return target;
}

function projectResponsePayload(payload) {
  const payloadType = String(payload.type || '').toLowerCase();
  const identity = copyAllowed(payload, ['type', 'id', 'call_id', 'status']);

  if (payloadType === 'message') {
    const result = {
      ...identity,
      ...copyAllowed(payload, ['role', 'phase']),
    };
    const role = String(payload.role || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(payload, 'content')) {
      result.content = ['developer', 'system'].includes(role)
        ? INTERNAL_OMISSION
        : cloneAllowedContent(payload.content);
    }
    return result;
  }
  if (payloadType === 'agent_message') {
    return {
      ...identity,
      ...copyAllowed(payload, ['author', 'recipient', 'phase', 'content']),
    };
  }
  if (payloadType === 'reasoning' || payloadType === 'compaction') {
    return markOmittedIfPresent(identity, payload, [
      'summary',
      'summary_text',
      'content',
      'text',
      'raw_content',
      'encrypted_content',
    ]);
  }
  if (payloadType === 'function_call') {
    return {
      ...identity,
      ...copyAllowed(payload, ['name', 'namespace', 'arguments']),
    };
  }
  if (payloadType === 'custom_tool_call') {
    return {
      ...identity,
      ...copyAllowed(payload, ['name', 'input']),
    };
  }
  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    return { ...identity, ...copyAllowed(payload, ['output']) };
  }

  // Future response item shapes are internal until explicitly reviewed.
  return identity;
}

function projectCompletedItem(item) {
  if (!isObject(item)) return INTERNAL_OMISSION;
  const itemType = String(item.type || '').toLowerCase();
  const identity = copyAllowed(item, ['type', 'id', 'status']);

  if (itemType === 'reasoning') {
    return markOmittedIfPresent(identity, item, [
      'summary',
      'summary_text',
      'content',
      'text',
      'raw_content',
      'encrypted_content',
    ]);
  }
  if (itemType === 'agentmessage') {
    return { ...identity, ...copyAllowed(item, ['phase', 'content', 'memory_citation']) };
  }
  if (itemType === 'usermessage') {
    return { ...identity, ...copyAllowed(item, ['client_id', 'content']) };
  }
  if (itemType === 'commandexecution') {
    return {
      ...identity,
      ...copyAllowed(item, [
        'command',
        'cwd',
        'duration',
        'exit_code',
        'parsed_cmd',
        'process_id',
        'source',
        'stderr',
        'stdout',
        'aggregated_output',
        'formatted_output',
      ]),
    };
  }
  if (itemType === 'filechange') {
    return { ...identity, ...copyAllowed(item, ['changes', 'stderr', 'stdout']) };
  }
  if (itemType === 'extension') {
    return { ...identity, ...copyAllowed(item, ['action', 'kind', 'query', 'results']) };
  }
  if (itemType === 'subagentactivity') {
    return {
      ...identity,
      ...copyAllowed(item, ['agent_path', 'agent_thread_id', 'kind']),
    };
  }
  if (itemType === 'collabagenttoolcall') {
    return {
      ...identity,
      ...copyAllowed(item, [
        'agents_states',
        'receiver_agents',
        'receiver_thread_ids',
        'sender_thread_id',
        'tool',
      ]),
    };
  }
  if (itemType === 'contextcompaction') return identity;

  // Future item shapes retain identifiers but not unreviewed content fields.
  return identity;
}

function projectEventPayload(payload) {
  const payloadType = String(payload.type || '').toLowerCase();
  const identity = copyAllowed(payload, ['type', 'thread_id', 'turn_id', 'call_id']);

  if (payloadType === 'agent_reasoning' || payloadType === 'reasoning') {
    return markOmittedIfPresent(identity, payload, ['message', 'content', 'text', 'summary']);
  }
  if (payloadType === 'agent_message') {
    return { ...identity, ...copyAllowed(payload, ['message', 'phase', 'memory_citation']) };
  }
  if (payloadType === 'user_message') {
    return {
      ...identity,
      ...copyAllowed(payload, ['message', 'text_elements', 'audio', 'images', 'local_audio', 'local_images']),
    };
  }
  if (payloadType === 'item_completed' || payloadType === 'item_started') {
    const result = {
      ...identity,
      ...copyAllowed(payload, ['started_at_ms', 'completed_at_ms']),
    };
    if (Object.prototype.hasOwnProperty.call(payload, 'item')) {
      result.item = projectCompletedItem(payload.item);
    }
    return result;
  }
  if (payloadType === 'task_started') {
    return {
      ...identity,
      ...copyAllowed(payload, ['collaboration_mode_kind', 'model_context_window', 'started_at']),
    };
  }
  if (payloadType === 'task_complete') {
    return {
      ...identity,
      ...copyAllowed(payload, [
        'completed_at',
        'duration_ms',
        'last_agent_message',
        'started_at',
        'time_to_first_token_ms',
      ]),
    };
  }
  if (payloadType === 'turn_aborted') {
    return {
      ...identity,
      ...copyAllowed(payload, ['completed_at', 'duration_ms', 'reason', 'started_at']),
    };
  }
  if (payloadType === 'token_count') {
    return { ...identity, ...copyAllowed(payload, ['info', 'rate_limits']) };
  }
  if (payloadType === 'patch_apply_end') {
    return {
      ...identity,
      ...copyAllowed(payload, ['changes', 'status', 'stderr', 'stdout', 'success']),
    };
  }
  if (payloadType === 'web_search_end') {
    return { ...identity, ...copyAllowed(payload, ['action', 'query']) };
  }
  if (payloadType === 'context_compacted') return identity;

  // Settings and future event shapes can contain injected instructions.
  return identity;
}

function projectSessionMetaPayload(payload) {
  const result = copyAllowed(payload, [
    'id',
    'session_id',
    'timestamp',
    'cwd',
    'originator',
    'cli_version',
    'source',
    'model_provider',
    'parent_thread_id',
    'forked_from_id',
    'agent_nickname',
    'agent_path',
    'agent_role',
    'context_window',
    'history_mode',
    'multi_agent_version',
    'subagent_history_start_ordinal',
    'thread_source',
  ]);
  return markOmittedIfPresent(result, payload, [
    'base_instructions',
    'developer_instructions',
    'dynamic_tools',
    'instructions',
    'system_instructions',
  ]);
}

function projectCompactedPayload(payload) {
  const result = copyAllowed(payload, [
    'window_number',
    'first_window_id',
    'previous_window_id',
    'window_id',
  ]);
  if (Object.prototype.hasOwnProperty.call(payload, 'message')) {
    result.message = INTERNAL_OMISSION;
  }
  if (Array.isArray(payload.replacement_history)) {
    result.replacement_history = payload.replacement_history.map((entry) => (
      isObject(entry) ? projectResponsePayload(entry) : INTERNAL_OMISSION
    ));
  } else if (Object.prototype.hasOwnProperty.call(payload, 'replacement_history')) {
    result.replacement_history = INTERNAL_OMISSION;
  }
  return result;
}

function projectTurnContextPayload(payload) {
  const result = copyAllowed(payload, [
    'turn_id',
    'current_date',
    'timezone',
    'model',
    'effort',
    'cwd',
    'approval_policy',
    'sandbox_policy',
    'realtime_active',
    'multi_agent_version',
    'comp_hash',
  ]);
  return markOmittedIfPresent(result, payload, ['summary', 'user_instructions']);
}

function projectPayload(rowType, payload) {
  if (rowType === 'session_meta') return projectSessionMetaPayload(payload);
  if (rowType === 'response_item') return projectResponsePayload(payload);
  if (rowType === 'event_msg') return projectEventPayload(payload);
  if (rowType === 'compacted') return projectCompactedPayload(payload);
  if (rowType === 'turn_context') return projectTurnContextPayload(payload);
  if (rowType === 'world_state') {
    const result = copyAllowed(payload, ['full']);
    if (Object.prototype.hasOwnProperty.call(payload, 'state')) result.state = INTERNAL_OMISSION;
    return result;
  }
  if (rowType === 'inter_agent_communication_metadata') {
    return copyAllowed(payload, ['trigger_turn']);
  }

  // Unknown row families only retain stable discriminants needed for ordering/debugging.
  return copyAllowed(payload, ['type', 'id', 'thread_id', 'turn_id', 'call_id']);
}

/** Build the only content projection allowed to cross the PostgreSQL boundary. */
function projectTranscriptRow(row) {
  if (!isObject(row) || !isObject(row.payload) || typeof row.type !== 'string') {
    throw new Error('transcript row must contain type and payload');
  }
  const projected = copyAllowed(row, ['ordinal', 'timestamp', 'type']);
  projected.payload = projectPayload(row.type, row.payload);

  return redactCanonicalValue(projected, 'Codex transcript projection');
}

function parseJsonLine(lineBytes, lineNumber) {
  let parseBytes = lineBytes;
  if (parseBytes.length > 0 && parseBytes[parseBytes.length - 1] === 13) {
    parseBytes = parseBytes.subarray(0, parseBytes.length - 1);
  }
  if (parseBytes.length === 0) {
    throw new Error(`Codex transcript contains an empty JSON line at line ${lineNumber}`);
  }
  if (parseBytes.length > MAX_LINE_BYTES) {
    throw new Error(`Codex transcript line ${lineNumber} exceeds ${MAX_LINE_BYTES} bytes`);
  }
  try {
    const value = JSON.parse(parseBytes.toString('utf8'));
    if (!isObject(value)) throw new Error('row is not an object');
    return value;
  } catch (error) {
    throw new Error(`Codex transcript has invalid JSON at line ${lineNumber}: ${error.message}`);
  }
}

function readFirstCompleteLine(source) {
  const limit = Math.min(source.observedSize, MAX_LINE_BYTES + 1);
  let offset = 0;
  let totalBytes = 0;
  const chunks = [];
  while (offset < limit) {
    const length = Math.min(64 * 1024, limit - offset);
    const chunk = Buffer.allocUnsafe(length);
    const read = fs.readSync(source.fd, chunk, 0, length, offset);
    if (read === 0) break;
    offset += read;
    const bytes = chunk.subarray(0, read);
    const newline = bytes.indexOf(10);
    if (newline !== -1) {
      chunks.push(bytes.subarray(0, newline));
      totalBytes += newline;
      return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalBytes);
    }
    chunks.push(bytes);
    totalBytes += bytes.length;
  }
  if (source.observedSize > MAX_LINE_BYTES) {
    throw new Error(`Codex transcript first line exceeds ${MAX_LINE_BYTES} bytes`);
  }
  throw new Error('Codex transcript does not yet contain a complete session_meta line');
}

function sessionIdFromFileName(realPath) {
  const match = path.basename(realPath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  );
  return match ? match[1].toLowerCase() : null;
}

function parseSessionMeta(row, realPath) {
  if (!isObject(row) || row.type !== 'session_meta' || !isObject(row.payload)) {
    throw new Error('Codex transcript first row must be session_meta');
  }
  const payload = row.payload;
  const transcriptId = uuid(payload.id, 'session_meta.payload.id');
  const fileId = sessionIdFromFileName(realPath);
  if (fileId === null || fileId !== transcriptId) {
    throw new Error('Codex transcript filename does not match session_meta.payload.id');
  }
  const rootSessionId = sessionIdentifier(
    payload.session_id || payload.id,
    'session_meta.payload.session_id'
  );
  const parentThreadId = uuid(payload.parent_thread_id, 'session_meta.payload.parent_thread_id', {
    nullable: true,
  });
  const startedAt = optionalString(payload.timestamp || row.timestamp, 128);
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) {
    throw new Error('Codex transcript session_meta timestamp is invalid');
  }
  const hasOrdinal = Object.prototype.hasOwnProperty.call(row, 'ordinal');
  if (hasOrdinal && (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0)) {
    throw new Error('Codex transcript session_meta ordinal is invalid');
  }
  return {
    transcriptId,
    rootSessionId,
    parentThreadId,
    positionKind: hasOrdinal ? POSITION_KIND_ORDINAL : POSITION_KIND_LINE,
    startedAt: new Date(startedAt).toISOString(),
    cwd: optionalString(payload.cwd),
    originator: optionalString(payload.originator, 512),
    cliVersion: optionalString(payload.cli_version, 128),
    source: optionalString(payload.source, 128),
    modelProvider: optionalString(payload.model_provider, 128),
    sourceFileName: path.basename(realPath),
    metadataJson: projectTranscriptRow(row).payload,
  };
}

function inspectTranscriptFile(filePath, options = {}) {
  const source = openTrustedTranscript(filePath, options);
  try {
    const firstLine = readFirstCompleteLine(source);
    const firstRow = parseJsonLine(firstLine, 1);
    const transcript = parseSessionMeta(firstRow, source.realPath);
    if (options.expectedRootSessionId
        && sessionIdentifier(options.expectedRootSessionId, 'expected root session id')
          !== transcript.rootSessionId) {
      throw new Error('Codex hook root session id does not match transcript session_meta');
    }
    assertSnapshotIdentity(source);
    return {
      transcript,
      observedSize: source.observedSize,
      sourceMtimeMs: source.sourceMtimeMs,
      pathHash: source.pathHash,
      fileIdentityHash: source.fileIdentityHash,
    };
  } finally {
    closeTrustedTranscript(source);
  }
}

function positionForRow(row, positionKind, lineNumber, previousOrdinal) {
  const hasOrdinal = Object.prototype.hasOwnProperty.call(row, 'ordinal');
  if ((positionKind === POSITION_KIND_ORDINAL) !== hasOrdinal) {
    throw new Error('Codex transcript mixes ordinal and legacy line positions');
  }
  if (positionKind === POSITION_KIND_LINE) return lineNumber;
  if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0) {
    throw new Error(`Codex transcript ordinal is invalid at line ${lineNumber}`);
  }
  if (previousOrdinal !== null && row.ordinal <= previousOrdinal) {
    throw new Error(`Codex transcript ordinal is not strictly increasing at line ${lineNumber}`);
  }
  return row.ordinal;
}

function directString(payload, key) {
  return isObject(payload) && typeof payload[key] === 'string'
    ? payload[key].slice(0, 512)
    : null;
}

function buildEventRecord(input) {
  const eventJson = projectTranscriptRow(input.row);
  const eventTimestamp = optionalString(input.row.timestamp, 128);
  if (eventTimestamp && !Number.isFinite(Date.parse(eventTimestamp))) {
    throw new Error(`Codex transcript timestamp is invalid at line ${input.lineNumber}`);
  }
  const payload = input.row.payload;
  return {
    transcriptId: input.transcriptId,
    positionKind: input.positionKind,
    sourcePosition: input.sourcePosition,
    sourceByteOffset: input.sourceByteOffset,
    sourceByteLength: input.rawLineBytes.length,
    eventTimestamp: eventTimestamp ? new Date(eventTimestamp).toISOString() : null,
    outerType: input.row.type.slice(0, 128),
    payloadType: directString(payload, 'type'),
    explicitTurnId: directString(payload, 'turn_id'),
    itemId: directString(payload, 'id') || directString(payload.item, 'id'),
    callId: directString(payload, 'call_id') || directString(payload.item, 'call_id'),
    eventSha256: sha256(input.rawLineBytes),
    projectionSha256: sha256(canonicalStringify(eventJson)),
    eventJson,
  };
}

function chainHash(previous, current) {
  const previousValue = HASH_PATTERN.test(previous || '') ? previous : '0'.repeat(64);
  if (!HASH_PATTERN.test(current || '')) throw new Error('chain input must be a SHA-256 hash');
  return sha256(`${previousValue}\0${current}`);
}

async function flushBatch(batch, onEvents) {
  if (batch.events.length === 0) return;
  await onEvents(batch.events);
  batch.events = [];
  batch.bytes = 0;
}

/**
 * Stream one immutable-size snapshot. Database callers can persist each batch
 * in their surrounding transaction; the collect wrapper is only for tests and
 * small diagnostics.
 */
async function streamTranscriptSnapshot(filePath, options = {}) {
  const source = openTrustedTranscript(filePath, options);
  try {
    const firstLine = readFirstCompleteLine(source);
    const firstRow = parseJsonLine(firstLine, 1);
    const transcript = parseSessionMeta(firstRow, source.realPath);
    if (options.expectedRootSessionId
        && sessionIdentifier(options.expectedRootSessionId, 'expected root session id')
          !== transcript.rootSessionId) {
      throw new Error('Codex hook root session id does not match transcript session_meta');
    }
    if (options.positionKind && options.positionKind !== transcript.positionKind) {
      throw new Error('Codex transcript position format changed since the previous sync');
    }

    const startByteOffset = Number(options.startByteOffset ?? 0);
    if (!Number.isSafeInteger(startByteOffset) || startByteOffset < 0
        || startByteOffset > source.observedSize) {
      throw new Error('Codex transcript start byte offset is invalid');
    }
    let lineNumber = Number(options.nextLineNo ?? 1);
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
      throw new Error('Codex transcript next line number is invalid');
    }
    let previousOrdinal = options.lastOrdinal === null || options.lastOrdinal === undefined
      ? null
      : Number(options.lastOrdinal);
    if (previousOrdinal !== null && (!Number.isSafeInteger(previousOrdinal) || previousOrdinal < 0)) {
      throw new Error('Codex transcript last ordinal is invalid');
    }
    let eventCount = Number(options.eventCount ?? 0);
    let eventChainSha256 = options.eventChainSha256 ?? '0'.repeat(64);
    let projectionChainSha256 = options.projectionChainSha256 ?? '0'.repeat(64);
    let lastEvent = null;
    let nextByteOffset = startByteOffset;
    let lineChunks = [];
    let lineBytes = 0;
    let lineStartOffset = startByteOffset;
    let readOffset = startByteOffset;
    const batch = { events: [], bytes: 0 };
    const onEvents = options.onEvents || (async () => {});
    const batchEvents = options.batchEvents || DEFAULT_BATCH_EVENTS;
    const batchBytes = options.batchBytes || DEFAULT_BATCH_BYTES;

    while (readOffset < source.observedSize) {
      const length = Math.min(64 * 1024, source.observedSize - readOffset);
      const chunk = Buffer.allocUnsafe(length);
      const read = fs.readSync(source.fd, chunk, 0, length, readOffset);
      if (read === 0) break;
      const chunkStartOffset = readOffset;
      readOffset += read;
      const bytes = chunk.subarray(0, read);
      let segmentStart = 0;

      while (segmentStart < bytes.length) {
        const newline = bytes.indexOf(10, segmentStart);
        if (newline === -1) {
          const tail = bytes.subarray(segmentStart);
          if (tail.length > 0) {
            lineChunks.push(tail);
            lineBytes += tail.length;
          }
          if (lineBytes > MAX_LINE_BYTES) {
            throw new Error(`Codex transcript line ${lineNumber} exceeds ${MAX_LINE_BYTES} bytes`);
          }
          break;
        }

        const finalSegment = bytes.subarray(segmentStart, newline);
        const completeLineBytes = lineBytes + finalSegment.length;
        let rawLineBytes;
        if (lineChunks.length === 0) {
          rawLineBytes = finalSegment;
        } else if (finalSegment.length === 0 && lineChunks.length === 1) {
          [rawLineBytes] = lineChunks;
        } else {
          if (finalSegment.length > 0) lineChunks.push(finalSegment);
          rawLineBytes = Buffer.concat(lineChunks, completeLineBytes);
        }
        const row = parseJsonLine(rawLineBytes, lineNumber);
        const sourcePosition = positionForRow(
          row,
          transcript.positionKind,
          lineNumber,
          previousOrdinal
        );
        const event = buildEventRecord({
          row,
          rawLineBytes,
          lineNumber,
          transcriptId: transcript.transcriptId,
          positionKind: transcript.positionKind,
          sourcePosition,
          sourceByteOffset: lineStartOffset,
        });
        batch.events.push(event);
        batch.bytes += Buffer.byteLength(JSON.stringify(event.eventJson), 'utf8');
        eventCount += 1;
        eventChainSha256 = chainHash(eventChainSha256, event.eventSha256);
        projectionChainSha256 = chainHash(projectionChainSha256, event.projectionSha256);
        previousOrdinal = transcript.positionKind === POSITION_KIND_ORDINAL
          ? sourcePosition
          : previousOrdinal;
        lastEvent = event;
        nextByteOffset = chunkStartOffset + newline + 1;
        lineStartOffset = nextByteOffset;
        lineChunks = [];
        lineBytes = 0;
        segmentStart = newline + 1;
        lineNumber += 1;

        if (batch.events.length >= batchEvents || batch.bytes >= batchBytes) {
          await flushBatch(batch, onEvents);
        }
      }
    }
    await flushBatch(batch, onEvents);
    assertSnapshotIdentity(source);

    return {
      transcript,
      projectionVersion: PROJECTION_VERSION,
      redactionVersion: REDACTION_VERSION,
      observedSize: source.observedSize,
      sourceMtimeMs: source.sourceMtimeMs,
      pathHash: source.pathHash,
      fileIdentityHash: source.fileIdentityHash,
      nextByteOffset,
      nextLineNo: lineNumber,
      lastOrdinal: transcript.positionKind === POSITION_KIND_ORDINAL ? previousOrdinal : null,
      lastEventByteOffset: lastEvent ? lastEvent.sourceByteOffset : options.lastEventByteOffset ?? null,
      lastEventByteLength: lastEvent ? lastEvent.sourceByteLength : options.lastEventByteLength ?? null,
      lastEventSha256: lastEvent ? lastEvent.eventSha256 : options.lastEventSha256 ?? null,
      lastEventTimestamp: lastEvent ? lastEvent.eventTimestamp : options.lastEventTimestamp ?? null,
      eventCount,
      eventChainSha256,
      projectionChainSha256,
      trailingBytes: source.observedSize - nextByteOffset,
    };
  } finally {
    closeTrustedTranscript(source);
  }
}

async function collectTranscriptSnapshot(filePath, options = {}) {
  const events = [];
  const snapshot = await streamTranscriptSnapshot(filePath, {
    ...options,
    onEvents: async (batch) => events.push(...batch),
  });
  return { ...snapshot, events };
}

function readAnchorSha256(filePath, state, options = {}) {
  if (!state || state.lastEventByteOffset === null || state.lastEventByteOffset === undefined
      || state.lastEventByteLength === null || state.lastEventByteLength === undefined) {
    return null;
  }
  const source = openTrustedTranscript(filePath, options);
  try {
    const offset = Number(state.lastEventByteOffset);
    const length = Number(state.lastEventByteLength);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length)
        || length < 0 || offset + length > source.observedSize) {
      throw new Error('stored transcript anchor is outside the current file');
    }
    const bytes = Buffer.allocUnsafe(length);
    const read = fs.readSync(source.fd, bytes, 0, length, offset);
    if (read !== length) throw new Error('stored transcript anchor could not be read completely');
    assertSnapshotIdentity(source);
    return sha256(bytes);
  } finally {
    closeTrustedTranscript(source);
  }
}

function validateResumeState(state, observed) {
  if (!state) return true;
  if (state.fileIdentityHash !== observed.fileIdentityHash) {
    throw new Error('Codex transcript file identity changed; refusing incremental overwrite');
  }
  if (Number(observed.observedSize) < Number(state.nextByteOffset)) {
    throw new Error('Codex transcript was truncated; refusing incremental overwrite');
  }
  if (state.lastEventSha256 && state.lastEventSha256 !== observed.anchorSha256) {
    throw new Error('Codex transcript anchor changed; refusing incremental overwrite');
  }
  return true;
}

module.exports = {
  DEFAULT_BATCH_BYTES,
  DEFAULT_BATCH_EVENTS,
  INTERNAL_OMISSION,
  MAX_LINE_BYTES,
  MAX_STORED_STRING_BYTES,
  POSITION_KIND_LINE,
  POSITION_KIND_ORDINAL,
  PROJECTION_VERSION,
  REDACTION_VERSION,
  buildEventRecord,
  chainHash,
  collectTranscriptSnapshot,
  inspectTranscriptFile,
  openTrustedTranscript,
  parseSessionMeta,
  projectTranscriptRow,
  readAnchorSha256,
  streamTranscriptSnapshot,
  validateResumeState,
};
