#!/usr/bin/env node

'use strict';

const assert = require('assert');
const path = require('path');
const {
  COMPLETION_GATE_SCHEMA_VERSION,
  evaluateCompletionGate,
} = require('./agent-orchestrator/completion-gate');
const policyGates = require('./agent-orchestrator/policy-gates');
const { assertStructuredOutput } = require('./agent-orchestrator/structured-output');

const SCHEMA_ROOT = path.join(__dirname, '..', 'schemas', 'agent-loop');

function validInput(overrides = {}) {
  return {
    scope: 'classic',
    risk: 'L2',
    review: {
      decision: 'approved',
      compliant: true,
      findings: [],
      followUpTasks: [],
    },
    validation: {
      status: 'passed',
      evidenceRef: 'validation.json',
    },
    material: true,
    effects: {
      state: 'committed',
      refs: ['effect:diff'],
    },
    evidence: {
      complete: true,
      refs: ['handoff.json', 'diff.patch'],
    },
    clarifications: [],
    revisions: [],
    blockers: [],
    ...overrides,
  };
}

function assertFails(input, pattern) {
  const gate = evaluateCompletionGate(input);
  assert.strictEqual(gate.ok, false, `expected gate to fail: ${JSON.stringify(gate)}`);
  assert.ok(
    gate.reasons.some((reason) => pattern.test(reason)),
    `expected a reason matching ${pattern}; got ${JSON.stringify(gate.reasons)}`
  );
  return gate;
}

const successInput = validInput();
const successSnapshot = JSON.parse(JSON.stringify(successInput));
const success = evaluateCompletionGate(successInput);
assert.deepStrictEqual(successInput, successSnapshot, 'completion evaluation must be pure');
assert.strictEqual(success.schemaVersion, COMPLETION_GATE_SCHEMA_VERSION);
assert.strictEqual(success.scope, 'classic');
assert.strictEqual(success.ok, true);
assert.deepStrictEqual(success.reasons, []);
assert.deepStrictEqual(
  success.evidenceRefs,
  ['validation.json', 'effect:diff', 'handoff.json', 'diff.patch']
);
assertStructuredOutput(success, {
  schemaRoot: SCHEMA_ROOT,
  schemaName: 'completion-gate.schema.json',
  label: 'successful completion gate',
});

const empty = assertFails({}, /scope must be classic, slice, or integration/);
assert.strictEqual(empty.scope, 'unknown');
assertFails(validInput({ review: undefined }), /review is required/);
assertFails(
  validInput({ review: { decision: 'approved', compliant: false, findings: [], followUpTasks: [] } }),
  /review compliant must be true/
);
assertFails(
  validInput({ review: { decision: 'APPROVED', compliant: true, findings: [], followUpTasks: [] } }),
  /review decision is APPROVED/
);
assertFails(
  validInput({ review: { decision: 'changes_requested', compliant: false, findings: [], followUpTasks: [] } }),
  /review decision is changes_requested/
);
assertFails(
  validInput({ review: { decision: 'approved', compliant: true, findings: [{ severity: 'P2' }], followUpTasks: [] } }),
  /open review findings: 1/
);
assertFails(
  validInput({ review: { decision: 'approved', compliant: true, findings: [], followUpTasks: ['fix'] } }),
  /open review follow-up tasks: 1/
);

assertFails(validInput({ validation: undefined }), /validation is required/);
assertFails(validInput({ validation: { status: 'failed', evidenceRef: 'validation.json' } }), /validation status is failed/);
assertFails(validInput({ validation: { status: 'passed' } }), /validation evidence refs are missing/);
assertFails(validInput({
  validation: { status: 'passed', evidenceRefs: ['validation.json', null] },
}), /validation evidence refs must contain only non-empty strings/);
assertFails(
  validInput({ validation: { status: 'skipped', evidenceRef: 'validation.json' } }),
  /validation skipped for L2/
);
const lowRiskSkipped = evaluateCompletionGate(validInput({
  risk: 'L1',
  validation: { status: 'skipped', evidenceRef: 'validation.json' },
  material: false,
  effects: { state: 'none', refs: [] },
}));
assert.strictEqual(lowRiskSkipped.ok, true, JSON.stringify(lowRiskSkipped));

assertFails(validInput({ material: undefined }), /material must be a boolean/);
assertFails(validInput({ effects: undefined }), /effects are required/);
assertFails(validInput({ effects: { state: 'partial', refs: ['effect:partial'] } }), /effects state is partial/);
assertFails(validInput({ effects: { state: 'committed', refs: [] } }), /committed effects require evidence refs/);
assertFails(validInput({ effects: { state: 'committed', refs: ['effect:diff', ''] } }), /effects refs must contain only non-empty strings/);
assertFails(
  validInput({ material: true, effects: { state: 'none', refs: [] } }),
  /material completion requires committed effects/
);
assertFails(
  validInput({ material: false, effects: { state: 'committed', refs: ['effect:unexpected'] } }),
  /non-material completion cannot report committed effects/
);

assertFails(validInput({ evidence: undefined }), /evidence completeness is required/);
assertFails(validInput({ evidence: { complete: false, refs: ['handoff.json'] } }), /evidence is incomplete/);
assertFails(validInput({ evidence: { complete: true, refs: [] } }), /evidence refs are missing/);
assertFails(validInput({ evidence: { complete: true, refs: ['handoff.json', null] } }), /evidence refs must contain only non-empty strings/);
assertFails(validInput({
  validation: { status: 'passed' },
  material: false,
  effects: { state: 'none', refs: [] },
  evidence: { complete: true, refs: [] },
}), /completion evidence refs are missing/);

assertFails(validInput({ clarifications: undefined }), /clarifications must be an array/);
assertFails(validInput({ clarifications: [{ id: 'c1', status: 'open' }] }), /open clarifications: 1/);
assert.strictEqual(evaluateCompletionGate(validInput({
  clarifications: [{ id: 'c1', status: 'resolved' }],
})).ok, true);
assertFails(validInput({ revisions: undefined }), /revisions must be an array/);
assertFails(validInput({ revisions: [{ id: 'r1', status: 'pending' }] }), /open revisions: 1/);
assert.strictEqual(evaluateCompletionGate(validInput({
  revisions: [{ id: 'r1', status: 'applied' }],
})).ok, true);
assertFails(validInput({ blockers: undefined }), /blockers must be an array/);
assertFails(validInput({ blockers: ['provider unavailable'] }), /open blockers: 1/);
assert.strictEqual(evaluateCompletionGate(validInput({
  blockers: [{ id: 'b1', status: 'resolved' }],
})).ok, true);

const integration = evaluateCompletionGate(validInput({
  scope: 'integration',
  pipeline: {
    requiredSlices: ['slice-a', 'slice-b'],
    completedSlices: ['slice-b', 'slice-a'],
    pendingSlices: [],
    runningSlices: [],
    blockedSlices: [],
  },
}));
assert.strictEqual(integration.ok, true, JSON.stringify(integration));
assertFails(validInput({ scope: 'integration' }), /pipeline summary is required/);
assertFails(validInput({
  scope: 'integration',
  pipeline: {
    requiredSlices: ['slice-a', 'slice-b'],
    completedSlices: ['slice-a'],
    pendingSlices: ['slice-b'],
    runningSlices: [],
    blockedSlices: [],
  },
}), /required slices incomplete: slice-b/);
assertFails(validInput({
  scope: 'integration',
  pipeline: {
    requiredSlices: ['slice-a'],
    completedSlices: ['slice-a', 'slice-extra'],
    pendingSlices: [],
    runningSlices: [],
    blockedSlices: [],
  },
}), /unexpected completed slices: slice-extra/);
assertFails(validInput({
  scope: 'integration',
  pipeline: {
    requiredSlices: ['slice-a'],
    completedSlices: ['slice-a'],
    pendingSlices: [],
    runningSlices: ['slice-b'],
    blockedSlices: [],
  },
}), /active pipeline slices: 1/);

assertStructuredOutput(empty, {
  schemaRoot: SCHEMA_ROOT,
  schemaName: 'completion-gate.schema.json',
  label: 'failed completion gate',
});

const legacyPassed = policyGates.canCompleteRun({
  validation: { status: 'passed' },
  spec: { taskBreakdown: [{ risk: 'L2' }] },
});
assert.strictEqual(legacyPassed.ok, true);
assert.strictEqual(legacyPassed.highestRisk, 'L2');
assert.strictEqual(legacyPassed.validationStatus, 'passed');
assert.strictEqual(legacyPassed.schemaVersion, COMPLETION_GATE_SCHEMA_VERSION);
assertStructuredOutput(legacyPassed, {
  schemaRoot: SCHEMA_ROOT,
  schemaName: 'completion-gate.schema.json',
  label: 'legacy completion gate facade',
});

const legacySkippedL1 = policyGates.canCompleteRun({
  validation: { status: 'skipped' },
  spec: { taskBreakdown: [{ risk: 'L1' }] },
});
assert.strictEqual(legacySkippedL1.ok, true);

const legacySkippedL2 = policyGates.canCompleteRun({
  validation: { status: 'skipped' },
  spec: { taskBreakdown: [{ risk: 'L2' }] },
});
assert.strictEqual(legacySkippedL2.ok, false);
assert.deepStrictEqual(
  legacySkippedL2.reasons,
  ['validation skipped for L2; L2+ requires explicit validation']
);

const extendedFacade = policyGates.canCompleteRun(validInput({
  spec: { taskBreakdown: [{ risk: 'L3' }] },
  review: { decision: 'blocked', compliant: false, findings: [], followUpTasks: [] },
}));
assert.strictEqual(extendedFacade.ok, false);
assert.strictEqual(extendedFacade.highestRisk, 'L3');
assert.match(extendedFacade.reasons.join('\n'), /review decision is blocked/);

const extendedSuccess = policyGates.canCompleteRun(validInput({
  spec: { taskBreakdown: [{ risk: 'L3' }] },
}));
assert.strictEqual(extendedSuccess.ok, true, JSON.stringify(extendedSuccess));
assert.strictEqual(extendedSuccess.highestRisk, 'L3');
assertStructuredOutput(extendedSuccess, {
  schemaRoot: SCHEMA_ROOT,
  schemaName: 'completion-gate.schema.json',
  label: 'extended completion gate facade',
});

console.log('agent-orchestrator-completion-gate: passed');
