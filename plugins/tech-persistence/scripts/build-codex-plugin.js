#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const { buildPluginHookConfig } = require(path.join(repoRoot, 'scripts', 'lib', 'hook-registry'));

const expectedCommands = [
  'agent-loop.md',
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
  'skill.md',
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
  'caveman',
  'caveman-commit',
  'caveman-compress',
  'caveman-help',
  'caveman-review',
  'memory',
  'continuous-learning',
  'prototype-workflow',
  'test-strategy',
  'context-handoff',
];

const replacements = [
  [/在 Claude Code runtime 下/g, '在支持 Agent spawn 的 runtime 下'],
  [/Claude Code runtime 下/g, '支持 Agent spawn 的 runtime 下'],
  [/仅对 Claude Code runtime 生效/g, '仅对支持 Agent spawn 的 runtime 生效'],
  [/Claude Code SlashCommand/g, 'non-Codex slash command'],
  [/CLAUDE\.md \/ AGENTS\.md/g, 'runtime instruction docs'],
  [/CLAUDE\.md \+ AGENTS\.md/g, 'runtime instruction docs'],
  [/CLAUDE-solutions-index/g, 'AGENTS-solutions-index'],
  [/node scripts\/archive-claude-solutions-index\.js/g, 'node scripts/archive-claude-solutions-index.js --claude-md AGENTS.md'],
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
  [/\.claude\/agents/g, '.codex/agents'],
  [/\.claude\//g, '.codex/'],
  [/\.claude\b/g, '.codex'],
];

const runHookJs = `#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const [, , scriptName, ...scriptArgs] = process.argv;

if (!scriptName) {
  process.exit(0);
}

function inferRuntime() {
  if (process.env.TECH_PERSISTENCE_RUNTIME) {
    return process.env.TECH_PERSISTENCE_RUNTIME.toLowerCase();
  }
  if (process.env.CODEX_HOME || process.env.CODEX_SESSION_ID || process.env.CODEX_PROJECT_DIR) {
    return 'codex';
  }
  if (
    process.env.CLAUDE_PLUGIN_ROOT
    || process.env.CLAUDE_SESSION_ID
    || process.env.CLAUDE_CONFIG_DIR
    || process.env.CLAUDE_PROJECT_DIR
  ) {
    return 'claude';
  }
  return 'codex';
}

process.env.TECH_PERSISTENCE_RUNTIME = inferRuntime();

const scriptPath = path.join(__dirname, scriptName);
const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  try {
    process.stderr.write(\`[run-hook] failed to launch \${scriptName}: \${result.error.message}\\n\`);
  } catch {}
  process.exit(0);
}

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(result.signal ? 1 : 0);
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
  ensureDir(dir);
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  });
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

function copyFilePreservingType(source, target, shouldTransformText = true) {
  const extension = path.extname(source).toLowerCase();
  const shouldTransform = shouldTransformText && ['.md', '.txt', '.json', '.toml'].includes(extension);
  if (shouldTransform) {
    copyTextFile(source, target, true);
    return;
  }
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function copyDirectoryRecursive(sourceDir, targetDir, options = {}) {
  ensureDir(targetDir);
  fs.readdirSync(sourceDir, { withFileTypes: true }).forEach((entry) => {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(source, target, options);
      return;
    }
    if (entry.isFile()) copyFilePreservingType(source, target, options.transformText !== false);
  });
}

function copyHookLibs(targetDir) {
  const sourceLibDir = path.join(repoRoot, 'scripts', 'lib');
  const targetLibDir = path.join(targetDir, 'lib');
  emptyDir(targetLibDir);

  const libFiles = fs
    .readdirSync(sourceLibDir)
    .filter((name) => name.endsWith('.js'))
    .sort();

  libFiles.forEach((name) => {
    copyTextFile(path.join(sourceLibDir, name), path.join(targetLibDir, name), false);
  });

  return libFiles.length;
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
  ensureDir(targetDir);
  fs.readdirSync(targetDir)
    .filter((name) => name.endsWith('.md') && !commandFiles.includes(name))
    .forEach((name) => fs.rmSync(path.join(targetDir, name), { force: true }));
  // plugins/tech-persistence/commands/ 服务于 Claude Code 2.x plugin 系统,
  // 必须保持 Claude Code 形态 (~/.claude/ 路径). Codex 端通过 skills/ 调用,
  // 不读 commands/, 所以这里不应该跑 codex transform.
  // 与 propagate-command-changes.js line 81 行为对齐 (transform = identity).
  commandFiles.forEach((name) => {
    copyTextFile(path.join(sourceDir, name), path.join(targetDir, name), false);
  });
  const copied = fs.readdirSync(targetDir)
    .filter((name) => name.endsWith('.md'))
    .sort();
  const copiedSet = new Set(copied);
  commandFiles
    .filter((name) => !copiedSet.has(name))
    .forEach((name) => {
      copyTextFile(path.join(sourceDir, name), path.join(targetDir, name), false);
    });
  assertInventory(
    'generated commands',
    fs.readdirSync(targetDir).filter((name) => name.endsWith('.md')).sort(),
    expectedCommands
  );
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
    copyDirectoryRecursive(
      path.join(sourceDir, name),
      path.join(targetDir, name),
      { transformText: !name.startsWith('caveman') }
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
  writeTextFile(
    path.join(targetDir, 'hooks.json'),
    `${JSON.stringify(buildPluginHookConfig(), null, 2)}\n`
  );
  [
    'caveman-activate.js',
    'inject-context.js',
    'observe.js',
    'evaluate-session.js',
    'prompt-submit.js',
  ].forEach((name) => {
    copyTextFile(path.join(repoRoot, 'scripts', name), path.join(targetDir, name), false);
  });
  const hookLibCount = copyHookLibs(targetDir);
  writeTextFile(path.join(targetDir, 'run-hook.js'), runHookJs);
  writeTextFile(path.join(targetDir, 'run-hook.cmd'), runHookCmd);
  return 5 + hookLibCount + 3;
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

function copyMcpRuntime() {
  const targetDir = path.join(pluginRoot, 'mcp');
  emptyDir(targetDir);
  copyTextFile(
    path.join(repoRoot, 'scripts', 'memory-mcp-server.js'),
    path.join(targetDir, 'memory-mcp-server.js'),
    false
  );
  const libCount = copyHookLibs(targetDir);
  return 1 + libCount;
}

function copyUtilityScripts() {
  const utilityScripts = [
    'configure-shared-homunculus.js',
    'agent-orchestrator.js',
    'sync-solution-index.js',
    'skill-eval-results.js',
    'skill-traces.js',
  ];
  utilityScripts.forEach((name) => {
    copyTextFile(
      path.join(repoRoot, 'scripts', name),
      path.join(pluginRoot, 'scripts', name),
      false
    );
  });
  copyAgentOrchestratorSubmodules();
  return utilityScripts.length + 1;
}

function copyAgentOrchestratorSubmodules() {
  const sourceDir = path.join(repoRoot, 'scripts', 'agent-orchestrator');
  if (!fs.existsSync(sourceDir)) return;
  const targetDir = path.join(pluginRoot, 'scripts', 'agent-orchestrator');
  emptyDir(targetDir);
  fs.readdirSync(sourceDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .forEach((name) => {
      copyTextFile(
        path.join(sourceDir, name),
        path.join(targetDir, name),
        false
      );
    });
}

function copySchemas() {
  const sourceDir = path.join(repoRoot, 'schemas', 'agent-loop');
  const targetDir = path.join(pluginRoot, 'schemas', 'agent-loop');
  emptyDir(targetDir);
  fs.readdirSync(sourceDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .forEach((name) => {
      copyTextFile(path.join(sourceDir, name), path.join(targetDir, name), false);
    });
  return fs.readdirSync(targetDir).filter((name) => name.endsWith('.json')).length;
}

function main() {
  const commandCount = copyCommands();
  const skillCount = copySkills();
  const hookCount = copyHooks();
  const mcpCount = copyMcpRuntime();
  const utilityCount = copyUtilityScripts();
  const schemaCount = copySchemas();
  copyHomunculusTemplate();

  console.log(`[OK] generated ${commandCount} commands`);
  console.log(`[OK] generated ${skillCount} skills`);
  console.log(`[OK] generated ${hookCount} hook files`);
  console.log(`[OK] generated ${mcpCount} mcp runtime files`);
  console.log(`[OK] generated ${utilityCount} utility scripts`);
  console.log(`[OK] generated ${schemaCount} schemas`);
  console.log('[OK] generated codex homunculus template');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  transform,
  normalizeLf,
  commandToSkill,
  parseFrontmatter,
  replacements,
  expectedCommands,
  expectedSkills,
  copyHookLibs,
};
