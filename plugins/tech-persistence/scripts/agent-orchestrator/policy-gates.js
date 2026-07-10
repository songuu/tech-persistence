'use strict';

const RISK_RANK = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
const SENSITIVE_PATTERN = /\b(auth(?:entication|orization)?|oauth|permission|password|secret|credential|token|migration|schema|database|drop\s+table|delete\s+from|deploy(?:ment)?|production|payment|billing)\b/i;

function normalizeRisk(value) {
  const risk = String(value || 'L2').toUpperCase();
  return Object.prototype.hasOwnProperty.call(RISK_RANK, risk) ? risk : 'L2';
}

function highestTaskRisk(spec) {
  const tasks = Array.isArray(spec && spec.taskBreakdown) ? spec.taskBreakdown : [];
  return tasks.reduce((highest, task) => {
    const candidate = normalizeRisk(task && task.risk);
    return RISK_RANK[candidate] > RISK_RANK[highest] ? candidate : highest;
  }, 'L0');
}

function findSensitiveTerms(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  const matches = text.match(new RegExp(SENSITIVE_PATTERN.source, 'gi')) || [];
  return [...new Set(matches.map((item) => item.toLowerCase()))];
}

function canAutoFreezeSpec(spec) {
  const reasons = [];
  const questions = Array.isArray(spec && spec.questions) ? spec.questions.filter(Boolean) : [];
  const assumptions = Array.isArray(spec && spec.assumptions) ? spec.assumptions.filter(Boolean) : [];
  const highestRisk = highestTaskRisk(spec);
  const sensitiveTerms = findSensitiveTerms(spec);
  if (questions.length > 0) reasons.push(`open questions: ${questions.length}`);
  if (assumptions.length > 0) reasons.push(`assumptions require human freeze: ${assumptions.length}`);
  if (RISK_RANK[highestRisk] > RISK_RANK.L2) reasons.push(`risk ${highestRisk} exceeds L2`);
  if (sensitiveTerms.length > 0) reasons.push(`sensitive terms: ${sensitiveTerms.join(', ')}`);
  return { ok: reasons.length === 0, reasons, highestRisk, sensitiveTerms };
}

function canCompleteRun({ validation, spec } = {}) {
  const highestRisk = highestTaskRisk(spec);
  const status = String(validation && validation.status || 'missing').toLowerCase();
  const reasons = [];
  if (status === 'passed') return { ok: true, reasons, highestRisk, validationStatus: status };
  if (status === 'skipped' && RISK_RANK[highestRisk] <= RISK_RANK.L1) {
    return { ok: true, reasons, highestRisk, validationStatus: status };
  }
  if (status === 'skipped') reasons.push(`validation skipped for ${highestRisk}; L2+ requires explicit validation`);
  else reasons.push(`validation status is ${status}`);
  return { ok: false, reasons, highestRisk, validationStatus: status };
}

module.exports = { RISK_RANK, highestTaskRisk, findSensitiveTerms, canAutoFreezeSpec, canCompleteRun };