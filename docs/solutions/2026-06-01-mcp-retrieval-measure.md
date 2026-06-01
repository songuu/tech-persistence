---
title: "MCP 主动检索 measure（缺陷 B）：demand-side telemetry 的主动检索轴"
date: "2026-06-01"
tags: [solution, telemetry, demand-side, mcp, self-evolution, measure-before-enforce]
related:
  - "[[2026-06-01-mcp-retrieval-measure]]"
  - "[[2026-06-01-secondary-defects-roadmap]]"
  - "[[2026-06-01-demand-side-recall-telemetry]]"
  - "[[ADR-022]]"
  - "[[documented-claim-vs-code-reality-drift]]"
---

# MCP 主动检索 measure（缺陷 B）

## 问题

缺陷 A（[[ADR-022]]）测「注入知识被用率」（被动注入侧——SessionStart/prompt-recall 塞进来的 domain 有没有被碰）。但 agent 还能**主动**调 MCP memory 工具（`tp_memory_search` 等）拉知识——这条「主动检索」通道此前**零信号**。缺陷 B（[[2026-06-01-secondary-defects-roadmap]] P2）补这一轴。

B 的根因与 A 同源：主动检索靠模型自愿调用（model-driven，无进程级强制）。故 B **只 measure 不 enforce**（measure-before-enforce；硬推「让 agent 主动检索」会 dead-on-arrival，[[feedback_enforcement_dead_on_arrival_82pct]]）。

## 根因 / 洞察

**[[ADR-012]] 二次勘察推翻 roadmap 初稿 filter（核心，drift 活样本）**：roadmap task 骨架原写「`tool` 匹配 `mcp__*memory*`」。但 `scripts/lib/memory-v5.js` 的 `normalizeToolName` 对工具名做 `.replace(/^mcp__/, '')`——**`mcp__` 前缀被剥**。MCP 调用 `mcp__tech-persistence-memory__tp_memory_search` 进 `observations.jsonl` 后记录为 `tech-persistence-memory__tp_memory_search`。

→ `mcp__*` 匹配 **0 条**，B 会静默测到「永远 0」（fail-open 到假信号）。这正是 [[documented-claim-vs-code-reality-drift]]（本仓库 #1 回归源）的活例，落在 roadmap 自己的 task 骨架上。

**修正**：按工具名后缀 `/tp_memory_/` 匹配（不依赖被剥的 `mcp__` 前缀，也不依赖 server 名）。`scripts/observe.js` 的 matcher `*` 确实捕获 MCP 调用，`tp_memory_` 子串 normalize 后存活 → 修正后可行。

## 解决方案

复用 A 的 recall-usage 管道，**零新 jsonl、零新 hook**：

- `scripts/lib/recall-usage.js`：
  - `RETRIEVAL_TOOL_RE = /tp_memory_(?:search|recent|file_history|project_profile)/`——只数**读取类**，排除 `tp_memory_save`（写入非检索）
  - `countActiveRetrievals(observations)`：数 `phase === 'post'` 且命中 RE 的条数。**只数 post**：`observe.js` 每次调用写 pre+post 两条，数 post 避免翻倍
  - `buildRecallUsageMetric` 加 `active_retrieval_count` 字段（写进 `recall-usage.jsonl`）
- 3 个消费点（数据已在 metric，皆字符串拼接）：
  - `user-level/commands/review-learnings.md` `--recall`：MCP 主动检索汇总维度 + 样例（主审计）
  - `scripts/inject-context.js` SessionStart cost summary：append `active-retrieval=N`（高频可见）
  - `scripts/evaluate-session.js` Stop console：append `主动检索: N`

## 关键决策

- **filter 用 `tp_memory_` 后缀，绝不 `mcp__*`**：`normalizeToolName` 剥前缀，`mcp__*` 必然 0 命中。测试含「剥前缀名命中」用例固化。
- **只数 post phase**：pre+post 是同一调用的两条 observation，数 post = 完成调用数，不翻倍。
- **排除 save**：检索 = 读取（search/recent/file_history/project_profile）；save 是写入（模型贡献记忆），不同信号。
- **预期偏低是 finding 非 bug**：被动注入是主路径，主动检索罕见甚至持续 0——这本身回答了「agent 到底主动检索了没」。文档明示别当故障修。
- **无新 ADR**：纯复用 A 设施，[[ADR-022]] 的 demand-side telemetry 架构已覆盖；B 是其主动检索轴的延伸。

## 预防 / 复用

- **从 observations 按工具名 filter 前，先确认 `normalizeToolName` 的变换**（剥 `mcp__`/`functions.` 前缀 + slice 80）——别用客户端原始工具名匹配。见 [[debugging-gotchas]] HIGH。
- 新增 demand-side 信号优先复用 `buildRecallUsageMetric` + `recall-usage.jsonl`，不新建管道（[[reuse-existing-infra-before-building-new]]）。

## 关联

- Plan: [[2026-06-01-mcp-retrieval-measure]] ｜ Roadmap: [[2026-06-01-secondary-defects-roadmap]]（B done；C 降级——C2 撞 [[ADR-021]] 天花板）
- A 设施: [[2026-06-01-demand-side-recall-telemetry]]、[[ADR-022]]
