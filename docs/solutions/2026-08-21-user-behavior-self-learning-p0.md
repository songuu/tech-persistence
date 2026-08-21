---
title: "用户行为驱动 Agent 自学习框架 P0：可信证据、候选生命周期与发布门禁"
date: "2026-08-21"
tags: [solution, self-learning, behavior-event, learning-candidate, authority, skill-evolution]
related_solutions:
  - "[[2026-08-20-mattpocock-skills-cse-self-evolution-eval]]"
aliases: ["agent self learning p0", "user behavior learning architecture", "governed skill evolution"]
status: completed
sources:
  - "docs/plans/2026-08-20-user-behavior-self-learning-p0.md"
  - "docs/Cognitive_Skill_Engine_Methodology_v2.2.md"
  - "https://github.com/mattpocock/skills at 885e2ca4d842d139e9aef4e48d366c63cb1b8013"
  - "https://developers.openai.com/codex/hooks"
  - "https://code.claude.com/docs/en/hooks"
---

# 用户行为驱动 Agent 自学习框架 P0

## Problem

目标不是让 Agent 把每次用户输入直接记成永久规则，而是建立一个可审计的学习闭环：观察用户行为、
操作、纠正、批准和任务结果，形成候选经验；只有经过证据、反例、评测、shadow 和人工批准的内容，
才允许影响后续 Agent 执行。

原架构存在四类根本风险：

1. legacy observation、Memory、instinct、Skill trace 各有独立写路径，调用次数、工具成功和用户同意容易
   被混为同一种“学习事实”；
2. 事件、候选、考卷、评估、批准和发布没有统一 identity/authority，调用方可以自报时间、actor、
   case result 或 approval；
3. 读时验证与写时提交之间存在并发撤销窗口，已被 tombstone 的证据仍可能推进 candidate；
4. Codex/Claude/CLI/MCP/plugin projection 之间缺少单一实现和 fail-closed 一致性证明。

## Root Cause

问题不在于缺少更多 prompt，而在于缺少一个可信的状态与权限模型：

- raw telemetry 既承担“发生过什么”，又被误用为“以后应该怎么做”；
- provenance 只是可填写字段，不是 journal 中可重验的 immutable reference；
- candidate、evaluation、approval 和 publish guard 没有绑定同一 project、revision、hash 与 scope；
- 自然语言被当作控制指令，普通 prompt 可能被解释成 durable memory consent；
- 多 runtime 复制文件，但没有证明所有入口调用同一 writer/reader 和相同负向契约。

## Solution

### 1. P0 控制流

```text
official runtime event / managed envelope / explicit control
  -> BehaviorEvent (redacted, content-bound, append-only)
  -> BehaviorEpisode (task-bound, outcome-aware, unknown-preserving)
  -> EvidenceRef
  -> LearningCandidate proposed
  -> authoritative evaluation
  -> shadow
  -> explicit user approval + receipt
  -> promoted resolver eligibility
  -> skill publish guard + original human go gate
```

`promoted` 只代表 resolver 可以读取，不等于自动改 Skill、rule、Memory、共享 runtime 或团队资产。

### 2. Canonical authority journal

`scripts/lib/self-learning-store.js` 是唯一权威写入层。每条记录包含 sequence、record/entity identity、
actor、occurred_at、payload hash、previous hash 和 record hash；reader 在使用前验证 schema、exact shape、
序列、链、文件名、hash、tombstone 和 domain payload。

写入采用锁内完整重读、revision/head CAS、临时文件、fsync、rename 和 readback：

- 同 record ID、同完整语义是幂等 no-op；
- 同 ID、不同语义是冲突；
- malformed/truncated/forked journal、损坏锁和未知字段 fail closed；
- 删除是绑定 target ID/hash 的逻辑 tombstone，不虚假声称物理擦除历史字节。

锁支持有界等待、dead-owner 恢复与 replacement identity 复核；真实并发用例覆盖不同事件和相同 receipt
重放。

### 3. BehaviorEvent、EvidenceRef 与 BehaviorEpisode

`BehaviorEvent` 统一记录 project/session/task/turn/parent、actor、runtime/source assurance、scope、
event type、signal strength、fact status、status、final disposition、脱敏 details 及 input/output digest。

关键语义：

- 用户 prompt、显式反馈、纠正、批准与工具/任务结果是不同事件；
- 工具成功不等于任务成功，系统 acceptance 不等于用户批准；
- 弱信号与显式信号分开，未知 outcome 保持 unknown；
- 没有稳定 runtime identity 时不使用时间戳伪造幂等 source ID。

`BehaviorEpisode` 仅按显式 task identity 聚合，绑定有序 event ID/hash，区分 goal/action/result、显式反馈、
弱信号、反例、最终处置和 verification。新增事件产生 content-addressed revision，不覆盖旧 Episode。

### 4. Runtime capture 与显式控制

Codex 0.147.0 使用 release contract 中的 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`；
Claude 使用官方 UserPromptSubmit/PreToolUse/PostToolUse/Stop payload。所有入口都执行 bounded stdin、
project/session identity preflight、code-only diagnostic 与 fail-open host behavior；身份不一致时必须零 journal、
零 lifecycle artifact。

显式用户控制固定为：

```text
TP_SELF_LEARNING_CONTROL_V1:<canonical JSON>
```

JSON 必须 exact-shaped、逐字 canonical、无重复 key、整条 UTF-8 不超过 4096 bytes。普通自然语言不做
approval、feedback、correction 或 remember 推断。同一 native turn 的 receipt identity 不包含 semantic；
同 turn 内容/分类变化因此形成冲突，而不是铸造第二条用户 authority。

### 5. Durable memory 必须有专用同意

`tp_memory_save` 只接受与待保存正文逐字绑定的：

```json
{"action":"remember","body":"<bounded body>"}
```

Codex 事件必须包含相同 semantic digest；Claude 必须由原始 prompt digest 精确绑定完整 canonical control。
普通 prompt、feedback、correction、跨项目事件、伪造引用和 tombstoned confirmation 都不能授权 durable
Memory 写入。

### 6. LearningCandidate 生命周期

候选类型冻结为 `preference`、`environment_fact`、`strategy`、`workflow`、`boundary`、
`anti_pattern`。候选包含 statement、target、scope、owner/proposer、evidence、counterexamples、TV policy、
retention 和 content hash。

```text
proposed -> evaluated -> shadow -> approved -> promoted
       \-> needs-review / rejected / expired / tombstoned
```

门禁不变量：

- 默认至少两个不同、完整、verified 的 Episode；单样本、仅弱/推断信号、未知结果不能 promotion；
- candidate evidence 的自报 assurance 不作真，资格从当前 journal Event/Episode 重算；
- correction 必须通过绑定 candidate ID/hash 的 evidence relation 明确 supports/refutes；未解释或反驳关系阻断；
- proposer、evaluator、publisher 分离；generic CLI/MCP 的 actor、authority 和时间由服务端绑定；
- approval 只能来自可信 native user event，绑定 live shadow candidate 的当前 ID/hash 和 approval receipt；
- scope/expiry/tombstone 在每个 forward action 重新验证。

### 7. Evaluation case v2 与撤销原子性

旧的 caller-provided `--from-trace` 已删除。case v2 只接受 canonical `source_event_ref`，并从项目 journal
派生 source trace；add、list、stage、read 都重验：

- source event active、未 tombstone、同 project；
- journal actor 与 event actor 一致；
- 事件是可信 native user prompt；
- redacted input digest 与 case input 一致。

evaluation artifact 对 case IDs 做 exact coverage，结果 hash/count/pass rate 全由服务端派生；文件读取验证
UTF-8/LF、regular file、nlink=1、fd/path inode、mtime/ctime/size，并二次读取防止同 inode 同长度漂移。
进程内 brand 绑定 candidate、project、artifact hash，以及 authority journal 的 store/revision/head。

最关键的并发不变量是：brand 消费把该 revision/head 强制传入 candidate append；store 在同一 journal lock
内重读并 CAS。若 source event 在 read 与 consume 之间被 tombstone，evaluation 追加为 0、candidate revision
不变，调用方也不能用自报 store options 覆盖该 CAS。

### 8. Skill eval 与 publish guard

Skill/Command target 绑定 exact key、canonical source path、source hash 和 project scope。result v3 由 promoted
candidate、当前 evaluation、active approval receipt、真实 staged artifact 和当前 source 派生，调用方不能
提交 pass rate、case summary、hash、时间或 authority。

publish guard 重新验证：

- 前后两个不同 candidate/evaluation/receipt；
- target key/path 连续，current baseline 等于 previous artifact hash；
- 当前 repository source 实算 hash；
- candidate/receipt 未 tombstone、未过期、仍 promoted；
- scope 为当前 project；
- case/result aggregate 与 CandidateEvaluation 完全一致；
- legacy v1/v2 history、坏行、无基线、损坏或 drift 一律阻断。

guard 只产生 publish authorization；真实发布仍保留人工 `go`、事务投影和 readback。

### 9. Redaction、retention 与 kill switch

持久化前递归脱敏结构化字段和自由文本，覆盖 snake/kebab/dot/camel/uppercase secret assignments、
escaped JSON、Authorization Basic/Bearer 和 URI userinfo；actor identity 中出现敏感值直接拒绝。普通 prose
如 password policy、token count 不误伤。

`self_learning` 配置提供 enabled、reader/writer、mode、promotion、阈值、retention 和 legacy reader/writer
边界。artifact-stage/result-record、CLI/MCP/candidate/hook 都在 I/O 前检查 writer gate；关闭策略必须零写。
expired/tombstoned 条目不进入自动 context。

### 10. Single source 与 projection

canonical source 位于 root `scripts/`、`scripts/lib/`、`schemas/`、`user-level/`。builder 原子投影到
Claude plugin、Codex hooks/skills、MCP 和 utility runtime；validator 检查 inventory、byte parity、require
closure、hook registry 和 timeout 单位。最终连续构建两次且恢复目录为空。

## Prevention

以后任何“Agent 已自学习”声明必须同时证明以下不变量，缺一项只能标记 needs-review/unknown：

1. 原始事件来自受支持 runtime identity，且写前脱敏；
2. evidence、episode、candidate、evaluation、approval、publish 都有 immutable hash/ref；
3. 调用方不能自报 user authority、server time、case result 或 approval；
4. case/receipt/tombstone/expiry 在最终写入使用的同一 journal 状态上重验；
5. 单样本和弱信号不进入 promoted；counterexample 不被平均分掩盖；
6. shadow 不自动注入，promoted 不自动写共享 runtime；
7. kill switch 在任何文件 I/O 前生效；
8. source、projection、installed wrapper、validator 和 negative fixtures 使用同一协议；
9. 无基线、旧 schema、损坏行、身份漂移和环境未知都不能被解释为通过。

## 已验证事实

- `npm test`：86/86 test files passed，0 failed。
- `test-model-canary.js`：41/41；`test-skill-publish-guard.js`：30/30。
- candidate store 15/15、candidate 24/24、MCP 13/13、evaluation artifact 11/11、case v2 11/11。
- builder 连续两次成功；plugin validator、self-learning projection、Codex native projection 全部通过。
- 最终两名独立 reviewer 未发现可复现 P0；撤销竞态的确定性探针确认 evaluation 记录为 0。
- working-tree 与 cached diff check 在排除用户原始方法论文档后通过；该文档未被本轮修改。

## 推断

- 当前实现建立了可信的“学习基础设施”和受治理 Skill 演进入口；它尚未证明实际任务质量会随时间提升。
- 从 mattpocock/skills 借入的主要是 agent-facing document fitness、lifecycle、primary artifact/pointer 与
  discovery 一致性；从 CSE v2.2 借入的是 evidence/counterexample/TV/ratchet 的目标方向，经 TP 的权限、
  schema、shadow 和人工 gate 重新约束。

## 未知项与残余 P1

- 未在真实已安装缓存中进行长期 dogfood；本轮证据是 repo/plugin projection 和真实本地 Node 子进程。
- lifecycle evidence artifact 写入后、journal 前的进程崩溃恢复仍需专门协议；孤立 recovery claim 也需治理。
- `results.jsonl` 的完整 hash-chain/锁、publish guard 到真实 source write 的 lease/CAS 仍是后续强化项。
- Codex Stop nullable 字段、Claude PostToolUseFailure、全局/团队 resolver 和密码学/OS 强身份未在 P0 完成。
- tombstone 是逻辑删除，不是物理 purge；legacy reader/writer 仍作为显式标记的兼容层存在。
- Git/PR 自动蒸馏、dependency DAG、RuntimePatch 和团队分发属于 P1+，本轮未实现。

## 迁移边界

- active `cases.jsonl` 中旧 case v1/self-declared trace 会 fail closed；需先移出 active 文件，再只读归档。
- 同为 result schema v3 但缺少 project `scope` 的旧记录会 fail closed，不能继续授权 publish。
- 未经 provenance 验证的旧 observation/instinct 只作 legacy/needs-review，不自动升级为事实或 Candidate。

## Related

- 实施计划：`docs/plans/2026-08-20-user-behavior-self-learning-p0.md`。
- 实施前分析：[[2026-08-20-mattpocock-skills-cse-self-evolution-eval]]。
- Canonical CLI：`scripts/self-learning.js`。
- 核心模块：`scripts/lib/self-learning-store.js`、`behavior-events.js`、`behavior-episodes.js`、
  `learning-candidates.js`、`self-learning-service.js`、`self-learning-evaluation-artifacts.js`。
- 用户方法论输入：`docs/Cognitive_Skill_Engine_Methodology_v2.2.md`（本轮未修改）。
