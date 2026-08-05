#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  decideRoute,
} = require('./agent-orchestrator/capability-router');
const {
  createTaskEnvelope,
} = require('./agent-orchestrator/execution-envelopes');
const {
  createCapabilitySnapshot,
} = require('./agent-orchestrator/runtime-capabilities');

const nativeExecutionControl = require('./agent-orchestrator/native-execution-control');
let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

function taskInput(overrides = {}) {
  return {
    ref: 'task:coordination:1',
    orchestrationOwner: 'tp',
    intent: 'write',
    requiredCapabilities: ['workspace-write', 'repo-read'],
    runtimeRefs: { codexThread: 'thread-coordination' },
    payload: { objective: 'exercise typed continuation' },
    ...overrides,
  };
}

function coordinationInput(overrides = {}) {
  return {
    taskClass: 'implementation',
    actionKind: 'modify-code',
    continuationPolicy: 'continue',
    successorRefs: ['task:coordination:next'],
    noFollowUp: false,
    ...overrides,
  };
}

function routeTask(task) {
  const snapshot = createCapabilitySnapshot({
    runtime: 'codex',
    profileId: 'coordination-test-v1',
    adapter: 'codex-exec',
    declaredCapabilities: ['repo-read', 'workspace-write'],
    documentedMaturity: 'stable',
    runtimeObserved: {
      'repo-read': true,
      'workspace-write': true,
    },
    observedAt: '2026-08-04T00:00:00.000Z',
    policy: {},
  });
  return decideRoute({
    task,
    candidates: [{
      ref: 'codex-worker',
      providerKey: 'implementation',
      priority: 10,
      snapshot,
    }],
    policy: { allowReadOnlyFallback: false },
  });
}

test('task envelopes without coordination retain their legacy shape and hashes', () => {
  const task = createTaskEnvelope({
    ref: 'task:coordination:legacy',
    orchestrationOwner: 'tp',
    intent: 'write',
    requiredCapabilities: ['workspace-write', 'repo-read'],
    runtimeRefs: { codexThread: 'thread-legacy' },
    payload: { objective: 'preserve legacy envelope' },
  });

  assert.strictEqual(Object.hasOwn(task, 'coordination'), false);
  assert.strictEqual(
    task.hash,
    'sha256:c03ad2c44927aa9c2357c378a427d7974bd0a090a938408c5318191aac7507eb'
  );
  assert.strictEqual(
    task.idempotencyKey,
    'idem:a5eaa1e45955771e26fe04e2294c7521fae74c03d4eb2e1591eb6984e30bf917'
  );
});

test('coordination is canonical and participates in task hash and idempotency', () => {
  const left = createTaskEnvelope(taskInput({
    coordination: coordinationInput({
      taskClass: ' implementation ',
      actionKind: ' modify-code ',
      successorRefs: [
        ' task:coordination:z ',
        'task:coordination:a',
        'task:coordination:z',
      ],
      claimedBy: ' agent:worker-1 ',
    }),
  }));
  const right = createTaskEnvelope(taskInput({
    coordination: coordinationInput({
      successorRefs: ['task:coordination:a', 'task:coordination:z'],
      claimedBy: 'agent:worker-1',
    }),
  }));

  assert.deepStrictEqual(left, right);
  assert.deepStrictEqual(left.coordination, {
    taskClass: 'implementation',
    actionKind: 'modify-code',
    continuationPolicy: 'continue',
    successorRefs: ['task:coordination:a', 'task:coordination:z'],
    noFollowUp: false,
    claimedBy: 'agent:worker-1',
  });


  const changedClaim = createTaskEnvelope(taskInput({
    coordination: coordinationInput({
      successorRefs: ['task:coordination:a', 'task:coordination:z'],
      claimedBy: 'agent:worker-2',
    }),
  }));
  assert.notStrictEqual(changedClaim.hash, left.hash);
  assert.notStrictEqual(changedClaim.idempotencyKey, left.idempotencyKey);
});

test('stage control carries typed coordination into its task envelope', () => {
  const coordination = coordinationInput({
    successorRefs: [],
    claimedBy: 'provider:implementation',
  });
  const stage = nativeExecutionControl.buildStageControl({
    options: {},
    orchestrationOwner: 'tp',
    runId: 'run-coordination',
    stage: 'implementation',
    taskRef: 'task:run-coordination:implementation',
    providerKey: 'implementation',
    intent: 'write',
    coordination,
    payload: { objective: 'carry coordination through stage control' },
  });

  assert.deepStrictEqual(stage.task.coordination, coordination);
  assert.strictEqual(stage.task.intent, 'write');
  assert.strictEqual(stage.route.taskHash, stage.task.hash);
});
test('coordination rejects contradictory or untyped continuation metadata', () => {
  assert.throws(() => createTaskEnvelope(taskInput({
    coordination: coordinationInput({
      noFollowUp: true,
      successorRefs: ['task:coordination:unexpected'],
    }),
  })), /noFollowUp.*successorRefs/);
  assert.throws(() => createTaskEnvelope(taskInput({
    coordination: coordinationInput({ continuationPolicy: 'retry-later' }),
  })), /continuationPolicy/);
  assert.throws(() => createTaskEnvelope(taskInput({
    coordination: coordinationInput({ noFollowUp: 'yes' }),
  })), /noFollowUp.*boolean/);
  assert.throws(() => createTaskEnvelope(taskInput({
    coordination: coordinationInput({ claimedBy: '' }),
  })), /claimedBy.*non-empty string/);
  assert.throws(() => createTaskEnvelope(taskInput({
    coordination: { ...coordinationInput(), retryCount: 1 },
  })), /coordination\.retryCount.*unsupported/);
});

test('claimedBy is visibility-only and cannot elevate route access', () => {
  const task = createTaskEnvelope(taskInput({
    intent: 'read-only',
    requiredCapabilities: ['repo-read'],
    coordination: coordinationInput({
      successorRefs: [],
      noFollowUp: true,
      claimedBy: 'agent:soft-owner',
    }),
  }));
  const route = routeTask(task);

  assert.strictEqual(task.orchestrationOwner, 'tp');
  assert.strictEqual(task.intent, 'read-only');
  assert.strictEqual(route.status, 'selected');
  assert.strictEqual(route.primary.access, 'read-only');
  assert.strictEqual(route.writer, null);
});

test('task envelope schema exposes a strict optional coordination contract', () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(
    __dirname,
    '..',
    'schemas',
    'agent-loop',
    'task-envelope.schema.json'
  ), 'utf8'));
  const coordination = schema.$defs.coordination;

  assert.strictEqual(schema.required.includes('coordination'), false);
  assert.deepStrictEqual(schema.properties.coordination, {
    $ref: '#/$defs/coordination',
  });
  assert.strictEqual(coordination.additionalProperties, false);
  assert.deepStrictEqual(
    Object.keys(coordination.properties).sort(),
    [
      'actionKind',
      'claimedBy',
      'continuationPolicy',
      'noFollowUp',
      'successorRefs',
      'taskClass',
    ]
  );
  assert.deepStrictEqual(
    [...coordination.required].sort(),
    [
      'actionKind',
      'continuationPolicy',
      'noFollowUp',
      'successorRefs',
      'taskClass',
    ]
  );
  assert.deepStrictEqual(
    coordination.properties.continuationPolicy.enum,
    ['continue', 'pause', 'stop']
  );
  assert.strictEqual(coordination.properties.successorRefs.uniqueItems, true);
  assert.match(coordination.properties.claimedBy.description, /visibility-only/i);
  assert.deepStrictEqual(coordination.allOf[0].if.properties.noFollowUp, {
    const: true,
  });
  assert.strictEqual(
    coordination.allOf[0].then.properties.successorRefs.maxItems,
    0
  );
});

console.log(`task-coordination: ${passed} passed`);
