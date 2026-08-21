---
description: "基于统一 authority journal 的可信持续学习：行为证据 → Episode → Candidate → TV/shadow → 人工 promotion"
version: "6.0"
---

# 持续自学习技能

本 skill 学习用户的显式反馈、纠正、操作结果和经验证工作流，用于优化后续 Agent。新知识的唯一写入链路是
`scripts/self-learning.js` / `tp_learning_*` 背后的 append-only journal；不得把观察直接写成 Memory、instinct、
rules、AGENTS.md、CLAUDE.md、skill 或 command。

## 权威链路

```text
BehaviorEvent
  -> BehaviorEpisode
  -> EvidenceRef
  -> LearningCandidate
  -> independent TV evaluation
  -> shadow
  -> explicit user.approval + receipt
  -> promoted (reader eligible; runtime_written=false)
```

- 单次工具调用只是 usage，不是质量或偏好证据。
- 至少两个不同 Episode；unknown outcome、仅弱信号、未解决反例或 TV 未达阈值不能前进。
- 自动流程最多到 `shadow`。`approve`、`promote` 和实际发布必须由独立人工 gate 完成。
- `promoted` 只允许受 scope 约束的 reader 使用，不会修改 runtime 文件。

## Runtime 采集

| Runtime 入口 | 可信行为 |
|---|---|
| Claude `UserPromptSubmit` | 有原生 source id、session id、occurred_at 时记录显式 prompt Event |
| Claude `PreToolUse` / `PostToolUse` | 有原生 tool use id 与时间时记录 request/result Event |
| Claude `Stop` | 从已记录 Event 关闭 Episode；不直接写 Memory/instinct |
| Codex standalone | 仅通过显式 CLI/MCP 或真实 lifecycle evidence；不虚构 Claude hook |
| managed agent-loop | task/result/acceptance envelope hash 可形成 verified EvidenceRef |

缺稳定身份、时间、task 或最终处置时必须 skip、unassigned、unknown 或 needs-review，不能用当前时间或文本
hash 伪造原生事件身份。

## Legacy 兼容边界

- `observations.jsonl`、历史 Memory 和 instinct 只作为明确标记的 legacy 兼容输入/读取层，不是新 SSOT。
- `legacy_writer_enabled` 控制 Claude observation 双写；关闭后不再追加，但不删除历史数据。
- `legacy_reader_enabled` 控制 prompt recall、SessionStart 的旧 Memory/session/instinct 读取；关闭后不读取但不删除。
- `legacy_inputs=needs-review` 只接受保持 `legacy_unverified + weak + unknown` 的旧证据；`off` 拒绝其进入
  Candidate proposal。

## 配置

`self_learning` 只接受以下字段；未知字段或非法类型必须 fail closed：

```json
{
  "enabled": true,
  "mode": "shadow",
  "writer_enabled": true,
  "reader_enabled": true,
  "promotion": "manual",
  "minimum_distinct_episodes": 2,
  "minimum_truth_score": 0.75,
  "minimum_value_score": 0.6,
  "retention_days": 90,
  "legacy_inputs": "needs-review",
  "legacy_writer_enabled": true,
  "legacy_reader_enabled": true
}
```

`enabled`、`writer_enabled`、`reader_enabled` 和 `mode=off` 控制新 authority 链；两个 legacy 开关独立控制
兼容路径。配置错误时新旧入口都 fail closed。

## Scope、读取与保留

- Reader 只返回 `promoted` 且 scope 精确匹配当前 project/session/task/personal/global/team identity 的 Candidate。
- SessionStart 必须传当前 session identity 并对 service 输出再次检查 status、scope 和 expiry。
- `retention` 缺省使用配置天数；到期 Candidate 追加可审计 `expired` transition。
- Event/Evidence/Episode 到期仅追加 hash-bound tombstone；P0 不物理擦除历史 journal。

## 操作规则

1. 先用 `record` / `close` / `evidence` 建立可读回的证据。
2. 用 `propose` 创建 Candidate；service 注入配置阈值快照，输入不能降低阈值。
3. 有独立 evaluator 和完整证据才可 `evaluate`；自动模式最多再进入 `shadow`。
4. 用 `inspect` / `metrics` 区分事实、推断、未知、反例与 outcome 指标。
5. 用 `govern` 执行 reject、expire、scope-correct 或 tombstone。
6. `verify-store` 必须同时验证 journal hash chain 与 Event/Evidence/Episode/Candidate domain identity。
