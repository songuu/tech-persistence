'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { protectedPath, readProtectedJson } = require('../agent-orchestrator/external-runtime-config');
const { enqueueSource, privateDirectory, durableCreate, atomicJson } = require('./runtime-transcript-spool');
const { validateJob } = require('./runtime-transcript-outbox');
const { sourceAdapter } = require('./transcript-source-adapters');
const { syncRuntimeTranscript } = require('./runtime-transcript-postgres');

function discover(root) {
  protectedPath(root, null, true);
  for (const name of ['sources', 'jobs', 'acks']) privateDirectory(path.join(root, name));
  const names = fs.readdirSync(path.join(root, 'sources'));
  if (names.length > 10000) throw new Error('transcript source inventory exceeds operator retention limit');
  const sources = new Map();
  const failures = [];
  for (const name of names) {
    try {
    if (!/^[a-f0-9]{64}\.jsonl$/.test(name)) throw new Error('unexpected transcript source entry');
    const file = path.join(root, 'sources', name);
    protectedPath(file);
    const source = sourceAdapter('harness-events-jsonl-v1').inspect(file);
    sources.set(source.pathHash, file);
    // Repairs a crash after append/fsync but before enqueue. Source identity survives append.
    if (source.observedSize > 0) enqueueSource(root, file, name.slice(0, -6));
    } catch { failures.push({ reason: 'source-discovery-failed' }); }
  }
  return { sources, failures };
}
async function runWorker(input) {
  const root = path.resolve(input.root);
  const { sources, failures } = discover(root);
  let names = fs.readdirSync(path.join(root, 'jobs')).filter(name => !/^\.pending-[a-f0-9-]{36}$/.test(name)).sort();
  if (names.length > 20000) throw new Error('transcript job inventory exceeds operator retention limit');
  const limit = input.maxJobs ?? 64;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('invalid worker batch limit');
  const cursorFile = path.join(root, 'scan-cursor.json');
  const cursor = fs.existsSync(cursorFile) ? readProtectedJson(cursorFile).after : '';
  if (typeof cursor !== 'string') throw new Error('invalid worker scan cursor');
  names = [...names.filter(name => name > cursor), ...names.filter(name => name <= cursor)];
  const summary = { attempted: 0, acknowledged: 0, failed: failures.length, remaining: 0, failures };
  for (const name of names) {
    const file = path.join(root, 'jobs', name), ackFile = path.join(root, 'acks', name);
    if (summary.attempted >= limit) { summary.remaining++; continue; }
    let counted = false;
    try {
      if (!/^sha256-[a-f0-9]{64}\.json$/.test(name)) throw new Error('unexpected outbox job entry');
      if (fs.existsSync(ackFile)) {
        const ack = readProtectedJson(ackFile);
        if (ack.jobHash !== name.slice(0, -5).replace('sha256-', 'sha256:') || ack.verified !== true) throw new Error('invalid transcript acknowledgement');
        continue;
      }
      summary.attempted++;
      counted = true;
      // Persist before work, so timeouts and poison jobs cannot monopolize every timer tick.
      atomicJson(cursorFile, { after: name }, true);
      const job = validateJob(readProtectedJson(file));
      if (name !== `${job.jobHash.replace(':', '-')}.json`) throw new Error('job filename/hash mismatch');
      const sourceFile = sources.get(job.sourcePathHash);
      if (!sourceFile) throw new Error('outbox source is missing');
      const result = await (input.sync || syncRuntimeTranscript)({ job, sourceFile, writer: input.writer, reader: input.reader });
      if (!result.verified || result.jobHash !== job.jobHash) throw new Error('independent readback is required before acknowledgement');
      durableCreate(ackFile, { jobHash: job.jobHash, transcriptId: result.transcriptId, verified: true });
      summary.acknowledged++;
    } catch {
      if (!counted) { summary.attempted++; atomicJson(cursorFile, { after: name }, true); }
      summary.failed++;
      summary.failures.push({ jobHash: name.slice(0, -5).replace('sha256-', 'sha256:'), reason: 'sync-or-readback-failed' });
    }
  }
  return summary;
}
module.exports = { discover, runWorker };
