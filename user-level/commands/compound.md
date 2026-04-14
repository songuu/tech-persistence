---
description: "复利步骤：提取经验→写入本能+rules+解决方案+采集 skill 使用信号"
---

# /compound — 复利循环（核心步骤）

融合 Compound Engineering 的复利机制 + 本能系统的自动学习 + Skill 自迭代的信号采集。
**每次有意义的工作结束后都应执行。**

## 执行流程

### 步骤 1: 扫描会话，提取 6 类知识
| 类型 | 写入位置 |
|------|---------|
| 解决方案 | `docs/solutions/` + CLAUDE.md 索引 |
| 踩坑记录 | `.claude/rules/debugging-gotchas.md` |
| 架构决策 | `.claude/rules/architecture.md` |
| 行为本能 | `~/.claude/homunculus/instincts/` |
| 模式发现 | `.claude/rules/` 对应文件 |
| 性能数据 | `.claude/rules/performance.md` |

### 步骤 2: 生成解决方案文档
对每个解决的重要问题，创建 `docs/solutions/{date}-{slug}.md`（含 YAML frontmatter），并在 CLAUDE.md 的解决方案索引追加一行摘要。

### 步骤 3: 提取经验到 rules
项目特有 → `.claude/rules/`，跨项目通用 → `~/.claude/CLAUDE.md`。

### 步骤 4: 创建/更新本能
- 用户纠正 → type: user_correction, 置信度 0.5+
- 解决耗时 bug → type: error_resolution, 置信度 0.3-0.7
- 反复使用工作流 → type: repeated_workflow, 置信度 0.3
- 明确偏好选择 → type: tool_preference, 置信度 0.5
- 已有本能再次观察 → 置信度 +0.1

### 步骤 5: 整合 /review 发现
检查审查报告中标注 `[🧠 新发现]` 的条目，提取为本能或 rules。

### 步骤 6: 采集 Skill 使用信号（新增）
检查本次会话中执行过哪些 skill/命令，对每个记录：

```json
{
  "skill": "skill名",
  "timestamp": "ISO日期",
  "signals": {
    "invocation": "explicit|auto|skipped",
    "steps_completed": [1,2,3],
    "steps_skipped": [4],
    "user_corrections": ["具体纠正内容"],
    "outcome": "completed|abandoned",
    "related_instincts_created": ["id"]
  }
}
```

追加到 `~/.claude/homunculus/skill-signals/{skill-name}.jsonl`。

如果某 skill 的放弃率 > 30% 或纠正 3+ 次，附加提示：
```
💡 /prototype 近期使用信号异常（放弃率 40%），建议 /skill-diagnose prototype
```

### 步骤 7: 本能与 skill 差异标记
检查新创建的本能是否与某个现有 skill 相关但未被吸收。如果是，在本能文件中标记 `pending_absorption: "{skill-name}"`。累积 5+ 个待吸收本能时提示：
```
💡 5 个新本能与 /review 相关但未被吸收，建议 /skill-improve review --absorb
```

### 步骤 8: 输出报告
```
🔄 Compound 复利报告

📄 解决方案: N 个 → docs/solutions/
📝 经验: rules/ +N 条 | CLAUDE.md +N 条
🧠 本能: 🆕 N 个 | ⬆️ N 个
📊 Skill 信号: 采集 N 个 skill 的使用数据
⚠️ Skill 异常: [如果有]

本项目累计: N 解决方案, M 本能, K 条 rules
```
