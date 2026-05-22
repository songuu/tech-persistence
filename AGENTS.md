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

- [2026-05-22] [sprint-protocol/rollback/enforcement] Phase 间预热协议从'必须'撤回为'可选'——避免 cargo-cult enforcement — 2026-05-22 会话评估是否接入 2026-05-12 gstack-latest-analysis.md C2 = Phase 间预热段 lint enforcement （pre-commit-check 强制 sprint phase 报告含「下一 Phase 预热」段）。当时 Phase 4 定级 🟢 待接入，反方理由 "(b) 预热段价值未量化，可能 cargo-cult" 反驳为 "通过 6 个月后比较返工率量化"。 → `docs/solutions/2026-05-22-phase-warmup-protocol-rollback.md`
- [2026-05-22] [review/design/sibling-eval] gstack design-review IP 借鉴：review.md 加 design lens 条件触发 + 双轨 prompt（Spawn-capable / Inline-fallback） — 用户请求："分析和对比下 gstack 系统里面关于设计的部分，在当前的系统架构里面，有没有应用和优化的空间"。 → `docs/solutions/2026-05-22-gstack-design-lens-double-track.md`
- [2026-05-22] [figma/mcp/design-to-code] Figma → 代码 1:1 还原方案研究 + 研究型 sprint 推荐排序与 fallback 协议 — 用户请求："目前 figma mcp 对于 figma 设计图总会存在很多偏差，这里有没有更好的方案，可以更好的还原，需要 1:1 的程度"。 → `docs/solutions/2026-05-22-figma-1to1-fidelity.md`
- [2026-05-21] [sibling-eval/external-reference/identity-question-first] gsd-build/get-shit-done 评估 — 0 直接实施 + 5 follow-up + 11 硬拒绝 + 2 防御性拒绝改正 — 用户请求："研究下 <https://github.com/gsd-build/get-shit-done ，看下当前的架构有没有任何可以借鉴的地方"。 → `docs/solutions/2026-05-21-gsd-eval.md`
- [2026-05-18] [testing/ci/cross-platform] 单元测试架构基线 v1：从 0 framework 到可测试 + CI 多平台 — 本仓库 34 JS 文件（6158 行）， 0 测试框架 / 0 package.json / 仅 3 个手写 test- .js 且 全部不在 CI 中跑 。审计发现 7 类架构缺陷阻碍单元测试。用户原话：「单元测试是必须的一步」——已存在但失效的测试基础设施 = 测试金字塔倒挂 + 回归保护 = 0。 → `docs/solutions/2026-05-18-unit-test-architecture-baseline.md`

<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->
## 当前迭代重点
- [ ] [当前任务]
