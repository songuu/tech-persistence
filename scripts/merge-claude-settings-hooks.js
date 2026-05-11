#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

function usage() {
  console.error('Usage: node scripts/merge-claude-settings-hooks.js <settings.json> [--hook-root <path>] [--shell windows|posix]');
}

function parseArgs() {
  const options = {
    settingsPath: null,
    hookRoot: '~/.claude/skills/continuous-learning/hooks',
    shell: process.platform === 'win32' ? 'windows' : 'posix',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!options.settingsPath && !arg.startsWith('--')) {
      options.settingsPath = arg;
    } else if (arg === '--hook-root') {
      options.hookRoot = args[++i];
    } else if (arg === '--shell') {
      options.shell = args[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.settingsPath) throw new Error('settings.json path is required');
  if (!['windows', 'posix'].includes(options.shell)) {
    throw new Error('--shell must be windows or posix');
  }
  return options;
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const content = fs.readFileSync(settingsPath, 'utf8').trim();
  if (!content) return {};
  return JSON.parse(content);
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

function hookCommand(hookRoot, script, suffix, shell) {
  const scriptPath = `${hookRoot.replace(/\\/g, '/')}/${script}`;
  const commandPath = shell === 'windows' ? quoteForWindows(scriptPath) : quoteForPosix(scriptPath);
  const argSuffix = suffix ? ` ${suffix}` : '';
  return shell === 'windows'
    ? `node ${commandPath}${argSuffix} 2>nul || exit /b 0`
    : `node ${commandPath}${argSuffix} 2>/dev/null || true`;
}

function hookSpec(hookRoot, shell) {
  return {
    SessionStart: {
      matcher: '*',
      scriptPattern: /inject-context\.js/,
      hook: {
        type: 'command',
        command: hookCommand(hookRoot, 'inject-context.js', '', shell),
        timeout: 5000,
      },
    },
    PreToolUse: {
      matcher: '*',
      scriptPattern: /observe\.js\b.*\bpre\b/,
      hook: {
        type: 'command',
        command: hookCommand(hookRoot, 'observe.js', 'pre', shell),
        timeout: 2000,
      },
    },
    PostToolUse: {
      matcher: '*',
      scriptPattern: /observe\.js\b.*\bpost\b/,
      hook: {
        type: 'command',
        command: hookCommand(hookRoot, 'observe.js', 'post', shell),
        timeout: 2000,
      },
    },
    Stop: {
      matcher: '*',
      scriptPattern: /evaluate-session\.js/,
      hook: {
        type: 'command',
        command: hookCommand(hookRoot, 'evaluate-session.js', '', shell),
        timeout: 10000,
      },
    },
  };
}

function hookCommands(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    return hooks
      .map((hook) => hook && hook.command)
      .filter((command) => typeof command === 'string');
  });
}

function mergeHook(settings, hookName, spec) {
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const entries = Array.isArray(settings.hooks[hookName]) ? settings.hooks[hookName] : [];
  if (hookCommands(entries).some((command) => spec.scriptPattern.test(command))) {
    settings.hooks[hookName] = entries;
    return false;
  }

  entries.push({
    matcher: spec.matcher,
    hooks: [spec.hook],
  });
  settings.hooks[hookName] = entries;
  return true;
}

function main() {
  const options = parseArgs();
  const settingsPath = path.resolve(options.settingsPath);
  const settings = readSettings(settingsPath);
  if (!settings.$schema) {
    settings.$schema = 'https://json.schemastore.org/claude-code-settings.json';
  }
  if (settings.autoMemoryEnabled === undefined) {
    settings.autoMemoryEnabled = true;
  }

  let changed = false;
  const specs = hookSpec(options.hookRoot, options.shell);
  Object.entries(specs).forEach(([hookName, spec]) => {
    if (mergeHook(settings, hookName, spec)) changed = true;
  });

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  console.log(changed ? '[OK] merged Claude Code hooks' : '[OK] Claude Code hooks already present');
}

try {
  main();
} catch (error) {
  usage();
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
}
