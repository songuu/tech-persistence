#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { capturePromptBehavior } = require('./prompt-submit');
const { captureToolBehavior, main: observeMain } = require('./observe');
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
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

function withTempProject(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-hook-capture-'));
  const workspace = path.join(root, 'workspace');
  const baseDir = path.join(root, 'homunculus');
  fs.mkdirSync(workspace, { recursive: true });
  try {
    fn({ root, workspace, baseDir, project: detectStableProjectIdentity(workspace) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function journalFor(baseDir, projectId) {
  return readJournal(resolveStoreDir(baseDir, projectId));
}

test('prompt hook writes a redacted idempotent BehaviorEvent without changing recall output', () => {
  withTempProject(({ workspace, baseDir, project }) => {
    const payload = {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-001',
      session_id: 'session-001',
      timestamp: '2026-08-20T06:00:00.000Z',
      cwd: workspace,
      prompt: `Use the validator with glpat-${'S'.repeat(24)}`,
    };
    const first = capturePromptBehavior(payload, {
      baseDir,
      project,
      taskRef: 'task-managed-prompt',
    });
    const replay = capturePromptBehavior(payload, {
      baseDir,
      project,
      taskRef: 'task-managed-prompt',
    });

    assert.strictEqual(first.status, 'recorded');
    assert.strictEqual(replay.status, 'duplicate');
    const journal = journalFor(baseDir, project.id);
    assert.strictEqual(journal.records.length, 1);
    assert.strictEqual(journal.records[0].record_type, 'behavior_event');
    assert.strictEqual(journal.records[0].payload.event_type, 'user.prompt');
    assert.strictEqual(journal.records[0].payload.task_ref, 'task-managed-prompt');
    assert.strictEqual(journal.records[0].payload.signal_strength, 'explicit');
    assert.notStrictEqual(journal.records[0].payload.occurred_at, payload.timestamp);
    assert(!JSON.stringify(journal).includes(`glpat-${'S'.repeat(24)}`));
  });
});

test('prompt receipt skips missing or unsafe transcript identity without journal writes', () => {
  withTempProject(({ root, workspace, baseDir, project }) => {
    const missing = capturePromptBehavior({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-unsafe',
      cwd: workspace,
      prompt: 'missing transcript identity',
    }, { baseDir, project, cwd: workspace });
    assert.deepStrictEqual(missing, { status: 'skipped', reason: 'untrusted-transcript' });

    const transcriptPath = path.join(root, 'session-unsafe.jsonl');
    const hardlinkPath = path.join(root, 'session-unsafe-hardlink.jsonl');
    fs.writeFileSync(transcriptPath, '{"type":"assistant"}\n');
    fs.linkSync(transcriptPath, hardlinkPath);
    const linked = capturePromptBehavior({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-unsafe',
      transcript_path: transcriptPath,
      cwd: workspace,
      prompt: 'hardlinked transcript identity',
    }, { baseDir, project, cwd: workspace });
    assert.deepStrictEqual(linked, { status: 'skipped', reason: 'untrusted-transcript' });
    assert.strictEqual(journalFor(baseDir, project.id).records.length, 0);
  });
});

test('prompt transcript cursor reads only a bounded tail', () => {
  withTempProject(({ root, workspace, baseDir, project }) => {
    const transcriptPath = path.join(root, 'session-bounded.jsonl');
    fs.writeFileSync(transcriptPath, 'x'.repeat(256 * 1024));
    const originalReadSync = fs.readSync;
    let maximumRead = 0;
    fs.readSync = (descriptor, buffer, offset, length, position) => {
      maximumRead = Math.max(maximumRead, length);
      return originalReadSync(descriptor, buffer, offset, length, position);
    };
    try {
      const result = capturePromptBehavior({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-bounded',
        transcript_path: transcriptPath,
        cwd: workspace,
        prompt: 'bounded transcript tail',
      }, { baseDir, project, cwd: workspace });
      assert.strictEqual(result.status, 'recorded');
      assert(maximumRead > 0 && maximumRead <= 64 * 1024, `unexpected read size: ${maximumRead}`);
    } finally {
      fs.readSync = originalReadSync;
    }
  });
});

test('prompt transcript replacement during bounded read is rejected before journal write', () => {
  withTempProject(({ root, workspace, baseDir, project }) => {
    const transcriptPath = path.join(root, 'session-replaced.jsonl');
    fs.writeFileSync(transcriptPath, '{"type":"assistant"}\n');
    const originalFstatSync = fs.fstatSync;
    let calls = 0;
    fs.fstatSync = (descriptor) => {
      const stat = originalFstatSync(descriptor);
      calls += 1;
      if (calls !== 2) return stat;
      return new Proxy(stat, {
        get(target, property) {
          if (property === 'size') return target.size + 1;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    try {
      const result = capturePromptBehavior({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-replaced',
        transcript_path: transcriptPath,
        cwd: workspace,
        prompt: 'replacement race must fail closed',
      }, { baseDir, project, cwd: workspace });
      assert.deepStrictEqual(result, { status: 'skipped', reason: 'untrusted-transcript' });
      assert.strictEqual(journalFor(baseDir, project.id).records.length, 0);
    } finally {
      fs.fstatSync = originalFstatSync;
    }
  });
});

test('prompt payload session cannot override trusted hook session identity', () => {
  withTempProject(({ workspace, baseDir, project }) => {
    const result = capturePromptBehavior({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-session-mismatch',
      session_id: 'payload-session',
      cwd: workspace,
      prompt: 'must not cross session authority',
    }, {
      baseDir,
      project,
      cwd: workspace,
      env: { CLAUDE_SESSION_ID: 'trusted-session' },
    });
    assert.deepStrictEqual(result, { status: 'error', reason: 'session-identity-mismatch' });
    assert.strictEqual(journalFor(baseDir, project.id).records.length, 0);
  });
});

test('official prompt payload without id/time uses a journal-owned replay receipt', () => {
  withTempProject(({ root, workspace, baseDir, project }) => {
    const transcriptPath = path.join(root, 'session-001.jsonl');
    fs.writeFileSync(transcriptPath, '{"type":"assistant","message":"before first prompt"}\n');
    const official = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-001',
      transcript_path: transcriptPath,
      cwd: workspace,
      prompt: 'same prompt',
    };
    const first = capturePromptBehavior(official, { baseDir, project, cwd: workspace });
    const replay = capturePromptBehavior(official, { baseDir, project, cwd: workspace });

    assert.strictEqual(first.status, 'recorded');
    assert.strictEqual(replay.status, 'duplicate');
    let journal = journalFor(baseDir, project.id);
    assert.strictEqual(journal.records.length, 1);
    const firstEvent = journal.records[0].payload;
    assert.match(firstEvent.occurred_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(firstEvent.details.prompt_receipt.occurrence, 1);
    assert.match(firstEvent.details.prompt_receipt.transcript_ref, /^sha256:[a-f0-9]{64}$/);
    assert.match(firstEvent.details.prompt_receipt.replay_ref, /^sha256:[a-f0-9]{64}$/);
    assert(!firstEvent.source_event_id.includes('same prompt'));
    assert(!JSON.stringify(firstEvent.details.prompt_receipt).includes(transcriptPath));

    // The transcript cursor, not prompt text or wall time, distinguishes a
    // later turn that repeats the exact same text.
    fs.appendFileSync(transcriptPath, '{"type":"assistant","message":"turn complete"}\n');
    const nextTurn = capturePromptBehavior(official, { baseDir, project, cwd: workspace });
    assert.strictEqual(nextTurn.status, 'recorded');
    journal = journalFor(baseDir, project.id);
    assert.strictEqual(journal.records.length, 2);
    assert.notStrictEqual(journal.records[1].payload.event_id, firstEvent.event_id);
    assert.strictEqual(journal.records[1].payload.details.prompt_receipt.occurrence, 2);
  });
});

test('same prompt receipt cursor with different semantics conflicts and preserves first truth', () => {
  withTempProject(({ root, workspace, baseDir, project }) => {
    const transcriptPath = path.join(root, 'session-conflict.jsonl');
    fs.writeFileSync(transcriptPath, '{"type":"assistant"}\n');
    const payload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-conflict',
      transcript_path: transcriptPath,
      cwd: workspace,
      prompt: 'first semantic value',
    };
    assert.strictEqual(
      capturePromptBehavior(payload, { baseDir, project, cwd: workspace }).status,
      'recorded'
    );
    assert.deepStrictEqual(capturePromptBehavior({
      ...payload,
      prompt: 'different semantic value',
    }, { baseDir, project, cwd: workspace }), {
      status: 'error',
      reason: 'capture-failed',
    });
    const records = journalFor(baseDir, project.id).records;
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].payload.details.summary, 'first semantic value');
  });
});

test('same native prompt id with different semantics conflicts and preserves first truth', () => {
  withTempProject(({ workspace, baseDir, project }) => {
    const payload = {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-conflict-001',
      session_id: 'session-001',
      cwd: workspace,
      prompt: 'first semantic value',
    };
    const first = capturePromptBehavior(payload, { baseDir, project, cwd: workspace });
    const conflict = capturePromptBehavior({
      ...payload,
      prompt: 'different semantic value',
    }, { baseDir, project, cwd: workspace });
    assert.strictEqual(first.status, 'recorded');
    assert.deepStrictEqual(conflict, { status: 'error', reason: 'capture-failed' });
    const records = journalFor(baseDir, project.id).records;
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].payload.details.summary, 'first semantic value');
  });
});

test('prompt capture failure is reported but never thrown into the hook host', () => {
  withTempProject(({ root, project }) => {
    const invalidBase = path.join(root, 'not-a-directory');
    fs.writeFileSync(invalidBase, 'occupied');
    const result = capturePromptBehavior({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-001',
      session_id: 'session-001',
      timestamp: '2026-08-20T06:00:00.000Z',
      prompt: 'record me',
    }, { baseDir: invalidBase, project });
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.reason, 'capture-failed');
  });
});

test('tool hook pre/post dual-write unified events with stable parent lineage', () => {
  withTempProject(({ workspace, baseDir, project }) => {
    const prePayload = {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tool-use-001',
      session_id: 'session-001',
      timestamp: '2026-08-20T06:01:00.000Z',
      cwd: workspace,
      tool_name: 'Write',
      tool_input: { file_path: 'scripts/example.js' },
    };
    const postPayload = {
      ...prePayload,
      hook_event_name: 'PostToolUse',
      timestamp: '2026-08-20T06:01:01.000Z',
      tool_response: { ok: true },
      success: true,
    };
    const pre = captureToolBehavior(prePayload, 'pre', {
      baseDir,
      project,
      taskRef: 'task-managed-tool',
    });
    const post = captureToolBehavior(postPayload, 'post', {
      baseDir,
      project,
      taskRef: 'task-managed-tool',
    });

    assert.strictEqual(pre.status, 'recorded');
    assert.strictEqual(post.status, 'recorded');
    const records = journalFor(baseDir, project.id).records;
    assert.deepStrictEqual(records.map((record) => record.payload.event_type), ['tool.request', 'tool.result']);
    assert.strictEqual(records[1].payload.parent_event_id, records[0].payload.event_id);
    assert(records.every((record) => record.payload.task_ref === 'task-managed-tool'));
    assert.strictEqual(records[1].payload.status, 'succeeded');
  });
});

test('official tool payload without timestamp is replay-stable at journal receipt time', () => {
  withTempProject(({ workspace, baseDir, project }) => {
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tool-receipt-001',
      session_id: 'session-001',
      cwd: workspace,
      tool_name: 'Read',
      tool_response: { ok: true },
      success: true,
    };
    const first = captureToolBehavior(payload, 'post', {
      baseDir, project, cwd: workspace,
    });
    const replay = captureToolBehavior(payload, 'post', {
      baseDir, project, cwd: workspace,
    });
    assert.strictEqual(first.status, 'recorded');
    assert.strictEqual(replay.status, 'duplicate');
    assert.strictEqual(journalFor(baseDir, project.id).records.length, 1);
  });
});

test('managed project identity rejects payload cwd from another project', () => {
  withTempProject(({ root, workspace, baseDir, project }) => {
    const otherWorkspace = path.join(root, 'other-workspace');
    fs.mkdirSync(otherWorkspace, { recursive: true });
    const result = capturePromptBehavior({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-cross-project-001',
      session_id: 'session-001',
      cwd: otherWorkspace,
      prompt: 'must not cross project authority',
    }, {
      baseDir,
      cwd: workspace,
      projectId: project.id,
    });
    assert.deepStrictEqual(result, { status: 'error', reason: 'project-identity-mismatch' });
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  });
});

test('observe rejects an oversized payload before legacy or journal writes', () => {
  withTempProject(({ workspace, baseDir }) => {
    const result = observeMain({
      phase: 'post',
      baseDir,
      cwd: workspace,
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tool-oversized-001',
        session_id: 'session-001',
        cwd: workspace,
        tool_name: 'Read',
        tool_response: 'x'.repeat(65 * 1024),
      }),
    });
    assert.deepStrictEqual(result, {
      legacy: { status: 'error', reason: 'hook-payload-too-large' },
      self_learning: { status: 'error', reason: 'hook-payload-too-large' },
    });
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  });
});

test('observe managed session mismatch fails open before legacy or unified writes', () => {
  withTempProject(({ workspace, baseDir, project }) => {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
      self_learning: {
        enabled: true,
        writer_enabled: true,
        reader_enabled: false,
        mode: 'shadow',
        legacy_writer_enabled: true,
        legacy_reader_enabled: false,
      },
    }));
    const result = observeMain({
      phase: 'post',
      baseDir,
      cwd: workspace,
      projectId: project.id,
      sessionId: 'trusted-managed-session',
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tool-session-conflict-001',
        session_id: 'payload-session',
        cwd: workspace,
        tool_name: 'Read',
        tool_response: { ok: true },
      }),
    });
    assert.deepStrictEqual(result, {
      legacy: { status: 'error', reason: 'session-identity-mismatch' },
      self_learning: { status: 'error', reason: 'session-identity-mismatch' },
    });
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  });
});

test('observe main preserves legacy observation while adding the unified journal write', () => {
  withTempProject(({ workspace, baseDir, project }) => {
    const previousCwd = process.cwd();
    const previousHome = process.env.TECH_PERSISTENCE_HOME;
    process.chdir(workspace);
    process.env.TECH_PERSISTENCE_HOME = baseDir;
    try {
      const result = observeMain({
        phase: 'pre',
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_use_id: 'tool-use-legacy-001',
          session_id: 'session-legacy-001',
          timestamp: '2026-08-20T06:02:00.000Z',
          cwd: workspace,
          tool_name: 'Read',
          tool_input: { file_path: 'README.md' },
        }),
      });
      assert.strictEqual(result.legacy.status, 'recorded');
      assert.strictEqual(result.self_learning.status, 'recorded');
      assert.strictEqual(journalFor(baseDir, project.id).records.length, 1);
      const observations = fs.readdirSync(path.join(baseDir, 'projects'), { recursive: true })
        .filter((entry) => String(entry).endsWith('observations.jsonl'));
      assert.strictEqual(observations.length, 1);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.TECH_PERSISTENCE_HOME;
      else process.env.TECH_PERSISTENCE_HOME = previousHome;
    }
  });
});

test('tool hook skips the unified write without a native tool_use_id', () => {
  withTempProject(({ baseDir, project }) => {
    const result = captureToolBehavior({
      hook_event_name: 'PostToolUse',
      session_id: 'session-001',
      timestamp: '2026-08-20T06:03:00.000Z',
      tool_name: 'Read',
      tool_response: { ok: true },
    }, 'post', { baseDir, project });
    assert.deepStrictEqual(result, { status: 'skipped', reason: 'missing-source-event-id' });
    assert.strictEqual(journalFor(baseDir, project.id).records.length, 0);
  });
});

test('hook capture honors the shared writer kill switch without blocking legacy paths', () => {
  withTempProject(({ baseDir, project }) => {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
      self_learning: {
        enabled: true,
        writer_enabled: false,
        reader_enabled: true,
        mode: 'shadow',
      },
    }));
    const result = capturePromptBehavior({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-disabled-001',
      session_id: 'session-001',
      timestamp: '2026-08-20T06:05:00.000Z',
      prompt: 'This should be safely skipped.',
    }, { baseDir, project });
    assert.deepStrictEqual(result, { status: 'skipped', reason: 'writer-disabled' });
    assert.strictEqual(fs.existsSync(path.join(baseDir, 'projects')), false);
  });
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
