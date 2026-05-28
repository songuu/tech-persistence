---
title: "A3 clarification channel：agent-loop frozen spec 的 append-only 异步澄清通道"
type: solution
status: completed
created: "2026-05-28"
updated: "2026-05-28"
tags: [agent-loop, orchestrator, clarification, async, append-only]
aliases: ["clarification channel", "clarifications.md"]
related:
  - "[[2026-05-28-two-layer-architecture-enhancement]]"
  - "[[2026-05-28-clarification-channel]]"
  - "[[ADR-003]]"
  - "[[ADR-004]]"
  - "[[ADR-012]]"
---

# A3 clarification channel

## Problem

agent-loop 的 classic 线性流（Claude freeze spec → Codex 实现 → Claude review）是**静态单向**的。implementer（Codex）执行中遇到 spec 歧义时，无法回问 spec-writer，只能要么自行猜测（无记录、无裁决），要么整轮重跑。缺少一个让 implementer **异步提问 + spec-writer 异步裁决**的通道。

## Root Cause

frozen spec artifact 一旦冻结就是只读静态文件，orchestrator 没有承载「implementer→spec-writer 单向问题流」的载体。设计文档 §A3 假设可「复用现有 contract-revision 流程」，但勘察（ADR-012）发现：

- **contract-revision / accept-revision / reject-revision 只存在于 pipeline 模式**（`scripts/agent-orchestrator/pipeline.js:22-23` 的 `PIPELINE_RESOLVE`，contract-conflict 状态机）。
- **classic 线性模式没有 contract-revision**。classic 的「修正 spec」等价回路是 review→`needs-followup`→resume re-implement（`runResume` line ~1803）。
- handoff schema 与 review schema 都是 strict（handoff `additionalProperties:false`），没有透传 clarification 的槽位。
- orchestrator artifact 都用覆盖式 `writeText`/`writeJson`，**无 append 助手**。

## Solution

在 `.agent-runs/<runId>/` 加 append-only 的 `clarifications.md`：

1. **新 lib `scripts/lib/clarifications.js`**（确定性、可单测、双 runtime 复用）：
   - `appendClarifications(runDir, entries)`：`fs.appendFileSync` 追加 implementer 的「假设+问题」（status: open），首写带 frontmatter+标题，后续纯 append section，自动派生 `clr-NNN` id。
   - `appendRulings(runDir, rulings)`：append spec-writer 的裁决（status: ruled，decision ∈ confirm-assumption | revise-spec）。
   - `readClarifications` / `listOpenClarifications`：解析 + 合并 clarification 与其 ruling。
   - 所有字符串字段写入前 `stripPrivateTags`（复用 `scripts/lib/redaction.js`，纵深防御）。

2. **schema 扩展**（向后兼容，新字段非 required）：handoff 加可选 `clarifications[]`，review 加可选 `clarificationRulings[]`。

3. **orchestrator wiring（仅 classic 路径，`scripts/agent-orchestrator.js`）**：
   - `normalizeHandoff` → `clarifications`；`normalizeReview` → `clarificationRulings`。
   - `runImplementationProvider` 写完 handoff 后 `recordImplementationClarifications`（不阻塞，写在 provider 调用之后）。
   - `runReviewProvider` 归一化后 `recordReviewRulings`。
   - `buildImplementationPrompt`：指令「遇歧义记录假设+问题，继续实现」+ 注入已 ruled 裁决（re-implement 时遵守）。
   - `buildReviewPrompt`：注入 open clarifications + 指令「逐条 ruling；revise-spec 同时进 findings/followUpTasks」。

4. **ruling→spec 修正衔接**：classic 模式 ruling=revise-spec 时，review provider 同步在 findings/followUpTasks 产出 → 状态转 `needs-followup` → resume re-implement。**不调用 pipeline 的 accept-revision**（那是另一条状态机）。

## Key Insight

设计文档说「复用现有 contract-revision」在 classic 模式不成立——contract-revision 是 pipeline-only。正确的衔接是 classic 既有的 review→needs-followup→re-implement 回路，无需新发明状态流。这是 ADR-012「以代码为准重新设计」的又一次应用：把「异步澄清」拆成「append-only 提问通道（新）」+「既有 needs-followup 回路（复用）」两半，而不是把 pipeline 的 contract-revision 强行搬到 classic。

append-only + 异步裁决严格符合 TP「批处理而非实时」哲学：clarification.md 纯 markdown，双 runtime 同目录读写，零新组件、零双向 runtime 通道。

## Prevention

- 任何「frozen 后还需结构化追加」的 orchestrator 场景，用 `fs.appendFileSync` + section 化 markdown，不要覆盖写，并配 append-only 单测（断言二次写后 `body.startsWith(priorBody)` + 字节只增）。
- 引用「现有 X 流程可复用」前先确认它在**当前模式**存在（pipeline vs classic 是两套状态机）。
- 改 strict schema（`additionalProperties:false`）加字段必须同步改对应的 normalize 函数。

## 新 ADR（草稿，交主 orchestrator 落 architecture.md）

> **ADR-018: agent-loop classic 模式的 spec 澄清用 append-only `clarifications.md` 异步通道，ruling→spec 修正复用 needs-followup 回路（不复用 pipeline contract-revision）**
> - **状态**：已采纳
> - **上下文**：[[2026-05-28-two-layer-architecture-enhancement]] §A3 要给 frozen spec 加 implementer→spec-writer 澄清通道，假设「复用现有 contract-revision（问题 13 accept-revision）」。ADR-012 勘察推翻：contract-revision/accept-revision 只在 pipeline 模式（`pipeline.js` contract-conflict 状态机）；classic 线性流没有该机制，其「修正 spec」等价回路是 review→needs-followup→resume re-implement。同时 handoff schema strict、orchestrator 无 append 助手。
> - **决策**：(1) frozen spec 旁加 append-only `clarifications.md`（新 lib `scripts/lib/clarifications.js`，`fs.appendFileSync`，section 化 markdown + frontmatter）；(2) implementer 经 handoff `clarifications[]` 提问（不阻塞，记假设继续实现），orchestrator append 进文件；(3) review provider 兼任 spec-writer，经 `clarificationRulings[]` 逐条裁决，append 为 ruling section；(4) **ruling=revise-spec 复用 classic 既有 needs-followup 回路**（review 同步进 findings/followUpTasks），不调用 pipeline accept-revision；(5) 所有字段写入前 stripPrivateTags（纵深防御）。
> - **原因**：(1) append-only + 异步裁决符合 TP「批处理而非实时」+「非 runtime」定位，零双向通道；(2) classic/pipeline 是两套状态机，强搬 contract-revision 会引入跨模式耦合；(3) 复用 needs-followup 回路使「ruling 改 spec」零新状态流；(4) clarifications.md 是纯 markdown runDir artifact，schemas/ 与 scripts/lib/ 由 build glob 自动同步，双 runtime parity 天然满足。
> - **备选**：(a) 把 pipeline contract-revision 搬到 classic——跨模式耦合，否决；(b) 双向 runtime 实时通道——违反轻量+非 runtime，否决；(c) 覆盖式重写 clarifications——丢历史，违反审计性，否决。
> - **影响**：(1) classic 模式新增 `clarifications.md` artifact 与 handoff/review schema 两个可选字段（向后兼容）；(2) 未来 classic 模式的「frozen 后追加」场景统一用 append-only lib；(3) pipeline 模式不受影响（改动全在 `state.mode!=='pipeline'` 路径）；(4) 新 lib 进 `scripts/lib/`，由 `copyHookLibs` glob 自动进 plugin 副本。
> - **来源**：`docs/plans/2026-05-28-clarification-channel.md`，本 solution。

## Related

- [[2026-05-28-two-layer-architecture-enhancement]] §A3（来源）
- [[ADR-003]] / [[ADR-004]]（agent-loop v6 orchestrator + artifact 机制）
- [[ADR-012]]（plan 阶段强制勘察——本次再次推翻设计假设）
