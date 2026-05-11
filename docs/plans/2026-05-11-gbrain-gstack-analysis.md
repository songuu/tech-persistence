---
title: "gbrain 架构思想融入 tech-persistence 的可行性研究"
type: sprint
status: completed
created: "2026-05-11"
updated: "2026-05-11"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
phase4_findings: 15
phase4_auto_fixed: 8
phase4_semantic_reframes: 5
adr_emitted: ADR-011
tags: [sprint, research, architecture, fusion]
aliases: ["gbrain-fusion", "gbrain-gstack-analysis"]
---

# gbrain 架构思想融入 tech-persistence 的可行性研究

> **Status:** `draft`
> **Created:** 2026-05-11
> **Updated:** 2026-05-11

---

## 需求分析

<!-- /think 阶段填写 -->

### 背景

本项目 `tech-persistence` 已经吸收了 **gstack** 的"角色分工"作为方法论之一（`CLAUDE.md` → think/plan/work/review/compound 五阶段）。同作者 Garry Tan 最近发布的 **gbrain**（agent 知识脑 / 自连知识图谱 / 34 skill）展示了几个值得关注的**架构级**选择 — 不是单点功能，而是底层抽象的取向。

本 sprint 要回答的唯一问题：

> **gbrain 最新的架构思想中，哪些可以融入本项目当前的 Memory v5 / instinct / 4-hook / agent-orchestrator / skills / sprint workflow 体系？以什么形式融入？代价多大？哪些其实不该融入？**

不做"对比 gbrain vs gstack"。gstack 早已是本项目方法论源头，重复对比意义有限；这次重点在 gbrain 的**新东西**。

### 要做（按"抽取 → 定位 → 塑形 → 取舍"四步）

1. **抽取** — 从 gbrain 源码与文档中识别 6-10 个**架构级思想**（不是功能列表），候选池包括但不限于：
   - 自连知识图谱 + typed-link 零 LLM 提取（write-time 确定性关系抽取）
   - 混合检索（graph + vector + BM25 + backlink-boost）
   - "确定性 vs 判断"分流原则（minions 队列 vs sub-agents）
   - Brain-first lookup 协议（先查脑再外调）
   - 评估闭环（BrainBench-Real / LongMemEval / eval capture）
   - Tiered enrichment + 自动升级（T3 → T2 → T1）
   - Soul audit 身份层（SOUL / USER / ACCESS_POLICY / HEARTBEAT）
   - Thin harness + fat skills（智能在 skill 里，不在 runtime）
   - Cross-modal review + refusal routing
   - Signal-detector 永远在线（每条消息并行廉价模型抓 originals + entities）
   - 跨 agent 操作协议（AGENTS.md vs CLAUDE.md 双轨）
   - Skill conformance gate（skillpack-check / RESOLVER）

2. **定位** — 把每个思想映射到本项目当前架构的具体落点：Memory v5 / Instinct 系统 / 4-hook / agent-orchestrator / skills / sprint / 解决方案索引 / CLAUDE.md。说清楚"如果引入会动哪一块"。

3. **塑形** — 给每个值得考虑的方向出一份**融入草图**（不是详细设计）：
   - 落点（具体文件 / 模块）
   - 影响面（哪些既有部分要改）
   - 与现有原则的冲突点（确定性 / 多运行时 parity / Obsidian 兼容 / 用户控制 / 轻量）
   - 最小可行接入形态（≤ 50 字的形状描述）

4. **取舍** — 每个方向标三档：
   - 🟢 **建议采纳**（与现有架构同向且代价小）
   - 🟡 **部分借鉴**（核心想法用、具体实现自己造）
   - 🔴 **显式拒绝**（与本项目定位冲突或代价过大）

   每条必须写 **反方理由**（即使最终结论是 🟢 也要写"不做的理由"），避免一边倒。

### 不做

- **不**实施任何融入方案（本 sprint 只输出研究，不动代码）
- **不**把 gbrain 当作"目标态"（本项目定位是开发者工具链，不是 agent brain）
- **不**重复对比 gbrain vs gstack（重点在 gbrain 的新东西）
- **不**重写本项目 CLAUDE.md / 架构 / 命令（融入草图是建议，不是动作）
- **不**做功能搬运清单（"他们有 34 个 skill，我们要补这些"这类机械迁移）
- **不**为了"全面"罗列 gbrain 所有细节 — 抽象层面够用即可

### 成功标准

- [ ] 6-10 个**架构思想**每个有：1 句话底层抽象描述 + 来源引用（文件 / 段落）+ 当前架构对照位置（具体文件名）+ 三档定级 + **至少一条反方理由**
- [ ] 每个 🟢 / 🟡 候选有"最小接入形态" — 不是详细设计，是 ≤ 50 字的形状描述
- [ ] 给出 **ROI 排序前 3** 的"如果只做一个先做哪个"建议，附直觉成本估算（人天 / 文件影响数）
- [ ] 列出 ≥ 2 个**显式拒绝**的候选并说清为什么（避免文档只有"该做"没有"该拒"）
- [ ] 用户读完能回答 3 个问题：
  1. gbrain 哪个**架构思想**最值得抄？为什么？
  2. 哪个**听起来很酷但其实不该做**？为什么？
  3. 如果今天只能动一件事，最小动作是什么？

### 风险和假设

| 项 | 内容 |
|---|------|
| **风险 1** | 把"功能"误当成"架构思想"。**缓解**：每个候选必须能用 1 句话描述底层抽象（"X 是关于 Y 的一种取向"），不能只是"他们有 X 功能"。 |
| **风险 2** | 抄袭偏见（"他们做了我也要做"）。**缓解**：硬性要求每个候选写反方理由 + ≥ 2 个显式拒绝。 |
| **风险 3** | 与现有架构冲突没看出来（例：盲目引入 embedding 破坏确定性原则 / 引入 PGLite 破坏纯文件 Obsidian 兼容）。**缓解**：每个候选列冲突点。 |
| **风险 4** | 候选过多无法执行结论。**缓解**：最终必须给 ROI 排序前 3 + 显式拒绝 ≥ 2。 |
| **风险 5** | "架构思想"过于抽象沦为口号。**缓解**：每个思想必须配 gbrain 原文出处（文件 / 段落），且配本项目落点路径（具体到文件名）。 |
| **假设 1** | 用户已熟悉本项目当前架构（Memory v5 / instinct / hooks / orchestrator / skills / sprint）。若不熟，Phase 2 增加"当前架构画像"前置 Task。 |
| **假设 2** | 用户目的是"看清值得做什么 / 不做什么"，不是"看完立刻动手"。本 sprint 不进入实现。 |

---

## 技术方案

<!-- Phase 2 /plan 填写 -->

### 方案概述

研究类 sprint，6 个 Task 完成"抽取 → 定位 → 塑形 → 取舍"。Task 1-2 输入（抓 gbrain 关键源 + 写本项目架构画像），Task 3-4 核心分析（候选验证 + 融入草图），Task 5-6 输出收敛（三档定级 + ROI 排序 + 三问答）。所有产出落在本文档不同段落。Phase 4 用 `ce-doc-review` 类 agent 做交叉审查避免偏见。

### 候选思想池及其核心架构优点（Phase 2 概览，Phase 3 收敛到 6-10 个）

12 个候选分 4 组。每个候选给"底层抽象 + 架构优点 + 来源 + 本项目对应位置"四字段。

#### Group A — 知识层 / 检索层

##### C1 typed-link 零 LLM 提取

- **底层抽象**：write-time 确定性关系抽取，关系即时计算不延后到查询
- **架构优点**：
  - 关系在写入瞬间确定 → 零 token 消耗、零 LLM 重读
  - 关系是 markdown 链接 / frontmatter 字段 → grep / jq 可处理，无 embedding 黑盒
  - backlink 反向查询变成 O(1) ripgrep，而非数据库查询
  - 失败可重现：同 markdown 进入 → 同关系图出来
- **来源**：gbrain README §"The brain wires itself / Every page write extracts entity references and creates typed links (`attended`, `works_at`, `invested_in`, `founded`, `advises`) with zero LLM calls"
- **本项目对应**：Memory v5 topic notes（`projects/<hash>/memory/<topic>.md`）当前是孤岛文档，无显式关系图

##### C2 混合检索（graph + vector + BM25 + backlink-boost）

- **底层抽象**：多通道融合，单通道盲区互补
- **架构优点**：
  - 召回与精度分压不同通道：vector 拉召回，BM25 拉精度，graph 拉关联
  - 单通道服务不可用时仍可降级
  - backlink-boost 让"被多次引用的知识"自然排前，形成权威节点
  - 实测数据（gbrain BrainBench）：P@5 49.1 / R@5 97.9，graph 关闭对照组 -31.4 P@5
- **来源**：gbrain README §"P@5 49.1%, R@5 97.9% on a 240-page Opus-generated rich-prose corpus"
- **本项目对应**：当前 `scripts/inject-context.js` SessionStart 注入是"全量 dump MEMORY.md"，没有检索层，没有评分

##### C4 Brain-first lookup 协议

- **底层抽象**：外部调用前的本地知识检查从模型自由裁量变成协议要求
- **架构优点**：
  - 减少重复外部调用（同一问题不会问两次 WebSearch）
  - 给 hook 一个可观察点：能否在 WebFetch / WebSearch 前检测到 memory 查询
  - 检索失败时自动 fallback 外部，但路径强制
- **来源**：gbrain README §"brain-first.md 5-step lookup before any external API call"
- **本项目对应**：本项目 SessionStart inject 是被动注入，没有"模型主动 query 内部记忆"入口；instinct 系统也无"先查再答"协议

#### Group B — 处理 / 执行层

##### C3 "确定性 vs 判断"分流原则

- **底层抽象**：按"输入→输出是否一对一"分流到不同执行器（脚本 vs LLM）
- **架构优点**：
  - 确定性任务用脚本（零 token、不依赖 LLM 服务可用、ms 级延迟）
  - 判断性任务才进入 sub-agent / skill（消耗 token）
  - 路由本身用规则表，不需要 LLM 决定
  - 实测数据（gbrain Minions）：753ms vs gateway timeout（>10s）/ $0 vs $0.03
- **来源**：gbrain README §"The routing rule: Deterministic (same input → same steps → same output) → Minions / Judgment (input requires assessment) → Sub-agents"
- **本项目对应**：本项目 `scripts/` vs `skills/` 已有这个直觉，但没有显式原则文档 — 新人不知该写哪边

##### C10 Signal-detector 永远在线

- **底层抽象**：每条 user message 触发并行廉价模型抓 originals + entities，不阻塞主流程
- **架构优点**：
  - 永不漏抓 — 即使主对话未用到的洞见也被捕获
  - 廉价（haiku 级 + 并行）
  - 主对话零延迟增加
- **来源**：gbrain README §"signal-detector / Fires on every message. Spawns a cheap model in parallel to capture original thinking and entity mentions"
- **本项目对应**：本项目 PostToolUse hook 是事件驱动（工具调用触发），不是消息驱动（user message 内容触发）— 维度不同

##### C9 Cross-modal review + refusal routing

- **底层抽象**：第二模型对抗审查 + 主模型拒绝时自动切换
- **架构优点**：
  - 单模型容易过度自信 → 跨模型 review 作为质量门
  - refusal routing 解决"主模型今天不愿写 X 但任务合法"的卡顿
- **来源**：gbrain README §"cross-modal-review / Quality gate via second model. Refusal routing: if one model refuses, silently switch"
- **本项目对应**：本项目 `agent-orchestrator` 已有 claude（spec/review）+ codex（impl）双模型，但没有 refusal routing 概念

#### Group C — 学习 / 进化层

##### C5 评估闭环（BrainBench-Real / eval capture）

- **底层抽象**：检索效果从感觉变成可重放的数字
- **架构优点**：
  - 每次代码变更可重放历史 query，看是否回归
  - 三数字：Jaccard@k 检索一致性 / top-1 stability / latency Δ
  - opt-in 设计（环境变量），PII 脱敏
  - 不依赖标注数据 — 用"过去 vs 当前检索结果"做 self-diff
- **来源**：gbrain README §"BrainBench-Real (session capture, contributor opt-in) / GBRAIN_CONTRIBUTOR_MODE=1 / mean Jaccard@k, top-1 stability, latency Δ"
- **本项目对应**：本项目目前**没有任何注入有效性指标** — inject 改动只能靠手测

##### C6 Tiered enrichment + 自动升级

- **底层抽象**：知识对象按"被提及频次"自动升级处理深度
- **架构优点**：
  - 不需要预先标"哪些重要" — 频次自然识别
  - 节省 LLM 成本：80% 实体停在 T3 不进入深度 enrichment
  - 升级规则用计数器，确定性
  - 实测：1 次提及 = T3 stub / 3 次 = T2 web+social / 8+ 次 = T1 full pipeline
- **来源**：gbrain README §"Entity enrichment auto-escalates: a person mentioned once gets a stub page (Tier 3). After 3 mentions across different sources, they get web + social enrichment (Tier 2). After a meeting or 8+ mentions, full pipeline (Tier 1)"
- **本项目对应**：instinct 系统已有"置信度 0.3-0.9 → graduation"形式一致，但本项目按出现次数自动升级规则较隐式

#### Group D — 治理 / 边界层

##### C7 Soul audit 身份层

- **底层抽象**：把"agent 身份"显式拆为 SOUL（我是谁）/ USER（为谁）/ ACCESS_POLICY（能访问什么）/ HEARTBEAT（何时运行）四份文件
- **架构优点**：
  - 每份职责单一可独立 review
  - 隐私策略（4-tier ACCESS）从代码常量提升为文档
  - HEARTBEAT 把 cron 放在 markdown 而非 crontab，可读可改
- **来源**：gbrain README §"soul-audit / 6-phase interview generating SOUL.md (agent identity), USER.md (user profile), ACCESS_POLICY.md (4-tier privacy), HEARTBEAT.md (operational cadence)"
- **本项目对应**：本项目所有"身份信息"挤在 CLAUDE.md（个人偏好 + 方法论 + 规则）— 已超载

##### C11 AGENTS.md vs CLAUDE.md 双轨

- **底层抽象**：通用 agent 协议（AGENTS.md）与 Claude Code 专用怪癖（CLAUDE.md）分离
- **架构优点**：
  - 新 runtime 接入（Cursor / Cline / 自研）只读 AGENTS.md
  - CLAUDE.md 装 hooks 语法 / slash commands 等 Claude-only
  - llms.txt / llms-full.txt 配套机器可读地图
- **来源**：gbrain README §"start with AGENTS.md (or CLAUDE.md if you're Claude Code) / llms.txt for the documentation map"
- **本项目对应**：本项目已有 Claude / Codex 双副本但内容近乎相同（mechanical propagation），无 AGENTS.md 抽象层

##### C8 Thin harness + fat skills

- **底层抽象**：智能写在 markdown skill 里（LLM 直接读执行），runtime 仅做硬约束
- **架构优点**：
  - skill 文件自带运行逻辑 — 改 skill 无需改 runtime
  - LLM 可读懂、解释、改写自己执行的 skill
  - runtime 代码量降到最低 → bug surface 小
- **来源**：gbrain README §"Skill files are code / Thin harness, fat skills: the intelligence lives in the skills, not the runtime / docs/ethos/THIN_HARNESS_FAT_SKILLS.md"
- **本项目对应**：本项目走的是**反向哲学**（runtime 较重，`scripts/lib/` 承担 memory / contract / parity 等关键确定性逻辑）— **这是显式冲突点**

##### C12 Skill conformance gate

- **底层抽象**：skill 元数据校验从"靠自觉"提升为 CI 必跑
- **架构优点**：
  - 每个 skill 必有 frontmatter + 触发条件 + RESOLVER 覆盖
  - 漂移可被 CI 检测（新 skill 没注册 / 老 skill 触发失效）
  - exit code 友好（0 / 1 / 2）适合 pipeline 门控
- **来源**：gbrain README §"skillpack-check / Agent-readable gbrain health report. Exit code for CI; JSON for debugging" + §"testing skill / Validates every skill has SKILL.md with frontmatter, manifest coverage, resolver coverage"
- **本项目对应**：本项目 skill 越加越多，已出现漂移（`build-codex-plugin.js` 同步是 mechanical 复制，但内容一致性无 CI 校验）

### 任务拆解

- [ ] **Task 1**: 抓取 gbrain 关键源 — `gh api` 拉 CHANGELOG / docs/ethos/THIN_HARNESS_FAT_SKILLS.md / skills/RESOLVER.md / 3-5 个核心 skill（signal-detector / brain-ops / minion-orchestrator / cross-modal-review / enrich）。输出：补全每个候选的来源引用到段落 / 行号
- [ ] **Task 2**: 当前架构画像 — 写入文档「当前架构画像」段（~800 字），覆盖 Memory v5 / Instinct / 4-hook / Orchestrator / Skills / Sprint / Solution Index 七个模块的现状
- [ ] **Task 3**: 候选池验证 + 收敛到 6-10 个 — 删减 / 合并 / 改名；每个保留候选填齐四字段（底层抽象 / 核心架构优点 / 来源 / 本项目对应位置）
- [ ] **Task 4**: 融入草图 — 每个保留候选填四字段：落点（具体文件）/ 影响面（哪些既有部分要改）/ 冲突点（与现有原则的冲突）/ 最小接入形态（≤ 50 字）
- [ ] **Task 5**: 三档定级 + 反方理由 — 🟢 / 🟡 / 🔴 + 每个必填"不做的理由"
- [ ] **Task 6**: 输出收敛 — ROI 排序前 3 + ≥ 2 显式拒绝 + 三问回答（最值得抄 / 不该做 / 今天只动一件）

### 测试策略

研究类 sprint 的"测试" = **自审清单**（不是单元 / 集成 / E2E）：

| 项 | 必须满足 |
|---|---------|
| 每个候选有 1 句底层抽象描述 | ✅ / ❌ |
| 每个候选有原文引用（文件 + 段落） | ✅ / ❌ |
| 每个候选有本项目落点（具体文件名） | ✅ / ❌ |
| 每个候选有 ≥ 1 条反方理由 | ✅ / ❌ |
| 每个 🟢 / 🟡 有最小接入形态（≤ 50 字） | ✅ / ❌ |
| ROI 排序前 3 有人天估算 | ✅ / ❌ |
| 显式拒绝 ≥ 2 | ✅ / ❌ |
| 三问可由文档自身回答（不需再问 AI） | ✅ / ❌ |

Phase 4 review 用 `ce-doc-review` / `ce-coherence-reviewer` 类 agent 跨视角审查偏见。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| gbrain 资源抓不全（速率限制 / 私有内容） | 中 | 中 | T1 限定 5 个文件，超时跳过；候选引用降级为 README 段落级 |
| 候选合并后维度漂移（4 字段不齐） | 中 | 高 | T3 强制四字段齐 |
| 三档定级被偏见污染（容易"听起来酷就 🟢"） | 高 | 中 | T5 强制反方理由；Phase 4 用 doc-reviewer 交叉审查 |
| 上下文压力（12 候选 × 4 字段 + 架构画像 + 引用 + sprint 文档其他段） | 中 | 中 | T2 后评估，必要时触发 `/checkpoint` |
| 显式拒绝凑数（为了凑数而拒绝） | 低 | 中 | 鼓励真实拒绝；2 是下限不是上限 |
| gbrain README 已变（频繁 push） | 低 | 低 | 文档标注 "as of 2026-05-11" |

### 涉及文件

**输出（仅写一个文件）**：
- `docs/plans/2026-05-11-gbrain-gstack-analysis.md`

**读取（gbrain 远端，T1 任务）**：
- `gh api repos/garrytan/gbrain/contents` 顶级清单
- `README.md`（已抓 ~80%）/ `CHANGELOG.md` / `docs/ethos/THIN_HARNESS_FAT_SKILLS.md` / `skills/RESOLVER.md`
- 3-5 个核心 skill：`signal-detector` / `brain-ops` / `minion-orchestrator` / `cross-modal-review` / `enrich`

**读取（本项目，T2/T4 任务）**：
- `CLAUDE.md` / `.claude/rules/architecture.md` / `.claude/rules/debugging-gotchas.md`
- `scripts/lib/memory-v5.js` / `scripts/inject-context.js` / `scripts/agent-orchestrator.js`
- `user-commands/` 全集 / `user-skills/` 全集
- 历史 plan：`docs/plans/2026-04-24-codex-memory-v5.md` / `docs/plans/2026-04-27-agent-orchestrator-v6.md`

---

## 实现进度

<!-- Phase 3 /work 填写 -->

### T1 输出 — gbrain 精确引用清单（2026-05-11）

抓取于 2026-05-11，16 个源文件保存在 `.agent-runs/_gbrain-fetch/`（gitignored）。每候选 1-2 句原文，行号或段落级精确引用。

**C1 typed-link 零 LLM 提取**  
源：`brain-ops.md` §Phase 2.5 "Structured Graph Updates (automatic)"
> Every `put_page` call automatically extracts entity references and writes them to the graph (`links` table) with inferred relationship types. Inferred link types: `attended` (meeting → person), `works_at`, `invested_in`, `founded`, `advises`, `source` (frontmatter), `mentions` (default). Stale links (refs no longer in the page text) are removed in the same call. This is "auto-link" reconciliation. The `put_page` MCP response includes `auto_links: { created, removed, errors }`.

**C2 混合检索 + backlink-boost**  
源：README §benchmark 段  
> P@5 49.1%, R@5 97.9% on a 240-page Opus-generated rich-prose corpus, beating its own graph-disabled variant by +31.4 points P@5 and ripgrep-BM25 + vector-only RAG by a similar margin. The graph layer plus v0.12 extract quality together carry the gap.

**C3 确定性 vs 判断分流**  
源（双源）：(1) `minion-orchestrator.md` §"Route the Request" 决策表; (2) `THIN_HARNESS_FAT_SKILLS.md` §Definition 4 "Latent vs. Deterministic"
> (Def 4) Latent space is where intelligence lives. The model reads, interprets, decides. Judgment. Synthesis. Pattern recognition. Deterministic is where trust lives. Same input, same output. Every time. SQL. Code. Numbers. The worst systems put the wrong work on the wrong side.  
> (Decision Guide) If it's a lookup table, it's code. If the agent needs to think, it's a skill.

**C4 Brain-first lookup 协议**  
源：`brain-first.md` §"The Lookup Chain (MANDATORY ORDER)"
> 1. `search` first — keyword search, fast, zero API cost.  
> 2. `query` if search is thin — hybrid semantic search, uses embedding API.  
> 3. `get_page` if you found a slug — read the full compiled truth.  
> 4. External APIs only after steps 1-2 return nothing useful.  
> Never skip to external APIs without completing steps 1-2. Score > 0.5 = use it.

**C5 评估闭环 (BrainBench-Real)**  
源：`eval-bench.md` §"The 4-command loop" + `eval-capture.md` §"Row schema (v1)"
> Capture (writes to `eval_candidates` when `GBRAIN_CONTRIBUTOR_MODE=1`) → Snapshot (`gbrain eval export --since 7d > baseline.ndjson`) → Code change → Replay (`gbrain eval replay --against baseline.ndjson`). 三指标：Mean Jaccard@k / Top-1 stability / Mean latency Δ. CI: `jq -e '.summary.mean_jaccard >= 0.85' replay.json || exit 1`. Off by default for production users (privacy-positive).

**C6 Tiered enrichment 自动升级**  
源：`enrich.md` §"Enrichment Tiers" 表 + signal-detector.md §"Phase 2" tier escalation
> Tier 1 (key, inner circle) → Full pipeline / All available APIs + deep web research.  
> Tier 2 (notable, occasional interactions) → Moderate / Web research + social + brain cross-ref.  
> Tier 3 (minor, worth tracking) → Light / Brain cross-ref + social lookup if handle known.  
> README 自动升级规则：1 次提及 = T3 stub / 3 次跨源 = T2 web+social / 8+ 次或一次会议 = T1 full。Auto-link post-hook on `put_page` 自动建立 entity link，无需手工调用。

**C7 Soul audit 身份层**  
源：`soul-audit.md` §"Phases" 6 段
> Phase 1 Identity Interview → SOUL.md identity. Phase 2 Vibe Calibration (4 communication styles) → SOUL.md vibe. Phase 3 Mission Mapping → SOUL.md mission. Phase 4 User Profile → USER.md. Phase 5 Boundaries (4 tiers Full/Work/Family/None) → ACCESS_POLICY.md. Phase 6 Operational Cadence → HEARTBEAT.md. Each phase is independent and re-runnable. NEVER ships pre-filled content.

**C8 Thin harness + fat skills**  
源：`docs/ethos/THIN_HARNESS_FAT_SKILLS.md` 全篇（Garry Tan 2026 YC Spring talk）
> Push intelligence UP into skills. Push execution DOWN into deterministic tooling. Keep the harness THIN. 三层架构：Fat skills (markdown procedures, 90% of value) on top / Thin CLI harness (~200 lines) in middle / Your app (deterministic foundation) on bottom. CLAUDE.md was 20,000 lines — the model's attention degraded. The fix: about 200 lines. Just pointers to documents. **关键发现**：与本项目"runtime 重，scripts/lib 承载关键逻辑"是 180° 反向哲学。

**C9 Cross-modal review + refusal routing**  
源：`cross-modal-review.md` §"When to invoke" + §"Refusal routing"
> When to invoke: Significant code changes (5+ files / 100+ lines) / Security-sensitive / Stuck or churning 2+ iterations / Pre-bulk-operation / Skill creation. Refusal routing: If primary review model refuses, switch silently to next model in chain (`conventions/cross-modal.yaml`). Don't show refusal to user. If ALL refuse, escalate. **关键发现**：v0.25.1 已添加 `/codex review` 显式 handoff — gstack 提供 Codex CLI 包装，cross-modal-review 调度时机；本项目 `agent-orchestrator` 已有相似 claude↔codex 二人转，但无 refusal 机制。

**C10 Signal-detector 永远在线**  
源：`signal-detector.md` §Contract + §Phase 1
> Fires on every inbound message (no exceptions unless purely operational). Runs in parallel (spawned, never blocks main response). Captures ideas with the user's EXACT phrasing (no paraphrasing). Two equal-priority captures: Phase 1 Idea/Observation Detection (PRIMARY) → originals/{slug} / concepts/{slug} / ideas/{slug}; Phase 2 Entity Detection (SECONDARY). "Original thinking is AT LEAST as valuable as entity extraction. Ideas are the intellectual capital."

**C11 AGENTS.md vs CLAUDE.md 双轨**  
源：README §"LLMs / Agents" + §"On an agent platform"
> **LLMs:** fetch `llms.txt` for the documentation map, or `llms-full.txt` for the same map with core docs inlined in one fetch. **Agents:** start with `AGENTS.md` (or `CLAUDE.md` if you're Claude Code). `AGENTS.md` is the non-Claude agent operating protocol (install, read order, trust boundary, common tasks).

**C12 Skill conformance gate**  
源（双源）：`testing.md` Mode 1 §"Skill conformance validation" + `skillpack-check.md` §"Contract" / §"Exit code"
> testing Mode 1 contract: Every SKILL.md has valid YAML frontmatter (`name`, `description`) / `skills/manifest.json` lists every skill directory / `skills/RESOLVER.md` references every skill in the manifest / No MECE violations (duplicate triggers across skills). CI gated by `bun test test/skills-conformance.test.ts test/resolver.test.ts`.  
> skillpack-check exit code: `0` healthy / `1` action needed (read `actions[]`) / `2` could not determine. Daily cron pattern: `gbrain skillpack-check --quiet`.

#### 附加发现（不入候选池）

- **Storage tiering** (`docs/storage-tiering.md`): `db_tracked` 目录 (git, human-edited) vs `db_only` 目录 (machine-generated, gitignored, `gbrain export --restore-only` 重建). 仅在 brain repo 突破 50K-200K 文件时有意义；本项目用不到。
- **gbrain 与 GStack 显式协同** (`skills/RESOLVER.md` §"Thinking skills (from GStack)"): "These skills come from GStack. If GStack is installed, the agent reads them directly. If not, brain-only mode still works (brain skills function without thinking skills)." 印证 gbrain ≠ gstack 替代者，而是知识层补充；同源同生态。

### T2 输出 — 当前架构画像（tech-persistence as of 2026-05-11）

本项目是一个**针对开发者工作流的自进化工程系统**，运行在 Claude Code + Codex 双 runtime 上。7 个模块各司其职：

#### 1. Memory v5 — 项目锚定的多层记忆

- **做什么**：`scripts/lib/memory-v5.js` 维护 `projects/<hash>/MEMORY.md`（轻量索引，≤ 200 行 / 25KB，`indexMaxEntries: 40`）+ `memory/<topic>.md`（topic 文件，按 architecture / debugging / testing / toolchain / workflow / security / performance / code-style / api-design / general 分类，每个 ≤ 80 entries）。observe 写入、inject 注入、evolve 毕业到永久 rules。`minMemoryConfidence: 0.45` 门控。
- **显著局限**：topic notes 是孤岛文档，**无显式关系图**；检索是"文件名匹配 + grep"级别，**无评分**；MEMORY.md 注入是全量 dump（CONTEXT_BUDGET_CHARS = 12000），未按 query 检索。

#### 2. Instinct 系统 — 置信度驱动的本能层

- **做什么**：观察 → 本能（confidence 0.3-0.9）→ ≥ 0.9 毕业到 `rules/architecture.md` / `rules/debugging-gotchas.md` 等永久知识。`scripts/evaluate-session.js` 在 Stop hook 抽取经验。
- **显著局限**：置信度升级主要靠人工 `/evolve`；**自动升级规则较隐式**，没有"按提及频次自然升级"的闭环；本能与 Memory v5 topic notes 之间的关系靠目录约定，无强约束。

#### 3. 4-Hook 系统 — 事件驱动观察

- **做什么**：SessionStart (`inject-context.js`，注入 handoff/sessions/instincts) / PreToolUse / PostToolUse (`observe.js`，记录工具调用) / Stop (`evaluate-session.js`，提取经验)。Claude Code 与 Codex 各有副本，由 `build-codex-plugin.js` 同步。
- **显著局限**：触发是**工具调用驱动**（when tool fires）而非**消息驱动**（每条 user message）；catch 块强制 stderr 至少一行日志（已记入 debug-gotchas 2026-05-09）；hook 内不能 crash 主会话但需可观察。

#### 4. Agent Orchestrator (v7) — Claude + Codex 二人转

- **做什么**：`scripts/agent-orchestrator.js` 主入口 + `scripts/agent-orchestrator/` 12 子模块（pipeline-state / queue / locks / global-contract / slice-normalizer / drift-detector / reconciliation / slice-planner / review / slice-runner / pipeline-providers / pipeline）。Claude (spec/review) → Codex (impl) → Claude (review)。支持 `--pipeline` 分片和 `--auto` 自动审查。`doctor` / `doctor --probe` 健康检查。
- **显著局限**：双模型协作但**无 refusal routing**；provider 错误处理（envelope 提取）2026-05-11 才修好；健康检查手工触发，无 cron。

#### 5. Skills 系统 — 双运行时副本

- **做什么**：源在 `user-level/skills/<name>/SKILL.md`（Claude，dir-per-skill）→ `.codex/skills/<name>/SKILL.md`（Codex）经 `build-codex-plugin.js` 机械派生；`propagate-command-changes.js` 同步命令副本。约 30+ skill + 20+ command。
- **显著局限**：skill 元数据校验**靠自觉**，无 frontmatter / RESOLVER / MECE 的 CI 门控；多副本派生靠 build 脚本，但**内容漂移**靠 git tracked 检测；skill 体积越加越大未审查。

#### 6. Sprint Workflow — 5 阶段角色切换

- **做什么**：think → plan → work → review → compound（gstack 方法论）。`/sprint`、`/work`、`/review` 等命令配套 `--auto` / `--caveman` 参数；产出 `docs/plans/YYYY-MM-DD-<slug>.md`。每 5 Task 评估 checkpoint。
- **显著局限**：阶段切换基本**同步**，无 background job / 异步队列；`/sprint` 适合 30 分钟-2 小时任务，更长靠 checkpoint 切片；没有效果评估闭环（即"上次 plan 是否有效"）。

#### 7. 解决方案索引 — 知识沉淀末端

- **做什么**：`CLAUDE.md` 顶部"解决方案索引"段按 日期 + 标签 + 一句话 + 链接列出每次重大修复或决策；`docs/solutions/<date>-<slug>.md` 是详细 doc；`docs/plans/<date>-<slug>.md` 是 sprint 工件。
- **显著局限**：完全人工维护；**没有自动 candidate**（从 git log / sessions / debug-journals 抽取）；索引体量未控。

#### 跨模块隐式原则（未显式文档化但实际遵守）

- **多运行时 parity**：Claude / Codex 必须同步副本（mechanical propagation），git tracked 派生文件不能手工 Edit
- **Obsidian 兼容**：所有 markdown 用 frontmatter + 标准链接，vault 可直接浏览
- **确定性 > 智能**：`scripts/lib/` 承载关键 deterministic 逻辑（memory parsing / contract / parity），不依赖 LLM
- **轻量优先**：**不**引入数据库（PGLite / Postgres）、**不**引入 embedding 服务、**不**引入永久后台进程 — 全文件系统

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-11 | T1 | 抓取 16 个 gbrain 关键源（CHANGELOG / RESOLVER / 9 SKILL.md / THIN_HARNESS_FAT_SKILLS / brain-first / eval-bench / eval-capture / storage-tiering），输出每候选精确引用清单到「T1 输出」段；发现 Storage tiering 不入候选池、gbrain RESOLVER 显式引用 GStack 印证两者协同。 |
| 2026-05-11 | T2 | 写入「当前架构画像」段：7 模块（Memory v5 / Instinct / 4-Hook / Orchestrator / Skills / Sprint / Solution Index）+ 4 条跨模块隐式原则。Glob 校验 `scripts/` 目录形状，Read `memory-v5.js` 与 `inject-context.js` 确认常量（CONTEXT_BUDGET_CHARS=12000、indexMaxLines=200、minMemoryConfidence=0.45）。 |
| 2026-05-11 | T3 | 候选池验证：12 候选全部通过 primary source 验证（详见 T1 输出引用），不删不合并不改名。理由：每个候选代表一个**清晰可辨的架构选择**，强行合并会丢失评估颗粒度；存在的 1 个边缘情况（C11 AGENTS.md 材料较薄）保留候选状态但预期在 T5 定级 🔴。Storage tiering（不在候选池）已在 T1 段标为附加发现。 |
| 2026-05-11 | T4 | 12 候选融入草图：每个填 4 字段（落点 / 影响面 / 冲突点 / 最小接入形态 ≤ 50 字）。重度冲突 4 个（C2 / C10 / C8 / C7），中度冲突 1 个（C5）。8 项自审中 T4 应满足的 3 项全勾。 |
| 2026-05-11 | T5 | 三档定级：🟢 6（C1 / C3 / C4 / C6 / C9 / C12）/ 🟡 3（C2 / C5 / C7）/ 🔴 3（C8 / C10 / C11）。每个候选必填反方理由（含 🟢 的"不做的理由"），避免一边倒。C8 拒绝的核心被 C3 ADR 吸收，形成一举两得的取舍链条。 |
| 2026-05-11 | T6 | ROI 排序前 3：① C12 Skill conformance（1 人天，解决已发生痛）② C3 ADR 决策表（0.5 人天，零代码）③ C1 typed-link（2-3 人天，5 年最值钱）。显式拒绝 3 个（C8 / C10 / C11）。三问回答：最值得抄 = C1（5 年复利），听起来酷但不该做 = C8（thin harness 反向哲学），今天只动一件 = C3 ADR-010（30 分钟）。 |
| 2026-05-11 | Phase 4 | Spawn 3 个并行 reviewer（coherence / product-lens / feasibility）。共抓 15 处问题，无伪阳性。**自动修 8 处** P0/P1/P2 机械错误：(1) T2 + T4 C12 路径 `user-skills/` → `user-level/skills/<name>/`；(2) T4 C11 + T5 反方 — AGENTS.md 已存在但是未初始化模板；(3) T4 C5 — `SECRET_PATTERNS` 未导出，应调用 `redactSensitive`；(4) T4 C2 冲突等级 重度 → 中度（分阶段）；(5) T4 C1 影响面加 `inject-context.js` budget 交互；(6) T6 C12 人天 1 → 1.5-2（含 plugin 副本同步）；(7) T6 Q3 添加完整 slug；(8) C12 最小接入形态加 plugin 同步注意事项。**5 处语义级 P0/P1 待用户决定**（不能机械修）。 |
| 2026-05-11 | Phase 4 reframe (fix all) | 用户选择 fix all，5 处语义级 reframe 全部应用为「Phase 4 后置」覆盖性结论（Phase 1-3 保留为 audit trail）：(a) **项目身份界定** — tech-persistence 是 developer-toolchain self-evolution sibling，不是 gstack/gbrain 替代；4 条不可妥协原则显式化。(b) **ROI 重排** — 旧 C12 → C3 → C1（speed-wins biased）改为 **C1 → C3 → C5-capture**（5 年杠杆 / 维护表面），C12 仍 🟢 但掉出 top-3 因痛是想象的。(c) **Solo reframe** — anchor 全文从"人天/onboarding"替换为"维护表面/记得性/测量过的痛"；C3 / C12 / C6 反方理由具体修订。(d) **推荐 Trajectory A** — memory-as-graph (C1 → C5-capture → C6) 三者互相强化，不是 3 个 orthogonal 赌注。(e) **C6 机制反方** — 针对 3 mentions / +0.1 / 0.9 阈值的时间分布盲点 + 0.9 毕业过冲，限定仅在 [0.3-0.7] 自动 + 跨 session 计数。三问回答与 Phase 3 一致（C1 / C8 / C3 ADR-010），reframe 强化而非推翻。 |
| 2026-05-11 | Phase 5 (Compound) | 提取 7 条经验写入「复利记录」段（identity-question-first / solo-ROI 公式 / trajectory vs orthogonal / 多视角 review 不可省略 / audit-trail vs overwrite / typed-link 最值得抄 / reviewer 揭示盲点）。沉淀到永久知识：(1) `CLAUDE.md` 项目「解决方案索引」段新增 entry 引用本 sprint；(2) `.claude/rules/architecture.md` 新增 **ADR-011 identity-question-first 原则** — 未来任何外部思想评估 sprint 必须先回答身份问题、按 5 年杠杆排 ROI、至少 spawn 1 个 product-lens reviewer。Status 切到 completed。 |

### T4 输出 — 12 候选融入草图（落点 / 影响面 / 冲突点 / 最小接入形态）

**说明**：每个候选 4 字段。最小接入形态控制在 ≤ 50 字。落点路径基于 T2 架构画像。冲突点与 4 条跨模块隐式原则（多运行时 parity / Obsidian 兼容 / 确定性 > 智能 / 轻量优先）对照。

#### Group A — 知识层 / 检索层

##### C1 typed-link 零 LLM 提取

- **落点**：`scripts/lib/memory-v5.js` 新增 `extractTypedLinks(content)`；写入 topic note 时同步生成 frontmatter `links:` 字段
- **影响面**：memory-v5 写入路径加一步；MEMORY.md 索引可展示反向引用计数；observe.js 不受影响；**`inject-context.js` 读端需更新** — 当前 `CONTEXT_BUDGET_CHARS = 12000` 全量 dump，新增 backlink 列后 per-entry 宽度变化导致 fewer entries fit，渲染逻辑需识别 backlink 列并配套调整 budget 计算
- **冲突点**：与"轻量优先"弱冲突（引入正则解析）；零 LLM 依赖故不破坏确定性；正向符合 Obsidian 兼容（wikilink 是原生格式）
- **最小接入形态**：write-time 解析 `[[topic-name]]` wikilink + 已知 topic id 提及，写 frontmatter `links: [...]`，MEMORY.md 加反向引用计数列

##### C2 混合检索（graph + vector + BM25）

- **落点**：`scripts/inject-context.js` 改"全量 dump"为分数化检索 + 新增 `scripts/lib/retrieval.js`
- **影响面**：SessionStart 注入流变；MEMORY.md 角色从"全量索引"→"top-K 命中"；可能需 embedding provider 或本地 model
- **冲突点**：**中度冲突 — 分阶段可控**：初期 BM25 + wikilink 图遍历**纯 JS 实现可规避所有原则冲突**；只在引入 vector / embedding 时才出现"重度冲突 — 轻量优先 + 全文件系统"（vector 索引需 SQLite / LanceDB）+ "弱冲突 — 确定性"（embedding 非确定）；与 Obsidian 兼容不直接冲突但 vector 阶段会增加 .gitignore 噪音
- **最小接入形态**：**只做 BM25 + wikilink 图遍历**（纯 JS，无 embedding），触发条件 MEMORY.md > 50 entries 时启用，<50 时仍用全量 dump

##### C4 Brain-first lookup 协议

- **落点**：新增 `user-skills/memory-first.md` skill；可选 PreToolUse hook 在 WebFetch / WebSearch 前打印软提醒
- **影响面**：skill 一份 + Codex 副本；hook 软观察不强制；调研类命令（`/think` / `/plan`）显式引用
- **冲突点**：hook 能记录不能拦截（已生成 tool call 不可改）→ 属软提醒；与 Obsidian / 确定性 / 轻量无冲突
- **最小接入形态**：1 个 skill 描述"外部调用前先 grep Memory v5 + 查 instinct" + PreToolUse hook 在 WebFetch / WebSearch 时打印一行"💡 检查 memory? 本次 inject 含: ..."

#### Group B — 处理 / 执行层

##### C3 确定性 vs 判断分流

- **落点**：`CLAUDE.md` 顶部新增 ADR-010；`docs/solutions/2026-05-11-deterministic-vs-judgment.md` 详细决策表
- **影响面**：**无代码改动**；指导未来"script 还是 skill"决策；新人 onboarding
- **冲突点**：无 — 本项目实际已遵循，只是未显式文档化
- **最小接入形态**：1 个 ADR + 1 张 5 行决策表（"输入→输出确定 → script / 需判断 → skill / 查表 → script / 多步骤 LLM 推理 → skill"）

##### C10 Signal-detector 永远在线

- **落点**：**无现有落点** — 本项目 hook 是工具调用驱动；消息驱动需 UserPromptSubmit hook（Claude Code 提供，Codex 无对应）
- **影响面**：需新 hook + 并行 Haiku 调用；与 Codex parity 严重失衡（Codex 不支持消息级 hook）
- **冲突点**：**重度冲突 — 多运行时 parity**（Codex 无对应入口）；**中度冲突 — 轻量优先**（每条 message 触发 LLM 即使廉价也累积成本）；**轻度冲突 — 用户控制**（用户无感的 LLM 调用）
- **最小接入形态**：**只做手动版** — `/capture` 命令显式触发抓 entity / original，不做 always-on；保留思想，放弃机制

##### C9 Cross-modal review + refusal routing

- **落点**：`scripts/agent-orchestrator/review.js` 加 refusal 模式检测；`scripts/agent-orchestrator/pipeline-providers.js` 加 provider chain
- **影响面**：review 阶段输出含拒绝模式时切换 fallback provider；orchestrator config 新增 `reviewProviderChain`
- **冲突点**：无显著冲突 — 本项目已有 claude + codex 双模型，refusal routing 是增量；与"用户控制"对齐（gbrain 也强调 informational + user sovereignty）
- **最小接入形态**：检测 review 输出含 "I can't / unable to / cannot" 等 refusal pattern → 切到 chain 中下一 provider → 全 chain 拒绝时报错给用户

#### Group C — 学习 / 进化层

##### C5 评估闭环（BrainBench-Real / eval capture）

- **落点**：新增 `scripts/lib/memory-eval-capture.js`；`scripts/inject-context.js` 在注入时记 NDJSON；`scripts/eval-replay.js` 命令；`user-commands/eval-replay.md`
- **影响面**：opt-in（env var `TECH_PERSISTENCE_EVAL_CAPTURE=1`）；新增 NDJSON schema（`session_id` / `injected_topics` / `query_hash` / `latency_ms`）；PII 脱敏**调用 `redactSensitive(text)`**（memory-v5.js line 519 已 export；`SECRET_PATTERNS` 本身未导出但 `redactSensitive` 内部用它）
- **冲突点**：与"无后台进程"弱冲突（capture 同步内嵌，replay 命令是手工触发 → 没破）；与"轻量优先"中等冲突（NDJSON 文件长期累积，需 rotation）
- **最小接入形态**：inject 时记 `{session_id, injected_topic_ids, char_count}` 到 NDJSON；`/eval-replay --since 7d` 对比当前 inject 与历史的 Jaccard@k；3 指标：Jaccard@k / top-1 stability / latency Δ

##### C6 Tiered enrichment 自动升级

- **落点**：`scripts/evaluate-session.js` 加 mention counter；instinct 文件 frontmatter 复用 `confidence`，不引入新 `tier`
- **影响面**：本能升级从"靠人工 /evolve"变为"自动 mention count + 阈值"；rules graduation 阈值与现有 0.9 配合
- **冲突点**：与现有 confidence 机制部分重叠 — **不要再加 tier 字段**（冗余）；只在 evaluate-session 里加 mention 自增
- **最小接入形态**：复用 confidence 段位映射 tier — `[0.3-0.5] = T3 stub / [0.5-0.7] = T2 / [0.7+] = T1`；evaluate-session 每次记录 instinct 时 mention count +1，达 3 次提升 confidence +0.1（封顶 0.9）

#### Group D — 治理 / 边界层

##### C7 Soul audit 身份层

- **落点**：仅借鉴**职责单一文件**思想 — 把 CLAUDE.md 当前的"关于我 + 编码偏好"段拆到新文件 `USER.md`；**不**引入 SOUL.md / HEARTBEAT.md / ACCESS_POLICY.md
- **影响面**：CLAUDE.md 瘦身 ~30 行；新增 USER.md；指针 `[详见 USER.md](./USER.md)`
- **冲突点**：**与本项目定位错配** — gbrain 的 soul-audit 假设 agent 是 personal assistant（HEARTBEAT 假设 cron / ACCESS_POLICY 假设多人）；本项目是开发者工具链，不需要这些
- **最小接入形态**：只提取一份 `USER.md`（个人偏好 + 编码偏好）；其他 3 个文件不创建

##### C11 AGENTS.md vs CLAUDE.md 双轨

- **落点**：项目根 `AGENTS.md` **已存在但是未初始化模板**（仍含 `[项目名称]` 占位符 + "请将 X 替换为实际名称"）；操作是"填充模板"而非"新建文件"
- **影响面**：填充后内容大量与 CLAUDE.md 重叠；现有 mechanical propagation 已解决跨 runtime 副本同步
- **冲突点**：**填充也是 documentation duplication，不解决任何当前痛点** — 本项目已有 Claude / Codex 双 runtime parity；填充 AGENTS.md 仅在接入第 3 个 runtime（Cursor / Cline）时才有边际收益
- **最小接入形态**：**保留模板未初始化状态**；若 6 个月内接入第 3 个 runtime，再正式填充

##### C8 Thin harness + fat skills

- **落点**：现有 `scripts/lib/` 不动；显式 ADR 重述本项目的**反向哲学**
- **影响面**：无代码；新增 ADR-011 说明"为何本项目 harness 不能 thin"
- **冲突点**：**180° 反向** — gbrain "fat skills" 主张判断性逻辑全部入 markdown，runtime 仅约束。本项目 `scripts/lib/`（memory parsing / contract / parity / orchestrator state machine）是**确定性 trust-critical** 逻辑，必须在 deterministic 层；agent-orchestrator 的 12 子模块（pipeline-state / locks / reconciliation）若挪到 skill 会破坏 trust
- **最小接入形态**：**显式反方采纳** — ADR 写"判断性 → skill，确定性 → scripts/lib"；不动现有代码；不写"200 行 thin harness"（我们的 harness 不该 thin）

##### C12 Skill conformance gate

- **落点**：新增 `scripts/check-skills-conformance.js`；`package.json` 加 npm script；可选 git pre-commit
- **影响面**：所有 SKILL.md 需 frontmatter（`name` / `description` / 可选 `triggers`）；MECE 检测（重复 trigger）；CI 校验类似已有 `validate-codex-plugin.js`
- **冲突点**：无 — 与本项目"多副本同步 + mechanical propagation"完全一致
- **最小接入形态**：1 个脚本扫描 `user-level/skills/*/SKILL.md` + `.codex/skills/*/SKILL.md` + `plugins/tech-persistence/skills/`，校验 frontmatter 必填字段 + duplicate trigger 检测 + 副本 hash 对比；exit 0 / 1 / 2 三档。**注意**：因 git tracked 派生文件，脚本本身也要靠 `build-codex-plugin.js` 同步到 plugin 副本（参见 debug-gotchas 2026-05-09）。

### T4 自审

8 项 Phase 2 自审清单中 T4 应满足的 3 项：

- [x] 每个 🟢 / 🟡 / 🔴 候选有最小接入形态（≤ 50 字描述）— 12 候选全部填写
- [x] 落点为具体文件名 — 12 候选全部具体（scripts/lib/memory-v5.js / inject-context.js / agent-orchestrator/review.js / CLAUDE.md / 新增脚本路径等）
- [x] 冲突点与跨模块隐式原则（轻量优先 / 多运行时 parity / 确定性 / Obsidian 兼容）显式对照 — 4 候选标"重度冲突"（C2 / C10 / C8 / C7），1 候选标"中度冲突"（C5），其余轻或无冲突

### T5 输出 — 三档定级 + 反方理由

**汇总**：🟢 6 / 🟡 3 / 🔴 3。每个候选必填反方理由（包括 🟢 的"不做的理由"），避免一边倒。

#### 🟢 建议采纳（6）

##### C1 typed-link 零 LLM 提取 — 🟢

- **主理由**：write-time 确定性、零 LLM 成本；与 4 条隐式原则**全部兼容**（轻量 / Obsidian / 确定性 / parity）；当前缺失的场景（topic-note 引用关系）真实存在；最小形态只需 memory-v5.js 加一步。
- **反方理由**：本项目 topic notes 当前体量小（每项目几十个），backlink 价值未必显现；可能 6 个月后才回本，**先做的机会成本是其他更紧迫的活**（例如 C12 conformance gate 解决"skill 漂移"是已经发生的痛）。

##### C3 确定性 vs 判断分流原则 — 🟢

- **主理由**：本项目实际已遵循只是未显式文档化；代价**极低**（1 个 ADR + 1 张决策表）；新人 onboarding 大幅受益；正好同时回答 C8 thin/fat 的反方部分（一举两得）。
- **反方理由**：写 ADR 是义务性产出，没有触发它的真实痛点；当前是单人维护，未来 6 个月若不扩团也不增 runtime，文档化优先级低；ADR 写完 1 个月没被引用就是死文档。

##### C4 Brain-first lookup 协议 — 🟢

- **主理由**：与现有 `inject-context.js` + `observe.js` 完全兼容（增量软提醒，不动现有路径）；skill 一份代价低；hook 软观察可记录"是否在外部调用前查 memory"行为数据。
- **反方理由**：hook **不能强制**（已生成的 tool call 无法改），软提醒沦为"装饰性输出"风险高；若用户不读 skill 描述（或 skill 没被 RESOLVER 命中）则等于没做。

##### C6 Tiered enrichment 自动升级（按提及频次）— 🟢

- **主理由**：本项目 instinct 系统**天然适配**（已有 confidence 0.3-0.9）；**不引入新 tier 字段**（复用 confidence）；evaluate-session 加 mention counter 是 5 行改动；改善"靠人工 /evolve"导致升级滞后的问题。
- **反方理由**：当前手工 `/evolve` 工作不大且**给用户控制感**；自动升级可能在低质量观察上误升，毕业到 rules 后撤回成本高；阈值 0.1 增幅可能需多次调优。

##### C9 Cross-modal review + refusal routing — 🟢

- **主理由**：本项目 `agent-orchestrator` 已有 claude + codex 双模型协作，refusal routing 是**增量**（不重写架构）；与 user sovereignty 原则一致（gbrain 也强调 informational + user decides）；落点明确 `agent-orchestrator/review.js` + `pipeline-providers.js`。
- **反方理由**：refusal 模式检测是**字符串匹配**（脆弱）— "I can't" / "unable to" 等关键词容易误检合法输出（如 "I can't find this in the codebase" 是合法 review 结论而非 refusal）；少量误检累积下来可能令人混乱。

##### C12 Skill conformance gate — 🟢

- **主理由**：与本项目"多副本同步 + mechanical propagation"哲学**完全一致**；已有 `validate-codex-plugin.js` 是同类模式（验证 Codex 副本完整性）；代价低（1 个脚本 ~150 行）；解决**已经发生**的痛（skill 越加越多无统一校验）。
- **反方理由**：当前 skill 数量 ~30 个**还未爆炸**，半年后再做也来得及；现在加一个脚本不解决紧迫问题；可能引入新的 CI 失败源（如本地 skill 编辑后忘 propagate 时 conformance 报错，反而打断流程）。

#### 🟡 部分借鉴（3）

##### C2 混合检索 — 🟡（只采纳 BM25 + 图遍历）

- **主理由**：评分化检索的核心思想（多通道融合、backlink boost）有价值；BM25 + wikilink 图遍历**纯 JS 可实现**（如 `flexsearch` 或手写）；不引入 vector / embedding 即可吃到 80% 收益。
- **反方理由**：本项目 SessionStart inject 总预算只有 12000 字符，全量 dump 完全够用；引入检索层是"为复杂度做准备"而非"现在就受益"；条件触发（MEMORY.md > 50 entries 才启用）多数项目永远触发不到。
- **采纳边界**：只在 MEMORY.md 真的超过 50 entries 时切换；vector / embedding **绝不引入**（破坏轻量 + 确定性原则）。

##### C5 评估闭环 — 🟡（只采纳 capture，replay 暂缓）

- **主理由**：评估缺失是**真问题** — 改 inject / observe 逻辑后无法证明是否回归；capture 部分代价极低（inject 时记一行 NDJSON），未来 replay 命令再补。
- **反方理由**：完整 4-command loop（capture / export / replay / CI 集成）对本项目过重；NDJSON 长期累积需 rotation 增加运维；本项目 inject 改动频率低（半年内 < 5 次），手测也能跑。
- **采纳边界**：只做 capture（写 NDJSON）；不做 export / replay / CI；积攒 1-2 个月数据后人工分析评估是否补 replay。

##### C7 Soul audit 身份层 — 🟡（仅拆 USER.md，不引入 SOUL / HEARTBEAT / ACCESS_POLICY）

- **主理由**：CLAUDE.md 当前**确实超载**（个人偏好 + 方法论 + 规则 + 跨模块原则 + 自学习），拆分有改善；USER.md 抽出"关于我 + 编码偏好"段是清晰的小重构。
- **反方理由**：4 文件方案对本项目过重 — HEARTBEAT.md 假设有 cron 系统（我们没有）；ACCESS_POLICY.md 假设多人访问（我们是单人）；SOUL.md 与 CLAUDE.md 高度重叠；**仅拆 USER.md 又只解决 1/4 问题**，性价比中等。
- **采纳边界**：仅拆 `USER.md`（30 行左右），CLAUDE.md 留指针；其他 3 个文件**不创建**。

#### 🔴 显式拒绝（3）

##### C8 Thin harness + fat skills — 🔴

- **主理由（拒绝的理由）**：**180° 反向哲学冲突** — gbrain 主张"判断性逻辑入 markdown，runtime 仅约束"；本项目 `scripts/lib/`（memory-v5.js / runtime-paths.js / agent-orchestrator/12 子模块）承载的是**确定性 trust-critical** 逻辑（contract / parity / state machine / locks / reconciliation），**不能挪到 skill**。把 agent-orchestrator state machine 写在 markdown 里会破坏所有 trust 保证。
- **反方理由（不拒绝的理由）**：思想的**部分**有价值 — 判断性确实应该在 skill。但 C3（确定性 vs 判断 ADR）已经吸收了这部分；C8 整体作为架构哲学接受，会引出错误的 refactor 方向（把 lib/ 挪走）。
- **结论**：思想保留进 C3 ADR；C8 整体作为采纳目标拒绝。

##### C10 Signal-detector 永远在线 — 🔴

- **主理由（拒绝的理由）**：**多运行时 parity 严重失衡** — Codex 没有 UserPromptSubmit 等消息级 hook，引入即破坏 Claude / Codex 镜像；**轻量原则强冲突** — 每条 user message 触发 LLM 调用即使廉价（haiku 级）也累积非零成本；**用户控制原则弱冲突** — 用户无感的 LLM 调用。
- **反方理由（不拒绝的理由）**：手动版 `/capture` 命令保留 ambient capture 思想（用户主动触发），可单独考虑；但那不是 "signal-detector always-on" 的采纳，是**新命令**。
- **结论**：核心机制（always-on）拒绝；手动版另立项不算 C10 采纳。

##### C11 AGENTS.md vs CLAUDE.md 双轨 — 🔴

- **主理由（拒绝的理由）**：本项目已有 Claude / Codex 双 runtime parity（via `build-codex-plugin.js` mechanical propagation）；新增 AGENTS.md 是 **documentation duplication 不解决任何当前痛点**。
- **反方理由（不拒绝的理由）**：若未来 6 个月内接入第 3 个 runtime（Cursor / Cline / 自研），AGENTS.md 会立即有用 — 当前拒绝是**时机选择**而非永久拒绝。
- **结论**：现状拒绝；保留 watch（若接入新 runtime 则重新评估）。

### T6 输出 — ROI 排序 + 三问回答

#### ROI 排序前 3（"如果资源有限只能做一个"序）

| 名次 | 候选 | 人天估算 | 文件影响 | 选定理由（成本 × 价值 × 时机）|
|------|------|---------|---------|---------|
| 🥇 1 | **C12 Skill conformance gate** | **1.5-2 人天**（修正后） | 1 新脚本 + 1 npm script + build-codex-plugin 同步 + validate-codex-plugin parity 校验 + smoke | 解决**已经发生**的痛（skill 数量增长 + Codex 副本同步 + RESOLVER 漂移）；现成模式可抄（`validate-codex-plugin.js`）；CI 可加可不加；纯增量、不改既有路径。**修正**：原 1 人天估算未含 dual-runtime 传播（git tracked 派生文件靠 propagation 脚本同步，参见 debug-gotchas 2026-05-09）。|
| 🥈 2 | **C3 确定性 vs 判断分流 ADR** | 0.5 人天 | 1 ADR + 1 决策表 | **零代码改动**；同时回答 C8 thin/fat 的反方；为 C1 / C6 / C12 提供决策框架；新人 onboarding 受益；可在 30 分钟内完成 |
| 🥉 3 | **C1 typed-link 零 LLM 提取** | 2-3 人天 | 2-3 文件（`memory-v5.js` + `inject-context.js` 索引展示） | 短期 ROI 不是最高，**但最值得 5 年看** — 每多一份 topic note 都自动入图；与 4 条隐式原则全部兼容；典型场景（topic note 引用关系）当前完全缺失 |

**为何不是 C4 / C6 / C9**：
- C4 Brain-first lookup 软提醒**不能强制**，价值依赖用户读 skill 描述，效果可疑
- C6 Tiered enrichment 复用 confidence 阈值思路对，但当前 `/evolve` 工作并不滞后到必须自动化
- C9 Cross-modal refusal routing 是**字符串匹配**（脆弱），ROI 中等且引入新失败源

#### 显式拒绝清单（≥ 2 已达成，共 3 个）

| 候选 | 拒绝核心理由（1 句） |
|------|---------|
| 🔴 C8 Thin harness + fat skills | 180° 反向哲学冲突 — 本项目 `scripts/lib/` 承载 trust-critical 确定性逻辑，不可挪到 markdown。思想的判断性入 skill 部分由 C3 吸收。 |
| 🔴 C10 Signal-detector 永远在线 | 多运行时 parity 严重失衡（Codex 无消息级 hook）+ 轻量原则强冲突（每条 message 触发 LLM 即使廉价也累积）。手动版可单独立项。 |
| 🔴 C11 AGENTS.md 双轨 | 已有 mechanical propagation 解决 Claude/Codex parity；AGENTS.md 是 documentation duplication 不解决当前痛点。接入第 3 个 runtime 时再评估。 |

#### 三问回答（文档自身可回答）

**Q1：gbrain 哪个架构思想最值得抄？为什么？**

**A：C1 typed-link 零 LLM 提取。**

- **底层抽象**：write-time 确定性关系抽取 — 关系在写入瞬间确定，零 token、零 LLM 重读，可被 grep / jq 处理。
- **为什么最值得**：(1) 与本项目 4 条隐式原则（轻量 / Obsidian / 确定性 / parity）**全部兼容**，零冲突；(2) 解决的真问题（topic notes 之间的关系是当前架构盲区）当前**完全缺失**；(3) 长期复利大 — 每多一份记忆都自动入图，半年后 backlink 价值才显现，**最值得 5 年看的投资**；(4) gbrain 实测 P@5 +31.4（开启 graph layer vs 关闭）证明效果可量化。
- **不是 C12 / C3 的原因**：C12 / C3 是"现在最痛 + 代价小"的速胜（ROI 排名 1-2），但 C1 是"5 年最值钱"的复利项 — 用户问"最值得抄"应理解为"最有架构含金量"而非"最先做"。

**Q2：gbrain 哪个听起来很酷但其实不该做？为什么？**

**A：C8 Thin harness + fat skills。**

- **为什么听起来酷**：Garry Tan 在 YC Spring 2026 talk 把 5 定义（Skill / Harness / Resolver / Latent vs Deterministic / Diarization）讲成"10x to 100x productivity"的根因；"Push intelligence UP into skills, push execution DOWN into deterministic tooling, keep the harness THIN" 是漂亮口号。
- **为什么不该做**：本项目 `scripts/lib/`（memory-v5.js / runtime-paths.js / agent-orchestrator/12 子模块如 pipeline-state / locks / reconciliation）承载的是**确定性 trust-critical 逻辑**（contract / parity / state machine）— 把这些写到 markdown 让 LLM 解释执行，会破坏所有 trust 保证（locks 不再原子、state migration 不再向后兼容、parity 不再 mechanical）。
- **关键区分**：gbrain 的 "fat skills" 主张**判断性逻辑**入 markdown — 这部分本项目早已遵循（skills 处理需要 LLM 判断的工作流）。**冲突在"thin harness"**：我们的 harness 不是 thin，也不该 thin；它本身就是被 12 子模块拆得清晰的确定性架构。Garry 的口号好，**适用于本项目则错**。
- **可吸收的部分**：仅"判断性 → skill / 确定性 → script"的二分原则 → 由 **C3 ADR** 吸收。

**Q3：如果今天只能动一件事，最小动作是什么？**

**A：C3 — 写 ADR-010 "确定性 vs 判断分流"，30 分钟内完成。**

落点：`CLAUDE.md` 顶部「架构决策记录」段新增 ADR-010 条目 + 新建 `docs/solutions/2026-05-11-deterministic-vs-judgment.md`（≤ 100 行）。

内容形态：
1. ADR-010 标题 + 状态 + 背景（C8 反向哲学冲突）
2. 决策表（5 行）：

   | 输入到输出映射 | 类型 | 落点 |
   |----|----|----|
   | 同输入恒同输出 | 确定性 | `scripts/lib/` |
   | 需 LLM 判断 / 综合 | 判断性 | `user-skills/` |
   | 查表 / lookup / 计数 | 确定性 | `scripts/` |
   | 多步骤 LLM 推理 | 判断性 | skill + orchestrator |
   | trust-critical (locks / contracts / parity) | 确定性 | `scripts/lib/` (永远) |

3. 反方记录：gbrain `THIN_HARNESS_FAT_SKILLS.md` 的主张及为何本项目反向（trust-critical 不可挪 markdown）
4. 一句话决策口诀

理由：
- **0 代码改动**，30 分钟内完成
- **立即生效**：下次写脚本 vs skill 决策时有依据
- 同时回答 C8 的反方，**两鸟一石**
- 给后续 C12 / C1 / C6 提供决策框架（这些都是 scripts/lib 改动，需要 ADR 背书）
- 如果连 30 分钟都没有，**今天什么都别动**

---

## 审查结果

Phase 4 spawn 3 个并行 reviewer：`ce-coherence-reviewer` / `ce-product-lens-reviewer` / `ce-feasibility-reviewer`。

### P0 — 必须修复

| # | 视角 | 位置 | 问题 | 状态 |
|---|------|------|------|------|
| 1 | feasibility | T2 §Skills + T4 C12 落点 | 路径错误：`user-skills/` 不存在，实际是 `user-level/skills/<name>/SKILL.md`（dir-per-skill 不是 flat .md）。glob 已验证。 | 已自动修复 ✓ |
| 2 | feasibility | T4 C11 落点 + T5 反方 | `AGENTS.md` 实际**已存在但是未初始化模板**（`[项目名称]` 占位），不是"未来才有"。C11 reasoning chain 表面错但结论（不投入）暂仍成立。 | 已自动修复 ✓ |
| 3 | feasibility | T4 C5 影响面 | `SECRET_PATTERNS` 未 export（line 519 `module.exports` 只导出 `redactSensitive`）。复用方式不该是"导入 patterns"，应该是"调用 `redactSensitive(query)`"。 | 已自动修复 ✓ |
| 4 | product | 全局框架 | 文档把候选当 pickable parts，**未回答更深的 identity question**：tech-persistence 是否仍 gstack-aligned？还是已演化为不同物种？C8 "180° 反向哲学"是 positioning signal 不是 candidate。回答这个问题让 8/12 候选变得 trivially decidable。 | **待你决定** ⏳ |
| 5 | product | T6 ROI 排序 | 单人维护、无截止压力 — **成本曲线与团队相反**。"speed wins" 在 solo 场景累积负利息（surface 增 / 边际收益减），"5-year leverage" 才是正利息。按"5 年杠杆 / 维护表面"重排，C1 可能跳到 #1；C12 可能掉到 #3 或下榜。 | **待你决定** ⏳ |

### P1 — 建议修复

| # | 视角 | 位置 | 问题 | 状态 |
|---|------|------|------|------|
| 6 | coherence | T4 C2 冲突点 vs 最小接入形态 | "重度冲突 ... 需 SQLite/LanceDB" 与 "纯 JS 可实现（BM25 + 图遍历）" 自相矛盾。冲突等级应为"中度 — 初期可规避，完整方案才冲突"。 | 已自动修复 ✓ |
| 7 | feasibility | T4 C1 影响面 | 漏掉 `inject-context.js` 的 `CONTEXT_BUDGET_CHARS = 12000` 交互：MEMORY.md 加 backlink 列后 per-entry 宽度变化 → fewer entries fit。读 / budget 端未列。 | 已自动修复 ✓ |
| 8 | feasibility | T6 C12 人天 | 1 人天估算未含 dual-runtime 传播（plugin 副本同步 + `validate-codex-plugin` 校验 + smoke）。现实 1.5-2 人天。已记入 debug-gotchas 2026-05-09 "git tracked 派生文件靠 propagation 脚本同步"。 | 已自动修复 ✓ |
| 9 | product | 全文 framing | "人天" / "新人 onboarding" 是团队语境。实际：单人 / 无 deadline / 注意力预算 + 维护意愿是真约束。应替换为"未来 6 个月自己还记得为何这么做吗 / 这笔投入要从哪里 stop doing 腾出来" | **待你决定** ⏳ |
| 10 | product | T6 ROI 三巨头 | C3 + C1 + C12 是**三个 orthogonal 赌注**，不是 coherent trajectory。另一种打法：**memory-as-graph trajectory** = C1 + C5-capture + C6，三者互相强化（typed-links → 评估检索 → tier 自动升级）。 | **待你决定** ⏳ |
| 11 | coherence | T5 C6 反方理由 | 反方 "可能在低质量观察上误升" 没针对 T4 提出的具体机制（3 mentions / +0.1 / 0.9 封顶）。论点泛化未咬住机制。 | **待你决定** ⏳ |

### P2 — 可选优化

| # | 视角 | 位置 | 问题 | 状态 |
|---|------|------|------|------|
| 12 | coherence | T5 C7 反方 | "仅拆 USER.md 又只解决 1/4 问题" 措辞含糊（1/4 应用 vs 1/4 延后？）。 | 待 |
| 13 | coherence | T6 Q3 落点 | 没给完整 slug `docs/solutions/2026-05-11-deterministic-vs-judgment.md`。 | 已自动修复 ✓ |
| 14 | product | T6 三问 | 缺**机会成本 / 反向场景**问题："要做这个我得 stop 什么？" / "ship 6 个月没人用是什么样子？" | 待 |
| 15 | feasibility | T4 C9 落点 | refusal 模式匹配必须**晚于 envelope extraction**（详 2026-05-11 debug-gotchas）— `runProcess` 已中心化错误处理，refusal 检测要避免把 401 envelope `result.message` 误判为 refusal。 | 待 |

### 总评

**真实价值**：3 个 reviewer 共抓出 15 处问题，**P0 中有 5 处真实**（3 feasibility 文件路径 / exports / AGENTS.md 状态错误 + 2 product 深度 reframe）。Coherence 抓出 1 处自相矛盾（C2）。无伪阳性。

**自动修复**：8 处 P0 / P1 / P2（路径 / exports / AGENTS.md 重述 / C2 冲突等级 / C1 budget 交互 / C12 人天 + T6 文件名 + C12 plugin 同步注意）。

**用户决定 fix all**：5 处语义级（P0-4 身份 / P0-5 ROI 重排 / P1-9 solo reframe / P1-10 trajectory / P1-11 C6 机制反方）全部应用，结果写在下方「Phase 4 后置 reframe」段。**Phase 1-3 决策轨迹保留不动**作为 audit trail；reframe 是**覆盖性结论**不是改写。

### Phase 4 后置 — 5 处 reframe（用户选择 fix all 应用结果）

> **覆盖说明**：以下结论**覆盖**Phase 1-3 / Phase 4 早期段落的对应判断。Phase 1-3 反映当时的认知，保留作历史轨迹；本段是经 reviewer 反馈后的**最终结论**。

#### (a) 项目身份界定（覆盖前面所有候选评级隐含假设 — P0-4 fix）

针对 reviewer 提出的 "tech-persistence 是否仍 gstack-aligned 还是已演化为不同物种" 前置问题，明确身份陈述：

> **tech-persistence 是一个针对开发者工作流的自进化工程系统**，运行在 Claude Code + Codex 双 runtime 上。
>
> - **不是** gstack 的替代品 — gstack 角色分工是 inspiration source，已吸收到 5 阶段（think / plan / work / review / compound）。
> - **不是** gbrain 的替代品 — gbrain 是 personal agent brain（meeting / email / people / 知识图谱），定位完全不同。
> - **是**与 gstack / gbrain 同生态的 sibling 项目，专注 **developer toolchain self-evolution**：跨 runtime parity / 确定性 trust-critical 逻辑 / 文件系统持久化 / 多模型协作的工作流。

**身份决定的 4 条不可妥协原则**（重新明示前面已隐式遵守的）：

- **多运行时 parity**：所有改动必须同步 Claude / Codex 副本
- **确定性优先**：trust-critical 逻辑（contract / parity / state machine）只能在 `scripts/lib/`，不可挪 markdown
- **轻量优先**：不引入 DB / embedding / 永久后台进程
- **Obsidian 兼容**：所有 markdown 是 vault 一等公民

**身份对 12 候选的 trivially-decidable 影响**：

- 与 developer-toolchain 共振：**C1 / C3 / C12 / C5-capture** → trivially 🟢
- 与 personal-agent-brain 强绑定不适用：**C10 (always-on signal) / C7 完整版 (SOUL / HEARTBEAT / ACCESS_POLICY)** → trivially 🔴 或 partial-only
- 与 trust-critical 原则冲突：**C8 (fat skills / thin harness) / C2 vector 阶段** → trivially 🔴
- 时机 / 储备型：**C11 AGENTS.md** 等接入第 3 runtime 才有意义 → trivially 🔴 (defer)

**与 T5 评级一致性**：✅ 完全一致。reviewer 洞察成立 — 身份回答完后 8/12 候选确实变 trivially decidable。差别在于**现在显式说明"为什么这么评"**，而非隐式 4 原则。

#### (b) ROI 重排（按 5 年杠杆 / 维护表面增量 — P0-5 fix）

**原 ROI 排序（speed-wins biased）**：C12 → C3 → C1

**solo-maintainer 重排**（leverage / surface ratio）：

| 名次 | 候选 | 5 年杠杆 | 维护表面增量 | 比率 |
|------|------|---------|------------|------|
| 🥇 1 | **C1 typed-link** | **高** — 每多 1 份 topic note 都自动入图；backlink graph 是知识层复利基础 | **低** — memory-v5.js +1 函数 + frontmatter 约定 | **极高** |
| 🥈 2 | **C3 ADR-010** | **中** — 每次"script vs skill"决策被引用；为后续候选提供决策背书 | **接近零** — 1 doc，不动代码 | **极高** |
| 🥉 3 | **C5-capture (Trajectory A 起点)** | **中** — 解锁未来检索效果可量化；3-6 月后才能 replay 出价值 | **低** — opt-in NDJSON 内嵌 inject-context.js | **高** |

**C12 从 #1 掉出 top-3 的原因**：

- "已发生的痛"复检 — solo + 30 skills **不构成** painful drift；现在没有 user 抱怨 RESOLVER 不命中。**痛是想象的，不是测量的**。
- 维护表面：1 脚本 + plugin 副本同步 + frontmatter 约定 + CI hook，一旦上线**永久维护**。
- 5 年杠杆：阻止 drift 是**负向价值**（防止变坏），不是正向复利。
- 结论：**C12 仍是 🟢 但不该是 top-3** — 等真痛了再做，或与 C1 / C5 同时收益时再加。

#### (c) Solo-maintainer reframing — 反方理由 anchor 替换（P1-9 fix）

旧 anchor → 新 anchor：

| 旧表述（团队语境） | 新表述（solo 语境） |
|------|------|
| "X 人天估算" | "维护表面增量" + "记得性 6 月" |
| "新人 onboarding 受益" | "6 月后未来的我读这 ADR 还能立刻明白吗" |
| "解决已发生的痛" | "**测量过**的痛 vs 想象的痛 — 没被痛过就别预防" |
| "ROI 比率" | "5 年杠杆 / 维护表面 — solo 的成本曲线与团队反向，speed wins 是负利息" |

具体反方理由修订（仅最受影响的 3 个）：

- **C3 反方 refresh**：原方向对但不够锋利。新："如果 6 月后还需要回这份 ADR 重读才能决定 script vs skill，说明 ADR 没起到 default-reflex 作用 — **检验标准是 ADR 写完后下次决策不用再读它**"。
- **C12 反方 refresh**：新增"已发生的痛是测量的还是想象的？目前没看到 RESOLVER 漂移导致 skill 不触发的实例。**痛是想象的就不该预防，让真痛来了再修**"。
- **C6 反方 refresh**：见 (e)。

#### (d) Trajectory 推荐：memory-as-graph (C1 → C5-capture → C6) — P1-10 fix

原 ROI 三件套 (C12 / C3 / C1) 是 **3 个 orthogonal 赌注**，互相不强化。

**Trajectory A — memory-as-graph**（推荐）：

```
C1 typed-link 零 LLM 提取
    ↓ 提供 graph 结构（typed links + backlinks）
C5-capture NDJSON 注入日志
    ↓ 测量"检索到对的 topic 了吗"
C6 confidence 自动升级（按 mention 频次）
    ↓ 让常被用到的知识自动毕业到永久 rules
```

三者**互相强化**：

- C1 给检索 backlink → C5 量化检索质量 → C6 用同样的 observation data 升级 confidence
- 投资期 3-6 个月；每步都可单独提供价值
- 整体方向：**让 Memory v5 从被动 dump 进化为有质量保证的知识图谱**

**Trajectory B — decision-discipline** (备选，浅薄)：C3 ADR → C12 skill conformance
- 互相弱依赖，只 cover 2 个候选，trajectory 短
- 不推荐作为主投资方向

**Trajectory C — execution-quality** (备选)：C4 brain-first → C9 cross-modal refusal → C5-replay
- 关于"执行时 quality gate"
- 也是 coherent 但价值不如 Trajectory A 长期

**推荐**：选 **Trajectory A**。它对应身份陈述的核心 — memory 是 self-evolving 系统的关键资产。

#### (e) C6 反方 refresh — 针对具体机制（P1-11 fix）

旧反方："当前手工 `/evolve` 工作不大且给用户控制感；自动升级可能在低质量观察上误升"。

**问题**：泛化"可能误升"未咬住 T4 提出的具体机制（3 mentions / +0.1 confidence / 0.9 cap）。

**新反方（针对机制）**：

> **3 次 mention +0.1 的阈值没有考虑时间分布**：
> - 一次会话内 3 次 mention（**噪声**）= 一周内 3 次（弱信号）= 三个月内 3 次（**真信号**），都触发同样升级
> - 真信号是"在分散时间内的 mention" — "刚好这一会话频繁讨论"更像噪声
> - 修正方向：mention 必须**跨 session** 才计数；或加入 time-window decay
>
> **更深的问题**：confidence 是**事件的统计量**，但"是否值得毕业到永久 rules" 是**意图判断**（这个本能是否真有可迁移性）。
> - 自动 mention counter 解决前者，毕业逻辑该是后者驱动
> - 自动升级到 0.7（仍是本能）是合理的；自动升级到 0.9 → 毕业 rules 是**过冲**
> - 0.9 应该仍需人工 `/evolve` 确认
>
> **修正后采纳形态**：mention counter 仅在 [0.3-0.7] 段自动 +0.1（且 mention 跨 session）；0.7+ 仍人工 `/evolve`。

#### Phase 4 reframe 最终结论

| 项 | Phase 1-3 结论 | Phase 4 reframe 后最终结论 |
|---|---|---|
| 项目身份 | 隐式 | **明示：developer toolchain self-evolution sibling，不是 gstack/gbrain 替代** |
| ROI top-3 | C12 → C3 → C1 | **C1 → C3 → C5-capture** |
| 投资方向 | 3 个 orthogonal 赌注 | **Trajectory A: memory-as-graph (C1 → C5-capture → C6)** |
| C12 定位 | top-3 | 🟢 保留但**降出 top-3**，等真痛来 |
| C6 采纳边界 | 复用 confidence 段位映射 tier | 仅在 [0.3-0.7] 自动 +0.1 + 跨 session 计数；**0.7+ 仍人工** |

**Q1 / Q2 / Q3 三问回答**：与 Phase 3 一致（C1 / C8 / C3 ADR-010）— reframe 强化而非推翻。

---

## 复利记录

### 提取的经验

1. **identity-question-first**：评估外部架构思想时，先回答身份问题（"本项目是 X / Y / Z 中的哪一个"），多数候选变 trivially decidable。**Cherry-picking 思想会 import surface / reject spine**。已沉淀为 `.claude/rules/architecture.md` ADR-011。

2. **Solo-maintainer 的 ROI 公式不同**：speed-wins 在 solo 场景累积负利息（surface 增 / 边际收益减），"5 年杠杆 / 维护表面增量"才是正利息。多数"best practices"隐含**团队 scarcity-of-time** 假设，对 solo 无效。ADR-011 显式化此原则。

3. **Trajectory > orthogonal bets**：候选 ROI 排序应按 **coherent trajectory**（每步强化前一步）而非 single bets。本 sprint 推荐 **Trajectory A memory-as-graph** (C1 → C5-capture → C6) 三者互相强化，优于 C12 + C3 + C1 三个 orthogonal 赌注。

4. **多视角并行 review 在研究文档上不可省略**：3 个 reviewer 抓出 15 处问题，**product-lens 抓出框架问题**（identity / ROI bias / team-framing），coherence + feasibility 抓不到。研究 sprint 没有代码可跑测试，**唯一对抗偏见的就是多视角并行 review**。

5. **写入 audit trail 而非 overwrite**：Phase 4 reframe 没改 Phase 1-3 而是叠加为「Phase 4 后置」段。未来回看能看出决策演化轨迹 — 当时为何这么想 + 后来为何改。

6. **gbrain 的 typed-link 思想是最值得抄的具体架构**（write-time 确定性 / 零 LLM / Obsidian-native / grep-able），但**当前不实施** — Trajectory A 起点；落点 `scripts/lib/memory-v5.js` + frontmatter `links:` 字段；与 4 条不可妥协原则全部兼容；5 年杠杆最高。

7. **reviewer 反馈的具体盲点教训**（feasibility reviewer 在 Phase 4 抓到，归纳为通用反思）：
   - 路径假设没核实（用 `user-skills/` 时未 glob）
   - 现有文件状态没核实（AGENTS.md 当作"未来才有"，实际是未初始化模板）
   - exports 名字猜的（`SECRET_PATTERNS` vs 实际 `redactSensitive`）
   - 人天估算漏 dual-runtime 传播（git tracked 派生文件必须靠 propagation 脚本同步）
   - 通用教训：**写"落点 / 影响面"前先做 1 轮 Glob + Read 校验**

### 创建/更新的本能

- 无新本能创建（本 sprint 输出研究而非可观察的工作流模式）
- 沉淀方式选择 **rules/architecture.md ADR-011**（显式架构决策）而非本能（confidence-based）— ADR 适合"必须遵守"型规则；本能适合"统计积累后毕业"型模式

### 解决方案文档

- **本 sprint 主文档**：`docs/plans/2026-05-11-gbrain-gstack-analysis.md`
- **已添加**：`CLAUDE.md`（项目）「解决方案索引」段 1 entry
- **已添加**：`.claude/rules/architecture.md` ADR-011 identity-question-first 原则
- **后续可选**（不在本 sprint 范围）：T6 推荐的 ADR-010 "确定性 vs 判断分流"

### 跨 sprint 影响（未来 sprint 应受益）

- 任何"是否融入外部思想 / 大幅 refactor"的 sprint 必须先有 Phase 0「项目身份界定」段
- ROI 评估默认按 "5 年杠杆 / 维护表面增量"
- 必须 spawn ≥ 1 个 product-lens reviewer（不能只 coherence + feasibility）
- 候选 ROI 应按 trajectory 而非 single bets 排序
- "落点 / 影响面"写之前先做 Glob + Read 校验
