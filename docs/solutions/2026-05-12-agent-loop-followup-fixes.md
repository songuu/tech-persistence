---
title: "Agent Loop audit Top-3 P0 修复 + 跨平台 sha256 enforcement"
date: 2026-05-12
tags: [solution, agent-loop, agent-orchestrator, pre-commit, enforcement, cross-platform, regression-tracked]
related_instincts:
  - state-file-backward-compat
  - multi-copy-doc-drift
  - documented-claim-vs-code-reality-drift
  - cross-platform-sha-needs-lf-normalize
aliases:
  - "agent-loop audit fixes"
  - "loadRun defensive default landed"
  - "orchestrator sync enforcement"
---

# Agent Loop audit Top-3 P0 修复

## Problem

2026-05-12 audit ([[2026-05-12-agent-loop-followup-audit]]) 识别出 15 项 follow-up 中 6 项 still-open + 3 项 partial。其中 Top-3 P0：

1. **F8/F9**：`scripts/agent-orchestrator*` 副本同步未纳入 pre-commit-check —— 与 [[2026-05-12-nul-hook-shell-mismatch]] 同款风险模型，commands/rules 已 enforce 但 scripts/ 裸奔
2. **F7-4**：`loadRun` 入口仍无 defensive default —— ADR-008 明示要做，[[state-file-backward-compat]] 本能写在 doc 但代码未落地（活样本）
3. **F1+F2**：pipeline mode plan `status: implemented` 但 P0/P1 + 复利记录全是占位行 —— sprint 模板 broken example，误导后人「implemented = completed」

## Root Cause

- **F8/F9**：文档级 enforcement（"记得跑 build-codex-plugin"）抵不住时间推移和重构。N≥2 回归触发了升级触发器（[[windows-hook-bash-portability]] 同款逻辑）。
- **F7-4**：[[state-file-backward-compat]] 本能 2026-05-09 写下"应该在 loadRun 入口 default"，但 caveman-audit 当时只在 `newState` 初始化没碰 `loadRun`。本能描述对的，代码未落地——这是元本能 [[documented-claim-vs-code-reality-drift]] 的活样本。
- **F1+F2**：sprint 流程的"自动化阶段"（implementation）和"手工阶段"（review + compound）边界不清晰，13 个 task 落地后 P0/P1 review 段被遗忘，复利记录变成无人填的占位行。

## Solution

### F8/F9 修复：`checkOrchestratorSync` enforcement

在 `scripts/pre-commit-check.js` 加：

```javascript
const ORCHESTRATOR_PATH_RE = /^(?:scripts|plugins\/tech-persistence\/scripts)\/agent-orchestrator(?:\.js|\/[^/]+\.js)$/;

function sha256OfFile(filePath) {
  // build-codex-plugin.js writes plugin copies via normalizeLf (CRLF → LF).
  // Hash LF-normalized bytes to match build semantics. Otherwise Windows users
  // with CRLF editors get stuck in a loop — build always writes LF, so raw-byte
  // sha mismatches forever.
  try {
    const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  } catch { return null; }
}

function checkOrchestratorSync(stagedFiles, repoRoot) {
  const trigger = stagedFiles.some((f) => ORCHESTRATOR_PATH_RE.test(f));
  if (!trigger) return [];
  // ... sha256 比对 main + 动态扫子模块 + 嵌套子目录拒绝 + 孤儿检测
}
```

关键设计点：
- **LF-normalize 在 hash 之前**：跟 `build-codex-plugin.normalizeLf` 语义一致，否则 Windows CRLF 用户死循环
- **嵌套子目录检测**：`build-codex-plugin.copyAgentOrchestratorSubmodules` 是非递归的，pre-commit 兜底报错，告诉添加 `scripts/agent-orchestrator/providers/x.js` 的人："非递归 build 不支持，先扁平化或更新 build"
- **`--diff-filter=ACMRD`**：捕获源删除，让 orphan detection 能跑
- **措辞通用化**：`formatPropagateError` 按 mismatch kind 自适应（"Propagate sync" / "agent-orchestrator 同步" / 两者皆有时合并）

### F7-4 修复：`applyStateDefaults` 纯函数

在 `scripts/agent-orchestrator.js` 抽出纯函数：

```javascript
function applyStateDefaults(state) {
  // ADR-008: persistent state may pre-date current field set. Default at the
  // deserialization boundary so every push/assign site can trust shape.
  if (state === null || state === undefined || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`state.json must be a JSON object, got ${state === null ? 'null' : Array.isArray(state) ? 'array' : typeof state}`);
  }
  if (!Array.isArray(state.providerRuns)) state.providerRuns = [];
  if (!state.files || typeof state.files !== 'object' || Array.isArray(state.files)) state.files = {};
  return state;
}

function loadRun(options, positionals) {
  const runDir = resolveRunDir(options, positionals);
  const statePath = path.join(runDir, 'state.json');
  const state = applyStateDefaults(readJson(statePath));
  return { runDir, statePath, state };
}
```

关键设计点：
- **纯函数**：可独立 self-test，不需要真实 state.json
- **mutate-in-place + 同引用返回**：保持 `loadRun` 现有契约（caller 持有相同 state ref，下游 mutate → saveState 持久化正确对象）
- **非 object 显式 throw**：而非"silently return as-is"，杜绝 reviewer CORR-5 指出的「null state 落到 push 才崩」

13 条 self-test 覆盖：legacyState gain providerRuns/files、files 数组被 coerce、providerRuns 字符串被重置、保留已有字段、null/undefined/array/string throw、同引用 mutate-in-place、files 数组真的变成 `{}`。

### F1+F2 修复：sprint status 止血

`docs/plans/2026-05-09-agent-loop-pipeline.md`：

```diff
- status: implemented
+ status: partial
+ tags: [..., sprint-not-fully-closed]
```

加 errata 块明示"13 task 已实施但 review/compound 未完成"，链到 [[2026-05-12-agent-loop-followup-audit]]。

完整止血/不替代完整 retrospective sprint —— 后者需要补 review + 写 solution doc，留作下一 sprint 候选。

## Prevention（可复利的元经验）

### 1. 跨平台 sha256 必须 LF-normalize

任何"源副本 sha256 比对"类 enforcement，如果一端走 normalize-on-write（build / codegen / format），另一端必须 normalize-on-hash。否则 Windows / CRLF editor / `core.autocrlf=true` 用户会进入死循环：build 一跑就把副本回到 LF，但源仍是 CRLF，sha 永远不等，repair command "build" 解不开。

参考实现：`scripts/pre-commit-check.js::sha256OfFile`。

参照对比：[[multi-copy-doc-drift]] 中 propagate-command-changes 用 string equality（直接含 `\n` 字面），不存在这个问题；本 sprint 新加的 orchestrator sync 用 fs.readFileSync 字节读，必须先 normalize。

### 2. 非递归 build + matching detection 的契约对偶

如果一个 build/codegen 步骤选择非递归（例如本项目 `copyAgentOrchestratorSubmodules` 只扫顶层 .js），下游所有依赖该 build 输出的 enforcement 必须**主动检测并拒绝违反 flat invariant 的输入**。否则添加 `scripts/agent-orchestrator/providers/claude.js` 这类嵌套：
- build 静默不复制
- pre-commit sha256 不比对（regex 不匹配嵌套路径）
- 用户看到 `git status` 一切正常
- 运行时 `require` 报 module not found，根因在 build 设计

兜底设计：`checkOrchestratorSync` 在动态扫源 dir 时遇到子目录立刻 push 一条 mismatch（reason "nested directory ... build is non-recursive; flatten or update build-codex-plugin"）。

### 3. 一次性 bash smoke 必须升级为可重放 scenario

ADR-013「dogfood 必须枚举边界产物」的真正兑现是 **smoke 必须可重放**，不只是"曾经跑过一次写在 changelog 里"。本 sprint 第一版只在 work 阶段跑了一次 bash 三步（current/tamper/restore），changelog 记录了"它过了"——但下次 refactor checkOrchestratorSync 时这个验证不会自动重跑。

ce-testing-reviewer 强制本 sprint 把它升级为 `scripts/smoke-pre-commit.js` 中的 5 个 scenario（S8-S12），覆盖 synced / tampered / CRLF-source / src-deleted-orphan / nested-subdir。这才是 ADR-013 的真正落地。

规则上升：写 enforcement 必须配 ≥1 个 negative-sample test，写在标准 smoke 文件中而非临时脚本/changelog。

### 4. 元本能的反身性：本能写在 doc ≠ enforcement

[[state-file-backward-compat]] 在 2026-05-09 被创建时描述了"应该在 loadRun 入口 default"——但实际代码没改，只在新建路径 `newState` 初始化。本能存在 5 个月（按记忆）但未落地，直到 2026-05-12 audit 抓出。

[[documented-claim-vs-code-reality-drift]] 元本能是本现象的总结：**本能 / 元经验 / 元规则 写下来不等于 enforcement，enforcement 只有在 pre-commit / test / lint / CI 才算数**。

本 sprint 通过把：
- F8/F9 → pre-commit-check (kind:'orchestrator')
- F7-4 → loadRun 入口代码 + 13 self-test
- F1+F2 → frontmatter `status: partial` 标识 broken example

把 3 个本能从「文档级提醒」升级为「机制级 enforcement」。

## Test Plan

- ✅ `node scripts/agent-orchestrator.js self-test` — passed (13 新 assertion 全过)
- ✅ `node scripts/smoke-pre-commit.js` — 12/12 passed (S1-S12)
- ✅ `node scripts/validate-codex-plugin.js` — passed
- ✅ `node scripts/pre-commit-check.js` — EXIT=0 (当前态合规)
- ✅ sha256 13 文件根/plugin 全 EQUAL
- ✅ 负样本 smoke 三步显式（S8 → S9 → S11）—— enforcement 真在拒，不是 fail-open trivially passing

## Related

- [[2026-05-12-agent-loop-followup-audit]] — 本修复的源 audit 报告
- [[2026-05-09-agent-loop-caveman-audit]] — F7-4 / F8 来源（本能写在 doc 但当时未代码化）
- [[2026-05-12-nul-hook-shell-mismatch]] — F8/F9 同款风险模型（多副本飘移），本次是其 cousin 落地
- [[state-file-backward-compat]] — 本能落地证据（confidence 升级）
- [[multi-copy-doc-drift]] — 本能落地证据（scripts/ 子集闭环）
- [[documented-claim-vs-code-reality-drift]] — 元本能的反身性证据（本能描述变成代码）
- [[cross-platform-sha-needs-lf-normalize]] — 新提取本能
- [[ADR-008]] state 文件向后兼容（终于代码化）
- [[ADR-013]] dogfood 必须枚举边界产物（再次兑现，从 prose 升级到 scenarios）
