'use strict';

/**
 * Codex hook registry.
 *
 * Kept separate from hook-registry.js so Claude hook commands and hashes do
 * not change when Codex context policy evolves.
 */

const DEFAULT_PLUGIN_ROOT_EXPR = '${CLAUDE_PLUGIN_ROOT}';
const SESSION_START_MATCHER = 'startup|clear|compact';
const WRITE_TOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|str_replace_editor|apply_patch|functions.apply_patch|write_file|edit_file|delete_file|move_file|create_file';
const LIFECYCLE_EVIDENCE_EVENTS = Object.freeze([
  'SubagentStart',
  'SubagentStop',
  'PostCompact',
  'SessionEnd',
]);

const CODEX_HOOKS = Object.freeze([
  { event: 'SessionStart', matcher: SESSION_START_MATCHER, script: 'inject-context-codex.js', timeout: 3000, async: false },
  { event: 'PreToolUse', matcher: WRITE_TOOL_MATCHER, script: 'guard-handoff-path-codex.js', timeout: 1000, async: false, statusMessage: 'Checking handoff path' },
  // Native lifecycle hooks are append-only evidence collectors. They never
  // steer a turn, mutate orchestration state, or infer a run from the cwd.
  { event: 'SubagentStart', matcher: '*', script: 'codex-lifecycle-evidence.js', timeout: 2, async: false },
  { event: 'SubagentStop', matcher: '*', script: 'codex-lifecycle-evidence.js', timeout: 2, async: false },
  { event: 'PostCompact', matcher: 'manual|auto', script: 'codex-lifecycle-evidence.js', timeout: 2, async: false },
  { event: 'SessionEnd', matcher: 'other', script: 'codex-lifecycle-evidence.js', timeout: 3, async: false },
  // Codex 0.145 skips async command hooks. Keep Claude observation hooks in the
  // legacy registry, but do not project no-op registrations into Codex. The
  // legacy Stop evaluator consumes those observations; without them it adds a
  // synchronous end-of-turn scan but cannot produce session-local learning.
  // Codex Sprint retains the explicit Compound phase for verified learning.
]);

function buildCommand(pluginRootExpr, hook) {
  const args = hook.args && hook.args.length ? ` ${hook.args.join(' ')}` : '';
  return `node "${pluginRootExpr}/codex-hooks/${hook.script}"${args}`;
}

function buildCodexPluginHookConfig(options = {}) {
  const pluginRootExpr = options.pluginRootExpr || DEFAULT_PLUGIN_ROOT_EXPR;
  const hooks = {};
  CODEX_HOOKS.forEach((hook) => {
    const entries = hooks[hook.event] || [];
    let entry = entries.find((candidate) => candidate.matcher === hook.matcher);
    if (!entry) {
      entry = { matcher: hook.matcher, hooks: [] };
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
  CODEX_HOOKS,
  DEFAULT_PLUGIN_ROOT_EXPR,
  LIFECYCLE_EVIDENCE_EVENTS,
  SESSION_START_MATCHER,
  WRITE_TOOL_MATCHER,
  buildCodexPluginHookConfig,
  getCodexHookScriptNames,
};
