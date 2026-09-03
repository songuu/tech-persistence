'use strict';
const assert = require('node:assert/strict');
const governance = require('./agent-orchestrator/external-runtime-governance');
const structuredOutput = require('./agent-orchestrator/structured-output');
const { CASES } = require('./agent-orchestrator/native-runtime-canary');
const { resolveExternalRuntime } = require('./agent-orchestrator/native-execution-control');
const id = 'openai-compatible-chat-v1';
const shadow = governance.shadowDecision(id, { observed: true });
assert.equal(shadow.route, 'shadow');
assert.deepEqual(shadow.workspaceDiff, []);
assert.deepEqual(shadow.externalEffects, []);
const base = { descriptorId: id, registered: true, observedCapability: true,
  environmentKeys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'], explicitPromotion: true,
  canary: { status: 'passed', workspaceEffects: 0, externalEffects: 0, identityMismatch: 0,
    receiptHash: `sha256:${'c'.repeat(64)}`,
    cases: CASES.map((caseId) => ({ id: caseId, status: 'passed' })) } };
base.canary.receiptHash = require('./agent-orchestrator/runtime-capabilities').stableHash(
  (({ receiptHash, ...core }) => core)(base.canary)
);
const promoted = governance.promotionDecision(base);
assert.equal(promoted.route, 'read-only');
structuredOutput.assertStructuredOutput(promoted, {
  schemaRoot: require('node:path').join(__dirname, '..', 'schemas', 'agent-loop'),
  schemaName: 'runtime-promotion-receipt.schema.json',
});
assert.equal(resolveExternalRuntime(promoted).route, 'read-only');
assert.throws(() => resolveExternalRuntime({ ...promoted, receiptHash: 'sha256:bad' }), /invalid/);
assert.equal(governance.promotionDecision({ ...base, canary: { ...base.canary, cases: base.canary.cases.slice(1) } }).route, 'shadow');
assert.equal(governance.promotionDecision({ ...base, environmentKeys: ['SECRET'] }).route, 'shadow');
assert.equal(governance.promotionDecision({ ...base, explicitPromotion: false }).route, 'shadow');
assert.equal(governance.promotionDecision({ ...base, canary: { ...base.canary, receiptHash: null } }).route, 'shadow');
assert.throws(() => governance.selectWriter([{ id: 'a', writerEligible: true }, { id: 'b', writerEligible: true }]), /multiple writer/);
assert.throws(() => governance.selectWriter([{ id: 'b', writerEligible: true }], { id: 'a', partialEffects: true }), /switching/);
process.stdout.write('external runtime governance: passed\n');
