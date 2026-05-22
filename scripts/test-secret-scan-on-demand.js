#!/usr/bin/env node

/**
 * test-secret-scan-on-demand.js
 *
 * Self-contained tests for the on-demand secret scanner.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scanner = require('./secret-scan-on-demand');

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

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-secret-scan-'));
}

function writeFile(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function run(args, cwd = process.cwd()) {
  let stdout = '';
  let stderr = '';
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (value = '') => { stdout += `${value}\n`; };
  console.error = (value = '') => { stderr += `${value}\n`; };
  try {
    const code = scanner.run(args, cwd);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 2, stdout, stderr: `${stderr}[secret-scan] ${error.message}\n` };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

test('positive: detects API key assignment and redacts value', () => {
  const root = makeDir();
  const secretValue = `supersecret${'A'.repeat(24)}`;
  writeFile(root, 'config.txt', `api_key = "${secretValue}"\n`);

  const result = run(['--paths', root]);
  assert.strictEqual(result.code, 1, `expected findings, stdout=${result.stdout}`);
  assert.ok(result.stdout.includes('[generic_api_key_assignment]'));
  assert.ok(!result.stdout.includes(secretValue), 'full secret leaked in output');
  assert.ok(result.stdout.includes('[REDACTED]'));
});

test('positive: detects OpenAI-style key and redacts value', () => {
  const root = makeDir();
  const secretValue = ['sk', 'proj', `A${'B'.repeat(30)}`].join('-');
  writeFile(root, 'token.txt', `token=${secretValue}\n`);

  const result = run(['--paths', root]);
  assert.strictEqual(result.code, 1, `expected findings, stdout=${result.stdout}`);
  assert.ok(result.stdout.includes('[openai_key]'));
  assert.ok(!result.stdout.includes(secretValue), 'full OpenAI-style key leaked in output');
});

test('negative: placeholder values do not report findings', () => {
  const root = makeDir();
  writeFile(root, 'example.md', 'api_key = "YOUR_API_KEY_PLACEHOLDER"\n');

  const result = run(['--paths', root]);
  assert.strictEqual(result.code, 0, `expected clean, stdout=${result.stdout}`);
  assert.ok(result.stdout.includes('clean'));
});

test('path filtering scans only requested subtree', () => {
  const root = makeDir();
  const secretValue = `anothersecret${'C'.repeat(24)}`;
  writeFile(root, 'scan-me/config.txt', `secret = "${secretValue}"\n`);
  writeFile(root, 'clean/readme.md', 'nothing to see here\n');

  const result = run(['--paths', path.join(root, 'clean')]);
  assert.strictEqual(result.code, 0, `expected clean, stdout=${result.stdout}`);
});

test('json output is valid and omits full secret', () => {
  const root = makeDir();
  const secretValue = `jsonsecret${'D'.repeat(24)}`;
  writeFile(root, 'config.json', `{"password":"${secretValue}"}\n`);

  const result = run(['--json', '--paths', root]);
  assert.strictEqual(result.code, 1, `expected findings, stdout=${result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.findings.length, 1);
  assert.ok(!result.stdout.includes(secretValue), 'full secret leaked in json output');
});

test('unknown option exits with usage error', () => {
  const result = run(['--definitely-not-real']);
  assert.strictEqual(result.code, 2);
  assert.ok(result.stderr.includes('unknown option'));
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
