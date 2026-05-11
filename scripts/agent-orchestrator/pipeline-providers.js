'use strict';

const fs = require('fs');
const path = require('path');

const globalContract = require('./global-contract');
const slicePlanner = require('./slice-planner');
const sliceNormalizer = require('./slice-normalizer');
const sliceRunner = require('./slice-runner');
const review = require('./review');
const queueModule = require('./queue');
const locksModule = require('./locks');
const driftDetector = require('./drift-detector');
const reconciliation = require('./reconciliation');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeText(file, content) { ensureDir(path.dirname(file)); fs.writeFileSync(file, content); }
function writeJson(file, data) { writeText(file, `${JSON.stringify(data, null, 2)}\n`); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function safeRead(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }

function recordProviderRun(state, record) {
  if (!Array.isArray(state.providerRuns)) state.providerRuns = [];
  return { ...state, providerRuns: [...state.providerRuns, record] };
}

function callClaudeStructured(ctx, label, options, runDir, schemaName, prompt, logPrefix) {
  const stamp = ctx.logStamp();
  const stdoutFile = ctx.stampedLogPath(runDir, logPrefix, 'stdout.log', stamp);
  const stderrFile = ctx.stampedLogPath(runDir, logPrefix, 'stderr.log', stamp);
  const args = ['-p', '--input-format', 'text', '--output-format', 'json'];
  if (!ctx.boolOption(options, 'skip-cli-schema')) {
    args.push('--json-schema', ctx.schemaJson(schemaName));
  }
  const { record, result } = ctx.runProcess(
    label,
    ctx.providerLaunch(options, 'spec'),
    args,
    {
      cwd: ctx.resolveWorkdir(options),
      stdoutFile,
      stderrFile,
      stdin: prompt,
      timeoutMs: ctx.providerTimeoutMs(options),
      env: ctx.claudeProviderEnv(),
    }
  );
  return { record, result, stdoutFile, stderrFile };
}

function runGlobalContractProvider(ctx, state, statePath, runDir, options) {
  const prompt = safeRead(path.join(runDir, 'prompts', 'global-contract.md'));
  if (!prompt.trim()) throw new Error('global-contract prompt is empty');
  const { record, result } = callClaudeStructured(
    ctx, 'global contract provider', options, runDir,
    'global-contract.schema.json', prompt, 'global-contract'
  );
  let parsed;
  try {
    parsed = ctx.extractJsonValue(result.stdout || '');
  } catch (error) {
    writeJson(path.join(runDir, 'global-contract.parse-error.json'), {
      message: error.message,
      stdoutFile: record.stdoutFile,
      stderrFile: record.stderrFile,
    });
    throw new Error(`global contract provider output unparseable: ${error.message}`);
  }
  writeJson(path.join(runDir, 'global-contract.raw.json'), parsed);
  const normalized = globalContract.writeGlobalContract(runDir, parsed, 'initial');
  let next = recordProviderRun(state, record);
  next = {
    ...next,
    status: 'global-contract-ready',
    files: { ...next.files, globalContract: 'global-contract.json' },
  };
  writeJson(statePath, next);
  ctx.log(`[OK] global contract generated (hash=${normalized.contractHash}); review at ${path.join(runDir, 'global-contract.json')}`);
  return next;
}

function runSlicePlannerProvider(ctx, state, statePath, runDir, options) {
  const contract = globalContract.loadGlobalContract(runDir);
  if (!contract) throw new Error('slice planner: global contract not found');
  const alreadyPlanned = slicePlanner.listSliceIds(runDir);
  const prompt = slicePlanner.buildSlicePlannerPrompt(contract, alreadyPlanned, { workdir: ctx.resolveWorkdir(options) });
  writeText(path.join(runDir, 'prompts', `slice-planner-${alreadyPlanned.length}.md`), prompt);
  const { record, result } = callClaudeStructured(
    ctx, 'slice planner provider', options, runDir,
    'pipeline-slice.schema.json', prompt, `slice-planner-${alreadyPlanned.length}`
  );
  let parsed;
  try {
    parsed = ctx.extractJsonValue(result.stdout || '');
  } catch (error) {
    throw new Error(`slice planner output unparseable: ${error.message}`);
  }
  const rawSlices = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed && parsed.slices) ? parsed.slices : [];
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
    nextState = {
      ...nextState,
      pipeline: {
        ...nextState.pipeline,
        sliceStates: { ...nextState.pipeline.sliceStates, [normalized.id]: 'slice-pending' },
      },
    };
    const staticCheck = sliceNormalizer.evaluateStaticCanStart(normalized);
    if (staticCheck.canStart && !normalized.rejected) {
      q = queueModule.moveToReady(q, normalized.id);
      nextState = {
        ...nextState,
        pipeline: {
          ...nextState.pipeline,
          sliceStates: { ...nextState.pipeline.sliceStates, [normalized.id]: 'slice-ready' },
        },
      };
    }
  }
  queueModule.saveQueue(runDir, q);
  if (rawSlices.length === 0) {
    nextState = {
      ...nextState,
      status: 'integration-ready',
      pipeline: { ...nextState.pipeline, lastSliceBatchAt: ctx.nowIso() },
    };
    ctx.log('[INFO] slice planner returned no new slices; entering integration-ready.');
  } else {
    nextState = {
      ...nextState,
      status: queueModule.hasActiveWork(q) ? 'executing-slices' : 'planning-slices',
      pipeline: { ...nextState.pipeline, lastSliceBatchAt: ctx.nowIso() },
    };
    ctx.log(`[OK] slice planner produced ${rawSlices.length} slice(s).`);
  }
  writeJson(statePath, nextState);
  return nextState;
}

function runSliceImplementationProvider(ctx, state, statePath, runDir, options, slice) {
  const contract = globalContract.loadGlobalContract(runDir);
  if (!contract) throw new Error('slice impl: global contract not found');
  const prompt = sliceRunner.buildSliceImplementPrompt(contract, slice, { workdir: ctx.resolveWorkdir(options) });
  slicePlanner.writeSlicePrompts(runDir, slice.id, { implement: prompt });

  const stamp = ctx.logStamp();
  const logPrefix = `slice-${slice.id}-impl`;
  const stdoutFile = ctx.stampedLogPath(runDir, logPrefix, 'stdout.log', stamp);
  const stderrFile = ctx.stampedLogPath(runDir, logPrefix, 'stderr.log', stamp);
  const lastMessageFile = ctx.stampedLogPath(runDir, logPrefix, 'last-message.json', stamp);
  const args = ['exec', '-C', ctx.resolveWorkdir(options), '--json'];
  args.push('--output-last-message', lastMessageFile);
  const sandbox = ctx.codexSandboxMode(options);
  if (sandbox) args.push('--sandbox', sandbox);
  if (!ctx.isGitRepository(ctx.resolveWorkdir(options)) || ctx.boolOption(options, 'skip-git-repo-check')) {
    args.push('--skip-git-repo-check');
  }
  if (!ctx.boolOption(options, 'skip-cli-schema')) {
    args.push('--output-schema', ctx.schemaPath('agent-handoff.schema.json'));
  }
  args.push('-');

  const { record } = ctx.runProcess(
    `slice impl provider [${slice.id}]`,
    ctx.providerLaunch(options, 'implementation'),
    args,
    {
      cwd: ctx.resolveWorkdir(options),
      stdoutFile,
      stderrFile,
      stdin: prompt,
      timeoutMs: ctx.providerTimeoutMs(options),
    }
  );

  const lastMessageText = safeRead(lastMessageFile);
  let handoffParsed;
  try {
    handoffParsed = ctx.extractJsonValue(lastMessageText || safeRead(stdoutFile));
  } catch (error) {
    writeJson(path.join(runDir, 'slices', slice.id, 'handoff.parse-error.json'), {
      message: error.message,
      stdoutFile,
      lastMessageFile,
    });
    throw new Error(`slice ${slice.id} impl handoff unparseable: ${error.message}`);
  }
  sliceRunner.writeSliceHandoff(runDir, slice.id, handoffParsed);

  const diffPatch = ctx.writeGitDiff(ctx.resolveWorkdir(options), runDir);
  sliceRunner.writeSliceDiff(runDir, slice.id, diffPatch);

  const validationCommands = Array.isArray(slice.validationCommands) ? slice.validationCommands : [];
  const validation = { status: 'skipped', commands: [], generatedAt: ctx.nowIso() };
  if (validationCommands.length > 0) {
    validation.status = 'passed';
    for (let index = 0; index < validationCommands.length; index += 1) {
      const command = validationCommands[index];
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
    throw new Error(`slice ${slice.id} validation failed; see ${path.join(runDir, 'slices', slice.id, 'validation.json')}`);
  }

  let next = recordProviderRun(state, record);
  next = {
    ...next,
    pipeline: {
      ...next.pipeline,
      sliceStates: {
        ...next.pipeline.sliceStates,
        [slice.id]: 'slice-implemented',
      },
    },
  };
  writeJson(statePath, next);
  return next;
}

function runSliceReviewProvider(ctx, state, statePath, runDir, options, slice) {
  const contract = globalContract.loadGlobalContract(runDir);
  if (!contract) throw new Error('slice review: global contract not found');
  const diffPath = path.join(runDir, 'slices', slice.id, 'diff.patch');
  const handoffPath = path.join(runDir, 'slices', slice.id, 'handoff.json');
  const prompt = slicePlanner.buildSliceReviewPrompt(contract, slice, { diffPath, handoffPath });
  slicePlanner.writeSlicePrompts(runDir, slice.id, { review: prompt });

  const { record, result } = callClaudeStructured(
    ctx, `slice review provider [${slice.id}]`, options, runDir,
    'review-result.schema.json', prompt, `slice-${slice.id}-review`
  );
  let reviewParsed;
  try {
    reviewParsed = ctx.extractJsonValue(result.stdout || '');
  } catch (error) {
    writeJson(path.join(runDir, 'slices', slice.id, 'review.parse-error.json'), {
      message: error.message,
      stdoutFile: record.stdoutFile,
      stderrFile: record.stderrFile,
    });
    throw new Error(`slice ${slice.id} review unparseable: ${error.message}`);
  }
  reviewParsed = reconciliation.rejectRecursiveRevision({ ...reviewParsed, sliceId: slice.id });
  review.writeSliceReview(runDir, slice.id, reviewParsed);

  let next = recordProviderRun(state, record);
  const approved = review.reviewApproved(reviewParsed);
  const revisions = Array.isArray(reviewParsed.contractRevisions) ? reviewParsed.contractRevisions : [];
  const driftEntries = [];

  if (approved && revisions.length === 0) {
    next = {
      ...next,
      pipeline: {
        ...next.pipeline,
        sliceStates: {
          ...next.pipeline.sliceStates,
          [slice.id]: 'slice-completed',
        },
      },
    };
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
    next = {
      ...next,
      status: 'contract-conflict',
      pipeline: {
        ...next.pipeline,
        sliceStates: { ...next.pipeline.sliceStates, [slice.id]: 'slice-rejected' },
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

  next = {
    ...next,
    pipeline: {
      ...next.pipeline,
      sliceStates: { ...next.pipeline.sliceStates, [slice.id]: 'slice-completed' },
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

  const { record, result } = callClaudeStructured(
    ctx, 'integration review provider', options, runDir,
    'review-result.schema.json', prompt, 'integration-review'
  );
  let reviewParsed;
  try {
    reviewParsed = ctx.extractJsonValue(result.stdout || '');
  } catch (error) {
    writeJson(path.join(runDir, 'integration-review.parse-error.json'), {
      message: error.message,
      stdoutFile: record.stdoutFile,
    });
    throw new Error(`integration review unparseable: ${error.message}`);
  }
  review.writeIntegrationReview(runDir, reviewParsed);

  let next = recordProviderRun(state, record);
  if (review.reviewApproved(reviewParsed)) {
    next = { ...next, status: 'completed' };
    writeJson(statePath, next);
    ctx.log(`[OK] integration review approved; run ${state.runId} completed.`);
    return next;
  }
  next = { ...next, status: 'executing-slices' };
  writeJson(statePath, next);
  ctx.log(`[WARN] integration review decision=${reviewParsed.decision || 'unknown'}; run returns to executing-slices for follow-up.`);
  return next;
}

module.exports = {
  runGlobalContractProvider,
  runSlicePlannerProvider,
  runSliceImplementationProvider,
  runSliceReviewProvider,
  runIntegrationReviewProvider,
  collectSlicesByState,
};
