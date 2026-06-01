#!/usr/bin/env node

/**
 * test-inject-context-cost-summary.js
 *
 * Self-contained tests for inject-context context-cost observability.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectPendingHandoff,
  detectPendingPrototype,
  renderContextCostSummary,
  renderContextWithOptionalCostSummary,
  renderSections,
  renderSectionsWithStats,
  shouldIncludeContextCostSummary,
} = require('./inject-context');
const {
  resolvePlanDirectories,
  resolvePlanPath,
  resolvePlanWritePath,
  resolveProjectPlansDir,
} = require('./lib/runtime-paths');

let passed = 0;
let failed = 0;
const failures = [];

function withTempRepo(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-inject-test-'));
  const plansDir = path.join(root, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  return fn({ root, plansDir });
}

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

test('extras.demandSideLine appends to cost summary when shown', () => {
  const context = renderContextWithOptionalCostSummary(
    [{ title: 'A', body: 'hello' }],
    'proj',
    { TECH_PERSISTENCE_CONTEXT_COST_SUMMARY: '1' },
    { demandSideLine: 'prior-session demand-side recall: 2/3 domains used (67%); dormant=security' }
  );
  assert.ok(context.includes('## Context cost summary'));
  assert.ok(context.includes('prior-session demand-side recall: 2/3 domains used (67%)'));
  assert.ok(context.includes('dormant=security'));
});

test('extras.demandSideLine does not leak when cost summary not shown', () => {
  const context = renderContextWithOptionalCostSummary(
    [{ title: 'A', body: 'hello' }],
    'proj',
    {},
    { demandSideLine: 'prior-session demand-side recall: 2/3 domains used (67%)' }
  );
  assert.ok(!context.includes('Context cost summary'));
  assert.ok(!context.includes('demand-side recall'));
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

test('detectPendingHandoff reads gitignored .handoff directory before legacy top-level handoffs', () => {
  withTempRepo(({ root, plansDir }) => {
    const handoffDir = path.join(plansDir, '.handoff');
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'plans', 'active-sprint.md'), '---\nstatus: in-progress\n---\n');
    fs.writeFileSync(
      path.join(plansDir, 'legacy-handoff-1.md'),
      '---\nsprint_doc: "docs/plans/active-sprint.md"\n---\nlegacy'
    );
    fs.writeFileSync(
      path.join(handoffDir, 'active-sprint-handoff-2.md'),
      '---\nsprint_doc: "docs/plans/active-sprint.md"\n---\nnew handoff'
    );

    const handoff = detectPendingHandoff({ repoRoot: root, plansDir });
    assert.ok(handoff, 'expected pending handoff');
    assert.strictEqual(handoff.file, 'docs/plans/.handoff/active-sprint-handoff-2.md');
    assert.ok(handoff.content.includes('new handoff'));
  });
});

test('plan writes target docs/plans as source of truth', () => {
  withTempRepo(({ root }) => {
    const previousRuntime = process.env.TECH_PERSISTENCE_RUNTIME;
    process.env.TECH_PERSISTENCE_RUNTIME = 'codex';
    try {
      assert.strictEqual(resolveProjectPlansDir(root), path.join(root, 'docs', 'plans'));
      assert.strictEqual(resolvePlanWritePath('next.md', root), path.join(root, 'docs', 'plans', 'next.md'));
      assert.deepStrictEqual(
        resolvePlanDirectories(root).map(dir => dir.sourceType),
        ['sourceOfTruth', 'runtimeCache', 'legacyFallback']
      );
      assert.deepStrictEqual(
        resolvePlanDirectories(root).map(dir => dir.displayPath),
        ['docs/plans', '.codex/plans', '.claude/plans']
      );
    } finally {
      if (previousRuntime === undefined) delete process.env.TECH_PERSISTENCE_RUNTIME;
      else process.env.TECH_PERSISTENCE_RUNTIME = previousRuntime;
    }
  });
});

test('resolvePlanPath prefers docs/plans and falls back to runtime cache', () => {
  withTempRepo(({ root, plansDir }) => {
    const previousRuntime = process.env.TECH_PERSISTENCE_RUNTIME;
    process.env.TECH_PERSISTENCE_RUNTIME = 'codex';
    try {
      const codexPlansDir = path.join(root, '.codex', 'plans');
      fs.mkdirSync(codexPlansDir, { recursive: true });
      fs.writeFileSync(path.join(plansDir, 'shared.md'), 'docs version');
      fs.writeFileSync(path.join(codexPlansDir, 'shared.md'), 'cache version');
      fs.writeFileSync(path.join(codexPlansDir, 'cache-only.md'), 'cache only');

      const preferred = resolvePlanPath('shared.md', root);
      assert.strictEqual(preferred.sourceType, 'sourceOfTruth');
      assert.strictEqual(preferred.displayPath, 'docs/plans/shared.md');

      const fallback = resolvePlanPath('cache-only.md', root);
      assert.strictEqual(fallback.sourceType, 'runtimeCache');
      assert.strictEqual(fallback.displayPath, '.codex/plans/cache-only.md');
    } finally {
      if (previousRuntime === undefined) delete process.env.TECH_PERSISTENCE_RUNTIME;
      else process.env.TECH_PERSISTENCE_RUNTIME = previousRuntime;
    }
  });
});

test('detectPendingPrototype searches docs/plans before hidden runtime caches', () => {
  withTempRepo(({ root, plansDir }) => {
    const previousCwd = process.cwd();
    const previousRuntime = process.env.TECH_PERSISTENCE_RUNTIME;
    process.env.TECH_PERSISTENCE_RUNTIME = 'codex';
    try {
      const codexPlansDir = path.join(root, '.codex', 'plans');
      fs.mkdirSync(codexPlansDir, { recursive: true });
      fs.writeFileSync(path.join(codexPlansDir, 'prototype-2026-01-01-status.md'), 'cache draft');
      fs.writeFileSync(path.join(plansDir, 'prototype-2026-01-02-status.md'), 'docs draft');
      process.chdir(root);

      const pending = detectPendingPrototype();
      assert.ok(pending, 'expected pending prototype status');
      assert.strictEqual(pending.sourceType, 'sourceOfTruth');
      assert.strictEqual(pending.displayPath, 'docs/plans/prototype-2026-01-02-status.md');
      assert.ok(pending.content.includes('docs draft'));
    } finally {
      process.chdir(previousCwd);
      if (previousRuntime === undefined) delete process.env.TECH_PERSISTENCE_RUNTIME;
      else process.env.TECH_PERSISTENCE_RUNTIME = previousRuntime;
    }
  });
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
