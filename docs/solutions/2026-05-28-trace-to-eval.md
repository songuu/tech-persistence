---
title: "B2 trace → eval 自动沉淀：失败 trace 半自动转结构化 eval case（provenance gate 护城河 + 双层脱敏）"
date: 2026-05-28
tags: [solution, self-evolution, skill-evolution, trace, eval, privacy, moat]
related_instincts:
  - documented-claim-vs-code-reality-drift
  - reuse-existing-infra-before-building-new
  - semantic-signal-needs-llm-judgement-not-hook
related_solutions:
  - "[[2026-05-28-skill-trace-aware-reflection]]"
  - "[[2026-05-28-skill-publish-baseline-guard]]"
  - "[[2026-05-28-two-layer-architecture-enhancement]]"
aliases: ["trace-to-eval", "B2 trace 转 eval", "skill-eval-cases"]
status: completed
---

# B2 trace → eval 自动沉淀

## Problem

`docs/plans/2026-05-28-two-layer-architecture-enhancement.md` §B2 要从真实使用 trace 里「corrections 发生的真实输入」半自动转成 skill eval case（真实失败 = 最有价值的测试）。护城河目标：eval case 来自真实 trace 而非 skill 自产（避免"自己出题给自己考"）。设计文档假设数据源是「signal jsonl 里 corrections」，复用 `skill-evals/{name}/` 目录。

## Root Cause

勘察（[[ADR-012]]）推翻设计文档两个数据源假设：

1. **「从 signal jsonl」过时**：signal record（`scripts/lib/skill-signals.js`）只有 `{skill, calls, source, session_id, project}`，无 corrections / 真实输入。B1 已把 trace（含 `input_excerpt/correction_diff/...`）移到独立 `skill-traces/{name}.jsonl`——B2 的真实数据源是 **skill-traces，不是 signal jsonl**。
2. **eval case 无结构化格式**：`skill-evals/{name}/` 已被 B3 占用为 `results/results.jsonl`（通过率时间线），但 eval **case** 本身只是 skill-eval.md 描述的 LLM 非结构化用例，无 schema、无 provenance 隔离字段。这与 B3 当时「eval 结果无结构化格式得先补格式」是同一类前置缺口。

## Solution

新结构化 eval-case 格式 + CLI，与 B3 的 results/ 平级同构：

1. **`scripts/lib/skill-eval-cases.js`**（纯函数 lib）：
   - `addCase`：强制 gate——`provenance` 必须 `trace`（护城河）+ `source_trace` 必须是对象（快照不可复现的真实上下文）+ `input` 非空，否则抛。所有字符串字段（含嵌套 `source_trace.*`）写入前 `redactDeep`→`stripPrivateTags`（纵深防御，即使来源 skill-traces 已脱敏）。
   - `readCases`：损坏行 skip + stderr marker，不抛。
   - 路径 `{baseDir}/skill-evals/{name}/cases/cases.jsonl`，append-only；复用 `SKILL_NAME_RE` 防路径逃逸。
2. **`scripts/skill-eval-cases.js`**（CLI）：`add`（强制 `--from-trace` JSON 快照，缺则 `exit 2`）+ `list`；usage/边界错 `exit 2`；不 crash。
3. **文档**：`skill-eval.md` 加「从真实 trace 沉淀 case（护城河强化）」段；`skill-diagnose.md` trace 提取后追加可选转 case 步；`skill.md` eval 子动作补 trace-case 数据源。
4. **测试**：`test-skill-eval-cases.js`（9，含 provenance gate 拒绝 / 嵌套 source_trace 脱敏负样本 / 路径逃逸 / 损坏行）+ `test-skill-eval-cases-cli.js`（10，含进程边界脱敏 + moat gate exit 2 + usage exit 2）。全量 skill 测试 6 文件 52/52。
5. **双 runtime 同步**：`copyUtilityScripts` 加 `skill-eval-cases.js`（lib 经 `copyHookLibs` glob 自动）。install.* 的 `skill-evals` 目录已存在，`cases/` 子目录由 lib `mkdirSync recursive` 懒创建。

## Key Insight

**护城河靠确定性必填字段而非纪律**：B2 的隔离性（case 来自真实 trace 而非 skill 自产）不靠"模型记得别自产 case"，而靠 `addCase` 对 `provenance=trace` + `source_trace` 的**写入即拒绝** gate（[[ADR-013]] mechanism-over-discipline 的又一活案例）。同时印证 [[reuse-existing-infra-before-building-new]]：B2 输入是 B1 的 skill-traces，输出与 B3 的 results.jsonl 同构平级——三者（traces/cases/results）构成 skill-evals 下的完整数据三角，全部 append-only jsonl + 同一套防御（SKILL_NAME_RE / 损坏行 skip / 双层脱敏）。

## Prevention

- 设计文档写「从 X 数据源」时先 grep X 的真实 schema（B2 第三次踩 doc drift：signal jsonl 不含 corrections）。
- 含真实输入的派生数据（trace→case）必须双层脱敏，嵌套对象用递归 `redactDeep` 不能只处理顶层字符串。
- 护城河类隔离性优先做成确定性写入 gate（provenance 必填），而非文档约定。

## Related
- [[2026-05-28-two-layer-architecture-enhancement]] — B2 设计来源
- [[2026-05-28-skill-trace-aware-reflection]] — B1（数据源 skill-traces）
- [[2026-05-28-skill-publish-baseline-guard]] — B3（同构 results.jsonl + guard 模式）
- [[ADR-013]] — mechanism over discipline（provenance gate 框架）
- [[ADR-017]] — 语义信号 LLM + 人工 gate（eval 执行仍语义判断，本 sprint 只结构化 case 产物）
