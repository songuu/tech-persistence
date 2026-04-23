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

## 角色约束
- ✅ 关注：代码质量、测试覆盖、可维护性、按计划执行
- ❌ 不关注：需求变更（回退到 /think）、过度优化（YAGNI）

## 输入来源
1. `$ARGUMENTS` 中指定的计划文件或任务
2. `.codex/plans/plan-*.md` 最新的 plan
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

