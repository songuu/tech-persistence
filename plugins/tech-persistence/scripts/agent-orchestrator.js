#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pipeline = require('./agent-orchestrator/pipeline');
const pipelineState = require('./agent-orchestrator/pipeline-state');
const pipelineQueue = require('./agent-orchestrator/queue');
const pipelineLocks = require('./agent-orchestrator/locks');
const globalContractModule = require('./agent-orchestrator/global-contract');
const slicePlannerModule = require('./agent-orchestrator/slice-planner');
const sliceNormalizerModule = require('./agent-orchestrator/slice-normalizer');
const driftDetectorModule = require('./agent-orchestrator/drift-detector');
const reconciliationModule = require('./agent-orchestrator/reconciliation');
const reviewModule = require('./agent-orchestrator/review');

const VERSION = 'v7';
const DEFAULT_RUNS_DIR = '.agent-runs';
const MAX_BUFFER = 64 * 1024 * 1024;
const REVIEW_CONTEXT_MAX_BYTES = 200 * 1024;
const INLINE_FILE_DIFF_MAX_BYTES = 96 * 1024;

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
  fs.writeFileSync(file, content);
}

function writeJson(file, data) {
  writeText(file, `${JSON.stringify(data, null, 2)}\n`);
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

function boolOption(options, key) {
  const value = optionValue(options, key);
  return value === true || value === 'true' || value === '1';
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

function loadRun(options, positionals) {
  const runDir = resolveRunDir(options, positionals);
  const statePath = path.join(runDir, 'state.json');
  const state = readJson(statePath);
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
    timeoutMs,
    envOverrides: settings.env || null,
  };

  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error(`${label} timed out after ${timeoutMs}ms; see ${settings.stdoutFile || 'stdout'} and ${settings.stderrFile || 'stderr'}`);
  }
  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (!settings.allowFailure && result.status !== 0) {
    const envelopeError = extractProviderEnvelopeError(result.stdout || '');
    const stderrPath = settings.stderrFile || 'stderr';
    const stdoutPath = settings.stdoutFile || 'stdout';
    const where = envelopeError
      ? `stdout: ${stdoutPath}`
      : `stderr: ${stderrPath} / stdout: ${stdoutPath}`;
    const reason = envelopeError ? ` — ${envelopeError}` : '';
    throw new Error(`${label} exited with ${result.status}${reason}; see ${where}`);
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

function statusFromReview(review) {
  if (review.decision === 'approved' && review.compliant === true) return 'completed';
  if (review.decision === 'blocked' || review.findings.some((finding) => finding.severity === 'P0')) {
    return 'blocked';
  }
  return 'needs-followup';
}

function buildSpecPrompt(requirement, options) {
  return [
    'You are the analysis and design provider in Tech Persistence agent-loop v6.',
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
  return [
    'You are the implementation provider in Tech Persistence agent-loop v6.',
    'Implement only the frozen spec. Do not reinterpret or expand requirements.',
    'If the spec is ambiguous, make the smallest safe implementation and record it in handoff.risks.',
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
    reviewNotes ? `\nPrior review notes JSON:\n${reviewNotes}` : '',
  ].filter(Boolean).join('\n');
}

function buildReviewPrompt(state, runDir) {
  const reviewContextPath = path.join(runDir, 'review-context.md');
  const reviewContext = safeRead(reviewContextPath) || '(missing review context)';
  return [
    'You are the review provider in Tech Persistence agent-loop v6.',
    'Review the implementation strictly against the frozen spec and technical design.',
    'Do not add new product requirements. Return JSON only and match the review schema.',
    'If the diff context is truncated, inspect the repository files directly.',
    '',
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

function runSpecProvider(state, statePath, runDir, options) {
  const prompt = readText(path.join(runDir, 'prompts', 'spec.md'));
  const providerLogStamp = logStamp();
  const stdoutFile = stampedLogPath(runDir, 'spec', 'stdout.log', providerLogStamp);
  const stderrFile = stampedLogPath(runDir, 'spec', 'stderr.log', providerLogStamp);
  const args = ['-p', '--input-format', 'text', '--output-format', 'json'];
  if (!boolOption(options, 'skip-cli-schema')) {
    args.push('--json-schema', schemaJson('requirement-spec.schema.json'));
  }

  const { record, result } = runProcess(
    'spec provider',
    providerLaunch(options, 'spec'),
    args,
    {
      cwd: state.workdir,
      stdoutFile,
      stderrFile,
      stdin: prompt,
      env: claudeProviderEnv(),
      timeoutMs: providerTimeoutMs(options),
    }
  );
  state.providerRuns.push(record);

  const rawSpec = extractJsonValue(result.stdout || '');
  const spec = normalizeSpec(rawSpec);
  const errors = validateSpec(spec);
  if (errors.length > 0) throw new Error(`Invalid spec output: ${errors.join('; ')}`);

  writeSpecArtifacts(runDir, spec, rawSpec);
  state.status = 'spec-ready';
  state.files.spec = 'spec.json';
  state.files.requirementSpec = 'requirement-spec.md';
  state.files.technicalDesign = 'technical-design.md';
  state.files.taskBreakdown = 'task-breakdown.json';
  saveState(statePath, state);
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
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  if (status.status !== 0) return [];

  return (status.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseGitStatusLine)
    .filter(Boolean)
    .filter((entry) => !isManagedArtifact(entry.path, workdir, runDir));
}

function parseGitStatusLine(line) {
  const status = line.slice(0, 2);
  let filePath = line.slice(3).trim();
  if (filePath.includes(' -> ')) filePath = filePath.split(' -> ').pop();
  filePath = filePath.replace(/^"|"$/g, '');
  return { status, path: normalizeGitPath(filePath) };
}

function normalizeGitPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
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

  const prompt = buildImplementationPrompt(state, runDir);
  writeText(path.join(runDir, 'prompts', 'implement.md'), prompt);
  const providerLogStamp = logStamp();
  const stdoutFile = stampedLogPath(runDir, 'implementation', 'stdout.log', providerLogStamp);
  const stderrFile = stampedLogPath(runDir, 'implementation', 'stderr.log', providerLogStamp);
  const lastMessageFile = stampedLogPath(runDir, 'implementation', 'last-message.json', providerLogStamp);
  const args = ['exec', '-C', state.workdir, '--json'];
  args.push('--output-last-message', lastMessageFile);
  const sandboxMode = codexSandboxMode(options);
  if (sandboxMode) args.push('--sandbox', sandboxMode);
  if (!isGitRepository(state.workdir) || boolOption(options, 'skip-git-repo-check')) {
    args.push('--skip-git-repo-check');
  }
  if (!boolOption(options, 'skip-cli-schema')) {
    args.push('--output-schema', schemaPath('agent-handoff.schema.json'));
  }
  args.push('-');

  const { record, result } = runProcess(
    'implementation provider',
    providerLaunch(options, 'implementation'),
    args,
    {
      cwd: state.workdir,
      stdoutFile,
      stderrFile,
      stdin: prompt,
      timeoutMs: providerTimeoutMs(options),
    }
  );
  state.providerRuns.push(record);

  let handoff;
  try {
    handoff = normalizeHandoff(extractJsonValue(safeRead(lastMessageFile) || result.stdout || ''));
  } catch (error) {
    handoff = {
      summary: 'Implementation provider completed, but JSON handoff could not be parsed.',
      changedFiles: [],
      validation: [],
      risks: [error.message],
      followUp: [],
    };
    writeJson(path.join(runDir, 'handoff.parse-error.json'), {
      message: error.message,
      stdoutFile: path.relative(runDir, stdoutFile),
      lastMessageFile: path.relative(runDir, lastMessageFile),
    });
  }
  writeJson(path.join(runDir, 'handoff.json'), handoff);
  writeText(path.join(runDir, 'handoff.md'), renderHandoff(handoff));
  writeGitDiff(state.workdir, runDir);
  writeValidation(state.workdir, runDir, options);
  writeReviewContext(runDir);

  state.status = 'implemented';
  state.files.handoff = 'handoff.md';
  state.files.diff = 'diff.patch';
  state.files.changedFiles = 'changed-files.json';
  state.files.validation = 'validation.json';
  state.files.reviewContext = 'review-context.md';
  saveState(statePath, state);
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

function writeGitDiff(workdir, runDir) {
  const changedFiles = listChangedFiles(workdir, runDir);
  writeJson(path.join(runDir, 'changed-files.json'), changedFiles);

  if (!isGitRepository(workdir)) {
    writeText(path.join(runDir, 'diff.patch'), 'Not a git repository; diff unavailable.\n');
    return;
  }

  const diffArgs = ['diff', '--no-ext-diff', '--binary', '--', '.'];
  for (const exclude of DEFAULT_DIFF_EXCLUDES) diffArgs.push(`:(exclude)${exclude}`);
  const result = spawnSync('git', diffArgs, {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });

  const trackedDiff = result.stdout || '';
  const syntheticDiffs = changedFiles
    .filter((entry) => entry.status === '??')
    .map((entry) => buildUntrackedDiff(workdir, entry.path))
    .filter(Boolean)
    .join('\n');
  const omitted = changedFiles
    .filter((entry) => shouldOmitDiff(entry.path))
    .map((entry) => `Diff omitted for generated or oversized file: ${entry.path}`)
    .join('\n');

  writeText(path.join(runDir, 'diff.patch'), [trackedDiff, syntheticDiffs, omitted].filter(Boolean).join('\n'));
}

function shouldOmitDiff(filePath) {
  const normalized = normalizeGitPath(filePath);
  return GENERATED_DIFF_OMIT_PATHS.has(normalized);
}

function buildUntrackedDiff(workdir, filePath) {
  if (shouldOmitDiff(filePath)) return null;
  const absolutePath = path.join(workdir, filePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return null;
  const bytes = fs.statSync(absolutePath).size;
  if (bytes > INLINE_FILE_DIFF_MAX_BYTES) return `Diff omitted for oversized new file: ${filePath}\n`;
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.includes(0)) return `Diff omitted for binary new file: ${filePath}\n`;
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
  const prompt = buildReviewPrompt(state, runDir);
  writeText(path.join(runDir, 'prompts', 'review.md'), prompt);
  const providerLogStamp = logStamp();
  const stdoutFile = stampedLogPath(runDir, 'review', 'stdout.log', providerLogStamp);
  const stderrFile = stampedLogPath(runDir, 'review', 'stderr.log', providerLogStamp);
  const args = ['-p', '--input-format', 'text', '--output-format', 'json'];
  if (!boolOption(options, 'skip-cli-schema')) {
    args.push('--json-schema', schemaJson('review-result.schema.json'));
  }

  const { record, result } = runProcess(
    'review provider',
    providerLaunch(options, 'review'),
    args,
    {
      cwd: state.workdir,
      stdoutFile,
      stderrFile,
      stdin: prompt,
      env: claudeProviderEnv(),
      timeoutMs: providerTimeoutMs(options),
    }
  );
  state.providerRuns.push(record);

  let rawReview;
  let review;
  try {
    rawReview = extractJsonValue(result.stdout || '');
    review = normalizeReview(rawReview);
  } catch (error) {
    writeJson(path.join(runDir, 'review.parse-error.json'), {
      message: error.message,
      stdoutFile: path.relative(runDir, stdoutFile),
      stderrFile: path.relative(runDir, stderrFile),
    });
    state.status = 'failed';
    saveState(statePath, state);
    throw error;
  }

  writeJson(path.join(runDir, 'review.raw.json'), rawReview);
  writeJson(path.join(runDir, 'review.json'), review);
  state.files.review = 'review.json';
  state.status = statusFromReview(review);
  if (state.status === 'needs-followup' || state.status === 'blocked') writeFollowUpTask(runDir, review);
  saveState(statePath, state);
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
    providerLaunch,
    providerCommandSpec,
    providerTimeoutMs,
    codexSandboxMode,
    claudeProviderEnv,
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

  const state = newState(workdir, runDir, runId, requirement);
  writeText(path.join(runDir, 'requirement.md'), `${requirement}\n`);
  writeText(path.join(runDir, 'prompts', 'spec.md'), buildSpecPrompt(requirement, { workdir }));
  writeJson(path.join(runDir, 'commands.json'), commandPlan(options));
  saveState(statePath, state);

  const preflight = buildPreflightReport(workdir, options, runDir);
  writePreflight(runDir, preflight);
  state.files.preflight = 'preflight.json';
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
  if (!boolOption(options, 'auto-freeze')) {
    console.log(`[OK] spec ready: ${runDir}`);
    console.log(`Next: review ${path.join(runDir, 'requirement-spec.md')}`);
    console.log(`Freeze: node scripts/agent-orchestrator.js freeze --run ${runId}`);
    return;
  }

  state.specFrozenAt = nowIso();
  state.specFrozenBy = 'auto-freeze';
  state.status = 'frozen';
  saveState(statePath, state);
  runImplementationProvider(state, statePath, runDir, options);
  runReviewProvider(state, statePath, runDir, options);
  printRunSummary(state);
}

function runResume(options, positionals) {
  const { runDir, statePath, state } = loadRun(options, positionals);
  if (state.mode === 'pipeline') {
    pipeline.resumePipelineRun(buildPipelineCtx(), options, positionals);
    return;
  }
  if (state.status === 'dry-run') {
    console.log(`[INFO] ${state.runId} is a dry-run. No provider calls to resume.`);
    return;
  }
  if (state.status === 'spec-ready' && !state.specFrozenAt) {
    console.log(`[INFO] ${state.runId} is waiting for human freeze.`);
    console.log(`Freeze: node scripts/agent-orchestrator.js freeze --run ${state.runId}`);
    return;
  }
  const preflight = buildPreflightReport(state.workdir, options, runDir);
  writePreflight(runDir, preflight);
  state.files.preflight = 'preflight.json';
  saveState(statePath, state);
  assertPreflight(preflight);

  if (state.status === 'frozen' || state.status === 'needs-followup' || state.status === 'blocked') {
    runImplementationProvider(state, statePath, runDir, options);
  }
  if (state.status === 'implemented') {
    runReviewProvider(state, statePath, runDir, options);
  }
  printRunSummary(state);
}

function printRunSummary(state) {
  console.log(`[OK] ${state.runId}: ${state.status}`);
  console.log(`Run dir: ${state.runDir}`);
  if (state.files.diff) console.log(`Diff: ${path.join(state.runDir, state.files.diff)}`);
  if (state.files.review) console.log(`Review: ${path.join(state.runDir, state.files.review)}`);
}

function runStatus(options, positionals) {
  const { state } = loadRun(options, positionals);
  printRunSummary(state);
  console.log(`Created: ${state.createdAt}`);
  console.log(`Updated: ${state.updatedAt}`);
  console.log(`Frozen: ${state.specFrozenAt || 'no'}`);
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
  assertSelfTest('pipeline slice transitions: frozen -> rejected branch',
    pipelineState.isValidSliceTransition('slice-frozen', 'slice-rejected'), true);
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

  runProviderIntegrationSelfTests();
}

function runProviderIntegrationSelfTests() {
  const providers = require('./agent-orchestrator/pipeline-providers');
  const tmpBase = path.join(os.tmpdir(), `agent-loop-selftest-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(tmpBase, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(tmpBase, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(tmpBase, 'slices'), { recursive: true });

  let stateObj = pipeline.newPipelineState(tmpBase, tmpBase, 'selftest', 'a provider integration self-test requirement');
  const statePath = path.join(tmpBase, 'state.json');
  writeJson(statePath, stateObj);
  writeText(
    path.join(tmpBase, 'prompts', 'global-contract.md'),
    'mock prompt for global contract',
  );

  const mockCtx = buildMockCtx(tmpBase);
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
        validationCommands: [],
        questions: [],
      }],
    }),
  );
  stateObj = providers.runSlicePlannerProvider(mockCtx, stateObj, statePath, tmpBase, {});
  assertSelfTest('provider integration: slice planner wrote slice-001', fs.existsSync(path.join(tmpBase, 'slices', 'slice-001', 'slice.json')), true);
  assertSelfTest('provider integration: slice state advanced to ready', stateObj.pipeline.sliceStates['slice-001'], 'slice-ready');
  assertSelfTest('provider integration: status executing-slices', stateObj.status, 'executing-slices');

  const reviewApprovedRaw = JSON.stringify({ decision: 'approved', contractRevisions: [], findings: [] });
  mockCtx._stdoutQueue.push(reviewApprovedRaw);
  const slice = require('./agent-orchestrator/slice-planner').loadSlice(tmpBase, 'slice-001');
  const locksModule = require('./agent-orchestrator/locks');
  locksModule.saveLocks(tmpBase, locksModule.claimAll(locksModule.loadLocks(tmpBase), slice));
  fs.writeFileSync(path.join(tmpBase, 'slices', 'slice-001', 'diff.patch'), 'mock diff');
  fs.writeFileSync(path.join(tmpBase, 'slices', 'slice-001', 'handoff.json'), '{}');
  const reviewOutcome = providers.runSliceReviewProvider(mockCtx, stateObj, statePath, tmpBase, {}, slice);
  assertSelfTest('provider integration: approved slice marked completed', reviewOutcome.state.pipeline.sliceStates['slice-001'], 'slice-completed');
  assertSelfTest('provider integration: completed-owner lock', JSON.parse(fs.readFileSync(path.join(tmpBase, 'locks.json'), 'utf8')).files['mock.txt'].status, 'completed-owner');

  stateObj = reviewOutcome.state;
  const reviewBreakingRaw = JSON.stringify({
    decision: 'needs-followup',
    findings: [],
    contractRevisions: [{ revisionId: 'rev-001', fields: { goal: 'new goal' }, rationale: 'breaking shift' }],
  });
  mockCtx._stdoutQueue.push(reviewBreakingRaw);
  fs.writeFileSync(path.join(tmpBase, 'slices', 'slice-001', 'diff.patch'), 'mock diff');
  const breakingOutcome = providers.runSliceReviewProvider(mockCtx, stateObj, statePath, tmpBase, {}, slice);
  assertSelfTest('provider integration: breaking revision enters contract-conflict', breakingOutcome.state.status, 'contract-conflict');
  assertSelfTest('provider integration: breaking drift recorded', breakingOutcome.drift[0].classification, 'breaking');

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
    providerLaunch: () => ({ command: 'mock', argsPrefix: [], shell: false }),
    providerCommandSpec: () => 'mock',
    providerTimeoutMs: () => 60000,
    codexSandboxMode: () => null,
    claudeProviderEnv: () => ({}),
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
  node scripts/agent-orchestrator.js status --run latest
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
  --run-id <id>                 Stable run id.
  --auto-freeze                 Explicitly skip human freeze and continue.
  --auto                        Pipeline mode: auto-freeze "safe" objects only (see docs).
  --pipeline                    Enable pipeline mode (experimental).
  --target <kind>               Pipeline freeze target: global-contract | slice.
  --slice-id <id>               Pipeline slice id (with --target slice).
  --resolve <action>            Pipeline contract-conflict action: accept-revision | reject-revision | abandon.
  --revision <id>               Revision id for --resolve accept/reject.
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

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  if (process.env.AGENT_LOOP_DEBUG) console.error(error.stack);
  process.exit(1);
}
