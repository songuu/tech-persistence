---
description: "复利步骤：提取经验→写入本能+rules+解决方案+skill信号，所有产出 Obsidian 兼容"
---

# /compound — 复利循环（核心步骤）

融合 Compound Engineering + 本能系统 + Skill 信号 + Obsidian 知识图谱。
**每次有意义的工作结束后都应执行。**

## 执行流程

### 步骤 1: 扫描会话，提取 7 类知识
| 类型 | 写入位置 |
|------|---------|
| 解决方案 | `docs/solutions/` + CLAUDE.md 索引 |
| 踩坑记录 | `.claude/rules/debugging-gotchas.md` |
| 架构决策 | `.claude/rules/architecture.md` |
| 行为本能 | `~/.claude/homunculus/instincts/` |
| 模式发现 | `.claude/rules/` 对应文件 |
| 性能数据 | `.claude/rules/performance.md` |
| 测试模式 | `.claude/rules/testing-patterns.md` |

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

在 CLAUDE.md 解决方案索引追加一行。

### 步骤 3: 提取经验到 rules
项目特有 → `.claude/rules/`，跨项目 → `~/.claude/CLAUDE.md`

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
