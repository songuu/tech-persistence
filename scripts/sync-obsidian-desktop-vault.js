#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const { resolveBaseDir, resolveActiveObsidianVaultPath } = require('./lib/runtime-paths');
const {
  resolveProjectionProject,
  syncObsidianSolutionProjection,
  writeIfChanged,
} = require('./sync-solution-index');

const DEFAULT_MIRROR_ROOT = '_shared_homunculus';

function normalizePathKey(filePath) {
  return path.resolve(filePath).replace(/[\\/]+$/, '').toLowerCase();
}

function normalizeMirrorRoot(value) {
  const raw = String(value || DEFAULT_MIRROR_ROOT).trim().replace(/^[\\/]+|[\\/]+$/g, '');
  return raw || DEFAULT_MIRROR_ROOT;
}

function walkMarkdownFiles(rootDir, currentDir = rootDir, relativePrefix = '') {
  if (!fs.existsSync(currentDir)) return [];
  return fs.readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
    if (entry.isDirectory()) return walkMarkdownFiles(rootDir, absolutePath, relativePath);
    if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
    return [{ relativePath, absolutePath }];
  });
}

function mirrorMarkdownTree(sourceDir, targetDir, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const sourceFiles = walkMarkdownFiles(sourceDir);
  const expected = new Set(sourceFiles.map((file) => file.relativePath.toLowerCase()));
  const changeDetails = [];
  let written = 0;
  let removed = 0;

  if (!dryRun && sourceFiles.length > 0) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  sourceFiles.forEach((file) => {
    const changed = writeIfChanged(
      path.join(targetDir, file.relativePath),
      fs.readFileSync(file.absolutePath, 'utf-8'),
      dryRun
    );
    if (!changed) return;
    written += 1;
    changeDetails.push({
      type: 'write',
      path: path.join(targetDir, file.relativePath),
    });
  });

  if (fs.existsSync(targetDir)) {
    walkMarkdownFiles(targetDir).forEach((file) => {
      if (expected.has(file.relativePath.toLowerCase())) return;
      removed += 1;
      if (!dryRun) fs.rmSync(file.absolutePath, { force: true });
      changeDetails.push({
        type: 'remove',
        path: file.absolutePath,
      });
    });
  }

  return {
    sourceDir,
    targetDir,
    changed: changeDetails.length > 0,
    written,
    removed,
    changeDetails,
  };
}

function ensureGitignoreRule(vaultPath, mirrorRoot, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const targetPath = path.join(vaultPath, '.gitignore');
  const normalizedRule = `${normalizeMirrorRoot(mirrorRoot).replace(/\\/g, '/')}/`;
  const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : '';
  const rules = existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rules.includes(normalizedRule)) {
    return { changed: false, path: targetPath, rule: normalizedRule };
  }

  const next = existing
    ? `${existing.replace(/\s*$/, '')}\n${normalizedRule}\n`
    : `${normalizedRule}\n`;
  if (!dryRun) fs.writeFileSync(targetPath, next, 'utf-8');
  return { changed: true, path: targetPath, rule: normalizedRule };
}

function buildMirrorPlan(sharedVault, desktopVault, project, options = {}) {
  const mirrorRoot = normalizeMirrorRoot(options.mirrorRoot);
  const mirrorBase = path.join(desktopVault, ...mirrorRoot.split(/[\\/]+/).filter(Boolean));
  return {
    mirrorRoot,
    mirrorBase,
    sections: [
      {
        name: 'memory',
        sourceDir: path.join(sharedVault, 'projects', project.id, 'memory'),
        targetDir: path.join(mirrorBase, 'projects', project.id, 'memory'),
      },
      {
        name: 'sessions',
        sourceDir: path.join(sharedVault, 'projects', project.id, 'sessions'),
        targetDir: path.join(mirrorBase, 'projects', project.id, 'sessions'),
      },
      {
        name: 'instincts',
        sourceDir: path.join(sharedVault, 'projects', project.id, 'instincts'),
        targetDir: path.join(mirrorBase, 'projects', project.id, 'instincts'),
      },
      {
        name: 'global-instincts',
        sourceDir: path.join(sharedVault, 'instincts', 'personal'),
        targetDir: path.join(mirrorBase, 'instincts', 'personal'),
      },
    ],
  };
}

function syncObsidianDesktopVault(repoRoot, options = {}) {
  const sharedVault = !options.sharedVault || options.sharedVault === 'shared' || options.sharedVault === 'auto'
    ? resolveBaseDir()
    : path.resolve(repoRoot, options.sharedVault);
  const desktopVault = resolveActiveObsidianVaultPath(options);
  if (!desktopVault) {
    throw new Error('未找到当前桌面端打开的 Obsidian vault，请先打开目标 vault 或传 --desktop-vault');
  }

  if (normalizePathKey(sharedVault) === normalizePathKey(desktopVault)) {
    return {
      sharedVault,
      desktopVault,
      changed: false,
      noopReason: 'desktop-vault-is-shared-vault',
      sections: [],
      solutionProjection: null,
      gitignore: null,
      project: resolveProjectionProject(repoRoot, sharedVault, options),
    };
  }

  const project = resolveProjectionProject(repoRoot, sharedVault, options);
  const plan = buildMirrorPlan(sharedVault, desktopVault, project, options);
  const sections = plan.sections.map((section) => ({
    name: section.name,
    ...mirrorMarkdownTree(section.sourceDir, section.targetDir, options),
  }));

  const solutionProjection = syncObsidianSolutionProjection(repoRoot, {
    ...options,
    obsidianVault: desktopVault,
    projectId: project.id,
    projectName: project.name,
    obsidianProjectRoot: `${plan.mirrorRoot.replace(/\\/g, '/')}/projects`,
  });
  const gitignore = ensureGitignoreRule(desktopVault, plan.mirrorRoot, options);

  return {
    sharedVault,
    desktopVault,
    project,
    mirrorRoot: plan.mirrorRoot,
    mirrorBase: plan.mirrorBase,
    sections,
    solutionProjection,
    gitignore,
    changed: sections.some((section) => section.changed)
      || Boolean(solutionProjection && solutionProjection.changed)
      || Boolean(gitignore && gitignore.changed),
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--desktop-vault') {
      options.desktopVault = argv[++i];
    } else if (arg === '--desktop-config') {
      options.desktopConfigPath = argv[++i];
    } else if (arg === '--shared-vault') {
      options.sharedVault = argv[++i];
    } else if (arg === '--mirror-root') {
      options.mirrorRoot = argv[++i];
    } else if (arg === '--project-id') {
      options.projectId = argv[++i];
    } else if (arg === '--project-name') {
      options.projectName = argv[++i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
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
    'Usage: node scripts/sync-obsidian-desktop-vault.js [--desktop-vault PATH] [--desktop-config PATH] [--shared-vault PATH] [--mirror-root DIR] [--dry-run]',
    '',
    'Examples:',
    '  node scripts/sync-obsidian-desktop-vault.js',
    '  node scripts/sync-obsidian-desktop-vault.js --desktop-vault C:\\path\\to\\vault',
    '  node scripts/sync-obsidian-desktop-vault.js --mirror-root _shared_homunculus',
  ].join('\n');
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = syncObsidianDesktopVault(process.cwd(), options);
  if (result.noopReason === 'desktop-vault-is-shared-vault') {
    console.log('[ok] 当前桌面 vault 已是 shared vault，无需额外镜像');
    return;
  }

  result.sections.forEach((section) => {
    const rel = path.relative(result.desktopVault, section.targetDir).replace(/\\/g, '/');
    console.log(`${section.changed ? '[updated]' : '[ok]'} desktop:${rel} (${section.written} synced, ${section.removed} removed)`);
  });

  if (result.solutionProjection) {
    const rel = path.relative(result.desktopVault, result.solutionProjection.targetDir).replace(/\\/g, '/');
    console.log(`${result.solutionProjection.changed ? '[updated]' : '[ok]'} desktop:${rel} (${result.solutionProjection.written} synced, ${result.solutionProjection.removed} removed)`);
  }

  if (result.gitignore) {
    const rel = path.relative(result.desktopVault, result.gitignore.path).replace(/\\/g, '/');
    console.log(`${result.gitignore.changed ? '[updated]' : '[ok]'} desktop:${rel} (${result.gitignore.rule})`);
  }
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
  normalizeMirrorRoot,
  walkMarkdownFiles,
  mirrorMarkdownTree,
  ensureGitignoreRule,
  buildMirrorPlan,
  syncObsidianDesktopVault,
};
