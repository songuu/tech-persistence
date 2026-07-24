'use strict';

const HOOK_TARGETS = Object.freeze({
  CLAUDE_CLASSIC: 'claude-classic',
  PLUGIN_RUNTIME: 'plugin-runtime',
});

const DEFAULT_CLAUDE_CLASSIC_HOOK_ROOT = '~/.claude/skills/continuous-learning/hooks';
const DEFAULT_PLUGIN_ROOT_EXPR = '${CLAUDE_PLUGIN_ROOT}';
const PLUGIN_SESSION_START_MATCHER = 'startup|clear|compact';

const LOGICAL_HOOKS = Object.freeze([
  {
    id: 'memory-session-context',
    lifecycle: 'session-start',
    script: 'inject-context.js',
    args: [],
    targets: {
      [HOOK_TARGETS.CLAUDE_CLASSIC]: {
        event: 'SessionStart',
        matcher: '*',
        timeout: 5000,
        scriptPattern: /inject-context\.js/,
      },
      [HOOK_TARGETS.PLUGIN_RUNTIME]: {
        event: 'SessionStart',
        matcher: PLUGIN_SESSION_START_MATCHER,
        timeout: 5000,
        async: false,
      },
    },
  },
  {
    id: 'caveman-session-mode',
    lifecycle: 'session-start',
    script: 'caveman-activate.js',
    args: [],
    targets: {
      [HOOK_TARGETS.PLUGIN_RUNTIME]: {
        event: 'SessionStart',
        matcher: PLUGIN_SESSION_START_MATCHER,
        timeout: 2000,
        async: false,
        statusMessage: 'Loading caveman mode',
      },
    },
  },
  {
    id: 'prompt-memory-recall',
    lifecycle: 'user-prompt-submit',
    script: 'prompt-submit.js',
    args: [],
    targets: {
      [HOOK_TARGETS.PLUGIN_RUNTIME]: {
        event: 'UserPromptSubmit',
        matcher: '*',
        timeout: 1800,
        async: false,
        statusMessage: 'Recalling relevant memory',
      },
    },
  },
  {
    id: 'guard-handoff-path-before-write',
    lifecycle: 'pre-tool-use',
    script: 'guard-handoff-path.js',
    args: [],
    targets: {
      [HOOK_TARGETS.PLUGIN_RUNTIME]: {
        event: 'PreToolUse',
        matcher: '*',
        timeout: 1000,
        async: false,
        statusMessage: 'Checking handoff path',
      },
    },
  },
  {
    id: 'observe-tool-before',
    lifecycle: 'pre-tool-use',
    script: 'observe.js',
    args: ['pre'],
    targets: {
      [HOOK_TARGETS.CLAUDE_CLASSIC]: {
        event: 'PreToolUse',
        matcher: '*',
        timeout: 2000,
        scriptPattern: /observe\.js\b.*\bpre\b/,
      },
      [HOOK_TARGETS.PLUGIN_RUNTIME]: {
        event: 'PreToolUse',
        matcher: '*',
        timeout: 2000,
        async: true,
      },
    },
  },
  {
    id: 'observe-tool-after',
    lifecycle: 'post-tool-use',
    script: 'observe.js',
    args: ['post'],
    targets: {
      [HOOK_TARGETS.CLAUDE_CLASSIC]: {
        event: 'PostToolUse',
        matcher: '*',
        timeout: 2000,
        scriptPattern: /observe\.js\b.*\bpost\b/,
      },
      [HOOK_TARGETS.PLUGIN_RUNTIME]: {
        event: 'PostToolUse',
        matcher: '*',
        timeout: 2000,
        async: true,
      },
    },
  },
  {
    id: 'evaluate-session',
    lifecycle: 'stop',
    script: 'evaluate-session.js',
    args: [],
    targets: {
      [HOOK_TARGETS.CLAUDE_CLASSIC]: {
        event: 'Stop',
        matcher: '*',
        timeout: 10000,
        scriptPattern: /evaluate-session\.js/,
      },
      [HOOK_TARGETS.PLUGIN_RUNTIME]: {
        event: 'Stop',
        matcher: '*',
        timeout: 10000,
        async: false,
      },
    },
  },
]);

function assertKnownTarget(target) {
  if (!Object.values(HOOK_TARGETS).includes(target)) {
    throw new Error(`unknown hook target: ${target}`);
  }
}

function hooksForTarget(target) {
  assertKnownTarget(target);
  return LOGICAL_HOOKS
    .map((hook) => ({ hook, target: hook.targets[target] }))
    .filter((entry) => entry.target);
}

function uniqueInOrder(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function getHookScriptNames(target) {
  return uniqueInOrder(hooksForTarget(target).map(({ hook }) => hook.script));
}

function getHookEventNames(target) {
  return uniqueInOrder(hooksForTarget(target).map(({ target: targetSpec }) => targetSpec.event));
}

function getHookSettingsExpectations(target) {
  return hooksForTarget(target).map(({ hook, target: targetSpec }) => ({
    id: hook.id,
    event: targetSpec.event,
    matcher: targetSpec.matcher,
    script: hook.script,
    scriptPattern: targetSpec.scriptPattern || patternForScriptAndArgs(hook.script, hook.args),
  }));
}

function quoteForWindows(value) {
  return `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function quoteForPosix(value) {
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return value.replace(/\\/g, '/');
  }
  return `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function buildClaudeClassicCommand(hookRoot, script, args, shell) {
  const scriptPath = `${hookRoot.replace(/\\/g, '/')}/${script}`;
  const commandPath = shell === 'windows' ? quoteForWindows(scriptPath) : quoteForPosix(scriptPath);
  const argSuffix = args && args.length > 0 ? ` ${args.join(' ')}` : '';
  // Claude Code on Windows executes hook commands via Git Bash (MSYS2), so
  // POSIX stderr suppression is the least surprising cross-shell fallback.
  return `node ${commandPath}${argSuffix} 2>/dev/null || true`;
}

function patternForScriptAndArgs(script, args) {
  const escapedScript = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!args || args.length === 0) return new RegExp(escapedScript);
  const escapedArgs = args.map((arg) => arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`${escapedScript}\\b.*\\b${escapedArgs}\\b`);
}

function buildClaudeClassicHookSpecs(options = {}) {
  const hookRoot = options.hookRoot || DEFAULT_CLAUDE_CLASSIC_HOOK_ROOT;
  const shell = options.shell || (process.platform === 'win32' ? 'windows' : 'posix');
  if (!['windows', 'posix'].includes(shell)) {
    throw new Error('shell must be windows or posix');
  }

  const specs = {};
  hooksForTarget(HOOK_TARGETS.CLAUDE_CLASSIC).forEach(({ hook, target }) => {
    specs[target.event] = {
      matcher: target.matcher,
      scriptPattern: target.scriptPattern || patternForScriptAndArgs(hook.script, hook.args),
      hook: {
        type: 'command',
        command: buildClaudeClassicCommand(hookRoot, hook.script, hook.args, shell),
        timeout: target.timeout,
      },
    };
  });
  return specs;
}

function buildPluginCommand(pluginRootExpr, script, args) {
  const argSuffix = args && args.length > 0 ? ` ${args.join(' ')}` : '';
  return `node "${pluginRootExpr}/hooks/run-hook.js" ${script}${argSuffix}`;
}

function buildPluginHookConfig(options = {}) {
  const pluginRootExpr = options.pluginRootExpr || DEFAULT_PLUGIN_ROOT_EXPR;
  const hooks = {};

  hooksForTarget(HOOK_TARGETS.PLUGIN_RUNTIME).forEach(({ hook, target }) => {
    const eventEntries = hooks[target.event] || [];
    let entry = eventEntries.find((candidate) => candidate.matcher === target.matcher);
    if (!entry) {
      entry = { matcher: target.matcher, hooks: [] };
      eventEntries.push(entry);
      hooks[target.event] = eventEntries;
    }

    const commandHook = {
      type: 'command',
      command: buildPluginCommand(pluginRootExpr, hook.script, hook.args),
      async: target.async,
      timeout: target.timeout,
    };
    if (target.statusMessage) commandHook.statusMessage = target.statusMessage;
    entry.hooks.push(commandHook);
  });

  return { hooks };
}

module.exports = {
  HOOK_TARGETS,
  LOGICAL_HOOKS,
  DEFAULT_CLAUDE_CLASSIC_HOOK_ROOT,
  DEFAULT_PLUGIN_ROOT_EXPR,
  PLUGIN_SESSION_START_MATCHER,
  buildClaudeClassicHookSpecs,
  buildPluginHookConfig,
  getHookEventNames,
  getHookScriptNames,
  getHookSettingsExpectations,
  hooksForTarget,
};
