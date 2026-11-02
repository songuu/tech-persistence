---
title: "Superpowers v7 复评：Brainstorming 应先理解意图，再选择工件路径"
date: "2026-10-16"
status: completed
type: solution
tags: [solution, sibling-eval, superpowers, v7, spec, brainstorming]
related_solutions:
  - "[[2026-09-09-superpowers-spec-brainstorming-eval]]"
source_plan: "[[2026-10-16-superpowers-v7-spec-brainstorming-eval]]"
source_commit: "bb92a77741419a4ab5f06e711a283343f1ada0c3"
---

# Superpowers v7 Spec / Brainstorming 增量复评

> Status: `completed`。product-lens、coherence、feasibility 三路只读终审均 PASS；本轮没有修改工作流实现。

## 修正后的核心结论

Superpowers v7 最值得借的不是新话术，而是 **控制顺序**：

> 对欠定义任务先理解意图并尽早复述，再决定是 quick、small 还是 project；分类是理解之后的交付选择，不是对话开始前的猜测。

这使 2026-09-09 的 route-first 建议发生翻转。TP 不必删除已经实现并由测试依赖的 `probe-like / bounded-like / architectural-like`；应把它们改为意图清楚后的 internal post-intent artifact route，面向用户只说自然语言的任务规模。清晰、低风险任务继续直接执行，不能被 v7 变成固定问答仪式。

第二个可借 spine 是决策 provenance，但必须分层。对话归因只区分 `user-stated / agent-inference`；Think handoff 记录 `user-owned / delegated / unresolved`；Plan 才把具体技术决定写为 `user-confirmed / agent-call / builder-delegated / user-only unresolved`。因此 Think 不会变成第二个 Plan，agent 决定也不会冒充用户同意。

第三个候选是 one-round planner-readiness：在 Plan 写出 authority draft 后、task decomposition 前，只提出“否则必须猜、猜错会显著改变结果”的问题。它补充而不替换 placeholder / consistency / scope / ambiguity 四项 inline preflight。由于上游 Codex 证据仍不充分，它只进入 P2 条件评测，不变成每份文档的默认 fresh-subagent gate，也不复用 post-implementation Review phase。

## 为什么这次是重大更新

- v7 删除了 v6.3 的 up-front 三路 router。设计文档明确认为：未理解需求前先分类，会让错误猜测同时控制提问和文档成本。[v7 rebuild design](https://github.com/obra/superpowers/blob/main/docs/superpowers/specs/2026-10-05-brainstorming-rebuild-design.md)
- 新 skill 使用开放描述问题、真实场景、anti-goals、早期 playback、显式猜测与决策所有权；意图清楚后才 sizing。spike 变成 discovery 内的 throwaway technique，而不是顶层任务类型。[brainstorming skill](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md)
- 通用 spec reviewer 被 fresh-builder readiness check 替代；只保留高影响未知项，并要求 minor 项由 agent 自行决定且标明 provenance。[builder check](https://github.com/obra/superpowers/blob/main/skills/brainstorming/builder-check-prompt.md)
- 官方 v7.0.0 固定在 `bb92a77741419a4ab5f06e711a283343f1ada0c3`，commit 时间为 `2026-10-10T00:28:04Z`；截至 2026-10-16，聚焦路径没有 release 后 main 增量。[v7.0.0 release](https://github.com/obra/superpowers/releases/tag/v7.0.0)

## 证据强度

上游对 v7 做了 115 个首轮样本、58 个多轮会话和 6 名盲测者的对比。报告中 process-jargon 与 menu-first 开场都降至 0/25、明确小任务正确直达升至 5/5、6/6 盲测者偏好新版；四项主观评分也全部提高。[PR #2463](https://github.com/obra/superpowers/pull/2463)

这些数据比较的是整套 rewrite，没有单独隔离 route ordering。它们足以让“route-first 是默认最稳首步”失去依据，并支持本轮翻转工程建议，但不能证明改善由 route-after-intent 单独造成，也不能证明 TP 应原样采用。主要结果来自 Claude；Codex 后续样本受 approval timeout 干扰，新旧 arm 都出现首轮直接开始 React/Vite 的情况，结果不具结论性。[eval environment](https://github.com/obra/superpowers/pull/2464)、[how-it-gets-made eval](https://github.com/obra/superpowers/pull/2482)

因此本轮区分：

- **已验证事实：** v7 的流程、固定源码、Claude 侧对照结果、当前 TP 实际落点。
- **工程推断：** 后置路由和决策 provenance 能减少 TP 在欠定义任务中的误分类与错误归因。
- **未知：** TP Claude/Codex 的实际收益、token/轮次成本、planner-readiness 的误问率。

## 16 项决策摘要

| 分类 | 数量 | 内容 |
|---|---:|---|
| P1 | 6 | route-after-intent、开放描述/真实场景问题、早期 playback 与事实/猜测区分、anti-goals、决策权边界、authority provenance |
| P2 | 2 | 条件 planner-readiness；精确对话节奏与触发阈值 A/B |
| Cross-ref | 2 | 多项目逐个处理是 v6.3 既有规则；v6.4.1/v6.4.2 Review Focus / lean plan 已于 2026-10-13 落地 |
| Hard reject | 6 | 固定 opt-out 开场、所有小任务强制批准、scoped recon 一律先问、默认独立 spec + auto-commit、视觉 server、每份设计默认 fresh subagent review |

详细评分、落点与证据见 [[2026-10-16-superpowers-v7-spec-brainstorming-eval]]。

## 对当前 TP 的建议形状

1. 对清晰任务维持直达路径；只在存在产品/行为欠定义时进入 intent discovery。
2. 先收集 goals、non-goals、anti-goals、prior art 和决策权边界；出现结果相关歧义或进入多轮/architectural 深度时，才用短 playback 暴露误解。
3. 意图清楚后再映射到 internal post-intent `probe-like / bounded-like / architectural-like`，保持 artifact scaling 和现有回归测试。
4. architectural-like 继续使用同文件 shadow design-authority，不默认拆 spec 文件；Plan 记录 user-confirmed / agent-call / builder-delegated / user-only unresolved。后者只用于会改变结果且无法合理默认的决定，并在 task decomposition 前触发现有开放产品决策 gate；minor/defaultable 项直接记录为 agent-call。
5. planner-readiness 仅作为高歧义 Plan 的 `authority draft → readiness → task decomposition` treatment；先做双 runtime A/B，不接 post-implementation Review phase。

## 与 9 月结论的 Defensive Challenge

**Flip 1：** SB1 从“先用三路枚举分类”改为“先理解意图，再使用枚举缩放工件”。枚举保留，控制顺序翻转。

**机制细化：** 9 月 SB14 已允许高风险/争议时做 P2 独立 Review，本轮不冒充第二个 flip。增量是将目标收窄为 task decomposition 前的 planner-readiness；默认四项 inline preflight 保留，没有恢复每文档 fresh-subagent review。

没有翻转的边界：同文件 authority 优先、物理双文件待证、自动 commit 拒绝、人工 gate 按风险/权限决定、SB6 lineage runtime 继续受 108-rep 本地证据门约束。

## 已覆盖与不应重复建设

Superpowers v6.4.1 的 Review Focus，以及 v6.4.2 的“计划记录决策而不是代码转录”、确切接口/断言和跨任务 Consumes/Produces，TP 已在 [[2026-10-13-plan-review-contracts]] 实施。该部分不需要新的 Plan owner、模板或 parser。[v6.4.1 release](https://github.com/obra/superpowers/releases/tag/v6.4.1)、[v6.4.2 release](https://github.com/obra/superpowers/releases/tag/v6.4.2)、[writing-plans](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md)

issue #2507 的 mandatory recon 仍是未合并提案；TP 已要求架构敏感工作先检查真实仓库证据，但不需要把正常只读勘察改成每次停等许可。[issue #2507](https://github.com/obra/superpowers/issues/2507)

issue #2473 记录了 auto-commit 可能把无关 staged 文件卷入提交的风险。这强化而不是改变 TP 的既有规则：commit 必须由当前任务授权，不从“spec 写完”自动推导。[issue #2473](https://github.com/obra/superpowers/issues/2473)

## 实施门与剩余风险

本轮不授权实施。若后续决定继续，最小范围应包含两端 Think SoT、两端 Plan SoT、`docs/plans/TEMPLATE.md`、Plan 条件 reference、受管投影和相应 parity tests；Codex Plan 当前为 3,987 bytes，详细 provenance 必须放入 reference 或先压缩入口。静态契约可扩展 `test-think-design-routing.js`，真实对话收益需要 Claude/Codex 分别做行为 A/B；不触碰 lineage parser、Work/Review freshness gate 或新服务。

实施前至少证明：明确任务不会被拉长；隐藏平台/媒介选择能被识别；agent 默认不会冒充用户同意；Claude/Codex 映射到同一内部路由。planner-readiness 还需单独测高影响漏问、误问、额外轮次和 token 成本。

## Review 状态

- product-lens：PASS；闭合 route 因果边界、readiness 时序、Think/Plan ownership 与轻量 playback。
- coherence：PASS；tag/SHA/UTC、核心 diff、16 项计数、历史时间线和证据限定一致。
- feasibility：PASS；真实落点、入口预算、`--clarify` 边界、投影与双 runtime eval 分层可行。
- defensive challenge：1 个真实 flip + 1 个机制细化；多项目规则降为 v6.3 cross-ref/backfill。

边界：研究文档不代表候选已实施或收益已在 TP 验证。未修改产品代码，未写 learning/instinct，未 commit、未 push。

