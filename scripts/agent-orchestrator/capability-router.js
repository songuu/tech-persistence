'use strict';

const {
  RUNTIMES,
  normalizeStringArray,
  stableHash,
  stableStringify,
} = require('./runtime-capabilities');

const ORCHESTRATION_OWNERS = Object.freeze([
  'tp',
  'codex-host',
  'claude-host',
]);

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalStringArray(value, label) {
  return value === undefined ? null : normalizeStringArray(value, label);
}

function normalizeEffectsState(task) {
  const state = task.partialEffects === true
    ? 'partial'
    : (task.effectsState || 'none');
  if (!['none', 'accepted', 'partial', 'committed'].includes(state)) {
    throw new Error(
      'task.effectsState must be none, accepted, partial, or committed'
    );
  }
  return state;
}

function normalizeTask(task) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error('task must be an object');
  }
  const orchestrationOwner = nonEmptyString(
    task.orchestrationOwner,
    'task.orchestrationOwner'
  );
  if (!ORCHESTRATION_OWNERS.includes(orchestrationOwner)) {
    throw new Error(
      `task.orchestrationOwner must be one of: ${ORCHESTRATION_OWNERS.join(', ')}`
    );
  }
  const intent = task.intent || task.mode || 'read-only';
  if (!['read-only', 'write'].includes(intent)) {
    throw new Error('task.intent must be read-only or write');
  }
  const requiredCapabilities = normalizeStringArray(
    task.requiredCapabilities || [],
    'task.requiredCapabilities'
  );
  const effectsState = normalizeEffectsState(task);
  return {
    ref: nonEmptyString(task.ref, 'task.ref'),
    hash: nonEmptyString(task.hash, 'task.hash'),
    orchestrationOwner,
    intent,
    requiredCapabilities,
    effectsState,
    partialEffects: effectsState !== 'none',
    resumeProviderRef: task.resumeProviderRef === undefined
      ? null
      : nonEmptyString(task.resumeProviderRef, 'task.resumeProviderRef'),
  };
}

function normalizeCandidate(candidate, index) {
  if (candidate === null || typeof candidate !== 'object'
      || Array.isArray(candidate)) {
    throw new Error(`candidates[${index}] must be an object`);
  }
  const snapshot = candidate.snapshot || candidate.capabilitySnapshot;
  if (snapshot === null || typeof snapshot !== 'object'
      || Array.isArray(snapshot)) {
    throw new Error(`candidates[${index}].snapshot must be an object`);
  }
  const ref = nonEmptyString(
    candidate.ref || candidate.id || candidate.providerKey,
    `candidates[${index}].ref`
  );
  const runtime = nonEmptyString(
    candidate.runtime || snapshot.runtime,
    `candidates[${index}].runtime`
  );
  if (!RUNTIMES.includes(runtime)) {
    throw new Error(
      `candidates[${index}].runtime must be one of: ${RUNTIMES.join(', ')}`
    );
  }
  const priority = candidate.priority === undefined ? 100 : candidate.priority;
  if (!Number.isSafeInteger(priority)) {
    throw new Error(`candidates[${index}].priority must be a safe integer`);
  }
  const effectiveCapabilities = Array.isArray(snapshot.effectiveCapabilities)
    ? normalizeStringArray(
      snapshot.effectiveCapabilities,
      `candidates[${index}].snapshot.effectiveCapabilities`
    )
    : [];
  return {
    ref,
    providerKey: nonEmptyString(
      candidate.providerKey || ref,
      `candidates[${index}].providerKey`
    ),
    runtime,
    profileId: snapshot.profileId === undefined
      ? null
      : nonEmptyString(snapshot.profileId, `candidates[${index}].snapshot.profileId`),
    adapter: snapshot.adapter === undefined
      ? null
      : nonEmptyString(snapshot.adapter, `candidates[${index}].snapshot.adapter`),
    priority,
    enabled: candidate.enabled !== false,
    effectiveCapabilities,
    snapshotHash: typeof snapshot.snapshotHash === 'string'
      ? snapshot.snapshotHash
      : stableHash({
        runtime,
        profileId: snapshot.profileId || null,
        adapter: snapshot.adapter || null,
        effectiveCapabilities,
      }),
  };
}

function normalizePolicy(policy = {}) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('policy must be an object');
  }
  return {
    allowReadOnlyFallback: policy.allowReadOnlyFallback !== false,
    allowedRuntimes: normalizeOptionalStringArray(
      policy.allowedRuntimes,
      'policy.allowedRuntimes'
    ),
    deniedRuntimes: normalizeOptionalStringArray(
      policy.deniedRuntimes,
      'policy.deniedRuntimes'
    ) || [],
    allowedCandidateRefs: normalizeOptionalStringArray(
      policy.allowedCandidateRefs,
      'policy.allowedCandidateRefs'
    ),
    deniedCandidateRefs: normalizeOptionalStringArray(
      policy.deniedCandidateRefs,
      'policy.deniedCandidateRefs'
    ) || [],
    writerCandidateRef: policy.writerCandidateRef === undefined
      ? null
      : nonEmptyString(policy.writerCandidateRef, 'policy.writerCandidateRef'),
  };
}

function policyReasons(candidate, policy) {
  const reasons = [];
  if (!candidate.enabled) reasons.push('candidate-disabled');
  if (policy.allowedRuntimes
      && !policy.allowedRuntimes.includes(candidate.runtime)) {
    reasons.push('runtime-not-allowed');
  }
  if (policy.deniedRuntimes.includes(candidate.runtime)) {
    reasons.push('runtime-denied');
  }
  if (policy.allowedCandidateRefs
      && !policy.allowedCandidateRefs.includes(candidate.ref)) {
    reasons.push('candidate-not-allowed');
  }
  if (policy.deniedCandidateRefs.includes(candidate.ref)) {
    reasons.push('candidate-denied');
  }
  return reasons;
}

function missingCapabilities(candidate, required) {
  return required.filter((capability) =>
    !candidate.effectiveCapabilities.includes(capability));
}

function assignment(candidate, access) {
  return {
    candidateRef: candidate.ref,
    providerKey: candidate.providerKey,
    runtime: candidate.runtime,
    profileId: candidate.profileId,
    adapter: candidate.adapter,
    access,
    capabilitySnapshotHash: candidate.snapshotHash,
  };
}

function hashRouteDecision(decision) {
  if (decision === null || typeof decision !== 'object'
      || Array.isArray(decision)) {
    throw new Error('route decision must be an object');
  }
  const { decisionHash: ignored, ...hashable } = decision;
  return stableHash(hashable);
}

function decideRoute({ task, candidates, policy = {} } = {}) {
  const normalizedTask = normalizeTask(task);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('candidates must be a non-empty array');
  }
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedCandidates = candidates
    .map(normalizeCandidate)
    .sort((left, right) =>
      left.priority - right.priority || left.ref.localeCompare(right.ref));
  const refs = normalizedCandidates.map((candidate) => candidate.ref);
  if (new Set(refs).size !== refs.length) {
    throw new Error('candidate refs must be unique');
  }

  const primaryRequirements = [...new Set([
    ...normalizedTask.requiredCapabilities,
    ...(normalizedTask.intent === 'write' ? ['workspace-write'] : []),
  ])].sort();
  const readOnlyRequirements = normalizedTask.requiredCapabilities
    .filter((capability) => capability !== 'workspace-write');
  if (!readOnlyRequirements.includes('repo-read')) {
    readOnlyRequirements.push('repo-read');
    readOnlyRequirements.sort();
  }

  const baseReasons = new Map(normalizedCandidates.map((candidate) => [
    candidate.ref,
    policyReasons(candidate, normalizedPolicy),
  ]));
  const primaryEligible = normalizedCandidates.filter((candidate) => {
    const reasons = baseReasons.get(candidate.ref);
    const missing = missingCapabilities(candidate, primaryRequirements);
    if (missing.length > 0) {
      reasons.push(...missing.map((capability) =>
        `missing-capability:${capability}`));
    }
    if (normalizedTask.intent === 'write'
        && normalizedPolicy.writerCandidateRef
        && candidate.ref !== normalizedPolicy.writerCandidateRef) {
      reasons.push('not-designated-writer');
    }
    if (normalizedTask.partialEffects
        && normalizedTask.resumeProviderRef
        && candidate.ref !== normalizedTask.resumeProviderRef) {
      reasons.push('partial-effects-writer-switch');
    }
    return reasons.length === 0;
  });

  let primaryCandidate = primaryEligible[0] || null;
  if (normalizedTask.effectsState === 'committed') {
    primaryCandidate = null;
    for (const candidate of normalizedCandidates) {
      baseReasons.get(candidate.ref).push('committed-effects-terminal');
    }
  } else if (normalizedTask.partialEffects && !normalizedTask.resumeProviderRef) {
    primaryCandidate = null;
    for (const candidate of normalizedCandidates) {
      baseReasons.get(candidate.ref).push('partial-effects-require-resume');
    }
  }

  let fallbacks = [];
  if (primaryCandidate
      && !normalizedTask.partialEffects
      && normalizedPolicy.allowReadOnlyFallback) {
    fallbacks = normalizedCandidates
      .filter((candidate) => candidate.ref !== primaryCandidate.ref)
      .filter((candidate) =>
        policyReasons(candidate, normalizedPolicy).length === 0
          && missingCapabilities(candidate, readOnlyRequirements).length === 0)
      .map((candidate) => assignment(candidate, 'read-only'));
  }

  const status = primaryCandidate ? 'selected' : 'blocked';
  const primary = primaryCandidate
    ? assignment(
      primaryCandidate,
      normalizedTask.intent === 'write' ? 'write' : 'read-only'
    )
    : null;
  const writer = primary && primary.access === 'write' ? primary : null;
  let fallbackPolicy;
  if (normalizedTask.partialEffects) {
    fallbackPolicy = { allowed: false, reason: 'partial-effects' };
  } else if (!normalizedPolicy.allowReadOnlyFallback) {
    fallbackPolicy = { allowed: false, reason: 'policy-disabled' };
  } else if (!primary) {
    fallbackPolicy = { allowed: false, reason: 'no-primary' };
  } else if (fallbacks.length === 0) {
    fallbackPolicy = { allowed: false, reason: 'no-read-only-candidate' };
  } else {
    fallbackPolicy = {
      allowed: true,
      reason: 'pre-effects-read-only-only',
    };
  }
  const selectedRefs = new Set([
    ...(primary ? [primary.candidateRef] : []),
    ...fallbacks.map((fallback) => fallback.candidateRef),
  ]);
  const rejected = normalizedCandidates
    .filter((candidate) => !selectedRefs.has(candidate.ref))
    .map((candidate) => ({
      candidateRef: candidate.ref,
      reasons: [...new Set(baseReasons.get(candidate.ref))].sort(),
    }));
  const decision = {
    schemaVersion: 'route-decision-v1',
    taskRef: normalizedTask.ref,
    taskHash: normalizedTask.hash,
    orchestrationOwner: normalizedTask.orchestrationOwner,
    intent: normalizedTask.intent,
    status,
    primary,
    writer,
    fallbacks,
    fallbackPolicy,
    rejected,
  };
  return {
    ...decision,
    decisionHash: stableHash(decision),
  };
}

module.exports = {
  ORCHESTRATION_OWNERS,
  decideRoute,
  hashRouteDecision,
  stableHash,
  stableStringify,
};
