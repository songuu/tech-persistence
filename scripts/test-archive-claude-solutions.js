#!/usr/bin/env node

/**
 * test-archive-claude-solutions.js — 自包含单测（无外部 framework）
 *
 * 覆盖：partitionSection / findSectionBounds / mergeArchiveContent / 端到端 spawn 脚本
 * 含 C2 bug 修复后的负样本验证（fallback 路径 archived_count 必须同步）
 * 运行：node scripts/test-archive-claude-solutions.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const SCRIPT_PATH = path.resolve(__dirname, 'archive-claude-solutions-index.js');
const {
  findSectionBounds,
  partitionSection,
  mergeArchiveContent,
} = require('./archive-claude-solutions-index');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`[OK] ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

function makeTempClaudeMd(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-archive-'));
  const claudeMd = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(claudeMd, content);
  return { dir, claudeMd, archiveDir: path.join(dir, 'docs', 'archives') };
}

function runScript(args, opts = {}) {
  const result = spawnSync('node', [SCRIPT_PATH, ...args], {
    encoding: 'utf-8',
    ...opts,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// ============================================================
// unit-level: findSectionBounds / partitionSection / mergeArchiveContent
// ============================================================

test('U1 findSectionBounds finds anchor + next ### bound', () => {
  const lines = [
    '# Top',
    '',
    '### 解决方案索引',
    '- [2026-05-14] a',
    '- [2026-05-13] b',
    '',
    '### 下一节',
    'other',
  ];
  const bounds = findSectionBounds(lines);
  assert.strictEqual(bounds.startIdx, 2);
  assert.strictEqual(bounds.endIdx, 6);
});

test('U2 findSectionBounds returns null when anchor missing', () => {
  const lines = ['# Top', '', 'No anchor here'];
  assert.strictEqual(findSectionBounds(lines), null);
});

test('U3 findSectionBounds handles anchor at EOF (no next ###)', () => {
  const lines = ['### 解决方案索引', '- [2026-05-14] a'];
  const bounds = findSectionBounds(lines);
  assert.strictEqual(bounds.startIdx, 0);
  assert.strictEqual(bounds.endIdx, 2);
});

test('U4 partitionSection extracts entries with date parsed', () => {
  const sectionLines = [
    '### 解决方案索引',
    '',
    '- [2026-05-14] entry A',
    '- [2026-05-12] entry B',
    'non-entry note',
    '',
  ];
  const { entries } = partitionSection(sectionLines);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].dateStr, '2026-05-14');
  assert.strictEqual(entries[1].dateStr, '2026-05-12');
});

test('U5 mergeArchiveContent creates new file with correct count', () => {
  const oldEntries = [
    { dateStr: '2026-05-10', line: '- [2026-05-10] x' },
    { dateStr: '2026-05-09', line: '- [2026-05-09] y' },
  ];
  const result = mergeArchiveContent(null, oldEntries, '2026-05-14');
  assert.ok(result.includes('archived_count: 2'));
  assert.ok(result.includes('- [2026-05-10] x'));
  assert.ok(result.includes('- [2026-05-09] y'));
});

test('U6 mergeArchiveContent dedups by full line', () => {
  const existing = [
    '---',
    'type: archive',
    'archived_count: 1',
    '---',
    '',
    '## 归档条目',
    '',
    '- [2026-05-10] x',
    '',
  ].join('\n');
  const oldEntries = [
    { dateStr: '2026-05-10', line: '- [2026-05-10] x' },  // duplicate
    { dateStr: '2026-05-09', line: '- [2026-05-09] y' },  // new
  ];
  const result = mergeArchiveContent(existing, oldEntries, '2026-05-14');
  // count should be 1 + 1 (one new added, one dedup'd)
  assert.ok(result.includes('archived_count: 2'), `expected count 2, got:\n${result}`);
  assert.ok(result.includes('- [2026-05-09] y'));
  // dedup'd line should appear only once
  const occurrences = (result.match(/- \[2026-05-10\] x/g) || []).length;
  assert.strictEqual(occurrences, 1);
});

test('U7 [C2 fix] mergeArchiveContent fallback path updates archived_count', () => {
  // existing 文件含 frontmatter 但无 "## 归档条目" header（结构异常）
  const existing = [
    '---',
    'type: archive',
    'archived_count: 5',
    '---',
    '',
    '# CLAUDE.md 解决方案索引归档',
    '',
    'malformed: no ## 归档条目 section',
    '',
  ].join('\n');
  const oldEntries = [
    { dateStr: '2026-05-10', line: '- [2026-05-10] x' },
    { dateStr: '2026-05-09', line: '- [2026-05-09] y' },
    { dateStr: '2026-05-08', line: '- [2026-05-08] z' },
  ];
  const result = mergeArchiveContent(existing, oldEntries, '2026-05-14');
  // count 必须 5 + 3 = 8（C2 修复前是仍然 5）
  assert.ok(result.includes('archived_count: 8'), `C2 bug: expected count 8 after fallback, got:\n${result}`);
  assert.ok(result.includes('## 归档条目（追加）'));
  assert.ok(result.includes('- [2026-05-10] x'));
});

test('U8 mergeArchiveContent returns existing unchanged when all entries dedup', () => {
  const existing = [
    '---',
    'archived_count: 1',
    '---',
    '',
    '## 归档条目',
    '',
    '- [2026-05-10] x',
  ].join('\n');
  const oldEntries = [{ dateStr: '2026-05-10', line: '- [2026-05-10] x' }];
  const result = mergeArchiveContent(existing, oldEntries, '2026-05-14');
  assert.strictEqual(result, existing, 'noop when all entries are duplicates');
});

// ============================================================
// integration-level: spawn the actual script
// ============================================================

function buildClaudeMd(entries) {
  const lines = ['# Top', '', '### 解决方案索引', ''];
  for (const e of entries) lines.push(`- [${e}] some text`);
  lines.push('', '### Other Section', 'other content');
  return lines.join('\n');
}

test('I1 [S1] 5 entries with keep=3 → 2 archived', () => {
  const { dir, claudeMd, archiveDir } = makeTempClaudeMd(
    buildClaudeMd(['2026-05-14', '2026-05-13', '2026-05-12', '2026-05-11', '2026-05-10'])
  );
  const r = runScript(['--keep', '3', '--claude-md', claudeMd, '--archive-dir', archiveDir]);
  assert.strictEqual(r.code, 0, r.stderr);
  const after = fs.readFileSync(claudeMd, 'utf-8');
  const remaining = (after.match(/^- \[2026/gm) || []).length;
  assert.strictEqual(remaining, 3);
  // archive file should contain 2 entries
  const archives = fs.readdirSync(archiveDir);
  assert.strictEqual(archives.length, 1);
  const archived = fs.readFileSync(path.join(archiveDir, archives[0]), 'utf-8');
  assert.ok(archived.includes('archived_count: 2'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('I2 [S2] idempotent: 2nd run is noop', () => {
  const { dir, claudeMd, archiveDir } = makeTempClaudeMd(
    buildClaudeMd(['2026-05-14', '2026-05-13', '2026-05-12', '2026-05-11', '2026-05-10'])
  );
  runScript(['--keep', '3', '--claude-md', claudeMd, '--archive-dir', archiveDir]);
  const r2 = runScript(['--keep', '3', '--claude-md', claudeMd, '--archive-dir', archiveDir]);
  assert.strictEqual(r2.code, 0);
  assert.ok(r2.stdout.includes('[noop]'), `expected [noop], got: ${r2.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('I3 [S3] entries ≤ keep → noop', () => {
  const { dir, claudeMd, archiveDir } = makeTempClaudeMd(
    buildClaudeMd(['2026-05-14', '2026-05-13'])
  );
  const r = runScript(['--keep', '5', '--claude-md', claudeMd, '--archive-dir', archiveDir]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('[noop]'));
  assert.ok(!fs.existsSync(archiveDir), 'archive dir should not be created');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('I4 [S4] sentinel missing → exit 1 (refuse to modify)', () => {
  const { dir, claudeMd, archiveDir } = makeTempClaudeMd('# no anchor here\nsome body\n');
  const before = fs.readFileSync(claudeMd, 'utf-8');
  const r = runScript(['--claude-md', claudeMd, '--archive-dir', archiveDir]);
  assert.strictEqual(r.code, 1);
  assert.ok(r.stderr.includes('section anchor not found'));
  // CLAUDE.md unchanged
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf-8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('I5 [S5] dry-run does not modify files', () => {
  const { dir, claudeMd, archiveDir } = makeTempClaudeMd(
    buildClaudeMd(['2026-05-14', '2026-05-13', '2026-05-12', '2026-05-11', '2026-05-10'])
  );
  const before = fs.readFileSync(claudeMd, 'utf-8');
  const r = runScript(['--keep', '3', '--dry-run', '--claude-md', claudeMd, '--archive-dir', archiveDir]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('[dry-run]'));
  // CLAUDE.md unchanged + archive dir not created
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf-8'), before);
  assert.ok(!fs.existsSync(archiveDir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('I6 [S5b] same-day re-run merges into existing archive, no new file', () => {
  const { dir, claudeMd, archiveDir } = makeTempClaudeMd(
    buildClaudeMd(['2026-05-14', '2026-05-13', '2026-05-12', '2026-05-11', '2026-05-10'])
  );
  // run 1: 3→1 archived
  runScript(['--keep', '4', '--claude-md', claudeMd, '--archive-dir', archiveDir]);
  // modify CLAUDE.md to inject 2 more old entries (simulate user editing in noise)
  const after1 = fs.readFileSync(claudeMd, 'utf-8');
  const injected = after1.replace(
    /(### 解决方案索引[^\n]*\n)/,
    '$1\n- [2026-05-09] injected1\n- [2026-05-08] injected2\n'
  );
  fs.writeFileSync(claudeMd, injected);
  // run 2 same-day with keep=2 should trim more and merge into same archive
  const r2 = runScript(['--keep', '2', '--claude-md', claudeMd, '--archive-dir', archiveDir]);
  assert.strictEqual(r2.code, 0);
  const archives = fs.readdirSync(archiveDir);
  assert.strictEqual(archives.length, 1, 'still only one archive file (same-day merge)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('I7 backup created on real run', () => {
  const { dir, claudeMd, archiveDir } = makeTempClaudeMd(
    buildClaudeMd(['2026-05-14', '2026-05-13', '2026-05-12'])
  );
  runScript(['--keep', '1', '--claude-md', claudeMd, '--archive-dir', archiveDir]);
  const baks = fs.readdirSync(dir).filter((n) => n.startsWith('CLAUDE.md.bak.'));
  assert.ok(baks.length >= 1, 'expected at least one .bak.* file');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- Summary ----------

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, err }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${err.stack || err.message}`);
  });
  process.exit(1);
}
