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

### ADR-001: Claude Code 与 Codex 使用显式共享 Homunculus (2026-04-23)
- **状态**：已采纳
- **上下文**：Codex 插件支持已经让 Codex 默认写入 `~/.codex/homunculus`，Claude Code 默认写入 `~/.claude/homunculus`。用户需要在两类 agent 之间共享本能、会话摘要、skill 信号和 Obsidian 知识图谱。
- **决策**：保持两个运行时默认独立，但新增显式共享模式。共享路径优先级为 `TECH_PERSISTENCE_HOME` 环境变量、`TECH_PERSISTENCE_CONFIG` 指向的配置文件、默认 `~/.tech-persistence/config.json`，最后回退到各运行时默认目录。
- **原因**：默认独立避免破坏已有安装；显式共享可以让 Claude Code 与 Codex 指向同一个 Obsidian vault，满足持续同步；全局配置文件规避 Codex/Claude Hook 是否方便注入环境变量的不确定性。
- **备选**：强制 Codex 写入 `~/.claude/homunculus`；保留一次性 `--import-claude`；实现双向文件 merge。前者破坏运行时隔离，第二个不能持续同步，第三个超出当前文件系统知识库模型。
- **影响**：安装脚本和文档必须同时解释独立、导入、共享三种模式；Hook 与命令脚本必须通过 runtime path resolver 解析 homunculus，不得新增硬编码主路径。
