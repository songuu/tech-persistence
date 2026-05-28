---
title: "A2 grader-revise 收敛闭环：review 层 rubric-gated 有限 revise loop（N=2 硬限 + L3+/--auto 门控）"
date: 2026-05-28
tags: [solution, coding-flow, review, grader, revise-loop]
related_instincts:
  - documented-claim-vs-code-reality-drift
related_solutions:
  - "[[2026-05-28-a1-clarify-enhancement]]"
  - "[[2026-05-28-clarification-channel]]"
  - "[[2026-05-28-two-layer-architecture-enhancement]]"
aliases: ["A2 grader-revise", "rubric-gated revise loop"]
status: completed
---

# A2 grader-revise 收敛闭环

## Problem

`docs/plans/2026-05-28-two-layer-architecture-enhancement.md` §A2（编码流层，review 层）：review 是**单遍**——reviewer 出 P0/P1/P2 报告即结束，没有「质量未达标 → 自动回 work 修 → 重审」的收敛回路。已有的 `NEEDS_CONTEXT` retry 只针对 context 不足，不针对质量分数。对标 Claude Agent SDK Outcomes（rubric + 独立 grader 打回重做）。

## Root Cause

勘察（[[ADR-012]]）证设计现状描述**准确**（A1 后第二次无 doc drift——本会话 B1/B2/B3/A3 均推翻假设，A1+A2 是仅有的两个描述准确的）：`review.md` 确实已有 4 status 契约（L34-48）、NEEDS_CONTEXT retry ≤1（L94-99）、BLOCKED escalation（L101-106）、Gap Detection Walkthrough（L128-149）。缺口是 review 单遍、无 rubric fail 后的有限 revise loop——不是缺能力，是缺收敛回路。

## Solution

纯文档协议增强（叠加在 review.md 现有 spawn 契约上，零脚本零依赖，4 task）：

1. **review.md 新增「Rubric-gated revise loop（收敛闭环，可选）」段**（插在 BLOCKED escalation 后，与 NEEDS_CONTEXT/BLOCKED 两个 bounded-loop 协议归组）：
   - 触发门控：L3/L4 或 `--auto`；L0-L2 且非 auto 保持单遍（轻量 + token 成本）。
   - 结构化 rubric：reviewer 在 P0/P1/P2 外按视角关键项给 pass/fail（关键项 fail 等价该视角产 P0）。
   - 收敛回路：P0>0 或 rubric 关键项 fail → 触发一次 work 微循环修复 → **仅重 spawn 受影响视角**（不重审全套）→ 收敛进 compound，否则回修。
   - **轮数硬限 N=2**（类比 NEEDS_CONTEXT retry ≤1）：第 2 轮仍未收敛 → 停止、标遗留 P0/P1、进 compound。
   - 人工 gate 不可被吞：非 auto P0 仍人工确认；BLOCKED 走既有 escalation；destructive/L4 P0 即使 auto 仍人工。
   - Multi-runtime：spawn-capable 重 spawn 子集 / inline-fallback 串行扮演，门控与硬限相同。
2. **「审查后流程」段衔接**：L3+/--auto 走 revise loop，L0-L2 单遍。
3. **双 runtime 同步**：propagate review + build + validate + pre-commit；revise loop 用 runtime-neutral idiom（spawn-capable / inline-fallback），grep codex 副本确认无 `Claude`→`Codex` 撞车。
4. **文档同步**：设计文档 A2 标 implemented + 补 B2/A3 漏标的 ✅ + changelog（status → implemented，6 增强全落地）；本 solution + index。

验证：纯文档无测试脚本——validate-codex-plugin pass（review.md 4 副本同步）+ pre-commit exit 0。

## Key Insight

**确定性收敛靠轮数硬限而非靠"判断够不够好"**：revise loop 防死循环不靠模型估算"还要不要再修一轮"，而靠 N=2 硬限——与既有 NEEDS_CONTEXT retry ≤1 完全同模式。这是把 [[ADR-013]] mechanism-over-discipline 的确定性思路用在协议层（不是 enforcement 脚本，而是协议里写死的数值边界）。

A2 价值高但被设计排在 ROI #6（token 成本 + 复杂度最高），实际落地却是纯文档 L1 改动——因为**复杂度在功能运行时（重 spawn 成本、死循环风险），不在改动本身**。运行时复杂度由 N=2 硬限 + L3+/--auto 门控 + 仅重 spawn 受影响视角三重缓解，全部是协议层可表达的约束，无需新组件。这印证设计原则 2（复用现有 spawn + status 契约，零新子系统）。

## Prevention

- 有限自动回路（retry / revise / clarification ruling）必须配确定性轮数硬限（类比 NEEDS_CONTEXT ≤1 / revise N=2），不靠模型判断终止条件。
- 自动迭代回路的人工 gate 边界（非-auto P0 / BLOCKED / destructive）必须显式声明"不被 loop 吞掉"，否则 --auto 会吃掉本应人工的 gate。
- 重审优化（仅重 spawn 受影响视角而非全套）是 token 成本的关键杠杆——自动回路设计必须问"能不能只重跑受影响子集"。

## Related
- [[2026-05-28-two-layer-architecture-enhancement]] — A2 设计来源（6 增强最后 1 个）
- [[ADR-012]] — plan 必须勘察（A2 验证设计描述准确）
- [[ADR-009]] — --auto 决策矩阵（revise loop 自动迭代边界）
- [[2026-05-28-a1-clarify-enhancement]] — A1（同期编码流层）
- [[2026-05-28-clarification-channel]] — A3（同期 agent-loop 层有限回路）
