#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WATCH_SECONDS = 15;
const DEFAULT_RECONCILE_SECONDS = 900;
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024;
const CONFIGURED_FIELDS = Object.freeze([
  'enabled',
  'runtimeRoot',
  'envFile',
  'watchSeconds',
  'reconcileSeconds',
  'reconcileAfter',
]);

function dependencyFailure(error) {
  if (error && typeof error.code === 'string' && error.code) return error.code;
  if (error && error.name && error.name !== 'Error') return error.name;
  return 'operation failed';
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(value, field) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function boundedInterval(value, field) {
  const parsed = positiveInteger(value, field);
  if (parsed > MAX_INTERVAL_SECONDS) {
    throw new Error(`${field} must be at most ${MAX_INTERVAL_SECONDS}`);
  }
  return parsed;
}

function canonicalUtcTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} must be a valid timestamp`);
  }
  const canonical = date.toISOString();
  if (typeof value === 'string' && value !== canonical) {
    throw new Error(`${field} must be a canonical UTC timestamp`);
  }
  return canonical;
}

function defaultHome(runtime = {}) {
  if (runtime.home) return runtime.home;
  const env = runtime.env || process.env;
  return env.HOME || env.USERPROFILE || os.homedir();
}

function parseArgs(argv, runtime = {}) {
  const env = runtime.env || process.env;
  const home = defaultHome(runtime);
  const cwd = runtime.cwd || process.cwd();
  const options = {
    runtimeRoot: runtime.repoRoot || REPO_ROOT,
    envFile: null,
    configPath: env.TECH_PERSISTENCE_CONFIG
      || path.join(home, '.tech-persistence', 'config.json'),
    watchSeconds: DEFAULT_WATCH_SECONDS,
    reconcileSeconds: DEFAULT_RECONCILE_SECONDS,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime-root') {
      options.runtimeRoot = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--env-file') {
      options.envFile = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--config') {
      options.configPath = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--watch-seconds') {
      options.watchSeconds = boundedInterval(requireValue(argv, index, arg), 'watchSeconds');
      index += 1;
    } else if (arg === '--reconcile-seconds') {
      options.reconcileSeconds = boundedInterval(
        requireValue(argv, index, arg),
        'reconcileSeconds'
      );
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error('Unknown option');
    }
  }

  if (!options.envFile) {
    options.envFile = path.join(
      options.runtimeRoot,
      'deploy',
      'postgres',
      '.env.transcripts'
    );
  }
  options.runtimeRoot = path.resolve(cwd, options.runtimeRoot);
  options.envFile = path.resolve(cwd, options.envFile);
  options.configPath = path.resolve(cwd, options.configPath);
  return options;
}

function assertAbsolutePath(value, field, pathModule = path) {
  if (typeof value !== 'string' || !pathModule.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path`);
  }
}

function lstatOrNull(fileSystem, file, field) {
  try {
    return fileSystem.lstatSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`${field} could not be inspected (${dependencyFailure(error)})`);
  }
}

function sameFile(left, right) {
  if (
    Number.isSafeInteger(left.dev)
    && Number.isSafeInteger(left.ino)
    && Number.isSafeInteger(right.dev)
    && Number.isSafeInteger(right.ino)
    && (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0)
  ) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function inspectPlainFile(fileSystem, file, field, options = {}) {
  const before = lstatOrNull(fileSystem, file, field);
  if (!before) throw new Error(`${field} does not exist`);
  if (before.isSymbolicLink()) throw new Error(`${field} must not be a symbolic link`);
  if (!before.isFile()) throw new Error(`${field} must be a plain file`);
  if (options.maxBytes !== undefined && before.size > options.maxBytes) {
    throw new Error(`${field} exceeds the size limit of ${options.maxBytes} bytes`);
  }

  let descriptor;
  try {
    descriptor = fileSystem.openSync(file, 'r');
    const opened = fileSystem.fstatSync(descriptor);
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new Error(`${field} changed while it was being validated`);
    }
    if (options.maxBytes !== undefined && opened.size > options.maxBytes) {
      throw new Error(`${field} exceeds the size limit of ${options.maxBytes} bytes`);
    }
    return { descriptor, stat: opened };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch (_) {
        // The original validation error is more useful.
      }
    }
    if (error && error.message && error.message.startsWith(`${field} `)) throw error;
    throw new Error(`${field} could not be opened safely (${dependencyFailure(error)})`);
  }
}

function closeDescriptor(fileSystem, descriptor, field) {
  try {
    fileSystem.closeSync(descriptor);
  } catch (error) {
    throw new Error(`${field} could not be closed after validation (${dependencyFailure(error)})`);
  }
}

function assertPlainFile(fileSystem, file, field) {
  const inspected = inspectPlainFile(fileSystem, file, field);
  closeDescriptor(fileSystem, inspected.descriptor, field);
  return inspected.stat;
}

function readJsonObject(fileSystem, file, field, maxBytes) {
  const inspected = inspectPlainFile(fileSystem, file, field, { maxBytes });
  let raw;
  try {
    raw = fileSystem.readFileSync(inspected.descriptor, 'utf8');
  } catch (error) {
    closeDescriptor(fileSystem, inspected.descriptor, field);
    throw new Error(`${field} could not be read (${dependencyFailure(error)})`);
  }
  closeDescriptor(fileSystem, inspected.descriptor, field);

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${field} must contain valid JSON (${dependencyFailure(error)})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must contain a JSON object`);
  }
  return { value, stat: inspected.stat };
}

function assertDirectory(fileSystem, directory, field) {
  const stat = lstatOrNull(fileSystem, directory, field);
  if (!stat) throw new Error(`${field} does not exist`);
  if (stat.isSymbolicLink()) throw new Error(`${field} must not be a symbolic link`);
  if (!stat.isDirectory()) throw new Error(`${field} must be a directory`);
}

function validateRuntime(options, dependencies) {
  const fileSystem = dependencies.fileSystem;
  const pathModule = dependencies.pathModule;
  assertDirectory(fileSystem, options.runtimeRoot, 'runtimeRoot');

  const packageFile = pathModule.join(options.runtimeRoot, 'package.json');
  const packageJson = readJsonObject(
    fileSystem,
    packageFile,
    'runtimeRoot/package.json',
    MAX_PACKAGE_BYTES
  ).value;
  if (packageJson.name !== 'tech-persistence') {
    throw new Error('runtimeRoot/package.json name must be tech-persistence');
  }

  const syncScript = pathModule.join(options.runtimeRoot, 'scripts', 'sync-codex-transcripts.js');
  assertPlainFile(fileSystem, syncScript, 'runtimeRoot/scripts/sync-codex-transcripts.js');

  let pgEntrypoint;
  try {
    pgEntrypoint = dependencies.resolveModule('pg', options.runtimeRoot);
  } catch (error) {
    throw new Error(`pg is not resolvable from runtimeRoot (${dependencyFailure(error)})`);
  }
  if (typeof pgEntrypoint !== 'string' || !pathModule.isAbsolute(pgEntrypoint)) {
    throw new Error('pg resolved from runtimeRoot must have an absolute entrypoint');
  }
  assertPlainFile(fileSystem, pgEntrypoint, 'pg entrypoint resolved from runtimeRoot');
}

function configFingerprint(stat) {
  if (!stat) return { exists: false };
  return {
    exists: true,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function readExistingConfig(fileSystem, configPath) {
  const stat = lstatOrNull(fileSystem, configPath, 'configPath');
  if (!stat) return { config: {}, fingerprint: configFingerprint(null) };
  if (stat.isSymbolicLink()) throw new Error('configPath must not be a symbolic link');
  if (!stat.isFile()) throw new Error('configPath must be a plain file');
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new Error(`configPath exceeds the size limit of ${MAX_CONFIG_BYTES} bytes`);
  }
  const read = readJsonObject(fileSystem, configPath, 'configPath', MAX_CONFIG_BYTES);
  return { config: read.value, fingerprint: configFingerprint(read.stat) };
}

function assertConfigUnchanged(fileSystem, configPath, fingerprint) {
  const current = lstatOrNull(fileSystem, configPath, 'configPath');
  if (!fingerprint.exists) {
    if (current) throw new Error('configPath appeared during configuration');
    return;
  }
  if (!current || current.isSymbolicLink() || !current.isFile()) {
    throw new Error('configPath changed during configuration');
  }
  const next = configFingerprint(current);
  if (
    next.dev !== fingerprint.dev
    || next.ino !== fingerprint.ino
    || next.size !== fingerprint.size
    || next.mtimeMs !== fingerprint.mtimeMs
  ) {
    throw new Error('configPath changed during configuration');
  }
}

function randomSuffix(randomBytes) {
  return randomBytes(12).toString('hex');
}

function atomicWriteJson(fileSystem, configPath, value, options = {}) {
  const pathModule = options.pathModule || path;
  const platform = options.platform || process.platform;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const directory = pathModule.dirname(configPath);
  const basename = pathModule.basename(configPath);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });

  let temporaryPath;
  let descriptor;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      temporaryPath = pathModule.join(
        directory,
        `.${basename}.tmp-${process.pid}-${randomSuffix(randomBytes)}`
      );
      try {
        descriptor = fileSystem.openSync(temporaryPath, 'wx', 0o600);
        break;
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
      }
    }
    if (descriptor === undefined) throw new Error('temporary name collision limit reached');

    fileSystem.writeFileSync(descriptor, serialized, 'utf8');
    if (platform !== 'win32') fileSystem.fchmodSync(descriptor, 0o600);
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;

    if (typeof options.beforeRename === 'function') options.beforeRename();
    fileSystem.renameSync(temporaryPath, configPath);
    temporaryPath = undefined;

    if (platform !== 'win32') {
      let directoryDescriptor;
      try {
        directoryDescriptor = fileSystem.openSync(directory, 'r');
        fileSystem.fsyncSync(directoryDescriptor);
      } finally {
        if (directoryDescriptor !== undefined) fileSystem.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch (_) {
        // Preserve the original atomic-write failure.
      }
    }
    if (temporaryPath) {
      try {
        fileSystem.unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (!cleanupError || cleanupError.code !== 'ENOENT') {
          // Preserve the original failure without leaking a temporary file path.
        }
      }
    }
    throw new Error(`atomically write configPath failed (${dependencyFailure(error)})`);
  }
}

function normalizeDependencies(dependencies = {}) {
  return {
    fileSystem: dependencies.fileSystem || fs,
    pathModule: dependencies.pathModule || path,
    platform: dependencies.platform || process.platform,
    randomBytes: dependencies.randomBytes || crypto.randomBytes,
    now: dependencies.now || (() => new Date()),
    resolveModule: dependencies.resolveModule || ((moduleName, runtimeRoot) => (
      require.resolve(moduleName, { paths: [runtimeRoot] })
    )),
  };
}

function configureCodexTranscriptSync(options = {}, injected = {}) {
  const dependencies = normalizeDependencies(injected);
  const runtimeRoot = options.runtimeRoot || REPO_ROOT;
  const envFile = options.envFile || dependencies.pathModule.join(
    runtimeRoot,
    'deploy',
    'postgres',
    '.env.transcripts'
  );
  const home = options.home || defaultHome({ env: options.env });
  const configPath = options.configPath || dependencies.pathModule.join(
    home,
    '.tech-persistence',
    'config.json'
  );
  const normalized = {
    runtimeRoot,
    envFile,
    configPath,
    watchSeconds: boundedInterval(
      options.watchSeconds === undefined ? DEFAULT_WATCH_SECONDS : options.watchSeconds,
      'watchSeconds'
    ),
    reconcileSeconds: boundedInterval(
      options.reconcileSeconds === undefined
        ? DEFAULT_RECONCILE_SECONDS
        : options.reconcileSeconds,
      'reconcileSeconds'
    ),
    dryRun: options.dryRun === true,
  };

  assertAbsolutePath(normalized.runtimeRoot, 'runtimeRoot', dependencies.pathModule);
  assertAbsolutePath(normalized.envFile, 'envFile', dependencies.pathModule);
  assertAbsolutePath(normalized.configPath, 'configPath', dependencies.pathModule);
  validateRuntime(normalized, dependencies);
  assertPlainFile(dependencies.fileSystem, normalized.envFile, 'envFile');
  const existing = readExistingConfig(dependencies.fileSystem, normalized.configPath);
  const previousTranscriptSync = existing.config.transcriptSync;
  if (
    previousTranscriptSync !== undefined
    && (
      previousTranscriptSync === null
      || typeof previousTranscriptSync !== 'object'
      || Array.isArray(previousTranscriptSync)
    )
  ) {
    throw new Error('configPath transcriptSync must be a JSON object when present');
  }
  const reconcileAfter = previousTranscriptSync
    && previousTranscriptSync.reconcileAfter !== undefined
    ? (() => {
      if (typeof previousTranscriptSync.reconcileAfter !== 'string') {
        throw new Error(
          'configPath transcriptSync.reconcileAfter must be a canonical UTC timestamp'
        );
      }
      return canonicalUtcTimestamp(
        previousTranscriptSync.reconcileAfter,
        'configPath transcriptSync.reconcileAfter'
      );
    })()
    : canonicalUtcTimestamp(dependencies.now(), 'reconcileAfter');

  const nextConfig = {
    ...existing.config,
    transcriptSync: {
      ...(previousTranscriptSync || {}),
      enabled: true,
      runtimeRoot: normalized.runtimeRoot,
      envFile: normalized.envFile,
      watchSeconds: normalized.watchSeconds,
      reconcileSeconds: normalized.reconcileSeconds,
      reconcileAfter,
    },
  };

  if (!normalized.dryRun) {
    atomicWriteJson(dependencies.fileSystem, normalized.configPath, nextConfig, {
      pathModule: dependencies.pathModule,
      platform: dependencies.platform,
      randomBytes: dependencies.randomBytes,
      beforeRename: () => assertConfigUnchanged(
        dependencies.fileSystem,
        normalized.configPath,
        existing.fingerprint
      ),
    });
  }

  return {
    status: normalized.dryRun ? 'planned' : 'configured',
    configuredFields: [...CONFIGURED_FIELDS],
    config: nextConfig,
  };
}

function showHelp(writeLine = console.log) {
  writeLine('Configure automatic Codex transcript delivery.');
  writeLine('');
  writeLine('Usage:');
  writeLine('  node scripts/configure-codex-transcript-sync.js [options]');
  writeLine('');
  writeLine('Options:');
  writeLine('  --runtime-root <dir>       Tech Persistence runtime root.');
  writeLine('  --env-file <file>          PostgreSQL environment file.');
  writeLine('  --config <file>            User config file.');
  writeLine(`  --watch-seconds <n>        Delivery poll interval. Default: ${DEFAULT_WATCH_SECONDS}`);
  writeLine(`  --reconcile-seconds <n>    Full reconciliation interval. Default: ${DEFAULT_RECONCILE_SECONDS}`);
  writeLine('  --dry-run                  Validate and report fields without writing.');
  writeLine('  --help                     Show this help.');
}

function main(argv = process.argv.slice(2), injected = {}) {
  const stdout = injected.stdout || ((line) => console.log(line));
  const stderr = injected.stderr || ((line) => console.error(line));
  try {
    const options = parseArgs(argv, {
      env: injected.env || process.env,
      home: injected.home,
      repoRoot: injected.repoRoot,
      cwd: injected.cwd,
    });
    if (options.help) {
      showHelp(stdout);
      return 0;
    }
    const result = configureCodexTranscriptSync(options, injected);
    stdout(`[${options.dryRun ? 'DRY-RUN' : 'OK'}] transcript sync ${result.status}`);
    stdout(`configured fields: ${result.configuredFields.join(', ')}`);
    return 0;
  } catch (error) {
    stderr(`[FAIL] ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  CONFIGURED_FIELDS,
  DEFAULT_RECONCILE_SECONDS,
  DEFAULT_WATCH_SECONDS,
  MAX_CONFIG_BYTES,
  MAX_INTERVAL_SECONDS,
  atomicWriteJson,
  configureCodexTranscriptSync,
  main,
  parseArgs,
  readExistingConfig,
  validateRuntime,
};
