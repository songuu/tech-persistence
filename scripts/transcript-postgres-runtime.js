#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_POSTGRES_PORT = 55433;
const DATABASE_NAME = 'tech_persistence';
const DATABASE_HOST = '127.0.0.1';
const COMPOSE_PROJECT_NAME = 'tech-persistence-transcripts';
const POSTGRES_STARTUP_MIN_FREE_BYTES = 2n * 1024n * 1024n * 1024n;
const POSTGRES_STARTUP_MIN_FREE_INODES = 10_000n;
const POSTGRES_STARTUP_MAX_USED_PERCENT = 95n;
const POSTGRES_DATA_DIR_ENV = 'TECH_PERSISTENCE_POSTGRES_DATA_DIR';
const POSTGRES_LOCAL_DEV_ENV = 'TECH_PERSISTENCE_POSTGRES_LOCAL_DEV';
const SECRET_DEFINITIONS = Object.freeze([
  { key: 'admin', fileName: 'postgres-admin-password' },
  { key: 'reader', fileName: 'transcript-reader-password' },
  { key: 'writer', fileName: 'transcript-writer-password' },
]);

function defaultPostgresDataDir() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), '.tech-persistence', 'shared', 'postgres');
  }
  return '/opt/tech-persistence/shared/postgres';
}

function normalizeAbsoluteDataDir(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new Error('Transcript PostgreSQL stable PGDATA policy requires a non-empty absolute directory');
  }
  if (!path.isAbsolute(value)) {
    throw new Error('Transcript PostgreSQL stable PGDATA policy requires an absolute directory');
  }
  return path.resolve(value);
}

function resolveRuntimePaths(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
  const runtimeEnv = options.env || process.env;
  const postgresRoot = path.resolve(
    options.postgresRoot || path.join(repoRoot, 'deploy', 'postgres')
  );
  const configuredDataDir = Object.prototype.hasOwnProperty.call(options, 'dataDir')
    ? options.dataDir
    : Object.prototype.hasOwnProperty.call(runtimeEnv, POSTGRES_DATA_DIR_ENV)
      ? runtimeEnv[POSTGRES_DATA_DIR_ENV]
      : defaultPostgresDataDir();
  return {
    repoRoot,
    postgresRoot,
    dataDir: normalizeAbsoluteDataDir(configuredDataDir),
    secretsDir: path.join(postgresRoot, 'secrets'),
    envFile: path.resolve(options.envFile || path.join(postgresRoot, '.env.transcripts')),
    composeFile: path.resolve(
      options.composeFile
        || path.join(repoRoot, 'deploy', 'compose', 'tech-persistence-postgres.compose.yml')
    ),
  };
}

function explicitDataDir(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'dataDir')) return options.dataDir;
  const runtimeEnv = options.env || process.env;
  return runtimeEnv[POSTGRES_DATA_DIR_ENV];
}

function pathComparisonKey(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function loadRuntimeState(options = {}, requireEnv = false) {
  let paths = resolveRuntimePaths(options);
  const envExists = fs.existsSync(paths.envFile);
  if (!envExists) {
    if (requireEnv) {
      throw new Error('Transcript PostgreSQL private environment is missing. Run prepare first.');
    }
    const runtimeEnv = options.env || process.env;
    return {
      paths,
      envExists: false,
      existingEnvContent: '',
      existingEnv: new Map(),
      allowLocalDevData: Object.prototype.hasOwnProperty.call(options, 'allowLocalDevData')
        ? options.allowLocalDevData === true
        : runtimeEnv[POSTGRES_LOCAL_DEV_ENV] === 'true',
    };
  }
  if (!fs.statSync(paths.envFile).isFile()) {
    throw new Error('Transcript PostgreSQL private environment must be a regular file');
  }

  const existingEnvContent = fs.readFileSync(paths.envFile, 'utf8');
  const existingEnv = parseEnv(existingEnvContent);
  if (existingEnv.has(POSTGRES_DATA_DIR_ENV)) {
    const persistedDataDir = existingEnv.get(POSTGRES_DATA_DIR_ENV);
    const normalizedPersistedDataDir = normalizeAbsoluteDataDir(persistedDataDir);
    const requestedDataDir = explicitDataDir(options);
    if (
      requestedDataDir
      && pathComparisonKey(normalizeAbsoluteDataDir(requestedDataDir))
        !== pathComparisonKey(normalizedPersistedDataDir)
    ) {
      throw new Error('Transcript PostgreSQL PGDATA configuration conflicts with the private environment');
    }
    paths = { ...paths, dataDir: normalizedPersistedDataDir };
  }

  const runtimeEnv = options.env || process.env;
  const allowLocalDevData = Object.prototype.hasOwnProperty.call(options, 'allowLocalDevData')
    ? options.allowLocalDevData === true
    : existingEnv.get(POSTGRES_LOCAL_DEV_ENV) === 'true'
      || runtimeEnv[POSTGRES_LOCAL_DEV_ENV] === 'true';
  return {
    paths,
    envExists: true,
    existingEnvContent,
    existingEnv,
    allowLocalDevData,
  };
}

function findExistingStorageProbe(target) {
  let candidate = path.resolve(target);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  if (!fs.existsSync(candidate)) {
    throw new Error('Transcript PostgreSQL storage preflight could not locate a filesystem');
  }
  return candidate;
}

function canonicalizePotentialPath(target) {
  const unresolved = [];
  let candidate = path.resolve(target);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error('Transcript PostgreSQL stable PGDATA policy could not verify the directory');
    }
    unresolved.unshift(path.basename(candidate));
    candidate = parent;
  }
  try {
    return path.resolve(fs.realpathSync(candidate), ...unresolved);
  } catch {
    throw new Error('Transcript PostgreSQL stable PGDATA policy could not verify the directory');
  }
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateStableDataDir(paths, allowLocalDevData) {
  const canonicalDataDir = canonicalizePotentialPath(paths.dataDir);
  const root = path.parse(canonicalDataDir).root;
  if (pathComparisonKey(canonicalDataDir) === pathComparisonKey(root)) {
    throw new Error('Transcript PostgreSQL stable PGDATA policy requires a dedicated directory');
  }
  if (allowLocalDevData) return;

  const canonicalRepoRoot = canonicalizePotentialPath(paths.repoRoot);
  const canonicalTempRoot = canonicalizePotentialPath(os.tmpdir());
  const segments = canonicalDataDir.split(/[\\/]+/).filter(Boolean);
  const hasVolatileSegment = segments.some((segment) => (
    /^(?:release|releases|worktree|worktrees)(?:[-_.].*)?$/i.test(segment)
  ));
  if (
    isSameOrInside(canonicalDataDir, canonicalRepoRoot)
    || isSameOrInside(canonicalDataDir, canonicalTempRoot)
    || hasVolatileSegment
  ) {
    throw new Error(
      'Transcript PostgreSQL stable PGDATA policy rejects repository, release, worktree, and temporary directories'
    );
  }
}

function bigintStatValue(stats, key) {
  const value = stats[key];
  if (typeof value === 'bigint') return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error('Transcript PostgreSQL storage preflight received invalid filesystem statistics');
}

function assertStorageCapacity(paths, options = {}) {
  const statfsSyncImpl = options.statfsSyncImpl || fs.statfsSync;
  const targets = [paths.dataDir, paths.secretsDir, path.dirname(paths.envFile)];
  const checkedProbes = new Set();

  for (const target of targets) {
    const probe = findExistingStorageProbe(target);
    const probeKey = pathComparisonKey(canonicalizePotentialPath(probe));
    if (checkedProbes.has(probeKey)) continue;
    checkedProbes.add(probeKey);

    let stats;
    try {
      stats = statfsSyncImpl(probe, { bigint: true });
    } catch {
      throw new Error('Transcript PostgreSQL storage preflight could not verify filesystem capacity');
    }
    const blockSize = bigintStatValue(stats, 'bsize');
    const availableBlocks = bigintStatValue(stats, 'bavail');
    const totalBlocks = bigintStatValue(stats, 'blocks');
    const freeBlocks = bigintStatValue(stats, 'bfree');
    const totalInodes = bigintStatValue(stats, 'files');
    const freeInodes = bigintStatValue(stats, 'ffree');
    if (blockSize === 0n || totalBlocks === 0n || freeBlocks > totalBlocks) {
      throw new Error('Transcript PostgreSQL storage preflight received invalid filesystem statistics');
    }

    const availableBytes = blockSize * availableBlocks;
    if (availableBytes < POSTGRES_STARTUP_MIN_FREE_BYTES) {
      throw new Error(
        'Transcript PostgreSQL storage preflight failed: free space is below the safe PostgreSQL startup reserve'
      );
    }
    const usedBlocks = totalBlocks - freeBlocks;
    if (usedBlocks * 100n >= totalBlocks * POSTGRES_STARTUP_MAX_USED_PERCENT) {
      throw new Error(
        'Transcript PostgreSQL storage preflight failed: filesystem utilization exceeds the safe startup limit'
      );
    }
    if (totalInodes > 0n && freeInodes < POSTGRES_STARTUP_MIN_FREE_INODES) {
      throw new Error(
        'Transcript PostgreSQL storage preflight failed: free inode count is below the safe PostgreSQL startup reserve'
      );
    }
  }
}

function directoryHasEntries(directory) {
  if (!fs.existsSync(directory)) return false;
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) {
    throw new Error(`Transcript PostgreSQL data path is not a directory: ${directory}`);
  }
  return fs.readdirSync(directory).length > 0;
}

function enforcePrivateFile(file) {
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function enforcePrivateDirectory(directory) {
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function writeNewPrivateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  enforcePrivateFile(file);
}

function generateSecret(randomBytes) {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) {
    throw new Error('Secret generator must return a Buffer containing at least 32 random bytes');
  }
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function readSecret(file, label) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    throw new Error(`Docker secret ${label} is not a regular file: ${file}`);
  }
  const value = fs.readFileSync(file, 'utf8').replace(/[\r\n]+$/g, '');
  if (!value || /[\r\n\0]/.test(value)) {
    throw new Error(`Docker secret ${label} must contain one non-empty line: ${file}`);
  }
  enforcePrivateFile(file);
  return value;
}

function parseEnv(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid TECH_PERSISTENCE_POSTGRES_PORT: ${String(value)}`);
  }
  return port;
}

function appendMissingEnvValues(envFile, existingContent, missingEntries) {
  if (missingEntries.length === 0) {
    enforcePrivateFile(envFile);
    return;
  }

  const lines = missingEntries.map(([key, value]) => `${key}=${value}`);
  if (!fs.existsSync(envFile)) {
    writeNewPrivateFile(
      envFile,
      `# Private local PostgreSQL runtime; do not commit.\n${lines.join('\n')}\n`
    );
    return;
  }

  const separator = existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(envFile, `${separator}${lines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  enforcePrivateFile(envFile);
}

function prepareRuntime(options = {}) {
  const runtimeState = loadRuntimeState(options);
  const {
    paths,
    existingEnvContent,
    existingEnv,
    allowLocalDevData,
  } = runtimeState;
  validateStableDataDir(paths, allowLocalDevData);
  // WHY: secrets, env, chmod, and mkdir are all writes. Capacity and inode
  // checks must therefore happen before even creating the runtime directories.
  assertStorageCapacity(paths, options);
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const secretPaths = SECRET_DEFINITIONS.map((definition) => ({
    ...definition,
    file: path.join(paths.secretsDir, definition.fileName),
  }));
  const missingSecrets = secretPaths.filter(({ file }) => !fs.existsSync(file));

  // WHY: initialized clusters retain role password hashes. Generating a new
  // missing file would make the runtime credential diverge from the database.
  if (missingSecrets.length > 0 && directoryHasEntries(paths.dataDir)) {
    throw new Error(
      `Transcript PostgreSQL data directory is not empty (${paths.dataDir}); missing Docker `
      + `secret files: ${missingSecrets.map(({ fileName }) => fileName).join(', ')}. `
      + 'Refusing to generate replacement credentials; restore the original secrets or recover the cluster explicitly.'
    );
  }

  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.secretsDir, { recursive: true, mode: 0o700 });
  enforcePrivateDirectory(paths.dataDir);
  enforcePrivateDirectory(paths.secretsDir);

  const createdSecrets = [];
  for (const secret of missingSecrets) {
    try {
      writeNewPrivateFile(secret.file, `${generateSecret(randomBytes)}\n`);
      createdSecrets.push(secret.fileName);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw new Error(`Failed to create Docker secret ${secret.fileName}: ${error.message}`, {
          cause: error,
        });
      }
    }
  }

  const secrets = Object.fromEntries(
    secretPaths.map(({ key, file, fileName }) => [key, readSecret(file, fileName)])
  );
  const requestedPort = existingEnv.get('TECH_PERSISTENCE_POSTGRES_PORT')
    || options.port
    || (options.env || process.env).TECH_PERSISTENCE_POSTGRES_PORT
    || DEFAULT_POSTGRES_PORT;
  const port = normalizePort(requestedPort);
  const readerPassword = encodeURIComponent(secrets.reader);
  const writerPassword = encodeURIComponent(secrets.writer);
  const desiredEnv = [
    [POSTGRES_DATA_DIR_ENV, paths.dataDir],
    ['TECH_PERSISTENCE_POSTGRES_PORT', String(port)],
    ['TRANSCRIPTS_POSTGRES_SSL', 'false'],
    [
      'TRANSCRIPTS_POSTGRES_READ_URL',
      `postgresql://transcript_reader:${readerPassword}@${DATABASE_HOST}:${port}/${DATABASE_NAME}`,
    ],
    [
      'TRANSCRIPTS_POSTGRES_WRITE_URL',
      `postgresql://transcript_writer:${writerPassword}@${DATABASE_HOST}:${port}/${DATABASE_NAME}`,
    ],
  ];
  if (allowLocalDevData) desiredEnv.splice(1, 0, [POSTGRES_LOCAL_DEV_ENV, 'true']);
  const missingEnvEntries = desiredEnv.filter(([key]) => !existingEnv.has(key));
  appendMissingEnvValues(paths.envFile, existingEnvContent, missingEnvEntries);

  return {
    ...paths,
    port,
    createdSecrets,
    addedEnvKeys: missingEnvEntries.map(([key]) => key),
  };
}

function runCompose(operation, composeArgs, options = {}) {
  const runtimeState = loadRuntimeState(options, true);
  const { paths, allowLocalDevData } = runtimeState;
  if (!fs.existsSync(paths.composeFile)) {
    throw new Error(`Docker Compose file is missing for ${operation}: ${paths.composeFile}`);
  }
  if (operation === 'up') {
    validateStableDataDir(paths, allowLocalDevData);
    // Recheck immediately before Docker can write PGDATA. This narrows the
    // race after prepare and still leaves status/down usable during low space.
    assertStorageCapacity(paths, options);
  }
  const runner = options.spawnSyncImpl || spawnSync;
  const args = [
    'compose',
    '--project-name',
    COMPOSE_PROJECT_NAME,
    '--env-file',
    paths.envFile,
    '-f',
    paths.composeFile,
    ...composeArgs,
  ];
  const result = runner('docker', args, {
    cwd: paths.repoRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: options.timeoutMs || 120_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`docker compose ${operation} failed to start: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`docker compose ${operation} failed (exit ${result.status}): ${detail}`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function runCli(argv, options = {}) {
  const [command, ...extra] = argv;
  if (extra.length > 0) {
    throw new Error(`Unexpected arguments for transcript PostgreSQL ${command || 'command'}: ${extra.join(' ')}`);
  }

  if (command === 'prepare') return prepareRuntime(options);
  if (command === 'up') {
    prepareRuntime(options);
    return runCompose('up', ['up', '-d', '--wait', '--wait-timeout', '120'], options);
  }
  if (command === 'status') return runCompose('status', ['ps'], options);
  if (command === 'down') return runCompose('down', ['down'], options);
  throw new Error('Usage: node scripts/transcript-postgres-runtime.js <prepare|up|status|down>');
}

function main() {
  try {
    const command = process.argv[2];
    const result = runCli(process.argv.slice(2));
    if (command === 'prepare') {
      console.log(
        `[transcript-postgres] prepared port=${result.port} `
        + `created_secrets=${result.createdSecrets.length} added_env_keys=${result.addedEnvKeys.length}`
      );
    }
  } catch (error) {
    console.error(`[transcript-postgres] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  COMPOSE_PROJECT_NAME,
  DATABASE_HOST,
  DATABASE_NAME,
  DEFAULT_POSTGRES_PORT,
  POSTGRES_STARTUP_MAX_USED_PERCENT,
  POSTGRES_STARTUP_MIN_FREE_BYTES,
  POSTGRES_STARTUP_MIN_FREE_INODES,
  SECRET_DEFINITIONS,
  assertStorageCapacity,
  prepareRuntime,
  resolveRuntimePaths,
  runCli,
  runCompose,
};

if (require.main === module) main();
