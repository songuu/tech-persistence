---
name: skill-diagnose
description: Codex-compatible entry point for the former /skill-diagnose command. [alias → /skill diagnose] 诊断 skill 健康状况：使用信号分析、步骤热力图、纠正模式、本能差异、progressive disclosure
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

Progressive disclosure 检查:
  - description trigger 清晰度: [清晰 / 模糊 / 误触发风险]
    (检查 frontmatter description 是否包含具体 trigger 词；模糊 description 导致 agent 难判断何时加载 skill，引发误触发或漏触发)
  - SKILL.md 行数: N 行 [<100 健康 / 100-200 警告 / >200 需拆分]
  - 应否拆 reference: [是 / 否]
    (>100 行且含多个领域协议、或长协议/低频高级用法挤占主入口时建议拆 REFERENCE.md / EXAMPLES.md)
  - 应否脚本化: [是 / 否]
    (同一 deterministic 操作反复由 LLM 生成 → 沉到 scripts/ 减少 token + 提高确定性)

诊断结论:
  🟢 健康 | 🟡 建议迭代 | 🔴 需要重构
  具体改进建议列表
```

## 触发时机
- 手动执行
- `/retrospective` 时自动附带
- 某 skill 放弃率 > 30% 时 `/compound` 提示

