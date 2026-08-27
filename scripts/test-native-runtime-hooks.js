#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CODEX_HOOKS,
  LIFECYCLE_EVIDENCE_EVENTS,
  buildCodexPluginHookConfig,
  getCodexHookScriptNames,
} = require('./lib/codex-hook-registry');
const {
  EVIDENCE_DIR_NAME,
  MAX_FIELD_CHARS,
  MAX_INPUT_BYTES,
  captureManagedLifecycle,
  deriveLifecycleSourceEventId,
  projectLifecycleBehavior,
  recordLifecycleBehavior,
  recordLifecycleEvidence,
} = require('./codex-lifecycle-evidence');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const {
  LIFECYCLE_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
  readJournal,
  resolveStoreDir,
} = require('./lib/self-learning-store');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function withRunDir(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-native-hooks-'));
  const runsRoot = path.join(root, '.agent-runs');
  const runDir = path.join(runsRoot, 'run-1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), '{"status":"running"}\n');
  try {
    fn({ root, runsRoot, runDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function hookPayload(event, overrides = {}) {
  return {
    session_id: 'thr_demo',
    turn_id: 'turn_demo',
    cwd: 'C:/workspace',
    hook_event_name: event,
    model: 'gpt-5.6-sol',
    permission_mode: 'default',
    ...overrides,
  };
}

function evidenceFiles(runDir) {
  const evidenceDir = path.join(runDir, EVIDENCE_DIR_NAME);
  if (!fs.existsSync(evidenceDir)) return [];
  return fs.readdirSync(evidenceDir).filter((name) => name.endsWith('.json')).sort();
}

function readOnlyRole(pathname, expectedName) {
  const source = fs.readFileSync(pathname, 'utf8');
  assert.match(source, new RegExp(`^name: ${expectedName}$`, 'm'));
  assert.match(source, /^tools: Read, Grep, Glob$/m);
  assert(!/\b(?:Bash|Edit|Write|NotebookEdit)\b/.test(
    source.split('---').slice(1, 2).join('')
  ), `${expectedName} frontmatter must not expose write-capable tools`);
  assert.match(source, /plugin root policy owns hooks, MCP, and permissions/i);
}

test('Codex registry keeps the four evidence-only lifecycle events alongside governed behavior hooks', () => {
  assert.deepStrictEqual(
    [...LIFECYCLE_EVIDENCE_EVENTS],
    ['SubagentStart', 'SubagentStop', 'PostCompact', 'SessionEnd']
  );
  const lifecycleHooks = CODEX_HOOKS.filter(
    (hook) => hook.script === 'codex-lifecycle-evidence.js'
  );
  assert.deepStrictEqual(
    lifecycleHooks.map((hook) => hook.event),
    [...LIFECYCLE_EVIDENCE_EVENTS]
  );
  assert(lifecycleHooks.every((hook) => hook.async === false));
  assert(lifecycleHooks.every((hook) => hook.timeout <= 3));
  assert(
    LIFECYCLE_RECEIPT_LOCK_RETRY_TIMEOUT_MS < Math.min(...lifecycleHooks.map((hook) => hook.timeout)) * 1000,
    'lifecycle receipt lock wait must fit inside the host hook timeout'
  );
  assert.strictEqual(
    getCodexHookScriptNames().filter((name) => name === 'codex-lifecycle-evidence.js').length,
    1
  );
  const transcriptOutboxHooks = CODEX_HOOKS.filter(
    (hook) => hook.script === 'codex-transcript-outbox.js'
  );
  assert.strictEqual(transcriptOutboxHooks.length, 1);
  assert.strictEqual(transcriptOutboxHooks[0].event, 'SessionEnd');
  assert.strictEqual(transcriptOutboxHooks[0].matcher, undefined);
  assert.strictEqual(lifecycleHooks.at(-1).matcher, undefined);
  assert.strictEqual(transcriptOutboxHooks[0].async, false);
  assert.strictEqual(transcriptOutboxHooks[0].timeout, 3);

  const config = buildCodexPluginHookConfig();
  assert.strictEqual(config.hooks.PostCompact[0].matcher, 'manual|auto');
  assert.strictEqual(config.hooks.SessionEnd[0].matcher, undefined);
  assert.strictEqual(config.hooks.SessionEnd.length, 1);
  assert.strictEqual(config.hooks.SessionEnd[0].hooks.length, 2);
  assert(
    config.hooks.SessionEnd[0].hooks.some(
      (hook) => hook.command.includes('/codex-hooks/codex-transcript-outbox.js')
        && hook.async === false
        && hook.timeout === 3
    )
  );
  for (const event of LIFECYCLE_EVIDENCE_EVENTS) {
    const serialized = JSON.stringify(config.hooks[event]);
    assert(serialized.includes('/codex-hooks/codex-lifecycle-evidence.js'));
    assert(!serialized.includes('run-hook.js'), `${event} must not double-spawn`);
    assert(!serialized.includes('"async":true'));
  }
});

test('missing explicit runDir is a no-op even when stdin payload names a path', () => {
  withRunDir(({ root, runDir }) => {
    const attackerChosen = path.join(root, '.agent-runs', 'attacker-chosen');
    const result = recordLifecycleEvidence(
      hookPayload('SubagentStart', {
        run_dir: attackerChosen,
        runDir: attackerChosen,
        agent_id: 'agent-1',
        agent_type: 'explorer',
      })
    );
    assert.deepStrictEqual(result, { status: 'noop', reason: 'missing-run-dir' });
    assert.deepStrictEqual(evidenceFiles(runDir), []);
    assert.strictEqual(fs.existsSync(attackerChosen), false);
  });
});

test('all supported lifecycle events append bounded evidence only inside runDir', () => {
  withRunDir(({ runDir }) => {
    const beforeState = fs.readFileSync(path.join(runDir, 'state.json'), 'utf8');
    const payloads = [
      hookPayload('SubagentStart', {
        agent_id: 'agent-1',
        agent_type: 'explorer',
      }),
      hookPayload('SubagentStop', {
        agent_id: 'agent-1',
        agent_type: 'explorer',
        agent_transcript_path: 'C:/secret/subagent.jsonl',
        last_assistant_message: 'sensitive transcript content',
        stop_hook_active: false,
      }),
      hookPayload('PostCompact', { trigger: 'auto' }),
      hookPayload('SessionEnd', { turn_id: undefined, reason: 'other' }),
    ];

    const results = payloads.map((payload) => recordLifecycleEvidence(payload, { runDir }));
    assert(results.every((result) => result.status === 'recorded'));
    assert.strictEqual(evidenceFiles(runDir).length, payloads.length);
    assert.strictEqual(
      fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'),
      beforeState,
      'evidence hook must not advance run state'
    );

    const evidenceDir = path.join(runDir, EVIDENCE_DIR_NAME);
    for (const result of results) {
      assert.strictEqual(path.dirname(result.file), evidenceDir);
      const raw = fs.readFileSync(result.file, 'utf8');
      const evidence = JSON.parse(raw);
      assert.strictEqual(evidence.kind, 'native-runtime-lifecycle');
      assert.strictEqual(evidence.runtime, 'codex');
      assert.strictEqual(evidence.idempotencyKey, path.basename(result.file, '.json'));
      assert(!raw.includes('sensitive transcript content'));
      assert(!raw.includes('C:/secret/subagent.jsonl'));
      assert(!raw.includes('"cwd"'));
      assert(Buffer.byteLength(raw, 'utf8') < 4096);
    }

    assert.deepStrictEqual(
      fs.readdirSync(runDir).sort(),
      [EVIDENCE_DIR_NAME, 'state.json'].sort(),
      'hook may only add its dedicated evidence directory'
    );
  });
});

test('replayed lifecycle event is idempotent and does not append a second file', () => {
  withRunDir(({ runDir }) => {
    const payload = hookPayload('SubagentStop', {
      agent_id: 'agent-1',
      agent_type: 'reviewer',
      stop_hook_active: false,
    });
    const first = recordLifecycleEvidence(payload, { runDir });
    const replay = recordLifecycleEvidence(
      { ...payload, last_assistant_message: 'ignored replay text' },
      { runDir }
    );
    assert.strictEqual(first.status, 'recorded');
    assert.strictEqual(replay.status, 'duplicate');
    assert.strictEqual(replay.idempotencyKey, first.idempotencyKey);
    assert.deepStrictEqual(evidenceFiles(runDir), [`${first.idempotencyKey}.json`]);
  });
});

test('tampered duplicate evidence artifact cannot change journal occurrence or source identity', () => {
  withRunDir(({ root, runDir }) => {
    const workspace = path.join(root, 'workspace');
    const baseDir = path.join(root, 'homunculus');
    fs.mkdirSync(workspace, { recursive: true });
    const project = detectStableProjectIdentity(workspace);
    const payload = hookPayload('SubagentStart', {
      cwd: workspace,
      agent_id: 'agent-authority-1',
      agent_type: 'worker',
    });
    const authority = {
      baseDir,
      projectId: project.id,
      cwd: workspace,
      taskRef: 'task-native-authority-001',
      sourceEventBase: 'managed-run:authority-001',
    };
    const receipt = recordLifecycleEvidence(payload, {
      runDir,
      recordedAt: '2026-08-20T06:03:00.000Z',
    });
    const first = projectLifecycleBehavior(payload, receipt, authority);
    assert.strictEqual(first.status, 'recorded');

    fs.writeFileSync(receipt.file, JSON.stringify({
      idempotencyKey: 'f'.repeat(64),
      recordedAt: '2099-01-01T00:00:00.000Z',
      event: 'SessionEnd',
    }));
    const duplicateArtifact = recordLifecycleEvidence(payload, { runDir });
    const replay = projectLifecycleBehavior(payload, duplicateArtifact, authority);
    assert.strictEqual(replay.status, 'duplicate');

    const records = readJournal(resolveStoreDir(baseDir, project.id)).records;
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].payload.occurred_at, '2026-08-20T06:03:00.000Z');
    assert.strictEqual(
      records[0].payload.source_event_id,
      deriveLifecycleSourceEventId(payload, authority)
    );
  });
});

test('tampered first-receipt artifact fails closed before any journal append', () => {
  withRunDir(({ root, runDir }) => {
    const workspace = path.join(root, 'workspace');
    const baseDir = path.join(root, 'homunculus');
    fs.mkdirSync(workspace, { recursive: true });
    const project = detectStableProjectIdentity(workspace);
    const payload = hookPayload('SessionEnd', { cwd: workspace, reason: 'other' });
    const receipt = recordLifecycleEvidence(payload, { runDir });
    fs.writeFileSync(receipt.file, JSON.stringify({
      idempotencyKey: '0'.repeat(64),
      recordedAt: '2099-01-01T00:00:00.000Z',
    }));
    const duplicate = recordLifecycleEvidence(payload, { runDir });
    assert.strictEqual(duplicate.status, 'duplicate');
    const result = projectLifecycleBehavior(payload, duplicate, {
      baseDir,
      projectId: project.id,
      cwd: workspace,
      taskRef: 'task-native-authority-002',
      sourceEventBase: 'managed-run:authority-002',
    });
    assert.deepStrictEqual(result, {
      status: 'error',
      reason: 'untrusted-evidence-receipt',
    });
    assert.strictEqual(readJournal(resolveStoreDir(baseDir, project.id)).records.length, 0);
  });
});

test('unsupported or oversized payloads fail open without writing evidence', () => {
  withRunDir(({ runDir }) => {
    assert.deepStrictEqual(
      recordLifecycleEvidence(hookPayload('Stop'), { runDir }),
      { status: 'noop', reason: 'unsupported-event' }
    );
    const oversized = hookPayload('SubagentStop', {
      agent_id: 'agent-1',
      agent_type: 'reviewer',
      last_assistant_message: 'x'.repeat(MAX_INPUT_BYTES + 1),
    });
    assert.deepStrictEqual(
      recordLifecycleEvidence(oversized, { runDir }),
      { status: 'noop', reason: 'payload-too-large' }
    );
    assert.deepStrictEqual(evidenceFiles(runDir), []);
  });
});

test('Codex lifecycle projects BehaviorEvent only with complete explicit identity', () => {
  withRunDir(({ root }) => {
    const baseDir = path.join(root, 'homunculus');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const project = detectStableProjectIdentity(workspace);
    const payload = hookPayload('SubagentStart', {
      cwd: workspace,
      agent_id: 'agent-1',
      agent_type: 'explorer',
    });
    const missing = recordLifecycleBehavior(payload, { baseDir });
    assert.deepStrictEqual(missing, {
      status: 'skipped',
      reason: 'missing-explicit-learning-identity',
    });
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);

    const context = {
      baseDir,
      projectId: project.id,
      cwd: workspace,
      taskRef: 'task-native-001',
      sourceEventBase: 'managed-run:run-001',
      occurredAt: '2026-08-20T06:04:00.000Z',
      evidenceIdempotencyKey: 'a'.repeat(64),
    };
    const first = recordLifecycleBehavior(payload, context);
    const replay = recordLifecycleBehavior(payload, context);
    assert.strictEqual(first.status, 'recorded');
    assert.strictEqual(replay.status, 'duplicate');
    const journal = readJournal(resolveStoreDir(baseDir, context.projectId));
    assert.strictEqual(journal.records.length, 1);
    const event = journal.records[0].payload;
    assert.strictEqual(event.runtime, 'codex');
    assert.strictEqual(event.source, 'codex_cli');
    assert.strictEqual(event.event_type, 'system.lifecycle');
    assert.strictEqual(event.session_id, payload.session_id);
    assert.strictEqual(event.task_ref, context.taskRef);
    assert.strictEqual(event.details.hook_event_name, 'SubagentStart');
    assert.strictEqual(event.source_event_id, deriveLifecycleSourceEventId(payload, context));

    const otherHook = hookPayload('PostCompact', { cwd: workspace, trigger: 'manual' });
    const otherContext = {
      ...context,
      occurredAt: '2026-08-20T06:04:01.000Z',
      evidenceIdempotencyKey: 'b'.repeat(64),
    };
    const other = recordLifecycleBehavior(otherHook, otherContext);
    assert.strictEqual(other.status, 'recorded');
    assert.notStrictEqual(other.event_id, first.event_id);
    assert.strictEqual(readJournal(resolveStoreDir(baseDir, context.projectId)).records.length, 2);

    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
      self_learning: {
        enabled: true,
        writer_enabled: false,
        reader_enabled: true,
        mode: 'shadow',
      },
    }));
    const disabled = recordLifecycleBehavior(payload, {
      ...context,
      sourceEventBase: 'managed-run:run-disabled-001',
      evidenceIdempotencyKey: 'c'.repeat(64),
    });
    assert.deepStrictEqual(disabled, { status: 'skipped', reason: 'writer-disabled' });
    assert.strictEqual(readJournal(resolveStoreDir(baseDir, context.projectId)).records.length, 2);
  });
});

test('Codex lifecycle explicit session mismatch is skipped instead of misattributed', () => {
  withRunDir(({ root }) => {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const project = detectStableProjectIdentity(workspace);
    const result = recordLifecycleBehavior(hookPayload('PostCompact', { cwd: workspace }), {
      baseDir: path.join(root, 'homunculus'),
      projectId: project.id,
      cwd: workspace,
      sessionId: 'different-session',
      taskRef: 'task-native-001',
      sourceEventBase: 'managed-run:run-002',
      occurredAt: '2026-08-20T06:04:01.000Z',
    });
    assert.deepStrictEqual(result, { status: 'skipped', reason: 'session-identity-mismatch' });
  });
});

test('managed lifecycle identity is verified before any run evidence or journal write', () => {
  withRunDir(({ root, runsRoot, runDir }) => {
    const workspace = path.join(root, 'workspace');
    const otherWorkspace = path.join(root, 'other-workspace');
    const baseDir = path.join(root, 'homunculus');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(otherWorkspace, { recursive: true });
    const project = detectStableProjectIdentity(workspace);
    const authority = {
      runDir,
      runsDir: runsRoot,
      baseDir,
      projectId: project.id,
      cwd: workspace,
      sessionId: 'managed-session',
      taskRef: 'task-native-preflight-001',
      sourceEventBase: 'managed-run:preflight-001',
    };

    const sessionMismatch = captureManagedLifecycle(
      hookPayload('PostCompact', { cwd: workspace, session_id: 'payload-session' }),
      authority
    );
    assert.deepStrictEqual(sessionMismatch, {
      status: 'skipped',
      reason: 'session-identity-mismatch',
      evidence: { status: 'skipped', reason: 'session-identity-mismatch' },
      behavior: { status: 'skipped', reason: 'session-identity-mismatch' },
    });
    assert.deepStrictEqual(evidenceFiles(runDir), []);
    assert.strictEqual(readJournal(resolveStoreDir(baseDir, project.id)).records.length, 0);

    const projectMismatch = captureManagedLifecycle(
      hookPayload('PostCompact', { cwd: otherWorkspace, session_id: 'managed-session' }),
      authority
    );
    assert.deepStrictEqual(projectMismatch, {
      status: 'error',
      reason: 'project-identity-mismatch',
      evidence: { status: 'skipped', reason: 'project-identity-mismatch' },
      behavior: { status: 'error', reason: 'project-identity-mismatch' },
    });
    assert.deepStrictEqual(evidenceFiles(runDir), []);
    assert.strictEqual(readJournal(resolveStoreDir(baseDir, project.id)).records.length, 0);
  });
});

test('evidence fields are allowlisted and individually bounded', () => {
  withRunDir(({ runDir }) => {
    const result = recordLifecycleEvidence(
      hookPayload('SubagentStart', {
        agent_id: 'a'.repeat(MAX_FIELD_CHARS + 50),
        agent_type: 'explorer',
        unknown: 'must-not-be-persisted',
      }),
      { runDir }
    );
    const evidence = JSON.parse(fs.readFileSync(result.file, 'utf8'));
    assert.strictEqual(evidence.refs.agentId.length, MAX_FIELD_CHARS);
    assert(!JSON.stringify(evidence).includes('must-not-be-persisted'));
  });
});

test('explicit runDir must be an absolute plain directory under the verified runs root', () => {
  withRunDir(({ root, runsRoot, runDir }) => {
    const payload = hookPayload('PostCompact', { trigger: 'manual' });
    assert.throws(
      () => recordLifecycleEvidence(payload, { runDir: 'relative/run' }),
      /absolute/i
    );
    assert.throws(
      () => recordLifecycleEvidence(payload, { runDir: root }),
      /\.agent-runs/
    );

    const customRunsRoot = path.join(root, 'custom-runs');
    const customRunDir = path.join(customRunsRoot, 'run-custom');
    fs.mkdirSync(customRunDir, { recursive: true });
    const customResult = recordLifecycleEvidence(payload, {
      runDir: customRunDir,
      runsDir: customRunsRoot,
    });
    assert.strictEqual(customResult.status, 'recorded');
    assert.strictEqual(path.dirname(path.dirname(customResult.file)), customRunDir);
    assert.throws(
      () => recordLifecycleEvidence(payload, { runDir: customRunDir, runsDir: runsRoot }),
      /directly under explicit runsDir/
    );

    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const evidenceDir = path.join(runDir, EVIDENCE_DIR_NAME);
    try {
      fs.symlinkSync(outside, evidenceDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
      throw error;
    }
    assert.throws(
      () => recordLifecycleEvidence(payload, { runDir }),
      /symbolic link|junction|plain directory/i
    );
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });
});

test('Codex native roles enforce read-only exploration/review and workspace-write implementation', () => {
  const agentsRoot = path.join(__dirname, '..', 'codex-native', 'agents');
  const explorer = fs.readFileSync(path.join(agentsRoot, 'explorer.toml'), 'utf8');
  const implementer = fs.readFileSync(path.join(agentsRoot, 'implementer.toml'), 'utf8');
  const reviewer = fs.readFileSync(path.join(agentsRoot, 'reviewer.toml'), 'utf8');
  assert.match(explorer, /^sandbox_mode = "read-only"$/m);
  assert.match(reviewer, /^sandbox_mode = "read-only"$/m);
  assert.match(implementer, /^sandbox_mode = "workspace-write"$/m);
  for (const source of [explorer, implementer, reviewer]) {
    assert.match(source, /^developer_instructions = """/m);
    assert(!source.includes('danger-full-access'));
  }
});

test('Claude native roles use the user-level agent source and keep policy at plugin root', () => {
  const agentsRoot = path.join(__dirname, '..', 'user-level', 'agents');
  readOnlyRole(path.join(agentsRoot, 'claude-explorer.md'), 'claude-explorer');
  readOnlyRole(path.join(agentsRoot, 'claude-reviewer.md'), 'claude-reviewer');

  const implementer = fs.readFileSync(
    path.join(agentsRoot, 'claude-implementer.md'),
    'utf8'
  );
  assert.match(implementer, /^name: claude-implementer$/m);
  assert.match(implementer, /^tools: Read, Grep, Glob, Edit, Write, Bash$/m);
  assert.match(implementer, /plugin root policy owns hooks, MCP, and permissions/i);
});

if (process.exitCode) process.exit(process.exitCode);
console.log(`\nResults: ${passed} passed, 0 failed`);
