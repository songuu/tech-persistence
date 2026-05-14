#!/usr/bin/env node

/**
 * archive-claude-solutions-index.js — CLAUDE.md 解决方案索引段归档
 *
 * 把 CLAUDE.md 的「### 解决方案索引」段截断为最近 N 条（默认 5），
 * 老条目移到 docs/archives/CLAUDE-solutions-index-<YYYY-MM-DD>.md。
 *
 * 用法：
 *   node scripts/archive-claude-solutions-index.js
 *   node scripts/archive-claude-solutions-index.js --keep 7  (覆盖默认)
 *   node scripts/archive-claude-solutions-index.js --dry-run
 *
 * 幂等：
 *   - 第一次跑：15 条 → 5 条 + 10 条进 archive
 *   - 第二次跑（≤ N 条）：noop
 *   - 同日重跑：合并到当日 archive（按 archived_at 判重），不创建多份
 *
 * 设计原则：
 *   - destructive on CLAUDE.md → 先 backup 到 CLAUDE.md.bak.<ts>
 *   - sentinel 严格 match `### 解决方案索引` + 下一 `### ` 或 EOF
 *   - sentinel 缺失 → exit 1（防误删其他段）
 *   - 仅匹配 `- [YYYY-MM-DD]` 开头的索引条目，其他行（说明 / 空行）保留
 */

const fs = require('fs');
const path = require('path');

const SECTION_ANCHOR = '### 解决方案索引';
const ENTRY_RE = /^- \[(\d{4}-\d{2}-\d{2})\]/;
const DEFAULT_KEEP = 5;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function backupTimestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}${hh}${mm}`;
}

function parseArgs(argv) {
  const args = { keep: DEFAULT_KEEP, dryRun: false, claudeMd: 'CLAUDE.md', archiveDir: 'docs/archives' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--keep') args.keep = parseInt(argv[++i], 10) || DEFAULT_KEEP;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--claude-md') args.claudeMd = argv[++i];
    else if (argv[i] === '--archive-dir') args.archiveDir = argv[++i];
  }
  return args;
}

/**
 * 在 lines[] 中定位「解决方案索引」段的边界。
 * 返回 { startIdx, endIdx } — startIdx 指向 anchor 行，endIdx 是下一 `### ` 或 lines.length。
 * anchor 缺失返 null。
 */
function findSectionBounds(lines) {
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === SECTION_ANCHOR) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { startIdx, endIdx };
}

/**
 * 从 section 内容中提取所有 `- [YYYY-MM-DD] ...` 条目（保留原行），
 * 同时保留非条目行（标题、说明、空行）— 这些是 section 结构。
 */
function partitionSection(sectionLines) {
  const entries = [];  // { dateStr, dateNum, line, idx } in section
  const nonEntryLines = [];  // 保留原顺序（含空行）
  sectionLines.forEach((line, idx) => {
    const m = line.match(ENTRY_RE);
    if (m) {
      entries.push({ dateStr: m[1], dateNum: m[1].replace(/-/g, ''), line, idx });
    } else {
      nonEntryLines.push({ idx, line });
    }
  });
  return { entries, nonEntryLines };
}

function loadExistingArchive(archivePath) {
  if (!fs.existsSync(archivePath)) return null;
  try {
    return fs.readFileSync(archivePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 合并到已存在的当日 archive 文件，按条目 dateStr 去重。
 * 返回更新后的文件内容。
 */
function mergeArchiveContent(existing, oldEntries, today) {
  if (!existing) {
    // 全新文件
    const lines = [
      '---',
      `type: archive`,
      `archived_from: CLAUDE.md`,
      `archived_section: "解决方案索引"`,
      `archived_at: "${today}"`,
      `archived_count: ${oldEntries.length}`,
      'tags: [archive, solutions-index]',
      '---',
      '',
      `# CLAUDE.md 解决方案索引归档（${today}）`,
      '',
      `本文件存放 ${today} 由 \`scripts/archive-claude-solutions-index.js\` 从 \`CLAUDE.md\` 归档出的 ${oldEntries.length} 条旧索引条目。`,
      '',
      '完整 solution 文档仍在 `docs/solutions/`，本文件仅留索引行作历史回溯。',
      '',
      '## 归档条目',
      '',
      ...oldEntries.map((e) => e.line),
      '',
    ];
    return lines.join('\n');
  }
  // 已有当日 archive：识别 "## 归档条目" 后所有 ENTRY_RE 行，合并去重
  const existingLines = existing.split('\n');
  const headerIdx = existingLines.findIndex((l) => l.trim() === '## 归档条目');
  if (headerIdx < 0) {
    // 文件结构异常，追加到末尾
    return existing + '\n## 归档条目（追加）\n' + oldEntries.map((e) => e.line).join('\n') + '\n';
  }
  const existingDateStrs = new Set();
  for (let i = headerIdx + 1; i < existingLines.length; i++) {
    const m = existingLines[i].match(ENTRY_RE);
    if (m) existingDateStrs.add(existingLines[i]);  // 用全行作为唯一性 key
  }
  const newToAdd = oldEntries.filter((e) => !existingDateStrs.has(e.line));
  if (newToAdd.length === 0) return existing;
  // 在文件末尾追加新条目，并更新 frontmatter count
  const newLines = [...existingLines];
  // 更新 frontmatter archived_count
  const cntIdx = newLines.findIndex((l) => /^archived_count:/.test(l));
  if (cntIdx >= 0) {
    const currentCount = parseInt(newLines[cntIdx].match(/(\d+)/)?.[1] || '0', 10);
    newLines[cntIdx] = `archived_count: ${currentCount + newToAdd.length}`;
  }
  newLines.push(...newToAdd.map((e) => e.line));
  if (newLines[newLines.length - 1] !== '') newLines.push('');
  return newLines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const claudeMdPath = path.resolve(args.claudeMd);
  const archiveDir = path.resolve(args.archiveDir);

  if (!fs.existsSync(claudeMdPath)) {
    console.error(`[fail] CLAUDE.md not found: ${claudeMdPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(claudeMdPath, 'utf-8');
  const lines = content.split('\n');

  const bounds = findSectionBounds(lines);
  if (!bounds) {
    console.error(`[fail] section anchor not found: "${SECTION_ANCHOR}"`);
    console.error('       refuse to modify CLAUDE.md without safe sentinel');
    process.exit(1);
  }

  const sectionLines = lines.slice(bounds.startIdx, bounds.endIdx);
  const { entries } = partitionSection(sectionLines);

  if (entries.length <= args.keep) {
    console.log(`[noop] ${entries.length} entries ≤ keep=${args.keep}; nothing to archive`);
    process.exit(0);
  }

  // 按日期降序排（最新在前），保留前 N 条
  const sorted = [...entries].sort((a, b) => b.dateNum.localeCompare(a.dateNum));
  const keepEntries = sorted.slice(0, args.keep);
  const oldEntries = sorted.slice(args.keep);

  // 把 keepEntries 的 idx 集合化，用于过滤
  const keepIdxSet = new Set(keepEntries.map((e) => e.idx));
  const newSectionLines = sectionLines.filter((line, idx) => {
    const m = line.match(ENTRY_RE);
    if (m) return keepIdxSet.has(idx);
    return true;  // 非条目行保留
  });

  // 在 anchor 后插入 archive pointer（如果尚无）
  const pointerLine = `> 老条目（> ${args.keep} 条）已归档至 \`docs/archives/CLAUDE-solutions-index-*.md\``;
  const hasPointer = newSectionLines.some((l) => l.includes('docs/archives/CLAUDE-solutions-index'));
  if (!hasPointer) {
    // 在 anchor (newSectionLines[0]) 后插入 pointer + 空行
    newSectionLines.splice(1, 0, '', pointerLine, '');
  }

  const today = todayIso();
  const archivePath = path.join(archiveDir, `CLAUDE-solutions-index-${today}.md`);
  const existingArchive = loadExistingArchive(archivePath);
  const newArchiveContent = mergeArchiveContent(existingArchive, oldEntries, today);

  const newClaudeMd = [
    ...lines.slice(0, bounds.startIdx),
    ...newSectionLines,
    ...lines.slice(bounds.endIdx),
  ].join('\n');

  if (args.dryRun) {
    console.log(`[dry-run] would archive ${oldEntries.length} entries → ${archivePath}`);
    console.log(`[dry-run] would keep ${keepEntries.length} entries in ${claudeMdPath}`);
    console.log(`[dry-run] CLAUDE.md size: ${content.length} → ${newClaudeMd.length} chars`);
    process.exit(0);
  }

  // backup CLAUDE.md
  const bakPath = `${claudeMdPath}.bak.${backupTimestamp()}`;
  fs.copyFileSync(claudeMdPath, bakPath);

  // archive dir
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(archivePath, newArchiveContent, 'utf-8');

  // write CLAUDE.md
  fs.writeFileSync(claudeMdPath, newClaudeMd, 'utf-8');

  console.log(`[ok] archived ${oldEntries.length} entries → ${archivePath}`);
  console.log(`[ok] kept ${keepEntries.length} latest in ${claudeMdPath}`);
  console.log(`[ok] backup: ${bakPath}`);
  console.log(`[ok] CLAUDE.md: ${content.length} → ${newClaudeMd.length} chars (-${content.length - newClaudeMd.length})`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[fail] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  findSectionBounds,
  partitionSection,
  mergeArchiveContent,
};
