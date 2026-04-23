---
description: "全面回顾：经验审查 + 本能审计 + Skill 诊断 + 观察归档 + 裁剪"
---

# /retrospective — 阶段性回顾（含 Skill 诊断）

## 执行流程

### 1. 经验层审查
检查 AGENTS.md 行数、rules 文件行数、重复/矛盾/过时条目。

### 2. 本能层审计
置信度分布、衰减预警、可聚类的本能组。

### 3. Skill 健康诊断（自动附带）
对所有有信号数据的 skill 执行 `/skill-diagnose`，输出摘要：
```
Skill 健康概览:
  /prototype: 🟡 建议迭代 (3 个步骤跳过率 > 30%)
  /review: 🟢 健康
  /compound: 🟢 健康
  /plan: 🟡 2 个新本能待吸收
```

### 4. 观察层归档
observations.jsonl > 5MB → 自动归档。

### 5. 跨层一致性
rules 与高置信本能是否一致？进化产物是否与 rules 重复？

### 6. 生成行动项
按 HIGH/MEDIUM/LOW 列出，等待确认后执行。
