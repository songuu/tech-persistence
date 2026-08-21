#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { adaptExplicitBehaviorEvent } = require('./lib/behavior-events');
const { detectProjectIdentity } = require('./lib/memory-v5');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { executeLearningAction } = require('./lib/self-learning-service');
const { readJournal, resolveStoreDir } = require('./lib/self-learning-store');

const SCRIPTS_DIR = __dirname;
const SECRET = 'runtime-secret-sentinel-92387';
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

function fixture(prefix = 'tp-runtime-entry-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const baseDir = path.join(root, 'homunculus');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { root, baseDir, workspace };
}

function runtimeEnv(baseDir, overrides = {}) {
  const env = {
    ...process.env,
    TECH_PERSISTENCE_HOME: baseDir,
    TECH_PERSISTENCE_RUNTIME: 'claude',
    ...overrides,
  };
  for (const key of ['CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) delete env[key];
  }
  return env;
}

function runHook(script, options = {}) {
  return spawnSync(
    process.execPath,
    [path.join(SCRIPTS_DIR, script), ...(options.args || [])],
    {
      cwd: options.cwd,
      env: runtimeEnv(options.baseDir, options.env),
      input: options.input,
      encoding: 'utf8',
      windowsHide: true,
    }
  );
}

function assertFailOpenDiagnostic(result, secret = SECRET) {
  assert.strictEqual(result.status, 0, result.error && result.error.message || result.stderr);
  assert(result.stderr.length > 0, 'expected a bounded diagnostic');
  assert(result.stderr.length <= 512, `diagnostic exceeded bound: ${result.stderr.length}`);
  assert(!result.stderr.includes(secret), 'diagnostic leaked payload/config value');
}

function writeConfig(baseDir, selfLearning) {
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
    self_learning: selfLearning,
  }));
}

function validPayloads(workspace) {
  return {
    'prompt-submit.js': JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-entry-001',
      session_id: 'session-entry-001',
      cwd: workspace,
      prompt: `remember ${SECRET}`,
    }),
    'observe.js': JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tool-entry-001',
      session_id: 'session-entry-001',
      cwd: workspace,
      tool_name: 'Read',
      tool_response: { value: SECRET },
      success: true,
    }),
    'evaluate-session.js': JSON.stringify({
      hook_event_name: 'Stop',
      session_id: `session-${SECRET}`,
      task_ref: 'task-entry-001',
      timestamp: '2026-08-20T08:00:00.000Z',
      cwd: workspace,
    }),
  };
}

function writeMalformedJournal(baseDir, projectId) {
  const storeDir = resolveStoreDir(baseDir, projectId);
  const journalDir = path.join(storeDir, 'journal');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(
    path.join(journalDir, `000000000001-${'a'.repeat(64)}.json`),
    `{ "secret": "${SECRET}"`
  );
}

test('real hooks fail open on strict config errors without leaking values or writing stores', () => {
  const { root, baseDir, workspace } = fixture();
  try {
    fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
      self_learning: { unexpected_secret_field: SECRET },
    }));
    const payloads = validPayloads(workspace);
    const cases = [
      ['prompt-submit.js', []],
      ['observe.js', ['post']],
      ['inject-context.js', []],
      ['evaluate-session.js', []],
    ];
    for (const [script, args] of cases) {
      const result = runHook(script, {
        args,
        baseDir,
        cwd: workspace,
        input: payloads[script],
      });
      assertFailOpenDiagnostic(result);
      assert.strictEqual(result.stdout, '');
    }
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Stop real entry rejects every malformed policy shape before mode side effects', () => {
  const variants = [
    '{ invalid json',
    JSON.stringify({ self_learning: { unknown_gate: true } }),
    JSON.stringify({ self_learning: { minimum_truth_score: 2 } }),
    JSON.stringify({ self_learning: {}, selfLearning: {} }),
  ];
  for (const configText of variants) {
    const { root, baseDir, workspace } = fixture('tp-stop-policy-entry-');
    try {
      fs.writeFileSync(path.join(baseDir, 'config.json'), configText);
      const result = runHook('evaluate-session.js', {
        baseDir,
        cwd: workspace,
        input: validPayloads(workspace)['evaluate-session.js'],
      });
      assertFailOpenDiagnostic(result);
      assert.strictEqual(result.stdout, '');
      assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
      assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects.json')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('normal entrypoint skips remain quiet', () => {
  const { root, baseDir, workspace } = fixture();
  try {
    writeConfig(baseDir, {
      legacy_writer_enabled: false,
      legacy_reader_enabled: false,
    });
    const cases = [
      runHook('prompt-submit.js', { baseDir, cwd: workspace, input: '{}' }),
      runHook('observe.js', { args: ['post'], baseDir, cwd: workspace, input: '' }),
      runHook('inject-context.js', { baseDir, cwd: workspace }),
      runHook('evaluate-session.js', { baseDir, cwd: workspace, input: '' }),
    ];
    for (const result of cases) {
      assert.strictEqual(result.status, 0, result.error && result.error.message || result.stderr);
      assert.strictEqual(result.stdout, '');
      assert.strictEqual(result.stderr, '');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real observe stdin enforces 64 KiB before any legacy or journal write', () => {
  const { root, baseDir, workspace } = fixture('tp-observe-bounded-entry-');
  try {
    writeConfig(baseDir, {
      legacy_writer_enabled: true,
      legacy_reader_enabled: false,
    });
    const projectId = detectStableProjectIdentity(workspace).id;
    const result = runHook('observe.js', {
      args: ['post'],
      baseDir,
      cwd: workspace,
      env: { TP_SELF_LEARNING_PROJECT_ID: projectId },
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tool-oversized-entry-001',
        session_id: 'session-oversized-entry-001',
        cwd: workspace,
        tool_name: 'Read',
        tool_response: SECRET.repeat(8192),
      }),
    });
    assertFailOpenDiagnostic(result);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real prompt stdin enforces 64 KiB total before parse, recall, or journal write', () => {
  const { root, baseDir, workspace } = fixture('tp-prompt-bounded-entry-');
  try {
    writeConfig(baseDir, {
      legacy_writer_enabled: true,
      legacy_reader_enabled: true,
    });
    const result = runHook('prompt-submit.js', {
      baseDir,
      cwd: workspace,
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt_id: 'prompt-oversized-entry-001',
        session_id: 'session-oversized-entry-001',
        cwd: workspace,
        prompt: SECRET.repeat(8192),
      }),
    });
    assertFailOpenDiagnostic(result);
    assert.match(result.stderr, /hook-payload-too-large/);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real Claude hooks reject payload cwd that conflicts with managed project authority', () => {
  const { root, baseDir, workspace } = fixture('tp-project-authority-entry-');
  const otherWorkspace = path.join(root, 'other-workspace');
  fs.mkdirSync(otherWorkspace, { recursive: true });
  try {
    writeConfig(baseDir, {
      legacy_writer_enabled: true,
      legacy_reader_enabled: false,
    });
    const env = {
      TP_SELF_LEARNING_PROJECT_ID: detectStableProjectIdentity(workspace).id,
      TP_SELF_LEARNING_TASK_REF: 'task-project-authority-entry',
    };
    const cases = [
      ['prompt-submit.js', [], {
        hook_event_name: 'UserPromptSubmit',
        prompt_id: 'prompt-project-authority-entry',
        session_id: 'session-project-authority-entry',
        cwd: otherWorkspace,
        prompt: 'cross project prompt',
      }],
      ['observe.js', ['post'], {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tool-project-authority-entry',
        session_id: 'session-project-authority-entry',
        cwd: otherWorkspace,
        tool_name: 'Read',
        tool_response: { ok: true },
      }],
      ['inject-context.js', [], {
        hook_event_name: 'SessionStart',
        session_id: 'session-project-authority-entry',
        cwd: otherWorkspace,
      }],
      ['evaluate-session.js', [], {
        hook_event_name: 'Stop',
        session_id: 'session-project-authority-entry',
        cwd: otherWorkspace,
      }],
    ];
    for (const [script, args, payload] of cases) {
      const result = runHook(script, {
        args,
        baseDir,
        cwd: workspace,
        env,
        input: JSON.stringify(payload),
      });
      assertFailOpenDiagnostic(result);
      assert.match(result.stderr, /project-identity-mismatch/);
      assert.strictEqual(result.stdout, '');
    }
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture and store failures are diagnostic but never block real hook processes', () => {
  const { root, baseDir, workspace } = fixture();
  try {
    writeConfig(baseDir, {
      legacy_writer_enabled: false,
      legacy_reader_enabled: false,
    });
    const project = detectStableProjectIdentity(workspace);
    writeMalformedJournal(baseDir, project.id);
    const payloads = validPayloads(workspace);
    const cases = [
      ['prompt-submit.js', []],
      ['observe.js', ['post']],
      ['inject-context.js', []],
      ['evaluate-session.js', []],
    ];
    for (const [script, args] of cases) {
      const result = runHook(script, {
        args,
        baseDir,
        cwd: workspace,
        input: payloads[script],
      });
      assertFailOpenDiagnostic(result);
      assert.strictEqual(result.stdout, '');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Stop real entry closes payload session/task at payload time without session env', () => {
  const { root, baseDir, workspace } = fixture();
  try {
    writeConfig(baseDir, {
      legacy_writer_enabled: false,
      legacy_reader_enabled: false,
    });
    const project = detectStableProjectIdentity(workspace);
    const sessionId = 'native-payload-session';
    const taskRef = 'native-payload-task';
    const occurredAt = '2026-08-20T08:30:00.000Z';
    const event = adaptExplicitBehaviorEvent({
      source_event_id: 'native-payload-prompt-001',
      occurred_at: '2026-08-20T08:29:00.000Z',
      project_id: project.id,
      session_id: sessionId,
      task_ref: taskRef,
      turn_ref: null,
      parent_event_id: null,
      actor: { kind: 'user', id: 'user', role: null },
      runtime: 'claude',
      source: 'claude_hook',
      event_type: 'user.prompt',
      signal_strength: 'explicit',
      status: 'observed',
      final_disposition: 'unknown',
      fact_status: 'fact',
      details: { summary: 'bounded prompt' },
      input_value: 'bounded prompt',
      output_value: null,
      evidence_refs: [],
    });
    executeLearningAction('record', {
      base_dir: baseDir,
      project_id: project.id,
      cwd: workspace,
      input: event,
    }, { require_explicit_base_dir: true });

    const legacyProject = detectProjectIdentity(workspace);
    const legacyDir = path.join(baseDir, 'projects', legacyProject.id);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'observations.jsonl'), [0, 1, 2]
      .map((index) => JSON.stringify({
        session_id: sessionId,
        timestamp: `2026-08-20T08:29:0${index}.000Z`,
        phase: 'post',
        tool: 'Read',
      }))
      .concat(JSON.stringify({
        session_id: 'other-session',
        timestamp: '2026-08-20T08:29:09.000Z',
        phase: 'post',
        tool: 'Write',
      }))
      .join('\n'));

    const result = runHook('evaluate-session.js', {
      baseDir,
      cwd: workspace,
      input: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: sessionId,
        task_id: taskRef,
        occurred_at: occurredAt,
        cwd: workspace,
      }),
    });
    assert.strictEqual(result.status, 0, result.error && result.error.message || result.stderr);
    assert.strictEqual(result.stderr, '');
    assert.strictEqual(result.stdout, '');
    const journal = readJournal(resolveStoreDir(baseDir, project.id));
    const episodes = journal.records.filter((record) => record.record_type === 'behavior_episode');
    assert.strictEqual(episodes.length, 1);
    assert.strictEqual(episodes[0].payload.session_id, sessionId);
    assert.strictEqual(episodes[0].payload.task_ref, taskRef);
    assert.strictEqual(episodes[0].payload.created_at, occurredAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Stop payload/env session conflict exits zero without closing or leaking identities', () => {
  const { root, baseDir, workspace } = fixture();
  try {
    writeConfig(baseDir, {
      legacy_writer_enabled: false,
      legacy_reader_enabled: false,
    });
    const result = runHook('evaluate-session.js', {
      baseDir,
      cwd: workspace,
      env: { CLAUDE_SESSION_ID: `env-${SECRET}` },
      input: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: `payload-${SECRET}`,
        task_ref: 'task-conflict',
        timestamp: '2026-08-20T08:30:00.000Z',
      }),
    });
    assertFailOpenDiagnostic(result);
    assert.match(result.stderr, /session-identity-mismatch/);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe payload/managed session conflict exits zero before both writers and leaks no identity', () => {
  const { root, baseDir, workspace } = fixture('tp-observe-session-conflict-entry-');
  try {
    writeConfig(baseDir, {
      legacy_writer_enabled: true,
      legacy_reader_enabled: false,
    });
    const projectId = detectStableProjectIdentity(workspace).id;
    const result = runHook('observe.js', {
      args: ['post'],
      baseDir,
      cwd: workspace,
      env: {
        TP_SELF_LEARNING_PROJECT_ID: projectId,
        CLAUDE_SESSION_ID: `trusted-${SECRET}`,
      },
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tool-session-conflict-entry',
        session_id: `payload-${SECRET}`,
        cwd: workspace,
        tool_name: 'Read',
        tool_response: { ok: true },
      }),
    });
    assertFailOpenDiagnostic(result);
    assert.match(result.stderr, /session-identity-mismatch/);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
