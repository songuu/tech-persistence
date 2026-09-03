'use strict';

const fs = require('fs');
const path = require('path');

const CLASSIFICATIONS = {
  COMPATIBLE: 'compatible',
  PENDING_ONLY: 'pending-only',
  COMPLETED_LOCAL: 'completed-local',
  CROSS_CUTTING: 'cross-cutting',
  BREAKING: 'breaking',
};

const ALLOWED_SOURCES = ['slice-review', 'slice-planner-replan'];

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function driftReportPath(runDir) {
  return path.join(runDir, 'drift-report.json');
}

function rejectIfInvalidSource(revision) {
  if (!revision || typeof revision !== 'object') {
    throw new Error('drift-detector: revision payload must be an object');
  }
  if (!ALLOWED_SOURCES.includes(revision.source)) {
    throw new Error(`drift-detector: source "${revision.source}" not in whitelist (${ALLOWED_SOURCES.join('|')})`);
  }
  if (!revision.fields || typeof revision.fields !== 'object') {
    throw new Error('drift-detector: revision.fields must be a non-empty object');
  }
}

function fieldsAffectOutOfScope(fields, contract) {
  if (!fields.nonGoals || !Array.isArray(contract.nonGoals)) return false;
  const removed = contract.nonGoals.filter((item) => !fields.nonGoals.includes(item));
  return removed.length > 0;
}

function classify(revision, context) {
  rejectIfInvalidSource(revision);
  const { contract, pendingSlices, completedSlices, runningSlices, reconciliationDepthOfSource } = context;
  const changedFields = Object.keys(revision.fields || {});

  if (revision.source === 'slice-review'
      && reconciliationDepthOfSource && reconciliationDepthOfSource >= 1) {
    return {
      classification: CLASSIFICATIONS.CROSS_CUTTING,
      reason: 'reconciliation slice review attempted to introduce a new contract revision; escalated to avoid infinite compensation loop.',
      action: 'escalate-recursive-revision',
    };
  }

  if (changedFields.includes('goal') || changedFields.includes('globalAcceptance')) {
    return {
      classification: CLASSIFICATIONS.BREAKING,
      reason: `revision touches ${changedFields.includes('goal') ? 'goal' : 'globalAcceptance'} — global contract foundation altered.`,
      action: 'enter-contract-conflict',
    };
  }
  if (fieldsAffectOutOfScope(revision.fields, contract || {})) {
    return {
      classification: CLASSIFICATIONS.BREAKING,
      reason: 'revision removes previously frozen nonGoals — out-of-scope boundary changed.',
      action: 'enter-contract-conflict',
    };
  }

  const completedCount = Array.isArray(completedSlices) ? completedSlices.length : 0;
  const runningCount = Array.isArray(runningSlices) ? runningSlices.length : 0;
  const pendingCount = Array.isArray(pendingSlices) ? pendingSlices.length : 0;

  if (changedFields.includes('architectureConstraints')) {
    if (completedCount + runningCount >= 2) {
      return {
        classification: CLASSIFICATIONS.CROSS_CUTTING,
        reason: 'architectureConstraints revision touches multiple completed/running slices.',
        action: 'enter-contract-conflict',
      };
    }
    if (completedCount === 1) {
      return {
        classification: CLASSIFICATIONS.COMPLETED_LOCAL,
        reason: 'architectureConstraints revision affects a single completed slice; reconciliation possible.',
        action: 'create-reconciliation-slice',
      };
    }
    if (pendingCount > 0) {
      return {
        classification: CLASSIFICATIONS.PENDING_ONLY,
        reason: 'architectureConstraints revision affects only pending slices; replan pending queue.',
        action: 'replan-pending-queue',
      };
    }
    return {
      classification: CLASSIFICATIONS.COMPATIBLE,
      reason: 'architectureConstraints revision has no slice impact yet.',
      action: 'update-future-base',
    };
  }

  if (changedFields.includes('runtimeTargets') || changedFields.includes('nonGoals')) {
    if (pendingCount > 0) {
      return {
        classification: CLASSIFICATIONS.PENDING_ONLY,
        reason: 'runtimeTargets/nonGoals revision affects only pending slices.',
        action: 'replan-pending-queue',
      };
    }
    return {
      classification: CLASSIFICATIONS.COMPATIBLE,
      reason: 'runtimeTargets/nonGoals revision has no active impact.',
      action: 'update-future-base',
    };
  }

  return {
    classification: CLASSIFICATIONS.COMPATIBLE,
    reason: 'revision touches only metadata fields; no slice impact.',
    action: 'update-future-base',
  };
}

function writeDriftReport(runDir, entries, globalContractHash) {
  const report = {
    generatedAt: nowIso(),
    globalContractHash: globalContractHash || '',
    revisions: entries,
  };
  writeJson(driftReportPath(runDir), report);
  return report;
}

module.exports = {
  CLASSIFICATIONS,
  ALLOWED_SOURCES,
  rejectIfInvalidSource,
  classify,
  writeDriftReport,
};
