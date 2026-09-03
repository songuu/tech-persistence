'use strict';
const assert = require('node:assert/strict');
const adapters = require('./agent-orchestrator/runtime-adapters');
const registry = require('./agent-orchestrator/provider-adapter-registry');
const structuredOutput = require('./agent-orchestrator/structured-output');
const path = require('node:path');

const common = { launch: { command: 'synthetic-cli' }, cwd: 'C:/synthetic', prompt: 'redacted fixture', schemaPath: 'schema.json' };
assert.deepEqual(adapters.buildProviderInvocation('claude', common), adapters.buildClaudeInvocation(common));
assert.deepEqual(adapters.buildProviderInvocation('codex', common), adapters.buildCodexInvocation(common));
assert.match(registry.registryHash(), /^[a-f0-9]{64}$/);
assert.throws(() => adapters.buildProviderInvocation('unknown', common), /Unknown provider/);
assert.throws(() => registry.descriptor('../dynamic-module'), /Unknown provider adapter/);
for (const descriptor of Object.values(registry.ADAPTERS)) structuredOutput.assertStructuredOutput(descriptor, {
  schemaRoot: path.join(__dirname, '..', 'schemas', 'agent-loop'), schemaName: 'provider-adapter.schema.json', label: descriptor.id,
});
process.stdout.write('provider adapter registry: passed\n');
