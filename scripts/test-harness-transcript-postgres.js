'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./test-harness-runtime-wiring');
const { captureInvocation, enqueueSource } = require('./lib/runtime-transcript-spool');
const { syncRuntimeTranscript } = require('./lib/runtime-transcript-postgres');
const { canonicalStringify } = require('./lib/self-learning-canonical');
const SEED = '0'.repeat(64);
function fakeDatabase() {
  let states = new Map(), events = new Map(), backup;
  const stats = { commits: 0, rollbacks: 0, maxBatch: 0 };
  const columns = ['transcript_id', 'position_kind', 'source_position', 'source_byte_offset', 'source_byte_length', 'event_timestamp', 'outer_type', 'payload_type', 'explicit_turn_id', 'item_id', 'call_id', 'event_sha256', 'projection_sha256', 'event_json'];
  async function query(request) {
    const text = typeof request === 'string' ? request : request.text;
    const v = request.values || [];
    if (text === 'BEGIN') { backup = structuredClone({ states, events }); return {}; }
    if (text === 'COMMIT') { stats.commits++; return {}; }
    if (text === 'ROLLBACK') { stats.rollbacks++; ({ states, events } = backup); return {}; }
    if (text.includes('pg_advisory_xact_lock')) return {};
    if (text.startsWith('INSERT INTO public.transcripts ')) {
      if (!states.has(v[0])) states.set(v[0], { transcript_id: v[0], root_session_id: v[1], path_hash: v[3], file_identity_hash: v[4], observed_size: 0,
        event_count: 0, next_line_no: 1, next_byte_offset: 0, event_chain_sha256: SEED, projection_chain_sha256: SEED,
        position_kind: 'line', projection_version: 'harness-events-v1', redaction_version: 'hash-only-v1' });
      return { rowCount: 1 };
    }
    if (text.includes('FROM public.transcripts WHERE')) return { rows: [states.get(v[0])] };
    if (text.startsWith('INSERT INTO public.transcript_events')) {
      let rowCount = 0; stats.maxBatch = Math.max(stats.maxBatch, v.length / columns.length);
      for (let i = 0; i < v.length; i += columns.length) {
        const row = Object.fromEntries(columns.map((name, j) => [name, v[i + j]])); row.event_json = JSON.parse(row.event_json);
        const key = `${row.transcript_id}:${row.source_position}`;
        if (!events.has(key)) { events.set(key, row); rowCount++; }
      }
      return { rowCount };
    }
    if (text.startsWith('UPDATE public.transcripts')) {
      Object.assign(states.get(v[0]), { observed_size: v[1], next_line_no: v[3], next_byte_offset: v[4], event_count: v[5], last_event_sha256: v[6], event_chain_sha256: v[7], projection_chain_sha256: v[8] });
      return { rowCount: 1 };
    }
    if (text.includes('LEFT JOIN public.transcript_events')) return { rows: [{ ...states.get(v[0]), stored_event_count: [...events.values()].filter(row => row.transcript_id === v[0]).length, duplicate_position_count: 0 }] };
    if (text.includes('FROM public.transcript_events')) return { rows: [...events.values()].filter(row => row.transcript_id === v[0] && row.source_position >= v[1] && row.source_position <= v[2]).sort((a, b) => a.source_position - b.source_position) };
    throw new Error(`unexpected test SQL: ${text}`);
  }
  const client = { query, release() {} };
  return { writer: { connect: async () => client }, reader: { query }, stats,
    snapshot() { return structuredClone({ events, states }); },
    tamper(fn) { fn(events, states); } };
}
async function main() {
  const root = fs.mkdtempSync(path.join(__dirname, '..', '.runtime-pg-test-'));
  try {
    const f = fixture(root), db = fakeDatabase();
    const sessionId = 'e'.repeat(64), sourceFile = path.join(f.spoolRoot, 'sources', `${sessionId}.jsonl`);
    const input = { sessionId, requestId: 'one', taskHash: `sha256:${'a'.repeat(64)}`, routeHash: `sha256:${'b'.repeat(64)}`,
      modelHash: 'c'.repeat(64), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), succeeded: true, requestBytes: 'prompt', responseBytes: 'result' };
    const capture = () => captureInvocation(f.spoolRoot, { ...input, requestId: String(Math.random()) });
    const jobFor = hash => JSON.parse(fs.readFileSync(path.join(f.spoolRoot, 'jobs', `${hash.replace(':', '-')}.json`)));
    let job = jobFor(capture().jobHash);
    const sync = selected => syncRuntimeTranscript({ job: selected || job, sourceFile, writer: db.writer, reader: db.reader });
    assert.equal((await sync()).eventCount, 2); assert.equal((await sync()).insertedEvents, 0);
    job = jobFor(capture().jobHash); assert.equal((await sync()).insertedEvents, 2);
    for (let i = 0; i < 65; i++) capture();
    job = jobFor(enqueueSource(f.spoolRoot, sourceFile, sessionId).jobHash);
    assert.equal((await sync()).eventCount, 134); assert.equal(db.stats.maxBatch, 64);
    const baseline = db.snapshot();
    job = jobFor(capture().jobHash);
    const id = `openai-compatible:${sessionId}`;
    db.tamper(events => events.set(`${id}:135`, { ...events.values().next().value, source_position: 135, event_sha256: '0'.repeat(64) }));
    await assert.rejects(sync(), /conflicting transcript event position/);
    assert.equal(db.snapshot().states.get(id).event_count, baseline.states.get(id).event_count);
    assert.equal(db.snapshot().events.has(`${id}:136`), false, 'new rows must roll back after conflict');
    db.tamper(events => events.delete(`${id}:135`)); assert.equal((await sync()).insertedEvents, 2);
    db.tamper(events => { events.values().next().value.event_json.status = 'failed'; });
    await assert.rejects(sync(), /content mismatch/);
    db.tamper(events => { events.values().next().value.event_json.status = 'started'; });
    assert.equal((await sync()).verified, true);
    db.tamper(events => { events.values().next().value.source_byte_offset = 999; });
    await assert.rejects(sync(), /content mismatch/);
    db.tamper(events => { events.values().next().value.source_byte_offset = 0; });
    const original = fs.readFileSync(sourceFile, 'utf8');
    const lines = original.trimEnd().split('\n'); const first = JSON.parse(lines[0]); first.requestId = 'f'.repeat(64); lines[0] = canonicalStringify(first);
    fs.writeFileSync(sourceFile, lines.join('\n') + '\n'); await assert.rejects(sync(), /prefix mismatch/); assert.ok(db.stats.rollbacks > 0);
    fs.writeFileSync(sourceFile, original); assert.equal((await sync()).verified, true);
    const earlyJob = jobFor(fs.readdirSync(path.join(f.spoolRoot, 'jobs')).map(name => JSON.parse(fs.readFileSync(path.join(f.spoolRoot, 'jobs', name)))).sort((a, b) => a.observedSize - b.observedSize)[0].jobHash);
    assert.equal((await sync(earlyJob)).insertedEvents, 0);
    fs.appendFileSync(sourceFile, '{'); await assert.rejects(sync(), /incomplete tail/);
    fs.writeFileSync(sourceFile, original.slice(0, -1)); await assert.rejects(sync(), /identity mismatch/);
    console.log('Harness PostgreSQL: insert/replay/growth/bounds/conflict/prefix/readback/tail checks passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
