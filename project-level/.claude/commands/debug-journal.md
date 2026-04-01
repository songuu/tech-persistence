---
description: "记录调试过程并自动生成调试本能"
---

# /debug-journal — 调试日志（自学习增强版）

解决棘手 bug 后使用。不仅记录调试过程，还自动从中提取可复用的调试本能。

## 执行步骤

### 1. 回顾调试过程
分析本次会话中的调试活动，生成结构化记录。

### 2. 写入经验（→ rules/debugging-gotchas.md）
```markdown
- [YYYY-MM] [领域] **标题**
  - 现象：用户观察到的表现
  - 误导方向：一开始以为是什么
  - 排查路径：关键排查步骤
  - 根因：最终确认的原因
  - 解决：具体修复方案
  - 预防：如何避免再次发生
```

### 3. 自动提取调试本能

从调试过程中识别可复用的行为模式，创建本能：

**错误解决本能** (type: error_resolution)：
```yaml
id: "fix-{错误关键词}"
trigger: "当遇到 {类似错误模式} 时"
confidence: 0.5
domain: "debugging"
action: "先检查 {根因方向}，而非 {误导方向}"
```

**排查路径本能** (type: repeated_workflow)：
```yaml
id: "debug-{场景}"
trigger: "调试 {类似场景} 时"
confidence: 0.5
domain: "debugging"
action: "按以下顺序排查: 1. ... 2. ... 3. ..."
```

### 4. 严重程度 → 置信度映射
- CRITICAL bug → 本能初始置信度 0.7（高频踩坑，需要立即记住）
- HIGH bug → 本能初始置信度 0.5
- MEDIUM/LOW → 本能初始置信度 0.3

### 5. 如果根因非常典型
同时在 `CLAUDE.md` 的"已知陷阱"中加一条简短提示（一行内）。

### 6. 输出报告
```
🐛 调试日志已记录

经验: → .claude/rules/debugging-gotchas.md (CRITICAL)
本能: 🆕 fix-auth-race-condition (debugging, 0.7)
      🆕 debug-check-env-first (debugging, 0.5)
陷阱: → CLAUDE.md (已追加)
```
