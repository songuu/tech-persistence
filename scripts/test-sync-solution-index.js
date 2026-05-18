#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseFrontmatter,
  collectSolutions,
  renderIndexJsonl,
  upsertSolutionSection,
  syncSolutionIndex,
} = require('./sync-solution-index');

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

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-solution-index-'));
  fs.mkdirSync(path.join(repo, 'docs', 'solutions'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Claude\n\n### 解决方案索引\n\n- old\n\n## Other\nkeep\n');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Agents\n\n## 已知陷阱（高频）\nnone\n\n## 当前迭代重点\n- [ ] x\n');
  return repo;
}

function writeSolution(repo, name, frontmatter, body) {
  fs.writeFileSync(
    path.join(repo, 'docs', 'solutions', name),
    ['---', frontmatter.trim(), '---', '', body.trim(), ''].join('\n')
  );
}

test('parseFrontmatter parses scalar and array fields', () => {
  const parsed = parseFrontmatter([
    '---',
    'title: "A title"',
    'date: 2026-05-18',
    'tags: [solution, memory, codex]',
    '---',
    '# Body',
    '',
  ].join('\n'));
  assert.strictEqual(parsed.data.title, 'A title');
  assert.strictEqual(parsed.data.date, '2026-05-18');
  assert.deepStrictEqual(parsed.data.tags, ['solution', 'memory', 'codex']);
  assert.ok(parsed.body.includes('# Body'));
});

test('collectSolutions derives stable entries from docs/solutions', () => {
  const repo = makeRepo();
  writeSolution(repo, '2026-05-17-a.md', 'title: "A"\ndate: 2026-05-17\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  writeSolution(repo, '2026-05-18-b.md', 'title: "B"\ndate: 2026-05-18\ntags: [solution, beta]', '# B\n\n## Problem\n\nBeta problem.');
  const entries = collectSolutions(repo);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].id, '2026-05-18-b');
  assert.strictEqual(entries[0].summary, 'Beta problem.');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('upsertSolutionSection replaces existing bounded section', () => {
  const repo = makeRepo();
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  const entries = collectSolutions(repo);
  const before = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8');
  const after = upsertSolutionSection(before, entries);
  assert.ok(!after.includes('- old'));
  assert.ok(after.includes('<!-- BEGIN TECH_PERSISTENCE_SOLUTIONS_INDEX -->'));
  assert.ok(after.includes('Alpha problem.'));
  assert.ok(after.includes('## Other\nkeep'));
  fs.rmSync(repo, { recursive: true, force: true });
});

test('upsertSolutionSection inserts technical sediment section when missing', () => {
  const repo = makeRepo();
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  const entries = collectSolutions(repo);
  const before = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8');
  const after = upsertSolutionSection(before, entries);
  assert.ok(after.includes('## 技术沉淀（通用经验）'));
  assert.ok(after.indexOf('### 解决方案索引') < after.indexOf('## 当前迭代重点'));
  fs.rmSync(repo, { recursive: true, force: true });
});

test('syncSolutionIndex writes one canonical jsonl and two projections', () => {
  const repo = makeRepo();
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  const result = syncSolutionIndex(repo, { targets: ['claude', 'codex'] });
  assert.strictEqual(result.entries.length, 1);
  assert.ok(fs.existsSync(path.join(repo, 'docs', 'solutions', 'index.jsonl')));
  assert.ok(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8').includes('Alpha problem.'));
  assert.ok(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8').includes('Alpha problem.'));
  const jsonl = renderIndexJsonl(result.entries).trim();
  assert.deepStrictEqual(JSON.parse(jsonl), result.entries[0]);
  fs.rmSync(repo, { recursive: true, force: true });
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
