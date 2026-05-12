---
title: "gstack 分析 sprint reframe 教训：sibling-evaluation 易产 framework-building 偏见"
type: solution
created: "2026-05-12"
related_sprint: "docs/plans/2026-05-12-gstack-latest-analysis.md"
related_adrs: [ADR-011, ADR-013]
related_instincts: [documented-claim-vs-code-reality-drift, mechanism-over-discipline]
tags: [sibling-evaluation, framework-building, reviewer-convergence, roi-evidence, dogfood]
---

# gstack 分析 sprint reframe 教训

## 背景

2026-05-12 `gstack-latest-analysis` sprint 评估 gstack 新功能并识别本项目可优化点。Phase 1-3 产出：9 个候选（C1-C9）+ 5 个内省项（I1-I5）+ ROI 前 3（C1 destructive hook / C2 phase warmup lint / C5 retro delta）+ 6 个显式拒绝 + 草拟 ADR-014。

**Phase 4 4 个 reviewer 中 3 个独立给出根本性 reframe 建议**（不是表面修改）：

- scope-guardian: "Sprint has drifted into framework-building"
- product-lens: "应输出 21 命令使用率审计 + positioning 决策，而非 9 个 gstack 候选"
- adversarial: "Not defensible as written. ROI #1 数据捏造，ROI #2 分母错"

用户选择 path-2 reframe。Phase 4 后新增 Task 7（21 命令使用率审计）+ Task 8（positioning 决策），全面降级原 ROI 第 1/第 2，取消 ADR-014，将原 🔴 C7 升级 🟡 with scope。

## 收获的经验

### L1 — Sibling-evaluation sprint 的"framework-building 偏见"

**模式**：用户问 "X 项目新功能 + 我们可优化点" 这类研究问题时，sprint 容易自动生成 4-5 层抽象（吸收度对照 / 4 原则对照 / 三问框架 / ADR 候选）。用户没要这些，是 sprint 内部"为了系统性"自发增生。

**触发场景**：
- 评估"同源 sibling 项目"（gstack/gbrain）
- 评估"已部分吸收的方法论源头"
- 在 ADR-011 之类"评估必须严谨"的规则下

**识别信号**：
- 候选数 > 用户原问题中明示的关注点数
- 抽象层数 ≥ 3（候选 + 内省 + ROI 框架 + ADR 候选 + 三问框架）
- ROI 评估周期 = 5 年（明显超出 solo 项目的实际规划地平线）

**纠偏**：
- Phase 1 think 阶段就明示 "用户原问题 N 个 facet → sprint 最多输出 N+1 个抽象层"
- Phase 4 必须 spawn scope-guardian（不仅 product-lens / adversarial）
- 任何 sprint 产 ADR 候选时，**追溯证据 N**（本案 N=2 + 一个 degenerate），N<3 直接 defer

### L2 — Mechanism 提案的 ROI 分子必须有真实事件证据，不能是 Fermi 估计

**反例（本 sprint）**：C1 destructive hook ROI 第 1，理由 "年频 1-3 次拦截"。adversarial reviewer `grep "rm -rf|DROP TABLE|force-push|accident|误删" debugging-gotchas.md` **零命中** → ROI 分子是猜测。

**规则**：
- 任何 mechanism 提案（hook / lint / pre-commit）的 ROI 分子必须 grep 真实事件：`debugging-gotchas.md` / `docs/solutions/*.md` / git log / issues
- 若零命中，定级降为 ⏸ "推迟到真实事件触发"
- "未来 5 年估算" 不替代 "过去 7 个月实证"

**与 [[documented-claim-vs-code-reality-drift]] 本能呼应**：本能说 "已修 claim 必须 grep 验证"，本规则说 "ROI claim 必须 grep 证据"。同源思想，扩展应用面。

### L3 — Enforcement 提案必须 dogfood inline 检查

**反例**：本 sprint 提议 phase warmup lint（C2/I1），证据 "落地率 2/20+"。adversarial reviewer 发现 **本 sprint 文档自己也无「下一 Phase 预热」段**（预热段在对话里，不在 doc）→ 提 lint 的人就是被 lint 的人。

**规则**：
- 任何 enforcement 提案（lint / gate / hook）在 Phase 3 完成前，必须 grep / 读本 sprint 文档自己有没有违反它要 enforce 的规则
- 若违反，两个可能：(a) 规则不可行 → 改规则；(b) 规则可行但人惰性 → enforce 之前先手动遵守 3 次
- **dogfood 检查应该在 Phase 3 末尾、Phase 4 review 开始前自动跑**

**与 ADR-013 关系**：ADR-013 "dogfood 必须枚举边界产物" 防"误拒既存"（pre-commit 上线第一天阻塞旧 plan）。本规则防"漏拒提议者自己"（lint 上线第一天放过提议者本人的违规）。两条互补，可考虑合并为 ADR-013 §B。

### L4 — Sibling 项目评估必须含 positioning 决策维度，不止候选评估

**反例**：本 sprint 原 Phase 1-3 框架完全没问 "gstack N=23→30+ 是 positioning move，本项目要不要跟"。product-lens reviewer F1/F5 指出这是核心遗漏。

**规则**：
- 评估同源 sibling 项目时，Phase 2 plan 必须含至少 1 个 Task = "positioning 决策"
- positioning 决策的输出格式：6 维对比矩阵（命令数 / 核心方向 / 目标用户 / 运行时 / 持久化 / 价值假设）+ 显式声明"跟随 / 不跟随 / 部分跟随"
- positioning 决策应该在候选评估**之前**，因为它定方向，候选评估只是执行

### L5 — Observation 单 session 100% 但跨 session 聚合 0 是结构性缺口

**取证**：`~/.claude/homunculus/projects/8331ab9c2853/observations.jsonl` 252 entries 全部来自本 sprint 一个 session（earliest = 2026-05-12T13:04）。observe.js 已写、4-hook 已部署、但**无跨 session 聚合脚本**（如 `scripts/usage-report.js`）。

**影响**：
- `/review-learnings` `/session-summary` 只读单 session，看不到跨 sprint 趋势
- "60 天未用命令" 类问题当前不可观测，要靠 docs proxy
- gstack `/retro` 的 JSON snapshot + delta 模式（C5）的真问题映射就在这里

**建议动作**（不在本 sprint 实施，作为后续 sprint 输入）：
- 新建 `scripts/usage-report.js` 聚合 observations.jsonl 跨 session
- 集成到 `/review-learnings` 加 `--usage` flag
- 维护表面 ~80 行

### L6 — Reviewer 收敛是高价值信号，不是噪声

**模式**：本 sprint 4 reviewer 中 3 个（scope-guardian / product-lens / adversarial）独立给出 reframe 建议。Coherence 提出 7 个具体 P0/P1 但没建议 reframe。

**信号强度阶梯**：
- 4/4 reviewer 收敛 → 必须 reframe
- 3/4 收敛 → 强烈建议 reframe（本案）
- 2/4 收敛 → 至少调整 ROI 排序
- 1/4 提出 → 单条 P0 处理

**反模式**：把 reviewer 收敛当 "几个 P0 列表分别处理"，会漏掉 reframe 信号。

## 应用建议

### 立即应用（修订本 sprint 或下个 sprint）

1. **sprint.md 命令更新**：Phase 4 review 报告必须含 "reviewer 收敛分析" 段（统计独立提出 reframe 的 reviewer 数）
2. **review.md 命令更新**：sibling-evaluation 类 sprint 必 spawn scope-guardian + product-lens + adversarial + coherence（4 必备）

### 中期应用（30 天内）

3. 新建 `scripts/usage-report.js` 跨 session 聚合（L5）
4. 实施 21 命令使用率审计的具体动作（已建未用 4 命令移 experimental/）

### 长期观察（≥3 月）

5. 若再有第 3 个 sibling-evaluation sprint（且非 degenerate），评估是否 propose 正式 ADR-014（吸收度对照表必填）
6. 评估 dogfood inline 检查是否能合并到 ADR-013 §B

## 关联本能更新

- [[documented-claim-vs-code-reality-drift]]: confidence 0.85 保持，应用面扩到 ROI 分子（不只是 "claim 已修"）
- [[mechanism-over-discipline]]（隐含本能）: confidence -0.1 至 0.75 — 不是所有 discipline 缺口都该转 mechanism，先看是否是 **产品信号被误读为 enforcement gap**
- [[sibling-evaluation-defaults-to-framework-building]]（新本能候选）: confidence 0.7, N=2

## 关联 ADR

- ADR-011 identity-question-first: 复用通过，product-lens reviewer 强制规则验证有效
- ADR-013 dogfood 边界产物枚举: 考虑加 §B "enforcement 提案必须 inline dogfood 自检"
- ADR-014（吸收度对照表）: 取消，推迟到 N≥3
