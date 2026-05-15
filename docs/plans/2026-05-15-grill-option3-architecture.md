---
title: "Option 3 完整实践架构：grill-with-docs 激进移植方案"
type: plan
status: draft
created: "2026-05-15"
updated: "2026-05-15"
tags: [plan, glossary, lexical-layer, architecture, sibling-eval-followup]
aliases: ["grill-option3"]
sources:
  - docs/plans/2026-05-15-grill-with-docs-deep-dive.md (前置评估)
  - https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs
---

# Option 3 完整实践架构

> 实施 [[2026-05-15-grill-with-docs-deep-dive]] §8 Option 3。本文是**架构 + 实施计划**，**不包含代码落地**。
> 总工作量预估：4-6h，6 phase 拆分。

---

## 0. 设计目标

| 目标 | 量化指标 |
|---|---|
| 1. 给 TP 补 **lexical layer**（词典层） | CONTEXT.md 存在并被 SessionStart 注入 |
| 2. 解决「触发器缺失」核心阻力 | 4 个 ingress 点（手动 / `/learn` / `/compound` / `/think`）全部工作 |
| 3. 多运行时 parity 守住 | Claude Code + Codex 双端 `/glossary` `$glossary` 等价可用 |
| 4. 落地 ADR 3-conditions gate | architecture.md 顶部 + 4 行准则 + 7 类 qualifying 列表 |
| 5. drift 检测可机械化 | pre-commit lint 软失败 + 报告（首版不阻塞）|
| 6. 反 stale 机制 | `/glossary lint --drift` 子命令检测 N 月未更新 entry |

**非目标**：
- ❌ 不移植 `grill-with-docs` 的关闭式访谈协议（已拒，见 deep-dive §6）
- ❌ 不实施 inline 更新协议（已拒，见 deep-dive §5）
- ❌ 不重写现有 ADR（仅在顶部追加 gate 准则）

---

## 1. 关键假设验证（ADR-012 强制）

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方法 | 验证结果 |
|---|---|---|
| `scripts/propagate-command-changes.js` 已支持 5 副本（含 skills）派生 | 读源文件 1-100 行 | ✅ 已支持 `plugins/.../skills/<cmd>/SKILL.md` + `.codex/skills/<cmd>/SKILL.md` + `user-level/skills/<cmd>/SKILL.md` 三类 skill 目标 |
| `scripts/inject-context.js` 是 SessionStart hook，可加新注入源 | 读源文件 1-130 行 | ✅ 已有 `Auto Memory v5` 注入段，可平行加 `Glossary` 段 |
| `scripts/pre-commit-check.js` 可加新 checker | 项目已有 `checkPropagateSync` / `checkOrchestratorSync` / `checkPlanScope` / `checkPlanCompletion` 4 个 checker | ✅ 加 `checkGlossaryConsistency` 是平行扩展 |
| `~/.claude/rules/architecture.md` 在用户级，项目级也有同名文件 | `ls ~/.claude/rules/ .claude/rules/` | ✅ 两端都存在，需保持一致性 |
| TP 现有 `本能` 双语漂移可量化 | `git grep -c` | ✅ 167 文件用「本能」、54 文件用「instinct」 |
| `/learn` 已有 G1-G5 严格 Gate 机制 | 读 plugins/.../learn/SKILL.md | ✅ Gate 机制存在，新增 glossary gate 是同模式扩展 |

**所有 6 个关键假设已勘察验证。**

---

## 2. 架构定位：lexical layer 在 TP 中的位置

```text
┌─────────────────────────────────────────────────────────┐
│ TP 学习系统分层（原 5 层 → 加 lexical layer 后 6 层）      │
├─────────────────────────────────────────────────────────┤
│ Layer 0: Lexical    ← NEW: CONTEXT.md（词典）              │
│ Layer 1: ADR        ← `architecture.md`（高级决策）         │
│ Layer 2: Rule       ← `rules/*.md`（横向命题）              │
│ Layer 3: Sediment   ← CLAUDE.md 技术沉淀段（项目内沉淀）     │
│ Layer 4: Instinct   ← `homunculus/instincts/`（自动观察提取）│
│ Layer 5: Observation← `homunculus/observations/`（原始事件）│
└─────────────────────────────────────────────────────────┘

注入链：SessionStart hook
  → inject-context.js
    → CLAUDE.md / AGENTS.md（含 sediment 段）
    → MEMORY.md（Layer 4 → Layer 0）  [现有]
    → CONTEXT.md（Layer 0）            [NEW]
    → 高优先级 instincts（Layer 4）    [现有]
```

**lexical layer 与其他层的关系**：
- 与 Layer 1-3（命题层）正交：词典回答「这叫什么」，命题回答「必须怎么做」
- 与 Layer 4-5（事件层）通过 `[[name]]` wikilinks 联结：CONTEXT.md entry 顶部可链向相关本能
- 与 Memory v5 互补：Memory v5 是事实索引（"user is X"），CONTEXT.md 是术语词典（"X 这个词什么意思"）

---

## 3. 文件结构（完整清单）

### 3.1 新增文件

```text
项目根
├── CONTEXT.md                                       ★ 主词典（git tracked）
├── CONTEXT-FORMAT.md                                ★ 格式参考（git tracked）
│
plugins/tech-persistence/skills/glossary/
└── SKILL.md                                         ★ /glossary skill 源
│
user-level/
├── commands/glossary.md                             ★ 命令文档源（propagate 起点）
└── skills/glossary/SKILL.md                         ★ user 级 skill（由 propagate 派生）
│
scripts/
├── glossary-lint.js                                 ★ drift / 一致性检测脚本
└── lib/glossary.js                                  ★ 解析 CONTEXT.md + 公共工具
│
docs/plans/
└── 2026-05-15-grill-option3-architecture.md         ← 本文档
```

### 3.2 修改文件

```text
项目级
├── .claude/rules/architecture.md                    + ADR gate 段（顶部）
├── plugins/tech-persistence/skills/think/SKILL.md   + "Sharpened terms?" 段（末尾）
├── plugins/tech-persistence/skills/learn/SKILL.md   + Glossary gate（路由判定旁）
├── plugins/tech-persistence/skills/compound/SKILL.md+ Glossary review 步骤
│
用户级（globally installed）
├── ~/.claude/rules/architecture.md                  + ADR gate 段
│
基础设施
├── scripts/inject-context.js                        + injectGlossary() 段
├── scripts/pre-commit-check.js                      + checkGlossaryConsistency()
├── scripts/propagate-command-changes.js             + glossary 加入命令清单
└── scripts/lib/memory-search.js                     + glossaryEntries() 检索函数
│
派生副本（自动生成，列出便于审计）
├── .claude/commands/glossary.md
├── plugins/tech-persistence/commands/glossary.md
├── .codex/commands/glossary.md
├── .codex/skills/glossary/SKILL.md
└── user-level 端反向同步段
```

**总计**：4 个新增源文件 + 4 个新增脚本 + 6 个修改文件 + ~6 个 propagate 派生副本。

---

## 4. CONTEXT.md 内容架构

### 4.1 双语策略（最终决定）

**采用 Option A 的优化版本**：

- **主标签**：中文为主 + 英文等价（用 `/` 连接）
- **`_Avoid_` 杀掉的是**：其他非等价变种（如 "pattern" / "experience" / "guideline"）
- **不杀掉的是**：中文与英文的等价（如 「本能」 ↔ `Instinct` 双向有效）

格式示例：

```markdown
**本能 / Instinct**:
从观察自动提取的置信度评级的行为模式，存于 `~/.claude/projects/<id>/instincts/`，置信度 ≥ 0.9 时毕业至 `~/.claude/rules/*.md`。
_Avoid_: experience (用「经验」专指 graduated rule), pattern (太模糊), learning (用「学习」专指 active extraction action)
```

### 4.2 分组结构（5 组）

```markdown
# CONTEXT.md - tech-persistence 项目词典

> 词典层（Layer 0）。回答「这个词在本项目中确切指什么」+「不要用什么变种」。
> 不放通用编程概念（timeout / error / cache 等）。

## Learning System（学习系统）
- 本能 / Instinct
- 经验 / Experience / Rule
- 观察 / Observation
- ADR
- 沉淀 / Sediment
- 毕业 / Graduate
- 置信度 / Confidence
- 复利 / Compound（方法论，不是命令）

## Workflow（工作流）
- Sprint
- Phase
- Task（大写：sprint 任务单元，与小写 todo task 不同）
- 检查点 / Checkpoint
- 交接 / Handoff
- 预热 / Pre-warm（Phase 间 hook）

## Architecture（架构）
- Hook（5 种含义需消歧）
- Skill / Command（在本项目中区分）
- Runtime（Claude Code / Codex 两个）
- Multi-runtime parity
- 派生 / Propagate
- Dogfood / 自试
- Fail-open
- Caveman mode

## Storage（存储）
- Memory v5
- Topic（Memory v5 的最小单位）
- Homunculus
- Project id
- MEMORY.md（与 CLAUDE.md 区分）

## Enforcement（强制层）
- Pre-commit check
- Multi-copy sync
- Mechanism over discipline
- Grandfather signal

## Relationships
- 一个 **Observation** 累积 N 次后提取成 **本能**
- 一个 **本能** 置信度 ≥ 0.9 时 **毕业** 为 **经验** / **ADR**
- 一个 **Sprint** 由 5 个 **Phase** 组成，每 Phase 推进多个 **Task**
- 每 5 **Task** 触发一次 **Checkpoint**，生成 **交接** 文件
- 一个 **Hook** 钩到 **Runtime** 的事件点上（SessionStart / PreToolUse / PostToolUse / Stop / UserPromptSubmit）
- 一个源文件 **派生** 到多个 **Runtime** 副本（**Multi-runtime parity**）
- **Memory v5** 在每个 **Runtime** 各有一个根目录，但 SessionStart 时合并注入（见 [[ADR-008]]）

## Example dialogue
> **用户**：「这个 `本能` 应该升 ADR 吗？」
> **助手**：「让我用 ADR gate 三条件检查 [[ADR-013-section-B]]：(1) hard-to-reverse ✅ (2) surprising-without-context ✅ (3) result-of-real-tradeoff ⚠️ —— 边缘。它通过了**毕业** gate（置信度 ≥ 0.9），但只满足 2/3 ADR gate，建议先写到 **经验** 层（`rules/*.md`），不升 ADR。」

## Flagged ambiguities
- `Task`（大写 vs 小写）：sprint 任务用大写，TodoWrite todo 用小写。Codex 的 task 概念用 `Codex task` 全称。
- `Hook` 五种含义：(1) Claude/Codex SessionStart/PreToolUse/PostToolUse/Stop/UserPromptSubmit 学习 hook；(2) git pre-commit hook；(3) git 其他 hook；(4) Claude Code permissions hook（settings.json hooks 字段）；(5) installer hook。**默认指 (1)**，其余需明示。
- `Compound`（方法论 vs 命令）：方法论叫「Compound Engineering」，命令叫 `/compound`。
- `本能` vs `instinct`：等价，可互换；但 **不要用** `experience` / `pattern` / `learning` 替代。
- `学习` vs `learn`：等价；但 `/learn` 是命令名，不指方法论本身。
- `Sediment` vs `沉淀` vs `tech sediment`：等价。`CLAUDE.md` 中的 `### 技术沉淀（通用经验）` 即是。
```

### 4.3 初始 20 个 term 完整列表

按 §4.2 五组列出，每组 4 个：

| 组 | Term | 一句话定义 | _Avoid_ |
|---|---|---|---|
| Learning | 本能 / Instinct | 从观察自动提取的置信度评级的行为模式 | experience, pattern, learning |
| Learning | 经验 / Experience / Rule | 毕业到 `rules/*.md` 的永久规则 | instinct (< 0.9 时), guideline |
| Learning | 观察 / Observation | 4-hook 自动捕获的原始事件 | event, log entry |
| Learning | 毕业 / Graduate | 本能升级为经验或 ADR 的过程 | promote, upgrade |
| Workflow | Sprint | 一次 /sprint 的完整 5-phase 循环 | iteration, cycle |
| Workflow | Phase | sprint 内的 5 个阶段之一 | step, stage |
| Workflow | Task（大写） | sprint phase 内的任务单元 | todo, item |
| Workflow | 检查点 / Checkpoint | 每 5 Task 自动保存的进度点 | save point, snapshot |
| Architecture | Hook | TP 学习层的 4-hook + 1 UserPromptSubmit | event handler, listener |
| Architecture | 派生 / Propagate | 单源 → 多副本同步动作 | copy, sync |
| Architecture | Dogfood | 用项目自身验证项目自身的新规则 | self-test, eat own |
| Architecture | Fail-open | enforcement 失效时放行（不阻塞用户）| graceful degradation |
| Storage | Memory v5 | TP 当前的跨会话记忆系统（topic-based） | memory, memories |
| Storage | Topic | Memory v5 中的最小知识单元 | category, tag |
| Storage | Homunculus | TP 的本地学习数据根目录 | knowledge base, store |
| Storage | Project id | 项目目录路径的 hash，用作 homunculus 子目录 | project key, hash |
| Enforcement | Pre-commit check | `scripts/pre-commit-check.js` 多 checker 框架 | git hook, lint |
| Enforcement | Multi-copy sync | propagate 后多副本一致性的强制保证 | replication |
| Enforcement | Mechanism over discipline | [[ADR-013]] 立场：把规则下沉为工具拒绝 | rule, policy |
| Enforcement | Grandfather signal | 旧产物豁免新规则的判定信号（如 filename date） | exemption, legacy |

**初始 batch 工作量**：20 个 entry × 5 分钟/entry = ~100 分钟。

### 4.4 多 context 处理

mattpocock 支持 `CONTEXT-MAP.md` 多上下文场景。**TP 不需要**——本项目是单一 product（self-evolution methodology system），单一 `CONTEXT.md` 足够。

未来若分裂出独立子系统（如 agent-loop 单独 release），再引入 CONTEXT-MAP.md。

---

## 5. `/glossary` skill 完整设计

### 5.1 子命令清单

参考 `/skill <action>` 多动作模式（已实现，见 `plugins/tech-persistence/skills/skill/SKILL.md`）：

| 子命令 | 用途 | 输入 |
|---|---|---|
| `/glossary add <term>` | 交互式添加新 entry | term 名 |
| `/glossary list` | 输出所有 entry（分组） | （无） |
| `/glossary search <query>` | 模糊搜索 entry | 关键词 |
| `/glossary lint` | 一致性检查（同 pre-commit checker，可手动跑） | （无）/ `--drift` flag |
| `/glossary sync-from-instinct` | 扫描最近 instincts，建议新 entry | （无）/ `--since=2w` |

**Codex 端**：`$glossary <subcommand>` 等价（propagate 自动同步）。

### 5.2 SKILL.md 主体草稿

```markdown
---
name: glossary
description: TP 项目词典管理。维护 CONTEXT.md 的 lexical layer，包含 add/list/search/lint/sync 5 个子动作。Use when user wants to add a term, check term consistency, or detect glossary drift.
---

# /glossary - 项目词典管理

维护 `CONTEXT.md`（TP 的 lexical layer）。

## 用法

```text
/glossary add <term>         ← 交互式新增（推荐流程）
/glossary list               ← 输出所有 entry（按分组）
/glossary search <query>     ← 模糊搜索
/glossary lint               ← 一致性检查（与 pre-commit 等价，可手动跑）
/glossary lint --drift       ← drift 检测（N 月未更新的 stale entry）
/glossary sync-from-instinct ← 扫描近期 instincts 建议新 entry
/glossary sync-from-instinct --since=2w ← 时间窗口可指定
```

## 角色约束

你现在是词典管理员。

- ✅ 关注：术语精确性、`_Avoid_` 列表完整性、双语等价标注
- ❌ 不关注：术语的应用场景（那是 rules 层）、术语的判断逻辑（那是 instinct 层）

## 执行细节（子命令）

### add <term>

1. 检查 `CONTEXT.md` 是否已存在该 term（fuzzy match：term 主体或 _Avoid_ 列表）
2. 若存在 → 提示用户使用 `update` 流程（暂未实现，先报错）
3. 若不存在 → 交互式询问：
   - 一句话定义（强制 ≤ 80 字，"WHAT it IS not what it does"）
   - 中英等价对（"this term has English equivalent?"）
   - `_Avoid_` 列表（"any aliases to kill?"）
   - 归属分组（5 选 1：Learning / Workflow / Architecture / Storage / Enforcement，或建议新组）
   - 相关 `[[name]]` 链接（可选）
4. **dogfood gate**（[[ADR-013-section-B]]）：插入 CONTEXT.md 前用 `glossary lint` 跑一次，若新 entry 触发任何 lint 警告则提示用户

### list

输出 `CONTEXT.md` 的所有 entry，分组显示 + 每组计数。caveman mode 下输出压缩为：
```text
Learning: 8 entries
Workflow: 6 entries
Architecture: 4 entries
Storage: 3 entries  
Enforcement: 3 entries
Total: 24
```

### search <query>

支持：(a) term 名字 fuzzy；(b) 定义中关键词；(c) `_Avoid_` 列表反向查询（输入别名找到 canonical term）。

### lint / lint --drift

调用 `scripts/glossary-lint.js`（见 §8）。

### sync-from-instinct [--since=2w]

1. 读取 `~/.claude/projects/<id>/instincts/*.md`（最近 N 周）
2. 提取每个 instinct 的 frontmatter `name` + 描述中的领域名词
3. 与 CONTEXT.md 现有 term 比对，建议未收录的高频名词
4. 输出候选列表，让用户选择性 `add`

## 何时用 /glossary vs 其他

- `/glossary` ←→ `/learn`：`/learn` 末尾会自动 gate（"Did this introduce new terms?"），若用户接受则跳到 `/glossary add`
- `/glossary` ←→ `/think`：`/think` 末尾可选触发 "Sharpened terms?"，同上
- `/glossary` ←→ `/compound`：`/compound` 步骤 9.5（新增）扫 glossary 健康度

## Phase 间预热

（仅在 `/sprint` 内调用时使用，本 skill 通常独立调用，不进 sprint phase 序列）
```

### 5.3 与 `/skill <action>` 多动作模式的一致性

参考 `/skill` 已有 5 子动作（diagnose/eval/improve/publish/auto/list）的实现，`/glossary` 5 子动作同模式：
- 单一 skill 入口
- 子命令解析在 SKILL.md 顶部
- 每个子命令独立段落
- caveman mode 输出压缩

---

## 6. `/think` `/learn` `/compound` 集成

### 6.1 `/think` 末尾追加段（非强制 gate）

在 `plugins/tech-persistence/skills/think/SKILL.md` 第 70-72 行附近（"### 4. 持久化到项目文档" 之后），追加：

```markdown
### 5. 词汇校准（可选，但鼓励）

读 `CONTEXT.md`。检查本次需求分析是否：

- **引入了新名词** 且该名词不在 CONTEXT.md 中？→ 提示用户 `/glossary add <term>`
- **使用了 _Avoid_ 列表中的别名**？→ 在输出末尾换用 canonical term，并标注
- **暴露了术语漂移**（同一概念被两种说法描述）？→ 在 `Flagged ambiguities` 段建议添加条目

**不要打断 /think 主流程**——只在末尾 1 行汇报：

```text
词汇校准: 0 新名词 / 1 别名替换 / 0 漂移建议
```

或：

```text
词汇校准: 建议 /glossary add Memory-v5-topic（在 Storage 组）
```
```

**触发原则**：可选段，不阻塞 /think 完成。 caveman mode 也保留（信息密度高）。

### 6.2 `/learn` 末尾 Glossary Gate

`plugins/tech-persistence/skills/learn/SKILL.md` 已有 G1-G5 严格 Gate（路由判定）。在 Gate 流程末尾追加 **G6**：

```markdown
### G6 · 引入新名词检查

如果本次 /learn 提取的本能或经验涉及未在 CONTEXT.md 中的项目特定名词：

- ✅ 检测到 → 在报告中追加一行：「建议 /glossary add: <term1>, <term2>」
- ❌ 未检测到 → 略过

**重要**：不阻塞 /learn 完成，仅作为建议输出。
```

### 6.3 `/compound` 步骤 9.5（新增）

`/compound` 当前末尾步骤是「健康摘要」（参考 [[ADR-013]] 的 dogfood 边界自检）。新增步骤 9.5「Glossary 健康摘要」：

```markdown
### 步骤 9.5 - Glossary 健康摘要

调用 `scripts/glossary-lint.js --report`：

- entry 总数
- 各组分布
- N 月未更新的 stale entry 数
- 本次 /compound 引入的新 term 数

输出示例（healthy）：
```text
📚 Glossary: 24 entries / 5 groups / 0 stale / 0 new
```

输出示例（recommend）：
```text
📚 Glossary: 24 entries / 5 groups / 3 stale > 3mo / 2 new pending review
  ⚠️ recommend: /glossary lint --drift 复审 stale entries
```

阈值（同 /compound 健康摘要的三档原则）：
- `healthy`：stale < 5, new pending == 0
- `observe`：stale 5-10, new pending 1-3
- `recommend`：stale > 10 或 new pending > 3
```

---

## 7. SessionStart 注入策略

### 7.1 always-on 还是 prompt-recall？

**决策：always-on 注入**。

理由：
1. CONTEXT.md 是 lexical foundation，每个 LLM 请求都可能用到术语 → always-on 收益高
2. Prompt-recall（按需检索）会延迟首次术语理解，违背词典层「常驻意识」的设计目的
3. 预估 CONTEXT.md 大小：20 entries × ~150 字符 + relationships + dialogue ≈ 5KB
4. 现有 inject-context.js 已注入 ~10KB（CLAUDE.md + MEMORY.md），再加 5KB 仍在合理范围
5. 真正长大后（>10KB）再切 prompt-recall

### 7.2 token 预算

| 组件 | 预算 | 当前态 |
|---|---|---|
| CONTEXT.md 主体 | ≤ 5KB | 0KB（不存在）|
| Glossary 注入段（含 header） | ≤ 5.5KB | 0KB |
| **超出时**：自动裁剪 | 保留前 60% + ellipsis 提示用户 | N/A |

裁剪策略：保留 Learning + Workflow（最高频两组），其他组按 `lint --drift` 报告排序，stale 优先裁。

### 7.3 `inject-context.js` 接入点

在 `scripts/inject-context.js` 现有 `Auto Memory v5 (MEMORY.md concise index)` 段后追加：

```javascript
// 伪代码示意，不是最终实现
function injectGlossary(injectContext, opts) {
  const glossaryPath = path.join(opts.projectRoot, 'CONTEXT.md');
  if (!fs.existsSync(glossaryPath)) return null;  // fail-open

  const content = fs.readFileSync(glossaryPath, 'utf8');
  const truncated = truncateToBudget(content, 5500);  // bytes

  injectContext.append({
    title: 'Project Glossary (CONTEXT.md)',
    body: truncated,
    priority: 8,  // 高于 instincts (5)，低于 ADR (10)
  });
}
```

**fail-open**：CONTEXT.md 不存在时静默返回，不报错（同 [[ADR-013]] 三层防御原则）。

---

## 8. Pre-commit lint

### 8.1 `checkGlossaryConsistency()` 设计

新增 `scripts/lib/glossary.js` 提供解析能力 + 在 `scripts/pre-commit-check.js` 注册新 checker：

```javascript
// scripts/lib/glossary.js 公共工具
function parseGlossary(path) {
  // 返回 { entries: [{term, definitions, avoid, group}], relationships, ambiguities }
}

function findAvoidUsage(text, glossary) {
  // 返回 [{ avoidTerm, canonicalTerm, lineNumber, snippet }]
}

// scripts/pre-commit-check.js
function checkGlossaryConsistency({ stagedFiles, repoRoot }) {
  const glossary = parseGlossary(path.join(repoRoot, 'CONTEXT.md'));
  if (!glossary) return { ok: true, findings: [] };  // fail-open

  const findings = [];
  for (const file of stagedFiles) {
    if (!file.endsWith('.md')) continue;
    if (isGrandfathered(file)) continue;  // §8.3
    const text = fs.readFileSync(file, 'utf8');
    findings.push(...findAvoidUsage(text, glossary));
  }
  return { ok: findings.length === 0, findings, severity: 'warn' };
}
```

### 8.2 软失败 vs 硬失败策略

**首版：软失败（warning only）**。

理由：
- ADR-013 §B 要求新 enforcement 不能立刻误拒已有产物
- 项目现有 167 文件含「本能」、54 含「instinct」，立即硬失败会全数误拒
- 软失败先收集真实违规率，3 个月后再评估升级硬失败

升级条件（未来）：
- soft warning 期 ≥ 3 个月
- 历史文件全量 audit 通过率 ≥ 95%
- 全部已存在违规要么修复、要么显式 grandfather

### 8.3 grandfather signal

参考 [[ADR-013]] 的 grandfather 模式（filename date）：

**豁免清单**：
- `docs/plans/2026-04-*` 之前所有 plan 文件（早期产物，写作时无 glossary）
- `docs/plans/2026-04-23-homunculus-sharing-handoff-*.md` 全部（自动生成 handoff）
- 任何含 `<!-- glossary: skip -->` HTML 注释的文件
- examples/ 下所有文件（教学用，可能故意用 _Avoid_ 词演示）

### 8.4 与 propagate 的协同

`propagate-command-changes.js` 当前不读 CONTEXT.md。**不需要改动**——propagate 处理副本派生，与 lint 是正交职责。

---

## 9. Trigger 网完整流转图

```text
┌────────────────────────────────────────────────────────────────┐
│ 触发点（Ingress）                                                │
├────────────────────────────────────────────────────────────────┤
│  A. 用户手动                                                     │
│     /glossary add <term>                                        │
│       ↓                                                          │
│       /glossary lint (gate)                                      │
│       ↓ ✓                                                        │
│       写入 CONTEXT.md → propagate to runtimes                    │
│                                                                  │
│  B. /think 末尾自动                                              │
│     /think 检测到新名词                                          │
│       ↓                                                          │
│       输出建议 "/glossary add X"                                 │
│       ↓                                                          │
│       用户接受 → 转 A                                            │
│                                                                  │
│  C. /learn G6 gate                                              │
│     /learn 提取本能含未收录名词                                  │
│       ↓                                                          │
│       报告末尾输出建议                                            │
│       ↓                                                          │
│       用户接受 → 转 A                                            │
│                                                                  │
│  D. /compound 步骤 9.5                                          │
│     扫 instincts + sediment，发现频繁未收录名词                  │
│       ↓                                                          │
│       输出健康摘要 + 建议清单                                     │
│       ↓                                                          │
│       用户接受 → 转 A 或批量                                      │
│                                                                  │
│  E. /glossary sync-from-instinct                                │
│     周期性手动批量同步                                            │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ 复查 / drift 检测                                                │
├────────────────────────────────────────────────────────────────┤
│  /glossary lint --drift                                          │
│  /compound 步骤 9.5 输出                                         │
│  pre-commit checkGlossaryConsistency （软失败 warn）              │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ 销毁                                                              │
├────────────────────────────────────────────────────────────────┤
│  手动编辑 CONTEXT.md 删除 entry                                  │
│  （暂不提供 /glossary remove，避免误删）                          │
└────────────────────────────────────────────────────────────────┘
```

---

## 10. 多运行时 parity 文件清单

`/glossary` 走 `propagate-command-changes.js` 现有 5 副本派生流程。新增到 propagate 命令清单：

```javascript
// scripts/propagate-command-changes.js 修改
node scripts/propagate-command-changes.js \
  sprint work plan review think \
  agent-loop test prototype evolve \
  glossary  // ← NEW
```

派生后产生的副本（自动）：

| Path | 派生自 | 转换 |
|---|---|---|
| `plugins/tech-persistence/commands/glossary.md` | user-level/commands/glossary.md | verbatim copy |
| `plugins/tech-persistence/skills/glossary/SKILL.md` | user-level/commands/glossary.md | 注入到 skill wrapper |
| `.codex/commands/glossary.md` | user-level/commands/glossary.md | Claude→Codex regex |
| `.codex/skills/glossary/SKILL.md` | (前一个) | (前一个) |
| `user-level/skills/glossary/SKILL.md` | user-level/commands/glossary.md | 注入到 skill wrapper |

**额外 parity 任务**：
- `~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md` 同步更新提及 CONTEXT.md
- 若用户级有独立 CONTEXT.md → 暂不实现（只做项目级，后续观察）

---

## 11. 实施阶段拆分

### Phase 0：基础设施（30 分钟）

- [ ] 写 `CONTEXT-FORMAT.md`（项目根，参考 mattpocock 的 format 但本土化）
- [ ] 写 `scripts/lib/glossary.js`（parseGlossary / findAvoidUsage 等公共工具）
- [ ] 单测 parseGlossary 解析样例

**产出**：基础设施可单独跑测试。

### Phase 1：初始 batch（90 分钟）

- [ ] 按 §4.3 写入 20 个 entry 到 `CONTEXT.md`
- [ ] 检查与现有 `~/.claude/rules/*.md` 描述无冲突
- [ ] 在 5 个高频文件中替换 `_Avoid_` 别名为 canonical term（dogfood + 验证 entries 写得对）

**dogfood**：本 step 必须用项目自身验证（[[ADR-013-section-B]]）。具体边界产物枚举见 §12。

### Phase 2：`/glossary` skill（60 分钟）

- [ ] 写 `user-level/commands/glossary.md`（按 §5.2 草稿扩展）
- [ ] 跑 `propagate-command-changes.js glossary` 产生 5 副本
- [ ] 验证 Claude Code 端 `/glossary list` 工作
- [ ] 验证 Codex 端 `$glossary list` 工作

### Phase 3：`/think` `/learn` `/compound` 集成（60 分钟）

- [ ] 修改 `plugins/.../think/SKILL.md` 末尾追加 §5 段
- [ ] 修改 `plugins/.../learn/SKILL.md` 末尾追加 G6 段
- [ ] 修改 `plugins/.../compound/SKILL.md` 步骤 9.5 段
- [ ] 跑 propagate 同步到 .codex 副本
- [ ] 手动测试 3 个 skill 末尾的提示工作

### Phase 4：SessionStart 注入（45 分钟）

- [ ] 修改 `scripts/inject-context.js` 加 `injectGlossary()` 段
- [ ] token 预算守住 5.5KB
- [ ] fail-open 测试：删除 CONTEXT.md 后 SessionStart 不报错
- [ ] 新 session 内验证 CONTEXT.md 内容已注入

### Phase 5：Pre-commit lint（45 分钟）

- [ ] 写 `scripts/glossary-lint.js`（standalone 也可手动跑）
- [ ] 在 `scripts/pre-commit-check.js` 注册 `checkGlossaryConsistency`
- [ ] 软失败模式（warning 不阻塞 commit）
- [ ] grandfather 清单生效
- [ ] smoke test 4 场景：pass / warn / grandfather / fail-open

### Phase 6：ADR gate 段（15 分钟）

- [ ] 在 `~/.claude/rules/architecture.md` 顶部追加 §4.2 的 ADR gate 段
- [ ] 在 `.claude/rules/architecture.md` 同步追加
- [ ] 验证现有 8 个 ADR 全部通过 gate

**总预算**：30 + 90 + 60 + 60 + 45 + 45 + 15 = **345 分钟 ≈ 5.75h**（含验证）

---

## 12. Dogfood 边界（[[ADR-013-section-B]] 强制）

按 ADR-013 §B 要求，列出本次 enforcement（pre-commit lint）会拒绝的现有产物，验证误拒率：

### 12.1 边界产物枚举

预估 lint 触发现有违规的文件数（基于 §1 量化数据）：

| 现有产物 | 是否会触发 lint | 处理 |
|---|---|---|
| `docs/plans/2026-04-*` 全部 plan | ✅ 高概率触发（含 instinct/experience 混用）| **grandfather**（filename date < 2026-05-15）|
| `docs/plans/2026-04-23-homunculus-sharing-handoff-*` | ✅ 必触发 | grandfather |
| `examples/` 下所有 | ⚠️ 可能触发（演示用）| `<!-- glossary: skip -->` 标注 |
| `~/.claude/rules/*.md` | ⚠️ 可能触发 | 在 Phase 1 第 3 步主动修复 |
| `.claude/rules/*.md` | ⚠️ 可能触发 | 同上 |
| `plugins/.../skills/*/SKILL.md` 全部 | ⚠️ 可能触发 | 在 Phase 3 主动修复（顺手）|
| `CLAUDE.md` 根 | ⚠️ 可能触发 | Phase 1 第 3 步主动修复 |

### 12.2 负样本验证（[[ADR-013-section-B]] 强制）

dogfood 必须做正反两类验证：

**正样本**：当前态合规应通过
- 跑 `node scripts/glossary-lint.js`，应输出 `0 violations`（grandfather + 已修文件覆盖后）

**负样本**：制造违规应被检出
- 在 `CLAUDE.md` 临时加 `experience` 替代 `本能`，再跑 lint
- 应输出 1 个 warning 指向具体行号 + 建议 canonical term
- 恢复后再跑 lint 应通过

### 12.3 报错信息必须 copy-paste runnable（[[ADR-013]] 要求）

```text
CONTEXT.md violation in CLAUDE.md:42:
  Used 'experience' but CONTEXT.md prefers '本能 / Instinct'
  Fix: replace 'experience' with '本能' or 'Instinct'

  Hint: 'experience' is reserved for graduated rules (rules/*.md content).
  See CONTEXT.md Learning section.
```

不能含 `<term>` 类占位符。

---

## 13. 风险与回滚

### 13.1 风险表

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 触发器全部失效 → 3 月后 stale | 中 | 高（核心阻力复发）| §6 的 4 个 ingress 点冗余设计；lint --drift 兜底 |
| 初始 20 entry 选择错误（漏掉高频 term）| 低 | 中 | 第一个月后跑 `sync-from-instinct` 补漏 |
| 双语策略不被自然接受（用户改写为单语）| 低 | 中 | 跟踪用户行为，必要时改 Option B/C |
| token 注入超 5.5KB 预算 | 低 | 低 | §7.2 裁剪策略 |
| pre-commit lint 升级硬失败时大量误拒 | 低（首版软失败）| 高 | 升级前 3 个月软失败期 + audit |
| `/glossary` 5 子动作中部分用不到（如 search）| 中 | 低 | 不影响其他子动作 |
| `_Avoid_` 列表覆盖不全 | 中 | 低 | 周期性 `lint --drift` 补漏 |

### 13.2 回滚方案

每个 Phase 独立可回滚：

| Phase | 回滚步骤 |
|---|---|
| 0 | `git rm CONTEXT-FORMAT.md scripts/lib/glossary.js` |
| 1 | `git rm CONTEXT.md` + 还原 5 个修改文件 |
| 2 | `git rm` 6 个 glossary skill 副本 |
| 3 | `git checkout` think/learn/compound SKILL.md |
| 4 | `git checkout` inject-context.js |
| 5 | `git rm` glossary-lint.js + `git checkout` pre-commit-check.js |
| 6 | `git checkout` architecture.md（两端）|

**最坏情况完整回滚**：< 5 分钟。

### 13.3 stale 检测兜底

`/compound` 步骤 9.5 输出"recommend"档时自动建议跑 `lint --drift`，避免 stale 累积无人察觉。

---

## 14. 关键决策记录（执行前确认）

执行前需要用户确认的 3 个关键决策：

| 决策点 | 推荐 | 备选 |
|---|---|---|
| CONTEXT.md 位置 | 项目根 | `.claude/CONTEXT.md` / `docs/CONTEXT.md` |
| 双语策略 | Option A（双标签 + opinionated _Avoid_） | Option B 主中文 / Option C 主英文 |
| lint 首版严格度 | 软失败（warning only） | 硬失败（拒 commit） |
| 初始 entry 数 | 20（5 组 × 4） | 10（仅 Learning + Workflow） / 30（更全）|
| 是否做 §6 三个 skill 集成 | 全做 | 只做 /learn G6（最关键触发器） |

---

## 15. 时间总预算

| Phase | 时间 | 累计 |
|---|---|---|
| 0 基础设施 | 30 min | 0:30 |
| 1 初始 batch | 90 min | 2:00 |
| 2 /glossary skill | 60 min | 3:00 |
| 3 三 skill 集成 | 60 min | 4:00 |
| 4 SessionStart 注入 | 45 min | 4:45 |
| 5 Pre-commit lint | 45 min | 5:30 |
| 6 ADR gate | 15 min | **5:45** |

**总预算：5h45min**（含验证 + dogfood）。

可拆为 2 个 sprint：
- Sprint A（2h）：Phase 0-1 + Phase 6（基础 + 词典 + ADR gate）
- Sprint B（3h45min）：Phase 2-5（自动化 + enforcement）

---

## 16. 最终决策点

向用户提出（**不实施**）：

1. **是否启动 Sprint A**（基础部分 2h）？
2. **如启动，时间窗口**？
3. **§14 的 5 个关键决策**是否同意推荐选项？

---

## 变更日志

- 2026-05-15 完成。**未实施**，等待用户在 §16 决策。
