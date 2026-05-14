---
title: "CLAUDE.md 解决方案索引膨胀治理 — 复用 prompt recall + 归档"
date: 2026-05-14
tags: [solution, memory-search, claude-md, prompt-recall, scope-trimming, bounded-context]
related_instincts:
  - linear-growing-always-on-must-be-bounded
  - reuse-existing-infra-before-building-new
  - documented-claim-vs-code-reality-drift
  - mechanism-over-discipline
aliases: ["claude-md-index-trim", "prompt-recall-solutions-source", "bounded-always-on"]
---

# CLAUDE.md 解决方案索引膨胀治理

## Problem

`/compound` 每次会话结束把"解决方案索引"追加到 `CLAUDE.md`。10 个月累积 15 条 / **11.7k chars / 4.3k tokens always-on 注入**，按 2.7k chars/月线性增长趋势，1 年内单 CLAUDE.md 注入将逼近 11k tokens，5 年崩。

## Root Cause

**两套并行的索引系统设计冲突**：

| 系统 | 大小控制 | 注入方式 |
|------|---------|---------|
| `CLAUDE.md` 解决方案索引 | ❌ 无界 | 静态 always-on |
| Memory v5 `MEMORY.md` | ✅ <200 行 <25KB | inject-context.js 动态按 sprint-tag 排序 |

`/compound` 把"解决方案索引"写到 CLAUDE.md 是历史路径，**职责本应归 Memory v5** —— 但即使迁到 Memory v5，详情段仍在 `docs/solutions/*.md`，纯索引迁移不解决"按 prompt 召回详情"的需求。

`agentmemory-memory-integration` plan 已完成 Phase 1 prompt-aware recall hook（`memory-search.js` + `UserPromptSubmit` hook），但 `docs/solutions/` **不在检索池**。这是 Phase 1 评估时的关键发现 —— 用户期待 prompt recall 自动覆盖，但代码现实是"基础设施就位但 source 缺一个目录"。

## Solution

**复用 agentmemory plan 已建的 prompt recall 基础设施 + bounded CLAUDE.md 索引段**：

### A) memory-search 扩 source（`scripts/lib/memory-search.js` +121 lines）

```javascript
function collectSolutionFiles(solutionsDir) {
  // 读 docs/solutions/*.md，fallback 处理无 frontmatter 的老 solution（15/16 有，1/16 fallback）
  // - date 优先级：frontmatter date → filename YYYY-MM-DD prefix → 空
  // - title 优先级：frontmatter title → body h1 → filename stem
}

function scoreSolution(entry, query) {
  // keyword * 2.0 (vs memory entry 1.5) — solution 是手写高密度精炼，关键词匹配是最强信号
  // + pathScore * 1.5 + recency * 0.5 + confidence(0.7) * 0.4
}

function searchMemory({ cwd, ... }) {
  const solutionsDir = cwd ? path.join(cwd, 'docs', 'solutions') : null;
  // solutions 与 memory/sessions/instincts 各自独立 top-k，互不挤占
  return { memory, sessions, instincts, solutions, query, limits };
}
```

`prompt-submit.js` 调用时传 `cwd: process.cwd()` —— solution 自动进检索池。

### B) CLAUDE.md 索引段 bounded（`scripts/archive-claude-solutions-index.js` 263 lines）

每次 /compound 写新条目后跑：

```bash
node scripts/archive-claude-solutions-index.js  # idempotent, default keep=5
```

- 索引段 ≤ 5 条 → noop
- > 5 条 → 老条目（按 dateNum 降序）移到 `docs/archives/CLAUDE-solutions-index-<YYYY-MM-DD>.md`
- backup `CLAUDE.md.bak.<ts>` 保险
- sentinel anchor `### 解决方案索引` 缺失 → exit 1 拒绝修改

### C) /compound 协议升级（`user-level/commands/compound.md` step 2.5）

写完新索引行后**必须**调用归档脚本。这是 LLM 协议级（不是 deterministic enforcement），靠 SKILL.md 提示模型遵守。

## Prevention

### 已落地

- **44 测试覆盖**（26 memory-search + 15 archive script + 3 live smoke）保护下次回归
- **C2 fix 含负样本测试 (U7)**：mergeArchiveContent fallback 路径 archived_count 同步 — 防 silent count drift
- **C7 + sentinel-strict** 抵御 destructive ops：脚本 anchor 缺失 → exit 1 而非破坏 CLAUDE.md

### 待升级（follow-up）

- **/compound step 2.5 是 LLM 协议**，无 deterministic enforcement。如果 N 次会话发现 /compound 没自动跑归档 → 升级为 pre-commit checker（"CLAUDE.md 索引段 > 5 条 → 拒 commit"）
- **prompt-recall e2e 仅 manual smoke**（3 个真实关键词）。如果将来需要 CI 保护 → 加 stdin-driven prompt-submit.js 集成测试
- **mcp/lib 副本同步**已通过 build 自动处理（验证：`generated 8 mcp runtime files`），但未来如果 mcp 服务长出独立 source 需要 propagate-mcp-lib 脚本

## Measurements

| 维度 | 修复前 | 修复后 |
|------|-------|-------|
| CLAUDE.md 总字符 | 17381 | 12479 (**-28%**) |
| 解决方案索引段字符 | 11907 (67% 文件体积) | 7005 (-41%) |
| 索引条目数 | 15 | 5 (+ archive 10) |
| Always-on token 注入 | ~4345 tokens | ~3120 tokens (**-1.2k/session**) |
| docs/solutions/ 召回 | 0 (不在检索池) | 16/16 文件可召回 |
| 增长速度 | 线性 ~2.7k chars/月 | **bounded**（恒定 5 条 + archive 外溢）|

## Validation

```bash
# 26 memory-search self-test (含 5 新 solution scenarios)
node scripts/test-memory-search.js  # 26/26 pass

# 15 archive script self-test (含 C2 fix 负样本验证)
node scripts/test-archive-claude-solutions.js  # 15/15 pass

# 3 端到端真实关键词 smoke
echo '{"prompt":"plugin migration hook 双触发"}' | node scripts/prompt-submit.js
# → 召回 2026-05-14-plugin-migration-cascade-cleanup.md ✓
echo '{"prompt":"pre-commit checkPlanScope enforcement"}' | node scripts/prompt-submit.js
# → 召回 2026-05-12-pre-commit-defense.md ✓
echo '{"prompt":"windows hook nul 污染"}' | node scripts/prompt-submit.js
# → 召回 nul-hook-shell-mismatch + instinct 0.88 ✓
```

## Sprint Lessons

1. **Linear-growing always-on context must be bounded** — 任何写入并自动注入 system prompt 的索引 / 列表 / 缓存类内容，N 年后必然崩。设计时必须问"上界在哪"。当前态可接受不等于设计可接受。
2. **Reuse existing infra before building new** — agentmemory plan 已建的 prompt recall 是"基础设施待补 source"，不是"需要新框架"。复用 memory-search 加 source path（<200 行）比"把 CLAUDE.md 索引迁到 Memory v5"（要改 /compound 写入路径 + 历史迁移）成本低且更彻底。识别"基础设施 vs 新框架"是 sprint 设计阶段的关键判断。
3. **C2 fix 是 [[mechanism-over-discipline]] 的活样本** —— 发现 fallback 路径 silent count drift 后，**修复 + 负样本 self-test (U7) 同步落地**，而不是"记得多检查"。这是 [[ADR-013]] dogfood 边界产物枚举的实践（U7 模拟 archive 文件结构异常的边界态）。
4. **agentmemory plan 5 个 claim 文件全实在** —— Phase 1 时验证 `memory-search.js / prompt-submit.js / memory-tools.js / memory-mcp-server.js / memory-export.js` 全部存在，是 [[documented-claim-vs-code-reality-drift]] 的**反例**。该本能 N=3 复现后置信度 0.92，但本 sprint 验证 it's not universal — 用 grep verify 的 plan claim 可以信任。

## Related

- [[2026-05-14-claude-md-index-via-prompt-recall]] — 本 sprint 文档
- [[2026-05-14-agentmemory-memory-integration]] — 本 sprint 复用的基础设施 plan
- [[documented-claim-vs-code-reality-drift]] — 本 sprint 反例
- [[mechanism-over-discipline]] — C2 fix + U7 负样本测试
- [[sibling-evaluation-defaults-to-framework-building]] — 复用 vs 新框架的判断
- [[ADR-013]] — dogfood 边界产物枚举（archive script 5 场景 + U7 内部模拟）
