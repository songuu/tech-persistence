'use strict';

const { redactSensitiveText } = require('./redaction');
const {
  assertExactKeys,
  canonicalize,
  stableHash,
  validateHash,
} = require('./self-learning-canonical');

const RECORD_KINDS = new Set([
  'acceptance-receipt',
  'authority-canary',
  'artifact-seal',
  'cohort-tombstone',
  'expected-sample',
  'independent-review-seal',
  'readback-seal',
  'validation-seal',
]);

function parseBoolean(value, name) {
  if (value === undefined || String(value).trim() === '') return false;
  if (/^(1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(0|false|no|off)$/i.test(String(value))) return false;
  throw new Error(`${name} must be true or false`);
}

function postgresUrlName(purpose) {
  return purpose === 'read'
    ? 'ACCEPTANCE_POSTGRES_READ_URL'
    : 'ACCEPTANCE_POSTGRES_WRITE_URL';
}

function loadAcceptancePostgresConnectionConfig(source, purpose) {
  if (!source || typeof source !== 'object') throw new Error('PostgreSQL config source is required');
  if (!['read', 'write'].includes(purpose)) throw new Error('PostgreSQL purpose is invalid');
  if (typeof source.ACCEPTANCE_POSTGRES_URL === 'string'
      && source.ACCEPTANCE_POSTGRES_URL.trim()) {
    throw new Error(
      'ACCEPTANCE_POSTGRES_URL is not supported; configure distinct '
      + 'ACCEPTANCE_POSTGRES_READ_URL and ACCEPTANCE_POSTGRES_WRITE_URL credentials'
    );
  }
  const name = postgresUrlName(purpose);
  const value = typeof source[name] === 'string' ? source[name].trim() : '';
  if (!value) throw new Error(`Missing required PostgreSQL env var: ${name}`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a postgresql:// URL with host, user, password, and database`);
  }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)
      || !parsed.hostname || !parsed.username || !parsed.password
      || !parsed.pathname || parsed.pathname === '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} must be a postgresql:// URL with host, user, password, and database`);
  }
  let database;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error(`${name} must contain one valid database path segment`);
  }
  if (!database || database.includes('/')) {
    throw new Error(`${name} must contain one valid database path segment`);
  }
  const ssl = parseBoolean(source.ACCEPTANCE_POSTGRES_SSL, 'ACCEPTANCE_POSTGRES_SSL');
  const hostname = parsed.hostname.toLowerCase();
  if (!ssl && !['127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('TLS is required for non-loopback PostgreSQL hosts');
  }
  return { url: parsed.toString(), ssl, source: name };
}

async function loadPgModule(options = {}) {
  if (options.pg) return options.pg;
  try {
    const moduleName = 'pg';
    return await import(moduleName);
  } catch (error) {
    throw new Error(
      `Acceptance PostgreSQL authority requires pg: ${redactSensitiveText(error && error.message || String(error))}`
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
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: `tech-persistence-acceptance-${purpose}`,
  });
}

const PRIVILEGE_ATTESTATION_QUERY = `
SELECT
  current_user AS role_name,
  current_setting('transaction_read_only')::boolean AS transaction_read_only,
  (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS is_superuser,
  (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user) AS bypass_rls,
  has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema,
  has_table_privilege(current_user, 'public.acceptance_authority_records', 'SELECT') AS can_select_all,
  has_table_privilege(current_user, 'public.acceptance_authority_records', 'INSERT') AS can_insert,
  has_table_privilege(current_user, 'public.acceptance_authority_records', 'UPDATE') AS can_update,
  has_table_privilege(current_user, 'public.acceptance_authority_records', 'DELETE') AS can_delete,
  has_table_privilege(current_user, 'public.acceptance_authority_records', 'TRUNCATE') AS can_truncate,
  has_column_privilege(current_user, 'public.acceptance_authority_records', 'record_hash', 'SELECT') AS can_select_hash,
  has_column_privilege(current_user, 'public.acceptance_authority_records', 'payload_json', 'SELECT') AS can_select_payload`;

async function attestAcceptancePostgres(writer, reader) {
  const [writerResult, readerResult] = await Promise.all([
    writer.query(PRIVILEGE_ATTESTATION_QUERY),
    reader.query(PRIVILEGE_ATTESTATION_QUERY),
  ]);
  const writerRole = writerResult.rows[0];
  const readerRole = readerResult.rows[0];
  const forbidden = (row) => row.is_superuser || row.bypass_rls || row.can_create_schema
    || row.can_update || row.can_delete || row.can_truncate;
  if (!writerRole || writerRole.role_name !== 'acceptance_writer'
      || writerRole.transaction_read_only || forbidden(writerRole)
      || !writerRole.can_insert || !writerRole.can_select_hash
      || writerRole.can_select_all || writerRole.can_select_payload) {
    throw new Error('PostgreSQL acceptance writer privilege attestation failed');
  }
  if (!readerRole || readerRole.role_name !== 'acceptance_reader'
      || !readerRole.transaction_read_only || forbidden(readerRole)
      || !readerRole.can_select_all || !readerRole.can_select_payload
      || readerRole.can_insert) {
    throw new Error('PostgreSQL acceptance reader privilege attestation failed');
  }
  if (writerRole.role_name === readerRole.role_name) {
    throw new Error('PostgreSQL acceptance reader and writer identities must differ');
  }
  return { writerRole: writerRole.role_name, readerRole: readerRole.role_name };
}

async function openAcceptancePostgres(options = {}) {
  const source = options.env || process.env;
  const readConfig = loadAcceptancePostgresConnectionConfig(source, 'read');
  const writeConfig = loadAcceptancePostgresConnectionConfig(source, 'write');
  if (readConfig.url === writeConfig.url) {
    throw new Error('PostgreSQL acceptance reader and writer URLs must be distinct');
  }
  const reader = await openPostgresPool(readConfig, 'reader', options);
  const writer = await openPostgresPool(writeConfig, 'writer', options);
  try {
    await attestAcceptancePostgres(writer, reader);
    return { reader, writer };
  } catch (error) {
    await Promise.allSettled([reader.end(), writer.end()]);
    throw error;
  }
}

function nullableHash(value, label) {
  return value === null || value === undefined ? null : validateHash(value, label);
}

function normalizeAuthorityRecord(input) {
  const fields = ['authorityScope', 'recordKind', 'recordKey', 'contractHash', 'subjectHash', 'payload'];
  const actualFields = Object.keys(input || {}).sort();
  const normalizedInput = input
    && (Object.prototype.hasOwnProperty.call(input, 'recordHash')
      || Object.prototype.hasOwnProperty.call(input, 'schemaVersion'));
  const expectedFields = normalizedInput
    ? [...fields, 'schemaVersion', 'recordHash']
    : fields;
  assertExactKeys(input, expectedFields, 'acceptance authority record');
  if (normalizedInput && input.schemaVersion !== 'acceptance-authority-record-v1') {
    throw new Error('acceptance authority schemaVersion is invalid');
  }
  const authorityScope = validateHash(input.authorityScope, 'authorityScope');
  const recordKey = validateHash(input.recordKey, 'recordKey');
  if (!RECORD_KINDS.has(input.recordKind)) {
    throw new Error('recordKind is not a supported acceptance authority record kind');
  }
  const payload = canonicalize(input.payload, new Set(), 'payload');
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024 * 1024) {
    throw new Error('acceptance authority payload exceeds 16 MiB');
  }
  if (redactSensitiveText(serialized) !== serialized) {
    throw new Error('acceptance authority payload contains sensitive content');
  }
  const core = {
    schemaVersion: 'acceptance-authority-record-v1',
    authorityScope,
    recordKind: input.recordKind,
    recordKey,
    contractHash: nullableHash(input.contractHash, 'contractHash'),
    subjectHash: nullableHash(input.subjectHash, 'subjectHash'),
    payload,
  };
  const recordHash = stableHash(core);
  if (actualFields.includes('recordHash')
      && validateHash(input.recordHash, 'recordHash') !== recordHash) {
    throw new Error('acceptance authority recordHash does not match its canonical content');
  }
  return { ...core, recordHash };
}

function rowMatchesRecord(row, record) {
  if (!row) return false;
  return row.authority_scope === record.authorityScope
    && row.record_kind === record.recordKind
    && row.record_key === record.recordKey
    && (row.contract_hash || null) === record.contractHash
    && (row.subject_hash || null) === record.subjectHash
    && row.record_hash === record.recordHash
    && stableHash(row.payload_json) === stableHash(record.payload);
}

async function verifyAcceptanceAuthorityReadback(reader, expectedInput) {
  const expected = normalizeAuthorityRecord({
    authorityScope: expectedInput.authorityScope,
    recordKind: expectedInput.recordKind,
    recordKey: expectedInput.recordKey,
    contractHash: expectedInput.contractHash,
    subjectHash: expectedInput.subjectHash,
    payload: expectedInput.payload,
  });
  if (expectedInput.recordHash && expectedInput.recordHash !== expected.recordHash) {
    throw new Error('acceptance authority record hash is invalid');
  }
  const result = await reader.query({
    text: `
SELECT authority_scope, record_kind, record_key, contract_hash, subject_hash,
       record_hash, payload_json
FROM public.acceptance_authority_records
WHERE authority_scope = $1 AND record_kind = $2 AND record_key = $3`,
    values: [expected.authorityScope, expected.recordKind, expected.recordKey],
  });
  if (result.rows.length !== 1 || !rowMatchesRecord(result.rows[0], expected)) {
    throw new Error('PostgreSQL acceptance authority readback mismatch');
  }
  return {
    verified: true,
    authorityScope: expected.authorityScope,
    recordKind: expected.recordKind,
    recordKey: expected.recordKey,
    recordHash: expected.recordHash,
  };
}

async function appendAcceptanceAuthorityRecord(writer, reader, input) {
  if (!writer || typeof writer.connect !== 'function' || !reader || typeof reader.query !== 'function') {
    throw new Error('acceptance authority append requires writer and independent reader pools');
  }
  const record = normalizeAuthorityRecord(input);
  const client = await writer.connect();
  try {
    await client.query('BEGIN');
    await client.query({
      text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      values: [`${record.authorityScope}|${record.recordKind}|${record.recordKey}`],
    });
    const inserted = await client.query({
      text: `
INSERT INTO public.acceptance_authority_records (
  authority_scope, record_kind, record_key, contract_hash, subject_hash, record_hash, payload_json
)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (authority_scope, record_kind, record_key) DO NOTHING
RETURNING record_hash`,
      values: [
        record.authorityScope,
        record.recordKind,
        record.recordKey,
        record.contractHash,
        record.subjectHash,
        record.recordHash,
        JSON.stringify(record.payload),
      ],
    });
    let storedHash = inserted.rows[0] && inserted.rows[0].record_hash;
    if (!storedHash) {
      const existing = await client.query({
        text: `
SELECT record_hash
FROM public.acceptance_authority_records
WHERE authority_scope = $1 AND record_kind = $2 AND record_key = $3`,
        values: [record.authorityScope, record.recordKind, record.recordKey],
      });
      storedHash = existing.rows[0] && existing.rows[0].record_hash;
    }
    if (storedHash !== record.recordHash) {
      throw new Error('PostgreSQL acceptance authority conflicts with existing immutable record');
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw new Error(
      `PostgreSQL acceptance authority append failed: ${redactSensitiveText(error && error.message || String(error))}`
    );
  } finally {
    client.release();
  }
  return verifyAcceptanceAuthorityReadback(reader, record);
}

module.exports = {
  RECORD_KINDS,
  appendAcceptanceAuthorityRecord,
  attestAcceptancePostgres,
  loadAcceptancePostgresConnectionConfig,
  normalizeAuthorityRecord,
  openAcceptancePostgres,
  openPostgresPool,
  verifyAcceptanceAuthorityReadback,
};
