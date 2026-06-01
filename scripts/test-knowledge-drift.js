#!/usr/bin/env node

/**
 * test-knowledge-drift.js — knowledge-drift.js 单元测试 + 全量 dogfood gate（缺陷 E）
 *
 * 覆盖：parseCodeReferences（js/json alternation）、classifyReference 6 档、
 * analyzeKnowledgeDrift 聚合、buildKnownIndex；最后固化 dogfood 探针——
 * 断言现有 rules/solutions/ADR 的 block=0（防 enforcement 上线误拒回归）。
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
  parseCodeReferences,
  classifyReference,
  analyzeKnowledgeDrift,
  buildKnownIndex,
} = require('./lib/knowledge-drift');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

const known = {
  paths: new Set(['scripts/foo.js', 'docs/x.md']),
  basenames: new Map([['foo.js', 1], ['bar.js', 2]]),
};

test('parseCodeReferences extracts file:line refs', () => {
  const refs = parseCodeReferences('see scripts/foo.js:42 and bar.ts:7 here');
  assert.deepStrictEqual(refs, [{ ref: 'scripts/foo.js', lineNum: 42 }, { ref: 'bar.ts', lineNum: 7 }]);
});

test('parseCodeReferences: .json not truncated to .js (alternation order)', () => {
  const refs = parseCodeReferences('config .claude/settings.json:5 here');
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].ref, '.claude/settings.json');
  assert.strictEqual(refs[0].lineNum, 5);
});

test('parseCodeReferences: .jsonl handled', () => {
  const refs = parseCodeReferences('telemetry/recall-usage.jsonl:1');
  assert.strictEqual(refs[0].ref, 'telemetry/recall-usage.jsonl');
});

test('parseCodeReferences: no refs / non-string → []', () => {
  assert.deepStrictEqual(parseCodeReferences('no refs here'), []);
  assert.deepStrictEqual(parseCodeReferences(null), []);
  assert.deepStrictEqual(parseCodeReferences(''), []);
});

test('classifyReference: src-prefix existing → ok', () => {
  assert.strictEqual(classifyReference('scripts/foo.js', known), 'ok');
});

test('classifyReference: src-prefix missing → block', () => {
  assert.strictEqual(classifyReference('scripts/ghost.js', known), 'block');
});

test('classifyReference: bare name found (incl. multi-copy) → ok', () => {
  assert.strictEqual(classifyReference('foo.js', known), 'ok');
  assert.strictEqual(classifyReference('bar.js', known), 'ok');
});

test('classifyReference: bare name missing → warn', () => {
  assert.strictEqual(classifyReference('ghost.js', known), 'warn');
});

test('classifyReference: ... shorthand → skip', () => {
  assert.strictEqual(classifyReference('plugins/.../foo.js', known), 'skip');
});

test('classifyReference: glob * → skip', () => {
  assert.strictEqual(classifyReference('scripts/*.js', known), 'skip');
});

test('classifyReference: runtime prefix (.claude//.codex/ with /) → skip', () => {
  assert.strictEqual(classifyReference('.claude/settings.json', known), 'skip');
  assert.strictEqual(classifyReference('.codex/foo.json', known), 'skip');
});

test('analyzeKnowledgeDrift aggregates blocks + warns, ignores ok/skip', () => {
  const text = '`scripts/ghost.js:1` `ghost-bare.js:2` `scripts/foo.js:3` `plugins/.../x.js:4`';
  const r = analyzeKnowledgeDrift(text, known);
  assert.strictEqual(r.blocks.length, 1);
  assert.strictEqual(r.blocks[0].ref, 'scripts/ghost.js');
  assert.strictEqual(r.warns.length, 1);
  assert.strictEqual(r.warns[0].ref, 'ghost-bare.js');
});

test('analyzeKnowledgeDrift: safe with null known (empty index → src-prefix=block)', () => {
  const r = analyzeKnowledgeDrift('scripts/ghost.js:1', null);
  assert.strictEqual(r.blocks.length, 1);
});

test('buildKnownIndex builds paths + basename counts (multi-copy)', () => {
  const idx = buildKnownIndex('scripts/a.js\nscripts/sub/a.js\ndocs/b.md\n');
  assert.ok(idx.paths.has('scripts/a.js'));
  assert.ok(idx.paths.has('scripts/sub/a.js'));
  assert.strictEqual(idx.basenames.get('a.js'), 2);
  assert.strictEqual(idx.basenames.get('b.md'), 1);
});

test('buildKnownIndex: empty input → empty index', () => {
  const idx = buildKnownIndex('');
  assert.strictEqual(idx.paths.size, 0);
  assert.strictEqual(idx.basenames.size, 0);
});

// 固化 dogfood 探针：现有知识层文档 block 必须 = 0（防误拒回归，ADR-013 §B）
test('DOGFOOD: 现有 .claude/rules + docs/solutions block = 0', () => {
  const root = path.resolve(__dirname, '..');
  const idx = buildKnownIndex(execSync('git ls-files', { cwd: root, encoding: 'utf-8' }));
  const blocks = [];
  for (const d of ['.claude/rules', 'docs/solutions']) {
    const dd = path.join(root, d);
    if (!fs.existsSync(dd)) continue;
    for (const f of fs.readdirSync(dd)) {
      if (!f.endsWith('.md')) continue;
      const text = fs.readFileSync(path.join(dd, f), 'utf-8');
      analyzeKnowledgeDrift(text, idx).blocks.forEach((b) => blocks.push(`${f} -> ${b.ref}:${b.lineNum}`));
    }
  }
  assert.strictEqual(blocks.length, 0, `expected 0 dogfood block, got:\n${blocks.join('\n')}`);
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, err }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${err.stack || err.message}`);
  });
  process.exit(1);
}
