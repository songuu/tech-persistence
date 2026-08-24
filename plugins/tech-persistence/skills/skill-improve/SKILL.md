---
description: "[alias → /skill improve] 基于诊断结果为 skill 生成修改提案：合并/精简/吸收本能/拆分"
---

# /skill-improve — Skill 改进提案

> **已合并到 `/skill improve <name>`**（行为完全一致，新代码请用 `/skill improve`）。本命令保留作 alias，向后兼容。

读取 `/skill-diagnose` 的诊断报告 + 信号文件 + 相关本能 + **失败 trace**，生成结构化修改提案，并将
所选提案通过 canonical self-learning writer 提交为 `LearningCandidate`。

## Self-learning candidate gate

- improve 只能执行 `propose`；通过独立 exam 后才可由 eval 执行 `evaluate`，随后进入 `shadow`。
- 提案选择、`--absorb`、高 confidence 或大量 trace 都不授权 `approve`、`promote` 或修改 skill。
- candidate 不能自带 exam、evaluation 或 approval；这些必须是绑定 `candidate_hash` 的独立 artifact。

## 失败 trace 根因反思（B1，GEPA 内核）

生成提案前先读该 skill 的结构化失败 trace：

```bash
node scripts/skill-traces.js list <name>   # 预览有多少条失败/纠正 trace
```

对每条 trace 做**根因反思**（不是把失败塌缩成"跳过率"标量，而是读 failure_step / error_excerpt / correction_diff 自然语言诊断"为什么失败"），把反思结论转为定向的 prompt 修改提案。trace 来自真实使用（`skill-traces/{name}.jsonl`），比同源自动生成的用例更有信号。

## 用法
- `/skill-improve prototype` — 为指定 skill 生成改进提案
- `/skill-improve --absorb` — 将待吸收 legacy 本能作为 evidence，生成对应 skill candidate；不直接合入

## 提案类型
1. **合并步骤**：跳过率 > 30% 的步骤合并到相邻步骤
2. **降级为可选**：使用率 < 25% 的步骤标记为可选
3. **吸收本能候选**：把 `pending_absorption` legacy marker 作为未验证线索，生成 evidence refs；不写 skill
4. **精简提问**：纠正 "太多了" 3+ 次 → 减少每轮问题数
5. **拆分 skill**：skill 过于庞大时拆为 2 个更聚焦的 skill

## 输出格式
```
修改提案: /{name} v{N} → candidate preview

candidate_id: <stable-id>
candidate_hash: <content-hash>
status: proposed
target_skill_hash: <current-skill-hash>
scope: <project|personal>
owner: <identity>

提案 1: [标题] (数据依据: ...)
  变更: ...
  影响: ...

提案 2: ...

差异预览 (关键段落 diff):
  - 旧内容
  + 新内容

确认哪些提案进入 `propose`？(编号 或 'all'；这不是 approval/promotion)
```

## 确认后

- 生成修改后的 skill preview，但不写入 canonical skill、command、rules 或 runtime projection。
- 通过 `scripts/self-learning.js propose` 写入并读回 `candidate_id`、`candidate_hash`；失败时 fail closed。
- 建议执行 `/skill-eval {name} --diff --candidate <candidate_id>`，由独立 evaluator 绑定当前
  candidate/skill/baseline/case-set hash。
- eval 通过后也只进入 `shadow`；publish 另需 hash-bound approval receipt 和人工 `go`。
