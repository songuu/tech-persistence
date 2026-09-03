'use strict';
const { transaction } = require('./auth-store');
function createTaskAuthorityStore(pool) {
  const call = (sql, values) => transaction(pool, async client => {
    const result = await client.query(sql, values);
    if (result.rows.length !== 1 || !Object.hasOwn(result.rows[0], 'result')) throw new Error('invalid authority function response');
    return result.rows[0].result;
  });
  return {
    claim: workerId => call('SELECT harness_tasks.claim_next($1) AS result', [workerId]),
    start: (workerId, claimToken) => call('SELECT harness_tasks.start_claim($1, $2::uuid) AS result', [workerId, claimToken]),
    heartbeat: (workerId, claimToken) => call('SELECT harness_tasks.heartbeat_claim($1, $2::uuid) AS result', [workerId, claimToken]),
    finish: input => call('SELECT harness_tasks.finish_claim($1, $2::uuid, $3, $4, $5) AS result',
      [input.workerId, input.claimToken, input.outcome, input.code, input.resultRef]),
    failBeforeDispatch: input => call('SELECT harness_tasks.fail_claim_before_dispatch($1, $2::uuid, $3, $4) AS result',
      [input.workerId, input.claimToken, input.code, input.resultRef]),
    releaseBeforeDispatch: (workerId, claimToken) => call('SELECT harness_tasks.release_claim_before_dispatch($1, $2::uuid) AS result',
      [workerId, claimToken]),
  };
}
module.exports = { createTaskAuthorityStore };
