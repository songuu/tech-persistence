'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { sourceAdapter } = require('./lib/transcript-source-adapters');
const outbox = require('./lib/runtime-transcript-outbox');
const structuredOutput = require('./agent-orchestrator/structured-output');

(async () => {
  const fixture = path.join(__dirname, 'fixtures', 'transcripts', 'external-synthetic.jsonl');
  const adapter = sourceAdapter('external-jsonl-hash-v1');
  const batches = [];
  const full = await adapter.stream(fixture, { onEvents: async (events) => batches.push(...events) });
  const incremental = await adapter.stream(fixture, { startLine: 2 });
  assert.equal(full.eventChainSha256, incremental.eventChainSha256);
  assert.equal(full.projectionChainSha256, incremental.projectionChainSha256);
  assert.equal(full.eventCount, 2);
  assert.equal(incremental.emittedEventCount, 1);
  const serialized = JSON.stringify(batches);
  assert.ok(!serialized.includes('redacted fixture') && !serialized.includes('must-not-project'));
  assert.equal(adapter.descriptor.batchDryRunOnly, true);
  const llamaAdapter = sourceAdapter('llama-cpp-chat-jsonl-v1');
  const realFixture = path.join(__dirname, 'fixtures', 'transcripts', 'llama-cpp-b10621-real-redacted.jsonl');
  const llamaSnapshot = await llamaAdapter.stream(realFixture);
  const llamaIncremental = await llamaAdapter.stream(realFixture, { startLine: 2 });
  assert.equal(llamaSnapshot.descriptor.runtime, 'llama-cpp');
  assert.equal(llamaSnapshot.eventChainSha256, llamaIncremental.eventChainSha256);
  assert.equal(llamaIncremental.emittedEventCount, 1);
  assert.ok(!JSON.stringify(llamaSnapshot).includes('Return JSON'));
  structuredOutput.assertStructuredOutput(adapter.descriptor, {
    schemaRoot: path.join(__dirname, '..', 'schemas', 'agent-loop'), schemaName: 'transcript-source-adapter.schema.json', label: 'external transcript adapter',
  });
  const hash = 'a'.repeat(64);
  const job = outbox.createJob({ runtime: 'external', adapterId: adapter.descriptor.id,
    sessionId: 'synthetic-session', sourcePathHash: hash, fileIdentityHash: 'b'.repeat(64), observedSize: 42 });
  assert.deepEqual(outbox.validateJob(job), job);
  structuredOutput.assertStructuredOutput(job, {
    schemaRoot: path.join(__dirname, '..', 'schemas', 'agent-loop'), schemaName: 'runtime-transcript-outbox-job.schema.json', label: 'runtime transcript outbox job',
  });
  assert.throws(() => outbox.validateJob({ ...job, rawPrompt: 'forbidden' }), /non-canonical/);
  process.stdout.write('runtime transcript adapters: passed\n');
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
