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

### ADR-005: Agent Loop 恢复流必须由 Normalizer 与 Continuation 状态驱动 (2026-04-29)
- **状态**：已采纳
- **上下文**：实际使用中出现 `plan.tasks` 无法解析、`summary: "APPROVED"` 被判为 `needs-followup`、`blocked` 无法 resume、Windows Codex sandbox 写入失败、provider 日志覆盖等问题；共同根因是状态机过早依赖 provider 原始字段和一次性执行假设。
- **决策**：Spec / handoff / review 输出先进入 codec + normalizer，再驱动状态机；`blocked` 与 `needs-followup` 视为同一 run 的 continuation，可重新进入 implementation；Windows 未显式指定时 Codex sandbox 默认 `workspace-write`；provider 日志使用时间戳并由 `state.providerRuns[]` 追溯。
- **原因**：这能消除手动修改 `state.json` 的恢复路径，让 provider 输出变体、Windows sandbox 差异和多次 resume 都成为 orchestrator 的确定性职责。
- **备选**：继续要求用户手动传 `--codex-sandbox workspace-write`、手动改 `blocked` 为 `frozen`、在 prompt 中强约束 provider 只输出单一 schema。备选方案脆弱且会在不同 provider 版本中反复失效。
- **影响**：第一次 `frozen` 实现仍要求 clean worktree；`needs-followup` / `blocked` continuation 允许在已有实现 diff 上继续；后续还需补 `status --verbose`、`retry` 和更细的 review prompt 预算。

### ADR-004: Agent Loop v6 Provider 适配层必须内建在 Orchestrator 中 (2026-04-28)
- **状态**：已采纳
- **上下文**：Windows 上 `claude` / `codex` 常解析到 npm shim，且 Claude Code 与 Codex 对 stdin、structured output、JSON wrapper、schema 严格度的行为不同；把这些差异交给用户手动传参会导致 `/agent-loop` 与 `$agent-loop` 行为分叉。
- **决策**：provider launch resolver、stdin prompt transport、structured output codec、contract normalizer、managed artifact diff、validation runner 和 normalized review state transition 都放入 `agent-orchestrator.js`，Claude Code command 与 Codex skill 只负责调用同一个脚本。
- **原因**：入口文档和运行时越薄，跨 Agent 差异越少；状态机只消费 canonical model，才能避免“review passed 但状态为 needs-followup”这类错误。
- **备选**：要求用户传 `--claude-command` / `--codex-command`；在 Claude/Codex 两边各写一份适配逻辑。前者不可移植，后者会让 bug 修复分叉。
- **影响**：orchestrator 新增 `doctor` / `preflight`、重复 `--validation-command`、`changed-files.json`、`review-context.md`、`review.raw.json` 等 artifacts；插件副本和项目副本必须机械同步。

### ADR-003: Agent Loop v6 使用外部编排器串联多 Agent (2026-04-27)
- **状态**：已采纳
- **上下文**：直接在 claude 或 codex 的命令/skill 内部串联彼此，会依赖两个运行时对对方的支持能力；当前这种支持薄弱，容易出现上下文丢失、输出协议不稳定、错误无法统一恢复的问题。
- **决策**：v6 将跨 Agent 流程提升到外部 orchestrator：由 `scripts/agent-orchestrator.js` 维护状态机、运行目录、JSON Schema、freeze 点、diff、validation、handoff 和 review loop。默认 spec/review provider 为 `claude -p`，implementation provider 为 `codex exec`。
- **原因**：外部进程能统一管理 exit code、stdout/stderr、文件产物、重试、恢复和 human freeze；两个 Agent 只承担单一职责，不需要理解彼此的内部命令系统。
- **备选**：只做 `/claude-codex` 这类命令内协议；只共享 homunculus 知识库；把其中一个 Agent 包装成另一个的 MCP 工具。命令内协议可作为人工 fallback，但不是稳定主路径；共享知识库不能提供执行控制；MCP 包装增加部署复杂度且仍要解决状态契约。
- **影响**：运行产物进入 `.agent-runs/<runId>/` 并被 Git 忽略；插件构建必须复制 orchestrator 与 schemas；新增 `/agent-loop` / `$agent-loop` 作为 v6 入口。
