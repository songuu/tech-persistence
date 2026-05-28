---
title: "Agent-loop clarification channel（A3 实施）"
type: sprint
status: planning
created: "2026-05-28"
updated: "2026-05-28"
tasks_total: 7
tasks_completed: 0
tags: [sprint, agent-orchestration, agent-loop]
aliases: ["clarification channel", "A3"]

invariants:
  - "provider 错误必须走 runProcess 中央错误处理，不自己 spawnSync（debugging-gotchas）"
  - "state 反序列化新字段必须在 applyStateDefaults 做 default（state-migration 教训）"
  - "agent-orchestrator.js 源与 plugin 副本 sha256 必须一致（pre-commit checkOrchestratorSync）"
  - "normalizeHandoff/normalizeReview 保持宽松解析，新字段不破坏现有字段"
invariant_tests:
  - scripts/agent-orchestrator.js  # node scripts/agent-orchestrator.js self-test
deferred:
  - sprint: 后续
    item: "clarification ruling 与 pipeline contract-revision 集成（ARCHITECTURE_ISSUES 问题 13）"
    deadline: "未定"
    reason: "非 pipeline 模式 ruling 走 review.json 通道即可，pipeline 集成超出本 sprint"
---

# Agent-loop clarification channel（A3 实施）

> 来源：[[2026-05-28-two-layer-architecture-enhancement]] A3。
> 由 B3 改向而来（B3 因 eval results 地基不存在不可实施，见 [[2026-05-28-market-architecture-gap-analysis]]）。
> A3 是 6 增强中**唯一有 deterministic 代码 backing**（`agent-orchestrator.js` 真状态机）的，能做成真正的机械化 artifact 流转。

## Phase 1：需求分析

### 要做
agent-loop 的 frozen spec 当前是**静态单向**：Claude freeze spec → Codex 实现 → Claude review。implementer 执行中遇 spec 歧义只能"做最小假设并记进 handoff.risks"（[agent-orchestrator.js:976](../../scripts/agent-orchestrator.js#L976)），spec-writer 无法回应。A3 把这条**单向记录**升级为**双向 clarification channel**：implementer 提问 → 持久化 → spec-writer/reviewer 裁决 → 回灌下一轮。

### 不做
- 不引入实时双向 runtime 通道（违反"非 runtime + 轻量"定位）——异步 append 批处理。
- 不碰 pipeline 模式的 contract-revision（问题 13）——非 pipeline 模式 ruling 走 review.json 通道。
- 不改 spec/implement/review 三段式状态机骨架，只加 artifact 流转。

### 成功标准
1. implementer 输出的 `clarifications` 被解析并 append 到 `clarifications.md`（status: open）。
2. reviewer 输出的 `clarificationRulings` 被解析并回灌 `clarifications.md`（status: ruled）。
3. 下一轮 implement prompt 能看到 ruling。
4. **open clarification 未裁决时，approved 降级为 needs-followup**（防错误假设固化 + 防 dead artifact）。
5. 双副本 sha256 一致；self-test 绿；smoke 覆盖 round-trip。

## Phase 2：技术方案

### 4 个改动点 + 1 新 artifact（均经 [[ADR-012]] 勘察）

| # | 函数/产物 | 改动 |
|---|----------|------|
| 1 | `normalizeHandoff` (844) | 加 `clarifications: toArray(raw.clarifications\|\|raw.questions)`，与 risks 区分（risks=已做假设，clarifications=待裁决问题） |
| 2 | `normalizeReview` (855) | 加 `clarificationRulings: toArray(raw.clarificationRulings)` |
| 3 | `buildImplementationPrompt` (968) | 注入 `clarifications.md` + 协议升级："遇歧义在 handoff.clarifications 提问（标当前假设），不阻塞继续；历史 ruling 见注入的 clarifications.md" |
| 4 | `buildReviewPrompt` (995) | 注入 `clarifications.md` + 协议："对每条 open clarification 在 review.clarificationRulings 给裁决（confirm-assumption / revise-spec + 理由）" |
| 5 | 新 artifact `clarifications.md` | append-only。新函数 `appendClarifications(runDir, entries, phase)`；`runImplementationProvider`/`runReviewProvider` 后调用；`state.files.clarifications` + `applyStateDefaults` default |

### 状态机决策（成功标准 4）
`statusFromReview` (934) 增加：读 clarifications.md，若存在 open（未 ruled）条目且 decision=approved → 降级 `needs-followup`（强制下一轮先裁决）。这是 A3 的核心价值——让 clarification 不被忽略，避免 implementer 错误假设被 approved 固化。

### 关键假设验证（兑现 [[ADR-012]]）

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| normalizeHandoff 可加字段不破坏现有 | Read 844-853 | ✅ 宽松解析 `raw.x\|\|raw.y`，加字段安全 |
| normalizeReview 可加 clarificationRulings | Read 855-896 | ✅ 同上 |
| buildImplementationPrompt 有注入点 + 已有歧义协议 | Read 968-993 | ✅ line 976 已有"ambiguous→risks"，A3 升级为 channel |
| buildReviewPrompt 有注入点 | Read 995-1023 | ✅ 可注入 clarifications.md |
| artifact 读写可复用 writeText/runDir | Read 100-117 + grep | ✅ writeText + path.join(runDir,...) |
| **schema strict 是否拒新字段** | **未验证 ⚠** | **Phase 3 T1 必须先读 schemas/handoff.json、review.json 的 additionalProperties；若 strict 需同步加可选字段（T5），否则 provider 输出被 schema 校验拒** |

### Anti-drift 入场 checklist

**① Invariant 继承**（见 frontmatter `invariants`）：runProcess 中央错误处理 / state default / 双副本 sha256 / normalize 宽松解析——A3 全部保持。

**② 集成路径声明**：

| 改动点 | 触发 | 中间层 | 持久化 | 下轮可见 |
|--------|------|--------|--------|----------|
| implementer 提问 | handoff.clarifications | normalizeHandoff 解析 | clarifications.md append (open) | ✅ reviewer prompt 注入 |
| reviewer 裁决 | review.clarificationRulings | normalizeReview 解析 | clarifications.md append (ruled) | ✅ 下轮 impl prompt 注入 |

全链路闭合，无 ❌（无 dead artifact——成功标准 4 的 status 降级保证 open 必被处理）。

**③ 半完成债务清单**：见 frontmatter `deferred`——pipeline contract-revision 集成明确推迟，非 pipeline 模式 ruling 走 review.json 通道自足。

## 任务拆解

- [ ] **T1**（前置验证 L1）：读 `scripts/agent-orchestrator/` schema 或 `schemas/*.json`，确认 handoff/review schema 的 `additionalProperties` strict 程度。决定 T5 是否需要。
- [ ] **T2**（L3）：`normalizeHandoff` + `normalizeReview` 加字段（`scripts/agent-orchestrator.js`）。
- [ ] **T3**（L3）：`buildImplementationPrompt` + `buildReviewPrompt` 注入 clarifications.md + 协议升级。
- [ ] **T4**（L3）：新增 `appendClarifications`/`writeClarifications` + runImpl/runReview 调用 + `state.files.clarifications` + `applyStateDefaults` default + `statusFromReview` open 降级逻辑。
- [ ] **T5**（条件，依赖 T1）：若 schema strict，更新 handoff/review schema 加可选 `clarifications`/`clarificationRulings`。
- [ ] **T6**（L3 测试）：self-test 加 round-trip 覆盖（implementer 提问→append→reviewer 裁决→回写→status 降级）；smoke 负样本（open 未裁决 + approved → 必须 needs-followup）。
- [ ] **T7**（L2 文档+同步）：`build-codex-plugin.js` 同步 plugin 副本 + `validate-codex-plugin.js` + `pre-commit-check.js` 确认 sha256 一致；更新 `user-level/commands/agent-loop.md` 说明 channel；更新本 sprint 文档 status。

## 测试策略
- T1-T5 改 orchestrator 核心状态流转 = **L3**：self-test round-trip + 负样本（open clarification 阻断 completed）+ 现有 self-test 不回归。
- 双副本：`node plugins/tech-persistence/scripts/build-codex-plugin.js && node scripts/validate-codex-plugin.js && node scripts/pre-commit-check.js`（[[debugging-gotchas]] propagate 纪律）。

## 风险
- R1：schema strict 未验证（T1 前置消解）。
- R2：双副本 sha256 漂移（T7 build+validate 消解）。
- R3：A3 的 deterministic backing 在 orchestrator artifact 流转；implementer/reviewer 是否真提问/裁决是 LLM 协议行为——但即使 LLM 不提问，orchestrator 行为与现状一致（向后兼容，clarifications 字段缺失 = 空 channel）。

## 变更日志

| 日期 | 阶段 | 说明 |
|------|------|------|
| 2026-05-28 | Phase 1-2 | 由 B3 改向 A3；需求+技术方案+任务拆解完成，关键假设验证含 schema strict 待验证项。status: planning |
