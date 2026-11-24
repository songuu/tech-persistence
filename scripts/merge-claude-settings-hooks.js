#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { buildClaudeClassicHookSpecs } = require('./lib/hook-registry');

const args = process.argv.slice(2);

function usage() {
  console.error('Usage: node scripts/merge-claude-settings-hooks.js <settings.json> [--hook-root <path>] [--shell windows|posix] [--prompt-only]');
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
    promptOnly: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!options.settingsPath && !arg.startsWith('--')) {
      options.settingsPath = arg;
    } else if (arg === '--hook-root') {
      options.hookRoot = args[++i];
    } else if (arg === '--shell') {
      options.shell = args[++i];
    } else if (arg === '--prompt-only') {
      options.promptOnly = true;
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

// Hook-only upgrades must not register a new hook or rewrite unrelated user
// settings. Limit ownership to the classic managed hook directory.
function normalizeManagedPath(candidate) {
  const expanded = candidate.startsWith('~/') || candidate.startsWith('~\\')
    ? path.join(os.homedir(), candidate.slice(2)) : candidate;
  const resolved = path.resolve(expanded.replace(/[\\/]/g, path.sep));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function upgradeExistingPromptHook(settings, hookRoot) {
  const entries = settings && settings.hooks && settings.hooks.UserPromptSubmit;
  if (!Array.isArray(entries)) return false;
  let changed = false;
  for (const entry of entries) {
    if (!Array.isArray(entry && entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || hook.type !== 'command' || typeof hook.command !== 'string') continue;
      // Recognize only the exact managed executable and known old fallback;
      // compound shell commands and other installations remain user-owned.
      const match = /^\s*node\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))(?:\s+2>(?:\/dev\/null|nul))?(?:\s*\|\|\s*true)?\s*$/i.exec(hook.command);
      if (!match || normalizeManagedPath(match[1] || match[2] || match[3])
          !== normalizeManagedPath(path.join(hookRoot, 'prompt-submit.js'))) continue;
      const command = hook.command.replace(/\s*\|\|\s*true\s*$/, '');
      if (command !== hook.command) { hook.command = command; changed = true; }
      if (hook.onFailure !== 'block') { hook.onFailure = 'block'; changed = true; }
      if (hook.async === true) { hook.async = false; changed = true; }
      if (hook.asyncRewake === true) { hook.asyncRewake = false; changed = true; }
    }
  }
  return changed;
}

function assertPlainSettingsPath(file) {
  const resolved = path.resolve(file);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('settings path contains a link');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('settings must be a plain file');
  return stat;
}

function sameSettingsIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;
}

function upgradePromptSettings(settingsPath, hookRoot) {
  if (!fs.existsSync(settingsPath)) return;
  const initial = assertPlainSettingsPath(settingsPath);
  const original = fs.readFileSync(settingsPath);
  if (!sameSettingsIdentity(initial, assertPlainSettingsPath(settingsPath))) throw new Error('settings changed during read');
  const settings = JSON.parse(original.toString('utf8').trim());
  if (!upgradeExistingPromptHook(settings, hookRoot)) return;
  const temporary = path.join(path.dirname(settingsPath), `.prompt-hook-${crypto.randomBytes(16).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', initial.mode & 0o777);
    fs.writeFileSync(descriptor, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (!sameSettingsIdentity(initial, assertPlainSettingsPath(settingsPath))
        || !original.equals(fs.readFileSync(settingsPath))) throw new Error('settings changed before publish');
    fs.renameSync(temporary, settingsPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  console.log('[OK] upgraded Claude prompt hook');
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
  if (options.promptOnly) {
    upgradePromptSettings(settingsPath, options.hookRoot);
    return;
  }
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
