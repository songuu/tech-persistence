# Obsidian 使用指南 — Sprint & Checkpoint 补充

> 追加到 docs/obsidian-usage.md 末尾

---

## Sprint 交接工作流

### 自动化流程

```
/sprint 执行中
  ↓ Task 5 完成
  ↓ Claude 建议 checkpoint
/checkpoint
  ↓ 生成 docs/plans/xxx-handoff-1.md (#handoff)
  ↓ Obsidian 自动出现金色节点
/compact 或关闭会话
  ↓
新会话开始
  ↓ SessionStart Hook 检测到 handoff 文件
  ↓ 自动注入 sprint 状态 + 关键决策
/sprint resume
  ↓ 从 Task 6 继续
```

### 在 Obsidian 中查看 Sprint

**Graph View 中的 Sprint 链路：**
```
Sprint 文档 (青色 #sprint)
  ├── Handoff #1 (金色 #handoff)
  ├── Handoff #2 (金色 #handoff)
  ├── Solution A (深绿 #solution)
  └── Instinct X (紫色 #instinct)
```

一个 sprint 会产生多个 handoff 节点（每次 checkpoint 一个），
以及多个 solution 和 instinct 节点（由 /compound 产生）。
它们通过 wikilinks 互相关联。

### Dataview 查询

**活跃的 Sprint（未完成）：**
````
```dataview
TABLE status, tasks_completed + "/" + tasks_total AS progress
FROM #sprint
WHERE status != "completed"
SORT updated DESC
```
````

**某个 Sprint 的所有 Checkpoint：**
````
```dataview
TABLE checkpoint_number, phase, created
FROM #handoff
WHERE sprint_doc = "docs/plans/2026-06-20-user-export.md"
SORT checkpoint_number ASC
```
````

**本月的所有 Sprint：**
````
```dataview
TABLE status, tasks_total, checkpoints
FROM #sprint
WHERE created >= date(today) - dur(30 days)
SORT created DESC
```
````

---

## 知识类型完整映射（更新版）

| 类型 | Tag | 颜色 | 产生方式 | 存储路径 |
|------|-----|------|---------|---------|
| 本能 | `#instinct` | 紫色 | Hook + /compound | instincts/ |
| 会话 | `#session` | 绿色 | Stop Hook | sessions/ |
| 解决方案 | `#solution` | 深绿 | /compound | docs/solutions/ |
| 规则 | `#rule` | 橙色 | /compound /learn | .claude/rules/ |
| 架构决策 | `#architecture` | 红色 | /compound | rules/architecture.md |
| **Sprint** | **`#sprint`** | **青色** | **/sprint** | **docs/plans/** |
| **交接点** | **`#handoff`** | **金色** | **/checkpoint** | **docs/plans/*-handoff-*.md** |
