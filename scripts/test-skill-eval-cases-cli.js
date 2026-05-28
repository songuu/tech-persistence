#!/usr/bin/env node

/**
 * test-skill-eval-cases-cli.js
 *
 * End-to-end tests for the skill-eval-cases CLI (add + list), focused on
 * exit-code policy and process-boundary redaction + provenance moat gate.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'skill-eval-cases.js');
const { resolveCasesFile } = require('./lib/skill-eval-cases');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-eval-cases-cli-'));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const TRACE_JSON = JSON.stringify({ failure_step: 'step 3', error_excerpt: 'timeout' });

test('add writes a case and exits 0', () => {
  const baseDir = makeBaseDir();
  const r = runCli([
    'add', '--name', 'prototype', '--input', 'dashboard mockup',
    '--expectation', 'asks <=5 questions', '--from-trace', TRACE_JSON, '--base-dir', baseDir,
  ]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('added'));
  assert.ok(fs.existsSync(resolveCasesFile('prototype', baseDir)));
});

test('add exits 2 (usage) without --from-trace (moat gate)', () => {
  const baseDir = makeBaseDir();
  const r = runCli(['add', '--name', 'sprint', '--input', 'x', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(r.stderr.includes('from-trace'));
});

test('add exits 2 (usage) on invalid --from-trace json', () => {
  const baseDir = makeBaseDir();
  const r = runCli(['add', '--name', 'work', '--input', 'x', '--from-trace', '{bad', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 2);
  assert.ok(r.stderr.includes('valid JSON'));
});

test('add exits 2 (usage) on missing --input', () => {
  const baseDir = makeBaseDir();
  assert.strictEqual(
    runCli(['add', '--name', 'plan', '--from-trace', TRACE_JSON, '--base-dir', baseDir]).status,
    2
  );
});

test('add exits 2 (usage) on missing --name', () => {
  assert.strictEqual(runCli(['add', '--input', 'x', '--from-trace', TRACE_JSON]).status, 2);
});

test('add redacts private tags across the process boundary', () => {
  const baseDir = makeBaseDir();
  const trace = JSON.stringify({ correction_diff: '<private>trace-secret</private>' });
  const r = runCli([
    'add', '--name', 'evolve', '--input', 'before <private>input-secret</private> after',
    '--from-trace', trace, '--base-dir', baseDir,
  ]);
  assert.strictEqual(r.status, 0, r.stderr);
  const serialized = fs.readFileSync(resolveCasesFile('evolve', baseDir), 'utf8');
  assert.ok(!serialized.includes('input-secret'), serialized);
  assert.ok(!serialized.includes('trace-secret'), serialized);
  assert.ok(serialized.includes('[PRIVATE REDACTED]'));
});

test('add exits 2 (usage) on invalid name (path escape)', () => {
  const baseDir = makeBaseDir();
  assert.strictEqual(
    runCli(['add', '--name', '../escape', '--input', 'x', '--from-trace', TRACE_JSON, '--base-dir', baseDir]).status,
    2
  );
});

test('list shows case count and exits 0', () => {
  const baseDir = makeBaseDir();
  runCli(['add', '--name', 'review', '--input', 'a', '--id', 'c1', '--from-trace', TRACE_JSON, '--base-dir', baseDir]);
  runCli(['add', '--name', 'review', '--input', 'b', '--id', 'c2', '--from-trace', TRACE_JSON, '--base-dir', baseDir]);
  const r = runCli(['list', 'review', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('2 case(s)'));
});

test('list exits 0 with 0 cases when none exist', () => {
  const baseDir = makeBaseDir();
  const r = runCli(['list', 'think', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('0 case(s)'));
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
