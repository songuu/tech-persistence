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
- [2026-05-29] [sprint/goal-loop/determinism] /sprint --goal 自主目标循环：pure-prompt MVP + '无宿主进程→确定性上限'设计原则 + helper 条件推迟 — 用户要求在当前架构接入 /sprint --goal "<目标 " 自主目标驱动循环：设目标 → think→plan→work→review→compound 重入直到达成或终止，4 维控制（终止条件 / 自动化程度 / 目标范围约束 / 运行时选择）。难点：确定性优先 是项目不可妥协原则，用户明确要"直接控制"终止——天然倾向给 max-iter 天花板写确定性强制代码。 → `docs/solutions/2026-05-29-sprint-goal-mode.md`

<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->
## 当前迭代重点
- [ ] [当前任务]
