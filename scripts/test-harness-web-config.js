'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadAuthConfig } = require('./harness-web/config');
const repository = path.resolve(__dirname, '..');
// Linux authority paths cannot descend from world-writable /tmp, even for these fake credentials.
const parent = fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : os.homedir());
const root = fs.mkdtempSync(path.join(parent, '.tp-auth-config-test-'));
fs.chmodSync(root, 0o700);
const secretMarker = 'FAKE_TEST_PASSWORD_MUST_NOT_APPEAR';
const valid = { version: 'harness-web-auth-config-v1', publicOrigin: 'https://songuu.top',
  databaseUrl: `postgresql://tp_web_auth:${secretMarker}@127.0.0.1:9/tech_persistence` };
let counter = 0;
function config(input = valid, mode = 0o600) {
  const file = path.join(root, `config-${counter++}.json`); fs.writeFileSync(file, JSON.stringify(input), { mode }); return file;
}
function cli(script, args, input) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    input, encoding: 'utf8', timeout: 10000, windowsHide: true,
    // No inherited application secrets or NODE_OPTIONS in child test processes.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir() },
  });
  assert.ok(!result.error, 'CLI must terminate within its budget');
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(!output.includes(secretMarker)); assert.ok(!output.includes('postgresql://'));
  assert.ok(!output.includes('password_hash')); assert.ok(!output.includes('listening'));
  assert.equal(result.status, 1); return output;
}
test.after(() => {
  assert.equal(path.dirname(root), parent);
  assert.ok(path.basename(root).startsWith('.tp-auth-config-test-'));
  fs.rmSync(root, { recursive: true, force: true });
});
test('protected config accepts only a dedicated runtime role and fixed origin', () => {
  const loaded = loadAuthConfig(config()); assert.equal(loaded.port, 5183);
  assert.equal(loaded.database.user, 'tp_web_auth'); assert.equal(loaded.database.max, 4);
  assert.equal(loaded.database.statement_timeout, 5000); assert.equal(loaded.database.ssl, false);
});
test('account operator config is purpose-isolated', () => {
  const file = config({ ...valid, databaseUrl: valid.databaseUrl.replace('tp_web_auth', 'tp_web_account_admin') });
  assert.equal(loadAuthConfig(file, 'admin').database.user, 'tp_web_account_admin');
  assert.throws(() => loadAuthConfig(file)); assert.throws(() => loadAuthConfig(config(), 'admin'));
});
test('configuration rejects missing schema, arrays and unknown security overrides', () => {
  for (const input of [null, [], {}, { ...valid, version: 'old' }, { ...valid, allowRegistration: true },
    { ...valid, cookieName: 'dm_session' }, { ...valid, databaseUrl: undefined }]) assert.throws(() => loadAuthConfig(config(input)));
});
test('production origin cannot be widened to a subdomain, URL path or non-TLS origin', () => {
  for (const origin of ['http://songuu.top', 'https://evil.songuu.top', 'https://songuu.top/',
    'https://songuu.top/tech-persistence', 'https://songuu.top:443', undefined]) {
    assert.throws(() => loadAuthConfig(config({ ...valid, publicOrigin: origin })));
  }
});
test('listener configuration rejects privileged, non-integer and invalid ports', () => {
  for (const port of [80, 0, -1, 65536, 5183.5, '5183']) assert.throws(() => loadAuthConfig(config({ ...valid, port })));
});
test('config refuses relative paths and any file in the provider repository', () => {
  assert.throws(() => loadAuthConfig('local.json'), /absolute/);
  assert.throws(() => loadAuthConfig(path.join(repository, 'package.json')), /outside/);
});
test('config refuses directories, missing files, malformed JSON and oversized files', () => {
  assert.throws(() => loadAuthConfig(root)); assert.throws(() => loadAuthConfig(path.join(root, 'missing.json')));
  const malformed = config(); fs.writeFileSync(malformed, '{'); assert.throws(() => loadAuthConfig(malformed));
  const large = config(); fs.writeFileSync(large, 'x'.repeat(256 * 1024 + 1)); assert.throws(() => loadAuthConfig(large), /limit/);
});
test('Linux configuration refuses group-readable secret files', { skip: process.platform === 'win32' }, () => {
  const file = config(); fs.chmodSync(file, 0o640); assert.throws(() => loadAuthConfig(file), /owner-readable/);
});
test('Linux configuration refuses writable ancestors and symlinks', { skip: process.platform === 'win32' }, () => {
  const unsafe = path.join(root, 'unsafe'); fs.mkdirSync(unsafe, { mode: 0o700 });
  const file = path.join(unsafe, 'config.json'); fs.writeFileSync(file, JSON.stringify(valid), { mode: 0o600 });
  fs.chmodSync(unsafe, 0o770); assert.throws(() => loadAuthConfig(file), /unsafe/); fs.chmodSync(unsafe, 0o700);
  const link = path.join(root, 'link.json'); fs.symlinkSync(config(), link); assert.throws(() => loadAuthConfig(link), /links/);
  const directoryLink = path.join(root, 'directory-link'); fs.symlinkSync(unsafe, directoryLink);
  assert.throws(() => loadAuthConfig(path.join(directoryLink, 'config.json')), /links/);
});
test('service CLI refuses arbitrary arguments without exposing supplied secrets', () => {
  assert.match(cli('harness-web-auth.js', ['--password', secretMarker]), /failed to start/);
});
test('service CLI rejects malformed config without exposing its contents', () => {
  assert.match(cli('harness-web-auth.js', ['--config', config({ ...valid, arbitrarySecret: secretMarker })]), /failed to start/);
});
test('service CLI refuses startup when its database is unavailable', () => {
  assert.match(cli('harness-web-auth.js', ['--config', config()]), /failed to start/);
});
test('operator CLI refuses password in argv and unsupported actions', () => {
  for (const args of [['--password', secretMarker], ['--config', config(), '--action', 'enable']]) {
    assert.match(cli('harness-web-account.js', args), /operation failed/);
  }
});
test('operator CLI rejects runtime credentials and malformed private stdin without echoing either', () => {
  assert.match(cli('harness-web-account.js', ['--config', config(), '--action', 'disable'], secretMarker), /operation failed/);
  const operatorFile = config({ ...valid, databaseUrl: valid.databaseUrl.replace('tp_web_auth', 'tp_web_account_admin') });
  assert.match(cli('harness-web-account.js', ['--config', operatorFile, '--action', 'create'], secretMarker), /operation failed/);
  assert.match(cli('harness-web-account.js', ['--config', operatorFile, '--action', 'create'], secretMarker.repeat(100)), /operation failed/);
});
test('operator CLI reports unavailable database generically', () => {
  const operatorFile = config({ ...valid, databaseUrl: valid.databaseUrl.replace('tp_web_auth', 'tp_web_account_admin') });
  assert.match(cli('harness-web-account.js', ['--config', operatorFile, '--action', 'disable'], '{"username":"alice"}'), /operation failed/);
});

for (const mode of ['SIGTERM', 'SIGINT', 'end-reject', 'end-timeout']) {
  test(`service startup and shutdown lifecycle: ${mode}`, () => {
    // Keep real HTTP binding/signal handlers; only replace the database with a controlled double.
    const harnessEntry = path.join(__dirname, 'harness-web-auth.js');
    const source = `
      const assert = require('node:assert/strict');
      const entry = ${JSON.stringify(harnessEntry)};
      const path = require('node:path');
      const mode = process.argv[1], configFile = process.argv[2];
      const config = require(path.join(path.dirname(entry), 'harness-web/config'));
      const realLoad = config.loadAuthConfig;
      config.loadAuthConfig = file => ({ ...realLoad(file), port: 0 });
      let ends = 0;
      config.openPool = () => ({ query: async () => ({ rows: [] }), end: () => {
        ends++; console.log(JSON.stringify({ poolEnds: ends }));
        if (mode === 'end-reject') return Promise.reject(new Error('${secretMarker}'));
        if (mode === 'end-timeout') return new Promise(() => {});
        return Promise.resolve();
      } });
      const httpServer = require(path.join(path.dirname(entry), 'harness-web/auth-server'));
      const create = httpServer.createAuthServer;
      httpServer.createAuthServer = input => {
        const server = create(input);
        server.once('listening', () => assert.equal(server.address().address, '127.0.0.1'));
        return server;
      };
      process.argv = [process.execPath, entry, '--config', configFile];
      require(entry).main().then(() => { process.emit(mode === 'SIGINT' ? 'SIGINT' : 'SIGTERM'); process.emit('SIGINT'); });
    `;
    const result = spawnSync(process.execPath, ['-e', source, mode, config()], {
      encoding: 'utf8', timeout: 9000, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir() },
    });
    assert.ok(!result.error); assert.match(result.stdout, /listening on loopback/);
    assert.equal((result.stdout.match(/"poolEnds":1/g) || []).length, 1);
    assert.doesNotMatch(result.stdout, /"poolEnds":2/);
    assert.ok(!result.stderr.includes(secretMarker), 'shutdown failures must not expose database details');
    assert.equal(result.status, mode.startsWith('end-') ? 1 : 0);
    if (mode === 'end-reject') assert.match(result.stderr, /shutdown failed/);
  });
}

for (const action of ['create', 'disable', 'reset-password']) {
  test(`operator CLI succeeds with public identity only: ${action}`, () => {
    const entry = path.join(__dirname, 'harness-web-account.js');
    const source = `
      const assert = require('node:assert/strict');
      const entry = ${JSON.stringify(entry)};
      const path = require('node:path');
      const action = process.argv[1], file = process.argv[2];
      const config = require(path.join(path.dirname(entry), 'harness-web/config'));
      let ended = false;
      config.openPool = settings => {
        assert.equal(settings.user, 'tp_web_account_admin');
        return { query: async (sql, values) => {
          if (action !== 'disable') assert.match(values[action === 'create' ? 2 : 1], /^scrypt-v1/);
          return { rows: [{ id: 'fixture-account-id', username: 'alice', disabled: action === 'disable',
            password_hash: 'PRIVATE_STORED_HASH', password: '${secretMarker}' }] };
        }, end: async () => { ended = true; } };
      };
      process.argv = [process.execPath, entry, '--config', file, '--action', action];
      require(entry).main().then(() => assert.equal(ended, true)).catch(() => { process.exitCode = 1; });
    `;
    const operatorFile = config({ ...valid, databaseUrl: valid.databaseUrl.replace('tp_web_auth', 'tp_web_account_admin') });
    const input = action === 'disable' ? { username: 'alice' } : { username: 'alice', password: secretMarker };
    const result = spawnSync(process.execPath, ['-e', source, action, operatorFile], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 9000, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir() },
    });
    assert.ok(!result.error); assert.equal(result.status, 0); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { id: 'fixture-account-id', username: 'alice', disabled: action === 'disable' });
    assert.ok(!result.stdout.includes(secretMarker)); assert.ok(!result.stdout.includes('PRIVATE_STORED_HASH'));
  });
}
