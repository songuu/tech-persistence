#!/usr/bin/env node

/**
 * test-skill-eval-cases.js
 *
 * Self-contained tests for trace→eval case sinking (lib level):
 * provenance gate (moat), defense-in-depth redaction, path-escape defense,
 * malformed-line tolerance, source_trace snapshot.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { addCase, readCases, resolveCasesFile } = require('./lib/skill-eval-cases');

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

function makeBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-eval-cases-'));
}

function traceSnapshot(overrides = {}) {
  return {
    failure_step: 'step 3',
    error_excerpt: 'timeout',
    correction_diff: 'user retried',
    input_excerpt: 'do X',
    ...overrides,
  };
}

test('addCase writes a parseable jsonl line with provenance=trace + source_trace', () => {
  const baseDir = makeBaseDir();
  const { record, casesFile } = addCase(
    'prototype',
    { input: 'screenshot of dashboard', expectation: 'asks <= 5 questions', source_trace: traceSnapshot() },
    { baseDir }
  );
  assert.strictEqual(record.name, 'prototype');
  assert.strictEqual(record.provenance, 'trace');
  assert.strictEqual(record.input, 'screenshot of dashboard');
  assert.deepStrictEqual(record.source_trace.failure_step, 'step 3');
  assert.strictEqual(casesFile, resolveCasesFile('prototype', baseDir));
  const lines = fs.readFileSync(casesFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
});

test('addCase rejects non-trace provenance (moat: no self-authored cases)', () => {
  const baseDir = makeBaseDir();
  assert.throws(
    () => addCase('sprint', { input: 'x', provenance: 'skill-generated', source_trace: traceSnapshot() }, { baseDir }),
    /provenance must be one of/
  );
});

test('addCase rejects missing source_trace (must snapshot real context)', () => {
  const baseDir = makeBaseDir();
  assert.throws(() => addCase('work', { input: 'x' }, { baseDir }), /source_trace required/);
  assert.throws(() => addCase('work', { input: 'x', source_trace: 'not-obj' }, { baseDir }), /source_trace required/);
  assert.throws(() => addCase('work', { input: 'x', source_trace: ['arr'] }, { baseDir }), /source_trace required/);
});

test('addCase rejects empty/absent input', () => {
  const baseDir = makeBaseDir();
  assert.throws(() => addCase('plan', { source_trace: traceSnapshot() }, { baseDir }), /input required/);
  assert.throws(() => addCase('plan', { input: '', source_trace: traceSnapshot() }, { baseDir }), /input required/);
});

test('addCase redacts private tags in all string fields incl nested source_trace (defense in depth)', () => {
  const baseDir = makeBaseDir();
  addCase(
    'work',
    {
      input: 'before <private>secret-input</private> after',
      expectation: '<system-private>token-exp</system-private>',
      id: '<private>secret-id</private>',
      source_trace: traceSnapshot({ correction_diff: '<claude-mem-context>mem-leak</claude-mem-context>' }),
      tags: ['<private>secret-tag</private>'],
    },
    { baseDir }
  );
  const serialized = fs.readFileSync(resolveCasesFile('work', baseDir), 'utf8');
  assert.ok(!serialized.includes('secret-input'), serialized);
  assert.ok(!serialized.includes('token-exp'), serialized);
  assert.ok(!serialized.includes('secret-id'), serialized);
  assert.ok(!serialized.includes('mem-leak'), serialized);
  assert.ok(!serialized.includes('secret-tag'), serialized);
  assert.ok(serialized.includes('[PRIVATE REDACTED]'));
  assert.ok(serialized.includes('[SYSTEM PRIVATE REDACTED]'));
  assert.ok(serialized.includes('[CLAUDE MEM CONTEXT REDACTED]'));
});

test('readCases returns records in append order', () => {
  const baseDir = makeBaseDir();
  addCase('evolve', { input: 'a', id: 'c1', source_trace: traceSnapshot() }, { baseDir });
  addCase('evolve', { input: 'b', id: 'c2', source_trace: traceSnapshot() }, { baseDir });
  const records = readCases('evolve', { baseDir });
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].input, 'a');
  assert.strictEqual(records[1].input, 'b');
});

test('readCases returns empty when no cases file exists', () => {
  const baseDir = makeBaseDir();
  assert.deepStrictEqual(readCases('think', { baseDir }), []);
});

test('readCases skips malformed lines without throwing', () => {
  const baseDir = makeBaseDir();
  addCase('compound', { input: 'a', source_trace: traceSnapshot() }, { baseDir });
  fs.appendFileSync(resolveCasesFile('compound', baseDir), 'not-json\n');
  addCase('compound', { input: 'b', source_trace: traceSnapshot() }, { baseDir });
  assert.strictEqual(readCases('compound', { baseDir }).length, 2);
});

test('invalid skill name is rejected (path escape defense)', () => {
  const baseDir = makeBaseDir();
  assert.throws(() => addCase('../escape', { input: 'x', source_trace: traceSnapshot() }, { baseDir }));
  assert.throws(() => resolveCasesFile('A.B', baseDir));
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
