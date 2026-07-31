'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCapabilitySnapshot } = require('./runtime-capabilities');
const { decideRoute } = require('./capability-router');
const {
  createProviderHandoff,
  createResultEnvelope,
  createTaskEnvelope,
  deriveIdempotencyKey,
  validateResultForAcceptance,
} = require('./execution-envelopes');
const goalLease = require('./goal-lease');

const CASES = Object.freeze([
  'single-host',
  'cross-runtime-read-only-review',
  'worktree-handoff',
  'resume',
  'partial-effects',
  'duplicate-result',
]);

function bool(value) {
  return value === true;
}

function evaluateCase(caseId, evidence = {}) {
  if (!CASES.includes(caseId)) throw new Error(`unknown canary case: ${caseId}`);
  const failures = [];
  const require = (condition, label) => {
    if (!condition) failures.push(label);
  };

  switch (caseId) {
    case 'single-host':
      require(evidence.schedulerCount === 1, 'schedulerCount must be 1');
      require(evidence.writerCount === 1, 'writerCount must be 1');
      require(bool(evidence.schemaValid), 'schemaValid must be true');
      break;
    case 'cross-runtime-read-only-review':
      require(Boolean(evidence.writerRuntime), 'writerRuntime is required');
      require(Boolean(evidence.reviewerRuntime), 'reviewerRuntime is required');
      require(evidence.writerRuntime !== evidence.reviewerRuntime, 'reviewer runtime must differ');
      require(bool(evidence.reviewerReadOnly), 'reviewerReadOnly must be true');
      require(bool(evidence.contractHashMatch), 'contractHashMatch must be true');
      break;
    case 'worktree-handoff':
      require(bool(evidence.baseShaMatch), 'baseShaMatch must be true');
      require(bool(evidence.mainWorktreeUnchanged), 'mainWorktreeUnchanged must be true');
      require(bool(evidence.diffHashVerified), 'diffHashVerified must be true');
      break;
    case 'resume':
      require(bool(evidence.sameHostRef), 'sameHostRef must be true');
      require(bool(evidence.repeatedFlagsHashMatch), 'repeatedFlagsHashMatch must be true');
      require(bool(evidence.noDuplicateEffects), 'noDuplicateEffects must be true');
      break;
    case 'partial-effects':
      require(evidence.status === 'partial-effects', 'status must be partial-effects');
      require(evidence.fallbackAttempted === false, 'fallbackAttempted must be false');
      require(bool(evidence.reconciliationRequired), 'reconciliationRequired must be true');
      break;
    case 'duplicate-result':
      require(bool(evidence.firstAccepted), 'firstAccepted must be true');
      require(evidence.secondAccepted === false, 'secondAccepted must be false');
      require(evidence.canonicalWrites === 1, 'canonicalWrites must be 1');
      break;
    default:
      break;
  }

  return { caseId, passed: failures.length === 0, failures };
}

function checkRecords(records) {
  if (!Array.isArray(records)) throw new Error('canary records must be an array');
  const byCase = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') throw new Error('canary record must be an object');
    if (byCase.has(record.caseId)) throw new Error(`duplicate canary case: ${record.caseId}`);
    byCase.set(record.caseId, evaluateCase(record.caseId, record.evidence));
  }
  const missing = CASES.filter((caseId) => !byCase.has(caseId));
  if (missing.length > 0) throw new Error(`missing canary cases: ${missing.join(', ')}`);
  const failed = [...byCase.values()].filter((result) => !result.passed);
  if (failed.length > 0) {
    throw new Error(`native runtime canary failed: ${failed.map((item) =>
      `${item.caseId}: ${item.failures.join('; ')}`).join(' | ')}`);
  }
  return { ok: true, cases: CASES, records: records.length };
}

function hashBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hashFile(file) {
  return hashBytes(fs.readFileSync(file));
}

function writeJson(file, value) {
  fs.writeFileSync(
    file,
    `${JSON.stringify(value, null, 2)}\n`,
    { flag: 'wx' }
  );
  return file;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function prepareArtifactRoot(artifactRoot) {
  if (typeof artifactRoot !== 'string' || artifactRoot.trim() === '') {
    throw new Error('artifactRoot must be a non-empty path');
  }
  const resolved = path.resolve(artifactRoot);
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new Error(`artifact root is not a directory: ${resolved}`);
  }
  fs.mkdirSync(resolved, { recursive: true });
  if (fs.readdirSync(resolved).length > 0) {
    throw new Error(`artifact root must be empty: ${resolved}`);
  }
  return resolved;
}

function artifactDescriptor(role, file) {
  return {
    role,
    path: path.resolve(file),
    hash: hashFile(file),
  };
}

function createProvenance(artifactRoot, hashes, artifactEntries) {
  return {
    kind: 'deterministic-module-artifacts',
    scope: 'offline-contract-only',
    artifactRoot,
    ...hashes,
    artifacts: artifactEntries.map(([role, file]) =>
      artifactDescriptor(role, file)),
  };
}

function verifyArtifactProvenance(records) {
  if (!Array.isArray(records)) throw new Error('canary records must be an array');
  const verified = new Map();
  for (const record of records) {
    const provenance = record && record.provenance;
    if (!provenance || provenance.kind !== 'deterministic-module-artifacts') {
      throw new Error(`${record && record.caseId}: deterministic provenance is required`);
    }
    if (provenance.scope !== 'offline-contract-only') {
      throw new Error(`${record.caseId}: provenance scope must be offline-contract-only`);
    }
    if (typeof provenance.artifactRoot !== 'string'
        || provenance.artifactRoot.trim() === '') {
      throw new Error(`${record.caseId}: provenance artifactRoot is required`);
    }
    if (!Array.isArray(provenance.artifacts)
        || provenance.artifacts.length === 0) {
      throw new Error(`${record.caseId}: provenance artifacts are required`);
    }
    const root = path.resolve(provenance.artifactRoot);
    for (const artifact of provenance.artifacts) {
      if (!artifact || typeof artifact !== 'object') {
        throw new Error(`${record.caseId}: provenance artifact must be an object`);
      }
      if (typeof artifact.role !== 'string' || artifact.role.trim() === '') {
        throw new Error(`${record.caseId}: provenance artifact role is required`);
      }
      if (typeof artifact.path !== 'string' || artifact.path.trim() === '') {
        throw new Error(`${record.caseId}: provenance artifact path is required`);
      }
      if (!/^sha256:[a-f0-9]{64}$/.test(artifact.hash || '')) {
        throw new Error(`${record.caseId}: provenance artifact hash is invalid`);
      }
      const file = path.resolve(artifact.path);
      const relative = path.relative(root, file);
      if (relative === '' || relative === '..'
          || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${record.caseId}: artifact escapes artifactRoot: ${file}`);
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error(`${record.caseId}: provenance artifact is missing: ${file}`);
      }
      const actualHash = hashFile(file);
      if (actualHash !== artifact.hash) {
        throw new Error(`${record.caseId}: provenance hash mismatch for ${file}`);
      }
      const previous = verified.get(file);
      if (previous && previous !== artifact.hash) {
        throw new Error(`${record.caseId}: inconsistent provenance hash for ${file}`);
      }
      verified.set(file, artifact.hash);
    }
  }
  return { ok: true, records: records.length, artifacts: verified.size };
}

function canarySnapshot(runtime, profileId, adapter, observed, deniedCapabilities = []) {
  const capabilities = Object.keys(observed).sort();
  return createCapabilitySnapshot({
    runtime,
    profileId,
    adapter,
    declaredCapabilities: capabilities,
    documentedMaturity: 'stable',
    runtimeObserved: observed,
    observedAt: '2026-07-30T00:00:00.000Z',
    probeError: null,
    source: 'deterministic-canary',
    policy: { deniedCapabilities },
  });
}

function deriveCanaryRecords(artifactRoot) {
  const root = prepareArtifactRoot(artifactRoot);
  const codexSnapshot = canarySnapshot(
    'codex',
    'implementation-coding-v1',
    'codex-exec',
    { 'repo-read': true, 'workspace-write': true }
  );
  const claudeSnapshot = canarySnapshot(
    'claude',
    'review-independent-v1',
    'claude-print',
    { 'repo-read': true, 'workspace-write': true },
    ['workspace-write']
  );
  const task = createTaskEnvelope({
    ref: 'task:deterministic-canary:implementation',
    orchestrationOwner: 'tp',
    intent: 'write',
    requiredCapabilities: ['repo-read', 'workspace-write'],
    runtimeRefs: {},
    payload: { contractHash: hashBytes('deterministic-canary-contract') },
  });
  const candidates = [
    {
      ref: 'codex-writer',
      providerKey: 'implementation',
      priority: 10,
      snapshot: codexSnapshot,
    },
    {
      ref: 'claude-review',
      providerKey: 'review',
      priority: 20,
      snapshot: claudeSnapshot,
    },
  ];
  const route = decideRoute({
    task,
    candidates,
    policy: { allowReadOnlyFallback: true },
  });

  const files = {
    accepted: path.join(root, 'accepted-result.json'),
    claudeSnapshot: path.join(root, 'claude-capability.json'),
    codexSnapshot: path.join(root, 'codex-capability.json'),
    diff: path.join(root, 'worktree.diff'),
    duplicateAttempt: path.join(root, 'duplicate-attempt.json'),
    goalInitial: path.join(root, 'goal-lease-initial.json'),
    goalResumed: path.join(root, 'goal-lease-resumed.json'),
    handoff: path.join(root, 'provider-handoff.json'),
    mainMarker: path.join(root, 'main-worktree.marker'),
    partialInitialRoute: path.join(root, 'partial-initial-route.json'),
    partialResult: path.join(root, 'partial-result.json'),
    partialResumeRoute: path.join(root, 'partial-resume-route.json'),
    partialTask: path.join(root, 'partial-task.json'),
    policyInitial: path.join(root, 'execution-policy-initial.json'),
    policyResumed: path.join(root, 'execution-policy-resumed.json'),
    result: path.join(root, 'result-envelope.json'),
    route: path.join(root, 'route-decision.json'),
    task: path.join(root, 'task-envelope.json'),
    validation: path.join(root, 'validation.json'),
  };
  fs.writeFileSync(files.diff, 'diff --git a/example b/example\n+implemented\n', { flag: 'wx' });
  writeJson(files.validation, { status: 'passed', tests: 1 });
  fs.writeFileSync(files.mainMarker, 'unchanged\n', { flag: 'wx' });
  const mainBefore = hashFile(files.mainMarker);
  const diffHash = hashFile(files.diff);
  const validationHash = hashFile(files.validation);
  const headSha = hashBytes(`${mainBefore}\n${diffHash}\n`);

  const result = createResultEnvelope({
    ref: 'result:deterministic-canary:implementation',
    task,
    route,
    providerRef: route.writer.candidateRef,
    status: 'succeeded',
    effects: { state: 'committed', refs: [diffHash] },
    runtimeRefs: { codexThread: 'thread-canary', codexTurn: 'turn-canary' },
    evidence: { baseSha: mainBefore, diffHash, headSha, validationHash },
    payload: { summary: 'deterministic canary implementation' },
  });
  const handoff = createProviderHandoff({
    ref: 'handoff:deterministic-canary:review',
    task,
    route,
    result,
    from: route.writer.candidateRef,
    to: 'claude-review',
    readOnly: true,
    runtimeRefs: { codexThread: 'thread-canary', claudeSession: 'session-canary' },
  });

  writeJson(files.codexSnapshot, codexSnapshot);
  writeJson(files.claudeSnapshot, claudeSnapshot);
  writeJson(files.task, task);
  writeJson(files.route, route);
  writeJson(files.result, result);
  writeJson(files.handoff, handoff);

  const lease = goalLease.acquireGoalLease(null, {
    runId: 'deterministic-canary',
    ownerRuntime: 'codex',
    objective: 'verify deterministic native runtime contracts',
    hostRef: 'thread-canary',
    now: '2026-07-30T00:00:00.000Z',
  });
  const resumedLease = goalLease.acquireGoalLease(lease, {
    runId: 'deterministic-canary',
    ownerRuntime: 'codex',
    objective: 'verify deterministic native runtime contracts',
    hostRef: 'thread-canary',
    now: '2026-07-30T00:01:00.000Z',
  });
  const policy = { owner: 'tp', router: 'shadow', claude: 'print', codex: 'exec' };
  writeJson(files.goalInitial, lease);
  writeJson(files.goalResumed, resumedLease);
  writeJson(files.policyInitial, policy);
  writeJson(files.policyResumed, { ...policy });

  const partialTask = createTaskEnvelope({
    ref: 'task:deterministic-canary:partial',
    orchestrationOwner: 'tp',
    intent: 'write',
    requiredCapabilities: ['repo-read', 'workspace-write'],
    runtimeRefs: {},
    payload: { contractHash: hashBytes('deterministic-canary-partial-contract') },
  });
  const partialInitialRoute = decideRoute({
    task: partialTask,
    candidates,
    policy: { allowReadOnlyFallback: true },
  });
  const partialResult = createResultEnvelope({
    ref: 'result:deterministic-canary:partial',
    task: partialTask,
    route: partialInitialRoute,
    providerRef: partialInitialRoute.writer.candidateRef,
    status: 'failed',
    effects: { state: 'partial', refs: [diffHash] },
    runtimeRefs: { codexThread: 'thread-canary-partial' },
    evidence: { diffHash },
    payload: { summary: 'partial effects require explicit reconciliation' },
  });
  const partialResumeRoute = decideRoute({
    task: { ...partialTask, effectsState: partialResult.effects.state },
    candidates,
    policy: { allowReadOnlyFallback: true },
  });
  writeJson(files.partialTask, partialTask);
  writeJson(files.partialInitialRoute, partialInitialRoute);
  writeJson(files.partialResult, partialResult);
  writeJson(files.partialResumeRoute, partialResumeRoute);

  writeJson(files.accepted, result);
  let secondWriteError = null;
  const conflicting = createResultEnvelope({
    ref: result.ref,
    task,
    route,
    providerRef: route.writer.candidateRef,
    status: 'succeeded',
    effects: result.effects,
    runtimeRefs: result.runtimeRefs,
    evidence: result.evidence,
    payload: { summary: 'conflicting duplicate' },
  });
  try {
    writeJson(files.accepted, conflicting);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    secondWriteError = error.code;
  }
  writeJson(files.duplicateAttempt, {
    firstHash: result.hash,
    secondHash: conflicting.hash,
    sameIdempotencyKey: result.idempotencyKey === conflicting.idempotencyKey,
    secondWriteError,
  });

  const persisted = {
    accepted: readJson(files.accepted),
    duplicateAttempt: readJson(files.duplicateAttempt),
    goalInitial: readJson(files.goalInitial),
    goalResumed: readJson(files.goalResumed),
    handoff: readJson(files.handoff),
    partialResult: readJson(files.partialResult),
    partialResumeRoute: readJson(files.partialResumeRoute),
    policyInitial: readJson(files.policyInitial),
    policyResumed: readJson(files.policyResumed),
    result: readJson(files.result),
    route: readJson(files.route),
    task: readJson(files.task),
  };
  const persistedAcceptance = validateResultForAcceptance(
    persisted.task,
    persisted.result,
    persisted.route
  );
  const schedulerOwners = new Set([
    persisted.task.orchestrationOwner,
    persisted.route.orchestrationOwner,
  ]);
  const writerAssignments = [
    persisted.route.primary,
    ...(persisted.route.fallbacks || []),
  ].filter((assignment) => assignment && assignment.access === 'write');
  const reviewer = (persisted.route.fallbacks || []).find((assignment) =>
    assignment.candidateRef === persisted.handoff.to);
  const partialReasons = (persisted.partialResumeRoute.rejected || [])
    .flatMap((entry) => entry.reasons || []);
  const canonicalWrites = persisted.accepted.hash === persisted.result.hash ? 1 : 0;
  const duplicateWasRejected = persisted.duplicateAttempt.secondWriteError === 'EEXIST';
  const commonHashes = {
    taskHash: task.hash,
    routeHash: route.decisionHash,
    resultHash: result.hash,
    handoffHash: handoff.hash,
  };
  return [
    {
      caseId: 'single-host',
      evidence: {
        schedulerCount: schedulerOwners.size,
        writerCount: writerAssignments.length,
        schemaValid: persistedAcceptance.accepted,
      },
      provenance: createProvenance(root, commonHashes, [
        ['task-envelope', files.task],
        ['route-decision', files.route],
        ['result-envelope', files.result],
      ]),
    },
    {
      caseId: 'cross-runtime-read-only-review',
      evidence: {
        writerRuntime: persisted.route.writer.runtime,
        reviewerRuntime: reviewer && reviewer.runtime,
        reviewerReadOnly: persisted.handoff.readOnly,
        contractHashMatch: persisted.handoff.taskHash === persisted.task.hash
          && persisted.handoff.resultHash === persisted.result.hash,
      },
      provenance: createProvenance(root, commonHashes, [
        ['codex-capability', files.codexSnapshot],
        ['claude-capability', files.claudeSnapshot],
        ['route-decision', files.route],
        ['provider-handoff', files.handoff],
      ]),
    },
    {
      caseId: 'worktree-handoff',
      evidence: {
        baseShaMatch: persisted.result.evidence.baseSha === mainBefore,
        mainWorktreeUnchanged: mainBefore === hashFile(files.mainMarker),
        diffHashVerified: persisted.result.evidence.diffHash === hashFile(files.diff)
          && persisted.result.evidence.validationHash === hashFile(files.validation),
      },
      provenance: createProvenance(root, commonHashes, [
        ['main-worktree-marker', files.mainMarker],
        ['worktree-diff', files.diff],
        ['validation-evidence', files.validation],
        ['result-envelope', files.result],
        ['provider-handoff', files.handoff],
      ]),
    },
    {
      caseId: 'resume',
      evidence: {
        sameHostRef: persisted.goalInitial.hostRef === persisted.goalResumed.hostRef,
        repeatedFlagsHashMatch: deriveIdempotencyKey(persisted.policyInitial)
          === deriveIdempotencyKey(persisted.policyResumed),
        noDuplicateEffects: duplicateWasRejected && canonicalWrites === 1,
      },
      provenance: createProvenance(root, commonHashes, [
        ['goal-lease-initial', files.goalInitial],
        ['goal-lease-resumed', files.goalResumed],
        ['execution-policy-initial', files.policyInitial],
        ['execution-policy-resumed', files.policyResumed],
        ['accepted-result', files.accepted],
        ['duplicate-attempt', files.duplicateAttempt],
      ]),
    },
    {
      caseId: 'partial-effects',
      evidence: {
        status: persisted.partialResult.effects.state === 'partial'
          ? 'partial-effects'
          : 'none',
        fallbackAttempted: persisted.partialResumeRoute.fallbacks.length > 0,
        reconciliationRequired: persisted.partialResumeRoute.status === 'blocked'
          && partialReasons.includes('partial-effects-require-resume'),
      },
      provenance: createProvenance(root, {
        ...commonHashes,
        partialTaskHash: partialTask.hash,
        partialRouteHash: partialResumeRoute.decisionHash,
        partialResultHash: partialResult.hash,
      }, [
        ['partial-task', files.partialTask],
        ['partial-initial-route', files.partialInitialRoute],
        ['partial-result', files.partialResult],
        ['partial-resume-route', files.partialResumeRoute],
      ]),
    },
    {
      caseId: 'duplicate-result',
      evidence: {
        firstAccepted: persisted.accepted.hash === persisted.result.hash,
        secondAccepted: !duplicateWasRejected,
        canonicalWrites,
      },
      provenance: createProvenance(root, {
        ...commonHashes,
        conflictingResultHash: conflicting.hash,
      }, [
        ['result-envelope', files.result],
        ['accepted-result', files.accepted],
        ['duplicate-attempt', files.duplicateAttempt],
      ]),
    },
  ];
}

function runDeterministicCanary(options = {}) {
  const ownsRoot = !options.artifactRoot;
  const artifactRoot = options.artifactRoot
    ? path.resolve(options.artifactRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'tp-native-runtime-canary-'));
  try {
    const records = deriveCanaryRecords(artifactRoot);
    const recordsFile = path.join(artifactRoot, 'canary-records.json');
    writeJson(recordsFile, records);
    const serializedRecords = readJson(recordsFile);
    const provenance = verifyArtifactProvenance(serializedRecords);
    const checked = checkRecords(serializedRecords);
    return {
      ...checked,
      mode: 'deterministic-artifact-derived',
      evidenceTrust: 'artifact-derived-verified',
      artifactRoot: ownsRoot ? null : artifactRoot,
      recordsFile: ownsRoot ? null : recordsFile,
      artifactsVerified: provenance.artifacts,
      records: serializedRecords.map((record) => ({
        caseId: record.caseId,
        provenance: {
          kind: record.provenance.kind,
          scope: record.provenance.scope,
        },
      })),
    };
  } finally {
    if (ownsRoot) fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
}

module.exports = {
  CASES,
  checkRecords,
  deriveCanaryRecords,
  evaluateCase,
  runDeterministicCanary,
  verifyArtifactProvenance,
};
