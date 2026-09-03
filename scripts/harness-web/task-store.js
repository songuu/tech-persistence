'use strict';
const { transaction } = require('./auth-store');
function createPgTaskStore(pool, transcriptPool = null) {
  const call = (sql, values) => transaction(pool, async client => {
    const result = await client.query(sql, values);
    if (result.rows.length !== 1 || !Object.hasOwn(result.rows[0], 'result')) throw new Error('invalid task function response');
    return result.rows[0].result;
  });
  return {
    create: input => call('SELECT harness_tasks.create_task($1, $2, $3, $4::uuid) AS result',
      [input.sessionHash, input.projectId, input.requirement, input.creationKey]),
    enqueue: input => call('SELECT harness_tasks.enqueue_task($1, $2::uuid, $3::uuid) AS result',
      [input.sessionHash, input.taskId, input.executionKey]),
    get: input => call('SELECT harness_tasks.get_task($1, $2::uuid) AS result', [input.sessionHash, input.taskId]),
    list: input => call('SELECT harness_tasks.list_tasks($1, $2::uuid, $3::integer) AS result', [input.sessionHash, input.after, input.limit]),
    projects: input => call('SELECT harness_tasks.list_projects($1) AS result', [input.sessionHash]),
    cancel: input => call('SELECT harness_tasks.request_cancel($1, $2::uuid) AS result', [input.sessionHash, input.taskId]),
    confirm: input => call('SELECT harness_tasks.confirm_task($1, $2::uuid) AS result', [input.sessionHash, input.taskId]),
    transcript: async input => {
      if (!transcriptPool) throw new Error('transcript reader is unavailable');
      const locator = await call('SELECT harness_tasks.transcript_locator($1, $2::uuid) AS result', [input.sessionHash, input.taskId]);
      if (locator === null) return { status: 'pending', eventCount: 0, lastSyncedAt: null };
      if (typeof locator !== 'string' || !/^[a-f0-9]{64}$/.test(locator)) throw new Error('invalid transcript locator');
      const result = await transcriptPool.query(`SELECT event_count, last_synced_at FROM public.transcripts
        WHERE transcript_id = $1`, [`openai-compatible:${locator}`]);
      if (result.rows.length === 0) return { status: 'pending', eventCount: 0, lastSyncedAt: null };
      if (result.rows.length !== 1) throw new Error('invalid transcript readback');
      return { status: result.rows[0].last_synced_at ? 'synced' : 'pending', eventCount: Number(result.rows[0].event_count),
        lastSyncedAt: result.rows[0].last_synced_at ? new Date(result.rows[0].last_synced_at).toISOString() : null };
    },
  };
}
module.exports = { createPgTaskStore };
