#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { callTool, listToolsForMcp } = require('./lib/memory-tools');
const { collectMemoryEntries } = require('./lib/memory-v5');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { resolveStoreDir, tombstoneEntity } = require('./lib/self-learning-store');
const { artifactContentHash } = require('./lib/skill-eval-results');
const { stableHash } = require('./lib/self-learning-canonical');
const { adaptClaudeHookEvent, appendBehaviorEvent } = require('./lib/behavior-events');
const { resolveBaseDir } = require('./lib/runtime-paths');
const { executeLearningAction } = require('./lib/self-learning-service');
const { addCase } = require('./lib/skill-eval-cases');
const { stageEvaluationArtifactAuthority } = require('./lib/self-learning-evaluation-artifacts');
const { CODEX_CONTROL_PREFIX } = require('./codex-behavior-hook');

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

function baseDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-learning-mcp-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    `${JSON.stringify({ self_learning: { retention_days: 36500 } })}\n`,
    'utf8'
  );
  return home;
}

function resultJson(result) {
  assert.ok(!result.isError, result.content && result.content[0] && result.content[0].text);
  return JSON.parse(result.content[0].text);
}

function withAuthority({ home = baseDir(), cwd = baseDir() } = {}, fn) {
  fs.mkdirSync(cwd, { recursive: true });
  const previousHome = process.env.TECH_PERSISTENCE_HOME;
  const previousCwd = process.cwd();
  process.env.TECH_PERSISTENCE_HOME = home;
  process.chdir(cwd);
  try {
    return fn({ home, cwd, projectId: detectStableProjectIdentity(cwd).id });
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.TECH_PERSISTENCE_HOME;
    else process.env.TECH_PERSISTENCE_HOME = previousHome;
  }
}

function feedbackEvent(body, suffix = '1') {
  return {
    session_id: `session-mcp-${suffix}`,
    task_ref: `task-mcp-${suffix}`,
    turn_ref: null,
    parent_event_id: null,
    actor: { kind: 'user', id: 'user:mcp', role: 'requester' },
    runtime: 'codex',
    source: 'codex_mcp',
    source_assurance: 'explicit',
    scope: { level: 'task', id: `task-mcp-${suffix}` },
    event_type: 'user.feedback',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'accepted',
    details: { feedback: body },
    input_value: body,
    output_value: null,
    evidence_refs: [],
    occurred_at: `2026-08-20T03:00:0${suffix}.000Z`,
    source_event_id: `mcp-feedback-${suffix}`,
  };
}

function memoryControl(body) {
  return `${CODEX_CONTROL_PREFIX}${JSON.stringify({ action: 'remember', body })}`;
}

function appendNativeMemoryControl(body, suffix = '1') {
  const projectId = detectStableProjectIdentity(process.cwd()).id;
  return appendBehaviorEvent(resolveStoreDir(resolveBaseDir(), projectId), {
    ...feedbackEvent(body, suffix),
    project_id: projectId,
    runtime: 'codex',
    source: 'codex_cli',
    event_type: 'user.prompt',
    final_disposition: 'accepted',
    details: { action: 'remember', body },
    input_value: { action: 'remember', body },
    source_event_id: `native-memory-confirmation-${suffix}`,
  });
}

function mcpEpisode(version, index) {
  const suffix = `${version}-${index}`;
  const sessionId = `session-mcp-publish-${suffix}`;
  const taskRef = `task-mcp-publish-${suffix}`;
  const projectId = detectStableProjectIdentity(process.cwd()).id;
  const storeDir = resolveStoreDir(resolveBaseDir(), projectId);
  const common = {
    session_id: sessionId,
    task_ref: taskRef,
    turn_ref: null,
    parent_event_id: null,
    runtime: 'codex',
    source: 'codex_mcp',
    scope: { level: 'task', id: taskRef },
    fact_status: 'fact',
    input_value: null,
    output_value: null,
    evidence_refs: [],
  };
  appendBehaviorEvent(storeDir, {
    ...common,
    project_id: projectId,
    actor: { kind: 'user', id: 'user:mcp-publisher', role: 'requester' },
    source: 'codex_cli',
    source_assurance: 'explicit',
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    status: 'observed',
    final_disposition: 'unknown',
    details: { summary: `evaluate publish candidate ${suffix}` },
    occurred_at: `2026-08-20T${String(version + 1).padStart(2, '0')}:0${index}:00.000Z`,
    source_event_id: `native-publish-prompt-${suffix}`,
  });
  const mcpObservation = resultJson(callTool('tp_learning_record', {
    kind: 'event',
    input: {
      ...common,
      actor: { kind: 'agent', id: 'agent:mcp-worker', role: 'worker' },
      source_assurance: 'observed',
      event_type: 'tool.request',
      signal_strength: 'inferred',
      status: 'observed',
      final_disposition: 'unknown',
      details: { tool: 'mcp-publish-test' },
      occurred_at: `2026-08-20T${String(version + 1).padStart(2, '0')}:0${index}:05.000Z`,
      source_event_id: `mcp-publish-tool-${suffix}`,
    },
  })).result.event;
  appendBehaviorEvent(storeDir, {
    ...common,
    project_id: projectId,
    actor: { kind: 'user', id: 'user:mcp-publisher', role: 'requester' },
    source: 'codex_cli',
    source_assurance: 'explicit',
    event_type: 'user.feedback',
    signal_strength: 'explicit',
    status: 'observed',
    final_disposition: 'accepted',
    details: { feedback: `verified preference ${suffix}` },
    input_value: `verified preference ${suffix}`,
    occurred_at: `2026-08-20T${String(version + 1).padStart(2, '0')}:0${index}:08.000Z`,
    source_event_id: `native-feedback-${suffix}`,
  });
  appendBehaviorEvent(storeDir, {
    ...common,
    project_id: projectId,
    actor: { kind: 'agent', id: 'agent:mcp-worker', role: 'worker' },
    source: 'agent_loop',
    source_assurance: 'verified',
    event_type: 'task.result',
    signal_strength: 'explicit',
    status: 'succeeded',
    final_disposition: 'accepted',
    details: { verification_status: 'verified' },
    evidence_refs: [`verified:test:${suffix}`],
    occurred_at: `2026-08-20T${String(version + 1).padStart(2, '0')}:0${index}:10.000Z`,
    source_event_id: `managed-publish-result-${suffix}`,
  });
  const closed = resultJson(callTool('tp_learning_close', {
    input: {
      session_id: sessionId,
      task_ref: taskRef,
      created_at: new Date(Math.max(
        Date.now(),
        Date.parse(mcpObservation.occurred_at)
      ) + 1).toISOString(),
      actor: { kind: 'system', id: 'episode-builder', runtime: 'test', authority_ref: null },
    },
  }));
  return closed.evidence.evidence;
}

const evaluationCaseIds = Array.from(
  { length: 10 },
  (_, index) => `mcp-case-${String(index + 1).padStart(2, '0')}`
);

function seedEvaluationCases(name, home) {
  const cwd = process.cwd();
  const projectId = detectStableProjectIdentity(cwd).id;
  const storeDir = resolveStoreDir(home, projectId);
  evaluationCaseIds.forEach((caseId, index) => {
    const input = `MCP governed evaluation input ${index + 1}`;
    const prompt = appendBehaviorEvent(storeDir, {
      project_id: projectId,
      session_id: `mcp-eval-case-session-${index + 1}`,
      task_ref: null,
      turn_ref: `mcp-eval-case-turn-${index + 1}`,
      parent_event_id: null,
      actor: { kind: 'user', id: 'user:mcp-eval-case', role: null },
      runtime: 'codex',
      source: 'codex_cli',
      source_assurance: 'explicit',
      scope: { level: 'session', id: `mcp-eval-case-session-${index + 1}` },
      event_type: 'user.prompt',
      signal_strength: 'explicit',
      fact_status: 'fact',
      status: 'observed',
      final_disposition: 'unknown',
      details: { fixture: 'self-learning-mcp-evaluation-authority' },
      input_value: input,
      output_value: null,
      evidence_refs: [],
      occurred_at: new Date(Date.UTC(2026, 7, 20, 0, 0, index + 1)).toISOString(),
      source_event_id: `mcp-eval-case-prompt-${index + 1}`,
    });
    addCase(name, {
      id: caseId,
      input,
      source_event_ref: prompt.event.event_id,
    }, { baseDir: home, cwd, projectId });
  });
}

function stageEvaluationAuthority(name, candidateId, passRate, home) {
  const passedCount = Math.round(passRate * evaluationCaseIds.length);
  return stageEvaluationArtifactAuthority(
    name,
    candidateId,
    evaluationCaseIds.map((caseId, index) => ({
      case_id: caseId,
      passed: index < passedCount,
    })),
    {
      baseDir: home,
      cwd: process.cwd(),
      projectId: detectStableProjectIdentity(process.cwd()).id,
    }
  ).authority;
}

function skillSourceFile(cwd, name) {
  return path.join(cwd, 'codex-native', 'skills', name, 'SKILL.md');
}

function writeSkillSource(cwd, name, content) {
  const file = skillSourceFile(cwd, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return artifactContentHash(content);
}

function mcpPromoteAndRecord(name, version, baselineHash, passRate) {
  const currentProjectId = detectStableProjectIdentity(process.cwd()).id;
  const home = resolveBaseDir();
  const evidence = [mcpEpisode(version, 1), mcpEpisode(version, 2)];
  const proposer = { kind: 'agent', id: 'agent:mcp-proposer', authority_ref: 'local:mcp-proposer' };
  const evaluator = { kind: 'agent', id: 'agent:mcp-evaluator', authority_ref: 'local:mcp-evaluator' };
  const approvalAuthority = `mcp-publish-approval-${version}`;
  const publisher = {
    kind: 'user', id: 'user:mcp-publisher', authority_ref: approvalAuthority,
  };
  const sourceContent = fs.readFileSync(skillSourceFile(process.cwd(), name), 'utf8');
  const sourceHash = artifactContentHash(sourceContent);
  if (baselineHash !== null) assert.strictEqual(sourceHash, baselineHash);
  const proposed = resultJson(callTool('tp_learning_propose', {
    input: {
      kind: 'workflow',
      statement: { text: `${name} v${version} MCP publish candidate`, fact_status: 'inference' },
      target: {
        key: `skill:${name}`,
        source_path: `codex-native/skills/${name}/SKILL.md`,
        source_hash: sourceHash,
      },
      scope: { level: 'project', id: currentProjectId },
      proposer,
      evidence_refs: evidence,
      counterexamples: [],
      occurred_at: `2026-08-21T0${version}:20:00.000Z`,
    },
  })).result.candidate;
  const content = `# ${name} v${version}\r\n\r\nMCP canonical candidate artifact\r\n`;
  const staged = resultJson(callTool('tp_learning_govern', {
    operation: 'artifact-stage',
    candidate_id: proposed.candidate_id,
    input: { name, content },
  })).result;
  assert.strictEqual(staged.artifact.hash, artifactContentHash(content));
  const idempotentStage = resultJson(callTool('tp_learning_govern', {
    operation: 'artifact-stage',
    candidate_id: proposed.candidate_id,
    input: { name, content: content.replace(/\r\n/g, '\n') },
  })).result;
  assert.strictEqual(idempotentStage.changed, false);
  const conflictingStage = callTool('tp_learning_govern', {
    operation: 'artifact-stage',
    candidate_id: proposed.candidate_id,
    input: { name, content: `${content}\nforged overwrite` },
  });
  assert.strictEqual(conflictingStage.isError, true);
  assert.match(conflictingStage.content[0].text, /overwrite is prohibited|different content/i);
  const evaluationInput = {
    expected_candidate_hash: proposed.candidate_hash,
    rubric_version: 'tv-v1',
    truth_score: 0.9,
    value_score: 0.9,
    assessor: evaluator,
    evidence_ref_ids: evidence.map((item) => item.evidence_id),
    baseline_hash: baselineHash,
    subject_artifact_hash: staged.artifact.hash,
    evaluation_artifact_ref: { name },
    counterexamples_reviewed: true,
    assessed_at: `2026-08-21T0${version}:21:00.000Z`,
  };
  stageEvaluationAuthority(name, proposed.candidate_id, passRate, home);
  const forgedSubject = callTool('tp_learning_govern', {
    operation: 'evaluate',
    candidate_id: proposed.candidate_id,
    input: { ...evaluationInput, subject_artifact_hash: stableHash({ forged: true }) },
  });
  assert.strictEqual(forgedSubject.isError, true);
  assert.match(forgedSubject.content[0].text, /staged canonical artifact/i);
  const evaluationStartedAt = Date.now();
  const evaluated = resultJson(callTool('tp_learning_govern', {
    operation: 'evaluate',
    candidate_id: proposed.candidate_id,
    input: evaluationInput,
  })).result.candidate;
  const evaluationFinishedAt = Date.now();
  assert.deepStrictEqual(evaluated.evaluation.assessor, {
    kind: 'agent', id: 'codex-mcp-evaluator', authority_ref: null,
  });
  assert(Date.parse(evaluated.evaluation.assessed_at) >= evaluationStartedAt);
  assert(Date.parse(evaluated.evaluation.assessed_at) <= evaluationFinishedAt);
  assert.strictEqual(
    evaluated.evaluation.eligibility.eligible,
    true,
    JSON.stringify(evaluated.evaluation.eligibility)
  );
  const shadowStartedAt = Date.now();
  const shadow = resultJson(callTool('tp_learning_govern', {
    operation: 'shadow',
    candidate_id: proposed.candidate_id,
    input: {
      expected_candidate_hash: evaluated.candidate_hash,
      actor: evaluator,
      occurred_at: `2026-08-21T0${version}:22:00.000Z`,
    },
  })).result.candidate;
  const shadowFinishedAt = Date.now();
  const shadowAudit = shadow.governance_history[shadow.governance_history.length - 1];
  assert.deepStrictEqual(shadowAudit.actor, {
    kind: 'agent', id: 'codex-mcp-shadow', authority_ref: null,
  });
  assert(Date.parse(shadowAudit.occurred_at) >= shadowStartedAt);
  assert(Date.parse(shadowAudit.occurred_at) <= shadowFinishedAt);
  const approvalEvent = appendBehaviorEvent(
    resolveStoreDir(resolveBaseDir(), currentProjectId),
    {
      project_id: currentProjectId,
      session_id: `session-mcp-approval-${version}`,
      task_ref: `task-mcp-approval-${version}`,
      turn_ref: null,
      parent_event_id: null,
      actor: { kind: 'user', id: publisher.id, role: 'publisher' },
      runtime: 'codex',
      source: 'codex_cli',
      source_assurance: 'explicit',
      scope: { level: 'task', id: `task-mcp-approval-${version}` },
      event_type: 'user.approval',
      signal_strength: 'explicit',
      fact_status: 'fact',
      status: 'observed',
      final_disposition: 'accepted',
      details: {
        action: 'approve',
        candidate_id: shadow.candidate_id,
        candidate_hash: shadow.candidate_hash,
      },
      input_value: null,
      output_value: null,
      evidence_refs: [],
      occurred_at: `2026-08-21T0${version}:23:00.000Z`,
      source_event_id: approvalAuthority,
    }
  );
  const approved = executeLearningAction('approve', {
    base_dir: home,
    project_id: currentProjectId,
    candidate_id: proposed.candidate_id,
    input: {
      expected_candidate_hash: shadow.candidate_hash,
      approval_event: {
        ...approvalEvent.event,
        event_hash: approvalEvent.record.payload_hash,
      },
      publisher,
      approved_at: `2026-08-21T0${version}:24:00.000Z`,
    },
  }).result;
  const promoted = executeLearningAction('promote', {
    base_dir: home,
    project_id: currentProjectId,
    candidate_id: proposed.candidate_id,
    input: {
      expected_candidate_hash: approved.candidate.candidate_hash,
      approval_receipt: approved.receipt,
      publisher,
      promoted_at: `2026-08-21T0${version}:25:00.000Z`,
    },
  }).result.candidate;
  const recorded = resultJson(callTool('tp_learning_govern', {
    operation: 'result-record',
    candidate_id: proposed.candidate_id,
    input: { name, version },
  })).result;
  assert.strictEqual(recorded.record.pass_rate, passRate);
  assert.strictEqual(recorded.record.skill_hash, staged.artifact.hash);
  assert.strictEqual(recorded.record.candidate_hash, promoted.candidate_hash);
  return { content, staged, promoted, recorded };
}

function findNamedFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findNamedFile(full, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === name) {
      return full;
    }
  }
  return null;
}

function filesBelow(root, current = root) {
  if (!fs.existsSync(current)) return [];
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(current, entry.name);
    return entry.isDirectory()
      ? filesBelow(root, full)
      : [path.relative(root, full)];
  }).sort();
}

test('MCP exposes five bounded self-learning tools', () => {
  const tools = listToolsForMcp();
  const names = tools.map((tool) => tool.name);
  assert.deepStrictEqual(names.filter((name) => name.startsWith('tp_learning_')), [
    'tp_learning_record',
    'tp_learning_close',
    'tp_learning_propose',
    'tp_learning_inspect',
    'tp_learning_govern',
  ]);
  const govern = tools.find((tool) => tool.name === 'tp_learning_govern');
  assert.ok(govern.inputSchema.properties.operation.enum.includes('artifact-stage'));
  assert.ok(govern.inputSchema.properties.operation.enum.includes('result-record'));
});

test('legacy memory writer requires an explicit user confirmation reference', () => {
  const definitions = listToolsForMcp();
  const save = definitions.find((tool) => tool.name === 'tp_memory_save');
  assert.ok(save.inputSchema.required.includes('user_confirmation_ref'));
  assert.strictEqual(save.inputSchema.additionalProperties, false);
  assert.ok(!Object.hasOwn(save.inputSchema.properties, 'base_dir'));
  assert.ok(!Object.hasOwn(save.inputSchema.properties, 'project_id'));
  assert.ok(!Object.hasOwn(save.inputSchema.properties, 'cwd'));
  assert.match(save.description, /user-confirmed verbatim/i);
  assert.match(save.description, /inferred learning/i);
  assert.match(save.description, /automatic Compound/i);

  const missing = callTool('tp_memory_save', { body: '用户要求保留这句原文' });
  assert.strictEqual(missing.isError, true);
  assert.match(missing.content[0].text, /user_confirmation_ref/);
  ['base_dir', 'project_id', 'cwd'].forEach((field) => {
    const override = callTool('tp_memory_save', {
      body: '用户要求保留这句原文',
      user_confirmation_ref: 'behavior-event:fake',
      [field]: field === 'project_id' ? 'attacker' : baseDir(),
    });
    assert.strictEqual(override.isError, true);
    assert.match(override.content[0].text, /unknown argument/i);
  });

  const home = baseDir();
  const cwd = baseDir();
  withAuthority({ home, cwd }, () => {
    const recorded = appendNativeMemoryControl('用户要求保留这句原文');
    const saved = callTool('tp_memory_save', {
      body: '用户要求保留这句原文',
      topic: 'workflow',
      user_confirmation_ref: recorded.event.event_id,
    });
    assert.ok(!saved.isError, saved.content[0].text);
    assert.match(saved.content[0].text, /user-confirmed verbatim/);
    const file = findNamedFile(path.join(home, 'projects'), 'workflow.md');
    assert.ok(file, 'confirmed memory file missing');
    const entries = collectMemoryEntries(path.dirname(file));
    assert.strictEqual(entries.length, 1, 'legacy Memory v5 reader lost the tightened write');
    assert.match(entries[0].line, /用户要求保留这句原文/);
  });
});

test('memory writer rejects fake, non-verbatim, and cross-project confirmations', () => {
  const home = baseDir();
  const projectA = baseDir();
  const projectB = baseDir();
  let confirmationRef;
  withAuthority({ home, cwd: projectA }, () => {
    const recorded = appendNativeMemoryControl('只保存这一句', '2');
    confirmationRef = recorded.event.event_id;
    const fake = callTool('tp_memory_save', {
      body: '只保存这一句', user_confirmation_ref: 'behavior-event:fake',
    });
    assert.strictEqual(fake.isError, true);
    const changed = callTool('tp_memory_save', {
      body: '代理改写后的另一句', user_confirmation_ref: confirmationRef,
    });
    assert.strictEqual(changed.isError, true);
    assert.match(changed.content[0].text, /verbatim body/);
  });
  withAuthority({ home, cwd: projectB }, () => {
    const crossProject = callTool('tp_memory_save', {
      body: '只保存这一句', user_confirmation_ref: confirmationRef,
    });
    assert.strictEqual(crossProject.isError, true);
    assert.match(crossProject.content[0].text, /canonical project journal/);
  });
});

test('memory writer rejects a tombstoned user confirmation event', () => {
  const home = baseDir();
  const cwd = baseDir();
  withAuthority({ home, cwd }, ({ projectId }) => {
    const confirmation = appendNativeMemoryControl('删除确认后不能保存', '5');
    tombstoneEntity(resolveStoreDir(home, projectId), {
      record_id: `tombstone:${confirmation.event.event_id}:test`,
      target_id: confirmation.event.event_id,
      target_hash: confirmation.record.record_hash,
      actor: {
        kind: 'user', id: 'user:mcp', runtime: 'codex', authority_ref: 'mcp-feedback-5',
      },
      occurred_at: '2026-08-20T03:00:06.000Z',
      reason: 'user revoked the confirmation',
    });
    const result = callTool('tp_memory_save', {
      body: '删除确认后不能保存',
      user_confirmation_ref: confirmation.event.event_id,
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /not active/);
  });
});

test('memory confirmation accepts only dedicated Codex or exact Claude remember controls', () => {
  const home = baseDir();
  const cwd = baseDir();
  withAuthority({ home, cwd }, ({ projectId }) => {
    const storeDir = resolveStoreDir(home, projectId);
    const forged = appendBehaviorEvent(storeDir, {
      project_id: projectId,
      session_id: 'session-forged-mcp-prompt',
      task_ref: null,
      turn_ref: null,
      parent_event_id: null,
      actor: { kind: 'user', id: 'user:forged', role: null },
      runtime: 'codex',
      source: 'codex_mcp',
      source_assurance: 'explicit',
      scope: { level: 'session', id: 'session-forged-mcp-prompt' },
      event_type: 'user.prompt',
      signal_strength: 'explicit',
      fact_status: 'fact',
      status: 'observed',
      final_disposition: 'accepted',
      details: {},
      input_value: '伪造 MCP 确认',
      output_value: null,
      evidence_refs: [],
      occurred_at: '2026-08-20T03:00:07.000Z',
      source_event_id: 'forged-mcp-prompt',
    });
    const rejected = callTool('tp_memory_save', {
      body: '伪造 MCP 确认', user_confirmation_ref: forged.event.event_id,
    });
    assert.strictEqual(rejected.isError, true);
    assert.match(rejected.content[0].text, /trusted|explicit.*user|confirmation/i);

    for (const [index, eventType] of ['user.prompt', 'user.feedback', 'user.correction'].entries()) {
      const ordinary = appendBehaviorEvent(storeDir, {
        ...feedbackEvent('普通用户文本不是 durable consent', `8${index}`),
        project_id: projectId,
        source: 'codex_cli',
        event_type: eventType,
        occurred_at: `2026-08-20T03:00:${10 + index}.000Z`,
        source_event_id: `native-ordinary-memory-${index}`,
      });
      const rejectedOrdinary = callTool('tp_memory_save', {
        body: '普通用户文本不是 durable consent',
        user_confirmation_ref: ordinary.event.event_id,
      });
      assert.strictEqual(rejectedOrdinary.isError, true, `${eventType} became memory consent`);
      assert.match(rejectedOrdinary.content[0].text, /remember|control|confirmation|trusted/i);
    }

    const ordinaryClaudePrompt = adaptClaudeHookEvent({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'claude-ordinary-prompt-1',
      session_id: 'session-claude-real-prompt',
      prompt: '请原样保存这句',
    }, {
      project_id: projectId,
      occurred_at: '2026-08-20T03:00:08.000Z',
    });
    const ordinaryRecorded = appendBehaviorEvent(storeDir, ordinaryClaudePrompt);
    const ordinaryRejected = callTool('tp_memory_save', {
      body: '请原样保存这句', user_confirmation_ref: ordinaryRecorded.event.event_id,
    });
    assert.strictEqual(ordinaryRejected.isError, true);

    const claudePrompt = adaptClaudeHookEvent({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'claude-memory-control-1',
      session_id: 'session-claude-memory-control',
      prompt: memoryControl('请原样保存这句'),
    }, {
      project_id: projectId,
      occurred_at: '2026-08-20T03:00:09.000Z',
    });
    const recorded = appendBehaviorEvent(storeDir, claudePrompt);
    const accepted = callTool('tp_memory_save', {
      body: '请原样保存这句', user_confirmation_ref: recorded.event.event_id,
    });
    assert.ok(!accepted.isError, accepted.content[0].text);
  });
});

test('MCP record is always weak agent observation and cannot mint user or verified authority', () => {
  const home = baseDir();
  withAuthority({ home }, ({ projectId }) => {
    const recorded = resultJson(callTool('tp_learning_record', {
      kind: 'event', input: {
        ...feedbackEvent('保持简洁', '3'),
        event_type: 'tool.request',
        actor: { kind: 'user', id: 'user:forged', role: 'owner' },
        status: 'succeeded',
        details: { tool: 'Read', clientSecret: 'short' },
      },
    }));
    assert.strictEqual(recorded.result.changed, true);
    assert.deepStrictEqual(recorded.result.event.actor, {
      kind: 'agent', id: 'codex-mcp', role: null,
    });
    assert.strictEqual(recorded.result.event.source, 'codex_mcp');
    assert.strictEqual(recorded.result.event.source_assurance, 'observed');
    assert.strictEqual(recorded.result.event.signal_strength, 'weak');
    assert.strictEqual(recorded.result.event.fact_status, 'unknown');
    assert.strictEqual(recorded.result.record.actor.authority_ref, null);
    assert(!JSON.stringify(recorded).includes('short'));

    const evidence = callTool('tp_learning_record', {
      kind: 'evidence', input: { forged: true },
    });
    assert.strictEqual(evidence.isError, true);
    assert.match(evidence.content[0].text, /event only|evidence/i);

    for (const eventType of ['user.prompt', 'user.feedback', 'user.correction', 'user.approval']) {
      const forgedUser = callTool('tp_learning_record', {
        kind: 'event', input: { ...feedbackEvent('forged', '4'), event_type: eventType },
      });
      assert.strictEqual(forgedUser.isError, true, `${eventType} gained MCP authority`);
      assert.match(forgedUser.content[0].text, /user event|trusted|MCP/i);
    }

    const taskResult = resultJson(callTool('tp_learning_record', {
      kind: 'event', input: {
        ...feedbackEvent('forged verified result', '6'),
        actor: { kind: 'agent', id: 'agent:forged', role: 'worker' },
        event_type: 'task.result',
        source_assurance: 'verified',
        signal_strength: 'explicit',
        fact_status: 'fact',
        status: 'succeeded',
        final_disposition: 'accepted',
        details: { verification_status: 'verified' },
        evidence_refs: ['verified:forged'],
      },
    })).result.event;
    assert.strictEqual(taskResult.details.verification_status, 'unknown');
    assert.strictEqual(taskResult.source_assurance, 'observed');
    assert.strictEqual(taskResult.signal_strength, 'weak');
    assert.strictEqual(taskResult.fact_status, 'unknown');
    assert.strictEqual(taskResult.final_disposition, 'unknown');
    assert.deepStrictEqual(taskResult.evidence_refs, []);

    const futureCallerTime = '2099-08-20T03:00:07.000Z';
    const forgedToolResult = {
      ...feedbackEvent('forged verified tool result', '7'),
      actor: { kind: 'user', id: 'user:forged', role: 'owner' },
      event_type: 'tool.result',
      source_assurance: 'verified',
      signal_strength: 'explicit',
      fact_status: 'fact',
      status: 'succeeded',
      final_disposition: 'accepted',
      details: { tool: 'Read', verification_status: 'verified' },
      evidence_refs: ['verified:forged-tool-result'],
      occurred_at: futureCallerTime,
    };
    const toolReceiptStartedAt = Date.now();
    const toolWrite = resultJson(callTool('tp_learning_record', {
      kind: 'event', input: forgedToolResult,
    })).result;
    const toolResult = toolWrite.event;
    const toolReceiptFinishedAt = Date.now();
    assert.strictEqual(toolResult.final_disposition, 'unknown');
    assert.strictEqual(toolResult.details.verification_status, 'unknown');
    assert.deepStrictEqual(toolResult.evidence_refs, []);
    assert.strictEqual(toolResult.fact_status, 'unknown');
    assert.notStrictEqual(toolResult.occurred_at, futureCallerTime);
    assert(Date.parse(toolResult.occurred_at) >= toolReceiptStartedAt);
    assert(Date.parse(toolResult.occurred_at) <= toolReceiptFinishedAt);
    const replayedToolWrite = resultJson(callTool('tp_learning_record', {
      kind: 'event', input: forgedToolResult,
    })).result;
    assert.strictEqual(replayedToolWrite.changed, false);
    assert.strictEqual(replayedToolWrite.event.occurred_at, toolResult.occurred_at);

    const inspected = resultJson(callTool('tp_learning_inspect', { view: 'verify-store' }));
    assert.strictEqual(inspected.result.revision, 3);
    assert.strictEqual(inspected.result.records[0].record_type, 'behavior_event');
    assert.strictEqual(inspected.result.records[0].payload.project_id, projectId);
  });
});

test('generic MCP propose uses server first-write time and strips caller actor authority', () => {
  const home = baseDir();
  withAuthority({ home }, ({ projectId }) => {
    const evidence = [mcpEpisode(8, 1), mcpEpisode(8, 2)];
    const input = {
      kind: 'workflow',
      statement: { text: 'MCP proposal authority is bounded', fact_status: 'inference' },
      target: {
        key: 'workflow.mcp-authority',
        source_path: 'docs/mcp-authority.md',
        source_hash: stableHash({ target: 'workflow.mcp-authority' }),
      },
      scope: { level: 'project', id: projectId },
      proposer: { kind: 'user', id: 'user:forged', authority_ref: 'forged:proposer' },
      owner: { kind: 'user', id: 'user:forged', authority_ref: 'forged:owner' },
      collector_ref: 'forged:collector',
      evidence_refs: evidence,
      counterexamples: [],
      occurred_at: '2099-08-21T09:20:00.000Z',
    };
    const startedAt = Date.now();
    const first = resultJson(callTool('tp_learning_propose', { input })).result;
    const finishedAt = Date.now();
    assert.deepStrictEqual(first.candidate.proposer, {
      kind: 'agent', id: 'codex-mcp', authority_ref: null,
    });
    assert.deepStrictEqual(first.candidate.owner, {
      kind: 'agent', id: 'codex-mcp', authority_ref: null,
    });
    assert.strictEqual(first.candidate.authority.collector_ref, null);
    assert(Date.parse(first.candidate.created_at) >= startedAt);
    assert(Date.parse(first.candidate.created_at) <= finishedAt);
    const replay = resultJson(callTool('tp_learning_propose', { input })).result;
    assert.strictEqual(replay.changed, false);
    assert.strictEqual(replay.candidate.created_at, first.candidate.created_at);
  });
});

test('MCP cannot invoke local-admin candidate governance even with a forged user actor', () => {
  withAuthority({}, () => {
    for (const operation of ['approve', 'promote', 'govern', 'retention']) {
      const result = callTool('tp_learning_govern', {
        operation,
        candidate_id: 'lc-' + 'a'.repeat(32),
        input: { actor: { kind: 'user', id: 'user:forged', authority_ref: 'forged' } },
      });
      assert.strictEqual(result.isError, true, `${operation} accepted an MCP actor`);
      assert.match(result.content[0].text, /local admin|CLI|unavailable through MCP/i);
    }
  });
});

test('MCP artifact and result writes honor every self-learning writer kill switch before I/O', () => {
  const policies = [
    { enabled: false },
    { writer_enabled: false },
    { mode: 'off' },
  ];
  for (const selfLearning of policies) {
    const home = baseDir();
    const cwd = baseDir();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ self_learning: selfLearning }));
    withAuthority({ home, cwd }, () => {
      const candidateId = `lc-${'d'.repeat(32)}`;
      const stage = callTool('tp_learning_govern', {
        operation: 'artifact-stage',
        candidate_id: candidateId,
        input: { name: 'sprint', content: '# must not be written\n' },
      });
      const result = callTool('tp_learning_govern', {
        operation: 'result-record',
        candidate_id: candidateId,
        input: { name: 'sprint', version: 1 },
      });
      assert.strictEqual(stage.isError, true);
      assert.strictEqual(result.isError, true);
      assert.match(stage.content[0].text, /writer|disabled|off/i);
      assert.match(result.content[0].text, /writer|disabled|off/i);
      assert.deepStrictEqual(filesBelow(home).filter((file) => file !== 'config.json'), []);
    });
  }
});

test('MCP learning tools reject caller-controlled authority and unknown fields', () => {
  const definitions = listToolsForMcp().filter((tool) => tool.name.startsWith('tp_learning_'));
  definitions.forEach((definition) => {
    assert.strictEqual(definition.inputSchema.additionalProperties, false);
    assert.ok(!Object.hasOwn(definition.inputSchema.properties, 'base_dir'));
    assert.ok(!Object.hasOwn(definition.inputSchema.properties, 'project_id'));
    assert.ok(!Object.hasOwn(definition.inputSchema.properties, 'cwd'));
  });
  withAuthority({}, () => {
    const attempts = [
      ['tp_learning_record', { kind: 'event', input: feedbackEvent('x', '4'), base_dir: baseDir() }],
      ['tp_learning_close', { input: {}, project_id: 'attacker' }],
      ['tp_learning_propose', { input: {}, cwd: baseDir() }],
      ['tp_learning_inspect', { view: 'verify-store', base_dir: baseDir() }],
      ['tp_learning_govern', { operation: 'publish-guard', input: { name: 'sprint' }, project_id: 'attacker' }],
      ['tp_learning_govern', { operation: 'publish-guard', input: { name: 'sprint', base_dir: baseDir() } }],
      ['tp_learning_govern', { operation: 'publish-guard', input: { name: 'sprint', now: '2099-01-01T00:00:00.000Z' } }],
      ['tp_learning_govern', { operation: 'publish-guard', candidate_id: 'lc-caller', input: { name: 'sprint' } }],
      ['tp_learning_govern', { operation: 'artifact-stage', candidate_id: 'lc-caller', input: { name: 'sprint', content: '# x', path: baseDir() } }],
      ['tp_learning_govern', { operation: 'result-record', candidate_id: 'lc-caller', input: { name: 'sprint', version: 1, pass_rate: 1 } }],
      ['tp_learning_govern', { operation: 'result-record', candidate_id: 'lc-caller', input: { name: 'sprint', version: 1, now: '2099-01-01T00:00:00.000Z' } }],
    ];
    attempts.forEach(([name, args]) => {
      const result = callTool(name, args);
      assert.strictEqual(result.isError, true, `${name} accepted authority override`);
      assert.match(result.content[0].text, /unknown argument|caller-selected candidate_id/i);
    });
  });
});

test('MCP governance rejects promotion before trusting any caller candidate or receipt', () => {
  withAuthority({}, () => {
    const result = callTool('tp_learning_govern', { operation: 'promote', input: {} });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /local admin|CLI|unavailable through MCP/i);
  });
});

test('MCP publish-guard is reachable and fails closed without eval authority', () => {
  withAuthority({}, () => {
    const result = callTool('tp_learning_govern', {
      operation: 'publish-guard', input: { name: 'sprint' },
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /no-baseline|BLOCKED|blocked/);
  });
});

test('MCP closes canonical stage through two promoted result versions into publish guard', () => {
  const home = baseDir();
  const cwd = baseDir();
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  withAuthority({ home, cwd }, () => {
    seedEvaluationCases('sprint', home);
    writeSkillSource(cwd, 'sprint', '# sprint source v0\n');
    const baseline = mcpPromoteAndRecord('sprint', 1, null, 0.8);
    writeSkillSource(cwd, 'sprint', baseline.content);
    const candidate = mcpPromoteAndRecord(
      'sprint',
      2,
      baseline.staged.artifact.hash,
      0.9
    );
    assert.notStrictEqual(
      baseline.recorded.record.candidate_id,
      candidate.recorded.record.candidate_id
    );
    assert.notStrictEqual(
      baseline.recorded.record.evaluation_id,
      candidate.recorded.record.evaluation_id
    );
    assert.notStrictEqual(
      baseline.recorded.record.approval_receipt_id,
      candidate.recorded.record.approval_receipt_id
    );
    const guarded = resultJson(callTool('tp_learning_govern', {
      operation: 'publish-guard', input: { name: 'sprint' },
    }));
    assert.strictEqual(guarded.result.status, 'ok');
    assert.strictEqual(guarded.result.publish_authorized, true);
  });
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
