#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CASES = Object.freeze([
  'L1-single-file', 'L2-multi-file', 'L3-security-review', 'failure-recovery',
]);
const TRACE_SCHEMA_VERSION = 'gpt56-trace-v1';
const COMPARE_SCHEMA_VERSION = 'gpt56-compare-v1';
const FINGERPRINT_SCHEMA_VERSION = 'claude-surface-fingerprint-v1';
const CLAUDE_SURFACE_BASELINE_SCHEMA_VERSION = 'claude-surface-baseline-v1';
const CLAUDE_SURFACE_VERIFICATION_SCHEMA_VERSION = 'claude-surface-baseline-verification-v1';
const DEFAULT_LEDGER = '.agent-runs/model-canary.jsonl';
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const COMPATIBILITY_EVIDENCE_SCHEMA_VERSION =
  'codex-model-compat-architecture-evidence-v1';
const COMPATIBILITY_EVIDENCE_PREFIX = 'CODEX_MODEL_COMPAT_EVIDENCE=';
const COMPATIBILITY_VALIDATOR_COMMAND = 'node scripts/model-compat-validator.js';
const EXTERNAL_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION =
  'codex-model-compat-external-evidence-v1';
const EXTERNAL_COMPATIBILITY_EVIDENCE_SOURCE = 'external-controller';
const EXTERNAL_COMPATIBILITY_TRUST_BOUNDARY = 'trace-external-controller';
const ARCHITECTURE_EVIDENCE_FILES = Object.freeze([
  'scripts/model-compat-validator.js',
  'scripts/test-codex-active-sprint-state.js',
  'scripts/test-codex-native-skill-projection.js',
]);
const SPRINT_PHASES = Object.freeze(['think', 'plan', 'work', 'review', 'compound']);
const CLAUDE_SURFACE = Object.freeze([
  'user-level/commands/**',
  'user-level/skills/**',
  'plugins/tech-persistence/commands/**',
  'plugins/tech-persistence/skills/**',
  'plugins/tech-persistence/hooks/**',
  'scripts/lib/hook-registry.js',
  'scripts/sync-solution-index.js',
  'plugins/tech-persistence/.claude-plugin/plugin.json',
]);
const POLICIES = Object.freeze({
  'gpt56-sprint-v1': Object.freeze({
    kind: 'performance',
    minimumPairs: 6,
    minimumChangedComparisonDimensions: 1,
    minimumPairsByCase: Object.freeze({
      'L1-single-file': 2,
      'L2-multi-file': 2,
      'L3-security-review': 1,
      'failure-recovery': 1,
    }),
    pairedMedianRatios: Object.freeze({
      wallMs: 0.75,
      ttfVisibleMs: 0.70,
      ttfMutationMs: 0.70,
      cumulativeInputTokens: 0.65,
      preMutationToolCalls: 0.70,
    }),
    wallRegressionRatio: 1.10,
    wallRegressionPassFraction: 5 / 6,
    contextAtFirstMutationMaximum: 0.60,
    maximumLearnedContextInjections: 1,
    maximumCavemanInjections: 1,
    l3WallRatio: 0.85,
    l3InputRatio: 0.75,
  }),
  'codex-model-compat-v1': Object.freeze({
    kind: 'compatibility',
    minimumPairs: 4,
    minimumChangedComparisonDimensions: 1,
    minimumPairsByCase: Object.freeze({
      'L1-single-file': 1,
      'L2-multi-file': 1,
      'L3-security-review': 1,
      'failure-recovery': 1,
    }),
    requiredSprintPhases: SPRINT_PHASES,
  }),
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return null;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function emptyCompatibility() {
  return {
    sprintPhases: null,
    resumeVerified: null,
    visionFallbackContractVerified: null,
    collaborationFallbackContractVerified: null,
  };
}

function requestedCompatibility(options = {}) {
  return {
    sprintPhases: Array.isArray(options.sprintPhases)
      ? [...new Set(options.sprintPhases.map(stringValue).filter(Boolean))]
      : null,
    resumeVerified: booleanValue(options.resumeVerified),
    visionFallbackContractVerified: booleanValue(options.visionFallbackContractVerified),
    collaborationFallbackContractVerified:
      booleanValue(options.collaborationFallbackContractVerified),
  };
}

function compatibilityWasRequested(requested) {
  return Object.values(requested).some((value) => value !== null);
}

function getPath(value, dottedPath) {
  let cursor = value;
  for (const part of dottedPath.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function firstDefined(value, paths) {
  for (const dottedPath of paths) {
    const candidate = getPath(value, dottedPath);
    if (candidate !== undefined && candidate !== null && candidate !== '') return candidate;
  }
  return null;
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (isObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
    return result;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalExistingPath(value, label) {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const canonical = fs.realpathSync(resolved);
  if (!fs.statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory: ${canonical}`);
  return canonical;
}

function sameCanonicalPath(left, right) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function architectureEnvironment(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())) continue;
    result[key] = value;
  }
  return result;
}

function architectureInvocation(repoRoot, expectedFile) {
  const currentFile = inspectArchitectureEvidenceFile(repoRoot, expectedFile.path);
  if (canonicalStringify(currentFile) !== canonicalStringify(expectedFile)) {
    throw new Error(`architecture evidence file changed before execution: ${expectedFile.path}`);
  }
  const executable = fs.realpathSync(process.execPath);
  const descriptor = {
    executable, args: [currentFile.realPath], cwd: repoRoot, shell: false,
  };
  return { ...descriptor, commandHash: sha256(JSON.stringify(descriptor)) };
}

function runArchitectureScript(invocation, env) {
  return spawnSync(invocation.executable, invocation.args, {
    cwd: invocation.cwd,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function pathIsWithinRoot(repoRoot, candidate) {
  const rootKey = process.platform === 'win32'
    ? path.normalize(repoRoot).toLowerCase() : path.normalize(repoRoot);
  const candidateKey = process.platform === 'win32'
    ? path.normalize(candidate).toLowerCase() : path.normalize(candidate);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${path.sep}`);
}

function inspectArchitectureEvidenceFile(repoRoot, relativePath) {
  const expectedPath = path.resolve(repoRoot, relativePath);
  if (!pathIsWithinRoot(repoRoot, expectedPath)) {
    throw new Error(`architecture evidence path escapes repository: ${relativePath}`);
  }
  let stats;
  try {
    stats = fs.lstatSync(expectedPath, { bigint: true });
  } catch (error) {
    throw new Error(`architecture evidence file is missing: ${relativePath}: ${error.message}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`architecture evidence file must be a plain regular file: ${relativePath}`);
  }
  const realPath = fs.realpathSync(expectedPath);
  if (!pathIsWithinRoot(repoRoot, realPath)) {
    throw new Error(`architecture evidence realpath escapes repository: ${relativePath}`);
  }
  if (!sameCanonicalPath(realPath, expectedPath)) {
    throw new Error(
      `architecture evidence file must resolve to its controlled repository path: ${relativePath}`
    );
  }
  return {
    path: relativePath,
    realPath,
    identity: { device: String(stats.dev), file: String(stats.ino) },
    sha256: sha256(fs.readFileSync(expectedPath)),
  };
}

function architectureFileSnapshot(repoRoot) {
  return ARCHITECTURE_EVIDENCE_FILES.map((relativePath) =>
    inspectArchitectureEvidenceFile(repoRoot, relativePath));
}

function gitArchitectureSnapshot(repoRoot, env) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: repoRoot, env, encoding: 'utf8', shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  });
  if (top.status !== 0) {
    if (fs.existsSync(path.join(repoRoot, '.git'))) {
      const detail = top.error ? top.error.message : String(top.stderr || '').trim();
      throw new Error(`cannot resolve git repository state: ${detail || `exit ${top.status}`}`);
    }
    return { state: 'no-git', head: null };
  }
  const gitRoot = canonicalExistingPath(String(top.stdout).trim(), 'git root');
  if (!sameCanonicalPath(gitRoot, repoRoot)) {
    throw new Error(`architecture root is not the git repository root: ${repoRoot}`);
  }
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repoRoot, env, encoding: 'utf8', shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  });
  const value = String(head.stdout || '').trim().toLowerCase();
  if (head.status !== 0 || !/^[a-f\d]{40,64}$/.test(value)) {
    const detail = head.error ? head.error.message : String(head.stderr || '').trim();
    throw new Error(`cannot resolve git HEAD: ${detail || `exit ${head.status}`}`);
  }
  return { state: 'head', head: value };
}

function parseExternalCompatibilityMarker(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter((line) => line !== '');
  if (lines.length !== 1 || !lines[0].startsWith(COMPATIBILITY_EVIDENCE_PREFIX)) {
    throw new Error('architecture validator must emit exactly one framed marker line');
  }
  const rawMarker = lines[0].slice(COMPATIBILITY_EVIDENCE_PREFIX.length);
  let marker;
  try {
    marker = JSON.parse(rawMarker);
  } catch (error) {
    throw new Error(`architecture validator emitted invalid marker JSON: ${error.message}`);
  }
  return { observed: normalizeCompatibilityMarker(marker), rawMarker };
}

function collectExternalArchitectureEvidence(root) {
  const repoRoot = canonicalExistingPath(root, 'architecture root');
  const env = architectureEnvironment();
  const filesBefore = architectureFileSnapshot(repoRoot);
  const gitBefore = gitArchitectureSnapshot(repoRoot, env);
  const tests = filesBefore.slice(1).map((fileEvidence) => {
    const relativePath = fileEvidence.path;
    const invocation = architectureInvocation(repoRoot, fileEvidence);
    const result = runArchitectureScript(invocation, env);
    if (result.error) {
      throw new Error(`architecture test failed: ${relativePath}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`architecture test failed: ${relativePath}: exit ${result.status}`);
    }
    return { path: relativePath, commandHash: invocation.commandHash, exitCode: 0 };
  });
  const validatorFile = filesBefore[0];
  const validatorPath = validatorFile.path;
  const validatorInvocation = architectureInvocation(repoRoot, validatorFile);
  const validatorResult = runArchitectureScript(validatorInvocation, env);
  if (validatorResult.error) {
    throw new Error(`architecture validator failed: ${validatorResult.error.message}`);
  }
  if (validatorResult.status !== 0) {
    throw new Error(`architecture validator failed: exit ${validatorResult.status}`);
  }
  const marker = parseExternalCompatibilityMarker(validatorResult.stdout);
  const filesAfter = architectureFileSnapshot(repoRoot);
  const gitAfter = gitArchitectureSnapshot(repoRoot, env);
  if (canonicalStringify(filesBefore) !== canonicalStringify(filesAfter)
      || canonicalStringify(gitBefore) !== canonicalStringify(gitAfter)) {
    throw new Error('architecture evidence inputs changed during validation');
  }
  return {
    schemaVersion: EXTERNAL_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION,
    source: EXTERNAL_COMPATIBILITY_EVIDENCE_SOURCE,
    observed: cloneCompatibility(marker.observed),
    attestation: {
      trustBoundary: EXTERNAL_COMPATIBILITY_TRUST_BOUNDARY,
      repoRoot,
      cwd: repoRoot,
      git: gitBefore,
      files: filesBefore,
      validator: {
        commandHash: validatorInvocation.commandHash,
        exitCode: 0,
        markerHash: sha256(Buffer.from(marker.rawMarker, 'utf8')),
      },
      tests,
    },
  };
}

function externalArtifactFromEvidence(evidence) {
  return {
    schemaVersion: evidence.schemaVersion,
    source: evidence.source,
    observed: cloneCompatibility(evidence.observed),
    attestation: evidence.attestation,
  };
}

function verifyExternalArchitectureEvidence(evidence, options = {}) {
  validateExternalArchitectureEvidence(evidence, true);
  const collector = options.collector || collectExternalArchitectureEvidence;
  const current = collector(evidence.attestation.repoRoot);
  if (canonicalStringify(externalArtifactFromEvidence(evidence))
      !== canonicalStringify(current)) {
    throw new Error('external architecture evidence changed since collection');
  }
  return true;
}

function hashInventory(value) {
  if (typeof value === 'string' && /^[a-f\d]{64}$/i.test(value)) return value.toLowerCase();
  if (value === null || value === undefined) return null;
  return sha256(Buffer.from(stableStringify(value), 'utf8'));
}

function normalizePath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function toTimestampMs(value) {
  const numeric = finiteNumber(value);
  if (numeric !== null) {
    if (numeric > 1e12) return numeric;
    if (numeric > 1e9) return numeric * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function median(values) {
  return percentile(values, 0.5);
}

function flattenText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join('\n');
  if (!isObject(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.message === 'string') return value.message;
  if (value.content !== undefined) return flattenText(value.content);
  return '';
}

function extractRowTimestamp(row) {
  const payload = isObject(row.payload) ? row.payload : {};
  return toTimestampMs(firstDefined(row, [
    'timestamp', 'created_at', 'occurred_at_ms',
    'payload.timestamp', 'payload.created_at', 'payload.occurred_at_ms',
  ])) || toTimestampMs(payload.completed_at) || toTimestampMs(payload.started_at);
}

function extractCommandArgument(rawArguments) {
  if (isObject(rawArguments)) {
    return firstDefined(rawArguments, ['command', 'cmd', 'script', 'input']) || '';
  }
  if (typeof rawArguments !== 'string') return '';
  try {
    const parsed = JSON.parse(rawArguments);
    if (isObject(parsed)) return extractCommandArgument(parsed);
  } catch (_) {
    // Custom tool input, such as apply_patch, is intentionally not JSON.
  }
  return rawArguments;
}

function extractToolCall(row, rowIndex) {
  const payload = isObject(row.payload) ? row.payload : row;
  const itemType = String(payload.type || row.type || '');
  if (itemType === 'mcp_tool_call_end' && isObject(payload.invocation)) {
    const invocation = payload.invocation;
    const endTimestamp = extractRowTimestamp(row);
    const seconds = finiteNumber(getPath(payload, 'duration.secs')) || 0;
    const nanoseconds = finiteNumber(getPath(payload, 'duration.nanos')) || 0;
    const durationMs = (seconds * 1000) + (nanoseconds / 1e6);
    return {
      id: String(firstDefined(payload, ['call_id', 'id']) || `anonymous-${rowIndex}`),
      name: `mcp__${String(invocation.server || 'unknown')}__${String(invocation.tool || 'unknown')}`,
      rawArguments: invocation.arguments || {},
      command: '',
      timestamp: endTimestamp === null ? null : Math.max(0, endTimestamp - durationMs),
      completedOutput: { output: payload.result, timestamp: endTimestamp },
    };
  }
  const isToolCall = ['function_call', 'custom_tool_call', 'tool_call'].includes(itemType)
    || /(?:^|_)call$/i.test(itemType);
  if (!isToolCall) return null;
  const rawArguments = firstDefined(payload, ['arguments', 'input', 'args', 'parameters']) || '';
  return {
    id: String(firstDefined(payload, ['call_id', 'id']) || `anonymous-${rowIndex}`),
    name: String(firstDefined(payload, ['name', 'tool_name', 'tool']) || 'unknown'),
    rawArguments,
    command: extractCommandArgument(rawArguments),
    timestamp: extractRowTimestamp(row),
  };
}

function extractToolOutput(row) {
  const payload = isObject(row.payload) ? row.payload : row;
  const itemType = String(payload.type || row.type || '');
  const isToolOutput = ['function_call_output', 'custom_tool_call_output', 'tool_output'].includes(itemType)
    || /(?:^|_)call_output$/i.test(itemType);
  if (!isToolOutput) return null;
  return {
    id: String(firstDefined(payload, ['call_id', 'id']) || ''),
    output: firstDefined(payload, ['output', 'result', 'content']),
    timestamp: extractRowTimestamp(row),
  };
}

function isVisibleMessage(row) {
  const payload = isObject(row.payload) ? row.payload : row;
  const itemType = String(payload.type || row.type || '');
  if (row.type === 'event_msg' && itemType === 'agent_message') return true;
  return itemType === 'message' && String(payload.role || '').toLowerCase() === 'assistant';
}

function isRepoRead(call) {
  const name = call.name.toLowerCase();
  if (/read_file|read_text|search_files|list_files|view_image/.test(name)) return true;
  if (!/shell|exec|command|powershell|terminal/.test(name)) return false;
  return /\b(rg|grep|git\s+(status|diff|log|show)|get-content|get-childitem|select-string|findstr)\b/i.test(call.command)
    || /(?:^|[\s;&|])(?:type|ls)\s/i.test(call.command);
}

function splitReadOnlyShellSegments(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];
    // Command substitutions remain executable inside double quotes in the
    // supported shells. Reject them before quote parsing can hide them.
    if (character === '`' || (character === '$' && next === '(')) return null;
    if (quote) {
      current += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\' && quote === '"') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    // Redirection, command substitution, grouping, and PowerShell invocation
    // operators are intentionally fail-closed. Each can hide an indirect write.
    if (character === '>' || character === '<' || character === '(' || character === ')'
        || character === '{' || character === '}') {
      return null;
    }
    const isSeparator = character === ';' || character === '\n' || character === '\r'
      || character === '|' || (character === '&' && next === '&');
    if (isSeparator) {
      if (character === '&') index += 1;
      else if (character === '|' && next === '|') index += 1;
      const segment = current.trim();
      if (segment) segments.push(segment);
      current = '';
      continue;
    }
    if (character === '&') return null;
    current += character;
  }
  if (quote) return null;
  if (current.trim()) segments.push(current.trim());
  return segments.length > 0 ? segments : null;
}

function isReadOnlyShellSegment(segment) {
  const command = segment.trim();
  const gitMatch = command.match(
    /^git(?:\.exe)?\s+(status|diff|log|show|rev-parse|ls-files|grep)(?:\s|$)/i,
  );
  if (gitMatch) {
    if (/(?:^|\s)["']?--(?:output|ext-diff|textconv|open-files-in-pager|paginate)(?:[=\s"']|$)/i
      .test(command)) return false;
    if (gitMatch[1].toLowerCase() === 'grep'
        && /(?:^|\s)["']?-O\S*(?=\s|$)/.test(command)) return false;
    return true;
  }
  if (/^(?:rg|rg\.exe|grep|findstr|findstr\.exe|Get-Content|Get-ChildItem|Select-String|Test-Path|Resolve-Path|Get-Item|Get-FileHash|where\.exe|which|pwd|ls|type)(?:\s|$)/i.test(command)) {
    return !/^rg(?:\.exe)?\b[\s\S]*(?:^|\s)["']?--pre(?:[=\s"']|$)/i.test(command);
  }
  const nodeCheck = command.match(
    /^node(?:\.exe)?\s+--check\s+("[^"]+"|'[^']+'|[^\s"']+)$/i,
  );
  if (nodeCheck) {
    const scriptPath = nodeCheck[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
    return !scriptPath.startsWith('-');
  }
  if (/^(?:bash|sh)\s+-n(?:\s|$)/i.test(command)) return true;
  return false;
}

function isClearlyReadOnlyShellCommand(command) {
  const segments = splitReadOnlyShellSegments(command);
  return Boolean(segments && segments.every(isReadOnlyShellSegment));
}

const READ_ONLY_TOOL_NAMES = new Set([
  'read_file',
  'functions.read_file',
  'read_text',
  'functions.read_text',
  'search_files',
  'functions.search_files',
  'list_files',
  'functions.list_files',
  'view_image',
  'functions.view_image',
]);
const SHELL_TOOL_NAMES = new Set([
  'shell_command',
  'functions.shell_command',
  'exec_command',
  'functions.exec_command',
  'powershell',
  'terminal',
]);

function isMutation(call) {
  const name = String(call.name || '').trim().toLowerCase();
  if (READ_ONLY_TOOL_NAMES.has(name)) return false;
  if (SHELL_TOOL_NAMES.has(name)) return !isClearlyReadOnlyShellCommand(call.command);
  // MCP and external tools are mutable until their exact tool name is audited
  // and added to READ_ONLY_TOOL_NAMES. Name fragments are never trusted.
  return true;
}

function isTrustedCompatibilityValidatorCall(call) {
  const toolName = String(call.name || '').trim().toLowerCase();
  if (!SHELL_TOOL_NAMES.has(toolName)
      || call.command !== COMPATIBILITY_VALIDATOR_COMMAND) return false;
  let args = isObject(call.rawArguments) ? call.rawArguments : null;
  if (!args && typeof call.rawArguments === 'string') {
    try {
      const parsed = JSON.parse(call.rawArguments);
      if (isObject(parsed)) args = parsed;
    } catch (_) {
      return false;
    }
  }
  return isObject(args)
    && Object.keys(args).length === 1
    && args.command === COMPATIBILITY_VALIDATOR_COMMAND;
}

function validationKind(call) {
  const command = call.command;
  if (!command) return null;
  // A validator command observed inside the trace is only an ordinary check. It
  // cannot mint architecture evidence; only the trace-external controller can.
  if (isTrustedCompatibilityValidatorCall(call)) return 'check';

  if (/\b(node|deno)\s+--check\b/i.test(command)) return 'syntax';
  if (/\bnode(?:\.exe)?\s+[^\r\n]*test[^\r\n]*\.js\b/i.test(command)) return 'test';
  if (/\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i.test(command) || /\b(pytest|cargo\s+test|go\s+test)\b/i.test(command)) return 'test';
  if (/\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/i.test(command)) return 'lint';
  if (/\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:type-check|check|validate|build)\b/i.test(command)) return 'check';
  return null;
}

function skillNamesFromCall(call) {
  const raw = typeof call.rawArguments === 'string' ? call.rawArguments : stableStringify(call.rawArguments);
  const source = (raw || call.command).replace(/\\+/g, '/');
  const names = [];
  const pattern = /(?:^|\/)([^\/\s"']+)\/SKILL\.md\b/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) names.push(match[1].toLowerCase());
  if (names.length === 0 && /\bSKILL\.md\b/i.test(source)) names.push('unknown');
  return names;
}

function changedFilesFromCall(call) {
  const source = typeof call.rawArguments === 'string' ? call.rawArguments : stableStringify(call.rawArguments);
  const files = [];
  const pattern = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gim;
  let match;
  while ((match = pattern.exec(source)) !== null) files.push(normalizePath(match[1].trim()));
  let objectArguments = isObject(call.rawArguments) ? call.rawArguments : null;
  if (!objectArguments && typeof call.rawArguments === 'string') {
    try { objectArguments = JSON.parse(call.rawArguments); } catch (_) { objectArguments = null; }
  }
  if (isObject(objectArguments)) {
    for (const key of ['path', 'file', 'file_path', 'target']) {
      if (typeof objectArguments[key] === 'string') files.push(normalizePath(objectArguments[key]));
    }
  }
  return [...new Set(files.filter(Boolean))];
}

function preferExitCodes(codes) {
  const known = codes.filter((code) => code !== null);
  if (known.length === 0) return null;
  return known.find((code) => code !== 0) ?? 0;
}

function numericExitCode(value) {
  const numeric = finiteNumber(value);
  return numeric !== null && Number.isInteger(numeric) ? numeric : null;
}

function genericCodeIsProcessExit(value, isRoot) {
  if (!Object.prototype.hasOwnProperty.call(value, 'code')) return false;
  const numeric = numericExitCode(value.code);
  if (numeric === null || numeric < -255 || numeric > 255) return false;
  const keys = Object.keys(value).map((key) => key.toLowerCase());
  if (keys.some((key) => ['statuscode', 'httpstatus', 'response', 'body', 'data'].includes(key))) {
    return false;
  }
  if (keys.some((key) => [
    'stdout', 'stderr', 'signal', 'cmd', 'command', 'killed', 'pid', 'process',
  ].includes(key))) return true;
  const descriptor = [value.type, value.kind, value.name].filter((item) => typeof item === 'string')
    .join(' ');
  if (/\b(?:process|command|shell|exec)\b/i.test(descriptor)) return true;
  return isRoot && keys.length === 1;
}

function outputExitCode(output) {
  const state = { codes: [], sawSuccess: false };
  const seen = new Set();
  const stack = [{ value: output, isRoot: true }];
  while (stack.length > 0) {
    const { value, isRoot } = stack.pop();
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (isObject(parsed) || Array.isArray(parsed)) stack.push({ value: parsed, isRoot });
      } catch (_) {
        // Non-JSON output is scanned as human-readable text below.
      }
      for (const match of value.matchAll(
        /(?:exit\s*code|process exited with code)\s*[:=]?\s*(-?\d+)/gi,
      )) {
        const code = numericExitCode(match[1]);
        if (code !== null) state.codes.push(code);
      }
      continue;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, isRoot: false });
      continue;
    }
    if (value.status === 'success' || value.ok === true) state.sawSuccess = true;
    for (const [key, child] of Object.entries(value)) {
      if (/^exit_?code$/i.test(key)) {
        const code = numericExitCode(child);
        if (code !== null) state.codes.push(code);
      }
      stack.push({ value: child, isRoot: false });
    }
    if (genericCodeIsProcessExit(value, isRoot)) state.codes.push(numericExitCode(value.code));
  }
  const authoritative = preferExitCodes(state.codes);
  if (authoritative !== null) return authoritative;
  return state.sawSuccess ? 0 : null;
}

function isTruncatedOutput(output) {
  return /(?:output|tokens?|content).{0,20}truncated|truncated.{0,20}(?:output|tokens?|content)|\.\.\.\s*\d+\s+tokens?\s+truncated/i.test(flattenText(output));
}

function cumulativeCounter() {
  return { current: null, offset: 0, total: null };
}

function updateCumulativeCounter(counter, nextValue) {
  const numeric = finiteNumber(nextValue);
  if (numeric === null) return;
  if (counter.current !== null && numeric < counter.current) counter.offset += counter.current;
  counter.current = numeric;
  counter.total = counter.offset + numeric;
}

function createAnalysisState(options = {}) {
  const taskSpecHash = typeof options.taskSpecHash === 'string'
    ? options.taskSpecHash
    : (typeof options.taskSpec === 'string' ? sha256(Buffer.from(options.taskSpec, 'utf8')) : null);
  const state = {
    caseId: options.caseId || null,
    identity: {
      taskSpecHash,
      repoCommit: options.repoCommit || null,
      codexVersion: options.codexVersion || null,
      model: null,
      effort: null,
      serviceTier: options.serviceTier || null,
      sandbox: options.sandbox || null,
      pluginInventoryHash: options.pluginInventoryHash || null,
      hookInventoryHash: options.hookInventoryHash || null,
      toolCatalogHash: options.toolCatalogHash || null,
    },
    requestedIdentity: {
      model: stringValue(options.model),
      effort: stringValue(options.effort),
    },
    observedIdentity: { model: new Set(), effort: new Set() },
    authoritativeSessionMetaSeen: false,
    identityEvidence: null,
    analysisErrors: new Set(),
    requestedCompatibility: requestedCompatibility(options),
    compatibility: emptyCompatibility(),
    externalArchitectureEvidence: options.externalArchitectureEvidence || null,
    compatibilityEvidence: null,
    warnings: new Set(),
    eventMinimum: null, eventMaximum: null, taskStart: null, taskEnd: null,
    taskDurationTotal: 0, taskDurationCount: 0, completedTurns: new Set(),
    firstVisible: null, firstTool: null, firstRepoRead: null, firstMutation: null,
    mutationDetected: false,
    outerToolCalls: 0, preMutationToolCalls: 0,
    skillReadCalls: 0, skillNames: new Set(), skillOutputTruncations: 0,
    learnedContextInjectionCount: 0, cavemanInjectionCount: 0,
    compactionCount: 0, compactionBeforeFirstMutationCount: 0, compactionKeys: new Set(),
    turnAborted: false, pendingTools: new Map(), toolIntervals: [],
    sawTimedToolCall: false, incompleteTimedTool: false,
    initialInputTokens: null, finalInputTokens: null, currentContextTokens: null,
    contextWindow: finiteNumber(options.contextWindow), peakContextRatio: null,
    contextAtFirstMutationRatio: null,
    cumulativeInput: cumulativeCounter(), cumulativeCachedInput: cumulativeCounter(),
    cumulativeOutput: cumulativeCounter(), cumulativeReasoning: cumulativeCounter(),
    validationCommands: [],
    changedFiles: new Set((options.changedFiles || []).map(normalizePath)),
    changedFilesObserved: Array.isArray(options.changedFiles),
    expectedChangedFiles: new Set((options.expectedChangedFiles || []).map(normalizePath)),
    expectedChangedFilesObserved: Array.isArray(options.expectedChangedFiles),
    accepted: booleanValue(options.accepted), p0Escape: booleanValue(options.p0Escape),
    falseCompletion: booleanValue(options.falseCompletion), qualityExitCode: finiteNumber(options.exitCode),
  };
  for (const field of [
    'visionRequired', 'visionSupported', 'visionFallbackVerified',
    'collaborationAvailable', 'collaborationFallbackVerified',
  ]) {
    if (booleanValue(options[field]) !== null) {
      state.warnings.add(`external-live-capability-unverified:${field}`);
    }
  }
  return state;
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) {
    throw new Error(`input exceeds ${MAX_JSON_BYTES} bytes: ${filePath}`);
  }
  return raw.split(/\r?\n/).filter((line) => line.trim() !== '').map((line, index) => {
    try { return JSON.parse(line); } catch (error) {
      throw new Error(`invalid JSON at ${filePath}:${index + 1}: ${error.message}`);
    }
  });
}

function readRecords(input) {
  if (Array.isArray(input)) return input;
  if (isObject(input)) return [input];
  if (typeof input !== 'string') throw new Error('records must be an array, object, file path, or JSONL text');
  const raw = fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : input;
  if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) throw new Error('input is too large');
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed;
  }
  return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) {
      throw new Error(`invalid JSON at line ${index + 1}: ${error.message}`);
    }
  });
}

function updateEventBounds(state, timestamp) {
  if (!Number.isFinite(timestamp)) return;
  state.eventMinimum = state.eventMinimum === null ? timestamp : Math.min(state.eventMinimum, timestamp);
  state.eventMaximum = state.eventMaximum === null ? timestamp : Math.max(state.eventMaximum, timestamp);
}

function uuidLike(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isAuthoritativeSessionMeta(row) {
  if (row.type !== 'session_meta' || !isObject(row.payload)
      || toTimestampMs(row.timestamp) === null) return false;
  const payload = row.payload;
  return uuidLike(payload.id)
    && toTimestampMs(payload.timestamp) !== null
    && stringValue(payload.cwd) !== null
    && stringValue(payload.originator) !== null
    && stringValue(payload.cli_version) !== null
    && stringValue(payload.source) !== null
    && stringValue(payload.model_provider) !== null;
}

function authoritativeTurnIdentity(row, sessionMetaSeen) {
  if (!sessionMetaSeen || row.type !== 'turn_context' || !isObject(row.payload)
      || toTimestampMs(row.timestamp) === null) return null;
  const payload = row.payload;
  if (!uuidLike(payload.turn_id)
      || stringValue(payload.cwd) === null
      || stringValue(payload.approval_policy) === null
      || !isObject(payload.sandbox_policy)
      || stringValue(payload.sandbox_policy.type) === null) return null;
  const model = stringValue(payload.model);
  const effort = stringValue(payload.effort);
  return model !== null && effort !== null ? { model, effort } : null;
}

function mergeIdentityFromRow(state, row) {
  const payload = isObject(row.payload) ? row.payload : row;
  if (isAuthoritativeSessionMeta(row)) state.authoritativeSessionMetaSeen = true;
  const observed = authoritativeTurnIdentity(row, state.authoritativeSessionMetaSeen);
  if (observed) {
    state.observedIdentity.model.add(observed.model);
    state.observedIdentity.effort.add(observed.effort);
  }
  const mappings = {
    repoCommit: ['repoCommit', 'repo_commit', 'git_commit'],
    codexVersion: ['cli_version', 'codexVersion', 'codex_version'],
    serviceTier: ['serviceTier', 'service_tier'],
    sandbox: ['sandbox', 'sandbox_mode', 'sandbox_policy.type', 'file_system_sandbox_policy.kind'],
  };
  for (const [key, paths] of Object.entries(mappings)) {
    if (state.identity[key] !== null) continue;
    const value = firstDefined(payload, paths);
    if (value !== null && !isObject(value)) state.identity[key] = String(value);
  }
  const inventories = {
    pluginInventoryHash: ['pluginInventoryHash', 'plugin_inventory_hash', 'plugins'],
    hookInventoryHash: ['hookInventoryHash', 'hook_inventory_hash', 'hooks'],
    toolCatalogHash: ['toolCatalogHash', 'tool_catalog_hash', 'dynamic_tools'],
  };
  for (const [key, paths] of Object.entries(inventories)) {
    if (state.identity[key] !== null) continue;
    const value = firstDefined(payload, paths);
    if (value !== null) state.identity[key] = hashInventory(value);
  }
}

function finalizeObservedIdentity(state) {
  const evidence = {};
  for (const field of ['model', 'effort']) {
    const requested = state.requestedIdentity[field];
    const observed = [...state.observedIdentity[field]].sort();
    let source;
    if (observed.length === 1) {
      state.identity[field] = observed[0];
      source = 'observed-trace';
      if (requested !== null && requested !== observed[0]) {
        state.analysisErrors.add(
          `requested-observed-identity-mismatch:${field}:${requested}!=${observed[0]}`
        );
      }
    } else if (observed.length > 1) {
      state.identity[field] = null;
      source = 'conflicting-observed';
      state.analysisErrors.add(`conflicting-observed-identity:${field}:${observed.join(',')}`);
    } else {
      state.identity[field] = null;
      source = 'missing';
      state.analysisErrors.add(`missing-observed-identity:${field}`);
    }
    evidence[field] = { requested, observed, source };
  }
  state.identityEvidence = evidence;
}
function updateTokenMetrics(state, row) {
  const payload = isObject(row.payload) ? row.payload : row;
  const info = isObject(payload.info) ? payload.info : payload;
  const total = isObject(info.total_token_usage) ? info.total_token_usage
    : (isObject(info.totalTokenUsage) ? info.totalTokenUsage : info);
  const last = isObject(info.last_token_usage) ? info.last_token_usage
    : (isObject(info.lastTokenUsage) ? info.lastTokenUsage : total);
  updateCumulativeCounter(state.cumulativeInput, firstDefined(total, ['input_tokens', 'inputTokens']));
  updateCumulativeCounter(state.cumulativeCachedInput, firstDefined(total, ['cached_input_tokens', 'cachedInputTokens']));
  updateCumulativeCounter(state.cumulativeOutput, firstDefined(total, ['output_tokens', 'outputTokens']));
  updateCumulativeCounter(state.cumulativeReasoning,
    firstDefined(total, ['reasoning_output_tokens', 'reasoning_tokens', 'reasoningTokens']));
  const lastInput = finiteNumber(firstDefined(last, ['input_tokens', 'inputTokens']));
  const lastTotal = finiteNumber(firstDefined(last, ['total_tokens', 'totalTokens']));
  const contextTokens = lastInput !== null ? lastInput : lastTotal;
  const contextWindow = finiteNumber(firstDefined(info, ['model_context_window', 'context_window', 'contextWindow']));
  if (contextWindow !== null) state.contextWindow = contextWindow;
  if (contextTokens !== null) {
    if (state.initialInputTokens === null) state.initialInputTokens = contextTokens;
    state.finalInputTokens = contextTokens;
    state.currentContextTokens = contextTokens;
    if (state.contextWindow) {
      const ratio = contextTokens / state.contextWindow;
      state.peakContextRatio = state.peakContextRatio === null ? ratio : Math.max(state.peakContextRatio, ratio);
    }
  }
}

function addCompaction(state, row, rowIndex) {
  const payload = isObject(row.payload) ? row.payload : row;
  const name = String(firstDefined(payload, ['type', 'event', 'name']) || row.type || '').toLowerCase();
  if (!/(context_)?compact(?:ion|ed)|compacted/.test(name)) return;
  const key = `${name}:${firstDefined(payload, ['id', 'turn_id']) || rowIndex}`;
  if (state.compactionKeys.has(key)) return;
  state.compactionKeys.add(key);
  state.compactionCount += 1;
  if (!state.mutationDetected) state.compactionBeforeFirstMutationCount += 1;
}

function handleLifecycleEvent(state, row, timestamp, rowIndex) {
  const payload = isObject(row.payload) ? row.payload : row;
  const name = String(firstDefined(payload, ['type', 'event', 'name']) || row.type || '').toLowerCase();
  if (/task_started|turn_started|agent_start/.test(name)) {
    state.taskStart = state.taskStart === null ? timestamp : Math.min(state.taskStart, timestamp);
  }
  if (name === 'user_message' && Number.isFinite(timestamp)
      && state.firstVisible === null && state.firstTool === null) {
    state.taskStart = timestamp;
  }
  if (/task_complete|task_completed|turn_complete|turn_completed|agent_stop/.test(name)) {
    state.taskEnd = state.taskEnd === null ? timestamp : Math.max(state.taskEnd, timestamp);
    const duration = finiteNumber(firstDefined(payload, ['duration_ms', 'wall_ms', 'elapsed_ms']));
    const turnId = String(firstDefined(payload, ['turn_id', 'id']) || `row-${rowIndex}`);
    if (duration !== null && !state.completedTurns.has(turnId)) {
      state.completedTurns.add(turnId);
      state.taskDurationTotal += duration;
      state.taskDurationCount += 1;
    }
  }
  if (/turn_aborted|task_aborted|agent_aborted|cancelled|canceled/.test(name)) state.turnAborted = true;
  if (/token_count|token_usage|usage/.test(name)) updateTokenMetrics(state, row);
  addCompaction(state, row, rowIndex);
}

function countContextSignals(state, row) {
  const payload = isObject(row.payload) ? row.payload : row;
  const text = flattenText(firstDefined(payload, ['message', 'content', 'text']) || '');
  if (/<learned-context\b/i.test(text)) {
    state.learnedContextInjectionCount += 1;
  }
  if (/<caveman-mode\b/i.test(text)) state.cavemanInjectionCount += 1;
}

function validationCommandRecord(call, output) {
  const kind = validationKind(call);
  if (!kind) return null;
  const normalizedCommand = call.command.replace(/\s+/g, ' ').trim();
  return {
    kind,
    exitCode: outputExitCode(output),
    commandHash: sha256(normalizedCommand),
  };
}

function normalizeCompatibilityMarker(marker) {
  if (!isObject(marker)) throw new Error('compatibility marker must be an object');
  if (marker.schemaVersion !== COMPATIBILITY_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion: ${marker.schemaVersion}`);
  }
  assertAllowedFields(marker,
    ['schemaVersion', 'sprint', 'fallbackContracts'], 'compatibility marker');
  assertRequiredFields(marker,
    ['schemaVersion', 'sprint', 'fallbackContracts'], 'compatibility marker');
  assertAllowedFields(marker.sprint,
    ['phases', 'resumeVerified'], 'compatibility marker.sprint');
  assertRequiredFields(marker.sprint,
    ['phases', 'resumeVerified'], 'compatibility marker.sprint');
  assertAllowedFields(marker.fallbackContracts,
    ['visionVerified', 'collaborationVerified'], 'compatibility marker.fallbackContracts');
  assertRequiredFields(marker.fallbackContracts,
    ['visionVerified', 'collaborationVerified'], 'compatibility marker.fallbackContracts');
  for (const [label, value] of [
    ['sprint.resumeVerified', marker.sprint.resumeVerified],
    ['fallbackContracts.visionVerified', marker.fallbackContracts.visionVerified],
    ['fallbackContracts.collaborationVerified',
      marker.fallbackContracts.collaborationVerified],
  ]) {
    if (typeof value !== 'boolean') {
      throw new Error(`compatibility marker.${label} must be a boolean`);
    }
  }
  assertStringArray(marker.sprint.phases, 'compatibility marker.sprint.phases');
  if (new Set(marker.sprint.phases).size !== marker.sprint.phases.length) {
    throw new Error('compatibility marker.sprint.phases must not contain duplicates');
  }
  const unsupportedPhases = marker.sprint.phases.filter((phase) => !SPRINT_PHASES.includes(phase));
  if (unsupportedPhases.length > 0) {
    throw new Error(`compatibility marker.sprint.phases are unsupported: ${unsupportedPhases.join(',')}`);
  }
  return {
    sprintPhases: [...marker.sprint.phases],
    resumeVerified: marker.sprint.resumeVerified,
    visionFallbackContractVerified: marker.fallbackContracts.visionVerified,
    collaborationFallbackContractVerified: marker.fallbackContracts.collaborationVerified,
  };
}
function cloneCompatibility(values) {
  if (values === null) return null;
  return {
    ...values,
    sprintPhases: Array.isArray(values.sprintPhases) ? [...values.sprintPhases] : null,
  };
}

function compatibilityValueText(value) {
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

function finalizeCompatibilityEvidence(state) {
  const requested = cloneCompatibility(state.requestedCompatibility);
  const artifact = state.externalArchitectureEvidence;
  if (!artifact) {
    state.compatibility = emptyCompatibility();
    state.compatibilityEvidence = {
      schemaVersion: EXTERNAL_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION,
      source: 'missing', requested, observed: null, attestation: null,
    };
    if (compatibilityWasRequested(requested)) {
      state.analysisErrors.add('missing-external-compatibility-evidence');
    }
    return;
  }
  try {
    validateExternalArchitectureEvidence(artifact, false);
  } catch (error) {
    state.compatibility = emptyCompatibility();
    state.compatibilityEvidence = {
      schemaVersion: EXTERNAL_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION,
      source: 'missing', requested, observed: null, attestation: null,
    };
    state.analysisErrors.add(`invalid-external-compatibility-evidence:${error.message}`);
    return;
  }
  const observed = cloneCompatibility(artifact.observed);
  state.compatibility = observed;
  state.compatibilityEvidence = {
    ...externalArtifactFromEvidence(artifact),
    requested,
  };
  for (const field of Object.keys(requested)) {
    if (requested[field] === null) continue;
    const matches = Array.isArray(requested[field])
      ? JSON.stringify(requested[field]) === JSON.stringify(observed[field])
      : requested[field] === observed[field];
    if (!matches) {
      state.analysisErrors.add(
        `requested-observed-compatibility-mismatch:${field}:`
        + `${compatibilityValueText(requested[field])}!=${compatibilityValueText(observed[field])}`
      );
    }
  }
}
function mergeIntervals(intervals) {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const interval of sorted) {
    const current = merged[merged.length - 1];
    if (!current || interval[0] > current[1]) merged.push(interval.slice());
    else current[1] = Math.max(current[1], interval[1]);
  }
  return merged;
}

function elapsedFrom(start, timestamp) {
  return Number.isFinite(start) && Number.isFinite(timestamp) ? Math.max(0, timestamp - start) : null;
}

function addMissingWarnings(record, warnings) {
  const paths = [
    'identity.taskSpecHash', 'identity.repoCommit', 'identity.codexVersion', 'identity.model',
    'identity.effort', 'identity.serviceTier', 'identity.sandbox', 'identity.pluginInventoryHash',
    'identity.hookInventoryHash', 'identity.toolCatalogHash', 'timing.wallMs', 'timing.ttfVisibleMs',
    'timing.ttfToolMs', 'timing.ttfRepoReadMs', 'timing.toolWallMs', 'context.cumulativeInputTokens',
    'context.contextWindow', 'quality.accepted', 'quality.p0Escape', 'quality.falseCompletion',
  ];
  for (const metricPath of paths) {
    if (getPath(record, metricPath) === null || getPath(record, metricPath) === undefined) {
      warnings.add(`missing:${metricPath}`);
    }
  }
}

function analyzeTrace(input, options = {}) {
  const rows = readRecords(input);
  const state = createAnalysisState(options);
  state.identity.pluginInventoryHash = hashInventory(options.pluginInventoryHash || options.pluginInventory);
  state.identity.hookInventoryHash = hashInventory(options.hookInventoryHash || options.hookInventory);
  state.identity.toolCatalogHash = hashInventory(options.toolCatalogHash || options.toolCatalog);

  rows.forEach((row, rowIndex) => {
    if (!isObject(row)) {
      state.warnings.add(`ignored-non-object-row:${rowIndex + 1}`);
      return;
    }
    const timestamp = extractRowTimestamp(row);
    updateEventBounds(state, timestamp);
    mergeIdentityFromRow(state, row);
    handleLifecycleEvent(state, row, timestamp, rowIndex);
    countContextSignals(state, row);
    if (isVisibleMessage(row) && state.firstVisible === null && timestamp !== null) state.firstVisible = timestamp;

    const call = extractToolCall(row, rowIndex);
    if (call) {
      state.outerToolCalls += 1;
      if (state.firstTool === null && call.timestamp !== null) state.firstTool = call.timestamp;
      if (isRepoRead(call) && state.firstRepoRead === null && call.timestamp !== null) state.firstRepoRead = call.timestamp;
      const mutating = isMutation(call);
      if (!state.mutationDetected && !mutating) state.preMutationToolCalls += 1;
      if (mutating && !state.mutationDetected) {
        state.mutationDetected = true;
        state.firstMutation = call.timestamp;
        if (state.contextWindow && state.currentContextTokens !== null) {
          state.contextAtFirstMutationRatio = state.currentContextTokens / state.contextWindow;
        }
      }
      const skills = skillNamesFromCall(call);
      if (skills.length > 0) {
        state.skillReadCalls += skills.length;
        skills.forEach((name) => state.skillNames.add(name));
      }
      changedFilesFromCall(call).forEach((file) => state.changedFiles.add(file));
      if (call.timestamp !== null) state.sawTimedToolCall = true;
      if (call.completedOutput) {
        const output = call.completedOutput;
        if (call.timestamp !== null && output.timestamp !== null
            && output.timestamp >= call.timestamp) {
          state.toolIntervals.push([call.timestamp, output.timestamp]);
        } else if (call.timestamp !== null) state.incompleteTimedTool = true;
        if (skills.length > 0 && isTruncatedOutput(output.output)) {
          state.skillOutputTruncations += 1;
        }
        const validation = validationCommandRecord(call, output.output);
        if (validation) {
          state.validationCommands.push(validation);
        }
        return;
      }
      state.pendingTools.set(call.id, { call, skills });
      return;
    }
    const output = extractToolOutput(row);
    if (!output) return;
    const pending = state.pendingTools.get(output.id);
    if (!pending) return;
    if (pending.call.timestamp !== null && output.timestamp !== null && output.timestamp >= pending.call.timestamp) {
      state.toolIntervals.push([pending.call.timestamp, output.timestamp]);
    } else if (pending.call.timestamp !== null) state.incompleteTimedTool = true;
    if (pending.skills.length > 0 && isTruncatedOutput(output.output)) state.skillOutputTruncations += 1;
    const validation = validationCommandRecord(pending.call, output.output);
    if (validation) {
      state.validationCommands.push(validation);
    }
    state.pendingTools.delete(output.id);
  });

  finalizeObservedIdentity(state);
  finalizeCompatibilityEvidence(state);
  if (state.taskStart === null) state.taskStart = state.eventMinimum;
  if (state.taskEnd === null) state.taskEnd = state.eventMaximum;
  if (state.pendingTools.size > 0 && state.sawTimedToolCall) state.incompleteTimedTool = true;
  const wallMs = state.taskDurationCount > 0 ? state.taskDurationTotal : elapsedFrom(state.taskStart, state.taskEnd);
  const intervals = mergeIntervals(state.toolIntervals);
  const toolWallMs = intervals.length > 0
    ? intervals.reduce((total, [start, end]) => total + (end - start), 0)
    : (state.outerToolCalls === 0 ? 0 : null);
  const gaps = [];
  if (Number.isFinite(state.taskStart) && Number.isFinite(state.taskEnd)) {
    let cursor = state.taskStart;
    for (const [start, end] of intervals) {
      if (start < state.taskStart || end > state.taskEnd) continue;
      if (start > cursor) gaps.push(start - cursor);
      cursor = Math.max(cursor, end);
    }
    if (state.taskEnd > cursor) gaps.push(state.taskEnd - cursor);
  }
  const duplicateSkillReads = Math.max(0, state.skillReadCalls - state.skillNames.size);
  const qualityExitCode = state.qualityExitCode !== null
    ? state.qualityExitCode
    : (state.validationCommands.length > 0 && state.validationCommands.every((entry) => entry.exitCode !== null)
      ? Math.max(...state.validationCommands.map((entry) => entry.exitCode)) : null);
  const changedFiles = [...state.changedFiles].sort();
  const expectedChangedFiles = [...state.expectedChangedFiles].sort();
  const unexpectedChangedFiles = state.expectedChangedFilesObserved
    ? changedFiles.filter((file) => !state.expectedChangedFiles.has(file)) : [];
  const record = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    caseId: state.caseId,
    analysis: {
      valid: state.analysisErrors.size === 0,
      errors: [...state.analysisErrors].sort(),
    },
    identity: state.identity,
    identityEvidence: state.identityEvidence,
    compatibility: state.compatibility,
    compatibilityEvidence: state.compatibilityEvidence,
    timing: {
      wallMs,
      ttfVisibleMs: elapsedFrom(state.taskStart, state.firstVisible),
      ttfToolMs: elapsedFrom(state.taskStart, state.firstTool),
      ttfRepoReadMs: elapsedFrom(state.taskStart, state.firstRepoRead),
      ttfMutationMs: elapsedFrom(state.taskStart, state.firstMutation),
      toolWallMs,
      nonToolMs: wallMs !== null && toolWallMs !== null ? Math.max(0, wallMs - toolWallMs) : null,
      nonToolGapP50: percentile(gaps, 0.5),
      nonToolGapP90: percentile(gaps, 0.9),
    },
    execution: {
      outerToolCalls: state.outerToolCalls,
      preMutationToolCalls: state.preMutationToolCalls,
      mutationDetected: state.mutationDetected,
      skillReadCalls: state.skillReadCalls,
      uniqueSkills: [...state.skillNames].sort(),
      duplicateSkillReads,
      skillOutputTruncations: state.skillOutputTruncations,
      learnedContextInjectionCount: state.learnedContextInjectionCount,
      cavemanInjectionCount: state.cavemanInjectionCount,
      compactionCount: state.compactionCount,
      preEditCompactionCount: state.compactionBeforeFirstMutationCount,
      turnAborted: state.turnAborted,
    },
    context: {
      initialTokens: state.initialInputTokens,
      finalTokens: state.finalInputTokens,
      cumulativeInputTokens: state.cumulativeInput.total,
      cachedInputTokens: state.cumulativeCachedInput.total,
      outputTokens: state.cumulativeOutput.total,
      reasoningTokens: state.cumulativeReasoning.total,
      contextWindow: state.contextWindow,
      peakContextRatio: state.peakContextRatio,
      contextAtFirstMutationRatio: state.contextAtFirstMutationRatio,
    },
    quality: {
      validationCommands: state.validationCommands,
      exitCode: qualityExitCode,
      changedFiles,
      expectedChangedFiles: state.expectedChangedFilesObserved ? expectedChangedFiles : null,
      unexpectedChangedFiles: state.expectedChangedFilesObserved ? unexpectedChangedFiles : null,
      accepted: state.accepted,
      p0Escape: state.p0Escape,
      falseCompletion: state.falseCompletion,
    },
    warnings: [],
  };
  if (rows.length === 0) state.warnings.add('empty-trace');
  if (state.incompleteTimedTool) state.warnings.add('incomplete-tool-timing');
  if (unexpectedChangedFiles.length > 0) {
    state.warnings.add(`unexpected-changed-files:${unexpectedChangedFiles.join(',')}`);
  }
  addMissingWarnings(record, state.warnings);
  record.warnings = [...state.warnings].sort();
  return record;
}

function walkFiles(rootDirectory) {
  if (!fs.existsSync(rootDirectory)) return [];
  const result = [];
  const stack = [rootDirectory];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  return result;
}

function fingerprintClaudeSurface(repoRoot = process.cwd(), patterns = CLAUDE_SURFACE) {
  const root = path.resolve(repoRoot);
  const warnings = [];
  const discovered = new Map();
  for (const pattern of patterns) {
    const target = path.resolve(root, pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern);
    const files = pattern.endsWith('/**')
      ? walkFiles(target)
      : (fs.existsSync(target) && fs.statSync(target).isFile() ? [target] : []);
    if (files.length === 0) warnings.push(`missing-surface:${pattern}`);
    for (const absolute of files) discovered.set(normalizePath(path.relative(root, absolute)), absolute);
  }
  const entries = [...discovered.entries()].sort(([left], [right]) => left.localeCompare(right));
  const files = entries.map(([relative, absolute]) => {
    const bytes = fs.readFileSync(absolute);
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const aggregate = crypto.createHash('sha256');
  for (const [relative, absolute] of entries) {
    const bytes = fs.readFileSync(absolute);
    const pathBytes = Buffer.from(relative, 'utf8');
    const pathLength = Buffer.allocUnsafe(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const byteLength = Buffer.allocUnsafe(8);
    byteLength.writeBigUInt64BE(BigInt(bytes.length));
    aggregate.update(pathLength).update(pathBytes).update(byteLength).update(bytes);
  }
  return {
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    root,
    patterns: [...patterns],
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    surfaceHash: aggregate.digest('hex'),
    files,
    warnings,
  };
}

function readClaudeSurfaceBaseline(input) {
  if (isObject(input)) return input;
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('Claude surface baseline must be an object, JSON string, or file path');
  }
  const trimmed = input.trim();
  const raw = trimmed.startsWith('{') ? trimmed : fs.readFileSync(path.resolve(input), 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) {
    throw new Error('Claude surface baseline exceeds the maximum JSON size');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid Claude surface baseline JSON: ${error.message}`);
  }
  if (!isObject(parsed)) throw new Error('Claude surface baseline must be a JSON object');
  return parsed;
}

function validateClaudeSurfaceBaseline(input) {
  const baseline = readClaudeSurfaceBaseline(input);
  const fields = [
    'schemaVersion', 'fingerprintSchemaVersion', 'patterns', 'fileCount', 'totalBytes',
    'surfaceHash', 'warnings',
  ];
  assertAllowedFields(baseline, fields, 'Claude surface baseline');
  assertRequiredFields(baseline, fields, 'Claude surface baseline');
  if (baseline.schemaVersion !== CLAUDE_SURFACE_BASELINE_SCHEMA_VERSION) {
    throw new Error(`unsupported Claude surface baseline schema: ${baseline.schemaVersion}`);
  }
  if (baseline.fingerprintSchemaVersion !== FINGERPRINT_SCHEMA_VERSION) {
    throw new Error(`unsupported Claude fingerprint schema: ${baseline.fingerprintSchemaVersion}`);
  }
  if (!Array.isArray(baseline.patterns)
    || baseline.patterns.some((pattern) => typeof pattern !== 'string')
    || JSON.stringify(baseline.patterns) !== JSON.stringify([...CLAUDE_SURFACE])) {
    throw new Error('Claude surface baseline patterns must exactly match the frozen surface');
  }
  if (!Number.isSafeInteger(baseline.fileCount) || baseline.fileCount < 0) {
    throw new Error('Claude surface baseline fileCount must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(baseline.totalBytes) || baseline.totalBytes < 0) {
    throw new Error('Claude surface baseline totalBytes must be a non-negative safe integer');
  }
  if (typeof baseline.surfaceHash !== 'string' || !/^[a-f\d]{64}$/.test(baseline.surfaceHash)) {
    throw new Error('Claude surface baseline surfaceHash must be a lowercase SHA-256 hash');
  }
  if (!Array.isArray(baseline.warnings) || baseline.warnings.length !== 0) {
    throw new Error('Claude surface baseline warnings must be an empty array');
  }
  return baseline;
}

function verifyClaudeSurfaceBaseline(repoRoot, baselineInput) {
  const baseline = validateClaudeSurfaceBaseline(baselineInput);
  const candidate = fingerprintClaudeSurface(repoRoot, baseline.patterns);
  const expected = {
    fingerprintSchemaVersion: baseline.fingerprintSchemaVersion,
    patterns: baseline.patterns,
    fileCount: baseline.fileCount,
    totalBytes: baseline.totalBytes,
    surfaceHash: baseline.surfaceHash,
    warnings: baseline.warnings,
  };
  const actual = {
    fingerprintSchemaVersion: candidate.schemaVersion,
    patterns: candidate.patterns,
    fileCount: candidate.fileCount,
    totalBytes: candidate.totalBytes,
    surfaceHash: candidate.surfaceHash,
    warnings: candidate.warnings,
  };
  const mismatches = Object.keys(expected).filter((field) =>
    stableStringify(expected[field]) !== stableStringify(actual[field])).map((field) => ({
    field,
    expected: expected[field],
    actual: actual[field],
  }));
  return {
    schemaVersion: CLAUDE_SURFACE_VERIFICATION_SCHEMA_VERSION,
    baselineSchemaVersion: baseline.schemaVersion,
    equal: mismatches.length === 0,
    mismatches,
    baseline: expected,
    candidate: actual,
  };
}

function diffFingerprints(baseline, candidate) {
  if (!isObject(baseline) || !isObject(candidate)) throw new Error('both fingerprints are required');
  const left = new Map((baseline.files || []).map((file) => [normalizePath(file.path), file]));
  const right = new Map((candidate.files || []).map((file) => [normalizePath(file.path), file]));
  const added = [...right.keys()].filter((file) => !left.has(file)).sort();
  const removed = [...left.keys()].filter((file) => !right.has(file)).sort();
  const changed = [...left.keys()].filter((file) => right.has(file)
    && left.get(file).sha256 !== right.get(file).sha256).sort();
  return {
    equal: baseline.surfaceHash === candidate.surfaceHash
      && added.length === 0 && removed.length === 0 && changed.length === 0,
    baselineHash: baseline.surfaceHash || null,
    candidateHash: candidate.surfaceHash || null,
    added, removed, changed,
  };
}

const COMPARISON_DIMENSION_FIELDS = Object.freeze(['model', 'effort']);
const PAIR_IDENTITY_FIELDS = Object.freeze([
  'taskSpecHash', 'codexVersion', 'serviceTier', 'sandbox', 'repoCommit',
  'toolCatalogHash', 'pluginInventoryHash', 'hookInventoryHash',
]);

function pairingKey(record) {
  if (!isObject(record) || !isObject(record.identity)) {
    return { key: null, missing: ['caseId', ...PAIR_IDENTITY_FIELDS] };
  }
  const missing = [];
  if (record.caseId === null || record.caseId === undefined || record.caseId === '') {
    missing.push('caseId');
  }
  missing.push(...PAIR_IDENTITY_FIELDS.filter((field) => record.identity[field] === null
    || record.identity[field] === undefined || record.identity[field] === ''));
  if (missing.length > 0) return { key: null, missing };
  const identity = { caseId: record.caseId };
  for (const field of PAIR_IDENTITY_FIELDS) identity[field] = record.identity[field];
  return { key: stableStringify(identity), missing: [] };
}

function safeRatio(candidate, baseline) {
  const left = finiteNumber(candidate);
  const right = finiteNumber(baseline);
  if (left === null || right === null || right <= 0) return null;
  return left / right;
}

function functionalFailures(record, label) {
  const failures = [];
  if (!isObject(record)) return [`${label}:record-missing`];
  if (getPath(record, 'quality.accepted') !== true) failures.push(`${label}:not-accepted`);
  if (getPath(record, 'quality.p0Escape') !== false) failures.push(`${label}:p0-escape-or-unknown`);
  if (getPath(record, 'quality.falseCompletion') !== false) failures.push(`${label}:false-completion-or-unknown`);
  if (getPath(record, 'execution.turnAborted') !== false) failures.push(`${label}:turn-aborted-or-unknown`);
  const validations = getPath(record, 'quality.validationCommands');
  if (!Array.isArray(validations) || validations.length === 0) failures.push(`${label}:no-validation`);
  else if (validations.some((entry) => finiteNumber(entry.exitCode) !== 0)) {
    failures.push(`${label}:validation-failed-or-unknown`);
  }
  const exitCode = getPath(record, 'quality.exitCode');
  if (exitCode !== null && exitCode !== undefined && finiteNumber(exitCode) !== 0) {
    failures.push(`${label}:exit-code`);
  }
  const expected = getPath(record, 'quality.expectedChangedFiles');
  const changed = getPath(record, 'quality.changedFiles');
  if (Array.isArray(expected) && Array.isArray(changed)) {
    const allowed = new Set(expected.map(normalizePath));
    if (changed.some((file) => !allowed.has(normalizePath(file)))) {
      failures.push(`${label}:changed-files-outside-expected`);
    }
  }
  const unexpected = getPath(record, 'quality.unexpectedChangedFiles');
  if (Array.isArray(unexpected) && unexpected.length > 0) {
    failures.push(`${label}:unexpected-changed-files`);
  }
  return failures;
}

function revalidateRecordArchitectureEvidence(row, options = {}, cache = new Map()) {
  if (!isObject(row.compatibilityEvidence)
      || row.compatibilityEvidence.source !== EXTERNAL_COMPATIBILITY_EVIDENCE_SOURCE) return;
  const key = canonicalStringify(externalArtifactFromEvidence(row.compatibilityEvidence));
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached !== true) throw cached;
    return;
  }
  const verifier = options.architectureVerifier || verifyExternalArchitectureEvidence;
  try {
    if (verifier(row.compatibilityEvidence) !== true) {
      throw new Error('external architecture verifier did not return true');
    }
    cache.set(key, true);
  } catch (error) {
    cache.set(key, error);
    throw error;
  }
}

function validateComparisonRows(records, label, options = {}, cache = new Map()) {
  const validRows = [];
  const errors = [];
  records.forEach((record, index) => {
    try {
      validateRecordRow(record);
      revalidateRecordArchitectureEvidence(record, options, cache);
      validRows.push(record);
    } catch (error) {
      errors.push(`${label}[${index}] invalid-record:${error.message}`);
    }
  });
  return { validRows, errors };
}

function comparisonDimensionState(records, label) {
  const values = {};
  const valid = {};
  const errors = [];
  for (const field of COMPARISON_DIMENSION_FIELDS) {
    const observed = records.map((record) => getPath(record, `identity.${field}`));
    const missing = observed.filter((value) => typeof value !== 'string' || value.trim() === '').length;
    const distinct = [...new Set(observed.filter((value) => typeof value === 'string'
      && value.trim() !== ''))].sort();
    valid[field] = records.length > 0 && missing === 0 && distinct.length === 1;
    values[field] = valid[field] ? distinct[0] : null;
    if (records.length > 0 && missing > 0) {
      errors.push(`${label}-comparison-dimension-missing:${field}:${missing}/${records.length}`);
    }
    if (distinct.length > 1) {
      errors.push(`${label}-comparison-dimension-inconsistent:${field}:${distinct.join(',')}`);
    }
  }
  return { values, valid, errors };
}

function pairRecords(baselines, candidates) {
  const errors = [];
  const baselineGroups = new Map();
  const candidateGroups = new Map();
  function add(records, groups, label) {
    records.forEach((record, index) => {
      const pairing = pairingKey(record);
      if (!pairing.key) {
        errors.push(`${label}[${index}] missing pairing identity: ${pairing.missing.join(',')}`);
        return;
      }
      if (!groups.has(pairing.key)) groups.set(pairing.key, []);
      groups.get(pairing.key).push(record);
    });
  }
  add(baselines, baselineGroups, 'baseline');
  add(candidates, candidateGroups, 'candidate');
  const keys = [...new Set([...baselineGroups.keys(), ...candidateGroups.keys()])].sort();
  const pairs = [];
  for (const key of keys) {
    const left = baselineGroups.get(key) || [];
    const right = candidateGroups.get(key) || [];
    if (left.length > 1 || right.length > 1) {
      errors.push(`duplicate-pairing-identity:${key.slice(0, 48)} baseline=${left.length} candidate=${right.length}`);
      continue;
    }
    if (left.length !== right.length) {
      errors.push(`pair-count-mismatch:${key.slice(0, 48)} baseline=${left.length} candidate=${right.length}`);
      continue;
    }
    for (let index = 0; index < left.length; index += 1) {
      pairs.push({ baseline: left[index], candidate: right[index], pairingKey: key });
    }
  }
  return { pairs, errors };
}

function compatibilityPolicyInputErrors(records, label) {
  const errors = [];
  records.forEach((record, index) => {
    if (!isObject(record.analysis)) errors.push(`${label}[${index}] missing-analysis-evidence`);
    if (!isObject(record.identityEvidence)) {
      errors.push(`${label}[${index}] missing-identity-evidence`);
    }
    if (!isObject(record.compatibility) || !isObject(record.compatibilityEvidence)) {
      errors.push(`${label}[${index}] missing-compatibility-evidence`);
    } else if (record.compatibilityEvidence.source !== EXTERNAL_COMPATIBILITY_EVIDENCE_SOURCE) {
      errors.push(
        `${label}[${index}] compatibility-evidence-not-observed:`
        + `${record.compatibilityEvidence.source || 'missing'}`
      );
    }
  });
  return errors;
}

function compareRuns(baselineInput, candidateInput, options = {}) {
  const baselines = readRecords(baselineInput);
  const candidates = readRecords(candidateInput);
  const architectureEvidenceCache = new Map();
  const baselineValidation = validateComparisonRows(
    baselines, 'baseline', options, architectureEvidenceCache
  );
  const candidateValidation = validateComparisonRows(
    candidates, 'candidate', options, architectureEvidenceCache
  );
  const baselineDimensions = comparisonDimensionState(baselineValidation.validRows, 'baseline');
  const candidateDimensions = comparisonDimensionState(candidateValidation.validRows, 'candidate');
  const comparisonDimensions = {
    baseline: baselineDimensions.values,
    candidate: candidateDimensions.values,
    changed: Object.fromEntries(COMPARISON_DIMENSION_FIELDS.map((field) => [
      field,
      baselineDimensions.values[field] !== null && candidateDimensions.values[field] !== null
        ? baselineDimensions.values[field] !== candidateDimensions.values[field]
        : null,
    ])),
  };
  const inputErrors = [
    ...baselineValidation.errors,
    ...candidateValidation.errors,
    ...baselineDimensions.errors,
    ...candidateDimensions.errors,
  ];
  const policyId = options.policyId || 'gpt56-sprint-v1';
  const policy = POLICIES[policyId];
  if (!policy) {
    return {
      schemaVersion: COMPARE_SCHEMA_VERSION, policyId, valid: false, passed: false,
      errors: [`unknown-policy:${policyId}`, ...inputErrors], warnings: [], pairCount: 0,
      pairs: [], metrics: {}, gates: [], caseCoverage: {}, comparisonDimensions,
    };
  }
  if (policy.kind === 'compatibility') {
    inputErrors.push(
      ...compatibilityPolicyInputErrors(baselineValidation.validRows, 'baseline'),
      ...compatibilityPolicyInputErrors(candidateValidation.validRows, 'candidate')
    );
  }
  const paired = pairRecords(baselineValidation.validRows, candidateValidation.validRows);
  const errors = [...inputErrors, ...paired.errors];
  const comparisonDimensionsValid = COMPARISON_DIMENSION_FIELDS.every((field) =>
    baselineDimensions.valid[field] && candidateDimensions.valid[field]);
  const changedComparisonDimensionCount = COMPARISON_DIMENSION_FIELDS.filter((field) =>
    comparisonDimensions.changed[field] === true).length;
  if (comparisonDimensionsValid
    && changedComparisonDimensionCount < policy.minimumChangedComparisonDimensions) {
    errors.push(
      `minimum-changed-comparison-dimensions:${changedComparisonDimensionCount}/${policy.minimumChangedComparisonDimensions}`
    );
  }
  if (paired.pairs.length < policy.minimumPairs) {
    errors.push(`minimum-pairs:${paired.pairs.length}/${policy.minimumPairs}`);
  }
  if (baselines.length === 0 || candidates.length === 0) errors.push('empty-input');
  const caseCoverage = {};
  for (const caseId of CASES) {
    const actual = paired.pairs.filter((pair) => pair.baseline.caseId === caseId
      && pair.candidate.caseId === caseId).length;
    const required = policy.minimumPairsByCase[caseId] || 0;
    caseCoverage[caseId] = { actual, required };
    if (actual < required) errors.push(`minimum-case-pairs:${caseId}:${actual}/${required}`);
  }
  const ratioPaths = policy.kind === 'performance' ? {
    wallMs: 'timing.wallMs',
    ttfVisibleMs: 'timing.ttfVisibleMs',
    ttfMutationMs: 'timing.ttfMutationMs',
    cumulativeInputTokens: 'context.cumulativeInputTokens',
    preMutationToolCalls: 'execution.preMutationToolCalls',
  } : {};
  const pairSummaries = [];
  const ratios = Object.fromEntries(Object.keys(ratioPaths).map((metric) => [metric, []]));
  for (const [index, pair] of paired.pairs.entries()) {
    const caseId = pair.candidate.caseId || pair.baseline.caseId || null;
    const metricRatios = {};
    for (const [metric, metricPath] of Object.entries(ratioPaths)) {
      const ratio = safeRatio(getPath(pair.candidate, metricPath), getPath(pair.baseline, metricPath));
      metricRatios[metric] = ratio;
      if (ratio !== null) ratios[metric].push(ratio);
      else if (!(metric === 'ttfMutationMs' && caseId === 'L3-security-review')) {
        errors.push(`pair[${index}] missing-ratio:${metric}`);
      }
    }
    pairSummaries.push({
      index, caseId, taskSpecHash: pair.candidate.identity.taskSpecHash, ratios: metricRatios,
    });
  }
  const metrics = {};
  for (const metric of Object.keys(ratioPaths)) {
    metrics[metric] = {
      medianRatio: median(ratios[metric]),
      samples: ratios[metric].length,
      maximumRatio: ratios[metric].length ? Math.max(...ratios[metric]) : null,
    };
  }
  const gates = [];
  function gate(name, passed, detail) {
    gates.push({ name, passed: Boolean(passed), detail });
  }
  for (const field of COMPARISON_DIMENSION_FIELDS) {
    gate(`comparison-dimension:baseline:${field}`, baselineDimensions.valid[field],
      baselineDimensions.values[field]);
    gate(`comparison-dimension:candidate:${field}`, candidateDimensions.valid[field],
      candidateDimensions.values[field]);
  }
  gate('minimum-changed-comparison-dimensions', comparisonDimensionsValid
    && changedComparisonDimensionCount >= policy.minimumChangedComparisonDimensions, {
    actual: changedComparisonDimensionCount,
    required: policy.minimumChangedComparisonDimensions,
    changed: comparisonDimensions.changed,
  });
  for (const caseId of CASES) {
    const coverage = caseCoverage[caseId];
    gate(`case-coverage:${caseId}`, coverage.actual >= coverage.required, coverage);
  }
  for (const [index, pair] of paired.pairs.entries()) {
    const functional = [
      ...functionalFailures(pair.baseline, `pair[${index}].baseline`),
      ...functionalFailures(pair.candidate, `pair[${index}].candidate`),
    ];
    gate(`pair[${index}].functional`, functional.length === 0, functional);
    const candidate = pair.candidate;
    const caseId = candidate.caseId || pair.baseline.caseId;
    if (policy.kind === 'performance') {
      const mutationTime = getPath(candidate, 'timing.ttfMutationMs');
      const changedFiles = getPath(candidate, 'quality.changedFiles');
      const hasMutation = getPath(candidate, 'execution.mutationDetected') === true
        || (mutationTime !== null && mutationTime !== undefined)
        || (Array.isArray(changedFiles) && changedFiles.length > 0);
      const mutationContext = finiteNumber(getPath(candidate, 'context.contextAtFirstMutationRatio'));
      if (hasMutation) {
        gate(`pair[${index}].context-at-first-mutation`,
          mutationContext !== null && mutationContext <= policy.contextAtFirstMutationMaximum,
          mutationContext);
      }
      const learned = finiteNumber(getPath(candidate, 'execution.learnedContextInjectionCount'));
      gate(`pair[${index}].learned-context-injections`,
        learned !== null && learned <= policy.maximumLearnedContextInjections, learned);
      const caveman = finiteNumber(getPath(candidate, 'execution.cavemanInjectionCount'));
      gate(`pair[${index}].caveman-injections`,
        caveman !== null && caveman <= policy.maximumCavemanInjections, caveman);
      gate(`pair[${index}].duplicate-skill-reads`,
        getPath(candidate, 'execution.duplicateSkillReads') === 0,
        getPath(candidate, 'execution.duplicateSkillReads'));
      gate(`pair[${index}].skill-output-truncations`,
        getPath(candidate, 'execution.skillOutputTruncations') === 0,
        getPath(candidate, 'execution.skillOutputTruncations'));
      if (caseId === 'L1-single-file' || caseId === 'L2-multi-file') {
        gate(`pair[${index}].no-pre-edit-compaction`,
          getPath(candidate, 'execution.preEditCompactionCount') === 0,
          getPath(candidate, 'execution.preEditCompactionCount'));
      }
      if (caseId === 'L3-security-review') {
        gate(`pair[${index}].review-no-mutation`, !hasMutation, mutationTime);
      }
    } else if (policy.kind === 'compatibility') {
      for (const side of ['baseline', 'candidate']) {
        for (const field of COMPARISON_DIMENSION_FIELDS) {
          const source = getPath(pair[side], `identityEvidence.${field}.source`);
          gate(`pair[${index}].${side}-identity-observed:${field}`,
            source === 'observed-trace', source || null);
        }
        const compatibilitySource = getPath(pair[side], 'compatibilityEvidence.source');
        gate(`pair[${index}].${side}-compatibility-observed`,
          compatibilitySource === EXTERNAL_COMPATIBILITY_EVIDENCE_SOURCE,
          compatibilitySource || null);
      }
      const compatibility = isObject(candidate.compatibility) ? candidate.compatibility : {};
      const sprintPhases = Array.isArray(compatibility.sprintPhases)
        ? compatibility.sprintPhases : [];
      const phasesMatch = JSON.stringify(sprintPhases)
        === JSON.stringify(policy.requiredSprintPhases);
      gate(`pair[${index}].sprint-phases`, phasesMatch, {
        observed: sprintPhases, required: policy.requiredSprintPhases,
      });
      gate(`pair[${index}].resume`, compatibility.resumeVerified === true,
        compatibility.resumeVerified ?? null);
      gate(`pair[${index}].vision-fallback-contract`,
        compatibility.visionFallbackContractVerified === true,
        compatibility.visionFallbackContractVerified ?? null);
      gate(`pair[${index}].collaboration-fallback-contract`,
        compatibility.collaborationFallbackContractVerified === true,
        compatibility.collaborationFallbackContractVerified ?? null);
    }
  }
  if (policy.kind === 'performance') {
    for (const [metric, threshold] of Object.entries(policy.pairedMedianRatios)) {
      gate(`median-ratio:${metric}`,
        metrics[metric].medianRatio !== null && metrics[metric].medianRatio <= threshold,
        { actual: metrics[metric].medianRatio, maximum: threshold });
    }
    const wallNonRegression = pairSummaries.filter((pair) => pair.ratios.wallMs !== null
      && pair.ratios.wallMs <= policy.wallRegressionRatio).length;
    const wallRequired = Math.ceil(paired.pairs.length * policy.wallRegressionPassFraction);
    gate('wall-non-regression-count', wallNonRegression >= wallRequired, {
      actual: wallNonRegression, required: wallRequired, maximumRatio: policy.wallRegressionRatio,
    });
    const l3Pairs = pairSummaries.filter((pair) => pair.caseId === 'L3-security-review');
    if (l3Pairs.length > 0) {
      const l3Wall = median(l3Pairs.map((pair) => pair.ratios.wallMs));
      const l3Input = median(l3Pairs.map((pair) => pair.ratios.cumulativeInputTokens));
      gate('l3-wall-ratio', l3Wall !== null && l3Wall <= policy.l3WallRatio,
        { actual: l3Wall, maximum: policy.l3WallRatio });
      gate('l3-input-ratio', l3Input !== null && l3Input <= policy.l3InputRatio,
        { actual: l3Input, maximum: policy.l3InputRatio });
    }
  }
  const valid = errors.length === 0;
  const passed = valid && gates.every((entry) => entry.passed);
  return {
    schemaVersion: COMPARE_SCHEMA_VERSION,
    policyId,
    valid,
    passed,
    errors,
    warnings: [],
    pairCount: paired.pairs.length,
    pairs: pairSummaries,
    metrics,
    gates,
    caseCoverage,
    comparisonDimensions,
  };
}
function forbiddenRawField(value, trail = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = forbiddenRawField(value[index], [...trail, String(index)]);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  const forbidden = new Set([
    'prompt', 'userprompt', 'rawprompt', 'rawoutput', 'tooloutput', 'assistantoutput', 'response', 'messages',
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) return [...trail, key].join('.');
    const found = forbiddenRawField(child, [...trail, key]);
    if (found) return found;
  }
  return null;
}

const TRACE_TOP_LEVEL_FIELDS = Object.freeze([
  'schemaVersion', 'caseId', 'analysis', 'identity', 'identityEvidence', 'compatibility',
  'compatibilityEvidence', 'timing', 'execution', 'context', 'quality', 'warnings', 'at',
]);
const OPTIONAL_TRACE_TOP_LEVEL_FIELDS = new Set([
  'at', 'compatibility', 'compatibilityEvidence',
]);
const IDENTITY_EVIDENCE_FIELDS = Object.freeze(['requested', 'observed', 'source']);
const IDENTITY_EVIDENCE_SOURCES = new Set([
  'observed-trace', 'conflicting-observed', 'missing',
]);
const COMPATIBILITY_FIELDS = Object.freeze([
  'sprintPhases', 'resumeVerified', 'visionFallbackContractVerified',
  'collaborationFallbackContractVerified',
]);
const TRACE_IDENTITY_FIELDS = Object.freeze([
  'taskSpecHash', 'repoCommit', 'codexVersion', 'model', 'effort', 'serviceTier', 'sandbox',
  'pluginInventoryHash', 'hookInventoryHash', 'toolCatalogHash',
]);
const TRACE_TIMING_FIELDS = Object.freeze([
  'wallMs', 'ttfVisibleMs', 'ttfToolMs', 'ttfRepoReadMs', 'ttfMutationMs', 'toolWallMs',
  'nonToolMs', 'nonToolGapP50', 'nonToolGapP90',
]);
const TRACE_EXECUTION_FIELDS = Object.freeze([
  'outerToolCalls', 'preMutationToolCalls', 'mutationDetected', 'skillReadCalls', 'uniqueSkills',
  'duplicateSkillReads', 'skillOutputTruncations', 'learnedContextInjectionCount',
  'cavemanInjectionCount', 'compactionCount', 'preEditCompactionCount', 'turnAborted',
]);
const TRACE_CONTEXT_FIELDS = Object.freeze([
  'initialTokens', 'finalTokens', 'cumulativeInputTokens', 'cachedInputTokens', 'outputTokens',
  'reasoningTokens', 'contextWindow', 'peakContextRatio', 'contextAtFirstMutationRatio',
]);
const TRACE_QUALITY_FIELDS = Object.freeze([
  'validationCommands', 'exitCode', 'changedFiles', 'expectedChangedFiles', 'unexpectedChangedFiles',
  'accepted', 'p0Escape', 'falseCompletion',
]);
const LEGACY_RECORD_FIELDS = Object.freeze([
  'caseId', 'accepted', 'p0Escape', 'falseCompletion', 'at',
]);

function assertAllowedFields(value, allowedFields, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set(allowedFields);
  const extra = Object.keys(value).filter((field) => !allowed.has(field)).sort();
  if (extra.length > 0) throw new Error(`${label} has unsupported fields: ${extra.join(',')}`);
}

function assertRequiredFields(value, requiredFields, label) {
  const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) throw new Error(`${label} missing fields: ${missing.join(',')}`);
}

function assertNullableNumbers(value, fields, label, options = {}) {
  for (const field of fields) {
    const item = value[field];
    if (item === null) continue;
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new Error(`${label}.${field} must be a finite number or null`);
    }
    if (options.integer && !Number.isSafeInteger(item)) {
      throw new Error(`${label}.${field} must be an integer or null`);
    }
    if (options.minimum !== undefined && item < options.minimum) {
      throw new Error(`${label}.${field} must be >= ${options.minimum} or null`);
    }
    if (options.maximum !== undefined && item > options.maximum) {
      throw new Error(`${label}.${field} must be <= ${options.maximum} or null`);
    }
  }
}

function assertAtMost(left, right, leftLabel, rightLabel) {
  if (left === null || right === null) return;
  if (left > right) throw new Error(`${leftLabel} must be <= ${rightLabel}`);
}

function assertTraceInvariants(row) {
  const { timing, execution, context } = row;
  for (const field of [
    'ttfVisibleMs', 'ttfToolMs', 'ttfRepoReadMs', 'ttfMutationMs', 'toolWallMs', 'nonToolMs',
  ]) {
    assertAtMost(timing[field], timing.wallMs, `timing.${field}`, 'timing.wallMs');
  }
  assertAtMost(timing.nonToolGapP50, timing.nonToolGapP90,
    'timing.nonToolGapP50', 'timing.nonToolGapP90');
  assertAtMost(timing.nonToolGapP90, timing.nonToolMs,
    'timing.nonToolGapP90', 'timing.nonToolMs');
  if (timing.wallMs !== null && timing.toolWallMs !== null && timing.nonToolMs !== null) {
    const tolerance = Math.max(1e-6, Math.abs(timing.wallMs) * 1e-6);
    if (Math.abs((timing.toolWallMs + timing.nonToolMs) - timing.wallMs) > tolerance) {
      throw new Error('timing.toolWallMs + timing.nonToolMs must equal timing.wallMs');
    }
  }

  assertAtMost(execution.preMutationToolCalls, execution.outerToolCalls,
    'execution.preMutationToolCalls', 'execution.outerToolCalls');
  assertAtMost(execution.duplicateSkillReads, execution.skillReadCalls,
    'execution.duplicateSkillReads', 'execution.skillReadCalls');
  assertAtMost(execution.preEditCompactionCount, execution.compactionCount,
    'execution.preEditCompactionCount', 'execution.compactionCount');
  if (new Set(execution.uniqueSkills).size !== execution.uniqueSkills.length) {
    throw new Error('execution.uniqueSkills must not contain duplicates');
  }
  if (execution.skillReadCalls !== null && execution.duplicateSkillReads !== null
      && execution.skillReadCalls - execution.uniqueSkills.length !== execution.duplicateSkillReads) {
    throw new Error('execution.duplicateSkillReads must equal skillReadCalls - uniqueSkills.length');
  }
  if (execution.mutationDetected === true
      && (execution.outerToolCalls === null || execution.outerToolCalls < 1)) {
    throw new Error('execution.mutationDetected=true requires outerToolCalls > 0');
  }
  if (execution.outerToolCalls === 0 && execution.skillReadCalls !== 0) {
    throw new Error('execution.skillReadCalls requires outerToolCalls > 0');
  }
  if (execution.skillReadCalls === null && execution.uniqueSkills.length > 0) {
    throw new Error('execution.uniqueSkills requires execution.skillReadCalls');
  }
  if (execution.mutationDetected === false && timing.ttfMutationMs !== null) {
    throw new Error('timing.ttfMutationMs requires execution.mutationDetected=true');
  }
  if (execution.mutationDetected === false && context.contextAtFirstMutationRatio !== null) {
    throw new Error('context.contextAtFirstMutationRatio requires execution.mutationDetected=true');
  }
  if (timing.ttfRepoReadMs !== null && timing.ttfToolMs === null) {
    throw new Error('timing.ttfRepoReadMs requires timing.ttfToolMs');
  }
  if (timing.ttfMutationMs !== null && timing.ttfToolMs === null) {
    throw new Error('timing.ttfMutationMs requires timing.ttfToolMs');
  }
  assertAtMost(timing.ttfToolMs, timing.ttfRepoReadMs,
    'timing.ttfToolMs', 'timing.ttfRepoReadMs');
  assertAtMost(timing.ttfToolMs, timing.ttfMutationMs,
    'timing.ttfToolMs', 'timing.ttfMutationMs');

  if (context.contextWindow !== null && context.contextWindow <= 0) {
    throw new Error('context.contextWindow must be > 0 or null');
  }
  assertAtMost(context.cachedInputTokens, context.cumulativeInputTokens,
    'context.cachedInputTokens', 'context.cumulativeInputTokens');
  assertAtMost(context.initialTokens, context.cumulativeInputTokens,
    'context.initialTokens', 'context.cumulativeInputTokens');
  assertAtMost(context.finalTokens, context.cumulativeInputTokens,
    'context.finalTokens', 'context.cumulativeInputTokens');
  assertAtMost(context.reasoningTokens, context.outputTokens,
    'context.reasoningTokens', 'context.outputTokens');
  assertAtMost(context.initialTokens, context.contextWindow,
    'context.initialTokens', 'context.contextWindow');
  assertAtMost(context.finalTokens, context.contextWindow,
    'context.finalTokens', 'context.contextWindow');
  assertAtMost(context.contextAtFirstMutationRatio, context.peakContextRatio,
    'context.contextAtFirstMutationRatio', 'context.peakContextRatio');
  if (context.peakContextRatio !== null && context.contextWindow === null) {
    throw new Error('context.peakContextRatio requires context.contextWindow');
  }
  if (context.contextAtFirstMutationRatio !== null && context.peakContextRatio === null) {
    throw new Error('context.contextAtFirstMutationRatio requires context.peakContextRatio');
  }
}

function assertStringArray(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be ${nullable ? 'null or ' : ''}an array of strings`);
  }
}

function validateAnalysisState(analysis) {
  assertAllowedFields(analysis, ['valid', 'errors'], 'analysis');
  assertRequiredFields(analysis, ['valid', 'errors'], 'analysis');
  if (typeof analysis.valid !== 'boolean') throw new Error('analysis.valid must be a boolean');
  assertStringArray(analysis.errors, 'analysis.errors');
  if (analysis.valid !== (analysis.errors.length === 0)) {
    throw new Error('analysis.valid must equal analysis.errors.length === 0');
  }
  if (!analysis.valid) throw new Error(`trace analysis invalid:${analysis.errors.join(';')}`);
}

function validateIdentityEvidence(identityEvidence, identity) {
  assertAllowedFields(identityEvidence, ['model', 'effort'], 'identityEvidence');
  assertRequiredFields(identityEvidence, ['model', 'effort'], 'identityEvidence');
  for (const field of ['model', 'effort']) {
    const evidence = identityEvidence[field];
    const label = `identityEvidence.${field}`;
    assertAllowedFields(evidence, IDENTITY_EVIDENCE_FIELDS, label);
    assertRequiredFields(evidence, IDENTITY_EVIDENCE_FIELDS, label);
    if (evidence.requested !== null && typeof evidence.requested !== 'string') {
      throw new Error(`${label}.requested must be a string or null`);
    }
    assertStringArray(evidence.observed, `${label}.observed`);
    if (new Set(evidence.observed).size !== evidence.observed.length) {
      throw new Error(`${label}.observed must not contain duplicates`);
    }
    if (!IDENTITY_EVIDENCE_SOURCES.has(evidence.source)) {
      throw new Error(`${label}.source is unsupported: ${evidence.source}`);
    }
    if (evidence.source === 'observed-trace'
        && (evidence.observed.length !== 1 || identity[field] !== evidence.observed[0])) {
      throw new Error(`${label} must resolve identity from exactly one observed value`);
    }
    if (evidence.source === 'observed-trace' && evidence.requested !== null
        && evidence.requested !== evidence.observed[0]) {
      throw new Error(`${label} requested identity conflicts with observed identity`);
    }

    if (evidence.source === 'conflicting-observed'
        && (evidence.observed.length < 2 || identity[field] !== null)) {
      throw new Error(`${label} conflicting observations are inconsistent`);
    }
    if (evidence.source === 'missing'
        && (evidence.observed.length !== 0 || identity[field] !== null)) {
      throw new Error(`${label} missing provenance is inconsistent`);
    }
    if (evidence.source !== 'observed-trace') {
      throw new Error(`${label} must use observed-trace provenance`);
    }
  }
}

function validateCompatibilityValues(compatibility, label = 'compatibility', requireComplete = false) {
  assertAllowedFields(compatibility, COMPATIBILITY_FIELDS, label);
  assertRequiredFields(compatibility, COMPATIBILITY_FIELDS, label);
  for (const field of [
    'resumeVerified', 'visionFallbackContractVerified',
    'collaborationFallbackContractVerified',
  ]) {
    if (requireComplete && typeof compatibility[field] !== 'boolean') {
      throw new Error(`${label}.${field} must be a boolean`);
    }
    if (!requireComplete && compatibility[field] !== null
        && typeof compatibility[field] !== 'boolean') {
      throw new Error(`${label}.${field} must be a boolean or null`);
    }
  }
  if (requireComplete && !Array.isArray(compatibility.sprintPhases)) {
    throw new Error(`${label}.sprintPhases must be an array of strings`);
  }
  if (compatibility.sprintPhases !== null) {
    assertStringArray(compatibility.sprintPhases, `${label}.sprintPhases`);
    if (new Set(compatibility.sprintPhases).size !== compatibility.sprintPhases.length) {
      throw new Error(`${label}.sprintPhases must not contain duplicates`);
    }
    const unsupported = compatibility.sprintPhases.filter((phase) => !SPRINT_PHASES.includes(phase));
    if (unsupported.length > 0) {
      throw new Error(`${label}.sprintPhases are unsupported: ${unsupported.join(',')}`);
    }
  }
}

function compatibilityValuesEqual(left, right) {
  if (!isObject(left) || !isObject(right)) return false;
  return COMPATIBILITY_FIELDS.every((field) => Array.isArray(left[field])
    ? JSON.stringify(left[field]) === JSON.stringify(right[field])
    : left[field] === right[field]);
}

function assertLowerSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hash`);
  }
}

function validateExternalArchitectureEvidence(evidence, requireRequested = true) {
  const fields = ['schemaVersion', 'source', 'requested', 'observed', 'attestation'];
  assertAllowedFields(evidence, fields, 'compatibilityEvidence');
  assertRequiredFields(evidence, requireRequested ? fields : fields.filter((field) =>
    field !== 'requested'), 'compatibilityEvidence');
  if (evidence.schemaVersion !== EXTERNAL_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`compatibilityEvidence schemaVersion is unsupported: ${evidence.schemaVersion}`);
  }
  if (evidence.source !== EXTERNAL_COMPATIBILITY_EVIDENCE_SOURCE) {
    throw new Error(`compatibilityEvidence.source is unsupported: ${evidence.source}`);
  }
  validateCompatibilityValues(evidence.observed, 'compatibilityEvidence.observed', true);
  if (requireRequested) {
    validateCompatibilityValues(evidence.requested, 'compatibilityEvidence.requested');
  }
  const attestation = evidence.attestation;
  assertAllowedFields(attestation,
    ['trustBoundary', 'repoRoot', 'cwd', 'git', 'files', 'validator', 'tests'],
    'compatibilityEvidence.attestation');
  assertRequiredFields(attestation,
    ['trustBoundary', 'repoRoot', 'cwd', 'git', 'files', 'validator', 'tests'],
    'compatibilityEvidence.attestation');
  if (attestation.trustBoundary !== EXTERNAL_COMPATIBILITY_TRUST_BOUNDARY) {
    throw new Error('compatibilityEvidence.attestation trust boundary is unsupported');
  }
  for (const field of ['repoRoot', 'cwd']) {
    if (typeof attestation[field] !== 'string' || !path.isAbsolute(attestation[field])) {
      throw new Error(`compatibilityEvidence.attestation.${field} must be an absolute path`);
    }
  }
  if (!sameCanonicalPath(attestation.repoRoot, attestation.cwd)) {
    throw new Error('compatibilityEvidence.attestation cwd must equal repoRoot');
  }
  assertAllowedFields(attestation.git, ['state', 'head'], 'compatibilityEvidence.attestation.git');
  assertRequiredFields(attestation.git, ['state', 'head'], 'compatibilityEvidence.attestation.git');
  if (attestation.git.state === 'head') {
    if (typeof attestation.git.head !== 'string'
        || !/^[a-f\d]{40,64}$/.test(attestation.git.head)) {
      throw new Error('compatibilityEvidence.attestation.git.head must be a lowercase Git hash');
    }
  } else if (attestation.git.state === 'no-git') {
    if (attestation.git.head !== null) {
      throw new Error('compatibilityEvidence.attestation.git.head must be null for no-git');
    }
  } else {
    throw new Error(`compatibilityEvidence.attestation.git.state is unsupported: ${attestation.git.state}`);
  }
  if (!Array.isArray(attestation.files)
      || attestation.files.length !== ARCHITECTURE_EVIDENCE_FILES.length) {
    throw new Error('compatibilityEvidence.attestation.files must cover fixed architecture files');
  }
  attestation.files.forEach((entry, index) => {
    const label = `compatibilityEvidence.attestation.files[${index}]`;
    assertAllowedFields(entry, ['path', 'realPath', 'identity', 'sha256'], label);
    assertRequiredFields(entry, ['path', 'realPath', 'identity', 'sha256'], label);
    if (entry.path !== ARCHITECTURE_EVIDENCE_FILES[index]) {
      throw new Error(`${label}.path must be ${ARCHITECTURE_EVIDENCE_FILES[index]}`);
    }
    const expectedPath = path.resolve(attestation.repoRoot, entry.path);
    if (typeof entry.realPath !== 'string' || !path.isAbsolute(entry.realPath)
        || !pathIsWithinRoot(attestation.repoRoot, entry.realPath)
        || !sameCanonicalPath(entry.realPath, expectedPath)) {
      throw new Error(`${label}.realPath must resolve to its controlled repository path`);
    }
    assertAllowedFields(entry.identity, ['device', 'file'], `${label}.identity`);
    assertRequiredFields(entry.identity, ['device', 'file'], `${label}.identity`);
    for (const field of ['device', 'file']) {
      if (typeof entry.identity[field] !== 'string' || !/^\d+$/.test(entry.identity[field])) {
        throw new Error(`${label}.identity.${field} must be an unsigned integer string`);
      }
    }
    assertLowerSha256(entry.sha256, `${label}.sha256`);
  });
  assertAllowedFields(attestation.validator,
    ['commandHash', 'exitCode', 'markerHash'], 'compatibilityEvidence.attestation.validator');
  assertRequiredFields(attestation.validator,
    ['commandHash', 'exitCode', 'markerHash'], 'compatibilityEvidence.attestation.validator');
  assertLowerSha256(attestation.validator.commandHash,
    'compatibilityEvidence.attestation.validator.commandHash');
  assertLowerSha256(attestation.validator.markerHash,
    'compatibilityEvidence.attestation.validator.markerHash');
  if (attestation.validator.exitCode !== 0) {
    throw new Error('compatibilityEvidence.attestation.validator.exitCode must be 0');
  }
  const expectedTests = ARCHITECTURE_EVIDENCE_FILES.slice(1);
  if (!Array.isArray(attestation.tests) || attestation.tests.length !== expectedTests.length) {
    throw new Error('compatibilityEvidence.attestation.tests must cover fixed architecture tests');
  }
  attestation.tests.forEach((entry, index) => {
    const label = `compatibilityEvidence.attestation.tests[${index}]`;
    assertAllowedFields(entry, ['path', 'commandHash', 'exitCode'], label);
    assertRequiredFields(entry, ['path', 'commandHash', 'exitCode'], label);
    if (entry.path !== expectedTests[index]) {
      throw new Error(`${label}.path must be ${expectedTests[index]}`);
    }
    assertLowerSha256(entry.commandHash, `${label}.commandHash`);
    if (entry.exitCode !== 0) throw new Error(`${label}.exitCode must be 0`);
  });
  if (requireRequested) {
    for (const field of COMPATIBILITY_FIELDS) {
      if (evidence.requested[field] === null) continue;
      const matches = Array.isArray(evidence.requested[field])
        ? JSON.stringify(evidence.requested[field]) === JSON.stringify(evidence.observed[field])
        : evidence.requested[field] === evidence.observed[field];
      if (!matches) {
        throw new Error(`compatibilityEvidence requested ${field} conflicts with observed`);
      }
    }
  }
}

function validateCompatibilityProvenance(evidence, compatibility) {
  if (evidence.source === 'missing') {
    const fields = ['schemaVersion', 'source', 'requested', 'observed', 'attestation'];
    assertAllowedFields(evidence, fields, 'compatibilityEvidence');
    assertRequiredFields(evidence, fields, 'compatibilityEvidence');
    if (evidence.schemaVersion !== EXTERNAL_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION) {
      throw new Error(`compatibilityEvidence schemaVersion is unsupported: ${evidence.schemaVersion}`);
    }
    validateCompatibilityValues(evidence.requested, 'compatibilityEvidence.requested');
    if (evidence.observed !== null || evidence.attestation !== null) {
      throw new Error('missing compatibility evidence cannot retain observed data or attestation');
    }
    if (!compatibilityValuesEqual(compatibility, emptyCompatibility())) {
      throw new Error('missing compatibility evidence requires empty compatibility values');
    }
    if (compatibilityWasRequested(evidence.requested)) {
      throw new Error('missing compatibility evidence cannot satisfy requested values');
    }
    return;
  }
  validateExternalArchitectureEvidence(evidence, true);
  if (!compatibilityValuesEqual(compatibility, evidence.observed)) {
    throw new Error('compatibility must equal compatibilityEvidence.observed');
  }
}
function validateTraceRecordSchema(row) {
  assertAllowedFields(row, TRACE_TOP_LEVEL_FIELDS, 'trace record');
  assertRequiredFields(row, TRACE_TOP_LEVEL_FIELDS.filter((field) =>
    !OPTIONAL_TRACE_TOP_LEVEL_FIELDS.has(field)), 'trace record');

  if (row.analysis !== undefined) validateAnalysisState(row.analysis);

  assertAllowedFields(row.identity, TRACE_IDENTITY_FIELDS, 'identity');
  assertRequiredFields(row.identity, TRACE_IDENTITY_FIELDS, 'identity');
  for (const field of TRACE_IDENTITY_FIELDS) {
    if (row.identity[field] !== null && typeof row.identity[field] !== 'string') {
      throw new Error(`identity.${field} must be a string or null`);
    }
  }
  if (row.identityEvidence !== undefined) validateIdentityEvidence(row.identityEvidence, row.identity);
  if (row.compatibility !== undefined) validateCompatibilityValues(row.compatibility);
  if (row.compatibilityEvidence !== undefined) {
    validateCompatibilityProvenance(row.compatibilityEvidence, row.compatibility);
  }

  assertAllowedFields(row.timing, TRACE_TIMING_FIELDS, 'timing');
  assertRequiredFields(row.timing, TRACE_TIMING_FIELDS, 'timing');
  assertNullableNumbers(row.timing, TRACE_TIMING_FIELDS, 'timing', { minimum: 0 });

  assertAllowedFields(row.execution, TRACE_EXECUTION_FIELDS, 'execution');
  assertRequiredFields(row.execution, TRACE_EXECUTION_FIELDS, 'execution');
  assertNullableNumbers(row.execution, TRACE_EXECUTION_FIELDS.filter((field) => ![
    'mutationDetected', 'uniqueSkills', 'turnAborted',
  ].includes(field)), 'execution', { integer: true, minimum: 0 });
  if (typeof row.execution.mutationDetected !== 'boolean' || typeof row.execution.turnAborted !== 'boolean') {
    throw new Error('execution mutationDetected and turnAborted must be booleans');
  }
  assertStringArray(row.execution.uniqueSkills, 'execution.uniqueSkills');

  assertAllowedFields(row.context, TRACE_CONTEXT_FIELDS, 'context');
  assertRequiredFields(row.context, TRACE_CONTEXT_FIELDS, 'context');
  assertNullableNumbers(row.context, TRACE_CONTEXT_FIELDS.filter((field) => ![
    'peakContextRatio', 'contextAtFirstMutationRatio',
  ].includes(field)), 'context', { integer: true, minimum: 0 });
  assertNullableNumbers(row.context, [
    'peakContextRatio', 'contextAtFirstMutationRatio',
  ], 'context', { minimum: 0, maximum: 1 });

  assertAllowedFields(row.quality, TRACE_QUALITY_FIELDS, 'quality');
  assertRequiredFields(row.quality, TRACE_QUALITY_FIELDS, 'quality');
  if (!Array.isArray(row.quality.validationCommands)) {
    throw new Error('quality.validationCommands must be an array');
  }
  row.quality.validationCommands.forEach((entry, index) => {
    const label = `quality.validationCommands[${index}]`;
    assertAllowedFields(entry, ['kind', 'exitCode', 'commandHash'], label);
    assertRequiredFields(entry, ['kind', 'exitCode', 'commandHash'], label);
    if (!['syntax', 'test', 'lint', 'check', 'compatibility'].includes(entry.kind)) {
      throw new Error(`${label}.kind is unsupported: ${entry.kind}`);
    }
    assertNullableNumbers(entry, ['exitCode'], label, { integer: true });
    if (typeof entry.commandHash !== 'string' || !/^[a-f\d]{64}$/i.test(entry.commandHash)) {
      throw new Error(`${label}.commandHash must be a SHA-256 hex digest`);
    }
  });
  assertNullableNumbers(row.quality, ['exitCode'], 'quality', { integer: true });
  assertStringArray(row.quality.changedFiles, 'quality.changedFiles');
  assertStringArray(row.quality.expectedChangedFiles, 'quality.expectedChangedFiles', true);
  assertStringArray(row.quality.unexpectedChangedFiles, 'quality.unexpectedChangedFiles', true);
  for (const field of ['accepted', 'p0Escape', 'falseCompletion']) {
    if (typeof row.quality[field] !== 'boolean') throw new Error(`quality.${field} must be a boolean`);
  }
  assertStringArray(row.warnings, 'warnings');
  assertTraceInvariants(row);
}

function validateLegacyRecordSchema(row) {
  assertAllowedFields(row, LEGACY_RECORD_FIELDS, 'legacy record');
  assertRequiredFields(row, LEGACY_RECORD_FIELDS.filter((field) => field !== 'at'), 'legacy record');
  for (const field of ['accepted', 'p0Escape', 'falseCompletion']) {
    if (typeof row[field] !== 'boolean') throw new Error(`${field} must be a boolean`);
  }
}

function validateRecordRow(row) {
  if (!isObject(row)) throw new Error('record must be an object');
  if (!CASES.includes(row.caseId)) throw new Error(`unknown caseId: ${row.caseId}`);
  const forbidden = forbiddenRawField(row);
  if (forbidden) throw new Error(`raw prompt/output field is forbidden: ${forbidden}`);
  if (row.schemaVersion === TRACE_SCHEMA_VERSION) validateTraceRecordSchema(row);
  else if (row.schemaVersion === undefined) validateLegacyRecordSchema(row);
  else throw new Error(`unsupported schemaVersion: ${row.schemaVersion}`);
  if (row.at !== undefined && typeof row.at !== 'string') throw new Error('at must be a string');
}

function recordRow(filePath, row, options = {}) {
  const absolute = path.resolve(filePath || DEFAULT_LEDGER);
  const stored = { ...row, at: options.at || row.at || new Date().toISOString() };
  validateRecordRow(stored);
  revalidateRecordArchitectureEvidence(stored, options);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const descriptor = fs.openSync(absolute, 'a', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(stored)}\n`, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  return stored;
}

function checkRows(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('no canary records');
  const architectureEvidenceCache = new Map();
  rows.forEach((row, index) => {
    try {
      validateRecordRow(row);
      revalidateRecordArchitectureEvidence(row, options, architectureEvidenceCache);
    } catch (error) {
      throw new Error(`invalid canary record at row ${index + 1}: ${error.message}`);
    }
  });
  const unsafe = rows.filter((row) => {
    if (row.schemaVersion === TRACE_SCHEMA_VERSION) {
      return getPath(row, 'quality.accepted') !== true
        || getPath(row, 'quality.p0Escape') === true
        || getPath(row, 'quality.falseCompletion') === true;
    }
    return row.accepted !== true || row.p0Escape === true || row.falseCompletion === true;
  });
  if (unsafe.length > 0) throw new Error(`canary blocked: ${unsafe.length} unsafe records`);
  return { ok: true, cases: [...new Set(rows.map((row) => row.caseId))], records: rows.length };
}

function checkLedger(filePath, options = {}) {
  return checkRows(readJsonLines(path.resolve(filePath || DEFAULT_LEDGER)), options);
}

function parseCliArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function cliOptions(args) {
  const expected = typeof args['expected-changed-files'] === 'string'
    ? args['expected-changed-files'].split(',').map((file) => file.trim()).filter(Boolean)
    : undefined;
  const sprintPhases = typeof args['sprint-phases'] === 'string'
    ? args['sprint-phases'].split(',').map((phase) => phase.trim()).filter(Boolean)
    : undefined;
  return {
    caseId: args['case-id'] || args.case,
    taskSpec: args['task-spec'],
    taskSpecHash: args['task-spec-hash'],
    repoCommit: args['repo-commit'],
    codexVersion: args['codex-version'],
    model: args.model,
    effort: args.effort,
    serviceTier: args['service-tier'],
    sandbox: args.sandbox,
    pluginInventoryHash: args['plugin-inventory-hash'],
    hookInventoryHash: args['hook-inventory-hash'],
    toolCatalogHash: args['tool-catalog-hash'],
    contextWindow: args['context-window'],
    accepted: args.accepted,
    p0Escape: args['p0-escape'],
    falseCompletion: args['false-completion'],
    exitCode: args['exit-code'],
    expectedChangedFiles: expected,
    visionRequired: args['vision-required'],
    visionSupported: args['vision-supported'],
    visionFallbackVerified: args['vision-fallback-verified'],
    collaborationAvailable: args['collaboration-available'],
    collaborationFallbackVerified: args['collaboration-fallback-verified'],
    sprintPhases,
    resumeVerified: args['resume-verified'],
    visionFallbackContractVerified: args['vision-fallback-contract-verified'],
    collaborationFallbackContractVerified:
      args['collaboration-fallback-contract-verified'],
  };
}

function writeJsonResult(result, outputPath) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    const absolute = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, serialized, 'utf8');
  } else process.stdout.write(serialized);
}

function usage() {
  return 'usage: model-canary.js record --file <jsonl> --json <row> | check --file <jsonl> | analyze --input <trace.jsonl> [--architecture-root <repo>] [identity/compatibility flags] | fingerprint --root <repo> [--baseline <baseline.json>] | compare --baseline <jsonl> --candidate <jsonl> [--policy <id>]';
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseCliArgs(rest);
  if (command === 'record') {
    if (typeof args.json !== 'string') throw new Error('--json is required');
    recordRow(args.file || DEFAULT_LEDGER, JSON.parse(args.json));
    return 0;
  }
  if (command === 'check') {
    writeJsonResult(checkLedger(args.file || DEFAULT_LEDGER), args.out);
    return 0;
  }
  if (command === 'analyze') {
    if (typeof args.input !== 'string') throw new Error('--input is required');
    const options = cliOptions(args);
    if (args['architecture-root'] !== undefined) {
      if (typeof args['architecture-root'] !== 'string') {
        throw new Error('--architecture-root requires a repository path');
      }
      options.externalArchitectureEvidence = collectExternalArchitectureEvidence(
        args['architecture-root']
      );
    }
    const result = analyzeTrace(args.input, options);
    writeJsonResult(result, args.out);
    return result.analysis.valid ? 0 : 2;
  }
  if (command === 'fingerprint') {
    const root = args.root || process.cwd();
    if (typeof args.baseline === 'string') {
      const verification = verifyClaudeSurfaceBaseline(root, args.baseline);
      writeJsonResult(verification, args.out);
      return verification.equal ? 0 : 1;
    }
    writeJsonResult(fingerprintClaudeSurface(root), args.out);
    return 0;
  }
  if (command === 'compare') {
    if (typeof args.baseline !== 'string' || typeof args.candidate !== 'string') {
      throw Object.assign(new Error('--baseline and --candidate are required'), { exitCode: 2 });
    }
    let result;
    try {
      result = compareRuns(args.baseline, args.candidate, { policyId: args.policy });
    } catch (error) {
      error.exitCode = 2;
      throw error;
    }
    writeJsonResult(result, args.out);
    return result.valid ? (result.passed ? 0 : 1) : 2;
  }
  throw new Error(usage());
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}

module.exports = {
  CASES,
  CLAUDE_SURFACE,
  CLAUDE_SURFACE_BASELINE_SCHEMA_VERSION,
  CLAUDE_SURFACE_VERIFICATION_SCHEMA_VERSION,
  COMPARISON_DIMENSION_FIELDS,
  COMPARE_SCHEMA_VERSION,
  DEFAULT_LEDGER,
  FINGERPRINT_SCHEMA_VERSION,
  PAIR_IDENTITY_FIELDS,
  POLICIES,
  TRACE_SCHEMA_VERSION,
  analyzeTrace,
  checkLedger,
  checkRows,
  collectExternalArchitectureEvidence,
  compareRuns,
  diffFingerprints,
  fingerprintClaudeSurface,
  hashInventory,
  main,
  median,
  pairingKey,
  percentile,
  recordRow,
  sha256,
  stableStringify,
  validateClaudeSurfaceBaseline,
  validateRecordRow,
  verifyExternalArchitectureEvidence,
  verifyClaudeSurfaceBaseline,
};
