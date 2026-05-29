#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pluginRoot = path.join(root, 'plugins', 'tech-persistence');
const { normalizeLf } = require(path.join(
  pluginRoot,
  'scripts',
  'build-codex-plugin.js'
));
const {
  HOOK_TARGETS,
  buildPluginHookConfig,
  getHookEventNames,
  getHookScriptNames,
} = require('./lib/hook-registry');

function listTopLevelMarkdownNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function listTopLevelJsNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();
}

function listSkillNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

const expectedCommands = listTopLevelMarkdownNames(path.join(root, 'user-level', 'commands'));
const expectedSkills = listSkillNames(path.join(root, 'user-level', 'skills'));
const expectedCommandSkills = expectedCommands.map((name) => path.basename(name, '.md'));
const expectedCodexSkills = Array.from(new Set([...expectedSkills, ...expectedCommandSkills])).sort();
const expectedHookScripts = getHookScriptNames(HOOK_TARGETS.PLUGIN_RUNTIME);
const expectedHookLibs = listTopLevelJsNames(path.join(root, 'scripts', 'lib'));

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

function validateInventory(label, actual, expected) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  const actualSet = new Set(actualSorted);
  const expectedSet = new Set(expectedSorted);
  const missing = expectedSorted.filter((name) => !actualSet.has(name));
  const extra = actualSorted.filter((name) => !expectedSet.has(name));

  if (missing.length > 0 || extra.length > 0) {
    fail(`${label} inventory mismatch. Missing: ${missing.join(', ') || 'none'}; Extra: ${extra.join(', ') || 'none'}`);
    return;
  }

  ok(`${label} inventory matches source`);
}

function validateGeneratedFileParity(source, target, label) {
  if (!fs.existsSync(source) || !fs.existsSync(target)) return;
  const sourceContent = fs.readFileSync(source, 'utf-8');
  const expected = normalizeLf(sourceContent);
  const actual = normalizeLf(fs.readFileSync(target, 'utf-8'));
  if (actual !== expected) {
    fail(`${label} is not in sync with source`);
    return;
  }
  ok(`${label} matches source`);
}

function resolveLocalRequire(fromFile, request) {
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = request.endsWith('.js')
    ? [base]
    : [base, `${base}.js`, path.join(base, 'index.js')];
  return candidates.find((candidate) => {
    const entry = stat(candidate);
    return entry && entry.isFile();
  });
}

function validateLocalRequireClosure(entryFiles, label) {
  const queue = entryFiles.filter((file) => fs.existsSync(file));
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const content = fs.readFileSync(current, 'utf-8');
    const requirePattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let match;
    while ((match = requirePattern.exec(content)) !== null) {
      const request = match[1];
      const resolved = resolveLocalRequire(current, request);
      if (!resolved) {
        fail(`${label} missing local dependency ${request} from ${path.relative(pluginRoot, current).replace(/\\/g, '/')}`);
        continue;
      }
      queue.push(resolved);
    }
  }

  ok(`${label} local require closure resolved`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
    return null;
  }
}

function collectHookCommands(value, commands = []) {
  if (!value) return commands;
  if (Array.isArray(value)) {
    value.forEach((item) => collectHookCommands(item, commands));
    return commands;
  }
  if (typeof value !== 'object') return commands;
  if (typeof value.command === 'string') commands.push(value.command);
  Object.values(value).forEach((item) => collectHookCommands(item, commands));
  return commands;
}

function validateProjectHookPortability() {
  const hooksPath = path.join(root, '.codex', 'hooks.json');
  if (!fs.existsSync(hooksPath)) {
    ok('project .codex/hooks.json missing');
    return;
  }

  const hooksConfig = readJson(hooksPath);
  if (!hooksConfig) return;

  const forbidden = [
    { pattern: /~\/\.claude/, reason: 'home-scoped Claude path' },
    { pattern: /\.claude[\\/]/, reason: 'Claude-only runtime directory' },
    { pattern: /continuous-learning[\\/]hooks/, reason: 'legacy skill hook path' },
  ];
  const badCommands = collectHookCommands(hooksConfig)
    .filter((command) => forbidden.some((rule) => rule.pattern.test(command)));

  if (badCommands.length > 0) {
    fail(`project .codex/hooks.json contains non-portable hook commands: ${badCommands.join(' | ')}`);
    return;
  }

  ok('project .codex/hooks.json uses project-local hook commands');
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

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(file);
    return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
  });
}

function validateAgentLoopAutoFlagParity() {
  const targets = [
    {
      label: 'plugin command agent-loop.md',
      file: path.join(pluginRoot, 'commands', 'agent-loop.md'),
    },
    {
      label: 'plugin skill agent-loop/SKILL.md',
      file: path.join(pluginRoot, 'skills', 'agent-loop', 'SKILL.md'),
    },
  ];
  const canonicalInvocation = 'node scripts/agent-orchestrator.js run --requirement "<去掉 --auto 的需求>" --auto';
  const stalePatterns = [
    '追加 `--auto-evaluate`',
    '--auto-evaluate` 让 orchestrator',
    'run --requirement "<去掉 --auto 的需求>" --auto-evaluate',
  ];

  targets.forEach((target) => {
    if (!fs.existsSync(target.file)) {
      fail(`${target.label} missing for auto flag parity`);
      return;
    }
    const content = fs.readFileSync(target.file, 'utf-8');
    if (!content.includes(canonicalInvocation)) {
      fail(`${target.label} must document canonical --auto orchestrator invocation`);
    }
    if (!content.includes('`--auto-evaluate` 与 `--auto-freeze`')) {
      fail(`${target.label} must document auto flag compatibility aliases`);
    }
    stalePatterns.forEach((pattern) => {
      if (content.includes(pattern)) {
        fail(`${target.label} must not instruct new calls to use ${pattern.trim()}`);
      }
    });
  });

  const orchestratorPath = path.join(pluginRoot, 'scripts', 'agent-orchestrator.js');
  if (!fs.existsSync(orchestratorPath)) {
    fail('plugin agent-orchestrator.js missing for auto flag parity');
    return;
  }
  const orchestrator = fs.readFileSync(orchestratorPath, 'utf-8');
  [
    "auto: ['auto', 'auto-evaluate', 'auto-freeze']",
    "'auto-evaluate': ['auto', 'auto-evaluate', 'auto-freeze']",
    "'auto-freeze': ['auto', 'auto-evaluate', 'auto-freeze']",
    '--auto-evaluate               Alias for --auto.',
    '--auto-freeze                 Legacy alias for --auto.',
  ].forEach((snippet) => {
    if (!orchestrator.includes(snippet)) {
      fail(`plugin agent-orchestrator.js missing auto flag parity snippet: ${snippet}`);
    }
  });
}

function validateNoClaudeOnlyText(dir, label) {
  const forbidden = /Claude Code|Claude|CLAUDE|~\/\.claude|\.claude\//;
  listMarkdownFiles(dir).forEach((file) => {
    const relativePath = path.relative(pluginRoot, file).replace(/\\/g, '/');
    if (relativePath.startsWith('skills/caveman')) return;
    const content = fs.readFileSync(file, 'utf-8');
    if (forbidden.test(content)) {
      fail(`${label} contains Claude-only text: ${relativePath}`);
    }
  });
}

if (!exists(pluginRoot, 'plugin root')) process.exit(1);
validateProjectHookPortability();

const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
if (isFile(manifestPath, 'plugin manifest')) {
  const manifest = readJson(manifestPath);
  if (manifest) {
    ['name', 'version', 'description', 'skills', 'hooks', 'mcpServers', 'interface'].forEach((key) => {
      if (!manifest[key]) fail(`manifest missing ${key}`);
    });
    if (manifest.name !== 'tech-persistence') fail('manifest name must be tech-persistence');
  }
}

const mcpManifestPath = path.join(pluginRoot, '.codex-plugin', '.mcp.json');
if (isFile(mcpManifestPath, 'mcp manifest .mcp.json')) {
  const mcpManifest = readJson(mcpManifestPath);
  if (mcpManifest) {
    if (!mcpManifest.mcpServers || typeof mcpManifest.mcpServers !== 'object') {
      fail('.mcp.json missing mcpServers object');
    } else {
      const memorySpec = mcpManifest.mcpServers['tech-persistence-memory'];
      if (!memorySpec) fail('.mcp.json missing tech-persistence-memory server');
      else {
        if (memorySpec.command !== 'node') fail('.mcp.json memory server must use node');
        if (!Array.isArray(memorySpec.args) || memorySpec.args.length < 1) {
          fail('.mcp.json memory server missing args');
        } else {
          const arg = memorySpec.args[0];
          if (!arg.includes('${CLAUDE_PLUGIN_ROOT}')) {
            fail('.mcp.json memory server args must reference ${CLAUDE_PLUGIN_ROOT} for cross-runtime portability');
          }
          if (!arg.endsWith('/memory-mcp-server.js')) {
            fail('.mcp.json memory server args must point to memory-mcp-server.js');
          }
        }
      }
    }
  }
}

const mcpRuntimePath = path.join(pluginRoot, 'mcp', 'memory-mcp-server.js');
isFile(mcpRuntimePath, 'mcp runtime memory-mcp-server.js');
validateGeneratedFileParity(
  path.join(root, 'scripts', 'memory-mcp-server.js'),
  mcpRuntimePath,
  'mcp runtime memory-mcp-server.js'
);

const mcpLibDir = path.join(pluginRoot, 'mcp', 'lib');
if (isDirectory(mcpLibDir, 'mcp lib dir')) {
  ['memory-tools.js', 'memory-search.js', 'memory-v5.js', 'runtime-paths.js'].forEach((dep) => {
    isFile(path.join(mcpLibDir, dep), `mcp lib/${dep}`);
  });
}
validateLocalRequireClosure(
  [mcpRuntimePath],
  'mcp runtime'
);

const commandsDir = path.join(pluginRoot, 'commands');
if (isDirectory(commandsDir, 'commands dir')) {
  const commandEntries = fs
    .readdirSync(commandsDir)
    .filter((name) => name.endsWith('.md'))
    .sort();
  validateInventory('commands dir', commandEntries, expectedCommands);
  expectedCommands.forEach((name) => isFile(path.join(commandsDir, name), `command ${name}`));
}

const skillsDir = path.join(pluginRoot, 'skills');
if (isDirectory(skillsDir, 'skills dir')) {
  const skillEntries = fs
    .readdirSync(skillsDir)
    .filter((name) => fs.existsSync(path.join(skillsDir, name)) && fs.lstatSync(path.join(skillsDir, name)).isDirectory())
    .sort();
  validateInventory('skills dir', skillEntries, expectedCodexSkills);
  expectedCodexSkills.forEach((name) => {
    const skillDir = path.join(skillsDir, name);
    if (isDirectory(skillDir, `skill ${name}`)) {
      isFile(path.join(skillDir, 'SKILL.md'), `skill ${name} SKILL.md`);
    }
  });
  expectedCommandSkills.forEach((name) => {
    const skillPath = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) return;
    const content = fs.readFileSync(skillPath, 'utf-8');
    if (!content.includes(`Codex-compatible entry point for the former /${name} command`)) {
      fail(`command skill ${name} must explain the Codex-compatible command entry point`);
    }
  });
  validateNoClaudeOnlyText(skillsDir, 'skills dir');
}

const readmePath = path.join(pluginRoot, 'README.md');
isFile(readmePath, 'README.md');

const hooksPath = path.join(pluginRoot, 'hooks', 'hooks.json');
if (isFile(hooksPath, 'hooks/hooks.json')) {
  const hooksConfig = readJson(hooksPath);
  const hooks = hooksConfig ? hooksConfig.hooks : null;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    fail('hooks/hooks.json missing hooks object');
  } else {
    getHookEventNames(HOOK_TARGETS.PLUGIN_RUNTIME).forEach((hook) => {
      if (!Array.isArray(hooks[hook])) fail(`hooks/hooks.json missing ${hook}`);
    });
    const expected = JSON.stringify(buildPluginHookConfig(), null, 2);
    const actual = JSON.stringify(hooksConfig, null, 2);
    if (actual !== expected) {
      fail('hooks/hooks.json must be generated from scripts/lib/hook-registry.js');
    } else {
      ok('hooks/hooks.json matches hook registry');
    }
  }
}

expectedHookScripts.forEach((script) => {
  isFile(path.join(pluginRoot, 'hooks', script), `hook script ${script}`);
  validateGeneratedFileParity(
    path.join(root, 'scripts', script),
    path.join(pluginRoot, 'hooks', script),
    `hook script ${script}`
  );
});

const hooksLibDir = path.join(pluginRoot, 'hooks', 'lib');
if (isDirectory(hooksLibDir, 'hook script lib dir')) {
  const hookLibEntries = fs
    .readdirSync(hooksLibDir)
    .filter((name) => name.endsWith('.js'))
    .sort();
  validateInventory('hook script lib dir', hookLibEntries, expectedHookLibs);
  expectedHookLibs.forEach((script) => {
    isFile(path.join(hooksLibDir, script), `hook script lib/${script}`);
    validateGeneratedFileParity(
      path.join(root, 'scripts', 'lib', script),
      path.join(hooksLibDir, script),
      `hook script lib/${script}`
    );
  });
}
isFile(path.join(pluginRoot, 'hooks', 'run-hook.cmd'), 'hook script run-hook.cmd');
isFile(path.join(pluginRoot, 'hooks', 'run-hook.js'), 'hook script run-hook.js');
const runHookPath = path.join(pluginRoot, 'hooks', 'run-hook.js');
if (fs.existsSync(runHookPath)) {
  const content = fs.readFileSync(runHookPath, 'utf-8');
  if (!content.includes('function inferRuntime()')) {
    fail('hook script run-hook.js must infer Claude/Codex runtime');
  }
  if (!content.includes('CLAUDE_PLUGIN_ROOT')) {
    fail('hook script run-hook.js must recognize Claude Code plugin runtime');
  }
  if (content.includes("process.env.TECH_PERSISTENCE_RUNTIME = 'codex';")) {
    fail('hook script run-hook.js must not hard-code Codex runtime');
  }
}
validateLocalRequireClosure(
  expectedHookScripts.map((script) => path.join(pluginRoot, 'hooks', script)),
  'hook scripts'
);
validateOptionalFile(path.join(pluginRoot, 'assets', 'tech-persistence-small.svg'), 'asset tech-persistence-small.svg');
validateOptionalFile(path.join(pluginRoot, 'assets', 'tech-persistence.svg'), 'asset tech-persistence.svg');
validateAgentLoopAutoFlagParity();

isFile(
  path.join(pluginRoot, 'scripts', 'import-claude-homunculus.js'),
  'import utility import-claude-homunculus.js'
);
isFile(
  path.join(pluginRoot, 'scripts', 'configure-shared-homunculus.js'),
  'shared utility configure-shared-homunculus.js'
);
isFile(
  path.join(pluginRoot, 'scripts', 'agent-orchestrator.js'),
  'agent-loop utility agent-orchestrator.js'
);
isFile(
  path.join(pluginRoot, 'scripts', 'sync-solution-index.js'),
  'solution-index utility sync-solution-index.js'
);
// utility 脚本（agent-orchestrator / skill-eval-* / skill-traces）通过 require('./lib/*')
// 解析 plugin scripts/lib，与 hook 脚本同样需要闭包校验；否则新增 ./lib 依赖会静默回归
// （A3 给 agent-orchestrator 引入首个 ./lib 依赖时实证：plugin 副本 Cannot find module）。
validateLocalRequireClosure(
  [
    'agent-orchestrator.js',
    'skill-eval-results.js',
    'skill-traces.js',
    'skill-eval-cases.js',
    // 以下 3 个当前零 ./lib 依赖（只 require 内建 fs/path），纳入闭包列表是为 future-proof：
    // 任一将来新增 require('./lib/*') 时护栏自动覆盖，不必记得回来补列表（今天它们 trivially 通过）。
    'configure-shared-homunculus.js',
    'sync-solution-index.js',
    'import-claude-homunculus.js',
  ].map((script) => path.join(pluginRoot, 'scripts', script)),
  'utility scripts'
);
[
  'requirement-spec.schema.json',
  'task-breakdown.schema.json',
  'agent-handoff.schema.json',
  'review-result.schema.json',
].forEach((schema) => {
  isFile(
    path.join(pluginRoot, 'schemas', 'agent-loop', schema),
    `agent-loop schema ${schema}`
  );
});
isFile(
  path.join(pluginRoot, 'codex-homunculus-template', 'config.json'),
  'codex homunculus template config.json'
);

const runtimePathsPath = path.join(pluginRoot, 'hooks', 'lib', 'runtime-paths.js');
if (fs.existsSync(runtimePathsPath)) {
  const content = fs.readFileSync(runtimePathsPath, 'utf-8');
  if (!content.includes('TECH_PERSISTENCE_CONFIG') || !content.includes('resolveConfiguredBaseDir')) {
    fail('hook runtime-paths.js must support shared homunculus config');
  }
}

const memoryV5Path = path.join(pluginRoot, 'hooks', 'lib', 'memory-v5.js');
if (fs.existsSync(memoryV5Path)) {
  const content = fs.readFileSync(memoryV5Path, 'utf-8');
  if (!content.includes('detectProjectIdentity') || !content.includes('loadUnifiedMemoryIndex')) {
    fail('hook memory-v5.js must include shared project identity and unified memory index helpers');
  }
}

const injectContextPath = path.join(pluginRoot, 'hooks', 'inject-context.js');
if (fs.existsSync(injectContextPath)) {
  const content = fs.readFileSync(injectContextPath, 'utf-8');
  if (!content.includes('loadUnifiedMemoryIndex')) {
    fail('hook inject-context.js must merge compatible Claude/Codex Memory v5 stores');
  }
}

expectedHookScripts.forEach((script) => {
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

isFile(
  path.join(pluginRoot, 'skills', 'caveman-compress', 'scripts', '__main__.py'),
  'caveman-compress script __main__.py'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('[OK] Codex plugin validation passed');
