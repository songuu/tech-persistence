---
title: "sibling-eval 文档的二次评审 + 证据驱动优先级校准"
date: 2026-05-18
tags: [solution, sibling-eval, meta-process, review-pass, priority-calibration]
related_instincts: [sibling-eval-completed-status-requires-review-pass, entry-protocol-vs-lessons-archive-layering]
aliases: ["evidence-based recalibration", "sibling-eval review pass"]
---

# sibling-eval 文档的二次评审 + 证据驱动优先级校准

## Problem

`docs/plans/2026-05-18-mattpocock-skills-followup.md` 标 `status: completed`，列 4 个借鉴推荐（P1/P1/P1/P2），但实际未经任何独立 reviewer。用户挑战"分析下"后才暴露：
- 2 处 landing place 错配（vertical tracer → `/test` 应改 `test-strategy`；feedback loop → `debugging-gotchas.md` 应改 `/work`）
- 4 个推荐中 2 个优先级与实际证据不符（vertical tracer 实例数 0、deletion test 实例数 0 → 应降 P3；skill diagnose 影响系统核心 → 应升 P1）
- 1 处防御性拒绝（`handoff` 被拒"TP checkpoint 更完整"，实际 checkpoint.md 80 行只是 snapshot writer，与 mattpocock resume-side 协议解决问题的两半）

## Root Cause

[[ADR-011]] 要求 sibling-eval "必须 spawn ≥1 个 product-lens reviewer"，但是**文档协议级 enforcement**——没有工具拒绝。文档作者凭直觉给优先级，没对照过去 3 个月 `debugging-gotchas.md` 实例数据。`status: completed` 字段诚实但 metadata 撒谎："完成"被读者解读为"已被独立挑战过"，作者只是想表达"我写完了"。这是 [[documented-claim-vs-code-reality-drift]] 的镜像——文档声称 vs 实际状态漂移。

## Solution

3 步骤校准流程（适用所有 sibling-eval / architecture-analysis 类文档）：

### Step 1: 证据归类

grep 过去 3 个月 `.claude/rules/debugging-gotchas.md` + `performance.md` + 项目本能文件，按域归类实例：
- 每个推荐对应一个域（testing / debugging / architecture / skill-system / ...）
- 实例 ≥ 2 → 升 P1 或维持 P1
- 实例 = 0 且无强 detection signal → 降 P3 / 不实施
- 实例 = 0 但 detection signal 已存在 → 维持 P1（如本次反馈环优先：detection 是 `/debug-journal` 触发条件 "3+ 轮"）

### Step 2: spawn product-lens reviewer

reviewer prompt 必须含 5 类挑战：
1. 隐藏假设（"embed in existing command = lightweight = good" 是否成立？）
2. landing place（建议位置是否单一职责？还是稀释现有命令？）
3. strategic value vs novelty（与项目 identity 对齐还是 cargo-cult？）
4. detection signal（不实施时如何观察到需要？无 signal = 解决假设问题）
5. **双向挑战 absorb 和 reject**（防御性拒绝是最隐蔽 cargo-cult，本次实证 `handoff` 即此类）

输出约束：≤300 字 + 强制"if only 1 of N, which?"。

### Step 3: 原文档插入校准段

- §二次评审与优先级校准（5 子节：landing 错配 / 优先级翻转 / 错误拒绝 / 修正后顺序 / 元层学到的）
- §实施记录（在 P1 落地后追加）
- §推荐执行顺序加标注 "本节为初版推荐；已修订，保留作审计轨迹"
- §变更日志追加 "二次"/"三次" 标记

实施验证：本流程 2026-05-18 实际运行了一次，修正 2 处 landing + 翻转 2 个优先级 + 识别 1 处错误拒绝。落地 2 个 P1 patch（commit fb55246）+ cleanup（237c177）。

## Prevention

- **Status semantics 严格化**：sibling-eval 类文档标 `completed` 前自检"有无 reviewer pass 证据"。否则用 `draft` / `pending-review`。
- **优先级强制证据化**：P0/P1/P2 排序表格旁必须列"实例计数 / detection signal"列，凭直觉打分不准。
- **Landing place 检查清单**：写"嵌入 X 现有命令"前 Read 该命令验证 capacity 和职责边界；区分 entry protocol vs lessons archive（[[entry-protocol-vs-lessons-archive-layering]]）。
- **Reviewer 双向挑战**：reviewer prompt 必须显式问"任何拒绝是否防御性"，不只是"任何吸收是否合理"。

## Related

- [[sibling-eval-completed-status-requires-review-pass]] — workflow gate 本能
- [[entry-protocol-vs-lessons-archive-layering]] — landing place 决策本能
- [[ADR-011]] — identity-question-first + sibling-eval reviewer 要求
- [[ADR-013]] — mechanism over discipline（本流程也是 ADR-013 候选）
- `docs/plans/2026-05-18-mattpocock-skills-followup.md` — 本次校准的目标文档
- `docs/plans/2026-05-11-gbrain-gstack-analysis.md` — 同模式首次出现

## 后续 ADR-013 候选

若再发生"sibling-eval 标 completed 无 review pass"事件（N=3），考虑下沉为 `scripts/pre-commit-check.js` 检查：frontmatter `type: analysis` 且 `status: completed` 但文件内无 §review / §二次评审 / §reviewer 段标题 → 拒绝 commit。当前 N=2 不足以触发下沉，但已记为候选。
