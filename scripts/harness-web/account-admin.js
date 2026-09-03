'use strict';
const { randomUUID } = require('node:crypto');
const { normalizeUsername, hashPassword } = require('./password');
async function manageAccount(pool, action, input) {
  if (!['create', 'disable', 'reset-password'].includes(action)) throw new Error('invalid account action');
  const keys = action === 'disable' ? ['username'] : ['username', 'password'];
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw new Error('invalid account input');
  const username = normalizeUsername(input.username);
  let result;
  if (action === 'create') {
    const passwordHash = await hashPassword(input.password);
    result = await pool.query(`INSERT INTO harness_web.accounts(id, username, password_hash)
      VALUES ($1, $2, $3) RETURNING id, username, disabled`, [randomUUID(), username, passwordHash]);
  } else if (action === 'disable') {
    result = await pool.query(`UPDATE harness_web.accounts SET disabled = true,
      auth_version = auth_version + 1, updated_at = now() WHERE username = $1 RETURNING id, username, disabled`, [username]);
  } else {
    const passwordHash = await hashPassword(input.password);
    // Do not re-enable a disabled account as an incidental effect of changing its password.
    result = await pool.query(`UPDATE harness_web.accounts SET password_hash = $2,
      auth_version = auth_version + 1, updated_at = now() WHERE username = $1 RETURNING id, username, disabled`, [username, passwordHash]);
  }
  if (!result.rows[0]) throw new Error('account not found');
  return { id: result.rows[0].id, username: result.rows[0].username, disabled: result.rows[0].disabled };
}
async function readAdminInput(stream) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 2048) throw new Error('account input exceeds limit');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid account input'); }
}
module.exports = { manageAccount, readAdminInput };
