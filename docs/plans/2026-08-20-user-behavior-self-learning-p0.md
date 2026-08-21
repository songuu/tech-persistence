---
type: sprint
status: completed
created: 2026-08-20
completed: 2026-08-21
slug: user-behavior-self-learning-p0
---

# 用户行为驱动 Agent 自学习框架 P0

## 用户请求

执行上一轮清单中的全部 P0：建立一个能够学习用户行为、操作、纠正与结果，并据此优化后续
Agent 执行的可信基础闭环。

## Think：目标与边界

### 要做

- 接通并统一 Codex/现有 observation 输入，将用户输入、工具操作、纠正、审批和结果规范化为
  `BehaviorEvent`，再按任务聚合为 `BehaviorEpisode`。
- 建立 `EvidenceRef` 与 `LearningCandidate`，覆盖 preference、environment fact、strategy、
  workflow、boundary、anti-pattern 六类学习资产。
- 实现 scope、provenance、counterexample、TV、confidence、生命周期、过期与人工 promotion gate。
- 保持 raw evidence append-only、可脱敏、可去重、可审计、可删除/过期；损坏或身份不一致时
  fail-closed，不以调用次数冒充质量。
- 让 `/evolve` 和 `/skill` 共用 candidate/eval/publish 门禁；P0 只允许 shadow，不自动修改共享
  runtime、全局规则或团队资产。
- 复用现有纯文件/JSONL、homunculus、plugin projection 和测试设施，完成多 runtime 投影与验证。

### 不做

- 不引入数据库、向量库、常驻 Gateway 或外部服务。
- 不做 Git/PR 自动蒸馏、RuntimePatch 自动执行、多维 LLM evaluator 或 P1 runtime strategy resolver。
- 不把历史 telemetry 批量迁移成已验证学习结论；缺少 provenance 的旧数据保持原状。
- 不自动提交、推送、安装、写团队共享 runtime，也不修改用户原始方法论文档。

## 可观察的成功标准

1. WHEN Codex 或兼容输入提交行为事件，THE SYSTEM SHALL 生成 schema-versioned、脱敏、幂等的
   `BehaviorEvent`，并保留 actor、task/session、scope、source、parent、input/output digest 和状态。
2. WHEN 同一任务的事件被归并，THE SYSTEM SHALL 生成可重建的 `BehaviorEpisode`，区分显式反馈、
   弱隐式信号、最终处置、验证证据和未知结果，不把单个事件直接当长期偏好。
3. WHEN Episode 产生学习候选，THE SYSTEM SHALL 生成带 evidence、counterexamples、TV、confidence、
   owner、scope 和 lifecycle 的 `LearningCandidate`，且单样本默认不能 promoted。
4. WHEN evidence/candidate/result 数据缺失、截断、损坏或 hash/identity 不匹配，THE SYSTEM SHALL
   fail closed 或返回 `needs-review`，不得静默使用陈旧记录或伪造无使用/成功结论。
5. WHEN candidate 被应用，THE SYSTEM SHALL 仅进入 shadow/建议状态；任何 promoted、全局或团队写入
   必须有显式人工批准、审计记录和可撤销状态。
6. WHEN 用户查看或治理学习结果，THE SYSTEM SHALL 能列出来源、scope、置信度、反例和状态，并支持
   reject、expire、delete/tombstone 或 scope 修正。
7. WHEN `/evolve` 生成 Skill/Command 候选，THE SYSTEM SHALL 不再绕过 candidate/eval/publish gate；
   P0 不自动写入默认 runtime。
8. WHEN 构建和测试完成，THE SYSTEM SHALL 证明 canonical source、plugin/runtime projection、schema、
   CLI 和 corruption/security fixtures 一致；未验证的跨 harness 行为保持未知。

## 风险、假设与待确认项

- “全部 P0”按上一轮列出的 35 项能力解释；Plan 阶段必须建立逐项覆盖矩阵，不能只实现几个核心类。
- 当前工作树已有上一轮分析、solution index 和用户方法论文档；这些均保留并与本轮实现分开报告。
- 本计划起草时曾按旧 Codex 能力边界假设缺少 turn behavior hooks；该假设已被 2026-08-21
  本机 Codex 0.147.0 `hooks stable` 与当前 [release contract](https://developers.openai.com/codex/hooks)
  取代。实现只采用 release 已列出的
  `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 及其官方字段，不按 main-branch schema
  猜测未来字段。
- 行为是否代表偏好存在误归因风险，因此显式反馈权重大于隐式信号，所有新候选先 shadow。
- 删除采用可审计 tombstone/状态迁移优先于破坏性擦除；真正敏感原文仍必须在写入前脱敏。

## 执行状态

Work、独立 Review 与 Compound 已完成。实现结果、最终不变量、迁移边界和验收证据见
`docs/solutions/2026-08-21-user-behavior-self-learning-p0.md`。

## Plan：冻结方案

### 已验证的现状

- Claude 已有 `PreToolUse`/`PostToolUse` observation 与 `Stop` evaluator，但用户 prompt 不落 observation，
  `Stop` 也没有消费最终处置；旧 JSONL 允许坏行静默跳过，不能作为可信学习真相源。
- 本计划起草时 Codex 只注册写类 `PreToolUse` guard 和四类 lifecycle evidence；Work 阶段已现场核验
  Codex 0.147.0 的 stable hooks 与当前 release docs：common payload 为 `session_id`、
  `transcript_path`、`cwd`、`model`，四类 turn hooks 含 `turn_id`，tool hooks 含 `tool_use_id`，
  `PostToolUse` 另含 `tool_response`，`timeout` 单位为秒。standalone Codex 现可自动写 governed journal；
  managed agent-loop 仍可额外引用 task/result/acceptance envelope 的 hash 强证据。
- 当前 `/evolve --auto`、`evaluate-session` 和若干学习命令可直接写 instinct/skill；skill eval result
  reader 会跳过坏行，CLI 异常时退出 0，均不满足 promotion gate。
- `scripts/lib/redaction.js` 已有递归脱敏能力；agent-loop 已有 canonical hash、CAS、authority/path guard、
  immutable evidence 与原子 projection 的可复用实现模式。
- root `scripts/`、`scripts/lib/`、`user-level/` 与 `schemas/` 是 canonical source；plugin 目录是构建
  projection。当前 builder/validator 只复制和校验 `schemas/agent-loop`。

### 能力边界

| 输入面 | P0 可信采集方式 | 不做的推断 |
|---|---|---|
| Claude hooks | prompt/tool hook adapter 双写 `BehaviorEvent`；Stop 关闭 Episode | 不把工具成功直接当偏好或任务成功 |
| Codex standalone | 原生 UserPromptSubmit/PreToolUse/PostToolUse/Stop 写 receipt；固定 control envelope 采集显式 feedback/correction/approval；MCP/CLI 仅作非用户 authority 的显式入口 | 不从自然语言推断控制，不把 PostToolUse 触发或 Stop message 当工具/任务成功 |
| Codex managed agent-loop | lifecycle 与 task/result/acceptance envelope 作为 `EvidenceRef` | 不把系统 acceptance 当用户批准 |
| 历史 observations/results | `legacy-unverified` adapter，只能进入 `needs-review` | 不批量升级为事实或 promoted 资产 |

缺少稳定 source event id、task id 或验证结果时，事件/任务分别标记 `unassigned`、`incomplete`、
`unknown`；不得用时间戳 fallback 冒充可幂等的 source identity。

### Authority SSOT 与存储事务

权威存储采用纯文件、严格、append-only 的 hash-chain journal：

```text
{homunculus}/projects/{projectId}/self-learning/v1/
  journal/
    000000000001-{recordHash}.json
    000000000002-{recordHash}.json
    ...
    LOCK.json
  projections/                 # 可删除、可重建，不是 truth
```

每个 journal record 包含 `sequence`、`record_type`、`record_id`、`entity_id`、`actor`、
`occurred_at`、`payload_hash`、`previous_hash`、`record_hash` 和已脱敏 `payload`。统一 writer/reader
执行以下契约：

1. writer 在写锁内完整读取并严格验证现有链；锁损坏或已有锁时 fail closed，不自动回收。
2. 同 `record_id + payload_hash` 是幂等 no-op；同 ID 异 hash 是冲突并阻断。
3. 新 record 先写同目录临时文件、fsync，再 rename 成不可变最终文件并 readback；提交后不覆盖。
4. reader 对文件名、schema、exact fields、sequence、previous/hash、payload hash、断档、分叉、残留事务
   做严格检查；任何异常返回 corruption/needs-review，不跳行。
5. event/evidence/episode/candidate transition/tombstone/approval receipt 都写同一 journal；projection 只从
   journal 重建，确保 writer/reader 共用唯一 SSOT。
6. `delete` 在 P0 表示追加绑定 `target_id + target_hash` 的 tombstone，并从 active projection 隐藏；
   不宣称擦除 journal、备份或恢复证据中的原字节。物理 purge 留给独立后续协议。

### 合同与模块

新增 canonical schema：

- `schemas/self-learning/evidence-ref.schema.json`
- `schemas/self-learning/behavior-event.schema.json`
- `schemas/self-learning/behavior-episode.schema.json`
- `schemas/self-learning/learning-candidate.schema.json`
- `schemas/self-learning/candidate-evaluation.schema.json`
- `schemas/self-learning/approval-receipt.schema.json`
- `schemas/self-learning/journal-record.schema.json`
- `schemas/self-learning/tombstone.schema.json`

新增实现：

- `scripts/lib/self-learning-canonical.js`：canonical JSON、hash、exact-shape、ID 与路径校验。
- `scripts/lib/self-learning-store.js`：journal lock、strict read、append、幂等、CAS、projection、tombstone。
- `scripts/lib/behavior-events.js`：`BehaviorEvent`、`EvidenceRef`、Claude/Codex/agent-loop adapter。
- `scripts/lib/behavior-episodes.js`：按显式 task identity 聚合 Episode、最终处置、完整性与基线指标。
- `scripts/lib/learning-candidates.js`：candidate taxonomy、TV、counterexample、lifecycle 与 authority gate。
- `scripts/self-learning.js`：单一 CLI；`record`、`close`、`propose`、`evaluate`、`shadow`、`approve`、
  `promote`、`inspect`、`metrics`、`govern`、`verify-store`。
- `user-level/commands/self-learning.md`：人/Agent 可审计入口。

`scripts/lib/memory-tools.js` 暴露同一实现的短名 MCP：`tp_learning_record`、
`tp_learning_close`、`tp_learning_propose`、`tp_learning_inspect`、`tp_learning_govern`；不建立第二套
writer。Claude hook 保留 legacy observation 兼容双写；Codex lifecycle 保留 run-local immutable evidence，
只在显式身份齐全时投影/导入事件。Codex turn hooks 直接写 canonical governed journal，使用原生
`turn_id`/`tool_use_id` 作为 receipt authority；缺少稳定身份即 fail closed。

### 数据语义

`BehaviorEvent` 必含版本、稳定 source/idempotency identity、project/session/task/turn/parent、actor、
runtime/source assurance、scope、event type、显式/弱/推断强度、事实状态、status、final disposition、
递归脱敏 details、input/output digest 与 evidence refs。

Codex 显式用户控制不做自然语言推断，固定为 `TP_SELF_LEARNING_CONTROL_V1:` 加逐字 canonical JSON，
整条 UTF-8 最多 4096 bytes。durable memory 只接受 exact `{"action":"remember","body":"..."}`；
普通 prompt/feedback/correction 不构成保存同意，Claude 也必须由原始 prompt digest 精确绑定同一 canonical
control。approval exact shape 绑定 `candidate_id`、当前 candidate hash、
`action=approve` 与 `accepted=true`，且候选必须仍为 live `shadow`；feedback/correction 也使用各自 exact
shape。UserPromptSubmit `source_event_id`/`authority_ref` 只绑定原生 `session_id`、`turn_id` 与 hook 名；
semantic 只作为冲突保护内容，不进入 receipt identity。同 turn 内容或分类变化 fail closed，且 approval 的
live-shadow 校验与 append 共用 journal transaction。无效前缀只输出有界错误码；generic Agent/MCP/CLI
不能伪造 native user authority。generic MCP/CLI 的 proposal、evaluation 与 shadow actor 使用固定的
agent role、空 authority ref 和服务器首写时间，调用方 actor/authority/time 不进入 journal。

`BehaviorEpisode` 只按显式 task ref 聚合；无 task ref 留在 session-unassigned。它绑定有序 event
ID/hash，分别列出 goal/action/result、explicit feedback、weak signals、counterexamples、最终处置与
verification。新事件产生 content-addressed revision，不覆盖 raw event。

`LearningCandidate` 类型固定为 `preference`、`environment_fact`、`strategy`、`workflow`、`boundary`、
`anti_pattern`；包含 statement、scope、owner/proposer、evidence、counterexamples、TV、confidence、
fact status、retention 与 lifecycle。状态机为：

```text
proposed -> evaluated -> shadow -> approved -> promoted
       \-> needs-review / rejected / expired / tombstoned
```

- 单样本、仅弱信号、未知结果或 unresolved counterexample 不得进入 approved/promoted。
- 默认 `minimum_distinct_episodes = 2`；TV 必须绑定 rubric version、assessor 与 evidence refs。
- candidate 内容不能自带 exam 或批准结果；evaluation 与 approval receipt 是独立 hash artifact。
- shadow 是所有 candidate 的必经状态。promotion 必须引用绑定当前 candidate hash 的显式
  `user.approval` event 和 approval receipt，并留下 publisher/authority ref。
- P0 的 `promoted` 只表示“允许被后续 resolver 读取”；不会自动改 skill、rules、共享 runtime 或团队资产。
- 本地 authority ref 是可审计协议身份，不是操作系统/密码学认证；强认证仍是已知未实现边界。

### 现有演进链路收口

- `/evolve`、`/learn`、`/compound`、`/session-summary` 与 `/skill improve` 的行为学习输出只能
  `propose` candidate；`--auto` 最多自动完成 proposal/evaluation/shadow，不能写 skill/command/rules。
- `/skill eval` 结果绑定 skill/candidate hash、baseline hash、case-set hash 与 evaluator；无 baseline、
  stale identity、坏行或 hash mismatch 一律阻断。
- `/skill publish` 与 `/evolve` 共用 candidate/evaluation/approval gate；实际 runtime publish 仍需原有
  人工 go gate，P0 不触发安装或共享写入。
- `evaluate-session` 不再把新行为直接写成可注入 instinct；新学习走 candidate。legacy instinct 仅保留
  兼容读取并明确标记 legacy，不作为新 SSOT。
- 后续 Agent 通过 `inspect/context` 读取 promoted 条目；shadow 仅作为显式建议展示，不自动注入。

### 配置、保留与基线

`user-level/homunculus/config.json` 新增 `self_learning`：默认 mode=`shadow`、promotion=`manual`、
minimum episodes、TV 阈值、retention days、reader/writer kill switch。原始 payload 写前递归脱敏；
事件仅持久化必要摘要与脱敏后 digest。

`metrics` 至少报告任务验证率、纠正率、重试率、无效调用率、unknown outcome、显式/弱信号比例、
candidate 状态和 source coverage。工具调用数只报告 usage；缺少 outcome denominator 时质量显示
`unknown`，不能用“调用多/零调用”判健康或成功。

### Work 分解与依赖

1. **T1 — Authority core（串行前置）**：schema、canonical hash、strict journal、锁、幂等、冲突、
   corruption、tombstone、projection 与安全测试。
2. **T2 — Behavior plane（依赖 T1，可并行）**：EvidenceRef/Event/Episode、Claude 双写、Codex 显式/
   lifecycle/managed adapter、最终处置、基线指标与 adapter 负向测试。
3. **T3 — Learning plane（依赖 T1，可并行）**：Candidate/TV/counterexample/lifecycle、shadow-first、
   approval receipt、人工 promotion 与治理测试。
4. **T4 — Eval/evolution gate（可与 T2/T3 并行）**：skill eval identity/fail-closed；收口
   `/evolve`、`/skill` 和其他直接写入口；保留 legacy 兼容边界。
5. **T5 — Entry/projection（依赖 T2/T3）**：CLI、MCP、command、config、builder/validator、全部 schema
   和 runtime projection byte parity。
6. **T6 — Integrated verification**：corruption、concurrency、redaction、path escape、authority、
   lifecycle、tombstone、baseline、build idempotency、全量 tests/validate/diff-check。

### P0-01～P0-35 覆盖矩阵

| P0 | 验收落点 |
|---|---|
| 01 Codex capture | 原生 UserPromptSubmit/PreToolUse/PostToolUse/Stop receipt + strict control envelope + managed lifecycle/envelope；缺失官方 identity 保持负向断言 |
| 02 unified event | `BehaviorEvent` schema/normalizer |
| 03 Episode | task-bound `BehaviorEpisode` builder |
| 04 goal/action/result | Episode 分类与完整性校验 |
| 05 explicit feedback | `user.feedback/user.approval` + explicit strength |
| 06 implicit weak | weak/inferred 独立集合且不可单独 promotion |
| 07 final disposition | task outcome/disposition/verification，缺失为 unknown |
| 08 EvidenceRef | content-bound typed reference schema |
| 09 immutable identity | source id、entity hash、record hash、chain hash |
| 10 scope | session/task/project/global/team + scope id |
| 11 asset taxonomy | 六类 candidate enum |
| 12 LearningCandidate | candidate schema、projection 与 CLI |
| 13 lifecycle | proposed→evaluated→shadow→approved→promoted + terminal states |
| 14 counterexamples | typed refs、review flag、unresolved block |
| 15 TV | truth/value rubric artifact 与阈值 gate |
| 16 sample minimum | 默认两个不同 Episode；单样本负向测试 |
| 17 evidence != truth | evidence assurance 与 fact status 分离 |
| 18 fact/inference/unknown | event/evidence/candidate/episode 全链传播 |
| 19 redaction | 持久化前 recursive redaction + digest 测试 |
| 20 retention/delete | expiry transition + hash-bound tombstone；不虚假宣称物理 purge |
| 21 append-only raw | immutable sequence journal records |
| 22 idempotency/dedupe | same ID/hash no-op，same ID/different hash block |
| 23 schemas/migrations | `schemas/self-learning` v1；legacy-unverified adapter，无自动升级 |
| 24 authority separation | collector/proposer/evaluator/publisher 独立 artifact/role |
| 25 hash identity | candidate/baseline/case-set/eval/approval 全部 hash-bound |
| 26 fail-closed | strict reader、lock、gate 与 CLI 非零退出 |
| 27 malformed block | middle/tail/truncation/unknown/extra field fixtures |
| 28 shadow-first | mandatory shadow transition，默认 mode=shadow |
| 29 human promotion | explicit user approval event + receipt + publisher audit |
| 30 unify evolve/skill | 共同 candidate/eval/approval/publish protocol |
| 31 inspect | list/show/context/verify-store，显示 provenance/TV/counterexample/status |
| 32 correct/delete | reject/expire/tombstone/scope-supersede governance transition |
| 33 baseline metrics | outcome/correction/retry/invalid-call/source coverage |
| 34 calls != quality | usage 与 outcome metrics 分栏；无 denominator=`unknown` |
| 35 writer/reader SSOT | 全入口调用同一 store；projection 可重建且非权威 |

### 验证矩阵

- 新增 `test-self-learning-store.js`、`test-self-learning-concurrency.js`、
  `test-self-learning-schema.js`、`test-behavior-events.js`、`test-behavior-episodes.js`、
  `test-learning-candidates.js`、`test-self-learning-authority.js`、`test-self-learning-redaction.js`、
  `test-self-learning-tombstone.js`、`test-self-learning-runtime-adapters.js`、
  `test-self-learning-projection.js`。
- 修改 skill eval、hook、native runtime、MCP manifest、plugin builder/validator 现有测试。
- 定向测试通过后运行 `npm test`、plugin build twice、validator、`git diff --check`。
- standalone Codex payload 与 installed-cache E2E 如当前 harness 仍不可访问，单独报告为环境未知，
  不把 source/plugin projection 证明冒充 installed runtime 证明。

## 完成证据（2026-08-21）

- 全量 `npm test`：86/86 test files passed，0 failed。
- `test-model-canary.js`：41/41；`test-skill-publish-guard.js`：30/30。
- 最终 P0 回归：case source 在 evaluation authority 读取后被 tombstone，candidate revision 保持不变，
  `candidate_evaluation` 追加数为 0；调用方无法覆盖 authority journal CAS。
- plugin builder 连续运行两次；projection、validator、source/generated byte parity 全部通过。
- 两名独立 reviewer 在最终冻结树上均未发现可复现 P0。
- 未安装、未提交、未推送、未写外部或团队 runtime；用户原始方法论文档未修改。
