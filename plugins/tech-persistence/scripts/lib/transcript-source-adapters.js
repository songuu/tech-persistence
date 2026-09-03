'use strict';

const codexProjection = require('./codex-transcript-projection');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { canonicalStringify } = require('./self-learning-canonical');

const CODEX_SOURCE = Object.freeze({
  id: 'codex-jsonl-v1', runtime: 'codex', positionKind: 'line',
  capabilities: Object.freeze(['discover', 'inspect', 'stream']),
});
const EXTERNAL_HASH_SOURCE = Object.freeze({
  id: 'external-jsonl-hash-v1', runtime: 'external', positionKind: 'line',
  capabilities: Object.freeze(['inspect', 'stream']), batchDryRunOnly: true,
});
const LLAMA_CPP_SOURCE = Object.freeze({
  id: 'llama-cpp-chat-jsonl-v1', runtime: 'llama-cpp', positionKind: 'line',
  capabilities: Object.freeze(['inspect', 'stream']), batchDryRunOnly: true,
});
const HARNESS_SOURCE = Object.freeze({ id: 'harness-events-jsonl-v1', runtime: 'openai-compatible',
  positionKind: 'line', capabilities: Object.freeze(['discover', 'inspect', 'stream']), batchDryRunOnly: false });

function inspectHarness(file) {
  const resolved = pathResolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('invalid or oversized harness transcript source');
  return { file: resolved, observedSize: stat.size, pathHash: sha256(resolved), sourceMtimeMs: stat.mtimeMs,
    fileIdentityHash: sha256(`${resolved}\0${stat.dev}\0${stat.ino}\0${stat.birthtimeMs}`) };
}
function projectHarnessLine(bytes, position, offset) {
  const eventSha256 = sha256(bytes);
  let raw;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid harness transcript JSON'); }
  const allowed = ['version', 'runtime', 'sessionId', 'requestId', 'taskHash', 'routeHash', 'modelHash', 'type', 'timestamp', 'status', 'payloadHash'];
  if (!raw || typeof raw !== 'object' || raw.version !== 'harness-event-v1' || raw.runtime !== 'openai-compatible'
      || bytes.toString('utf8') !== canonicalStringify(raw)
      || Object.keys(raw).some((key) => !allowed.includes(key))
      || !['request', 'response', 'error'].includes(raw.type)
      || ({ request: 'started', response: 'succeeded', error: 'failed' })[raw.type] !== raw.status
      || Number.isNaN(Date.parse(raw.timestamp))
      || ['sessionId', 'requestId', 'modelHash', 'payloadHash'].some((key) => !/^[a-f0-9]{64}$/.test(raw[key] || ''))
      || ['taskHash', 'routeHash'].some((key) => !/^sha256:[a-f0-9]{64}$/.test(raw[key] || ''))) throw new Error('invalid or unsafe harness transcript event');
  return { sourcePosition: position, sourceByteOffset: offset, sourceByteLength: bytes.length,
    outerType: raw.type, payloadType: raw.status, eventTimestamp: raw.timestamp, explicitTurnId: raw.taskHash,
    callId: raw.requestId, itemId: null, eventSha256, projectionSha256: sha256(canonicalStringify(raw)), eventJson: raw };
}
async function streamHarness(file, options = {}) {
  const startLine = options.startLine ?? 1;
  if (!Number.isSafeInteger(startLine) || startLine < 1) throw new Error('invalid transcript startLine');
  const inspected = inspectHarness(file);
  const fd = fs.openSync(inspected.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const opened = fs.fstatSync(fd);
  const limit = options.limitBytes ?? inspected.observedSize;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > opened.size) { fs.closeSync(fd); throw new Error('invalid transcript snapshot limit'); }
  const { chainHash } = codexProjection;
  let pending = Buffer.alloc(0), readOffset = 0, lineOffset = 0, count = 0, emitted = 0;
  let eventChainSha256 = '0'.repeat(64), projectionChainSha256 = '0'.repeat(64), lastEventSha256 = null;
  let checkpoint = { eventCount: 0, eventChainSha256, projectionChainSha256, nextByteOffset: 0 };
  let sessionId = null; let batch = [];
  try {
    while (readOffset < limit) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit - readOffset));
      const length = fs.readSync(fd, buffer, 0, buffer.length, readOffset);
      if (!length) throw new Error('transcript truncated during read');
      readOffset += length; pending = Buffer.concat([pending, buffer.subarray(0, length)]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, end);
        if (!line.length || line.length > 8192) throw new Error('invalid harness transcript line size');
        const event = projectHarnessLine(line, ++count, lineOffset);
        if (sessionId && sessionId !== event.eventJson.sessionId) throw new Error('transcript session drift');
        sessionId = event.eventJson.sessionId;
        lineOffset += end + 1; pending = pending.subarray(end + 1);
        eventChainSha256 = chainHash(eventChainSha256, event.eventSha256);
        projectionChainSha256 = chainHash(projectionChainSha256, event.projectionSha256);
        lastEventSha256 = event.eventSha256;
        if (count === startLine - 1) checkpoint = { eventCount: count, eventChainSha256, projectionChainSha256, nextByteOffset: lineOffset };
        if (count >= startLine) { batch.push(event); emitted++; }
        if (batch.length === 64) { if (options.onEvents) await options.onEvents(batch); batch = []; }
      }
      if (pending.length > 8192) throw new Error('unterminated transcript line exceeds limit');
    }
    if (batch.length && options.onEvents) await options.onEvents(batch);
    const after = fs.fstatSync(fd);
    const finalIdentity = inspectHarness(file);
    if (after.ino !== opened.ino || after.size < opened.size || finalIdentity.fileIdentityHash !== inspected.fileIdentityHash
        || (after.size === opened.size && after.mtimeMs !== opened.mtimeMs)) throw new Error('transcript identity changed during read');
    return { ...inspected, observedSize: limit, descriptor: HARNESS_SOURCE, sessionId,
      eventCount: count, emittedEventCount: emitted, nextLineNo: count + 1, nextByteOffset: lineOffset,
      trailingBytes: pending.length, eventChainSha256, projectionChainSha256, lastEventSha256, checkpoint };
  } finally { fs.closeSync(fd); }
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function inspectExternal(file) {
  const resolved = pathResolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('external transcript must be a regular file');
  const bytes = fs.readFileSync(resolved);
  return { file: resolved, observedSize: stat.size, pathHash: sha256(resolved.toLowerCase()),
    fileIdentityHash: sha256(bytes), sourceMtimeMs: stat.mtimeMs };
}
function pathResolve(file) { return require('node:path').resolve(file); }
async function streamExternal(file, options = {}) {
  const inspected = inspectExternal(file);
  const text = fs.readFileSync(inspected.file, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  let byteOffset = 0;
  const start = Number.isSafeInteger(options.startLine) ? options.startLine : 1;
  const allEvents = lines.map((line, index) => {
    const sourceByteLength = Buffer.byteLength(line);
    const event = { sourcePosition: index + 1, sourceByteOffset: byteOffset, sourceByteLength,
      outerType: 'unknown', eventSha256: sha256(line),
      projectionSha256: sha256(JSON.stringify({ sourcePosition: index + 1, eventSha256: sha256(line) })),
      eventJson: { type: 'unknown', sourceHash: sha256(line) } };
    byteOffset += sourceByteLength + 1;
    return event;
  });
  const events = allEvents.slice(start - 1);
  if (options.onEvents) await options.onEvents(events);
  return { descriptor: options.descriptor || EXTERNAL_HASH_SOURCE, ...inspected,
    eventCount: allEvents.length, emittedEventCount: events.length, nextLineNo: lines.length + 1,
    eventChainSha256: sha256(allEvents.map((event) => event.eventSha256).join('')),
    projectionChainSha256: sha256(allEvents.map((event) => event.projectionSha256).join('')) };
}

function sourceAdapter(id) {
  if (id === HARNESS_SOURCE.id) return Object.freeze({ descriptor: HARNESS_SOURCE, inspect: inspectHarness, stream: streamHarness });
  if (id === EXTERNAL_HASH_SOURCE.id) return Object.freeze({
    descriptor: EXTERNAL_HASH_SOURCE, inspect: inspectExternal, stream: streamExternal,
  });
  if (id === LLAMA_CPP_SOURCE.id) return Object.freeze({
    descriptor: LLAMA_CPP_SOURCE, inspect: inspectExternal,
    stream: (file, options = {}) => streamExternal(file, { ...options, descriptor: LLAMA_CPP_SOURCE }),
  });
  if (id !== CODEX_SOURCE.id) throw new Error(`Unknown transcript source adapter: ${id}`);
  return Object.freeze({
    descriptor: CODEX_SOURCE,
    inspect: codexProjection.inspectTranscriptFile,
    stream: codexProjection.streamTranscriptSnapshot,
    collect: codexProjection.collectTranscriptSnapshot,
  });
}

module.exports = { CODEX_SOURCE, EXTERNAL_HASH_SOURCE, LLAMA_CPP_SOURCE, HARNESS_SOURCE, sourceAdapter };
