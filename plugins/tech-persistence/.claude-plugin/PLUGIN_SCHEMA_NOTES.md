---
title: ".claude-plugin manifest 约束笔记"
type: reference
created: "2026-06-05"
updated: "2026-06-05"
tags: [reference, plugin, claude, manifest, validator, parity]
aliases: ["PLUGIN_SCHEMA_NOTES", "claude manifest 约束"]
---

# `.claude-plugin/plugin.json` 约束笔记

> 这些是 Claude 插件 validator 的**未文档化、版本相关**约束。它们靠"记得保持 manifest 最小"维持，
> 是 [[documented-claim-vs-code-reality-drift]]（P0a）的典型来源。现已下沉为确定性断言：
> `scripts/plugin-manifest-checks.js`（纯函数）+ `scripts/validate-codex-plugin.js`（IO + 报错），
> 单测 `scripts/test-plugin-manifest-checks.js`。来源评估见 `docs/solutions/2026-06-05-ecc-eval.md` adapt#1。

## 为何 manifest 必须保持最小

当前 `.claude-plugin/plugin.json` 只含 `name` / `version` / `description` / `author` / `homepage` /
`license` / `keywords`，**不声明** `commands` / `skills` / `agents` / `hooks` / `mcpServers`。
Claude Code 按约定**自动发现** `commands/`、`skills/`、`agents/`、`hooks/hooks.json`，
显式声明反而触发 validator 拒绝或重复加载。

## 三条确定性约束（已 enforce）

| 约束 | 违反后果 | enforce 点 |
|---|---|---|
| **禁声明 `agents` key** | Claude validator 判 "Invalid input" | `checkClaudeManifest` |
| **禁声明 `hooks` key** | "Duplicate hooks file"（与自动发现的 `hooks/hooks.json` 冲突） | `checkClaudeManifest` |
| **`commands`/`skills` 若出现必须是数组** | 非数组形状被 validator 拒 | `checkClaudeManifest` |
| **MCP 全限定名 `mcp__<server>__<tool>` ≤ 64 字符** | 超长被 gateway 拒，工具静默不可用 | `findOverlongMcpNames`（守卫拒 >64，不拒恰好 64 避免 FP） |

当前最长 MCP 全限定名 = `mcp__tech-persistence-memory__tp_memory_project_profile` = **55 字符**（余量 9）。
新增长工具名或重命名 server 时，validator 会在 commit 前拒绝突破 64 的情况。

## 与 Codex manifest 的相反要求（关键）

`.codex-plugin/plugin.json` 的要求与 Claude manifest **相反**：它**必须**声明 `skills` / `hooks` /
`mcpServers`（见 `validate-codex-plugin.js` 既有断言）。因此**不能用统一断言校验两个 manifest**——
按 runtime 分别校验，符合 TP 既有 runtime-projection 模式（[[ADR-014]]）。

## 验证

```bash
node scripts/validate-codex-plugin.js          # 含 .claude-plugin manifest + MCP fq-name 守卫
node scripts/run-tests.js --grep plugin-manifest-checks   # 单测（含三档负样本）
```

负样本（证明断言真拒，[[feedback_negative_sample_3_archs]]）：给本 manifest 临时加 `"hooks": "..."`
或把某 MCP 工具改名到 65 字符 → `validate-codex-plugin.js` 必须 exit≠0。
