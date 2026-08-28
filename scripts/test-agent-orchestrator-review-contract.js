#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const review = require('./agent-orchestrator/review');
const slicePlanner = require('./agent-orchestrator/slice-planner');
const structuredOutput = require('./agent-orchestrator/structured-output');

const schemaRoot = path.join(__dirname, '..', 'schemas', 'agent-loop');
const reviewSchema = JSON.parse(fs.readFileSync(
  path.join(schemaRoot, 'review-result.schema.json'),
  'utf8'
));

assert.deepStrictEqual(
  reviewSchema.properties.decision.enum,
  review.CANONICAL_REVIEW_DECISIONS,
  'runtime and schema must share the canonical decision enum'
);

function assertSchemaRejects(value, messagePattern) {
  assert.throws(
    () => structuredOutput.assertStructuredOutput(value, {
      schemaRoot,
      schemaName: 'review-result.schema.json',
      label: 'canonical review',
    }),
    messagePattern
  );
}

function approvedReview(overrides = {}) {
  return {
    decision: 'approved',
    compliant: true,
    findings: [],
    followUpTasks: [],
    contractRevisions: [],
    ...overrides,
  };
}

assert.strictEqual(review.reviewApproved(approvedReview()), true);
assert.strictEqual(
  review.reviewApproved(approvedReview({ compliant: false })),
  false,
  'approved + compliant=false must fail closed'
);
assert.strictEqual(
  review.reviewApproved(approvedReview({
    findings: [{ severity: 'P1', message: 'required behavior is missing' }],
  })),
  false,
  'approved reviews cannot carry unresolved findings'
);
assert.strictEqual(
  review.reviewApproved(approvedReview({ followUpTasks: ['implement the missing behavior'] })),
  false,
  'approved reviews cannot carry unresolved follow-up tasks'
);
assert.strictEqual(
  review.reviewApproved(approvedReview({
    contractRevisions: [{
      revisionId: 'rev-required-behavior',
      fields: { globalAcceptance: ['new required behavior'] },
      rationale: 'the frozen contract is incomplete',
    }],
  })),
  false,
  'approved reviews cannot carry unresolved contract revisions'
);
assert.strictEqual(
  review.reviewApproved(approvedReview({
    clarificationRulings: [{ id: 'clarification-1', decision: 'revise-spec' }],
  })),
  false,
  'approved reviews cannot carry an unresolved revise-spec ruling'
);

assertSchemaRejects(
  approvedReview({ compliant: false }),
  /canonical review failed local schema validation/
);
assertSchemaRejects(
  approvedReview({ findings: [{ severity: 'P1', message: 'missing behavior' }] }),
  /canonical review failed local schema validation/
);
assertSchemaRejects(
  approvedReview({ followUpTasks: ['finish the required behavior'] }),
  /canonical review failed local schema validation/
);
assertSchemaRejects(
  approvedReview({
    contractRevisions: [{
      revisionId: 'rev-required-behavior',
      fields: { globalAcceptance: ['new required behavior'] },
      rationale: 'the frozen contract is incomplete',
    }],
  }),
  /canonical review failed local schema validation/
);
assertSchemaRejects(
  approvedReview({
    clarificationRulings: [{ id: 'clarification-1', decision: 'revise-spec' }],
  }),
  /canonical review failed local schema validation/
);
assertSchemaRejects({
  decision: 'changes_requested',
  compliant: true,
  findings: [{ severity: 'P1', message: 'missing behavior' }],
  followUpTasks: ['finish the required behavior'],
  contractRevisions: [],
}, /canonical review failed local schema validation/);
assertSchemaRejects({
  decision: 'blocked',
  compliant: true,
  findings: [],
  followUpTasks: ['obtain required input'],
  contractRevisions: [],
}, /canonical review failed local schema validation/);

assertSchemaRejects({
  decision: 'changes_requested',
  compliant: false,
  findings: [],
  followUpTasks: [],
  contractRevisions: [{ arbitrary: true }],
}, /canonical review failed local schema validation/);
assertSchemaRejects({
  decision: 'changes_requested',
  compliant: false,
  findings: [],
  followUpTasks: [],
  contractRevisions: [{
    revisionId: 'invalid-id',
    fields: { goal: 'revised goal' },
    rationale: 'goal changed',
  }],
}, /canonical review failed local schema validation/);
assertSchemaRejects({
  decision: 'changes_requested',
  compliant: false,
  findings: [],
  followUpTasks: [],
  contractRevisions: [{
    revisionId: 'rev-empty-fields',
    fields: {},
    rationale: 'no actual revision',
  }],
}, /canonical review failed local schema validation/);

const validRevisionReview = {
  decision: 'changes_requested',
  compliant: false,
  findings: [{ severity: 'P1', message: 'frozen acceptance is incomplete' }],
  followUpTasks: ['resolve the proposed contract revision'],
  contractRevisions: [{
    revisionId: 'rev-required-behavior',
    fields: { globalAcceptance: ['new required behavior'] },
    rationale: 'the frozen contract is incomplete',
  }],
};
assert.deepStrictEqual(
  structuredOutput.assertStructuredOutput(validRevisionReview, {
    schemaRoot,
    schemaName: 'review-result.schema.json',
    label: 'canonical review',
  }),
  validRevisionReview
);

const slicePrompt = slicePlanner.buildSliceReviewPrompt(
  { goal: 'canonical review contract' },
  { id: 'slice-001' },
  {}
);
const integrationPrompt = slicePlanner.buildIntegrationReviewPrompt(
  { goal: 'canonical review contract' },
  [],
  {}
);
for (const prompt of [slicePrompt, integrationPrompt]) {
  assert.match(prompt, new RegExp(review.CANONICAL_REVIEW_DECISIONS.join(', ')));
  assert.doesNotMatch(prompt, /needs-followup/);
  assert.match(prompt, /approved[^\n]*compliant=true/i);
  assert.match(prompt, /findings\[\][^\n]*followUpTasks\[\][^\n]*contractRevisions\[\]/i);
}

console.log('agent-orchestrator-review-contract: all assertions passed');
