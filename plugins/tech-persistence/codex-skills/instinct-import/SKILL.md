---
name: instinct-import
description: Codex-compatible entry point for the former /instinct-import command. 将他人分享的本能解析为待核验学习候选
---

# Instinct Import

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/instinct-import` command.

## Invocation

Use `$instinct-import <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/instinct-import`, interpret that as this `$instinct-import` skill invocation while running in Codex.

## Command Instructions

# /instinct-import — 导入本能

从导出文件中读取他人分享的本能，将其作为 `legacy-unverified` evidence 提交为待核验
`LearningCandidate`；不直接导入可注入 instinct。

## Self-learning candidate gate

- 导入输出统一通过 canonical `scripts/self-learning.js` 执行 `propose`；只有本地独立 evidence 完整时
  才可 `evaluate`，所有候选必须先进入 `shadow`。
- 自动或批量导入最多执行 `propose`、`evaluate`、`shadow`；不得执行 `approve`、`promote`，不得写
  inherited instinct、rules、skill、command、marker 或共享 runtime。
- “确认导入”只确认 proposal 范围，不是显式 `user.approval`，不能生成 approval receipt。
- 来源 confidence 仅作为折扣后的弱信号，不能替代 TV、counterexample、本地复现或最终处置。

## 使用方式
`/instinct-import path/to/instincts-export.md`

## 执行步骤

1. 读取导入文件，解析其中的本能列表
2. 对每个本能：
   - 递归脱敏并为原文件/条目建立 content-bound EvidenceRef
   - 标记 assurance=`legacy-unverified`、fact status=`unknown` 和原始来源 digest
   - 置信度乘以 0.8，仅记录为弱 signal
   - 检查与现有 candidate、rule、instinct、solution 的重复与冲突
3. 展示导入预览，等待确认：

```
📥 本能导入预览

| # | Candidate | scope | 原始置信度 | 折扣信号 | 状态 |
|---|------|-----|----------|----------|------|
| 1 | prefer-xxx | project | 0.70 | 0.56 | proposed |
| 2 | use-xxx | project | 0.80 | 0.64 | needs-review（冲突） |
| 3 | always-xxx | project | 0.90 | 0.72 | proposed |

确认创建 candidate proposal? (y/n，或输入编号选择性提交)
```

4. 确认后通过 canonical writer 执行 `propose`，读回每个 `candidate_id`、`candidate_hash` 和状态
5. 冲突、缺来源 identity 或缺本地验证的候选进入 `needs-review`；不创建 pending-review 文件旁路

## 注意
- 导入候选必须由后续独立 Episode/evidence 验证，并经过 `evaluate`、`shadow` 与显式人工批准才可能
  promoted
- reject/expire/delete 使用 self-learning governance/tombstone；不通过删除旧 Markdown 冒充 journal 擦除
- 任一 schema、hash、redaction 或 readback 失败时 fail closed，不回退到 inherited 目录写入
