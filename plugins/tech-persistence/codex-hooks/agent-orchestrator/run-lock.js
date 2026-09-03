'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const controlStore = require('./control-store');

const LOCK_SCHEMA_VERSION = 'run-lock-v1';
const LOCK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNKNOWN_OWNER_STALE_MS = 5 * 60 * 1000;

function assertLockName(name) {
  if (!LOCK_NAME_PATTERN.test(String(name || ''))) {
    throw new Error(`invalid run lock name: ${name}`);
  }
}

function lockPathInControlDir(controlDir, name) {
  assertLockName(name);
  return path.join(path.resolve(controlDir), `.${name}.lock`);
}

function lockPath(runDir, name, options = {}) {
  return lockPathInControlDir(controlStore.controlRunDir(runDir, options), name);
}

function ownerPath(lockDir) {
  return path.join(lockDir, 'owner.json');
}

function readOwner(lockDir) {
  const file = ownerPath(lockDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function lockAgeMs(lockDir, nowMs) {
  try {
    return Math.max(0, nowMs - fs.statSync(lockDir).mtimeMs);
  } catch (_) {
    return 0;
  }
}

function canRecover(lockDir, owner, options) {
  const alive = options.isProcessAlive || isProcessAlive;
  if (owner && Number.isInteger(owner.pid)) return !alive(owner.pid);
  const staleAfterMs = Number.isFinite(options.unknownOwnerStaleMs)
    ? options.unknownOwnerStaleMs
    : UNKNOWN_OWNER_STALE_MS;
  return lockAgeMs(lockDir, options.nowMs || Date.now()) >= staleAfterMs;
}

function assertAuthority(runDir, candidate, options) {
  return controlStore.assertAuthoritativeControlPath(runDir, candidate, options);
}

function recoverLock(runDir, lockDir, options) {
  assertAuthority(runDir, lockDir, options);
  const recoveryPath = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  fs.renameSync(lockDir, recoveryPath);
  assertAuthority(runDir, recoveryPath, options);
  fs.rmSync(recoveryPath, { recursive: true, force: true });
}

function acquireRunLock(runDir, name, metadata = {}, options = {}) {
  assertLockName(name);
  let controlDir;
  try {
    controlDir = controlStore.ensureControlRunDir(runDir, options);
  } catch (error) {
    throw new Error(
      `failed to initialize external control store for ${name} lock: ${error.message}`
    );
  }
  const lockDir = lockPathInControlDir(controlDir, name);
  const token = crypto.randomBytes(16).toString('hex');
  let recovered = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      assertAuthority(runDir, controlDir, options);
      fs.mkdirSync(lockDir);
      assertAuthority(runDir, lockDir, options);
      const owner = {
        schemaVersion: LOCK_SCHEMA_VERSION,
        name,
        token,
        pid: Number.isInteger(metadata.pid) ? metadata.pid : process.pid,
        command: metadata.command ? String(metadata.command) : null,
        runId: metadata.runId ? String(metadata.runId) : null,
        acquiredAt: metadata.now || new Date().toISOString(),
      };
      fs.writeFileSync(ownerPath(lockDir), `${JSON.stringify(owner, null, 2)}\n`, {
        flag: 'wx',
      });

      let released = false;
      return {
        lockDir,
        owner,
        recovered,
        release() {
          if (released) return false;
          assertAuthority(runDir, lockDir, options);
          const current = readOwner(lockDir);
          if (!current) {
            throw new Error(`${name} lock owner metadata is missing during release`);
          }
          if (current.token !== token) {
            throw new Error(`${name} lock ownership changed before release`);
          }
          assertAuthority(runDir, lockDir, options);
          fs.rmSync(lockDir, { recursive: true, force: true });
          released = true;
          return true;
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assertAuthority(runDir, lockDir, options);
      const owner = readOwner(lockDir);
      if (!canRecover(lockDir, owner, options)) {
        const ownerSummary = owner && owner.pid ? ` by pid ${owner.pid}` : '';
        throw new Error(`${name} lock is active${ownerSummary}`);
      }
      recoverLock(runDir, lockDir, options);
      recovered = true;
    }
  }

  throw new Error(`failed to acquire ${name} lock after stale recovery`);
}

function withRunLock(runDir, name, metadata, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('run lock callback is required');
  const lock = acquireRunLock(runDir, name, metadata, options);
  try {
    return callback(lock);
  } finally {
    lock.release();
  }
}

module.exports = {
  LOCK_SCHEMA_VERSION,
  UNKNOWN_OWNER_STALE_MS,
  acquireRunLock,
  isProcessAlive,
  lockPath,
  readOwner,
  withRunLock,
};
