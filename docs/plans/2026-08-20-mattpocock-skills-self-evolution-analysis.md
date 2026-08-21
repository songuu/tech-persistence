---
type: sprint
status: completed
created: 2026-08-20
slug: mattpocock-skills-self-evolution-analysis
---

# Matt Pocock skills 与当前 Skill 自进化架构分析

## 用户请求

分析 `https://github.com/mattpocock/skills`，并结合
`docs/Cognitive_Skill_Engine_Methodology_v2.2.md`，详细评估当前仓库的 Skill
自进化体系，判断哪些设计可以直接借鉴、哪些需要适配、哪些不应引入。

## 预期交付

- 对外部仓库的结构、机制、工程实践与边界形成可追溯事实。
- 对 v2.2 方法论与当前实现建立证据化架构映射。
- 输出可直接借鉴、需适配借鉴、不建议借鉴三类结论。
- 给出按收益、风险、依赖和验证方式排序的落地建议。

## 当前动作

目标已完成：最终复审无 finding，solution 索引已更新并通过幂等读回，等待清除 Sprint pointer。

## Think：目标与边界

### 要做

- 以 GitHub 当前可见的一手资料为准，分析 `mattpocock/skills` 的目录结构、
  Skill 编写约束、质量机制、分发方式及其明确边界。
- 阅读 v2.2 方法论，区分规范性目标、建议机制和可验证要求。
- 从当前仓库的 Skill 自进化入口、诊断、评估、改进、发布、学习与持久化链路中
  收集实际实现证据，不把文档声明等同于运行时能力。
- 建立三方映射，按“可直接借鉴 / 需适配借鉴 / 不建议引入”分类，并给出
  优先级、依赖、风险和验证方式。

### 不做

- 本轮不复制外部仓库代码、不修改现有 Skill 实现、不提交或推送。
- 不把本地静态检查当成生产使用效果，也不对缺少证据的行为作完成声明。
- 不扩展到与 Skill 自进化无直接关系的插件或业务功能。

## 可观察的成功标准

1. WHEN 外部仓库分析完成，THE SYSTEM SHALL 用可访问的一手链接和当前快照信息
   支撑关键事实，并显式标记随仓库演进可能漂移的结论。
2. WHEN 当前架构被描述，THE SYSTEM SHALL 为主要机制提供本地文件、测试或命令输出
   证据，并区分“设计意图”与“已实现行为”。
3. WHEN 三方对照完成，THE SYSTEM SHALL 对每个候选机制给出来源、当前缺口、适配成本、
   收益、风险以及直接/适配/拒绝分类。
4. WHEN 落地建议形成，THE SYSTEM SHALL 给出按优先级排序的最小改动单元及对应验收方式，
   足以支撑后续单独实施 Sprint。
5. WHEN 证据不足或环境阻塞，THE SYSTEM SHALL 将其列为未知项，不以推断代替事实。

## 风险、假设与待确认项

- 假设“当前的 skill 自进化”指本仓库围绕 `skill diagnose/eval/improve/publish`、
  `evolve`、学习与持久化形成的完整链路；Plan 阶段将用仓库事实校验。
- 外部仓库可能在分析后继续变化，因此结论需绑定检索日期与可识别版本。
- v2.2 可能是规范目标而非全部落地；必须与实际脚本、测试分开核对。
- 本轮只读业务实现并写 Sprint 工件，无不可逆外部影响，也没有开放产品决策。

## Plan：方案与任务契约

### 方案概述与关键取舍

采用“三路独立取证、一次统一裁决”的方式：外部仓库只认当前一手资料，本地方法论按
规范性条款解析，当前架构则以源码、测试和命令输出为准。2026-05 已有的两份
`mattpocock/skills` 分析只作为历史基线，用当前外部快照与当前实现逐项复核，不能直接沿用。

最终产物写入
`docs/solutions/2026-08-20-mattpocock-skills-cse-self-evolution-eval.md`；先标 draft，
通过 Review 后再决定是否标 completed。分析采用“身份/目标函数 gate → 机制映射 →
收益与冲突 → 借鉴裁决”的顺序，避免仅因形式相似就引入重复能力。

### 有序任务清单

#### T1 [P] 外部仓库当前事实

- 目标：绑定检索日期和可识别版本，分析目录、代表性 Skill、编写准则、示例/模板、
  测试或自动化、分发方式、许可证与明确局限。
- 文件集合：GitHub 一手页面与 raw 文件；本地只读历史基线
  `docs/plans/2026-05-15-mattpocock-skills-analysis.md`、
  `docs/plans/2026-05-18-mattpocock-skills-followup.md`。
- 前置依赖：无。
- 风险：L1；外部仓库会漂移，必须记录 snapshot/commit，搜索摘要不能替代正文。
- 完成证据：至少从仓库结构、设计哲学、代表性实现、质量/分发、限制五个角度提供
  一手链接和事实清单，并列出相对 2026-05 基线的变化。

#### T2 [P] v2.2 方法论规范抽取

- 目标：把方法论拆成可验证能力，而不是复述章节。
- 文件集合：`docs/Cognitive_Skill_Engine_Methodology_v2.2.md`。
- 前置依赖：无。
- 风险：L1；文档可能描述目标态，需标明规范、建议与示例的证据强度。
- 完成证据：形成分层、数据流、Git 蒸馏、运行时防御、标准化矩阵、Darwin 棘轮、
  SKILL 模板、路线图八类契约及验收信号。

#### T3 [P] 当前 Skill 自进化实现审计

- 目标：还原信号采集、诊断、改进、A/B 评估、发布护栏、学习/聚类、runtime projection
  与持久化的真实链路，并找出文档—实现—测试差距。
- 文件集合：`README.md`、`plugins/tech-persistence/{commands,codex-skills,hooks,codex-hooks,mcp,scripts}`、
  根目录 `scripts/lib/skill-*.js`、`scripts/test-skill-*.js`、相关 schemas，以及
  `docs/plans/2026-05-13-skill-evolution-architecture.md`。
- 前置依赖：无。
- 风险：L2；多 runtime projection 可能同名异义，不可只读单一副本。
- 完成证据：给出 source-of-truth、消费者、派生副本、数据格式、关键 gate、现有测试与
  已知缺口的端到端图谱；必要时运行最窄的已有 skill 测试验证声明。

#### T4 三方映射与借鉴裁决

- 目标：把 T1–T3 合并为逐机制矩阵，输出直接借鉴、适配借鉴、不建议引入三类结论。
- 文件集合：写入上述 solution 文档和本 Sprint 计划；不改业务实现。
- 前置依赖：T1、T2、T3 全部完成。
- 风险：L2；主要风险是把收敛进化误判为缺口，或用文档声明替代运行证据。
- 完成证据：每项包含来源、当前对应、缺口、收益、冲突/成本、裁决、优先级和验证方式；
  明确区分事实、推断、未知项。

#### T5 证据与文档验证

- 目标：验证本地引用、外部来源、分类一致性和建议可执行性。
- 文件集合：solution 文档、当前计划以及它们引用的只读证据。
- 前置依赖：T4。
- 风险：L1。
- 完成证据：关键本地引用可定位；外部事实有一手链接；`git diff --check` 通过；
  已运行测试与未运行测试分开报告。

### 多 runtime / 派生文件核对契约

| 机制 | 可能的 source-of-truth | 主要消费者/投影 | 核对方式 |
|---|---|---|---|
| Skill 工作流说明 | `plugins/tech-persistence/codex-skills` 或 `commands` | Codex、Claude、用户级安装投影 | 比较入口语义与生成/安装脚本，不假定同名文件等价 |
| 信号与 trace 数据 | hooks/codex-hooks/mcp 共用 lib 与 homunculus JSONL | diagnose、improve、compound | 追踪 writer、schema、reader 与测试 fixture |
| eval case/result | `skill-eval-cases` / `skill-eval-results` lib | eval、publish baseline guard | 读取 append/判定逻辑并运行现有测试 |
| 发布与派生资产 | publish 命令、projection/build 脚本 | plugin cache、用户级命令/Skill | 只审计现有 gate，不执行发布或安装 |

### 测试策略

- 最窄反馈：文件与链接定位、关键脚本静态追踪、外部页面全文读取。
- 行为验证：运行与分析声明直接相关的现有测试，优先
  `test-skill-traces*`、`test-skill-eval-cases*`、`test-skill-eval-results`、
  `test-skill-publish-guard`、`test-skill-size-budget`、`test-codex-native-skill-projection`。
- 文档验证：逐条检查矩阵来源与本地锚点，最后运行 `git diff --check`。
- 本轮不因分析任务运行全量套件；若最窄测试暴露共享基础设施问题，再按影响扩展。

### 风险、恢复与未知项

- 所有业务取证均只读；唯一写入是 Sprint pointer、计划和分析文档，可通过普通 diff 审查。
- 不克隆或执行外部仓库代码；网络不可达时以环境阻塞报告，不能用 2026-05 快照冒充当前事实。
- 未知项包括外部 Skill 的真实使用效果、尚未落地的 v2.2 目标态、以及本地 fixture
  无法证明的生产行为。

### 下一可执行动作

进入 Work，并行执行 T1、T2、T3；三路证据齐备后由主代理完成 T4–T5。

## Work：执行结果

### T1 外部仓库当前事实 — completed

- 快照绑定到 `mattpocock/skills` `main` 的
  `885e2ca4d842d139e9aef4e48d366c63cb1b8013`（检索日 2026-08-20）。
- 固定树核实 35 个 `SKILL.md`、35 个 Codex sidecar、25 个 promoted Skill，以及
  user/model invocation、lifecycle、writing-for-agents、wayfinder 等当前机制。
- 校正 2026-05 “18 个 Skill”“无 Codex parity”“纯独立提示片段”等已漂移口径。
- 核实上游没有行为 eval/schema CI，当前 HEAD 本身是 6 个 YAML frontmatter discovery 修复。

### T2 v2.2 方法论规范抽取 — completed

- 抽取 Git evidence、五层数据流、双层存储、runtime defense、multi-role、Darwin ratchet、
  SKILL 模板和路线图的可验证契约。
- 将 v2.2 定位为目标态能力地图；识别 Git 绝对真理、Revert 过度归因、TV/RIA 定义不足、
  hotpatch 优先级、自动团队分发、单一综合分和生产治理等缺口。
- 反推出 `EvidenceRef`、`RuleCandidate`、`EvalRun`、`RuntimePatch` 四类最小对象与 gate 链。

### T3 当前 Skill 自进化实现审计 — completed

- 还原 signals → diagnose/trace → cases → improve/eval → scalar guard → manual publish 链，
  以及 `/evolve --auto` 的旁路。
- 验证当前 Codex plugin 不注册 PostToolUse/Stop，而 signal writer 只接在 Claude legacy
  `evaluate-session`；`$skill` 的自动 Codex signals 声明与实际 wiring 不一致，列为 P0。
- 验证 trace/case/result 辅助库、脱敏、append-only、guard 和多 runtime 投影；同时确认
  evaluator、publisher、rollback、Git ingestion、DAG、多维 ratchet 尚未实现。
- 发现 signal 可能重复计数、case 不核验 source trace 身份、wrapper 邻接链接缺失、CLI 依赖 cwd、
  size budget 未扫描活跃 `codex-skills` surface 等 P1 缺口。

### T4 三方映射与借鉴裁决 — completed

- 详细报告已写入
  `docs/solutions/2026-08-20-mattpocock-skills-cse-self-evolution-eval.md`。
- 结论分为“直接借鉴 / 需适配 / 拒绝”，并给出目标控制流、不变量、P0–P4 exit gate
  和验收测试矩阵。
- 核心排序：先修正 Codex evidence 入口，再硬化 candidate identity、EvalRun、多维 fail-closed
  ratchet 和 installed discovery；之后才试点 Git evidence，不建设新常驻网关。

### T5 证据与文档验证 — completed

- 3 个无子进程 test file 通过：traces 7/7、eval-cases 9/9、size-budget 5/5。
- 受限环境的 Node `spawnSync` 先遇到 `EPERM`；以获准的直接执行路径重跑 5 个 CLI/guard/
  projection test file，全部通过。
- `node scripts/validate-codex-plugin.js` 通过 inventory、字节投影和 require closure 校验。
- `git diff --check` 无 whitespace error；对两个新增文档使用 `git diff --no-index --check`
  时仅返回“存在新增 diff”的预期 exit 1，没有 whitespace error 输出。
- 方法论文档保持用户原始 untracked 状态；未修改业务实现、未提交、未推送。

### Work 残余未知项

- 上游 marketplace pin 是否等于 `main` HEAD 未核验。
- 上游真实使用效果、TP 跨 harness 行为 parity 和 installed-plugin cwd 运行未验证。
- v2.2 无配套实现或 benchmark，不能验证其宣称效果。

### Review 入口

冻结审查对象：外部快照、上述 solution 报告和本计划的 Work 证据。Review 不扩大到实现建议本身；
如发现事实错误、分类冲突或验收 gate 不可执行，则回到 Work 修订文档。

## Review Cycle 1：findings 与修复

两名独立只读 reviewer 分别核对本地执行链和外部/v2.2 证据，发现 6 项可操作问题；Sprint 已按
`review → work` 回退后修订：

1. **High：malformed results 被跳过可能基于旧记录或 no-baseline 放行。**
   报告新增静默陈旧比较路径，P1 和验收要求尾部 malformed/truncated candidate 必须 block。
2. **Medium：考题与 Skill 隔离只是协议，没有 authority enforcement。**
   降级为协议事实；P1 新增 candidate/exam/evaluator/publisher identity separation 和 hash readback。
3. **Medium：results 的 `cases` 未脱敏。**
   限定“双层脱敏”范围，新增固定 schema、递归脱敏与跨进程测试要求。
4. **Medium：把 TP 补足 gate 混写成 v2.2 已有能力。**
   拆成“v2.2 明示目标”与“本评估新增工程 gate”。
5. **Medium：把逻辑 Skill Graph/Runtime Controller 误写成 v2.2 要求重型服务。**
   改为 TP 明确拒绝将逻辑层物理化为新常驻 Gateway/DB/向量图谱；不再归因给原文。
6. **Medium：合并了 Hard Rule 提炼与重复纠正自动团队补丁两项不同主张。**
   拆为两个独立拒绝项，分别给 final-disposition/反证与授权/TTL/回滚 gate。

同时将外部 workflow 表述收紧为“固定树只有一个 tracked `release.yml`”，并给 2026-05 固定树
28 个 `SKILL.md` 的不可变链接。

## Review Cycle 2：残项修复

复审确认第一轮 6 项实质风险已进入当前事实、P1 和验收矩阵，只留下 5 个表述精度残项：

- 将 trace writer 的限定顶层字符串脱敏与 eval-case 的嵌套递归脱敏分开描述。
- 将 guard 输入精确写为“最后两条可解析记录”。
- 将验证结论中的泛称“脱敏”限定到 trace/case 实际覆盖面。
- 把 RuleCandidate lifecycle、结构化 provenance/counterexamples 从 v2.2 明示能力移到 TP 新增 gate。
- 把 Request Changes 主张精确写成“不经最终处置核验即可直接提炼”，不误写为自动动作。

以上均已修订，等待最终独立复审。

## Review Cycle 3：最终结果

- 本地实现 reviewer：`none`；确认 trace/case 脱敏范围、最后两条可解析记录和验证结论均与源码一致。
- 外部/方法论 reviewer：`none`；确认 RuleCandidate 补足 gate 与 Request Changes 表述已正确分离。
- 残余风险只保留报告“未知项”中明确列出的未验证外部/生产行为，没有未解决 finding。

## Compound：完成记录

- 新增 1 份 completed solution：
  `docs/solutions/2026-08-20-mattpocock-skills-cse-self-evolution-eval.md`。
- 规则/本能：no-op；本轮是架构评估，没有授权或真实运行信号支撑新增共享 rule/instinct。
- 首次索引写入在沙箱内因 `EPERM` 失败；获准直接路径重跑成功，canonical index 共 49 entries。
- `docs/solutions/index.jsonl` 更新，`CLAUDE.md` 有界 projection 更新，`AGENTS.md` projection 禁用且未修改。
- 第二次同步返回三个 `[ok]`，证明当前索引/投影幂等。
- `test-sync-solution-index.js` 沙箱内 20/21，唯一失败为 hard-crash fixture 子进程 status `null`
  （与已确认的 spawn EPERM 相同）；获准路径重跑 21/21。

Solution index: updated 49 entries -> docs/solutions/index.jsonl; Claude projection: updated; AGENTS projection: disabled
