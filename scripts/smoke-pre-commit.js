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
    'scripts/lib/hook-registry.js',
    'plugins/tech-persistence/scripts/build-codex-plugin.js',
    'scripts/pre-commit-check.js',
    'scripts/sync-solution-index.js',
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
  // plugin command 是 plain copy (与 pre-commit-check.js 期望对齐, 服务 Claude Code 2.x plugin)
  writeFile(dir, `plugins/tech-persistence/commands/${name}.md`, build.normalizeLf(sourceContent));
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

function scenarioTopLevelHandoffBlocked() {
  const dir = makeRepo('handoff');
  writeFile(dir, 'docs/plans/demo-handoff-1.md', '---\ntype: sprint-handoff\n---\n# Handoff\n');
  gitAdd(dir, 'docs/plans/demo-handoff-1.md');

  const res = runCheck(dir);
  assert(res.code === 1, `expected exit 1, got ${res.code}. stderr=${res.stderr}`);
  assert(/Top-level handoff/.test(res.stderr), `stderr missing top-level handoff error: ${res.stderr}`);
  assert(/docs\/plans\/\.handoff/.test(res.stderr), `stderr missing .handoff repair path: ${res.stderr}`);
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

// ─────────────────────────────────────────────────────────────
// Orchestrator sync scenarios (S8-S12) — enforce sha256 between
// scripts/agent-orchestrator.js (+ /*.js) and plugin copies.
// ─────────────────────────────────────────────────────────────

const ORCH_MAIN_SRC = 'scripts/agent-orchestrator.js';
const ORCH_MAIN_DST = 'plugins/tech-persistence/scripts/agent-orchestrator.js';
const ORCH_SUB_SRC_DIR = 'scripts/agent-orchestrator';
const ORCH_SUB_DST_DIR = 'plugins/tech-persistence/scripts/agent-orchestrator';

function setupOrchestratorFixture(dir, mainContent, submodules = {}) {
  writeFile(dir, ORCH_MAIN_SRC, mainContent);
  writeFile(dir, ORCH_MAIN_DST, mainContent);
  for (const [name, content] of Object.entries(submodules)) {
    writeFile(dir, `${ORCH_SUB_SRC_DIR}/${name}`, content);
    writeFile(dir, `${ORCH_SUB_DST_DIR}/${name}`, content);
  }
}

function scenarioOrchestratorSynced() {
  const dir = makeRepo('s8');
  clearRequireCache(dir);

  setupOrchestratorFixture(dir, '// orchestrator v1\nmodule.exports = {};\n', {
    'queue.js': '// queue\n',
  });
  gitAdd(dir, ORCH_MAIN_SRC, ORCH_MAIN_DST, `${ORCH_SUB_SRC_DIR}/queue.js`, `${ORCH_SUB_DST_DIR}/queue.js`);

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0, got ${res.code}. stderr=${res.stderr}`);
  assert(
    !/hook 内部异常已忽略|fail-open 放行|MISSING_TRANSFORMERS/.test(res.stderr),
    `expected real pass, got fail-open: stderr=${res.stderr}`
  );
}

function scenarioOrchestratorTampered() {
  const dir = makeRepo('s9');
  clearRequireCache(dir);

  setupOrchestratorFixture(dir, '// orchestrator v1\n', { 'queue.js': '// queue v1\n' });
  gitAdd(dir, ORCH_MAIN_SRC, ORCH_MAIN_DST, `${ORCH_SUB_SRC_DIR}/queue.js`, `${ORCH_SUB_DST_DIR}/queue.js`);
  execSync('git commit -q -m "synced"', { cwd: dir });

  // Tamper plugin copy of a submodule
  writeFile(dir, `${ORCH_SUB_DST_DIR}/queue.js`, '// queue v1\n// TAMPERED\n');
  gitAdd(dir, `${ORCH_SUB_DST_DIR}/queue.js`);

  const res = runCheck(dir);
  assert(res.code === 1, `expected exit 1, got ${res.code}. stderr=${res.stderr}`);
  assert(/agent-orchestrator\/queue\.js/.test(res.stderr), `stderr missing file name: ${res.stderr}`);
  assert(/sha256 mismatch/.test(res.stderr), `stderr missing reason: ${res.stderr}`);
  assert(/build-codex-plugin/.test(res.stderr), `stderr missing repair command: ${res.stderr}`);
}

function scenarioOrchestratorCRLFSource() {
  // Windows editors may save source with CRLF. Plugin build always writes LF.
  // Raw-byte sha would mismatch forever; LF-normalization makes them equal.
  const dir = makeRepo('s10');
  clearRequireCache(dir);

  const content = '// orchestrator\nmodule.exports = {};\n';
  writeFile(dir, ORCH_MAIN_SRC, content.replace(/\n/g, '\r\n'));  // CRLF source
  writeFile(dir, ORCH_MAIN_DST, content);                          // LF plugin copy
  gitAdd(dir, ORCH_MAIN_SRC, ORCH_MAIN_DST);

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0 (LF-normalized hash should match), got ${res.code}. stderr=${res.stderr}`);
  assert(
    !/hook 内部异常已忽略|fail-open 放行|sha256 mismatch/.test(res.stderr),
    `expected clean pass without sha mismatch, stderr=${res.stderr}`
  );
}

function scenarioOrchestratorSourceDeletedOrphan() {
  const dir = makeRepo('s11');
  clearRequireCache(dir);

  setupOrchestratorFixture(dir, '// orchestrator\n', { 'queue.js': '// queue\n', 'locks.js': '// locks\n' });
  gitAdd(dir, ORCH_MAIN_SRC, ORCH_MAIN_DST,
    `${ORCH_SUB_SRC_DIR}/queue.js`, `${ORCH_SUB_DST_DIR}/queue.js`,
    `${ORCH_SUB_SRC_DIR}/locks.js`, `${ORCH_SUB_DST_DIR}/locks.js`);
  execSync('git commit -q -m "synced with submodules"', { cwd: dir });

  // Delete source submodule but leave plugin copy → orphan
  execSync(`git rm -- "${ORCH_SUB_SRC_DIR}/locks.js"`, { cwd: dir });

  const res = runCheck(dir);
  assert(res.code === 1, `expected exit 1, got ${res.code}. stderr=${res.stderr}`);
  assert(/orphan plugin submodule|source file missing/.test(res.stderr), `stderr missing orphan/missing msg: ${res.stderr}`);
}

function scenarioOrchestratorNestedSubdir() {
  // build-codex-plugin.copyAgentOrchestratorSubmodules is non-recursive.
  // pre-commit-check must surface that contract by reporting nested dirs.
  const dir = makeRepo('s12');
  clearRequireCache(dir);

  setupOrchestratorFixture(dir, '// orchestrator\n', { 'queue.js': '// queue\n' });
  writeFile(dir, `${ORCH_SUB_SRC_DIR}/providers/claude.js`, '// nested provider\n');
  gitAdd(dir, ORCH_MAIN_SRC, ORCH_MAIN_DST,
    `${ORCH_SUB_SRC_DIR}/queue.js`, `${ORCH_SUB_DST_DIR}/queue.js`,
    `${ORCH_SUB_SRC_DIR}/providers/claude.js`);

  const res = runCheck(dir);
  assert(res.code === 1, `expected exit 1, got ${res.code}. stderr=${res.stderr}`);
  assert(/nested directory|non-recursive/.test(res.stderr), `stderr missing nested-dir reason: ${res.stderr}`);
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
// Plan completion verify scenarios (S13a-f) — C7 / ADR-013.
// Validate that sprints marked status:completed have actually
// touched the inline-code paths claimed by checked tasks.
// ─────────────────────────────────────────────────────────────

function planWithFrontmatter({ type, status, body }) {
  return `---
title: "Smoke plan"
type: ${type}
status: ${status}
created: "2026-05-13"
tags: [sprint]
---

# Smoke plan

## 需求分析

### 风险和假设

**关键假设验证**:

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| 一项假设是这样的需要确认 | Read 一些文件并跑命令验证 | 已确认通过且无问题 |
| 第二项假设也是这样需要看 | Read 别的文件并跑 grep 命令 | 已确认通过且无问题 |
| 第三项假设这样验证 | 跑一些命令做验证 | 实际符合预期目标 |

${body}
`;
}

function scenarioPlanCompletionPathInDiff() {
  // S13a: type=sprint + status=completed + checked task with path that DOES appear in diff → pass
  const dir = makeRepo('s13a');
  clearRequireCache(dir);

  // Pre-create a target file and commit, so it appears in `git log` since the plan date.
  writeFile(dir, 'scripts/foo.js', '// foo\n');
  gitAdd(dir, 'scripts/foo.js');
  execSync('git commit -q -m "add foo"', { cwd: dir });

  const body = `## 技术方案

### 任务拆解

- [x] **Task 1**: implement foo — 文件: \`scripts/foo.js\`
`;
  writeFile(dir, 'docs/plans/2026-05-13-smoke.md', planWithFrontmatter({
    type: 'sprint', status: 'completed', body,
  }));
  gitAdd(dir, 'docs/plans/2026-05-13-smoke.md');

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0, got ${res.code}. stderr=${res.stderr}`);
  assert(
    !/hook 内部异常已忽略|fail-open 放行|MISSING_TRANSFORMERS/.test(res.stderr),
    `expected real pass, got fail-open: stderr=${res.stderr}`
  );
}

function scenarioPlanCompletionPathMissing() {
  // S13b: type=sprint + status=completed + checked task with path NOT in diff → fail
  const dir = makeRepo('s13b');
  clearRequireCache(dir);

  // No prior commit touching scripts/missing.js, and not staged either.
  const body = `## 技术方案

### 任务拆解

- [x] **Task 1**: implement missing — 文件: \`scripts/missing.js\`
`;
  writeFile(dir, 'docs/plans/2026-05-13-smoke.md', planWithFrontmatter({
    type: 'sprint', status: 'completed', body,
  }));
  gitAdd(dir, 'docs/plans/2026-05-13-smoke.md');

  const res = runCheck(dir);
  assert(res.code === 1, `expected exit 1, got ${res.code}. stderr=${res.stderr}`);
  assert(/Plan completion verify/.test(res.stderr), `stderr missing C7 marker: ${res.stderr}`);
  assert(/scripts\/missing\.js/.test(res.stderr), `stderr missing path: ${res.stderr}`);
  assert(/Task 1/.test(res.stderr), `stderr missing task ref: ${res.stderr}`);
}

function scenarioPlanCompletionNoCodeTask() {
  // S13c: type=sprint + status=completed + checked task but NO inline-code path → skip (research sprint)
  const dir = makeRepo('s13c');
  clearRequireCache(dir);

  const body = `## 技术方案

### 任务拆解

- [x] **Task 1**: write research findings (no code)
- [x] **Task 2**: interview stakeholders
`;
  writeFile(dir, 'docs/plans/2026-05-13-smoke.md', planWithFrontmatter({
    type: 'sprint', status: 'completed', body,
  }));
  gitAdd(dir, 'docs/plans/2026-05-13-smoke.md');

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0 (research skip), got ${res.code}. stderr=${res.stderr}`);
}

function scenarioPlanCompletionNotSprintType() {
  // S13d: type=plan + status=completed + path missing → skip (only `type:sprint` triggers)
  const dir = makeRepo('s13d');
  clearRequireCache(dir);

  const body = `## 任务拆解

- [x] **Task 1**: implement — 文件: \`scripts/missing.js\`
`;
  writeFile(dir, 'docs/plans/2026-05-13-smoke.md', planWithFrontmatter({
    type: 'plan', status: 'completed', body,
  }));
  gitAdd(dir, 'docs/plans/2026-05-13-smoke.md');

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0 (non-sprint skip), got ${res.code}. stderr=${res.stderr}`);
}

function scenarioPlanCompletionStatusNotCompleted() {
  // S13e: type=sprint + status=in-progress + path missing → skip (only completed triggers)
  const dir = makeRepo('s13e');
  clearRequireCache(dir);

  const body = `## 任务拆解

- [x] **Task 1**: implement — 文件: \`scripts/missing.js\`
`;
  writeFile(dir, 'docs/plans/2026-05-13-smoke.md', planWithFrontmatter({
    type: 'sprint', status: 'in-progress', body,
  }));
  gitAdd(dir, 'docs/plans/2026-05-13-smoke.md');

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0 (status skip), got ${res.code}. stderr=${res.stderr}`);
}

function scenarioPlanCompletionGrandfathered() {
  // S13f: filename date < 2026-05-12 + status=completed + path missing → skip (grandfather)
  const dir = makeRepo('s13f');
  clearRequireCache(dir);

  const body = `## 任务拆解

- [x] **Task 1**: implement — 文件: \`scripts/missing.js\`
`;
  // Use a filename date strictly before the grandfather threshold.
  const planContent = `---
title: "Old"
type: sprint
status: completed
created: "2026-04-15"
---

${body}
`;
  writeFile(dir, 'docs/plans/2026-04-15-old.md', planContent);
  gitAdd(dir, 'docs/plans/2026-04-15-old.md');

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0 (grandfather), got ${res.code}. stderr=${res.stderr}`);
}

// ─────────────────────────────────────────────────────────────
// Solution index sync scenarios (S14a-b) — docs/solutions is the
// source of truth; index.jsonl + runtime docs must be regenerated by
// scripts/sync-solution-index.js before commit.
// ─────────────────────────────────────────────────────────────

function writeSolutionDoc(dir, title, summary) {
  writeFile(dir, 'docs/solutions/2026-05-18-sync-smoke.md', `---
title: "${title}"
date: 2026-05-18
tags: [solution, smoke]
---

# ${title}

## Problem

${summary}
`);
}

function syncSolutions(dir) {
  clearRequireCache(dir);
  const sync = require(path.join(dir, 'scripts/sync-solution-index.js'));
  sync.syncSolutionIndex(dir, { targets: ['claude', 'codex'] });
}

function stageSolutionSet(dir) {
  gitAdd(
    dir,
    'docs/solutions/2026-05-18-sync-smoke.md',
    'docs/solutions/index.jsonl',
    'CLAUDE.md',
    'AGENTS.md'
  );
}

function scenarioSolutionIndexChangedNotSynced() {
  const dir = makeRepo('s14a');
  clearRequireCache(dir);

  writeSolutionDoc(dir, 'Smoke Solution v1', 'Original summary.');
  syncSolutions(dir);
  stageSolutionSet(dir);
  execSync('git commit -q -m "solution synced"', { cwd: dir });

  writeSolutionDoc(dir, 'Smoke Solution v2', 'Updated summary that should force regenerated projections.');
  gitAdd(dir, 'docs/solutions/2026-05-18-sync-smoke.md');

  const res = runCheck(dir);
  assert(res.code === 1, `expected exit 1, got ${res.code}. stderr=${res.stderr}`);
  assert(/Solution index sync/.test(res.stderr), `stderr missing solution index marker: ${res.stderr}`);
  assert(/docs\/solutions\/index\.jsonl/.test(res.stderr), `stderr missing index path: ${res.stderr}`);
  assert(/CLAUDE\.md/.test(res.stderr), `stderr missing CLAUDE.md projection path: ${res.stderr}`);
  assert(/AGENTS\.md/.test(res.stderr), `stderr missing AGENTS.md projection path: ${res.stderr}`);
  assert(/sync-solution-index\.js --all/.test(res.stderr), `stderr missing repair command: ${res.stderr}`);
}

function scenarioSolutionIndexChangedAndSynced() {
  const dir = makeRepo('s14b');
  clearRequireCache(dir);

  writeSolutionDoc(dir, 'Smoke Solution v1', 'Original summary.');
  syncSolutions(dir);
  stageSolutionSet(dir);
  execSync('git commit -q -m "solution synced"', { cwd: dir });

  writeSolutionDoc(dir, 'Smoke Solution v2', 'Updated summary with regenerated projections.');
  syncSolutions(dir);
  stageSolutionSet(dir);

  const res = runCheck(dir);
  assert(res.code === 0, `expected exit 0, got ${res.code}. stderr=${res.stderr}`);
  assert(
    !/hook 内部异常已忽略|fail-open 放行|Solution index sync/.test(res.stderr),
    `expected real pass without solution drift: stderr=${res.stderr}`
  );
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
  runScenario('S7: top-level docs/plans/*-handoff-*.md staged → exit 1', scenarioTopLevelHandoffBlocked);
  runScenario('S8: missing transformer module → exit 0 with fail-open diagnostic', scenarioFailOpenOnMissingTransformer);
  runScenario('S9: orchestrator src+plugin synced → exit 0 (not fail-open)', scenarioOrchestratorSynced);
  runScenario('S10: orchestrator plugin tampered → exit 1 with file name + sha mismatch', scenarioOrchestratorTampered);
  runScenario('S11: orchestrator source CRLF + plugin LF → exit 0 (LF-normalized)', scenarioOrchestratorCRLFSource);
  runScenario('S12: orchestrator source submodule deleted, plugin remains → exit 1 (orphan)', scenarioOrchestratorSourceDeletedOrphan);
  runScenario('S13: nested subdir under scripts/agent-orchestrator/ → exit 1 (non-recursive build)', scenarioOrchestratorNestedSubdir);
  runScenario('S14a: sprint completed + checked task path in diff → exit 0 (not fail-open)', scenarioPlanCompletionPathInDiff);
  runScenario('S14b: sprint completed + checked task path missing → exit 1 with C7 marker + path', scenarioPlanCompletionPathMissing);
  runScenario('S14c: sprint completed + checked task without inline-code path → exit 0 (research skip)', scenarioPlanCompletionNoCodeTask);
  runScenario('S14d: type=plan (not sprint) + status=completed → exit 0 (non-sprint skip)', scenarioPlanCompletionNotSprintType);
  runScenario('S14e: sprint type but status=in-progress → exit 0 (status skip)', scenarioPlanCompletionStatusNotCompleted);
  runScenario('S14f: grandfathered date + completed + path missing → exit 0', scenarioPlanCompletionGrandfathered);
  runScenario('S15a: docs/solutions changed but index/projections stale → exit 1', scenarioSolutionIndexChangedNotSynced);
  runScenario('S15b: docs/solutions changed and index/projections synced → exit 0', scenarioSolutionIndexChangedAndSynced);

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
