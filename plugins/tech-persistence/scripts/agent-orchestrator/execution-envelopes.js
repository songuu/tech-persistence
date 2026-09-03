'use strict';

const {
  ORCHESTRATION_OWNERS,
  hashRouteDecision,
} = require('./capability-router');
const {
  canonicalize,
  normalizeStringArray,
  stableHash,
} = require('./runtime-capabilities');
const {
  redactArtifactValue,
  redactSensitiveText,
} = require('../lib/redaction');
const acceptance = require('../lib/acceptance-contract');

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTINUATION_POLICIES = Object.freeze(['continue', 'pause', 'stop']);
const COORDINATION_FIELDS = new Set([
  'taskClass',
  'actionKind',
  'continuationPolicy',
  'successorRefs',
  'noFollowUp',
  'claimedBy',
]);

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalObject(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return canonicalize(value, new Set(), label);
}

function redactSensitiveKeys(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/^(?:authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd)$/i.test(key)) {
      return [key, '[REDACTED]'];
    }
    return [key, redactSensitiveKeys(item)];
  }));
}

function redactedCanonicalObject(value, label) {
  const canonical = canonicalObject(value, label);
  const structurallyRedacted = redactSensitiveKeys(
    redactArtifactValue(canonical)
  );
  const serialized = redactSensitiveText(JSON.stringify(structurallyRedacted));
  try {
    return canonicalObject(JSON.parse(serialized), label);
  } catch (error) {
    throw new Error(`${label} could not be redacted as canonical JSON: ${error.message}`);
  }
}

function normalizeRuntimeRefs(value) {
  const refs = redactedCanonicalObject(value, 'runtimeRefs');
  for (const [key, ref] of Object.entries(refs)) {
    if (ref !== null && (typeof ref !== 'string' || ref.trim() === '')) {
      throw new Error(`runtimeRefs.${key} must be a non-empty string or null`);
    }
    if (typeof ref === 'string') refs[key] = ref.trim();
  }
  return refs;
}

function normalizeTaskCoordination(value) {
  if (value === undefined) return undefined;
  const source = canonicalObject(value, 'coordination');
  const unsupported = Object.keys(source).find((key) => !COORDINATION_FIELDS.has(key));
  if (unsupported) {
    throw new Error(`coordination.${unsupported} is unsupported`);
  }
  const continuationPolicy = nonEmptyString(
    source.continuationPolicy,
    'coordination.continuationPolicy'
  );
  if (!CONTINUATION_POLICIES.includes(continuationPolicy)) {
    throw new Error(
      `coordination.continuationPolicy must be one of: ${CONTINUATION_POLICIES.join(', ')}`
    );
  }
  const successorRefs = normalizeStringArray(
    source.successorRefs,
    'coordination.successorRefs'
  );
  if (typeof source.noFollowUp !== 'boolean') {
    throw new Error('coordination.noFollowUp must be a boolean');
  }
  if (source.noFollowUp && successorRefs.length > 0) {
    throw new Error(
      'coordination.noFollowUp cannot be true when coordination.successorRefs is non-empty'
    );
  }
  const coordination = {
    taskClass: nonEmptyString(source.taskClass, 'coordination.taskClass'),
    actionKind: nonEmptyString(source.actionKind, 'coordination.actionKind'),
    continuationPolicy,
    successorRefs,
    noFollowUp: source.noFollowUp,
  };
  if (source.claimedBy !== undefined) {
    // A soft owner is observable coordination metadata, never route authority.
    coordination.claimedBy = nonEmptyString(
      source.claimedBy,
      'coordination.claimedBy'
    );
  }
  return coordination;
}

function normalizeNativeEvidence(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('native must be an object or null');
  }
  const nativeAccepted = value.nativeAccepted;
  if (typeof nativeAccepted !== 'boolean') {
    throw new Error('native.nativeAccepted must be a boolean');
  }
  const optionalString = (field) => {
    const item = value[field];
    if (item === undefined || item === null) return null;
    return nonEmptyString(item, `native.${field}`);
  };
  return {
    runtime: optionalString('runtime'),
    adapter: optionalString('adapter'),
    nativeAccepted,
    terminalEvent: optionalString('terminalEvent'),
    terminalStatus: optionalString('terminalStatus'),
    acceptanceErrors: normalizeStringArray(
      value.acceptanceErrors || [],
      'native.acceptanceErrors'
    ),
  };
}

function deriveIdempotencyKey(input) {
  return `idem:${stableHash(canonicalize(input)).slice('sha256:'.length)}`;
}

function roleIntent(role) {
  const intents = {
    tp_explorer: 'read-only',
    tp_implementer: 'write',
    tp_reviewer: 'read-only',
  };
  const normalized = nonEmptyString(role, 'role');
  if (!Object.prototype.hasOwnProperty.call(intents, normalized)) {
    throw new Error(`unsupported agent role ${normalized}`);
  }
  return { role: normalized, intent: intents[normalized] };
}

function normalizeEnforcement(value) {
  const enforcement = value || 'contract-enforced';
  if (!['contract-enforced', 'native-enforced'].includes(enforcement)) {
    throw new Error('enforcement must be contract-enforced or native-enforced');
  }
  return enforcement;
}

function normalizeWorkspace(input) {
  const workspaceMode = input.workspaceMode || 'shared';
  if (!['shared', 'isolated'].includes(workspaceMode)) {
    throw new Error('workspaceMode must be shared or isolated');
  }
  const worktreeRef = input.worktreeRef === undefined || input.worktreeRef === null
    ? null
    : nonEmptyString(input.worktreeRef, 'worktreeRef');
  if (workspaceMode === 'isolated' && !worktreeRef) {
    throw new Error('isolated workspaceMode requires worktreeRef');
  }
  return { workspaceMode, worktreeRef };
}

function normalizeAssignmentTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error('assignment task envelope is required');
  }
  return {
    taskRef: nonEmptyString(task.ref, 'task.ref'),
    taskHash: nonEmptyString(task.hash, 'task.hash'),
    taskIdempotencyKey: nonEmptyString(task.idempotencyKey, 'task.idempotencyKey'),
  };
}

function createAgentAssignment(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('agent assignment input must be an object');
  }
  const task = normalizeAssignmentTask(input.task);
  const assigned = roleIntent(input.role);
  const intent = input.intent || assigned.intent;
  if (intent !== assigned.intent) {
    throw new Error(`${assigned.role} is ${assigned.intent}`);
  }
  const ownedFiles = normalizeStringArray(input.ownedFiles || [], 'ownedFiles');
  const readFiles = normalizeStringArray(input.readFiles || [], 'readFiles');
  if (intent === 'write' && ownedFiles.length === 0) {
    throw new Error('write agent assignment requires ownedFiles');
  }
  if (ownedFiles.some((file) => readFiles.includes(file))) {
    throw new Error('ownedFiles and readFiles must not overlap');
  }
  const workspace = normalizeWorkspace(input);
  const enforcement = normalizeEnforcement(input.enforcement);
  const core = {
    schemaVersion: 'agent-assignment-v1',
    kind: 'agent-assignment',
    ref: nonEmptyString(input.ref, 'ref'),
    ...task,
    sliceRef: nonEmptyString(input.sliceRef, 'sliceRef'),
    role: assigned.role,
    intent,
    ownedFiles,
    readFiles,
    ...workspace,
    enforcement,
    requiredCapabilities: normalizeStringArray(
      input.requiredCapabilities || [],
      'requiredCapabilities'
    ),
  };
  const hash = stableHash(core);
  return {
    ...core,
    hash,
    idempotencyKey: deriveIdempotencyKey({
      kind: core.kind,
      ref: core.ref,
      taskHash: core.taskHash,
      sliceRef: core.sliceRef,
      hash,
    }),
  };
}

function normalizeInvocationNative(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invocation native proof is required');
  }
  if (typeof value.nativeAccepted !== 'boolean') {
    throw new Error('native.nativeAccepted must be a boolean');
  }
  const optional = (field) => value[field] === undefined || value[field] === null
    ? null
    : nonEmptyString(value[field], `native.${field}`);
  return {
    nativeAccepted: value.nativeAccepted,
    terminalEvent: optional('terminalEvent'),
    terminalStatus: optional('terminalStatus'),
    acceptanceErrors: normalizeStringArray(
      value.acceptanceErrors || [],
      'native.acceptanceErrors'
    ),
  };
}

function createAgentInvocation(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('agent invocation input must be an object');
  }
  const assignment = input.assignment;
  if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
    throw new Error('agent invocation assignment is required');
  }
  const enforcement = normalizeEnforcement(input.enforcement);
  if (enforcement !== assignment.enforcement) {
    throw new Error('invocation enforcement must match assignment');
  }
  const status = input.status || 'planned';
  if (!['planned', 'started', 'completed', 'failed', 'blocked'].includes(status)) {
    throw new Error('invocation status is unsupported');
  }
  const actualRole = input.actualRole === undefined || input.actualRole === null
    ? null
    : nonEmptyString(input.actualRole, 'actualRole');
  const native = normalizeInvocationNative(input.native);
  if (actualRole !== null && actualRole !== assignment.role) {
    throw new Error('actualRole must match assignment role');
  }
  if (enforcement === 'contract-enforced') {
    if (actualRole !== null || native.nativeAccepted) {
      throw new Error('contract-enforced invocation cannot claim a native role');
    }
  } else if (status === 'completed') {
    if (actualRole === null) {
      throw new Error('native-enforced completed invocation requires actualRole');
    }
    if (!native.nativeAccepted) {
      throw new Error('native-enforced completed invocation requires native acceptance');
    }
  }
  const core = {
    schemaVersion: 'agent-invocation-v1',
    kind: 'agent-invocation',
    ref: nonEmptyString(input.ref, 'ref'),
    assignmentRef: nonEmptyString(assignment.ref, 'assignment.ref'),
    assignmentHash: nonEmptyString(assignment.hash, 'assignment.hash'),
    assignmentIdempotencyKey: nonEmptyString(
      assignment.idempotencyKey,
      'assignment.idempotencyKey'
    ),
    runtime: nonEmptyString(input.runtime, 'runtime'),
    adapter: nonEmptyString(input.adapter, 'adapter'),
    enforcement,
    status,
    actualRole,
    runtimeRefs: normalizeRuntimeRefs(input.runtimeRefs || {}),
    native,
  };
  const hash = stableHash(core);
  return {
    ...core,
    hash,
    idempotencyKey: deriveIdempotencyKey({
      kind: core.kind,
      ref: core.ref,
      assignmentHash: core.assignmentHash,
      status: core.status,
      hash,
    }),
  };
}

function validateAgentInvocation(assignment, invocation) {
  const errors = [];
  if (!assignment || typeof assignment !== 'object') {
    errors.push('agent assignment is missing');
  }
  if (!invocation || typeof invocation !== 'object') {
    errors.push('agent invocation is missing');
  }
  if (errors.length > 0) return { accepted: false, errors };
  const { hash: assignmentHash, idempotencyKey: assignmentKey, ...assignmentCore } = assignment;
  if (!HASH_PATTERN.test(assignmentHash) || stableHash(assignmentCore) !== assignmentHash) {
    errors.push('agent assignment hash does not match');
  }
  if (assignmentKey !== deriveIdempotencyKey({
    kind: assignment.kind,
    ref: assignment.ref,
    taskHash: assignment.taskHash,
    sliceRef: assignment.sliceRef,
    hash: assignment.hash,
  })) {
    errors.push('agent assignment idempotency key does not match');
  }
  if (invocation.assignmentRef !== assignment.ref
      || invocation.assignmentHash !== assignment.hash
      || invocation.assignmentIdempotencyKey !== assignment.idempotencyKey) {
    errors.push('agent invocation does not belong to assignment');
  }
  if (invocation.enforcement !== assignment.enforcement) {
    errors.push('agent invocation enforcement does not match assignment');
  }
  if (invocation.actualRole !== null && invocation.actualRole !== assignment.role) {
    errors.push('agent invocation role does not match assignment');
  }
  if (assignment.enforcement === 'native-enforced'
      && invocation.status === 'completed') {
    if (invocation.actualRole !== assignment.role) {
      errors.push('native assignment completed without assigned role proof');
    }
    if (!invocation.native || invocation.native.nativeAccepted !== true) {
      errors.push('native assignment completed without native acceptance');
    }
  }
  if (assignment.enforcement === 'contract-enforced'
      && (invocation.actualRole !== null
        || (invocation.native && invocation.native.nativeAccepted))) {
    errors.push('contract assignment claims native role execution');
  }
  const { hash: invocationHash, idempotencyKey: invocationKey, ...invocationCore } = invocation;
  if (!HASH_PATTERN.test(invocationHash) || stableHash(invocationCore) !== invocationHash) {
    errors.push('agent invocation hash does not match');
  }
  if (invocationKey !== deriveIdempotencyKey({
    kind: invocation.kind,
    ref: invocation.ref,
    assignmentHash: invocation.assignmentHash,
    status: invocation.status,
    hash: invocation.hash,
  })) {
    errors.push('agent invocation idempotency key does not match');
  }
  return { accepted: errors.length === 0, errors };
}
function createTaskEnvelope(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('task envelope input must be an object');
  }
  const ref = nonEmptyString(input.ref, 'ref');
  const orchestrationOwner = nonEmptyString(
    input.orchestrationOwner,
    'orchestrationOwner'
  );
  if (!ORCHESTRATION_OWNERS.includes(orchestrationOwner)) {
    throw new Error(
      `orchestrationOwner must be one of: ${ORCHESTRATION_OWNERS.join(', ')}`
    );
  }
  const intent = input.intent || 'read-only';
  if (!['read-only', 'write'].includes(intent)) {
    throw new Error('intent must be read-only or write');
  }
  const coordination = normalizeTaskCoordination(input.coordination);
  const core = {
    schemaVersion: 'task-envelope-v1',
    kind: 'task',
    ref,
    orchestrationOwner,
    intent,
    requiredCapabilities: normalizeStringArray(
      input.requiredCapabilities || [],
      'requiredCapabilities'
    ),
    runtimeRefs: normalizeRuntimeRefs(input.runtimeRefs || {}),
    ...(coordination === undefined
      ? {}
      : { coordination }),
    payload: canonicalObject(input.payload, 'payload'),
  };
  const hash = stableHash(core);
  return {
    ...core,
    hash,
    idempotencyKey: deriveIdempotencyKey({
      kind: core.kind,
      ref,
      hash,
    }),
  };
}

function normalizeEffects(value) {
  const effects = value === undefined ? {} : value;
  if (effects === null || typeof effects !== 'object'
      || Array.isArray(effects)) {
    throw new Error('effects must be an object');
  }
  const state = effects.state || 'none';
  if (!['none', 'partial', 'committed'].includes(state)) {
    throw new Error('effects.state must be none, partial, or committed');
  }
  const refs = normalizeStringArray(effects.refs || [], 'effects.refs');
  if (state === 'none' && refs.length > 0) {
    throw new Error('effects.refs must be empty when effects.state is none');
  }
  return { state, refs };
}

function createResultEnvelope(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('result envelope input must be an object');
  }
  const task = input.task;
  const route = input.route;
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error('task envelope is required');
  }
  if (route === null || typeof route !== 'object' || Array.isArray(route)) {
    throw new Error('route decision is required');
  }
  const ref = nonEmptyString(input.ref, 'ref');
  const providerRef = nonEmptyString(input.providerRef, 'providerRef');
  const status = input.status;
  if (!['succeeded', 'failed', 'blocked'].includes(status)) {
    throw new Error('status must be succeeded, failed, or blocked');
  }
  const core = {
    schemaVersion: 'result-envelope-v1',
    kind: 'result',
    ref,
    taskRef: nonEmptyString(task.ref, 'task.ref'),
    taskHash: nonEmptyString(task.hash, 'task.hash'),
    taskIdempotencyKey: nonEmptyString(
      task.idempotencyKey,
      'task.idempotencyKey'
    ),
    routeHash: nonEmptyString(route.decisionHash, 'route.decisionHash'),
    providerRef,
    status,
    effects: normalizeEffects(input.effects),
    runtimeRefs: normalizeRuntimeRefs(input.runtimeRefs || {}),
    native: normalizeNativeEvidence(input.native),
    evidence: redactedCanonicalObject(input.evidence, 'evidence'),
    payload: redactedCanonicalObject(input.payload, 'payload'),
  };
  const hash = stableHash(core);
  return {
    ...core,
    hash,
    idempotencyKey: deriveIdempotencyKey({
      kind: core.kind,
      ref,
      taskIdempotencyKey: core.taskIdempotencyKey,
      routeHash: core.routeHash,
      providerRef,
    }),
  };
}

function acceptanceSubjectForResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('result envelope is required for acceptance subject');
  }
  const { hash, idempotencyKey, ...core } = result;
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash) || stableHash(core) !== hash) {
    throw new Error('result envelope hash does not match acceptance subject');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new Error('result envelope idempotency key is required');
  }
  return canonicalize(core);
}

function createAcceptanceReceiptProjection(input = {}) {
  const contract = acceptance.assertAcceptanceContract(input.contract);
  const receipt = acceptance.assertAcceptanceReceipt(input.receipt, { contract });
  const counts = { passed: 0, failed: 0, unknown: 0 };
  for (const result of receipt.results) counts[result.status] += 1;
  return canonicalize({
    mode: 'shadow',
    contractRef: nonEmptyString(input.contractRef, 'acceptance contractRef'),
    contractHash: contract.contractHash,
    receiptRef: nonEmptyString(input.receiptRef, 'acceptance receiptRef'),
    receiptHash: receipt.receiptHash,
    subjectRef: receipt.subjectRef,
    subjectHash: receipt.subjectHash,
    overallStatus: receipt.overallStatus,
    counts,
  });
}

function createProviderHandoff(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('provider handoff input must be an object');
  }
  const { task, route, result } = input;
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error('task envelope is required');
  }
  if (route === null || typeof route !== 'object' || Array.isArray(route)) {
    throw new Error('route decision is required');
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('result envelope is required');
  }
  if (typeof input.readOnly !== 'boolean') {
    throw new Error('readOnly must be a boolean');
  }
  const ref = nonEmptyString(input.ref, 'ref');
  const from = nonEmptyString(input.from, 'from');
  const to = nonEmptyString(input.to, 'to');
  if (result.taskRef !== task.ref || result.taskHash !== task.hash) {
    throw new Error('result does not belong to task');
  }
  if (route.taskRef !== task.ref || route.taskHash !== task.hash
      || result.routeHash !== route.decisionHash
      || hashRouteDecision(route) !== route.decisionHash) {
    throw new Error('task, result, and route hashes do not match');
  }
  if (result.effects && result.effects.state === 'partial' && to !== from) {
    throw new Error('provider switching is forbidden after partial effects');
  }
  const routedFallback = Array.isArray(route.fallbacks)
    && route.fallbacks.find((fallback) => fallback.candidateRef === to);
  if (routedFallback && !input.readOnly) {
    throw new Error('routed fallback must remain read-only');
  }
  if (!input.readOnly
      && (!route.writer || route.writer.candidateRef !== to)) {
    throw new Error('writable handoff target must be the single route writer');
  }
  const core = {
    schemaVersion: 'provider-handoff-v1',
    kind: 'provider-handoff',
    ref,
    taskRef: nonEmptyString(task.ref, 'task.ref'),
    taskHash: nonEmptyString(task.hash, 'task.hash'),
    resultRef: nonEmptyString(result.ref, 'result.ref'),
    resultHash: nonEmptyString(result.hash, 'result.hash'),
    routeHash: nonEmptyString(route.decisionHash, 'route.decisionHash'),
    from,
    to,
    readOnly: input.readOnly,
    runtimeRefs: normalizeRuntimeRefs(input.runtimeRefs || {}),
  };
  const hash = stableHash(core);
  return {
    ...core,
    hash,
    idempotencyKey: deriveIdempotencyKey({
      kind: core.kind,
      ref,
      taskHash: core.taskHash,
      resultHash: core.resultHash,
      routeHash: core.routeHash,
      from,
      to,
      readOnly: core.readOnly,
    }),
  };
}

function validateNativeEvidence(result, route, errors) {
  const native = result.native;
  if (!native || typeof native !== 'object') {
    errors.push('native runtime evidence is missing');
    return;
  }
  if (native.nativeAccepted !== true) {
    errors.push('native runtime result was not accepted');
  }
  const routed = route.primary || null;
  const expectedRuntime = routed && routed.runtime
    ? routed.runtime
    : String(result.providerRef || '').split(':')[0];
  const expectedAdapter = routed && routed.adapter
    ? routed.adapter
    : String(result.providerRef || '').split(':').slice(-1)[0];
  if (native.runtime !== expectedRuntime) {
    errors.push('native runtime does not match result provider');
  }
  if (native.adapter !== expectedAdapter) {
    errors.push('native adapter does not match result provider');
  }
  if (native.runtime === 'claude') {
    if (native.terminalEvent !== 'result'
        || native.terminalStatus !== 'success') {
      errors.push('claude native terminal evidence is invalid');
    }
    if (typeof result.runtimeRefs.claudeSession !== 'string'
        || result.runtimeRefs.claudeSession.trim() === '') {
      errors.push('claude native session ref is missing');
    }
  } else if (native.runtime === 'codex') {
    if (!['turn.completed', 'turn/completed', 'turn_completed']
      .includes(native.terminalEvent)
        || native.terminalStatus !== 'completed') {
      errors.push('codex native terminal evidence is invalid');
    }
    if (typeof result.runtimeRefs.codexThread !== 'string'
        || result.runtimeRefs.codexThread.trim() === '') {
      errors.push('codex native thread ref is missing');
    }
  } else if (native.runtime === 'openai-compatible') {
    if (native.terminalEvent !== 'chat.completion' || native.terminalStatus !== 'stop'
        || route.intent !== 'read-only' || route.writer !== null
        || typeof result.runtimeRefs.externalSession !== 'string'
        || typeof result.runtimeRefs.externalRequest !== 'string'
        || typeof result.runtimeRefs.completionId !== 'string') {
      errors.push('external read-only terminal evidence is invalid');
    }
  } else {
    errors.push('native runtime is unsupported');
  }
}

function validateResultForAcceptance(task, result, route, options = {}) {
  const errors = [];
  if (!task || typeof task !== 'object') errors.push('task envelope is missing');
  if (!result || typeof result !== 'object') errors.push('result envelope is missing');
  if (!route || typeof route !== 'object') errors.push('route decision is missing');
  if (errors.length > 0) {
    return { accepted: false, errors, fallbackAllowed: false };
  }
  const { hash: taskHash, idempotencyKey: taskKey, ...taskCore } = task;
  if (!HASH_PATTERN.test(taskHash) || stableHash(taskCore) !== taskHash) {
    errors.push('task content hash does not match');
  }
  if (taskKey !== deriveIdempotencyKey({
    kind: task.kind,
    ref: task.ref,
    hash: task.hash,
  })) {
    errors.push('task idempotency key does not match');
  }
  if (result.taskRef !== task.ref) errors.push('result task ref does not match');
  if (result.taskHash !== task.hash) errors.push('result task hash does not match');
  if (result.taskIdempotencyKey !== task.idempotencyKey) {
    errors.push('result task idempotency key does not match');
  }
  if (route.taskRef !== task.ref) errors.push('route task ref does not match');
  if (route.taskHash !== task.hash) errors.push('route task hash does not match');
  if (route.orchestrationOwner !== task.orchestrationOwner) {
    errors.push('route orchestration owner does not match');
  }
  if (result.routeHash !== route.decisionHash
      || hashRouteDecision(route) !== route.decisionHash) {
    errors.push('result route hash does not match');
  }
  const routeMode = options.routeMode || 'enforce';
  if (!['off', 'shadow', 'enforce'].includes(routeMode)) {
    errors.push(`unsupported route mode: ${routeMode}`);
  }
  if (routeMode === 'enforce' && (route.status !== 'selected' || !route.primary)) {
    errors.push('route has no selected primary');
  } else if (route.primary
      && result.providerRef !== route.primary.candidateRef) {
    errors.push('result provider does not match route primary');
  }
  if (options.requireNativeEvidence === true) {
    validateNativeEvidence(result, route, errors);
  }
  if (result.status !== 'succeeded') {
    errors.push(`result status is ${result.status}`);
  }
  const effectsState = result.effects && result.effects.state;
  if (effectsState === 'partial') errors.push('result has partial effects');
  if (task.intent === 'read-only' && effectsState !== 'none') {
    errors.push('read-only task reported write effects');
  }
  const { hash: resultHash, idempotencyKey: resultKey, ...resultCore } = result;
  if (typeof resultHash !== 'string' || !HASH_PATTERN.test(resultHash)) {
    errors.push('result hash is invalid');
  } else if (stableHash(resultCore) !== resultHash) {
    errors.push('result content hash does not match');
  }
  if (resultKey !== deriveIdempotencyKey({
    kind: result.kind,
    ref: result.ref,
    taskIdempotencyKey: result.taskIdempotencyKey,
    routeHash: result.routeHash,
    providerRef: result.providerRef,
  })) {
    errors.push('result idempotency key does not match');
  }
  const accepted = errors.length === 0;
  const fallbackAllowed = errors.length === 1
    && errors[0] === `result status is ${result.status}`
    && result.status !== 'succeeded'
    && effectsState === 'none'
    && route.fallbackPolicy
    && route.fallbackPolicy.allowed === true
    && Array.isArray(route.fallbacks)
    && route.fallbacks.length > 0
    && route.fallbacks.every((fallback) => fallback.access === 'read-only');
  return { accepted, errors, fallbackAllowed };
}

module.exports = {
  acceptanceSubjectForResult,
  createAcceptanceReceiptProjection,
  createAgentAssignment,
  createAgentInvocation,
  validateAgentInvocation,
  createProviderHandoff,
  createResultEnvelope,
  createTaskEnvelope,
  deriveIdempotencyKey,
  normalizeRuntimeRefs,
  validateResultForAcceptance,
};
