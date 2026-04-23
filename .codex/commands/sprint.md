---
description: "全流程冲刺：think→plan→work→review→compound，含上下文 checkpoint 和恢复"
---

# /sprint — 全流程冲刺

一个命令驱动完整的 Plan→Work→Review→Compound 循环。
**支持上下文 checkpoint：长任务不怕上下文溢出。**

## 用法
```
/sprint <需求描述>       ← 新 sprint
/sprint resume           ← 从最近的 checkpoint 恢复
```

## 项目文档贯穿全流程

整个 sprint 共用一个文档。路径：`docs/plans/YYYY-MM-DD-<需求简写>.md`

```
Phase 1 → 创建文档，填写「需求分析」     → status: draft
Phase 2 → 填写「技术方案」「任务拆解」    → status: planning
Phase 3 → 逐步勾选任务，追加变更日志      → status: in-progress
  ⚡ checkpoint → 生成 handoff 文件       → status: checkpoint-N
  恢复 → 继续 work                       → status: in-progress
Phase 4 → 填写「审查结果」               → status: reviewing
Phase 5 → 填写「复利记录」               → status: completed
```

## 执行流程

### Phase 1: Think (暂停确认)
```
Phase 1/5: Think
[执行 /think，输出范围定义]
[创建 docs/plans/YYYY-MM-DD-xxx.md，填写需求分析]
→ 'go' 进入 Plan | 修改意见调整 | 'skip' 跳过
```

### Phase 2: Plan (暂停确认)
```
Phase 2/5: Plan
[执行 /plan，输出实现计划]
[填写文档的技术方案、任务拆解]
[如果 Task > 5 个，预告：将在 Task 5 后自动 checkpoint]
→ 'go' 进入 Work | 修改意见调整
```

### Phase 3: Work (含自动 checkpoint)
```
Phase 3/5: Work
[执行 /work，按计划逐步实现]
[每个 Task：实现 → 风险评估 → 按等级测试 → 勾选文档 checkbox]

⚡ 每 5 个 Task 自动检查是否需要 checkpoint:
  ├── 无退化信号 → 继续
  └── 有退化信号 或 已完成 5 个 Task → 建议 checkpoint:
      "⚡ 建议 checkpoint — 已完成 5/8 Task，上下文压力较大
       执行 /checkpoint 保存状态，然后 /compact
       下次 /sprint resume 恢复"

退化信号检测：
  - 工具调用参数出错增多
  - 忘记了 Phase 1/2 中确认的约定
  - 回答变得笼统
  - 会话轮次 > 30
```

### Phase 3 恢复（从 checkpoint）
```
/sprint resume

📋 检测到 Checkpoint:
  Sprint: 用户导出功能
  文件: docs/plans/2026-06-20-user-export-handoff-1.md
  进度: 5/8 Task
  下一步: Task 6 — 异步大文件导出

  3 个关键决策已加载。继续？
→ 'go' 继续 Task 6
```

恢复时做的事：
1. 读取 handoff 文件 → 加载进度、决策、文件列表
2. 读取 sprint 主文档 → 加载方案和 Task 列表
3. 读取相关测试文件 → 确认测试状态
4. 从下一个未完成 Task 继续

### Phase 4: Review (暂停确认)
```
Phase 4/5: Review
[执行 /review，多视角审查]
[审查报告写入文档]
→ P0 自动修复 → P1 确认 → 'go' 进入 Compound
```

### Phase 5: Compound (自动执行)
```
Phase 5/5: Compound
[执行 /compound]
[填写文档复利记录，status → completed]
[sprint 文档的 frontmatter 添加 Obsidian tags]

🏁 Sprint 完成！
  文档: docs/plans/2026-06-20-xxx.md
  Checkpoints: N 次
  知识: M 条经验, K 个本能, J 个 skill 信号
```

## Sprint 文档 frontmatter（Obsidian 兼容）

```yaml
---
title: "用户导出功能"
type: sprint
status: completed
created: "2026-06-20"
updated: "2026-06-21"
checkpoints: 1
tasks_total: 8
tasks_completed: 8
tags: [sprint, feature]
aliases: ["用户导出"]
---
```

## 适用场景
- 中到大型功能开发
- 需要完整规划-实现-审查-学习流程
- 长任务（8+ Task）自动 checkpoint 保证不丢失进度

## 不适用
- 小 bug → 直接修 → /compound
- 探索调研 → 自由对话 → /learn
