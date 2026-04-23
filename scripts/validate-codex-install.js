#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const homeDir = process.env.HOME || process.env.USERPROFILE;
const userCodexRoot = process.env.CODEX_HOME || path.join(homeDir, '.codex');
const projectRoot = process.cwd();
const projectCodexRoot = path.join(projectRoot, '.codex');

let hasFailure = false;

function fail(message) {
  console.error(`[FAIL] ${message}`);
  hasFailure = true;
}

function ok(message) {
  console.log(`[OK] ${message}`);
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

function walkMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdownFiles(file);
    return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
  });
}

function validateCodexText(dir, label) {
  const forbidden = /CLAUDE\.md|Claude Code|~\/\.claude|\.claude\/|Codex\.md|\.Codex|~\/\.Codex|锛|銆|鏋|绛|璁|鍐|鐨|涓€/;
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
  validateSkills(path.join(userCodexRoot, 'skills'), expectedSkills(), '~/.codex/skills');
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
  validateSkills(path.join(projectCodexRoot, 'skills'), expectedSkills(), '.codex/skills');
  isDirectory(path.join(projectCodexRoot, 'plans'), '.codex/plans');
  validateCodexText(path.join(projectCodexRoot, 'commands'), '.codex/commands');
  validateCodexText(path.join(projectCodexRoot, 'rules'), '.codex/rules');
  validateCodexText(path.join(projectCodexRoot, 'skills'), '.codex/skills');
  validateCodexFile(path.join(projectRoot, 'AGENTS.md'), 'AGENTS.md');
}

validateUserInstall();
validateProjectInstall();

if (hasFailure) process.exit(1);
console.log('\n[OK] Codex install validation passed');
