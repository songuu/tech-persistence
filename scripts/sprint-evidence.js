#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readActiveSprint } = require('./lib/codex-active-sprint');
const { normalizeBinding, verifySprintAcceptance } = require('./lib/codex-sprint-acceptance');
const { collectAcceptanceShadowReport } = require('./agent-orchestrator/acceptance-shadow-report');
const controlStore = require('./agent-orchestrator/control-store');
const { inspectTranscriptFile, collectTranscriptSnapshot } = require('./lib/codex-transcript-projection');
const {
  loadPostgresConnectionConfig,
  openPostgresPool,
  verifyTranscriptReadback,
} = require('./lib/codex-transcript-postgres');
const { loadEnvFile } = require('./sync-codex-transcripts');
const { redactSensitiveText } = require('./lib/redaction');

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SESSION_FILES = 20_000;
const HASH = /^sha256:[a-f0-9]{64}$/;

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    plan: null,
    controlRoot: null,
    transcriptSpool: null,
    configPath: null,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--plan') {
      options.plan = requireValue(argv, index, option);
      index += 1;
    } else if (option === '--control-root') {
      options.controlRoot = requireValue(argv, index, option);
      index += 1;
    } else if (option === '--transcript-spool') {
      options.transcriptSpool = requireValue(argv, index, option);
      index += 1;
    } else if (option === '--config') {
      options.configPath = requireValue(argv, index, option);
      index += 1;
    } else if (option === '--json') options.json = true;
    else if (option === '--help' || option === '-h') options.help = true;
    else throw new Error(`Unknown option: ${option}`);
  }
  return options;
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realpath(file) {
  return fs.realpathSync.native ? fs.realpathSync.native(file) : fs.realpathSync(file);
}

function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function insideReal(root, candidate) {
  return inside(realpath(root), realpath(candidate));
}

function readBoundedJson(file, root, optional = false) {
  const resolved = path.resolve(file);
  if (root && !inside(root, resolved)) throw new Error('evidence artifact escapes its root');
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (optional && error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
    throw new Error('evidence artifact must be a bounded regular file');
  }
  if (root && !insideReal(root, resolved)) throw new Error('evidence artifact escaped its real root');
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function normalizePlan(cwd, sprint, requestedPlan) {
  const plan = requestedPlan || (sprint.active ? sprint.plan : null);
  if (!plan) return null;
  const workspace = path.resolve(cwd);
  const plansRoot = path.join(workspace, 'docs', 'plans');
  const resolved = path.resolve(workspace, plan);
  if (!inside(plansRoot, resolved)) throw new Error('evidence plan must stay below docs/plans');
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('evidence plan must be a regular file');
  if (!insideReal(plansRoot, resolved)) throw new Error('evidence plan escaped the real plans root');
  return {
    relative: path.relative(workspace, resolved).replace(/\\/g, '/'),
    resolved,
  };
}

function publicProviderRun(record) {
  const accepted = record && record.acceptance && record.acceptance.accepted === true
    && HASH.test(record.taskEnvelopeHash || '')
    && HASH.test(record.routeDecisionHash || '')
    && HASH.test(record.resultEnvelopeHash || '');
  return {
    runtime: typeof record.runtime === 'string' ? record.runtime : null,
    phase: typeof record.phase === 'string' ? record.phase : null,
    taskEnvelopeHash: HASH.test(record.taskEnvelopeHash || '') ? record.taskEnvelopeHash : null,
    routeDecisionHash: HASH.test(record.routeDecisionHash || '') ? record.routeDecisionHash : null,
    resultEnvelopeHash: HASH.test(record.resultEnvelopeHash || '') ? record.resultEnvelopeHash : null,
    accepted,
    transcript: record && record.transcript && typeof record.transcript === 'object'
      ? {
        status: String(record.transcript.status || 'unknown'),
        jobHash: HASH.test(record.transcript.jobHash || '') ? record.transcript.jobHash : null,
        requestJobHash: HASH.test(record.transcript.requestJobHash || '')
          ? record.transcript.requestJobHash
          : null,
      }
      : null,
  };
}

function emptyHarness(status = 'not-used') {
  return {
    status,
    runLocator: null,
    contractHash: null,
    bindingHash: null,
    providerRunCount: 0,
    acceptedRunCount: 0,
    receiptCount: 0,
    receiptStatuses: [],
    errors: [],
    providerRuns: [],
  };
}

function inspectHarnessDefault({ cwd, sprint, plan, controlRoot }) {
  if (!plan) return emptyHarness();
  const bindingFile = `${plan.resolved}.acceptance.json`;
  const rawBinding = readBoundedJson(bindingFile, path.dirname(plan.resolved), true);
  if (!rawBinding) return emptyHarness();
  const boundedBinding = normalizeBinding(rawBinding);
  if (boundedBinding.plan !== plan.relative) {
    throw new Error('Sprint Acceptance binding targets another plan');
  }
  const boundedRunDir = path.resolve(boundedBinding.runLocator);
  if (!inside(cwd, boundedRunDir)) throw new Error('Sprint Harness run escapes the workspace');
  const runStat = fs.lstatSync(boundedRunDir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink() || !insideReal(cwd, boundedRunDir)) {
    throw new Error('Sprint Harness run must be a plain workspace directory');
  }
  const binding = verifySprintAcceptance({
    cwd,
    plan: plan.relative,
    controlRoot,
    requirePassed: false,
  });
  if (binding.bindingHash !== boundedBinding.bindingHash) {
    throw new Error('Sprint Acceptance binding changed during evidence readback');
  }
  const runDir = path.resolve(binding.runLocator);
  const state = readBoundedJson(path.join(runDir, 'state.json'), runDir, true);
  const providerRuns = state && Array.isArray(state.providerRuns)
    ? state.providerRuns.map(publicProviderRun)
    : [];
  const acceptedRunCount = providerRuns.filter((record) => record.accepted).length;
  let receiptCount = 0;
  let receiptStatuses = [];
  const errors = [];
  try {
    const report = collectAcceptanceShadowReport(path.dirname(runDir), {
      providerRoot: path.resolve(cwd),
      controlRoot: controlRoot || undefined,
    });
    const target = report.runs.find((entry) => (
      pathKey(entry.runLocator) === pathKey(binding.runLocator)
      && entry.contractHash === binding.contractHash
    ));
    const targetHasErrors = report.errors.some((entry) => entry.run === path.basename(runDir));
    if (target && !targetHasErrors) {
      receiptCount = target.receipts.length;
      receiptStatuses = target.receipts.map((receipt) => receipt.overallStatus);
    }
    if (targetHasErrors) {
      errors.push('authority-readback-invalid');
    }
  } catch {
    errors.push('authority-readback-unavailable');
  }
  let status = 'acceptance-bound';
  if (acceptedRunCount > 0) status = 'external-execution';
  else if (providerRuns.length > 0) status = 'external-attempted';
  else if (receiptCount > 0) status = 'acceptance-only';
  return {
    status,
    runLocator: binding.runLocator,
    contractHash: binding.contractHash,
    bindingHash: binding.bindingHash,
    providerRunCount: providerRuns.length,
    acceptedRunCount,
    receiptCount,
    receiptStatuses,
    errors,
    providerRuns,
  };
}

function inspectRuntimeTranscriptDefault(providerRuns, transcriptSpool) {
  const records = providerRuns.filter((record) => record.transcript);
  if (records.length === 0) {
    return { status: 'not-used', jobCount: 0, verifiedAckCount: 0, transcriptIds: [], evidence: [] };
  }
  const captureIncomplete = records.some((record) => record.transcript.status === 'capture-incomplete');
  const jobHashes = [...new Set(records.flatMap((record) => [
    record.transcript.jobHash,
    record.transcript.requestJobHash,
  ]).filter((value) => HASH.test(value || '')))];
  if (captureIncomplete || jobHashes.length === 0) {
    return {
      status: 'capture-incomplete', jobCount: jobHashes.length, verifiedAckCount: 0,
      transcriptIds: [], evidence: jobHashes,
    };
  }
  if (!transcriptSpool) {
    return {
      status: 'queued', jobCount: jobHashes.length, verifiedAckCount: 0,
      transcriptIds: [], evidence: jobHashes,
    };
  }
  const root = path.resolve(transcriptSpool);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Transcript spool must be a plain directory');
  }
  const transcriptIds = [];
  let verifiedAckCount = 0;
  for (const jobHash of jobHashes) {
    const name = `${jobHash.replace(':', '-')}.json`;
    const ack = readBoundedJson(path.join(root, 'acks', name), path.join(root, 'acks'), true);
    if (!ack) continue;
    if (ack.jobHash !== jobHash || ack.verified !== true || typeof ack.transcriptId !== 'string') {
      throw new Error('Transcript acknowledgement is invalid');
    }
    verifiedAckCount += 1;
    transcriptIds.push(ack.transcriptId);
  }
  const status = jobHashes.length > 0 && verifiedAckCount === jobHashes.length
    ? 'synced'
    : verifiedAckCount > 0 ? 'partial' : 'queued';
  return { status, jobCount: jobHashes.length, verifiedAckCount, transcriptIds, evidence: jobHashes };
}

function findCodexTranscript(codexHome, sessionId) {
  const root = path.join(codexHome, 'sessions');
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  const queue = [root];
  let visited = 0;
  const matches = [];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_SESSION_FILES) throw new Error('Codex session inventory exceeds evidence limit');
      const file = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) {
        matches.push(file);
      }
    }
  }
  if (matches.length !== 1) return null;
  return matches[0];
}

function readTranscriptConfig(configPath) {
  const config = readBoundedJson(configPath, path.dirname(configPath), true);
  if (!config || !config.transcriptSync || config.transcriptSync.enabled !== true) return null;
  const value = config.transcriptSync;
  if (typeof value.envFile !== 'string' || !path.isAbsolute(value.envFile)) {
    throw new Error('Transcript config envFile must be absolute');
  }
  return value;
}

async function inspectHostTranscriptDefault({ env, home, configPath }) {
  const sessionId = env.CODEX_SESSION_ID || null;
  if (!sessionId) {
    return { status: 'not-found', sessionId: null, eventCount: 0, lastSyncedAt: null, evidence: [] };
  }
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  const transcriptFile = findCodexTranscript(codexHome, sessionId);
  if (!transcriptFile) {
    return { status: 'not-found', sessionId, eventCount: 0, lastSyncedAt: null, evidence: [] };
  }
  const sessionsRoot = path.join(codexHome, 'sessions');
  const header = inspectTranscriptFile(transcriptFile, {
    sessionsRoot,
    expectedRootSessionId: sessionId,
  });
  const evidence = [`transcript:${header.transcript.transcriptId}`];
  const resolvedConfig = path.resolve(configPath || env.TECH_PERSISTENCE_CONFIG
    || path.join(home, '.tech-persistence', 'config.json'));
  let syncConfig;
  try {
    syncConfig = readTranscriptConfig(resolvedConfig);
  } catch {
    return { status: 'config-invalid', sessionId, eventCount: null, lastSyncedAt: null, evidence };
  }
  if (!syncConfig) {
    return { status: 'local-only', sessionId, eventCount: null, lastSyncedAt: null, evidence };
  }
  const databaseEnv = {};
  let reader;
  try {
    loadEnvFile(syncConfig.envFile, databaseEnv);
    const readerConfig = loadPostgresConnectionConfig(databaseEnv, 'read');
    reader = await openPostgresPool(readerConfig, 'evidence-reader');
    const identity = await reader.query(
      "SELECT current_user AS role_name, current_setting('transaction_read_only')::boolean AS read_only"
    );
    if (identity.rows.length !== 1 || identity.rows[0].read_only !== true) {
      throw new Error('Transcript evidence connection is not read-only');
    }
    const row = await reader.query({
      text: 'SELECT event_count, last_synced_at FROM public.transcripts WHERE transcript_id = $1',
      values: [header.transcript.transcriptId],
    });
    if (row.rows.length === 0) {
      return { status: 'postgres-pending', sessionId, eventCount: 0, lastSyncedAt: null, evidence };
    }
    if (row.rows.length !== 1) throw new Error('Transcript evidence readback is ambiguous');
    const storedCount = Number(row.rows[0].event_count);
    const lastSyncedAt = row.rows[0].last_synced_at
      ? new Date(row.rows[0].last_synced_at).toISOString()
      : null;
    const snapshot = await collectTranscriptSnapshot(transcriptFile, {
      sessionsRoot,
      expectedRootSessionId: sessionId,
    });
    try {
      await verifyTranscriptReadback(reader, {
        transcriptId: snapshot.transcript.transcriptId,
        eventCount: snapshot.eventCount,
        nextByteOffset: snapshot.nextByteOffset,
        lastEventSha256: snapshot.lastEventSha256,
        eventChainSha256: snapshot.eventChainSha256,
        projectionChainSha256: snapshot.projectionChainSha256,
      });
    } catch {
      return { status: 'postgres-pending', sessionId, eventCount: storedCount, lastSyncedAt, evidence };
    }
    return {
      status: 'postgres-synced', sessionId, eventCount: snapshot.eventCount,
      lastSyncedAt, evidence: [...evidence, 'postgres-independent-readback'],
    };
  } catch {
    return { status: 'postgres-unavailable', sessionId, eventCount: null, lastSyncedAt: null, evidence };
  } finally {
    if (reader) await reader.end().catch(() => {});
  }
}

function combineTranscript(sprint, runtime, host) {
  if (runtime.status !== 'not-used') {
    return {
      status: runtime.status,
      association: 'harness-provider-run',
      runtime,
      host,
    };
  }
  if (host.status === 'postgres-synced') {
    return {
      status: sprint.active ? 'synced' : 'unbound-synced',
      association: sprint.active ? 'current-host-session' : 'no-active-sprint',
      runtime,
      host,
    };
  }
  if (host.status !== 'not-found') {
    return {
      status: sprint.active ? host.status : 'unbound-local',
      association: sprint.active ? 'current-host-session' : 'no-active-sprint',
      runtime,
      host,
    };
  }
  return { status: 'not-used', association: 'none', runtime, host };
}

async function collectSprintEvidence(options = {}, dependencies = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = dependencies.env || process.env;
  const home = dependencies.home || os.homedir();
  const sprint = (dependencies.readActiveSprint || readActiveSprint)(cwd);
  const plan = (dependencies.normalizePlan || normalizePlan)(cwd, sprint, options.plan);
  const selectedIsActive = sprint.active === true && plan !== null && sprint.plan === plan.relative;
  const selectedSprint = {
    ...sprint,
    active: selectedIsActive,
    reason: selectedIsActive
      ? null
      : options.plan ? 'selected-plan-not-active' : sprint.reason || 'inactive',
  };
  const harness = dependencies.inspectHarness
    ? dependencies.inspectHarness({ cwd, sprint, plan, controlRoot: options.controlRoot })
    : inspectHarnessDefault({ cwd, sprint, plan, controlRoot: options.controlRoot });
  const runtimeTranscript = dependencies.inspectRuntimeTranscript
    ? dependencies.inspectRuntimeTranscript(harness.providerRuns || [], options.transcriptSpool)
    : inspectRuntimeTranscriptDefault(harness.providerRuns || [], options.transcriptSpool);
  const hostTranscript = await (dependencies.inspectHostTranscript || inspectHostTranscriptDefault)({
    cwd,
    env,
    home,
    configPath: options.configPath,
  });
  const transcript = combineTranscript(selectedSprint, runtimeTranscript, hostTranscript);
  const harnessUsed = harness.providerRunCount > 0 || harness.receiptCount > 0;
  const transcriptCaptured = runtimeTranscript.jobCount > 0 || hostTranscript.status !== 'not-found';
  const transcriptSynced = runtimeTranscript.status === 'synced'
    || (runtimeTranscript.status === 'not-used' && hostTranscript.status === 'postgres-synced');
  const sprintTranscriptBound = runtimeTranscript.jobCount > 0
    || (selectedSprint.active && hostTranscript.status !== 'not-found');
  return {
    schemaVersion: 'sprint-runtime-evidence-v1',
    generatedAt: new Date().toISOString(),
    sprint: {
      active: selectedSprint.active,
      reason: selectedSprint.reason,
      plan: plan ? plan.relative : null,
      currentActivePlan: sprint.active === true ? sprint.plan : null,
      phase: selectedSprint.active ? sprint.phase : null,
      status: selectedSprint.active ? sprint.status : null,
      acceptanceProtocol: selectedSprint.active ? sprint.acceptanceProtocol : null,
    },
    harness,
    transcript,
    verdict: { harnessUsed, transcriptCaptured, transcriptSynced, sprintTranscriptBound },
  };
}

function display(value) {
  return value === null || value === undefined || value === '' ? '-' : String(value);
}

function formatSprintEvidence(evidence) {
  const host = evidence.transcript.host;
  const runtime = evidence.transcript.runtime;
  return [
    'Sprint runtime evidence',
    `  Sprint: ${evidence.sprint.active ? `${display(evidence.sprint.phase)}/${display(evidence.sprint.status)}` : `inactive (${display(evidence.sprint.reason)})`}`,
    `  Plan: ${display(evidence.sprint.plan)}`,
    `  Harness: ${evidence.harness.status}`,
    `    providerRuns=${evidence.harness.providerRunCount}, accepted=${evidence.harness.acceptedRunCount}, receipts=${evidence.harness.receiptCount}`,
    `    run=${display(evidence.harness.runLocator)}, contract=${display(evidence.harness.contractHash)}`,
    `  Transcript: ${evidence.transcript.status}`,
    `    association=${evidence.transcript.association}, runtimeJobs=${runtime.jobCount}, verifiedAcks=${runtime.verifiedAckCount}`,
    `    hostSession=${display(host.sessionId)}, hostStatus=${host.status}, events=${display(host.eventCount)}, lastSyncedAt=${display(host.lastSyncedAt)}`,
    `  Verdict: harnessUsed=${evidence.verdict.harnessUsed}, transcriptCaptured=${evidence.verdict.transcriptCaptured}, transcriptSynced=${evidence.verdict.transcriptSynced}, sprintTranscriptBound=${evidence.verdict.sprintTranscriptBound}`,
  ].join('\n');
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/sprint-evidence.js [options]',
    '',
    'Options:',
    '  --plan <docs/plans/*.md>   Inspect a historical/completed Sprint plan.',
    '  --control-root <path>      Override the external Acceptance authority root.',
    '  --transcript-spool <path>  Verify Harness runtime transcript acknowledgements.',
    '  --config <path>            Override ~/.tech-persistence/config.json.',
    '  --json                     Emit canonical JSON instead of the human summary.',
    '  --help                     Show this help.',
    '',
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const evidence = await collectSprintEvidence(options);
  process.stdout.write(options.json
    ? `${JSON.stringify(evidence, null, 2)}\n`
    : `${formatSprintEvidence(evidence)}\n`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`[SPRINT_EVIDENCE_FAILED] ${redactSensitiveText(error.message)}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  collectSprintEvidence,
  combineTranscript,
  formatSprintEvidence,
  inspectHarnessDefault,
  inspectRuntimeTranscriptDefault,
  parseArgs,
};
