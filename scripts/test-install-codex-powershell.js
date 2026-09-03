#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = path.join(repoRoot, 'install-codex.ps1');
const source = fs.readFileSync(installer, 'utf8');
const fallbackHelper = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'install-managed-project-fallback.js'),
  'utf8'
);
const transactionHelper = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'codex-user-install-transaction.js'),
  'utf8'
);
const pluginCliHelper = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'codex-plugin-cli.js'),
  'utf8'
);
const jsonAssetHelper = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'install-codex-json-asset.js'),
  'utf8'
);const textAssetHelper = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'install-codex-text-asset.js'),
  'utf8'
);
const bashInstaller = fs.readFileSync(path.join(repoRoot, 'install-codex.sh'), 'utf8');
const nonAsciiLines = source
  .split(/\r?\n/)
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => /[^\x00-\x7F]/.test(line));

assert.deepStrictEqual(
  nonAsciiLines,
  [],
  `install-codex.ps1 must stay ASCII-only for Windows PowerShell 5.1 no-BOM parsing.\n${nonAsciiLines
    .map(({ number, line }) => `${number}: ${line}`)
    .join('\n')}`
);

function functionBody(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `cannot isolate ${name}`);
  return source.slice(start, end);
}

const userAssetsBody = functionBody('Install-CodexUserAssets', 'Build-Plugin');
const pluginInstallBody = functionBody('Install-CodexPluginBundle', 'Update-Marketplace');
const installUserBody = functionBody('Install-User', 'Install-Project');
const installProjectBody = functionBody('Install-Project', 'Import-ClaudeHomunculus');
assert.ok(!userAssetsBody.includes('Copy-CodexSkillDir'), 'user assets must not copy direct skills');
assert.ok(!userAssetsBody.includes('continuous-learning'), 'user assets must not copy direct hooks');
assert.ok(source.includes('$CodexAgentsInstallScript = Join-Path $ScriptDir "scripts\\install-codex-agents.js"'), 'PowerShell must use the shared safe AGENTS installer');
assert.ok(source.includes('function Install-CodexAgentsFile'), 'PowerShell must centralize AGENTS helper exit handling');
assert.ok(source.includes('$helperExit -ne 0 -and $helperExit -ne 2'), 'PowerShell must accept only optimized or preserved-custom AGENTS outcomes');
assert.ok(userAssetsBody.includes('codex-native\\agents\\user.md'), 'user install must use the Codex-native user AGENTS template');
assert.ok(source.includes('codex-native\\agents\\project.md'), 'project install must use the Codex-native project AGENTS template');
assert.ok(!userAssetsBody.includes('Copy-CodexText (Join-Path $ScriptDir "user-level\\CLAUDE.md")'), 'user install must not project the legacy Claude root prompt into AGENTS.md');
assert.ok(source.includes('$TextAssetInstallScript = Join-Path $ScriptDir "scripts\\install-codex-text-asset.js"'), 'PowerShell must use the shared text asset CAS installer');
assert.ok(source.includes('Codex text asset compare-and-swap failed'), 'PowerShell text projection must fail closed on CAS conflicts');
assert.ok(textAssetHelper.includes('readTargetExpectation(target)'), 'text asset helper must capture target raw/hash state');
assert.ok(textAssetHelper.includes('publishTextCompareAndSwap(target, converted, expectation'), 'text asset helper must bind publication to the captured target state');
assert.ok(source.includes('$CodexPluginCli = Join-Path $CodexHome "plugins\\.plugin-appserver\\codex.exe"'), 'PowerShell must prefer the Codex Desktop plugin CLI');
assert.ok(source.includes('& $CodexPluginCli plugin marketplace add $HomeDir --json'), 'canonical marketplace root must be the user home');
assert.ok(source.includes('--fix --install-canonical'), 'explicit user installer must invoke the safe runtime repair');
assert.ok(source.includes('--plugin-owner-status --json'), 'project installer must probe plugin ownership');
assert.ok(source.includes('Join-Path $PluginSource "codex-skills"'), 'project fallback must use Codex-native skills');
assert.ok(source.includes('Join-Path $ScriptDir "codex-native\\commands"'), 'direct commands must use Codex-native overrides');
assert.ok(
  installProjectBody.includes('$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json'),
  'project catalog must be decoded explicitly as UTF-8 under Windows PowerShell 5.1'
);
assert.ok(source.includes('scripts\\install-managed-project-fallback.js'), 'project fallback must use the shared Node helper');
assert.ok(source.includes('--user-codex-home $CodexHome'), 'project fallback must reconcile user-level skill exclusions');
assert.ok(!source.includes('$fallbackScript = @\''), 'PowerShell must not retain a second embedded fallback implementation');
assert.ok(fallbackHelper.includes("const OWNER_MANIFEST = 'tech-persistence-owner.json'"), 'shared helper must write an owner manifest');
assert.ok(fallbackHelper.includes('assertSafeManagedPath'), 'shared helper must enforce symlink and realpath boundaries');
assert.ok(!source.includes('$RepoAgentsPluginsDir'), 'installer must not maintain a second repo marketplace');
assert.ok(source.includes('function Install-CodexPluginBundle'), 'plugin refresh must use an isolated installer function');
assert.ok(source.includes('Staged plugin fingerprint mismatch'), 'plugin stage must be fingerprint-verified');
assert.ok(source.includes('Refresh-CodexPluginCache'), 'installer must refresh the installed canonical plugin cache');
assert.ok(source.includes('& $CodexPluginCli plugin add "$PluginName@local-plugins" --json'), 'cache refresh must use the resolved official Codex plugin command');
assert.ok(transactionHelper.includes("require('./codex-plugin-cli')"), 'transaction helper must share the Codex plugin CLI resolver');
assert.ok(source.includes('Test-SameCodexPluginBundle'), 'Codex bundle must have a runtime-specific fingerprint');
assert.ok(source.includes('Remove-Item -LiteralPath $legacyCommands'), 'Codex bundle must omit legacy commands before activation');
assert.ok(source.includes('Existing plugin backed up to $backup'), 'plugin activation must retain a backup');
assert.ok(source.includes('Previous plugin restored after activation failure'), 'failed activation must restore its backup');
assert.ok(source.includes('Invoke-CodexUserInstallTransaction -Action "prepare"'), 'user install must snapshot before target activation');
assert.ok(source.includes('"--owner-pid", $PID'), 'PowerShell prepare must bind the transaction lock to the outer installer PID');
assert.ok(pluginInstallBody.includes('[Parameter(Mandatory = $true)][string]$TransactionManifest'), 'PowerShell plugin activation must receive the prepared transaction manifest');
const beforeClaimIndex = pluginInstallBody.indexOf('-Phase "before-claim"');
const targetClaimIndex = pluginInstallBody.indexOf('[System.IO.Directory]::Move($PluginTarget, $backup)');
const claimedGateIndex = pluginInstallBody.indexOf('-Phase "claimed"', targetClaimIndex);
const publishAbsentIndex = pluginInstallBody.indexOf('Canonical plugin target appeared before staged plugin publication');
const publishIndex = pluginInstallBody.indexOf('[System.IO.Directory]::Move($stage, $PluginTarget)');
assert.ok(
  beforeClaimIndex >= 0
    && targetClaimIndex > beforeClaimIndex
    && claimedGateIndex > targetClaimIndex
    && publishAbsentIndex > claimedGateIndex
    && publishIndex > publishAbsentIndex,
  'PowerShell activation must gate before claim, validate the claim, and require an absent target before publication'
);
assert.ok(pluginInstallBody.includes('-ClaimedPath $backup'), 'PowerShell claimed gate must verify the preserved original bytes');
assert.ok(pluginInstallBody.includes('(Get-DirectoryFingerprint $backup) -ne $originalTargetFingerprint'), 'PowerShell must fingerprint the exact claimed directory before any restore');
assert.ok(pluginInstallBody.includes('Previous plugin remains preserved at $backup because the claim is unverified or the canonical target is occupied'), 'PowerShell claim failure must preserve old bytes when the claim is unverified or a concurrent target appears');
for (const moveLine of pluginInstallBody.match(/^\s*Move-Item .*$/gm) || []) {
  assert.ok(!/\s-Force(?:\s|$)/.test(moveLine), `PowerShell activation Move-Item must remain non-Force: ${moveLine.trim()}`);
}
assert.ok(bashInstaller.includes('local shell_pid="$$"'), 'Bash owner resolution must start from the outer shell PID');
assert.ok(bashInstaller.includes('ps_output="$(ps -W)"'), 'Git Bash must capture its process table without last-command exec replacement');
assert.ok(bashInstaller.includes('printf \'%s\\n\' "$ps_output" | awk -v pid="$shell_pid"'), 'Git Bash must map its virtual PID through the captured MSYS process table');
assert.ok(bashInstaller.includes('matches != 1'), 'Git Bash PID mapping must fail closed unless exactly one process matches');
assert.ok(bashInstaller.includes('--owner-pid "$installer_owner_pid"'), 'Bash prepare must pass the live outer installer process PID');
assert.ok(bashInstaller.includes('local transaction_manifest="$1"'), 'Bash plugin activation must receive the prepared transaction manifest');
assert.ok(bashInstaller.includes('--phase "before-claim"'), 'Bash activation must run the before-claim gate');
assert.ok(bashInstaller.includes('--phase "claimed"'), 'Bash activation must run the claimed gate');
assert.ok(bashInstaller.includes('--claimed-path "$backup"'), 'Bash claimed gate must verify the preserved original bytes');
assert.ok(bashInstaller.includes('fs.lstatSync(target);'), 'Bash publication helper must immediately reject an existing canonical target');
assert.ok(bashInstaller.includes('fs.renameSync(source, target);'), 'Bash publication must use Node fs.rename after its collision check');
assert.ok(!bashInstaller.includes('mv "$stage" "$PLUGIN_TARGET"'), 'Bash must not let mv embed a stage in a concurrent target directory');
assert.ok(!bashInstaller.includes('mv "$PLUGIN_TARGET" "$backup"'), 'Bash must not let mv embed the canonical target in a concurrent backup directory');
assert.ok(bashInstaller.includes('backup_hash="$(plugin_fingerprint "$backup")"'), 'Bash must re-fingerprint claimed bytes before restoration');
assert.ok(bashInstaller.includes('stage and backup retained'), 'Bash collision failures must retain staged and claimed evidence');
assert.ok(source.includes('Invoke-CodexUserInstallTransaction -Action "activated"'), 'user install must snapshot after target activation');
for (const phase of ['marketplace-file', 'marketplace', 'cache', 'doctor']) {
  assert.ok(
    source.includes(`Invoke-CodexUserInstallTransaction -Action "checkpoint" -ManifestPath $transactionManifest -Phase "${phase}"`),
    `user install must persist the ${phase} checkpoint before continuing`
  );
}
assert.ok(source.includes('Invoke-CodexUserInstallTransaction -Action "commit"'), 'user install must verify before committing');
assert.ok(source.includes('Invoke-CodexUserInstallTransaction -Action "rollback"'), 'user install failures must invoke compensation');
for (const step of ['target', 'marketplace', 'cache', 'doctor', 'user-assets']) {
  assert.ok(source.includes(`Invoke-InstallFailureInjection "${step}"`), `missing ${step} failure injection`);
}
assert.ok(source.includes('Compensation also failed closed; evidence:'), 'compensation failure must retain evidence and fail closed');
assert.ok(source.includes('recovery-required'), 'post-commit failures must report an explicit recovery state');
assert.ok(
  /finally\s*\{[\s\S]*Invoke-CodexUserInstallCleanup/.test(installUserBody),
  'PowerShell transaction cleanup must run from finally so pipeline stop/Ctrl+C cannot bypass it'
);
assert.ok(
  source.includes('scripts\\update-codex-marketplace.js'),
  'PowerShell must use the shared lossless marketplace transformer'
);
assert.ok(
  source.includes('--manifest $TransactionManifest'),
  'PowerShell marketplace update must use the prepared manifest expectation'
);
assert.ok(
  bashInstaller.includes('--manifest "$transaction_manifest"'),
  'Bash marketplace update must use the prepared manifest expectation'
);
assert.ok(
  source.includes('& node @args') && bashInstaller.includes('node "$TEXT_ASSET_INSTALL_SCRIPT"'),
  'PowerShell and Bash post-commit text assets must use the shared CAS helper'
);
assert.ok(
  source.includes('plugin transaction committed, but post-commit user assets are incomplete'),
  'post-commit asset failure must not claim that the whole user install rolled back'
);
assert.ok(source.includes('scripts\\install-codex-json-asset.js'), 'PowerShell must use the shared JSON asset installer');
assert.ok(bashInstaller.includes('scripts/install-codex-json-asset.js'), 'Bash must use the shared JSON asset installer');
assert.ok(!/Copy-Item .*codex-homunculus-template\\config\.json/.test(source), 'PowerShell must not copy config.json non-atomically');
assert.ok(!/Write-Utf8NoBom \$registry/.test(source), 'PowerShell must not write projects.json directly');
assert.ok(!/cp .*codex-homunculus-template\/config\.json/.test(bashInstaller), 'Bash must not copy config.json non-atomically');
assert.ok(!/printf '\{\}\\n' > .*projects\.json/.test(bashInstaller), 'Bash must not truncate projects.json directly');
assert.ok(jsonAssetHelper.includes('retainPrevious: true'), 'invalid JSON assets must retain a unique backup');
assert.ok(jsonAssetHelper.includes('publishTextCompareAndSwap'), 'JSON assets must use no-clobber compare-and-swap publication');
assert.ok(transactionHelper.includes("'committed-lock-release-failed'"), 'commit lock failure must have an explicit non-success disposition');
assert.ok(transactionHelper.includes("'rolled-back-lock-release-failed'"), 'rollback lock failure must have an explicit non-success disposition');
assert.ok(transactionHelper.includes("'recovery-required-lock-release-failed'"), 'recovery lock failure must have an explicit non-success disposition');
assert.ok(source.includes('no rollback was attempted'), 'PowerShell must not rollback a committed terminal transaction');
assert.ok(bashInstaller.includes('no rollback was attempted'), 'Bash must not rollback a committed terminal transaction');
assert.ok(!source.includes('Prune-InstallBackups'), 'Codex installer must never prune unproven backups');
assert.ok(!source.includes('INSTALL_BAK_RETENTION'), 'Codex installer must not expose wildcard backup retention');
assert.ok(transactionHelper.includes("state = 'rollback-failed'"), 'transaction helper must persist rollback failure evidence');
assert.ok(!transactionHelper.includes("['plugin', 'add', owner.pluginId, '--json']"), 'rollback must not inverse-add an owner without CAS');
assert.ok(!transactionHelper.includes("['plugin', 'remove', owner.pluginId, '--json']"), 'rollback must not inverse-remove an owner without CAS');
assert.ok(!transactionHelper.includes("['plugin', 'marketplace', 'remove'"), 'rollback must not inverse-remove a marketplace without CAS');
assert.ok(transactionHelper.includes('automatic owner cleanup is disabled'), 'unsafe pre-install owners must fail before mutation');
assert.ok(transactionHelper.includes('verifyRollbackControlSurfaces'), 'rollback must re-verify owner metadata before every filesystem mutation');
assert.ok(transactionHelper.includes('rollback owner metadata drift'), 'rollback must fail closed when owner metadata differs from the prepared snapshot');
assert.ok(transactionHelper.includes("recoverySurfaces.push('owners')"), 'irreversible owner changes must become explicit recovery-required evidence');
assert.ok(transactionHelper.includes('rollback marketplace registration drift'), 'rollback must fail closed when marketplace registration differs from the prepared snapshot');
assert.ok(transactionHelper.includes("'verify-final-rollback'"), 'rollback must verify the complete byte-exact runtime after durable restore');
assert.ok(transactionHelper.includes('snapshotPluginCaches'), 'transaction prepare must snapshot actual plugin-cache bytes');
assert.ok(transactionHelper.includes('cache checkpoint byte mismatch'), 'cache checkpoint must reject same-version byte drift');
assert.ok(transactionHelper.includes('rollback ownership gate'), 'rollback must reject unknown or concurrent runtime state');
assert.ok(transactionHelper.includes('no version/source CAS'), 'rollback must expose the official CLI CAS limitation as evidence');
assert.ok(transactionHelper.includes("recoverySurfaces.push('marketplaceRegistration')"), 'irreversible marketplace registration drift must become recovery-required evidence');
assert.ok(transactionHelper.includes("checkpoint.phase !== 'doctor'"), 'commit must require the final doctor checkpoint');
assert.ok(pluginCliHelper.includes("'.plugin-appserver', 'codex.exe'"), 'Windows plugin operations must prefer the Codex Desktop plugin CLI');
assert.ok(pluginCliHelper.includes("path.join(\n      environment.APPDATA"), 'Windows plugin CLI resolver must retain the npm Codex fallback');
assert.ok(pluginCliHelper.includes("command: nodeExecutable"), 'Windows npm fallback must use process.execPath for the verified Codex entrypoint');
assert.ok(pluginCliHelper.includes("source: 'path-fallback'"), 'PATH fallback must remain available when verified entrypoints are absent');
assert.ok(!source.includes('[System.IO.File]::Replace('), 'PowerShell text projection must not retain the pre-CAS File.Replace path');
assert.ok(textAssetHelper.includes('expectedSha256: expectation.sha256'), 'text asset result must retain the captured SHA256 evidence');
assert.ok(textAssetHelper.includes('retainExpectedBackup(target, expectation)'), 'text asset backup must come from captured raw bytes');

const dryRunIndex = source.indexOf('& node $DoctorScript --reference-plugin-root $PluginTarget');
const fixIndex = source.indexOf('& node $DoctorScript --fix --install-canonical');
assert.ok(dryRunIndex >= 0 && fixIndex > dryRunIndex, 'runtime repair must always be preceded by a dry-run');

if (process.platform !== 'win32') {
  console.log('[SKIP] Windows PowerShell parser check requires Windows');
  process.exit(0);
}

const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Help'],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

const output = `${result.stdout || ''}${result.stderr || ''}`;

if (result.error && result.error.code === 'EPERM') {
  console.log('[SKIP] Windows PowerShell spawn blocked by environment');
  process.exit(0);
}

assert.ifError(result.error);
assert.strictEqual(
  result.status,
  0,
  `install-codex.ps1 must parse under Windows PowerShell 5.1.\n${output}`
);
assert.ok(!/ParserError|Unexpected token|Missing closing/i.test(output), output);

const catalogPath = path
  .join(repoRoot, 'project-level', 'profiles', 'catalog.json')
  .replaceAll("'", "''");
const catalogResult = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      `$catalog = Get-Content -LiteralPath '${catalogPath}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
      'if ($catalog.schemaVersion -ne 1) { throw "unexpected catalog schema" }',
      'if (@($catalog.profiles.PSObject.Properties).Count -ne 10) { throw "unexpected profile count" }',
      'if ([int][char]$catalog.profiles.base.description[0] -ne 0x6240) { throw "catalog text was not decoded as UTF-8" }',
    ].join('; '),
  ],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
const catalogOutput = `${catalogResult.stdout || ''}${catalogResult.stderr || ''}`;
assert.ifError(catalogResult.error);
assert.strictEqual(
  catalogResult.status,
  0,
  `project standards catalog must decode as UTF-8 under Windows PowerShell 5.1.\n${catalogOutput}`
);

const textAssetPath = path.join(repoRoot, 'scripts', 'install-codex-text-asset.js').replaceAll("'", "''");
const projectionHarness = [
  'function Ensure-Dir($path) { if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null } }',
  'function Write-Warn($msg) { Write-Output $msg }',
  `$TextAssetInstallScript = '${textAssetPath}'`,
  functionBody('Copy-CodexText', 'Copy-CodexCommandDir'),
  '$root = Join-Path ([System.IO.Path]::GetTempPath()) ("tp-cas-text-" + [guid]::NewGuid().ToString("N"))',
  '[void](New-Item -ItemType Directory -Path $root)',
  'try {',
  '  $sourcePath = Join-Path $root "source.md"',
  '  $target = Join-Path $root "target.md"',
  '  [System.IO.File]::WriteAllText($sourcePath, "Use Claude Code and CLAUDE.md.")',
  '  [System.IO.File]::WriteAllText($target, "initial")',
  '  Copy-CodexText $sourcePath $target -BackupExisting',
  '  if ([System.IO.File]::ReadAllText($target) -ne "Use Codex and AGENTS.md.") { throw "published text mismatch" }',
  '  $backups = @(Get-ChildItem -LiteralPath $root -Filter "target.md.bak.*")',
  '  if ($backups.Count -ne 1) { throw "expected one retained backup" }',
  '  if ([System.IO.File]::ReadAllText($backups[0].FullName) -ne "initial") { throw "backup bytes changed" }',
  '  [System.IO.File]::WriteAllText($target, "custom")',
  '  Copy-CodexText $sourcePath $target -NoOverwrite',
  '  if ([System.IO.File]::ReadAllText($target) -ne "custom") { throw "strict no-overwrite changed custom bytes" }',
  '} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }',
].join('\n');

const projectionResult = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', projectionHarness],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

const projectionOutput = `${projectionResult.stdout || ''}${projectionResult.stderr || ''}`;
assert.ifError(projectionResult.error);
assert.strictEqual(
  projectionResult.status,
  0,
  `Copy-CodexText must use guarded text publication under Windows PowerShell 5.1.\n${projectionOutput}`
);
console.log('[OK] install-codex.ps1 parses and uses guarded text publication under Windows PowerShell 5.1');
