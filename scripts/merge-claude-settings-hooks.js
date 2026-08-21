#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { buildClaudeClassicHookSpecs } = require('./lib/hook-registry');

const args = process.argv.slice(2);

function usage() {
  console.error('Usage: node scripts/merge-claude-settings-hooks.js <settings.json> [--hook-root <path>] [--shell windows|posix]');
}

function writeFailureDiagnostic(error) {
  const code = error && typeof error.code === 'string'
    ? error.code.replace(/[^a-z0-9_-]/gi, '').slice(0, 64)
    : error && typeof error.name === 'string'
      ? error.name.replace(/[^a-z0-9_-]/gi, '').slice(0, 64)
      : null;
  process.stderr.write(
    `[FAIL] merge-settings-failed${code ? ` (${code})` : ''}\n`.slice(0, 256)
  );
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

function mergeHook(settings, hookName, spec) {
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const entries = Array.isArray(settings.hooks[hookName]) ? settings.hooks[hookName] : [];
  let matched = false;
  let changed = false;
  for (const entry of entries) {
    if (!Array.isArray(entry && entry.hooks)) continue;
    entry.hooks = entry.hooks.map((hook) => {
      const command = hook && hook.command;
      if (typeof command !== 'string' || !spec.scriptPattern.test(command)) return hook;
      matched = true;
      const replacement = { ...spec.hook };
      if (JSON.stringify(hook) !== JSON.stringify(replacement)) changed = true;
      return replacement;
    });
  }
  if (matched) {
    settings.hooks[hookName] = entries;
    return changed;
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
  const specs = buildClaudeClassicHookSpecs({
    hookRoot: options.hookRoot,
    shell: options.shell,
  });
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
  writeFailureDiagnostic(error);
  process.exit(1);
}
