'use strict';

/**
 * Codex hook registry.
 *
 * Kept separate from hook-registry.js so Claude hook commands and hashes do
 * not change when Codex context policy evolves.
 */

const DEFAULT_PLUGIN_ROOT_EXPR = '${CLAUDE_PLUGIN_ROOT}';
const SESSION_START_MATCHER = 'startup|resume|clear|compact';
const WRITE_TOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|str_replace_editor|apply_patch|functions.apply_patch|write_file|edit_file|delete_file|move_file|create_file';
const CODEX_HOOK_TIMEOUT_UNIT = 'seconds';
const CODEX_HOOK_MAX_TIMEOUT_SECONDS = 5;
const CODEX_BEHAVIOR_EVENTS = Object.freeze([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
]);
const LIFECYCLE_EVIDENCE_EVENTS = Object.freeze([
  'SubagentStart',
  'SubagentStop',
  'PostCompact',
  'SessionEnd',
]);

const CODEX_HOOKS = Object.freeze([
  { event: 'SessionStart', matcher: SESSION_START_MATCHER, script: 'inject-context-codex.js', timeout: 5, async: false },
  { event: 'PreToolUse', matcher: WRITE_TOOL_MATCHER, script: 'guard-handoff-path-codex.js', timeout: 2, async: false, statusMessage: 'Checking handoff path' },
  // These are the current Codex release hook events. Keep them synchronous so
  // the append receipt is durable before the turn advances or the session ends.
  { event: 'UserPromptSubmit', script: 'codex-behavior-hook.js', timeout: 5, async: false },
  { event: 'PreToolUse', matcher: '*', script: 'codex-behavior-hook.js', timeout: 2, async: false },
  { event: 'PostToolUse', matcher: '*', script: 'codex-behavior-hook.js', timeout: 2, async: false },
  { event: 'Stop', script: 'codex-behavior-hook.js', timeout: 5, async: false },
  // Native lifecycle hooks are append-only evidence collectors. They never
  // steer a turn, mutate orchestration state, or infer a run from the cwd.
  { event: 'SubagentStart', matcher: '*', script: 'codex-lifecycle-evidence.js', timeout: 2, async: false },
  { event: 'SubagentStop', matcher: '*', script: 'codex-lifecycle-evidence.js', timeout: 2, async: false },
  { event: 'PostCompact', matcher: 'manual|auto', script: 'codex-lifecycle-evidence.js', timeout: 2, async: false },
  { event: 'SessionEnd', matcher: 'other', script: 'codex-lifecycle-evidence.js', timeout: 3, async: false },
  // Capture stays synchronous because background hooks may finish out of order
  // or be cancelled at session end. Promotion and shared-runtime writes remain
  // outside these hooks and require their explicit governance gates.
]);

function assertCodexHookTimeout(hook) {
  if (!Number.isInteger(hook.timeout)
      || hook.timeout < 1
      || hook.timeout > CODEX_HOOK_MAX_TIMEOUT_SECONDS) {
    throw new Error(
      `Codex hook timeout must be an integer in seconds within [1,${CODEX_HOOK_MAX_TIMEOUT_SECONDS}]`
    );
  }
}

function buildCommand(pluginRootExpr, hook) {
  const args = hook.args && hook.args.length ? ` ${hook.args.join(' ')}` : '';
  return `node "${pluginRootExpr}/codex-hooks/${hook.script}"${args}`;
}

function buildCodexPluginHookConfig(options = {}) {
  const pluginRootExpr = options.pluginRootExpr || DEFAULT_PLUGIN_ROOT_EXPR;
  const hooks = {};
  CODEX_HOOKS.forEach((hook) => {
    assertCodexHookTimeout(hook);
    const entries = hooks[hook.event] || [];
    let entry = entries.find((candidate) => candidate.matcher === hook.matcher);
    if (!entry) {
      entry = hook.matcher === undefined
        ? { hooks: [] }
        : { matcher: hook.matcher, hooks: [] };
      entries.push(entry);
      hooks[hook.event] = entries;
    }
    const command = {
      type: 'command',
      command: buildCommand(pluginRootExpr, hook),
      async: hook.async,
      timeout: hook.timeout,
    };
    if (hook.statusMessage) command.statusMessage = hook.statusMessage;
    entry.hooks.push(command);
  });
  return { hooks };
}

function getCodexHookScriptNames() {
  return [...new Set(CODEX_HOOKS.map((hook) => hook.script))];
}

module.exports = {
  CODEX_BEHAVIOR_EVENTS,
  CODEX_HOOK_MAX_TIMEOUT_SECONDS,
  CODEX_HOOK_TIMEOUT_UNIT,
  CODEX_HOOKS,
  DEFAULT_PLUGIN_ROOT_EXPR,
  LIFECYCLE_EVIDENCE_EVENTS,
  SESSION_START_MATCHER,
  WRITE_TOOL_MATCHER,
  assertCodexHookTimeout,
  buildCodexPluginHookConfig,
  getCodexHookScriptNames,
};
