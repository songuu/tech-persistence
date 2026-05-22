#!/usr/bin/env node

/**
 * test-inject-context-cost-summary.js
 *
 * Self-contained tests for inject-context context-cost observability.
 */

const assert = require('assert');

const {
  renderContextCostSummary,
  renderContextWithOptionalCostSummary,
  renderSections,
  renderSectionsWithStats,
  shouldIncludeContextCostSummary,
} = require('./inject-context');

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

test('renderSections keeps the legacy markdown shape', () => {
  const output = renderSections([{ title: 'A', body: 'hello' }]);
  assert.strictEqual(output, '## A\n\nhello');
});

test('small context does not include cost summary by default', () => {
  const rendered = renderSectionsWithStats([{ title: 'A', body: 'hello' }], 1000);
  assert.strictEqual(shouldIncludeContextCostSummary(rendered.stats, {}), false);
  const context = renderContextWithOptionalCostSummary([{ title: 'A', body: 'hello' }], 'proj', {});
  assert.ok(!context.includes('Context cost summary'));
});

test('environment flag forces cost summary', () => {
  const context = renderContextWithOptionalCostSummary(
    [{ title: 'A', body: 'hello' }],
    'proj',
    { TECH_PERSISTENCE_CONTEXT_COST_SUMMARY: '1' }
  );
  assert.ok(context.includes('## Context cost summary'));
  assert.ok(context.includes('context='));
});

test('truncated sections trigger cost summary', () => {
  const sections = [{ title: 'Big', body: 'x'.repeat(200) }];
  const rendered = renderSectionsWithStats(sections, 40);
  assert.deepStrictEqual(rendered.stats.truncatedSections, ['Big']);
  assert.strictEqual(shouldIncludeContextCostSummary(rendered.stats, {}), true);
});

test('summary is compact and includes core stats', () => {
  const rendered = renderSectionsWithStats([
    { title: 'A', body: 'x'.repeat(10) },
    { title: 'B', body: 'y'.repeat(100) },
  ], 60);
  const summary = renderContextCostSummary(rendered.stats);
  assert.ok(summary.length < 350, `summary too long: ${summary.length}`);
  assert.ok(summary.includes('chars'));
  assert.ok(summary.includes('tokens'));
  assert.ok(summary.includes('sections='));
  assert.ok(summary.includes('truncated=B'));
});

test('near-budget context triggers cost summary', () => {
  const rendered = renderSectionsWithStats([{ title: 'A', body: 'x'.repeat(75) }], 100);
  assert.ok(rendered.stats.injectedChars >= 80, `expected >=80 injected chars, got ${rendered.stats.injectedChars}`);
  assert.strictEqual(shouldIncludeContextCostSummary(rendered.stats, {}), true);
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
