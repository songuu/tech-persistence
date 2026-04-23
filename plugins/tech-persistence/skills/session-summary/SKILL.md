---
name: session-summary
description: Codex-compatible entry point for the former /session-summary command. 生成当前会话的完整技术总结 + 自动调用 /learn 提取经验和本能
---

# Session Summary

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/session-summary` command.

## Invocation

Use `$session-summary <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/session-summary`, interpret that as this `$session-summary` skill invocation while running in Codex.

## Command Instructions

# /session-summary — 会话总结（自学习增强版）

## 报告模板

```markdown
# 会话总结 — [YYYY-MM-DD HH:MM]

## 概要
- 持续时长: ~N 分钟
- 工具调用: N 次 (主要: Read, Edit, Bash)
- 自动观察: N 条 (已写入 observations.jsonl)

## 完成的工作
- [ ] 任务1
- [ ] 任务2

## 关键技术决策
| 决策 | 选择 | 原因 | 备选 |
|------|------|------|------|

## 踩坑 & 解决
### 问题1: [标题]
- **现象**:
- **根因**:
- **解决**:

## 待办 & 后续
- [ ] ...

## 自学习产出
### 新增/更新的经验 (→ rules/)
| 经验 | 写入位置 |

### 新增/更新的本能 (→ instincts/)
| 本能 | 域 | 置信度 | 状态 |
```

## 执行步骤
1. 回顾整个会话历史
2. 按模板生成报告
3. **自动调用 /learn** 提取经验 + 本能
4. 将报告保存到 `~/.codex/homunculus/projects/{project}/sessions/`
5. 输出报告

## 额外行为
- 如果观察日志中有 error/Error → 自动触发 /debug-journal 逻辑
- 如果有架构决策 → 自动追加到 `.codex/rules/architecture.md`

