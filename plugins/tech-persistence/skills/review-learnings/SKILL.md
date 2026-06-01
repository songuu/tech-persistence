---
name: review-learnings
description: Codex-compatible entry point for the former /review-learnings command. 回顾所有技术沉淀：经验 + 本能 + 观察，支持搜索、统计、裁剪
---

# Review Learnings

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/review-learnings` command.

## Invocation

Use `$review-learnings <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/review-learnings`, interpret that as this `$review-learnings` skill invocation while running in Codex.

## Command Instructions

# /review-learnings — 全量知识回顾

回顾、搜索和管理所有层次的知识积累。

## 数据来源（按层次）

| 层次 | 位置 | 内容 |
|------|------|------|
| 核心知识 | `AGENTS.md` | 项目/个人核心信息 |
| 分类经验 | `.codex/rules/*.md` | 按领域分类的成熟经验 |
| 项目本能 | `~/.codex/homunculus/projects/{id}/instincts/` | 项目级学习的行为 |
| 全局本能 | `~/.codex/homunculus/instincts/personal/` | 跨项目通用行为 |
| 进化产物 | `~/.codex/homunculus/evolved/` | 聚类生成的 skill/command |
| 原始观察 | `~/.codex/homunculus/projects/{id}/observations.jsonl` | 未处理的原始数据 |
| 会话摘要 | `~/.codex/homunculus/projects/{id}/sessions/` | 历史会话总结 |
| 召回信号 | `~/.codex/homunculus/telemetry/recall-usage.jsonl` | demand-side 使用率 + 沉睡 domain + MCP 主动检索（measure-only） |

## 操作模式

**无参数 — 总览**：
```
📊 知识库统计 — 项目: {name}

经验层:
  AGENTS.md: N 行 | rules/: N 个文件, N 条经验

本能层:
  项目本能: N 个 (🔵N 🟢N 🟡N 🟠N 🔴N)
  全局本能: N 个
  导入本能: N 个

进化层:
  Skills: N | Commands: N | Agents: N

观察层:
  本月观察: N 条 | 会话摘要: N 份

最近更新: YYYY-MM-DD
```

**`search {keyword}` — 搜索**：
跨所有层次搜索匹配关键词的内容。

**`prune` — 裁剪**：
1. 检测重复（rules 和 instincts 之间）
2. 检测矛盾
3. 检测过时（涉及已废弃依赖）
4. 检测衰减本能（置信度 < 0.2）
5. 列出建议删除项，等待确认

**`export` — 导出**：
合并所有沉淀为一份结构化文档。

**`timeline` — 时间线**：
按时间倒序展示知识积累过程。

**`--usage` — 21 命令使用率**：
显示 21 个 tech-persistence 命令在 Codex transcript（`~/.codex/projects/<slug>/*.jsonl`）+ Codex observations（`tool:"Skill"`）中的**精准**使用次数，区分 30 天滚动窗口和累计。

实现：执行 `node scripts/usage-report.js --inline`（或 `--window 60` 自定义窗口），把输出直接展示给用户。完整归档报告用 `node scripts/usage-report.js` 写入 `docs/reports/command-usage-YYYY-MM-DD.md`。

数据局限（必读）：
- transcript 仅覆盖当前 cwd 对应的 session；subagent 内调用不计
- 仅捕获**用户显式输入 `/xxx`**；对话式触发（"实现 X"）不计
- Codex observations 同秒同 skill 已去重

**`--recall` — demand-side 召回使用率审计**：
读 `~/.codex/homunculus/telemetry/recall-usage.jsonl`（每次会话结束由 Stop hook 追加一条），汇总「注入的知识 domain 实际被碰到了多少」——这是供给侧 `MEMORY.md` 索引覆盖率之外，唯一的需求侧信号。

实现：读取最近 30 条记录，按以下维度汇总：
- **平均使用率**：`usage_rate` 均值（注入的 domain 中本会话实际触及的比例）
- **长期沉睡 domain**：在多数会话出现于 `dormant_domains` 的 domain（注入了但持续没被碰到）
- **趋势**：使用率是否随时间下降
- **MCP 主动检索**：`active_retrieval_count` 总和 + 每会话均值（模型主动调 `tp_memory_*` 读取类工具的次数）。A（使用率）测被动注入被用率，本项测**主动检索发生率**。**预期偏低**——被动注入是主路径；持续为 0 = 主动检索基本未发生（本身是 finding，非 bug，别当故障修）。measure-only。

```
🎯 demand-side 召回审计（最近 30 会话）
  平均使用率: 62%
  长期沉睡: security (28/30 会话), api-design (25/30)
  MCP 主动检索: 总 4 次 / 0.13 次每会话（被动注入为主，主动检索罕见——符合预期）
  → 建议: 这些域的本能注入了但极少被碰到，考虑裁剪该域低置信本能，
    或确认这些知识是否仍需每次自动注入
```

定位（必读）：这是**粗粒度退化探测**，非精确度量。`dormant` 基于命令/文件的启发式 domain 推断（宽松匹配，宁可多算碰到、少误报沉睡），**不衡量「模型是否语义遵守了本能」**（该信号 hook 测不到）。仅 measure，不触发任何自动裁剪——所有删除仍走 `prune` 人工确认。

## 健康检查（每次自动执行）
- ⚠️ AGENTS.md > 200 行
- ⚠️ 单个 rules 文件 > 100 行
- ⚠️ 本能 > 50 个未聚类
- ⚠️ 观察日志 > 5MB 未归档
- ⚠️ 30+ 天未更新的 rules 文件
- ⚠️ 衰减本能 > 10 个未清理
- ⚠️ 某 domain 在最近 10+ 会话持续 dormant（注入未被碰到，用 `--recall` 详查）

