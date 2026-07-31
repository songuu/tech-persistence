#!/usr/bin/env node

'use strict';

const assert = require('assert');
const control = require('./agent-orchestrator/native-execution-control');
const runtimeAdapters = require('./agent-orchestrator/runtime-adapters');

const observedAt = '2026-07-30T02:03:04.000Z';
let passed = 0;

function test(name, run) {
  run();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

function verifiedEvidence(providerKey) {
  const profile = require('./agent-orchestrator/provider-profiles')
    .profile({}, providerKey);
  return control.observedAdapterEvidence(providerKey, {
    runtimeObserved: Object.fromEntries(
      profile.capabilities.map((capability) => [capability, true])
    ),
    observedAt,
    source: 'test-capability-probe',
  });
}

function claudeNativeResult(overrides = {}) {
  return {
    runtime: 'claude',
    adapter: 'claude-print',
    status: 'succeeded',
    nativeAccepted: true,
    terminalEvidence: {
      observed: true,
      event: 'result',
      status: 'success',
    },
    nativeAcceptanceErrors: [],
    runtimeRefs: { sessionId: 'session-1' },
    ...overrides,
  };
}

test('defaults preserve the current claude-print to codex-exec path', () => {
  assert.strictEqual(control.orchestrationOwner({}), 'tp');
  assert.strictEqual(control.capabilityRouterMode({}), 'shadow');
  assert.deepStrictEqual(control.adapterPolicy({}), {
    claude: 'print',
    codex: 'exec',
  });
});

test('explicit native adapter policy is validated', () => {
  assert.deepStrictEqual(control.adapterPolicy({
    'claude-adapter': 'bare',
    'codex-adapter': 'app-server',
    'allow-experimental-app-server': true,
  }), { claude: 'bare', codex: 'app-server' });
  assert.throws(() => control.adapterPolicy({
    'codex-adapter': 'app-server',
  }), /explicit opt-in/);
  assert.throws(() => control.orchestrationOwner({
    'orchestration-owner': 'nested-owner',
  }), /orchestration owner/);
});

test('stage control selects exactly one observed writer', () => {
  const stage = control.buildStageControl({
    options: {
      'orchestration-owner': 'codex-host',
      'claude-adapter': 'bare',
      'codex-adapter': 'exec',
    },
    runId: 'run-1',
    stage: 'implementation',
    providerKey: 'implementation',
    intent: 'write',
    payload: { promptHash: `sha256:${'a'.repeat(64)}` },
    capabilityEvidence: verifiedEvidence('implementation'),
  });
  assert.strictEqual(stage.task.orchestrationOwner, 'codex-host');
  assert.strictEqual(stage.route.status, 'selected');
  assert.strictEqual(stage.route.writer.candidateRef, stage.providerRef);
  assert.strictEqual(stage.route.fallbacks.length, 0);
  assert.strictEqual(stage.capabilitySnapshot.adapter, 'codex-exec');
});

test('unknown runtime evidence remains blocked rather than assumed true', () => {
  const stage = control.buildStageControl({
    options: {},
    runId: 'run-2',
    stage: 'review',
    providerKey: 'review',
    intent: 'read-only',
    payload: {},
  });
  assert.strictEqual(stage.route.status, 'blocked');
  assert.deepStrictEqual(stage.capabilitySnapshot.effectiveCapabilities, []);
});

test('provider availability timestamp alone is not capability probe evidence', () => {
  const evidence = control.observedAdapterEvidence('implementation', observedAt);
  assert(Object.values(evidence.runtimeObserved).every(
    (observation) => observation === 'unknown'
  ));
  assert.strictEqual(evidence.observedAt, null);
});

test('result acceptance is hash-bound and rejects partial effects', () => {
  const stage = control.buildStageControl({
    options: {},
    runId: 'run-3',
    stage: 'spec',
    providerKey: 'spec',
    intent: 'read-only',
    payload: {},
    capabilityEvidence: verifiedEvidence('spec'),
  });
  const accepted = control.createAttemptResult({
    stageControl: stage,
    ref: 'result:run-3:spec:1',
    status: 'succeeded',
    effects: { state: 'none', refs: [] },
    runtimeRefs: { claudeSession: 'session-1' },
    evidence: {},
    payload: { ok: true },
    nativeResult: claudeNativeResult(),
  });
  assert.strictEqual(accepted.acceptance.accepted, true);
  assert.strictEqual(accepted.acceptance.fallbackAllowed, false);

  const partial = control.createAttemptResult({
    stageControl: stage,
    ref: 'result:run-3:spec:2',
    status: 'failed',
    effects: { state: 'partial', refs: [`sha256:${'b'.repeat(64)}`] },
    runtimeRefs: {},
    evidence: {},
    payload: {},
    nativeResult: claudeNativeResult(),
  });
  assert.strictEqual(partial.acceptance.accepted, false);
  assert.strictEqual(partial.acceptance.fallbackAllowed, false);

  const missingNativeTerminal = control.createAttemptResult({
    stageControl: stage,
    ref: 'result:run-3:spec:3',
    status: 'succeeded',
    effects: { state: 'none', refs: [] },
    runtimeRefs: { claudeSession: 'session-1' },
    evidence: {},
    payload: { ok: true },
    nativeResult: claudeNativeResult({
      nativeAccepted: false,
      terminalEvidence: { observed: false, event: null, status: null },
      nativeAcceptanceErrors: ['claude terminal result event is missing'],
    }),
  });
  assert.strictEqual(missingNativeTerminal.acceptance.accepted, false);
  assert(missingNativeTerminal.acceptance.errors.includes(
    'native runtime result was not accepted'
  ));

  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
  const redacted = control.createAttemptResult({
    stageControl: stage,
    ref: 'result:run-3:spec:4',
    status: 'succeeded',
    effects: { state: 'none', refs: [] },
    runtimeRefs: { claudeSession: 'session-1' },
    evidence: { providerMessage: `api_key=${secret}` },
    payload: { nested: { token: secret } },
    nativeResult: claudeNativeResult(),
  });
  assert.strictEqual(redacted.acceptance.accepted, true);
  assert(!JSON.stringify(redacted.result).includes(secret));
  assert.strictEqual(redacted.result.payload.nested.token, '[REDACTED]');
  assert.strictEqual(
    redacted.result.evidence.providerMessage,
    'api_key=[REDACTED]'
  );
});

test('official Codex JSONL terminal sample is accepted without a turn id', () => {
  const stage = control.buildStageControl({
    options: {},
    runId: 'run-codex-official-jsonl',
    stage: 'implementation',
    providerKey: 'implementation',
    intent: 'write',
    payload: {},
    capabilityEvidence: verifiedEvidence('implementation'),
  });
  const nativeResult = runtimeAdapters.normalizeCodexOutput({
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-official' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n'),
    lastMessage: JSON.stringify({ summary: 'done' }),
  });
  const accepted = control.createAttemptResult({
    stageControl: stage,
    ref: 'result:run-codex-official-jsonl:implementation:1',
    status: nativeResult.status,
    effects: { state: 'committed', refs: [`sha256:${'d'.repeat(64)}`] },
    runtimeRefs: { codexThread: nativeResult.runtimeRefs.threadId },
    evidence: {},
    payload: nativeResult.payload,
    nativeResult,
  });
  assert.strictEqual(nativeResult.runtimeRefs.turnId, null);
  assert.strictEqual(accepted.acceptance.accepted, true);
});

test('execution plan v2 carries owner, policies, snapshots, and routes', () => {
  const plan = control.buildExecutionPlan({
    options: {
      'orchestration-owner': 'claude-host',
      'capability-router': 'shadow',
      'claude-adapter': 'bare',
      'codex-adapter': 'exec',
    },
    runId: 'run-plan',
    requirementHash: `sha256:${'c'.repeat(64)}`,
    observedAt,
    capabilityEvidenceByProvider: {
      spec: verifiedEvidence('spec'),
      implementation: verifiedEvidence('implementation'),
      review: verifiedEvidence('review'),
    },
  });
  assert.strictEqual(plan.version, 'execution-plan-v2');
  assert.strictEqual(plan.orchestrationOwner, 'claude-host');
  assert.deepStrictEqual(plan.adapterPolicy, { claude: 'bare', codex: 'exec' });
  assert.strictEqual(plan.capabilityRouter.mode, 'shadow');
  assert.strictEqual(plan.stages.spec.routeDecision.status, 'selected');
  assert.strictEqual(plan.stages.implementation.routeDecision.writer.access, 'write');
  assert.strictEqual(plan.stages.review.routeDecision.primary.access, 'read-only');
});

test('shadow execution plan records unknown capability routes without changing legacy mode', () => {
  const plan = control.buildExecutionPlan({
    options: {},
    runId: 'run-shadow-unknown',
    requirementHash: `sha256:${'d'.repeat(64)}`,
  });
  assert.strictEqual(plan.capabilityRouter.mode, 'shadow');
  assert.strictEqual(plan.stages.spec.routeDecision.status, 'blocked');
  assert.deepStrictEqual(
    plan.stages.spec.capabilities.effectiveCapabilities,
    []
  );
});

console.log(`native-execution-control: ${passed} passed`);
