#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  appendAcceptanceAuthorityRecord,
  attestAcceptancePostgres,
  loadAcceptancePostgresConnectionConfig,
  normalizeAuthorityRecord,
} = require('./lib/acceptance-postgres-authority');
const { appendPostgresAuthorityRecordSync } = require('./lib/acceptance-postgres-authority-client');
const { PUBLIC_APPEND_KINDS, appendFromFile } = require('./acceptance-postgres-authority');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function source(overrides = {}) {
  return {
    ACCEPTANCE_POSTGRES_READ_URL: 'postgresql://acceptance_reader:reader@127.0.0.1:55433/tech_persistence',
    ACCEPTANCE_POSTGRES_WRITE_URL: 'postgresql://acceptance_writer:writer@127.0.0.1:55433/tech_persistence',
    ACCEPTANCE_POSTGRES_SSL: 'false',
    ...overrides,
  };
}

function record(overrides = {}) {
  return normalizeAuthorityRecord({
    authorityScope: HASH_A,
    recordKind: 'acceptance-receipt',
    recordKey: HASH_B,
    contractHash: HASH_A,
    subjectHash: HASH_B,
    payload: { schemaVersion: 'acceptance-receipt-v1', overallStatus: 'passed' },
    ...overrides,
  });
}

assert.strictEqual(loadAcceptancePostgresConnectionConfig(source(), 'read').source, 'ACCEPTANCE_POSTGRES_READ_URL');
assert.throws(
  () => loadAcceptancePostgresConnectionConfig(source({ ACCEPTANCE_POSTGRES_URL: 'postgresql://shared:x@127.0.0.1/db' }), 'read'),
  /distinct.*READ_URL.*WRITE_URL/i
);
assert.throws(
  () => loadAcceptancePostgresConnectionConfig(source({ ACCEPTANCE_POSTGRES_READ_URL: 'postgresql://reader:x@example.com/db' }), 'read'),
  /TLS is required/i
);
assert.strictEqual(record().recordHash.startsWith('sha256:'), true);
assert.throws(() => record({ recordKind: 'arbitrary' }), /recordKind/);
assert.strictEqual(
  normalizeAuthorityRecord(record({ recordKind: 'cohort-tombstone' })).recordKind,
  'cohort-tombstone'
);
assert.deepStrictEqual([...PUBLIC_APPEND_KINDS].sort(), ['acceptance-receipt', 'authority-canary']);

const calls = [];
const client = {
  async query(query) {
    calls.push(query);
    if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') return { rows: [], rowCount: null };
    if (query.text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (query.text.includes('INSERT INTO')) return { rows: [{ record_hash: record().recordHash }], rowCount: 1 };
    throw new Error(`unexpected writer query: ${query.text}`);
  },
  release() {},
};
const writer = { async connect() { return client; } };
const reader = {
  async query(query) {
    calls.push(query);
    const expected = record();
    return {
      rows: [{
        authority_scope: expected.authorityScope,
        record_kind: expected.recordKind,
        record_key: expected.recordKey,
        contract_hash: expected.contractHash,
        subject_hash: expected.subjectHash,
        record_hash: expected.recordHash,
        payload_json: expected.payload,
      }],
      rowCount: 1,
    };
  },
};

(async () => {
  await assert.rejects(
    appendFromFile('must-not-be-read.env', record({ recordKind: 'readback-seal' })),
    /public append recordKind is not allowed/i
  );
  await assert.rejects(
    appendFromFile('must-not-be-read.env', record({ recordKind: 'cohort-tombstone' })),
    /public append recordKind is not allowed/i
  );
  const privilegeRow = (overrides) => ({
    is_superuser: false,
    bypass_rls: false,
    can_create_schema: false,
    can_update: false,
    can_delete: false,
    can_truncate: false,
    ...overrides,
  });
  await attestAcceptancePostgres(
    { async query() { return { rows: [privilegeRow({
      role_name: 'acceptance_writer',
      transaction_read_only: false,
      can_select_all: false,
      can_insert: true,
      can_select_hash: true,
      can_select_payload: false,
    })] }; } },
    { async query() { return { rows: [privilegeRow({
      role_name: 'acceptance_reader',
      transaction_read_only: true,
      can_select_all: true,
      can_insert: false,
      can_select_hash: true,
      can_select_payload: true,
    })] }; } }
  );
  await assert.rejects(
    attestAcceptancePostgres(
      { async query() { return { rows: [privilegeRow({
        role_name: 'acceptance_writer',
        transaction_read_only: false,
        can_select_all: true,
        can_insert: true,
        can_select_hash: true,
        can_select_payload: true,
      })] }; } },
      { async query() { return { rows: [] }; } }
    ),
    /writer privilege attestation failed/i
  );
  const brokerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-pg-broker-'));
  try {
    const envFile = path.join(brokerRoot, 'private.env');
    fs.writeFileSync(envFile, 'ACCEPTANCE_POSTGRES_SSL=false\n');
    const expectedRecord = record();
    let brokerCall;
    const brokerResult = appendPostgresAuthorityRecordSync(expectedRecord, {
      postgresEnvFile: envFile,
      spawnSyncImpl(command, args, options) {
        brokerCall = { command, args, options };
        return {
          status: 0,
          stdout: `${JSON.stringify({ verified: true, recordHash: expectedRecord.recordHash })}\n`,
          stderr: '',
        };
      },
    });
    assert.strictEqual(brokerResult.recordHash, expectedRecord.recordHash);
    assert.strictEqual(brokerCall.command, process.execPath);
    assert.strictEqual(brokerCall.args[1], 'append');
    assert.strictEqual(brokerCall.options.shell, false);
    assert.strictEqual(brokerCall.options.input, JSON.stringify(expectedRecord));
    assert.strictEqual(brokerCall.options.env.ACCEPTANCE_POSTGRES_WRITE_URL, undefined);
    assert.throws(
      () => appendPostgresAuthorityRecordSync(expectedRecord, {
        postgresEnvFile: envFile,
        providerRoot: brokerRoot,
        spawnSyncImpl() { throw new Error('must reject before spawn'); },
      }),
      /outside the provider workspace/i
    );
  } finally {
    fs.rmSync(brokerRoot, { recursive: true, force: true });
  }
  const result = await appendAcceptanceAuthorityRecord(writer, reader, record());
  assert.deepStrictEqual(result, {
    verified: true,
    authorityScope: HASH_A,
    recordKind: 'acceptance-receipt',
    recordKey: HASH_B,
    recordHash: record().recordHash,
  });
  assert(calls.some((query) => query && query.text && query.text.includes('VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)')));
  assert(calls.every((query) => !query || !Array.isArray(query.values)
    || query.values.every((value) => typeof value !== 'string' || !value.includes('\0'))));
  assert(calls.some((query) => query && query.text && query.text.includes('SELECT authority_scope')));

  const conflictingWriter = {
    async connect() {
      return {
        ...client,
        async query(query) {
          if (query === 'BEGIN' || query === 'ROLLBACK') return { rows: [], rowCount: null };
          if (query.text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
          if (query.text.includes('INSERT INTO')) return { rows: [], rowCount: 0 };
          if (query.text.includes('SELECT record_hash')) return { rows: [{ record_hash: HASH_A }], rowCount: 1 };
          throw new Error('unexpected query');
        },
      };
    },
  };
  await assert.rejects(
    appendAcceptanceAuthorityRecord(conflictingWriter, reader, record()),
    /conflicts with existing immutable record/i
  );
  console.log('[OK] acceptance PostgreSQL authority config, append, conflict, and independent readback');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
