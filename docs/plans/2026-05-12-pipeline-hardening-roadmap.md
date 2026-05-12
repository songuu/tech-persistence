---
title: "Pipeline hardening roadmap"
type: architecture-hardening-plan
status: in-progress
created: "2026-05-12"
updated: "2026-05-12"
checkpoints: 0
tasks_total: 8
tasks_completed: 3
tags: [agent-loop, pipeline, architecture, hardening]
aliases: ["pipeline hardening", "agent-loop pipeline hardening", "pipeline 缺陷修复路线"]
---

# Pipeline hardening roadmap

> **Status:** `in-progress`
> **Scope:** 修复 2026-05-12 架构审查发现的 P0 / P1 缺陷。
> **Source:** `docs/architecture/ARCHITECTURE_ISSUES.md` 的“当前架构深层缺陷”与 `docs/architecture/agent-loop-pipeline-architecture.md` 的“当前实现限制”。

## 目标

把 pipeline 从“目标架构已经写清楚，但部分约束依赖约定”推进到“关键状态、契约、文件边界和运行时投影都有确定性门禁”。

必须优先保护：

- 默认 classic `/agent-loop` 行为不变。
- `--pipeline` 仍是显式 opt-in。
- Claude Code origin / Codex projection 的来源关系不变。
- trust-critical 逻辑继续在 `scripts/` deterministic 层，不下沉到 skill markdown。
- 文档、source command、Codex projection、plugin 生成物保持可验证同步。

## 不做

- 不在本轮引入真正多 worker 并行执行。
- 不默认启用 `--pipeline`。
- 不把 `.codex/plans` / `.claude/plans` 直接删除；只先收敛 source-of-truth 语义。
- 不把 provider review 结果当最终验收事实；最终仍以 deterministic validation 和 integration review 为准。
- 不把所有历史 artifact 做迁移；只保证新 run 语义正确，旧 run 兼容读取。

## 风险和假设

- 风险：本 roadmap 涉及 source command、`.codex` projection、plugin 副本和项目级安装验证，单点修改容易造成多分发面漂移。
- 风险：pipeline 状态、queue、locks、contract revision 同时变化时，最容易产生 false success，因此每个 P0 task 必须有 self-test 覆盖。
- 假设：当前批次只推进 hardening，不改变默认 classic `/agent-loop` 行为，不默认启用 `--pipeline` 或 `--auto`。

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| classic `/agent-loop` 默认行为不能被 hardening 改动破坏 | Read `scripts/agent-orchestrator.js`，确认 `runStart()` 仍只在显式 `--pipeline` 时进入 pipeline，且未传 `--auto` 时仍停在 spec review gate | 已确认：默认路径仍走 classic run，`--auto` 只是显式参数；`node scripts/agent-orchestrator.js self-test` 已通过 |
| 双运行时派生副本必须和 source command / orchestrator 同步 | Read `user-level/commands/agent-loop.md`、`.codex/commands/agent-loop.md`、`plugins/tech-persistence/commands/agent-loop.md`，并运行 plugin build / validation | 已确认：`node plugins/tech-persistence/scripts/build-codex-plugin.js`、`node scripts/validate-codex-plugin.js` 已通过 |
| pipeline failure 和 contract-conflict 修复必须有确定性回归，而不是只靠文档约定 | Read `scripts/agent-orchestrator.js` self-test 区域，确认覆盖 provider failure、accept revision、reject revision 三条路径 | 已确认：root 与 plugin 的 `agent-orchestrator.js self-test` 都已通过，覆盖 failure blocking、contract apply、reconciliation 生成和 reject reason |

## 优先级原则

| 层级 | 修复对象 | 判断标准 |
|------|----------|----------|
| P0 | 用户按文档执行会走错路径，或失败状态可能被误判为成功 | 先修 |
| P1 | pipeline isolation / provenance / state audit 不可信 | 第二批修 |
| P2 | 目录命名、兼容读取、体验增强 | 后置 |

## Phase 1：先消除 false success

### Task 1：统一 classic / pipeline 的 auto flag

**状态**：已完成（2026-05-12）

**问题**

文档和 skill 使用 `--auto` / `--auto-evaluate`，classic orchestrator 主要识别 `--auto-freeze`。这会让用户按文档运行时走不到预期自动评估路径。

**代码落点**

- `scripts/agent-orchestrator.js`
- `user-level/commands/agent-loop.md`
- `.codex/commands/agent-loop.md`
- `plugins/tech-persistence/commands/agent-loop.md`
- `plugins/tech-persistence/skills/agent-loop/SKILL.md`
- `scripts/validate-codex-plugin.js`

**实现要求**

- 选择一个 canonical flag，建议保留用户可见的 `--auto`。
- `--auto-evaluate` 与 `--auto-freeze` 做兼容别名。
- CLI help、source command、Codex projection、plugin skill 必须同口径。
- validator 增加 flag parity 检查。

**验收**

- `node scripts/agent-orchestrator.js --help` 能看到 canonical flag 与别名说明。
- `rg -n "--auto-evaluate|--auto-freeze|--auto" user-level .codex plugins scripts` 的命中都符合别名关系。
- `node scripts/validate-codex-plugin.js` 通过。

**实际结果**

- `scripts/agent-orchestrator.js` 将 `--auto`、`--auto-evaluate`、`--auto-freeze` 统一为同一组布尔别名。
- classic 路径改为读取 canonical `--auto`，自动冻结记录为 `specFrozenBy: "auto"`。
- `user-level/commands/agent-loop.md`、`.codex` projection、plugin command / skill 全部改为新调用只生成 `--auto`。
- `scripts/validate-codex-plugin.js` 增加 agent-loop auto flag parity 检查。
- 验证通过：`node scripts/agent-orchestrator.js --help`、`node scripts/agent-orchestrator.js self-test`、`node scripts/validate-codex-plugin.js`、`git diff --check`。

### Task 2：provider failure 必须写明确失败态

**状态**：已完成（2026-05-12）

**问题**

slice 从 queued 进入 running 后，如果 provider 执行失败，当前状态可能停在 `slice-implementing`，后续 resume / review 容易把它误认为可审查实现。

**代码落点**

- `scripts/agent-orchestrator/pipeline.js`
- `scripts/agent-orchestrator/pipeline-state.js`
- `scripts/agent-orchestrator/pipeline-schemas.js`
- `scripts/agent-orchestrator/pipeline-providers.js`

**实现要求**

- 增加 `slice-implementation-failed` 或 `slice-blocked` 明确语义。
- provider 异常、非零退出、schema parse 失败、validation failure 必须写 failure event。
- review 入口必须校验 evidence-complete：handoff、diff、validation 至少有明确存在或明确缺席原因。
- lock release / retain 写入事件，不隐式处理。

**验收**

- mock provider failure self-test：失败后 slice 不进入 review。
- resume 对 failed slice 给出 retry / block / abandon 的明确下一步。
- `history.jsonl` 能看出失败原因、provider、exit code 和 lock 策略。

**实际结果**

- `pipeline-state.js` 增加 `slice-implementation-failed` 状态，允许从 failure 回到 `slice-ready` / `slice-pending` 重试。
- `pipeline.js` 在 slice implementation provider 失败时写入 `slices/<id>/implementation-failure.json`，释放该 slice locks，并把 queue 移入 blocked。
- resume 遇到缺少 handoff / diff / validation 的 `slice-implementing` 时不再进入 review，而是阻断为 implementation failure。
- `runProcess()` 抛错时携带 `providerRecord`，pipeline failure artifact 和 `pipeline.history.jsonl` 可以保留 provider label、status 和日志路径。
- 验证通过：root/plugin `agent-orchestrator.js self-test`、`node scripts/validate-codex-plugin.js`、`git diff --check`。

### Task 3：contract-conflict resolve 必须应用 contract revision

**状态**：已完成（2026-05-12）

**问题**

文档要求 accept revision 后更新 global contract、重排 affected slices、生成 reconciliation slice；实现需要补齐这条闭环，避免只记录 accepted event。

**代码落点**

- `scripts/agent-orchestrator/pipeline.js`
- `scripts/agent-orchestrator/pipeline-reconciliation.js`
- `scripts/agent-orchestrator/pipeline-schemas.js`
- `scripts/agent-orchestrator/pipeline-state.js`

**实现要求**

- `accept-revision` 产生新的 `global-contract.json` 版本或等价版本记录。
- pending affected slices 标记 superseded / replanned，不再按旧 contract 执行。
- completed affected slices 自动生成 reconciliation slice。
- resolve 后强制运行 drift check。

**验收**

- breaking / cross-cutting revision 被 accept 后，contract hash 改变。
- pending affected slice 不再保持旧 hash 的 ready 状态。
- completed-local 场景生成 reconciliation slice。
- reject revision 后 contract 与 queue 不变，并写入 reject reason。

**实际结果**

- `global-contract.js` 增加 revision event 读取与按 `revisionId` 查找原始 revision 的 helper。
- `accept-revision` 会调用 `applyRevisionToContract()` 并以 `revision-applied` 写回 `global-contract.json` / `global-contract.history.jsonl`。
- `drift-report.json` 中的 affected pending slices 会被标记为 `slice-rejected`，slice artifact 写入 `supersededByRevision`。
- `drift-report.json` 中的 affected completed slices 会生成 reconciliation slice，并进入 queue。
- `contract-revisions.jsonl` 和 `pipeline.history.jsonl` 会记录 accepted revision、applied contract hash、superseded slices 和 reconciliation slice id。
- `reject-revision` 保持 contract / queue 不变，并记录 human reason 到 `contract-revisions.jsonl` 与 `pipeline.history.jsonl`。
- 验证通过：root `agent-orchestrator.js self-test` 覆盖 accept-revision contract apply / pending supersede / reconciliation 生成。

## Phase 2：让 pipeline isolation 变成硬门禁

### Task 4：引入 changed-files gate

**问题**

`ownedFiles` 当前主要是计划和锁的约束，没有校验真实 diff。实现完成后记录全局 worktree diff，无法证明 slice 没越界。

**代码落点**

- `scripts/agent-orchestrator/pipeline.js`
- `scripts/agent-orchestrator/pipeline-locks.js`
- `scripts/agent-orchestrator/pipeline-schemas.js`
- `scripts/agent-orchestrator.js`

**实现要求**

- slice 完成前计算 changed files。
- changed files 必须是 `ownedFiles` 子集，或命中显式 exception。
- exception 类型至少区分 `generated`、`managed`、`shared-contract`。
- out-of-scope diff 默认阻断 `slice-completed`。

**验收**

- mock slice 修改未声明文件时进入 blocked / rejected。
- managed artifact 仍被排除，不误伤 `.agent-runs/`、`node_modules/`、`dist/` 等路径。
- integration review 能看到按 slice 分组的 changed files。

### Task 5：状态事件唯一写入口

**问题**

`pipeline-state.js` 定义了状态机，但 provider / pipeline 层仍可能直接写状态事件。状态机还不是唯一门禁。

**代码落点**

- `scripts/agent-orchestrator/pipeline-state.js`
- `scripts/agent-orchestrator/pipeline.js`
- `scripts/agent-orchestrator/pipeline-providers.js`
- `scripts/agent-orchestrator/run-context.js`（如存在事件写 helper）

**实现要求**

- 建立 `transitionRun()` / `transitionSlice()` 或统一 reducer。
- provider 返回 result，不写 `slice-*` 终态。
- 所有状态事件包含 `from`、`to`、`reason`、`actor`、`source`。
- validator 或 self-test 检查 provider 模块没有直接写状态终态。

**验收**

- 非法 transition self-test 会失败。
- provider 模块搜索不到直接写 `slice-completed` / `slice-reviewed` 等终态的路径。
- 新旧 history 仍可兼容读取。

## Phase 3：收敛双运行时和计划源头

### Task 6：Codex projection 保留 provenance

**问题**

Codex skill 是 Claude Code source command 的 projection。生成脚本如果做无上下文替换，会让 Codex 文档声称自己执行了实际仍由 Claude provider 承担的角色。

**代码落点**

- `plugins/tech-persistence/scripts/build-codex-plugin.js`
- `plugins/tech-persistence/skills/agent-loop/SKILL.md`
- `scripts/validate-codex-plugin.js`
- `docs/architecture/agent-loop-pipeline-architecture.md`

**实现要求**

- projection 使用 `analysis provider` / `implementation provider` / `review provider` 等 runtime-neutral 术语。
- 明确写出 Claude Code origin、Codex projection。
- validator 检查 projection 文档不出现误导性 provider ownership。

**验收**

- plugin build 后不会生成“Codex 负责 global contract / integration review”这类与代码不符的语义。
- `node scripts/validate-codex-plugin.js` 能捕获 provenance 漂移。

### Task 7：统一 plans source of truth

**问题**

`docs/plans`、`.codex/plans`、`.claude/plans` 职责混杂。用户可审阅计划与 runtime cache 没有明确边界。

**代码落点**

- `scripts/inject-context.js`
- `scripts/lib/runtime-paths.js`
- `user-level/commands/work.md`
- `user-level/commands/plan.md`
- Codex / plugin projection 副本

**实现要求**

- `docs/plans` 明确为 human-readable source of truth。
- `.codex/plans` / `.claude/plans` 仅作为 runtime cache / legacy fallback。
- plan resolver 返回来源类型：`sourceOfTruth`、`runtimeCache`、`legacyFallback`。
- 写计划默认进入 `docs/plans`。

**验收**

- `$work` / `/work` 的输入来源优先 `docs/plans`。
- fallback 命中隐藏目录时有明确日志或上下文标记。
- `rg -n "\\.codex/plans|\\.claude/plans" user-level .codex plugins scripts` 的命中都说明是 fallback / cache，不再冒充 source of truth。

## Phase 4：验证矩阵和发布同步

### Task 8：补 hardening 验证矩阵

**问题**

这些修复跨 classic CLI、pipeline state、provider adapter、projection build 和 plugin validation，只跑单个 self-test 不够。

**代码落点**

- `scripts/agent-orchestrator.js`
- `scripts/validate-codex-plugin.js`
- `scripts/validate-codex-install.js`
- `scripts/validate-claude-install.js`
- `docs/architecture/ARCHITECTURE_ISSUES.md`

**验收矩阵**

```bash
node scripts/agent-orchestrator.js self-test
node scripts/agent-orchestrator.js run --requirement "smoke" --preflight-only
node scripts/agent-orchestrator.js run --requirement "smoke" --pipeline --dry-run
node scripts/validate-codex-plugin.js
node scripts/validate-codex-install.js --project
node scripts/validate-claude-install.js --project
git diff --check
```

如果涉及 provider 真实调用，再补：

```bash
node scripts/agent-orchestrator.js doctor --probe --skip-git-repo-check
```

**验收**

- 每个 P0 / P1 修复都有 self-test 或 targeted smoke。
- plugin 生成物与 source command 一致。
- 项目级 Claude / Codex 安装副本一致。
- 文档中的 flags、provider provenance、plan source-of-truth 与代码行为一致。

## 推荐实施顺序

1. **先修 Task 1**：命令入口不一致是最直接的用户可见错误。
2. **再修 Task 2 + Task 3**：先防 false success，再处理 contract conflict 的闭环。
3. **然后修 Task 4 + Task 5**：把 slice isolation 和状态审计变成硬门禁。
4. **最后修 Task 6 + Task 7**：收敛 projection 和计划源头，降低长期漂移。
5. **每批结束跑 Task 8 矩阵**：不要等全部完成后才发现副本或插件漂移。

## 完成定义

- P0 缺陷全部有代码修复和回归测试。
- P1 缺陷至少有硬门禁或 validator，不能只停留在文档说明。
- `docs/architecture/ARCHITECTURE_ISSUES.md` 中对应问题标注为已修或降级。
- `docs/architecture/agent-loop-pipeline-architecture.md` 的“当前实现限制”被更新为真实剩余限制。
- `docs/plans/2026-05-09-agent-loop-pipeline.md` 保持历史 implemented 记录，不再被当作当前 hardening 计划修改。
