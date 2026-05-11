#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const homeDir = process.env.HOME || process.env.USERPROFILE;
const userClaudeRoot = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
const projectRoot = process.cwd();
const projectClaudeRoot = path.join(projectRoot, '.claude');
const args = new Set(process.argv.slice(2));

let hasFailure = false;

function fail(message) {
  console.error(`[FAIL] ${message}`);
  hasFailure = true;
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function expectedUserCommands() {
  return listMarkdownFiles(path.join(repoRoot, 'user-level', 'commands'));
}

function expectedProjectCommands() {
  return listMarkdownFiles(path.join(repoRoot, 'project-level', '.claude', 'commands'));
}

function expectedUserRules() {
  return listMarkdownFiles(path.join(repoRoot, 'user-level', 'rules'));
}

function expectedProjectRules() {
  return listMarkdownFiles(path.join(repoRoot, 'project-level', '.claude', 'rules'));
}

function expectedClaudeSkills() {
  return [
    'context-handoff',
    'continuous-learning',
    'memory',
    'prototype-workflow',
    'test-strategy',
  ].sort();
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function isFile(file, label) {
  if (!fs.existsSync(file)) {
    fail(`${label} missing`);
    return false;
  }
  if (!fs.lstatSync(file).isFile()) {
    fail(`${label} must be a file`);
    return false;
  }
  ok(`${label} exists`);
  return true;
}

function isDirectory(dir, label) {
  if (!fs.existsSync(dir)) {
    fail(`${label} missing`);
    return false;
  }
  if (!fs.lstatSync(dir).isDirectory()) {
    fail(`${label} must be a directory`);
    return false;
  }
  ok(`${label} exists`);
  return true;
}

function validateInventory(dir, expected, label) {
  if (!isDirectory(dir, label)) return;
  const actual = listMarkdownFiles(dir);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));

  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${label} inventory mismatch. Missing: ${missing.join(', ') || 'none'}; Extra: ${extra.join(', ') || 'none'}`
    );
    return;
  }
  ok(`${label} has ${expected.length} files`);
}

function validateSkills(dir, expected, label) {
  if (!isDirectory(dir, label)) return;
  const missing = expected.filter((name) => !fs.existsSync(path.join(dir, name, 'SKILL.md')));
  if (missing.length > 0) {
    fail(`${label} missing skills: ${missing.join(', ')}`);
    return;
  }
  ok(`${label} has required skills`);
}

function collectHookCommands(settings, hookName) {
  const entries = settings?.hooks?.[hookName];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    return hooks
      .map((hook) => hook && hook.command)
      .filter((command) => typeof command === 'string');
  });
}

function validateSettingsHooks(file, label) {
  if (!isFile(file, label)) return;
  const settings = readJson(file, label);
  if (!settings) return;

  const expected = [
    ['SessionStart', /inject-context\.js/],
    ['PreToolUse', /observe\.js\b.*\bpre\b/],
    ['PostToolUse', /observe\.js\b.*\bpost\b/],
    ['Stop', /evaluate-session\.js/],
  ];

  for (const [hookName, pattern] of expected) {
    const commands = collectHookCommands(settings, hookName);
    if (!commands.some((command) => pattern.test(command))) {
      fail(`${label} missing ${hookName} hook command matching ${pattern}`);
    } else {
      ok(`${label} has ${hookName} hook`);
    }
  }
}

function validateHookScripts(hooksDir, label) {
  if (!isDirectory(hooksDir, label)) return;
  [
    'inject-context.js',
    'observe.js',
    'evaluate-session.js',
    path.join('lib', 'runtime-paths.js'),
    path.join('lib', 'memory-v5.js'),
  ].forEach((name) => {
    isFile(path.join(hooksDir, name), `${label}/${name.replace(/\\/g, '/')}`);
  });
}

function validateSharedHomunculusConfig() {
  console.log('\nShared homunculus config:');
  const configPath = process.env.TECH_PERSISTENCE_CONFIG
    ? path.resolve(expandHome(process.env.TECH_PERSISTENCE_CONFIG))
    : path.join(homeDir, '.tech-persistence', 'config.json');

  if (process.env.TECH_PERSISTENCE_HOME) {
    const envHome = path.resolve(expandHome(process.env.TECH_PERSISTENCE_HOME));
    ok(`TECH_PERSISTENCE_HOME set: ${envHome}`);
    if (!fs.existsSync(envHome)) fail(`TECH_PERSISTENCE_HOME target missing: ${envHome}`);
    return;
  }

  if (!fs.existsSync(configPath)) {
    ok('not configured; Claude Code will use ~/.claude/homunculus');
    return;
  }

  const config = readJson(configPath, configPath);
  if (!config) return;
  const configured = config.homunculusHome || config.homunculusDir || config.vaultPath;
  if (!configured) {
    fail('shared config missing homunculusHome');
    return;
  }
  const homunculusHome = path.resolve(expandHome(configured));
  ok(`shared homunculus configured: ${homunculusHome}`);
  if (!fs.existsSync(homunculusHome)) fail(`shared homunculus directory missing: ${homunculusHome}`);
}

function validateUserInstall() {
  console.log('\nUser-level Claude Code install:');
  isFile(path.join(userClaudeRoot, 'CLAUDE.md'), '~/.claude/CLAUDE.md');
  validateSettingsHooks(path.join(userClaudeRoot, 'settings.json'), '~/.claude/settings.json');
  validateInventory(path.join(userClaudeRoot, 'commands'), expectedUserCommands(), '~/.claude/commands');
  validateInventory(path.join(userClaudeRoot, 'rules'), expectedUserRules(), '~/.claude/rules');
  validateSkills(path.join(userClaudeRoot, 'skills'), expectedClaudeSkills(), '~/.claude/skills');
  validateHookScripts(
    path.join(userClaudeRoot, 'skills', 'continuous-learning', 'hooks'),
    '~/.claude/skills/continuous-learning/hooks'
  );
}

function validateProjectInstall() {
  console.log('\nProject-level Claude Code install:');
  isFile(path.join(projectRoot, 'CLAUDE.md'), 'CLAUDE.md');
  validateSettingsHooks(path.join(projectClaudeRoot, 'settings.json'), '.claude/settings.json');
  validateInventory(path.join(projectClaudeRoot, 'commands'), expectedProjectCommands(), '.claude/commands');
  validateInventory(path.join(projectClaudeRoot, 'rules'), expectedProjectRules(), '.claude/rules');
  isDirectory(path.join(projectClaudeRoot, 'plans'), '.claude/plans');
}

const allowedArgs = new Set(['--help', '--user', '--project']);
const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length > 0) {
  fail(`unknown arguments: ${unknownArgs.join(', ')}`);
}

if (args.has('--help')) {
  console.log('Usage: node scripts/validate-claude-install.js [--user] [--project]');
  process.exit(0);
}

const validateUser = args.size === 0 || args.has('--user');
const validateProject = args.size === 0 || args.has('--project');

if (validateUser) validateUserInstall();
if (validateProject) validateProjectInstall();
validateSharedHomunculusConfig();

if (hasFailure) process.exit(1);
console.log('\n[OK] Claude Code install validation passed');
