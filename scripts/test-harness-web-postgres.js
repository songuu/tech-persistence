'use strict';
// Opt-in only: creates and removes one uniquely owned test database, never production tables.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createPgAuthStore, transaction } = require('./harness-web/auth-store');
const { createAuthService, tokenHash } = require('./harness-web/auth');
const { manageAccount } = require('./harness-web/account-admin');

async function main() {
  if (process.argv.length === 2) { console.log('SKIP real PostgreSQL auth test: requires --controlled-postgres on the approved Linux host'); return; }
  const includeTasks = process.argv[3] === '--tasks';
  assert.deepEqual(process.argv.slice(2), includeTasks ? ['--controlled-postgres', '--tasks'] : ['--controlled-postgres']);
  assert.equal(process.platform, 'linux', 'controlled PostgreSQL tests require Linux');
  const { Pool } = require('pg');
  const suffix = randomBytes(8).toString('hex');
  const database = `tp_auth_test_${suffix}`;
  const owner = `${database}_owner`, runtime = `${database}_web`, admin = `${database}_admin`;
  const taskOwner = `${database}_task_owner`, taskRole = `${database}_tasks`, authorityRole = `${database}_authority`;
  const marker = `harness-web-auth-isolated-test:${suffix}`;
  const pools = [], cases = [];
  let createdOwner = false, createdDatabase = false, installed = false, tasksInstalled = false, executionInstalled = false, currentCase = 'setup';
  function psql(db, sql) {
    assert.ok(db === 'postgres' || db === database, 'never address the production database');
    try {
      return execFileSync('docker', ['exec', '-i', 'tech-persistence-postgres', 'psql', '-X', '-qAt',
        '--set', 'ON_ERROR_STOP=1', '--username', 'postgres', '--dbname', db],
      { input: sql, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { throw new Error('isolated test database administration failed (details suppressed)'); }
  }
  function pool(user, password, extra = {}) {
    const result = new Pool({ host: '127.0.0.1', port: 55433, database, user, password, max: 8,
      connectionTimeoutMillis: 2000, statement_timeout: 5000, lock_timeout: 2000,
      idle_in_transaction_session_timeout: 5000, application_name: 'tp-auth-isolated-test', ...extra });
    result.on('error', () => {}); pools.push(result); return result;
  }
  const check = async (name, run) => { currentCase = name; await run(); cases.push(name); };
  const denied = operation => assert.rejects(operation, error => error.code === '42501');
  const hash = () => tokenHash(randomBytes(32).toString('hex'));
  let cleanupVerified = false;
  try {
    for (const name of [database, owner, runtime, admin, taskOwner, taskRole, authorityRole]) assert.match(name, /^tp_auth_test_[0-9a-f]{16}(?:_owner|_web|_admin|_task_owner|_tasks|_authority)?$/);
    assert.equal(psql('postgres', `SELECT count(*) FROM pg_database WHERE datname = '${database}'`), '0');
    const ownerPassword = randomBytes(32).toString('hex');
    const runtimePassword = randomBytes(32).toString('hex');
    const adminPassword = randomBytes(32).toString('hex');
    psql('postgres', `CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    createdOwner = true;
    psql('postgres', `CREATE DATABASE ${database} OWNER ${owner}`); createdDatabase = true;
    psql('postgres', `COMMENT ON DATABASE ${database} IS '${marker}'`);
    const sql = fs.readFileSync(path.join(__dirname, '../deploy/harness-web/001-auth.sql'), 'utf8')
      .replaceAll('tp_web_account_admin', admin).replaceAll('tp_web_auth', runtime)
      .replace('ON DATABASE tech_persistence', `ON DATABASE ${database}`);
    assert.ok(!sql.includes('tech_persistence'), 'migration may only target the isolated database');
    psql(database, sql); installed = true;
    psql(database, `ALTER ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}';
      ALTER ROLE ${admin} LOGIN PASSWORD '${adminPassword}';
      GRANT USAGE ON SCHEMA harness_web TO ${owner};
      GRANT ALL ON ALL TABLES IN SCHEMA harness_web TO ${owner}`);
    const ownerPool = pool(owner, ownerPassword), runtimePool = pool(runtime, runtimePassword);
    const secondRuntimePool = pool(runtime, runtimePassword), adminPool = pool(admin, adminPassword);
    const store = createPgAuthStore(runtimePool), secondStore = createPgAuthStore(secondRuntimePool);
    const service = createAuthService(store), secondService = createAuthService(secondStore);
    let alice, bob, aliceSession;
    await check('operator creates distinct accounts; runtime reads only salted hashes', async () => {
      alice = await manageAccount(adminPool, 'create', { username: 'alice', password: 'isolated-test alice password' });
      bob = await manageAccount(adminPool, 'create', { username: 'bob', password: 'isolated-test bob password' });
      assert.notEqual(alice.id, bob.id);
      const stored = await store.findAccount('alice'); assert.match(stored.passwordHash, /^scrypt-v1/);
      assert.equal(stored.authVersion, 1); assert.equal(stored.disabled, false);
      assert.equal(await store.findAccount("alice' OR true--"), null);
    });
    await check('dedicated runtime and operator roles enforce least privilege', async () => {
      await denied(runtimePool.query('UPDATE harness_web.accounts SET disabled = true'));
      await denied(runtimePool.query('INSERT INTO harness_web.accounts SELECT * FROM harness_web.accounts'));
      await denied(runtimePool.query('DELETE FROM harness_web.sessions'));
      await denied(runtimePool.query('UPDATE harness_web.sessions SET expires_at = now()'));
      await denied(adminPool.query('SELECT * FROM harness_web.sessions'));
      await denied(adminPool.query('DELETE FROM harness_web.accounts'));
      await denied(adminPool.query("UPDATE harness_web.accounts SET username = 'changed'"));
      await denied(runtimePool.query('CREATE TABLE harness_web.forbidden(id integer)'));
    });
    await check('login commits session visible on independent connection with no plaintext token', async () => {
      aliceSession = await service.login({ username: 'alice', password: 'isolated-test alice password' });
      const principal = await secondService.session(aliceSession.token); assert.equal(principal.user.id, alice.id);
      const rows = (await ownerPool.query('SELECT token_hash, account_id FROM harness_web.sessions')).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].token_hash, tokenHash(aliceSession.token));
      assert.ok(!JSON.stringify(rows).includes(aliceSession.token));
    });
    await check('duplicate session conflict rolls back without damaging prior session', async () => {
      await assert.rejects(store.createSession({ accountId: alice.id, authVersion: 1,
        tokenHash: tokenHash(aliceSession.token), ttlSeconds: 3600 }), error => error.code === '23505');
      assert.equal((await secondService.session(aliceSession.token)).user.id, alice.id);
      const rollbackHash = hash();
      await assert.rejects(transaction(runtimePool, async client => {
        await client.query(`INSERT INTO harness_web.sessions(token_hash, account_id, auth_version, expires_at)
          VALUES ($1, $2, 1, now() + interval '1 hour')`, [rollbackHash, alice.id]);
        throw new Error('injected transaction failure');
      }), /injected/);
      assert.equal(await secondStore.resolveSession(rollbackHash), null);
    });
    await check('session cap is exact under concurrent connections', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : secondStore).createSession({
        accountId: bob.id, authVersion: 1, tokenHash: hash(), ttlSeconds: 3600 })));
      assert.equal(results.filter(Boolean).length, 8);
      assert.ok(results.filter(Boolean).every(row => row.id === bob.id));
    });
    await check('session cap does not inherit an unsafe repeatable-read snapshot', async () => {
      const charlie = await manageAccount(adminPool, 'create', { username: 'charlie', password: 'isolated-test charlie password' });
      for (let i = 0; i < 7; i++) await store.createSession({ accountId: charlie.id, authVersion: 1, tokenHash: hash(), ttlSeconds: 3600 });
      const first = createPgAuthStore(pool(runtime, runtimePassword, { max: 1, options: '-c default_transaction_isolation=repeatable\\ read' }));
      const second = createPgAuthStore(pool(runtime, runtimePassword, { max: 1, options: '-c default_transaction_isolation=repeatable\\ read' }));
      const blocker = await ownerPool.connect(); let pending;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(213804732, hashtext($1))', [charlie.id]);
        pending = Promise.all([first, second].map(item => item.createSession({ accountId: charlie.id, authVersion: 1, tokenHash: hash(), ttlSeconds: 3600 })));
        // Attach a rejection handler while deliberately waiting for both blocked clients.
        pending.catch(() => {});
        let queued = 0;
        for (let attempt = 0; attempt < 60; attempt++) {
          queued = Number((await ownerPool.query(`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'
            AND classid = 213804732 AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].count);
          if (queued === 2) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(queued, 2, 'both transactions must contend on the same lock');
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      const result = await pending; assert.equal(result.filter(Boolean).length, 1);
    });
    await check('CSRF is session-bound and revoked cookie replay fails across connections', async () => {
      await assert.rejects(service.logout(aliceSession.token, 'wrong'), error => error.status === 403);
      await service.logout(aliceSession.token, aliceSession.csrfToken);
      await assert.rejects(secondService.session(aliceSession.token), error => error.status === 401);
      await service.logout(aliceSession.token, aliceSession.csrfToken);
      assert.equal((await ownerPool.query('SELECT count(*) FROM harness_web.sessions WHERE account_id = $1', [alice.id])).rows[0].count, '1');
    });
    await check('database expiry invalidates sessions without relying on browser expiry', async () => {
      const expiredHash = hash(); await store.createSession({ accountId: alice.id, authVersion: 1, tokenHash: expiredHash, ttlSeconds: 3600 });
      await ownerPool.query(`UPDATE harness_web.sessions SET created_at = now() - interval '2 hours',
        expires_at = now() - interval '1 hour' WHERE token_hash = $1`, [expiredHash]);
      assert.equal(await secondStore.resolveSession(expiredHash), null);
    });
    await check('password reset rejects old password, old sessions and stale version login', async () => {
      const oldSession = await service.login({ username: 'alice', password: 'isolated-test alice password' });
      await manageAccount(adminPool, 'reset-password', { username: 'alice', password: 'isolated-test reset password' });
      await assert.rejects(secondService.session(oldSession.token), error => error.status === 401);
      await assert.rejects(service.login({ username: 'alice', password: 'isolated-test alice password' }), error => error.status === 401);
      assert.equal(await store.createSession({ accountId: alice.id, authVersion: 1, tokenHash: hash(), ttlSeconds: 3600 }), null);
      assert.equal((await service.login({ username: 'alice', password: 'isolated-test reset password' })).user.id, alice.id);
    });
    await check('account disable revokes all sessions and reset never re-enables it', async () => {
      const bobHash = (await ownerPool.query('SELECT token_hash FROM harness_web.sessions WHERE account_id = $1 LIMIT 1', [bob.id])).rows[0].token_hash;
      await manageAccount(adminPool, 'disable', { username: 'bob' });
      assert.equal(await secondStore.resolveSession(bobHash), null);
      assert.equal(await store.createSession({ accountId: bob.id, authVersion: 2, tokenHash: hash(), ttlSeconds: 3600 }), null);
      await manageAccount(adminPool, 'reset-password', { username: 'bob', password: 'isolated-test new bob password' });
      await assert.rejects(secondService.login({ username: 'bob', password: 'isolated-test new bob password' }), error => error.status === 401);
      assert.equal((await store.findAccount('bob')).disabled, true);
    });
    await check('per-account limiter is durable and exact under concurrency', async () => {
      await ownerPool.query('DELETE FROM harness_web.login_limits');
      const results = await Promise.all(Array.from({ length: 15 }, (_, i) => (i % 2 ? store : secondStore).reserveLoginAttempt('limit-user')));
      assert.equal(results.filter(Boolean).length, 5);
      assert.equal((await ownerPool.query('SELECT attempts FROM harness_web.login_limits WHERE bucket = $1', [tokenHash('limit-user')])).rows[0].attempts, 6);
    });
    await check('global limiter caps unique buckets and expired budgets reset', async () => {
      await ownerPool.query('DELETE FROM harness_web.login_limits');
      const results = await Promise.all(Array.from({ length: 80 }, (_, i) => (i % 2 ? store : secondStore).reserveLoginAttempt(`limit-user-${i}`)));
      assert.equal(results.filter(Boolean).length, 60);
      assert.equal((await ownerPool.query('SELECT count(*) FROM harness_web.login_limits')).rows[0].count, '61');
      await ownerPool.query("UPDATE harness_web.login_limits SET reset_at = now() - interval '1 second'");
      assert.equal(await secondStore.reserveLoginAttempt('after-expiry'), true);
      assert.equal((await ownerPool.query('SELECT count(*) FROM harness_web.login_limits')).rows[0].count, '2');
    });
    await check('database connection failure cannot authenticate or mint a session', async () => {
      const unavailable = createAuthService(createPgAuthStore(pool(runtime, 'deliberately-wrong-test-password')));
      await assert.rejects(unavailable.login({ username: 'alice', password: 'isolated-test reset password' }));
      await assert.rejects(unavailable.session(aliceSession.token));
    });
    if (includeTasks) {
      currentCase = 'task schema installation';
      const tasksSql = fs.readFileSync(path.join(__dirname, '../deploy/harness-web/002-tasks.sql'), 'utf8')
        .replaceAll('tp_task_owner', taskOwner).replaceAll('tp_web_tasks', taskRole)
        .replace('ON DATABASE tech_persistence', `ON DATABASE ${database}`);
      assert.ok(!tasksSql.includes('tech_persistence'));
      psql(database, tasksSql); tasksInstalled = true;
      const taskPassword = randomBytes(32).toString('hex');
      const authoritySql = fs.readFileSync(path.join(__dirname, '../deploy/harness-web/003-execution.sql'), 'utf8')
        .replaceAll('tp_task_owner', taskOwner).replaceAll('tp_web_tasks', taskRole).replaceAll('tp_task_authority', authorityRole)
        .replaceAll('tp_web_account_admin', admin)
        .replace('ON DATABASE tech_persistence', `ON DATABASE ${database}`);
      assert.ok(!authoritySql.includes('tech_persistence'));
      for (const fixed of ['tp_task_owner', 'tp_web_tasks', 'tp_task_authority', 'tp_web_account_admin']) assert.ok(!authoritySql.includes(fixed));
      psql(database, authoritySql); executionInstalled = true;
      const confirmationSql = fs.readFileSync(path.join(__dirname, '../deploy/harness-web/004-confirm-resume.sql'), 'utf8')
        .replaceAll('tp_task_owner', taskOwner).replaceAll('tp_web_tasks', taskRole)
        .replaceAll('tp_web_account_admin', admin);
      for (const fixed of ['tp_task_owner', 'tp_web_tasks', 'tp_web_account_admin']) assert.ok(!confirmationSql.includes(fixed));
      psql(database, confirmationSql);
      const authorityPassword = randomBytes(32).toString('hex');
      psql(database, `ALTER ROLE ${taskRole} LOGIN PASSWORD '${taskPassword}';
        ALTER ROLE ${authorityRole} LOGIN PASSWORD '${authorityPassword}';
        GRANT ${taskOwner} TO ${owner};
        GRANT USAGE ON SCHEMA harness_tasks TO ${owner}; GRANT ALL ON ALL TABLES IN SCHEMA harness_tasks TO ${owner}`);
      await require('./test-harness-web-tasks-postgres').run({ database, ownerPool, adminPool, authStore: store,
        taskPool: pool(taskRole, taskPassword), secondTaskPool: pool(taskRole, taskPassword), taskOwner, taskRole, check });
      await require('./test-harness-task-execution-postgres').run({ ownerPool, taskPool: pool(taskRole, taskPassword),
        authorityPool: pool(authorityRole, authorityPassword), secondAuthorityPool: pool(authorityRole, authorityPassword), check });
    }
  } catch (error) {
    throw new Error(`PostgreSQL authentication check failed: ${currentCase}; code=${error.code || 'assertion-or-setup'}`);
  } finally {
    await Promise.all(pools.map(item => item.end()));
    if (createdDatabase) {
      // Read back ownership and marker before any DROP. Refuse cleanup if identity has drifted.
      const identity = psql('postgres', `SELECT pg_get_userbyid(datdba) || ':' || COALESCE(shobj_description(oid, 'pg_database'), '')
        FROM pg_database WHERE datname = '${database}'`);
      assert.equal(identity, `${owner}:${marker}`, 'cleanup refused: test database identity mismatch');
      psql('postgres', `DROP DATABASE ${database}`);
    }
    if (executionInstalled) psql('postgres', `DROP ROLE ${authorityRole}`);
    if (tasksInstalled) { psql('postgres', `DROP ROLE ${taskRole}`); psql('postgres', `DROP ROLE ${taskOwner}`); }
    if (installed) psql('postgres', `DROP ROLE ${runtime}; DROP ROLE ${admin}`);
    if (createdOwner) psql('postgres', `DROP ROLE ${owner}`);
    cleanupVerified = psql('postgres', `SELECT count(*) FROM pg_database WHERE datname = '${database}'`) === '0'
      && psql('postgres', `SELECT count(*) FROM pg_roles WHERE rolname IN ('${owner}', '${runtime}', '${admin}', '${taskOwner}', '${taskRole}', '${authorityRole}')`) === '0';
    assert.equal(cleanupVerified, true);
    console.log(JSON.stringify({ isolatedDatabase: database, cleanupVerified, productionDatabaseTouched: false }));
  }
  console.log(JSON.stringify({ passed: cases.length, cases }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
