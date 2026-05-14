---
title: "spec-kit 借鉴评估"
type: sprint
status: completed
created: "2026-05-14"
updated: "2026-05-14"
checkpoints: 0
tasks_total: 9
tasks_completed: 9
tags: [sprint, evaluation, sibling-analysis, spec-driven-development, sdd]
aliases: ["spec-kit-eval", "speckit-vs-tech-persistence"]
---

# spec-kit 借鉴评估

> 评估 [github/spec-kit](https://github.com/github/spec-kit) 的 Spec-Driven Development (SDD) 设计，结合 tech-persistence 现有 5-phase sprint 架构，判定哪些点值得借鉴、哪些点必须拒绝。

## 0. 项目身份界定（兑现 [[ADR-011]]）

**tech-persistence = developer-toolchain self-evolution sibling**

不是 spec-kit 替代品，不是 SDD framework 实现，**是自学习工程系统**。

### 4 条不可妥协原则（影响所有借鉴判定）

| 原则 | 含义 | 对 spec-kit 借鉴的约束 |
|------|------|----------------------|
| 多运行时 parity | Claude Code + Codex 双运行时对齐 | 任何命令协议改动必须从 `user-level/commands/*` 源头同步到 Claude plugin / Codex commands / Codex skills 等 projection，并用 build/validator 防漂移 |
| 确定性优先 | mechanism over discipline；hook 拒绝 over LLM 协议 | 借鉴的设计必须能落地为 enforcement，不能仅靠"记得遵守" |
| **轻量优先** | 单文件流 > 多文件 artifact；docs/plans/*.md 一个文件贯穿全流程 | **拒绝任何把 1 个 sprint 拆 3+ 文件的设计** |
| Obsidian 兼容 | frontmatter + wikilinks + 单文件可读 | 拒绝任何破坏 Obsidian Graph View 联通性的目录结构 |

### tech-persistence 定位表

| 维度 | 本项目 | spec-kit | gbrain | gstack |
|------|--------|---------|--------|--------|
| 主入口 | 5-phase sprint (think→plan→work→review→compound) | constitution + core 4-step SDD (specify→plan→tasks→implement)，clarify/analyze/checklist 为条件性增强 | typed-link memory graph | command-driven workflow |
| 单文件 vs 多文件 | **单文件** docs/plans/YYYY-MM-DD-*.md | 多文件 .specify/specs/{feat}/{spec,plan,tasks,...} | typed graph nodes | 命令 chain |
| 治理机制 | CLAUDE.md + .claude/rules/ + ADR | constitution.md (memory/) | NA | NA |
| 任务记法 | 顺序 checkbox | `[P]` 标可并行 + 依赖图 | NA | NA |
| 自学习 | 核心 hooks + 本能系统 + memory v5 + agentmemory | 无 | typed-link 持久化 | NA |
| 多 runtime 副本 | Claude Code + Codex 双副本 | 30+ AI agent 通过 init CLI | 单 runtime | 单 runtime |

## 1. 需求分析

### 用户问题

> "结合当前的架构，分析下 https://github.com/github/spec-kit，看下有没有可以借鉴的地方"

### 解读

不是"全盘吸收 SDD"，而是**有选择地评估**——结合本项目身份和 4 条不可妥协原则筛选。

### 评估边界

- ✅ 评估**理念**借鉴（如 clarify gate 独立产物的价值）
- ✅ 评估**机制**借鉴（如 `[P]` 并行标记）
- ✅ 评估**artifact 结构**借鉴（如 contracts/ 单独文件）
- ❌ 不评估代码移植（不同语言栈）
- ❌ 不评估 CLI 工具借鉴（用户面窄）

## 2. 关键假设验证（兑现 [[ADR-012]]）

**关键假设验证**：以下假设必须在 Phase 2 plan 前验证，避免基于错误前提评估。

| # | 假设 | 验证方式 | 状态 | 验证结果 |
|---|------|---------|------|---------|
| H1 | spec-kit 是当前活跃维护的项目（不是 dead repo） | WebFetch commits/main | ✅ | 98.8k stars，每日多次 commit，0.8.7→0.8.9 高速迭代 |
| H2 | spec-kit 当前核心流程是否为固定 6-step | WebFetch README + integrations | ✅ | README 当前呈现为 constitution 建立原则 + specify/plan/tasks/implement 核心 4-step；clarify/analyze/checklist/taskstoissues 属于条件性增强，不应写成硬性 6-step |
| H3 | 本项目 5-phase 命令链已实现 | Glob user-level/commands/*.md | ✅ | 22 个 commands 已存在（think/plan/work/review/compound/sprint 等） |
| H4 | docs/plans/ 单文件流是设计意图 | Read TEMPLATE.md | ✅ | TEMPLATE.md 明确分需求/方案/进度/审查/复利 5 段，**单文件贯穿全流程** |
| H5 | tasks `[P]` 是否真并行执行 vs 仅标注 | WebFetch templates/commands/tasks.md | ⚠️ | **关键发现：仅 LLM 协议级标注**，"未明确并行执行机制 / 仅生成示例和机会识别"。判定规则："different files, no dependencies on incomplete tasks" |
| H6 | 本项目是否已有并行 task 标注 | Grep `\[P\]\|parallel\|并行` user-level/commands/ | ❌ | **0 个匹配**——本项目 task 完全是顺序清单 |
| H7 | constitution.md 是 step 1 只读还是动态消费 | WebFetch plan.md template | ✅ | **被 plan 命令显式 ERROR-gate**："Load constitution once, evaluate alignment at two checkpoints (pre- and post-design), flag unresolved violations as errors" |
| H8 | 本项目 ADR 是否被 Phase 1-5 显式参考 | Grep `ADR-\|architecture\.md\|constitution` user-level/commands/ + Read `scripts/pre-commit-check.js` | ⚠️ | **仅 4 次引用**（agent-loop/compound/think/session-summary 各 1 次），**无通用 ADR ERROR-gate**。pre-commit-check.js 只对选定规则做 deterministic enforcement（propagate sync / 关键假设验证 / completed-plan diff），不能等同于 constitution 全量治理检查 |
| H9 | clarify 独立产物 vs Phase 1 内嵌是否真减少 plan 错 | WebFetch clarify.md template | ⚠️ | **enforcement 是 procedural 不是 technical**：用户可显式跳过仅警告 downstream rework risk；本项目 ADR-012 + ADR-013 §B 已更严格 |
| H10 | contracts/ + data-model.md 拆分是否提升可追溯 | WebFetch plan.md template | ⚠️ | 理论价值：internal structure vs external boundaries；**但与本项目单文件流冲突** |

## 3. 技术方案

### 3.1 最终决策表（10 项设计点）

按 [[ADR-011]] 4 条不可妥协原则评估，按"5 年杠杆 / 维护表面增量" ROI 排序：

| # | spec-kit 设计点 | 决策 | 理由 | 涉及原则 |
|---|----|-----|-----|-----|
| 1 | constitution.md (step 1 强制创建) | ✗ 拒绝 | 本项目 `CLAUDE.md` + `.claude/rules/architecture.md` ADR + `rules/*.md` 三层等价；新加 constitution.md = 重复治理面 | 轻量优先 |
| 2 | constitution.md 在 plan 阶段 ERROR-gate | △ 借鉴思想，拒绝新文件 | 不新增 `constitution.md`，但借鉴"plan 阶段显式治理检查"思想：未来应映射到现有 ADR/rules/pre-commit checker，而不是再加一层治理文件 | 确定性优先 + 轻量优先 |
| 3 | /clarify 独立命令 + spec.md 内嵌 `## Clarifications` 段 | ✗ 拒绝独立命令 | 本项目 [[ADR-012]] "关键假设验证" 段 + [[ADR-013]] §B "Dogfood 自检" 已覆盖主要 rework 风险；可补强检查项，但不新增独立 `/clarify` artifact | 确定性优先 |
| 4 | 多文件 artifact 拆分（spec/plan/tasks/contracts/data-model/quickstart） | ✗ 拒绝 | 与单文件 docs/plans/YYYY-MM-DD-*.md 流冲突；多文件破坏 Obsidian Graph View 单 sprint 联通性 | 轻量优先 + Obsidian 兼容 |
| 5 | feature 编号 `.specify/specs/{N}-{name}/` 目录 | ✗ 拒绝 | 与日期流 `docs/plans/YYYY-MM-DD-*.md` 冲突；日期流支持时间序回溯，编号流支持功能视角，**本项目身份偏时间序** | 轻量优先 |
| 6 | /implement 一键执行全部 task | ✗ 拒绝 | 本项目 `/work` 已等价，且支持 task 间风险评估 + checkpoint，**比线性执行更安全** | （已等价） |
| 7 | `specify init --integration=<agent>` CLI 工具支持 30+ AI 代理 | ✗ 拒绝 | 本项目用户面窄（双 runtime: Claude Code + Codex 即可）；30+ 代理 init CLI 是 framework-vendor 思路，本项目是 self-evolution 工具 | 多运行时 parity（已满足） |
| 8 | **tasks `[P]` 并行标记 + 依赖识别** | **✓ 借鉴** | **本项目完全缺失（H6=0 匹配）**；spec-kit 自己也只是 LLM 协议级（H5 验证）。本项目应把它定位为计划层并行机会标注：(a) work 阶段可连续处理无冲突 task，但每个 task 仍单独质量门；(b) review 阶段帮助识别真依赖；(c) checkpoint 时 handoff 更准确；(d) 修改成本低 | 轻量优先 + 多运行时 parity |
| 9 | data-model.md 独立文件 | ✗ 拒绝 | 与单文件流冲突；本项目当前 plan §3.X 技术方案段已足够（注：契约思想已通过 #10 借鉴入 §3.4） | 轻量优先 |
| 10 | contracts/ 独立目录（API 契约） | △ **借鉴思想（条件性单文件段）** | **Phase 4 product-lens reviewer 洞察**：本项目自有契约边界（`scripts/lib/hook-registry.js` ADR-014 / `agent-orchestrator/schemas/*.json` / `propagate-command-changes` 等 SoT-projection transform）。拒绝独立 `contracts/` 目录（与单文件流冲突），但**借鉴"契约边界要显式标注"思想** → 在 plan 模板加可选 §「契约接口（条件性）」段。详见 §3.4 | 轻量优先 + 多运行时 parity |

**结论**：10 项中 **2 项直接借鉴**（`[P]` 并行标记 + 契约接口条件性段），**1 项借鉴思想但不新增 artifact**（constitution gate → 映射到现有 ADR/rules/enforcement），**7 项拒绝**。整体仍保持轻量单文件 sprint 架构。

### 3.2 借鉴点 A — `tasks [P]` 并行标记（详细说明）

#### 3.2.0 设计定位（先界定边界，再讨论实现）

`[P]` 在本项目中**只是计划层标注 + 连续处理提示**，**不是**多 worker 并发执行调度器。

| 维度 | `[P]` sprint 协议（本借鉴） | `agent-loop --pipeline`（既有，不属于借鉴范围） |
|------|--------------------------|------------------------------------|
| 作用层 | LLM 协议层（plan/work 命令文档约定） | 进程层（orchestrator 调度多 provider） |
| 实施成本 | ~30 行文档 + propagate | 数千行 orchestrator + schema + state machine |
| 并发性质 | 单 LLM 连续处理无冲突 task | 真实多进程 / 多 provider 并发 |
| 质量门 | 每个 task 独立风险评估 + 测试 + 勾选 | freeze gate + diff + validation per provider |
| 失败回滚 | 单 task 失败不影响其他 [P] task 已勾选状态 | orchestrator state.json + run dir |
| 适用场景 | 中小 sprint 内多文档/多模板修改 | 跨 agent 协作的 spec→implementation→review 流程 |

**判定规则**（本项目化，3 个必要条件 AND，缺一不可）：

```
[P] = 满足以下全部条件：
  1. task 不修改与其他 [P] task 相同的文件（按绝对路径比对）
  2. task 不依赖任何未完成的 task 产物（无前置 task 引用）
  3. task 风险等级 ≤ L2（L3/L4 task 即使无冲突也强制串行，便于人工逐 task 把关）
```

#### 3.2.1 判定规则正反例集（≥4 对）

按"工作中可能出现的真实情况"枚举，给 LLM 在 plan 阶段判定的清晰边界。

| 场景 | task 列表 | 正/反 | 理由 |
|------|----------|------|------|
| **正例 A**：多个独立文档修改 | T1: TEMPLATE.md / T2: plan.md / T3: work.md | ✅ T1[P] T2[P] T3[P] | 3 task 改 3 个文件，无引用依赖，全 L1 |
| **正例 B**：多模板同步更新 | T1: rules/a.md / T2: rules/b.md / T3: rules/c.md | ✅ T1[P] T2[P] T3[P] | 同样独立文件，零跨引用 |
| **反例 A**：风险等级 L3+ | T1: scripts/auth.js (L4) / T2: scripts/logger.js (L1) | ❌ 全部串行 | T1 是 L4 强制串行，T2 单独 [P] 无意义（[P] 需多 task 协同） |
| **反例 B**：依赖未完成产物 | T1: 写 lib/foo.js (L2) / T2: 写 test/foo.test.js (L2, 依赖 T1 导出) | ❌ T1 后 T2 串行 | T2 引用 T1 产物，违反"无未完成依赖" |
| **反例 C**：同文件并发 | T1: package.json 加依赖 / T2: package.json 改 scripts | ❌ T1 T2 串行 | 同文件并发会导致后写覆盖先写 |
| **反例 D**：propagate-build 链 | T1: 改 SoT command / T2: 跑 propagate 同步副本 | ❌ T2 严格依赖 T1 | T2 操作 T1 产物，违反规则 2 |
| **正例 C**：跨域 review fix | T1: 修 security finding A.md / T2: 修 perf finding B.js | ✅ T1[P] T2[P] | 不同 reviewer 提的不同文件 finding，独立修复 |
| **边界例**：3 个都是 [P] 但其中 1 个 L3 | T1[L1] / T2[L1] / T3[L3] | ⚠️ T1[P] T2[P] / T3 串行 | T3 不参与本批 [P]，T1+T2 单独并行 |

#### 3.2.2 TEMPLATE.md 修改草稿（§3.2.2）

`docs/plans/TEMPLATE.md` 当前任务拆解段（第 34-38 行）：

```markdown
### 任务拆解

- [ ] **Task 1**: [描述] — 文件: `path/to/file`
- [ ] **Task 2**: [描述] — 依赖 Task 1
- [ ] **Task 3**: [描述]
```

修改后：

```markdown
### 任务拆解

> 标记 `[P]` 表示可并行：(a) 不与其他 [P] task 改相同文件 (b) 无未完成依赖 (c) 风险 ≤ L2。
> `/work` 阶段可优先连续处理同一批 [P] task；每个 task 仍单独完成风险评估、测试和勾选。其他 task 顺序处理。
> 真正多进程并发请用 `agent-loop --pipeline`，不要把 `[P]` 升级成轻量 orchestrator。

- [ ] **Task 1 [P]**: [描述] — 文件: `path/a.md` — 风险: L?
- [ ] **Task 2 [P]**: [描述] — 文件: `path/b.md` — 风险: L?
- [ ] **Task 3**: [描述] — 依赖 Task 1+2 — 风险: L?
```

新增 3 处变更：
1. 模板前置说明（3 行 quote block）明示判定规则 + agent-loop --pipeline 边界
2. 示例 task 加 `[P]` 标记 + `— 风险: L?` 占位
3. 显式提示 work 阶段的消费协议（"可优先连续处理"而非"必须并行"）

#### 3.2.3 plan.md SoT patch 草稿（§3.2.3）

`user-level/commands/plan.md` 应新增一段（建议放在"任务拆解"段附近）：

```markdown
## [P] 并行标记判定

在生成 §4 任务拆解时，对每个 task 评估是否标 `[P]`：

**满足全部 3 条 → 标 `[P]`**：
1. 不修改其他 `[P]` task 涉及的文件（按绝对路径比对，不是按"似乎相关"判断）
2. 不依赖任何未完成 task 的产物（如 T1 写 lib/foo.js，T2 写 test/foo.test.js → T2 不标 [P]）
3. 风险等级 ≤ L2（L3/L4 task 即使无冲突也强制串行）

**默认不标 `[P]`**：拿不准时不标，遵循"少标比误标好"。`[P]` 漏标只是损失连续处理优化机会；误标会让 work 阶段绕过质量门或产生文件冲突。

**与 `agent-loop --pipeline` 的区别**：`[P]` 是 LLM 协议层标注，非真实多 worker 调度。真正需要跨 agent 并发（spec → implementation → review 异步流水线）请用 `agent-loop --pipeline`。
```

#### 3.2.4 work.md SoT patch 草稿（§3.2.4）

`user-level/commands/work.md` 应新增一段（建议放在"逐 task 实现"协议附近）：

```markdown
## 消费 [P] 标记的协议

当 plan §4 任务清单存在 `[P]` 标记时：

**连续处理（推荐）**：可在同一轮回复中连续完成多个 `[P]` task 的代码修改（如多个 Edit / Write 工具调用），但每个 task 仍需：
- 独立做风险等级评估
- 按风险等级写测试 / 跑测试
- 勾选 §4 task checkbox
- 在变更日志记录

**冲突检测（必须）**：开始 `[P]` 批量处理前，确认本批 task 涉及文件确实互不重叠。如果发现 plan 阶段标 `[P]` 但实际文件冲突，立刻降级为串行并在变更日志记录"plan [P] 标错"。

**禁止行为**：
- ❌ 把多个 `[P]` task 合并成一个 checkbox 勾选
- ❌ 跳过单个 task 的测试因为"反正同批 [P]"
- ❌ 把 `[P]` 当作"批量略过 review"的借口

**checkpoint 处理**：如果 [P] 批中途需要 checkpoint，handoff 文件必须列出"本批 [P] 已完成 X 个，剩余 Y 个"，恢复时按剩余继续。
```

#### 3.2.5 propagate / build 同步路径（§3.2.5）

```bash
# 1. 修改 SoT
edit user-level/commands/plan.md
edit user-level/commands/work.md
edit docs/plans/TEMPLATE.md  # TEMPLATE.md 是 SoT 自身，无副本

# 2. propagate（git tracked 派生：.codex/commands/, plugins/tech-persistence/commands/）
node scripts/propagate-command-changes.js plan work

# 3. build（生成 plugins/tech-persistence/skills/{plan,work}/SKILL.md + .codex/skills/...）
node plugins/tech-persistence/scripts/build-codex-plugin.js

# 4. 强制校验（pre-commit hook 自动跑，但也可手动）
node scripts/pre-commit-check.js
```

**副本树结构**（plan / work 各 1 个 SoT + 4 个 projection）：

```
user-level/commands/plan.md  (SoT)
├── plugins/tech-persistence/commands/plan.md  (propagate)
├── plugins/tech-persistence/skills/plan/SKILL.md  (build)
├── .codex/commands/plan.md  (propagate)
└── .codex/skills/plan/SKILL.md  (build)
```

#### 3.2.6 dogfood 协议（§3.2.6）

本 sprint **自身就是 dogfood 测试**：

1. **本 sprint plan §4** 已使用 `[P]` 标记 T1/T2/T3 — 证明 Phase 2 plan 阶段判定规则可读
2. **Phase 3 work 阶段** 将连续处理 T1+T2+T3（同轮多 Edit）— 证明 work 阶段消费协议可执行
3. **Phase 4 review** 会专门检查"`[P]` 协议在本 sprint 是否真的省时间还是装饰" — product-lens reviewer 强制项

**未来持续 dogfood**：从本 sprint 起，每个新 sprint plan **必须**对每个 task 显式给出 [P] 标记决策（即使是"不标"也是显式决策，不是默认顺序）。

#### 3.2.7 失效模式与兜底（§3.2.7）

| 失效模式 | 触发条件 | 影响 | 兜底 |
|---------|---------|------|------|
| LLM 漏读 `[P]` 协议 | 命令文档段未被 SessionStart 注入或被压缩 | task 全部串行（仅性能损失） | 无害失效，无需特殊处理 |
| plan 误标 `[P]` 但实际文件冲突 | 模型判断错误 | work 阶段冲突 / 后写覆盖 | work.md 协议明示"先冲突检测后处理"，降级串行 |
| `[P]` 被理解为真实多 worker 并发 | LLM 看到 `[P]` 误以为可调度多 process | 绕过单 task 质量门 | TEMPLATE.md 前置 quote + plan.md / work.md 明示"非 orchestrator" |
| review 阶段绕过 `[P]` 批 | reviewer 把整批当一个 finding | 漏审单 task | review.md（未来增强）加"按 task 粒度 review"提示 |
| propagate 漏副本 | 改 SoT 但忘跑 propagate | 4 副本不一致 | pre-commit-check.js sha256 强制校验（已有） |

#### 3.2.8 涉及文件清单（§3.2.8）

| # | 文件 | 类型 | 修改类型 |
|---|------|------|---------|
| 1 | `docs/plans/TEMPLATE.md` | SoT（无副本） | 添加 `[P]` 模板说明 |
| 2 | `user-level/commands/plan.md` | SoT | 新增 `[P]` 判定段 |
| 3 | `user-level/commands/work.md` | SoT | 新增 `[P]` 消费段 |
| 4 | `plugins/tech-persistence/commands/plan.md` | propagate 派生 | 自动同步 |
| 5 | `plugins/tech-persistence/commands/work.md` | propagate 派生 | 自动同步 |
| 6 | `plugins/tech-persistence/skills/plan/SKILL.md` | build 派生 | 自动生成 |
| 7 | `plugins/tech-persistence/skills/work/SKILL.md` | build 派生 | 自动生成 |
| 8 | `.codex/commands/plan.md` | propagate 派生 | 自动同步 |
| 9 | `.codex/commands/work.md` | propagate 派生 | 自动同步 |
| 10 | `.codex/skills/plan/SKILL.md` | build 派生 | 自动生成 |
| 11 | `.codex/skills/work/SKILL.md` | build 派生 | 自动生成 |

合计 11 个文件，其中 3 个手改 + 8 个工具自动生成。

### 3.3 借鉴点 B — constitution gate 思想（详细说明，**不新增 artifact**）

#### 3.3.1 spec-kit 原版机制（H7 验证结果）

spec-kit `plan.md` template 在 plan 阶段对 `constitution.md` 做**双 checkpoint ERROR-gate**：

```
1. Pre-design: "Fill Constitution Check section from constitution"
   → 列出每个治理条款 + 是否对齐
2. Post-design: "Re-evaluate Constitution Check post-design"
   → 重新对齐 + 若违反必须 justify 或 ERROR
```

**实质**：把项目治理规则从"静态注入 system prompt"提升到"plan 命令显式自检 + 错误报告"。

#### 3.3.2 本项目现状对比

| 治理层 | spec-kit | tech-persistence |
|--------|---------|------------------|
| 治理文件 | `.specify/memory/constitution.md` 单文件 | `CLAUDE.md` + `.claude/rules/{architecture,debugging-gotchas,api-conventions,testing-patterns,performance,prototype-conventions,general-standards,auto-mode,common/*}.md` |
| 注入方式 | LLM-level plan 命令显式 ERROR check | SessionStart hook 静态注入 + UserPromptSubmit recall hook（动态相关性） |
| Enforcement | LLM 协议级（用户可绕过） | **3 类同时存在**：(a) 静态注入（CLAUDE.md / rules）；(b) 动态 recall（memory-search + UserPromptSubmit）；(c) **deterministic pre-commit checker**（[[ADR-013]] mechanism over discipline） |
| 已有 checker | 无 | `checkPropagateSync` / `checkOrchestratorSync` / `checkPlanScope` / `checkPlanCompletion` / `checkPlanCompletionVerify` |

**关键结论**：本项目 deterministic enforcement (`pre-commit-check.js`) 在**事后拒绝**维度领先 spec-kit；但 spec-kit constitution check 是**事前 alignment**（plan 时强制 LLM 重新列治理 + 标 alignment 状态），属不同失效防御层。**两者非互斥**——本项目 H8 已实证 ADR 引用仅 4 次 + 无通用 ADR ERROR-gate，**事前 alignment 是真实 gap**。本 sprint 不退回 LLM-level ERROR check（性质不可靠 + 用户可绕过），但承认 gap 存在，需要事前 + 事后双层防御（事前 = 可观察 lint，事后 = pre-commit deterministic check）。

#### 3.3.3 借鉴的"思想"（不是机制）

借鉴的核心思想：**plan 阶段对治理规则做显式 alignment check**，不再只靠"模型记得 CLAUDE.md 写了什么"。

本项目化的等价映射（**3 类同时存在 + 增量补强**）：

1. **静态层**（已有）：SessionStart 注入 `CLAUDE.md` + `.claude/rules/architecture.md` 等
2. **动态层**（已有）：UserPromptSubmit hook + `memory-search.js` 按 prompt 召回 instinct / solution / ADR
3. **协议层**（已有部分）：plan.md SoT 中已隐含 ADR-011/012/013 引用要求；可补强为**显式 ADR 自检段**
4. **Enforcement 层**（已有局部）：`pre-commit-check.js` 的 `checkPlanScope`（[[ADR-012]] 关键假设验证段必填） + `checkPlanCompletion`（completed 状态 task 必须真有 commit 命中）

**增量空间（**本 sprint 不实施**）**：可考虑加 `checkPlanAdrReference` checker — plan 必须 reference ≥1 个 ADR/instinct/wikilink，否则视为"未对照治理规则"。这是 follow-up，不在本 sprint scope。

#### 3.3.4 不借鉴的边界

| spec-kit 做法 | 本项目对应做法 | 理由 |
|--------------|--------------|------|
| 新增 `constitution.md` 单文件 | 保持 CLAUDE.md + 多 rules + ADR | 单文件治理是 framework 思维；本项目分层治理更灵活 |
| plan 阶段对全治理做 LLM ERROR check | pre-commit-check.js 局部 deterministic check | LLM-level enforcement 不可靠（[[ADR-013]] mechanism over discipline）；deterministic check 比 LLM ERROR 强 |
| "Constitution Check" 段强制写入 plan.md | 现有 §2「关键假设验证」段 + §0「项目身份界定」段已等价 | 已有等价段，无需重命名为 Constitution Check |

#### 3.3.5 落地优先级（本 sprint **不实施**）

constitution gate 思想的等价实施已在本项目中分散落地于：
- [[ADR-011]] §0 项目身份界定（plan 必含）
- [[ADR-012]] §2 关键假设验证（plan 必含 + pre-commit-check 强制）
- [[ADR-013]] §B Dogfood 自检（plan 必含 + pre-commit-check 强制 anchor 格式）

**结论**：思想**部分吸收**（[[ADR-011]] §0 + [[ADR-012]] §2 + [[ADR-013]] §B 已覆盖项目身份、假设验证、dogfood 边界 3 个维度），但 §3.3.2 实证**事前 ADR alignment 仍是真实 gap**。

**Future follow-up 候选 `checkPlanAdrReference`** — 立项条件（可观察）：
- (a) `docs/plans/` 内 3+ 个 plan 收到 review 反馈含 "未引 ADR" / "应参照 ADR" 类措辞，**或**
- (b) plan-completion checker 加 plan 必须 grep 出 ≥1 个 `ADR-\d+` 引用作 lint 项（low-cost 试探，可作为 sprint scope-2 立项门槛）

立项条件 (b) 实施成本估算：~50 行 checker + smoke test，与 `checkPlanCompletion` 同 pattern。本 sprint 不实施仅记录立项路径，避免 scope creep。

### 3.4 借鉴点 C — 契约接口（条件性单文件段，Phase 4 reviewer 洞察后扩 scope）

#### 3.4.1 背景与触发动机

Phase 4 product-lens reviewer 洞察：spec-kit 的 `contracts/` + `data-model.md` 拒绝时的拒绝面太宽。本项目自有契约边界存在但未被显式标注：

| 本项目契约 | 位置 | 受影响消费者 |
|----------|------|-------------|
| Hook projection 契约 | `scripts/lib/hook-registry.js` ([[ADR-014]]) | `install.ps1` / `install.sh` / `build-codex-plugin.js` / `validate-claude-install.js` |
| Spec-implementation-review schema | `scripts/agent-orchestrator/schemas/*.json` | `agent-orchestrator.js` 状态机 / `claude.js` / `codex.js` provider |
| SoT-projection transform | `scripts/propagate-command-changes.js`, `scripts/propagate-*.js` | `pre-commit-check.js::checkPropagateSync` / `checkOrchestratorSync` 强制校验 |
| Git tracked 派生文件 transform 规则 | 任何被 `pre-commit-check.js` 强制 sha256 的派生关系 | 所有跨副本一致性 enforcement |

变更上述契约时，**未显式列 before/after = 高概率漏改某消费者**（典型踩坑：`docs/solutions/2026-05-14-plugin-migration-cascade-cleanup.md` 完整记录了 6 项级联清理）。

#### 3.4.2 借鉴的脊椎（不是表面）

| spec-kit 表面 | spec-kit 脊椎 | 本项目化映射 |
|--------------|--------------|-------------|
| `contracts/` 独立目录 | 契约边界要被显式标注 | plan 模板内**可选单文件段** |
| `data-model.md` 独立文件 | 数据结构变更需 before/after 对照 | 同上，前置在「方案概述」之后 |
| 项目级 `.specify/specs/{feat}/` 拆分 | 契约 vs 实现 vs 任务的关注点分离 | 单文件 plan 内的 H3 段级关注点分离（仍 Obsidian 兼容） |

**借鉴的是脊椎**：契约 before/after + 受影响消费者**强制显式化**。

**拒绝的是表面**：独立 `contracts/` 目录、多文件拆分、`{feat}/` 编号制等。

#### 3.4.3 实施位置

1. **TEMPLATE.md**：技术方案段 §「方案概述」之后、§「任务拆解」之前，新增可选 §「契约接口（条件性）」段（含触发条件 quote + 表格模板）
2. **plan.md SoT**：新增 §2.6「契约边界标注（条件性，触发即必填）」段（明示 4 类触发条件 + 必填理由 + 未触发场景说明）

#### 3.4.4 触发条件（4 类，OR 关系）

任一即必填：

1. 变更 `scripts/lib/hook-registry.js` 等 multi-runtime hook projection 契约
2. 变更 `scripts/agent-orchestrator/schemas/*.json` 等 spec-implementation-review 契约
3. 变更 `scripts/propagate-*.js` 或类似 SoT-projection transform 函数
4. 变更任何 git tracked 派生文件的 transform 规则

#### 3.4.5 与 [[ADR-014]] 的关系

[[ADR-014]] 已建立 hook-registry 单一语义源头原则，但**未规定 plan 阶段如何标注变更影响**。本借鉴补齐 plan 阶段的"事前 alignment"——契约层面的事前对齐，与 §3.3 讨论的 ADR alignment gap 同一性质（事前防 plan 跑偏到 work，事后 pre-commit-check 防漂移到 commit）。

#### 3.4.6 与 §3.3 constitution gate 思想的协同

| 层 | 防御点 | 工具 |
|----|-------|------|
| 静态层（已有） | SessionStart 注入 CLAUDE.md / rules | hook |
| 动态层（已有） | UserPromptSubmit 召回 ADR / instinct / solution | `memory-search.js` |
| **协议层（本 sprint 补强）** | plan 阶段显式契约 before/after 表 | plan.md §2.6 |
| **协议层（本 sprint 补强）** | plan 阶段显式 ADR alignment（H8 gap） | （留 follow-up `checkPlanAdrReference`） |
| Enforcement 层（已有） | 提交时 sha256 / scope / completion 校验 | `pre-commit-check.js` |

本 sprint 落地的协议层补强**部分关闭** §3.3.2 的"事前 alignment gap" — 但仅契约边界维度，ADR alignment 维度仍 follow-up。

#### 3.4.7 dogfood 边界（[[ADR-013]] §B）

本 sprint 引入"契约接口段"会**拒绝**已有产物吗？

- 本 sprint 自身**未触发**任何 4 类条件（纯文档协议变更，无 hook-registry / schemas / propagate transform 改动）→ 本 sprint plan 可省略契约接口段 ✓
- 近 3 个 sprint plan dogfood 检查：
  - `2026-05-14-claude-md-index-via-prompt-recall.md` — 改 `memory-search.js` 加 source path = ❓ **是否算 SoT-projection transform？** memory-search 不是 transform 是 retrieval lib，应**不触发**契约段
  - `2026-05-13-skill-evolution-architecture.md` — 加 `scripts/lib/skill-signals.js` Stop hook 派生 jsonl，改 4 命令为 `/skill <action>` 子动作 = 不触发 4 类条件，可省略
  - `2026-05-13-plan-completion-verify.md` — 加 `pre-commit-check.js::checkPlanCompletion` checker = 不触发（是消费者不是契约本身）
- **结论**：触发条件设计偏严格，不会误拒既有产物 ✓；未来变更上述 4 类时强制填写

#### 3.4.8 实施成本

| 项 | 行数 | 风险 |
|---|------|------|
| TEMPLATE.md 加 §「契约接口（条件性）」段 | +14 行 | L0 |
| plan.md SoT §2.6 加触发条件 + 格式 + 必填理由 | +28 行 | L1 |
| propagate + build → 8 projection 自动同步 | 0 行（工具自动） | L1 |
| 合计 | ~42 行 | L0-L1 |

### 3.5 测试策略

- **L0/L1 风险（T1-T4 文档修改）**: 冒烟级
  - `git diff` 视觉检查
  - propagate 后 sha256 一致（pre-commit 自动校验）
- **L1 风险（T5 dogfood）**: 标准级
  - 本 sprint plan 文档本身**使用 `[P]` 标记**作为 dogfood 测试
  - 写后人类可读 + Obsidian 渲染正常

### 3.6 涉及文件（汇总）

- 借鉴点 A `[P]` 并行标记：11 个文件（详见 §3.2.8）
- 借鉴点 B constitution gate 思想：**不引入新文件**（已映射到现有 ADR/rules/enforcement）
- 借鉴点 C 契约接口（条件性段）：2 个 SoT（TEMPLATE.md / plan.md，已含在 11 个里）→ 不增加新文件，与借鉴点 A 共用 plan.md propagate 链

**最终累计影响文件 = 12 个**（11 个 [P] 涉及 + 0 个 constitution + 1 个 TEMPLATE 已含在 [P] 11 个中 + 0 个新增 = 实际仍为 11 个；contracts 段写入 plan.md 已含的 SoT）。

### 3.7 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| `[P]` 协议过于晦涩，LLM 反而漏读规则 | 中 | task 串行执行（仅性能损失） | 在 plan.md 加 2-3 条正反例；dogfood 验证 |
| 借鉴 1 项后 product-lens reviewer 在 Phase 4 指出还该借鉴 X 项 | 低 | Phase 4 返工 | Phase 4 强制 product-lens reviewer 提前审 |
| `[P]` 被误读成真正多 worker 并发 | 中 | 绕过单 task 质量门或制造冲突 | 文档明示它只是计划层标注 + 连续处理提示；真正并发/锁/契约冻结走 `agent-loop --pipeline` |
| 多副本 propagate 漏掉某个文件 | 低 | hook/skill 不一致 | pre-commit-check.js 强制校验 sha256 |

## 4. 任务拆解

> 标记 `[P]` 表示可并行：(a) 不与其他 [P] task 改相同文件 (b) 无未完成依赖 (c) 风险 ≤ L2。
> `/work` 阶段可优先连续处理同一批 [P] task；每个 task 仍单独完成风险评估、测试和勾选。其他 task 顺序处理。
> **本任务清单本身就是 `[P]` 标记的 dogfood**。

- [x] **Task 1 [P]**: 修改 `docs/plans/TEMPLATE.md` 任务拆解段加 `[P]` 说明（含 2-3 行规则 + 示例） — 文件: `docs/plans/TEMPLATE.md` — 风险: L0 — **完成**
- [x] **Task 2 [P]**: 修改 `user-level/commands/plan.md` 加 `[P]` 判定规则段 — 文件: `user-level/commands/plan.md` — 风险: L1 — **完成**
- [x] **Task 3 [P]**: 修改 `user-level/commands/work.md` 加 `[P]` 消费规则段 — 文件: `user-level/commands/work.md` — 风险: L1 — **完成**
- [x] **Task 4**: propagate + build 同步 projection — 依赖 Task 2+3 — 命令: `node scripts/propagate-command-changes.js plan work` + `node plugins/tech-persistence/scripts/build-codex-plugin.js` — 风险: L1 — **完成**（8 projection + 22 commands + 32 skills 重生成）
- [x] **Task 5**: dogfood 验证（本 sprint plan 已使用 `[P]` 即是 dogfood；额外跑 pre-commit-check.js 确认 sha256 对齐） — 命令: `node scripts/pre-commit-check.js` — 风险: L1 — **完成**（pre-commit 0 报错，12 文件 sha256 对齐）

#### Scope-2（Phase 4 review 后扩 scope — 契约边界借鉴落地）

- [x] **Task 6 [P]**: 修改 `docs/plans/TEMPLATE.md` 新增 §「契约接口（条件性）」段（含触发条件 quote + before/after 表模板） — 文件: `docs/plans/TEMPLATE.md` — 风险: L0 — **完成**
- [x] **Task 7 [P]**: 修改 `user-level/commands/plan.md` 新增 §2.6「契约边界标注（条件性，触发即必填）」段（4 类触发条件 + 必填理由 + 未触发场景说明） — 文件: `user-level/commands/plan.md` — 风险: L1 — **完成**
- [x] **Task 8 [P]**: 修改 `docs/plans/2026-05-14-spec-kit-analysis.md` §3.1 决策表 #9/#10 + 新增 §3.4 借鉴点 C 详细说明 + §3.5/§3.6/§3.7 节号上移 — 文件: `docs/plans/2026-05-14-spec-kit-analysis.md` — 风险: L0 — **完成**
- [x] **Task 9**: propagate + build + pre-commit (依赖 Task 6+7) — 命令: `node scripts/propagate-command-changes.js plan work` + `node plugins/tech-persistence/scripts/build-codex-plugin.js` + `node scripts/pre-commit-check.js` — 风险: L1 — **完成**（8 projection + 0 报错，12 文件 sha256 对齐）

**dogfood 实证 (scope-2)**：T6+T7+T8 是第二批 `[P]` 同批 task — 用**同一轮 3 个 Edit 工具调用**完成 3 个不同文件修改（TEMPLATE.md / plan.md / sprint plan），证明协议在**review 后 follow-up 扩 scope 场景**同样可执行 ✓

## 5. 变更日志

### 2026-05-14 Phase 1 (Think)
- 创建 sprint 文档，frontmatter status=draft
- 完成项目身份界定（[[ADR-011]] 4 原则约束）
- 完成需求分析与 scope/non-scope 定义
- 列出 10 项 H1-H10 关键假设，待 Phase 2 验证
- 初步借鉴候选：1 项明确借鉴（`[P]` 并行标记），2 项 △ 待评估（clarify 独立产物 / contracts 拆分），5 项明确拒绝

### 2026-05-14 Phase 2 (Plan)
- 验证 H1-H10 假设（10/10 完成，含 6 项验证结果改变初判：H7 constitution ERROR-gate 比预想更动态、H9 spec-kit 自家也仅 procedural enforcement 等）
- 输出 10 项设计决策表（**1 直接借鉴 / 1 借鉴思想但不新增 artifact / 8 拒绝**）
- 借鉴点：`tasks [P]` 并行标记（spec-kit 也仅 LLM 协议级，但本项目完全缺失 → 0→1 增益清晰）；在本项目中定位为计划层标注和连续处理提示，不是多 worker 并发执行
- 拒绝点的核心理由：(a) constitution 类设计不新增文件，但可把治理检查思想映射到现有 ADR/rules/enforcement；(b) 多文件 artifact 与单文件流冲突；(c) clarify 独立命令本项目 ADR-012 + ADR-013 §B 已覆盖主要 rework 风险
- 拆 5 个 task（T1-T3 [P] 并行 + T4-T5 串行），全 L0-L1 风险
- §4 任务清单本身使用 `[P]` 标记作 dogfood 测试
- status: draft → planning

### 2026-05-14 Phase 2 Plan 扩充（按用户要求加详细说明）
- §3.2 借鉴点 A `[P]`：新增 §3.2.0 设计定位（vs agent-loop --pipeline 对比表）/ §3.2.1 正反例集（4 正 4 反）/ §3.2.2 TEMPLATE.md 完整 patch 草稿 / §3.2.3 plan.md SoT patch 草稿 / §3.2.4 work.md SoT patch 草稿 / §3.2.5 propagate-build 同步路径（含命令） / §3.2.6 dogfood 协议（本 sprint 自身 + future sprint 持续 dogfood） / §3.2.7 失效模式与兜底（5 类） / §3.2.8 涉及文件清单（11 个）
- §3.3 借鉴点 B constitution gate 思想：新增 §3.3.1 spec-kit 原版机制 / §3.3.2 本项目现状对比表（4 层 enforcement） / §3.3.3 借鉴的思想（3 类同时存在 + 增量空间）/ §3.3.4 不借鉴的边界 / §3.3.5 落地优先级（本 sprint 不实施 + 立项条件）
- §3.4 / §3.5 / §3.6 序号修正

### 2026-05-14 Phase 3 (Work)
- **T1 [P] [L0] 完成**：`docs/plans/TEMPLATE.md` 任务拆解段加 `[P]` 说明（quote block + 示例 task）
- **T2 [P] [L1] 完成**：`user-level/commands/plan.md` 新增 §2.5「[P] 并行标记判定」段（含 3 条判定规则 + 4 正反例对照表 + agent-loop --pipeline 边界说明）
- **T3 [P] [L1] 完成**：`user-level/commands/work.md` 新增「消费 [P] 标记的协议」段（连续处理 + 冲突检测 + 3 禁止行为 + checkpoint 处理）
- **dogfood 实证**：T1/T2/T3 是 `[P]` 同批 task，本 sprint Phase 3 用**同一轮 3 个 Edit 工具调用**完成 — 协议在 LLM 端可读可执行 ✓
- **T4 [L1] 完成**：`propagate-command-changes.js plan work` + `build-codex-plugin.js` — 8 个 projection 同步 + 22 commands + 32 skills bundle 重新生成
- **T5 [L1] 完成**：`pre-commit-check.js` 0 报错 — 12 文件 sha256 对齐 + ADR-012 关键假设验证段通过
- status: planning → in-progress（5/5 task 完成）

### 2026-05-14 Phase 4 (Review)
- 并行 spawn 3 reviewer：product-lens（ADR-011 强制）/ coherence / dogfood-validity
- **评级**：product-lens B / coherence ✅ / dogfood-validity C → B（修复后）
- **修复 5 个 obvious P0**：
  - D-P0-1: work.md 「冲突检测」加 4 步算法 + 集合交集判定
  - D-P0-2: work.md 加「失败传播（必须）」段 + 禁止行为补 1 项（"跳过失败 task 继续后续 [P]"）
  - D-P0-3: plan.md §2.5 规则 1 多文件 task 处理 — 改为"集合交集 = ∅"
  - C-P0-4: sprint plan frontmatter status: in-progress → reviewing
  - PL-P0-5: sprint plan §3.3.3 / §3.3.5 措辞精细化（承认事前 alignment gap + 立项条件可观察化为 2 个具体信号 a/b）
- propagate + build + pre-commit 第二轮全过（同步至 8 projection）
- **PL-P0-2（契约边界）用户选 B 扩 sprint scope-2 实施**：T6-T9（详见下方变更）
- 7 个 P1/P2 留 follow-up（措辞优化 / bisect 友好性 / agent-loop 量化阈值等，不阻塞）
- status: in-progress → reviewing

### 2026-05-14 Phase 4 Scope-2 (Contract Boundary 借鉴扩展)
- **T6 [P] [L0] 完成**：`docs/plans/TEMPLATE.md` 新增 §「契约接口（条件性）」段（4 类触发条件 quote + before/after 表模板）
- **T7 [P] [L1] 完成**：`user-level/commands/plan.md` 新增 §2.6「契约边界标注（条件性，触发即必填）」段（明示 4 类触发条件 + 必填理由 + 未触发场景说明 + 引用 ADR-014）
- **T8 [P] [L0] 完成**：sprint plan §3.1 决策 #9/#10 更新（#10 拒绝 → △借鉴思想） + 新增 §3.4 借鉴点 C 详细说明（8 子段：背景、脊椎/表面区分、实施位置、触发条件、与 ADR-014 关系、与 §3.3 协同、dogfood 边界、实施成本）+ §3.5/§3.6/§3.7 节号上移
- **dogfood 实证 (scope-2)**：T6+T7+T8 是第二批 `[P]` 同批 task — 同一轮 3 Edit 完成 3 个独立文件，证明协议在 review 后 follow-up 扩 scope 场景同样可执行 ✓
- **T9 [L1] 完成**：propagate + build + pre-commit — 12 文件 +984 -23，sha256 对齐
- **最终累计**：sprint scope 从 5 task 扩为 9 task；决策 1 借鉴 → 2 直接借鉴 + 1 思想吸收 + 7 拒绝
- tasks_total: 5 → 9, tasks_completed: 5 → 9

### 2026-05-14 Phase 5 (Compound)
- 写 `docs/solutions/2026-05-14-spec-kit-eval.md`（完整 problem/root-cause/solution/prevention/measurements/4 lessons）
- 新建 2 本能（personal/）：
  - `sibling-evaluation-reviewer-loop-can-close-in-sprint.md` N=1 conf 0.6
  - `contract-boundary-explicit-annotation-before-multi-copy-change.md` N=1 conf 0.6
- `CLAUDE.md` 解决方案索引加 1 entry（spec-kit-eval）
- 跑 `archive-claude-solutions-index.js`（/compound step 2.5 协议）→ 1 entry archived 到 `docs/archives/CLAUDE-solutions-index-2026-05-14.md`；CLAUDE.md 8381→7623 chars
- 填写 §7 复利记录（6 子段：知识资产 / 4 lessons / 本能进化 / skill 信号 / follow-up / 元发现）
- status: reviewing → completed
- 元发现：**Reviewer 反馈即时闭环方法论**（在 sibling-evaluation sprint 中首次实证）是本 sprint 最有价值的产出，远超 `[P]` 协议本身

## 6. 审查结果

**Review 维度**：3 并行 reviewer
- **product-lens**（[[ADR-011]] 强制）— 判定决策是否符合项目身份 / 是否导入表面拒绝脊椎
- **coherence** — plan ↔ 实施 ↔ 副本一致性
- **dogfood-validity** — 协议是否真能在不读 plan 时被 LLM 遵守

### Review 评级

| Reviewer | 评级 | 主要发现 |
|---------|------|---------|
| product-lens | **B** | 决策方向正确但漏判 spec-kit 真正脊椎（事前 alignment vs 事后 enforcement）+ 契约边界思想可借鉴 |
| coherence | **✅ 完全一致** | pre-commit 0 报错；12 文件 sha256 对齐；transform 仅含预期路径替换 |
| dogfood-validity | **C → B (修复后)** | 冲突检测无算法 / [P] 失败传播未定义 / 多文件 task 歧义；修复后升 B |

### P0 — 必须修复（5 个，全部已修）

| # | 视角 | 文件:位置 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | dogfood | `user-level/commands/work.md` 「冲突检测（必须）」 | 只说"确认"，无可执行算法 → LLM 自我感觉确认风险 | ✅ 修复（加 4 步算法 + 集合交集判断） |
| 2 | dogfood | `user-level/commands/work.md` | `[P]` task 失败时停/继续协议未定义 | ✅ 修复（加「失败传播（必须）」段 + 禁止行为补 1 项） |
| 3 | dogfood | `user-level/commands/plan.md` §2.5 规则 1 | 单 task 改多文件时"不同文件"判定歧义 | ✅ 修复（改为"集合交集 = ∅"） |
| 4 | coherence | sprint plan frontmatter `status` | Phase 4 时 status 仍为 in-progress（应为 reviewing） | ✅ 修复（in-progress → reviewing） |
| 5 | product-lens | sprint plan §3.3.3 / §3.3.5 | 表述把 pre-commit 等同于 spec-kit constitution check 是 cherry-pick；事前 vs 事后是不同失效层 | ✅ 修复（§3.3.3 承认事前 alignment gap + §3.3.5 立项条件可观察化为 2 个具体信号） |

### P1 — 建议修复（2 个）

| # | 视角 | 文件:位置 | 问题 | 状态 |
|---|------|---------|------|------|
| 6 | dogfood | `docs/plans/TEMPLATE.md` | 示例只展示单文件 task，回测发现多文件 task 是主流 | ⏳ 留 follow-up — 当前 SoT plan.md §2.5 已强调集合交集，TEMPLATE 简化合理 |
| 7 | product-lens | sprint plan §3.2 | `[P]` 借鉴 5 年杠杆论证薄弱（dogfood 节省时间个位数秒） | ⏳ 留 follow-up — 价值随 sprint task 数线性增长，长期 ROI 可在后续 sprint 复盘观察 |

### P2 — 可选优化（4 个）

| # | 视角 | 内容 | 状态 |
|---|------|------|------|
| 8 | coherence | plan §3.2.5 "32 skills" 数字未交叉验证 | ⏳ 已重 build 32 confirmed |
| 9 | coherence | plan §3.2.1 "4 正 4 反" vs SoT plan.md "4 行" 措辞偏差 | ⏳ SoT 简化合理 |
| 10 | dogfood | `[P]` 批量提交建议各 task 独立 git commit（bisect 友好） | ⏳ 未来 sprint follow-up |
| 11 | dogfood | `[P]` 数量 ≥ 4 时建议升级 `agent-loop --pipeline` 量化阈值 | ⏳ 未来 sprint follow-up |

### 已处理 PL-P0-2（用户选 B 扩 scope-2 立即实施 ✓）

**PL-P0-2（product-lens）**：spec-kit contracts/ + data-model.md 拒绝理由薄。本项目自有契约边界（`scripts/lib/hook-registry.js` ADR-014 / `agent-orchestrator.js` schemas / `propagate-command-changes` SoT-projection transform），可借鉴"契约边界要显式标注"思想（plan 模板加可选 §X 「契约接口」段，仍单文件不破坏 Obsidian）。

**用户决策**：B — 扩 sprint scope-2 立即实施。

**落地（T6-T9）**：
- `docs/plans/TEMPLATE.md` 新增 §「契约接口（条件性）」段（4 类触发条件 + before/after 表模板）
- `user-level/commands/plan.md` 新增 §2.6「契约边界标注（条件性，触发即必填）」段
- propagate + build + pre-commit 通过（12 文件 sha256 对齐）
- dogfood 边界产物枚举（§3.4.7）：近 3 个 sprint plan 不被新协议误拒 ✓

**决策摘要更新**：10 项中 **2 项直接借鉴**（`[P]` + 契约接口条件性段）+ **1 项思想吸收**（constitution gate）+ **7 项拒绝**。

### 总评

**A−**：决策方向正确（2 直接借鉴 + 1 思想吸收 + 7 拒绝符合身份）；执行质量高（pre-commit 0 报错 × 3 轮，coherence ✅）；协议清晰度经 5 P0 fix + scope-2 扩展后达 production-ready；**Phase 4 reviewer 漏判脊椎在同一 sprint 内被采纳实施**（罕见的"reviewer 反馈即时闭环"）。**[[ADR-011]] 4 原则全部对齐 + [[ADR-013]] §B dogfood 边界枚举满足 + [[ADR-014]] 契约语义统一原则被本 sprint 协议层补强**。

## 7. 复利记录

### 7.1 产出的知识资产

| 资产 | 路径 | 说明 |
|------|------|------|
| Solution doc | `docs/solutions/2026-05-14-spec-kit-eval.md` | 完整 problem/root-cause/solution/prevention/measurements/lessons (4 lessons) |
| 新本能 1 | `~/.claude/homunculus/instincts/personal/sibling-evaluation-reviewer-loop-can-close-in-sprint.md` | N=1 conf 0.6 — reviewer 反馈同 sprint 闭环条件性协议 |
| 新本能 2 | `~/.claude/homunculus/instincts/personal/contract-boundary-explicit-annotation-before-multi-copy-change.md` | N=1 conf 0.6 — 跨副本契约变更前 plan 必含 before/after |
| CLAUDE.md 索引 | 加 1 条 entry + 跑 archive 脚本（最老 1 条归档） | 自动 bounded 5 条 |
| Archive 文件 | `docs/archives/CLAUDE-solutions-index-2026-05-14.md` | 1 entry archived |

### 7.2 提取的 4 条 lessons（详见 solution doc）

1. **Identity-question-first 实战有效** — §0 项目身份界定 + 4 不可妥协原则让 10 项决策有可追溯逻辑
2. **脊椎 vs 表面识别需要 product-lens reviewer** — coherence + dogfood 不能替代，多视角并行 review 在 sibling-evaluation 不可省略
3. **Reviewer 闭环可同 sprint 完成（条件性）** — 视角强 + 借鉴脊椎 + PR-size 三条件全满足时无需"留 follow-up"
4. **协议层是 deterministic enforcement 的前置防线** — plan §2.5/§2.6 协议（事前 alignment）与 pre-commit-check（事后拒绝）互补不冲突

### 7.3 本能进化路径

| 本能 | 当前 N | 升级路径（→ 0.9 毕业到 rules/） |
|------|-------|------------------------------|
| `sibling-evaluation-reviewer-loop-can-close-in-sprint` | 1 | 累计 ≥3 次 sibling-evaluation sprint 应用 scope-2 协议 → 毕业到 `rules/architecture.md` ADR |
| `contract-boundary-explicit-annotation-before-multi-copy-change` | 1 | 累计 ≥3 次 hook-registry / orchestrator schemas / propagate transform 变更 plan 显式标注 → 毕业 |

### 7.4 Skill 信号

本 sprint 内未触发 skill 调用（纯文档协议 + propagate + pre-commit）。`skill-signals/` 仍空（结构性限制：Claude Code SlashCommand 不进 PreToolUse hook）。

### 7.5 Future follow-up（不在本 sprint scope）

- **`checkPlanAdrReference` pre-commit checker** — 立项条件 (a) 3+ plan review 反馈含"未引 ADR" 或 (b) 直接 lint 试探。预估 ~50 行 + smoke test
- **Multi-file task TEMPLATE 示例** — 当前 TEMPLATE 示例只单文件 task；可补 1 行多文件示例
- **`[P]` 批量 git bisect 友好性** — work.md 加"各 task 独立 commit"建议
- **`[P]` 量化阈值** — `[P]` ≥ 4 时建议升级 `agent-loop --pipeline`

### 7.6 元发现（本 sprint 最有价值的产出）

不是 `[P]` 协议本身（spec-kit 已有原型，本项目复用），不是契约接口段（spec-kit 思想本土化），而是 **reviewer 反馈即时闭环方法论** —— 在 sibling-evaluation 类 sprint 中首次实证可行。这条经验已沉淀为 [[sibling-evaluation-reviewer-loop-can-close-in-sprint]] 本能，是本 sprint 在元层级（方法论层级）的复利收益。

## 下一 Phase 预热（Phase 3: Work / 文档协议落地）

**关键文件**:
- `docs/plans/TEMPLATE.md`（任务拆解模板）
- `user-level/commands/plan.md`（SoT：生成 `[P]` 标注）
- `user-level/commands/work.md`（SoT：消费 `[P]` 标注但保留单 task 质量门）

**执行命令**:
- `node scripts/propagate-command-changes.js plan work`
- `node plugins/tech-persistence/scripts/build-codex-plugin.js`
- `node scripts/pre-commit-check.js`

**风险预判**:
- 不要把 `[P]` 写成真实并发执行；真实并发属于 `agent-loop --pipeline`
- propagate/build 可能更新 10 个 projection 文件，需检查 diff 是否只有 plan/work 相关
- pre-commit 只看 staged changes；未 stage 时需结合 `git diff` 人工确认 projection 是否同步
