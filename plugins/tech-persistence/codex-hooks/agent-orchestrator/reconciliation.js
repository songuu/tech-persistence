'use strict';

const sliceNormalizer = require('./slice-normalizer');

const MAX_DEPTH = 1;

function isReconciliationSliceId(id) {
  return typeof id === 'string' && id.startsWith('reconcile-');
}

function generateReconciliationSlice(options) {
  const { revision, affectedSlices, affectedFiles, fallbackIndex = 0, globalContractHash } = options;
  if (!revision) throw new Error('reconciliation: revision required');
  const baseId = `reconcile-${String(fallbackIndex + 1).padStart(3, '0')}`;
  const raw = {
    id: baseId,
    type: 'reconciliation',
    title: `Reconcile ${affectedSlices ? affectedSlices.join(', ') : ''} against ${revision.revisionId || 'revision'}`.trim(),
    dependsOn: [],
    ownedFiles: Array.isArray(affectedFiles) ? affectedFiles : [],
    readFiles: [],
    risk: 'L2',
    acceptanceCriteria: [
      `Apply revision ${revision.revisionId || 'pending'} to the affected slices: ${(affectedSlices || []).join(', ') || 'n/a'}`,
    ],
    doneCriteria: [
      'Affected files match the revised contract',
      'Slice review records no further contract revision',
    ],
    validationCommands: Array.isArray(revision.validationCommands) ? revision.validationCommands : [],
    questions: [],
    affectedSlices: Array.isArray(affectedSlices) ? affectedSlices : [],
    affectedFiles: Array.isArray(affectedFiles) ? affectedFiles : [],
    requiredChanges: Array.isArray(revision.requiredChanges) ? revision.requiredChanges : [],
    depth: 1,
  };
  const normalized = sliceNormalizer.normalizeSlice(raw, { fallbackIndex, globalContractHash, defaultType: 'reconciliation' });
  return sliceNormalizer.rejectIfUnsafe(normalized);
}

function ensureDepthLimit(slice) {
  if (!slice || slice.type !== 'reconciliation') return slice;
  if ((slice.depth || 1) > MAX_DEPTH) {
    return {
      ...slice,
      rejected: true,
      rejectedReasons: [`reconciliation depth ${slice.depth} > ${MAX_DEPTH}; escalate to contract-conflict.`],
    };
  }
  return slice;
}

function isReviewFromReconciliationSlice(review) {
  if (!review || typeof review !== 'object') return false;
  return isReconciliationSliceId(review.sliceId);
}

function rejectRecursiveRevision(review) {
  if (!isReviewFromReconciliationSlice(review)) return review;
  if (!Array.isArray(review.contractRevisions) || review.contractRevisions.length === 0) return review;
  return {
    ...review,
    contractRevisions: [],
    recursiveRevisionsBlocked: review.contractRevisions,
  };
}

module.exports = {
  MAX_DEPTH,
  isReconciliationSliceId,
  generateReconciliationSlice,
  ensureDepthLimit,
  isReviewFromReconciliationSlice,
  rejectRecursiveRevision,
};
