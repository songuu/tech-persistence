'use strict';
const assert = require('node:assert/strict');
const direct = require('./lib/codex-transcript-projection');
const { sourceAdapter } = require('./lib/transcript-source-adapters');
const { projectHarnessTimeline } = require('./lib/harness-event-projection');
const structuredOutput = require('./agent-orchestrator/structured-output');
const path = require('node:path');

const adapter = sourceAdapter('codex-jsonl-v1');
assert.equal(adapter.stream, direct.streamTranscriptSnapshot);
assert.equal(adapter.collect, direct.collectTranscriptSnapshot);
assert.throws(() => sourceAdapter('../unknown'), /Unknown transcript source adapter/);
const one = { kind: 'pipeline.transition', sourceId: 'synthetic-1', value: { status: 'done' }, observedAt: '2026-01-01T00:00:00.000Z' };
assert.deepEqual(projectHarnessTimeline([one]), projectHarnessTimeline([one]));
assert.deepEqual(projectHarnessTimeline([one, { invalid: true }]), projectHarnessTimeline([one]));
structuredOutput.assertStructuredOutput(projectHarnessTimeline([one])[0], {
  schemaRoot: path.join(__dirname, '..', 'schemas', 'agent-loop'), schemaName: 'harness-event.schema.json', label: 'harness event',
});
const serialized = JSON.stringify(projectHarnessTimeline([one]));
assert.ok(!serialized.includes('prompt') && !serialized.includes('stdout') && !serialized.includes('reasoning'));
process.stdout.write('harness adapters: passed\n');
