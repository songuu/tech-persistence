'use strict';
const { stableHash } = require('./self-learning-canonical');
const VERSION = 'runtime-transcript-outbox/v3';

function createJob(input = {}) {
  for (const key of ['runtime', 'adapterId', 'sessionId', 'sourcePathHash', 'fileIdentityHash']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`${key} is required`);
  }
  if (!/^[a-f0-9]{64}$/.test(input.sourcePathHash) || !/^[a-f0-9]{64}$/.test(input.fileIdentityHash)) {
    throw new Error('outbox source hashes are invalid');
  }
  const core = { version: VERSION, runtime: input.runtime, adapterId: input.adapterId,
    sessionId: input.sessionId, sourcePathHash: input.sourcePathHash,
    fileIdentityHash: input.fileIdentityHash, observedSize: Number(input.observedSize || 0),
    positionKind: input.positionKind || 'line' };
  if (!Number.isSafeInteger(core.observedSize) || core.observedSize < 0) throw new Error('observedSize is invalid');
  return Object.freeze({ ...core, jobHash: stableHash(core) });
}
function validateJob(job) {
  const expected = createJob(job);
  if (expected.jobHash !== job.jobHash || Object.keys(job).length !== Object.keys(expected).length) {
    throw new Error('runtime transcript outbox job is non-canonical');
  }
  return expected;
}
module.exports = { VERSION, createJob, validateJob };
