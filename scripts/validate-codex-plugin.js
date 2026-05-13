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
const expectedHookScripts = [
  'caveman-activate.js',
  'evaluate-session.js',
  'inject-context.js',
  'observe.js',
];
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
    ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].forEach((hook) => {
      if (!Array.isArray(hooks[hook])) fail(`hooks/hooks.json missing ${hook}`);
    });
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
