---
title: "对比：tech-persistence /plan vs Claude Code 原生 plan mode vs Codex CLI 原生 plan mode（方法论层 vs 双 runtime enforcement 层）"
date: 2026-06-08
tags: [solution, architecture, plan-mode, claude-code, codex]
related_instincts:
  - plan-mode-enforcement-vs-plan-command-artifact
  - native-plan-mode-convergent-across-runtimes
related_solutions:
  - "[[2026-06-01-claude-code-dynamic-workflows-architecture]]"
  - "[[2026-05-29-sprint-goal-mode]]"
aliases: ["plan mode comparison", "plan 模式对比", "native plan mode vs /plan", "codex plan mode", "三方 plan 对比"]
status: completed
---

# 对比：tech-persistence /plan vs Claude Code 原生 plan mode vs Codex CLI 原生 plan mode

## Problem

用户先问"对比当前 plan 模式和 Claude Code 自带的 plan 模式"，再要求接入 Codex CLI 原生 plan 模式凑成三方对比。风险在于三者都叫 plan，容易当成竞品三选一。实际它们分两层——tech-persistence `/plan` 是 model-driven markdown 方法论协议（双 runtime），Claude Code / Codex 的原生 plan mode 各是其 harness/CLI 进程级强制的 read-only enforcement 状态——混为一谈会推导出错误的"替换"结论，并踩本仓库 [[ADR-021]] 已界定的"确定性强制上限由是否存在宿主进程决定"边界。接入 Codex 这一轴同时暴露并修正了本文初版的一处 drift（曾误称原生 plan mode "仅 Claude Code、无 Codex 等价物"）。

## Root Cause

把三者放在同一根 ROI 轴上比较是错的，因为它们分属不同层。先各自落实 load-bearing 事实，并标注每条是 repo-verified 还是 external（web-sourced）。

### tech-persistence `/plan`（本仓库代码现实，repo-verified）

来源：`user-level/commands/plan.md`（经 propagate 派生到 `.codex/commands/plan.md` + plugin skill）。

- **本质**：markdown prompt 协议，无 backing code、无宿主进程。属 [[ADR-021]] 所述 model-driven 子系统。
- **角色约束**：显式切到架构师视角（关注方案/任务拆解/风险/依赖/测试策略；不碰产品定义与具体代码）。
- **规划深度自适应**：详尽度跟「任务可逆性 × 规模」走，判定优先级"可逆性 > 规模"（与全局「规划深度规则」一致）。
- **结构化产物**：任务拆解 + `[P]` 并行判定（3 条全满足才标）+ 测试策略 + 风险表 + 条件性「契约接口 before/after」段 + 置信度自评。
- **持久化（CRITICAL，不可跳过）**：执行步骤 4 强制 `Write` 计划进 `docs/plans/YYYY-MM-DD-<slug>.md`，更新 `status: planning`。
- **gate**：默认结尾询问是否进 `/work`；`--auto` 时任务数 ≤ 8 且无 L3/L4 才自动放行。
- **知识集成**：研究阶段读 CLAUDE.md / `.claude/rules/` / 高置信度本能（`~/.claude/homunculus/`）。
- **多运行时 parity**：Claude + Codex 双副本（[[ADR-011]]）。Claude 端入口是 `/plan` slash command；**Codex 端入口是 plan 技能（`$plan` / `@` 选择器），不是 `/plan`**——因为 Codex CLI 把插件包注册为 skill 而非 interactive slash command（见 sprint skill 前言），且 `/plan` 在 Codex 已被其原生 plan mode 占用（见下）。

### Claude Code 原生 plan mode（harness 内置特性，external，非本仓库代码）

来源：Claude Code harness 内置能力，由 `EnterPlanMode` / `ExitPlanMode` 工具与 Shift+Tab 模式切换暴露。external 运行时行为：

- **本质**：harness 强制的运行时状态，不是 prompt 协议。
- **探索期写保护**：plan mode 期间 harness 在工具层 block 所有 mutating 操作（Write/Edit/mutating Bash），模型只能 read/search/explore。进程级确定性强制。
- **gate**：模型经 `ExitPlanMode` 提交 plan，走 harness 原生审批 UI，用户批准/拒绝；批准后退出 plan mode 才能执行。
- **产物**：plan 是 in-conversation 文本，默认不落盘。
- **知识集成 / 角色**：通用 research-then-propose，无 tech-persistence 的本能/rules/契约注入，无架构师角色切换。
- **运行时**：Claude Code 独占（但 Codex 有自己的同构等价物，见下——"原生 plan mode"作为**类别**在两 runtime 都存在）。

### Codex CLI 原生 plan mode（OpenAI Codex CLI 内置特性，external，web-sourced）

来源：OpenAI Codex 官方文档 + 多个二手实践源（见 Verification）。external 运行时行为：

- **本质**：CLI 强制的运行时状态，不是 prompt 协议（与 Claude Code 原生 plan mode 同层）。
- **激活**：`/plan` 命令 或 in-session `Shift+Tab` 切换。
- **探索期写保护**：read-only——模型可读文件、搜代码、提澄清问题，但**在你批准 plan 之前不修改文件、不运行 mutating 命令**。
- **gate**：plan 流式输出到专用 TUI plan view；approve（"go with that plan"）/ deny；**deny 时 Codex 按你的反馈迭代精修 plan**，直到对齐（比 Claude 的单轮 ExitPlanMode 多了显式精修回路）。
- **产物**：plan 在 TUI view，默认不落盘。
- **可配**：`plan_mode_reasoning_effort`（如 "high"）单独控制 plan 阶段推理强度。
- **与 sandbox/approval 分层协同**：Codex 安全由两层组成——sandbox mode（技术能力边界：`read-only` / `workspace-write` / `danger-full-access`）+ approval policy（何时必须问你）。read-only 也可经 `/permissions` 进入。
- **运行时**：Codex CLI 独占。
- **repo 旁证**：本仓库 agent-orchestrator 的 `codexSandboxMode`（`plugins/tech-persistence/scripts/agent-orchestrator.js:1181`）即对接 `codex exec --sandbox <mode>`（Windows 默认 `workspace-write`），印证 Codex 的 sandbox 分层确实存在；但注意那是**非交互 `codex exec`** 路径，与**交互式 Plan Mode** 不是同一入口。

## Solution

> 这是对比分析（compare + pros/cons），不含落地承诺。结论：**三者分两层——一个方法论层（`/plan`，双 runtime）+ 两个 enforcement 层原生 plan mode（Claude / Codex 各一），互补非竞争。两 runtime 的原生 plan mode 是收敛进化（near-identical 语义），反向验证 [[ADR-021]] framing。**

### 本质差异（三方）

| 维度 | tech-persistence `/plan` | Claude Code 原生 plan mode | Codex CLI 原生 plan mode |
|------|--------------------------|----------------------------|--------------------------|
| 本质 | model-driven markdown 协议 | harness 强制运行时状态 | CLI 强制运行时状态 |
| 强制力 | 纪律层——无进程强制（[[ADR-021]]） | 确定性层——harness block 写 | 确定性层——CLI read-only，批准前不写/不跑 mutating |
| 探索期写保护 | ❌ 无（可边 plan 边改文件） | ✅ 有（read-only 硬隔离） | ✅ 有（read-only 硬隔离） |
| 激活 | `/plan`（Claude）/ `$plan` 技能（Codex） | Shift+Tab / `EnterPlanMode` | `/plan` 或 Shift+Tab |
| gate | sprint 'go' / `--auto`（软约定） | `ExitPlanMode` 审批 UI（硬，单轮） | TUI plan 审批，approve/deny（硬，**deny→迭代精修**） |
| 产物 | 持久化 `docs/plans/*.md` | in-conversation，不落盘 | TUI plan view，不落盘 |
| 产物结构 | 任务拆解+`[P]`+风险表+测试+契约+置信度 | 自由格式 | 自由格式（可配 `plan_mode_reasoning_effort`） |
| 知识集成 | 深——CLAUDE.md/rules/本能/规划深度 | 无，stateless 通用 | 无，stateless 通用 |
| 角色约束 | 显式架构师视角 | 通用 research-then-propose | 通用 read-analyze-propose |
| 运行时 | Claude + Codex parity（**方法论层**） | 仅 Claude Code（enforcement 层） | 仅 Codex CLI（enforcement 层） |
| 可审计 | 高——git tracked/ADR/Obsidian | 低——对话内 | 低——TUI 内 |

### 关键洞察 1：两 runtime 原生 plan mode 是收敛进化

Claude Code 与 Codex CLI **各自独立**做出了语义近乎同构的原生 plan mode：read-only 探索 → 提 plan → 批准才执行 → Shift+Tab in-session 切换。这是收敛进化（[[feedback_sibling_eval_convergent_evolution_high_value]]）——两个独立 runtime 撞出同一个 enforcement 机制，反向验证本仓库 [[ADR-021]]「确定性写保护必须有宿主进程」的 framing：两个 harness 都靠进程级状态实现了 markdown 协议拿不到的写保护。

Codex 相对 Claude 的差异点：deny 时显式迭代精修 plan 回路、`plan_mode_reasoning_effort` 可配、与三档 sandbox + approval policy 分层耦合更显式。但这些是同一层内的实现差异，不改变"二者同属 enforcement 层"的定性。

### 关键洞察 2：`/plan` token 在 Codex 撞名（高踩坑）

**在 Codex CLI 里输入 `/plan` 进的是 Codex 原生 plan mode，不是 tech-persistence 的方法论 plan。** tech-persistence 的 plan 在 Codex 经**技能入口**（`$plan` / `@` 选择器）——因为 Codex CLI 把插件包注册为 skill 而非 interactive slash command（repo 事实，见 sprint skill 前言）。所以同一个 `/plan` 字符串，在 Claude = tech-persistence 方法论 plan，在 Codex = Codex 原生 plan mode；要在 Codex 用 tech-persistence 的结构化 plan 必须走 `$plan` 技能。这是 multi-runtime 下最易踩的入口歧义。

### 各自优劣（互补点）

- **原生 plan mode（两 runtime 通用）强在 `/plan` 的死穴**：探索期确定性写保护（markdown 协议永远拿不到，[[ADR-021]] 边界）、原生 UI 硬批准、零配置零维护。Codex 侧额外有 deny→精修回路与可配推理强度。
- **`/plan` 强在原生 plan mode 完全不碰的地方**：落盘 `docs/plans/` 沉淀 + 跨 sprint invariant/债务/ADR 链接、`[P]`/L0-L4/契约 before-after 结构化深度、吃本能/rules 喂回自学习系统的知识闭环、**方法论层的双 runtime parity**（同一套 plan 方法论 Claude 用命令、Codex 用技能，行为一致）。

### 机制冲突点（叠加会撞车）

1. **写保护 vs 落盘**：`/plan` 步骤 4「持久化到 `docs/plans/`」是 `Write`；原生 plan mode（Claude 或 Codex）期间 read-only 硬隔离 block 所有写。即在任一原生 plan mode 里直接跑 `/plan` 方法论，落盘步骤会被硬拦。两者是串联非嵌套。
2. **入口撞名（Codex 侧，见洞察 2）**：`/plan` 在 Codex 不会唤起 tech-persistence plan。

正确组合时序（两 runtime 对称）：

```text
进原生 plan mode（Claude: Shift+Tab/EnterPlanMode；Codex: /plan 或 Shift+Tab）
  → read-only 硬隔离防误改，探索 + 按 tech-persistence plan 结构组织内容
  → 经原生审批（Claude ExitPlanMode / Codex TUI approve）走硬 gate
  → 批准后退出 plan mode → 此时才 Write 落盘 docs/plans/（Codex 经 $plan 技能产出结构）→ 进 /work
```

即：原生 plan mode 提供「探索期确定性写保护 + 硬批准 gate」，tech-persistence `/plan` 提供「结构化产物 + 知识沉淀」，两层在两 runtime 上对称组合。

### 何时用哪个

| 场景 | 选择 |
|------|------|
| 中大型功能、跨 sprint、要沉淀、要双 runtime 方法论一致 | tech-persistence `/plan`（或 `/sprint`；Codex 端用 `$plan` 技能） |
| 任意任务的「先看后做」安全闸，尤其陌生代码库怕误改 | 当前 runtime 的原生 plan mode（Claude / Codex 各自的） |
| 既要写保护又要结构沉淀 | 组合：原生 plan mode 探索 → 原生审批 → 批准后 `/plan` 落盘 |
| 小可逆任务（规划深度规则 P0/P1） | 都不用，直接做 |

## Decision Record

延续 [[ADR-021]]：model-driven `/sprint` / `/plan` 没有宿主进程，确定性上限 = 协议 + 持久化 + 可见打印；Claude Code / Codex 的原生 plan mode 恰恰**都有**宿主进程（harness/CLI），所以都能做 `/plan` 物理做不到的探索期写保护与硬批准 gate。三者踩在 ADR-021「确定性强制上限由是否存在宿主进程/可挂事件决定」光谱上——`/plan` 在纪律端，两个原生 plan mode 在确定性端。两 runtime 各自独立做出同构 plan mode 是该 ADR 的双重活案例（收敛进化，[[feedback_sibling_eval_convergent_evolution_high_value]]）。

延续 [[ADR-011]] 确立的 4 不可妥协原则之 multi-runtime parity（ADR-011 主题是 identity-question-first，parity 是其 decision 段列出的 4 原则之一，本仓库统一以 [[ADR-011]] 作 parity 锚点）：原生 plan mode 是 runtime-specific enforcement——Claude 与 Codex 各有一份，互不可移植，但**作为类别在两 runtime 对称存在**。tech-persistence `/plan` 提供的是**方法论层**的对称 parity（Claude 命令 + Codex 技能）。两层叠起来：enforcement 层由各 runtime 原生 plan mode 对称覆盖，方法论层由 `/plan` 对称覆盖——parity 在两层都成立，与 [[2026-06-01-claude-code-dynamic-workflows-architecture]]「Claude-only feature 必须有 fallback backend」同构（这里 fallback 天然存在，因 Codex 自带等价 enforcement）。

本条**不改任何顶层命令**，是纯对比分析；是否把"与原生 plan mode 协同 + Codex `$plan` 入口提示"吸收进 `/plan`，留作后续显式决策（需先过"是否值得增维护表面"判断）。

## 二次评审（Adversarial Verification）

本文 claim-heavy，按本仓库 [[documented-claim-vs-code-reality-drift]] 文化核验。两轮：

- **第一轮（Claude/`/plan` 两方，多 agent workflow）**：27 claim → 25 supported / 1 external / 1 partial（ADR-011 引用精度，已修）。详见会话首轮 workflow 输出。
- **第二轮（接入 Codex，inline 核验，ultracode 已关、无 workflow opt-in）**：
  - repo-internal claims（`/plan` Codex 入口是技能而非 `/plan`、codex sandbox 分层经 `agent-orchestrator.js:1181` `codexSandboxMode`、`.codex/commands/plan.md` 是 propagate 派生副本）：对源码核验通过。
  - external Codex claims（原生 plan mode read-only + `/plan`/Shift+Tab 激活 + TUI approve/deny 迭代精修 + `plan_mode_reasoning_effort` + sandbox 三档）：web-sourced（OpenAI 官方文档 + 多个二手源，见 Verification），标注 external，不纳入 repo drift 校验。
  - **修正一处 prior drift**：初版断言原生 plan mode「仅 Claude Code、无 Codex 等价物」，经本轮研究证伪——Codex CLI 有同构原生 plan mode。已改为"runtime-specific、两 runtime 对称存在"。这正是本仓库"断言 X 只在 runtime A 前必须复查 sibling runtime"教训的活样本（见 Prevention）。

## Verification

- 自家代码对照（repo-verified）：`user-level/commands/plan.md`、`user-level/commands/think.md`、`.codex/commands/plan.md`（propagate 副本）、`plugins/tech-persistence/scripts/agent-orchestrator.js:1181`（`codexSandboxMode`，`codex exec --sandbox`）、`.claude/rules/architecture.md`（ADR-021/012/011/023）、sprint skill 前言（Codex 注册为 skill 非 slash command）。
- 外部对照（external，web-sourced，2026-06 检索）：
  - [Agent approvals & security – Codex | OpenAI Developers](https://developers.openai.com/codex/agent-approvals-security)
  - [Sandbox – Codex | OpenAI Developers](https://developers.openai.com/codex/concepts/sandboxing)
  - [Command line options – Codex CLI | OpenAI Developers](https://developers.openai.com/codex/cli/reference)
  - [Plan Mode in Codex CLI is here | DeepakNess](https://deepakness.com/raw/plan-mode-in-codex-cli/)
  - [Plan Mode Mechanics: Enter vs Tab | Codex Blog](https://codex.danielvaughan.com/2026/04/08/plan-mode-mechanics/)
  - Claude Code 原生 plan mode（`EnterPlanMode`/`ExitPlanMode`、Shift+Tab、read-only 强制、审批 UI）。
- 文档变更验证：`node scripts/sync-solution-index.js --all`；`node scripts/pre-commit-check.js`；`git diff --check`。

## Prevention / 泛化

- 比较多个同名机制前先问"它们在不在同一层"——harness/CLI 进程级 enforcement vs model-driven 协议不在一根 ROI 轴上，"替换"是伪命题，正解是分层组合。
- 这是 [[ADR-021]] 在 plan 工具维度的具体落点：要"确定性写保护"就必须有宿主进程；markdown 协议拿不到，需要时借各 runtime 原生 plan mode，而非给协议堆"模型必须自愿调用"的伪强制。
- **断言"X 能力只在 runtime A、runtime B 无等价物"前，必须复查 sibling runtime 是否已 ship 等价物**——Claude Code 与 Codex CLI 收敛进化频繁（plan mode、dynamic workflows、approval/sandbox 都是各自独立做出近似物），单边断言极易 drift（本文初版即踩，"无 Codex 等价物"被证伪）。
- 评估外部 runtime 能力一律先归类：方法论协议 / 执行后端 / 编排原语 / 观察工具 / **enforcement 机制**，归类前不改顶层命令（与 [[2026-06-01-claude-code-dynamic-workflows-architecture]] 同协议）。
- multi-runtime 下注意**入口 token 撞名**：同一 `/cmd` 在不同 runtime 可能指向不同 owner（`/plan` 在 Codex = 原生 plan mode，tech-persistence plan 在 Codex 走 `$plan` 技能）。跨 runtime 写"用 /X"指引前先确认该 token 在目标 runtime 未被内置占用。
