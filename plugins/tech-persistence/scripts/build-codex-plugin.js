#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');

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

const replacements = [
  [/~\/\.claude\/homunculus/g, '~/.codex/homunculus'],
  [/~\/\.claude\/CLAUDE\.md/g, '~/.codex/AGENTS.md'],
  [/`~\/\.claude\/homunculus/g, '`~/.codex/homunculus'],
  [/~\/\.claude\/commands/g, '~/.codex commands via Tech Persistence plugin'],
  [/Claude Code/g, 'Codex'],
  [/Claude/g, 'Codex'],
  [/CLAUDE_PROJECT_DIR/g, 'CODEX_PROJECT_DIR'],
  [/CLAUDE\.md/g, 'AGENTS.md'],
  [/\.claude\/commands/g, '.codex/commands'],
  [/\.claude\/skills/g, '.codex/skills'],
  [/\.claude\/rules/g, '.codex/rules'],
  [/\.claude\/plans/g, '.codex/plans'],
];

const runHookJs = `#!/usr/bin/env node

const path = require('path');

const [, , scriptName, ...scriptArgs] = process.argv;

if (!scriptName) {
  process.exit(0);
}

process.env.TECH_PERSISTENCE_RUNTIME = 'codex';

const scriptPath = path.join(__dirname, scriptName);
process.argv = [process.argv[0], scriptPath, ...scriptArgs];
require(scriptPath);
`;

const runHookCmd = [
  '@echo off',
  'setlocal',
  'set "SCRIPT_DIR=%~dp0"',
  'node "%SCRIPT_DIR%run-hook.js" %*',
  'exit /b 0',
  '',
].join('\r\n');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function emptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

function transform(content) {
  return replacements.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    content
  );
}

function normalizeLf(content) {
  return content.replace(/\r\n/g, '\n');
}

function copyTextFile(source, target, shouldTransform = true) {
  ensureDir(path.dirname(target));
  const content = fs.readFileSync(source, 'utf-8');
  fs.writeFileSync(target, normalizeLf(shouldTransform ? transform(content) : content));
}

function writeTextFile(target, content) {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, content);
}

function assertInventory(label, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} inventory mismatch. Missing: ${missing.join(', ') || 'none'}; Extra: ${extra.join(', ') || 'none'}`
    );
  }
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) {
    return { data: {}, body: content };
  }

  const end = content.indexOf('\n---', 4);
  if (end === -1) {
    return { data: {}, body: content };
  }

  const raw = content.slice(4, end).trim();
  const body = content.slice(end + '\n---'.length).replace(/^\s*\n/, '');
  const data = {};
  raw.split('\n').forEach((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) return;
    const [, key, value] = match;
    data[key] = value.replace(/^"(.*)"$/, '$1');
  });
  return { data, body };
}

function titleFromCommandName(name) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function commandToSkill(name, content) {
  const commandName = path.basename(name, '.md');
  const { data, body } = parseFrontmatter(normalizeLf(transform(content)));
  const description = data.description
    || `Run the former /${commandName} workflow in Codex.`;
  const title = titleFromCommandName(commandName);

  return normalizeLf(`---
name: ${commandName}
description: Codex-compatible entry point for the former /${commandName} command. ${description}
---

# ${title}

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin \`commands/*.md\` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former \`/${commandName}\` command.

## Invocation

Use \`$${commandName} <arguments>\` or select this skill through Codex's \`@\` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention \`/${commandName}\`, interpret that as this \`$${commandName}\` skill invocation while running in Codex.

## Command Instructions

${body}
`);
}

function copyCommands() {
  const sourceDir = path.join(repoRoot, 'user-level', 'commands');
  const targetDir = path.join(pluginRoot, 'commands');
  const commandFiles = fs.readdirSync(sourceDir)
    .filter((name) => name.endsWith('.md'))
    .sort();

  assertInventory('commands', commandFiles, expectedCommands);
  emptyDir(targetDir);
  commandFiles.forEach((name) => {
    copyTextFile(path.join(sourceDir, name), path.join(targetDir, name));
  });
  return commandFiles.length;
}

function copySkills() {
  const sourceDir = path.join(repoRoot, 'user-level', 'skills');
  const targetDir = path.join(pluginRoot, 'skills');
  const skillDirs = fs.readdirSync(sourceDir)
    .filter((name) => {
      const skillDir = path.join(sourceDir, name);
      return fs.lstatSync(skillDir).isDirectory()
        && fs.existsSync(path.join(skillDir, 'SKILL.md'));
    })
    .sort();

  assertInventory('skills', skillDirs, expectedSkills);
  emptyDir(targetDir);
  skillDirs.forEach((name) => {
    copyTextFile(
      path.join(sourceDir, name, 'SKILL.md'),
      path.join(targetDir, name, 'SKILL.md')
    );
  });
  expectedCommands.forEach((name) => {
    const source = path.join(repoRoot, 'user-level', 'commands', name);
    const target = path.join(targetDir, path.basename(name, '.md'), 'SKILL.md');
    const content = fs.readFileSync(source, 'utf-8');
    writeTextFile(target, commandToSkill(name, content));
  });
  return skillDirs.length + expectedCommands.length;
}

function copyHooks() {
  const targetDir = path.join(pluginRoot, 'hooks');
  emptyDir(targetDir);
  [
    'inject-context.js',
    'observe.js',
    'evaluate-session.js',
  ].forEach((name) => {
    copyTextFile(path.join(repoRoot, 'scripts', name), path.join(targetDir, name));
  });
  copyTextFile(
    path.join(repoRoot, 'scripts', 'lib', 'runtime-paths.js'),
    path.join(targetDir, 'lib', 'runtime-paths.js')
  );
  copyTextFile(
    path.join(repoRoot, 'scripts', 'lib', 'memory-v5.js'),
    path.join(targetDir, 'lib', 'memory-v5.js')
  );
  writeTextFile(path.join(targetDir, 'run-hook.js'), runHookJs);
  writeTextFile(path.join(targetDir, 'run-hook.cmd'), runHookCmd);
  return 7;
}

function copyHomunculusTemplate() {
  const targetDir = path.join(pluginRoot, 'codex-homunculus-template');
  emptyDir(targetDir);
  copyTextFile(
    path.join(repoRoot, 'user-level', 'homunculus', 'config.json'),
    path.join(targetDir, 'config.json')
  );
  return 1;
}

function copyUtilityScripts() {
  copyTextFile(
    path.join(repoRoot, 'scripts', 'configure-shared-homunculus.js'),
    path.join(pluginRoot, 'scripts', 'configure-shared-homunculus.js'),
    false
  );
  return 1;
}

function main() {
  const commandCount = copyCommands();
  const skillCount = copySkills();
  const hookCount = copyHooks();
  const utilityCount = copyUtilityScripts();
  copyHomunculusTemplate();

  console.log(`[OK] generated ${commandCount} commands`);
  console.log(`[OK] generated ${skillCount} skills`);
  console.log(`[OK] generated ${hookCount} hook files`);
  console.log(`[OK] generated ${utilityCount} utility scripts`);
  console.log('[OK] generated codex homunculus template');
}

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
}
