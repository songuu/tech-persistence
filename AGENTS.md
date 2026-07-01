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

- [2026-07-01] [sibling-eval/external-reference/superpowers] obra/superpowers + garrytan/gstack 2026-06 更新评估 — 可借鉴项收敛到 token、安全、决策可见性、eval 隔离 — 用户请求：研究 obra/superpowers 和 garrytan/gstack 最近一个月更新了哪些内容，以及哪些值得直接借鉴到当前 tech-persistence 架构里。 → `docs/solutions/2026-07-01-superpowers-gstack-june-2026-eval.md`
- [2026-06-17] [sibling-eval/goal-mode/claude-code] Sibling-eval：Claude /goal × Codex /goal 原生命令 vs TP /sprint --goal（收窄到原生 goal 原语） — 用户问"结合 Claude Code 自带的 /goal 和 Codex 自带的 /goal，TP 当前架构的 /sprint --goal 需要改进哪里"。作用域严格收窄到 两个 runtime 各自的原生 /goal 命令本身 ，排除 Claude Dynamic Workflows / /loop / cron / Routines / fan-out（那些不是 /goal）。对比对象是 TP /sprint --goal（纯… → `docs/solutions/2026-06-17-native-goal-sibling-eval.md`
- [2026-06-15] [sibling-eval/external-reference/moai-adk] Sibling-eval：MoAI-ADK (modu-ai) vs tech-persistence — Sibling-eval：MoAI-ADK (modu-ai) vs tech-persistence → `docs/solutions/2026-06-15-moai-adk-eval.md`
- [2026-06-15] [sibling-eval/external-reference/bmad] Sibling-eval：BMAD-METHOD + SuperClaude_Framework vs tech-persistence — Sibling-eval：BMAD-METHOD + SuperClaude Framework vs tech-persistence → `docs/solutions/2026-06-15-bmad-superclaude-eval.md`
- [2026-06-09] [sibling-eval/external-reference/identity-question-first] phuryn/pm-skills PRD 技能/命令评估 — 0 直接借鉴（目标用户错配）+ 2 收敛进化 + 1 不实施 follow-up — 用户请求："--auto 对比下 https://github.dev/phuryn/pm-skills，主要是里面的 PRD 相关的技能和命令"。 → `docs/solutions/2026-06-09-pm-skills-eval.md`

<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->
## 当前迭代重点
- [ ] [当前任务]
