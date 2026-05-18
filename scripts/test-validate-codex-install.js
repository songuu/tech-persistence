#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { stripManagedSolutionIndex } = require('./validate-codex-install');

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

test('stripManagedSolutionIndex removes generated block with cross-runtime words', () => {
  const input = [
    '# AGENTS',
    '',
    '<!-- BEGIN TECH_PERSISTENCE_SOLUTIONS_INDEX -->',
    '- mentions CLAUDE.md and Claude Code inside generated history',
    '<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->',
    '',
    '## Current',
  ].join('\n');
  const stripped = stripManagedSolutionIndex(input);
  assert.ok(!stripped.includes('CLAUDE.md'));
  assert.ok(!stripped.includes('Claude Code'));
  assert.ok(stripped.includes('# AGENTS'));
  assert.ok(stripped.includes('## Current'));
});

test('stripManagedSolutionIndex removes multiple generated blocks', () => {
  const block = [
    '<!-- BEGIN TECH_PERSISTENCE_SOLUTIONS_INDEX -->',
    'generated',
    '<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->',
  ].join('\n');
  const stripped = stripManagedSolutionIndex(`before\n${block}\nmiddle\n${block}\nafter`);
  assert.strictEqual((stripped.match(/generated/g) || []).length, 0);
  assert.ok(stripped.includes('before'));
  assert.ok(stripped.includes('middle'));
  assert.ok(stripped.includes('after'));
});

test('stripManagedSolutionIndex leaves unbounded content unchanged', () => {
  const input = '# AGENTS\n\nNo generated block here.\n';
  assert.strictEqual(stripManagedSolutionIndex(input), input);
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
