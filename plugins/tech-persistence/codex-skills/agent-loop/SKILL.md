---
name: agent-loop
description: Codex-compatible entry point for the former /agent-loop command. v7 双原生控制面：Tech Persistence 单 owner 编排，Claude Code 产出/复审，Codex 实现；带 capability routing、验收 envelope 与 Goal lease
---

# Agent Loop

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/agent-loop` command.

## Invocation

Use `$agent-loop <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/agent-loop`, interpret that as this `$agent-loop` skill invocation while running in Codex.

## Command Instructions

# /agent-loop — v7 Codex × Claude Code 双原生编排

v7 保留 v6 的冻结 spec 主路径，同时把 Codex 与 Claude Code 的原生能力放进同一个可审计控制面：

`/agent-loop` 是一个**可选执行后端**，不是 `/sprint` 的前置条件；任一 adapter 不可用都不会成为默认 `/sprint --runtime current` 的前置条件。不得因为需求中出现 Harness、Transcript 或 provider 品牌名等领域词就自动选择 `/agent-loop`；只有用户显式调用本命令，或显式选择已通过 preflight 的外部编排 backend，才进入以下双 provider 路径。

1. Tech Persistence orchestrator 是默认且唯一的 scheduler/state owner；每个阶段只有一个 writer。
2. Claude Code 只负责需求分析、技术设计、任务拆解和只读复审；默认保留 `print` adapter，`bare` 必须显式启用或由 enforce router 选择。
3. 人类 review 后 freeze spec；Codex 默认通过 `exec` adapter 按冻结 spec 实现，并产出 diff、validation、handoff。
4. provider 结果必须通过 task/route/capability hash 与幂等键验收，验收后才能推进状态机。
5. Codex App Server 仅提供显式实验性 prepare/gate，不会在默认路径自动接管编排。
6. 若复审不通过，orchestrator 把 review notes 转成 follow-up task，再交给原 writer；发生 partial effects 后禁止切换 provider。

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
/agent-loop goal-bind <runId> --runtime <codex|claude> --host-ref <opaque-ref> --objective <目标>
/agent-loop goal-release <runId> [--reason <原因>]
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
$agent-loop goal-bind <runId> --runtime <codex|claude> --host-ref <opaque-ref> --objective <目标>
$agent-loop goal-release <runId> [--reason <原因>]
$agent-loop doctor
$agent-loop self-test
```

## 可选参数

- `--auto`：自动审查模式。orchestrator 在 spec 通过自校验（required 字段齐全、`questions: []` 为空、`assumptions` 不阻塞、acceptance 与 scope 不冲突）时自动 `freeze` 并继续 implementation + review；否则保留人工 freeze gate。review 通过即 `completed`；review 不通过仍按 follow-up 流程，不会绕过 P0。`--auto-evaluate` 与 `--auto-freeze` 是兼容别名，新文档和新调用统一使用 `--auto`。是否允许追加该 flag 仍以当前项目的 auto-mode/risk 规则为准。
- `--pipeline`：启用 pipeline 流水线模式。默认串行模式（`state.mode = "classic"`）行为完全不变；只有显式传 `--pipeline` 才进入新状态机。pipeline 模式先由 Claude Code 生成全局契约，冻结后再分批生成可执行 slice，每个 slice 独立冻结、独立 Codex 实现、独立 review，最后由 Claude Code 做 integration review。详见下方"Pipeline 模式"章节。`--pipeline --auto` 仅自动 freeze "safe" 对象，reconciliation slice 永不自动 freeze。
- `--target`、`--slice-id`、`--resolve`、`--revision`、`--unblock`：pipeline 模式 freeze/resume 的细粒度控制。详见下方章节。
- `--orchestration-owner <tp|codex-host|claude-host>`：声明唯一 scheduler owner；默认 `tp`。
- `--control-root <path>`：仅供高级部署/测试覆盖权威控制存储位置；必须同时位于 runDir 与 provider workspace 之外。默认使用用户目录下的 `.tech-persistence/agent-loop-control/`，不会注入 provider 环境。
- `--capability-router <off|shadow|enforce>`：能力路由模式；默认 `shadow`，记录决策但不改变旧 provider 路径。只有 `enforce` 才允许 effective capability 参与 adapter 选择。
- `--claude-adapter <print|bare|auto>`：默认 `print`；`bare` 只在显式选择时使用，`auto` 在非 enforce 模式仍解析为 `print`。可配合 `--claude-plugin-dir`、`--claude-settings`。
- `--codex-adapter <exec|app-server|auto>`：默认 `exec`；`app-server` 还必须显式传 `--allow-experimental-app-server`，当前只准备受控接口，不执行未验收的 live JSON-RPC 编排。

## 一致性保障

- Claude Code 的 `/agent-loop` 与 Codex 的 `$agent-loop` 必须调用同一个 orchestrator。
- orchestrator 会自动解析 Windows npm shim，例如 `claude.cmd` 和 `codex.cmd`，不要求用户手动传真实 `.exe`。
- spec、implementation、review prompt 都通过 stdin 或 artifact 文件传输，避免 Windows argv 过长。
- provider 原始输出必须先归一化为 canonical spec / handoff / review，再驱动状态机。
- CLI 的 schema 参数只是 provider 侧约束；即使显式 `--skip-cli-schema`，orchestrator 仍会使用本地、无依赖 schema 校验器拒绝空对象、缺字段、额外字段和非法枚举。
- 本地 schema 校验器会解析 schema root 内的 `$defs` fragment 引用；网络 URI、文件路径、循环引用、越界 fragment 与超深引用一律 fail closed。
- Classic、pipeline slice 与 pipeline integration 共用同一个 Completion Gate。`approved` 不能单独完成 run；`compliant=false`、未解决 revision/blocker、证据不完整、required slice 未完成或 validation 未通过都会生成失败 gate receipt 并阻断终态。
- Pipeline integration validation 在 review 前由 orchestrator 以 `shell:false` 和受限命令策略真实执行；review prompt 只引用 `integration-validation.json` 及日志引用，不把“待执行命令列表”当成通过证据。
- capability 只有在 declared、observed=true、policy 三者同时允许时才生效；`unknown` 永不授权。
- task envelope、route decision、capability snapshot、result envelope 与 acceptance 必须 hash 绑定；duplicate/tamper 直接拒绝。
- fallback 永远只读；存在 partial/committed effects 时禁止把 writer 切到另一个 runtime。
- `executionPolicy` 会在创建 run 时持久化；resume 未显式覆盖时继承，显式 owner/router/adapter 冲突会在 provider 启动前拒绝。
- 每个 run 的 provider dispatch 与 Goal mutation 都使用 provider workspace 外的权威锁。每个 lexical run locator 不可变绑定 canonical identity；canonical identity 再原子声明唯一 authority，因此同一 run 的不同 junction aliases 共享 dispatch/Goal lock，而 locator retarget 会 fail-closed。把 `controlRoot/runs`、`locators`、`identities` 或 run 专属控制目录重定向进 provider workspace 同样拒绝。删除 runDir 或伪造 runDir 内文件不能绕过活跃 owner；外部控制存储不可用时不回退到本地锁。
- provider acceptance 固定使用 `provider-dispatch → goal-lease-update` 锁序，并在同一短临界区内重读 Goal revision、验证 dispatch context、写 canonical result/acceptance 与唯一 accepted record；bind/release 不反向获取 dispatch lock。
- provider 失败会落盘 effect snapshot、失败 result/acceptance 与 opaque runtime refs。同 runtime/provider/stage 且存在原生 session/thread ref 时才可 native resume；已被 provider 接受、或 partial effects 无可验证原生 ref 时进入 reconcile，禁止静默重跑。
- managed provider 只注入最小控制环境；Codex lifecycle hooks 仅在显式 `TP_AGENT_RUN_DIR` 下写 evidence，不推进状态、不写 Memory、不修改权限。
- 如果 provider 或 schema 预检失败，先运行 `doctor`，不要手工绕过状态机。
- 修改 orchestrator 后运行 `self-test`，它不调用外部 provider，只验证 codec / normalizer / schema 基础契约。
- 修改 completion/review/validation 路径后，还要运行 structured-output、review contract、completion gate、pipeline review 与 integration validation focused tests；随后重建并校验 plugin projection。

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

当参数不是 `freeze`、`resume`、`status`、`goal-bind`、`goal-release`、`doctor`、`self-test`、`abandon` 时：

1. 优先使用当前项目的 `scripts/agent-orchestrator.js`。
2. 如果当前项目没有该脚本，查找 `~/plugins/tech-persistence/scripts/agent-orchestrator.js`。
3. 若用户传了 `--pipeline`，进入 pipeline 流水线模式（详见下方章节）；否则走默认串行 v7 流程。
4. 运行：

```bash
node scripts/agent-orchestrator.js run --requirement "$ARGUMENTS"
```

不要默认传 `--auto`。spec 必须先给用户 review。

若用户传了 `--auto`，模型先把 `<原始需求>` 中的 `--auto` 移除，然后追加 canonical `--auto`：

```bash
node scripts/agent-orchestrator.js run --requirement "<去掉 --auto 的需求>" --auto
```

`--auto` 让 orchestrator 在 spec 通过自校验时自动 freeze + resume；不通过则停在 `spec-ready` 等待人工 freeze。`--auto-evaluate` 与 `--auto-freeze` 只作为历史兼容别名保留，不要在新文档或新调用里主动生成。模型在追加该 flag 前必须确认本会话当前不属于 destructive / 高风险场景。

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

### Goal lease

Goal lease 绑定当前 run 与一个原生 Codex/Claude **宿主 Goal**，不代表单个 worker stage，也不复制 provider 的 transcript、上下文或内部状态：

```bash
node scripts/agent-orchestrator.js goal-bind --run <runId> --runtime <codex|claude> --host-ref <opaque-ref> --objective "<目标>"
node scripts/agent-orchestrator.js goal-release --run <runId> --reason "<可选原因>"
```

同一 run 同时只允许一个 active lease。`codex-host` / `claude-host` owner 只能绑定同 runtime Goal；默认 `tp` owner 可绑定任一宿主 Goal，并仍可让 Claude spec/review 与 Codex implementation 跨 runtime 执行。权威 lease 保存在外部控制存储，使用 revision/CAS；接收结果时在 `goal-lease-update` 临界区内重读并校验 revision、run、objective 与 owner，再提交 canonical acceptance。runDir 中只有不含 `hostRef` 的非权威投影。切换 host/runtime 前必须显式 release，防止两个原生任务同时成为 writer。

## 文件契约

每次运行写入 `.agent-runs/<runId>/`：

- `state.json`: orchestrator 状态机（`status`、`specFrozenAt`、`providerRuns[]`、`files`）。
- `execution-plan.json`: v2 控制面快照（owner、adapter policy、capability snapshots、task/route hashes）。
- `goal-lease.json`: 可选 Goal lease 的非权威投影；不含 host ref、原生 runtime transcript 或内部上下文。权威 lease 与 dispatch lock 位于 provider workspace 外的 control store。
- `requirement.md`: 用户原始需求。
- `commands.json`: 本次 run 解析出的 provider 启动命令快照。
- `spec.json`: 冻结前的结构化需求契约（normalized）。
- `spec.raw.json`: spec provider 原始未归一化输出，用于排查归一化差异。
- `requirement-spec.md`: 给人 review 的 spec。
- `technical-design.md`: 技术设计。
- `task-breakdown.json`: 实现任务。
- `changed-files.json`: 过滤 managed artifacts 后的变更清单。
- `diff.patch`: codex 实现后的 diff（含 untracked synthetic diff）。所有 tracked/staged path 额外使用有界摘要绑定 HEAD、index、worktree 与 porcelain rename/copy source；lockfile、generated、超大、二进制和 symlink 可省略正文但不能省略内容/链接目标摘要。`git diff` 非零会 fail-closed，buffer overflow 会写显式 marker 并使用摘要兜底；内容或跨 managed 边界 rename 漂移会使 handoff 失效。
- `review-context.md`: review provider 使用的截断安全上下文。
- `validation.json`: 验证结果（`status`/`commands[]`，包含每条命令 stdoutFile/stderrFile）。
- `handoff.md`: 实现交接（人类可读）。
- `handoff.json`: canonical 实现交接（normalized）。
- `provider-handoff.json`: 跨 runtime 的只读交接 bundle，绑定 task/route/result/handoff hash 与 git/validation evidence。
- `handoff.parse-error.json`: handoff JSON 解析失败时记录原始 stdout/last-message 文件位置。
- `clarifications.md`: append-only 异步澄清通道（A3）。implementer 遇 spec 歧义时记录「采用的假设 + 问题」（status: open），不阻塞继续实现；spec-writer 在下一个 review gate 对每条追加 ruling（confirm-assumption / revise-spec，status: ruled）。ruling=revise-spec 时同时进 review findings/followUpTasks，走 `needs-followup` → resume re-implement 回路（classic 模式；不复用 pipeline 的 accept-revision）。
- `review.json`: 验收复审（normalized）。
- `review.raw.json`: provider 原始 review 输出。
- `review.parse-error.json`: review JSON 解析失败时记录原始 stdout/stderr 文件位置。
- `acceptance-contract.json`: freeze 时生成的 canonical 验收契约。
- `acceptance-receipts/**`: 按 contractHash + subjectHash 保存的 immutable shadow Receipt；批 1 不参与完成判定。
- `acceptance-shadow.json` / `acceptance-evidence-index.json`: latest shadow 投影与证据索引。provider assessment 和未封存的工作区 validation/log 不具备 verified authority；command validation 只有在 reviewer 前封存且 reviewer 后安全重跑才可 verified；`artifact:<workdir-relative-path>` 在 freeze 封存基线，并于 reviewer 后受限读回、封存 digest。
- `preflight.json`: 本机 provider/schema/workdir 预检。
- `contracts/<stage>.<timestamp>.{task,route,capabilities,result,acceptance}.json`: 每次 provider attempt 的不可变控制与验收记录；同一 task 的 accepted canonical result 另存为 hash 命名文件。
- `contracts/<stage>.<timestamp>.effects.json`: provider 失败时的前后 worktree snapshot、partial-effects 判定与 hash 证据；`state.json.providerRecovery` 保存 native/restart/reconcile 恢复决策和 opaque runtime refs。
- `native-lifecycle-evidence/*.json`: 仅当 orchestrator 显式注入 `TP_AGENT_RUN_DIR` 时生成的 Codex lifecycle evidence；缺失 run 绑定时 hook 安全 no-op。
- `follow-up-task.md`: 复审不通过时生成（含 findings 行式格式：`[severity] file:Lline: message — fix: ...`）。
- `prompts/{spec,implement,review}.md`: 发给各 provider 的最终 prompt 文本。
- `logs/{spec,implementation,review,validation-N}.<timestamp>.{stdout,stderr}.log`: 带时间戳的 provider 与 validation 日志，多次 resume 不互相覆盖。

## 核心原则

- 分析 provider 不写代码。
- 实现 provider 不重新解释需求。
- freeze 前不进入实现。
- review provider 只对照冻结 spec，不新增产品范围；同时兼任 spec-writer，对 implementer 提的 open clarification 逐条裁决。
- implementer 遇 spec 歧义不阻塞：记录假设 + 问题到 `handoff.clarifications[]`，orchestrator append 进 `clarifications.md`，由下一个 gate 异步裁决（刻意不引入双向 runtime 实时通道）。
- orchestrator 负责状态、日志、重试、恢复、diff 和 validation。
- shadow Acceptance 只接受 runtime-owned authority；command adapter 使用 pre-review seal、post-review command 重跑与单 subject binding。artifact adapter 只接受 `artifact:<workdir-relative-path>` + canonical expected，freeze 基线后做有界、拒绝 link/逃逸的 post-review 读回，并要求 reviewer 前后 workspace snapshot 稳定、路径命中 reviewer 前由 harness 捕获且由 accepted subject evidence 绑定的 changed-files effect scope：缺失 failed，新建或 digest 变化 passed，未变化/scope 不匹配/reviewer 漂移/不安全 unknown。其他 Oracle 尚保持 unknown。External store 只保证路径位于 provider workspace 外，不自行建立 OS ACL/独立账号；宿主未限制 provider 时不能把该路径隔离当作完整 authority。`acceptance-shadow-report.js` 只消费外部 expected-sample/Receipt ledger，且 `requires-review` 不代表 Gate 通过。
- orchestrator 是默认唯一 scheduler/state owner；host 原生 agent、hooks、MCP 和 adapter 都不能绕过它推进状态。
- 状态转换必须发生在 result acceptance 之后；相同幂等键的冲突结果必须进入 resume/reconcile，不能覆盖 accepted result。
- 跨 runtime review 只能消费只读 provider handoff；fallback 不获得写权限。
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

- `.agent-runs/<runId>/global-contract.json` 是全局契约。`contractHash` 对 `goal/nonGoals/globalAcceptance/acceptanceContract/architectureConstraints/runtimeTargets` 做 canonical 排序 + sha256。`blockingQuestions`、`riskLevel` 不进 hash。
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
