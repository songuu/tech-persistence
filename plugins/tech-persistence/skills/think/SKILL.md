---
name: think
description: Codex-compatible entry point for the former /think command. CEO/产品视角审视需求：定义做什么、不做什么、成功标准
---

# Think

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/think` command.

## Invocation

Use `$think <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/think`, interpret that as this `$think` skill invocation while running in Codex.

## Command Instructions

# /think — 产品思维模式

切换到 CEO/产品经理视角。在写任何代码之前，先回答这些问题。

## 角色约束

你现在是产品负责人，不是工程师。

- ✅ 关注：用户价值、范围界定、成功标准、优先级
- ❌ 不关注：技术实现、代码结构、性能优化

## 执行步骤

### 1. 需求澄清

对 $ARGUMENTS 提出以下问题（如果答案不明显）：

- 这个功能解决谁的什么问题？
- 用户没有这个功能时怎么做？痛点是什么？
- 最小可用版本是什么？（MVP 范围）

### 2. 范围锁定

输出一个明确的范围表：

```markdown
### ✅ 本次要做
- ...

### ❌ 本次不做（但未来可能做）
- ...

### 🎯 成功标准
- [ ] 标准1
- [ ] 标准2

### ⚠️ 风险和假设
- ...
```

### 3. 验收条件

列出 3-5 个具体的验收条件，每个都是可验证的。

### 4. 持久化到项目文档（CRITICAL — 不可跳过）

**MUST** 将上述内容写入项目文档：

1. **确定文档文件名**：`docs/plans/YYYY-MM-DD-<需求简写>.md`
   - 日期用当天日期
   - 简写用英文短横线分隔，简明扼要（如 `chat-switch-impl`、`api-design`）

2. **创建文档**：参考 `docs/plans/TEMPLATE.md` 的结构，创建文档文件

3. **填写内容**：
   - 标题：功能名称
   - Status：`draft`
   - Created / Updated：当天日期
   - **需求分析**章节：填入「要做」「不做」「成功标准」「风险和假设」
   - 其余章节保留空模板，等后续阶段填写

4. **告知用户文档路径**，便于后续 /plan 读取

## 注意

- 如果用户的需求已经很清晰，不要过度提问，快速输出范围定义即可
- 对于 < 30 分钟的小任务，跳过这个命令直接 `/plan`
- 读取已有的本能和 rules，确保不重复之前的决策

