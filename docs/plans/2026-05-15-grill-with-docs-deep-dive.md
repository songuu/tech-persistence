---
title: "grill-with-docs 深度研究：4 机制拆解与适配评估"
type: analysis
status: completed
created: "2026-05-15"
updated: "2026-05-15"
tags: [analysis, sibling-eval, grill-with-docs, context-md, adr-gate]
aliases: ["grill-with-docs-deep"]
sources:
  - https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs
  - https://github.com/mattpocock/course-video-manager (真实 CONTEXT.md 范例)
  - docs/plans/2026-05-15-mattpocock-skills-analysis.md (前置浅评)
---

# grill-with-docs 深度研究

> 沿用 [[2026-05-15-mattpocock-skills-analysis]] §4.1 标注的「中等价值，需 mini-sprint 评估」候选。
> 本文产出**评估结论 + 决策点**，**不实施**。

## 0. 关键假设验证

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| `grill-with-docs` 需要拆成独立机制而非整体移植 | Read 本文 §1 4 个机制拆解 | 文档已分解 Grill 协议、CONTEXT.md glossary、inline 更新协议、ADR gate 四项机制 |
| 借鉴结论必须受 TP 四原则约束 | Read 本文 §2 TP 4 不可妥协原则筛选 + §7 总评 | 文档结论偏向机制 B + D，拒绝完整移植和与现有 hook 重复的 inline 更新协议 |

## TL;DR

把 `grill-with-docs` 拆为 **4 个独立机制**，逐一用 TP 4 不可妥协原则筛：

| 机制 | 评级 | 理由 |
|---|---|---|
| Grill 协议（关闭式访谈） | ❌ 拒 | 与 /think CEO 视角范围定义哲学正交 |
| CONTEXT.md glossary 格式 | 🟡 **候选**（需用户决策） | TP 确实有 domain drift 问题（167/54 双语证据），但维护负担和触发器缺失是阻力 |
| Inline 更新协议 | ❌ 拒 | 与 TP 4-hook 自动观察体系不兼容（重复机制） |
| ADR 3-conditions gate | ✅ **强推荐** | 5 分钟落地、零风险、TP 现状已满足但未明示 |

**决策点**：见 §8。

---

## 1. 4 个机制拆解

`grill-with-docs/SKILL.md` 不是单一概念，是 4 个本可独立的协议**捆绑销售**：

### 机制 A：Grill 协议
来源：grill-me SKILL（5 行，被 grill-with-docs 复用）。
内容：「一次一问 + 提供推荐答案 + 走遍决策树每个分支 + 能查代码就查代码」。
本质：**关闭式访谈直到穷尽**。

### 机制 B：CONTEXT.md glossary 格式
来源：CONTEXT-FORMAT.md（独立文档）。
内容：定义 markdown glossary 的严格结构：
```
## Language
**Term**:
One-sentence definition.
_Avoid_: alias1, alias2

## Relationships
- A produces many B
- B belongs to one C

## Example dialogue
> Dev: "..."
> Domain expert: "..."

## Flagged ambiguities
- "X" was used to mean both A and B — resolved: ...
```
关键规则：
- **一句话定义**（"Define what it IS, not what it does"）
- **`_Avoid_` 必填**（"Be opinionated. Pick the best one"）
- **只放项目特定术语**（"general programming concepts don't belong"）
- **Example dialogue 必填**（演示术语自然交互）

### 机制 C：Inline 更新协议
来源：SKILL.md 中段。
内容：「在 grill 对话过程中**实时**写入 CONTEXT.md / ADR，不批量、不延后、不收尾时统一处理」。
本质：**行为契约**，依赖 LLM 自觉。

### 机制 D：ADR 3-conditions gate + 最小模板
来源：ADR-FORMAT.md（独立文档）。
内容：
- 三条件全真才创建：hard-to-reverse ∧ surprising-without-context ∧ result-of-real-tradeoff
- 最小模板可以是 "1 paragraph is fine"
- Optional sections（Status / Considered Options / Consequences）仅在有真实价值时加
- 7 类典型 qualifying decision（架构形状 / 集成模式 / 技术 lock-in / 边界与 scope / deliberate 偏离 / 不可见约束 / 反直觉的 rejected alternative）

---

## 2. TP 4 不可妥协原则筛选

| 机制 | 多运行时 parity | 确定性优先 | 轻量优先 | Obsidian 兼容 | 综合 |
|------|---|---|---|---|---|
| A Grill | 🟡（与 /think 重叠但风格不同） | ❌ 终止条件主观 | ❌ 关闭式访谈漫长 | ✅ | **拒** |
| B CONTEXT.md | ✅ | ✅（格式严格） | ⚠️（初始 10-15 entries）| ✅ | **候选** |
| C Inline 协议 | ✅ | ❌（依赖 LLM 纪律）| ✅ | ✅ | **拒** |
| D ADR gate | ✅ | ✅ | ✅ | ✅ | **强推荐** |

---

## 3. 深度评估：CONTEXT.md 是否真值得引入

### 3.1 TP 有 domain drift 问题吗？

**有，且量化可证**：

| 术语对 | 文件级证据 | 性质 |
|---|---|---|
| `本能` vs `instinct` | 167 vs 54 files | 双语混用，无强制规则 |
| `观察` vs `observation` | 大量混用 | 同上 |
| `compound` | 3 种含义混用 | 命令 `/compound` / 复利 / Compound Engineering 方法论 |
| `Task` (大写) vs `task` (小写) | sprint task / TodoWrite task / Codex task | 语义不同但拼写同 |
| `hook` | 5 种含义 | 4-hook 学习 / pre-commit / git / claude code permissions / installer |
| `propagate` | 脚本名 / 动作 / 副本同步机制 | 同字三义 |
| `本能` graduate vs `rule` vs `ADR` | 同一进化阶梯三层 | 三层界限模糊 |

**实证 cost**：
- 新 LLM 会话冷启动时需重新理解。SessionStart 注入 MEMORY.md，但 MEMORY.md 是事实（"user is X"），不是 lexical glossary。
- 跨副本派生（propagate-command-changes.js 类操作）时，术语不一致会让 LLM 改一处漏一处。
- 本文作者写"前置浅评"`docs/plans/2026-05-15-mattpocock-skills-analysis.md` 第 9 行就在「sibling」和「cousin」之间犹豫——典型的术语漂移。

### 3.2 与 TP 现有学习层的冲突

TP 当前学习 5 层（按抽象度从高到低）：

```
1. ADR (~/.claude/rules/architecture.md)          ← 提案级 / 决策记录
2. Rule (~/.claude/rules/*.md)                    ← 命题级 / 横向规则
3. CLAUDE.md sediment（"调试经验"等）              ← 命题级 / 项目内沉淀
4. Memory v5 + 本能（projects/<id>/...）           ← 事实级 / 自动观察
5. Observation（projects/<id>/observations/）      ← 事件级 / 原始事件
```

**CONTEXT.md 进入哪一层？**

答：**第 0 层（lexical），与上述 5 层正交**。

- vs ADR：ADR 是「为什么这么做」，CONTEXT.md 是「这个东西叫什么」。
- vs Rule：Rule 是命题（"必须 X"），CONTEXT.md 是词典（"这叫 X"）。
- vs CLAUDE.md sediment：sediment 是经验（"踩坑 Y 已解决"），CONTEXT.md 是术语（"Y 这个词指什么"）。
- vs Memory v5 + 本能：Memory v5 是事实（"用户偏好 X"），CONTEXT.md 是词汇。
- vs Observation：观察是事件，CONTEXT.md 是稳定词汇。

**结论**：填补 TP **lexical layer** 的空白，无重叠。

### 3.3 与 wikilinks `[[name]]` 的关系

TP 已用 `[[name]]` 做跨记忆引用（本能 / ADR / solutions）。

- `[[name]]` 单向 → 定义位置
- CONTEXT.md 反向 → 名字 → 定义 + 别名 + 关系

互补，不冲突。CONTEXT.md entry 顶部可加 `→ [[instinct-name]]` 把 lexical 和 propositional 连起来。

### 3.4 双语挑战（mattpocock 没考虑过）

TP 用户是 zh/en 混合写作者。mattpocock 的 CONTEXT.md 单语设计。

候选格式：

**Option A**：双标签
```markdown
**本能 / Instinct**:
A confidence-graded behavior pattern auto-extracted from observations...
_Avoid_: experience (用 经验 仅指 graduated rule), pattern (太模糊)
```

**Option B**：主中文 + 英文 _Avoid_
```markdown
**本能**:
从观察自动提取的置信度评级的行为模式...
_Avoid_: instinct (when writing English in this codebase, still prefer **本能**)
```

**Option C**：主英文（mattpocock 原版精神）
```markdown
**Instinct**:
A confidence-graded behavior pattern...
_Avoid_: 本能 (legacy; prefer **Instinct** in new writing)
```

**评估**：Option A 最贴合 TP 现实，但牺牲了 mattpocock 「pick the best one and kill the rest」的纯粹性。Option B 更激进但语义清晰。Option C 与现状偏离过大（167 vs 54 是不可逆历史）。

**推荐 Option A**，因为：(a) 真实使用就是双语并行；(b) 「opinionated」可以是「双语都对、不要用其他变种」。

### 3.5 维护成本

| 阶段 | 工作量 | 频率 |
|---|---|---|
| 初始 | 写入 10-15 个核心 term | 一次性 1-2h |
| 持续 | 新概念引入时 +1 entry | 月度 1-3 entries（与 ADR 同频）|
| 触发器缺失风险 | 谁记得更新？mattpocock 靠 grill 会话，TP 没有等价触发器 | **这是最大阻力** |

**触发器候选**：
- `/think` skill 末尾加可选段「Sharpened terms?」（轻）
- `/compound` 步骤加「terminology updates」检查（重）
- pre-commit hook lint 新 PR 是否引入新 term（重 + 噪音多）
- 完全靠人记得（轻 + 高漏率）

**结论**：初始投入小（1-2h），但**长期维护取决于触发器是否能成立**。mattpocock 的方法在 TP 上「移植」需要补这一环。

### 3.6 反方观点：CONTEXT.md 不值得引入

为了平衡判断，列出反对理由：

1. **冷启动 cost 可能高估**：TP 用户是 maintainer 自己，已熟悉术语；漂移困扰的是 LLM 而非人。SessionStart 已注入 CLAUDE.md + Memory v5，已知大量术语 context。再加 CONTEXT.md 边际收益递减。
2. **可被 instinct 替代**：把"`本能` 这词指 X"作为 confidence=1.0 的 instinct 写入 instincts 目录，自动注入；无需额外文件层。
3. **drift 本质不是缺 glossary 是缺纪律**：mattpocock 的 CONTEXT.md 在 grill session 中 inline 更新；TP 不引入 grill skill 等于没有写入触发器。**机制 B 与机制 A 绑定，单独移植机制 B 是「带头但无脖子」**。
4. **维护负担可能扩大**：50+ 实际 term 双语 = 100 entries，维护偏移会很快。
5. **可能与 Obsidian 习惯冲突**：Obsidian 自身有 backlinks + tags 体系，CONTEXT.md 不在该体系内，会形成第二个 source of truth。

### 3.7 净评估

| 方向 | 论据强度 |
|---|---|
| 引入 | drift 真实可量化 / lexical layer 正交不冗余 / Obsidian 友好 / mattpocock 实例（course-video-manager）证明可行 |
| 不引入 | 触发器缺失（核心论据）/ 可被 instinct 替代 / 维护负担放大风险 |

**作者倾向（非决策）**：触发器缺失是真正的阻碍。如果不能解决「谁来维护 + 何时更新」，CONTEXT.md 会在 3 个月内成为 stale 文档。但若先做**一次性 batch**（写入当前 15 个高频 term）+ 把更新责任挂在 `/learn` 末尾（"Did this introduce new terms? +entry"），可行性显著提升。

---

## 4. ADR 3-conditions gate：详细落地方案

### 4.1 现状对照

TP 现有 ADR-002/003/004/008/009/011/012/013 全部检验：

| ADR | hard-to-reverse | surprising | real-tradeoff | 通过 mattpocock gate? |
|---|---|---|---|---|
| 002 Memory v5 索引 | ✅ 改文件格式成本高 | ✅ 不读 SKILL 不会想到 | ✅ vs 数据库/向量 | ✅ |
| 003 外部 orchestrator | ✅ 改回内嵌成本高 | ✅ | ✅ vs claude/codex 内嵌 | ✅ |
| 004 Provider 适配内建 | ✅ | ✅ Windows shim 不易猜 | ✅ vs 用户传参 | ✅ |
| 008 Memory v5 多目录合并 | ✅ | ✅ | ✅ vs first-hit | ✅ |
| 009 auto-mode 单文件 | ⚠️ 可重构 | ✅ | ✅ | 边缘 |
| 011 identity-question-first | ⚠️ 协议级 | ✅ 反直觉 | ✅ | ✅ |
| 012 plan 阶段勘察 | ✅ 协议改回成本高 | ✅ | ✅ | ✅ |
| 013 mechanism over discipline | ✅ | ✅ | ✅ | ✅ |

**结论**：TP 现有 ADR 100% 通过 mattpocock gate。规则隐式遵循，**未明示**。

### 4.2 落地步骤

1. 在 `~/.claude/rules/architecture.md` 顶部插入：

```markdown
## ADR 创建准则（三条件 gate）

只有当全部三条满足时才创建 ADR：

1. **Hard to reverse** — 改变决定的成本是有意义的（不是 5 分钟能撤回的事）
2. **Surprising without context** — 未来读者会想"为什么这么做？"
3. **Result of real trade-off** — 存在真实备选，因具体原因选了这条

任一条缺失则跳过 ADR：
- 容易反转 → 反转就完了
- 不反直觉 → 没人会问为什么
- 没有真备选 → 只是「做了显而易见的事」

### 7 类 qualifying decisions
- 架构形状（monorepo / event-sourced 等）
- 跨上下文集成模式
- 携带 lock-in 的技术选择（DB / message bus / auth / deploy target）
- 边界与 scope 决策（"X 由 Y 上下文拥有，其他只能用 ID 引用"）
- 反直觉的偏离（"用手写 SQL 不用 ORM 因为 X"）
- 代码看不见的约束（合规要求 / 响应时间 SLA）
- 反直觉的 rejected alternative（考虑 GraphQL 选 REST，记下来免得 6 个月后又被建议）
```

2. 在项目级 `.claude/rules/architecture.md` 顶部追加同样段（保持双层一致性）。

3. **可选**：把现有 8 个 ADR 顶部各加一行 `<!-- gate: all-three -->` 注释证明已通过审核。

### 4.3 风险

- ❌ 与现有 ADR 写法冲突（TP ADR 多段写法 vs mattpocock "1 paragraph is fine"）：**不冲突**。三条件 gate 是「是否创建」的判断，不约束「创建后写多长」。TP 可继续多段写法，gate 仅约束准入。
- ❌ 与 `/compound` 流程冲突：**不冲突**。/compound 会让经验从本能毕业为 rule，再升级到 ADR——升级到 ADR 时叠加三条件 gate 即可。

### 4.4 收益

- /compound 在判断"是否升级 ADR"时有明确准则（当前依赖直觉）
- 防止 ADR 通货膨胀（未来用户复制本系统时不会乱写 ADR）
- 与 mattpocock 流派握手成功（如果未来共享其他思想，词汇已对齐）

---

## 5. Inline 更新协议（机制 C）拒绝理由

**冲突点**：

| 维度 | mattpocock inline | TP 4-hook 自动观察 |
|---|---|---|
| 触发 | LLM 在 grill 中觉察到 term 收敛 | Hook 在工具调用前后自动记录 |
| 写入对象 | CONTEXT.md / ADR | observations.jsonl / instincts/*.md |
| 时机 | 对话进行时实时 | 工具调用后 ms 级 |
| 依赖 | LLM 纪律（容易被压缩 context 击穿）| 系统级 hook（deterministic）|

引入 inline 协议 = 在 TP 已有的确定性观察层上**叠加一个 prompt-discipline 层**。后者与 [[ADR-013]] 「mechanism over discipline」立场直接矛盾。

**拒绝。**

---

## 6. Grill 协议（机制 A）拒绝理由

| 维度 | mattpocock grill | TP `/think` |
|---|---|---|
| 终止 | 决策树穷尽（主观）| 范围 + 非范围 + 成功标准 定义后即结束 |
| 提问数 | N（可能 20+）| 通常 3-5 |
| 关注 | 每个决策树分支 | scope 边界 |
| 角色 | 关闭式访谈者 | CEO/产品视角 |

`/think` 是 TP 用户已用熟的 skill。引入 grill 会形成**两个目的相似但风格不同的入口**，违反 [[mattpocock]] 自己的「make it composable」原则——多入口反而不 composable。

**拒绝。**（保留 `/think` 不变。）

---

## 7. 总评：机制 B + D 是真正的收益

| 机制 | 决策 | 时间预算 | 风险 |
|---|---|---|---|
| A Grill | 拒 | 0 | 0 |
| B CONTEXT.md | **用户决策** | 1-2h 初始 + 触发器设计 | 触发器若不成立 → stale |
| C Inline | 拒 | 0 | 0 |
| D ADR gate | **直接做** | 5 分钟 | 0 |

---

## 8. 决策点（请用户选择）

### Option 1（保守）：只做 ADR gate
- 5 分钟修两个 architecture.md 顶部
- 零结构变化
- CONTEXT.md 留作未来观察 

### Option 2（中等）：ADR gate + 一次性 CONTEXT.md batch
- 做 Option 1
- + 一次性写入 10-15 个核心 term 的 `CONTEXT.md`（不附 inline 更新协议，纯静态文档）
- 把维护责任挂在 `/learn` 末尾增加可选检查
- 工作量 2h

### Option 3（激进）：完整移植
- 做 Option 2
- + 加 `/glossary` skill 作为显式更新入口
- + 在 `/think` 末尾加 "Sharpened terms?" 段
- 工作量 4-6h，机制更完整但维护负担最大

### Option 4：搁置
- 都不动，本研究归档作为「评估完成，结论是不引入」的明确记录
- 触发器缺失论据成立，等触发器思路成熟再来

---

## 9. 元观察

- 这次 sibling-eval 的产物是「一份分析 + 一个决策点」**不是「一个落地决策表」**——遵循 [[feedback_sibling_eval_default_compare_not_borrow]]。
- 把 grill-with-docs 拆为 4 个机制单独评估，比"整体借鉴/不借鉴"得到了更精细的结论（拒 2 借 1 候选 1）。**机制拆解**作为 sibling-eval 通用模式可能值得固化为 instinct。
- 「触发器缺失」是这次研究最重要的发现——机制 B（CONTEXT.md）和机制 A（grill）在 mattpocock 那里是**捆绑销售**的，单独移植 B 时缺失 A 这个触发器是核心阻力。**Tools-bundle-vs-mechanism 的拆解经验**也值得固化。

---

## 变更日志

- 2026-05-15 完成。**未实施任何借鉴**，等待用户在 §8 中决策。
