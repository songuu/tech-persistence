#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CLAUDE_SURFACE_BASELINE_SCHEMA_VERSION,
  POLICIES,
  TRACE_SCHEMA_VERSION,
  analyzeTrace,
  checkLedger,
  collectExternalArchitectureEvidence,
  compareRuns,
  diffFingerprints,
  fingerprintClaudeSurface,
  main,
  recordRow,
  sha256,
  stableStringify,
  validateClaudeSurfaceBaseline,
  validateRecordRow,
  verifyExternalArchitectureEvidence,
  verifyClaudeSurfaceBaseline,
} = require('./model-canary');

let passed = 0;
function test(name, run) {
  try {
    run();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'model-canary-'));
}

function traceOptions(overrides = {}) {
  return {
    caseId: 'L1-single-file',
    taskSpecHash: 'a'.repeat(64),
    repoCommit: 'deadbeef',
    codexVersion: '0.144.6',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    serviceTier: 'priority',
    sandbox: 'workspace-write',
    pluginInventoryHash: 'b'.repeat(64),
    hookInventoryHash: 'c'.repeat(64),
    toolCatalogHash: 'd'.repeat(64),
    accepted: true,
    p0Escape: false,
    falseCompletion: false,
    expectedChangedFiles: ['src/a.js'],
    ...overrides,
  };
}

function authoritativeSessionMeta(timestamp = '2026-07-22T23:59:59.998Z') {
  return {
    timestamp,
    type: 'session_meta',
    payload: {
      id: '019f0000-0000-7000-8000-000000000001',
      timestamp,
      cwd: 'C:\\project\\repo',
      originator: 'Codex Desktop',
      cli_version: '0.145.0',
      source: 'vscode',
      model_provider: 'openai',
    },
  };
}

function authoritativeTurnContext(model, effort,
    timestamp = '2026-07-22T23:59:59.999Z', turnId = '019f0000-0000-7000-8000-000000000002') {
  return {
    timestamp,
    type: 'turn_context',
    payload: {
      turn_id: turnId,
      cwd: 'C:\\project\\repo',
      approval_policy: 'on-request',
      sandbox_policy: { type: 'workspace-write' },
      model,
      effort,
    },
  };
}

function syntheticTrace() {
  return [
    { timestamp: '2026-07-23T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-23T00:00:00.010Z', type: 'event_msg', payload: {
      type: 'token_count', info: { model_context_window: 1000,
        total_token_usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 5 },
        last_token_usage: { total_tokens: 200 } },
    } },
    { timestamp: '2026-07-23T00:00:00.050Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
    { timestamp: '2026-07-23T00:00:00.100Z', type: 'response_item', payload: {
      type: 'function_call', call_id: 'read', name: 'shell_command',
      arguments: JSON.stringify({ command: 'Get-Content .codex/skills/work/SKILL.md' }),
    } },
    { timestamp: '2026-07-23T00:00:00.200Z', type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'read', output: 'skill instructions' } },
    { timestamp: '2026-07-23T00:00:00.300Z', type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'edit', name: 'apply_patch',
      input: '*** Begin Patch\n*** Update File: src/a.js\n*** End Patch',
    } },
    { timestamp: '2026-07-23T00:00:00.450Z', type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'edit', output: 'Success' } },
    { timestamp: '2026-07-23T00:00:00.500Z', type: 'response_item', payload: {
      type: 'function_call', call_id: 'test', name: 'shell_command',
      arguments: JSON.stringify({ command: 'node scripts/test-a.js' }),
    } },
    { timestamp: '2026-07-23T00:00:00.700Z', type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'test', output: 'Exit code: 0\nPASS' } },
    { timestamp: '2026-07-23T00:00:00.900Z', type: 'event_msg', payload: {
      type: 'token_count', info: { model_context_window: 1000,
        total_token_usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 50, reasoning_output_tokens: 20 },
        last_token_usage: { total_tokens: 500 } },
    } },
    { timestamp: '2026-07-23T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_completed' } },
    authoritativeSessionMeta('2026-07-23T00:00:01.001Z'),
    authoritativeTurnContext(
      'gpt-5.6-sol', 'xhigh', '2026-07-23T00:00:01.002Z',
      '019f0000-0000-7000-8000-000000000003'
    ),
  ];
}

const COMPATIBILITY_EVIDENCE_SCHEMA_VERSION =
  'codex-model-compat-architecture-evidence-v1';
const COMPATIBILITY_EVIDENCE_PREFIX = 'CODEX_MODEL_COMPAT_EVIDENCE=';
const EXTERNAL_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION =
  'codex-model-compat-external-evidence-v1';
const TRUSTED_COMPATIBILITY_VALIDATOR_COMMAND = 'node scripts/model-compat-validator.js';

function compatibilityValues(overrides = {}) {
  return {
    sprintPhases: ['think', 'plan', 'work', 'review', 'compound'],
    resumeVerified: true,
    visionFallbackContractVerified: true,
    collaborationFallbackContractVerified: true,
    ...overrides,
  };
}

function compatibilityMarker(values = compatibilityValues()) {
  return {
    schemaVersion: COMPATIBILITY_EVIDENCE_SCHEMA_VERSION,
    sprint: {
      phases: values.sprintPhases,
      resumeVerified: values.resumeVerified,
    },
    fallbackContracts: {
      visionVerified: values.visionFallbackContractVerified,
      collaborationVerified: values.collaborationFallbackContractVerified,
    },
  };
}
function createArchitectureHarnessFixture(options = {}) {
  const root = tempDirectory();
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const marker = JSON.stringify(compatibilityMarker());
  fs.writeFileSync(path.join(scripts, 'model-compat-validator.js'),
    `process.stdout.write(${JSON.stringify(COMPATIBILITY_EVIDENCE_PREFIX + marker + '\n')});\n`);
  fs.writeFileSync(path.join(scripts, 'test-codex-active-sprint-state.js'),
    options.activeSprintFailure ? "console.error('forced failure'); process.exitCode = 1;\n" : '');
  fs.writeFileSync(path.join(scripts, 'test-codex-native-skill-projection.js'), '');
  return root;
}


function traceWithCompatibilityMarker(values, exitCode = 0, marker = compatibilityMarker(values)) {
  const trace = syntheticTrace();
  trace[7] = {
    ...trace[7],
    payload: {
      ...trace[7].payload,
      arguments: JSON.stringify({ command: TRUSTED_COMPATIBILITY_VALIDATOR_COMMAND }),
    },
  };
  trace[8] = {
    ...trace[8],
    payload: {
      ...trace[8].payload,
      output: `Exit code: ${exitCode}\n${COMPATIBILITY_EVIDENCE_PREFIX}${JSON.stringify(marker)}`,
    },
  };
  return trace;
}

function traceWithMarkerCommand(command, values, exitCode = 0) {
  const trace = syntheticTrace();
  trace[7] = {
    ...trace[7],
    payload: {
      ...trace[7].payload,
      arguments: JSON.stringify({ command }),
    },
  };
  trace[8] = {
    ...trace[8],
    payload: {
      ...trace[8].payload,
      output: `Exit code: ${exitCode}\n${COMPATIBILITY_EVIDENCE_PREFIX}${JSON.stringify(
        compatibilityMarker(values)
      )}`,
    },
  };
  return trace;
}

function appendCompatibilityMarker(trace, values, exitCode = 0) {
  const marker = compatibilityMarker(values);
  trace.splice(-1, 0,
    { timestamp: '2026-07-23T00:00:00.710Z', type: 'response_item', payload: {
      type: 'function_call', call_id: 'compat-test-2', name: 'shell_command',
      arguments: JSON.stringify({ command: TRUSTED_COMPATIBILITY_VALIDATOR_COMMAND }),
    } },
    { timestamp: '2026-07-23T00:00:00.720Z', type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'compat-test-2',
      output: `Exit code: ${exitCode}\n${COMPATIBILITY_EVIDENCE_PREFIX}${JSON.stringify(marker)}`,
    } });
  return trace;
}

function traceWithObservedIdentity(model, effort, trace = syntheticTrace()) {
  return [
    authoritativeSessionMeta(),
    authoritativeTurnContext(model, effort),
    ...trace.filter((row) => !['session_meta', 'turn_context'].includes(row.type)),
  ];
}

function shellTrace(command) {
  return [
    { timestamp: '2026-07-23T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-23T00:00:00.100Z', type: 'response_item', payload: {
      type: 'function_call', call_id: 'shell', name: 'shell_command',
      arguments: JSON.stringify({ command }),
    } },
    { timestamp: '2026-07-23T00:00:00.200Z', type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'shell', output: 'Exit code: 0' } },
    { timestamp: '2026-07-23T00:00:00.300Z', type: 'event_msg', payload: { type: 'task_completed' } },
  ];
}

function namedToolTrace(name, rawArguments = {}, itemType = 'function_call') {
  return [
    { timestamp: '2026-07-23T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-23T00:00:00.100Z', type: 'response_item', payload: {
      type: itemType, call_id: 'tool', name, arguments: JSON.stringify(rawArguments),
    } },
    { timestamp: '2026-07-23T00:00:00.200Z', type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'tool', output: 'ok' } },
    { timestamp: '2026-07-23T00:00:00.300Z', type: 'event_msg', payload: { type: 'task_completed' } },
  ];
}

function completedMcpTrace() {
  return [
    { timestamp: '2026-07-23T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-23T00:00:00.200Z', type: 'event_msg', payload: {
      type: 'mcp_tool_call_end',
      call_id: 'mcp-call',
      invocation: { server: 'external', tool: 'lookup', arguments: { query: 'status' } },
      duration: { secs: 0, nanos: 100000000 },
      result: { Ok: { content: [{ type: 'text', text: 'done' }] } },
    } },
    { timestamp: '2026-07-23T00:00:00.300Z', type: 'event_msg', payload: { type: 'task_completed' } },
  ];
}

function detectsMutation(command) {
  return analyzeTrace(shellTrace(command), traceOptions({ expectedChangedFiles: [] }))
    .execution.mutationDetected;
}

function detectsToolMutation(name, rawArguments = {}, itemType = 'function_call') {
  return analyzeTrace(namedToolTrace(name, rawArguments, itemType),
    traceOptions({ expectedChangedFiles: [] }))
    .execution.mutationDetected;
}

function makeRecord(index, candidate = false, overrides = {}) {
  const caseIds = ['L1-single-file', 'L2-multi-file', 'L3-security-review',
    'failure-recovery', 'L1-single-file', 'L2-multi-file'];
  const caseId = overrides.caseId || caseIds[index];
  const review = caseId === 'L3-security-review';
  const wallMs = candidate ? (review ? 800 : 700) : 1000;
  const inputTokens = candidate ? (review ? 7000 : 6000) : 10000;
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    caseId,
    analysis: { valid: true, errors: [] },
    identity: {
      taskSpecHash: String(index + 1).padStart(64, '0'),
      repoCommit: 'deadbeef',
      codexVersion: '0.145.0',
      model: 'gpt-5.6-sol',
      effort: candidate ? 'high' : 'xhigh',
      serviceTier: 'priority',
      sandbox: 'workspace-write',
      pluginInventoryHash: '1'.repeat(64),
      hookInventoryHash: '2'.repeat(64),
      toolCatalogHash: '3'.repeat(64),
    },
    identityEvidence: {
      model: {
        requested: 'gpt-5.6-sol',
        observed: ['gpt-5.6-sol'],
        source: 'observed-trace',
      },
      effort: {
        requested: candidate ? 'high' : 'xhigh',
        observed: [candidate ? 'high' : 'xhigh'],
        source: 'observed-trace',
      },
    },
    timing: {
      wallMs,
      ttfVisibleMs: candidate ? 600 : 1000,
      ttfToolMs: candidate ? 100 : 150,
      ttfRepoReadMs: candidate ? 120 : 180,
      ttfMutationMs: review ? null : (candidate ? 200 : 300),
      toolWallMs: candidate ? 300 : 400,
      nonToolMs: candidate ? wallMs - 300 : 600,
      nonToolGapP50: 50,
      nonToolGapP90: 100,
    },
    execution: {
      outerToolCalls: candidate ? 7 : 12,
      preMutationToolCalls: candidate ? 6 : 10,
      mutationDetected: !review,
      skillReadCalls: 1,
      uniqueSkills: ['sprint'],
      duplicateSkillReads: 0,
      skillOutputTruncations: 0,
      learnedContextInjectionCount: 1,
      cavemanInjectionCount: 1,
      compactionCount: 0,
      preEditCompactionCount: 0,
      turnAborted: false,
    },
    context: {
      initialTokens: 1000,
      finalTokens: candidate ? 4000 : 8000,
      cumulativeInputTokens: inputTokens,
      cachedInputTokens: candidate ? 4000 : 7000,
      outputTokens: 500,
      reasoningTokens: 300,
      contextWindow: 10000,
      peakContextRatio: candidate ? 0.5 : 0.8,
      contextAtFirstMutationRatio: review ? null : 0.4,
    },
    quality: {
      validationCommands: [{ kind: 'test', exitCode: 0, commandHash: sha256('node test.js') }],
      exitCode: 0,
      changedFiles: review ? [] : ['src/a.js'],
      expectedChangedFiles: review ? [] : ['src/a.js'],
      unexpectedChangedFiles: [],
      accepted: true,
      p0Escape: false,
      falseCompletion: false,
    },
    warnings: [],
    ...overrides,
  };
}

function setObservedIdentity(record, overrides = {}) {
  for (const field of ['model', 'effort']) {
    if (!Object.prototype.hasOwnProperty.call(overrides, field)) continue;
    record.identity[field] = overrides[field];
    record.identityEvidence[field] = {
      requested: overrides[field], observed: [overrides[field]], source: 'observed-trace',
    };
  }
  return record;
}

function fakeExternalCompatibilityEvidence(compatibility) {
  const repoRoot = path.resolve(__dirname, '..');
  return {
    schemaVersion: EXTERNAL_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION,
    source: 'external-controller',
    requested: { ...compatibility },
    observed: { ...compatibility },
    attestation: {
      trustBoundary: 'trace-external-controller',
      repoRoot,
      cwd: repoRoot,
      git: { state: 'no-git', head: null },
      files: [
        'scripts/model-compat-validator.js',
        'scripts/test-codex-active-sprint-state.js',
        'scripts/test-codex-native-skill-projection.js',
      ].map((file, index) => ({
        path: file,
        realPath: path.resolve(repoRoot, file),
        identity: { device: '1', file: String(index + 1) },
        sha256: String(index + 1).repeat(64),
      })),
      validator: {
        commandHash: '4'.repeat(64), exitCode: 0,
        markerHash: sha256(JSON.stringify(compatibilityMarker(compatibility))),
      },
      tests: [
        'scripts/test-codex-active-sprint-state.js',
        'scripts/test-codex-native-skill-projection.js',
      ].map((file, index) => ({
        path: file, commandHash: String(index + 5).repeat(64), exitCode: 0,
      })),
    },
  };
}

function compatibilityComparisonOptions() {
  return { policyId: 'codex-model-compat-v1', architectureVerifier: () => true };
}

function withCompatibilityEvidence(record, overrides = {}) {
  const model = record.identity.model;
  const effort = record.identity.effort;
  const compatibility = compatibilityValues(overrides);
  return {
    ...record,
    analysis: { valid: true, errors: [] },
    identityEvidence: {
      model: { requested: model, observed: [model], source: 'observed-trace' },
      effort: { requested: effort, observed: [effort], source: 'observed-trace' },
    },
    compatibility,
    compatibilityEvidence: fakeExternalCompatibilityEvidence(compatibility),
  };
}

function setCompatibilityEvidence(record, overrides = {}) {
  const compatibility = compatibilityValues({ ...record.compatibility, ...overrides });
  record.compatibility = compatibility;
  record.compatibilityEvidence = fakeExternalCompatibilityEvidence(compatibility);
  return record;
}
test('architecture compatibility producer is syntax-valid and rejects all CLI claims', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const validatorPath = path.join(__dirname, 'model-compat-validator.js');
  assert.strictEqual(fs.existsSync(validatorPath), true);
  const syntax = spawnSync(process.execPath, ['--check', validatorPath], {
    cwd: repoRoot, encoding: 'utf8', shell: false,
  });
  assert.strictEqual(syntax.status, 0, syntax.stderr);
  const claimed = spawnSync(process.execPath, [validatorPath, '--resume-verified', 'true'], {
    cwd: repoRoot, encoding: 'utf8', shell: false,
  });
  assert.notStrictEqual(claimed.status, 0);
  assert(!claimed.stdout.includes(COMPATIBILITY_EVIDENCE_PREFIX));
});

test('architecture producer sanitizes execution and emits no marker when a child test fails', () => {
  const producer = require('./model-compat-validator');
  const calls = [];
  let stdout = '';
  let stderr = '';
  const code = producer.main([], {
    env: {
      NODE_OPTIONS: '--require untrusted.js',
      Node_Path: 'C:\\untrusted',
      SAFE_VALUE: 'preserved',
    },
    spawnSyncImpl: (executable, args, options) => {
      calls.push({ executable, args, options });
      return calls.length === 1
        ? { status: 0, signal: null }
        : {
          status: 7,
          signal: null,
          stdout: `${COMPATIBILITY_EVIDENCE_PREFIX}${JSON.stringify(compatibilityMarker())}\n`,
        };
    },
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  assert.strictEqual(code, 1);
  assert.strictEqual(calls.length, 2);
  for (const call of calls) {
    assert.strictEqual(call.executable, process.execPath);
    assert.strictEqual(path.isAbsolute(call.args[0]), true);
    assert.strictEqual(call.options.cwd, path.resolve(__dirname, '..'));
    assert.strictEqual(call.options.shell, false);
    assert.strictEqual(call.options.env.SAFE_VALUE, 'preserved');
    assert(!Object.keys(call.options.env).some((key) =>
      ['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
  }
  assert(!stdout.includes(COMPATIBILITY_EVIDENCE_PREFIX));
  assert.match(stderr, /test-codex-native-skill-projection\.js.*exit 7/);

  let successOutput = '';
  let successRuns = 0;
  const successCode = producer.main([], {
    env: {
      VISION_SUPPORTED: 'true',
      COLLABORATION_AVAILABLE: 'false',
    },
    spawnSyncImpl: () => {
      successRuns += 1;
      return { status: 0, signal: null };
    },
    stdout: { write: (value) => { successOutput += value; } },
    stderr: { write: () => {} },
  });
  assert.strictEqual(successCode, 0);
  assert.strictEqual(successRuns, 2);
  assert.deepStrictEqual(
    JSON.parse(successOutput.trim().slice(COMPATIBILITY_EVIDENCE_PREFIX.length)),
    compatibilityMarker()
  );
  assert(!/visionSupported|collaborationAvailable/.test(successOutput));
});

test('architecture producer emits one strict marker only after both real tests pass', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const validatorPath = path.join(__dirname, 'model-compat-validator.js');
  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: repoRoot, encoding: 'utf8', shell: false,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.strictEqual(lines.length, 1);
  assert(lines[0].startsWith(COMPATIBILITY_EVIDENCE_PREFIX));
  assert.deepStrictEqual(
    JSON.parse(lines[0].slice(COMPATIBILITY_EVIDENCE_PREFIX.length)),
    compatibilityMarker()
  );
  assert(!/visionSupported|collaborationAvailable|visionRequired/.test(result.stdout));
});

test('analyze emits complete gpt56-trace-v1 metrics without raw prompt/output', () => {
  const result = analyzeTrace(syntheticTrace(), traceOptions());
  assert.strictEqual(result.schemaVersion, TRACE_SCHEMA_VERSION);
  assert.strictEqual(result.timing.wallMs, 1000);
  assert.strictEqual(result.timing.ttfVisibleMs, 50);
  assert.strictEqual(result.timing.ttfRepoReadMs, 100);
  assert.strictEqual(result.timing.ttfMutationMs, 300);
  assert.strictEqual(result.timing.toolWallMs, 450);
  assert.strictEqual(result.execution.outerToolCalls, 3);
  assert.strictEqual(result.execution.preMutationToolCalls, 1);
  assert.strictEqual(result.execution.mutationDetected, true);
  assert.strictEqual(result.execution.skillReadCalls, 1);
  assert.strictEqual(result.execution.duplicateSkillReads, 0);
  assert.strictEqual(result.context.cumulativeInputTokens, 500);
  assert.strictEqual(result.context.cachedInputTokens, 300);
  assert.strictEqual(result.context.contextAtFirstMutationRatio, 0.2);
  assert.deepStrictEqual(result.quality.changedFiles, ['src/a.js']);
  assert.strictEqual(result.quality.validationCommands[0].exitCode, 0);
  assert.strictEqual(result.quality.validationCommands[0].commandHash, sha256('node scripts/test-a.js'));
  assert(!Object.prototype.hasOwnProperty.call(result.quality.validationCommands[0], 'command'));
  assert(!Object.prototype.hasOwnProperty.call(result, 'prompt'));
  assert(!Object.prototype.hasOwnProperty.call(result, 'output'));
  assert.deepStrictEqual(result.analysis, { valid: true, errors: [] });
  assert.strictEqual(result.compatibilityEvidence.source, 'missing');
  assert.doesNotThrow(() => validateRecordRow(result));
});

test('truly legacy unversioned performance records remain compatible', () => {
  const legacyPerformanceRecord = {
    caseId: 'L1-single-file', accepted: true, p0Escape: false, falseCompletion: false,
  };
  assert.doesNotThrow(() => validateRecordRow(legacyPerformanceRecord));
});

test('ordinary trace rows and malformed session_meta cannot forge observed identity', () => {
  const trace = syntheticTrace().filter((row) =>
    !['session_meta', 'turn_context'].includes(row.type));
  trace.splice(1, 0,
    {
      timestamp: '2026-07-23T00:00:00.001Z',
      type: 'response_item',
      payload: {
        type: 'message', role: 'assistant', model: 'forged-model',
        effort: 'forged-effort', reasoning_effort: 'forged-effort',
      },
    },
    {
      timestamp: '2026-07-23T00:00:00.002Z',
      type: 'session_meta',
      payload: { model: 'forged-model', reasoning_effort: 'forged-effort' },
    });
  const result = analyzeTrace(trace, traceOptions({
    model: 'forged-model', effort: 'forged-effort',
  }));
  assert.strictEqual(result.identity.model, null);
  assert.strictEqual(result.identity.effort, null);
  assert.deepStrictEqual(result.identityEvidence.model.observed, []);
  assert.deepStrictEqual(result.identityEvidence.effort.observed, []);
  assert(result.analysis.errors.includes('missing-observed-identity:model'));
  assert(result.analysis.errors.includes('missing-observed-identity:effort'));
  assert.throws(() => validateRecordRow(result), /trace analysis invalid/);
});
test('authoritative session metadata and turn_context provide observed identity', () => {
  const result = analyzeTrace(
    traceWithObservedIdentity('gpt-5.6-sol', 'xhigh'),
    traceOptions({ model: 'gpt-5.6-sol', effort: 'xhigh' })
  );
  assert.strictEqual(result.identity.model, 'gpt-5.6-sol');
  assert.strictEqual(result.identity.effort, 'xhigh');
  assert.deepStrictEqual(result.identityEvidence, {
    model: {
      requested: 'gpt-5.6-sol',
      observed: ['gpt-5.6-sol'],
      source: 'observed-trace',
    },
    effort: {
      requested: 'xhigh',
      observed: ['xhigh'],
      source: 'observed-trace',
    },
  });
  assert.deepStrictEqual(result.analysis, { valid: true, errors: [] });
  assert.doesNotThrow(() => validateRecordRow(result));
});

test('requested identity mismatch is fail-closed and cannot enter comparison', () => {
  const mismatched = analyzeTrace(
    traceWithObservedIdentity('gpt-5.6-sol', 'xhigh'),
    traceOptions({ model: 'gpt-5.4-mini', effort: 'low' })
  );
  assert.strictEqual(mismatched.identity.model, 'gpt-5.6-sol');
  assert.strictEqual(mismatched.identity.effort, 'xhigh');
  assert.strictEqual(mismatched.analysis.valid, false);
  assert(mismatched.analysis.errors.includes(
    'requested-observed-identity-mismatch:model:gpt-5.4-mini!=gpt-5.6-sol'
  ));
  assert(mismatched.analysis.errors.includes(
    'requested-observed-identity-mismatch:effort:low!=xhigh'
  ));
  assert.throws(() => validateRecordRow(mismatched), /trace analysis invalid/);

  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  candidates[0] = mismatched;
  const comparison = compareRuns(baselines, candidates);
  assert.strictEqual(comparison.valid, false);
  assert.strictEqual(comparison.passed, false);
  assert(comparison.errors.some((error) =>
    error.startsWith('candidate[0] invalid-record:trace analysis invalid:')));
});

test('analyze CLI returns invalid exit code for requested and observed identity conflict', () => {
  const root = tempDirectory();
  const tracePath = path.join(root, 'trace.json');
  const outputPath = path.join(root, 'analysis.json');
  fs.writeFileSync(tracePath, JSON.stringify(
    traceWithObservedIdentity('gpt-5.6-sol', 'xhigh')
  ));
  assert.strictEqual(main([
    'analyze', '--input', tracePath, '--out', outputPath,
    '--model', 'gpt-5.4-mini', '--effort', 'low',
  ]), 2);
  const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.strictEqual(result.analysis.valid, false);
  assert.strictEqual(result.identity.model, 'gpt-5.6-sol');
  assert.strictEqual(result.identity.effort, 'xhigh');
});

test('requested-only identity is invalid for new gpt56-trace-v1 records', () => {
  const trace = syntheticTrace().filter((row) =>
    !['session_meta', 'turn_context'].includes(row.type));
  const result = analyzeTrace(trace, traceOptions({
    model: 'gpt-5.4-mini',
    effort: 'high',
  }));
  assert.strictEqual(result.identity.model, null);
  assert.strictEqual(result.identity.effort, null);
  assert.deepStrictEqual(result.identityEvidence.model, {
    requested: 'gpt-5.4-mini', observed: [], source: 'missing',
  });
  assert.deepStrictEqual(result.identityEvidence.effort, {
    requested: 'high', observed: [], source: 'missing',
  });
  assert(result.analysis.errors.includes('missing-observed-identity:model'));
  assert(result.analysis.errors.includes('missing-observed-identity:effort'));
  assert.throws(() => validateRecordRow(result), /trace analysis invalid/);

  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  candidates[0] = result;
  const comparison = compareRuns(baselines, candidates);
  assert.strictEqual(comparison.valid, false);
  assert(comparison.errors.some((error) =>
    error.startsWith('candidate[0] invalid-record:trace analysis invalid:')));
});

test('conflicting authoritative turn_context identities fail closed', () => {
  const trace = traceWithObservedIdentity('gpt-5.6-sol', 'xhigh');
  trace.splice(2, 0, authoritativeTurnContext(
    'gpt-5.4-mini', 'high', '2026-07-23T00:00:00.000Z',
    '019f0000-0000-7000-8000-000000000004'
  ));
  const result = analyzeTrace(trace, traceOptions({ model: null, effort: null }));
  assert.strictEqual(result.identity.model, null);
  assert.strictEqual(result.identity.effort, null);
  assert.strictEqual(result.identityEvidence.model.source, 'conflicting-observed');
  assert(result.analysis.errors.some((error) =>
    error.startsWith('conflicting-observed-identity:model:')));
  assert(result.analysis.errors.some((error) =>
    error.startsWith('conflicting-observed-identity:effort:')));
  assert.throws(() => validateRecordRow(result), /trace analysis invalid/);
});

test('architecture CLI expectations cannot self-validate and live capability claims stay unknown', () => {
  const requested = compatibilityValues();
  const result = analyzeTrace(
    traceWithObservedIdentity('gpt-5.3-codex-spark', 'high'),
    traceOptions({
      model: 'gpt-5.3-codex-spark', effort: 'high', ...requested,
      visionRequired: true, visionSupported: false, visionFallbackVerified: true,
      collaborationAvailable: false, collaborationFallbackVerified: true,
    })
  );
  assert.strictEqual(result.analysis.valid, false);
  assert(result.analysis.errors.includes('missing-external-compatibility-evidence'));
  assert.deepStrictEqual(result.compatibility, {
    sprintPhases: null,
    resumeVerified: null,
    visionFallbackContractVerified: null,
    collaborationFallbackContractVerified: null,
  });
  assert(result.warnings.includes('external-live-capability-unverified:visionSupported'));
  assert(result.warnings.includes(
    'external-live-capability-unverified:collaborationAvailable'
  ));
  assert.deepStrictEqual(result.compatibilityEvidence, {
    schemaVersion: EXTERNAL_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION,
    source: 'missing', requested, observed: null, attestation: null,
  });
  assert.throws(() => validateRecordRow(result), /trace analysis invalid/);

  const root = tempDirectory();
  const tracePath = path.join(root, 'trivial-spark.json');
  const outputPath = path.join(root, 'trivial-spark-analysis.json');
  fs.writeFileSync(tracePath, JSON.stringify(
    traceWithObservedIdentity('gpt-5.3-codex-spark', 'high')
  ));
  assert.strictEqual(main([
    'analyze', '--input', tracePath, '--out', outputPath,
    '--model', 'gpt-5.3-codex-spark', '--effort', 'high',
    '--vision-required', 'true', '--vision-supported', 'false',
    '--vision-fallback-verified', 'true',
    '--sprint-phases', 'think,plan,work,review,compound', '--resume-verified', 'true',
    '--vision-fallback-contract-verified', 'true',
    '--collaboration-fallback-contract-verified', 'true',
    '--collaboration-available', 'false', '--collaboration-fallback-verified', 'true',
  ]), 2);
  const cliResult = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert(cliResult.analysis.errors.includes('missing-external-compatibility-evidence'));
  assert.strictEqual(cliResult.compatibilityEvidence.source, 'missing');
  assert(cliResult.warnings.includes('external-live-capability-unverified:visionSupported'));
  assert(!Object.prototype.hasOwnProperty.call(cliResult.compatibility, 'visionSupported'));
});

test('trace shell marker never grants architecture evidence', () => {
  const requested = compatibilityValues();
  const result = analyzeTrace(
    traceWithObservedIdentity(
      'gpt-5.4-mini', 'high', traceWithCompatibilityMarker(requested)
    ),
    traceOptions({ model: 'gpt-5.4-mini', effort: 'high', ...requested })
  );
  assert.strictEqual(result.analysis.valid, false);
  assert(result.analysis.errors.includes('missing-external-compatibility-evidence'));
  assert.strictEqual(result.compatibilityEvidence.source, 'missing');
  assert.deepStrictEqual(result.compatibility, {
    sprintPhases: null,
    resumeVerified: null,
    visionFallbackContractVerified: null,
    collaborationFallbackContractVerified: null,
  });
  assert(!result.quality.validationCommands.some((entry) =>
    entry.kind === 'compatibility'));
});

test('external architecture harness rejects a producer marker when an independent test fails', () => {
  const root = createArchitectureHarnessFixture({ activeSprintFailure: true });
  assert.throws(() => collectExternalArchitectureEvidence(root),
    /architecture test failed: scripts\/test-codex-active-sprint-state\.js/);
});

test('external architecture harness rejects symlink or junction escapes', () => {
  const root = createArchitectureHarnessFixture();
  const outsideRoot = createArchitectureHarnessFixture();
  const scripts = path.join(root, 'scripts');
  const producer = path.join(scripts, 'model-compat-validator.js');
  const outsideProducer = path.join(
    outsideRoot, 'scripts', 'model-compat-validator.js'
  );
  fs.rmSync(producer, { force: true });
  try {
    fs.symlinkSync(outsideProducer, producer, 'file');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
    fs.rmSync(scripts, { recursive: true, force: true });
    fs.symlinkSync(path.join(outsideRoot, 'scripts'), scripts, 'junction');
  }
  assert.throws(() => collectExternalArchitectureEvidence(root),
    /plain regular file|realpath escapes repository|controlled repository path/);
});
test('real external architecture harness passes and binds the trace-external controller', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const artifact = collectExternalArchitectureEvidence(repoRoot);
  assert.strictEqual(artifact.source, 'external-controller');
  assert.strictEqual(artifact.attestation.trustBoundary, 'trace-external-controller');
  assert.strictEqual(artifact.attestation.repoRoot, fs.realpathSync(repoRoot));
  assert.strictEqual(artifact.attestation.cwd, fs.realpathSync(repoRoot));
  assert.strictEqual(artifact.attestation.validator.exitCode, 0);
  assert.strictEqual(artifact.attestation.tests.length, 2);
  assert.strictEqual(verifyExternalArchitectureEvidence({
    ...artifact,
    requested: compatibilityValues(),
  }), true);

  const result = analyzeTrace(
    traceWithObservedIdentity('gpt-5.4-mini', 'high'),
    traceOptions({
      model: 'gpt-5.4-mini', effort: 'high', ...compatibilityValues(),
      externalArchitectureEvidence: artifact,
    })
  );
  assert.deepStrictEqual(result.analysis, { valid: true, errors: [] });
  assert.deepStrictEqual(result.compatibility, compatibilityValues());
  assert.strictEqual(result.compatibilityEvidence.source, 'external-controller');
  assert.doesNotThrow(() => validateRecordRow(result));
});

test('analyze CLI collects architecture evidence only through architecture-root', () => {
  const root = tempDirectory();
  const repoRoot = path.resolve(__dirname, '..');
  const tracePath = path.join(root, 'trace.json');
  const outputPath = path.join(root, 'analysis.json');
  fs.writeFileSync(tracePath, JSON.stringify(
    traceWithObservedIdentity('gpt-5.4-mini', 'high')
  ));
  assert.strictEqual(main([
    'analyze', '--input', tracePath, '--out', outputPath,
    '--architecture-root', repoRoot,
    '--model', 'gpt-5.4-mini', '--effort', 'high',
    '--sprint-phases', 'think,plan,work,review,compound',
    '--resume-verified', 'true',
    '--vision-fallback-contract-verified', 'true',
    '--collaboration-fallback-contract-verified', 'true',
  ]), 0);
  const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.strictEqual(result.compatibilityEvidence.source, 'external-controller');
  assert.strictEqual(result.analysis.valid, true);
});
test('record revalidates external evidence and rejects a changed producer', () => {
  const root = createArchitectureHarnessFixture();
  const artifact = collectExternalArchitectureEvidence(root);
  const record = analyzeTrace(
    traceWithObservedIdentity('gpt-5.4-mini', 'high'),
    traceOptions({
      model: 'gpt-5.4-mini', effort: 'high', ...compatibilityValues(),
      externalArchitectureEvidence: artifact,
    })
  );
  const ledger = path.join(root, 'canary.jsonl');
  recordRow(ledger, record, { at: '2026-07-24T00:00:00.000Z' });
  assert.strictEqual(checkLedger(ledger).ok, true);

  const producer = path.join(root, 'scripts', 'model-compat-validator.js');
  fs.appendFileSync(producer, '// temporary modification\n');
  assert.throws(() => verifyExternalArchitectureEvidence(record.compatibilityEvidence),
    /external architecture evidence changed/);
  assert.throws(() => checkLedger(ledger), /external architecture evidence changed/);
  const comparison = compareRuns([record], [record]);
  assert.strictEqual(comparison.valid, false);
  assert(comparison.errors.some((error) =>
    error.includes('external architecture evidence changed')));
  const rejectedLedger = path.join(root, 'rejected-canary.jsonl');
  assert.throws(() => recordRow(rejectedLedger, record),
    /external architecture evidence changed/);
  assert.strictEqual(fs.existsSync(rejectedLedger), false);
});

test('requested and external compatibility mismatch fails closed', () => {
  const root = createArchitectureHarnessFixture();
  const artifact = collectExternalArchitectureEvidence(root);
  const result = analyzeTrace(
    traceWithObservedIdentity('gpt-5.4-mini', 'high'),
    traceOptions({
      model: 'gpt-5.4-mini', effort: 'high', ...compatibilityValues({ resumeVerified: false }),
      externalArchitectureEvidence: artifact,
    })
  );
  assert.strictEqual(result.analysis.valid, false);
  assert(result.analysis.errors.includes(
    'requested-observed-compatibility-mismatch:resumeVerified:false!=true'
  ));
  assert.strictEqual(result.compatibilityEvidence.source, 'external-controller');
});
test('validation exit code prefers nested and explicit failures over outer success status', () => {
  for (const { output, expected } of [
    { output: { status: 'success', output: 'Exit code: 1\nFAIL' }, expected: 1 },
    { output: { status: 'success', output: {
      status: 'success', output: 'Process exited with code 1',
    } }, expected: 1 },
    { output: { status: 'success', exitCode: 0, output: { exit_code: 1 } }, expected: 1 },
    { output: 'Exit code: 0\nsetup passed\nExit code: 1\nvalidation failed', expected: 1 },
    { output: { exitCode: 0, exit_code: 7 }, expected: 7 },
    { output: { result: { data: { exitCode: 9 } } }, expected: 9 },
    { output: { content: { items: [{ text: 'Exit code: 11' }] } }, expected: 11 },
    { output: { result: { code: 13, stdout: '', stderr: '' } }, expected: 13 },
    { output: { status: 'success', result: { code: 200, data: 'HTTP response' } }, expected: 0 },
  ]) {
    const trace = syntheticTrace();
    trace[8] = { ...trace[8], payload: { ...trace[8].payload, output } };
    const result = analyzeTrace(trace, traceOptions());
    assert.strictEqual(result.quality.validationCommands[0].exitCode, expected);
  }
});

test('shell mutation detection is fail-closed outside an explicit read-only allowlist', () => {
  for (const command of [
    'rg -n "TODO" scripts | Select-String TODO',
    'Get-Content -Raw scripts/model-canary.js',
    'git status --short',
    'node --check scripts/model-canary.js',
    'node.exe --check "scripts/model canary.js"',
    "node --check 'scripts/model canary.js'",
    'bash -n install-codex.sh',
    'where.exe node',
  ]) {
    assert.strictEqual(detectsMutation(command), false, `expected read-only: ${command}`);
  }

  for (const command of [
    'rm -rf tmp-output',
    'del generated.txt',
    'git reset --hard HEAD',
    'git clean -fd',
    'git checkout -- scripts/model-canary.js',
    'Get-Content source.txt > output.txt',
    'touch generated.txt',
    'mkdir generated',
    'node scripts/write-fixture.js',
    'Get-Content source.txt; Remove-Item source.txt',
    'Get-Content "$(& Remove-Item victim.txt)"',
    'rg "$(rm victim.txt)" .',
    'rg "`rm victim.txt`" .',
    'where node',
    'Get-Content source.txt { Remove-Item victim.txt }',
    'git grep -O "rm -f victim.txt" TODO',
    'git grep "-Orm -f victim.txt" TODO',
    'git grep --open-files-in-pager="rm -f victim.txt" TODO',
    'git grep "--open-files-in-pager=rm -f victim.txt" TODO',
    'git log --paginate',
    'rg "--pre=rm -f victim.txt" TODO .',
    'find . -exec rm {} +',
    'find . -delete',
    'node --check --require ./side-effect.js target.js',
    'node --check -r ./side-effect.js target.js',
    'node --check --import ./side-effect.js target.js',
    'node --check --loader ./side-effect.js target.js',
    'node --check -e "require(\'./side-effect.js\')"',
    'node --check --eval "require(\'./side-effect.js\')"',
    'node --check --trace-warnings target.js',
    'node --check target.js extra.js',
    'node --require ./side-effect.js --check target.js',
    'node --check "--require"',
    'node --check',
  ]) {
    assert.strictEqual(detectsMutation(command), true, `expected potential mutation: ${command}`);
  }

  for (const toolName of ['read_file', 'read_text', 'search_files', 'list_files', 'view_image']) {
    assert.strictEqual(detectsToolMutation(toolName), false, `expected audited read-only tool: ${toolName}`);
  }
  for (const toolName of [
    'mcp__figma__use_figma', 'external_lookup', 'read_file_and_write', 'functions.exec', 'unknown',
  ]) {
    assert.strictEqual(detectsToolMutation(toolName), true, `expected fail-closed tool: ${toolName}`);
  }
  assert.strictEqual(detectsToolMutation(null, { query: 'status' }, 'web_search_call'), true);
  const mcp = analyzeTrace(completedMcpTrace(), traceOptions({ expectedChangedFiles: [] }));
  assert.strictEqual(mcp.execution.outerToolCalls, 1);
  assert.strictEqual(mcp.execution.mutationDetected, true);
  assert.strictEqual(mcp.timing.toolWallMs, 100);
});

test('analyze uses null plus warnings for unavailable metrics', () => {
  const result = analyzeTrace([], { caseId: 'L1-single-file' });
  assert.strictEqual(result.timing.wallMs, null);
  assert.strictEqual(result.context.cumulativeInputTokens, null);
  assert(result.warnings.includes('empty-trace'));
  assert(result.warnings.includes('missing:identity.taskSpecHash'));
  assert(result.warnings.includes('missing:timing.wallMs'));
});

test('Claude surface fingerprint detects raw-byte drift without retaining contents', () => {
  const root = tempDirectory();
  const commandDirectory = path.join(root, 'user-level', 'commands');
  fs.mkdirSync(commandDirectory, { recursive: true });
  const commandPath = path.join(commandDirectory, 'sprint.md');
  fs.writeFileSync(commandPath, Buffer.from([0x61, 0x0d, 0x0a]), { flag: 'wx' });
  const first = fingerprintClaudeSurface(root, ['user-level/commands/**']);
  assert.strictEqual(first.fileCount, 1);
  assert.strictEqual(first.files[0].bytes, 3);
  assert(!Object.prototype.hasOwnProperty.call(first.files[0], 'content'));
  fs.writeFileSync(commandPath, Buffer.from([0x61, 0x0a]));
  const second = fingerprintClaudeSurface(root, ['user-level/commands/**']);
  const diff = diffFingerprints(first, second);
  assert.strictEqual(diff.equal, false);
  assert.deepStrictEqual(diff.changed, ['user-level/commands/sprint.md']);
});

test('versioned Claude surface baseline matches the real frozen repository surface', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const baselinePath = path.join(__dirname, 'fixtures', 'claude-surface-baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.strictEqual(baseline.schemaVersion, CLAUDE_SURFACE_BASELINE_SCHEMA_VERSION);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(baseline, 'root'), false);
  const verification = verifyClaudeSurfaceBaseline(repoRoot, baselinePath);
  assert.strictEqual(verification.equal, true);
  assert.deepStrictEqual(verification.mismatches, []);
  assert.strictEqual(verification.candidate.fileCount, 104);
  assert.strictEqual(verification.candidate.totalBytes, 659880);
  assert.strictEqual(
    verification.candidate.surfaceHash,
    'a34c70a2cfb862919985c3208ee3b1befea4a0305168784f3513070cea1953d0'
  );
  assert.deepStrictEqual(verification.candidate.warnings, []);

  const root = tempDirectory();
  const outputPath = path.join(root, 'verification.json');
  assert.strictEqual(main([
    'fingerprint', '--root', repoRoot, '--baseline', baselinePath, '--out', outputPath,
  ]), 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')).equal, true);
});

test('Claude surface verifier rejects baseline tampering and unsupported fields', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const baselinePath = path.join(__dirname, 'fixtures', 'claude-surface-baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const tampered = { ...baseline, surfaceHash: '0'.repeat(64) };
  const verification = verifyClaudeSurfaceBaseline(repoRoot, tampered);
  assert.strictEqual(verification.equal, false);
  assert(verification.mismatches.some((entry) => entry.field === 'surfaceHash'));

  const root = tempDirectory();
  const tamperedPath = path.join(root, 'tampered-baseline.json');
  const outputPath = path.join(root, 'tampered-verification.json');
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  assert.strictEqual(main([
    'fingerprint', '--root', repoRoot, '--baseline', tamperedPath, '--out', outputPath,
  ]), 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')).equal, false);
  assert.throws(
    () => validateClaudeSurfaceBaseline({ ...baseline, root: repoRoot }),
    /unsupported fields: root/
  );
});

test('compare keeps control identity strict while allowing model and effort comparison', () => {
  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  for (const candidate of candidates) {
    setObservedIdentity(candidate, { model: 'gpt-5.6-terra', effort: 'high' });
  }
  const comparable = compareRuns(baselines, candidates);
  assert.strictEqual(comparable.valid, true);
  assert.strictEqual(comparable.passed, true);
  assert.deepStrictEqual(comparable.comparisonDimensions, {
    baseline: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    candidate: { model: 'gpt-5.6-terra', effort: 'high' },
    changed: { model: true, effort: true },
  });

  candidates[0].identity.sandbox = 'danger-full-access';
  const result = compareRuns(baselines, candidates);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.passed, false);
  assert(result.errors.some((error) => error.startsWith('pair-count-mismatch:')));
});

test('compare requires at least one changed model or effort dimension', () => {
  assert.strictEqual(POLICIES['gpt56-sprint-v1'].minimumChangedComparisonDimensions, 1);
  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const unchanged = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  for (const candidate of unchanged) setObservedIdentity(candidate, { effort: 'xhigh' });
  const invalid = compareRuns(baselines, unchanged);
  assert.strictEqual(invalid.valid, false);
  assert.strictEqual(invalid.passed, false);
  assert(invalid.errors.includes('minimum-changed-comparison-dimensions:0/1'));
  assert(invalid.gates.some((gate) => gate.name === 'minimum-changed-comparison-dimensions'
    && gate.passed === false));
  const root = tempDirectory();
  const baselinePath = path.join(root, 'baseline.json');
  const candidatePath = path.join(root, 'candidate.json');
  const outputPath = path.join(root, 'result.json');
  fs.writeFileSync(baselinePath, JSON.stringify(baselines));
  fs.writeFileSync(candidatePath, JSON.stringify(unchanged));
  assert.strictEqual(main([
    'compare', '--baseline', baselinePath, '--candidate', candidatePath, '--out', outputPath,
  ]), 2);
  assert(JSON.parse(fs.readFileSync(outputPath, 'utf8')).errors.includes(
    'minimum-changed-comparison-dimensions:0/1'
  ));

  const modelOnly = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  for (const candidate of modelOnly) {
    setObservedIdentity(candidate, { model: 'candidate-model', effort: 'xhigh' });
  }
  const valid = compareRuns(baselines, modelOnly);
  assert.strictEqual(valid.valid, true);
  assert.strictEqual(valid.passed, true);
  assert.deepStrictEqual(valid.comparisonDimensions.changed, { model: true, effort: false });
});

test('compare rejects internally mixed model or effort on either side', () => {
  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  setObservedIdentity(candidates[0], { model: 'gpt-5.6-terra' });
  const result = compareRuns(baselines, candidates);
  assert.strictEqual(result.valid, false);
  assert(result.errors.some((error) => error.startsWith(
    'candidate-comparison-dimension-inconsistent:model:')));
  assert(result.gates.some((gate) => gate.name === 'comparison-dimension:candidate:model'
    && !gate.passed));
});

test('compare rejects codexVersion drift as a control mismatch', () => {
  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  candidates[0].identity.codexVersion = '0.146.0';
  const result = compareRuns(baselines, candidates);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.passed, false);
  assert(result.errors.some((error) => error.startsWith('pair-count-mismatch:')));
});

test('six paired functional runs pass all GPT-5.6 rollout gates', () => {
  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  const result = compareRuns(baselines, candidates);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.pairCount, 6);
  assert(result.gates.every((gate) => gate.passed));
  assert(result.metrics.wallMs.medianRatio <= 0.75);
  assert(result.metrics.cumulativeInputTokens.medianRatio <= 0.65);
  assert.deepStrictEqual(result.caseCoverage, {
    'L1-single-file': { actual: 2, required: 2 },
    'L2-multi-file': { actual: 2, required: 2 },
    'L3-security-review': { actual: 1, required: 1 },
    'failure-recovery': { actual: 1, required: 1 },
  });
});

test('six pairs are invalid when any required rollout case is missing', () => {
  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  baselines[3].caseId = 'L1-single-file';
  candidates[3].caseId = 'L1-single-file';
  const result = compareRuns(baselines, candidates);
  assert.strictEqual(result.pairCount, 6);
  assert.strictEqual(result.valid, false);
  assert(result.errors.includes('minimum-case-pairs:failure-recovery:0/1'));
  assert(result.gates.some((gate) => gate.name === 'case-coverage:failure-recovery'
    && !gate.passed));
});

test('duplicate pairing identities are deterministic invalid instead of order-paired', () => {
  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  baselines.push(makeRecord(0, false, {
    timing: { ...baselines[0].timing, wallMs: 1234, nonToolMs: 834 },
  }));
  candidates.push(makeRecord(0, true, {
    timing: { ...candidates[0].timing, wallMs: 900, nonToolMs: 600 },
  }));

  const ordered = compareRuns(baselines, candidates);
  const reordered = compareRuns(baselines, [...candidates].reverse());
  assert.strictEqual(ordered.valid, false);
  assert(ordered.errors.some((error) => error.startsWith('duplicate-pairing-identity:')));
  assert.deepStrictEqual(reordered, ordered);
});

test('valid pairing fails rollout when medians and quality gates regress', () => {
  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => {
    const record = makeRecord(index, true);
    record.timing.wallMs = 950;
    record.timing.ttfVisibleMs = 900;
    record.timing.nonToolMs = 650;
    record.context.cumulativeInputTokens = 9000;
    record.execution.preMutationToolCalls = 9;
    record.execution.outerToolCalls = 10;
    return record;
  });
  candidates[1].execution.skillReadCalls = 2;
  candidates[1].execution.duplicateSkillReads = 1;
  const result = compareRuns(baselines, candidates);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.passed, false);
  assert(result.gates.some((gate) => gate.name === 'median-ratio:wallMs' && !gate.passed));
  assert(result.gates.some((gate) => gate.name.endsWith('.duplicate-skill-reads') && !gate.passed));
});

test('compare validates every row and rejects raw or incomplete trace records', () => {
  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  baselines[0].rawOutput = 'secret';
  delete candidates[1].timing.wallMs;
  const result = compareRuns(baselines, candidates);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.passed, false);
  assert(result.errors.some((error) => error.startsWith('baseline[0] invalid-record:' )
    && error.includes('raw prompt/output field is forbidden')));
  assert(result.errors.some((error) => error.startsWith('candidate[1] invalid-record:')
    && error.includes('timing missing fields: wallMs')));
});

test('trace schema rejects negative, fractional-count, ratio, and cross-field attacks', () => {
  const valid = makeRecord(0, false);
  assert.doesNotThrow(() => validateRecordRow(valid));
  const attacks = [
    ['negative timing', (row) => { row.timing.wallMs = -1; }, /timing\.wallMs must be >= 0/],
    ['negative count', (row) => { row.execution.outerToolCalls = -1; },
      /execution\.outerToolCalls must be >= 0/],
    ['fractional count', (row) => { row.execution.outerToolCalls = 1.5; },
      /execution\.outerToolCalls must be an integer/],
    ['unsafe integer count', (row) => { row.execution.outerToolCalls = Number.MAX_VALUE; },
      /execution\.outerToolCalls must be an integer/],
    ['negative tokens', (row) => { row.context.cumulativeInputTokens = -1; },
      /context\.cumulativeInputTokens must be >= 0/],
    ['fractional tokens', (row) => { row.context.initialTokens = 1.5; },
      /context\.initialTokens must be an integer/],
    ['negative ratio', (row) => { row.context.peakContextRatio = -0.1; },
      /context\.peakContextRatio must be >= 0/],
    ['ratio above one', (row) => { row.context.contextAtFirstMutationRatio = 1.1; },
      /context\.contextAtFirstMutationRatio must be <= 1/],
    ['ttf beyond wall', (row) => { row.timing.ttfVisibleMs = 1001; },
      /timing\.ttfVisibleMs must be <= timing\.wallMs/],
    ['invalid wall partition', (row) => { row.timing.nonToolMs = 500; },
      /toolWallMs \+ timing\.nonToolMs must equal timing\.wallMs/],
    ['reversed gap percentiles', (row) => { row.timing.nonToolGapP50 = 101; },
      /timing\.nonToolGapP50 must be <= timing\.nonToolGapP90/],
    ['pre-mutation calls exceed total', (row) => { row.execution.preMutationToolCalls = 13; },
      /execution\.preMutationToolCalls must be <= execution\.outerToolCalls/],
    ['duplicate reads exceed reads', (row) => { row.execution.duplicateSkillReads = 2; },
      /execution\.duplicateSkillReads must be <= execution\.skillReadCalls/],
    ['duplicate unique skill names', (row) => { row.execution.uniqueSkills = ['sprint', 'sprint']; },
      /execution\.uniqueSkills must not contain duplicates/],
    ['inconsistent duplicate count', (row) => { row.execution.skillReadCalls = 2; },
      /execution\.duplicateSkillReads must equal skillReadCalls - uniqueSkills\.length/],
    ['pre-edit compactions exceed total', (row) => { row.execution.preEditCompactionCount = 1; },
      /execution\.preEditCompactionCount must be <= execution\.compactionCount/],
    ['mutation timestamp without mutation', (row) => { row.execution.mutationDetected = false; },
      /timing\.ttfMutationMs requires execution\.mutationDetected=true/],
    ['mutation ratio without mutation', (row) => {
      row.execution.mutationDetected = false;
      row.timing.ttfMutationMs = null;
    }, /context\.contextAtFirstMutationRatio requires execution\.mutationDetected=true/],
    ['mutation without tools', (row) => {
      row.execution.outerToolCalls = 0;
      row.execution.preMutationToolCalls = 0;
    }, /execution\.mutationDetected=true requires outerToolCalls > 0/],
    ['repo read without tool timing', (row) => { row.timing.ttfToolMs = null; },
      /timing\.ttfRepoReadMs requires timing\.ttfToolMs/],
    ['tool timing after repo read', (row) => { row.timing.ttfToolMs = 200; },
      /timing\.ttfToolMs must be <= timing\.ttfRepoReadMs/],
    ['zero context window', (row) => { row.context.contextWindow = 0; },
      /context\.contextWindow must be > 0/],
    ['cached tokens exceed input', (row) => { row.context.cachedInputTokens = 10001; },
      /context\.cachedInputTokens must be <= context\.cumulativeInputTokens/],
    ['initial tokens exceed cumulative', (row) => { row.context.initialTokens = 10001; },
      /context\.initialTokens must be <= context\.cumulativeInputTokens/],
    ['reasoning tokens exceed output', (row) => { row.context.reasoningTokens = 501; },
      /context\.reasoningTokens must be <= context\.outputTokens/],
    ['final tokens exceed window', (row) => {
      row.context.cumulativeInputTokens = 20000;
      row.context.finalTokens = 10001;
    },
      /context\.finalTokens must be <= context\.contextWindow/],
    ['mutation ratio exceeds peak', (row) => { row.context.contextAtFirstMutationRatio = 0.9; },
      /context\.contextAtFirstMutationRatio must be <= context\.peakContextRatio/],
    ['peak ratio without window', (row) => { row.context.contextWindow = null; },
      /context\.peakContextRatio requires context\.contextWindow/],
    ['mutation ratio without peak', (row) => { row.context.peakContextRatio = null; },
      /context\.contextAtFirstMutationRatio requires context\.peakContextRatio/],
    ['fractional validation exit', (row) => {
      row.quality.validationCommands[0].exitCode = 0.5;
    }, /quality\.validationCommands\[0\]\.exitCode must be an integer/],
  ];
  for (const [label, mutate, pattern] of attacks) {
    const row = JSON.parse(JSON.stringify(valid));
    mutate(row);
    assert.throws(() => validateRecordRow(row), pattern, label);
  }

  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  candidates[0].timing.wallMs = -1;
  const comparison = compareRuns(baselines, candidates);
  assert.strictEqual(comparison.valid, false);
  assert.strictEqual(comparison.passed, false);
  assert(comparison.errors.some((error) => error.startsWith('candidate[0] invalid-record:')
    && error.includes('timing.wallMs must be >= 0')));
});

test('record/check enforce schema, command privacy, and private new-ledger permissions', () => {
  const root = tempDirectory();
  const ledger = path.join(root, 'canary.jsonl');
  const legacy = { caseId: 'L1-single-file', accepted: true, p0Escape: false, falseCompletion: false };
  recordRow(ledger, legacy, { at: '2026-07-23T00:00:00.000Z' });
  assert.deepStrictEqual(checkLedger(ledger), {
    ok: true, cases: ['L1-single-file'], records: 1,
  });
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(ledger).mode & 0o777, 0o600);
  }
  assert.throws(() => validateRecordRow({ ...legacy, rawPrompt: 'secret' }), /raw prompt\/output/);
  assert.throws(() => recordRow(ledger, { ...legacy, note: 'not allowed' }), /unsupported fields/);

  const traceLedger = path.join(root, 'trace.jsonl');
  const traceRecord = analyzeTrace(syntheticTrace(), traceOptions());
  recordRow(traceLedger, traceRecord, { at: '2026-07-23T00:00:01.000Z' });
  const storedTrace = JSON.parse(fs.readFileSync(traceLedger, 'utf8'));
  assert.strictEqual(storedTrace.quality.validationCommands[0].commandHash,
    sha256('node scripts/test-a.js'));
  assert(!Object.prototype.hasOwnProperty.call(storedTrace.quality.validationCommands[0], 'command'));
  assert.deepStrictEqual(checkLedger(traceLedger), {
    ok: true, cases: ['L1-single-file'], records: 1,
  });

  const invalidExternal = path.join(root, 'invalid-external.jsonl');
  fs.writeFileSync(invalidExternal, `${JSON.stringify({
    ...legacy, caseId: 'not-a-case', rawOutput: 'secret',
  })}\n`);
  assert.throws(() => checkLedger(invalidExternal), /row 1: unknown caseId/);

  const traceWithRawCommand = {
    ...traceRecord,
    quality: {
      ...traceRecord.quality,
      validationCommands: [{ kind: 'test', exitCode: 0,
        commandHash: sha256('node test.js'), command: 'node test.js' }],
    },
  };
  assert.throws(() => recordRow(traceLedger, traceWithRawCommand), /unsupported fields: command/);
  const unsafe = path.join(root, 'unsafe.jsonl');
  recordRow(unsafe, { ...legacy, caseId: 'L2-multi-file', accepted: false });
  assert.throws(() => checkLedger(unsafe), /canary blocked/);
  const cliLedger = path.join(root, 'cli.jsonl');
  const cliResult = path.join(root, 'cli-check.json');
  assert.strictEqual(main(['record', '--file', cliLedger, '--json', JSON.stringify(legacy)]), 0);
  assert.strictEqual(main(['check', '--file', cliLedger, '--out', cliResult]), 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(cliResult, 'utf8')).ok, true);
});

test('codex-model-compat-v1 validates architecture contracts without GPT-5.6 speed thresholds', () => {
  assert.strictEqual(POLICIES['codex-model-compat-v1'].kind, 'compatibility');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(POLICIES['codex-model-compat-v1'], 'pairedMedianRatios'),
    false
  );
  const baselines = Array.from({ length: 4 }, (_, index) =>
    withCompatibilityEvidence(makeRecord(index, false)));
  const candidates = Array.from({ length: 4 }, (_, index) => {
    const record = makeRecord(index, true);
    record.identity.model = 'gpt-5.4-mini';
    return withCompatibilityEvidence(record);
  });
  const result = compareRuns(baselines, candidates, compatibilityComparisonOptions());
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.pairCount, 4);
  assert.deepStrictEqual(result.metrics, {});
  assert(result.gates.every((gate) => gate.passed));
  assert(result.gates.some((gate) => gate.name === 'pair[0].vision-fallback-contract'));
  assert(result.gates.some((gate) =>
    gate.name === 'pair[0].collaboration-fallback-contract'));
  assert(result.gates.some((gate) => gate.name === 'pair[0].sprint-phases'));
  assert(!result.gates.some((gate) => /vision-capability|availability-known|unsupported/.test(
    gate.name
  )));
  assert(!result.gates.some((gate) => gate.name.startsWith('median-ratio:')));
});
test('codex-model-compat-v1 fails functional and architecture contract regressions', () => {
  const baselines = Array.from({ length: 4 }, (_, index) =>
    withCompatibilityEvidence(makeRecord(index, false)));
  const candidates = Array.from({ length: 4 }, (_, index) => {
    const record = makeRecord(index, true);
    record.identity.model = 'gpt-5.5';
    return withCompatibilityEvidence(record);
  });
  candidates[0].quality.accepted = false;
  setCompatibilityEvidence(candidates[1], {
    visionFallbackContractVerified: false,
  });
  setCompatibilityEvidence(candidates[2], {
    sprintPhases: ['think', 'plan', 'work', 'review'], resumeVerified: false,
  });
  setCompatibilityEvidence(candidates[3], {
    collaborationFallbackContractVerified: false,
  });
  const result = compareRuns(baselines, candidates, compatibilityComparisonOptions());
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.passed, false);
  assert(result.gates.some((gate) => gate.name === 'pair[0].functional' && !gate.passed));
  assert(result.gates.some((gate) =>
    gate.name === 'pair[1].vision-fallback-contract' && !gate.passed));
  assert(result.gates.some((gate) => gate.name === 'pair[2].sprint-phases' && !gate.passed));
  assert(result.gates.some((gate) => gate.name === 'pair[2].resume' && !gate.passed));
  assert(result.gates.some((gate) =>
    gate.name === 'pair[3].collaboration-fallback-contract' && !gate.passed));
});
test('codex-model-compat-v1 excludes live model capability claims from automatic policy', () => {
  const baselines = Array.from({ length: 4 }, (_, index) =>
    withCompatibilityEvidence(makeRecord(index, false)));
  const candidates = Array.from({ length: 4 }, (_, index) => {
    const record = makeRecord(index, true);
    record.identity.model = 'gpt-5.3-codex-spark';
    return withCompatibilityEvidence(record);
  });
  const result = compareRuns(baselines, candidates, compatibilityComparisonOptions());
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.passed, true);
  assert(!result.gates.some((gate) =>
    /vision-capability|collaboration-availability|unsupported-fallback-covered/.test(gate.name)));

  const forgedLiveClaim = JSON.parse(JSON.stringify(candidates[0]));
  forgedLiveClaim.compatibility.visionSupported = true;
  assert.throws(() => validateRecordRow(forgedLiveClaim),
    /compatibility has unsupported fields: visionSupported/);
});
test('codex-model-compat-v1 requires observed identity and complete evidence metadata', () => {
  const baselines = Array.from({ length: 4 }, (_, index) =>
    withCompatibilityEvidence(makeRecord(index, false)));
  const candidates = Array.from({ length: 4 }, (_, index) => {
    const record = makeRecord(index, true);
    record.identity.model = 'gpt-5.4-mini';
    return withCompatibilityEvidence(record);
  });
  candidates[0].identityEvidence.model = {
    requested: 'gpt-5.4-mini', observed: [], source: 'requested-fallback',
  };
  let result = compareRuns(baselines, candidates, compatibilityComparisonOptions());
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.passed, false);
  assert(result.errors.some((error) => error.startsWith('candidate[0] invalid-record:')
    && error.includes('source is unsupported: requested-fallback')));
  const replacement = makeRecord(0, true);
  replacement.identity.model = 'gpt-5.4-mini';
  candidates[0] = withCompatibilityEvidence(replacement);

  const tampered = JSON.parse(JSON.stringify(candidates[2]));
  tampered.identityEvidence.model.requested = 'forged-request';
  assert.throws(() => validateRecordRow(tampered),
    /requested identity conflicts with observed identity/);

  delete candidates[1].compatibility;
  delete candidates[1].compatibilityEvidence;
  result = compareRuns(baselines, candidates, compatibilityComparisonOptions());
  assert.strictEqual(result.valid, false);
  assert(result.errors.includes('candidate[1] missing-compatibility-evidence'));
});

test('main compare returns 0 pass, 1 policy failure, and 2 invalid', () => {
  const root = tempDirectory();
  const baselinePath = path.join(root, 'baseline.json');
  const candidatePath = path.join(root, 'candidate.json');
  const outputPath = path.join(root, 'result.json');
  const baselines = Array.from({ length: 6 }, (_, index) => makeRecord(index, false));
  const candidates = Array.from({ length: 6 }, (_, index) => makeRecord(index, true));
  fs.writeFileSync(baselinePath, JSON.stringify(baselines));
  fs.writeFileSync(candidatePath, JSON.stringify(candidates));
  assert.strictEqual(main(['compare', '--baseline', baselinePath, '--candidate', candidatePath, '--out', outputPath]), 0);
  candidates[0].quality.accepted = false;
  fs.writeFileSync(candidatePath, JSON.stringify(candidates));
  assert.strictEqual(main(['compare', '--baseline', baselinePath, '--candidate', candidatePath, '--out', outputPath]), 1);
  candidates[0].identity.taskSpecHash = null;
  fs.writeFileSync(candidatePath, JSON.stringify(candidates));
  assert.strictEqual(main(['compare', '--baseline', baselinePath, '--candidate', candidatePath, '--out', outputPath]), 2);
  candidates[0] = makeRecord(0, true);
  candidates[0].rawPrompt = 'must never enter comparison output';
  fs.writeFileSync(candidatePath, JSON.stringify(candidates));
  assert.strictEqual(main(['compare', '--baseline', baselinePath, '--candidate', candidatePath, '--out', outputPath]), 2);
  const invalidResult = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.strictEqual(invalidResult.valid, false);
  assert(invalidResult.errors.some((error) => error.startsWith('candidate[0] invalid-record:')));
});

if (process.exitCode) {
  console.error(`model-canary: ${passed} tests passed before failure`);
} else {
  console.log(`model-canary: ${passed} tests passed`);
}
