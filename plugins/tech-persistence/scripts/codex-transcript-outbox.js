#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_OUTBOX_DIR_NAME = 'transcript-outbox';
const DEFAULT_TRANSCRIPTS_DIR_NAME = 'sessions';
const FAILURE_DIAGNOSTIC = '[codex-transcript-outbox] E_TRANSCRIPT_OUTBOX\n';
const LEGACY_JOB_SCHEMA = 'codex-transcript-outbox/v1';
const JOB_SCHEMA = 'codex-transcript-outbox/v2';
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_JOB_BYTES = 16 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SESSION_ID_BYTES = 256;
const MAX_WATCH_SECONDS = 24 * 60 * 60;
const DEFAULT_RECONCILE_SECONDS = 15 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pathExists(fileSystem, target) {
  try {
    fileSystem.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function realpath(fileSystem, target) {
  if (fileSystem.realpathSync
      && typeof fileSystem.realpathSync.native === 'function') {
    return fileSystem.realpathSync.native(target);
  }
  return fileSystem.realpathSync(target);
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizedPathIdentity(target) {
  const normalized = path.normalize(target);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizedSessionId(value) {
  if (typeof value !== 'string'
      || value.trim() === ''
      || value !== value.trim()
      || Buffer.byteLength(value, 'utf8') > MAX_SESSION_ID_BYTES
      || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error('official SessionEnd session_id must be a bounded non-empty identifier');
  }
  return UUID_PATTERN.test(value) ? value.toLowerCase() : value;
}

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty absolute path`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function statNanoseconds(stat, field, millisecondField) {
  if (typeof stat[field] === 'bigint') return stat[field];
  const milliseconds = Number(stat[millisecondField]);
  if (!Number.isFinite(milliseconds)) return 0n;
  return BigInt(Math.trunc(milliseconds * 1e6));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && statNanoseconds(left, 'birthtimeNs', 'birthtimeMs')
      === statNanoseconds(right, 'birthtimeNs', 'birthtimeMs');
}

function assertPlainFile(stat, label) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a plain file, not a symbolic link`);
  }
}

function openReadOnlyNoFollow(fileSystem, target) {
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW)
    ? fs.constants.O_NOFOLLOW
    : 0;
  return fileSystem.openSync(target, fs.constants.O_RDONLY | noFollow);
}

/**
 * Bind the pathname to an opened file descriptor before emitting metadata.
 * The second lstat/realpath pair detects a pathname swapped after open; the
 * fd remains the authority for observed size, mtime, and file identity.
 */
function inspectTranscript(transcriptPath, transcriptsRoot, fileSystem = fs) {
  const requestedPath = assertAbsolutePath(transcriptPath, 'transcript_path');
  const requestedRoot = assertAbsolutePath(transcriptsRoot, 'transcripts root');
  if (!pathIsInside(requestedRoot, requestedPath) || requestedRoot === requestedPath) {
    throw new Error('transcript_path must be below the configured transcripts root');
  }

  const rootStat = fileSystem.statSync(requestedRoot, { bigint: true });
  if (!rootStat.isDirectory()) {
    throw new Error('configured transcripts root must be a directory');
  }
  const realRoot = realpath(fileSystem, requestedRoot);
  const before = fileSystem.lstatSync(requestedPath, { bigint: true });
  assertPlainFile(before, 'transcript_path');
  const realBefore = realpath(fileSystem, requestedPath);
  if (!pathIsInside(realRoot, realBefore) || realRoot === realBefore) {
    throw new Error('transcript_path resolves outside the configured transcripts root');
  }

  let descriptor;
  try {
    descriptor = openReadOnlyNoFollow(fileSystem, requestedPath);
    const opened = fileSystem.fstatSync(descriptor, { bigint: true });
    assertPlainFile(opened, 'opened transcript');

    const after = fileSystem.lstatSync(requestedPath, { bigint: true });
    assertPlainFile(after, 'transcript_path');
    const realAfter = realpath(fileSystem, requestedPath);
    const snapshot = fileSystem.fstatSync(descriptor, { bigint: true });
    assertPlainFile(snapshot, 'opened transcript');
    const pathSnapshot = fileSystem.lstatSync(requestedPath, { bigint: true });
    assertPlainFile(pathSnapshot, 'transcript_path');
    const realPathSnapshot = realpath(fileSystem, requestedPath);

    if (normalizedPathIdentity(realAfter) !== normalizedPathIdentity(realBefore)
        || normalizedPathIdentity(realPathSnapshot) !== normalizedPathIdentity(realAfter)
        || !pathIsInside(realRoot, realAfter)
        || !pathIsInside(realRoot, realPathSnapshot)
        || !sameFileIdentity(before, opened)
        || !sameFileIdentity(after, opened)
        || !sameFileIdentity(opened, snapshot)
        || !sameFileIdentity(pathSnapshot, snapshot)) {
      throw new Error('transcript_path was replaced while its identity was being verified');
    }

    if (snapshot.size < 0n || snapshot.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('transcript observed size is outside the safe integer range');
    }
    const observedSize = Number(snapshot.size);
    const mtimeNanoseconds = statNanoseconds(snapshot, 'mtimeNs', 'mtimeMs');
    const mtimeMilliseconds = Number(mtimeNanoseconds / 1000000n);
    if (!Number.isFinite(mtimeMilliseconds)) {
      throw new Error('transcript mtime is invalid');
    }

    const canonicalPath = realAfter;
    const pathHash = sha256(normalizedPathIdentity(canonicalPath));
    const identityProjection = {
      path_hash: pathHash,
      dev: String(snapshot.dev),
      ino: String(snapshot.ino),
      birthtime_ns: String(statNanoseconds(snapshot, 'birthtimeNs', 'birthtimeMs')),
    };
    return {
      transcriptPath: canonicalPath,
      pathHash,
      fileIdentityHash: sha256(JSON.stringify(identityProjection)),
      observedSize,
      mtime: new Date(mtimeMilliseconds).toISOString(),
    };
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function resolveCodexHome(options) {
  const env = options.env || process.env;
  const configured = options.codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return assertAbsolutePath(configured, 'CODEX_HOME');
}

function resolveTranscriptsRoot(codexHome, options) {
  const env = options.env || process.env;
  const configured = options.transcriptsRoot
    || env.CODEX_TRANSCRIPTS_ROOT
    || path.join(codexHome, DEFAULT_TRANSCRIPTS_DIR_NAME);
  return assertAbsolutePath(configured, 'CODEX_TRANSCRIPTS_ROOT');
}

function canonicalTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function assertCanonicalUtcTimestamp(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  const canonical = canonicalTimestamp(value, label);
  if (value !== canonical) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return canonical;
}

function jobAddressProjection(job) {
  const projection = {
    schema: job.schema,
    runtime: job.runtime,
    root_session_id: job.root_session_id,
    transcript_path: job.transcript_path,
    path_hash: job.path_hash,
    file_identity_hash: job.file_identity_hash,
    observed_size: job.observed_size,
    mtime: job.mtime,
  };
  if (job.schema === LEGACY_JOB_SCHEMA) {
    projection.queued_prefix_sha256 = job.queued_prefix_sha256;
  }
  return projection;
}

function jobAddress(job) {
  return sha256(JSON.stringify(jobAddressProjection(job)));
}

function fsyncDirectory(directory, fileSystem, platform) {
  if (platform === 'win32') return;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(directory, 'r');
    fileSystem.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function ensureOutboxDirectory(codexHome, fileSystem, platform = process.platform) {
  const outboxDir = path.join(codexHome, DEFAULT_OUTBOX_DIR_NAME);
  fileSystem.mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
  const stat = fileSystem.lstatSync(outboxDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('transcript outbox must be a plain directory');
  }
  const realCodexHome = realpath(fileSystem, codexHome);
  const realOutboxDir = realpath(fileSystem, outboxDir);
  if (!pathIsInside(realCodexHome, realOutboxDir) || realCodexHome === realOutboxDir) {
    throw new Error('transcript outbox resolves outside CODEX_HOME');
  }
  // This is intentionally unconditional on POSIX: another SessionEnd may have
  // created the directory but not yet made its parent entry durable.
  fsyncDirectory(codexHome, fileSystem, platform);
  return outboxDir;
}

function assertExistingJob(file, expectedJob, expectedAddress, fileSystem) {
  const stat = fileSystem.lstatSync(file);
  assertPlainFile(stat, 'existing transcript outbox job');
  if (stat.size > MAX_JOB_BYTES) {
    throw new Error('existing transcript outbox job exceeds the maximum size');
  }
  const existing = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
  let queuedAtIsCanonical = false;
  try {
    queuedAtIsCanonical = canonicalTimestamp(existing && existing.queued_at, 'queued_at')
      === existing.queued_at;
  } catch {
    queuedAtIsCanonical = false;
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)
      || JSON.stringify(Object.keys(existing)) !== JSON.stringify(Object.keys(expectedJob))
      || !queuedAtIsCanonical
      || jobAddress(existing) !== expectedAddress
      || JSON.stringify(jobAddressProjection(existing))
        !== JSON.stringify(jobAddressProjection(expectedJob))) {
    throw new Error('existing transcript outbox job does not match its content address');
  }
}

function writeJobCreateOnce(outboxDir, job, fileSystem = fs, platform = process.platform) {
  const address = jobAddress(job);
  const finalPath = path.join(outboxDir, `${address}.json`);
  if (pathExists(fileSystem, finalPath)) {
    assertExistingJob(finalPath, job, address, fileSystem);
    fsyncDirectory(outboxDir, fileSystem, platform);
    return { status: 'duplicate', file: finalPath, address };
  }

  const temporaryPath = path.join(
    outboxDir,
    `.${address}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    fileSystem.fchmodSync(descriptor, 0o600);
    fileSystem.writeFileSync(descriptor, `${JSON.stringify(job)}\n`, 'utf8');
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    try {
      fileSystem.linkSync(temporaryPath, finalPath);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      assertExistingJob(finalPath, job, address, fileSystem);
      fileSystem.unlinkSync(temporaryPath);
      fsyncDirectory(outboxDir, fileSystem, platform);
      return { status: 'duplicate', file: finalPath, address };
    }
    fileSystem.unlinkSync(temporaryPath);
    fsyncDirectory(outboxDir, fileSystem, platform);
    return { status: 'queued', file: finalPath, address };
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    try {
      fileSystem.unlinkSync(temporaryPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function defaultTranscriptSyncConfigPath(env = process.env) {
  return env.TECH_PERSISTENCE_CONFIG
    || path.join(os.homedir(), '.tech-persistence', 'config.json');
}

function readPlainJsonFile(file, label, fileSystem) {
  const resolved = assertAbsolutePath(file, label);
  const stat = fileSystem.lstatSync(resolved);
  assertPlainFile(stat, label);
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`${label} exceeds the maximum size`);
  const parsed = JSON.parse(fileSystem.readFileSync(resolved, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain an object`);
  }
  return parsed;
}

function resolvePlainFile(file, label, fileSystem) {
  const resolved = assertAbsolutePath(file, label);
  const stat = fileSystem.lstatSync(resolved);
  assertPlainFile(stat, label);
  return realpath(fileSystem, resolved);
}

/**
 * Start the long-lived consumer only after the durable job exists. Any failure
 * is collapsed to a fixed status so hook output can never disclose local paths,
 * credentials, or exception messages. The outbox job remains the retry source.
 */
function startTranscriptSyncWorker(options = {}) {
  try {
    const fileSystem = options.fileSystem || fs;
    const configPath = options.configPath || defaultTranscriptSyncConfigPath(options.env || process.env);
    const config = readPlainJsonFile(configPath, 'transcript sync config', fileSystem);
    const sync = config.transcriptSync;
    if (!sync || typeof sync !== 'object' || Array.isArray(sync)) {
      throw new Error('transcriptSync config is required');
    }
    if (sync.enabled === false) return { status: 'disabled' };
    if (sync.enabled !== true) throw new Error('transcriptSync.enabled must be true or false');
    if (!Number.isSafeInteger(sync.watchSeconds)
        || sync.watchSeconds < 1
        || sync.watchSeconds > MAX_WATCH_SECONDS) {
      throw new Error('transcriptSync.watchSeconds is outside the supported range');
    }
    const reconcileSeconds = sync.reconcileSeconds === undefined
      ? DEFAULT_RECONCILE_SECONDS
      : sync.reconcileSeconds;
    if (!Number.isSafeInteger(reconcileSeconds)
        || reconcileSeconds < 1
        || reconcileSeconds > MAX_WATCH_SECONDS) {
      throw new Error('transcriptSync.reconcileSeconds is outside the supported range');
    }
    const reconcileAfter = assertCanonicalUtcTimestamp(
      sync.reconcileAfter,
      'transcriptSync.reconcileAfter'
    );

    const runtimeRoot = assertAbsolutePath(sync.runtimeRoot, 'transcriptSync.runtimeRoot');
    const runtimeStat = fileSystem.lstatSync(runtimeRoot);
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
      throw new Error('transcriptSync.runtimeRoot must be a plain directory');
    }
    const realRuntimeRoot = realpath(fileSystem, runtimeRoot);
    const worker = resolvePlainFile(
      path.join(runtimeRoot, 'scripts', 'sync-codex-transcripts.js'),
      'transcript sync worker',
      fileSystem
    );
    if (!pathIsInside(realRuntimeRoot, worker) || worker === realRuntimeRoot) {
      throw new Error('transcript sync worker resolves outside runtimeRoot');
    }
    const envFile = resolvePlainFile(sync.envFile, 'transcript sync env file', fileSystem);
    const spawn = options.spawn || childProcess.spawn;
    const child = spawn(options.processExecPath || process.execPath, [
      worker,
      '--watch-seconds',
      String(sync.watchSeconds),
      '--reconcile-seconds',
      String(reconcileSeconds),
      '--reconcile-after',
      reconcileAfter,
      '--env-file',
      envFile,
    ], {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (!child
        || !Number.isSafeInteger(child.pid)
        || child.pid < 1
        || typeof child.unref !== 'function') {
      throw new Error('transcript sync worker did not return a child process');
    }
    if (typeof child.once === 'function') {
      // A detached worker may report launch errors asynchronously. Keep those
      // errors private; the durable job will be retried by the next SessionEnd.
      child.once('error', () => {});
    }
    child.unref();
    return { status: 'started' };
  } catch {
    return { status: 'failed' };
  }
}

function launchTranscriptSyncWorker(options) {
  try {
    const launch = options.workerLauncher || startTranscriptSyncWorker;
    return launch(options);
  } catch {
    return { status: 'failed' };
  }
}

function enqueueTranscript(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('official SessionEnd payload must be an object');
  }
  const rootSessionId = normalizedSessionId(payload.session_id);
  if (payload.transcript_path === null) {
    return {
      status: 'reconcile-only',
      worker: launchTranscriptSyncWorker(options),
    };
  }
  const transcriptPath = assertAbsolutePath(payload.transcript_path, 'transcript_path');
  const fileSystem = options.fileSystem || fs;
  const codexHome = resolveCodexHome(options);
  const transcriptsRoot = resolveTranscriptsRoot(codexHome, options);
  const observation = inspectTranscript(transcriptPath, transcriptsRoot, fileSystem);
  const job = {
    schema: JOB_SCHEMA,
    runtime: 'codex',
    root_session_id: rootSessionId,
    transcript_path: observation.transcriptPath,
    path_hash: observation.pathHash,
    file_identity_hash: observation.fileIdentityHash,
    observed_size: observation.observedSize,
    mtime: observation.mtime,
    queued_at: canonicalTimestamp(options.queuedAt || new Date(), 'queued_at'),
  };
  const platform = options.platform || process.platform;
  const outboxDir = ensureOutboxDirectory(codexHome, fileSystem, platform);
  const result = writeJobCreateOnce(outboxDir, job, fileSystem, platform);
  const worker = launchTranscriptSyncWorker(options);
  return { ...result, worker };
}

function readStdinBounded(maxBytes = MAX_INPUT_BYTES) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(4096);
  let total = 0;
  while (true) {
    const bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new Error('SessionEnd payload exceeds the input limit');
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function main() {
  try {
    const input = readStdinBounded();
    if (input.trim() === '') throw new Error('SessionEnd payload is empty');
    const result = enqueueTranscript(JSON.parse(input));
    if (!result.worker || result.worker.status === 'failed') {
      process.stderr.write(FAILURE_DIAGNOSTIC);
    }
  } catch {
    // Fail open without reflecting exception messages, payload fields, or paths.
    process.stderr.write(FAILURE_DIAGNOSTIC);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_OUTBOX_DIR_NAME,
  DEFAULT_TRANSCRIPTS_DIR_NAME,
  FAILURE_DIAGNOSTIC,
  JOB_SCHEMA,
  LEGACY_JOB_SCHEMA,
  MAX_INPUT_BYTES,
  enqueueTranscript,
  inspectTranscript,
  jobAddress,
  main,
  startTranscriptSyncWorker,
  writeJobCreateOnce,
};
