'use strict';
const crypto = require('node:crypto');
const { normalizeUsername, validPassword, verifyPassword, DUMMY_RECORD } = require('./password');
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_TTL_SECONDS = 3600;
class AuthError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function validToken(value) { return typeof value === 'string' && TOKEN_PATTERN.test(value); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function csrfForToken(token) { return crypto.createHmac('sha256', token).update('tp-auth-csrf-v1').digest('hex'); }
function checkCsrf(token, csrf) {
  if (!validToken(token)) throw new AuthError(401, 'unauthorized');
  if (!validToken(csrf) || !crypto.timingSafeEqual(Buffer.from(csrf, 'hex'), Buffer.from(csrfForToken(token), 'hex'))) {
    throw new AuthError(403, 'invalid_csrf');
  }
}
function publicSession(row, token) {
  return { user: { id: row.id, username: row.username }, expiresAt: row.expiresAt, csrfToken: csrfForToken(token) };
}
function createAuthService(store) {
  let activeLogins = 0;
  return {
    async login(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'username') || !Object.hasOwn(input, 'password')) {
        throw new AuthError(400, 'invalid_request');
      }
      let username;
      try { username = normalizeUsername(input.username); } catch { throw new AuthError(400, 'invalid_request'); }
      if (!validPassword(input.password)) throw new AuthError(400, 'invalid_request');
      // Claim before the first await: callers cannot race into unbounded scrypt allocations.
      if (activeLogins >= 2) throw new AuthError(429, 'login_busy');
      activeLogins++;
      try {
        if (!await store.reserveLoginAttempt(username)) throw new AuthError(429, 'login_throttled');
        const account = await store.findAccount(username);
        const verified = await verifyPassword(input.password, account?.passwordHash || DUMMY_RECORD);
        if (!verified || !account || account.disabled) throw new AuthError(401, 'invalid_credentials');
        const token = crypto.randomBytes(32).toString('hex');
        const row = await store.createSession({ accountId: account.id, authVersion: account.authVersion,
          tokenHash: tokenHash(token), ttlSeconds: SESSION_TTL_SECONDS });
        if (!row) throw new AuthError(401, 'invalid_credentials');
        return { token, ...publicSession(row, token) };
      } finally { activeLogins--; }
    },
    async session(token) {
      if (!validToken(token)) throw new AuthError(401, 'unauthorized');
      const row = await store.resolveSession(tokenHash(token));
      if (!row) throw new AuthError(401, 'unauthorized');
      return publicSession(row, token);
    },
    async logout(token, csrf) {
      checkCsrf(token, csrf);
      // Repeated logout is safe, but storage failure must not be reported as revocation.
      await store.revokeSession(tokenHash(token));
    },
  };
}
module.exports = { AuthError, createAuthService, tokenHash, csrfForToken, checkCsrf, validToken, SESSION_TTL_SECONDS };
