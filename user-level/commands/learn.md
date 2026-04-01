---
description: "从当前会话提取技术经验 + 创建/更新本能"
---

# /learn — 智能经验提取（自学习增强版）

你是一个技术知识管理专家，具备本能系统的感知能力。
分析当前会话中的所有对话内容，提取有价值的技术经验，同时更新本能系统。

## 提取流程

### 第一步：读取现有知识
1. 读取 `CLAUDE.md` 了解已有核心知识
2. 读取 `.claude/rules/` 下所有文件了解已有分类经验
3. 读取 `~/.claude/homunculus/projects/` 下当前项目的本能（如果存在）
4. 读取 `~/.claude/homunculus/instincts/personal/` 下全局本能

### 第二步：扫描会话，多维度提取

**经验维度**（写入 rules 文件）：
- 踩坑记录：遇到的报错、异常行为、非直觉 API
- 调试经验：定位问题的关键线索和思路
- 架构决策：设计选择及其原因
- 性能发现：优化手段和实测效果
- 最佳实践：发现的更好做法
- 工具技巧：命令行、编辑器、框架高效用法

**本能维度**（写入 instinct 文件）：
- 用户纠正：你（Claude）被纠正了什么行为？→ 创建纠正本能
- 工具偏好：用户偏好哪种工具/方法？→ 创建偏好本能
- 重复模式：什么工作流被反复执行？→ 创建工作流本能
- 错误解决：用什么方法解决了错误？→ 创建解决本能

### 第三步：质量筛选

每条经验必须通过：
1. **有具体场景**：不是空泛建议，有触发条件
2. **有根因分析**：不只是 what，还有 why
3. **有解决方案**：不只记录问题，还有如何解决
4. **不重复**：检查已有内容，跳过重复

每个本能必须满足：
1. **原子化**：一个本能只描述一个行为
2. **有触发条件**：什么场景下应该触发
3. **有证据**：基于本次会话的具体观察
4. **有置信度评分**：0.3(初步) / 0.5(中等) / 0.7(强) / 0.9(核心)

### 第四步：分类写入

**经验写入位置决策树**：
```
适用于所有项目？
├── 是 → ~/.claude/CLAUDE.md 的对应子章节
└── 否 → 什么领域？
    ├── 架构决策 → .claude/rules/architecture.md
    ├── 踩坑/调试 → .claude/rules/debugging-gotchas.md
    ├── 性能相关 → .claude/rules/performance.md
    ├── 测试相关 → .claude/rules/testing-patterns.md
    ├── API 设计 → .claude/rules/api-conventions.md
    └── 其他 → 新建 .claude/rules/{topic}.md
```

**本能写入位置**：
```
通用行为（与项目无关）？
├── 是 → ~/.claude/homunculus/instincts/personal/{id}.md
└── 否 → ~/.claude/homunculus/projects/{project-hash}/instincts/{id}.md
```

**本能文件格式**：
```yaml
---
id: "描述性ID"
trigger: "在什么场景下触发"
confidence: 0.5
domain: "code-style|testing|git|debugging|performance|architecture|security|toolchain|api-design|workflow"
type: "user_correction|error_resolution|repeated_workflow|tool_preference|discovery|decision"
source: "session-observation"
created: "YYYY-MM-DD"
last_seen: "YYYY-MM-DD"
scope: "project|global"
---

# 简短标题

## Action
具体应该做什么

## Evidence
- YYYY-MM-DD: 观察到的具体证据
```

### 第五步：冲突处理
- 新经验与旧经验矛盾 → 更新旧条目，标注更新日期
- 新本能与旧本能矛盾 → 旧本能置信度 -0.1，新本能正常写入
- 两者适用于不同场景 → 都保留，补充适用条件

### 第六步：输出报告

```
📝 本次会话提取完成

经验提取：
| # | 经验摘要 | 级别 | 写入位置 |
|---|---------|------|---------|
| 1 | ... | CRITICAL | .claude/rules/xxx.md |

本能更新：
| # | 本能 ID | 域 | 置信度 | 状态 |
|---|---------|-----|--------|------|
| 1 | prefer-xxx | code-style | 0.5 | 🆕 新建 |
| 2 | use-xxx | testing | 0.7 | ⬆️ 提升 |

✅ 经验: 写入 X 条, 跳过 Y 条重复
🧠 本能: 新建 X 个, 更新 Y 个

💡 提示: 运行 git diff .claude/ 查看变更
💡 提示: 运行 /instinct-status 查看所有本能
```
