#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildObsidianSyncPreflight,
  classifyActiveVault,
  normalizeMirrorRoot,
  parseArgs,
} = require('./obsidian-sync-preflight');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function markObsidianVault(vaultPath) {
  fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true });
}

function writeDesktopConfig(configPath, activeVault) {
  writeFile(configPath, JSON.stringify({
    vaults: {
      active: {
        path: activeVault,
        open: true,
        ts: 1,
      },
    },
  }));
}

test('classifyActiveVault separates shared, repo, other, and unknown vaults', () => {
  const root = makeDir('tp-preflight-classify-');
  const repo = path.join(root, 'repo');
  const shared = path.join(root, 'shared');
  const other = path.join(root, 'other');
  fs.mkdirSync(repo);
  fs.mkdirSync(shared);
  fs.mkdirSync(other);

  assert.strictEqual(classifyActiveVault(repo, shared, shared), 'shared');
  assert.strictEqual(classifyActiveVault(repo, shared, repo), 'repo');
  assert.strictEqual(classifyActiveVault(repo, shared, other), 'other');
  assert.strictEqual(classifyActiveVault(repo, shared, null), 'unknown');
  assert.strictEqual(normalizeMirrorRoot('\\_shared_homunculus\\'), '_shared_homunculus');

  fs.rmSync(root, { recursive: true, force: true });
});

test('buildObsidianSyncPreflight reports repo vault mirror mode', () => {
  const root = makeDir('tp-preflight-repo-');
  const repo = path.join(root, 'repo');
  const shared = path.join(root, 'shared');
  const config = path.join(root, 'obsidian.json');
  fs.mkdirSync(repo);
  fs.mkdirSync(shared);
  markObsidianVault(repo);
  markObsidianVault(shared);
  writeDesktopConfig(config, repo);

  const report = buildObsidianSyncPreflight(repo, {
    sharedVault: shared,
    desktopConfigPath: config,
  });

  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.repo.isObsidianVault, true);
  assert.strictEqual(report.sharedVault.exists, true);
  assert.strictEqual(report.sharedVault.configured, false);
  assert.strictEqual(report.desktop.activeVaultMode, 'repo');
  assert.strictEqual(report.desktop.desktopMirrorNeeded, true);
  assert.strictEqual(report.desktop.mirrorBase, path.join(repo, '_shared_homunculus'));
  assert.strictEqual(report.cloud.status, 'unknown');
  assert.ok(report.recommendedActions.some((action) => action.includes('sync-obsidian-desktop-vault.js')));

  fs.rmSync(root, { recursive: true, force: true });
});

test('buildObsidianSyncPreflight reports shared vault mode without mirror', () => {
  const root = makeDir('tp-preflight-shared-');
  const repo = path.join(root, 'repo');
  const shared = path.join(root, 'shared');
  const config = path.join(root, 'obsidian.json');
  fs.mkdirSync(repo);
  fs.mkdirSync(shared);
  markObsidianVault(shared);
  writeDesktopConfig(config, shared);

  const report = buildObsidianSyncPreflight(repo, {
    sharedVault: shared,
    desktopConfigPath: config,
  });

  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.desktop.activeVaultMode, 'shared');
  assert.strictEqual(report.desktop.desktopMirrorNeeded, false);
  assert.ok(report.recommendedActions.some((action) => action.includes('verify shared vault directly')));

  fs.rmSync(root, { recursive: true, force: true });
});

test('buildObsidianSyncPreflight reports unknown active vault without accidental .obsidian fallback', () => {
  const root = makeDir('tp-preflight-unknown-');
  const repo = path.join(root, 'repo');
  const shared = path.join(root, 'shared');
  fs.mkdirSync(repo);
  fs.mkdirSync(shared);
  markObsidianVault(repo);

  const report = buildObsidianSyncPreflight(repo, {
    sharedVault: shared,
    desktopConfigPath: path.join(root, 'missing-obsidian.json'),
  });

  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.desktop.activeVaultMode, 'unknown');
  assert.strictEqual(report.desktop.activeVaultIsObsidianVault, false);
  assert.strictEqual(report.desktop.mirrorBase, null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('parseArgs supports explicit preflight paths', () => {
  const options = parseArgs([
    'node',
    'scripts/obsidian-sync-preflight.js',
    '--repo-root',
    'repo',
    '--shared-vault',
    'shared',
    '--desktop-vault',
    'desktop',
    '--desktop-config',
    'obsidian.json',
    '--mirror-root',
    'mirror',
    '--pretty',
  ]);

  assert.strictEqual(options.repoRoot, 'repo');
  assert.strictEqual(options.sharedVault, 'shared');
  assert.strictEqual(options.desktopVault, 'desktop');
  assert.strictEqual(options.desktopConfigPath, 'obsidian.json');
  assert.strictEqual(options.mirrorRoot, 'mirror');
  assert.strictEqual(options.pretty, true);
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, error }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${error.stack || error.message}`);
  });
  process.exit(1);
}
