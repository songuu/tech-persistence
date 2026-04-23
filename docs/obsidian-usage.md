# Obsidian 知识管理使用指南

> 安装完成后，日常如何使用 Obsidian 浏览和管理 tech-persistence 产出的知识。

## 核心概念

tech-persistence 的知识产出分为 5 种类型，每种在 Obsidian 中有对应的 tag 和存储位置：

| 类型 | Tag | 存储路径 | 产生方式 |
|------|-----|----------|---------|
| 本能 | `#instinct` | `instincts/personal/` 或 `projects/<id>/instincts/` | Hook 自动 + `/compound` |
| 会话摘要 | `#session` | `projects/<id>/sessions/` | Stop Hook 自动 |
| 解决方案 | `#solution` | `docs/solutions/` (项目级) | `/compound` 手动 |
| 规则 | `#rule` | `.claude/rules/` 或 `.codex/rules/` (项目级) | `/compound` `/learn` |
| 架构决策 | `#architecture` | `.claude/rules/architecture.md` 或 `.codex/rules/architecture.md` | `/compound` |

---

## 日常工作流

### 1. 正常开发（无需额外操作）

```
正常使用 Claude Code 或 Codex
  ↓
Hook 自动观察 → observations.jsonl
  ↓
Stop Hook 生成会话摘要 (带 #session tag)
  ↓ 
会话摘要自动出现在 Obsidian 中
```

你不需要做任何事情。每次 Claude Code 或 Codex 会话结束，知识自动流入 Obsidian。共享模式下，两边会写入同一个 homunculus vault。

### 2. /compound 后查看新知识

```bash
# Claude Code 中执行
/compound

# Codex 中执行
$compound
```

`/compound` 会产出：
- 本能文件（`instincts/*.md`）→ Obsidian 中 `#instinct` 节点
- 解决方案（`docs/solutions/*.md`）→ Obsidian 中 `#solution` 节点
- 规则更新（`.claude/rules/*.md` 或 `.codex/rules/*.md`）→ 项目级知识

切换到 Obsidian，刷新即可看到新节点。

### 3. 用 Graph View 发现关联

打开 Obsidian 的 **Graph View**（快捷键 `Ctrl/Cmd + G`）：

- **紫色节点**（`#instinct`）= 你的行为本能
- **绿色节点**（`#session`）= 会话历史
- **深绿节点**（`#solution`）= 解决方案
- **橙色节点**（`#rule`）= 规则
- **红色节点**（`#architecture`）= 架构决策

节点之间的连线 = `[[wikilinks]]`，表示知识间的关联。例如：
- 一个 session 链接到它产生的 instincts
- 一个 solution 链接到相关的 instincts

### 4. 用 Dashboard 快速导航

打开 `Dashboard.md`，它提供：

- **Quick Links** — 跳转到全部本能、会话历史
- **Knowledge Areas** — 按 tag 分类浏览
- **Recent** — 最近更新的本能（需要 Dataview 插件）
- **High Confidence** — 高置信度本能列表

---

## Frontmatter 格式规范

所有知识文件使用 YAML frontmatter + Obsidian wikilinks：

### 本能文件

```yaml
---
id: "error-resolution-m1abc"
trigger: "Windows bash 语法不兼容"
confidence: 0.50
domain: "debugging"
type: "error_resolution"
source: "session-observation"
created: "2026-04-08"
last_seen: "2026-04-08"
scope: "project"
tags: [instinct, debugging]
aliases: ["Windows bash 语法不兼容"]
---

# Windows bash 语法不兼容

## Action
Windows 上 Claude Code hooks 使用 bash 执行，必须用 Unix 语法

## Evidence
- 2026-04-08: install.ps1 生成的 settings.json 使用了 CMD 语法导致死循环

## Related
- [[session-2026-04-08]] — 发现此问题的会话
```

**关键规则**：
- `tags` 和 `aliases` 使用**内联数组**格式（`[a, b]`），不用 block 序列
- 末尾保留 `## Related` 区域用于 wikilinks
- `confidence` 是数值，不加引号

### 会话摘要

```yaml
---
date: "2026-04-08"
time: "20:51"
project: "tech-persistence"
type: session-summary
observations: 42
patterns: 3
tags: [session, "tech-persistence"]
---

# Session 2026-04-08 20:51

## Stats
- Observations: 42
- Top tools: Edit(12), Read(8), Bash(6)
- Patterns detected: 3
- Instincts: +2 new, 1 updated

## Instinct Links
[[error-resolution-m1abc]], [[repeated-workflow-m2def]]
```

### 解决方案

```yaml
---
title: "Hook bash 兼容性修复"
date: 2026-04-08
tags:
  - solution
  - debugging
related_instincts: [error-resolution-m1abc]
aliases:
  - "bash 兼容性"
---

# Hook bash 兼容性修复

## Problem
...

## Root Cause
...

## Solution
...

## Prevention
...

## Related
- [[error-resolution-m1abc]] — 关联的行为本能
```

---

## 搜索和查询

### 基本搜索

在 Obsidian 中 `Ctrl/Cmd + Shift + F` 全文搜索。

### Dataview 查询示例

在任何笔记中添加 dataview 代码块：

**列出所有高置信本能：**
````
```dataview
TABLE confidence, domain, trigger, last_seen
FROM #instinct
WHERE number(confidence) >= 0.7
SORT confidence DESC
```
````

**按域分组统计：**
````
```dataview
TABLE length(rows) AS count
FROM #instinct
GROUP BY domain
SORT length(rows) DESC
```
````

**近 7 天的会话：**
````
```dataview
TABLE observations, patterns, time
FROM #session
WHERE date >= date(today) - dur(7 days)
SORT date DESC
```
````

**特定项目的本能：**
````
```dataview
LIST trigger
FROM #instinct AND "projects/a1b2c3d4e5f6"
SORT confidence DESC
```
````

---

## 知识维护

### 手动编辑本能

你可以在 Obsidian 中直接编辑本能文件：
- 修改 `confidence` 值（手动提升/降低）
- 添加 `## Related` 链接
- 补充 `## Evidence` 内容

系统会在下次读取时使用你的修改。

### 添加自定义笔记

在 `_inbox/` 中创建新笔记，使用 `_templates/` 中的模板：
1. `Ctrl/Cmd + N` 新建笔记
2. 使用 Templater 插入模板
3. 填写内容
4. 移动到合适的目录

### 定期维护

| 频率 | 操作 | 目的 |
|------|------|------|
| 每周 | Graph View 浏览 | 发现孤立节点、缺失关联 |
| 每月 | `/retrospective` + Graph View | 清理衰减本能、确认进化候选 |
| 每季 | `/evolve` + 手动整理 | 将本能聚类为 skills |

---

## MCP Server 使用（高级）

配置 MCPVault 后，Claude Code 或 Codex 可以直接操作 Vault：

```
Agent 中：
> 搜索我的 vault 中关于 debugging 的本能
> 创建一个新的解决方案笔记
> 列出所有高置信度本能
```

MCPVault 提供 14 个 MCP 工具：
- 文件列表和搜索（BM25 排序）
- 读取和创建笔记
- Frontmatter 管理
- Tag 查询

---

## 数据流总览

```
Claude Code / Codex 会话
  ├─ Hook 自动 → observations.jsonl (Obsidian 忽略)
  ├─ Stop Hook → sessions/*.md (#session)
  ├─ /compound  → instincts/*.md (#instinct)
  │              → docs/solutions/*.md (#solution)
  │              → .claude/rules/*.md 或 .codex/rules/*.md (#rule)
  └─ /evolve    → evolved/skills/*.md
                 → evolved/rules/*.md

所有 .md 文件 → Obsidian Vault → Graph View 可视化
                               → Dataview 查询
                               → 全文搜索
```

---

## Sprint 交接工作流

### 自动 Checkpoint

Stop Hook 在每次会话结束时自动检测活跃 Sprint：
- 如果 `docs/plans/` 中有 `status: in-progress` 的 Sprint 文档
- 自动生成 `*-handoff-N.md` 交接文件
- 文件包含：Task 进度、修改文件列表、观察统计
- 下次 SessionStart 自动检测并注入 handoff 状态

### 手动 Checkpoint

```
/checkpoint               ← 保存详细状态（含关键决策）
/sprint resume            ← Claude Code 从最新 handoff 恢复
$sprint resume            ← Codex 从最新 handoff 恢复
```

### Graph View 中的 Sprint 链路

```
Sprint 文档 (青色 #sprint)
  ├── Handoff #1 (金色 #handoff) ← 自动生成
  ├── Handoff #2 (金色 #handoff)
  ├── Solution A (深绿 #solution)
  └── Instinct X (紫色 #instinct)
```

### Sprint 相关 Dataview 查询

**活跃 Sprint：**
````
```dataview
TABLE status, tasks_done + "/" + tasks_total AS progress
FROM #sprint
WHERE status != "completed"
```
````

**Sprint 的 Checkpoint 历史：**
````
```dataview
TABLE checkpoint_number, phase, created
FROM #handoff
WHERE sprint_doc = "docs/plans/YOUR-SPRINT.md"
SORT checkpoint_number ASC
```
````

## 完整知识类型映射

| 类型 | Tag | Graph 颜色 | 产生方式 |
|------|-----|-----------|---------|
| 本能 | `#instinct` | 紫色 | Hook + /compound |
| 会话 | `#session` | 绿色 | Stop Hook |
| 解决方案 | `#solution` | 深绿 | /compound |
| 规则 | `#rule` | 橙色 | /compound /learn |
| 架构决策 | `#architecture` | 红色 | /compound |
| Sprint | `#sprint` | 青色 | /sprint |
| 交接点 | `#handoff` | 金色 | Stop Hook 自动 + /checkpoint |
