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
/checkpoint --caveman     ← 同时生成 compact handoff，便于低 token resume
```

## 执行步骤

1. 检测当前是否在 sprint 中（有活跃的 `docs/plans/` 文档）
2. 扫描会话，提取：
   - 已完成/未完成的 Task
   - 关键决策（方案选择、技术取舍）
   - 已修改的文件列表
   - 当前测试状态
   - 阻塞项
3. 生成交接文件 `docs/plans/.handoff/{name}-handoff-{N}.md`（Obsidian 兼容 frontmatter；目录不存在时自动创建）
4. 如果当前 sprint 启用了 caveman/token 压缩模式，额外生成 `docs/plans/.handoff/{name}-handoff-{N}-compact.md`
5. 滚动保留协议：写入新 handoff 后，列同一 sprint name 的全部 handoff（按 mtime 倒序），删除超出保留数的最早项
   - 保留数默认 3，可通过环境变量 `TECH_PERSISTENCE_CHECKPOINT_RETENTION` 覆盖
   - 完整 handoff 与 compact handoff 视为同一组（一对 `-N.md` + `-N-compact.md` 算 1 个）
   - 删除前在控制台打印 `[checkpoint] retention: removed <name>-handoff-X.md` 便于审计
6. 更新 sprint 主文档的 status

**为何用 `.handoff/` 子目录 + gitignore**：
- handoff 是 ephemeral context bridge（仅供 /compact 后 resume），不是 durable artifact
- 已通过 `.gitignore` 排除 `docs/plans/.handoff/` 避免污染 git 历史（11ddfae 历史教训：单 sprint 跑出 123+ handoff 文件全进 git）
- `.` 前缀目录在多数 Obsidian vault 配置中默认隐藏，主文档列表保持干净

## Compact handoff

compact handoff 用于 `/sprint resume --caveman` 的低 token 恢复。它不是完整交接的替代品，只是 resume 首读摘要。

必须包含：

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

写法规则：
- 每项 1 行或极短 bullet
- 不放完整 diff
- 不复制 sprint 主文档正文
- 保留文件路径、命令、错误原文
- 信息不足以恢复时，明确写 `Need full doc if`

## 输出
```
⚡ Checkpoint #N 已保存

  文件: docs/plans/.handoff/xxx-handoff-1.md
  Compact: docs/plans/.handoff/xxx-handoff-1-compact.md
  进度: 5/8 Task
  关键决策: 3 条
  保留: 3 个最近 handoff（旧的已滚动删除）

  现在可以安全地 /compact 或关闭会话。
  下次说 "继续 sprint" 即可恢复（resume 会从 .handoff/ 找最近一个）。
```

## 不在 sprint 中时

如果没有活跃 sprint，生成通用交接文件 `docs/plans/.handoff/session-{YYYY-MM-DDTHHMM}-handoff.md`：

```yaml
---
type: session-handoff
created: "2026-06-20T14:30:00"
tags: [handoff, session]
---
```

记录：当前在做什么、做到哪里了、下一步是什么、关键上下文。
同样适用滚动保留协议（默认 3，按 mtime）。

