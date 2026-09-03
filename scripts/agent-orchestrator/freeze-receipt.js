'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalStringify, stableHash, validateHash } = require('../lib/self-learning-canonical');
const controlStore = require('./control-store');

const FREEZE_RECEIPT_SCHEMA_VERSION = 'agent-loop-freeze-receipt-v1';
const ACCEPTANCE_PROTOCOL = 'v1';
const SCOPE_PATTERN = /^(classic|global|slice:[a-z0-9-]+)(?:@[a-f0-9]{64})?$/;

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeReceipt(value) {
  const keys = Object.keys(value || {}).sort();
  const expected = [
    'acceptanceProtocol', 'contractHash', 'frozenPayloadHash',
    'runLocator', 'schemaVersion', 'scopeRef',
  ].sort();
  if (canonicalStringify(keys) !== canonicalStringify(expected)) {
    throw new Error('freeze receipt must have exact fields');
  }
  if (value.schemaVersion !== FREEZE_RECEIPT_SCHEMA_VERSION
      || value.acceptanceProtocol !== ACCEPTANCE_PROTOCOL) {
    throw new Error('freeze receipt protocol is unsupported');
  }
  const scopeRef = requiredString(value.scopeRef, 'freeze receipt scopeRef');
  if (!SCOPE_PATTERN.test(scopeRef)) throw new Error('freeze receipt scopeRef is invalid');
  return {
    schemaVersion: FREEZE_RECEIPT_SCHEMA_VERSION,
    acceptanceProtocol: ACCEPTANCE_PROTOCOL,
    runLocator: requiredString(value.runLocator, 'freeze receipt runLocator'),
    scopeRef,
    contractHash: validateHash(value.contractHash, 'freeze receipt contractHash'),
    frozenPayloadHash: validateHash(
      value.frozenPayloadHash,
      'freeze receipt frozenPayloadHash'
    ),
  };
}

function receiptFile(runDir, scopeRef, options) {
  const controlDir = controlStore.ensureControlRunDir(runDir, options);
  const safeScope = scopeRef.replace(/[:@]/g, '-');
  const directory = path.join(controlDir, 'freeze-receipts');
  controlStore.assertAuthoritativeControlPath(runDir, directory, options);
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${safeScope}.json`);
}

function expectedReceipt(runDir, input) {
  const scopeRef = requiredString(input.scopeRef, 'freeze scopeRef');
  if (!SCOPE_PATTERN.test(scopeRef)) throw new Error('freeze scopeRef is invalid');
  return normalizeReceipt({
    schemaVersion: FREEZE_RECEIPT_SCHEMA_VERSION,
    acceptanceProtocol: ACCEPTANCE_PROTOCOL,
    runLocator: controlStore.stableRunLocator(runDir),
    scopeRef,
    contractHash: validateHash(input.contractHash, 'freeze contractHash'),
    frozenPayloadHash: stableHash(input.frozenPayload),
  });
}

function recordFreezeReceipt(runDir, input, options = {}) {
  const expected = expectedReceipt(runDir, input);
  const file = receiptFile(runDir, expected.scopeRef, options);
  const actual = normalizeReceipt(
    controlStore.claimAuthoritativeJson(runDir, file, expected, options)
  );
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new Error('freeze receipt conflicts with the frozen payload');
  }
  return actual;
}

function verifyFreezeReceipt(runDir, input, options = {}) {
  const expected = expectedReceipt(runDir, input);
  const file = receiptFile(runDir, expected.scopeRef, options);
  if (!fs.existsSync(file)) throw new Error('freeze receipt is missing');
  const actual = normalizeReceipt(
    controlStore.readAuthoritativeJson(runDir, file, options)
  );
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new Error('freeze receipt does not match the current frozen payload');
  }
  return actual;
}

module.exports = {
  ACCEPTANCE_PROTOCOL,
  FREEZE_RECEIPT_SCHEMA_VERSION,
  expectedReceipt,
  normalizeReceipt,
  recordFreezeReceipt,
  verifyFreezeReceipt,
};
