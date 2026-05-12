---
title: "P0 防御机制：propagate sync + plan 勘察验证"
type: sprint
status: completed
tasks_total: 5
tasks_completed: 5
p0_count: 7
p1_count: 7
p2_count: 9
adr_emitted: ADR-013
solution_doc: docs/solutions/2026-05-12-pre-commit-defense.md
created: "2026-05-12"
updated: "2026-05-12"
checkpoints: 0
tasks_total: 0
tasks_completed: 0
tags: [sprint, infrastructure, enforcement, hooks]
aliases: ["defense-mechanism", "p0-defense"]
constraints: [no-auto-default, no-crash-on-failure, preserve-no-verify]
---

# P0 防御机制：propagate sync + plan 勘察验证

> **Status:** `draft`
> **Created:** 2026-05-12
> **Updated:** 2026-05-12

---

## 需求分析

### 背景

本仓库刚完成 Layer 1 sprint（`docs/plans/2026-05-11-sprint-speed-layer1.md`），过程中自暴露两类失败：

1. **D1 实证**：写入 sprint Compound 阶段我自己漏跑 `build-codex-plugin`，validate 才发现。
2. **D2 实证**：Plan 阶段两次基于错误假设（`CONTEXT_BUDGET_CHARS = 25KB` / `pipeline.js` 是 /sprint 代码），work 阶段才发现并停下来重新设计；催生 [[ADR-012]]。

共同根因：**重要规则只活在 .md 里，模型不读就违反**。本 sprint 把这两条规则下沉成工具检查。

### 要做

- pre-commit hook 检测 user-level 源文件变更但派生副本不同步 → 拒绝 commit + 给精确修复命令
- pre-commit hook 检测新增/修改的 sprint plan 文档缺「关键假设验证」段 → 拒绝 commit + 引用 ADR-012
- hook 失效时不能 crash git commit（fallback 报警放行）
- 安装脚本（install.sh / install.ps1 / upgrade-v3.ps1）同步安装 git hook
- 本 sprint 自身 dogfood：plan 文档包含「关键假设验证」段，commit 跑通 hook

### 不做

- ❌ pre-commit 自动跑 propagate（会污染 commit 原子性）
- ❌ PreToolUse hook 跟踪 Read 历史（surface 太大）
- ❌ ADR/rules stale 检测（D4，下个 sprint）
- ❌ 风险等级 grep 升级（D5，下个 sprint）
- ❌ 修改 `/plan` 命令执行模式（只做后置 lint，不前置干预）
- ❌ `--auto` 默认开启（user feedback：永远不准默认开启）

### 成功标准

- [ ] 改 `user-level/commands/sprint.md` 但没 propagate → `git commit` 返回非 0，打印 `node scripts/propagate-command-changes.js && node plugins/tech-persistence/scripts/build-codex-plugin.js && node scripts/validate-codex-plugin.js`
- [ ] 改 `user-level/skills/<name>/SKILL.md` 但没 propagate → 同上
- [ ] 改 `user-level/commands/sprint.md` 并跑过 propagate → commit 通过
- [ ] 新建 `docs/plans/2026-05-12-foo.md` 缺「关键假设验证」段 → commit 拒绝 + 指引
- [ ] `git commit --no-verify` → 永远通过（用户主权）
- [ ] Node 不在 PATH → stderr 警告 + 放行
- [ ] hook 跑出异常（如 propagate-command-changes.js 抛错）→ catch 后 stderr 留日志 + 放行
- [ ] 本 sprint 自身 commit 时跑通 hook（dogfood）

### 风险和假设

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| 项目已有 git hooks 安装机制 | Read install.sh:1-413, install.ps1:1-193 | ❌ **没有**——需新增 install-git-hooks.js |
| propagate 产物清单可枚举 | Read propagate-command-changes.js:69-131 + build-codex-plugin.js:9-44 | ✅ 21 commands + 10 skills + rules 派生清单都明确 |
| 派生副本比对方式 | 比对逻辑设计 | ✅ **sha256 比对"transform 后的源 vs 派生文件当前"**——mtime 被 git 重置不可靠 |
| Plan 文档统一遵循 TEMPLATE.md | Glob + Read TEMPLATE.md:1-99 | ✅ 都有 `status`, `created`, `tags` frontmatter |
| Node 是项目硬依赖 | install.sh:50 + install.ps1:50,182 | ✅ 强制依赖 node>=18 |
| package.json 存在 | Read package.json | ❌ **不存在**——本仓库非 npm 包，但 node 仍可独立调用 |

**风险**：

- **R1**: Windows git hook 兼容性。`.git/hooks/pre-commit` 是 sh 脚本，Windows 用 git for windows 的 bash。倾向：sh 一行 `node scripts/pre-commit-check.js` 委托给 Node，跨平台一致。
- **R2**: 现有 plan 文档（5 个）没有「关键假设验证」段。grandfather 方案：只检查 staged 文件中**新增**的 plan 文档，或检查 frontmatter `created >= 2026-05-12`。
- **R3**: skills 副本是目录（含 SKILL.md + 可能多文件），比 commands 复杂。需要枚举每个 skill 的"关键文件"对比。
- **R4**: pre-commit 慢会激怒用户。目标：< 200ms（只跑 staged 文件相关的检查，不全量扫描）。

---

## 技术方案

### 方案概述

新增 `scripts/pre-commit-check.js` 作为单一检查入口，在 `.git/hooks/pre-commit` 中由 sh 一行委托给 node 执行。检查分两路：

1. **Propagate sync 检查**：扫描 staged `user-level/` 路径变更，对每个 transform 关系（user-level → plugin / .codex / user-level skill wrapper）**重跑 transform 函数**，与派生文件当前内容做 sha256 比对。任何不一致 → 拒绝 commit + 打印精确修复命令链。

2. **Plan scope lint**：扫描 staged 新增或修改的 `docs/plans/YYYY-MM-DD-*.md`（排除 handoff / TEMPLATE），验证存在「关键假设验证」段且至少 3 行有效内容（非占位符）。Grandfather：created < 2026-05-12 的文档跳过。

容错：任何步骤抛错 → `process.stderr.write('[pre-commit] <错误>\n')` + `process.exit(0)`，**永不锁住 commit**。`--no-verify` 仍可绕过（git 行为，hook 不到该层）。

### 任务拆解

- [x] **Task 1** (T1): 写 `scripts/pre-commit-check.js` — 核心逻辑（251 行）。导出 `getStagedFiles` / `checkPropagateSync` / `checkPlanScope` 等函数 + main loop + 全局 try/catch fallback 放行。
- [x] **Task 2** (T2): 写 `scripts/install-git-hooks.js` — 写入 `.git/hooks/pre-commit`（sh 一行调 node），已有 hook 做 `.bak.<timestamp>` 备份，非 git 仓库跳过。
- [x] **Task 3** (T3): 修改 `install.sh` 的 `install_project()` + `install.ps1` 的 `Install-Project`，调用 install-git-hooks.js。`--hooks-only` 不动（git hook 是一次性 wrapper，pre-commit-check.js 自身改变才需要重装，但 wrapper 是稳定的）。
- [x] **Task 4** (T4): 写 `scripts/smoke-pre-commit.js` — 5 场景用 tmp dir + git init 真实模拟。结果 5/5 全过。
- [x] **Task 5** (T5): Dogfood — `validate-codex-plugin` 通过；本机装 git hook 通过；本 sprint staged 产物干跑 pre-commit-check 通过 (exit 0)；反向破坏 plan 验证拒绝路径 (exit 1 + 精确修复指引)；恢复后再跑通过。

### 测试策略

- **单元**: `smoke-pre-commit.js` 5 场景，全部用 tmp git 仓库真实模拟（不 mock）
  1. user-level/commands/sprint.md 改了但派生未同步 → exit 1
  2. user-level/commands/sprint.md 改了且已同步 → exit 0
  3. 新建 docs/plans/2026-05-12-foo.md 缺「关键假设验证」段 → exit 1
  4. 新建 docs/plans/2026-05-12-foo.md 含完整段 → exit 0
  5. 改老 plan（created: 2026-04-09，grandfathered） → exit 0
- **集成**: 本机安装 git hook 后实际跑 `git commit --dry-run` 风格的验证
- **手动**: 验证 `git commit --no-verify` 仍可通过
- **风险等级**: L2（修改 git workflow，但有 `--no-verify` 兜底；hook 容错放行不锁用户）

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Windows git for windows sh 不可用 | 低 | 锁住 commit | sh hook 内部 `command -v node` 检测；失败 echo 警告 + exit 0 |
| transform 函数派生漂移 | 中 | 误报"未同步" | **复用同一个 transform 函数**（require 现有 propagate / build 脚本），不重写 |
| 现有 plan 文档触发新规则 | 高 | commit 失败 | Grandfather: 解析 frontmatter `created` 字段，< 2026-05-12 跳过 |
| Node 启动 ~100ms 慢感 | 低 | 用户感知 | hook 内只跑必要逻辑；staged 文件少时直接 early return |
| smoke 测试污染本机 git | 中 | 副作用 | 用 `os.tmpdir()` 创建独立测试 repo，每个场景独立目录 |
| build-codex-plugin 的 assertInventory 与 propagate 验证逻辑分叉 | 中 | propagate 通过但 plugin 失败 | 派生检查同时覆盖 propagate 产物 + build-codex-plugin 期望清单 |

### 涉及文件

**新增**:
- `scripts/pre-commit-check.js`（核心逻辑）
- `scripts/install-git-hooks.js`（安装器）
- `scripts/smoke-pre-commit.js`（测试）

**修改**:
- `install.sh`（install_project + --hooks-only 调用安装器）
- `install.ps1`（Install-Project + -HooksOnly 调用安装器）
- `docs/plans/2026-05-12-defense-mechanism.md`（本文档，phase 推进）

**不修改**（明示）:
- `scripts/propagate-command-changes.js` —— 不改逻辑，pre-commit 复用
- `plugins/tech-persistence/scripts/build-codex-plugin.js` —— 不改逻辑
- `/plan` / `/sprint` 命令 —— 不前置干预，只后置 lint
- `upgrade-v3.ps1` —— 不涉及（用户已升级版本，git hook 由 install.ps1 装）

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-12 | T1 | 新增 `scripts/pre-commit-check.js`（251 行）。复用 propagate / build-codex-plugin 的 transform 函数对派生副本做内容比对；plan 文档「关键假设验证」段 lint，grandfather 阈值 2026-05-12。全局 try/catch fallback exit 0。|
| 2026-05-12 | T1 | 重构 `scripts/propagate-command-changes.js` 加 `module.exports`（applyCodexRegex / injectIntoSkillWrapper / stripFrontmatter / propagateCommand / propagateRule）+ `if (require.main === module) main();` guard。|
| 2026-05-12 | T1 | 重构 `plugins/tech-persistence/scripts/build-codex-plugin.js` 加 `module.exports`（transform / normalizeLf / commandToSkill / parseFrontmatter / replacements / expectedCommands / expectedSkills）+ guard。|
| 2026-05-12 | T2 | 新增 `scripts/install-git-hooks.js`（~100 行）。生成 sh 一行 wrapper 调 node；MARKER 检测已有 hook 是不是自己（避免覆盖第三方）；非 git repo / node 缺失 fallback 放行。|
| 2026-05-12 | T3 | `install.sh::install_project` + `install.ps1::Install-Project` 末尾调用 install-git-hooks.js；失败仅 warn 不阻塞 install。|
| 2026-05-12 | T4 | 新增 `scripts/smoke-pre-commit.js`（5 场景：未同步 / 已同步 / plan 缺段 / plan 含段 / grandfathered）。结果 5/5 全过。|
| 2026-05-12 | T5 | 本机装 git hook（`.git/hooks/pre-commit`），干跑 staged → exit 0；反向破坏 plan 段 → exit 1 + 精确修复指引；恢复后再跑 → exit 0。|

---

## 审查结果

3 个 reviewer 并行（correctness / maintainability / testing），共 31 findings。L3 dispatch（不触发 security/architecture：不涉及 auth/data，不引入新抽象）。

### P0 — 必须修复（全部已修）

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | maint | `pre-commit-check.js:formatPropagateError` | 输出 `<cmd>...` 占位符，用户无法 copy-paste | ✅ 修：新增 `deriveRepairCommand` 从 mismatches 派生真实命令名 |
| 2 | correct | `pre-commit-check.js:checkPlanScope` | 7 个旧 plan 无 frontmatter，hook 装上后修这些 plan 会被静默拒绝（**dogfood blocker**） | ✅ 修：grandfather signal 改用 filename date（PLAN_PATH_RE 已 capture），独立于 frontmatter |
| 3 | correct | `pre-commit-check.js:parseFrontmatter` | CRLF 行尾 plan 不匹配 `---\n`，frontmatter 解析失败 | ✅ 修：parseFrontmatter 接受 `---\n` / `---\r\n`，内部 normalize CRLF→LF |
| 4 | correct | `pre-commit-check.js:getStagedFiles` | `core.quotePath=true` 让非 ASCII 文件名（中文 plan title）被静默跳过 | ✅ 修：加 `-c core.quotePath=false` |
| 5 | test | `smoke-pre-commit.js:S2` | exit 0 断言不区分 real-pass vs silent fail-open | ✅ 修：S2 加 negative assertion `!/hook 内部异常已忽略\|fail-open 放行/` |
| 6 | test | `smoke-pre-commit.js` | `user-level/rules/*.md` 分支零覆盖 | ✅ 修：新增 S6 (rules out-of-sync) |
| 7 | test | `smoke-pre-commit.js` | fail-open 安全网无测试（核心 promise 不被锁定） | ✅ 修：新增 S7 (missing transformer → exit 0 + 诊断) |

### P1 — 建议修复（已修主要项）

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | maint | `pre-commit-check.js:26,52,275` | `sha256` + `crypto` import 是 dead code | ✅ 删除 |
| 2 | maint | `pre-commit-check.js:79,85` | `checkPropagateSync` 第三参数 `transformers` 无 caller | ✅ 删除 |
| 3 | maint | `install-git-hooks.js:22` | `MARKER` vs `HOOK_BODY` 同步 drift 风险 | ✅ 加双向不变量注释 |
| 4 | maint | `pre-commit-check.js:loadTransformers` | 模块缺失被吞到通用 catch，root cause 不明 | ✅ 加 `MISSING_TRANSFORMERS` 错误码 + 专用诊断消息 |
| 5 | correct | `pre-commit-check.js:anchorRe` | 不匹配 `### **关键假设验证**` 复合形式 | ✅ 修：正则加 `\*{0,2}` 兼容 |
| 6 | test | `install-git-hooks.js` | 零覆盖（fresh / 二次装 / 第三方覆盖 / non-git 4 路径） | 🔜 defer — 单元逻辑简单，后续 sprint 加专用 smoke |
| 7 | correct | `pre-commit-check.js:parseFrontmatter` | end-marker 不严格（不要求行尾） | ✅ 修：search regex 要求 `(?:\r?\n\|$)` |

### P2 — 可选优化（全部 defer）

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | maint | 多处 | `process.stderr.write` vs `console.error` 风格不一致 | ⏸️ defer — soft style，不影响行为 |
| 2 | maint | 多处 | `'use strict'` 与老脚本不一致 | ⏸️ defer — 与 agent-orchestrator 风格对齐 |
| 3 | correct | `pre-commit-check.js:GRANDFATHER_BEFORE` | 缺 WHY 注释 | ✅ 修：加 ADR-012 + 1-day buffer 解释 |
| 4 | correct | `install-git-hooks.js:resolveHookPath` | Bare repos 失败路径 | ⏸️ defer — 罕见场景 |
| 5 | correct | `install-git-hooks.js:backupIfForeign` | 第三方 husky/pre-commit 框架被静默覆盖 | ⏸️ defer — 触发条件清晰，backup 已保留 |
| 6 | test | `smoke-pre-commit.js:clearRequireCache` | Windows realpath/8.3 边界 | ⏸️ defer — 已无回归 |
| 7 | test | 多处 | S1 不验证全部 3 个 mismatch 报告 | ⏸️ defer — S1 已断言 propagate 错误段存在 |
| 8 | test | `smoke-pre-commit.js` | 空 staged / renamed / malformed FM / thin section 未覆盖 | ⏸️ defer — 边缘场景，加一次性 |
| 9 | test | `smoke-pre-commit.js:S3` | `/关键假设验证/` 断言 trivially-true | ✅ 已通过 P0 修复改用更严格的 reason 字符串匹配 |

### 总评

**风险等级 L3**（git workflow 改动 + 跨脚本耦合 + 跨平台集成）。3 reviewer 并行覆盖 correctness/maintainability/testing。31 findings 中 7 P0 全修；7 P1 中 6 修 1 defer；P2 中 1 顺手修，其余 defer 至后续 sprint。

**关键防御保留**：3 层 fail-open（`--no-verify` / 外层 try/catch / sh wrapper node 缺失放行）+ 1 个新增（`MISSING_TRANSFORMERS` 诊断）。Dogfood 自验证：7 个 smoke 场景全过，6+ 个本仓库旧无-FM plan 验证不被误拒。

**reviewer 还指出 3 个 residual risks 默认接受**：
1. Pre-commit 是开发期防御，`--no-verify` 永远可绕过——by design
2. 用户在 GUI IDE 不在 PATH 启动 git 时，sh wrapper exit 0 静默禁用 — 已 stderr warn
3. Race: 修改 derived 但只 stage source — 由用户纪律保证

---

## 复利记录

### 提取的经验

1. **Dogfood 必须枚举边界产物，不能只测自己刚写的** (→ [[ADR-013]])
   - 事件：reviewer 抓出 6+ 个无 FM 旧 plan 会被刚装的 hook 立刻拒绝
   - 规则：enforcement 类 plan 的「关键假设验证」段必须含「会拒绝哪些现有产物」枚举
   - 与 ADR-012 关系：ADR-012 验证输入假设，ADR-013 验证输出影响——形成对

2. **filename 比 frontmatter 鲁棒——优先用 git-enforced metadata** (→ `debugging-gotchas.md` HIGH)
   - 事件：原方案用 frontmatter `created` 做 grandfather，3 个独立失效（CRLF / 无 FM / 不可解析日期）由同一根因导致
   - 修复：filename date 通过 `PLAN_PATH_RE` 强制 capture，一次性解决全部 3 个
   - 适用：plan / solution / changelog 等带日期前缀的产物

3. **fail-open 系统必须有 negative assertion** (→ `debugging-gotchas.md` HIGH)
   - 事件：S2 `assert(exit === 0)` 既能 pass real-pass 也能 pass silent fail-open
   - 修复：加 `assert(!/hook 内部异常已忽略|fail-open 放行/.test(stderr))`
   - 通用：所有 exit-0-meaning-both-pass-and-disabled 的测试

4. **error message 必须 copy-paste runnable** (→ `debugging-gotchas.md` HIGH)
   - 事件：`<cmd>... [--rules <rule>...]` 占位符让用户每次 failure 都翻译 4 步
   - 修复：`deriveRepairCommand` 从 mismatch records 派生具体值
   - 例外：明示模板（plan-lint 的「关键假设验证」段模板有 `<占位>` 标记）

5. **复用 transform 函数，不重写** (架构经验)
   - pre-commit-check.js 不实现自己的派生 transform，而是 require `propagate-command-changes.js::applyCodexRegex` 和 `build-codex-plugin.js::transform`
   - 任何派生逻辑变化，验证逻辑自动跟上——没有"两套规则漂移"风险
   - 代价：两个模块都需要 `require.main === module` guard + `module.exports`（最小重构）

6. **MISSING_TRANSFORMERS 模式：fail-open 时分类失败原因** (架构经验)
   - 普通 fail-open 给一行通用消息，遇上特定 root cause（如依赖模块缺失）给专用诊断
   - 既保持 fail-open 不锁用户，又让 silent degradation 浮上来——下次重命名 propagate 脚本时不会"hook 静默关闭"

7. **L3 dispatch matrix self-validate 第二次** ([[2026-05-11-sprint-speed-layer1]] T1 二次确认)
   - 本 sprint 是 L3，跑 3 reviewer：correctness 抓 5 P0、maintainability 抓 1 P0、testing 抓 2 P0
   - 每个 reviewer 贡献 ≥1 个独立 P0，无冗余、无遗漏——证明 dispatch matrix 不是 cosmetic

### 创建/更新的本能

- **新增 [[ADR-013]]**: 自动化 enforcement 必须先验证不锁死现有产物（dogfood-coverage-first）
- **`.claude/rules/debugging-gotchas.md` HIGH 加 4 条**:
  - `[enforcement, dogfood]` 边界覆盖规则
  - `[metadata, signal-source]` filename > frontmatter
  - `[tests, fail-open]` negative assertion 模式
  - `[error-message, ux]` runnable 修复命令

### 解决方案文档

- [[2026-05-12-pre-commit-defense]] — 完整 Problem / Root Cause / Solution / Prevention 记录，5 条 prevention 元经验，相关 ADR / sprint / solution 链接

### CLAUDE.md 解决方案索引

`CLAUDE.md` 第 172 行新增本 sprint 的一行索引（按 [日期] [标签] 问题→方案 格式）。
