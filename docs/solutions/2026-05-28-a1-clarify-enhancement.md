---
title: "A1 clarify 阶段强化：think 验收升级 EARS-lite + 可选 --clarify 子步"
date: 2026-05-28
tags: [solution, coding-flow, clarify, think, ears]
related_instincts:
  - documented-claim-vs-code-reality-drift
related_solutions:
  - "[[2026-05-28-skill-trace-aware-reflection]]"
  - "[[2026-05-28-skill-publish-baseline-guard]]"
  - "[[2026-05-28-two-layer-architecture-enhancement]]"
aliases: ["A1 clarify 强化", "think-clarify-enhancement"]
status: completed
---

# A1 clarify 阶段强化

## Problem

`docs/plans/2026-05-28-two-layer-architecture-enhancement.md` §A1（编码流层，think 层）：think 的需求澄清轻量被动（"答案不明显才问"，不主动系统扫描欠定义点），验收条件非结构化，欠定义会拖到 plan 阶段才暴露（[[ADR-012]] 同类 plan-error 教训）。

## Root Cause

勘察（[[ADR-012]]）证设计现状描述**准确**（罕见——本会话 B1/B3 均推翻假设，A1 是 3 个里唯一无 doc drift 的）：`think.md` 步骤 1「需求澄清」+ 步骤 3「3-5 可验证验收条件」确实存在但都是自然语言、被动触发。缺口是结构化 + 主动扫描，不是缺能力。

## Solution

4 task（纯文档零依赖）：

1. **EARS-lite 验收升级**（`think.md` 步骤 3）：L3+ 任务强制 `WHEN <触发> THE SYSTEM SHALL <可观测行为>`（保留中文仅借结构），L0-L2 可选不强制（避免小任务过重）。
2. **可选 `--clarify` 子步**（`think.md` 新增执行步骤 1.5）：`--clarify` 触发或 L3+ 建议时，主动系统化扫描三维欠定义点（输入边界 / 失败模式 / 空状态），逐条列出要求确认。对标 spec-kit `/clarify` 但内联进 think，不新增独立命令。用法 + 可选参数段同步加 `--clarify`（与 `--auto` 可组合）。
3. **双 runtime 同步**：propagate think + build-codex-plugin + validate + pre-commit；grep codex 副本确认无 runtime label 撞车（A1 内容无 `Claude`/`Claude Code` 字样，propagate 原样保留）。
4. **文档同步**：设计文档 A1 标 implemented + 变更日志、本 solution + index。

验证：纯文档无测试脚本——validate-codex-plugin pass（think.md 4 副本同步）+ pre-commit exit 0（staged 5 个 think 副本，checkPropagateSync sha256 一致）。

## Key Insight

**设计文档现状描述的准确性是逐项勘察验证出来的，不是默认的**。本会话连续 3 个增强（B3/B2/B1）勘察均推翻设计假设，A1 是唯一描述准确的——但这只能在 Read 之后确认，不能省略勘察。[[ADR-012]] 的 ROI 不因"上一次假设错"或"这一次假设对"而改变：勘察成本恒定低，跳过的代价（work 阶段返工）恒定高。

EARS-lite 选型经 dogfood 验证：本会话 B1/B3/A1 三个 sprint 文档的 Success 段都已用 `WHEN…THE SYSTEM SHALL…`，格式在中文语境可用且不臃肿。

## Prevention

- 验收条件结构化（EARS-lite）把"系统应正确处理"这类不可证伪表述挡在 think 阶段，而非拖到 plan/work 才发现欠定义。
- `--clarify` 主动扫描限定 L3+ / 显式触发，L0-L2 跳过——结构化能力的施加范围必须与任务风险匹配，避免轻量原则被侵蚀。

## Related
- [[2026-05-28-two-layer-architecture-enhancement]] — A1 设计来源
- [[ADR-012]] — plan 必须勘察（A1 验证设计描述准确）
- [[2026-05-28-skill-trace-aware-reflection]] — B1（同期，EARS-lite dogfood 来源）
