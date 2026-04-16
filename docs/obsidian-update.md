# Obsidian 配置增量更新

> 在已有的 Obsidian vault 中执行以下操作，添加新的 tag 颜色分组。

## 需要更新的文件

### `.obsidian/graph.json`

在 `colorGroups` 数组中添加以下 2 个分组：

```json
{
  "query": "tag:#handoff",
  "color": { "a": 1, "rgb": 16761095 }
},
{
  "query": "tag:#sprint",
  "color": { "a": 1, "rgb": 2263842 }
}
```

完整的 colorGroups 应该是：

| Tag | 颜色 | RGB 值 | 含义 |
|-----|------|--------|------|
| `#instinct` | 紫色 | 8667902 | 本能节点 |
| `#session` | 绿色 | 4559462 | 会话摘要 |
| `#rule` | 橙色 | 15105570 | 规则文件 |
| `#solution` | 深绿 | 2930463 | 解决方案 |
| `#architecture` | 红色 | 14423100 | 架构决策 |
| `#handoff` | 金色 | 16761095 | Sprint 交接点 (**新增**) |
| `#sprint` | 青色 | 2263842 | Sprint 文档 (**新增**) |

### `_templates/handoff.md` (新建)

```markdown
---
type: sprint-handoff
sprint_doc: ""
checkpoint_number: 1
created: "<% tp.date.now("YYYY-MM-DDTHH:mm:ss") %>"
phase: "work"
tags: [handoff, sprint]
---

# Sprint Handoff #{{checkpoint_number}}

## Sprint 状态
- 文档: {{sprint_doc}}
- 当前阶段: {{phase}}
- Task 进度: /

## 已完成的 Task

## 未完成的 Task

## 关键决策

## 已修改的文件

## 当前测试状态

## 环境/阻塞

## 下一步

## Related
```

### `Dashboard.md` 追加

在 Dashboard 中添加一个新区域：

```markdown
## 活跃 Sprint

\```dataview
TABLE status, tasks_completed + "/" + tasks_total AS progress, updated
FROM #sprint
WHERE status != "completed"
SORT updated DESC
\```

## 最近的 Checkpoints

\```dataview
TABLE sprint_doc, phase, checkpoint_number
FROM #handoff
SORT created DESC
LIMIT 5
\```
```

### `.obsidianignore` 追加

```
# 已有的忽略规则保持不变，追加：
*.jsonl.bak
*.bak.*
```
