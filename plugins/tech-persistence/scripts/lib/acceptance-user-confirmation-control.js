'use strict';

const {
  assertExactKeys,
  canonicalStringify,
  validateHash,
  validateIdentifier,
} = require('./self-learning-canonical');

const NATIVE_CONTROL_PREFIX = 'TP_SELF_LEARNING_CONTROL_V1:';
const MAX_NATIVE_CONTROL_BYTES = 4096;

function invalidControl(reason) {
  return { status: 'invalid', reason };
}

function parseCanonicalNativeControl(prompt) {
  if (typeof prompt !== 'string' || !prompt.startsWith(NATIVE_CONTROL_PREFIX)) {
    return { status: 'ordinary' };
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_NATIVE_CONTROL_BYTES) {
    return invalidControl('control-envelope-too-large');
  }
  const encoded = prompt.slice(NATIVE_CONTROL_PREFIX.length);
  let semantic;
  try {
    semantic = JSON.parse(encoded);
    if (canonicalStringify(semantic) !== encoded) {
      return invalidControl('control-json-noncanonical');
    }
  } catch {
    return invalidControl('control-json-invalid');
  }
  return { status: 'canonical', semantic };
}

function normalizeAcceptanceConfirmationSemantic(semantic) {
  try {
    assertExactKeys(
      semantic,
      ['action', 'contract_hash', 'criterion_id', 'decision', 'oracle_hash', 'subject_hash'],
      'acceptance confirmation control'
    );
    if (semantic.action !== 'confirm-acceptance') {
      return invalidControl('control-action-invalid');
    }
    validateHash(semantic.contract_hash, 'acceptance confirmation contract_hash');
    validateIdentifier(semantic.criterion_id, 'acceptance confirmation criterion_id');
    validateHash(semantic.oracle_hash, 'acceptance confirmation oracle_hash');
    validateHash(semantic.subject_hash, 'acceptance confirmation subject_hash');
    if (!['accepted', 'rejected'].includes(semantic.decision)) {
      return invalidControl('control-shape-invalid');
    }
    return {
      status: 'control',
      event_type: 'user.approval',
      final_disposition: semantic.decision,
      details: { ...semantic },
      semantic: { ...semantic },
    };
  } catch {
    return invalidControl('control-shape-invalid');
  }
}

function parseAcceptanceConfirmationControl(prompt) {
  const decoded = parseCanonicalNativeControl(prompt);
  if (decoded.status !== 'canonical') return decoded;
  if (decoded.semantic.action !== 'confirm-acceptance') {
    return { status: 'other-control', semantic: decoded.semantic };
  }
  return normalizeAcceptanceConfirmationSemantic(decoded.semantic);
}

module.exports = {
  NATIVE_CONTROL_PREFIX,
  MAX_NATIVE_CONTROL_BYTES,
  parseCanonicalNativeControl,
  normalizeAcceptanceConfirmationSemantic,
  parseAcceptanceConfirmationControl,
};
