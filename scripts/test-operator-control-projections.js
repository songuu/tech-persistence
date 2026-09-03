#!/usr/bin/env node

'use strict';

const assert = require('assert');
const path = require('path');
const structuredOutput = require('./agent-orchestrator/structured-output');
const {
  buildOperatorReviewPacket,
  MAX_EVIDENCE_REFS,
  MAX_EVIDENCE_REF_LENGTH,
  MAX_NEXT_SAFE_ACTION_LENGTH,
  MAX_REASON_LENGTH,
} = require('./agent-orchestrator/operator-review-packet');
const {
  deriveSchedulerHint,
} = require('./agent-orchestrator/scheduler-hint');

let passed = 0;

function test(name, run) {
  run();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

function frozen(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const item of Object.values(value)) frozen(item);
  return value;
}

test('runnable queue produces a deterministic non-authorizing run-now hint', () => {
  const input = frozen({
    run: { status: 'executing-slices', runId: 'run-1' },
    queue: {
      pending: [],
      ready: ['slice-b', 'slice-a'],
      running: [],
      completed: [],
      blocked: [],
      rejected: [],
      abandoned: [],
    },
  });

  const first = deriveSchedulerHint(input);
  const second = deriveSchedulerHint(input);

  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.schemaVersion, 'scheduler-hint-v1');
  assert.strictEqual(first.permission, 'none');
  assert.strictEqual(first.action, 'run-now');
  assert.match(first.reason, /ready work/i);
  assert.match(first.resetToken, /^reset:[a-f0-9]{64}$/);
  assert.strictEqual('retryAfterMs' in first, false);
});

test('terminal run stops even when stale gates or work remain', () => {
  const hint = deriveSchedulerHint({
    run: { status: 'completed' },
    queue: { ready: ['slice-stale'] },
    userGate: { status: 'open', reason: 'stale user gate' },
    evidenceWait: { status: 'waiting', retryAfterMs: 2_000 },
  });

  assert.strictEqual(hint.action, 'stop');
  assert.match(hint.reason, /terminal/i);
  assert.strictEqual('retryAfterMs' in hint, false);
  assert.strictEqual('resetToken' in hint, false);
});

test('an active user gate waits without granting work permission', () => {
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
  const hint = deriveSchedulerHint({
    run: { status: 'executing-slices' },
    queue: { ready: ['slice-1'] },
    userGate: {
      status: 'open',
      reason: `owner approval requires api_key=${secret}`,
    },
  });

  assert.strictEqual(hint.action, 'wait');
  assert.strictEqual(hint.permission, 'none');
  assert.match(hint.reason, /owner approval/);
  assert(!JSON.stringify(hint).includes(secret));
  assert(hint.reason.length <= MAX_REASON_LENGTH);
});

test('an evidence wait backs off with a bounded stable retry contract', () => {
  const input = {
    run: { status: 'executing-slices' },
    queue: { ready: ['slice-1'] },
    evidenceWait: {
      status: 'waiting',
      reason: 'CI result has not reached a terminal state',
      retryAfterMs: 4_000,
      ref: 'ci:build:17',
    },
  };
  const first = deriveSchedulerHint(input);
  const changed = deriveSchedulerHint({
    ...input,
    evidenceWait: { ...input.evidenceWait, ref: 'ci:build:18' },
  });

  assert.strictEqual(first.action, 'backoff');
  assert.strictEqual(first.retryAfterMs, 4_000);
  assert.match(first.resetToken, /^reset:[a-f0-9]{64}$/);
  assert.notStrictEqual(first.resetToken, changed.resetToken);
});

test('blocked and empty active queues fail closed into wait or backoff', () => {
  const blocked = deriveSchedulerHint({
    run: { status: 'executing-slices' },
    queue: {
      blocked: [{ sliceId: 'slice-1', reason: 'owned file is claimed' }],
    },
  });
  assert.strictEqual(blocked.action, 'wait');
  assert.match(blocked.reason, /blocked/i);

  const idle = deriveSchedulerHint({
    run: { status: 'executing-slices' },
    queue: {},
  });
  assert.strictEqual(idle.action, 'backoff');
  assert.strictEqual(idle.retryAfterMs, 60_000);
});

test('operator packet is bounded, public-safe, and contains only derived fields', () => {
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
  const evidenceRefs = [
    'validation.json',
    'result:accepted:1',
    'validation.json',
    ...Array.from({ length: 12 }, (_, index) =>
      `evidence:${String(index).padStart(2, '0')}:${'x'.repeat(400)}`),
    `api_key=${secret}`,
  ];
  const input = frozen({
    run: { status: 'executing-slices', runId: 'run-1' },
    queue: { ready: ['slice-1'] },
    decision: 'continue-bounded-work',
    reason: `validated result; token=${secret}; ${'r'.repeat(500)}`,
    evidenceRefs,
    freshness: {
      status: 'fresh',
      observedAt: '2026-08-04T01:02:03.000Z',
      source: `status api_key=${secret}`,
      stale: false,
      ignoredPrivatePayload: secret,
    },
    boundary: {
      intent: 'read-only',
      writeAllowed: false,
      requiresApproval: true,
      scopes: ['scripts/agent-orchestrator/', 'scripts/agent-orchestrator/'],
      reason: `scope gate api_key=${secret}`,
      ignoredAuthority: 'never-copy-arbitrary-fields',
    },
    nextSafeAction: `inspect accepted evidence, then continue ${secret} ${'a'.repeat(500)}`,
  });

  const first = buildOperatorReviewPacket(input);
  const second = buildOperatorReviewPacket(input);

  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(Object.keys(first).sort(), [
    'boundary',
    'decision',
    'evidenceLayers',
    'evidenceRefs',
    'freshness',
    'nextSafeAction',
    'permission',
    'reason',
    'schedulerHint',
    'schemaVersion',
  ].sort());
  assert.strictEqual(first.schemaVersion, 'operator-review-packet-v1');
  assert.strictEqual(first.permission, 'none');
  assert.strictEqual(first.schedulerHint.permission, 'none');
  assert.strictEqual(first.schedulerHint.action, 'run-now');
  assert.strictEqual(first.evidenceRefs.length, MAX_EVIDENCE_REFS);
  assert.deepStrictEqual(first.evidenceRefs, [...first.evidenceRefs].sort());
  assert.deepStrictEqual(Object.keys(first.evidenceLayers).sort(), [
    'artifact', 'local', 'production', 'runtime', 'user',
  ]);
  assert(Object.values(first.evidenceLayers).every(Array.isArray));
  assert.strictEqual(new Set(first.evidenceRefs).size, first.evidenceRefs.length);
  assert(first.evidenceRefs.every((ref) => ref.length <= MAX_EVIDENCE_REF_LENGTH));
  assert(first.reason.length <= MAX_REASON_LENGTH);
  assert(first.nextSafeAction.length <= MAX_NEXT_SAFE_ACTION_LENGTH);
  assert.deepStrictEqual(Object.keys(first.freshness).sort(), [
    'observedAt', 'source', 'stale', 'status',
  ]);
  assert.deepStrictEqual(Object.keys(first.boundary).sort(), [
    'intent', 'reason', 'requiresApproval', 'scopes', 'writeAllowed',
  ]);
  assert(!JSON.stringify(first).includes(secret));
  assert.strictEqual(input.boundary.ignoredAuthority, 'never-copy-arbitrary-fields');
});

test('packet derives conservative defaults instead of inventing authority', () => {
  const packet = buildOperatorReviewPacket({
    run: { status: 'spec-ready' },
    queue: {},
  });

  assert.strictEqual(packet.decision, 'wait');
  assert.strictEqual(packet.permission, 'none');
  assert.strictEqual(packet.boundary.writeAllowed, false);
  assert.strictEqual(packet.boundary.requiresApproval, true);
  assert.strictEqual(packet.schedulerHint.action, 'wait');
  assert.match(packet.nextSafeAction, /existing gate/i);
});

test('public control projections satisfy strict versioned schemas', () => {
  const schemaRoot = path.resolve(__dirname, '..', 'schemas', 'agent-loop');
  const hint = deriveSchedulerHint({
    run: { status: 'completed', runId: 'run-schema' },
    queue: {},
  });
  const packet = buildOperatorReviewPacket({
    run: { status: 'completed', runId: 'run-schema' },
    queue: {},
  });

  structuredOutput.assertStructuredOutput(hint, {
    schemaRoot,
    schemaName: 'scheduler-hint.schema.json',
    label: 'scheduler hint',
  });
  structuredOutput.assertStructuredOutput(packet, {
    schemaRoot,
    schemaName: 'operator-review-packet.schema.json',
    label: 'operator review packet',
  });
  assert.throws(() => structuredOutput.assertStructuredOutput(
    { ...packet, unexpectedAuthority: true },
    {
      schemaRoot,
      schemaName: 'operator-review-packet.schema.json',
      label: 'operator review packet',
    }
  ), /additional property unexpectedAuthority/);
});

console.log(`operator-control-projections: ${passed} passed`);
