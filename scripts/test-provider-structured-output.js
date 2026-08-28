#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const structuredOutput = require('./agent-orchestrator/structured-output');
const pipelineProviders = require('./agent-orchestrator/pipeline-providers');
const globalContract = require('./agent-orchestrator/global-contract');
const runtimeAdapters = require('./agent-orchestrator/runtime-adapters');
const { stableHash } = require('./agent-orchestrator/runtime-capabilities');

const schemaRoot = path.join(__dirname, '..', 'schemas', 'agent-loop');

const refSchemaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-structured-ref-'));
try {
  const writeRefSchema = (name, schema) => {
    fs.writeFileSync(path.join(refSchemaRoot, name), `${JSON.stringify(schema, null, 2)}\n`);
  };
  const assertRefSchemaRejects = (name, schema, value, pattern) => {
    writeRefSchema(name, schema);
    assert.throws(
      () => structuredOutput.assertStructuredOutput(value, {
        schemaRoot: refSchemaRoot,
        schemaName: name,
        label: `restricted ref ${name}`,
      }),
      pattern
    );
  };

  writeRefSchema('hash-ref.schema.json', {
    type: 'object',
    additionalProperties: false,
    required: ['hash'],
    properties: {
      hash: { $ref: '#/$defs/hash' },
    },
    $defs: {
      hash: {
        type: 'string',
        pattern: '^sha256:[a-f0-9]{64}$',
      },
    },
  });

  const validHashRef = { hash: `sha256:${'a'.repeat(64)}` };
  assert.deepStrictEqual(
    structuredOutput.assertStructuredOutput(validHashRef, {
      schemaRoot: refSchemaRoot,
      schemaName: 'hash-ref.schema.json',
      label: 'hash ref fixture',
    }),
    validHashRef
  );
  assert.throws(
    () => structuredOutput.assertStructuredOutput({ hash: 99999 }, {
      schemaRoot: refSchemaRoot,
      schemaName: 'hash-ref.schema.json',
      label: 'hash ref fixture',
    }),
    /hash ref fixture failed local schema validation.*hash/
  );

  for (const [name, ref] of [
    ['network-ref.schema.json', 'https://example.invalid/schema.json#/$defs/value'],
    ['sibling-ref.schema.json', 'other.schema.json#/$defs/value'],
    ['escape-ref.schema.json', '../outside.schema.json#/$defs/value'],
    ['absolute-ref.schema.json', 'C:\\outside.schema.json#/$defs/value'],
    ['non-def-fragment.schema.json', '#/properties/value'],
  ]) {
    assertRefSchemaRejects(name, {
      type: 'object',
      properties: { value: { $ref: ref } },
    }, {}, /only document-local #\/\$defs\//);
  }

  assertRefSchemaRejects('missing-ref.schema.json', {
    type: 'object',
    properties: { value: { $ref: '#/$defs/missing' } },
    $defs: {},
  }, {}, /does not resolve/);

  assertRefSchemaRejects('non-string-ref.schema.json', {
    type: 'object',
    properties: { value: { $ref: 7 } },
    $defs: {},
  }, {}, /\$ref must be a string/);

  assertRefSchemaRejects('cycle-ref.schema.json', {
    type: 'object',
    properties: { value: { $ref: '#/$defs/a' } },
    $defs: {
      a: { $ref: '#/$defs/b' },
      b: { $ref: '#/$defs/a' },
    },
  }, {}, /reference cycle/);

  const deepDefs = {};
  const deepRefCount = structuredOutput.MAX_REF_DEPTH + 8;
  for (let index = 0; index < deepRefCount; index += 1) {
    deepDefs[`level${index}`] = index === deepRefCount - 1
      ? { type: 'string' }
      : { $ref: `#/$defs/level${index + 1}` };
  }
  assertRefSchemaRejects('deep-ref.schema.json', {
    type: 'object',
    properties: { value: { $ref: '#/$defs/level0' } },
    $defs: deepDefs,
  }, {}, /exceeds maximum depth/);
} finally {
  fs.rmSync(refSchemaRoot, { recursive: true, force: true });
}

const validAgentInvocation = {
  schemaVersion: 'agent-invocation-v1',
  kind: 'agent-invocation',
  ref: 'invocation:test',
  hash: `sha256:${'a'.repeat(64)}`,
  idempotencyKey: `idem:${'b'.repeat(64)}`,
  assignmentRef: 'assignment:test',
  assignmentHash: `sha256:${'c'.repeat(64)}`,
  assignmentIdempotencyKey: `idem:${'d'.repeat(64)}`,
  runtime: 'codex',
  adapter: 'codex-exec',
  enforcement: 'contract-enforced',
  status: 'completed',
  actualRole: null,
  runtimeRefs: {},
  native: {
    nativeAccepted: true,
    terminalEvent: 'turn.completed',
    terminalStatus: 'completed',
    acceptanceErrors: [],
  },
};
assert.deepStrictEqual(
  structuredOutput.assertStructuredOutput(validAgentInvocation, {
    schemaRoot,
    schemaName: 'agent-invocation.schema.json',
    label: 'tracked agent invocation schema',
  }),
  validAgentInvocation
);
assert.throws(
  () => structuredOutput.assertStructuredOutput({ ...validAgentInvocation, hash: 99999 }, {
    schemaRoot,
    schemaName: 'agent-invocation.schema.json',
    label: 'tracked agent invocation schema',
  }),
  /tracked agent invocation schema failed local schema validation.*\$\.hash/
);

function validHandoff() {
  return {
    summary: 'implemented',
    changedFiles: ['src/index.js'],
    validation: ['node test.js'],
    risks: [],
    followUp: [],
  };
}

assert.deepStrictEqual(
  structuredOutput.assertStructuredOutput(validHandoff(), {
    schemaRoot,
    schemaName: 'agent-handoff.schema.json',
    label: 'classic implementation handoff',
  }),
  validHandoff()
);

assert.throws(
  () => structuredOutput.assertStructuredOutput({}, {
    schemaRoot,
    schemaName: 'agent-handoff.schema.json',
    label: 'classic implementation handoff',
  }),
  /classic implementation handoff failed local schema validation.*summary/
);

assert.throws(
  () => structuredOutput.assertStructuredOutput({ ...validHandoff(), unexpected: true }, {
    schemaRoot,
    schemaName: 'agent-handoff.schema.json',
    label: 'pipeline implementation handoff',
  }),
  /additional property unexpected/
);

const validSlice = {
  id: 'slice-001',
  title: 'bounded slice',
  dependsOn: [],
  ownedFiles: ['src/index.js'],
  readFiles: [],
  risk: 'L1',
  acceptanceCriteria: ['works'],
  doneCriteria: ['tests pass'],
  validationCommands: [],
  questions: [],
};

const batch = structuredOutput.assertStructuredOutput({ slices: [validSlice] }, {
  schemaRoot,
  schemaName: 'pipeline-slice-batch.schema.json',
  label: 'pipeline slice batch',
});
assert.strictEqual(batch.slices[0].id, 'slice-001');

assert.deepStrictEqual(
  structuredOutput.assertStructuredOutput({ slices: [] }, {
    schemaRoot,
    schemaName: 'pipeline-slice-batch.schema.json',
    label: 'pipeline slice batch',
  }),
  { slices: [] }
);

assert.throws(
  () => structuredOutput.assertStructuredOutput({}, {
    schemaRoot,
    schemaName: 'pipeline-slice-batch.schema.json',
    label: 'pipeline slice batch',
  }),
  /pipeline slice batch failed local schema validation.*slices/
);

assert.throws(
  () => structuredOutput.assertStructuredOutput({ slices: [{ ...validSlice, risk: 'L9' }] }, {
    schemaRoot,
    schemaName: 'pipeline-slice-batch.schema.json',
    label: 'pipeline slice batch',
  }),
  /slices\[0\]\.risk.*allowed values/
);

const singleSliceSchema = JSON.parse(fs.readFileSync(
  path.join(schemaRoot, 'pipeline-slice.schema.json'),
  'utf8'
));
const batchSliceSchema = JSON.parse(fs.readFileSync(
  path.join(schemaRoot, 'pipeline-slice-batch.schema.json'),
  'utf8'
)).properties.slices.items;
assert.deepStrictEqual(batchSliceSchema, {
  type: singleSliceSchema.type,
  additionalProperties: singleSliceSchema.additionalProperties,
  required: singleSliceSchema.required,
  properties: singleSliceSchema.properties,
});

assert.throws(
  () => structuredOutput.assertStructuredOutput({
    decision: 'approved',
    compliant: true,
    findings: [],
  }, {
    schemaRoot,
    schemaName: 'review-result.schema.json',
    label: 'pipeline review',
  }),
  /followUpTasks/
);

const canonicalApprovedReview = {
  decision: 'approved',
  compliant: true,
  findings: [],
  followUpTasks: [],
  contractRevisions: [],
};
assert.deepStrictEqual(
  structuredOutput.assertStructuredOutput(canonicalApprovedReview, {
    schemaRoot,
    schemaName: 'review-result.schema.json',
    label: 'pipeline review',
  }),
  canonicalApprovedReview
);

for (const invalidReview of [
  { ...canonicalApprovedReview, compliant: false },
  {
    ...canonicalApprovedReview,
    findings: [{ severity: 'P1', message: 'required behavior is missing' }],
  },
  {
    decision: 'changes_requested',
    compliant: true,
    findings: [],
    followUpTasks: ['implement required behavior'],
    contractRevisions: [],
  },
  {
    decision: 'changes_requested',
    compliant: false,
    findings: [],
    followUpTasks: [],
    contractRevisions: [{ arbitrary: true }],
  },
]) {
  assert.throws(
    () => structuredOutput.assertStructuredOutput(invalidReview, {
      schemaRoot,
      schemaName: 'review-result.schema.json',
      label: 'pipeline review',
    }),
    /pipeline review failed local schema validation/
  );
}

const pipelineRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-pipeline-invalid-handoff-'));
try {
  const frozenContract = globalContract.writeGlobalContract(pipelineRunDir, {
    version: 'global-v1',
    goal: 'reject empty pipeline handoff',
    nonGoals: [],
    globalAcceptance: ['empty handoff is rejected'],
    architectureConstraints: [],
    runtimeTargets: ['claude-code', 'codex'],
    riskLevel: 'L1',
    blockingQuestions: [],
  }, 'test');
  const slice = { ...validSlice, contractHash: frozenContract.contractHash };
  const state = {
    runId: 'pipeline-invalid-handoff',
    workdir: pipelineRunDir,
    runDir: pipelineRunDir,
    status: 'executing-slices',
    files: {},
    providerRuns: [],
  };
  let lastMessageFile;
  let observedFailure;
  let acceptanceCalled = false;
  const ctx = {
    resolveWorkdir: () => pipelineRunDir,
    currentGitSha: () => null,
    listChangedFiles: () => [],
    logStamp: () => 'stamp',
    stampedLogPath: (runDir, prefix, suffix) => path.join(runDir, `${prefix}.${suffix}`),
    buildCodexProviderInvocation: (options, runDir, prompt, outputFile) => {
      lastMessageFile = outputFile;
      return {
        runtime: 'codex',
        adapter: 'codex-exec',
        launch: { command: 'mock' },
        args: [],
        cwd: pipelineRunDir,
        stdin: prompt,
        env: {},
        schemaPath: null,
      };
    },
    providerResumeRefs: () => ({}),
    prepareProviderAttempt: () => ({
      profile: { runtime: 'codex' },
      capabilitySnapshot: { adapter: 'codex-exec' },
      task: {
        ref: 'task:pipeline-invalid-handoff:slice-001',
        hash: 'sha256:test-task',
        idempotencyKey: 'idempotency:pipeline-invalid-handoff:slice-001',
      },
      route: { decisionHash: 'sha256:test-route' },
      onFailure: (failure) => {
        observedFailure = failure;
        return { providerRecovery: { required: true, stage: 'slice-implementation-slice-001' } };
      },
    }),
    providerTimeoutMs: () => 1000,
    runProcess: (label, launch, args, settings) => {
      const stdout = [
        JSON.stringify({ type: 'thread.started', thread_id: 'pipeline-invalid-thread' }),
        JSON.stringify({ type: 'turn.started', turn_id: 'pipeline-invalid-turn' }),
        JSON.stringify({ type: 'turn.completed' }),
      ].join('\n');
      fs.writeFileSync(lastMessageFile, '{}');
      fs.writeFileSync(settings.stdoutFile, stdout);
      fs.writeFileSync(settings.stderrFile, '');
      return {
        result: { status: 0, stdout, stderr: '' },
        record: {
          label,
          status: 0,
          stdoutFile: settings.stdoutFile,
          stderrFile: settings.stderrFile,
          startedAt: 'test',
          finishedAt: 'test',
        },
      };
    },
    runProviderPostProcess: (attempt, record, context, run) => {
      try {
        return run();
      } catch (error) {
        const persisted = attempt.onFailure({
          kind: error.providerFailureKind || 'post-process',
          message: error.message,
          record,
          runtimeOutput: context.runtimeOutput || error.runtimeResult,
        });
        error.providerRecovery = persisted.providerRecovery;
        throw error;
      }
    },
    providerStep: (kind, run) => {
      try {
        return run();
      } catch (error) {
        error.providerFailureKind = error.providerFailureKind || kind;
        throw error;
      }
    },
    normalizeCodexOutput: runtimeAdapters.normalizeCodexOutput,
    assertProviderStructuredOutput: (value, schemaName, label, options) => (
      ctx.providerStep('schema-validation', () => structuredOutput.assertStructuredOutput(value, {
        schemaRoot,
        schemaName,
        label,
        collectionProperty: options && options.collectionProperty,
      }))
    ),
    extractJsonValue: JSON.parse,
    hashArtifact: stableHash,
    acceptProviderAttempt: () => {
      acceptanceCalled = true;
      throw new Error('acceptance must not run for an invalid handoff');
    },
  };

  assert.throws(
    () => pipelineProviders.runSliceImplementationProvider(
      ctx,
      state,
      path.join(pipelineRunDir, 'state.json'),
      pipelineRunDir,
      {},
      slice
    ),
    /pipeline implementation handoff slice-001 failed local schema validation/
  );
  assert.strictEqual(observedFailure.kind, 'schema-validation');
  assert.strictEqual(acceptanceCalled, false);
  assert.strictEqual(
    fs.existsSync(path.join(pipelineRunDir, 'slices', slice.id, 'handoff.json')),
    false
  );
} finally {
  fs.rmSync(pipelineRunDir, { recursive: true, force: true });
}

console.log('provider-structured-output: all assertions passed');
