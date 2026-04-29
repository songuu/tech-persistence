---
title: "Agent Loop 恢复流与 Provider 输出归一化"
date: 2026-04-29
tags: [solution, agent-loop, orchestrator, windows]
related_instincts: []
aliases: ["blocked resume", "summary approved", "plan.tasks"]
---

# Agent Loop 恢复流与 Provider 输出归一化

## Problem

`agent-loop` 在真实运行中出现多处需要人工介入的问题：Spec 输出 `plan.tasks` / `taskBreakdown.tasks` 无法解析、review 输出 `summary: "APPROVED"` 仍被判为 `needs-followup`、`blocked` 状态无法 resume、Windows Codex sandbox 写入失败、Claude Code 缺少 Git Bash、非 Git 目录 preflight 无法显式跳过，以及 provider 日志或长耗时 run 不好追踪。

## Root Cause

编排器把 provider 原始输出、运行环境差异和状态流转耦合在一起。状态机直接依赖单一字段形态，resume 只覆盖理想状态，Windows sandbox 和日志策略也依赖用户手动传参或固定文件名。

## Solution

修复方向是把 provider 输出与状态机解耦：

- `normalizeSpec()` 支持 `plan.tasks`、`plan.design`、`plan.requirements` 等 alias。
- `normalizeSpec()` 继续兼容 `taskBreakdown.tasks`、`taskBreakdown.items` 等嵌套输出，但写出的 canonical `spec.json` 仍保持扁平数组。
- `normalizeReview()` 支持 `summary: "APPROVED"`，并让 P0/blocked finding 优先于 approved 信号。
- `runResume()` 支持从 `blocked` 重新进入 implementation。
- `needs-followup` / `blocked` 作为同一 run 的 continuation，允许在已有实现 diff 上继续。
- Windows 下 Codex 未显式指定时默认 `--sandbox workspace-write`，`doctor` 输出 `codexSandbox` 生效策略。
- Windows 下自动检测并注入 `CLAUDE_CODE_GIT_BASH_PATH`，`doctor` 输出 `claudeGitBash` 检查项。
- `--skip-git-repo-check` 会让非 Git 目录通过 preflight，但保持 no-diff marker，默认仍要求 Git。
- provider timeout 支持 `--provider-timeout-minutes` / `--provider-timeout-ms` 并写入 `providerRuns[]`。
- provider stdout/stderr/last-message 日志使用时间戳，历史 run 通过 `state.providerRuns[]` 追溯。

主要落地文件：

- `scripts/agent-orchestrator.js`
- `plugins/tech-persistence/scripts/agent-orchestrator.js`
- `docs/architecture/ARCHITECTURE_ISSUES.md`
- `docs/architecture/ISSUES.md`
- `.codex/rules/architecture.md`

## Prevention

- 状态机只消费 canonical spec/handoff/review，不直接消费 provider 原始字段。
- 所有 provider 新输出形态必须先补 normalizer 和 `self-test`。
- Windows provider/sandbox 行为必须进入 `doctor`，不能藏在文档里的手动参数。
- preflight 对可降级场景必须要求显式 flag，避免静默牺牲 review 质量。
- 多次 resume 的 artifact 必须可追溯，不用固定日志文件名承载历史。

## Related

- [[2026-04-29-agent-loop-architecture-issues]]
- [[ARCHITECTURE_ISSUES]]
- [[ISSUES]]
