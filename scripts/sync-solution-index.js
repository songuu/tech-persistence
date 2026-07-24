#!/usr/bin/env node

/**
 * sync-solution-index.js
 *
 * Keeps solution summaries single-sourced from docs/solutions/*.md, then renders
 * the bounded Claude runtime projection into CLAUDE.md. Codex reads the canonical
 * docs/solutions/index.jsonl on demand instead of preloading it through AGENTS.md.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { detectProjectIdentity } = require('./lib/memory-v5');
const { resolveBaseDir, resolveConfiguredBaseDir } = require('./lib/runtime-paths');

const DEFAULT_KEEP = 5;
const SECTION_ANCHOR = '### 解决方案索引';
const BEGIN_MARKER = '<!-- BEGIN TECH_PERSISTENCE_SOLUTIONS_INDEX -->';
const END_MARKER = '<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->';

function normalizeLf(content) {
  return String(content || '').replace(/\r\n/g, '\n');
}

function parseScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((part) => parseScalar(part)).filter(Boolean);
  }
  return trimmed;
}

function parseFrontmatter(content) {
  const text = normalizeLf(content);
  if (!text.startsWith('---\n')) return { data: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { data: {}, body: text };

  const raw = text.slice(4, end).trim();
  const body = text.slice(end + 5).replace(/^\s*\n/, '');
  const data = {};
  raw.split('\n').forEach((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) return;
    data[match[1]] = parseScalar(match[2]);
  });
  return { data, body };
}

function stripMarkdown(text) {
  return normalizeLf(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, maxChars = 220) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function firstParagraph(sectionText) {
  const paragraphs = normalizeLf(sectionText)
    .split(/\n\s*\n/)
    .map((part) => stripMarkdown(part))
    .filter(Boolean);
  return paragraphs[0] || '';
}

function extractSection(body, heading) {
  const text = normalizeLf(body);
  const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
  const match = headingRe.exec(text);
  if (!match) return '';
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = rest.search(/\n##\s+/);
  return next === -1 ? rest : rest.slice(0, next);
}

function deriveSummary(body) {
  return truncate(
    firstParagraph(extractSection(body, 'Problem'))
      || firstParagraph(extractSection(body, 'Solution'))
      || firstParagraph(body)
      || 'See solution document for details.'
  );
}

function dateFromFilename(fileName) {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})-/);
  return match ? match[1] : '0000-00-00';
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : (typeof tags === 'string' ? [tags] : []);
  return list
    .map((tag) => String(tag).trim())
    .filter(Boolean);
}

function solutionFromFile(repoRoot, absolutePath) {
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const { data, body } = parseFrontmatter(content);
  const fileName = path.basename(absolutePath);
  const relPath = toPosixPath(path.relative(repoRoot, absolutePath));
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const tags = normalizeTags(data.tags);

  return {
    id: path.basename(fileName, '.md'),
    date: String(data.date || dateFromFilename(fileName)),
    title: String(data.title || (titleMatch && titleMatch[1]) || path.basename(fileName, '.md')),
    tags,
    summary: deriveSummary(body),
    path: relPath,
  };
}

function collectSolutions(repoRoot, options = {}) {
  const solutionsDir = path.resolve(repoRoot, options.solutionsDir || 'docs/solutions');
  if (!fs.existsSync(solutionsDir)) return [];
  return fs.readdirSync(solutionsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => solutionFromFile(repoRoot, path.join(solutionsDir, name)))
    .sort((a, b) => {
      const byDate = b.date.localeCompare(a.date);
      if (byDate !== 0) return byDate;
      return b.id.localeCompare(a.id);
    });
}

function renderTagLabel(tags) {
  const filtered = normalizeTags(tags).filter((tag) => tag !== 'solution').slice(0, 3);
  return filtered.length > 0 ? `[${filtered.join('/')}] ` : '';
}

function renderEntry(entry) {
  return `- [${entry.date}] ${renderTagLabel(entry.tags)}${entry.title} — ${entry.summary} → \`${entry.path}\``;
}

function renderSolutionSection(entries, options = {}) {
  const keep = options.keep || DEFAULT_KEEP;
  const visible = entries.slice(0, keep);
  const lines = [
    SECTION_ANCHOR,
    '',
    BEGIN_MARKER,
    '> Generated from `docs/solutions/*.md`; do not edit this block manually.',
    '> Refresh with `node scripts/sync-solution-index.js --all`.',
    '',
  ];
  if (visible.length === 0) {
    lines.push('- 暂无解决方案记录。');
  } else {
    visible.forEach((entry) => lines.push(renderEntry(entry)));
  }
  lines.push('', END_MARKER);
  return lines.join('\n');
}

function findSectionBounds(lines) {
  const startIdx = lines.findIndex((line) => line.trim() === SECTION_ANCHOR);
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^#{1,3}\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { startIdx, endIdx };
}

function insertSection(content, section) {
  const lines = normalizeLf(content).split('\n');
  const techIdx = lines.findIndex((line) => /^##\s+技术沉淀/.test(line));
  if (techIdx >= 0) {
    let insertAt = lines.length;
    for (let i = techIdx + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i])) {
        insertAt = i;
        break;
      }
    }
    const before = lines.slice(0, insertAt).join('\n').replace(/\s*$/, '\n\n');
    const after = lines.slice(insertAt).join('\n').replace(/^\s*/, '');
    return `${before}${section}\n${after}`.replace(/\n{3,}/g, '\n\n');
  }

  const currentIdx = lines.findIndex((line) => /^##\s+当前迭代重点/.test(line));
  const insertAt = currentIdx >= 0 ? currentIdx : lines.length;
  const before = lines.slice(0, insertAt).join('\n').replace(/\s*$/, '\n\n');
  const after = lines.slice(insertAt).join('\n').replace(/^\s*/, '');
  return `${before}## 技术沉淀（通用经验）\n\n${section}\n${after}`.replace(/\n{3,}/g, '\n\n');
}

function upsertSolutionSection(content, entries, options = {}) {
  const normalized = normalizeLf(content);
  const section = renderSolutionSection(entries, options);
  const lines = normalized.split('\n');
  const bounds = findSectionBounds(lines);
  if (!bounds) return insertSection(normalized, section);

  const updated = [
    ...lines.slice(0, bounds.startIdx),
    ...section.split('\n'),
    ...lines.slice(bounds.endIdx),
  ];
  return updated.join('\n').replace(/\n{3,}/g, '\n\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(content, value) {
  let count = 0;
  let offset = 0;
  while (offset < content.length) {
    const index = content.indexOf(value, offset);
    if (index === -1) break;
    count += 1;
    offset = index + value.length;
  }
  return count;
}

function findExactMarkerLines(content, marker) {
  const matches = [];
  const pattern = new RegExp(`^${escapeRegExp(marker)}(?:\\r\\n|\\n|$)`, 'gm');
  for (const match of content.matchAll(pattern)) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return matches;
}

function invalidCodexMigrationError(agentsPath, reason) {
  const error = new Error(
    `refusing to migrate ${agentsPath}: invalid solution-index managed markers (${reason})`
  );
  error.code = 'TECH_PERSISTENCE_INVALID_AGENTS_SOLUTION_INDEX';
  error.path = agentsPath;
  return error;
}

function removeLegacyCodexSolutionSection(content, options = {}) {
  const agentsPath = options.agentsPath || 'AGENTS.md';
  const beginOccurrences = countOccurrences(content, BEGIN_MARKER);
  const endOccurrences = countOccurrences(content, END_MARKER);
  const beginLines = findExactMarkerLines(content, BEGIN_MARKER);
  const endLines = findExactMarkerLines(content, END_MARKER);

  if (beginOccurrences === 0 && endOccurrences === 0) {
    return { content, changed: false, migration: 'already-absent' };
  }
  if (beginOccurrences !== beginLines.length || endOccurrences !== endLines.length) {
    throw invalidCodexMigrationError(agentsPath, 'markers must each occupy an exact line');
  }
  if (beginLines.length !== 1 || endLines.length !== 1) {
    throw invalidCodexMigrationError(
      agentsPath,
      `expected one ordered pair, found ${beginLines.length} begin and ${endLines.length} end`
    );
  }
  if (beginLines[0].start >= endLines[0].start) {
    throw invalidCodexMigrationError(agentsPath, 'END marker appears before BEGIN marker');
  }

  let removalStart = beginLines[0].start;
  const prefix = content.slice(0, removalStart);
  const attachedHeading = new RegExp(
    `(^|\\r?\\n)${escapeRegExp(SECTION_ANCHOR)}(?:\\r\\n|\\n)(?:[\\t ]*(?:\\r\\n|\\n))*$`
  ).exec(prefix);
  if (attachedHeading) {
    // The heading was emitted outside the old managed markers. Remove it only
    // when it is the exact, directly attached renderer heading; never consume
    // arbitrary neighboring project text.
    removalStart = attachedHeading.index + attachedHeading[1].length;
  }

  return {
    content: content.slice(0, removalStart) + content.slice(endLines[0].end),
    changed: true,
    migration: 'removed-legacy-managed-block',
  };
}

function renderIndexJsonl(entries) {
  return entries
    .map((entry) => JSON.stringify(entry))
    .join('\n')
    .concat(entries.length > 0 ? '\n' : '');
}

function resolveObsidianVault(repoRoot, options = {}) {
  const requested = options.obsidianVault;
  if (!requested) return null;
  if (requested === 'shared') {
    const configured = resolveConfiguredBaseDir();
    if (!configured) {
      throw new Error('shared homunculus 未配置，请先运行 scripts/configure-shared-homunculus.js');
    }
    return configured;
  }
  if (requested === 'auto') return resolveBaseDir();
  return path.resolve(repoRoot, requested);
}

function normalizePathKey(filePath) {
  return path.resolve(filePath).replace(/[\\/]+$/, '').toLowerCase();
}

function resolveObsidianProjectRoot(options = {}) {
  const raw = String(options.obsidianProjectRoot || 'projects');
  return raw.split(/[\\/]+/).filter(Boolean);
}

function readRegisteredProject(vaultPath, repoRoot) {
  const registryPath = path.join(vaultPath, 'projects.json');
  if (!fs.existsSync(registryPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const repoKey = normalizePathKey(repoRoot);
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value.path !== 'string') continue;
      if (normalizePathKey(value.path) !== repoKey) continue;
      return {
        id,
        name: value.name || path.basename(repoRoot),
        source: value.source || 'registry',
      };
    }
    return null;
  } catch {
    return null;
  }
}

function resolveProjectionProject(repoRoot, vaultPath, options = {}) {
  const registered = readRegisteredProject(vaultPath, repoRoot);
  const detected = detectProjectIdentity(repoRoot);
  return {
    id: String(options.projectId || (registered && registered.id) || detected.id),
    name: String(options.projectName || (registered && registered.name) || detected.name),
    source: options.projectId ? 'override' : ((registered && registered.source) || detected.source),
  };
}

function buildObsidianProjectionState(repoRoot, options = {}) {
  const vaultPath = resolveObsidianVault(repoRoot, options);
  if (!vaultPath) return null;

  const project = resolveProjectionProject(repoRoot, vaultPath, options);
  const solutionsDir = path.resolve(repoRoot, options.solutionsDir || 'docs/solutions');
  const targetDir = path.join(vaultPath, ...resolveObsidianProjectRoot(options), project.id, 'solutions');
  const files = fs.existsSync(solutionsDir)
    ? fs.readdirSync(solutionsDir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => ({
        name,
        sourcePath: path.join(solutionsDir, name),
        targetPath: path.join(targetDir, name),
        content: fs.readFileSync(path.join(solutionsDir, name), 'utf-8'),
      }))
    : [];

  return { vaultPath, project, solutionsDir, targetDir, files };
}

function applyObsidianProjection(state, dryRun = false) {
  if (!state) return null;
  const changeDetails = [];
  let written = 0;
  let removed = 0;

  if (!dryRun) {
    fs.mkdirSync(state.targetDir, { recursive: true });
  }

  state.files.forEach((file) => {
    const changed = writeIfChanged(file.targetPath, file.content, dryRun);
    if (changed) {
      written += 1;
      changeDetails.push({
        type: 'write',
        path: file.targetPath,
        name: file.name,
      });
    }
  });

  if (fs.existsSync(state.targetDir)) {
    const expected = new Set(state.files.map((file) => file.name.toLowerCase()));
    fs.readdirSync(state.targetDir)
      .filter((name) => name.endsWith('.md') && !expected.has(name.toLowerCase()))
      .forEach((name) => {
        removed += 1;
        if (!dryRun) fs.rmSync(path.join(state.targetDir, name), { force: true });
        changeDetails.push({
          type: 'remove',
          path: path.join(state.targetDir, name),
          name,
        });
      });
  }

  return {
    changed: changeDetails.length > 0,
    written,
    removed,
    changeDetails,
  };
}

function syncObsidianSolutionProjection(repoRoot, options = {}) {
  const state = buildObsidianProjectionState(repoRoot, options);
  if (!state) return null;
  return {
    ...state,
    ...applyObsidianProjection(state, Boolean(options.dryRun)),
  };
}

function targetDocs(repoRoot, options = {}) {
  const requested = options.targets || ['claude', 'codex'];
  const docs = [];
  if (requested.includes('claude')) {
    docs.push({
      target: 'claude',
      operation: 'upsert',
      path: path.resolve(repoRoot, options.claudeMd || 'CLAUDE.md'),
    });
  }
  if (requested.includes('codex')) {
    docs.push({
      target: 'codex',
      operation: 'remove-only-migration',
      path: path.resolve(repoRoot, options.agentsMd || 'AGENTS.md'),
    });
  }
  return docs;
}

function codexMigrationRecoveryJournalPath(target) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.tech-persistence-cas-recovery.json`
  );
}

function reconcileCodexMigrationRecovery(target, options = {}) {
  const journalPath = codexMigrationRecoveryJournalPath(target);
  if (!fs.existsSync(journalPath)) return null;
  if (options.dryRun) {
    const error = new Error(
      `pending AGENTS compare-and-swap recovery requires a non-dry run: ${journalPath}`
    );
    error.code = 'TECH_PERSISTENCE_AGENTS_RECOVERY_REQUIRED';
    error.path = journalPath;
    throw error;
  }
  // Keep Claude-only and already-migrated paths cheap: the heavy CAS module is
  // loaded only for an actual recovery journal or a stale block publication.
  const { reconcilePublishJournal } = require('./update-codex-marketplace');
  return reconcilePublishJournal(target, {
    testHooks: options.codexMigrationRecoveryTestHooks,
  });
}

function buildExpectedState(repoRoot, options = {}) {
  const entries = collectSolutions(repoRoot, options);
  const indexPath = path.resolve(repoRoot, options.indexPath || 'docs/solutions/index.jsonl');
  const indexContent = renderIndexJsonl(entries);
  const docs = (options.skipRuntimeDocs ? [] : targetDocs(repoRoot, options)).map((doc) => {
    if (doc.operation === 'remove-only-migration') {
      const recovery = reconcileCodexMigrationRecovery(doc.path, options);
      if (!fs.existsSync(doc.path)) {
        return {
          ...doc,
          currentRaw: null,
          currentContent: null,
          expectedRaw: null,
          expectedContent: null,
          migration: 'absent-file',
        };
      }
      const stat = fs.lstatSync(doc.path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw invalidCodexMigrationError(doc.path, 'AGENTS target is not a regular file');
      }
      const currentRaw = fs.readFileSync(doc.path);
      const currentContent = currentRaw.toString('utf8');
      if (!Buffer.from(currentContent, 'utf8').equals(currentRaw)) {
        throw invalidCodexMigrationError(doc.path, 'AGENTS is not round-trip UTF-8');
      }
      const migration = removeLegacyCodexSolutionSection(currentContent, {
        agentsPath: doc.path,
      });
      const recoveredPublication = Boolean(
        recovery && recovery.outcome === 'published' && recovery.commitState === 'committed'
      );
      return {
        ...doc,
        currentRaw,
        currentContent,
        expectedRaw: Buffer.from(migration.content, 'utf8'),
        expectedContent: migration.content,
        posixMode: process.platform === 'win32' ? null : stat.mode & 0o777,
        migration: recoveredPublication
          ? 'recovered-published-managed-block'
          : migration.migration,
        recoveredPublication,
        recovery,
      };
    }
    const currentContent = fs.existsSync(doc.path) ? fs.readFileSync(doc.path, 'utf-8') : '';
    return {
      ...doc,
      currentContent,
      expectedContent: upsertSolutionSection(currentContent, entries, options),
    };
  });
  return { entries, indexPath, indexContent, docs };
}

function writeIfChanged(filePath, content, dryRun = false) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
  if (current === content) return false;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  return true;
}

function writeMigrationCompareAndSwap(doc, options = {}) {
  if (doc.recoveredPublication) {
    return {
      changed: true,
      commitState: 'committed',
      recovered: true,
      ...(doc.recovery && doc.recovery.durabilityWarning
        ? { durabilityWarning: doc.recovery.durabilityWarning }
        : {}),
    };
  }

  if (doc.currentRaw === null && doc.expectedRaw === null) return { changed: false };
  const changed = !doc.currentRaw.equals(doc.expectedRaw);
  if (!changed || options.dryRun) return { changed };

  // Lazy by design: Claude projection and already-migrated Codex paths never
  // load the CAS runtime.
  const {
    marketplaceExpectationFromRaw,
    publishTextCompareAndSwap,
  } = require('./update-codex-marketplace');
  const publication = publishTextCompareAndSwap(
    doc.path,
    doc.expectedRaw,
    marketplaceExpectationFromRaw(doc.currentRaw, doc.posixMode),
    {
      previousLabel: 'solution-index-migration',
      testHooks: options.codexMigrationTestHooks,
    }
  );
  if (!publication || publication.commitState !== 'committed') {
    const error = new Error(`AGENTS migration commit state is not committed: ${doc.path}`);
    error.code = 'TECH_PERSISTENCE_AGENTS_COMMIT_STATE_UNKNOWN';
    error.commitState = publication && publication.commitState
      ? publication.commitState
      : 'unknown';
    throw error;
  }
  return {
    changed: true,
    commitState: 'committed',
    recovered: Boolean(publication.recovered),
    ...(publication.durabilityWarning
      ? { durabilityWarning: publication.durabilityWarning }
      : {}),
  };
}
function syncSolutionIndex(repoRoot, options = {}) {
  const state = buildExpectedState(repoRoot, options);
  const dryRun = Boolean(options.dryRun);
  const changes = [];

  if (!options.skipIndex) {
    changes.push({
      target: 'index',
      path: state.indexPath,
      changed: writeIfChanged(state.indexPath, state.indexContent, dryRun),
    });
  }

  if (!options.skipRuntimeDocs) {
    state.docs.forEach((doc) => {
      if (doc.operation === 'remove-only-migration') {
        const publication = writeMigrationCompareAndSwap(doc, {
          dryRun,
          codexMigrationTestHooks: options.codexMigrationTestHooks,
        });
        changes.push({
          target: doc.target,
          path: doc.path,
          ...publication,
          ...(doc.migration ? { migration: doc.migration } : {}),
        });
        return;
      }
      changes.push({
        target: doc.target,
        path: doc.path,
        changed: writeIfChanged(doc.path, doc.expectedContent, dryRun),
      });
    });
  }

  const shouldSyncObsidian = Boolean(options.obsidianVault || options.obsidianTarget);
  if (options.obsidianTarget && !options.obsidianVault) {
    throw new Error('--target obsidian requires --obsidian-vault shared|auto|PATH');
  }

  const obsidianProjection = shouldSyncObsidian
    ? syncObsidianSolutionProjection(repoRoot, options)
    : null;
  if (obsidianProjection) {
    changes.push({
      type: 'obsidian',
      target: 'obsidian',
      path: obsidianProjection.targetDir,
      vaultPath: obsidianProjection.vaultPath,
      changed: obsidianProjection.changed,
      written: obsidianProjection.written,
      removed: obsidianProjection.removed,
    });
  }
  return { ...state, changes, obsidianProjection };
}

function parseArgs(argv) {
  const options = { targets: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      options.targets = ['claude', 'codex'];
    } else if (arg === '--target') {
      const target = argv[++i];
      if (target === 'obsidian') {
        options.obsidianTarget = true;
      } else {
        options.targets.push(target);
      }
    } else if (arg === '--obsidian-only') {
      options.obsidianTarget = true;
      options.skipIndex = true;
      options.skipRuntimeDocs = true;
    } else if (arg === '--skip-runtime-docs') {
      options.skipRuntimeDocs = true;
    } else if (arg === '--skip-index') {
      options.skipIndex = true;
    } else if (arg === '--keep') {
      options.keep = parseInt(argv[++i], 10) || DEFAULT_KEEP;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--solutions-dir') {
      options.solutionsDir = argv[++i];
    } else if (arg === '--index-path') {
      options.indexPath = argv[++i];
    } else if (arg === '--claude-md') {
      options.claudeMd = argv[++i];
    } else if (arg === '--agents-md') {
      options.agentsMd = argv[++i];
    } else if (arg === '--obsidian-vault') {
      options.obsidianVault = argv[++i];
    } else if (arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.targets.length === 0 && options.obsidianTarget) {
    options.skipIndex = true;
    options.skipRuntimeDocs = true;
  } else if (options.targets.length === 0) {
    options.targets = ['claude', 'codex'];
  }
  options.targets = Array.from(new Set(options.targets));
  return options;
}

function usage() {
  return [
    'Usage: node scripts/sync-solution-index.js [--all] [--target claude|codex|obsidian] [--keep N] [--dry-run] [--obsidian-vault shared|auto|PATH]',
    '',
    'Examples:',
    '  node scripts/sync-solution-index.js --all',
    '  node scripts/sync-solution-index.js --target codex --keep 3',
    '  node scripts/sync-solution-index.js --all --obsidian-vault shared',
    '  node scripts/sync-solution-index.js --target obsidian --obsidian-vault shared',
    '  node scripts/sync-solution-index.js --obsidian-only --obsidian-vault shared',
  ].join('\n');
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const repoRoot = process.cwd();
  const result = syncSolutionIndex(repoRoot, options);
  result.changes.forEach((change) => {
    if (change.type === 'obsidian') {
      const rel = toPosixPath(path.relative(change.vaultPath, change.path));
      const suffix = `(${change.written} synced, ${change.removed} removed)`;
      console.log(`${change.changed ? '[updated]' : '[ok]'} obsidian:${rel} ${suffix}`);
      return;
    }
    const rel = toPosixPath(path.relative(repoRoot, change.path));
    console.log(`${change.changed ? '[updated]' : '[ok]'} ${rel}`);
  });
  const wroteIndex = result.changes.some((change) => change.target === 'index');
  console.log(`[ok] ${wroteIndex ? 'indexed' : 'collected'} ${result.entries.length} solution docs`);
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
  DEFAULT_KEEP,
  SECTION_ANCHOR,
  BEGIN_MARKER,
  END_MARKER,
  normalizeLf,
  parseFrontmatter,
  collectSolutions,
  renderEntry,
  renderSolutionSection,
  renderIndexJsonl,
  parseArgs,
  upsertSolutionSection,
  removeLegacyCodexSolutionSection,
  resolveObsidianVault,
  readRegisteredProject,
  resolveProjectionProject,
  resolveObsidianProjectRoot,
  buildObsidianProjectionState,
  syncObsidianSolutionProjection,
  buildExpectedState,
  writeIfChanged,
  syncSolutionIndex,
};
