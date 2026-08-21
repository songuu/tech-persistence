#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  adaptClaudeHookEvent,
  adaptExplicitBehaviorEvent,
  adaptLegacyObservation,
  adaptManagedRuntimeEvent,
  buildManagedRuntimeEvidenceRefs,
  journalActorForEvent,
} = require('./lib/behavior-events');

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

const NOW = '2026-08-20T04:00:00.000Z';
const PROJECT = 'project-abc';
const SESSION = 'session-abc';

test('Claude UserPromptSubmit is an explicit prompt, not inferred feedback', () => {
  const event = adaptClaudeHookEvent({
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-001',
    session_id: SESSION,
    prompt: 'Please inspect the repository first.',
  }, { project_id: PROJECT, occurred_at: NOW });
  assert.strictEqual(event.runtime, 'claude');
  assert.strictEqual(event.event_type, 'user.prompt');
  assert.strictEqual(event.signal_strength, 'explicit');
  assert.strictEqual(event.source_assurance, 'observed');
  assert.notStrictEqual(event.event_type, 'user.feedback');
});

test('Claude tool pre/post events share source lineage and post points to pre', () => {
  const pre = adaptClaudeHookEvent({
    hook_event_name: 'PreToolUse',
    tool_use_id: 'tool-use-001',
    session_id: SESSION,
    tool_name: 'Write',
    tool_input: { file_path: 'scripts/example.js' },
  }, { project_id: PROJECT, task_ref: 'task-abc', occurred_at: NOW });
  const post = adaptClaudeHookEvent({
    hook_event_name: 'PostToolUse',
    tool_use_id: 'tool-use-001',
    session_id: SESSION,
    tool_name: 'Write',
    tool_input: { file_path: 'scripts/example.js' },
    tool_response: { ok: true },
    success: true,
  }, { project_id: PROJECT, task_ref: 'task-abc', occurred_at: '2026-08-20T04:00:01.000Z' });
  assert.strictEqual(pre.event_type, 'tool.request');
  assert.strictEqual(post.event_type, 'tool.result');
  assert.strictEqual(post.parent_event_id, pre.event_id);
  assert.strictEqual(post.status, 'succeeded');
  assert.strictEqual(post.final_disposition, 'unknown');
});

test('Claude adapter fails closed without stable identity or a real registered hook', () => {
  assert.throws(() => adaptClaudeHookEvent({
    hook_event_name: 'UserPromptSubmit', session_id: SESSION, prompt: 'same content',
  }, { project_id: PROJECT, occurred_at: NOW }), /source|stable/i);
  assert.throws(() => adaptClaudeHookEvent({
    hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Write', tool_input: {},
  }, { project_id: PROJECT, occurred_at: NOW }), /source|stable/i);
  assert.throws(() => adaptClaudeHookEvent({
    hook_event_name: 'PermissionRequest', request_id: 'request-1', session_id: SESSION,
  }, { project_id: PROJECT, occurred_at: NOW }), /unsupported/i);
});

test('standalone Codex requires a stable native source and rejects MCP self-asserted correction', () => {
  assert.throws(() => adaptExplicitBehaviorEvent({
    source_event_id: 'codex-mcp-self-report-001',
    occurred_at: NOW,
    project_id: PROJECT,
    session_id: SESSION,
    task_ref: null,
    actor: { kind: 'user', id: 'user', role: null },
    runtime: 'codex',
    source: 'codex_mcp',
    event_type: 'user.correction',
    status: 'observed',
    final_disposition: 'superseded',
    fact_status: 'fact',
    details: { summary: 'Untrusted self-report.' },
    evidence_refs: [],
  }), /cannot assert explicit/i);
  const event = adaptExplicitBehaviorEvent({
    source_event_id: 'codex-explicit-001',
    occurred_at: NOW,
    project_id: PROJECT,
    session_id: SESSION,
    task_ref: null,
    actor: { kind: 'user', id: 'user', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    event_type: 'user.correction',
    status: 'observed',
    final_disposition: 'superseded',
    fact_status: 'fact',
    details: { summary: 'Do not treat missing hooks as observed evidence.' },
    evidence_refs: [],
  });
  assert.strictEqual(event.source_assurance, 'explicit');
  assert.strictEqual(event.signal_strength, 'explicit');
  assert.strictEqual(event.task_ref, null);
  assert.throws(() => adaptExplicitBehaviorEvent({
    occurred_at: NOW,
    project_id: PROJECT,
    session_id: SESSION,
    actor: { kind: 'user', id: 'user', role: null },
    runtime: 'codex',
    event_type: 'user.feedback',
  }), /source_event_id/i);
});

function managedInput(overrides = {}) {
  const taskHash = `sha256:${'1'.repeat(64)}`;
  const base = {
    occurred_at: NOW,
    project_id: PROJECT,
    session_id: SESSION,
    task: {
      ref: 'task-abc', hash: taskHash, idempotencyKey: `idem:${'3'.repeat(64)}`,
    },
    result: {
      ref: 'result-abc',
      hash: `sha256:${'2'.repeat(64)}`,
      idempotencyKey: `idem:${'4'.repeat(64)}`,
      taskRef: 'task-abc',
      taskHash,
      taskIdempotencyKey: `idem:${'3'.repeat(64)}`,
      providerRef: 'codex:exec',
      status: 'succeeded',
      effects: { state: 'committed', refs: ['diff:abc'] },
      runtimeRefs: { codexThread: 'thread-abc', codexTurn: 'turn-abc' },
      native: {
        runtime: 'codex', adapter: 'codex-exec', nativeAccepted: true,
        terminalEvent: 'turn.completed', terminalStatus: 'completed', acceptanceErrors: [],
      },
    },
    acceptance: { accepted: true, errors: [], fallbackAllowed: false },
  };
  return {
    ...base,
    ...overrides,
    task: { ...base.task, ...(overrides.task || {}) },
    result: { ...base.result, ...(overrides.result || {}) },
    acceptance: { ...base.acceptance, ...(overrides.acceptance || {}) },
  };
}

test('managed result binds typed refs without claiming user approval', () => {
  const input = managedInput();
  const evidence = buildManagedRuntimeEvidenceRefs(input);
  const event = adaptManagedRuntimeEvent(input);
  assert.strictEqual(event.source_assurance, 'verified');
  assert.strictEqual(event.event_type, 'task.result');
  assert.strictEqual(event.final_disposition, 'accepted');
  assert.strictEqual(event.fact_status, 'fact');
  assert.strictEqual(event.details.user_approved, false);
  assert.deepStrictEqual(evidence.map((ref) => ref.source_type), [
    'task_envelope', 'result_envelope', 'acceptance_receipt',
  ]);
  assert(evidence.every((ref) => ref.signal_strength === 'weak'));
  assert.deepStrictEqual(event.evidence_refs, evidence.map((ref) => ref.evidence_id).sort());
  assert.strictEqual(journalActorForEvent(event).authority_ref, event.source_event_id);
});

test('managed adapter rejects mismatch and keeps unaccepted success unknown', () => {
  const unknown = adaptManagedRuntimeEvent(managedInput({
    result: {
      native: {
        runtime: 'codex', adapter: 'codex-exec', nativeAccepted: false,
        terminalEvent: null, terminalStatus: null, acceptanceErrors: ['missing terminal'],
      },
    },
    acceptance: { accepted: false, errors: ['native evidence rejected'] },
  }));
  assert.strictEqual(unknown.final_disposition, 'unknown');
  assert.strictEqual(unknown.fact_status, 'unknown');
  assert.throws(() => adaptManagedRuntimeEvent(managedInput({
    result: { taskRef: 'other-task' },
  })), /task.*mismatch|belong/i);
});

test('permission mode and system acceptance never synthesize user approval', () => {
  const event = adaptManagedRuntimeEvent(managedInput({ permission_mode: 'full-auto' }));
  assert.notStrictEqual(event.event_type, 'user.approval');
  assert.strictEqual(event.details.user_approved, false);
  assert.strictEqual(event.signal_strength, 'weak');
});

test('legacy observation stays weak, unknown, and legacy-unverified', () => {
  const event = adaptLegacyObservation({
    schema_version: '5.0', timestamp: NOW, phase: 'post', session_id: SESSION,
    project: { id: PROJECT }, runtime: 'auto', tool: 'Write',
    input_summary: '{"file":"scripts/example.js"}', output_summary: 'ok', status: 'success',
  }, { source_event_id: 'legacy-line-001' });
  assert.strictEqual(event.source_assurance, 'legacy_unverified');
  assert.strictEqual(event.signal_strength, 'weak');
  assert.strictEqual(event.fact_status, 'unknown');
  assert.strictEqual(event.final_disposition, 'unknown');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
