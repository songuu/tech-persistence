---
name: skill-improve
description: Codex-compatible entry point for the former /skill-improve command. 基于诊断结果为 skill 生成修改提案：合并/精简/吸收本能/拆分
---

# Skill Improve

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/skill-improve` command.

## Invocation

Use `$skill-improve <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/skill-improve`, interpret that as this `$skill-improve` skill invocation while running in Codex.

## Command Instructions

# /skill-improve — Skill 改进提案

读取 `/skill-diagnose` 的诊断报告 + 信号文件 + 相关本能，生成结构化修改提案。

## 用法
- `/skill-improve prototype` — 为指定 skill 生成改进提案
- `/skill-improve --absorb` — 将所有待吸收本能合入对应 skill

## 提案类型
1. **合并步骤**：跳过率 > 30% 的步骤合并到相邻步骤
2. **降级为可选**：使用率 < 25% 的步骤标记为可选
3. **吸收本能**：将 `pending_absorption` 标记的本能写入 skill
4. **精简提问**：纠正 "太多了" 3+ 次 → 减少每轮问题数
5. **拆分 skill**：skill 过于庞大时拆为 2 个更聚焦的 skill

## 输出格式
```
修改提案: /{name} v{N} → v{N+1}

提案 1: [标题] (数据依据: ...)
  变更: ...
  影响: ...

提案 2: ...

差异预览 (关键段落 diff):
  - 旧内容
  + 新内容

确认哪些提案？(编号 或 'all')
```

## 确认后
- 生成修改后的 skill 内容（不立即写入）
- 建议执行 `/skill-eval {name} --diff` 验证

