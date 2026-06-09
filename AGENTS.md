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

- [2026-06-09] [sibling-eval/external-reference/identity-question-first] phuryn/pm-skills PRD 技能/命令评估 — 0 直接借鉴（目标用户错配）+ 2 收敛进化 + 1 不实施 follow-up — 用户请求："--auto 对比下 https://github.dev/phuryn/pm-skills，主要是里面的 PRD 相关的技能和命令"。 → `docs/solutions/2026-06-09-pm-skills-eval.md`
- [2026-06-08] [architecture/plan-mode/claude-code] 对比：tech-persistence /plan vs Claude Code 原生 plan mode vs Codex CLI 原生 plan mode（方法论层 vs 双 runtime enforcement 层） — 用户先问"对比当前 plan 模式和 Claude Code 自带的 plan 模式"，再要求接入 Codex CLI 原生 plan 模式凑成三方对比。风险在于三者都叫 plan，容易当成竞品三选一。实际它们分两层——tech-persistence /plan 是 model-driven markdown 方法论协议（双 runtime），Claude Code / Codex 的原生 plan mode 各是其 harness… → `docs/solutions/2026-06-08-plan-mode-comparison.md`
- [2026-06-05] [sibling-eval/ecc/harness] ECC (Enterprise Claude Code) sibling-eval — ECC (Enterprise Claude Code) sibling-eval → `docs/solutions/2026-06-05-ecc-eval.md`
- [2026-06-02] [obsidian/cross-device/sync] Obsidian 跨终端/跨设备同步对 tech-persistence 架构的优缺点与方案 — 用户问：不同终端 / 不同设备之间用 Obsidian 同步本项目的知识 vault，优缺点是什么，尤其针对当前这种架构。结论是知识层天生贴合 Obsidian 跨设备同步（4 不可妥协原则里 3 条正向加分），但「多设备双写」撞两个结构性硬伤：append-only jsonl 文件级同步会丢行、Claude auto-memory 用 cwd-key 路径根本不 portable。因此桌面多设备首选 git-based 同步（与现… → `docs/solutions/2026-06-02-obsidian-cross-device.md`
- [2026-06-01] [methodology/planning-depth/parity] 规划深度自适应 rule（缺陷 D）：methodology 规则的 Codex parity 落点 — 规划深度自适应 rule（缺陷 D） → `docs/solutions/2026-06-01-planning-depth-rule.md`

<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->
## 当前迭代重点
- [ ] [当前任务]
