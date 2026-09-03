'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTaskService } = require('./harness-web/task-service');
const { createPgTaskStore } = require('./harness-web/task-store');
const { tokenHash, csrfForToken } = require('./harness-web/auth');
const { releaseFixtureClient } = require('./test-harness-web-tasks-postgres');
const TOKEN = 'a'.repeat(64), CSRF = csrfForToken(TOKEN);
const taskId = randomUUID(), key = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const task = { id: taskId, projectId: 'test-project', state: 'draft', createdAt: new Date().toISOString(), queuedAt: null,
  terminalCode: null, confirmationRequired: false };
function fixture() {
  const calls = [];
  const store = Object.fromEntries(['create', 'enqueue', 'cancel', 'confirm', 'get', 'list', 'projects', 'transcript'].map(method => [method, async input => {
    calls.push({ method, input });
    if (method === 'list') return { items: [task], nextCursor: null };
    if (method === 'projects') return [{ id: 'test-project', name: 'Test project', canCreate: true, canExecute: false }];
    if (method === 'transcript') return { status: 'synced', eventCount: 3, lastSyncedAt: new Date().toISOString() };
    return { ...task, requirement: 'test requirement', ...(method === 'create' || method === 'enqueue' ? { replayed: false } : {}) };
  }]));
  return { calls, store, service: createTaskService(store) };
}
const request = () => ({ projectId: 'test-project', requirement: 'test requirement', idempotencyKey: key });
const fails = (operation, status) => assert.rejects(operation, error => error.status === status);
test('isolated fixture cleanup destroys clients even when rollback or role reset fails', async () => {
  for (const reset of ['ROLLBACK', 'RESET ROLE']) {
    const calls = [];
    await assert.rejects(releaseFixtureClient({ query: async sql => { calls.push(sql); throw new Error('injected cleanup failure'); },
      release: broken => calls.push(broken) }, reset), /injected cleanup failure/);
    assert.deepEqual(calls, [reset, true]);
  }
});
test('isolated fixture cleanup releases successful and already-settled clients', async () => {
  const calls = [], client = { query: async sql => calls.push(sql), release: broken => calls.push(broken) };
  await releaseFixtureClient(client, 'ROLLBACK'); await releaseFixtureClient(client);
  assert.deepEqual(calls, ['ROLLBACK', true, true]);
});
test('create derives identity material from session, not the request body', async () => {
  const f = fixture(); await f.service.create(TOKEN, CSRF, request());
  assert.equal(f.calls[0].input.sessionHash, tokenHash(TOKEN)); assert.ok(!JSON.stringify(f.calls).includes(TOKEN));
  assert.equal(f.calls[0].input.creationKey, key); assert.equal(f.calls[0].input.requirement, 'test requirement');
});
test('all operations reject missing, malformed or non-string tokens before storage', async () => {
  const f = fixture();
  for (const token of [undefined, null, '', 42, 'a'.repeat(63), 'A'.repeat(64)]) {
    await fails(f.service.create(token, CSRF, request()), 401); await fails(f.service.enqueue(token, CSRF, taskId, { idempotencyKey: key }), 401);
    await fails(f.service.get(token, taskId), 401); await fails(f.service.list(token), 401); await fails(f.service.projects(token), 401);
  }
  assert.equal(f.calls.length, 0);
});
test('create and enqueue require session-bound CSRF', async () => {
  const f = fixture();
  for (const csrf of [undefined, '', 'b'.repeat(64), csrfForToken('b'.repeat(64))]) {
    await fails(f.service.create(TOKEN, csrf, request()), 403);
    await fails(f.service.enqueue(TOKEN, csrf, taskId, { idempotencyKey: key }), 403);
  }
  assert.equal(f.calls.length, 0);
});
for (const field of ['ownerId', 'userId', 'tenant', 'role', 'command', 'path', 'env', 'provider', 'model', 'accepted']) {
  test(`create refuses privilege/config field: ${field}`, async () => {
    const f = fixture(); await fails(f.service.create(TOKEN, CSRF, { ...request(), [field]: 'untrusted' }), 400);
    assert.equal(f.calls.length, 0);
  });
}
test('create refuses missing fields, arrays and inherited input fields', async () => {
  const f = fixture();
  for (const input of [null, [], {}, { projectId: 'test-project', requirement: 'text' }, Object.create(request())]) {
    await fails(f.service.create(TOKEN, CSRF, input), 400);
  }
});
test('project identifiers cannot carry paths, URLs or SQL syntax', async () => {
  const f = fixture();
  for (const projectId of ['../root', 'https://host', "x' OR true--", 'x', 'x'.repeat(65), {}, 'Upper']) {
    await fails(f.service.create(TOKEN, CSRF, { ...request(), projectId }), 400);
  }
  assert.equal(f.calls.length, 0);
});
test('requirement bytes are bounded and invalid text is rejected', async () => {
  const f = fixture();
  for (const requirement of ['', ' \n\t', null, {}, 'x'.repeat(16385), '中'.repeat(5462), 'bad\u0000text', '\ud800']) {
    await fails(f.service.create(TOKEN, CSRF, { ...request(), requirement }), 400);
  }
  await f.service.create(TOKEN, CSRF, { ...request(), requirement: '中'.repeat(5461) });
  await f.service.create(TOKEN, CSRF, { ...request(), requirement: 'x'.repeat(16384) });
  assert.equal(f.calls.length, 2);
});
test('requirement is preserved as untrusted data without command interpretation', async () => {
  const f = fixture(); const requirement = '\n<script>alert(1)</script>\n; DROP TABLE accounts;\n';
  await f.service.create(TOKEN, CSRF, { ...request(), requirement }); assert.equal(f.calls[0].input.requirement, requirement);
});
test('idempotency keys must be canonical UUID v4', async () => {
  const f = fixture();
  for (const idempotencyKey of ['', 'not-a-uuid', key.toUpperCase(), `${key.slice(0, 14)}1${key.slice(15)}`, 42]) {
    await fails(f.service.create(TOKEN, CSRF, { ...request(), idempotencyKey }), 400);
  }
});
test('enqueue has exact shape and never accepts a state or command', async () => {
  const f = fixture();
  for (const input of [null, {}, [], { idempotencyKey: key, state: 'accepted' }, { idempotencyKey: key, command: 'echo' }]) {
    await fails(f.service.enqueue(TOKEN, CSRF, taskId, input), 400);
  }
  await f.service.enqueue(TOKEN, CSRF, taskId, { idempotencyKey: key });
  assert.deepEqual(f.calls[0].input, { sessionHash: tokenHash(TOKEN), taskId, executionKey: key });
});
test('cancel requires CSRF, exact empty body and derives owner from the session', async () => {
  const f = fixture();
  await fails(f.service.cancel(TOKEN, 'wrong', taskId, {}), 403);
  for (const input of [null, [], { outcome: 'succeeded' }, { accepted: true }]) await fails(f.service.cancel(TOKEN, CSRF, taskId, input), 400);
  await f.service.cancel(TOKEN, CSRF, taskId, {});
  assert.deepEqual(f.calls[0].input, { sessionHash: tokenHash(TOKEN), taskId });
});
test('confirm requires CSRF, exact empty body and derives owner from the session', async () => {
  const f = fixture();
  await fails(f.service.confirm(TOKEN, 'wrong', taskId, {}), 403);
  for (const input of [null, [], { accepted: true }]) await fails(f.service.confirm(TOKEN, CSRF, taskId, input), 400);
  await f.service.confirm(TOKEN, CSRF, taskId, {});
  assert.deepEqual(f.calls[0].input, { sessionHash: tokenHash(TOKEN), taskId });
});
test('public projection accepts execution states but never authority evidence', async () => {
  const f = fixture();
  for (const state of ['claimed', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'needs_coordination']) {
    f.store.get = async () => ({ ...task, state, queuedAt: new Date().toISOString(), requirement: 'text', claimToken: key, resultRef: '/private' });
    const result = await f.service.get(TOKEN, taskId); assert.equal(result.state, state); assert.ok(!Object.hasOwn(result, 'claimToken'));
  }
});
test('task IDs are validated for both query and mutation', async () => {
  const f = fixture();
  for (const id of ['', '../task', "' OR true--", null]) {
    await fails(f.service.get(TOKEN, id), 400); await fails(f.service.enqueue(TOKEN, CSRF, id, { idempotencyKey: key }), 400);
  }
  assert.equal(f.calls.length, 0);
});
test('transcript status is owner-authorized through storage and exposes metadata only', async () => {
  const f = fixture(); const result = await f.service.transcript(TOKEN, taskId);
  assert.equal(result.status, 'synced'); assert.equal(result.eventCount, 3);
  assert.deepEqual(f.calls[0].input, { sessionHash: tokenHash(TOKEN), taskId });
});
test('pagination is bounded and rejects identity filters or malformed cursors', async () => {
  const f = fixture();
  for (const input of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '20' }, { after: '../x' }, { ownerId: taskId }, []]) {
    await fails(f.service.list(TOKEN, input), 400);
  }
  await f.service.list(TOKEN); assert.deepEqual(f.calls[0].input, { sessionHash: tokenHash(TOKEN), after: null, limit: 20 });
  await f.service.list(TOKEN, { after: taskId, limit: 50 }); assert.equal(f.calls[1].input.limit, 50);
});
test('public projections discard internal identities, keys, logs and configuration', async () => {
  const f = fixture(); f.store.get = async () => ({ ...task, requirement: 'own text', ownerId: 'secret-owner',
    creationKey: key, token: TOKEN, stdout: 'private log', accepted: true, workdir: '/private' });
  const result = await f.service.get(TOKEN, taskId);
  assert.deepEqual(Object.keys(result).sort(), ['confirmationRequired', 'createdAt', 'id', 'projectId', 'queuedAt', 'requirement', 'state', 'terminalCode']);
});
test('lists exclude requirement bodies and projects expose only approved metadata', async () => {
  const f = fixture(); f.store.list = async () => ({ items: [{ ...task, requirement: 'private text', ownerId: 'other' }], nextCursor: null });
  f.store.projects = async () => [{ id: 'test-project', name: 'Test', canCreate: true, canExecute: false, path: '/private' }];
  assert.equal((await f.service.list(TOKEN)).items[0].requirement, undefined);
  assert.deepEqual(Object.keys((await f.service.projects(TOKEN))[0]).sort(), ['canCreate', 'canExecute', 'id', 'name']);
});
test('failed storage and malformed output fail closed without leaking details', async () => {
  const f = fixture(); f.store.get = async () => { throw new Error('postgres://private-password@host'); };
  await assert.rejects(f.service.get(TOKEN, taskId), error => error.status === 503 && !error.message.includes('private'));
  for (const value of [null, {}, { ...task, state: 'accepted' }, { ...task, id: 'invalid' }]) {
    f.store.get = async () => value; await fails(f.service.get(TOKEN, taskId), 503);
  }
});
test('public task identifiers must be primitive strings, not coercible JSON arrays', async () => {
  const f = fixture();
  for (const value of [{ ...task, id: [taskId] }, { ...task, projectId: [task.projectId] }]) {
    f.store.get = async () => ({ ...value, requirement: 'text' }); await fails(f.service.get(TOKEN, taskId), 503);
  }
});
test('project display-name bounds count Unicode codepoints like PostgreSQL', async () => {
  const f = fixture();
  for (const name of ['项'.repeat(128), '🚀'.repeat(128)]) {
    f.store.projects = async () => [{ id: 'test-project', name, canCreate: true, canExecute: false }];
    assert.equal((await f.service.projects(TOKEN))[0].name, name);
  }
  f.store.projects = async () => [{ id: 'test-project', name: '🚀'.repeat(129), canCreate: true, canExecute: false }];
  await fails(f.service.projects(TOKEN), 503);
});
test('only known database error codes become business errors, never raw messages', async () => {
  const f = fixture();
  for (const [code, status] of [['P0400', 400], ['P0401', 401], ['P0403', 403], ['P0404', 404], ['P0409', 409], ['P0429', 429], ['P0503', 503], ['23505', 503]]) {
    f.store.get = async () => { const error = new Error('private input and SQL'); error.code = code; throw error; };
    await assert.rejects(f.service.get(TOKEN, taskId), error => error.status === status && !error.message.includes('private'));
  }
});
test('service admission remains occupied until storage settles, including rejected work', async () => {
  const f = fixture(); const releases = []; f.store.get = () => new Promise((resolve, reject) => releases.push(reject));
  const pending = Array.from({ length: 8 }, () => f.service.get(TOKEN, taskId).catch(error => error.status));
  await fails(f.service.projects(TOKEN), 429); assert.equal(releases.length, 8);
  releases.forEach(reject => reject(new Error('failure'))); assert.deepEqual(await Promise.all(pending), Array(8).fill(503));
  f.store.get = async () => ({ ...task, requirement: 'text' }); assert.equal((await f.service.get(TOKEN, taskId)).id, taskId);
});
test('task store uses only parameterized approved database functions in read-committed transactions', async () => {
  const calls = []; const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ result: {} }] }; }, release() {} };
  const store = createPgTaskStore({ connect: async () => client });
  await store.create({ sessionHash: 'sensitive-hash', projectId: 'project', requirement: "'; DROP TABLE tasks;", creationKey: key });
  await store.enqueue({ sessionHash: 'sensitive-hash', taskId, executionKey: key });
  await store.cancel({ sessionHash: 'sensitive-hash', taskId });
  await store.confirm({ sessionHash: 'sensitive-hash', taskId });
  await store.get({ sessionHash: 'sensitive-hash', taskId }); await store.list({ sessionHash: 'sensitive-hash', limit: 20, after: null });
  await store.projects({ sessionHash: 'sensitive-hash' });
  const operations = calls.filter(call => call.values);
  assert.equal(operations.length, 7);
  for (const call of operations) { assert.match(call.sql, /^SELECT harness_tasks\.[a-z_]+\(/); assert.ok(!call.sql.includes('sensitive-hash')); assert.ok(!call.sql.includes('DROP')); }
  assert.equal(calls.filter(call => call.sql === 'BEGIN ISOLATION LEVEL READ COMMITTED').length, 7);
  assert.equal(calls.filter(call => call.sql === 'COMMIT').length, 7);
});
