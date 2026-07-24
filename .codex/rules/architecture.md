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

### ADR-028: GPT-5.6 使用 Codex 原生投影，Claude 运行面保持冻结 (2026-07-23)
- **状态**：已采纳
- **上下文**：旧 `/sprint`、`/work`、`/review` 直接把为 Claude 编写的长协议、预热规则与多阶段指令投影给 Codex；同时 direct skills、plugin skills、旧 command 自动迁移 skill 与 stale plugin cache 可能形成多个可见 owner。GPT-5.6 会认真执行这些重复且高约束的协议，导致首个有效动作前反复读 skill/规则、累计输入膨胀和工具调用串行化。Claude 仍依赖原目录、命令与 hook 语义，不能用一次全局改写修复 Codex。
- **决策**：Claude 的 `user-level/commands`、`user-level/skills`、plugin `commands/skills/hooks` 与 legacy hook registry 保持冻结；Codex 改用独立的 `codex-native` phase-local skills、Codex-only hook registry 和有界 active-sprint pointer。`AGENTS.md` 不再静态嵌入 solution index，Codex-only Compound 按需读取 canonical index，并明确 `--all` 只维护 canonical index 与 Claude 的有界 projection。Codex 的 user/project `AGENTS.md` 改用最小原生模板；只有字节归一化哈希命中已知历史模板时才备份迁移，未知自定义文件必须以非成功的 preserved-custom 结果原地保留，项目模板只在显式 `-Project`/`--project` 时处理。Codex 安装只保留一个 canonical plugin owner，旧 direct/shared skill 文件原地保留并通过 `skills.config` 的完整 `SKILL.md` 路径禁用；project fallback 接管时必须事务性移除其自身路径的旧 managed exclusion，且不得跟随 symlink/junction 逃逸项目根。安装包不携带 legacy `commands/`，避免 Codex 自动生成 migrated-command-skills；用户明确执行安装时才通过官方 plugin CLI 刷新 canonical cache，并用 fresh prompt inventory 验证真实可见面。日常 runtime doctor 只自动修复可做哈希/CAS 验证的 `config.toml`，plugin owner 的 add/remove 一律输出完整原始指纹和候选命令后交由人工执行。
- **原因**：运行时投影能在不改变 Claude 行为的前提下减少 GPT-5.6 的协议歧义、重复 owner 和前置上下文；原地禁用与备份/指纹校验比移动或删除用户文件更可恢复。active pointer 与阶段内渐进加载把上下文成本绑定到当前工作，而不是完整 sprint 生命周期。
- **备选**：直接缩短 Claude 共用命令；删除用户级重复 skills；仅降低 GPT-5.6 reasoning effort；新增一层 provider router。前两项会破坏 Claude 或用户资产，第三项不能解决重复 owner/协议冲突，第四项增加不必要的调度状态与故障面。
- **影响**：Codex 与 Claude 的生成物必须分别校验；Claude 冻结面用确定性文件指纹守门。Codex plugin build 是离线 source projection，active runtime 只能读取 installer cache；build 必须在所有目标首次写入前完成 lexical、`lstat`、`realpath` 与 symlink/junction 检查，使用不会抢占存活 PID 的跨进程锁、全量 staging、私有 claim + create-if-absent、依赖先于入口发布和事务级回滚，不能先清空可见目录。首个 live mutation 前必须 fsync 持久 recovery manifest；每个 temp copy、parent create、claim、publish 前后都要有可判定的状态，hard crash 或不完整 manifest 的下一次 build 必须通过 `--recover` 恢复已证明状态或 fail-closed。回滚失败必须保留唯一备份与证据，不能覆盖并发外部写入，也不得宣称跨文件 live-reader 原子性。Codex 热路径只保留有界 SessionStart pointer 读取和 write-only PreToolUse guard；同步 `UserPromptSubmit` 全库召回、观察型 PostToolUse 与 legacy Stop evaluator 不进入 Codex 投影，学习改由显式 Compound phase 完成。active pointer、plan 与 resume/goal/Figma 引用都必须按需加载并限制文件大小/真实路径。安装事务必须保存 target、marketplace、cache 的真实字节快照并在每个阶段验证所有权；回滚使用 descriptor-first 的持久 plan，stage/claim/publish 后即使进程退出也只能从已绑定的字节和路径续跑，stale `preparing`、缺失初始 manifest 与非终态中断通过显式 `reconcile` 处理。lock release 只能 claim 自己的 token/原始字节，出现 replacement lock 时保留双方证据而不能删除 replacement。marketplace 与 JSON assets 使用 manifest-bound raw hash、私有 claim 和 no-clobber publish。因官方 CLI 没有 owner/source/version CAS，CLI 改变 owner/cache 前仍可真实回滚，确认越过非 CAS 提交边界后则持久化 `recovery-required`、保留 installer-owned 状态并允许幂等重跑，绝不虚假声称已恢复，也绝不自动执行逆向 add/remove；未知或并发漂移、锁释放失败继续保留证据并以非成功 disposition fail-closed。doctor 的 config 修复必须先有 verifier、独占备份、no-replace publish 和最终读回，owner 变更永不自动执行。默认不启用 caveman；模型或 reasoning effort 调整必须先通过至少 6 组同 task spec、同 Codex/service/sandbox/repo/tool/plugin/hook identity 的 canary 配对，同时满足任务成功、质量、错误、工具调用、TTFA、总时延与 token 预算；缺字段、重复 pairing identity 或非同配对样本时不得宣称性能提升。
- **复审门禁**：Claude 冻结面使用版本化基线文件绑定 fingerprint schema、精确路径集合、文件数、总字节、SHA-256 与空 warnings；Codex SessionStart 只验证并解析 pointer 本身，不打开 plan，只有当前用户显式请求 sprint/resume/continue 才允许按需读计划。PreToolUse matcher 与实现必须覆盖同一组精确写工具别名，不用 substring 猜测。canary 的候选必须至少改变 model 或 reasoning effort 一项，零变化对照无效。
- **文档投影**：即使不在 Sprint 热路径，含 provider runtime 语义的 memory、continuous-learning 与 caveman skills 也必须有 Codex-native 覆盖，并由包验证器拒绝 Claude legacy 的 SessionStart 自动注入/激活声明；README 必须明确六个薄 `/command` 兼容入口与 `$skill` 原生入口的边界。

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
