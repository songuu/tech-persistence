---
description: "可信记忆治理：把会话知识转为 EvidenceRef 与 LearningCandidate，不直接写旧知识层"
---

# 记忆治理技能

## 触发场景

- 用户说“记住这个”“这是个经验”“下次注意”；
- `/learn`、`/review-learnings`、`/session-summary`、`/debug-journal` 产生可复用发现；
- 一个问题已有验证结果、反例或明确用户纠正。

## 唯一新写入链路

```text
来源事实/产物
  -> EvidenceRef (immutable digest + disposition + scope)
  -> LearningCandidate (fact/inference/unknown)
  -> TV + shadow
  -> explicit user approval
  -> promoted reader context
```

不得因本 skill 被触发而直接新增或更新：

- `memory/MEMORY.md` 或 topic Markdown；
- `instincts/*.md`；
- `.claude/rules/`、`.Codex/rules/`、AGENTS.md 或 CLAUDE.md；
- skill、command、agent 或共享 runtime。

历史 Memory/instinct 可在 `legacy_reader_enabled=true` 时读取并明确标记为兼容层，但不能被当成已验证事实或
新 authority。`legacy_writer_enabled=false` 时不得追加旧 observation；开关变化不删除历史数据。

## Evidence 质量门

1. 来源必须有稳定 identity、不可变 digest、captured_at、scope 和最终处置。
2. 用户原话/纠正标为 explicit；推断与弱信号不得伪装为事实。
3. 无 outcome、验证或 task identity 时保持 unknown / needs-review。
4. 写前递归脱敏；敏感或不可验证 payload 拒绝进入 journal。
5. 同一 source identity 重放必须幂等，内容漂移必须报 conflict。

## Candidate 决策

- 分类只允许 preference、environment_fact、strategy、workflow、boundary、anti_pattern。
- `scope` 必须精确到 session/task/project/personal/global/team 及对应 ID。
- 默认至少两个不同 Episode，并记录 counterexample。
- 自动流程最多 `propose -> evaluate -> shadow`；不能自行 approve/promote。
- 用户说“记住”授权提出候选，不自动等价于绑定 candidate hash 的 `user.approval`。

## 去重与治理

提出前用 `inspect` 检查相同 target/scope/statement；完全重复不重复写，新增证据走同一 Candidate 的
content-addressed revision。矛盾必须记录 counterexample 或提出替代 Candidate，不能静默覆盖。

用户可 reject、expire、scope-correct 或 tombstone。P0 的 delete 仅是可审计 tombstone，不宣称物理擦除。
`retention` 使用配置默认值并为到期 Candidate 追加 `expired` transition。
