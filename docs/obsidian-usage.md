# Obsidian 知识管理使用指南

> 安装完成后，日常如何使用 Obsidian 浏览和管理 tech-persistence 产出的知识。

## 核心概念

tech-persistence 的知识产出分两层：**vault 图谱节点**（写入 homunculus vault，带 tag + 配色，在 Graph View / Dashboard 可见）和 **repo 注入层**（写入 git repo 的 `.claude/rules/`，供运行时注入，不进 vault graph）。

### vault 图谱节点（6 类，Graph View + Dashboard 可见）

| 类型 | Tag | Graph 颜色 | 存储路径 | 产生方式 |
|------|-----|-----------|----------|---------|
| 本能 | `#instinct` | 紫色 | `instincts/personal/` 或 `projects/<id>/instincts/` | Hook 自动 + `/compound` |
| Memory | `#memory` | 蓝色 | `projects/<id>/memory/{topic}.md`、`MEMORY.md` | Stop Hook 自动 |
| 会话摘要 | `#session` | 绿色 | `projects/<id>/sessions/` | Stop Hook 自动 |
| 解决方案 | `#solution` | 深绿 | `projects/<id>/solutions/`（由 repo `docs/solutions/` 投影） | `/compound` + solution sync |
| Sprint | `#sprint` | 青色 | `docs/plans/` (项目级) | `/sprint` |
| 交接点 | `#handoff` | 金色 | `docs/plans/.handoff/` | Stop Hook 自动 + `/checkpoint` |

### repo 注入层（不进 vault graph）

| 类型 | 存储路径 | 产生方式 | 为何不进 vault |
|------|----------|---------|---------------|
| 规则 | `.claude/rules/` 或 `.codex/rules/` | `/compound` `/learn` | 文件在 git repo / 运行时注入目录，不在 homunculus vault；无 frontmatter |
| 架构决策 (ADR) | `.claude/rules/architecture.md` | `/compound` | 同上；高价值 ADR 知识通过 Memory topic + solution 在 vault 间接可见 |

> **历史勘误**：早期文档/配置曾给 `#rule`(橙)/`#architecture`(红) 配色并声称接入 Graph，但这两类文件物理上不在 vault，配色永不命中（空转）。2026-06-01 起诚实化为「repo 注入层」，graph 配色仅覆盖上方 6 类真正写入 vault 的产出。详见 `docs/plans/2026-06-01-obsidian-integration-completeness.md`。

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

你不需要做任何事情来同步 session / memory / instinct。每次 Claude Code 或 Codex 会话结束，这三类知识会自动流入 Obsidian。共享模式下，两边会写入同一个 homunculus vault。repo 里的 `docs/solutions/*.md` 仍是 canonical source，需要通过 `node scripts/sync-solution-index.js --all --obsidian-vault shared` 或重跑 `node scripts/init-obsidian-vault.js --shared` 刷新 vault 投影。

### 2. /compound 后查看新知识

```bash
# Claude Code 中执行
/compound

# Codex 中执行
$compound
```

`/compound` 会产出：
- 本能文件（`instincts/*.md`）→ Obsidian 中 `#instinct` 节点
- 解决方案 canonical（`docs/solutions/*.md`）→ 通过 solution sync 投影到 `projects/<id>/solutions/*.md`，再出现在 Obsidian `#solution` 节点
- 规则更新（`.claude/rules/*.md` 或 `.codex/rules/*.md`）→ repo 注入层（不进 vault graph）

切换到 Obsidian 前，若这次新增了 solution，先跑一次 `node scripts/sync-solution-index.js --all --obsidian-vault shared`（或重跑 `node scripts/init-obsidian-vault.js --shared`）；其余自动产物直接刷新即可看到。

### 3. 用 Graph View 发现关联

打开 Obsidian 的 **Graph View**（快捷键 `Ctrl/Cmd + G`）：

- **紫色节点**（`#instinct`）= 你的行为本能
- **蓝色节点**（`#memory`）= Memory v5 主题记忆
- **绿色节点**（`#session`）= 会话历史
- **深绿节点**（`#solution`）= 解决方案
- **青色节点**（`#sprint`）= Sprint 文档
- **金色节点**（`#handoff`）= Sprint 交接点

> 规则（`.claude/rules/`）与架构决策是 repo 注入层，不在 vault graph 中。

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
  ├─ Hook 自动 → observations.jsonl (jsonl，Obsidian 忽略)
  ├─ Stop Hook → sessions/*.md (#session)
  │            → projects/<id>/memory/{topic}.md, MEMORY.md (#memory)
  ├─ /compound  → instincts/*.md (#instinct)
  │              → docs/solutions/*.md (canonical source)
  │              → sync-solution-index --obsidian-vault → projects/<id>/solutions/*.md (#solution)
  │              → .claude/rules/*.md 或 .codex/rules/*.md (repo 注入层，不进 vault graph)
  └─ /evolve    → evolved/skills/*.md
                 → evolved/rules/*.md

vault 内 .md 文件 → Obsidian Graph View / Dataview / 全文搜索
```

### 为什么看不到原始数据（.jsonl）

`.obsidianignore` 排除所有 `*.jsonl`，因为它们是**机器格式的原始采集层**，不适合人工浏览：

| 文件 | 用途 |
|------|------|
| `projects/<id>/observations.jsonl` | Tier 0 工具调用观察 |
| `skill-signals/*.jsonl` | Skill 使用信号 |
| `skill-evals/<name>/results.jsonl`、`cases.jsonl` | Skill 评测结果/用例 |
| `telemetry/recall-usage.jsonl`、`memory-recall.jsonl` | 召回 telemetry |

你看到的所有 Markdown 节点都是 Hook/命令从这些 jsonl 派生出来的高价值产物。需要查原始数据时直接用编辑器打开 jsonl，不经 Obsidian。

### Persona（用户画像）

`projects/<id>/memory/persona.md`（ADR-015 引入的 5 字段画像）由 `/compound` 维护。若希望它在 Graph View / Dashboard 可见，frontmatter 加 `tags: [persona]` 即可（Dashboard Quick Links 已含 `[[persona]]` 跳转）。persona 是单文件低频信号，默认无专属配色。

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

### vault 图谱节点（带 Graph 配色 + Dashboard 查询，三方一致）

| 类型 | Tag | Graph 颜色 | 产生方式 |
|------|-----|-----------|---------|
| 本能 | `#instinct` | 紫色 | Hook + /compound |
| Memory | `#memory` | 蓝色 | Stop Hook |
| 会话 | `#session` | 绿色 | Stop Hook |
| 解决方案 | `#solution` | 深绿 | /compound |
| Sprint | `#sprint` | 青色 | /sprint |
| 交接点 | `#handoff` | 金色 | Stop Hook 自动 + /checkpoint |

### repo 注入层（不进 vault graph）

| 类型 | 路径 | 产生方式 |
|------|------|---------|
| 规则 | `.claude/rules/`、`.codex/rules/` | /compound /learn |
| 架构决策 | `.claude/rules/architecture.md` | /compound |
