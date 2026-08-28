# Agent Harness 需求对齐与验收闭环计划

> **Status:** `planning`
> **Created:** 2026-08-27
> **Updated:** 2026-08-27

---

## 需求分析

### 背景

当前 `tech-persistence` 已具备较强的 Harness 控制面：状态机、Provider 能力快照、执行指纹、任务/路由/结果 envelope、幂等、副作用与 fallback 约束、工作区边界、生命周期证据和 Transcript outbox。主要缺口不是缺少另一个 orchestrator，而是缺少“用户需求 → 可执行验收合同 → 独立证据 → 完成判定 → 真实反馈回归”的机械闭环。

现有 `acceptanceCriteria`、`globalAcceptance`、`doneCriteria` 主要是自由文本。Hash 能证明文本未被静默替换，但不能证明文本正确表达用户真实需求，也不能证明测试、运行时结果和用户效果逐条覆盖这些标准。实验性 pipeline 还存在非 approved review 误完成、integration validation 只进入 prompt、`reviewApproved()` 忽略 `compliant`、prompt/schema 枚举不一致等确定性 false-success 路径。

### 要做

- 修复本地 structured-output validator 的 `$ref` 静默放行（现存 live 洞，非未来风险）。
- 修复现有 classic/pipeline 完成态判定中的 false-success。
- 建立 classic、pipeline slice、pipeline integration 共用的 Completion Gate，并把「所有 required slice 已 completed」从 prompt 文本改为结构化前置条件。
- 修复 classic acceptance envelope 中硬编码的 `validation.status: 'passed'`。
- 引入冻结的 `AcceptanceContract v1` 和系统生成的 `AcceptanceReceipt v1`。
- 将 criterion ID 贯穿 requirement、task、slice、validation、handoff、review、result 和 status。
- 将本地测试、artifact、runtime readback、独立 review、用户确认作为不同 Oracle 和证据等级。
- 合同修订后机械判定旧 Receipt 失效，禁止 stale evidence 完成新合同。
- 通过 legacy/shadow/enforce 分阶段迁移，保持旧 run 可读可恢复。
- 在语义验收稳定后，引入 ProviderAdapter、只读 HarnessEvent 和 TranscriptSourceAdapter。
- 外部 Runtime 只允许经过显式注册、固定 canary、权限 allowlist 和 promotion receipt 后晋级。
- 将 verified failed Receipt 和可信用户纠偏转为受治理的固定 Eval 候选，不自动学习或发布。

### 不做

- 不替换现有 scheduler、Goal lease、turn journal、state machine 或 effect/fallback 规则。
- 不引入第二套权威 Event Store 或第二个调度 owner。
- P0/P1 不接 DeepSeek Harness、Pi 或其他外部 Runtime。
- 不先做动态多 Provider 路由、多 writer 或自适应预算。
- 不把普通日志、terminal success、命令退出码或 reviewer 自报直接等价为业务验收。
- 不允许外部 Adapter 动态加载项目或插件中的任意代码。
- 不自动把用户自然语言推断为批准、纠偏或学习信号。
- 不自动 Compound、publish、commit、push、部署或写数据库。
- 不在 P0-P2 修改 Transcript 数据库 schema；确有必要时另立 P3 migration gate。

### 成功标准

- [ ] `$ref` 指向的 `$defs` 约束真被执行；`hash: 99999` 之类不合模式的值必须被拒绝而非静默通过。
- [ ] `changes_requested`、`blocked` 或 `compliant=false` 永远不能进入完成态。
- [ ] prompt 中的 decision 枚举与 schema 一致，合法 review 不再因枚举漂移被误拒。
- [ ] Integration validation 由 orchestrator 实际执行，并保存 policy、argv、退出码、日志引用和 hash。
- [ ] Integration 完成前，「所有 required slice 已 completed」由代码校验，不依赖 review prompt 文本。
- [ ] 持久化的 `validation.status` 由 completion gate 结果派生，不存在 gate 失败但 evidence 写 `passed` 的情况。
- [ ] classic、pipeline slice、pipeline integration 使用同一 Completion Gate。
- [ ] 每个 v1 run 都有不可变 `contractHash` 和 freeze receipt。
- [ ] 每条 criterion 都有且只有一个 Receipt result；缺失、额外、重复均失败关闭。
- [ ] `passed` 必须有与 Oracle 类型一致、可读回、digest 匹配的 verified evidence。
- [ ] 任意 `failed` 导出 overall `failed`；任意未覆盖或未知导出 overall `unknown`；只有全部通过才是 `passed`。
- [ ] 合同语义发生修订时 contract hash 改变，旧 Receipt 不能满足新合同。
- [ ] status/operator review 分别展示本地、artifact、runtime、用户和生产证据，不折叠为单一“完成”。
- [ ] legacy run 不被隐式改写；v1 新 run 可通过 shadow/enforce 模式逐步启用。
- [ ] Claude/Codex 经 ProviderAdapter facade 后的 argv、stdin、schemaPath、runtimeRefs、native acceptance 和 execution fingerprint 与旧路径一致。
- [ ] `user-confirmation` Oracle 在 Claude 与 Codex 两侧的可达性被明确判定；只有 Codex 可用时必须显式声明为 parity 缺口，不得当作已完成。
- [ ] 外部 Runtime 未通过 read-only canary 和显式 promotion 前没有真实写权限。
- [ ] canonical source、plugin projection、安装 cache 和 schema inventory 一致。

### 风险和假设

- 最大风险是“谁有权生成 passed”，不是 JSON Schema 本身；最终 Receipt 必须由 orchestrator 生成。
- LLM 可以帮助提出 criterion 和 assessment，但不能生成最终 hash、evidence digest、overall status 或用户批准。
- 无法确定性验证的 criterion 必须走独立 review 或用户确认；缺少 authority 时保持 `unknown`。
- 本地 structured-output validator 对 `$ref` 不是「不完整支持」而是**静默放行**（`structured-output.js:41-135` 无 `$ref` 分支，遇到 `{$ref:...}` 视为无约束 schema 通过）。已实测：`hash: 99999` 对 `{"$ref":"#/$defs/hash"}`（`^sha256:[a-f0-9]{64}$`）零报错。`agent-assignment` / `provider-handoff` / `result-envelope` 共 19 个 `$ref` 字段当前完全未被校验。若 Contract/Receipt 用 `$ref` 复用 hash 定义，hash-bound 将是装饰性的——故先修再共享 schema。
- `user-confirmation` 的可信性来源是**用户手打 canonical JSON control 前缀 + fail-closed 解析 + hash 绑定**（`codex-behavior-hook.js:247-287`），不是宿主原生 UI 捕获；论证可行性时不要写成需要 runtime 改造。
- approval authority 目前只认 `codex_cli`（`behavior-events.js:669-671`）。Claude 侧无对等 behavior hook，`claude_prompt` 仅允许 `user.prompt` + `purpose=memory`。直接落地 `user-confirmation` 会产出 Codex-only Oracle，违反 ADR-011。
- 旧 run、旧 hash 和旧投影需要长期双读，不能通过升级静默迁移。
- Windows wrapper 可能出现 `spawn EPERM`；需要把 wrapper 环境失败与实际业务断言结果分开。
- 外部 Runtime 的 session path、tree JSONL、terminal event、resume token、文件身份和 sandbox 语义必须在接入时按当前版本验证，不能从文章或截图推断。

---

## 技术方案

### 方案概述

采用“现有 orchestrator + 需求对齐层 + 兼容 Adapter”的分层结构：

```text
用户需求 / 显式纠偏
        ↓
AcceptanceContract（需求真相，冻结并 hash-bound）
        ↓
现有 Orchestrator / Provider / Sandbox
        ↓
Task / Slice / Tool / Validation / Runtime Readback
        ↓
AcceptanceReceipt（逐 criterion、system-owned）
        ↓
Shared Completion Gate
        ↓
passed / failed / unknown / contract revision
        ↓
受治理的 Fixed Eval 候选
```

P0 只修复确定性假完成；P1 建立语义验收闭环；P2 以兼容 facade 和 shadow projection 吸收 Harness 能力；P3 才接外部 Runtime、Transcript 和 writer promotion。任一后续阶段都不能绕过前一阶段的完成 Gate。

### AcceptanceContract v1

```json
{
  "schemaVersion": "acceptance-contract-v1",
  "sourceRequirementHash": "sha256:...",
  "criteria": [
    {
      "id": "ac-user-can-save-draft",
      "statement": "用户刷新页面后仍能恢复草稿",
      "sourceRefs": ["requirement:user-request"],
      "oracle": {
        "type": "readback",
        "procedure": "重新加载目标并读取草稿内容",
        "expected": "读回内容与保存值完全一致"
      }
    }
  ],
  "contractHash": "sha256:..."
}
```

约束：

- 所有进入合同的 criterion 都是硬门槛；非阻塞建议不进入合同。
- `id` 是逻辑业务 ID，不可变身份是 `(contractHash, criterionId)`。
- `statement` 只描述用户可观察结果，不写实现步骤。
- `sourceRefs` 至少一个，防止模型自行发明验收标准。
- `sourceRequirementHash`、`contractHash` 由 runtime 计算，不信任 provider 输入。
- v1 不引入权重、评分、容差 DSL 或自动 `notApplicable`。

### AcceptanceReceipt v1

```json
{
  "schemaVersion": "acceptance-receipt-v1",
  "contractHash": "sha256:...",
  "subjectRef": "result:run-123",
  "subjectHash": "sha256:...",
  "results": [
    {
      "criterionId": "ac-user-can-save-draft",
      "oracleHash": "sha256:...",
      "status": "passed",
      "evaluatorRef": "runtime:agent-loop",
      "evidenceRefs": [
        {
          "kind": "runtime-readback",
          "ref": "validation:draft-readback",
          "digest": "sha256:...",
          "assurance": "verified"
        }
      ],
      "observed": "刷新后读回值与写入值一致"
    }
  ],
  "overallStatus": "passed",
  "receiptHash": "sha256:..."
}
```

派生规则：

- `results` 必须精确覆盖合同 criterion。
- `passed` 至少包含一条与 Oracle 匹配的 verified evidence。
- 任一 `failed` → overall `failed`。
- 无失败但存在缺失或未知 → overall `unknown`。
- 只有全部 `passed` → overall `passed`。
- provider/reviewer 只提交 assessment；最终状态、hash、evaluator identity 和 evidence digest 由 orchestrator 生成。

### Oracle / Evidence 规则

| Oracle | 允许通过的证据 | 必须拒绝 |
|---|---|---|
| `command` | 冻结前通过 policy 的命令、退出码、命令 hash、日志/artifact hash | provider 自报测试通过、未冻结命令、通用 build 冒充业务断言 |
| `artifact` | 安全根目录内的真实路径读回、digest、与 subject 绑定的 freshness | 路径逃逸、旧 artifact、仅声称文件存在 |
| `readback` | 独立 reader/runtime 的查询或探针及结果 hash | writer 自己的写入回执、只证明连接存在 |
| `independent-review` | reviewer 与 writer 身份不同，绑定 contract/subject/criterion hash | summary-only `APPROVED`、未逐 criterion 裁决 |
| `user-confirmation` | fail-closed canonical control envelope（拒重复键/乱序/尾随 prose）+ 绑定 contract/criterion/subject 三元 hash 的显式批准 | 普通自然语言推断、MCP/agent 自报、历史批准重放 |

`user-confirmation` 的实现基线是既有的 `codex-behavior-hook.js` control envelope（`assertExactKeys` 白名单扩展），不是新建 authority；但它当前只在 Codex 侧可达，Claude 侧 parity 单列为 P1-6b。

### 契约接口

| 契约名 | Before | After | 影响副本 / 消费者 |
|---|---|---|---|
| Schema `$ref` | `{$ref:...}` 静默放行，19 个字段零校验 | root 内 sibling/fragment 受限解析并真正执行 `$defs` 约束 | structured-output validator、全部含 `$ref` 的 schema、provider bundling |
| Review result | pipeline 中 `decision`、`compliant` 可矛盾（classic 经 `normalizeReview` 已强制一致）；prompt/schema 枚举漂移 | canonical decision + 逐 criterion assessment；矛盾组合机械拒绝 | pipeline、structured-output validator、review prompt |
| Completion | classic/pipeline 分散判断，pipeline 可 false-success；integration 无 slice 完成度结构校验 | 单一 `completion-gate.js`，所有终态均需 gate `ok=true`，含 required-slice 完成度前置 | classic run、slice review、integration review、operator status |
| Requirement | `acceptanceCriteria: string[]` | v1 Contract 为权威，字符串仅兼容投影；task 引用 `criterionIds` | spec provider、task breakdown、status、Sprint plan |
| Global contract | `globalAcceptance: string[]` | 冻结 contract hash 为权威，旧数组为只读投影 | global freeze、slice planner、drift detector |
| Pipeline slice | slice 自带自由文本 criteria | 只引用冻结合同中的 `criterionIds` | planner、normalizer、implementer、reviewer |
| Validation | command list/exit code | command + criterion coverage + policy/log/evidence hash | slice validation、integration validation、completion gate |
| Result envelope | `evidence` 任意对象 | typed Receipt ref/hash，完成态绑定 matching Receipt | result envelope、turn receipt、provider lifecycle |
| Provider | Claude/Codex 专用 builder/normalizer | checked-in Adapter Registry；旧 API 保留兼容 facade | runtime adapters、profiles、router、canary、pipeline provider |
| Harness event | pipeline、journal、lifecycle、transcript 各自独立 | 非权威、只读、可关联的 `HarnessEvent` projection | status、operator review、可选 BehaviorEvent adapter |
| Transcript | Codex 专用 projection/outbox | `TranscriptSourceAdapter`，Codex 先做等价封装 | SessionEnd hook、outbox、sync worker、PostgreSQL writer/reader |

### 权威源码与生成投影

权威源码：

- `scripts/agent-orchestrator.js`
- `scripts/agent-orchestrator/*.js`
- `scripts/lib/*.js`
- `schemas/agent-loop/*.json`
- `user-level/commands|skills|agents`
- `codex-native/commands|skills|agents`
- `project-level/profiles`

生成投影，不得手工修改：

- `plugins/tech-persistence/scripts/agent-orchestrator.js`
- `plugins/tech-persistence/scripts/agent-orchestrator/*.js`
- `plugins/tech-persistence/scripts/lib/*.js`
- `plugins/tech-persistence/schemas/**`
- `plugins/tech-persistence/skills/**`
- `plugins/tech-persistence/codex-skills/**`

所有源变更完成后统一运行 builder、validator 和 pre-commit parity gate。

### 任务拆解

> 本计划主链不标 `[P]`。核心任务大量修改共享 orchestrator/schema 文件且风险为 L3/L4；按依赖串行执行。每项实施都先写失败回归，再改生产代码。

#### P0 — 消灭确定性 false-success

- [ ] **P0-0 受限 `$ref` 解析（修 live 校验洞）**
  - 目标：让 `$ref` 指向的 `$defs` 约束真被执行，消除 19 个字段的静默放行。
  - 文件：`scripts/agent-orchestrator/structured-output.js`、`scripts/test-provider-structured-output.js`。
  - 依赖：无。
  - 风险：L3（把 19 个既有字段从「从不校验」变成「校验」，可能拒绝现存产物）。
  - 完成证据：只允许 schema root 内 sibling/fragment 引用；网络 URI、路径逃逸、循环、超深引用拒绝；`hash: 99999` 对 `#/$defs/hash` 必须报错（负样本）；按 ADR-013 §B 枚举现存 `.agent-runs/` 产物与 fixture，确认新校验不误拒——若误拒，先修产物或收窄，不得上线让用户绕过。

- [ ] **P0-1 Canonical review contract**
  - 目标：统一 pipeline review 语义，修复 `decision/compliant` 矛盾、prompt/schema 枚举漂移和未受约束的 `contractRevisions`。classic 侧 `normalizeReview`（`agent-orchestrator.js:1026`）已强制 `compliant = decision==='approved'`，本任务不改其语义，只补测试锁定。
  - 文件：`schemas/agent-loop/review-result.schema.json`、`scripts/agent-orchestrator/review.js`、`scripts/agent-orchestrator.js`、`scripts/agent-orchestrator/slice-planner.js`、`scripts/test-provider-structured-output.js`；新增 `scripts/test-agent-orchestrator-review-contract.js`。
  - 依赖：P0-0。
  - 风险：L3。
  - 完成证据：decision 仅允许 `approved|changes_requested|blocked`；approved 必须 `compliant=true`；其他组合 fail closed；prompt/schema/fixture 一致。两类负向回归分开写——(a) 矛盾组合**不完成**；(b) 枚举漂移（prompt 说 `needs-followup`、schema 只认 `changes_requested`）当前**抛错**并落 `review.parse-error.json`，即合法 review 被误拒，方向与 false-success 相反，不要写成「错误完成」。

- [ ] **P0-2 Shared completion gate**
  - 目标：把 classic、slice、integration 的完成条件收口为纯函数和持久化 gate receipt。
  - 文件：新增 `scripts/agent-orchestrator/completion-gate.js`、`schemas/agent-loop/completion-gate.schema.json`、`scripts/test-agent-orchestrator-completion-gate.js`；修改 `policy-gates.js`、`agent-orchestrator.js` 和相关 turn/native tests。
  - 依赖：P0-1。
  - 风险：L3。
  - 完成证据：gate 输出 `scope/ok/reasons/evidenceRefs`；缺失 evidence、非 canonical approved、open clarification/revision/blocker 均失败关闭；旧 `canCompleteRun()` 只保留兼容 facade。
  - 附带修两处同文件缺陷（避免 P1 再回头）：
    - `agent-orchestrator.js:3073-3077` 的 acceptance envelope 硬编码 `validation: { status: 'passed' }`，`completionGate.ok === false` 时仍写 `passed`。run status 经 `statusFromReview`（`:1071`）判定是对的，但持久化 evidence 在说谎，直接违反本计划成功标准「`passed` 必须有 verified evidence」。改为由 gate 结果派生，并加「gate 失败时 envelope 不得为 passed」负样本。
    - `runIntegrationReviewProvider`（`pipeline-providers.js:758-766`）在 reviewer approved 后直接 `transitionRun(COMPLETED)`，**无任何 required-slice 完成度代码校验**；该约束目前只活在 prompt 文本（`slice-planner.js:114`），正是本计划批判的「prompt 当 enforcement」。用现成的 `collectSlicesByState` 把它做成 gate 的确定性前置条件。

- [ ] **P0-3 Pipeline slice review false-success 修复**
  - 目标：任何非 approved review、未解决 revision 或不完整 evidence 都不能进入 `slice-completed`。根因已定位：`pipeline-providers.js:602` 只在 `approved && revisions.length===0` 走早返回，不满足时穿过 revision 循环；`escalated=false` 时 `:681-688` **无条件** transition REVIEWED→COMPLETED。
  - 文件：`pipeline-providers.js`、`pipeline-state.js`、`pipeline.js`、`review.js`、`agent-orchestrator.js` self-test；新增 `test-agent-orchestrator-pipeline-review.js`。
  - 依赖：P0-2。
  - 风险：L3。
  - 完成证据：`changes_requested + revisions=[]`、`blocked + revisions=[]`、`approved + compliant=false` 均不完成；失败后 queue、slice state、locks 一致；只有成功路径标记 completed owner。

- [ ] **P0-4 Integration validation 真执行**
  - 目标：integration review 前由 orchestrator 真实执行聚合验证命令，不再把待执行命令列表当证据。
  - 文件：新增 `scripts/agent-orchestrator/validation-runner.js`、`scripts/test-agent-orchestrator-integration-validation.js`；修改 `validation-command-policy.js`、`review.js`、`pipeline-providers.js`、`pipeline.js`、`slice-planner.js`。
  - 依赖：P0-3。
  - 风险：L4。
  - 完成证据：所有命令经过 allowlist 和 `shell:false`；生成 `integration-validation.json`；policy 拒绝、启动失败、超时、非零退出都阻断完成；review prompt 只引用已执行 artifact。

- [ ] **P0-5 跨模式、文档与投影发布门**
  - 目标：证明 classic/pipeline 使用相同 gate，并同步 tracked projection。
  - 文件：`README.md`、`user-level/commands/agent-loop.md`、相关 architecture 文档及 builder 生成的 plugin scripts/schemas/skills。
  - 依赖：P0-4。
  - 风险：L2。
  - 完成证据：focused tests、orchestrator self-test、native CLI、builder、plugin validator、pre-commit-check、`git diff --check` 全部通过；工作树只含计划内文件。

#### P1 — 建立需求—证据闭环

> **不一次性锁定 8 个任务。** 按 ADR-013 §B / ADR-022 measure-before-enforce，P1 分三批，批间有量化 Gate：
>
> - **批 1（shadow）**：P1-1 + P1-4。只生成 Contract/Receipt，不参与任何完成判定。
> - **Gate B-1（量化）**：用真实 run 统计 criterion 的 `passed / failed / unknown` 分布。`unknown` 占比过高时**先回头调 Oracle 归属，不推进批 2**。
> - **批 2**：P1-2 + P1-3。
> - **批 3**：P1-5 → P1-8。
>
> 依据：多数业务 criterion 无确定性 Oracle。若 `unknown → blocked` 主导早期，v1 会天天 block，用户切回 legacy，触发 `feedback_enforcement_dead_on_arrival_82pct`（enforcement 死于被绕过）。批 1 的唯一目的是拿到这个分布数据。

- [ ] **P1-1 Canonicalization 与 Contract/Receipt 原语**（批 1）
  - 目标：建立不依赖 provider 信任的稳定 hash 与 exact coverage。受限 `$ref` 解析已在 P0-0 完成，此处只消费。
  - 文件：新增 `schemas/agent-loop/acceptance-contract.schema.json`、`acceptance-receipt.schema.json`、`scripts/lib/acceptance-contract.js`、`scripts/test-acceptance-contract.js`。
  - 依赖：全部 P0（含 P0-0）。
  - 风险：L3。
  - 完成证据：稳定 canonical hash；duplicate/missing/extra/tamper 拒绝；provider bundle 与本地 validator 结果一致。

- [ ] **P1-2 强不可变 freeze 与协议版本**（批 2）
  - 目标：freeze 后所有影响执行和验证的字段都纳入 hash/readback；引入 `acceptanceProtocol: legacy|v1`。
  - 文件：`agent-orchestrator.js`、`global-contract.js`、`slice-normalizer.js`、`pipeline.js`、`pipeline-providers.js`；新增 `freeze-receipt.schema.json`、`test-agent-orchestrator-freeze-integrity.js`。
  - 依赖：P1-1。
  - 风险：L3。
  - 完成证据：classic 保存 immutable spec + contract freeze receipt；global/slice hash 覆盖 risk、questions、validation commands、read/owned files；implementation/review 前重新计算；旧 run 缺 receipt 时不静默升级。

- [ ] **P1-3 Criterion ID 贯穿 requirement/task/slice**（批 2）
  - 目标：建立 criterion → task/slice → validation/eval 的明确所有权。
  - 文件：`requirement-spec.schema.json`、`task-breakdown.schema.json`、`global-contract.schema.json`、`pipeline-slice.schema.json`、`pipeline-slice-batch.schema.json`、`agent-handoff.schema.json`、`review-result.schema.json`、`slice-planner.js`、`slice-normalizer.js`、`slice-runner.js`。
  - 依赖：P1-2。
  - 风险：L3。
  - 完成证据：每个 task/slice 声明 `criterionIds`；未知 ID 阻断；每条全局 criterion 落到 slice 或 integration coverage；无法映射时不能 auto-freeze。

- [ ] **P1-4 Acceptance evaluator 与 system-owned Receipt**（批 1，shadow）
  - 目标：按 Oracle 类型核验证据并生成 immutable Receipt。**批 1 阶段 Receipt 只写不判**——不接入 completion gate，用于产出 Gate B-1 的 `passed/failed/unknown` 分布。
  - 文件：新增 `scripts/agent-orchestrator/acceptance-evaluator.js`、`scripts/test-agent-orchestrator-acceptance.js`；修改 `execution-envelopes.js`、`pipeline-providers.js`。（接入 `policy-gates.js` / `completion-gate.js` 推到 P1-5。）
  - 依赖：P1-1。criterion↔task 映射尚未建立时，shadow 阶段允许 Receipt 直接对齐 contract criterion，不依赖 P1-3。
  - 风险：L3。
  - 完成证据：criterion exact coverage；contract/subject/oracle hash 一致；summary-only approval、validation skipped、stale evidence、错误 evidence 类型不能生成 passed Receipt；shadow 模式下 Receipt 存在与否**不改变**任何 run 终态。

- [ ] **P1-5 Classic/Pipeline enforce、合同修订与恢复**（批 3）
  - 目标：两套状态机共用 Receipt gate，合同修订机械失效旧证据，并补 provider reconciliation 路径。
  - 文件：`agent-orchestrator.js`、`pipeline.js`、`pipeline-providers.js`、`policy-gates.js`、`completion-gate.js`、`drift-detector.js`、`provider-lifecycle.js`、`turn-transaction.js`、`operator-review-packet.js` 及对应 tests/schema。
  - 依赖：P1-4 + Gate B-1 通过 + 未决设计决策 D2 已定。
  - 风险：L3。
  - 完成证据：failed → changes_requested；unknown → blocked；全 pass 才 completed；revision 后旧 Receipt stale；retry 保持 provider/stage/effects/goal lease identity；status 分层展示 evidence。

- [ ] **P1-6a 用户确认 Authority（Codex 侧）**（批 3）
  - 目标：提供不可由 agent 自行伪造的 `user-confirmation` Oracle。**基建已存在**，本任务是扩展而非新建：`codex-behavior-hook.js:247-287` 已有 fail-closed canonical control envelope（`action: 'approve'` + `assertExactKeys` + `validateHash`），`behavior-events.js:669-671` 已有 `purpose='approval'` authority 判定，`acceptance_receipt` 已是合法 `source_type`（`:35`）。工作量 = 往 `assertExactKeys` 白名单加 `contractHash + criterionId + subjectHash` 三元绑定。
  - 文件：`scripts/codex-behavior-hook.js`、`scripts/lib/behavior-events.js`、`acceptance-evaluator.js` 及 hook/event tests。
  - 依赖：P1-4。
  - 风险：L3（下调：复用既有 fail-closed 解析路径，非新建 authority 面）。
  - 完成证据：只有绑定 `contractHash + criterionId + subjectHash` 的显式 control envelope 可通过；普通文本、MCP、agent 自报、stale/replay/mismatch 均拒绝；无 authority 时保持 unknown。

- [ ] **P1-6b `user-confirmation` 的 Claude parity 判定**（批 3，先判定再实施）
  - 目标：回答「Claude 侧有没有可用的 approval 捕获面」，避免产出 Codex-only Oracle 违反 ADR-011。
  - 现状：approval authority 只认 `codex_cli`；Claude 侧无对等 behavior hook（全仓仅 `codex-behavior-hook.js`），`claude_prompt` 被 `behavior-events.js:658-662` 限定为 `user.prompt` + `purpose='memory'`。
  - 先产出判定，三条出路择一，**不要默认第三条**：
    1. Claude 侧建对等 control envelope 入口（UserPromptSubmit 承载同一 canonical JSON 协议）。
    2. 判定 Claude 侧不可达 → `user-confirmation` 在 Claude runtime 下降级为 `independent-review`，并在 status 中显式标注 Oracle 降级。
    3. 显式接受 parity 缺口并写入 ADR（需按 ADR-011 论证为何此处可豁免）。
  - 依赖：P1-6a。
  - 风险：L3。
  - 完成证据：判定结论落文档；若选 1 则双 runtime 同 fixture 行为一致；若选 2 则降级在 status/Receipt 中可见且不静默当作 passed。

- [ ] **P1-7 Receipt → Feedback → Fixed Eval**（批 3）
  - 目标：将 verified failed Receipt 和可信纠偏转为受治理回归样本。
  - 文件：`behavior-events.js`、`skill-eval-cases.js`、`self-learning-evaluation-artifacts.js`、`agent-orchestrator.js`、`pipeline.js`、`native-runtime-canary.js`、`model-canary.js` 及 acceptance feedback tests。
  - 依赖：P1-5；用户确认型 case 依赖 P1-6a。
  - 风险：L3。
  - 完成证据：Receipt durable readback 后才产生 task.result；expectation 从冻结 criterion 重算；跨项目、tombstone、hash mismatch 拒绝；只有显式 promotion 才进入固定 case；Acceptance Eval 与模型兼容性 Canary 分账。

- [ ] **P1-8 Codex-native Sprint 桥接**（批 3）
  - 目标：让 `think → plan → work → review` 使用同一 Contract/Receipt 协议，不另造 grader。
  - 文件：`codex-native/skills/{think,plan,work,review,sprint,compound}/SKILL.md`、`docs/plans/TEMPLATE.md`、`scripts/lib/codex-active-sprint.js`、`scripts/codex-active-sprint-state.js` 及 state tests。
  - 依赖：P1-1、P1-5。
  - 风险：L3。
  - 完成证据：新 Sprint 在 plan→work 前冻结 `<plan>.acceptance.json`；review→compound 前读回 passed Receipt；旧 pointer 按 legacy 打开；Receipt/state transition 间崩溃可恢复，不能部分完成。

#### P2 — 兼容 Adapter 与只读 Harness 投影

- [ ] **P2-1 Adapter contract 与脱敏 fixture**
  - 目标：冻结 ProviderAdapter、HarnessEvent、TranscriptSourceAdapter 的 strict schema 和 golden fixture。
  - 文件：新增 `provider-adapter.schema.json`、`harness-event.schema.json`、`transcript-source-adapter.schema.json`、`scripts/fixtures/provider-adapters/*`、`scripts/fixtures/transcripts/*`。
  - 依赖：P1 完成。
  - 风险：L1。
  - 完成证据：稳定 ID/hash；未知字段 fail closed；fixture 仅含合成/脱敏数据。

- [ ] **P2-2 ProviderAdapter compatibility facade**
  - 目标：以 checked-in registry 统一 Claude/Codex 调用，但默认执行字节级不变。
  - 文件：新增 `provider-adapter-registry.js`；修改 `runtime-adapters.js`、`provider-profiles.js`、`native-execution-control.js`、`runtime-capabilities.js`、`execution-envelopes.js`、`agent-orchestrator.js`、`pipeline-providers.js`。
  - 依赖：P2-1。
  - 风险：L3。
  - 完成证据：旧 API 作为 facade；argv/cwd/stdin/schemaPath/runtimeRefs/native acceptance/fingerprint golden 一致；unknown runtime/adapter 拒绝；无动态 module path；mode/hash 写入 execution plan。

- [ ] **P2-3 HarnessEvent 只读投影**
  - 目标：关联 pipeline transition、turn journal、provider result/handoff、lifecycle 和 transcript，但不改变权威状态。
  - 文件：新增 `scripts/lib/harness-events.js`、`harness-event-projection.js`；修改 status projection 和 lifecycle evidence 只读消费者。
  - 依赖：P2-2。
  - 风险：L2。
  - 完成证据：相同源生成相同 event ID；乱序读取稳定；identity mismatch skip；无 raw prompt/stdout/tool args/reasoning；projector/hook 失败不改变 control state。

- [ ] **P2-4 Codex TranscriptSourceAdapter 等价封装**
  - 目标：抽象 transcript source，同时保持 Codex outbox v1/v2、cursor、hash chain、redaction 和数据库语义不变。
  - 文件：新增 `scripts/lib/transcript-source-adapters.js`；修改 `sync-codex-transcripts.js` 和相关 outbox/projection/PostgreSQL tests。
  - 依赖：P2-2。
  - 风险：L3。
  - 完成证据：同一 Codex fixture 的 transcriptId、event count、byte cursor、event/projection hash chain 字节级等价；重放、断网保留、独立 reader 读回不回归。

- [ ] **P2-5 Projection/cache 一致性门**
  - 目标：生成所有新增模块/schema 的 plugin projection 并验证安装后 fresh runtime。
  - 文件：builder、validator、projection inventory 和相关 tests；不手改生成树。
  - 依赖：P2-2 至 P2-4。
  - 风险：L2。
  - 完成证据：root/plugin/cache hash 一致；build/validate/pre-commit/fresh-runtime smoke 通过。

#### P3 — 外部 Runtime、Transcript 与写权限晋级

- [ ] **P3-1 外部 Provider shadow**
  - 目标：每个外部 Runtime 以独立 checked-in descriptor/normalizer/profile 接入，只生成 shadow route，不替换当前 Provider。
  - 文件：Provider registry、profiles、runtime/route schema、native validator、脱敏 fixtures。
  - 依赖：P2 完成，并验证目标 Runtime 当前官方协议。
  - 风险：L3。
  - 完成证据：workspace diff=0、external effects=[]；shadow decision/descriptor/capability hash 可复算；加入 adapter-specific environment allowlist，未满足前禁止 live promotion。

- [ ] **P3-2 Read-only live canary 与 promotion receipt**
  - 目标：验证 cold start、structured output、terminal success/failure/timeout、resume、event correlation、repo-read 和 env redaction。
  - 文件：`native-runtime-canary.js`、promotion policy/receipt schema、execution plan 记录和 tests。
  - 依赖：P3-1。
  - 风险：L3。
  - 完成证据：固定 case 连续通过；0 workspace/external effects；0 identity/hash mismatch；只有 `registered + observed capability + fixed canary PASS + explicit allowlist + promotion receipt` 才启用 read-only。

- [ ] **P3-3 外部 Transcript shadow**
  - 目标：以只读 discover/inspect/stream 接入外部 session，未知格式不猜测解析。
  - 文件：provider-specific transcript source adapter、fixture、dry-run CLI/tests。
  - 依赖：P3-1 和当前版本真实 transcript fixture。
  - 风险：L3。
  - 完成证据：增量与全量投影一致；system/developer/reasoning/internal state 不入 projection；未知 shape 只留 ID/hash；无可靠 SessionEnd 时仅允许 batch dry-run。

- [ ] **P3-4 Runtime-neutral outbox + PostgreSQL canary**
  - 目标：复用 durable outbox、writer transaction、独立 reader readback，必要时才另立 DB migration。
  - 文件：generic outbox core/job schema、sync worker、configurator、package scripts、运维文档和 transcript tests。
  - 依赖：P3-3。
  - 风险：L4。
  - 完成证据：durable job → writer transaction → independent reader exact count/cursor/hash-chain/duplicate=0 → ack；重复消费 inserted=0；断网 retained；hook 无 DB 凭据和正文。

- [ ] **P3-5 多 candidate enforce / writer promotion**
  - 目标：在固定 canary 和显式授权后才允许 registry 构建多 candidate route，并保持唯一 writer。
  - 文件：`native-execution-control.js`、`capability-router.js`、`pipeline-providers.js`、policy、promotion receipt 和 canary tests。
  - 依赖：P3-2；建议具备 P3-3 可观测性。
  - 风险：L4。
  - 完成证据：route deterministic；唯一 writer；base/diff/head/result/criterion evidence 完整；partial/committed effects 时禁止换 Provider，必须原 Provider resume 或人工 reconciliation。

### 未决设计决策（必须在 P1 批 3 前定，不得留到实施期）

- [ ] **D1 无确定性 Oracle 的 criterion 默认走哪个 Oracle？**
  多数业务 criterion 无法用 `command` / `artifact` / `readback` 覆盖。若 `user-confirmation` 因 P1-6b 只在 Codex 可达，全部会积压到 `independent-review`，reviewer 成为唯一瓶颈且 `unknown → blocked` 主导早期。必须明确：默认 Oracle 是什么、reviewer 吞吐上限如何处理、`unknown` 是否允许在特定 risk 等级下不阻塞。
  依赖 Gate B-1 的实测分布数据；D1 未定不得进入 P1-5 enforce。

- [ ] **D2 合同修订后，已 `slice-completed` 的 slice 是否重开？**
  `contractHash` 改变时旧 Receipt 判 stale（计划已定），但未答已完成 slice 的处置。这决定 contract revision 在 run 中途到底可不可用：全部重开则修订成本极高、接近重启 run；不重开则完成态由旧合同背书，与「stale evidence 不能满足新合同」直接矛盾。可选方向：按 criterion 影响面局部重开（只重开 `criterionIds` 与被改字段相交的 slice）。
  属状态机语义，必须设计期定；P1-5 完成证据依赖此结论。

### 测试策略

#### 最窄反馈环

1. 每个任务先增加失败回归，确认当前代码确实暴露目标缺陷。
2. 直接运行新增单元测试脚本，避免先通过全套 wrapper 掩盖根因。
3. 修改最小生产文件，重复运行对应 focused tests。
4. 通过 focused tests 后才进入 classic/pipeline self-test、canary、projection 和全套测试。

#### 完整测试矩阵

| 维度 | 必测场景 |
|---|---|
| Schema `$ref` | 不合 `$defs` 模式的值必须被拒（`hash: 99999`）、网络 URI、路径逃逸、循环引用、超深引用、现存产物不误拒 |
| Review | approved/compliant 矛盾、summary-only、finding/follow-up/revision 冲突、enum 漂移导致合法 review 被误拒 |
| Completion | missing evidence、validation failed/skipped、open clarification、queue/lock 不一致、required slice 未全 completed、gate 失败但 envelope 写 passed |
| Contract | 空 criteria、重复 ID、非法 Oracle、额外字段、hash tamper、语义变更换 hash |
| Receipt | missing/extra/duplicate result、错误 oracleHash、伪造 overall、无证据却 passed |
| Command | policy deny、非零退出、超时、旧输出、通用 build 冒充业务断言 |
| Artifact | 路径逃逸、symlink/outside root、digest 变化、stale artifact |
| Readback | writer 自证、错误目标、权限不足、query 失败、独立 reader 成功 |
| Review Oracle | reviewer=writer、漏 criterion、逐 criterion 合格 review |
| User Oracle | 普通文本、MCP 自报、过期 approval、三元 hash mismatch、真实 native approval |
| Classic | spec→freeze→implement→fail/pass→follow-up→resume |
| Pipeline | non-approved zero revisions、orphan criterion、跨 slice、integration failure、revision stale |
| Compatibility | legacy hash golden、历史 run resume、dual-field mismatch、新旧投影 parity |
| Concurrency/Recovery | 双 freeze CAS、并发 Receipt、临时文件崩溃、重复事件幂等、partial effects |
| Feedback | verified failure、trusted correction join、跨项目/tombstone 拒绝、显式 promotion |
| Adapter | unknown runtime、capability mismatch、env leakage、native identity mismatch |
| Transcript | full/incremental parity、redaction、cursor/hash chain、outbox replay、独立读回 |
| Projection | canonical/plugin/cache inventory、schema/skill/script parity |
| Canary | false completion、stale receipt、缺 user authority、legacy resume、无 ledger/坏 ledger |

#### 回归命令

P0/P1 focused tests 名称按任务创建，随后至少运行：

```powershell
node scripts\agent-orchestrator.js self-test
node scripts\native-runtime-canary.js self-test
node scripts\test-agent-orchestrator-native-cli.js
node scripts\test-provider-turn-validation.js
node scripts\test-provider-structured-output.js
node plugins\tech-persistence\scripts\build-codex-plugin.js
node scripts\validate-codex-plugin.js
node scripts\pre-commit-check.js
git diff --check
npm test
```

若 `npm test` 或包装测试遇到 `spawn EPERM`，直接运行 focused test 文件，并分别报告 wrapper 环境阻塞与业务断言结果，不将两者合并。

### 迁移与发布 Gate

#### Legacy → v1

- state 缺 `acceptanceProtocol` 时解释为 `legacy`，不改写历史 run。
- 第一阶段新 run 默认 legacy，显式 canary 开启 v1 shadow。
- shadow 通过后新 run 默认 v1 enforce；legacy reader 长期保留。
- v1 同时生成旧字符串字段作为只读 projection；新旧字段不一致时 fail closed。
- 旧 run 升级 v1 必须显式 re-freeze，不能自动猜测 Oracle 或映射 Task/Slice。

#### 阶段 Gate

- **Gate A / P0：** `$ref` 静默放行已修且不误拒现存产物；四类 false-success 都有负向回归且修复；hardcoded `validation.status` 已由 gate 派生；classic/pipeline 共用 completion gate 且含 required-slice 前置。
- **Gate B / P1 批 1 shadow：** Contract/Receipt 稳定生成，零未解释 hash/coverage 差异，legacy resume 不回归；Receipt 存在与否不改变任何 run 终态。
- **Gate B-1 / 量化（新增，批 1→批 2 之间）：** 用真实 run 统计 criterion 的 `passed / failed / unknown` 分布与各 Oracle 命中占比。`unknown` 占比过高时先回头调 Oracle 归属与 D1，**不推进批 2**。此 Gate 的产出是 D1 的输入。
- **Gate C / P1 enforce：** D1、D2 均已定论；固定语义案例全部通过，才把新 run 默认切到 v1 enforce。
- **Gate D / P2：** Claude/Codex Adapter golden 字节级兼容，才接外部 Runtime shadow。
- **Gate E / P3 read-only：** 外部 Runtime canary 通过并显式批准，才允许真实 read-only 调用。
- **Gate F / P3 writer/DB：** 任何外部写入、writer promotion 或 DB migration 单独审批，不随 Adapter 接入自动扩大权限。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---:|---:|---|
| Contract 内容本身误解用户需求 | 中 | 高 | sourceRefs、可观察 statement、human freeze、显式 revision |
| Provider/reviewer 伪造通过 | 中 | 高 | system-owned Receipt、独立 identity、exact coverage、hash/readback |
| Completion Gate 过严导致大量 unknown → v1 被用户关闭（enforcement dead on arrival） | 中-高 | 高 | 批 1 只 shadow；Gate B-1 先量化 unknown 占比；D1 定默认 Oracle；unknown 明示而非降级通过 |
| `$ref` 修复后拒绝现存产物 | 中 | 中 | ADR-013 §B：上线前枚举 `.agent-runs/` 产物与 fixture；误拒则修产物或收窄，不让用户绕过 |
| `user-confirmation` 落地即 Codex-only，违反 ADR-011 | 高 | 中-高 | P1-6b 先判定 Claude 可达性；不可达则降级为 independent-review 并在 status 显式标注，不静默当 passed |
| 已完成 slice 与 contract revision 的关系未定导致状态机自相矛盾 | 中 | 高 | D2 设计期定论，作为 P1-5 前置 |
| Schema/Prompt/Runtime 同步漂移 | 中 | 高 | canonical schema、受限 `$ref` resolver、golden fixture、projection parity |
| Integration 命令扩大副作用 | 低-中 | 高 | allowlist、shell:false、禁止发布/部署/迁移/安装/seed/reset |
| 历史 run 无法 resume | 中 | 高 | 显式 protocol version、legacy hash 保留、双读、不隐式改写 |
| Contract revision 误用旧证据 | 中 | 高 | `(contractHash, criterionId)` identity、stale Receipt 拒绝 |
| 用户批准被自然语言伪造 | 中 | 高 | 原生 authority、三元 hash、普通文本/MCP/agent 自报拒绝 |
| HarnessEvent 泄露 prompt/reasoning | 低-中 | 高 | 只存结构化 refs/status/effects、redaction、content-addressed read model |
| 外部 Adapter 继承全部环境变量 | 中 | 高 | adapter-specific env allowlist；未实现前禁止 live promotion |
| Plugin/source/cache 多副本漂移 | 中 | 中 | source-only 修改、builder 原子投影、validator/pre-commit/hash gate |
| Transcript 外部格式不稳定 | 中 | 中-高 | verified fixture、shadow/dry-run、未知 shape 只留 ID/hash |
| Wrapper `spawn EPERM` 被误报为业务失败 | 中 | 中 | focused direct tests，与环境阻塞分开报告 |

### 回滚与恢复

- Acceptance：将新 run 默认切回 legacy/shadow；已有 v1 reader 永久保留，不删除 Contract/Receipt。
- Adapter：切回 `provider-adapter-mode=legacy`；忽略 shadow projection 即可。
- HarnessEvent：关闭 projector，不修改或回滚权威 journal/goal lease。
- Transcript：停止新 collector，保留未 ack outbox job；不得自动删除已写数据库行。
- Provider：无 effects 时可禁用；partial/committed effects 后不得切换 Provider，必须原 Provider resume 或人工 reconciliation。
- Schema：保留旧版本 reader 和 golden；禁止通过降级重写已生成的 v1 artifact。
- Plugin：只从 canonical source 重建，禁止编辑 generated tree 或 cache。
- Learning：learning append 失败不反向伪造 acceptance 失败；保留可重试证据并报告未落盘。

### 涉及文件

核心现有文件：

- `scripts/agent-orchestrator.js`
- `scripts/agent-orchestrator/{review,policy-gates,pipeline,pipeline-state,pipeline-providers,slice-planner,slice-normalizer,slice-runner,global-contract,drift-detector,execution-envelopes,provider-lifecycle,turn-transaction,runtime-adapters,native-execution-control,runtime-capabilities,capability-router,operator-review-packet,structured-output}.js`
- `scripts/lib/{behavior-events,self-learning-evaluation-artifacts,codex-active-sprint}.js`
- `schemas/agent-loop/{requirement-spec,task-breakdown,global-contract,pipeline-slice,pipeline-slice-batch,agent-handoff,review-result,result-envelope,contract-revision}.schema.json`
- `scripts/model-canary.js`
- `scripts/agent-orchestrator/native-runtime-canary.js`
- `scripts/sync-codex-transcripts.js`
- `codex-native/skills/{think,plan,work,review,sprint,compound}/SKILL.md`
- `docs/plans/TEMPLATE.md`
- `README.md`
- `user-level/commands/agent-loop.md`

计划新增文件：

- `scripts/agent-orchestrator/completion-gate.js`
- `scripts/agent-orchestrator/validation-runner.js`
- `scripts/agent-orchestrator/acceptance-evaluator.js`
- `scripts/agent-orchestrator/provider-adapter-registry.js`
- `scripts/agent-orchestrator/harness-event-projection.js`
- `scripts/lib/acceptance-contract.js`
- `scripts/lib/harness-events.js`
- `scripts/lib/transcript-source-adapters.js`
- `schemas/agent-loop/completion-gate.schema.json`
- `schemas/agent-loop/freeze-receipt.schema.json`
- `schemas/agent-loop/acceptance-contract.schema.json`
- `schemas/agent-loop/acceptance-receipt.schema.json`
- `schemas/agent-loop/provider-adapter.schema.json`
- `schemas/agent-loop/harness-event.schema.json`
- `schemas/agent-loop/transcript-source-adapter.schema.json`
- 对应 `scripts/test-*.js` 和脱敏 fixture。

### 下一可执行动作

从 **P0-0** 开始（它是 P1 hash-bound 的前置，且修的是现存 live 洞），先写失败回归：

1. `hash: 99999` 对 `{"$ref":"#/$defs/hash"}`（`^sha256:[a-f0-9]{64}$`）当前零报错——已实测确认，`structured-output.js:41-135` 无 `$ref` 分支；
2. 枚举现存 `.agent-runs/` 产物与 fixture，确认加上 `$ref` 解析后不误拒（ADR-013 §B）。

随后 **P0-1**，再写三组失败回归：

3. pipeline 中 `approved + compliant=false` 被 `reviewApproved()`（`review.js:66-70`）错误接受；
4. `changes_requested + contractRevisions=[]` 被 pipeline 错误推进（`pipeline-providers.js:602` 早返回不命中 → `:681-688` 无条件 completed）；
5. review prompt 的 `needs-followup`（`slice-planner.js:90,112`）与 schema 的 `changes_requested`（`review-result.schema.json:16`）漂移，**当前表现为抛错落 `review.parse-error.json`**，即合法 review 被误拒。

确认测试在当前代码上按预期失败后，再修 validator、review schema、normalizer 和 pipeline 分支。未经单独授权，不提交、不推送、不生成外部状态。

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|---|---|---|
| 2026-08-27 | Plan | 完成只读架构分析并创建本实施计划；未初始化 Sprint，未修改生产代码。 |
| 2026-08-27 | Plan 修订 | 逐条核实原 4 项 P0 断言（全部成立，补精确行号）。新增 3 项原计划漏报/未提的缺陷：`$ref` 静默放行（升 P0-0，实测 `hash: 99999` 零报错，19 字段现零校验）、classic acceptance envelope 硬编码 `validation.status: 'passed'`、integration 无 required-slice 完成度校验（后两项并入 P0-2）。修正 1 处误分类：枚举漂移后果是**合法 review 被误拒（抛错）**，非 false-success。P1 由「一次锁定 8 任务」改为三批 + Gate B-1 量化门。P1-6 拆为 6a（Codex 侧扩既有 control envelope，风险 L4→L3）+ 6b（Claude parity 先判定）。新增未决设计决策 D1（无确定性 Oracle 的默认归属）、D2（contract revision 是否重开已完成 slice）。未修改生产代码。 |

---

## 审查结果

### P0 — 必须修复

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|---|---|---|---|
| 1 | Pipeline review | `pipeline-providers.js:602`、`:681-688` | 非 approved 且无 revision 可落入 completed 分支（早返回不命中后无条件 transition） | 已核实 / 待实施 |
| 2 | Integration validation | `pipeline-providers.js:717-719` / `slice-planner.js:127-130` | 命令只进入 prompt 文本，全仓无执行点；approved 后直接完成 | 已核实 / 待实施 |
| 3 | Review contract | `review.js:66-70` | `reviewApproved()` 忽略 `compliant`；矛盾组合仅 pipeline 可达（classic 经 `normalizeReview`（`agent-orchestrator.js:1026`）已强制一致） | 已核实 / 待实施 |
| 4 | Prompt/schema | `slice-planner.js:90,112` / `review-result.schema.json:16` | `needs-followup` 与 `changes_requested` 漂移。**后果是合法 review 被误拒（抛错）**，非 false-success | 已核实 / 待实施 |
| 5 | Schema validator | `structured-output.js:41-135` | `$ref` 静默放行：无 `$ref` 分支，`{$ref:...}` 视为无约束通过。实测 `hash: 99999` 对 `#/$defs/hash` 零报错；`agent-assignment`/`provider-handoff`/`result-envelope` 共 19 个字段当前零校验 | 新增（原计划埋在 P1-1 风险段，升 P0-0） |
| 6 | Classic evidence | `agent-orchestrator.js:3073-3077` | acceptance envelope 硬编码 `validation.status: 'passed'`；gate 失败时 evidence 仍写 passed（run status 本身正确） | 新增（并入 P0-2） |
| 7 | Integration gate | `pipeline-providers.js:758-766` | reviewer approved 即 `transitionRun(COMPLETED)`，无 required-slice 完成度代码校验；约束只在 prompt（`slice-planner.js:114`） | 新增（并入 P0-2） |

### P1 — 建议修复

| # | 视角 | 问题 | 状态 |
|---|---|---|---|
| 1 | Requirement semantics | Acceptance 仍为自由文本，没有稳定 criterion ID、Oracle 和 evidence mapping | 待实施 |
| 2 | Freeze integrity | 部分行为字段未纳入冻结 hash/readback | 待实施 |
| 3 | Completion semantics | Hash/exit code/reviewer approval 证明流程，不证明用户结果 | 待实施 |
| 4 | Feedback loop | 用户纠偏尚未形成受治理的产品级固定 Eval | 待实施 |
| 5 | Oracle parity | approval authority 只认 `codex_cli`（`behavior-events.js:669-671`）；Claude 侧无对等 behavior hook，`claude_prompt` 被限定为 `user.prompt` + `purpose=memory`（`:658-662`）。`user-confirmation` 直接落地即 Codex-only，违反 ADR-011 | 新增（拆为 P1-6b，先判定后实施） |
| 6 | Enforcement 时序 | 原 P1 一次性锁定 8 个任务，未在 P0 产出证据前量化 `unknown` 占比；`unknown → blocked` 主导早期会触发 `feedback_enforcement_dead_on_arrival_82pct` | 新增（改为三批 + Gate B-1 量化） |

### P2 — 可选优化

| # | 视角 | 建议 | 状态 |
|---|---|---|---|
| 1 | Provider | 引入兼容 Adapter Registry，先封装现有 Claude/Codex | 后置 |
| 2 | Event | 增加非权威 HarnessEvent 关联投影 | 后置 |
| 3 | Transcript | 增加 TranscriptSourceAdapter，保持现有 outbox/DB 验收 | 后置 |
| 4 | Runtime | 外部 Runtime 只在 shadow/canary 后晋级 | 后置 |

### 总评

当前架构已经是合格的外部 Harness 骨架；实施优先级必须是“先修 false completion，再建立需求—证据闭环，最后扩 Runtime”。只要 Completion Gate 仍可能把流程完成误认为需求满足，新增 Provider、Plugin、Subagent 或事件量都会放大而不是解决偏差。

---

## 复利记录

### 提取的经验

- Contract integrity 不等于 Contract validity。
- Terminal success、schema pass、hash、validation exit 0、review approved、state completed 都只证明各自层级，不自动证明用户需求满足。
- 外部 Harness 最适合作为 Provider/Evidence adapter 接入，而不是新 state owner。
- 产品 Acceptance Eval 与模型兼容性 Canary 应分账，复用 ledger/hash 方法但不混用语义。
- **「validator 不完整支持某特性」与「validator 静默放行某特性」是两个量级的问题。** 前者是待补齐，后者是既存 live 洞。判定方式只有一条：拿明确违反约束的值跑一次探针，看是否报错。本次实测 `hash: 99999` 对 `{"$ref":"#/$defs/hash"}` 零报错，才把它从 P1 风险段升为 P0-0。写「不完整支持」这类措辞时必须先探针，否则会把 live 洞排到后面。
- **断言某缺陷「classic/pipeline 共同存在」前要分别核两条路径的 normalize 层。** 本例 `decision/compliant` 矛盾只在 pipeline 可达——classic 经 `normalizeReview` 已强制 `compliant = decision==='approved'`。不分开核会写出修一半不存在问题的任务。
- **enforcement 的方向要看它误伤谁**：枚举漂移与 false-success 表面都是「review 语义不一致」，但前者拒绝合法 review、后者放过非法完成，负向回归的断言完全相反。归类时按「谁被误伤」而非「症状像什么」。
- **判定某 Oracle/authority 可行性时，先 grep 基建是否已存在，再判 parity 是否对称。** 本例两者都被原计划判反：`user-confirmation` 基建已在（故风险 L4→L3），但 authority 只认 `codex_cli`、Claude 侧无对等 hook（故存在原计划未列的 ADR-011 缺口）。「要新建」与「已存在但不对称」需要的任务完全不同。

### 创建/更新的本能

- 无；本计划不自动写学习或触发 Compound。

### 解决方案文档

- 待 P0/P1 实施并通过验证后再决定是否生成 `docs/solutions/` 记录。
