---
title: "gstack 分析 sprint 后续执行方案（A / B / C / D）"
type: plan
status: draft
created: "2026-05-12"
updated: "2026-05-12"
parent_sprint: "docs/plans/2026-05-12-gstack-latest-analysis.md"
parent_solution: "docs/solutions/2026-05-12-gstack-analysis-reframe-lessons.md"
candidates: [A-command-audit, B-usage-report, C-adr-013-section-b, D-gstack-defer]
priority_order: [A, B, C, D]
tags: [plan, followup, command-audit, usage-aggregation, dogfood, enforcement]
aliases: ["gstack-followups", "command-audit-plan"]
---

# gstack 分析 sprint 后续执行方案

> 落地 `docs/plans/2026-05-12-gstack-latest-analysis.md` Phase 4 reframe 后的 4 个候选动作。
> 方案 A/B/C 可独立执行，方案 D 是 30 天观察期（不立即动作）。

---

## 关键假设验证（ADR-012）

> 本 plan 涉及 6 个文件，每个文件至少有一次 Read / Grep 验证。可信度标记。

| 假设 | 验证文件 | 行 | 结果 | 可信度 |
|---|---|---|---|---|
| 21 命令清单完整 | `Glob user-level/commands/*.md` | — | ✅ 21 文件 | high |
| 4 个 0-提及命令 grep 排除自引后确实 0 | `Grep prototype docs/solutions/` | — | ✅ 0 命中 | high |
| install.sh 命令复制是 glob 循环 | `install.sh` | 159 | ✅ `for file in user-level/commands/*.md` | high |
| install.ps1 同源 | `install.ps1` | 91 | ✅ `Get-ChildItem ... -Filter "*.md"` | high |
| observations 路径与 schema | `scripts/observe.js` | 26-73 | ✅ projects/<id>/observations.jsonl + 13 字段 | high |
| 跨 session 聚合脚本不存在 | `Glob scripts/*usage*` | — | ✅ 0 命中（结构性缺口确认） | high |
| pre-commit-check 已有 plan-lint 框架 | `scripts/pre-commit-check.js` | 31-36 | ✅ `GRANDFATHER_BEFORE` + `PLAN_PATH_RE` | high |
| **ADR-013 已毕业到 architecture.md** | `Grep ADR-013 .claude/rules/architecture.md` | — | ❌ **未毕业** — 仅在 CLAUDE.md 索引和 debugging-gotchas.md 引用 | high |
| `scripts/lib/` 已有 memory-v5 / runtime-paths | `ls scripts/lib/` | — | ✅ 2 helper 在 | high |
| propagate-command-changes.js transform 规则 | `scripts/propagate-command-changes.js` | — | ⚠️ 尚未读完整，方案 A3 实施前必须读取 | medium |

**关键修正**：原对话中假设 ADR-013 在 architecture.md，实际**未毕业**。方案 C 第 1 步必须先毕业 ADR-013 主体。

---

## 方案 A — 21 命令使用率审计

### 目标

清理 4 个 0-提及命令（`prototype` / `skill-eval` / `skill-improve` / `skill-publish`）到 `experimental/` 子目录；5 个 1-提及命令打 `usage_evidence: low` 标记。让命令面板与 252 entries observation 数据对齐。

### 任务拆解

| # | 任务 | 风险 | 涉及文件 | 验证 |
|---|------|---|---|------|
| A1 | 创建 `user-level/commands/experimental/`，移入 4 个 0-提及命令 | L2 | `user-level/commands/{prototype,skill-eval,skill-improve,skill-publish}.md` → `experimental/` | `ls user-level/commands/experimental/` 4 文件；原目录不再有这 4 个 |
| A2 | `install.sh` 增加 `--include-experimental` flag，默认**不复制** `experimental/`；同改 `install.ps1` | L3 | `install.sh:155-170`、`install.ps1:88-100` | tmp HOME 跑 `bash install.sh --user`：默认 17 命令；加 flag 跑：21 命令 |
| A3 | 同步 `scripts/propagate-command-changes.js`：plugin 副本（`plugins/tech-persistence/commands/`）和 `.codex/commands/` 也按 experimental 分流 | L3 | `scripts/propagate-command-changes.js` + 两副本目录 | `node scripts/propagate-command-changes.js && node scripts/pre-commit-check.js` 通过 |
| A4 | 5 个 1-提及命令（待 grep 1-命中精确列表确认）frontmatter 加 `usage_evidence: low` | L1 | 5 个 `user-level/commands/*.md` | `grep -l "usage_evidence: low" user-level/commands/` 5 命中 |
| A5 | README.md 命令速查表加 ⚠️ 标记；CLAUDE.md 索引追加；本 plan 转 status: completed | L1 | `README.md`、`CLAUDE.md`、本文件 | pre-commit-check 通过 |

### 风险与不做什么

- ❌ 不删除任何命令文件（可逆性优先）
- ❌ 不一次处理 5 个 1-提及命令的清理 — 仅打标记，30 天后基于方案 B 数据复盘
- ⚠️ `experimental/` glob 行为：必须 dogfood 跑完整 `bash install.sh --user` 到 tmp HOME，确认默认确实不复制
- ⚠️ A3 实施前先 Read `scripts/propagate-command-changes.js` 全文（关键假设验证表的 medium 项）

### Dogfood 自检

- 本方案是 enforcement 提案吗？**否** — 纯目录重组 + flag 增加
- 边界产物枚举：命令本身 / install.sh / install.ps1 / propagate / plugin 副本 / .codex 副本 / README / CLAUDE.md = 8 处
- 已踩坑预防：[[hooks/windows/shell-mismatch]] `install.ps1` 不能引入 cmd 风格语法

### 维护表面增量

- 新增 ~40 LOC（install flag + propagate 分流）
- 删除 0
- 文档变更 ~6 处

---

## 方案 B — 跨 Session 使用聚合脚本

### 目标

补 L5 暴露的结构性缺口：`observations.jsonl` 已 252 entries 但无聚合脚本，`/review-learnings` 只读单 session 看不到跨 sprint 趋势。同时为方案 D 提供"30 天后复盘"的真实数据。

### 任务拆解

| # | 任务 | 风险 | 涉及文件 | 验证 |
|---|------|---|---|------|
| B1 | 新建 `scripts/usage-report.js`：流式读 `observations.jsonl` → 按 `command_family` / `tool` 分组 → 输出 30/60/90 天分桶 | L2 | `scripts/usage-report.js`（新文件） | `node scripts/usage-report.js --window 30d` 输出表格 |
| B2 | 参数：`--by command\|tool`、`--window <N>d`、`--json`、`--threshold N`、`--project <id>` | L2 | 同上 | 5 参数各跑一次返回非空 |
| B3 | `scripts/lib/memory-v5.js` 抽出 `iterateObservations(projectId, opts)` 流式 helper（避免大文件 OOM） | L2 | `scripts/lib/memory-v5.js` + B1 调用方 | self-test：mock 10MB jsonl，进程 RSS < 100MB |
| B4 | schema 容错：未来 v6+ jsonl 行 → 跳过 + warn，不 crash | L2 | B1 + B3 | mock 含 v4/v5/v6 混合行，运行成功 + stderr warn |
| B5 | `/review-learnings` 命令文档增加 `--usage` flag | L1 | `user-level/commands/review-learnings.md` | grep 命中 |
| B6 | 跨平台 smoke：`scripts/smoke-cross-platform.js` 加 usage scenario | L3 | `scripts/smoke-cross-platform.js` | Windows path 解析无 backslash 问题 |
| B7 | 文档：`docs/solutions/2026-05-12-usage-report.md` 记录设计 + README 加段 | L1 | 2 文件 | pre-commit 通过 |

### 风险与不做什么

- ❌ 不写 SQL/数据库 — observations.jsonl 是纯文件，加聚合层违反"轻量优先"
- ❌ 不实时计算 — 按需 CLI，不进 hook（hook 必须 < 1s）
- ❌ 不在本 sprint 同时改 `/session-summary` — scope 隔离
- ⚠️ 大文件 OOM：必须用 `readline.createInterface` 流式读，不是 `readFileSync`
- ⚠️ schema 漂移：必须读 `schema_version` 字段，未知版本跳过

### Dogfood 自检

- 本方案是 enforcement 提案吗？**否** — 只 observe，不 enforce
- 边界产物枚举：空 jsonl / schema 混合 / UTF-8 中文 command_family / Windows 路径 / 多项目并存 = 5 个 corner case
- 测试覆盖：mock 数据集必须包含上述 5 种

### 维护表面增量

- 新增 ~120 LOC（脚本 + helper + tests）
- 复用现有 `scripts/lib/memory-v5.js` 和 `smoke-cross-platform.js`
- 文档变更 ~3 处

---

## 方案 C — ADR-013 §B 落地（含 ADR-013 主体毕业）

### 目标

把 L3「enforcement 提案必须 dogfood inline」从教训文档升级为 `.claude/rules/architecture.md` 的 ADR-013 §B 正式条款。**前置发现**：ADR-013 主体本身尚未毕业到 architecture.md，需先补 ADR-013 主体。

### 任务拆解

| # | 任务 | 风险 | 涉及文件 | 验证 |
|---|------|---|---|------|
| C1 | Read `docs/solutions/2026-05-12-pre-commit-defense.md` 提取 ADR-013 主体描述 | L0 | 该文件 | 提取完成 |
| C2 | 把 ADR-013 主体写入 `.claude/rules/architecture.md`（含状态/上下文/决策/原因/备选/影响/来源） | L1 | `.claude/rules/architecture.md` | `grep "ADR-013" .claude/rules/architecture.md` 命中 |
| C3 | 追加 ADR-013 §B「enforcement 提案必须 inline dogfood 自检」 | L1 | 同上 | grep §B 命中 |
| C4 | `scripts/pre-commit-check.js` 新增 `checkEnforcementDogfood()`：当 plan 含 `enforcement\|lint\|hook\|gate\|pre-commit` 关键词 **且** 任务段也含 → 强制要求文档含「Dogfood 自检」H2 或 H3 段 | L3 | `scripts/pre-commit-check.js` | 见 C5 smoke |
| C5 | `scripts/smoke-pre-commit.js` 加 3 个 scenario：S13a（含 dogfood 段 → pass）/ S13b（缺段 → fail）/ S13c（不含 enforcement 关键词 → skip） | L2 | `scripts/smoke-pre-commit.js` | 3 场景全过 |
| C6 | `docs/solutions/2026-05-12-adr-013-section-b.md` 记录决策 + CLAUDE.md 索引追加 | L1 | 2 文件 | pre-commit 通过 |

### 风险与不做什么

- ❌ 不把 dogfood 段 enforce 到所有 plan — 仅含 enforcement 关键词的 plan（避免误拒研究类 sprint）
- ❌ 不在 `GRANDFATHER_BEFORE` 之前的 plan 应用 — 复用 ADR-012 grandfather 机制
- ⚠️ 关键词匹配的"双条件"必须明确：plan 既要在 body 含关键词，又要在 task 段含 — 否则会误中"背景章节提及 enforcement 但本 sprint 不实施"的研究 plan
- ⚠️ LF-normalize 必须沿用 [[cross-platform-sha-needs-lf-normalize]] 本能
- ⚠️ fail-open 标记：保持 `[hook] failed:`

### Dogfood 自检（递归 dogfood — 本方案是 enforcement 提案）

- **本方案是 enforcement 提案 → 必须 inline 自检 → ✅ 本段就是**
- 边界产物枚举：
  1. 含关键词但不实施 enforcement 的研究 plan → 应 skip
  2. `GRANDFATHER_BEFORE` 之前的旧 plan → 应 skip
  3. 跨平台 line-ending（CRLF 源 / LF 副本）→ LF-normalize 后 compare
  4. 中文 plan 文件名（`docs/plans/2026-05-12-中文.md`）→ `-c core.quotePath=false` 保证不被 escape
  5. 已 grandfather 的 plan 同时修改 → 修改部分是否需要触发？决策：不触发（grandfather = 整文件豁免）
- 本 plan 自身要求 dogfood 段吗？本 plan 含 "enforcement" 关键词 + 任务段也含 → 是 → ✅ 上方「Dogfood 自检」段满足要求
- fail-open 标记：保持 `[hook] failed:` marker；smoke S13d 必须 assert 通过 scenario stderr 不含此 marker

### 维护表面增量

- architecture.md +50 行
- pre-commit-check.js +40 LOC
- smoke-pre-commit.js +30 LOC
- 文档 ~2 处

---

## 方案 D — gstack 候选补吸收（30 天观察期）

### 目标

避免 sibling-evaluation framework-building 偏见复发。3 个候选（C1 destructive hook / C2 phase warmup lint / C5 retro delta）需要真实事件触发分子才解冻。

### 解冻条件

| 候选 | 解冻条件 | 数据源 |
|---|---|---|
| C1 destructive hook | `grep "rm -rf\|DROP TABLE\|force-push\|accident\|误删" .claude/rules/debugging-gotchas.md` 出现 ≥1 真实事故 | 等待自然事件 |
| C2 phase warmup lint | 方案 B 产物显示 ≥ 5 个 sprint 在 Phase N→N+1 之间有显著探索往返 | 方案 B usage-report |
| C5 retro delta | N=3 sibling-evaluation sprint 完成（gstack ×1 + gbrain ×1 + 未来 ×1） | 自然累积 |

### 30 天复盘 checklist（2026-06-12）

- [ ] 跑 `node scripts/usage-report.js --window 30d --by command` 看跨 session 数据
- [ ] grep debugging-gotchas.md 是否有真实 destructive 事故
- [ ] 是否出现第 3 个 sibling-evaluation sprint
- [ ] 若任一条件满足 → 启动对应候选的 plan sprint

### 不做什么

- ❌ 不预设解冻日期 — 等真实证据
- ❌ 不补吸收 G2/G3/G5（gstack reviewer 命令族 / autoplan / ship）— 与本项目 inbound self-evolution positioning 正交，跟随会破坏轻量原则

---

## 推荐执行顺序

```
A (命令审计)        — 30-60 分钟，独立可上线，杠杆最高
  ↓
B (usage-report)    — 2-3 小时，为 D 提供分子数据，补结构性缺口
  ↓
C (ADR-013 §B)      — 1-2 小时，防止下次 sprint 复发 L3 dogfood 失败
  ↓
D (30 天后复盘)     — 无动作，仅等待
```

**最小起步动作**：方案 A 的 A1+A4 两步（移文件 + 加 frontmatter 标记），~10 分钟可见效。A2/A3/A5 后续 sprint 收尾。

---

## 变更日志

- 2026-05-12 初稿（基于 `2026-05-12-gstack-analysis-reframe-lessons.md` 的 6 条经验）

---

## 关联

- 父 sprint: `docs/plans/2026-05-12-gstack-latest-analysis.md`
- 父 solution: `docs/solutions/2026-05-12-gstack-analysis-reframe-lessons.md`
- 相关 ADR: ADR-011（identity-question-first）、ADR-012（plan 假设验证）、ADR-013（dogfood 边界产物枚举，待毕业）
- 相关本能: [[documented-claim-vs-code-reality-drift]]、[[cross-platform-sha-needs-lf-normalize]]、[[mechanism-over-discipline]]、[[sibling-evaluation-defaults-to-framework-building]]
