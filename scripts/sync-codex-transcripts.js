#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { streamTranscriptSnapshot } = require('./lib/codex-transcript-projection');
const { redactSensitiveText } = require('./lib/redaction');
const {
  openTranscriptPostgres,
  syncTranscriptFile,
} = require('./lib/codex-transcript-postgres');
const { jobAddress } = require('./codex-transcript-outbox');

const OUTBOX_SCHEMA_VERSION = 'codex-transcript-outbox/v1';
const OUTBOX_SCHEMA_VERSION_V2 = 'codex-transcript-outbox/v2';
const SUPPORTED_OUTBOX_SCHEMAS = new Set([OUTBOX_SCHEMA_VERSION, OUTBOX_SCHEMA_VERSION_V2]);
const MAX_JOB_BYTES = 64 * 1024;
const MAX_SOURCE_FILES = 100_000;
const DEFAULT_RECONCILE_SECONDS = 15 * 60;
const MAX_RETRY_SECONDS = 5 * 60;
const WATCH_LEASE_DIRECTORY = '.sync-worker-lease';
const WATCH_LEASE_OWNER_FILE = 'owner.json';
const WATCH_LEASE_INITIALIZATION_MILLISECONDS = 30 * 1000;
const WATCH_LEASE_HEARTBEAT_MILLISECONDS = 30 * 1000;
const WATCH_LEASE_STALE_MILLISECONDS = 5 * 60 * 1000;
const MAX_SESSION_ID_BYTES = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SYNC_FAILURE_CODE = 'E_TRANSCRIPT_SYNC_FAILED';
const FATAL_FAILURE_CODE = 'E_TRANSCRIPT_SYNC_FATAL';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseCanonicalUtcTimestamp(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} requires a canonical UTC timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    mode: 'outbox',
    files: [],
    sessionsRoot: null,
    outbox: null,
    envFile: null,
    dryRun: false,
    json: false,
    keepJobs: false,
    watchSeconds: null,
    reconcileSeconds: DEFAULT_RECONCILE_SECONDS,
    reconcileAfter: null,
    help: false,
  };
  let explicitMode = null;
  const chooseMode = (mode) => {
    if (explicitMode && explicitMode !== mode) {
      throw new Error('Choose only one transcript source mode: --all, --file, or --outbox');
    }
    explicitMode = mode;
    args.mode = mode;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      chooseMode('all');
    } else if (arg === '--file') {
      if (!argv[index + 1]) throw new Error('--file requires a path');
      chooseMode('files');
      args.files.push(argv[++index]);
    } else if (arg === '--outbox') {
      chooseMode('outbox');
      if (argv[index + 1] && !argv[index + 1].startsWith('--')) args.outbox = argv[++index];
    } else if (arg === '--sessions-root') {
      if (!argv[index + 1]) throw new Error('--sessions-root requires a path');
      args.sessionsRoot = argv[++index];
    } else if (arg === '--env-file') {
      if (!argv[index + 1]) throw new Error('--env-file requires a path');
      args.envFile = argv[++index];
    } else if (arg === '--watch-seconds') {
      if (!argv[index + 1]) throw new Error('--watch-seconds requires a value');
      args.watchSeconds = parsePositiveInteger(argv[++index], '--watch-seconds');
    } else if (arg === '--watch') {
      args.watchSeconds = 15;
    } else if (arg === '--reconcile-seconds') {
      if (!argv[index + 1]) throw new Error('--reconcile-seconds requires a value');
      args.reconcileSeconds = parsePositiveInteger(argv[++index], '--reconcile-seconds');
    } else if (arg === '--reconcile-after') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new Error('--reconcile-after requires a value');
      }
      args.reconcileAfter = parseCanonicalUtcTimestamp(
        argv[++index],
        '--reconcile-after'
      );
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--keep-jobs') {
      args.keepJobs = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function unquoteEnvValue(value) {
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
    return value.slice(1, -1);
  }
  return value;
}

const TRANSCRIPT_POSTGRES_ENV_KEYS = Object.freeze([
  'TRANSCRIPTS_POSTGRES_URL',
  'TRANSCRIPTS_POSTGRES_READ_URL',
  'TRANSCRIPTS_POSTGRES_WRITE_URL',
  'TRANSCRIPTS_POSTGRES_SSL',
]);

function loadEnvFile(filePath, target = process.env) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('transcript env file must be a plain file');
  const raw = fs.readFileSync(resolved, 'utf8');
  const entries = [];
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`transcript env file has invalid syntax at line ${index + 1}`);
    entries.push([match[1], unquoteEnvValue(match[2].trim())]);
  }
  // An explicitly configured private env file is the authority for the
  // transcript sink. Inherited Codex variables must not redirect transcripts.
  for (const key of TRANSCRIPT_POSTGRES_ENV_KEYS) delete target[key];
  for (const [key, value] of entries) {
    if (TRANSCRIPT_POSTGRES_ENV_KEYS.includes(key) || target[key] === undefined) {
      target[key] = value;
    }
  }
  return target;
}

function defaultCodexHome(env) {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

function resolveRuntimePaths(args, env) {
  const codexHome = defaultCodexHome(env);
  return {
    sessionsRoot: path.resolve(args.sessionsRoot || env.CODEX_TRANSCRIPTS_ROOT || path.join(codexHome, 'sessions')),
    outbox: path.resolve(args.outbox || env.CODEX_TRANSCRIPT_OUTBOX_DIR || path.join(codexHome, 'transcript-outbox')),
  };
}

function validateJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)
      || !SUPPORTED_OUTBOX_SCHEMAS.has(job.schema) || job.runtime !== 'codex') {
    throw new Error('outbox job has an unsupported schema');
  }
  if (typeof job.root_session_id !== 'string'
      || job.root_session_id.trim() === ''
      || job.root_session_id !== job.root_session_id.trim()
      || Buffer.byteLength(job.root_session_id, 'utf8') > MAX_SESSION_ID_BYTES
      || CONTROL_CHARACTER_PATTERN.test(job.root_session_id)) {
    throw new Error('outbox job root_session_id is invalid');
  }
  if (typeof job.transcript_path !== 'string' || !path.isAbsolute(job.transcript_path)) {
    throw new Error('outbox job transcript_path is invalid');
  }
  for (const field of ['path_hash', 'file_identity_hash']) {
    if (!HASH_PATTERN.test(job[field] || '')) throw new Error(`outbox job ${field} is invalid`);
  }
  if (job.schema === OUTBOX_SCHEMA_VERSION
      && !HASH_PATTERN.test(job.queued_prefix_sha256 || '')) {
    throw new Error('outbox job queued_prefix_sha256 is invalid');
  }
  if (job.schema === OUTBOX_SCHEMA_VERSION_V2 && job.queued_prefix_sha256 !== undefined) {
    throw new Error('outbox job v2 must not contain queued_prefix_sha256');
  }
  const observedSize = Number(job.observed_size);
  if (!Number.isSafeInteger(observedSize) || observedSize < 0) {
    throw new Error('outbox job observed_size is invalid');
  }
  if (typeof job.mtime !== 'string' || !Number.isFinite(Date.parse(job.mtime))) {
    throw new Error('outbox job mtime is invalid');
  }
  if (typeof job.queued_at !== 'string' || !Number.isFinite(Date.parse(job.queued_at))) {
    throw new Error('outbox job queued_at is invalid');
  }
  return job;
}

function fileIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    birthtimeMs: String(stat.birthtimeMs),
  };
}

function sameIdentity(left, stat) {
  return left.device === String(stat.dev)
    && left.inode === String(stat.ino)
    && left.birthtimeMs === String(stat.birthtimeMs);
}

function statNanoseconds(stat, field, millisecondField) {
  if (typeof stat[field] === 'bigint') return stat[field];
  const milliseconds = Number(stat[millisecondField]);
  if (!Number.isFinite(milliseconds)) return 0n;
  return BigInt(Math.trunc(milliseconds * 1e6));
}

function sameSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && statNanoseconds(left, 'mtimeNs', 'mtimeMs') === statNanoseconds(right, 'mtimeNs', 'mtimeMs')
    && statNanoseconds(left, 'ctimeNs', 'ctimeMs') === statNanoseconds(right, 'ctimeNs', 'ctimeMs');
}

function hashQueuedPrefix(file, observedSize) {
  const beforePath = fs.lstatSync(file, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error('queued transcript must be a plain file');
  }
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < BigInt(observedSize)) {
      throw new Error('queued transcript no longer covers its observed size');
    }
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < observedSize) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, observedSize - offset),
        offset
      );
      if (bytesRead === 0) throw new Error('queued transcript prefix ended unexpectedly');
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(file, { bigint: true });
    if (!sameSnapshot(before, after)
        || afterPath.dev !== after.dev
        || afterPath.ino !== after.ino) {
      throw new Error('queued transcript changed while its prefix was verified');
    }
    return digest.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertQueuedPrefix(source) {
  if (!source.outboxEntry) return;
  const job = source.outboxEntry.job;
  if (job.schema === OUTBOX_SCHEMA_VERSION_V2) return;
  if (hashQueuedPrefix(source.file, job.observed_size) !== job.queued_prefix_sha256) {
    throw new Error('queued transcript prefix does not match the outbox snapshot');
  }
}

function queuedSnapshotCovered(source, result) {
  if (!source.outboxEntry) return true;
  const job = source.outboxEntry.job;
  const queuedMtimeMs = Date.parse(job.mtime);
  return result.verified === true
    && Number(result.trailingBytes) === 0
    && Number.isSafeInteger(Number(result.nextByteOffset))
    && Number(result.nextByteOffset) >= job.observed_size
    && Number.isSafeInteger(Number(result.observedSize))
    && Number(result.observedSize) >= job.observed_size
    && Number.isFinite(Number(result.sourceMtimeMs))
    && Number(result.sourceMtimeMs) >= queuedMtimeMs;
}

function readOutboxJobs(outbox) {
  if (!fs.existsSync(outbox)) return [];
  const rootStat = fs.lstatSync(outbox);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Codex transcript outbox must be a plain directory');
  }
  const jobs = [];
  for (const entry of fs.readdirSync(outbox, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const file = path.join(outbox, entry.name);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('outbox job must be a plain file');
    if (before.size > MAX_JOB_BYTES) throw new Error('outbox job exceeds the size limit');
    let job;
    try {
      job = validateJob(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      throw new Error(`outbox job is invalid: ${redactSensitiveText(error.message)}`);
    }
    if (entry.name !== `${jobAddress(job)}.json`) {
      throw new Error('outbox job filename does not match its content address');
    }
    const after = fs.lstatSync(file);
    if (!sameIdentity(fileIdentity(before), after)) throw new Error('outbox job identity changed while reading');
    jobs.push({ file, job, identity: fileIdentity(after) });
    if (jobs.length > MAX_SOURCE_FILES) throw new Error('outbox contains too many jobs');
  }
  return jobs.sort((left, right) =>
    left.job.queued_at.localeCompare(right.job.queued_at) || left.file.localeCompare(right.file));
}

function acknowledgeJob(entry) {
  const current = fs.lstatSync(entry.file);
  if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(entry.identity, current)) {
    throw new Error('outbox job identity changed before acknowledgement');
  }
  fs.unlinkSync(entry.file);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH');
  }
}

function readWatchLeaseOwner(ownerFile, fileSystem) {
  try {
    const stat = fileSystem.lstatSync(ownerFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOB_BYTES) return null;
    const owner = JSON.parse(fileSystem.readFileSync(ownerFile, 'utf8'));
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
        || !Number.isSafeInteger(owner.pid) || owner.pid < 1
        || typeof owner.hostname !== 'string' || owner.hostname.length < 1
        || !/^[a-f0-9]{32,128}$/.test(owner.token || '')
        || typeof owner.acquired_at !== 'string'
        || !Number.isFinite(Date.parse(owner.acquired_at))) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

function removeRenamedLease(directory, fileSystem) {
  const ownerFile = path.join(directory, WATCH_LEASE_OWNER_FILE);
  try {
    fileSystem.unlinkSync(ownerFile);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  try {
    fileSystem.rmdirSync(directory);
  } catch (error) {
    // A damaged stale lease must not regain ownership. Its renamed evidence is
    // intentionally retained if it contains anything except owner.json.
    if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY')) throw error;
  }
}

function acquireWatchLease(outbox, options = {}) {
  const fileSystem = options.fileSystem || fs;
  fileSystem.mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const rootStat = fileSystem.lstatSync(outbox);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Codex transcript outbox must be a plain directory');
  }
  const directory = path.join(outbox, WATCH_LEASE_DIRECTORY);
  const hostname = options.hostname || os.hostname();
  const pid = options.pid || process.pid;
  const isAlive = options.isProcessAlive || processIsAlive;
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const now = options.now || (() => new Date());

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fileSystem.mkdirSync(directory, { mode: 0o700 });
      const owner = {
        pid,
        hostname,
        token,
        acquired_at: now().toISOString(),
      };
      fileSystem.writeFileSync(
        path.join(directory, WATCH_LEASE_OWNER_FILE),
        `${JSON.stringify(owner)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      );
      return { acquired: true, directory, owner, fileSystem };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }

    const ownerFile = path.join(directory, WATCH_LEASE_OWNER_FILE);
    let leaseStat;
    try {
      leaseStat = fileSystem.lstatSync(directory);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!leaseStat.isDirectory() || leaseStat.isSymbolicLink()) {
      throw new Error('transcript sync worker lease must be a plain directory');
    }
    const owner = readWatchLeaseOwner(ownerFile, fileSystem);
    let ownerStat = null;
    try {
      ownerStat = fileSystem.lstatSync(ownerFile);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    const currentTime = now();
    const currentTimeMs = currentTime instanceof Date
      ? currentTime.getTime()
      : Number(currentTime);
    const heartbeatAge = ownerStat ? currentTimeMs - Number(ownerStat.mtimeMs) : Infinity;
    const heartbeatFresh = Number.isFinite(heartbeatAge)
      && heartbeatAge <= WATCH_LEASE_STALE_MILLISECONDS;
    if (owner && owner.hostname === hostname && isAlive(owner.pid) && heartbeatFresh) {
      return { acquired: false, directory, owner, fileSystem };
    }
    if (owner && owner.hostname !== hostname && heartbeatFresh) {
      // A local outbox is not expected to be shared across hosts. When it is,
      // preserve a fresh foreign heartbeat but recover an abandoned one.
      return { acquired: false, directory, owner, fileSystem };
    }
    if (!owner && currentTimeMs - leaseStat.mtimeMs < WATCH_LEASE_INITIALIZATION_MILLISECONDS) {
      // mkdir is the atomic ownership operation; owner.json is written
      // immediately after it. Do not steal during that small publication gap.
      return { acquired: false, directory, owner: null, fileSystem };
    }

    const staleDirectory = path.join(
      outbox,
      `${WATCH_LEASE_DIRECTORY}.stale.${pid}.${crypto.randomBytes(8).toString('hex')}`
    );
    try {
      fileSystem.renameSync(directory, staleDirectory);
      removeRenamedLease(staleDirectory, fileSystem);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('transcript sync worker lease contention did not converge');
}

function refreshWatchLease(lease, options = {}) {
  if (!lease || lease.acquired !== true) return false;
  const fileSystem = lease.fileSystem || fs;
  const ownerFile = path.join(lease.directory, WATCH_LEASE_OWNER_FILE);
  const current = readWatchLeaseOwner(ownerFile, fileSystem);
  if (!current || current.token !== lease.owner.token) return false;
  const now = options.now || (() => new Date());
  const timestamp = now();
  const date = timestamp instanceof Date ? timestamp : new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) throw new Error('transcript sync lease heartbeat time is invalid');
  fileSystem.utimesSync(ownerFile, date, date);
  return true;
}

function releaseWatchLease(lease) {
  if (!lease || lease.acquired !== true) return false;
  const fileSystem = lease.fileSystem || fs;
  let directoryStat;
  try {
    directoryStat = fileSystem.lstatSync(lease.directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return false;
  const ownerFile = path.join(lease.directory, WATCH_LEASE_OWNER_FILE);
  const current = readWatchLeaseOwner(ownerFile, fileSystem);
  if (!current || current.token !== lease.owner.token) return false;
  fileSystem.unlinkSync(ownerFile);
  try {
    fileSystem.rmdirSync(lease.directory);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  return true;
}

function discoverTranscriptFiles(sessionsRoot, reconcileAfter = null) {
  const rootStat = fs.lstatSync(sessionsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Codex sessions root must be a plain directory');
  }
  const cutoffMs = reconcileAfter === null || reconcileAfter === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(parseCanonicalUtcTimestamp(reconcileAfter, 'reconcileAfter'));
  const files = [];
  const queue = [sessionsRoot];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (cutoffMs === Number.NEGATIVE_INFINITY) {
          files.push(candidate);
        } else {
          const stat = fs.lstatSync(candidate);
          if (!stat.isSymbolicLink() && stat.isFile() && stat.mtimeMs >= cutoffMs) {
            files.push(candidate);
          }
        }
      }
      if (files.length > MAX_SOURCE_FILES) throw new Error('Codex sessions root contains too many transcripts');
    }
  }
  return files.sort();
}

function sourcesForMode(args, paths) {
  if (args.mode === 'outbox') {
    return readOutboxJobs(paths.outbox).map((entry) => ({
      file: entry.job.transcript_path,
      expectedRootSessionId: entry.job.root_session_id,
      expectedPathHash: entry.job.path_hash,
      expectedFileIdentityHash: entry.job.file_identity_hash,
      outboxEntry: entry,
    }));
  }
  if (args.mode === 'all') {
    return discoverTranscriptFiles(paths.sessionsRoot, args.reconcileAfter)
      .map((file) => ({ file }));
  }
  return args.files.map((file) => ({ file: path.resolve(file) }));
}

async function dryRunFile(source, sessionsRoot) {
  const snapshot = await streamTranscriptSnapshot(source.file, {
    sessionsRoot,
    expectedRootSessionId: source.expectedRootSessionId,
  });
  return {
    verified: false,
    transcriptId: snapshot.transcript.transcriptId,
    eventCount: snapshot.eventCount,
    insertedEvents: 0,
    trailingBytes: snapshot.trailingBytes,
    dryRun: true,
  };
}

async function runOnce(args, dependencies = {}) {
  const env = dependencies.env || process.env;
  const paths = resolveRuntimePaths(args, env);
  const sources = sourcesForMode(args, paths);
  const summary = {
    attempted: sources.length,
    verified: 0,
    pending: 0,
    failed: 0,
    insertedEvents: 0,
    storedEvents: 0,
    separateReader: null,
    results: [],
  };
  if (sources.length === 0) return summary;

  const syncFile = dependencies.syncFile || syncTranscriptFile;
  const openPostgres = dependencies.openPostgres || openTranscriptPostgres;
  let database = null;
  if (!args.dryRun) {
    database = await openPostgres({ env });
    summary.separateReader = database.separateReader === true;
  }
  try {
    for (const source of sources) {
      const sourceRef = sha256(path.resolve(source.file)).slice(0, 12);
      try {
        assertQueuedPrefix(source);
        const result = args.dryRun
          ? await dryRunFile(source, paths.sessionsRoot)
          : await syncFile(source.file, {
            sessionsRoot: paths.sessionsRoot,
            writer: database.writer,
            reader: database.reader,
            expectedRootSessionId: source.expectedRootSessionId,
            expectedPathHash: source.expectedPathHash,
            expectedFileIdentityHash: source.expectedFileIdentityHash,
            expectedObservedSize: source.outboxEntry && source.outboxEntry.job.observed_size,
            expectedMtime: source.outboxEntry && source.outboxEntry.job.mtime,
            expectedQueuedPrefixSha256:
              source.outboxEntry && source.outboxEntry.job.queued_prefix_sha256,
          });
        summary.insertedEvents += Number(result.insertedEvents || 0);
        summary.storedEvents += Number(result.eventCount || 0);
        if (result.verified === true) summary.verified += 1;
        const complete = !args.dryRun
          && result.verified === true
          && Number(result.trailingBytes) === 0
          && queuedSnapshotCovered(source, result);
        if (!complete) {
          summary.pending += 1;
        } else if (source.outboxEntry && !args.keepJobs) {
          // Recheck immediately before unlink so a same-inode rewrite after sync
          // cannot acknowledge a job for a different queued prefix.
          assertQueuedPrefix(source);
          acknowledgeJob(source.outboxEntry);
        }
        summary.results.push({
          sourceRef,
          status: complete ? 'verified' : (args.dryRun ? 'dry-run' : 'pending'),
          transcriptId: result.transcriptId,
          eventCount: result.eventCount,
          insertedEvents: result.insertedEvents,
          trailingBytes: result.trailingBytes,
        });
      } catch (error) {
        summary.failed += 1;
        summary.results.push({
          sourceRef,
          status: 'failed',
          errorCode: SYNC_FAILURE_CODE,
        });
      }
    }
  } finally {
    if (database) await database.close();
  }
  return summary;
}

function printHelp() {
  console.log([
    'Usage: sync-codex-transcripts.js [--outbox [dir] | --all | --file path] [options]',
    '',
    'Options:',
    '  --sessions-root <dir>  Trusted Codex sessions directory',
    '  --env-file <file>      Private PostgreSQL environment file',
    '  --dry-run              Parse and redact without database writes',
    '  --keep-jobs            Do not acknowledge verified outbox jobs',
    '  --watch[-seconds N]    Repeatedly drain the outbox',
    `  --reconcile-seconds N  Full session scan interval (default ${DEFAULT_RECONCILE_SECONDS})`,
    '  --reconcile-after ISO   For --all/watch, include files modified at/after this UTC time',
    '  --json                 Emit a JSON summary without transcript content',
  ].join('\n'));
}

function printSummary(summary, json) {
  if (json) {
    console.log(JSON.stringify(summary));
    return;
  }
  console.log(
    `Codex transcript sync: attempted=${summary.attempted} verified=${summary.verified} `
      + `pending=${summary.pending} failed=${summary.failed} inserted_events=${summary.insertedEvents}`
  );
  for (const result of summary.results) {
    const detail = result.status === 'failed'
      ? ` error=${result.errorCode}`
      : ` transcript=${result.transcriptId} events=${result.eventCount} inserted=${result.insertedEvents}`;
    console.log(`  ${result.sourceRef} ${result.status}${detail}`);
  }
}

function formatFatalDiagnostic() {
  return `[codex-transcript-sync] ${FATAL_FAILURE_CODE}\n`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function emptyWatchCycle() {
  return {
    attempted: 0,
    verified: 0,
    pending: 0,
    failed: 0,
    insertedEvents: 0,
    fatal: false,
  };
}

function addWatchSummary(target, summary) {
  for (const field of ['attempted', 'verified', 'pending', 'failed', 'insertedEvents']) {
    target[field] += Number(summary && summary[field] || 0);
  }
}

function printWatchCycle(summary, json, output = console.log) {
  const errorCode = summary.fatal
    ? FATAL_FAILURE_CODE
    : (summary.failed > 0 ? SYNC_FAILURE_CODE : null);
  if (json) {
    output(JSON.stringify({
      attempted: summary.attempted,
      verified: summary.verified,
      pending: summary.pending,
      failed: summary.failed,
      insertedEvents: summary.insertedEvents,
      errorCode,
    }));
    return;
  }
  output(
    `[codex-transcript-sync] attempted=${summary.attempted} verified=${summary.verified} `
      + `pending=${summary.pending} failed=${summary.failed} inserted_events=${summary.insertedEvents}`
      + (errorCode ? ` error=${errorCode}` : '')
  );
}

function watchCycleArgs(args, mode) {
  return {
    ...args,
    mode,
    files: [],
    watchSeconds: null,
  };
}

async function runWatch(args, dependencies = {}) {
  const env = dependencies.env || process.env;
  const paths = resolveRuntimePaths(args, env);
  const acquireLease = dependencies.acquireLease || acquireWatchLease;
  const lease = acquireLease(paths.outbox, dependencies.leaseOptions || {});
  const output = dependencies.output || console.log;
  if (!lease.acquired) {
    output('[codex-transcript-sync] worker=already-running');
    return { code: 0, status: 'already-running', iterations: 0 };
  }

  const runCycle = dependencies.runOnce || runOnce;
  const waitFor = dependencies.wait || wait;
  const now = dependencies.now || Date.now;
  const maxIterations = dependencies.maxIterations === undefined
    ? Number.POSITIVE_INFINITY
    : dependencies.maxIterations;
  const maxRetryMilliseconds = Number(dependencies.maxRetrySeconds || MAX_RETRY_SECONDS) * 1000;
  let nextReconciliationAt = Number.NEGATIVE_INFINITY;
  let failureStreak = 0;
  let iterations = 0;
  let leaseHealthy = refreshWatchLease(lease);
  const heartbeatTimer = setInterval(() => {
    try {
      leaseHealthy = refreshWatchLease(lease);
    } catch {
      leaseHealthy = false;
    }
  }, WATCH_LEASE_HEARTBEAT_MILLISECONDS);
  if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  try {
    while (iterations < maxIterations) {
      if (!leaseHealthy) throw new Error('transcript sync worker lease was lost');
      leaseHealthy = refreshWatchLease(lease);
      const cycle = emptyWatchCycle();
      const cycleStartedAt = Number(now());
      try {
        const drained = await runCycle(watchCycleArgs(args, 'outbox'), {
          env,
          openPostgres: dependencies.openPostgres,
          syncFile: dependencies.syncFile,
        });
        addWatchSummary(cycle, drained);
      } catch {
        cycle.fatal = true;
      }

      if (cycleStartedAt >= nextReconciliationAt) {
        try {
          const reconciled = await runCycle(watchCycleArgs(args, 'all'), {
            env,
            openPostgres: dependencies.openPostgres,
            syncFile: dependencies.syncFile,
          });
          addWatchSummary(cycle, reconciled);
        } catch {
          cycle.fatal = true;
        }
        nextReconciliationAt = cycleStartedAt + (args.reconcileSeconds * 1000);
      }

      printWatchCycle(cycle, args.json, output);
      iterations += 1;
      const failed = cycle.fatal || cycle.failed > 0;
      failureStreak = failed ? failureStreak + 1 : 0;
      if (iterations >= maxIterations) break;
      const baseMilliseconds = args.watchSeconds * 1000;
      const retryMilliseconds = failed
        ? Math.min(baseMilliseconds * (2 ** Math.max(0, failureStreak - 1)), maxRetryMilliseconds)
        : baseMilliseconds;
      await waitFor(retryMilliseconds);
    }
    return { code: 0, status: 'stopped', iterations };
  } finally {
    clearInterval(heartbeatTimer);
    (dependencies.releaseLease || releaseWatchLease)(lease);
  }
}

async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.envFile) loadEnvFile(args.envFile, env);
  if (args.watchSeconds) {
    const result = await runWatch(args, { ...dependencies, env });
    return result.code;
  }
  const runCycle = dependencies.runOnce || runOnce;
  const summary = await runCycle(args, {
    env,
    openPostgres: dependencies.openPostgres,
    syncFile: dependencies.syncFile,
  });
  printSummary(summary, args.json);
  return summary.failed > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    () => {
      process.stderr.write(formatFatalDiagnostic());
      process.exitCode = 1;
    }
  );
}

module.exports = {
  OUTBOX_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION_V2,
  acquireWatchLease,
  acknowledgeJob,
  discoverTranscriptFiles,
  formatFatalDiagnostic,
  loadEnvFile,
  main,
  parseArgs,
  readOutboxJobs,
  refreshWatchLease,
  releaseWatchLease,
  resolveRuntimePaths,
  runOnce,
  runWatch,
  validateJob,
};
