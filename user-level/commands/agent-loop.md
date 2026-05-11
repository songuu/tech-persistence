---
description: "v6 外部编排器：claude 产出冻结 spec，codex 按 spec 执行，claude 复审；可选 --pipeline 启用分片流水线"
---

# /agent-loop — v6 外部 Agent 编排（可选 pipeline 流水线）

v6 的主路径不是让两个 Agent 在各自命令里理解彼此，而是由外部 orchestrator 调用 provider：

1. `claude -p` 只负责需求分析、技术设计、任务拆解。
2. 人类 review 后 freeze spec。
3. `codex exec` 只按冻结 spec 实现，并产出 diff、validation、handoff。
4. `claude -p` 只按冻结 spec 做验收复审。
5. 若复审不通过，orchestrator 把 review notes 转成 follow-up task，再交给 `codex exec`。

## 用法

```bash
/agent-loop <原始需求>
/agent-loop --auto <原始需求>
/agent-loop --pipeline <原始需求>
/agent-loop --pipeline --auto <原始需求>
/agent-loop freeze <runId>
/agent-loop freeze <runId> --target global-contract
/agent-loop freeze <runId> --target slice --slice-id <sliceId>
/agent-loop resume <runId>
/agent-loop resume --auto <runId>
/agent-loop resume <runId> --resolve accept-revision --revision <revisionId>
/agent-loop resume <runId> --resolve reject-revision --revision <revisionId>
/agent-loop resume <runId> --unblock <sliceId>
/agent-loop abandon <runId>
/agent-loop status [runId|latest]
/agent-loop doctor
/agent-loop self-test
```

Codex 中使用同名 skill：

```bash
$agent-loop <原始需求>
$agent-loop --auto <原始需求>
$agent-loop --pipeline <原始需求>
$agent-loop --pipeline --auto <原始需求>
$agent-loop freeze <runId>
$agent-loop freeze <runId> --target global-contract
$agent-loop freeze <runId> --target slice --slice-id <sliceId>
$agent-loop resume <runId>
$agent-loop resume <runId> --resolve accept-revision --revision <revisionId>
$agent-loop resume <runId> --unblock <sliceId>
$agent-loop abandon <runId>
$agent-loop status [runId|latest]
$agent-loop doctor
$agent-loop self-test
```

## 可选参数

- `--auto`：自动审查模式。orchestrator 在 spec 通过自校验（required 字段齐全、`questions: []` 为空、`assumptions` 不阻塞、acceptance 与 scope 不冲突）时自动 `freeze` 并继续 implementation + review；否则保留人工 freeze gate。review 通过即 `completed`；review 不通过仍按 follow-up 流程，不会绕过 P0。详见 `~/.claude/rules/auto-mode.md`。
- `--pipeline`：启用 pipeline 流水线模式。默认串行模式（`state.mode = "classic"`）行为完全不变；只有显式传 `--pipeline` 才进入新状态机。pipeline 模式先由 Claude Code 生成全局契约，冻结后再分批生成可执行 slice，每个 slice 独立冻结、独立 Codex 实现、独立 review，最后由 Claude Code 做 integration review。详见下方"Pipeline 模式"章节。`--pipeline --auto` 仅自动 freeze "safe" 对象，reconciliation slice 永不自动 freeze。
- `--target`、`--slice-id`、`--resolve`、`--revision`、`--unblock`：pipeline 模式 freeze/resume 的细粒度控制。详见下方章节。

## 一致性保障

- Claude Code 的 `/agent-loop` 与 Codex 的 `$agent-loop` 必须调用同一个 orchestrator。
- orchestrator 会自动解析 Windows npm shim，例如 `claude.cmd` 和 `codex.cmd`，不要求用户手动传真实 `.exe`。
- spec、implementation、review prompt 都通过 stdin 或 artifact 文件传输，避免 Windows argv 过长。
- provider 原始输出必须先归一化为 canonical spec / handoff / review，再驱动状态机。
- 如果 provider 或 schema 预检失败，先运行 `doctor`，不要手工绕过状态机。
- 修改 orchestrator 后运行 `self-test`，它不调用外部 provider，只验证 codec / normalizer / schema 基础契约。

## 执行规则

### Doctor

当参数为 `doctor` 时运行：

```bash
node scripts/agent-orchestrator.js doctor
```

### Self-Test

当参数为 `self-test` 时运行：

```bash
node scripts/agent-orchestrator.js self-test
```

### 新需求

当参数不是 `freeze`、`resume`、`status`、`doctor`、`self-test`、`abandon` 时：

1. 优先使用当前项目的 `scripts/agent-orchestrator.js`。
2. 如果当前项目没有该脚本，查找 `~/plugins/tech-persistence/scripts/agent-orchestrator.js`。
3. 若用户传了 `--pipeline`，进入 pipeline 流水线模式（详见下方章节）；否则走默认串行 v6 流程。
4. 运行：

```bash
node scripts/agent-orchestrator.js run --requirement "$ARGUMENTS"
```

不要默认传 `--auto-freeze`。spec 必须先给用户 review。

若用户传了 `--auto`，模型先把 `<原始需求>` 中的 `--auto` 移除，然后追加 `--auto-evaluate`：

```bash
node scripts/agent-orchestrator.js run --requirement "<去掉 --auto 的需求>" --auto-evaluate
```

`--auto-evaluate` 让 orchestrator 在 spec 通过自校验时自动 freeze + resume；不通过则停在 `spec-ready` 等待人工 freeze。模型在追加该 flag 前必须确认本会话当前不属于 destructive / 高风险场景。

若用户传了 `--pipeline`，模型把 `<原始需求>` 中的 `--pipeline` 移除，然后追加 `--pipeline`（再追加 `--auto` 时同样移除并追加）：

```bash
node scripts/agent-orchestrator.js run --requirement "<去掉 --pipeline/--auto 的需求>" --pipeline
node scripts/agent-orchestrator.js run --requirement "<去掉 --pipeline/--auto 的需求>" --pipeline --auto
```

如果只想检查本机环境而不调用 provider，运行：

```bash
node scripts/agent-orchestrator.js doctor
```

### Freeze

当参数形如 `freeze <runId>` 时运行：

```bash
node scripts/agent-orchestrator.js freeze --run <runId>
```

只在用户明确认可 spec 后执行。

如果该 run 的 `state.mode === "pipeline"`，freeze 必须带 `--target`：

```bash
# 冻结 global contract（首次 freeze）
node scripts/agent-orchestrator.js freeze --run <runId> --target global-contract

# 冻结某个 slice（每个 slice 单独 freeze）
node scripts/agent-orchestrator.js freeze --run <runId> --target slice --slice-id <sliceId>
```

orchestrator 在 pipeline mode 缺失 `--target` 时立即报错，不会默认到任意 target。

### Resume

当参数形如 `resume <runId>` 时运行：

```bash
node scripts/agent-orchestrator.js resume --run <runId>
```

如果用户给了验证命令，追加：

```bash
--validation-command "<command>"
```

验证命令可以重复传入多次。validation 由 orchestrator 执行并写入 `validation.json`，provider handoff 里的 validation 只作为说明。

可选拆分人工 gate 的开关：

- `--no-review`（同义 `--implementation-only`）：只跑实现，停在 `implemented`，让用户手动检查后再次 `resume`。
- `--review-only`：跳过实现 provider，只对当前 handoff 跑复审。常用于已有 `implemented` 状态、想重跑复审的场景。

恢复时若状态为 `completed`/`failed`/`dry-run`，orchestrator 会打印状态并直接返回；不要重复触发 provider。

Pipeline 模式下 resume 支持额外动作：

- `--resolve accept-revision --revision <revisionId>`：在 `contract-conflict` 状态接受 contract revision，旧 slice 标记 superseded 并生成 reconciliation slice。
- `--resolve reject-revision --revision <revisionId>`：拒绝 revision，回退到上一份 frozen contract。
- `--resolve abandon`：把整个 run 直接 abandon。
- `--unblock <sliceId>`：把某个 `slice-blocked` 状态的 slice 重排回 `slice-ready`。

### Abandon

当参数形如 `abandon <runId>` 时运行：

```bash
node scripts/agent-orchestrator.js abandon --run <runId>
```

仅支持 pipeline 模式 run，classic 模式不支持 abandon（直接放置即可）。

### Status

当参数形如 `status` 或 `status <runId>` 时运行：

```bash
node scripts/agent-orchestrator.js status --run <runId|latest>
```

## 文件契约

每次运行写入 `.agent-runs/<runId>/`：

- `state.json`: orchestrator 状态机（`status`、`specFrozenAt`、`providerRuns[]`、`files`）。
- `requirement.md`: 用户原始需求。
- `commands.json`: 本次 run 解析出的 provider 启动命令快照。
- `spec.json`: 冻结前的结构化需求契约（normalized）。
- `spec.raw.json`: spec provider 原始未归一化输出，用于排查归一化差异。
- `requirement-spec.md`: 给人 review 的 spec。
- `technical-design.md`: 技术设计。
- `task-breakdown.json`: 实现任务。
- `changed-files.json`: 过滤 managed artifacts 后的变更清单。
- `diff.patch`: codex 实现后的 diff（含 untracked synthetic diff）。
- `review-context.md`: review provider 使用的截断安全上下文。
- `validation.json`: 验证结果（`status`/`commands[]`，包含每条命令 stdoutFile/stderrFile）。
- `handoff.md`: 实现交接（人类可读）。
- `handoff.json`: canonical 实现交接（normalized）。
- `handoff.parse-error.json`: handoff JSON 解析失败时记录原始 stdout/last-message 文件位置。
- `review.json`: 验收复审（normalized）。
- `review.raw.json`: provider 原始 review 输出。
- `review.parse-error.json`: review JSON 解析失败时记录原始 stdout/stderr 文件位置。
- `preflight.json`: 本机 provider/schema/workdir 预检。
- `follow-up-task.md`: 复审不通过时生成（含 findings 行式格式：`[severity] file:Lline: message — fix: ...`）。
- `prompts/{spec,implement,review}.md`: 发给各 provider 的最终 prompt 文本。
- `logs/{spec,implementation,review,validation-N}.<timestamp>.{stdout,stderr}.log`: 带时间戳的 provider 与 validation 日志，多次 resume 不互相覆盖。

## 核心原则

- 分析 provider 不写代码。
- 实现 provider 不重新解释需求。
- freeze 前不进入实现。
- review provider 只对照冻结 spec，不新增产品范围。
- orchestrator 负责状态、日志、重试、恢复、diff 和 validation。
- `.agent-runs/`、`node_modules/`、构建产物等 managed artifacts 不参与 clean worktree 阻塞。
- review 真通过时状态必须是 `completed`；`status: passed` / `canMerge: true` 等同义输出必须被归一化。

## Pipeline 模式（可选 opt-in）

> 默认串行模式不变。只有 `--pipeline` 启用以下行为，`state.mode = "pipeline"`。

### 何时考虑使用 pipeline

- 需求面大、需要多个相对独立的 slice 串行/分阶段实现。
- 接受"全局契约先 freeze、后续每个 slice 独立 freeze"的工作流。
- 接受人工 gate 仍是默认（除非显式 `--auto`，并且对象在 safe 集合内）。

### 双层状态机

Run-level：

```text
draft → global-contract-ready → global-contract-frozen → planning-slices ↔ executing-slices
       → integration-ready → completed
       分支：contract-conflict（人工 resolve）/ abandoned
```

Slice-level（每个 slice 独立）：

```text
slice-pending → slice-ready → slice-frozen → slice-implementing → slice-implemented → slice-reviewed → slice-completed
       分支：slice-blocked / slice-rejected / slice-abandoned
```

### 不可变契约

- `.agent-runs/<runId>/global-contract.json` 是全局契约。`contractHash` 只对 `goal/nonGoals/globalAcceptance/architectureConstraints/runtimeTargets` 做 canonical 排序 + sha256。`blockingQuestions`、`riskLevel` 不进 hash。
- `.agent-runs/<runId>/slices/<sliceId>/slice.json` 是 slice 契约。slice hash 绑定 global contract hash 与 slice 关键字段。
- frozen 后不允许人工编辑，所有契约字段变化必须通过 `contract-revision` 走 drift detector。

### Drift detector 白名单

只有以下两类来源能触发 contract revision：

1. slice review provider 在 `review.json` 显式声明 `contractRevisions[]`。
2. slice planner 重入时新 slice 与 frozen contract 字段的差分。

不接受人工 diff、不接受 hook 推断。drift detector 把每条 revision 分为 5 类：

- `compatible` → 更新未来 slice 基线
- `pending-only` → 重排 pending queue
- `completed-local` → 生成 reconciliation slice
- `cross-cutting` / `breaking` → 进 `contract-conflict`，必须人工 `resume --resolve`

### Reconciliation 递归终止

补偿 slice `depth` 永远为 1；自身 review 不允许产 contractRevision（产了就强制升级为 `cross-cutting`）；不能依赖其它 reconciliation slice。`--auto` 不会自动 freeze reconciliation slice。

### `--pipeline --auto` 的 safe 集合（正向定义）

只有同时满足以下条件才会自动 freeze：

**Global contract safe**：`riskLevel ≤ L2`、`blockingQuestions` 为空、normalizer 与 provider 输出语义等价、不命中强制人工 Gate。

**Slice safe**：`risk ≤ L2`、`ownedFiles.length ≤ 5`、`dependsOn` 全部 completed、`questions` 为空、`sensitiveAreas` 为空（不涉及 auth / secret / migration / destructive / api / data-schema / storage-path）、不命中强制人工 Gate。

**强制人工 Gate**（无视 `--auto`）：global acceptance 改变、API/数据结构/存储路径改变、≥2 个 completed slice 受影响、auth/secret/migration/destructive、推翻 outOfScope、validation 连续失败 ≥ 2 次、contract hash mismatch、provider 输出无法 parse、drift 为 cross-cutting/breaking、reconciliation slice（永远人工）。

灰区（既非强制 gate 也非 safe）：默认走人工 gate，记录到 `state.pipeline.autoSkipped[]`。

### Pipeline 模式新增 artifact

`.agent-runs/<runId>/` 下：

- `global-contract.json` / `global-contract.history.jsonl` / `contract-revisions.jsonl`
- `queue.json`（pending/ready/running/completed/blocked）
- `locks.json`（claimed / completed-owner / released）
- `drift-report.json`、`integration-review.json`
- `slices/<sliceId>/slice.json`、`slice.raw.json`、`handoff.json`、`review.json`、`diff.patch`、`validation.json`、`prompts/{implement,review}.md`
- `prompts/global-contract.md`

### 自检与 dry-run

```bash
# 不调用 provider，只验证 codec / normalizer / schema / 状态机
node scripts/agent-orchestrator.js self-test

# 创建 pipeline run 的完整 artifact 拓扑（不调用任何 provider）
node scripts/agent-orchestrator.js run --requirement "<需求>" --pipeline --dry-run
```

详细架构、模块边界、状态机表请见 `docs/architecture/agent-loop-pipeline-architecture.md`。
