---
description: "记录调试过程并自动生成调试本能"
---

# /debug-journal — 调试日志

解决棘手 bug 后使用。记录完整调试过程 + 自动提取调试本能。

## 记录格式
```markdown
- [YYYY-MM] [领域] **标题**
  - 现象：用户观察到的表现
  - 误导方向：一开始以为是什么
  - 排查路径：关键排查步骤
  - 根因：最终确认的原因
  - 解决：具体修复方案
  - 预防：如何避免再次发生
```

写入 `.codex/rules/debugging-gotchas.md`。
CRITICAL bug 同时在 AGENTS.md 的"已知陷阱"加一行。
自动创建 debugging 域本能（CRITICAL→置信度 0.7，HIGH→0.5，MEDIUM→0.3）。
