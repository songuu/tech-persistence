---
title: "单元测试架构基线 v1：从 0 framework 到可测试 + CI 多平台"
date: 2026-05-18
tags: [solution, testing, ci, cross-platform, hook, architecture]
related_instincts: [baseline-verify-before-blaming-current-sprint, hook-entry-testability-3-piece, negative-sample-3-archs]
aliases: ["unit-test-baseline-v1", "测试架构基线", "node-test-runner"]
---

# 单元测试架构基线 v1

## Problem

本仓库 34 JS 文件（6158 行），**0** 测试框架 / **0** package.json / 仅 3 个手写 `test-*.js` 且**全部不在 CI 中跑**。审计发现 7 类架构缺陷阻碍单元测试。用户原话：「单元测试是必须的一步」——已存在但失效的测试基础设施 = 测试金字塔倒挂 + 回归保护 = 0。

## Root Cause

历史路径依赖：
- 早期仅靠 smoke + validator 覆盖端到端 → 没引入框架的理由也合理（[[ADR-011]] 轻量原则）
- 后续手写 `test-*.js` 时**没人加 CI step** → 写了等于白写（C2 bug `6d9c05a` 修复后补的 self-test 也只在本地跑）
- hook 入口（observe.js / caveman-activate.js）设计为「main 顶层执行」，require 时立刻触发副作用，**无法纯单测**
- CI 仅 macOS 单平台 → Windows-specific bug 已踩 ≥3 次（[[bash-pipefail-vs-ls-no-match]] / [[ps1-needs-utf8-bom]] / `[2026-05-12 hooks, shell-mismatch]`）

## Solution

采用 **S2 scope**（D1 + D2 + D4(C) + D6 + D7(C)）：

### 1. 引入 zero-dep test framework（D1A）

新建 `package.json`（`private: true` + `engines.node >= 18` + 零 dependencies） + `scripts/run-tests.js` runner：
- 扫描 `scripts/test-*.js` 串行 `spawnSync` 跑（隔离 require 缓存 + 避免 node:test 命名冲突）
- 聚合 pass/fail，`return failed > 0 ? 1 : 0`（防 POSIX exit code mod 256 fail-open）
- 支持 `--grep` / `--list` 参数
- `NODE_NO_WARNINGS=1` 过滤 ExperimentalWarning

**对比方案**：jest/vitest 引入 100+ deps 违反 [[ADR-011]] 轻量原则；`find -exec` 过简，无聚合 exit code / grep。

### 2. CI 接入 + 跨平台 matrix（D2 + D6）

`.github/workflows/macos-cross-platform.yml` 重写：
- 新增 `Run unit tests` step（跑 `node scripts/run-tests.js`）
- `matrix.os: [ubuntu-latest, macos-latest, windows-latest]`（之前仅 macos-latest）
- `defaults.run.shell: bash`（windows 走 git-bash）
- install probe step 加 `if: matrix.os != 'windows-latest'`（git-bash 路径差异，Windows 单独 ps1 probe 留 backlog）
- Job rename `macos-smoke` → `ci`（需手动更新 branch protection rules）

### 3. Hook 入口可测性三件套（D4C + D7C）

`scripts/observe.js` + `scripts/caveman-activate.js`：
- 加 `if (require.main === module)` 守卫（与项目内 9 个现有脚本一致）
- 加 `module.exports = { main, ...pureFunctions }`
- observe.js 补 `[observe] hook failed:` 标准化 log（caveman-activate.js 已有）

新单测：
- `test-hook-entries.js`（16 tests）：resolveMode 三档优先级 / readConfigMode 边界 / VALID_MODES 完整性 / observe.js exports + 无副作用
- `test-merge-claude-settings-hooks.js`（6 tests）：`buildClaudeClassicHookSpecs` 输出的 hook command 不含 cmd 风格 `2>nul` / `exit /b` / `>nul` / `%VAR%`（防 `[2026-05-12 hooks, shell-mismatch]` 回归）

### 4. ADR-013 §B 三档负样本（C6 补全）

按 [[ADR-013]] §B 精神，enforcement 必须验证 3 档：
- **pass**: 当前态全过 ✓
- **fail-by-breaking-test**: 改测试断言让 fail → runner exit=1 ✓
- **fail-by-breaking-impl**（黄金标准）:
  - 负样本 A: 改 `caveman-activate.resolveMode` 写死返回 `'lite'` → test-hook-entries B1/B2/B3 fail → runner exit=1 ✓
  - 负样本 B: 改 `hook-registry.js` 把 hook command 注入 `2>nul` → test-merge W1/W3 fail → runner exit=1 ✓

只有 c 档才能证明 test 真在守 impl 行为而非仅 self-consistent。

## Prevention

### 关键习惯（写入新本能 [[hook-entry-testability-3-piece]]）

任何新 hook 入口脚本必须满足三件套：
1. `if (require.main === module)` 守卫
2. `module.exports = { main, ...pureFns }`
3. `[<name>] hook failed:` 标准化 log（见 [[2026-05-09 hooks, observability]]）

### 验证回归归因（写入新本能 [[baseline-verify-before-blaming-current-sprint]]）

跑 sprint 后任何 CI step / smoke / test fail 都要先：
```bash
git stash push -m "verify-baseline" -- <changed scope>
node scripts/<failing-step>.js
git stash pop
```

如 baseline 同 fail → pre-existing，与本 sprint 无关；如 baseline pass → 本 sprint 引入回归，必须修。

本 sprint 实战：smoke-pre-commit S1/S2/S6 fail → stash 后仍 `15 pass / 3 fail` → 确认 pre-existing（独立 sprint 处理）。

### 测试 enforcement 三档负样本（写入新本能 [[negative-sample-3-archs]]）

任何新 enforcement（pre-commit / test / lint / CI）合并前必须三档验证：
- a) pass 场景
- b) 改测试断言让 fail（验证 runner exit code 链路）
- c) 改生产代码让 fail（验证 test 真在守 impl 行为）

跳过 c 档 = enforcement 可能 self-consistent fail-open（test 不真测 impl）。

### Reviewer 选择策略

4 视角并行 spawn 各抓不同 P0：
- correctness/testing reviewer → 抓 forbidden patterns 大小写 / exit code fail-open
- architecture reviewer → 抓 plugin 副本未同步（C1）
- CI/cross-platform reviewer → 抓 smoke needle 硬编码（C2）
- dogfood-boundary reviewer → 抓 hook re-install 不热更新 / 三档负样本缺失

单一 reviewer 不可能同时覆盖所有视角。**未来涉及 CI / 跨副本 / hook 改造的 sprint 必须 ≥4 视角并行。**

## Related

- [[baseline-verify-before-blaming-current-sprint]] — 新本能
- [[hook-entry-testability-3-piece]] — 新本能
- [[negative-sample-3-archs]] — 新本能
- [[ADR-011]] — 4 不可妥协原则（轻量优先驱动 zero-dep package.json + node:test）
- [[ADR-013]] §B — 新 enforcement 必须枚举边界产物（本 sprint 实战应用）
- [[ADR-014]] — Hook 架构统一语义源头（本 sprint C1 plugin 副本同步即源于此）
- [[ADR-015]] — Memory v5 双系统（与本 sprint 无关但前 sprint 同源）
- [[2026-05-09 hooks, observability]] — `[hook] failed:` log 规则（observe.js 本 sprint 补全）
- [[2026-05-12 hooks, shell-mismatch]] — cmd vs bash 风格混用（test-merge 守护此 gotcha）
- [[bash-pipefail-vs-ls-no-match]] — 跨平台 install probe 痛点之一
- [[documented-claim-vs-code-reality-drift]] N=3 — C2 修复才补 self-test = 之前 0 覆盖典型反例
- `docs/plans/2026-05-18-unit-test-architecture-audit.md` — 本 sprint 完整审计 + 7 类缺陷矩阵

## 后续 sprint 候选（P2 → backlog）

| 候选 | 描述 | 触发条件 |
|------|------|---------|
| install.sh 加 hook 自动 diff-cp | 已装用户 re-install 自动覆盖新版本 hook | hook log 改造 N=2 时 |
| smoke-pre-commit S1/S2/S6 修复 | 临时 dir 补复 `scripts/lib/hook-registry` | 优先级低（CI 不阻塞，独立 sprint） |
| observe.js stdin 阻塞修复 | `fs.readFileSync(0)` 在 CLI 无 stdin pipe 时挂 | 用户报告 |
| test-* mkdtemp 自动清理 | try/finally 模式 | 本地反复跑污染 tmpdir 时 |
| run-tests.js 加 --bail + timeout | 单 test 卡死防全 CI 卡 | flaky test 出现时 |
| ADR-013 §B 升级 pre-commit-check | 强制新 test-*.js 必须含 3 档负样本注释 | N=3 跳过三档时 |
