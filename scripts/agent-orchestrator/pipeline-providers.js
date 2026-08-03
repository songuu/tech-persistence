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
const validationPolicy = require('./validation-command-policy');
const { redactSensitiveText, redactArtifactValue } = require('../lib/redaction');
const executionEnvelopes = require('./execution-envelopes');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeText(file, content) { ensureDir(path.dirname(file)); fs.writeFileSync(file, redactSensitiveText(String(content))); }
function writeJson(file, data) { writeText(file, `${JSON.stringify(data, null, 2)}\n`); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function safeRead(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }

function recordProviderRun(state, record) {
  if (!Array.isArray(state.providerRuns)) state.providerRuns = [];
  return { ...state, providerRuns: [...state.providerRuns, record] };
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

function callClaudeStructured(ctx, state, providerKey, stage, label, options, runDir, schemaName, prompt, logPrefix) {
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
    ctx.providerResumeRefs(state, 'claude', providerKey, stage)
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
    runtimeRefs: {
      claudeSession: runtimeOutput.runtimeRefs.sessionId,
    },
    runtimeResult: runtimeOutput,
    evidence,
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
  const validation = { status: 'skipped', commands: [], generatedAt: ctx.nowIso(), changedFilesGate };
  if (validationCommands.length > 0) {
    validation.status = 'passed';
    for (let index = 0; index < validationCommands.length; index += 1) {
      const command = validationCommands[index];
      const decision = validationPolicy.validateGeneratedValidationCommand(command, { workdir: ctx.resolveWorkdir(options) });
      if (!decision.ok) {
        validation.status = 'blocked';
        validation.commands.push({ command, policy: decision });
        sliceRunner.writeSliceValidation(runDir, slice.id, validation);
        const error = new Error(`slice ${slice.id} validation rejected: ${decision.reason}`);
        error.providerFailureKind = 'validation';
        throw withProviderRecord(error, record);
      }
      const vStamp = ctx.logStamp();
      const vOut = ctx.stampedLogPath(runDir, `slice-${slice.id}-validation-${index}`, 'stdout.log', vStamp);
      const vErr = ctx.stampedLogPath(runDir, `slice-${slice.id}-validation-${index}`, 'stderr.log', vStamp);
      const vRecord = ctx.runShell(`slice ${slice.id} validation [${index}]`, command, {
        cwd: ctx.resolveWorkdir(options),
        stdoutFile: vOut,
        stderrFile: vErr,
        timeoutMs: ctx.providerTimeoutMs(options),
      });
      validation.commands.push({ command, ...vRecord });
      if (vRecord.status !== 0) validation.status = 'failed';
    }
  }
  sliceRunner.writeSliceValidation(runDir, slice.id, validation);
  if (validation.status === 'failed') {
    const error = new Error(
      `slice ${slice.id} validation failed; see ${path.join(runDir, 'slices', slice.id, 'validation.json')}`
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

  const { record, result, runtimeOutput, attempt } = callClaudeStructured(
    ctx, state, 'review', `slice-review-${slice.id}`, `slice review provider [${slice.id}]`, options, runDir,
    'review-result.schema.json', prompt, `slice-${slice.id}-review`
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
  ctx.providerStep('acceptance', () => acceptClaudeResult(
    ctx,
    state,
    attempt,
    record,
    runtimeOutput,
    reviewParsed,
    { reviewHash: ctx.hashArtifact(reviewParsed) }
  ));

  return ctx.providerPostAcceptanceStep('state-transition', () => {
  let next = recordProviderRun(state, record);
  const approved = review.reviewApproved(reviewParsed);
  const revisions = Array.isArray(reviewParsed.contractRevisions) ? reviewParsed.contractRevisions : [];
  const driftEntries = [];

  if (approved && revisions.length === 0) {
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
    return { state: next, drift: [], revisions: [] };
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
    writeJson(statePath, next);
    ctx.log(`[WARN] slice ${slice.id} triggered ${driftEntries.length} revision(s); run entered contract-conflict.`);
    return { state: next, drift: driftEntries, revisions };
  }

  next = transitionSlice(next, slice.id, pipelineState.SLICE_STATES.REVIEWED, {
    actor: 'review-provider',
    reason: 'slice review accepted local revision',
  });
  next = transitionSlice(next, slice.id, pipelineState.SLICE_STATES.COMPLETED, {
    actor: 'review-provider',
    reason: 'slice review completed with local revision',
  });
  next = {
    ...next,
    pipeline: {
      ...next.pipeline,
      lastDriftReportAt: ctx.nowIso(),
    },
  };
  let q = queueModule.loadQueue(runDir);
  q = queueModule.moveToCompleted(q, slice.id);
  queueModule.saveQueue(runDir, q);
  let locks = locksModule.loadLocks(runDir);
  locks = locksModule.markCompletedOwner(locks, slice);
  locksModule.saveLocks(runDir, locks);
  writeJson(statePath, next);
  return { state: next, drift: driftEntries, revisions };
  });
  });
}

function collectSlicesByState(state, target) {
  if (!state.pipeline || !state.pipeline.sliceStates) return [];
  return Object.keys(state.pipeline.sliceStates).filter((id) => state.pipeline.sliceStates[id] === target);
}

function runIntegrationReviewProvider(ctx, state, statePath, runDir, options) {
  const contract = globalContract.loadGlobalContract(runDir);
  if (!contract) throw new Error('integration review: global contract not found');
  const slices = slicePlanner.loadAllSlices(runDir);
  const aggregated = review.aggregateIntegrationValidationCommands(contract, slices);
  const prompt = slicePlanner.buildIntegrationReviewPrompt(contract, slices, { aggregatedValidation: aggregated });
  writeText(path.join(runDir, 'prompts', 'integration-review.md'), prompt);

  const { record, result, runtimeOutput, attempt } = callClaudeStructured(
    ctx, state, 'review', 'integration-review', 'integration review provider', options, runDir,
    'review-result.schema.json', prompt, 'integration-review'
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
  } catch (error) {
    writeJson(path.join(runDir, 'integration-review.parse-error.json'), {
      message: error.message,
      stdoutFile: record.stdoutFile,
    });
    throw error;
  }
  ctx.providerStep('artifact', () => review.writeIntegrationReview(runDir, reviewParsed));
  ctx.providerStep('acceptance', () => acceptClaudeResult(
    ctx,
    state,
    attempt,
    record,
    runtimeOutput,
    reviewParsed,
    { reviewHash: ctx.hashArtifact(reviewParsed) }
  ));

  return ctx.providerPostAcceptanceStep('state-transition', () => {
  let next = recordProviderRun(state, record);
  if (review.reviewApproved(reviewParsed)) {
    next = transitionRun(next, pipelineState.RUN_STATES.COMPLETED, {
      actor: 'review-provider',
      reason: 'integration review approved',
    });
    writeJson(statePath, next);
    ctx.log(`[OK] integration review approved; run ${state.runId} completed.`);
    return next;
  }
  next = transitionRun(next, pipelineState.RUN_STATES.EXECUTING_SLICES, {
    actor: 'review-provider',
    reason: 'integration review requested follow-up',
  });
  writeJson(statePath, next);
  ctx.log(`[WARN] integration review decision=${reviewParsed.decision || 'unknown'}; run returns to executing-slices for follow-up.`);
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
};
