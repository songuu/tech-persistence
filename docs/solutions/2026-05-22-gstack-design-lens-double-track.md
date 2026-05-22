---
title: "gstack design-review IP 借鉴：review.md 加 design lens 条件触发 + 双轨 prompt（Spawn-capable / Inline-fallback）"
date: 2026-05-22
tags: [solution, review, design, sibling-eval, multi-runtime, codex-regex, gstack-borrow]
related_instincts: [external-skill-borrow-separate-prompt-ip-from-private-binary, codex-regex-sync-needs-runtime-neutral-idiom, propagate-needs-build-step-for-skill-wrapper]
aliases: ["design-lens-double-track", "gstack-design-borrow"]
---

# gstack design-review IP 借鉴：review.md 加 design lens 条件触发 + 双轨 prompt

## Problem

用户请求："分析和对比下 gstack 系统里面关于设计的部分，在当前的系统架构里面，有没有应用和优化的空间"。

接续 2026-05-22 Figma 1:1 还原 sprint，本项目开始处理 design 议题。2026-05-12 gstack-latest-analysis.md C4 (多角色 reviewer，含 design lens) 当时定级 🟡 部分采纳，反方理由 "本项目是开发者工具链，product/design 维度通常空（无 UI）"。Figma sprint 改变了语境 → 重新评估 C4 是否值得接入。

直接 mechanical 复制 gstack `qa-design-review` skill 不可行：该 skill **强依赖 gstack 私有工具链**（`~/.claude/skills/gstack/bin/gstack-*` / `~/.claude/skills/gstack/browse/dist/browse` binary / 写入 `~/.gstack/` 目录 / 引用 `/qa` `/setup-browser-cookies` 命令族），违反本项目 4 不可妥协·轻量原则。

## Root Cause

外部 skill 借鉴的常见误区：把 "可用的 skill" 当成 "可移植的 IP"。`qa-design-review` 价值由两部分组成：

| 组成 | 性质 | 可移植性 |
|------|------|----------|
| Design Audit Checklist (10 类 ~80 项) + AI Slop Detection (10 anti-patterns) + Critique Format (notice/wonder/what if/think because) + Scoring System (A-F + AI Slop Score) | **prompt-level IP** | ✅ 可分离 |
| `$B goto / screenshot / js / perf` (browser binary 实时抓取) + `~/.gstack/sessions` 状态 + `gstack-contributor-mode` field reports + `gstack-update-check` 自更新 + `/qa Phase 8e.5` skill 间引用 | **私有 binary + 状态依赖** | ❌ 不可移植（引入 = 违反 4 不可妥协） |

不做分离 → 要么 mechanical 复制引入私有依赖（违反原则），要么完全放弃借鉴（错过 prompt IP）。

## Solution

### 决策：C1+C4 合并为"双轨 design lens"

C4 双轨实现，按 user 决策（AskUserQuestion 选 option C "C1+C4 双轨"）：

| 端 | 实现 | 工具依赖 | 输出能力 |
|----|------|---------|---------|
| **Spawn-capable runtime** (Claude Code / 等价 Agent tool 可用) | reviewer prompt 引导调用用户级 `qa-design-review` skill | gstack browse binary (用户已装) | screenshot diff / 实时 URL 抓取 / 性能 metrics / fix loop |
| **Inline-fallback runtime** (Codex CLI) | reviewer prompt 内联精简 audit checklist (gstack IP 浓缩版 A-G 段) | 无 | 静态源代码 audit only |

### 落地位置

`user-level/commands/review.md` 改动（surgical edits）：

1. **description** 末尾加 `+ design lens 条件触发`
2. **Spawn 协议·模型分层表** 加 `design 🎨 (条件触发) | sonnet` 行
3. **风险驱动派遣段** 新增「Design lens 条件触发」子段：
   - 触发条件 5 类（视觉文件扩展名 / figma URL / commit message 前缀 / sprint frontmatter tags / PR 关键词）
   - 跳过条件 2 类（纯 dev toolchain / 仅 token 替换）
   - 增量 spawn：在 Dispatch Matrix 子集基础上 +1 design reviewer (sonnet)，不替换其他视角
4. **审查视角段** 加「视角 design 🎨（条件触发）」子段，含**双轨 prompt 模板**：
   - Spawn-capable runtime prompt 模板（调用 gstack skill）
   - Inline-fallback runtime prompt 模板（内联精简 checklist）
   - 双轨行为差异表

### Codex regex 撞车防御

源里 `Claude Code 端` / `Codex 端` 标签经 `propagate-command-changes.js` 的 codex regex 同步会双双变成 `Codex 端`（regex 把 `Claude Code` → `Codex` 也把 `Claude` → `Codex`），两段标题合并、双轨语义丢失。

**修复**：源标签换为 regex-safe idiom：

| 旧（regex 撞车） | 新（regex 不替换） |
|----------------|-------------------|
| `Claude Code 端 prompt 模板` | `Spawn-capable runtime prompt 模板` |
| `Codex 端 prompt 模板` | `Inline-fallback runtime prompt 模板` |
| `Claude Code 端 / Codex 端`（差异表表头） | `Spawn-capable runtime / Inline-fallback runtime` |
| `Codex 端无浏览器 binary` | `inline-fallback runtime 无浏览器 binary` |

并在 Spawn-capable 段加显式 **Runtime gate** 行："仅 spawn-capable runtime 执行；inline-fallback runtime 读到此段跳过"。`~/.claude/skills/design-review/SKILL.md` 路径经 regex 变成 `~/.codex/skills/design-review/SKILL.md`（codex 端不存在），段内已加注释说明 codex runtime 不应到达本段。

### 4 副本同步

```bash
node scripts/propagate-command-changes.js review
node plugins/tech-persistence/scripts/build-codex-plugin.js
node scripts/validate-codex-plugin.js
node scripts/pre-commit-check.js  # EXIT=0
```

**踩坑**：propagate 后 pre-commit-check 报 `skill wrapper mismatch`。原因：propagate 用 `injectIntoSkillWrapper` 写 plugin/codex skill，但 pre-commit-check 用 `build.transform`（来自 `build-codex-plugin.js`）比对 sha256。两个 transform 输出可能不一致（plugin skill 还有 build step 注入）。修复：必须**propagate 后再跑 build-codex-plugin.js**。

## Prevention

### 元规则：外部 skill IP 借鉴必须分离 prompt 与私有依赖

写入 [[external-skill-borrow-separate-prompt-ip-from-private-binary]] feedback memory。任何 sibling-eval 决定借鉴外部 skill 时，**Phase 2 plan 阶段强制回答**：

1. 该 skill 的价值是否可拆分为 "prompt-level IP" 与 "私有 binary / 状态依赖"？
2. 仅借鉴 prompt-level IP 能否覆盖 80%+ 的目标价值？如能 → 优先纯 prompt 集成
3. 必须用 binary 时，是否引入 4 不可妥协违反？如违反 → 要么放弃要么双轨（Spawn-capable runtime 调原 skill，Inline-fallback runtime 自研 prompt）

### 元规则：Codex regex 同步副本时 runtime 区分用 regex-safe idiom

写入 [[codex-regex-sync-needs-runtime-neutral-idiom]]。`propagate-command-changes.js` 的 codex regex 会把 `Claude Code` / `Claude` / `.claude/` / `CLAUDE.md` 全替换为 codex 对应。如果文档需要明确区分两个 runtime（双轨实现 / runtime-specific 行为差异），**不能用 `Claude Code 端` / `Codex 端` 作为标签**——会撞车。改用：

| 场景 | 推荐 idiom |
|------|----------|
| 运行时能力分类 | `spawn-capable runtime` / `inline-fallback runtime` |
| Agent tool 可用性 | `Agent-spawn-capable` / `single-context-only` |
| 既有 review.md idiom | `多视角并行 spawn 协议` / `inline 扮演 N 视角` |

源里用 idiom 后 codex 副本读起来也清晰（不再有歧义）。

### 元规则：propagate 后还需 build-codex-plugin.js 才能让 pre-commit-check 通过

写入 [[propagate-needs-build-step-for-skill-wrapper]]。Skill wrapper 的派生路径（`plugins/tech-persistence/skills/<cmd>/SKILL.md`）由 `build-codex-plugin.js` 的 `transform` 函数生成（含额外 wrapper 注入），不仅仅是 propagate 的 `injectIntoSkillWrapper`。`pre-commit-check.js::checkPropagateSync` 用 `build.transform` 比对 sha256，所以 propagate 后必须再跑 build。固化命令序列：

```bash
node scripts/propagate-command-changes.js <cmd>...
node plugins/tech-persistence/scripts/build-codex-plugin.js
node scripts/validate-codex-plugin.js
node scripts/pre-commit-check.js
```

## Validation

- 4 副本 sha256 sync：✅ pre-commit-check EXIT=0
- validate-codex-plugin：✅ 32 skills 通过
- Codex regex 不撞车：✅ grep 确认 codex 副本含 `Spawn-capable runtime prompt 模板` 和 `Inline-fallback runtime prompt 模板` 两段独立标题
- 双轨 prompt 内容完整：✅ Spawn-capable 段引用 user-level skill + runtime gate；Inline-fallback 段内联 A-G 7 类 audit checklist + AI slop pattern 10 anti-patterns

## Related

- [[2026-05-22-figma-1to1-fidelity]] — 引出 design 议题的前置 sprint
- [[2026-05-12-gstack-analysis-reframe-lessons]] — gstack eval reframe 教训
- [[ADR-011]] — sibling 项目身份界定，本案 product-lens reviewer 强制 spawn
- [[ADR-013]] — mechanism over discipline；本案外部 skill 借鉴算 mechanism 借鉴
- [[feedback_sibling_eval_default_compare_not_borrow]] — 用户显式说"接入" overrides 默认 compare-only
- [[feedback_target_user_mismatch_invalidates_borrow]] — 本案 target user 同质（dev 都需要 design audit），未触发 mismatch
- [[external-skill-borrow-separate-prompt-ip-from-private-binary]] — 本案沉淀的新本能
- [[codex-regex-sync-needs-runtime-neutral-idiom]] — 本案沉淀的新本能
- [[propagate-needs-build-step-for-skill-wrapper]] — 本案沉淀的新本能
