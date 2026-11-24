'use strict';

// This guard is only appropriate when the operator has asserted that the
// whole configured root is private to this device. Filesystem type alone
// cannot prove that a local directory is not replicated to another machine.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const GUARD_FILE = '.journal-recovery-guard-v2.sqlite';
const STAGING_PREFIX = '.journal-recovery-guard-init-';
const APPLICATION_ID = 1414541874;
const MARKER = 'tech-persistence-journal-recovery-v2';
const volumeCache = new Map();

function supportsNodeSqlite(version = process.versions.node, load = sqliteModule) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(String(version));
  if (!match || !(Number(match[1]) > 22
      || (Number(match[1]) === 22 && Number(match[2]) >= 5))) return false;
  // Some versions require --experimental-sqlite and newer versions permit
  // --no-experimental-sqlite. Version alone cannot establish capability.
  try { return typeof load().DatabaseSync === 'function'; } catch (_) { return false; }
}

function isEnabledForStore(storeDir, env = process.env) {
  const declared = env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT;
  if (process.platform !== 'win32' || !supportsNodeSqlite()
      || typeof declared !== 'string' || !path.isAbsolute(declared)) return false;
  const root = path.resolve(declared);
  const store = path.resolve(storeDir);
  const relative = path.relative(root.toLowerCase(), store.toLowerCase());
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const volume = path.parse(root).root;
  if (!/^[A-Za-z]:\\$/.test(volume) || path.parse(store).root.toLowerCase() !== volume.toLowerCase()) return false;
  if (volumeCache.has(volume.toUpperCase())) return volumeCache.get(volume.toUpperCase());
  const drive = `${volume[0]}:`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[int]([System.IO.DriveInfo]::new('${drive}')).DriveType`],
  { encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
  const supported = !result.error && result.status === 0 && String(result.stdout).trim() === '3';
  volumeCache.set(volume.toUpperCase(), supported);
  return supported;
}

function sqliteModule() {
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    if (String(warning) === 'SQLite is an experimental feature and might change at any time') return;
    return original.call(this, warning, ...args);
  };
  try { return require('node:sqlite'); } finally { process.emitWarning = original; }
}

function sameIdentity(a, b) {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
    && String(a.birthtimeNs) === String(b.birthtimeNs);
}

function assertDirectory(directory, expected) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, expected)
      || fs.realpathSync(directory) !== expected.realpath) throw new Error('recovery guard directory changed');
}

function assertPrivateFile(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('recovery guard file is not private');
  return stat;
}

function assertNoSidecars(target) {
  // This guard never modifies the database once published. Reject ambiguous
  // sidecars before SQLite can perform automatic recovery on foreign bytes.
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { fs.lstatSync(`${target}${suffix}`); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('recovery guard has an unexpected SQLite sidecar');
  }
}

function prepareDatabase(storeDir, DatabaseSync) {
  const target = path.join(storeDir, GUARD_FILE);
  if (!fs.existsSync(target)) {
    const temporary = path.join(storeDir, `${STAGING_PREFIX}${crypto.randomBytes(16).toString('hex')}.tmp`);
    let db;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      fs.closeSync(fd);
      db = new DatabaseSync(path.toNamespacedPath(temporary));
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA application_id=${APPLICATION_ID}; CREATE TABLE marker (id TEXT PRIMARY KEY); INSERT INTO marker VALUES ('${MARKER}');`);
      db.close(); db = undefined;
      const sync = fs.openSync(temporary, 'r+');
      try { fs.fsyncSync(sync); } finally { fs.closeSync(sync); }
      try { fs.linkSync(temporary, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      if (db) try { db.close(); } catch (_) {}
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  let identity = fs.lstatSync(target, { bigint: true });
  if (!identity.isFile() || identity.isSymbolicLink()) throw new Error('invalid recovery guard');
  if (identity.nlink > 1n) {
    for (const name of fs.readdirSync(storeDir)) {
      if (!/^\.journal-recovery-guard-init-[a-f0-9]{32}\.tmp$/.test(name)) continue;
      const stage = path.join(storeDir, name);
      const stat = fs.lstatSync(stage, { bigint: true });
      if (stat.isFile() && !stat.isSymbolicLink() && sameIdentity(stat, identity)) fs.unlinkSync(stage);
    }
    identity = fs.lstatSync(target, { bigint: true });
  }
  identity = assertPrivateFile(target);
  const fd = fs.openSync(target, 'r');
  try {
    const header = Buffer.alloc(72);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length
        || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\u0000'
        || header.readUInt32BE(68) !== APPLICATION_ID) throw new Error('invalid recovery guard database');
    if (!sameIdentity(identity, fs.fstatSync(fd, { bigint: true }))) throw new Error('recovery guard file changed');
  } finally { fs.closeSync(fd); }
  return { target, identity };
}

function acquireGuard(storeDir, timeoutMs) {
  const { DatabaseSync } = sqliteModule();
  const directory = fs.lstatSync(storeDir, { bigint: true });
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('invalid recovery guard directory');
  const dirIdentity = { dev: String(directory.dev), ino: String(directory.ino), birthtimeNs: String(directory.birthtimeNs), realpath: fs.realpathSync(storeDir) };
  const target = path.join(storeDir, GUARD_FILE);
  assertNoSidecars(target);
  const prepared = prepareDatabase(storeDir, DatabaseSync);
  assertDirectory(storeDir, dirIdentity);
  assertNoSidecars(target);
  let db;
  try {
    db = new DatabaseSync(path.toNamespacedPath(target));
    const rows = db.prepare('SELECT id FROM marker').all();
    if (rows.length !== 1 || rows[0].id !== MARKER) throw new Error('invalid recovery guard marker');
    db.exec(`PRAGMA busy_timeout=${timeoutMs}; BEGIN IMMEDIATE;`);
    assertDirectory(storeDir, dirIdentity);
    assertNoSidecars(target);
    const after = assertPrivateFile(target);
    if (!sameIdentity(prepared.identity, after)) throw new Error('recovery guard identity changed');
    let released = false;
    return {
      identity: { dev: String(after.dev), ino: String(after.ino), birthtimeNs: String(after.birthtimeNs) },
      verify() {
        if (released) throw new Error('recovery guard is no longer held');
        assertDirectory(storeDir, dirIdentity);
        assertNoSidecars(target);
        if (!sameIdentity(prepared.identity, assertPrivateFile(target))) throw new Error('recovery guard identity changed');
      },
      release() {
        if (released) return;
        released = true;
        try { db.exec('ROLLBACK'); } finally { db.close(); }
      },
    };
  } catch (error) {
    if (db) try { db.close(); } catch (_) {}
    if (error && error.errcode === 5) error.code = 'SELF_LEARNING_LOCKED';
    throw error;
  }
}

module.exports = { GUARD_FILE, supportsNodeSqlite, isEnabledForStore, acquireGuard };
