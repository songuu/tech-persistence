#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const {
  resolveActiveObsidianVaultPath,
  resolveBaseDir,
  resolveConfiguredBaseDir,
  resolveObsidianDesktopConfigPath,
} = require('./lib/runtime-paths');

const DEFAULT_MIRROR_ROOT = '_shared_homunculus';

function normalizePathKey(filePath) {
  return filePath ? path.resolve(filePath).replace(/[\\/]+$/, '').toLowerCase() : null;
}

function normalizeMirrorRoot(value) {
  const raw = String(value || DEFAULT_MIRROR_ROOT).trim().replace(/^[\\/]+|[\\/]+$/g, '');
  return raw || DEFAULT_MIRROR_ROOT;
}

function pathExists(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function isObsidianVault(vaultPath) {
  if (!vaultPath) return false;
  return pathExists(path.join(vaultPath || '', '.obsidian'));
}

function classifyActiveVault(repoRoot, sharedVault, activeVault) {
  if (!activeVault) return 'unknown';
  const activeKey = normalizePathKey(activeVault);
  if (activeKey === normalizePathKey(sharedVault)) return 'shared';
  if (activeKey === normalizePathKey(repoRoot)) return 'repo';
  return 'other';
}

function buildRecommendedActions(report) {
  const actions = [];
  actions.push('node scripts/sync-solution-index.js --target obsidian --obsidian-vault shared');

  if (report.desktop.activeVaultMode === 'repo') {
    actions.push('node scripts/sync-obsidian-desktop-vault.js --project-id <project-id> --project-name tech-persistence');
  } else if (report.desktop.activeVaultMode === 'shared') {
    actions.push('verify shared vault directly in Obsidian');
  } else if (report.desktop.activeVaultMode === 'unknown') {
    actions.push('open a target vault in the Obsidian desktop app or pass --desktop-vault');
  } else {
    actions.push('switch Obsidian desktop to the shared vault or pass --desktop-vault for an explicit mirror target');
  }

  actions.push('verify cloud sync state inside Obsidian or the chosen external sync tool');
  return actions;
}

function buildObsidianSyncPreflight(repoRoot = process.cwd(), options = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const sharedVault = options.sharedVault
    ? path.resolve(options.sharedVault)
    : resolveBaseDir();
  const configuredBaseDir = resolveConfiguredBaseDir();
  const desktopConfigPath = options.desktopConfigPath
    ? path.resolve(options.desktopConfigPath)
    : resolveObsidianDesktopConfigPath();
  const activeVault = resolveActiveObsidianVaultPath({
    desktopVault: options.desktopVault,
    desktopConfigPath,
  });
  const activeVaultMode = classifyActiveVault(resolvedRepoRoot, sharedVault, activeVault);
  const mirrorRoot = normalizeMirrorRoot(options.mirrorRoot);
  const mirrorBase = activeVault
    ? path.join(activeVault, ...mirrorRoot.split(/[\\/]+/).filter(Boolean))
    : null;

  const report = {
    schemaVersion: 'obsidian-sync-preflight/v1',
    ok: Boolean(sharedVault && activeVault),
    repo: {
      path: resolvedRepoRoot,
      exists: pathExists(resolvedRepoRoot),
      isObsidianVault: isObsidianVault(resolvedRepoRoot),
    },
    sharedVault: {
      path: sharedVault,
      configured: Boolean(configuredBaseDir && normalizePathKey(configuredBaseDir) === normalizePathKey(sharedVault)),
      exists: pathExists(sharedVault),
      isObsidianVault: isObsidianVault(sharedVault),
    },
    desktop: {
      configPath: desktopConfigPath,
      configExists: pathExists(desktopConfigPath),
      activeVaultPath: activeVault,
      activeVaultMode,
      activeVaultExists: pathExists(activeVault),
      activeVaultIsObsidianVault: isObsidianVault(activeVault),
      mirrorRoot,
      mirrorBase,
      desktopMirrorNeeded: activeVaultMode === 'repo',
    },
    cloud: {
      status: 'unknown',
      reason: 'Obsidian account, remote vault binding, and external sync-tool state are not exposed by the repo scripts.',
    },
  };

  return {
    ...report,
    recommendedActions: buildRecommendedActions(report),
  };
}

function parseArgs(argv) {
  const options = {
    help: false,
    pretty: false,
    repoRoot: process.cwd(),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-root') {
      options.repoRoot = argv[++i];
    } else if (arg === '--shared-vault') {
      options.sharedVault = argv[++i];
    } else if (arg === '--desktop-vault') {
      options.desktopVault = argv[++i];
    } else if (arg === '--desktop-config') {
      options.desktopConfigPath = argv[++i];
    } else if (arg === '--mirror-root') {
      options.mirrorRoot = argv[++i];
    } else if (arg === '--pretty') {
      options.pretty = true;
    } else if (arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return [
    'Usage: node scripts/obsidian-sync-preflight.js [--pretty] [--repo-root PATH] [--shared-vault PATH] [--desktop-vault PATH] [--desktop-config PATH]',
    '',
    'Examples:',
    '  node scripts/obsidian-sync-preflight.js --pretty',
    '  node scripts/obsidian-sync-preflight.js --desktop-vault C:\\path\\to\\vault --pretty',
  ].join('\n');
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const report = buildObsidianSyncPreflight(options.repoRoot, options);
  console.log(JSON.stringify(report, null, options.pretty ? 2 : 0));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[fail] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_MIRROR_ROOT,
  buildObsidianSyncPreflight,
  classifyActiveVault,
  normalizeMirrorRoot,
  normalizePathKey,
  parseArgs,
};
