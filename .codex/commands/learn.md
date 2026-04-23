---
description: "从当前会话提取项目特有的技术经验和本能"
---

# /learn — 项目级经验提取

只提取**项目特有**的经验。通用经验用用户级 `/learn`。

## 步骤
1. 读取 AGENTS.md、`.codex/rules/`、项目本能、`package.json`
2. 提取经验 + 本能（含依赖版本上下文）
3. 写入 `.codex/rules/` 和 `homunculus/projects/{hash}/instincts/`
4. 输出报告

## 写入位置
| 类型 | 位置 |
|------|------|
| 架构决策 | `.codex/rules/architecture.md` |
| 踩坑调试 | `.codex/rules/debugging-gotchas.md` |
| 性能经验 | `.codex/rules/performance.md` |
| 测试模式 | `.codex/rules/testing-patterns.md` |
| API 规范 | `.codex/rules/api-conventions.md` |
| 高频陷阱 | `AGENTS.md` → 已知陷阱 |
| 项目本能 | `homunculus/projects/{hash}/instincts/` |
