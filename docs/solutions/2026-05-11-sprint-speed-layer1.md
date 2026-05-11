---
title: "$sprint 执行层加速：dispatch + 模型分层 + 注入相关性 + phase-prewarm"
date: 2026-05-11
tags: [solution, sprint, performance, optimization, layer1]
related_instincts: []
aliases: ["sprint Layer 1 加速", "review dispatch matrix", "phase 间预热"]
---

# $sprint 执行层加速

## Problem

用户高频使用 `$sprint` / `/sprint`，反馈"在某些场景下还是会很慢，希望更智能化"。前置评估（2026-05-11-gbrain-gstack-analysis.md）结论：60% 痛点在执行层（Layer 1），不在架构层（Layer 3 trajectory）。

## Root Cause

`/sprint` 的耗时分布在 5 个 phase 间，主要消耗点：

1. **Review 阶段不论改动大小都跑 5 视角全套** — 改个 typo 也跑 security/perf 等于浪费
2. **所有 reviewer 都用同一模型** — 简单的 quality 检查用 Sonnet 是 3× 浪费
3. **SessionStart 注入按 confidence/date 排** — 与当前 sprint 主题无关的高 confidence 经验排在前面
4. **Phase 切换全冷启动** — Phase N 结束 → 等 'go' → Phase N+1 重新探索同一批文件

## Solution

四件事，全部完成（修订一处后）：

### T1: Risk-aware reviewer dispatch matrix（`user-level/commands/review.md`）

按 task 的 risk level 选 reviewer 子集：

| Risk | 跑的视角 | 跳过 |
|------|---------|------|
| L0 / L1 | 4 (quality) | 1 / 2 / 3 / 5 |
| L2 | 4 + 5 (quality + test) | 1 / 2 / 3 |
| L3 | 1 + 3 + 4 + 5 | 2 (perf) |
| L4 | 全套 5 | — |

不确定 risk 时**保守按 L3**。强制输出「派遣记录」段（risk 评估、跑了哪些、跳过了哪些、原因）。

### T2: Reviewer 模型分层（同 review.md）

| 视角 | 默认模型 | 强制最低 |
|------|---------|---------|
| security 🔒 | Sonnet 4.6 | **永远不用 Haiku** |
| perf / arch | Sonnet 4.6 | Sonnet 4.6 |
| quality / test | Haiku 4.5 | Haiku 4.5 |

quick reviewer (quality/test) 用 Haiku 4.5：3× 快、90% 能力、显著省 token。

### T3: SessionStart 注入相关性提升（`scripts/inject-context.js` + `scripts/lib/memory-v5.js`）

```javascript
// memory-v5.js: selectMemoryIndexEntries 新增 prioritizeTopics 选项
function selectMemoryIndexEntries(entries, config, options = {}) {
  const merged = sortMemoryEntries(mergeMemoryEntries(entries));
  const limit = config.maxIndexEntries;
  const prioritizeTopics = Array.isArray(options.prioritizeTopics) ? options.prioritizeTopics : [];
  if (prioritizeTopics.length === 0) return merged.slice(0, limit);

  const topicSet = new Set(prioritizeTopics.map((t) => String(t).toLowerCase()));
  const prioritized = merged.filter((e) => topicSet.has(String(e.topic).toLowerCase()));
  const rest = merged.filter((e) => !topicSet.has(String(e.topic).toLowerCase()));
  return [...prioritized, ...rest].slice(0, limit);
}

// inject-context.js: 探测当前活跃 sprint tags
function detectActiveSprintTags(plansDir = path.join(process.cwd(), 'docs', 'plans')) {
  // 扫 docs/plans/ 找 status: planning/in-progress/reviewing 的最新文档
  // 解析 frontmatter tags 数组，无 active sprint 或无 tags 返回 []
  // ...
}
```

**注意：tags-vs-topics 近似匹配** — sprint frontmatter `tags` 和 memory entry `topic` 是不同概念，仅当字面命中（大小写不敏感）才生效。未命中时不影响原排序。

### T4 修订版: Phase 间预热（`sprint.md` 协议 + 5 phase 命令钩子）

**关键修正**：原计划改 `scripts/agent-orchestrator/pipeline.js` 错了 — 那是 agent-loop v7 的代码，不是 `/sprint` 的代码。`/sprint` 的 phase 切换在命令文档里，模型按文档自走。

修订方案：

- `sprint.md` 新增「Phase 间预热协议」（强制格式 + 各 phase 典型内容映射）
- `think.md` / `plan.md` / `work.md` / `review.md` / `compound.md` 末尾各加「Phase 间预热钩子」段

每个 phase 报告末尾**必须**输出：

```text
## 下一 Phase 预热（Phase N+1: <名称>）
关键文件: <1-3 个 N+1 必读路径>
执行命令: <1-2 个 N+1 起步探索命令>
风险预判: <1-3 行 N+1 潜在风险>
```

让用户 'go' 时模型已经"想好"下一步，节省 N→N+1 切换的探索往返。

## Prevention

5 个元经验（写入 .claude/rules/ 各文件）：

1. **Plan 阶段必须勘察被改文件，不能纯靠假设**（ADR-012）
   - 本 sprint 两次 plan-error：CONTEXT_BUDGET 25KB 假设错（实际 12KB）、pipeline.js 改动对象错（agent-loop 非 sprint）
   - Plan 阶段就该读 1-2 个关键文件验证关键假设；省下的 30 分钟换来 work 阶段不需要返工

2. **文档级改动也是改动，需要审查**
   - L0 (纯样式/文案) 免测不适用于工作流/dispatch matrix 类文档改动
   - 这类文档改动影响范围极广（影响所有 sprint 行为），review 必须照跑

3. **scope 误判 ≠ scope creep**
   - scope creep = 执行扩张（应阻止）
   - scope 误判 = plan 错了（应停下来修正 plan）
   - 区分清楚不要硬上

4. **Propagate 必须每次都跑**
   - 6 个命令 × 4 副本 = 24 个手工 Edit 不可控
   - 用 `propagate-command-changes.js` 和 `build-codex-plugin.js`

5. **L3 dispatch 跑 4 reviewer 跳 perf，本 sprint review 已自我验证**
   - 跳过的视角必须输出原因，可追溯

## Related

- [[2026-05-11-gbrain-gstack-analysis]] — 前置评估，本 sprint 来源
- [[ADR-011]] — identity-question-first 原则（评估 trajectory 时应用）
- [[ADR-012]] — Plan 阶段勘察必读（本 sprint 提出）
- [[2026-05-09-agent-loop-caveman-audit]] — propagate 同步多副本的同类教训
