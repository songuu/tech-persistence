# agent-loop pipeline 模式架构

日期：2026-05-11

适用范围：

- Tech Persistence Agent Loop 编排器：`scripts/agent-orchestrator.js`
- Pipeline 子模块目录：`scripts/agent-orchestrator/`
- Pipeline schemas：`schemas/agent-loop/{global-contract,pipeline-slice,contract-revision,pipeline-queue,pipeline-locks,drift-report}.schema.json`
- Claude source command：`user-level/commands/agent-loop.md`
- Codex projection：`.codex/skills/agent-loop/SKILL.md`、`plugins/tech-persistence/skills/agent-loop/SKILL.md`

## 1. 设计定位

Pipeline 模式是 `agent-loop` 的显式 opt-in 能力，通过 `--pipeline` 进入。
默认串行模式（classic）行为完全不变：`state.mode === 'classic'` 的 run 仍然走 `draft → spec-ready → frozen → implemented → completed`，
不会调用任何 pipeline 子模块。

Pipeline 模式解决的核心问题：

- 串行模式必须等"完整 spec 冻结"才能开 Codex。需求量大时人工 freeze 成为单点瓶颈。
- 后生成的文档可能与已实现 slice 冲突，串行模式没有"局部回退"语义。

设计取舍：

- 不引入多 Codex worker、不引入 per-slice git worktree。第一版只做单 worker。
- 用版本化契约（global contract + 每个 slice contract）做不可变冻结，drift detector 处理后续变化。
- 不允许人工编辑 frozen 文件。所有契约变化必须走 `contract-revision`。

## 2. 模块边界

```text
scripts/agent-orchestrator.js                  CLI 入口、mode 分流、向后兼容
scripts/agent-orchestrator/
  ├── pipeline.js                              pipeline 编排入口；状态机驱动、各 phase 调度
  ├── pipeline-state.js                        run/slice 双层状态机常量、合法转移表与 transition event 写入口
  ├── global-contract.js                       contractHash canonical 计算、双 history 写入
  ├── slice-planner.js                         provider prompt 模板、slice 文件 I/O
  ├── slice-normalizer.js                      L4 拒绝、敏感域识别、static canStart 判定
  ├── queue.js                                 pending/ready/running/completed/blocked 队列
  ├── locks.js                                 claimed/completed-owner/released 三态、dependsOn 升级
  ├── slice-runner.js                          Codex implementation prompt、handoff/diff/validation 文件 I/O
  ├── review.js                                slice review + integration review、validation 命令聚合
  ├── drift-detector.js                        白名单触发源、五级分类
  └── reconciliation.js                        depth=1 限制、递归 revision 拒绝
```

子模块原则：

- 子模块**仅依赖** Node.js 标准库（fs/path/crypto）和其它子模块；
- 主 orchestrator 通过 `buildPipelineCtx()` 构造 ctx 对象注入共享 helper（loadRun / preflight / log / option 解析等），
  避免 pipeline 子模块反向 require 主 orchestrator 形成循环依赖；
- 每个子模块函数都是纯函数或局部 I/O，便于在 self-test 中直接调用。

## 3. 双层状态机

Run-level（整个 run 的阶段）：

```text
draft
  -> global-contract-ready
  -> global-contract-frozen
  -> planning-slices ----+
       |                 |
       v                 |
  executing-slices ------+   每完成一批 slice 后可回到 planning-slices 规划剩余
       |
       +---> contract-conflict   人工 resume --resolve 后回到 executing-slices
       |
       v
  integration-ready
       |
       v
  completed
       |
       +---> abandoned          任何阶段用户主动 abandon
```

Slice-level（每个 slice 独立维护，状态存放在 `state.pipeline.sliceStates[sliceId]`）：

```text
slice-pending
  -> slice-ready          canStart 静态条件通过
  -> slice-frozen         freeze 写入 slice.json + contractHash
  -> slice-implementing   Codex 执行中
  -> slice-implemented    validation 通过
  -> slice-reviewed       slice review approved
  -> slice-completed      drift 分类完成、locks 转 completed-owner

分支：
  slice-ready    -> slice-blocked   dispatch 时 ownedFiles 被抢占或 dependsOn 未完成
  slice-reviewed -> slice-rejected  drift 为 cross-cutting/breaking
  任意状态       -> slice-abandoned run 进入 abandoned
```

合法转移由 `pipeline-state.js` 的 `RUN_TRANSITIONS` / `SLICE_TRANSITIONS` 表显式声明，
`pipeline.js` 内部通过 `assertRunTransition` / `assertSliceTransition` 强制；非法转移立即抛错，
便于在 self-test 与开发时早暴露 bug。

## 4. 不可变契约与 hash 范围

`global-contract.json` 的 `contractHash` 仅基于 **canonical 字段集合**：

- `goal`
- `nonGoals`（写入前已按字典序排序）
- `globalAcceptance`（同上）
- `architectureConstraints`（同上）
- `runtimeTargets`（同上）

明确排除：

- `blockingQuestions`（问答交互会反复修改，纳入会让已冻结 slice 全部 hash 失配）
- `riskLevel`（属于运行时元数据）
- `integrationValidationCommands`（属于运行时配置，不属于契约）
- `version` / history 元数据

因此修改 `blockingQuestions` 不会让任何 frozen slice 失效。这是 drift detector 的边界。

每个 slice 的 `contractHash` 由 `sliceNormalizer.computeSliceHash` 计算，
包含 slice id/title/dependsOn/ownedFiles/acceptanceCriteria/doneCriteria/risk 以及 **当时的** global contract hash。
这意味着 slice 与某个具体版本的 global contract 绑定。

## 5. 两份 history 文件

```text
.agent-runs/<runId>/global-contract.history.jsonl    contract 文件层快照
.agent-runs/<runId>/contract-revisions.jsonl         字段层 revision 申请与裁决记录
```

- `global-contract.history.jsonl`：每次写入 contract 都追加一行完整快照，含 `cause`（initial / freeze / dry-run / revision-applied 等）。
  用途：审计文件何时被改、改成了什么。
- `contract-revisions.jsonl`：每次 revision 申请追加一行，含 `revisionId / source / fields / classification / resolution`。
  用途：审计契约字段层面发生过哪些变更申请、谁批准谁拒绝。

source of truth：
- 契约字段查询读 `global-contract.json`（最新）。
- revision 历史查询读 `contract-revisions.jsonl`。
- 文件运行时审计读 `global-contract.history.jsonl`。

## 6. Drift detector 白名单触发

`drift-detector.js` 的 `classify(revision, context)` 拒绝来源不在以下白名单的 revision：

- `slice-review`：slice review provider 在 `review.json` 内显式声明 `contractRevisions[]`。
- `slice-planner-replan`：slice planner 重入时，新 slice 与已冻结 contract 字段的差分自动生成候选。

**不接受**人工编辑源文件的 diff、不接受 hook 隐式推断。

分类规则：

| 触发条件 | classification | action |
|---------|----------------|--------|
| `source = slice-review` 且 sourceSlice 是 reconciliation（depth≥1） | cross-cutting | escalate-recursive-revision |
| 修改 `goal` 或 `globalAcceptance` | breaking | enter-contract-conflict |
| 修改 `nonGoals` 且新值移除了已冻结条目 | breaking | enter-contract-conflict |
| 修改 `architectureConstraints` 且完成+运行中 slice ≥ 2 | cross-cutting | enter-contract-conflict |
| 修改 `architectureConstraints` 且完成 slice = 1 | completed-local | create-reconciliation-slice |
| 修改 `architectureConstraints` 且仅 pending slice 受影响 | pending-only | replan-pending-queue |
| 修改 `runtimeTargets` / `nonGoals` 且仅 pending 受影响 | pending-only | replan-pending-queue |
| 其它 | compatible | update-future-base |

## 7. Reconciliation 递归终止

`reconciliation.js` 强制三条递归终止规则：

1. `depth` 字段记录补偿层级，初始为 1；`ensureDepthLimit` 拒绝 `depth > 1` 的 slice。
2. `rejectRecursiveRevision(review)` 在 reconciliation slice review 的 `contractRevisions[]` 上强制清空，
   将原数组保留到 `recursiveRevisionsBlocked` 仅用于审计；drift detector 也会把同情况判为 `cross-cutting`。
3. normalizer 拒绝 reconciliation slice 的 `dependsOn` 中包含其它 `reconcile-*` id。

任何违反都会让 drift detector 把这条 revision 判为 `cross-cutting` 并升级到 `contract-conflict`。

## 8. Lock 三态与 dependsOn 升级

`locks.js` 维护文件级锁，三态：

- `claimed`：slice 在 `slice-frozen` 或 `slice-implementing` 阶段，独占写入权。
- `completed-owner`：slice 已 `slice-completed`，只读保护。
- `released`：仅 abandoned slice 或 run 失败回滚使用。

`classifyClaim(locks, slice)` 把每个 ownedFile 划分到三类：

- `claimable`：未占用或当前 slice 自己持有。
- `blockedBy`：被其它 slice claimed 或被 completed-owner 占用且 dependsOn 不含该 owner。
- `upgradable`：被 completed-owner 占用但 dependsOn **显式包含** 该 owner（合法接管）。

第一版只允许单 Codex worker，dispatcher 选 slice 前先做 classify；任何 `blockedBy` 非空就进 `slice-blocked`。

## 9. CLI surface

```bash
# 启用 pipeline 模式（只在 run 时生效）
node scripts/agent-orchestrator.js run --requirement "..." --pipeline
node scripts/agent-orchestrator.js run --requirement "..." --pipeline --auto

# Pipeline freeze 必须显式 target；缺失立即报错
node scripts/agent-orchestrator.js freeze --run <id> --target global-contract
node scripts/agent-orchestrator.js freeze --run <id> --target slice --slice-id <slice>

# contract-conflict 恢复路径
node scripts/agent-orchestrator.js resume --run <id> --resolve accept-revision --revision <id>
node scripts/agent-orchestrator.js resume --run <id> --resolve reject-revision --revision <id>
node scripts/agent-orchestrator.js resume --run <id> --resolve abandon
node scripts/agent-orchestrator.js resume --run <id> --unblock <sliceId>

# 任何阶段可主动 abandon
node scripts/agent-orchestrator.js abandon --run <id>
```

向后兼容：

- 不传 `--pipeline` 时 `runStart` 走 classic 路径，所有现有命令、参数、行为不变。
- `state.mode` 字段在 classic run 上为 `"classic"`，在 pipeline run 上为 `"pipeline"`。
- `freezeRun` 对 classic run 不要求 `--target`；对 pipeline run 强制要求。
- 缺失 `mode` 字段的旧 state.json 视为 classic。

## 10. `--auto` 协议

`--auto` 只能自动 freeze 同时满足以下条件的对象（**正向定义**）：

**Global contract safe**：

- `riskLevel` ≤ L2。
- `blockingQuestions` 为空。
- 不触及"强制人工 Gate"任一项。
- normalizer 输出与 provider 原始输出语义等价。

**Slice safe**（`sliceNormalizer.isSliceSafeForAuto`）：

- `risk` ≤ L2。
- `ownedFiles.length` ≤ 5。
- `dependsOn` 全部 `slice-completed`。
- `questions` 为空。
- `sensitiveAreas` 为空（不涉及 auth / secret / migration / destructive / api / data-schema / storage-path）。
- 不触及"强制人工 Gate"。

**Reconciliation slice**：永不自动 freeze（无论分类）。

**灰区**（既非强制人工 Gate 也非 safe）：默认走人工 gate，写入 `state.pipeline.autoSkipped[]` 用于事后分析。

## 11. 测试与验证

最低验证：

```bash
node scripts/agent-orchestrator.js self-test
node scripts/agent-orchestrator.js run --requirement "smoke" --preflight-only
node scripts/agent-orchestrator.js run --requirement "smoke" --pipeline --dry-run
node scripts/validate-codex-plugin.js
git diff --check
```

self-test 覆盖（`runPipelineSelfTests`）：

- 双层状态机合法/非法转移
- 6 个 pipeline schemas 解析
- 3 个 provider-facing schemas 严格性
- contractHash 排除 blockingQuestions
- contractHash 对乱序数组等价
- L4 slice 拒绝
- 敏感域 slice 自动识别 + 拒绝
- safe slice 通过 static canStart
- queue 完整状态迁移
- locks claimed → completed-owner、dependsOn 升级路径
- 4 类 drift 分类（breaking / cross-cutting / pending-only / completed-local）
- drift 来源白名单（user-edit 抛错）
- reconciliation depth>1 拒绝
- reconciliation revision 递归剥离
- integration validation 命令聚合顺序与去重
- newPipelineState mode/status 正确
- transition events 记录 from / to / actor / source / reason
- provider 模块禁止直接写 terminal slice/run status
- changed-files gate owned/out-of-scope/generated/dirty baseline 路径

dry-run 端到端验证：

- `run --pipeline --dry-run` 写出完整 artifact 拓扑（global-contract / queue / locks / history / slice 目录）。
- `status` / `resume` / `freeze` / `abandon` 在 pipeline run 上正确分派。
- 同一脚本 `run --dry-run` (无 `--pipeline`) 走 classic 路径。

## 12. 部署与同步

源头：

- `user-level/commands/agent-loop.md` 是 Claude source command。
- `scripts/agent-orchestrator.js` + `scripts/agent-orchestrator/` 是执行真相。

派生：

- `.codex/commands/agent-loop.md` 由 `scripts/propagate-command-changes.js` 从 source 转写而来。
- `plugins/tech-persistence/commands/agent-loop.md` 与 `plugins/tech-persistence/skills/agent-loop/SKILL.md`
  由 `plugins/tech-persistence/scripts/build-codex-plugin.js` 生成。

任何 pipeline 行为修改后必须按以下顺序同步：

1. 改 source command + `scripts/agent-orchestrator/*` + `scripts/agent-orchestrator.js`。
2. `node scripts/propagate-command-changes.js` 同步 4 个副本。
3. `node plugins/tech-persistence/scripts/build-codex-plugin.js` 重新生成 plugin。
4. `node scripts/validate-codex-plugin.js` 校验。
5. `node scripts/agent-orchestrator.js self-test` 全套通过。

## 13. 当前实现限制（2026-06-01）

本文件描述的是 pipeline 目标架构。当前实现已经有 global contract、slice queue、locks、drift detector、contract conflict resolver 和 dry-run 验证，但还没有把所有约束都落成强制门禁。后续修改需要优先消除以下差距。

对应执行路线见 `docs/plans/2026-05-12-pipeline-hardening-roadmap.md`。本节只记录架构现状和限制，具体拆解、代码落点和验收矩阵放在 roadmap 中维护。

### 13.1 状态机写入口已收口

**当前状态（2026-06-01）**：`pipeline-state.js` 已提供 `transitionRun()` / `transitionSlice()` 作为统一状态写入口，并写入 `state.pipeline.transitionEvents[]`，事件字段包含 `from` / `to` / `reason` / `actor` / `source`。`pipeline.js` 与 `pipeline-providers.js` 的 run/slice 状态推进已改为调用该 helper，self-test 会扫描 provider 模块，禁止直接写 terminal slice/run status。

已落地：

- 所有状态写入都经过 transition check。
- validator 禁止 provider 模块直接写状态终态。
- review approved 路径显式走 `slice-implemented -> slice-reviewed -> slice-completed`，不再跳过 `slice-reviewed`。

仍待补：

- provider 仍会负责组合状态变更和 artifact 写入；若继续收敛，可以把 provider 输出进一步降成 result object，由 pipeline reducer 单点应用。
- `pipeline.history.jsonl` 与 `state.pipeline.transitionEvents[]` 仍是两条审计线，后续可在 Task 8 里验证两者一致性。

### 13.2 slice 执行缺少事务边界

**当前状态（2026-05-12）**：第一批修复已落地。slice implementation failure 会写入 `implementation-failure.json` 与 `pipeline.history.jsonl`，状态进入 `slice-implementation-failed`，queue 进入 blocked，并释放该 slice locks。后续仍可继续增强 retry/status UX。

当前 slice 从 queued 进入 running 后，会声明 locks 并写入 implementing。若 provider 调用失败，系统需要明确写入 failure / blocked / retryable 状态，而不是把半成品留给 review 继续处理。

必须补齐的门禁：

- review 只能处理 evidence-complete 的 slice。
- provider failure 必须写 failure event。
- lock release / retain 需要显式策略。
- resume 需要按失败类型决定 retry、block 还是人工介入。

### 13.3 `ownedFiles` changed-files gate 已落地

**当前状态（2026-06-01）**：slice implementation provider 会在执行前后对 git changed-files 做快照，并用文件指纹识别本 slice 实际触碰的文件。触碰文件必须落在 `ownedFiles` 范围内，或命中 `generated` / `managed` exception；否则写入 `changed-files-gate.json` 后抛错，走 implementation failure/block 流程，阻断 `slice-implemented` / `slice-completed`。

已落地：

- slice 完成时计算 provider 前后 touched files，而不是只看全局 diff。
- out-of-scope diff 默认阻断状态推进。
- `changed-files-gate.json` 进入 slice evidence 和 review prompt。
- `generated` / `managed` exception 已有确定性分类。

仍待补：

- `shared-contract` exception 需要和 Task 5/Task 7 的状态事件与计划源头收敛一起定义，避免 provider 自行声明共享写权限。
- 多 worker 前仍需要 isolated worktree 或更强 per-slice baseline 策略，防止并发写同一 dirty file。

### 13.4 contract conflict resolver 需要实现闭环审计

**当前状态（2026-05-12）**：第一批修复已落地。`accept-revision` 会应用 contract revision、记录 applied hash、supersede affected pending slices，并为 affected completed slices 生成 reconciliation slice。后续仍需继续补更完整的 pending replan 策略。

文档目标是 accept revision 后更新 global contract、supersede pending slices、为 completed-local 生成 reconciliation slice。当前实现需要继续对齐这条闭环，避免“记录了接受事件，但执行计划仍基于旧 contract”的 false success。

最低要求：

- `accept-revision` 产生新的 contract version。
- affected pending slices 不能继续按旧 contract 执行。
- affected completed slices 必须进入 reconciliation。
- resolver 后必须跑 drift check。

### 13.5 当前 pipeline 仍是单 worker 执行模型

当前 architecture 已为 parallel slices 做了 queue / lock / dependsOn 设计，但实现上仍应按 single worker 理解，不能把它当成真正的多 agent 并行执行系统。

扩展到多 worker 前至少需要：

- 更强 per-slice baseline 或 isolated worktree 策略。
- 状态事件唯一写入口。
- provider failure transaction。
- shared files conflict policy。
- per-slice baseline 或 isolated worktree 策略。

### 13.6 Codex projection 必须保留 provenance

**当前状态（2026-06-01）**：已修复。Codex plugin build 对 agent-loop skill 做 provider provenance 保留，`validate-codex-plugin.js` 会检查必备 Claude Code provider 来源片段，并禁止生成“Codex 负责 global contract / integration review”这类与实际 provider 分工不符的文案。

本仓库的来源关系是 Claude Code skill 为 origin，Codex skill 为 projection。生成 Codex plugin 时，不能用全局替换抹掉 provider provenance。

已落地：

- projection 文档显式保留 Claude Code provider / Codex projection 的来源关系。
- build 脚本对 agent-loop command-to-skill 转换做定向修正。
- validator 检查 projection 文档是否声称 Codex 执行了当前代码实际不会执行的角色。

### 13.7 CLI flag 需要做 docs parity

**当前状态（2026-05-12）**：已修复。`--auto` 是 canonical flag，`--auto-evaluate` 与 `--auto-freeze` 是兼容别名；`validate-codex-plugin.js` 已增加 agent-loop auto flag parity 检查。

classic orchestrator、pipeline 文档和 skill 文档里的 `--auto`、`--auto-evaluate`、`--auto-freeze` 需要统一。当前读者不能只看文档就判断哪个参数是真实入口。

建议先做兼容别名，再收敛到一个 canonical flag，并把 help / docs / skill / README 放进同一条 parity check。

### 13.8 plans source of truth 已收敛

**当前状态（2026-06-01）**：`docs/plans` 已作为 human-readable source of truth。`runtime-paths.js` 提供 `resolvePlanDirectories()` / `resolvePlanPath()` / `resolvePlanWritePath()`，来源类型为 `sourceOfTruth`、`runtimeCache`、`legacyFallback`。隐藏目录 `.codex/plans` / `.claude/plans` 保留为 runtime cache / legacy fallback，不再作为默认计划写入目标。

已落地：

- `resolveProjectPlansDir()` 返回 `docs/plans`，新计划默认写入用户可审阅目录。
- `inject-context.js` 的 prototype 状态恢复按 `docs/plans` 优先搜索，并在注入上下文里标出 `sourceType`。
- `test-inject-context-cost-summary.js` 覆盖 plan resolver 优先级和 prototype source-of-truth 注入。
- `validate-codex-plugin.js` 检查插件副本里的 plan source-of-truth helper 和 `inject-context` 投影。

仍待补：

- 历史 `.codex/plans` / `.claude/plans` artifact 不做批量迁移；只通过 fallback 兼容读取。
- 后续如果 native workflow backend 落地，需要把 workflow artifact 与 `docs/plans` 的关系写入同一 resolver，而不是新增第四套 plan 目录约定。
