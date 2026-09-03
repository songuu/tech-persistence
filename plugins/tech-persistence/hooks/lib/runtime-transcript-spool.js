'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256, protectedPath } = require('../agent-orchestrator/external-runtime-config');
const { createJob } = require('./runtime-transcript-outbox');
const { sourceAdapter } = require('./transcript-source-adapters');
const { canonicalStringify } = require('./self-learning-canonical');

function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  protectedPath(dir, null, true);
}
function atomicJson(file, value, replace = false) {
  const bytes = `${JSON.stringify(value)}\n`;
  const temporary = path.join(path.dirname(file), `.pending-${crypto.randomUUID()}`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if (replace) {
      if (fs.existsSync(file)) protectedPath(file);
      fs.renameSync(temporary, file);
    } else {
      try { fs.linkSync(temporary, file); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        protectedPath(file);
        if (fs.readFileSync(file, 'utf8') !== bytes) throw new Error('durable content-addressed file conflicts');
      }
    }
    syncDirectory(path.dirname(file));
  } finally {
    // Only this invocation's private temporary artifact is removed; existing evidence is never replaced.
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function durableCreate(file, value) { return atomicJson(file, value); }
function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function enqueueSource(root, sourceFile, sessionId) {
  const adapter = sourceAdapter('harness-events-jsonl-v1');
  const source = adapter.inspect(sourceFile);
  const job = createJob({ runtime: adapter.descriptor.runtime, adapterId: adapter.descriptor.id,
    sessionId, sourcePathHash: source.pathHash, fileIdentityHash: source.fileIdentityHash,
    observedSize: source.observedSize, positionKind: 'line' });
  privateDirectory(path.join(root, 'jobs'));
  const file = path.join(root, 'jobs', `${job.jobHash.replace(':', '-')}.json`);
  durableCreate(file, job);
  return { jobHash: job.jobHash, sourcePathHash: job.sourcePathHash };
}
function captureEvent(root, input, type) {
  if (!/^[a-f0-9]{64}$/.test(input.sessionId)) throw new Error('transcript session must be a hash');
  privateDirectory(path.join(root, 'sources'));
  const sourceFile = path.join(root, 'sources', `${input.sessionId}.jsonl`);
    const base = { version: 'harness-event-v1', runtime: 'openai-compatible', sessionId: input.sessionId,
      requestId: sha256(input.requestId), taskHash: input.taskHash, routeHash: input.routeHash,
      modelHash: input.modelHash };
    const event = type === 'request'
      ? { ...base, type, timestamp: input.startedAt, status: 'started', payloadHash: sha256(input.requestBytes) }
      : { ...base, type: input.succeeded ? 'response' : 'error', timestamp: input.finishedAt,
        status: input.succeeded ? 'succeeded' : 'failed', payloadHash: sha256(input.responseBytes) };
    if (fs.existsSync(sourceFile) && fs.lstatSync(sourceFile).isSymbolicLink()) throw new Error('spool source cannot be a link');
    const fd = fs.openSync(sourceFile, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      // One bounded O_APPEND write per frame: concurrent authorities cannot interleave frames.
      const bytes = Buffer.from(`${canonicalStringify(event)}\n`);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size + bytes.length > 64 * 1024 * 1024) throw new Error('transcript capacity reached; start a new run');
      if (stat.size) {
        const tail = Buffer.alloc(1); fs.readSync(fd, tail, 0, 1, stat.size - 1);
        if (tail[0] !== 10) throw new Error('incomplete transcript tail requires operator reconciliation');
      }
      if (bytes.length > 8192 || fs.writeSync(fd, bytes) !== bytes.length) throw new Error('incomplete transcript append');
      fs.fsyncSync(fd);
    }
    finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(sourceFile));
    return enqueueSource(root, sourceFile, input.sessionId);
}
function captureInvocation(root, input) { captureEvent(root, input, 'request'); return captureEvent(root, input, 'terminal'); }
module.exports = { captureEvent, captureInvocation, enqueueSource, privateDirectory, durableCreate, syncDirectory, atomicJson };
