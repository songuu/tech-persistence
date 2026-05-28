#!/usr/bin/env node

/**
 * test-skill-publish-guard.js
 *
 * Tests the skill-eval-results CLI (record + guard subcommands), focused on
 * exit-code policy: regression exit 2, no-baseline/ok exit 0, fail-open exit 0
 * with marker, usage errors exit 2.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'skill-eval-results.js');
const { recordResult, resolveResultsFile } = require('./lib/skill-eval-results');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-guard-'));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('guard exit 0 (no-baseline) when no results exist', () => {
  const baseDir = makeBaseDir();
  const r = runCli(['guard', 'prototype', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('PASS'));
});

test('guard exit 0 (ok) when new version not worse', () => {
  const baseDir = makeBaseDir();
  recordResult('sprint', { version: 1, passRate: 0.67, baseDir });
  recordResult('sprint', { version: 2, passRate: 0.93, baseDir });
  const r = runCli(['guard', 'sprint', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('PASS'));
});

test('guard exit 2 (regression) when new version drops', () => {
  const baseDir = makeBaseDir();
  recordResult('review', { version: 1, passRate: 0.9, baseDir });
  recordResult('review', { version: 2, passRate: 0.6, baseDir });
  const r = runCli(['guard', 'review', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(r.stderr.includes('BLOCKED'));
  assert.ok(r.stderr.includes('修复路径'));
});

test('guard exit 0 when tolerance absorbs flaky drop', () => {
  const baseDir = makeBaseDir();
  recordResult('plan', { version: 1, passRate: 0.9, baseDir });
  recordResult('plan', { version: 2, passRate: 0.88, baseDir });
  assert.strictEqual(runCli(['guard', 'plan', '--base-dir', baseDir]).status, 2);
  assert.strictEqual(runCli(['guard', 'plan', '--base-dir', baseDir, '--tolerance', '0.05']).status, 0);
});

test('guard fail-open exit 0 + marker when results path is unreadable', () => {
  const baseDir = makeBaseDir();
  // 让 results.jsonl 路径变成目录 → readFileSync 抛 EISDIR → 必须 fail-open
  const resultsFile = resolveResultsFile('work', baseDir);
  fs.mkdirSync(resultsFile, { recursive: true });
  const r = runCli(['guard', 'work', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 0, `expected fail-open exit 0, got ${r.status}`);
  assert.ok(r.stderr.includes('[skill-guard] fail-open:'), r.stderr);
});

test('guard exit 2 (usage) on missing name', () => {
  assert.strictEqual(runCli(['guard']).status, 2);
});

test('guard exit 2 (usage) on invalid name (path escape)', () => {
  const baseDir = makeBaseDir();
  assert.strictEqual(runCli(['guard', '../escape', '--base-dir', baseDir]).status, 2);
});

test('unknown subcommand exits 2', () => {
  assert.strictEqual(runCli(['bogus']).status, 2);
});

test('record subcommand writes result and exits 0', () => {
  const baseDir = makeBaseDir();
  const r = runCli(['record', '--name', 'evolve', '--version', '1', '--pass-rate', '0.8', '--base-dir', baseDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(resolveResultsFile('evolve', baseDir)));
});

test('record exits 2 on missing required flag', () => {
  const baseDir = makeBaseDir();
  assert.strictEqual(runCli(['record', '--name', 'evolve', '--base-dir', baseDir]).status, 2);
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
