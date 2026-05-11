# [项目名称]

> 请将 [项目名称] 替换为实际名称。保持本文件 < 200 行。

## 项目概述
- **定位**：[一句话描述]
- **技术栈**：[语言] + [框架] + [数据库] + [部署]
- **仓库结构**：`src/` 业务 | `tests/` 测试 | `scripts/` 工具

## 常用命令
```bash
pnpm dev          # 开发
pnpm build        # 构建
pnpm test         # 测试
pnpm lint         # 检查
```

## 架构约定
- [关键架构约定]

## 自学习系统
本项目启用了基于 Hook 的自动学习：
- PreToolUse/PostToolUse 自动捕获观察
- Stop 时自动分析模式并创建本能
- SessionStart 时自动注入近期上下文和高置信本能
- 运行 `/instinct-status` 查看已学习的项目本能
- 运行 `/evolve` 将成熟本能进化为 skill/command
- 观察和本能存储在 `~/.codex/homunculus/projects/` 下

## 关键决策记录
<!-- 由 /learn 自动追加 -->

## 已知陷阱（高频）
<!-- 只放最高频的坑，详细在 .codex/rules/debugging-gotchas.md -->
- Claude-side 已有 `settings.json` 但缺 hook 时不能只警告；必须结构化 merge 并跑 `validate-claude-install.js`，否则学习层静默失效。

## 解决方案索引
- [2026-05-11] [claude/hooks/installer] 已有 Claude-side settings 缺 hooks 会让学习层静默失效；新增结构化 hook merger + Claude 安装态 validator → `docs/solutions/2026-05-11-claude-settings-hook-merge.md`

## 当前迭代重点
- [ ] [当前任务]
