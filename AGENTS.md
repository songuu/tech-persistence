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

- [2026-06-01] [self-evolution/telemetry/observability] demand-side 召回 telemetry：度量注入知识是否被用（measure-before-enforce） — demand-side 召回 telemetry → `docs/solutions/2026-06-01-demand-side-recall-telemetry.md`
- [2026-05-29] [sprint/goal-loop/determinism] /sprint --goal 自主目标循环：pure-prompt MVP + '无宿主进程→确定性上限'设计原则 + helper 条件推迟 — 用户要求在当前架构接入 /sprint --goal "<目标 " 自主目标驱动循环：设目标 → think→plan→work→review→compound 重入直到达成或终止，4 维控制（终止条件 / 自动化程度 / 目标范围约束 / 运行时选择）。难点：确定性优先 是项目不可妥协原则，用户明确要"直接控制"终止——天然倾向给 max-iter 天花板写确定性强制代码。 → `docs/solutions/2026-05-29-sprint-goal-mode.md`
- [2026-05-28] [self-evolution/skill-evolution/trace] B2 trace → eval 自动沉淀：失败 trace 半自动转结构化 eval case（provenance gate 护城河 + 双层脱敏） — docs/plans/2026-05-28-two-layer-architecture-enhancement.md §B2 要从真实使用 trace 里「corrections 发生的真实输入」半自动转成 skill eval case（真实失败 = 最有价值的测试）。护城河目标：eval case 来自真实 trace 而非 skill 自产（避免"自己出题给自己考"）。设计文档假设数据源是「signal jsonl 里 cor… → `docs/solutions/2026-05-28-trace-to-eval.md`
- [2026-05-28] [self-evolution/skill-evolution/trace] B1 trace-aware 反思：skill 失败/纠正 trace 结构化捕获（半自动 + 双层脱敏） — docs/plans/2026-05-28-two-layer-architecture-enhancement.md §B1（GEPA reflective mutation 内核）要 /skill improve 基于真实失败 trace 做根因反思，而非把失败塌缩成"跳过率"标量。设计文档假设"扩展现有 signal jsonl 的 steps skipped/corrections/duration 字段"。同时 B2（tra… → `docs/solutions/2026-05-28-skill-trace-aware-reflection.md`
- [2026-05-28] [enforcement/self-evolution/skill-evolution] B3 基线护栏下沉：skill publish 退化发布确定性拒绝（含 eval-result 结构化格式） — docs/plans/2026-05-28-two-layer-architecture-enhancement.md §B3 提议把 skill-publish 的"eval 通过率 ≥ 当前版本才能发布"从文档协议下沉为确定性 enforcement（ADR-013 mechanism-over-discipline 活案例）。设计文档假设"复用 scripts/pre-commit-check.js 模式纯加一个检查函数"。 → `docs/solutions/2026-05-28-skill-publish-baseline-guard.md`

<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->
## 当前迭代重点
- [ ] [当前任务]
