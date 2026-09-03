'use strict';

const providerProfiles = require('./provider-profiles');
const providerAdapterRegistry = require('./provider-adapter-registry');
const externalRuntimeGovernance = require('./external-runtime-governance');
const externalConfig = require('./external-runtime-config');
const { ORCHESTRATION_OWNERS, decideRoute } = require('./capability-router');
const { createCapabilitySnapshot, stableHash } = require('./runtime-capabilities');
const {
  createResultEnvelope,
  createTaskEnvelope,
  validateResultForAcceptance,
} = require('./execution-envelopes');

const ROUTER_MODES = Object.freeze(['off', 'shadow', 'enforce']);
const CLAUDE_ADAPTERS = Object.freeze(['print', 'bare', 'auto']);
const CODEX_ADAPTERS = Object.freeze(['exec', 'app-server', 'auto']);
const EXECUTION_POLICY_VERSION = 'execution-policy-v1';

function optionValue(options, key) {
  const value = options && options[key];
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function boolOption(options, key) {
  const value = optionValue(options, key);
  return value === true || value === 'true' || value === '1';
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function orchestrationOwner(options = {}, fallback = 'tp') {
  const value = String(optionValue(options, 'orchestration-owner') || fallback);
  return oneOf(value, ORCHESTRATION_OWNERS, 'orchestration owner');
}

function capabilityRouterMode(options = {}, fallback = 'shadow') {
  const value = String(optionValue(options, 'capability-router') || fallback);
  return oneOf(value, ROUTER_MODES, 'capability router mode');
}

function adapterPolicy(options = {}) {
  const routerMode = capabilityRouterMode(options);
  let claude = String(optionValue(options, 'claude-adapter') || 'print');
  let codex = String(optionValue(options, 'codex-adapter') || 'exec');
  oneOf(claude, CLAUDE_ADAPTERS, 'Claude adapter');
  oneOf(codex, CODEX_ADAPTERS, 'Codex adapter');
  if (claude === 'auto') claude = routerMode === 'enforce' ? 'bare' : 'print';
  if (codex === 'auto') codex = 'exec';
  if (codex === 'app-server' && !boolOption(options, 'allow-experimental-app-server')) {
    throw new Error('Codex App Server requires explicit opt-in with --allow-experimental-app-server');
  }
  return { claude, codex };
}

function executionPolicy(options = {}) {
  const config = externalConfig.configured(options);
  return {
    schemaVersion: EXECUTION_POLICY_VERSION,
    orchestrationOwner: orchestrationOwner(options),
    capabilityRouter: {
      mode: capabilityRouterMode(options),
    },
    adapterPolicy: adapterPolicy(options),
    allowExperimentalAppServer: boolOption(options, 'allow-experimental-app-server'),
    ...(config ? { external: { configFile: String(options['external-runtime-config']), configHash: config.configHash,
      stages: externalConfig.stages(options) } } : {}),
  };
}

function normalizePersistedExecutionPolicy(persisted) {
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
    throw new Error('persisted execution policy must be an object');
  }
  const normalized = {
    schemaVersion: persisted.schemaVersion || EXECUTION_POLICY_VERSION,
    orchestrationOwner: persisted.orchestrationOwner,
    capabilityRouter: persisted.capabilityRouter,
    adapterPolicy: persisted.adapterPolicy,
    allowExperimentalAppServer: persisted.allowExperimentalAppServer === true,
    ...(persisted.external ? { external: persisted.external } : {}),
  };
  if (normalized.schemaVersion !== EXECUTION_POLICY_VERSION) {
    throw new Error(`unsupported execution policy version: ${normalized.schemaVersion}`);
  }
  if (!normalized.capabilityRouter || !normalized.adapterPolicy) {
    throw new Error('persisted execution policy is incomplete');
  }
  return normalized;
}

function resolveExecutionPolicyOptions(options = {}, persisted) {
  if (!persisted) return { ...options };
  const expected = normalizePersistedExecutionPolicy(persisted);
  const resolvedOptions = { ...options };
  if (expected.external) {
    if (resolvedOptions['external-stages'] === undefined) resolvedOptions['external-stages'] = expected.external.stages.join(',');
    if (resolvedOptions['external-runtime-config'] === undefined) resolvedOptions['external-runtime-config'] = expected.external.configFile;
    resolvedOptions.externalConfigHash = expected.external.configHash;
  }
  if (optionValue(resolvedOptions, 'orchestration-owner') === undefined) {
    resolvedOptions['orchestration-owner'] = expected.orchestrationOwner;
  }
  if (optionValue(resolvedOptions, 'capability-router') === undefined) {
    resolvedOptions['capability-router'] = expected.capabilityRouter.mode;
  }
  if (optionValue(resolvedOptions, 'claude-adapter') === undefined) {
    resolvedOptions['claude-adapter'] = expected.adapterPolicy.claude;
  }
  if (optionValue(resolvedOptions, 'codex-adapter') === undefined) {
    resolvedOptions['codex-adapter'] = expected.adapterPolicy.codex;
  }
  if (expected.allowExperimentalAppServer
      && optionValue(resolvedOptions, 'allow-experimental-app-server') === undefined) {
    resolvedOptions['allow-experimental-app-server'] = true;
  }

  const actual = executionPolicy(resolvedOptions);
  if (stableHash(actual.external || null) !== stableHash(expected.external || null)) throw new Error('execution policy conflict for external runtime');
  const checks = [
    ['orchestration owner', actual.orchestrationOwner, expected.orchestrationOwner],
    ['capability router', actual.capabilityRouter.mode, expected.capabilityRouter.mode],
    ['claude adapter', actual.adapterPolicy.claude, expected.adapterPolicy.claude],
    ['codex adapter', actual.adapterPolicy.codex, expected.adapterPolicy.codex],
    [
      'experimental app-server opt-in',
      actual.allowExperimentalAppServer,
      expected.allowExperimentalAppServer,
    ],
  ];
  for (const [label, requested, stored] of checks) {
    if (requested !== stored) {
      throw new Error(
        `execution policy conflict for ${label}: persisted=${stored}, requested=${requested}`
      );
    }
  }
  return resolvedOptions;
}

function validateProviderRecovery(recovery, stageControl, input = {}) {
  if (!recovery || recovery.required !== true) return null;
  const matches = recovery.providerRef === stageControl.providerRef
    && recovery.providerKey === input.providerKey
    && recovery.runtime === stageControl.profile.runtime
    && recovery.stage === input.stage;
  if (!matches) {
    throw new Error(
      `same provider resume is required after provider failure: ${recovery.providerRef} ${recovery.stage}`
    );
  }
  return recovery;
}

function adapterId(profile, policy) {
  if (profile.runtime === 'openai-compatible') return 'openai-compatible-chat';
  if (profile.runtime === 'claude') return `claude-${policy.claude}`;
  return policy.codex === 'app-server' ? 'codex-app-server' : 'codex-exec';
}

function observedAdapterEvidence(providerKey, evidence) {
  const profile = providerProfiles.profile({}, providerKey);
  const input = evidence && typeof evidence === 'object'
    && !Array.isArray(evidence)
    ? evidence
    : {};
  const observations = input.runtimeObserved
    && typeof input.runtimeObserved === 'object'
    && !Array.isArray(input.runtimeObserved)
    ? input.runtimeObserved
    : {};
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  const observedAt = typeof input.observedAt === 'string'
    && !Number.isNaN(Date.parse(input.observedAt))
    ? input.observedAt
    : null;
  const isProbeEvidence = Boolean(
    observedAt
    && source
    && /(?:probe|preflight)/i.test(source)
  );
  return {
    runtimeObserved: Object.fromEntries(
      profile.capabilities.map((capability) => [
        capability,
        isProbeEvidence && [true, false, 'unknown'].includes(observations[capability])
          ? observations[capability]
          : 'unknown',
      ])
    ),
    probeError: isProbeEvidence && typeof input.probeError === 'string'
      ? input.probeError
      : null,
    observedAt: isProbeEvidence ? observedAt : null,
    source: isProbeEvidence ? source : 'static-profile',
  };
}

function buildCapabilitySnapshot(options, providerKey, evidence, policy) {
  const profile = providerProfiles.profile(options, providerKey);
  const input = evidence || {};
  return createCapabilitySnapshot({
    runtime: profile.runtime,
    profileId: profile.id,
    adapter: adapterId(profile, policy),
    declaredCapabilities: profile.capabilities,
    documentedMaturity: profile.documentedMaturity || 'unknown',
    runtimeObserved: input.runtimeObserved,
    probeError: input.probeError,
    observedAt: input.observedAt,
    source: input.source,
    policy: input.policy || {},
  });
}

function buildStageControl(input = {}) {
  const options = input.options || {};
  const profile = providerProfiles.profile(options, input.providerKey);
  if (!profile) throw new Error(`unknown provider key: ${input.providerKey}`);
  const policy = input.adapterPolicy || adapterPolicy(options);
  const owner = input.orchestrationOwner || orchestrationOwner(options);
  const config = externalConfig.configured(options);
  if (profile.runtime === 'openai-compatible' && input.intent === 'write') throw new Error('external runtime cannot be a writer');
  const externalEvidence = profile.runtime === 'openai-compatible' && config ? {
    runtimeObserved: Object.fromEntries(profile.capabilities.map((capability) => [capability, true])),
    source: 'authority-canary-probe', observedAt: config.canary.finishedAt,
  } : input.capabilityEvidence;
  const capabilitySnapshot = buildCapabilitySnapshot(
    options,
    input.providerKey,
    externalEvidence,
    policy
  );
  const task = createTaskEnvelope({
    ref: input.taskRef || `task:${input.runId}:${input.stage}`,
    orchestrationOwner: owner,
    intent: input.intent || (input.providerKey === 'implementation' ? 'write' : 'read-only'),
    requiredCapabilities: profile.capabilities,
    runtimeRefs: input.runtimeRefs || {},
    coordination: input.coordination,
    payload: input.payload || {},
  });
  const providerRef = `${profile.runtime}:${input.providerKey}:${capabilitySnapshot.adapter}`;
  const candidates = [{ ref: providerRef, providerKey: input.providerKey, priority: 10, snapshot: capabilitySnapshot }];
  if (config && profile.runtime !== 'openai-compatible') {
    const externalSnapshot = buildCapabilitySnapshot({ ...options, 'external-stages': 'spec' }, 'spec', {
      runtimeObserved: { stdin: true, 'structured-output': true, 'bounded-context': true },
      source: 'authority-canary-probe', observedAt: config.canary.finishedAt,
    }, policy);
    candidates.push({ ref: 'openai-compatible:spec:openai-compatible-chat', providerKey: 'spec', priority: 100, snapshot: externalSnapshot });
  }
  externalRuntimeGovernance.selectWriter(candidates.map(candidate => ({ id: candidate.ref,
    writerEligible: candidate.ref === providerRef && task.intent === 'write' })));
  const route = decideRoute({
    task,
    candidates,
    policy: {
      allowReadOnlyFallback: false,
      allowedCandidateRefs: [providerRef],
      ...(task.intent === 'write' ? { writerCandidateRef: providerRef } : {}),
    },
  });
  return {
    providerRef,
    profile,
    capabilitySnapshot,
    task,
    route,
    routeMode: capabilityRouterMode(options),
  };
}

function nativeEvidence(nativeResult) {
  if (!nativeResult || typeof nativeResult !== 'object'
      || Array.isArray(nativeResult)) {
    return null;
  }
  const terminal = nativeResult.terminalEvidence || {};
  return {
    runtime: nativeResult.runtime || null,
    adapter: nativeResult.adapter || null,
    nativeAccepted: nativeResult.nativeAccepted === true,
    terminalEvent: terminal.event || null,
    terminalStatus: terminal.status || null,
    acceptanceErrors: Array.isArray(nativeResult.nativeAcceptanceErrors)
      ? nativeResult.nativeAcceptanceErrors
      : [],
  };
}

function createAttemptResult(input = {}) {
  const stageControl = input.stageControl;
  if (!stageControl || !stageControl.task || !stageControl.route) {
    throw new Error('stageControl with task and route is required');
  }
  const result = createResultEnvelope({
    ref: input.ref,
    task: stageControl.task,
    route: stageControl.route,
    providerRef: stageControl.providerRef,
    status: input.status,
    effects: input.effects,
    runtimeRefs: input.runtimeRefs || {},
    native: nativeEvidence(input.nativeResult),
    evidence: input.evidence || {},
    payload: input.payload || {},
  });
  return {
    result,
    acceptance: validateResultForAcceptance(
      stageControl.task,
      result,
      stageControl.route,
      {
        routeMode: stageControl.routeMode || 'enforce',
        requireNativeEvidence: true,
      }
    ),
  };
}

function buildExecutionPlan(input = {}) {
  const options = input.options || {};
  const owner = orchestrationOwner(options);
  const policy = adapterPolicy(options);
  const evidenceByProvider = input.capabilityEvidenceByProvider || {};
  const stageDefinitions = {
    spec: { providerKey: 'spec', intent: 'read-only' },
    implementation: { providerKey: 'implementation', intent: 'write' },
    review: { providerKey: 'review', intent: 'read-only' },
  };
  const stages = {};
  const config = externalConfig.configured(options);
  const externalRuntime = resolveExternalRuntime(config ? config.promotion : input.externalPromotionReceipt);
  for (const [stage, definition] of Object.entries(stageDefinitions)) {
    const capabilityEvidence = evidenceByProvider[definition.providerKey]
      ? observedAdapterEvidence(
        definition.providerKey,
        evidenceByProvider[definition.providerKey]
      )
      : null;
    const stageControl = buildStageControl({
      options,
      adapterPolicy: policy,
      orchestrationOwner: owner,
      runId: input.runId,
      stage,
      providerKey: definition.providerKey,
      intent: definition.intent,
      payload: { requirementHash: input.requirementHash },
      capabilityEvidence,
    });
    stages[stage] = {
      profile: stageControl.profile,
      capabilities: stageControl.capabilitySnapshot,
      taskEnvelope: stageControl.task,
      routeDecision: stageControl.route,
    };
  }
  return {
    version: 'execution-plan-v2',
    orchestrationOwner: owner,
    adapterPolicy: policy,
    adapterRegistry: {
      mode: providerAdapterRegistry.REGISTRY_MODE,
      hash: providerAdapterRegistry.registryHash(),
    },
    externalRuntime,
    capabilityRouter: { mode: capabilityRouterMode(options) },
    requirementHash: input.requirementHash || null,
    planHash: stableHash({ owner, policy, adapterRegistry: {
      mode: providerAdapterRegistry.REGISTRY_MODE,
      hash: providerAdapterRegistry.registryHash(),
    }, externalRuntime, stages }),
    stages,
  };
}

function resolveExternalRuntime(receipt) {
  const descriptorId = 'openai-compatible-chat-v1';
  if (!receipt) return externalRuntimeGovernance.shadowDecision(
    descriptorId, { source: 'checked-in-descriptor', livePromotion: false }
  );
  const { receiptHash, ...core } = receipt;
  const checkNames = ['registered', 'observedCapability', 'fixedCanaryPassed', 'canaryReceiptBound', 'zeroEffects', 'identityMatched', 'environmentAllowed', 'explicitPromotion'];
  if (receiptHash !== stableHash(core)
      || receipt.version !== 'external-runtime-promotion-v1'
      || !/^sha256:[a-f0-9]{64}$/.test(receipt.canaryReceiptHash || '')
      || receipt.descriptorId !== descriptorId
      || receipt.descriptorHash !== externalRuntimeGovernance.descriptorHash(descriptorId)
      || receipt.eligible !== true || receipt.route !== 'read-only'
      || receipt.writerEligible !== false
      || !receipt.checks || Object.keys(receipt.checks).length !== checkNames.length
      || checkNames.some(key => receipt.checks[key] !== true)) {
    throw new Error('external runtime promotion receipt is invalid');
  }
  return Object.freeze({ ...receipt });
}

module.exports = {
  CLAUDE_ADAPTERS,
  CODEX_ADAPTERS,
  ROUTER_MODES,
  adapterPolicy,
  resolveExternalRuntime,
  buildExecutionPlan,
  buildStageControl,
  executionPolicy,
  resolveExecutionPolicyOptions,
  capabilityRouterMode,
  createAttemptResult,
  observedAdapterEvidence,
  orchestrationOwner,
  validateProviderRecovery,
};
