---
title: "/sprint --goal 自主目标驱动闭环"
type: sprint
status: completed
created: "2026-05-29"
updated: "2026-05-29"
tasks_total: 5
tasks_completed: 5
tags: [sprint, feature, sprint-command, goal-loop]
aliases: ["sprint --goal", "goal mode"]

# === Anti-Drift 扩展字段 ===
invariants:
  - "多运行时 parity：只改 user-level/commands/sprint.md 源；4 个派生副本（plugin command / codex command / plugin skill / codex skill）由 propagate+build 重生成，永不手改（[[ADR-011]]/[[ADR-014]]）"
  - "改 sprint.md 后必跑 propagate→build→validate→pre-commit 四件套；propagate 单跑不足（skill wrapper 走 build.commandToSkill，不是 propagate.injectIntoSkillWrapper）"
  - "Codex regex 不撞车：新增 prose 不含裸 Claude / Claude Code / .claude；runtime 区分用 spawn-capable / inline-fallback / agent-loop orchestrator idiom"
  - "--auto 永不默认；--goal 单用绝不开自主（[[feedback_no_auto_default]]）"
  - "确定性终止优先于 LLM 自评：--until exit0 或 iteration==max-iter 硬停；LLM 达成判定仅 advisory，可提前停、不可越 max-iter"
  - "命令速查保持 24 个（--goal 是参数不是新命令）"
invariant_tests:
  - "node scripts/propagate-command-changes.js sprint"
  - "node plugins/tech-persistence/scripts/build-codex-plugin.js"
  - "node scripts/validate-codex-plugin.js"
  - "node scripts/run-tests.js"
  - "node scripts/pre-commit-check.js"
deferred:
  - sprint: "follow-up"
    item: "--runtime both：委托 agent-loop 编排器跨运行时执行（本 sprint 仅文档化）"
    deadline: "2026-08-29"
    reason: "MVP 轻量优先；跨运行时编排是 agent-loop 职责。agent-loop 现无 --max-iter/goal-budget 可委托，需另设计 seam，故诚实推迟而非半建"
  - sprint: "follow-up（条件触发）"
    item: "max-iter 硬天花板下沉为 scripts/sprint-goal.js 确定性 helper（lib+CLI）"
    deadline: "2026-08-29"
    reason: "仅当 --goal --auto 自主循环被证明高频且有价值时下沉（[[feedback_unproven_protocol_rollback_before_enforcement]]）；完整蓝图已冻结在本 plan 附录 A"
---

# /sprint --goal 自主目标驱动闭环

> **Status:** `completed`
> **Created:** 2026-05-29
> **Updated:** 2026-05-29

---

## 需求分析

<!-- /think 阶段填写。CEO/产品视角：定义做什么、不做什么、成功标准。 -->

### 一句话

给 `/sprint`（及 Codex `$sprint` parity 副本）新增 `--goal "<目标>"` 参数：把"目标"提升为一等被追踪对象，让 think→plan→work→review→compound 循环可以**自主迭代直到目标达成或触发确定性终止**。控制 4 维：终止条件 / 自动化程度 / 目标范围约束 / 运行时选择。

### 现状勘察（[[ADR-012]] 不靠假设）

- 全仓库无 `--goal`/`--until`/`--max-iter` → 干净起点，无向后兼容包袱。
- `--auto` 已是跨命令参数，中心定义在 `~/.claude/rules/auto-mode.md`，强制人工边界明确（destructive / L4 / 安全 / scope creep / 测试失败）。
- `/sprint` 已支持 `--auto`/`--caveman`，**单趟**跑完 5 phase；无循环、无目标追踪、无终止判定。
- agent-loop 已做**跨运行时**编排（claude spec + codex impl）+ 自身 freeze/resume 循环 + `--auto` 自动 freeze（[[ADR-003]]/[[ADR-004]]）。运行时选择天然归属它。
- 跨 sprint 防漂移协议已有「第 6 视角集成连续性」+ invariants frontmatter → 目标范围约束可复用，不另起炉灶。

### 要做（in scope）

1. **`--goal "<目标>"` 参数**：goal 成为一等对象，写入 sprint 文档 frontmatter（`goal:` 字段）+ 注入每个 phase header 作为北极星。
2. **自主循环**：goal 未达成时，闭环可重入（review 判定"未达标"→ 回 work/plan 修 → 重审），而非单趟即止。
3. **终止条件（确定性兜底强制）**：
   - `--max-iter N`（默认 3，**硬上限**）
   - `--until "<command>"`（loop 直到 shell 命令 exit 0，确定性 ground truth）
   - LLM 目标达成自评作为"软"成功信号，但**永远被 max-iter 兜底**
4. **自动化程度**：复用现有 `--auto`，不重造。`--goal` 单独用 → 人工 gate 全保留；`--goal --auto` 组合 → 自主跑（仍受 auto-mode 强制人工边界约束）。
5. **目标范围约束**：goal 注入 Think 锚定 scope/non-scope；每 phase 对照 goal 做漂移检查（复用第 6 视角）；漂移默认**告警**，永不静默。
6. **运行时选择**：`--runtime <current|both>`。`current`（默认）= 当前运行时内闭环；`both` = **委托 agent-loop**（本 sprint 仅文档化为 follow-up）。

### 不做（non-scope）

- ❌ 不新建状态机/编排器（轻量优先）。
- ❌ 不让 `--goal` 或自主性成为默认行为（[[feedback_no_auto_default]]）。
- ❌ 不做纯 LLM 终止判定（必有 max-iter 兜底）。
- ❌ 不在 sprint 内重建跨运行时协调（`--runtime both` 委托 agent-loop，本 sprint 仅文档化）。
- ❌ 不做跨会话常驻 goal daemon（goal 生命周期 = 单个 sprint 文档）。
- ❌ 不改 auto-mode 既有强制人工边界（destructive/L4/安全/scope creep/测试失败 仍无视 --goal --auto）。

### 成功标准（已按架构发现 re-scope）

- [ ] `/sprint --goal "X"` 跑完整循环，追踪 X 为北极星，给出达成判定，**人工 gate 全保留**。
- [ ] `/sprint --goal "X" --auto --max-iter 3 --until "npm test"` 自主跑，loop 到测试全绿或 3 轮，遇强制 gate 停。
- [ ] **终止精度（MVP 版）**：协议明确 max-iter 为 HARD ceiling；iteration 计数**持久化在 sprint 文档 frontmatter** 且每轮重入前**强制从磁盘重读**（不信压缩后记忆）；每轮**强制打印** termination-check 行使任何跳过在 transcript 可见。
  - ⚠️ **re-scope 说明**：原 Think 版写「单测可验证 iter ≤ N」。架构勘察证实 `/sprint` **无宿主进程**（见下方「关键架构发现」），纯协议无代码可单测。该「单测可验证」目标移至 **附录 A 的 deferred helper follow-up**；MVP 用「frontmatter 持久 + 重读 + 可见打印」替代。
- [ ] **双运行时 parity**：`$sprint --goal` 在 Codex 行为一致（[[ADR-011]]）。
- [ ] **文档全同步**（CLAUDE.md doc-sync 规则）：本 plan + README --goal 段 + auto-mode.md 迭代级边界 + sprint 5 副本同步 + 命令速查仍 24。
- [ ] `--goal` 单独用绝不自动跳 gate（[[feedback_no_auto_default]] 守住）。

### 风险和假设

见下方「技术方案 → 风险评估」表（已细化）。

---

## 技术方案

<!-- /plan 阶段填写。架构师视角。 -->

### 关键假设验证（[[ADR-012]] 强制段）

| 假设 | 验证方式 | 结论 | 可信度 |
|------|---------|------|--------|
| `/sprint` 是模型驱动的 markdown 协议，无宿主进程循环 | Read 全部 5 副本 + 对比 `pipeline.js:472` 真实 Node for 循环 | **成立**。phase 重入=模型读 markdown 自选继续；无 hookable per-iteration 事件 | 0.95 |
| 改 sprint.md 必跑 propagate **+ build** 四件套 | Read pre-commit-check.js L88/L132（skill wrapper 走 build.commandToSkill 非 propagate.injectIntoSkillWrapper）| **成立**。propagate 单跑→`× skill wrapper mismatch` | 0.95 |
| Codex regex 会撞车裸 Claude token | Read propagate L24-47 / build L48-72（`Claude Code→Codex`、`Claude→Codex`、`.claude→.codex`）| **成立**。新 prose 须 runtime-neutral idiom | 0.9 |
| 命令数不变（--goal 是参数）| Read README L355「命令速查（24 个）」| **成立**。保持 24 | 0.95 |
| agent-loop 可承接 `--runtime both` 委托 | Read agent-orchestrator + pipeline.js | **部分**。agent-loop 有跨运行时编排，但**无 --max-iter/goal-budget** 可委托（pipeline `maxIterations=32` 是死锁守卫非目标预算）→ both 须另设计 seam，故本 sprint 仅文档化 | 0.85 |
| iteration 计数器可纯 frontmatter 持久（无需 state file）| Read clarifications.js（nextSequence 靠 regex 数 markdown，frontmatter header 写一次）| **成立**。Obsidian 兼容 + 轻量 | 0.9 |

### 关键架构发现（load-bearing — 决定选型）

> **`/sprint` 没有宿主进程。** phase 是「模型读 markdown 并选择继续」，对比 `pipeline.js:472` 那种真实 Node `for` 循环（`maxIterations=32` 由进程强制计数）。**推论：没有任何方案能让 max-iter "真正确定性强制"** —— 一个「模型必须自愿调用」的 CLI 计数器并不比 prose 更被强制，只是把信任从「数对」挪到「记得调用」。无 hookable 的 per-iteration 事件可挂。
>
> 这个事实把"确定性优先"在本特性上的可达上限钉死：能做到的最强是「frontmatter 持久 + 每轮重读 + 可见打印 + 低默认 max-iter + 多层既有 auto-mode 强制 gate」，而非「进程级硬计数」。helper 能提供的边际确定性（`--until` 真实 exit code、整数计数器）真实但有限，且代价是 [[ADR-020]] 全链 + 3 档负样本测试 + parity 表面。

### 选型决策（⚠️ 本 sprint 关键决策 — 见文末 gate 提问）

三路对抗设计裁决（完整记录于 `docs/solutions/`，本 sprint compound 阶段沉淀）：

| 方案 | 形态 | 确定性 | 代价 | 裁决 |
|------|------|--------|------|------|
| **A pure-prompt（推荐 MVP）** | 0 代码，纯协议 + frontmatter 计数 | max-iter 是纪律非机制（诚实声明）；--until 模型经 Bash 跑真实 exit code | 0；干净可撤 | pure-prompt agent verdict = 推荐 MVP |
| **Hybrid** | 默认纯协议；仅 `--goal --auto` 路径加最小 helper | --auto 路径整数计数+真实 --until | 中（helper 但仅 auto 激活）| adversary 推荐；但自标 helper 有 HIGH 级 voluntary-call gap |
| **B full helper** | 永远走 scripts/sprint-goal.js | 每调用可靠 | 高（ADR-020 全链+测试）| adversary 标 default 路径 over-engineering |

**我的架构推荐 = 分阶段（A → 条件触发 B）**：

- **本 sprint**：落 **Approach A（pure-prompt MVP）** + adversary 列的**全部 prose 护栏**（除 helper）：goal frontmatter 持久 + 每轮重读 + 强制打印 check 行 + 终止优先级明文 + 默认 max-iter=3 HARD + auto-mode 加迭代级强制边界 + goal-drift 复用第 6 视角两档。
- **deferred follow-up（条件触发）**：若 `--goal --auto` 自主循环被证明**高频且有价值**，再把 max-iter 天花板下沉为 `scripts/sprint-goal.js`（蓝图见**附录 A**，inv5 已冻结完整设计）。

**推荐理由**：项目反复重申「未证协议先证价值再下沉 enforcement」（[[feedback_unproven_protocol_rollback_before_enforcement]] 的 2026-05-22 预热协议 rollback 是活案例 + [[feedback_enforcement_dead_on_arrival_82pct]] + [[ADR-013]] 自身谨慎）。`--goal` 是未证特性；helper 的边际确定性真实但小（voluntary-call gap 使其也非真强制），代价是 ADR-020 全链。A 以零代码交付**全部用户可见行为**，干净可撤，与 `--auto`/`--caveman`「协议 + auto-mode.md 引用、无 backing code」完全同构。

> **但 `确定性优先` 是你的不可妥协原则**，与「未证协议不下沉」在此真冲突。这是架构师无法替你定的取舍 → 文末 gate 明确提问。下方任务拆解默认按 **A（推荐）** 展开；若选 Hybrid/B，追加附录 A 的 3 个 helper task。

### 入场扫描（Phase 2 强制三件套）

#### 1. 回归扫描 — Invariants 继承

| 子系统 | 继承的 invariant | 本 sprint 如何保持 |
|--------|-----------------|--------------------|
| 多副本同步 | 只改源 sprint.md，4 副本派生重生成（[[ADR-011]]/[[ADR-014]]）| 仅编辑 `user-level/commands/sprint.md`，跑四件套重生成 |
| propagate/build 链 | propagate 单跑不足，必接 build（2026-05-22 gotcha）| T4 固化四件套命令序列 |
| Codex regex | runtime 区分用 neutral idiom（[[feedback_codex_regex_sync_runtime_idiom]]）| `--runtime both` 文案用 "agent-loop orchestrator" / "spawn-capable"，禁裸 Claude |
| auto 默认 | `--auto` 永不默认（[[feedback_no_auto_default]]）| `--goal` 单用保留全 gate，自主须显式 `--goal --auto` |
| 命令计数 | README「24 个」| --goal 是参数，计数不变 |
| 先例对齐 | `2026-05-28-a1-clarify-enhancement`（纯文档命令增强）3-副本 sha256 不变量 | 复用同 invariant_tests 链 |

#### 2. 集成路径声明

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|---------|--------|--------|------------|
| `/sprint --goal "X"` | 用户输入 | 写 sprint-doc frontmatter `goal/goal_iteration/goal_max_iter/goal_until/goal_status` | ✅ markdown frontmatter | ✅（重读 frontmatter）|
| 循环重入判定 | Phase5 Compound 后 | 协议读 frontmatter + 跑 --until via Bash + max-iter 比对 | ✅ frontmatter 计数 +1 | ✅ 打印 check 行 |
| **静默断点风险** | — | 模型若不写 frontmatter / `/compact` 后不重读 → 计数丢失静默重置 | ❌ | ❌ |

→ 缓解（must-address #1）：协议**强制**每轮重入前从磁盘重读 frontmatter，**强制打印** `Goal loop: iter N/max, until=exit<code>, goal-met=y/n, decision=continue|stop`，使跳过在 transcript 可见。

#### 3. 半完成债务清单

| 议题 | 本 sprint 决策 | deadline |
|------|---------------|----------|
| `--runtime both` 跨运行时委托 agent-loop | ⏭ 推迟（frontmatter `deferred`），仅文档化委托语义 | 2026-08-29 |
| max-iter 下沉确定性 helper | ⏭ 条件触发推迟（证明高频后），蓝图冻结附录 A | 2026-08-29 |

### 契约接口（条件性 — 触发：编辑 propagate 派生文件）

> 本 sprint **不改** transform 规则函数，只编辑流经它的源内容。契约表记录内容如何流经既有 transform：

| 契约 | transform | 影响副本 |
|------|-----------|----------|
| sprint.md → plugin command | identity（LF normalize）| `plugins/tech-persistence/commands/sprint.md` |
| sprint.md → codex command | applyCodexRegex | `.codex/commands/sprint.md` |
| sprint.md → plugin/codex skill | **build.commandToSkill**（wrapper + codexRegex body）| `plugins/.../skills/sprint/SKILL.md`、`.codex/skills/sprint/SKILL.md` |
| auto-mode.md 源 → codex 副本 | applyCodexRegex（`~/.claude/rules`→`~/.codex/rules`）| `.codex/rules/auto-mode.md` |

### 任务拆解（MVP = Approach A；选 Hybrid/B 见附录 A 追加）

> `[P]` 可并行：不改同文件 + 无依赖 + 风险 ≤ L2。

- [x] **Task 1**: 编辑 `user-level/commands/sprint.md` 源 —— 核心协议。子项：(a) 用法块 + Codex 同义块 + L20 可组合注，加 `--goal/--max-iter/--until/--runtime`；(b) 可选参数段加 4 个 bullet（含「--goal 不开自主」明文）；(c) **新增 `## Goal Loop 协议` section**（插在 Caveman section 后、执行流程前），含目标追踪/终止优先级/循环机制/gate 行为/范围约束；(d) Phase 1 Think 加 north-star 注入段；(e) Phase 5 Compound 加循环重入决策 + 强制打印 check 行 + summary 扩展；(f) Phase 4 第 6 视角加 goal-drift 两档（warn-not-silent，仅同时破 invariant 才升 P0）；(g) frontmatter YAML schema 加 `goal/goal_iteration/goal_max_iter/goal_until/goal_status`。 — 文件: `user-level/commands/sprint.md` — 风险: **L2**
- [x] **Task 2**: 编辑 `user-level/rules/auto-mode.md` 源 + 同步 `.codex/rules/auto-mode.md` —— 加**迭代级强制人工边界**（协议首个 loop-class 边界）：「到 --max-iter 天花板 goal 未达 → STOP 问人」+「跨迭代累积 scope creep → 强制人工（即便单轮合规）」；各命令集成表加 `/sprint --goal` 行；默认值段补「--goal 单用不开自主」；顺手修既有 `AGENTS.md` typo。**不弱化**既有 5 条强制边界。 — 文件: `user-level/rules/auto-mode.md` (+`.codex/` 副本) — 风险: **L2**
- [x] **Task 3 [P]**: 编辑 `README.md` —— 在「自动审查模式（--auto）」段后加并列「目标驱动循环（--goal）」段（mirror --auto 段结构）；确认命令速查仍 24；检查 3 个 mermaid 是否需提 --goal（预期否）。 — 文件: `README.md` — 风险: **L1**
- [x] **Task 4**: 跑同步四件套 + 验证 —— `node scripts/propagate-command-changes.js sprint` → `node plugins/tech-persistence/scripts/build-codex-plugin.js` → `node scripts/validate-codex-plugin.js` → `node scripts/run-tests.js` → `node scripts/pre-commit-check.js`；auto-mode 改动按 rules 传播路径同步；Grep `.codex/commands/sprint.md` + `.codex/skills/sprint/SKILL.md` 确认无 Claude→Codex 误替换。 — 验证任务 — 风险: **L2**
- [x] **Task 5 [P]**: 完成本 plan 文档收尾 —— 勾选任务、填变更日志、确认 frontmatter invariants/invariant_tests/deferred 完整；确认 doc-sync 规则满足。 — 文件: `docs/plans/2026-05-29-sprint-goal-mode.md` — 风险: **L1**

### 测试策略

- **无新代码（MVP）→ 无新单测**。回归由既有确定性 gate 守护：
  - `validate-codex-plugin.js`（require 闭包 + 副本 parity）
  - `pre-commit-check.js::checkPropagateSync`（5 副本 sha256 LF-normalized 一致）
  - `run-tests.js`（既有测试无回归）
- **手动验证**：Read 生成的 `## Goal Loop 协议` 确认终止优先级明文无歧义；dry-read `$sprint` skill 副本确认 codex 转换无语义损坏。
- **负样本**（per [[feedback_negative_sample_3_archs]]，文档型适配）：故意只跑 propagate 不跑 build → pre-commit **必须** fail（`skill wrapper mismatch`）；恢复跑 build → 必 pass。证明同步 gate 真在守。
- 若选 Hybrid/B：附录 A 的 `scripts/test-sprint-goal.js` 走完整 3 档负样本（pass exit0 / blocking exit2 含 copy-paste 修复 / fail-open exit0 + `[sprint-goal] fail-open:` marker via EISDIR）。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| R1 `--goal --auto` 失控/无限循环 | 中 | 高 | 默认 max-iter=3 + frontmatter 持久重读 + 可见打印 + auto-mode 迭代级强制 gate（多层）；helper 路径见附录 A |
| R2 `--goal` 静默开自主 | 低 | 高 | 协议明文 --goal≠自主；helper（若建）inert until --auto |
| R3 `--until` 模型幻觉 exit code | 中 | 中 | 协议强制经 Bash 真跑并打印 exit code；helper 路径用 spawnSync 真实 status |
| R4 计数器跨 /compact 丢失 | 中 | 高 | **must-address #1**：frontmatter 持久 + 每轮强制重读，不信压缩记忆 |
| R5 propagate 单跑漏 build | 中 | 中 | T4 固化四件套 + 负样本验证 |
| R6 Codex regex 撞车 | 低 | 中 | runtime-neutral idiom + T4 grep 验证 |
| R7 `--runtime both` scope leak 重建编排 | 低 | 中 | 仅文档化为 deferred；agent-loop 无 goal-budget 可委托，明确不半建 |

### 涉及文件

**编辑（仅源）**：
- `user-level/commands/sprint.md`（T1 核心）
- `user-level/rules/auto-mode.md`（T2）
- `.codex/rules/auto-mode.md`（T2 同步副本）
- `README.md`（T3）
- `docs/plans/2026-05-29-sprint-goal-mode.md`（T5 本文档）

**重生成（派生，T4 自动，勿手改）**：
- `plugins/tech-persistence/commands/sprint.md`、`.codex/commands/sprint.md`
- `plugins/tech-persistence/skills/sprint/SKILL.md`、`.codex/skills/sprint/SKILL.md`

**若选 Hybrid/B（附录 A）新建**：`scripts/lib/sprint-goal.js`、`scripts/sprint-goal.js`、`scripts/test-sprint-goal.js` + 改 `build-codex-plugin.js`/`validate-codex-plugin.js` 两处列表。

---

## 附录 A：deferred helper 完整蓝图（条件触发，已冻结）

> 仅当 `--goal --auto` 被证明高频且有价值时落地。inv5 勘察已冻结完整设计，避免未来重新勘察：

- **两文件镜像 `skill-eval-results` 对**：`scripts/lib/sprint-goal.js`（纯逻辑，**零 process.exit**，导出 `parseGoalState/nextIteration/runUntil/decideContinuation`）+ `scripts/sprint-goal.js`（薄 CLI，拥有全部 exit-code 策略）。
- **迭代状态**：存 sprint-doc YAML frontmatter（仿 clarifications.js nextSequence：读 frontmatter→自增→只重写 frontmatter 块）。
- **--until**：`spawnSync(cmd,{shell:true})` 看 `result.status`；exit0→met→停；try/catch 包，spawn 错→`{met:false,error}` 不崩。测试用 `node -e process.exit(0|1)` 跨平台。
- **max-iter HARD**：`shouldContinue = iteration < maxIter && untilExit !== 0`；LLM 自评仅 advisory，可提前停不可越天花板。
- **autonomy 决策留在 /sprint 层**（复用 --auto 矩阵），helper 只算「能否继续」，不烘焙 autonomy（守 [[feedback_no_auto_default]]）。
- **exit codes**（per `.claude/rules/hook-exit-codes.md`）：0=成功/fail-open；2=越天花板的 blocking guard（含 copy-paste 修复命令）/usage 错；fail-open=exit0 + `[sprint-goal] fail-open:` marker。
- **持久字符串过 `stripPrivateTags`**（redaction.js 纵深防御）。
- **双 runtime parity**：lib 经 `copyHookLibs(pluginRoot/scripts)` 自动复制（[[ADR-020]]，build L407）；CLI **必须**加进 `copyUtilityScripts`（build L388-395）**和** `validateLocalRequireClosure` utility 列表（validate L488-501），否则 Codex `$sprint` 副本 `Cannot find module`。
- **测试** `scripts/test-sprint-goal.js`（run-tests.js 自动发现 `test-*.js`）：lib 计数/天花板/runUntil/边界；CLI 3 档负样本。ADR-020 教训：**实跑 plugin 副本**，勿信 `parity ✓`。

---

## 实现进度

<!-- /work 阶段更新 -->

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-29 | T1 | `user-level/commands/sprint.md` 加 `--goal/--max-iter/--until/--runtime` 用法+可选参数 bullet；新增 `## Goal Loop 协议` section（目标追踪/终止优先级/强制打印 check 行/循环机制/gate 行为/范围约束/运行时选择）；Phase1 north-star 注入段；Phase4 第6视角加 goal-drift 两档；Phase5 循环重入决策+summary；frontmatter 加 5 个 goal 字段 |
| 2026-05-29 | T2 | `user-level/rules/auto-mode.md` 加 Goal Loop 迭代级强制人工边界（协议首个 loop-class 边界）+ 三维正交注 + `/sprint --goal` 集成行 + 默认值「--goal 不开自主」注。AGENTS.md 经 regex `runtime instruction docs` 处理，非 typo，未改 |
| 2026-05-29 | T3 | `README.md` 加「目标驱动循环（--goal）」段（mirror --auto）+ /sprint 速查行加 `--goal` 标注；命令计数仍 24 |
| 2026-05-29 | T4 | 跑 propagate(sprint+--rules auto-mode)→build→validate→run-tests(19/19)→pre-commit(staged EXIT=0)。负样本：派生副本 drift→pre-commit EXIT=1+修复命令→恢复 EXIT=0。grep .codex 确认无 regex 撞车（`~/.codex/rules`、`agent-loop 编排器`、`runtime instruction docs` 均正确，无裸 Claude 泄漏）|
| 2026-05-29 | T5 | 本 plan 收尾：勾选 5 task、填变更日志、status→in-progress |
| 2026-06-17 | 优化3 | 终止优先级第 3 档（LLM advisory 自评）加「反-proxy 完成核证」清单（4 点：证据覆盖全部 requirement / 确定性信号≠完成 / 反代理替换 / 不确定即未达成），借 Codex `continuation.md` Completion audit 形状。纯 prompt 加法、零 backing code，只调节 advisory 松紧、不碰第 1/2 档确定性终止（守 [[ADR-021]]）。源 `sprint.md` 改后跑 propagate→build→validate→pre-commit(EXIT=0)，4 副本同步、codex 无 regex 撞车。来源：native-/goal sibling-eval（`docs/solutions/2026-06-17-native-goal-sibling-eval.md`）的 sprint 优化点 #3。优化 1（循环携带物落盘）/2（--goal 使用遥测）/4（成本估算）/5（judge≠worker 外置）按用户指示本轮不实施 |

---

## 审查结果

> Ultracode 多视角 workflow：5 维并行 review + 对抗验证（reviewer 只读、禁 git 写）。机械不变量已在 T4 验证，本轮聚焦语义质量。

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| — | — | — | 无 | — |

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| — | — | — | 无 | — |

### P2 — 可选优化（noted，不在本 sprint 处理）
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | parity | `.codex/rules/auto-mode.md` | auto-mode 源 `CLAUDE.md / AGENTS.md` 经既有 regex 转为 `runtime instruction docs`（语义抽象）。**pre-existing 规则**（`propagate.js` L29），非本 sprint 引入 | 不处理（scope discipline；如需可另开 sprint 把抽象明示为 intentional）|

### 视角结论
- **架构自洽**：DONE，0 findings。终止优先级无歧义、循环机制与 5-phase 流不冲突、frontmatter schema 三处一致。
- **确定性诚实 + no-auto-default**：DONE，0 findings。无 determinism 过度声称（明示无宿主进程的协议层上限）；"--goal 不开自主"在 sprint.md/auto-mode.md/README 三处一致，无泄漏。
- **第 6 视角（跨 sprint 集成连续性）**：DONE，0 findings。命令计数仍 24、propagate/build sync 不变量保持、runtime-neutral idiom 守住、deferral 诚实（--runtime both + helper 均有 deadline + Appendix A 冻结蓝图）、无 dead code。
- **parity-regex-safety**：DONE。reviewer 误把 8 条"验证确认"当 findings 发；对抗验证识破（3 dismissed，其余全 "no fix needed/成功合规"）。无真实缺陷。
- **doc-completeness**：workflow pipeline[4] agent 失败未跑 → **手动补做全清**：flag 跨 3 文件一致、零残留占位符、frontmatter goal 字段三处一致、success-criteria re-scope 与 Approach A 一致。

### 总评
零真实 P0/P1 缺陷，6 视角全清。纯协议 MVP，机械不变量（propagate/build/validate/tests 19-19/pre-commit/负样本）全绿，双运行时 parity 无撞车。ship-ready（提交待用户确认）。

---

## 复利记录

### 提取的经验
- **model-driven 子系统的确定性上限由"是否有宿主进程/可挂事件"决定**——`/sprint` 无宿主进程，max-iter 天花板靠协议+frontmatter持久+可见打印，而非进程级硬计数。这是 [[ADR-016]]/[[ADR-017]] 语义-确定性边界的第三轴。
- **未证特性默认 pure-prompt，mechanism 下沉作为"证明价值后"条件 backlog**（蓝图先冻结）——避免给未证特性首版接 enforcement（[[feedback_unproven_protocol_rollback_before_enforcement]]）。
- **对抗设计 panel 的价值**：pure-prompt / helper / hybrid 三方独立设计 + adversary 裁决，逼出了"voluntary-call gap 使 helper 也非真强制"这一被单方设计会漏的事实。

### 创建/更新的本能
- 新建 [[ADR-021]]（rules/architecture.md）：model-driven 协议确定性强制上限 + pure-prompt MVP + helper 条件推迟。
- 新建 memory `feedback_model_driven_loop_determinism_ceiling`（+ MEMORY.md 指针）。

### 解决方案文档
- `docs/solutions/2026-05-29-sprint-goal-mode.md`（已入 index，CLAUDE.md/AGENTS.md 解决方案索引已同步）。

### 遗留（deferred，已在 frontmatter 跟踪，deadline 2026-08-29）
- `--runtime both` 跨运行时委托 agent-loop（需 agent-loop 加 goal-budget seam）。
- max-iter 确定性 helper `scripts/sprint-goal.js`（蓝图见附录 A；仅当 `--goal --auto` 证明高频再下沉）。
