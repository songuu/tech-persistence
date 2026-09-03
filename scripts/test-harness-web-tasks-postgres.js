'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createPgTaskStore } = require('./harness-web/task-store');
const { createTaskService } = require('./harness-web/task-service');
const { tokenHash, csrfForToken } = require('./harness-web/auth');
const { transaction } = require('./harness-web/auth-store');
const { DUMMY_RECORD } = require('./harness-web/password');
async function releaseFixtureClient(client, resetSql) {
  try { if (resetSql) await client.query(resetSql); }
  finally { client.release(true); } // Never return a possibly aborted transaction/role to the fixture pool.
}
async function run({ database, ownerPool, adminPool, authStore, taskPool, secondTaskPool, taskOwner, taskRole, check }) {
  // This suite mutates fixtures; independently refuse any non-test database before its first write.
  assert.match(database, /^tp_auth_test_[0-9a-f]{16}$/);
  const identity = (await ownerPool.query(`SELECT current_database() AS database, current_user AS role,
    shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`)).rows[0];
  assert.deepEqual(identity, { database, role: `${database}_owner`, marker: `harness-web-auth-isolated-test:${database.slice('tp_auth_test_'.length)}` });
  const store = createPgTaskStore(taskPool), secondStore = createPgTaskStore(secondTaskPool);
  const service = createTaskService(store), secondService = createTaskService(secondStore);
  const actors = [];
  for (let i = 0; i < 6; i++) {
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    await adminPool.query('INSERT INTO harness_web.accounts(id, username, password_hash) VALUES ($1, $2, $3)', [id, `task-user-${i}`, DUMMY_RECORD]);
    await authStore.createSession({ accountId: id, authVersion: 1, tokenHash: tokenHash(token), ttlSeconds: 3600 });
    actors.push({ id, token, sessionHash: tokenHash(token), csrf: csrfForToken(token) });
  }
  await ownerPool.query("INSERT INTO harness_tasks.projects(id, name, enabled, execution_enabled) VALUES ('project-one', 'One', true, true), ('project-two', 'Two', true, false)");
  for (const actor of actors.slice(0, 5)) await ownerPool.query("INSERT INTO harness_tasks.members(account_id, project_id, can_create, can_execute) VALUES ($1, 'project-one', true, true), ($1, 'project-two', true, true)", [actor.id]);
  const create = (actor = actors[0], options = {}) => service.create(actor.token, actor.csrf, { projectId: 'project-one', requirement: 'isolated synthetic task', idempotencyKey: randomUUID(), ...options });
  const enqueue = (actor, id, key = randomUUID()) => service.enqueue(actor.token, actor.csrf, id, { idempotencyKey: key });
  const denied = operation => assert.rejects(operation, error => error.code === '42501');
  const rejects = (operation, status) => assert.rejects(operation, error => error.status === status);
  const count = async () => Number((await ownerPool.query('SELECT count(*) FROM harness_tasks.tasks')).rows[0].count);
  const reset = async () => { await ownerPool.query('DELETE FROM harness_tasks.tasks'); };
  const seed = async (actor, quantity, state = 'draft') => {
    assert.ok(Number.isInteger(quantity) && quantity > 0 && quantity <= 1000);
    return (await ownerPool.query(`INSERT INTO harness_tasks.tasks(owner_id, project_id, requirement, creation_key, state, execution_key, created_at, queued_at)
      SELECT $1, 'project-one', 'controlled fixture', gen_random_uuid(), $3, CASE WHEN $3 = 'queued' THEN gen_random_uuid() ELSE NULL END,
        now() - interval '3 minutes', CASE WHEN $3 = 'queued' THEN now() - interval '2 minutes' ELSE NULL END
      FROM generate_series(1, $2::integer) RETURNING id`, [actor.id, quantity, state])).rows;
  };
  const revokeDuringAuthorization = async (sql, parameters, operation, expectedCode) => {
    const blocker = await ownerPool.connect();
    let client, pending;
    try {
      client = await taskPool.connect();
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query('BEGIN'); await blocker.query(sql, parameters);
      const isolatedStore = createPgTaskStore({ connect: async () => ({ query: client.query.bind(client), release() {} }) });
      let settled = false;
      pending = operation(isolatedStore).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
      let waiting = false;
      for (let i = 0; i < 40 && !settled; i++) {
        waiting = (await ownerPool.query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted AND locktype = 'transactionid') AS waiting", [pid])).rows[0].waiting;
        if (waiting) break;
        await ownerPool.query('SELECT pg_sleep(0.01)');
      }
      assert.equal(waiting, true, 'authorization must wait for an in-flight permission change, not consume stale permission');
      await blocker.query('COMMIT');
      const result = await pending; assert.equal(result.error?.code, expectedCode);
    } finally {
      try { await releaseFixtureClient(blocker, 'ROLLBACK'); }
      finally {
        try { if (pending) await pending; }
        finally { if (client) await releaseFixtureClient(client); }
      }
    }
  };
  await check('A2 web role has only approved function access, never table or helper access', async () => {
    for (const sql of ['SELECT * FROM harness_tasks.tasks', "UPDATE harness_tasks.tasks SET state = 'queued'", 'DELETE FROM harness_tasks.tasks',
      'SELECT * FROM harness_tasks.members', 'SELECT * FROM harness_web.sessions', 'SELECT password_hash FROM harness_web.accounts',
      `SET ROLE ${taskOwner}`, 'CREATE TABLE harness_tasks.forbidden(id integer)',
      "SELECT harness_tasks.principal(repeat('a', 64), false)", 'SELECT harness_tasks.visible_task(NULL, NULL)']) await denied(taskPool.query(sql));
    await denied(adminPool.query('SELECT * FROM harness_tasks.tasks'));
    const roles = (await ownerPool.query('SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1)', [[taskRole, taskOwner]])).rows;
    assert.equal(roles.length, 2); assert.ok(roles.every(row => !row.rolsuper && !row.rolcreaterole && !row.rolcreatedb && !row.rolbypassrls));
    assert.equal(roles.find(row => row.rolname === taskOwner).rolcanlogin, false);
    assert.equal((await ownerPool.query("SELECT provolatile FROM pg_proc WHERE oid = 'harness_tasks.task_view(harness_tasks.tasks,boolean)'::regprocedure")).rows[0].provolatile, 's');
  });
  await check('A2 project list is authorized and execution eligibility is never inferred', async () => {
    assert.deepEqual(await service.projects(actors[5].token), []);
    assert.deepEqual(await service.projects(actors[0].token), [
      { id: 'project-one', name: 'One', canCreate: true, canExecute: true },
      { id: 'project-two', name: 'Two', canCreate: true, canExecute: false }]);
    await rejects(create(actors[5]), 404); await rejects(create(actors[0], { projectId: 'missing-project' }), 404); assert.equal(await count(), 0);
    const displayName = '🚀'.repeat(128);
    await ownerPool.query("UPDATE harness_tasks.projects SET name = $1 WHERE id = 'project-one'", [displayName]);
    assert.equal((await service.projects(actors[0].token))[0].name, displayName);
    await assert.rejects(ownerPool.query("UPDATE harness_tasks.projects SET name = $1 WHERE id = 'project-one'", [`${displayName}🚀`]), error => error.code === '23514');
    await ownerPool.query("UPDATE harness_tasks.projects SET name = 'One' WHERE id = 'project-one'");
  });
  await check('A2 function owner cannot mutate authentication or read password data', async () => {
    const client = await ownerPool.connect();
    try {
      // Only the isolated fixture operator receives this membership; production grants are unchanged.
      await client.query(`SET ROLE ${taskOwner}`);
      assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, taskOwner);
      for (const sql of ['UPDATE harness_web.accounts SET disabled = true', 'UPDATE harness_web.accounts SET auth_version = auth_version + 1',
        'DELETE FROM harness_web.accounts', 'INSERT INTO harness_web.accounts SELECT * FROM harness_web.accounts',
        'UPDATE harness_web.sessions SET revoked_at = now()', 'DELETE FROM harness_web.sessions',
        'INSERT INTO harness_web.sessions SELECT * FROM harness_web.sessions', 'SELECT password_hash FROM harness_web.accounts',
        'SELECT * FROM harness_web.login_limits']) await denied(client.query(sql));
      const memberships = await client.query('SELECT 1 FROM pg_auth_members WHERE member = $1::regrole', [taskOwner]);
      assert.equal(memberships.rows.length, 0, 'function owner must not inherit any business or admin role');
    } finally { await releaseFixtureClient(client, 'RESET ROLE'); }
    assert.equal((await service.projects(actors[0].token)).length, 2);
  });
  await check('A2 create persists a draft visible through another pool without exposing internal fields', async () => {
    const requirement = '<script>untrusted</script>\n; DROP TABLE tasks;';
    const result = await create(actors[0], { requirement }); assert.equal(result.state, 'draft'); assert.equal(result.replayed, false);
    const read = await secondService.get(actors[0].token, result.id); assert.equal(read.requirement, requirement);
    assert.deepEqual(Object.keys(read).sort(), ['confirmationRequired', 'createdAt', 'id', 'projectId', 'queuedAt', 'requirement', 'state', 'terminalCode']);
    assert.equal(await count(), 1); await reset();
  });
  await check('A2 owner boundaries apply to detail, enqueue, pagination and same-key reuse', async () => {
    const key = randomUUID(); const first = await create(actors[0], { idempotencyKey: key }); const second = await create(actors[1], { idempotencyKey: key });
    assert.notEqual(first.id, second.id);
    for (const id of [first.id, randomUUID()]) {
      await rejects(service.get(actors[1].token, id), 404); await rejects(enqueue(actors[1], id), 404);
      await rejects(service.list(actors[1].token, { after: id }), 404);
    }
    const page = await service.list(actors[1].token); assert.deepEqual(page.items.map(row => row.id), [second.id]);
    assert.equal(page.items[0].requirement, undefined); await reset();
  });
  await check('A2 same-key concurrent create commits exactly one task across pools', async () => {
    const input = { sessionHash: actors[0].sessionHash, projectId: 'project-one', requirement: 'idempotent', creationKey: randomUUID() };
    const result = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : secondStore).create(input)));
    assert.equal(new Set(result.map(row => row.id)).size, 1); assert.equal(result.filter(row => !row.replayed).length, 1);
    assert.equal(await count(), 1); await reset();
  });
  await check('A2 same creation key cannot bind different content or project', async () => {
    const key = randomUUID(); await create(actors[0], { idempotencyKey: key });
    await rejects(create(actors[0], { idempotencyKey: key, requirement: 'different' }), 409);
    await rejects(create(actors[0], { idempotencyKey: key, projectId: 'project-two' }), 409);
    assert.equal(await count(), 1); await reset();
  });
  await check('A2 database independently rejects missing or fabricated sessions', async () => {
    for (const sessionHash of [null, 'bad', 'f'.repeat(64)]) {
      await assert.rejects(store.create({ sessionHash, projectId: 'project-one', requirement: 'text', creationKey: randomUUID() }), error => error.code === 'P0401');
      await assert.rejects(store.list({ sessionHash, after: null, limit: 20 }), error => error.code === 'P0401');
    }
    assert.equal(await count(), 0);
  });
  await check('A2 rechecks revoked, expired, disabled and password-version-invalidated sessions', async () => {
    const actor = actors[0]; const result = await create(actor); const key = randomUUID();
    const changes = [
      ["UPDATE harness_web.sessions SET revoked_at = now() WHERE token_hash = $1", [actor.sessionHash]],
      ["UPDATE harness_web.sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE token_hash = $1", [actor.sessionHash]],
      ['UPDATE harness_web.accounts SET disabled = true WHERE id = $1', [actor.id]],
      ['UPDATE harness_web.accounts SET auth_version = 2 WHERE id = $1', [actor.id]],
    ];
    for (const [sql, parameters] of changes) {
      await ownerPool.query(sql, parameters);
      await rejects(service.get(actor.token, result.id), 401); await rejects(create(actor), 401);
      await rejects(enqueue(actor, result.id, key), 401); await rejects(service.list(actor.token), 401); await rejects(service.projects(actor.token), 401);
      await ownerPool.query('UPDATE harness_web.accounts SET disabled = false, auth_version = 1 WHERE id = $1', [actor.id]);
      await ownerPool.query("UPDATE harness_web.sessions SET revoked_at = NULL, created_at = now(), expires_at = now() + interval '1 hour' WHERE token_hash = $1", [actor.sessionHash]);
    }
    assert.equal((await service.get(actor.token, result.id)).state, 'draft'); assert.equal(await count(), 1); await reset();
  });
  await check('A2 revoked membership and disabled project also block idempotent replays', async () => {
    const actor = actors[0], key = randomUUID(); const created = await create(actor, { idempotencyKey: key });
    for (const mode of ['membership', 'project']) {
      if (mode === 'membership') await ownerPool.query("DELETE FROM harness_tasks.members WHERE account_id = $1 AND project_id = 'project-one'", [actor.id]);
      else await ownerPool.query("UPDATE harness_tasks.projects SET enabled = false WHERE id = 'project-one'");
      await rejects(create(actor, { idempotencyKey: key }), 404); await rejects(service.get(actor.token, created.id), 404);
      await rejects(enqueue(actor, created.id), 404); assert.deepEqual((await service.list(actor.token)).items, []);
      if (mode === 'membership') await ownerPool.query("INSERT INTO harness_tasks.members VALUES ($1, 'project-one', true, true)", [actor.id]);
      else await ownerPool.query("UPDATE harness_tasks.projects SET enabled = true WHERE id = 'project-one'");
    }
    await reset();
  });
  await check('A2 execution requires both current member permission and explicit provider qualification', async () => {
    const actor = actors[0]; const created = await create(actor, { projectId: 'project-two' });
    await rejects(enqueue(actor, created.id), 503);
    await ownerPool.query("UPDATE harness_tasks.members SET can_execute = false WHERE account_id = $1 AND project_id = 'project-two'", [actor.id]);
    await rejects(enqueue(actor, created.id), 403); assert.equal((await service.get(actor.token, created.id)).state, 'draft');
    await ownerPool.query("UPDATE harness_tasks.members SET can_execute = true WHERE account_id = $1 AND project_id = 'project-two'", [actor.id]); await reset();
  });
  await check('A2 queued same-key execution replays reauthorize without changing durable state', async () => {
    const actor = actors[0], created = await create(actor), key = randomUUID();
    await enqueue(actor, created.id, key);
    const before = (await ownerPool.query('SELECT * FROM harness_tasks.tasks WHERE id = $1', [created.id])).rows[0];
    for (const mode of ['member-delete', 'project-disable', 'execute-disable', 'qualification-disable']) {
      try {
        if (mode === 'member-delete') await ownerPool.query("DELETE FROM harness_tasks.members WHERE account_id = $1 AND project_id = 'project-one'", [actor.id]);
        else if (mode === 'project-disable') await ownerPool.query("UPDATE harness_tasks.projects SET enabled = false WHERE id = 'project-one'");
        else if (mode === 'execute-disable') await ownerPool.query("UPDATE harness_tasks.members SET can_execute = false WHERE account_id = $1 AND project_id = 'project-one'", [actor.id]);
        else await ownerPool.query("UPDATE harness_tasks.projects SET execution_enabled = false WHERE id = 'project-one'");
        await rejects(enqueue(actor, created.id, key), mode === 'execute-disable' ? 403 : mode === 'qualification-disable' ? 503 : 404);
        assert.deepEqual((await ownerPool.query('SELECT * FROM harness_tasks.tasks WHERE id = $1', [created.id])).rows[0], before);
      } finally {
        if (mode === 'member-delete') await ownerPool.query("INSERT INTO harness_tasks.members VALUES ($1, 'project-one', true, true)", [actor.id]);
        else if (mode === 'execute-disable') await ownerPool.query("UPDATE harness_tasks.members SET can_execute = true WHERE account_id = $1 AND project_id = 'project-one'", [actor.id]);
        else await ownerPool.query("UPDATE harness_tasks.projects SET enabled = true, execution_enabled = true WHERE id = 'project-one'");
      }
    }
    assert.equal((await enqueue(actor, created.id, key)).replayed, true);
    assert.equal(await count(), 1); await reset();
  });
  await check('A2 concurrent enqueue is one state transition and execution keys cannot be rebound', async () => {
    const created = await create(), other = await create(), key = randomUUID();
    const input = { sessionHash: actors[0].sessionHash, taskId: created.id, executionKey: key };
    const result = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : secondStore).enqueue(input)));
    assert.equal(result.filter(row => !row.replayed).length, 1); assert.ok(result.every(row => row.state === 'queued'));
    await rejects(enqueue(actors[0], other.id, key), 409); await rejects(enqueue(actors[0], created.id), 409);
    assert.equal((await service.get(actors[0].token, other.id)).state, 'draft'); await reset();
  });
  await check('A2 create cannot race an in-flight member or project revocation', async () => {
    const actor = actors[0];
    for (const mode of ['member-delete', 'create-disable', 'project-disable']) {
      const sql = mode === 'member-delete' ? "DELETE FROM harness_tasks.members WHERE account_id = $1 AND project_id = 'project-one'"
        : mode === 'create-disable' ? "UPDATE harness_tasks.members SET can_create = false WHERE account_id = $1 AND project_id = 'project-one'"
          : "UPDATE harness_tasks.projects SET enabled = false WHERE id = 'project-one'";
      await revokeDuringAuthorization(sql, mode === 'project-disable' ? [] : [actor.id], candidate => candidate.create({ sessionHash: actor.sessionHash,
        projectId: 'project-one', requirement: 'revocation race', creationKey: randomUUID() }), 'P0404');
      assert.equal(await count(), 0);
      if (mode === 'member-delete') await ownerPool.query("INSERT INTO harness_tasks.members VALUES ($1, 'project-one', true, true)", [actor.id]);
      else if (mode === 'create-disable') await ownerPool.query("UPDATE harness_tasks.members SET can_create = true WHERE account_id = $1 AND project_id = 'project-one'", [actor.id]);
      else await ownerPool.query("UPDATE harness_tasks.projects SET enabled = true WHERE id = 'project-one'");
    }
  });
  await check('A2 enqueue cannot race an in-flight member, project or qualification revocation', async () => {
    const actor = actors[0], created = await create(actor);
    for (const mode of ['member-delete', 'execute-disable', 'project-disable', 'qualification-disable']) {
      const sql = mode === 'member-delete' ? "DELETE FROM harness_tasks.members WHERE account_id = $1 AND project_id = 'project-one'"
        : mode === 'execute-disable' ? "UPDATE harness_tasks.members SET can_execute = false WHERE account_id = $1 AND project_id = 'project-one'"
          : mode === 'project-disable' ? "UPDATE harness_tasks.projects SET enabled = false WHERE id = 'project-one'"
            : "UPDATE harness_tasks.projects SET execution_enabled = false WHERE id = 'project-one'";
      const code = mode === 'execute-disable' ? 'P0403' : mode === 'qualification-disable' ? 'P0503' : 'P0404';
      await revokeDuringAuthorization(sql, ['member-delete', 'execute-disable'].includes(mode) ? [actor.id] : [], candidate => candidate.enqueue({
        sessionHash: actor.sessionHash, taskId: created.id, executionKey: randomUUID() }), code);
      assert.equal((await ownerPool.query('SELECT state FROM harness_tasks.tasks WHERE id = $1', [created.id])).rows[0].state, 'draft');
      if (mode === 'member-delete') await ownerPool.query("INSERT INTO harness_tasks.members VALUES ($1, 'project-one', true, true)", [actor.id]);
      else if (mode === 'execute-disable') await ownerPool.query("UPDATE harness_tasks.members SET can_execute = true WHERE account_id = $1 AND project_id = 'project-one'", [actor.id]);
      else await ownerPool.query("UPDATE harness_tasks.projects SET enabled = true, execution_enabled = true WHERE id = 'project-one'");
    }
    await reset();
  });
  await check('A2 per-owner creation rate is atomic under concurrency and replay does not consume it', async () => {
    const requests = Array.from({ length: 20 }, () => ({ sessionHash: actors[0].sessionHash, projectId: 'project-one', requirement: 'bounded', creationKey: randomUUID() }));
    const started = performance.now(); const result = await Promise.allSettled(requests.map((input, i) => (i % 2 ? store : secondStore).create(input)));
    assert.equal(result.filter(row => row.status === 'fulfilled').length, 5);
    assert.ok(result.filter(row => row.status === 'rejected').every(row => row.reason.code === 'P0429'));
    const succeeded = result.findIndex(row => row.status === 'fulfilled'); assert.equal((await store.create(requests[succeeded])).replayed, true);
    assert.equal(await count(), 5); console.log(JSON.stringify({ taskCreateConcurrency: 20, successful: 5, elapsedMs: Math.round(performance.now() - started) })); await reset();
  });
  await check('A2 global creation rate is atomic across different owners', async () => {
    const result = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => store.create({ sessionHash: actors[i % 5].sessionHash,
      projectId: 'project-one', requirement: 'global rate', creationKey: randomUUID() })));
    assert.equal(result.filter(row => row.status === 'fulfilled').length, 20); assert.equal(await count(), 20); await reset();
  });
  await check('A2 draft backlog and retained total bounds refuse excess writes', async () => {
    await seed(actors[0], 9);
    const result = await Promise.allSettled(Array.from({ length: 10 }, () => store.create({ sessionHash: actors[0].sessionHash, projectId: 'project-one', requirement: 'draft cap', creationKey: randomUUID() })));
    assert.equal(result.filter(row => row.status === 'fulfilled').length, 1); assert.equal(await count(), 10); await reset();
    await seed(actors[1], 1000); await rejects(create(actors[0]), 429); assert.equal(await count(), 1000); await reset();
  });
  await check('A2 per-owner queue bound is atomic under concurrent execution requests', async () => {
    await seed(actors[0], 4, 'queued'); const drafts = await seed(actors[0], 6);
    const result = await Promise.allSettled(drafts.map(row => store.enqueue({ sessionHash: actors[0].sessionHash, taskId: row.id, executionKey: randomUUID() })));
    assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
    assert.ok(result.filter(row => row.status === 'rejected').every(row => row.reason.code === 'P0429')); await reset();
  });
  await check('A2 global queue bound is atomic across owners', async () => {
    const drafts = [];
    for (let i = 0; i < 5; i++) { await seed(actors[i], i === 4 ? 3 : 4, 'queued'); drafts.push((await seed(actors[i], 1))[0]); }
    const result = await Promise.allSettled(drafts.map((row, i) => store.enqueue({ sessionHash: actors[i].sessionHash, taskId: row.id, executionKey: randomUUID() })));
    assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal((await ownerPool.query("SELECT count(*) FROM harness_tasks.tasks WHERE state = 'queued'")).rows[0].count, '20'); await reset();
  });
  await check('A2 failed create and enqueue transactions leave no partial mutation', async () => {
    const key = randomUUID();
    await assert.rejects(transaction(taskPool, async client => {
      await client.query('SELECT harness_tasks.create_task($1, $2, $3, $4)', [actors[0].sessionHash, 'project-one', 'rollback', key]);
      throw new Error('injected rollback');
    }), /injected/);
    assert.equal(await count(), 0); const created = await create(actors[0], { requirement: 'rollback', idempotencyKey: key });
    const executionKey = randomUUID();
    await assert.rejects(transaction(taskPool, async client => {
      await client.query('SELECT harness_tasks.enqueue_task($1, $2, $3)', [actors[0].sessionHash, created.id, executionKey]);
      throw new Error('injected rollback');
    }), /injected/);
    assert.equal((await service.get(actors[0].token, created.id)).state, 'draft');
    assert.equal((await enqueue(actors[0], created.id, executionKey)).replayed, false); await reset();
  });
  await check('A2 cursor pages contain only own visible metadata, including timestamp ties', async () => {
    const expected = (await seed(actors[0], 5)).map(row => row.id).sort().reverse(); await seed(actors[1], 4);
    const found = []; let after;
    do {
      const page = await service.list(actors[0].token, { limit: 2, ...(after ? { after } : {}) });
      assert.ok(page.items.every(row => !Object.hasOwn(row, 'requirement'))); found.push(...page.items.map(row => row.id)); after = page.nextCursor;
    } while (after);
    assert.deepEqual(found, expected); assert.deepEqual((await service.list(actors[5].token)).items, []); await reset();
  });
  await check('A2 unsafe direct transaction isolation fails closed while store explicitly uses read committed', async () => {
    const client = await taskPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await assert.rejects(client.query('SELECT harness_tasks.create_task($1, $2, $3, $4)', [actors[0].sessionHash, 'project-one', 'wrong snapshot', randomUUID()]), error => error.code === 'P0503');
      await client.query('ROLLBACK');
      await client.query("SET default_transaction_isolation = 'repeatable read'");
      const custom = createPgTaskStore({ connect: async () => ({ query: client.query.bind(client), release() {} }) });
      assert.equal((await custom.create({ sessionHash: actors[0].sessionHash, projectId: 'project-one', requirement: 'explicit override', creationKey: randomUUID() })).state, 'draft');
    } finally { await client.query("SET default_transaction_isolation = 'read committed'"); client.release(); }
    assert.equal(await count(), 1); await reset();
  });
  await check('A2 session expiration during lock wait is rechecked before inserting', async () => {
    const actor = actors[0], token = randomBytes(32).toString('hex');
    const blocker = await ownerPool.connect(); let client, pending;
    try {
      client = await taskPool.connect();
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const isolatedStore = createPgTaskStore({ connect: async () => ({ query: client.query.bind(client), release() {} }) });
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(213804733, 0)');
      await authStore.createSession({ accountId: actor.id, authVersion: 1, tokenHash: tokenHash(token), ttlSeconds: 1 });
      pending = isolatedStore.create({ sessionHash: tokenHash(token), projectId: 'project-one', requirement: 'expires while waiting', creationKey: randomUUID() })
        .then(value => ({ value }), error => ({ error }));
      let waiting = false;
      for (let i = 0; i < 40; i++) {
        waiting = (await ownerPool.query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted AND locktype = 'advisory') AS waiting", [pid])).rows[0].waiting;
        if (waiting) break;
        await ownerPool.query('SELECT pg_sleep(0.01)');
      }
      assert.equal(waiting, true, 'session must expire during a proven advisory-lock wait');
      await blocker.query('SELECT pg_sleep(1.2)');
    } finally {
      try { await releaseFixtureClient(blocker, 'ROLLBACK'); }
      finally {
        try { if (pending) await pending; }
        finally { if (client) await releaseFixtureClient(client); }
      }
    }
    assert.equal((await pending).error?.code, 'P0401'); assert.equal(await count(), 0);
  });
}
if (require.main === module) {
  if (process.argv.length === 2) console.log('SKIP real PostgreSQL task test: requires --controlled-postgres on the approved Linux host');
  else {
    assert.deepEqual(process.argv.slice(2), ['--controlled-postgres']);
    try { execFileSync(process.execPath, [path.join(__dirname, 'test-harness-web-postgres.js'), '--controlled-postgres', '--tasks'], { stdio: 'inherit', timeout: 120000 }); }
    catch { process.exitCode = 1; }
  }
}
module.exports = { run, releaseFixtureClient };
