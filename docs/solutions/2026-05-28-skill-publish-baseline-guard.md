---
title: "B3 基线护栏下沉：skill publish 退化发布确定性拒绝（含 eval-result 结构化格式）"
date: 2026-05-28
tags: [solution, enforcement, self-evolution, skill-evolution, mechanism-over-discipline]
related_instincts:
  - mechanism-over-discipline
  - enforcement-entry-by-commit-boundary
  - reuse-existing-infra-before-building-new
related_solutions:
  - "[[2026-05-12-pre-commit-defense]]"
  - "[[2026-05-28-two-layer-architecture-enhancement]]"
aliases: ["skill-publish-guard", "B3 基线护栏", "eval-result 结构化"]
status: completed
---

# B3 基线护栏下沉

## Problem

`docs/plans/2026-05-28-two-layer-architecture-enhancement.md` §B3 提议把 skill-publish 的"eval 通过率 ≥ 当前版本才能发布"从文档协议下沉为确定性 enforcement（[[ADR-013]] mechanism-over-discipline 活案例）。设计文档假设"复用 `scripts/pre-commit-check.js` 模式纯加一个检查函数"。

## Root Cause

实施勘察（[[ADR-012]]）推翻设计文档两个核心假设：

1. **enforcement 入口选错**：`pre-commit-check.js` 由 `git diff --cached` 驱动，只能守护"会进 git commit 的改动"。但 `/skill publish` 改的是 runtime 目录 `~/.claude/homunculus/skill-evals/{name}/`，**不产生 git commit**，永远不在 staged files——pre-commit 入口对 publish 动作结构性失效。
2. **无结构化基线**：`/skill` 明示整条进化链"无 deterministic backing code"，eval 结果只是 LLM 产出的 markdown 表格，无结构化格式，护栏无可读基线。

## Solution

完整自包含 6 task：

1. **`scripts/lib/skill-eval-results.js`**（纯函数 lib）：`recordResult` / `readResults` / `readLatestTwo` / `checkRegression(tolerance)`，append-only `results.jsonl`，路径 `{baseDir}/skill-evals/{name}/results/results.jsonl`。沿用 skill-signals 的 `SKILL_NAME_RE` 路径逃逸防御；边界校验 version（正整数）+ pass_rate（0..1）；损坏行 skip + stderr marker 不抛。
2. **`scripts/skill-eval-results.js`**（CLI）：`record` + `guard` 子命令合并（YAGNI，避免两个顶层脚本）。guard 是 validator：退化 `exit 2` + 派生具体修复命令；无基线 `exit 0` 放行；内部异常 fail-open `exit 0` + `[skill-guard] fail-open:` marker；usage 错 `exit 2`。
3. **文档**：`skill-eval.md` 加 record 步骤；`skill-publish.md` 步骤 0 强制 guard；`skill.md` eval/publish/auto 子动作同步。
4. **测试**：`test-skill-eval-results.js`（9）+ `test-skill-publish-guard.js`（10，spawnSync 端到端覆盖 [[ADR-013]]§B 四类：pass / 退化 exit2 / 无基线放行 / fail-open marker）。smoke 合并入端到端 test 避免重复。
5. **双 runtime 同步**：`copyUtilityScripts` 加 CLI（lib 经 `copyHookLibs` glob 自动复制）；propagate 3 命令文档；build + validate + pre-commit 全绿；CLI 双副本 sha256 一致。
6. **文档同步**：设计文档 B3 标 implemented、[[ADR-016]]、README 知识层 + 目录结构、本 solution。

## Key Insight

**enforcement 入口选址原则**：先问"被守护的动作是否产生 git commit"。产生 → pre-commit；runtime-only 副作用（写 `~/.claude/...`）→ 必须在产生副作用的动作流程内拦截，否则 enforcement 形同虚设。这条原则升级为 [[ADR-016]]。

## Prevention

- 下沉 enforcement 提案前，先验证"被守护动作的副作用落在哪"（git tree vs runtime dir），别默认 pre-commit 能守一切。
- 给 LLM-only 子系统加 deterministic gate 时，先确认它依赖的数据有没有结构化格式；没有就得先补格式（本次 eval-result 即前置缺口）。
- 无基线放行是 enforcement 零误拒启动的关键（当前 skill-evals 全空）。

## Related
- [[2026-05-28-two-layer-architecture-enhancement]] — B3 设计来源
- [[ADR-016]] — 本 sprint 升级的架构决策
- [[ADR-013]] — mechanism over discipline（框架）
- [[2026-05-12-pre-commit-defense]] — pre-commit enforcement 模式来源
