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

### ADR-027: Secret redaction 扩覆盖，不默认升 pre-commit gate (2026-07-01)
- **状态**：已采纳
- **上下文**：Hook observations、Memory v5、skill trace/eval case 都会持久化用户输入或工具输出摘要。仅 `<private>` 标签脱敏不足以覆盖常见 provider token；但把 secret scan 直接接入 pre-commit 会把误报变成提交阻断。
- **决策**：`scripts/lib/redaction.js` 作为 durable redaction 共享入口，覆盖 GitLab PAT、HuggingFace、npm、DigitalOcean、Bearer、OpenAI/AWS、GCP service-account JSON 字段、generic secret assignment 和长 base64 blob；`scripts/lib/memory-v5.js` 复用该入口。`scripts/secret-scan-on-demand.js` 同步扩展 pattern pack，但继续保持 on-demand，不默认接 `pre-commit-check.js` 强门禁。
- **原因**：持久化链路需要纵深防御；on-demand scanner 可以 dogfood 低误报率。pre-commit enforcement 只有在真实命中或充分低 FP 证据后再评估，符合 measure-before-enforce。
- **备选**：只扩 scanner 不扩 durable redaction；或直接把 scanner 接入 pre-commit。前者保护不了 observations/memory 输出，后者容易因测试 fixture/文档示例误报阻断开发。
- **影响**：新增持久化输出时优先复用 `redactSensitiveText`/`stripPrivateTags`；新增 secret pattern 时必须同时补 scanner 输出脱敏测试和 durable redaction 测试。plugin 投影由 build 生成，不手改。
### ADR-016: Codex plugin SessionStart 不在 resume 重注入 startup context (2026-07-01)
- **状态**：已采纳
- **上下文**：Codex plugin runtime 的 `SessionStart` matcher 同时覆盖 `startup|resume|clear|compact` 时，`inject-context.js` 与 `caveman-activate.js` 会在 resume 场景重复注入 learned-context/caveman context，增加 token 成本和认知噪音。
- **决策**：plugin runtime 的 session-start bootstrap matcher 收敛为 `startup|clear|compact`；`resume` 不再触发 startup context 注入。配置继续从 `scripts/lib/hook-registry.js` 生成，plugin 投影不得手工改回。
- **原因**：startup/clear/compact 仍保留新会话和上下文重建能力；resume 依赖既有上下文即可，重复注入收益低、成本高。
- **备选**：保留 `resume` 并在 hook 内做 session-level dedupe marker；完全移除 Codex SessionStart hooks。前者需要稳定 session id 语义，后者会损失 clear/compact 后的必要注入。
- **影响**：后续新增 SessionStart hook 时必须明确是否允许 resume；默认不把 bootstrap 类 hook 绑到 resume。skill carving 先用 `scripts/skill-size-budget.js` 计量 heavy command-derived skills，再决定是否拆 `references/`。
### ADR-015: 先补 pipeline 硬门禁，再接 native workflow backend (2026-06-01)
- **状态**：已采纳
- **上下文**：Claude Code Dynamic workflows 适合大规模 subagent 编排，但 tech-persistence 的 `/sprint` 是方法论协议，`agent-loop --pipeline` 才是可替换/扩展的执行后端。若在 pipeline 仍缺少真实文件边界和状态门禁时直接接 native workflow，并行能力会放大现有漂移。
- **决策**：先沿用 `docs/plans/2026-05-12-pipeline-hardening-roadmap.md` 加固 pipeline：落地 `ownedFiles` changed-files gate，并把 run/slice 状态推进统一收口到 `pipeline-state.js` 的 transition helper。native workflow 只能作为未来 backend seam 的一支，不能替代 `/sprint`、`/work`、`/review` 的顶层方法论。
- **原因**：changed-files gate 能证明 slice 没越界写文件；统一 transition helper 能保证 provider/pipeline 层不会绕过状态机。两者都是接多 agent/多 worker 前的共同前置。
- **备选**：直接实现 Claude workflow adapter；继续只靠 prompt 约束 `ownedFiles` 和状态流转。前者会引入 Claude-only parity 问题，后者无法阻止 false success。
- **影响**：后续接 workflow backend 前，必须保留 durable `.agent-runs` artifacts、fallback runtime、provider provenance、budget/permission profile；多 worker 前还需要补 review/validation transaction boundary、shared-contract exception 和 isolated worktree 策略。

### ADR-014: Hook 架构统一语义源头，按运行时生成配置 (2026-05-14)
- **状态**：已采纳
- **上下文**：Tech Persistence 同时支持 Claude Code classic、Claude Code plugin 与 Codex plugin。直接共享同一份 hook 配置会把事件名、matcher、路径占位符、async/timeout 语义混在一起，容易造成某一运行时看似通过、另一运行时实际未注册或双触发。
- **决策**：维护 `scripts/lib/hook-registry.js` 作为逻辑 hook registry，统一 `memory-session-context`、`observe-tool-*`、`evaluate-session`、`prompt-memory-recall` 等业务语义；各运行时只消费自己的 projection。Claude classic 继续只启用其兼容的 4 hook，plugin runtime 额外启用 `UserPromptSubmit` 和 `caveman-activate`。
- **原因**：统一语义能避免安装器、plugin build、validator 各自硬编码漂移；分运行时 projection 能保留 Claude Code 与 Codex 的事件、路径和输出语义差异。
- **备选**：直接把 `hooks/hooks.json` 复制给所有运行时；继续在每个 installer/validator 内硬编码 hook 表。前者不兼容 classic 配置，后者已经出现 drift。
- **影响**：新增或调整 hook 必须先改 registry，再让 installer/build/validator 从 registry 派生；不得把 runtime-specific matcher 或路径写成全局规则。
