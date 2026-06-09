---
title: "phuryn/pm-skills PRD 技能/命令评估 — 0 直接借鉴（目标用户错配）+ 2 收敛进化 + 1 不实施 follow-up"
date: 2026-06-09
tags: [solution, sibling-eval, external-reference, identity-question-first, target-user-mismatch, convergent-evolution, prd, pm-skills]
related_instincts:
  - sibling-eval-default-compare-not-borrow
  - target-user-mismatch-invalidates-borrow
  - sibling-eval-convergent-evolution-high-value
  - sibling-eval-completed-status-requires-review-pass
  - grep-self-codebase-before-analysis
related_solutions:
  - "[[2026-05-26-claude-mem-eval]]"
  - "[[2026-05-21-gsd-eval]]"
  - "[[2026-05-14-spec-kit-eval]]"
  - "[[2026-05-15-mattpocock-skills-analysis]]"
aliases: ["pm-skills-eval", "pm-skills sibling eval", "phuryn-pm-skills-prd-borrowing-decision"]
status: draft
sources:
  - "https://github.com/phuryn/pm-skills (锚定 main 分支 fetch 日期 2026-06-09)"
  - "PM Skills Marketplace：100+ 技能/命令，9 plugin，面向产品经理"
  - "https://github.com/phuryn/pm-skills/blob/main/pm-execution/skills/create-prd/SKILL.md"
  - "https://github.com/phuryn/pm-skills/tree/main/pm-execution (16 skills + 11 commands)"
---

# phuryn/pm-skills PRD 技能/命令评估 — sibling-eval

> **Status**: `draft`（analysis 类文档未过 §review/二次评审，按 [[feedback_sibling_eval_completed_status_requires_review_pass]] 不标 completed）

## Problem

用户请求："`--auto` 对比下 https://github.dev/phuryn/pm-skills，主要是里面的 PRD 相关的技能和命令"。

按 [[feedback_sibling_eval_default_compare_not_borrow]]：默认输出 = compare + pros/cons，非实施决策表。

## pm-skills 是什么

PM Skills Marketplace：**100+ agentic 技能/命令**，9 个 plugin（discovery / strategy / execution / market-research / data-analytics / go-to-market / marketing-growth / toolkit / ai-shipping），**面向产品经理**。纯 prompt 模板库，无 enforcement、无双 runtime、无确定性约束。

PRD 相关集中在 `pm-execution` plugin（16 skills + 11 commands）：

| 实体 | 类型 | 做什么 |
|---|---|---|
| `create-prd` / `/write-prd` | skill+cmd | 8 节 PRD 模板（Summary / Contacts / Background / Objective / Market Segment / Value Proposition / Solution / Release），plain language，输出 `PRD-[name].md`；三文件结构 SKILL/TEMPLATE/EXAMPLE |
| `/red-team-prd`（skill `strategy-red-team`） | cmd+skill | 对抗式压测 PRD/roadmap/strategy，攻击 load-bearing 假设，按**验证成本**排序 |
| `pre-mortem` / `/pre-mortem` | skill+cmd | 失败模式预演，上线前廉价试错 |
| `user-stories`(INVEST) / `job-stories` / `wwas`(Why-What-Acceptance) | skill | story 拆分层 |
| `outcome-roadmap` / `sprint-plan` | skill | 产品规划 |

## TP 是什么（[[ADR-011]] 4 不可妥协）

- **MR**: multi-runtime parity（Claude + Codex）
- **DET**: determinism-first（grep + frontmatter）
- **LT**: lightweight-first（无 daemon / DB / 重文档层）
- **OBS**: Obsidian-compat（pure markdown + frontmatter）

身份：developer-toolchain self-evolution sibling。最近的 PRD 类比物 = `think`（CEO 视角定 scope/non-scope/success）+ `plan`（架构师技术方案）+ `prototype`（截图需求收敛）。**无专门 PRD 命令**（grep 确认）。

## 身份 gate（决定一切）

| 维度 | pm-skills | tech-persistence |
|---|---|---|
| 目标用户 | 产品经理 | solo 开发者（自己） |
| 产物受众 | 人类 stakeholder（沟通） | 模型自身 + 未来的我（执行） |
| 产物形态 | PRD / roadmap / strategy 文档 | think/plan markdown + 本能 + ADR |
| 不可妥协 | 无（纯模板库） | MR / DET / LT / OBS |

按 [[feedback_target_user_mismatch_invalidates_borrow]]：end-user(PM) 系统机制移植到 dev 系统，多数引入"用错场景的便利"。**这是本评估的主 gate。**

## PRD 实体 → TP 最近对应

| pm-skills PRD 实体 | TP 最近对应 | 关系 |
|---|---|---|
| `create-prd` 8 节模板 | `think` + `plan` | 重叠仅"定义做什么"；Contacts/Market Segment/Value Prop/Release-rollout 4 节对 dev 工具链无意义 |
| `/red-team-prd`（假设按验证成本排序） | ADR-011 product-lens + ADR-012 假设验证 + ADR-013 §B dogfood 边界枚举 + review 第 4 视角 | **收敛进化** |
| `pre-mortem` | `think` risks + `review` 多视角 | 收敛 |
| `user-stories`/`job-stories`/`wwas` | 无（TP 直接 task 拆解） | dev 不需 story 中间层 |
| `outcome-roadmap`/`sprint-plan` | `sprint` 任务表（语义不同） | 撞名不撞义 |

## PRD 三件套 pros/cons + 裁决

### A. `create-prd` 8 节模板 — 拒绝
- ✅ 成熟结构化模板，强制覆盖维度；三文件 SKILL/TEMPLATE/EXAMPLE 是 example-driven，输出稳定。
- ⚠️ 8 节里 Contacts / Market Segment / Value Proposition / Release-rollout 是 PM-stakeholder 维度，dev 自进化场景零适用；引入完整 PRD 层 = 在 `think` 之上加重文档负担，违反 LT + YAGNI。
- **裁决：拒绝。** TP `think` 故意轻（定 scope，不写产品文档）。

### B. `/red-team-prd` 假设对抗 + 验证成本排序 — 收敛进化，不借
- ✅ 把"攻击假设 + 按验证成本排序"做成独立显式命令；TP 把同一能力分散在 plan/review/ADR，无单一入口。
- ⚠️ TP 已有等价物：`plan`「关键假设验证」段（[[ADR-012]] 强制标可信度 + 勘察文件）、`review` 第 4 视角、[[ADR-013]] §B「枚举会拒绝哪些现有产物」。再加独立命令 = 重复表面，违反 LT。
- **裁决：收敛进化，不借。** 见下节。

### C. `pre-mortem` 失败模式预演 — 拒绝
- ✅ 上线前廉价试错框架。
- ⚠️ TP `think` risks + `review` 多视角已覆盖；dev 场景"上线"=commit，回滚成本远低于产品发布，pre-mortem 的 ROI 前提不成立。
- **裁决：拒绝。**

## 收敛进化项（[[feedback_sibling_eval_convergent_evolution_high_value]]）

两个独立系统造出同机制 = 自家方向被外部验证：

1. **假设对抗 + 按验证成本排序**：pm-skills `red-team-prd` ↔ TP [[ADR-012]](plan 假设标可信度) + [[ADR-013]] §B(dogfood 最低验证成本枚举) + [[ADR-011]](product-lens reviewer 强制)。两边都收敛到"先攻击最贵假设"。
2. **多视角对抗审查**：pm-skills `strategy-red-team` ↔ TP `review` 6 视角。

→ 信号：TP 的 plan/review 防漂移设计方向正确。**不需任何动作。**

## 结论

| 项 | 数量 |
|---|---|
| 直接借鉴 | **0** |
| 收敛进化（验证自家方向） | 2 |
| 可选 follow-up（标注不实施） | 1 |
| 硬拒绝 | create-prd / pre-mortem / user-stories / outcome-roadmap |

**唯一可选 follow-up（不实施，仅记录）**：`think` 命令收尾可选追加一行"本需求最贵/最不确定假设 + 最低成本验证手段"。但 `plan`「关键假设验证」段已覆盖 ~90%，think 阶段补只是提前一个 Phase —— 边际价值低，**不建议落地**（LT 优先）。

**根因**：pm-skills 是优质 PM 模板库，解决"PM 如何对 stakeholder 表达产品意图"；TP 解决"dev 工具链如何自我积累 + 双 runtime 执行"。两者目标函数正交，模板可读不可移。

## 变更日志

- 2026-06-09：初稿。0 直接借鉴 + 2 收敛 + 1 不实施 follow-up。status: draft（待二次评审）。
