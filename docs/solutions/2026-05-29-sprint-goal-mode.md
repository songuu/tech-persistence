---
title: "/sprint --goal 自主目标循环：pure-prompt MVP + '无宿主进程→确定性上限'设计原则 + helper 条件推迟"
date: 2026-05-29
tags: [solution, sprint, goal-loop, determinism, mechanism-over-discipline, unproven-protocol]
related_instincts:
  - model-driven-loop-has-no-enforceable-counting-point
  - unproven-protocol-rollback-before-enforcement
  - no-auto-default
  - reuse-existing-infra-before-building-new
related_solutions:
  - "[[2026-05-12-pre-commit-defense]]"
  - "[[2026-05-28-skill-publish-baseline-guard]]"
aliases: ["sprint --goal", "goal mode", "goal loop", "目标驱动循环"]
status: completed
---

# /sprint --goal 自主目标驱动闭环

## Problem

用户要求在当前架构接入 `/sprint --goal "<目标>"` 自主目标驱动循环：设目标 → think→plan→work→review→compound 重入直到达成或终止，4 维控制（终止条件 / 自动化程度 / 目标范围约束 / 运行时选择）。难点：`确定性优先` 是项目不可妥协原则，用户明确要"直接控制"终止——天然倾向给 max-iter 天花板写确定性强制代码。

## Root Cause（load-bearing 架构发现）

Plan 阶段对抗设计 panel（pure-prompt vs deterministic-helper vs hybrid）勘察（[[ADR-012]]）暴露决定性事实：

- **`/sprint` 没有宿主进程**。phase 重入是「模型读 markdown 并选择继续」，对比 `pipeline.js:472` 的真实 Node `for` 循环（`maxIterations=32` 由进程强制计数）。**无 hookable per-iteration 事件**。
- 推论：一个「模型必须自愿调用」的 max-iter CLI 计数器**并不比 prose 更被强制**——只是把信任从「数对」挪到「记得调用」（adversary 自标 helper 有 HIGH 级 voluntary-call gap）。给无强制触发点的环节堆 CLI = "guarding the unguardable"。
- 同时 `确定性优先` 与 [[feedback_unproven_protocol_rollback_before_enforcement]]（2026-05-22 预热协议 rollback 活案例）在此真冲突：后者要求未证协议先证价值再下沉 enforcement。

## Solution（Approach A pure-prompt MVP，用户拍板）

零代码，与 `--auto`/`--caveman`「协议 + auto-mode.md 引用、无 backing code」同构。改 5 个源（4 source + plan）：

1. **`user-level/commands/sprint.md`**：用法/可选参数加 `--goal/--max-iter/--until/--runtime`；新增 `## Goal Loop 协议` section（目标一等追踪 / 终止优先级 / 强制打印 check 行 / 循环机制 / gate 行为 / 范围约束 / 运行时选择）；Phase1 north-star 注入；Phase4 第 6 视角加 goal-drift 两档（warn-not-silent，仅同破 invariant 才升 P0）；Phase5 循环重入决策；frontmatter 加 5 个 `goal*` 字段。
2. **`user-level/rules/auto-mode.md`**：加 Goal Loop **迭代级强制人工边界**（协议首个 loop-class 边界：到 max-iter 未达成→停下问人；跨迭代累积 scope creep→强制人工）+ 三维正交注 + `/sprint --goal` 集成行 + 默认值「--goal 不开自主」注。
3. **`README.md`**：加「目标驱动循环（--goal）」段（mirror --auto）。
4. 同步链：`propagate-command-changes.js sprint --rules auto-mode` → `build-codex-plugin.js` → `validate-codex-plugin.js` → `run-tests.js`(19/19) → `pre-commit-check.js`(staged EXIT=0)。

**确定性如何在无宿主进程下尽量保证**（明文声明为协议层上限，非进程级硬计数）：
- `goal_iteration` 是循环状态 SoT，存 sprint-doc frontmatter，**每轮重入前强制从磁盘重读**（不信 `/compact` 后对话记忆）；
- 每轮收尾**强制打印** `Goal loop: iter N/max, until=exit<code>, goal-met=y/n, decision=...`，使跳过在 transcript 可见；
- 终止优先级：`--until` exit0 / `iteration>=max-iter` 硬停，**压倒** LLM 达成自评（仅 advisory，可提前停不可越天花板）；
- 低默认 max-iter=3 + auto-mode 迭代级强制 gate（多层断路器）。
- `--goal` 单用**不开自主**（守 [[feedback_no_auto_default]]），自主须显式 `--goal --auto`。

## Decision Record

见 [[ADR-021]]：model-driven markdown 协议的"确定性强制"上限由"是否存在宿主进程/可挂事件"决定（[[ADR-016]]/[[ADR-017]] 语义-确定性边界的**第三轴**：是否有强制触发点）。max-iter 下沉为 `scripts/sprint-goal.js` 确定性 helper **条件推迟**（仅当 `--goal --auto` 证明高频且有价值；蓝图冻结于 plan 附录 A）。`--runtime both` 跨运行时委托 agent-loop 亦推迟（agent-loop 无 goal-budget 可承接）。两项均在 plan frontmatter `deferred`，deadline 2026-08-29。

## Verification

- propagate+build+validate 绿；run-tests 19/19；pre-commit staged EXIT=0。
- **负样本**（[[feedback_negative_sample_3_archs]] 文档型适配）：派生副本注入 drift → pre-commit EXIT=1 + 派生具体修复命令 → 重生成恢复 EXIT=0。
- grep `.codex` 确认无 Claude→Codex regex 撞车（`~/.codex/rules`、`agent-loop 编排器`、`runtime instruction docs` 均正确，无裸 Claude 泄漏）。
- Ultracode 多视角 review workflow（5 维 + 对抗验证）：零真实 P0/P1，6 视角全清。

## Prevention / 泛化

- **给 model-driven 子系统设计"确定性 enforcement"前，先问「有没有宿主进程 / hookable 事件可挂」**——无则确定性上限是"协议 + 持久化 + 可见打印 + 低默认值 + 既有强制 gate 多层"，别堆模型必须自愿调用的 CLI 假装强制。[[ADR-021]] 第三轴。
- **未证特性默认 pure-prompt，把 mechanism 下沉作为"证明价值后"的条件 backlog**（蓝图先冻结避免重新勘察），而非首版就接 enforcement（[[feedback_unproven_protocol_rollback_before_enforcement]] + [[ADR-013]] 谨慎）。
- 改 `user-level/commands/*.md` 或 `user-level/rules/*.md` 源必跑 `propagate + build + validate + pre-commit` 四件套（propagate 单跑不足，[[feedback_propagate_needs_build_step]]）；新 prose 用 runtime-neutral idiom 防 codex regex 撞车（[[feedback_codex_regex_sync_runtime_idiom]]）。
