---
description: "全面回顾：审查经验 + 审计本能 + 归档观察 + 裁剪过时内容"
---

# /retrospective — 阶段性技术回顾（自学习增强版）

对项目的所有知识层（经验、本能、观察、进化产物）做全面审查。

## 执行流程

### 1. 经验层审查
读取 `CLAUDE.md` 和 `.claude/rules/` 所有文件：
- 检查行数超标
- 检测重复/矛盾
- 对比 `package.json` 检测过时依赖引用

### 2. 本能层审计
读取 `~/.claude/homunculus/projects/{hash}/instincts/` 和全局本能：

```
🧠 本能审计

总计: N 个本能

置信度分布:
  🔵 核心(0.9+): N 个
  🟢 强(0.7+): N 个 — 这些在自动应用
  🟡 中等(0.5+): N 个
  🟠 初步(<0.5): N 个
  🔴 衰减(<0.2): N 个 — 建议清理

域分布:
  code-style: N | testing: N | debugging: N | ...

问题检测:
  ⚠️ N 个本能互相矛盾
  ⚠️ N 个本能 30+ 天未见，持续衰减
  ⚠️ N 个同域本能可聚类 (建议 /evolve)
  ⚠️ N 个进化产物未被确认写入 rules
```

### 3. 观察层归档
检查 `observations.jsonl` 大小：
- > 5MB → 自动归档到 `observations.archive/`
- 生成归档摘要（观察数、时间范围、主要工具）

### 4. 进化层检查
检查 `~/.claude/homunculus/evolved/` 和项目 `evolved/`：
- 未被确认的进化产物 → 提示审核
- 已确认并写入 rules 的 → 标记为已毕业

### 5. 跨层一致性检查
- rules 中的经验是否与高置信本能一致？
- 进化产物是否与 rules 重复？
- CLAUDE.md 的陷阱是否与 debugging-gotchas.md 同步？

### 6. 生成行动项

```
📌 回顾行动项

HIGH:
- [ ] 清理 N 个衰减本能 (< 0.2)
- [ ] 解决 N 处经验与本能矛盾
- [ ] 归档观察日志 (当前 XMB)

MEDIUM:
- [ ] 聚类 N 组相关本能 (/evolve)
- [ ] CLAUDE.md 迁移 N 行到 rules/
- [ ] 审核 N 个进化产物

LOW:
- [ ] 统一日期格式
- [ ] 补充 {domain} 领域的经验

执行哪些? (输入编号，或 'all-high' 执行所有 HIGH 项)
```

### 7. 执行确认
逐条确认后执行。删除操作会先备份到 `.archive/` 目录。
