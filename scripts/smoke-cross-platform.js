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

function testCiWorkflowExists() {
  const workflowPath = '.github/workflows/macos-cross-platform.yml';
  const workflowAbs = path.join(repoRoot, workflowPath);
  assert(fs.existsSync(workflowAbs), `${workflowPath} does not exist`);

  const workflow = read(workflowPath);
  for (const needle of [
    'runs-on: ${{ matrix.os }}',
    'ubuntu-latest',
    'macos-latest',
    'windows-latest',
    'shell: bash',
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
    'node scripts/run-tests.js',
    "if: matrix.os != 'windows-latest'",
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

function testPowerShellInstallersDoNotBackupUnchangedFiles() {
  const claudeInstaller = read('install.ps1');
  assertIncludes(claudeInstaller, 'function Test-SameFileContent', 'install.ps1');
  assertIncludes(claudeInstaller, 'Prune-InstallBackups $d', 'install.ps1');
  assertIncludes(claudeInstaller, 'if (Test-SameFileContent $s $d)', 'install.ps1');

  const codexInstaller = read('install-codex.ps1');
  assertIncludes(codexInstaller, 'function Test-SameTextContent', 'install-codex.ps1');
  assertIncludes(codexInstaller, 'function Test-SameDirectoryContent', 'install-codex.ps1');
  assertIncludes(codexInstaller, '[string[]]$ExcludeNames = @()', 'install-codex.ps1');
  assertIncludes(codexInstaller, 'Prune-InstallBackups $target', 'install-codex.ps1');
  assertIncludes(codexInstaller, 'if (Test-SameTextContent $target $converted)', 'install-codex.ps1');
  assertIncludes(codexInstaller, '$projectCommandNames', 'install-codex.ps1');
  assertIncludes(codexInstaller, 'plugin already up to date', 'install-codex.ps1');

  const pluginInstaller = read('install-plugin.ps1');
  assertIncludes(pluginInstaller, '[switch]$All', 'install-plugin.ps1');
  assertIncludes(pluginInstaller, 'function Show-Help', 'install-plugin.ps1');
}

function testUnifiedPowerShellInstallerCoversAllWindowsInstallers() {
  const unifiedInstallerPath = 'install-all.ps1';
  assert(fs.existsSync(path.join(repoRoot, unifiedInstallerPath)), `${unifiedInstallerPath} does not exist`);

  const script = read(unifiedInstallerPath);
  for (const needle of [
    'install.ps1',
    'install-codex.ps1',
    'install-plugin.ps1',
    '[switch]$SkipLegacy',
    '[switch]$SkipCodex',
    '[switch]$SkipPlugin',
    '[switch]$DryRun',
    '[switch]$ContinueOnError',
    'If no target switch is provided, this script defaults to -All.',
  ]) {
    assertIncludes(script, needle, unifiedInstallerPath);
  }
}

process.stdout.write('\nsmoke: cross-platform install and macOS CI\n');
run('install.sh fails fast when Node.js is missing or too old', testInstallShNodePreflight);
run('install-codex.sh keeps Node.js preflight', testCodexInstallStillHasNodePreflight);
run('cross-platform CI workflow covers matrix os, smoke checks, and unit tests', testCiWorkflowExists);
run('project plans directories survive clean checkouts', testProjectPlanDirectoriesAreTracked);
run('unset shared homunculus is a successful no-op', testSharedHomunculusNoopDoesNotAbortInstall);
run('Claude project install creates plans directory', testClaudeProjectInstallCreatesPlansDirectory);
run('PowerShell installers skip unchanged-file backups and prune old .bak files', testPowerShellInstallersDoNotBackupUnchangedFiles);
run('unified PowerShell installer covers legacy, Codex, and plugin installers', testUnifiedPowerShellInstallerCoversAllWindowsInstallers);

process.stdout.write(`\nresult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const item of failures) {
    process.stderr.write(`\n${item.name}\n${item.error}\n`);
  }
  process.exit(1);
}
