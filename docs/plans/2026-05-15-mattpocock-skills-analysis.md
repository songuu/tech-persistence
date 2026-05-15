---
title: "mattpocock/skills 对照分析"
type: analysis
status: completed
created: "2026-05-15"
updated: "2026-05-15"
tags: [analysis, sibling-eval, external-reference]
aliases: ["mattpocock-skills-eval"]
sources:
  - https://github.com/mattpocock/skills (commit pushed 2026-05-13, 82.7k★, MIT, 100% Shell)
---

# mattpocock/skills 对照分析

> 评估请求是「分析下」，**不是「选哪几个借鉴」**。本文默认形态是 compare + pros/cons，不是落地决策表。
> 用户选择只产出 Phase 3 文档（跳过 Plan/Review/Compound 形式化阶段）。

## 0. 关键假设验证

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| mattpocock/skills 不能按同类 sibling 直接合并 | Read 本文 §1 项目身份对照 + §2 Skill 名义 vs 实质重叠表 | 文档先界定 TP 是自进化方法论系统，再比较 shared language、ADR gate、skill 重叠和拒绝项 |
| 本次输出是 compare，不是 commit-ready 实施计划 | Read 本文开头说明 + §7 不借鉴清单 | 文档只给候选方向和拒绝清单，没有把外部 skill 直接并入 TP runtime |

## TL;DR

1. **不是 sibling，是 cousin**——两者哲学根上对立：mattpocock 流派**反流程绑架**（明示拒绝 GSD/BMAD/Spec-Kit），TP 是**强流程**（5-phase sprint + 多层 enforcement）。
2. 18 个 skill 中，**3 个名字重叠（caveman/prototype/handoff）实质上 TP 都已实现且功能更全**；剩下 15 个里**1 个值得深入研究（grill-with-docs 的 CONTEXT.md glossary 模式）**、**1 个有轻量借鉴价值（ADR 三条件 gate）**，其余受 TP 的「方法论系统」身份约束**不适合借鉴**。
3. mattpocock 流派会反对 TP 的：sprint phase gate、Memory v5、本能毕业、多运行时 parity、pre-commit enforcement——这些不是缺陷而是**身份差异**，不应在他们的视角下修。

---

## 1. 项目身份对照（ADR-011 前置）

| 维度 | mattpocock/skills | tech-persistence |
|------|---|---|
| 定位 | 个人 `.claude` 目录公开版 | 自进化方法论系统 |
| 体量 | 18 个 skill，100% Shell，MIT | 40 个 skill + 12 命令 + 4 hook + 多运行时 parity |
| 哲学 | **反流程绑架**——"approaches like GSD, BMAD, Spec-Kit take away your control" | **强流程 + 复利**——Plan→Work→Review→Compound + 本能 |
| 用户假设 | 任何写产品 app 的工程师 | solo-maintainer 想搞个人复利系统 |
| 状态承载 | `CONTEXT.md`（glossary）+ `docs/adr/` | 同上 + Memory v5 + 本能（JSON）+ skill-signals |
| Enforcement | 无 | Hook + pre-commit + multi-copy sha + plan-lint |
| 单 skill 耦合 | **全可单装**，"work with any model" | 大量耦合：compound 依赖 learn，sprint 依赖 think/plan/work/review/compound |
| 目标失败模式 | 4 类：不对齐 / 啰嗦 / 不工作 / 大泥球 | 同上 + "上下文压力 / 记忆遗忘 / 知识漂移 / 多副本失同步" |

**关键结论**：mattpocock 的「反流程」立场与 TP 的「强流程」立场不矛盾——他们解决的是不同人群的不同问题。mattpocock 的用户在写产品应用（domain-specific），TP 的用户在维护方法论系统本身（meta-tooling）。

**ADR-011 4 条不可妥协原则下的过滤**：
- 多运行时 parity：mattpocock 只 Claude Code，未 Codex parity（虽然 README 说 "any model"，但 install 入口是 `skills.sh`，Codex 端无对应封装）
- 确定性优先：mattpocock 没有 enforcement 层，全靠 skill prompt 描述
- 轻量优先：✅ mattpocock 比 TP 轻得多
- Obsidian 兼容：✅ 全是 markdown

---

## 2. Skill 名义 vs 实质重叠表

| Mattpocock skill | 名义对照 TP | 实质对比 | 评级 |
|---|---|---|---|
| `caveman` | TP `caveman` | TP 有 lite/full/ultra/wenyan 6 档 + caveman-commit/review/compress/help 全家桶；mattpocock 单档 | **TP 已超** |
| `prototype` | TP `prototype` + `prototype-workflow` | **语义不同**：mattpocock 是 throwaway runnable prototype（UI 变体探索），TP 是 UI 原型截图 → 假设驱动需求收敛 | **正交，非重叠** |
| `handoff` | TP `checkpoint` + `context-handoff` + sprint handoff-N | mattpocock 是 10 行 SKILL 写到 `mktemp`；TP 是 sprint-aware 5-task auto checkpoint + compact handoff + resume 协议 | **TP 已超 10x+** |
| `tdd` | TP `test` + `test-strategy` | **方法不同**：mattpocock 是 RGR 流程指导，TP 是 L0-L4 风险分级自动决定测试深度 | **正交** |
| `diagnose` | TP `debug-journal`（隐式，通过 hook 触发） | mattpocock 是 6 步主动调用 SKILL，TP 是 PostToolUse hook 被动观察 + 解决方案归档 | **正交：主动 vs 被动** |
| `grill-me` | TP `think` | mattpocock 是关闭式深度访谈（一问一答到决策树穷尽），TP 是 CEO 视角范围定义 | **正交** |
| `write-a-skill` | TP `skill` + `skill-publish` + `skill-eval` 等 5 子动作 | mattpocock 是 scaffold helper，TP 是「skill 全生命周期 diagnose→eval→improve→publish」 | **TP 已超** |
| `to-prd` | 无直接对应 | mattpocock 把对话 → PRD → 投递到 issue tracker | **TP 没有，但也不需要**——TP 是方法论项目不是产品项目 |
| `to-issues` | 无 | 把 PRD 拆 vertical slice → GitHub issues | **同上** |
| `triage` | 无 | issue 状态机：bug/enhancement × 5 个 state | **同上** |
| `grill-with-docs` | TP `think` + 部分 ADR 协议 | **mattpocock 独有**：访谈中 inline 更新 `CONTEXT.md` glossary + ADR | **见 §4 深入分析** |
| `improve-codebase-architecture` | 无（TP `/review` 不重叠） | 自有架构词汇表（Module/Interface/Depth/Seam/Adapter）+ deletion test | **见 §4 深入分析** |
| `zoom-out` | 无 | "解释代码时给出整个系统的 context" | **TP 没有，但可被 /think 覆盖**——边际效益低 |
| `setup-matt-pocock-skills` | TP `install.sh/ps1` | 一次性 per-repo scaffolding 提示 | **方向相同，机制不同** |
| `git-guardrails-claude-code` | 无 | Hook 拦截 dangerous git cmd | **见 §4** |
| `migrate-to-shoehorn` | 无 | TypeScript 工具迁移 | **不适用** |
| `scaffold-exercises` | 无 | 教学用 exercise scaffolding | **不适用** |
| `setup-pre-commit` | TP `scripts/pre-commit-check.js` | Husky + lint-staged + Prettier + type check | **TP 自有 enforcement 框架，语义不同** |

---

## 3. Mattpocock 流派的核心思想（5 条）

### 3.1 「Shared Language」是核心红利

**主张**：`CONTEXT.md` 不是 spec、不是 scratch pad，是**纯 glossary**（domain terms + relationships + flagged ambiguities）。每次 grill 会话中 inline 更新。

**支撑论据**（README 原文）：
- 命名一致性 → 代码可被 agent 导航
- token 节省 → "materialization cascade" vs "There's a problem when a lesson inside a section of a course is made 'real'"
- agent 思考成本下降

**TP 状态**：
- `/think` 输出 scope/non-scope/success，**不维护 domain glossary**
- ADR 系统较成熟但只记决策，不记词汇

**是否值得借鉴**：见 §4.1

### 3.2 ADR 三条件 sparingness gate

**主张**（grill-with-docs SKILL.md 原文）：
> Only offer to create an ADR when all three are true:
> 1. Hard to reverse
> 2. Surprising without context
> 3. The result of a real trade-off

**TP 状态**：TP 的 ADR-008/011/012/013 实际上都满足这三条，但**规则没有显式写在 `~/.claude/rules/architecture.md` 顶部**。

**是否值得借鉴**：✅ 轻量、零风险、与 4 原则不冲突。**建议**：在 `~/.claude/rules/architecture.md` 顶部加 4 行 ADR gate 准则。

### 3.3 「Deletion test」与模块深度词汇表

**主张**（improve-codebase-architecture）：定义 Module / Interface / Implementation / Depth / Seam / Adapter / Leverage / Locality 8 个核心词汇。Deletion test：删掉这个模块复杂度去哪了？

**TP 状态**：`/review` 有架构维度但用的是通用词汇，没有这套精确语言。

**是否值得借鉴**：⚠️ **身份不匹配**。这套词汇是为「产品 app 多模块 codebase」设计的，TP 自身是 meta-tooling 项目，scripts/ 下的 ~30 个 JS 文件不构成需要 deepening 的产品架构。**对外部用户的 `/review` 倒是有价值**，但实施成本（需要更新 `/review` 的 prompt + 写 LANGUAGE.md 配套）与对 TP 用户场景（自维护方法论）的收益不匹配。

### 3.4 反流程的合理性

**主张**："Approaches that own the process take away your control and make bugs in the process hard to resolve."

**TP 视角**：这条批评对 TP 部分成立——`/sprint` 流程出 bug 时确实**难以单点修复**（要么改 sprint.md 协议、要么改 phase 间钩子、要么调 hook、要么调 propagate 脚本）。

**反驳**：
- TP 的 enforcement 多层都是**fail-open**（[[ADR-013]] 三层防御），用户永远有逃生通道
- TP 不是给「任何 Claude 用户」的 skill 集合，是给「想搭复利系统」的个人——这个用户群明确接受「流程绑架」的代价换长期复利

**是否值得借鉴**：❌ 这条不是「思想」，是「立场」。TP 不应翻立场。

### 3.5 Issue tracker 三档抽象

**主张**（CONTEXT.md）：把 GitHub Issues / Linear / `.scratch/` markdown 三种 issue tracker 抽象为统一接口，skill（`to-issues` / `to-prd` / `triage` / `qa`）只对接抽象层。

**TP 状态**：TP 没有 issue tracker 接入。

**是否值得借鉴**：❌ **明显超出 TP 身份**。TP 不是产品工程工具链，是自进化方法论。引入 issue tracker = 把整个 PR/issue workflow 接进 TP，scope creep 巨大。

---

## 4. 可能值得借鉴的两条（compare not commit）

### 4.1 `CONTEXT.md` glossary 模式（中等价值）

**适配方向**：作为 `/think` 的可选输出，或作为新轻量 skill `/glossary`。

**潜在收益**：
- TP 自身的 domain terms（observation / instinct / 本能 / phase gate / skill signal / Memory v5 topic / homunculus / propagate / dogfood ...）越来越多，新会话冷启动时 LLM 需要重新理解。glossary 可减少术语理解成本。
- 与 Obsidian 兼容（纯 markdown）
- 与 4 原则不冲突

**代价**：
- 增加一个文件（`docs/glossary.md` 或 `CONTEXT.md` 根目录）
- `/think` 需要新增 "inline 更新 glossary" 协议——会增加 /think 长度
- 与现有 `~/.claude/rules/architecture.md` ADR 列表存在概念重叠风险

**潜在冲突**：
- TP 已有 wikilinks 风格（`[[instinct-name]]`），glossary 又是另一种术语载体，可能形成第二个 source of truth
- TP 的 4-hook 自动观察已经隐式建立 domain（observations 文件夹），再加 glossary 是 manual 第二层

**评级**：值得**单独写一个 mini-sprint** 评估（Phase 0/1 是否真的需要），不是本次直接借鉴。

### 4.2 ADR 三条件 gate 准则（轻量价值）

**适配方向**：在 `~/.claude/rules/architecture.md` 顶部加 4 行规则。

**潜在收益**：
- 显式写下 TP 已经隐式遵循的规则，让 `/compound` 在判断"是否升级为 ADR"时有依据
- 零结构变更
- 与 4 原则 0 冲突

**代价**：~10 分钟实施。

**评级**：✅ **可作为下一次 `/compound` 或独立 chore 落地**。**不在本次评估的实施范围**——本次是分析不是落地。

---

## 5. TP 独有、mattpocock 流派会反对的设计

| TP 设计 | Mattpocock 流派会说 | TP 的反驳 |
|---|---|---|
| `/sprint` 5-phase gate | "Process owns you, bugs in process hard to resolve" | 用户群不同：solo-maintainer 接受流程换长期复利 |
| Memory v5 + 本能 | "Just write `CONTEXT.md`, simpler" | TP 是跨会话的，CONTEXT.md 是 session-bound + author-discipline-enforced；本能有置信度评估 |
| Pre-commit enforcement（[[ADR-013]]） | "Documentation should be enough" | 已实证 documentation 协议会失效（ADR-013 论据），mechanism > discipline |
| 多运行时 parity（Claude + Codex） | "Pick one model" | TP 用户明确同时用 Codex 和 Claude Code |
| Hook 系统 | "Hooks add invisible state" | 4-hook 是 fail-open + 有 `[hook] failed:` marker 可观察 |
| 本能毕业（observation → instinct → permanent rule） | "Just write the rule" | 早期不确定的规则不应直接写死，需要 confidence ramp |

**结论**：这些差异**根植于身份**，不应在 mattpocock 视角下"修复"。

---

## 6. 反向问题：mattpocock 流派对 TP 会有哪些有效批评？

逐条考虑哪些值得吸收：

1. **「Sprint phase gate 增加了流程修复成本」** —— 部分成立。本仓库 `2026-05-12-pre-commit-defense.md` 等多个解决方案已记录"修协议"的成本。**应吸收**：未来 sprint 协议变更前先评估"出 bug 时是否有清晰的修复路径"。
2. **「Skill 互相耦合违反 composability」** —— 部分成立。TP 的 `/compound` 内嵌 `/learn` 是设计意图（复利层），但 `/sprint` 调 `/think /plan /work /review /compound` 5 个，新用户单独用其中一个会困惑。**应吸收**：每个被 sprint 调用的 skill 文档需明示"也可独立调用"。
3. **「没有 CONTEXT.md，新 LLM 会话冷启动成本高」** —— 部分成立。见 §4.1。
4. **「Caveman 不该是默认行为」** —— 不成立。TP `caveman` 本来就是 trigger 才激活，与 mattpocock 同 default。
5. **「ADR 太重了，每个决策都写一篇」** —— 不成立。TP 的 ADR-008→013 实际频率约每月 1-2 条，符合 mattpocock 的 sparingness 标准。

---

## 7. 不借鉴的明确清单（含理由）

| 拒绝项 | 理由 |
|---|---|
| `to-prd` / `to-issues` / `triage` | 引入 issue tracker = scope creep 出 TP 身份 |
| `improve-codebase-architecture` 整套词汇表 | 针对产品 app 多模块场景，TP 是 meta-tooling 不适配 |
| `setup-matt-pocock-skills` 模式（启动时 grill） | TP `install.sh` 已是确定性安装，加 grill 会破坏 deterministic-first |
| `tdd` skill | TP `test` + `test-strategy` 已用 L0-L4 风险分级覆盖，RGR 是子集 |
| `grill-me`/`grill-with-docs` 的「关闭式访谈直到穷尽」 | 与 TP 的 `/think`（CEO 视角范围定义）哲学不同——一个是穷尽决策树，一个是定义做什么不做什么 |
| `git-guardrails-claude-code` | TP 用 pre-commit-check.js 已覆盖 + 用户已用 `.claude/settings.json` permissions |
| `migrate-to-shoehorn` / `scaffold-exercises` | TP 不写 TypeScript 应用代码，不教学 |
| 反流程立场本身 | 立场而非思想，TP 不翻立场 |

---

## 8. 元观察（对 TP 自身有用的发现）

1. **mattpocock 单文件 SKILL.md 极简，10 行起步**——TP 的 SKILL.md 普遍 50+ 行。**值得反思**：TP 的 skill 是否过度文档化？是否能精简？这是 `/skill-diagnose` 的潜在新维度。
2. **mattpocock 的 "Reference docs" 模式**（如 triage SKILL 指向 `AGENT-BRIEF.md` / `OUT-OF-SCOPE.md`）做了 progressive disclosure——主 SKILL 短，配套文档详。**TP 已部分采用**（caveman-compress 有 scripts/，但配套 md 较少）。**值得评估**：是否把超长 SKILL（如 sprint）拆为 SKILL.md 主入口 + 协议文档。
3. **mattpocock 公开 deprecated/in-progress/personal 三类隔离**目录——TP 没有这种公开 vs 私有的分层（虽然 .out-of-scope 类似）。**不需要借鉴**，但是个干净的 organize pattern。

---

## 9. 后续动作建议（**不在本次范围**）

如果未来想推进，按 ROI 排序：

1. **加 ADR 三条件 gate 准则到 `~/.claude/rules/architecture.md`** —— 10 分钟，零风险，§4.2
2. **`/skill-diagnose` 加 "skill 长度过长 / 缺 progressive disclosure" 维度** —— §8.1+§8.2 共同收获
3. **mini-sprint 评估 CONTEXT.md glossary 是否真值得引入** —— §4.1
4. **`/sprint`、`/work` 等被组合调用的 skill 文档显式声明"也可独立调用"** —— §6.2

每一条都需要单独的 `/sprint` 或 `/learn` 决策。**本文档到此结束。**

---

## 变更日志

- 2026-05-15 创建。Phase 1 (Think) 已完成，用户选择只产出本分析文档，跳过 Phase 2/4/5 形式化。
