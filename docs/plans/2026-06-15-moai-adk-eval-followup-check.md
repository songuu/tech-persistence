---
title: "MoAI-ADK eval follow-up 检查"
type: sprint
status: completed
created: "2026-06-15"
updated: "2026-06-15"
tasks_total: 4
tasks_completed: 4
tags: [sprint, docs, sibling-eval, moai-adk]
aliases: ["moai-adk eval follow-up"]
invariant_tests:
  - "node scripts/sync-solution-index.js --all"
  - "git diff --check"
  - "node scripts/pre-commit-check.js"
---

# MoAI-ADK eval follow-up 检查

## 需求分析

### 要做
- 检查 `docs/solutions/2026-06-15-moai-adk-eval.md` 是否仍有可继续执行项。
- 对已落地但文档未同步的 stale 语义做收口。
- 按 source-read 结果补强 `/review` Doc↔Code Walkthrough checklist。
- 保持 verdict 与 status 诚实：已实施的写已实施，未源码全审的不伪装 completed。

### 不做
- 不新增 MoAI-ADK 机制实现。
- 不把 moai 的 Go evaluator / Ralph / full skill inventory 搬进 TP。
- 不吸收 numeric scoring / evaluator profiles / report-dir / coverage gate 等重型 harness 机制。
- 不追逐 README 内部不一致的 agent/skill 精确营销数字。

### 成功标准
- [x] B1 状态在 TL;DR、残留风险、结论、实施记录之间一致。
- [x] MoAI plan-auditor / sync-auditor 可借 checklist 已落到 `user-level/commands/review.md` 并同步 4 副本。
- [x] 明确剩余 follow-up 哪些可做、哪些不建议做。
- [x] 运行 solution index 同步与 diff 检查。

### 风险和假设
- 风险 L1：docs-only；主要风险是把未全审的外部源码误写成已完成。
- 假设 `status: reviewed` 比 `completed` 更准确，因为 R1/R3 仍未全仓源码审计。

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| B1 已有真实落点，后续只需补强 checklist | Read `user-level/commands/review.md` 并 grep Doc↔Code Walkthrough | `user-level/commands/review.md` 已包含 Doc↔Code 一致性 Walkthrough；本轮补入 Context Isolation / UNVERIFIED / must-pass / second-pass |
| 当前 MoAI evaluator 文件不是 evaluator-active.md | GitHub raw / directory spot-check | `evaluator-active.md` 在当前 main 未找到；同目录存在并已读 `sync-auditor.md`，只作为外部参考源 |
| 不应把 MoAI 重型 evaluator 搬进 TP | 对照 ADR-011 / ADR-017 / ADR-022 | numeric scoring、profile、report-dir、coverage gate 均增加 harness 负担；本轮只借轻量 review checklist |

---

## 技术方案

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| sibling-eval docs | compare + pros/cons，不把评估请求误当实施承诺 | 只收口已实施 B1 与 follow-up 判定，不新增实现承诺 |
| Doc↔Code 一致性 | 写 "已实施/已下沉" 前 grep/read 代码锚定 | 已核对 `/review` walkthrough 在 user-level / Codex / plugin 副本存在 |
| solution index | `docs/solutions/*.md` 为 canonical source，index/runtime docs 由脚本生成 | 修改 solution 后跑 `node scripts/sync-solution-index.js --all` |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| solution doc 文案收口 | 用户打开 solution | `sync-solution-index.js` | `docs/solutions/index.jsonl` + runtime docs managed block | 是 |

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| MoAI-ADK eval | B1 语义 doc↔code↔plan 审计 | 已实施，文档收口 | 2026-06-15 |
| MoAI-ADK eval | plan-auditor / evaluator checklist source-read | 已执行：`evaluator-active.md` 当前不存在，按实际 `sync-auditor.md` 吸收轻量 checklist | 2026-06-15 |
| MoAI-ADK eval | R1/R3 外部源码全审 | 推迟，只有升 completed 时需要 | 无硬 deadline |

### 任务拆解
- [x] **Task 1 [P]**: 复核 B1 / ADR-026 / review 副本落点 — 风险: L1
- [x] **Task 2 [P]**: 修正 solution stale 文案并追加 follow-up 判定 — 风险: L1
- [x] **Task 3**: 同步 solution index 并验证 diff — 风险: L1
- [x] **Task 4**: 补强 `/review` Doc↔Code Walkthrough checklist 并同步副本 — 风险: L1

### 测试策略
- 文档同步：`node scripts/sync-solution-index.js --all`
- Whitespace：`git diff --check`
- Repo gate：`node scripts/pre-commit-check.js`

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 把 R1/R3 写成已完成 | 中 | 后续 eval 误读 | 保留 `status: reviewed`，§11 明确 source-read 只可选 |
| solution index drift | 低 | runtime docs stale | 运行统一 renderer |

### 涉及文件
- `docs/solutions/2026-06-15-moai-adk-eval.md`
- `docs/solutions/index.jsonl`
- `CLAUDE.md`
- `AGENTS.md`
- `docs/plans/2026-06-15-moai-adk-eval-followup-check.md`

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-06-15 | Task 1 | 核对 B1 落点：`user-level/commands/review.md`、`.codex/commands/review.md`、`.codex/skills/review/SKILL.md`、`plugins/tech-persistence/*/review*` 均已有 Doc↔Code Walkthrough；ADR-026 已采纳 |
| 2026-06-15 | Task 2 | 修正 `B1 backlog / 待最终处置` stale 文案，追加 §11 二次检查结论 |
| 2026-06-15 | Task 3 | 运行 index 同步、diff check、pre-commit gate |
| 2026-06-15 | Task 4 | 将 source-read 得到的 Context Isolation / UNVERIFIED / must-pass / second-pass checklist 落到 `/review` 并 propagate 至 4 副本 |

### 验证记录

| 命令 | 结果 |
|------|------|
| `node scripts/sync-solution-index.js --all` | pass；indexed 46 solution docs，`docs/solutions/index.jsonl` + `CLAUDE.md` + `AGENTS.md` 均 ok |
| `git diff --check` | pass；仅输出既有 line-ending warning |
| `node scripts/pre-commit-check.js` | pass |
| `node scripts\propagate-command-changes.js review` | pass；同步 plugin command、codex command、plugin skill、codex skill |
| `rg -n "Context isolation\|UNVERIFIED\|Must-pass firewall\|Chain-of-Verification\|Second pass" ...review...` | pass；user-level / Codex / plugin 5 份副本均命中 |

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
| P2-1 | source-depth | `docs/solutions/2026-06-15-moai-adk-eval.md` | 若未来想升 `completed`，需读 moai Ralph + plan-auditor 源码 | defer |

### 总评
当前可执行 TP 侧优化已完成。已读 `plan-auditor.md` 与当前 evaluator 文件 `sync-auditor.md` 后，只吸收轻量 checklist；剩余 source-read 是外部 eval 严格度提升，不阻塞本仓库实现。

---

## 复利记录

### 提取的经验
- sibling-eval 后续检查优先找 stale verdict/status 语义，不要只查是否还有 backlog。
- 外部 README 数字自相矛盾时保留 range；不要让营销数字驱动架构裁决。
- 外部 evaluator 的 adversarial audit 可借 checklist 语言，但不要搬 scoring/profile/report-dir 等 harness 负担。

### 创建/更新的本能
- 无新增本能，复用 `documented-claim-vs-code-reality-drift`。

### 解决方案文档
- 更新 `docs/solutions/2026-06-15-moai-adk-eval.md`。
