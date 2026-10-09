---
title: "任务状态与修改文件一致性核验"
type: verification-report
status: verified
date: "2026-10-08"
---

# 任务状态与修改文件一致性核验

## 已核实的任务事实

- `docs/plans/2026-04-23-homunculus-sharing.md` 声明实现任务完成 5/5，状态仍为 `in-progress`，成功标准尚未勾选。实现完成数量不构成 Sprint 验收关闭证据。
- 活动 Sprint CLI 返回 `active: false`、`reason: missing-pointer`。本次没有创建活动指针，也没有将旧 Sprint 标记为完成。
- 最新历史交接中的 5/10 来自旧的全量 checkbox 计数。恢复入口现在展示当前计划的 5/5，并标明原交接是历史快照；历史文件保留原文。

## 已完成的修复

| 一致性范围 | 修改 | 权威源码 |
| --- | --- | --- |
| 任务计数 | checkpoint 与恢复入口共用 frontmatter 计数；拒绝重复、缺项、缩进、非法整数；兼容引号、BOM、CRLF；无声明计数的旧文档保留兼容读取 | `scripts/lib/sprint-progress.js`、`scripts/evaluate-session.js`、`scripts/inject-context.js` |
| 完成门禁 | 缩进的任务元数据无法绕过完成校验 | `scripts/lib/codex-active-sprint.js` |
| 锁恢复 | 重新读取混合时点快照；正常归档期间允许从同一对象的精确审计证据读回；篡改证据继续拒绝 | `scripts/agent-orchestrator/run-lock.js` |
| 状态机说明 | 完成证据先验证和 claim，发布新指针后退休旧证据；失败可恢复；入口保持在 4KiB 预算内 | `codex-native/skills/sprint/SKILL.md`、`references/resume.md` |
| 源码与插件 | 通过现有生成器同步 Goal、锁、Sprint 与 hook 的投影，更新受控表面指纹 | `plugins/tech-persistence/`、`scripts/fixtures/claude-surface-baseline.json` |
| 校验预算 | 单项架构测试 180 秒；串行 producer 总预算 375 秒；两层复用同一常量 | `scripts/model-compat-validator.js`、`scripts/model-canary.js` |

## 验证记录

新增回归先复现失败，再验证修复。

| 验证 | 结果 |
| --- | --- |
| Sprint 状态与崩溃恢复 | 168 项通过 |
| Provider 生命周期与锁恢复 | 49 项通过 |
| Goal 租约布局 / Goal 租约 / 验证器 | 14 / 29 / 3 项通过 |
| 原生 CLI 集成 | 通过 |
| 任务进度解析与真实交接显示 | 8 组通过；实际计划与恢复入口均显示 5/5 |
| Codex context hooks / hook entries / context cost summary | 16 / 22 / 12 项通过 |
| 完整 Model Canary | 42 项全部通过，退出码 0；包含真实架构证据、独立控制器、CLI 采集与指纹校验 |
| 插件生成投影校验 | 通过 |
| 项目规范双运行时校验 | Claude 与 Codex 均通过 |
| 工作区与暂存区 diff 检查 | 通过 |

## 修改与适用范围

开始检查时已有 26 个暂存文件。本次补充修复保留在未暂存区，未执行暂存、提交、推送或插件安装。

主要新增文件为共享解析器 `scripts/lib/sprint-progress.js`、回归 `scripts/test-sprint-progress.js`、解析器的四处生成投影及本报告。其他变更包括上述权威源码、对应生成投影和现有回归测试。

本报告验证仓库源码与生成投影。已安装插件缓存尚未更新；全仓库所有测试未执行。旧 Sprint 的成功标准、Review 和 Compound 尚缺闭环证据，保持原有状态。

## 最终修改文件清单

当前共有 41 个修改或新增文件，其中 26 个文件包含原有暂存变更。以下清单包含原有工作与本次修复；生成投影与源码按现有生成器同步。

- `codex-native/skills/sprint/SKILL.md`
- `codex-native/skills/sprint/references/resume.md`
- `docs/reports/2026-10-08-task-consistency.md`
- `plugins/tech-persistence/codex-hooks/agent-orchestrator/goal-lease.js`
- `plugins/tech-persistence/codex-hooks/agent-orchestrator/run-lock.js`
- `plugins/tech-persistence/codex-hooks/agent-orchestrator/validation-runner.js`
- `plugins/tech-persistence/codex-hooks/lib/codex-active-sprint.js`
- `plugins/tech-persistence/codex-hooks/lib/sprint-progress.js`
- `plugins/tech-persistence/codex-skills/sprint/SKILL.md`
- `plugins/tech-persistence/codex-skills/sprint/references/resume.md`
- `plugins/tech-persistence/codex-skills/sprint/runtime/codex-active-sprint-state.js`
- `plugins/tech-persistence/codex-skills/sprint/runtime/lib/codex-active-sprint.js`
- `plugins/tech-persistence/hooks/evaluate-session.js`
- `plugins/tech-persistence/hooks/inject-context.js`
- `plugins/tech-persistence/hooks/lib/sprint-progress.js`
- `plugins/tech-persistence/mcp/lib/sprint-progress.js`
- `plugins/tech-persistence/scripts/agent-orchestrator/goal-lease.js`
- `plugins/tech-persistence/scripts/agent-orchestrator/run-lock.js`
- `plugins/tech-persistence/scripts/agent-orchestrator/validation-runner.js`
- `plugins/tech-persistence/scripts/codex-active-sprint-state.js`
- `plugins/tech-persistence/scripts/lib/codex-active-sprint.js`
- `plugins/tech-persistence/scripts/lib/sprint-progress.js`
- `scripts/agent-orchestrator/goal-lease.js`
- `scripts/agent-orchestrator/run-lock.js`
- `scripts/agent-orchestrator/validation-runner.js`
- `scripts/codex-active-sprint-state.js`
- `scripts/evaluate-session.js`
- `scripts/fixtures/claude-surface-baseline.json`
- `scripts/inject-context.js`
- `scripts/lib/codex-active-sprint.js`
- `scripts/lib/sprint-progress.js`
- `scripts/model-canary.js`
- `scripts/model-compat-validator.js`
- `scripts/test-agent-orchestrator-native-cli.js`
- `scripts/test-codex-active-sprint-state.js`
- `scripts/test-goal-lease-layout.js`
- `scripts/test-goal-lease.js`
- `scripts/test-model-canary.js`
- `scripts/test-provider-lifecycle-controls.js`
- `scripts/test-sprint-progress.js`
- `scripts/test-validation-runner.js`
