#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyStopLearningPolicy,
  closeSelfLearningEpisode,
  loadSelfLearningConfig,
  main: evaluateMain,
  parseStopInvocation,
  readSessionObservations,
} = require('./evaluate-session');
const { detectProjectIdentity } = require('./lib/memory-v5');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const {
  DEFAULT_SELF_LEARNING_POLICY,
  filterCandidatesForContext,
  loadSelfLearningPolicy,
} = require('./lib/self-learning-service');
const {
  isLegacyReaderEnabled,
  isSelfLearningReaderEnabled,
  loadPromotedCandidateContext,
  main: injectMain,
  parseSessionStartInvocation,
  promotedCandidatesFromContextPayload,
  renderPromotedCandidateLines,
} = require('./inject-context');
const { isLegacyReaderEnabled: isPromptLegacyReaderEnabled } = require('./prompt-submit');
const { main: observeMain } = require('./observe');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function candidate(id, status, effectiveStatus = status, overrides = {}) {
  return {
    candidate_id: id,
    status,
    effective_status: effectiveStatus,
    kind: 'workflow',
    statement: { text: `statement ${id}`, fact_status: 'inference' },
    target: {
      key: `workflow.${id}`,
      source_path: `docs/workflow-${id}.md`,
      source_hash: `sha256:${'7'.repeat(64)}`,
    },
    scope: { level: 'project', id: 'project-demo' },
    promotion: status === 'promoted' ? { runtime_written: false } : null,
    retention: { expires_at: null, tombstoned: false },
    created_at: '2026-08-19T08:00:00.000Z',
    updated_at: '2026-08-19T08:00:00.000Z',
    ...overrides,
  };
}

test('authority config parses every governed field and rejects unknown or illegal values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-runtime-service-policy-'));
  try {
    assert.deepStrictEqual(loadSelfLearningPolicy(root), DEFAULT_SELF_LEARNING_POLICY);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      self_learning: {
        enabled: true,
        mode: 'shadow',
        writer_enabled: true,
        reader_enabled: true,
        promotion: 'manual',
        minimum_distinct_episodes: 4,
        minimum_truth_score: 0.9,
        minimum_value_score: 0.8,
        retention_days: 30,
        legacy_inputs: 'needs-review',
        legacy_writer_enabled: false,
        legacy_reader_enabled: false,
      },
    }));
    assert.deepStrictEqual(loadSelfLearningPolicy(root), {
      enabled: true,
      mode: 'shadow',
      writer_enabled: true,
      reader_enabled: true,
      promotion: 'manual',
      minimum_distinct_episodes: 4,
      minimum_truth_score: 0.9,
      minimum_value_score: 0.8,
      retention_days: 30,
      legacy_inputs: 'needs-review',
      legacy_writer_enabled: false,
      legacy_reader_enabled: false,
    });

    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      self_learning: { unknown_gate: true },
    }));
    assert.throws(() => loadSelfLearningPolicy(root), /unexpected.*unknown_gate/i);

    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      self_learning: { minimum_truth_score: 2 },
    }));
    assert.throws(() => loadSelfLearningPolicy(root), /minimum_truth_score/i);

    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      self_learning: { promotion: 'automatic' },
    }));
    assert.throws(() => loadSelfLearningPolicy(root), /promotion/i);

    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ self_learning: null }));
    assert.throws(() => loadSelfLearningPolicy(root), /must be an object/i);

    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify([]));
    assert.throws(() => loadSelfLearningPolicy(root), /root must be an object/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context filtering requires exact scope identity and rejects expired or malformed retention', () => {
  const now = '2026-08-20T08:00:00.000Z';
  const values = [
    candidate('project', 'promoted'),
    candidate('session', 'promoted', 'promoted', { scope: { level: 'session', id: 'session-demo' } }),
    candidate('task', 'promoted', 'promoted', { scope: { level: 'task', id: 'task-demo' } }),
    candidate('personal', 'promoted', 'promoted', { scope: { level: 'personal', id: 'person-demo' } }),
    candidate('global', 'promoted', 'promoted', { scope: { level: 'global', id: 'global-demo' } }),
    candidate('team', 'promoted', 'promoted', { scope: { level: 'team', id: 'team-demo' } }),
    candidate('wrong-session', 'promoted', 'promoted', { scope: { level: 'session', id: 'other' } }),
    candidate('expired', 'promoted', 'promoted', {
      retention: { expires_at: '2026-08-20T07:59:59.000Z', tombstoned: false },
    }),
    candidate('bad-expiry', 'promoted', 'promoted', {
      retention: { expires_at: 'not-a-time', tombstoned: false },
    }),
  ];
  const filtered = filterCandidatesForContext(values, {
    project_id: 'project-demo',
    session_id: 'session-demo',
    task_ref: 'task-demo',
    personal_id: 'person-demo',
    global_id: 'global-demo',
    team_id: 'team-demo',
    now,
  });
  assert.deepStrictEqual(filtered.map((item) => item.candidate_id), [
    'project', 'session', 'task', 'personal', 'global', 'team',
  ]);
  assert.deepStrictEqual(filterCandidatesForContext(values, {
    project_id: 'project-demo',
    now,
  }).map((item) => item.candidate_id), ['project']);
});

test('Stop evaluator defaults on and explicit false prevents all Stop-time learning writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-runtime-policy-'));
  try {
    assert.deepStrictEqual(loadSelfLearningConfig(root), DEFAULT_SELF_LEARNING_POLICY);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      self_learning: { enabled: false },
    }));
    assert.deepStrictEqual(loadSelfLearningConfig(root), {
      ...DEFAULT_SELF_LEARNING_POLICY,
      enabled: false,
    });

    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      self_learning: {},
      selfLearning: {},
    }));
    assert.throws(() => loadSelfLearningConfig(root), /configure self_learning only once/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer flag pauses authority writes without re-enabling legacy writers', () => {
  const forbidden = () => { throw new Error('writer called'); };
  const result = applyStopLearningPolicy(
    { baseDir: 'C:\\authority' },
    [{ domain: 'workflow', description: 'weak pattern' }],
    { name: 'demo' },
    { enabled: true, writer_enabled: false },
    {
      executeLearningAction: forbidden,
      createOrUpdateInstinct: forbidden,
      writeMemoryNotes: forbidden,
      decayInstincts: forbidden,
    }
  );
  assert.strictEqual(result.mode, 'self-learning');
  assert.deepStrictEqual(result.instinctResults, []);
  assert.strictEqual(result.episode.reason, 'self-learning-writer-disabled');
});

test('enabled Stop policy closes an episode but never writes legacy instinct or Memory truth', () => {
  const calls = [];
  const paths = {
    baseDir: 'C:\\authority',
    projectInstincts: 'legacy-project',
    projectMemory: 'legacy-memory',
    globalInstincts: 'legacy-global',
  };
  const forbidden = () => { throw new Error('legacy writer called'); };
  const result = applyStopLearningPolicy(
    paths,
    [{ domain: 'workflow', description: 'weak pattern' }],
    { id: 'legacy-id', name: 'demo' },
    { enabled: true },
    {
      sessionId: 'session-123',
      taskRef: 'task-123',
      occurredAt: '2026-08-20T08:00:00.000Z',
      cwd: 'C:\\repo',
      createOrUpdateInstinct: forbidden,
      writeMemoryNotes: forbidden,
      decayInstincts: forbidden,
      executeLearningAction(action, args) {
        calls.push({ action, args });
        return {
          result: {
            episode: {
              episode_id: 'behavior-episode:abc',
              revision: 1,
              status: 'needs_review',
            },
          },
        };
      },
    }
  );

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].action, 'close');
  assert.strictEqual(calls[0].args.input.session_id, 'session-123');
  assert.strictEqual(calls[0].args.input.task_ref, 'task-123');
  assert.deepStrictEqual(result.instinctResults, []);
  assert.deepStrictEqual(result.memoryResults, { created: 0, updated: 0, skipped: 0, indexed: 0 });
  assert.strictEqual(result.episode.persisted, true);
  assert.strictEqual(result.candidateInputs.status, 'needs-review');
  assert.strictEqual(result.candidateInputs.persisted, false);
});

test('missing stable session identity safely skips episode persistence', () => {
  const result = closeSelfLearningEpisode({ baseDir: 'C:\\authority' }, {
    sessionId: '',
    executeLearningAction() {
      throw new Error('must not be called');
    },
  });
  assert.deepStrictEqual(result, {
    status: 'needs-review',
    persisted: false,
    reason: 'missing-stable-session-id',
  });
});

test('missing task identity remains explicitly session-unassigned and does not close', () => {
  const result = closeSelfLearningEpisode({ baseDir: 'C:\\authority' }, {
    sessionId: 'session-123',
    taskRef: '',
    executeLearningAction() {
      throw new Error('must not be called');
    },
  });
  assert.deepStrictEqual(result, {
    status: 'needs-review',
    persisted: false,
    reason: 'session-unassigned',
  });
});

test('Stop payload owns session, task, and occurred-at identity while conflicts fail closed', () => {
  const parsed = parseStopInvocation(JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'payload-session',
    task_id: 'payload-task',
    occurred_at: '2026-08-20T08:00:00.000Z',
  }), {
    CLAUDE_SESSION_ID: 'payload-session',
  });
  assert.deepStrictEqual(parsed, {
    status: 'ready',
    sessionId: 'payload-session',
    taskRef: 'payload-task',
    occurredAt: '2026-08-20T08:00:00.000Z',
    payload: {
      hook_event_name: 'Stop',
      session_id: 'payload-session',
      task_id: 'payload-task',
      occurred_at: '2026-08-20T08:00:00.000Z',
    },
  });
  assert.deepStrictEqual(parseStopInvocation(JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'payload-secret-session',
    task_ref: 'task-123',
    timestamp: '2026-08-20T08:00:00.000Z',
  }), {
    CLAUDE_SESSION_ID: 'different-env-secret-session',
  }), {
    status: 'needs-review',
    reason: 'session-identity-mismatch',
  });
});

test('legacy observations are filtered by the explicit Stop session, never by env fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-stop-observations-'));
  const file = path.join(root, 'observations.jsonl');
  try {
    fs.writeFileSync(file, [
      JSON.stringify({ session_id: 'payload-session', timestamp: '2026-08-20T08:00:00.000Z' }),
      JSON.stringify({ session_id: 'env-session', timestamp: '2026-08-20T08:00:01.000Z' }),
      JSON.stringify({ timestamp: '2026-08-20T08:00:02.000Z' }),
    ].join('\n'));
    assert.deepStrictEqual(
      readSessionObservations(file, 'payload-session').map((item) => item.session_id),
      ['payload-session']
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disabled policy never falls back to legacy instinct, Memory, or decay writers', () => {
  const forbidden = () => { throw new Error('legacy writer called'); };
  const patterns = [{ domain: 'testing', description: 'legacy pattern' }];
  const result = applyStopLearningPolicy({
    projectInstincts: 'project-instincts',
    projectMemory: 'project-memory',
    globalInstincts: 'global-instincts',
  }, patterns, { name: 'demo' }, { enabled: false }, {
    createOrUpdateInstinct: forbidden,
    writeMemoryNotes: forbidden,
    decayInstincts: forbidden,
    executeLearningAction: forbidden,
  });
  assert.strictEqual(result.mode, 'disabled');
  assert.deepStrictEqual(result.instinctResults, []);
  assert.deepStrictEqual(result.memoryResults, { created: 0, updated: 0, skipped: 0, indexed: 0 });
  assert.strictEqual(result.episode.reason, 'self-learning-disabled');
  assert.strictEqual(result.candidateInputs, null);
});

test('SessionStart accepts only promoted effective candidates and ignores shadow suggestions', () => {
  const promoted = candidate('promoted', 'promoted');
  const payload = {
    result: {
      automatic_context: [
        promoted,
        candidate('shadow-in-auto', 'shadow'),
        candidate('tombstoned-promotion', 'promoted', 'needs-review'),
        candidate('approved', 'approved'),
      ],
      shadow_suggestions: [candidate('shadow', 'shadow')],
      policy: { shadow_auto_injection: false, runtime_write_performed: false },
    },
  };
  const before = JSON.stringify(promoted);
  assert.deepStrictEqual(
    promotedCandidatesFromContextPayload(payload, {
      project_id: 'project-demo',
      now: '2026-08-20T08:00:00.000Z',
    }).map((item) => item.candidate_id),
    ['promoted']
  );
  const lines = renderPromotedCandidateLines([promoted]);
  assert.strictEqual(lines.length, 1);
  assert(lines[0].includes('statement promoted'));
  assert.strictEqual(JSON.stringify(promoted), before, 'rendering must not mutate promotion metadata');
  assert.strictEqual(promoted.promotion.runtime_written, false);
});

test('SessionStart binds native payload session and managed task identity before context filtering', () => {
  assert.deepStrictEqual(parseSessionStartInvocation(JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: 'native-session-start',
    timestamp: '2026-08-20T08:00:00.000Z',
  }), {
    TP_SELF_LEARNING_TASK_REF: 'managed-task-start',
    CODEX_SESSION_ID: '',
    CLAUDE_SESSION_ID: '',
  }), {
    status: 'ready',
    payload: {
      hook_event_name: 'SessionStart',
      session_id: 'native-session-start',
      timestamp: '2026-08-20T08:00:00.000Z',
    },
    sessionId: 'native-session-start',
    taskRef: 'managed-task-start',
    now: '2026-08-20T08:00:00.000Z',
  });
  assert.deepStrictEqual(parseSessionStartInvocation(JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: 'native-session-start',
  }), {
    CLAUDE_SESSION_ID: 'different-parent-session',
  }), {
    status: 'error',
    reason: 'session-identity-mismatch',
  });
});

test('managed project authority rejects cross-project cwd for Stop and SessionStart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-runtime-project-authority-'));
  const baseDir = path.join(root, 'homunculus');
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(workspaceA, { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
    self_learning: {
      legacy_reader_enabled: false,
      legacy_writer_enabled: false,
    },
  }));
  const env = {
    TP_SELF_LEARNING_PROJECT_ID: detectStableProjectIdentity(workspaceA).id,
    TP_SELF_LEARNING_TASK_REF: 'task-project-authority',
  };
  const previousStderr = process.stderr.write;
  const previousLog = console.log;
  try {
    process.stderr.write = () => true;
    console.log = () => {};
    const stop = evaluateMain({
      baseDir,
      cwd: workspaceA,
      env,
      input: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'session-project-authority',
        cwd: workspaceB,
      }),
    });
    assert.deepStrictEqual(stop, {
      status: 'needs-review',
      reason: 'project-identity-mismatch',
    });
    const start = injectMain({
      baseDir,
      cwd: workspaceA,
      env,
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-project-authority',
        cwd: workspaceB,
      }),
    });
    assert.deepStrictEqual(start, {
      status: 'error',
      reason: 'project-identity-mismatch',
    });
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  } finally {
    process.stderr.write = previousStderr;
    console.log = previousLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SessionStart context reader fails closed and rechecks service output', () => {
  assert.deepStrictEqual(loadPromotedCandidateContext({
    baseDir: 'C:\\authority',
    executeLearningAction() { throw new Error('corrupt journal'); },
  }), []);

  const result = loadPromotedCandidateContext({
    baseDir: 'C:\\authority',
    cwd: 'C:\\repo',
    projectId: 'project-demo',
    sessionId: 'session-demo',
    now: '2026-08-20T08:00:00.000Z',
    executeLearningAction(action, args) {
      assert.strictEqual(action, 'context');
      assert.strictEqual(args.base_dir, 'C:\\authority');
      assert.strictEqual(args.input.session_id, 'session-demo');
      assert.strictEqual(args.input.now, '2026-08-20T08:00:00.000Z');
      return { result: { automatic_context: [candidate('ok', 'promoted'), candidate('no', 'evaluated')] } };
    },
  });
  assert.deepStrictEqual(result.map((item) => item.candidate_id), ['ok']);
});

test('reader flag disables governed Candidate injection without consulting the store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-runtime-reader-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      self_learning: { enabled: true, reader_enabled: false },
    }));
    assert.strictEqual(isSelfLearningReaderEnabled(root), false);
    assert.deepStrictEqual(loadPromotedCandidateContext({
      baseDir: root,
      executeLearningAction() { throw new Error('must not read store'); },
    }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy switches independently cover prompt recall, SessionStart compatibility, and observations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-runtime-legacy-switches-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      self_learning: {
        legacy_reader_enabled: false,
        legacy_writer_enabled: false,
      },
    }));
    assert.strictEqual(isLegacyReaderEnabled(root), false);
    assert.strictEqual(isPromptLegacyReaderEnabled(root), false);
    const result = observeMain({
      baseDir: root,
      cwd: root,
      input: '{}',
      observedAt: '2026-08-20T08:00:00.000Z',
    });
    assert.strictEqual(result.legacy.status, 'skipped');
    assert.strictEqual(result.legacy.reason, 'legacy-writer-disabled');
    assert.strictEqual(fs.existsSync(path.join(root, 'projects')), false);

    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      self_learning: { unexpected: true },
    }));
    assert.strictEqual(isLegacyReaderEnabled(root), false, 'invalid policy must fail closed');
    assert.strictEqual(isPromptLegacyReaderEnabled(root), false, 'invalid policy must fail closed');
    const invalid = observeMain({ baseDir: root, cwd: root, input: '{}' });
    assert.strictEqual(invalid.legacy.reason, 'invalid-policy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default Stop main leaves legacy instinct and Memory truth directories untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-runtime-main-'));
  const previousHome = process.env.TECH_PERSISTENCE_HOME;
  const previousSession = process.env.CLAUDE_SESSION_ID;
  const previousCodexSession = process.env.CODEX_SESSION_ID;
  const previousLog = console.log;
  const previousStderrWrite = process.stderr.write;
  try {
    process.env.TECH_PERSISTENCE_HOME = root;
    process.env.CLAUDE_SESSION_ID = 'session-runtime-policy';
    process.env.CODEX_SESSION_ID = 'session-runtime-policy';
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      self_learning: { enabled: true, writer_enabled: true },
      memory_v5: { enabled: true },
    }));
    const project = detectProjectIdentity();
    const projectDir = path.join(root, 'projects', project.id);
    fs.mkdirSync(projectDir, { recursive: true });
    const occurredAt = new Date().toISOString();
    const observations = [0, 1, 2].map((index) => JSON.stringify({
      session_id: 'session-runtime-policy',
      timestamp: occurredAt,
      phase: 'post',
      tool: 'Bash',
      command: 'npm test',
      status: 'success',
      output_summary: `ok ${index}`,
    }));
    fs.writeFileSync(path.join(projectDir, 'observations.jsonl'), `${observations.join('\n')}\n`);

    console.log = () => {};
    process.stderr.write = () => true;
    evaluateMain({
      input: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'session-runtime-policy',
        task_ref: 'task-runtime-policy',
        timestamp: occurredAt,
      }),
    });

    assert.strictEqual(fs.existsSync(path.join(projectDir, 'instincts')), false);
    assert.strictEqual(fs.existsSync(path.join(projectDir, 'memory')), false);
    assert.strictEqual(fs.existsSync(path.join(root, 'instincts', 'personal')), false);
    assert.strictEqual(fs.readdirSync(path.join(projectDir, 'sessions')).length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.TECH_PERSISTENCE_HOME;
    else process.env.TECH_PERSISTENCE_HOME = previousHome;
    if (previousSession === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = previousSession;
    if (previousCodexSession === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = previousCodexSession;
    console.log = previousLog;
    process.stderr.write = previousStderrWrite;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

if (process.exitCode) process.exit(process.exitCode);
console.log(`\nResults: ${passed} passed`);
