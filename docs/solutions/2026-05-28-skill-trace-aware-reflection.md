---
title: "B1 trace-aware 反思：skill 失败/纠正 trace 结构化捕获（半自动 + 双层脱敏）"
date: 2026-05-28
tags: [solution, self-evolution, skill-evolution, trace, gepa, privacy]
related_instincts:
  - documented-claim-vs-code-reality-drift
  - reuse-existing-infra-before-building-new
  - semantic-signal-needs-llm-judgement-not-hook
related_solutions:
  - "[[2026-05-28-skill-publish-baseline-guard]]"
  - "[[2026-05-28-two-layer-architecture-enhancement]]"
  - "[[2026-05-27-claude-mem-followups]]"
aliases: ["skill-traces", "B1 trace 反思", "trace-aware-reflection"]
status: completed
---

# B1 trace-aware 反思

## Problem

`docs/plans/2026-05-28-two-layer-architecture-enhancement.md` §B1（GEPA reflective mutation 内核）要 `/skill improve` 基于真实失败 trace 做根因反思，而非把失败塌缩成"跳过率"标量。设计文档假设"扩展现有 signal jsonl 的 steps_skipped/corrections/duration 字段"。同时 B2（trace→eval）依赖此数据。

## Root Cause

勘察（[[ADR-012]]）推翻设计假设：

1. **signal schema 是 doc drift**：`aggregateSkillSignals` record 只有 `{skill, calls, source}`，diagnose/improve.md 描述的完成率/热力图/纠正模式全是 [[documented-claim-vs-code-reality-drift]]。
2. **语义信号无法 hook 自动派生**：skill 一次执行"成功/失败/被纠正"是语义判断，无 exit code，PostToolUse hook 看不到。
3. **ROI 依赖倒置**：设计文档把 B1 排在 B2 之后（#4 vs #2），但 B2 的数据源正是 B1 的产物。

## Solution

5 task（按数据依赖在 B2 之前实施）：

1. **`scripts/lib/skill-traces.js`**：`recordTrace`（内部对所有字符串字段 `stripPrivateTags` 脱敏）/ `readTraces`；独立 `{baseDir}/skill-traces/{name}.jsonl`；复用 `SKILL_NAME_RE` 路径逃逸防御。
2. **`scripts/skill-traces.js`** CLI：`record` + `list`；usage 错 exit 2；不 crash。
3. **文档**：`skill-diagnose.md` 加"从 observations 半自动提取失败 trace → 人工 gate → record"；`skill-improve.md` 加"读 trace 根因反思（GEPA 内核）"；`skill.md` 子动作同步。
4. **双 runtime 同步**：`copyUtilityScripts` 加 CLI（lib 经 `copyHookLibs` glob 自动）；install.sh/ps1 加 `skill-traces` 目录；propagate 3 命令；build + validate + pre-commit；CLI + lib 双副本 sha256 一致。
5. **文档同步**：设计文档 B1 标 implemented、[[ADR-017]]、README、本 solution + index。

测试：`test-skill-traces.js`（7，含脱敏负样本）+ `test-skill-traces-cli.js`（7，含进程边界脱敏 + 逃逸 + usage）。全量 run-tests 16/16。

## Key Insight

**确定性化的边界**：给 LLM-only 子系统加数据捕获时，先问"这个信号是确定性可派生，还是语义判断"。确定性（工具调用 + error_signal）→ hook 自动派生（observe 已做）；语义（skill 成败/纠正）→ "LLM 判断 + 人工 gate + CLI 结构化 record"，不堆 hook。这是 [[ADR-016]]（确定性环节下沉 enforcement）的互补面，合为 [[ADR-017]]。

## Prevention

- 设计文档写"扩展现有 X 字段"时，先 grep 确认 X 真的存在（本次 signal schema 是 doc drift）。
- trace/捕获类功能含真实输入 → 双层脱敏（数据源已脱敏 + 写入再过一道），隐私纵深防御不可省。
- 新数据存储与既有聚合逻辑隔离（独立目录），避免文件名过滤巧合带来的耦合。

## Related
- [[2026-05-28-two-layer-architecture-enhancement]] — B1 设计来源
- [[2026-05-28-skill-publish-baseline-guard]] — B3（同期，B2 依赖链）
- [[ADR-017]] — 语义信号捕获方式
- [[ADR-016]] — skill 链 deterministic 化（互补面）
