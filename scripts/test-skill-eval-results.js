#!/usr/bin/env node

/**
 * test-skill-eval-results.js
 *
 * Self-contained tests for skill eval result recording + regression detection.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  recordResult,
  readResults,
  readLatestTwo,
  checkRegression,
  resolveResultsFile,
} = require('./lib/skill-eval-results');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-eval-results-'));
}

test('recordResult writes a parseable jsonl line', () => {
  const baseDir = makeBaseDir();
  const { record, resultsFile } = recordResult('prototype', { version: 1, passRate: 0.8, baseDir });
  assert.strictEqual(record.name, 'prototype');
  assert.strictEqual(record.pass_rate, 0.8);
  assert.strictEqual(resultsFile, resolveResultsFile('prototype', baseDir));
  const lines = fs.readFileSync(resultsFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(JSON.parse(lines[0]).version, 1);
});

test('readLatestTwo returns prev/curr in append order', () => {
  const baseDir = makeBaseDir();
  recordResult('sprint', { version: 1, passRate: 0.6, baseDir });
  recordResult('sprint', { version: 2, passRate: 0.9, baseDir });
  const { prev, curr } = readLatestTwo('sprint', { baseDir });
  assert.strictEqual(prev.version, 1);
  assert.strictEqual(curr.version, 2);
});

test('checkRegression returns no-baseline with zero or one record', () => {
  const baseDir = makeBaseDir();
  assert.strictEqual(checkRegression('work', { baseDir }).status, 'no-baseline');
  recordResult('work', { version: 1, passRate: 0.7, baseDir });
  assert.strictEqual(checkRegression('work', { baseDir }).status, 'no-baseline');
});

test('checkRegression returns ok when new version is not worse', () => {
  const baseDir = makeBaseDir();
  recordResult('evolve', { version: 1, passRate: 0.67, baseDir });
  recordResult('evolve', { version: 2, passRate: 0.93, baseDir });
  assert.strictEqual(checkRegression('evolve', { baseDir }).status, 'ok');
});

test('checkRegression returns regression when new version drops', () => {
  const baseDir = makeBaseDir();
  recordResult('review', { version: 1, passRate: 0.9, baseDir });
  recordResult('review', { version: 2, passRate: 0.6, baseDir });
  const result = checkRegression('review', { baseDir });
  assert.strictEqual(result.status, 'regression');
  assert.ok(result.reason.includes('60.0%'));
  assert.ok(result.reason.includes('90.0%'));
});

test('checkRegression tolerance absorbs small flaky drop', () => {
  const baseDir = makeBaseDir();
  recordResult('plan', { version: 1, passRate: 0.9, baseDir });
  recordResult('plan', { version: 2, passRate: 0.88, baseDir });
  assert.strictEqual(checkRegression('plan', { baseDir }).status, 'regression');
  assert.strictEqual(checkRegression('plan', { baseDir, tolerance: 0.05 }).status, 'ok');
});

test('invalid skill name is rejected (path escape defense)', () => {
  const baseDir = makeBaseDir();
  assert.throws(() => recordResult('../escape', { version: 1, passRate: 0.5, baseDir }));
  assert.throws(() => resolveResultsFile('A_B', baseDir));
});

test('invalid passRate and version are rejected at boundary', () => {
  const baseDir = makeBaseDir();
  assert.throws(() => recordResult('think', { version: 0, passRate: 0.5, baseDir }));
  assert.throws(() => recordResult('think', { version: 1, passRate: 1.5, baseDir }));
  assert.throws(() => recordResult('think', { version: 1, passRate: -0.1, baseDir }));
});

test('readResults skips malformed lines without throwing', () => {
  const baseDir = makeBaseDir();
  recordResult('compound', { version: 1, passRate: 0.8, baseDir });
  const resultsFile = resolveResultsFile('compound', baseDir);
  fs.appendFileSync(resultsFile, 'not-json\n');
  recordResult('compound', { version: 2, passRate: 0.85, baseDir });
  const records = readResults('compound', { baseDir });
  assert.strictEqual(records.length, 2);
  assert.strictEqual(checkRegression('compound', { baseDir }).status, 'ok');
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
