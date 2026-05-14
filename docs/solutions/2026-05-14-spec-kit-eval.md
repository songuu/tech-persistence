---
title: "spec-kit 评估 — 借鉴 2 项 + reviewer 闭环 + 契约边界协议层补强"
date: 2026-05-14
tags: [solution, sibling-evaluation, spec-driven-development, sdd, parallel-task-marker, contract-boundary, reviewer-loop, identity-question-first]
related_instincts:
  - sibling-evaluation-reviewer-loop-can-close-in-sprint
  - contract-boundary-explicit-annotation-before-multi-copy-change
  - sibling-evaluation-defaults-to-framework-building
  - reuse-existing-infra-before-building-new
aliases: ["spec-kit-eval", "speckit-borrowing-decision", "parallel-marker-protocol", "contract-boundary-plan-section"]
---

# spec-kit 借鉴评估 sprint — 2 借鉴 + 1 思想吸收 + 7 拒绝

## Problem

用户请求："结合当前的架构，分析下 [github/spec-kit](https://github.com/github/spec-kit)，看下有没有可以借鉴的地方"。

spec-kit 是 GitHub 出品的 Spec-Driven Development (SDD) 工具链（98.8k stars，每日 commit）：constitution → specify → clarify → plan → tasks → implement 命令链 + `.specify/specs/{N}-{feat}/{spec,plan,tasks,contracts,data-model,quickstart}.md` 多文件 artifact + 30+ AI 代理支持。

tech-persistence 是**自学习工程系统**（developer-toolchain self-evolution sibling），已有 5-phase sprint (think→plan→work→review→compound) + 4 hook 自学习 + Memory v5 + agentmemory + 双 runtime（Claude Code + Codex）副本。

**核心矛盾**：spec-kit 看似覆盖度高，本项目身份特殊。**默认推理倾向**是 framework-building（[[sibling-evaluation-defaults-to-framework-building]]）—— 容易"导入表面、拒绝脊椎"。

## Root Cause

LLM 评估外部 sibling project 时的 3 个失效模式：

1. **身份模糊**：不先回答"本项目是什么"，直接进入"挑哪几个借鉴"，导致 ROI 用错坐标（speed-wins 偏向，solo-maintainer 成本曲线被忽略）
2. **脊椎/表面混淆**：把外部项目的**外在产物**（constitution.md / contracts/ 目录）当作"借鉴脊椎"，错过真正的**执行点**（plan 时事前 alignment / 契约边界显式标注）
3. **拒绝面过宽**：拒绝整套 spec-kit 多文件 artifact 时，把"契约边界要标注"这个**正交脊椎**也一并拒绝；本应保留思想

## Solution — 3 层防御

### A) Identity-question-first ([[ADR-011]] 强制)

Sprint plan §0「项目身份界定」段，列出 **4 条不可妥协原则**：
- 多运行时 parity / 确定性优先 / 轻量优先 / Obsidian 兼容

每个借鉴判定**必须**列出涉及的原则。10 项决策表里 9 项明确 reference 原则 → 拒绝逻辑可追溯。

### B) 借鉴清单 — 2 项直接借鉴 + 1 项思想吸收

**借鉴点 A：tasks `[P]` 并行标记**（PR-size，~30 行）
- 加入 `docs/plans/TEMPLATE.md` 任务拆解段、`user-level/commands/plan.md` §2.5、`user-level/commands/work.md` 「消费 [P] 协议」段
- **判定 3 条件**：不同文件（集合交集 = ∅）+ 无未完成依赖 + 风险 ≤ L2
- **work 端协议**：连续处理 + 4 步冲突检测算法 + 失败传播（任 1 失败 → 立即停止剩余 [P]）+ 4 禁止行为
- **与 `agent-loop --pipeline` 边界**：协议层 ≠ orchestrator；真并发走 agent-loop
- Dogfood **2 批同轮 [P] 同时 3 文件**（T1+T2+T3 / T6+T7+T8）

**借鉴点 B：契约接口条件性段**（Phase 4 reviewer 洞察后扩 scope-2 实施）
- `docs/plans/TEMPLATE.md` 加 §「契约接口（条件性）」段，触发条件 4 类（hook-registry / orchestrator schemas / propagate transform / git tracked 派生 transform）
- `user-level/commands/plan.md` §2.6 协议明示触发即必填 + 必填理由（多运行时 parity 不可妥协）
- 与 [[ADR-014]] 协同：ADR-014 建立 hook-registry 单一语义源头，本借鉴补齐 plan 阶段事前 alignment

**借鉴思想（不新增 artifact）：constitution gate**
- spec-kit 在 plan 阶段对 constitution.md 做 ERROR-gate（事前 alignment）
- 本项目已有等价 + 更先进的实施：SessionStart 静态注入 + UserPromptSubmit 动态 recall + pre-commit-check.js deterministic enforcement
- 承认 H8 实证的真实 gap：ADR 引用仅 4 次，事前 alignment 维度有空白；future follow-up `checkPlanAdrReference` 立项条件可观察化为 2 信号

### C) 拒绝清单 — 7 项（按身份原则筛掉的表面）

| 拒绝项 | 涉及原则 |
|--------|---------|
| `constitution.md` 强制创建 | 轻量优先（CLAUDE.md + ADR 已等价） |
| 多文件 artifact 拆分 | 轻量优先 + Obsidian 兼容 |
| feature 编号 `.specify/specs/{N}-{name}/` | 与日期流冲突 |
| `/implement` 一键执行 | 已等价（/work + 风险评估） |
| `specify init --integration=<agent>` 30+ 代理 CLI | 用户面窄 |
| `data-model.md` 独立文件 | 与单文件流冲突（思想已通过契约段借鉴） |
| `/clarify` 独立命令 | ADR-012 + ADR-013 §B 已更严格 |

## Reviewer 即时闭环（核心方法论收获）

Phase 4 由 3 个并行 reviewer 审查：
- **product-lens**（[[ADR-011]] 强制）：评级 B — 发现"漏判契约边界脊椎"
- **coherence**：评级 ✅ — 12 文件 sha256 对齐
- **dogfood-validity**：评级 C → B（5 P0 修后）

**关键决策**：product-lens 的 P0-2（契约边界）不是 fix 是新借鉴点 → 必须问用户。用户选 B（扩 scope-2 立即实施）→ 新增 T6-T9 4 task。

这是首次实证：**reviewer 反馈在同 sprint 内闭环**是可行的，前提条件 3 个：
1. Reviewer 是 product-lens / coherence / dogfood-validity 等强视角（不是泛 review）
2. 提议属于借鉴**脊椎**（不是新机制）
3. 实施成本 PR-size（本次 ~42 行 + propagate 自动）

不满足任一 → 留 follow-up。

## Prevention

### 已落地

- **Sprint plan §0 项目身份界定** + 4 不可妥协原则（[[ADR-011]] 强制）→ 每次 sibling evaluation 必填
- **Sprint plan §2 关键假设验证** + 10 H1-H10 验证（[[ADR-012]] 强制）→ pre-commit-check.js anchor 校验
- **Phase 4 至少 1 product-lens reviewer** + 并行 coherence + dogfood-validity → 3 视角不可省略
- **Scope-2 扩展协议**（本 sprint 首次落地）：reviewer 找到的"脊椎+PR-size+借鉴"类 P0 → AskUserQuestion + 同 sprint 实施

### 待升级（follow-up）

- **`checkPlanAdrReference` pre-commit checker**：plan 必须 grep 出 ≥1 个 `ADR-\d+` 引用作 lint。立项条件：(a) 3+ 个 plan 收到 review 反馈含"未引 ADR" / 或 (b) 本 sprint 后 N 次新 sprint 主动评估有效性。预估 ~50 行 + smoke test
- **Multi-file task TEMPLATE 示例**：当前 TEMPLATE 示例只展示单文件 task，dogfood 回测发现多文件 task 是主流。可补强 1 行示例
- **`[P]` 批量提交 git bisect 友好性指引**：work.md 加"各 task 独立 commit 便于二分查找"

## Measurements

| 维度 | 修复前 | 修复后 |
|------|-------|-------|
| 借鉴决策清晰度 | 0（用户提问） | 10 项决策表（2 借鉴 + 1 吸收 + 7 拒绝），每项 reference 原则 |
| `[P]` 标记基础设施 | 0（H6 grep 0 匹配） | 11 文件协议（TEMPLATE + plan/work × SoT/propagate/build 4 副本） |
| 契约边界显式标注 | 0 个 plan 含 | TEMPLATE.md + plan.md §2.6 协议覆盖未来所有 plan |
| 协议层防御 | 1 层（pre-commit deterministic） | **3 层**（SessionStart 静态 + UserPromptSubmit 动态 + plan §2.5/§2.6 协议 + pre-commit 拒绝） |
| Sprint scope 灵活性 | 单线 5 task | **scope-2 扩展机制**（reviewer 闭环触发） |
| Pre-commit 通过次数 | 1 次 | 3 轮（T5 / Review fix / Scope-2） — 验证可重复 |

## Validation

```bash
# 验证协议在 4 副本同步
node scripts/pre-commit-check.js   # 0 报错 - 12 文件 sha256 对齐

# 验证 [P] 协议在 plan SoT 可见
grep -A 5 "## 2.5 \[P\] 并行标记判定" user-level/commands/plan.md

# 验证契约接口段在 TEMPLATE 可见
grep -A 8 "### 契约接口（条件性" docs/plans/TEMPLATE.md

# 验证 dogfood — 本 sprint 自身 [P] 实证
grep -c "\[P\]" docs/plans/2026-05-14-spec-kit-analysis.md   # ≥ 6 个 [P] 标记
```

## Sprint Lessons

1. **Identity-question-first 实战有效** — §0 项目身份界定 + 4 原则约束让 10 项决策有可追溯逻辑；未在 §0 出现的原则即 reviewer 检查的盲点。Sibling-evaluation 必须先回答身份问题再挑借鉴。

2. **脊椎 vs 表面识别需要 product-lens reviewer** — coherence reviewer 只能验证一致性，dogfood-validity 只能验证协议清晰度。**第一次**判错的"contracts 拒绝理由薄"靠 product-lens 才发现 → 多视角并行 review 在 sibling-evaluation sprint 不可省略。

3. **Reviewer 闭环可在同 sprint 内完成（条件性）** — 满足 3 条件（视角强 + 借鉴脊椎 + PR-size）时不必"留 follow-up"。本 sprint 是该方法论的首次实证 → 沉淀为 [[sibling-evaluation-reviewer-loop-can-close-in-sprint]] 本能。

4. **协议层是 deterministic enforcement 的前置防线** — 本项目过去重点是 pre-commit-check.js（事后拒绝）。本 sprint 实证**协议层（plan §2.5 / §2.6）作为事前 alignment** 是必要补充，与 [[ADR-013]] mechanism over discipline 不冲突而是互补 → 沉淀为 [[contract-boundary-explicit-annotation-before-multi-copy-change]] 本能。

## Related

- [[2026-05-14-spec-kit-analysis]] — 本 sprint 文档
- [[2026-05-11-gbrain-gstack-analysis]] — 上一次 sibling evaluation sprint（[[ADR-011]] 首次落地）
- [[2026-05-14-claude-md-index-trim-via-prompt-recall]] — 同日 sprint，也使用 [[reuse-existing-infra-before-building-new]] 本能
- [[ADR-011]] — Identity-question-first（本 sprint 第二次实证）
- [[ADR-012]] — 关键假设验证（H1-H10）
- [[ADR-013]] §B — Dogfood 边界产物枚举（近 3 sprint plan 不被新协议误拒）
- [[ADR-014]] — Hook-registry 单一语义源头（本 sprint 协议层补强）
- [[sibling-evaluation-defaults-to-framework-building]] — 反模式（本 sprint 抵御）
- [[reuse-existing-infra-before-building-new]] — 借鉴/拒绝判定的核心标准
