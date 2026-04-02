---
description: "全流程冲刺：自动串联 think→plan→work→review→compound，中间暂停确认"
---

# /sprint — 全流程冲刺

一个命令驱动完整的 Plan→Work→Review→Compound 循环。
在关键决策点暂停等待用户确认。

## 用法
`/sprint <需求描述>`

## 执行流程

### Phase 1: Think (暂停确认)
```
🎯 Phase 1/5: Think

[执行 /think 逻辑，输出范围定义]

→ 确认范围后输入 'go' 进入 Plan 阶段
→ 输入修改意见进行调整
→ 输入 'skip' 跳过 Think 直接 Plan
```

### Phase 2: Plan (暂停确认)
```
📋 Phase 2/5: Plan

[执行 /plan 逻辑，输出实现计划]

→ 确认计划后输入 'go' 进入 Work 阶段
→ 输入修改意见进行调整
```

### Phase 3: Work (自动执行)
```
🔨 Phase 3/5: Work

[执行 /work 逻辑，按计划逐步实现]
[每个 Task 完成后输出进度]
[遇到 blocker 暂停]
```

### Phase 4: Review (暂停确认)
```
🔍 Phase 4/5: Review

[执行 /review 逻辑，多视角审查]
[输出 P0/P1/P2 问题列表]

→ P0 自动修复
→ P1 确认后修复
→ 修复完成后输入 'go' 进入 Compound 阶段
```

### Phase 5: Compound (自动执行)
```
🔄 Phase 5/5: Compound

[执行 /compound 逻辑，提取所有经验]
[输出复利报告]

🏁 Sprint 完成！
```

## 适用场景
- 中到大型功能开发
- 需要完整规划-实现-审查-学习流程
- 希望确保每次开发都有知识积累

## 不适用场景
- 快速修一个小 bug → 直接修，然后 /compound
- 探索性调研 → 自由对话，然后 /learn
- 紧急热修复 → 直接修，然后 /debug-journal
