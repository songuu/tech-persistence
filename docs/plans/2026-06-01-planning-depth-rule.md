---
title: "缺陷 D：规划深度自适应 rule"
type: plan
status: completed
created: "2026-06-01"
updated: "2026-06-01"
tags: [plan, methodology, planning-depth, self-evolution, agentic]
parent: "docs/plans/2026-06-01-secondary-defects-roadmap.md"
related:
  - "[[2026-06-01-secondary-defects-roadmap]]"
  - "[[2026-06-01-architecture-defect-analysis]]"
risk: L1
---

# 缺陷 D：规划深度自适应 rule

> 承接 [[2026-06-01-secondary-defects-roadmap]] 缺陷 D（P4，零代码）。本缺陷的核心是「想清楚比写代码重要」——agentic coding 下执行成本趋近免费，80/20（80% 规划）的 pre-agentic 假设需要按任务可逆性细化，而非一刀切。

## 目标（CEO 视角，做什么/不做什么）

- ✅ 补 1 条轻量元规则：**规划深度跟「任务可逆性 × 规模」走**（与现有「测试深度跟风险走」L0-L4 正交同构）。可逆/小任务允许快试错跳过重规划；不可逆/高风险保留完整 80/20。
- ❌ **不加 `--explore N`**（并行 N 方案选优）——撞「确定性优先」（N 方案选优引入不确定）+ 重 + 未证需求 + worktree 已能手动做。看着酷，实际 YAGNI（[[user_workflow_preferences]]：挑战看着酷的方案）。
- ❌ 不写任何代码、不加 CLI、不加 hook。纯 markdown 规则。

## 关键假设验证（[[ADR-012]]）

| 假设 | 勘察 | 修正后现实 |
|------|------|-----------|
| 规则放 `user-level/CLAUDE.md` 即可 | Read install.ps1:138 / install.sh:201 | user-level/CLAUDE.md 只装 `~/.claude/CLAUDE.md`（Claude 全局），**Codex 不读** |
| 根 `AGENTS.md` 是方法论镜像，需 propagate 进去 | Read `AGENTS.md:1` | 根 AGENTS.md 是**项目模板**（`[项目名称]` 占位）+ sync-solution-index 写「解决方案索引」块；**非方法论镜像**，不该塞规则 |
| `测试规则` 是纯 CLAUDE.md 规则 | Grep `测试规则`/`L0 免测` 全仓 | `测试规则` 在 CLAUDE.md（Claude）**+ `.codex/skills/test-strategy`**（Codex parity 经 skill 携带）。纯 CLAUDE.md 会留 parity 缺口 |
| `/plan` 已有规划深度概念 | Read `user-level/commands/plan.md:1-56` | 只有 per-task `风险 L?`，**无「该做多少前期规划」元规则**；`/plan` 在 propagate 列表（propagate-command-changes.js:15） |

**结论（parity 决策，[[ADR-011]]）**：methodology 规则若只放 user-level/CLAUDE.md 会有 Codex parity 缺口。规则**内容**落 `/plan`（propagate 到 `.codex` + plugin = Codex 可读），CLAUDE.md 放 Claude 侧 summary——与 `测试规则`「CLAUDE.md 摘要 + skill/command 携带详情」模型同构。

## 方案（架构师视角）

两处落点，受控重复（同 `测试规则` 模型，markdown 非代码，drift 风险低）：

1. **`user-level/CLAUDE.md` 新增 `## 规划深度规则`**（紧跟 `## 测试规则`）：P0-P4 完整档位矩阵 + 「可逆性 > 规模」判定优先级 + 与「使用节奏」关系。Claude 全局方法论摘要。
2. **`user-level/commands/plan.md` 新增 `## 规划深度自适应`**：自包含的 3 档精简版（可逆+小 / 常规 / 不可逆+高风险），Codex 读得到 = parity。propagate → `.codex/commands/plan.md` + plugin skill。

档位（与测试 L0-L4 正交——一个管"写多少测试"，一个管"做多少前期规划"）：

| 档 | 触发 | 规划深度 |
|----|------|---------|
| P0 直接做 | 可逆 + 小（文案/样式/局部改名） | 跳过 think/plan，直接做 + 自验 |
| P1 轻规划 | 可逆 + 中（低风险新增） | 单段计划，省 think |
| P2 标准 | 常规开发 | plan→work→review |
| P3 重规划 | 不可逆 或 大（核心逻辑/跨模块） | think→plan→work→review，保留 80/20 |
| P4 全程 | 不可逆 + 高风险（支付/认证/数据/迁移/删除/对外发布） | 完整 5 phase + 多方案对比 |

判定优先级 **可逆性 > 规模**：可逆性低即使规模小也升档。

## Task list

- [x] **Task 1 [P]**: `user-level/CLAUDE.md` 加 `## 规划深度规则`（完整矩阵）— 文件: `user-level/CLAUDE.md` — 风险: L1
- [x] **Task 2 [P]**: `user-level/commands/plan.md` 加 `## 规划深度自适应`（精简版）— 文件: `user-level/commands/plan.md` — 风险: L1
- [x] **Task 3**: propagate + build + validate + pre-commit（依赖 T2）— 风险: L1
- [x] **Task 4**: 文档沉淀（solution + ADR-024 parity 决策 + roadmap D→done + sync-solution-index）— 风险: L1

> T1/T2 不同文件、无依赖 → `[P]`。T3 依赖 T2（propagate plan.md）。

## 成功标准

- [x] `~/.claude/CLAUDE.md` 源（user-level）含规划深度矩阵，紧邻测试规则
- [x] `.codex/commands/plan.md` + plugin skill 含精简版（propagate 后 sha 一致，pre-commit `checkPropagateSync` 通过）
- [x] propagate 未触发 codex-regex 撞车（无 "Claude Code 端" 式 runtime 标签，[[feedback_codex_regex_sync_runtime_idiom]]）
- [x] pre-commit exit 0

## 测试策略

L1（纯 markdown 规则，无可执行逻辑）：propagate sha 一致性 + validate-codex-plugin + pre-commit 即覆盖。无单测需求。

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 只放 CLAUDE.md 留 Codex parity 缺口 | 高（若不勘察） | 违反 [[ADR-011]] | 勘察已定位，规则落 propagate 命令 |
| 两处副本 drift | 低 | 规则不一致 | markdown 稳定规则；CLAUDE.md 摘要 + plan.md 详版分工，非逐字复制 |
| propagate 漏跑 build | 中 | pre-commit skill wrapper mismatch | 固定序列 propagate→build→validate→pre-commit（[[feedback_propagate_needs_build_step]]） |

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-06-01 | 创建 + 实施。规则落 CLAUDE.md（摘要）+ /plan（详版，Codex parity）。 |
