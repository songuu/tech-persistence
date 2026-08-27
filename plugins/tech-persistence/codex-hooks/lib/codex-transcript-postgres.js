'use strict';

const {
  PROJECTION_VERSION,
  REDACTION_VERSION,
  inspectTranscriptFile,
  readAnchorSha256,
  streamTranscriptSnapshot,
  validateResumeState,
} = require('./codex-transcript-projection');
const { redactSensitiveText } = require('./redaction');

const EVENT_COLUMNS = Object.freeze([
  'transcript_id',
  'position_kind',
  'source_position',
  'source_byte_offset',
  'source_byte_length',
  'event_timestamp',
  'outer_type',
  'payload_type',
  'explicit_turn_id',
  'item_id',
  'call_id',
  'event_sha256',
  'projection_sha256',
  'event_json',
]);
const EVENT_FIELD_ORDER = Object.freeze([
  'transcriptId',
  'positionKind',
  'sourcePosition',
  'sourceByteOffset',
  'sourceByteLength',
  'eventTimestamp',
  'outerType',
  'payloadType',
  'explicitTurnId',
  'itemId',
  'callId',
  'eventSha256',
  'projectionSha256',
  'eventJson',
]);
const CHAIN_SEED = '0'.repeat(64);

function parseBoolean(value, name) {
  if (value === undefined || String(value).trim() === '') return false;
  if (/^(1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(0|false|no|off)$/i.test(String(value))) return false;
  throw new Error(`${name} must be true or false`);
}

function postgresUrlName(purpose) {
  return purpose === 'read'
    ? 'TRANSCRIPTS_POSTGRES_READ_URL'
    : 'TRANSCRIPTS_POSTGRES_WRITE_URL';
}

/** Parse one private PostgreSQL URL without ever returning a loggable summary. */
function loadPostgresConnectionConfig(source, purpose) {
  if (!['read', 'write'].includes(purpose)) throw new Error('PostgreSQL purpose is invalid');
  const specificName = postgresUrlName(purpose);
  const specific = typeof source[specificName] === 'string' ? source[specificName].trim() : '';
  const common = typeof source.TRANSCRIPTS_POSTGRES_URL === 'string'
    ? source.TRANSCRIPTS_POSTGRES_URL.trim()
    : '';
  if (common) {
    throw new Error(
      'TRANSCRIPTS_POSTGRES_URL is not supported; configure distinct '
      + 'TRANSCRIPTS_POSTGRES_READ_URL and TRANSCRIPTS_POSTGRES_WRITE_URL credentials'
    );
  }
  const value = specific;
  if (!value) throw new Error(`Missing required PostgreSQL env var: ${specificName}`);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${specificName} must be a postgresql:// URL with host, user, password, and database`);
  }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)
      || !parsed.hostname || !parsed.username || !parsed.password
      || !parsed.pathname || parsed.pathname === '/' || parsed.search || parsed.hash) {
    throw new Error(`${specificName} must be a postgresql:// URL with host, user, password, and database`);
  }
  let database;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error(`${specificName} must contain one valid database path segment`);
  }
  if (!database || database.includes('/')) {
    throw new Error(`${specificName} must contain one valid database path segment`);
  }
  const ssl = parseBoolean(source.TRANSCRIPTS_POSTGRES_SSL, 'TRANSCRIPTS_POSTGRES_SSL');
  const hostname = parsed.hostname.toLowerCase();
  if (!ssl && !['127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('TLS is required for non-loopback PostgreSQL hosts');
  }
  return {
    url: parsed.toString(),
    ssl,
    source: specificName,
  };
}

async function loadPgModule(options = {}) {
  if (options.pg) return options.pg;
  try {
    const moduleName = 'pg';
    return await import(moduleName);
  } catch (error) {
    throw new Error(
      `Codex transcript PostgreSQL sync requires pg: ${redactSensitiveText(error && error.message || String(error))}`
    );
  }
}

async function openPostgresPool(config, purpose, options = {}) {
  const pg = await loadPgModule(options);
  const Pool = pg.Pool || (pg.default && pg.default.Pool);
  if (typeof Pool !== 'function') throw new Error('pg does not expose Pool');
  return new Pool({
    connectionString: config.url,
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: `tech-persistence-transcript-${purpose}`,
  });
}

const PRIVILEGE_ATTESTATION_QUERY = `
WITH transcript_state_select_columns(column_name) AS (
  VALUES
    ('transcript_id'), ('root_session_id'), ('parent_thread_id'), ('path_hash'),
    ('file_identity_hash'), ('position_kind'), ('observed_size'), ('observed_mtime'),
    ('next_byte_offset'), ('next_line_no'), ('last_ordinal'),
    ('last_event_byte_offset'), ('last_event_byte_length'), ('last_event_sha256'),
    ('event_chain_sha256'), ('projection_chain_sha256'), ('event_count'),
    ('projection_version'), ('redaction_version'), ('last_event_at')
), transcript_state_update_columns(column_name) AS (
  VALUES
    ('observed_size'), ('observed_mtime'), ('next_byte_offset'), ('next_line_no'),
    ('last_ordinal'), ('last_event_byte_offset'), ('last_event_byte_length'),
    ('last_event_sha256'), ('event_chain_sha256'), ('projection_chain_sha256'),
    ('event_count'), ('last_event_at'), ('updated_at'), ('last_synced_at')
), event_evidence_columns(column_name) AS (
  VALUES
    ('transcript_id'), ('position_kind'), ('source_position'),
    ('event_sha256'), ('projection_sha256')
)
SELECT
  current_user AS role_name,
  current_database() AS database_name,
  current_setting('transaction_read_only')::boolean AS transaction_read_only,
  (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS is_superuser,
  (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user) AS bypass_rls,
  has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_schema,
  has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema,
  pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
    WHERE oid = 'public.transcripts'::regclass)) = current_user AS owns_transcripts,
  pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
    WHERE oid = 'public.transcript_events'::regclass)) = current_user AS owns_transcript_events,
  has_table_privilege(current_user, 'public.transcripts', 'SELECT') AS can_select_transcripts,
  has_table_privilege(current_user, 'public.transcript_events', 'SELECT')
    AS can_select_transcript_events,
  has_table_privilege(current_user, 'public.transcripts', 'INSERT') AS can_insert_transcripts,
  has_table_privilege(current_user, 'public.transcript_events', 'INSERT')
    AS can_insert_transcript_events,
  has_table_privilege(current_user, 'public.transcripts', 'UPDATE') AS can_update_transcripts,
  has_table_privilege(current_user, 'public.transcript_events', 'UPDATE')
    AS can_update_transcript_events,
  has_table_privilege(current_user, 'public.transcripts', 'DELETE') AS can_delete_transcripts,
  has_table_privilege(current_user, 'public.transcript_events', 'DELETE')
    AS can_delete_transcript_events,
  has_table_privilege(current_user, 'public.transcripts', 'TRUNCATE') AS can_truncate_transcripts,
  has_table_privilege(current_user, 'public.transcript_events', 'TRUNCATE')
    AS can_truncate_transcript_events,
  NOT EXISTS (
    SELECT 1 FROM transcript_state_select_columns
    WHERE NOT has_column_privilege(
      current_user, 'public.transcripts', column_name, 'SELECT'
    )
  ) AS can_select_transcript_state,
  NOT EXISTS (
    SELECT 1 FROM transcript_state_update_columns
    WHERE NOT has_column_privilege(
      current_user, 'public.transcripts', column_name, 'UPDATE'
    )
  ) AS can_update_transcript_state,
  NOT EXISTS (
    SELECT 1 FROM event_evidence_columns
    WHERE NOT has_column_privilege(
      current_user, 'public.transcript_events', column_name, 'SELECT'
    )
  ) AS can_select_event_evidence,
  has_column_privilege(current_user, 'public.transcripts', 'metadata_json', 'SELECT')
    AS can_select_metadata_json,
  has_column_privilege(current_user, 'public.transcript_events', 'event_json', 'SELECT')
    AS can_select_event_json`;

function attestationMatches(row, expectedTrue, expectedFalse) {
  return row
    && expectedTrue.every((field) => row[field] === true)
    && expectedFalse.every((field) => row[field] === false);
}

async function attestTranscriptPostgres(writer, reader) {
  let writerResult;
  let readerResult;
  try {
    [writerResult, readerResult] = await Promise.all([
      writer.query(PRIVILEGE_ATTESTATION_QUERY),
      reader.query(PRIVILEGE_ATTESTATION_QUERY),
    ]);
  } catch (error) {
    throw new Error(
      `PostgreSQL privilege attestation query failed: ${redactSensitiveText(
        error && error.message || String(error)
      )}`
    );
  }
  if (!writerResult || writerResult.rows.length !== 1
      || !readerResult || readerResult.rows.length !== 1) {
    throw new Error('PostgreSQL privilege attestation returned an invalid result');
  }
  const writerRow = writerResult.rows[0];
  const readerRow = readerResult.rows[0];
  if (!writerRow.role_name || writerRow.role_name === readerRow.role_name
      || writerRow.database_name !== readerRow.database_name) {
    throw new Error('Transcript sync requires distinct PostgreSQL roles in the same database');
  }
  const commonDenied = [
    'is_superuser',
    'bypass_rls',
    'can_create_schema',
    'owns_transcripts',
    'owns_transcript_events',
    'can_delete_transcripts',
    'can_delete_transcript_events',
    'can_truncate_transcripts',
    'can_truncate_transcript_events',
  ];
  if (!attestationMatches(readerRow, [
    'transaction_read_only',
    'can_use_schema',
    'can_select_transcripts',
    'can_select_transcript_events',
    'can_select_transcript_state',
    'can_select_event_evidence',
    'can_select_metadata_json',
    'can_select_event_json',
  ], [
    ...commonDenied,
    'can_insert_transcripts',
    'can_insert_transcript_events',
    'can_update_transcripts',
    'can_update_transcript_events',
    'can_update_transcript_state',
  ])) {
    throw new Error('PostgreSQL transcript reader privilege attestation failed');
  }
  if (!attestationMatches(writerRow, [
    'can_use_schema',
    'can_insert_transcripts',
    'can_insert_transcript_events',
    'can_select_transcript_state',
    'can_update_transcript_state',
    'can_select_event_evidence',
  ], [
    'transaction_read_only',
    ...commonDenied,
    'can_select_transcripts',
    'can_select_transcript_events',
    'can_update_transcripts',
    'can_update_transcript_events',
    'can_select_metadata_json',
    'can_select_event_json',
  ])) {
    throw new Error('PostgreSQL transcript writer privilege attestation failed');
  }
  return { separateReader: true };
}

async function openTranscriptPostgres(options = {}) {
  const env = options.env || process.env;
  const writeConfig = loadPostgresConnectionConfig(env, 'write');
  const readConfig = loadPostgresConnectionConfig(env, 'read');
  if (readConfig.url === writeConfig.url) {
    throw new Error('PostgreSQL transcript sync requires distinct reader and writer credentials');
  }
  const writer = await openPostgresPool(writeConfig, 'writer', options);
  let reader;
  try {
    reader = await openPostgresPool(readConfig, 'reader', options);
  } catch (error) {
    await writer.end();
    throw error;
  }
  try {
    await attestTranscriptPostgres(writer, reader);
  } catch (error) {
    await Promise.allSettled([reader.end(), writer.end()]);
    throw error;
  }
  return {
    writer,
    reader,
    separateReader: true,
    async close() {
      const results = await Promise.allSettled([reader.end(), writer.end()]);
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    },
  };
}

function buildEventInsert(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('at least one transcript event is required');
  }
  const values = [];
  const tuples = events.map((event) => {
    const placeholders = EVENT_FIELD_ORDER.map((field) => {
      const value = field === 'eventJson' ? JSON.stringify(event[field]) : event[field];
      values.push(value === undefined ? null : value);
      const placeholder = `$${values.length}`;
      return field === 'eventJson' ? `${placeholder}::jsonb` : placeholder;
    });
    return `(${placeholders.join(', ')})`;
  });
  return {
    text: [
      `INSERT INTO public.transcript_events (${EVENT_COLUMNS.join(', ')})`,
      `VALUES ${tuples.join(', ')}`,
      'ON CONFLICT (transcript_id, position_kind, source_position) DO NOTHING',
    ].join('\n'),
    values,
  };
}

function numberValue(value, label, options = {}) {
  if (options.nullable && (value === null || value === undefined)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (options.minimum || 0)) {
    throw new Error(`stored ${label} is invalid`);
  }
  return parsed;
}

function mapTranscriptState(row) {
  if (!row) return null;
  return {
    transcriptId: row.transcript_id,
    rootSessionId: row.root_session_id,
    parentThreadId: row.parent_thread_id,
    pathHash: row.path_hash,
    fileIdentityHash: row.file_identity_hash,
    positionKind: row.position_kind,
    observedSize: numberValue(row.observed_size, 'observed size'),
    sourceMtimeMs: Number(row.observed_mtime),
    nextByteOffset: numberValue(row.next_byte_offset, 'next byte offset'),
    nextLineNo: numberValue(row.next_line_no, 'next line number', { minimum: 1 }),
    lastOrdinal: numberValue(row.last_ordinal, 'last ordinal', { nullable: true }),
    lastEventByteOffset: numberValue(row.last_event_byte_offset, 'last event offset', { nullable: true }),
    lastEventByteLength: numberValue(row.last_event_byte_length, 'last event length', { nullable: true }),
    lastEventSha256: row.last_event_sha256,
    eventChainSha256: row.event_chain_sha256 || CHAIN_SEED,
    projectionChainSha256: row.projection_chain_sha256 || CHAIN_SEED,
    eventCount: numberValue(row.event_count, 'event count'),
    projectionVersion: row.projection_version,
    redactionVersion: row.redaction_version,
    lastEventTimestamp: row.last_event_at instanceof Date
      ? row.last_event_at.toISOString()
      : row.last_event_at,
  };
}

const STATE_SELECT = `
SELECT transcript_id, root_session_id, parent_thread_id, path_hash,
       file_identity_hash, position_kind, observed_size, observed_mtime,
       next_byte_offset, next_line_no, last_ordinal,
       last_event_byte_offset, last_event_byte_length, last_event_sha256,
       event_chain_sha256, projection_chain_sha256, event_count,
       projection_version, redaction_version, last_event_at
FROM public.transcripts
WHERE transcript_id = $1
FOR UPDATE`;

async function insertInitialTranscript(client, header) {
  const transcript = header.transcript;
  await client.query({
    text: `
INSERT INTO public.transcripts (
  transcript_id, root_session_id, parent_thread_id, source_file_name,
  path_hash, file_identity_hash, position_kind, observed_size, observed_mtime,
  next_byte_offset, next_line_no, last_ordinal,
  last_event_byte_offset, last_event_byte_length, last_event_sha256,
  event_chain_sha256, projection_chain_sha256, event_count,
  projection_version, redaction_version, first_event_at, last_event_at,
  cwd, originator, cli_version, source, model_provider, metadata_json
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, 0, $8,
  0, 1, NULL, NULL, NULL, NULL, $9, $9, 0, $10, $11, $12, NULL,
  $13, $14, $15, $16, $17, $18::jsonb
)
ON CONFLICT (transcript_id) DO NOTHING`,
    values: [
      transcript.transcriptId,
      transcript.rootSessionId,
      transcript.parentThreadId,
      transcript.sourceFileName,
      header.pathHash,
      header.fileIdentityHash,
      transcript.positionKind,
      header.sourceMtimeMs,
      CHAIN_SEED,
      PROJECTION_VERSION,
      REDACTION_VERSION,
      transcript.startedAt,
      transcript.cwd,
      transcript.originator,
      transcript.cliVersion,
      transcript.source,
      transcript.modelProvider,
      JSON.stringify(transcript.metadataJson),
    ],
  });
}

function assertExistingTranscript(state, header, anchorSha256) {
  const transcript = header.transcript;
  if (state.rootSessionId !== transcript.rootSessionId
      || state.parentThreadId !== transcript.parentThreadId
      || state.positionKind !== transcript.positionKind
      || state.pathHash !== header.pathHash) {
    throw new Error('stored transcript identity does not match the source file');
  }
  if (state.projectionVersion !== PROJECTION_VERSION
      || state.redactionVersion !== REDACTION_VERSION) {
    throw new Error('stored transcript projection version changed; explicit rebuild is required');
  }
  validateResumeState(state, {
    fileIdentityHash: header.fileIdentityHash,
    observedSize: header.observedSize,
    anchorSha256,
  });
}

async function assertStoredBatch(client, events) {
  if (events.length === 0) return;
  const transcriptId = events[0].transcriptId;
  const positionKind = events[0].positionKind;
  const positions = events.map((event) => event.sourcePosition);
  const result = await client.query({
    text: `
SELECT source_position, event_sha256, projection_sha256
FROM public.transcript_events
WHERE transcript_id = $1
  AND position_kind = $2
  AND source_position = ANY($3::bigint[])`,
    values: [transcriptId, positionKind, positions],
  });
  const stored = new Map(result.rows.map((row) => [
    Number(row.source_position),
    { eventSha256: row.event_sha256, projectionSha256: row.projection_sha256 },
  ]));
  for (const event of events) {
    const actual = stored.get(event.sourcePosition);
    if (!actual || actual.eventSha256 !== event.eventSha256
        || actual.projectionSha256 !== event.projectionSha256) {
      throw new Error(
        `PostgreSQL transcript conflict at ${event.positionKind} ${event.sourcePosition}; refusing overwrite`
      );
    }
  }
}

async function persistEventBatch(client, events) {
  await client.query(buildEventInsert(events));
  await assertStoredBatch(client, events);
}

async function updateTranscriptState(client, snapshot) {
  const transcript = snapshot.transcript;
  const result = await client.query({
    text: `
UPDATE public.transcripts
SET observed_size = $2,
    observed_mtime = $3,
    next_byte_offset = $4,
    next_line_no = $5,
    last_ordinal = $6,
    last_event_byte_offset = $7,
    last_event_byte_length = $8,
    last_event_sha256 = $9,
    event_chain_sha256 = $10,
    projection_chain_sha256 = $11,
    event_count = $12,
    last_event_at = $13,
    updated_at = now(),
    last_synced_at = now()
WHERE transcript_id = $1`,
    values: [
      transcript.transcriptId,
      snapshot.observedSize,
      snapshot.sourceMtimeMs,
      snapshot.nextByteOffset,
      snapshot.nextLineNo,
      snapshot.lastOrdinal,
      snapshot.lastEventByteOffset,
      snapshot.lastEventByteLength,
      snapshot.lastEventSha256,
      snapshot.eventChainSha256,
      snapshot.projectionChainSha256,
      snapshot.eventCount,
      snapshot.lastEventTimestamp,
    ],
  });
  if (result.rowCount !== 1) throw new Error('PostgreSQL transcript cursor update affected no row');
}

function normalizeExpected(expected) {
  return {
    transcriptId: expected.transcriptId,
    eventCount: Number(expected.eventCount),
    nextByteOffset: Number(expected.nextByteOffset),
    lastEventSha256: expected.lastEventSha256,
    eventChainSha256: expected.eventChainSha256,
    projectionChainSha256: expected.projectionChainSha256,
  };
}

async function verifyTranscriptReadback(reader, expectedInput) {
  const expected = normalizeExpected(expectedInput);
  const result = await reader.query({
    text: `
SELECT t.transcript_id,
       t.event_count,
       t.next_byte_offset,
       t.last_event_sha256,
       t.event_chain_sha256,
       t.projection_chain_sha256,
       count(e.source_position)::bigint AS stored_event_count,
       (count(e.source_position) - count(DISTINCT (e.position_kind, e.source_position)))::bigint
         AS duplicate_position_count
FROM public.transcripts AS t
LEFT JOIN public.transcript_events AS e ON e.transcript_id = t.transcript_id
WHERE t.transcript_id = $1
GROUP BY t.transcript_id`,
    values: [expected.transcriptId],
  });
  if (result.rows.length !== 1) {
    throw new Error('PostgreSQL transcript readback mismatch: session row is missing');
  }
  const row = result.rows[0];
  const mismatches = [];
  const compareNumber = (name, actual, wanted) => {
    if (Number(actual) !== Number(wanted)) mismatches.push(name);
  };
  compareNumber('event_count', row.event_count, expected.eventCount);
  compareNumber('stored_event_count', row.stored_event_count, expected.eventCount);
  compareNumber('duplicate_position_count', row.duplicate_position_count, 0);
  compareNumber('next_byte_offset', row.next_byte_offset, expected.nextByteOffset);
  for (const [name, expectedKey] of [
    ['last_event_sha256', 'lastEventSha256'],
    ['event_chain_sha256', 'eventChainSha256'],
    ['projection_chain_sha256', 'projectionChainSha256'],
  ]) {
    if ((row[name] || null) !== (expected[expectedKey] || null)) mismatches.push(name);
  }
  if (mismatches.length > 0) {
    throw new Error(`PostgreSQL transcript readback mismatch: ${mismatches.join(', ')}`);
  }
  return {
    verified: true,
    transcriptId: expected.transcriptId,
    eventCount: expected.eventCount,
    duplicatePositionCount: 0,
  };
}

function transcriptIdentityMatches(left, right) {
  const leftTranscript = left && left.transcript;
  const rightTranscript = right && right.transcript;
  return leftTranscript && rightTranscript
    && leftTranscript.transcriptId === rightTranscript.transcriptId
    && leftTranscript.rootSessionId === rightTranscript.rootSessionId
    && leftTranscript.parentThreadId === rightTranscript.parentThreadId
    && leftTranscript.positionKind === rightTranscript.positionKind;
}

function assertHeaderMatchesSnapshot(header, snapshot) {
  if (!transcriptIdentityMatches(header, snapshot)
      || header.pathHash !== snapshot.pathHash
      || header.fileIdentityHash !== snapshot.fileIdentityHash
      || Number(header.observedSize) !== Number(snapshot.observedSize)
      || Number(header.sourceMtimeMs) !== Number(snapshot.sourceMtimeMs)) {
    throw new Error('Codex transcript changed between inspection and streaming');
  }
}

function assertFullSnapshotMatches(expected, actual) {
  const fields = [
    'pathHash',
    'fileIdentityHash',
    'observedSize',
    'sourceMtimeMs',
    'nextByteOffset',
    'nextLineNo',
    'lastOrdinal',
    'lastEventByteOffset',
    'lastEventByteLength',
    'lastEventSha256',
    'lastEventTimestamp',
    'eventCount',
    'eventChainSha256',
    'projectionChainSha256',
    'trailingBytes',
  ];
  if (!transcriptIdentityMatches(expected, actual)
      || fields.some((field) => expected[field] !== actual[field])) {
    throw new Error('Codex transcript historical prefix does not match the synchronized snapshot');
  }
}

async function verifyFullTranscriptSnapshot(filePath, options, expected) {
  const fullSnapshot = await streamTranscriptSnapshot(filePath, {
    sessionsRoot: options.sessionsRoot,
    expectedRootSessionId: options.expectedRootSessionId,
    expectedPathHash: options.expectedPathHash,
    expectedFileIdentityHash: options.expectedFileIdentityHash,
    batchBytes: options.batchBytes,
    batchEvents: options.batchEvents,
  });
  assertFullSnapshotMatches(expected, fullSnapshot);
  return fullSnapshot;
}

async function syncTranscriptFile(filePath, options) {
  if (!options || !options.sessionsRoot || !options.writer || !options.reader) {
    throw new Error('syncTranscriptFile requires sessionsRoot, writer, and reader');
  }
  const header = inspectTranscriptFile(filePath, {
    sessionsRoot: options.sessionsRoot,
    expectedRootSessionId: options.expectedRootSessionId,
  });
  if (options.expectedPathHash && options.expectedPathHash !== header.pathHash) {
    throw new Error('Codex outbox path hash does not match the transcript file');
  }
  if (options.expectedFileIdentityHash
      && options.expectedFileIdentityHash !== header.fileIdentityHash) {
    throw new Error('Codex outbox file identity does not match the transcript file');
  }
  if (options.expectedObservedSize !== undefined) {
    if (!Number.isSafeInteger(options.expectedObservedSize)
        || options.expectedObservedSize < 0) {
      throw new Error('Codex outbox observed size is invalid');
    }
    if (header.observedSize < options.expectedObservedSize) {
      throw new Error('Codex transcript is smaller than the queued SessionEnd observation');
    }
  }
  if (options.expectedMtime !== undefined) {
    const expectedMtimeMs = Date.parse(options.expectedMtime);
    if (typeof options.expectedMtime !== 'string' || !Number.isFinite(expectedMtimeMs)) {
      throw new Error('Codex outbox mtime is invalid');
    }
    if (header.sourceMtimeMs < expectedMtimeMs) {
      throw new Error('Codex transcript is older than the queued SessionEnd observation');
    }
  }
  const client = await options.writer.connect();
  let snapshot;
  let previousEventCount = 0;
  try {
    await client.query('BEGIN');
    await client.query({
      text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      values: [header.transcript.transcriptId],
    });
    let stateResult = await client.query({
      text: STATE_SELECT,
      values: [header.transcript.transcriptId],
    });
    if (stateResult.rows.length === 0) {
      await insertInitialTranscript(client, header);
      stateResult = await client.query({
        text: STATE_SELECT,
        values: [header.transcript.transcriptId],
      });
    }
    if (stateResult.rows.length !== 1) throw new Error('PostgreSQL transcript state is missing');
    const state = mapTranscriptState(stateResult.rows[0]);
    previousEventCount = state.eventCount;
    const anchorSha256 = readAnchorSha256(filePath, state, {
      sessionsRoot: options.sessionsRoot,
      expectedPathHash: header.pathHash,
      expectedFileIdentityHash: header.fileIdentityHash,
    });
    assertExistingTranscript(state, header, anchorSha256);

    snapshot = await streamTranscriptSnapshot(filePath, {
      sessionsRoot: options.sessionsRoot,
      expectedRootSessionId: options.expectedRootSessionId,
      expectedPathHash: header.pathHash,
      expectedFileIdentityHash: header.fileIdentityHash,
      startByteOffset: state.nextByteOffset,
      nextLineNo: state.nextLineNo,
      lastOrdinal: state.lastOrdinal,
      positionKind: state.positionKind,
      lastEventByteOffset: state.lastEventByteOffset,
      lastEventByteLength: state.lastEventByteLength,
      lastEventSha256: state.lastEventSha256,
      lastEventTimestamp: state.lastEventTimestamp,
      eventCount: state.eventCount,
      eventChainSha256: state.eventChainSha256,
      projectionChainSha256: state.projectionChainSha256,
      batchBytes: options.batchBytes,
      batchEvents: options.batchEvents,
      onEvents: async (events) => persistEventBatch(client, events),
    });
    assertHeaderMatchesSnapshot(header, snapshot);
    if (options.expectedObservedSize !== undefined
        && options.expectedQueuedPrefixSha256 === undefined) {
      await verifyFullTranscriptSnapshot(filePath, {
        sessionsRoot: options.sessionsRoot,
        expectedRootSessionId: options.expectedRootSessionId,
        expectedPathHash: header.pathHash,
        expectedFileIdentityHash: header.fileIdentityHash,
        batchBytes: options.batchBytes,
        batchEvents: options.batchEvents,
      }, snapshot);
    }
    await updateTranscriptState(client, snapshot);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw new Error(
      `Codex transcript PostgreSQL sync failed: ${redactSensitiveText(error && error.message || String(error))}`
    );
  } finally {
    client.release();
  }

  const readback = await verifyTranscriptReadback(options.reader, {
    transcriptId: snapshot.transcript.transcriptId,
    eventCount: snapshot.eventCount,
    nextByteOffset: snapshot.nextByteOffset,
    lastEventSha256: snapshot.lastEventSha256,
    eventChainSha256: snapshot.eventChainSha256,
    projectionChainSha256: snapshot.projectionChainSha256,
  });
  return {
    ...readback,
    rootSessionId: snapshot.transcript.rootSessionId,
    insertedEvents: snapshot.eventCount - previousEventCount,
    nextByteOffset: snapshot.nextByteOffset,
    observedSize: snapshot.observedSize,
    sourceMtimeMs: snapshot.sourceMtimeMs,
    trailingBytes: snapshot.trailingBytes,
  };
}

module.exports = {
  CHAIN_SEED,
  EVENT_COLUMNS,
  assertFullSnapshotMatches,
  assertHeaderMatchesSnapshot,
  attestTranscriptPostgres,
  buildEventInsert,
  loadPostgresConnectionConfig,
  mapTranscriptState,
  openPostgresPool,
  openTranscriptPostgres,
  syncTranscriptFile,
  verifyFullTranscriptSnapshot,
  verifyTranscriptReadback,
};
