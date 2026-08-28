#!/usr/bin/env node

'use strict';

const assert = require('assert');

const completionGate = require('./agent-orchestrator/completion-gate');
const locks = require('./agent-orchestrator/locks');
const pipelineState = require('./agent-orchestrator/pipeline-state');
const queue = require('./agent-orchestrator/queue');
const review = require('./agent-orchestrator/review');

const slice = { id: 'slice-review-test', ownedFiles: ['src/review-test.js'], dependsOn: [] };
const gateInput = (reviewResult) => ({
  scope: 'slice',
  risk: 'L2',
  review: reviewResult,
  validation: { status: 'passed', evidenceRef: 'validation.json' },
  material: true,
  effects: { state: 'committed', refs: ['diff.patch'] },
  evidence: { complete: true, refs: ['handoff.json', 'diff.patch', 'review.json'] },
  clarifications: [],
  revisions: Array.isArray(reviewResult.contractRevisions) ? reviewResult.contractRevisions : [],
  blockers: [],
});

const nonApproved = [
  {
    decision: 'changes_requested',
    compliant: false,
    findings: [{ severity: 'P1', message: 'required change' }],
    followUpTasks: ['apply required change'],
    contractRevisions: [],
  },
  {
    decision: 'blocked',
    compliant: false,
    findings: [{ severity: 'P0', message: 'missing external evidence' }],
    followUpTasks: ['obtain evidence'],
    contractRevisions: [],
  },
];

for (const reviewResult of nonApproved) {
  review.assertCanonicalReview(reviewResult);
  const gate = completionGate.evaluateCompletionGate(gateInput(reviewResult));
  assert.strictEqual(gate.ok, false, `${reviewResult.decision} must not pass completion gate`);

  const initialState = {
    status: pipelineState.RUN_STATES.EXECUTING_SLICES,
    pipeline: { sliceStates: { [slice.id]: pipelineState.SLICE_STATES.IMPLEMENTED } },
  };
  const blockedState = pipelineState.transitionSlice(
    initialState,
    slice.id,
    pipelineState.SLICE_STATES.BLOCKED,
    { reason: reviewResult.decision }
  );
  assert.strictEqual(blockedState.pipeline.sliceStates[slice.id], pipelineState.SLICE_STATES.BLOCKED);

  const blockedQueue = queue.moveToBlocked(queue.moveToRunning(queue.emptyQueue(), slice.id), slice.id, reviewResult.decision);
  assert.strictEqual(blockedQueue.running.length, 0);
  assert.strictEqual(blockedQueue.blocked[0].sliceId, slice.id);

  const releasedLocks = locks.releaseSliceLocks(locks.claimAll(locks.emptyLocks(), slice), slice);
  assert.strictEqual(releasedLocks.files['src/review-test.js'].status, locks.STATUS.RELEASED);
}

assert.strictEqual(review.reviewApproved({
  decision: 'approved',
  compliant: false,
  findings: [],
  followUpTasks: [],
  contractRevisions: [],
}), false, 'approved + compliant=false must fail closed before state transition');

const approved = {
  decision: 'approved',
  compliant: true,
  findings: [],
  followUpTasks: [],
  contractRevisions: [],
};
const approvedGate = completionGate.evaluateCompletionGate(gateInput(approved));
assert.strictEqual(approvedGate.ok, true);
let completedState = {
  status: pipelineState.RUN_STATES.EXECUTING_SLICES,
  pipeline: { sliceStates: { [slice.id]: pipelineState.SLICE_STATES.IMPLEMENTED } },
};
completedState = pipelineState.transitionSlice(completedState, slice.id, pipelineState.SLICE_STATES.REVIEWED);
completedState = pipelineState.transitionSlice(completedState, slice.id, pipelineState.SLICE_STATES.COMPLETED);
assert.strictEqual(completedState.pipeline.sliceStates[slice.id], pipelineState.SLICE_STATES.COMPLETED);
const completedQueue = queue.moveToCompleted(queue.moveToRunning(queue.emptyQueue(), slice.id), slice.id);
assert.deepStrictEqual(completedQueue.completed, [slice.id]);
const completedLocks = locks.markCompletedOwner(locks.claimAll(locks.emptyLocks(), slice), slice);
assert.strictEqual(completedLocks.files['src/review-test.js'].status, locks.STATUS.COMPLETED_OWNER);

console.log('agent-orchestrator-pipeline-review: passed');
