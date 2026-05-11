'use strict';

const fs = require('fs');
const path = require('path');

const BUILTIN_INTEGRATION_VALIDATION = ['git diff --check'];

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
  if (!review) return false;
  if (typeof review.decision !== 'string') return false;
  return review.decision.toLowerCase() === 'approved';
}

module.exports = {
  BUILTIN_INTEGRATION_VALIDATION,
  aggregateIntegrationValidationCommands,
  writeSliceReview,
  writeIntegrationReview,
  loadSliceReview,
  loadIntegrationReview,
  reviewApproved,
};
