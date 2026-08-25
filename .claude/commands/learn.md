---
description: "从当前会话提取项目特有 EvidenceRef，并提交受治理的 LearningCandidate"
---

# learn — 项目级学习候选提取

只提取项目特有且可追溯的证据与候选；通用发现也必须走同一 Candidate authority。

## Guardrails

- 不直接写 `.claude/rules/`、CLAUDE.md、Memory、instinct、skill、command 或 runtime marker。
- 自动流程最多执行 `propose -> evaluate -> shadow`，不得因高置信度、重复观察或 auto 模式执行
  `approve`、`promote` 或 `publish`。
- 现有 rules、历史本能和项目文档只用于上下文与去重，不自动成为本次新证据。

## Steps

1. 从当前会话已验证的测试、日志、补丁、用户纠正或稳定产物建立 EvidenceRef。
2. 提取踩坑、根因、架构决策、性能发现或工具策略，并检查重复、反例和适用边界。
3. 通过 canonical self-learning writer `propose` project-scope LearningCandidate。
4. 证据和独立 evaluator 齐全时可 `evaluate`；缺失时保持 `needs-review`。
5. 输出 candidate id/hash、scope、EvidenceRef、反例、TV 状态和未验证项。

## 停止条件

- canonical writer、schema、redaction 或写后读回失败时停止并报告 partial/failed。
- 不回退到旧 Markdown 直接写路径；后续发布必须有独立 approval receipt 与显式人工 gate。
