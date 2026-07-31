#!/usr/bin/env node
'use strict';

const assert = require('assert');
const adapters = require('./agent-orchestrator/runtime-adapters');

const launch = {
  command: 'claude',
  argsPrefix: [],
  requested: 'claude',
  shell: false,
};

const printInvocation = adapters.buildClaudeInvocation({
  launch,
  cwd: 'C:\\repo',
  prompt: 'Produce a spec',
  schemaJson: '{"type":"object"}',
  mode: 'print',
});
assert.strictEqual(printInvocation.adapter, 'claude-print');
assert.deepStrictEqual(printInvocation.args.slice(0, 5), [
  '-p', '--input-format', 'text', '--output-format', 'json',
]);
assert(!printInvocation.args.includes('--bare'));
assert.strictEqual(printInvocation.env.TECH_PERSISTENCE_MANAGED_RUN, '1');
assert.strictEqual(printInvocation.env.TECH_PERSISTENCE_RUNTIME, 'claude');
assert.strictEqual(printInvocation.env.TECH_PERSISTENCE_MEMORY_WRITE_OWNER, 'control');

const bareInvocation = adapters.buildClaudeInvocation({
  launch,
  cwd: 'C:\\repo',
  prompt: 'Review a diff',
  schemaJson: '{"type":"object"}',
  mode: 'bare',
  pluginDir: 'C:\\plugin',
  settings: 'C:\\policy.json',
});
assert.strictEqual(bareInvocation.adapter, 'claude-bare');
assert.strictEqual(bareInvocation.args[0], '--bare');
assert(bareInvocation.args.includes('--plugin-dir'));
assert(bareInvocation.args.includes('--settings'));

const resumedClaudeInvocation = adapters.buildClaudeInvocation({
  launch,
  cwd: 'C:\\repo',
  prompt: 'Resume the same failed spec attempt',
  mode: 'print',
  sessionId: 'claude-session-resume',
});
assert.deepStrictEqual(
  resumedClaudeInvocation.args.slice(-2),
  ['--resume', 'claude-session-resume']
);

const hookEventInvocation = adapters.buildClaudeInvocation({
  launch,
  cwd: 'C:\\repo',
  prompt: 'Emit lifecycle evidence',
  mode: 'print',
  includeHookEvents: true,
});
assert.strictEqual(
  hookEventInvocation.args.filter((arg) => arg === '--output-format').length,
  1
);
assert(hookEventInvocation.args.includes('stream-json'));

const claudeResult = adapters.normalizeClaudeOutput(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'claude-session-1',
  structured_output: { decision: 'approved' },
  usage: { input_tokens: 10, output_tokens: 4 },
  total_cost_usd: 0.01,
}));
assert.strictEqual(claudeResult.status, 'succeeded');
assert.strictEqual(claudeResult.accepted, true);
assert.strictEqual(claudeResult.nativeAccepted, true);
assert.deepStrictEqual(claudeResult.terminalEvidence, {
  observed: true,
  event: 'result',
  status: 'success',
});
assert.strictEqual(claudeResult.runtimeRefs.sessionId, 'claude-session-1');
assert.deepStrictEqual(claudeResult.payload, { decision: 'approved' });

const claudeMissingNativeRef = adapters.normalizeClaudeOutput(JSON.stringify({
  type: 'result',
  subtype: 'success',
  structured_output: { decision: 'approved' },
}));
assert.strictEqual(claudeMissingNativeRef.status, 'succeeded');
assert.strictEqual(claudeMissingNativeRef.nativeAccepted, false);
assert(claudeMissingNativeRef.nativeAcceptanceErrors.includes(
  'claude session ref is missing'
));

const claudeMissingTerminal = adapters.normalizeClaudeOutput(JSON.stringify({
  type: 'assistant',
  session_id: 'claude-session-no-terminal',
  result: '{"decision":"approved"}',
}));
assert.strictEqual(claudeMissingTerminal.status, 'succeeded');
assert.strictEqual(claudeMissingTerminal.nativeAccepted, false);
assert(claudeMissingTerminal.nativeAcceptanceErrors.includes(
  'claude terminal result event is missing'
));

assert.throws(
  () => adapters.normalizeClaudeOutput(JSON.stringify({
    type: 'result',
    subtype: 'error',
    is_error: true,
    session_id: 'claude-session-2',
    result: 'provider failed',
  })),
  /provider failed/
);

const codexExec = adapters.buildCodexInvocation({
  launch: { ...launch, command: 'codex', requested: 'codex' },
  cwd: 'C:\\repo',
  prompt: 'Implement the slice',
  schemaPath: 'C:\\repo\\schema.json',
  lastMessageFile: 'C:\\run\\last.json',
  sandbox: 'workspace-write',
  mode: 'exec',
});
assert.strictEqual(codexExec.adapter, 'codex-exec');
assert.deepStrictEqual(codexExec.args.slice(0, 3), ['exec', '-C', 'C:\\repo']);
assert(codexExec.args.includes('--output-schema'));
assert.strictEqual(codexExec.args[codexExec.args.length - 1], '-');

const resumedCodex = adapters.buildCodexInvocation({
  launch: { ...launch, command: 'codex', requested: 'codex' },
  cwd: 'C:\\repo',
  prompt: 'Resume the same failed implementation attempt',
  lastMessageFile: 'C:\\run\\last.json',
  resumeThreadId: 'thread-resume',
  mode: 'exec',
});
assert(resumedCodex.args.includes('resume'));
assert(resumedCodex.args.includes('thread-resume'));

assert.throws(
  () => adapters.buildCodexInvocation({
    launch: { ...launch, command: 'codex', requested: 'codex' },
    cwd: 'C:\\repo',
    mode: 'app-server',
  }),
  /explicit opt-in/
);

const appServer = adapters.buildCodexInvocation({
  launch: { ...launch, command: 'codex', requested: 'codex' },
  cwd: 'C:\\repo',
  mode: 'app-server',
  allowExperimental: true,
});
assert.strictEqual(appServer.adapter, 'codex-app-server');
assert.deepStrictEqual(appServer.args, ['app-server', '--stdio']);

const codexResult = adapters.normalizeCodexOutput({
  stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: 'thr-1' }),
    JSON.stringify({ type: 'turn.started', turn_id: 'turn-1' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 8 } }),
  ].join('\n'),
  lastMessage: JSON.stringify({ summary: 'done' }),
});
assert.strictEqual(codexResult.status, 'succeeded');
assert.strictEqual(codexResult.accepted, true);
assert.strictEqual(codexResult.nativeAccepted, true);
assert.deepStrictEqual(codexResult.terminalEvidence, {
  observed: true,
  event: 'turn.completed',
  status: 'completed',
});
assert.strictEqual(codexResult.runtimeRefs.threadId, 'thr-1');
assert.strictEqual(codexResult.runtimeRefs.turnId, 'turn-1');
assert.deepStrictEqual(codexResult.payload, { summary: 'done' });

const codexMissingTerminal = adapters.normalizeCodexOutput({
  stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: 'thr-no-terminal' }),
    JSON.stringify({ type: 'turn.started', turn_id: 'turn-no-terminal' }),
  ].join('\n'),
  lastMessage: JSON.stringify({ summary: 'not terminal' }),
});
assert.strictEqual(codexMissingTerminal.status, 'succeeded');
assert.strictEqual(codexMissingTerminal.nativeAccepted, false);
assert(codexMissingTerminal.nativeAcceptanceErrors.includes(
  'codex terminal turn event is missing'
));

// Mirrors the official `codex exec --json` sample: turn lifecycle events do
// not promise a turn_id, so thread.started + turn.completed is sufficient.
const codexOfficialJsonl = adapters.normalizeCodexOutput({
  stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: 'thr-official-sample' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: {
      id: 'item_1',
      type: 'agent_message',
      text: 'done',
    } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 8 } }),
  ].join('\n'),
  lastMessage: JSON.stringify({ summary: 'official sample accepted' }),
});
assert.strictEqual(codexOfficialJsonl.nativeAccepted, true);
assert.strictEqual(codexOfficialJsonl.runtimeRefs.threadId, 'thr-official-sample');
assert.strictEqual(codexOfficialJsonl.runtimeRefs.turnId, null);

let codexInvalidPayloadError;
try {
  adapters.normalizeCodexOutput({
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: 'thr-invalid-payload' }),
      JSON.stringify({ type: 'turn.started', turn_id: 'turn-invalid-payload' }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n'),
    lastMessage: '{not-json',
  });
} catch (error) {
  codexInvalidPayloadError = error;
}
assert(codexInvalidPayloadError);
assert.strictEqual(codexInvalidPayloadError.runtimeResult.runtimeRefs.threadId, 'thr-invalid-payload');
assert.strictEqual(codexInvalidPayloadError.runtimeResult.runtimeRefs.turnId, 'turn-invalid-payload');

assert.deepStrictEqual(
  adapters.extractRecoveryRuntimeRefs('claude', {
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'error',
      session_id: 'claude-failed-session',
    }),
  }),
  { sessionId: 'claude-failed-session' }
);
assert.deepStrictEqual(
  adapters.extractRecoveryRuntimeRefs('codex', {
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: 'thr-recovery' }),
      JSON.stringify({ type: 'turn.started', turn_id: 'turn-recovery' }),
    ].join('\n'),
  }),
  { threadId: 'thr-recovery', turnId: 'turn-recovery' }
);
assert.deepStrictEqual(
  adapters.extractRecoveryRuntimeRefs('claude', {
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      structured_output: { session_id: 'spoofed-business-session' },
    }),
  }),
  {}
);
assert.deepStrictEqual(
  adapters.extractRecoveryRuntimeRefs('codex', {
    stdout: JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: JSON.stringify({
          thread_id: 'spoofed-business-thread',
          turn_id: 'spoofed-business-turn',
        }),
      },
    }),
  }),
  {}
);

assert.strictEqual(adapters.canSafelyFallback({
  accepted: false,
  effects: { changedFiles: [], externalEffects: [] },
}), true);
assert.strictEqual(adapters.canSafelyFallback({
  accepted: true,
  effects: { changedFiles: [], externalEffects: [] },
}), false);
assert.strictEqual(adapters.canSafelyFallback({
  accepted: false,
  effects: { changedFiles: ['src/a.js'], externalEffects: [] },
}), false);

console.log('runtime-adapters: 43 passed');
