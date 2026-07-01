#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectSkillSizeBudget,
  formatMarkdown,
  main,
  parseArgs,
} = require('./skill-size-budget');

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

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-skill-budget-'));
  fs.mkdirSync(path.join(root, 'user-level', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(root, '.codex', 'skills', 'review'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user-level', 'skills', 'manual'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'user-level', 'commands', 'review.md'),
    ['---', 'description: Review command', '---', '', '# Review', '', 'x'.repeat(80), ''].join('\n')
  );
  fs.writeFileSync(
    path.join(root, '.codex', 'skills', 'review', 'SKILL.md'),
    ['---', 'name: review', '---', '', 'Codex-compatible entry point for the former /review command.', '', 'y'.repeat(160), ''].join('\n')
  );
  fs.writeFileSync(
    path.join(root, 'user-level', 'skills', 'manual', 'SKILL.md'),
    ['---', 'name: manual', '---', '', 'manual skill body', ''].join('\n')
  );
  return root;
}

test('parseArgs supports thresholds and source-only mode', () => {
  const args = parseArgs([
    'node',
    'scripts/skill-size-budget.js',
    '--top',
    '5',
    '--warn-bytes',
    '100',
    '--heavy-bytes',
    '200',
    '--source-only',
    '--json',
  ]);
  assert.strictEqual(args.top, 5);
  assert.strictEqual(args.warnBytes, 100);
  assert.strictEqual(args.heavyBytes, 200);
  assert.strictEqual(args.includeProjections, false);
  assert.strictEqual(args.json, true);
});

test('collectSkillSizeBudget classifies command-derived runtime skills', () => {
  const root = makeRepo();
  const report = collectSkillSizeBudget({ root, warnBytes: 100, heavyBytes: 200 });
  const reviewSkill = report.entries.find((entry) => entry.path === '.codex/skills/review/SKILL.md');
  const manualSkill = report.entries.find((entry) => entry.path === 'user-level/skills/manual/SKILL.md');

  assert.ok(reviewSkill, 'missing review skill entry');
  assert.strictEqual(reviewSkill.commandDerived, true);
  assert.strictEqual(reviewSkill.surface, 'codex-skill-runtime');
  assert.strictEqual(reviewSkill.pressure, 'heavy');
  assert.ok(manualSkill, 'missing manual skill entry');
  assert.strictEqual(manualSkill.commandDerived, false);
  assert.strictEqual(report.total.commandDerivedSkills, 1);

  fs.rmSync(root, { recursive: true, force: true });
});

test('source-only report skips projection surfaces but keeps source skills and commands', () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, '.codex', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex', 'commands', 'review.md'), '# generated\n');

  const report = collectSkillSizeBudget({ root, includeProjections: false });
  assert.ok(report.entries.some((entry) => entry.path === 'user-level/commands/review.md'));
  assert.ok(report.entries.some((entry) => entry.path === 'user-level/skills/manual/SKILL.md'));
  assert.ok(!report.entries.some((entry) => entry.surface === 'codex-command-projection'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('formatMarkdown renders top rows and surface summary', () => {
  const root = makeRepo();
  const report = collectSkillSizeBudget({ root, warnBytes: 100, heavyBytes: 200 });
  const markdown = formatMarkdown(report, 2);
  assert.ok(markdown.includes('# Skill Size Budget'));
  assert.ok(markdown.includes('## Top 2'));
  assert.ok(markdown.includes('codex-skill-runtime'));
  assert.ok(markdown.includes('## By Surface'));
  fs.rmSync(root, { recursive: true, force: true });
});

function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = fn();
    return { code, stdout: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('main --json exits 0 and prints entries', () => {
  const root = makeRepo();
  const result = captureStdout(() => main(['node', 'scripts/skill-size-budget.js', '--root', root, '--json']));
  assert.strictEqual(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.entries.length >= 3);
  assert.strictEqual(parsed.root, root);
  fs.rmSync(root, { recursive: true, force: true });
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