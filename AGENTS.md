# [项目名称]

> 请将 [项目名称] 替换为实际名称。保持本文件 < 200 行。

## 项目概述
- **定位**：[一句话描述]
- **技术栈**：[语言] + [框架] + [数据库] + [部署]
- **仓库结构**：`src/` 业务 | `tests/` 测试 | `scripts/` 工具

## 常用命令
```bash
pnpm dev          # 开发
pnpm build        # 构建
pnpm test         # 测试
pnpm lint         # 检查
```

## 架构约定
- [关键架构约定]

## 自学习系统
本项目启用了基于 Hook 的自动学习：
- PreToolUse/PostToolUse 自动捕获观察
- Stop 时自动分析模式并创建本能
- SessionStart 时自动注入近期上下文和高置信本能
- 运行 `/instinct-status` 查看已学习的项目本能
- 运行 `/evolve` 将成熟本能进化为 skill/command
- 观察和本能存储在 `~/.codex/homunculus/projects/` 下

## 关键决策记录
<!-- 由 /learn 自动追加 -->

## 已知陷阱（高频）
<!-- 只放最高频的坑，详细在 .codex/rules/debugging-gotchas.md -->

## 技术沉淀（通用经验）

### 解决方案索引

<!-- BEGIN TECH_PERSISTENCE_SOLUTIONS_INDEX -->
> Generated from `docs/solutions/*.md`; do not edit this block manually.
> Refresh with `node scripts/sync-solution-index.js --all`.

- [2026-05-18] [testing/ci/cross-platform] 单元测试架构基线 v1：从 0 framework 到可测试 + CI 多平台 — 本仓库 34 JS 文件（6158 行）， 0 测试框架 / 0 package.json / 仅 3 个手写 test- .js 且 全部不在 CI 中跑 。审计发现 7 类架构缺陷阻碍单元测试。用户原话：「单元测试是必须的一步」——已存在但失效的测试基础设施 = 测试金字塔倒挂 + 回归保护 = 0。 → `docs/solutions/2026-05-18-unit-test-architecture-baseline.md`
- [2026-05-18] [sibling-eval/meta-process/review-pass] sibling-eval 文档的二次评审 + 证据驱动优先级校准 — docs/plans/2026-05-18-mattpocock-skills-followup.md 标 status: completed，列 4 个借鉴推荐（P1/P1/P1/P2），但实际未经任何独立 reviewer。用户挑战"分析下"后才暴露： - 2 处 landing place 错配（vertical tracer → /test 应改 test-strategy；feedback loop → debugging-… → `docs/solutions/2026-05-18-sibling-eval-evidence-based-recalibration.md`
- [2026-05-18] [checkpoint/handoff/docs-hygiene] Checkpoint Handoff 文件治理：ephemeral artifact 三件套 — /checkpoint 每次执行写 docs/plans/{name}-handoff-{N}.md，N 单调递增无上限。长 sprint（如 2026-04-23-homunculus-sharing）跑出 123+ handoff 文件 ，全部 commit 进 git 历史，污染 docs/plans/ 顶层（与 sprint 主文档混在一起）。commit 11ddfae 一次性 git rm 清理 123 个文件，但 机制没… → `docs/solutions/2026-05-18-checkpoint-handoff-rolling-retention.md`
- [2026-05-15] [memory-v5/persona/architecture] Memory v5 Persona 顶层独立维度实施 + 发现 TP 双 memory 系统盲点 — TDAI sibling eval（2026-05-15-tencentdb-agent-memory-analysis）§4 借鉴点 1 提议在 TP 加 persona.md 单文件聚合用户画像，避免散落在多个 feedback /user 中靠模型每次现场聚合。用户在评估完成后改主意"直接按计划实现"，跳过原推荐的 1-2 周观察期。 → `docs/solutions/2026-05-15-persona-top-level-dimension.md`
- [2026-05-14] [sibling-evaluation/spec-driven-development/sdd] spec-kit 评估 — 借鉴 2 项 + reviewer 闭环 + 契约边界协议层补强 — 用户请求："结合当前的架构，分析下 github/spec-kit，看下有没有可以借鉴的地方"。 → `docs/solutions/2026-05-14-spec-kit-eval.md`

<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->
## 当前迭代重点
- [ ] [当前任务]
