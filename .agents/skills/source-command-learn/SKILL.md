---
name: "source-command-learn"
description: "从当前会话提取项目特有 EvidenceRef 与 LearningCandidate"
---

# source-command-learn

Use this skill when the user asks to run the migrated source command `learn`.

## Command Template

# /learn — 项目级学习候选提取

只提取**项目特有**且可追溯的证据与候选。通用发现也必须走同一 Candidate authority，不走旧 Markdown
知识写入旁路。

## 步骤
1. 只读检查 AGENTS.md、现有 rules、历史本能、`package.json`，用于去重和上下文，不把它们视为新证据。
2. 从当前会话的已验证结果、用户纠正、测试、日志或稳定产物建立 EvidenceRef。
3. 通过 canonical self-learning writer `propose` project-scope LearningCandidate。
4. 证据和独立 evaluator 齐全时可 `evaluate`，自动执行最多到 `shadow`。
5. 输出 candidate id/hash、scope、EvidenceRef、反例、TV 状态和未验证项。

## 禁止旁路

- 不直接写 `.Codex/rules/`、`.claude/rules/`、AGENTS.md、CLAUDE.md、Memory 或 instinct。
- 不因 `--auto`、高置信度或重复观察而执行 approve、promote 或 publish。
- 缺稳定来源、最终处置或验证时只报告 needs-review，不回退到旧写入路径。
