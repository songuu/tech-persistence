---
title: "B1 trace-aware 反思：skill 失败/纠正 trace 结构化捕获（GEPA 内核）"
type: sprint
status: completed
created: "2026-05-28"
updated: "2026-05-28"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, self-evolution, skill-evolution, trace, gepa]
aliases: ["B1 trace 反思", "skill-traces"]

# === Anti-Drift 扩展字段 ===
invariants:
  - "trace 写入前必须脱敏（recordTrace 内部对字符串字段跑 stripPrivateTags），纵深防御真实输入泄漏"
  - "trace 存独立 skill-traces/ 目录，不混入 skill-signals calls jsonl（避免污染 summarizeSkillSignals）"
  - "recordTrace CLI 是写工具非 hook：参数/边界错 exit 2，但绝不 crash 调用方主流程"
  - "双 runtime 副本 sha256 一致（LF-normalize 后比对）"
invariant_tests:
  - "node scripts/run-tests.js --grep skill"
deferred: []
deadcode_until: []
---

# B1 trace-aware 反思

> **来源**：[[2026-05-28-two-layer-architecture-enhancement]] §B1（GEPA reflective mutation 内核）。B2（trace→eval）的数据前置。
> **依赖重排**：按数据依赖 B1 先于 B2 实施（设计文档 ROI 排序倒置，见 [[2026-05-28-skill-publish-baseline-guard]] 同类勘察教训）。

---

## Phase 1: 需求分析（Think）

### Scope
- 让 skill 失败/纠正 trace 有结构化捕获，使 `/skill diagnose` `/skill improve` 基于真实 trace 做根因反思，而非凭空描述"纠正模式"。
- 数据进入：`/skill diagnose` 时 LLM 从现成 observations.jsonl 半自动提取失败 trace → 人工确认 → CLI record（用户选定路径）。

### Non-scope
- 不做 hook 自动失败检测（skill 成败是语义判断，无 exit code，不可确定性化）。
- 不做 B2（trace→eval 转换，下一步）。
- 不改 calls 计数聚合逻辑（`aggregateSkillSignals` / `summarizeSkillSignals` 不动）。
- 不引入 GEPA 的 Pareto 自动搜索（保持人工 gate + 轻量）。

### Success（EARS-lite）
- WHEN LLM 在 diagnose 时判定某次 skill 执行失败/被纠正，THE SYSTEM SHALL 经人工确认后结构化记录 trace（failure_step / error_excerpt / correction_diff / input_excerpt，已脱敏）到 skill-traces/{name}.jsonl。
- WHEN `/skill improve` 运行，THE SYSTEM SHALL 读取 trace 做根因反思（GEPA 内核：读 trace → 自然语言诊断 → 定向改 prompt）。
- WHEN trace 字段含 `<private>` 等敏感标签，THE SYSTEM SHALL 写入前 stripPrivateTags 脱敏。

### Risks
- trace 含真实输入 → 双层脱敏（observations 已脱敏 + recordTrace 再过一道，纵深防御）。
- trace 靠 LLM 判断写入 = 半下沉（同 [[2026-05-28-skill-publish-baseline-guard]] P1-b 固有边界：语义信号无法 hook 自动化），用 diagnose 流程 prompt 强约束缓解。

---

## Phase 2: 技术方案（Plan）

### 关键假设验证（[[ADR-012]]）

| 假设 | 验证文件 | 实际 | 可信度 |
|------|---------|------|--------|
| signal jsonl 含 corrections/steps_skipped/duration | `skill-signals.js` | **推翻**：record 仅 `{skill, calls, source}`，diagnose/improve.md 描述的字段全是 doc drift | 已勘察 |
| 真实失败输入有现成数据源 | `observe.js:54-74` | observations.jsonl 含 input_summary/output_summary/error_signal/status，双层脱敏（stripPrivateTags + redactObservation） | 已勘察 |
| trace 存 skill-signals jsonl 安全 | `summarizeSkillSignals` | 混入会让无 calls 行被读（虽安全跳过），但语义混杂 → 改用独立 skill-traces/ 目录 | 已勘察 |
| 脱敏管线可复用 | `lib/redaction.js` | `stripPrivateTags` 导出可复用 | 已勘察 |

### 入场扫描 - Invariants 继承

| 子系统 | 既有 invariant | 本 sprint 如何保持 |
|--------|---------------|--------------------|
| 脱敏管线 | observe 写入前 stripPrivateTags + redactObservation | recordTrace 复用 stripPrivateTags |
| skill-signals | calls 聚合不被污染 | trace 存独立 skill-traces/，不碰 signal jsonl |
| 多副本同步 | git tracked 派生靠 propagate + build | CLI 走 copyUtilityScripts；lib 走 copyHookLibs |
| skill 名校验 | SKILL_NAME_RE 路径逃逸防御 | recordTrace 复用同 regex |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| diagnose 提取失败 trace | `/skill diagnose` LLM 读 observations → 人工确认 → record CLI | skill-traces.js（脱敏） | ✅ skill-traces/{name}.jsonl | ✅ improve 读 |
| improve 反思 | `/skill improve` 读 trace | readTraces | — | ✅ 提案含根因 |

无 ❌ 链路。

### 入场扫描 - 债务清单
来自 [[2026-05-28-skill-publish-baseline-guard]]：B2（trace→eval）依赖本 sprint 产物，本 sprint 完成后 B2 解除阻塞。

### 任务拆解

| Task | 等级 | 内容 | 验证 |
|------|------|------|------|
| T1 | L2 | `scripts/lib/skill-traces.js`：`recordTrace`（内部 stripPrivateTags 脱敏）/ `readTraces`；路径 `{baseDir}/skill-traces/{name}.jsonl`；SKILL_NAME_RE 防御 | `scripts/test-skill-traces.js` 单测（含脱敏断言）|
| T2 | L2 | `scripts/skill-traces.js` CLI：`record` + `list` 子命令；usage 错 exit 2；不 crash | 单测（脱敏 + 路径逃逸 + usage）|
| T3 | L1 | 文档：skill-diagnose.md 加"从 observations 提取失败 trace → 人工确认 → record"；skill-improve.md 加"读 trace 根因反思"；skill.md 子动作同步 | grep 校验含命令 |
| T4 | L2 | 双 runtime 同步：copyUtilityScripts 加 CLI、install.sh/ps1 加 skill-traces 目录、propagate 3 命令、build+validate+pre-commit | validate pass + CLI sha match |
| T5 | L1 | 文档同步：设计文档 B1 标 implemented + 变更日志、README 知识层、[[ADR-017]]、solution + index | pre-commit pass |

### 验证策略
- 每 Task 跑 `node scripts/run-tests.js --grep skill`。
- T1/T2 强制脱敏负样本：trace 含 `<private>` → 写入后文件不含明文 + 含 [PRIVATE REDACTED]。
- T4 后全量 build + validate + pre-commit。

### trace schema
```json
{ "schema_version": "1.0", "timestamp": "...", "skill": "prototype",
  "failure_step": "step 3 需求澄清", "error_excerpt": "...", "correction_diff": "...",
  "input_excerpt": "...", "source": "diagnose-extract" }
```
除 skill + timestamp 外字段可选；字符串字段写入前 stripPrivateTags。

---

## Phase 3: 实现记录（Work）

| Task | 状态 | 产物 | 验证 |
|------|------|------|------|
| T1 | ✅ | `scripts/lib/skill-traces.js`（recordTrace 脱敏 / readTraces）+ test | 7/7（含脱敏负样本）|
| T2 | ✅ | `scripts/skill-traces.js` CLI（record+list）+ test | 7/7（脱敏/逃逸/usage）|
| T3 | ✅ | skill-diagnose.md（提取 trace）/ skill-improve.md（反思）/ skill.md 同步 | grep 校验 |
| T4 | ✅ | build copyUtilityScripts +CLI；install.sh/ps1 加 skill-traces 目录；propagate 3 命令 | validate pass，CLI+lib sha match，run-tests 16/16 |
| T5 | ✅ | 设计文档 B1 标 implemented、[[ADR-017]]、README、solution + index | sync 30 docs，pre-commit exit 0 |

## Phase 4: 审查结果（Review）

风险等级：L2（新增脚本 + 改文档，含隐私脱敏路径）。

**P0**：无。

**P1（1，固有边界非缺陷）**：trace 入口靠 LLM 半自动判断（diagnose 提取 + 人工 gate）= 半下沉。属语义信号无法 hook 自动化的固有边界，已由 [[ADR-017]] 明示为决策而非妥协。

**第 6 视角（集成连续性）**：未破坏 B3 产物/hook/calls 聚合（skill.md 被 B3+B1 共改，propagate 均同步）；无 dead code（recordTrace←CLI+diagnose / readTraces←CLI+improve）；集成链闭环（diagnose 提取 → record → skill-traces.jsonl → improve 反思）。

## Phase 5: 复利记录（Compound）

- **新 ADR**：[[ADR-017]] — 语义信号（skill 失败/纠正）用"LLM 半自动判断 + CLI 结构化 record"捕获，不靠 hook；[[ADR-016]] 互补面。
- **新 solution**：[[2026-05-28-skill-trace-aware-reflection]]。
- **候选本能**：
  - `semantic-signal-needs-llm-judgement-not-hook`（🟢 0.75）：给 LLM-only 子系统加数据捕获，先分"确定性可派生（hook）vs 语义判断（LLM+人工 gate+CLI record）"。
  - `doc-claims-field-verify-before-extend`（🟡 0.6）：设计文档写"扩展现有 X 字段"必须先 grep 确认 X 存在——本次 signal schema 是 doc drift。
- **B2 解除阻塞**：skill-traces 数据源就位，B2（trace→eval）可实施。
- **连续 3 sprint 模式复用**：[[ADR-012]] 勘察连续 3 次（B3/B2/B1）推翻设计假设——设计文档与代码现实的 drift 是高频项，勘察 ROI 持续为正。

## Related
- [[2026-05-28-two-layer-architecture-enhancement]] — B1 设计来源
- [[2026-05-28-skill-publish-baseline-guard]] — B3（同类勘察教训 + B2 依赖链）
- [[ADR-012]] — plan 必须勘察（已推翻 signal schema 假设）
- [[ADR-016]] — skill 链 deterministic 化先例

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-05-28 | 初版 plan：勘察推翻 signal schema 假设（无 corrections/真实输入，doc drift），trace 存独立 skill-traces/，diagnose 半自动提取 + 双层脱敏。status: planning |
