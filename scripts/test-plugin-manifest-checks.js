#!/usr/bin/env node

/**
 * test-plugin-manifest-checks.js
 *
 * Self-contained tests for the Claude plugin manifest deterministic checks.
 * Covers the 3-arch negative-sample requirement (feedback_negative_sample_3_archs / ADR-013 §B):
 *  (a) current real manifest + real MCP tool names PASS,
 *  (b) break-input: forbidden keys / non-array shape / overlong fq-name MUST be rejected,
 *  (c) extraction regression: real tool names extracted correctly.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  MCP_FQ_NAME_MAX,
  checkClaudeManifest,
  extractMcpToolNames,
  buildMcpFqNames,
  findOverlongMcpNames,
} = require('./plugin-manifest-checks');

const root = path.resolve(__dirname, '..');
const pluginRoot = path.join(root, 'plugins', 'tech-persistence');
const CLAUDE_MANIFEST = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
const MEMORY_TOOLS_SRC = path.join(root, 'scripts', 'lib', 'memory-tools.js');
const MCP_SERVER_NAME = 'tech-persistence-memory';

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

// ── (a) the real shipped manifest must PASS (regression guard on the live file) ──
test('pass: real .claude-plugin/plugin.json has no forbidden keys', () => {
  const manifest = JSON.parse(fs.readFileSync(CLAUDE_MANIFEST, 'utf-8'));
  const errors = checkClaudeManifest(manifest);
  assert.deepStrictEqual(errors, [], `unexpected errors: ${errors.join(' | ')}`);
  assert.strictEqual(manifest.name, 'tech-persistence');
});

// ── (b) break-input: forbidden keys rejected ──
test('reject: manifest declaring hooks is rejected', () => {
  const errors = checkClaudeManifest({ name: 'tech-persistence', hooks: './hooks/hooks.json' });
  assert.ok(errors.length >= 1, 'expected at least one error');
  assert.ok(errors.some((e) => e.includes('"hooks"')), `errors did not mention hooks: ${errors.join(' | ')}`);
});

test('reject: manifest declaring agents is rejected', () => {
  const errors = checkClaudeManifest({ name: 'tech-persistence', agents: ['./agents'] });
  assert.ok(errors.some((e) => e.includes('"agents"')), `errors did not mention agents: ${errors.join(' | ')}`);
});

// ── (b) break-input: non-array shape rejected ──
test('reject: skills as a string is rejected (must be array)', () => {
  const errors = checkClaudeManifest({ name: 'tech-persistence', skills: './skills/' });
  assert.ok(errors.some((e) => e.includes('"skills"') && e.includes('array')), `errors: ${errors.join(' | ')}`);
});

test('pass: skills as an array is accepted', () => {
  const errors = checkClaudeManifest({ name: 'tech-persistence', skills: ['./skills/a'] });
  assert.deepStrictEqual(errors, []);
});

test('reject: non-object manifest is rejected', () => {
  assert.ok(checkClaudeManifest(null).length >= 1);
  assert.ok(checkClaudeManifest([]).length >= 1);
  assert.ok(checkClaudeManifest('x').length >= 1);
});

// ── (c) extraction regression: real tool names ──
test('extract: real memory-tools.js yields the known tp_memory_* tools', () => {
  const source = fs.readFileSync(MEMORY_TOOLS_SRC, 'utf-8');
  const names = extractMcpToolNames(source);
  ['tp_memory_search', 'tp_memory_recent', 'tp_memory_save', 'tp_memory_file_history', 'tp_memory_project_profile']
    .forEach((expected) => {
      assert.ok(names.includes(expected), `missing tool ${expected}; got ${names.join(', ')}`);
    });
});

// ── (a) real MCP fq-names are within the 64-char limit ──
test('pass: real MCP fully-qualified names are within 64 chars', () => {
  const source = fs.readFileSync(MEMORY_TOOLS_SRC, 'utf-8');
  const names = extractMcpToolNames(source);
  const fqNames = buildMcpFqNames(MCP_SERVER_NAME, names);
  const overlong = findOverlongMcpNames(fqNames);
  assert.deepStrictEqual(overlong, [], `overlong fq-names: ${JSON.stringify(overlong)}`);
  const longest = Math.max(...fqNames.map((n) => n.length));
  assert.ok(longest <= MCP_FQ_NAME_MAX, `longest ${longest} exceeds ${MCP_FQ_NAME_MAX}`);
});

// ── (b) break-input: an overlong fq-name MUST be flagged ──
test('reject: a 65-char fully-qualified name is flagged', () => {
  // mcp__tech-persistence-memory__ = 30 chars; pad tool name to push fq-name to 65.
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  const padLen = 65 - prefix.length;
  const longTool = `tp_${'x'.repeat(padLen - 3)}`; // 'tp_' + pad
  const fqName = `${prefix}${longTool}`;
  assert.strictEqual(fqName.length, 65, `constructed fq-name length ${fqName.length} != 65`);
  const overlong = findOverlongMcpNames([fqName]);
  assert.strictEqual(overlong.length, 1);
  assert.strictEqual(overlong[0].length, 65);
});

test('boundary: exactly 64 chars is allowed (no false positive)', () => {
  const name = 'm'.repeat(64);
  assert.deepStrictEqual(findOverlongMcpNames([name]), []);
  const name65 = 'm'.repeat(65);
  assert.strictEqual(findOverlongMcpNames([name65]).length, 1);
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
