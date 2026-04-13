---
description: "复利步骤：提取本次所有经验→写入本能+rules+解决方案索引，让下次更容易"
---

# /compound — 复利循环（核心步骤）

这是整个系统最重要的步骤。它融合了：

- **Compound Engineering** 的 "compound step"（记录解决方案供未来复用）
- **本能系统** 的自动学习（置信度评分、去重、进化）
- **/learn** 的经验提取（写入 rules 文件）

**每次有意义的工作结束后都应执行此命令。**

## 执行流程

### 第一步：全面扫描会话

回顾本次会话中的**所有**内容，识别以下 6 类知识：

| 类型       | 描述                   | 写入位置                            |
|------------|------------------------|-------------------------------------|
| **解决方案** | 解决了一个具体问题       | `docs/solutions/` + CLAUDE.md 索引   |
| **踩坑记录** | 遇到的坑和非直觉行为     | `.claude/rules/debugging-gotchas.md` |
| **架构决策** | 做出的设计选择           | `.claude/rules/architecture.md`      |
| **行为本能** | 被纠正的习惯或发现的偏好  | `~/.claude/homunculus/instincts/`    |
| **模式发现** | 可复用的工作流或代码模式  | `.claude/rules/` 对应文件            |
| **性能数据** | 有实测数据的优化发现      | `.claude/rules/performance.md`       |

### 第二步：生成解决方案文档（Compound Engineering 核心）

对于本次解决的**每个重要问题**，创建结构化解决方案：

文件路径：`docs/solutions/{YYYY-MM-DD}-{slug}.md`

```markdown
---
title: "[问题简述]"
date: YYYY-MM-DD
tags:
  - solution
  - [领域标签]
related_instincts: [instinct-id-1, instinct-id-2]
aliases:
  - "[问题关键词]"
---

# [问题简述]

## 问题
[1-2 句描述遇到的问题]

## 根因
[为什么会出现这个问题]

## 解决方案
[具体怎么解决的，含代码示例（如果适用）]

## 预防
[如何避免再次遇到]

## Related
- [[相关本能ID]] — 关联的行为本能
- [[相关session]] — 发现此问题的会话
```

同时在 `CLAUDE.md` 的 `### 解决方案索引` 追加一行：

```markdown
- [YYYY-MM-DD] [标签] 问题简述 → 方案摘要 (详见 docs/solutions/xxx.md)
```

### 第三步：提取经验到 rules（/learn 逻辑）

按经验的适用范围分类写入：

- 项目特有 → `.claude/rules/` 对应文件
- 跨项目通用 → `~/.claude/CLAUDE.md` 的技术沉淀部分

格式：

```markdown
- [YYYY-MM] [领域] **标题**：简述
  - 原因：...
  - 解决：...
```

### 第四步：创建/更新本能

从本次会话中识别原子化行为模式：

**必须创建本能的情况：**

- 用户纠正了 Claude → type: user_correction, 置信度 0.5+
- 解决了一个耗时 bug → type: error_resolution, 置信度 0.3-0.7
- 反复使用某个工作流 → type: repeated_workflow, 置信度 0.3
- 做出了明确偏好选择 → type: tool_preference, 置信度 0.5

写入位置决策：

- 通用行为 → `~/.claude/homunculus/instincts/personal/`
- 项目特有 → `~/.claude/homunculus/projects/{hash}/instincts/`

已有本能 → 置信度 +0.1（上限 0.95）

**Obsidian 兼容格式要求：**

- frontmatter 必须包含 `tags` 数组（含 `instinct` + 域标签）
- frontmatter 包含 `aliases` 字段（触发条件的简短描述）
- 正文末尾添加 `## Related` 区域，用 `[[wikilink]]` 链接相关本能和会话
- 解决方案文件同理：`tags` 含 `solution`，末尾 `## Related` 链接本能

### 第五步：审查中的发现

如果本次执行过 `/review`，检查审查报告中标注 `[新发现]` 的条目，
将它们提取为本能或 rules 条目。

### 第六步：更新项目文档（CRITICAL — 不可跳过）

**MUST** 更新项目文档：

1. **查找文档**：在 `docs/plans/` 下找到当前功能对应的文档

2. **填写内容**：
   - 在「复利记录」章节填写：提取的经验、创建的本能、解决方案文档链接
   - 更新 Status 为 `completed`
   - 更新 Updated 日期

3. 如果本次工作没有对应的项目文档（如小修复），跳过此步

### 第七步：采集 Skill 使用信号（v4 新增 — Skill 自迭代反馈回路）

检查本次会话中执行过哪些 skill 或工作流命令（如 `/prototype`、`/review`、`/plan`、`/think`、`/work`、`/sprint`、自定义 skill）。对每个执行过的 skill，记录一条结构化的使用信号：

```json
{
  "skill": "prototype",
  "timestamp": "2026-04-13T10:20:30.000Z",
  "session_id": "s-xxx",
  "signals": {
    "invocation": "explicit",
    "steps_completed": [1, 2, 3],
    "steps_skipped": [4],
    "user_corrections": ["问题太多了，一次最多 3 个"],
    "outcome": "completed",
    "duration_minutes": 18,
    "related_instincts_created": ["prefer-short-question-rounds"]
  }
}
```

字段说明：

- `invocation`: `explicit`（用户显式触发） | `auto`（自动建议触发） | `skipped`（用户拒绝触发）
- `steps_completed` / `steps_skipped`: skill 定义的步骤编号
- `user_corrections`: 本次会话中针对该 skill 执行方式的纠正
- `outcome`: `completed` | `abandoned`（用户中途放弃）
- `related_instincts_created`: 本次 compound 新建的、与此 skill 相关的本能 id

**写入位置**：追加到 `~/.claude/homunculus/skill-signals/{skill-name}.jsonl`，一个 skill 一个文件，追加写入（jsonl 格式）。

**异常提示**：如果某个 skill 在最近 10 次调用中 `outcome: abandoned` 占比 > 30%，或 `user_corrections` 累计 3+ 次，在报告中附加提示：

```text
💡 /prototype 近期使用信号异常（放弃率 40%），建议 /skill-diagnose prototype
```

### 第八步：本能与 skill 差异标记（v4 新增）

遍历第四步新创建的本能，判断是否与某个现有 skill（在 `~/.claude/skills/` 或 `~/.claude/commands/`）相关：

- **判断依据**：本能的 `domain` 或 `trigger` 语义命中某个 skill 的职责范围
- **命中时**：在本能 frontmatter 追加 `pending_absorption: "{skill-name}"`
- **累积提示**：当某个 skill 累计 5+ 个待吸收本能时，在报告中附加：

```text
💡 5 个新本能与 /review 相关但未被吸收，建议 /skill-improve review --absorb
```

这是 skill 自迭代闭环的第一层（信号采集 + 差异标记）。后续层由 `/skill-diagnose`、`/skill-improve`、`/skill-eval`、`/skill-publish` 承担。

### 第九步：输出复利报告

```text
复利报告

解决方案: N 个 → docs/solutions/
   - [slug1]: 问题简述
   - [slug2]: 问题简述

经验写入:
   .claude/rules/debugging-gotchas.md: +2 条
   .claude/rules/performance.md: +1 条
   ~/.claude/CLAUDE.md: +1 条 (通用经验)

本能更新:
   新增 fix-xxx (debugging, 0.5)
   提升 prefer-yyy (code-style, 0.7 → 0.8)

项目文档: docs/plans/YYYY-MM-DD-xxx.md → completed

Skill 使用信号:
   /prototype: 1 次 (completed, 18min)
   /review:    1 次 (completed, 0 纠正)
   采集到 ~/.claude/homunculus/skill-signals/

待吸收本能: 2 个本能已标记 pending_absorption: "review"

⚠️ Skill 异常 (如有):
   💡 /prototype 放弃率 40% → 建议 /skill-diagnose prototype

复利统计:
   本项目累计: N 个解决方案, M 个本能, K 条 rules
   本月新增: +X 个解决方案

下次遇到类似问题，/plan 会自动读取这些解决方案
下次类似 skill 调用，/skill-diagnose 会基于信号数据给出改进建议
```

## 与其他命令的关系

```text
/think   → 产出: 需求分析 → 写入项目文档
/plan    → 产出: 技术方案 → 写入项目文档
/work    → 产出: 代码变更 → 更新项目文档进度
/review  → 产出: 审查报告 → 写入项目文档
/compound → 产出: 复利记录 → 写入项目文档并标记 completed
                             ↑ 这就是"复利"
```

## 为什么 /compound 优于单纯 /learn

| 能力             | /learn | /compound |
|------------------|--------|-----------|
| 提取经验到 rules | ✅ | ✅ |
| 创建本能 | ✅ | ✅ |
| 生成解决方案文档 | ❌ | ✅ |
| 更新解决方案索引 | ❌ | ✅ |
| 整合 /review 发现 | ❌ | ✅ |
| 更新项目文档状态 | ❌ | ✅ |
| 复利统计 | ❌ | ✅ |

/learn 仍然可用（作为轻量版），/compound 是 /learn 的超集。
