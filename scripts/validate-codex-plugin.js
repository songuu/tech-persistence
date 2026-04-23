#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
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

function exists(file, label = file) {
  if (!fs.existsSync(file)) {
    fail(`${label} missing`);
    return false;
  }
  ok(`${label} exists`);
  return true;
}

if (!exists(pluginRoot, 'plugin root')) process.exit(1);

const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
if (exists(manifestPath, 'plugin manifest')) {
  const manifest = readJson(manifestPath);
  if (manifest) {
    ['name', 'version', 'description', 'skills', 'hooks', 'interface'].forEach((key) => {
      if (!manifest[key]) fail(`manifest missing ${key}`);
    });
    if (manifest.name !== 'tech-persistence') fail('manifest name must be tech-persistence');
  }
}

const commandsDir = path.join(pluginRoot, 'commands');
if (exists(commandsDir, 'commands dir')) {
  expectedCommands.forEach((name) => exists(path.join(commandsDir, name), `command ${name}`));
}

const skillsDir = path.join(pluginRoot, 'skills');
if (exists(skillsDir, 'skills dir')) {
  expectedSkills.forEach((name) => {
    exists(path.join(skillsDir, name, 'SKILL.md'), `skill ${name}`);
  });
}

const hooksPath = path.join(pluginRoot, 'hooks.json');
if (exists(hooksPath, 'hooks.json')) {
  const hooksConfig = readJson(hooksPath);
  const hooks = hooksConfig && hooksConfig.hooks ? hooksConfig.hooks : {};
  ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].forEach((hook) => {
    if (!hooks[hook]) fail(`hooks.json missing ${hook}`);
  });
}

['inject-context.js', 'observe.js', 'evaluate-session.js'].forEach((script) => {
  exists(path.join(pluginRoot, 'hooks', script), `hook script ${script}`);
});

if (process.exitCode) process.exit(process.exitCode);
console.log('[OK] Codex plugin validation passed');
