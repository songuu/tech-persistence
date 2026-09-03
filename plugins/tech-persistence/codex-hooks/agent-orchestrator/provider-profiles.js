'use strict';
const { createCapabilitySnapshot, stableHash } = require('./runtime-capabilities');
const DEFAULT_PROFILES = {
  spec: 'spec-reasoning-v1',
  implementation: 'implementation-coding-v1',
  review: 'review-independent-v1',
};
const PROFILES = {
  'spec-reasoning-v1': {
    id: 'spec-reasoning-v1',
    runtime: 'claude',
    adapter: 'claude-print',
    capabilities: ['stdin', 'structured-output', 'repo-read'],
    documentedMaturity: 'stable',
    providerKey: 'spec',
  },
  'implementation-coding-v1': {
    id: 'implementation-coding-v1',
    runtime: 'codex',
    adapter: 'codex-exec',
    capabilities: ['stdin', 'structured-output', 'repo-read', 'workspace-write'],
    documentedMaturity: 'stable',
    providerKey: 'implementation',
  },
  'review-independent-v1': {
    id: 'review-independent-v1',
    runtime: 'claude',
    adapter: 'claude-print',
    capabilities: ['stdin', 'structured-output', 'repo-read'],
    documentedMaturity: 'stable',
    providerKey: 'review',
  },
};

function profileId(options, key) {
  if (['spec', 'review'].includes(key) && require('./external-runtime-config').stages(options).includes(key)) return `external-readonly-${key}-v1`;
  const requested = options && options[`${key}-profile`];
  return requested && PROFILES[requested] ? requested : DEFAULT_PROFILES[key];
}

function profile(options, key) {
  if (['spec', 'review'].includes(key) && require('./external-runtime-config').stages(options).includes(key)) {
    return { id: `external-readonly-${key}-v1`, runtime: 'openai-compatible', adapter: 'openai-compatible-chat',
      capabilities: ['stdin', 'structured-output', 'bounded-context'], documentedMaturity: 'experimental', providerKey: key };
  }
  return PROFILES[profileId(options, key)];
}

function capabilitySnapshot(options, key, observation = null) {
  const selected = profile(options, key);
  const configuredObservation = options
    && options.runtimeCapabilityEvidence
    && options.runtimeCapabilityEvidence[key];
  const evidence = observation || configuredObservation || {};
  const snapshot = createCapabilitySnapshot({
    runtime: selected.runtime,
    profileId: selected.id,
    adapter: selected.adapter,
    declaredCapabilities: selected.capabilities,
    documentedMaturity: selected.documentedMaturity,
    runtimeObserved: evidence.runtimeObserved,
    probeError: evidence.probeError,
    observedAt: evidence.observedAt,
    source: evidence.source,
    policy: evidence.policy || {},
  });
  return {
    ...snapshot,
    capabilities: [...selected.capabilities],
    verifiedAt: snapshot.observedAt || new Date().toISOString(),
  };
}

function hash(value) {
  return stableHash(value);
}

module.exports = {
  DEFAULT_PROFILES,
  PROFILES,
  capabilitySnapshot,
  hash,
  profile,
  profileId,
};
