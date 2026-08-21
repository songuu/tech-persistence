---
name: "source-command-debug-journal"
description: "把已验证调试过程记录为 EvidenceRef 并提出受治理的学习候选"
---

# source-command-debug-journal

Use this skill when the user asks to run the migrated source command `debug-journal`.

## Command Template

# /debug-journal — 调试日志

解决棘手 bug 后使用。保留可追溯的调试事实、反例和验证结果；不得自动生成旧 instinct 或改写 rules。

## 记录格式
```markdown
- [YYYY-MM] [领域] **标题**
  - 现象：用户观察到的表现
  - 误导方向：一开始以为是什么
  - 排查路径：关键排查步骤
  - 根因：最终确认的原因
  - 解决：具体修复方案
  - 预防：如何避免再次发生
```

## Authority 写入

1. 将可读回的测试、日志、补丁或结果 envelope 建为 EvidenceRef；记录 digest、scope、captured_at 与最终处置。
2. 将“根因/预防”分别按 fact 或 inference 提出 `anti_pattern` / `strategy` LearningCandidate。
3. 自动流程最多 `propose -> evaluate -> shadow`；没有独立验证时保持 needs-review。
4. 报告 candidate id/hash、EvidenceRef、反例与未知项。

## 禁止旁路

- 不自动写 `.Codex/rules/debugging-gotchas.md`、AGENTS.md、CLAUDE.md 或其他 rules。
- 不创建或增强 debugging instinct，不写旧 Memory。
- CRITICAL/HIGH/MEDIUM 只表示审查优先级，不映射为置信度或发布权限。
- 用户之后显式要求发布知识时，仍需 candidate evaluation、approval receipt 与目标发布流程的人工 `go`。
