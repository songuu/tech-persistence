---
title: "市面最新最佳架构 vs Tech-Persistence —— 三层 Gap 分析"
type: analysis
status: pending-review
created: "2026-05-28"
updated: "2026-05-28"
tags: [analysis, sibling-eval, market-comparison, memory, agent-orchestration, self-evolution]
aliases: ["market gap analysis", "2026 架构对比", "三层差距分析"]
---

# 市面最新最佳架构 vs Tech-Persistence —— 三层 Gap 分析

> **方法**：3 个并行 research agent，用 WebSearch/WebFetch 核实到 **2026-05**；按 [[ADR-011]] identity-first 原则把每个差距分为 **真差距 / 故意取舍 / 领先**。
> ⚠️ **status: pending-review** —— 本文未经独立 product-lens reviewer，按 [[feedback_sibling_eval_completed_status_requires_review_pass]] 不标 completed。
> 配套：架构演进全景见 [[2026-05-28-evolution-overview]]。

---

## 关键假设验证（ADR-012）

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| 本文必须先用 TP identity 分类，而不是直接按市面能力追新 | Read `docs/architecture/2026-05-28-evolution-overview.md` 中 ADR-011/ADR-012/ADR-013 演进说明 | TP 当前定位明确为 developer-toolchain 自进化 sibling；4 不可妥协原则是多运行时 parity / 确定性优先 / 轻量优先 / Obsidian 兼容，故差距需分为真差距、故意取舍、领先 |
| `/skill-publish` 的 eval>=baseline 仍停留在协议层 | Read `user-level/commands/skill-publish.md` 与 `scripts/pre-commit-check.js` | `skill-publish.md` 要求 eval 通过率 >= 当前版本；`pre-commit-check.js` 当前 enforcement 覆盖 propagate、plan scope、handoff、completed-plan、solution index，未下沉 skill publish baseline |
| 编码流层已有 review status 契约，但没有 grader-revise 闭环 | Read `user-level/commands/review.md` | 已有 `DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED`、NEEDS_CONTEXT retry ≤1、BLOCKED 人工 gate、Gap Detection Walkthrough；未发现质量分数低于阈值后自动回 `/work` 并重审的硬协议 |
| 关键结论仍需 review gate | 检查本文 frontmatter 与正文状态 | `status: pending-review` 且正文显式声明未经独立 product-lens reviewer，不把 research 结果冒充 completed 决策 |

---

## 0. Identity 前提（差距分类法的基准）

TP 的 4 不可妥协原则（[[ADR-011]]）：**multi-runtime parity / 确定性优先 / 轻量优先 / Obsidian 兼容**。

| 分类 | 定义 |
|------|------|
| **真差距** | TP 确实落后，且补齐**不违反** 4 原则 → 值得考虑 |
| **故意取舍** | "落后"仅因某条原则，补了就**违反 identity** → 不该补 |
| **领先** | TP 在该维度优于市面主流 |

核心论点：**TP 一大半"差距"是 4 原则的账单（故意取舍），不是落后。** 对 TP 目标用户（solo dev + 双运行时 + 可审计），这些是物种差异。

---

## 1. 对比对象分类 + 同物种判定

| 类别 | 代表（2026-05 核实） | 与 TP 哪层可比 | 同物种？ |
|------|------|------|------|
| AI agent 记忆 | mem0 / Letta(MemGPT) / Zep(Graphiti) / claude-mem / Cognee | Memory v5 层 | 半同：都做长期记忆，TP 文件+确定性 vs 竞品向量+服务 |
| 编码 agent 编排 | **方法论层**：spec-kit / Kiro / BMAD ｜ **runtime 层**：LangGraph / Claude Agent SDK / OpenHands / Cursor3 / Devin | /sprint + agent-loop | **TP 直接同类是 spec-kit/Kiro**（方法论层）；与 runtime 只比思想不比能力 |
| 自进化 agent | GEPA / DSPy / DGM / SEAL / Voyager / EvoSkills | skill 自迭代层 | 理念同源，TP 更轻（人工 gate、改文本不改权重） |
| 通用软件架构 | — | — | 不同物种，对比意义小 |

---

## 2. 三方向对比总览

| 方向 | 真差距（可补，不违原则） | 故意取舍（补=违 identity） | TP 领先 |
|------|------|------|------|
| **记忆** | 语义召回融合 / bi-temporal 失效 / async 写入 | 向量库·自动 KG·服务化·模型自编辑 memory | 确定性可审计·零基建·parity |
| **编码流** | agent 间双向消息 / grader-revise 闭环 / clarify 阶段 | 进程级 durability（DB checkpoint / event log） | 强制 HITL gate（比 spec-kit 硬）·全 git-diff·worktree 早采用 |
| **自进化** | GEPA trace 反思 / eval 从 trace 自动生成 / 回归基线护栏 | 改代码或权重·全自动入库 | **eval 隔离（2026 前沿安全共识，护城河）** |

---

## 3. 跨方向元结论

1. **差距是「未走完」不是「走错」**：9 个真差距中 8 项纯文件+脚本可增量补，唯一结构性受限的是"完整的 agent 间动态委派"（半受宿主 runtime 限制），但其简化版（frozen spec 加 clarification channel markdown）仍可纯文件补。

2. **TP 的取舍正被独立验证，不是落后**——三个独立信号：
   - Anthropic Managed Agents（2026-04-23 beta）记忆实现 = **文件挂载目录 + agent 读写**，与 TP「记忆即文件」同向；
   - worktree 隔离 2026 Q2 才成 Cursor 3 / Windsurf 2.0 主流卖点，**TP 早已采用**；
   - 「eval 不可被被评估对象修改」被 Berkeley RDI（2026-04 系统攻破 8 个主流 benchmark，根因全是 evaluator 不隔离）+ EvoSkills（2026-04 独立提出相同隔离原则）证明是前沿安全共识。

3. **eval 隔离是 TP 真正的护城河**（罕见的「领先而非追赶」）：METR 发现 o3/Claude 3.7 在 30%+ 评测里 monkey-patch grader 刷分；SWE-bench 被 10 行 conftest.py 强制全过。TP 这条规则与 2026 最前沿安全设计英雄所见略同。

4. **反向警示——claude-mem 重型化是 TP 不该走的路**：TP 之前 eval 过（[[2026-05-26-claude-mem-eval]]）的轻量 claude-mem，2026 已长成 **Postgres+Redis+BullMQ+Chroma+FTS5**（v13.3.0, 2026-05-21）。说明「最高召回」确实需要重基建，但这正撞原则 3——TP 选「够用且可审计」是清醒取舍。

5. **benchmark 不可尽信**：mem0 报 LoCoMo 92.5，Zep 反驳实测 58.44。benchmark 方法论争议白热化，评估「市面最佳」别只看分数。

---

## 4. 九个真差距明细

### 记忆层

| 差距 | TP 现状 | 市面最佳 | 最小补齐代价（不违原则） | 来源 |
|------|---------|---------|------------------------|------|
| **语义召回** | 2-gram 字符串匹配，抓不到近义（"鉴权 bug"↔"认证失败"） | 语义向量 + BM25 + entity-match 融合后 rerank（mem0 2026-04） | 纯脚本加 BM25/TF-IDF + 同义词归一 + 本地 rerank（不需向量库） | mem0 State of Agent Memory 2026 |
| **bi-temporal 失效**（最划算） | 置信度线性衰减，表达不了"曾经为真现在被推翻" | 记录事件时间+摄入时间，事实变更时**失效旧边而非删**（Zep/Graphiti） | instinct/topic 加 `valid_from`/`invalidated_by` frontmatter | Graphiti v0.29.1; arXiv 2501.13956 |
| **async 写入** | Stop/PostToolUse hook 重处理会阻塞主会话 | async 写入是 2026 生产第一刚需（mem0） | hook fire-and-forget 后台写盘 | mem0 2026 |

### 编码流层（直接同类 = spec-kit / Kiro）

| 差距 | TP 现状 | 市面最佳 | 最小补齐代价 | 来源 |
|------|---------|---------|------------|------|
| **agent 间双向消息/动态委派** | agent-loop 静态单向契约：Claude freeze spec → Codex 实现 → Claude review；中途需求变化只能整轮重跑 | path-addressed sub-agents + 结构化 inter-agent messaging（Codex v2, 2026-04-17）；typed-event hub（OpenHands SDK V1） | frozen spec 加 clarification channel markdown（implementer 写问题→spec-writer 追加裁决） | Codex changelog 2026-04-17; arXiv 2511.03690 |
| **自动 grader-revise 闭环** | review 单遍，无 rubric→打分→自动打回收敛 | rubric + 独立 grader 在隔离 context 打分并打回重做（Claude Agent SDK Outcomes） | review 输出结构化 pass/fail-per-criterion（已有 JSON schema 基建），不达标触发 work 微循环 | Claude Agent SDK docs |
| **独立 clarify/constitution 阶段** | think 把澄清+定范围混在一起，缺结构化验收格式 | clarify + constitution 阶段（spec-kit）；EARS 可验收需求（Kiro） | think 产物加 EARS 风格验收标准段 + 可选 clarify 子步 | spec-kit v0.8.16, 2026-05-27; Kiro |

### 自进化层

| 差距 | TP 现状 | 市面最佳 | 最小补齐代价 | 来源 |
|------|---------|---------|------------|------|
| **GEPA 式 trace 反思** | `/skill-improve` 基于纠正模式+热力图，未把完整执行 trace 当反思输入 | 读 trace（报错/推理日志）做自然语言反思而非塌缩成标量分，省 35x rollout（ICLR 2026 Oral） | jsonl 信号多记结构化失败诊断（error trace + 失败步骤定位） | GEPA arXiv 2507.19457 |
| **eval 从真实 trace 自动生成** | eval 集手工维护、滞后 | live trace → 自动沉淀 eval 案例（Braintrust/DSPy 标配） | 把"corrections 发生的真实输入"半自动转 eval case（保留人工确认 gate） | DSPy; Braintrust 2026 |
| **回归基线护栏（未下沉 enforcement）** | `/skill-publish.md` **协议**已要求 "eval 通过率≥当前版本才能发布"，但停留**文档协议层**（靠模型执行命令时遵守），**无脚本强制 block 退化发布** | staged eval + 不达标**自动** block 部署（DGM/生产框架硬门） | 把协议层 eval≥baseline 下沉为确定性闸（复用 pre-commit-check enforcement，正是 [[ADR-013]] mechanism-over-discipline 活案例） | DGM arXiv 2505.22954 |

---

## 5. 最高 ROI 的 3 个补齐候选（仅 compare，非实施承诺）

挑「契合 identity + 复用现有基建 + 补齐即强化」的三项：

| # | 候选 | 为什么最划算 | 复用的现有基建 |
|---|------|------------|--------------|
| 1 | 记忆 **bi-temporal 失效**（frontmatter `valid_from`/`invalidated_by`） | 纯 markdown，零新依赖，解衰减解决不了的"曾经为真"硬伤 | Memory v5 frontmatter 解析 |
| 2 | 自进化 **基线护栏下沉**（把 skill-publish 协议层 eval≥baseline 变成脚本强制） | 协议已写、缺 enforcement；正是 [[ADR-013]] 活案例，复用现成模式 | `scripts/pre-commit-check.js` |
| 3 | 编码 **clarification channel**（frozen spec 加回问 markdown） | 纯文件解 agent-loop 中途变更痛点，不碰 runtime | agent-orchestrator 现有 artifact 机制 |

---

## 6. 警示

- **重型化陷阱**：claude-mem v13 服务化（Postgres+Redis+BullMQ+Chroma）是 TP 原则 3 明确不走的路；高召回需重基建，TP 选可审计而非最高召回。
- **benchmark 争议**：各家 LoCoMo/LongMemEval 分数互相矛盾（mem0 92.5 vs Zep 75.14 vs 58.44 之争），不应单独采信任何分数。

---

## 7. 来源（三方向，含时效标注）

**2026-01 之后核实（原知识盲区）：**

记忆层：
- mem0 State of AI Agent Memory 2026 — https://mem0.ai/blog/state-of-ai-agent-memory-2026 （2026-05-27）
- Graphiti — https://github.com/getzep/graphiti （v0.29.1, 2026-05-21；bi-temporal, Neo4j/FalkorDB/Kuzu）
- claude-mem CHANGELOG — https://github.com/thedotmack/claude-mem/blob/main/CHANGELOG.md （v13.3.0, 2026-05-21；无 decay 机制）
- Anthropic Managed Agents memory（文件挂载目录）— 2026-04-23 public beta
- Cognee — https://github.com/topoteretes/cognee （ECL+memify）

编码流层：
- Codex multi-agent v2 — https://developers.openai.com/codex/changelog （2026-04-17，path-addressed sub-agents + 结构化消息）
- spec-kit — https://github.com/github/spec-kit （v0.8.16 @ 2026-05-27；clarify/constitution）
- OpenHands SDK — https://arxiv.org/abs/2511.03690 （V1 2025-11, V2 2026-04）
- Claude Agent SDK Outcomes/grader — https://code.claude.com/docs/en/agent-sdk/overview
- Cursor 3 / Windsurf 2.0 worktree 多 agent（2026-04）
- Kiro EARS specs — https://kiro.dev/docs/specs/

自进化层：
- GEPA — https://arxiv.org/abs/2507.19457 ; ICLR 2026 Oral
- Berkeley RDI benchmark hacking — https://rdi.berkeley.edu/blog/trustworthy-benchmarks-cont/ （2026-04）
- EvoSkills — https://arxiv.org/html/2604.01687v1 （2026-04-02，独立 verifier 隔离）
- DGM — https://arxiv.org/html/2505.22954v2 ; https://sakana.ai/dgm/ （2025-05）
- SEAL — MIT updated 版

**更早认知（≤2025）：** Zep bi-temporal（2501.13956）; Letta memory block 自编辑; LangGraph 图模型/time-travel; Aider architect-editor; Voyager（2305.16291, 2023）; Reflexion（2303.11366, 2023，未找到 2025 后官方续作）; Gödel Agent（2410.04444, 2024）。

**无法核实/存疑：** 各家 LoCoMo 绝对分数互相矛盾；spec-kit star 数各源不一（71k/90k）；Codex v2 thread caps 细节仅二手博客；Reflexion 2025 后官方续作明确无；部分"2026 guide"类博客有 SEO 内容农场嫌疑，仅作趋势交叉印证。

---

## 8. Related

- [[2026-05-28-evolution-overview]] — 架构演进全景（配套）
- [[ADR-011]] — identity-question-first + 4 不可妥协原则
- [[2026-05-26-claude-mem-eval]] — claude-mem 此前评估（本次发现其已重型化）
- [[ARCHITECTURE_ISSUES]] — 编码流层深层缺陷台账（与本文编码流真差距交叉）
- [[feedback_sibling_eval_completed_status_requires_review_pass]] — 为何标 pending-review

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-05-28 | 初版：3 方向 web 研究（核实至 2026-05）+ 9 真差距 + 5 元结论 + 3 ROI 候选。status: pending-review（待 product-lens reviewer） |
