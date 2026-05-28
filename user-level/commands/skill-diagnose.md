---
description: "[alias → /skill diagnose] 诊断 skill 健康状况：使用信号分析、步骤热力图、纠正模式、本能差异、progressive disclosure"
---

# /skill-diagnose — Skill 健康诊断

读取 `~/.claude/homunculus/skill-signals/{name}.jsonl`，分析 skill 的使用情况。

## 用法
- `/skill-diagnose` — 诊断所有 skill
- `/skill-diagnose prototype` — 诊断指定 skill

## 输出格式
```
## Skill 诊断: /{name}

使用统计 (最近 30 天):
  调用: N 次 | 完成率: X% | 平均耗时: Xmin

步骤热力图:
  | 步骤 | 执行率 | 跳过率 | 修改率 |
  标记 跳过率>30% 和 修改率>20% 的步骤

用户纠正模式:
  - N次: "具体纠正内容" → 建议 skill 如何调整

本能差异:
  - N 个新本能与此 skill 相关但未吸收
  - N 个本能与 skill 当前指令矛盾

Progressive disclosure 检查:
  - description trigger 清晰度: [清晰 / 模糊 / 误触发风险]
    (检查 frontmatter description 是否包含具体 trigger 词；模糊 description 导致 agent 难判断何时加载 skill，引发误触发或漏触发)
  - SKILL.md 行数: N 行 [<100 健康 / 100-200 警告 / >200 需拆分]
  - 应否拆 reference: [是 / 否]
    (>100 行且含多个领域协议、或长协议/低频高级用法挤占主入口时建议拆 REFERENCE.md / EXAMPLES.md)
  - 应否脚本化: [是 / 否]
    (同一 deterministic 操作反复由 LLM 生成 → 沉到 scripts/ 减少 token + 提高确定性)

诊断结论:
  🟢 健康 | 🟡 建议迭代 | 🔴 需要重构
  具体改进建议列表
```

## 失败 trace 提取（B1 trace-aware，半自动）

诊断时若发现该 skill 有失败/被纠正的真实执行，**半自动**沉淀为结构化 trace 供 `/skill improve` 根因反思：

1. 读 `~/.claude/homunculus/projects/{hash}/observations.jsonl`（已双层脱敏）中 `tool:"Skill"` 且 `error_signal` / `status` 异常、或后续被用户纠正的条目。
2. 提炼 failure_step（哪一步崩）/ error_excerpt（错误片段）/ correction_diff（用户怎么纠正）/ input_excerpt（触发输入）。
3. **人工确认 gate** 后写入（CLI 内部再过一道脱敏，纵深防御）：
   ```bash
   node scripts/skill-traces.js record --name <skill> \
     --failure-step "<哪步>" --error-excerpt "<错误>" --correction-diff "<纠正>" --input-excerpt "<输入>"
   ```
   追加到 `~/.claude/homunculus/skill-traces/{name}.jsonl`。

> trace 入口是半自动（LLM 提取 + 人工确认），不靠 hook 自动检测——skill 成败是语义判断，无 exit code。

4. （可选，B2）若该条 trace 值得固化为 eval 测试，人工确认后转结构化 case（最有价值的测试 = 真实失败）：
   ```bash
   node scripts/skill-eval-cases.js add --name <skill> \
     --input "<触发输入>" --expectation "<期望>" --from-trace '<trace JSON 快照>'
   ```
   追加到 `skill-evals/{name}/cases/cases.jsonl`，供 `/skill eval` 消费。case 强制带 `provenance=trace` + trace 快照（护城河：不接受 skill 自产）。

## 触发时机
- 手动执行
- `/retrospective` 时自动附带
- 某 skill 放弃率 > 30% 时 `/compound` 提示
