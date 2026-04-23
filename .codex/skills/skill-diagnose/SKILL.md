---
name: skill-diagnose
description: Codex-compatible entry point for the former /skill-diagnose command. 诊断 skill 健康状况：使用信号分析、步骤热力图、纠正模式、本能差异
---

# Skill Diagnose

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/skill-diagnose` command.

## Invocation

Use `$skill-diagnose <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/skill-diagnose`, interpret that as this `$skill-diagnose` skill invocation while running in Codex.

## Command Instructions

# /skill-diagnose — Skill 健康诊断

读取 `~/.codex/homunculus/skill-signals/{name}.jsonl`，分析 skill 的使用情况。

## 用法
- `/skill-diagnose` — 诊断所有 skill
- `/skill-diagnose prototype` — 诊断指定 skill

## 输出格式
```
## Skill 诊断: /{name}

使用统计 (最近 30 天):
  调用: N 次 | 完成率: X% | 平均耗时: Xmin

步骤热力图:
  | 步骤 | 执行率 | 跳过率 | 修改率 |
  标记 跳过率>30% 和 修改率>20% 的步骤

用户纠正模式:
  - N次: "具体纠正内容" → 建议 skill 如何调整

本能差异:
  - N 个新本能与此 skill 相关但未吸收
  - N 个本能与 skill 当前指令矛盾

诊断结论:
  🟢 健康 | 🟡 建议迭代 | 🔴 需要重构
  具体改进建议列表
```

## 触发时机
- 手动执行
- `/retrospective` 时自动附带
- 某 skill 放弃率 > 30% 时 `/compound` 提示

