---
title: "Sibling-eval：Claude /goal × Codex /goal 原生命令 vs TP /sprint --goal（收窄到原生 goal 原语）"
date: "2026-06-17"
tags: [solution, sibling-eval, goal-mode, claude-code, codex]
related_instincts:
  - feedback_reverify_sibling_before_single_runtime_assertion
  - feedback_sibling_eval_convergent_evolution_high_value
  - model_driven_loop_determinism_ceiling
  - documented-claim-vs-code-reality-drift
related_solutions:
  - "[[2026-05-29-sprint-goal-mode]]"
  - "[[2026-06-08-plan-mode-comparison]]"
  - "[[2026-06-01-claude-code-dynamic-workflows-architecture]]"
aliases: ["native goal sibling-eval", "claude goal vs codex goal", "/goal 对比", "goal 原语对比"]
status: completed
---

# Sibling-eval：Claude /goal × Codex /goal 原生命令 vs TP /sprint --goal

## Problem

用户问"结合 Claude Code 自带的 `/goal` 和 Codex 自带的 `/goal`，TP 当前架构的 `/sprint --goal` 需要改进哪里"。作用域严格收窄到**两个 runtime 各自的原生 `/goal` 命令本身**，排除 Claude Dynamic Workflows / `/loop` / cron / Routines / fan-out（那些不是 `/goal`）。对比对象是 TP `/sprint --goal`（纯 markdown 协议 MVP，无宿主进程，[[ADR-021]]）。结论先行：收窄到原生 `/goal` 后 sprint **几乎不用改**——三方在终止哲学/完成判定/续跑机制上**独立收敛**，[[ADR-021]] 三方全印证、零承重事实被推翻；唯一真借鉴点只有一条（judge≠worker 完成判定），且因 `--goal` 零使用证据进 backlog 不本轮落；最高 ROI 是修正一处**临时分析层 drift**（"Codex 无对等 Stop hook" —— 一手源码证伪，但该 drift 从未写进 committed 文档）。

## Root Cause

三者都叫 "goal"，但分属不同层，混为一谈会推出错误的"借鉴/替换"结论。先各自落实 load-bearing 事实，标注 repo-verified vs external（一手源码 / 官方文档 / 二手）。

### 三方原生对比（全部一手核实：openai/codex 仓库源码 + code.claude.com/docs/en/goal）

| 维度 | Claude `/goal`（v2.1.139, GA） | Codex `/goal`（0.128+，现 0.140） | TP `/sprint --goal` |
|---|---|---|---|
| 核心原语 | session 级 **prompt-based Stop-hook 封装**（一 session 一 active goal，`/clear` 即清） | **5 层 Rust runtime**：SQLite goals DB + app-server JSON-RPC `thread/goal/*` + 模型 3 工具 + `core/goals.rs` 事件总线 + TUI | 纯 **markdown 协议**，0 backing code，与 `--auto`/`--caveman` 同构（[[ADR-021]]） |
| 循环发动机 | host harness 每 turn 边界触发 Stop hook → evaluator no → reason 作下一 turn 指引续跑（真 turn-boundary 触发点） | Rust core 进程内事件总线 `MaybeContinueIfIdle` 自动续跑（真进程循环，对标 `scripts/agent-orchestrator/pipeline.js:472` 的 Node `for` 循环） | 模型读 markdown **自选重入** think→plan→work→review→compound（边界=Phase5 Compound 中段，**非 turn 边界**）；host 看不到"一个 sprint-iteration 刚结束" |
| 达成判定 | **独立 small-fast-model evaluator**（默认 Haiku，可配；judge≠worker），只读已 surface 的 transcript，不跑工具/读文件 | 模型自报 `update_goal{status:complete}`；`continuation.md` Completion audit **逐字禁止仅凭 tests/green checks/manifests/proxy 判完成**，要求逐 requirement 核证 | LLM 自评仅 **advisory**（judge==worker，主循环模型自评自己）；第 6 视角 goal-drift（`user-level/commands/sprint.md`）跑 Phase4 判 scope-drift 非 goal-completion ← **TP 唯一真缺口** |
| 终止控制 | 纯 evaluator 语义 yes/no，**无 token/cost budget**（要 bound 须在 condition 写软子句，由 evaluator 语义判） | **token_budget + SQL 原子记账**：`status_after_budget_limit()` 在 DB 层派生 `budget_limited` terminal 态 + 注入 `budget_limit.md` steering 优雅收尾（系统控，非模型控）；Semaphore 串行化记账防 race | 确定性天花板：`--until` exit0 / `iteration>=max-iter` 硬停（默认 3）+ frontmatter `goal_iteration` 持久 + 每轮强制重读磁盘 + 强制打印 check 行；LLM 自评只能提前停、不能越天花板 |
| 宿主进程 | 有（Stop-hook turn-boundary 挂点；另有 CLI 级 Stop hook 子系统 `decision:block` 续跑） | 有（Rust core 事件总线 + SQLite + 独立 CLI Stop hook 子系统） | **无**（`/sprint` markdown 协议层无自有 Node 宿主循环——区别于 agent-loop 的 `pipeline.js:472` 真 `for` 循环）。这是 [[ADR-021]] 的 runtime-agnostic 结构事实 |
| 持久性 | goal 随 session；resume(`--resume`/`--continue`) 恢复 condition，但 turn count/timer/token baseline **全部 reset**；已 achieved/cleared 不恢复 | SQLite 跨会话 durable（`goal_id` UUID 版本化防 stale 记账 race）；`ThreadResumed`→reactivate、`TaskAborted(Interrupted)`→paused | frontmatter `goal_iteration` 标量持久（Obsidian 兼容），每轮重读磁盘不信 `/compact` 后对话记忆；生命周期=单 sprint 文档（non-scope 明确不做跨会话常驻 goal daemon） |
| 非交互可靠 | `claude -p` headless 单次跑到完成可靠；Ctrl+C 早停；evaluation tokens 计在 small fast model 上 typically negligible | goal 工具暴露门 = `persistent_thread_state_available && !Review-子代理`（`ext/goal/src/extension.rs:105`），**与 interactive/exec 无关**；`codex exec --enable goals` 在持久 thread state 可用时即暴露 3 工具。残余不可靠=语义层"模型须自愿 `update_goal` 才算 complete"（交互/非交互同构） | 非交互靠确定性天花板兜底（`--until` exit0 / max-iter 硬停 + 强制打印 check 行可见性），不依赖模型自愿；`--goal` 单用不开自主，自主须显式 `--goal --auto` |

## Solution

### 收敛进化（自家方向被双 runtime 外部验证，高价值产出，[[feedback_sibling_eval_convergent_evolution_high_value]]）

三方各自独立造出同一批机制，说明 TP 设计方向正确，**无需借鉴、写进结论**：

1. **确定性终止天花板**：Codex 用 token_budget + SQL 原子记账，TP 独立用 iteration/exit（max-iter + `--until` exit0）。双方各自造出"执行者不能拍板终止、由执行者之外的确定性机制控天花板"，只是计量维度不同（token vs iteration/exit code）。TP 选 iteration/exit 是对无宿主进程协议的正确适配（token 累计无法纯协议可靠记；iteration 可 frontmatter 持久 + Obsidian 兼容）。
2. **反-proxy 完成纪律**：Codex `continuation.md` Completion audit 逐字禁止仅凭 tests/green checks/manifests/search 等 proxy 判完成、要求逐 requirement 核证；TP 独立用 advisory-only 自评 + 强制打印 check 行使跳过在 transcript 可见。双方独立造出"别假装完成 / 完成证据要可见可核"的同形纪律。
3. **"执行者只能 start+self-complete、终止决定权外置"非对称**：Claude（worker 跑 / 独立 evaluator 判 / 系统清 goal）、Codex（模型只 create+self-complete / core runtime 控续跑预算终止）、TP（LLM 自评 advisory / `--until`·max-iter 硬停 / 人工 gate 天花板）——三方独立收敛到同一非对称形状。
4. **host-process 级续跑机制位于各自原语之下**：Claude = Stop-hook turn-boundary 封装；Codex = core 事件总线 + 独立 CLI Stop hook（`decision:block` 把 reason 注入为新 user prompt，带 `stop_hook_active` loop-guard，与 Claude Stop hook 几乎逐字同构）。`codex-rs/core/src/tools/hook_names.rs` 甚至有 `Write`/`Edit`/`Agent` matcher alias 显式注释兼容 "Claude Code-style names" —— **两 runtime 的 hook 子系统本身就是收敛进化铁证**。TP 二者皆无，正向印证"无宿主进程→纯协议确定性上限"方向。

### 两条一手源码修正（本次最大产出）

**修正 1 —— Codex 确有 `decision:block` 强制续跑的 Stop hook（上轮临时综合层断言被证伪）**

上一轮分析的临时综合层曾断言"Codex 无对等 Stop-hook 续跑"。本轮直接读 openai/codex 仓库源码定论——**第三方博客对、综合层错**：

- `codex-rs/app-server-protocol/schema/typescript/v2/HookEventName.ts` 枚举含 `stop` 与 `subagentStop`；
- `codex-rs/core/src/hook_runtime.rs` 的 `run_turn_stop_hooks`（root turn 跑 Stop / child turn 跑 SubagentStop）+ `stop_hook_active` loop-guard（与 Claude 同构）；
- `codex-rs/hooks/src/events/stop.rs` 的 `StopOutcome{ should_stop, stop_reason, should_block, block_reason, continuation_fragments }`，parser 显式处理两条等价续跑触发：(a) JSON `decision:block`→`continuation_prompt`，(b) exit code 2 + stderr 写 reason。

> ⚠️ **防勘误过头的关键澄清**：Codex 的 Stop hook 是 **CLI 级 hook 子系统**（与 Claude 的 Stop hook 同层），**不是 `/goal` 命令本身**——Codex `/goal` 的续跑由 core runtime 事件总线驱动，与 Stop hook 正交。结论不变：两 runtime 都在其 `/goal` 原语之下有 host-process 续跑机制，TP `/sprint` 二者皆无，故不能复制是 **runtime-agnostic 的结构原因**（与"哪个 runtime 有没有 hook"无关）。
>
> 这条 drift 的来源与处置：它**只活在上一轮 workflow 的临时综合层，从未写进任何 committed TP 文档**。经核实 [[ADR-021]] 与 [[2026-05-29-sprint-goal-mode]] 原文均**干净**——只说 `/sprint` 自身"无宿主进程 / 无 hookable per-iteration 事件"（关于 sprint 循环边界，为真），从未断言"Codex 无 Stop hook"。故**无 committed 文本需要勘误**；记录此条是为 anti-rediscovery + 印证 [[feedback_reverify_sibling_before_single_runtime_assertion]]（排他 runtime 断言落笔前必复查 sibling，Claude↔Codex hook 子系统收敛进化频繁）。

**修正 2 —— "Codex 非交互 goal 必然不可靠"太强（影响早期 `--runtime both` 阻塞理由表述）**

一手读 `codex-rs/ext/goal/src/extension.rs:105`：goal 工具暴露门 = `persistent_thread_state_available && !Review-子代理`，**与 interactive/exec 无关**。issue #24094（state=open）经维护者判为 **0.132→0.133 stale daemon 一次性迁移问题**、非架构缺陷，承诺 forward-compat。故"codex exec 必然 model-mediated 不可靠"过强——设计上不排除 exec，**残余不可靠只在"模型须自愿 `update_goal` 才算 complete"的语义层**（交互/非交互同构）。

> ⚠️ 但**未端到端实测**，issue 仍 open——只能写"设计上不排除 exec"，不可写"codex exec goal 已可靠"（见下方未决事实）。状态机已从 4 态扩为 6 态（`active|paused|blocked|usageLimited|budgetLimited|complete`，`ThreadGoalStatus.ts`）；migration 0034 `DROP TABLE thread_goals`（commit ba57aab，#23300，迁独立 goal DB）正是上轮"schema 会变 + 数据丢失 issue"的根因。

### [[ADR-021]] 状态：经一手核实未被任何原生 `/goal` 机制推翻，三方全印证

承重事实复核：(1) `/sprint` 无宿主进程；(2) 无可挂的 **sprint-iteration** 触发点。逐个对抗：

- **Claude `/goal` 的 Stop-hook 触发——不改变，反而给出 ADR-021 仍成立的 runtime-agnostic 正确理由**。Claude evaluator 触发在 **turn/session 边界**；TP sprint 重入边界是 **Phase5 Compound 中段**——粒度不匹配（**turn ≠ sprint-iteration**），host harness 无法在 sprint-iteration 边界触发。Claude 能做每-turn 独立判官，正因它有 turn 挂点；TP 没有对应 sprint-iteration 挂点。
- **Codex `/goal` 的 `goals.rs` 事件总线——不改变**。它是 Rust core 进程内真事件循环（有宿主进程），正是 ADR-021 对比的 `pipeline.js:472` 那类真 `for` 循环的同类。有宿主进程才能进程级硬终止；TP `/sprint` 没有 → 不能照搬。印证而非推翻。
- **第三轴措辞精化（写进本 solution，不改干净的 ADR）**：ADR-021 影响段"无 hookable 事件"应读作"无 **sprint-iteration 边界**的 hookable 事件"——因为两 runtime 都有 Stop hook，TP 自己也注册了 4 个 hook（含 Stop/`evaluate-session`）。所以 ADR-021 成立的精确理由是 **边界粒度不匹配 + [[ADR-009]] hook 不做业务编排**，而非"无 hook 可用"。这条精化强化 ADR-021 主轴：parity 可达（两侧都有 Stop-hook seam），TP 选 pure-prompt MVP 是**轻量优先 + measure-before-enforce 的主动取舍**，不是 Codex 侧能力缺失。

### 收窄后该改什么

**唯一真借鉴（P2 → deferred backlog，不本轮实施）**：把 Goal Loop 的**完成判定**从主循环 advisory 自评（judge==worker）升级为独立 sub-judge 步骤——Phase5 收尾委托一个只读 transcript+diff 的判定者输出 `goal-met=y/n+reason`，与现有 advisory 自评分离；判定 prompt 内嵌 Codex `continuation.md` 风格的**反-proxy 核证清单**（别仅凭过测/green checks 判完成，逐 requirement 核证）。

- 落法：复用 `/review` 的 spawn 协议（spawn-capable runtime spawn sub-judge，inline-fallback runtime 内联保 parity，守 [[feedback_external_skill_borrow_separate_prompt_ip]]）；零新脚本、不下沉 enforcement、不改 max-iter 天花板；经 propagate→build→validate→pre-commit 同步副本（守 [[ADR-024]] methodology-rule parity）。
- **但**：不可照搬"每-turn 独立判官"（无 sprint-iteration 触发点，ADR-021 钉死），只借 judge≠worker 的**形状**。且 `--goal` 是未证 MVP（plan 自标），按 [[feedback_unproven_protocol_rollback_before_enforcement]] 与既有 helper deferred 同档——**等 `--goal --auto` 被证明高频使用后再落**，否则是给未证特性加表面。

**HOLD / 移出作用域**：

- **Codex token_budget 终止** —— HOLD（收敛进化非 borrow）：TP 已有 iteration/exit 等价确定性天花板；token 维度对无宿主进程纯协议不可靠落地。
- **Codex SQLite durable goal daemon** —— HOLD：runtime 内核实现细节不可移植，撞 non-scope（不做跨会话常驻 goal daemon）+ ADR-021（生命周期=单 sprint 文档）+ 第 4 不可妥协（Obsidian 兼容；SQLite schema 私有会变）。
- **"系统控终止"非对称** —— HOLD：TP 已有等价物（advisory 自评 + `--until`/max-iter 硬停 + 人工 gate 天花板）。真增量只在完成判定外置。
- **每-turn 独立判官频率 / fan-out / workflow budget seam** —— 拒绝/移出：无 sprint-iteration 触发点 / 属 Dynamic Workflows 不属 `/goal`（budget seam 已正确归 agent-loop backendKind，见 [[2026-06-01-claude-code-dynamic-workflows-architecture]]）。

## 二次评审（对抗核验 + 一手源码复核）

本 eval 经两轮 ultracode workflow：第一轮 11 agents（research → 综合 → 逐候选对抗核验 → completeness critic），第二轮 5 agents（收窄到原生 `/goal` 后一手源码复核两个 `/goal` 机制 + 争议 Stop-hook 事实 + 收窄重判 → 最终综合）。对抗核验把第一轮综合层 6 候选收紧到"1 条 reframe 进 backlog + 5 条 reject/HOLD"，并查出综合层与对抗层**双双**踩了 Codex Stop-hook 事实 drift —— 第二轮一手源码（openai/codex repo）定论修正。这正是 [[feedback_single_pass_eval_lenient_vs_adversarial]]（单视角手写 eval 偏宽，对抗 + 一手核验收紧）+ [[feedback_reverify_sibling_before_single_runtime_assertion]] 的活案例。

> 状态 `completed`：本文经上述两轮对抗核验 + 一手源码复核（§二次评审）满足 review-pass 前提，并由用户 2026-06-17 显式 sign-off 转 `completed`（[[feedback_sibling_eval_completed_status_requires_review_pass]]）。

### 未决事实（不可写进 ADR/committed 断言，仅 secondary）

1. **Codex `/goal` 在 `codex exec` 非交互下端到端可靠性**：代码层暴露门已一手核实（`extension.rs:105`，与 interactive/exec 无关），但"`codex exec --enable goals` 完整跑通 goal 自主循环到 complete"**未端到端实测**；issue #24094 仍 open，维护者判定系评论级佐证非实测。只能写"设计上不排除 exec，残余不可靠在语义层"，不可写"已可靠"。
2. **Codex 官方 hooks 文档正文**（`developers.openai.com/codex/hooks`、cookbook `using_goals_in_codex`）：WebFetch 持续 403，正文未取到。Stop-hook `decision:block` 结论由 openai/codex 仓库源码（同属一手 OpenAI 来源）独立证实，可写；但依赖官方 hooks 页**措辞原文**的引用须标 secondary。
3. **精确版本可用性窗口**（Stop hook ~v0.115.0/2026-03-17 functional、goals 0.132→0.133 default-on、最新 stable 0.140.0）：来自 releases 页 + issue 评论的二手时间锚，未逐版本实测；写 solution 可，版本号易 drift（[[feedback_grep_self_codebase_before_analysis]]）。

## Verification

- 一手核实：Claude `/goal` 全部机制来自官方 `code.claude.com/docs/en/goal`；Codex `/goal` + Stop hook 机制来自 openai/codex 仓库源码（`HookEventName.ts` / `hook_runtime.rs` / `hooks/src/events/stop.rs` / `hook_names.rs` / `ext/goal/{tool,accounting,extension}.rs` / `state/runtime/goals.rs` / `state/migrations/0034_*` / `ext/goal/templates/goals/{continuation,budget_limit}.md` / `ThreadGoalStatus.ts`，均 gh API 一手）+ issue #24094。
- repo 对照：`user-level/commands/sprint.md`（Goal Loop 协议 / 终止三优先级 / 第 6 视角 goal-drift / 强制打印 check 行）、`.claude/rules/architecture.md`（[[ADR-021]] 承重事实经核实干净）、`docs/plans/2026-05-29-sprint-goal-mode.md`（pure-prompt MVP 决策 + non-scope + 附录 A helper 蓝图）、`docs/solutions/2026-06-01-claude-code-dynamic-workflows-architecture.md`（budget 属 Workflows 非 `/goal`，已归 agent-loop backendKind）。
- 文档变更验证：`node scripts/sync-solution-index.js --all`；`node scripts/pre-commit-check.js`。

## Prevention / 泛化

- **排他 runtime 断言（"X 只有 A、B 无对等物"）落笔前必一手复查 sibling**：Claude↔Codex 在 goal / plan mode / hook 子系统上收敛进化频繁，单边记忆滞后 = 高频 drift。优先级：一手源码/官方文档 > 第三方博客；官方页 403 时用同源仓库源码独立证实，而非拿第三方当一手（[[feedback_reverify_sibling_before_single_runtime_assertion]]、[[documented-claim-vs-code-reality-drift]]）。
- **model-driven 协议借鉴 host-runtime 原语前，先问"被借机制依赖宿主进程/可挂事件吗"**：依赖则只能借**协议形状**（如 judge≠worker、反-proxy 判据）不能借**进程级 enforcement**（如 token 原子记账、每-turn 触发频率）——这是 [[ADR-021]] 第三轴的应用（[[model_driven_loop_determinism_ceiling]]）。
- **sibling-eval 默认产出对比 + 改进面，不是落地决策表**；收敛进化项写进结论但不进 borrow 裁决；未证特性的借鉴进 measure-gated backlog 而非首版接 enforcement。
- **"勘误"前先验证 committed 文本是否真含错误断言**：本次 drift 只在临时分析层、committed ADR 干净——对干净文本做假勘误本身制造 drift。
