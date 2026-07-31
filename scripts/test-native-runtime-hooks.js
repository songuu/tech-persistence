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
  recordLifecycleEvidence,
} = require('./codex-lifecycle-evidence');

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

test('Codex registry adds only the four evidence-only lifecycle events', () => {
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
  assert.strictEqual(
    getCodexHookScriptNames().filter((name) => name === 'codex-lifecycle-evidence.js').length,
    1
  );

  const config = buildCodexPluginHookConfig();
  assert.strictEqual(config.hooks.PostCompact[0].matcher, 'manual|auto');
  assert.strictEqual(config.hooks.SessionEnd[0].matcher, 'other');
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
