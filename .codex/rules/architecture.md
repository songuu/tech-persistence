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

### ADR-041: Sprint 按宿主能力执行，品牌 provider 只作为显式可选后端 (2026-09-03)

- **状态**：已采纳
- **上下文**：`/sprint` 默认语义已经是 `--runtime current`，但命令文档仍把并行实现、复审和计划中的 `both` 描述为 Claude/Codex 固定分工，导致执行者可能在当前宿主完全可用时，因为未选中的 Claude OAuth 过期或 Codex 未安装而停在 Plan。用户环境还可能只有一个 provider，或由其他 Harness/Agent 框架托管。
- **决策**：Sprint 核心只依赖当前可执行宿主，并按阶段 capability 决定 spawn、inline、串行或显式 backend 委托；provider 品牌不是 capability。`/agent-loop` 保持独立、显式选择的可选后端，需求文本出现 Harness/Transcript/provider 名称不构成选择信号。非当前 provider 不可用不阻塞 Sprint；detached runner 没有任何候选时只阻塞具体阶段并报告缺失 capability。副作用前可换到满足策略的候选，partial/committed effects 后继续执行既有 same-provider resume/reconciliation 规则，禁止切换 writer。
- **原因**：把方法论编排与 provider transport 解耦，才能同时覆盖仅 Codex、仅 Claude Code、其他宿主和双 provider 环境，又不削弱 ADR-037 的 writer/effect 安全边界。
- **备选**：把 Claude 登录作为 Sprint 全局前置；要求所有用户安装两套 CLI；根据需求里出现的 “Harness” 自动进入 `/agent-loop`。这些方案把部署偶然性提升为产品架构约束，并会产生与截图一致的错误阻塞。
- **影响**：`--runtime current` 始终在当前宿主闭环；`both` 暂作兼容入口并回退 current，直到 agent-loop 有 goal-budget 承接 seam。跨 provider 独立复审不可用时必须标记 assurance 降级，但不能把流程伪装成多 provider，也不能把非当前 provider 的认证失败当成恢复条件。

### ADR-034: Gate B-1 cohort 排除使用 authority-owned 不可变 tombstone (2026-09-01)
- **状态**：已采纳（机制已落地；未对真实 run 执行排除）
- **上下文**：expected-sample marker 让中断 run 不会因缺 Receipt 而静默消失，但永久把明确放弃或评估前被替代的 run 记为错误，也会让 cohort 生命周期无法收敛。若 provider 或普通运维脚本可在看到结果后排除样本，则 Gate B-1 分母可被操纵。
- **决策**：tombstone 只能由 provider workspace 外的固定 lifecycle broker 授权，精确绑定 stable run locator、Contract hash、expected-sample marker hash、受限 reason、operator event 与 control-envelope digest，并以 content hash 写入 external control store 的不可变 singleton。只允许 `operator-abandoned` 与 `superseded-before-evaluation`，且仅在不存在任何 Receipt authority 时创建；Receipt 创建路径反向拒绝已有 tombstone。离线 report 重算全部 binding/hash，只排除无 Receipt 的有效 tombstone；tombstone+Receipt、篡改、缺 marker/Contract 或并发竞态全部 fail closed。PostgreSQL 内部 record-kind/schema 预留 `cohort-tombstone`，公开 append broker 继续拒绝该 kind，避免 provider 获得 lifecycle authority。
- **原因**：排除样本是改变统计分母的治理动作，不是 provider 的运行状态更新。外部 broker + immutable marker binding 能把“为什么不再期待 Receipt”与原始 cohort 身份锁定，同时保留审计记录。
- **备选**：删除 expected marker；按目录不存在自动排除；允许任意 reason；Receipt 产生后仍可 tombstone；让公开 PostgreSQL broker接受 tombstone。它们分别允许静默丢样、目录操纵、不可审计排除、事后挑样和权限扩大。
- **影响**：`acceptance:cohort:tombstone` 只是受控运维入口，实际执行会改变 Gate B-1 分母，仍需对目标 run 与原因做显式治理确认。本轮没有 tombstone 任何现有真实 run。并发产生 Receipt 会留下冲突证据并阻断样本，而不是自动选边；OS account/ACL 未落地前仍不声称 hostile same-user 隔离。

### ADR-033: 晚到用户确认使用 append-only Receipt successor chain (2026-09-01)
- **状态**：已采纳（shadow lifecycle）
- **上下文**：用户只能在看到具体 subject 后合理确认，但首份 shadow Receipt 已可能以 unknown 持久化；覆盖它会破坏 immutable evidence，继续拒绝则让 user-confirmation 无法形成真实闭环。
- **决策**：同一 `contractHash + subjectHash` 的 Receipt authority 使用从 1 开始的 `evaluationSequence` 和 nullable `predecessorReceiptHash` 形成唯一线性链。genesis 永久保留；successor 只允许 `user-confirmation` criterion 从 unknown 单向收敛到 passed/failed，且只能新增一个 verified user-confirmation ref，claimed refs、evaluator、其他 criterion 和任何已有 terminal status 不得变化。相同 Receipt replay 不增加序号；离线报告验证全部 Receipt、连续序号、predecessor、单调 diff 后只计 head。非 canonical duplicate 保留既有诊断兼容；canonical fork/gap/conflict fail closed。
- **原因**：append-only chain 同时保留历史真相与晚到 authority，不需要覆盖或删除，也与 PostgreSQL append-only ledger 的 record-key-by-receipt-hash 模式一致。
- **备选**：首份确认前不写 Receipt（丢失 Gate B-1 unknown 样本）；覆盖 unknown Receipt（破坏不可变性）；让 provider 指定 latest（可重放/降级）；允许任意 criterion 重新评估（把 successor 变成绕过 stale-evidence 的通道）。
- **影响**：report 扫描成本仍为 authority record 数量的 O(N)，并发写入可能产生 fork 且会保守阻断样本；未来 cohort tombstone/supersession 必须复用 authority-owned 链语义，不能引入第二套“最新版”选择规则。

### ADR-032: 用户验收确认必须由原生 canonical control 与外部 reader 共同证明 (2026-09-01)
- **状态**：已采纳（Codex adapter；Claude parity 仍按 P1-6b 单列）
- **上下文**：普通自然语言“通过/确认”、provider assessment 或 agent 自造 JSON 都不能代表用户授权；仅记录原生 prompt 也不足以证明它绑定当前 Contract、subject 与 criterion。
- **决策**：扩展既有 `TP_SELF_LEARNING_CONTROL_V1`，新增 exact-shape `confirm-acceptance` action，字段固定为 `contract_hash + subject_hash + criterion_id + oracle_hash + accepted|rejected decision`，且 JSON 字节必须等于 canonical serialization。Codex `UserPromptSubmit` hook 只把它记录为显式 user event，不在 hook 内判断当前合同。Acceptance evaluator 使用固定仓库外 `--acceptance-user-confirmation-broker` 读取 native event authority，要求 exact response、stable run locator、完整四元 hash、固定 `codex_cli:UserPromptSubmit` authority、event ref 与 control-envelope digest；结果进入 external system-owned seal，Receipt 与离线 report 重新计算 binding/verdict/digest。broker 失败、普通语言、错误 authority/locator/binding、seal 注入或篡改一律保持 `unknown`。
- **原因**：原生 hook 证明“用户确实提交了哪段显式控制”，外部 reader 证明“该控制对应当前验收对象”；两者缺一都会把意图捕获与运行时绑定混为同一自报边界。
- **备选**：从自然语言推断确认；复用 self-learning candidate 的 `approve` action；让 hook 直接写 Acceptance Receipt；信任 provider 传入 event ref。它们分别造成意图误判、领域身份混淆、hook 越权裁决和引用伪造。
- **影响**：Codex adapter 在评估时已有匹配 native event 的前提下能产生 verified passed/failed；未配置 broker 或没有对应 event 时保持 unknown。晚到确认按 ADR-033 追加 immutable successor，不覆盖 unknown genesis。Claude 侧没有同等原生 control reachability，必须在 P1-6b 选择对等入口、显式降级为 independent-review，或按 ADR-011 记录豁免，不能静默宣称 parity。OS 服务账户/ACL 未落地前仍不声称 hostile same-user 隔离。

### ADR-031: Criterion readback/review 使用固定外部 broker 与 system-owned seal (2026-09-01)
- **状态**：已采纳（shadow authority adapter；尚未解决同 OS 用户隔离）
- **上下文**：provider assessment 与普通 `review.json` 都是 provider/reviewer 可写输入；只有 hash 自洽、summary `approved` 或不同字符串 identity 不能证明真实 readback/独立 review。broker 若继承宿主 token、缺少目标 run 绑定或可从 provider workspace 替换，同样不能成为 authority。
- **决策**：`readback` 与 `independent-review` 分别使用显式配置的固定 broker。broker 必须是 provider workspace 外的非链接普通文件，子进程只继承 Windows 启动所需的最小系统环境白名单，不继承 PATH、HOME、API token 或数据库 URL。每个冻结 criterion 的请求包含 stable run locator 与 `contractHash + subjectHash + criterionId + oracleHash`，响应必须 exact-shape 并原样回显 locator/binding；readback 要求 reader/writer identity 不同，independent review 要求 reviewer/writer identity 不同且逐 criterion 返回 `passed|failed|unknown`。broker 执行前后 inode/size/mtime/digest 不变才把完整覆盖写入 external append-only seal，Receipt 和离线 Gate B-1 report 都重新计算 seal/evidence digest；调用方不能注入 seal。
- **原因**：authority 需要同时绑定“哪个 run、哪个合同、哪个结果、哪个 criterion、哪个 Oracle、哪个身份做了什么观测”。外部 broker 把实际查询/复审与被验收 provider 分离，system-owned seal 把观测结果从普通 JSON claim 升级为可重放验证的证据。
- **备选**：直接信任 `acceptance-assessments.json`；扩展现有 review schema 后把同一 provider 的 `approved` 当独立 review；允许任意 SQL/command；让 broker 继承宿主环境。它们分别造成 self-attestation、身份假独立、注入面扩大和凭据泄漏。
- **影响**：未配置 broker、执行失败、binding/locator 漂移、同身份、未知决定或 broker 变化一律保持 `unknown`，不影响 legacy terminal state。broker 的真实 reader/reviewer 凭据必须来自独立服务边界；同 OS 用户仍可能在执行前替换未受 ACL 保护的 broker，因此服务账户/ACL 完成前 P1-4 仍不得宣称 authority 隔离完成。详见 [[2026-09-01-shadow-acceptance-evidence-boundary]]。

### ADR-030: Acceptance PostgreSQL authority 使用 append-only writer 与独立 reader (2026-09-01)
- **状态**：已采纳（authority ledger 基础设施；尚未替代 P1-4 filesystem control store）
- **上下文**：Acceptance Receipt、validation/artifact/review/readback seal 需要比 provider-writable workspace 更强的持久化边界；单连接写后自报、共享数据库凭据或只验证连通性不能证明 durable readback。
- **决策**：复用 transcript/Agent 项目的 PostgreSQL 分权模式，设置 `acceptance_writer` 与 `acceptance_reader` 两个独立 LOGIN role。writer 仅可 INSERT append-only ledger 并读取冲突键/hash，reader 设置 `default_transaction_read_only=on` 并读取完整记录；应用在 writer 事务提交后必须通过 reader 对 canonical payload/hash 做精确回读。表级 trigger 拒绝 UPDATE/DELETE，双方均无 schema create、ownership、superuser、bypass RLS、truncate 权限。provider 子进程环境剥离 acceptance/transcript 数据库 URL。
- **原因**：hash 只能证明内容自洽；独立数据库身份、最小权限、不可变键冲突和提交后读回共同证明记录由 harness authority 路径持久化，且 writer 不能回读完整 payload 来伪装独立验证。
- **备选**：继续只用同 OS 用户的外部目录；writer 写后用同一连接 SELECT；合同携带任意 SQL。前两者缺少独立 authority，后者扩大注入和数据访问面。
- **影响**：`acceptance:postgres:canary` 是启用前门禁；任一 privilege attestation、冲突或 readback mismatch 都 fail closed。Shadow Receipt 可经显式外部 broker 镜像到 ledger，且 broker/env 必须位于 provider workspace 外；plugin runtime 不内置 npm 依赖，需指向部署方管理且具备锁定 `pg` 依赖的 broker。当前私密 env/secret 仍由同一 OS 用户持有，因此这只是数据库权限隔离基础，不宣称已解决 P1-4 的 OS 级 authority 隔离；criterion readback/review broker 见 ADR-031，服务账户边界与 cohort/tombstone 仍待完成。

### ADR-029: Shadow Acceptance 的 claim 与 verified evidence 分权 (2026-09-01)
- **状态**：已采纳
- **上下文**：P1 批 1 需要用真实 run 的 Receipt 分布决定是否进入 enforce；provider-writable assessment 可以描述证据，但不能证明自身的 command、artifact、reader 或 reviewer claim 为真。
- **决策**：assessment 只承载 locator/claim；只有 runtime-owned resolver 从权威 ledger、受限根目录 artifact、独立 reader 或 native reviewer authority 读回并复算的证据可标为 verified。Receipt 原语强制 exact coverage、subject/ref/contract/Oracle 绑定与 `passed => matching verified evidence`。shadow 写盘始终 best-effort，不得影响 classic、slice 或 integration 的权威状态迁移。没有真实 Contract/assessment producer 与 resolver 时，Gate B-1 保持 blocked。
- **原因**：普通 SHA-256 证明内容自洽，不证明 provenance；错误的 shadow 分布会让后续 D1 与 enforcement 建立在伪证据上。
- **备选**：信任 provider 的布尔字段；先收集分布再补 resolver；直接把 Receipt 接入 Completion Gate。三者都会把被验收者的自报升级为权威事实。
- **影响**：P1-4 必须增加真实 classic/pipeline E2E、伪造 claim、symlink/不可写路径和 shadow-error 状态等价回归；command validation 只有在 external control store 完成 pre-provider seal、worktree snapshot 复验与单 subject binding 后才可 verified。artifact adapter 必须在 freeze 封存基线、reviewer 前将 changed-files effect scope hash 绑定 accepted subject，post-review 仅从 workdir 内有界读回并拒绝 link/逃逸/读时变化，再把 baseline/current/scope 绑定 contract+subject；其他 Oracle 仍须各自建立 authority adapter。路径隔离不等价于 OS ACL，source/plugin runtime 必须行为一致。详见 [[2026-09-01-shadow-acceptance-evidence-boundary]]。

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
### ADR-035: Provider dispatch 使用可验证的独立 Linux 身份边界 (2026-09-01)

- **状态**：已采纳（运行时机制已实现；宿主账号/ACL 部署尚未证明）
- **决策**：provider 启动可配置独立正整数 UID/GID 与 provider-owned 0700-style home，并由绝对路径、root-owned、非链接、group/other 不可写且整条 canonical 父目录链同样受保护的 `setpriv` 以 `--reuid/--regid/--clear-groups` shell-free 执行。provider UID 必须不同于 harness authority UID；环境切换 HOME/XDG，剥离 authority 用户目录、SSH/GPG/sudo 与私密 PostgreSQL URL。launcher 在执行后复核权限与 SHA-256，变化即以 `provider-os-isolation-integrity` fail closed。生产部署用 `--require-provider-os-isolation` 禁止缺失配置降级。
- **备选**：只检查外部路径；同一 UID 下隐藏环境变量；依赖 shell/sudo；只在启动前检查 launcher。它们分别不能抵抗同用户读取、扩大命令解释面，或留下可替换路径与执行期漂移窗口。
- **影响**：Windows 显式拒绝 UID/GID 模式；仓库不自动创建系统账号、赋 capability 或修改 ACL。运行时机制通过不等于部署证明，只有宿主完成独立账号、最小 capability/ACL 与 read-only audit 后才能关闭 P1-4 的 OS 隔离缺口。

### ADR-036: OS authority 部署使用 capability launcher + 反向访问证明 (2026-09-01)

- **状态**：已采纳（部署资产完成；目标 Linux 宿主尚未 attested）
- **决策**：固定创建 `tp-authority` 与 `tp-provider` 两个 nologin system account，primary UID/GID 分离且均不得有 supplementary groups。root-owned `provider-identity-launcher` 只给 authority group 执行，mode 固定 0750，capability 必须且只能是 `cap_setuid,cap_setgid=ep`；launcher 编译时固化 authority/provider identity，只接受 canonical setpriv-compatible argv、绝对 provider command，降权后清空 groups/capabilities 并设置 `no_new_privs`。launcher canonical 父链与 authority/provider 敏感路径拒绝 link、group/other write 与任何 named/default extended ACL。authority home/control/env 固定 authority-owned 0700/0700/0600，provider home 固定 provider-owned 0700；shared workdir 固定 `authority:provider 0770`，使 authority 可编排而 provider 可修改项目。harness/plugin/broker/env 必须从 authority-owned、workdir 外路径加载，不能执行 provider 可写 repo 中的 authority code。安装只在 root + 精确确认令牌下执行，不覆盖既有 env 内容；随后必须以 authority 身份真实降权，并主动证明 provider UID/GID/groups、secret 不可读、control 不可读写、launcher 不可执行、authority/root identity 与相对 command 被拒绝，以及 workspace 可写。
- **备选**：sudoers command allowlist；setuid-root wrapper；只检查 mode；root 直接运行 harness；把 audit JSON 放在 provider workspace 自证。它们分别扩大解析/提权面、忽略 ACL 旁路、让 authority 过权或允许伪造证明。
- **影响**：安装会创建宿主账号、目录、file capability 与 ACL 状态，因此默认只输出 plan，apply 保留固定 destructive gate。Windows CI 只验证纯 evaluator、模拟 collector 和 shell 合同；P1-4 只有在目标 Linux 上保存通过的独立 JSON audit 后才可关闭此项。

### ADR-037: 外部 Runtime 先 shadow，read-only 与 writer 分级晋级 (2026-09-01)

- **状态**：已采纳
- **决策**：外部 Runtime 只能由 checked-in descriptor 注册，先生成零 workspace diff、零 external effect 的 shadow decision。read-only 晋级必须同时具备 observed capability、固定 canary 全通过、环境 allowlist、零 identity/hash mismatch 和显式 promotion receipt；writer 晋级另需真实 transcript/outbox/PostgreSQL 独立读回，并始终保持唯一 writer。出现 partial 或 committed effects 后禁止切换 Provider。
- **原因**：`/health` 成功、SDK 兼容或配置存在均不能证明服务 ready、证据可关联或写入安全。把不同权限级别拆门可以在继续实现 adapter 的同时阻止证据不足的 live mutation。
- **影响**：sibling `agent-api` `/ready`=503 的 fail-closed 状态保持不绕过；采用 sibling Agent 已有的 OpenAI-compatible/Ollama 调用 seam，以固定 llama.cpp 与真实模型完成 P3-2 至 P3-5。外部 runtime 仅晋级 read-only，writer 仍未晋级；不得从 read-only receipt 推导写权限。

### ADR-038: Promotion receipt 必须链式绑定真实 canary receipt (2026-09-01)

- **状态**：已采纳
- **决策**：外部 runtime promotion 的 canonical core 必须包含合法的 `canaryReceiptHash`，并由最终 `receiptHash` 覆盖。repo-read canary 必须让模型精确回显有界输入内容的 SHA-256，不能只证明 harness 自己可读文件。receipt 使用不可覆盖文件保存，旧 receipt 在 canary 变化后自然失效。
- **原因**：未绑定 canary receipt 时，不同 canary 可生成同一个 promotion hash；仅由 harness 本地读文件则无法证明 provider 看到了被测试内容。
- **影响**：缺失或格式错误的 canary hash 一律保持 shadow；Schema 与测试必须使用带 `sha256:` 前缀的真实格式并覆盖缺失绑定负例。详见 [[2026-09-01-external-runtime-live-promotion]]。

### ADR-039: 外部 Harness 只读接线与模型上线资格分离 (2026-09-02)

- **状态**：候选实现已验证；真实模型资格未通过，当前 Harness 发布链接未切换。
- **决策**：沿用既有 Task/Route/Result/Goal/Acceptance 所有权，仅扩展显式 spec/review Provider adapter；外部 runtime 永不进入 writer。配置在 workspace 外绑定 canary、promotion、endpoint、model 和 resume hash。模型服务是独立 provider 身份的 loopback HTTP 服务，固定 transport 是 authority 代码且不继承凭据。
- **上下文**：模型仅获得 bounded-context，不声称拥有 repo-read 工具。Linux 文件上下文使用实际 fd 路径与 inode 校验；review 读取当前完整材料，缺失、超限、binary/overflow/omission fail closed。非 Linux 不静默降级文件读取边界。
- **持久化**：authority 请求先落盘，再 dispatch；hash-only 语义事件由独立 worker 提交，reader 校验事件全部字段及 cursor/hash，成功后原子 ack。坏任务隔离并公平重试；terminal capture-incomplete 或半帧保留为需协调状态，不猜造响应、不重跑已执行任务。
- **验收边界**：小 canary PASS、Transcript ack、主 CLI fixture PASS 分别证明各自层级。2026-09-02 两次真实135M主 spec 分别 terminal 拒绝/超时，不能据此宣称完整模型或公网交互功能可用。详情见 [[2026-09-02-harness-transcript-production-wiring]]。

### ADR-040: 公网任务使用独立身份与执行边界，不继承演示 runner 的权限 (2026-09-02)

- **状态**：TP 独立账户/可撤销短期会话方案已获专项批准；A1/A2 候选已实现并通过受控 Linux/PG 验证，公网任务未部署。
- **决策**：既有站点只有共享 Cookie，不用作独立主体；TP 采用独立账户和随机会话，由独立网关绑定主体与批准的 project。durable task request 不能携带任意 CLI、路径、env 或 provider 配置。authority 二次验证并调用既有 Harness，保持唯一 writer/Acceptance/Transcript 所有权。多用户执行必须证明逐任务文件与网络隔离，共享 provider UID 和顺序执行本身不足以保证隔离。
- **模型边界**：若获准使用 sibling Agent 的远端模型，凭据由固定目标的独立 provider broker 持有，authority transport 继续只访问 loopback；不因 `hasKey=true` 就使用凭据、产生费用或扩大外部 writer 权限。
- **审批进展**：登录源码审阅、模型复用/费用和 TP 独立账户均已获得授权，不重复申请同一范围；默认关闭公开注册，不改造其他项目登录。默认 PATH 没有已验证的 Claude/Codex writer，完整模型资格仍未通过；不得以身份底座通过、登录页 200、模型 Schema 探针或静态 Cookie gate 证明完整任务功能。详见 [[2026-09-02-authenticated-harness-tasks]]。
- **A1 边界**：`harness_web` 新 schema，运行角色不可改账户，管理角色不可查 session；PG 只存 token hash，每次认证复核账户版本/停用/过期/撤销。密码 scrypt 两并发、全部认证请求最多 16 个业务名额；断开 socket 不提前释放 DB 操作。限流/会话事务固定 READ COMMITTED，不能依赖默认隔离级别；关闭失败必须脱敏且非零退出。真实临时 PG 证据和既有 Transcript/Receipt 数据严格分开。
- **A2 边界**：`harness_tasks` 使用 NOLOGIN function owner 和仅可执行五个批准函数的 web task 角色；函数从 session hash 重建主体，不信任调用方 owner 参数。创建/入队采用 READ COMMITTED + 全局短事务锁，项目/成员授权行 FOR SHARE 保持至提交，缺失行/NULL 明确拒绝，幂等重放也复核当前授权。仅持久化 draft/queued，无 claim/dispatch/accepted/Receipt/Transcript 写权限。会话检查不扩大为 auth 表 UPDATE 权限，不回溯取消在途事务；A3 dispatch 仍需重验。A6 另核验最小权限离线管理、生产有效 ACL、参数日志和容量，详见 [[2026-09-02-task-authorization-row-locks]]。
