'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { redactArtifactValue, redactSensitiveText } = require('../lib/redaction');
const validationPolicy = require('./validation-command-policy');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_COMMANDS = 32;

function hashText(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function normalizeRef(value) {
  return value.split(path.sep).join('/');
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveDirectories(workdirValue, runDirValue) {
  if (!runDirValue) throw new Error('validation runner requires runDir');
  const workdir = path.resolve(workdirValue || process.cwd());
  let workdirStat;
  try {
    workdirStat = fs.statSync(workdir);
  } catch (error) {
    throw new Error(`validation workdir is not readable: ${workdir}: ${error.message}`);
  }
  if (!workdirStat.isDirectory()) throw new Error(`validation workdir is not a directory: ${workdir}`);

  const runDir = path.resolve(runDirValue);
  if (!pathInside(workdir, runDir)) {
    throw new Error(`validation runDir must stay inside workdir: ${runDir}`);
  }
  fs.mkdirSync(runDir, { recursive: true });
  const realWorkdir = fs.realpathSync(workdir);
  const realRunDir = fs.realpathSync(runDir);
  if (!pathInside(realWorkdir, realRunDir)) {
    throw new Error(`validation runDir must stay inside workdir: ${runDir}`);
  }

  const logsDir = path.join(realRunDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const realLogsDir = fs.realpathSync(logsDir);
  if (!pathInside(realRunDir, realLogsDir)) {
    throw new Error(`validation logs directory escaped runDir: ${logsDir}`);
  }
  return { workdir: realWorkdir, runDir: realRunDir, logsDir: realLogsDir };
}

function normalizeTimeout(value) {
  const timeoutMs = value === undefined ? DEFAULT_TIMEOUT_MS : value;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`validation timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function normalizeAttemptId(value) {
  const attemptId = value === undefined
    ? `${Date.now()}-${process.pid}`
    : String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(attemptId)) {
    throw new Error('validation attemptId must be a safe identifier');
  }
  return attemptId;
}

function normalizeCommands(value) {
  if (!Array.isArray(value)) throw new Error('validation commands must be an array');
  if (value.length > MAX_COMMANDS) {
    throw new Error(`validation commands cannot exceed ${MAX_COMMANDS} entries`);
  }
  return value.map((command, index) => {
    if (typeof command !== 'string') {
      throw new Error(`validation command ${index} must be a string`);
    }
    return command;
  });
}

function writeJson(file, value) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new Error(`refusing to replace symbolic-link validation artifact: ${file}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeLogEvidence(runDir, file, output) {
  const persisted = redactSensitiveText(String(output || ''));
  fs.writeFileSync(file, persisted, { encoding: 'utf8', flag: 'wx' });
  return {
    ref: normalizeRef(path.relative(runDir, file)),
    hash: hashText(persisted),
    bytes: Buffer.byteLength(persisted, 'utf8'),
    redacted: true,
  };
}

function errorMessage(error) {
  if (!error) return null;
  const prefix = error.code ? `${error.code}: ` : '';
  return redactSensitiveText(`${prefix}${error.message || String(error)}`);
}

function baseCommandRecord(index, decision, status, reason = null) {
  return {
    index,
    command: redactSensitiveText(decision.command),
    policy: redactArtifactValue(decision),
    argv: redactArtifactValue(decision.argv || []),
    status,
    startedAt: null,
    finishedAt: null,
    timeoutMs: null,
    exitStatus: null,
    signal: null,
    timedOut: false,
    error: reason ? redactSensitiveText(reason) : null,
    stdout: null,
    stderr: null,
  };
}

function writeAggregate(runDir, record) {
  // integration-validation.json is the latest projection; per-attempt logs remain immutable.
  writeJson(path.join(runDir, 'integration-validation.json'), record);
  return record;
}

function runValidationCommands(commandsValue, options = {}) {
  const commands = normalizeCommands(commandsValue);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const attemptId = normalizeAttemptId(options.attemptId);
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  if (typeof spawnSyncImpl !== 'function') throw new Error('validation spawnSyncImpl must be a function');
  const { workdir, runDir, logsDir } = resolveDirectories(options.workdir, options.runDir);

  const startedAt = now();
  const decisions = commands.map((command) => (
    validationPolicy.validateGeneratedValidationCommand(command, { workdir })
  ));
  const rejected = decisions.some((decision) => !decision.ok);

  if (rejected) {
    const records = decisions.map((decision, index) => (
      decision.ok
        ? baseCommandRecord(index, decision, 'not-run', 'validation batch blocked by policy preflight')
        : baseCommandRecord(index, decision, 'blocked', decision.reason)
    ));
    return writeAggregate(runDir, {
      schemaVersion: 'integration-validation-v1',
      attemptId,
      status: 'blocked',
      startedAt,
      finishedAt: now(),
      generatedAt: now(),
      timeoutMs,
      artifactRef: 'integration-validation.json',
      commands: records,
    });
  }

  if (decisions.length === 0) {
    return writeAggregate(runDir, {
      schemaVersion: 'integration-validation-v1',
      attemptId,
      status: 'skipped',
      startedAt,
      finishedAt: now(),
      generatedAt: now(),
      timeoutMs,
      artifactRef: 'integration-validation.json',
      commands: [],
    });
  }

  const records = [];
  let aggregateStatus = 'passed';
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index];
    if (aggregateStatus !== 'passed') {
      records.push(baseCommandRecord(
        index,
        decision,
        'not-run',
        'validation command not run because a prior command failed'
      ));
      continue;
    }

    const commandStartedAt = now();
    let result;
    try {
      result = spawnSyncImpl(decision.argv[0], decision.argv.slice(1), {
        cwd: workdir,
        encoding: 'utf8',
        env: options.env || process.env,
        maxBuffer: MAX_BUFFER,
        shell: false,
        timeout: timeoutMs,
        windowsHide: true,
      });
    } catch (error) {
      result = { status: null, signal: null, stdout: '', stderr: '', error };
    }
    result = result || { status: null, signal: null, stdout: '', stderr: '' };
    const commandFinishedAt = now();
    const stdoutFile = path.join(
      logsDir,
      `integration-validation-${attemptId}-${index}.stdout.log`
    );
    const stderrFile = path.join(
      logsDir,
      `integration-validation-${attemptId}-${index}.stderr.log`
    );
    const stdout = writeLogEvidence(runDir, stdoutFile, result.stdout);
    const stderr = writeLogEvidence(runDir, stderrFile, result.stderr);
    const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
    const exitStatus = Number.isInteger(result.status) ? result.status : null;
    let status = 'passed';
    if (timedOut) status = 'timeout';
    else if (result.error) status = 'launch-error';
    else if (exitStatus !== 0) status = 'failed';

    records.push({
      ...baseCommandRecord(index, decision, status),
      startedAt: commandStartedAt,
      finishedAt: commandFinishedAt,
      timeoutMs,
      exitStatus,
      signal: result.signal || null,
      timedOut,
      error: errorMessage(result.error),
      stdout,
      stderr,
    });
    if (status !== 'passed') aggregateStatus = 'failed';
  }

  return writeAggregate(runDir, {
    schemaVersion: 'integration-validation-v1',
    attemptId,
    status: aggregateStatus,
    startedAt,
    finishedAt: now(),
    generatedAt: now(),
    timeoutMs,
    artifactRef: 'integration-validation.json',
    commands: records,
  });
}

function runValidationCommand(command, options = {}) {
  return runValidationCommands([command], options);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_BUFFER,
  MAX_COMMANDS,
  MAX_TIMEOUT_MS,
  hashText,
  runValidationCommand,
  runValidationCommands,
};
