---
title: "B2 trace → eval 自动沉淀：失败 trace 半自动转结构化 eval case"
date: 2026-05-28
status: implemented
tags: [plan, self-evolution, skill-evolution, trace, eval, privacy, moat]
invariants:
  - "eval case 的真实输入字段写入前必须再过一道 stripPrivateTags（纵深防御，即使来源 skill-traces 已脱敏）"
  - "trace→eval 转换的每条 case 必须带 provenance=trace + source_trace 快照，护城河靠 provenance 字段确定性可查"
  - "cases.jsonl 与 results.jsonl 同构（append-only jsonl + SKILL_NAME_RE 路径逃逸防御 + 损坏行 skip + 边界校验），不引入 DB"
  - "skill 名只接受 /^[a-z][a-z0-9-]{0,63}$/，防路径逃逸到 skill-evals 外"
invariant_tests:
  - "scripts/test-skill-eval-cases.js: lib 级（脱敏负样本 / 路径逃逸 / 损坏行 / provenance 必填 / 边界校验）"
  - "scripts/test-skill-eval-cases-cli.js: CLI 端到端（进程边界脱敏 + provenance gate + usage exit 2）"
related_plans:
  - "[[2026-05-28-skill-trace-aware-reflection]]"
  - "[[2026-05-28-skill-publish-baseline-guard]]"
  - "[[2026-05-28-two-layer-architecture-enhancement]]"
---

# B2 trace → eval 自动沉淀

> 设计来源：`docs/plans/2026-05-28-two-layer-architecture-enhancement.md` §B2（第 99-106 行）。

## 关键假设验证表（ADR-012 强制勘察）

| 设计文档假设 | 验证文件 | 实际现状 | 可信度 |
|---|---|---|---|
| 「从 signal jsonl 里 corrections 真实输入转 case」 | `scripts/lib/skill-signals.js:55-63` | **不成立**。signal record 只有 `{schema_version, timestamp, session_id, project, skill, calls, source}`，无 corrections / 真实输入。trace（含 corrections / input_excerpt）在 B1 落到独立 `skill-traces/{name}.jsonl` | 高（已读源码） |
| 「复用 skill-evals/{name}/ 目录」 | `scripts/lib/skill-eval-results.js:19-24` | **成立但需澄清**。该目录已被 B3 占用，结构是 `skill-evals/{name}/results/results.jsonl`（eval 通过率时间线）。eval **case** 本身无结构化格式 | 高 |
| 「eval 集手工写或基于当前 skill 自动生成」 | `user-level/commands/skill-eval.md:15-24` | **成立**。skill-eval.md 只说 case 在 `skill-evals/{skill-name}/`，是 LLM 产出的非结构化用例，无 schema、无 provenance 隔离字段 | 高 |
| 「真实输入可能不可复现 → 转 case 时快照必要上下文」 | trace schema `scripts/lib/skill-traces.js:34-44` | **成立**。trace 已带 `failure_step/error_excerpt/correction_diff/input_excerpt/source/timestamp`，可直接快照进 case 的 `source_trace` | 高 |
| 复用现有脱敏函数 | `scripts/lib/redaction.js:23-29` | **成立**。`stripPrivateTags` 是现成纵深防御入口，B1 已复用 | 高 |

**结论（偏差说明）**：设计文档 §B2 的「从 signal jsonl」数据源假设**已过时**（B1 把 trace 移到了独立 `skill-traces/`）。以代码实际为准重新设计：B2 的输入是 `skill-traces/{name}.jsonl`（B1 产物），输出是新的结构化 eval-case 格式 `skill-evals/{name}/cases/cases.jsonl`（与 B3 的 `results/results.jsonl` 同构、平级）。这与 B3 当时「eval 结果无结构化格式，得先补格式」是同一类前置缺口——eval **case** 此前也无结构化格式。

---

## Phase 1 — Think（CEO 视角：做什么 / 不做什么）

### 做什么
- 把 B1 沉淀的真实失败 trace **半自动**转成结构化 eval case（真实失败 = 最有价值的测试）。
- 护城河强化：每条 case 标记 `provenance=trace` + 快照 `source_trace`，确定性可查「这个 case 来自真实使用而非 skill 自产」。

### 不做什么
- ❌ 不自动跑 case（eval 执行仍是 LLM 语义判断，保持 [[ADR-017]] 边界）。
- ❌ 不引入 case 自动评分 / Pareto 搜索（[[ADR-013]] 轻量优先，与 B1 刻意不引入 GEPA 自动搜索一致）。
- ❌ 不替代 skill-eval.md 现有「LLM 自动生成 case」路径——trace-case 是**补充的高信号来源**，不是唯一来源。
- ❌ 不碰 results.jsonl（B3 领域，eval 通过率时间线）。

### Success（EARS-lite）
- WHEN `/skill diagnose` 提取到失败 trace 且人工确认后 THE SYSTEM SHALL 把该 trace 经 `node scripts/skill-eval-cases.js add` 转为一条结构化 eval case 追加到 `skill-evals/{name}/cases/cases.jsonl`。
- WHEN 任何 case 字段含真实输入（input/expectation/source_trace）写入前 THE SYSTEM SHALL 再过一道 `stripPrivateTags`，使私有标签内容不落盘（纵深防御）。
- WHEN case 未携带 `provenance=trace` 且未携带 `source_trace` THE SYSTEM SHALL 拒绝写入（usage exit 2），保证护城河字段不被绕过。
- WHEN skill 名不匹配 `/^[a-z][a-z0-9-]{0,63}$/` THE SYSTEM SHALL 拒绝（防路径逃逸到 skill-evals 外）。
- WHEN `/skill eval` 需要 case 集 THE SYSTEM SHALL 能通过 `node scripts/skill-eval-cases.js list <name>` 读到 trace 沉淀的真实 case（供 LLM 消费）。

---

## Phase 2 — Plan（架构师视角）

### 数据流
```
observations.jsonl (双层脱敏)
   │  /skill diagnose 半自动提取 + 人工 gate
   ▼
skill-traces/{name}.jsonl            ← B1 产物（已脱敏）
   │  /skill diagnose 或 improve 后人工确认「这条失败值得固化为 case」
   ▼  node scripts/skill-eval-cases.js add（内部再过 stripPrivateTags）
skill-evals/{name}/cases/cases.jsonl ← B2 产物（结构化 eval case + provenance=trace + source_trace 快照）
   │  /skill eval 读取（LLM 消费 + 语义判断通过率）
   ▼
skill-evals/{name}/results/results.jsonl ← B3 产物（通过率时间线，publish guard 读）
```

### 新增模块
1. `scripts/lib/skill-eval-cases.js`（纯函数 lib）
   - `resolveCasesFile(name, baseDir)` → `{baseDir}/skill-evals/{name}/cases/cases.jsonl`
   - `addCase(name, input, {baseDir})`：
     - 校验 `provenance`（必须 `trace`）+ `source_trace`（必须对象，含 trace 快照）→ 否则抛。
     - 所有字符串字段（`input`/`expectation`/`source_trace.*` 字符串值）写入前 `stripPrivateTags`。
     - 校验 `id` 唯一性可选（append-only，重复 id 仅 stderr 提示，不阻塞）。
     - schema：`{schema_version, timestamp, name, id, input, expectation, provenance, source_trace, tags?}`
   - `readCases(name, {baseDir})`：损坏行 skip + stderr marker，不抛。
   - 复用 `SKILL_NAME_RE`（与 skill-traces / skill-eval-results 一致）。
2. `scripts/skill-eval-cases.js`（CLI，只管 argv + exit policy）
   - `add --name <n> --input <s> --expectation <s> [--id <s>] [--from-trace <json>] [--tag <s>] [--base-dir <dir>]`
     - `--from-trace` 接受 trace JSON 快照（来自 `skill-traces.js list` 的一条）；缺失时拒绝（provenance gate）。
     - 内部 set provenance=trace。
   - `list <name> [--base-dir <dir>]`：预览 case 数 + 摘要（供 LLM eval 前消费）。
   - exit policy：usage/边界错 exit 2；正常 exit 0；不 crash 调用方。

### 文档改动（需主 orchestrator propagate+build）
- `user-level/commands/skill-eval.md`：加「从 trace 沉淀真实 case」段（B2），明确 trace-case 是高信号补充来源 + provenance 隔离 = 护城河强化。
- `user-level/commands/skill-diagnose.md`：trace 提取后追加「可继续 `skill-eval-cases.js add` 固化为 case」一步。
- `user-level/commands/skill.md`：eval 子动作说明补 trace-case 数据源。

### 双 runtime 同步（主 orchestrator 收口，我不跑 build）
- `copyUtilityScripts` 列表加 `skill-eval-cases.js`（lib 经 `copyHookLibs` glob 自动复制）——**我只改 build 脚本源的列表，不跑 build**。
- install.sh / install.ps1 已建 `skill-evals` 目录，`cases/` 子目录由 lib `mkdirSync recursive` 懒创建，无需改 install。

### 关键假设验证（已在上方表完成）
所有「涉及文件」均已 Read：skill-traces.js / skill-eval-results.js / skill-signals.js / redaction.js / runtime-paths.js / 4 个 skill*.md / build-codex-plugin.js copyUtilityScripts / install.* 目录列表。

### 风险评估
- L2（新增独立数据文件 + CLI，不改既有聚合逻辑；含真实输入但有双层脱敏）。
- 风险点：真实输入不可复现 → 已用 `source_trace` 快照缓解；隐私 → 双层脱敏 + 测试负样本断言。

---

## Phase 3 — Work（工程师视角）

实现顺序：lib → CLI → 测试 → 文档 → build 列表。

- T1 `scripts/lib/skill-eval-cases.js`：纯函数，复用 redaction + SKILL_NAME_RE 模式。
- T2 `scripts/skill-eval-cases.js`：CLI，provenance gate + 双层脱敏由 lib 保证。
- T3 `scripts/test-skill-eval-cases.js`：lib 级测试（脱敏负样本 / 逃逸 / 损坏行 / provenance 必填 / 同构 readCases）。
- T4 `scripts/test-skill-eval-cases-cli.js`：CLI 端到端（进程边界脱敏 + provenance gate exit 2 + usage exit 2）。
- T5 文档：skill-eval.md / skill-diagnose.md / skill.md。
- T6 build 列表加 `skill-eval-cases.js`（不跑 build）。

---

## Phase 4 — Review（审查团队视角）

- 安全：路径逃逸（SKILL_NAME_RE）✓ / 隐私双层脱敏（lib 内 stripPrivateTags + 测试负样本）✓ / 无硬编码 secret ✓。
- 一致性：与 skill-traces.js / skill-eval-results.js 同构（append-only / 损坏行 skip / marker / 命名校验）✓。
- 护城河：provenance=trace + source_trace 为确定性必填 gate，无法被 skill 自产 case 绕过（写入即拒）✓。
- parity：纯文件 jsonl，CLI 双 runtime 跑；进 copyUtilityScripts ✓（主 orchestrator build 收口）。
- 4 原则：parity ✓ / 确定性（jsonl + provenance gate）✓ / 轻量（无 DB，复用现有目录与模式）✓ / Obsidian（数据是 jsonl，skill/doc 是 markdown）✓。

---

## Phase 5 — Compound（知识管理者视角）

- solution：`docs/solutions/2026-05-28-trace-to-eval.md`。
- 是否新 ADR：本 sprint 沿用 [[ADR-016]]（确定性下沉）/ [[ADR-017]]（语义信号 LLM+gate）既有边界，**但确立了一条新的目录约定 + 护城河 enforcement 方式**（provenance gate 确定性拒绝非 trace 来源 case），建议主 orchestrator 评估是否值得新 ADR（草稿见返回报告）。
- 变更日志：见本文 frontmatter `status: implemented`。
