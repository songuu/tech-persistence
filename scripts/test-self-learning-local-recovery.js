'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const store = require('./lib/self-learning-store');
const guard = require('./lib/self-learning-local-recovery-guard');

const available = process.platform === 'win32' && guard.supportsNodeSqlite();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-local-recovery-'));
  const dir = path.join(root, 'store');
  const prior = process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT;
  process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT = root;
  t.after(() => {
    if (prior === undefined) delete process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT;
    else process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dir };
}

function createDeadLock(dir) {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  assert.equal(child.status, 0);
  const journal = path.join(dir, store.JOURNAL_DIR_NAME);
  fs.mkdirSync(journal, { recursive: true });
  const lockFile = path.join(journal, store.LOCK_FILE_NAME);
  const lock = { schema_version: store.LOCK_SCHEMA_VERSION, token: 'a'.repeat(32), pid: child.pid,
    operation: 'test', acquired_at: '2000-01-01T00:00:00.000Z' };
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  return { lockFile, lock };
}

function run(dir, source) {
  return spawnSync(process.execPath, ['-e', source, require.resolve('./lib/self-learning-store'), dir], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
}

for (const [name, patch, exitCode] of [
  ['claim published', `const original=fs.linkSync;fs.linkSync=(a,b)=>{const r=original(a,b);if(String(b).endsWith(s.LOCK_RECOVERY_CLAIM_FILE_NAME))process.exit(71);return r}`, 71],
  ['lock moved to quarantine', `const original=fs.renameSync;fs.renameSync=(a,b)=>{const r=original(a,b);if(String(b).includes('.journal-local-recovery-'))process.exit(72);return r}`, 72],
  ['quarantine deleted', `const original=fs.unlinkSync;fs.unlinkSync=(a)=>{const r=original(a);if(String(a).includes('.journal-local-recovery-'))process.exit(73);return r}`, 73],
]) {
  test(`automatic recovery after hard exit: ${name}`, { skip: !available }, (t) => {
    const { dir } = fixture(t);
    createDeadLock(dir);
    const child = run(dir, `const fs=require('fs'),s=require(process.argv[1]);${patch};s.acquireJournalLock(process.argv[2],{stale_lock_age_ms:0,retry_timeout_ms:5000})`);
    assert.equal(child.status, exitCode, child.stderr);
    const lock = store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 5000 });
    lock.release();
    assert.equal(store.readJournal(dir).revision, 0);
    assert.equal(fs.existsSync(path.join(dir, store.LOCK_RECOVERY_CLAIM_FILE_NAME)), false);
  });
}

test('recovery resumes after hard exit between restored hard-link and quarantine deletion', { skip: !available }, (t) => {
  const { dir } = fixture(t);
  createDeadLock(dir);
  const child = run(dir, `
    const fs=require('fs'),s=require(process.argv[1]),path=require('path');
    const stat=fs.lstatSync,rm=fs.rmSync,rename=fs.renameSync;
    let moved=false;const stage=path.join(process.argv[2],'.journal-record-'+ 'a'.repeat(32)+'.tmp');
    fs.renameSync=(a,b)=>{const r=rename(a,b);if(String(b).includes('.journal-local-recovery-')){moved=true;fs.writeFileSync(stage,'private stage')}return r};
    fs.lstatSync=(p,...a)=>{if(moved&&String(p)===stage){const e=new Error('transient');e.code='EACCES';throw e}return stat(p,...a)};
    fs.rmSync=(p,...a)=>{if(String(p).includes('.journal-local-recovery-'))process.exit(74);return rm(p,...a)};
    s.acquireJournalLock(process.argv[2],{stale_lock_age_ms:0,retry_timeout_ms:5000});
  `);
  assert.equal(child.status, 74, child.stderr);
  const lockHandle = store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 5000 });
  lockHandle.release();
  assert.equal(store.readJournal(dir).revision, 0);
});

test('legacy ownerless claim stays intact even for declared local store', { skip: !available }, (t) => {
  const { dir } = fixture(t);
  const { lockFile } = createDeadLock(dir);
  const claim = path.join(dir, store.LOCK_RECOVERY_CLAIM_FILE_NAME);
  fs.linkSync(lockFile, claim);
  assert.throws(() => store.acquireJournalLock(dir, { retry_timeout_ms: 50, stale_lock_age_ms: 0 }),
    (error) => error.code === 'SELF_LEARNING_LOCKED');
  assert.equal(fs.existsSync(claim), true);
  assert.equal(fs.existsSync(lockFile), true);
});

test('unattested local store does not auto-remove a dead PID lock', { skip: !available }, (t) => {
  const { dir } = fixture(t);
  const { lockFile } = createDeadLock(dir);
  delete process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT;
  assert.throws(() => store.acquireJournalLock(dir, { retry_timeout_ms: 50, stale_lock_age_ms: 0 }),
    (error) => error.code === 'SELF_LEARNING_RECOVERY_UNAVAILABLE');
  assert.equal(fs.existsSync(lockFile), true);
});

test('a live or reused PID blocks recovery and preserves the claim and lock', { skip: !available }, (t) => {
  const { dir } = fixture(t);
  const { lockFile, lock } = createDeadLock(dir);
  const child = run(dir, `const fs=require('fs'),s=require(process.argv[1]);const f=fs.linkSync;fs.linkSync=(a,b)=>{const x=f(a,b);if(String(b).endsWith(s.LOCK_RECOVERY_CLAIM_FILE_NAME))process.exit(71);return x};s.acquireJournalLock(process.argv[2],{stale_lock_age_ms:0,retry_timeout_ms:5000})`);
  assert.equal(child.status, 71, child.stderr);
  const claim = path.join(dir, store.LOCK_RECOVERY_CLAIM_FILE_NAME);
  const before = fs.readFileSync(lockFile);
  const originalKill = process.kill;
  try {
    process.kill = (pid, signal) => pid === lock.pid && signal === 0 ? true : originalKill(pid, signal);
    assert.throws(() => store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 50 }),
      (error) => error.code === 'SELF_LEARNING_LOCKED');
  } finally { process.kill = originalKill; }
  assert.deepEqual(fs.readFileSync(lockFile), before);
  assert.equal(fs.existsSync(claim), true);
});

test('different-inode lock and quarantine are both preserved', { skip: !available }, (t) => {
  const { dir } = fixture(t);
  const { lockFile } = createDeadLock(dir);
  const child = run(dir, `const fs=require('fs'),s=require(process.argv[1]);const f=fs.linkSync;fs.linkSync=(a,b)=>{const x=f(a,b);if(String(b).endsWith(s.LOCK_RECOVERY_CLAIM_FILE_NAME))process.exit(71);return x};s.acquireJournalLock(process.argv[2],{stale_lock_age_ms:0,retry_timeout_ms:5000})`);
  assert.equal(child.status, 71, child.stderr);
  const claimFile = path.join(dir, store.LOCK_RECOVERY_CLAIM_FILE_NAME);
  const claim = JSON.parse(fs.readFileSync(claimFile));
  const quarantine = path.join(dir, `.journal-local-recovery-${claim.recovery_token}.json`);
  fs.copyFileSync(lockFile, quarantine);
  assert.notEqual(fs.statSync(lockFile).ino, fs.statSync(quarantine).ino);
  const before = fs.readFileSync(lockFile);
  assert.throws(() => store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 50 }),
    (error) => error.code === 'SELF_LEARNING_LOCKED');
  assert.deepEqual(fs.readFileSync(lockFile), before);
  assert.deepEqual(fs.readFileSync(quarantine), before);
  assert.equal(fs.existsSync(claimFile), true);
});

test('Node 22.0–22.4 do not advertise built-in SQLite recovery', () => {
  const availableModule = () => ({ DatabaseSync() {} });
  for (const version of ['18.20.0', '22.0.0', '22.4.1']) assert.equal(guard.supportsNodeSqlite(version, availableModule), false);
  for (const version of ['22.5.0', '22.22.0', '23.0.0']) assert.equal(guard.supportsNodeSqlite(version, availableModule), true);
});

test('SQLite support requires a loadable built-in with DatabaseSync', () => {
  const absent = () => { const error = new Error('disabled'); error.code = 'ERR_UNKNOWN_BUILTIN_MODULE'; throw error; };
  for (const version of ['22.5.0', '22.12.0', '23.0.0', '23.3.0', '24.0.0']) {
    assert.equal(guard.supportsNodeSqlite(version, absent), false);
    assert.equal(guard.supportsNodeSqlite(version, () => ({})), false);
    assert.equal(guard.supportsNodeSqlite(version, () => ({ DatabaseSync() {} })), true);
  }
});

test('guard handles Windows paths longer than 260 characters', { skip: !available }, (t) => {
  const { root } = fixture(t);
  const storeDir = path.join(root, 'x'.repeat(110), 'y'.repeat(110));
  fs.mkdirSync(storeDir, { recursive: true });
  assert(path.join(storeDir, guard.GUARD_FILE).length > 260);
  const held = guard.acquireGuard(storeDir, 1000);
  try { held.verify(); } finally { held.release(); }
});

test('explicitly disabled experimental SQLite is not treated as available', { skip: !available }, (t) => {
  const { root, dir } = fixture(t);
  const { lockFile } = createDeadLock(dir);
  const before = fs.readFileSync(lockFile);
  const child = spawnSync(process.execPath, ['--no-experimental-sqlite', '-e', `
    const s=require(process.argv[1]),g=require(process.argv[2]);
    const enabled=g.isEnabledForStore(process.argv[3]);
    try{s.acquireJournalLock(process.argv[3],{stale_lock_age_ms:0,retry_timeout_ms:50});process.exit(3)}
    catch(e){process.stdout.write(JSON.stringify({enabled,code:e.code}));process.exit(0)}
  `, require.resolve('./lib/self-learning-store'), require.resolve('./lib/self-learning-local-recovery-guard'), dir], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT: root, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { enabled: false, code: 'SELF_LEARNING_RECOVERY_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(lockFile), before);
});

test('a foreign SQLite guard with forged marker is not modified', { skip: !available }, (t) => {
  const { dir } = fixture(t);
  createDeadLock(dir);
  const guardFile = path.join(dir, guard.GUARD_FILE);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(guardFile);
  db.exec("PRAGMA application_id=1414541874; CREATE TABLE marker (id TEXT PRIMARY KEY); INSERT INTO marker VALUES ('tech-persistence-journal-recovery-v2'); CREATE TABLE private_data (value TEXT); INSERT INTO private_data VALUES ('preserve');");
  db.close();
  const before = fs.readFileSync(guardFile);
  const lock = store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 5000 });
  lock.release();
  assert.deepEqual(fs.readFileSync(guardFile), before);
});

for (const suffix of ['-journal', '-wal', '-shm']) {
  test(`pre-existing ${suffix} guard sidecar is preserved`, { skip: !available }, (t) => {
    const { dir } = fixture(t);
    const { lockFile } = createDeadLock(dir);
    const sidecar = path.join(dir, `${guard.GUARD_FILE}${suffix}`);
    fs.writeFileSync(sidecar, 'user sidecar');
    assert.throws(() => store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 30 }),
      (error) => error.code === 'SELF_LEARNING_RECOVERY_UNAVAILABLE');
    assert.equal(fs.readFileSync(sidecar, 'utf8'), 'user sidecar');
    assert.equal(fs.existsSync(lockFile), true);
  });
}

test('a hard-linked guard path is not altered', { skip: !available }, (t) => {
  const { root, dir } = fixture(t);
  const { lockFile } = createDeadLock(dir);
  const victim = path.join(root, 'victim');
  fs.writeFileSync(victim, 'user file');
  fs.linkSync(victim, path.join(dir, guard.GUARD_FILE));
  assert.throws(() => store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 30 }),
    (error) => error.code === 'SELF_LEARNING_RECOVERY_UNAVAILABLE');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'user file');
  assert.equal(fs.existsSync(lockFile), true);
});

test('a hard-linked SQLite sidecar is not altered', { skip: !available }, (t) => {
  const { root, dir } = fixture(t);
  const { lockFile } = createDeadLock(dir);
  const victim = path.join(root, 'victim');
  fs.writeFileSync(victim, 'user sidecar');
  const sidecar = path.join(dir, `${guard.GUARD_FILE}-journal`);
  fs.linkSync(victim, sidecar);
  assert.throws(() => store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 30 }),
    (error) => error.code === 'SELF_LEARNING_RECOVERY_UNAVAILABLE');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'user sidecar');
  assert.equal(fs.readFileSync(sidecar, 'utf8'), 'user sidecar');
  assert.equal(fs.existsSync(lockFile), true);
});

test('a missing built-in SQLite module fails closed without modifying the lock', { skip: !available }, (t) => {
  const { dir } = fixture(t);
  const { lockFile } = createDeadLock(dir);
  const before = fs.readFileSync(lockFile);
  const Module = require('node:module');
  const load = Module._load;
  try {
    Module._load = function (request, ...args) {
      if (request === 'node:sqlite') { const error = new Error('unavailable'); error.code = 'ERR_UNKNOWN_BUILTIN_MODULE'; throw error; }
      return load.call(this, request, ...args);
    };
    assert.throws(() => store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 30 }),
      (error) => error.code === 'SELF_LEARNING_RECOVERY_UNAVAILABLE');
  } finally { Module._load = load; }
  assert.deepEqual(fs.readFileSync(lockFile), before);
});

test('guard file replacement during recovery fails closed and is retryable', { skip: !available }, (t) => {
  const { dir } = fixture(t);
  createDeadLock(dir);
  const child = run(dir, `
    const fs=require('fs'),s=require(process.argv[1]),path=require('path');
    const stat=fs.lstatSync,rename=fs.renameSync;let moved=false;
    fs.renameSync=(a,b)=>{const r=rename(a,b);if(String(b).includes('.journal-local-recovery-'))moved=true;return r};
    fs.lstatSync=(p,...args)=>{const x=stat(p,...args);if(moved&&String(p)===path.join(process.argv[2],'.journal-recovery-guard-v2.sqlite'))Object.defineProperty(x,'ino',{value:x.ino===0n?1n:0n});return x};
    try{s.acquireJournalLock(process.argv[2],{stale_lock_age_ms:0,retry_timeout_ms:100})}catch(e){process.stdout.write(String(e.code||e.message));process.exit(75)}
  `);
  assert.equal(child.status, 75, child.stderr);
  assert.equal(fs.existsSync(path.join(dir, store.LOCK_RECOVERY_CLAIM_FILE_NAME)), true);
  const lock = store.acquireJournalLock(dir, { stale_lock_age_ms: 0, retry_timeout_ms: 5000 });
  lock.release();
  assert.equal(store.readJournal(dir).revision, 0);
});

test('adjacent guard inode values above Number precision fail closed', { skip: !available }, (t) => {
  const { dir } = fixture(t);
  createDeadLock(dir);
  assert.equal(Number(9007199254740992n), Number(9007199254740993n));
  const child = run(dir, `
    const fs=require('fs'),s=require(process.argv[1]),path=require('path');
    const stat=fs.lstatSync,fstat=fs.fstatSync,open=fs.openSync,close=fs.closeSync,rename=fs.renameSync;
    const target=path.join(process.argv[2],'.journal-recovery-guard-v2.sqlite');let moved=false;const fds=new Set();
    const alter=x=>{Object.defineProperty(x,'ino',{value:moved?9007199254740993n:9007199254740992n});return x};
    fs.openSync=(p,...a)=>{const fd=open(p,...a);if(String(p)===target)fds.add(fd);return fd};
    fs.closeSync=fd=>{fds.delete(fd);return close(fd)};
    fs.lstatSync=(p,...a)=>{const x=stat(p,...a);return String(p)===target?alter(x):x};
    fs.fstatSync=(fd,...a)=>{const x=fstat(fd,...a);return fds.has(fd)?alter(x):x};
    fs.renameSync=(a,b)=>{const r=rename(a,b);if(String(b).includes('.journal-local-recovery-'))moved=true;return r};
    try{s.acquireJournalLock(process.argv[2],{stale_lock_age_ms:0,retry_timeout_ms:200})}catch(e){process.stdout.write(String(e.code||e.message));process.exit(76)}
  `);
  assert.equal(child.status, 76, child.stderr);
  assert.equal(fs.existsSync(path.join(dir, store.LOCK_RECOVERY_CLAIM_FILE_NAME)), true);
});

test('adjacent claimed LOCK inode values above Number precision fail closed', { skip: !available }, (t) => {
  const { dir } = fixture(t);
  const { lockFile } = createDeadLock(dir);
  const before = fs.readFileSync(lockFile);
  assert.equal(Number(9007199254740992n), Number(9007199254740993n));
  const child = run(dir, `
    const fs=require('fs'),s=require(process.argv[1]),path=require('path');
    const stat=fs.lstatSync,fstat=fs.fstatSync,open=fs.openSync,close=fs.closeSync,link=fs.linkSync;
    const target=path.join(process.argv[2],s.JOURNAL_DIR_NAME,s.LOCK_FILE_NAME);let claimed=false;const fds=new Set();
    const alter=x=>{Object.defineProperty(x,'ino',{value:claimed?9007199254740993n:9007199254740992n});return x};
    fs.openSync=(p,...a)=>{const fd=open(p,...a);if(String(p)===target)fds.add(fd);return fd};
    fs.closeSync=fd=>{fds.delete(fd);return close(fd)};
    fs.lstatSync=(p,...a)=>{const x=stat(p,...a);return String(p)===target?alter(x):x};
    fs.fstatSync=(fd,...a)=>{const x=fstat(fd,...a);return fds.has(fd)?alter(x):x};
    fs.linkSync=(a,b)=>{const r=link(a,b);if(String(b).endsWith(s.LOCK_RECOVERY_CLAIM_FILE_NAME))claimed=true;return r};
    try{s.acquireJournalLock(process.argv[2],{stale_lock_age_ms:0,retry_timeout_ms:200})}catch(e){process.stdout.write(String(e.code||e.message));process.exit(77)}
  `);
  assert.equal(child.status, 77, child.stderr);
  assert.deepEqual(fs.readFileSync(lockFile), before);
  assert.equal(fs.existsSync(path.join(dir, store.LOCK_RECOVERY_CLAIM_FILE_NAME)), true);
});

test('concurrent recovery contenders never overlap the journal critical section', { skip: !available }, async (t) => {
  const { dir } = fixture(t);
  createDeadLock(dir);
  const start = Date.now() + 500;
  const source = `
    const fs=require('fs'),path=require('path'),s=require(process.argv[1]);
    const dir=process.argv[2],start=Number(process.argv[3]);while(Date.now()<start){}
    try{const lock=s.acquireJournalLock(dir,{stale_lock_age_ms:0,retry_timeout_ms:10000});
      const inside=path.join(dir,'exclusive-critical-section');const fd=fs.openSync(inside,'wx');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,35);
      fs.closeSync(fd);fs.unlinkSync(inside);lock.release();process.exit(0);
    }catch(e){process.stderr.write(String(e.code||e.message));process.exit(2)}
  `;
  const attempts = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, require.resolve('./lib/self-learning-store'), dir, String(start)], {
      windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  }));
  const results = await Promise.all(attempts);
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0, 0], JSON.stringify(results));
  assert.equal(store.readJournal(dir).revision, 0);
});

test('a legacy writer cannot enter while a v2 recovery claim is held', { skip: !available }, async (t) => {
  const { root, dir } = fixture(t);
  createDeadLock(dir);
  const legacyRoot = path.join(root, 'legacy');
  fs.cpSync(path.join(__dirname, 'lib'), path.join(legacyRoot, 'lib'), { recursive: true });
  const old = spawnSync('git', ['show', 'HEAD:scripts/lib/self-learning-store.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true });
  assert.equal(old.status, 0, old.stderr);
  fs.writeFileSync(path.join(legacyRoot, 'lib', 'self-learning-store.js'), old.stdout);
  const source = `
    const fs=require('fs'),s=require(process.argv[1]);const link=fs.linkSync;
    fs.linkSync=(a,b)=>{const r=link(a,b);if(String(b).endsWith(s.LOCK_RECOVERY_CLAIM_FILE_NAME)){
      process.stdout.write('claim-ready\\n');const v=Buffer.alloc(1);fs.readSync(0,v,0,1,null)}return r};
    try{const x=s.acquireJournalLock(process.argv[2],{stale_lock_age_ms:0,retry_timeout_ms:5000});x.release();process.exit(0)}catch(e){process.stderr.write(String(e.code||e.message));process.exit(2)}
  `;
  const child = spawn(process.execPath, ['-e', source, require.resolve('./lib/self-learning-store'), dir], {
    windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('recovery claimant did not start')), 10000);
    child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('claim-ready')) { clearTimeout(timer); resolve(); } });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const legacy = spawnSync(process.execPath, ['-e', `
    const s=require(process.argv[1]);try{s.acquireJournalLock(process.argv[2],{retry_timeout_ms:100,stale_lock_age_ms:0});process.exit(3)}catch(e){process.stdout.write(String(e.code));process.exit(0)}
  `, path.join(legacyRoot, 'lib', 'self-learning-store.js'), dir], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  try {
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(legacy.stdout, 'SELF_LEARNING_LOCKED');
  } finally { child.stdin.end('x'); }
  assert.equal(await exited, 0, stderr);
  assert.equal(store.readJournal(dir).revision, 0);
});
