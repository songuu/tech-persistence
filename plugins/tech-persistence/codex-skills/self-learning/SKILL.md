---
name: self-learning
description: Codex-compatible entry point for the former /self-learning command. 用户行为驱动的可信自学习入口：采集、Episode、Candidate、TV、shadow 与人工治理
---

# Self Learning

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/self-learning` command.

## Invocation

Use `$self-learning <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/self-learning`, interpret that as this `$self-learning` skill invocation while running in Codex.

## Command Instructions

# /self-learning — 用户行为自学习

使用 canonical self-learning service 操作同一份严格、append-only self-learning journal。插件运行时优先
调用 `tp_learning_*` MCP；`scripts/self-learning.js` 仅用于源码仓库或管理员诊断。这个入口学习
用户的显式反馈、纠正、操作结果和已验证工作流，用于优化后续 Agent；它不会从单次调用量推断质量，
也不会自动修改 skill、rules 或共享 runtime。

## Runtime 覆盖边界

- Codex：现有 prompt/tool/Stop hook 可经 adapter 记录 BehaviorEvent、关闭 Episode。
- Codex standalone：使用本命令或 `tp_learning_*` MCP 显式记录；不得声称存在 PostToolUse/Stop Hook。
- managed agent-loop：task/result/acceptance envelope hash 可作为 verified EvidenceRef；系统 acceptance 不等于
  用户 approval。
- 缺稳定 source event id、task identity 或最终验证时，保留 `unassigned`、`unknown` 或 `needs-review`，
  不用时间戳伪造幂等身份。

## MCP（插件运行时首选）

- `tp_learning_record`：只记录 MCP 侧 weak/observed/unknown 的 agent BehaviorEvent；不能铸造 user、verified
  或 EvidenceRef authority。
- `tp_learning_close`：关闭并固化 BehaviorEpisode。
- `tp_learning_propose`：创建或证据增强 LearningCandidate。
- `tp_learning_inspect`：只读检查 journal、projection 与 metrics。
- `tp_learning_govern`：MCP 可执行 candidate artifact-stage、读取本地可信 evaluation artifact 后 evaluate、
  shadow、派生 result-record 与只读 publish-guard；approve、promote、govern、retention 仅允许可信本地
  管理员入口。

这些工具由插件自身解析，不依赖当前业务仓库存在 `scripts/` 目录。

## CLI（源码仓库 / 管理员回退）

仅在 tech-persistence 源码仓库根目录运行。所有 CLI 操作显式指定 homunculus 与稳定 project id；JSON
从文件或 stdin 读取，避免把敏感内容放在参数中：

```bash
node scripts/self-learning.js record --base-dir <homunculus> --project-id <id> --input event.json
node scripts/self-learning.js evidence --base-dir <homunculus> --project-id <id> --input evidence.json
node scripts/self-learning.js close --base-dir <homunculus> --project-id <id> --input episode-close.json
node scripts/self-learning.js propose --base-dir <homunculus> --project-id <id> --input candidate.json
node scripts/self-learning.js evaluate <candidate-id> --base-dir <homunculus> --project-id <id> --input evaluation.json
node scripts/self-learning.js shadow <candidate-id> --base-dir <homunculus> --project-id <id> --input transition.json
node scripts/self-learning.js approve <candidate-id> --base-dir <homunculus> --project-id <id> --input approval.json
node scripts/self-learning.js promote <candidate-id> --base-dir <homunculus> --project-id <id> --input promotion.json
node scripts/self-learning.js inspect --base-dir <homunculus> --project-id <id>
node scripts/self-learning.js metrics --base-dir <homunculus> --project-id <id>
node scripts/self-learning.js govern <candidate-id> --base-dir <homunculus> --project-id <id> --input governance.json
node scripts/self-learning.js retention --base-dir <homunculus> --project-id <id> --input retention.json
node scripts/self-learning.js verify-store --base-dir <homunculus> --project-id <id>
```

## 生命周期与门禁

```text
BehaviorEvent -> BehaviorEpisode -> EvidenceRef -> LearningCandidate
proposed -> evaluated -> shadow -> approved -> promoted
```

通用 CLI/MCP `record` 只能写弱 Agent observation，不能创建用户 authority。Codex 用户需要在真实
`UserPromptSubmit` 中发送固定前缀和逐字 canonical JSON；整条消息不得包含额外空白或换行：

```text
TP_SELF_LEARNING_CONTROL_V1:{"accepted":true,"action":"approve","candidate_hash":"sha256:<64 lowercase hex>","candidate_id":"lc-<32 lowercase hex>"}
TP_SELF_LEARNING_CONTROL_V1:{"accepted":true,"action":"feedback","summary":"Prefer the focused test."}
TP_SELF_LEARNING_CONTROL_V1:{"action":"correct","summary":"Run the validator before reporting completion."}
```

Approval 只有在 `candidate_id + candidate_hash` 精确命中当前 project 的 live `shadow` revision 时才会
落为 `user.approval`；无效 envelope fail closed。普通自然语言 prompt 仍只是 `user.prompt`，不会被推断
成反馈、纠正或批准。

- Candidate 类型只有 preference、environment_fact、strategy、workflow、boundary、anti_pattern。
- Candidate target 必须是 exact `{key,source_path,source_hash}`；`source_path` 是无遍历的仓库相对路径，
  `source_hash` 绑定提案所依据的当前源文件。skill/command target 还受固定 source allowlist 与发布时真实
  文件 readback 约束。
- 默认至少两个不同 Episode；仅弱信号、unknown outcome、unresolved counterexample 或 TV 未达阈值均不能批准。
- proposer 与 evaluator 必须独立；evaluation 绑定 rubric、candidate/evidence/evaluator hash。
- shadow 是必经状态，只显示建议，不自动注入。
- approval 必须先把显式 `user.approval` BehaviorEvent 写入同一 journal，并精确绑定当前
  `candidate_id + candidate_hash`；permission mode、自然语言里的 `approved_by` 或系统 acceptance 不能替代。
- promoted 仅表示允许后续 reader 读取，`runtime_written=false`；实际 skill/rule publish 仍需各自 eval、
  approval receipt、人工 `go`、readback 与 rollback gate。

## 查看与治理

`inspect/context` 必须显示 scope、owner、EvidenceRef、fact/inference/unknown、TV、confidence、反例和状态。
`context` 的 `automatic_context` 只包含 `promoted`；`shadow_suggestions` 始终单列，禁止自动注入。
用户可以 reject、expire、scope-correct 或 tombstone。`delete` 在 P0 中是 hash-bound tombstone：active
projection 不再暴露目标，但原 journal record 仍保留以供审计；不得把它描述为物理擦除。真正 purge
需要另一个覆盖 journal、备份、恢复证据和索引的显式协议。

`config.json` 的 `self_learning` 是 strict config：只允许 `enabled`、`mode`、`writer_enabled`、
`reader_enabled`、`promotion`、三个 minimum 阈值、`retention_days`、`legacy_inputs`、
`legacy_writer_enabled`、`legacy_reader_enabled`。未知字段、非法类型/范围、非 manual promotion 均 fail closed。

- `enabled`、`writer_enabled`、`reader_enabled` 和 `mode=off` 控制新 authority 链；writer 关闭时 CLI/MCP
  与自动入口不得追加，reader 关闭时不得返回自动上下文。
- `legacy_writer_enabled` 独立控制 observation 双写；`legacy_reader_enabled` 独立控制 prompt recall 与
  SessionStart 的旧 Memory/session/instinct。关闭只停用路径，不删除历史数据。
- `legacy_inputs=needs-review` 要求旧证据保持 `legacy_unverified + weak + unknown`；`off` 禁止其进入 proposal。
- `inspect`/`verify-store` 在 reader kill switch 下仍可诊断；`verify-store` 同时验证 hash chain 与
  Event/Evidence/Episode/Candidate domain identity，不能只校验 JSON/hash 外壳。

`propose` 由 service 注入配置阈值快照；candidate 输入只能提高，不能降低 minimum episodes/truth/value。
`context` 只返回 scope ID 精确匹配当前 project/session/task/personal/global/team identity 且尚未到期的条目；
SessionStart 必须传当前 session 并二次过滤 status/scope/expiry。`retention` 未显式给天数时使用配置值，
为到期 Candidate 追加 audited `expired` transition；Event/Evidence/Episode 仍只追加 tombstone，不物理 purge。

## 指标解释

`metrics` 分开报告 usage 与 quality。工具调用量只说明使用；任务验证率、纠正率、重试率和无效调用率
才是 outcome 指标。分母为 0 时返回 `status=unknown, value=null`，不得解释成健康、成功或无问题。
