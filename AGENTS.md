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

- [2026-06-01] [methodology/planning-depth/parity] 规划深度自适应 rule（缺陷 D）：methodology 规则的 Codex parity 落点 — 规划深度自适应 rule（缺陷 D） → `docs/solutions/2026-06-01-planning-depth-rule.md`
- [2026-06-01] [telemetry/demand-side/mcp] MCP 主动检索 measure（缺陷 B）：demand-side telemetry 的主动检索轴 — MCP 主动检索 measure（缺陷 B） → `docs/solutions/2026-06-01-mcp-retrieval-measure.md`
- [2026-06-01] [enforcement/self-evolution/drift] 知识层 drift checker：enforcement 判定域由 dogfood FP 反推（40→0 FP） — 知识层 drift checker（缺陷 E） → `docs/solutions/2026-06-01-knowledge-drift-checker.md`
- [2026-06-01] [self-evolution/telemetry/observability] demand-side 召回 telemetry：度量注入知识是否被用（measure-before-enforce） — demand-side 召回 telemetry → `docs/solutions/2026-06-01-demand-side-recall-telemetry.md`
- [2026-06-01] [architecture/claude-code/dynamic-workflows] Claude Code Dynamic workflows 接入 tech-persistence：backend seam 优先，不替换 sprint 方法论 — Claude Code 在 2026-05-25 到 2026-05-29 发布 Dynamic workflows research preview：Claude 可以为任务写 JavaScript orchestration script，并在后台协调大量 subagents。用户问当前 tech-persistence 架构是否有优化空间。 → `docs/solutions/2026-06-01-claude-code-dynamic-workflows-architecture.md`

<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->
## 当前迭代重点
- [ ] [当前任务]
