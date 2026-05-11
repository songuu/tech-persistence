#!/usr/bin/env node

// Smoke test for T3: SessionStart 注入相关性提升
// 验证:
//   1. selectMemoryIndexEntries 的 prioritizeTopics 选项能把命中 topic 排前
//   2. 空 prioritizeTopics 退化为原行为
//   3. 重排不丢条目
//   4. detectActiveSprintTags 能从真实 docs/plans/ 读到 tags

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { selectMemoryIndexEntries } = require('./lib/memory-v5');
const { detectActiveSprintTags } = require('./inject-context');

const repoRoot = path.resolve(__dirname, '..');

function makeTmpPlansDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-relevance-plans-'));
  return dir;
}

function writePlan(dir, name, frontmatter, body = '# placeholder') {
  const fmLines = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.map((x) => x).join(', ')}]`;
    return `${k}: ${v}`;
  });
  const content = `---\n${fmLines.join('\n')}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, name), content);
}

function cleanupTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function makeEntry(id, topic, date, confidence) {
  return { id, topic, date, confidence, line: `- ${date} [${confidence}] ${id}` };
}

function testReorder() {
  const entries = [
    makeEntry('a', 'debugging', '2026-05-01', 0.5),
    makeEntry('b', 'auth', '2026-05-02', 0.8),
    makeEntry('c', 'performance', '2026-05-03', 0.6),
    makeEntry('d', 'auth', '2026-05-04', 0.4),
  ];

  const noPriority = selectMemoryIndexEntries(entries, { maxIndexEntries: 10 });
  assert.strictEqual(noPriority[0].id, 'b', '无 priority 时 b (conf 0.8) 应排第一');

  const withPriority = selectMemoryIndexEntries(
    entries,
    { maxIndexEntries: 10 },
    { prioritizeTopics: ['auth'] }
  );
  assert.strictEqual(withPriority[0].topic, 'auth');
  assert.strictEqual(withPriority[1].topic, 'auth');
  assert.strictEqual(withPriority[0].id, 'b', 'auth 内部仍按 conf 排');
  assert.strictEqual(withPriority[1].id, 'd');

  console.log('[ok] prioritizeTopics reorders matched topics to front');
}

function testNoLoss() {
  const entries = [
    makeEntry('a', 'debugging', '2026-05-01', 0.5),
    makeEntry('b', 'auth', '2026-05-02', 0.8),
  ];
  const result = selectMemoryIndexEntries(
    entries,
    { maxIndexEntries: 10 },
    { prioritizeTopics: ['auth'] }
  );
  assert.strictEqual(result.length, 2, '重排不应丢失条目');
  console.log('[ok] no entry loss after reorder');
}

function testEmptyFallback() {
  const entries = [
    makeEntry('a', 'debugging', '2026-05-01', 0.5),
    makeEntry('b', 'auth', '2026-05-02', 0.8),
  ];
  const result1 = selectMemoryIndexEntries(entries, { maxIndexEntries: 10 }, {});
  const result2 = selectMemoryIndexEntries(entries, { maxIndexEntries: 10 }, { prioritizeTopics: [] });
  assert.deepStrictEqual(result1.map((e) => e.id), result2.map((e) => e.id));
  assert.strictEqual(result1[0].id, 'b');
  console.log('[ok] empty prioritizeTopics falls back to default ordering');
}

function testCaseInsensitive() {
  const entries = [makeEntry('a', 'Auth', '2026-05-01', 0.5), makeEntry('b', 'debugging', '2026-05-02', 0.8)];
  const result = selectMemoryIndexEntries(
    entries,
    { maxIndexEntries: 10 },
    { prioritizeTopics: ['auth'] }
  );
  assert.strictEqual(result[0].id, 'a', 'topic 比较应大小写不敏感');
  console.log('[ok] prioritizeTopics is case-insensitive');
}

function testLimitRespected() {
  const entries = [];
  for (let i = 0; i < 50; i++) {
    entries.push(makeEntry(`e${i}`, i % 2 === 0 ? 'auth' : 'debugging', '2026-05-01', 0.5));
  }
  const result = selectMemoryIndexEntries(
    entries,
    { maxIndexEntries: 10 },
    { prioritizeTopics: ['auth'] }
  );
  assert.strictEqual(result.length, 10, 'limit 应仍生效');
  // 前 10 应全是 auth (25 个 auth > 10)
  assert.ok(result.every((e) => e.topic === 'auth'), 'limit 内应全为 priority topic');
  console.log('[ok] maxIndexEntries limit respected');
}

function testDetectActiveSprintTagsParsesTags() {
  const dir = makeTmpPlansDir();
  try {
    writePlan(dir, '2026-05-11-foo.md', {
      status: 'planning',
      tags: ['sprint', 'performance', 'optimization'],
    });
    const tags = detectActiveSprintTags(dir);
    assert.deepStrictEqual(tags, ['sprint', 'performance', 'optimization']);
    console.log('[ok] detectActiveSprintTags parses planning sprint tags');
  } finally {
    cleanupTmp(dir);
  }
}

function testDetectActiveSprintTagsSkipsCompleted() {
  const dir = makeTmpPlansDir();
  try {
    writePlan(dir, '2026-05-11-foo.md', {
      status: 'completed',
      tags: ['sprint', 'auth'],
    });
    const tags = detectActiveSprintTags(dir);
    assert.deepStrictEqual(tags, [], 'completed sprint 应被跳过');
    console.log('[ok] detectActiveSprintTags skips completed sprints');
  } finally {
    cleanupTmp(dir);
  }
}

function testDetectActiveSprintTagsHandlesNoFrontmatter() {
  const dir = makeTmpPlansDir();
  try {
    fs.writeFileSync(path.join(dir, '2026-05-11-noframe.md'), '# No frontmatter here\n');
    const tags = detectActiveSprintTags(dir);
    assert.deepStrictEqual(tags, [], '无 frontmatter 文档应被跳过返回 []');
    console.log('[ok] detectActiveSprintTags skips docs without frontmatter');
  } finally {
    cleanupTmp(dir);
  }
}

function testDetectActiveSprintTagsActiveButNoTags() {
  const dir = makeTmpPlansDir();
  try {
    writePlan(dir, '2026-05-11-foo.md', {
      status: 'in-progress',
    });
    const tags = detectActiveSprintTags(dir);
    assert.deepStrictEqual(tags, [], 'active 但无 tags 字段应返回 []');
    console.log('[ok] detectActiveSprintTags returns [] when active sprint has no tags');
  } finally {
    cleanupTmp(dir);
  }
}

function testDetectActiveSprintTagsPicksLatestActive() {
  const dir = makeTmpPlansDir();
  try {
    writePlan(dir, '2026-05-09-old.md', { status: 'planning', tags: ['old'] });
    writePlan(dir, '2026-05-10-mid.md', { status: 'completed', tags: ['mid'] });
    writePlan(dir, '2026-05-11-new.md', { status: 'reviewing', tags: ['new'] });
    const tags = detectActiveSprintTags(dir);
    assert.deepStrictEqual(tags, ['new'], '应取按文件名排序最新的 active 文档');
    console.log('[ok] detectActiveSprintTags picks latest active sprint');
  } finally {
    cleanupTmp(dir);
  }
}

function testDetectActiveSprintTagsMissingDir() {
  const tags = detectActiveSprintTags('/nonexistent/path/to/plans');
  assert.deepStrictEqual(tags, [], '目录不存在应返回 []');
  console.log('[ok] detectActiveSprintTags handles missing plans directory');
}

function testIntegrationInjectContext() {
  // 在真实 repo 跑 inject-context.js 走一遍 — 无 stderr 报错即视为通过。
  const result = execSync('node scripts/inject-context.js', {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.trim()) {
    const parsed = JSON.parse(result);
    assert.ok(parsed.hookSpecificOutput, '应输出 hookSpecificOutput');
  }
  console.log('[ok] inject-context.js runs cleanly with detectActiveSprintTags');
}

function main() {
  testReorder();
  testNoLoss();
  testEmptyFallback();
  testCaseInsensitive();
  testLimitRespected();
  testDetectActiveSprintTagsParsesTags();
  testDetectActiveSprintTagsSkipsCompleted();
  testDetectActiveSprintTagsHandlesNoFrontmatter();
  testDetectActiveSprintTagsActiveButNoTags();
  testDetectActiveSprintTagsPicksLatestActive();
  testDetectActiveSprintTagsMissingDir();
  testIntegrationInjectContext();
  console.log('\n[ok] T3 smoke tests passed');
}

main();
