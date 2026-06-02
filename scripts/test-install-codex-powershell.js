#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = path.join(repoRoot, 'install-codex.ps1');
const source = fs.readFileSync(installer, 'utf8');
const nonAsciiLines = source
  .split(/\r?\n/)
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => /[^\x00-\x7F]/.test(line));

assert.deepStrictEqual(
  nonAsciiLines,
  [],
  `install-codex.ps1 must stay ASCII-only for Windows PowerShell 5.1 no-BOM parsing.\n${nonAsciiLines
    .map(({ number, line }) => `${number}: ${line}`)
    .join('\n')}`
);

if (process.platform !== 'win32') {
  console.log('[SKIP] Windows PowerShell parser check requires Windows');
  process.exit(0);
}

const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Help'],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

const output = `${result.stdout || ''}${result.stderr || ''}`;

if (result.error && result.error.code === 'EPERM') {
  console.log('[SKIP] Windows PowerShell spawn blocked by environment');
  process.exit(0);
}

assert.ifError(result.error);
assert.strictEqual(
  result.status,
  0,
  `install-codex.ps1 must parse under Windows PowerShell 5.1.\n${output}`
);
assert.ok(!/ParserError|Unexpected token|Missing closing/i.test(output), output);

console.log('[OK] install-codex.ps1 parses under Windows PowerShell 5.1');
