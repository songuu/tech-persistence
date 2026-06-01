---
title: "知识抗腐化 drift checker（缺陷 E execution plan）"
type: sprint
status: completed
created: "2026-06-01"
updated: "2026-06-01"
parent: "docs/plans/2026-06-01-secondary-defects-roadmap.md"
tags: [sprint, enforcement, self-evolution, drift]
aliases: ["knowledge-drift checker", "缺陷 E plan"]
tasks_total: 5
tasks_completed: 5
related:
  - "[[2026-06-01-secondary-defects-roadmap]]"
  - "[[2026-06-01-architecture-defect-analysis]]"
invariants:
  - "block 档仅触发于「带行号 + 源码前缀(scripts/docs/plugins/user-level) + 文件不存在」（dogfood 守 0 FP）"
  - "warn 档（裸文件名 glob 0 匹配）不阻塞 commit（exit 0）"
  - "只校验引用的文件存在性，绝不校验行号值（行号必随编辑漂移）"
  - "fail-open 保留（hook 内部异常 exit 0 + stderr marker）"
invariant_tests:
  - scripts/test-knowledge-drift.js
  - scripts/smoke-pre-commit.js
deferred:
  - sprint: "缺陷 E follow-up"
    item: "inline-code 符号存在性校验（`funcName` / 常量名 grep）"
    deadline: "2026-09-01"
    reason: "符号 grep FP 高（匹配注释/通用词），本版只做路径引用，符号留 future"
---

# 知识抗腐化 drift checker（缺陷 E execution plan）

> 承接 [[2026-06-01-secondary-defects-roadmap]] 缺陷 E（P1）。Think 已在 roadmap 完成，本文档是 Phase 2 Plan（含 dogfood 验证的解析设计）→ 待 go work。

---

## 需求分析

### 要做

- 给 `pre-commit-check.js` 加第 7 个 checker `checkKnowledgeDrift`：校验 staged 的 `rules/solutions/ADR` md 里的**代码位置引用**所指文件是否还存在。
- 直击本仓库 #1 回归源 [[documented-claim-vs-code-reality-drift]]（成熟知识层 append-only、零校验）。

### 不做

- ❌ 不校验行号值（行号必随编辑漂移，校验=持续 FP）。
- ❌ 不校验无行号的路径引用（dogfood 证明 FP=40，因文档大量合法引用假设/未来/运行时文件）。
- ❌ 不做 inline-code 符号存在性校验（FP 高，[[deferred]] 到 follow-up）。
- ❌ 不进 plugin 副本（pre-commit-check 是开发期 git hook，不在 `copyUtilityScripts` 列表，无双 runtime parity 负担）。

### 成功标准

- [ ] 现有全部 rules/solutions/ADR 通过（block 档 0 FP，dogfood 已验证 = 0）。
- [ ] 删除被「源码前缀 + 行号」引用的文件 → checker block（exit 1，含具体修复指引）。
- [ ] 裸文件名 glob 0 匹配 → warn（stderr，不阻塞）。
- [ ] `...` 简写 / 运行时前缀（`.claude/`,`.codex/`）/ 无行号引用 → skip。
- [ ] fail-open：lib 异常 → exit 0 + marker。

### 风险和假设

- 假设引用格式分布稳定（dogfood 已验证当前分布）。
- 假设源码前缀集合 `{scripts,docs,plugins,user-level}` 覆盖真实 drift 信号（dogfood：现有带行号引用全落此集或裸名）。

---

## 技术方案

### 入场扫描 — Invariants 继承

| 子系统 | 既有 invariant | 本 sprint 如何保持 |
|--------|----------------|--------------------|
| pre-commit checker 模式 | `check*(stagedFiles, repoRoot)→failures[]`；filter relevant 否则 `[]`；main 汇总 exit 1/0（[pre-commit-check.js:95-453](../../scripts/pre-commit-check.js)） | `checkKnowledgeDrift` 严格同签名同模式 |
| fail-open | main try-catch → exit 0 + `[pre-commit]` marker（line 630-640） | 新 checker 异常被 main 兜底；lib 内部亦 try-catch |
| 跨平台 | `getStagedFiles` 用 `core.quotePath=false`（中文名）+ diff-filter ACMRD（含删除） | 复用现有 `getStagedFiles`，不新增文件枚举 |
| enforcement dogfood | [[ADR-013]] §B：上线前枚举现有边界产物验证 0 FP | dogfood 探针已在 plan 阶段跑（v1→v2），Task 4 固化为 test |

### 入场扫描 — 集成路径声明

| 改动点 | 触发动作 | 中间层 | 持久化 | 消费点 |
|--------|----------|--------|--------|--------|
| drift 解析 | `knowledge-drift.js` lib | 解析 md → 分档 → 校验存在 | 无（纯函数） | `checkKnowledgeDrift` |
| checker 接入 | git commit → pre-commit hook | `checkKnowledgeDrift(staged, root)` | 无 | exit 1（block）/ stderr（warn） |

链路完整闭环：git commit 是已有强制触发点（[[ADR-016]]「动作产生 git commit → 挂 pre-commit」原则正向命中）。**无 dead-on-arrival 风险**（pre-commit 每次 commit 必跑）。

### 入场扫描 — 半完成债务清单

| 来源 | 议题 | 本 sprint 决策 |
|------|------|----------------|
| roadmap E | inline-code 符号校验 | [[deferred]]（FP 高，留 follow-up，frontmatter 已记 deadline 2026-09-01）|
| roadmap B/C/D | 其他次级缺陷 | 不在本 sprint（E 独立）|

### 关键假设验证（[[ADR-012]] + [[ADR-013]] §B dogfood）

| 假设 | 验证方法 | 结果 | 可信度 |
|------|---------|------|--------|
| checker 模式可复用 | 读 `checkSolutionIndexSync`（最近同类，line 413） | ✅ filter→require→比对→failures[] 模式清晰 | 高 |
| naive「路径存在性」可行 | dogfood 探针 v1（带目录路径） | **证伪** → would-block 40/42（正则 bug + 假设文件 + 运行时路径） | 高 |
| 收窄「带行号+源码前缀」0 FP | dogfood 探针 v2 | ✅ **would-block = 0**；裸名 11(4 唯一)归 warn；skip 运行时 0 / `...` 1 | 高 |
| 无需 grandfather | v2 现有 0 FP | ✅ 现有全过，无需 filename-date grandfather（区别于 [[ADR-012]] 的 plan lint） | 高 |
| 不进 plugin parity | `copyUtilityScripts` 列表 | ✅ pre-commit-check 不在列表（开发期工具） | 高 |
| 正则 js/json 截断 bug | v1 探针 `settings.json`→`settings.js` | ✅ 真实 → alternation 必须长在前 `jsonl\|json\|...\|js` | 高 |

### 方案概述

`checkKnowledgeDrift` 解析 staged 的 `.claude/rules/*.md` + `docs/solutions/*.md` + `.claude/rules/architecture.md`(ADR) 里的**带行号代码引用**，按 dogfood 验证的分档校验：

### 解析分档表（经 dogfood 验证，0 FP）

| 引用形态 | 例 | 校验 | 命中 |
|---------|-----|------|------|
| 带行号 + 源码前缀(`scripts/docs/plugins/user-level/`) | `scripts/inject-context.js:25` | 文件存在性 | 不存在 = **block (exit 1)** |
| 带行号 + 裸文件名 | `inject-context.js:28`、`pipeline.js:472` | glob basename（repo 内） | **0 匹配 = warn**（≥1=OK，不要求唯一） |
| 含 `...` / `*` 简写 | `plugins/.../build-codex-plugin.js:332` | **skip**（文档惯例） | — |
| 非源码前缀（运行时） | `.claude/settings.json:60` | **skip**（安装位置，repo 内在 user-level/） | — |
| 无行号路径引用 | `scripts/sprint-goal.js`（deferred 文件） | **skip**（假设/未来文件合法） | — |
| inline-code 符号 | `` `copyTextFile` `` | **不做** | [[deferred]] |

正则关键：alternation 长在前 `(?:jsonl|json|mjs|cjs|js|ts|sh|ps1)`（修 v1 的 `settings.json`→`.js` 截断）。

### 任务拆解

- [x] **Task 1**: drift lib `scripts/lib/knowledge-drift.js` — 解析带行号引用 + 分档（block/warn/skip）+ 文件存在/glob basename 校验，纯函数（输入 md 文本+root，输出 `{blocks[], warns[]}`）— 风险: L3（解析正则 + 分档逻辑核心）
- [x] **Task 2**: `checkKnowledgeDrift(stagedFiles, repoRoot)` 接入 [pre-commit-check.js](../../scripts/pre-commit-check.js) — filter staged rules/solutions/architecture.md → 调 lib → block 进 failures(exit1)、warn 走 stderr(不阻塞) + `formatKnowledgeDriftError` + module.exports 注册 — 风险: L3（enforcement 接入）
- [x] **Task 3 [P]**: smoke scenarios 接入 [smoke-pre-commit.js](../../scripts/smoke-pre-commit.js) — pass / block(删源码文件) / warn(裸名失配) / skip(`...`) / skip(运行时前缀) / fail-open；makeRepo copy 列表加 `knowledge-drift.js` — 风险: L2
- [x] **Task 4 [P]**: 单元测试 `scripts/test-knowledge-drift.js`（解析分档/glob/边界）+ **全量 dogfood gate**（扫现有全部 rules/solutions/ADR 断言 block=0，固化探针为持久 test）— 风险: L2
- [x] **Task 5**: 文档同步 — ADR-023（drift checker 设计 + dogfood 收窄决策）+ README（pre-commit 章节）+ roadmap E status→done + 本 plan 变更日志 — 风险: L1

### 测试策略

- 单元（`test-knowledge-drift.js`）：解析正则（js/json 顺序、带行号/无行号、`...`/运行时前缀分档）；glob basename（0/1/多匹配）；block/warn 分类。
- 三档负样本（[[feedback_negative_sample_3_archs]]）：(a) pass 现有文档；(b) break-test：删除被引用源码文件 → block；(c) break-impl：删 lib → checker fail-open（不崩 commit）。
- smoke（[[ADR-013]] 4 类）：pass / fail(block) / skip(grandfather 等价=运行时前缀+`...`) / fail-open。
- 全量 dogfood gate（Task 4）：现有 42 md 文件 block 必须 = 0（探针已验证，固化防回归）。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 未来新引用格式绕过解析 | 中 | 漏检（FN） | 接受——FN 比 FP 安全（[[ADR-013]] §B 原则）；warn 档兜底裸名 |
| 裸名 glob 多匹配误判存在 | 低 | 漏检 drift（pipeline.js 有 plugin 副本） | 接受——多匹配视为存在，宁可 FN |
| 源码前缀集合不全 | 低 | 漏检某目录 drift | 探针证明现有引用全覆盖；新前缀按需加 |
| enforcement 上线阻塞合法 commit | **已消除** | — | dogfood v2 证明 0 FP；无需 grandfather |

### 涉及文件

- `scripts/lib/knowledge-drift.js`（新，解析 + 校验纯函数）
- `scripts/pre-commit-check.js`（加 checker + formatter + exports）
- `scripts/smoke-pre-commit.js`（加 drift scenarios + makeRepo copy）
- `scripts/test-knowledge-drift.js`（新，单测 + 全量 dogfood gate）
- `.claude/rules/architecture.md`（ADR-023）
- `README.md`（pre-commit 章节）
- `docs/plans/2026-06-01-secondary-defects-roadmap.md`（E status→done）

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-06-01 | dogfood | 探针 v1（带目录路径存在性）would-block 40/42 → 收窄到「带行号+源码前缀」探针 v2 = 0 FP，确立无需 grandfather |
| 2026-06-01 | Task 1 | `scripts/lib/knowledge-drift.js` 纯函数：parseCodeReferences（alternation 长在前修 js/json 截断）+ classifyReference 6 档 + analyzeKnowledgeDrift + buildKnownIndex |
| 2026-06-01 | Task 2 | `checkKnowledgeDrift` 接入 pre-commit-check.js：block 计入 exit 1、warn 总打印不阻塞；formatter + exports |
| 2026-06-01 | Task 3 | smoke S16a-e（pass/block/warn/skip/fail-open）+ makeRepo copy 列表加 knowledge-drift.js（修复引入依赖导致的 S15b fail-open） |
| 2026-06-01 | Task 4 | `test-knowledge-drift.js` 16 单测 + 固化 dogfood gate（现有 block=0）；run-tests auto-discover 21/21 |
| 2026-06-01 | Task 5 | ADR-023；README 不改（pre-commit dev-time guard 历来不在用户入口，与现有 6 checker 一致）；roadmap E status→done |

---

## 审查结果

> Phase 4 self-review（中小 enforcement sprint，inline 多视角；全程掌握代码故不 spawn）。

| 视角 | 结论 |
|------|------|
| 正确性 | ✅ REF_RE alternation(json>js) + classifyReference 6 档由 16 单测覆盖；main warn 不阻塞/block exit1 由 smoke 覆盖；staged 删除文件 `text==null` 跳过；同 commit 新增源码文件在 `git ls-files`(index) → 不误 block（S16a 验证） |
| 安全/FP | ✅ dogfood 0 FP + gate 固化于 test；fail-open（lib 缺失 → exit0 + marker，S16e 验证） |
| 第 6 视角集成连续性 | ✅ 现有 6 checker 不变（smoke 26 pass 含旧全过）；无 dead code（lib 被 pre-commit + test require，checker 被 main 调）；测试覆盖匹配 L3；自身 commit drift=0（已验证） |
| 文档同步 | ✅ ADR-023 + 本 plan + roadmap E→done；README 不涉及（dev-time guard，现有 6 checker 同样不在 README，保持一致） |

- **P0**：无 ｜ **P1**：无
- **P2（不做）**：dogfood gate 只断言 block=0 未断言 warn 基线——warn 不阻塞，YAGNI。

---

## 复利记录

### 提取的经验
- **enforcement 判定域应由 dogfood FP 反推，而非先验设计**：naive「路径存在性」dogfood 40/42 FP → 收窄到「带行号 + 源码前缀」确定性可判子集 → 重 dogfood 0 FP。是 [[ADR-013]] §B 的深化（从"枚举边界产物验证"到"用 FP 数据反推可判定子集"）。
- **文档里的路径引用三类天然非 repo-source**：假设/未来文件、运行时安装路径、`...` 简写——"存在性"对它们不是确定性信号；只有"带行号 + 源码前缀"是作者对 repo 现状的确定性断言。
- pre-commit 引入首个**非阻塞 warn 档**（block→exit1 / warn→总打印 exit0）。

### 创建/更新的本能
- [[enforcement-decision-domain-from-dogfood-fp]]（新，feedback）

### 解决方案文档
- `docs/solutions/2026-06-01-knowledge-drift-checker.md`
- ADR-023（`.claude/rules/architecture.md`）
