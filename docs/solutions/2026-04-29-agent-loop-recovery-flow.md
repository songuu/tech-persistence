---
title: "Agent Loop 恢复流与 Provider 输出归一化"
date: 2026-04-29
tags: [solution, agent-loop, orchestrator, windows]
related_instincts: []
aliases: ["blocked resume", "summary approved", "plan.tasks"]
---

# Agent Loop 恢复流与 Provider 输出归一化

## Problem

`agent-loop` 在真实运行中出现多处需要人工介入的问题：Spec 输出 `plan.tasks` 无法解析、review 输出 `summary: "APPROVED"` 仍被判为 `needs-followup`、`blocked` 状态无法 resume、Windows Codex sandbox 写入失败，以及 provider 日志被覆盖。

## Root Cause

编排器把 provider 原始输出、运行环境差异和状态流转耦合在一起。状态机直接依赖单一字段形态，resume 只覆盖理想状态，Windows sandbox 和日志策略也依赖用户手动传参或固定文件名。

## Solution

修复方向是把 provider 输出与状态机解耦：

- `normalizeSpec()` 支持 `plan.tasks`、`plan.design`、`plan.requirements` 等 alias。
- `normalizeReview()` 支持 `summary: "APPROVED"`，并让 P0/blocked finding 优先于 approved 信号。
- `runResume()` 支持从 `blocked` 重新进入 implementation。
- `needs-followup` / `blocked` 作为同一 run 的 continuation，允许在已有实现 diff 上继续。
- Windows 下 Codex 未显式指定时默认 `--sandbox workspace-write`，`doctor` 输出 `codexSandbox` 生效策略。
- provider stdout/stderr/last-message 日志使用时间戳，历史 run 通过 `state.providerRuns[]` 追溯。

主要落地文件：

- `scripts/agent-orchestrator.js`
- `plugins/tech-persistence/scripts/agent-orchestrator.js`
- `docs/architecture/ARCHITECTURE_ISSUES.md`
- `.codex/rules/architecture.md`

## Prevention

- 状态机只消费 canonical spec/handoff/review，不直接消费 provider 原始字段。
- 所有 provider 新输出形态必须先补 normalizer 和 `self-test`。
- Windows provider/sandbox 行为必须进入 `doctor`，不能藏在文档里的手动参数。
- 多次 resume 的 artifact 必须可追溯，不用固定日志文件名承载历史。

## Related

- [[2026-04-29-agent-loop-architecture-issues]]
- [[ARCHITECTURE_ISSUES]]
