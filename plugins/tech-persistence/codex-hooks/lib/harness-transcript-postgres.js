'use strict';
const path = require('node:path');
const { sourceAdapter } = require('./transcript-source-adapters');
const { buildEventInsert, verifyTranscriptReadback } = require('./codex-transcript-postgres');
const { canonicalStringify } = require('./self-learning-canonical');
const { sha256 } = require('../agent-orchestrator/external-runtime-config');
const SEED = '0'.repeat(64);
const adapter = sourceAdapter('harness-events-jsonl-v1');

function assertIdentity(snapshot, job) {
  if (snapshot.pathHash !== job.sourcePathHash || snapshot.fileIdentityHash !== job.fileIdentityHash
      || snapshot.observedSize < job.observedSize || job.positionKind !== 'line'
      || !/^[a-f0-9]{64}$/.test(job.sessionId)) throw new Error('harness transcript source identity mismatch');
}
async function verifyRows(reader, sourceFile, transcriptId, expected) {
  const reread = await adapter.stream(sourceFile, { limitBytes: expected.observedSize, onEvents: async events => {
    const rows = (await reader.query({ text: `SELECT source_position, event_sha256, projection_sha256,
      event_json, outer_type, payload_type, call_id, explicit_turn_id, event_timestamp, source_byte_offset, source_byte_length, item_id
      FROM public.transcript_events WHERE transcript_id=$1 AND position_kind='line'
      AND source_position BETWEEN $2 AND $3 ORDER BY source_position`,
      values: [transcriptId, events[0].sourcePosition, events[events.length - 1].sourcePosition] })).rows;
    if (rows.length !== events.length) throw new Error('harness readback event count mismatch');
    for (let i = 0; i < events.length; i++) {
      const row = rows[i], event = events[i];
      const timestamp = row.event_timestamp instanceof Date ? row.event_timestamp.toISOString() : row.event_timestamp;
      if (Number(row.source_position) !== event.sourcePosition || row.event_sha256 !== event.eventSha256
          || row.projection_sha256 !== event.projectionSha256 || sha256(canonicalStringify(row.event_json)) !== event.projectionSha256
          || row.outer_type !== event.outerType || row.payload_type !== event.payloadType || row.call_id !== event.callId
          || Number(row.source_byte_offset) !== event.sourceByteOffset || Number(row.source_byte_length) !== event.sourceByteLength || row.item_id !== event.itemId
          || row.explicit_turn_id !== event.explicitTurnId || Date.parse(timestamp) !== Date.parse(event.eventTimestamp)) {
        throw new Error('harness readback event content mismatch');
      }
    }
  } });
  for (const key of ['fileIdentityHash', 'eventCount', 'nextByteOffset', 'eventChainSha256', 'projectionChainSha256']) {
    if (reread[key] !== expected[key]) throw new Error('harness source changed after commit');
  }
  return verifyTranscriptReadback(reader, { transcriptId, ...expected });
}
async function syncHarnessTranscript(input, job) {
  const initial = adapter.inspect(input.sourceFile);
  assertIdentity(initial, job);
  const transcriptId = `${job.runtime}:${job.sessionId}`;
  const client = await input.writer.connect();
  let snapshot, insertedEvents = 0;
  try {
    await client.query('BEGIN');
    await client.query({ text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', values: [transcriptId] });
    await client.query({ text: `INSERT INTO public.transcripts (transcript_id, root_session_id, source_file_name,
      path_hash, file_identity_hash, position_kind, observed_size, observed_mtime, next_byte_offset, next_line_no,
      event_count, event_chain_sha256, projection_chain_sha256, projection_version, redaction_version, source, model_provider, metadata_json)
      VALUES ($1,$2,$3,$4,$5,'line',0,$6,0,1,0,$7,$7,'harness-events-v1','hash-only-v1',$8,$8,$9::jsonb)
      ON CONFLICT (transcript_id) DO NOTHING`, values: [transcriptId, job.sessionId, path.basename(input.sourceFile),
      initial.pathHash, initial.fileIdentityHash, initial.sourceMtimeMs, SEED, job.runtime, JSON.stringify({ adapterId: job.adapterId })] });
    const state = (await client.query({ text: `SELECT path_hash, file_identity_hash, root_session_id,
      observed_size, next_line_no, next_byte_offset, event_count, event_chain_sha256, projection_chain_sha256,
      position_kind, projection_version, redaction_version
      FROM public.transcripts WHERE transcript_id=$1 FOR UPDATE`, values: [transcriptId] })).rows[0];
    if (!state || state.path_hash !== initial.pathHash || state.file_identity_hash !== initial.fileIdentityHash
        || state.root_session_id !== job.sessionId || state.position_kind !== 'line' || state.projection_version !== 'harness-events-v1'
        || state.redaction_version !== 'hash-only-v1' || Number(state.observed_size) > initial.observedSize
        || Number(state.next_line_no) !== Number(state.event_count) + 1) throw new Error('stored harness identity/cursor mismatch');
    snapshot = await adapter.stream(input.sourceFile, { startLine: Number(state.next_line_no), limitBytes: initial.observedSize,
      onEvents: async events => {
        if (events.some(event => event.eventJson.sessionId !== job.sessionId)) throw new Error('harness session/job mismatch');
        insertedEvents += (await client.query(buildEventInsert(events.map(event => ({ ...event, transcriptId, positionKind: 'line' }))))).rowCount;
        const rows = (await client.query({ text: `SELECT source_position, event_sha256, projection_sha256
          FROM public.transcript_events WHERE transcript_id=$1 AND position_kind='line'
          AND source_position BETWEEN $2 AND $3 ORDER BY source_position`, values: [transcriptId, events[0].sourcePosition, events.at(-1).sourcePosition] })).rows;
        if (rows.length !== events.length || rows.some((row, i) => Number(row.source_position) !== events[i].sourcePosition
            || row.event_sha256 !== events[i].eventSha256 || row.projection_sha256 !== events[i].projectionSha256)) throw new Error('conflicting transcript event position');
      } });
    if (snapshot.fileIdentityHash !== initial.fileIdentityHash || snapshot.sessionId !== job.sessionId
        || snapshot.checkpoint.eventCount !== Number(state.event_count)
        || snapshot.checkpoint.nextByteOffset !== Number(state.next_byte_offset)
        || snapshot.checkpoint.eventChainSha256 !== state.event_chain_sha256
        || snapshot.checkpoint.projectionChainSha256 !== state.projection_chain_sha256) throw new Error('harness historical prefix mismatch');
    await client.query({ text: `UPDATE public.transcripts SET observed_size=$2, observed_mtime=$3, next_line_no=$4,
      next_byte_offset=$5, event_count=$6, last_event_sha256=$7, event_chain_sha256=$8,
      projection_chain_sha256=$9, updated_at=now(), last_synced_at=now() WHERE transcript_id=$1`,
      values: [transcriptId, snapshot.observedSize, snapshot.sourceMtimeMs, snapshot.nextLineNo, snapshot.nextByteOffset,
        snapshot.eventCount, snapshot.lastEventSha256, snapshot.eventChainSha256, snapshot.projectionChainSha256] });
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve original failure. */ }
    throw error;
  } finally { client.release(); }
  const readback = await verifyRows(input.reader, input.sourceFile, transcriptId, snapshot);
  if (snapshot.trailingBytes) throw new Error('harness transcript has an incomplete tail; retry retained');
  return { ...readback, insertedEvents, jobHash: job.jobHash, nextLineNo: snapshot.nextLineNo, nextByteOffset: snapshot.nextByteOffset };
}
module.exports = { syncHarnessTranscript, verifyRows };
