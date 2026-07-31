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
      task: { hash: 'sha256:test-task' },
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

console.log('provider-structured-output: 12 passed');
