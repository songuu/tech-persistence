'use strict';

const crypto = require('crypto');

const SENSITIVE_AREAS = ['auth', 'secret', 'migration', 'destructive', 'api', 'data-schema', 'storage-path'];
const SENSITIVE_KEYWORDS = [
  { area: 'auth', patterns: [/\bauth\b/i, /\boauth\b/i, /\blogin\b/i, /\bsession token\b/i] },
  { area: 'secret', patterns: [/\bsecret\b/i, /\bapi[ _-]?key\b/i, /\bpassword\b/i, /\btoken\b/i, /\bcredential\b/i] },
  { area: 'migration', patterns: [/\bmigration\b/i, /\balter table\b/i, /\bschema change\b/i] },
  { area: 'destructive', patterns: [/\bdrop table\b/i, /\bdelete from\b/i, /\brm\s+-rf\b/i, /\bdestructive\b/i] },
  { area: 'api', patterns: [/\bAPI contract\b/i, /\bendpoint signature\b/i, /\bpublic API\b/i] },
  { area: 'data-schema', patterns: [/\bdata model\b/i, /\bdata schema\b/i, /\bcolumn\b/i] },
  { area: 'storage-path', patterns: [/\bstorage path\b/i, /\bfile layout\b/i, /\bartifact path\b/i] },
];

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function detectSensitiveAreas(slice) {
  const haystack = [
    slice.title || '',
    ...(asStringArray(slice.acceptanceCriteria)),
    ...(asStringArray(slice.doneCriteria)),
    ...(asStringArray(slice.requiredChanges)),
    ...(asStringArray(slice.ownedFiles)),
  ].join('\n').toLowerCase();
  const found = new Set(asStringArray(slice.sensitiveAreas));
  for (const rule of SENSITIVE_KEYWORDS) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) {
      found.add(rule.area);
    }
  }
  return Array.from(found).filter((area) => SENSITIVE_AREAS.includes(area));
}

function computeSliceHash(slice, globalContractHash) {
  const canonical = {
    id: slice.id || '',
    title: slice.title || '',
    dependsOn: [...asStringArray(slice.dependsOn)].sort(),
    ownedFiles: [...asStringArray(slice.ownedFiles)].sort(),
    acceptanceCriteria: [...asStringArray(slice.acceptanceCriteria)],
    doneCriteria: [...asStringArray(slice.doneCriteria)],
    risk: slice.risk || 'L1',
    globalContractHash: globalContractHash || '',
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return `sha256:${hash}`;
}

function ensureId(slice, fallbackIndex) {
  const id = String(slice.id || '').trim();
  if (id) return id;
  return `slice-${String(fallbackIndex + 1).padStart(3, '0')}`;
}

function normalizeRisk(value) {
  const allowed = ['L0', 'L1', 'L2', 'L3', 'L4'];
  if (allowed.includes(value)) return value;
  return 'L1';
}

function normalizeSlice(raw, options) {
  const { fallbackIndex = 0, globalContractHash = '', defaultType = 'slice' } = options || {};
  const source = raw && typeof raw === 'object' ? raw : {};
  const type = source.type === 'reconciliation' ? 'reconciliation' : defaultType;
  const slice = {
    id: ensureId(source, fallbackIndex),
    type,
    title: String(source.title || '').trim() || `Untitled slice ${fallbackIndex + 1}`,
    dependsOn: asStringArray(source.dependsOn),
    ownedFiles: asStringArray(source.ownedFiles),
    readFiles: asStringArray(source.readFiles),
    risk: normalizeRisk(source.risk),
    acceptanceCriteria: asStringArray(source.acceptanceCriteria),
    doneCriteria: asStringArray(source.doneCriteria),
    validationCommands: asStringArray(source.validationCommands),
    questions: asStringArray(source.questions),
    sensitiveAreas: [],
    canStart: false,
  };
  if (type === 'reconciliation') {
    slice.depth = Number.isInteger(source.depth) ? source.depth : 1;
    slice.affectedSlices = asStringArray(source.affectedSlices);
    slice.affectedFiles = asStringArray(source.affectedFiles);
    slice.requiredChanges = asStringArray(source.requiredChanges);
    if (!slice.id.startsWith('reconcile-')) {
      slice.id = `reconcile-${String(fallbackIndex + 1).padStart(3, '0')}`;
    }
  }
  slice.sensitiveAreas = detectSensitiveAreas(slice);
  slice.contractHash = computeSliceHash(slice, globalContractHash);
  return slice;
}

function isSafeRisk(risk) {
  return ['L0', 'L1', 'L2', 'L3'].includes(risk);
}

function rejectIfUnsafe(slice) {
  const issues = [];
  if (!isSafeRisk(slice.risk)) {
    issues.push(`risk ${slice.risk} exceeds L3; slice planner must split this slice into smaller scope.`);
  }
  if (slice.sensitiveAreas && slice.sensitiveAreas.length > 0) {
    const sensitive = slice.sensitiveAreas.join(', ');
    issues.push(`slice touches sensitive areas: ${sensitive}; human operator must review before planning continues.`);
  }
  if (slice.type === 'reconciliation' && slice.depth > 1) {
    issues.push(`reconciliation depth ${slice.depth} exceeds 1; collapse the change into a single reconciliation slice or escalate to contract-conflict.`);
  }
  if (slice.type === 'reconciliation') {
    const recursiveDeps = (slice.dependsOn || []).filter((id) => id.startsWith('reconcile-'));
    if (recursiveDeps.length > 0) {
      issues.push(`reconciliation slice may not depend on other reconciliation slices: ${recursiveDeps.join(', ')}.`);
    }
  }
  if (issues.length === 0) return slice;
  return {
    ...slice,
    canStart: false,
    questions: [...slice.questions, ...issues],
    rejected: true,
    rejectedReasons: issues,
  };
}

function evaluateStaticCanStart(slice) {
  if (slice.rejected) return { canStart: false, reasons: slice.rejectedReasons || ['rejected by normalizer'] };
  const reasons = [];
  if (slice.questions && slice.questions.length > 0) reasons.push(`open questions: ${slice.questions.length}`);
  if (!isSafeRisk(slice.risk)) reasons.push(`risk ${slice.risk} exceeds L3`);
  if (slice.sensitiveAreas && slice.sensitiveAreas.length > 0) reasons.push(`sensitive areas: ${slice.sensitiveAreas.join(', ')}`);
  return { canStart: reasons.length === 0, reasons };
}

function isSliceSafeForAuto(slice) {
  if (slice.type === 'reconciliation') return false;
  if (!['L0', 'L1', 'L2'].includes(slice.risk)) return false;
  if (Array.isArray(slice.ownedFiles) && slice.ownedFiles.length > 5) return false;
  if (Array.isArray(slice.questions) && slice.questions.length > 0) return false;
  if (Array.isArray(slice.sensitiveAreas) && slice.sensitiveAreas.length > 0) return false;
  return true;
}

module.exports = {
  SENSITIVE_AREAS,
  detectSensitiveAreas,
  computeSliceHash,
  normalizeSlice,
  rejectIfUnsafe,
  evaluateStaticCanStart,
  isSliceSafeForAuto,
};
