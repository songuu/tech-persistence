---
title: "Agent Loop pipeline mode"
type: architecture-plan
status: implemented
created: "2026-05-09"
updated: "2026-05-11"
checkpoints: 0
tasks_total: 13
tasks_completed: 13
tags: [agent-loop, pipeline, claude-code, codex, orchestrator]
aliases: ["agent-loop --pipeline", "pipeline mode", "slice freeze"]
---

# Agent Loop pipeline mode

> **Status:** `implemented`
> **Created:** 2026-05-09
> **Updated:** 2026-05-11（13 个 Task 全部落地，回归通过）

---

## 需求分析

### 要做
- 为 `agent-loop` 增加显式 opt-in 的 `--pipeline` 模式。
- 保持默认 `/agent-loop <需求>` / `$agent-loop <需求>` 行为完全不变。
- 将当前“完整 spec 冻结后再执行”的串行流程扩展为“全局契约冻结 + slice 分片冻结 + Codex 流水线执行 + Claude Code 分层复审”。
- 引入 contract revision / drift detector / reconciliation slice 兜底，处理后生成文档与已执行 slice 不一致的问题。
- 保持 Claude Code 是需求、设计、拆解、复审的 source-of-truth；Codex 只实现已冻结契约。
- 保持 Claude Code 与 Codex 两个入口调用同一个 orchestrator，避免运行时行为漂移。

### 不做
- 不改变默认 `agent-loop` 串行模式。
- 不让 Codex 执行未冻结的 global contract 或 slice。
- 第一版不做多 Codex worker 并发写入同一仓库。
- 第一版不强制引入 per-slice git worktree；多 worktree 合并队列放到后续阶段。
- 不把后生成文档静默覆盖已冻结文档。
- 不绕过现有 provider adapter、structured output codec、contract normalizer、artifact manager、validation runner、state machine 六层边界。

### 成功标准
- [ ] 不传 `--pipeline` 时，现有 v7 串行模式 self-test 和行为保持不变。
- [ ] 传 `--pipeline` 时，run state 明确记录 `mode: "pipeline"`。
- [ ] pipeline 模式先生成并冻结 `global-contract.json`，再允许 slice planning。
- [ ] Codex 只能执行 `slice-frozen` 且 contract hash 匹配的 slice。
- [ ] `ownedFiles` 冲突会阻塞 slice，不会并发写同一文件。
- [ ] 新文档与冻结契约不一致时生成 `contract-revision`，不会静默覆盖旧文档。
- [ ] 漂移分类为 `compatible` / `pending-only` / `completed-local` / `cross-cutting` / `breaking`。
- [ ] `completed-local` 自动生成 reconciliation slice。
- [ ] `cross-cutting` / `breaking` 进入 `contract-conflict`，必须人工处理。
- [ ] 最终只有 integration review 通过后，run 才能进入 `completed`。

### 风险和假设
- 风险：过早 slice 执行导致后续设计反悔。缓解：冻结内容不可变；后续变化只能通过 contract revision 和 drift detector 处理。
- 风险：多 slice 修改同一文件造成冲突。缓解：第一版只做单 Codex worker，并用 `locks.json` 管理 `ownedFiles`。
- 风险：pipeline artifact 变多，恢复复杂度提高。缓解：所有状态写入 `.agent-runs/<runId>/state.json`、`queue.json`、slice 子目录和 history jsonl。
- 风险：Claude Code 与 Codex 文档投影漂移。缓解：继续从 `user-level/commands/agent-loop.md` 生成 Codex skill projection，并验证 plugin 输出。
- 假设：`--pipeline` 是实验性 opt-in 能力；稳定默认模式必须优先保护。

---

## 技术方案

### 方案概述

在现有 `agent-loop` 外部 orchestrator 上增加 pipeline mode。默认 mode 仍是 `classic`，只有用户显式传入 `--pipeline` 才进入新状态机。pipeline mode 先由 Claude Code 生成全局契约，冻结后再持续生成可执行 slice。每个 slice 独立冻结、独立执行、独立 validation、独立 review，最后由 Claude Code 做 integration review。

兜底机制以版本化契约为核心：已冻结 global contract 和 slice contract 不允许被后续文档静默覆盖。后续文档如果改变早期约束，只能生成 `contract-revision`，再由 drift detector 做影响分析，并选择重排 pending slice、生成 reconciliation slice、暂停 pipeline 或废弃当前 run。

### 总体流程

```text
run --pipeline
  -> preflight
  -> global contract provider (Claude Code)
  -> freeze global contract
  -> slice planner (Claude Code)                     <-- 可重入：每完成一批 slice 后再次规划剩余
       |
       v
  +--> queue ready slices
  |    -> freeze slice
  |    -> claim locks (ownedFiles, status=claimed)
  |    -> implementation provider (Codex)
  |    -> validation runner
  |    -> slice review provider (Claude Code)
  |    -> drift detector (输入：本次 slice review 输出的 contractRevisions[] 候选)
  |          -> compatible / pending-only            -> 继续下一个 slice
  |          -> completed-local                      -> 生成 reconciliation slice 后继续
  |          -> cross-cutting / breaking             -> contract-conflict (人工 resume --resolve)
  |    -> mark locks as completed-owner (不释放)
  +--- 还有 ready slice 或 pending slice 可解锁 -> 回到队首
       |
       v
  -> 全部 required slice 处于 slice-completed
  -> integration review provider (Claude Code)
  -> completed
```

> **drift detector 输入来源（白名单）**：
> (a) slice review provider 在 `review.json` 内显式声明的 `contractRevisions[]`；
> (b) slice planner 重入时新生成 slice 与已冻结 global contract 的字段差分。
> 不读取人工编辑的源文件，不从 diff 推断，避免静默触发。

### 状态机

Classic 模式保持现状：

```text
draft -> spec-ready -> frozen -> implemented -> completed
```

Pipeline 模式分两层状态机：Run-level 描述整个 run 的阶段；slice-level 描述每个 slice 的独立生命周期。
两者并行存在，run 处于 `executing-slices` 时由 slice 状态机驱动；run 进入 `contract-conflict` 时所有
running slice 暂停在当前 slice 状态，等待人工裁决。

**Run-level 状态**

```text
draft
  -> global-contract-ready
  -> global-contract-frozen
  -> planning-slices ----+
        |                |
        v                |
  executing-slices ------+   (每完成一批 slice 后可回到 planning-slices 规划剩余)
        |
        +---> contract-conflict   (人工 resume --resolve 后回到 executing-slices)
        |
        v
  integration-ready
        |
        v
  completed
        |
        +---> abandoned          (任何阶段用户主动 abandon)
```

**Slice-level 状态**（每个 slice 独立维护）

```text
slice-pending
  -> slice-ready          (canStart 静态条件通过)
  -> slice-frozen         (freeze 写入 slice.json + contractHash)
  -> slice-implementing   (Codex 执行中)
  -> slice-implemented    (validation 通过)
  -> slice-reviewed       (slice review approved)
  -> slice-completed      (drift 分类完成、locks 转 completed-owner)

  分支：
  slice-ready    -> slice-blocked   (dispatch 时 ownedFiles 被抢占或 dependsOn 未完成)
  slice-reviewed -> slice-rejected  (drift 为 cross-cutting/breaking，run 进 contract-conflict)
  任意状态       -> slice-abandoned (run 进入 abandoned 或人工弃用)
```

状态规则：

- `global-contract-ready`：全局契约已生成，但尚未 freeze。
- `global-contract-frozen`：全局契约已冻结，可以规划 slice。
- `planning-slices`：slice planner 正在产出新一批 slice；可重入。
- `executing-slices`：至少一个 slice 处于 frozen/implementing/reviewing 阶段。
- `contract-conflict`：drift detector 判定为 cross-cutting 或 breaking，必须人工 `resume --resolve` 才能回到 `executing-slices`，或者 `abandon` 整个 run。
- `integration-ready`：所有 required slice 处于 `slice-completed` 且无 pending slice，等待最终 integration review。
- `slice-pending`：slice planner 已产出但未通过 canStart 静态校验。
- `slice-ready`：canStart 静态条件已通过，但尚未 freeze。
- `slice-frozen`：slice 已冻结，contractHash 已写入，允许 Codex 执行。
- `slice-blocked`：dispatch 时可启动条件回退（ownedFiles 被抢占、依赖未完成），等待解除阻塞。
- `slice-rejected`：本 slice 触发 cross-cutting/breaking drift，run 进入 contract-conflict 等待人工裁决。

**contract-conflict 恢复路径**：人工只能通过 `resume --run <id> --resolve <action>` 恢复，其中 `<action>` ∈：

- `accept-revision --revision <id>`：接受 revision，旧 slice 标记为 superseded 并生成 reconciliation slice。
- `reject-revision --revision <id>`：拒绝 revision，回退到上一份 frozen contract，清空候选 revision。
- `abandon`：整个 run 进入 abandoned。

不允许人工直接编辑 frozen contract 文件；直接编辑视为 abandon。

### Artifact 契约

Pipeline 模式在 `.agent-runs/<runId>/` 下新增：

```text
global-contract.json
global-contract.history.jsonl
queue.json
locks.json
contract-revisions.jsonl
drift-report.json
integration-review.json
slices/<sliceId>/slice.json
slices/<sliceId>/slice.raw.json
slices/<sliceId>/handoff.json
slices/<sliceId>/review.json
slices/<sliceId>/diff.patch
slices/<sliceId>/validation.json
slices/<sliceId>/prompts/implement.md
slices/<sliceId>/prompts/review.md
```

### Global Contract

新增 `schemas/agent-loop/global-contract.schema.json`。

核心字段：

```json
{
  "version": "global-v1",
  "goal": "",
  "nonGoals": [],
  "globalAcceptance": [],
  "architectureConstraints": [],
  "runtimeTargets": ["claude-code", "codex"],
  "riskLevel": "L2",
  "blockingQuestions": [],
  "integrationValidationCommands": [],
  "contractHash": "sha256:..."
}
```

`contractHash` 计算范围（**canonical 字段集合**，其他字段不进入哈希）：

- `goal`
- `nonGoals`（排序后序列化）
- `globalAcceptance`（排序后序列化）
- `architectureConstraints`（排序后序列化）
- `runtimeTargets`（排序后序列化）

排除字段：`blockingQuestions`、`riskLevel`、`integrationValidationCommands`、`version`、history 元数据。
排除 `blockingQuestions` 是因为问答交互会反复修改它，纳入会让已冻结 slice 全部失效；
排除 `integrationValidationCommands` 是因为它属于运行时配置，不属于契约本身。

执行规则：

- `blockingQuestions` 非空时不得进入 slice planning。
- global contract freeze 后**契约字段**（hash 范围内）不可变；非契约字段（如 `integrationValidationCommands`、`blockingQuestions` 的清空）允许后续追加，但必须写入 `global-contract.history.jsonl`。
- 任何契约字段变更必须先生成 `contract-revisions.jsonl` 条目并通过 drift detector，**禁止直接修改 frozen 文件**。

**两份 history 文件分工**：

- `global-contract.history.jsonl`：global contract **文件**写入历史快照（initial freeze、append integrationValidationCommands、resume 后字段变化等运行时事件）。append-only，每行一份完整 contract 快照 + 时间戳 + cause。
- `contract-revisions.jsonl`：契约**字段层面**的 revision 申请记录（来自 slice review 或 slice planner，含 drift detector 分类、人工裁决结果）。append-only，每行一个 revision 事件，含 `revisionId`、`source`、`classification`、`resolution`。

source of truth：契约字段查询永远读 `global-contract.json`（最新 frozen 版本）；revision 历史查询读 `contract-revisions.jsonl`；运行时文件审计读 `global-contract.history.jsonl`。

### Slice Contract

新增 `schemas/agent-loop/pipeline-slice.schema.json`。

核心字段：

```json
{
  "id": "slice-001",
  "title": "",
  "dependsOn": [],
  "ownedFiles": [],
  "readFiles": [],
  "risk": "L1",
  "acceptanceCriteria": [],
  "doneCriteria": [],
  "validationCommands": [],
  "questions": [],
  "contractHash": "sha256:...",
  "canStart": false
}
```

`canStart` 必须由 orchestrator 校验后写入，不完全信任 provider 输出。

可启动条件（**两阶段强制**：freeze 时校验静态条件，dispatch 时再次校验运行时条件）：

| 条件 | freeze 校验 | dispatch 校验 | 失败处理 |
|------|------------|---------------|---------|
| `questions` 为空 | ✅ | — | 回到 `slice-pending` |
| `risk` ≤ L3 | ✅ | — | 见下方 L4 处理 |
| 不涉及 destructive / auth / secret / migration | ✅ | — | 见下方 L4 处理 |
| `contractHash` 与冻结 global contract 匹配 | ✅ | ✅ | mismatch → 进入 `slice-rejected` + `contract-conflict` |
| `dependsOn` 全部 `slice-completed` | — | ✅ | 进入 `slice-blocked` |
| `ownedFiles` 未被 `slice-implementing` slice claim | — | ✅ | 进入 `slice-blocked` |

**L4 / 安全敏感 slice 处理**：slice normalizer 阶段直接拒绝并回写 `questions[]` 要求 planner 拆细，
不允许 L4 slice 进入 `slice-ready`。这避免 L4 slice 永远 `slice-blocked` 导致 run 卡死。

**`risk` 与 global contract `riskLevel` 的关系**：global contract `riskLevel` 是 run 整体风险评估，
影响 `--auto` 能否自动 freeze global contract；slice `risk` 是单 slice 风险，影响该 slice 能否进入
`canStart`。两者独立维护，例如 run 整体 L3 但仍可包含 L1 slice。

### Queue 和 Lock

新增 `schemas/agent-loop/pipeline-queue.schema.json`。

```json
{
  "pending": [],
  "ready": [],
  "running": [],
  "completed": [],
  "blocked": []
}
```

新增 `schemas/agent-loop/pipeline-locks.schema.json`。

```json
{
  "files": {
    "scripts/agent-orchestrator.js": {
      "sliceId": "slice-001",
      "status": "claimed"
    }
  }
}
```

锁状态语义（三态，**禁止"或"语义**）：

- `claimed`：slice 处于 `slice-frozen` 或 `slice-implementing` 阶段，独占写入权。其他 slice claim 失败 → `slice-blocked`。
- `completed-owner`：slice 已 `slice-completed`，文件**只读保护**。后续 slice 若 `dependsOn` 显式包含该 slice，允许将 lock 升级回 `claimed` 进行接管；否则视为推翻历史实现，slice planner 必须把该文件加入新 slice 的 `dependsOn`，绕过的 slice 会在 normalizer 阶段被拒。
- `released`：仅 abandoned slice 或 run 失败回滚时使用，从 lock 表移除。

第一版执行策略：

- 只允许单 Codex worker。
- 执行前 claim `ownedFiles`，状态 `claimed`。
- `slice-completed` 后转 `completed-owner`，**不释放**。
- `dependsOn` 升级路径必须通过 normalizer 校验，不能在 dispatch 时静默放行。
- 冲突 slice 进入 `slice-blocked`，不自动抢占；用户可通过 `resume --run <id> --unblock <sliceId>` 强制重排。

### Drift Detector

新增 `schemas/agent-loop/contract-revision.schema.json` 和 `schemas/agent-loop/drift-report.schema.json`。

**触发来源（白名单，沉默不触发）**：

1. slice review provider 在 `review.json` 中显式声明 `contractRevisions[]`。
2. slice planner 重入时，新生成 slice 与已冻结 global contract 字段的差分（自动生成候选 revision）。
3. **不接受**人工编辑的源文件作为触发来源；**不接受**从 diff 静默推断。

漂移分类：

```text
compatible      后续 slice 使用新版本，不影响已完成实现
pending-only    只影响未执行 slice，重排 pending queue
completed-local 影响已完成 slice，但可通过局部补偿修复
cross-cutting   影响共享架构、接口、状态或多个 slice
breaking        推翻全局目标、验收标准或 outOfScope
```

处理策略：

```text
compatible      -> update future slice base contract
pending-only    -> replan pending queue
completed-local -> create reconciliation slice
cross-cutting   -> enter contract-conflict
breaking        -> enter contract-conflict
```

### Reconciliation Slice

当 drift detector 判断为 `completed-local` 时，生成补偿 slice：

```json
{
  "id": "reconcile-001",
  "type": "reconciliation",
  "affectedSlices": [],
  "affectedFiles": [],
  "requiredChanges": [],
  "validationCommands": [],
  "depth": 1
}
```

规则：

- Codex 只实现补偿 slice，不重做整个 run。
- 补偿 slice 必须走 freeze、implementation、validation、slice review。
- 补偿 slice 通过后才能继续 integration review。

**递归终止（避免无限补偿循环）**：

- 补偿 slice 自身的 slice review **不允许产出 contractRevision**。Provider 若仍输出 revision，drift detector 强制升级为 `cross-cutting` 进入 `contract-conflict`。
- `depth` 字段记录补偿层级。一个 run 内 reconciliation slice `depth` 最多为 1；任何 `depth >= 2` 的请求直接进 `contract-conflict`。
- reconciliation slice 之间禁止互相依赖：normalizer 会拒绝 `dependsOn` 中包含其他 `reconcile-*` id 的 slice。
- reconciliation slice **永不自动 freeze**，无视 `--auto`（详见下方 Safe 集合）。

### Review 分层

Pipeline 模式新增两类 review：

- Slice review：Claude Code 只检查当前 slice 是否满足冻结 slice contract。运行的 validation 命令仅为 slice 自身的 `validationCommands`。
- Integration review：Claude Code 汇总检查 global contract、全部 slice、全部 handoff、全部 diff、全部 validation、全部 contract revision。

**Integration 阶段全量 validation 命令来源**（按顺序合并去重）：

1. `global-contract.json` 的 `integrationValidationCommands`（用户/作者显式声明）。
2. 所有已完成 slice 的 `validationCommands` 并集（自动聚合）。
3. orchestrator 内置兜底：`git diff --check`、schema validation、自检命令。

只有 integration review approved，run 才能进入 `completed`。

### CLI 设计

保留顶层命令，使用 `--pipeline` 分流：

```bash
node scripts/agent-orchestrator.js run --requirement "..." --pipeline
node scripts/agent-orchestrator.js run --requirement "..." --pipeline --auto

# pipeline 模式下 freeze 必须显式指定 target
node scripts/agent-orchestrator.js freeze --run <runId> --target global-contract
node scripts/agent-orchestrator.js freeze --run <runId> --target slice --slice-id <sliceId>

# resume 支持 contract-conflict 恢复与 blocked slice 重排
node scripts/agent-orchestrator.js resume --run <runId>
node scripts/agent-orchestrator.js resume --run <runId> --resolve accept-revision --revision <revisionId>
node scripts/agent-orchestrator.js resume --run <runId> --resolve reject-revision --revision <revisionId>
node scripts/agent-orchestrator.js resume --run <runId> --unblock <sliceId>
node scripts/agent-orchestrator.js abandon --run <runId>

node scripts/agent-orchestrator.js status --run <runId>
```

规则：

- `--pipeline` 只在 `run` 创建时决定 mode。
- `state.mode = "classic"` 走现有路径，`freeze --run` 不需要 `--target`，向后兼容。
- `state.mode = "pipeline"` 走新路径，`freeze` 必须带 `--target`，缺失直接报错而非默认到任意 target。
- `--auto` 只控制安全 gate 是否自动通过，不会自动启用 pipeline。
- `--pipeline --auto` 可以自动 freeze "safe" 对象（正向定义见下方"Safe 集合"）。

### 强制人工 Gate

以下情况无视 `--auto`：

- global acceptance 改变。
- API / 数据结构 / 存储路径改变。
- 多个 completed slice 受影响（≥ 2 个）。
- auth / secret / migration / destructive。
- 新文档推翻 `outOfScope`。
- validation 连续失败 **≥ 2 次**（同一 slice 两次 validation 失败即触发，不允许 `--auto` 第三次重试）。
- contract hash mismatch。
- provider 输出无法 parse 或 normalizer 无法生成 canonical contract。
- drift 分类为 `cross-cutting` 或 `breaking`。
- reconciliation slice（无论分类，永远人工）。

### Safe 集合（`--pipeline --auto` 可自动通过的正向定义）

只有同时满足以下所有条件，才允许 `--auto` 自动 freeze。**Safe 集合与"强制人工 Gate"是反向二分**，
两者之外的对象进入"灰区"，默认走人工 gate 并记录到 `state.json` 的 `auto-skipped[]`。

**Global contract safe**：

- `riskLevel` ≤ L2。
- `blockingQuestions` 为空。
- 不命中"强制人工 Gate"任一项。
- normalizer 输出与 provider 原始输出语义等价（无字段被丢弃）。

**Slice safe**：

- `risk` ≤ L2。
- `ownedFiles.length` ≤ 5。
- `dependsOn` 全部 `slice-completed`。
- `questions` 为空。
- `contractHash` 与当前 frozen global contract 匹配。
- 不涉及 destructive / auth / secret / migration / API / 数据结构 / 存储路径。
- 不命中"强制人工 Gate"任一项。

**Reconciliation slice safe**：永不自动 freeze。所有 reconciliation slice 必须人工确认，因为它涉及修复已完成实现，影响面比常规 slice 高一档。

---

## 任务拆解

> 实现层为避免 `scripts/agent-orchestrator.js` 单文件超过 800 行，拆出 `scripts/agent-orchestrator/` 子模块目录。
> 顶层 `agent-orchestrator.js` 仅负责 CLI 入口与 mode 分流，pipeline 状态机、locks、drift detector 等独立成模块。

- [ ] **Task 1**: 写 pipeline 架构文档 — 文件: `docs/architecture/agent-loop-pipeline-architecture.md`
- [ ] **Task 2**: 新增 pipeline schema — 文件: `schemas/agent-loop/*.schema.json`
- [ ] **Task 3**: 增加 `state.mode` 与 `--pipeline` CLI 分流（含 `freeze --target`、`resume --resolve`、`abandon`） — 文件: `scripts/agent-orchestrator.js`
- [ ] **Task 4**: 实现 global contract provider、canonical hash、双 history 写入 — 文件: `scripts/agent-orchestrator/global-contract.js`
- [ ] **Task 5**: 实现 slice planner、slice normalizer（含 L4 拒绝路径） — 文件: `scripts/agent-orchestrator/slice-planner.js`, `scripts/agent-orchestrator/slice-normalizer.js`
- [ ] **Task 6**: 实现 queue + locks（claimed / completed-owner / released 三态） + 单 worker 调度 — 文件: `scripts/agent-orchestrator/queue.js`, `scripts/agent-orchestrator/locks.js`
- [ ] **Task 7**: 实现 slice implementation prompt 和 Codex handoff 写入 — 文件: `scripts/agent-orchestrator/slice-runner.js`
- [ ] **Task 8**: 实现 slice review 和 integration review（含 `integrationValidationCommands` 聚合） — 文件: `scripts/agent-orchestrator/review.js`
- [ ] **Task 9**: 实现 contract revision 与 drift detector（白名单触发源、五级分类） — 文件: `scripts/agent-orchestrator/drift-detector.js`
- [ ] **Task 10**: 实现 reconciliation slice 生成、`depth` 限制、递归终止与 `resume --resolve` 恢复路径 — 文件: `scripts/agent-orchestrator/reconciliation.js`
- [ ] **Task 11**: 补充 self-test / dry-run / schema validation（含双层状态机回归） — 文件: `scripts/agent-orchestrator.js`, `schemas/agent-loop/*`
- [ ] **Task 12**: 更新 Claude source command 与 Codex projection 文档 — 文件: `user-level/commands/agent-loop.md`, `.codex/skills/agent-loop/SKILL.md`, `plugins/tech-persistence/skills/agent-loop/SKILL.md`
- [ ] **Task 13**: 更新 README、plugin README，并重新生成/验证 Codex plugin — 文件: `README.md`, `plugins/tech-persistence/README.md`, `plugins/tech-persistence/**`

---

## 测试策略

### 风险等级

- 风险等级：L3。
- 原因：修改 orchestrator 状态机、provider prompt、artifact 契约和 Claude/Codex 双运行时文档。默认模式兼容性是最高优先级。

### 最低验证

```bash
node scripts/agent-orchestrator.js self-test
node scripts/agent-orchestrator.js run --requirement "pipeline smoke" --preflight-only
node scripts/agent-orchestrator.js run --requirement "pipeline smoke" --pipeline --dry-run
node scripts/validate-codex-plugin.js
git diff --check
```

### 新增 self-test 覆盖

- classic mode 不传 `--pipeline` 时状态机保持现状。
- pipeline mode 创建 `mode: "pipeline"`，run/slice 双层状态机分别可达。
- slice 未 freeze 时拒绝 Codex implementation。
- `ownedFiles` 冲突会阻塞 slice 进入 `slice-blocked`。
- 后续 slice 在 `dependsOn` 不包含 `completed-owner` 时不能 claim 同一文件。
- `contractHash` mismatch 会让 slice 进入 `slice-rejected` 且 run 进 `contract-conflict`。
- `completed-local` drift 会生成 reconciliation slice。
- `breaking` / `cross-cutting` drift 会进入 `contract-conflict`。
- reconciliation slice review 输出 contractRevision 时强制升级为 `cross-cutting`。
- reconciliation slice `depth >= 2` 直接进 `contract-conflict`。
- L4 / 安全敏感 slice 在 normalizer 阶段被拒绝并要求 planner 拆细，不进 `slice-ready`。
- `freeze` 在 pipeline mode 下未带 `--target` 时立即报错。
- `--pipeline --auto` 不会自动 freeze reconciliation slice。
- 灰区对象（既非强制 gate 也非 safe）默认走人工 gate 并写入 `auto-skipped[]`。
- `resume --resolve accept-revision` 与 `reject-revision` 分别回到 `executing-slices`。
- `contractHash` canonical 范围只包含 goal/nonGoals/globalAcceptance/architectureConstraints/runtimeTargets，修改 `blockingQuestions` 不会改变 hash。
- integration review 未通过时不能进入 `completed`。

### 验证边界

- Provider-backed 完整运行需要真实 `claude` / `codex` CLI 环境，不作为第一轮自动测试强依赖。
- `self-test` 必须不调用外部 provider。
- `dry-run` / `preflight-only` 必须可在无 provider 调用的情况下验证 artifact 和本地契约。

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 默认模式被 pipeline 改动影响 | 中 | 高 | `state.mode` 明确分流；新增 classic regression self-test |
| 后续文档和已执行 slice 冲突 | 高 | 高 | contract revision + drift detector + reconciliation slice |
| slice 粒度过细导致管理成本高 | 中 | 中 | 第一版单 worker；slice planner 控制最小粒度 |
| provider 输出结构漂移 | 中 | 中 | 继续使用 codec + normalizer + strict schema |
| 文件锁误判阻塞正常执行 | 中 | 中 | lock 只基于 `ownedFiles`；允许人工 resolve blocked slice |
| validation 过慢 | 中 | 中 | slice validation 可局部执行；integration review 前再跑全量命令 |
| Claude/Codex 文档不一致 | 中 | 高 | 从 Claude source command 生成 Codex projection，并跑 plugin validation |

---

## 涉及文件

### 新增

- `docs/architecture/agent-loop-pipeline-architecture.md`
- `schemas/agent-loop/global-contract.schema.json`
- `schemas/agent-loop/pipeline-slice.schema.json`
- `schemas/agent-loop/contract-revision.schema.json`
- `schemas/agent-loop/pipeline-queue.schema.json`
- `schemas/agent-loop/pipeline-locks.schema.json`
- `schemas/agent-loop/drift-report.schema.json`

### 修改

- `scripts/agent-orchestrator.js`
- `user-level/commands/agent-loop.md`
- `.codex/skills/agent-loop/SKILL.md`
- `plugins/tech-persistence/skills/agent-loop/SKILL.md`
- `plugins/tech-persistence/scripts/build-codex-plugin.js`
- `plugins/tech-persistence/README.md`
- `README.md`

### 可能由构建生成

- `plugins/tech-persistence/commands/agent-loop.md`
- `plugins/tech-persistence/skills/agent-loop/SKILL.md`
- 用户级 / cache plugin 副本，仅在明确要求同步安装输出时处理。

---

## 确认清单

- [ ] 确认 `--pipeline` 是唯一启用入口，默认模式完全不变。
- [ ] 确认第一版只做单 Codex worker。
- [ ] 确认后生成文档不能静默覆盖冻结文档。
- [ ] 确认 drift detector 五级分类。
- [ ] 确认 `completed-local` 默认生成 reconciliation slice。
- [ ] 确认 `cross-cutting` / `breaking` 必须人工 gate。
- [ ] 确认 `--auto` 不等于 `--pipeline`。
- [ ] 确认 `--pipeline --auto` 只能自动通过 safe gate。
- [ ] 确认 integration review 通过才算 completed。
- [ ] 确认后续实现要同步 Claude source 与 Codex projection。

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-09 | planning | 生成 `--pipeline` opt-in 流水线执行计划，尚未改实现代码。 |
| 2026-05-11 | planning-revision | 修复 14 处逻辑漏洞：run/slice 双层状态机、drift 触发白名单、lock 三态语义、`contractHash` canonical 范围、reconciliation `depth` 递归终止、`--auto` safe 集合正向定义、`freeze --target` 必填、L4 slice normalizer 拒绝、双 history 文件分工、`integrationValidationCommands` 字段、强制 gate 阈值量化、任务子模块拆分、self-test 覆盖补全、`contract-conflict` 恢复路径明确。 |
| 2026-05-11 | implementation | 落地 Task 1-13：6 个 pipeline schemas、`scripts/agent-orchestrator/` 11 个子模块（pipeline/state/queue/locks/global-contract/slice-planner/slice-normalizer/slice-runner/review/drift-detector/reconciliation）、CLI 分流 + state.mode + freeze/resume/abandon + --target/--resolve/--unblock、扩展 50+ 条 self-test 覆盖、`run --pipeline --dry-run` 端到端写出完整 artifact 拓扑、`docs/architecture/agent-loop-pipeline-architecture.md`、Claude source command + 4 副本 propagation、Codex plugin 构建脚本同步 `agent-orchestrator/` 子目录 + 修补 `.claude\/agents` 替换正则、README pipeline 段、`/agent-loop` 命令速查表补 `--pipeline`。回归：self-test、classic dry-run、pipeline dry-run、plugin self-test、plugin validation 全部通过。 |
| 2026-05-11 | provider-integration | 新增 `pipeline-providers.js`（globalContract/slicePlanner/sliceImpl/sliceReview/integrationReview 五个 provider 入口），buildPipelineCtx 注入完整 v6 helper（runProcess/providerLaunch/parsers/codexSandboxMode/claudeProviderEnv/writeGitDiff），`advancePipeline` 实现状态机驱动的多阶段循环（含 `--auto` safe 集合判定、L4 阻塞、lock claim、drift 升级到 contract-conflict），新增 4 条 mock-ctx 端到端 self-test（global contract / slice planner / approved review / breaking revision → contract-conflict）。回归矩阵：self-test、classic dry-run、pipeline dry-run、plugin self-test、plugin validation 全部通过。剩余：真实 `claude` / `codex` CLI 环境下的 e2e 冒烟需在有 CLI 的环境单独执行。 |
| 2026-05-11 | provider-error-ux | 首次在真实 CLI 下跑 `--pipeline --auto` 暴露：`claude -p --output-format json` 失败（401/429/quota）时错误内容只在 stdout（envelope `{is_error,api_error_status,result}`），stderr 空，原 `runProcess` 报错只指向 stderr 把用户引到空文件。修复：`runProcess` status≠0 时新增 `extractProviderEnvelopeError(stdout)` 提取人类可读的 `result` / `api_error_status` 拼进 Error message，并同时给出 stdout 路径；新增 `doctor --probe` 子命令真打一次 claude/codex 提前暴露认证状态；4 条 self-test 覆盖 envelope 提取。同步两份副本（root + plugins）并在 `debugging-gotchas.md` HIGH 段记录踩坑。 |

---

## 审查结果

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| - | - | - | 待实现后审查 | open |

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| - | - | - | 待实现后审查 | open |

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | architecture | pipeline v2 | 多 worker + per-slice worktree + merge queue 可作为第二阶段能力 | deferred |

### 总评

该计划保持默认模式稳定，把 pipeline 作为显式 opt-in 能力。核心兜底是版本化冻结契约、drift detector 和 reconciliation slice，避免“后生成文档覆盖前执行结果”的隐性风险。

---

## 复利记录

### 提取的经验
- 大任务并行不应该突破冻结契约，而应该缩小冻结粒度。
- 后续文档变化必须变成 contract revision，不能覆盖历史执行依据。

### 创建/更新的本能
- 待实现完成后由 `/compound` 或 hook 评估。

### 解决方案文档
- 待实现完成后沉淀到 `docs/solutions/`。
