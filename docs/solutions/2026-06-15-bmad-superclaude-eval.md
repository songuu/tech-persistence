---
type: solution
slug: bmad-superclaude-eval
created: "2026-06-15"
status: reviewed
tags: [sibling-eval, external-reference, bmad, superclaude, identity-question-first, convergent-evolution, refute-by-default]
verdict_tally: { borrow: 0, adapt: 0, backlog: 2, reject: 17 }
sources:
  - https://github.com/bmad-code-org/bmad-method
  - https://github.com/SuperClaude-Org/SuperClaude_Framework
related:
  - "[[2026-06-09-pm-skills-eval]]"
  - "[[2026-06-05-ecc-eval]]"
  - "[[ADR-011]]"
  - "[[ADR-021]]"
  - "[[ADR-022]]"
  - "[[ADR-024]]"
  - "[[ADR-025]]"
---

# Sibling-eval：BMAD-METHOD + SuperClaude_Framework vs tech-persistence

> 用户请求："研究和分析下 https://github.com/bmad-code-org/bmad-method 和 https://github.com/SuperClaude-Org/SuperClaude_Framework"
> 默认语义 = compare + pros/cons + borrow 候选（refute-by-default），**不是实施承诺**（[[feedback_sibling_eval_default_compare_not_borrow]] / [[feedback_no_auto_default]]）。

## TL;DR

两个被评项规模都远大于 solo 自用的 TP（BMAD 团队敏捷 AI 方法论 / SuperClaude Claude-Code-only 配置框架），但**「高 stars ≠ 借鉴理由」**。19 个候选经多 agent 对抗核验（refute-by-default，每条 verdict 带 file:line 代码锚定）后：**0 borrow / 0 adapt / 2 backlog（YAGNI-gated）/ 17 reject。**

reject 主因**不是违反 4 不可妥协**——绝大多数候选的 NN gate 实际 pass（pure markdown 协议加法）。杀掉它们的是 **tp_already_has（TP 已有同构或更强机制）+ target-user 错配**（BMAD 的 PRD→epics→stories 团队交付 ceremony、SuperClaude 的 static-prompt-bloat 哲学）。多处 TP 版本严格更强且有代码锚定（确定性 eval guard、char-budgeted injection、hook-driven auto-instinct）。

**最高价值产出 = §6 三方收敛进化表**（11 机制：6 par / 5 tp_better）——BMAD/SuperClaude/TP 独立收敛到同构设计，是 TP 方向被两个数量级更大的项目双重验证的强信号（[[feedback_sibling_eval_convergent_evolution_high_value]]）。结论与 pm-skills/gbrain/ECC 三次 sibling-eval 的 ~0 借鉴同构，反映 TP 作为 self-evolution meta-toolchain 在方法论层已近饱和（[[ADR-025]] doc-saturated 现象再印证）。

> **修订说明**：本 doc 初稿（主循环手写）曾给出 0/2/3/8 含 2 adapt（plan 档位命名锐化 / mode 激活打印）。多 agent 对抗核验把这两项判为 **reject（already-had + 无真实 P0）**——确定性化的对抗审比单视角手写更严。已以 workflow 权威数据重写。

---

## 1. 身份对比（identity-question-first，[[ADR-011]]）

先回答身份问题再排候选，否则会"导入表面 / 拒绝脊椎"（[[ADR-011]]）。

| 维度 | BMAD-METHOD | SuperClaude | tech-persistence |
|------|-------------|-------------|------------------|
| 物种 | Agile-AI 方法论框架（模拟全套命名 persona 敏捷团队） | Claude-Code-only meta-config / 行为增强框架（无 runtime engine） | Solo-maintainer 自进化工具链 sibling |
| 目标用户 | "一人编排 AI 敏捷团队"（solo + 小团队）；Enterprise track 面向更大组织 | 通用 Claude Code 重度用户 / OSS power-user | **单人**双运行时开发者（自己） |
| 核心脊椎 | PRD→architecture→epics→stories→dev 生命周期 + scale-adaptive 规划档（0-4/三 track） | 30 `/sc:` 命令 + 7 behavioral modes + 16 agent + 8 MCP，纯 @-import markdown | think→plan→work→review→compound + 知识层 |
| 运行时 | 多 IDE bundle（IDE-agnostic） | **仅 Claude Code** | **Claude Code + Codex（parity 不可妥协）** |
| 安装/依赖 | `npx bmad-method install` + marketplace + web-bundle | `pipx`/`pip`/`npm` self-install + 8 MCP server | install.sh/.ps1 纯文件复制，零 marketplace/GUI |
| 知识/记忆 | 文档产物（PRD/architecture/story）；**无 instinct/auto-memory 层** | Serena MCP write/read_memory + /sc:save·load；**无自动 instinct 层** | instinct(0.3-0.9)→evolve→graduate + Memory v5（hook 自动驱动） |
| 确定性 | 协议层（persona prompt + workflow 模板），无 enforcement | 协议层 + MCP，无 telemetry 分层 | 协议层 + pre-commit enforcement + 供给/需求侧 telemetry（measure-before-enforce） |

**身份结论**：两者均为 **same-category（solo dev-tooling）**，target-user-mismatch 过滤器**不整体触发**——但**逐候选**仍有两类 scoped mismatch 频繁触发：
- BMAD：(1) Enterprise track（security architecture / DevOps / multi-tenant / compliance）是 team/enterprise-shaped；(2) 它是**交付 PRODUCT 软件**的方法论，TP 是**meta self-evolution** 工具链。
- SuperClaude：(1) **Claude-Code-only**（任何机制需过不可妥协 #1）；(2) **static-prompt-bloat 哲学**（@-import 全文进每个 system prompt）= TP char-budgeted hook injection 的哲学对立面。

---

## 2. 评估方法

- identity-question-first（§1）→ 4 不可妥协做 borrow gate。
- refute-by-default：每候选默认否决，需正面证明"not-already-had + 命中真实 P0 + net-new value + 过 4 NN"才升级。
- 收敛进化检测优先（§6）：TP 已独立造出同构机制的，归"验证"不归"borrow"。
- 推荐按 P0 痛点覆盖排序（[[feedback_research_recommendation_sort_by_user_pain]]）。
- **数据来源**：多 agent dynamic workflow（`wf_4ec02ceb-e1b`，29 agents：7 recon + 2 analyze + 19 adversarial verify + synthesize+critic）。每条 verdict 经独立 verifier 用真实 TP 文件 grep + file:line 锚定。配额首跑挂掉后 resume，缓存 recon 复用。

TP 的 P0 痛点（裁决锚点）：
- **P0a** doc-vs-code drift（#1 回归源）
- **P0b** 注入知识改变行为不可测（语义遵守，[[ADR-022]] A2 层明示不可测）
- **P0c** 跨运行时 parity 维护负担
- **P0d** instinct domain 多样性低（根因=分类器 detectPatterns 只产 workflow/debugging/code-style 三 domain）
- **P0e** enforcement dead-on-arrival

---

## 3. 逐机制分析（recon 摘要）

### 3.1 BMAD-METHOD
模型驱动 markdown/skill 敏捷方法论，模拟全套命名 persona 团队（Analyst/PM/Architect/SM/Dev/QA/UX）驱动人工 gated 的 PRD→架构→epics→stories→dev 生命周期；scale-adaptive 规划档（Levels 0-4 / 三 track：Quick Flow≈2h → BMad Method → Enterprise）；artifact-as-context（前文档成下阶段 context）；fresh-chat-per-story 自包含 story 文件；Party Mode 单会话多 persona 协作；JSON evals/（expectation + trigger-discrimination）；npx 装到 ~50 AI-tool 目录 + marketplace + web-bundle。**无持久 instinct/auto-memory 层。**

### 3.2 SuperClaude
无 runtime-engine 的 Claude-Code-only 配置框架，纯 @-import markdown context 把 vanilla Claude Code 变成重型平台：30 `/sc:` 命令 + 7 behavioral modes（Token-Efficiency / Orchestration / Introspection / Brainstorming…，可堆叠，activation hierarchy safety>intent>context>resource）+ 16 agent persona + 8 pre-wired MCP（Context7/Sequential/Magic/Playwright/Serena…）；Deep Research（≥2 源/claim + 0-1 置信 + inline citation）；Serena MCP + /sc:save·load 会话持久化。**重依赖 + single-runtime + static prompt bloat。**

---

## 4. 候选裁决表（refute-by-default，code-anchored）

19 候选；裁决列直接取 workflow 对抗核验 per-candidate verdict。`已有?`=tp_already_has，`用户`=target_user_fit。

| # | 候选 | 命中 P0 | 已有? | 用户 | 裁决 | 杀招（代码锚定） |
|---|------|---------|------|------|------|------------------|
| bmad-c1 | 工作流后自动 next-action 指引 | none | ✓ | fit | reject | `/sprint` 已 auto-chain 全阶段 + work.md:263「建议执行 /review」+ frontmatter 持久化已覆盖 /compact 后断序 |
| bmad-c2 | correct-course 中途防漂移 workflow | P0a | ✓ | fit | reject | sprint.md 跨 Sprint 防漂移协议(420-519) + Goal Loop 范围约束 + work.md 偏差处理 + /review 第 6 视角；新增=冗余 alias 抬 P0c parity |
| bmad-c3 | per-epic retrospective 学习捕获 | P0d→none | ✓ | mismatch | reject | TP 已有 /compound+/learn+/retrospective+自动 instinct；P0d 是 illusory（改 reflection 时机不改分类器只产 3 domain；[[ADR-025]] 0/17 净增已证） |
| bmad-c4 | pre-impl readiness gate workflow | P0a→none | ✓ | partial | reject | plan→work 边界已由 ADR-012 + **确定性** checkPlanScope(pre-commit-check.js:262-297) + checkPlanCompletion 守护；model checklist 反而**弱化 determinism**(NN fail) |
| bmad-c5 | 自包含 hyper-detail story 交接文件 | P0b→none | ✓ | partial | reject | /checkpoint + context-handoff skill 已实现，含 `Need full doc if:` 自足 gate(checkpoint.md:54,62)；P0b 误标（交接是抗 context-reset，非测语义遵守） |
| bmad-c6 | domain-adaptive（非仅 scale）规划路由 | P0d→none | ✓ | partial | reject | L4 已强制 auth/payment/data 全程 + security lens 恒 P1(review.md:238)；domain-tag 喂 P0d 正是 [[ADR-025]] 判 metric-gaming 的反模式；domain=模型语义，违 determinism |
| bmad-c7 | customize.toml 分层身份注入(base→team→user) | P0b 弱 | ✓ | partial | reject | persona.md 5 字段(inject-context.js:54-74,[[ADR-015]])已注入同物；TOML+resolver 违 obsidian+lightweight；去掉 team 层只剩 base<user 化妆性重构 |
| **bmad-c8** | **trigger-discrimination eval（触发判别测试）** | **P0e 弱** | **✗近** | **fit** | **backlog** | 4 NN 全 pass，是 skill-evals/cases.jsonl 的 field-extension；skill-diagnose 仅有定性误触发检查、无结构化 negative case；YAGNI-gated（先量化误触发频率再建） |
| bmad-c9 | 34+ 细粒度命名 workflow 单元 | none | ✓ | mismatch | reject | 绝大多数是团队 PRD/epics/story 形态（TP 故意无 PRD 命令）；workflow sprawl 违 lightweight；think→plan→…+deep-research 已覆盖 meta 部分 |
| bmad-c10 | Quick Flow 单遍 fast-lane（L0-L1） | none | ✓ | fit | reject | CLAUDE.md:52「小任务直接开发→/learn」+ think.md:119 显式 stage-collapse + [[ADR-024]] 已按可逆性×规模路由（比 BMAD 仅按 size 更细）；第二路由面会 drift |
| sc-1 | Deep Research 证据纪律(≥2 源+置信+引用) | P0a | ✓ | partial | reject | 每条 ADR 已有 `来源:` + [[wikilink]] + file:NN 锚；knowledge-drift.js([[ADR-023]])已是**确定性** drift gate；残余「模型自报 0-1 置信」是 [[ADR-022]] 拦的不可测自评，反而**更弱** |
| sc-2 | Introspection mode（结构标记暴露推理） | P0b | ✓ | partial | reject | 模型自愿发"我在用 instinct X"标记=语义自评无 exit code，正是 [[ADR-022]] §备选(b) + [[ADR-021]] 第三轴拦的伪强制；TP 已发需求侧 recall telemetry（A1 可测半），A2 层已**主动接受不可测** |
| sc-3 | Token-Efficiency symbol legend（符号表+解码） | none | ✓ | fit | reject | 无 P0；caveman 已 ~75% 削减且非正式用箭头/缩写；卖点 caveman-validate 往返校验是**幻影**（grep 确认 repo 无 caveman-validate）；NL 往返=语义判断违 determinism |
| **sc-4** | **组件分层 taxonomy(命令=WHAT/mode=STYLE/agent=DOMAIN/MCP=CAPABILITY)** | **none** | **✓功能** | **partial** | **backlog** | 4 NN pass(纯 doc)；功能已有(README 目录结构 + 知识/机制层分 + [[ADR-014]] hook-registry)；**直接抄 SC taxonomy 是 import-surface-reject-spine**(MCP=CAPABILITY 无 TP 对应)；TP-native 分层 note 仅在 sprawl 成真痛时有边际价值 |
| sc-5 | Brainstorming/Socratic 非预设需求 mode | none | ✓ | fit | reject | /think --clarify + /prototype 已做非预设需求收敛；唯一新切片 hedge-word 自动触发=模型语义判断、无证据 /think 入口是痛点，违 measure-before-enforce |
| sc-6 | /sc:pm 常驻 PM agent + 自改进 provenance | P0a→none | ✓ | mismatch | reject | compound→ADR 管线(22 ADR 带状态/上下文/决策/来源/[[wikilink]])更严；常驻 agent 三违 NN(parity+determinism+lightweight=daemon)；team PM 构造错配 solo |
| sc-7 | /sc:reflect+select-tool+recommend 自 meta 工具 | P0d→none | ✓ | partial | reject | reflect≈session-summary/retrospective+recall telemetry；select-tool≈/skill list+需求输入路由块；P0d 误标(router 不产新 instinct domain)；"确定性 which-skill router"是 [[ADR-022]] 语义墙 |
| sc-8 | 可堆叠 mode + 显式激活优先级 | none | ✓ | partial | reject | auto-mode.md(80-90)已写三模式正交可同启 + 三档矩阵(强制人工>自动>灰区)=SC 的 safety>intent>context；三模式作用于 disjoint 轴本不冲突，无真痛 |
| sc-9 | 资源阈值触发(context>75%→压缩/编排) | none | ✓ | mismatch | reject | TP hook 面(SessionStart/Pre/Post/Stop)**拿不到实时 context-%**，>75% 只能模型自估=伪确定性(违 determinism)；Codex 无等价 % 暴露(违 parity)；CLAUDE.md 已有 4 个阈值启发提示 /compact |

**tally：0 borrow / 0 adapt / 2 backlog / 17 reject。**

> 2 backlog 均 **YAGNI-gated**（过 4 NN + fit/partial 用户，但无急迫真痛，证价值前不建）：
> - **bmad-c8** trigger-discrimination eval：唯一 `tp_already_has=false` 项（diagnose 仅定性误触发检查，无结构化 negative trigger case）。若 ~30 skill 误触发成实测痛点，可作 cases.jsonl field-extension（parity-clean）。
> - **sc-4** 组件分层 taxonomy：功能已有，但 **TP-native** 分层 note（非 SC taxonomy）在 capability-placement 困惑成观察到的反复成本时有边际 onboarding 价值。

---

## 5. 推荐（按 P0 痛点覆盖排序）

1. **【最高价值，非借入】确认收敛进化（§6）** — 覆盖"方向验证"诉求。两个数量级更大的项目独立造出与 TP 同构的 11 项机制（6 par / 5 tp_better）。无需动代码。
2. **【显式不做 17 reject】** — 主因 tp_already_has + target-user 错配，**非违反不可妥协**。正确排除"高 stars 项目有的 = 我该抄"的诱惑。
3. **【2 backlog 均不立即做】** — bmad-c8 / sc-4 过 NN 但无急迫真痛；**measure-before-enforce**：先观测到实测痛点（误触发频率 / placement 困惑）再议。**默认什么都不做是正确 posture**（同 [[2026-06-09-pm-skills-eval]] 的 ~0 借鉴）。

> 强制人工 gate：即便将来动 backlog，任何落地需用户显式 go（[[feedback_no_auto_default]]）；本 eval 默认只产对比，未自动改任何文件。

---

## 6. 三方收敛进化表（最高价值产出）

11 机制独立收敛（6 par / 5 tp_better）。收敛项**不进 borrow 裁决**（已有），写进结论作方向验证（[[feedback_sibling_eval_convergent_evolution_high_value]]）。

| 机制 | BMAD | SuperClaude | tech-persistence | TP 位置 |
|------|------|-------------|------------------|---------|
| model-driven markdown 协议（无宿主进程） | self-contained Skill 目录按名调用 | 30 `/sc:` + 7 modes 纯 @-import | think→plan→work→review→compound（[[ADR-021]] 确定性上限=协议+持久化+可见打印） | par |
| persona/角色按阶段切换 | 6+ 命名 persona agent（独立 subagent）+ customize.toml | 16 agent + Business/Spec Panel | gstack 角色切换（同一 agent 切视角，非独立 subagent） | par |
| 规模自适应规划深度 | Levels 0-4 / 3 track + 声称 domain-metamorphic | （无显式档，靠 mode 堆叠近似） | [[ADR-024]] + L0-L4 + **可逆性>规模**路由 + plan-lint 确定性强制 | par |
| 规划/实现分离 + 渐进上下文 + 交接 | 4 phase + fresh-chat-per-story 自包含文件 | Serena MCP + /sc:save·load | think→plan→work + /checkpoint + context-handoff（含 `Need full doc if:` 自足 gate） | par |
| 单会话多视角 review panel | Party Mode（2-3 persona） | Business Panel / Spec Panel | /review 多 lens（security/perf/arch/quality/test + 条件 design） | par |
| token 压缩 / progressive disclosure | sharded micro-file（声称 74-90%） | Token-Efficiency mode（symbol legend，声称 30-50%/≥95% 保留） | caveman 家族（lite/full/ultra/wenyan，~75%，**确定性 Python compress/validate/benchmark**）+ Memory v5 12KB 预算 | **tp_better** |
| per-skill eval 框架 | JSON evals/（expectation + trigger-discrimination） | （无显式 per-skill eval） | skill-eval(A/B) + **skill-publish baseline guard**（确定性回归 gate，[[ADR-016]]）+ results.jsonl | **tp_better** |
| 行为规则注入模型方式 | （隐式经 skill） | @-import **全文进每个 system prompt**（static bloat 无预算） | hook SessionStart inject-context.js **char budget 12KB** + curated Memory v5 + 需求侧 recall telemetry | **tp_better** |
| 会话 save/restore + memory 持久化 | fresh-chat-per-story（人工 curated，无 instinct 层） | Serena MCP + /sc:save·load | Memory v5 hook 自动驱动 + compatReadDirs 双运行时 + **instinct(0.3-0.9)→evolve→graduate 自动层（两者均无）** | **tp_better** |
| 分发 + plugin 打包 | npx 装 ~50 目录 + marketplace + web-bundle | pipx/pip/npm self-install | install.sh/ps1 + propagate + **双运行时 parity**；NO marketplace/GUI | par |
| flag 驱动行为模式切换 | （track 选择近似） | 7 modes 自动/手动 flag 可堆叠 + activation hierarchy | caveman + auto(--auto 永不默认) + goal loop | par |

**关键洞察**：TP 在**确定性 + 轻量 + 注入预算 + 自动 instinct** 四维是 tp_better 集中区。SuperClaude static-prompt-bloat 与 TP char-budgeted injection 是哲学对立面；两项目都缺 TP 的自动 instinct 层。这印证 4 不可妥协是**差异化护城河**而非负担。

---

## 7. 下游落地状态

- **代码改动**：无（compare-only，未改任何源文件）。
- **backlog（bmad-c8 / sc-4）**：未实施，证价值前不建。
- **本 doc**：`docs/solutions/2026-06-15-bmad-superclaude-eval.md`，status=`reviewed`。
- **解决方案索引**：已 `node scripts/sync-solution-index.js --all` 重生成（45 docs），CLAUDE.md/AGENTS.md/index.jsonl 已同步。

---

## 8. §二次评审（review pass）

### 8.1 数据-结论一致性
- frontmatter tally(0/0/2/17) 与 §4 表逐行可加总：reject 17 + backlog 2(bmad-c8/sc-4) = 19，一致。✅
- **抓到 workflow 自身一处不一致**：synthesis prose 写"0 borrow / 0 adapt / 0 backlog"，但 per-candidate verdicts + tally 字段是 backlog:2。按 [[feedback_evaluation_data_conclusion_consistency]] 以更细粒度的 per-candidate verdict 为准（=2 backlog），不取 synthesizer 过度概括的 prose。已在本 doc 修正。⚠️→✅
- §6 收敛进化定位与 §5 推荐第 1 项（最高价值非借入）一致，无撕裂。✅
- **修正初稿过宽**：主循环 draft 的 2 adapt（plan 档位/mode 打印）经对抗核验降为 reject（already-had + 无 P0），符合 refute-by-default。已重写。✅

### 8.2 规模自适应（size-aware）
- analysis/compare sprint，非大型实现。按 [[feedback_sprint_evaluation_must_be_size_aware]] 不套大任务标准。docs/solutions 文档无需配测试/CI。✅

### 8.3 grep-self（自家代码先于外部断言）
- 全部 17 reject + 2 backlog 的杀招均带 TP 真实 file:line 锚定（pre-commit-check.js:262-297 / inject-context.js:54-74 / review.md:238 / checkpoint.md:54 / evaluate-session.js 分类器 …），非旧记忆臆测。✅
- knowledge-drift.js / checkPlanScope / persona.md 等引用经 verifier grep 确认存在。✅

### 8.4 残留风险
- **R1（外部规模数字未独立验证）**：BMAD 声称 74-90% token 削减 / SuperClaude 30-50%·≥95% 保留是 marketing claim，未跑对比；TP caveman ~75% 同为声称值。三方压缩率**不可直接横比**。但**不影响裁决**（裁决锚身份/已有/P0，非压缩率）。
- **R2（MCP 层未逐个审）**：SuperClaude 8 MCP（含 Serena memory）未逐审。理论上若某 MCP 提供确定性检索 + 可双运行时 parity，或能命中 P0b——但 lightweight-first + Claude-only 双门槛使其大概率仍 reject。**真实盲区，记录在案**。
- **R3（BMAD Enterprise track 一笔带过）**：security architecture/compliance gate 整体按 team-shaped 归类，未逐机制审。若未来 TP 想吸某 enterprise 确定性 check（如 compliance gate 确定性化），需单独 re-eval。
- **R4（unknown-unknown）**：prompt-level 分析可能看不到工程实现技巧（如 BMAD sharded step-file 的 progressive load 调度算法），code-level 深读才能完全排除。borrow≈0 结论稳健（每 reject 有 tp_already_has/illusory-P0 锚定 + 三次历史 sibling-eval 同构），唯余此沉默风险。

### 8.5 review 裁决
- 结论稳健、数据自洽（含修正 workflow 内部 prose/verdict 不一致）、规模匹配、code-anchored。
- 外部 marketing 数字(R1) 已显式标注未验证、不影响裁决。R2/R3 盲区已披露。
- status 升 **`reviewed`**（已过 §二次评审 + 对抗核验 code-anchored + R1 外部数字已限定为不影响裁决的 marketing claim）。未升 `completed`：R2/R3 是已披露的未审子域，留待将来按需 re-eval。

---

## 9. 变更日志
- 2026-06-15 初稿：主循环手写，tally 0/2/3/8（含 2 adapt）。
- 2026-06-15 重写：多 agent dynamic workflow（`wf_4ec02ceb-e1b`，29 agents）对抗核验完成，tally 修正为 0/0/2/17（code-anchored）。修正 2 adapt→reject。修正 workflow 内部 synthesis prose（0 backlog）vs verdict（2 backlog）不一致，以 per-candidate 为准。status→reviewed。

## Related
- [[2026-06-09-pm-skills-eval]] — 上一个 sibling-eval（~0 借鉴，同 compare-not-borrow + 收敛进化模式）
- [[2026-06-05-ecc-eval]] — 格式模板来源
- [[ADR-011]] — identity-question-first + 4 不可妥协
- [[ADR-021]] — model-driven 协议确定性上限（c4/sc-2 杀招依据）
- [[ADR-022]] — 供给/需求侧 telemetry + A2 语义遵守不可测（sc-1/sc-2/sc-7 杀招依据）
- [[ADR-024]] — 规划深度自适应（c6/c10 已有依据）
- [[ADR-025]] — doc-saturated repo 挖掘零 yield（c3/c6 P0d illusory 依据）
