'use strict';

const {
  HASH_PATTERN,
  assertExactKeys,
  assertRedactionStableString,
  canonicalStringify,
  canonicalize,
  stableHash,
  validateHash,
} = require('./self-learning-canonical');

const CONTRACT_SCHEMA_VERSION = 'acceptance-contract-v1';
const RECEIPT_SCHEMA_VERSION = 'acceptance-receipt-v1';
const CRITERION_ID_PATTERN = /^ac-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ORACLE_TYPES = new Set([
  'command',
  'artifact',
  'readback',
  'independent-review',
  'user-confirmation',
]);
const RESULT_STATUSES = new Set(['passed', 'failed', 'unknown']);
const EVIDENCE_KINDS = new Set([
  'command-execution',
  'artifact-readback',
  'runtime-readback',
  'independent-review',
  'user-confirmation',
]);
const EVIDENCE_ASSURANCE = new Set(['claimed', 'verified']);
const ORACLE_EVIDENCE_KIND = Object.freeze({
  command: 'command-execution',
  artifact: 'artifact-readback',
  readback: 'runtime-readback',
  'independent-review': 'independent-review',
  'user-confirmation': 'user-confirmation',
});

function compareCanonicalStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return assertRedactionStableString(value.trim(), label);
}

function sortedUniqueStrings(values, label, options = {}) {
  const minimum = options.minItems || 0;
  if (!Array.isArray(values) || values.length < minimum) {
    const count = minimum === 1 ? 'one' : String(minimum);
    throw new Error(`${label} must contain at least ${count} ${minimum === 1 ? 'entry' : 'entries'}`);
  }
  const normalized = values.map((value, index) => requiredString(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return normalized.sort();
}

function normalizeOracle(value, label = 'oracle') {
  assertExactKeys(value, ['type', 'procedure', 'expected'], label);
  const type = requiredString(value.type, `${label}.type`);
  if (!ORACLE_TYPES.has(type)) throw new Error(`${label}.type is unsupported: ${type}`);
  const expected = requiredString(value.expected, `${label}.expected`);
  if (type === 'command' && expected !== 'exit code is zero') {
    throw new Error(`${label}.expected must be "exit code is zero" for command Oracle`);
  }
  return {
    type,
    procedure: requiredString(value.procedure, `${label}.procedure`),
    expected,
  };
}

function oracleHash(oracle) {
  return stableHash(normalizeOracle(oracle));
}

function normalizeCriterion(value, index) {
  const label = `criteria[${index}]`;
  assertExactKeys(value, ['id', 'statement', 'sourceRefs', 'oracle'], label);
  const id = requiredString(value.id, `${label}.id`);
  if (!CRITERION_ID_PATTERN.test(id)) {
    throw new Error(`${label} criterion id must match ${CRITERION_ID_PATTERN}`);
  }
  return {
    id,
    statement: requiredString(value.statement, `${label}.statement`),
    sourceRefs: sortedUniqueStrings(value.sourceRefs, `${label}.sourceRefs`, { minItems: 1 }),
    oracle: normalizeOracle(value.oracle, `${label}.oracle`),
  };
}

function normalizeCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new Error('criteria must contain at least one criterion');
  }
  const normalized = criteria.map(normalizeCriterion);
  const seen = new Set();
  for (const criterion of normalized) {
    if (seen.has(criterion.id)) throw new Error(`duplicate criterion id ${criterion.id}`);
    seen.add(criterion.id);
  }
  return normalized.sort((left, right) => compareCanonicalStrings(left.id, right.id));
}

function contractPayload(input) {
  return canonicalize({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceRequirementHash: validateHash(input.sourceRequirementHash, 'sourceRequirementHash'),
    criteria: normalizeCriteria(input.criteria),
  });
}

function createAcceptanceContract(input = {}) {
  if (!Object.prototype.hasOwnProperty.call(input, 'sourceRequirement')) {
    throw new Error('sourceRequirement is required');
  }
  const payload = contractPayload({
    sourceRequirementHash: stableHash(input.sourceRequirement),
    criteria: input.criteria,
  });
  return canonicalize({ ...payload, contractHash: stableHash(payload) });
}

function assertCanonicalEqual(actual, expected, label) {
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new Error(`${label} is not canonical`);
  }
}

function assertAcceptanceContract(contract, options = {}) {
  assertExactKeys(
    contract,
    ['schemaVersion', 'sourceRequirementHash', 'criteria', 'contractHash'],
    'acceptance contract'
  );
  if (contract.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw new Error(`acceptance contract schemaVersion must be ${CONTRACT_SCHEMA_VERSION}`);
  }
  validateHash(contract.contractHash, 'contractHash');
  const payload = contractPayload(contract);
  const expectedHash = stableHash(payload);
  if (contract.contractHash !== expectedHash) {
    throw new Error('contractHash does not match canonical contract payload');
  }
  if (Object.prototype.hasOwnProperty.call(options, 'sourceRequirement')
      && contract.sourceRequirementHash !== stableHash(options.sourceRequirement)) {
    throw new Error('sourceRequirementHash does not match source requirement');
  }
  const expected = canonicalize({ ...payload, contractHash: expectedHash });
  assertCanonicalEqual(contract, expected, 'acceptance contract');
  return contract;
}

function normalizeEvidenceRef(value, label) {
  assertExactKeys(value, ['kind', 'ref', 'digest', 'assurance'], label);
  const kind = requiredString(value.kind, `${label}.kind`);
  if (!EVIDENCE_KINDS.has(kind)) throw new Error(`${label}.kind is unsupported: ${kind}`);
  const assurance = requiredString(value.assurance, `${label}.assurance`);
  if (!EVIDENCE_ASSURANCE.has(assurance)) {
    throw new Error(`${label}.assurance is unsupported: ${assurance}`);
  }
  return {
    kind,
    ref: requiredString(value.ref, `${label}.ref`),
    digest: validateHash(value.digest, `${label}.digest`),
    assurance,
  };
}

function normalizeEvidenceRefs(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const normalized = values.map((value, index) => normalizeEvidenceRef(value, `${label}[${index}]`));
  const serialized = normalized.map((value) => canonicalStringify(value));
  if (new Set(serialized).size !== serialized.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return normalized.sort((left, right) => compareCanonicalStrings(
    canonicalStringify(left),
    canonicalStringify(right)
  ));
}

function criterionMap(contract) {
  return new Map(contract.criteria.map((criterion) => [criterion.id, criterion]));
}

function assertExactCoverage(results, contract) {
  if (!Array.isArray(results)) throw new Error('results must be an array');
  const expected = criterionMap(contract);
  const seen = new Set();
  for (const result of results) {
    const criterionId = result && result.criterionId;
    if (seen.has(criterionId)) throw new Error(`duplicate criterion result ${criterionId}`);
    seen.add(criterionId);
    if (!expected.has(criterionId)) throw new Error(`unknown criterion result ${criterionId}`);
  }
  for (const criterionId of expected.keys()) {
    if (!seen.has(criterionId)) throw new Error(`missing criterion result ${criterionId}`);
  }
}

function normalizeResult(value, index, contractCriteria) {
  const label = `results[${index}]`;
  assertExactKeys(
    value,
    ['criterionId', 'oracleHash', 'status', 'evaluatorRef', 'evidenceRefs', 'observed'],
    label
  );
  const criterionId = requiredString(value.criterionId, `${label}.criterionId`);
  const criterion = contractCriteria.get(criterionId);
  const actualOracleHash = validateHash(value.oracleHash, `${label}.oracleHash`);
  if (actualOracleHash !== oracleHash(criterion.oracle)) {
    throw new Error(`oracleHash does not match contract criterion ${criterionId}`);
  }
  const status = requiredString(value.status, `${label}.status`);
  if (!RESULT_STATUSES.has(status)) throw new Error(`${label}.status is unsupported: ${status}`);
  const evidenceRefs = normalizeEvidenceRefs(value.evidenceRefs, `${label}.evidenceRefs`);
  if (status === 'passed' && !evidenceRefs.some((evidenceRef) => (
    evidenceRef.assurance === 'verified'
      && evidenceRef.kind === ORACLE_EVIDENCE_KIND[criterion.oracle.type]
  ))) {
    throw new Error(`${label} passed result requires verified evidence matching the criterion Oracle`);
  }
  return {
    criterionId,
    oracleHash: actualOracleHash,
    status,
    evaluatorRef: requiredString(value.evaluatorRef, `${label}.evaluatorRef`),
    evidenceRefs,
    observed: requiredString(value.observed, `${label}.observed`),
  };
}

function normalizeResults(results, contract) {
  assertExactCoverage(results, contract);
  const contractCriteria = criterionMap(contract);
  return results
    .map((result, index) => normalizeResult(result, index, contractCriteria))
    .sort((left, right) => compareCanonicalStrings(left.criterionId, right.criterionId));
}

function deriveOverallStatus(results) {
  if (results.some((result) => result.status === 'failed')) return 'failed';
  if (results.some((result) => result.status === 'unknown')) return 'unknown';
  return 'passed';
}

function receiptPayload(input) {
  const contract = assertAcceptanceContract(input.contract);
  const results = normalizeResults(input.results, contract);
  return canonicalize({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    contractHash: contract.contractHash,
    subjectRef: requiredString(input.subjectRef, 'subjectRef'),
    subjectHash: validateHash(input.subjectHash, 'subjectHash'),
    results,
    overallStatus: deriveOverallStatus(results),
  });
}

function createAcceptanceReceipt(input = {}) {
  if (!Object.prototype.hasOwnProperty.call(input, 'subject')) throw new Error('subject is required');
  if (!input.subject || input.subject.ref !== input.subjectRef) {
    throw new Error('subjectRef does not match subject.ref');
  }
  const payload = receiptPayload({
    contract: input.contract,
    subjectRef: input.subjectRef,
    subjectHash: stableHash(input.subject),
    results: input.results,
  });
  return canonicalize({ ...payload, receiptHash: stableHash(payload) });
}

function assertAcceptanceReceipt(receipt, options = {}) {
  assertExactKeys(receipt, [
    'schemaVersion',
    'contractHash',
    'subjectRef',
    'subjectHash',
    'results',
    'overallStatus',
    'receiptHash',
  ], 'acceptance receipt');
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(`acceptance receipt schemaVersion must be ${RECEIPT_SCHEMA_VERSION}`);
  }
  const contract = assertAcceptanceContract(options.contract);
  if (receipt.contractHash !== contract.contractHash) {
    throw new Error('receipt contractHash does not match contract');
  }
  validateHash(receipt.receiptHash, 'receiptHash');
  const payload = receiptPayload({
    contract,
    subjectRef: receipt.subjectRef,
    subjectHash: receipt.subjectHash,
    results: receipt.results,
  });
  if (receipt.overallStatus !== payload.overallStatus) {
    throw new Error('overallStatus does not match result statuses');
  }
  if (Object.prototype.hasOwnProperty.call(options, 'subject')
      && receipt.subjectHash !== stableHash(options.subject)) {
    throw new Error('subjectHash does not match subject');
  }
  const expectedHash = stableHash(payload);
  if (receipt.receiptHash !== expectedHash) {
    throw new Error('receiptHash does not match canonical receipt payload');
  }
  const expected = canonicalize({ ...payload, receiptHash: expectedHash });
  assertCanonicalEqual(receipt, expected, 'acceptance receipt');
  return receipt;
}

module.exports = {
  CONTRACT_SCHEMA_VERSION,
  CRITERION_ID_PATTERN,
  EVIDENCE_ASSURANCE,
  EVIDENCE_KINDS,
  HASH_PATTERN,
  ORACLE_TYPES,
  RECEIPT_SCHEMA_VERSION,
  RESULT_STATUSES,
  assertAcceptanceContract,
  assertAcceptanceReceipt,
  assertExactCoverage,
  contractPayload,
  createAcceptanceContract,
  createAcceptanceReceipt,
  deriveOverallStatus,
  oracleHash,
  receiptPayload,
};
