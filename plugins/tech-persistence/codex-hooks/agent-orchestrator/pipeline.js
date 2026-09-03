'use strict';

const fs = require('fs');
const path = require('path');

const state = require('./pipeline-state');
const queue = require('./queue');
const locks = require('./locks');
const globalContract = require('./global-contract');
const slicePlanner = require('./slice-planner');
const sliceNormalizer = require('./slice-normalizer');
const sliceRunner = require('./slice-runner');
const review = require('./review');
const drift = require('./drift-detector');
const reconciliation = require('./reconciliation');
const providers = require('./pipeline-providers');
const runLock = require('./run-lock');
const nativeExecutionControl = require('./native-execution-control');
const acceptanceEvaluator = require('./acceptance-evaluator');
const freezeReceipt = require('./freeze-receipt');

const { RUN_STATES, SLICE_STATES } = state;

const FREEZE_TARGETS = { GLOBAL_CONTRACT: 'global-contract', SLICE: 'slice' };
const RESOLVE_ACTIONS = {
  ACCEPT_REVISION: 'accept-revision',
  REJECT_REVISION: 'reject-revision',
  ABANDON: 'abandon',
};

function nowIso() {
  return new Date().toISOString();
}

function controlStoreOptions(ctx, options, providerRoot) {
  const controlRoot = ctx.optionValue(options, 'control-root');
  return {
    providerRoot: path.resolve(providerRoot || ctx.resolveWorkdir(options)),
    ...(controlRoot === undefined || controlRoot === true
      ? {}
      : { controlRoot: String(controlRoot) }),
  };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function appendJsonl(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(data)}\n`);
}

function appendPipelineEvent(runDir, event) {
  appendJsonl(path.join(runDir, 'pipeline.history.jsonl'), { ...event, at: nowIso() });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfExists(file, fallback = null) {
  return fs.existsSync(file) ? readJson(file) : fallback;
}

function newPipelineState(workdir, runDir, runId, requirement) {
  return {
    version: 'v7',
    mode: 'pipeline',
    runId,
    status: RUN_STATES.DRAFT,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    workdir,
    runDir,
    files: { requirement: 'requirement.md' },
    requirementPreview: requirement.slice(0, 240),
    pipeline: {
      globalContractFrozenAt: null,
      globalContractFrozenBy: null,
      sliceStates: {},
      reconciliationCounter: 0,
      autoSkipped: [],
      conflictRevisionIds: [],
      lastDriftReportAt: null,
      lastSliceBatchAt: null,
    },
    providerRuns: [],
    specFrozenAt: null,
    specFrozenBy: null,
  };
}

function saveState(statePath, draft) {
  const next = { ...draft, updatedAt: nowIso() };
  writeJson(statePath, next);
  return next;
}

function transitionRun(stateObj, target, metadata = {}) {
  return state.transitionRun(stateObj, target, { source: 'pipeline', ...metadata });
}

function transitionSlice(stateObj, sliceId, target, metadata = {}) {
  return state.transitionSlice(stateObj, sliceId, target, { source: 'pipeline', ...metadata });
}

function recordAutoSkip(stateObj, reason) {
  return {
    ...stateObj,
    pipeline: {
      ...stateObj.pipeline,
      autoSkipped: [...stateObj.pipeline.autoSkipped, { reason, at: nowIso() }],
    },
  };
}

function sliceEvidenceComplete(runDir, sliceId) {
  return ['handoff.json', 'diff.patch', 'changed-files-gate.json', 'validation.json'].every((name) =>
    fs.existsSync(path.join(runDir, 'slices', sliceId, name))
  );
}

function blockFailedSlice(ctx, current, statePath, runDir, slice, error, reasonPrefix = 'implementation failed') {
  const reason = `${reasonPrefix}: ${error && error.message ? error.message : String(error)}`;
  const providerRecord = error && error.providerRecord ? error.providerRecord : null;
  const failure = {
    sliceId: slice.id,
    failedAt: nowIso(),
    reason,
    providerRecord,
    lockAction: 'released',
    retryCommand: `node scripts/agent-orchestrator.js resume --run ${current.runId} --unblock ${slice.id}`,
  };
  writeJson(path.join(runDir, 'slices', slice.id, 'implementation-failure.json'), failure);
  appendPipelineEvent(runDir, {
    type: SLICE_STATES.IMPLEMENTATION_FAILED,
    sliceId: slice.id,
    reason,
    providerRecord,
    lockAction: 'released',
  });

  let q = queue.loadQueue(runDir);
  q = queue.moveToBlocked(q, slice.id, reason);
  queue.saveQueue(runDir, q);

  let locksNow = locks.loadLocks(runDir);
  locksNow = locks.releaseSliceLocks(locksNow, slice);
  locks.saveLocks(runDir, locksNow);

  let next = transitionSlice(current, slice.id, SLICE_STATES.IMPLEMENTATION_FAILED);
  if (providerRecord) {
    const providerRuns = Array.isArray(next.providerRuns) ? next.providerRuns : [];
    const duplicate = providerRuns.some((entry) => (
      entry.executionFingerprint === providerRecord.executionFingerprint
      && entry.startedAt === providerRecord.startedAt
    ));
    if (!duplicate) {
      next = {
        ...next,
        providerRuns: [...providerRuns, providerRecord],
      };
    }
  }
  if (error && error.providerRecovery) {
    next = {
      ...next,
      providerRecovery: error.providerRecovery,
    };
  }
  saveState(statePath, next);
  ctx.log(`[BLOCKED] slice ${slice.id} implementation failed; retry with: ${failure.retryCommand}`);
  return next;
}

function findDriftEntry(runDir, revisionId) {
  const report = readJsonIfExists(path.join(runDir, 'drift-report.json'), { revisions: [] });
  const entries = Array.isArray(report.revisions) ? report.revisions : [];
  return entries.find((entry) => entry.revisionId === revisionId) || null;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

function changedCriterionIds(previousContract, nextContract) {
  const previous = new Map((previousContract?.criteria || []).map((item) => [item.id, JSON.stringify(item)]));
  const next = new Map((nextContract?.criteria || []).map((item) => [item.id, JSON.stringify(item)]));
  return [...new Set([...previous.keys(), ...next.keys()])]
    .filter((id) => previous.get(id) !== next.get(id));
}

function criterionImpact(runDir, contract, changedIds) {
  const slices = slicePlanner.listSliceIds(runDir).map((id) => slicePlanner.loadSlice(runDir, id)).filter(Boolean);
  const owners = new Map();
  for (const slice of slices) for (const id of slice.criterionIds || []) {
    if (!owners.has(id)) owners.set(id, []);
    owners.get(id).push(slice.id);
  }
  for (const id of contract.integrationCriterionIds || []) {
    if (!owners.has(id)) owners.set(id, []);
    owners.get(id).push('integration');
  }
  const unmapped = changedIds.filter((id) => !owners.has(id) || owners.get(id).length !== 1);
  if (unmapped.length > 0) {
    throw new Error(`contract revision impact is incomplete; full run replan required for: ${unmapped.join(', ')}`);
  }
  const impacted = new Set(changedIds.flatMap((id) => owners.get(id)).filter((id) => id !== 'integration'));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const slice of slices) {
      if (!impacted.has(slice.id) && (slice.dependsOn || []).some((id) => impacted.has(id))) {
        impacted.add(slice.id); expanded = true;
      }
    }
  }
  return [...impacted].sort();
}

function markSlicesSuperseded(runDir, stateObj, q, sliceIds, revisionId) {
  let nextState = stateObj;
  let nextQueue = q;
  for (const sliceId of uniqueStrings(sliceIds)) {
    const slice = slicePlanner.loadSlice(runDir, sliceId);
    if (slice) {
      slicePlanner.writeSliceArtifacts(runDir, {
        ...slice,
        supersededByRevision: revisionId,
        supersededAt: nowIso(),
      });
    }
    const currentSliceState = nextState.pipeline.sliceStates[sliceId] || SLICE_STATES.PENDING;
    if (currentSliceState !== SLICE_STATES.REJECTED && currentSliceState !== SLICE_STATES.ABANDONED) {
      nextState = transitionSlice(nextState, sliceId, SLICE_STATES.REJECTED);
    }
    nextQueue = queue.moveToRejected(nextQueue, sliceId);
  }
  return { state: nextState, queue: nextQueue };
}

function filesOwnedBySlices(runDir, sliceIds) {
  return uniqueStrings(uniqueStrings(sliceIds).flatMap((sliceId) => {
    const slice = slicePlanner.loadSlice(runDir, sliceId);
    return slice && Array.isArray(slice.ownedFiles) ? slice.ownedFiles : [];
  }));
}

function createReconciliationSlice(runDir, stateObj, q, revision, completedSlices, contractHash) {
  const affectedSlices = uniqueStrings(completedSlices);
  if (affectedSlices.length === 0) return { state: stateObj, queue: q, slice: null };
  const fallbackIndex = slicePlanner.listSliceIds(runDir).length + (stateObj.pipeline.reconciliationCounter || 0);
  const slice = reconciliation.generateReconciliationSlice({
    revision,
    affectedSlices,
    affectedFiles: filesOwnedBySlices(runDir, affectedSlices),
    fallbackIndex,
    globalContractHash: contractHash,
  });
  slicePlanner.writeSliceArtifacts(runDir, slice, slice);
  let nextQueue = queue.moveToPending(q, slice.id);
  let nextState = {
    ...stateObj,
    pipeline: {
      ...stateObj.pipeline,
      reconciliationCounter: (stateObj.pipeline.reconciliationCounter || 0) + 1,
    },
  };
  nextState = transitionSlice(nextState, slice.id, SLICE_STATES.PENDING);
  const staticCheck = sliceNormalizer.evaluateStaticCanStart(slice);
  if (staticCheck.canStart && !slice.rejected) {
    nextQueue = queue.moveToReady(nextQueue, slice.id);
    nextState = transitionSlice(nextState, slice.id, SLICE_STATES.READY);
  }
  return { state: nextState, queue: nextQueue, slice };
}

function isContractSafeForAuto(contract) {
  if (!contract) return false;
  if (!['L0', 'L1', 'L2'].includes(contract.riskLevel)) return false;
  if (Array.isArray(contract.blockingQuestions) && contract.blockingQuestions.length > 0) return false;
  return true;
}

function ensureSliceDirsReady(runDir) {
  fs.mkdirSync(path.join(runDir, 'slices'), { recursive: true });
}

function dryRunGlobalContract(requirement) {
  return globalContract.normalizeGlobalContract({
    version: 'global-v1',
    goal: `[dry-run] ${requirement.split('\n')[0].slice(0, 160)}`,
    nonGoals: ['[dry-run placeholder non-goal]'],
    globalAcceptance: ['[dry-run placeholder acceptance]'],
    architectureConstraints: ['[dry-run placeholder constraint]'],
    runtimeTargets: ['claude-code', 'codex'],
    riskLevel: 'L1',
    blockingQuestions: [],
    integrationValidationCommands: [],
  });
}

function dryRunSliceBatch(globalContractDoc) {
  const sliceA = sliceNormalizer.normalizeSlice({
    id: 'slice-001',
    title: '[dry-run] placeholder slice',
    dependsOn: [],
    ownedFiles: ['dry-run-placeholder.txt'],
    readFiles: [],
    risk: 'L1',
    acceptanceCriteria: ['[dry-run] satisfies placeholder'],
    doneCriteria: ['[dry-run] file written'],
    validationCommands: [],
    questions: [],
  }, { fallbackIndex: 0, globalContractHash: globalContractDoc.contractHash });
  return [sliceNormalizer.rejectIfUnsafe(sliceA)];
}

function writePipelineSkeleton(runDir, requirement) {
  ensureSliceDirsReady(runDir);
  const queueState = queue.saveQueue(runDir, queue.emptyQueue());
  const lockState = locks.saveLocks(runDir, locks.emptyLocks());
  fs.writeFileSync(path.join(runDir, 'requirement.md'), `${requirement.trim()}\n`);
  return { queueState, lockState };
}

function freezePipelineRun(ctx, options, positionals) {
  const { runDir, statePath, state: stateObj } = ctx.loadRun(options, positionals);
  if (stateObj.mode !== 'pipeline') {
    throw new Error('freezePipelineRun: state.mode must be "pipeline"');
  }
  const target = ctx.optionValue(options, 'target');
  if (!target) {
    throw new Error('pipeline freeze requires --target {global-contract|slice}');
  }
  if (target === FREEZE_TARGETS.GLOBAL_CONTRACT) {
    return freezeGlobalContract(ctx, options, runDir, statePath, stateObj);
  }
  if (target === FREEZE_TARGETS.SLICE) {
    const sliceId = ctx.optionValue(options, 'slice-id');
    if (!sliceId) throw new Error('freeze --target slice requires --slice-id <id>');
    return freezeSlice(ctx, options, runDir, statePath, stateObj, sliceId);
  }
  throw new Error(`unknown freeze target: ${target}`);
}

function freezeGlobalContract(ctx, options, runDir, statePath, stateObj) {
  const contract = globalContract.loadGlobalContract(runDir);
  if (!contract) throw new Error('Cannot freeze: global-contract.json does not exist');
  if (Array.isArray(contract.blockingQuestions) && contract.blockingQuestions.length > 0) {
    throw new Error(`Cannot freeze global contract: ${contract.blockingQuestions.length} blocking question(s) remain.`);
  }
  const normalized = globalContract.writeGlobalContract(runDir, contract, 'freeze');
  const acceptanceContract = acceptanceEvaluator.recordAcceptanceContract({
    kind: 'global-contract',
    workdir: ctx.resolveWorkdir(options),
    runDir,
    source: normalized,
    controlStoreOptions: ctx.goalLeaseStoreOptions(options, ctx.resolveWorkdir(options)),
  });
  if (acceptanceContract.status !== 'written') {
    throw new Error(`Cannot freeze acceptance contract: ${acceptanceContract.error}`);
  }
  freezeReceipt.recordFreezeReceipt(runDir, {
    scopeRef: 'global',
    contractHash: acceptanceContract.contract.contractHash,
    frozenPayload: normalized,
  }, controlStoreOptions(ctx, options, ctx.resolveWorkdir(options)));
  let nextState = stateObj;
  if (nextState.status === RUN_STATES.GLOBAL_CONTRACT_READY) {
    nextState = transitionRun(nextState, RUN_STATES.GLOBAL_CONTRACT_FROZEN);
  } else if (nextState.status !== RUN_STATES.GLOBAL_CONTRACT_FROZEN) {
    throw new Error(`Cannot freeze global contract from status ${nextState.status}`);
  }
  nextState = {
    ...nextState,
    acceptanceProtocol: freezeReceipt.ACCEPTANCE_PROTOCOL,
    pipeline: {
      ...nextState.pipeline,
      globalFreezeScope: 'global',
      globalContractFrozenAt: nowIso(),
      globalContractFrozenBy: ctx.optionValue(options, 'reviewer') || process.env.USER || process.env.USERNAME || 'human',
    },
    files: {
      ...nextState.files,
      globalContract: 'global-contract.json',
      ...(acceptanceContract.status === 'written'
        ? { acceptanceContract: 'acceptance-contract.json' }
        : {}),
    },
  };
  saveState(statePath, nextState);
  ctx.log(`[OK] global contract frozen (hash=${normalized.contractHash})`);
  return nextState;
}

function freezeSlice(ctx, options, runDir, statePath, stateObj, sliceId) {
  const contract = globalContract.loadGlobalContract(runDir);
  if (!contract) throw new Error('Cannot freeze slice before global contract exists');
  const slice = slicePlanner.loadSlice(runDir, sliceId);
  if (!slice) throw new Error(`Cannot freeze slice: ${sliceId} not found`);
  const sliceStateNow = stateObj.pipeline.sliceStates[sliceId] || SLICE_STATES.PENDING;
  if (sliceStateNow !== SLICE_STATES.READY && sliceStateNow !== SLICE_STATES.PENDING) {
    throw new Error(`Cannot freeze slice ${sliceId}: current state ${sliceStateNow}`);
  }
  if (slice.rejected) {
    throw new Error(`Cannot freeze rejected slice ${sliceId}: ${(slice.rejectedReasons || []).join('; ')}`);
  }
  const staticCheck = sliceNormalizer.evaluateStaticCanStart(slice);
  if (!staticCheck.canStart) {
    throw new Error(`Cannot freeze slice ${sliceId}: ${staticCheck.reasons.join('; ')}`);
  }
  if (slice.contractHash && contract.contractHash && slice.contractHash !== sliceNormalizer.computeSliceHash(slice, contract.contractHash)) {
    // Hash drifted; rewrite slice with current global hash baseline before freezing.
    slice.contractHash = sliceNormalizer.computeSliceHash(slice, contract.contractHash);
    slicePlanner.writeSliceArtifacts(runDir, slice);
  }
  const globalScope = stateObj.pipeline.globalFreezeScope || 'global';
  const revisionSuffix = globalScope.includes('@') ? globalScope.slice(globalScope.indexOf('@')) : '';
  const sliceScope = `slice:${sliceId}${revisionSuffix}`;
  freezeReceipt.recordFreezeReceipt(runDir, {
    scopeRef: sliceScope,
    contractHash: contract.contractHash,
    frozenPayload: slice,
  }, controlStoreOptions(ctx, options, ctx.resolveWorkdir(options)));
  let nextState = stateObj;
  if (sliceStateNow === SLICE_STATES.PENDING) {
    nextState = transitionSlice(nextState, sliceId, SLICE_STATES.READY);
  }
  nextState = transitionSlice(nextState, sliceId, SLICE_STATES.FROZEN);
  nextState = { ...nextState, pipeline: { ...nextState.pipeline,
    sliceFreezeScopes: { ...(nextState.pipeline.sliceFreezeScopes || {}), [sliceId]: sliceScope } } };
  saveState(statePath, nextState);
  ctx.log(`[OK] slice ${sliceId} frozen (hash=${slice.contractHash})`);
  return nextState;
}

function resumePipelineRun(ctx, options, positionals) {
  const { runDir, statePath, state: stateObj } = ctx.loadRun(options, positionals);
  if (stateObj.mode !== 'pipeline') {
    throw new Error('resumePipelineRun: state.mode must be "pipeline"');
  }
  if (stateObj.acceptanceProtocol === freezeReceipt.ACCEPTANCE_PROTOCOL) {
    const contract = globalContract.loadGlobalContract(runDir);
    const acceptanceContract = JSON.parse(
      fs.readFileSync(path.join(runDir, 'acceptance-contract.json'), 'utf8')
    );
    const storeOptions = controlStoreOptions(ctx, options, ctx.resolveWorkdir(options));
    freezeReceipt.verifyFreezeReceipt(runDir, {
      scopeRef: stateObj.pipeline.globalFreezeScope || 'global',
      contractHash: acceptanceContract.contractHash,
      frozenPayload: contract,
    }, storeOptions);
    for (const [sliceId, sliceStatus] of Object.entries(stateObj.pipeline.sliceStates || {})) {
      if (![SLICE_STATES.FROZEN, SLICE_STATES.IMPLEMENTING, SLICE_STATES.IMPLEMENTED,
        SLICE_STATES.REVIEWING, SLICE_STATES.COMPLETED].includes(sliceStatus)) continue;
      const frozenSlice = slicePlanner.loadSlice(runDir, sliceId);
      freezeReceipt.verifyFreezeReceipt(runDir, {
        scopeRef: stateObj.pipeline.sliceFreezeScopes?.[sliceId] || `slice:${sliceId}`,
        contractHash: contract.contractHash,
        frozenPayload: frozenSlice,
      }, storeOptions);
    }
  }
  const effectiveOptions = nativeExecutionControl.resolveExecutionPolicyOptions(
    options,
    stateObj.executionPolicy
  );
  return runLock.withRunLock(
    runDir,
    'provider-dispatch',
    { command: 'resume', runId: stateObj.runId },
    () => {
      ctx.turnBudget.ensureTurnBudgetForResume(
        runDir,
        stateObj.runId,
        Object.prototype.hasOwnProperty.call(stateObj, 'turnBudgetPolicy')
          ? stateObj.turnBudgetPolicy
          : undefined,
        controlStoreOptions(ctx, effectiveOptions, stateObj.workdir)
      );
      const resolve = ctx.optionValue(effectiveOptions, 'resolve');
      if (resolve) {
        return resolveContractConflict(
          ctx,
          effectiveOptions,
          runDir,
          statePath,
          stateObj,
          resolve
        );
      }
      const unblockSlice = ctx.optionValue(effectiveOptions, 'unblock');
      if (unblockSlice) {
        return unblockBlockedSlice(
          ctx,
          effectiveOptions,
          runDir,
          statePath,
          stateObj,
          unblockSlice
        );
      }
      return advancePipeline(
        ctx,
        effectiveOptions,
        runDir,
        statePath,
        stateObj
      );
    },
    controlStoreOptions(ctx, effectiveOptions, stateObj.workdir)
  );
}

function resolveContractConflict(ctx, options, runDir, statePath, stateObj, action) {
  if (stateObj.status !== RUN_STATES.CONTRACT_CONFLICT) {
    throw new Error(`Cannot resolve: run is not in ${RUN_STATES.CONTRACT_CONFLICT}, currently ${stateObj.status}`);
  }
  if (action === RESOLVE_ACTIONS.ABANDON) {
    const next = transitionRun(stateObj, RUN_STATES.ABANDONED);
    saveState(statePath, next);
    ctx.log(`[OK] run ${stateObj.runId} abandoned via resolve.`);
    return next;
  }
  const revisionId = ctx.optionValue(options, 'revision');
  if (!revisionId) throw new Error('resume --resolve requires --revision <revisionId>');
  if (action === RESOLVE_ACTIONS.ACCEPT_REVISION) {
    const revision = globalContract.findRevisionEvent(runDir, revisionId);
    if (!revision) throw new Error(`Cannot accept revision ${revisionId}: original revision event not found`);
    const currentContract = globalContract.loadGlobalContract(runDir);
    if (!currentContract) throw new Error('Cannot accept revision: global-contract.json not found');
    const nextContract = globalContract.applyRevisionToContract(currentContract, revision);
    const acceptanceSemanticFields = ['goal', 'globalAcceptance', 'acceptanceContract'];
    const proposedChangedFields = globalContract.detectChangedCanonicalFields(currentContract, nextContract);
    const semanticRevision = proposedChangedFields.some((field) => acceptanceSemanticFields.includes(field));
    const previousAcceptance = semanticRevision
      ? JSON.parse(fs.readFileSync(path.join(runDir, 'acceptance-contract.json'), 'utf8'))
      : null;
    const nextAcceptance = semanticRevision
      ? acceptanceEvaluator.createAcceptanceContractForGlobalContract(nextContract)
      : null;
    let semanticImpact = [];
    let changedCriteria = [];
    if (semanticRevision) {
      changedCriteria = changedCriterionIds(previousAcceptance, nextAcceptance);
      if (changedCriteria.length === 0) changedCriteria = nextAcceptance.criteria.map((item) => item.id);
      semanticImpact = criterionImpact(runDir, nextContract, changedCriteria);
    }
    let pendingGlobalFreeze = null;
    if (semanticRevision) {
      const recorded = acceptanceEvaluator.recordAcceptanceContract({
        kind: 'global-contract', workdir: ctx.resolveWorkdir(options), runDir,
        source: nextContract, allowRevision: true,
        controlStoreOptions: ctx.goalLeaseStoreOptions(options, ctx.resolveWorkdir(options)),
      });
      if (recorded.status !== 'written') throw new Error(`Cannot revise acceptance contract: ${recorded.error}`);
      const scopeRef = `global@${recorded.contract.contractHash.slice('sha256:'.length)}`;
      freezeReceipt.recordFreezeReceipt(runDir, {
        scopeRef, contractHash: recorded.contract.contractHash, frozenPayload: nextContract,
      }, controlStoreOptions(ctx, options, ctx.resolveWorkdir(options)));
      pendingGlobalFreeze = scopeRef;
    }
    const writtenContract = globalContract.writeGlobalContract(runDir, nextContract, 'revision-applied');
    if (pendingGlobalFreeze) {
      stateObj = { ...stateObj, pipeline: { ...stateObj.pipeline, globalFreezeScope: pendingGlobalFreeze } };
    }
    const changedFields = globalContract.detectChangedCanonicalFields(currentContract, writtenContract);
    const driftEntry = findDriftEntry(runDir, revisionId);
    const impact = driftEntry && driftEntry.impact ? driftEntry.impact : {};
    let q = queue.loadQueue(runDir);
    let next = stateObj;
    const reopenedSlices = [];
    for (const sliceId of semanticImpact) {
      if (next.pipeline.sliceStates[sliceId] === SLICE_STATES.COMPLETED) {
        next = state.reopenCompletedSlice(next, sliceId, revisionId);
        q = queue.moveToPending(q, sliceId);
        reopenedSlices.push(sliceId);
      }
    }
    const pendingImpact = semanticRevision
      ? (impact.pendingSlices || []).filter((sliceId) => semanticImpact.includes(sliceId))
      : (impact.pendingSlices || []);
    const superseded = markSlicesSuperseded(runDir, next, q, pendingImpact, revisionId);
    next = superseded.state;
    q = superseded.queue;
    const reconciliationResult = createReconciliationSlice(
      runDir,
      next,
      q,
      revision,
      semanticRevision ? [] : (impact.completedSlices || []),
      writtenContract.contractHash
    );
    next = reconciliationResult.state;
    q = reconciliationResult.queue;
    queue.saveQueue(runDir, q);
    globalContract.appendRevisionEvent(runDir, {
      revisionId,
      resolvedAt: nowIso(),
      resolvedBy: process.env.USER || process.env.USERNAME || 'human',
      resolution: 'accepted',
      appliedContractHash: writtenContract.contractHash,
      changedFields,
      supersededSlices: uniqueStrings(pendingImpact),
      reconciliationSliceId: reconciliationResult.slice ? reconciliationResult.slice.id : null,
      changedCriterionIds: changedCriteria,
      reopenedSlices,
    });
    appendPipelineEvent(runDir, {
      type: 'contract-revision-accepted',
      revisionId,
      appliedContractHash: writtenContract.contractHash,
      changedFields,
      supersededSlices: uniqueStrings(pendingImpact),
      reconciliationSliceId: reconciliationResult.slice ? reconciliationResult.slice.id : null,
      changedCriterionIds: changedCriteria,
      reopenedSlices,
    });
    next = transitionRun(next, RUN_STATES.EXECUTING_SLICES);
    saveState(statePath, next);
    ctx.log(`[OK] revision ${revisionId} accepted; run resumes in ${next.status}.`);
    return next;
  }
  if (action === RESOLVE_ACTIONS.REJECT_REVISION) {
    const reason = ctx.optionValue(options, 'reason') || 'rejected by human';
    globalContract.appendRevisionEvent(runDir, {
      revisionId,
      resolvedAt: nowIso(),
      resolvedBy: process.env.USER || process.env.USERNAME || 'human',
      resolution: 'rejected',
      reason,
    });
    appendPipelineEvent(runDir, {
      type: 'contract-revision-rejected',
      revisionId,
      reason,
    });
    const next = transitionRun(stateObj, RUN_STATES.EXECUTING_SLICES);
    saveState(statePath, next);
    ctx.log(`[OK] revision ${revisionId} rejected; run resumes in ${next.status}.`);
    return next;
  }
  throw new Error(`unknown resolve action: ${action}`);
}

function unblockBlockedSlice(ctx, options, runDir, statePath, stateObj, sliceId) {
  let q = queue.loadQueue(runDir);
  const blocked = q.blocked.find((entry) => entry.sliceId === sliceId);
  if (!blocked) throw new Error(`Slice ${sliceId} is not in the blocked list.`);
  q = queue.moveToReady(q, sliceId);
  queue.saveQueue(runDir, q);
  let next = transitionSlice(stateObj, sliceId, SLICE_STATES.READY);
  saveState(statePath, next);
  ctx.log(`[OK] slice ${sliceId} unblocked and moved to ready.`);
  return next;
}

function advancePipeline(ctx, options, runDir, statePath, stateObj) {
  if (stateObj.status === RUN_STATES.CONTRACT_CONFLICT) {
    throw new Error('Cannot advance: run is in contract-conflict. Use resume --resolve.');
  }
  if (stateObj.status === RUN_STATES.COMPLETED || stateObj.status === RUN_STATES.ABANDONED) {
    ctx.log(`[INFO] run ${stateObj.runId} already ${stateObj.status}.`);
    return stateObj;
  }
  if (stateObj.dryRun || stateObj.status === RUN_STATES.DRY_RUN) {
    ctx.log(`[INFO] run ${stateObj.runId} is a dry-run; no provider calls to resume.`);
    return stateObj;
  }

  const auto = ctx.boolOption(options, 'auto');
  const maxIterations = 32;
  let current = stateObj;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (current.status === RUN_STATES.CONTRACT_CONFLICT) {
      ctx.log(`[STOP] run ${current.runId} entered contract-conflict; use resume --resolve.`);
      return current;
    }
    if (current.status === RUN_STATES.COMPLETED || current.status === RUN_STATES.ABANDONED) {
      return current;
    }
    if (current.status === RUN_STATES.GLOBAL_CONTRACT_READY) {
      if (!auto) {
        ctx.log(`[GATE] global contract ready; freeze with: freeze --run ${current.runId} --target global-contract`);
        return current;
      }
      const contract = globalContract.loadGlobalContract(runDir);
      if (!isContractSafeForAuto(contract)) {
        current = recordAutoSkip(current, 'global-contract not safe for auto-freeze');
        saveState(statePath, current);
        ctx.log('[GATE] --auto skipped global contract freeze (not in safe set).');
        return current;
      }
      current = freezeGlobalContract(ctx, options, runDir, statePath, current);
      continue;
    }
    if (current.status === RUN_STATES.GLOBAL_CONTRACT_FROZEN) {
      current = transitionRun(current, RUN_STATES.PLANNING_SLICES);
      saveState(statePath, current);
      continue;
    }
    if (current.status === RUN_STATES.PLANNING_SLICES) {
      current = providers.runSlicePlannerProvider(ctx, current, statePath, runDir, options);
      continue;
    }
    if (current.status === RUN_STATES.EXECUTING_SLICES) {
      const q = queue.loadQueue(runDir);
      if (!queue.hasActiveWork(q)) {
        if (q.blocked.length > 0) {
          ctx.log(`[GATE] no runnable slices; ${q.blocked.length} blocked. Use resume --unblock after resolving the reason.`);
          return current;
        }
        if (q.completed.length > 0) {
          current = transitionRun(current, RUN_STATES.INTEGRATION_READY);
          saveState(statePath, current);
          continue;
        }
        current = transitionRun(current, RUN_STATES.PLANNING_SLICES);
        saveState(statePath, current);
        continue;
      }
      const sliceId = q.ready[0] || q.pending[0] || q.running[0];
      if (!sliceId) {
        ctx.log(`[GATE] no ready slice; ${q.blocked.length} blocked, ${q.pending.length} pending. Use resume --unblock or wait.`);
        return current;
      }
      const slice = slicePlanner.loadSlice(runDir, sliceId);
      if (!slice) {
        ctx.log(`[WARN] queue references missing slice ${sliceId}; advancing.`);
        const cleaned = queue.moveToAbandoned(q, sliceId);
        queue.saveQueue(runDir, cleaned);
        continue;
      }
      const sliceStateNow = current.pipeline.sliceStates[sliceId] || 'slice-pending';
      if (['slice-pending', 'slice-ready'].includes(sliceStateNow)) {
        if (!auto || !sliceNormalizer.isSliceSafeForAuto(slice)) {
          ctx.log(`[GATE] slice ${sliceId} ready; freeze with: freeze --run ${current.runId} --target slice --slice-id ${sliceId}`);
          return current;
        }
        const classification = locks.classifyClaim(locksModule(runDir), slice);
        if (classification.blockedBy.length > 0) {
          const reason = classification.blockedBy.map((entry) => `${entry.file}:${entry.reason}`).join('; ');
          const q2 = queue.moveToBlocked(q, sliceId, reason);
          queue.saveQueue(runDir, q2);
          current = transitionSlice(current, sliceId, SLICE_STATES.BLOCKED, {
            reason: `slice lock claim blocked: ${reason}`,
          });
          saveState(statePath, current);
          ctx.log(`[GATE] slice ${sliceId} blocked: ${reason}`);
          continue;
        }
        current = freezeSlice(ctx, options, runDir, statePath, current, sliceId);
        continue;
      }
      if (sliceStateNow === 'slice-frozen') {
        const q3 = queue.moveToRunning(queue.loadQueue(runDir), sliceId);
        queue.saveQueue(runDir, q3);
        let locksNow = locks.loadLocks(runDir);
        locksNow = locks.claimAll(locksNow, slice);
        locks.saveLocks(runDir, locksNow);
        current = transitionSlice(current, sliceId, SLICE_STATES.IMPLEMENTING, {
          reason: 'slice dispatch started implementation',
        });
        saveState(statePath, current);
        try {
          current = providers.runSliceImplementationProvider(ctx, current, statePath, runDir, options, slice);
        } catch (error) {
          current = blockFailedSlice(ctx, current, statePath, runDir, slice, error);
          return current;
        }
        continue;
      }
      if (sliceStateNow === 'slice-implementing' || sliceStateNow === 'slice-implemented') {
        if (sliceStateNow === 'slice-implementing' && !sliceEvidenceComplete(runDir, slice.id)) {
          current = blockFailedSlice(
            ctx,
            current,
            statePath,
            runDir,
            slice,
            new Error('slice is still implementing and lacks complete handoff/diff/changed-files gate/validation evidence'),
            'implementation evidence incomplete'
          );
          return current;
        }
        const outcome = providers.runSliceReviewProvider(ctx, current, statePath, runDir, options, slice);
        current = outcome.state;
        continue;
      }
      // Already reviewed/completed but still in queue running — promote.
      const qFinal = queue.moveToCompleted(queue.loadQueue(runDir), sliceId);
      queue.saveQueue(runDir, qFinal);
      continue;
    }
    if (current.status === RUN_STATES.INTEGRATION_READY) {
      if (current.acceptanceProtocol === 'v1'
          && (['failed', 'unknown'].includes(current.acceptanceStatus)
            || current.completionGateStatus === 'failed')
          && !ctx.boolOption(options, 'retry-acceptance')) {
        ctx.log(
          `[GATE] integration completion remains blocked (acceptance=${current.acceptanceStatus || 'unknown'}, gate=${current.completionGateStatus || 'unknown'}); resolve the evidence or implementation, then resume with --retry-acceptance.`
        );
        return current;
      }
      current = providers.runIntegrationReviewProvider(ctx, current, statePath, runDir, options);
      if (current.status !== RUN_STATES.COMPLETED) return current;
      continue;
    }
    ctx.log(`[STOP] unhandled run status: ${current.status}`);
    return current;
  }
  ctx.log(`[STOP] advance loop reached max iterations (${maxIterations}); stopping safely.`);
  return current;
}

function locksModule(runDir) {
  return locks.loadLocks(runDir);
}

function abandonPipelineRun(ctx, options, positionals) {
  const { statePath, state: stateObj } = ctx.loadRun(options, positionals);
  if (stateObj.mode !== 'pipeline') {
    throw new Error('abandonPipelineRun: state.mode must be "pipeline"');
  }
  if (stateObj.status === RUN_STATES.COMPLETED || stateObj.status === RUN_STATES.ABANDONED) {
    ctx.log(`[INFO] run ${stateObj.runId} already ${stateObj.status}.`);
    return stateObj;
  }
  const next = transitionRun(stateObj, RUN_STATES.ABANDONED);
  saveState(statePath, next);
  ctx.log(`[OK] run ${stateObj.runId} abandoned.`);
  return next;
}

function startPipelineRun(ctx, options, positionals) {
  const workdir = ctx.resolveWorkdir(options);
  const runsDir = ctx.resolveRunsDir(workdir, options);
  const requirement = ctx.readRequirement(options, positionals);
  const runId = ctx.optionValue(options, 'run-id') || `${ctx.dateStamp()}-${ctx.slugify(requirement)}`;
  const runDir = path.join(runsDir, runId);
  const statePath = path.join(runDir, 'state.json');
  if (fs.existsSync(statePath)) throw new Error(`Run already exists: ${runDir}`);

  fs.mkdirSync(path.join(runDir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'slices'), { recursive: true });

  const dispatchLock = runLock.acquireRunLock(runDir, 'provider-dispatch', {
    command: 'run',
    runId,
  }, controlStoreOptions(ctx, options, workdir));
  try {
  if (fs.existsSync(statePath)) {
    throw new Error(`Run already exists after dispatch lock acquisition: ${runDir}`);
  }
  const executionPolicy = nativeExecutionControl.executionPolicy(options);
  let stateObj = newPipelineState(workdir, runDir, runId, requirement);
  stateObj = {
    ...stateObj,
    orchestrationOwner: executionPolicy.orchestrationOwner,
    executionPolicy,
    turnBudgetPolicy: ctx.turnBudgetPolicyFromOptions(options),
  };
  ctx.turnBudget.initializeTurnBudget(
    runDir,
    runId,
    stateObj.turnBudgetPolicy,
    controlStoreOptions(ctx, options, workdir)
  );
  writePipelineSkeleton(runDir, requirement);
  fs.writeFileSync(
    path.join(runDir, 'prompts', 'global-contract.md'),
    slicePlanner.buildGlobalContractPrompt(requirement, { workdir }),
  );
  saveState(statePath, stateObj);

  const preflight = ctx.buildPreflightReport(workdir, options, runDir);
  ctx.writePreflight(runDir, preflight);
  const executionPlan = ctx.buildNativeExecutionPlan(
    options,
    runId,
    requirement,
    preflight
  );
  writeJson(path.join(runDir, 'execution-plan.json'), executionPlan);
  stateObj = {
    ...stateObj,
    files: {
      ...stateObj.files,
      preflight: 'preflight.json',
      executionPlan: 'execution-plan.json',
    },
  };
  saveState(statePath, stateObj);

  if (ctx.boolOption(options, 'preflight-only')) {
    stateObj = { ...stateObj, status: preflight.ok ? 'preflight-ready' : 'preflight-failed' };
    saveState(statePath, stateObj);
    ctx.printPreflight(preflight);
    if (!preflight.ok) ctx.exitWithFailure();
    return stateObj;
  }
  ctx.assertPreflight(preflight);

  if (ctx.boolOption(options, 'dry-run')) {
    const contract = dryRunGlobalContract(requirement);
    const normalizedContract = globalContract.writeGlobalContract(runDir, contract, 'dry-run');
    const acceptanceContract = acceptanceEvaluator.recordAcceptanceContract({
      kind: 'global-contract',
      workdir,
      runDir,
      source: normalizedContract,
      controlStoreOptions: ctx.goalLeaseStoreOptions(options, workdir),
    });
    if (acceptanceContract.status !== 'written') {
      throw new Error(`Cannot freeze acceptance contract: ${acceptanceContract.error}`);
    }
    stateObj = transitionRun(stateObj, RUN_STATES.GLOBAL_CONTRACT_READY);
    stateObj = transitionRun(stateObj, RUN_STATES.GLOBAL_CONTRACT_FROZEN);
    stateObj = {
      ...stateObj,
      pipeline: { ...stateObj.pipeline, globalContractFrozenAt: nowIso(), globalContractFrozenBy: 'dry-run' },
      files: {
        ...stateObj.files,
        globalContract: 'global-contract.json',
        ...(acceptanceContract.status === 'written'
          ? { acceptanceContract: 'acceptance-contract.json' }
          : {}),
      },
    };
    stateObj = transitionRun(stateObj, RUN_STATES.PLANNING_SLICES);
    const slices = dryRunSliceBatch(contract);
    let q = queue.loadQueue(runDir);
    for (const slice of slices) {
      slicePlanner.writeSliceArtifacts(runDir, slice, slice);
      q = queue.moveToPending(q, slice.id);
      stateObj = transitionSlice(stateObj, slice.id, SLICE_STATES.PENDING);
      if (!slice.rejected) {
        const staticCheck = sliceNormalizer.evaluateStaticCanStart(slice);
        if (staticCheck.canStart) {
          q = queue.moveToReady(q, slice.id);
          stateObj = transitionSlice(stateObj, slice.id, SLICE_STATES.READY);
        }
      }
    }
    queue.saveQueue(runDir, q);
    stateObj = transitionRun(stateObj, RUN_STATES.EXECUTING_SLICES);
    stateObj = { ...stateObj, dryRun: true };
    saveState(statePath, stateObj);
    ctx.log(`[OK] pipeline dry-run created ${runDir}`);
    ctx.log(`     global-contract: ${path.join(runDir, 'global-contract.json')}`);
    ctx.log(`     slices: ${slices.map((s) => s.id).join(', ') || 'none'}`);
    return stateObj;
  }

  stateObj = providers.runGlobalContractProvider(ctx, stateObj, statePath, runDir, options);
  if (!ctx.boolOption(options, 'auto')) {
    ctx.log(`[OK] global contract ready: ${runDir}`);
    ctx.log(`Next: review ${path.join(runDir, 'global-contract.json')}`);
    ctx.log(`Freeze: node scripts/agent-orchestrator.js freeze --run ${runId} --target global-contract`);
    return stateObj;
  }
  stateObj = advancePipeline(ctx, options, runDir, statePath, stateObj);
  return stateObj;
  } finally {
    dispatchLock.release();
  }
}

module.exports = {
  RUN_STATES,
  SLICE_STATES,
  FREEZE_TARGETS,
  RESOLVE_ACTIONS,
  newPipelineState,
  transitionRun,
  transitionSlice,
  isContractSafeForAuto,
  freezePipelineRun,
  resumePipelineRun,
  abandonPipelineRun,
  startPipelineRun,
  dryRunGlobalContract,
  dryRunSliceBatch,
  changedCriterionIds,
  criterionImpact,
};
