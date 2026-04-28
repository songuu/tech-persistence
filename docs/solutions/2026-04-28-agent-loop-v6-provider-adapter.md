---
title: "Agent Loop v6 Provider Adapter Unification"
date: 2026-04-28
tags: [solution, agent-loop, orchestration, codex, claude]
related_instincts: []
aliases: ["agent-loop Claude Codex 一致性", "Windows provider shim 适配"]
---

# Agent Loop v6 Provider Adapter Unification

## Problem

`/agent-loop` 在 Claude Code 与 `$agent-loop` 在 Codex 中虽然指向同一流程，但实际运行会因为 Windows npm shim、stdin/argv、structured output schema、JSON wrapper 和 review 字段差异而分叉。

## Root Cause

旧版 orchestrator 把 provider 命令名、进程启动、prompt 传输、JSON 解析、review 状态判定、diff 上下文和 validation 事实揉在单流程里，状态机直接消费 provider 原始输出。

## Solution

把差异吸收到 `agent-orchestrator.js` 内部：

- ProviderLaunchResolver 自动解析 `claude.cmd` 与 `codex.cmd`。
- spec/review 通过 `claude -p --input-format text` 从 stdin 读 prompt。
- implementation 通过 `codex exec -` 从 stdin 读 prompt。
- StructuredOutputCodec 支持 wrapper、fenced JSON、content array 与 balanced JSON。
- ContractNormalizer 将 spec / handoff / review 归一化后再驱动状态机。
- DiffManager 产出 `changed-files.json` 与截断安全 `review-context.md`。
- ValidationRunner 让 `--validation-command` 可重复传入，并由 orchestrator 写入验收事实。
- `doctor` 与 `self-test` 分别覆盖本机预检和 codec/normalizer/schema 最小回归。

## Prevention

Claude Code command 与 Codex skill 只允许作为薄入口，必须调用同一个 orchestrator。新增 provider 字段、schema 或状态时，先更新 normalizer 与 `self-test`，再更新入口文档。

## Related

- [[agent-loop-v6-root-architecture]] — 根因复盘与架构调整
- [[ADR-004]] — Provider 适配层内建在 Orchestrator
