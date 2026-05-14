---
name: compound
description: Codex-compatible entry point for the former /compound command. 复利步骤：提取经验→写入本能+rules+解决方案+skill信号，所有产出 Obsidian 兼容
---

# Compound

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/compound` command.

## Invocation

Use `$compound <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/compound`, interpret that as this `$compound` skill invocation while running in Codex.

## Command Instructions

# /compound — 复利循环（核心步骤）

融合 Compound Engineering + 本能系统 + Skill 信号 + Obsidian 知识图谱。
**每次有意义的工作结束后都应执行。**

## 执行流程

### 步骤 1: 扫描会话，提取 7 类知识
| 类型 | 写入位置 |
|------|---------|
| 解决方案 | `docs/solutions/` + AGENTS.md 索引 |
| 踩坑记录 | `.codex/rules/debugging-gotchas.md` |
| 架构决策 | `.codex/rules/architecture.md` |
| 行为本能 | `~/.codex/homunculus/instincts/` |
| 模式发现 | `.codex/rules/` 对应文件 |
| 性能数据 | `.codex/rules/performance.md` |
| 测试模式 | `.codex/rules/testing-patterns.md` |

### 步骤 2: 生成解决方案文档（Obsidian 兼容）

文件：`docs/solutions/{YYYY-MM-DD}-{slug}.md`

**必须包含 Obsidian frontmatter + wikilinks：**

```yaml
---
title: "[问题简述]"
date: YYYY-MM-DD
tags: [solution, 领域tag]
related_instincts: [instinct-id-1]
aliases: ["问题的别名"]
---
```

```markdown
# [问题简述]

## Problem
[1-2 句]

## Root Cause
[为什么]

## Solution
[怎么解决，含代码]

## Prevention
[如何避免]

## Related
- [[instinct-id]] — 关联本能
- [[session-YYYY-MM-DD]] — 发现此问题的会话
```

在 AGENTS.md 解决方案索引追加一行。

### 步骤 2.5: AGENTS.md 索引段尺寸维护

写完新索引行后，检查 `### 解决方案索引` 段是否 > 5 条：

```bash
node scripts/archive-claude-solutions-index.js  # idempotent；≤5 条时 noop
```

效果：
- 老条目（超出最近 5 条）移到 `docs/archives/CLAUDE-solutions-index-<YYYY-MM-DD>.md`
- AGENTS.md 始终保留**最近 5 条** + archive pointer
- always-on 注入恒定，不再线性增长（设计参考 `docs/plans/2026-05-14-claude-md-index-via-prompt-recall.md`）
- 老条目仍可被 **prompt recall hook**（UserPromptSubmit）按用户当轮 prompt 召回（数据源是 `docs/solutions/*.md`，不依赖 AGENTS.md 索引）

报告中加一行 `Archive: <N> 条 → docs/archives/CLAUDE-solutions-index-*.md`（若 noop 则 `Archive: noop`）。

### 步骤 3: 提取经验到 rules
项目特有 → `.codex/rules/`，跨项目 → `~/.codex/AGENTS.md`

### 步骤 4: 创建/更新本能（Obsidian 兼容）

本能文件必须用 Obsidian 标准格式：

```yaml
---
id: "error-resolution-xxxx"
trigger: "简短描述"
confidence: 0.50
domain: "debugging"
type: "error_resolution"
created: "YYYY-MM-DD"
last_seen: "YYYY-MM-DD"
tags: [instinct, 域tag]
aliases: ["触发描述"]
---
```

末尾保留 `## Related` 用于 wikilinks。

### 步骤 5: 整合 /review 中的 `[🧠 新发现]`

### 步骤 6: 采集 Skill 使用信号
检查本次使用了哪些 skill，记录到 `skill-signals/{name}.jsonl`。
放弃率 > 30% 或纠正 3+ 次 → 提示 `/skill-diagnose`。

### 步骤 7: 本能与 skill 差异标记
新本能标记 `pending_absorption`，累积 5+ 个 → 提示 `/skill-improve`。

### 步骤 8: Sprint 交接检查
如果当前在 sprint 中且检测到上下文压力 → 建议 `/checkpoint`。

### 步骤 9: 输出报告

```
🔄 Compound 复利报告

📄 解决方案: N 个 → docs/solutions/ (Obsidian #solution)
📝 经验: rules/ +N 条
🧠 本能: 🆕 N 个 | ⬆️ N 个 (Obsidian #instinct)
📊 Skill 信号: N 个 skill
⚡ Sprint: [进度/checkpoint 状态]

💡 所有产出已写入 Obsidian 兼容格式
   打开 Obsidian Graph View 查看新增节点和关联
```

### 步骤 9.5: Skill 健康摘要

> **本段由 /compound 的 LLM 执行者在产出报告前手动派生**（读取 `skill-signals/*.jsonl` + 应用阈值），非自动 hook。Stage A 仅负责数据写入，本步骤是消费端。

读 `~/.codex/homunculus/skill-signals/*.jsonl`（Stage A hook 派生），按累计调用数 + 阈值输出健康度：

```
🎯 Skill 健康摘要

| Skill   | 累计 | 末次   | 健康度        |
|---------|-----|-------|--------------|
| sprint  | 18  | 05-13 | 🟢 healthy    |
| work    | 6   | 05-10 | 🟢 healthy    |
| evolve  | 22  | 04-22 | 🔴 recommend  |

🔴 1 个 skill 累计调用 ≥ 20 — 建议跑 /skill diagnose evolve
💡 详细诊断: /skill diagnose <name>
```

阈值（`~/.codex/homunculus/config.json` 可配置，未配置时取默认）：
- 🟢 healthy: 累计 ≥ 5
- 🟡 observe: 累计 < 5
- 🔴 recommend: 累计 ≥ 20

**信号为空时**（首次 compound 或无 Codex Skill 调用）：

```
🎯 Skill 健康摘要
  暂无信号（skill-signals/ 为空或仅含 0 调用）
  💡 Stage A hook 仅采集 Codex 端 tool:"Skill"；Codex SlashCommand 不在统计内
```

**实现指引**（不绑死 API 签名）：读 `scripts/lib/skill-signals` 模块派生健康度摘要数据；阈值优先从 `~/.codex/homunculus/config.json` 的 `skill_evolution_thresholds` 读，未配置时取默认 `{ healthy: 5, recommend_diagnose: 20 }`。

## Phase 间预热钩子

完整 sprint 内执行时（`/sprint` 调用），本命令报告末尾**必须**追加「收尾预热」段（无下一 phase，但有清场动作）。协议见当前命令集合中 `sprint.md` 的「Phase 间预热协议」。

本命令的典型预热内容：

```text
## 收尾预热（无下一 Phase）
关键文件: sprint 文档 frontmatter
执行命令: 确认 status: completed、检查是否需 /compact
风险预判: 上下文压力、未处理的 P2 backlog、未关闭的 follow-up
```

单独使用本命令（不在 sprint 内）时，预热段建议但非必须。

