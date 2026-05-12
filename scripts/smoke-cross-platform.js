#!/usr/bin/env node

/**
 * Smoke tests for cross-platform installation and macOS CI coverage.
 *
 * These checks intentionally stay lightweight and static enough to run on any
 * developer machine while still guarding the macOS/POSIX gaps found during
 * architecture validation.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function assert(condition, message) {
  if (condition) return;
  throw new Error(message);
}

function assertIncludes(text, needle, label) {
  assert(text.includes(needle), `${label} missing: ${needle}`);
}

function run(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok ${name}\n`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error: error.message });
    process.stdout.write(`  fail ${name}\n    ${error.message}\n`);
  }
}

function testInstallShNodePreflight() {
  const script = read('install.sh');

  assertIncludes(script, 'require_node() {', 'install.sh');
  assertIncludes(script, 'Node.js >= 18 required', 'install.sh');

  const requireFunctionIndex = script.indexOf('require_node() {');
  const resolvePathIndex = script.indexOf('resolve_user_path() {');
  assert(
    requireFunctionIndex !== -1 && requireFunctionIndex < resolvePathIndex,
    'install.sh must define require_node before node-backed helpers'
  );

  const mainRequireIndex = script.lastIndexOf('\nrequire_node\n');
  const configureIndex = script.lastIndexOf('\nconfigure_shared_homunculus\n');
  assert(mainRequireIndex !== -1, 'install.sh main entry must call require_node before writes');
  assert(
    mainRequireIndex < configureIndex,
    'install.sh must run require_node before configure_shared_homunculus'
  );
}

function testCodexInstallStillHasNodePreflight() {
  const script = read('install-codex.sh');

  assertIncludes(script, 'require_node() {', 'install-codex.sh');
  assertIncludes(script, 'Node.js >= 18 required', 'install-codex.sh');
  assertIncludes(script, 'install_project() {', 'install-codex.sh');
  assertIncludes(script, 'install_user() {', 'install-codex.sh');
}

function testMacosWorkflowExists() {
  const workflowPath = '.github/workflows/macos-cross-platform.yml';
  const workflowAbs = path.join(repoRoot, workflowPath);
  assert(fs.existsSync(workflowAbs), `${workflowPath} does not exist`);

  const workflow = read(workflowPath);
  for (const needle of [
    'runs-on: macos-latest',
    'bash -n install.sh',
    'bash -n install-codex.sh',
    'node scripts/agent-orchestrator.js self-test',
    'node scripts/validate-codex-plugin.js',
    'node scripts/validate-codex-install.js --project',
    'node scripts/validate-claude-install.js --project',
    'node scripts/smoke-pre-commit.js',
    'node scripts/smoke-memory-parity.js',
    'node scripts/smoke-relevance.js',
    'node scripts/smoke-cross-platform.js',
    'bash "$GITHUB_WORKSPACE/install.sh" --project',
    'bash "$GITHUB_WORKSPACE/install-codex.sh" --project',
  ]) {
    assertIncludes(workflow, needle, workflowPath);
  }
}

function testProjectPlanDirectoriesAreTracked() {
  for (const rel of [
    '.claude/plans/.gitkeep',
    '.codex/plans/.gitkeep',
  ]) {
    assert(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist so clean checkouts keep the plans directory`);
  }

  const attributes = read('.gitattributes');
  assertIncludes(attributes, '/.claude/**/.gitkeep text eol=lf', '.gitattributes');
  assertIncludes(attributes, '/.codex/**/.gitkeep text eol=lf', '.gitattributes');
}

function testSharedHomunculusNoopDoesNotAbortInstall() {
  const claudeScript = read('install.sh');
  assertIncludes(
    claudeScript,
    '[[ -n "${SHARED_HOMUNCULUS:-}" ]] || return 0',
    'install.sh configure_shared_homunculus'
  );

  const codexScript = read('install-codex.sh');
  assertIncludes(
    codexScript,
    '[[ -n "${SHARED_HOMUNCULUS:-}" ]] || return 0',
    'install-codex.sh configure_shared_homunculus'
  );
}

function testClaudeProjectInstallCreatesPlansDirectory() {
  const script = read('install.sh');
  assertIncludes(script, 'mkdir -p "${claude_dir}/plans"', 'install.sh install_project');

  const workflow = read('.github/workflows/macos-cross-platform.yml');
  assertIncludes(workflow, 'test -d ".claude/plans"', '.github/workflows/macos-cross-platform.yml');
}

process.stdout.write('\nsmoke: cross-platform install and macOS CI\n');
run('install.sh fails fast when Node.js is missing or too old', testInstallShNodePreflight);
run('install-codex.sh keeps Node.js preflight', testCodexInstallStillHasNodePreflight);
run('macOS workflow covers POSIX install and core smoke checks', testMacosWorkflowExists);
run('project plans directories survive clean checkouts', testProjectPlanDirectoriesAreTracked);
run('unset shared homunculus is a successful no-op', testSharedHomunculusNoopDoesNotAbortInstall);
run('Claude project install creates plans directory', testClaudeProjectInstallCreatesPlansDirectory);

process.stdout.write(`\nresult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const item of failures) {
    process.stderr.write(`\n${item.name}\n${item.error}\n`);
  }
  process.exit(1);
}
