---
name: sprint
description: Codex-compatible entry point for the former /sprint command. 全流程冲刺：think→plan→work→review→compound，含上下文 checkpoint 和恢复
---

# Sprint

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/sprint` command.

## Invocation

Use `$sprint <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/sprint`, interpret that as this `$sprint` skill invocation while running in Codex.

## Command Instructions

# /sprint — 全流程冲刺

一个命令驱动完整的 Plan→Work→Review→Compound 循环。
**支持上下文 checkpoint：长任务不怕上下文溢出。**

## 用法
```
/sprint <需求描述>       ← 新 sprint
/sprint --caveman <需求> ← 新 sprint，启用 token 压缩模式
/sprint resume           ← 从最近的 checkpoint 恢复
/sprint resume --caveman ← 从 compact handoff 优先恢复
```

Codex 中同义：

```text
$sprint <需求描述>
$sprint --caveman <需求描述>
$sprint resume --caveman
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

## Caveman Token Budget Mode

触发方式：
- 用户显式写 `$sprint --caveman ...`
- 用户在 sprint 请求中说“压缩 token / less tokens / caveman / 简短”
- 当前会话已启用 `$caveman`，且用户没有要求完整展开

核心原则：

| 层 | 策略 |
|---|---|
| 对话输出 | `caveman-lite` 或 `caveman-full`，只报决策、风险、下一步 |
| sprint 主文档 | `artifactMode=complete`，完整保留 scope、验收、任务、测试、审查 |
| checkpoint | 同时生成完整 handoff 和 compact handoff |
| resume | `compact-first`：先读 compact handoff，不足时再读完整 sprint 文档 |
| review | findings 用一行式格式：`文件:行: severity: 问题。修复。` |
| compound | 对话只报数量和路径，完整经验写入 rules/solutions |

禁止压缩：
- `docs/plans/*.md` 主 sprint 文档
- 架构决策、验收标准、测试策略、P0/P1 审查依据
- 安全警告、不可逆操作确认、复杂迁移步骤
- 代码块、命令、文件路径、错误原文

允许压缩：
- 阶段汇报
- 中间状态
- checkpoint/resume 摘要
- review finding 展示
- compound 收尾报告

compact handoff 文件：

```text
docs/plans/YYYY-MM-DD-xxx-handoff-N.md          # 完整交接
docs/plans/YYYY-MM-DD-xxx-handoff-N-compact.md  # 压缩恢复摘要
```

compact handoff 必须包含：

```markdown
# Compact Handoff

Sprint: <名称>
Progress: <完成数>/<总数>
Next: <下一步>
Changed: <文件列表>
Decisions: <关键决策，最多 5 条>
Validation: <命令 + 结果>
Risks: <未关闭风险>
Need full doc if: <何时必须回读完整 sprint 文档>
```

阶段输出预算：

```text
Think: scope / non-scope / success / risks，各 1-3 条
Plan: 任务表 + 验证策略，不展开实现细节
Work: 只报 Task delta、测试结果、阻塞项
Review: 只报 P0/P1；P2 写入文档，不默认展开
Compound: 只报沉淀数量、路径、是否建议 compact
```

如果用户要求“完整版本 / 完整架构 / 从源头看”，临时退出 caveman 输出压缩；完整说明后再恢复 compact mode。

## 执行流程

### Phase 1: Think (暂停确认)
```
Phase 1/5: Think
[执行 /think，输出范围定义]
[创建 docs/plans/YYYY-MM-DD-xxx.md，填写需求分析]
→ 'go' 进入 Plan | 修改意见调整 | 'skip' 跳过
```

Caveman mode 输出：

```text
Scope: ...
Non-scope: ...
Success: ...
Risks: ...
Next: go -> Plan
```

### Phase 2: Plan (暂停确认)
```
Phase 2/5: Plan
[执行 /plan，输出实现计划]
[填写文档的技术方案、任务拆解]
[如果 Task > 5 个，预告：将在 Task 5 后自动 checkpoint]
→ 'go' 进入 Work | 修改意见调整
```

Caveman mode 输出只展示任务表和验证策略；完整方案写入 sprint 文档，不在对话中重复。

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

Caveman mode 中，每个 Task 完成只输出：

```text
Done: Task N
Changed: <files>
Risk: Lx
Test: <command> -> pass/fail/skipped
Next: Task N+1
```

达到 checkpoint 条件时必须生成 compact handoff，并提示先 `/compound` 再 `/compact`。

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
1. 如果是 caveman mode，先读取最新 `*-handoff-*-compact.md`
2. compact 信息不足时，读取完整 handoff 和 sprint 主文档
3. 读取相关测试文件 → 确认测试状态
4. 从下一个未完成 Task 继续

### Phase 4: Review (暂停确认)
```
Phase 4/5: Review
[执行 /review，多视角审查]
[审查报告写入文档]
→ P0 自动修复 → P1 确认 → 'go' 进入 Compound
```

Caveman mode review 展示：

```text
P0:
- path:line: bug/risk: problem. fix.
P1:
- path:line: risk/nit: problem. fix.
```

完整审查表仍写入 sprint 文档。

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

Caveman mode 收尾：

```text
Done: sprint completed
Doc: <path>
Knowledge: <N rules>, <M instincts>, <K signals>
Compact: yes/no + reason
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

