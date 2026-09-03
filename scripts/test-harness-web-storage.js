'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { transaction, createPgAuthStore } = require('./harness-web/auth-store');
const { databaseConfig } = require('./harness-web/config');
const { manageAccount, readAdminInput } = require('./harness-web/account-admin');
const fs = require('node:fs');
const path = require('node:path');

test('runtime and operator database credentials cannot be interchanged', () => {
  const runtime = 'postgresql://tp_web_auth:fake@127.0.0.1:55433/tech_persistence';
  assert.equal(databaseConfig(runtime, 'runtime').user, 'tp_web_auth');
  assert.throws(() => databaseConfig(runtime, 'admin'));
  assert.throws(() => databaseConfig(runtime.replace('tp_web_auth', 'tp_web_account_admin'), 'runtime'));
});
test('database configuration rejects remote hosts, parameters, wrong databases and privileged roles', () => {
  for (const url of ['bad', 'postgres://postgres:fake@127.0.0.1:55433/tech_persistence',
    'postgres://tp_web_auth:fake@evil.test:55433/tech_persistence', 'postgres://tp_web_auth:fake@localhost:55433/tech_persistence',
    'postgres://tp_web_auth:fake@127.0.0.1:55433/postgres', 'postgres://tp_web_auth:fake@127.0.0.1:55433/tech_persistence?sslmode=disable',
    'postgres://tp_web_auth@127.0.0.1:55433/tech_persistence']) assert.throws(() => databaseConfig(url, 'runtime'));
});
test('transaction rolls back an operation failure and always releases the client', async () => {
  const events = []; const client = { query: async sql => events.push(sql), release: broken => events.push(['release', broken]) };
  await assert.rejects(transaction({ connect: async () => client }, async () => { throw new Error('failure'); }));
  assert.deepEqual(events, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'ROLLBACK', ['release', false]]);
});
test('failed commit is not reported as a successful session', async () => {
  const events = []; const client = { query: async sql => { events.push(sql); if (sql === 'COMMIT') throw new Error('commit lost'); }, release: () => events.push('release') };
  await assert.rejects(transaction({ connect: async () => client }, async () => 'session'));
  assert.deepEqual(events, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'COMMIT', 'ROLLBACK', 'release']);
});
test('a client whose rollback failed is removed from the pool', async () => {
  let broken; const client = { query: async sql => { if (sql === 'ROLLBACK') throw new Error('connection lost'); }, release: value => { broken = value; } };
  await assert.rejects(transaction({ connect: async () => client }, async () => { throw new Error('first'); }), /first/);
  assert.equal(broken, true);
});
test('session lifetime cannot be widened by a direct store caller', async () => {
  const store = createPgAuthStore({ connect: () => { throw new Error('unexpected connection'); } });
  for (const ttlSeconds of [0, -1, 3601, NaN, 1.5]) await assert.rejects(store.createSession({ ttlSeconds }), /lifetime/);
});
test('account lookup and session queries use parameter bindings', async () => {
  const calls = []; const store = createPgAuthStore({ query: async (sql, values) => { calls.push([sql, values]); return { rows: [] }; } });
  await store.findAccount("x' OR true--"); await store.resolveSession('injected'); await store.revokeSession('injected');
  for (const [sql, values] of calls) { assert.ok(sql.includes('$1')); assert.ok(!sql.includes(values[0])); }
});
test('account management never creates default accounts or accepts additional privileges', async () => {
  const pool = { query: () => { throw new Error('should not be called'); } };
  await assert.rejects(manageAccount(pool, 'create', { username: 'operator', password: 'long fake password', admin: true }));
  await assert.rejects(manageAccount(pool, 'enable', { username: 'operator' }));
  await assert.rejects(manageAccount(pool, 'disable', { username: '../admin' }));
});
test('account creation stores a salted hash and returns only public identity fields', async () => {
  let parameters; const pool = { query: async (sql, values) => { parameters = values; assert.match(sql, /INSERT/); return { rows: [{ id: values[0], username: values[1], disabled: false, password_hash: values[2] }] }; } };
  const result = await manageAccount(pool, 'create', { username: 'Operator', password: 'test-only admin password' });
  assert.match(parameters[2], /^scrypt-v1/); assert.ok(!parameters[2].includes('password'));
  assert.deepEqual(Object.keys(result).sort(), ['disabled', 'id', 'username']); assert.equal(result.username, 'operator');
});
test('password reset invalidates prior sessions without enabling a disabled account', async () => {
  let statement; const pool = { query: async sql => { statement = sql; return { rows: [{ id: 'test', username: 'operator', disabled: true }] }; } };
  const result = await manageAccount(pool, 'reset-password', { username: 'operator', password: 'test-only reset password' });
  assert.match(statement, /auth_version = auth_version \+ 1/); assert.doesNotMatch(statement, /disabled = false/); assert.equal(result.disabled, true);
});
test('admin input is bounded JSON and does not echo malformed secrets', async () => {
  assert.deepEqual(await readAdminInput(Readable.from(['{"username":"operator"}'])), { username: 'operator' });
  await assert.rejects(readAdminInput(Readable.from(['private password invalid'])), error => !error.message.includes('private'));
  await assert.rejects(readAdminInput(Readable.from(['x'.repeat(2049)])), /limit/);
});
test('auth migration owns only new roles and schema, and gives the web role no account mutation', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../deploy/harness-web/001-auth.sql'), 'utf8');
  assert.match(sql, /CREATE SCHEMA harness_web/); assert.doesNotMatch(sql, /IF NOT EXISTS|DROP|public\.transcript|acceptance_/);
  assert.match(sql, /GRANT SELECT ON harness_web\.accounts TO tp_web_auth/);
  assert.doesNotMatch(sql, /GRANT (?:[^;]*UPDATE|[^;]*INSERT) ON harness_web\.accounts TO tp_web_auth;/);
  assert.match(sql, /GRANT UPDATE\(revoked_at\)/); assert.doesNotMatch(sql, /GRANT[^;]*DELETE[^;]*sessions/);
});
