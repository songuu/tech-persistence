#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const homeDir = process.env.HOME || process.env.USERPROFILE;
const userCodexRoot = process.env.CODEX_HOME || path.join(homeDir, '.codex');
const projectRoot = process.cwd();
const projectCodexRoot = path.join(projectRoot, '.codex');
const repoMarketplacePath = path.join(projectRoot, '.agents', 'plugins', 'marketplace.json');

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

function listSkillDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function expectedUserCommands() {
  return listMarkdownFiles(path.join(repoRoot, 'user-level', 'commands'));
}

function expectedProjectCommands() {
  return listMarkdownFiles(path.join(repoRoot, 'project-level', '.claude', 'commands'));
}

function expectedProjectCommandUnion() {
  return [...new Set([...expectedUserCommands(), ...expectedProjectCommands()])].sort();
}

function expectedUserRules() {
  return listMarkdownFiles(path.join(repoRoot, 'user-level', 'rules'));
}

function expectedProjectRules() {
  return listMarkdownFiles(path.join(repoRoot, 'project-level', '.claude', 'rules'));
}

function expectedProjectRuleUnion() {
  return [...new Set([...expectedUserRules(), ...expectedProjectRules()])].sort();
}

function expectedSkills() {
  return listSkillDirs(path.join(repoRoot, 'user-level', 'skills'));
}

function expectedCodexCommandSkills() {
  return expectedUserCommands().map((name) => path.basename(name, '.md'));
}

function expectedCodexSkills() {
  return [...new Set([...expectedSkills(), ...expectedCodexCommandSkills()])].sort();
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
  const actual = listSkillDirs(dir);
  const actualSet = new Set(actual);
  const missing = expected.filter((name) => !actualSet.has(name));

  if (missing.length > 0) {
    fail(`${label} missing skills: ${missing.join(', ')}`);
    return;
  }
  ok(`${label} has required skills`);
}

function validateCodexCommandSkills(dir, label) {
  if (!isDirectory(dir, label)) return;
  expectedCodexCommandSkills().forEach((name) => {
    const skillPath = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      fail(`${label} missing command skill wrapper: ${name}`);
      return;
    }
    const content = fs.readFileSync(skillPath, 'utf8');
    if (!content.includes(`Codex-compatible entry point for the former /${name} command`)) {
      fail(`${label} command skill wrapper ${name} missing Codex entry-point marker`);
    }
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
    ok('not configured; Codex will use ~/.codex/homunculus');
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


function walkMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdownFiles(file);
    return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
  });
}

function validateCodexText(dir, label, options = {}) {
  const forbidden = options.allowCrossRuntimeReferences
    ? /Codex\.md|\.Codex|~\/\.Codex|锛|銆|鏋|绛|璁|鍐|鐨|涓€/
    : /CLAUDE\.md|Claude Code|~\/\.claude|\.claude\/|Codex\.md|\.Codex|~\/\.Codex|锛|銆|鏋|绛|璁|鍐|鐨|涓€/;
  walkMarkdownFiles(dir).forEach((file) => {
    const content = fs.readFileSync(file, 'utf8');
    if (forbidden.test(content)) {
      fail(`${label} contains unconverted or mojibake text: ${path.relative(projectRoot, file)}`);
    }
  });
}

function validateCodexFile(file, label) {
  if (!fs.existsSync(file)) return;
  const forbidden = /CLAUDE\.md|Claude Code|~\/\.claude|\.claude\/|Codex\.md|\.Codex|~\/\.Codex|锛|銆|鏋|绛|璁|鍐|鐨|涓€/;
  const content = fs.readFileSync(file, 'utf8');
  if (forbidden.test(content)) {
    fail(`${label} contains unconverted or mojibake text`);
  }
}

function validateUserInstall() {
  console.log('\nUser-level Codex install:');
  isFile(path.join(userCodexRoot, 'AGENTS.md'), '~/.codex/AGENTS.md');
  validateInventory(path.join(userCodexRoot, 'commands'), expectedUserCommands(), '~/.codex/commands');
  validateInventory(path.join(userCodexRoot, 'rules'), expectedUserRules(), '~/.codex/rules');
  validateSkills(path.join(userCodexRoot, 'skills'), expectedCodexSkills(), '~/.codex/skills');
  validateCodexCommandSkills(path.join(userCodexRoot, 'skills'), '~/.codex/skills');
  validateCodexText(path.join(userCodexRoot, 'commands'), '~/.codex/commands');
  validateCodexText(path.join(userCodexRoot, 'rules'), '~/.codex/rules');
  validateCodexText(path.join(userCodexRoot, 'skills'), '~/.codex/skills');
}

function validateProjectInstall() {
  console.log('\nProject-level Codex install:');
  isFile(path.join(projectRoot, 'AGENTS.md'), 'AGENTS.md');
  validateInventory(
    path.join(projectCodexRoot, 'commands'),
    expectedProjectCommandUnion(),
    '.codex/commands'
  );
  validateInventory(path.join(projectCodexRoot, 'rules'), expectedProjectRuleUnion(), '.codex/rules');
  validateSkills(path.join(projectCodexRoot, 'skills'), expectedCodexSkills(), '.codex/skills');
  validateCodexCommandSkills(path.join(projectCodexRoot, 'skills'), '.codex/skills');
  isDirectory(path.join(projectCodexRoot, 'plans'), '.codex/plans');
  validateCodexText(path.join(projectCodexRoot, 'commands'), '.codex/commands');
  validateCodexText(
    path.join(projectCodexRoot, 'rules'),
    '.codex/rules',
    { allowCrossRuntimeReferences: true }
  );
  validateCodexText(path.join(projectCodexRoot, 'skills'), '.codex/skills');
  validateCodexFile(path.join(projectRoot, 'AGENTS.md'), 'AGENTS.md');
}

function validateRepoMarketplace() {
  console.log('\nCodex marketplace root:');
  if (!isFile(repoMarketplacePath, '.agents/plugins/marketplace.json')) return;
  const marketplace = readJson(repoMarketplacePath, '.agents/plugins/marketplace.json');
  if (!marketplace) return;
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const entry = plugins.find((plugin) => plugin.name === 'tech-persistence');
  if (!entry) {
    fail('repo marketplace missing tech-persistence entry');
    return;
  }
  ok('repo marketplace has tech-persistence entry');
  if (entry.source?.source !== 'local') fail('tech-persistence marketplace source must be local');
  if (entry.source?.path !== './plugins/tech-persistence') {
    fail('tech-persistence marketplace path must be ./plugins/tech-persistence');
  }
  if (entry.policy?.installation !== 'INSTALLED_BY_DEFAULT') {
    fail('tech-persistence must be INSTALLED_BY_DEFAULT so Codex skills load without a separate UI install');
  }
  if (entry.policy?.authentication !== 'ON_INSTALL') {
    fail('tech-persistence authentication policy must be ON_INSTALL');
  }
}

validateUserInstall();
validateProjectInstall();
validateRepoMarketplace();
validateSharedHomunculusConfig();

if (hasFailure) process.exit(1);
console.log('\n[OK] Codex install validation passed');
