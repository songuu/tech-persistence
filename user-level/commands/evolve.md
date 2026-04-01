---
description: "将高置信度本能聚类进化为可复用的 skill、command 或 agent"
---

# /evolve — 本能进化

分析所有高置信度本能，找出可以聚类的相关本能组，
将它们进化为更高阶的产物：skill、command 或 agent。

## 执行步骤

### 1. 加载候选本能
从以下位置读取置信度 >= 0.5 的本能：
- `~/.claude/homunculus/projects/{project}/instincts/`
- `~/.claude/homunculus/instincts/personal/`

### 2. 按域聚类

将本能按 `domain` 标签分组，找出同域内 3+ 个相关本能的组：

```
code-style 域 (5 个本能):
  - prefer-functional-style (0.75)
  - use-const-over-let (0.80)
  - avoid-class-components (0.65)
  - prefer-arrow-functions (0.55)
  - destructure-props (0.70)
→ 🎯 可聚类为 "代码风格规范" skill
```

### 3. 建议进化方案

对每个可聚类的组，分析最适合的进化形态：

| 进化形态 | 适合场景 | 产物位置 |
|---------|---------|---------|
| **Skill** | 一组相关的行为规范/工作流 | `~/.claude/homunculus/evolved/skills/` |
| **Command** | 可以用 /slash 命令触发的流程 | `~/.claude/homunculus/evolved/commands/` 或 `.claude/commands/` |
| **Agent** | 需要专门子代理处理的复杂任务 | `~/.claude/homunculus/evolved/agents/` |
| **Rule** | 成熟到可以成为永久规则的经验 | `.claude/rules/` |

### 4. 生成进化产物

**Skill 格式**:
```markdown
---
description: "自动生成的技能：[描述]"
evolved_from: ["instinct-id-1", "instinct-id-2", ...]
evolved_date: "YYYY-MM-DD"
---

# [技能名称]

## 何时触发
[综合所有源本能的触发条件]

## 行为规范
[综合所有源本能的行为指导]

## 来源证据
[列出各本能的关键证据]
```

**Command 格式**:
```markdown
---
description: "[命令描述]"
evolved_from: ["instinct-id-1", "instinct-id-2", ...]
---

# /[命令名] — [描述]

[综合工作流步骤]
```

### 5. 输出报告

```
🧬 本能进化分析

发现 {n} 个可进化的聚类:

聚类 1: "代码风格规范" (5 个本能, 平均置信度 0.69)
  来源: prefer-functional-style, use-const-over-let, ...
  建议: → 进化为 Skill
  预览: .claude/skills/coding-style-conventions/SKILL.md

聚类 2: "测试前置检查" (3 个本能, 平均置信度 0.72)
  来源: lint-before-test, typecheck-first, ...
  建议: → 进化为 Rule (写入 .claude/rules/testing-patterns.md)
  
是否执行进化? (输入聚类编号，或 'all')
```

### 6. 执行后
- 生成的文件写入对应目录
- 源本能不删除，但标记 `evolved_into: "产物路径"`
- 输出 `git diff` 建议
