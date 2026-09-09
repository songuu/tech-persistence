---
title: "Think artifact routing 与 design-authority shadow pilot"
date: "2026-09-09"
updated: "2026-09-09"
status: completed
type: implementation-plan
pilot: design-authority-shadow-v1
source_decision: "[[2026-09-09-superpowers-spec-brainstorming-eval]]"
tags: [think, plan, brainstorming, spec, multi-runtime, shadow-pilot]
---

# Think artifact routing 与 design-authority shadow pilot

<!-- design-authority:start -->
## Design Authority（shadow）

- 问题与用户价值：Claude/Codex Think 对小任务持久化和下一 phase 的语义分叉；architectural Plan 没有稳定、可读的设计 owner。
- 范围：统一 artifact route、单向升级、throwaway 重分类、人工 gate；在同一 plan 内试点 design authority 与 inline preflight。
- 非目标：不增加独立 spec 文件、lineage parser、digest、Work/Review gate、stale recovery 或新的命令/phase。
- 备选方案：全量 lineage runtime 因 TP 本地 ROI 未验证而拒绝；独立 spec 文件因增加 surface 而留待 A/B；选择可回滚的 prompt-contract shadow pilot。
- 组件与消费者：Claude SoT `user-level/commands/{think,plan}.md`、Codex SoT `codex-native/skills/{think,plan}/SKILL.md`、`user-level/rules/auto-mode.md`、生成器与两套 plugin projections。
- Acceptance Criteria：
  - AC-ROUTE: WHEN 独立 Think 收到任务，THE SYSTEM SHALL 输出 probe-like、bounded-like 或 architectural-like 及判定理由，并选择答案、Work 或 Plan。
  - AC-RATCHET: WHEN probe 暴露持久实现需求或任一路径暴露隐藏复杂度，THE SYSTEM SHALL 重新分类并只允许升级，不能静默保留 throwaway 产物。
  - AC-SPRINT: WHEN Think 在活动 Sprint 内运行，THE SYSTEM SHALL 保持 `think -> plan` 状态边，只缩放 Plan 深度与附加工件。
  - AC-SHADOW: WHEN Think/Plan 判为 architectural-like，THE SYSTEM SHALL 在同一 plan 内建立一次 shadow design-authority，并检查 placeholder、内部一致性、scope 与歧义。
  - AC-BOUNDARY: WHEN pilot 被传播，THE SYSTEM SHALL 保持 Claude/Codex 投影一致，且不引入独立 spec、lineage runtime 或 Work/Review gate。
<!-- design-authority:end -->

## 关键假设验证

- 假设：双 runtime 的权威来源和投影边界可由现有生成器维护。验证：`propagate-command-changes.js`、projection tests 和 plugin validator 均已通过。
- 假设：活动 Sprint 不能从 Think 直接跳 Work。验证：当前状态机只允许 `think -> plan`；契约测试已固定该反例。
- 小样本已知：使用真实原生入口时，Claude/Codex 对 probe、bounded、architectural、活动 Sprint 和直接 Plan 的 smoke 符合本契约。统计准确率、误升级率和 shadow 区块的长期价值仍未知；保持 shadow，不据此启用 SB6。

## 契约接口

| 契约 | Before | After | 消费者 |
|---|---|---|---|
| Think artifact route | 小任务/常规任务二分，Claude 端强制持久化 | 三路复杂度语义、单向升级、独立 Think 与活动 Sprint 边界 | Claude/Codex Think、auto-mode |
| Architectural Plan | 技术方案与任务共处一个可变 plan | 同文件 shadow design-authority；AC statement 单 owner，任务只引用 ID | Claude/Codex Plan、Sprint acceptance projection |
| Runtime enforcement | 无 manual design-lineage gate | 不变；shadow-only | Work、Review、agent-loop |

## 任务与结果

- [x] 添加先失败后通过的确定性契约测试 — Criteria: AC-ROUTE, AC-RATCHET, AC-SPRINT, AC-SHADOW, AC-BOUNDARY
- [x] 更新 Claude/Codex Think、Plan 与 auto-mode 权威来源 — Criteria: AC-ROUTE, AC-RATCHET, AC-SPRINT, AC-SHADOW
- [x] 使用既有生成器传播两套 plugin projections — Criteria: AC-BOUNDARY
- [x] 运行定向测试、project-standards check、solution-index dry-run 与 plugin validation — Criteria: AC-BOUNDARY

## 验证证据

- `node scripts/test-think-design-routing.js`：旧版先因缺少 `probe-like` 失败；实现后通过。
- 最终扩展回归 `node scripts/run-tests.js --grep "install-codex|think-design-routing|sprint-runtime-portability|plugin-manifest-checks|codex-native-skill-projection|claude-codex-skill-projection-boundary|skill-size-budget|validate-codex-install"`：11/11 test files 通过。
- `node scripts/validate-codex-plugin.js`：通过。
- `node scripts/project-standards.js --project-root . --check --runtime both --profiles auto --json`：Claude/Codex 均 valid。
- `node scripts/sync-solution-index.js --all --dry-run`：全部 `ok`。
- 安装态：Codex canonical owner 恢复为 `tech-persistence@local-plugins`，1.0.8 source/cache hash 一致；Claude plugin 因同版本缓存不刷新而递增至 1.0.4，安装后 `skills/think/SKILL.md` 与源码 hash 一致。Codex 全局 `auto-mode.md` 在确认精确匹配旧生成物后以备份 + CAS 更新。
- 在线 smoke：Codex CLI 0.153.2 / `gpt-5.6-sol` / xhigh 与 Claude Code 2.1.261（text 模式未暴露具体模型）均使用无工具、无会话持久化调用；probe、bounded、architectural、活动 Sprint、直接 Plan 五类契约通过。Codex 必须使用真实 `$tech-persistence:think` / `$tech-persistence:plan` 入口；仅在自然语言中提及 skill 名不算有效调用。Claude 混合 skill batch 曾把 `checks` 解释为 Think 人工 gate，独立 `/tech-persistence:plan` 复验后正确输出 `placeholder`、内部一致性、`scope`、歧义，并保持 `separateSpec=false`、`lineageGate=false`。
- 在线 probe 首次暴露 route 标签自由改写；已收紧为必须原样输出三类枚举，并加入确定性回归测试后重新传播、部署和复验。
- 部署复核发现通用 Codex 文本安装器会把 `CLAUDE.md / AGENTS.md` 错转成重复的 `AGENTS.md / AGENTS.md`；回归测试先复现后，安装器已与投影器统一为 `runtime instruction docs`。活动全局 `auto-mode.md` 经备份 + CAS 修正，并与仓库投影 SHA-256 一致。扩展测试同时修正了 legacy AGENTS fixture 在 Git materialize 为 CRLF 时构造 `CRCRLF` 的测试假设。
- `node scripts/smoke-cross-platform.js`：本轮相关安装断言通过，总计 12/13；唯一失败是当前 Windows 环境无法创建 Bash service instance（`E_ACCESSDENIED`），与本次 Think/Plan 和文本转换改动无关。

## 回滚

若出现 bounded 误升级、无效文档增长或 phase 路由回归，移除本次 Think/Plan/auto-mode 契约并运行：

`node scripts/propagate-command-changes.js think plan --rules auto-mode`

已有 shadow 区块保留为普通 Markdown；无需迁移或删除用户数据。
