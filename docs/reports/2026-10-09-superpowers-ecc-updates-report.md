---
type: sibling-update-evaluation
status: completed
created: 2026-10-09
updated: 2026-10-09
scope: research-only
superpowers_commit: 8ca22dba9a94f28898bbce59f2537ff4d87c747d
ecc_release_commit: c05b2d6614f62f6db0047669aa4eefb223d478f9
ecc_main_commit: ef648e01899ba3e8dc6371642deaaf64b4477775
tags: [evaluation, superpowers, ecc, architecture]
---

# Superpowers / ECC 近期更新：值得借鉴的增量

**建议优先补 Plan 的接口与断言约束、Plan→Review 的隐含失败输入交接。工程侧接着审计旧安装路径的文件所有权，再补实际分发产物的生命周期验证。** 会话诊断适合复用现有入口做小范围增强。整包接入和再建控制面没有足够增量价值。

本轮采用 sibling-eval-protocol 的证据、候选评分与三项独立复核；按用户约束跳过自动 Compound、学习写入和索引晋级。只保存研究产物，不实施候选。

## 1. 版本、时间与研究范围

| 项目 | 已验证最新发布 | 固定源码及范围 |
|---|---|---|
| Superpowers | v6.4.2；GitHub `published_at=2026-09-25T18:08:09Z`，北京时间 9/26 02:08 | HEAD 与 peeled release commit 都是 `8ca22dba9a94f28898bbce59f2537ff4d87c747d`。对比此前 v6.3 评估提交，重点核查 v6.4.1 / v6.4.2 |
| ECC | v2.2.3；GitHub `published_at=2026-10-01T23:00:36Z`，北京时间 10/2 07:00 | release 为 `c05b2d6614f62f6db0047669aa4eefb223d478f9`；本轮 main 为 `ef648e01899ba3e8dc6371642deaaf64b4477775`，仅多 1 条日文 README 赞助名单更新。重点核查 2.2.x 发布及源码 |

来源：[Superpowers v6.4.2](https://github.com/obra/superpowers/releases/tag/v6.4.2)、[ECC v2.2.3](https://github.com/affaan-m/ECC/releases/tag/v2.2.3)。日期以发布记录为准；CHANGELOG 的标题日期、tag 创建时间和实际发布可能不同。

ECC 2.2.x 的 GitHub 实际发布时间（UTC）：2.2.0 为 8/28 19:55:05，2.2.1 为 9/8 17:52:08，2.2.2 为 9/30 19:04:52。这三项读取官方 release HTML 的 `released this` 对应时间戳，未因 API 限流推断未发布。尤其 2.2.2 的 CHANGELOG 标题写 9/15，但 Pi core 于 9/29 合入、9/30 随该 release 发布。[v2.2.0](https://github.com/affaan-m/ECC/releases/tag/v2.2.0)、[v2.2.1](https://github.com/affaan-m/ECC/releases/tag/v2.2.1)、[v2.2.2](https://github.com/affaan-m/ECC/releases/tag/v2.2.2)

历史基线：[[2026-09-04-superpowers-v63-eval]]、[[2026-09-09-superpowers-spec-brainstorming-eval]]、[[2026-06-05-ecc-eval]]（含 7/30 补充）。ECC 旧补充未绑定 SHA，不能把本轮称为对旧审阅对象的精确 Git diff。旧材料中的能力缺口必须重新核查当前源码。

实测口径：Superpowers 229 tracked files / 15 个 `SKILL.md` / 2 个 `package.json`；ECC 4,212 tracked files / 根 `skills/` 293 个技能，全部路径合计 1,027 个 `SKILL.md`（含译文、适配副本、Pi profile 等）/ 17 个 `package.json`。不把所有副本计数当独立技能，也不使用 manifest 宣传数字推断可接入数量。GitHub 动态 stars 不用于采纳决策；主代理 API 被限流，该项未完整核对。

Superpowers 根 `package.json` 声明版本 6.4.2、OpenCode 入口及 Pi skills/extensions，未声明 runtime/dev dependencies；脚本/子目录另行分析，不等于整个仓库没有依赖。ECC 根 Node runtime dependencies 为 `@iarna/toml`、`ajv`、`js-yaml`、`sql.js` 四项，`pi/core/package.json` 没有 runtime dependencies。v2.1.0 根依赖为三项，因此本轮不能宣称 ECC 的根依赖总量减少。

## 2. 当前架构身份与原则校准

读取 `.codex/project-standards.json` 及 active base/agent/infrastructure 规范。TP 当前已有双原生工作流、能力路由、持久事务和可选 PostgreSQL/外部 runtime；旧协议中“不得有 DB/daemon”和“只能 Markdown”不能机械套用。

- MR：两宿主的能力与授权边界一致，允许执行机制不同。
- DET：授权、状态转换、写入所有权、证据和恢复关键路径有确定性校验；不禁止 LLM 做规划/审查。
- LT：默认路径轻量，已有可选基础设施按实际需求使用；不因外部仓库带 DB 就整包否决。
- OBS：人类知识产物兼容 Markdown/frontmatter；JSON/journal/DB 可以承载运行状态。

| 维度 | TP 当前 | Superpowers 当前 | ECC 当前 |
|---|---|---|---|
| 核心身份 | 持久工程记忆、受治理学习、开发工作流 | 软件开发方法与技能框架 | 多 harness 工作流、安装与 operator 能力集合 |
| runtime | Claude / Codex 原生入口，显式 opt-in 的外部 adapter | 多宿主技能和脚本，新增 Muse/Qwen/OpenCode 支持 | Claude/Codex 等多适配器；部分实验 operator 扩展 |
| persistence | Markdown 知识、append-only journal、runstate；可选 PG | spec/plan、workspace ledger、原始会话和诊断产物 | install-state、memory/observer、会话和控制面状态 |
| determinism | 关键 owner/hash/CAS/Receipt 校验 | LLM 语义流程，加 Git/脚本护栏 | manifest installer、ownership、hash 发布门；学习仍含 LLM |
| privacy | 明确来源/权限；诊断和学习写入分开 | 只读 transcript、按请求脱敏导出与审计 | 本地观察/memory；不同技能另有网络依赖 |
| surface | 共享源 + Codex 原生覆盖 + 受管生成 inventory | 15 技能，多宿主安装面 | 根 293 技能，另有 123 技能/24 prompt 的 Pi core 子集 |
| scaling | 按依赖、风险、slot 选择并行 | Native inline 与 subagent 两模式 | team/council/operator 等多模式，须逐项证明能力 |
| business model | 本轮不推断商业模式；当前根 package 为 private | MIT 技能仓库，README 提供商业支持联系 | MIT 仓库，README 含赞助及 operator 生态入口 |
| dependency surface | 当前根依赖 pg；功能/服务按需启用 | 根 manifest 无 runtime/dev 依赖声明，子目录/脚本单独分析 | 根四依赖；MCP defaults 与 Pi core 依赖是不同口径 |

自述证据：[Superpowers README](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/README.md)、[ECC package 描述](https://github.com/affaan-m/ECC/blob/c05b2d6614f62f6db0047669aa4eefb223d478f9/package.json)。当前 README/manifest 可能滞后于技能正文，采纳以实际源码为准。

## 3. 候选与优先级

计数：**11 项 = 2 P1 + 3 P2 + 2 backlog + 2 cross-ref + 2 hard-reject**。优先级表示建议顺序，不表示已经实施。评分顺序 MR / DET / LT / OBS；P=pass，p=partial，F=fail。方法评分针对改写后的 TP 方案，原样上游政策另列 C10/C11。

| ID | 候选与判断 | 四原则 | Surface / Spine | 已验证落点 |
|---|---|---|---|---|
| C1 | **P1**：计划记录接口、关键值、断言和验证命令，减少函数体和跨任务重复；TP 已有轻计划，增量在具体契约 | P/P/P/P | Spine | 复用 `user-level/commands/plan.md`、`codex-native/skills/plan/SKILL.md` |
| C2 | **P1**：Review Focus 把隐含失败条件分配给测试 owner；Declined to judge 逐项显式处置 | P/P/P/P | Spine | 复用 `user-level/commands/plan.md`、`review.md` 与 `codex-native/skills/plan/SKILL.md`、`review/SKILL.md` |
| C3 | **P2**：安装文件所有权边界审计，优先检查 legacy Claude 同名技能覆盖 | p/P/P/P | Spine | `install.sh`；对照 `scripts/codex-user-install-transaction.js`、`scripts/install-codex-text-asset.js`、`scripts/install-managed-project-fallback.js` |
| C4 | **P2**：验证同一实际分发产物的安装/升级/重复安装/故障恢复，绑定内容哈希 | P/P/p/P | Spine | `plugins/tech-persistence/scripts/build-codex-plugin.js`、`.github/workflows/macos-cross-platform.yml`、`scripts/validate-codex-plugin.js`、`scripts/validate-codex-install.js`、`scripts/validate-claude-install.js` |
| C5 | **P2**：按问题范围做会话诊断，结论绑定原始来源，区分当前状态与当时状态 | P/P/P/P | Spine | `user-level/commands/skill-diagnose.md`、`skill.md`、`scripts/skill-traces.js`、`scripts/lib/skill-traces.js`；Codex 使用现有生成入口，不假设存在独立 native override |
| C6 | **backlog**：预期有实现变更时核对 review 基线、范围和 changed-files；合法无改动任务仍允许 | P/P/P/P | Spine | `codex-native/skills/review/SKILL.md`、`user-level/commands/review.md`；对照 `scripts/agent-orchestrator/pipeline-providers.js` 的 hash-bound diff/changed-files |
| C7 | **backlog**：显式策展的语义依赖审计与排除理由；按需求做轻量分发，而非新建 profile 框架 | P/P/P/P | Spine | 复用 `plugins/tech-persistence/scripts/build-codex-plugin.js`、`scripts/plugin-manifest-checks.js`、`scripts/validate-codex-plugin.js` |
| C8 | **cross-ref**：处理成功后才能确认/归档；现有 journal 和 transcript 独立读回已承接 | P/P/P/P | Spine | `scripts/lib/runtime-transcript-worker.js`、`runtime-transcript-postgres.js`、`self-learning-service.js` |
| C9 | **cross-ref**：Native inline 与风险/依赖驱动并行；TP 已有相应默认路径 | P/P/P/P | Spine | `codex-native/skills/work/SKILL.md`、`review/SKILL.md`、`user-level/commands/work.md` |
| C10 | **hard-reject**：原样引入强制每次人工终审、自动 commit、固定最强模型、每步全套测试、固定七维诊断派发 | p/F/F/p | Surface | 不采纳原样政策；有效契约拆入 C1/C2/C5/C9 |
| C11 | **hard-reject**：整包更新接入、重复控制面和无需求的新宿主/operator 扩面 | p/F/F/p | Surface | 不新增控制面；将有价值方法落到 C1–C9 的既有模块 |

### C1：计划具体，但不预写整个实现

Superpowers v6.4.2 约束 test step 给名称/断言，code step 给签名/文件/spec 精确值，verification step 给命令和通过条件；跨任务通过 Interfaces 交流。算法或精确文案不能从契约推导时才写正文。计划自查代码块比例和重复。

TP Plan 当前已有风险缩放、文件集合、依赖、完成证据、before/after 契约，以及 architectural shadow authority。不能把这轮称为首次轻量规划。建议仅增强跨任务契约和验证的具体程度，保留 probe/bounded 的低成本路径；不为文案/L0 任务强制写代码断言，不创建第二份 spec owner。

来源：[What a Step Contains](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/writing-plans/SKILL.md#L140)。上游声称单个复现计划耗时/Token 大幅下降及 planted-defect probes 9/9；这不是 TP 效果验证，不承诺相同收益。

### C2：把容易漏掉的输入提前交给测试与审查

Superpowers v6.4.1 的 Review Focus 先找规格隐含但任务测试未覆盖的高价值失败条件，再补到 owning task 的测试。TP 适配时应留下风险、测试 owner 和残余未验证项，而非永久把该段写成“这些都未测”。审查者把因范围原因放弃判断的行为写入 Declined to judge，由主代理给出处置和理由。

TP Claude Review 已有 Gap Detection Walkthrough（用户路径/已有覆盖/缺口/action）；Codex Review 也要求边界与未运行验证。真正缺口是 Plan 端预先分配这些输入，以及明确记录“考虑过、因超出 spec 而不判断”的行为。建议 L2+ 或相关边界改动触发，最多选五项；低风险可给简短检查结果。合理用户期待作为 defect/risk 证据，**不能静默扩大用户 scope、改冻结 criterion 或授权新写入**。

来源：[Review Focus](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/writing-plans/SKILL.md#L77)、[Declined to judge](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/requesting-code-review/code-reviewer.md#L43)。

### C3：ECC 的增量是保护边界，不是再建 installer

ECC 2.2.1 的安装保护区别“已经受管”与“只是恰好内容相同”；未受管用户文件不覆盖、不登记为自己的资产。preview→apply 期间文件出现要明确重试；失败安装只刷新实际写入文件的 digest，未写文件保留原 ownership hash。

TP 已有 Codex user-install durable transaction、hash-bound backup/CAS rollback、fallback owner manifest 和 runtime doctor repair。不能复述旧评估中“没有 ledger/doctor”的缺口。本次读到 `install.sh` 的 legacy `install_user` 对指定技能正文直接 `cp`；这是值得先做回归样本的窄边界，不代表用户当前文件已经损坏，也不证明其他安装器都不安全。

后续先覆盖：未受管同名文件、受管后用户修改、preview 后新建文件、写到一半失败、重复安装、清理时保留用户资产。成功升级是否覆盖已修改受管文件必须有显式政策。ECC 自己仍保留受管文件成功升级可替换的合同，不能声称其保护了所有用户编辑。

来源：[ownership guard](https://github.com/affaan-m/ECC/blob/c05b2d6614f62f6db0047669aa4eefb223d478f9/scripts/lib/install/ownership-guard.js#L40)、[preview revalidation](https://github.com/affaan-m/ECC/blob/c05b2d6614f62f6db0047669aa4eefb223d478f9/scripts/lib/multi-harness-setup.js#L413)。

### C4：实际交付物也应经过验证

ECC 2.2.0 起把一次生成的 npm archive 绑定 SHA-256，三 OS 跑同一 archive 的生命周期，publish 前后再校验；2.2.3 将 registry 可见性等待延长到五分钟。值得借鉴的是“测试、安装、分发的是同一份字节”，以及幂等更新与清理能保留用户文件。

TP 已有三 OS / Node 18、24 的 CI、生成漂移检查及安装 smoke；目前检查的是 checkout/生成目录，没有看到等价的单一归档产物贯穿门。根 package 是 private，因此不应套用 ECC 的 npm staged→latest 发布链。若实际发布路线分发插件 bundle，应让现有生成器先产出固定包，再让验证器和隔离安装消费它；只在真正发布需求下接完整 release gate。

来源：[ECC release artifact workflow](https://github.com/affaan-m/ECC/blob/c05b2d6614f62f6db0047669aa4eefb223d478f9/.github/workflows/release.yml#L143)。这是源码机制核验，没有执行上游 CI 或 npm 发布。

### C5：让“为什么会话出错”有证据

Superpowers 新 `diagnosing-superpowers` 从明确问题、session/turn 范围出发，结论必须有 `path:line`；大记录先测量、再提取小字段。当前环境配置不能冒充历史运行时配置。导出只在用户请求时做，另行脱敏检查。

TP 已有 skill-signals、failure traces、脱敏以及明确 gate，适合增加“预期/实际/相关事件/证据证明什么/尚未知什么”的会话报告。现有 trace 的 `source` 字符串不等于绑定了原始会话行证据；诊断材料也不能自行授权 BehaviorEvent、eval case 或 learning promotion。

按问题选择一至几个维度，复用原生 transcript 来源与现有 CLI；不默认扫描全部历史，不按上游固定派七个 analyst，不新建日志数据库或 daemon。原始 session 只读，外发必须有当前授权。

来源：[diagnosing-superpowers](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/diagnosing-superpowers/SKILL.md#L15)、[context safety](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/diagnosing-superpowers/references/context-safety.md)。

### C6–C9：保留方法，先避免重复建设

- C6：上游 helper 实际拒绝非 descendant 和零提交范围，并非检查所有 diff 语义。分支审查可基于正确共同祖先，但不能硬编码每个项目都有 `origin/main`。TP pipeline 已绑定 diff/changed-files/hash；未来审计手工 Review 的范围选择时，再补“预期有改动却审了空范围”。只读研究、合法 no-op 和未提交工作树 diff 都不能被这个提交范围规则误拒绝。[review-package guard](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/subagent-driven-development/scripts/review-package#L25)
- C7：ECC 2.2.2 的 `pi/core` 用显式 include/exclude 和排除理由生成 123 技能/24 prompts，禁止 runtime download/hooks/SaaS；缺分类会失败。这是轻量策展的方法。TP 已有受管 inventory missing/extra 检查，增量只在语义依赖审计/排除理由，待真实安装面需求再做。ECC 默认 MCP 收缩是此前 June audit 的决定、进入 2.2.0 发布说明，不能叫 October 新发明；也不能照抄其“移除 memory MCP”，TP 的 memory 服务是核心能力。[pi-core builder](https://github.com/affaan-m/ECC/blob/c05b2d6614f62f6db0047669aa4eefb223d478f9/scripts/build-pi-core.js#L62)、[connector policy](https://github.com/affaan-m/ECC/blob/c05b2d6614f62f6db0047669aa4eefb223d478f9/docs/MCP-CONNECTOR-POLICY.md)
- C8：ECC observer 增加 exit 0 + 唯一末行 `analysis_complete` 才归档。TP canonical learning 已有 journal/approval receipt 验证，runtime transcript worker 要求独立读回及匹配 job hash 后写 durable ack。上游按配置截取最近 N 行分析（默认 500），随后归档整个 live 文件，因此完成标记不能证明所有记录被分析，也不能证明学习写入合法。这里只交叉引用保留源数据与确认原则，不接它的自动写 instinct/daemon。TP legacy `scripts/observe.js` 仍有 10 MB 旋转；旋转是保留/体积策略，不是“已完成分析”收据，canonical 保证不能外推至这条旧链。[sampling](https://github.com/affaan-m/ECC/blob/c05b2d6614f62f6db0047669aa4eefb223d478f9/skills/continuous-learning-v2/agents/observer-loop.sh#L241)、[completion check](https://github.com/affaan-m/ECC/blob/c05b2d6614f62f6db0047669aa4eefb223d478f9/skills/continuous-learning-v2/agents/observer-loop.sh#L440)
- C9：Superpowers 的 Native inline 相比旧 stub 是实际更新；TP Work 已能单会话执行，按依赖/风险/slot 决定并行，并有验证证据/最终 Review。无需再建一种 Native runtime 或任务 ledger owner。上游每步全套 suite 的动机是避免邻近回归遗漏；TP 保留窄反馈→风险匹配回归，明确测试范围与未验证项。[Native execution](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/executing-plans/SKILL.md)

## 4. 双向挑战与判断翻转

1. **C7：原样轻量 profile / MCP 政策不采纳 → 抽取语义策展方法进入 backlog。** 拒绝 Pi 安装面或移除 TP memory 不能连带拒绝“默认资产要明确解释依赖、排除理由”的价值；与此同时 TP 的 inventory checks 已有，故不升格为新框架或 P1。产品 reviewer 对真实生成器与 ECC manifest 的检查支持该收窄。
2. **C8：拟借新完成标记 P2 → cross-ref。** 源码证明 TP 已有更强的 journal-bound receipt / job-hash + independent readback；ECC marker 还有采样/全文件归档边界。新增一个 marker owner 会重复建设，并降低证据要求。
3. C10 仍拒绝原样政策：人工 gate 服从当前用户授权与风险，不能覆盖 `--auto`；提交与学习写入不从完成开发自动推导。自动化关键状态不能由任意 LLM 自报解锁。有效方法已由 C1/C2/C5 承接。
4. C11 仍拒绝整包与控制面替换：多宿主/更多技能数量不能证明 TP 核心价值增加。若以后有具体新宿主需求，通过现有 capability/adapter 框架另行评估。

Superpowers v6.4.0 没有发布；`proving-it-works-with-a-movie` 在 v6.4.1 被明确留待后续，不列为已发布候选。也不照抄 v6.4.2 删除 CLAUDE.md：TP 当前有明确的双原生与 legacy 受管文档责任，应按自己的生成架构处理。[v6.4.1 发布边界](https://github.com/obra/superpowers/releases/tag/v6.4.1)

## 5. 后续实施顺序与验收

这是建议，不是本轮实施授权。

1. C1+C2：先做小范围 Plan/Review 文案契约；共享源与 Codex 原生覆盖同步，经现有生成器投影。用真实或既有 skill-eval cases 验证计划长度、接口错配、隐含输入漏测、无依据扩 scope；不只测试关键词是否出现。预计收益需本地 A/B 证明。
2. C3：先建立隔离 HOME/config 的安装回归样本，再决定 legacy 路径迁移；覆盖冲突、编辑、半失败、重试和清理，绝不对用户真实安装做破坏性测试。
3. C4：按实际分发路线选择 bundle 格式与安装消费者；同一哈希固定产物在三 OS 生命周期中验证。不为了借鉴而启用 npm 发布。
4. C5：通过已有 diagnose/trace 入口先验证一个具体失败会话；证据缺失保留 unknown，只有用户要求时考虑脱敏导出。
5. C6/C7：有范围误判/安装面成本的真实证据后再做，保留 backlog。

## 6. 实际验证与限制

- 已执行：公开仓库 Git clone/log/tag peel/diff、tracked/技能/manifest 分层计数；只读 `rg` / `Get-Content` 检查候选路径、关键实现和测试源码；核对发布记录。
- 报告校验：24 个本地落点全部存在；16 个固定提交源码链接涉及 14 个文件，11 处行号锚点均有效；11 项候选与分类计数一致。工作树仅新增本轮两份研究文档。
- 当前研究不修改产品代码，不需要新增行为测试；未执行上游脚本、安装依赖、连业务账号、运行上游 CI 或真实 provider/cost canary。前一轮 Muse 的测试结果不冒充本轮验证。
- 源码机制可核对，效果（成本/漏测率/返工率）仍未知，需实施后的本地样本；upstream eval 宣称不等于 TP 实测。
- 环境：sandbox helper 启动失败，安全只读 shell 通过已获自动审查允许的沙箱外路径完成；主代理 GitHub API 限流，结合 Git、发布网页及 reviewer 发布字段交叉验证。没有权限拒绝或业务环境阻塞。

## 7. 独立复核

| 审查面 | 结果 | 实际核验 |
|---|---|---|
| product-lens-reviewer | PASS | 读上游技能/ownership/observer 与 TP Plan、Review、安装事务、生成 inventory、transcript 读回；确认方法增量、已有覆盖和 scope |
| coherence-reviewer | PASS | 核对 11 项计数、四原则、授权/owner、实际 package 与上下游关键路径；修正并读回 observer 默认采样口径、事实与建议分界 |
| feasibility-reviewer | PASS | 实跑 Git 计数/tag peel/main diff、rg/Test-Path/Get-Content；核对 release 时间和落点；发现并关闭初稿“Superpowers 根无 package”错误 |

三路 reviewer 均列出实际检查文件，并读回修订。没有剩余可操作研究问题。研究完成只表示分析与证据复核完成，不代表候选实现或运行时验收完成。

## Related

- [[2026-10-09-superpowers-ecc-updates-eval]]
- [[2026-09-04-superpowers-v63-eval]]
- [[2026-09-09-superpowers-spec-brainstorming-eval]]
- [[2026-06-05-ecc-eval]]
