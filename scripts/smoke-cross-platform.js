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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

function testBashCodexTextProjectionIsNoopWhenUnchanged() {
  const installer = read('install-codex.sh');
  assertIncludes(installer, 'TEXT_ASSET_INSTALL_SCRIPT="${SCRIPT_DIR}/scripts/install-codex-text-asset.js"', 'install-codex.sh');
  assertIncludes(installer, 'node "$TEXT_ASSET_INSTALL_SCRIPT"', 'install-codex.sh');
  const { installCodexTextAsset } = require('./install-codex-text-asset');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-copy-noop-'));
  try {
    const source = path.join(tempRoot, 'source.md');
    const target = path.join(tempRoot, 'target.md');
    fs.writeFileSync(source, 'Use Claude Code and CLAUDE.md.\n');
    installCodexTextAsset({ allowedRoot: tempRoot, source, target, mode: 'backup' });
    const firstBytes = fs.readFileSync(target);
    installCodexTextAsset({ allowedRoot: tempRoot, source, target, mode: 'backup' });
    assert(fs.readFileSync(target).equals(firstBytes), 'unchanged projection must retain exact target bytes');
    assert(
      fs.readdirSync(tempRoot).filter((name) => name.startsWith('target.md.bak.')).length === 0,
      'unchanged projection must not create a backup'
    );

    fs.writeFileSync(target, 'locally changed\n');
    installCodexTextAsset({ allowedRoot: tempRoot, source, target, mode: 'backup' });
    const backups = fs.readdirSync(tempRoot).filter((name) => name.startsWith('target.md.bak.'));
    assert(backups.length === 1, 'changed projection must retain exactly one unique backup');
    assert(fs.readFileSync(path.join(tempRoot, backups[0]), 'utf8') === 'locally changed\n', 'backup must preserve original bytes');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function testBashCodexTextProjectionRejectsInjectedRaces() {
  const { installCodexTextAsset } = require('./install-codex-text-asset');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-copy-cas-'));
  try {
    const source = path.join(tempRoot, 'source.md');
    fs.writeFileSync(source, 'Use Claude Code and CLAUDE.md.\n');

    const existingTarget = path.join(tempRoot, 'existing.md');
    fs.writeFileSync(existingTarget, 'initial\n');
    let existingConflict = null;
    try {
      installCodexTextAsset({
        allowedRoot: tempRoot,
        source,
        target: existingTarget,
        mode: 'backup',
        testHooks: {
          beforeClaim() {
            fs.writeFileSync(existingTarget, 'external-existing\n');
          },
        },
      });
    } catch (error) {
      existingConflict = error;
    }
    assert(existingConflict, 'an existing-target race must fail closed');
    assert(
      /compare-and-swap|concurrent/i.test(existingConflict.message),
      `existing-target race must report a CAS conflict: ${existingConflict.message}`
    );
    assert(
      fs.readFileSync(existingTarget, 'utf8') === 'external-existing\n',
      'an existing-target race must retain external bytes'
    );

    const absentTarget = path.join(tempRoot, 'absent.md');
    let absentConflict = null;
    try {
      installCodexTextAsset({
        allowedRoot: tempRoot,
        source,
        target: absentTarget,
        mode: 'backup',
        testHooks: {
          beforePublish() {
            fs.writeFileSync(absentTarget, 'external-created\n');
          },
        },
      });
    } catch (error) {
      absentConflict = error;
    }
    assert(absentConflict, 'an absent-target creation race must fail closed');
    assert(
      /compare-and-swap|concurrent/i.test(absentConflict.message),
      `absent-target race must report a CAS conflict: ${absentConflict.message}`
    );
    assert(
      fs.readFileSync(absentTarget, 'utf8') === 'external-created\n',
      'an absent-target race must retain the externally created file'
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
function bashFunctionBody(installer, name, nextName) {
  const start = installer.indexOf(`${name}() {`);
  const end = installer.indexOf(`${nextName}() {`, start + 1);
  assert(start >= 0 && end > start, `cannot isolate Bash function ${name}`);
  return installer.slice(start, end).trim();
}

function testBashActivationRenameRejectsExistingTarget() {
  const installer = read('install-codex.sh');
  const body = bashFunctionBody(
    installer,
    'rename_directory_if_target_absent',
    'install_codex_plugin_bundle'
  );
  const match = body.match(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/);
  assert(match, 'cannot isolate the Node-backed Bash activation rename program');
  const program = match[1]
    .replace(
      'const [sourceInput, targetInput] = process.argv.slice(2);',
      'const [sourceInput, targetInput] = inputs;'
    )
    .replace('process.exit(17);', 'throw Object.assign(new Error("target exists"), { code: 17 });');
  const runRename = (source, target) => new Function('require', 'inputs', 'console', program)(
    require,
    [source, target],
    { error() {} }
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-activation-rename-'));
  try {
    const source = path.join(tempRoot, 'stage');
    const target = path.join(tempRoot, 'target');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'payload.txt'), 'new');
    runRename(source, target);
    assert(!fs.existsSync(source), 'successful publication must consume the stage directory');
    assert(fs.readFileSync(path.join(target, 'payload.txt'), 'utf8') === 'new', 'published bytes changed');

    const collidingSource = path.join(tempRoot, 'colliding-stage');
    const collidingTarget = path.join(tempRoot, 'colliding-target');
    fs.mkdirSync(collidingSource);
    fs.mkdirSync(collidingTarget);
    fs.writeFileSync(path.join(collidingSource, 'payload.txt'), 'staged');
    fs.writeFileSync(path.join(collidingTarget, 'payload.txt'), 'concurrent');
    let collisionCode = 0;
    try {
      runRename(collidingSource, collidingTarget);
    } catch (error) {
      collisionCode = error.code;
    }
    assert(collisionCode === 17, `existing-target rename must fail with collision status 17; got ${collisionCode}`);
    assert(fs.readFileSync(path.join(collidingSource, 'payload.txt'), 'utf8') === 'staged', 'collision must retain staged bytes');
    assert(fs.readFileSync(path.join(collidingTarget, 'payload.txt'), 'utf8') === 'concurrent', 'collision must retain concurrent target bytes');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function testBashOwnerPidIsLiveToNode() {
  const installer = read('install-codex.sh');
  const resolver = bashFunctionBody(installer, 'resolve_installer_owner_pid', 'build_plugin');
  const bash = process.platform === 'win32' && fs.existsSync('C:\\Apps\\Git\\bin\\bash.exe')
    ? 'C:\\Apps\\Git\\bin\\bash.exe'
    : 'bash';
  const script = `${resolver}\nowner_pid="$(resolve_installer_owner_pid)" || exit $?\nprintf 'shell=%s owner=%s platform=%s\\n' "$$" "$owner_pid" "$(uname -s)"`;
  const result = spawnSync(bash, ['-c', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error && result.error.code === 'EPERM') {
    process.stdout.write('    skip Git Bash process creation blocked by Windows sandbox\n');
    return;
  }
  assert(!result.error, `cannot execute Bash owner PID probe: ${result.error && result.error.message}`);
  if (
    process.platform === 'win32'
    && result.status !== 0
    && /couldn't create signal pipe, Win32 error 5/i.test(result.stderr || '')
  ) {
    process.stdout.write('    skip Git Bash process creation blocked by Windows sandbox\n');
    return;
  }
  assert(result.status === 0, `Bash owner PID must be live to Node: ${result.stderr || result.stdout}`);
  const fields = Object.fromEntries(
    result.stdout.trim().split(/\s+/).map((item) => item.split('=', 2))
  );
  assert(/^\d+$/.test(fields.shell || ''), `invalid Bash shell PID evidence: ${result.stdout}`);
  assert(/^\d+$/.test(fields.owner || ''), `invalid Node-visible owner PID evidence: ${result.stdout}`);
  if (/^(MINGW|MSYS|CYGWIN)/.test(fields.platform || '')) {
    assert(fields.owner !== fields.shell, 'Git Bash must not pass its Node-invisible virtual PID as lock owner');
  } else {
    assert(fields.owner === fields.shell, 'POSIX Bash must preserve the real outer shell PID');
  }

  const simulatedWinPid = '999999';
  const collisionScript = `${resolver}
uname() { printf 'MINGW64_NT-test\\n'; }
ps() {
  printf 'PID PPID PGID WINPID TTY UID STIME COMMAND\\n'
  printf '%s 1 %s ${simulatedWinPid} ? 1 00:00:00 /usr/bin/bash\\n' "$$" "$$"
}
node() { printf 'probe=%s\\n' "$3" >&2; return 0; }
owner_pid="$(resolve_installer_owner_pid)" || exit $?
printf 'shell=%s owner=%s\\n' "$$" "$owner_pid"`;
  const collision = spawnSync(bash, ['-c', collisionScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(!collision.error, `cannot execute simulated MSYS PID collision probe: ${collision.error && collision.error.message}`);
  assert(collision.status === 0, `simulated MSYS PID collision probe failed: ${collision.stderr || collision.stdout}`);
  const collisionFields = Object.fromEntries(
    collision.stdout.trim().split(/\s+/).map((item) => item.split('=', 2))
  );
  assert(collisionFields.owner === simulatedWinPid, `MSYS virtual PID collision bypassed WINPID mapping: ${collision.stdout}`);
  assert(collisionFields.owner !== collisionFields.shell, `MSYS virtual PID collision returned the unrelated live PID: ${collision.stdout}`);
  assert(collision.stderr.trim() === `probe=${simulatedWinPid}`, `Node must probe only the mapped WINPID: ${collision.stderr}`);
}

function testCodexInstallersUseOneRuntimeOwner() {
  const bashInstaller = read('install-codex.sh');
  const fallbackHelper = read('scripts/install-managed-project-fallback.js');
  for (const needle of [
    'codex plugin marketplace add "$HOME"',
    '--fix --install-canonical',
    '--plugin-owner-status --json',
    '${PLUGIN_SOURCE}/codex-skills',
    '${SCRIPT_DIR}/codex-native/commands',
    'compound.md|plan.md|review.md|sprint.md|think.md|work.md',
    'refresh_codex_plugin_cache',
    '${SCRIPT_DIR}/scripts/install-managed-project-fallback.js',
    '--user-codex-home "$CODEX_HOME"',
    'plugin_fingerprint() {',
    'mktemp -d',
    'fs.lstatSync(value)',
    'fs.realpathSync.native',
    'Previous plugin restored after activation failure',
    'rm -rf -- "$stage/commands"',
    'codex-user-install-transaction.js',
    'run_user_install_step',
    'rollback_user_install_transaction',
    'CODEX_INSTALL_FAIL_AT',
    'transaction commit',
    "trap 'user_install_exit_trap $?' EXIT",
    "trap 'user_install_signal_trap 130 INT' INT",
    "trap 'user_install_signal_trap 143 TERM' TERM",
    '--phase "marketplace-file"',
    '--phase "marketplace"',
    '--phase "cache"',
    '--phase "doctor"',
    'scripts/install-codex-agents.js',
    '${SCRIPT_DIR}/codex-native/agents/user.md',
    '${SCRIPT_DIR}/codex-native/agents/project.md',
    'if result="$(node "$CODEX_AGENTS_INSTALL_SCRIPT"',
    'if node "$MARKETPLACE_UPDATE_SCRIPT"',
    'if initialize_homunculus; then',
    'if install_codex_user_assets; then',
  ]) {
    assertIncludes(bashInstaller, needle, 'install-codex.sh');
  }
  assert(!bashInstaller.includes('REPO_AGENTS_PLUGINS_DIR'), 'install-codex.sh must not maintain a repo marketplace');
  assert(!bashInstaller.includes('continuous-learning hooks copied'), 'install-codex.sh must not copy user hooks');
  assert(!bashInstaller.includes('node - "$skills_source"'), 'install-codex.sh must not retain an embedded fallback implementation');
  assert(!bashInstaller.includes('.stage.$$.${RANDOM}'), 'Bash stage paths must not use predictable PID/RANDOM names');
  assert(!bashInstaller.includes('mkdir -p "$stage"'), 'Bash stage allocation must be exclusive');
  assert(!bashInstaller.includes('if ! {'), 'Bash post-commit steps must not rely on a negated command group');
  const textAssetHelper = read('scripts/install-codex-text-asset.js');
  assertIncludes(textAssetHelper, 'readTargetExpectation(target)', 'Codex text asset helper');
  assertIncludes(textAssetHelper, 'publishTextCompareAndSwap(target, converted, expectation', 'Codex text asset helper');
  assertIncludes(textAssetHelper, 'expectation.raw.equals(converted)', 'Codex text asset helper');
  assertIncludes(bashInstaller, 'node "$TEXT_ASSET_INSTALL_SCRIPT"', 'install-codex.sh');

  const powershellInstaller = read('install-codex.ps1');
  for (const needle of [
    'codex plugin marketplace add $HomeDir',
    '--fix --install-canonical',
    '--plugin-owner-status --json',
    'Join-Path $PluginSource "codex-skills"',
    'Join-Path $ScriptDir "codex-native\\commands"',
    'Refresh-CodexPluginCache',
    'scripts\\install-managed-project-fallback.js',
    '--user-codex-home $CodexHome',
    'function Install-CodexPluginBundle',
    'Staged plugin fingerprint mismatch',
    'Previous plugin restored after activation failure',
    'Test-SameCodexPluginBundle',
    'codex-user-install-transaction.js',
    'Invoke-CodexUserInstallTransaction -Action "prepare"',
    'Invoke-CodexUserInstallTransaction -Action "rollback"',
    'CODEX_INSTALL_FAIL_AT',
    '-Action "checkpoint"',
    '-Phase "marketplace-file"',
    '-Phase "marketplace"',
    '-Phase "cache"',
    '-Phase "doctor"',
    'scripts\\install-codex-agents.js',
    'codex-native\\agents\\user.md',
    'codex-native\\agents\\project.md',
    'function Install-CodexAgentsFile',
    '$helperExit -ne 0 -and $helperExit -ne 2',
  ]) {
    assertIncludes(powershellInstaller, needle, 'install-codex.ps1');
  }
  assert(!powershellInstaller.includes('$RepoAgentsPluginsDir'), 'install-codex.ps1 must not maintain a repo marketplace');
  assert(!powershellInstaller.includes('continuous-learning hooks copied'), 'install-codex.ps1 must not copy user hooks');
  assert(!powershellInstaller.includes('$fallbackScript = @\''), 'install-codex.ps1 must not retain an embedded fallback implementation');
  assert(!powershellInstaller.includes('Prune-InstallBackups'), 'install-codex.ps1 must retain all unproven backups');
  assert(!powershellInstaller.includes('INSTALL_BAK_RETENTION'), 'install-codex.ps1 must not prune backups by wildcard retention');

  const transactionHelper = read('scripts/codex-user-install-transaction.js');
  for (const needle of [
    'probe-owners-before-install',
    'probe-marketplace-before-install',
    'afterActivation',
    'restore-plugin-target',
    'restore-marketplace-file',
    'verifyRollbackControlSurfaces',
    'rollback owner metadata drift',
    "recoverySurfaces.push('owners')",
    'automatic owner cleanup is disabled',
    'no version/source CAS',
    "recoverySurfaces.push('marketplaceRegistration')",
    "state = 'rollback-failed'",
    'environment.APPDATA',
    'nodeExecutable',
    "source: 'windows-npm-cli'",
    "source: 'path-fallback'",
    'unsafe plugin id',
    'duplicate plugin ids',
    'snapshotPluginCaches',
    'cache checkpoint byte mismatch',
    'rollback ownership gate',
    'checkpointTransaction',
  ]) {
    assertIncludes(transactionHelper, needle, 'scripts/codex-user-install-transaction.js');
  }

  for (const needle of [
    "const OWNER_MANIFEST = 'tech-persistence-owner.json'",
    'inspectManagedSkillExclusions',
    'inspectDisabledSkillPaths',
    'assertSafeManagedPath',
    'after-config-write',
  ]) {
    assertIncludes(fallbackHelper, needle, 'scripts/install-managed-project-fallback.js');
  }
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

function testPowerShellInstallersRetainBackupsAndSkipUnchangedFiles() {
  const claudeInstaller = read('install.ps1');
  assertIncludes(claudeInstaller, 'function Test-SameFileContent', 'install.ps1');
  assertIncludes(claudeInstaller, 'Prune-InstallBackups $d', 'install.ps1');
  assertIncludes(claudeInstaller, 'if (Test-SameFileContent $s $d)', 'install.ps1');

  const codexInstaller = read('install-codex.ps1');
  assertIncludes(codexInstaller, '$TextAssetInstallScript = Join-Path $ScriptDir "scripts\\install-codex-text-asset.js"', 'install-codex.ps1');
  assertIncludes(codexInstaller, 'function Test-SameDirectoryContent', 'install-codex.ps1');
  assertIncludes(codexInstaller, '[string[]]$ExcludeNames = @()', 'install-codex.ps1');
  assertIncludes(codexInstaller, '& node @args', 'install-codex.ps1');
  assertIncludes(codexInstaller, 'Codex text asset compare-and-swap failed', 'install-codex.ps1');
  assertIncludes(codexInstaller, '$projectCommandNames', 'install-codex.ps1');
  assertIncludes(codexInstaller, 'plugin already up to date', 'install-codex.ps1');
  assert(!codexInstaller.includes('Prune-InstallBackups'), 'install-codex.ps1 must not remove unproven backups');
  assert(!codexInstaller.includes('Get-BackupFiles'), 'install-codex.ps1 must not enumerate backups by wildcard');

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
run('Bash Codex text projection skips unchanged backups and preserves changed bytes', testBashCodexTextProjectionIsNoopWhenUnchanged);
run('Bash Codex text projection rejects injected target races', testBashCodexTextProjectionRejectsInjectedRaces);
run('Bash activation rename preserves stage and target on collision', testBashActivationRenameRejectsExistingTarget);
run('Bash transaction owner PID is live to Node', testBashOwnerPidIsLiveToNode);
run('Codex installers enforce one plugin owner with a conditional managed fallback', testCodexInstallersUseOneRuntimeOwner);
run('cross-platform CI workflow covers matrix os, smoke checks, and unit tests', testCiWorkflowExists);
run('project plans directories survive clean checkouts', testProjectPlanDirectoriesAreTracked);
run('unset shared homunculus is a successful no-op', testSharedHomunculusNoopDoesNotAbortInstall);
run('Claude project install creates plans directory', testClaudeProjectInstallCreatesPlansDirectory);
run('PowerShell installers skip unchanged files and Codex retains all backups', testPowerShellInstallersRetainBackupsAndSkipUnchangedFiles);
run('unified PowerShell installer covers legacy, Codex, and plugin installers', testUnifiedPowerShellInstallerCoversAllWindowsInstallers);

process.stdout.write(`\nresult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const item of failures) {
    process.stderr.write(`\n${item.name}\n${item.error}\n`);
  }
  process.exit(1);
}
