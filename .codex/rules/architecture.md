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

### ADR-014: Hook 架构统一语义源头，按运行时生成配置 (2026-05-14)
- **状态**：已采纳
- **上下文**：Tech Persistence 同时支持 Claude Code classic、Claude Code plugin 与 Codex plugin。直接共享同一份 hook 配置会把事件名、matcher、路径占位符、async/timeout 语义混在一起，容易造成某一运行时看似通过、另一运行时实际未注册或双触发。
- **决策**：维护 `scripts/lib/hook-registry.js` 作为逻辑 hook registry，统一 `memory-session-context`、`observe-tool-*`、`evaluate-session`、`prompt-memory-recall` 等业务语义；各运行时只消费自己的 projection。Claude classic 继续只启用其兼容的 4 hook，plugin runtime 额外启用 `UserPromptSubmit` 和 `caveman-activate`。
- **原因**：统一语义能避免安装器、plugin build、validator 各自硬编码漂移；分运行时 projection 能保留 Claude Code 与 Codex 的事件、路径和输出语义差异。
- **备选**：直接把 `hooks/hooks.json` 复制给所有运行时；继续在每个 installer/validator 内硬编码 hook 表。前者不兼容 classic 配置，后者已经出现 drift。
- **影响**：新增或调整 hook 必须先改 registry，再让 installer/build/validator 从 registry 派生；不得把 runtime-specific matcher 或路径写成全局规则。
