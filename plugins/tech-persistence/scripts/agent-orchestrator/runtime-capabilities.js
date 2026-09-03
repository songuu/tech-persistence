'use strict';

const crypto = require('crypto');

const RUNTIMES = Object.freeze(['codex', 'claude', 'openai-compatible']);
const DOCUMENTED_MATURITIES = Object.freeze([
  'stable',
  'preview',
  'experimental',
  'deprecated',
  'undocumented',
  'unknown',
]);
const OBSERVATION_VALUES = Object.freeze([true, false, 'unknown']);

function canonicalize(value, seen = new Set(), label = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite numbers`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined) throw new Error(`${label} must not contain undefined`);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${label} must not contain circular references`);
    seen.add(value);
    const result = value.map((entry, index) =>
      canonicalize(entry, seen, `${label}[${index}]`));
    seen.delete(value);
    return result;
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} must contain JSON-compatible values`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must contain plain objects`);
  }
  if (seen.has(value)) throw new Error(`${label} must not contain circular references`);
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalize(value[key], seen, `${label}.${key}`);
  }
  seen.delete(value);
  return result;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function stableHash(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function normalizeNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const normalized = value.map((entry, index) =>
    normalizeNonEmptyString(entry, `${label}[${index}]`));
  return [...new Set(normalized)].sort();
}

function normalizeMaturity(input, capabilities) {
  const result = {};
  if (typeof input === 'string') {
    if (!DOCUMENTED_MATURITIES.includes(input)) {
      throw new Error(`documentedMaturity is unsupported: ${input}`);
    }
    for (const capability of capabilities) result[capability] = input;
    return result;
  }
  if (input !== undefined && (input === null || typeof input !== 'object'
      || Array.isArray(input))) {
    throw new Error('documentedMaturity must be a maturity string or object');
  }
  const source = input || {};
  for (const capability of capabilities) {
    const maturity = source[capability] === undefined
      ? 'unknown'
      : source[capability];
    if (!DOCUMENTED_MATURITIES.includes(maturity)) {
      throw new Error(
        `documentedMaturity.${capability} is unsupported: ${maturity}`
      );
    }
    result[capability] = maturity;
  }
  return result;
}

function normalizeObservations(input, capabilities) {
  if (input !== undefined && (input === null || typeof input !== 'object'
      || Array.isArray(input))) {
    throw new Error('runtimeObserved must be an object');
  }
  const source = input || {};
  const result = {};
  for (const capability of capabilities) {
    const observation = source[capability] === undefined
      ? 'unknown'
      : source[capability];
    if (!OBSERVATION_VALUES.includes(observation)) {
      throw new Error(
        `runtimeObserved.${capability} must be true, false, or unknown`
      );
    }
    result[capability] = observation;
  }
  return result;
}

function policyAllows(capability, policy = {}) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('policy must be an object');
  }
  if (policy.allowedCapabilities !== undefined) {
    const allowed = normalizeStringArray(
      policy.allowedCapabilities,
      'policy.allowedCapabilities'
    );
    if (!allowed.includes(capability)) return false;
  }
  if (policy.deniedCapabilities !== undefined) {
    const denied = normalizeStringArray(
      policy.deniedCapabilities,
      'policy.deniedCapabilities'
    );
    if (denied.includes(capability)) return false;
  }
  if (policy.capabilities !== undefined) {
    if (policy.capabilities === null || typeof policy.capabilities !== 'object'
        || Array.isArray(policy.capabilities)) {
      throw new Error('policy.capabilities must be an object');
    }
    if (policy.capabilities[capability] !== undefined
        && typeof policy.capabilities[capability] !== 'boolean') {
      throw new Error(`policy.capabilities.${capability} must be a boolean`);
    }
    if (policy.capabilities[capability] === false) return false;
  }
  return true;
}

function createCapabilitySnapshot(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('capability snapshot input must be an object');
  }
  const runtime = normalizeNonEmptyString(input.runtime, 'runtime');
  if (!RUNTIMES.includes(runtime)) {
    throw new Error(`runtime must be one of: ${RUNTIMES.join(', ')}`);
  }
  const profileId = normalizeNonEmptyString(input.profileId, 'profileId');
  const adapter = normalizeNonEmptyString(input.adapter, 'adapter');
  const declaredCapabilities = normalizeStringArray(
    input.declaredCapabilities,
    'declaredCapabilities'
  );
  const observedKeys = input.runtimeObserved
    && typeof input.runtimeObserved === 'object'
    && !Array.isArray(input.runtimeObserved)
    ? Object.keys(input.runtimeObserved)
    : [];
  const maturityKeys = input.documentedMaturity
    && typeof input.documentedMaturity === 'object'
    && !Array.isArray(input.documentedMaturity)
    ? Object.keys(input.documentedMaturity)
    : [];
  const describedCapabilities = [...new Set([
    ...declaredCapabilities,
    ...observedKeys,
    ...maturityKeys,
  ])].sort();
  const documentedMaturity = normalizeMaturity(
    input.documentedMaturity,
    describedCapabilities
  );
  const runtimeObserved = normalizeObservations(
    input.runtimeObserved,
    describedCapabilities
  );
  const hasObservation = Object.values(runtimeObserved)
    .some((value) => value === true || value === false);
  const observedAt = input.observedAt === undefined ? null : input.observedAt;
  if (observedAt !== null) {
    if (typeof observedAt !== 'string'
        || Number.isNaN(Date.parse(observedAt))) {
      throw new Error('observedAt must be an ISO-compatible date-time or null');
    }
  } else if (hasObservation) {
    throw new Error('observedAt is required when runtimeObserved contains true or false');
  }
  const probeError = input.probeError === undefined ? null : input.probeError;
  if (probeError !== null && (typeof probeError !== 'string'
      || probeError.trim() === '')) {
    throw new Error('probeError must be a non-empty string or null');
  }
  const source = input.source === undefined
    ? (hasObservation ? 'runtime-probe' : 'static-profile')
    : normalizeNonEmptyString(input.source, 'source');
  const effectiveCapabilities = declaredCapabilities.filter((capability) =>
    runtimeObserved[capability] === true
      && policyAllows(capability, input.policy || {}));
  const core = {
    schemaVersion: 'runtime-capability-snapshot-v1',
    runtime,
    profileId,
    adapter,
    declaredCapabilities,
    documentedMaturity,
    runtimeObserved,
    probeError: probeError === null ? null : probeError.trim(),
    observedAt,
    effectiveCapabilities,
    source,
  };
  return {
    ...core,
    snapshotHash: stableHash(core),
    // Legacy aliases remain declared-only. Routing must use effectiveCapabilities.
    capabilities: [...declaredCapabilities],
    verifiedAt: observedAt,
  };
}

module.exports = {
  DOCUMENTED_MATURITIES,
  OBSERVATION_VALUES,
  RUNTIMES,
  canonicalize,
  createCapabilitySnapshot,
  normalizeStringArray,
  policyAllows,
  stableHash,
  stableStringify,
};
