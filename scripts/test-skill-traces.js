#!/usr/bin/env node

/**
 * test-skill-traces.js
 *
 * Self-contained tests for skill trace recording (with redaction) + reading.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { recordTrace, readTraces, resolveTraceFile } = require('./lib/skill-traces');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-traces-'));
}

test('recordTrace writes a parseable jsonl line with optional fields', () => {
  const baseDir = makeBaseDir();
  const { record, traceFile } = recordTrace(
    'prototype',
    { failure_step: 'step 3', error_excerpt: 'timeout', source: 'diagnose-extract' },
    { baseDir }
  );
  assert.strictEqual(record.skill, 'prototype');
  assert.strictEqual(record.failure_step, 'step 3');
  assert.strictEqual(traceFile, resolveTraceFile('prototype', baseDir));
  const lines = fs.readFileSync(traceFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
});

test('recordTrace omits empty/absent optional fields', () => {
  const baseDir = makeBaseDir();
  const { record } = recordTrace('sprint', { failure_step: 'x' }, { baseDir });
  assert.ok(!('error_excerpt' in record));
  assert.ok(!('correction_diff' in record));
});

test('recordTrace redacts private tags in all string fields (defense in depth)', () => {
  const baseDir = makeBaseDir();
  recordTrace(
    'work',
    {
      failure_step: 'before <private>secret-step</private> after',
      input_excerpt: '<system-private>token-xyz</system-private>',
      error_excerpt: 'ok',
    },
    { baseDir }
  );
  const serialized = fs.readFileSync(resolveTraceFile('work', baseDir), 'utf8');
  assert.ok(!serialized.includes('secret-step'), serialized);
  assert.ok(!serialized.includes('token-xyz'), serialized);
  assert.ok(serialized.includes('[PRIVATE REDACTED]'));
  assert.ok(serialized.includes('[SYSTEM PRIVATE REDACTED]'));
});

test('readTraces returns records in append order', () => {
  const baseDir = makeBaseDir();
  recordTrace('evolve', { failure_step: 'a' }, { baseDir });
  recordTrace('evolve', { failure_step: 'b' }, { baseDir });
  const records = readTraces('evolve', { baseDir });
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].failure_step, 'a');
  assert.strictEqual(records[1].failure_step, 'b');
});

test('readTraces returns empty when no trace file exists', () => {
  const baseDir = makeBaseDir();
  assert.deepStrictEqual(readTraces('plan', { baseDir }), []);
});

test('readTraces skips malformed lines without throwing', () => {
  const baseDir = makeBaseDir();
  recordTrace('compound', { failure_step: 'a' }, { baseDir });
  fs.appendFileSync(resolveTraceFile('compound', baseDir), 'not-json\n');
  recordTrace('compound', { failure_step: 'b' }, { baseDir });
  assert.strictEqual(readTraces('compound', { baseDir }).length, 2);
});

test('invalid skill name is rejected (path escape defense)', () => {
  const baseDir = makeBaseDir();
  assert.throws(() => recordTrace('../escape', { failure_step: 'x' }, { baseDir }));
  assert.throws(() => resolveTraceFile('A.B', baseDir));
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
