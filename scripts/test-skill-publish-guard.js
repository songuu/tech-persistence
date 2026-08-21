#!/usr/bin/env node

/**
 * test-skill-publish-guard.js
 *
 * Tests the skill-eval-results CLI (record + guard subcommands), focused on
 * exit-code policy: only comparable status=ok exits 0. Regression, no-baseline,
 * identity mismatch, malformed data, internal errors, and usage errors exit 2.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { stableHash } = require('./lib/self-learning-canonical');
const { addCase, readCases } = require('./lib/skill-eval-cases');
const {
  stageEvaluationArtifactAuthority,
} = require('./lib/self-learning-evaluation-artifacts');
const { detectStableProjectIdentity, readOriginRemote } = require('./lib/project-identity');
const { resolveStoreDir } = require('./lib/self-learning-store');
const {
  appendBehaviorEvent,
  appendEvidenceRef,
  normalizeEvidenceRef,
} = require('./lib/behavior-events');
const { closeBehaviorEpisode } = require('./lib/behavior-episodes');
const {
  approveCandidate,
  evaluateCandidate,
  governCandidate,
  promoteCandidate,
  proposeCandidate,
  transitionCandidate,
} = require('./lib/learning-candidates');

const CLI = path.join(__dirname, 'skill-eval-results.js');
const {
  checkPublishGuard,
  artifactContentHash,
  EVAL_RESULTS_SCHEMA_VERSION,
  MAX_ARTIFACT_BYTES,
  recordAuthoritativeResult,
  resolveCandidateArtifactFile,
  resolveResultsFile,
  resultHash,
} = require('./lib/skill-eval-results');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

function makeBaseDir() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-guard-'));
  fs.writeFileSync(
    path.join(baseDir, 'config.json'),
    `${JSON.stringify({ self_learning: { retention_days: 36500 } })}\n`,
    'utf8'
  );
  return baseDir;
}

function makeTrustedRepoBaseDir() {
  const baseDir = makeBaseDir();
  const gitDir = path.join(baseDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  const remote = readOriginRemote(path.resolve(__dirname, '..'));
  if (!remote) throw new Error('publish guard fixture requires the repository origin remote');
  fs.writeFileSync(
    path.join(gitDir, 'config'),
    `[remote "origin"]\n\turl = ${remote}\n`,
    'utf8'
  );
  return baseDir;
}

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd || path.resolve(__dirname, '..'),
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) throw result.error;
  return result;
}

function digest(label) {
  return stableHash({ label });
}

function targetSourcePath(targetKey) {
  const [kind, name] = targetKey.split(':');
  return kind === 'command'
    ? `user-level/commands/${name}.md`
    : `codex-native/skills/${name}/SKILL.md`;
}

function writeTargetSource(repoRoot, targetKey, content) {
  const sourcePath = targetSourcePath(targetKey);
  const sourceFile = path.join(repoRoot, ...sourcePath.split('/'));
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, content, 'utf8');
  return {
    key: targetKey,
    source_path: sourcePath,
    source_hash: artifactContentHash(content),
  };
}

const AUTHORITY_CASE_COUNT = 25;
function evaluationAuthority(baseDir, name, candidateId, passRate) {
  let cases = readCases(name, { baseDir });
  if (cases.length === 0) {
    const storeDir = resolveStoreDir(baseDir, projectId);
    for (let index = 0; index < AUTHORITY_CASE_COUNT; index += 1) {
      const input = `fixture input ${index + 1}`;
      const prompt = appendBehaviorEvent(storeDir, {
        project_id: projectId,
        session_id: `publish-guard-eval-${name}-${index + 1}`,
        task_ref: null,
        turn_ref: `publish-guard-eval-turn-${name}-${index + 1}`,
        parent_event_id: null,
        actor: { kind: 'user', id: 'user:publish-guard-eval', role: null },
        runtime: 'codex',
        source: 'codex_cli',
        source_assurance: 'explicit',
        scope: { level: 'session', id: `publish-guard-eval-${name}-${index + 1}` },
        event_type: 'user.prompt',
        signal_strength: 'explicit',
        fact_status: 'fact',
        status: 'observed',
        final_disposition: 'unknown',
        details: { fixture: 'skill-publish-guard-evaluation' },
        input_value: input,
        output_value: null,
        evidence_refs: [],
        occurred_at: new Date(Date.UTC(2026, 7, 19, 23, 0, index + 1)).toISOString(),
        source_event_id: `publish-guard-eval-prompt-${name}-${index + 1}`,
      });
      addCase(name, {
        id: `case-${String(index + 1).padStart(3, '0')}`,
        input,
        source_event_ref: prompt.event.event_id,
      }, { baseDir, cwd: projectCwd, projectId });
    }
    cases = readCases(name, { baseDir });
  }
  const passedCount = Math.round(passRate * cases.length);
  const results = cases.map((item, index) => ({
    case_id: item.id,
    passed: index < passedCount,
  }));
  return stageEvaluationArtifactAuthority(
    name,
    candidateId,
    results,
    { baseDir, cwd: projectCwd, projectId }
  ).authority;
}

function recordVersion(name, version, passRate, baseDir, overrides = {}) {
  const input = {
    skillHash: digest(`${name}-skill-${version}`),
    candidateHash: digest(`${name}-candidate-${version}`),
    target: {
      key: `skill:${name}`,
      source_path: `codex-native/skills/${name}/SKILL.md`,
      source_hash: version === 1
        ? digest(`${name}-source-0`)
        : digest(`${name}-skill-${version - 1}`),
    },
    baselineHash: version === 1 ? null : digest(`${name}-skill-${version - 1}`),
    caseSetHash: digest(`${name}-cases-v1`),
    evaluatorRef: 'evaluator:test-rubric-v1',
    evaluatorHash: digest(`${name}-evaluator-v1`),
    candidateId: `lc-${digest(`${name}-candidate-id-${version}`).slice(7, 39)}`,
    evaluationId: `eval-${digest(`${name}-evaluation-id-${version}`).slice(7, 39)}`,
    evaluationHash: digest(`${name}-evaluation-${version}`),
    approvalReceiptId: `approval-${digest(`${name}-approval-id-${version}`).slice(7, 39)}`,
    approvalReceiptHash: digest(`${name}-approval-${version}`),
    cases: {
      case_results_hash: digest(`${name}-case-results-${version}`),
      case_count: 100,
      passed_count: Math.round(passRate * 100),
    },
    ...overrides,
  };
  const record = {
    schema_version: EVAL_RESULTS_SCHEMA_VERSION,
    timestamp: `2026-08-20T0${version}:06:00.000Z`,
    name,
    version,
    pass_rate: passRate,
    skill_hash: input.skillHash,
    candidate_id: input.candidateId,
    candidate_hash: input.candidateHash,
    target: input.target,
    scope: input.scope || { level: 'project', id: projectId },
    baseline_hash: input.baselineHash,
    case_set_hash: input.caseSetHash,
    evaluator_ref: input.evaluatorRef,
    evaluator_hash: input.evaluatorHash,
    evaluation_id: input.evaluationId,
    evaluation_hash: input.evaluationHash,
    approval_receipt_id: input.approvalReceiptId,
    approval_receipt_hash: input.approvalReceiptHash,
    cases: input.cases,
    source: 'test-fixture',
  };
  record.result_hash = resultHash(record);
  const resultsFile = resolveResultsFile(name, baseDir);
  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
  fs.appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
  return { record, resultsFile };
}

const projectCwd = path.resolve(__dirname, '..');
const projectId = detectStableProjectIdentity(projectCwd).id;
function runGuardCli(args, baseDir, cwd = projectCwd) {
  return runCli(args, {
    cwd,
    env: { TECH_PERSISTENCE_HOME: baseDir },
  });
}
const proposer = { kind: 'agent', id: 'agent:proposer', authority_ref: 'local:proposer' };
const evaluator = { kind: 'agent', id: 'agent:evaluator', authority_ref: 'local:evaluator' };
const publisher = { kind: 'user', id: 'user:publisher', authority_ref: 'local:user' };

function seedEvidence(storeDir, episodeId) {
  const sessionId = `session-${episodeId}`;
  const taskRef = `task-${episodeId}`;
  const common = {
    project_id: projectId,
    session_id: sessionId,
    task_ref: taskRef,
    turn_ref: null,
    parent_event_id: null,
    runtime: 'codex',
    source: 'codex_cli',
    scope: { level: 'task', id: taskRef },
    fact_status: 'fact',
    input_value: null,
    output_value: null,
    evidence_refs: [],
  };
  appendBehaviorEvent(storeDir, {
    ...common,
    actor: { kind: 'user', id: 'user:test', role: 'requester' },
    source_assurance: 'explicit',
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    status: 'observed',
    final_disposition: 'unknown',
    details: { summary: 'publish guard fixture goal' },
    occurred_at: '2026-08-20T01:00:00.000Z',
    source_event_id: `${episodeId}-prompt`,
  });
  appendBehaviorEvent(storeDir, {
    ...common,
    actor: { kind: 'agent', id: 'agent:test', role: 'worker' },
    source_assurance: 'observed',
    event_type: 'tool.request',
    signal_strength: 'inferred',
    status: 'observed',
    final_disposition: 'unknown',
    details: { tool: 'test' },
    occurred_at: '2026-08-20T01:00:10.000Z',
    source_event_id: `${episodeId}-request`,
  });
  appendBehaviorEvent(storeDir, {
    ...common,
    actor: { kind: 'user', id: 'user:test', role: 'requester' },
    source_assurance: 'explicit',
    event_type: 'user.feedback',
    signal_strength: 'explicit',
    status: 'observed',
    final_disposition: 'accepted',
    details: { feedback: 'retain the verified publish behavior' },
    input_value: 'retain the verified publish behavior',
    occurred_at: '2026-08-20T01:00:15.000Z',
    source_event_id: `${episodeId}-feedback`,
  });
  appendBehaviorEvent(storeDir, {
    ...common,
    actor: { kind: 'agent', id: 'agent:test', role: 'worker' },
    source_assurance: 'verified',
    event_type: 'task.result',
    signal_strength: 'explicit',
    status: 'succeeded',
    final_disposition: 'accepted',
    details: { verification_status: 'verified' },
    evidence_refs: [`verified:test:${episodeId}`],
    occurred_at: '2026-08-20T01:00:20.000Z',
    source_event_id: `${episodeId}-result`,
  });
  const episode = closeBehaviorEpisode(storeDir, {
    project_id: projectId,
    session_id: sessionId,
    task_ref: taskRef,
    created_at: '2026-08-20T01:00:30.000Z',
    actor: { kind: 'system', id: 'episode-builder', runtime: 'test', authority_ref: null },
  });
  const evidence = normalizeEvidenceRef({
    schema_version: 'self-learning-evidence-ref-v1',
    source_type: 'behavior_episode',
    source_ref: episode.episode.episode_id,
    immutable_ref: `journal:${episodeId}`,
    digest: episode.record.payload_hash,
    uri: null,
    final_disposition: 'accepted',
    captured_at: '2026-08-20T01:00:00.000Z',
    scope: { level: 'project', id: projectId },
    redaction_status: 'passed',
    assurance: 'verified',
    signal_strength: 'explicit',
    fact_status: 'fact',
  });
  appendEvidenceRef(storeDir, evidence, {
    actor: { kind: 'system', id: 'evidence-builder', role: null },
    occurred_at: evidence.captured_at,
  });
  return evidence;
}

function seedPromotedCandidate(
  baseDir,
  name,
  version,
  baselineHash,
  caseSetHash,
  targetKey,
  passRate = 0.9,
  options = {}
) {
  const storeDir = resolveStoreDir(baseDir, projectId);
  const approvalAuthority = `approval-${name}-${version}`;
  const candidatePublisher = { ...publisher, authority_ref: approvalAuthority };
  const evidence = [
    seedEvidence(storeDir, `${name}-v${version}-episode-a`),
    seedEvidence(storeDir, `${name}-v${version}-episode-b`),
  ];
  const candidateTargetKey = targetKey || `skill:${name}`;
  const sourceContent = version === 1
    ? `# ${name} source v0\n`
    : `# ${name} v${version - 1}\r\n\r\ncanonical candidate artifact\r\n`;
  const target = writeTargetSource(baseDir, candidateTargetKey, sourceContent);
  if (baselineHash !== null && target.source_hash !== baselineHash) {
    throw new Error(`fixture baseline/source mismatch: ${target.source_hash} != ${baselineHash}`);
  }
  const proposed = proposeCandidate(storeDir, {
    project_id: projectId,
    kind: 'workflow',
    statement: { text: `${name} v${version} publish candidate`, fact_status: 'inference' },
    target,
    scope: options.scope || { level: 'project', id: projectId },
    proposer,
    evidence_refs: evidence,
    counterexamples: [],
    occurred_at: `2026-08-20T0${version}:01:00.000Z`,
    ...(options.expiresAt === undefined ? {} : { expires_at: options.expiresAt }),
  }).candidate;
  const artifactText = `# ${name} v${version}\r\n\r\ncanonical candidate artifact\r\n`;
  const artifactFile = resolveCandidateArtifactFile(name, proposed.candidate_id, baseDir);
  fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
  fs.writeFileSync(artifactFile, artifactText, 'utf8');
  const subjectArtifactHash = artifactContentHash(artifactText);
  const caseAuthority = evaluationAuthority(baseDir, name, proposed.candidate_id, passRate);
  const evaluated = evaluateCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: proposed.candidate_hash,
    rubric_version: 'tv-v1',
    truth_score: 0.9,
    value_score: 0.9,
    assessor: evaluator,
    evidence_ref_ids: evidence.map((item) => item.evidence_id),
    baseline_hash: baselineHash,
    subject_artifact_hash: subjectArtifactHash,
    evaluation_artifact_authority: caseAuthority,
    counterexamples_reviewed: true,
    assessed_at: `2026-08-20T0${version}:02:00.000Z`,
  }).candidate;
  const shadow = transitionCandidate(storeDir, proposed.candidate_id, 'shadow', {
    expected_candidate_hash: evaluated.candidate_hash,
    actor: evaluator,
    occurred_at: `2026-08-20T0${version}:03:00.000Z`,
  }).candidate;
  const event = appendBehaviorEvent(storeDir, {
    project_id: projectId,
    session_id: `session-${name}-${version}`,
    task_ref: `task-${name}-${version}`,
    turn_ref: null,
    parent_event_id: null,
    actor: { kind: 'user', id: publisher.id, role: 'publisher' },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'task', id: `task-${name}-${version}` },
    event_type: 'user.approval',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'accepted',
    details: { action: 'approve', candidate_id: shadow.candidate_id, candidate_hash: shadow.candidate_hash },
    input_value: null,
    output_value: null,
    evidence_refs: [],
    occurred_at: `2026-08-20T0${version}:04:00.000Z`,
    source_event_id: approvalAuthority,
  });
  const approved = approveCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: shadow.candidate_hash,
    approval_event: { ...event.event, event_hash: event.record.payload_hash },
    publisher: candidatePublisher,
    approved_at: `2026-08-20T0${version}:05:00.000Z`,
  });
  const promoted = promoteCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: approved.candidate.candidate_hash,
    approval_receipt: approved.receipt,
    publisher: candidatePublisher,
    promoted_at: `2026-08-20T0${version}:06:00.000Z`,
  }).candidate;
  return {
    artifactFile,
    subjectArtifactHash,
    candidate: promoted,
    receipt: approved.receipt,
    publisher: candidatePublisher,
    storeDir,
  };
}

function recordPromotedVersion(name, version, passRate, baseDir, overrides = {}) {
  const expectedArtifactHash = artifactContentHash(
    `# ${name} v${version}\r\n\r\ncanonical candidate artifact\r\n`
  );
  const skillHash = overrides.skillHash || expectedArtifactHash;
  const baselineHash = version === 1
    ? null
    : artifactContentHash(`# ${name} v${version - 1}\r\n\r\ncanonical candidate artifact\r\n`);
  const caseSetHash = digest(`${name}-cases-v1`);
  const seeded = seedPromotedCandidate(
    baseDir,
    name,
    version,
    baselineHash,
    caseSetHash,
    overrides.targetKey,
    passRate
  );
  const result = recordVersion(
    name,
    version,
    seeded.candidate.evaluation.pass_rate,
    baseDir,
    {
      skillHash,
      baselineHash,
      caseSetHash: seeded.candidate.evaluation.case_set_hash,
      evaluatorRef: evaluator.authority_ref,
      evaluatorHash: seeded.candidate.evaluation.evaluator_hash,
      candidateId: seeded.candidate.candidate_id,
      candidateHash: seeded.candidate.candidate_hash,
      target: seeded.candidate.target,
      evaluationId: seeded.candidate.evaluation.evaluation_id,
      evaluationHash: seeded.candidate.evaluation.evaluation_hash,
      approvalReceiptId: seeded.receipt.receipt_id,
      approvalReceiptHash: seeded.receipt.receipt_hash,
      cases: {
        case_results_hash: seeded.candidate.evaluation.case_results_hash,
        case_count: seeded.candidate.evaluation.case_count,
        passed_count: seeded.candidate.evaluation.passed_count,
      },
      ...overrides,
    }
  );
  return { ...result, artifactFile: seeded.artifactFile, seeded };
}

function recordDerivedPromotedVersion(name, version, passRate, baseDir) {
  const baselineHash = version === 1
    ? null
    : artifactContentHash(`# ${name} v${version - 1}\r\n\r\ncanonical candidate artifact\r\n`);
  const seeded = seedPromotedCandidate(
    baseDir,
    name,
    version,
    baselineHash,
    digest(`${name}-cases-v1`),
    undefined,
    passRate
  );
  const result = recordAuthoritativeResult(name, seeded.candidate.candidate_id, {
    baseDir,
    projectId,
    version,
  });
  return { ...result, artifactFile: seeded.artifactFile, seeded };
}

function completeRecordArgs(name, version, candidateId, artifactFile) {
  return [
    'record', '--name', name, '--version', String(version),
    '--candidate-id', candidateId,
    ...(artifactFile ? ['--artifact-path', artifactFile] : []),
  ];
}

test('guard exit 2 (no-baseline) when no results exist', () => {
  const baseDir = makeBaseDir();
  const r = runGuardCli(['guard', 'prototype'], baseDir);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes('BLOCKED'));
  assert.ok(r.stderr.includes('no-baseline'));
});

test('guard exit 2 (no-baseline) when only one result exists', () => {
  const baseDir = makeBaseDir();
  recordVersion('prototype', 1, 0.8, baseDir);
  const r = runGuardCli(['guard', 'prototype'], baseDir);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes('no-baseline'));
});

test('publish guard requires a readable authoritative self-learning journal', () => {
  const baseDir = makeBaseDir();
  recordVersion('sprint', 1, 0.7, baseDir);
  recordVersion('sprint', 2, 0.9, baseDir);
  const result = checkPublishGuard('sprint', { baseDir, projectId, repoRoot: baseDir });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'candidate-missing');
});

test('publish guard passes only when current journal state is promoted and fully bound', () => {
  const baseDir = makeBaseDir();
  const baseline = recordDerivedPromotedVersion('sprint', 1, 0.67, baseDir);
  const current = recordDerivedPromotedVersion('sprint', 2, 0.93, baseDir);
  assert.strictEqual(current.record.target.key, baseline.record.target.key);
  assert.strictEqual(current.record.target.source_path, baseline.record.target.source_path);
  assert.notStrictEqual(
    current.record.target.source_hash,
    baseline.record.target.source_hash,
    'source_hash is the per-proposal baseline, not cross-version identity'
  );
  assert.strictEqual(current.record.target.source_hash, baseline.record.skill_hash);
  assert.strictEqual(current.record.target.source_hash, current.record.baseline_hash);
  const result = checkPublishGuard('sprint', { baseDir, projectId, repoRoot: baseDir });
  assert.strictEqual(result.status, 'ok', result.reason);
  assert.strictEqual(result.publish_authorized, true);
  assert.strictEqual(result.reason_code, 'authoritative-promoted-non-regression');
});

test('authoritative result recording rejects non-project candidate scope', () => {
  const baseDir = makeBaseDir();
  const seeded = seedPromotedCandidate(
    baseDir,
    'sprint',
    1,
    null,
    digest('sprint-cases-v1'),
    undefined,
    0.8,
    { scope: { level: 'task', id: 'task-sprint-only' } }
  );
  assert.throws(
    () => recordAuthoritativeResult('sprint', seeded.candidate.candidate_id, {
      baseDir,
      projectId,
      version: 1,
      clock: () => '2026-08-20T01:06:30.000Z',
    }),
    /project scope|scope.*project/i
  );
});

test('authoritative result recording uses operation time and blocks explicit expiry', () => {
  const freshBase = makeBaseDir();
  const fresh = seedPromotedCandidate(
    freshBase, 'sprint', 1, null, digest('sprint-cases-v1'), undefined, 0.8
  );
  const operationTime = '2026-08-20T01:30:00.000Z';
  const recorded = recordAuthoritativeResult('sprint', fresh.candidate.candidate_id, {
    baseDir: freshBase,
    projectId,
    version: 1,
    clock: () => operationTime,
  });
  assert.strictEqual(recorded.record.timestamp, operationTime);

  const expiredBase = makeBaseDir();
  const expired = seedPromotedCandidate(
    expiredBase,
    'sprint',
    1,
    null,
    digest('sprint-cases-v1'),
    undefined,
    0.8,
    { expiresAt: '2026-08-20T01:07:00.000Z' }
  );
  assert.throws(
    () => recordAuthoritativeResult('sprint', expired.candidate.candidate_id, {
      baseDir: expiredBase,
      projectId,
      version: 1,
      clock: () => '2026-08-20T01:07:00.000Z',
    }),
    /expired|expiry/i
  );
});

test('authoritative result recording and publish guard block configured default expiry', () => {
  const recordBase = makeBaseDir();
  fs.writeFileSync(
    path.join(recordBase, 'config.json'),
    `${JSON.stringify({ self_learning: { retention_days: 1 } })}\n`,
    'utf8'
  );
  const expired = seedPromotedCandidate(
    recordBase, 'review', 1, null, digest('review-cases-v1'), undefined, 0.8
  );
  assert.throws(
    () => recordAuthoritativeResult('review', expired.candidate.candidate_id, {
      baseDir: recordBase,
      projectId,
      version: 1,
      clock: () => '2026-08-21T01:06:00.000Z',
    }),
    /expired|expiry/i
  );

  const guardBase = makeBaseDir();
  fs.writeFileSync(
    path.join(guardBase, 'config.json'),
    `${JSON.stringify({ self_learning: { retention_days: 90 } })}\n`,
    'utf8'
  );
  recordDerivedPromotedVersion('review', 1, 0.7, guardBase);
  recordDerivedPromotedVersion('review', 2, 0.9, guardBase);
  const guard = checkPublishGuard('review', {
    baseDir: guardBase,
    projectId,
    repoRoot: guardBase,
    clock: () => '2026-11-19T00:00:00.000Z',
  });
  assert.strictEqual(guard.status, 'blocked');
  assert.strictEqual(guard.reason_code, 'candidate-expired');

  const explicitGuardBase = makeBaseDir();
  const baseline = seedPromotedCandidate(
    explicitGuardBase,
    'plan',
    1,
    null,
    digest('plan-cases-v1'),
    undefined,
    0.7,
    { expiresAt: '2026-08-20T03:00:00.000Z' }
  );
  const baselineRecord = recordAuthoritativeResult('plan', baseline.candidate.candidate_id, {
    baseDir: explicitGuardBase,
    projectId,
    version: 1,
    clock: () => '2026-08-20T01:30:00.000Z',
  });
  const current = seedPromotedCandidate(
    explicitGuardBase,
    'plan',
    2,
    baselineRecord.record.skill_hash,
    digest('plan-cases-v1'),
    undefined,
    0.9,
    { expiresAt: '2026-08-20T03:00:00.000Z' }
  );
  recordAuthoritativeResult('plan', current.candidate.candidate_id, {
    baseDir: explicitGuardBase,
    projectId,
    version: 2,
    clock: () => '2026-08-20T02:30:00.000Z',
  });
  const explicitGuard = checkPublishGuard('plan', {
    baseDir: explicitGuardBase,
    projectId,
    repoRoot: explicitGuardBase,
    clock: () => '2026-08-20T03:00:00.000Z',
  });
  assert.strictEqual(explicitGuard.status, 'blocked');
  assert.strictEqual(explicitGuard.reason_code, 'candidate-expired');
});

test('authoritative result writer refuses to append behind legacy history', () => {
  const baseDir = makeBaseDir();
  const seeded = seedPromotedCandidate(
    baseDir, 'sprint', 1, null, digest('sprint-cases-v1'), undefined, 0.8
  );
  const file = resolveResultsFile('sprint', baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schema_version: '1.0',
    timestamp: '2026-08-01T00:00:00.000Z',
    name: 'sprint',
    version: 1,
    pass_rate: 0.5,
    source: 'legacy',
  })}\n`);
  assert.throws(
    () => recordAuthoritativeResult('sprint', seeded.candidate.candidate_id, {
      baseDir, projectId, version: 2,
    }),
    /legacy v1\/v2/i
  );
});

test('authoritative result writer rejects target baseline drift before append', () => {
  const baseDir = makeBaseDir();
  recordDerivedPromotedVersion('sprint', 1, 0.8, baseDir);
  const drifted = seedPromotedCandidate(
    baseDir,
    'sprint',
    2,
    null,
    digest('sprint-cases-v1'),
    undefined,
    0.9
  );
  assert.throws(
    () => recordAuthoritativeResult('sprint', drifted.candidate.candidate_id, {
      baseDir, projectId, version: 2,
    }),
    /baseline_hash|target source_hash|previous skill_hash/i
  );
  assert.strictEqual(
    fs.readFileSync(resolveResultsFile('sprint', baseDir), 'utf8').trim().split('\n').length,
    1,
    'a non-comparable target baseline must not be appended'
  );
});

test('publish guard rejects pass_rate tampering even when attacker recomputes result_hash', () => {
  const baseDir = makeBaseDir();
  recordDerivedPromotedVersion('sprint', 1, 0.67, baseDir);
  recordDerivedPromotedVersion('sprint', 2, 0.93, baseDir);
  const resultsFile = resolveResultsFile('sprint', baseDir);
  const records = fs.readFileSync(resultsFile, 'utf8').trim().split('\n').map(JSON.parse);
  records[1].pass_rate = 1;
  records[1].cases.passed_count = records[1].cases.case_count;
  records[1].result_hash = resultHash(records[1]);
  fs.writeFileSync(resultsFile, `${records.map(JSON.stringify).join('\n')}\n`);
  const result = checkPublishGuard('sprint', { baseDir, projectId, repoRoot: baseDir });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'authority-mismatch');
  assert.match(result.reason, /pass_rate mismatch/i);
});

test('publish guard blocks fake hashes and stale candidate revisions', () => {
  const fakeBase = makeBaseDir();
  recordPromotedVersion('review', 1, 0.7, fakeBase);
  recordPromotedVersion('review', 2, 0.9, fakeBase, {
    evaluationHash: digest('forged-evaluation'),
  });
  let result = checkPublishGuard('review', { baseDir: fakeBase, projectId, repoRoot: fakeBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'authority-mismatch');

  const fakeApprovalBase = makeBaseDir();
  recordPromotedVersion('review', 1, 0.7, fakeApprovalBase);
  recordPromotedVersion('review', 2, 0.9, fakeApprovalBase, {
    approvalReceiptHash: digest('forged-approval-receipt'),
  });
  result = checkPublishGuard('review', { baseDir: fakeApprovalBase, projectId, repoRoot: fakeApprovalBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'authority-mismatch');

  const staleBase = makeBaseDir();
  recordPromotedVersion('review', 1, 0.7, staleBase);
  const current = recordPromotedVersion('review', 2, 0.9, staleBase);
  const candidateId = current.record.candidate_id;
  const storeDir = resolveStoreDir(staleBase, projectId);
  governCandidate(storeDir, candidateId, {
    action: 'needs-review',
    expected_candidate_hash: current.record.candidate_hash,
    actor: publisher,
    reason: 'new contradictory evidence',
    occurred_at: '2026-08-20T09:00:00.000Z',
  });
  result = checkPublishGuard('review', { baseDir: staleBase, projectId, repoRoot: staleBase });
  assert.strictEqual(result.status, 'blocked');
  assert.ok(['candidate-not-promoted', 'authority-mismatch'].includes(result.reason_code));
});

test('publish guard blocks tombstoned candidate or approval receipt', () => {
  const candidateBase = makeBaseDir();
  recordPromotedVersion('plan', 1, 0.7, candidateBase);
  const current = recordPromotedVersion('plan', 2, 0.9, candidateBase);
  governCandidate(resolveStoreDir(candidateBase, projectId), current.record.candidate_id, {
    action: 'tombstone',
    expected_candidate_hash: current.record.candidate_hash,
    actor: publisher,
    reason: 'withdrawn by publisher',
    occurred_at: '2026-08-20T09:10:00.000Z',
  });
  let result = checkPublishGuard('plan', { baseDir: candidateBase, projectId, repoRoot: candidateBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'candidate-tombstoned');

  const receiptBase = makeBaseDir();
  recordPromotedVersion('plan', 1, 0.7, receiptBase);
  const receiptCurrent = recordPromotedVersion('plan', 2, 0.9, receiptBase);
  const storeDir = resolveStoreDir(receiptBase, projectId);
  const receiptRecord = require('./lib/self-learning-store').projectJournal(storeDir).active
    .find((record) => record.entity_id === receiptCurrent.record.approval_receipt_id);
  require('./lib/self-learning-store').tombstoneEntity(storeDir, {
    record_id: `tombstone:${receiptCurrent.record.approval_receipt_id}:test`,
    target_id: receiptCurrent.record.approval_receipt_id,
    target_hash: receiptRecord.record_hash,
    actor: { kind: 'user', id: publisher.id, runtime: 'test', authority_ref: publisher.authority_ref },
    occurred_at: '2026-08-20T09:11:00.000Z',
    reason: 'approval revoked',
  });
  result = checkPublishGuard('plan', { baseDir: receiptBase, projectId, repoRoot: receiptBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'approval-tombstoned');
});

test('publish guard rejects skill-command and canonical-path target drift', () => {
  const baseDir = makeBaseDir();
  recordDerivedPromotedVersion('sprint', 1, 0.7, baseDir);
  recordDerivedPromotedVersion('sprint', 2, 0.9, baseDir);
  const resultsFile = resolveResultsFile('sprint', baseDir);
  const records = fs.readFileSync(resultsFile, 'utf8').trim().split('\n').map(JSON.parse);
  records[1].target = {
    ...records[1].target,
    key: 'command:sprint',
    source_path: 'user-level/commands/sprint.md',
  };
  records[1].result_hash = resultHash(records[1]);
  fs.writeFileSync(resultsFile, `${records.map(JSON.stringify).join('\n')}\n`);
  let result = checkPublishGuard('sprint', { baseDir, projectId, repoRoot: baseDir });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'identity-mismatch');
  assert.match(result.reason, /target key|source_path/i);

  records[1].target = {
    ...records[0].target,
    source_path: 'user-level/skills/sprint/SKILL.md',
  };
  records[1].result_hash = resultHash(records[1]);
  fs.writeFileSync(resultsFile, `${records.map(JSON.stringify).join('\n')}\n`);
  result = checkPublishGuard('sprint', { baseDir, projectId, repoRoot: baseDir });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'identity-mismatch');
  assert.match(result.reason, /source_path/i);

  const scopeBase = makeBaseDir();
  recordDerivedPromotedVersion('sprint', 1, 0.7, scopeBase);
  recordDerivedPromotedVersion('sprint', 2, 0.9, scopeBase);
  const scopeResultsFile = resolveResultsFile('sprint', scopeBase);
  const scopeRecords = fs.readFileSync(scopeResultsFile, 'utf8').trim().split('\n').map(JSON.parse);
  scopeRecords[1].scope = { level: 'project', id: 'project:other' };
  scopeRecords[1].result_hash = resultHash(scopeRecords[1]);
  fs.writeFileSync(scopeResultsFile, `${scopeRecords.map(JSON.stringify).join('\n')}\n`);
  result = checkPublishGuard('sprint', { baseDir: scopeBase, projectId, repoRoot: scopeBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'identity-mismatch');
  assert.match(result.reason, /project scope/i);
});

test('publish guard rejects same candidate/evaluation/receipt replay across versions', () => {
  const baseDir = makeBaseDir();
  const seeded = recordPromotedVersion('sprint', 1, 0.8, baseDir);
  recordVersion('sprint', 2, 0.9, baseDir, {
    skillHash: seeded.record.skill_hash,
    candidateId: seeded.record.candidate_id,
    candidateHash: seeded.record.candidate_hash,
    baselineHash: seeded.record.skill_hash,
    caseSetHash: seeded.record.case_set_hash,
    evaluatorRef: seeded.record.evaluator_ref,
    evaluatorHash: seeded.record.evaluator_hash,
    evaluationId: seeded.record.evaluation_id,
    evaluationHash: seeded.record.evaluation_hash,
    approvalReceiptId: seeded.record.approval_receipt_id,
    approvalReceiptHash: seeded.record.approval_receipt_hash,
  });
  const result = checkPublishGuard('sprint', { baseDir, projectId, repoRoot: baseDir });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'identity-mismatch');
  assert.match(result.reason, /candidate_id must differ/);
});

test('publish guard independently rejects evaluation and receipt identity replay', () => {
  for (const identity of ['evaluationId', 'approvalReceiptId']) {
    const baseDir = makeBaseDir();
    const baseline = recordVersion('sprint', 1, 0.8, baseDir);
    recordVersion('sprint', 2, 0.9, baseDir, {
      [identity]: identity === 'evaluationId'
        ? baseline.record.evaluation_id
        : baseline.record.approval_receipt_id,
    });
    const result = checkPublishGuard('sprint', { baseDir, projectId, repoRoot: baseDir });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.reason_code, 'identity-mismatch');
    assert.match(
      result.reason,
      identity === 'evaluationId' ? /evaluation_id must differ/ : /approval_receipt_id must differ/
    );
  }
});

test('publish guard rejects arbitrary skill hash and actual artifact drift', () => {
  const forgedBase = makeBaseDir();
  recordPromotedVersion('review', 1, 0.7, forgedBase);
  recordPromotedVersion('review', 2, 0.9, forgedBase, {
    skillHash: digest('caller-selected-skill-hash'),
  });
  let result = checkPublishGuard('review', { baseDir: forgedBase, projectId, repoRoot: forgedBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'authority-mismatch');
  assert.match(result.reason, /subject_artifact_hash/);

  const driftBase = makeBaseDir();
  recordPromotedVersion('review', 1, 0.7, driftBase);
  const current = recordPromotedVersion('review', 2, 0.9, driftBase);
  fs.writeFileSync(current.artifactFile, '# drifted after evaluation\n', 'utf8');
  result = checkPublishGuard('review', { baseDir: driftBase, projectId, repoRoot: driftBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'artifact-drift');

  const baselineDriftBase = makeBaseDir();
  const baseline = recordPromotedVersion('review', 1, 0.7, baselineDriftBase);
  recordPromotedVersion('review', 2, 0.9, baselineDriftBase);
  fs.writeFileSync(baseline.artifactFile, '# forged historical baseline\n', 'utf8');
  result = checkPublishGuard('review', { baseDir: baselineDriftBase, projectId, repoRoot: baselineDriftBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'artifact-drift');
  assert.strictEqual(result.authoritative_record, 'baseline');
});

test('publish guard hashes the real target source and rejects source/hash drift', () => {
  const sourceDriftBase = makeBaseDir();
  recordDerivedPromotedVersion('review', 1, 0.7, sourceDriftBase);
  recordDerivedPromotedVersion('review', 2, 0.9, sourceDriftBase);
  const sourceFile = path.join(
    sourceDriftBase,
    ...targetSourcePath('skill:review').split('/')
  );
  fs.writeFileSync(sourceFile, '# source changed after evaluation\n', 'utf8');
  let result = checkPublishGuard('review', {
    baseDir: sourceDriftBase,
    projectId,
    repoRoot: sourceDriftBase,
  });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'source-drift');
  assert.match(result.reason, /previous promoted artifact|target\.source_hash|baseline_hash/i);

  const hashDriftBase = makeBaseDir();
  recordDerivedPromotedVersion('review', 1, 0.7, hashDriftBase);
  recordDerivedPromotedVersion('review', 2, 0.9, hashDriftBase);
  const resultsFile = resolveResultsFile('review', hashDriftBase);
  const records = fs.readFileSync(resultsFile, 'utf8').trim().split('\n').map(JSON.parse);
  records[1].target.source_hash = digest('forged-source-hash');
  records[1].result_hash = resultHash(records[1]);
  fs.writeFileSync(resultsFile, `${records.map(JSON.stringify).join('\n')}\n`);
  result = checkPublishGuard('review', {
    baseDir: hashDriftBase,
    projectId,
    repoRoot: hashDriftBase,
  });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'identity-mismatch');
  assert.match(result.reason, /target source_hash/i);
});

test('publish guard rejects externally hardlinked candidate and source artifacts', () => {
  const candidateBase = makeBaseDir();
  recordDerivedPromotedVersion('review', 1, 0.7, candidateBase);
  const current = recordDerivedPromotedVersion('review', 2, 0.9, candidateBase);
  fs.linkSync(current.artifactFile, path.join(candidateBase, 'external-candidate.md'));
  let result = checkPublishGuard('review', {
    baseDir: candidateBase,
    projectId,
    repoRoot: candidateBase,
  });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'artifact-invalid');
  assert.match(result.reason, /nlink|hardlink|link count/i);

  const sourceBase = makeBaseDir();
  recordDerivedPromotedVersion('review', 1, 0.7, sourceBase);
  recordDerivedPromotedVersion('review', 2, 0.9, sourceBase);
  const sourceFile = path.join(sourceBase, ...targetSourcePath('skill:review').split('/'));
  fs.linkSync(sourceFile, path.join(sourceBase, 'external-source.md'));
  result = checkPublishGuard('review', {
    baseDir: sourceBase,
    projectId,
    repoRoot: sourceBase,
  });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'source-invalid');
  assert.match(result.reason, /nlink|hardlink|link count/i);
});

test('publish guard rejects non-file, invalid UTF-8, oversized, and linked artifacts', () => {
  const directoryBase = makeBaseDir();
  recordPromotedVersion('review', 1, 0.7, directoryBase);
  let current = recordPromotedVersion('review', 2, 0.9, directoryBase);
  fs.unlinkSync(current.artifactFile);
  fs.mkdirSync(current.artifactFile);
  let result = checkPublishGuard('review', { baseDir: directoryBase, projectId, repoRoot: directoryBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'artifact-invalid');
  assert.match(result.reason, /plain regular file/);

  const encodingBase = makeBaseDir();
  recordPromotedVersion('review', 1, 0.7, encodingBase);
  current = recordPromotedVersion('review', 2, 0.9, encodingBase);
  fs.writeFileSync(current.artifactFile, Buffer.from([0xc3, 0x28]));
  result = checkPublishGuard('review', { baseDir: encodingBase, projectId, repoRoot: encodingBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'artifact-invalid');
  assert.match(result.reason, /UTF-8/);

  const oversizedBase = makeBaseDir();
  recordPromotedVersion('review', 1, 0.7, oversizedBase);
  current = recordPromotedVersion('review', 2, 0.9, oversizedBase);
  fs.writeFileSync(current.artifactFile, Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x61));
  result = checkPublishGuard('review', { baseDir: oversizedBase, projectId, repoRoot: oversizedBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'artifact-invalid');
  assert.match(result.reason, /exceeds/);

  const linkedBase = makeBaseDir();
  recordPromotedVersion('review', 1, 0.7, linkedBase);
  current = recordPromotedVersion('review', 2, 0.9, linkedBase);
  const candidateDir = path.dirname(current.artifactFile);
  const realCandidateDir = `${candidateDir}-real`;
  fs.renameSync(candidateDir, realCandidateDir);
  fs.symlinkSync(realCandidateDir, candidateDir, process.platform === 'win32' ? 'junction' : 'dir');
  result = checkPublishGuard('review', { baseDir: linkedBase, projectId, repoRoot: linkedBase });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'artifact-invalid');
  assert.match(result.reason, /symbolic link or junction/);
});

test('guard exit 0 (ok) when new version not worse', () => {
  const baseDir = makeTrustedRepoBaseDir();
  recordPromotedVersion('sprint', 1, 0.67, baseDir);
  recordPromotedVersion('sprint', 2, 0.93, baseDir);
  const r = runGuardCli(['guard', 'sprint'], baseDir, baseDir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('PASS'));
});

test('guard exit 2 (regression) when new version drops', () => {
  const baseDir = makeBaseDir();
  recordVersion('review', 1, 0.9, baseDir);
  recordVersion('review', 2, 0.6, baseDir);
  const r = runGuardCli(['guard', 'review'], baseDir);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(r.stderr.includes('BLOCKED'));
  assert.ok(r.stderr.includes('pass-rate-regression'));
});

test('guard exit 0 when tolerance absorbs flaky drop', () => {
  const baseDir = makeTrustedRepoBaseDir();
  recordPromotedVersion('plan', 1, 0.9, baseDir);
  recordPromotedVersion('plan', 2, 0.88, baseDir);
  assert.strictEqual(runGuardCli(['guard', 'plan'], baseDir, baseDir).status, 2);
  assert.strictEqual(runGuardCli(['guard', 'plan', '--tolerance', '0.05'], baseDir, baseDir).status, 0);
});

test('guard fail-closed exit 2 when results path is unreadable', () => {
  const baseDir = makeBaseDir();
  // 让 results.jsonl 路径变成目录 → readFileSync 抛 EISDIR → 必须 fail closed
  const resultsFile = resolveResultsFile('work', baseDir);
  fs.mkdirSync(resultsFile, { recursive: true });
  const r = runGuardCli(['guard', 'work'], baseDir);
  assert.strictEqual(r.status, 2, `expected fail-closed exit 2, got ${r.status}`);
  assert.ok(r.stderr.includes('[skill-guard] ERROR:'), r.stderr);
});

test('guard fail-closed exit 2 on malformed tail', () => {
  const baseDir = makeBaseDir();
  const { resultsFile } = recordVersion('work', 1, 0.8, baseDir);
  fs.appendFileSync(resultsFile, '{"truncated":');
  const r = runGuardCli(['guard', 'work'], baseDir);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes('[skill-guard] ERROR:'), r.stderr);
  assert.ok(r.stderr.includes('malformed line'), r.stderr);
});

test('guard exit 2 (usage) on missing name', () => {
  assert.strictEqual(runCli(['guard']).status, 2);
});

test('guard exit 2 (usage) on invalid name (path escape)', () => {
  const baseDir = makeBaseDir();
  assert.strictEqual(runGuardCli(['guard', '../escape'], baseDir).status, 2);
});

test('guard rejects caller-controlled authority overrides', () => {
  const baseDir = makeBaseDir();
  const override = runGuardCli(['guard', 'sprint', '--base-dir', baseDir], baseDir);
  assert.strictEqual(override.status, 2);
  assert.match(override.stderr, /unknown flag.*base-dir/i);
  const projectOverride = runGuardCli(['guard', 'sprint', '--project-id', 'attacker'], baseDir);
  assert.strictEqual(projectOverride.status, 2);
  assert.match(projectOverride.stderr, /unknown flag.*project-id/i);
  const clockOverride = runGuardCli(
    ['guard', 'sprint', '--now', '2099-01-01T00:00:00.000Z'],
    baseDir
  );
  assert.strictEqual(clockOverride.status, 2);
  assert.match(clockOverride.stderr, /unknown flag.*now/i);
});

test('unknown subcommand exits 2', () => {
  assert.strictEqual(runCli(['bogus']).status, 2);
});

test('record subcommand writes result and exits 0', () => {
  const baseDir = makeBaseDir();
  const seeded = seedPromotedCandidate(
    baseDir, 'evolve', 1, null, digest('evolve-cases-v1'), undefined, 0.8
  );
  const r = runCli(
    completeRecordArgs('evolve', 1, seeded.candidate.candidate_id, seeded.artifactFile),
    { cwd: projectCwd, env: { TECH_PERSISTENCE_HOME: baseDir } }
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(resolveResultsFile('evolve', baseDir)));
});

test('record exits 2 on missing candidate authority and rejects non-canonical artifact path', () => {
  const baseDir = makeBaseDir();
  const seeded = seedPromotedCandidate(
    baseDir, 'evolve', 1, null, digest('evolve-cases-v1'), undefined, 0.8
  );
  const args = completeRecordArgs('evolve', 1, seeded.candidate.candidate_id);
  const flagIndex = args.indexOf('--candidate-id');
  args.splice(flagIndex, 2);
  const r = runCli(args, { cwd: projectCwd, env: { TECH_PERSISTENCE_HOME: baseDir } });
  assert.strictEqual(r.status, 2);
  assert.ok(r.stderr.includes('--candidate-id'));

  const wrongPath = runCli(
    completeRecordArgs('evolve', 1, seeded.candidate.candidate_id, path.join(baseDir, 'forged.md')),
    { cwd: projectCwd, env: { TECH_PERSISTENCE_HOME: baseDir } }
  );
  assert.strictEqual(wrongPath.status, 2);
  assert.match(wrongPath.stderr, /exact canonical/i);

  const clockOverride = runCli(
    [
      ...completeRecordArgs('evolve', 1, seeded.candidate.candidate_id, seeded.artifactFile),
      '--now', '2099-01-01T00:00:00.000Z',
    ],
    { cwd: projectCwd, env: { TECH_PERSISTENCE_HOME: baseDir } }
  );
  assert.strictEqual(clockOverride.status, 2);
  assert.match(clockOverride.stderr, /unknown flag.*now/i);
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, err }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${err.stack || err.message}`);
  });
  process.exit(1);
}
