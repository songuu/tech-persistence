#!/usr/bin/env node

/**
 * test-skill-traces-cli.js
 *
 * Tests the skill-traces CLI (record + list): exit policy + redaction at the
 * process boundary.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'skill-traces.js');
const { resolveTraceFile } = require('./lib/skill-traces');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-traces-cli-'));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('record exits 0 and writes trace file', () => {
  const baseDir = makeBaseDir();
  const r = runCli(['record', '--name', 'prototype', '--failure-step', 'step 3', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(resolveTraceFile('prototype', baseDir)));
});

test('record redacts private tags at process boundary', () => {
  const baseDir = makeBaseDir();
  const r = runCli([
    'record', '--name', 'work',
    '--input-excerpt', 'x <private>leak-token</private> y',
    '--base-dir', baseDir,
  ]);
  assert.strictEqual(r.status, 0, r.stderr);
  const serialized = fs.readFileSync(resolveTraceFile('work', baseDir), 'utf8');
  assert.ok(!serialized.includes('leak-token'), serialized);
  assert.ok(serialized.includes('[PRIVATE REDACTED]'));
});

test('record exits 2 when no content field given', () => {
  const baseDir = makeBaseDir();
  assert.strictEqual(runCli(['record', '--name', 'sprint', '--base-dir', baseDir]).status, 2);
});

test('record exits 2 on missing name', () => {
  assert.strictEqual(runCli(['record', '--failure-step', 'x']).status, 2);
});

test('list exits 0 and reports count', () => {
  const baseDir = makeBaseDir();
  runCli(['record', '--name', 'evolve', '--failure-step', 'a', '--base-dir', baseDir]);
  const r = runCli(['list', 'evolve', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('1 trace'));
});

test('list exits 2 on invalid name (path escape)', () => {
  const baseDir = makeBaseDir();
  assert.strictEqual(runCli(['list', '../escape', '--base-dir', baseDir]).status, 2);
});

test('unknown subcommand exits 2', () => {
  assert.strictEqual(runCli(['bogus']).status, 2);
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
