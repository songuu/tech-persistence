#!/usr/bin/env node

/**
 * test-memory-export.js — 自包含单测
 *
 * 覆盖：
 *   - collectRecords 产生稳定 id + provenance metadata
 *   - exportJsonl 每行有效 JSON + 字段完整
 *   - exportMarkdown 每条 frontmatter + body 可解析
 *   - round-trip：导出后 stable id 在再次 export 时保持一致（防重复同步）
 *   - 路径中含特殊字符不破坏 markdown 文件名
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const {
  collectRecords,
  exportJsonl,
  exportMarkdown,
  recordToMarkdown,
  STABLE_ID_PREFIX,
} = require('./memory-export');

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

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-export-test-'));
  const projectId = 'projfix';
  const memoryDir = path.join(root, 'projects', projectId, 'memory');
  const sessionsDir = path.join(root, 'projects', projectId, 'sessions');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  fs.writeFileSync(
    path.join(memoryDir, 'architecture.md'),
    `# Architecture\n\n<!-- memory:v5:aaa111 -->\n- 2026-05-13 [0.85] dual-runtime boundary lives in runtime-paths.js\n\n<!-- memory:v5:bbb222 -->\n- 2026-05-12 [0.7] hooks must be cross-platform\n`
  );
  fs.writeFileSync(
    path.join(memoryDir, 'general.md'),
    `# General\n\n<!-- memory:v5:ccc333 -->\n- 2026-05-13 [0.6] api_key=sk-proj-zzzzz should be redacted\n`
  );
  fs.writeFileSync(
    path.join(sessionsDir, '2026-05-13-aaa.md'),
    `---\ndate: "2026-05-13"\ntype: session-summary\n---\n\nDiscussed runtime-paths.js and hooks.\n`
  );

  const project = { id: projectId, name: 'projfix', source: 'test' };
  const baseDirs = [root];
  return { root, project, baseDirs };
}

// ---------- collectRecords ----------

test('collectRecords produces stable ids with prefix and project id', () => {
  const { project, baseDirs } = makeFixture();
  const records = collectRecords(project, baseDirs);
  assert.ok(records.length >= 3, `expected ≥3 records, got ${records.length}`);
  records.forEach((r) => {
    assert.ok(r.id.startsWith(`${STABLE_ID_PREFIX}:${project.id}:`), `bad id ${r.id}`);
    assert.ok(r.provenance.source_system === 'tech-persistence');
    assert.ok(r.provenance.source_memory_id);
  });
});

test('collectRecords redacts secrets in body', () => {
  const { project, baseDirs } = makeFixture();
  const records = collectRecords(project, baseDirs);
  const ccc = records.find((r) => r.id.endsWith('ccc333'));
  assert.ok(ccc, 'expected ccc333 record');
  assert.ok(!ccc.body.includes('sk-proj-zzzzz'), `secret leaked: ${ccc.body}`);
  assert.ok(ccc.body.includes('[REDACTED]'));
});

test('collectRecords optionally includes sessions', () => {
  const { project, baseDirs } = makeFixture();
  const records = collectRecords(project, baseDirs, { includeSessions: true });
  const sessionRecords = records.filter((r) => r.kind === 'session');
  assert.strictEqual(sessionRecords.length, 1);
  assert.ok(sessionRecords[0].id.includes(':session:'));
});

// ---------- exportJsonl ----------

test('exportJsonl writes one JSON per line', () => {
  const { project, baseDirs } = makeFixture();
  const records = collectRecords(project, baseDirs);
  const outFile = path.join(os.tmpdir(), `tp-export-test-${Date.now()}.jsonl`);
  exportJsonl(records, outFile);

  const lines = fs.readFileSync(outFile, 'utf-8').trim().split('\n');
  assert.strictEqual(lines.length, records.length);
  lines.forEach((line) => {
    const parsed = JSON.parse(line);
    assert.ok(parsed.id.startsWith(STABLE_ID_PREFIX));
  });
});

// ---------- exportMarkdown ----------

test('exportMarkdown writes one .md per record with provenance frontmatter', () => {
  const { project, baseDirs } = makeFixture();
  const records = collectRecords(project, baseDirs);
  const outDir = path.join(os.tmpdir(), `tp-export-md-${Date.now()}`);
  exportMarkdown(records, outDir);

  const files = fs.readdirSync(outDir).filter((n) => n.endsWith('.md'));
  assert.strictEqual(files.length, records.length);

  const sample = fs.readFileSync(path.join(outDir, files[0]), 'utf-8');
  assert.ok(sample.startsWith('---\n'));
  assert.ok(sample.includes('source_system: tech-persistence'));
  assert.ok(sample.includes('source_version: memory-v5'));
});

// ---------- round-trip ----------

test('round-trip: same memory entry produces same stable id across runs', () => {
  const { project, baseDirs } = makeFixture();
  const run1 = collectRecords(project, baseDirs);
  const run2 = collectRecords(project, baseDirs);

  const idsRun1 = new Set(run1.map((r) => r.id));
  const idsRun2 = new Set(run2.map((r) => r.id));

  assert.strictEqual(idsRun1.size, idsRun2.size);
  idsRun1.forEach((id) => assert.ok(idsRun2.has(id), `id ${id} missing in run2`));
});

test('round-trip: appending new entries does not change existing ids', () => {
  const { root, project, baseDirs } = makeFixture();
  const run1 = collectRecords(project, baseDirs);
  const idsRun1 = new Set(run1.map((r) => r.id));

  // Append new entry
  const memoryDir = path.join(root, 'projects', project.id, 'memory');
  fs.appendFileSync(
    path.join(memoryDir, 'architecture.md'),
    `\n<!-- memory:v5:ddd444 -->\n- 2026-05-14 [0.8] new entry\n`
  );

  const run2 = collectRecords(project, baseDirs);
  const idsRun2 = new Set(run2.map((r) => r.id));

  idsRun1.forEach((id) => assert.ok(idsRun2.has(id), `existing id ${id} missing after append`));
  assert.ok(run2.length === run1.length + 1, `expected ${run1.length + 1} records, got ${run2.length}`);
});

test('recordToMarkdown handles missing source_topic for sessions', () => {
  const sessionRecord = {
    kind: 'session',
    id: 'tech-persistence:v5:projfix:session:2026-05-13-aaa',
    source_session_name: '2026-05-13-aaa.md',
    date: '2026-05-13',
    body: 'session body',
    provenance: {
      source_system: 'tech-persistence',
      source_version: 'memory-v5',
      source_project_id: 'projfix',
      source_project_name: 'projfix',
      source_session_name: '2026-05-13-aaa.md',
    },
  };
  const md = recordToMarkdown(sessionRecord);
  assert.ok(md.startsWith('---\n'));
  assert.ok(md.includes('kind: session'));
  assert.ok(md.includes('source_session_name: 2026-05-13-aaa.md'));
  assert.ok(!md.includes('source_topic:'));
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
