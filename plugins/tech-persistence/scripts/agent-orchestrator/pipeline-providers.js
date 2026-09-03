'use strict';

const fs = require('fs');
const path = require('path');

const pipelineState = require('./pipeline-state');
const globalContract = require('./global-contract');
const slicePlanner = require('./slice-planner');
const sliceNormalizer = require('./slice-normalizer');
const sliceRunner = require('./slice-runner');
const review = require('./review');
const queueModule = require('./queue');
const locksModule = require('./locks');
const driftDetector = require('./drift-detector');
const reconciliation = require('./reconciliation');
const validationRunner = require('./validation-runner');
const completionGate = require('./completion-gate');
const acceptanceEvaluator = require('./acceptance-evaluator');
const { redactSensitiveText, redactArtifactValue } = require('../lib/redaction');
const executionEnvelopes = require('./execution-envelopes');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeText(file, content) { ensureDir(path.dirname(file)); fs.writeFileSync(file, redactSensitiveText(String(content))); }
function writeJson(file, data) { writeText(file, `${JSON.stringify(data, null, 2)}\n`); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function safeRead(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }

function runRef(...parts) {
  return parts.join('/');
}

function readJsonIfExists(file, fallback = null) {
  return fs.existsSync(file) ? readJson(file) : fallback;
}

function resolvedAcceptanceContract(runDir, contract) {
  const file = path.join(runDir, 'acceptance-contract.json');
  if (fs.existsSync(file)) return readJson(file);
  if (contract.acceptanceContract && Array.isArray(contract.acceptanceContract.criteria)) {
    return contract.acceptanceContract;
  }
  return acceptanceEvaluator.createAcceptanceContractFromCriteria({
    sourceRequirement: { goal: contract.goal, globalAcceptance: contract.globalAcceptance },
    criteria: contract.globalAcceptance,
    sourceRef: 'global-contract.json#/globalAcceptance',
  });
}

function recordShadowAcceptance(input = {}) {
  return acceptanceEvaluator.recordShadowAcceptance({
    ...input,
    createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
  });
}

function shadowAcceptanceForResult(
  workdir,
  runDir,
  relativeDir,
  accepted,
  controlStoreOptions,
  validationSeal = null
) {
  if (!accepted || !accepted.result) return { status: 'absent' };
  try {
    return recordShadowAcceptance({
      runDir,
      workdir,
      relativeDir,
      controlStoreOptions,
      validationSeal,
      subjectRef: accepted.result.ref,
      subject: executionEnvelopes.acceptanceSubjectForResult(accepted.result),
    });
  } catch (error) {
    return {
      status: 'error',
      error: redactSensitiveText(error && error.message ? error.message : String(error)),
    };
  }
}

function acceptanceControlOptions(ctx, options) {
  const controlRoot = ctx.optionValue(options, 'control-root');
  const postgresEnvFile = ctx.optionValue(options, 'acceptance-postgres-env-file');
  const postgresBrokerPath = ctx.optionValue(options, 'acceptance-postgres-broker');
  const readbackBrokerPath = ctx.optionValue(options, 'acceptance-readback-broker');
  const independentReviewBrokerPath = ctx.optionValue(
    options,
    'acceptance-independent-review-broker'
  );
  const userConfirmationBrokerPath = ctx.optionValue(
    options,
    'acceptance-user-confirmation-broker'
  );
  return {
    providerRoot: ctx.resolveWorkdir(options),
    ...(controlRoot === undefined || controlRoot === true
      ? {}
      : { controlRoot: String(controlRoot) }),
    ...(postgresEnvFile === undefined || postgresEnvFile === true
      ? {}
      : { postgresEnvFile: path.resolve(String(postgresEnvFile)) }),
    ...(postgresBrokerPath === undefined || postgresBrokerPath === true
      ? {}
      : { postgresBrokerPath: path.resolve(String(postgresBrokerPath)) }),
    ...(readbackBrokerPath === undefined || readbackBrokerPath === true
      ? {}
      : { readbackBrokerPath: path.resolve(String(readbackBrokerPath)) }),
    ...(independentReviewBrokerPath === undefined || independentReviewBrokerPath === true
      ? {}
      : { independentReviewBrokerPath: path.resolve(String(independentReviewBrokerPath)) }),
    ...(userConfirmationBrokerPath === undefined || userConfirmationBrokerPath === true
      ? {}
      : { userConfirmationBrokerPath: path.resolve(String(userConfirmationBrokerPath)) }),
  };
}

function resolvedClarifications(reviewResult) {
  const rulings = Array.isArray(reviewResult && reviewResult.clarificationRulings)
    ? reviewResult.clarificationRulings
    : [];
  return rulings.map((ruling) => ({
    id: ruling.id,
    status: ruling.decision === 'confirm-assumption' ? 'resolved' : 'open',
    decision: ruling.decision,
  }));
}

function sliceCompletionGateInput(runDir, slice, reviewResult) {
  const sliceDir = path.join(runDir, 'slices', slice.id);
  const validation = readJsonIfExists(path.join(sliceDir, 'validation.json'), {});
  const changedFiles = readJsonIfExists(path.join(sliceDir, 'changed-files.json'), []);
  const changedFilesGate = readJsonIfExists(path.join(sliceDir, 'changed-files-gate.json'), {});
  const evidenceRefs = [
    runRef('slices', slice.id, 'handoff.json'),
    runRef('slices', slice.id, 'diff.patch'),
    runRef('slices', slice.id, 'changed-files-gate.json'),
    runRef('slices', slice.id, 'validation.json'),
    runRef('slices', slice.id, 'review.json'),
  ];
  const evidenceFiles = evidenceRefs.map((ref) => path.join(runDir, ...ref.split('/')));
  const material = Array.isArray(changedFiles) && changedFiles.length > 0;
  return {
    scope: 'slice',
    risk: slice.risk,
    review: reviewResult,
    validation: {
      status: validation.status,
      evidenceRef: runRef('slices', slice.id, 'validation.json'),
    },
    material,
    effects: material
      ? { state: 'committed', refs: [runRef('slices', slice.id, 'diff.patch')] }
      : { state: 'none', refs: [] },
    evidence: {
      complete: evidenceFiles.every((file) => fs.existsSync(file)) && changedFilesGate.ok === true,
      refs: evidenceRefs,
    },
    clarifications: resolvedClarifications(reviewResult),
    revisions: Array.isArray(reviewResult.contractRevisions) ? reviewResult.contractRevisions : [],
    blockers: [],
  };
}

function blockSliceAfterReview(ctx, state, statePath, runDir, slice, reason, gate, driftEntries, revisions) {
  const gatePath = path.join(runDir, 'slices', slice.id, 'completion-gate.json');
  if (gate) writeJson(gatePath, gate);
  let next = transitionSlice(state, slice.id, pipelineState.SLICE_STATES.BLOCKED, {
    actor: 'review-provider',
    reason,
  });
  let q = queueModule.loadQueue(runDir);
  q = queueModule.moveToBlocked(q, slice.id, reason);
  queueModule.saveQueue(runDir, q);
  let locks = locksModule.loadLocks(runDir);
  locks = locksModule.releaseSliceLocks(locks, slice);
  locksModule.saveLocks(runDir, locks);
  writeJson(statePath, next);
  ctx.log(`[GATE] slice ${slice.id} blocked after review: ${reason}`);
  return { state: next, drift: driftEntries || [], revisions: revisions || [] };
}

function recordProviderRun(state, record) {
  if (!Array.isArray(state.providerRuns)) state.providerRuns = [];
  return { ...state, providerRuns: [...state.providerRuns, record] };
}

function acceptanceEnforcementVerdict(state, acceptanceShadow, ownedCriterionIds) {
  if (!state || state.acceptanceProtocol !== 'v1') return 'legacy';
  const owned = [...new Set(Array.isArray(ownedCriterionIds) ? ownedCriterionIds : [])];
  if (owned.length === 0) return 'passed';
  if (!acceptanceShadow || acceptanceShadow.status !== 'written' || !acceptanceShadow.receipt) {
    return 'unknown';
  }
  const results = new Map(
    (Array.isArray(acceptanceShadow.receipt.results) ? acceptanceShadow.receipt.results : [])
      .map((result) => [result.criterionId, result.status])
  );
  const statuses = owned.map((criterionId) => results.get(criterionId) || 'unknown');
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('unknown')) return 'unknown';
  return 'passed';
}

function withProviderRecord(error, record) {
  if (error && record && !error.providerRecord) error.providerRecord = record;
  return error;
}

function transitionRun(stateObj, target, metadata = {}) {
  return pipelineState.transitionRun(stateObj, target, { source: 'pipeline-providers', ...metadata });
}

function transitionSlice(stateObj, sliceId, target, metadata = {}) {
  return pipelineState.transitionSlice(stateObj, sliceId, target, { source: 'pipeline-providers', ...metadata });
}

function callClaudeStructured(ctx, state, providerKey, stage, label, options, runDir, schemaName, prompt, logPrefix, artifacts = []) {
  const stamp = ctx.logStamp();
  const stdoutFile = ctx.stampedLogPath(runDir, logPrefix, 'stdout.log', stamp);
  const stderrFile = ctx.stampedLogPath(runDir, logPrefix, 'stderr.log', stamp);
  const workdir = ctx.resolveWorkdir(options);
  const invocation = ctx.buildClaudeProviderInvocation(
    options,
    providerKey,
    runDir,
    prompt,
    schemaName,
    workdir,
    ctx.providerResumeRefs(state, 'claude', providerKey, stage),
    artifacts
  );
  const attempt = ctx.prepareProviderAttempt(state, runDir, options, {
    stage,
    providerKey,
    intent: 'read-only',
    prompt,
    schemaPath: invocation.schemaPath,
    stamp,
  });
  const { record, result } = ctx.runProcess(
    label,
    invocation.launch,
    invocation.args,
    {
      cwd: invocation.cwd,
      stdoutFile,
      stderrFile,
      stdin: invocation.stdin,
      timeoutMs: ctx.providerTimeoutMs(options),
      env: invocation.env,
      phase: stage,
      providerKey,
      schemaPath: invocation.schemaPath,
      options,
      runtime: invocation.runtime,
      adapter: invocation.adapter,
      capabilitySnapshot: attempt.capabilitySnapshot,
      taskEnvelopeHash: attempt.task.hash,
      routeDecisionHash: attempt.route.decisionHash,
      onFailure: attempt.onFailure,
    }
  );
  const runtimeOutput = ctx.runProviderPostProcess(attempt, record, { result }, () => (
    ctx.providerStep('output-normalization', () => ctx.normalizeClaudeOutput({
      stdout: result.stdout || '',
      adapter: invocation.adapter,
    }))
  ));
  return { record, result, runtimeOutput, attempt, stdoutFile, stderrFile };
}

function acceptClaudeResult(ctx, state, attempt, record, runtimeOutput, payload, evidence = {}) {
  const accepted = ctx.acceptProviderAttempt(state, attempt, {
    status: runtimeOutput.status,
    effects: { state: 'none', refs: [] },
    runtimeRefs: require('./external-runtime-invocation').runtimeRefs(runtimeOutput),
    runtimeResult: runtimeOutput,
    evidence,
    validation: {
      status: 'passed',
      source: 'structured-output',
      evidenceRef: attempt.lifecycle.stage,
    },
    payload,
  });
  record.resultEnvelopeHash = accepted.result.hash;
  record.acceptance = accepted.acceptance;
  record.runtimeRefs = accepted.result.runtimeRefs;
  record.usage = runtimeOutput.usage || record.usage;
  return accepted;
}

function runGlobalContractProvider(ctx, state, statePath, runDir, options) {
  const prompt = safeRead(path.join(runDir, 'prompts', 'global-contract.md'));
  if (!prompt.trim()) throw new Error('global-contract prompt is empty');
  const { record, result, runtimeOutput, attempt } = callClaudeStructured(
    ctx, state, 'spec', 'global-contract', 'global contract provider', options, runDir,
    'global-contract.schema.json', prompt, 'global-contract'
  );
  return ctx.runProviderPostProcess(attempt, record, { result, runtimeOutput }, () => {
    let parsed;
    try {
      parsed = ctx.providerStep('structured-output-parse', () => (
        runtimeOutput.payload === undefined
          ? ctx.extractJsonValue(result.stdout || '')
          : runtimeOutput.payload
      ));
      ctx.assertProviderStructuredOutput(
        parsed,
        'global-contract.schema.json',
        'pipeline global contract'
      );
    } catch (error) {
      writeJson(path.join(runDir, 'global-contract.parse-error.json'), {
        message: error.message,
        stdoutFile: record.stdoutFile,
        stderrFile: record.stderrFile,
      });
      throw error;
    }
    ctx.providerStep('artifact', () => writeJson(
      path.join(runDir, 'global-contract.raw.json'),
      parsed
    ));
    const normalized = ctx.providerStep(
      'artifact',
      () => globalContract.writeGlobalContract(runDir, parsed, 'initial')
    );
    ctx.providerStep('acceptance', () => acceptClaudeResult(
      ctx,
      state,
      attempt,
      record,
      runtimeOutput,
      parsed,
      { outputHash: ctx.hashArtifact(parsed) }
    ));
    let next = transitionRun(
      recordProviderRun(state, record),
      pipelineState.RUN_STATES.GLOBAL_CONTRACT_READY,
      { actor: 'spec-provider', reason: 'global contract generated' }
    );
    next = {
      ...next,
      files: { ...next.files, globalContract: 'global-contract.json' },
    };
    ctx.providerPostAcceptanceStep('state-transition', () => writeJson(statePath, next));
    ctx.log(`[OK] global contract generated (hash=${normalized.contractHash}); review at ${path.join(runDir, 'global-contract.json')}`);
    return next;
  });
}

function runSlicePlannerProvider(ctx, state, statePath, runDir, options) {
  const contract = globalContract.loadGlobalContract(runDir);
  if (!contract) throw new Error('slice planner: global contract not found');
  const alreadyPlanned = slicePlanner.listSliceIds(runDir);
  const frozenAcceptanceContract = resolvedAcceptanceContract(runDir, contract);
  if (!frozenAcceptanceContract || !Array.isArray(frozenAcceptanceContract.criteria)) {
    throw new Error('slice planner requires a frozen acceptance contract');
  }
  const allowedCriterionIds = frozenAcceptanceContract.criteria.map((criterion) => criterion.id);
  const prompt = slicePlanner.buildSlicePlannerPrompt(contract, alreadyPlanned, { workdir: ctx.resolveWorkdir(options) });
  writeText(path.join(runDir, 'prompts', `slice-planner-${alreadyPlanned.length}.md`), prompt);
  const { record, result, runtimeOutput, attempt } = callClaudeStructured(
    ctx, state, 'spec', 'slice-planner', 'slice planner provider', options, runDir,
    'pipeline-slice-batch.schema.json', prompt, `slice-planner-${alreadyPlanned.length}`
  );
  return ctx.runProviderPostProcess(attempt, record, { result, runtimeOutput }, () => {
  let parsed;
  try {
    parsed = ctx.providerStep('structured-output-parse', () => (
      runtimeOutput.payload === undefined
        ? ctx.extractJsonValue(result.stdout || '')
        : runtimeOutput.payload
    ));
    ctx.assertProviderStructuredOutput(
      parsed,
      'pipeline-slice-batch.schema.json',
      'pipeline slice batch'
    );
  } catch (error) {
    throw error;
  }
  const rawSlices = parsed.slices;
  let nextState = recordProviderRun(state, record);
  let q = queueModule.loadQueue(runDir);
  const offset = alreadyPlanned.length;
  for (let index = 0; index < rawSlices.length; index += 1) {
    const fallbackIndex = offset + index;
    const normalized = sliceNormalizer.rejectIfUnsafe(
      sliceNormalizer.normalizeSlice(rawSlices[index], {
        fallbackIndex,
        globalContractHash: contract.contractHash,
        allowedCriterionIds,
      })
    );
    slicePlanner.writeSliceArtifacts(runDir, normalized, rawSlices[index]);
    q = queueModule.moveToPending(q, normalized.id);
    nextState = transitionSlice(nextState, normalized.id, pipelineState.SLICE_STATES.PENDING, {
      actor: 'slice-planner-provider',
      reason: 'slice planned',
    });
    const staticCheck = sliceNormalizer.evaluateStaticCanStart(normalized);
    if (staticCheck.canStart && !normalized.rejected) {
      q = queueModule.moveToReady(q, normalized.id);
      nextState = transitionSlice(nextState, normalized.id, pipelineState.SLICE_STATES.READY, {
        actor: 'slice-planner-provider',
        reason: 'slice static canStart passed',
      });
    }
  }
  queueModule.saveQueue(runDir, q);
  if (rawSlices.length === 0) {
    nextState = transitionRun(nextState, pipelineState.RUN_STATES.INTEGRATION_READY, {
      actor: 'slice-planner-provider',
      reason: 'slice planner returned no slices',
    });
    nextState = { ...nextState, pipeline: { ...nextState.pipeline, lastSliceBatchAt: ctx.nowIso() } };
    ctx.log('[INFO] slice planner returned no new slices; entering integration-ready.');
  } else {
    const target = queueModule.hasActiveWork(q)
      ? pipelineState.RUN_STATES.EXECUTING_SLICES
      : pipelineState.RUN_STATES.PLANNING_SLICES;
    nextState = transitionRun(nextState, target, {
      actor: 'slice-planner-provider',
      reason: 'slice planner produced slices',
    });
    nextState = { ...nextState, pipeline: { ...nextState.pipeline, lastSliceBatchAt: ctx.nowIso() } };
    ctx.log(`[OK] slice planner produced ${rawSlices.length} slice(s).`);
  }
  ctx.providerStep('acceptance', () => acceptClaudeResult(
    ctx,
    state,
    attempt,
    record,
    runtimeOutput,
    parsed,
    { outputHash: ctx.hashArtifact(parsed) }
  ));
  ctx.providerPostAcceptanceStep('state-transition', () => writeJson(statePath, nextState));
  return nextState;
  });
}

function runSliceImplementationProvider(ctx, state, statePath, runDir, options, slice) {
  const contract = globalContract.loadGlobalContract(runDir);
  if (!contract) throw new Error('slice impl: global contract not found');
  const workdir = ctx.resolveWorkdir(options);
  const baseSha = ctx.currentGitSha(workdir);
  const prompt = sliceRunner.buildSliceImplementPrompt(contract, slice, { workdir });
  slicePlanner.writeSlicePrompts(runDir, slice.id, { implement: prompt });
  const beforeChangedFiles = ctx.listChangedFiles(workdir, runDir);
  const beforeSnapshot = sliceRunner.snapshotChangedFiles(workdir, beforeChangedFiles);

  const stamp = ctx.logStamp();
  const logPrefix = `slice-${slice.id}-impl`;
  const stdoutFile = ctx.stampedLogPath(runDir, logPrefix, 'stdout.log', stamp);
  const stderrFile = ctx.stampedLogPath(runDir, logPrefix, 'stderr.log', stamp);
  const lastMessageFile = ctx.stampedLogPath(runDir, logPrefix, 'last-message.json', stamp);
  const invocation = ctx.buildCodexProviderInvocation(
    options,
    runDir,
    prompt,
    lastMessageFile,
    workdir,
    ctx.providerResumeRefs(
      state,
      'codex',
      'implementation',
      `slice-implementation-${slice.id}`
    )
  );
  const attempt = ctx.prepareProviderAttempt(state, runDir, options, {
    stage: `slice-implementation-${slice.id}`,
    providerKey: 'implementation',
    intent: 'write',
    prompt,
    schemaPath: invocation.schemaPath,
    contractHash: contract.contractHash,
    stamp,
  });
  const sliceArtifactsDir = path.join(runDir, 'slices', slice.id);
  const agentAssignment = executionEnvelopes.createAgentAssignment({
    ref: `assignment:${state.runId}:${slice.id}:${attempt.prefix}`,
    task: attempt.task,
    sliceRef: `slice:${slice.id}`,
    role: 'tp_implementer',
    intent: 'write',
    ownedFiles: slice.ownedFiles || [],
    readFiles: slice.readFiles || [],
    workspaceMode: 'shared',
    worktreeRef: null,
    enforcement: 'contract-enforced',
    requiredCapabilities: ['repo-read', 'workspace-write'],
  });
  writeJson(path.join(sliceArtifactsDir, 'agent-assignment.json'), agentAssignment);
  const agentInvocationStarted = executionEnvelopes.createAgentInvocation({
    ref: `invocation:${state.runId}:${slice.id}:${attempt.prefix}:started`,
    assignment: agentAssignment,
    runtime: invocation.runtime,
    adapter: invocation.adapter,
    enforcement: 'contract-enforced',
    status: 'started',
    actualRole: null,
    runtimeRefs: {},
    native: {
      nativeAccepted: false,
      terminalEvent: null,
      terminalStatus: null,
      acceptanceErrors: ['codex exec does not prove named native agent selection'],
    },
  });
  writeJson(path.join(sliceArtifactsDir, 'agent-invocation.started.json'), agentInvocationStarted);

  const { record, result } = ctx.runProcess(
    `slice impl provider [${slice.id}]`,
    invocation.launch,
    invocation.args,
    {
      cwd: invocation.cwd,
      stdoutFile,
      stderrFile,
      stdin: invocation.stdin,
      env: invocation.env,
      timeoutMs: ctx.providerTimeoutMs(options),
      phase: `slice-implementation-${slice.id}`,
      providerKey: 'implementation',
      schemaPath: invocation.schemaPath,
      options,
      runtime: invocation.runtime,
      adapter: invocation.adapter,
      capabilitySnapshot: attempt.capabilitySnapshot,
      taskEnvelopeHash: attempt.task.hash,
      routeDecisionHash: attempt.route.decisionHash,
      onFailure: attempt.onFailure,
    }
  );

  const lastMessageText = safeRead(lastMessageFile);
  return ctx.runProviderPostProcess(attempt, record, {
    result,
    lastMessage: lastMessageText,
  }, () => {
  const runtimeOutput = ctx.providerStep('output-normalization', () => ctx.normalizeCodexOutput({
    stdout: result.stdout || safeRead(stdoutFile),
    lastMessage: lastMessageText,
    adapter: invocation.adapter,
  }));
  const agentInvocation = executionEnvelopes.createAgentInvocation({
    ref: `invocation:${state.runId}:${slice.id}:${attempt.prefix}:completed`,
    assignment: agentAssignment,
    runtime: runtimeOutput.runtime,
    adapter: runtimeOutput.adapter,
    enforcement: 'contract-enforced',
    status: runtimeOutput.status === 'succeeded' ? 'completed' : 'failed',
    actualRole: null,
    runtimeRefs: {
      codexThread: runtimeOutput.runtimeRefs.threadId,
      codexTurn: runtimeOutput.runtimeRefs.turnId,
    },
    native: {
      nativeAccepted: false,
      terminalEvent: null,
      terminalStatus: null,
      acceptanceErrors: ['codex exec does not prove named native agent selection'],
    },
  });
  const agentInvocationAcceptance = executionEnvelopes.validateAgentInvocation(
    agentAssignment,
    agentInvocation
  );
  if (!agentInvocationAcceptance.accepted) {
    const error = new Error(
      `slice ${slice.id} agent invocation rejected: ${agentInvocationAcceptance.errors.join('; ')}`
    );
    error.providerFailureKind = 'agent-invocation';
    throw withProviderRecord(error, record);
  }
  writeJson(path.join(sliceArtifactsDir, 'agent-invocation.json'), agentInvocation);
  let handoffParsed;
  try {
    handoffParsed = ctx.providerStep('structured-output-parse', () => (
      runtimeOutput.payload !== undefined && runtimeOutput.payload !== null
        ? runtimeOutput.payload
        : ctx.extractJsonValue(lastMessageText || safeRead(stdoutFile))
    ));
    ctx.assertProviderStructuredOutput(
      handoffParsed,
      'agent-handoff.schema.json',
      `pipeline implementation handoff ${slice.id}`
    );
  } catch (error) {
    writeJson(path.join(runDir, 'slices', slice.id, 'handoff.parse-error.json'), {
      message: error.message,
      stdoutFile,
      lastMessageFile,
    });
    error.message = `slice ${slice.id} impl handoff invalid: ${error.message}`;
    throw withProviderRecord(error, record);
  }
  sliceRunner.writeSliceHandoff(runDir, slice.id, handoffParsed);

  const diffPatch = ctx.writeGitDiff(workdir, runDir);
  sliceRunner.writeSliceDiff(runDir, slice.id, diffPatch);
  const afterChangedFiles = ctx.listChangedFiles(workdir, runDir);
  sliceRunner.writeSliceChangedFiles(runDir, slice.id, afterChangedFiles);
  const afterSnapshot = sliceRunner.snapshotChangedFiles(workdir, afterChangedFiles);
  const changedFilesGate = sliceRunner.evaluateSliceChangedFiles(slice, beforeSnapshot, afterSnapshot);
  sliceRunner.writeSliceChangedFilesGate(runDir, slice.id, changedFilesGate);
  try {
    sliceRunner.assertSliceChangedFilesGate(changedFilesGate);
  } catch (error) {
    error.providerFailureKind = error.providerFailureKind || 'changed-files-gate';
    throw withProviderRecord(error, record);
  }

  const validationCommands = Array.isArray(slice.validationCommands) ? slice.validationCommands : [];
  const validationStamp = ctx.logStamp();
  const validationArtifactName = `slice-validation-${validationStamp}.json`;
  const validationRunnerOptions = {
    workdir: ctx.resolveWorkdir(options),
    runDir,
    attemptId: `slice-${validationStamp}`,
    artifactName: validationArtifactName,
    logPrefix: 'slice-validation',
  };
  const configuredValidationTimeout = ctx.providerTimeoutMs(options);
  if (Number.isFinite(configuredValidationTimeout) && configuredValidationTimeout > 0) {
    validationRunnerOptions.timeoutMs = Math.min(
      validationRunner.MAX_TIMEOUT_MS,
      Math.floor(configuredValidationTimeout)
    );
  }
  const validation = validationRunner.runValidationCommands(
    validationCommands,
    validationRunnerOptions
  );
  validation.changedFilesGate = changedFilesGate;
  writeJson(path.join(runDir, validationArtifactName), validation);
  sliceRunner.writeSliceValidation(runDir, slice.id, validation);
  if (validation.status === 'blocked') {
    const blockedCommand = validation.commands.find((command) => command.status === 'blocked');
    const error = new Error(
      `slice ${slice.id} validation rejected: ${blockedCommand && blockedCommand.error ? blockedCommand.error : 'policy blocked'}`
    );
    error.providerFailureKind = 'validation';
    throw withProviderRecord(error, record);
  }

  const effectRefs = afterChangedFiles.length > 0
    ? [ctx.hashArtifact({
      changedFiles: afterChangedFiles,
      diffHash: ctx.hashArtifact(diffPatch),
    })]
    : [];
  const accepted = ctx.providerStep('acceptance', () => ctx.acceptProviderAttempt(state, attempt, {
    status: runtimeOutput.status,
    effects: {
      state: effectRefs.length > 0 ? 'committed' : 'none',
      refs: effectRefs,
    },
    runtimeRefs: {
      codexThread: runtimeOutput.runtimeRefs.threadId,
      codexTurn: runtimeOutput.runtimeRefs.turnId,
    },
    runtimeResult: runtimeOutput,
    evidence: {
      handoffHash: ctx.hashArtifact(handoffParsed),
      changedFilesGateHash: ctx.hashArtifact(changedFilesGate),
      validationHash: ctx.hashArtifact(validation),
      diffHash: ctx.hashArtifact(diffPatch),
      changedFilesHash: ctx.hashArtifact(afterChangedFiles),
      agentAssignmentHash: agentAssignment.hash,
      agentInvocationHash: agentInvocation.hash,
      agentInvocationAcceptanceHash: ctx.hashArtifact(agentInvocationAcceptance),
      baseSha,
      headSha: ctx.currentGitSha(workdir),
    },
    validation: {
      status: validation.status,
      source: `slices/${slice.id}/validation.json`,
      evidenceRef: `slices/${slice.id}/validation.json`,
    },
    payload: handoffParsed,
  }));
  record.resultEnvelopeHash = accepted.result.hash;
  record.acceptance = accepted.acceptance;
  record.runtimeRefs = accepted.result.runtimeRefs;
  record.usage = runtimeOutput.usage || record.usage;
  record.agentAssignmentHash = agentAssignment.hash;
  record.agentInvocationHash = agentInvocation.hash;
  ctx.providerPostAcceptanceStep('post-acceptance-artifact', () => ctx.writeProviderHandoffBundle(
    state,
    runDir,
    options,
    attempt,
    accepted,
    {
      relativeFile: path.join('slices', slice.id, 'provider-handoff.json'),
      recordStateFile: false,
      artifactPaths: {
        handoff: path.join('slices', slice.id, 'handoff.json'),
        diff: path.join('slices', slice.id, 'diff.patch'),
        validation: path.join('slices', slice.id, 'validation.json'),
        changedFiles: path.join('slices', slice.id, 'changed-files.json'),
        changedFilesGate: path.join('slices', slice.id, 'changed-files-gate.json'),
        agentAssignment: path.join('slices', slice.id, 'agent-assignment.json'),
        agentInvocation: path.join('slices', slice.id, 'agent-invocation.json'),
      },
    }
  ));

  let next = transitionSlice(
    recordProviderRun(state, record),
    slice.id,
    pipelineState.SLICE_STATES.IMPLEMENTED,
    { actor: 'implementation-provider', reason: 'slice implementation provider completed' }
  );
  ctx.providerPostAcceptanceStep('state-transition', () => writeJson(statePath, next));
  return next;
  });
}

function runSliceReviewProvider(ctx, state, statePath, runDir, options, slice) {
  const contract = globalContract.loadGlobalContract(runDir);
  if (!contract) throw new Error('slice review: global contract not found');
  ctx.validateProviderHandoffBundle(state, runDir, options, {
    relativeFile: path.join('slices', slice.id, 'provider-handoff.json'),
    expectedContractHash: contract.contractHash,
  });
  const diffPath = path.join(runDir, 'slices', slice.id, 'diff.patch');
  const handoffPath = path.join(runDir, 'slices', slice.id, 'handoff.json');
  const changedFilesGatePath = path.join(runDir, 'slices', slice.id, 'changed-files-gate.json');
  const prompt = slicePlanner.buildSliceReviewPrompt(contract, slice, { diffPath, handoffPath, changedFilesGatePath });
  slicePlanner.writeSlicePrompts(runDir, slice.id, { review: prompt });
  const artifactEffectRefsHash = ctx.hashArtifact(
    acceptanceEvaluator.artifactEffectRefs(runDir, path.join('slices', slice.id))
  );
  const artifactWorkspaceSnapshot = ctx.captureWorktreeSnapshot(
    ctx.resolveWorkdir(options),
    runDir
  );

  const { record, result, runtimeOutput, attempt } = callClaudeStructured(
    ctx, state, 'review', `slice-review-${slice.id}`, `slice review provider [${slice.id}]`, options, runDir,
    'review-result.schema.json', prompt, `slice-${slice.id}-review`,
    ['diff.patch', 'handoff.json', 'validation.json', 'changed-files-gate.json'].map(name => path.join('slices', slice.id, name))
  );
  return ctx.runProviderPostProcess(attempt, record, { result, runtimeOutput }, () => {
  let reviewParsed;
  try {
    reviewParsed = ctx.providerStep('structured-output-parse', () => (
      runtimeOutput.payload === undefined
        ? ctx.extractJsonValue(result.stdout || '')
        : runtimeOutput.payload
    ));
    ctx.assertProviderStructuredOutput(
      reviewParsed,
      'review-result.schema.json',
      `pipeline slice review ${slice.id}`
    );
    reviewParsed = { ...reviewParsed, criterionIds: [...slice.criterionIds] };
    review.assertCanonicalReview(reviewParsed);
  } catch (error) {
    writeJson(path.join(runDir, 'slices', slice.id, 'review.parse-error.json'), {
      message: error.message,
      stdoutFile: record.stdoutFile,
      stderrFile: record.stderrFile,
    });
    throw error;
  }
  reviewParsed = ctx.providerStep(
    'output-normalization',
    () => reconciliation.rejectRecursiveRevision({ ...reviewParsed, sliceId: slice.id })
  );
  ctx.providerStep('artifact', () => review.writeSliceReview(runDir, slice.id, reviewParsed));
  const artifactReviewStable = ctx.hashArtifact(artifactWorkspaceSnapshot) === ctx.hashArtifact(
    ctx.captureWorktreeSnapshot(ctx.resolveWorkdir(options), runDir)
  );
  const acceptedReview = ctx.providerStep('acceptance', () => acceptClaudeResult(
    ctx,
    state,
    attempt,
    record,
    runtimeOutput,
    reviewParsed,
    {
      reviewHash: ctx.hashArtifact(reviewParsed),
      artifactEffectRefsHash,
      artifactReviewStable,
    }
  ));
  let validationSeal = null;
  try {
    validationSeal = acceptanceEvaluator.sealValidationEvidence({
      workdir: ctx.resolveWorkdir(options),
      runDir,
      contract: readJson(path.join(runDir, 'acceptance-contract.json')),
      validation: readJson(path.join(runDir, 'slices', slice.id, 'validation.json')),
      workspaceSnapshot: artifactWorkspaceSnapshot,
      controlStoreOptions: acceptanceControlOptions(ctx, options),
    });
  } catch (error) {
    writeJson(path.join(runDir, 'slices', slice.id, 'acceptance-validation-seal.error.json'), {
      schemaVersion: 'acceptance-shadow-error-v1',
      status: 'error',
      message: redactSensitiveText(error && error.message ? error.message : String(error)),
    });
  }
  record.acceptanceShadow = shadowAcceptanceForResult(
    ctx.resolveWorkdir(options),
    runDir,
    path.join('slices', slice.id),
    acceptedReview,
    acceptanceControlOptions(ctx, options),
    validationSeal
  );

  return ctx.providerPostAcceptanceStep('state-transition', () => {
  let next = recordProviderRun(state, record);
  const approved = review.reviewApproved(reviewParsed);
  const revisions = Array.isArray(reviewParsed.contractRevisions) ? reviewParsed.contractRevisions : [];
  const driftEntries = [];

  if (approved && revisions.length === 0) {
    const gate = completionGate.evaluateCompletionGate(
      sliceCompletionGateInput(runDir, slice, reviewParsed)
    );
    writeJson(path.join(runDir, 'slices', slice.id, 'completion-gate.json'), gate);
    if (!gate.ok) {
      return blockSliceAfterReview(
        ctx,
        next,
        statePath,
        runDir,
        slice,
        `slice completion gate rejected: ${gate.reasons.join('; ')}`,
        gate,
        [],
        []
      );
    }
    const acceptanceVerdict = acceptanceEnforcementVerdict(
      next,
      record.acceptanceShadow,
      slice.criterionIds
    );
    if (acceptanceVerdict !== 'legacy' && acceptanceVerdict !== 'passed') {
      return blockSliceAfterReview(
        ctx,
        next,
        statePath,
        runDir,
        slice,
        `slice acceptance Receipt is ${acceptanceVerdict}`,
        gate,
        [],
        []
      );
    }
    next = transitionSlice(next, slice.id, pipelineState.SLICE_STATES.REVIEWED, {
      actor: 'review-provider',
      reason: 'slice review approved',
    });
    next = transitionSlice(next, slice.id, pipelineState.SLICE_STATES.COMPLETED, {
      actor: 'review-provider',
      reason: 'slice review approved with no revisions',
    });
    let q = queueModule.loadQueue(runDir);
    q = queueModule.moveToCompleted(q, slice.id);
    queueModule.saveQueue(runDir, q);
    let locks = locksModule.loadLocks(runDir);
    locks = locksModule.markCompletedOwner(locks, slice);
    locksModule.saveLocks(runDir, locks);
    writeJson(statePath, next);
    return { state: next, drift: [], revisions: [], completionGate: gate };
  }

  for (let index = 0; index < revisions.length; index += 1) {
    const revisionRaw = revisions[index];
    const revisionId = revisionRaw.revisionId || `rev-${slice.id}-${index + 1}`;
    const revision = {
      revisionId,
      source: 'slice-review',
      sourceSliceId: slice.id,
      createdAt: ctx.nowIso(),
      fields: revisionRaw.fields || {},
      rationale: revisionRaw.rationale || '',
      classification: 'pending',
      resolution: 'pending',
    };
    const sliceIsReconciliation = slice.type === 'reconciliation';
    const driftContext = {
      contract,
      pendingSlices: collectSlicesByState(next, 'slice-pending').concat(collectSlicesByState(next, 'slice-ready')),
      completedSlices: collectSlicesByState(next, 'slice-completed'),
      runningSlices: collectSlicesByState(next, 'slice-implementing').concat(collectSlicesByState(next, 'slice-frozen')),
      reconciliationDepthOfSource: sliceIsReconciliation ? (slice.depth || 1) : 0,
    };
    const drift = driftDetector.classify(revision, driftContext);
    revision.classification = drift.classification;
    globalContract.appendRevisionEvent(runDir, revision);
    driftEntries.push({
      revisionId,
      classification: drift.classification,
      reason: drift.reason,
      impact: { pendingSlices: driftContext.pendingSlices, completedSlices: driftContext.completedSlices },
      action: drift.action,
    });
  }
  driftDetector.writeDriftReport(runDir, driftEntries, contract.contractHash);

  const escalated = driftEntries.some((entry) => ['cross-cutting', 'breaking'].includes(entry.classification));
  if (escalated) {
    next = transitionRun(next, pipelineState.RUN_STATES.CONTRACT_CONFLICT, {
      actor: 'review-provider',
      reason: 'slice review produced breaking or cross-cutting revision',
    });
    next = transitionSlice(next, slice.id, pipelineState.SLICE_STATES.REJECTED, {
      actor: 'review-provider',
      reason: 'slice review revision escalated',
    });
    next = {
      ...next,
      pipeline: {
        ...next.pipeline,
        conflictRevisionIds: [...next.pipeline.conflictRevisionIds, ...driftEntries.map((entry) => entry.revisionId)],
        lastDriftReportAt: ctx.nowIso(),
      },
    };
    let q = queueModule.loadQueue(runDir);
    q = queueModule.moveToRejected(q, slice.id);
    queueModule.saveQueue(runDir, q);
    let locks = locksModule.loadLocks(runDir);
    locks = locksModule.releaseSliceLocks(locks, slice);
    locksModule.saveLocks(runDir, locks);
    writeJson(statePath, next);
    ctx.log(`[WARN] slice ${slice.id} triggered ${driftEntries.length} revision(s); run entered contract-conflict.`);
    return { state: next, drift: driftEntries, revisions };
  }

  const reason = revisions.length > 0
    ? `slice review proposed ${revisions.length} unresolved contract revision(s)`
    : `slice review decision=${reviewParsed.decision}`;
  const gate = completionGate.evaluateCompletionGate(
    sliceCompletionGateInput(runDir, slice, reviewParsed)
  );
  return blockSliceAfterReview(
    ctx,
    next,
    statePath,
    runDir,
    slice,
    reason,
    gate,
    driftEntries,
    revisions
  );
  });
  });
}

function collectSlicesByState(state, target) {
  if (!state.pipeline || !state.pipeline.sliceStates) return [];
  return Object.keys(state.pipeline.sliceStates).filter((id) => state.pipeline.sliceStates[id] === target);
}

function uniqueRefs(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

function integrationValidationRefs(validation) {
  const refs = [validation && validation.artifactRef];
  for (const command of (validation && Array.isArray(validation.commands) ? validation.commands : [])) {
    if (command.stdout && command.stdout.ref) refs.push(command.stdout.ref);
    if (command.stderr && command.stderr.ref) refs.push(command.stderr.ref);
  }
  return uniqueRefs(refs);
}

function integrationPipelineSummary(queue, slices) {
  return {
    requiredSlices: slices.map((slice) => slice.id),
    completedSlices: [...queue.completed],
    pendingSlices: [...queue.pending, ...queue.ready],
    runningSlices: [...queue.running],
    blockedSlices: queue.blocked.map((entry) => entry.sliceId),
  };
}

function integrationMaterialEvidence(runDir, slices) {
  const materialSliceIds = slices
    .filter((slice) => {
      const changedFiles = readJsonIfExists(
        path.join(runDir, 'slices', slice.id, 'changed-files.json'),
        []
      );
      return Array.isArray(changedFiles) && changedFiles.length > 0;
    })
    .map((slice) => slice.id);
  return {
    material: materialSliceIds.length > 0,
    refs: materialSliceIds.map((sliceId) => runRef('slices', sliceId, 'diff.patch')),
  };
}

function integrationCompletionGateInput(runDir, contract, slices, queue, reviewResult, validation) {
  const validationRefs = integrationValidationRefs(validation);
  const sliceGateRefs = slices.map((slice) => runRef('slices', slice.id, 'completion-gate.json'));
  const reviewRefs = reviewResult ? ['integration-review.json'] : [];
  const evidenceRefs = uniqueRefs([...validationRefs, ...sliceGateRefs, ...reviewRefs]);
  const materialEvidence = integrationMaterialEvidence(runDir, slices);
  const evidenceFilesExist = evidenceRefs.length > 0 && evidenceRefs.every((ref) => (
    fs.existsSync(path.join(runDir, ...ref.split('/')))
  ));
  const sliceGatesPass = slices.every((slice) => {
    const gate = readJsonIfExists(path.join(runDir, 'slices', slice.id, 'completion-gate.json'));
    return gate && gate.ok === true;
  });
  return {
    scope: 'integration',
    risk: contract.riskLevel,
    review: reviewResult,
    validation: {
      status: validation && validation.status,
      evidenceRefs: validationRefs,
    },
    material: materialEvidence.material,
    effects: materialEvidence.material
      ? { state: 'committed', refs: materialEvidence.refs }
      : { state: 'none', refs: [] },
    evidence: {
      complete: evidenceFilesExist && sliceGatesPass,
      refs: evidenceRefs,
    },
    clarifications: resolvedClarifications(reviewResult),
    revisions: reviewResult && Array.isArray(reviewResult.contractRevisions)
      ? reviewResult.contractRevisions
      : [],
    blockers: queue.blocked.map((entry) => ({
      id: entry.sliceId,
      status: 'open',
      reason: entry.reason,
    })),
    pipeline: integrationPipelineSummary(queue, slices),
  };
}

function runIntegrationValidation(ctx, state, runDir, options, commands, phase = 'integration') {
  const runner = typeof ctx.runIntegrationValidation === 'function'
    ? ctx.runIntegrationValidation
    : validationRunner.runValidationCommands;
  const configuredTimeout = ctx.providerTimeoutMs(options);
  const runnerOptions = {
    workdir: ctx.resolveWorkdir(options),
    runDir,
    attemptId: `${phase}-${ctx.logStamp()}-${Array.isArray(state.providerRuns) ? state.providerRuns.length : 0}`,
    ...(phase === 'post-review' ? {
      artifactName: 'acceptance-post-review-validation.json',
      logPrefix: 'acceptance-post-review-validation',
    } : {}),
  };
  if (Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
    runnerOptions.timeoutMs = Math.min(
      validationRunner.MAX_TIMEOUT_MS,
      Math.max(1, Math.floor(configuredTimeout))
    );
  }
  return runner(commands, runnerOptions);
}

function runIntegrationReviewProvider(ctx, state, statePath, runDir, options) {
  const contract = globalContract.loadGlobalContract(runDir);
  if (!contract) throw new Error('integration review: global contract not found');
  const slices = slicePlanner.loadAllSlices(runDir);
  const frozenAcceptanceContract = resolvedAcceptanceContract(runDir, contract);
  if (!frozenAcceptanceContract || !Array.isArray(frozenAcceptanceContract.criteria)) {
    throw new Error('integration review requires a frozen acceptance contract');
  }
  const requiredCriterionIds = new Set(
    frozenAcceptanceContract.criteria.map((criterion) => criterion.id)
  );
  const integrationCriterionIds = Array.isArray(contract.integrationCriterionIds)
    ? contract.integrationCriterionIds
    : [];
  const declaredCriterionIds = [
    ...slices.flatMap((slice) => Array.isArray(slice.criterionIds) ? slice.criterionIds : []),
    ...integrationCriterionIds,
  ];
  const coveredCriterionIds = new Set(declaredCriterionIds);
  const missingCriterionIds = [...requiredCriterionIds].filter(
    (criterionId) => !coveredCriterionIds.has(criterionId)
  );
  const unknownCriterionIds = [...coveredCriterionIds].filter(
    (criterionId) => !requiredCriterionIds.has(criterionId)
  );
  const duplicateCriterionIds = [...new Set(declaredCriterionIds.filter(
    (criterionId, index) => declaredCriterionIds.indexOf(criterionId) !== index
  ))];
  if (missingCriterionIds.length > 0 || unknownCriterionIds.length > 0
      || duplicateCriterionIds.length > 0) {
    throw new Error(
      `integration criterion coverage is invalid; missing=${missingCriterionIds.join(',') || 'none'}; unknown=${unknownCriterionIds.join(',') || 'none'}; duplicate=${duplicateCriterionIds.join(',') || 'none'}`
    );
  }
  const aggregated = review.aggregateIntegrationValidationCommands(contract, slices);
  const queue = queueModule.loadQueue(runDir);
  let validation;
  try {
    validation = runIntegrationValidation(ctx, state, runDir, options, aggregated);
  } catch (error) {
    const errorArtifact = {
      schemaVersion: 'integration-validation-error-v1',
      status: 'failed',
      artifactRef: 'integration-validation.error.json',
      message: error.message,
      generatedAt: ctx.nowIso(),
    };
    writeJson(path.join(runDir, errorArtifact.artifactRef), errorArtifact);
    const gate = completionGate.evaluateCompletionGate(integrationCompletionGateInput(
      runDir,
      contract,
      slices,
      queue,
      null,
      errorArtifact
    ));
    writeJson(path.join(runDir, 'integration-completion-gate.json'), gate);
    writeJson(statePath, state);
    ctx.log(`[GATE] integration validation could not run: ${error.message}`);
    return state;
  }

  if (!validation || validation.status !== 'passed') {
    let validationAcceptance = null;
    if (validation && validation.status === 'failed') {
      try {
        const validationWorkspaceSnapshot = ctx.captureWorktreeSnapshot(
          ctx.resolveWorkdir(options),
          runDir
        );
        const acceptanceContract = readJson(path.join(runDir, 'acceptance-contract.json'));
        const failedSeal = acceptanceEvaluator.sealValidationEvidence({
          workdir: ctx.resolveWorkdir(options),
          runDir,
          contract: acceptanceContract,
          validation,
          workspaceSnapshot: validationWorkspaceSnapshot,
          controlStoreOptions: acceptanceControlOptions(ctx, options),
        });
        const validationSubject = {
          ref: `validation:${validation.attemptId}`,
          schemaVersion: 'acceptance-validation-subject-v1',
          attemptId: validation.attemptId,
          artifactHash: failedSeal.artifactHash,
          workspaceSnapshotHash: ctx.hashArtifact(validationWorkspaceSnapshot),
        };
        validationAcceptance = recordShadowAcceptance({
          workdir: ctx.resolveWorkdir(options),
          runDir,
          relativeDir: '.',
          controlStoreOptions: acceptanceControlOptions(ctx, options),
          validationSeal: failedSeal,
          subjectRef: validationSubject.ref,
          subject: validationSubject,
        });
      } catch (error) {
        writeJson(path.join(runDir, 'acceptance-validation-seal.error.json'), {
          schemaVersion: 'acceptance-shadow-error-v1',
          status: 'error',
          message: redactSensitiveText(error && error.message ? error.message : String(error)),
        });
      }
    }
    const gate = completionGate.evaluateCompletionGate(integrationCompletionGateInput(
      runDir,
      contract,
      slices,
      queue,
      null,
      validation || { status: 'failed', artifactRef: 'integration-validation.json', commands: [] }
    ));
    writeJson(path.join(runDir, 'integration-completion-gate.json'), gate);
    const next = state.acceptanceProtocol === 'v1'
      ? {
        ...state,
        acceptanceStatus: acceptanceEnforcementVerdict(
          state,
          validationAcceptance,
          integrationCriterionIds
        ),
        completionGateStatus: 'failed',
      }
      : state;
    writeJson(statePath, next);
    ctx.log(`[GATE] integration validation status=${validation && validation.status ? validation.status : 'missing'}; reviewer was not called.`);
    return next;
  }

  const validationWorkspaceSnapshot = ctx.captureWorktreeSnapshot(
    ctx.resolveWorkdir(options),
    runDir
  );
  let validationSeal = null;
  try {
    validationSeal = acceptanceEvaluator.sealValidationEvidence({
      workdir: ctx.resolveWorkdir(options),
      runDir,
      contract: readJson(path.join(runDir, 'acceptance-contract.json')),
      validation,
      workspaceSnapshot: validationWorkspaceSnapshot,
      controlStoreOptions: acceptanceControlOptions(ctx, options),
    });
  } catch (error) {
    writeJson(path.join(runDir, 'acceptance-validation-seal.error.json'), {
      schemaVersion: 'acceptance-shadow-error-v1',
      status: 'error',
      message: redactSensitiveText(error && error.message ? error.message : String(error)),
    });
  }

  const prompt = slicePlanner.buildIntegrationReviewPrompt(contract, slices, {
    executedValidation: aggregated,
    validationArtifactPath: validation.artifactRef,
    validationStatus: validation.status,
  });
  writeText(path.join(runDir, 'prompts', 'integration-review.md'), prompt);
  const artifactEffectRefsHash = ctx.hashArtifact(
    acceptanceEvaluator.artifactEffectRefs(runDir, '.')
  );

  const { record, result, runtimeOutput, attempt } = callClaudeStructured(
    ctx, state, 'review', 'integration-review', 'integration review provider', options, runDir,
    'review-result.schema.json', prompt, 'integration-review',
    ['integration-validation.json', ...slices.flatMap(slice => ['diff.patch', 'handoff.json', 'validation.json', 'review.json'].map(name => path.join('slices', slice.id, name)))]
  );
  return ctx.runProviderPostProcess(attempt, record, { result, runtimeOutput }, () => {
  let reviewParsed;
  try {
    reviewParsed = ctx.providerStep('structured-output-parse', () => (
      runtimeOutput.payload === undefined
        ? ctx.extractJsonValue(result.stdout || '')
        : runtimeOutput.payload
    ));
    ctx.assertProviderStructuredOutput(
      reviewParsed,
      'review-result.schema.json',
      'pipeline integration review'
    );
  reviewParsed = {
    ...reviewParsed,
    criterionIds: frozenAcceptanceContract.criteria.map((criterion) => criterion.id),
  };
  review.assertCanonicalReview(reviewParsed);
  } catch (error) {
    writeJson(path.join(runDir, 'integration-review.parse-error.json'), {
      message: error.message,
      stdoutFile: record.stdoutFile,
    });
    throw error;
  }
  ctx.providerStep('artifact', () => review.writeIntegrationReview(runDir, reviewParsed));
  const currentWorkspaceSnapshot = ctx.captureWorktreeSnapshot(ctx.resolveWorkdir(options), runDir);
  const reviewChangedWorkspace = ctx.hashArtifact(currentWorkspaceSnapshot)
    !== ctx.hashArtifact(validationWorkspaceSnapshot);
  const acceptedReview = ctx.providerStep('acceptance', () => acceptClaudeResult(
    ctx,
    state,
    attempt,
    record,
    runtimeOutput,
    reviewParsed,
    {
      reviewHash: ctx.hashArtifact(reviewParsed),
      artifactEffectRefsHash,
      artifactReviewStable: !reviewChangedWorkspace,
    }
  ));
  let effectiveValidation = validation;
  try {
    const postReviewValidation = runIntegrationValidation(
      ctx, state, runDir, options, aggregated, 'post-review'
    );
    effectiveValidation = postReviewValidation;
    validationSeal = acceptanceEvaluator.sealValidationEvidence({
      workdir: ctx.resolveWorkdir(options),
      runDir,
      contract: readJson(path.join(runDir, 'acceptance-contract.json')),
      validation: postReviewValidation,
      workspaceSnapshot: ctx.captureWorktreeSnapshot(ctx.resolveWorkdir(options), runDir),
      controlStoreOptions: acceptanceControlOptions(ctx, options),
    });
    if (reviewChangedWorkspace) {
      writeJson(path.join(runDir, 'acceptance-review-workspace-drift.json'), {
        schemaVersion: 'acceptance-review-workspace-drift-v1',
        revalidated: true,
      });
    }
  } catch (error) {
    validationSeal = null;
    writeJson(path.join(runDir, 'acceptance-validation-seal.error.json'), {
      schemaVersion: 'acceptance-shadow-error-v1',
      status: 'error',
      message: redactSensitiveText(error && error.message ? error.message : String(error)),
    });
  }
  record.acceptanceShadow = shadowAcceptanceForResult(
    ctx.resolveWorkdir(options),
    runDir,
    '.',
    acceptedReview,
    acceptanceControlOptions(ctx, options),
    validationSeal
  );

  return ctx.providerPostAcceptanceStep('state-transition', () => {
  let next = recordProviderRun(state, record);
  const gate = completionGate.evaluateCompletionGate(integrationCompletionGateInput(
    runDir,
    contract,
    slices,
    queue,
    reviewParsed,
    effectiveValidation
  ));
  writeJson(path.join(runDir, 'integration-completion-gate.json'), gate);
  const acceptanceVerdict = acceptanceEnforcementVerdict(
    next,
    record.acceptanceShadow,
    integrationCriterionIds
  );
  next = {
    ...next,
    acceptanceStatus: acceptanceVerdict,
    completionGateStatus: gate.ok ? 'passed' : 'failed',
  };
  if (gate.ok && (acceptanceVerdict === 'legacy' || acceptanceVerdict === 'passed')) {
    next = transitionRun(next, pipelineState.RUN_STATES.COMPLETED, {
      actor: 'review-provider',
      reason: 'integration completion gate passed',
    });
    writeJson(statePath, next);
    ctx.log(`[OK] integration completion gate passed; run ${state.runId} completed.`);
    return next;
  }
  writeJson(statePath, next);
  const denial = acceptanceVerdict !== 'legacy' && acceptanceVerdict !== 'passed'
    ? `acceptance Receipt is ${acceptanceVerdict}`
    : gate.reasons.join('; ');
  ctx.log(`[GATE] integration completion denied: ${denial}`);
  return next;
  });
  });
}

module.exports = {
  runGlobalContractProvider,
  runSlicePlannerProvider,
  runSliceImplementationProvider,
  runSliceReviewProvider,
  runIntegrationReviewProvider,
  collectSlicesByState,
  recordShadowAcceptance,
};
