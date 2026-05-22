---
title: "GSD eval 5 follow-up trigger 状态复查 + 下次触发即下沉标记"
type: sprint
status: planning
created: "2026-05-22"
updated: "2026-05-22"
tasks_total: 3
tasks_completed: 0
tags: [sprint, sibling-eval-followup, trigger-audit, anti-drift]
aliases: ["gsd-eval-trigger-audit", "follow-up status check"]
sources:
  - docs/plans/2026-05-21-gsd-eval.md
  - docs/solutions/2026-05-21-gsd-eval.md
  - scripts/validate-gsd-eval-docs.js

# === Anti-Drift 扩展字段 ===
invariants:
  - "prior sprint (2026-05-21-gsd-eval) 5 follow-up trigger 不可弱化 (evidence-based-recalibration §Step1)"
  - "trigger 未达标不下沉 enforcement (mechanism-over-discipline 反向应用)"
  - "本 sprint 不实施任何 follow-up (Phase 1 用户已确认 scope)"

invariant_tests:
  - "node scripts/validate-gsd-eval-docs.js"

deferred: []
deadcode_until: []
---

# GSD eval 5 follow-up trigger 状态复查

> **Status:** `draft`
> **Created:** 2026-05-22
> **Updated:** 2026-05-22

---

## 需求分析

### 用户请求原文
> 分析下 docs/plans/2026-05-21-gsd-eval.md / docs/solutions/2026-05-21-gsd-eval.md / scripts/validate-gsd-eval-docs.js，需要将 gsd 更好的融合接入到当前的架构

### Phase 1 用户 clarify

提问 4 选项 (严格按 trigger / 提前下沉 1 项 / 思想吸收 / 重新挑战) → 用户选 **"严格按 trigger 等待"**。

### 身份界定 (ADR-011)

TP = developer-toolchain self-evolution sibling for solo-maintainer。prior sprint 已实证 0 直接实施合理 + 5 grep-able trigger。本 sprint 不重新挑战该结论, 仅复查 trigger 状态 + 明示"下次触发即下沉"。

### 要做 (Scope)

1. 验证 follow-up #4 `/review-gap-detection` 的 6th 视角触发计数 (Grep 跨 sprint Phase 4 review 段中"集成连续性"/"未覆盖 invariant"/"6th 视角")
2. 在 prior solution doc (`docs/solutions/2026-05-21-gsd-eval.md`) Prevention §待升级段加 trigger 状态表, 明示 N=3 的两项 (plan-checker-reviewer-spawn, forensics-audit) "下次触发即下沉"
3. 必要时更新 `scripts/validate-gsd-eval-docs.js` 守住新 trigger 状态表存在性

### 不做 (Non-scope)

- ❌ 不实施 plan-checker-reviewer-spawn (即使 N=3, 距 trigger 仅 1)
- ❌ 不实施 forensics-audit / secret-scan / token-cost-summary / /review-gap-detection
- ❌ 不修改 prior sprint 决策表 (#1-#17 行)
- ❌ 不动 instinct 注册 (6 本能已注册不动)
- ❌ 不动 enforcement / pre-commit hook
- ❌ 不重新评估 GSD (prior sprint 结论 = 不可变 baseline)
- ❌ 不引入新 follow-up (5 项已 frozen)

### 成功标准

- [ ] 6th 视角实证次数明确 (grep 数字 + 文件清单)
- [ ] prior solution doc Prevention 段含 trigger 状态表 (5 行, 每行: trigger / 当前值 / 距 trigger / 下次触发动作)
- [ ] `validate-gsd-eval-docs.js` 不退化 (或追加 1 项断言守新表)
- [ ] 本 sprint 文档 status: completed (任务 100% 完成)
- [ ] 0 个 follow-up 在本 sprint 内实施

### 风险和假设

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 6th 视角触发计数有歧义 (什么算"未覆盖 invariant 破坏") | 中 | trigger 计数错 | 显式列出 grep pattern + 人工逐条确认; 若歧义不可消除, 标"待下次实证再判" |
| 用户其实想要更多 (1-2 task 不够) | 低 | 本 sprint 完成后立刻又开新 sprint | Phase 1 clarify 已显式选 scope; 信用户判断 |
| validate-gsd-eval-docs.js 改动引入新断言但本仓库现状违反 | 低 | hook fail | 按 ADR-013 §B, 改之前先 dogfood: 跑现状, 确认 pass; 必要时 grandfather |
| 用户后续质疑"为什么 N=3 不下沉" | 中 | 复议 | trigger 状态表写明"下次触发即下沉"的明确动作; 本 sprint 不解释, 引用 evidence-based-recalibration §Step1 |

### 关键假设 (待 Phase 2 验证)

- H1: prior solution doc Prevention 段是合适的位置 (vs 新建独立 trigger-status.md) → Read prior doc 确认
- H2: validate-gsd-eval-docs.js 可加 1 行断言守新表 (现有 13 个 fail() 断言模式可复用)
- H3: 6th 视角"集成连续性"在历史 sprint Phase 4 review 段实际触发次数 (推测: 仅 gsd-eval 本身 1 次, 因协议是 2026-05-21 才正式上 review 文档)

---

## 下一 Phase 预热（Phase 2: Plan）

关键文件: `docs/solutions/2026-05-21-gsd-eval.md` (Prevention §待升级段, 约第 130 行) + `scripts/validate-gsd-eval-docs.js` (现有断言模式)
执行命令: `Grep "集成连续性|第 6 视角|未覆盖.*invariant" docs/solutions/ docs/plans/` 实证 6th 视角触发计数
风险预判: 6th 视角是 2026-05-21 才命名的概念, 历史 sprint 不会用此名; 需放宽 grep pattern 找语义等价表达

---

## 技术方案

### 入场扫描 - Invariants 继承

| 子系统 | 来源 sprint | invariant | 本 sprint 如何保持 |
|--------|------------|-----------|-------------------|
| sibling-eval follow-up | 2026-05-21 gsd-eval | 5 follow-up trigger 不可弱化 | 本 sprint 不实施任何 follow-up |
| sibling-eval | 2026-05-18 recalibration | 实例计数 + detection signal grep-able | trigger 状态表全 grep-able pattern |
| enforcement | ADR-013 §B | 边界产物枚举 + 三档负样本 dogfood | T3 跑 pass/break-test/break-impl |
| anti-drift | sprint.md §跨 Sprint 防漂移 | 入场 checklist 三项 | 本段已含 |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| solution Prevention §待升级 | Edit 加 trigger 状态表 | 无 | ✅ docs/solutions/2026-05-21-gsd-eval.md | ✅ git tracked |
| validate-gsd-eval-docs.js | Edit 加 section assert | node CLI | ✅ scripts/ | ad-hoc (未挂 hook) |
| 本 sprint plan doc | Phase 3 进度更新 | 无 | ✅ docs/plans/ | ✅ git tracked |

注: `validate-gsd-eval-docs.js` 当前未挂 pre-commit-check.js, 是 ad-hoc 脚本 (`node scripts/validate-gsd-eval-docs.js` 手动跑)。改它不影响 enforcement, 是 anchor doc 守护。

### 入场扫描 - 半完成债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| 2026-05-21 gsd-eval | 5 follow-up 全部 | 本 sprint 不实施 (0 trigger 达标) | trigger 达标即下沉 |
| 2026-05-21 gsd-eval | `evidence-based-recalibration` 毕业为 ADR-016 候选 | 不本 sprint 处理 (confidence 0.90 未到下次复用) | 下次 sibling-eval +1 |

### 关键假设验证 (ADR-012)

| 假设 | 验证方式 | 结果 |
|------|---------|------|
| H1: prior solution Prevention §待升级段是合适位置 | Read line 129-135 | ✓ 5 项列表结构, 加表格不冲突 |
| H2: validate 脚本可加 section assert | Read line 95-139 模式 | ✓ `section() + countLines/tableDataRowCount` 模式可复用 |
| H3: 6th 视角实际触发次数 | Grep "集成连续性\|第 6 视角\|未覆盖.*invariant" docs/ + 区分定义 vs 实例 | ✓ 4 hit 全是协议定义 (line 83/134 gsd-eval solution + line 369/416 gsd-eval plan), 实际触发 **N=0** |
| H4 (新): validate 改前跑现状必 pass | `node scripts/validate-gsd-eval-docs.js` baseline | 待 T3 验证 |

### 方案概述

3 task 完成 trigger 状态明示 + 守护。

**核心改动**: prior solution doc Prevention §待升级段 5 个 `- **xxx**: ...` 列表项升级为 markdown 表格 (status + 当前值 + 距 trigger + 下次触发动作 4 列)。原 5 行散文 → 5 行表格行, 保持 grep-able 同时给"距 trigger 仅差 N"明确信号。

### 任务拆解

- [ ] **Task 1 [P]**: Edit `docs/solutions/2026-05-21-gsd-eval.md` Prevention §待升级段, 把 5 个列表项重写为 markdown 表格 (5 行 × 4 列)
- [ ] **Task 2 [P]**: Edit `scripts/validate-gsd-eval-docs.js` 加 1 个 `section(solution, '### 待升级')` 表格 ≥5 行的 assert
- [ ] **Task 3**: 三档负样本 dogfood (a) baseline pass, (b) break-test (临时改阈值 ≥10 → fail), (c) break-impl (临时减表为 4 行 → fail)

T1+T2 改不同文件可并行。T3 依赖 T1+T2 完成。3 task ≤ 5, 不会触发自动 checkpoint。

### 测试策略

- 单元: 无 (无新业务逻辑)
- 集成: `node scripts/validate-gsd-eval-docs.js` (frontmatter invariant_tests 字段)
- 手动验证: T3 三档负样本 (ADR-013 §B mechanism-over-discipline)
- Dogfood 边界产物: 仅 1 个 anchor doc (`docs/solutions/2026-05-21-gsd-eval.md`), 无其他同类产物会被新 assert 误拒

### 涉及文件

只读勘察 (已完成):
- `docs/solutions/2026-05-21-gsd-eval.md` line 118-142 (Prevention 段全段)
- `scripts/validate-gsd-eval-docs.js` line 95-139 (尾部 assert 模式)

写入:
- `docs/solutions/2026-05-21-gsd-eval.md` Prevention §待升级段 (改表格)
- `scripts/validate-gsd-eval-docs.js` 尾部加 ~5 行 assert
- `docs/plans/2026-05-22-gsd-eval-followup-trigger-audit.md` (本文档, Phase 3 进度)

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Edit 破坏 solution doc status: completed invariant_tests | 低 | validate fail | T1 后立即跑 validate baseline; H4 验证 |
| validate 新 assert 与现有 13 assert section regex 冲突 | 低 | 误拒 | 复用 `section(solution, '### 待升级')` (已存在 section); 跑 baseline 先 |
| 改 prior sprint solution doc 看似回退 status: completed | 中 | dogfood failure | doc 改动是"trigger 状态注释补充", 不修改决策表/Sprint Lessons; Phase 4 review 自检 |
| 6th 视角 N=0 实证遗漏 (其他历史 sprint 用了别名) | 低 | trigger 计数错 | grep pattern 已扩展到"集成连续性\|第 6 视角\|未覆盖.{0,10}invariant"; 4 hit 逐条确认全是定义 |
| 三档负样本步骤 c (break-impl 减表行) 在 git 中留痕 | 低 | 仓库脏 | 步骤 c 跑后立即 revert; 不 commit 中间态 |

---

## 下一 Phase 预热（Phase 3: Work）

关键文件: [docs/solutions/2026-05-21-gsd-eval.md](docs/solutions/2026-05-21-gsd-eval.md):129-135 (Prevention §待升级原 5 行) + [scripts/validate-gsd-eval-docs.js](scripts/validate-gsd-eval-docs.js):95-139 (assert 模式)
执行命令: T1 完成后立即 `node scripts/validate-gsd-eval-docs.js` 跑 baseline
风险预判: T1 改 markdown 表格可能让 prior `### 待升级` section 内容结构变, validate 现有 13 assert 不命中此段, 应不冲突

---

## 实现进度

(待 Phase 3 填写)

---

## 审查结果

(待 Phase 4 填写)

---

## 复利记录

(待 Phase 5 填写)
