#!/usr/bin/env node

/**
 * sync-solution-index.js
 *
 * Keeps solution summaries single-sourced from docs/solutions/*.md, then renders
 * bounded runtime projections into CLAUDE.md and AGENTS.md.
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

function buildObsidianProjectionState(repoRoot, options = {}) {
  const vaultPath = resolveObsidianVault(repoRoot, options);
  if (!vaultPath) return null;

  const detectedProject = detectProjectIdentity(repoRoot);
  const project = {
    id: String(options.projectId || detectedProject.id),
    name: String(options.projectName || detectedProject.name),
  };
  const solutionsDir = path.resolve(repoRoot, options.solutionsDir || 'docs/solutions');
  const targetDir = path.join(vaultPath, 'projects', project.id, 'solutions');
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
    docs.push({ target: 'claude', path: path.resolve(repoRoot, options.claudeMd || 'CLAUDE.md') });
  }
  if (requested.includes('codex')) {
    docs.push({ target: 'codex', path: path.resolve(repoRoot, options.agentsMd || 'AGENTS.md') });
  }
  return docs;
}

function buildExpectedState(repoRoot, options = {}) {
  const entries = collectSolutions(repoRoot, options);
  const indexPath = path.resolve(repoRoot, options.indexPath || 'docs/solutions/index.jsonl');
  const indexContent = renderIndexJsonl(entries);
  const docs = targetDocs(repoRoot, options).map((doc) => {
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

function syncSolutionIndex(repoRoot, options = {}) {
  const state = buildExpectedState(repoRoot, options);
  const dryRun = Boolean(options.dryRun);
  const changes = [];
  changes.push({
    path: state.indexPath,
    changed: writeIfChanged(state.indexPath, state.indexContent, dryRun),
  });
  state.docs.forEach((doc) => {
    changes.push({
      target: doc.target,
      path: doc.path,
      changed: writeIfChanged(doc.path, doc.expectedContent, dryRun),
    });
  });
  const obsidianProjection = syncObsidianSolutionProjection(repoRoot, options);
  if (obsidianProjection) {
    changes.push({
      type: 'obsidian',
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
      options.targets.push(argv[++i]);
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
  if (options.targets.length === 0) options.targets = ['claude', 'codex'];
  options.targets = Array.from(new Set(options.targets));
  return options;
}

function usage() {
  return [
    'Usage: node scripts/sync-solution-index.js [--all] [--target claude|codex] [--keep N] [--dry-run] [--obsidian-vault shared|auto|PATH]',
    '',
    'Examples:',
    '  node scripts/sync-solution-index.js --all',
    '  node scripts/sync-solution-index.js --target codex --keep 3',
    '  node scripts/sync-solution-index.js --all --obsidian-vault shared',
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
  console.log(`[ok] indexed ${result.entries.length} solution docs`);
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
  upsertSolutionSection,
  resolveObsidianVault,
  buildObsidianProjectionState,
  syncObsidianSolutionProjection,
  buildExpectedState,
  syncSolutionIndex,
};
