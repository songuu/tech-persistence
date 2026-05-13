---
title: "gstack 最新功能扫描与本项目可优化点分析"
type: sprint
status: completed
created: "2026-05-12"
updated: "2026-05-13"
checkpoints: 0
tasks_total: 8
tasks_completed: 8
adr_emitted: none (ADR-014 deferred to N≥3)
phase4_findings: 6 P0 / 6 P1 / 3 P2
phase4_reframe: path-2 product-lens reframe applied
reviewers: coherence, scope-guardian, product-lens, adversarial
tags: [sprint, research, architecture, sibling-evaluation, gstack]
aliases: ["gstack-latest-scan", "gstack-analysis-2"]
---

# gstack 最新功能扫描与本项目可优化点分析

> **Status:** `completed`
> **Created:** 2026-05-12
> **Updated:** 2026-05-13

---

## 需求分析

### 背景

本项目 `tech-persistence` 早期已吸收 **gstack** 的「角色分工」作为方法论之一（`CLAUDE.md` 顶部明示 "gstack 的角色分工"，think/plan/work/review/compound 五阶段即为该吸收的产物）。同作者 Garry Tan 持续在维护 gstack，并新增了多项**架构级**特性。

与 2026-05-11 `gbrain-gstack-analysis` sprint 的区别：
- 上次 sprint 评估 **gbrain**（未吸收的 sibling 知识脑项目）→ 输出 ADR-011 identity-question-first 原则
- 本 sprint 评估 **gstack**（已部分吸收的方法论源头）→ 看 **diff vs 当前吸收态**

### 本 sprint 回答的核心问题

> 1. gstack 当前态相对本项目当前吸收态，**有哪些新增的架构思想 / 命令族 / 工作流位移**？
> 2. 这些新东西里，哪些应该 **补吸收** / **部分借鉴** / **显式拒绝**？
> 3. 同时反向看：本项目自身当前实现，有哪些**不依赖 gstack** 也成立的优化点？
> 4. 如果今天只能动一件事，**最小动作**是什么？

### 已抓取的 gstack 当前态证据（Phase 1 取证）

来自 `https://github.com/garrytan/gstack` README + CLAUDE.md WebFetch（2026-05-12）：

**gstack 当前关键特性集：**

| # | 特性 | gstack 出处 |
|---|------|------------|
| G1 | **Sprint 7-phase**: Think→Plan→Build→Review→Test→Ship→Reflect | README 节"Notable Workflow Features" |
| G2 | **多角色 reviewer 命令族**：`/plan-ceo-review` / `/plan-design-review` / `/plan-eng-review` / `/plan-devex-review` | README "Planning & Strategy" + CLAUDE.md "Role-Based Personas" |
| G3 | **/autoplan 串联 CEO→design→eng 顺序审查** | CLAUDE.md "Sub-Agents & Parallel Capability" |
| G4 | **多层测试管道 cost-tiered**（Free `bun test` / Paid `test:evals` / Gate / Periodic） | CLAUDE.md "Overall Workflow Phases" |
| G5 | **/ship 编排 release**（review readiness / version bump / CHANGELOG 写产品语调 / deploy） | CLAUDE.md "/ship orchestrates final release" |
| G6 | **行为约束命令族**：`/freeze` / `/guard` / `/careful` | README "Safety & Tools" |
| G7 | **Skill validation gate**（commit/CI 强制 skill 文档 + 模板一致） | CLAUDE.md "Skill validation + doc regeneration" + "Merge conflict guard on SKILL.md" |
| G8 | **Compiled binaries guard**：禁止 `git add .` / 强制 stage explicitly | CLAUDE.md "NEVER commit browse/dist/ or design/dist/" |
| G9 | **E2E attribution guard**：claim "失败是 pre-existing" 前必须在 main 上跑一次 | CLAUDE.md "run the same eval on main and show it fails there too" |
| G10 | **Continuous checkpoint mode**（auto-commit + 结构化 context） | README "Continuous checkpoint mode for auto-committing work" |
| G11 | **Domain skills**（per-site 持久 agent notes） | README "Domain skills for per-site agent notes" |
| G12 | **Parallel sprint management 10-15 concurrent CC sessions** | README "Parallel sprint management" |
| G13 | **GBrain integration** `/setup-gbrain` `/sync-gbrain`（持久知识库） | README "GBrain integration" |
| G14 | **/codex 多 AI 审计命令** | README "Specialized agents: /codex (multi-AI audit)" |
| G15 | **Prompt-injection L1-L6 防御**（browser 场景，datamarking → ONNX classifier → ensemble） | CLAUDE.md "Security stack (layered prompt-injection defense)" |
| G16 | **GStack Browser + Raw CDP escape hatch** | README "Raw CDP escape hatch" |
| G17 | **/pair-agent cross-agent browser sharing** | README "Multi-AI coordination" |
| G18 | **Voice input + natural trigger phrases** | README "Voice input compatible with natural trigger phrases" |

本项目当前态对照（来自 `user-level/commands/` 21 个文件）：

`agent-loop / checkpoint / compound / evolve / instinct-{export,import,status} / learn / plan / prototype / review / review-learnings / session-summary / skill-{diagnose,eval,improve,publish} / sprint / test / think / work`

### 要做

1. **gstack 候选清单**：从上 18 项中收敛 6-10 个**架构级**候选（不是功能列表），每个给：底层抽象 + gstack 引用 + 本项目对照点 + 吸收度标签（✅/🟡/⬜）+ 采纳定级（🟢/🟡/🔴）+ ≥1 反方理由
2. **内省维度可优化点 ≥ 3 条**：不依赖 gstack 也成立，每条带：现状证据（文件:行）+ 建议动作 + 维护表面增量估算
3. **ROI 前 3 + 显式拒绝 ≥ 2**：按 5 年杠杆 / 维护表面增量评，**不按**人天/速胜
4. **三问作答**：最值得补 / 最该拒 / 最小动作
5. Phase 4 必须 spawn ≥ 1 个 product-lens reviewer（ADR-011 强制）

### 不做

- **不**实施任何方案（研究 sprint，纯输出文档）
- **不**机械抄 skill 数 / command 数
- **不**重复 gstack vs gbrain 对比（前 sprint 已覆盖 gbrain）
- **不**为追求"全面"罗列 gstack 细节
- **不**动 CLAUDE.md / install / orchestrator 代码

### 成功标准

- [ ] gstack 候选 6-10 个，每个 6 字段齐全（含反方理由）
- [ ] 内省维度可优化点 ≥ 3 条，每条 3 字段齐全
- [ ] ROI 排序前 3 + 显式拒绝 ≥ 2
- [ ] 三问明确作答
- [ ] Phase 4 reviewer 数 ≥ 4（含至少 1 个 product-lens）
- [ ] frontmatter 含 `phase4_findings` / `adr_emitted`（若有）字段

### 风险与假设

| # | 内容 | 缓解 |
|---|------|------|
| R1 | "已吸收"判断错误 → 重复推荐已有功能 | Task 2 强制每个 ✅ 附本项目对应文件路径 |
| R2 | 把"功能"误当架构 | 每个候选必须能用 1 句话描述底层抽象（"X 是关于 Y 的取向"） |
| R3 | 内省维度沦为通用感叹 | 每条强制配现状证据（文件:行）+ 维护表面增量估算 |
| R4 | gstack 与本项目 scope 不重叠的内容被误推荐（如 browser stack） | Phase 2 设硬性 scope 过滤：browser / voice / deploy / parallel-sessions 直接归 🔴 显式拒绝 |
| R5 | 候选膨胀（gbrain sprint 12 个偏多） | 总条目 ≤ 13（gstack 候选 ≤ 10 + 内省 ≤ 5） |
| A1 | gstack repo 公开可访问 | ✅ Phase 1 已 WebFetch 验证 |
| A2 | 本项目已吸收"角色分工"出自 gstack | ✅ CLAUDE.md 顶部明示 |
| A3 | 用户目的是"看清值得做什么 / 不做什么"非"立刻动手" | 本 sprint 不进实现 |

### 关键假设验证（ADR-012）

| 假设 | 验证方法 | 状态 |
|------|---------|------|
| gstack repo URL 可访问 | WebFetch | ✅ Phase 1 通过 |
| 本项目当前 commands/ 文件清单 | `ls user-level/commands/` | ✅ Phase 1 通过（21 个文件） |
| 本项目当前 review 是多视角并行 | grep `review.md` + Memory 中 `parallel_review_agents` 本能 | ✅ Memory v5 confirmed |
| gstack 的 7-phase sprint 真实存在（vs 我们 5-phase） | WebFetch README 节"Notable Workflow Features" 确认 | ✅ Phase 1 通过 |
| gstack `/freeze /guard /careful` 真存在 | WebFetch README "Safety & Tools" 节确认 | ✅ Phase 1 通过 |

---

## 技术方案

### 方案概述

研究类 sprint，6 个 Task 完成"取证 → 映射 → 定级 → 内省 → 收敛 → 收尾"。无代码改动，全部产出落在本文档不同段落。Phase 4 多 reviewer 交叉审查避免 sibling-evaluation 偏见，特别是 product-lens（ADR-011）和 adversarial（sibling-evaluation 大风险）。

### 任务拆解

- [x] **Task 1 — gstack 候选源码取证**（L1，30 min）
  - 抓 gstack 几个关键 command 源文件（`/autoplan` / `/ship` / `/freeze` / `/guard` / `/careful`）的真实内容，不止 README 摘要
  - 文件：本文档 `## 候选取证` 段
  - 产出：每个候选附 ≥1 行 gstack 真实命令文件路径或 README 引用

- [x] **Task 2 — 本项目当前态映射 + 吸收度标签**（L1，20 min）
  - 对 18 个 gstack 特性逐个 grep 本项目 `user-level/commands/*.md` 和 `.claude/rules/*.md`
  - 每个标 ✅已吸收 / 🟡部分吸收 / ⬜未吸收
  - 文件：本文档 `## 吸收度对照表` 段
  - 依赖 Task 1

- [x] **Task 3 — 候选三档定级 + 反方理由**（L2，40 min）
  - 收敛到 6-10 个架构级候选（剔除明显 scope 外如 browser / voice / parallel-sessions）
  - 每个标 🟢建议补吸收 / 🟡部分借鉴 / 🔴显式拒绝
  - 每条强制写反方理由（即使是 🟢 也写"不做的理由"）
  - 显式与 4 条不可妥协原则对照（多运行时 parity / 确定性 / 轻量 / Obsidian 兼容）
  - 文件：本文档 `## 候选定级` 段
  - 依赖 Task 2

- [x] **Task 4 — 内省维度可优化点**（L2，30 min）
  - 来源（不依赖 gstack 也成立）：
    - 近期 sprint 文档（特别 `2026-05-12-agent-loop-followup-audit.md`「still-open」项）
    - `debugging-gotchas.md` 中 HIGH 级未关闭项
    - ADR-012/013 是否真转 mechanism（pre-commit-check 覆盖度）
    - Phase 间预热协议落地度（grep 近 5 个 sprint 文档是否真有预热段）
    - sprint workflow 中退化信号检测的实际触发证据
  - ≥ 3 条，每条：现状证据（文件:行）+ 建议动作 + 维护表面增量估算
  - 文件：本文档 `## 内省维度可优化点` 段

- [x] **Task 5 — ROI 排序 + 显式拒绝**（L2，20 min）
  - 跨 Task 3（gstack 候选）+ Task 4（内省）的所有 🟢 / 🟡 候选统一 ROI 排序
  - 按 5 年杠杆 / 维护表面增量（**不按**人天）
  - 输出 ROI 前 3 + 显式拒绝 ≥ 2
  - 文件：本文档 `## ROI 排序与显式拒绝` 段
  - 依赖 Task 3 + Task 4

- [x] **Task 6 — 三问作答 + ADR 候选 + 文档收尾**（L1，15 min）
  - 三问：最值得补 / 最该拒 / 最小动作（必须三句话内回答完）
  - 若本 sprint 涌现新原则 → 草拟 ADR-014 候选（不入正式 rules，留 Phase 5 compound 决定）
  - status: planning → reviewing
  - 文件：本文档 `## 三问作答` + `## ADR 候选`
  - 依赖 Task 5

- [x] **Task 7 — 21 命令使用率审计**（L2，30 min，Phase 4 reviewer 反馈后新增）
  - 数据源：`observations.jsonl`（4-hook 系统产出）+ git log + docs/plans/docs/solutions 提及次数 proxy
  - 识别"已建未用"命令清单
  - 文件：本文档 `## 21 命令使用率审计` 段
  - 触发：path-2 reframe / product-lens F2/F3/F5

- [x] **Task 8 — Positioning 决策**（L1，20 min，Phase 4 reviewer 反馈后新增）
  - gstack N=23→30+ 移动方向 vs 本项目 N=21 当前定位
  - 是否跟随、部分跟随、完全分叉
  - 文件：本文档 `## Positioning 决策` 段
  - 触发：path-2 reframe / product-lens F1/F5

### 测试策略

研究类 sprint 无自动化测试。验证策略：
- **可重现性**：所有 gstack 引用必须有具体 URL / 文件路径 / README 段落（非凭记忆）
- **反偏见**：Phase 4 强制 ≥ 1 个 adversarial + 1 个 product-lens reviewer
- **scope 守门**：每个 🟢 候选必须明示**违反**哪 4 条不可妥协原则中的几条（若违反 ≥ 1，必须降级 🟡 或 🔴）

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 偏见污染（同作者光环） | M | H | Phase 4 adversarial reviewer + 强制反方理由 |
| 候选过多 | M | M | 硬上限 13 条（10+3）；Task 3 / Task 4 各设条数硬上限 |
| Scope drift（browser / voice 误推荐） | L | M | Task 3 设硬过滤规则 |
| 内省维度沦为感叹 | M | M | 强制证据驱动（文件:行）|
| ADR 滥发（每 sibling sprint 一条 ADR） | M | L | ADR 候选仅在 Phase 5 compound 决定是否落地 |

### 涉及文件

仅修改：`docs/plans/2026-05-12-gstack-latest-analysis.md`（本文档）

Phase 5 可能新增（视 Task 6 输出）：
- `.claude/rules/architecture.md`（追加 ADR-014）— 仅当 Task 6 确认有新原则涌现
- `docs/solutions/2026-05-12-gstack-latest-sync.md`（解决方案索引）— 仅当用户后续要求实施

---

## 候选取证（Task 1 产出）

来自 `https://github.com/garrytan/gstack` 各 skill `SKILL.md` 直抓（2026-05-12，WebFetch 验证）：

### G1-deep `/autoplan`（深取证）

**底层抽象**：单命令完成"CEO → Design → Eng → DX"四阶段自动 review，每阶段内**两个独立 voices 并行**（Claude subagent + Codex via `codex exec`），输出 consensus table（CONFIRMED / DISAGREE / N/A）。15-30 个中间问题压缩为 2 个 user-facing gate。

关键子机制：

| 子机制 | gstack 实现 | 本项目当前对照 |
|---|---|---|
| **Dual Voices**（双独立模型分析同一物） | 每 review phase 内 subagent + codex 并行 | agent-orchestrator v6 = spec/impl/review **串联**单 voice |
| **6 自动决策启发式** | Completeness / Boil Lakes / Pragmatic / DRY / Explicit / Bias Toward Action | `auto-mode.md` 只有三档矩阵（强制/自动/灰区），无决策启发式 |
| **Mechanical / Taste / User Challenge 三档** | 自动决策时仍区分"显然 vs 合理分歧 vs 反对用户原方向" | auto-mode 三档（永远人工 / 自动通过 / 灰区）— 缺"反对用户原方向"显式概念 |
| **Decision Audit Trail** | markdown table 追加到 plan file（Phase / Decision / Classification / Principle / Rationale / Rejected） | auto-mode 打印 `✓ auto: phase N→N+1` 但**不持久化**到 sprint 文档 |
| **Codex 反 prompt-injection 边界** | 所有 codex 提示前缀 filesystem boundary 阻止 codex 读 skill 定义 | 本项目无此防御（codex 仍可读 `.codex/commands/`） |

### G5-deep `/ship`（深取证）

**底层抽象**：非交互式 release pipeline，20+ 步串联（pre-flight / merge-test / coverage audit / plan completion / pre-landing review / version bump / changelog / push / PR create）。**只有 Eng review 是强制 gate**，CEO/Design/Adversarial 是信息项。

关键子机制（与本项目可关联的）：

| 子机制 | gstack 实现 | 本项目当前对照 |
|---|---|---|
| **Plan completion verification** | 扫 plan file，逐项验证 actionable items 是否真在 diff 中 | sprint Phase 5 compound 检查 checkbox 勾选，但**不验证 diff 中是否真有对应改动** |
| **Coverage audit with override gate** | 60% min / 80% target，未达需 user 显式 override | 本项目按风险等级 L0-L4 决定测试深度，无统一 coverage gate |
| **Idempotent re-run** | 重跑 verify 所有 gate 但跳过已完成动作（如 version bump） | sprint resume 从 checkpoint 恢复，但不验证已完成 Task 的产物是否真存在 |

### G6-deep `/freeze` `/guard` `/careful`（深取证）

**底层抽象**：**pre-tool hook 真做 enforcement**，不是文档协议。

| skill | 拦截目标 | 机制 |
|---|---|---|
| `/careful` | `rm -rf` / `DROP TABLE` / `git push --force` / `git reset --hard` / `kubectl delete` / `docker rm -f` | Bash pre-tool hook 模式匹配 → 返回 "ask" permission decision |
| `/freeze` | Edit / Write 出指定目录 | pre-tool hook 验证 file path 在 allowed dir |
| `/guard` | careful + freeze 组合 | 同上 |

**关键观察**：gstack 显式承认 "this prevents accidental edits, not a security boundary"（bash 可绕过）— 即便如此仍值得做，因为 90% 事故是 accidental。

### G6-context `/cso`（安全审计，深取证）

**底层抽象**：14-phase 安全审计（stack detection / attack surface mapping / secrets archaeology / dependency / CI/CD / webhook / LLM / supply chain / OWASP / STRIDE），8/10 confidence gate（daily 模式）+ 22 hard exclusions（DoS / rate-limiting / test fixtures 自动排除）。

| 子机制 | gstack | 本项目 |
|---|---|---|
| **Attack surface first** | 先列 public endpoints / auth boundaries / file uploads / webhooks | review 视角 1 security 不强制先列 attack surface |
| **22 hard exclusions** | 显式排除已知 noise（DoS 除非 LLM cost / 测试 fixture） | 本项目无 exclusion list，每次 review 容易复现噪音 |
| **Active verification** | 每个 finding trace code path 确认存在 | review P0 也要求验证但无规范 trace 协议 |

### G10-deep `/context-save` `/retro`（持久化与复盘）

| skill | 关键点 | 本项目对照 |
|---|---|---|
| `/context-save` | Append-only（每次 save 新文件，从不 overwrite） | `/checkpoint` 生成 handoff doc，未明示 append-only 但实现上是 `-handoff-{N}.md` 编号，**已是 append-only** ✅ |
| `/retro` | 周/月级 retro + JSON snapshot 到 `.context/retros/` + delta 比较（"Test ratio: 22% → 41% ↑19pp"）+ 跨项目 `/retro global` | `/session-summary` 单 session 摘要，`/review-learnings` 复盘但**无周/月级**、**无 delta 比较**、**无跨项目** |

---

## 吸收度对照表（Task 2 产出）

| # | gstack 特性 | 吸收度 | 本项目对应 |
|---|---|---|---|
| G1 | Sprint 多阶段（gstack: Think→Plan→Build→Review→Test→Ship→Reflect） | 🟡 部分 | `user-level/commands/sprint.md` 5-phase；Test 在 work 内按风险，Ship 不存在（无 deploy），Reflect = compound |
| G2 | 多角色 reviewer 命令族（CEO/design/eng/devex review） | 🟡 部分 | `review.md` 多视角并行（security/perf/arch/quality/test），**缺**产品/设计/devex/CEO 视角；ADR-011 已要求 product-lens 但仅在文档评审 |
| G3 | /autoplan dual voices + 自动决策启发式 + decision audit | ⬜ 未吸收 | `auto-mode.md` 三档矩阵；agent-orchestrator v6 单 voice 串联；无决策审计表 |
| G4 | 多层测试管道 cost-tiered（Free/Paid/Gate/Periodic） | ⬜ 未吸收 | 风险驱动测试深度（L0-L4），按 risk 而非 cost；无 periodic tier |
| G5 | /ship release pipeline + coverage gate + plan completion verify | 🟡 部分 | 无 release（无 deploy）；plan completion 仅勾 checkbox 不验证 diff |
| G6 | /freeze /guard /careful pre-tool enforcement | ⬜ 未吸收 | `auto-mode.md` 纯文档协议，靠模型自律 |
| G7 | Skill validation gate（commit/CI 强制 skill 文档+模板一致） | 🟡 部分 | `/skill-eval` `/skill-diagnose` `/skill-publish` 存在但**无 commit gate enforcement**；`pre-commit-check.js` 只覆盖 plan lint 和 orchestrator sync |
| G8 | Compiled binaries guard（禁止 `git add .`） | 🟡 部分 | debugging-gotchas 记录"已踩 nul 文件 2 次"，但无 hook 拦截 `git add .` |
| G9 | E2E attribution guard（claim "pre-existing" 前先在 main 跑） | ✅ 已吸收同质本能 | `[[documented-claim-vs-code-reality-drift]]` 本能 + `2026-05-12-agent-loop-followup-audit.md` 4 档分类（closed/partial/still-open/wont-fix-now） |
| G10 | Continuous checkpoint + auto-commit | 🟡 部分 | `/checkpoint` 已是 append-only `-handoff-{N}.md`，**无 auto-commit** |
| G11 | Domain skills（per-site agent notes） | ⬜ 未吸收 | Memory v5 `MEMORY.md` + topic files 偏 cross-session 共用，无 domain scope 概念 |
| G12 | Parallel sprint management 10-15 sessions | 🔴 显式拒绝（scope 外） | 违反"轻量"原则，单 sprint 已足够 |
| G13 | GBrain 集成 `/setup-gbrain` `/sync-gbrain` | 🔴 已显式拒绝 | `2026-05-11-gbrain-gstack-analysis.md` ADR-011 拒绝全融入 |
| G14 | /codex 多 AI 审计命令 | 🟡 部分 | agent-orchestrator v6 已支持 claude+codex 串联；非独立 `/codex` 命令但能力存在 |
| G15 | Prompt-injection L1-L6 | 🔴 scope 外 | 非 browser agent toolchain |
| G16 | GStack Browser + Raw CDP | 🔴 scope 外 | 同上 |
| G17 | /pair-agent 跨 agent browser 共享 | 🔴 scope 外 | 同上 |
| G18 | Voice input + natural triggers | 🔴 scope 外 | CLI 工具非 voice agent |
| G-cso | /cso 14-phase 安全审计 + 22 exclusions | 🟡 部分 | review 视角 1 security 存在，深度不及；无 exclusion list |
| G-retro | /retro 周/月级 + JSON snapshot + delta | ⬜ 未吸收 | `/session-summary` 单 session，无周月级 delta |
| G-cs | /context-save append-only | ✅ 已吸收 | `/checkpoint` 同质 |

**收敛**：scope 外 5 条（G12/13/15/16/17/18）+ 已吸收 2 条（G9 同质 + G-cs）= **剩 13 个候选**，Task 3 进一步收敛到 ≤ 10。

---

## 候选定级（Task 3 产出）

按"底层抽象 + 反方理由 + 4 原则对照"评级。

### C1 🟢 **Pre-tool destructive command hook**（吸收 G6 /careful 的 enforcement 部分）

- **底层抽象**：危险动作的禁令应是 **mechanism**（hook 拦截）而非 **文档协议**（auto-mode.md 写"必问"）
- **gstack 引用**：`careful/SKILL.md` "Bash pre-tool hook 模式匹配 → 返回 ask permission"
- **本项目落点**：`scripts/lib/destructive-guard.js`（新建）+ `~/.claude/settings.json` `PreToolUse` hook + Codex 镜像
- **4 原则对照**：✅ 多运行时 parity（Claude + Codex hook 必须同步）；✅ 确定性（pattern 匹配是确定的）；⚠ **轻量违反** — 估算 250 行（150+20+30+50）超出 "<200 行" 上限（修 P0-F）；✅ Obsidian 兼容（无文件结构改动）
- **反方理由**：(a) 已有本能"destructive 永远必问"，模型有自律；(b) bash heredoc / 别名可绕过，**只能防 accidental**，不防 deliberate（修 coherence P0-3）；(c) Windows 上 pre-tool hook 还要复测一次 nul 类副作用（已 burn 2 次）；(d) **adversarial P0-1 实证：`grep "rm -rf|DROP TABLE|force-push|accident|误删" debugging-gotchas.md` 零命中** — "年频 1-3 次"无证据，是猜测
- **反驳反方**：90% 事故是 accidental（gstack 自己 ack）；mechanism > discipline 在 ADR-013 验证过
- **Phase 4 最终定级**：🟢 → ⏸ **推迟**，等真实 destructive 事故触发再做（reviewer 共识）

### C2 🟢 **Phase 间预热段 lint enforcement**（内省驱动，不源自 gstack）

- **底层抽象**：sprint workflow 已规定"每 phase 报告末尾必有预热段"，但**实际落地率 2/20+**（grep `下一 Phase` in `docs/plans/*.md`） → 又是 ADR-013 "文档协议 → mechanism" 案例
- **gstack 引用**：（无直接对应，但与 G7 skill validation gate 同模式）
- **本项目落点**：`scripts/pre-commit-check.js` 新增 `checkPhaseWarmup()`，检查近 24h 修改的 `docs/plans/*.md` 含 phase 报告段时必有「下一 Phase 预热」字符串
- **4 原则对照**：✅ 4 条都不冲突，纯文档 enforcement
- **反方理由**：(a) 易误拒（用户写到一半 commit）；(b) 预热段价值未量化，可能是 cargo-cult
- **反驳反方**：grandfather + 仅检查 "声明完成本 phase" 的段落；价值量化通过 6 个月后比较"返工率"

### C3 🟡 **Decision Audit Table 持久化**（部分借鉴 G3 /autoplan）

- **底层抽象**：auto-mode 自动决策从"打印一行"升级为"写入 sprint 文档的 audit table"
- **gstack 引用**：`autoplan/SKILL.md` "Every auto-decision is logged in a markdown table within the plan file"
- **本项目落点**：`sprint.md` 模板新增 `## 决策审计表`段；auto-mode 触发时追加行
- **4 原则对照**：✅ 全部
- **反方理由**：(a) 表格膨胀（一个长 sprint 几十条）；(b) 当前 auto-mode 用户极少启用（grep 不到主用例），ROI 不明
- **采纳形态**：仅在 `--auto` 模式下追加；非 auto 模式不动；表满 30 条自动折叠

### C4 🟡 **多角色 reviewer 命令族**（部分借鉴 G2）

- **底层抽象**：review 不止技术维度（security/perf/arch/quality/test），还应有 **product / design / devex** 维度
- **gstack 引用**：`autoplan/SKILL.md` 显式 4 phase（CEO/Design/Eng/DX）
- **本项目落点**：`review.md` Dispatch Matrix 新增可选 `--lens=product` / `--lens=devex`；ADR-011 已要求 product-lens 用于"评估外部架构"类 sprint
- **4 原则对照**：✅ 全部
- **反方理由**：(a) 本项目是开发者工具链，product/design 维度通常空（无 UI）；(b) ADR-011 已在文档协议层覆盖，再加 lens 是冗余
- **采纳形态**：仅在「sibling project evaluation」类 sprint 自动 spawn product-lens，其他不强制

### C5 🟢 **Retro JSON snapshot + delta 比较**（吸收 G-retro 的"度量"内核，拒绝周月级 cron）

- **底层抽象**：复盘从"读 markdown 摘要"升级为"读 JSON + 比上次 delta"（"Test ratio: 22% → 41% ↑19pp"）
- **gstack 引用**：`retro/SKILL.md` "writes one JSON snapshot to .context/retros/ ... shows deltas"
- **本项目落点**：`scripts/session-snapshot.js`（新建）写 `~/.claude/projects/{hash}/retros/YYYY-MM-DD.json`；`/review-learnings` 命令读最新 + 上一份对比
- **4 原则对照**：✅ 多运行时 parity（Claude + Codex 共享 snapshot 目录）；✅ 确定性；✅ 轻量（snapshot 单文件 < 5KB）；✅ Obsidian 兼容（JSON 在 Obsidian 中可读不可视，但 markdown 索引可加 frontmatter `dataview`）
- **反方理由**：(a) 周月级 retro 对 solo-maintainer ROI 低；(b) JSON 不利 Obsidian 直接渲染
- **采纳形态**：**只吸收 delta 比较的内核**，触发改为 "每次 `/session-summary` 写一份"，不做 cron 周月

### C6 🟡 **Codex filesystem boundary for prompt injection**（部分借鉴 G3 内 Codex boundary）

- **底层抽象**：调 codex 时，prompt 前缀 "你不允许读 .codex/commands/ 和 skill 定义文件"，避免 codex 顺藤摸瓜
- **gstack 引用**：`autoplan/SKILL.md` "All Codex prompts prefixed with filesystem boundary"
- **本项目落点**：`scripts/agent-orchestrator.js` 调 codex 时 prompt 前置 boundary 段
- **4 原则对照**：✅ 全部，但增加了一些 codex prompt 复杂度
- **反方理由**：(a) 本项目 codex 主要负责 implementation（按 spec 执行），不是 review，attack surface 比 gstack 小；(b) 增加 prompt 长度 = 增加 token
- **采纳形态**：仅在 review provider = codex 时加 boundary；implementation 不加

### C7 🟡 **Plan completion verification（scope 到代码 sprint）**（Phase 4 reviewer 反馈后从 🔴 升 🟡）

- **底层抽象**：sprint Phase 5 不止勾 checkbox，还扫 `git diff` 验证每个 Task 在 diff 中真有对应改动
- **gstack 引用**：`ship/SKILL.md` "extracts actionable items from any associated plan file and verifies each is addressed in the diff"
- **原拒绝理由**：(a) 研究类 sprint **无代码改动**，diff 验证天然失败；(b) gstack 服务于 release pipeline
- **Phase 4 反驳**（adversarial P1-2 + product-lens F4）：CLAUDE.md 第 28 条本能 `documented-claim-vs-code-reality-drift` 是本项目**最强活跃本能**（4/8 "fixed" claims grep 零命中），C7 正是它的 mechanism。"研究 sprint 无 diff" 不是拒绝理由，是 **scope 限制条件**
- **新定级 🟡**：scope 收窄到 `type:sprint AND status:done AND has-code-tasks`；研究类 sprint 跳过
- **采纳形态**：`scripts/pre-commit-check.js` 新增 `checkPlanCompletion()`：grep frontmatter `type:sprint` + `status:done` + 任务表有 "文件:" 字段 = 触发；其他类型 sprint 不触发
- **4 原则对照**：✅ 全部（轻量 ~100 行，复用 ADR-013 grandfather 模式）

### C8 🔴 **多层测试管道 cost-tiered（Free/Paid/Gate/Periodic）**（显式拒绝）

- **底层抽象**：测试按成本/频率分层而非按风险分层
- **gstack 引用**：CLAUDE.md "Free tier / Paid evals / Gate-tier / Periodic-tier"
- **拒绝理由**：(a) 本项目已用风险驱动（L0-L4）分层，**根上是同问题不同切法**；(b) 风险驱动更适合 dev 工具链（没有外部用户流量驱动 periodic eval）；(c) gstack 用 paid evals 是因有 LLM-judge eval 真花钱，本项目 review 用本地 agent 无此成本
- **反方理由**：未来若引入 LLM-judge eval 应重新评估

### C9 🔴 **Domain skills（per-site agent notes）**（显式拒绝）

- **底层抽象**：每个目标"网站 / 项目"独立 namespace 的 agent 持久笔记
- **gstack 引用**：README "Domain skills for per-site agent notes"
- **拒绝理由**：(a) 本项目是 dev 工具链，"site"概念不存在；(b) Memory v5 已有 project-scoped + global 双层，足够分隔；(c) 引入"domain"会增加 3 层 namespace（global/project/domain）超过当前轻量原则

---

## 内省维度可优化点（Task 4 产出）

不依赖 gstack 也成立，纯本项目内部审视。

### I1 🟢 **Phase 间预热段落地率 2/20+**（与 C2 重合，主推此项）

- **现状证据**：`grep "下一 Phase" docs/plans/*.md` → 仅命中 `2026-05-11-sprint-architecture-review.md` + `2026-05-11-sprint-speed-layer1.md`；近 4 个 plan（`2026-05-12-*.md` 4 个文件）**全无**预热段
- **建议动作**：升级为 pre-commit-check（C2 已细化方案）
- **维护表面增量**：`pre-commit-check.js` +30 行 + `smoke-pre-commit.js` +1 scenario（warmup-missing），总 < 50 行

### I2 🟢 **Pre-tool destructive hook 缺失**（与 C1 重合，主推此项）

- **现状证据**：`grep "PreToolUse|destructive" scripts/` 仅命中 install / merge-claude-settings 等"配置 hook"代码，**无任何 destructive 命令拦截脚本**；`auto-mode.md` 文档协议是当前唯一防线
- **建议动作**：实施 C1（hook 真做拦截）
- **维护表面增量**：新增 1 脚本 `scripts/lib/destructive-guard.js`（~150 行）+ `~/.claude/settings.json` `PreToolUse` 段（5 行）+ Codex 镜像（10 行）+ smoke（30 行）。**关键风险**：Windows 上 hook command 必须 POSIX 语法（已踩 2 次 nul），新增 hook 前必须 grep `2>nul|exit /b` 反向断言

### I3 🟡 **决策审计表缺失**（与 C3 重合，但 ROI 低）

- **现状证据**：`auto-mode.md` 规定打印 `✓ auto: phase N→N+1` 但**不持久化**；session 一结束就丢
- **建议动作**：实施 C3 但仅在 `--auto` 模式触发
- **维护表面增量**：`sprint.md` 模板 +1 段（10 行）+ Codex 镜像；脚本不动

### I4 🟡 **agent-orchestrator follow-up audit "still-open" 6 项未关闭**（来自 2026-05-12-agent-loop-followup-audit.md）

- **现状证据**：上次 audit 4 closed / 3 partial / **6 still-open** / 2 wont-fix-now（CLAUDE.md 索引第 28 条引用）
- **建议动作**：另起 sprint 收尾 still-open，非本 sprint 范围；本 sprint 仅记录
- **维护表面增量**：变化范围依 still-open 项的具体内容

### I5 🟡 **`scripts/` 缺顶层 README**（隐性）

- **现状证据**：`ls scripts/` 22 个 .js 文件，无 `scripts/README.md` 说明各脚本职责；`debugging-gotchas` 多次出现 "新增 `scripts/lib/*` 依赖必须同步 install 和 build-codex-plugin" 但无中央索引
- **建议动作**：新建 `scripts/README.md` 单页索引（每脚本一行）
- **维护表面增量**：+1 文档（80 行），后续每加脚本 +1 行
- **反方**：未触发问题的纯文档优化，ROI 低于 I1/I2

---

## 21 命令使用率审计（Task 7 — reframe 新增）

**2026-05-13 复核修正**：原审计把不存在于 `user-level/commands/` 的 `/debug-journal` 纳入 21 命令，并把部分低提及命令误判为 0 提及。以下为按当前仓库重跑后的结果。

**取证方法**（排除本 sprint 自引文档）：

| 数据源 | 覆盖范围 | 限制 |
|---|---|---|
| `user-level/commands/*.md` | 当前真实命令面 | ✅ 21 个文件；`/debug-journal` 不存在，不能纳入 21 命令审计 |
| `~/.claude/homunculus/projects/8331ab9c2853/observations.jsonl` | 1562 entries，2026-05-12T01:04:58Z → 2026-05-13T01:25:08Z | hook 里 `session_id` 多为 fallback，不能当真实 session 数；slash 命中来自 input/output 文本，不等同实际 slash command 调用 |
| `~/.codex/homunculus/projects/8331ab9c2853/observations.jsonl` | 3 entries，2026-04-23T02:47:20Z → 2026-04-23T02:54:56Z | 样本太少，只能证明 Codex 侧路径存在 |
| `docs/plans/*.md` + `docs/solutions/*.md` | 79 个历史文档；排除本文件、followup plan、reframe lessons 3 个自引文档 | 间接 proxy — 文档提及不等于实际调用，但能发现"长期没有被工作流提到"的命令 |
| `git log --since "60 days ago" --format=%s` | commit message | 当前 21 个命令均 0 命中；不作为使用率依据 |

**核心发现 — 4-hook observation 系统已建但跨 session 聚合缺失**：

- observation 文件存在并持续增长，但当前没有稳定的跨 session 聚合脚本（如 `scripts/usage-report.js`）。
- `detectProjectIdentity()` 在本次 Node 复核中返回 `b68201be5c69`（cwd fallback），而历史 observation 实际在 `8331ab9c2853` 下；说明 usage-report 不能只信当前 runtime 推导路径，必须兼容历史项目 id / 迁移路径。
- 这是 gstack `/retro` JSON snapshot + delta 模式的**真问题映射**（C5 仍成立，但落点应是"跨 session / 跨 runtime 聚合"，不是 generic retro 指标）。

**Docs 提及次数（21 命令，排除自引后）**：

| 提及数 / 文件广度 | 命令 | 判定 |
|---|---|---|
| **0 / 0 文件** | `/instinct-export` `/instinct-import` `/instinct-status` `/review-learnings` `/session-summary` | 🔴 文档证据缺失；候选收敛，但执行前需 usage-report 复核真实调用 |
| **1 / 1 文件** | `/checkpoint` | 🟡 极低提及；保留观察 |
| **4-5 / 1 文件** | `/learn` `/prototype` `/skill-eval` `/skill-improve` `/skill-publish` | 🟡 低广度，不是 0 提及；不能按旧方案直接移入 experimental |
| **4-5 / 2-3 文件** | `/test` `/skill-diagnose` | 🟡 中低提及；保留 |
| **9-11** | `/evolve` `/think` | ✅ 保留 |
| **19-20** | `/plan` `/work` | ✅ 主力 |
| **30+** | `/sprint` `/compound` `/review` `/agent-loop` | ✅ 高频 / 核心 |

**Observation slash 文本命中（仅辅助，不等同实际调用）**：

| 命中数 | 命令 |
|---|---|---|
| **0** | `/checkpoint` `/evolve` `/instinct-export` `/learn` `/prototype` `/session-summary` `/skill-diagnose` `/skill-eval` `/skill-improve` `/skill-publish` `/test` |
| **2-6** | `/instinct-import` `/instinct-status` `/plan` `/review` `/review-learnings` `/think` `/work` |
| **16+** | `/compound` `/agent-loop` `/sprint` |

**结论 — 原清理清单作废，改为候选收敛清单**（不立即执行，作为后续 sprint 输入）：

| 命令 | 证据状态 | 建议动作 |
|---|---|---|
| `/instinct-export` `/instinct-import` `/instinct-status` | docs 0；observation 中仅 `/instinct-import` `/instinct-status` 有 2 次文本命中 | 暂列 experimental 候选；执行前用 usage-report 区分真实调用与文档文本命中 |
| `/review-learnings` `/session-summary` | docs 0；`/review-learnings` 有 6 次 observation 文本命中，`/session-summary` 为 0 | 暂不移动；先确认它们是否作为 Stop/复盘链路被隐式使用 |
| `/prototype` `/skill-eval` `/skill-improve` `/skill-publish` | docs 4-5，但全部集中在 `docs/plans/2026-04-13-skill-self-iteration-loop.md` 单文件 | 从"0 提及清理"改为"低广度观察"，不能按旧 followup A 直接移动 |

**反方理由**：
- `/instinct-export` 是 0 docs 提及但**结构性价值**仍成立（团队协作 / 开源共享场景）；移除主线前必须保留源码和恢复路径。
- `/review-learnings` / `/session-summary` 属于复盘链路命令，可能通过文档外触发；仅靠 docs proxy 判定风险偏高。
- skill 自迭代命令虽然低广度，但与本项目 inbound self-evolution 定位直接相关，不能和 outbound shipping 命令同一套退役标准。

**产品级洞察（来自 product-lens reviewer F5/F2）**：
gstack 从 N=23 → N=30+ 是**用户价值假设的扩张**。本项目从 N=21 看，当前更准确的结论不是"9 个命令可立即退役"，而是：**5 个命令 docs 0 提及，6 个命令只被单个历史文档提到，命令面确实偏宽，但退役清单必须先由 usage-report 复核**。"已建"不等于"应建"，但"低文档提及"也不等于"可直接移出主线"。

---

## Positioning 决策（Task 8 — reframe 新增）

### gstack 与本项目的差异化定位

| 维度 | gstack (Garry Tan) | tech-persistence (本项目) |
|---|---|---|
| **命令数** | N=23 → N=30+（持续扩张）| N=21（稳定 ~3 个月）|
| **核心方向** | **outbound shipping**（browser / canary / land-and-deploy / pair-agent / parallel sprint / voice / make-pdf / scrape）| **inbound self-evolution**（learn / compound / evolve / instinct / skill-eval/diagnose/improve/publish）|
| **目标用户** | "Solo founder shipping like a team"（团队速度的单兵）| 单 dev 工具链的自我进化 |
| **运行时** | Claude Code 单端为主，codex 是组件 | **Claude + Codex 双运行时 parity**（4 原则之首）|
| **持久化** | `.context/retros/` + `~/.gstack/checkpoints/` | Memory v5 + `~/.claude/homunculus` 共享 + Obsidian 兼容 |
| **价值假设** | "工具替代团队角色"（CEO / 设计 / Eng / DX 都是命令）| "工具积累自身能力"（每次工作让下次更容易）|

### Positioning 决策

**正式声明（提议加入 ADR-011 章节作为 §A）：**

> tech-persistence **不跟随 gstack 的 outbound shipping 扩张方向**。本项目的差异化定位是 **inbound self-evolution toolkit**：核心命题是"AI 协作工程的自我复利"，而非"AI 团队替代外部角色"。共享 gstack 的方法论根（think/plan/work/review/compound）但拒绝其向 deployment / browser / multi-agent shipping 的扩张。

### 选择理由

1. **重叠最小、互补最大**：gstack 缺 instinct 系统、缺 Memory v5、缺多运行时 parity；本项目缺 deployment / browser — 用户若两者皆需，可同时使用两个 toolkit 而无冲突
2. **避免身份漂移**（ADR-011 强化）：跟随 gstack 的 N=30+ 扩张需要堆 ~10 个新命令，破坏"轻量"原则
3. **真实需求约束**：用户当前未表达 deployment / parallel sprint / browser stack 需求；扩 commands 等于堆产品债

### 不做（显式）

- 不引入 `/ship` `/land-and-deploy` `/canary`（无 deploy 场景）
- 不引入 `/browse` `/pair-agent`（非 browser toolchain）
- 不引入 parallel sprint management
- 不引入 voice triggers

### 反方理由

- 若未来本项目有 deployment 需求（如 install.sh 升级到 CI 触发的 release），`/ship` 类命令仍可借鉴。Reframe 不锁死永远拒绝，仅锁定 "**至今**无证据需要"。

---

## ROI 排序与显式拒绝（Task 5 — Phase 4 reframe 后重写）

### Phase 4 reviewer 共识修正

**取消原 ROI 第 1 / 第 2 排序**（adversarial P0-1/P0-2 + scope-guardian 验证）。

| 原排序 | 项目 | 取消原因 |
|---|---|---|
| 🥇 旧 | C1 destructive hook | 数据捏造 — `debugging-gotchas.md` 零 destructive 事故记录；nul 是 hook 语法 ≠ destructive 命令 |
| 🥈 旧 | C2 phase warmup lint | 分母错（20+ 大多是 handoff/research）+ 本 sprint dogfood 失败（自己也没写）+ 产品信号被误读为 enforcement gap |

### 新 ROI 排序（基于 reviewer 确认证据 + Task 7/8 reframe）

**🥇 ROI 第 1 — 已建未用命令清理（Task 7 产出）**

- **5 年杠杆**：复核后是 5 个 docs 0 提及命令 + 6 个单文档低广度命令，而不是旧结论的"4 个 0 + 5 个 1"。先把清理候选从"直接移动文件"改为"基于 usage-report 复核后的收敛动作"，可以避免继续被"我们有命令"的假象误导，同时不误伤 skill 自迭代 / 复盘链路命令。
- **维护表面增量**：**负的**（删 / 合并 = 减表面）
- **杠杆/增量比**：**∞**（无新增维护，全是减表面）
- **风险**：docs proxy 不是实际调用数据；缓解 = 先做 usage-report，再决定 experimental 清单

**🥈 ROI 第 2 — 跨 session 使用率聚合脚本（Task 7 衍生）**

- **5 年杠杆**：实施后 every sprint 可见"60 天未用命令"清单，未来"是否再加 X 命令"决策有真实数据支持；本能 `documented-claim-vs-code-reality-drift` 加一层防御（命令文档也是"声称"）。2026-05-13 复核还发现 current id `b68201be5c69` 与历史 observation id `8331ab9c2853` 漂移，usage-report 必须兼容历史 id / runtime 路径。
- **维护表面增量**：~80 行（聚合脚本 + `/review-learnings` 集成）
- **杠杆/增量比**：~10x
- **关键约束**：吸收 gstack `/retro` 的"delta 比较"内核（C5 仍成立），但落点改为命令使用率而非 generic engineering metrics

**🥉 ROI 第 3 — C7 plan completion verify（重新定级 🟡 with scope）**

- **来源**：adversarial P1-2 + product-lens F4 共同认为原拒绝错。`documented-claim-vs-code-reality-drift` 是本项目最强活跃本能，C7 正是它的 mechanism。
- **重新定级**：原 🔴 → 🟡，scope 收窄到 `type:sprint AND status:done AND has-code-tasks`
- **5 年杠杆**：每次实施类 sprint 自动验证"task 真在 diff 中"；本能 doc-vs-code-drift 至少触及 4 次（CLAUDE.md 记录），mechanism > discipline 的真实复用
- **维护表面增量**：~100 行（`pre-commit-check.js` 新增 `checkPlanCompletion()`，复用 ADR-013 grandfather 模式）

### Phase 4 后被降级的候选

| 候选 | 原级 | 新级 | 降级原因 |
|---|---|---|---|
| C1 destructive hook | 🟢 | 🟡 → ⏸ 推迟 | adversarial P0-1：数据捏造 + 真实事故 0；待真发生再做 |
| C2 phase warmup lint | 🟢 | 🟡 → ⏸ 推迟 | adversarial P0-2 + P0-3：分母错 + dogfood 失败 + 产品信号被误读 |
| ADR-014 候选 | 候选 | ⏸ 取消 | scope-guardian P0-3：N=2 不够，等 N≥3 + 30 天间隔 |
| C4 多角色 reviewer 命令族 | 🟡 | ⏸ 推迟 | scope-guardian #6：ADR-011 已覆盖，再加 lens 冗余 |
| C6 Codex filesystem boundary | 🟡 | ⏸ 推迟 | scope-guardian #7：本项目 codex attack surface 远小于 gstack |

### 显式拒绝（Phase 4 后无变化 — 这部分 reviewer 一致接受）

| # | 拒绝项 | 拒绝理由 |
|---|---|---|
| 拒1 | G12 Parallel sprint management | 违反"轻量"；solo 单 sprint 足够 |
| 拒2 | G13 完整 gbrain 集成 | ADR-011 已显式拒绝 |
| 拒3 | C8 多层测试管道 cost-tiered | 与风险驱动测试同问题不同切法 |
| 拒4 | C9 Domain skills | "site" 概念不存在 |
| 拒5 | G15-17 Browser / prompt-injection / pair-agent | scope 外 |
| 拒6 | gstack outbound shipping 方向整体跟随 | Positioning 决策（Task 8）显式拒绝 |

---

## 三问作答（Task 6 — Phase 4 reframe 后重写）

### Q1（产品级版本）: **什么单一改动让已建的东西价值 10x？**

**A: 先建立可信 usage-report，再收敛 21 命令中证据不足的候选**（当前复核为 5 个 docs 0 提及 + 6 个单文档低广度命令；旧结论 "4 个 0 + 5 个 1" 作废）。

理由：
- 本项目的 self-evolution 主张要成立，**必须自己用得起来**。但 docs proxy 只能证明文档提及，不等同实际 slash command 调用
- 跟"吸收 gstack 新功能"完全相反：先**先计量、再收敛**，最后才考虑要不要扩
- 失败成本低（usage-report + experimental 候选清单），但不能再按错误清单直接移动文件

### Q2: 听起来酷但**该拒**的是哪个？为什么？

**A: gstack 整个 outbound shipping 方向**（G12 parallel sprint + G15-17 browser stack + `/ship` `/canary` `/land-and-deploy` `/pair-agent`）。

理由（来自 Task 8 positioning 决策）：
- gstack 从 N=23→30+ 是产品 positioning 移动：**"solo founder shipping like a team"**
- 本项目是 **inbound self-evolution toolkit**，互补不竞争
- 跟随 = 堆 10 个命令破"轻量"，且复制 gstack 没有差异化
- 共享方法论根（think/plan/work/review/compound）就够，方向分叉是健康的

### Q3（产品 + 工程合并）: 今天只能动一件事，**最小动作**是什么？

**A: 修正 21 命令审计口径并重写 followup A 的候选列表**（先不移动文件；把 `prototype/skill-eval/skill-improve/skill-publish` 从"0 提及清理"降级为"低广度观察"）。

理由：
- 比 C1（~250 LOC）和 C2（~50 LOC + 错的产品判断）都小，且直接修复当前 followup 的执行风险
- 立刻验证 Task 7/8 reframe 的核心论点："**先证明没人用，再 retire；不要把低文档广度误当 0 使用**"
- 失败安全：usage-report 做完后仍可把确认无用的命令移入 experimental，6 个月内若有用例可移回
- **不需要 Windows hook 复杂度 / 不依赖未验证证据 / 不要求 ADR-014 框架**

**注意**：本答案把 ROI 第 1 拆成"先可信计量，再清理候选"，避免再次出现 P0-C 式优先级矛盾。

---

## ADR 候选（Task 6 — Phase 4 reframe 后取消）

~~ADR-014 候选：评估同源 sibling 项目时必须先输出"吸收度对照表"。~~

**取消理由**（scope-guardian P0-3 + adversarial P1-3）：

- N=2 sample（gbrain + gstack），且 gbrain 是 zero-absorption，gstack 是 partial-absorption diff — **两个不同问题类**，不是同原则的两次应用
- 一周内连发 ADR-011 + ADR-014 是 ADR inflation
- 现在落 ADR 会强行让下个 sibling sprint 套不匹配的模板

**推迟到 N≥3 + 至少 30 天间隔之后**。若届时第三个 sibling sprint 仍验证"先输吸收度对照"价值，再正式 propose。临时知识仍可在本 sprint 复利记录段保留，作为下次 sibling sprint 启动时的参考线索（非正式规则）。

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-12 | Phase 1 | 创建文档，完成 18 个 gstack 特性取证 + 关键假设验证 |
| 2026-05-12 | Phase 2 | 任务表拆解 6 个 Task，确认 scope 过滤规则 |
| 2026-05-12 | Task 1 | gstack 7 个核心 skill 深取证（/autoplan / /ship / /freeze / /guard / /careful / /cso / /retro / /context-save） |
| 2026-05-12 | Task 2 | 21 个 gstack 特性吸收度对照表（5 scope 外拒绝、2 已吸收、13 待评估） |
| 2026-05-12 | Task 3 | 候选定级 — 9 个候选（C1-C9），2 🟢 / 4 🟡 / 3 🔴 |
| 2026-05-12 | Task 4 | 内省维度 5 项（I1-I5），证据驱动 |
| 2026-05-12 | Task 5 | ROI 排序前 3 + 显式拒绝 6 项 |
| 2026-05-12 | Task 6 | 三问作答 + ADR-014 候选起草 |
| 2026-05-13 | Task 7 复核 | 重跑 21 命令审计，修正 `/debug-journal` 不存在、低提及命令误判、旧 ROI 段残留 |

---

## 审查结果

Phase 4 spawn 4 reviewer 并行（coherence / scope-guardian / product-lens [ADR-011 强制] / adversarial）。

### P0 — 必须修复

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| P0-A | adversarial + scope-guardian | 候选定级 C1 + ROI 第 1 | **C1 ROI 数据捏造** — `grep "rm -rf\|DROP TABLE\|force-push\|accident\|误删" debugging-gotchas.md` 零命中。nul 污染是 hook 语法事故，C1 hook 拦不住。"年频 1-3 次"无证据 | ✅ 已解决（path-2 reframe：C1 推迟；2026-05-13 复核后新 ROI 第 1 = 先可信计量，再收敛命令面）|
| P0-B | adversarial + product-lens | 内省 I1 / 候选 C2 | **C2/I1 "2/20+"分母错** — 20 个 plan 大多是 handoff/research/历史，协议仅适用 active sprint 的阶段报告；正确分母 ≈ 4。**dogfood 失败：本文档自己也无「下一 Phase 预热」段**（在对话不在 doc）→ 提 lint 的人就是被 lint 的人 | ✅ 已解决（path-2 reframe：C2 推迟，承认是产品信号而非 enforcement gap）|
| P0-C | coherence | 三问作答 Q3 vs ROI 排序 | **优先级矛盾** — Q3 答 C2 是"最小动作"，ROI 排 C1 第 1。两套排序逻辑未说清 | ✅ 已解决（Q3 重写；2026-05-13 复核后明确拆成"usage-report 计量 → experimental 候选收敛"）|
| P0-D | adversarial + scope-guardian | ADR-014 候选 | **N=2 premature** — gbrain sprint = zero-absorption，gstack sprint = partial-absorption diff，**两个不同问题类**，不是同原则的两次应用。一周连发 2 个 ADR 是 inflation | ✅ 已解决（ADR-014 取消，推迟到 N≥3）|
| P0-E | adversarial + product-lens | 候选 C7 拒绝 | **拒绝过急** — CLAUDE.md 第 28 条本能 `documented-claim-vs-code-reality-drift` 是项目最强活跃本能，C7 正是它的 mechanism。应 scope 到 `type:sprint+status:done` 且有代码 Task，非整体拒绝 | ✅ 已解决（C7 升级 🟡，scope 到 code sprint）|
| P0-F | adversarial | 候选定级 C1 | **轻量原则自相矛盾** — C1 评 ✅ 轻量 (<200 行)，估算 ~250 行（150+20+30+50） | ✅ 已解决（C1 评级改 ⚠ 轻量违反；推迟）|

### P1 — 建议修复

| # | 视角 | 问题 |
|---|------|------|
| P1-1 | product-lens F2 | Q3 是工程口味答案。产品 Q3 应该是"什么单一改动让已建的东西价值 10x"，不是"最小工程动作" |
| P1-2 | product-lens F3 | 预热段 2/20+ 是**产品信号**（用户不写=不觉得有价值），不是 enforcement gap；修 lint 是"build the wrong thing well" |
| P1-3 | product-lens F1/F5 | 完全未问"gstack N=23→30+ 是 positioning move，本项目要不要跟"。候选评估天然回避 positioning |
| P1-4 | scope-guardian #5 | sprint 引入了用户没要的抽象层（4 原则对照 / 三问框架 / ADR-014）。**只有吸收度对照表 earns its keep** |
| P1-5 | adversarial P1-4 | Windows hook 缓解仅 grep `2>nul`，未列其他陷阱（CRLF heredoc / cmd /c 重入 / path 空格） |
| P1-6 | adversarial P1-5 | 同作者光环偏见未在评分中折扣 — gbrain sprint 多拒，gstack sprint 多采纳，对称可疑 |

### P2 — 可选优化

| # | 视角 | 问题 |
|---|------|------|
| P2-1 | coherence #2 | 吸收度对照表 G3 与 C3 不交叉引用，读者难追溯 |
| P2-2 | coherence #5 | ✅/🟡/⬜ 三档语义模糊（命令/本能/协议都标 ✅，类别不一致）|
| P2-3 | coherence #7 | "落地率 2/20+" 命令未给完整 grep 命令 |

### 总评

**4 个独立 reviewer 中 3 个建议根本性 reframe，不是表面修改：**
- scope-guardian: "Sprint has drifted into framework-building"
- product-lens: "应该输出 21 命令使用率审计 + positioning 决策，而非 9 个 gstack 候选"
- adversarial: "Not defensible as written"
- coherence: "Moderate (0.70)，3 个矛盾未解"

**核心 verdict**：本 sprint 的研究产出（G1-G18 inventory + 吸收度对照表 + ROI top-3）是 right-sized，但下游的 mechanism 推荐（C1/C2/C5）+ ADR-014 + 三问框架 **建立在弱证据上**，且 ROI 第 1 和第 2 都被 adversarial 找到数据问题。Phase 5 compound 前必须先决定 reframe 路径。

---

## 复利记录

### 提取的经验（详见 `docs/solutions/2026-05-12-gstack-analysis-reframe-lessons.md`）

- **L1**: Sibling-evaluation sprint 有 framework-building 偏见（自动生成 4-5 层抽象用户没要）
- **L2**: Mechanism 提案的 ROI 分子必须有 grep 真实事件证据，不能是 Fermi 估计
- **L3**: Enforcement 提案必须 dogfood inline 检查（提 lint 的人是不是自己也违反它）
- **L4**: Sibling 评估必须含 positioning 决策维度（6 维对比矩阵 + 跟/不跟/部分跟）
- **L5**: observation 单 session 100% 但跨 session 聚合 0 — 结构性缺口
- **L6**: Reviewer 收敛是高价值信号（3/4 = 必 reframe）

### 创建/更新的本能

- 升级：`[[documented-claim-vs-code-reality-drift]]` 应用面扩展到 ROI 分子
- 降级：`[[mechanism-over-discipline]]` confidence -0.1（不是所有 discipline 缺口都该转 mechanism，先看是否是产品信号被误读）
- 新候选本能：`[[sibling-evaluation-defaults-to-framework-building]]` confidence 0.7, N=2，等 N=3 升级

### 解决方案文档

- `docs/solutions/2026-05-12-gstack-analysis-reframe-lessons.md` — 6 条经验完整记录

### CLAUDE.md 索引追加

```text
- [2026-05-12] [sprint/sibling-evaluation/reframe] gstack 分析 sprint 暴露 sibling-evaluation 易产"framework-building 偏见"（用户问研究问题→sprint 输出 9 候选 + 4 抽象层 + ADR 候选）；4 reviewer 中 3 个独立给 reframe 建议（scope-guardian + product-lens + adversarial），coherence 给具体 P0。path-2 reframe：删 ADR-014（N=2 不足）+ 降级 C1 destructive hook（ROI 分子捏造，grep `debugging-gotchas.md` 零真实事故）+ 推迟 C2 phase warmup lint（dogfood 失败 + 分母错）+ C7 plan completion verify 从 🔴 升 🟡 scope 到 code sprint（呼应本项目最强本能 documented-claim-vs-code-reality-drift）+ 新增 Task 7 21 命令使用率审计（2026-05-13 复核修正：`/debug-journal` 不存在；当前是 5 个 docs 0 提及 + 6 个单文档低广度命令，需 usage-report 复核后再收敛）+ Task 8 positioning 决策（gstack outbound vs 本项目 inbound 正交不竞争）。新增 6 条经验 L1-L6 → `docs/solutions/2026-05-12-gstack-analysis-reframe-lessons.md`
```
