---
title: "Claude Code dynamic workflows 对当前架构的优化评估"
type: sprint
status: completed
created: "2026-06-01"
updated: "2026-06-01"
tasks_total: 4
tasks_completed: 4
tags: [sprint, architecture, claude-code, workflow, agent-loop]
aliases: ["dynamic workflows architecture review", "workflow mode architecture"]
invariants:
  - "多运行时 parity 优先：新能力不能把 Codex 路径变成二等公民，必须有 native-workflow 与 fallback 两层语义"
  - "确定性优先：Claude Code workflow 只能作为执行后端，长期 source of truth 仍应落在 repo artifact / .agent-runs"
  - "轻量优先：未证高频前不新增 workflow runtime adapter 代码，先以文档化决策和后续任务收口"
invariant_tests:
  - "node scripts/sync-solution-index.js --all"
  - "git diff --check"
deferred:
  - sprint: "follow-up"
    item: "agent-loop 增加 workflow backend capability seam：native Claude workflow 可用时使用，其他运行时走现有 pipeline fallback"
    deadline: "2026-08-29"
    reason: "当前需求是架构评估；直接接 runtime adapter 会同时触及 provider/permission/artifact/parallel merge，属于 L3+ 实施 sprint"
  - sprint: "follow-up"
    item: "agent-loop pipeline hardening：沿用既有 docs/plans/2026-05-12-pipeline-hardening-roadmap.md（completed, 8/8）。后续可选深化项为 review/validation 侧 transaction boundary、shared-contract exception 与 native workflow backend seam"
    deadline: "2026-08-29"
    reason: "接 native workflow 前的共同前置，但已有 in-progress roadmap 在 track；本 plan 只引用不重列，避免 doc-vs-doc drift（本仓 #1 回归源）"
---

# Claude Code dynamic workflows 对当前架构的优化评估

> **Status:** `completed`
> **Created:** 2026-06-01
> **Updated:** 2026-06-01

---

## 需求分析

### 要做
- 研究 Claude Code 2026-05-25 到 2026-05-29 发布的 Dynamic workflows research preview。
- 对照 Tech Persistence 当前 `/sprint`、`/work`、`/review`、`agent-loop --pipeline` 架构，判断是否有优化空间。
- 给出不追新、不膨胀、可落地的优化路线。

### 不做
- 不直接改 `scripts/agent-orchestrator.js` 或 pipeline 模块。
- 不把 `/sprint` 全面替换成 Claude Code workflow。
- 不新增 `.claude/workflows/` 可执行脚本；未证高频前先保持文档级决策。

### 成功标准
- [x] 明确 Claude Code Dynamic workflows 的能力边界和限制。
- [x] 明确当前架构哪些层应该吸收 workflow，哪些层不该动。
- [x] 输出优先级排序的优化建议。
- [x] 产出可复用 solution 文档并同步 solution index。

### 风险和假设

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际发现 | 可信度 |
|------|---------|---------|--------|
| Claude Code 最近的 workflow mode 是官方功能而非社区猜测 | Web 查官方 docs `What's New Week 22` 与 `Dynamic workflows` 页面 | 官方称 2026-05-25~29 发布 Dynamic workflows research preview；v2.1.154+，workflow 是 Claude 写的 JavaScript orchestration script，在后台协调多 subagents | 高 |
| workflow 适合替代所有现有 spawn 协议 | Read 官方 workflows / agents 对比页面 | 不成立。官方定位是 codebase-wide audit、大迁移、cross-checked research、dozens/hundreds agents；少量 side task 仍适合 subagents，独立任务适合 agent view | 高 |
| workflow 可作为 durable orchestrator source of truth | Read 官方 workflow limits | 不成立。workflow 可在同一 session 暂停/恢复；退出 Claude Code 后下次会 fresh start。长期 SoT 仍需 `.agent-runs` / markdown artifacts | 高 |
| 当前 agent-loop pipeline 已具备 workflow-like 骨架 | Read `docs/architecture/agent-loop-pipeline-architecture.md`、`scripts/agent-orchestrator/*` | 成立。已有 global contract / slices / queue / locks / drift / reconciliation；`ownedFiles` changed-files gate 与状态写入口收口已落地，但仍是 single worker，且有 review/validation transaction boundary 债务 | 高 |
| `/sprint --goal` 的 `--runtime both` deferred 可由 workflow 承接 | Read `docs/plans/2026-05-29-sprint-goal-mode.md` 与官方 workflow docs | 部分成立。workflow 可承接“大量 subagent 编排”，但不能跨 Codex provider，也不能替代 goal-budget/durable state；更适合作为 agent-loop backend 的一支 | 中高 |

---

## 技术方案

### 方案概述

结论：**有优化空间，但不应该把 Claude Dynamic workflows 直接塞进 `/sprint`。** 当前架构最该吸收的是它的核心原则：把大规模 loop / branch / cross-check 从模型上下文移到脚本/runtime；但吸收点应是 `agent-loop` 的 backend seam，而不是 `sprint` 的 phase 协议。

当前系统已经有三层编排：

| 当前层 | 现状 | 是否适合 workflow 化 | 判断 |
|--------|------|----------------------|------|
| `/sprint` | model-driven markdown protocol，负责 think→plan→work→review→compound | 不适合直接替换 | 它是用户工作流协议，不是执行 runtime；保持轻量和可解释 |
| `/work [P]` | 少量 worker spawn + worktree isolation | 暂不替换 | 官方建议少量 side task 用 subagents；workflow 对 2~5 个 worker 太重 |
| `/review` | risk-aware reviewer spawn + revise loop | 条件替换 | 普通 diff 继续 spawn；codebase-wide audit / adversarial cross-check 可走 workflow |
| `agent-loop classic` | 外部 orchestrator，spec→impl→review | 可增加 backend seam | 它已有 provider 边界和 artifacts，最适合接 native workflow |
| `agent-loop --pipeline` | 手写 global contract / slice queue / locks / drift | 最该先加固 | 这是本项目的 workflow-like runtime；先收债再接 native |

### Claude Dynamic workflows 的 load-bearing 事实

官方文档给出的关键边界：

- workflow 是 Claude 为任务写出的 JavaScript orchestration script，由 runtime 后台执行，并协调大量 subagents。
- 适用场景是 codebase-wide audit、500-file migration、cross-checked research、多角度计划评审。
- workflow 的价值不只是更多 agents，而是把 loop / branching / intermediate results 放到 script variables，主上下文只拿最终结果。
- workflow launch 有权限提示；auto / ultracode 下提示策略不同。workflow 内 subagents 继承 allowlist，文件编辑自动批准。
- workflow script 本身没有直接 fs/shell access；读写和命令由 agents 做。
- 没有 mid-run user input；需要阶段性 sign-off 时，应拆成多个 workflow。
- 并发上限约 16 agents，总 agent 上限 1000。
- pause/resume 仅在同一 Claude Code session 内可靠，退出后下次 fresh start。

### 推荐架构

#### A. 增加 “workflow backend capability seam”，但先只设计不实现

目标不是新增一套 `/workflow` 命令，而是在 `agent-loop` 内部抽象：

```text
agent-loop orchestration intent
  -> backend: native-workflow | local-pipeline | classic-provider
  -> artifacts: .agent-runs/<runId> remains source of truth
```

最低语义：

| 字段 | 作用 |
|------|------|
| `backendKind` | `classic-provider` / `local-pipeline` / `native-claude-workflow` |
| `phasePlan` | workflow planned phases 或 pipeline slices 的共同投影 |
| `agentBudget` | max concurrent agents、total agent cap、模型/成本预算 |
| `permissionProfile` | allowlist / edit policy / shell/MCP prompts 的显式声明 |
| `resumeSemantics` | same-session resume vs durable artifact resume |

这个 seam 可以让 Claude Code 新 workflow 成为 backend，而不是成为新的顶层方法论。

#### B. 先加固现有 pipeline，再谈 native workflow adapter

> **勘误（2026-06-01 meta-review，按代码现实核验）**：本节债务清单原稿过宽，已按 `scripts/agent-orchestrator/` 实际状态收窄，并统一交由既有 `docs/plans/2026-05-12-pipeline-hardening-roadmap.md`（in-progress, 5/8 完成）追踪，不在此另起平行清单。

接 native workflow 前，现有 pipeline 的债务优先级更高：

1. **状态写入口收口（已落地）**：`pipeline-state.js` 已提供 `transitionRun()` / `transitionSlice()` 统一入口，`pipeline.js` 与 `pipeline-providers.js` 的 run/slice 状态推进已收口，transition event 记录 `from` / `to` / `reason` / `actor` / `source`。
2. **`ownedFiles` diff gate（已落地）**：slice implementation provider 前后会快照 changed files 并做文件指纹比较，touched files 必须落在 `ownedFiles` 或 `generated` / `managed` exception 内；结果写入 `changed-files-gate.json` 并进入 review prompt。架构文档 §13.3 已更新。
3. **slice transaction boundary（仅 review/validation 侧）**：实现失败侧已落地——`blockFailedSlice`（`pipeline.js:120`）含 `releaseSliceLocks` + 转移到 `IMPLEMENTATION_FAILED`，调用点 `pipeline.js:576/583`。仍缺的是 review / validation 失败的等价 failure artifact、lock release/retain 与 retry 状态。
4. **permission / cost budget artifact（前瞻需求，非既有债务）**：架构文档 §13 限制清单未登记此项，属本 plan 为 backend seam 引入的前瞻需求；且 Claude workflow runtime 已自带 `budget` 对象与并发上限。降级为"随 backend seam 一起做"，不作为独立前置阻塞。

第 1~3 条是 pipeline 自身债务（与 Claude workflow 无关），由上述 in-progress roadmap 推进；第 4 条随 seam 落地。

#### C. 更新触发策略：把 workflow 用在“大规模可脚本化编排”

建议加入一条路由规则：

| 场景 | 推荐机制 |
|------|---------|
| 1~5 个明确小任务 | 现有 `/work [P]` 或串行 work |
| 普通 diff review | 现有 `/review` risk-aware dispatch |
| 全仓审计 / 大迁移 / 多角度 cross-check research | workflow backend |
| 需要人工 freeze / sign-off 的跨阶段任务 | 多个 workflow + agent-loop artifacts，不塞进单个 workflow |
| 需要跨 Claude/Codex provider 的 spec/impl/review | agent-loop classic/pipeline，workflow 只能作为 Claude 侧辅助 backend |

#### D. 不把 workflow 当 durable state machine

Claude workflow 的 same-session resume 很有价值，但不等价于 `agent-loop` 的 durable `.agent-runs`。因此：

- workflow run 的脚本、phase result、agent summaries 要被拉回 `.agent-runs/<runId>/workflow/` 做审计。
- `.agent-runs/state.json` 仍是跨会话恢复 SoT。
- 退出会话后 workflow fresh start 的限制必须反映在 `resumeSemantics` 中。

### 任务拆解

- [x] **Task 1**: 官方功能勘察和边界提取 — 文件: `docs/plans/2026-06-01-claude-code-workflow-architecture.md` — 风险: L1
- [x] **Task 2**: 对照当前 `/sprint` / `/work` / `/review` / `agent-loop --pipeline` 分层 — 文件: `docs/plans/2026-06-01-claude-code-workflow-architecture.md` — 风险: L1
- [x] **Task 3**: 产出推荐架构和后续任务 — 文件: `docs/plans/2026-06-01-claude-code-workflow-architecture.md` — 风险: L1
- [x] **Task 4**: 写 solution 并同步索引 — 文件: `docs/solutions/2026-06-01-claude-code-dynamic-workflows-architecture.md` — 风险: L1

### 测试策略

- 代码未改，免单元测试。
- 文档类 L1：运行 solution index sync，检查 markdown diff。
- 手动验证：对照官方 docs 和本仓库架构文档，确认 recommendation 没把 research-preview runtime 误当成 durable orchestrator。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 追新导致抽象层膨胀 | 中 | 高 | workflow 只作为 agent-loop backend seam，不做顶层方法论 |
| 误把 same-session resume 当 durable resume | 中 | 高 | `.agent-runs` 保持 SoT，workflow result 必须落盘 |
| Claude-only workflow 破坏 Codex parity | 高 | 高 | native workflow 只是 backendKind 一支，其他 runtime 走 local-pipeline fallback |
| 权限语义变弱 | 中 | 高 | permissionProfile 显式记录 allowlist、edit auto-approve、mid-run prompt 风险 |
| token/cost 失控 | 中 | 中 | agentBudget 强制声明 max concurrent / total agents / model tier |

### 涉及文件

- `docs/plans/2026-06-01-claude-code-workflow-architecture.md`
- `docs/solutions/2026-06-01-claude-code-dynamic-workflows-architecture.md`
- `docs/solutions/index.jsonl`
- `CLAUDE.md`
- `AGENTS.md`

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-06-01 | T1 | 勘察官方 Week 22 / Dynamic workflows / Agents 对比文档，提取 workflow 的适用场景、运行时限制、权限和 resume 语义 |
| 2026-06-01 | T2 | 对照当前 `/sprint`、`/work [P]`、`/review`、`agent-loop classic/pipeline`，判断 workflow 应作为 backend seam 而非替代 phase 协议 |
| 2026-06-01 | T3 | 定义后续优化路线：workflow backend capability seam、pipeline hardening、workflow 触发策略、durable artifact policy |
| 2026-06-01 | T4 | 新增 solution 文档并同步 solution index 到 `CLAUDE.md` / `AGENTS.md` |
| 2026-06-01 | meta-review | 按代码现实核验 §B 债务清单：收窄 #1（reducer `transitionSlice` 已存在，债务是 provider 直写绕过）/ #3（实现失败侧 `blockFailedSlice` 已落地，仅 review/validation 侧待补）；#4 cost/budget 降级为前瞻（runtime 已内置 budget）；deferred #2 改为引用既有 in-progress roadmap（3/8），消 doc-vs-doc drift。核心结论不变 |
| 2026-06-01 | execution | 按 follow-up 直接执行 roadmap Task 4：`ownedFiles` changed-files gate 已落地，roadmap 进度更新为 4/8；剩余 pipeline 前置重点转为 Task 5 状态写入口收口与 review/validation transaction boundary |
| 2026-06-01 | execution | 继续执行 roadmap Task 5：状态写入口收口已落地，provider/pipeline 状态推进统一走 `pipeline-state.js` transition helper，roadmap 进度更新为 5/8 |
| 2026-06-01 | execution | 继续执行 roadmap Task 6：Codex projection provider provenance 已通过 build 脚本保留并由 plugin validator 检查，roadmap 进度更新为 6/8 |
| 2026-06-01 | execution | 继续执行 roadmap Task 7：`docs/plans` source-of-truth resolver、prototype sourceType 注入、测试与 plugin projection validator 已落地，roadmap 进度更新为 7/8 |
| 2026-06-01 | execution | 执行 roadmap Task 8：root/plugin self-test、preflight、pipeline dry-run、plugin/install validators、上下文注入测试、`git diff --check` 已通过，roadmap 完成 8/8 |

---

## 审查结果

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| — | — | — | 无 | — |

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| — | — | — | 无 | — |

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | architecture | `agent-loop --pipeline` | native workflow 前置的状态唯一写入口、`ownedFiles` diff gate、projection provenance、plans source-of-truth 与验证矩阵已落地；后续关注 review/validation transaction boundary 深化、shared-contract exception 与多 worker isolated worktree | 完成本轮 hardening，深化项记录 follow-up |
| 2 | parity | Claude workflow | native workflow 是 Claude Code 能力，Codex 不能直接等价执行；需要 backendKind + fallback 明确语义 | 记录 follow-up |

### 总评

结论可靠：Claude Dynamic workflows 是值得吸收的执行层能力，但当前最优路径是 **agent-loop backend seam + pipeline hardening**，不是把 `/sprint` 或现有 reviewer/worker spawn 全部替换成 workflow。

---

## 复利记录

### 提取的经验
- 新 agentic runtime 能力先归类到“执行后端 / 编排原语 / 方法论协议”哪一层，再决定接入点；不要因为名字叫 workflow 就替换项目的 workflow 方法论。
- 大规模 subagent 编排的 SoT 必须落 repo artifact；same-session runtime resume 不能替代跨会话 durable resume。
- Claude-only 能力进入多运行时项目时，必须先设计 fallback backend，而不是把 parity 问题留给文档解释。

### 创建/更新的本能
- `native-agent-workflow-is-backend-not-methodology`
- `runtime-resume-is-not-durable-state`
- `claude-only-feature-needs-backend-fallback-for-parity`

### 解决方案文档
- `docs/solutions/2026-06-01-claude-code-dynamic-workflows-architecture.md`
