---
type: archive
archived_from: CLAUDE.md
archived_section: "解决方案索引"
archived_at: "2026-05-18"
archived_count: 2
tags: [archive, solutions-index]
---

# CLAUDE.md 解决方案索引归档（2026-05-18）

本文件存放 2026-05-18 由 `scripts/archive-claude-solutions-index.js` 从 `CLAUDE.md` 归档出的 1 条旧索引条目。

完整 solution 文档仍在 `docs/solutions/`，本文件仅留索引行作历史回溯。

## 归档条目

- [2026-05-14] [sibling-evaluation/spec-kit/reviewer-loop-closure] spec-kit (98.8k stars SDD) 借鉴评估按 [[ADR-011]] 4 不可妥协原则筛 10 项 → 初判 1 借 9 拒；Phase 4 product-lens reviewer 发现漏判脊椎"契约边界要显式标注"（不是表面的 contracts/ 目录），AskUserQuestion 后用户选 B 扩 scope-2 同 sprint 实施 T6-T9 → 最终 **2 直接借鉴**（`[P]` 并行标记 + 契约接口条件性段）+ **1 思想吸收**（constitution gate 映射到现有 ADR/rules/pre-commit）+ **7 拒绝**（constitution.md 文件 / 多文件 artifact / feature 编号 / /implement / 30+ CLI / data-model.md / /clarify）。`[P]` 协议在本 sprint 内 dogfood **2 批同轮 3 Edit**（T1+T2+T3 / T6+T7+T8）证明 LLM 端可执行；plan.md §2.5 含 3 条判定（集合交集=∅ + 无未完成依赖 + 风险≤L2）+ 4 正反例 + agent-loop --pipeline 边界；work.md 含 4 步冲突检测算法 + 失败传播 + 4 禁止行为；TEMPLATE.md / plan.md §2.6 加契约接口段（4 类触发条件 OR 关系）。3 reviewer 并行评级：product-lens B / coherence ✅ / dogfood C→B(5 P0 修后)。新本能 [[sibling-evaluation-reviewer-loop-can-close-in-sprint]] + [[contract-boundary-explicit-annotation-before-multi-copy-change]]。指标：sprint scope 5→9 task / 12 文件 +1010 -23 / pre-commit 通过 3 轮 → `docs/solutions/2026-05-14-spec-kit-eval.md`

- [2026-05-14] [analysis/plan-revision/self-codebase-drift] agentmemory 接入 plan v0.2 修订 sprint 暴露 [[documented-claim-vs-code-reality-drift]] **镜像**——「自家文档（plan）声称 vs 自家代码现实」漂移：原 plan 把 `selectMemoryIndexEntries` 当"非 query-aware search"，实际 2026-05-11 sprint speed layer1 已加 `prioritizeTopics`（sprint-tag 重排）；漂移源 = 起草者凭 weeks 前记忆而非凭 grep。3 ADR 联合应用（ADR-011 身份界定 + ADR-012 关键假设验证 + ADR-013 §B dogfood 边界）补 §0「项目身份界定 + 4 条不可妥协原则 + agentmemory 定位表」/ §0.5「关键假设验证（4 已勘察 + 5 待验证）」/ §15 changelog + 修正 §2.3/§2.4/§6.3 与 sprint-tag 重排层的协同关系（prompt-recall 复用 `detectActiveSprintTags()` 信号 + 二次评分 + 与 SessionStart 注入去重 3 候选方案）；Phase 4 review 2 P0 一次直修（README "7 处" → "6 处" 数字虚 + 凭空 `injection-log.jsonl` → 3 候选方案）；新增本能 `feedback_grep_self_codebase_before_analysis.md`：写技术 plan / 分析外部方案前必须 `git log --since='3 months ago'` 近期变更，避免基于旧版认知评估新方案 → `docs/plans/2026-05-14-agentmemory-memory-integration.md`
