#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  CODEX_BEHAVIOR_EVENTS,
  CODEX_HOOK_MAX_TIMEOUT_SECONDS,
  CODEX_HOOK_TIMEOUT_UNIT,
  CODEX_HOOKS,
  buildCodexPluginHookConfig,
} = require('./lib/codex-hook-registry');
const {
  CODEX_CONTROL_PREFIX,
  MAX_CONTROL_INPUT_BYTES,
  MAX_HOOK_INPUT_BYTES,
  captureCodexBehavior,
  parseCodexControlEnvelope,
} = require('./codex-behavior-hook');
const {
  appendBehaviorEvent,
  deriveBehaviorEventIdentity,
  normalizeEvidenceRef,
} = require('./lib/behavior-events');
const { closeBehaviorEpisode } = require('./lib/behavior-episodes');
const {
  approveCandidate,
  evaluateCandidate,
  proposeCandidate,
  transitionCandidate,
} = require('./lib/learning-candidates');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { addCase } = require('./lib/skill-eval-cases');
const { stageEvaluationArtifactAuthority } = require('./lib/self-learning-evaluation-artifacts');
const {
  appendRecord,
  readJournal,
  resolveStoreDir,
} = require('./lib/self-learning-store');
const { stableHash } = require('./lib/self-learning-canonical');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${error.stack || error.message}`);
  }
}

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-codex-behavior-hook-'));
  const workspace = path.join(root, 'plain-workspace');
  const baseDir = path.join(root, 'homunculus');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
    self_learning: {
      enabled: true,
      writer_enabled: true,
      reader_enabled: false,
      mode: 'shadow',
      legacy_writer_enabled: false,
      legacy_reader_enabled: false,
    },
  }));
  const project = detectStableProjectIdentity(workspace);
  const env = {
    TP_SELF_LEARNING_PROJECT_ID: project.id,
    TP_SELF_LEARNING_TASK_REF: 'task-codex-hook',
    CODEX_SESSION_ID: 'thr-codex-hook',
    TECH_PERSISTENCE_RUNTIME: 'codex',
  };
  try {
    fn({ root, workspace, baseDir, project, env });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function payload(event, workspace, overrides = {}) {
  return {
    session_id: 'thr-codex-hook',
    transcript_path: null,
    cwd: workspace,
    hook_event_name: event,
    model: 'gpt-5.6-sol',
    permission_mode: 'default',
    turn_id: 'turn-codex-hook',
    ...overrides,
  };
}

function journalFor(baseDir, projectId) {
  return readJournal(resolveStoreDir(baseDir, projectId));
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function seedCandidateEvidence(storeDir, projectId, suffix, minute) {
  const sessionId = `session-control-${suffix}`;
  const taskRef = `task-control-${suffix}`;
  const common = {
    project_id: projectId,
    session_id: sessionId,
    task_ref: taskRef,
    parent_event_id: null,
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'task', id: taskRef },
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: {},
    output_value: null,
    evidence_refs: [],
  };
  const append = (index, overrides = {}) => appendBehaviorEvent(storeDir, {
    ...common,
    source_event_id: `seed-control-${suffix}-${index}`,
    turn_ref: `turn-control-${suffix}-${index}`,
    actor: { kind: 'user', id: 'user', role: null },
    event_type: 'user.prompt',
    input_value: `seed ${suffix} ${index}`,
    occurred_at: `2026-08-21T01:${minute}:0${index}.000Z`,
    ...overrides,
  });
  append(0);
  append(1, {
    actor: { kind: 'agent', id: 'agent:seed', role: null },
    event_type: 'tool.request',
    signal_strength: 'inferred',
  });
  append(2, {
    actor: { kind: 'agent', id: 'agent:seed', role: null },
    source: 'agent_loop',
    source_assurance: 'verified',
    signal_strength: 'explicit',
    event_type: 'task.result',
    status: 'succeeded',
    final_disposition: 'accepted',
    evidence_refs: [`evidence:${'c'.repeat(64)}`],
  });
  append(3, {
    event_type: 'user.feedback',
    final_disposition: 'accepted',
  });
  const episode = closeBehaviorEpisode(storeDir, {
    project_id: projectId,
    session_id: sessionId,
    task_ref: taskRef,
    created_at: `2026-08-21T01:${minute}:04.000Z`,
    actor: {
      kind: 'system', id: 'episode-builder', runtime: 'codex', authority_ref: 'local:episode-builder',
    },
  });
  const evidence = normalizeEvidenceRef({
    schema_version: 'self-learning-evidence-ref-v1',
    source_type: 'behavior_episode',
    source_ref: episode.episode.episode_id,
    immutable_ref: `journal:${episode.episode.episode_id}`,
    digest: episode.record.payload_hash,
    uri: null,
    final_disposition: 'accepted',
    captured_at: `2026-08-21T01:${minute}:00.000Z`,
    scope: { level: 'project', id: projectId },
    redaction_status: 'passed',
    assurance: 'verified',
    signal_strength: 'explicit',
    fact_status: 'fact',
  });
  appendRecord(storeDir, {
    record_type: 'evidence_ref',
    record_id: evidence.evidence_id,
    entity_id: evidence.evidence_id,
    actor: { kind: 'system', id: 'evidence-builder', runtime: 'unknown', authority_ref: null },
    occurred_at: evidence.captured_at,
    payload: evidence,
  });
  return evidence;
}

function seedShadowCandidate(baseDir, projectId, cwd) {
  const storeDir = resolveStoreDir(baseDir, projectId);
  const evidence = [
    seedCandidateEvidence(storeDir, projectId, 'a', '10'),
    seedCandidateEvidence(storeDir, projectId, 'b', '11'),
  ];
  const proposed = proposeCandidate(storeDir, {
    project_id: projectId,
    kind: 'workflow',
    statement: { text: 'Use the native control envelope for explicit feedback.', fact_status: 'inference' },
    target: {
      key: 'workflow.codex-control',
      source_path: 'docs/codex-control.md',
      source_hash: digest('codex-control-target'),
    },
    scope: { level: 'project', id: projectId },
    proposer: { kind: 'agent', id: 'agent:learner', authority_ref: 'local:agent' },
    evidence_refs: evidence,
    counterexamples: [],
    occurred_at: '2026-08-21T01:12:00.000Z',
  }).candidate;
  const evaluationName = `eval-${proposed.candidate_id.slice(3, 15)}`;
  const results = [1, 2].map((index) => {
    const input = `control case ${index}`;
    const prompt = appendBehaviorEvent(storeDir, {
      project_id: projectId,
      session_id: `codex-control-eval-session-${index}`,
      task_ref: null,
      turn_ref: `codex-control-eval-turn-${index}`,
      parent_event_id: null,
      actor: { kind: 'user', id: 'user:codex-control-eval', role: null },
      runtime: 'codex',
      source: 'codex_cli',
      source_assurance: 'explicit',
      scope: { level: 'session', id: `codex-control-eval-session-${index}` },
      event_type: 'user.prompt',
      signal_strength: 'explicit',
      fact_status: 'fact',
      status: 'observed',
      final_disposition: 'unknown',
      details: { fixture: 'codex-control-evaluation-authority' },
      input_value: input,
      output_value: null,
      evidence_refs: [],
      occurred_at: `2026-08-21T01:12:0${index}.000Z`,
      source_event_id: `codex-control-eval-prompt-${index}`,
    });
    addCase(evaluationName, {
      id: `case-${index}`,
      input,
      source_event_ref: prompt.event.event_id,
    }, { baseDir, cwd, projectId });
    return { case_id: `case-${index}`, passed: true };
  });
  const evaluated = evaluateCandidate(storeDir, proposed.candidate_id, {
    expected_candidate_hash: proposed.candidate_hash,
    rubric_version: 'tv-v1',
    truth_score: 0.9,
    value_score: 0.9,
    evaluation_artifact_authority: stageEvaluationArtifactAuthority(
      evaluationName,
      proposed.candidate_id,
      results,
      { baseDir, cwd, projectId }
    ).authority,
    assessor: { kind: 'agent', id: 'agent:evaluator', authority_ref: 'local:evaluator' },
    evidence_ref_ids: proposed.evidence_refs.map((ref) => ref.evidence_id),
    counterexamples_reviewed: true,
    assessed_at: '2026-08-21T01:13:00.000Z',
  }).candidate;
  return transitionCandidate(storeDir, proposed.candidate_id, 'shadow', {
    expected_candidate_hash: evaluated.candidate_hash,
    actor: { kind: 'agent', id: 'agent:evaluator', authority_ref: 'local:evaluator' },
    occurred_at: '2026-08-21T01:14:00.000Z',
  }).candidate;
}

test('Codex behavior hooks are registered from the current release contract with second-based bounds', () => {
  assert.strictEqual(CODEX_HOOK_TIMEOUT_UNIT, 'seconds');
  assert(Number.isInteger(CODEX_HOOK_MAX_TIMEOUT_SECONDS));
  assert(CODEX_HOOK_MAX_TIMEOUT_SECONDS >= 1 && CODEX_HOOK_MAX_TIMEOUT_SECONDS <= 10);
  assert.deepStrictEqual(
    [...CODEX_BEHAVIOR_EVENTS],
    ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']
  );
  const behaviorHooks = CODEX_HOOKS.filter((hook) => hook.script === 'codex-behavior-hook.js');
  assert.deepStrictEqual(behaviorHooks.map((hook) => hook.event), [...CODEX_BEHAVIOR_EVENTS]);
  assert(behaviorHooks.every((hook) => hook.async === false));
  assert(behaviorHooks.every((hook) => Number.isInteger(hook.timeout)));
  assert(behaviorHooks.every((hook) => hook.timeout >= 1
    && hook.timeout <= CODEX_HOOK_MAX_TIMEOUT_SECONDS));
  assert(CODEX_HOOKS.every((hook) => Number.isInteger(hook.timeout)
    && hook.timeout >= 1
    && hook.timeout <= CODEX_HOOK_MAX_TIMEOUT_SECONDS));
  assert(!JSON.stringify(buildCodexPluginHookConfig()).includes('3000'));
  assert(!JSON.stringify(buildCodexPluginHookConfig()).includes('1000'));
});

test('canonical docs describe current Codex hooks and the exact native control boundary', () => {
  const root = path.resolve(__dirname, '..');
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  const readme = read('README.md');
  const pluginReadme = read('plugins/tech-persistence/README.md');
  const plan = read('docs/plans/2026-08-20-user-behavior-self-learning-p0.md');
  const skill = read('codex-native/skills/continuous-learning/SKILL.md');
  const combined = [readme, pluginReadme, plan, skill].join('\n');
  assert.match(readme, /Codex native governed hooks/);
  assert.match(combined, /TP_SELF_LEARNING_CONTROL_V1:/);
  assert.match(combined, /canonical JSON/);
  assert.match(combined, /current candidate hash|当前 candidate hash/);
  assert.match(combined, /session_id/);
  assert.match(combined, /UserPromptSubmit/);
  assert.match(combined, /same-turn|同 turn/);
  assert.match(combined, /same journal transaction|共用 journal transaction/);
  assert.doesNotMatch(combined, /control semantic digest|semantic digest/);
  assert.match(combined, /integer seconds|整数秒/);
  assert.doesNotMatch(readme, /Codex 不注册 UserPromptSubmit、PostToolUse 或 Stop hook/);
  assert.doesNotMatch(plan, /Codex 缺少 PostToolUse\/Stop hook 是已验证平台边界/);
  assert.doesNotMatch(plan, /不声称存在 PostToolUse\/Stop 自动 Hook/);
  assert.doesNotMatch(plan, /不存在的 Hook 保持负向断言/);
});

test('official prompt turn receipt is stable, redacted, and conflicts on semantic replay', () => {
  withFixture(({ workspace, baseDir, project, env }) => {
    const rawSecret = `github_token=ghp_${'A'.repeat(36)}`;
    const official = payload('UserPromptSubmit', workspace, {
      prompt: `Run the focused tests; ${rawSecret}`,
      // These are not current Codex fields and must not control identity or time.
      prompt_id: 'invented-claude-id',
      timestamp: '1999-01-01T00:00:00.000Z',
      task_ref: 'forged-payload-task',
    });
    const first = captureCodexBehavior(official, {
      baseDir,
      cwd: workspace,
      env,
      occurredAt: '2026-08-21T01:00:00.000Z',
    });
    const replay = captureCodexBehavior(official, {
      baseDir,
      cwd: workspace,
      env,
      occurredAt: '2026-08-21T02:00:00.000Z',
    });
    const conflict = captureCodexBehavior({ ...official, prompt: 'Different prompt, same turn.' }, {
      baseDir,
      cwd: workspace,
      env,
      occurredAt: '2026-08-21T03:00:00.000Z',
    });
    const classificationConflict = captureCodexBehavior({
      ...official,
      prompt: `${CODEX_CONTROL_PREFIX}{"accepted":false,"action":"feedback","summary":"Use the focused test."}`,
    }, {
      baseDir,
      cwd: workspace,
      env,
      occurredAt: '2026-08-21T04:00:00.000Z',
    });

    assert.strictEqual(first.status, 'recorded');
    assert.strictEqual(replay.status, 'duplicate');
    assert.deepStrictEqual(conflict, { status: 'error', reason: 'identity-conflict' });
    assert.deepStrictEqual(classificationConflict, { status: 'error', reason: 'identity-conflict' });
    const journal = journalFor(baseDir, project.id);
    assert.strictEqual(journal.records.length, 1);
    const event = journal.records[0].payload;
    assert.strictEqual(event.runtime, 'codex');
    assert.strictEqual(event.source, 'codex_cli');
    assert.match(event.source_event_id, /^codex-prompt:[a-f0-9]{64}$/);
    assert.strictEqual(event.turn_ref, 'turn-codex-hook');
    assert.strictEqual(event.task_ref, 'task-codex-hook');
    assert.strictEqual(event.scope.level, 'task');
    assert.strictEqual(event.event_type, 'user.prompt');
    assert.strictEqual(event.source_assurance, 'explicit');
    assert.strictEqual(event.occurred_at, '2026-08-21T01:00:00.000Z');
    assert.notStrictEqual(event.occurred_at, official.timestamp);
    assert(!JSON.stringify(journal).includes(rawSecret));
    assert.strictEqual(journal.records[0].actor.authority_ref, event.source_event_id);
  });
});

test('native prompt control envelope is canonical, bounded, and never inferred from ordinary text', () => {
  const candidateId = `lc-${'a'.repeat(32)}`;
  const candidateHash = `sha256:${'b'.repeat(64)}`;
  const approvalJson = JSON.stringify({
    accepted: true,
    action: 'approve',
    candidate_hash: candidateHash,
    candidate_id: candidateId,
  });
  assert.strictEqual(Buffer.byteLength(CODEX_CONTROL_PREFIX, 'utf8') > 0, true);
  assert(MAX_CONTROL_INPUT_BYTES >= 256 && MAX_CONTROL_INPUT_BYTES <= 4096);
  assert.deepStrictEqual(
    parseCodexControlEnvelope(`${CODEX_CONTROL_PREFIX}${approvalJson}`),
    {
      status: 'control',
      event_type: 'user.approval',
      final_disposition: 'accepted',
      details: {
        accepted: true,
        action: 'approve',
        candidate_hash: candidateHash,
        candidate_id: candidateId,
      },
      semantic: {
        accepted: true,
        action: 'approve',
        candidate_hash: candidateHash,
        candidate_id: candidateId,
      },
    }
  );
  const remember = { action: 'remember', body: '只持久化这一句' };
  assert.deepStrictEqual(
    parseCodexControlEnvelope(`${CODEX_CONTROL_PREFIX}${JSON.stringify(remember)}`),
    {
      status: 'control',
      event_type: 'user.prompt',
      final_disposition: 'accepted',
      details: remember,
      semantic: remember,
    }
  );
  assert.deepStrictEqual(
    parseCodexControlEnvelope(`${CODEX_CONTROL_PREFIX}${JSON.stringify({
      action: 'remember', body: 'two\nlines',
    })}`),
    { status: 'invalid', reason: 'control-shape-invalid' }
  );
  assert.deepStrictEqual(
    parseCodexControlEnvelope(`${CODEX_CONTROL_PREFIX}{"action":"remember","body":"只持久化这一句","extra":true}`),
    { status: 'invalid', reason: 'control-shape-invalid' }
  );
  assert.deepStrictEqual(parseCodexControlEnvelope('Please approve this candidate.'), {
    status: 'ordinary',
  });
  assert.deepStrictEqual(
    parseCodexControlEnvelope(`${CODEX_CONTROL_PREFIX}{"action":"approve"}`),
    { status: 'invalid', reason: 'control-shape-invalid' }
  );
  assert.deepStrictEqual(
    parseCodexControlEnvelope(`${CODEX_CONTROL_PREFIX} ${approvalJson}`),
    { status: 'invalid', reason: 'control-json-noncanonical' }
  );
  assert.deepStrictEqual(
    parseCodexControlEnvelope(`${CODEX_CONTROL_PREFIX}${approvalJson}\n`),
    { status: 'invalid', reason: 'control-json-noncanonical' }
  );
  assert.deepStrictEqual(
    parseCodexControlEnvelope(`${CODEX_CONTROL_PREFIX}{"accepted":true,"action":"approve","candidate_hash":"${candidateHash}","candidate_id":"${candidateId}","candidate_id":"${candidateId}"}`),
    { status: 'invalid', reason: 'control-json-noncanonical' }
  );
  assert.deepStrictEqual(
    parseCodexControlEnvelope(`${CODEX_CONTROL_PREFIX}${'x'.repeat(MAX_CONTROL_INPUT_BYTES)}`),
    { status: 'invalid', reason: 'control-envelope-too-large' }
  );
});

test('UserPromptSubmit remember control binds the exact semantic body into the trusted receipt', () => {
  withFixture(({ workspace, baseDir, project, env }) => {
    const semantic = { action: 'remember', body: '只持久化这一句' };
    const result = captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-remember',
      prompt: `${CODEX_CONTROL_PREFIX}${JSON.stringify(semantic)}`,
    }), {
      baseDir,
      cwd: workspace,
      env,
      occurredAt: '2026-08-21T01:19:00.000Z',
    });
    assert.strictEqual(result.status, 'recorded');
    const event = journalFor(baseDir, project.id).records[0].payload;
    assert.strictEqual(event.event_type, 'user.prompt');
    assert.strictEqual(event.final_disposition, 'accepted');
    assert.deepStrictEqual(event.details, semantic);
    assert.strictEqual(event.input_digest, stableHash(semantic));
  });
});

test('UserPromptSubmit records trusted controls with one immutable receipt per native turn', () => {
  withFixture(({ workspace, baseDir, project, env }) => {
    const feedback = `${CODEX_CONTROL_PREFIX}{"accepted":false,"action":"feedback","summary":"Prefer the focused test."}`;
    const correction = `${CODEX_CONTROL_PREFIX}{"action":"correct","summary":"Run the validator before reporting completion."}`;
    const feedbackResult = captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-feedback', prompt: feedback,
    }), { baseDir, cwd: workspace, env, occurredAt: '2026-08-21T01:20:00.000Z' });
    const correctionResult = captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-correction', prompt: correction,
    }), { baseDir, cwd: workspace, env, occurredAt: '2026-08-21T01:21:00.000Z' });
    const feedbackReplay = captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-feedback', prompt: feedback,
    }), { baseDir, cwd: workspace, env, occurredAt: '2026-08-21T02:20:00.000Z' });
    const summaryConflict = captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-feedback',
      prompt: `${CODEX_CONTROL_PREFIX}{"accepted":false,"action":"feedback","summary":"Changed summary."}`,
    }), { baseDir, cwd: workspace, env, occurredAt: '2026-08-21T03:20:00.000Z' });
    const actionConflict = captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-feedback', prompt: correction,
    }), { baseDir, cwd: workspace, env, occurredAt: '2026-08-21T04:20:00.000Z' });
    assert.strictEqual(feedbackResult.status, 'recorded');
    assert.strictEqual(correctionResult.status, 'recorded');
    assert.strictEqual(feedbackReplay.status, 'duplicate');
    assert.deepStrictEqual(summaryConflict, { status: 'error', reason: 'identity-conflict' });
    assert.deepStrictEqual(actionConflict, { status: 'error', reason: 'identity-conflict' });
    const events = journalFor(baseDir, project.id).records.map((record) => record.payload);
    const feedbackEvent = events.find((event) => event.event_type === 'user.feedback');
    const correctionEvent = events.find((event) => event.event_type === 'user.correction');
    assert(feedbackEvent && correctionEvent);
    assert.strictEqual(feedbackEvent.final_disposition, 'rejected');
    assert.strictEqual(correctionEvent.final_disposition, 'unknown');
    for (const event of [feedbackEvent, correctionEvent]) {
      assert.strictEqual(event.source_assurance, 'explicit');
      assert.strictEqual(event.signal_strength, 'explicit');
      assert.strictEqual(event.fact_status, 'fact');
      assert.match(event.source_event_id, /^codex-prompt:[a-f0-9]{64}$/);
      assert.notStrictEqual(event.source_event_id, event.turn_ref);
      const record = journalFor(baseDir, project.id).records.find(
        (item) => item.payload.event_id === event.event_id
      );
      assert.strictEqual(record.actor.authority_ref, event.source_event_id);
    }
    assert.notStrictEqual(feedbackEvent.source_event_id, correctionEvent.source_event_id);
    assert.strictEqual(events.filter((event) => event.turn_ref === 'turn-feedback').length, 1);
  });
});

test('approval control is accepted only for the live shadow candidate and binds id/hash', () => {
  withFixture(({ workspace, baseDir, project, env }) => {
    const shadow = seedShadowCandidate(baseDir, project.id, workspace);
    const approvalPrompt = `${CODEX_CONTROL_PREFIX}${JSON.stringify({
      accepted: true,
      action: 'approve',
      candidate_hash: shadow.candidate_hash,
      candidate_id: shadow.candidate_id,
    })}`;
    const accepted = captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-approval', prompt: approvalPrompt,
    }), { baseDir, cwd: workspace, env, occurredAt: '2026-08-21T01:22:00.000Z' });
    assert.strictEqual(accepted.status, 'recorded');
    const journal = journalFor(baseDir, project.id);
    const approvalRecord = journal.records.find((record) => record.record_type === 'behavior_event'
      && record.payload.event_type === 'user.approval');
    assert(approvalRecord);
    assert.deepStrictEqual(approvalRecord.payload.details, {
      accepted: true,
      action: 'approve',
      candidate_hash: shadow.candidate_hash,
      candidate_id: shadow.candidate_id,
    });
    assert.strictEqual(approvalRecord.payload.final_disposition, 'accepted');
    assert.match(approvalRecord.payload.source_event_id, /^codex-prompt:[a-f0-9]{64}$/);
    assert.strictEqual(approvalRecord.actor.authority_ref, approvalRecord.payload.source_event_id);

    const changedApproval = `${CODEX_CONTROL_PREFIX}${JSON.stringify({
      accepted: true,
      action: 'approve',
      candidate_hash: digest('changed-approval-hash'),
      candidate_id: shadow.candidate_id,
    })}`;
    assert.deepStrictEqual(captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-approval', prompt: changedApproval,
    }), { baseDir, cwd: workspace, env }), {
      status: 'error', reason: 'identity-conflict',
    });

    const wrongHashPrompt = `${CODEX_CONTROL_PREFIX}${JSON.stringify({
      accepted: true,
      action: 'approve',
      candidate_hash: digest('wrong-current-hash'),
      candidate_id: shadow.candidate_id,
    })}`;
    assert.deepStrictEqual(captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-wrong-hash', prompt: wrongHashPrompt,
    }), { baseDir, cwd: workspace, env }), {
      status: 'skipped', reason: 'control-authority-invalid',
    });

    const approved = approveCandidate(resolveStoreDir(baseDir, project.id), shadow.candidate_id, {
      expected_candidate_hash: shadow.candidate_hash,
      approval_event: { event_id: approvalRecord.payload.event_id },
      publisher: {
        kind: 'user', id: 'user', authority_ref: approvalRecord.actor.authority_ref,
      },
      approved_at: '2026-08-21T01:22:00.000Z',
    }).candidate;
    const nonShadowPrompt = `${CODEX_CONTROL_PREFIX}${JSON.stringify({
      accepted: true,
      action: 'approve',
      candidate_hash: approved.candidate_hash,
      candidate_id: approved.candidate_id,
    })}`;
    assert.deepStrictEqual(captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-not-shadow', prompt: nonShadowPrompt,
    }), { baseDir, cwd: workspace, env }), {
      status: 'skipped', reason: 'control-authority-invalid',
    });
    assert.strictEqual(
      journalFor(baseDir, project.id).records.filter((record) =>
        record.record_type === 'behavior_event' && record.payload.event_type === 'user.approval').length,
      1
    );
  });
});

test('approval live-shadow validation and receipt append share one transaction boundary', () => {
  withFixture(({ workspace, baseDir, project, env }) => {
    const storeDir = resolveStoreDir(baseDir, project.id);
    const shadow = seedShadowCandidate(baseDir, project.id, workspace);
    const approvalPrompt = `${CODEX_CONTROL_PREFIX}${JSON.stringify({
      accepted: true,
      action: 'approve',
      candidate_hash: shadow.candidate_hash,
      candidate_id: shadow.candidate_id,
    })}`;
    let seamCalls = 0;
    const result = captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: 'turn-approval-race', prompt: approvalPrompt,
    }), {
      baseDir,
      cwd: workspace,
      env,
      beforeReceiptAppend() {
        seamCalls += 1;
        transitionCandidate(storeDir, shadow.candidate_id, 'needs-review', {
          expected_candidate_hash: shadow.candidate_hash,
          actor: { kind: 'agent', id: 'agent:race-reviewer', authority_ref: 'local:race-reviewer' },
          occurred_at: '2026-08-21T01:22:30.000Z',
          reason: 'deterministic transition race fixture',
        });
      },
    });

    assert.strictEqual(seamCalls, 1);
    assert.deepStrictEqual(result, { status: 'skipped', reason: 'control-authority-invalid' });
    assert.strictEqual(journalFor(baseDir, project.id).records.filter((record) => (
      record.record_type === 'behavior_event'
      && record.payload.event_type === 'user.approval'
    )).length, 0);
  });
});

test('PreToolUse and PostToolUse share native tool lineage and keep undocumented outcomes unknown', () => {
  withFixture(({ workspace, baseDir, project, env }) => {
    const pre = payload('PreToolUse', workspace, {
      turn_id: 'turn-tool',
      tool_name: 'Bash',
      tool_use_id: 'tool-call-1',
      tool_input: { command: 'exit 9' },
    });
    const post = payload('PostToolUse', workspace, {
      turn_id: 'turn-tool',
      tool_name: 'Bash',
      tool_use_id: 'tool-call-1',
      tool_input: { command: 'exit 9' },
      tool_response: { exit_code: 9, output: 'failed' },
    });
    assert.strictEqual(captureCodexBehavior(pre, {
      baseDir, cwd: workspace, env, occurredAt: '2026-08-21T01:01:00.000Z',
    }).status, 'recorded');
    assert.strictEqual(captureCodexBehavior(post, {
      baseDir, cwd: workspace, env, occurredAt: '2026-08-21T01:01:01.000Z',
    }).status, 'recorded');

    const events = journalFor(baseDir, project.id).records
      .filter((record) => record.record_type === 'behavior_event')
      .map((record) => record.payload);
    const request = events.find((event) => event.event_type === 'tool.request');
    const result = events.find((event) => event.event_type === 'tool.result');
    assert(request && result);
    assert.strictEqual(request.source_event_id, 'tool-call-1');
    assert.strictEqual(result.source_event_id, 'tool-call-1');
    assert.strictEqual(result.parent_event_id, request.event_id);
    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.final_disposition, 'unknown');
    assert.strictEqual(result.fact_status, 'fact');
  });
});

test('Stop records lifecycle only and closes an episode only under managed task authority', () => {
  withFixture(({ workspace, baseDir, project, env }) => {
    const promptResult = captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      prompt: 'Inspect and test the current change.',
    }), { baseDir, cwd: workspace, env, occurredAt: '2026-08-21T01:02:00.000Z' });
    assert.strictEqual(promptResult.status, 'recorded');
    const stopPayload = payload('Stop', workspace, {
      last_assistant_message: 'All checks passed.',
      stop_hook_active: false,
    });
    const stopped = captureCodexBehavior(stopPayload, {
      baseDir, cwd: workspace, env, occurredAt: '2026-08-21T01:02:05.000Z',
    });
    const replay = captureCodexBehavior(stopPayload, {
      baseDir, cwd: workspace, env, occurredAt: '2026-08-21T01:03:00.000Z',
    });
    assert.strictEqual(stopped.status, 'recorded');
    assert.strictEqual(stopped.episode.status, 'needs_review');
    assert.strictEqual(replay.status, 'duplicate');
    assert.strictEqual(replay.episode.status, 'duplicate');

    const journal = journalFor(baseDir, project.id);
    const stopEvent = journal.records.find((record) => record.record_type === 'behavior_event'
      && record.payload.event_type === 'system.lifecycle').payload;
    assert.strictEqual(stopEvent.status, 'unknown');
    assert.strictEqual(stopEvent.final_disposition, 'unknown');
    assert.notStrictEqual(stopEvent.event_type, 'task.result');
    assert.strictEqual(
      journal.records.filter((record) => record.record_type === 'behavior_episode').length,
      1
    );
  });

  withFixture(({ workspace, baseDir, project, env }) => {
    const unassignedEnv = { ...env };
    delete unassignedEnv.TP_SELF_LEARNING_TASK_REF;
    const result = captureCodexBehavior(payload('Stop', workspace, {
      stop_hook_active: false,
      last_assistant_message: '',
    }), {
      baseDir, cwd: workspace, env: unassignedEnv, occurredAt: '2026-08-21T01:04:00.000Z',
    });
    assert.strictEqual(result.status, 'recorded');
    assert.deepStrictEqual(result.episode, { status: 'skipped', reason: 'session-unassigned' });
    const journal = journalFor(baseDir, project.id);
    assert.strictEqual(journal.records[0].payload.task_ref, null);
    assert.strictEqual(journal.records[0].payload.scope.level, 'session');
    assert.strictEqual(journal.records.some((record) => record.record_type === 'behavior_episode'), false);
  });
});

test('managed project and session mismatches fail open without writing', () => {
  withFixture(({ root, workspace, baseDir, project, env }) => {
    const other = path.join(root, 'other-workspace');
    fs.mkdirSync(other);
    const projectMismatch = captureCodexBehavior(payload('UserPromptSubmit', other, {
      prompt: 'Wrong project.',
    }), { baseDir, cwd: workspace, env });
    assert.deepStrictEqual(projectMismatch, { status: 'error', reason: 'project-identity-mismatch' });
    const sessionMismatch = captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      session_id: 'different-session',
      prompt: 'Wrong session.',
    }), { baseDir, cwd: workspace, env });
    assert.deepStrictEqual(sessionMismatch, { status: 'error', reason: 'session-identity-mismatch' });
    assert.strictEqual(journalFor(baseDir, project.id).records.length, 0);
  });
});

test('missing release fields and oversized stdin fail open without invented identities', () => {
  withFixture(({ workspace, baseDir, project, env }) => {
    assert.deepStrictEqual(captureCodexBehavior(payload('UserPromptSubmit', workspace, {
      turn_id: undefined,
      prompt_id: 'claude-only-id',
      prompt: 'No current Codex turn id.',
    }), { baseDir, cwd: workspace, env }), {
      status: 'skipped', reason: 'missing-turn-id',
    });
    assert.deepStrictEqual(captureCodexBehavior(payload('PreToolUse', workspace, {
      tool_name: 'Bash', tool_input: { command: 'echo x' },
    }), { baseDir, cwd: workspace, env }), {
      status: 'skipped', reason: 'missing-tool-use-id',
    });
    assert.deepStrictEqual(captureCodexBehavior(payload('Stop', workspace), {
      baseDir, cwd: workspace, env,
    }), {
      status: 'skipped', reason: 'missing-stop-hook-active',
    });
    assert.deepStrictEqual(captureCodexBehavior(payload('Stop', workspace, {
      stop_hook_active: false,
    }), { baseDir, cwd: workspace, env }), {
      status: 'skipped', reason: 'missing-last-assistant-message',
    });
    assert.strictEqual(journalFor(baseDir, project.id).records.length, 0);

    const script = path.join(__dirname, 'codex-behavior-hook.js');
    const oversized = spawnSync(process.execPath, [script], {
      cwd: workspace,
      input: 'x'.repeat(MAX_HOOK_INPUT_BYTES + 1),
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...env, TP_SELF_LEARNING_BASE_DIR: baseDir },
    });
    assert.strictEqual(oversized.status, 0, oversized.stderr);
    assert.strictEqual(oversized.stdout, '');
    assert(!oversized.stderr.includes(workspace));
    assert.strictEqual(journalFor(baseDir, project.id).records.length, 0);

    const secret = `ghp_${'Z'.repeat(36)}`;
    const malformedControl = spawnSync(process.execPath, [script], {
      cwd: workspace,
      input: JSON.stringify(payload('UserPromptSubmit', workspace, {
        turn_id: 'turn-malformed-control',
        prompt: `${CODEX_CONTROL_PREFIX}{"action":"feedback","summary":"${secret}`,
      })),
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...env, TP_SELF_LEARNING_BASE_DIR: baseDir },
    });
    assert.strictEqual(malformedControl.status, 0, malformedControl.stderr);
    assert.strictEqual(
      malformedControl.stderr.trim(),
      '[codex-behavior-hook] control-json-invalid'
    );
    assert(!malformedControl.stderr.includes(secret));
    assert(!malformedControl.stderr.includes('summary'));
    assert.strictEqual(journalFor(baseDir, project.id).records.length, 0);
  });
});

test('real child process captures from a non-repository cwd and installed config fixture rejects millisecond timeouts', () => {
  withFixture(({ root, workspace, baseDir, project, env }) => {
    const script = path.join(__dirname, 'codex-behavior-hook.js');
    const child = spawnSync(process.execPath, [script], {
      cwd: workspace,
      input: JSON.stringify(payload('PostToolUse', workspace, {
        turn_id: 'turn-child',
        tool_name: 'apply_patch',
        tool_use_id: 'tool-child',
        tool_input: { command: '*** Begin Patch' },
        tool_response: 'Done!',
      })),
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...env, TP_SELF_LEARNING_BASE_DIR: baseDir },
    });
    assert.strictEqual(child.status, 0, child.error && child.error.message || child.stderr);
    assert.strictEqual(child.stdout, '');
    const expected = deriveBehaviorEventIdentity({
      project_id: project.id,
      runtime: 'codex',
      source: 'codex_cli',
      source_event_id: 'tool-child',
      event_type: 'tool.result',
    });
    assert(journalFor(baseDir, project.id).records.some(
      (record) => record.record_id === expected.event_id
    ));

    const validator = path.join(__dirname, 'validate-codex-plugin.js');
    const validFixture = path.join(root, 'valid-hooks.json');
    const invalidFixture = path.join(root, 'invalid-hooks.json');
    const generated = buildCodexPluginHookConfig();
    fs.writeFileSync(validFixture, `${JSON.stringify(generated, null, 2)}\n`);
    const invalid = JSON.parse(JSON.stringify(generated));
    invalid.hooks.UserPromptSubmit[0].hooks[0].timeout = 5000;
    fs.writeFileSync(invalidFixture, `${JSON.stringify(invalid, null, 2)}\n`);
    const validResult = spawnSync(process.execPath, [
      validator, '--validate-codex-hooks-only', validFixture,
    ], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(validResult.status, 0, validResult.stderr);
    const invalidResult = spawnSync(process.execPath, [
      validator, '--validate-codex-hooks-only', invalidFixture,
    ], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(invalidResult.status, 1);
    assert.match(invalidResult.stderr, /seconds|timeout/i);
  });
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
