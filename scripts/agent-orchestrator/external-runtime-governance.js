'use strict';
const { stableHash } = require('./runtime-capabilities');
const { CASES: FIXED_CANARY_CASES } = require('./native-runtime-canary');

const DESCRIPTORS = Object.freeze({
  'openai-compatible-chat-v1': Object.freeze({
    id: 'openai-compatible-chat-v1',
    runtime: 'openai-compatible',
    protocol: 'openai-chat-completions',
    protocolEvidence: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
    protocolVerifiedAt: '2026-09-01',
    preferredOfficialApi: 'responses',
    compatibilityReason: 'sibling agent uses the OpenAI SDK with a custom baseURL',
    sourceReference: 'E:/project/ai/agent/src/shared/llm/openaiCompatible.ts',
    environmentAllowlist: Object.freeze(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']),
    capabilities: Object.freeze(['stdin', 'structured-output', 'bounded-context', 'event-correlation']),
    defaultRoute: 'shadow',
    writerEligible: false,
  }),
});

function descriptor(id) {
  if (!DESCRIPTORS[id]) throw new Error(`Unknown external runtime descriptor: ${id}`);
  return DESCRIPTORS[id];
}
function descriptorHash(id) { return stableHash(descriptor(id)); }

function shadowDecision(id, observation = {}) {
  const selected = descriptor(id);
  return {
    version: 'external-runtime-shadow-v1', descriptorId: id,
    descriptorHash: descriptorHash(id), route: 'shadow',
    workspaceDiff: [], externalEffects: [],
    capabilityHash: stableHash({ capabilities: selected.capabilities, observation }),
  };
}

function promotionDecision(input = {}) {
  const selected = descriptor(input.descriptorId);
  const allowlist = [...selected.environmentAllowlist].sort();
  const supplied = [...new Set(input.environmentKeys || [])].sort();
  const environmentAllowed = supplied.every((key) => allowlist.includes(key));
  const canary = input.canary || {};
  const canaryReceiptHash = typeof canary.receiptHash === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(canary.receiptHash) ? canary.receiptHash : null;
  const { receiptHash: ignoredCanaryHash, ...canaryCore } = canary;
  const canaryBound = Boolean(canaryReceiptHash && canaryReceiptHash === stableHash(canaryCore));
  const canaryCasesPassed = Array.isArray(canary.cases) && canary.cases.length === FIXED_CANARY_CASES.length && FIXED_CANARY_CASES.every((id) => Array.isArray(canary.cases)
    && canary.cases.some((item) => item && item.id === id && item.status === 'passed'));
  const eligible = input.registered === true && input.observedCapability === true
    && canary.status === 'passed' && canaryBound && canaryCasesPassed && canary.workspaceEffects === 0
    && canary.externalEffects === 0 && canary.identityMismatch === 0
    && environmentAllowed && input.explicitPromotion === true;
  const core = {
    version: 'external-runtime-promotion-v1', descriptorId: selected.id,
    descriptorHash: descriptorHash(selected.id), canaryReceiptHash, eligible: Boolean(eligible),
    route: eligible ? 'read-only' : 'shadow', writerEligible: false,
    checks: { registered: input.registered === true, observedCapability: input.observedCapability === true,
      fixedCanaryPassed: canary.status === 'passed' && canaryCasesPassed,
      canaryReceiptBound: canaryBound, zeroEffects: canary.workspaceEffects === 0 && canary.externalEffects === 0,
      identityMatched: canary.identityMismatch === 0, environmentAllowed, explicitPromotion: input.explicitPromotion === true },
  };
  return { ...core, receiptHash: stableHash(core) };
}

function selectWriter(candidates = [], currentWriter = null) {
  const writers = candidates.filter((candidate) => candidate.writerEligible === true);
  if (writers.length > 1) throw new Error('multiple writer candidates are forbidden');
  if (currentWriter && (currentWriter.partialEffects || currentWriter.committedEffects)
      && writers[0] && writers[0].id !== currentWriter.id) {
    throw new Error('provider switching is forbidden after partial or committed effects');
  }
  return writers[0] || currentWriter || null;
}
module.exports = { DESCRIPTORS, descriptor, descriptorHash, promotionDecision, selectWriter, shadowDecision };
