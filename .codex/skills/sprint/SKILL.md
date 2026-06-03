---
name: sprint
description: Codex-compatible entry point for the former /sprint command. 全流程冲刺：think→plan→work→review→compound，含上下文 checkpoint 和恢复
---

# Sprint

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/sprint` command.

## Invocation

Use `$sprint <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/sprint`, interpret that as this `$sprint` skill invocation while running in Codex.

## Command Instructions

# /sprint — 全流程冲刺

一个命令驱动完整的 Plan→Work→Review→Compound 循环。
**支持上下文 checkpoint：长任务不怕上下文溢出。**

## 用法
```
/sprint <需求描述>       ← 新 sprint
/sprint --caveman <需求> ← 新 sprint，启用 token 压缩模式
/sprint --auto <需求>    ← 新 sprint，启用自动审查模式
/sprint --goal "<目标>" <需求>        ← 目标驱动循环（人工 gate 全保留）
/sprint --goal "<目标>" --auto <需求> ← 目标驱动 + 自主循环
/sprint resume           ← 从最近的 checkpoint 恢复
/sprint resume --caveman ← 从 compact handoff 优先恢复
/sprint resume --auto    ← 恢复并启用自动审查
```

`--goal` 的修饰参数：`--max-iter N`（默认 3，循环硬上限）、`--until "<shell 命令>"`（命令 exit 0 即终止）、`--runtime current|both`（默认 current；both 仅文档化未实装）。

`--caveman` / `--auto` / `--goal` 三者正交，可任意组合：`/sprint --goal "<目标>" --caveman --auto <需求>`。**`--goal` 单独使用不开启自主**——自主循环必须显式叠加 `--auto`。

Codex 中同义：

```text
$sprint <需求描述>
$sprint --caveman <需求描述>
$sprint --auto <需求描述>
$sprint --goal "<目标>" <需求描述>
$sprint --goal "<目标>" --auto <需求描述>
$sprint resume --caveman
$sprint resume --auto
```

## 可选参数

- `--caveman`：输出 token 压缩，详见下方 Caveman Token Budget Mode。
- `--auto`：自动审查模式。Phase 1-4 间的 'go' gate 由模型按风险等级 / 用户行为 / 置信度自主判断；强制人工的边界（destructive、L4、scope creep、P0 不平凡修复）仍保留。详见 `~/.codex/rules/auto-mode.md`。
- `--goal "<目标>"`：目标驱动循环。目标成为一等被追踪对象（写入 sprint 文档 frontmatter，注入每个 Phase 作为 north-star），think→plan→work→review→compound 循环可重入直到目标达成或触发终止。详见下方「Goal Loop 协议」。**`--goal` 不改变 gate 行为**——单独使用时人工 gate 全保留，自主须叠加 `--auto`。
- `--max-iter N`：循环硬上限，默认 3。无论 LLM 是否判定达成，迭代数到达 N 必停。
- `--until "<shell 命令>"`：确定性终止条件。每轮收尾经 Bash 真实执行该命令，exit 0 即终止循环（ground truth，优先于 LLM 自评）。
- `--runtime current|both`：执行运行时。`current`（默认）在当前运行时内闭环；`both` 委托 agent-loop 编排器跨运行时执行——**本版本仅文档化语义，未实装**（见下方「Goal Loop 协议 → 运行时选择」）。

## 项目文档贯穿全流程

整个 sprint 共用一个文档。路径：`docs/plans/YYYY-MM-DD-<需求简写>.md`

```
Phase 1 → 创建文档，填写「需求分析」     → status: draft
Phase 2 → 填写「技术方案」「任务拆解」    → status: planning
Phase 3 → 逐步勾选任务，追加变更日志      → status: in-progress
  ⚡ checkpoint → 生成 handoff 文件       → status: checkpoint-N
  恢复 → 继续 work                       → status: in-progress
Phase 4 → 填写「审查结果」               → status: reviewing
Phase 5 → 填写「复利记录」               → status: completed
```

## 需求输入路由（隐式 skill 调用）

`/sprint <需求描述>` 先判定输入类型，再决定是否进入完整 sprint。用户不需要显式输入 `/work`、`/prototype` 或 `/debug-journal`；路由命中时由当前工作流隐式唤起对应 skill。

| 输入类型 | 隐式路由 | 关键约束 |
|----------|----------|----------|
| 直接描述 bug、粘贴错误日志/堆栈、描述页面异常 | 小/已知根因 → 不启动完整 sprint，直接进入 `/work` bug 修复分支；根因不明/影响面大 → 先用 sprint 建计划，再由 Phase 3 调用 `/work` | 必须先建立可运行反馈环；Bug 修复必须有回归测试 |
| Bug 截图 | 先识别为 bug 证据，不按原型处理；隐式进入 `/work` 的「非平凡 bug 调试入口规则」 | 截图信息不足时只追问复现所需的最小信息 |
| 原型/设计截图 | `/prototype` 多轮需求收敛 | 不直接写代码 |
| 参考图/说明图 | 作为上下文理解 | 不自动改变工作流 |

**Bug 路由落点**：
1. 复现或构建最小 pass/fail signal（测试、curl/CLI fixture、浏览器脚本、trace replay、throwaway harness）。
2. 按 `/work` 风险等级修改代码，并加载测试策略。
3. 修复后跑回归测试；非平凡 bug（3+ 轮）收尾必须 `/debug-journal` → `/compound`。

## Caveman Token Budget Mode

触发方式：
- 用户显式写 `$sprint --caveman ...`
- 用户在 sprint 请求中说“压缩 token / less tokens / caveman / 简短”
- 当前会话已启用 `$caveman`，且用户没有要求完整展开

核心原则：

| 层 | 策略 |
|---|---|
| 对话输出 | `caveman-lite` 或 `caveman-full`，只报决策、风险、下一步 |
| sprint 主文档 | `artifactMode=complete`，完整保留 scope、验收、任务、测试、审查 |
| checkpoint | 同时生成完整 handoff 和 compact handoff |
| resume | `compact-first`：先读 compact handoff，不足时再读完整 sprint 文档 |
| review | findings 用一行式格式：`文件:行: severity: 问题。修复。` |
| compound | 对话只报数量和路径，完整经验写入 rules/solutions |

禁止压缩：
- `docs/plans/*.md` 主 sprint 文档
- 架构决策、验收标准、测试策略、P0/P1 审查依据
- 安全警告、不可逆操作确认、复杂迁移步骤
- 代码块、命令、文件路径、错误原文

允许压缩：
- 阶段汇报
- 中间状态
- checkpoint/resume 摘要
- review finding 展示
- compound 收尾报告

compact handoff 文件（统一写入 `docs/plans/.handoff/` 子目录，已 gitignore）：

```text
docs/plans/.handoff/YYYY-MM-DD-xxx-handoff-N.md          # 完整交接
docs/plans/.handoff/YYYY-MM-DD-xxx-handoff-N-compact.md  # 压缩恢复摘要
```

> `/checkpoint` 命令负责创建 `.handoff/` 目录（首次）并滚动保留最近 3 个；详见 `checkpoint.md` 的「执行步骤」段。

compact handoff 必须包含：

```markdown
# Compact Handoff

Sprint: <名称>
Progress: <完成数>/<总数>
Next: <下一步>
Changed: <文件列表>
Decisions: <关键决策，最多 5 条>
Validation: <命令 + 结果>
Risks: <未关闭风险>
Need full doc if: <何时必须回读完整 sprint 文档>
```

阶段输出预算：

```text
Think: scope / non-scope / success / risks，各 1-3 条
Plan: 任务表 + 验证策略，不展开实现细节
Work: 只报 Task delta、测试结果、阻塞项
Review: 只报 P0/P1；P2 写入文档，不默认展开
Compound: 只报沉淀数量、路径、是否建议 compact
```

如果用户要求“完整版本 / 完整架构 / 从源头看”，临时退出 caveman 输出压缩；完整说明后再恢复 compact mode。

## Goal Loop 协议

> 仅当传入 `--goal "<目标>"` 时激活。把"目标"作为贯穿全程的一等对象，并允许 sprint 循环重入直到目标达成或确定性终止。

### 目标作为一等被追踪对象

`--goal` 激活后，sprint 文档 frontmatter 写入（Obsidian 兼容标量）：

```yaml
goal: "<目标原文>"
goal_max_iter: 3           # --max-iter，硬上限
goal_until: "<shell 命令>"  # --until，可选；为空表示无确定性终止命令
goal_iteration: 0          # 已完成的循环轮次，每轮重入前 +1
goal_status: in-progress   # in-progress | met | max-iter-reached | terminated
```

**计数器持久化 + 强制重读**：`goal_iteration` 是循环状态的 single source of truth，**只信 frontmatter 磁盘值，不信压缩后的对话记忆**。每轮重入前必须重新读取 sprint 文档 frontmatter 取当前 `goal_iteration` 再 +1 写回。（`/compact` 会丢失对话内计数，frontmatter 是唯一可靠锚点。）

### 终止优先级（确定性优先于语义）

判定顺序，**确定性条件先于、且压倒 LLM 自评**：

1. **`--until` 命令 exit 0** → 立即终止（`goal_status: met`）。该命令每轮收尾经 Bash 真实执行、读取真实 exit code，不得用 LLM 推测代替。
2. **`goal_iteration >= goal_max_iter`** → 立即终止（`goal_status: max-iter-reached`），**无论 LLM 是否认为目标已达成**。这是硬天花板。
3. **LLM 目标达成自评** → 仅 advisory：可让循环**提前**停（`goal_status: met`），但**永远不能突破 max-iter 让循环继续**。

> ⚠️ **确定性上限说明**：`/sprint` 是模型驱动的 markdown 协议，无宿主进程强制计数。max-iter 天花板靠"frontmatter 持久 + 每轮重读 + 强制打印 check 行 + 低默认值 + auto-mode 迭代级强制 gate"多层保证，而非进程级硬计数。这是本协议层可达的确定性上限。若 `--goal --auto` 被证明高频且有价值，再下沉为确定性 helper（见 `docs/plans/2026-05-29-sprint-goal-mode.md` 附录 A）。

### 每轮强制打印 check 行

每次循环判定（Phase 5 Compound 收尾）**必须**打印一行，使任何跳过在 transcript 可见：

```text
Goal loop: iter <N>/<max>, until=<exit code 或 n/a>, goal-met=<yes|no>, decision=<continue|stop:reason>
```

### 循环机制

```text
Phase 5 Compound 收尾
  ↓ 读 frontmatter goal_iteration（磁盘，不信对话记忆）
  ↓ 跑 --until（若有）→ 读真实 exit code
  ↓ 按终止优先级判定 → 打印 check 行
  ├── 终止 → goal_status 落定，正常收尾
  └── 继续 → goal_iteration +1 写回 frontmatter → 重入 Phase 1 Think
              （携带目标 + 上一轮 delta + 未达成原因）
```

### gate 行为（守 --auto 永不默认）

- **`--goal` 单独使用**：每个 Phase 间人工 gate **全保留**，循环重入也需用户 'go'。人工 gate 本身即天花板——用户不会盲目批准第 4 次重入。
- **`--goal --auto`**：循环按 auto-mode 决策矩阵自主推进，但 auto-mode 的**强制人工边界**（destructive / L4 / 安全 / scope creep / 测试失败）以及新增的**迭代级边界**（到 max-iter 仍未达成 → 停下问人；跨迭代累积 scope creep → 强制人工）**无视 --auto**，是真正的断路器。详见 `~/.codex/rules/auto-mode.md`。

### 目标范围约束（复用第 6 视角）

`--goal` 激活时，Phase 1 Think 把目标注入 scope/non-scope 定义；后续每轮 Phase 4 Review **复用第 6 视角**（集成连续性）做目标漂移检查——不新增第 7 视角。漂移处理两档：

- **默认 warn-not-silent**：本轮改动偏离 north-star → 打印警告并继续（即便 --auto），不静默。
- **升级强制 gate**：仅当漂移**同时**触发 auto-mode 既有 scope-creep 边界时，升级为强制人工。（不把每次漂移都变硬 gate，否则每轮自主迭代都被打断，循环失去意义。）

### 运行时选择

- `--runtime current`（默认）：在当前运行时内完成整个目标循环。
- `--runtime both`：委托 agent-loop 编排器跨运行时执行（spec 与实现分属不同 provider）。**本版本仅文档化语义，未实装**：agent-loop 现无 `--max-iter` / goal-budget 可承接委托，需另设计 seam。传入 `--runtime both` 时按 `current` 执行并提示该限制。

## 执行流程

### Phase 1: Think (暂停确认)
```
Phase 1/5: Think
[执行 /think，输出范围定义]
[创建 docs/plans/YYYY-MM-DD-xxx.md，填写需求分析]
→ 'go' 进入 Plan | 修改意见调整 | 'skip' 跳过
```

Auto mode：scope 明确、无开放问题且与原始需求无 scope creep 时直接进入 Plan，并打印 `✓ auto: phase 1 → 2`；否则保留人工 gate。

Goal mode：当传入 `--goal` 时，把目标作为 north-star 注入 scope/non-scope 定义并对照检查范围一致性；同时在 sprint 文档 frontmatter 初始化 `goal` / `goal_max_iter` / `goal_until` / `goal_iteration: 0` / `goal_status: in-progress`（详见「Goal Loop 协议」）。

Caveman mode 输出：

```text
Scope: ...
Non-scope: ...
Success: ...
Risks: ...
Next: go -> Plan
```

### Phase 2: Plan (暂停确认)
```
Phase 2/5: Plan
[执行 /plan，输出实现计划]
[填写文档的技术方案、任务拆解]
[强制执行「跨 Sprint 入场 checklist」三项，见下方协议]
[如果 Task > 5 个，预告：将在 Task 5 后自动 checkpoint]
→ 'go' 进入 Work | 修改意见调整
```

Auto mode：任务数 ≤ 8 且无 L3/L4 task、无明显 scope 不一致、入场 checklist 三项全部回答时直接进入 Work；否则保留人工 gate。打印 `✓ auto: phase 2 → 3` 或 `⚠ manual gate kept: phase 2 — <原因>`。

Caveman mode 输出只展示任务表和验证策略；完整方案写入 sprint 文档，不在对话中重复。

**跨 sprint 入场 checklist (Phase 2 强制)**：详见下方「跨 Sprint 防漂移协议 → 入场 checklist」段。三项任一空白视为 Plan 未完成。

### Phase 3: Work (含自动 checkpoint)

> 同批 `[P]` task 在支持 Agent spawn 的 runtime 下通过 `/work` 的 **Worker spawn 协议**真并行实施（用 Agent tool 的 `isolation: "worktree"` 隔离）；Codex CLI 端保留 batch fallback。详见 `work.md` 的「Worker spawn 协议」段。

```
Phase 3/5: Work
[执行 /work，按计划逐步实现]
[每个 Task：实现 → 风险评估 → 按等级测试 → 勾选文档 checkbox]

⚡ 每 5 个 Task 自动检查是否需要 checkpoint:
  ├── 无退化信号 → 继续
  └── 有退化信号 或 已完成 5 个 Task → 建议 checkpoint:
      "⚡ 建议 checkpoint — 已完成 5/8 Task，上下文压力较大
       执行 /checkpoint 保存状态，然后 /compact
       下次 /sprint resume 恢复"

退化信号检测：
  - 工具调用参数出错增多
  - 忘记了 Phase 1/2 中确认的约定
  - 回答变得笼统
  - 会话轮次 > 30
```

Caveman mode 中，每个 Task 完成只输出：

```text
Done: Task N
Changed: <files>
Risk: Lx
Test: <command> -> pass/fail/skipped
Invariants: <列表> -> pass/fail
Next: Task N+1
```

**每 Task 完成强制跑「不变量回归」**：除本 task 新增测试外，必须额外跑 sprint 文档 `invariant_tests` 字段列出的所有测试 + 涉及子系统的 perf benchmark。任一回归挂掉立即升级为 P0，本 task 不算完成。

达到 checkpoint 条件时必须生成 compact handoff，并提示先 `/compound` 再 `/compact`。

### Phase 3 恢复（从 checkpoint）
```
/sprint resume

📋 检测到 Checkpoint:
  Sprint: 用户导出功能
  文件: docs/plans/.handoff/2026-06-20-user-export-handoff-1.md
  进度: 5/8 Task
  下一步: Task 6 — 异步大文件导出

  3 个关键决策已加载。继续？
→ 'go' 继续 Task 6
```

恢复时做的事：
1. 在 `docs/plans/.handoff/` 下查找最近的 handoff 文件（按 mtime 排序；该目录已 gitignore）
2. 如果是 caveman mode，先读取最新 `*-handoff-*-compact.md`
3. compact 信息不足时，读取完整 handoff 和 sprint 主文档（主文档仍在 `docs/plans/` 顶层）
4. 读取相关测试文件 → 确认测试状态
5. 从下一个未完成 Task 继续

### Phase 4: Review (暂停确认)

> 支持 Agent spawn 的 runtime 下 `/review` 通过 **Spawn 协议**真并行 spawn 5 reviewer 子进程（按 risk-aware dispatch matrix 选定子集），共享 4 status 返回契约（DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED）。任一 reviewer 报 `BLOCKED` 即使 `--auto` 也强制人工 gate。Codex CLI 端保留 inline 5 视角 fallback。详见 `review.md` 的「Spawn 协议」段。

```
Phase 4/5: Review
[执行 /review，多视角审查 (5 + 1 视角)]
[审查报告写入文档]
→ P0 自动修复 → P1 确认 → 'go' 进入 Compound
```

**第 6 视角 — 集成连续性（跨 sprint, 强制）**：5 视角（架构 / 安全 / 性能 / 代码质量 / 测试覆盖）之外必加。检查项：

1. 本 sprint 改动是否破坏前 sprint 立的 invariant（reload `invariants` frontmatter 字段逐条 verify）
2. 是否引入 dead code（新建 API / export 被 import 次数 == 0）
3. 是否让前 sprint 的设计意图无法实现（如前 sprint 留的"待 UI 接线"在本 sprint 仍空）
4. 本 sprint 留的中间状态在下个 sprint 走通整链路要多大工作量
5. 是否有"半下沉漂移"（shared / web / api 边界中间状态无 timeline）
6. （仅当 `--goal` 激活）本轮/本 sprint 改动是否偏离 `--goal` north-star 目标——复用本视角，不新增第 7 视角。漂移默认 warn-not-silent（打印警告、不静默继续），仅当同时触发 scope-creep 边界才升级为 P0/强制 gate（详见「Goal Loop 协议 → 目标范围约束」）。

第 6 视角发现破坏 invariant 或新增 dead code 一律视为 P0/P1 必修。

Auto mode：obvious P0（typo / 缺 import / null check）自动修复并继续；语义级 P0、destructive 改动、L4 任务相关 P0、第 6 视角任一 finding 仍保留人工 gate。P1 默认跳过确认进入 Compound；P0 强制项必须问。

Caveman mode review 展示：

```text
P0:
- path:line: bug/risk: problem. fix.
P1:
- path:line: risk/nit: problem. fix.
```

完整审查表仍写入 sprint 文档。

### Phase 5: Compound (自动执行)
```
Phase 5/5: Compound
[执行 /compound]
[填写文档复利记录，status → completed]
[sprint 文档的 frontmatter 添加 Obsidian tags]

🏁 Sprint 完成！
  文档: docs/plans/2026-06-20-xxx.md
  Checkpoints: N 次
  知识: M 条经验, K 个本能, J 个 skill 信号
  Auto mode: A gates 自动通过 / M gates 强制人工（仅当启用 --auto 时显示）
  Goal: <met|max-iter-reached|terminated>，迭代 <N>/<max>（仅当启用 --goal 时显示）
```

**Goal Loop 收尾（仅当 `--goal` 激活）**：Compound 完成后按「Goal Loop 协议 → 循环机制」判定是否重入，并强制打印 check 行：

```text
Goal loop: iter <N>/<max>, until=<exit code 或 n/a>, goal-met=<yes|no>, decision=<continue|stop:reason>
```

- decision=stop → 落定 `goal_status`，正常结束 sprint。
- decision=continue → 读磁盘 frontmatter，`goal_iteration` +1 写回，重入 Phase 1 Think（携带目标 + 上一轮 delta + 未达成原因）。

Caveman mode 收尾：

```text
Done: sprint completed
Doc: <path>
Knowledge: <N rules>, <M instincts>, <K signals>
Compact: yes/no + reason
```

## Phase 间预热协议（建议，非强制）

> **撤回历史**：2026-05-22 撤回"必须"约束。6 个月观察落地率 18% (9/49 plans)，价值未通过返工率量化，反方 cargo-cult 假设未被反驳。按 [[mechanism-over-discipline]] 隐含前提（协议先证明价值再 enforcement），降级为建议；接 enforcement 会触发 [[ADR-013]] enforcement 死亡风险（高频 `--no-verify`）。详见会话 2026-05-22 C2 评估。

每个 Phase 报告末尾**可选**追加「下一 Phase 预热」段，让用户 'go' 时模型上下文已就绪，节省 N→N+1 切换的探索往返。预热段非必填，跳过不视为协议违反。

### 预热段格式（可选）

```text
## 下一 Phase 预热（Phase N+1: <名称>）
关键文件: <1-3 个 N+1 必读路径>
执行命令: <1-2 个 N+1 起步探索命令>
风险预判: <1-3 行 N+1 潜在风险或注意点>
```

### 各 Phase 预热典型内容

| 当前 Phase | 下一 Phase | 典型关键文件 | 典型起步命令 |
|-----------|-----------|------------|------------|
| Think → Plan | Plan | `docs/plans/TEMPLATE.md`、相关 `rules/*.md` | `Grep` 相关 ADR、`Glob` 待改文件 |
| Plan → Work | Work | 计划列出的最高优先级文件 | 跑当前测试基线、读关键模块 |
| Work → Review | Review | `git diff` 输出、新增测试文件 | `git diff <base>...HEAD`、检查测试通过 |
| Review → Compound | Compound | sprint 文档的 review 段 | 读 P0/P1 处理记录、扫 rules/ 是否需更新 |
| Compound → 收尾 | （无下一 phase）| sprint 文档 frontmatter | 检查 status: completed、是否需 /compact |

### 设计原则

- ✅ 仅提示线索，不预先执行下一 phase 的操作
- ✅ 每段 ≤ 3 行，信息密度优先
- ✅ Caveman mode 也保留（密度高不浪费 token）
- ❌ 不复述当前 phase 的结论
- ❌ 不预先调用 LLM 生成下一 phase 的产物
- ❌ 不修改任何文件，纯文本提示

预热段失败（如无法确定下一 phase 关键文件）或主动跳过时，输出 `预热: 跳过 — <原因>` 即可，不阻塞流程；什么都不输出也合法（建议非强制）。

## 跨 Sprint 防漂移协议（Anti-Drift）

Sprint 拆分降低单次风险，但放大长期漂移。多 sprint 任务要保证质量，必须显式建模"跨 sprint 状态"。

### 为什么需要

Sprint 边界默认切断 3 类信息流：

1. **跨 sprint 不变量**：上 sprint 立的纪律（如 useMemo / nodeTypes 模块级常量）在新 sprint 看不到 diff，容易回归
2. **跨层集成路径**：API 在 task A，UI 在 task B，单 task acceptance 都通过但联起来是 dead code 或静默丢失
3. **历史决策语境**：上 sprint 留的"暂不做"在新 sprint 启动时无人盘点，半完成状态无限延期

不防护就会出现 3 类典型反模式：

| 反模式 | 实例 | 单 sprint review 为什么漏 |
|--------|------|--------------------------|
| 回归式反模式 | 上 sprint 加的 useMemo 在新 sprint 同类代码处缺失 | review 只看本 sprint diff，feedback memory 存在但无强制 cross-check |
| 集成断裂 | API 全套建好但 UI 不调用；state 校验通过但保存路径不含它 | 每 task acceptance 只检查"本 task 完成"，没有"用户走通整条路径" |
| 半完成漂移 | shared 下沉到一半；大文件持续新增不拆 | 单 sprint 看每改动都合理，无人监督整体方向是否仍一致 |

### 入场 checklist（Phase 2 Plan 强制）

每次新 sprint 进入 Phase 2 必须显式回答以下三项，写入 sprint 文档"## Phase 2: 技术方案"段开头：

#### 1. 回归扫描

列出本 sprint 触及的子系统在之前 sprint 立过的 invariant，每条作为本 sprint 隐式 acceptance：

```markdown
### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| ReactFlow | nodeTypes 模块级 const, adapter useMemo | 新接入文件复用相同模式 |
| TS↔Go DAG | sync test 守拓扑同步 | 改 DEFAULT_STAGE_DAG 必须同步 Go |
```

实操：在父需求 `docs/plans/<parent>.md` 或前置 sprint 文档的 frontmatter 中查 `invariants:` 字段，逐条照搬。

#### 2. 集成路径声明

每个新建 API / 持久化状态 / 跨层组件，必须画出"用户从点击到持久化再到刷新可见的完整链路"：

```markdown
### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| customEdges 拖线 | onConnect | setState | ❌ 内存 only | ❌ 丢失 |
| Layout API | savePipelineGraphLayout | controller → supabase | ✅ jsonb | ❌ UI 不调用 |
```

任一链路有"❌"必须显式归属：要么本 sprint 收口（添加缺失环节），要么文档化推迟到下一 sprint 并加 feature gate / 预览 banner 防止静默丢失。

#### 3. 半完成债务清单

上 sprint 留的 `⏭ Sprint X 议题` 必须二选一：

- **本 sprint 解决**：作为 task 加入 Phase 3 任务表
- **明确推迟**：写入 frontmatter `deferred:` 字段，附 deadline；超过 3 sprint 未落地必须正式撤回（写入"不做"决策，不再算半完成）

```markdown
### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| Sprint A | adapter 下沉 shared | ⏭ Sprint C | 2026-06-01 |
| Sprint B | editor-core 拆分 | ⏭ Sprint C | 2026-06-01 |
```

任一项空白即 Plan 不通过，强制 manual gate。

### Phase 3 局部回归（每 Task 完成）

每 Task 收尾必须跑（不只是本 task 新增测试）：

```bash
# 1. 本 task 新增测试（默认）
# 2. invariant_tests frontmatter 列表（强制）
# 3. 涉及子系统的 perf benchmark（强制）
# 4. TS↔Go contract test / sync test（如适用）
```

实操：sprint 文档 frontmatter 加 `invariant_tests:` 字段（见下方 frontmatter 示例）；Phase 3 Work 阶段每 task done 时自动跑这个列表。

### Phase 4 第 6 视角

见上方 Phase 4: Review 段的「第 6 视角 — 集成连续性」。

### 架构纪律标签

代码层面预防漂移，通过显式标签把"软纪律"变成"硬约束"：

| 标签 | 用途 | 实例 |
|------|------|------|
| `@FeatureGate("<name>")` 装饰器 | dead code API 必须挂 feature gate, 未启用时即使后端可用也 404 | Layout API 未接 UI 时 `@FeatureGate("layouts-ui")` |
| `Persistence: "memory" \| "session" \| "server"` 类型标签 | `useState` 涉及业务数据必须显式声明持久化层级 | `customEdges: PersistedState<"memory", Edge[]>` |
| `// @sizebudget <N>` 注释 | 大文件加行数上限注释, pre-commit hook 拒绝超额提交 | `// @sizebudget 800` |
| `@sprint-X-invariant` 测试标签 | sprint 立的不变量打标签, 所有后续 sprint 必跑 | `describe.concurrent("@sprint-a-invariant: ReactFlow perf", ...)` |
| `// @deadcode-until: <sprint>` 注释 | 标注"建好暂不用"代码, 必有 sprint deadline | Layout controller 顶部加 `// @deadcode-until: Sprint C` |

### Sprint 内 checkpoint 额外触发条件

Phase 3 中除"每 5 task / 退化信号"之外，新增触发条件：

- **invariant test 失败**：必 checkpoint 排查根因，不允许"暂时跳过"
- **新增 dead code 探测**：本 sprint 新增 API export 但 import 计数为 0 时打印警告，是否 checkpoint 由用户决定

### 复盘审计（每 2-3 sprint 一次）

跑"半完成债务清单"审计：

- 所有 `⏭ Sprint X 议题` 列项目要么落地要么撤回
- 不允许无限延期；超过 3 sprint 未落地必须正式撤回（写入"不做"决策）
- 审计结果写入根 sprint 文档（父需求）或独立 audit doc

实操：会话中说"`/sprint audit`" 触发，本 skill 扫描 `docs/plans/*.md` 的所有 `deferred:` 字段，输出过期/未跟踪条目清单。

## Sprint 文档 frontmatter（Obsidian 兼容 + Anti-Drift 扩展）

```yaml
---
title: "用户导出功能"
type: sprint
status: completed
created: "2026-06-20"
updated: "2026-06-21"
checkpoints: 1
tasks_total: 8
tasks_completed: 8
tags: [sprint, feature]
aliases: ["用户导出"]

# === Goal Loop 字段（仅 --goal 激活时写入）===
goal: "<目标原文>"
goal_max_iter: 3
goal_until: ""            # --until shell 命令；空 = 无确定性终止命令
goal_iteration: 0         # 已完成循环轮次，每轮重入前 +1（计数器 SoT，每轮重读磁盘）
goal_status: in-progress  # in-progress | met | max-iter-reached | terminated

# === Anti-Drift 扩展字段 ===

# 本 sprint 立的不变量，后续 sprint 必须保持
invariants:
  - "ReactFlow nodeTypes 必须模块级 const"
  - "adapter 输出必须 useMemo 包装"
  - "TS DEFAULT_STAGE_DAG 与 Go defaultStageDAG sync test 守住"

# 本 sprint 的不变量回归测试入口（Phase 3 每 task 必跑）
invariant_tests:
  - apps/web/app/ui/graph/__tests__/perf-bench.test.ts
  - apps/api/src/snapshot/snapshot.service.spec.ts  # 含 TS↔Go sync test

# 留给后续 sprint 的议题，标明 deadline；超过 3 sprint 未落地必须撤回
deferred:
  - sprint: C
    item: "adapter 下沉 shared (Sprint A 决策)"
    deadline: "2026-06-01"
    reason: "等 customEdges 持久化决策"
  - sprint: C
    item: "editor-core 1900+ 行拆分"
    deadline: "2026-06-01"
    reason: "Sprint A + B 累积技术债"

# 本 sprint 引入的 dead code / feature-gated 代码, 必填 owner 和 unblock 条件
deadcode_until:
  - path: "apps/api/src/pipeline-layouts/"
    until_sprint: C
    unblock: "editor-core 接入 fetchPipelineGraphLayout / save"
---
```

## 适用场景
- 中到大型功能开发
- 需要完整规划-实现-审查-学习流程
- 长任务（8+ Task）自动 checkpoint 保证不丢失进度

## 不适用
- 小 bug / 已知根因 bug → 隐式 `/work` bug 分支直接修 → 回归测试 → /compound
- 探索调研 → 自由对话 → /learn

