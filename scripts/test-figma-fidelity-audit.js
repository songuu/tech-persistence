#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const audit = require('./figma-fidelity-audit');

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

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-figma-audit-'));
}

function writeFile(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function captureRun(args, cwd) {
  let stdout = '';
  let stderr = '';
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (value = '') => { stdout += `${value}\n`; };
  console.error = (value = '') => { stderr += `${value}\n`; };
  try {
    const code = audit.run(args, cwd);
    return { code, stdout, stderr };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

test('detects hardcoded hex, color functions, and visual px values', () => {
  const root = makeDir();
  const file = writeFile(root, 'src/Button.css', [
    '.button {',
    '  color: #1677ff;',
    '  background: rgba(0, 0, 0, 0.4);',
    '  padding: 12px 16px;',
    '}',
    '',
  ].join('\n'));

  const findings = audit.scanFiles([file], root);
  assert.deepStrictEqual(findings.map((f) => f.kind), [
    'hardcoded_hex_color',
    'hardcoded_color_function',
    'hardcoded_px',
    'hardcoded_px',
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('allows 0px, 1px, token sources, and inline allow comments', () => {
  const root = makeDir();
  const css = writeFile(root, 'src/Card.css', [
    '.card { border-width: 1px; margin: 0px; }',
    '/* figma-fidelity-allow: legacy vendor override */',
    '.legacy { color: #ffffff; padding: 24px; }',
    '',
  ].join('\n'));
  const tokens = writeFile(root, 'tokens/theme.css', ':root { --color-primary: #1677ff; --space-3: 12px; }\n');

  assert.strictEqual(audit.scanFiles([css], root).length, 0);
  assert.strictEqual(audit.shouldScanFile(tokens), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('file-level allow skips whole file', () => {
  const root = makeDir();
  const file = writeFile(root, 'src/vendor.css', [
    '/* figma-fidelity-audit: allow-file */',
    '.vendor { color: #ff0000; padding: 32px; }',
    '',
  ].join('\n'));

  assert.strictEqual(audit.scanFiles([file], root).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('CLI returns 1 for findings and prints JSON when requested', () => {
  const root = makeDir();
  writeFile(root, 'src/Button.tsx', 'export const Button = () => <button style={{ color: "#1677ff", padding: "12px" }} />;\n');

  const result = captureRun(['--json', '--paths', 'src'], root);
  assert.strictEqual(result.code, 1);
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.findings.length, 2);
  assert.deepStrictEqual(parsed.scannedFiles, ['src/Button.tsx']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('CLI returns 0 for clean tokenized styles', () => {
  const root = makeDir();
  writeFile(root, 'src/Button.css', '.button { color: var(--color-primary); padding: var(--space-3); }\n');

  const result = captureRun(['--paths', 'src'], root);
  assert.strictEqual(result.code, 0, result.stdout);
  assert.ok(result.stdout.includes('clean'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('unknown option returns usage error', () => {
  const result = captureRun(['--bad-option'], process.cwd());
  assert.strictEqual(result.code, 2);
  assert.ok(result.stderr.includes('unknown option'));
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
