'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { hashPassword, verifyPassword, normalizeUsername, validPassword } = require('./harness-web/password');
const { createAuthService, tokenHash, csrfForToken } = require('./harness-web/auth');
const { createAuthServer } = require('./harness-web/auth-server');

const PASSWORD = 'test-only passphrase 71!';
class MemoryStore {
  constructor(hash) {
    this.account = { id: crypto.randomUUID(), username: 'operator', passwordHash: hash, authVersion: 1, disabled: false };
    this.sessions = new Map(); this.now = Date.now(); this.attempts = new Map(); this.fail = false;
  }
  check() { if (this.fail) throw new Error('postgres://private-password@private-host'); }
  async reserveLoginAttempt(username) { this.check(); const count = (this.attempts.get(username) || 0) + 1; this.attempts.set(username, count); return count <= 5; }
  async findAccount(username) { this.check(); return username === this.account.username ? { ...this.account } : null; }
  async createSession(input) {
    this.check();
    if (this.account.disabled || this.account.authVersion !== input.authVersion) return null;
    const row = { id: this.account.id, username: this.account.username, authVersion: input.authVersion,
      expiresAt: new Date(this.now + input.ttlSeconds * 1000).toISOString(), revoked: false };
    this.sessions.set(input.tokenHash, row); return { ...row };
  }
  async resolveSession(hash) {
    this.check(); const row = this.sessions.get(hash);
    return row && !row.revoked && !this.account.disabled && row.authVersion === this.account.authVersion && Date.parse(row.expiresAt) > this.now ? { ...row } : null;
  }
  async revokeSession(hash) { this.check(); const row = this.sessions.get(hash); if (row) row.revoked = true; }
}

let passwordHash;
test.before(async () => { passwordHash = await hashPassword(PASSWORD); });
test('scrypt uses fixed production cost and does not retain the password', async () => {
  assert.match(passwordHash, /^scrypt-v1\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.ok(!passwordHash.includes(PASSWORD)); assert.equal(await verifyPassword(PASSWORD, passwordHash), true);
  assert.equal(await verifyPassword('a wrong passphrase!', passwordHash), false);
});
test('password salts are random', async () => { assert.notEqual(await hashPassword(PASSWORD), passwordHash); });
test('password bounds reject short, long, invalid and oversized values', async () => {
  for (const value of [null, 42, '', 'short', 'a'.repeat(129), '😀'.repeat(129)]) assert.equal(validPassword(value), false);
  assert.equal(validPassword('中'.repeat(15)), true); await assert.rejects(hashPassword('short'));
});
test('malformed hash cannot choose cheaper or unbounded scrypt parameters', async () => {
  for (const value of ['bad', passwordHash.replace('131072', '2'), passwordHash.replace('131072', '999999999'), passwordHash + '$extra']) {
    await assert.rejects(verifyPassword(PASSWORD, value), /password record/);
  }
});
test('usernames are canonical bounded ASCII identifiers', () => {
  assert.equal(normalizeUsername(' Operator '), 'operator');
  for (const value of ['ab', 'a'.repeat(65), '../admin', "admin' OR 1=1", '<script>', {}, null]) assert.throws(() => normalizeUsername(value));
});

async function fixture(t) {
  const store = new MemoryStore(passwordHash); const service = createAuthService(store);
  const server = createAuthServer({ service, publicOrigin: 'https://songuu.top' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const call = (pathname, options = {}) => new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const headers = options.rawHeaders || { Host: 'songuu.top', Origin: 'https://songuu.top', 'X-TP-Client': '1',
      ...(body === null ? {} : { 'Content-Type': 'application/json' }), ...options.headers };
    const request = http.request({ host: '127.0.0.1', port: server.address().port,
      path: `/tech-persistence/api/v1${pathname}`, method: options.method || (body === null ? 'GET' : 'POST'), headers }, response => {
      let text = ''; response.on('data', chunk => text += chunk); response.on('end', () => {
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject); request.end(body);
  });
  const login = () => call('/auth/login', { body: { username: 'operator', password: PASSWORD } });
  return { store, service, call, login, server };
}
function cookie(result) { return result.headers['set-cookie'][0].split(';')[0]; }

test('login issues a unique secure cookie, stores only its hash, and exposes no credentials', async t => {
  const f = await fixture(t); const first = await f.login(); const second = await f.login();
  assert.equal(first.status, 200); assert.notEqual(cookie(first), cookie(second));
  assert.match(first.headers['set-cookie'][0], /^__Host-tp_session=[a-f0-9]{64};/);
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=3600']) assert.ok(first.headers['set-cookie'][0].includes(flag));
  assert.ok(!first.headers['set-cookie'][0].includes('Domain='));
  const token = cookie(first).split('=')[1]; assert.ok(f.store.sessions.has(tokenHash(token))); assert.ok(!f.store.sessions.has(token));
  assert.ok(!first.text.includes(token)); assert.ok(!first.text.includes(PASSWORD)); assert.ok(!first.text.includes(passwordHash));
  assert.equal(first.json.user.id, f.store.account.id); assert.equal(first.headers['cache-control'], 'no-store');
});
test('session lookup binds the principal to its stored session, never a forwarded header', async t => {
  const f = await fixture(t); const logged = await f.login();
  const result = await f.call('/auth/session', { headers: { Cookie: cookie(logged), 'X-User-Id': 'attacker', 'X-Forwarded-User': 'attacker' } });
  assert.equal(result.status, 200); assert.equal(result.json.user.id, f.store.account.id); assert.match(result.json.csrfToken, /^[a-f0-9]{64}$/);
});
test('missing or fabricated session and forwarded identity are unauthorized', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { 'X-User-Id': 'operator' }, { Cookie: '__Host-tp_session=' + 'a'.repeat(64) }, { Cookie: '__Host-tp_session=bad' }]) {
    assert.equal((await f.call('/auth/session', { headers })).status, 401);
  }
});
test('logout revokes server state and replaying the copied cookie fails', async t => {
  const f = await fixture(t); const logged = await f.login(); const storedCookie = cookie(logged);
  const session = await f.call('/auth/session', { headers: { Cookie: storedCookie } });
  const headers = { Cookie: storedCookie, 'X-TP-CSRF': session.json.csrfToken };
  const logout = await f.call('/auth/logout', { body: {}, headers });
  assert.equal(logout.status, 204); assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await f.call('/auth/session', { headers: { Cookie: storedCookie } })).status, 401);
  assert.equal((await f.call('/auth/logout', { body: {}, headers })).status, 204);
});
test('expiration is enforced server-side', async t => {
  const f = await fixture(t); const logged = await f.login(); f.store.now += 3600001;
  assert.equal((await f.call('/auth/session', { headers: { Cookie: cookie(logged) } })).status, 401);
});
test('disabling the account invalidates existing sessions', async t => {
  const f = await fixture(t); const logged = await f.login(); f.store.account.disabled = true;
  assert.equal((await f.call('/auth/session', { headers: { Cookie: cookie(logged) } })).status, 401);
  assert.equal((await f.login()).status, 401);
});
test('password version changes invalidate all earlier sessions', async t => {
  const f = await fixture(t); const logged = await f.login(); f.store.account.authVersion++;
  assert.equal((await f.call('/auth/session', { headers: { Cookie: cookie(logged) } })).status, 401);
});
test('logout requires the correct session-bound CSRF token', async t => {
  const f = await fixture(t); const logged = await f.login();
  for (const csrf of [undefined, 'a'.repeat(64), csrfForToken('b'.repeat(64))]) {
    const headers = { Cookie: cookie(logged), ...(csrf ? { 'X-TP-CSRF': csrf } : {}) };
    assert.equal((await f.call('/auth/logout', { body: {}, headers })).status, 403);
  }
  assert.equal((await f.call('/auth/session', { headers: { Cookie: cookie(logged) } })).status, 200);
});
test('cross-origin, missing Origin and null Origin mutations are rejected before login', async t => {
  const f = await fixture(t);
  for (const origin of ['', 'null', 'https://evil.test', 'https://songuu.top.evil.test', 'http://songuu.top']) {
    assert.equal((await f.call('/auth/login', { body: { username: 'operator', password: PASSWORD }, headers: { Origin: origin } })).status, 403);
  }
  assert.equal(f.store.attempts.size, 0);
});
test('wrong Host and cross-site fetch metadata are rejected', async t => {
  const f = await fixture(t);
  for (const headers of [{ Host: 'evil.test' }, { Host: 'songuu.top:443' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await f.call('/auth/session', { headers })).status, 403);
  }
});
test('duplicate security headers are rejected', async t => {
  const f = await fixture(t);
  for (const [name, value] of [['Host', 'songuu.top'], ['Origin', 'https://songuu.top'], ['X-TP-Client', '1'], ['Cookie', 'x=y'], ['X-TP-CSRF', 'a'.repeat(64)]]) {
    const raw = ['Host', 'songuu.top', 'Origin', 'https://songuu.top', 'X-TP-Client', '1'];
    if (!['Host', 'Origin', 'X-TP-Client'].includes(name)) raw.push(name, value);
    raw.push(name, value);
    assert.equal((await f.call('/auth/session', { rawHeaders: raw })).status, 400);
  }
});
test('duplicate session cookie names cannot be resolved ambiguously', async t => {
  const f = await fixture(t); const logged = await f.login();
  assert.equal((await f.call('/auth/session', { headers: { Cookie: `${cookie(logged)}; ${cookie(logged)}` } })).status, 400);
});
test('login cannot be submitted as form data or without its custom header', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/auth/login', { body: 'username=operator', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await f.call('/auth/login', { body: {}, headers: { 'X-TP-Client': '' } })).status, 403);
});
test('malformed JSON, unknown fields and invalid credentials shape fail without signing in', async t => {
  const f = await fixture(t);
  for (const body of ['{bad', 'null', '[]', { username: 'operator', password: PASSWORD, admin: true }, { username: 'operator' }, { username: {}, password: PASSWORD }]) {
    assert.equal((await f.call('/auth/login', { body })).status, 400);
  }
  assert.equal(f.store.sessions.size, 0);
});
test('body byte limit is enforced', async t => {
  const f = await fixture(t); assert.equal((await f.call('/auth/login', { body: 'a'.repeat(32769) })).status, 413);
});
test('nonexistent account and wrong password share the same rejection', async t => {
  const f = await fixture(t);
  const a = await f.call('/auth/login', { body: { username: 'missing', password: PASSWORD } });
  const b = await f.call('/auth/login', { body: { username: 'operator', password: 'different password 25' } });
  assert.equal(a.status, 401); assert.deepEqual(a.json, b.json);
});
test('per-account attempt reservation blocks password guessing', async t => {
  const f = await fixture(t); for (let i = 0; i < 5; i++) await f.store.reserveLoginAttempt('operator');
  assert.equal((await f.login()).status, 429); assert.equal(f.store.sessions.size, 0);
});
test('database failure is sanitized and does not issue a cookie', async t => {
  const f = await fixture(t); f.store.fail = true; const result = await f.login();
  assert.equal(result.status, 503); assert.equal(result.headers['set-cookie'], undefined); assert.ok(!result.text.includes('private'));
});
test('a failed session commit cannot issue an authenticated cookie', async t => {
  const f = await fixture(t); f.store.createSession = async () => { throw new Error('secret database failure'); };
  const result = await f.login(); assert.equal(result.status, 503); assert.equal(result.headers['set-cookie'], undefined);
});
test('account change during password verification prevents session creation', async t => {
  const f = await fixture(t); const original = f.store.findAccount.bind(f.store);
  f.store.findAccount = async username => { const old = await original(username); f.store.account.authVersion++; return old; };
  assert.equal((await f.login()).status, 401); assert.equal(f.store.sessions.size, 0);
});
test('only two concurrent login operations may run and slots are released on failures', async t => {
  const f = await fixture(t); const releases = [];
  f.store.reserveLoginAttempt = () => new Promise(resolve => releases.push(resolve));
  const first = f.login(); const second = f.login();
  while (releases.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.login()).status, 429); releases.forEach(resolve => resolve(false));
  assert.equal((await first).status, 429); assert.equal((await second).status, 429);
  f.store.reserveLoginAttempt = async () => true; assert.equal((await f.login()).status, 200);
});
test('no registration, account management or task execution routes exist in the auth service', async t => {
  const f = await fixture(t);
  for (const pathname of ['/auth/register', '/auth/create-account', '/tasks', '/auth/../tasks']) {
    assert.equal((await f.call(pathname, { body: {} })).status, 404);
  }
  assert.equal((await f.call('/auth/logout')).status, 405);
});
test('database read failure never falls back to a stateless session', async t => {
  const f = await fixture(t); const logged = await f.login(); f.store.fail = true;
  assert.equal((await f.call('/auth/session', { headers: { Cookie: cookie(logged) } })).status, 503);
});

test('shared admission bounds abandoned session requests until their database operations settle', { timeout: 5000 }, async t => {
  const f = await fixture(t); const pending = [];
  f.store.resolveSession = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  try {
    for (let wave = 0; wave < 3; wave++) {
      await Promise.all(Array.from({ length: 20 }, () => new Promise(resolve => {
        const request = http.request({ host: '127.0.0.1', port: f.server.address().port,
          path: '/tech-persistence/api/v1/auth/session', headers: { Host: 'songuu.top', Cookie: '__Host-tp_session=' + 'a'.repeat(64) } }, response => response.resume());
        const deadline = setTimeout(() => request.destroy(), 60);
        request.on('error', () => {}); request.on('close', () => { clearTimeout(deadline); resolve(); }); request.end();
      })));
    }
    assert.equal(pending.length, 16, 'disconnects must not release in-flight database admission');
    assert.equal((await f.call('/auth/session', { headers: { Cookie: '__Host-tp_session=' + 'a'.repeat(64) } })).status, 429);
  } finally { pending.forEach(item => item.reject(new Error('injected store failure'))); }
  // A settled rejection releases the same slot even if its HTTP client has gone away.
  await new Promise(resolve => setImmediate(resolve)); f.store.resolveSession = async () => null;
  assert.equal((await f.call('/auth/session', { headers: { Cookie: '__Host-tp_session=' + 'a'.repeat(64) } })).status, 401);
});

test('trickled request bodies cannot stretch the receive timeout to Node default scan interval', { timeout: 9000 }, async t => {
  const f = await fixture(t);
  assert.ok(f.server.connectionsCheckingInterval <= 250);
  const started = Date.now(); let forced = false;
  await new Promise(resolve => {
    const request = http.request({ host: '127.0.0.1', port: f.server.address().port, method: 'POST',
      path: '/tech-persistence/api/v1/auth/login', headers: { Host: 'songuu.top', Origin: 'https://songuu.top',
        'X-TP-Client': '1', 'Content-Type': 'application/json', 'Content-Length': '1000' } }, response => response.resume());
    request.on('error', () => {}); request.write(' ');
    const trickle = setInterval(() => request.write(' '), 200);
    const deadline = setTimeout(() => { forced = true; request.destroy(); }, 7000);
    request.on('close', () => { clearInterval(trickle); clearTimeout(deadline); resolve(); });
  });
  assert.equal(forced, false, 'server must enforce the receive deadline, not just idle timeout');
  assert.ok(Date.now() - started < 7000); assert.equal(f.store.attempts.size, 0);
});
