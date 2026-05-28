#!/usr/bin/env node

/**
 * test-clarifications.js
 *
 * agent-loop A3 clarification channel 的自包含测试：
 *   - append-only 语义（二次 append 不覆盖历史，字节数只增）
 *   - implementer clarification 写入 + ruling 写入 + 合并解析
 *   - redaction（敏感标签写入前脱敏）
 *   - listOpenClarifications gate 注入
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendClarifications,
  appendRulings,
  readClarifications,
  listOpenClarifications,
  clarificationsPath,
} = require('./lib/clarifications');

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

function makeRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-clarif-'));
}

test('appendClarifications writes parseable open entries and assigns ids', () => {
  const runDir = makeRunDir();
  const { ids, file } = appendClarifications(runDir, [
    { assumption: 'use REST', question: 'REST or GraphQL?' },
    { assumption: 'soft delete', question: 'hard or soft delete?' },
  ]);
  assert.strictEqual(ids.length, 2);
  assert.strictEqual(file, clarificationsPath(runDir));
  const parsed = readClarifications(runDir);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].status, 'open');
  assert.strictEqual(parsed[0].assumption, 'use REST');
  assert.strictEqual(parsed[0].question, 'REST or GraphQL?');
});

test('appendClarifications is append-only: second call keeps prior entries and only grows the file', () => {
  const runDir = makeRunDir();
  appendClarifications(runDir, [{ assumption: 'a1', question: 'q1' }]);
  const file = clarificationsPath(runDir);
  const sizeAfterFirst = fs.statSync(file).size;
  const bodyAfterFirst = fs.readFileSync(file, 'utf8');

  appendClarifications(runDir, [{ assumption: 'a2', question: 'q2' }]);
  const sizeAfterSecond = fs.statSync(file).size;
  const bodyAfterSecond = fs.readFileSync(file, 'utf8');

  // 字节数只增不减；第一条原文完整保留在第二次写入后的内容里。
  assert.ok(sizeAfterSecond > sizeAfterFirst, 'file must grow, not shrink');
  assert.ok(bodyAfterSecond.startsWith(bodyAfterFirst), 'prior content must be preserved verbatim (append-only)');
  const parsed = readClarifications(runDir);
  assert.strictEqual(parsed.length, 2);
  const ids = parsed.map((e) => e.id);
  assert.deepStrictEqual(ids, ['clr-001', 'clr-002']);
});

test('appendRulings marks the referenced clarification ruled and merges decision/note', () => {
  const runDir = makeRunDir();
  const { ids } = appendClarifications(runDir, [{ assumption: 'a1', question: 'q1' }]);
  const id = ids[0];
  appendRulings(runDir, [{ id, decision: 'revise-spec', note: 'change to GraphQL' }]);
  const parsed = readClarifications(runDir);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].status, 'ruled');
  assert.strictEqual(parsed[0].decision, 'revise-spec');
  assert.strictEqual(parsed[0].note, 'change to GraphQL');
  // 原 assumption/question 仍保留（合并而非覆盖）。
  assert.strictEqual(parsed[0].assumption, 'a1');
});

test('appendRulings is append-only over clarifications: original open section text survives', () => {
  const runDir = makeRunDir();
  const { ids } = appendClarifications(runDir, [{ assumption: 'a1', question: 'q1' }]);
  const file = clarificationsPath(runDir);
  const bodyBeforeRuling = fs.readFileSync(file, 'utf8');
  appendRulings(runDir, [{ id: ids[0], decision: 'confirm-assumption' }]);
  const bodyAfterRuling = fs.readFileSync(file, 'utf8');
  assert.ok(bodyAfterRuling.startsWith(bodyBeforeRuling), 'ruling must append after the open clarification, not rewrite it');
  assert.ok(bodyAfterRuling.includes('## clarification clr-001'), 'open clarification section must persist');
  assert.ok(bodyAfterRuling.includes('## ruling clr-001'), 'ruling section must be appended');
});

test('listOpenClarifications returns only un-ruled entries', () => {
  const runDir = makeRunDir();
  const { ids } = appendClarifications(runDir, [
    { assumption: 'a1', question: 'q1' },
    { assumption: 'a2', question: 'q2' },
  ]);
  appendRulings(runDir, [{ id: ids[0], decision: 'confirm-assumption' }]);
  const open = listOpenClarifications(runDir);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].id, ids[1]);
});

test('redaction strips private tags before writing (defense in depth)', () => {
  const runDir = makeRunDir();
  appendClarifications(runDir, [
    { assumption: 'before <private>secret-token</private> after', question: 'q' },
  ]);
  const serialized = fs.readFileSync(clarificationsPath(runDir), 'utf8');
  assert.ok(!serialized.includes('secret-token'), 'private tag content must not be persisted');
});

test('empty input is a no-op (no file, no throw)', () => {
  const runDir = makeRunDir();
  const res = appendClarifications(runDir, []);
  assert.strictEqual(res.ids.length, 0);
  assert.strictEqual(fs.existsSync(clarificationsPath(runDir)), false);
  assert.deepStrictEqual(readClarifications(runDir), []);
});

test('rulings without an id are ignored (ruling must reference a clarification)', () => {
  const runDir = makeRunDir();
  appendClarifications(runDir, [{ assumption: 'a1', question: 'q1' }]);
  const res = appendRulings(runDir, [{ decision: 'confirm-assumption' }]);
  assert.strictEqual(res.ids.length, 0);
});

console.log(`\nclarifications: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
