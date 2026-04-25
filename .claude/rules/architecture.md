# 架构决策记录 (ADR)

> 记录关键架构决策。由 /learn 自动追加，也可手动编辑。
> 当同类决策的本能置信度达到 0.9 时，会从本能"毕业"写入此处。

## 格式
<!--
### ADR-NNN: [标题] (YYYY-MM-DD)
- **状态**：已采纳 / 已废弃
- **上下文**：为什么需要做这个决策
- **决策**：选择了什么
- **原因**：为什么
- **备选**：未采纳的方案
- **影响**：约束或后果
- **来源本能**：[如果从本能毕业，记录原始 instinct ID]
-->

## 决策列表

### ADR-002: Codex Memory v5 使用轻量索引 + Topic 文件 (2026-04-24)
- **状态**：已采纳
- **上下文**：v4 已有 observations、instincts 和 sessions，但 SessionStart 注入缺少类似 Claude Code auto memory 的轻量启动索引，容易在“全量会话摘要/本能列表”和“无记忆”之间摇摆。
- **决策**：在 `projects/{hash}/memory/` 下新增 `MEMORY.md` 和 `memory/{topic}.md`。`MEMORY.md` 只保存通过置信度门控的高价值索引，目标 `<200 行 / 25KB`；调试、测试、工具链等细节进入 topic 文件。
- **原因**：轻量索引能稳定注入未来最可能复用的信息；topic 文件保留细节但默认不进入上下文；结构与 Claude Code auto memory 的实践一致，便于用户理解和审计。
- **备选**：只继续写 instincts；把完整 sessions 注入；引入数据库/向量检索。前者缺少可读启动索引，第二个上下文成本高，第三个超出当前纯文件/Obsidian 模型。
- **影响**：Hook 必须规范化 Codex payload、脱敏、去重并维护 `MEMORY.md` 预算；安装脚本和 Codex plugin 构建必须复制 `scripts/lib/`。
