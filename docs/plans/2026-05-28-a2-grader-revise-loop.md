---
title: "A2 grader-revise 收敛闭环：review 层 rubric-gated 有限 revise loop"
type: sprint
status: completed
created: "2026-05-28"
updated: "2026-05-28"
checkpoints: 0
tasks_total: 4
tasks_completed: 4
tags: [sprint, coding-flow, review, grader, revise-loop]
aliases: ["A2 grader-revise", "rubric-gated revise loop"]

# === Anti-Drift 扩展字段 ===
invariants:
  - "review.md 4 副本 sha256 一致（源 + codex propagate + plugin build，LF-normalize 后比对）"
  - "revise loop 轮数硬限 N=2（类比 NEEDS_CONTEXT ≤1），收敛或达上限才进 compound——确定性边界不可去"
  - "revise loop 仅 L3+ 或 --auto 触发；L0-L2 保持单遍 review（轻量原则，token 成本门控）"
  - "非 --auto 模式 P0 仍人工 gate；BLOCKED 永远人工（不被 revise loop 吞掉）"
invariant_tests:
  - "node scripts/pre-commit-check.js"
  - "node scripts/validate-codex-plugin.js"
deferred: []
deadcode_until: []
---

# A2 grader-revise 收敛闭环

> **来源**：[[2026-05-28-two-layer-architecture-enhancement]] §A2（编码流层，review 层，设计 ROI #6）。
> **现状勘察**（[[ADR-012]]）：`review.md` 已有 4 status 契约（L34-48）+ NEEDS_CONTEXT retry ≤1（L94-99）+ BLOCKED 人工 gate（L101-106）+ Gap Detection Walkthrough（L128-149）。设计描述准确（A1 后第二次无 doc drift）。缺口是 review 单遍、无 rubric fail → revise → 重审收敛回路。

---

## Phase 1: 需求分析（Think）

### Scope
- review.md 叠加**可选 rubric-gated revise loop**：reviewer findings 扩展为结构化 `pass/fail-per-criterion`；P0>0（或 rubric 关键项 fail）→ 自动触发一次 work 微循环修复 → **仅重 spawn 受影响视角** reviewer。
- revise 轮数**硬限 N=2**（类比 NEEDS_CONTEXT ≤1，防死循环），收敛或达上限才进 compound。
- 触发门控：仅 L3+ 或 `--auto`；L0-L2 单遍。非 `--auto` 时 P0 仍人工 gate，revise loop 仅 `--auto` 自动迭代。

### Non-scope
- 不改 review 5 视角定义 / Dispatch Matrix / 模型分层（既有不动）。
- 不引入独立 grader 命令（内联进 review，复用现有 status 契约）。
- 不改 work.md（work 微循环 = 按既有 work 约定重跑修复，review loop 仅编排，不改 executor）。
- 不改 sprint.md 状态机（Phase 4 既有「P0 自动修复」语义兼容；revise loop 在 review 内部，sprint 调 /review 自动获得）。
- L0-L2 不引入 revise loop（轻量 + token 成本）。

### Success（EARS-lite）
- WHEN review 在 L3+ 或 `--auto` 下命中 P0（或 rubric 关键项 fail），THE SYSTEM SHALL 自动触发一次 work 微循环修复后仅重 spawn 受影响视角 reviewer，而非全套重审。
- WHEN revise loop 已迭代 2 轮仍未收敛，THE SYSTEM SHALL 停止迭代、标记未收敛 finding 并进入 compound（不无限循环）。
- WHEN review 运行在 L0-L2 且非 `--auto`，THE SYSTEM SHALL 保持单遍 review 不触发 revise loop。
- WHEN 任一 reviewer 报 BLOCKED，THE SYSTEM SHALL 强制人工 gate（即使 `--auto`），不被 revise loop 自动吞掉。
- WHEN 非 `--auto` 模式命中 P0，THE SYSTEM SHALL 仍向用户呈现 P0 并等待确认（revise loop 仅在 `--auto` 自动迭代）。

### Risks
- revise loop × 重 spawn = token 成本上升 → L3+/`--auto` 门控 + N=2 硬限缓解。
- 死循环 → 轮数硬限 N=2（确定性边界，与 NEEDS_CONTEXT ≤1 同模式）。
- review.md 4 副本同步 → propagate + build + validate + pre-commit 固化序列（[[debugging-gotchas]] propagate-needs-build-step）。
- codex regex 撞车（runtime label）→ A2 不引入 runtime-specific 标签；revise loop 描述用 runtime-neutral idiom，propagate 后 grep codex 副本验证。

---

## Phase 2: 技术方案（Plan）

### 关键假设验证（[[ADR-012]]）

| 假设 | 验证文件 | 实际 | 可信度 |
|------|---------|------|--------|
| review.md 已有 4 status 契约可叠加 | Read review.md:34-48 | 确认：DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED + 兜底规则 | 已勘察 |
| 已有有限 retry 硬限模式可类比 | Read review.md:94-99 | 确认：NEEDS_CONTEXT retry ≤1，第 2 次降级 P1 防死循环 | 已勘察 |
| BLOCKED 已是强制人工 gate（revise loop 不能吞） | Read review.md:101-106 | 确认：即使 --auto 也人工 escalation | 已勘察 |
| review 是单遍、无 rubric revise 回路（缺口真实） | Read review.md 全文 | 确认：审查后流程 L405-409「P0 立即修复」无重审循环 | 已勘察 |
| sprint Phase 4 既有 P0 自动修复语义兼容 | sprint skill Phase 4 段 | 确认：「P0 自动修复 → P1 确认 → go」；revise loop 是其结构化细化，不冲突 | 已勘察 |
| EARS-lite 在本项目可用 | A1 落地（本会话） | dogfood：think.md 已升级 EARS-lite | 已验证 |

### 入场扫描 - Invariants 继承

| 子系统 | 既有 invariant | 本 sprint 如何保持 |
|--------|---------------|--------------------|
| 多副本同步 | git tracked 派生靠 propagate + build | review.md 改源后跑固化序列 |
| codex regex | 跨 runtime 标签用 neutral idiom | A2 不引入 runtime-specific 标签 |
| review status 契约 | 4 status + 兜底 DONE_WITH_CONCERNS | revise loop 复用现有 status，不新增状态值 |
| 有限 retry 硬限 | NEEDS_CONTEXT ≤1 | revise loop N=2 同模式（确定性防死循环）|

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| rubric-gated revise loop | `/review`（L3+/--auto）| review.md 新增 revise loop 段 | ✅ sprint 文档 review 段记录轮次 | ✅ compound 读 |
| 结构化 pass/fail-per-criterion | reviewer 输出 | review.md 输出格式扩展 | ✅ review 报告 | ✅ |

无 ❌ 链路（纯协议，无新 API/state）。

### 入场扫描 - 债务清单
来自 [[2026-05-28-two-layer-architecture-enhancement]]：A2 是设计文档 6 增强最后 1 个；做完 A1/B1/B2/B3/A3/A2 全部落地，无剩余 deferred。

### 任务拆解

| Task | 等级 | 内容 | 验证 |
|------|------|------|------|
| T1 | L1 | review.md 新增「Rubric-gated revise loop」段：结构化 pass/fail-per-criterion + P0>0 触发 work 微循环 + 仅重 spawn 受影响视角 + N=2 硬限 + L3+/--auto 门控 + 非-auto P0 人工 gate + BLOCKED 不被吞 | grep 含 revise loop / N=2 |
| T2 | L1 | review.md「审查后流程」段衔接 revise loop（单遍 → 收敛回路）；runtime-neutral idiom（spawn-capable / inline-fallback）；inline-fallback runtime 串行 fallback 描述 | grep 含门控条件 |
| T3 | L2 | 双 runtime 同步：propagate review + build + validate + pre-commit；grep codex 副本无 runtime label 撞车 | validate pass + 4 副本 sha match |
| T4 | L1 | 文档同步：设计文档 A2 标 implemented + 变更日志（**并补 B2/A3 漏标的 ✅ + changelog**）；solution + sync index | pre-commit exit 0 |

### 验证策略
- 纯文档无测试脚本：验证靠 propagate sync（pre-commit checkPropagateSync sha256）+ validate-codex-plugin。
- T3 后 grep `.codex/commands/review.md` 确认无 runtime label 撞车（revise loop 不含 `Claude`/`Claude Code` 字样或用 neutral idiom）。

---

## Phase 3: 实现记录（Work）

| Task | 状态 | 产物 | 验证 |
|------|------|------|------|
| T1 | ✅ | review.md 新增「Rubric-gated revise loop（收敛闭环，可选）」段（插在 BLOCKED escalation 后，loop 协议归组）：结构化 rubric pass/fail + P0>0 触发 work 微循环 + 仅重 spawn 受影响视角 + N=2 硬限 + L3+/--auto 门控 + 人工 gate 不被吞 + Multi-runtime 行为 + 派遣记录扩展 | grep 含 Rubric-gated revise loop / 轮数硬限 N=2 |
| T2 | ✅ | review.md「审查后流程」段加门控引导（L3+/--auto 走 revise loop，L0-L2 单遍）；全段 runtime-neutral idiom | grep 含门控条件 |
| T3 | ✅ | propagate review + build（22 commands / 32 skills）+ validate pass；grep codex 副本含 revise loop（L108/135/145-146/455）且新增内容无 runtime label 撞车（L328 Codex 是既有行 regex 替换，非本次新增）| validate pass，4 副本同步，pre-commit exit 0 |
| T4 | ✅ | 设计文档 A2 标 implemented + 补 B2/A3 漏标 ✅ + changelog（status → implemented，6 增强全落地）；solution + sync index（34 docs）| pre-commit exit 0 |

## Phase 4: 审查结果（Review）

风险等级：L1（纯文档命令协议增强，无代码路径 / 无 enforcement / 无 state / 无安全面）。按 Dispatch Matrix L1 单 reviewer，inline 自审。

**P0**：无。

**P1**：无。A2 是 review.md 协议增强，复用现有 4 status 契约 + spawn 协议，不新增脚本、状态值、持久化或安全面；revise loop 的确定性边界（N=2）与既有 NEEDS_CONTEXT ≤1 同模式。

**第 6 视角（集成连续性）**：
1. 未破坏 invariant——review.md 4 副本经 validate sha 一致；revise loop 复用既有 status 契约不新增状态值；N=2 硬限承接 NEEDS_CONTEXT ≤1 确定性模式；L3+/--auto 门控承接 Dispatch Matrix 轻量思路。
2. 无 dead code——review 是既有命令，revise loop 是协议段非新 export；门控/重审/收敛链路读取既有 status 与 risk 等级。
3. 集成闭环——revise loop 嵌在 review 内部，sprint Phase 4 调 /review 自动获得（sprint.md 状态机「P0 自动修复」语义兼容，无需改 sprint）。work.md 不动（loop 仅编排修复→重审串接，executor 不变）。
4. 人工 gate 边界显式声明不被 loop 吞掉（非-auto P0 / BLOCKED / destructive/L4），与 auto-mode.md 强制人工边界一致。

## Phase 5: 复利记录（Compound）

- **新 ADR**：无。A2 遵循现有 propagate+build 多副本同步 + 既有 review status 契约，未引入新架构决策（区别于 A3/B2 各产 1 ADR——它们涉及新 lib + 新数据格式 + 跨模式集成判断）。revise loop 的 N=2 确定性边界是既有 NEEDS_CONTEXT ≤1 模式的复用，非新决策。
- **新 solution**：[[2026-05-28-a2-grader-revise-loop]]。
- **候选本能**：无新增。A2 强化 [[documented-claim-vs-code-reality-drift]]（本会话第 6 次勘察，A1+A2 是仅有的两个描述准确的——但准确性只能 Read 后确认，不能省略勘察，[[ADR-012]] ROI 恒定）。
- **里程碑**：设计文档 [[2026-05-28-two-layer-architecture-enhancement]] 6 增强（A1/A2/A3/B1/B2/B3）**全部落地**，status → implemented。编码流层 3 个（A1 think-clarify / A2 revise-loop / A3 clarification-channel）+ 自进化层 3 个（B1 trace 反思 / B2 trace→eval / B3 baseline guard）全闭环。
- **EARS-lite dogfood**：A2 Success 段沿用 `WHEN…THE SYSTEM SHALL…`，本会话第 5 个用该格式的 sprint 文档。

## Related
- [[2026-05-28-two-layer-architecture-enhancement]] — A2 设计来源（最后 1 个增强）
- [[ADR-012]] — plan 必须勘察（A2 验证设计描述准确）
- [[ADR-009]] — --auto 决策矩阵（revise loop 自动迭代边界）
- [[2026-05-28-a1-clarify-enhancement]] — A1（同期编码流层，EARS-lite dogfood 来源）

## Related
- [[2026-05-28-two-layer-architecture-enhancement]] — A2 设计来源（最后 1 个增强）
- [[ADR-012]] — plan 必须勘察（A2 验证设计描述准确）
- [[ADR-009]] — --auto 决策矩阵（revise loop 自动迭代边界）
- [[2026-05-28-a1-clarify-enhancement]] — A1（同期编码流层，EARS-lite dogfood 来源）

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-05-28 | 初版 plan：review 层 rubric-gated 有限 revise loop（N=2 硬限 + L3+/--auto 门控），纯文档零依赖。status: planning |
| 2026-05-28 | 实施完成：review.md 新增 revise loop 段 + 审查后流程衔接；4 副本同步（validate pass）；设计文档 A2 标 implemented + 补 B2/A3 漏标 + status→implemented（6 增强全落地）；solution + index（34 docs）。status: completed |
