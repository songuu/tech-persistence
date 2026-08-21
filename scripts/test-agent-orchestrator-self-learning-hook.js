#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  attachSelfLearningProviderEnv,
  buildSelfLearningProviderEnv,
} = require('./agent-orchestrator');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { readJournal, resolveStoreDir } = require('./lib/self-learning-store');

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

function spawnManagedHook(workspace, invocation, script, payload, args = []) {
  return spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: workspace,
    env: { ...process.env, ...invocation.env },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
  });
}

function spawnLifecycle(workspace, invocation, payload) {
  return spawnManagedHook(
    workspace,
    invocation,
    'codex-lifecycle-evidence.js',
    payload
  );
}

test('managed invocation identity reaches the real Codex hook and authority journal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-orchestrator-hook-e2e-'));
  const workspace = path.join(root, 'workspace');
  const baseDir = path.join(root, 'homunculus');
  const runsDir = path.join(workspace, '.agent-runs');
  const runDir = path.join(runsDir, 'run-e2e');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), '{"status":"running"}\n');
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
    self_learning: {
      legacy_writer_enabled: false,
      legacy_reader_enabled: false,
    },
  }));
  try {
    const state = { runId: 'run-e2e', workdir: workspace };
    const attempt = {
      task: {
        ref: 'task:run-e2e:implementation:001',
        hash: `sha256:${'a'.repeat(64)}`,
      },
    };
    const identityEnv = buildSelfLearningProviderEnv(state, attempt, { baseDir });
    assert.deepStrictEqual(Object.keys(identityEnv).sort(), [
      'TP_SELF_LEARNING_BASE_DIR',
      'TP_SELF_LEARNING_PROJECT_ID',
      'TP_SELF_LEARNING_SOURCE_EVENT_BASE',
      'TP_SELF_LEARNING_TASK_REF',
    ]);
    assert.strictEqual(identityEnv.TP_SELF_LEARNING_BASE_DIR, path.resolve(baseDir));
    assert.strictEqual(identityEnv.TP_SELF_LEARNING_TASK_REF, attempt.task.ref);
    assert.strictEqual(identityEnv.TP_SELF_LEARNING_SOURCE_EVENT_BASE, attempt.task.hash);
    assert.strictEqual(identityEnv.TP_SELF_LEARNING_SESSION_ID, undefined,
      'agent-loop run id must not impersonate the native Codex session');

    const invocation = attachSelfLearningProviderEnv({
      env: {
        TP_AGENT_RUN_DIR: runDir,
        TP_AGENT_RUNS_DIR: runsDir,
      },
    }, state, attempt, { baseDir });
    assert.strictEqual(invocation.env.CODEX_SESSION_ID, '');
    assert.strictEqual(invocation.env.CLAUDE_SESSION_ID, '');
    const basePayload = {
      session_id: 'native-codex-session-e2e',
      turn_id: 'native-codex-turn-e2e',
      cwd: workspace,
      model: 'gpt-5.6-sol',
      permission_mode: 'default',
    };
    const first = spawnLifecycle(workspace, invocation, {
      ...basePayload,
      hook_event_name: 'SubagentStart',
      agent_id: 'agent-e2e',
      agent_type: 'worker',
    });
    assert.strictEqual(first.status, 0, first.error && first.error.message || first.stderr);
    const evidenceDir = path.join(runDir, 'native-lifecycle-evidence');
    const firstArtifact = path.join(
      evidenceDir,
      fs.readdirSync(evidenceDir).find((name) => name.endsWith('.json'))
    );
    fs.writeFileSync(firstArtifact, JSON.stringify({
      idempotencyKey: 'f'.repeat(64),
      recordedAt: '2099-01-01T00:00:00.000Z',
      event: 'SessionEnd',
    }));
    const replay = spawnLifecycle(workspace, invocation, {
      ...basePayload,
      hook_event_name: 'SubagentStart',
      agent_id: 'agent-e2e',
      agent_type: 'worker',
    });
    const distinctHook = spawnLifecycle(workspace, invocation, {
      ...basePayload,
      hook_event_name: 'PostCompact',
      trigger: 'manual',
    });
    for (const result of [first, replay, distinctHook]) {
      assert.strictEqual(result.status, 0, result.error && result.error.message || result.stderr);
      assert.strictEqual(result.stdout, '');
      assert.strictEqual(result.stderr, '');
    }

    const project = detectStableProjectIdentity(workspace);
    const journal = readJournal(resolveStoreDir(baseDir, project.id));
    const events = journal.records.filter((record) => record.record_type === 'behavior_event');
    assert.strictEqual(events.length, 2, 'replay must deduplicate while distinct hooks remain distinct');
    assert.deepStrictEqual(events.map((record) => record.payload.details.hook_event_name), [
      'SubagentStart',
      'PostCompact',
    ]);
    assert(events.every((record) => record.payload.session_id === basePayload.session_id));
    assert(events.every((record) => record.payload.task_ref === attempt.task.ref));
    assert(events.every((record) => record.payload.occurred_at !== '2099-01-01T00:00:00.000Z'));
    assert.notStrictEqual(events[0].payload.source_event_id, events[1].payload.source_event_id);

    assert.strictEqual(fs.readdirSync(evidenceDir).filter((name) => name.endsWith('.json')).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed task identity reaches Claude prompt/tool/Stop hooks and closes one task Episode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-orchestrator-claude-hook-e2e-'));
  const workspace = path.join(root, 'workspace');
  const baseDir = path.join(root, 'homunculus');
  const runsDir = path.join(workspace, '.agent-runs');
  const runDir = path.join(runsDir, 'run-claude-e2e');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), '{"status":"running"}\n');
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
    self_learning: {
      legacy_writer_enabled: false,
      legacy_reader_enabled: false,
    },
  }));
  try {
    const state = { runId: 'run-claude-e2e', workdir: workspace };
    const attempt = {
      task: {
        ref: 'task:run-claude-e2e:spec:001',
        hash: `sha256:${'b'.repeat(64)}`,
      },
    };
    const invocation = attachSelfLearningProviderEnv({
      env: {
        TP_AGENT_RUN_DIR: runDir,
        TP_AGENT_RUNS_DIR: runsDir,
      },
    }, state, attempt, { baseDir });
    const sessionId = 'native-claude-session-e2e';
    const prompt = spawnManagedHook(workspace, invocation, 'prompt-submit.js', {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-managed-e2e',
      session_id: sessionId,
      cwd: workspace,
      prompt: 'Run the bounded managed task.',
    });
    const toolBase = {
      tool_use_id: 'tool-managed-e2e',
      session_id: sessionId,
      cwd: workspace,
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    };
    const pre = spawnManagedHook(workspace, invocation, 'observe.js', {
      ...toolBase,
      hook_event_name: 'PreToolUse',
    }, ['pre']);
    const post = spawnManagedHook(workspace, invocation, 'observe.js', {
      ...toolBase,
      hook_event_name: 'PostToolUse',
      tool_response: { ok: true },
      success: true,
    }, ['post']);
    const stop = spawnManagedHook(workspace, invocation, 'evaluate-session.js', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: workspace,
    });
    for (const result of [prompt, pre, post, stop]) {
      assert.strictEqual(result.status, 0, result.error && result.error.message || result.stderr);
      assert.strictEqual(result.stdout, '');
      assert.strictEqual(result.stderr, '');
    }

    const project = detectStableProjectIdentity(workspace);
    const journal = readJournal(resolveStoreDir(baseDir, project.id));
    const events = journal.records
      .filter((record) => record.record_type === 'behavior_event')
      .map((record) => record.payload);
    assert.deepStrictEqual(events.map((event) => event.event_type), [
      'user.prompt',
      'tool.request',
      'tool.result',
    ]);
    assert(events.every((event) => event.session_id === sessionId));
    assert(events.every((event) => event.task_ref === attempt.task.ref));
    const episode = journal.records.find((record) => record.record_type === 'behavior_episode');
    assert(episode, 'Stop must close an Episode for the managed task identity');
    assert.strictEqual(episode.payload.session_id, sessionId);
    assert.strictEqual(episode.payload.task_ref, attempt.task.ref);
    assert.match(episode.payload.created_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
