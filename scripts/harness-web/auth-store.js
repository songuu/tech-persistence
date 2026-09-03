'use strict';
const { tokenHash } = require('./auth');
async function transaction(pool, operation) {
  const client = await pool.connect();
  let broken = false;
  try {
    // Advisory-lock waiters must see commits made by the prior holder, regardless of role defaults.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}
function publicRow(row) {
  return row ? { id: row.id, username: row.username, expiresAt: new Date(row.expires_at).toISOString() } : null;
}
function createPgAuthStore(pool) {
  return {
    async reserveLoginAttempt(username) {
      return transaction(pool, async client => {
        // A short shared lock orders budget updates across service processes, not just one Node instance.
        await client.query('SELECT pg_advisory_xact_lock(213804731, 0)');
        await client.query('DELETE FROM harness_web.login_limits WHERE reset_at <= now()');
        const reserve = async (bucket, seconds, limit) => {
          const result = await client.query(`INSERT INTO harness_web.login_limits(bucket, attempts, reset_at)
            VALUES ($1, 1, now() + $2 * interval '1 second')
            ON CONFLICT (bucket) DO UPDATE SET attempts = LEAST(harness_web.login_limits.attempts + 1, $3 + 1)
            RETURNING attempts`, [bucket, seconds, limit]);
          return result.rows[0].attempts <= limit;
        };
        if (!await reserve('global', 60, 60)) return false;
        return reserve(tokenHash(username), 600, 5);
      });
    },
    async findAccount(username) {
      const result = await pool.query(`SELECT id, username, password_hash, auth_version, disabled
        FROM harness_web.accounts WHERE username = $1`, [username]);
      const row = result.rows[0];
      return row ? { id: row.id, username: row.username, passwordHash: row.password_hash, authVersion: row.auth_version, disabled: row.disabled } : null;
    },
    async createSession({ accountId, authVersion, tokenHash: hash, ttlSeconds }) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error('invalid session lifetime');
      return transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(213804732, hashtext($1))', [accountId]);
        const result = await client.query(`INSERT INTO harness_web.sessions(token_hash, account_id, auth_version, expires_at)
          SELECT $1, a.id, a.auth_version, now() + $4 * interval '1 second'
          FROM harness_web.accounts a
          WHERE a.id = $2 AND a.auth_version = $3 AND NOT a.disabled
            AND (SELECT count(*) FROM harness_web.sessions s WHERE s.account_id = a.id
              AND s.auth_version = a.auth_version AND s.revoked_at IS NULL AND s.expires_at > now()) < 8
          RETURNING account_id AS id, expires_at,
            (SELECT username FROM harness_web.accounts WHERE id = $2) AS username`, [hash, accountId, authVersion, ttlSeconds]);
        return publicRow(result.rows[0]);
      });
    },
    async resolveSession(hash) {
      const result = await pool.query(`SELECT a.id, a.username, s.expires_at FROM harness_web.sessions s
        JOIN harness_web.accounts a ON a.id = s.account_id AND a.auth_version = s.auth_version
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND NOT a.disabled`, [hash]);
      return publicRow(result.rows[0]);
    },
    async revokeSession(hash) {
      await pool.query('UPDATE harness_web.sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE token_hash = $1', [hash]);
    },
  };
}
module.exports = { createPgAuthStore, transaction };
