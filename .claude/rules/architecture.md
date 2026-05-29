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

### ADR-020: plugin 副本的 lib 解析按"消费方所在目录"分别填充，utility 脚本的 `scripts/lib` 与 hook 的 `hooks/lib` 是独立解析路径 (2026-05-29)
- **状态**：已采纳
- **上下文**：[[2026-05-28-two-layer-architecture-enhancement]] 实现完整性审计发现 A3/B1/B2/B3 的 `parity ✓` 不准确。Codex plugin 的 4 个 utility 脚本（A3 改动的既有 `agent-orchestrator.js` + B1/B2/B3 新增的 `skill-traces.js` / `skill-eval-cases.js` / `skill-eval-results.js`）在 plugin 副本里运行时全部 `Cannot find module './lib/...'`。根因：Node 的 `require('./lib/x')` 相对**脚本文件自身**解析——hook 脚本在 `plugins/.../hooks/`，解析到 `hooks/lib`（由 `copyHooks` 调 `copyHookLibs(hooks)` 填）；utility 脚本在 `plugins/.../scripts/`，解析到 `scripts/lib`，但 `copyUtilityScripts` 此前只复制顶层脚本 + `copyAgentOrchestratorSubmodules`（`scripts/agent-orchestrator/` 子目录），**从不填 `scripts/lib`**。A3 给 agent-orchestrator 引入**首个** `./lib` 依赖（此前整条闭包零 `./lib`、全部已复制）是 P0 回归点。ADR-016/017/018/019 都把传播机制写成「lib 经 `copyHookLibs` glob 自动复制」——**本条勘误该假设**：copyHookLibs 的目标参数是消费方目录，只被 hooks/mcp 调用过，对 scripts 下的消费方无效。
- **决策**：(1) plugin lib 按"哪个目录下的脚本 `require('./lib')`"分别填充——`copyUtilityScripts` 末尾追加 `copyHookLibs(path.join(pluginRoot,'scripts'))`，让 `scripts/lib` 与 `hooks/lib`、`mcp/lib` 平级各持一份（复用同一 `copyHookLibs`，glob 全量 raw 复制）；(2) `validate-codex-plugin.js` 对 utility 脚本（agent-orchestrator + 3 个 skill CLI）加 `validateLocalRequireClosure` 护栏，与既有 hook 闭包校验同源（[[ADR-013]] mechanism-over-discipline：把"记得填 scripts/lib"下沉为 validator 拒绝），含删 lib 跑 validate 必 fail 的 break-impl 负样本（[[feedback_negative_sample_3_archs]]）。
- **原因**：(1) `require('./lib')` 的解析锚点是文件位置而非进程 cwd，所以每个放 utility 脚本的目录都必须各持一份 lib，不能指望 hooks/lib 覆盖；(2) sha256 sync（pre-commit）只比对源↔副本字节、查不出"副本是忠实拷贝但缺传递依赖"，测试只跑 root `scripts/`（有 lib）从不跑 plugin 副本——两道现有防线对这类缺失结构性失效，必须靠 require 闭包校验补；(3) 复用 `copyHookLibs` 而非新建复制逻辑（[[reuse-existing-infra-before-building-new]]）。
- **备选**：(a) 把 utility 脚本的 `require('./lib/x')` 改写成指向 `../hooks/lib`——跨目录耦合且脆，否决；(b) 继续靠 ADR 文字提醒「记得同步 build」——正是 [[ADR-013]] 批判的纪律层，已实证失效（4 个 ADR 都写错假设仍漏）；(c) 把 lib 收敛成单一 plugin 顶层目录 + 全脚本改 require 路径——改动面大、破坏 root↔plugin 路径 parity，否决。
- **影响**：(1) 今后任何被 `copyUtilityScripts` 复制的 `scripts/` 脚本新增 `require('./lib/*')`，由 validator 闭包护栏自动守护，无需人工记忆；(2) ADR-016/017/018/019「lib 经 copyHookLibs glob 自动复制」表述据本条勘误——机制是"按消费方目录分别 `copyHookLibs(<dir>)`"，hooks/mcp/scripts 三处独立；(3) plugin `scripts/lib/` 成为 git-tracked 派生产物（12 文件），由 build 生成；(4) 该 gotcha 进 [[debugging-gotchas]] HIGH 段。
- **来源**：`docs/plans/2026-05-28-two-layer-architecture-enhancement.md` 2026-05-29 审计修正条目；[[documented-claim-vs-code-reality-drift]]。

### ADR-019: skill eval case 的护城河靠 provenance 确定性写入 gate，traces/cases/results 在 skill-evals 下同构 (2026-05-28)
- **状态**：已采纳
- **上下文**：[[2026-05-28-two-layer-architecture-enhancement]] §B2 要从真实使用 trace 半自动转 skill eval case，护城河目标是 eval case 来自真实 trace 而非 skill 自产（避免"自己出题给自己考"）。设计文档假设数据源是「signal jsonl 里 corrections」、复用 `skill-evals/{name}/`。[[ADR-012]] 勘察推翻两个数据源假设：(1) signal record（`scripts/lib/skill-signals.js`）只有 `{skill, calls, source, session_id, project}`，无 corrections/真实输入——B1 已把含 `input_excerpt/correction_diff` 的 trace 移到独立 `skill-traces/{name}.jsonl`（[[ADR-017]]），B2 真实数据源是 skill-traces 不是 signal jsonl；(2) eval **case** 此前无结构化格式（只是 skill-eval.md 描述的 LLM 非结构化用例），与 [[ADR-016]] 当时「eval 结果无格式得先补」是同类前置缺口。
- **决策**：(1) 新建 `skill-evals/{name}/cases/cases.jsonl`，与 [[ADR-016]] 的 `results/results.jsonl` 平级同构（append-only / `SKILL_NAME_RE` 防路径逃逸 / 损坏行 skip + stderr marker / 双层脱敏）——traces/cases/results 构成 skill-evals 下完整数据三角；(2) 护城河靠 `addCase` 的**写入即拒绝** gate：`provenance` 必须 `trace` + `source_trace` 必须是对象（快照不可复现的真实上下文）+ `input` 非空，CLI 缺 `--from-trace` 直接 `exit 2`；(3) 所有字符串字段含嵌套 `source_trace.*` 写入前递归 `redactDeep`→`stripPrivateTags`（纵深防御，即使来源 skill-traces 已脱敏）；(4) record + list 合并为单 CLI `scripts/skill-eval-cases.js`（YAGNI）。
- **原因**：(1) 护城河隔离性（来源是否 trace）是确定性可判定的，按 [[ADR-013]] mechanism-over-discipline 应下沉为工具拒绝，而非靠"模型记得别自产"；(2) 与 results.jsonl 同构降认知成本 + 复用同套防御（[[reuse-existing-infra-before-building-new]]）；(3) trace 含真实输入，双层脱敏是隐私不可妥协项（与 [[ADR-017]] recordTrace 同纵深防御）。
- **备选**：(a) 复用 signal jsonl——无 corrections 字段，否决；(b) 靠 skill-eval.md 协议约束别自产 case——正是 [[ADR-013]] 批判的纪律层；(c) eval case 通过率自动算进 results.jsonl——涉及语义判断确定性化边界（[[ADR-017]]），超本 sprint 范围，另立。
- **影响**：(1) eval case 执行 + 评分仍是 LLM 语义判断（[[ADR-017]] 边界不变，本 sprint 只结构化 case 产物，不自动跑）；(2) 未来 skill-evals 下新增数据流沿用同构 append-only jsonl + 同套防御；(3) `skill-eval-cases.js` 进 `copyUtilityScripts` 列表（双 runtime parity），lib 经 `copyHookLibs` glob 自动复制；(4) `cases/` 子目录由 lib `mkdirSync recursive` 懒创建，install.* 无需改。
- **来源**：`docs/plans/2026-05-28-trace-to-eval.md`，`docs/solutions/2026-05-28-trace-to-eval.md`。

### ADR-018: agent-loop classic 模式的 spec 澄清用 append-only `clarifications.md` 异步通道，ruling→spec 修正复用 needs-followup 回路（不复用 pipeline contract-revision） (2026-05-28)
- **状态**：已采纳
- **上下文**：[[2026-05-28-two-layer-architecture-enhancement]] §A3 要给 frozen spec 加 implementer→spec-writer 澄清通道，假设「复用现有 contract-revision（问题 13 accept-revision）」。[[ADR-012]] 勘察推翻：contract-revision/accept-revision/reject-revision 只在 pipeline 模式（`scripts/agent-orchestrator/pipeline.js` 的 contract-conflict 状态机）；classic 线性流（freeze→implement→review→resume）没有该机制，其「修正 spec」等价回路是 review→`needs-followup`→resume re-implement（`runResume`）。同时 handoff schema strict（`additionalProperties:false`）、orchestrator artifact 全是覆盖式 `writeText`/`writeJson` 无 append 助手。
- **决策**：(1) frozen spec 旁加 append-only `clarifications.md`（新 lib `scripts/lib/clarifications.js`，`fs.appendFileSync`，section 化 markdown + frontmatter，自动派生 `clr-NNN` id）；(2) implementer 经 handoff `clarifications[]` 提问（**不阻塞**，记假设继续实现），orchestrator append 进文件；(3) review provider 兼任 spec-writer，经 `clarificationRulings[]` 逐条裁决（decision ∈ confirm-assumption | revise-spec），append 为 ruling section；(4) **ruling=revise-spec 复用 classic 既有 needs-followup 回路**（review 同步进 findings/followUpTasks），不调用 pipeline accept-revision；(5) 所有字段写入前 `stripPrivateTags`（纵深防御）；(6) handoff/review schema 加可选字段（向后兼容，非 required），同步改对应 normalize 函数。
- **原因**：(1) append-only + 异步裁决符合 TP「批处理而非实时」+「非 runtime」定位，零双向 runtime 通道（轻量原则）；(2) classic/pipeline 是两套状态机，强搬 contract-revision 会引入跨模式耦合；(3) 复用 needs-followup 回路使「ruling 改 spec」零新状态流；(4) clarifications.md 是纯 markdown runDir artifact，schemas/ 与 scripts/lib/ 由 build glob 自动同步，双 runtime parity 天然满足。
- **备选**：(a) 把 pipeline contract-revision 搬到 classic——跨模式耦合，否决；(b) 双向 runtime 实时通道——违反轻量+非 runtime，否决；(c) 覆盖式重写 clarifications——丢历史违反审计性，否决。
- **影响**：(1) classic 模式新增 `clarifications.md` artifact 与 handoff/review schema 两个可选字段（向后兼容）；(2) 未来 classic 模式「frozen 后追加」场景统一用 append-only lib + append-only 单测（断言二次写后 `body.startsWith(priorBody)` + 字节只增）；(3) pipeline 模式不受影响（改动全在 classic 路径）；(4) 新 lib 进 `scripts/lib/` 由 `copyHookLibs` glob 自动进 plugin 副本；(5) clarification 由 LLM provider 在 handoff/review JSON 产出（语义判断，同 [[ADR-017]] 性质，无法 hook 自动派生），靠 prompt 强约束 + schema 缓解。
- **来源**：`docs/plans/2026-05-28-clarification-channel.md`，`docs/solutions/2026-05-28-clarification-channel.md`。

### ADR-017: skill 进化链的语义信号（失败/纠正）用"LLM 半自动判断 + CLI 结构化 record"捕获，不靠 hook 自动检测 (2026-05-28)
- **状态**：已采纳
- **上下文**：[[2026-05-28-two-layer-architecture-enhancement]] §B1（GEPA 内核）要 improve 基于真实失败 trace 反思。设计文档假设"扩展现有 signal jsonl 的 steps_skipped/corrections/duration 字段"。勘察推翻：`aggregateSkillSignals` record 只有 `{skill, calls, source}`——diagnose/improve.md 描述的完成率/热力图/纠正模式全是 doc drift（[[documented-claim-vs-code-reality-drift]]）。更根本：skill 一次执行"成功/失败/被纠正"是**语义判断**，无 exit code，PostToolUse hook 看不到——无法像 observe 那样确定性自动派生。
- **决策**：(1) skill 的失败/纠正 trace 用"LLM 半自动判断 + 人工 gate + CLI 结构化 record"捕获，不引入 hook 自动失败检测；(2) 数据源复用现成 observations.jsonl（已双层脱敏，含 input/output/error_signal），由 `/skill diagnose` 时 LLM 提取异常条目 → 人工确认 → `node scripts/skill-traces.js record`；(3) trace 存独立 `{baseDir}/skill-traces/{name}.jsonl`，**不混入 skill-signals 的 calls jsonl**（避免污染 `summarizeSkillSignals` 聚合）；(4) recordTrace 内部对所有字符串字段再过 `stripPrivateTags`（纵深防御，即使 observations 已脱敏）。
- **原因**：(1) 语义信号（成败/纠正）确定性化的边界——能 hook 自动派生的是"工具调用 + error_signal"（已在 observe 做），"这次 skill 用得好不好"必须 LLM 判断，强行 hook 化会产生噪声标注；(2) 复用 observations 避免新建捕获点（[[reuse-existing-infra-before-building-new]]）；(3) 独立目录保持 calls 聚合纯净 + 与 [[ADR-016]] skill-evals/ 同构（parity）；(4) trace 含真实输入，双层脱敏是隐私不可妥协项。
- **备选**：(a) hook 自动检测 skill 失败——语义判断不可确定性化，否决；(b) trace 混入 signal jsonl——污染 calls 聚合，且语义混杂；(c) 不脱敏（信 observations 已脱敏）——违反纵深防御，否决。
- **影响**：(1) 这是 [[ADR-016]] 同期确立的 skill 链 deterministic 化的**互补面**——ADR-016 管"能确定性判定的环节下沉 enforcement"，ADR-017 管"语义判定环节保持 LLM + 人工 gate，只把产物结构化"；(2) B2（trace→eval）以本 sprint 的 skill-traces 为数据源解除阻塞；(3) 未来给 LLM-only 子系统加数据捕获时，先问"这个信号是确定性可派生还是语义判断"——后者走"LLM 判断 + CLI record"，不堆 hook。
- **来源**：`docs/plans/2026-05-28-skill-trace-aware-reflection.md`，`docs/solutions/2026-05-28-skill-trace-aware-reflection.md`。

### ADR-016: skill 进化链引入首个 deterministic gate（publish 基线护栏），enforcement 入口按"动作是否产生 git commit"选址 (2026-05-28)
- **状态**：已采纳
- **上下文**：[[2026-05-28-two-layer-architecture-enhancement]] §B3（[[ADR-013]] 活案例）提议把 skill-publish 的"eval 通过率 ≥ 当前版本"从文档协议下沉为确定性 enforcement。设计文档假设"复用 `scripts/pre-commit-check.js` 模式"。实施勘察推翻两个核心假设：(1) `/skill` 明示整条进化链"无 deterministic backing code"，eval 结果只是 LLM 产出的 markdown 表格，**无结构化格式**，护栏无可读基线；(2) `pre-commit-check.js` 由 `git diff --cached` 驱动，但 publish 改的是 runtime 目录 `~/.claude/homunculus/skill-evals/{name}/`，**不产生 git commit**，永远不在 staged files——pre-commit 入口对 publish 动作结构性失效。
- **决策**：(1) 先补齐结构化 eval-result 格式 `scripts/lib/skill-eval-results.js`（`recordResult`/`readLatestTwo`/`checkRegression`，append-only `results.jsonl`），这是 enforcement 的数据前置；(2) enforcement 入口选址原则——**按"被守护的动作是否产生 git commit"决定挂 pre-commit 还是挂动作流程内的独立 guard**。publish 不产生 commit → 独立 guard CLI（`scripts/skill-eval-results.js guard <name>`，退化 `exit 2`），由 `/skill publish` 步骤 0 强制调用；(3) record + guard 合并为单 CLI（YAGNI，避免两个顶层脚本 + 两个 copyUtilityScripts 项）；(4) 沿用 [[ADR-013]] enforcement 模式：3 层 fail-open（用户可不调 / try-catch exit 0 + `[skill-guard] fail-open:` marker / node 缺失靠调用方）、派生具体修复命令、无基线放行（向后兼容当前全空的 skill-evals）。
- **原因**：(1) pre-commit 是 git-staged 驱动的 enforcement，只能守护"会进 commit 的改动"；runtime-only 副作用（写 `~/.claude/...`）必须在产生副作用的动作流程内拦截，否则 enforcement 形同虚设；(2) 给 LLM-only 子系统加首个 deterministic gate 合理——[[ADR-013]] mechanism-over-discipline 核心是"高频违反 / 影响一致性的规则下沉为工具拒绝"，退化发布正属此类；(3) 无基线放行保证 enforcement 零误拒启动（[[ADR-013]]§B 边界产物：当前 skill-evals 全空，护栏必须放行而非阻塞）。
- **备选**：(a) 挂 pre-commit-check——已证结构性失效（publish 不 commit）；(b) 继续靠 skill-publish.md 协议——正是 [[ADR-013]] 批判的"停留文档层"；(c) 引入 DB 存 eval 历史——违反轻量原则，append-only jsonl 足够。
- **影响**：(1) skill 进化链从"纯 LLM 协议"变为"LLM 协议 + 1 个 deterministic publish gate"，后续 skill 链增强（B1/B2）需注意该 gate 存在；(2) 未来任何"下沉 enforcement"提案必须先问"被守护的动作是否产生 git commit"——产生则 pre-commit，否则动作流程内 guard；(3) guard CLI 进 `copyUtilityScripts` 列表（双 runtime parity），lib 经 `copyHookLibs` glob 自动复制；(4) eval result 结构化格式确立后，B2（trace→eval）有了落地基础。
- **来源**：`docs/plans/2026-05-28-skill-publish-baseline-guard.md`，`docs/solutions/2026-05-28-skill-publish-baseline-guard.md`。

### ADR-015: Memory v5 引入 Persona 顶层独立维度（5 字段固定结构）+ 显式区分双 memory 系统 (2026-05-15)
- **状态**：已采纳
- **上下文**：TDAI sibling eval（[[2026-05-15-tencentdb-agent-memory-analysis]]）§4 借鉴点 1 提议 TP Memory v5 缺少"用户长期画像"维度——`feedback_*` / `user_*` 散落多个文件，SessionStart 每次靠模型从散链聚合，跨会话稳定性差；同时实施中发现 TP **同时有两套 memory 系统**（Claude Code auto memory at `~/.claude/projects/C--<cwdpath>/memory/` vs Tech-persistence v5 at `~/.claude/homunculus/projects/<gitHash>/memory/`），写入侧 vs 读取侧默认分离——所有现有 `feedback_*`/`user_*` 在 Codex 端**完全不可见**（违反 [[ADR-011]] multi-runtime parity 但此前未发现）。
- **决策**：(1) Memory v5 引入 `persona.md` 单文件，5 固定字段（Role / Preferences / Non-negotiables / Communication style / Known context），位于 v5 memory dir 顶层；(2) `inject-context.js` 加 `loadPersonaBody()` first-hit 函数 + section 0c（位于 Memory v5 index 之前，900 chars 预算），让 persona 不被 index entry 排挤；(3) **persona.md 只写 v5 dir，不写 auto-memory dir**——双运行时 parity（Codex 通过 `~/.codex/homunculus/` compat dir 读到）+ 避免 Claude Code core 与 tech-persistence hook 双重注入；(4) **未来涉及"memory/" 的设计文档必须明示是 `auto-memory` 还是 `v5`**，否则歧义会再次导致写错路径。
- **原因**：(1) Persona 是跨会话稳定的低频信号，不应与变频的 instinct/topic entry 共享预算；(2) 5 字段固定结构使新 user-type 观察沉淀有明确归属（不再每次问"这条应该建新文件还是塞 user_workflow_preferences"）；(3) v5 dir 是双运行时唯一可达路径（[[ADR-008]] compatReadDirs 涵盖 `~/.claude/homunculus/` + `~/.codex/homunculus/`），auto-memory dir 是 Claude Code 私有；(4) 双 memory 系统并存是历史事实（不会短期合并），文档明示比"代码 grep 才知道"友好。
- **备选**：(a) 自动从 `feedback_*`/`user_*` 聚合 persona——脆弱且时序耦合；(b) 把 persona 放 auto-memory dir——破坏 Codex parity；(c) symlink `~/.claude/persona.md` 到项目 persona.md——跨项目场景未出现，YAGNI；(d) 重构两套 memory 为单一系统——超出本 sprint 范围，且 Claude Code core auto-memory 不受 tech-persistence 控制。
- **影响**：(1) 新增 `memory/persona.md` 文件约定，其他消费方（`/sprint` / `/compound` / `/work`）可读但本次不强制改动；(2) `inject-context.js` section 编号 0c→Persona、0d→Memory v5（原 0c），所有未来 section 注入需注意编号；(3) Codex 端通过 plugin 副本 hook 同步获得 persona 可见性；(4) `feedback_*`/`user_*` 在 auto-memory dir 仍可继续写（不强制迁移），但**新的高频通用 user-type 观察应优先沉到 persona.md 5 字段**或在 v5 dir 新建对应文件；(5) Codex 端"找不到用户偏好"如成为具体痛点，再考虑让 `inject-context.js` 也读 auto-memory dir（P1 backlog，本次未实施）。
- **来源**：`docs/solutions/2026-05-15-persona-top-level-dimension.md`，`docs/plans/2026-05-15-tencentdb-agent-memory-analysis.md` §9 P2 提前执行。

### ADR-014: Hook 架构统一语义源头，按运行时生成配置 (2026-05-14)
- **状态**：已采纳
- **上下文**：Tech Persistence 同时支持 Claude Code classic、Claude Code plugin 与 Codex plugin。直接共享同一份 hook 配置会把事件名、matcher、路径占位符、async/timeout 语义混在一起，容易造成某一运行时看似通过、另一运行时实际未注册或双触发。
- **决策**：维护 `scripts/lib/hook-registry.js` 作为逻辑 hook registry，统一 `memory-session-context`、`observe-tool-*`、`evaluate-session`、`prompt-memory-recall` 等业务语义；各运行时只消费自己的 projection。Claude classic 继续只启用其兼容的 4 hook，plugin runtime 额外启用 `UserPromptSubmit` 和 `caveman-activate`。
- **原因**：统一语义能避免安装器、plugin build、validator 各自硬编码漂移；分运行时 projection 能保留 Claude Code 与 Codex 的事件、路径和输出语义差异。
- **备选**：直接把 `hooks/hooks.json` 复制给所有运行时；继续在每个 installer/validator 内硬编码 hook 表。前者不兼容 classic 配置，后者已经出现 drift。
- **影响**：新增或调整 hook 必须先改 registry，再让 installer/build/validator 从 registry 派生；不得把 runtime-specific matcher 或路径写成全局规则。

### ADR-013: 关键规则必须从文档协议下沉为工具拒绝（mechanism over discipline） (2026-05-12)
- **状态**：已采纳
- **上下文**：`docs/plans/2026-05-11-sprint-speed-layer1.md` Compound 阶段实证两次失败：(1) 我自己漏跑 `build-codex-plugin`，validate 才暴露；(2) Plan 阶段两次基于错误假设（`CONTEXT_BUDGET_CHARS=25KB`、`pipeline.js` 是 /sprint 代码），work 阶段才发现，催生 ADR-012。两次失败的共同根因：**关键规则只活在 .md 里**——propagate 纪律在 `debugging-gotchas.md`，plan 勘察规则在 ADR-012，靠模型每次读 context 时记得遵守。上下文压缩 / 压力下 / 重要时刻会被悄悄省略。文档协议级 enforcement 有 3 个失效模式：(a) **遗忘**——上下文压缩后规则不在 active context；(b) **省略**——压力下模型主动跳过 self-check；(c) **漂移**——多次修订后文档与实际期望偏移，但没有客观信号验证。
- **决策**：高频违反、影响其他副本一致性、或涉及 dogfood 边界的规则，必须从"靠模型记得"的文档协议下沉为"工具层拒绝"。第一批落地：`scripts/pre-commit-check.js` 接管 propagate sync 检查（多副本 sha256 比对，LF-normalize）和 plan 假设验证段 lint（filename-date 做 grandfather，独立于 frontmatter 的鲁棒标识）。后续新增 enforcement 必须沿用同套模式：(a) 复用现有 transform 函数做 sha256 比对而非重写；(b) 3 层 fail-open 防御（用户 `--no-verify` / hook try-catch / sh wrapper node 缺失）；(c) 派生具体修复命令包含**真实参数**而非占位符；(d) 跨平台 LF-normalize 必须先于 hash 比对（[[cross-platform-sha-needs-lf-normalize]]）。
- **原因**：(1) 文档协议 3 个失效模式都是结构性的，写更多文档解决不了；(2) hook 拒绝是确定性信号，每次 commit 都跑，不依赖模型 context 状态；(3) fail-open 保证用户永远有逃生通道，不会被自己写的工具锁死；(4) "派生具体 fix 命令"把错误信息变成可 copy-paste 的修复路径，错误成本接近零。
- **备选**：(a) 继续靠文档协议 + reviewer agent 提醒——已实证失效 2 次；(b) 改用 server-side CI 拒绝——延迟反馈，本地 commit 仍可携带 broken state；(c) 在 LLM 主循环加 self-check prompt——增加 token + 不可靠。
- **影响**：所有"高频违反 / 跨副本一致性 / dogfood 边界"类规则必须问"能不能 pre-commit 拒掉"。第一批落地的 checker：`checkPropagateSync` / `checkOrchestratorSync` / `checkPlanScope`（ADR-012）/ `checkPlanCompletion`（C7）。新增 checker 必须配 smoke scenarios（`scripts/smoke-pre-commit.js`），覆盖 pass/fail/grandfather/fail-open 4 类至少各 1 个。
- **来源**：`docs/solutions/2026-05-12-pre-commit-defense.md`、Phase 4 review 暴露 7 P0 中 6+ 个无-FM 旧 plan dogfood blocker。

### ADR-013 §B: Enforcement 提案必须 inline dogfood 边界产物枚举 (2026-05-12)
- **状态**：已采纳
- **上下文**：ADR-013 主决策落地时 Phase 4 reviewer 发现 hook 装上**立刻**会拒绝 6+ 个本仓库**已有的**无 frontmatter 旧 plan。原 dogfood 步骤只验证：(a) 我刚写的新 plan 通过 + (b) 破坏一次再恢复——**没枚举本仓库已有的同类产物是否都满足新规则**。如合并，hook 上线第一天就阻塞合法旧产物，用户必须 `--no-verify` 绕过——enforcement 最差启动状态。修复方式是 grandfather signal 改用 filename date（path-regex 强制，独立于 frontmatter），一次性解决无-FM / CRLF / 不可解析 created 三个失效。
- **决策**：任何新 enforcement 机制（pre-commit / lint / CI / hook with reject）合并前必须满足"dogfood 边界覆盖"：(a) 枚举本仓库与新规则同类的**已有产物**至少 3 个边界样本（最老 / 最新 / 格式异常 / 跨平台 line-ending / 中文文件名 / 已 grandfather）；(b) 离线模拟 enforcement 跑这些样本不被误拒；(c) 如有误拒，要么 grandfather 要么主动改造旧产物——而不是上线让用户 `--no-verify`；(d) plan 阶段「关键假设验证」段必须含一条"会拒绝哪些现有产物"枚举。**额外要求**：当前态全部合规时必须主动制造负样本验证（改一个文件 1 字符 → 跑必须 fail；恢复 → 跑必须 pass），少了这步 = enforcement 上线但实际从未被验证过（fail-open 风险）。
- **原因**：(1) 智能猜测的 enforcement 规则在真实语料上 FP 率惊人（C7 实施时 12 个现有 plan 立刻爆 2 个 FP = 17%）；(2) 上线后被 `--no-verify` 绕过 = enforcement 死亡，因为用户养成"反正先 --no-verify"习惯后不可逆；(3) "当前态合规"是 trivial pass 状态，单测不能证明 hook 真在拒（fail-open 静默失效在 `[hook] failed:` marker 不存在时无法检测）；(4) 边界产物枚举是低成本步骤（10 分钟跑一次），节省的是上线后用户绕过 hook 几周的隐性成本。
- **备选**：(a) 不枚举边界产物，上线后修复 FP——已实证 ADR-013 主决策第一次就踩；(b) 把所有现存产物 grandfather——会让规则永远无法约束历史；(c) 强制用户改造所有旧产物——用户成本太高，会拒绝合并 enforcement。
- **影响**：plan 阶段「关键假设验证」段必须含"会拒绝哪些现有产物"枚举；plan 阶段必须有「Dogfood 自检」H2 或 H3 段（含边界产物列表 + 负样本验证步骤）；smoke 必须覆盖 pass / fail / skip-grandfather / fail-open 4 类。本条款已在 C7 (`docs/plans/2026-05-13-plan-completion-verify.md`) 第二次成功应用：dogfood 12 个现有 status:completed plan → 立刻爆 2 个 FP（命令形式 inline-code 误匹配 / 仓库外路径），均通过 regex 迭代修复而非降低 enforcement 强度。
- **来源**：`docs/solutions/2026-05-12-pre-commit-defense.md` Prevention §1；`docs/plans/2026-05-13-plan-completion-verify.md` Phase 5 复利（第二次应用验证）；本能 [[mechanism-over-discipline]]。

### ADR-012: Plan 阶段必须勘察被改文件，不能纯靠假设 (2026-05-11)
- **状态**：已采纳
- **上下文**：`docs/plans/2026-05-11-sprint-speed-layer1.md` Phase 2 plan 阶段连续两次基于错误假设拍 plan，到 Phase 3 work 阶段才发现：(1) 假设 `CONTEXT_BUDGET_CHARS = 25KB`，实际 `inject-context.js:25` 是 12KB — T3 价值定位需重写为"提升相关性"而非"减小体积"；(2) 假设要改 `scripts/agent-orchestrator/pipeline.js` 实现 Phase 间预热，实际该文件是 agent-loop v7 pipeline mode 的代码，跟 `/sprint` 完全不是同一回事，T4 改动对象错了 → 必须停下来重新设计为修订版 A 方案（改 sprint.md 协议 + 5 phase 钩子）。两次错误都导致 work 阶段停顿、重新与用户对齐、调整 plan。
- **决策**：Plan 阶段必须读取被改文件的关键代码段验证关键假设（"我以为这文件是干嘛的"、"我以为这个常量是多少"、"我以为这个目录在哪"）。具体规则：(a) plan 列出的"涉及文件"清单中每个文件至少有一次 Read（哪怕只读 frontmatter / module.exports / 关键常量）；(b) plan 中所有"假设 X"必须标记可信度 — 不能纯凭模型记忆下决定。Plan 阶段比 work 阶段慢 10-20 分钟换 work 阶段不返工，性价比正。
- **原因**：(1) work 阶段才发现 plan 错 = 需要停下来重新设计，浪费已实施的部分；(2) 用户会感知到"为什么你 plan 说要改 A 现在又改 B" — 信任成本；(3) plan 错的根因是"模型基于过往记忆 / 文件名猜测内容"，而记忆和文件名都会过期 / 误导；(4) 本 sprint 两次 plan-error 都是 30 分钟内能避免的（读 25 行 + 读 1 个 module.exports）。
- **备选**：(a) plan 阶段不勘察，work 阶段发现再返工 — 已踩坑，本 sprint 复发两次；(b) plan 之前先全文 explore — 太重，1 个文件就够；(c) 只在 L3+ task 勘察 — 本 sprint T3/T4 都是 L3 但仍踩坑，证明 L2 也需要勘察。
- **影响**：sprint plan 阶段输出必须包含「关键假设验证」短段（哪些假设、验证了哪些文件、可信度）；planner agent / `/plan` 命令文档应加入此要求；review 阶段对 plan 文档审查"假设是否被验证"作为审查点。
- **来源**：`docs/plans/2026-05-11-sprint-speed-layer1.md` Phase 2→3 转换时的两次 plan 修正。

### ADR-011: 评估外部架构思想时遵循 identity-question-first 原则 (2026-05-11)
- **状态**：已采纳
- **上下文**：评估 `garrytan/gbrain`（同作者 Garry Tan 同生态、公开质量极高的项目）的 12 个架构思想是否融入本项目时，Phase 1-3 直接进入"按 ROI 排序选 top-3"。Phase 4 product-lens reviewer 指出真问题不是"挑哪几个"而是"本项目还是 gstack-aligned 吗，还是已演化为不同物种"。Identity question 没回答时，研究会**"导入表面 / 拒绝脊椎"**（例如 C8 thin/fat 反向哲学是 positioning signal 不是 candidate）。同时 ROI 在身份不明时偏 speed-wins，但 solo-maintainer 的成本曲线与团队反向（speed wins 在 solo 场景累积负利息）。
- **决策**：评估外部架构思想（gbrain / 未来其他 sibling 项目 / 大幅 refactor 提议）必须先回答 identity question："本项目是 X / Y / Z 中的哪一个？" 答案明示后，多数候选变 trivially decidable。具体到本项目：**tech-persistence = developer-toolchain self-evolution sibling**（不是 gstack / gbrain 替代）；4 条不可妥协原则 — 多运行时 parity / 确定性优先 / 轻量优先 / Obsidian 兼容。ROI 评估默认按 "5 年杠杆 / 维护表面增量" 而非 "人天 / 速胜"。
- **原因**：(1) Cherry-picking 思想会 import surface / reject spine，结果不连贯（C8 反向哲学 = positioning signal 不是候选）；(2) ROI top-3 在身份不明时容易偏 speed-wins，但 solo 用户的成本曲线与团队反向；(3) reviewer 反馈系统证明这是 **product-lens 才能抓到的问题**，coherence + feasibility 抓不到 — 多视角并行 review 在研究文档上不可省略。
- **备选**：(a) 不写 ADR，靠下次评估时凭感觉 — 会忘；(b) 把身份陈述放 CLAUDE.md 顶部"关于我"段 — 把身份和个人偏好混淆，未来其他评估 sprint 不会读到。
- **影响**：未来任何"是否融入外部思想 / 大幅 refactor"的 sprint 必须有 Phase 0 / 前置「项目身份界定」段，明示 4 条不可妥协原则与候选评级的对应关系；ROI 评估默认按"5 年杠杆 / 维护表面增量"；评估流程**必须 spawn 至少 1 个 product-lens reviewer**（不能只 coherence + feasibility）。
- **来源**：`docs/plans/2026-05-11-gbrain-gstack-analysis.md` Phase 4 product-lens reviewer 反馈。

### ADR-009: 全局 `--auto` 决策协议放在单一 rule 文件，命令通过引用获得行为 (2026-05-09)
- **状态**：已采纳
- **上下文**：每个工作流命令都有自己的人工 gate（`/sprint` phase 间 'go'、`/agent-loop` freeze、`/work` task 完成确认、`/review` P0 修复确认），各自硬编码"必问"。新增 `--auto` 参数若每个命令各自实现行为定义，会立刻分叉；同时缺少跨命令一致的"什么时候必须问、什么时候可以自动"边界。
- **决策**：建立 `~/.claude/rules/auto-mode.md` 作为单一决策协议中心。三档矩阵（强制人工 / 自动通过 / 灰区智能判断）+ 各命令的具体集成表都在这一份规则里。每个命令文件只在"可选参数"段引用 `详见 ~/.claude/rules/auto-mode.md`，不复制规则正文。orchestrator 增加 `--auto-evaluate`（条件 freeze）与原有 `--auto-freeze`（永远 freeze）形成两档。
- **原因**：单 source of truth 防止规则分叉。命令文件只声明"接受 --auto"，行为定义集中在规则。强制人工边界（destructive、L4、scope creep、安全相关、测试失败）在规则里写清楚一次胜过 21 个命令各自重复。Orchestrator 双层 freeze 区分"全自动"（已存在用法）和"智能审查"（新增），不破坏旧行为。
- **备选**：每个命令各自定义 `--auto` 行为；只在 `/sprint` 实现 `--auto`；用 hook 拦截。前者会立刻分叉，第二个不通用，第三个让 hook 介入业务决策不合适。
- **影响**：新增工作流命令只需在"可选参数"段加一行引用即可获得 `--auto` 支持；规则更新一次所有命令一致。要求 install 脚本同步复制 `auto-mode.md`（已加入 install.sh / install.ps1）。

### ADR-008: Memory v5 启动注入必须合并兼容运行时索引 (2026-05-07)
- **状态**：已采纳
- **上下文**：Claude Code 默认写 `~/.claude/homunculus`，Codex 默认写 `~/.codex/homunculus`。即使推荐共享 `homunculusHome`，未配置共享目录时两个运行时仍可能各自产生 durable Memory v5 topic notes；旧的 SessionStart first-hit fallback 会让一个 `MEMORY.md` 遮蔽另一个。
- **决策**：项目身份识别、Memory v5 topic entry 解析、去重、排序和 index 格式化统一放入 `scripts/lib/memory-v5.js`；`inject-context.js` 对 `resolveCompatReadDirs()` 返回的所有兼容 memory 目录做合并注入，不再第一个命中就停止。
- **原因**：一致性应该由当前 runtime helper 保证，而不是靠用户记住每次都配置共享目录；同一个 helper 还能避免 observe/inject/evaluate 三个 hook 的 project id 漂移。
- **备选**：强制所有用户配置共享 vault；把 Codex memory 复制进 Claude memory；继续 first-hit fallback。前者破坏默认安装可用性，复制会制造写入副作用，first-hit fallback 已证明会造成上下文漂移。
- **影响**：共享 vault 仍是文件级持续同步的推荐方案；默认分离目录下，启动上下文读取保持一致，但各 runtime 的 topic 文件写入位置仍保持独立。新增 memory helper 时必须同步 root hooks、Codex plugin hooks 和 parity smoke。

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

### ADR-002: Codex Memory v5 使用轻量索引 + Topic 文件 (2026-04-24)
- **状态**：已采纳
- **上下文**：v4 已有 observations、instincts 和 sessions，但 SessionStart 注入缺少类似 Claude Code auto memory 的轻量启动索引，容易在“全量会话摘要/本能列表”和“无记忆”之间摇摆。
- **决策**：在 `projects/{hash}/memory/` 下新增 `MEMORY.md` 和 `memory/{topic}.md`。`MEMORY.md` 只保存通过置信度门控的高价值索引，目标 `<200 行 / 25KB`；调试、测试、工具链等细节进入 topic 文件。
- **原因**：轻量索引能稳定注入未来最可能复用的信息；topic 文件保留细节但默认不进入上下文；结构与 Claude Code auto memory 的实践一致，便于用户理解和审计。
- **备选**：只继续写 instincts；把完整 sessions 注入；引入数据库/向量检索。前者缺少可读启动索引，第二个上下文成本高，第三个超出当前纯文件/Obsidian 模型。
- **影响**：Hook 必须规范化 Codex payload、脱敏、去重并维护 `MEMORY.md` 预算；安装脚本和 Codex plugin 构建必须复制 `scripts/lib/`。
