---
description: "从当前会话提取项目特有的技术经验和本能"
---

# /learn — 项目级经验提取（自学习增强版）

分析当前会话，提取与本项目相关的经验和本能。

## 与用户级 /learn 的区别
- 只提取**项目特有**的经验，通用经验用用户级 /learn
- 本能默认写入项目目录而非全局目录
- 会同时检查项目的 `package.json` / `pyproject.toml` 等依赖信息，为经验添加版本上下文

## 执行步骤

### 1. 读取项目上下文
- `CLAUDE.md` 的决策记录和已知陷阱
- `.claude/rules/` 所有文件
- `~/.claude/homunculus/projects/{hash}/instincts/` 已有本能
- `package.json` 或等效依赖文件（提供版本上下文）

### 2. 提取经验 + 本能
同用户级 /learn 的提取逻辑，但增加：
- 每条经验自动关联当前依赖版本（如 `[React 19.x]`）
- 检测是否有已存在的观察日志可以辅助分析

### 3. 写入位置

| 类型 | 位置 |
|------|------|
| 架构决策 | `.claude/rules/architecture.md` |
| 踩坑调试 | `.claude/rules/debugging-gotchas.md` |
| 性能经验 | `.claude/rules/performance.md` |
| 测试模式 | `.claude/rules/testing-patterns.md` |
| API 规范 | `.claude/rules/api-conventions.md` |
| 高频陷阱 | `CLAUDE.md` → 已知陷阱 |
| 关键决策 | `CLAUDE.md` → 关键决策记录 |
| 项目本能 | `~/.claude/homunculus/projects/{hash}/instincts/` |

### 4. 输出报告
```
📝 项目经验提取完成 [{project_name}]

经验: 写入 X 条 | 跳过 Y 条重复
本能: 新建 X 个 | 更新 Y 个

💡 git diff .claude/  查看变更
💡 /instinct-status  查看所有本能
```
