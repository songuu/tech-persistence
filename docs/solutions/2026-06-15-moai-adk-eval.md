---
type: solution
slug: moai-adk-eval
created: "2026-06-15"
status: reviewed
tags: [sibling-eval, external-reference, moai-adk, identity-question-first, convergent-evolution, refute-by-default, target-user-mismatch, adversarial-verified]
verdict_tally: { borrow: 0, adapt: 0, backlog: 1, reject: 11 }
sources:
  - https://github.com/modu-ai/moai-adk
  - https://deepwiki.com/modu-ai/moai-adk/1-moai-adk-overview
related:
  - "[[2026-06-15-bmad-superclaude-eval]]"
  - "[[2026-06-09-pm-skills-eval]]"
  - "[[2026-06-05-ecc-eval]]"
  - "[[ADR-011]]"
  - "[[ADR-021]]"
  - "[[ADR-022]]"
  - "[[ADR-023]]"
  - "[[ADR-025]]"
---

# Sibling-eval：MoAI-ADK (modu-ai) vs tech-persistence

> 用户请求："--auto 继续对比 https://github.com/modu-ai/moai-adk"
> 默认语义 = compare + pros/cons + borrow 候选（refute-by-default），**不是实施承诺**（[[feedback_sibling_eval_default_compare_not_borrow]] / [[feedback_no_auto_default]]）。
> 系列：spec-kit / gsd / claude-mem / ecc / pm-skills / bmad-superclaude → 本次 moai-adk（第 6 次连续 ~0 借鉴）。

## TL;DR

MoAI-ADK = **SPEC-First 重量级生产级 agentic 编码 harness**（Go 单二进制 CLI，38,700+ 行 / 38 包，24-28 agents + 52 skills，Plan→Run→Sync→PR 全生命周期 + DB 管理 + design pipeline + GLM tmux 多 LLM）。规模与定位远超 solo 自用、纯 markdown+jsonl 的 TP。

11 候选机制经 **29-轮等价的 13-agent 对抗核验**（refute-by-default，每条 verdict 强制 grep TP 代码锚定 already-had）后：**0 borrow / 0 adapt / 1 backlog / 11 reject。**

> **对抗核验改判（vs 主循环 draft 0/0/1/10）**：
> - **C5（Ralph 确定性分类）backlog → reject**：draft 犯 category error——把 Ralph 的 LSP+AST-grep 错误分类错配到 [[ADR-021]] 只装"max-iter 迭代天花板"的 deferred slot（`docs/plans/2026-05-29-sprint-goal-mode.md:31-34`）。错误分类是独立面，target-user 错配 + LSP/AST 重量违反轻量 → reject。
> - **C1 前提被证伪（verdict 仍 reject）**：draft 写"TP plan freeform、EARS 是团队 ceremony"——**事实错**。`think.md:81-95` 早已有 `验收条件（EARS-lite）`（`WHEN <触发条件> THE SYSTEM SHALL <可观测行为>`，L3+ 强制）。TP 不是"拒绝 EARS"而是"采纳 + risk-gate"。这是 draft 自身的 [[documented-claim-vs-code-reality-drift]]（详见 §7.1）。
> - **completeness critic 挖出 1 真漏 → 新 backlog（B1）**：`plan-auditor/sync-auditor` 语义 doc↔code↔plan 审计，**正坐 TP #1 痛点（doc-drift）**。

reject 主因：**target-user 错配**（C3/C5/C9：moai 是规模化产代码 harness，TP 是 solo 自进化方法论层）+ **already-had**（C1/C2/C4/C6/C7/C8/C10/C11）+ **违反不可妥协**（轻量 #3 复发于 C3/C5/C7/C10/C11；parity #1 于 C7/C10/C11；确定性 #2 于 C4）。

**最高价值产出有二**：
1. **§4 收敛进化表（10 机制）**——moai 重型 harness 与 TP 在 phase-gated / session-resume / 对抗 QA / 迭代天花板 / 内联纪律标签 / 跨模型 / 双模 spawn / token 预算 / 模型分层 / 需求侧遥测 独立收敛。TP 方向被又一个数量级更大项目验证（[[feedback_sibling_eval_convergent_evolution_high_value]]）。
2. **B1 backlog（plan-auditor 语义审计）+ §7.2 发现的 TP 真 bug**——eval 反而暴露 TP 自身 doc-drift 防御的语义盲区 + sprint.md:517 一处虚假 enforcement 声明。比"借不借机制"更有价值。

第 6 次连续 ~0 借鉴，再印证 [[ADR-025]] doc-saturated meta-toolchain 现象。

---

## 1. 身份对比（identity-question-first，[[ADR-011]]）

| 维度 | MoAI-ADK | tech-persistence |
|------|----------|------------------|
| 本质 | 生产级 agentic 编码 harness（"人设计 SPEC/质量门，agent 写代码"） | self-evolution 方法论 + 知识沉淀层（meta-toolchain） |
| 交付物 | 测试+文档齐全的**生产代码** + PR | **方法论协议**（markdown 命令/skill）+ 知识层（instinct/rules/memory） |
| 形态 | Go 单二进制 38.7K 行，重安装（curl\|bash / Go build） | 纯 markdown + 轻 js hook + jsonl，install 脚本复制文件 |
| 运行时 | Claude Code（+ GLM via tmux），cost-tier | Claude Code **+ Codex** parity（[[ADR-011]] 不可妥协 #1） |
| 知识持久 | `progress.md` 会话级 + `.moai/project/*` 自动生成文档 | Memory v5（instinct/topic/persona）+ Obsidian 兼容 |
| 目标用户 | 想规模化产出生产代码的**通用开发者/团队** | **solo** self-evolution 工具链维护者 |

**身份结论**：不同物种。moai 解决"怎么让 AI 写出可信生产代码"；TP 解决"怎么让我的开发方法论与经验跨会话复利、双运行时可见"。脊椎形似（phase-gated 循环）神不同——前者产出 code，后者产出 method+knowledge。

## 2. 目标用户错配判定（[[feedback_target_user_mismatch_invalidates_borrow]]）

moai 几乎所有"便利"都为 **code-production-at-scale** 设计：TRUST5/85% 覆盖门守生产代码；@MX 帮 agent 导航大型业务代码库；DDD 改造 legacy；GLM cost-tier/tmux 控团队成本；27 hook + 52 skill + .moai/db|brand|design 全功能产品工厂。

→ 这些不是"TP 没想到"，是"TP 不该要"。对抗核验逐条确认：借入即引入用错场景的重量。

## 3. 4 不可妥协原则对照（[[ADR-011]]）

| 原则 | moai-adk 表现 | 对借鉴的影响 |
|------|---------------|-------------|
| 多运行时 parity（Claude+Codex） | Claude Code + **GLM**（非 Codex），cost-tier 导向 | moai 机制隐含 Claude/GLM-only，移植需补 Codex = parity 负担；C7/C10/C11 直接违反 |
| 确定性优先 / measure-before-enforce | Ralph LSP+AST-grep 分类是真确定性；GAN 0.75 是 LLM 浮点打分 | C4 借入 0.75 浮点分会**回退**确定性（TP 用二值 rubric，review.md:119-127） |
| 轻量优先 | 38.7K 行 Go + 单二进制 + 27 hook + DB/design 子系统 | 与轻量根本对立；C3/C5/C7/C10/C11 全踩 |
| Obsidian 兼容 markdown 知识层 | `.moai/*` 是 yaml config + 自动文档，非 Obsidian-first | 知识层模型不同 |

## 4. 收敛进化机制（最高价值之一，[[feedback_sibling_eval_convergent_evolution_high_value]]）

两项目独立收敛到同构 = TP 方向被验证。收敛项**不进 borrow 裁决**（已有），写进结论。每条已对抗核验 file:line 锚定。

| # | 机制 | MoAI-ADK | tech-persistence（code-anchored） | 评级 |
|---|------|----------|------------------|------|
| CV1 | phase-gated 工作流 | Plan→Run→Sync | think→plan→work→review→compound | par |
| CV2 | 会话记忆 + resume | `progress.md` + 中断自动续 | checkpoint/handoff（`checkpoint.md:18-62`）+ 每-Task resume（`sprint.md:295-314`）+ 每 5 Task 自动 checkpoint（`sprint.md:266-271`） | **tp_better**（per-Task 粒度 > moai phase 级 + Obsidian + 双运行时） |
| CV3 | 对抗 QA loop | GAN Loop（Builder↔Evaluator，min 0.75，max 5） | Rubric-gated revise loop（`review.md:108-152`，cap N=2）+ agent-loop classic（[[ADR-018]]/[[ADR-004]]）+ dynamic-workflows 对抗 review | par（动机同；TP 用二值 rubric 守确定性） |
| CV4 | 确定性迭代天花板 | Ralph max 100 iter | `--goal` max-iter（[[ADR-021]]）+ `pipeline.js:463 maxIterations=32` | par |
| CV5 | 内联纪律标签 | @MX:ANCHOR/WARN/NOTE/TODO | @FeatureGate/@sizebudget/@sprint-X-invariant/@deadcode-until（`sprint.md:513-519`，**doc-only**） | par（思路同；自动化差异见 C3） |
| CV6 | 跨模型/运行时 | Claude/GLM/hybrid（cost 动机） | Claude/Codex（parity 动机） | par（机制收敛，动机异） |
| CV7 | sub-agent vs team-spawn 双模 | Agent-Teams / `--solo` | Agent spawn（worktree 隔离）/ Codex batch fallback | par |
| CV8 | token 效率分级披露 | Progressive Disclosure 3 级 | host-runtime 原生 L1/L2/L3 skill + 渐进披露 check（`skill-diagnose.md:31-38`）+ 12KB 注入预算（`inject-context.js:31`） | par |
| CV9 | 风险/质量分级门 | TRUST 5 | risk-adaptive `/review` rubric（`review/SKILL.md:138`）+ L0-L4 + security.md + Memory v5/ADR（Trackable） | **tp_better**（risk-scaled vs 每次 5 门强制；[[ADR-022]] measure-before-enforce） |
| CV10 | 使用遥测/分析 | `task-metrics.jsonl`（token/会话分析） | demand-side recall（`recall-usage.js`，[[ADR-022]]，dormant-domain）+ skill-signals（`skill-signals.js`） | par（critic 新增；TP 已收敛同思路） |

**10 机制收敛（8 par / 2 tp_better），0 项 moai_better 到值得借入**——与 bmad 11 机制（6 par / 5 tp_better）同构信号。

## 5. 借鉴候选 verdict（refute-by-default，对抗核验后）

> NN = not-already-had？P0 = 真实未满足痛点（非 illusory）？value = net-new + 合身份？三条全过才 borrow/adapt。conf = 核验置信度。

| # | 候选机制 | NN | P0 | verdict | conf | 核验理由（code-anchored） |
|---|----------|----|----|---------|------|------|
| C1 | EARS 格式 SPEC 语法 | ✗ | ✗ | **reject** | 0.90 | **already-had**：`think.md:81-95` 已有 EARS-lite（L3+ 强制）。full-EARS 5 模板 + 英文 ceremony 的增量 P0 是团队消歧（writer≠reader），solo 同上下文 illusory + 违反轻量 |
| C2 | TRUST 5 质量框架 | ✗ | ✗ | **reject** | 0.88 | already-had：risk-adaptive `/review` rubric（`review/SKILL.md:138`）+ fail→fix→re-review（:123）+ L0-L4 + security.md。每次 5 门强制对 markdown 工作流 illusory（[[ADR-022]]）。**勘误**：TP 的 TRUST 等价是 LLM `/review` 非 pre-commit checker（draft 高估了确定性） |
| C3 | @MX 自动标注（ANCHOR=3+callers / WARN=complexity≥15） | ✓ | ✗ | **reject** | 0.93 | **NN 真成立**（`pre-commit-check.js` grep "sizebudget/complexity/ANCHOR" = 0 匹配，无 caller-counting）。但 P0 illusory：@MX 帮导航大型生产代码库，TP 是万行 meta-tooling，痛点是 doc-drift 不是 code 导航 + AST 重量违反轻量。**draft 自疑正确，resist 住"自动化=net-new→adapt"陷阱** |
| C4 | GAN Loop 对抗 QA | ✗ | ✗ | **reject** | 0.93 | already-had + 收敛（CV3）：`review.md:108-152` Rubric-gated revise loop（cap N=2）同构。唯一增量 0.75 浮点分会**回退确定性**（#2），cosmetic pseudo-adapt |
| C5 | Ralph Engine 确定性错误分类（LSP+AST-grep，分级 1-4，max 100 iter） | ✗ | ✗ | **reject**（draft backlog 改判） | 0.82 | **category error 修正**：Ralph 2 面——迭代天花板（already-had/已 deferred，CV4）+ 错误分类。deferred slot（`sprint-goal.md:31-34`）只装迭代计数器，**不装错误分类**。错误分类 target-user 错配（TP 不产 LSP-可诊断的编译代码）+ LSP/AST 重量违反轻量 |
| C6 | Progressive Disclosure 3 级 skills | ✗ | ✗ | **reject** | 0.93 | already-had + 收敛（CV8）：host 原生 L1/L2/L3 + `skill-diagnose.md:31-38` 已审计 + 12KB 预算 |
| C7 | 多 LLM cost-tier（High/Med/Low + GLM tmux） | ✗ | ✗ | **reject** | 0.93 | already-had：`performance.md:3-18` Haiku/Sonnet/Opus 分层（CV6）。cost-arbitrage P0 illusory（solo 无 code-farm）；tmux+GLM 违反轻量 #3 + parity #1（加 GLM 非 Codex） |
| C8 | progress.md 自动 resume | ✗ | ✗ | **reject** | 0.93 | already-had 且更强（CV2）：per-Task resume。auto-resume 需宿主进程（[[ADR-021]] 无），cosmetic delta |
| C9 | DDD ANALYZE-PRESERVE-IMPROVE（legacy <10% 覆盖） | ✗ | ✗ | **reject** | 0.90 | already-had：行为锁定 = 回归测试强制（`test.md:164-191`）+ [[ADR-013]]§B break-impl 3 档负样本。<10% legacy 前提对 TP 不成立 + target-user 错配。**勘误**：draft"无代码可重构"不准（TP 有 14 lib js 层） |
| C10 | Hook 协议 27 事件 | ✗ | ✗ | **reject** | 0.93 | already-had：逻辑 hook registry（`hook-registry.js:11-137`，7 逻辑 hook 投影，[[ADR-014]]）。27 事件（TeammateIdle 等）**无宿主 runtime 触发器**（[[ADR-021]] inert）+ 违反 parity #1 + 轻量 #3。**draft "partial" 勘误为 fully already-had** |
| C11 | Execution Mode Selection Gate | ✗ | ✗ | **reject** | 0.90 | already-had fully：`agent-orchestrator.js:1701` buildPreflightReport + `:1916` runDoctor + `:1923` --probe live ping + gate `:1838/:1845` + auto-mode 确认门。GLM/tmux 选择器 target-user 错配 |
| **B1** | **plan-auditor / sync-auditor 语义 doc↔code↔plan 审计** | ✓ | ✓ | **backlog** | — | **critic 新增**。NN：`knowledge-drift.js`（[[ADR-023]]）只查行号引用**文件存在性**，不做语义（测不出"doc 称已修但代码没改"）。P0 真实：坐 TP #1 痛点 doc-drift（CLAUDE.md "文档滞后=失败" + [[feedback_drift_fix_requires_full_claim_grep]]），现靠纪律非机制（正是 [[ADR-013]] 反模式）。**但**语义审计是 LLM 判断（[[ADR-017]] 边界）不可做 pre-commit 确定性门 → 落 `/review` lens / `/compound` check，measure-before-enforce gated（同 C5 旧 gate 纪律）。moai 的 Go 实现拒（重量），借的是**机制形状**非实现 |

**tally: 0 borrow / 0 adapt / 1 backlog（B1）/ 11 reject。**

## 6. 优缺点（双向，[[feedback_evaluation_data_conclusion_consistency]]）

**moai-adk 强于 TP（但不适合 TP 借）**：真生产代码 harness（16+ 语言 coverage / TDD-DDD 自动选 / PR 自动化）；全功能产品工厂（DB/design/brand pipeline）；Ralph 确定性错误分类（但 target-user 错配）。

**TP 强于 moai-adk**：双运行时 parity（Codex）；知识层复利（instinct 进化 + Obsidian 跨设备）；确定性 enforcement 下沉 pre-commit（[[ADR-013]]）vs moai LLM 浮点门；轻量（markdown+jsonl vs 38.7K 行 Go）；measure-before-enforce（[[ADR-022]]）。

**moai-adk 自身风险（旁观，不影响 TP）**：重量级 harness 维护表面、GLM tmux 复杂度、85% coverage 硬门对探索型代码摩擦。

## 7. §二次评审（adversarial-verified，status=reviewed）

本 doc 经 13-agent 对抗核验 workflow（refute-by-default + 每条 verdict 强制 grep TP 代码锚定 + completeness critic 查漏）。review pass 完成，status 升 **reviewed**（[[feedback_sibling_eval_completed_status_requires_review_pass]]）。**不升 completed**：R1/R3 未读 moai 源码 + B1 待最终处置（见 §8）。

### 7.1 对抗核验对 draft 的纠正（[[feedback_single_pass_eval_lenient_vs_adversarial]] 活案例）

主循环 draft 系统性偏宽的预测被证实——但本次偏差**不在"误标 adapt"而在"reject 理由错"**：

- **C1**：draft 用"freeform 够用、EARS 团队 ceremony"reject——**事实错误**，TP 早已采纳 EARS-lite（`think.md:81-95`）。这是 draft 自身的 [[documented-claim-vs-code-reality-drift]]，讽刺地正是本 eval 主题。教训：**写"TP 没有 X"前必须 grep，不能凭记忆**（[[feedback_grep_self_codebase_before_analysis]]）。
- **C5**：draft 给 backlog 是 category error（错误分类≠迭代天花板 deferred slot）。对抗核验拆分两面后判 reject。
- **C2/C9/C10/C11**：verdict 不变但 draft 理由不精确（C2 高估确定性、C9 漏 js 层、C10/C11 "partial" 实为 fully）——对抗核验逐条 code-anchor 收紧。

结论：**对抗核验 = 6 个 sibling-eval 来防 draft 偏宽的有效兜底**。draft 0/0/1/10 → 对抗 0/0/1/11（C5 降级 + B1 新增）。

### 7.2 eval 反向发现的 TP 真 bug（actionable，独立 follow-up）

对抗核验 C3 时发现：**`sprint.md:517` 声称 `@sizebudget` 由 "pre-commit hook 拒绝超额提交" 强制，但 grep `pre-commit-check.js` = 0 匹配**——TP 自家 sprint.md 的 [[documented-claim-vs-code-reality-drift]]（虚假 enforcement 声明）。两条处置路径（待用户定，**不并入本 eval commit**，守"每个提交只做一件事"）：
- (a) 改 doc：把 @sizebudget 行标为"doc-only 约定"（与同表其他 3 个标签一致），最小、诚实；
- (b) 实装：给 pre-commit 加 @sizebudget checker（但需先证高频违反价值，[[ADR-013]] + measure-before-enforce）。
推荐 (a)（轻量 + 立即消除 drift）。

## 8. 残留风险（[[documented-claim-vs-code-reality-drift]]）

- **R1**：moai 资料来自 README + DeepWiki + 1 次 web search，**未读源码**。性能 claim（90% rework↓ / 70% bug↓ / 15% 时间↓）是营销数字，未独立核实，本 eval 不依赖它们裁决。
- **R2（已部分解除）**：52 skills / 24-28 agents 此前按类别抽象判定。completeness critic 专审 evaluator 类（sync-auditor/plan-auditor）→ 挖出 B1。其余类别（manager/expert/builder/design）+ Alfred NL 路由 / /simplify / /moai design / codemaps 经 critic refute-by-default 全 reject（target-user 错配 / already-had / 轻量）。**剩余风险**：52 skill 未逐个审，可能仍有细粒度机制漏网（低概率，doc-saturated 模式下）。
- **R3**：Ralph（C5）+ plan-auditor（B1）实现细节未读源码。B1 backlog 是基于**机制形状**非 moai 实现质量；revival 前需读源码核实语义审计严格度。
- **R4**：agent 数两处来源不一致（README 24 / search 28），不影响裁决，记录待核。

## 9. 结论

第 6 次连续 ~0 借鉴（spec-kit/gsd/claude-mem/ecc/pm-skills/bmad 后），**再印证 [[ADR-025]] doc-saturated meta-toolchain 现象**：外部框架（无论规模/stars）机制要么 already-had、要么 target-user 错配、要么违反不可妥协。

但本次 eval 的**真价值不在裁决而在副产物**：
1. **B1**（plan-auditor 语义审计）——TP doc-drift 防御的真实语义盲区，落 measure-before-enforce backlog；
2. **§7.2 TP 真 bug**（sprint.md:517 虚假 enforcement 声明）——eval 反向 dogfood 出自家 drift；
3. **§7.1 draft 自身 C1 drift**——证明"写 TP 没有 X 前必 grep"，以及对抗核验对单遍裁决的必要性。

收敛验证（§4 十机制）+ 三个副产物 > 零借鉴本身。
