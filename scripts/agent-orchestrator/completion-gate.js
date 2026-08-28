'use strict';

const COMPLETION_GATE_SCHEMA_VERSION = 'completion-gate-v1';
const VALID_SCOPES = new Set(['classic', 'slice', 'integration']);
const RISK_RANK = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 });

const RESOLVED_STATUSES = Object.freeze({
  clarifications: new Set(['resolved', 'ruled', 'confirmed', 'closed']),
  revisions: new Set(['applied', 'accepted', 'rejected', 'resolved', 'superseded']),
  blockers: new Set(['resolved', 'closed', 'cleared', 'dismissed']),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRisk(value) {
  const risk = String(value || 'L2').toUpperCase();
  return Object.prototype.hasOwnProperty.call(RISK_RANK, risk) ? risk : 'L2';
}

function nonEmptyStrings(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
}

function addUnique(target, value) {
  if (!target.includes(value)) target.push(value);
}

function addReason(reasons, reason) {
  addUnique(reasons, reason);
}

function addEvidenceRefs(target, values) {
  for (const value of nonEmptyStrings(values)) addUnique(target, value);
}

function itemStatus(item) {
  if (!isPlainObject(item)) return '';
  return String(item.status || item.state || item.resolution || '').trim().toLowerCase();
}

function unresolvedCount(items, kind) {
  const resolved = RESOLVED_STATUSES[kind];
  return items.filter((item) => !resolved.has(itemStatus(item))).length;
}

function inspectRequiredCollection(input, key, reasons) {
  const value = input[key];
  if (!Array.isArray(value)) {
    addReason(reasons, `${key} must be an array`);
    return null;
  }
  const open = unresolvedCount(value, key);
  if (open > 0) addReason(reasons, `open ${key}: ${open}`);
  return value;
}

function inspectReview(review, reasons) {
  if (!isPlainObject(review)) {
    addReason(reasons, 'review is required');
    return;
  }
  const decision = typeof review.decision === 'string' && review.decision.length > 0
    ? review.decision
    : 'missing';
  if (decision !== 'approved') {
    addReason(reasons, `review decision is ${decision}; approved required`);
  }
  if (review.compliant !== true) addReason(reasons, 'review compliant must be true');

  if (!Array.isArray(review.findings)) {
    addReason(reasons, 'review findings must be an array');
  } else if (review.findings.length > 0) {
    addReason(reasons, `open review findings: ${review.findings.length}`);
  }
  if (!Array.isArray(review.followUpTasks)) {
    addReason(reasons, 'review follow-up tasks must be an array');
  } else if (review.followUpTasks.length > 0) {
    addReason(reasons, `open review follow-up tasks: ${review.followUpTasks.length}`);
  }
}

function inspectValidation(validation, risk, material, reasons, evidenceRefs) {
  if (!isPlainObject(validation)) {
    addReason(reasons, 'validation is required');
    return;
  }
  const status = String(validation.status || 'missing').toLowerCase();
  if (status === 'passed') {
    // Passed validation is the normal completion path.
  } else if (status === 'skipped') {
    if (RISK_RANK[risk] > RISK_RANK.L1) {
      addReason(reasons, `validation skipped for ${risk}; L2+ requires explicit validation`);
    } else if (material !== false) {
      addReason(reasons, 'validation skipped for material completion');
    }
  } else {
    addReason(reasons, `validation status is ${status}`);
  }
  const directRef = validation.evidenceRef;
  const refs = validation.evidenceRefs;
  if (directRef !== undefined
      && (typeof directRef !== 'string' || directRef.trim().length === 0)) {
    addReason(reasons, 'validation evidenceRef must be a non-empty string');
  }
  if (refs !== undefined && !Array.isArray(refs)) {
    addReason(reasons, 'validation evidenceRefs must be an array');
  } else if (Array.isArray(refs) && nonEmptyStrings(refs).length !== refs.length) {
    addReason(reasons, 'validation evidence refs must contain only non-empty strings');
  }
  const validationRefs = [];
  addEvidenceRefs(validationRefs, [directRef]);
  addEvidenceRefs(validationRefs, refs);
  if (validationRefs.length === 0) addReason(reasons, 'validation evidence refs are missing');
  addEvidenceRefs(evidenceRefs, validationRefs);
}

function inspectEffects(material, effects, reasons, evidenceRefs) {
  if (typeof material !== 'boolean') addReason(reasons, 'material must be a boolean');
  if (!isPlainObject(effects)) {
    addReason(reasons, 'effects are required');
    return;
  }

  const state = String(effects.state || 'missing').toLowerCase();
  if (!['none', 'partial', 'committed'].includes(state)) {
    addReason(reasons, `effects state is ${state}`);
  } else if (state === 'partial') {
    addReason(reasons, 'effects state is partial; reconciliation required');
  }

  if (!Array.isArray(effects.refs)) {
    addReason(reasons, 'effects refs must be an array');
  } else {
    if (nonEmptyStrings(effects.refs).length !== effects.refs.length) {
      addReason(reasons, 'effects refs must contain only non-empty strings');
    }
    addEvidenceRefs(evidenceRefs, effects.refs);
    if (state === 'none' && effects.refs.length > 0) {
      addReason(reasons, 'effects refs must be empty when effects state is none');
    }
    if (state === 'committed' && nonEmptyStrings(effects.refs).length === 0) {
      addReason(reasons, 'committed effects require evidence refs');
    }
  }

  if (material === true && state !== 'committed') {
    addReason(reasons, 'material completion requires committed effects');
  }
  if (material === false && state === 'committed') {
    addReason(reasons, 'non-material completion cannot report committed effects');
  }
}

function inspectEvidence(evidence, reasons, evidenceRefs) {
  if (!isPlainObject(evidence)) {
    addReason(reasons, 'evidence completeness is required');
    return;
  }
  if (evidence.complete !== true) addReason(reasons, 'evidence is incomplete');
  if (!Array.isArray(evidence.refs)) {
    addReason(reasons, 'evidence refs must be an array');
    return;
  }
  if (nonEmptyStrings(evidence.refs).length !== evidence.refs.length) {
    addReason(reasons, 'evidence refs must contain only non-empty strings');
  }
  if (nonEmptyStrings(evidence.refs).length === 0) {
    addReason(reasons, 'evidence refs are missing');
  }
  addEvidenceRefs(evidenceRefs, evidence.refs);
}

function inspectSliceIds(pipeline, key, reasons) {
  const value = pipeline[key];
  if (!Array.isArray(value)) {
    addReason(reasons, `pipeline ${key} must be an array`);
    return null;
  }
  const normalized = nonEmptyStrings(value);
  if (normalized.length !== value.length) {
    addReason(reasons, `pipeline ${key} must contain only non-empty slice ids`);
  }
  if (new Set(normalized).size !== normalized.length) {
    addReason(reasons, `pipeline ${key} contains duplicate slice ids`);
  }
  return normalized;
}

function inspectPipeline(scope, pipeline, reasons) {
  if (scope !== 'integration') return;
  if (!isPlainObject(pipeline)) {
    addReason(reasons, 'pipeline summary is required for integration');
    return;
  }

  const required = inspectSliceIds(pipeline, 'requiredSlices', reasons);
  const completed = inspectSliceIds(pipeline, 'completedSlices', reasons);
  const pending = inspectSliceIds(pipeline, 'pendingSlices', reasons);
  const running = inspectSliceIds(pipeline, 'runningSlices', reasons);
  const blocked = inspectSliceIds(pipeline, 'blockedSlices', reasons);
  if (![required, completed, pending, running, blocked].every(Array.isArray)) return;

  const requiredSet = new Set(required);
  const completedSet = new Set(completed);
  const missing = required.filter((sliceId) => !completedSet.has(sliceId));
  const extra = completed.filter((sliceId) => !requiredSet.has(sliceId));
  if (missing.length > 0) addReason(reasons, `required slices incomplete: ${missing.join(', ')}`);
  if (extra.length > 0) addReason(reasons, `unexpected completed slices: ${extra.join(', ')}`);
  if (pending.length + running.length > 0) {
    addReason(reasons, `active pipeline slices: ${pending.length + running.length}`);
  }
  if (blocked.length > 0) addReason(reasons, `blocked pipeline slices: ${blocked.length}`);
}

function evaluateCompletionGate(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const scope = VALID_SCOPES.has(source.scope) ? source.scope : 'unknown';
  const reasons = [];
  const evidenceRefs = [];
  const risk = normalizeRisk(source.risk);

  if (scope === 'unknown') addReason(reasons, 'scope must be classic, slice, or integration');
  inspectReview(source.review, reasons);
  inspectValidation(source.validation, risk, source.material, reasons, evidenceRefs);
  inspectEffects(source.material, source.effects, reasons, evidenceRefs);
  inspectEvidence(source.evidence, reasons, evidenceRefs);
  inspectRequiredCollection(source, 'clarifications', reasons);
  inspectRequiredCollection(source, 'revisions', reasons);
  inspectRequiredCollection(source, 'blockers', reasons);
  inspectPipeline(scope, source.pipeline, reasons);
  if (evidenceRefs.length === 0) addReason(reasons, 'completion evidence refs are missing');

  return {
    schemaVersion: COMPLETION_GATE_SCHEMA_VERSION,
    scope,
    ok: reasons.length === 0,
    reasons,
    evidenceRefs,
  };
}

module.exports = {
  COMPLETION_GATE_SCHEMA_VERSION,
  evaluateCompletionGate,
};
