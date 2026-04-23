---
name: checkpoint
description: Codex-compatible entry point for the former /checkpoint command. 保存当前 sprint/任务状态到交接文件，为上下文重置做准备
---

# Checkpoint

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/checkpoint` command.

## Invocation

Use `$checkpoint <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/checkpoint`, interpret that as this `$checkpoint` skill invocation while running in Codex.

## Command Instructions

# /checkpoint — 上下文交接点

在任何时刻保存当前工作状态，为 `/compact` 或新会话做准备。

## 用法
```
/checkpoint               ← 保存当前 sprint 状态
/checkpoint "补充说明"     ← 附加备注
```

## 执行步骤

1. 检测当前是否在 sprint 中（有活跃的 `docs/plans/` 文档）
2. 扫描会话，提取：
   - 已完成/未完成的 Task
   - 关键决策（方案选择、技术取舍）
   - 已修改的文件列表
   - 当前测试状态
   - 阻塞项
3. 生成交接文件 `docs/plans/{name}-handoff-{N}.md`（Obsidian 兼容 frontmatter）
4. 更新 sprint 主文档的 status

## 输出
```
⚡ Checkpoint #N 已保存

  文件: docs/plans/xxx-handoff-1.md
  进度: 5/8 Task
  关键决策: 3 条

  现在可以安全地 /compact 或关闭会话。
  下次说 "继续 sprint" 即可恢复。
```

## 不在 sprint 中时

如果没有活跃 sprint，生成通用交接文件：

```yaml
---
type: session-handoff
created: "2026-06-20T14:30:00"
tags: [handoff, session]
---
```

记录：当前在做什么、做到哪里了、下一步是什么、关键上下文。

