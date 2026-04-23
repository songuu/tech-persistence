#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pluginRoot = path.join(root, 'plugins', 'tech-persistence');
const expectedCommands = [
  'checkpoint.md',
  'compound.md',
  'evolve.md',
  'instinct-export.md',
  'instinct-import.md',
  'instinct-status.md',
  'learn.md',
  'plan.md',
  'prototype.md',
  'review.md',
  'review-learnings.md',
  'session-summary.md',
  'skill-diagnose.md',
  'skill-eval.md',
  'skill-improve.md',
  'skill-publish.md',
  'sprint.md',
  'test.md',
  'think.md',
  'work.md',
];
const expectedSkills = [
  'memory',
  'continuous-learning',
  'prototype-workflow',
  'test-strategy',
  'context-handoff',
];

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
    return null;
  }
}

function stat(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function exists(file, label = file) {
  if (!fs.existsSync(file)) {
    fail(`${label} missing`);
    return false;
  }
  ok(`${label} exists`);
  return true;
}

function isFile(file, label = file) {
  const entry = stat(file);
  if (!entry) {
    fail(`${label} missing`);
    return false;
  }
  if (!entry.isFile()) {
    fail(`${label} must be a file`);
    return false;
  }
  ok(`${label} is a file`);
  return true;
}

function isDirectory(file, label = file) {
  const entry = stat(file);
  if (!entry) {
    fail(`${label} missing`);
    return false;
  }
  if (!entry.isDirectory()) {
    fail(`${label} must be a directory`);
    return false;
  }
  ok(`${label} is a directory`);
  return true;
}

function validateOptionalFile(file, label = file) {
  if (!fs.existsSync(file)) {
    ok(`${label} missing`);
    return false;
  }
  return isFile(file, label);
}

if (!exists(pluginRoot, 'plugin root')) process.exit(1);

const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
if (isFile(manifestPath, 'plugin manifest')) {
  const manifest = readJson(manifestPath);
  if (manifest) {
    ['name', 'version', 'description', 'skills', 'hooks', 'interface'].forEach((key) => {
      if (!manifest[key]) fail(`manifest missing ${key}`);
    });
    if (manifest.name !== 'tech-persistence') fail('manifest name must be tech-persistence');
  }
}

const commandsDir = path.join(pluginRoot, 'commands');
if (isDirectory(commandsDir, 'commands dir')) {
  const commandEntries = fs
    .readdirSync(commandsDir)
    .filter((name) => name.endsWith('.md'));
  if (commandEntries.length !== expectedCommands.length) {
    fail(`commands dir must contain exactly ${expectedCommands.length} .md files`);
  }
  expectedCommands.forEach((name) => isFile(path.join(commandsDir, name), `command ${name}`));
}

const skillsDir = path.join(pluginRoot, 'skills');
if (isDirectory(skillsDir, 'skills dir')) {
  const skillEntries = fs.readdirSync(skillsDir).filter((name) =>
    fs.existsSync(path.join(skillsDir, name)) && fs.lstatSync(path.join(skillsDir, name)).isDirectory()
  );
  if (skillEntries.length !== expectedSkills.length) {
    fail(`skills dir must contain exactly ${expectedSkills.length} skill directories`);
  }
  expectedSkills.forEach((name) => {
    const skillDir = path.join(skillsDir, name);
    if (isDirectory(skillDir, `skill ${name}`)) {
      isFile(path.join(skillDir, 'SKILL.md'), `skill ${name} SKILL.md`);
    }
  });
}

const readmePath = path.join(pluginRoot, 'README.md');
isFile(readmePath, 'README.md');

const hooksPath = path.join(pluginRoot, 'hooks.json');
if (isFile(hooksPath, 'hooks.json')) {
  const hooksConfig = readJson(hooksPath);
  const hooks = hooksConfig ? hooksConfig.hooks : null;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    fail('hooks.json missing hooks object');
  } else {
    ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].forEach((hook) => {
      if (!Array.isArray(hooks[hook])) fail(`hooks.json missing ${hook}`);
    });
  }
}

['inject-context.js', 'observe.js', 'evaluate-session.js'].forEach((script) => {
  isFile(path.join(pluginRoot, 'hooks', script), `hook script ${script}`);
});

validateOptionalFile(path.join(pluginRoot, 'hooks', 'lib', 'runtime-paths.js'), 'hook script lib/runtime-paths.js');
validateOptionalFile(path.join(pluginRoot, 'hooks', 'run-hook.cmd'), 'hook script run-hook.cmd');
validateOptionalFile(path.join(pluginRoot, 'hooks', 'run-hook.js'), 'hook script run-hook.js');
validateOptionalFile(path.join(pluginRoot, 'assets', 'tech-persistence-small.svg'), 'asset tech-persistence-small.svg');
validateOptionalFile(path.join(pluginRoot, 'assets', 'tech-persistence.svg'), 'asset tech-persistence.svg');

isFile(
  path.join(pluginRoot, 'scripts', 'import-claude-homunculus.js'),
  'import utility import-claude-homunculus.js'
);
isFile(
  path.join(pluginRoot, 'codex-homunculus-template', 'config.json'),
  'codex homunculus template config.json'
);

['inject-context.js', 'observe.js', 'evaluate-session.js'].forEach((script) => {
  const scriptPath = path.join(pluginRoot, 'hooks', script);
  if (!fs.existsSync(scriptPath)) return;
  const content = fs.readFileSync(scriptPath, 'utf-8');
  if (
    content.includes("'.claude', 'homunculus'")
    || content.includes('".claude", "homunculus"')
  ) {
    fail(`hook script ${script} hard-codes .claude homunculus`);
  }
});

if (process.exitCode) process.exit(process.exitCode);
console.log('[OK] Codex plugin validation passed');
