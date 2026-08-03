#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const profiles = require('./agent-orchestrator/provider-profiles');
const {
  createCapabilitySnapshot,
} = require('./agent-orchestrator/runtime-capabilities');
const {
  decideRoute,
  hashRouteDecision,
} = require('./agent-orchestrator/capability-router');
const {
  createAgentAssignment,
  createAgentInvocation,
  validateAgentInvocation,
  createProviderHandoff,
  createResultEnvelope,
  createTaskEnvelope,
  deriveIdempotencyKey,
  validateResultForAcceptance,
} = require('./agent-orchestrator/execution-envelopes');

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

function capabilityInput(overrides = {}) {
  return {
    runtime: 'codex',
    profileId: 'implementation-coding-v1',
    adapter: 'codex-exec',
    declaredCapabilities: [
      'workspace-write',
      'repo-read',
      'subagents',
      'app-server',
    ],
    documentedMaturity: {
      'app-server': 'experimental',
      'repo-read': 'stable',
      subagents: 'stable',
      'workspace-write': 'stable',
    },
    runtimeObserved: {
      'app-server': false,
      'repo-read': true,
      subagents: 'unknown',
      'workspace-write': true,
    },
    probeError: 'app-server probe unavailable',
    observedAt: '2026-07-30T01:02:03.000Z',
    policy: {
      allowedCapabilities: [
        'repo-read',
        'subagents',
        'workspace-write',
      ],
    },
    ...overrides,
  };
}

function codexSnapshot() {
  return createCapabilitySnapshot(capabilityInput());
}

function claudeSnapshot(overrides = {}) {
  return createCapabilitySnapshot({
    runtime: 'claude',
    profileId: 'review-independent-v1',
    adapter: 'claude-print',
    declaredCapabilities: [
      'repo-read',
      'structured-output',
      'workspace-write',
    ],
    documentedMaturity: 'stable',
    runtimeObserved: {
      'repo-read': true,
      'structured-output': true,
      'workspace-write': true,
    },
    probeError: null,
    observedAt: '2026-07-30T01:02:04.000Z',
    policy: {
      deniedCapabilities: ['workspace-write'],
    },
    ...overrides,
  });
}

function routeTask(overrides = {}) {
  return {
    ref: 'task:dual-native:1',
    hash: `sha256:${'1'.repeat(64)}`,
    orchestrationOwner: 'tp',
    intent: 'write',
    requiredCapabilities: ['repo-read'],
    effectsState: 'none',
    ...overrides,
  };
}

function routeCandidates() {
  return [
    {
      ref: 'claude-review',
      providerKey: 'review',
      priority: 20,
      snapshot: claudeSnapshot(),
    },
    {
      ref: 'codex-writer',
      providerKey: 'implementation',
      priority: 10,
      snapshot: codexSnapshot(),
    },
  ];
}

test('effective capabilities are declared intersect observed true intersect policy', () => {
  const snapshot = codexSnapshot();
  assert.deepStrictEqual(snapshot.declaredCapabilities, [
    'app-server',
    'repo-read',
    'subagents',
    'workspace-write',
  ]);
  assert.deepStrictEqual(snapshot.effectiveCapabilities, [
    'repo-read',
    'workspace-write',
  ]);
  assert.strictEqual(snapshot.documentedMaturity['app-server'], 'experimental');
  assert.strictEqual(snapshot.runtimeObserved.subagents, 'unknown');
  assert.strictEqual(snapshot.probeError, 'app-server probe unavailable');
  assert.strictEqual(snapshot.observedAt, '2026-07-30T01:02:03.000Z');
  assert.match(snapshot.snapshotHash, /^sha256:[a-f0-9]{64}$/);
});

test('unknown observation and policy allow never grant a capability', () => {
  const snapshot = createCapabilitySnapshot(capabilityInput({
    runtimeObserved: {
      'app-server': 'unknown',
      'repo-read': 'unknown',
      subagents: 'unknown',
      'workspace-write': 'unknown',
    },
    observedAt: null,
    probeError: null,
    policy: {
      allowedCapabilities: [
        'app-server',
        'repo-read',
        'subagents',
        'workspace-write',
      ],
    },
  }));
  assert.deepStrictEqual(snapshot.effectiveCapabilities, []);
});

test('real observations require provenance time', () => {
  assert.throws(
    () => createCapabilitySnapshot(capabilityInput({ observedAt: null })),
    /observedAt/
  );
});

test('capability snapshot hash ignores object and array insertion order', () => {
  const left = codexSnapshot();
  const right = createCapabilitySnapshot(capabilityInput({
    declaredCapabilities: [
      'app-server',
      'subagents',
      'repo-read',
      'workspace-write',
    ],
    runtimeObserved: {
      'workspace-write': true,
      subagents: 'unknown',
      'repo-read': true,
      'app-server': false,
    },
  }));
  assert.strictEqual(left.snapshotHash, right.snapshotHash);
});

test('write route has exactly one writer and read-only fallbacks', () => {
  const decision = decideRoute({
    task: routeTask(),
    candidates: routeCandidates(),
    policy: { allowReadOnlyFallback: true },
  });
  assert.strictEqual(decision.status, 'selected');
  assert.strictEqual(decision.primary.candidateRef, 'codex-writer');
  assert.strictEqual(decision.primary.access, 'write');
  assert.strictEqual(decision.writer.candidateRef, 'codex-writer');
  assert.strictEqual(decision.fallbacks.length, 1);
  assert.strictEqual(decision.fallbacks[0].candidateRef, 'claude-review');
  assert.strictEqual(decision.fallbacks[0].access, 'read-only');
  assert.strictEqual(decision.orchestrationOwner, 'tp');
  assert.match(decision.decisionHash, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(hashRouteDecision(decision), decision.decisionHash);
});

test('route decision is deterministic across candidate order', () => {
  const candidates = routeCandidates();
  const left = decideRoute({
    task: routeTask(),
    candidates,
    policy: { allowReadOnlyFallback: true },
  });
  const right = decideRoute({
    task: routeTask(),
    candidates: [...candidates].reverse(),
    policy: { allowReadOnlyFallback: true },
  });
  assert.deepStrictEqual(left, right);
});

test('partial effects block provider switching and all fallback', () => {
  const decision = decideRoute({
    task: routeTask({ effectsState: 'partial' }),
    candidates: routeCandidates(),
    policy: { allowReadOnlyFallback: true },
  });
  assert.strictEqual(decision.status, 'blocked');
  assert.strictEqual(decision.primary, null);
  assert.strictEqual(decision.writer, null);
  assert.deepStrictEqual(decision.fallbacks, []);
  assert.strictEqual(decision.fallbackPolicy.allowed, false);
  assert.strictEqual(decision.fallbackPolicy.reason, 'partial-effects');
});

test('partial effects may only resume the same explicit writer', () => {
  const decision = decideRoute({
    task: routeTask({
      effectsState: 'partial',
      resumeProviderRef: 'codex-writer',
    }),
    candidates: routeCandidates(),
    policy: { allowReadOnlyFallback: true },
  });
  assert.strictEqual(decision.status, 'selected');
  assert.strictEqual(decision.primary.candidateRef, 'codex-writer');
  assert.strictEqual(decision.primary.access, 'write');
  assert.deepStrictEqual(decision.fallbacks, []);
  assert.strictEqual(decision.fallbackPolicy.reason, 'partial-effects');
});

test('committed effects cannot be executed again even by the same writer', () => {
  const decision = decideRoute({
    task: routeTask({
      effectsState: 'committed',
      resumeProviderRef: 'codex-writer',
    }),
    candidates: routeCandidates(),
    policy: { allowReadOnlyFallback: true },
  });
  assert.strictEqual(decision.status, 'blocked');
  assert.strictEqual(decision.primary, null);
  assert.strictEqual(decision.writer, null);
  assert.deepStrictEqual(decision.fallbacks, []);
});

test('only declared orchestration owners are accepted', () => {
  for (const owner of ['tp', 'codex-host', 'claude-host']) {
    assert.doesNotThrow(() => decideRoute({
      task: routeTask({ orchestrationOwner: owner }),
      candidates: routeCandidates(),
      policy: {},
    }));
  }
  assert.throws(() => decideRoute({
    task: routeTask({ orchestrationOwner: 'nested-fourth-runtime' }),
    candidates: routeCandidates(),
    policy: {},
  }), /orchestrationOwner/);
});

test('task, result, and handoff envelopes bind refs, hashes, and runtime refs', () => {
  const task = createTaskEnvelope({
    ref: 'task:dual-native:1',
    orchestrationOwner: 'tp',
    intent: 'write',
    requiredCapabilities: ['repo-read', 'workspace-write'],
    runtimeRefs: {
      codexThread: 'thread-1',
      claudeSession: null,
    },
    payload: {
      contractHash: `sha256:${'a'.repeat(64)}`,
      requirement: 'implement bounded native routing',
    },
  });
  const route = decideRoute({
    task,
    candidates: routeCandidates(),
    policy: { allowReadOnlyFallback: true },
  });
  const result = createResultEnvelope({
    ref: 'result:dual-native:1',
    task,
    route,
    providerRef: 'codex-writer',
    status: 'succeeded',
    effects: {
      state: 'committed',
      refs: [`sha256:${'b'.repeat(64)}`],
    },
    runtimeRefs: {
      codexThread: 'thread-1',
      codexTurn: 'turn-1',
    },
    evidence: {
      validationHash: `sha256:${'c'.repeat(64)}`,
    },
    payload: { summary: 'done' },
  });
  const handoff = createProviderHandoff({
    ref: 'handoff:dual-native:1',
    task,
    route,
    result,
    from: 'codex-writer',
    to: 'claude-review',
    readOnly: true,
    runtimeRefs: {
      codexThread: 'thread-1',
      claudeSession: 'session-1',
    },
  });

  for (const envelope of [task, result, handoff]) {
    assert.match(envelope.idempotencyKey, /^idem:[a-f0-9]{64}$/);
    assert.match(envelope.hash, /^sha256:[a-f0-9]{64}$/);
    assert.strictEqual(typeof envelope.ref, 'string');
    assert.strictEqual(typeof envelope.runtimeRefs, 'object');
  }
  assert.strictEqual(result.taskRef, task.ref);
  assert.strictEqual(result.taskHash, task.hash);
  assert.strictEqual(result.routeHash, route.decisionHash);
  assert.strictEqual(result.taskIdempotencyKey, task.idempotencyKey);
  assert.strictEqual(handoff.taskHash, task.hash);
  assert.strictEqual(handoff.resultHash, result.hash);
  assert.strictEqual(handoff.routeHash, route.decisionHash);
  assert.strictEqual(handoff.readOnly, true);

  const acceptance = validateResultForAcceptance(task, result, route);
  assert.deepStrictEqual(acceptance, {
    accepted: true,
    errors: [],
    fallbackAllowed: false,
  });
});

test('envelope and idempotency hashes are canonical', () => {
  const input = {
    ref: 'task:canonical',
    orchestrationOwner: 'claude-host',
    intent: 'read-only',
    requiredCapabilities: ['structured-output', 'repo-read'],
    runtimeRefs: { z: 'last', a: 'first' },
    payload: { z: 2, a: 1 },
  };
  const left = createTaskEnvelope(input);
  const right = createTaskEnvelope({
    ...input,
    requiredCapabilities: ['repo-read', 'structured-output'],
    runtimeRefs: { a: 'first', z: 'last' },
    payload: { a: 1, z: 2 },
  });
  assert.deepStrictEqual(left, right);
  assert.strictEqual(
    deriveIdempotencyKey({ b: 2, a: 1 }),
    deriveIdempotencyKey({ a: 1, b: 2 })
  );
});

test('agent assignment and invocation bind scope, role, and native proof', () => {
  const task = createTaskEnvelope({
    ref: 'task:agent-assignment',
    orchestrationOwner: 'tp',
    intent: 'write',
    requiredCapabilities: ['repo-read', 'workspace-write'],
    runtimeRefs: {},
    payload: {},
  });
  const assignment = createAgentAssignment({
    ref: 'assignment:agent-assignment',
    task,
    sliceRef: 'slice:agent-assignment',
    role: 'tp_implementer',
    intent: 'write',
    ownedFiles: ['scripts/agent-orchestrator/execution-envelopes.js'],
    readFiles: ['scripts/test-runtime-capability-router.js'],
    workspaceMode: 'isolated',
    worktreeRef: 'worktree:assignment-test',
    enforcement: 'native-enforced',
    requiredCapabilities: ['workspace-write'],
  });
  const invocation = createAgentInvocation({
    ref: 'invocation:agent-assignment:1',
    assignment,
    runtime: 'codex',
    adapter: 'codex-app-server',
    enforcement: 'native-enforced',
    status: 'completed',
    actualRole: 'tp_implementer',
    runtimeRefs: { codexThread: 'thread-assignment' },
    native: {
      nativeAccepted: true,
      terminalEvent: 'turn.completed',
      terminalStatus: 'completed',
      acceptanceErrors: [],
    },
  });

  assert.match(assignment.hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(invocation.hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepStrictEqual(validateAgentInvocation(assignment, invocation), {
    accepted: true,
    errors: [],
  });
  assert.throws(() => createAgentAssignment({
    ref: 'assignment:invalid-reviewer-write',
    task,
    sliceRef: 'slice:invalid-reviewer-write',
    role: 'tp_reviewer',
    intent: 'write',
    ownedFiles: ['x.js'],
    enforcement: 'contract-enforced',
  }), /read-only/);
  assert.throws(() => createAgentInvocation({
    ref: 'invocation:missing-native-proof',
    assignment,
    runtime: 'codex',
    adapter: 'codex-app-server',
    enforcement: 'native-enforced',
    status: 'completed',
    actualRole: null,
    runtimeRefs: { codexThread: 'thread-assignment' },
    native: {
      nativeAccepted: false,
      terminalEvent: null,
      terminalStatus: null,
      acceptanceErrors: ['target role unavailable'],
    },
  }), /actualRole/);
});

test('failed no-effect result permits only the routed read-only fallback', () => {
  const task = createTaskEnvelope({
    ref: 'task:fallback',
    orchestrationOwner: 'codex-host',
    intent: 'write',
    requiredCapabilities: ['repo-read', 'workspace-write'],
    runtimeRefs: {},
    payload: {},
  });
  const route = decideRoute({
    task,
    candidates: routeCandidates(),
    policy: { allowReadOnlyFallback: true },
  });
  const result = createResultEnvelope({
    ref: 'result:fallback',
    task,
    route,
    providerRef: 'codex-writer',
    status: 'failed',
    effects: { state: 'none', refs: [] },
    runtimeRefs: {},
    evidence: {},
    payload: {},
  });
  const acceptance = validateResultForAcceptance(task, result, route);
  assert.strictEqual(acceptance.accepted, false);
  assert(acceptance.errors.includes('result status is failed'));
  assert.strictEqual(acceptance.fallbackAllowed, true);
  assert(route.fallbacks.every((fallback) => fallback.access === 'read-only'));
});

test('partial-effect result can never fall back', () => {
  const task = createTaskEnvelope({
    ref: 'task:partial-result',
    orchestrationOwner: 'codex-host',
    intent: 'write',
    requiredCapabilities: ['repo-read', 'workspace-write'],
    runtimeRefs: {},
    payload: {},
  });
  const route = decideRoute({
    task,
    candidates: routeCandidates(),
    policy: { allowReadOnlyFallback: true },
  });
  const result = createResultEnvelope({
    ref: 'result:partial-result',
    task,
    route,
    providerRef: 'codex-writer',
    status: 'failed',
    effects: {
      state: 'partial',
      refs: [`sha256:${'d'.repeat(64)}`],
    },
    runtimeRefs: {},
    evidence: {},
    payload: {},
  });
  const acceptance = validateResultForAcceptance(task, result, route);
  assert.strictEqual(acceptance.accepted, false);
  assert(acceptance.errors.includes('result has partial effects'));
  assert.strictEqual(acceptance.fallbackAllowed, false);
});

test('handoff cannot turn a fallback into a writer or switch after partial effects', () => {
  const task = createTaskEnvelope({
    ref: 'task:handoff-guard',
    orchestrationOwner: 'tp',
    intent: 'write',
    requiredCapabilities: ['repo-read', 'workspace-write'],
    runtimeRefs: {},
    payload: {},
  });
  const route = decideRoute({
    task,
    candidates: routeCandidates(),
    policy: { allowReadOnlyFallback: true },
  });
  const noEffectResult = createResultEnvelope({
    ref: 'result:handoff-guard:none',
    task,
    route,
    providerRef: 'codex-writer',
    status: 'failed',
    effects: { state: 'none', refs: [] },
    runtimeRefs: {},
    evidence: {},
    payload: {},
  });
  assert.throws(() => createProviderHandoff({
    ref: 'handoff:illegal-writer',
    task,
    route,
    result: noEffectResult,
    from: 'codex-writer',
    to: 'claude-review',
    readOnly: false,
    runtimeRefs: {},
  }), /read-only/);

  const partialResult = createResultEnvelope({
    ref: 'result:handoff-guard:partial',
    task,
    route,
    providerRef: 'codex-writer',
    status: 'failed',
    effects: {
      state: 'partial',
      refs: [`sha256:${'e'.repeat(64)}`],
    },
    runtimeRefs: {},
    evidence: {},
    payload: {},
  });
  assert.throws(() => createProviderHandoff({
    ref: 'handoff:illegal-partial-switch',
    task,
    route,
    result: partialResult,
    from: 'codex-writer',
    to: 'claude-review',
    readOnly: true,
    runtimeRefs: {},
  }), /partial effects/);
});

test('acceptance rejects envelopes mutated after hashing', () => {
  const task = createTaskEnvelope({
    ref: 'task:tamper',
    orchestrationOwner: 'tp',
    intent: 'write',
    requiredCapabilities: ['repo-read', 'workspace-write'],
    runtimeRefs: {},
    payload: {},
  });
  const route = decideRoute({
    task,
    candidates: routeCandidates(),
    policy: { allowReadOnlyFallback: true },
  });
  const result = createResultEnvelope({
    ref: 'result:tamper',
    task,
    route,
    providerRef: 'codex-writer',
    status: 'succeeded',
    effects: { state: 'committed', refs: [`sha256:${'f'.repeat(64)}`] },
    runtimeRefs: {},
    evidence: {},
    payload: { summary: 'original' },
  });
  result.payload.summary = 'tampered';
  const acceptance = validateResultForAcceptance(task, result, route);
  assert.strictEqual(acceptance.accepted, false);
  assert(acceptance.errors.includes('result content hash does not match'));
  assert.strictEqual(acceptance.fallbackAllowed, false);
});

test('legacy provider profile API remains available without granting unknown runtime capabilities', () => {
  assert.strictEqual(
    profiles.profileId({}, 'implementation'),
    'implementation-coding-v1'
  );
  assert.strictEqual(
    profiles.profile({}, 'review').adapter,
    'claude-print'
  );
  const snapshot = profiles.capabilitySnapshot({}, 'review');
  assert.deepStrictEqual(snapshot.capabilities, [
    'stdin', 'structured-output', 'repo-read',
  ]);
  assert.deepStrictEqual(snapshot.effectiveCapabilities, []);
  assert.strictEqual(snapshot.runtimeObserved['structured-output'], 'unknown');
  assert.strictEqual(snapshot.source, 'static-profile');
  assert.strictEqual(snapshot.observedAt, null);
  assert.strictEqual(Number.isNaN(Date.parse(snapshot.verifiedAt)), false);
  const observed = profiles.capabilitySnapshot({}, 'review', {
    runtimeObserved: {
      stdin: true,
      'structured-output': true,
      'repo-read': true,
    },
    observedAt: '2026-07-30T02:03:04.000Z',
  });
  assert.strictEqual(observed.source, 'runtime-probe');
  assert.deepStrictEqual(observed.effectiveCapabilities, [
    'repo-read', 'stdin', 'structured-output',
  ]);
  assert.notStrictEqual(profiles.hash({ a: 1 }), profiles.hash({ a: 2 }));
});

test('new JSON schemas expose strict versioned contract fields', () => {
  const schemaDir = path.resolve(__dirname, '..', 'schemas', 'agent-loop');
  const expectations = {
    'task-envelope.schema.json': [
      'schemaVersion', 'kind', 'ref', 'hash', 'idempotencyKey', 'runtimeRefs',
      'orchestrationOwner',
    ],
    'result-envelope.schema.json': [
      'schemaVersion', 'kind', 'ref', 'hash', 'idempotencyKey', 'runtimeRefs',
      'taskRef', 'taskHash', 'routeHash',
    ],
    'provider-handoff.schema.json': [
      'schemaVersion', 'kind', 'ref', 'hash', 'idempotencyKey', 'runtimeRefs',
      'taskHash', 'resultHash', 'routeHash',
    ],
    'runtime-capability-snapshot.schema.json': [
      'schemaVersion', 'runtime', 'declaredCapabilities',
      'documentedMaturity', 'runtimeObserved', 'probeError', 'observedAt',
      'effectiveCapabilities', 'snapshotHash',
    ],
    'route-decision.schema.json': [
      'schemaVersion', 'taskRef', 'taskHash', 'orchestrationOwner', 'status',
      'primary', 'writer', 'fallbacks', 'fallbackPolicy', 'decisionHash',
    ],
    'agent-assignment.schema.json': [
      'schemaVersion', 'kind', 'ref', 'hash', 'idempotencyKey', 'taskRef',
      'taskHash', 'sliceRef', 'role', 'intent', 'ownedFiles', 'readFiles',
      'workspaceMode', 'worktreeRef', 'enforcement', 'requiredCapabilities',
    ],
    'agent-invocation.schema.json': [
      'schemaVersion', 'kind', 'ref', 'hash', 'idempotencyKey', 'assignmentRef',
      'assignmentHash', 'runtime', 'adapter', 'enforcement', 'status',
      'actualRole', 'runtimeRefs', 'native',
    ],
  };
  for (const [name, required] of Object.entries(expectations)) {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, name), 'utf8'));
    assert.strictEqual(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.strictEqual(schema.additionalProperties, false);
    for (const field of required) {
      assert(schema.required.includes(field), `${name} must require ${field}`);
    }
  }
});

console.log(`runtime-capability-router: ${passed} passed`);
