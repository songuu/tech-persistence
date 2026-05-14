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

## 消费 [P] 标记的协议

当 plan §4 任务清单中存在 `[P]` 标记时：

**连续处理（推荐）**：可在同一轮回复中连续完成多个 `[P]` task 的代码修改（如多个 Edit / Write 工具调用），但每个 task 仍需：
- 独立做风险等级评估
- 按风险等级写测试 / 跑测试
- 勾选 §4 task checkbox
- 在变更日志记录

**冲突检测（必须，按算法执行）**：开始 `[P]` 批量处理前：
1. 从 plan §4 抽取本批 `[P]` task 的 `文件:` 字段，构造路径集合
2. 集合 size 必须等于 task 数 — 任何重叠路径都需降级为串行
3. 单 task 改多文件时按文件集合的**交集**判断（∩ = ∅ 才算无冲突）
4. 发现 plan 标 `[P]` 但实际冲突 → 立刻降级为串行 + 在变更日志记"plan [P] 标错"

**失败传播（必须）**：任何 `[P]` task 测试失败 → **立刻停止本批剩余 `[P]` task**，转入 3 轮调试循环修复该 task；不得跳过失败 task 继续后续 `[P]`。失败 task 修复后可继续本批；3 轮仍失败按"偏差处理"协议暂停报告。

**禁止行为**：
- ❌ 把多个 `[P]` task 合并成一个 checkbox 勾选
- ❌ 跳过单个 task 的测试因为"反正同批 [P]"
- ❌ 把 `[P]` 当作"批量略过 review"的借口
- ❌ 跳过失败 task 继续后续 `[P]`（违反"失败传播"）

**checkpoint 处理**：如果 `[P]` 批中途需要 checkpoint，handoff 文件必须列出"本批 [P] 已完成 X 个，剩余 Y 个"，恢复时按剩余继续。

**与 `agent-loop --pipeline` 的区别**：`[P]` 是单 LLM 连续处理提示，**不是**多进程调度。真正需要跨 agent 并发请用 `agent-loop --pipeline`。

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

完整 sprint 内执行时（`/sprint` 调用），本命令报告末尾**必须**追加「下一 Phase 预热」段。协议见当前命令集合中 `sprint.md` 的「Phase 间预热协议」。

本命令的典型预热内容：

```text
## 下一 Phase 预热（Phase 4: Review）
关键文件: 本次 diff 涉及的核心文件、新增/修改的测试文件
执行命令: git diff <base>...HEAD（看完整 diff）、跑完整 test suite
风险预判: 漏改的相邻代码、风险等级与测试深度不匹配、未覆盖的 edge case
```

单独使用本命令（不在 sprint 内）时，预热段建议但非必须。

