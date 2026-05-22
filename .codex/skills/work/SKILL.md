---
name: work
description: Codex-compatible entry point for the former /work command. 工程师模式：按计划逐步实现，每步按风险等级自动测试
---

# Work

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/work` command.

## Invocation

Use `$work <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/work`, interpret that as this `$work` skill invocation while running in Codex.

## Command Instructions

# /work — 工程执行模式

切换到高级工程师视角。按计划逐步实现。

## 用法

```
/work                  ← 按计划执行
/work --auto           ← 自动审查模式：L0-L2 直接通过，L3 视置信度，L4/destructive 仍问
```

## 可选参数

- `--auto`：自动审查模式。每个 Task 完成后是否进入下一个，由模型按风险等级 / 置信度 / 用户行为自主判断。L4 任务、destructive 操作、测试失败、scope 偏离仍强制人工。详见 `~/.codex/rules/auto-mode.md`。

## 角色约束
- ✅ 关注：代码质量、测试覆盖、可维护性、按计划执行
- ❌ 不关注：需求变更（回退到 /think）、过度优化（YAGNI）

## 输入来源
1. `$ARGUMENTS` 中指定的计划文件或任务
2. `docs/plans/` 下最新的 sprint/plan 文档（由 /think 或 /plan 创建）
3. 对话上下文

## 每个 Task 的执行循环

```
读取 Task 描述
  ↓
实现代码变更
  ↓
风险评估 (自动，基于变更文件):
  ├── L0 (纯样式/文案) → 跳过测试
  ├── L1 (低风险新增) → 写 1-3 个冒烟测试 → 运行
  ├── L2 (常规开发) → 写 5-10 个标准测试 → 运行
  └── L3-L4 (核心逻辑) → 写严格/全面测试 → 运行
       ↓
  ├── 通过 → 标记 Task 完成，进入下一个
  └── 失败 → 判断是代码 bug 还是测试错误
       ├── 代码 bug → 修复代码 → 重跑
       └── 测试错误 → 修正测试 → 重跑
       (最多 3 轮，仍失败则暂停报告)
```

## Worker spawn 协议（[P] 真并行）

**目的**：用 Codex Agent tool 真 spawn N 个独立 worker 子进程并行实施 `[P]` 同批 task，达成 3 个核心目标 —— 分工明确（每 worker 单一 task 单一文件清单）+ 减少总时间（N×T → 1×T）+ 提高效率（独立 worktree 隔离 + 模型分层）。

> 以下"真并行 spawn"仅对支持 Agent spawn 的 runtime 生效。Codex CLI 见下方「Multi-runtime fallback」段。

### 触发条件

当 plan §4 任务清单中存在 `[P]` 标记时，按以下规则决定 spawn 还是 batch：

| 条件 | spawn 模式（Codex）| batch 模式（fallback）|
|------|------------------------|---------------------|
| `[P]` task 数 ≥ 2 | ✅ 真 spawn N worker 并行 | ❌（单 task 无并行收益）|
| 所有 `[P]` task 风险 ≤ L2 | ✅ | ❌（L3+ 必须 batch，不 spawn）|
| runtime 是 Codex | ✅ | ❌ |
| 通过冲突检测算法 | ✅ | ❌ → 降级 batch + 记 "plan [P] 标错" |

### 冲突检测算法（必须，spawn 前执行）

1. 从 plan §4 抽取本批 `[P]` task 的 `文件:` 字段，构造路径集合
2. 集合 size 必须等于 task 数 — 任何重叠路径都需降级为串行
3. 单 task 改多文件时按文件集合的**交集**判断（∩ = ∅ 才算无冲突）
4. 发现 plan 标 `[P]` 但实际冲突 → 立刻降级为串行 batch + 在变更日志记 "plan [P] 标错"

### Spawn 调用语法

通过冲突检测的 `[P]` 同批 task，**单条 message 内** spawn N 个 Agent：

```
Agent(
  subagent_type: "general-purpose",
  model: "<haiku | sonnet>",
  isolation: "worktree",      // 必须！每 worker 独立 git worktree
  prompt: "<下方 Worker prompt template>"
)
Agent(...) // N 个 worker 并发
```

**`isolation: "worktree"` 是强制要求**：Agent tool 自动创建临时 git worktree，每 worker 在独立 working tree 工作，避免共享文件 race condition。worker 无 changes 或失败时 worktree 自动清理。

### 模型分层

| 任务风险 | 模型层级 |
|---------|---------|
| L0 / L1（纯样式 / 低风险新增）| `haiku` |
| L2（常规开发）| `sonnet` |
| L3+ | 不 spawn（必须串行 batch）|

### 4 status 返回契约（与 reviewer 共享）

每个 worker 输出末尾必须含且仅含一行：

```
STATUS: <DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED>
```

状态定义：
- `DONE`：task 实施完成，测试全过
- `DONE_WITH_CONCERNS`：task 实施完成，但有偏离 plan 描述 / lint 警告 / 测试 flaky 等
- `NEEDS_CONTEXT`：worker 无法完成 task，需主 LLM 补充上下文（必须说明缺什么）
- `BLOCKED`：结构性阻塞（如 task 描述矛盾 / 依赖未完成 / 测试基线失败）

**兜底**：worker 漏输出 STATUS 行 → 主 LLM 视为 `DONE_WITH_CONCERNS`。

## Worker prompt template

```
你是 worker subagent，负责实施单一 task。

Task: <task 描述>
涉及文件: <file list（来自 plan §4 文件字段）>
风险: <L?>
测试要求（按风险等级）:
  - L0: 跳过测试
  - L1: 1-3 个冒烟测试
  - L2: 5-10 个标准测试

约束：
- 仅修改 task 涉及的文件
- 在本 worktree 内实施 + 跑测试 + 验证通过
- **必须用相对路径写文件**（相对于本 worktree 根 = 当前 CWD），禁止用绝对路径（绝对路径会绕过 worktree 隔离，写到主 repo 污染父进程）
- **实施完成后必须 `git add <files> && git commit -m "[worker] <task 摘要>"`**，否则 worktree branch 与 main 等价，主 LLM 无法 cherry-pick / merge
- 不勾选 sprint.md checkbox（主 LLM 串行 apply 后才勾）

输出格式：
1. 实施摘要：哪些文件改了（必须列相对路径），关键变更（≤ 200 字），git commit hash
2. 测试结果：跑的命令 + pass/fail + 用例数
3. 末尾必须一行: STATUS: <DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED>

约束（重申）：
- 不写文件超出 task 涉及清单
- 必须 commit 改动（否则 patch 收集失败）
- 必须用相对路径（否则破坏 worktree 隔离）
- NEEDS_CONTEXT 必须说明缺什么
- BLOCKED 必须说明结构性阻塞原因
```

### Patch 收集与 apply（主 LLM 责任）

worker 完成后，Agent tool 返回 worktree path + branch（有 changes 时）或自动清理（无 changes / 失败时）。

主 LLM 按以下顺序处理：

1. **收集**：N 个 worker 完成后，按返回顺序收集每 worker 的 worktree branch
2. **审视**：每 worker 的实施摘要 + STATUS 一一审查
3. **串行 apply**：
   - 所有 STATUS=DONE/DONE_WITH_CONCERNS → 依次 cherry-pick 或 merge worktree branch 到主分支
   - 任一 STATUS=NEEDS_CONTEXT → retry 流程（≤ 1 次硬限）
   - 任一 STATUS=BLOCKED → escalation 流程（强制人工 gate）
4. **回归测试**：apply 完所有 patch 后，跑一次整套测试验证组合效果
5. **勾选 + 变更日志**：每 task 单独勾 sprint.md checkbox + 单独记变更日志

### NEEDS_CONTEXT retry / BLOCKED escalation（与 reviewer 共享）

- **NEEDS_CONTEXT retry**：主 LLM 补 context → 重 spawn 该 worker（≤ 1 次硬限）→ 第 2 次仍 NEEDS → 视为 DONE_WITH_CONCERNS 并报告
- **BLOCKED escalation**：强制人工 gate，即使 `--auto` 也必须问

### 失败传播（保留原 [P] 协议规则）

任何 worker 测试失败 → **立刻停止本批剩余 worker 的 apply**，转入 3 轮调试循环修复该 task；不得跳过失败 worker 继续后续 apply。失败 task 修复后可继续本批 apply；3 轮仍失败按"偏差处理"协议暂停报告。

### 禁止行为

- ❌ spawn 没带 `isolation: "worktree"`（race condition 必现）
- ❌ worker 用绝对路径写文件（如 `C:\project\...` / `/c/project/...`）— 会绕过 worktree 隔离写到主 repo（2026-05-15 dogfood 实证 worker B 失败 case）
- ❌ worker 完成后未 `git commit`（branch 与 main 等价，cherry-pick 为空 — 2026-05-15 dogfood 实证 worker A 失败 case）
- ❌ 把多个 `[P]` task 合并成一个 checkbox 勾选
- ❌ 跳过单个 task 的测试因为"反正同批 [P]"
- ❌ 把 `[P]` 当作"批量略过 review"的借口
- ❌ 跳过失败 worker 的 patch 继续后续 apply（违反"失败传播"）
- ❌ worker 在自己 worktree 外写文件（违反 task 涉及文件约束）

### Checkpoint 处理

如果 `[P]` 批中途需要 checkpoint，handoff 文件必须列出：
- 本批 `[P]` 已 apply 几个 worker patch
- 还有几个 worker 在跑 / 已完成待 apply
- 失败 worker 列表
- 恢复时按剩余 patch 继续 apply

## Multi-runtime fallback

| runtime | spawn 机制 | 行为 |
|---------|----------|------|
| **Codex** | Agent tool + `isolation: "worktree"` | 上述真 worker spawn 协议生效 |
| **Codex CLI** | 不可用（无 Agent tool 等价物）| 主 LLM 在单 context 内连续处理 `[P]` 同批 task（保留旧 batch 行为，但仍遵守冲突检测 + 失败传播 + 禁止行为）|

**Codex 端 batch 模式**：主 LLM 在同一轮回复中连续完成多个 `[P]` task 的代码修改（如多个 Edit/Write 工具调用），每个 task 仍需独立做风险评估 / 写测试 / 跑测试 / 勾 checkbox / 记变更日志。本批所有 task 完成后再进入下一批 / 下一 Phase。

### 与 `agent-loop --pipeline` 的区别

`[P]` 是 sprint 内多 task 的并行实施模式（Codex 端用 Agent tool 在主 sprint 同一对话内 spawn worker 并行；Codex 端 batch fallback）。`agent-loop --pipeline` 是跨 sprint 跨 agent 的流水线（spec → impl → review），是不同抽象层级，**不要混用**。

## 质量门（每个 Task 完成时检查）
- [ ] 代码能编译/运行
- [ ] 测试等级匹配风险等级
- [ ] 测试全部通过
- [ ] Bug 修复有回归测试
- [ ] 没有引入 lint 错误
- [ ] 变更范围不超出 Task 定义

## 偏差处理
- 发现计划遗漏了某个步骤 → 标注但继续，不自作主张修改计划
- 发现更好的实现方式 → 记录为备注，按原计划实现，/review 时讨论
- 遇到计划外的 blocker → 立即暂停并报告

## 非平凡 bug 调试入口规则（反馈环优先）

**触发条件**（满足任一即适用）：
- Task 测试连续失败 ≥ 2 轮且根因不明
- 用户报告 bug 但行为偏差与 root cause 不直接对应
- `/sprint` 外的临时调试场景（同样适用，本规则不限于 `/work` 内）

**核心规则**：进入单假设修复前，必须先建立**最小反馈环**——一个快速、确定、agent 可运行的 pass/fail signal。可选形式（按优先级）：

1. 失败测试（最常用，最确定）
2. curl / CLI fixture
3. 浏览器脚本 / DevTools snippet / trace replay
4. throwaway harness（一次性可执行复现器）
5. git bisect / differential loop（已知好版本 vs 坏版本）

**没有反馈环时禁止进入单假设修复**。必须显式报告：
- 已尝试构建反馈环的手段
- 为什么当前手段不构成确定的 pass/fail signal
- 需要主 LLM / 用户补充什么才能建立反馈环

**不适用**：
- 已知根因的简单 fix（typo / 缺 import / 语义清楚的 null check / 类型不匹配）
- L0 样式 / 文案修改
- 反馈环已存在（如 task 测试已写好且能稳定复现失败）

**为什么这条是 entry rule 而非 tactical lesson**：`debugging-gotchas.md` 是 lessons archive（注入时被读），但反馈环优先是 *修 bug 入口时* 才需要触发的判断。落在 `/work` 这里保证在 bug 修复开始那一刻生效，而不是事后才被记起。

## 进度报告
每完成 1 个 Task：
```
✅ Task N/M: [描述]
   文件: [修改的文件]
   测试: L[X] — Y 用例通过
```

全部完成：
```
🏁 所有 Task 完成 (N/M)
   测试: X 用例全部通过 (L0: N文件免测, L2: N文件, L3: N文件)
   建议执行 /review
```

## Phase 间预热钩子

完整 sprint 内执行时（`/sprint` 调用），本命令报告末尾**可选**追加「下一 Phase 预热」段（2026-05-22 起改建议非强制）。协议见当前命令集合中 `sprint.md` 的「Phase 间预热协议」。

本命令的典型预热内容：

```text
## 下一 Phase 预热（Phase 4: Review）
关键文件: 本次 diff 涉及的核心文件、新增/修改的测试文件
执行命令: git diff <base>...HEAD（看完整 diff）、跑完整 test suite
风险预判: 漏改的相邻代码、风险等级与测试深度不匹配、未覆盖的 edge case
```

单独使用本命令（不在 sprint 内）时，预热段建议但非必须。

