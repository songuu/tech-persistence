#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { redactSensitiveText, redactArtifactValue } = require('./lib/redaction');
const policyGates = require('./agent-orchestrator/policy-gates');
const validationCommandPolicy = require('./agent-orchestrator/validation-command-policy');
const providerProfiles = require('./agent-orchestrator/provider-profiles');
const runtimeAdapters = require('./agent-orchestrator/runtime-adapters');
const nativeExecutionControl = require('./agent-orchestrator/native-execution-control');
const goalLease = require('./agent-orchestrator/goal-lease');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');
const runLock = require('./agent-orchestrator/run-lock');
const providerLifecycle = require('./agent-orchestrator/provider-lifecycle');
const structuredOutput = require('./agent-orchestrator/structured-output');
const operatorReviewPacket = require('./agent-orchestrator/operator-review-packet');
const turnTransaction = require('./agent-orchestrator/turn-transaction');

const pipeline = require('./agent-orchestrator/pipeline');
const pipelineState = require('./agent-orchestrator/pipeline-state');
const pipelineQueue = require('./agent-orchestrator/queue');
const pipelineLocks = require('./agent-orchestrator/locks');
const globalContractModule = require('./agent-orchestrator/global-contract');
const slicePlannerModule = require('./agent-orchestrator/slice-planner');
const sliceRunnerModule = require('./agent-orchestrator/slice-runner');
const sliceNormalizerModule = require('./agent-orchestrator/slice-normalizer');
const driftDetectorModule = require('./agent-orchestrator/drift-detector');
const reconciliationModule = require('./agent-orchestrator/reconciliation');
const reviewModule = require('./agent-orchestrator/review');
const clarifications = require('./lib/clarifications');

const VERSION = 'v7';
const DEFAULT_RUNS_DIR = '.agent-runs';
const MAX_BUFFER = 64 * 1024 * 1024;
const REVIEW_CONTEXT_MAX_BYTES = 200 * 1024;
const INLINE_FILE_DIFF_MAX_BYTES = 96 * 1024;
const STATUS_ARTIFACT_MAX_BYTES = 256 * 1024;

const PROVIDERS = {
  spec: 'claude',
  implementation: 'codex',
  review: 'claude',
};

const DEFAULT_MANAGED_PREFIXES = [
  '.agent-runs/',
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  'coverage/',
];

const DEFAULT_DIFF_EXCLUDES = [
  '.agent-runs/**',
  'node_modules/**',
  '.next/**',
  'dist/**',
  'build/**',
  'coverage/**',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
];

const GENERATED_DIFF_OMIT_PATHS = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
]);

function nowIso() {
  return new Date().toISOString();
}

function dateStamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function logStamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '');
}

function stampedLogPath(runDir, label, suffix, stamp) {
  return path.join(runDir, 'logs', `${label}.${stamp}.${suffix}`);
}

function coalesce(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function providerTimeoutMs(options) {
  const explicitMs = optionValue(options, 'provider-timeout-ms') || optionValue(options, 'timeout-ms');
  if (explicitMs !== undefined && explicitMs !== true) {
    const parsed = Number(explicitMs);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const explicitMinutes = optionValue(options, 'provider-timeout-minutes') || optionValue(options, 'timeout-minutes');
  if (explicitMinutes !== undefined && explicitMinutes !== true) {
    const parsed = Number(explicitMinutes);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 60 * 1000;
  }

  return undefined;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function safeRead(file) {
  return fs.existsSync(file) ? readText(file) : '';
}

function writeText(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, redactSensitiveText(String(content)));
}

function writeJson(file, data) {
  writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writeCanonicalJson(file, data, options = undefined) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, options);
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function slugify(value) {
  return String(value || 'agent-loop')
    .toLowerCase()
    .replace(/[`"'<>]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'agent-loop';
}

function parseCli(argv) {
  const tokens = [...argv];
  const command = tokens[0] && !tokens[0].startsWith('-') ? tokens.shift() : 'run';
  const options = {};
  const positionals = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equalIndex = token.indexOf('=');
    if (equalIndex !== -1) {
      setOption(options, token.slice(2, equalIndex), token.slice(equalIndex + 1));
      continue;
    }

    const key = token.slice(2);
    const next = tokens[index + 1];
    if (next && !next.startsWith('--')) {
      setOption(options, key, next);
      index += 1;
    } else {
      setOption(options, key, true);
    }
  }

  return { command, options, positionals };
}

function setOption(options, key, value) {
  if (options[key] === undefined) {
    options[key] = value;
    return;
  }
  if (Array.isArray(options[key])) {
    options[key].push(value);
  } else {
    options[key] = [options[key], value];
  }
}

function optionValue(options, key) {
  const value = options[key];
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function optionValues(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === false) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

const BOOL_OPTION_ALIASES = {
  auto: ['auto', 'auto-evaluate', 'auto-freeze'],
  'auto-evaluate': ['auto', 'auto-evaluate', 'auto-freeze'],
  'auto-freeze': ['auto', 'auto-evaluate', 'auto-freeze'],
};

function boolOptionKeys(key) {
  return BOOL_OPTION_ALIASES[key] || [key];
}

function boolOption(options, key) {
  return boolOptionKeys(key).some((candidate) => {
    const value = optionValue(options, candidate);
    return value === true || value === 'true' || value === '1';
  });
}

function toolRoot() {
  return path.resolve(__dirname, '..');
}

function schemaPath(name) {
  return path.join(toolRoot(), 'schemas', 'agent-loop', name);
}

function schemaJson(name) {
  return JSON.stringify(readJson(schemaPath(name)));
}

function resolveWorkdir(options) {
  return path.resolve(optionValue(options, 'workdir') || process.cwd());
}

function resolveRunsDir(workdir, options) {
  return path.resolve(workdir, optionValue(options, 'runs-dir') || DEFAULT_RUNS_DIR);
}

function goalLeaseStoreOptions(options, providerRoot) {
  const controlRoot = optionValue(options, 'control-root');
  return {
    ...(controlRoot === undefined || controlRoot === true
      ? {}
      : { controlRoot: String(controlRoot) }),
    ...(providerRoot ? { providerRoot: path.resolve(providerRoot) } : {}),
  };
}

function latestRunDir(runsDir) {
  if (!fs.existsSync(runsDir)) return null;
  const candidates = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runDir = path.join(runsDir, entry.name);
      const statePath = path.join(runDir, 'state.json');
      if (!fs.existsSync(statePath)) return null;
      return { runDir, mtimeMs: fs.statSync(statePath).mtimeMs };
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0] ? candidates[0].runDir : null;
}

function resolveRunDir(options, positionals = []) {
  const workdir = resolveWorkdir(options);
  const runsDir = resolveRunsDir(workdir, options);
  const requested = optionValue(options, 'run') || optionValue(options, 'run-id') || positionals[0] || 'latest';

  if (requested === 'latest') {
    const latest = latestRunDir(runsDir);
    if (!latest) throw new Error(`No agent-loop runs found in ${runsDir}`);
    return latest;
  }

  const direct = path.resolve(workdir, requested);
  if (fs.existsSync(path.join(direct, 'state.json'))) return direct;

  const byId = path.join(runsDir, requested);
  if (fs.existsSync(path.join(byId, 'state.json'))) return byId;

  throw new Error(`Run not found: ${requested}`);
}

function applyStateDefaults(state) {
  // ADR-008: persistent state may pre-date current field set. Default at the
  // deserialization boundary so every push/assign site can trust shape.
  // For null/primitive (e.g. state.json contains literal `null` from tampering),
  // throw rather than return a value that violates the post-condition — every
  // downstream callsite assumes state is an object.
  if (state === null || state === undefined || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`state.json must be a JSON object, got ${state === null ? 'null' : Array.isArray(state) ? 'array' : typeof state}`);
  }
  if (!Array.isArray(state.providerRuns)) state.providerRuns = [];
  if (!state.files || typeof state.files !== 'object' || Array.isArray(state.files)) state.files = {};
  return state;
}

function loadRun(options, positionals) {
  const runDir = resolveRunDir(options, positionals);
  const statePath = path.join(runDir, 'state.json');
  const state = applyStateDefaults(readJson(statePath));
  return { runDir, statePath, state };
}

function saveState(statePath, state) {
  state.updatedAt = nowIso();
  writeJson(statePath, state);
}

function readRequirement(options, positionals) {
  const requirementFile = optionValue(options, 'requirement-file');
  if (requirementFile) return readText(path.resolve(requirementFile)).trim();
  const requirement = optionValue(options, 'requirement');
  if (requirement) return String(requirement).trim();
  const joined = positionals.join(' ').trim();
  if (joined) return joined;
  throw new Error('Missing requirement. Use --requirement "..." or --requirement-file path.');
}

function isWindows() {
  return process.platform === 'win32';
}

function splitCommandLine(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }
  return tokens;
}

function providerCommandSpec(options, key) {
  const explicit = optionValue(options, `${key}-command`);
  if (explicit) return explicit;

  const specificEnv = process.env[`AGENT_LOOP_${key.toUpperCase()}_COMMAND`];
  if (specificEnv) return specificEnv;

  if (key === 'implementation') {
    return optionValue(options, 'codex-command')
      || process.env.AGENT_LOOP_CODEX_COMMAND
      || PROVIDERS.implementation;
  }

  return optionValue(options, 'claude-command')
    || process.env.AGENT_LOOP_CLAUDE_COMMAND
    || PROVIDERS[key];
}

function resolveProviderLaunch(commandSpec) {
  const parts = splitCommandLine(commandSpec);
  const requestedCommand = parts[0] || commandSpec || '';
  const requestedArgs = parts.slice(1);
  if (!requestedCommand) throw new Error('Provider command is empty');

  if (!isWindows()) {
    return {
      command: requestedCommand,
      argsPrefix: requestedArgs,
      shell: false,
      requested: commandSpec,
      resolvedFrom: 'direct',
    };
  }

  const candidates = findWindowsCommandCandidates(requestedCommand);
  const checked = [];
  for (const candidate of candidates) {
    checked.push(candidate);
    const ext = path.extname(candidate).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      const shim = resolveWindowsShim(candidate);
      if (shim) {
        return {
          ...shim,
          argsPrefix: [...shim.argsPrefix, ...requestedArgs],
          requested: commandSpec,
          checked,
        };
      }
      return {
        command: candidate,
        argsPrefix: requestedArgs,
        shell: true,
        requested: commandSpec,
        resolvedFrom: 'windows-shim-shell-fallback',
        checked,
      };
    }
    if (ext === '.exe') {
      return {
        command: candidate,
        argsPrefix: requestedArgs,
        shell: false,
        requested: commandSpec,
        resolvedFrom: 'windows-executable',
        checked,
      };
    }
  }

  return {
    command: requestedCommand,
    argsPrefix: requestedArgs,
    shell: false,
    requested: commandSpec,
    resolvedFrom: 'direct-unresolved',
    checked,
  };
}

function findWindowsCommandCandidates(command) {
  const candidates = [];
  const add = (candidate) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };

  if (/[\\/]/.test(command) || path.isAbsolute(command)) {
    add(path.resolve(command));
    if (!path.extname(command)) {
      add(path.resolve(`${command}.exe`));
      add(path.resolve(`${command}.cmd`));
      add(path.resolve(`${command}.bat`));
    }
    return candidates.filter((candidate) => fs.existsSync(candidate));
  }

  const where = spawnSync('where.exe', [command], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  if (where.status === 0) {
    for (const line of (where.stdout || '').split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) add(candidate);
    }
  }

  return candidates
    .filter((candidate) => {
      const ext = path.extname(candidate).toLowerCase();
      return ext === '.cmd' || ext === '.bat' || ext === '.exe';
    })
    .filter((candidate) => fs.existsSync(candidate));
}

function resolveWindowsShim(shimPath) {
  const shimDir = path.dirname(shimPath);
  const content = safeRead(shimPath);
  if (!content) return null;

  const dp0Targets = [...content.matchAll(/"%dp0%\\([^"]+\.(exe|js))"/gi)]
    .map((match) => ({
      absolutePath: path.join(shimDir, match[1]),
      ext: `.${match[2].toLowerCase()}`,
    }))
    .filter((target) => fs.existsSync(target.absolutePath));

  const executableTarget = dp0Targets.find((target) => target.ext === '.exe');
  if (executableTarget) {
    return {
      command: executableTarget.absolutePath,
      argsPrefix: [],
      shell: false,
      resolvedFrom: 'windows-npm-shim-exe',
      shimPath,
    };
  }

  const scriptTarget = dp0Targets.find((target) => target.ext === '.js');
  if (scriptTarget) {
    return {
      command: resolveNodeExecutable(shimDir),
      argsPrefix: [scriptTarget.absolutePath],
      shell: false,
      resolvedFrom: 'windows-npm-shim-node-script',
      shimPath,
    };
  }

  return null;
}

function resolveNodeExecutable(shimDir) {
  const localNode = path.join(shimDir, 'node.exe');
  if (fs.existsSync(localNode)) return localNode;
  const candidates = findWindowsCommandCandidates('node');
  return candidates.find((candidate) => path.extname(candidate).toLowerCase() === '.exe') || 'node';
}

function resolveClaudeGitBash() {
  const fromEnv = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return { path: fromEnv, source: 'env' };
  }

  if (!isWindows()) return { path: null, source: 'not-windows' };

  const candidates = [
    'C:\\Apps\\Git\\usr\\bin\\bash.exe',
    'C:\\Apps\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { path: candidate, source: 'known-path' };
  }

  const pathCandidate = findWindowsCommandCandidates('bash')
    .find((candidate) => /\\Git\\(usr\\bin|bin)\\bash\.exe$/i.test(candidate));
  if (pathCandidate) return { path: pathCandidate, source: 'path' };

  return { path: null, source: fromEnv ? 'env-missing' : 'missing' };
}

function claudeProviderEnv() {
  const resolved = resolveClaudeGitBash();
  if (resolved.path && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    return { CLAUDE_CODE_GIT_BASH_PATH: resolved.path };
  }
  return {};
}

function runProcess(label, launchOrCommand, args, settings) {
  const launch = typeof launchOrCommand === 'string'
    ? resolveProviderLaunch(launchOrCommand)
    : launchOrCommand;
  const finalArgs = [...(launch.argsPrefix || []), ...args];
  const timeoutMs = settings.timeoutMs || 30 * 60 * 1000;
  const startedAt = nowIso();
  const result = spawnSync(launch.command, finalArgs, {
    cwd: settings.cwd,
    encoding: 'utf8',
    env: settings.env ? { ...process.env, ...settings.env } : process.env,
    input: settings.stdin,
    maxBuffer: MAX_BUFFER,
    shell: launch.shell === true,
    timeout: timeoutMs,
  });
  const finishedAt = nowIso();

  if (settings.stdoutFile) writeText(settings.stdoutFile, result.stdout || '');
  if (settings.stderrFile) writeText(settings.stderrFile, result.stderr || '');

  const record = {
    label,
    requestedCommand: launch.requested || launch.command,
    command: launch.command,
    args: finalArgs,
    cwd: settings.cwd,
    shell: launch.shell === true,
    resolvedFrom: launch.resolvedFrom || 'direct',
    shimPath: launch.shimPath || null,
    startedAt,
    finishedAt,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdoutFile: settings.stdoutFile || null,
    stderrFile: settings.stderrFile || null,
    stdinBytes: settings.stdin ? Buffer.byteLength(settings.stdin, 'utf8') : 0,
    phase: settings.phase || null,
    providerKey: settings.providerKey || null,
    runtime: settings.runtime || null,
    adapter: settings.adapter || null,
    profileId: settings.providerKey ? providerProfiles.profileId(settings.options || {}, settings.providerKey) : null,
    capabilitySnapshot: settings.capabilitySnapshot
      || (settings.providerKey
        ? providerProfiles.capabilitySnapshot(settings.options || {}, settings.providerKey)
        : null),
    taskEnvelopeHash: settings.taskEnvelopeHash || null,
    routeDecisionHash: settings.routeDecisionHash || null,
    promptHash: settings.stdin ? ('sha256:' + crypto.createHash('sha256').update(settings.stdin).digest('hex')) : null,
    executionFingerprint: providerProfiles.hash({ phase: settings.phase || null, providerKey: settings.providerKey || null, adapter: settings.adapter || null, command: launch.requested || launch.command, args: finalArgs, prompt: settings.stdin || '', schemaPath: settings.schemaPath || null }),
    schemaPath: settings.schemaPath || null,
    usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null },
    timeoutMs,
    envOverrides: settings.env || null,
  };

  function failWithRecord(message, kind) {
    let failure = null;
    if (typeof settings.onFailure === 'function') {
      try {
        failure = settings.onFailure({
          kind,
          message,
          record,
          result,
        }) || null;
      } catch (persistenceError) {
        record.failurePersistenceError = persistenceError.message;
        message = `${message}; failed to persist provider failure: ${persistenceError.message}`;
      }
    }
    const error = new Error(message);
    error.providerRecord = record;
    if (failure && failure.providerRecovery) {
      error.providerRecovery = failure.providerRecovery;
    }
    throw error;
  }

  if (result.error && result.error.code === 'ETIMEDOUT') {
    failWithRecord(
      `${label} timed out after ${timeoutMs}ms; see ${settings.stdoutFile || 'stdout'} and ${settings.stderrFile || 'stderr'}`,
      'timeout'
    );
  }
  if (result.error) {
    failWithRecord(`${label} failed to start: ${result.error.message}`, 'launch-error');
  }
  if (!settings.allowFailure && result.status !== 0) {
    const envelopeError = extractProviderEnvelopeError(result.stdout || '');
    const stderrPath = settings.stderrFile || 'stderr';
    const stdoutPath = settings.stdoutFile || 'stdout';
    const where = envelopeError
      ? `stdout: ${stdoutPath}`
      : `stderr: ${stderrPath} / stdout: ${stdoutPath}`;
    const reason = envelopeError ? ` — ${envelopeError}` : '';
    failWithRecord(
      `${label} exited with ${result.status}${reason}; see ${where}`,
      'nonzero-exit'
    );
  }
  return { result, record };
}

function extractProviderEnvelopeError(stdoutText) {
  if (!stdoutText || typeof stdoutText !== 'string') return null;
  const trimmed = stdoutText.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      if (parsed.is_error === true || typeof parsed.api_error_status !== 'undefined') {
        const apiStatus = parsed.api_error_status ? `[api ${parsed.api_error_status}] ` : '';
        const msg = typeof parsed.result === 'string' && parsed.result.trim()
          ? parsed.result.trim()
          : (parsed.error && (parsed.error.message || parsed.error)) || 'provider returned error envelope';
        return `${apiStatus}${msg}`;
      }
      if (parsed.error && (parsed.error.message || typeof parsed.error === 'string')) {
        return typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
      }
    }
  } catch (_) { /* not JSON, fall through */ }
  return null;
}

function runValidatedCommand(label, decision, settings) {
  const startedAt = nowIso();
  const result = spawnSync(decision.argv[0], decision.argv.slice(1), { cwd: settings.cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, shell: false, timeout: settings.timeoutMs || 30 * 60 * 1000 });
  const finishedAt = nowIso();
  if (settings.stdoutFile) writeText(settings.stdoutFile, result.stdout || '');
  if (settings.stderrFile) writeText(settings.stderrFile, result.stderr || '');
  return { command: decision.command, argv: decision.argv, policy: decision, status: result.status, startedAt, finishedAt };
}

function runShell(label, command, settings) {
  const startedAt = nowIso();
  const result = spawnSync(command, {
    cwd: settings.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: true,
    timeout: settings.timeoutMs || 30 * 60 * 1000,
  });
  const finishedAt = nowIso();

  if (settings.stdoutFile) writeText(settings.stdoutFile, result.stdout || '');
  if (settings.stderrFile) writeText(settings.stderrFile, result.stderr || '');

  return {
    label,
    command,
    cwd: settings.cwd,
    startedAt,
    finishedAt,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdoutFile: settings.stdoutFile || null,
    stderrFile: settings.stderrFile || null,
  };
}

function extractJsonValue(text) {
  const parsed = parseJsonFromText(text);
  return unwrapAgentJson(parsed);
}

function parseJsonFromText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty output');

  const direct = tryParseJson(trimmed);
  if (direct.ok) return direct.value;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed.ok) return parsed.value;
  }

  const extracted = findFirstJson(trimmed);
  if (extracted) {
    const parsed = tryParseJson(extracted);
    if (parsed.ok) return parsed.value;
  }

  throw new Error('Could not parse JSON from agent output');
}

function tryParseJson(value) {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error };
  }
}

function unwrapAgentJson(value, depth = 0) {
  if (depth > 5) return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.text === 'string') return item.text;
        if (item && typeof item.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return unwrapAgentJson(parseJsonFromText(text), depth + 1);
    return value;
  }

  if (value && typeof value === 'object') {
    const candidates = [
      value.result,
      value.content,
      value.message && value.message.content,
      value.output,
      value.response,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        try {
          return unwrapAgentJson(parseJsonFromText(candidate), depth + 1);
        } catch (error) {
          continue;
        }
      }
      if (Array.isArray(candidate)) {
        try {
          return unwrapAgentJson(candidate, depth + 1);
        } catch (error) {
          continue;
        }
      }
      if (candidate && typeof candidate === 'object') {
        return unwrapAgentJson(candidate, depth + 1);
      }
    }
  }

  return value;
}

function findFirstJson(text) {
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== '{' && first !== '[') continue;
    const close = first === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === first) {
        depth += 1;
      } else if (char === close) {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function toArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function stringArray(value) {
  return toArray(value).map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item.message === 'string') return item.message;
    if (item && typeof item.title === 'string') return item.title;
    return JSON.stringify(item);
  }).filter(Boolean);
}

function normalizeClarifications(value) {
  return toArray(value)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const assumption = String(item.assumption || '').trim();
      const question = String(item.question || item.ambiguity || '').trim();
      if (!assumption && !question) return null;
      const entry = { assumption, question };
      if (typeof item.id === 'string' && item.id.trim()) entry.id = item.id.trim();
      return entry;
    })
    .filter(Boolean);
}

function normalizeClarificationRulings(value) {
  const allowed = new Set(['confirm-assumption', 'revise-spec']);
  return toArray(value)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const id = String(item.id || '').trim();
      if (!id) return null;
      const decision = allowed.has(item.decision) ? item.decision : 'confirm-assumption';
      const ruling = { id, decision };
      if (typeof item.note === 'string' && item.note.trim()) ruling.note = item.note.trim();
      return ruling;
    })
    .filter(Boolean);
}

function normalizeTaskContainer(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return coalesce(value.tasks, value.taskBreakdown, value.items, value.steps, value.children, []);
  }
  return value;
}

function normalizeSpec(rawSpec) {
  const raw = rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
  const rawPlan = raw.plan && typeof raw.plan === 'object' ? raw.plan : {};
  const rawRequirement = coalesce(
    raw.requirementSpec,
    raw.requirements,
    raw.requirement,
    rawPlan.requirementSpec,
    rawPlan.requirements,
    rawPlan.requirement,
    {}
  );
  const rawDesign = coalesce(
    raw.technicalDesign,
    raw.design,
    raw.technical,
    rawPlan.technicalDesign,
    rawPlan.design,
    rawPlan.technical,
    {}
  );
  const rawTasks = normalizeTaskContainer(coalesce(
    raw.taskBreakdown,
    raw.tasks,
    raw.implementationTasks,
    rawPlan.taskBreakdown,
    rawPlan.tasks,
    rawPlan.implementationTasks,
    []
  ));

  const requirementSpec = {
    summary: String(rawRequirement.summary || raw.summary || rawPlan.summary || ''),
    userValue: String(rawRequirement.userValue || rawRequirement.value || raw.userValue || rawPlan.userValue || ''),
    scope: stringArray(rawRequirement.scope || raw.scope || rawPlan.scope),
    acceptanceCriteria: stringArray(
      rawRequirement.acceptanceCriteria
      || rawRequirement.acceptance
      || raw.acceptanceCriteria
      || raw.acceptance
      || rawPlan.acceptanceCriteria
      || rawPlan.acceptance
    ),
  };

  const technicalDesign = {
    approach: String(rawDesign.approach || rawDesign.summary || raw.approach || rawPlan.approach || ''),
    files: stringArray(rawDesign.files || rawDesign.changedFiles || raw.files || rawPlan.files),
    interfaces: stringArray(rawDesign.interfaces || raw.interfaces || rawPlan.interfaces),
    dataAndState: String(rawDesign.dataAndState || rawDesign.state || raw.dataAndState || rawPlan.dataAndState || ''),
    risks: stringArray(rawDesign.risks || raw.risks || rawPlan.risks),
    testStrategy: rawDesign.testStrategy || raw.testStrategy || rawPlan.testStrategy || '',
  };

  const taskBreakdown = toArray(rawTasks).map((task, index) => {
    const source = task && typeof task === 'object' ? task : { title: String(task || '') };
    return {
      id: String(source.id || `T${String(index + 1).padStart(2, '0')}`),
      title: String(source.title || source.name || source.summary || `Task ${index + 1}`),
      description: String(source.description || source.details || source.summary || ''),
      dependencies: stringArray(source.dependencies || source.dependsOn),
      risk: normalizeRisk(source.risk),
      doneCriteria: stringArray(source.doneCriteria || source.acceptanceCriteria || source.acceptance),
      suggestedValidation: stringArray(source.suggestedValidation || source.validation),
    };
  });

  return {
    requirementSpec,
    technicalDesign,
    taskBreakdown,
    assumptions: stringArray(raw.assumptions || rawPlan.assumptions),
    outOfScope: stringArray(raw.outOfScope || raw.nonGoals || rawPlan.outOfScope || rawPlan.nonGoals),
    questions: stringArray(raw.questions || raw.openQuestions || rawPlan.questions || rawPlan.openQuestions),
    humanReviewChecklist: stringArray(raw.humanReviewChecklist || raw.reviewChecklist || rawPlan.humanReviewChecklist || rawPlan.reviewChecklist),
  };
}

function normalizeRisk(value) {
  const risk = String(value || 'L2').toUpperCase();
  return ['L0', 'L1', 'L2', 'L3', 'L4'].includes(risk) ? risk : 'L2';
}

function normalizeHandoff(rawHandoff) {
  const raw = rawHandoff && typeof rawHandoff === 'object' ? rawHandoff : {};
  return {
    summary: String(raw.summary || raw.result || raw.message || ''),
    changedFiles: stringArray(raw.changedFiles || raw.files),
    validation: stringArray(raw.validation || raw.validations || raw.tests),
    risks: stringArray(raw.risks || raw.warnings),
    followUp: stringArray(raw.followUp || raw.followUpTasks || raw.nextSteps),
    clarifications: normalizeClarifications(raw.clarifications || raw.questions),
  };
}

function normalizeReview(rawReview) {
  const raw = rawReview && typeof rawReview === 'object' ? rawReview : {};
  const issues = toArray(raw.issues || raw.findings);
  const warnings = toArray(raw.warnings);
  const findings = issues.map(normalizeFinding).filter(Boolean);
  const warningFindings = warnings.map((warning) => normalizeFinding(warning, 'P2')).filter(Boolean);
  const allFindings = [...findings, ...warningFindings];
  const status = String(raw.status || raw.decision || '').toLowerCase();
  const explicitDecision = String(raw.decision || '').toLowerCase();
  const summary = String(raw.summary || raw.reviewSummary || raw.message || raw.result || '');
  const summarySignal = summary.trim().toLowerCase();
  const hasApprovedSummary = /^(approved|pass|passed)(\b|[\s:._-])/.test(summarySignal);
  const hasBlockingFinding = allFindings.some((finding) => finding.severity === 'P0');
  const issueCount = findings.length;

  let decision = 'changes_requested';
  if (explicitDecision === 'blocked' || status === 'blocked' || hasBlockingFinding) {
    decision = 'blocked';
  } else if (raw.compliant === true || explicitDecision === 'approved') {
    decision = 'approved';
  } else if (
    ['passed', 'pass', 'approved'].includes(status)
    && raw.canMerge !== false
    && issueCount === 0
  ) {
    decision = 'approved';
  } else if (hasApprovedSummary && raw.canMerge !== false && issueCount === 0) {
    decision = 'approved';
  } else if (raw.canMerge === true && issueCount === 0) {
    decision = 'approved';
  } else if (explicitDecision === 'changes_requested') {
    decision = 'changes_requested';
  }

  return {
    decision,
    compliant: decision === 'approved',
    summary,
    findings: allFindings,
    followUpTasks: stringArray(raw.followUpTasks || raw.followUp || raw.requiredChanges),
    clarificationRulings: normalizeClarificationRulings(raw.clarificationRulings || raw.rulings),
  };
}

function normalizeFinding(value, fallbackSeverity = 'P1') {
  if (!value) return null;
  if (typeof value === 'string') {
    return { severity: fallbackSeverity, message: value };
  }
  const severity = normalizeSeverity(value.severity || value.priority || fallbackSeverity);
  return {
    severity,
    file: value.file || value.path || undefined,
    line: Number.isInteger(value.line) ? value.line : undefined,
    message: String(value.message || value.summary || value.title || ''),
    requiredFix: value.requiredFix || value.fix || undefined,
  };
}

function normalizeSeverity(value) {
  const severity = String(value || '').toUpperCase();
  if (['P0', 'CRITICAL', 'BLOCKER', 'BLOCKING'].includes(severity)) return 'P0';
  if (['P2', 'MINOR', 'LOW', 'WARNING'].includes(severity)) return 'P2';
  return 'P1';
}

function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) errors.push('spec must be an object');
  if (!spec.requirementSpec) errors.push('missing requirementSpec');
  if (!spec.technicalDesign) errors.push('missing technicalDesign');
  if (!Array.isArray(spec.taskBreakdown) || spec.taskBreakdown.length === 0) {
    errors.push('taskBreakdown must be a non-empty array');
  }
  if (spec.requirementSpec && !Array.isArray(spec.requirementSpec.acceptanceCriteria)) {
    errors.push('requirementSpec.acceptanceCriteria must be an array');
  }
  return errors;
}

function statusFromReview(review, completionGate = { ok: true }) {
  if (review.decision === 'approved' && review.compliant === true) return completionGate.ok ? 'completed' : 'needs-followup';
  if (review.decision === 'blocked' || review.findings.some((finding) => finding.severity === 'P0')) {
    return 'blocked';
  }
  return 'needs-followup';
}

function buildSpecPrompt(requirement, options) {
  return [
    'You are the analysis and design provider in Tech Persistence agent-loop v7.',
    'Do not implement code. Produce a frozen contract for a separate implementation provider.',
    'Return JSON only. Match the schema exactly enough for automated parsing.',
    'Use Chinese when the requirement is Chinese. Keep task ids stable and ASCII.',
    '',
    'Architecture principles:',
    '- The analysis provider owns requirementSpec, technicalDesign, and taskBreakdown.',
    '- The implementation provider must not reinterpret requirements.',
    '- Human review freezes the spec before implementation.',
    '- The review provider checks implementation against the frozen spec.',
    '',
    'Output contract:',
    '- Return one top-level JSON object only; do not wrap it in Markdown.',
    '- taskBreakdown must be a top-level Task[] array, not { "tasks": [...] }.',
    '- Each task must include id, title, description, dependencies, risk, doneCriteria, and suggestedValidation.',
    '- Use this exact top-level shape: { "requirementSpec": {...}, "technicalDesign": {...}, "taskBreakdown": [...], "assumptions": [...], "outOfScope": [...], "questions": [...], "humanReviewChecklist": [...] }.',
    '',
    `Repository root: ${options.workdir}`,
    '',
    'Original requirement:',
    requirement,
  ].join('\n');
}

function buildImplementationPrompt(state, runDir) {
  const spec = readText(path.join(runDir, 'spec.json'));
  const design = safeRead(path.join(runDir, 'technical-design.md'));
  const tasks = safeRead(path.join(runDir, 'task-breakdown.json'));
  const reviewNotes = safeRead(path.join(runDir, 'review.json'));
  const priorRulings = readPriorRulingsBlock(runDir);
  return [
    'You are the implementation provider in Tech Persistence agent-loop v7.',
    'Implement only the frozen spec. Do not reinterpret or expand requirements.',
    'If the spec is ambiguous: adopt the smallest safe assumption, KEEP IMPLEMENTING (do not block),',
    'and record the ambiguity in handoff.clarifications[] as { assumption, question }.',
    'The spec-writer will rule on each clarification at the next review gate.',
    'Honor any prior clarification rulings listed below.',
    'Follow the repository style and keep changes scoped.',
    'Return JSON only. Match the handoff schema.',
    '',
    `Run id: ${state.runId}`,
    `Repository root: ${state.workdir}`,
    '',
    'Frozen spec JSON:',
    spec,
    '',
    'Technical design markdown:',
    design,
    '',
    'Task breakdown JSON:',
    tasks,
    priorRulings ? `\nPrior clarification rulings (honor these):\n${priorRulings}` : '',
    reviewNotes ? `\nPrior review notes JSON:\n${reviewNotes}` : '',
  ].filter(Boolean).join('\n');
}

function readPriorRulingsBlock(runDir) {
  const ruled = clarifications.readClarifications(runDir).filter((entry) => entry.status === 'ruled');
  if (ruled.length === 0) return '';
  return ruled
    .map((entry) => `- ${entry.id} [${entry.decision}] assumption: ${entry.assumption}${entry.note ? ` — ruling: ${entry.note}` : ''}`)
    .join('\n');
}

function readOpenClarificationsBlock(runDir) {
  const open = clarifications.listOpenClarifications(runDir);
  if (open.length === 0) return '';
  return open
    .map((entry) => `- ${entry.id} assumption: ${entry.assumption} | question: ${entry.question}`)
    .join('\n');
}

function buildReviewPrompt(state, runDir) {
  const reviewContextPath = path.join(runDir, 'review-context.md');
  const reviewContext = safeRead(reviewContextPath) || '(missing review context)';
  const openClarifications = readOpenClarificationsBlock(runDir);
  const clarificationGuidance = openClarifications
    ? [
      '',
      'Open clarifications raised by the implementer (rule on EACH one):',
      openClarifications,
      '',
      'For each open clarification, add an entry to clarificationRulings[]:',
      '- { id, decision: "confirm-assumption" } if the adopted assumption is acceptable.',
      '- { id, decision: "revise-spec", note } if the spec must change; ALSO add a finding/followUpTask',
      '  describing the required change so the orchestrator re-implements via the needs-followup loop.',
      '',
    ].join('\n')
    : '';
  return [
    'You are the review provider in Tech Persistence agent-loop v7.',
    'You are also the spec-writer: rule on any open clarifications raised by the implementer.',
    'Review the implementation strictly against the frozen spec and technical design.',
    'Do not add new product requirements. Return JSON only and match the review schema.',
    'If the diff context is truncated, inspect the repository files directly.',
    clarificationGuidance,
    `Run id: ${state.runId}`,
    `Repository root: ${state.workdir}`,
    `Review context file: ${reviewContextPath}`,
    '',
    'Frozen spec JSON:',
    readText(path.join(runDir, 'spec.json')),
    '',
    'Technical design markdown:',
    safeRead(path.join(runDir, 'technical-design.md')),
    '',
    'Review context markdown:',
    reviewContext,
    '',
    'Validation result JSON:',
    safeRead(path.join(runDir, 'validation.json')) || '{}',
    '',
    'Implementation handoff markdown:',
    safeRead(path.join(runDir, 'handoff.md')) || '(missing handoff)',
  ].join('\n');
}

function renderSpecMarkdown(spec) {
  const requirement = spec.requirementSpec || {};
  const design = spec.technicalDesign || {};
  return [
    '# Requirement Spec',
    '',
    '## Summary',
    requirement.summary || '',
    '',
    '## User Value',
    requirement.userValue || '',
    '',
    '## Scope',
    arrayLines(requirement.scope),
    '',
    '## Out Of Scope',
    arrayLines(spec.outOfScope),
    '',
    '## Acceptance Criteria',
    arrayLines(requirement.acceptanceCriteria || spec.acceptanceCriteria),
    '',
    '## Assumptions',
    arrayLines(spec.assumptions),
    '',
    '## Technical Approach',
    design.approach || '',
    '',
    '## Risks',
    arrayLines(design.risks),
    '',
    '## Test Strategy',
    typeof design.testStrategy === 'string'
      ? design.testStrategy
      : JSON.stringify(design.testStrategy || {}, null, 2),
    '',
  ].join('\n');
}

function renderTechnicalDesign(spec) {
  const design = spec.technicalDesign || {};
  return [
    '# Technical Design',
    '',
    '## Approach',
    design.approach || '',
    '',
    '## Files',
    arrayLines(design.files),
    '',
    '## Interfaces',
    arrayLines(design.interfaces),
    '',
    '## Data And State',
    design.dataAndState || '',
    '',
    '## Risks',
    arrayLines(design.risks),
    '',
    '## Test Strategy',
    typeof design.testStrategy === 'string'
      ? design.testStrategy
      : JSON.stringify(design.testStrategy || {}, null, 2),
    '',
  ].join('\n');
}

function arrayLines(value) {
  const items = toArray(value);
  if (items.length === 0) return '';
  return items.map((item) => {
    if (typeof item === 'string') return `- ${item}`;
    return `- ${JSON.stringify(item)}`;
  }).join('\n');
}

function writeSpecArtifacts(runDir, spec, rawSpec) {
  if (rawSpec) writeJson(path.join(runDir, 'spec.raw.json'), rawSpec);
  writeJson(path.join(runDir, 'spec.json'), spec);
  writeText(path.join(runDir, 'requirement-spec.md'), renderSpecMarkdown(spec));
  writeText(path.join(runDir, 'technical-design.md'), renderTechnicalDesign(spec));
  writeJson(path.join(runDir, 'task-breakdown.json'), spec.taskBreakdown || []);
}

function providerLaunch(options, key) {
  return resolveProviderLaunch(providerCommandSpec(options, key));
}

function codexSandboxMode(options) {
  const explicit = optionValue(options, 'codex-sandbox');
  if (explicit && explicit !== true && explicit !== 'default') return String(explicit);
  if (isWindows() && explicit !== 'default') return 'workspace-write';
  return null;
}

function nativeAdapterPolicy(options) {
  return nativeExecutionControl.adapterPolicy(options);
}

function claudePluginDirs(options, mode) {
  const explicit = optionValues(options, 'claude-plugin-dir');
  if (explicit.length > 0) return explicit.map((value) => path.resolve(value));
  return mode === 'bare'
    ? [path.join(toolRoot(), 'plugins', 'tech-persistence')]
    : [];
}

function buildClaudeProviderInvocation(
  options,
  providerKey,
  runDir,
  prompt,
  schemaName,
  workdir = resolveWorkdir(options),
  resumeRefs = {}
) {
  const policy = nativeAdapterPolicy(options);
  const selectedSchemaPath = boolOption(options, 'skip-cli-schema')
    ? null
    : schemaPath(schemaName);
  return runtimeAdapters.buildClaudeInvocation({
    launch: providerLaunch(options, providerKey),
    mode: policy.claude,
    cwd: workdir,
    prompt,
    schemaJson: selectedSchemaPath ? schemaJson(schemaName) : null,
    schemaPath: selectedSchemaPath,
    pluginDir: claudePluginDirs(options, policy.claude),
    settings: optionValue(options, 'claude-settings') || null,
    sessionId: resumeRefs.sessionId || null,
    env: {
      ...claudeProviderEnv(),
      TP_AGENT_RUN_DIR: path.resolve(runDir),
      TP_AGENT_RUNS_DIR: path.dirname(path.resolve(runDir)),
    },
  });
}

function buildCodexProviderInvocation(
  options,
  runDir,
  prompt,
  lastMessageFile,
  workdir = resolveWorkdir(options),
  resumeRefs = {}
) {
  const policy = nativeAdapterPolicy(options);
  if (policy.codex === 'app-server') {
    throw new Error(
      'Codex App Server is exposed as an experimental prepare-only adapter; '
      + 'agent-loop provider execution remains codex exec until the JSON-RPC canary is promoted.'
    );
  }
  const selectedSchemaPath = boolOption(options, 'skip-cli-schema')
    ? null
    : schemaPath('agent-handoff.schema.json');
  return runtimeAdapters.buildCodexInvocation({
    launch: providerLaunch(options, 'implementation'),
    mode: policy.codex,
    cwd: workdir,
    prompt,
    lastMessageFile,
    sandbox: codexSandboxMode(options),
    skipGitRepoCheck: !isGitRepository(workdir)
      || boolOption(options, 'skip-git-repo-check'),
    schemaPath: selectedSchemaPath,
    resumeThreadId: resumeRefs.threadId || null,
    allowExperimental: boolOption(options, 'allow-experimental-app-server'),
    env: {
      TP_AGENT_RUN_DIR: path.resolve(runDir),
      TP_AGENT_RUNS_DIR: path.dirname(path.resolve(runDir)),
    },
  });
}

function providerResumeRefs(state, runtime, providerKey, stage) {
  return providerLifecycle.providerResumeRefs(state && state.providerRecovery, {
    runtime,
    providerKey,
    stage,
  });
}

function safeStageName(value) {
  return String(value || 'provider')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'provider';
}

function appendProviderRunOnce(state, record) {
  if (!Array.isArray(state.providerRuns)) state.providerRuns = [];
  const duplicate = state.providerRuns.some((entry) => (
    entry.executionFingerprint === record.executionFingerprint
    && entry.startedAt === record.startedAt
  ));
  if (!duplicate) state.providerRuns.push(record);
}

function providerStep(kind, run) {
  try {
    return run();
  } catch (error) {
    if (error && !error.providerFailureKind) error.providerFailureKind = kind;
    throw error;
  }
}

function providerPostAcceptanceStep(kind, run) {
  try {
    return run();
  } catch (error) {
    if (error) {
      error.providerFailureKind = error.providerFailureKind || kind;
      error.providerAccepted = true;
    }
    throw error;
  }
}

function assertProviderStructuredOutput(value, schemaName, label, options = {}) {
  return providerStep('schema-validation', () => structuredOutput.assertStructuredOutput(value, {
    schemaRoot: path.join(toolRoot(), 'schemas', 'agent-loop'),
    schemaName,
    label,
    collectionProperty: options.collectionProperty,
  }));
}

function failProviderPostProcess(attempt, record, error, context = {}) {
  if (!error || error.providerFailurePersisted === true) return error;
  const runtimeResult = context.runtimeOutput
    || error.runtimeResult
    || null;
  const failure = {
    kind: error.providerFailureKind || context.kind || 'post-process',
    message: error.message || String(error),
    record,
    result: context.result || null,
    runtimeOutput: runtimeResult,
    runtimeRefs: runtimeAdapters.extractRecoveryRuntimeRefs(
      attempt.profile.runtime,
      {
        runtimeOutput: runtimeResult,
        runtimeResult,
        result: context.result,
        stdout: context.stdout,
        stderr: context.stderr,
        lastMessage: context.lastMessage,
      }
    ),
    providerAccepted: error.providerAccepted === true,
  };
  const persisted = attempt.onFailure(failure);
  error.providerFailurePersisted = true;
  error.providerRecord = error.providerRecord || record;
  if (persisted && persisted.providerRecovery) {
    error.providerRecovery = persisted.providerRecovery;
  }
  return error;
}

function runProviderPostProcess(attempt, record, context, run) {
  try {
    return run();
  } catch (error) {
    throw failProviderPostProcess(attempt, record, error, context);
  }
}

function persistProviderFailure(state, runDir, attempt, failure) {
  const postAcceptanceFailure = failure.providerAccepted === true;
  const typedResultRecorded = Boolean(
    attempt.turnControl
    && attempt.turnControl.receipt
    && attempt.turnControl.receipt.completedPhases.includes('typed-result')
  );
  const canonicalResultFile = path.join(attempt.contractDir, `${attempt.prefix}.result.json`);
  const canonicalAcceptanceFile = path.join(
    attempt.contractDir,
    `${attempt.prefix}.acceptance.json`
  );
  const canonicalArtifactsExist = fs.existsSync(canonicalResultFile)
    || fs.existsSync(canonicalAcceptanceFile);
  const canonicalResult = fs.existsSync(canonicalResultFile)
    ? readJson(canonicalResultFile)
    : null;
  const canonicalAcceptance = fs.existsSync(canonicalAcceptanceFile)
    ? readJson(canonicalAcceptanceFile)
    : null;
  const canonicalAccepted = Boolean(canonicalAcceptance && canonicalAcceptance.accepted === true);
  const preserveCanonical = postAcceptanceFailure || canonicalArtifactsExist;
  const failureArtifactSuffix = postAcceptanceFailure
    ? 'post-acceptance-failure'
    : (preserveCanonical
      ? 'acceptance-failure'
      : (typedResultRecorded ? `${safeStageName(failure.kind)}-failure` : null));
  const failureArtifactStem = failureArtifactSuffix
    ? `${attempt.prefix}.${failureArtifactSuffix}`
    : attempt.prefix;
  const afterSnapshot = captureWorktreeSnapshot(state.workdir, runDir);
  const effects = providerLifecycle.createEffectSnapshot(
    attempt.effectBaseline,
    afterSnapshot,
    { inheritedRecovery: state.providerRecovery }
  );
  const effectsFile = path.join(
    attempt.contractDir,
    `${failureArtifactStem}.effects.json`
  );
  writeCanonicalJson(effectsFile, effects);

  const runtimeRefs = runtimeAdapters.extractRecoveryRuntimeRefs(
    attempt.profile.runtime,
    {
      runtimeOutput: failure.runtimeOutput,
      runtimeResult: failure.runtimeOutput,
      runtimeRefs: failure.runtimeRefs,
      result: failure.result,
      stdout: failure.result && failure.result.stdout,
      stderr: failure.result && failure.result.stderr,
    }
  );
  const outcome = nativeExecutionControl.createAttemptResult({
    stageControl: attempt,
    ref: failureArtifactSuffix
      ? `result:${state.runId}:${attempt.prefix}:${failureArtifactSuffix}`
      : `result:${state.runId}:${attempt.prefix}`,
    status: 'failed',
    effects: {
      state: effects.state,
      refs: effects.refs,
    },
    runtimeRefs,
    evidence: {
      failureKind: failure.kind,
      effectsSnapshotHash: effects.snapshotHash,
      stdoutHash: providerProfiles.hash(safeRead(failure.record.stdoutFile)),
      stderrHash: providerProfiles.hash(safeRead(failure.record.stderrFile)),
    },
    payload: {
      message: failure.message,
      exitStatus: failure.record.status === null ? null : failure.record.status,
      signal: failure.record.signal || null,
    },
  });
  if (!preserveCanonical) {
    writeCanonicalJson(
      path.join(attempt.contractDir, `${attempt.prefix}.result.json`),
      outcome.result
    );
  }
  writeCanonicalJson(
    path.join(attempt.contractDir, `${failureArtifactStem}.result.json`),
    outcome.result
  );
  writeCanonicalJson(
    path.join(attempt.contractDir, `${failureArtifactStem}.acceptance.json`),
    outcome.acceptance
  );

  if (preserveCanonical) {
    const canonicalHash = canonicalResult && canonicalResult.hash || null;
    if (canonicalAccepted || postAcceptanceFailure) {
      failure.record.acceptedResultEnvelopeHash = canonicalHash
        || failure.record.resultEnvelopeHash
        || null;
    } else {
      failure.record.rejectedResultEnvelopeHash = canonicalHash;
    }
    failure.record.failureResultEnvelopeHash = outcome.result.hash;
    failure.record.postAcceptanceFailure = postAcceptanceFailure || canonicalAccepted;
    if (canonicalAcceptance) failure.record.acceptance = canonicalAcceptance;
  } else {
    failure.record.resultEnvelopeHash = outcome.result.hash;
    failure.record.acceptance = outcome.acceptance;
  }
  failure.record.failure = {
    kind: failure.kind,
    effectsState: effects.state,
    effectsSnapshotHash: effects.snapshotHash,
  };
  failure.record.runtimeRefs = runtimeRefs;
  appendProviderRunOnce(state, failure.record);

  const providerRecovery = providerLifecycle.providerRecoveryRecord({
    runId: state.runId,
    attempt,
    providerKey: attempt.lifecycle.providerKey,
    stage: attempt.lifecycle.stage,
    effects,
    runtimeRefs,
    failureKind: failure.kind,
    forceReconcile: failure.providerAccepted === true || canonicalAccepted,
  });
  if (providerRecovery) state.providerRecovery = providerRecovery;
  state.lastProviderFailure = {
    providerRef: attempt.providerRef,
    stage: attempt.lifecycle.stage,
    failedAt: nowIso(),
    resultHash: outcome.result.hash,
    effectsState: effects.state,
  };
  state.files.contracts = 'contracts';
  saveState(path.join(runDir, 'state.json'), state);
  return { outcome, effects, providerRecovery };
}

function recordAttemptTurnPhase(attempt, phase, payload) {
  if (!attempt.turnControl) {
    throw new Error(`turn control is missing for provider attempt ${attempt.prefix || '<unknown>'}`);
  }
  const recorded = turnTransaction.recordTurnPhase(
    attempt.turnControl.journalFile,
    {
      identity: attempt.turnControl.identity,
      turnKey: attempt.turnControl.turnKey,
      phase,
      payload,
    }
  );
  attempt.turnControl.receipt = recorded.receipt;
  return recorded;
}

function prepareProviderAttempt(state, runDir, options, input) {
  const stageName = safeStageName(input.stage);
  const stamp = input.stamp || logStamp();
  const capabilityEvidence = input.capabilityEvidence
    ? nativeExecutionControl.observedAdapterEvidence(
      input.providerKey,
      input.capabilityEvidence
    )
    : null;
  const effectBaseline = captureWorktreeSnapshot(state.workdir, runDir);
  const leaseStoreOptions = goalLeaseStoreOptions(options, state.workdir);
  const currentLease = goalLease.readGoalLease(runDir, leaseStoreOptions);
  const goalDispatchContext = {
    runId: state.runId,
    providerRuntime: null,
    orchestrationOwner: state.executionPolicy
      ? state.executionPolicy.orchestrationOwner
      : state.orchestrationOwner,
    objective: safeRead(path.join(runDir, 'requirement.md')).trim(),
  };
  const stageControl = nativeExecutionControl.buildStageControl({
    options,
    orchestrationOwner: state.orchestrationOwner
      || nativeExecutionControl.orchestrationOwner(options),
    runId: state.runId,
    stage: input.stage,
    taskRef: `task:${state.runId}:${stageName}:${stamp}`,
    providerKey: input.providerKey,
    intent: input.intent,
    coordination: input.coordination || {
      taskClass: 'provider-stage',
      actionKind: stageName,
      continuationPolicy: 'continue',
      successorRefs: [],
      noFollowUp: false,
      claimedBy: `provider:${input.providerKey}`,
    },
    payload: {
      promptHash: providerProfiles.hash(input.prompt || ''),
      schemaPath: input.schemaPath || null,
      contractHash: input.contractHash || null,
      effectBaselineHash: providerProfiles.hash(effectBaseline),
      goalLeaseRevision: currentLease && currentLease.revision || null,
    },
    runtimeRefs: input.runtimeRefs || {},
    capabilityEvidence,
  });
  if (stageControl.routeMode === 'enforce'
      && stageControl.route.status !== 'selected') {
    throw new Error(
      `native route blocked for ${input.stage}: ${JSON.stringify(stageControl.route.rejected)}`
    );
  }
  goalLease.validateGoalLeaseForDispatch(currentLease, {
    ...goalDispatchContext,
    providerRuntime: stageControl.profile.runtime,
  });
  const activeRecovery = nativeExecutionControl.validateProviderRecovery(
    state.providerRecovery,
    stageControl,
    {
      providerKey: input.providerKey,
      stage: input.stage,
    }
  );
  if (activeRecovery && activeRecovery.reconcileRequired === true) {
    throw new Error(
      `provider recovery requires reconciliation before redispatch: no native ${activeRecovery.runtime} resume ref was captured`
    );
  }
  const contractDir = path.join(runDir, 'contracts');
  const prefix = `${stageName}.${stamp}`;
  const turnIdentity = {
    runId: state.runId,
    stage: stageName,
    taskRef: stageControl.task.ref,
    taskHash: stageControl.task.hash,
    routeHash: stageControl.route.decisionHash,
    providerRef: stageControl.providerRef,
  };
  const turnKey = turnTransaction.deriveTurnKey(turnIdentity);
  writeJson(path.join(contractDir, `${prefix}.task.json`), stageControl.task);
  writeJson(path.join(contractDir, `${prefix}.route.json`), stageControl.route);
  writeJson(
    path.join(contractDir, `${prefix}.capabilities.json`),
    stageControl.capabilitySnapshot
  );
  state.files.contracts = 'contracts';
  const attempt = {
    ...stageControl,
    contractDir,
    prefix,
    effectBaseline,
    turnControl: {
      identity: turnIdentity,
      turnKey,
      journalFile: path.join(contractDir, `${prefix}.turn-journal.json`),
    },
    lifecycle: {
      providerKey: input.providerKey,
      stage: input.stage,
    },
    goalLeaseControl: {
      expectedRevision: currentLease && Number.isInteger(currentLease.revision)
        ? currentLease.revision
        : 0,
      storeOptions: leaseStoreOptions,
      dispatchContext: {
        ...goalDispatchContext,
        providerRuntime: stageControl.profile.runtime,
      },
    },
  };
  attempt.onFailure = (failure) => persistProviderFailure(state, runDir, attempt, failure);
  return attempt;
}

function normalizeTurnValidation(validation, acceptance) {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) {
    throw new Error('provider turn validation is required');
  }
  const sourceStatus = typeof validation.status === 'string'
    ? validation.status.trim().toLowerCase()
    : '';
  if (!['passed', 'failed', 'skipped'].includes(sourceStatus)) {
    throw new Error('provider turn validation status must be passed, failed, or skipped');
  }
  return {
    status: sourceStatus === 'passed' && acceptance && acceptance.accepted === true
      ? 'passed'
      : 'failed',
    sourceStatus,
    validationHash: providerProfiles.hash(validation),
  };
}

function acceptProviderAttempt(state, attempt, input) {
  const leaseControl = attempt.goalLeaseControl || {
    expectedRevision: 0,
    storeOptions: {},
    dispatchContext: null,
  };
  const outcome = nativeExecutionControl.createAttemptResult({
    stageControl: attempt,
    ref: `result:${state.runId}:${attempt.prefix}`,
    status: input.status,
    effects: input.effects,
    runtimeRefs: input.runtimeRefs || {},
    nativeResult: input.runtimeResult,
    evidence: input.evidence || {},
    payload: input.payload || {},
  });
  recordAttemptTurnPhase(attempt, 'host-execute', {
    status: input.status,
    providerRef: attempt.providerRef,
    runtimeRefsHash: providerProfiles.hash(input.runtimeRefs || {}),
  });
  const typedResultFile = path.join(
    attempt.contractDir,
    `${attempt.prefix}.typed-result.json`
  );
  writeCanonicalJson(typedResultFile, outcome.result);
  recordAttemptTurnPhase(attempt, 'typed-result', {
    material: true,
    resultRef: outcome.result.ref,
    resultArtifactRef: path.relative(state.runDir, typedResultFile).replace(/\\/g, '/'),
    resultHash: outcome.result.hash,
    effectsState: outcome.result.effects.state,
  });
  const turnValidation = normalizeTurnValidation(input.validation, outcome.acceptance);
  const validationPhase = recordAttemptTurnPhase(attempt, 'validation', {
    status: turnValidation.status,
    sourceStatus: turnValidation.sourceStatus,
    validationHash: turnValidation.validationHash,
    acceptanceHash: providerProfiles.hash(outcome.acceptance),
    errorsHash: providerProfiles.hash(outcome.acceptance.errors || []),
  });
  if (turnValidation.sourceStatus !== 'passed') {
    const error = new Error(
      `provider validation ${turnValidation.sourceStatus} for ${attempt.prefix}; material result requires passed validation before durable-writeback`
    );
    error.providerFailureKind = 'validation';
    error.turnReceipt = validationPhase.receipt;
    throw error;
  }
  const taskHashSuffix = attempt.task.hash.slice('sha256:'.length, 'sha256:'.length + 16);
  const acceptedFile = path.join(
    attempt.contractDir,
    `${safeStageName(attempt.task.ref)}.${taskHashSuffix}.accepted.json`
  );
  goalLease.withValidatedGoalLease(
    state.runDir,
    {
      runId: state.runId,
      expectedRevision: leaseControl.expectedRevision,
      dispatchContext: leaseControl.dispatchContext,
    },
    () => {
      writeCanonicalJson(
        path.join(attempt.contractDir, `${attempt.prefix}.result.json`),
        outcome.result
      );
      writeCanonicalJson(
        path.join(attempt.contractDir, `${attempt.prefix}.acceptance.json`),
        outcome.acceptance
      );
      if (!outcome.acceptance.accepted) {
        throw new Error(
          `provider result rejected for ${attempt.prefix}: ${outcome.acceptance.errors.join('; ')}`
        );
      }
      try {
        writeCanonicalJson(acceptedFile, outcome.result, { flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readJson(acceptedFile);
        if (existing.hash !== outcome.result.hash) {
          throw new Error(
            `conflicting accepted result for task ${attempt.task.ref}; resume/reconcile is required`
          );
        }
        outcome.duplicate = true;
      }
      const durable = recordAttemptTurnPhase(attempt, 'durable-writeback', {
        status: 'committed',
        acceptedResultHash: outcome.result.hash,
        acceptanceHash: providerProfiles.hash(outcome.acceptance),
        acceptedArtifact: path.basename(acceptedFile),
      });
      outcome.turnReceipt = durable.receipt;
      outcome.turnJournalRef = path.relative(state.runDir, attempt.turnControl.journalFile)
        .replace(/\\/g, '/');
    },
    leaseControl.storeOptions
  );
  if (state.providerRecovery && state.providerRecovery.required === true) {
    nativeExecutionControl.validateProviderRecovery(
      state.providerRecovery,
      attempt,
      attempt.lifecycle
    );
    delete state.providerRecovery;
  }
  delete state.lastProviderFailure;
  return outcome;
}

function capabilityEvidenceByProvider(preflight) {
  const checks = new Map((preflight.checks || []).map((check) => [check.name, check]));
  return Object.fromEntries(['spec', 'implementation', 'review']
    .map((key) => [key, checks.get(`${key}Provider`)] )
    .filter(([, check]) => check && check.detail
      && typeof check.detail.capabilityEvidence === 'object')
    .map(([key, check]) => [key, check.detail.capabilityEvidence]));
}

function buildNativeExecutionPlan(options, runId, requirement, preflight) {
  return nativeExecutionControl.buildExecutionPlan({
    options,
    runId,
    requirementHash: providerProfiles.hash(requirement),
    capabilityEvidenceByProvider: capabilityEvidenceByProvider(preflight),
  });
}

function currentGitSha(workdir) {
  if (!isGitRepository(workdir)) return null;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  return result.status === 0 ? String(result.stdout || '').trim() || null : null;
}

function reviewProviderRef(options) {
  const policy = nativeAdapterPolicy(options);
  return `claude:review:claude-${policy.claude}`;
}

function providerArtifactDefinitions(settings = {}) {
  const paths = {
    handoff: 'handoff.json',
    diff: 'diff.patch',
    validation: 'validation.json',
    changedFiles: 'changed-files.json',
    ...(settings.artifactPaths || {}),
  };
  return {
    handoff: {
      path: paths.handoff,
      format: 'json',
      evidenceKey: 'handoffHash',
    },
    diff: {
      path: paths.diff,
      format: 'text',
      evidenceKey: 'diffHash',
    },
    validation: {
      path: paths.validation,
      format: 'json',
      evidenceKey: 'validationHash',
    },
    changedFiles: {
      path: paths.changedFiles,
      format: 'json',
      evidenceKey: 'changedFilesHash',
    },
    changedFilesGate: paths.changedFilesGate
      ? {
        path: paths.changedFilesGate,
        format: 'json',
        evidenceKey: 'changedFilesGateHash',
      }
      : { enabled: false },
  };
}

function writeProviderHandoffBundle(
  state,
  runDir,
  options,
  attempt,
  outcome,
  settings = {}
) {
  const handoff = executionEnvelopes.createProviderHandoff({
    ref: `handoff:${state.runId}:${attempt.prefix}`,
    task: attempt.task,
    route: attempt.route,
    result: outcome.result,
    from: attempt.providerRef,
    to: reviewProviderRef(options),
    readOnly: true,
    runtimeRefs: outcome.result.runtimeRefs,
  });
  const evidence = outcome.result.evidence || {};
  const artifactManifest = providerLifecycle.createArtifactManifest(
    runDir,
    providerArtifactDefinitions(settings),
    evidence
  );
  const bundle = {
    schemaVersion: 'provider-handoff-bundle-v1',
    task: attempt.task,
    route: attempt.route,
    result: outcome.result,
    handoff,
    artifactManifest,
    worktree: {
      workdirHash: providerProfiles.hash(path.resolve(state.workdir)),
      baseSha: evidence.baseSha || null,
      headSha: evidence.headSha || null,
      diffHash: evidence.diffHash,
      changedFilesHash: evidence.changedFilesHash,
    },
  };
  const relativeFile = settings.relativeFile || 'provider-handoff.json';
  writeJson(path.join(runDir, relativeFile), bundle);
  if (settings.recordStateFile !== false) {
    state.files.providerHandoff = relativeFile;
  }
  return bundle;
}

function validateProviderHandoffBundle(state, runDir, options, settings = {}) {
  const relativeFile = settings.relativeFile || state.files.providerHandoff;
  const handoffPath = relativeFile
    ? path.join(runDir, relativeFile)
    : null;
  if (!handoffPath || !fs.existsSync(handoffPath)) {
    const executionPlanPath = state.files.executionPlan
      ? path.join(runDir, state.files.executionPlan)
      : null;
    const plan = executionPlanPath && fs.existsSync(executionPlanPath)
      ? readJson(executionPlanPath)
      : null;
    if (plan && plan.version === 'execution-plan-v2') {
      throw new Error('provider handoff is required before v2 review');
    }
    return null;
  }

  const bundle = readJson(handoffPath);
  const acceptance = executionEnvelopes.validateResultForAcceptance(
    bundle.task,
    bundle.result,
    bundle.route,
    {
      routeMode: nativeExecutionControl.capabilityRouterMode(options),
      requireNativeEvidence: true,
    }
  );
  if (!acceptance.accepted) {
    throw new Error(`provider handoff result is invalid: ${acceptance.errors.join('; ')}`);
  }
  const recreated = executionEnvelopes.createProviderHandoff({
    ref: bundle.handoff.ref,
    task: bundle.task,
    route: bundle.route,
    result: bundle.result,
    from: bundle.handoff.from,
    to: bundle.handoff.to,
    readOnly: bundle.handoff.readOnly,
    runtimeRefs: bundle.handoff.runtimeRefs,
  });
  if (bundle.handoff.hash !== recreated.hash
      || bundle.handoff.idempotencyKey !== recreated.idempotencyKey) {
    throw new Error('provider handoff hash or idempotency key is invalid');
  }
  if (bundle.handoff.readOnly !== true) {
    throw new Error('review provider handoff must be read-only');
  }
  if (bundle.handoff.to !== reviewProviderRef(options)) {
    throw new Error('provider handoff review target does not match active adapter policy');
  }
  const expectedContractHash = settings.expectedContractHash
    || providerProfiles.hash(readText(path.join(runDir, 'spec.json')));
  if (bundle.task.payload.contractHash !== expectedContractHash) {
    throw new Error('provider handoff frozen contract hash does not match');
  }
  const evidence = bundle.result.evidence || {};
  for (const key of [
    'diffHash',
    'validationHash',
    'changedFilesHash',
    'baseSha',
    'headSha',
  ]) {
    if (!(key in evidence)) throw new Error(`provider handoff missing ${key} evidence`);
  }
  providerLifecycle.verifyArtifactManifest(
    runDir,
    bundle.artifactManifest,
    evidence
  );
  const worktree = bundle.worktree || {};
  if (worktree.workdirHash !== providerProfiles.hash(path.resolve(state.workdir))) {
    throw new Error('provider handoff worktree identity does not match active run');
  }
  for (const key of ['baseSha', 'headSha', 'diffHash', 'changedFilesHash']) {
    if (worktree[key] !== evidence[key]) {
      throw new Error(`provider handoff worktree ${key} does not match result evidence`);
    }
  }
  const currentSnapshot = captureWorktreeSnapshot(state.workdir, runDir);
  if (currentSnapshot.headSha !== evidence.headSha) {
    throw new Error('provider handoff headSha is stale for the current worktree');
  }
  if (currentSnapshot.diffHash !== evidence.diffHash) {
    throw new Error('provider handoff diffHash is stale for the current worktree');
  }
  if (currentSnapshot.changedFilesHash !== evidence.changedFilesHash) {
    throw new Error('provider handoff changedFilesHash is stale for the current worktree');
  }
  if (isGitRepository(state.workdir)) {
    if (!gitObjectExists(state.workdir, evidence.baseSha)) {
      throw new Error('provider handoff baseSha is not a reachable git commit');
    }
    if (!gitObjectExists(state.workdir, evidence.headSha)) {
      throw new Error('provider handoff headSha is not a reachable git commit');
    }
  }
  return bundle;
}

function runSpecProvider(state, statePath, runDir, options) {
  const prompt = readText(path.join(runDir, 'prompts', 'spec.md'));
  const providerLogStamp = logStamp();
  const stdoutFile = stampedLogPath(runDir, 'spec', 'stdout.log', providerLogStamp);
  const stderrFile = stampedLogPath(runDir, 'spec', 'stderr.log', providerLogStamp);
  const invocation = buildClaudeProviderInvocation(
    options,
    'spec',
    runDir,
    prompt,
    'requirement-spec.schema.json',
    state.workdir,
    providerResumeRefs(state, 'claude', 'spec', 'spec')
  );
  const attempt = prepareProviderAttempt(state, runDir, options, {
    stage: 'spec',
    providerKey: 'spec',
    intent: 'read-only',
    prompt,
    schemaPath: invocation.schemaPath,
    stamp: providerLogStamp,
  });

  const { record, result } = runProcess(
    'spec provider',
    invocation.launch,
    invocation.args,
    {
      cwd: invocation.cwd,
      stdoutFile,
      stderrFile,
      stdin: invocation.stdin,
      env: invocation.env,
      timeoutMs: providerTimeoutMs(options),
      phase: 'spec',
      providerKey: 'spec',
      schemaPath: invocation.schemaPath,
      options,
      runtime: invocation.runtime,
      adapter: invocation.adapter,
      capabilitySnapshot: attempt.capabilitySnapshot,
      taskEnvelopeHash: attempt.task.hash,
      routeDecisionHash: attempt.route.decisionHash,
      onFailure: attempt.onFailure,
    }
  );
  state.providerRuns.push(record);

  return runProviderPostProcess(attempt, record, { result }, () => {
    const runtimeOutput = providerStep('output-normalization', () => (
      runtimeAdapters.normalizeClaudeOutput({
        stdout: result.stdout || '',
        adapter: invocation.adapter,
      })
    ));
    const rawSpec = providerStep('structured-output-parse', () => (
      runtimeOutput.payload === undefined
        ? extractJsonValue(result.stdout || '')
        : runtimeOutput.payload
    ));
    assertProviderStructuredOutput(
      rawSpec,
      'requirement-spec.schema.json',
      'classic requirement spec'
    );
    const spec = providerStep('output-normalization', () => normalizeSpec(rawSpec));
    const errors = validateSpec(spec);
    if (errors.length > 0) {
      const error = new Error(`Invalid spec output: ${errors.join('; ')}`);
      error.providerFailureKind = 'schema-validation';
      throw error;
    }

    providerStep('artifact', () => writeSpecArtifacts(runDir, spec, rawSpec));
    const accepted = providerStep('acceptance', () => acceptProviderAttempt(state, attempt, {
      status: runtimeOutput.status,
      effects: { state: 'none', refs: [] },
      runtimeRefs: {
        claudeSession: runtimeOutput.runtimeRefs.sessionId,
      },
      runtimeResult: runtimeOutput,
      evidence: {
        stdoutHash: providerProfiles.hash(result.stdout || ''),
        schemaPath: invocation.schemaPath,
      },
      validation: {
        status: 'passed',
        source: 'requirement-spec',
        evidenceRef: 'spec.json',
      },
      payload: spec,
    }));
    record.resultEnvelopeHash = accepted.result.hash;
    record.acceptance = accepted.acceptance;
    record.runtimeRefs = accepted.result.runtimeRefs;
    record.usage = runtimeOutput.usage || record.usage;

    state.status = 'spec-ready';
    state.files.spec = 'spec.json';
    state.files.requirementSpec = 'requirement-spec.md';
    state.files.technicalDesign = 'technical-design.md';
    state.files.taskBreakdown = 'task-breakdown.json';
    providerPostAcceptanceStep('state-transition', () => saveState(statePath, state));
  });
}

function freezeRun(options, positionals) {
  const { state, statePath, runDir } = loadRun(options, positionals);
  if (state.mode === 'pipeline') {
    pipeline.freezePipelineRun(buildPipelineCtx(), options, positionals);
    return;
  }
  if (!fs.existsSync(path.join(runDir, 'spec.json'))) {
    throw new Error('Cannot freeze before spec.json exists');
  }
  state.status = 'frozen';
  state.specFrozenAt = nowIso();
  state.specFrozenBy = optionValue(options, 'reviewer') || process.env.USER || process.env.USERNAME || 'human';
  saveState(statePath, state);
  console.log(`[OK] frozen ${state.runId}`);
}

function abandonRun(options, positionals) {
  const { state } = loadRun(options, positionals);
  if (state.mode === 'pipeline') {
    pipeline.abandonPipelineRun(buildPipelineCtx(), options, positionals);
    return;
  }
  throw new Error('abandon is only supported in pipeline mode runs.');
}

function isGitRepository(workdir) {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  return result.status === 0 && String(result.stdout || '').trim() === 'true';
}

function gitRoot(workdir) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function listChangedFiles(workdir, runDir) {
  if (!isGitRepository(workdir)) return [];
  const status = spawnSync('git', [
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  if (status.status !== 0) {
    throw new Error(
      `failed to enumerate changed files: ${status.error && status.error.message || status.stderr || status.stdout || 'git status failed'}`
    );
  }

  return parseGitStatusPorcelainZ(status.stdout || '')
    .filter(Boolean)
    .filter((entry) => {
      const destinationManaged = isManagedArtifact(entry.path, workdir, runDir);
      const sourceManaged = entry.originalPath
        ? isManagedArtifact(entry.originalPath, workdir, runDir)
        : false;
      // A rename/copy that crosses the managed boundary still changes a
      // provider-owned path. Drop the record only when every represented path
      // is managed; otherwise the source deletion/addition must stay hash-bound.
      return !destinationManaged || Boolean(entry.originalPath && !sourceManaged);
    });
}

function parseGitStatusPorcelainZ(output) {
  const fields = String(output || '').split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4 || field[2] !== ' ') {
      throw new Error('failed to parse git status porcelain -z output');
    }
    const status = field.slice(0, 2);
    const filePath = field.slice(3);
    const entry = { status, path: normalizeGitPath(filePath) };
    if (/[RC]/.test(status)) {
      // In porcelain v1 -z mode the destination is in the current record and
      // the original path is the following NUL field.
      index += 1;
      if (index >= fields.length || !fields[index]) {
        throw new Error('git status rename/copy record is missing its original path');
      }
      entry.originalPath = normalizeGitPath(fields[index]);
    }
    entries.push(entry);
  }
  return entries;
}

function normalizeGitPath(value) {
  const raw = String(value || '');
  const platformPath = process.platform === 'win32' ? raw.replace(/\\/g, '/') : raw;
  return platformPath.replace(/^\.\//, '');
}

function isManagedArtifact(filePath, workdir, runDir) {
  const normalized = normalizeGitPath(filePath);
  const runRel = normalizeGitPath(path.relative(workdir, runDir));
  if (runRel && runRel !== '..' && !runRel.startsWith('../')) {
    if (normalized === runRel || normalized.startsWith(`${runRel}/`)) return true;
  }
  return DEFAULT_MANAGED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function ensureCleanWorktree(workdir, options, runDir, state) {
  if (boolOption(options, 'allow-dirty')) return;
  if (state && ['needs-followup', 'blocked'].includes(state.status)) return;
  const changedFiles = listChangedFiles(workdir, runDir);
  if (changedFiles.length > 0) {
    const preview = changedFiles.slice(0, 12).map((entry) => `${entry.status} ${entry.path}`).join('\n');
    throw new Error(
      `Implementation requires a clean git worktree except managed artifacts. Commit/stash changes or pass --allow-dirty explicitly.\n${preview}`
    );
  }
}

function runImplementationProvider(state, statePath, runDir, options) {
  if (!state.specFrozenAt) throw new Error('Spec is not frozen. Run freeze first.');
  ensureCleanWorktree(state.workdir, options, runDir, state);
  const baseSha = currentGitSha(state.workdir);

  const prompt = buildImplementationPrompt(state, runDir);
  writeText(path.join(runDir, 'prompts', 'implement.md'), prompt);
  const providerLogStamp = logStamp();
  const stdoutFile = stampedLogPath(runDir, 'implementation', 'stdout.log', providerLogStamp);
  const stderrFile = stampedLogPath(runDir, 'implementation', 'stderr.log', providerLogStamp);
  const lastMessageFile = stampedLogPath(runDir, 'implementation', 'last-message.json', providerLogStamp);
  const invocation = buildCodexProviderInvocation(
    options,
    runDir,
    prompt,
    lastMessageFile,
    state.workdir,
    providerResumeRefs(state, 'codex', 'implementation', 'implementation')
  );
  const attempt = prepareProviderAttempt(state, runDir, options, {
    stage: 'implementation',
    providerKey: 'implementation',
    intent: 'write',
    prompt,
    schemaPath: invocation.schemaPath,
    contractHash: providerProfiles.hash(readText(path.join(runDir, 'spec.json'))),
    stamp: providerLogStamp,
  });

  const { record, result } = runProcess(
    'implementation provider',
    invocation.launch,
    invocation.args,
    {
      cwd: invocation.cwd,
      stdoutFile,
      stderrFile,
      stdin: invocation.stdin,
      env: invocation.env,
      timeoutMs: providerTimeoutMs(options),
      phase: 'implementation',
      providerKey: 'implementation',
      schemaPath: invocation.schemaPath,
      options,
      runtime: invocation.runtime,
      adapter: invocation.adapter,
      capabilitySnapshot: attempt.capabilitySnapshot,
      taskEnvelopeHash: attempt.task.hash,
      routeDecisionHash: attempt.route.decisionHash,
      onFailure: attempt.onFailure,
    }
  );
  state.providerRuns.push(record);

  const lastMessageText = safeRead(lastMessageFile);
  return runProviderPostProcess(attempt, record, {
    result,
    lastMessage: lastMessageText,
  }, () => {
    const runtimeOutput = providerStep('output-normalization', () => (
      runtimeAdapters.normalizeCodexOutput({
        stdout: result.stdout || '',
        lastMessage: lastMessageText,
        adapter: invocation.adapter,
      })
    ));
    let rawHandoff;
    try {
      rawHandoff = providerStep('structured-output-parse', () => (
        runtimeOutput.payload !== undefined && runtimeOutput.payload !== null
          ? runtimeOutput.payload
          : extractJsonValue(lastMessageText || result.stdout || '')
      ));
      assertProviderStructuredOutput(
        rawHandoff,
        'agent-handoff.schema.json',
        'classic implementation handoff'
      );
    } catch (error) {
      writeJson(path.join(runDir, 'handoff.parse-error.json'), {
        message: error.message,
        stdoutFile: path.relative(runDir, stdoutFile),
        lastMessageFile: path.relative(runDir, lastMessageFile),
      });
      throw error;
    }
    const handoff = providerStep('output-normalization', () => normalizeHandoff(rawHandoff));
    providerStep('artifact', () => {
      writeJson(path.join(runDir, 'handoff.json'), handoff);
      writeText(path.join(runDir, 'handoff.md'), renderHandoff(handoff));
      recordImplementationClarifications(state, runDir, handoff);
    });
    providerStep('changed-files-gate', () => writeGitDiff(state.workdir, runDir));
    providerStep('validation', () => writeValidation(state.workdir, runDir, options));
    providerStep('artifact', () => writeReviewContext(runDir));

    const changedFiles = readJson(path.join(runDir, 'changed-files.json'));
    const diffText = safeRead(path.join(runDir, 'diff.patch'));
    const validation = readJson(path.join(runDir, 'validation.json'));
    const effectRefs = changedFiles.length > 0
      ? [providerProfiles.hash({ changedFiles, diffHash: providerProfiles.hash(diffText) })]
      : [];
    const accepted = providerStep('acceptance', () => acceptProviderAttempt(state, attempt, {
      status: runtimeOutput.status,
      effects: {
        state: effectRefs.length > 0 ? 'committed' : 'none',
        refs: effectRefs,
      },
      runtimeRefs: {
        codexThread: runtimeOutput.runtimeRefs.threadId,
        codexTurn: runtimeOutput.runtimeRefs.turnId,
      },
      runtimeResult: runtimeOutput,
      evidence: {
        handoffHash: providerProfiles.hash(handoff),
        validationHash: providerProfiles.hash(validation),
        diffHash: providerProfiles.hash(diffText),
        changedFilesHash: providerProfiles.hash(changedFiles),
        baseSha,
        headSha: currentGitSha(state.workdir),
      },
      validation: {
        status: validation.status,
        source: 'validation.json',
        evidenceRef: 'validation.json',
      },
      payload: handoff,
    }));
    record.resultEnvelopeHash = accepted.result.hash;
    record.acceptance = accepted.acceptance;
    record.runtimeRefs = accepted.result.runtimeRefs;
    record.usage = runtimeOutput.usage || record.usage;
    providerPostAcceptanceStep('post-acceptance-artifact', () => writeProviderHandoffBundle(
      state,
      runDir,
      options,
      attempt,
      accepted
    ));

    state.status = 'implemented';
    state.files.handoff = 'handoff.md';
    state.files.diff = 'diff.patch';
    state.files.changedFiles = 'changed-files.json';
    state.files.validation = 'validation.json';
    state.files.reviewContext = 'review-context.md';
    providerPostAcceptanceStep('state-transition', () => saveState(statePath, state));
  });
}

function recordImplementationClarifications(state, runDir, handoff) {
  const entries = normalizeClarifications(handoff && handoff.clarifications);
  if (entries.length === 0) return;
  // append-only：implementer 记录假设后不阻塞，等下一个 gate 由 spec-writer 裁决。
  clarifications.appendClarifications(runDir, entries);
  state.files.clarifications = clarifications.CLARIFICATIONS_FILE;
}

function recordReviewRulings(state, runDir, review) {
  const rulings = normalizeClarificationRulings(review && review.clarificationRulings);
  if (rulings.length === 0) return;
  clarifications.appendRulings(runDir, rulings);
  state.files.clarifications = clarifications.CLARIFICATIONS_FILE;
}

function renderHandoff(handoff) {
  return [
    '# Agent Handoff',
    '',
    '## Summary',
    handoff.summary || '',
    '',
    '## Changed Files',
    arrayLines(handoff.changedFiles),
    '',
    '## Validation',
    arrayLines(handoff.validation),
    '',
    '## Risks',
    arrayLines(handoff.risks),
    '',
    '## Follow Up',
    arrayLines(handoff.followUp),
    '',
  ].join('\n');
}

function isGitDiffBufferOverflow(result) {
  const code = result && result.error && result.error.code;
  const message = String(result && result.error && result.error.message || '');
  return code === 'ENOBUFS'
    || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    || /maxBuffer|ENOBUFS/i.test(message);
}

function checkedGitDiffOutput(result, mode, maxBuffer) {
  if (result && result.status === 0) {
    return { text: result.stdout || '', overflow: false };
  }
  if (isGitDiffBufferOverflow(result)) {
    return { text: '', overflow: true, mode, maxBuffer };
  }
  const detail = result && (
    result.error && result.error.message
    || result.stderr
    || result.stdout
  );
  throw new Error(`git diff ${mode} failed: ${detail || `exit ${result && result.status}`}`);
}

function collectGitDiff(
  workdir,
  runDir,
  changedFiles = listChangedFiles(workdir, runDir),
  settings = {}
) {
  if (!isGitRepository(workdir)) {
    return 'Not a git repository; diff unavailable.\n';
  }
  const configuredMaxBuffer = Number(settings.maxBuffer);
  const maxBuffer = Number.isInteger(configuredMaxBuffer) && configuredMaxBuffer > 0
    ? configuredMaxBuffer
    : MAX_BUFFER;
  const pathspec = ['--', '.'];
  for (const exclude of DEFAULT_DIFF_EXCLUDES) pathspec.push(`:(exclude)${exclude}`);
  const runDiff = settings.runDiff || ((modeArgs) => spawnSync('git', [
    'diff',
    ...modeArgs,
    '--no-ext-diff',
    '--binary',
    ...pathspec,
  ], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer,
    shell: false,
  }));
  const staged = checkedGitDiffOutput(runDiff(['--cached']), 'staged', maxBuffer);
  const worktree = checkedGitDiffOutput(runDiff([]), 'worktree', maxBuffer);
  const syntheticDiffs = changedFiles
    .filter((entry) => entry.status === '??')
    .map((entry) => buildUntrackedDiff(workdir, entry))
    .filter(Boolean)
    .join('\n');
  const trackedBindings = changedFiles
    .filter((entry) => entry.status !== '??')
    .map((entry) => renderOmittedDiffSummary(
      workdir,
      entry,
      shouldOmitDiff(entry.path) ? 'generated' : 'tracked-content-binding'
    ))
    .join('\n');
  const omittedUntracked = changedFiles
    .filter((entry) => entry.status === '??' && shouldOmitDiff(entry.path))
    .map((entry) => renderOmittedDiffSummary(workdir, entry, 'generated'))
    .join('\n');
  const overflows = [staged, worktree].filter((entry) => entry.overflow);
  const overflowMarker = overflows.length > 0
    ? `Git diff output omitted after bounded overflow: ${JSON.stringify({
      schemaVersion: 'git-diff-output-overflow-v1',
      modes: overflows.map((entry) => entry.mode),
      maxBuffer,
      fallback: 'head-index-worktree-content-summaries',
    })}`
    : '';

  return [
    staged.text,
    worktree.text,
    overflowMarker,
    trackedBindings,
    syntheticDiffs,
    omittedUntracked,
  ].filter(Boolean).join('\n');
}

function captureWorktreeSnapshot(workdir, runDir) {
  const changedFiles = listChangedFiles(workdir, runDir);
  const diffText = collectGitDiff(workdir, runDir, changedFiles);
  return {
    headSha: currentGitSha(workdir),
    changedFiles,
    changedFilesHash: providerProfiles.hash(changedFiles),
    diffHash: providerProfiles.hash(diffText),
  };
}

function gitObjectExists(workdir, sha) {
  if (!sha || !isGitRepository(workdir)) return false;
  const result = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  return result.status === 0;
}

function writeGitDiff(workdir, runDir) {
  const changedFiles = listChangedFiles(workdir, runDir);
  writeJson(path.join(runDir, 'changed-files.json'), changedFiles);
  const diffPatch = collectGitDiff(workdir, runDir, changedFiles);
  writeText(path.join(runDir, 'diff.patch'), diffPatch);
  return diffPatch;
}

function shouldOmitDiff(filePath) {
  const normalized = normalizeGitPath(filePath);
  return GENERATED_DIFF_OMIT_PATHS.has(normalized);
}

function gitObjectSize(workdir, objectId) {
  if (!objectId) return null;
  const result = spawnSync('git', ['cat-file', '-s', objectId], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to size git object ${objectId}: ${result.error && result.error.message || result.stderr || result.stdout || 'git cat-file failed'}`
    );
  }
  const size = Number(String(result.stdout || '').trim());
  return Number.isFinite(size) ? size : null;
}

function headFileFingerprint(workdir, filePath) {
  const normalized = normalizeGitPath(filePath);
  const result = spawnSync('git', [
    '--literal-pathspecs',
    'ls-tree',
    '-z',
    'HEAD',
    '--',
    normalized,
  ], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to fingerprint HEAD content for ${normalized}: ${result.error && result.error.message || result.stderr || result.stdout || 'git ls-tree failed'}`
    );
  }
  const output = String(result.stdout || '').replace(/\0+$/, '');
  if (!output) return { exists: false };
  const match = output.match(/^(\d+)\s+([a-z]+)\s+([0-9a-f]+)\t/);
  if (!match) throw new Error(`failed to parse HEAD fingerprint for ${normalized}`);
  const objectId = match[3];
  return {
    exists: true,
    mode: match[1],
    objectType: match[2],
    objectId,
    size: gitObjectSize(workdir, objectId),
  };
}

function indexFileFingerprint(workdir, filePath) {
  const result = spawnSync('git', [
    '--literal-pathspecs',
    'ls-files',
    '--stage',
    '--',
    normalizeGitPath(filePath),
  ], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to fingerprint index content for ${normalizeGitPath(filePath)}: ${result.error && result.error.message || result.stderr || result.stdout || 'git ls-files failed'}`
    );
  }
  if (!String(result.stdout || '').trim()) return { exists: false };
  const entries = String(result.stdout || '')
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\d+)\s+([0-9a-f]+)\s+(\d+)\t/);
      if (!match) return null;
      const objectId = match[2];
      return {
        mode: match[1],
        objectId,
        size: gitObjectSize(workdir, objectId),
        stage: Number(match[3]),
      };
    })
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`failed to parse index fingerprint for ${normalizeGitPath(filePath)}`);
  }
  return { exists: true, entries };
}

function worktreeFileFingerprint(workdir, filePath) {
  const normalized = normalizeGitPath(filePath);
  const absolutePath = path.resolve(workdir, normalized);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    let linkPayload;
    try {
      linkPayload = fs.readlinkSync(absolutePath, { encoding: 'buffer' });
    } catch (error) {
      throw new Error(`failed to read link payload for ${normalized}: ${error.message}`);
    }
    if (!Buffer.isBuffer(linkPayload)) {
      throw new Error(`failed to safely fingerprint link payload for ${normalized}`);
    }
    return {
      exists: true,
      type: 'symlink',
      size: stat.size,
      linkPayloadBytes: linkPayload.length,
      linkPayloadHash: `sha256:${crypto.createHash('sha256').update(linkPayload).digest('hex')}`,
    };
  }
  if (!stat.isFile()) {
    throw new Error(`cannot safely fingerprint non-regular worktree path ${normalized}`);
  }
  const result = spawnSync('git', ['hash-object', '--no-filters', '--', normalized], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to fingerprint omitted diff content for ${normalized}: ${result.stderr || result.stdout || 'git hash-object failed'}`
    );
  }
  return {
    exists: true,
    type: 'file',
    size: stat.size,
    objectId: String(result.stdout || '').trim(),
  };
}

function renderOmittedDiffSummary(workdir, entry, reason) {
  const filePath = normalizeGitPath(typeof entry === 'string' ? entry : entry.path);
  const status = typeof entry === 'object' && entry ? String(entry.status || '') : '';
  const originalPath = typeof entry === 'object' && entry && entry.originalPath
    ? normalizeGitPath(entry.originalPath)
    : null;
  const summary = {
    schemaVersion: 'omitted-diff-content-v1',
    reason,
    path: filePath,
    originalPath,
    status,
    head: headFileFingerprint(workdir, filePath),
    originalHead: originalPath ? headFileFingerprint(workdir, originalPath) : null,
    index: indexFileFingerprint(workdir, filePath),
    worktree: worktreeFileFingerprint(workdir, filePath),
  };
  return `Diff omitted; content summary: ${JSON.stringify(summary)}`;
}

function buildUntrackedDiff(workdir, entry) {
  const filePath = normalizeGitPath(typeof entry === 'string' ? entry : entry.path);
  if (shouldOmitDiff(filePath)) return null;
  const absolutePath = path.join(workdir, filePath);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return renderOmittedDiffSummary(workdir, entry, 'symlink-new-file');
  }
  if (!stat.isFile()) {
    return renderOmittedDiffSummary(workdir, entry, 'non-regular-new-path');
  }
  const bytes = stat.size;
  if (bytes > INLINE_FILE_DIFF_MAX_BYTES) {
    return renderOmittedDiffSummary(workdir, entry, 'oversized-new-file');
  }
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.includes(0)) {
    return renderOmittedDiffSummary(workdir, entry, 'binary-new-file');
  }
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const body = lines.map((line) => `+${line}`).join('\n');
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    '',
  ].join('\n');
}

function writeReviewContext(runDir) {
  const changedFiles = safeRead(path.join(runDir, 'changed-files.json')) || '[]';
  const diff = safeRead(path.join(runDir, 'diff.patch')) || '(empty diff)';
  const truncated = Buffer.byteLength(diff, 'utf8') > REVIEW_CONTEXT_MAX_BYTES;
  const diffContext = truncated ? sliceTextByBytes(diff, REVIEW_CONTEXT_MAX_BYTES) : diff;
  writeText(path.join(runDir, 'review-context.md'), [
    '# Review Context',
    '',
    '## Changed Files',
    '',
    '```json',
    changedFiles.trim(),
    '```',
    '',
    '## Diff',
    '',
    truncated
      ? `Diff was truncated at ${REVIEW_CONTEXT_MAX_BYTES} bytes. Inspect repository files directly for omitted context.`
      : 'Full inline diff follows.',
    '',
    '```diff',
    diffContext,
    '```',
    '',
  ].join('\n'));
}

function sliceTextByBytes(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString('utf8');
}

function writeValidation(workdir, runDir, options) {
  const commands = optionValues(options, 'validation-command');
  if (commands.length === 0) {
    writeJson(path.join(runDir, 'validation.json'), {
      status: 'skipped',
      reason: 'No --validation-command provided',
      commands: [],
    });
    return;
  }

  const results = commands.map((command, index) => {
    const label = `validation-${index + 1}`;
    const stdoutFile = path.join(runDir, 'logs', `${label}.stdout.log`);
    const stderrFile = path.join(runDir, 'logs', `${label}.stderr.log`);
    const result = runShell(label, command, { cwd: workdir, stdoutFile, stderrFile });
    return {
      command: result.command,
      exitCode: result.status,
      status: result.status === 0 ? 'passed' : 'failed',
      stdoutFile: path.relative(runDir, stdoutFile),
      stderrFile: path.relative(runDir, stderrFile),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    };
  });

  writeJson(path.join(runDir, 'validation.json'), {
    status: results.every((result) => result.exitCode === 0) ? 'passed' : 'failed',
    commands: results,
  });
}

function runReviewProvider(state, statePath, runDir, options) {
  validateProviderHandoffBundle(state, runDir, options);
  const prompt = buildReviewPrompt(state, runDir);
  writeText(path.join(runDir, 'prompts', 'review.md'), prompt);
  const providerLogStamp = logStamp();
  const stdoutFile = stampedLogPath(runDir, 'review', 'stdout.log', providerLogStamp);
  const stderrFile = stampedLogPath(runDir, 'review', 'stderr.log', providerLogStamp);
  const invocation = buildClaudeProviderInvocation(
    options,
    'review',
    runDir,
    prompt,
    'review-result.schema.json',
    state.workdir,
    providerResumeRefs(state, 'claude', 'review', 'review')
  );
  const attempt = prepareProviderAttempt(state, runDir, options, {
    stage: 'review',
    providerKey: 'review',
    intent: 'read-only',
    prompt,
    schemaPath: invocation.schemaPath,
    contractHash: providerProfiles.hash(readText(path.join(runDir, 'spec.json'))),
    stamp: providerLogStamp,
  });

  const { record, result } = runProcess(
    'review provider',
    invocation.launch,
    invocation.args,
    {
      cwd: invocation.cwd,
      stdoutFile,
      stderrFile,
      stdin: invocation.stdin,
      env: invocation.env,
      timeoutMs: providerTimeoutMs(options),
      phase: 'review',
      providerKey: 'review',
      schemaPath: invocation.schemaPath,
      options,
      runtime: invocation.runtime,
      adapter: invocation.adapter,
      capabilitySnapshot: attempt.capabilitySnapshot,
      taskEnvelopeHash: attempt.task.hash,
      routeDecisionHash: attempt.route.decisionHash,
      onFailure: attempt.onFailure,
    }
  );
  state.providerRuns.push(record);

  return runProviderPostProcess(attempt, record, { result }, () => {
    const runtimeOutput = providerStep('output-normalization', () => (
      runtimeAdapters.normalizeClaudeOutput({
        stdout: result.stdout || '',
        adapter: invocation.adapter,
      })
    ));
    let rawReview;
    let review;
    try {
      rawReview = providerStep('structured-output-parse', () => (
        runtimeOutput.payload === undefined
          ? extractJsonValue(result.stdout || '')
          : runtimeOutput.payload
      ));
      assertProviderStructuredOutput(
        rawReview,
        'review-result.schema.json',
        'classic review result'
      );
      review = providerStep('output-normalization', () => normalizeReview(rawReview));
    } catch (error) {
      writeJson(path.join(runDir, 'review.parse-error.json'), {
        message: error.message,
        stdoutFile: path.relative(runDir, stdoutFile),
        stderrFile: path.relative(runDir, stderrFile),
      });
      throw error;
    }

    providerStep('artifact', () => {
      writeJson(path.join(runDir, 'review.raw.json'), rawReview);
      writeJson(path.join(runDir, 'review.json'), review);
    });
    const completionGate = providerStep('validation', () => policyGates.canCompleteRun({
      validation: readJson(path.join(runDir, 'validation.json')),
      spec: readJson(path.join(runDir, 'spec.json')),
    }));
    providerStep('artifact', () => writeJson(
      path.join(runDir, 'completion-gate.json'),
      completionGate
    ));

    const accepted = providerStep('acceptance', () => acceptProviderAttempt(state, attempt, {
      status: runtimeOutput.status,
      effects: { state: 'none', refs: [] },
      runtimeRefs: {
        claudeSession: runtimeOutput.runtimeRefs.sessionId,
      },
      runtimeResult: runtimeOutput,
      evidence: {
        reviewHash: providerProfiles.hash(review),
        completionGateHash: providerProfiles.hash(completionGate),
      },
      validation: {
        status: 'passed',
        source: 'review-result-and-completion-gate',
        evidenceRef: 'completion-gate.json',
      },
      payload: review,
    }));
    record.resultEnvelopeHash = accepted.result.hash;
    record.acceptance = accepted.acceptance;
    record.runtimeRefs = accepted.result.runtimeRefs;
    record.usage = runtimeOutput.usage || record.usage;

    providerPostAcceptanceStep('state-transition', () => {
      state.files.review = 'review.json';
      state.files.completionGate = 'completion-gate.json';
      recordReviewRulings(state, runDir, review);
      state.status = statusFromReview(review, completionGate);
      if (state.status === 'needs-followup' || state.status === 'blocked') {
        writeFollowUpTask(runDir, review);
      }
      saveState(statePath, state);
    });
  });
}

function writeFollowUpTask(runDir, review) {
  const tasks = Array.isArray(review.followUpTasks) ? review.followUpTasks : [];
  writeText(path.join(runDir, 'follow-up-task.md'), [
    '# Follow-up Task',
    '',
    'The review provider requested changes against the frozen spec.',
    '',
    '## Follow-up Tasks',
    arrayLines(tasks),
    '',
    '## Findings',
    arrayLines(review.findings),
    '',
  ].join('\n'));
}

function newState(workdir, runDir, runId, requirement) {
  return {
    version: VERSION,
    mode: 'classic',
    runId,
    status: 'draft',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    workdir,
    runDir,
    providers: PROVIDERS,
    files: {
      requirement: 'requirement.md',
    },
    requirementPreview: requirement.slice(0, 240),
    specFrozenAt: null,
    specFrozenBy: null,
    providerRuns: [],
  };
}

function buildPipelineCtx() {
  return {
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
    exitWithFailure: () => { process.exitCode = 1; },
    optionValue,
    optionValues,
    boolOption,
    resolveWorkdir,
    resolveRunsDir,
    readRequirement,
    dateStamp,
    slugify,
    loadRun,
    buildPreflightReport,
    writePreflight,
    assertPreflight,
    printPreflight,
    runProcess,
    runShell,
    runValidatedCommand,
    providerLaunch,
    providerCommandSpec,
    providerTimeoutMs,
    codexSandboxMode,
    claudeProviderEnv,
    buildClaudeProviderInvocation,
    buildCodexProviderInvocation,
    prepareProviderAttempt,
    acceptProviderAttempt,
    runProviderPostProcess,
    providerStep,
    providerPostAcceptanceStep,
    assertProviderStructuredOutput,
    providerResumeRefs,
    writeProviderHandoffBundle,
    validateProviderHandoffBundle,
    currentGitSha,
    buildNativeExecutionPlan,
    orchestrationOwner: nativeExecutionControl.orchestrationOwner,
    normalizeClaudeOutput: runtimeAdapters.normalizeClaudeOutput,
    normalizeCodexOutput: runtimeAdapters.normalizeCodexOutput,
    hashArtifact: providerProfiles.hash,
    isGitRepository,
    writeGitDiff,
    listChangedFiles,
    ensureCleanWorktree,
    extractJsonValue,
    parseJsonFromText,
    unwrapAgentJson,
    findFirstJson,
    tryParseJson,
    schemaPath,
    schemaJson,
    nowIso,
    logStamp,
    stampedLogPath,
  };
}

function commandPlan(options) {
  const specCommand = providerCommandSpec(options, 'spec');
  const implementationCommand = providerCommandSpec(options, 'implementation');
  const reviewCommand = providerCommandSpec(options, 'review');
  return {
    doctor: 'node scripts/agent-orchestrator.js doctor',
    spec: `${specCommand} -p --input-format text --output-format json --json-schema <schema-json> < prompts/spec.md`,
    freeze: 'node scripts/agent-orchestrator.js freeze --run <runId>',
    implementation: `${implementationCommand} exec -C <workdir> --json --output-last-message <file> --output-schema ${schemaPath('agent-handoff.schema.json')} - < prompts/implement.md`,
    review: `${reviewCommand} -p --input-format text --output-format json --json-schema <schema-json> < prompts/review.md`,
  };
}

function buildPreflightReport(workdir, options, runDir) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('node', true, process.version);
  add('workdir', fs.existsSync(workdir), workdir);
  add('runDirWritable', canWriteDirectory(runDir), runDir);
  const gitRepository = isGitRepository(workdir);
  add('gitRepository', gitRepository || boolOption(options, 'skip-git-repo-check'), gitRepository
    ? gitRoot(workdir)
    : {
      skipped: boolOption(options, 'skip-git-repo-check'),
      detail: boolOption(options, 'skip-git-repo-check')
        ? 'not a git repository; allowed by --skip-git-repo-check as a no-diff run'
        : 'not a git repository; pass --skip-git-repo-check to allow a no-diff run',
    });

  if (isWindows()) {
    const gitBash = resolveClaudeGitBash();
    add('claudeGitBash', Boolean(gitBash.path), gitBash.path
      ? { path: gitBash.path, source: gitBash.source }
      : 'Claude Code on Windows requires Git Bash; install Git or set CLAUDE_CODE_GIT_BASH_PATH');
  }

  for (const key of ['spec', 'implementation', 'review']) {
    try {
      const launch = providerLaunch(options, key);
      add(`${key}Provider`, true, {
        requested: providerCommandSpec(options, key),
        command: launch.command,
        argsPrefix: launch.argsPrefix,
        shell: launch.shell,
        resolvedFrom: launch.resolvedFrom,
        shimPath: launch.shimPath || null,
      });
    } catch (error) {
      add(`${key}Provider`, false, error.message);
    }
  }

  add('codexHandoffSchemaStrict', schemaHasStrictObjects(readJson(schemaPath('agent-handoff.schema.json'))), 'agent-handoff.schema.json');
  add('codexSandbox', true, isWindows()
    ? {
      effective: codexSandboxMode(options) || 'codex-default',
      defaulted: optionValue(options, 'codex-sandbox') === undefined,
      reason: 'Windows defaults to workspace-write to avoid elevated sandbox process and write-policy failures.',
    }
    : 'not required on non-Windows platforms');

  return {
    version: VERSION,
    workdir,
    runDir,
    generatedAt: nowIso(),
    platform: `${process.platform} ${os.release()}`,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

function canWriteDirectory(dir) {
  try {
    let target = fs.existsSync(dir) ? dir : path.dirname(dir);
    while (target && !fs.existsSync(target)) {
      const parent = path.dirname(target);
      if (parent === target) break;
      target = parent;
    }
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function schemaHasStrictObjects(schema) {
  if (!schema || typeof schema !== 'object') return true;
  if (schema.type === 'object' && schema.additionalProperties !== false) return false;
  for (const key of Object.keys(schema)) {
    if (!schemaHasStrictObjects(schema[key])) return false;
  }
  return true;
}

function writePreflight(runDir, report) {
  writeJson(path.join(runDir, 'preflight.json'), report);
}

function assertPreflight(report) {
  if (!report.ok) {
    const failed = report.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail)}`)
      .join('; ');
    throw new Error(`Preflight failed: ${failed}`);
  }
}

function printPreflight(report) {
  for (const check of report.checks) {
    console.log(`${check.ok ? '[OK]' : '[FAIL]'} ${check.name}: ${formatDetail(check.detail)}`);
  }
  console.log(report.ok ? '[OK] doctor passed' : '[FAIL] doctor found issues');
}

function formatDetail(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function runStart(options, positionals) {
  if (boolOption(options, 'pipeline')) {
    pipeline.startPipelineRun(buildPipelineCtx(), options, positionals);
    return;
  }
  const workdir = resolveWorkdir(options);
  const runsDir = resolveRunsDir(workdir, options);
  const requirement = readRequirement(options, positionals);
  const runId = optionValue(options, 'run-id') || `${dateStamp()}-${slugify(requirement)}`;
  const runDir = path.join(runsDir, runId);
  const statePath = path.join(runDir, 'state.json');

  if (fs.existsSync(statePath)) throw new Error(`Run already exists: ${runDir}`);
  ensureDir(path.join(runDir, 'prompts'));
  ensureDir(path.join(runDir, 'logs'));

  const dispatchLock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'run',
    runId,
  }, goalLeaseStoreOptions(options, workdir));
  try {
  if (fs.existsSync(statePath)) {
    throw new Error(`Run already exists after dispatch lock acquisition: ${runDir}`);
  }
  const executionPolicy = nativeExecutionControl.executionPolicy(options);
  const state = newState(workdir, runDir, runId, requirement);
  state.orchestrationOwner = executionPolicy.orchestrationOwner;
  state.executionPolicy = executionPolicy;
  writeText(path.join(runDir, 'requirement.md'), `${requirement}\n`);
  writeText(path.join(runDir, 'prompts', 'spec.md'), buildSpecPrompt(requirement, { workdir }));
  writeJson(path.join(runDir, 'commands.json'), commandPlan(options));
  saveState(statePath, state);

  const preflight = buildPreflightReport(workdir, options, runDir);
  writePreflight(runDir, preflight);
  const executionPlan = buildNativeExecutionPlan(
    options,
    runId,
    requirement,
    preflight
  );
  writeJson(path.join(runDir, 'execution-plan.json'), executionPlan);
  state.files.preflight = 'preflight.json';
  state.files.executionPlan = 'execution-plan.json';
  saveState(statePath, state);

  if (boolOption(options, 'preflight-only')) {
    state.status = preflight.ok ? 'preflight-ready' : 'preflight-failed';
    saveState(statePath, state);
    printPreflight(preflight);
    if (!preflight.ok) process.exitCode = 1;
    return;
  }
  assertPreflight(preflight);

  if (boolOption(options, 'dry-run')) {
    state.status = 'dry-run';
    saveState(statePath, state);
    console.log(`[OK] dry-run created ${runDir}`);
    return;
  }

  runSpecProvider(state, statePath, runDir, options);
  if (!boolOption(options, 'auto')) {
    console.log(`[OK] spec ready: ${runDir}`);
    console.log(`Next: review ${path.join(runDir, 'requirement-spec.md')}`);
    console.log(`Freeze: node scripts/agent-orchestrator.js freeze --run ${runId}`);
    return;
  }

  const autoGate = policyGates.canAutoFreezeSpec(readJson(path.join(runDir, 'spec.json')));
  writeJson(path.join(runDir, 'auto-gate.json'), autoGate);
  state.files.autoGate = 'auto-gate.json';
  if (!autoGate.ok) { saveState(statePath, state); console.log('[INFO] auto freeze blocked: ' + autoGate.reasons.join('; ')); return; }
  state.specFrozenAt = nowIso();
  state.specFrozenBy = 'auto';
  state.status = 'frozen';
  saveState(statePath, state);
  runImplementationProvider(state, statePath, runDir, options);
  runReviewProvider(state, statePath, runDir, options);
  printRunSummary(state);
  } finally {
    dispatchLock.release();
  }
}

function runResume(options, positionals) {
  const { runDir, statePath, state } = loadRun(options, positionals);
  const effectiveOptions = nativeExecutionControl.resolveExecutionPolicyOptions(
    options,
    state.executionPolicy
  );
  if (state.mode === 'pipeline') {
    pipeline.resumePipelineRun(buildPipelineCtx(), effectiveOptions, positionals);
    return;
  }
  return runLock.withRunLock(
    runDir,
    'provider-dispatch',
    { command: 'resume', runId: state.runId },
    () => {
  if (state.status === 'dry-run') {
    console.log(`[INFO] ${state.runId} is a dry-run. No provider calls to resume.`);
    return;
  }
  if (state.status === 'spec-ready' && !state.specFrozenAt) {
    console.log(`[INFO] ${state.runId} is waiting for human freeze.`);
    console.log(`Freeze: node scripts/agent-orchestrator.js freeze --run ${state.runId}`);
    return;
  }
  const preflight = buildPreflightReport(state.workdir, effectiveOptions, runDir);
  writePreflight(runDir, preflight);
  state.files.preflight = 'preflight.json';
  saveState(statePath, state);
  assertPreflight(preflight);

  if (state.status === 'frozen' || state.status === 'needs-followup' || state.status === 'blocked') {
    runImplementationProvider(state, statePath, runDir, effectiveOptions);
  }
  if (state.status === 'implemented') {
    runReviewProvider(state, statePath, runDir, effectiveOptions);
  }
  printRunSummary(state);
    },
    goalLeaseStoreOptions(effectiveOptions, state.workdir)
  );
}

function printRunSummary(state) {
  console.log(`[OK] ${state.runId}: ${state.status}`);
  console.log(`Run dir: ${state.runDir}`);
  if (state.files.diff) console.log(`Diff: ${path.join(state.runDir, state.files.diff)}`);
  if (state.files.review) console.log(`Review: ${path.join(state.runDir, state.files.review)}`);
}

function isContainedRealPath(rootReal, targetReal) {
  const relativeReal = path.relative(rootReal, targetReal);
  return relativeReal !== '..'
    && !relativeReal.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeReal);
}

function resolveRunDirectory(runDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) return null;
  let resolved;
  try {
    resolved = providerLifecycle.resolveArtifactPath(runDir, relativePath);
  } catch (_error) {
    return null;
  }

  try {
    const lexicalStat = fs.lstatSync(resolved.absolutePath);
    if (lexicalStat.isSymbolicLink() || !lexicalStat.isDirectory()) {
      return null;
    }
    const rootReal = fs.realpathSync.native(path.resolve(runDir));
    const directoryReal = fs.realpathSync.native(resolved.absolutePath);
    const realStat = fs.statSync(directoryReal);
    if (!isContainedRealPath(rootReal, directoryReal)
        || realStat.dev !== lexicalStat.dev
        || realStat.ino !== lexicalStat.ino) {
      return null;
    }
    return { absolutePath: resolved.absolutePath, realPath: directoryReal };
  } catch (_error) {
    return null;
  }
}

function readRunJsonArtifact(runDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) return null;
  let resolved;
  try {
    resolved = providerLifecycle.resolveArtifactPath(runDir, relativePath);
  } catch (_error) {
    return null;
  }

  let descriptor = null;
  try {
    const lexicalStat = fs.lstatSync(resolved.absolutePath);
    if (lexicalStat.isSymbolicLink()
        || !lexicalStat.isFile()
        || lexicalStat.size > STATUS_ARTIFACT_MAX_BYTES) {
      return null;
    }
    const rootReal = fs.realpathSync.native(path.resolve(runDir));
    const targetReal = fs.realpathSync.native(resolved.absolutePath);
    if (!isContainedRealPath(rootReal, targetReal)) {
      return null;
    }

    descriptor = fs.openSync(targetReal, 'r');
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile()
        || openedStat.size > STATUS_ARTIFACT_MAX_BYTES
        || openedStat.dev !== lexicalStat.dev
        || openedStat.ino !== lexicalStat.ino) {
      return null;
    }
    const buffer = Buffer.alloc(openedStat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(
        descriptor, buffer, offset, buffer.length - offset, offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterStat = fs.fstatSync(descriptor);
    if (offset !== openedStat.size
        || afterStat.size !== openedStat.size
        || afterStat.mtimeMs !== openedStat.mtimeMs) {
      return null;
    }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } catch (_error) {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_error) {
        // Status is a fail-closed projection; descriptor cleanup must not make it fail open.
      }
    }
  }
}

function operatorUserGate(state) {
  if (state.status === 'spec-ready' && !state.specFrozenAt) {
    return {
      active: true,
      status: 'open',
      ref: `run:${state.runId}:spec-freeze`,
      reason: 'the frozen specification requires an explicit human freeze',
    };
  }
  if (state.status === 'contract-conflict') {
    return {
      active: true,
      status: 'open',
      ref: `run:${state.runId}:contract-conflict`,
      reason: 'the contract conflict requires an explicit accept or reject decision',
    };
  }
  return null;
}

function operatorEvidenceWait(state) {
  const recovery = state.providerRecovery;
  if (!recovery || recovery.required !== true) return null;
  return {
    active: true,
    status: 'waiting',
    ref: recovery.resultHash || recovery.providerRef || `run:${state.runId}:provider-recovery`,
    reason: recovery.reconcileRequired === true
      ? 'provider recovery requires reconciliation evidence'
      : 'provider recovery is waiting for resumable runtime evidence',
    retryAfterMs: 300_000,
  };
}

function nextSafeActionForRun(state) {
  if (['completed', 'abandoned', 'dry-run'].includes(state.status)) {
    return 'inspect the recorded evidence; this terminal run has no scheduled execution';
  }
  if (state.status === 'spec-ready' && !state.specFrozenAt) {
    return `node scripts/agent-orchestrator.js freeze --run ${state.runId}`;
  }
  if (state.status === 'contract-conflict') {
    return `node scripts/agent-orchestrator.js resume --run ${state.runId} --resolve <accept-revision|reject-revision> --revision <id>`;
  }
  if (state.status === 'blocked' || state.status === 'needs-followup') {
    return `inspect the blocker evidence, then node scripts/agent-orchestrator.js resume --run ${state.runId}`;
  }
  return `node scripts/agent-orchestrator.js resume --run ${state.runId}`;
}

function latestTurnReceipt(runDir) {
  const contracts = resolveRunDirectory(runDir, 'contracts');
  if (!contracts) return null;

  let entries;
  try {
    entries = fs.readdirSync(contracts.realPath, { withFileTypes: true });
  } catch (_error) {
    return null;
  }

  const journals = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.turn-journal.json'))
    .map((entry) => {
      try {
        const file = path.join(contracts.realPath, entry.name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()
            || !stat.isFile()
            || stat.size > STATUS_ARTIFACT_MAX_BYTES) {
          return null;
        }
        return { name: entry.name, mtimeMs: stat.mtimeMs };
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name)
    ));
  for (const selected of journals) {
    const ref = `contracts/${selected.name}`;
    const journal = readRunJsonArtifact(runDir, ref);
    if (!journal) continue;
    try {
      return {
        ref,
        receipt: turnTransaction.replayTurnJournal(journal),
      };
    } catch (_error) {
      // Corrupt journals degrade to the next safe candidate instead of breaking status.
    }
  }
  return null;
}

function buildRunStatusProjection(runDir, state) {
  const reviewRef = state.files && state.files.review;
  const validationRef = state.files && state.files.validation;
  const review = readRunJsonArtifact(runDir, reviewRef) || {};
  const validation = readRunJsonArtifact(runDir, validationRef) || {};
  const queue = readRunJsonArtifact(runDir, 'queue.json') || {};
  const latestTurn = latestTurnReceipt(runDir);
  const evidenceRefs = [
    ...Object.values(state.files || {}).filter((value) => typeof value === 'string'),
  ];
  if (fs.existsSync(path.join(runDir, 'queue.json'))) evidenceRefs.push('queue.json');
  if (latestTurn) evidenceRefs.push(latestTurn.ref);

  const packet = operatorReviewPacket.buildOperatorReviewPacket({
    run: {
      runId: state.runId,
      status: state.status,
      mode: state.mode || 'classic',
    },
    queue,
    userGate: operatorUserGate(state),
    evidenceWait: operatorEvidenceWait(state),
    decision: review.decision,
    reason: review.summary || review.reason || (validation.status
      ? `latest validation status is ${validation.status}`
      : undefined),
    evidenceRefs,
    freshness: {
      status: 'snapshot',
      observedAt: state.updatedAt || null,
      source: 'state.json and referenced run artifacts',
      stale: null,
    },
    boundary: {
      intent: 'read-only',
      writeAllowed: false,
      requiresApproval: false,
      scopes: evidenceRefs,
      reason: 'status is a read-only projection and does not grant execution authority',
    },
    nextSafeAction: nextSafeActionForRun(state),
  });

  return {
    schemaVersion: 'agent-loop-status-v1',
    run: {
      runId: state.runId,
      mode: state.mode || 'classic',
      status: state.status,
      createdAt: state.createdAt || null,
      updatedAt: state.updatedAt || null,
    },
    operatorReviewPacket: packet,
    turnReceipt: latestTurn ? latestTurn.receipt : null,
  };
}

function runStatus(options, positionals) {
  const { runDir, state } = loadRun(options, positionals);
  const projection = buildRunStatusProjection(runDir, state);
  if (boolOption(options, 'json')) {
    console.log(JSON.stringify(projection, null, 2));
    return;
  }
  printRunSummary(state);
  console.log(`Created: ${state.createdAt}`);
  console.log(`Updated: ${state.updatedAt}`);
  console.log(`Frozen: ${state.specFrozenAt || 'no'}`);
  const packet = projection.operatorReviewPacket;
  console.log(`Operator decision: ${packet.decision}`);
  console.log(`Reason: ${packet.reason}`);
  console.log(
    `Scheduler hint: ${packet.schedulerHint.action} (permission=${packet.schedulerHint.permission})`
  );
  console.log(`Next safe action: ${packet.nextSafeAction}`);
}

function bindGoalLease(options, positionals) {
  const { runDir, statePath, state } = loadRun(options, positionals);
  const ownerRuntime = optionValue(options, 'runtime');
  const hostRef = optionValue(options, 'host-ref');
  const objective = optionValue(options, 'objective');
  if (!ownerRuntime || !hostRef || !objective) {
    throw new Error(
      'goal-bind requires --runtime codex|claude, --host-ref <opaque-ref>, and --objective <text>'
    );
  }
  const runObjective = readText(path.join(runDir, 'requirement.md')).trim();
  if (goalLease.objectiveHash(objective) !== goalLease.objectiveHash(runObjective)) {
    throw new Error('goal-bind objective conflict: objective must match the frozen run requirement');
  }
  const expectedOwner = `${ownerRuntime}-host`;
  const activeOwner = state.executionPolicy
    ? state.executionPolicy.orchestrationOwner
    : state.orchestrationOwner;
  if (activeOwner !== 'tp' && activeOwner !== expectedOwner) {
    throw new Error(
      `goal-bind owner conflict: ${ownerRuntime} Goal requires orchestration owner tp or ${expectedOwner}`
    );
  }
  const lease = goalLease.bindGoalLease(runDir, {
    runId: state.runId,
    ownerRuntime: String(ownerRuntime),
    hostRef: String(hostRef),
    objective: String(objective),
  }, {
    expectedRevision: optionValue(options, 'expected-revision'),
    ...goalLeaseStoreOptions(options, state.workdir),
  });
  state.files.goalLease = goalLease.GOAL_LEASE_FILE;
  saveState(statePath, state);
  console.log(`[OK] bound ${ownerRuntime} native Goal lease for ${state.runId}`);
}

function releaseGoalLease(options, positionals) {
  const { runDir, statePath, state } = loadRun(options, positionals);
  const lease = goalLease.releaseStoredGoalLease(runDir, {
    reason: optionValue(options, 'reason') || 'released by operator',
    expectedRevision: optionValue(options, 'expected-revision'),
    ...goalLeaseStoreOptions(options, state.workdir),
  });
  state.files.goalLease = goalLease.GOAL_LEASE_FILE;
  saveState(statePath, state);
  console.log(`[OK] released native Goal lease for ${state.runId}`);
}

function runDoctor(options) {
  const workdir = resolveWorkdir(options);
  const runsDir = resolveRunsDir(workdir, options);
  const probeDir = path.join(runsDir, '_doctor');
  const report = buildPreflightReport(workdir, options, probeDir);
  printPreflight(report);
  if (!report.ok) { process.exitCode = 1; return; }
  if (boolOption(options, 'probe')) {
    const probe = probeProviders(workdir, options, probeDir);
    printProbe(probe);
    if (!probe.ok) process.exitCode = 1;
  }
}

function probeProviders(workdir, options, runDir) {
  ensureDir(runDir);
  const results = [];
  const stamp = logStamp();
  const probePrompt = 'ping';

  try {
    const stdoutFile = stampedLogPath(runDir, 'probe-spec', 'stdout.log', stamp);
    const stderrFile = stampedLogPath(runDir, 'probe-spec', 'stderr.log', stamp);
    runProcess(
      'probe spec/review provider',
      providerLaunch(options, 'spec'),
      ['-p', '--input-format', 'text', '--output-format', 'json'],
      { cwd: workdir, stdoutFile, stderrFile, stdin: probePrompt, timeoutMs: 30000, env: claudeProviderEnv() }
    );
    results.push({ name: 'spec/review (claude)', ok: true });
  } catch (error) {
    results.push({ name: 'spec/review (claude)', ok: false, reason: error.message });
  }

  try {
    const stdoutFile = stampedLogPath(runDir, 'probe-impl', 'stdout.log', stamp);
    const stderrFile = stampedLogPath(runDir, 'probe-impl', 'stderr.log', stamp);
    runProcess(
      'probe implementation provider',
      providerLaunch(options, 'implementation'),
      ['--version'],
      { cwd: workdir, stdoutFile, stderrFile, timeoutMs: 30000 }
    );
    results.push({ name: 'implementation (codex)', ok: true });
  } catch (error) {
    results.push({ name: 'implementation (codex)', ok: false, reason: error.message });
  }

  return { ok: results.every((r) => r.ok), results };
}

function printProbe(probe) {
  console.log('--- probe ---');
  for (const r of probe.results) {
    if (r.ok) console.log(`[OK] ${r.name}`);
    else console.log(`[FAIL] ${r.name}: ${r.reason}`);
  }
  console.log(probe.ok ? '[OK] probe passed' : '[FAIL] probe failed');
}

function runSelfTest() {
  const wrappedReview = extractJsonValue(JSON.stringify({
    result: '```json\n{"status":"passed","canMerge":true,"issues":[],"warnings":[]}\n```',
  }));
  const normalizedReview = normalizeReview(wrappedReview);
  assertSelfTest('review passed alias normalizes to approved', normalizedReview.decision, 'approved');
  assertSelfTest('approved review maps to completed', statusFromReview(normalizedReview), 'completed');

  const handoffClarifications = normalizeHandoff({
    summary: 's',
    clarifications: [
      { assumption: 'use REST', question: 'REST or GraphQL?' },
      { assumption: '', question: '' },
    ],
  }).clarifications;
  assertSelfTest('handoff clarifications drop empty entries', handoffClarifications.length, 1);
  assertSelfTest('handoff clarification keeps assumption', handoffClarifications[0].assumption, 'use REST');

  const reviewRulings = normalizeReview({
    decision: 'approved',
    clarificationRulings: [
      { id: 'clr-001', decision: 'revise-spec', note: 'switch to GraphQL' },
      { id: '', decision: 'confirm-assumption' },
      { id: 'clr-002', decision: 'bogus' },
    ],
  }).clarificationRulings;
  assertSelfTest('review rulings drop entries without id', reviewRulings.length, 2);
  assertSelfTest('review ruling normalizes unknown decision to confirm-assumption', reviewRulings[1].decision, 'confirm-assumption');

  const summaryApprovedReview = normalizeReview({ summary: 'APPROVED', findings: [] });
  assertSelfTest('summary APPROVED normalizes to approved', summaryApprovedReview.decision, 'approved');

  const nestedPlanSpec = normalizeSpec({
    plan: {
      requirements: { summary: 'Nested plan', acceptance: ['works'] },
      design: { approach: 'Use normalized aliases' },
      tasks: [{ title: 'Implement nested plan support' }],
    },
  });
  assertSelfTest('plan.tasks alias normalizes', nestedPlanSpec.taskBreakdown.length, 1);

  const nestedTaskBreakdownSpec = normalizeSpec({
    requirementSpec: { summary: 'Nested taskBreakdown', acceptanceCriteria: ['works'] },
    technicalDesign: { approach: 'Use nested taskBreakdown compatibility' },
    taskBreakdown: { tasks: [{ title: 'Flatten taskBreakdown.tasks' }] },
  });
  assertSelfTest('taskBreakdown.tasks normalizes', nestedTaskBreakdownSpec.taskBreakdown.length, 1);
  assertSelfTest('provider timeout minutes parses', providerTimeoutMs({ 'provider-timeout-minutes': '2' }), 120000);

  const claude401 = extractProviderEnvelopeError('{"is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 Invalid bearer token"}');
  assertSelfTest('envelope extractor surfaces claude 401', claude401.includes('401') && claude401.includes('authenticate'), true);
  const codex402 = extractProviderEnvelopeError('{"is_error":true,"result":"insufficient quota"}');
  assertSelfTest('envelope extractor surfaces generic is_error', codex402.includes('insufficient quota'), true);
  assertSelfTest('envelope extractor ignores plain text', extractProviderEnvelopeError('hello world'), null);
  assertSelfTest('envelope extractor ignores empty', extractProviderEnvelopeError(''), null);
  assertSelfTest('auto flag canonical parses', boolOption({ auto: true }, 'auto'), true);
  assertSelfTest('auto-evaluate alias parses as auto', boolOption({ 'auto-evaluate': true }, 'auto'), true);
  assertSelfTest('auto-freeze legacy alias parses as auto', boolOption({ 'auto-freeze': true }, 'auto'), true);

  const controlRootSentinel = path.join(
    os.tmpdir(),
    `agent-loop-control-root-must-stay-host-only-${process.pid}-${Date.now()}`
  );
  const providerRunSentinel = path.join(
    os.tmpdir(),
    `agent-loop-provider-env-selftest-${process.pid}-${Date.now()}`
  );
  const providerInvocations = [
    buildClaudeProviderInvocation(
      { 'control-root': controlRootSentinel, 'skip-cli-schema': true },
      'spec',
      providerRunSentinel,
      'self-test',
      'agent-spec.schema.json'
    ),
    buildCodexProviderInvocation(
      { 'control-root': controlRootSentinel, 'skip-cli-schema': true },
      providerRunSentinel,
      'self-test',
      path.join(providerRunSentinel, 'last-message.json')
    ),
  ];
  const controlRootLeaked = providerInvocations.some((invocation) => (
    invocation.env.TP_AGENT_CONTROL_ROOT !== undefined
    || Object.values(invocation.env).includes(controlRootSentinel)
  ));
  assertSelfTest(
    'external control root is not exposed to provider environments',
    controlRootLeaked,
    false
  );

  const handoffTestDir = path.join(
    os.tmpdir(),
    `agent-loop-handoff-selftest-${process.pid}-${Date.now()}`
  );
  fs.mkdirSync(handoffTestDir, { recursive: true });
  try {
    writeJson(path.join(handoffTestDir, 'spec.json'), { frozen: true });
    const handoffArtifact = { summary: 'done' };
    const validationArtifact = { status: 'passed', commands: [] };
    const changedFilesArtifact = [];
    const diffArtifact = 'Not a git repository; diff unavailable.\n';
    writeJson(path.join(handoffTestDir, 'handoff.json'), handoffArtifact);
    writeJson(
      path.join(handoffTestDir, 'validation.json'),
      validationArtifact
    );
    writeJson(path.join(handoffTestDir, 'changed-files.json'), changedFilesArtifact);
    writeText(path.join(handoffTestDir, 'diff.patch'), diffArtifact);
    const contractHash = providerProfiles.hash(
      readText(path.join(handoffTestDir, 'spec.json'))
    );
    const stageControl = nativeExecutionControl.buildStageControl({
      options: {},
      runId: 'handoff-selftest',
      stage: 'implementation',
      providerKey: 'implementation',
      intent: 'write',
      payload: { contractHash },
      capabilityEvidence: nativeExecutionControl.observedAdapterEvidence(
        'implementation',
        {
          runtimeObserved: {
            stdin: true,
            'structured-output': true,
            'repo-read': true,
            'workspace-write': true,
          },
          observedAt: nowIso(),
          source: 'self-test-capability-probe',
        }
      ),
    });
    const accepted = nativeExecutionControl.createAttemptResult({
      stageControl,
      ref: 'result:handoff-selftest',
      status: 'succeeded',
      effects: {
        state: 'committed',
        refs: [providerProfiles.hash('selftest-diff')],
      },
      runtimeRefs: {
        codexThread: 'thread-selftest',
        codexTurn: 'turn-selftest',
      },
      nativeResult: {
        runtime: 'codex',
        adapter: 'codex-exec',
        status: 'succeeded',
        nativeAccepted: true,
        terminalEvidence: {
          observed: true,
          event: 'turn.completed',
          status: 'completed',
        },
        nativeAcceptanceErrors: [],
        runtimeRefs: {
          threadId: 'thread-selftest',
          turnId: 'turn-selftest',
        },
      },
      evidence: {
        handoffHash: providerProfiles.hash(handoffArtifact),
        diffHash: providerProfiles.hash(diffArtifact),
        validationHash: providerProfiles.hash(validationArtifact),
        changedFilesHash: providerProfiles.hash(changedFilesArtifact),
        baseSha: null,
        headSha: null,
      },
      payload: handoffArtifact,
    });
    const handoffState = {
      runId: 'handoff-selftest',
      orchestrationOwner: 'tp',
      workdir: handoffTestDir,
      files: {},
    };
    const attempt = {
      ...stageControl,
      prefix: 'implementation.selftest',
    };
    writeProviderHandoffBundle(
      handoffState,
      handoffTestDir,
      {},
      attempt,
      accepted
    );
    const validated = validateProviderHandoffBundle(
      handoffState,
      handoffTestDir,
      {}
    );
    assertSelfTest('provider handoff validates hash-bound evidence', validated.handoff.readOnly, true);
    validated.handoff.hash = providerProfiles.hash('tampered');
    writeJson(path.join(handoffTestDir, 'provider-handoff.json'), validated);
    let tamperedHandoffThrew = false;
    try {
      validateProviderHandoffBundle(handoffState, handoffTestDir, {});
    } catch (_) {
      tamperedHandoffThrew = true;
    }
    assertSelfTest('provider handoff rejects tampering', tamperedHandoffThrew, true);
  } finally {
    fs.rmSync(handoffTestDir, { recursive: true, force: true });
  }

  // ADR-008 backward-compat: state.json from pre-caveman-audit may lack these fields.
  const legacyState = applyStateDefaults({ runId: 'old-run', status: 'frozen' });
  assertSelfTest('legacy state gains providerRuns default', Array.isArray(legacyState.providerRuns) && legacyState.providerRuns.length === 0, true);
  assertSelfTest('legacy state gains files default', legacyState.files && typeof legacyState.files === 'object' && !Array.isArray(legacyState.files), true);
  const stateWithFilesArray = applyStateDefaults({ files: ['a'], providerRuns: 'oops' });
  assertSelfTest('files array is coerced to object', Array.isArray(stateWithFilesArray.files), false);
  assertSelfTest('non-array providerRuns is reset', Array.isArray(stateWithFilesArray.providerRuns), true);
  const preserveState = applyStateDefaults({ providerRuns: [{ phase: 'spec' }], files: { spec: 'spec.json' } });
  assertSelfTest('existing providerRuns preserved', preserveState.providerRuns[0].phase, 'spec');
  assertSelfTest('existing files preserved', preserveState.files.spec, 'spec.json');
  // Reject non-object state explicitly (CORR-5): null/primitive state.json must not
  // silently produce a state object that fails downstream property access.
  let nullThrew = false;
  try { applyStateDefaults(null); } catch { nullThrew = true; }
  assertSelfTest('null state throws explicit error', nullThrew, true);
  let undefThrew = false;
  try { applyStateDefaults(undefined); } catch { undefThrew = true; }
  assertSelfTest('undefined state throws explicit error', undefThrew, true);
  let arrayThrew = false;
  try { applyStateDefaults([]); } catch { arrayThrew = true; }
  assertSelfTest('top-level array state throws explicit error', arrayThrew, true);
  let stringThrew = false;
  try { applyStateDefaults('frozen'); } catch { stringThrew = true; }
  assertSelfTest('primitive string state throws explicit error', stringThrew, true);
  // Mutate-in-place contract: loadRun expects same reference back so downstream
  // mutations propagate to saveState. Verify identity, not just value equality.
  const inputRef = { runId: 'r1', status: 'frozen' };
  const outputRef = applyStateDefaults(inputRef);
  assertSelfTest('applyStateDefaults returns same reference', outputRef === inputRef, true);
  assertSelfTest('mutate-in-place: input gained providerRuns', Array.isArray(inputRef.providerRuns), true);
  // Strengthen T7: confirm coerced files is actually {}, not arbitrary truthy non-array
  assertSelfTest('files array dropped to empty object', JSON.stringify(stateWithFilesArray.files), '{}');

  const directBusinessJson = extractJsonValue(JSON.stringify({
    result: 'Implementation completed without structured wrapper.',
    files: ['scripts/example.js'],
    followUpTasks: ['Run full validation later'],
  }));
  const normalizedHandoff = normalizeHandoff(directBusinessJson);
  assertSelfTest('business result field is not treated as wrapper', normalizedHandoff.summary, 'Implementation completed without structured wrapper.');
  assertSelfTest('handoff files alias normalizes', normalizedHandoff.changedFiles[0], 'scripts/example.js');

  const nestedContent = extractJsonValue(JSON.stringify({
    message: {
      content: [
        { text: '{"decision":"approved","compliant":true,"findings":[],"followUpTasks":[]}' },
      ],
    },
  }));
  assertSelfTest('message.content array unwraps JSON', nestedContent.decision, 'approved');
  assertSelfTest('handoff schema uses strict objects', schemaHasStrictObjects(readJson(schemaPath('agent-handoff.schema.json'))), true);

  runPipelineSelfTests();

  console.log('[OK] self-test passed');
}

function runPipelineSelfTests() {
  for (const schemaName of [
    'global-contract.schema.json',
    'pipeline-slice.schema.json',
    'pipeline-slice-batch.schema.json',
    'contract-revision.schema.json',
  ]) {
    assertSelfTest(`pipeline provider schema is strict ${schemaName}`, schemaHasStrictObjects(readJson(schemaPath(schemaName))), true);
  }
  for (const schemaName of [
    'pipeline-queue.schema.json',
    'pipeline-locks.schema.json',
    'drift-report.schema.json',
  ]) {
    const parsed = readJson(schemaPath(schemaName));
    assertSelfTest(`internal artifact schema parses ${schemaName}`, parsed.$id.includes('agent-loop'), true);
  }

  assertSelfTest('pipeline run transitions: draft -> global-contract-ready',
    pipelineState.isValidRunTransition('draft', 'global-contract-ready'), true);
  assertSelfTest('pipeline run transitions: executing-slices -> integration-ready',
    pipelineState.isValidRunTransition('executing-slices', 'integration-ready'), true);
  assertSelfTest('pipeline run transitions: completed has no successor',
    pipelineState.isValidRunTransition('completed', 'executing-slices'), false);
  assertSelfTest('pipeline slice transitions: pending -> ready',
    pipelineState.isValidSliceTransition('slice-pending', 'slice-ready'), true);
  assertSelfTest('pipeline slice transitions: pending -> rejected supersede',
    pipelineState.isValidSliceTransition('slice-pending', 'slice-rejected'), true);
  assertSelfTest('pipeline slice transitions: ready -> rejected supersede',
    pipelineState.isValidSliceTransition('slice-ready', 'slice-rejected'), true);
  assertSelfTest('pipeline slice transitions: frozen -> rejected branch',
    pipelineState.isValidSliceTransition('slice-frozen', 'slice-rejected'), true);
  assertSelfTest('pipeline slice transitions: implementing -> implementation-failed',
    pipelineState.isValidSliceTransition('slice-implementing', 'slice-implementation-failed'), true);
  assertSelfTest('pipeline slice transitions: implementation-failed -> ready retry',
    pipelineState.isValidSliceTransition('slice-implementation-failed', 'slice-ready'), true);
  assertSelfTest('pipeline slice transitions: completed has no successor',
    pipelineState.isValidSliceTransition('slice-completed', 'slice-implementing'), false);

  const contractA = globalContractModule.normalizeGlobalContract({
    goal: 'g', nonGoals: ['x'], globalAcceptance: ['a'],
    architectureConstraints: ['c'], runtimeTargets: ['claude-code', 'codex'],
    riskLevel: 'L2', blockingQuestions: ['q1'],
  });
  const contractB = globalContractModule.normalizeGlobalContract({
    goal: 'g', nonGoals: ['x'], globalAcceptance: ['a'],
    architectureConstraints: ['c'], runtimeTargets: ['claude-code', 'codex'],
    riskLevel: 'L2', blockingQuestions: ['totally different'],
  });
  assertSelfTest('contractHash excludes blockingQuestions', contractA.contractHash, contractB.contractHash);

  const contractSorted = globalContractModule.normalizeGlobalContract({
    goal: 'g', nonGoals: ['b', 'a'], globalAcceptance: ['a'],
    architectureConstraints: ['c'], runtimeTargets: ['codex', 'claude-code'],
    riskLevel: 'L2', blockingQuestions: [],
  });
  const contractSortedFlip = globalContractModule.normalizeGlobalContract({
    goal: 'g', nonGoals: ['a', 'b'], globalAcceptance: ['a'],
    architectureConstraints: ['c'], runtimeTargets: ['claude-code', 'codex'],
    riskLevel: 'L2', blockingQuestions: [],
  });
  assertSelfTest('contractHash canonical sorts arrays', contractSorted.contractHash, contractSortedFlip.contractHash);

  const l4Slice = sliceNormalizerModule.rejectIfUnsafe(
    sliceNormalizerModule.normalizeSlice({
      id: 'slice-l4', title: 'too risky', risk: 'L4', ownedFiles: ['x.js'],
      acceptanceCriteria: ['a'], doneCriteria: ['d'],
    }, { fallbackIndex: 0, globalContractHash: contractA.contractHash }),
  );
  assertSelfTest('L4 slice is rejected', l4Slice.rejected, true);

  const sensitiveSlice = sliceNormalizerModule.rejectIfUnsafe(
    sliceNormalizerModule.normalizeSlice({
      id: 'slice-auth', title: 'rewrite auth middleware', risk: 'L2', ownedFiles: ['auth.js'],
      acceptanceCriteria: ['ok'], doneCriteria: ['ok'],
    }, { fallbackIndex: 0, globalContractHash: contractA.contractHash }),
  );
  assertSelfTest('sensitive-area slice flagged auth', sensitiveSlice.sensitiveAreas.includes('auth'), true);
  assertSelfTest('sensitive-area slice rejected', sensitiveSlice.rejected, true);

  const safeSlice = sliceNormalizerModule.normalizeSlice({
    id: 'slice-001', title: 'simple', risk: 'L1', ownedFiles: ['a.js', 'b.js'],
    acceptanceCriteria: ['ok'], doneCriteria: ['ok'],
  }, { fallbackIndex: 0, globalContractHash: contractA.contractHash });
  const staticCheck = sliceNormalizerModule.evaluateStaticCanStart(safeSlice);
  assertSelfTest('safe slice passes static canStart', staticCheck.canStart, true);
  assertSelfTest('safe slice is auto-eligible', sliceNormalizerModule.isSliceSafeForAuto(safeSlice), true);

  const gateBase = path.join(os.tmpdir(), `agent-loop-gate-selftest-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(gateBase, 'src'), { recursive: true });
  const beforeEmpty = sliceRunnerModule.snapshotChangedFiles(gateBase, []);
  writeText(path.join(gateBase, 'src', 'allowed.js'), 'allowed\n');
  const afterAllowed = sliceRunnerModule.snapshotChangedFiles(gateBase, [{ status: '??', path: 'src/allowed.js' }]);
  const allowedGate = sliceRunnerModule.evaluateSliceChangedFiles(
    { id: 'slice-gate', ownedFiles: ['src/'] },
    beforeEmpty,
    afterAllowed
  );
  assertSelfTest('changed-files gate allows owned directory', allowedGate.ok, true);
  assertSelfTest('changed-files gate records touched owned file', allowedGate.allowedFiles[0], 'src/allowed.js');

  const outOfScopeGate = sliceRunnerModule.evaluateSliceChangedFiles(
    { id: 'slice-gate', ownedFiles: ['docs/'] },
    beforeEmpty,
    afterAllowed
  );
  assertSelfTest('changed-files gate blocks out-of-scope file', outOfScopeGate.ok, false);
  assertSelfTest('changed-files gate reports out-of-scope file', outOfScopeGate.outOfScopeFiles[0], 'src/allowed.js');

  writeText(path.join(gateBase, 'package-lock.json'), '{}\n');
  const afterGenerated = sliceRunnerModule.snapshotChangedFiles(gateBase, [{ status: '??', path: 'package-lock.json' }]);
  const generatedGate = sliceRunnerModule.evaluateSliceChangedFiles(
    { id: 'slice-gate', ownedFiles: ['src/'] },
    beforeEmpty,
    afterGenerated
  );
  assertSelfTest('changed-files gate classifies generated exception', generatedGate.exceptions[0].type, 'generated');
  assertSelfTest('changed-files gate allows generated exception', generatedGate.ok, true);

  writeText(path.join(gateBase, 'src', 'previous.js'), 'before\n');
  const beforeDirty = sliceRunnerModule.snapshotChangedFiles(gateBase, [{ status: ' M', path: 'src/previous.js' }]);
  writeText(path.join(gateBase, 'src', 'previous.js'), 'after\n');
  const afterDirty = sliceRunnerModule.snapshotChangedFiles(gateBase, [{ status: ' M', path: 'src/previous.js' }]);
  const touchedDirtyGate = sliceRunnerModule.evaluateSliceChangedFiles(
    { id: 'slice-current', ownedFiles: ['src/current.js'] },
    beforeDirty,
    afterDirty
  );
  assertSelfTest('changed-files gate catches edits to pre-existing dirty files', touchedDirtyGate.outOfScopeFiles[0], 'src/previous.js');
  fs.rmSync(gateBase, { recursive: true, force: true });

  let q = pipelineQueue.emptyQueue();
  q = pipelineQueue.moveToPending(q, 'slice-001');
  q = pipelineQueue.moveToReady(q, 'slice-001');
  q = pipelineQueue.moveToRunning(q, 'slice-001');
  q = pipelineQueue.moveToCompleted(q, 'slice-001');
  assertSelfTest('queue ends at completed', q.completed[0], 'slice-001');
  assertSelfTest('queue running cleared', q.running.length, 0);
  const qBlocked = pipelineQueue.moveToBlocked(pipelineQueue.emptyQueue(), 'slice-002', 'ownedFiles claimed');
  assertSelfTest('queue blocked records reason', qBlocked.blocked[0].reason, 'ownedFiles claimed');

  let locksState = pipelineLocks.emptyLocks();
  locksState = pipelineLocks.claimAll(locksState, { id: 'slice-001', ownedFiles: ['a.js'] });
  assertSelfTest('locks claimed', locksState.files['a.js'].status, 'claimed');
  locksState = pipelineLocks.markCompletedOwner(locksState, { id: 'slice-001', ownedFiles: ['a.js'] });
  assertSelfTest('locks completed-owner', locksState.files['a.js'].status, 'completed-owner');
  const denyClass = pipelineLocks.classifyClaim(locksState, { id: 'slice-002', ownedFiles: ['a.js'], dependsOn: [] });
  assertSelfTest('completed-owner blocks without dependsOn', denyClass.blockedBy.length, 1);
  const allowClass = pipelineLocks.classifyClaim(locksState, { id: 'slice-003', ownedFiles: ['a.js'], dependsOn: ['slice-001'] });
  assertSelfTest('completed-owner upgradable with dependsOn', allowClass.upgradable.length, 1);

  const driftReview = driftDetectorModule.classify(
    { source: 'slice-review', fields: { globalAcceptance: ['new'] }, rationale: 'breaking' },
    { contract: contractA, pendingSlices: [], completedSlices: [], runningSlices: [] },
  );
  assertSelfTest('drift breaking detected', driftReview.classification, 'breaking');

  const driftRecon = driftDetectorModule.classify(
    { source: 'slice-review', fields: { architectureConstraints: ['new'] }, rationale: 'recon attempted' },
    { contract: contractA, pendingSlices: [], completedSlices: [], runningSlices: [], reconciliationDepthOfSource: 1 },
  );
  assertSelfTest('reconciliation drift escalated to cross-cutting', driftRecon.classification, 'cross-cutting');

  const driftPending = driftDetectorModule.classify(
    { source: 'slice-planner-replan', fields: { runtimeTargets: ['claude-code'] }, rationale: 'pending only' },
    { contract: contractA, pendingSlices: ['slice-002'], completedSlices: [], runningSlices: [] },
  );
  assertSelfTest('drift pending-only', driftPending.classification, 'pending-only');

  const driftLocal = driftDetectorModule.classify(
    { source: 'slice-review', fields: { architectureConstraints: ['new'] }, rationale: 'local' },
    { contract: contractA, pendingSlices: [], completedSlices: ['slice-001'], runningSlices: [] },
  );
  assertSelfTest('drift completed-local', driftLocal.classification, 'completed-local');

  const reconSlice = reconciliationModule.generateReconciliationSlice({
    revision: { revisionId: 'rev-001', validationCommands: ['npm test'] },
    affectedSlices: ['slice-001'],
    affectedFiles: ['a.js'],
    fallbackIndex: 0,
    globalContractHash: contractA.contractHash,
  });
  assertSelfTest('reconciliation slice id prefix', reconSlice.id.startsWith('reconcile-'), true);
  assertSelfTest('reconciliation slice depth 1', reconSlice.depth, 1);

  const deepRecon = reconciliationModule.ensureDepthLimit({ ...reconSlice, depth: 2 });
  assertSelfTest('reconciliation depth >1 rejected', deepRecon.rejected, true);

  const cleanedRecursive = reconciliationModule.rejectRecursiveRevision({
    sliceId: 'reconcile-001',
    contractRevisions: [{ revisionId: 'rev-002', fields: { goal: 'change' } }],
  });
  assertSelfTest('reconciliation revisions stripped', cleanedRecursive.contractRevisions.length, 0);
  assertSelfTest('reconciliation revisions captured for audit', cleanedRecursive.recursiveRevisionsBlocked.length, 1);

  const aggregated = reviewModule.aggregateIntegrationValidationCommands(
    { integrationValidationCommands: ['npm run lint'] },
    [{ validationCommands: ['npm test'] }, { validationCommands: ['npm test', 'npm run typecheck'] }],
  );
  assertSelfTest('integration validation deduped', aggregated.length, 4);
  assertSelfTest('integration validation order: global first', aggregated[0], 'npm run lint');
  assertSelfTest('integration validation builtin tail', aggregated[aggregated.length - 1], 'git diff --check');

  let illegalThrown = false;
  try {
    driftDetectorModule.classify({ source: 'user-edit', fields: { goal: 'g' } }, { contract: contractA });
  } catch (error) {
    illegalThrown = true;
  }
  assertSelfTest('drift source whitelist enforced', illegalThrown, true);

  const planState = pipeline.newPipelineState('/tmp/work', '/tmp/work/.agent-runs/x', 'x', 'requirement');
  assertSelfTest('newPipelineState mode pipeline', planState.mode, 'pipeline');
  assertSelfTest('newPipelineState initial status', planState.status, 'draft');
  const runTransitionState = pipelineState.transitionRun(planState, pipelineState.RUN_STATES.GLOBAL_CONTRACT_READY, {
    actor: 'self-test',
    source: 'pipeline-state-test',
    reason: 'exercise run transition helper',
  });
  const runTransitionEvent = runTransitionState.pipeline.transitionEvents[0];
  assertSelfTest('pipeline-state transition event records from', runTransitionEvent.from, 'draft');
  assertSelfTest('pipeline-state transition event records to', runTransitionEvent.to, 'global-contract-ready');
  assertSelfTest('pipeline-state transition event records actor', runTransitionEvent.actor, 'self-test');
  assertSelfTest('pipeline-state transition event records source', runTransitionEvent.source, 'pipeline-state-test');
  assertSelfTest('pipeline-state transition event records reason', runTransitionEvent.reason, 'exercise run transition helper');
  const sliceTransitionState = pipelineState.transitionSlice(runTransitionState, 'slice-selftest', pipelineState.SLICE_STATES.READY, {
    actor: 'self-test',
    source: 'pipeline-state-test',
    reason: 'exercise slice transition helper',
  });
  const sliceTransitionEvent = sliceTransitionState.pipeline.transitionEvents[1];
  assertSelfTest('pipeline-state slice event records sliceId', sliceTransitionEvent.sliceId, 'slice-selftest');
  const providerSource = readText(path.join(__dirname, 'agent-orchestrator', 'pipeline-providers.js'));
  assertSelfTest('provider module avoids direct terminal slice state writes',
    /sliceStates\s*:\s*\{/.test(providerSource), false);
  assertSelfTest('provider module avoids direct run status writes',
    /status:\s*['"](global-contract-ready|integration-ready|executing-slices|contract-conflict|completed)['"]/.test(providerSource), false);

  runProviderIntegrationSelfTests();
}

function runProviderIntegrationSelfTests() {
  const providers = require('./agent-orchestrator/pipeline-providers');
  const tmpBase = path.join(os.tmpdir(), `agent-loop-selftest-${process.pid}-${Date.now()}`);
  const mockWorkdir = path.join(tmpBase, 'workdir');
  fs.mkdirSync(path.join(tmpBase, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(tmpBase, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(tmpBase, 'slices'), { recursive: true });
  fs.mkdirSync(mockWorkdir, { recursive: true });

  const gitCommands = [
    ['init'],
    ['config', 'user.email', 'agent-loop-selftest@example.invalid'],
    ['config', 'user.name', 'Agent Loop Self Test'],
  ];
  for (const args of gitCommands) {
    const outcome = spawnSync('git', args, { cwd: mockWorkdir, encoding: 'utf8', shell: false });
    if (outcome.status !== 0) {
      throw new Error(`self-test git ${args.join(' ')} failed: ${outcome.stderr || outcome.stdout || 'unknown error'}`);
    }
  }
  writeText(path.join(mockWorkdir, 'baseline.txt'), 'baseline\n');
  for (const args of [['add', 'baseline.txt'], ['commit', '-m', 'test: initialize provider fixture']]) {
    const outcome = spawnSync('git', args, { cwd: mockWorkdir, encoding: 'utf8', shell: false });
    if (outcome.status !== 0) {
      throw new Error(`self-test git ${args.join(' ')} failed: ${outcome.stderr || outcome.stdout || 'unknown error'}`);
    }
  }

  let stateObj = pipeline.newPipelineState(mockWorkdir, tmpBase, 'selftest', 'a provider integration self-test requirement');
  const statePath = path.join(tmpBase, 'state.json');
  writeJson(statePath, stateObj);
  writeText(
    path.join(tmpBase, 'prompts', 'global-contract.md'),
    'mock prompt for global contract',
  );

  const mockCtx = buildMockCtx(mockWorkdir);
  mockCtx.currentGitSha = currentGitSha;
  mockCtx.isGitRepository = isGitRepository;
  mockCtx.writeGitDiff = writeGitDiff;
  mockCtx.listChangedFiles = listChangedFiles;
  let calls = 0;
  mockCtx.runProcess = (label, launchOrCommand, args, settings) => {
    calls += 1;
    const stdout = mockCtx._stdoutQueue.shift() || '{}';
    if (settings && settings.stdoutFile) writeText(settings.stdoutFile, stdout);
    if (settings && settings.stderrFile) writeText(settings.stderrFile, '');
    return {
      result: { status: 0, stdout, stderr: '' },
      record: {
        label, args, cwd: settings ? settings.cwd : null,
        stdoutFile: settings && settings.stdoutFile, stderrFile: settings && settings.stderrFile,
        status: 0, startedAt: 'mock', finishedAt: 'mock',
      },
    };
  };
  mockCtx._stdoutQueue = [
    JSON.stringify({
      version: 'global-v1',
      goal: 'Mock provider integration goal',
      nonGoals: ['no implementation in this self-test'],
      globalAcceptance: ['providers wire through ctx'],
      architectureConstraints: ['mock only'],
      runtimeTargets: ['claude-code', 'codex'],
      riskLevel: 'L1',
      blockingQuestions: [],
    }),
  ];

  stateObj = providers.runGlobalContractProvider(mockCtx, stateObj, statePath, tmpBase, {});
  assertSelfTest('provider integration: global contract written', fs.existsSync(path.join(tmpBase, 'global-contract.json')), true);
  assertSelfTest('provider integration: status global-contract-ready', stateObj.status, 'global-contract-ready');
  assertSelfTest('provider integration: providerRuns appended', Array.isArray(stateObj.providerRuns) && stateObj.providerRuns.length === 1, true);
  const providerContractsDir = path.join(tmpBase, 'contracts');
  const firstTurnJournalName = fs.readdirSync(providerContractsDir)
    .find((name) => name.endsWith('.turn-journal.json'));
  assertSelfTest('provider integration: turn journal written', Boolean(firstTurnJournalName), true);
  const firstTurnReceipt = turnTransaction.replayTurnJournal(
    turnTransaction.readTurnJournal(path.join(providerContractsDir, firstTurnJournalName))
  );
  assertSelfTest('provider integration: durable writeback receipted',
    firstTurnReceipt.currentPhase, 'durable-writeback');
  assertSelfTest('provider integration: scheduler apply is not fabricated',
    firstTurnReceipt.nextPhase, 'scheduler-apply');
  const firstTaskName = fs.readdirSync(providerContractsDir)
    .find((name) => name.endsWith('.task.json'));
  const firstTask = readJson(path.join(providerContractsDir, firstTaskName));
  assertSelfTest('provider integration: typed coordination attached',
    firstTask.coordination.taskClass, 'provider-stage');


  stateObj = { ...stateObj, status: 'planning-slices' };
  writeJson(statePath, stateObj);
  mockCtx._stdoutQueue.push(
    JSON.stringify({
      slices: [{
        id: 'slice-001',
        title: 'mock slice',
        dependsOn: [],
        ownedFiles: ['mock.txt'],
        readFiles: [],
        risk: 'L1',
        acceptanceCriteria: ['mock ok'],
        doneCriteria: ['mock done'],
        validationCommands: ['git diff --check'],
        questions: [],
      }],
    }),
  );
  stateObj = providers.runSlicePlannerProvider(mockCtx, stateObj, statePath, tmpBase, {});
  assertSelfTest('provider integration: slice planner wrote slice-001', fs.existsSync(path.join(tmpBase, 'slices', 'slice-001', 'slice.json')), true);
  assertSelfTest('provider integration: slice state advanced to ready', stateObj.pipeline.sliceStates['slice-001'], 'slice-ready');
  assertSelfTest('provider integration: status executing-slices', stateObj.status, 'executing-slices');

  const slice = require('./agent-orchestrator/slice-planner').loadSlice(tmpBase, 'slice-001');
  stateObj = pipelineState.transitionSlice(stateObj, slice.id, pipelineState.SLICE_STATES.FROZEN, {
    source: 'self-test',
    reason: 'simulate slice freeze before implementation',
  });
  stateObj = pipelineState.transitionSlice(stateObj, slice.id, pipelineState.SLICE_STATES.IMPLEMENTING, {
    source: 'self-test',
    reason: 'simulate slice dispatch before implementation',
  });
  writeJson(statePath, stateObj);
  const originalRunProcess = mockCtx.runProcess;
  mockCtx.runProcess = (label, launchOrCommand, args, settings) => {
    const outcome = originalRunProcess(label, launchOrCommand, args, settings);
    if (String(label).includes('slice impl provider')) {
      writeText(path.join(mockWorkdir, 'mock.txt'), 'implemented\n');
      const staged = spawnSync('git', ['add', 'mock.txt'], {
        cwd: mockWorkdir,
        encoding: 'utf8',
        shell: false,
      });
      if (staged.status !== 0) {
        throw new Error(`self-test failed to stage mock.txt: ${staged.stderr || staged.stdout || 'unknown error'}`);
      }
    }
    return outcome;
  };
  mockCtx._stdoutQueue.push(JSON.stringify({
    summary: 'implemented mock slice',
    changedFiles: ['mock.txt'],
    validation: [],
    risks: [],
    followUp: [],
  }));
  stateObj = providers.runSliceImplementationProvider(mockCtx, stateObj, statePath, tmpBase, {}, slice);
  assertSelfTest('provider integration: slice implementation advanced to implemented',
    stateObj.pipeline.sliceStates['slice-001'], 'slice-implemented');
  assertSelfTest('provider integration: changed-files gate written',
    fs.existsSync(path.join(tmpBase, 'slices', 'slice-001', 'changed-files-gate.json')), true);
  assertSelfTest('provider integration: changed-files artifact is slice scoped',
    fs.existsSync(path.join(tmpBase, 'slices', 'slice-001', 'changed-files.json')), true);
  assertSelfTest('provider integration: changed-files gate passed',
    JSON.parse(fs.readFileSync(path.join(tmpBase, 'slices', 'slice-001', 'changed-files-gate.json'), 'utf8')).ok, true);
  assertSelfTest('provider integration: agent assignment is slice scoped',
    fs.existsSync(path.join(tmpBase, 'slices', 'slice-001', 'agent-assignment.json')), true);
  assertSelfTest('provider integration: agent invocation is slice scoped',
    fs.existsSync(path.join(tmpBase, 'slices', 'slice-001', 'agent-invocation.json')), true);
  const assignmentArtifact = JSON.parse(fs.readFileSync(
    path.join(tmpBase, 'slices', 'slice-001', 'agent-assignment.json'),
    'utf8'
  ));
  const invocationArtifact = JSON.parse(fs.readFileSync(
    path.join(tmpBase, 'slices', 'slice-001', 'agent-invocation.json'),
    'utf8'
  ));
  assertSelfTest('provider integration: assignment uses the implementer role',
    assignmentArtifact.role, 'tp_implementer');
  assertSelfTest('provider integration: CLI invocation remains contract-enforced',
    invocationArtifact.enforcement, 'contract-enforced');
  assertSelfTest('provider integration: CLI invocation does not claim a native role',
    invocationArtifact.actualRole, null);

  writeText(path.join(mockWorkdir, 'mock.txt'), 'tampered staged content\n');
  spawnSync('git', ['add', 'mock.txt'], { cwd: mockWorkdir, encoding: 'utf8', shell: false });
  let stagedTamperRejected = false;
  try {
    mockCtx.validateProviderHandoffBundle(stateObj, tmpBase, {}, {
      relativeFile: path.join('slices', slice.id, 'provider-handoff.json'),
      expectedContractHash: globalContractModule.loadGlobalContract(tmpBase).contractHash,
    });
  } catch (error) {
    stagedTamperRejected = /diffHash is stale/.test(error.message);
  }
  assertSelfTest('provider integration: staged index tampering invalidates handoff diff hash', stagedTamperRejected, true);
  writeText(path.join(mockWorkdir, 'mock.txt'), 'implemented\n');
  spawnSync('git', ['add', 'mock.txt'], { cwd: mockWorkdir, encoding: 'utf8', shell: false });

  const reviewApprovedRaw = JSON.stringify({
    decision: 'approved',
    compliant: true,
    contractRevisions: [],
    findings: [],
    followUpTasks: [],
  });
  mockCtx._stdoutQueue.push(reviewApprovedRaw);
  const locksModule = require('./agent-orchestrator/locks');
  locksModule.saveLocks(tmpBase, locksModule.claimAll(locksModule.loadLocks(tmpBase), slice));
  const stateBeforeApprovedReview = stateObj;
  const reviewOutcome = providers.runSliceReviewProvider(mockCtx, stateObj, statePath, tmpBase, {}, slice);
  assertSelfTest('provider integration: approved slice marked completed', reviewOutcome.state.pipeline.sliceStates['slice-001'], 'slice-completed');
  assertSelfTest('provider integration: completed-owner lock', JSON.parse(fs.readFileSync(path.join(tmpBase, 'locks.json'), 'utf8')).files['mock.txt'].status, 'completed-owner');

  stateObj = stateBeforeApprovedReview;
  writeJson(statePath, stateObj);
  pipelineQueue.saveQueue(tmpBase, pipelineQueue.moveToRunning(pipelineQueue.emptyQueue(), slice.id));
  const reviewBreakingRaw = JSON.stringify({
    decision: 'changes_requested',
    compliant: false,
    findings: [],
    followUpTasks: ['resolve the breaking contract revision'],
    contractRevisions: [{ revisionId: 'rev-001', fields: { goal: 'new goal' }, rationale: 'breaking shift' }],
  });
  mockCtx._stdoutQueue.push(reviewBreakingRaw);
  const breakingOutcome = providers.runSliceReviewProvider(mockCtx, stateObj, statePath, tmpBase, {}, slice);
  assertSelfTest('provider integration: breaking revision enters contract-conflict', breakingOutcome.state.status, 'contract-conflict');
  assertSelfTest('provider integration: breaking drift recorded', breakingOutcome.drift[0].classification, 'breaking');

  const failureBase = path.join(os.tmpdir(), `agent-loop-selftest-failure-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(failureBase, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(failureBase, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(failureBase, 'slices'), { recursive: true });
  let failureState = pipeline.newPipelineState(failureBase, failureBase, 'selftest-failure', 'provider failure requirement');
  const failureStatePath = path.join(failureBase, 'state.json');
  const failureContract = pipeline.dryRunGlobalContract('provider failure');
  globalContractModule.writeGlobalContract(failureBase, failureContract, 'self-test');
  const failureSlice = sliceNormalizerModule.normalizeSlice({
    id: 'slice-failure',
    title: 'mock failure slice',
    dependsOn: [],
    ownedFiles: ['failure.txt'],
    readFiles: [],
    risk: 'L1',
    acceptanceCriteria: ['failure is blocked'],
    doneCriteria: ['failure is recorded'],
    validationCommands: [],
    questions: [],
  }, { fallbackIndex: 0, globalContractHash: failureContract.contractHash });
  slicePlannerModule.writeSliceArtifacts(failureBase, failureSlice);
  pipelineQueue.saveQueue(failureBase, pipelineQueue.moveToReady(pipelineQueue.emptyQueue(), failureSlice.id));
  failureState = {
    ...failureState,
    status: 'executing-slices',
    pipeline: {
      ...failureState.pipeline,
      sliceStates: { [failureSlice.id]: 'slice-frozen' },
    },
  };
  writeJson(failureStatePath, failureState);
  const failureCtx = buildMockCtx(failureBase);
  failureCtx.runProcess = (label, launchOrCommand, args, settings) => {
    if (settings && settings.stdoutFile) writeText(settings.stdoutFile, '');
    if (settings && settings.stderrFile) writeText(settings.stderrFile, 'mock failure');
    const error = new Error('mock implementation provider failure');
    error.providerRecord = {
      label,
      args,
      cwd: settings ? settings.cwd : null,
      stdoutFile: settings && settings.stdoutFile,
      stderrFile: settings && settings.stderrFile,
      status: 1,
      startedAt: 'mock',
      finishedAt: 'mock',
    };
    throw error;
  };
  const failureControlRoot = `${failureBase}-control`;
  const failedState = pipeline.resumePipelineRun(failureCtx, {
    'control-root': failureControlRoot,
  }, []);
  assertSelfTest('provider integration: implementation failure state recorded',
    failedState.pipeline.sliceStates[failureSlice.id], 'slice-implementation-failed');
  const failedQueue = pipelineQueue.loadQueue(failureBase);
  assertSelfTest('provider integration: implementation failure blocks queue',
    failedQueue.blocked[0].sliceId, failureSlice.id);
  const failedLocks = pipelineLocks.loadLocks(failureBase);
  assertSelfTest('provider integration: implementation failure releases locks',
    failedLocks.files['failure.txt'].status, 'released');
  assertSelfTest('provider integration: failure artifact written',
    fs.existsSync(path.join(failureBase, 'slices', failureSlice.id, 'implementation-failure.json')), true);
  assertSelfTest('provider integration: failure history written',
    fs.existsSync(path.join(failureBase, 'pipeline.history.jsonl')), true);
  assertSelfTest('provider integration: failed provider run recorded',
    Array.isArray(failedState.providerRuns) && failedState.providerRuns.length === 1, true);
  fs.rmSync(failureBase, { recursive: true, force: true });
  fs.rmSync(failureControlRoot, { recursive: true, force: true });

  const resolveBase = path.join(os.tmpdir(), `agent-loop-selftest-resolve-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(resolveBase, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(resolveBase, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(resolveBase, 'slices'), { recursive: true });
  const resolveStatePath = path.join(resolveBase, 'state.json');
  const resolveContract = globalContractModule.writeGlobalContract(
    resolveBase,
    pipeline.dryRunGlobalContract('resolve contract'),
    'self-test'
  );
  const completedSlice = sliceNormalizerModule.normalizeSlice({
    id: 'slice-completed',
    title: 'completed slice',
    ownedFiles: ['completed.txt'],
    acceptanceCriteria: ['done'],
    doneCriteria: ['done'],
  }, { fallbackIndex: 0, globalContractHash: resolveContract.contractHash });
  const pendingSlice = sliceNormalizerModule.normalizeSlice({
    id: 'slice-pending',
    title: 'pending slice',
    ownedFiles: ['pending.txt'],
    acceptanceCriteria: ['pending'],
    doneCriteria: ['pending'],
  }, { fallbackIndex: 1, globalContractHash: resolveContract.contractHash });
  slicePlannerModule.writeSliceArtifacts(resolveBase, completedSlice);
  slicePlannerModule.writeSliceArtifacts(resolveBase, pendingSlice);
  let resolveQueue = pipelineQueue.emptyQueue();
  resolveQueue = pipelineQueue.moveToCompleted(resolveQueue, completedSlice.id);
  resolveQueue = pipelineQueue.moveToReady(resolveQueue, pendingSlice.id);
  pipelineQueue.saveQueue(resolveBase, resolveQueue);
  globalContractModule.appendRevisionEvent(resolveBase, {
    revisionId: 'rev-accept',
    source: 'slice-review',
    sourceSliceId: completedSlice.id,
    fields: { architectureConstraints: ['revised constraint'] },
    rationale: 'self-test accept revision',
    classification: 'completed-local',
    resolution: 'pending',
  });
  driftDetectorModule.writeDriftReport(resolveBase, [{
    revisionId: 'rev-accept',
    classification: 'completed-local',
    reason: 'self-test',
    impact: { pendingSlices: [pendingSlice.id], completedSlices: [completedSlice.id] },
    action: 'create-reconciliation-slice',
  }], resolveContract.contractHash);
  let resolveState = pipeline.newPipelineState(resolveBase, resolveBase, 'selftest-resolve', 'resolve requirement');
  resolveState = {
    ...resolveState,
    status: 'contract-conflict',
    pipeline: {
      ...resolveState.pipeline,
      sliceStates: {
        [completedSlice.id]: 'slice-completed',
        [pendingSlice.id]: 'slice-ready',
      },
      conflictRevisionIds: ['rev-accept'],
    },
  };
  writeJson(resolveStatePath, resolveState);
  const resolveControlRoot = `${resolveBase}-control`;
  const resolvedState = pipeline.resumePipelineRun(buildMockCtx(resolveBase), {
    resolve: 'accept-revision',
    revision: 'rev-accept',
    'control-root': resolveControlRoot,
  }, []);
  assertSelfTest('provider integration: accept revision resumes execution', resolvedState.status, 'executing-slices');
  assertSelfTest('provider integration: accept revision applies contract',
    globalContractModule.loadGlobalContract(resolveBase).architectureConstraints[0], 'revised constraint');
  assertSelfTest('provider integration: accept revision supersedes pending slice',
    resolvedState.pipeline.sliceStates[pendingSlice.id], 'slice-rejected');
  const reconcileIds = slicePlannerModule.listSliceIds(resolveBase).filter((id) => id.startsWith('reconcile-'));
  assertSelfTest('provider integration: accept revision creates reconciliation slice', reconcileIds.length, 1);
  const acceptedEvent = globalContractModule.loadRevisionEvents(resolveBase).find((event) =>
    event.revisionId === 'rev-accept' && event.resolution === 'accepted'
  );
  assertSelfTest('provider integration: accept revision records applied hash',
    Boolean(acceptedEvent && acceptedEvent.appliedContractHash), true);
  fs.rmSync(resolveBase, { recursive: true, force: true });
  fs.rmSync(resolveControlRoot, { recursive: true, force: true });

  const rejectBase = path.join(os.tmpdir(), `agent-loop-selftest-reject-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(rejectBase, 'slices'), { recursive: true });
  const rejectStatePath = path.join(rejectBase, 'state.json');
  const rejectContract = globalContractModule.writeGlobalContract(
    rejectBase,
    pipeline.dryRunGlobalContract('reject contract'),
    'self-test'
  );
  globalContractModule.appendRevisionEvent(rejectBase, {
    revisionId: 'rev-reject',
    source: 'slice-review',
    fields: { goal: 'should not apply' },
    rationale: 'self-test reject revision',
    classification: 'breaking',
    resolution: 'pending',
  });
  pipelineQueue.saveQueue(rejectBase, pipelineQueue.emptyQueue());
  let rejectState = pipeline.newPipelineState(rejectBase, rejectBase, 'selftest-reject', 'reject requirement');
  rejectState = {
    ...rejectState,
    status: 'contract-conflict',
    pipeline: { ...rejectState.pipeline, conflictRevisionIds: ['rev-reject'] },
  };
  writeJson(rejectStatePath, rejectState);
  const rejectControlRoot = `${rejectBase}-control`;
  const rejectedState = pipeline.resumePipelineRun(buildMockCtx(rejectBase), {
    resolve: 'reject-revision',
    revision: 'rev-reject',
    reason: 'self-test says no',
    'control-root': rejectControlRoot,
  }, []);
  assertSelfTest('provider integration: reject revision resumes execution', rejectedState.status, 'executing-slices');
  assertSelfTest('provider integration: reject revision leaves contract unchanged',
    globalContractModule.loadGlobalContract(rejectBase).contractHash, rejectContract.contractHash);
  const rejectedEvent = globalContractModule.loadRevisionEvents(rejectBase).find((event) =>
    event.revisionId === 'rev-reject' && event.resolution === 'rejected'
  );
  assertSelfTest('provider integration: reject revision records reason',
    rejectedEvent && rejectedEvent.reason, 'self-test says no');
  fs.rmSync(rejectBase, { recursive: true, force: true });
  fs.rmSync(rejectControlRoot, { recursive: true, force: true });

  fs.rmSync(tmpBase, { recursive: true, force: true });
}

function buildMockCtx(workdir) {
  return {
    log: () => {},
    warn: () => {},
    error: () => {},
    optionValue: (options, key) => options ? options[key] : undefined,
    optionValues: (options, key) => options && Array.isArray(options[key]) ? options[key] : [],
    boolOption: () => false,
    resolveWorkdir: () => workdir,
    resolveRunsDir: () => workdir,
    readRequirement: () => 'mock requirement',
    dateStamp,
    slugify,
    loadRun: () => ({ runDir: workdir, statePath: path.join(workdir, 'state.json'), state: readJson(path.join(workdir, 'state.json')) }),
    buildPreflightReport: () => ({ ok: true, checks: [] }),
    writePreflight: () => {},
    assertPreflight: () => {},
    printPreflight: () => {},
    runProcess: () => { throw new Error('mock runProcess not set'); },
    runShell: () => ({ status: 0, startedAt: 'mock', finishedAt: 'mock' }),
    runValidatedCommand: () => ({ status: 0, startedAt: 'mock', finishedAt: 'mock' }),
    providerLaunch: () => ({ command: 'mock', argsPrefix: [], shell: false }),
    providerCommandSpec: () => 'mock',
    providerTimeoutMs: () => 60000,
    codexSandboxMode: () => null,
    claudeProviderEnv: () => ({}),
    buildClaudeProviderInvocation: (options, providerKey, runDir, prompt, schemaName) => ({
      runtime: 'claude',
      adapter: 'claude-print',
      launch: { command: 'mock', argsPrefix: [], shell: false },
      args: ['-p', '--input-format', 'text', '--output-format', 'json'],
      cwd: workdir,
      stdin: prompt,
      env: runtimeAdapters.managedRunEnv('claude', { TP_AGENT_RUN_DIR: runDir }),
      schemaPath: schemaPath(schemaName),
    }),
    buildCodexProviderInvocation: (options, runDir, prompt, lastMessageFile) => ({
      runtime: 'codex',
      adapter: 'codex-exec',
      launch: { command: 'mock', argsPrefix: [], shell: false },
      args: ['exec', '-C', workdir, '--json', '--output-last-message', lastMessageFile, '-'],
      cwd: workdir,
      stdin: prompt,
      env: runtimeAdapters.managedRunEnv('codex', { TP_AGENT_RUN_DIR: runDir }),
      schemaPath: schemaPath('agent-handoff.schema.json'),
    }),
    prepareProviderAttempt,
    acceptProviderAttempt,
    runProviderPostProcess,
    providerStep,
    providerPostAcceptanceStep,
    assertProviderStructuredOutput,
    providerResumeRefs,
    writeProviderHandoffBundle,
    validateProviderHandoffBundle,
    currentGitSha: () => null,
    buildNativeExecutionPlan,
    orchestrationOwner: nativeExecutionControl.orchestrationOwner,
    normalizeClaudeOutput: (input) => {
      const source = input && typeof input === 'object' ? input.stdout : input;
      return {
        runtime: 'claude',
        adapter: input && input.adapter ? input.adapter : 'claude-print',
        status: 'succeeded',
        accepted: true,
        nativeAccepted: true,
        terminalEvidence: { observed: true, event: 'result', status: 'success' },
        nativeAcceptanceErrors: [],
        runtimeRefs: { sessionId: 'claude-selftest-session' },
        payload: JSON.parse(source),
        usage: null,
      };
    },
    normalizeCodexOutput: (input) => ({
      runtime: 'codex',
      adapter: input.adapter || 'codex-exec',
      status: 'succeeded',
      accepted: true,
      nativeAccepted: true,
      terminalEvidence: {
        observed: true,
        event: 'turn.completed',
        status: 'completed',
      },
      nativeAcceptanceErrors: [],
      runtimeRefs: {
        threadId: 'codex-selftest-thread',
        turnId: 'codex-selftest-turn',
      },
      payload: JSON.parse(input.lastMessage || input.stdout),
      usage: null,
    }),
    hashArtifact: providerProfiles.hash,
    isGitRepository: () => false,
    writeGitDiff: () => '',
    listChangedFiles: () => [],
    ensureCleanWorktree: () => {},
    extractJsonValue: (text) => JSON.parse(text),
    parseJsonFromText: (text) => JSON.parse(text),
    unwrapAgentJson: (value) => value,
    findFirstJson: () => null,
    tryParseJson: (value) => { try { return { ok: true, value: JSON.parse(value) }; } catch (error) { return { ok: false, error }; } },
    schemaPath,
    schemaJson,
    nowIso,
    logStamp,
    stampedLogPath,
  };
}

function assertSelfTest(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`Self-test failed: ${name}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function usage() {
  console.log(`Tech Persistence agent-loop ${VERSION}

Usage:
  node scripts/agent-orchestrator.js run --requirement "..."
  node scripts/agent-orchestrator.js run --requirement-file docs/request.md --dry-run
  node scripts/agent-orchestrator.js run --requirement "..." --preflight-only
  node scripts/agent-orchestrator.js freeze --run <runId>
  node scripts/agent-orchestrator.js resume --run <runId> --validation-command "npm test"
  node scripts/agent-orchestrator.js status --run latest [--json]
  node scripts/agent-orchestrator.js goal-bind --run <runId> --runtime codex --host-ref <opaque-ref> --objective "..."
  node scripts/agent-orchestrator.js goal-release --run <runId> [--reason "..."]
  node scripts/agent-orchestrator.js doctor
  node scripts/agent-orchestrator.js self-test

Pipeline mode (experimental opt-in):
  node scripts/agent-orchestrator.js run --requirement "..." --pipeline [--auto]
  node scripts/agent-orchestrator.js freeze --run <id> --target global-contract
  node scripts/agent-orchestrator.js freeze --run <id> --target slice --slice-id <slice>
  node scripts/agent-orchestrator.js resume --run <id> --resolve accept-revision --revision <id>
  node scripts/agent-orchestrator.js resume --run <id> --resolve reject-revision --revision <id>
  node scripts/agent-orchestrator.js resume --run <id> --unblock <sliceId>
  node scripts/agent-orchestrator.js abandon --run <id>

Options:
  --workdir <path>              Repository root. Defaults to cwd.
  --runs-dir <path>             Run directory under workdir. Defaults to .agent-runs.
  --control-root <path>         External authoritative control root. Advanced/testing override.
  --run-id <id>                 Stable run id.
  --auto                        Auto-evaluate safe gates. Classic: freeze spec only when self-check passes.
  --auto-evaluate               Alias for --auto.
  --auto-freeze                 Legacy alias for --auto.
  --pipeline                    Enable pipeline mode (experimental).
  --target <kind>               Pipeline freeze target: global-contract | slice.
  --slice-id <id>               Pipeline slice id (with --target slice).
  --resolve <action>            Pipeline contract-conflict action: accept-revision | reject-revision | abandon.
  --revision <id>               Revision id for --resolve accept/reject.
  --reason <text>               Optional human reason for --resolve reject-revision.
  --unblock <sliceId>           Move a blocked slice back to ready.
  --allow-dirty                 Allow implementation in a dirty git worktree.
  --validation-command <cmd>    Shell command to run after implementation. Repeatable.
  --claude-command <cmd>        Override spec/review provider command.
  --codex-command <cmd>         Override implementation provider command.
  --spec-command <cmd>          Override spec provider command.
  --implementation-command <cmd> Override implementation provider command.
  --review-command <cmd>        Override review provider command.
  --skip-cli-schema             Do not pass CLI schema flags.
  --skip-git-repo-check         Pass Codex --skip-git-repo-check.
  --codex-sandbox <mode>        Override Codex sandbox mode. Windows defaults to workspace-write.
  --orchestration-owner <owner> Single scheduler owner: tp | codex-host | claude-host.
  --capability-router <mode>    Capability routing: off | shadow | enforce. Defaults to shadow.
  --claude-adapter <mode>       Claude adapter: print | bare | auto. Defaults to print.
  --claude-plugin-dir <path>    Explicit plugin dir for Claude bare mode. Repeatable.
  --claude-settings <path>      Explicit Claude settings file for the adapter.
  --codex-adapter <mode>        Codex adapter: exec | app-server | auto. Defaults to exec.
  --allow-experimental-app-server  Permit preparing the experimental App Server adapter.
  --provider-timeout-minutes <n> Override spec/implementation/review provider timeout.
  --provider-timeout-ms <n>     Override provider timeout in milliseconds.
  --dry-run                     Create run files and prompts without calling providers.
  --preflight-only              Create run files and only run local preflight checks.
`);
}

function main() {
  const parsed = parseCli(process.argv.slice(2));
  const { command, options, positionals } = parsed;
  if (command === 'help' || boolOption(options, 'help')) {
    usage();
    return;
  }

  switch (command) {
    case 'run':
      runStart(options, positionals);
      break;
    case 'freeze':
      freezeRun(options, positionals);
      break;
    case 'resume':
      runResume(options, positionals);
      break;
    case 'status':
      runStatus(options, positionals);
      break;
    case 'goal-bind':
      bindGoalLease(options, positionals);
      break;
    case 'goal-release':
      releaseGoalLease(options, positionals);
      break;
    case 'doctor':
    case 'preflight':
      runDoctor(options);
      break;
    case 'abandon':
      abandonRun(options, positionals);
      break;
    case 'self-test':
      runSelfTest();
      break;
    default:
      runStart(options, [command, ...positionals]);
      break;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    if (process.env.AGENT_LOOP_DEBUG) console.error(error.stack);
    process.exit(1);
  }
}

module.exports = {
  collectGitDiff,
  listChangedFiles,
  normalizeTurnValidation,
  worktreeFileFingerprint,
};
