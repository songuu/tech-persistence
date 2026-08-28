'use strict';

const fs = require('fs');
const path = require('path');

const BUILTIN_INTEGRATION_VALIDATION = ['git diff --check'];
const CANONICAL_REVIEW_DECISIONS = Object.freeze(['approved', 'changes_requested', 'blocked']);
const CONTRACT_REVISION_FIELDS = Object.freeze([
  'goal',
  'nonGoals',
  'globalAcceptance',
  'architectureConstraints',
  'runtimeTargets',
]);
const REVISION_ID_PATTERN = /^rev-[a-z0-9-]+$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function contractRevisionErrors(revision, at) {
  const errors = [];
  if (!isPlainObject(revision)) return [`${at} must be an object`];
  const allowedKeys = new Set(['revisionId', 'fields', 'rationale']);
  const extraKeys = Object.keys(revision).filter((key) => !allowedKeys.has(key));
  if (extraKeys.length > 0) errors.push(`${at} has unsupported field(s): ${extraKeys.join(', ')}`);
  if (typeof revision.revisionId !== 'string' || !REVISION_ID_PATTERN.test(revision.revisionId)) {
    errors.push(`${at}.revisionId must match ${REVISION_ID_PATTERN}`);
  }
  if (typeof revision.rationale !== 'string' || !revision.rationale.trim()) {
    errors.push(`${at}.rationale must be a non-empty string`);
  }
  if (!isPlainObject(revision.fields)) {
    errors.push(`${at}.fields must be a non-empty object`);
    return errors;
  }
  const fieldNames = Object.keys(revision.fields);
  if (fieldNames.length === 0) errors.push(`${at}.fields must be a non-empty object`);
  const unsupportedFields = fieldNames.filter((key) => !CONTRACT_REVISION_FIELDS.includes(key));
  if (unsupportedFields.length > 0) {
    errors.push(`${at}.fields has unsupported canonical field(s): ${unsupportedFields.join(', ')}`);
  }
  return errors;
}

function canonicalReviewErrors(review) {
  if (!isPlainObject(review)) return ['review must be an object'];
  const errors = [];
  if (!CANONICAL_REVIEW_DECISIONS.includes(review.decision)) {
    errors.push(`decision must be one of ${CANONICAL_REVIEW_DECISIONS.join('|')}`);
  }
  const expectedCompliance = review.decision === 'approved';
  if (review.compliant !== expectedCompliance) {
    errors.push(`${review.decision || 'unknown'} requires compliant=${expectedCompliance}`);
  }
  for (const field of ['findings', 'followUpTasks']) {
    if (!Array.isArray(review[field])) errors.push(`${field} must be an array`);
  }
  if (review.contractRevisions !== undefined && !Array.isArray(review.contractRevisions)) {
    errors.push('contractRevisions must be an array when present');
  }
  const revisions = Array.isArray(review.contractRevisions) ? review.contractRevisions : [];
  revisions.forEach((revision, index) => {
    errors.push(...contractRevisionErrors(revision, `contractRevisions[${index}]`));
  });

  if (review.decision === 'approved') {
    if (Array.isArray(review.findings) && review.findings.length > 0) {
      errors.push('approved review cannot contain unresolved findings');
    }
    if (Array.isArray(review.followUpTasks) && review.followUpTasks.length > 0) {
      errors.push('approved review cannot contain unresolved followUpTasks');
    }
    if (revisions.length > 0) {
      errors.push('approved review cannot contain unresolved contractRevisions');
    }
    const rulings = Array.isArray(review.clarificationRulings) ? review.clarificationRulings : [];
    if (rulings.some((ruling) => ruling && ruling.decision === 'revise-spec')) {
      errors.push('approved review cannot contain unresolved revise-spec clarification rulings');
    }
  }
  return errors;
}

function assertCanonicalReview(review) {
  const errors = canonicalReviewErrors(review);
  if (errors.length > 0) {
    throw new Error(`canonical review contract violated: ${errors.join('; ')}`);
  }
  return review;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function aggregateIntegrationValidationCommands(globalContract, slices) {
  const seen = new Set();
  const result = [];
  const push = (command) => {
    const trimmed = String(command || '').trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  };
  if (globalContract && Array.isArray(globalContract.integrationValidationCommands)) {
    for (const command of globalContract.integrationValidationCommands) push(command);
  }
  for (const slice of slices || []) {
    if (!slice || !Array.isArray(slice.validationCommands)) continue;
    for (const command of slice.validationCommands) push(command);
  }
  for (const command of BUILTIN_INTEGRATION_VALIDATION) push(command);
  return result;
}

function sliceReviewPath(runDir, sliceId) {
  return path.join(runDir, 'slices', sliceId, 'review.json');
}

function integrationReviewPath(runDir) {
  return path.join(runDir, 'integration-review.json');
}

function writeSliceReview(runDir, sliceId, review) {
  writeJson(sliceReviewPath(runDir, sliceId), review);
}

function writeIntegrationReview(runDir, review) {
  writeJson(integrationReviewPath(runDir), review);
}

function loadSliceReview(runDir, sliceId) {
  const file = sliceReviewPath(runDir, sliceId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadIntegrationReview(runDir) {
  const file = integrationReviewPath(runDir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function reviewApproved(review) {
  try {
    assertCanonicalReview(review);
    return review.decision === 'approved';
  } catch (_error) {
    return false;
  }
}

module.exports = {
  BUILTIN_INTEGRATION_VALIDATION,
  CANONICAL_REVIEW_DECISIONS,
  CONTRACT_REVISION_FIELDS,
  canonicalReviewErrors,
  assertCanonicalReview,
  aggregateIntegrationValidationCommands,
  writeSliceReview,
  writeIntegrationReview,
  loadSliceReview,
  loadIntegrationReview,
  reviewApproved,
};
