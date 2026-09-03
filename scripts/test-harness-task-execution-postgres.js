'use strict';
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createTaskAuthorityStore } = require('./harness-web/task-authority-store');

async function run({ ownerPool, taskPool, authorityPool, secondAuthorityPool, check }) {
  const authority = createTaskAuthorityStore(authorityPool), second = createTaskAuthorityStore(secondAuthorityPool);
  const reset = () => ownerPool.query('DELETE FROM harness_tasks.tasks');
  const actor = async () => (await ownerPool.query(`SELECT m.account_id AS id, s.token_hash FROM harness_tasks.members m
    JOIN harness_web.sessions s ON s.account_id = m.account_id JOIN harness_web.accounts a ON a.id = m.account_id
    WHERE m.project_id = 'project-one' AND m.can_execute AND NOT a.disabled AND s.revoked_at IS NULL AND s.expires_at > now() LIMIT 1`)).rows[0];
  const seed = async (requirement = 'execution test') => {
    const row = await actor(); assert.ok(row);
    return (await ownerPool.query(`INSERT INTO harness_tasks.tasks(owner_id, project_id, requirement, creation_key, state, execution_key, queued_at)
      VALUES ($1, 'project-one', $2, $3, 'queued', $4, clock_timestamp()) RETURNING id`, [row.id, requirement, randomUUID(), randomUUID()])).rows[0].id;
  };
  const state = async id => (await ownerPool.query('SELECT state, claim_token, dispatch_started FROM harness_tasks.tasks WHERE id = $1', [id])).rows[0];
  await reset();
  await check('A3 authority and web roles cannot read or mutate task tables directly', async () => {
    for (const pool of [authorityPool, taskPool]) {
      await assert.rejects(pool.query('SELECT requirement FROM harness_tasks.tasks'), error => error.code === '42501');
      await assert.rejects(pool.query("UPDATE harness_tasks.tasks SET state = 'succeeded'"), error => error.code === '42501');
    }
    await assert.rejects(taskPool.query("SELECT harness_tasks.claim_next('web-1')"), error => error.code === '42501');
  });
  await check('A3 concurrent authority workers obtain exactly one globally fenced claim', async () => {
    const firstId = await seed('first'), secondId = await seed('second');
    const claims = await Promise.all([authority.claim('authority-1'), second.claim('authority-2')]);
    assert.equal(claims.filter(Boolean).length, 1); assert.equal(claims.find(Boolean).taskId, firstId);
    assert.equal((await state(secondId)).state, 'queued'); await reset();
  });
  await check('A3 claim rechecks account, project and member qualification', async () => {
    const id = await seed(); const row = await actor();
    await ownerPool.query("UPDATE harness_tasks.members SET can_execute = false WHERE account_id = $1 AND project_id = 'project-one'", [row.id]);
    assert.equal(await authority.claim('authority-1'), null); assert.equal((await state(id)).state, 'queued');
    await ownerPool.query("UPDATE harness_tasks.members SET can_execute = true WHERE account_id = $1 AND project_id = 'project-one'", [row.id]); await reset();
  });
  await check('A3 wrong fencing tokens cannot start, heartbeat or finish a claim', async () => {
    await seed(); const claim = await authority.claim('authority-1'), wrong = randomUUID();
    assert.equal(await authority.start('authority-1', wrong), false);
    assert.deepEqual(await authority.heartbeat('authority-1', wrong), { owned: false, cancel: true });
    assert.equal(await authority.finish({ workerId: 'authority-1', claimToken: wrong, outcome: 'failed', code: 'wrong', resultRef: 'authority:none' }), false);
    assert.equal((await state(claim.taskId)).state, 'claimed'); await reset();
  });
  await check('A3 pre-dispatch failures are fenced terminal outcomes', async () => {
    const id = await seed(); const claim = await authority.claim('authority-1');
    assert.equal(await authority.failBeforeDispatch({ workerId: 'authority-1', claimToken: randomUUID(), code: 'clone_failed', resultRef: 'sandbox:none' }), false);
    assert.equal(await authority.failBeforeDispatch({ workerId: 'authority-1', claimToken: claim.claimToken, code: 'clone_failed', resultRef: `sandbox:${id}` }), true);
    assert.equal((await state(id)).state, 'failed'); await reset();
  });
  await check('A3 authority shutdown releases only its fenced pre-dispatch claim', async () => {
    const id = await seed(); const claim = await authority.claim('authority-1');
    assert.equal(await authority.releaseBeforeDispatch('authority-1', randomUUID()), false);
    assert.equal(await authority.releaseBeforeDispatch('authority-2', claim.claimToken), false);
    assert.equal(await authority.releaseBeforeDispatch('authority-1', claim.claimToken), true);
    const released = await state(id); assert.equal(released.state, 'queued'); assert.equal(released.claim_token, null);
    const replacement = await second.claim('authority-2'); assert.equal(replacement.taskId, id); assert.notEqual(replacement.claimToken, claim.claimToken);
    await reset();
  });
  await check('A3 dispatch is marked durably before execution and blocks a second claim', async () => {
    await seed(); await seed(); const claim = await authority.claim('authority-1');
    assert.equal(await authority.start('authority-1', claim.claimToken), true); assert.equal((await state(claim.taskId)).dispatch_started, true);
    assert.equal(await second.claim('authority-2'), null); await reset();
  });
  await check('A3 start rechecks revocation after claim', async () => {
    await seed(); const row = await actor(); const claim = await authority.claim('authority-1');
    await ownerPool.query("UPDATE harness_tasks.members SET can_execute = false WHERE account_id = $1 AND project_id = 'project-one'", [row.id]);
    assert.equal(await authority.start('authority-1', claim.claimToken), false); assert.equal((await state(claim.taskId)).state, 'claimed');
    await ownerPool.query("UPDATE harness_tasks.members SET can_execute = true WHERE account_id = $1 AND project_id = 'project-one'", [row.id]); await reset();
  });
  await check('A3 running cancellation is observable and cannot be overwritten by success', async () => {
    const id = await seed(); const row = await actor(); const claim = await authority.claim('authority-1'); await authority.start('authority-1', claim.claimToken);
    const cancelled = (await taskPool.query('SELECT harness_tasks.request_cancel($1, $2) AS result', [row.token_hash, id])).rows[0].result;
    assert.equal(cancelled.state, 'cancel_requested'); assert.deepEqual(await authority.heartbeat('authority-1', claim.claimToken), { owned: true, cancel: true });
    assert.equal(await authority.finish({ workerId: 'authority-1', claimToken: claim.claimToken, outcome: 'succeeded', code: 'ok', resultRef: 'receipt:1' }), false);
    assert.equal(await authority.finish({ workerId: 'authority-1', claimToken: claim.claimToken, outcome: 'cancelled', code: 'cancelled', resultRef: 'authority:cancelled' }), true);
    assert.equal((await state(id)).state, 'cancelled'); await reset();
  });
  await check('A3 cancelled tasks cannot be re-enqueued with a new execution key', async () => {
    const id = await seed(); const row = await actor();
    const cancelled = (await taskPool.query('SELECT harness_tasks.request_cancel($1, $2) AS result', [row.token_hash, id])).rows[0].result;
    assert.equal(cancelled.state, 'cancelled');
    await assert.rejects(taskPool.query('SELECT harness_tasks.enqueue_task($1, $2, $3)', [row.token_hash, id, randomUUID()]), error => error.code === 'P0409');
    assert.equal((await state(id)).state, 'cancelled'); await reset();
  });
  await check('A3 expired pre-dispatch claims are safely requeued with a new fence', async () => {
    await seed(); const first = await authority.claim('authority-1');
    await ownerPool.query("UPDATE harness_tasks.tasks SET lease_until = now() - interval '1 second' WHERE id = $1", [first.taskId]);
    const replacement = await second.claim('authority-2'); assert.equal(replacement.taskId, first.taskId); assert.notEqual(replacement.claimToken, first.claimToken); await reset();
  });
  await check('A3 expired post-dispatch claims require coordination and are never replayed', async () => {
    const id = await seed(); const queuedId = await seed('must remain queued'); const claim = await authority.claim('authority-1'); await authority.start('authority-1', claim.claimToken);
    await ownerPool.query("UPDATE harness_tasks.tasks SET lease_until = now() - interval '1 second' WHERE id = $1", [id]);
    assert.equal(await second.claim('authority-2'), null); assert.equal((await state(id)).state, 'needs_coordination'); assert.equal((await state(queuedId)).state, 'queued'); await reset();
  });
  await check('A3 expired workers cannot write a terminal result before recovery', async () => {
    const id = await seed(); const claim = await authority.claim('authority-1'); await authority.start('authority-1', claim.claimToken);
    await ownerPool.query("UPDATE harness_tasks.tasks SET lease_until = now() - interval '1 second' WHERE id = $1", [id]);
    assert.equal(await authority.finish({ workerId: 'authority-1', claimToken: claim.claimToken, outcome: 'succeeded', code: 'ok', resultRef: 'receipt:1' }), false);
    assert.equal((await state(id)).state, 'running'); await reset();
  });
  await check('A4 owner confirmation resumes only the original spec-ready sandbox under a new fence', async () => {
    const id = await seed(); const row = await actor(); const first = await authority.claim('authority-1');
    await authority.start('authority-1', first.claimToken);
    assert.equal(await authority.finish({ workerId: 'authority-1', claimToken: first.claimToken,
      outcome: 'needs_coordination', code: 'harness_spec_ready', resultRef: `sandbox:${id}:${first.claimToken}` }), true);
    const confirmed = (await taskPool.query('SELECT harness_tasks.confirm_task($1, $2) AS result', [row.token_hash, id])).rows[0].result;
    assert.equal(confirmed.state, 'queued'); assert.equal(confirmed.confirmationRequired, false);
    await assert.rejects(taskPool.query('SELECT harness_tasks.confirm_task($1, $2)', [row.token_hash, id]), error => error.code === 'P0409');
    const resumed = await second.claim('authority-2');
    assert.equal(resumed.taskId, id); assert.equal(resumed.resumeClaimToken, first.claimToken); assert.notEqual(resumed.claimToken, first.claimToken);
    const locator = (await taskPool.query('SELECT harness_tasks.transcript_locator($1, $2) AS value', [row.token_hash, id])).rows[0].value;
    const runRoot = `/var/lib/tech-persistence/task-sandboxes/${id}/${first.claimToken}/evidence/runs/${id}-${first.claimToken}`;
    assert.equal(locator, createHash('sha256').update(runRoot).digest('hex'));
    await reset();
  });
  await check('A3 terminal outcome input is bounded and invalid values roll back', async () => {
    await seed(); const claim = await authority.claim('authority-1'); await authority.start('authority-1', claim.claimToken);
    for (const outcome of ['accepted', 'queued', '../done']) await assert.rejects(authority.finish({ workerId: 'authority-1', claimToken: claim.claimToken,
      outcome, code: 'bad', resultRef: 'receipt:1' }), error => error.code === 'P0400');
    assert.equal((await state(claim.taskId)).state, 'running'); await reset();
  });
}
if (require.main === module) console.log('SKIP real PostgreSQL execution test: invoked by test-harness-web-postgres.js --controlled-postgres --tasks');
module.exports = { run };
