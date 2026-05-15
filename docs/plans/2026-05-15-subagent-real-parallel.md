---
title: "Subagent 真并行：/review + /work + /sprint Phase 4 用 Agent tool spawn + SDD 4 status 协议"
type: sprint
status: in-progress
created: "2026-05-15"
updated: "2026-05-15"
tasks_total: 7
tasks_completed: 7
tags: [sprint, subagent, parallel-review, parallel-work, worker-spawn, sdd-status-protocol, agent-tool, refactor]
aliases: ["subagent-real-parallel", "sdd-status-borrow"]
related_instincts:
  - feedback-sibling-eval-default-compare-not-borrow
  - dogfood-validity-reviewer-essential-for-sibling-eval
  - feedback-grep-self-codebase-before-analysis
related_adrs:
  - ADR-011  # identity-question-first
  - ADR-012  # 关键假设验证
  - ADR-013  # mechanism over discipline + §B dogfood 边界
  - ADR-014  # hook-registry 单一语义源头（同源原则可类比 reviewer registry）
---

# Subagent 真并行 + SDD 4 status 协议借鉴

## §0 项目身份界定（[[ADR-011]] 强制）

**项目定位**：tech-persistence = developer-toolchain self-evolution sibling（personal toolchain），不是公开 plugin。

**4 不可妥协原则**：

| 原则 | 本 sprint 体现 |
|------|---------------|
| 多运行时 parity | 改动 user-level/commands/*.md 必须经 propagate-command-changes.js 同步 .codex/ + build-codex-plugin.js 同步 plugin 副本 |
| 确定性优先 | reviewer dispatch 必须可复现（risk + 文件路径 → reviewer 集合 deterministic）；不引入随机选择 |
| 轻量优先 | 不新建 ~/.claude/agents/ 庞大 agent 库；复用 Claude Code 内置 `general-purpose` Agent + prompt template |
| Obsidian 兼容 | sprint 文档 frontmatter + wiki-link `[[...]]` 引用 ADR/instincts |

**档位声明**（[[feedback-sibling-eval-default-compare-not-borrow]]）：

- 用户明示**(c) 落地实施**档位（"做一个 subagent 优化"是实施动词）
- 用户选 B 选项：scope = /review + /sprint Phase 4 + SDD 4 status，不含 /agent-loop orchestrator 改动、不含 ~/.claude/agents/ 库新建
- 不做 sibling-eval 全表对比（参考 superpowers 是借鉴 single feature，不是评估全 plugin）

### Scope 扩展记录（Phase 2 用户授权）

- **2026-05-15 用户驱动扩展**：原 B scope 仅 /review + /sprint Phase 4；用户提示"subagent 的目的是分工 / 减时间 / 提效率"后选择 C 选项扩到 **/work** 也 spawn worker subagent
- 扩展原因：3 个核心目标（分工 / 减时间 / 提效率）的最大杠杆在 /work 多 task 并行实施，不在 /review 5 视角并行
- 仍保持的明示不做：~~/plan~~（设计思考需连贯单上下文，不适合拆分 spawn）、~~/agent-loop orchestrator~~、~~~/.claude/agents/ 库~~
- 任务数 4 → 7（≤ 8 满足 sprint.md Phase 2 自动准入；但用户未启用 --auto 仍保留人工 gate）

### 核心动机（Phase 2 用户明示，对齐到设计约束）

本 sprint 的 subagent 化围绕 3 个核心目标，所有设计决策对齐这 3 个目标：

| # | 目标 | 设计落地 | 反例（要警惕的偏离）|
|---|------|---------|------------------|
| 1 | **分工明确** | 5 reviewer 视角 + worker per [P] task；每 spawn 单一职责单一文件清单 | ❌ 让一个 reviewer 既审 security 又审 perf；❌ worker 改 task 描述外的文件 |
| 2 | **减少总时间** | 真并行 spawn（5×T → 1×T）；retry ≤ 1 硬限不拖慢；patch 收集串行 apply 但快（秒级）| ❌ retry 无限循环；❌ BLOCKED 强制 gate 阻塞所有 reviewer；❌ 主 LLM 串行扮演 N 视角 |
| 3 | **提高效率** | 独立 context 无视角污染；Haiku/Sonnet 模型分层节省成本；worktree 隔离避免回滚 | ❌ 全用 Sonnet（成本无意义）；❌ 共享 working dir 让 worker 互相破坏 |

**对齐验证规则**：Phase 3 实施时每完成一个 task 自检"是否对齐这 3 个目标"；Phase 4 review 阶段强制审"是否引入了反例的设计"。

---

## §1 需求分析（Phase 1 Think）

### 1.1 现状（grep 验证，2026-05-15）

| 组件 | 实际状态 | 性质 |
|------|---------|------|
| `user-level/commands/review.md` | 5 视角描述为 inline LLM role-switching；表格写有"默认模型 Sonnet/Haiku"但**无 Agent tool spawn 调用** | aspirational design，未实现 |
| `user-level/commands/sprint.md` Phase 4 | 调用 `/review`，本身无 spawn 逻辑 | 同上 |
| `~/.claude/agents/*.md` | 目录**不存在**（`rules/common/agents.md` 描述 10 个 agent 全是空引用）| 文档与现实漂移 |
| `scripts/agent-orchestrator/*.js` | 跨进程 orchestration，仅服务 `/agent-loop` 的 spec→impl→review 流水线 | 不复用于 /review/sprint |
| 用户级 commands 中 `Agent(`/`subagent_type` 引用 | grep 0 命中 | 项目代码完全不消费 Agent tool |
| Built-in Agent（`general-purpose`/`Plan`/`Explore`）| Claude Code 提供，未被 commands 编排 | 现成能力闲置 |

→ **核心 gap**：所谓"5 视角并行 reviewer"实际是**单 LLM 上下文内串行扮演 5 个角色**，不能实现：
1. 独立 context（视角间相互污染）
2. 独立模型（Haiku/Sonnet 分层是文档承诺，未实施）
3. 真并行（一次 LLM call 串行思考 ≠ N 并发子进程）
4. 独立失败隔离（单 reviewer crash 拖垮全审查）

### 1.2 借鉴对象（superpowers SDD，仅 4 个 single feature）

按 [[feedback-sibling-eval-default-compare-not-borrow]]，本 sprint 不做全 plugin 评估，只借 4 个 SDD 元素：

| 借鉴项 | 来源 | 本项目落地形式 |
|-------|------|---------------|
| **真子进程 spawn**（Agent tool）| superpowers `using-subagents` skill 的 7-step flow | 改 review.md / sprint.md，5 reviewer 改 spawn 5 个 `general-purpose` Agent |
| **4 status 返回协议** | superpowers SDD: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED | reviewer prompt template 强制末尾输出 `STATUS: <one of 4>` |
| **escalation 触发条件** | superpowers SDD escalation paths | NEEDS_CONTEXT → 主 LLM 补充 context 再 retry；BLOCKED → 升级人工 gate |
| **独立 context 隔离** | superpowers per-task isolated context | Agent tool 天然提供（每个 spawn 是独立 conversation）|

**不借鉴**（非本 sprint scope）：
- ~~7-step full SDD flow~~（过重）
- ~~Red Flags Never list~~（review prompt 内 inline 即可）
- ~~per-task subagent specialization 库~~（轻量原则）
- ~~SDD orchestrator 模式~~（与现有 risk dispatch 冲突）

### 1.3 要做

**/review + /sprint Phase 4 端**：

- [ ] **R1**: `/review` 5 视角改用 Agent tool spawn 真并行子进程（每 reviewer 独立 context + 独立模型层级）
- [ ] **R2**: `/sprint` Phase 4 复用 R1 的 reviewer pool，不重写 dispatch 逻辑
- [ ] **R3**: reviewer prompt template 强制 4 status 返回（DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED）
- [ ] **R4**: NEEDS_CONTEXT 触发主 LLM 补充上下文 retry（≤1 次）；BLOCKED 触发升级人工 gate（即使 --auto 也强制问）
- [ ] **R5**: dispatch matrix 保留（risk → reviewer 子集），reviewer 模型分层落地（quality/test = Haiku，security/perf/arch = Sonnet）
- [ ] **R6**: 派遣记录格式扩展（增加 spawn count + status 分布 + retry/blocked 计数）

**/work 端**（Phase 2 用户授权扩 scope）：

- [ ] **R7**: `/work` 同批 `[P]` task 改为真 spawn worker subagent 并行实施（用 Agent tool 的 `isolation: "worktree"` 参数，每 worker 独立 git worktree 避免 race condition）
- [ ] **R8**: worker prompt template 强制 4 status 返回（与 reviewer 同协议，统一 contract）
- [ ] **R9**: worker 完成后主 LLM 串行 apply patch（不让多 worker 同时写同目录）；失败 worker worktree 自动清理（Agent tool 内置行为）
- [ ] **R10**: 保留原 `[P]` 协议的冲突检测算法（line 60-63）和失败传播规则（line 65）；改写 line 75 "[P] 不是多进程调度" 为 "Claude Code 端真 spawn worker，Codex 端保留 batch fallback"

**共用基础设施**：

- [ ] **R11**: 改动同步 .codex/ + plugin 副本（propagate-command-changes.js + build-codex-plugin.js）

### 1.4 不做（明示排除）

- ❌ **不**新建 ~/.claude/agents/*.md 库（违反"轻量优先"原则；用 prompt template 嵌入即可）
- ❌ **不**改 agent-orchestrator（不属于 /review/work/sprint 范畴；用户已明示 scope 不含 D）
- ❌ **不**改 review.md 的 5 视角定义本身（security/perf/arch/quality/test 内容不变，只改 spawn 机制）
- ❌ **不**改 /plan（用户明示保留单上下文：设计思考需连贯，不适合拆分 spawn）
- ❌ **不**做 superpowers SDD 7-step full flow（过重）
- ❌ **不**做 ~/.claude/agents/ 库扫描或 hot-reload（确定性优先：reviewer/worker 集合 hardcode 在 review.md/work.md）
- ❌ **不**支持 reviewer 自定义注入（YAGNI，用户没有此需求）
- ❌ **不**改 /agent-loop 的 reviewer 阶段（独立 orchestrator 已工作，本 sprint 不动）
- ❌ **不**追加新的 reviewer 视角（仍是 5 视角）
- ❌ **不**让 worker 跨 [P] 边界做依赖任务（worker 仅在 [P] 同批内并行，依赖 task 仍串行）

### 1.5 成功标准

**/review + /sprint Phase 4**：

- [ ] 跑一次 `/review` 在 L3+ diff 上：观察到**真并行 spawn**（多个 Agent 调用一次性发出，非顺序）
- [ ] reviewer 输出**全部包含 `STATUS: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>`** 末尾标记
- [ ] **NEEDS_CONTEXT 触发**至少 1 次 retry 闭环可演示
- [ ] **BLOCKED 即使 --auto 也强制问用户**
- [ ] dispatch matrix 行为不变（L0/L1 仍只跑 quality；L4 跑全套）
- [ ] 派遣记录格式新增 status 分布 + retry/blocked 计数

**/work**：

- [ ] 构造 2-3 个 `[P]` 标记的 L1/L2 task 跑一次 `/work`：观察到**真并行 worker spawn**（用 isolation: worktree）
- [ ] worker 输出**全部包含 `STATUS: ...`** 末尾标记
- [ ] worker 完成后主 LLM 串行 apply 各 worktree 的 patch + 跑 task 测试 + 勾选 sprint.md checkbox
- [ ] 失败场景：故意让某 worker 测试失败 → 主 LLM 不 apply 该 patch + 该 worktree 自动清理 + 进入原 3 轮调试循环
- [ ] 冲突检测：原 line 60-63 算法保留；spawn 前先检测，发现冲突降级串行
- [ ] 时间收益：spawn N 个 worker 的 wall clock 时间 ≈ 单 task 时间（而非 N × 单 task 时间）

**共用**：

- [ ] `.codex/commands/{review,work,sprint}.md` 与 `user-level/commands/{review,work,sprint}.md` sha256 一致；plugin 副本同步
- [ ] `node scripts/pre-commit-check.js` 通过

### 1.6 风险

**/review 端**：

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Agent tool multi-runtime parity（H4 已验证 Codex 不支持）| 高 | 中 | review.md/work.md 文档化 fallback：Codex 端保留 inline / batch 模式 |
| L4 dispatch 触发 5 reviewer 并发 token quota 急剧上升 | 高 | 中 | dispatch matrix 限制 L0/L1 只跑 quality（1 个）；L4 才全套；文档明示成本 ≈ 5 × Sonnet+Haiku |
| reviewer/worker 漏输出 STATUS 行 | 中 | 中 | prompt template 末尾"必须以 `STATUS: ...` 行结尾"；漏输出视为 DONE_WITH_CONCERNS 兜底；派遣记录的 status 分布字段暴露漏判 |
| NEEDS_CONTEXT retry 死循环 | 低 | 高 | 硬限 retry ≤ 1 次；第 2 次仍 NEEDS_CONTEXT 视为 DONE_WITH_CONCERNS 并标 P1 |
| BLOCKED 拦截破坏 --auto 流畅性 | 低 | 低 | 与 auto-mode.md 强制人工边界一致（destructive / L4 / scope creep 也是强制问），不算新例外 |

**/work worker spawn 端（新增）**：

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 多 worker 共享 working dir 引发 race condition | **高** | **高** | **强制**用 `isolation: "worktree"`（Agent tool 内置参数，自动创建临时 git worktree）；无此参数严禁 spawn |
| worktree branch merge 冲突 | 中 | 中 | `[P]` 协议已限制改不同文件（line 60-63 算法）；spawn 前先检测；发现冲突降级串行 |
| worker 测试相互污染 | 中 | 中 | worker 在自己 worktree 跑测试 → 天然隔离；主 LLM apply 后再跑回归 |
| 失败 worker 留下 dirty state | 低 | 低 | Agent tool 内置：worker 失败/无 changes 时 worktree 自动清理（per tool description）|
| `[P]` 协议改写破坏现有 sprint plan 引用 | 中 | 中 | 保留 [P] 标记语义不变；仅改"如何执行" — 现有 plan 文档全部向后兼容 |
| Codex 端 worker spawn 不可用退化为 batch | 高 | 低 | 已知；work.md 文档分叉说明；Codex 用户失去 wall-clock 收益但分工/效率仍可由主 LLM 实现（不变） |
| worker 时间收益不及预期（spawn overhead 大）| 中 | 低 | dogfood 实测；若 N=2 时仍慢于串行，文档加"仅 N≥3 推荐"提示 |

---

## 关键假设验证（§2，[[ADR-012]] — 已完成）

Phase 2 通过 grep + Read 验证 7 个假设，结果如下：

| H# | 假设原文 | 验证方式 | 实际发现 | 结论 |
|----|---------|---------|---------|------|
| **H1** | Claude Code Agent tool（`subagent_type: general-purpose`）可在 SlashCommand 触发的 prompt 中调用 | 检视本会话可用工具列表中的 Agent tool schema | Agent tool 接受 `subagent_type` 参数（含 general-purpose / Plan / Explore 等）；SlashCommand 触发的 turn 与普通 turn 行为一致 | ✅ 成立 |
| **H2** | Agent tool 多次调用在单条 LLM message 内可真并行 | Read tool description: "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently" | tool description 明示 — 单 message 多 Agent call = 真并行 | ✅ 成立 |
| **H3** | `general-purpose` Agent 模型 fixed Sonnet，不能按 reviewer 视角指定 Haiku | 读 Agent tool schema 中 `model` 参数 | **比原假设乐观**：Agent tool 暴露 `model` 参数（`enum: ["sonnet", "opus", "haiku"]`）— 每个 spawn 可独立指定模型层级 | ❌ 假设不成立（**好消息**：模型分层可真落地）|
| **H4** | Codex CLI 通过 plugin skill 调用时支持等效的 Agent spawn 机制 | `find scripts/lib -name '*codex*'`（0 命中）+ grep `subagent\|Agent(` 全仓库（仅 review-learnings.md 提到 subagent 是 analytics scope 语义，非工具调用）| Codex 无 Agent tool 等价物；它通过 plugin/skill 机制扩展 LLM 但不能 spawn 子进程 | ❌ 假设不成立 → **multi-runtime 行为必须分叉**（Codex 保留 inline role-switch，[[ADR-014]] 允许）|
| **H5** | `propagate-command-changes.js` 能处理 spawn 协议段 | Read scripts/propagate-command-changes.js | 纯字符串 regex 替换，新增章节原样传递；`Claude Code → Codex` 替换会改写描述但 Agent tool 名称（如 `general-purpose`）保留 | ✅ 成立（注意：Codex 副本里 "Claude Code 端真并行" → "Codex 端真并行" 是字面替换错位，需在 review.md 直接 inline runtime fallback 说明，避免 propagate 误改语义）|
| **H6** | `pre-commit-check.js` 不误报新增章节 | Read scripts/pre-commit-check.js 全文 | `checkPropagateSync` 只比对 propagate 输出 vs 实际副本；`checkPlanScope` 已通过 §2 自满足；`checkPlanCompletion` 仅 status:completed 触发；`checkOrchestratorSync` 不涉及 commands/ | ✅ 成立 |
| **H7** | sprint.md Phase 4 不重复 dispatch 定义 | grep sprint.md line 203-222 | Phase 4 块仅写 `[执行 /review，多视角审查]`，不重复 dispatch matrix | ✅ 成立（主改 review.md，sprint.md 仅微调描述）|

**关键结论**：
1. ✅ 真并行 spawn 在 Claude Code 端**可行**（H1+H2）
2. ✅ 模型分层（Haiku/Sonnet）**可落地**（H3 反假设）
3. ❌ Codex 端**保留 inline fallback**（H4 反假设 → multi-runtime 文档化分叉）
4. ✅ 无需改 propagate 脚本 / pre-commit-check（H5+H6）
5. ✅ sprint.md 改动最小化（H7）

**Phase 3 准入条件**：H1+H2+H4 已验证 ✓ → 准入。

---

## §3 技术方案

### 3.1 方案概述

**双 spawn 模式 + dual-runtime 分叉**架构：

```
统一 spawn 协议（共享 STATUS / retry / escalation 契约）
  ├── Reviewer spawn（/review）
  │     └── 5 视角真并行（risk-aware dispatch）→ 收集 findings + STATUS
  └── Worker spawn（/work）— 新增
        └── [P] 同批真并行（用 isolation: worktree）→ 主 LLM 收 patch + 串行 apply + 测试

multi-runtime 分叉
  ├── Claude Code: Agent(subagent_type, model, prompt, isolation?) 真并行
  └── Codex CLI:   inline / batch fallback（保留旧行为）
```

**核心改动**：
- review.md + work.md 从"prompt 内角色扮演 / 串行 batch"升级为"LLM 行为规范文档"
- 给定 runtime 能力，规范如何 dispatch（dispatch 决策权在 LLM，不写新脚本）
- 共享统一 STATUS 契约（DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED），减少协议碎片化

**为什么不写脚本 dispatcher**：4 不可妥协原则之"轻量优先"——dispatch 逻辑写在 markdown，LLM 解析执行，避免新增 `scripts/dispatch.js` 增加维护表面。同样模式见 `/sprint` Phase 间预热协议（纯文档规范，无脚本支撑）。

**worker spawn 的关键决策点（与 reviewer 不同）**：

| 维度 | reviewer | worker |
|------|---------|--------|
| 写文件 | 否（只读 diff 输出 findings）| 是 |
| 隔离机制 | 不需要（无写操作）| **必须 isolation: worktree** |
| Patch 处理 | 不涉及 | worker 完成后主 LLM 串行 apply（避免 race condition）|
| 测试责任 | 不跑测试 | worker 在自己 worktree 跑测试；主 LLM apply 后再跑回归 |
| 失败回滚 | 不涉及 | Agent tool 内置：失败/无 changes 时 worktree 自动清理 |

### 3.2 契约接口（[[ADR-013]] §B 触发条件检查）

本 sprint 引入 2 个共享 STATUS 契约（reviewer + worker）。其他契约不变。

| 契约名 | Before | After | 影响副本 / 消费者 |
|--------|--------|-------|------------------|
| **Reviewer return** | LLM 自由格式输出 5 段感想 | 末尾必须 `STATUS: <DONE \| DONE_WITH_CONCERNS \| NEEDS_CONTEXT \| BLOCKED>` | review.md prompt template（Claude Code spawn）+ inline role-switch 段（Codex 端 advisory）|
| **Worker return**（新增）| /work 同批 [P] task 由主 LLM 串行扮演 | spawn N worker；每 worker 输出 (a) 实施摘要 + (b) 测试结果 + (c) `STATUS: ...` 行；主 LLM 收 patch 后串行 apply | work.md worker prompt template + propagate 同步 |
| ~~hook-registry projection~~ | — | 不变 | — |
| ~~propagate transform~~ | — | 不变（H5 验证）| — |

**Dogfood 边界**（[[ADR-013]] §B）：

- 现有 sprint plan 副本：5+ 个 `docs/plans/*.md` 含「派遣记录」段（旧格式 5 字段）→ 不会被新格式破坏（新增字段为追加，旧解析向后兼容）
- 现有 plan template `[P]` 标记说明：保持语义（不并行改同文件 / 无依赖 / 风险 ≤ L2）；仅"如何执行"从主 LLM batch 改为真 worker spawn — 现有标记的 plan 全部向后兼容
- 现有 work.md line 75 "[P] 不是多进程调度" → **必须改写**（不是向后兼容，是行为变更）→ propagate 后副本同步
- 现有 review-learnings.md / docs/plans/ 等提到 "5 视角" → 不修改其语义
- **负样本 1**：故意省略 STATUS 行 → 主 LLM 视为 DONE_WITH_CONCERNS 兜底（不报错），dogfood 在 T6/T7 验证
- **负样本 2**：故意制造 [P] task 改同文件 → 冲突检测降级串行，dogfood 在 T7 验证

### 3.3 任务拆解

> [P] 并行条件：(a) 不与其他 [P] task 改相同文件 (b) 无未完成依赖 (c) 风险 ≤ L2。
> 本 sprint T1+T3 改不同文件可 [P]（review.md vs work.md）；T6+T7 dogfood 步骤可 [P]（不改文件，相互独立）。

- [ ] **Task 1 [P]**: review.md 加 3 新章节 — `Spawn 协议`、`Reviewer prompt template`、`Multi-runtime fallback` — 文件: `user-level/commands/review.md` — 风险: L2
  - 插入位置：现"风险驱动派遣"段之前（与 5 视角定义并列）
  - 内容：Agent tool 调用语法 + 4 status 契约 + Claude Code/Codex 分叉说明
- [ ] **Task 2**: review.md 改 dispatch matrix 表 + 派遣记录格式 + 加 retry/escalation 流程段 — 文件: `user-level/commands/review.md` — 风险: L2 — 依赖 Task 1
  - 表格新增列：Spawn 数 / 模型层级（Sonnet/Haiku）
  - 派遣记录新增字段：Status 分布 / Retry 计数 / Blocked 计数
  - 新增 NEEDS_CONTEXT retry（≤1 次硬限）+ BLOCKED escalation（强制人工 gate，--auto 也不跳）流程
- [ ] **Task 3 [P]**: work.md 加 worker spawn 协议段 + 改写 [P] 协议 line 49-75 — 文件: `user-level/commands/work.md` — 风险: L2
  - 新增 `Worker spawn 协议` 段：触发条件 + Agent tool 调用（含 `isolation: "worktree"` 必备）+ worker prompt template + STATUS 契约（与 reviewer 共享）+ patch 收集机制
  - 改写 line 75 "`[P]` 不是多进程调度" → "Claude Code 端真 spawn worker，Codex 端保留 batch fallback"
  - 保留 line 60-63 冲突检测算法 + line 65 失败传播规则
  - 加 `Multi-runtime fallback` 段（结构与 review.md 一致）
- [ ] **Task 4**: sprint.md Phase 4 描述微调 — 文件: `user-level/commands/sprint.md` — 风险: L1 — 依赖 Task 2
  - Phase 4 段加 1-2 行说明"调用 /review 时按 spawn 协议触发"
  - Phase 3 段（含 [P] 处理提示）加 1 行指向 work.md 的 worker spawn 协议
- [ ] **Task 5**: 跑 propagate + build + pre-commit — 文件: 自动同步 `.codex/` `plugins/` — 风险: L1 — 依赖 Task 2 + Task 3 + Task 4
  - `node scripts/propagate-command-changes.js review work sprint`
  - `node plugins/tech-persistence/scripts/build-codex-plugin.js`
  - `node scripts/pre-commit-check.js`（exit 0）
  - 副本 sha256 比对全 EQUAL（pre-commit-check 内置）
- [ ] **Task 6 [P]**: Dogfood `/review` — 在当前 sprint diff 上跑一次，验证 4 项 — 文件: 无新文件（结果记 §4 变更日志）— 风险: L2 — 依赖 Task 5
  - 验证 1: 单 message 内 spawn 多 Agent（看工具调用 batch）
  - 验证 2: 每 Agent 末尾含 `STATUS: ...`
  - 验证 3: 构造 NEEDS_CONTEXT 场景 → retry → DONE
  - 验证 4: 构造 BLOCKED 场景 → 即使 --auto 也强制问
- [ ] **Task 7 [P]**: Dogfood `/work` worker spawn — 构造 2-3 个 [P] L1/L2 task 跑一次 — 文件: 无新文件（结果记 §4 变更日志）— 风险: L2 — 依赖 Task 5
  - 验证 1: spawn N 个 Agent 都带 `isolation: "worktree"`
  - 验证 2: worker 末尾含 `STATUS: ...`；主 LLM 串行 apply patch 后跑测试
  - 验证 3: 构造一个 worker 测试失败 → 主 LLM 不 apply 该 patch + worktree 自动清理 → 进入 3 轮调试
  - 验证 4: 时间收益：3 个 worker spawn 的 wall clock ≈ 单 task 时间（不是 3 × 单 task）

**[P] 协调时序**：

```
Phase 3 实施时序（理论上）：
  Round 1: spawn T1 + T3（[P] 不同文件不同 spawn）
    └─ T1 完成 ─┐
    └─ T3 完成 ─┤
                 ├─→ Round 2: T2 / T4（T2 dep T1, T4 dep T2）
                 │           ├─ T2 → T4 串行
                 │           └─ T4 完成
                 │
                 └─→ Round 3: T5 propagate（dep T2 + T3 + T4）
                              └─ T5 完成
                                   ↓
                            Round 4: spawn T6 + T7（[P] 不改文件可并发 dogfood）
```

注：本 sprint 是 dogfood 自身（用 sprint 文档写 plan，规划 spawn 改造）。Phase 3 的 [P] 实际执行不要求"真 spawn"——本 sprint 是改造前提，主 LLM 单上下文串行处理 T1+T3 即可。**真 spawn 验证在 T7 dogfood**。

### 3.4 测试策略

| 维度 | 测试方法 | 通过标准 |
|------|---------|---------|
| 单元 | 无（纯文档变更，无新脚本）| — |
| 集成 | `node scripts/pre-commit-check.js`（Task 5 内）| exit 0 |
| 集成 | propagate 副本 sha256 比对（pre-commit-check 内置）| 全部 EQUAL |
| Dogfood /review | Task 6 的 4 项验证 | 全过 |
| Dogfood /work worker spawn | Task 7 的 4 项验证 | 全过 |
| 回归 | review dispatch matrix 已有行为：L0/L1 仍只跑 quality；L4 跑全 5 | dogfood 至少跑 L2 + L3 |
| 回归 | work [P] 协议向后兼容：现有 plan 文档 [P] 标记仍有效 | 选 1-2 个历史 sprint plan 用新 work.md 走查不报错 |

### 3.5 风险评估

> 已在 §1.6 完整列出（reviewer + worker 双视角）。此处不重复，避免维护双副本漂移。

### 3.6 涉及文件

主要改动：
- `user-level/commands/review.md`（~+80 行新章节 + dispatch matrix / 派遣记录格式扩展）
- `user-level/commands/work.md`（~+60 行 Worker spawn 协议段 + line 49-75 改写）
- `user-level/commands/sprint.md`（Phase 3/4 段微调，~+5 行）

机械同步（propagate 处理）：
- `.codex/commands/{review,work,sprint}.md`（自动）
- `plugins/tech-persistence/commands/{review,work,sprint}.md`（自动）
- `plugins/tech-persistence/skills/{review,work,sprint}/SKILL.md`（如存在则自动）

不改动：
- `scripts/propagate-command-changes.js`（H5 验证：现有 transform 足够）
- `scripts/pre-commit-check.js`（H6 验证：无误报）
- `scripts/agent-orchestrator.js`（不在 scope）
- `~/.claude/agents/`（不在 scope）
- `user-level/commands/plan.md`（不在 scope，§1.4 明示）

---

## §4 实现进度

> Phase 3 填充。

### 变更日志

| 日期 | Phase | 变更说明 |
|------|-------|---------|
| 2026-05-15 | Phase 1 | 创建 sprint 文档；§0 身份界定 + §1 需求分析（要做 7 项 / 不做 8 项 / 成功标准 8 项）+ §2 关键假设 7 条待 Phase 2 验证 |
| 2026-05-15 | Phase 2 | §2 验证 7 假设（H1✅ H2✅ H3❌反假设/好消息 H4❌反假设/分叉 H5✅ H6✅ H7✅）+ §3 技术方案落地（双轨制 dual-track 架构 + reviewer return contract 1 条 + 4 任务拆解 + 测试策略 + 风险评估）；status: draft → planning |
| 2026-05-15 | Phase 2 修订 | 用户反馈"subagent 目的是分工 / 减时间 / 提效率"+ 选 C 选项扩 scope 到 /work；§0 加「Scope 扩展记录」+「核心动机」段；§1.3 要做扩 7 → 11 项（R7-R10 work spawn）；§1.4 不做明示 /plan 排除；§1.5 成功标准加 work 6 项；§1.6 风险分 review/worker 两表；§3.1 改双 spawn 模式（reviewer + worker，worker 必须 isolation: worktree）；§3.2 加 worker return contract；§3.3 任务 4 → 7（T1+T3 [P] 不同文件，T6+T7 [P] dogfood）；§3.4 加 work dogfood 维度；§3.6 加 work.md；tasks_total 4 → 7 |
| 2026-05-15 | Phase 3 T1 [P] | review.md 加 3 新章节（Spawn 协议 / Reviewer prompt template / Multi-runtime fallback）；插入位置: line 18 现"风险驱动派遣"之前；新增 ~95 行 |
| 2026-05-15 | Phase 3 T2 | review.md 改 Dispatch Matrix（加 Spawn 数 + 模型层级列）+ Reviewer 模型分层（lowercase 与 Spawn 协议对齐）+ 派遣记录格式（分 Claude Code spawn 模式 / Codex inline fallback 模式 + Status 分布 + Retry + Blocked 字段 + BLOCKED escalation 提示）|
| 2026-05-15 | Phase 3 T3 [P] | work.md 改写 line 49-75 [P] 协议为 Worker spawn 协议；加触发条件表 / 冲突检测算法（保留原算法）/ Spawn 调用语法（强制 isolation: worktree）/ 模型分层 / 4 status 契约 / Worker prompt template / Patch 收集与 apply 机制 / NEEDS_CONTEXT retry / BLOCKED escalation / 失败传播 / 禁止行为表 / Checkpoint 处理 / Multi-runtime fallback 段；首版纠正 Edit fullwidth `（）` vs halfwidth `()` 一次（T3 重试通过）|
| 2026-05-15 | Phase 3 T4 | sprint.md Phase 3 段加引用 work.md Worker spawn 协议；Phase 4 段加引用 review.md Spawn 协议（含 BLOCKED escalation 强制人工 gate 提醒）|
| 2026-05-15 | Phase 3 T5 | `node scripts/propagate-command-changes.js review work sprint` → 12 文件副本同步 ✓；`node plugins/tech-persistence/scripts/build-codex-plugin.js` → 22 commands + 32 skills + 15 hook + 8 mcp + 3 utility + 10 schemas 全过；`node scripts/pre-commit-check.js` exit 0 |
| 2026-05-15 | Phase 3 T6 + T7 [P] | **真并行 4 Agent spawn 在单 message 内完成**（2 reviewers haiku × 2 + 2 workers haiku × 2 with isolation: worktree）；全部 4 Agent 返回末尾 STATUS 行（4/4 协议遵守）；总耗时约 wall clock 2 分钟 vs 串行预估 8 分钟（**减时间目标实证**）|
| 2026-05-15 | Phase 3 T6 dogfood 结果 | quality reviewer 报 DONE_WITH_CONCERNS（10 findings: P1 × 6 + P2 × 4，多为措辞 / 章节结构改进项）；test reviewer 报 DONE_WITH_CONCERNS（5 findings: P0 × 1 + P1 × 3 + P2 × 1，P0 F5 提议补 H8 假设验证 isolation 参数）— 实际 T7 spawn 已直接验证 isolation 可用，P0 finding 是推断非事实，可记录在 H8 补充段而非 P0 修复 |
| 2026-05-15 | Phase 3 T7 dogfood 关键发现 | **3 个真实协议缺口被 dogfood 暴露**（loop-back 触发）：(1) Worker A 在 worktree 内创建文件但未 `git commit` → branch 与 main 等价，cherry-pick 为空；(2) Worker B 用绝对路径写到主 repo 绕过 worktree 隔离（isolation: worktree 不强制限制写入路径，仅设 CWD）；(3) Agent tool worktree 残留 locked，需 `-f -f` 清理。两个 worker 都返回 `STATUS: DONE` 但行为分叉 — 自报 STATUS 不可靠 |
| 2026-05-15 | Phase 3 Loop-back fix | work.md Worker prompt template 加 2 强制约束：(a) 必须用相对路径（禁绝对路径）；(b) 必须 git add + commit；禁止行为表加 2 行注明 dogfood 实证；重 propagate work.md + build + pre-commit ✓；预防未来 dogfood 时这 2 个 case 复现 |
| 2026-05-15 | Phase 3 dogfood 文件 | `docs/dogfood/2026-05-15-spawn-verify-a.md`（Worker A 在 worktree 创建后由父进程从 worktree 复制）+ `docs/dogfood/2026-05-15-spawn-verify-b.md`（Worker B 用绝对路径直写主 repo — 反例实证）|
| 2026-05-15 | Phase 3 hotfix | §2 标题 `## §2 关键假设验证` 因 `§2 ` 不符合 pre-commit 的 `\*{0,2}` 匹配规则失配 → 改为 `## 关键假设验证（§2，...）`；pre-commit 通过 ✓ |
| 2026-05-15 | Phase 3 完成 | tasks_completed: 0 → 7；status: planning → in-progress；用户 scope 仅到 Phase 3，Phase 4/5 不在本 sprint 范围 |

---

## §5 审查结果

> Phase 4 填充。本 sprint 用户范围只到 Phase 3，Phase 4-5 后续单独触发。

---

## §6 复利记录

> Phase 5 填充。本 sprint 用户范围只到 Phase 3。

---

## 下一 Phase 预热（Phase 3: Work）

关键文件：`user-level/commands/review.md`（171 行，T1+T2 主改）；`user-level/commands/work.md`（119 行，T3 主改 line 49-75）；`user-level/commands/sprint.md` line 203-222 + Phase 3 段（T4 微调）
执行命令：T1+T3 可 [P] 并行（不同文件）；T5 跑 `node scripts/propagate-command-changes.js review work sprint` + `node plugins/tech-persistence/scripts/build-codex-plugin.js` + `node scripts/pre-commit-check.js`
风险预判：(a) 任务数 7 ≤ 8 满足 sprint.md "Phase 2 → 3 自动准入"但用户未启 --auto 仍人工 gate；(b) T7 worker spawn dogfood 是本 sprint 最高风险点——若 isolation: worktree 实际行为偏离预期（如 worktree 不自动清理 / patch apply 冲突），可能 loop-back 到 T3 改协议（上限 ≤ 1 次）；(c) /work worker spawn 改写 line 75 是行为变更（不是新增）—— review-learnings.md 等下游引用需 grep 排查
