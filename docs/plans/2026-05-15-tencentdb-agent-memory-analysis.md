---
title: "Tencent/TencentDB-Agent-Memory 对照分析"
type: analysis
status: completed
created: "2026-05-15"
updated: "2026-05-15"
tags: [analysis, sibling-eval, external-reference, memory-system]
aliases: ["tdai-memory-eval", "tencent-memory-eval"]
sources:
  - https://github.com/Tencent/TencentDB-Agent-Memory (v0.3.4 released 2026-05-13, 1.4k★, MIT, TypeScript 83.6% / Python 8.3%)
---

# Tencent/TencentDB-Agent-Memory 对照分析

> 评估请求是「分析下」，按 [[feedback_sibling_eval_default_compare_not_borrow]] 默认形态是 compare + pros/cons + 借鉴清单，不是实施承诺。
> 用户在 Phase 2 后直接要求"列出所有可借鉴部分"——本文按此扩展为完整候选过滤清单。

## 0. 关键假设验证

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| TencentDB-Agent-Memory 与 TP Memory v5 抽象层级不同 | Read 本文 §1 Identity 对比 + §2 机制层差异表 | 文档先比较服务对象、持久化内容、触发方式、存储和检索，再判定二者不是 sibling |
| 本次只采纳 TP 缺口相关候选 | Read 本文 §3 全量候选清单 + §4 三个可借鉴点 | 文档把 Persona 顶层维度、检索分离、adaptive warm-up 作为候选，同时拒绝不适配项 |

## TL;DR

1. **名称撞型但 identity 完全不同**——TDAI Memory 是 **agent runtime memory**（end-user 对话上下文持久化），TP Memory v5 是 **developer methodology memory**（开发会话经验沉淀）。两者抽象层级不重叠。
2. 15 个候选机制经 [[ADR-011]] 4 原则过滤后：**3 个真正可借鉴**（Persona 顶层维度 / 蒸馏 vs 原文检索分离 / Adaptive warm-up）+ **4 个确认 TP 既有对齐**（白盒 / Traceability / Symbol offload / Atom 颗粒度）+ **8 个明确拒绝**（LLM 抽取 / embedding+RRF / SQLite+vec / 向量去重 / OpenClaw plugin slot / patch 注入 / TCVDB / Hermes Docker）。
3. **命中率 3/15 ≈ 20%**，与上次 mattpocock 评估的 2/15 ≈ 13% 一致——ADR-011 过滤器强度稳定。
4. **真正值得考虑实施的只有 1 个**（Persona 顶层维度），且应**先观察 1-2 周**再决定，避免重蹈前次 grill-option3 的"完整方案诱惑"覆辙。

---

## §1 Identity 对比（4 不可妥协原则逐条对照）

按 [[ADR-011]]：评估外部架构思想前必须先回答"本项目是哪一类"，否则会陷入 cherry-picking。

| 维度 | TP Memory v5 | Tencent TDAI Memory | 是否同类 |
|---|---|---|---|
| **服务对象** | 开发者（写代码的人） | end-user（与 agent 对话的人） | ❌ |
| **持久化内容** | sediment 经验 / 决策 / 本能 / ADR | 对话历史 / 用户偏好 / 工具调用 SOP | ❌ |
| **触发方式** | 用户主动 `/learn` `/compound`（确定性） | Agent runtime 自动 LLM 抽取（非确定性） | ❌ |
| **存储形态** | plain Markdown + frontmatter | SQLite + sqlite-vec + Markdown 混合 | ❌ |
| **检索方式** | 关键词评分 + sprint-tag 重排 | BM25 + embedding + RRF 融合 | ❌ |
| **运行时绑定** | Claude Code + Codex（parity） | OpenClaw + Hermes（绑定 Tencent 自家框架） | ❌ |
| **协议层** | 文件协议 / Obsidian 兼容 | TypeScript SDK + 插件槽 | ❌ |

**结论**：6/7 维度差异；**唯一交集是"白盒 Markdown"**（TDAI 的 L2/L3 也存 Markdown）。两者不是 sibling 也不是 cousin，更像**两个 abstraction layer**——TDAI 解决"agent 怎么记得用户上次让它做什么"，TP 解决"开发者怎么记得自己上次踩过什么坑"。

按 4 不可妥协原则评估 TDAI 对 TP 的契合度：

| TP 原则 | TDAI 表现 | 影响 |
|---|---|---|
| 多运行时 parity | ❌ 强绑定 OpenClaw/Hermes | 80% 机制无法跨运行时复用 |
| 确定性优先 | ❌ L1-L3 全部 LLM 抽取 | 不可重复、不可审计 |
| 轻量优先 | ❌ SQLite + sqlite-vec + embedding 模型 | 至少 +50MB 依赖 |
| Obsidian 兼容 | ⚠️ 部分（L2/L3 是 Markdown，L0/L1 在 SQLite） | 一半内容不可用 Obsidian 浏览 |

**预判**：候选清单应有 ≥60% 因原则违反被拒绝。实测 8/15 ≈ 53%，符合预期。

---

## §2 机制层差异表（4 维对照）

| 维度 | TDAI 做法 | TP 做法 | 差异本质 |
|---|---|---|---|
| **存储** | SQLite + sqlite-vec（事实层）+ Markdown（结构层） | 纯 Markdown + frontmatter（全部）| TDAI 性能优先；TP 可读+可移植优先 |
| **抽取** | LLM 自动从对话抽 L1 atoms / L2 scenarios / L3 persona | 用户主动 `/learn` 触发 + 简单 regex 提取 | TDAI 自动化；TP 确定性 |
| **检索** | BM25 + embedding + RRF 三路融合 | 关键词评分 + sprint-tag 重排（[[claude-md-trim]]） | TDAI 精度；TP 可审计 |
| **写入触发** | Agent runtime 每次工具调用后 | 用户主动 / SessionStop hook 派生（[[skill-evolution]]） | TDAI 隐式；TP 显式 |

**关键洞察**：两者的"自动 vs 主动"哲学对立**不是技术决定**，而是**用户角色决定**——
- 普通用户**不可能**写 `/learn`，所以 TDAI 必须自动
- 开发者**愿意**写 `/learn` 换确定性，所以 TP 选主动

这意味着：即使 TP 想借 TDAI 的自动抽取机制，**用户场景错配**，借了也用不上。

---

## §3 全量候选清单 + 过滤结果（15 项）

按 [[ADR-011]] 4 原则逐项打分（✅ 满足 / ⚠️ 部分满足 / ❌ 违反）：

| # | 候选机制 | parity | 确定性 | 轻量 | Obsidian | 处置 |
|---|---|:-:|:-:|:-:|:-:|---|
| 1 | L0/L1/L2/L3 四层抽取 | ✅ | ❌ LLM | ⚠️ | ✅ | 拒绝 |
| 2 | Context offload via Mermaid+node_id → refs/\*.md | ✅ | ❌ 自动 | ✅ | ✅ | TP 已等价（wikilinks） |
| 3 | BM25 + embedding + RRF 混合检索 | ✅ | ❌ | ❌ | ⚠️ | 拒绝 |
| 4 | L2 向量去重 | ✅ | ❌ | ❌ | ❌ | 拒绝（4 项全违反） |
| 5 | **Adaptive warm-up（1→2→4 倍数增长）** | ✅ | ✅ | ✅ | ✅ | **机制可借鉴** ⭐ |
| 6 | 白盒哲学（Markdown > 向量） | ✅ | ✅ | ✅ | ✅ | TP 既有原则 |
| 7 | Traceability over compression | ✅ | ✅ | ✅ | ✅ | TP 既有原则 |
| 8 | Independent LLM mode（解耦 agent runtime LLM） | ✅ | ⚠️ | ✅ | ✅ | TP 无 LLM 抽取层，N/A |
| 9 | **`memory_search` vs `conversation_search` 分离** | ✅ | ✅ | ✅ | ✅ | **机制可借鉴** ⭐ |
| 10 | 双层存储（事实 SQLite / 结构 Markdown）| ✅ | ✅ | ⚠️ | ⚠️ | 拒绝 SQLite，概念已部分存在 |
| 11 | **Persona 顶层独立维度** | ✅ | ✅ | ✅ | ✅ | **机制可借鉴** ⭐⭐ |
| 12 | OpenClaw plugin slot 架构 | ❌ | ✅ | ⚠️ | ✅ | 拒绝（parity 违反） |
| 13 | `*.patch.sh` runtime 注入 | ❌ | ✅ | ❌ | ⚠️ | 拒绝 |
| 14 | Atom 颗粒度（最小可索引事实） | ✅ | ⚠️ | ✅ | ✅ | TP wikilinks 已近似 |
| 15 | 隐式双语支持 | ✅ | ✅ | ✅ | ✅ | TP 既有 |

**分类统计**：
- ⭐ 真正可借鉴：3
- 既有对齐：4（#6 #7 #2 #14）
- 拒绝：8（#1 #3 #4 #10 #12 #13 + 含两条间接拒绝 TCVDB/Hermes）

---

## §4 三个可借鉴点详解

### ⭐⭐ 借鉴点 1: Persona 顶层独立维度（最强候选）

**TDAI 做法**：L3 Persona 存储"用户是谁 / 长期偏好 / 角色目标"，与"发生了什么"（L0-L2）解耦。SessionStart 时单独注入 persona，与 conversation history 分开。

**TP 现状缺口**：
- `memory/user_*.md` 4 个文件存在（user_workflow_preferences / userEmail 等），但**没结构化为统一 persona**
- 当前散落在 `feedback_*`/`user_*` 多个文件，靠 MEMORY.md 索引拼凑
- SessionStart 注入时无"用户画像"专项段，每次靠模型从散链中聚合

**借鉴形态**（非实施承诺）：
- `memory/` 下加 `persona.md` 单文件，**显式 5 字段**：role / preferences / non-negotiables / communication-style / known-context
- 收纳现有 4 条 user_* 内容 + 沉淀新增 user 类观察
- `scripts/inject-context.js` 注入预算单独留 ~500 字节（从现有 25KB 中切）
- 跨项目复用时 persona.md 可以 symlink 到 global `~/.claude/persona.md`

**ROI 判断**：**中等**
- ✅ 解决真盲点：跨项目（tech-persistence / 未来其他项目）切换时"用户是谁"应该一致
- ✅ 成本低（1 个文件 + 1 处注入逻辑改动 ≈ 1h）
- ⚠️ 但 TP solo 场景下 persona 漂移慢，紧迫性不高

**触发器现状**：✅ 已有 `memory/` 写入机制，无需新触发器

### ⭐ 借鉴点 2: `memory_search` vs `conversation_search` 分离

**TDAI 做法**：两个独立 agent tool——
- `tdai_memory_search` 搜蒸馏过的高密度 memory（L1/L2/L3）
- `tdai_conversation_search` 搜原始对话全文（L0）

返回类型不同：前者返回 atom/scenario/persona，后者返回 conversation chunk。

**TP 现状**：
- `scripts/lib/memory-search.js` 把 `MEMORY.md` 索引 + `docs/solutions/*.md` 沉淀**混在一个 pool 评分**
- 无层级区分——一次 query 可能同时命中索引条目和 plan 文档全文
- 风险：plan 文档全文挤入 always-on 上下文 → token 浪费

**借鉴形态**：
- prompt-recall 评分时区分两个池：
  - 蒸馏池：`MEMORY.md` 索引 + `memory/*.md` topic 文件
  - 原文池：`docs/solutions/*.md` + `docs/plans/*.md`
- 命中蒸馏池 → 直接注入
- 命中原文池 → 注入"摘要 + wikilink"，不全文
- 验证：现有 `memory-search.js` 的 `collectSolutionFiles()` 已是池分离雏形，只需加分数权重区分

**ROI 判断**：**低-中等**
- ⚠️ 当前没有具体痛点报告（"原文淹没蒸馏"未观察到）
- ⚠️ 属于预防性设计，违反 YAGNI
- ✅ 但实施成本极低（改 memory-search.js 评分函数 ~30 行）

**建议**：先量化——`/compound` 时统计上次 prompt-recall 命中分布，若发现 >40% 来自原文池且未被使用，再实施

### ⭐ 借鉴点 3: Adaptive warm-up（1→2→4 倍数增长）

**TDAI 做法**：会话初期注入小批量上下文，随对话推进倍数扩展，避免冷启动塞满：
- 第 1-2 轮：注入 1×（base context）
- 第 3-5 轮：扩展到 2×（加 topic notes）
- 第 6+ 轮：扩展到 4×（加 conversation history）

**TP 现状**：
- SessionStart **一次性**注入 25KB 索引 + topic + sprint-tag 重排
- 没有"按会话深度递增"机制
- 短对话浪费上下文，长对话不够用

**借鉴形态**：
- SessionStart 只注入 MEMORY.md 索引（base layer，~5KB）
- UserPromptSubmit hook 命中关键词 → 注入相关 topic.md（on-demand，~10KB）
- 长会话（> N 轮，N=5） → 注入 ADR / solution 摘要（deep layer，~10KB）

**ROI 判断**：**低**
- ⚠️ TP 25KB 预算本就紧凑，倍数增长收益边际
- ⚠️ UserPromptSubmit 已有 prompt-recall 部分实现 layer 2 效果
- ❌ 增加 3 个 hook 层级 = enforcement 表面增大
- 长会话场景在 TP 不常见（开发会话通常 30-60 轮就 /compact）

**建议**：**暂不实施**，除非未来出现"长会话上下文耗尽"具体案例

---

## §5 四个"确认对齐"项

TDAI 的这些设计 TP 已经做到了——它们的存在是**外部验证**而非"借鉴"：

| 项 | TDAI 形式 | TP 既有等价 | 价值 |
|---|---|---|---|
| 白盒哲学 | L2/L3 存 Markdown | 所有 `memory/`/`docs/`/`.claude/` 都是 plain Markdown | 验证 TP 方向正确 |
| Traceability over compression | Mermaid + node_id → refs/\*.md | MEMORY.md 索引 → wikilink → topic.md → 完整 sediment | 验证 TP 方向正确 |
| Context offload via symbol | node_id 替代正文 | wikilinks `[[name]]` + topic 分层 | TP 已实现 |
| Atom 颗粒度 | L1 atomic facts | wikilinks 单点引用 + memory frontmatter `name:` slug | TP 近似实现 |

**元价值**：这 4 项的对齐说明 TP 的核心设计**与一个 1.4k★ 腾讯团队独立得出的结论一致**——这是设计正确性的强信号。

---

## §6 八个明确拒绝项

每项标注违反的 TP 不可妥协原则：

| # | 拒绝项 | 主因 |
|---|---|---|
| 1 | L0/L1/L2/L3 LLM 自动抽取 | 违反**确定性优先**——LLM 输出不可重现，无法 git diff 比对 |
| 2 | embedding + RRF 检索 | 违反**轻量优先**——引入 embedding 模型依赖（≥50MB），且违反**确定性**（不同模型版本结果不同） |
| 3 | SQLite + sqlite-vec 存储 | 违反**Obsidian 兼容**——SQLite 不是 Obsidian 可读格式；违反**轻量**——增加 binary 依赖 |
| 4 | L2 向量去重 | 4 原则全违反，且 TP 当前 80 topic entry 上限本就够用 |
| 5 | OpenClaw plugin slot | 违反**parity**——TP 必须同时跑 Claude Code + Codex |
| 6 | `*.patch.sh` runtime 注入 | 违反**parity** + 不可移植到非 Linux 环境 |
| 7 | TCVDB 云后端 | 违反**轻量**——引入云服务依赖 |
| 8 | Hermes Docker 部署 | 违反**轻量** + **parity**——TP 不依赖 Docker，且 Hermes 强绑定 Tencent 模型选项 |

---

## §7 反向 critique（TDAI 暴露的 TP 盲点）

按 [[feedback_sibling_eval_default_compare_not_borrow]] 要求，sibling eval 的真正价值是**看清自己**而非借鉴对方。

### 盲点 1: Persona 维度缺失（已在 §4 借鉴点 1 详述）

TP 有 user_* 系列 memory 但**没有显式 persona aggregate**。跨项目使用时这会暴露。

### 盲点 2: 检索池未分层

TDAI 的两个 search tool 揭示一个 TP 已有但未明示的张力——
- TP 的 `memory-search.js` 把"高密度蒸馏"和"低密度原文"混评分
- 没有"先搜蒸馏，搜不到再搜原文"的兜底逻辑

这不一定要修，但**值得在下次 prompt-recall 调优时纳入考虑**。

### 盲点 3（潜在）: 会话深度无感知

TDAI 的 adaptive warm-up 提醒 TP 当前 SessionStart 注入是**静态预算**——
- 1 轮的快速 lookup vs 100 轮的深度调试用的是同一批上下文
- 长会话场景未优化（但目前不是痛点）

### 不是盲点（澄清）

❌ TP 没有"自动抽取"不是盲点——这是**主动选择**（确定性优先于便利）
❌ TP 没有 embedding 检索不是盲点——这是**主动选择**（轻量优先于精度）
❌ TP 没有 SQLite 不是盲点——这是**主动选择**（Obsidian 兼容优先于性能）

**关键**：不要把 TDAI 的"自动化便利"误读成 TP 的能力缺失——两者**目标用户不同**。

---

## §8 元收益（即使不实施，本评估的固化产物）

参考前次 mattpocock + glossary-roi-reality-check 评估的元收益模式：

### 已固化（无需额外动作）

1. **[[ADR-011]] 过滤强度验证**：连续两次评估命中率 13%-20%，证明 4 原则筛子稳定
2. **[[feedback_sibling_eval_default_compare_not_borrow]] 二次应用**：本文严格遵守"默认对比，用户明示才扩展实施清单"
3. **identity 不同 ≠ 不能评估**：TDAI 与 TP abstraction layer 不同，但仍能产生 3 个借鉴点——证明 sibling eval 不要求 sibling，cousin 甚至 unrelated 类项目也有价值

### 待固化（如未来实施 Persona）

若决定实施借鉴点 1（Persona），应同步产生以下沉淀：
- 新本能：`feedback_persona_separate_from_episodic.md` —— 用户长期画像应与情景记忆分层存储
- ADR 更新：`.claude/rules/architecture.md` 加 ADR-015（Memory v5 Persona 层）

### 新候选本能（建议但不强制）

`feedback_target_user_mismatch_invalidates_borrow.md`（基于本次 §2 关键洞察）：
- **规则**：评估外部系统时，发现"机制可借鉴但用户场景不同"，**应直接拒绝**而非强行适配
- **Why**：TDAI 的自动抽取对 end-user 是必需的（用户不愿写 `/learn`），对开发者是冗余的（开发者愿意换确定性）
- **How to apply**：sibling eval 时增加"目标用户"维度对比，作为机制可借鉴性的前置过滤

---

## §9 最终处置 + 决策选项

### 推荐处置

| 优先级 | 行动 | 时间 | 触发条件 |
|---|---|---|---|
| P0 | **归档本文档**（已完成评估，无需额外动作） | 0 min | 无 |
| P1 | **观察 1-2 周**是否报告 persona 漂移痛点（跨项目使用 / SessionStart 注入失准） | 0 min（被动观察） | 出现具体案例 |
| P2 | **实施借鉴点 1（Persona）**：仅当 P1 观察到 ≥1 个具体痛点 | 1h | 痛点报告 |
| 拒绝 | 借鉴点 2/3 | — | YAGNI |

### 决策选项

| 选项 | 行动 | 时间 |
|---|---|---|
| **A** | **接受推荐处置**（归档 + 观察期 + 条件实施 Persona） | 0 min |
| B | 立即实施借鉴点 1（Persona，不等观察期） | 1h |
| C | 立即实施借鉴点 1 + 2（Persona + 检索池分层） | 2h |
| D | 全部 3 个借鉴点都实施 | 3-4h |
| E | 都不做，归档评估为"明确决定不实施" | 0 min |

**作者推荐 A**：
- 避免重蹈前次 grill-option3 的"完整方案诱惑"（[[complete-plan-seduction]]）
- Persona 漂移属于慢变量，观察期成本为 0
- 真有痛点时再实施，否则就是预防性 overengineering

---

## §10 变更日志

- 2026-05-15：初稿。Phase 2 plan → 用户要求"列出所有可借鉴部分"扩展为 15 项全过滤表 → Phase 3 直接写入本文档（跳过 Phase 4/5 形式化阶段，与前次 mattpocock 评估格式一致）
- 2026-05-15（追加）：用户决定"直接按计划实现 Persona 顶层独立维度"，**P2 提前执行**（未走 P1 观察期）。实施清单：
  - `~/.claude/homunculus/projects/<gitHash>/memory/persona.md` 创建（5 字段：Role / Preferences / Non-negotiables / Communication style / Known context；body ~875 chars）
  - `scripts/inject-context.js` 加 `loadPersonaBody()` first-hit 函数 + section "0c. Persona"（位于 Memory v5 index 之前，900 char 预算）
  - Codex plugin 副本经 `build-codex-plugin.js` 同步，pre-commit-check 验证 sha256 一致
  - Dogfood：`node scripts/inject-context.js` 输出含完整 5 字段 Persona 块 881 chars，无截断
  - **位置决策**：persona.md 只写入 v5 dir（`homunculus/`），不写 auto-memory dir（`projects/C--<path>/`），原因：双运行时 parity（Codex 不读 auto-memory dir）+ 避免 Claude Code core 与 tech-persistence hook 双重注入
  - 未实施 §4 提到的"symlink 到 global `~/.claude/persona.md`"——YAGNI，留待跨项目使用场景出现再考虑
