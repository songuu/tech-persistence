'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { redactSensitiveText } = require('./redaction');
const { withoutPrivateDatabaseCredentials } = require('./private-runtime-env');

const MAX_BUFFER = 1024 * 1024;

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return resolved;
  }
}

function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertBrokerOutsideProviderRoot(providerRoot, envFile, bridge) {
  if (!providerRoot) return;
  const root = canonicalPath(providerRoot);
  if (pathWithin(root, canonicalPath(envFile)) || pathWithin(root, canonicalPath(bridge))) {
    throw new Error(
      'Acceptance PostgreSQL broker and private environment must be outside the provider workspace'
    );
  }
}

function appendPostgresAuthorityRecordSync(record, options = {}) {
  if (!options.postgresEnvFile) return null;
  const envFile = path.resolve(String(options.postgresEnvFile));
  let stat;
  try {
    stat = fs.lstatSync(envFile);
  } catch {
    throw new Error('Acceptance PostgreSQL private environment is unavailable');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Acceptance PostgreSQL private environment must be a regular non-link file');
  }
  const runner = options.spawnSyncImpl || spawnSync;
  const bridge = path.resolve(
    options.postgresBrokerPath || path.join(__dirname, '..', 'acceptance-postgres-authority.js')
  );
  let bridgeStat;
  try {
    bridgeStat = fs.lstatSync(bridge);
  } catch {
    throw new Error('Acceptance PostgreSQL authority broker is unavailable');
  }
  if (!bridgeStat.isFile() || bridgeStat.isSymbolicLink()) {
    throw new Error('Acceptance PostgreSQL authority broker must be a regular non-link file');
  }
  assertBrokerOutsideProviderRoot(options.providerRoot, envFile, bridge);
  const serialized = JSON.stringify(record);
  const result = runner(process.execPath, [bridge, 'append', envFile], {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    input: serialized,
    maxBuffer: MAX_BUFFER,
    shell: false,
    timeout: options.postgresTimeoutMs || 30_000,
    windowsHide: true,
    env: withoutPrivateDatabaseCredentials(),
  });
  if (result.error || result.status !== 0) {
    const detail = redactSensitiveText(
      result.error && result.error.message
        ? result.error.message
        : String(result.stderr || result.stdout || `exit ${result.status}`).trim()
    );
    throw new Error(`Acceptance PostgreSQL authority broker failed: ${detail}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || '').trim());
  } catch {
    throw new Error('Acceptance PostgreSQL authority broker returned invalid JSON');
  }
  if (!parsed || parsed.verified !== true || parsed.recordHash !== record.recordHash) {
    throw new Error('Acceptance PostgreSQL authority broker readback does not match the record');
  }
  return parsed;
}

module.exports = { appendPostgresAuthorityRecordSync };
