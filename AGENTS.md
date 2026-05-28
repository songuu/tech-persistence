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

- [2026-05-28] [self-evolution/skill-evolution/trace] B1 trace-aware 反思：skill 失败/纠正 trace 结构化捕获（半自动 + 双层脱敏） — docs/plans/2026-05-28-two-layer-architecture-enhancement.md §B1（GEPA reflective mutation 内核）要 /skill improve 基于真实失败 trace 做根因反思，而非把失败塌缩成"跳过率"标量。设计文档假设"扩展现有 signal jsonl 的 steps skipped/corrections/duration 字段"。同时 B2（tra… → `docs/solutions/2026-05-28-skill-trace-aware-reflection.md`
- [2026-05-28] [enforcement/self-evolution/skill-evolution] B3 基线护栏下沉：skill publish 退化发布确定性拒绝（含 eval-result 结构化格式） — docs/plans/2026-05-28-two-layer-architecture-enhancement.md §B3 提议把 skill-publish 的"eval 通过率 ≥ 当前版本才能发布"从文档协议下沉为确定性 enforcement（ADR-013 mechanism-over-discipline 活案例）。设计文档假设"复用 scripts/pre-commit-check.js 模式纯加一个检查函数"。 → `docs/solutions/2026-05-28-skill-publish-baseline-guard.md`
- [2026-05-27] [security/hooks/memory-v5] claude-mem follow-up 吸收：privacy tags + hook exit policy + local recall telemetry — 2026-05-26 claude-mem sibling-eval 得出 4 个 P1 follow-up：edge-tag-stripping、hook exit-code protocol、SECURITY.md transparency、grep/frontmatter recall telemetry。评估 sprint 已完成，但如果不下沉为代码和规则，会继续停留在"文档知道风险，hook 仍全文捕获"的半完成状态。 → `docs/solutions/2026-05-27-claude-mem-followups.md`
- [2026-05-26] [sibling-eval/external-reference/identity-question-first] claude-mem 评估 — 0 直接借鉴 + 4 follow-up + 2 backlog + 5 hard reject + 1 自捕获新发现 (F13) — 用户请求："分析下 https://github.com/thedotmack/claude-mem"。 → `docs/solutions/2026-05-26-claude-mem-eval.md`
- [2026-05-22] [sprint-protocol/rollback/enforcement] Phase 间预热协议从'必须'撤回为'可选'——避免 cargo-cult enforcement — 2026-05-22 会话评估是否接入 2026-05-12 gstack-latest-analysis.md C2 = Phase 间预热段 lint enforcement （pre-commit-check 强制 sprint phase 报告含「下一 Phase 预热」段）。当时 Phase 4 定级 🟢 待接入，反方理由 "(b) 预热段价值未量化，可能 cargo-cult" 反驳为 "通过 6 个月后比较返工率量化"。 → `docs/solutions/2026-05-22-phase-warmup-protocol-rollback.md`

<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->
## 当前迭代重点
- [ ] [当前任务]
