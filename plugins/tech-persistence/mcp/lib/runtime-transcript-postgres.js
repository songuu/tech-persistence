'use strict';
const path = require('node:path');
const { sourceAdapter } = require('./transcript-source-adapters');
const { buildEventInsert, verifyTranscriptReadback } = require('./codex-transcript-postgres');
const { validateJob } = require('./runtime-transcript-outbox');

async function syncRuntimeTranscript(input = {}) {
  const job = validateJob(input.job);
  const adapter = sourceAdapter(job.adapterId);
  if (job.adapterId === 'harness-events-jsonl-v1' && job.runtime === adapter.descriptor.runtime) {
    return require('./harness-transcript-postgres').syncHarnessTranscript(input, job);
  }
  if (adapter.descriptor.runtime !== job.runtime || adapter.descriptor.batchDryRunOnly !== true) {
    throw new Error('runtime transcript adapter/job mismatch');
  }
  const snapshot = await adapter.stream(input.sourceFile);
  if (snapshot.pathHash !== job.sourcePathHash || snapshot.fileIdentityHash !== job.fileIdentityHash
      || snapshot.observedSize !== job.observedSize) throw new Error('runtime transcript source identity mismatch');
  const events = [];
  await adapter.stream(input.sourceFile, { onEvents: async (batch) => events.push(...batch) });
  const transcriptId = `${job.runtime}:${job.sessionId}`;
  const client = await input.writer.connect();
  let insertedEvents = 0;
  try {
    await client.query('BEGIN');
    await client.query({ text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', values: [transcriptId] });
    await client.query({ text: `INSERT INTO public.transcripts (
      transcript_id, root_session_id, source_file_name, path_hash, file_identity_hash, position_kind,
      observed_size, observed_mtime, next_line_no, event_count, event_chain_sha256,
      projection_chain_sha256, projection_version, redaction_version, source, model_provider, metadata_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
    ON CONFLICT (transcript_id) DO NOTHING`, values: [transcriptId, job.sessionId,
      path.basename(input.sourceFile), snapshot.pathHash, snapshot.fileIdentityHash, job.positionKind,
      snapshot.observedSize, snapshot.sourceMtimeMs, snapshot.nextLineNo, snapshot.eventCount,
      snapshot.eventChainSha256, snapshot.projectionChainSha256, 'runtime-hash-v1', 'hash-only-v1',
      job.runtime, job.runtime, JSON.stringify({ adapterId: job.adapterId, jobHash: job.jobHash })] });
    const projected = events.map((event) => ({ ...event, transcriptId, positionKind: job.positionKind,
      eventTimestamp: null, payloadType: null, explicitTurnId: null, itemId: null, callId: null }));
    if (projected.length > 0) insertedEvents = (await client.query(buildEventInsert(projected))).rowCount;
    const update = await client.query({ text: `UPDATE public.transcripts SET observed_size=$2, observed_mtime=$3,
      next_line_no=$4, event_count=$5, last_event_sha256=$6, event_chain_sha256=$7,
      projection_chain_sha256=$8, updated_at=now(), last_synced_at=now() WHERE transcript_id=$1
      AND path_hash=$9 AND file_identity_hash=$10`, values: [transcriptId, snapshot.observedSize,
      snapshot.sourceMtimeMs, snapshot.nextLineNo, snapshot.eventCount,
      events.length ? events[events.length - 1].eventSha256 : null, snapshot.eventChainSha256,
      snapshot.projectionChainSha256, snapshot.pathHash, snapshot.fileIdentityHash] });
    if (update.rowCount !== 1) throw new Error('runtime transcript state identity mismatch');
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
  const readback = await verifyTranscriptReadback(input.reader, { transcriptId,
    eventCount: snapshot.eventCount, nextByteOffset: 0,
    lastEventSha256: events.length ? events[events.length - 1].eventSha256 : null,
    eventChainSha256: snapshot.eventChainSha256, projectionChainSha256: snapshot.projectionChainSha256 });
  return { ...readback, insertedEvents, jobHash: job.jobHash };
}

module.exports = { syncRuntimeTranscript };
