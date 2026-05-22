---
title: "GSD top-3 机制原生吸收实施计划"
type: sprint
status: completed
created: "2026-05-22"
updated: "2026-05-22"
tasks_total: 5
tasks_completed: 5
tags: [sprint, gsd-eval, native-absorption, context-cost, security, review]
aliases: ["gsd-top3-native-absorption", "GSD 1-2-3 absorption"]
sources:
  - docs/plans/2026-05-21-gsd-eval.md
  - docs/solutions/2026-05-21-gsd-eval.md
  - docs/plans/2026-05-22-gsd-eval-followup-trigger-audit.md

invariants:
  - "不接入 GSD runtime / 命令树 / .planning 状态模型"
  - "只吸收 1 token-cost-summary / 2 secret-scan-on-demand / 3 review-gap-detection"
  - "plan-checker-reviewer-spawn 与 forensics-audit 本轮不实施"
  - "新增机制必须按 TP 原生架构落点实现, 保持 Claude/Codex projection 同步"

invariant_tests:
  - "node scripts/secret-scan-on-demand.js --paths scripts docs user-level plugins .codex"
  - "node scripts/propagate-command-changes.js review"
  - "node plugins/tech-persistence/scripts/build-codex-plugin.js"
  - "node scripts/validate-codex-plugin.js"
  - "node scripts/pre-commit-check.js"
  - "node scripts/smoke-pre-commit.js"
  - "npm test"
  - "git diff --check"

deferred:
  - "plan-checker-reviewer-spawn"
  - "forensics-audit"
deadcode_until: []
---

# GSD top-3 机制原生吸收实施计划

> **Status:** `completed`
> **Created:** 2026-05-22
> **Updated:** 2026-05-22

---

## 需求分析

### 用户请求原文

> 先按照 1,2,3 来，制定完整的计划

### 背景解读

上一轮结论把 GSD 借鉴拆成 5 个 TP 原生机制，并建议先做：

1. `token-cost-summary`
2. `secret-scan-on-demand`
3. `/review-gap-detection`

本计划将这 3 个点从 prior follow-up backlog 提前进入实施计划。该用户指令覆盖 `2026-05-22-gsd-eval-followup-trigger-audit.md` 中“严格按 trigger 等待”的旧 scope，但只覆盖上述 3 项；`plan-checker-reviewer-spawn` 与 `forensics-audit` 仍保持 deferred。

### 要做

- 在 `scripts/inject-context.js` 中加入低成本 context 注入成本摘要，暴露 selected / injected / truncated 信息。
- 新增 `scripts/secret-scan-on-demand.js`，作为手动安全扫描入口，不默认接 pre-commit 阻断。
- 将 `/review-gap-detection` 嵌入现有 `/review` 协议，作为 walkthrough sub-step，不新增独立 `/uat` 或 GSD 命令。
- 为 3 个机制补对应测试或 smoke，避免只靠文档纪律。
- 同步 review 命令 SoT 到 `.codex`、plugin commands、plugin skill wrapper。

### 不做

- 不接入 GSD CLI / SDK / namespace routers。
- 不迁移 GSD `.planning` 状态模型。
- 不新增 GSD 风格命令族。
- 不实施 `plan-checker-reviewer-spawn`。
- 不实施 `forensics-audit`。
- 不把 secret scan 直接放入 pre-commit 强阻断，除非本轮扫描已经命中真实风险并另开 enforcement 决策。

### 成功标准

- [x] `inject-context.js` 可在接近预算或显式开关时输出 compact context cost summary，默认额外 token 成本可控。
- [x] `secret-scan-on-demand.js` 能扫描指定路径，命中时 redacted 输出 path:line + pattern id，exit 1；无命中 exit 0。
- [x] `/review` 文档包含 gap-detection walkthrough，要求说明 existing coverage / uncovered invariant / action。
- [x] review SoT 改动已传播到 `.codex/commands`、`.codex/skills`、`plugins/tech-persistence/commands`、`plugins/tech-persistence/skills`。
- [x] 新增/更新测试覆盖 pass、positive、negative 三档样本。
- [x] `npm test`、`pre-commit-check`、`validate-codex-plugin`、`git diff --check` 全绿。

### 关键假设验证

| 假设 | 验证方式 | 当前证据 | 结论 |
|------|----------|----------|------|
| H1: `token-cost-summary` 的正确落点是 `scripts/inject-context.js` 而不是 `sync-solution-index.js` | Read `inject-context.js` 与 `compound.md` | `inject-context.js` 是 SessionStart additionalContext 唯一组装点；solution index 已由 `compound.md` 管控为最近 5 条 | 成立 |
| H2: context cost summary 不应无条件增加 always-on 成本 | Read `CONTEXT_BUDGET_CHARS` 与 `addSection/renderSections` | 当前总预算 12000 chars，所有 section 都进入 `<learned-context>`；无条件追加会反向增加成本 | 成立，采用阈值/开关策略 |
| H3: secret scan 应先做 on-demand，不该直接挂 pre-commit | Read `pre-commit-check.js` 和 ADR-013 相关 solution | pre-commit 是强 enforcement；新安全扫描未 dogfood 全仓 false positive 边界，不满足直接阻断条件 | 成立 |
| H4: `/review-gap-detection` 应嵌入 `user-level/commands/review.md` SoT | Read `review.md` 与 `propagate-command-changes.js` | review 命令已有 risk-aware dispatch 与 multi-runtime fallback；SoT 变更可由 propagate 同步 | 成立 |
| H5: review 命令变更会触发多副本 projection，但不改变 transform 契约 | Read `propagate-command-changes.js` 与 `build-codex-plugin.js` | 单 SoT 命令调整不改 transform 函数，只需运行 propagation/build 并通过 pre-commit sync | 成立 |

---

## 技术方案

### 方案概述

采用“TP 原生吸收”而不是“GSD 接入”：3 个点分别落在 context observability、安全扫描脚本、review 协议三个已有子系统中。所有实现都保持 zero dependency，不引入 npm 包，不增加常驻 runtime，不改变现有 hook registry 和 orchestrator schema。

实施顺序按风险与依赖排序：先做可独立测试的 context cost helper，再做 on-demand secret scanner，最后改 `/review` SoT 并跑 projection。三个功能任务文件集合独立，可连续处理；最终由一个串行 validation task 统一兜底。

### 契约接口

本计划不修改 projection transform 规则、不修改 hook registry 契约、不修改 agent-orchestrator JSON schema。唯一涉及的 projection 是 `user-level/commands/review.md` 的内容变更，需要按现有 transform 生成派生副本。

| 契约名 | Before | After | 影响副本 / 消费者 |
|--------|--------|-------|------------------|
| review command SoT projection | `user-level/commands/review.md` 由 `propagate-command-changes.js` 投影到 `.codex` 与 plugin skill wrapper | 同一投影链路，仅 review command 内容增加 gap-detection walkthrough | `.codex/commands/review.md`, `.codex/skills/review/SKILL.md`, `plugins/tech-persistence/commands/review.md`, `plugins/tech-persistence/skills/review/SKILL.md` |
| hook additionalContext payload | `inject-context.js` 输出 `<learned-context>`，无 cost stats | 保持 JSON shape 不变；在阈值/开关命中时把 compact stats 作为普通 section 注入 | SessionStart hook consumers |
| secret scan CLI | 无 TP 原生 secret scanner | 新增手动 CLI，默认不参与 pre-commit | 人工执行、后续 enforcement 候选 |

### 任务拆解

- [x] **Task 1 [P]**: 实现 `token-cost-summary` helper 与注入策略 — 文件: `scripts/inject-context.js`, `scripts/test-inject-context-cost-summary.js` — 风险: L2
- [x] **Task 2 [P]**: 新增 `secret-scan-on-demand` CLI 与三档测试 — 文件: `scripts/secret-scan-on-demand.js`, `scripts/test-secret-scan-on-demand.js` — 风险: L2
- [x] **Task 3 [P]**: 将 `/review-gap-detection` 嵌入 review SoT 并传播副本 — 文件: `user-level/commands/review.md`, `.codex/commands/review.md`, `.codex/skills/review/SKILL.md`, `plugins/tech-persistence/commands/review.md`, `plugins/tech-persistence/skills/review/SKILL.md` — 风险: L2
- [x] **Task 4**: 集成验证与 false-positive dogfood — 依赖 Task 1-3 — 文件: `scripts/`, `docs/plans/2026-05-22-gsd-top3-native-absorption.md` — 风险: L2
- [x] **Task 5**: 更新实施进度、审查记录与后续 trigger 状态 — 依赖 Task 4 — 文件: `docs/plans/2026-05-22-gsd-top3-native-absorption.md`, `docs/solutions/2026-05-21-gsd-eval.md`（必要时）— 风险: L1

`[P]` 判定：Task 1/2/3 文件集合不重叠、无前置依赖、风险均 ≤ L2。Task 4/5 依赖前置产物，串行。

### Task 1 设计：token-cost-summary

目标：给 SessionStart context 注入一个可审计的成本摘要，但不让摘要本身成为 always-on 膨胀源。

实现要点：

- 将 `renderSections(sections)` 重构为可返回 stats 的内部 helper，例如 `renderSectionsWithStats(sections, budget) -> { text, stats }`。
- stats 记录每个 section 的 `title`、`sourceChars`、`injectedChars`、`truncated`。
- 新增 `shouldIncludeContextCostSummary(stats, env)`：
  - `TECH_PERSISTENCE_CONTEXT_COST_SUMMARY=1|always` 时强制加入。
  - `injectedChars >= 0.8 * CONTEXT_BUDGET_CHARS` 或存在 truncated section 时自动加入。
  - 低于阈值默认不加入，避免无意义增加上下文。
- summary 格式控制在 200-350 chars：
  - total selected chars
  - total injected chars / budget
  - estimated tokens，按 `Math.ceil(chars / 4)` 粗估
  - truncated section titles，最多 3 个
- 保持 stdout JSON shape 不变：仍只输出 `hookSpecificOutput.additionalContext`。
- `module.exports` 增加 helper，供测试复用。

### Task 2 设计：secret-scan-on-demand

目标：提供人工可运行的安全扫描，而不是直接新增 pre-commit 阻断。

CLI 草案：

```bash
node scripts/secret-scan-on-demand.js
node scripts/secret-scan-on-demand.js --paths scripts docs user-level plugins .codex
node scripts/secret-scan-on-demand.js --include-untracked
node scripts/secret-scan-on-demand.js --json
```

默认行为：

- 默认扫描 `git ls-files` 返回的 tracked text files。
- `--paths` 限定扫描路径。
- `--include-untracked` 才加入未跟踪文件，避免误扫本地临时垃圾。
- 自动跳过 `.git/`, `node_modules/`, `.agent-runs/`, `docs/archives/`, binary-like extensions。
- 命中输出只显示 redacted snippet，不打印完整 secret。
- exit code：
  - `0`: 无命中
  - `1`: 有 finding
  - `2`: 脚本参数或内部错误

首批 pattern：

| id | pattern intent |
|----|----------------|
| `openai_key` | `sk-...` 类 key |
| `aws_access_key` | `AKIA[0-9A-Z]{16}` |
| `generic_api_key_assignment` | `api_key = "long value"` / `api-key: long value` |
| `token_assignment` | `access_token` / `refresh_token` / `secret` / `password` 长值 |
| `private_key_header` | PEM private key header |

测试必须覆盖：

- positive：真实假 key 被发现，exit 1。
- negative：文档里的 pattern 示例 / placeholder 不误报，exit 0。
- redaction：stdout/stderr 不包含完整 secret value。
- path filtering：`--paths` 能限定扫描范围。

### Task 3 设计：/review-gap-detection

目标：把 GSD `verify-work` 的“找未覆盖 gap”思想吸收到现有 `/review`，不新增命令。

嵌入点：

- 修改 `user-level/commands/review.md`。
- 在 “风险驱动派遣” 后加入 “Walkthrough gap detection” 子段。
- 要求 review 报告在派遣记录后或 Findings 前增加小表：

```markdown
## Gap Detection Walkthrough
| workflow / invariant | existing coverage | uncovered gap | action |
|----------------------|-------------------|---------------|--------|
```

触发规则：

- L0/L1：可跳过，但必须写跳过原因。
- L2：至少检查测试覆盖与用户路径是否断裂。
- L3/L4：强制检查跨 runtime、projection、hook、state artifact、security boundary。
- 如果发现 “existing tests pass but workflow still broken” 风险，按 P1+ finding 处理。

投影命令：

```bash
node scripts/propagate-command-changes.js review
node plugins/tech-persistence/scripts/build-codex-plugin.js
node scripts/validate-codex-plugin.js
```

### 测试策略

单元测试：

- `scripts/test-inject-context-cost-summary.js`
  - budget 未接近时不加 summary。
  - env 开关时加 summary。
  - section truncate 时加 summary。
  - stats token estimate 与 injected chars 合理。
- `scripts/test-secret-scan-on-demand.js`
  - positive / negative / redaction / path filtering。

集成 / smoke：

- `node scripts/secret-scan-on-demand.js --paths scripts docs user-level plugins .codex`
- `node scripts/propagate-command-changes.js review`
- `node plugins/tech-persistence/scripts/build-codex-plugin.js`
- `node scripts/validate-codex-plugin.js`
- `node scripts/pre-commit-check.js`
- `node scripts/smoke-pre-commit.js`
- `npm test`
- `git diff --check`

手动验证：

- 运行 `node scripts/inject-context.js`，确认 stdout 仍是合法 JSON。
- 用环境变量运行 `TECH_PERSISTENCE_CONTEXT_COST_SUMMARY=1 node scripts/inject-context.js`，确认 additionalContext 中出现 compact cost summary。
- 检查 `.codex/skills/review/SKILL.md` 和 `plugins/tech-persistence/skills/review/SKILL.md` 均含 gap detection 段。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| context cost summary 反而增加 always-on token 成本 | 中 | 中 | 默认阈值触发；低成本场景不注入；summary 限长 |
| secret scan 对文档示例误报 | 高 | 中 | pattern 增加 placeholder/example 负样本测试；本轮不接 pre-commit |
| secret scan 输出泄露完整 key | 中 | 高 | redaction 测试强制 stdout/stderr 不包含完整 secret |
| review SoT 改动漏传播到 Codex/plugin | 中 | 高 | 跑 propagate + build + validate-codex-plugin + pre-commit-check |
| `/review` 文档继续膨胀，增加认知成本 | 中 | 中 | 嵌入现有 risk-aware dispatch，只增加一个小表和触发规则 |
| 新测试在 Windows sandbox spawn EPERM | 中 | 低 | 若 `npm test` 因 sandbox spawn EPERM 失败，按流程用已批准 PowerShell `npm test` 前缀重跑 |

### 涉及文件

新增：

- `scripts/secret-scan-on-demand.js`
- `scripts/test-secret-scan-on-demand.js`
- `scripts/test-inject-context-cost-summary.js`

修改：

- `scripts/inject-context.js`
- `user-level/commands/review.md`
- `.codex/commands/review.md`
- `.codex/skills/review/SKILL.md`
- `plugins/tech-persistence/commands/review.md`
- `plugins/tech-persistence/skills/review/SKILL.md`
- `docs/plans/2026-05-22-gsd-top3-native-absorption.md`
- `docs/solutions/2026-05-21-gsd-eval.md`（仅当需要把 3 项状态从 follow-up 改为 in-progress / absorbed）

---

## 下一 Phase 预热（Phase 3: Work）

关键文件：

- `scripts/inject-context.js`
- `user-level/commands/review.md`
- `scripts/pre-commit-check.js`
- `scripts/smoke-pre-commit.js`

执行命令：

```bash
node scripts/inject-context.js
node scripts/propagate-command-changes.js review
node plugins/tech-persistence/scripts/build-codex-plugin.js
node scripts/validate-codex-plugin.js
node scripts/secret-scan-on-demand.js --paths scripts docs user-level plugins .codex
npm test
git diff --check
```

风险预判：

- 最高风险不是代码复杂度，而是 false positive 和 projection 漏同步。
- Work 阶段先写纯 helper + tests，再接 CLI 和 review projection，最后统一跑全链路验证。

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-22 | Task 1 | `scripts/inject-context.js` 新增 context cost stats/helper 与阈值/环境变量触发策略；新增 `scripts/test-inject-context-cost-summary.js` 覆盖默认不注入、强制注入、截断触发、near-budget 触发。 |
| 2026-05-22 | Task 2 | 新增 `scripts/secret-scan-on-demand.js` 手动扫描 CLI；新增 `scripts/test-secret-scan-on-demand.js` 覆盖 positive、placeholder negative、path filter、JSON redaction、usage error。 |
| 2026-05-22 | Task 3 | `user-level/commands/review.md` 增加 Gap Detection Walkthrough；已运行 `propagate-command-changes.js review` 与 `build-codex-plugin.js` 生成 `.codex` / plugin 副本，并通过 `validate-codex-plugin.js`。 |
| 2026-05-22 | Task 4 | 完成 dogfood 验证：secret scan 对 `scripts docs user-level plugins .codex` clean；`inject-context.js` 默认/强制摘要输出 JSON 正常；`validate-codex-plugin.js`、`pre-commit-check.js`、`smoke-pre-commit.js`、`npm test`、`git diff --check` 通过。 |
| 2026-05-22 | Task 5 | 更新 `docs/solutions/2026-05-21-gsd-eval.md` follow-up 状态：3 项已 absorbed，2 项 deferred；运行 `sync-solution-index.js --all` 与 `validate-gsd-eval-docs.js` 通过。 |

---

## 审查结果

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| - | Work 自检 | - | 未发现 P0 | - |

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| - | Work 自检 | - | 未发现 P1 | - |

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | future | `scripts/secret-scan-on-demand.js` | 当前 scanner 为 on-demand，不接 pre-commit。若后续出现真实命中，再升级 `checkSecretScan`。 | deferred |

### 总评

3 个 GSD 借鉴点已按 TP 原生架构落地。正式 `/review` 尚未执行；本轮 Work 自检 + 自动化验证未发现阻塞项。

---

## 复利记录

### 提取的经验

- GSD 类外部机制接入时，优先拆成 TP 原生 observability / CLI / protocol 小补丁，避免引入外部 runtime 与命令面。
- 安全扫描先 on-demand dogfood，确认 false positive 边界后再考虑 pre-commit enforcement。

### 创建/更新的本能

- 无新增本能；本轮属于既有 GSD follow-up 的原生吸收。

### 解决方案文档

- 更新 `docs/solutions/2026-05-21-gsd-eval.md` follow-up 状态。
