#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  POSITION_KIND_LINE,
  POSITION_KIND_ORDINAL,
  PROJECTION_VERSION,
  REDACTION_VERSION,
  collectTranscriptSnapshot,
  projectTranscriptRow,
  validateResumeState,
} = require('./lib/codex-transcript-projection');
const {
  attestTranscriptPostgres,
  assertFullSnapshotMatches,
  assertHeaderMatchesSnapshot,
  buildEventInsert,
  loadPostgresConnectionConfig,
  openTranscriptPostgres,
  syncTranscriptFile,
  verifyFullTranscriptSnapshot,
  verifyTranscriptReadback,
} = require('./lib/codex-transcript-postgres');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

function withTranscript(lines, fn, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-sync-'));
  const sessionsRoot = path.join(root, 'sessions');
  const day = path.join(sessionsRoot, '2026', '08', '25');
  fs.mkdirSync(day, { recursive: true });
  const transcriptId = options.transcriptId || '01a0376a-348a-79a1-a661-b2d08726726b';
  const file = path.join(day, `rollout-2026-08-25T13-35-02-${transcriptId}.jsonl`);
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}${options.trailingNewline === false ? '' : '\n'}`);
  return Promise.resolve(fn({ root, sessionsRoot, file, transcriptId }))
    .finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

function meta(transcriptId, overrides = {}, ordinal = 0) {
  return {
    ...(ordinal === null ? {} : { ordinal }),
    timestamp: '2026-08-25T05:35:02.000Z',
    type: 'session_meta',
    payload: {
      id: transcriptId,
      session_id: transcriptId,
      timestamp: '2026-08-25T05:35:02.000Z',
      cwd: 'C:\\project\\example',
      originator: 'Codex Desktop',
      cli_version: '0.147.0',
      source: 'vscode',
      model_provider: 'openai',
      base_instructions: 'must never leave the host',
      ...overrides,
    },
  };
}

function userRow(ordinal, message = 'hello') {
  return {
    ...(ordinal === null ? {} : { ordinal }),
    timestamp: '2026-08-25T05:35:03.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: message }],
    },
  };
}

function privilegeAttestation(role, overrides = {}) {
  const reader = role === 'reader';
  return {
    role_name: role,
    database_name: 'tech_persistence',
    transaction_read_only: reader,
    is_superuser: false,
    bypass_rls: false,
    can_use_schema: true,
    can_create_schema: false,
    owns_transcripts: false,
    owns_transcript_events: false,
    can_select_transcripts: reader,
    can_select_transcript_events: reader,
    can_insert_transcripts: !reader,
    can_insert_transcript_events: !reader,
    can_update_transcripts: false,
    can_update_transcript_events: false,
    can_delete_transcripts: false,
    can_delete_transcript_events: false,
    can_truncate_transcripts: false,
    can_truncate_transcript_events: false,
    can_select_transcript_state: true,
    can_update_transcript_state: !reader,
    can_select_event_evidence: true,
    can_select_metadata_json: reader,
    can_select_event_json: reader,
    ...overrides,
  };
}

test('PostgreSQL config follows the strict split read/write URL contract', () => {
  const write = loadPostgresConnectionConfig({
    TRANSCRIPTS_POSTGRES_WRITE_URL: 'postgresql://writer:private@127.0.0.1:55433/tech_persistence',
    TRANSCRIPTS_POSTGRES_SSL: 'false',
  }, 'write');
  assert.strictEqual(write.ssl, false);
  assert.match(write.url, /^postgresql:\/\/writer:/);

  assert.throws(() => loadPostgresConnectionConfig({
    TRANSCRIPTS_POSTGRES_URL: 'postgresql://writer:private@127.0.0.1:55433/tech_persistence',
    TRANSCRIPTS_POSTGRES_WRITE_URL: 'postgresql://writer:private@127.0.0.1:55433/tech_persistence',
  }, 'write'), /TRANSCRIPTS_POSTGRES_URL is not supported/i);
  assert.throws(() => loadPostgresConnectionConfig({
    TRANSCRIPTS_POSTGRES_URL: 'postgresql://writer:private@127.0.0.1:55433/tech_persistence',
  }, 'write'), /TRANSCRIPTS_POSTGRES_URL is not supported/i);
  assert.throws(() => loadPostgresConnectionConfig({
    TRANSCRIPTS_POSTGRES_WRITE_URL: 'https://db.example.test/tech_persistence',
  }, 'write'), /postgresql:\/\//i);
  assert.throws(() => loadPostgresConnectionConfig({
    TRANSCRIPTS_POSTGRES_WRITE_URL: 'postgresql://writer:private@db.example.test/tech_persistence',
    TRANSCRIPTS_POSTGRES_SSL: 'false',
  }, 'write'), /TLS is required for non-loopback PostgreSQL hosts/i);
  const tls = loadPostgresConnectionConfig({
    TRANSCRIPTS_POSTGRES_WRITE_URL: 'postgresql://writer:private@db.example.test/tech_persistence',
    TRANSCRIPTS_POSTGRES_SSL: 'true',
  }, 'write');
  assert.strictEqual(tls.ssl, true);
  assert.throws(() => loadPostgresConnectionConfig({
    TRANSCRIPTS_POSTGRES_WRITE_URL: 'postgresql://writer@127.0.0.1:55433/tech_persistence',
  }, 'write'), /host, user, password, and database/i);
});

test('PostgreSQL open requires distinct reader and writer credentials', async () => {
  class FakePool {
    constructor(config) {
      this.config = config;
    }

    async query() {
      const role = this.config.connectionString.includes('reader:') ? 'reader' : 'writer';
      return { rows: [privilegeAttestation(role)] };
    }

    async end() {}
  }

  const writeUrl = 'postgresql://writer:private@127.0.0.1:55433/tech_persistence';
  await assert.rejects(openTranscriptPostgres({
    env: { TRANSCRIPTS_POSTGRES_WRITE_URL: writeUrl },
    pg: { Pool: FakePool },
  }), /TRANSCRIPTS_POSTGRES_READ_URL/i);

  await assert.rejects(openTranscriptPostgres({
    env: {
      TRANSCRIPTS_POSTGRES_WRITE_URL: writeUrl,
      TRANSCRIPTS_POSTGRES_READ_URL: writeUrl,
    },
    pg: { Pool: FakePool },
  }), /distinct reader and writer credentials/i);

  const database = await openTranscriptPostgres({
    env: {
      TRANSCRIPTS_POSTGRES_WRITE_URL: writeUrl,
      TRANSCRIPTS_POSTGRES_READ_URL: 'postgresql://reader:readonly@127.0.0.1:55433/tech_persistence',
    },
    pg: { Pool: FakePool },
  });
  assert.strictEqual(database.separateReader, true);
  assert.notStrictEqual(database.writer.config.connectionString, database.reader.config.connectionString);
  await database.close();
});

test('PostgreSQL privilege attestation proves independent least-privilege roles', async () => {
  const pool = (row) => ({ async query() { return { rows: [row] }; } });
  const good = await attestTranscriptPostgres(
    pool(privilegeAttestation('writer')),
    pool(privilegeAttestation('reader'))
  );
  assert.strictEqual(good.separateReader, true);

  await assert.rejects(attestTranscriptPostgres(
    pool(privilegeAttestation('shared')),
    pool(privilegeAttestation('shared', { transaction_read_only: true }))
  ), /distinct PostgreSQL roles/i);
  await assert.rejects(attestTranscriptPostgres(
    pool(privilegeAttestation('writer')),
    pool(privilegeAttestation('reader', { can_insert_transcripts: true }))
  ), /reader privilege attestation failed/i);
  await assert.rejects(attestTranscriptPostgres(
    pool(privilegeAttestation('writer', { can_select_event_json: true })),
    pool(privilegeAttestation('reader'))
  ), /writer privilege attestation failed/i);
});

test('queued SessionEnd observations reject a truncated or older transcript before PostgreSQL access', () => (
  withTranscript([
    meta('01a0376a-348a-79a1-a661-b2d08726726b'),
    userRow(1),
  ], async ({ sessionsRoot, file }) => {
    const stat = fs.statSync(file);
    const unreachableWriter = {
      connect: async () => {
        throw new Error('PostgreSQL must not be reached for a stale outbox observation');
      },
    };
    const reader = {};

    await assert.rejects(syncTranscriptFile(file, {
      sessionsRoot,
      writer: unreachableWriter,
      reader,
      expectedObservedSize: stat.size + 1,
    }), /smaller than the queued SessionEnd observation/i);

    await assert.rejects(syncTranscriptFile(file, {
      sessionsRoot,
      writer: unreachableWriter,
      reader,
      expectedMtime: new Date(stat.mtimeMs + 60_000).toISOString(),
    }), /older than the queued SessionEnd observation/i);
  })
));

test('snapshot coherence rejects header replacement and historical prefix rewrites', () => {
  const transcript = {
    transcriptId: '01a0376a-348a-79a1-a661-b2d08726726b',
    rootSessionId: 'thr_123',
    parentThreadId: null,
    positionKind: 'ordinal',
  };
  const header = {
    transcript,
    pathHash: 'a'.repeat(64),
    fileIdentityHash: 'b'.repeat(64),
    observedSize: 300,
    sourceMtimeMs: 1_777_000_000_000,
  };
  const snapshot = {
    ...header,
    nextByteOffset: 300,
    nextLineNo: 4,
    lastOrdinal: 2,
    lastEventByteOffset: 200,
    lastEventByteLength: 99,
    lastEventSha256: 'c'.repeat(64),
    eventCount: 3,
    eventChainSha256: 'd'.repeat(64),
    projectionChainSha256: 'e'.repeat(64),
    trailingBytes: 0,
  };
  assert.doesNotThrow(() => assertHeaderMatchesSnapshot(header, snapshot));
  assert.throws(() => assertHeaderMatchesSnapshot(header, {
    ...snapshot,
    fileIdentityHash: 'f'.repeat(64),
  }), /changed between inspection and streaming/i);
  assert.doesNotThrow(() => assertFullSnapshotMatches(snapshot, { ...snapshot }));
  assert.throws(() => assertFullSnapshotMatches(snapshot, {
    ...snapshot,
    eventChainSha256: 'f'.repeat(64),
  }), /historical prefix does not match/i);
});

test('v2 worker recomputes the full chain and rejects a same-inode middle-line rewrite', () => (
  withTranscript([
    meta('01a0376a-348a-79a1-a661-b2d08726726b'),
    userRow(1, 'AAAA'),
    userRow(2, 'last-anchor'),
  ], async ({ sessionsRoot, file }) => {
    const expected = await collectTranscriptSnapshot(file, { sessionsRoot });
    const before = fs.statSync(file);
    const original = fs.readFileSync(file, 'utf8');
    const rewritten = original.replace('AAAA', 'BBBB');
    assert.notStrictEqual(rewritten, original);
    assert.strictEqual(Buffer.byteLength(rewritten), Buffer.byteLength(original));
    fs.writeFileSync(file, rewritten);
    fs.utimesSync(file, before.atime, before.mtime);
    const after = fs.statSync(file);
    assert.strictEqual(after.size, before.size);

    await assert.rejects(verifyFullTranscriptSnapshot(file, {
      sessionsRoot,
      expectedPathHash: expected.pathHash,
      expectedFileIdentityHash: expected.fileIdentityHash,
    }, expected), /historical prefix does not match/i);
  })
));

test('safe projection removes internal instructions and reasoning while redacting secrets', () => {
  const projectedMeta = projectTranscriptRow(meta(
    '01a0376a-348a-79a1-a661-b2d08726726b',
    { database_url: 'postgresql://admin:secret@db/private' }
  ));
  const serializedMeta = JSON.stringify(projectedMeta);
  assert(!serializedMeta.includes('must never leave the host'));
  assert(!serializedMeta.includes('admin:secret'));
  assert(serializedMeta.includes('[INTERNAL CONTENT OMITTED]'));
  assert(!serializedMeta.includes('database_url'));

  const projectedReasoning = projectTranscriptRow({
    ordinal: 2,
    timestamp: '2026-08-25T05:35:04.000Z',
    type: 'response_item',
    payload: {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'private chain of thought' }],
      encrypted_content: 'ciphertext',
    },
  });
  const serializedReasoning = JSON.stringify(projectedReasoning);
  assert(!serializedReasoning.includes('private chain of thought'));
  assert(!serializedReasoning.includes('ciphertext'));
  assert(serializedReasoning.includes('[INTERNAL CONTENT OMITTED]'));

  const projectedDeveloper = projectTranscriptRow({
    ordinal: 3,
    timestamp: '2026-08-25T05:35:05.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: 'hidden developer policy' },
  });
  assert(!JSON.stringify(projectedDeveloper).includes('hidden developer policy'));
});

test('safe projection handles real compacted, completed reasoning, and world state shapes', () => {
  const projectedCompacted = projectTranscriptRow({
    ordinal: 4,
    timestamp: '2026-08-25T05:35:06.000Z',
    type: 'compacted',
    payload: {
      message: 'public compacted summary',
      replacement_history: [
        {
          type: 'message',
          id: 'developer-history',
          role: 'developer',
          content: [{ type: 'input_text', text: 'hidden compacted developer policy' }],
          internal_chat_message_metadata_passthrough: { instructions: 'hidden passthrough' },
        },
        {
          type: 'message',
          id: 'system-history',
          role: 'system',
          content: [{ type: 'input_text', text: 'hidden compacted system policy' }],
        },
        {
          type: 'message',
          id: 'user-history',
          role: 'user',
          content: [{ type: 'input_text', text: 'preserved compacted user message' }],
        },
        {
          type: 'compaction',
          id: 'compaction-history',
          encrypted_content: 'hidden compacted ciphertext',
        },
      ],
      window_number: 2,
      first_window_id: 'window-1',
      previous_window_id: 'window-1',
      window_id: 'window-2',
      future_internal_blob: 'hidden unknown compacted field',
    },
  });
  const serializedCompacted = JSON.stringify(projectedCompacted);
  assert(serializedCompacted.includes('preserved compacted user message'));
  assert(!serializedCompacted.includes('hidden compacted developer policy'));
  assert(!serializedCompacted.includes('hidden compacted system policy'));
  assert(!serializedCompacted.includes('hidden passthrough'));
  assert(!serializedCompacted.includes('hidden compacted ciphertext'));
  assert(!serializedCompacted.includes('hidden unknown compacted field'));

  const projectedCompletedReasoning = projectTranscriptRow({
    ordinal: 5,
    timestamp: '2026-08-25T05:35:07.000Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: '01a0376a-348a-79a1-a661-b2d08726726b',
      turn_id: '01a0376a-0000-7000-8000-000000000001',
      item: {
        type: 'Reasoning',
        id: 'rs_private',
        summary_text: ['hidden completed reasoning summary'],
        raw_content: ['hidden completed reasoning raw content'],
      },
      started_at_ms: 1,
      completed_at_ms: 2,
    },
  });
  const serializedCompletedReasoning = JSON.stringify(projectedCompletedReasoning);
  assert(!serializedCompletedReasoning.includes('hidden completed reasoning summary'));
  assert(!serializedCompletedReasoning.includes('hidden completed reasoning raw content'));
  assert(serializedCompletedReasoning.includes('rs_private'));

  const projectedWorldState = projectTranscriptRow({
    ordinal: 6,
    timestamp: '2026-08-25T05:35:08.000Z',
    type: 'world_state',
    payload: {
      full: true,
      state: {
        agents_md: { text: 'hidden agents md' },
        permissions: { instructions: 'hidden permissions instructions' },
        plugins_instructions: { body: 'hidden plugin instructions' },
        skills: { body: 'hidden skill instructions' },
        instructions: 'hidden generic instructions',
        host_skills: { body: 'hidden host skill instructions' },
      },
    },
  });
  const serializedWorldState = JSON.stringify(projectedWorldState);
  for (const secret of [
    'hidden agents md',
    'hidden permissions instructions',
    'hidden plugin instructions',
    'hidden skill instructions',
    'hidden generic instructions',
    'hidden host skill instructions',
  ]) {
    assert(!serializedWorldState.includes(secret));
  }
  assert.strictEqual(projectedWorldState.ordinal, 6);
  assert.strictEqual(projectedWorldState.timestamp, '2026-08-25T05:35:08.000Z');
  assert.strictEqual(projectedWorldState.type, 'world_state');

  const projectedUnknown = projectTranscriptRow({
    ordinal: 7,
    timestamp: '2026-08-25T05:35:09.000Z',
    type: 'event_msg',
    payload: {
      type: 'future_internal_event',
      thread_id: '01a0376a-348a-79a1-a661-b2d08726726b',
      internal_blob: 'hidden future internal payload',
    },
  });
  assert(!JSON.stringify(projectedUnknown).includes('hidden future internal payload'));
  assert.strictEqual(projectedUnknown.type, 'event_msg');
  assert.strictEqual(projectedUnknown.payload.type, 'future_internal_event');
});

test('snapshot reader uses physical transcript id and ordinal positions', async () => {
  const transcriptId = '01a0376a-348a-79a1-a661-b2d08726726b';
  await withTranscript([
    meta(transcriptId, {
      session_id: '01a0376a-0000-7000-8000-000000000001',
      parent_thread_id: '01a0376a-0000-7000-8000-000000000002',
    }),
    userRow(1, 'token=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
  ], async ({ sessionsRoot, file }) => {
    const snapshot = await collectTranscriptSnapshot(file, { sessionsRoot });
    assert.strictEqual(snapshot.transcript.transcriptId, transcriptId);
    assert.strictEqual(snapshot.transcript.rootSessionId, '01a0376a-0000-7000-8000-000000000001');
    assert.strictEqual(snapshot.transcript.parentThreadId, '01a0376a-0000-7000-8000-000000000002');
    assert.strictEqual(snapshot.transcript.positionKind, POSITION_KIND_ORDINAL);
    assert.deepStrictEqual(snapshot.events.map((event) => event.sourcePosition), [0, 1]);
    assert(snapshot.events.every((event) => /^[a-f0-9]{64}$/.test(event.eventSha256)));
    assert(!JSON.stringify(snapshot.events).includes('sk-proj-AAAA'));
    assert.strictEqual(snapshot.projectionVersion, PROJECTION_VERSION);
    assert.strictEqual(snapshot.redactionVersion, REDACTION_VERSION);
  });
});

test('root session identifiers follow the official bounded opaque SessionEnd contract', async () => {
  const transcriptId = '01a0376a-348a-79a1-a661-b2d08726726b';
  await withTranscript([
    meta(transcriptId, { session_id: 'thr_123' }),
    userRow(1),
  ], async ({ sessionsRoot, file }) => {
    const snapshot = await collectTranscriptSnapshot(file, {
      sessionsRoot,
      expectedRootSessionId: 'thr_123',
    });
    assert.strictEqual(snapshot.transcript.rootSessionId, 'thr_123');
    await assert.rejects(
      collectTranscriptSnapshot(file, {
        sessionsRoot,
        expectedRootSessionId: 'thr_different',
      }),
      /does not match/i
    );
  });
});

test('legacy snapshot reader falls back to 1-based line positions', async () => {
  const transcriptId = '01a0376a-348a-79a1-a661-b2d08726726b';
  await withTranscript([
    meta(transcriptId, {}, null),
    userRow(null),
  ], async ({ sessionsRoot, file }) => {
    const snapshot = await collectTranscriptSnapshot(file, { sessionsRoot });
    assert.strictEqual(snapshot.transcript.positionKind, POSITION_KIND_LINE);
    assert.deepStrictEqual(snapshot.events.map((event) => event.sourcePosition), [1, 2]);
  });
});

test('reader rejects paths outside the trusted sessions root and mixed position formats', async () => {
  const transcriptId = '01a0376a-348a-79a1-a661-b2d08726726b';
  await withTranscript([meta(transcriptId), userRow(null)], async ({ root, sessionsRoot, file }) => {
    await assert.rejects(
      collectTranscriptSnapshot(file, { sessionsRoot }),
      /mixes ordinal and legacy line positions/i
    );
    const outside = path.join(root, 'outside.jsonl');
    fs.copyFileSync(file, outside);
    await assert.rejects(
      collectTranscriptSnapshot(outside, { sessionsRoot }),
      /outside the trusted Codex sessions root/i
    );
  });
});

test('stream reader enforces the outbox file identity on every reopen', async () => {
  const transcriptId = '01a0376a-348a-79a1-a661-b2d08726726b';
  await withTranscript([meta(transcriptId), userRow(1)], async ({ sessionsRoot, file }) => {
    await assert.rejects(collectTranscriptSnapshot(file, {
      sessionsRoot,
      expectedFileIdentityHash: 'f'.repeat(64),
    }), /file identity does not match the expected snapshot/i);
  });
});

test('reader leaves a trailing partial JSON line for the next incremental sync', async () => {
  const transcriptId = '01a0376a-348a-79a1-a661-b2d08726726b';
  await withTranscript([meta(transcriptId), userRow(1)], async ({ sessionsRoot, file }) => {
    fs.appendFileSync(file, '{"ordinal":2');
    const snapshot = await collectTranscriptSnapshot(file, { sessionsRoot });
    assert.strictEqual(snapshot.events.length, 2);
    assert(snapshot.trailingBytes > 0);
    assert(snapshot.nextByteOffset < snapshot.observedSize);
  });
});

test('single-line snapshot preserves a zero byte anchor across an empty incremental read', async () => {
  const transcriptId = '01a0376a-348a-79a1-a661-b2d08726726b';
  await withTranscript([meta(transcriptId)], async ({ sessionsRoot, file }) => {
    const first = await collectTranscriptSnapshot(file, { sessionsRoot });
    assert.strictEqual(first.events.length, 1);
    assert.strictEqual(first.lastEventByteOffset, 0);

    const second = await collectTranscriptSnapshot(file, {
      sessionsRoot,
      positionKind: first.transcript.positionKind,
      startByteOffset: first.nextByteOffset,
      nextLineNo: first.nextLineNo,
      lastOrdinal: first.lastOrdinal,
      lastEventByteOffset: first.lastEventByteOffset,
      lastEventByteLength: first.lastEventByteLength,
      lastEventSha256: first.lastEventSha256,
      lastEventTimestamp: first.lastEventTimestamp,
      eventCount: first.eventCount,
      eventChainSha256: first.eventChainSha256,
      projectionChainSha256: first.projectionChainSha256,
    });
    assert.strictEqual(second.events.length, 0);
    assert.strictEqual(second.lastEventByteOffset, 0);
    assert.strictEqual(second.lastEventByteLength, first.lastEventByteLength);
    assert.strictEqual(second.lastEventSha256, first.lastEventSha256);
  });
});

test('snapshot reader assembles one JSON line across multiple read chunks', async () => {
  const transcriptId = '01a0376a-348a-79a1-a661-b2d08726726b';
  const message = `begin-${'chunk boundary content '.repeat(8 * 1024)}-end`;
  await withTranscript([meta(transcriptId), userRow(1, message)], async ({ sessionsRoot, file }) => {
    const snapshot = await collectTranscriptSnapshot(file, { sessionsRoot });
    assert.strictEqual(snapshot.events.length, 2);
    assert.strictEqual(snapshot.events[1].eventJson.payload.content[0].text, message);
    assert(snapshot.events[1].sourceByteLength > 2 * 64 * 1024);
    assert.strictEqual(snapshot.trailingBytes, 0);
  });
});

test('resume validation accepts append-only growth and rejects truncation or replacement', () => {
  const state = {
    fileIdentityHash: 'a'.repeat(64),
    nextByteOffset: 120,
    lastEventByteOffset: 50,
    lastEventByteLength: 69,
    lastEventSha256: 'b'.repeat(64),
  };
  assert.doesNotThrow(() => validateResumeState(state, {
    fileIdentityHash: 'a'.repeat(64),
    observedSize: 200,
    anchorSha256: 'b'.repeat(64),
  }));
  assert.throws(() => validateResumeState(state, {
    fileIdentityHash: 'a'.repeat(64), observedSize: 100, anchorSha256: 'b'.repeat(64),
  }), /truncated/i);
  assert.throws(() => validateResumeState(state, {
    fileIdentityHash: 'c'.repeat(64), observedSize: 200, anchorSha256: 'b'.repeat(64),
  }), /identity changed/i);
  assert.throws(() => validateResumeState(state, {
    fileIdentityHash: 'a'.repeat(64), observedSize: 200, anchorSha256: 'd'.repeat(64),
  }), /anchor changed/i);
});

test('event insert is parameterized and conflicts never overwrite evidence', () => {
  const event = {
    transcriptId: '01a0376a-348a-79a1-a661-b2d08726726b',
    positionKind: 'ordinal', sourcePosition: 1, sourceByteOffset: 100,
    sourceByteLength: 120, eventTimestamp: '2026-08-25T05:35:03.000Z',
    outerType: 'response_item', payloadType: 'message', explicitTurnId: null,
    itemId: null, callId: null, eventSha256: 'a'.repeat(64),
    projectionSha256: 'b'.repeat(64), eventJson: { text: "Robert'); DROP TABLE transcripts;--" },
  };
  const statement = buildEventInsert([event]);
  assert.match(statement.text, /ON CONFLICT \(transcript_id, position_kind, source_position\) DO NOTHING/i);
  assert(!statement.text.includes('Robert'));
  assert(statement.values.some((value) => typeof value === 'string' && value.includes('Robert')));
});

test('independent readback requires exact count, cursor, and hashes', async () => {
  const expected = {
    transcriptId: '01a0376a-348a-79a1-a661-b2d08726726b',
    eventCount: 2,
    nextByteOffset: 240,
    lastEventSha256: 'a'.repeat(64),
    eventChainSha256: 'b'.repeat(64),
    projectionChainSha256: 'c'.repeat(64),
  };
  const reader = {
    async query() {
      return { rows: [{
        transcript_id: expected.transcriptId,
        event_count: '2',
        stored_event_count: '2',
        duplicate_position_count: '0',
        next_byte_offset: '240',
        last_event_sha256: expected.lastEventSha256,
        event_chain_sha256: expected.eventChainSha256,
        projection_chain_sha256: expected.projectionChainSha256,
      }] };
    },
  };
  const result = await verifyTranscriptReadback(reader, expected);
  assert.strictEqual(result.verified, true);

  const badReader = { async query() { return { rows: [{ ...(await reader.query()).rows[0], stored_event_count: '1' }] }; } };
  await assert.rejects(verifyTranscriptReadback(badReader, expected), /readback mismatch/i);
});

(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const { name, error } of failures) {
      console.error(`\n[${name}]\n${error.stack || error.message}`);
    }
    process.exitCode = 1;
  }
})();
