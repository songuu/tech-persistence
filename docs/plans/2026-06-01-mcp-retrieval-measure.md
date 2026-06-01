---
title: "缺陷 B：MCP 主动检索 measure"
type: plan
status: completed
created: "2026-06-01"
updated: "2026-06-01"
tags: [plan, telemetry, demand-side, mcp, self-evolution, agentic]
parent: "docs/plans/2026-06-01-secondary-defects-roadmap.md"
related:
  - "[[2026-06-01-secondary-defects-roadmap]]"
  - "[[2026-06-01-demand-side-recall-telemetry]]"
  - "[[ADR-022]]"
risk: L2
---

# 缺陷 B：MCP 主动检索 measure

> 承接 [[2026-06-01-secondary-defects-roadmap]] 缺陷 B（P2）。A（[[ADR-022]]）测「注入知识被用率」（被动注入侧）；B 补「主动检索发生率」（模型主动调 MCP memory 读取工具）。同一 telemetry 家族，复用 recall-usage 管道，零新 jsonl。**纯 measure，无 enforcement**（measure-before-enforce，[[ADR-022]] / [[feedback_unproven_protocol_rollback_before_enforcement]]）。

## 目标

- ✅ 在现有 demand-side metric（`recall-usage.jsonl`）加 `active_retrieval_count` 字段：本会话模型主动调 `tp_memory_*` 读取类工具的完成次数。
- ✅ 贯通已有 3 个消费点（review-learnings `--recall` 主审计 + SessionStart cost summary + Stop console）。
- ❌ 不强推「让 agent 主动检索」（撞缺陷 A 自愿根因，硬接 enforcement 会 dead-on-arrival，[[feedback_enforcement_dead_on_arrival_82pct]]）。
- ❌ 零新 jsonl、零新 hook。

## 关键假设验证（[[ADR-012]]）

| 假设 | 勘察 | 现实 |
|------|------|------|
| filter 匹配 `mcp__*memory*` | `scripts/lib/memory-v5.js:180` `normalizeToolName` `.replace(/^mcp__/,'')` | **`mcp__` 被剥**！记录值 `tech-persistence-memory__tp_memory_search` → 必须匹配 `/tp_memory_/`（二次勘察发现 ①） |
| MCP 调用进 observations | `scripts/observe.js:16` matcher `*` + `tool: normalized.tool` | ✅ 捕获；`tp_memory_` 子串 normalize 后存活 |
| MCP 工具命名 | `scripts/lib/memory-tools.js:213` 起 | `tp_memory_search/recent/save/file_history/project_profile`；检索=读取 4 个，排除 `save`（写） |
| pre+post 是否翻倍 | `scripts/observe.js:59` 每调用写 pre+post 两条 | 只数 `phase==='post'` 避免翻倍 |
| 复用 metric 还是新字段 | `scripts/evaluate-session.js:891` 已传 `observations` 给 `buildRecallUsageMetric` | 加字段即贯通写入；零新管道 |

## 方案

1. **`scripts/lib/recall-usage.js`**（hook lib，build 自动同步 plugin 副本）：
   - `RETRIEVAL_TOOL_RE = /tp_memory_(?:search|recent|file_history|project_profile)/`（不匹配 `mcp__*`，排除 save）
   - `countActiveRetrievals(observations)`：数 `phase==='post'` 且 tool 命中 RE 的条数
   - `buildRecallUsageMetric` 加 `active_retrieval_count`
2. **消费点**（数据已在 metric，三处皆字符串拼接）：
   - `user-level/commands/review-learnings.md` `--recall`：加「MCP 主动检索」汇总维度 + 样例行（**主审计**）
   - `scripts/inject-context.js` SessionStart `demandSideLine`：append `active-retrieval=N`（高频可见）
   - `scripts/evaluate-session.js` Stop console：append `主动检索: N`
3. **测试**：`test-recall-usage.js` 加 countActiveRetrievals 用例（post-only / 排除 save / 排除非 memory / 剥前缀名命中 / 空）+ buildRecallUsageMetric 含字段。
4. **parity**：recall-usage.js / inject / evaluate 经 build 同步 plugin；review-learnings 经 propagate 同步 .codex + plugin。

## Task list

- [x] **Task 1**: recall-usage.js 加 `countActiveRetrievals` + `active_retrieval_count` + export — 风险: L2
- [x] **Task 2**: test-recall-usage.js 加用例（TDD：先断言计数语义）— 风险: L2
- [x] **Task 3 [P]**: inject-context.js + evaluate-session.js 两处 cost summary append — 风险: L1
- [x] **Task 4 [P]**: review-learnings.md `--recall` 加维度 + 样例 — 风险: L1
- [x] **Task 5**: propagate review-learnings + build + validate + 全测 + pre-commit（依赖 T1-4）— 风险: L2
- [x] **Task 6**: 文档沉淀（solution + roadmap B→done；ADR 视情况——纯复用 A 设施，可能无需新 ADR）— 风险: L1

## 成功标准

- [x] `active_retrieval_count` 写入 recall-usage.jsonl；`tp_memory_search` 类调用被计数，`tp_memory_save` / 非 memory 工具不计
- [x] pre/post 不翻倍（同一调用计 1）
- [x] `--recall` 报告含「MCP 主动检索次数」；SessionStart/Stop cost summary 含 active-retrieval（>0 时）
- [x] 复用现有管道，零新 jsonl；recall-usage.js plugin 副本 sha 一致
- [x] 全测绿（test-recall-usage + run-tests）+ pre-commit exit 0

## 测试策略

L2（计数逻辑有边界：phase 去重 / save 排除 / 剥前缀名匹配）。TDD：先在 test-recall-usage.js 写计数断言，再实现。纯函数 countActiveRetrievals 单测充分；消费点是字符串拼接，靠 pre-commit + validate 覆盖。

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| filter 写成 `mcp__*` 测到永远 0 | 高（若不勘察） | B 静默失效（假信号） | 勘察已定位，用 `/tp_memory_/`；测试含「剥前缀名命中」用例 |
| pre+post 翻倍计数 | 中 | 次数虚高 2× | 只数 phase==='post'；测试含 pre+post 同调用计 1 |
| 信号长期为 0 被误读为 bug | 中 | 误判 | 文档明示「预期偏低，持续 0 本身是 finding」 |

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-06-01 | 创建 + 实施。active_retrieval_count 加入 demand-side metric，复用 recall-usage 管道。 |
