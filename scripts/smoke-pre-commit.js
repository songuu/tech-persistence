#!/usr/bin/env node

/**
 * Smoke tests for scripts/pre-commit-check.js.
 *
 * Strategy: spin up a real temp git repo per scenario, copy the relevant
 * transform modules from the real repo, set up source + derived files,
 * `git add` them, then invoke pre-commit-check.js with cwd=tmp and assert
 * exit code + stderr content.
 *
 * Run: node scripts/smoke-pre-commit.js
 *      node scripts/smoke-pre-commit.js --keep   (keep tmp dirs for inspection)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const REAL_REPO = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');

// ─────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────

const tmpDirs = [];
let passed = 0;
let failed = 0;
const failures = [];

function makeRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tp-precommit-${label}-`));
  tmpDirs.push(dir);
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "smoke@test"', { cwd: dir });
  execSync('git config user.name "smoke"', { cwd: dir });
  // Seed initial commit so HEAD exists (some git versions need it before `git diff --cached`)
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  execSync('git add .gitkeep', { cwd: dir });
  execSync('git commit -q -m "init"', { cwd: dir });

  for (const rel of [
    'scripts/propagate-command-changes.js',
    'plugins/tech-persistence/scripts/build-codex-plugin.js',
    'scripts/pre-commit-check.js',
  ]) {
    const src = path.join(REAL_REPO, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return dir;
}

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function gitAdd(dir, ...files) {
  // -A is fine since we control the dir contents; use explicit paths anyway for safety.
  for (const f of files) {
    execSync(`git add -- "${f}"`, { cwd: dir });
  }
}

function runCheck(dir) {
  const res = spawnSync(process.execPath, [path.join(dir, 'scripts/pre-commit-check.js')], {
    cwd: dir,
    encoding: 'utf-8',
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function assert(condition, message) {
  if (condition) return;
  throw new Error(`assertion failed: ${message}`);
}

function runScenario(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err.message });
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
  }
}

// ─────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────

const SPRINT_V1 = `---
description: test command v1
---

# Sprint v1

This is Claude Code talking about ~/.claude/commands.
`;

const SPRINT_V2 = `---
description: test command v2 (modified)
---

# Sprint v2

This is Claude Code talking about ~/.claude/commands.
A new paragraph was added here.
`;

function syncedDerivedSet(dir, name, sourceContent) {
  const propagate = require(path.join(dir, 'scripts/propagate-command-changes.js'));
  const build = require(path.join(dir, 'plugins/tech-persistence/scripts/build-codex-plugin.js'));

  writeFile(dir, `.codex/commands/${name}.md`, propagate.applyCodexRegex(sourceContent));
  writeFile(dir, `plugins/tech-persistence/commands/${name}.md`, build.normalizeLf(build.transform(sourceContent)));
  if (build.expectedCommands.includes(`${name}.md`)) {
    writeFile(dir, `plugins/tech-persistence/skills/${name}/SKILL.md`, build.commandToSkill(`${name}.md`, sourceContent));
  }
}

function clearRequireCache(dir) {
  // Each scenario re-requires from its own tmp dir; require.cache is keyed by
  // realpath, so clear entries pointing inside this dir.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dir)) delete require.cache[key];
  }
}

// ─────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────

function scenarioUserLevelChangedNotSynced() {
  const dir = makeRepo('s1');
  clearRequireCache(dir);

  writeFile(dir, 'user-level/commands/sprint.md', SPRINT_V1);
  syncedDerivedSet(dir, 'sprint', SPRINT_V1);
  gitAdd(dir, 'user-level/commands/sprint.md',
    '.codex/commands/sprint.md',
    'plugins/tech-persistence/commands/sprint.md',
    'plugins/tech-persistence/skills/sprint/SKILL.md');
  execSync('git commit -q -m "v1 synced"', { cwd: dir });

  // Now modify source, do NOT update derived
  writeFile(dir, 'user-level/commands/sprint.md', SPRINT_V2);
  gitAdd(dir, 'user-level/commands/sprint.md');

  const res = runCheck(dir);
  assert(res.code === 1, `expected exit 1, got ${res.code}. stderr=${res.stderr}`);
  assert(/Propagate sync/.test(res.stderr), `stderr missing propagate error: ${res.stderr}`);
  assert(/修复（按顺序执行）/.test(res.stderr), `stderr missing fix command: ${res.stderr}`);
}

function scenarioUserLevelChangedAndSynced() {
  const dir = makeRepo('s2');
  clearRequireCache(dir);

  writeFile(dir, 'user-level/commands/sprint.md', SPRINT_V1);
  syncedDerivedSet(dir, 'sprint', SPRINT_V1);
  gitAdd(dir, 'user-level/commands/sprint.md',
    '.codex/commands/sprint.md',
    'plugins/tech-persistence/commands/sprint.md',
    'plugins/tech-persistence/skills/sprint/SKILL.md');
  execSync('git commit -q -m "v1 synced"', { cwd: dir });

  // Modify source AND derived together
  writeFile(dir, 'user-level/commands/sprint.md', SPRINT_V2);
  syncedDerivedSet(dir, 'sprint', SPRINT_V2);
  gitAdd(dir, 'user-level/commands/sprint.md',
    '.codex/commands/sprint.md',
    'plugins/tech-persistence/commands/sprint.md',
    'plugins/tech-persistence/skills/sprint/SKILL.md');

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0, got ${res.code}. stderr=${res.stderr}`);
  // Critical: distinguish real pass from silent fail-open path.
  assert(
    !/hook 内部异常已忽略|fail-open 放行/.test(res.stderr),
    `expected real pass, got fail-open: stderr=${res.stderr}`
  );
}

function scenarioRulesPathOutOfSync() {
  const dir = makeRepo('s6');
  clearRequireCache(dir);

  const ruleV1 = `# Auto Mode Rule v1\n\nThis rule mentions Claude Code and ~/.claude/rules.\n`;
  const ruleV2 = `# Auto Mode Rule v2\n\nThis rule mentions Claude Code and ~/.claude/rules.\nAnd has a new line.\n`;

  const propagate = require(path.join(dir, 'scripts/propagate-command-changes.js'));

  writeFile(dir, 'user-level/rules/auto-mode.md', ruleV1);
  writeFile(dir, '.codex/rules/auto-mode.md', propagate.applyCodexRegex(ruleV1));
  gitAdd(dir, 'user-level/rules/auto-mode.md', '.codex/rules/auto-mode.md');
  execSync('git commit -q -m "v1 rule synced"', { cwd: dir });

  // Modify source, do NOT update derived
  writeFile(dir, 'user-level/rules/auto-mode.md', ruleV2);
  gitAdd(dir, 'user-level/rules/auto-mode.md');

  const res = runCheck(dir);
  assert(res.code === 1, `expected exit 1, got ${res.code}. stderr=${res.stderr}`);
  assert(/propagate rule output mismatch/.test(res.stderr), `expected rule mismatch reason in stderr: ${res.stderr}`);
  assert(/--rules auto-mode/.test(res.stderr), `expected derived repair command with --rules, got: ${res.stderr}`);
}

function scenarioFailOpenOnMissingTransformer() {
  // This is the hook's keystone promise: if a hook-internal dependency disappears,
  // the commit must still pass. Tests that the MISSING_TRANSFORMERS path produces
  // exit 0 with a diagnostic message.
  const dir = makeRepo('s7');
  clearRequireCache(dir);

  writeFile(dir, 'user-level/commands/sprint.md', SPRINT_V2);
  gitAdd(dir, 'user-level/commands/sprint.md');

  // Delete the transformer dependency
  fs.rmSync(path.join(dir, 'plugins/tech-persistence/scripts/build-codex-plugin.js'));

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0 (fail-open), got ${res.code}. stderr=${res.stderr}`);
  assert(
    /MISSING_TRANSFORMERS|派生脚本缺失|fail-open 放行/.test(res.stderr),
    `expected fail-open diagnostic in stderr: ${res.stderr}`
  );
}

function scenarioPlanMissingAssumptionSection() {
  const dir = makeRepo('s3');
  clearRequireCache(dir);

  const planContent = `---
title: "Foo"
status: draft
created: "2026-05-12"
tags: [sprint]
---

# Foo

## 需求分析

### 要做
- A thing

### 风险和假设
- a risk
`;
  writeFile(dir, 'docs/plans/2026-05-12-foo.md', planContent);
  gitAdd(dir, 'docs/plans/2026-05-12-foo.md');

  const res = runCheck(dir);
  assert(res.code === 1, `expected exit 1, got ${res.code}. stderr=${res.stderr}`);
  assert(/Plan scope lint/.test(res.stderr), `stderr missing plan error: ${res.stderr}`);
  assert(/关键假设验证/.test(res.stderr), `stderr missing anchor reference: ${res.stderr}`);
}

function scenarioPlanWithAssumptionSection() {
  const dir = makeRepo('s4');
  clearRequireCache(dir);

  const planContent = `---
title: "Foo"
status: draft
created: "2026-05-12"
tags: [sprint]
---

# Foo

## 需求分析

### 风险和假设

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| 假设一些事情 | Read 一些文件 | 已验证通过 |
| 假设另外的事情 | Read 另外的文件 | 已验证通过 |
| 第三个假设 | 跑命令 | 实际符合 |
`;
  writeFile(dir, 'docs/plans/2026-05-12-foo.md', planContent);
  gitAdd(dir, 'docs/plans/2026-05-12-foo.md');

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0, got ${res.code}. stderr=${res.stderr}`);
}

function scenarioGrandfatheredPlan() {
  const dir = makeRepo('s5');
  clearRequireCache(dir);

  const planContent = `---
title: "Old plan"
status: completed
created: "2026-04-09"
tags: [sprint]
---

# Old

## 需求分析

This plan predates ADR-012 and has no 「关键假设验证」 section.
`;
  writeFile(dir, 'docs/plans/2026-04-09-old.md', planContent);
  gitAdd(dir, 'docs/plans/2026-04-09-old.md');

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0 (grandfathered), got ${res.code}. stderr=${res.stderr}`);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function main() {
  process.stdout.write('\nsmoke: pre-commit-check.js\n');
  runScenario('S1: user-level changed but derived not synced → exit 1', scenarioUserLevelChangedNotSynced);
  runScenario('S2: user-level changed and derived synced → exit 0 (not fail-open)', scenarioUserLevelChangedAndSynced);
  runScenario('S3: new plan doc missing 关键假设验证 → exit 1', scenarioPlanMissingAssumptionSection);
  runScenario('S4: new plan doc with 关键假设验证 → exit 0', scenarioPlanWithAssumptionSection);
  runScenario('S5: grandfathered old plan (filename date < 2026-05-12) → exit 0', scenarioGrandfatheredPlan);
  runScenario('S6: user-level/rules/ source out of sync → exit 1 with --rules in repair cmd', scenarioRulesPathOutOfSync);
  runScenario('S7: missing transformer module → exit 0 with fail-open diagnostic', scenarioFailOpenOnMissingTransformer);

  process.stdout.write(`\nresult: ${passed} passed, ${failed} failed\n`);

  if (!KEEP) {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } else {
    process.stdout.write(`tmp dirs kept:\n${tmpDirs.map((d) => `  ${d}`).join('\n')}\n`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main();
