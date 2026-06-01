---
title: "Claude Code Dynamic workflows 接入 tech-persistence：backend seam 优先，不替换 sprint 方法论"
date: 2026-06-01
tags: [solution, architecture, claude-code, dynamic-workflows, agent-loop, parity]
related_instincts:
  - native-agent-workflow-is-backend-not-methodology
  - runtime-resume-is-not-durable-state
  - claude-only-feature-needs-backend-fallback-for-parity
related_solutions:
  - "[[2026-05-29-sprint-goal-mode]]"
  - "[[2026-05-12-agent-loop-followup-fixes]]"
aliases: ["Claude workflow architecture", "Dynamic workflows backend seam", "workflow mode"]
status: completed
---

# Claude Code Dynamic workflows 接入 tech-persistence

## Problem

Claude Code 在 2026-05-25 到 2026-05-29 发布 Dynamic workflows research preview：Claude 可以为任务写 JavaScript orchestration script，并在后台协调大量 subagents。用户问当前 tech-persistence 架构是否有优化空间。

风险在于名字都叫 workflow：本项目已有 `/sprint` 工作流方法论、`/work [P]` worker spawn、`/review` reviewer spawn、`agent-loop --pipeline` 手写分片流水线。若直接把 Claude workflow 当成顶层替代，会把“执行后端能力”和“工程方法论协议”混在一起，破坏轻量性与 multi-runtime parity。

## Root Cause

官方文档的 load-bearing 事实：

- Dynamic workflows 适合 codebase-wide audit、大迁移、cross-checked research、多角度计划评审；本质是让 script 持有 loop/branch/intermediate results，主上下文只接收最终报告。
- workflow 没有 mid-run user input；需要阶段性 sign-off 时应拆成多个 workflow。
- workflow script 本身无直接 fs/shell access，读写和命令由 agents 执行。
- workflow 有同 session pause/resume，但退出 Claude Code 后下次会 fresh start；这不是 durable orchestrator state。
- workflow subagents 继承 allowlist，文件编辑自动批准；shell/web/MCP 等仍可能在 mid-run prompt。
- 并发和总 agent 数有上限，成本会显著放大。

当前 tech-persistence 的关键事实：

- `/sprint` 是 model-driven markdown protocol，无宿主进程；它表达方法论，不是 runtime。
- `agent-loop classic/pipeline` 已经是外部 orchestrator，有 `.agent-runs` durable artifacts、provider 边界、freeze/resume/review 状态。
- `agent-loop --pipeline` 已有 global contract / slices / queue / locks / drift / reconciliation，像手写版 workflow runtime；`ownedFiles` changed-files gate 与状态写入口收口已落地，但仍有 single worker、review/validation transaction boundary 等债。

## Solution

### 决策

**把 Claude Dynamic workflows 作为 `agent-loop` 的可选 backend seam，而不是替换 `/sprint`、`/work` 或 `/review` 的顶层协议。**

推荐抽象：

```text
agent-loop orchestration intent
  -> backendKind: classic-provider | local-pipeline | native-claude-workflow
  -> durable source of truth: .agent-runs/<runId>
```

### 分层规则

| 场景 | 推荐机制 |
|------|---------|
| 少量明确 task | 现有 `/work [P]` 或串行 work |
| 普通 diff review | 现有 `/review` risk-aware dispatch |
| 全仓审计 / 大迁移 / cross-checked research | native workflow backend（可用时） |
| 需要人工 freeze / sign-off | 多个 workflow stage + `.agent-runs` artifact gate，不塞入单个 workflow |
| 跨 Claude/Codex provider spec/impl/review | `agent-loop` classic/pipeline；workflow 只能作为 Claude 侧 backend |

### 后续实施顺序

1. **pipeline hardening 已完成本轮 8/8**：沿用既有 `docs/plans/2026-05-12-pipeline-hardening-roadmap.md`，不另起平行清单。代码现实（2026-06-01 核验）：状态写入口已收口到 `pipeline-state.js` transition helper、实现失败侧 `blockFailedSlice` 已落地、`ownedFiles` changed-files gate 已落地（provider 前后快照 + `changed-files-gate.json`）、Codex projection provenance 与 `docs/plans` source-of-truth resolver 已落地，验证矩阵覆盖 root/plugin self-test、preflight、pipeline dry-run、plugin/install validators 与 diff check。permission/cost budget 属前瞻需求（Claude workflow runtime 已自带 `budget`），随 backend seam 落地，非独立前置。
2. **再加 backend seam**：`backendKind`、`phasePlan`、`agentBudget`、`permissionProfile`、`resumeSemantics`。
3. **最后试 native workflow adapter**：只在 Claude Code v2.1.154+ 且任务匹配“大规模可脚本化编排”时启用；其他 runtime 走 local-pipeline fallback。

## Decision Record

这延续 [[ADR-021]]：model-driven `/sprint` 没有宿主进程，不应把确定性和大规模编排硬塞进 sprint prose。Claude Dynamic workflows 提供的是“有 runtime 的 script orchestration”，因此它应进入已有的外部 orchestrator 层，也就是 `agent-loop`。

同时延续 [[ADR-011]] multi-runtime parity：Claude-only 能力必须有 fallback backend，不能让 Codex 路径只靠一句“不支持”退化。

## Verification

- 官方 docs 对照：Week 22 发布页、Dynamic workflows 页面、Agents 对比页。
- 本仓库对照：`README.md` 架构总览、`docs/architecture/agent-loop-pipeline-architecture.md`、`docs/plans/2026-05-29-sprint-goal-mode.md`、`user-level/commands/work.md`、`user-level/commands/review.md`。
- 文档变更验证：`node scripts/sync-solution-index.js --all`；`git diff --check`。

## Prevention / 泛化

- 新 agentic runtime 能力先归类：**方法论协议 / 执行后端 / 编排原语 / 观察工具**。归类前不改顶层命令。
- runtime resume 不是 durable state。任何多 agent run 的最终 SoT 必须落 repo artifact 或 `.agent-runs`。
- Claude-only feature 进入 tech-persistence 必须先设计 fallback backend，否则违反 multi-runtime parity。
- workflow 适合大规模 cross-check 和迁移；2~5 个 worker/reviewer 继续用现有 spawn 协议，避免 research-preview 功能过度下沉。
