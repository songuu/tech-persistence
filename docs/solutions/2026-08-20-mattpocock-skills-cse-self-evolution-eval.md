---
title: "mattpocock/skills + Cognitive Skill Engine v2.2 对当前 Skill 自进化架构的借鉴评估"
date: "2026-08-20"
tags: [solution, sibling-eval, skill-evolution, cognitive-skill-engine, architecture]
related_solutions:
  - "[[2026-05-15-mattpocock-skills-analysis]]"
  - "[[2026-05-18-mattpocock-skills-followup]]"
aliases: ["mattpocock skills cse eval", "skill self evolution architecture eval"]
status: completed
sources:
  - "https://github.com/mattpocock/skills at 885e2ca4d842d139e9aef4e48d366c63cb1b8013"
  - "docs/Cognitive_Skill_Engine_Methodology_v2.2.md"
  - "local skill evolution implementation and targeted tests on 2026-08-20"
---

# mattpocock/skills + CSE v2.2 对当前 Skill 自进化架构的借鉴评估

> Status: `completed`。本文绑定外部仓库 2026-08-20 快照，记录 P0 实施前的三方分析；当时只做
> 分析和验证。2026-08-21 已按该分析完成自学习 P0，当前实现与验证边界见
> [[2026-08-21-user-behavior-self-learning-p0]]；本文第 5～11 节保留为历史基线，不代表当前 runtime。

## 结论先行

当前 Tech Persistence（下称 TP）的 Skill 自进化不是一个已经闭环的“自动进化引擎”，而是一个
**证据意识较强、关键安全边界正确、但当前 Codex 入口链首尚未接通、其余环节也只有局部确定性
支撑的半机械化工作流**：

```text
Claude legacy observations / Stop → skill 调用计数
  ⇢ [未接到当前 Codex plugin 的 $skill 入口]
  → LLM 诊断 / 人工确认失败 trace
  → LLM 改进提案
  → LLM A/B 评估 + 手工记录单一通过率
  → 最近两条结果的确定性 guard
  → 人工 go 后发布与投影
```

它已经优于 v2.2 的地方是：写权限边界、trace 限定字段二次脱敏、case 嵌套对象递归脱敏与
provenance shape 约束、
人工发布 gate、事务化多 runtime 投影与回滚意识。考题与 Skill 隔离目前只是协议要求，并无
deterministic authority enforcement。它明显弱于目标态的地方是：README
明确当前 Codex 不注册 PostToolUse/Stop，而 signal writer 只在 Claude legacy Stop evaluator 中调用；
即使有 signals，遥测字段也过薄；诊断和评测主要依赖 LLM；结果只有一个 `pass_rate`；guard
在无基线和内部错误时放行，损坏行还会被静默跳过；没有 Git/PR 证据归一化、反例/TV gate、正例/诱饵分维度回归、
依赖/冲突图；`/evolve --auto` 还可绕过 `/skill eval → publish` 链直接生成 Skill/Command。

三方最合理的组合不是互相替换，而是各取所长：

| 来源 | 最有价值的职责 | 不应承担的职责 |
|---|---|---|
| `mattpocock/skills` | agent 文档适配度、context pointer、调用分类、生命周期和发布面一致性 | 行为评测或自动进化；上游没有这套确定性能力 |
| CSE v2.2 | Git 证据候选、TV/反例、DAG、正例/诱饵棘轮的目标能力地图 | 直接当工程规格；权限、schema、评测隔离和运行治理均未定义完整 |
| TP 当前实现 | 授权、脱敏、append-only 数据、人工 gate、deterministic guard、跨 runtime 投影 | 仅靠现有标量通过率证明质量单调增长 |

推荐目标链路是：

```text
observations + authorized Git/PR evidence
  → EvidenceRef 归一化 / 脱敏 / 最终处置核验
  → RuleCandidate + counterexamples + TV gate
  → candidate lifecycle（不直接进入 runtime）
  → versioned EvalPlan（positive / distractor / safety / context）
  → current vs candidate 多维评测（固定 hashes / dataset / judge / seed）
  → fail-closed deterministic guard
  → human go
  → transactional projection / discovery canary / readback / rollback
```

## 1. 证据范围与可信度

### 1.1 外部仓库快照

- 检索日期：2026-08-20。
- `main` HEAD：[`885e2ca4d842d139e9aef4e48d366c63cb1b8013`](https://github.com/mattpocock/skills/commit/885e2ca4d842d139e9aef4e48d366c63cb1b8013)。
- 该提交修复 6 个 `SKILL.md` 的无效 YAML frontmatter；冒号后未加引号导致 `skills.sh`
  discovery 静默跳过。这是引入 parser/discovery canary 的直接现实证据。
- 当前固定树有 35 个 `SKILL.md` 和 35 个相邻 `agents/openai.yaml`；其中 engineering 18、
  productivity 7、misc 4、in-progress 6。Claude 插件正式发布 engineering + productivity
  共 25 个 Skill。结构以[固定树](https://github.com/mattpocock/skills/tree/885e2ca4d842d139e9aef4e48d366c63cb1b8013/skills)
  和[插件清单](https://github.com/mattpocock/skills/blob/885e2ca4d842d139e9aef4e48d366c63cb1b8013/.claude-plugin/plugin.json)为准。
- 固定快照 `package.json` 版本为 1.2.3，只有 changeset、version、plugin version check 三个
  npm script；固定树只有一个 tracked workflow 文件 `.github/workflows/release.yml`，没有 Skill
  schema 或行为 eval CI。

这些事实只描述该 commit，不等于其 marketplace 安装版本已经包含同一内容，也不能证明真实使用效果。

### 1.2 本地证据

本地结论来自以下 source/runtime/测试面，而不是仅从说明文档推断：

- 统一入口和四阶段协议：`plugins/tech-persistence/codex-skills/skill/SKILL.md:18-121`。
- 诊断、trace、评测、改进、发布：同目录的 `skill-diagnose`、`skill-eval`、
  `skill-improve`、`skill-publish`。
- 聚类进化旁路：`plugins/tech-persistence/codex-skills/evolve/SKILL.md:18-115`。
- 数据与 guard：`scripts/lib/skill-signals.js`、`skill-traces.js`、
  `skill-eval-cases.js`、`skill-eval-results.js` 和 CLI。
- 多 runtime 投影：`scripts/propagate-command-changes.js`、
  `plugins/tech-persistence/scripts/build-codex-plugin.js` 及投影测试。
- 本轮实测：8 个与结论直接相关的 test file 全部通过；详见“验证记录”。

### 1.3 v2.2 文档定位

`docs/Cognitive_Skill_Engine_Methodology_v2.2.md` 共 237 行。本文把它视为**目标态能力地图**，
不是“当前已实现能力”，也不是可以按章节直接编码的规范。原因是其核心对象、权限模型、阈值、
冲突决议、评测隔离、回滚事务和生产运维都没有形成完整机器契约。

## 2. 对 2026-05 旧结论的校正

本仓库已有两轮 2026-05 分析。它们适合作为历史基线，但以下判断已经漂移：

| 旧口径 | 2026-08 当前事实 | 修正 |
|---|---|---|
| “上游有 18 个 Skill” | [2026-05-18 固定树](https://api.github.com/repos/mattpocock/skills/git/trees/67bce91c80cd1020a4f068ced32d0281656842ad?recursive=1)其实已有 28 个 `SKILL.md`；18 只是当时 README 展示面。当前为 35 | 不再以 README 列表数代表完整文件面 |
| “上游主要是独立、无流程的小片段” | 已形成 `idea → grill → spec → tickets → implement → review` 可选流程、on-ramp、router 与 `wayfinder` | 应称“拒绝强制总控，但已是组合式流程系统” |
| “Codex parity 未做” | 35 个 Skill 均有 `agents/openai.yaml`，user/model invocation 有双 harness metadata | 元数据 parity 已有；原生 Codex plugin 仍在 roadmap |
| “write-a-skill 是 scaffold helper” | 已演化为 `writing-for-agents`，覆盖 agent 文档适配度理论 | 当前最值得借的是诊断模型，而不是模板本身 |
| “progressive disclosure 是主要新项” | TP 已在 5 月吸收该检查；上游现已扩展到 pointer、completion、no-op、cache/sediment | 不能重复交付旧建议，应升级诊断维度 |

上游演化本身也给出一个重要样本：`zoom-out` 因无人使用被删除，公开 `caveman` 因与内部实验
重复被删除，`ubiquitous-language` / `design-an-interface` 被吸收到共享 discipline，beta `review`
晋升为 `code-review`。演化原因可在固定快照的
[CHANGELOG](https://raw.githubusercontent.com/mattpocock/skills/885e2ca4d842d139e9aef4e48d366c63cb1b8013/CHANGELOG.md)
中追踪。它证明的是人工维护的生命周期价值，不证明自动演进有效。

## 3. 外部仓库真正值得研究的机制

### 3.1 Agent-facing document fitness

[`writing-for-agents`](https://raw.githubusercontent.com/mattpocock/skills/885e2ca4d842d139e9aef4e48d366c63cb1b8013/skills/productivity/writing-for-agents/SKILL.md)
把“Skill 写得好”从行数/格式问题提升为可诊断的 agent 文档问题：

1. **Context pointer**：开头措辞要把模型带到正确的 trigger branch；不同含义不能共享一个模糊词。
2. **Context load 与 cognitive load 分离**：信息量和模型理解/决策成本是两个不同指标。
3. **Branch-local progressive disclosure**：reference 按真实分支加载，而不是只把正文机械拆短。
4. **Completion criterion**：必须既可检查又穷尽，否则 agent 会提前停止或无限延伸。
5. **Leading word 与正向措辞**：在上下文竞争下，把目标动作放在否定或从句前。
6. **Environment as source of truth**：可从环境即时查询的信息不应复制成陈旧文档缓存。
7. **No-op / sediment test**：逐句问“删除它是否改变目标模型行为”；不改变就删。

其核心判断“可预测性来自同一过程，不是同一输出”与 TP 的 deterministic backing 并不冲突：
脚本应固定证据、状态和 gate；LLM 仍可在受控过程内产生非完全相同的分析文本。

### 3.2 User-invoked 与 model-invoked

上游把显式编排 Skill 与可隐式触发的共享 discipline 分开：user-invoked 可调用 model-invoked，
默认不调用另一个 user-invoked；Claude `disable-model-invocation` 与 Codex
`policy.allow_implicit_invocation` 表达同一意图。详见
[invocation 规范](https://raw.githubusercontent.com/mattpocock/skills/885e2ca4d842d139e9aef4e48d366c63cb1b8013/.agents/invocation.md)。

该分类很有价值，但不能原样套在 TP：`/sprint` 当前显式推进 phase Skill，这是受状态机约束的合法
编排，不应被“一律禁止 user→user”误杀。正确借法是先建立 invocation graph 和 adapter metadata，
把规则作为可配置 validator，再迁移现有例外。

### 3.3 Lifecycle 与发布边界

上游用 `in-progress`、promoted、misc/out-of-promotion、删除/吸收 changeset 形成了轻量生命周期；
但它没有自动行为评测。TP 应借状态和一致性 invariant，而不是照搬目录：

- candidate/beta 不进入默认 runtime；
- promoted manifest、router/help、文档、projection 必须一致；
- rename/remove 必须记录 replacement 或 absorption；
- 使用率只能触发候选退役，不应在遥测不完整时自动删除。

### 3.4 Primary artifact 与 pointer

`wayfinder` 的“map is index, not store”、prototype 分支回链、research 单一引用文档都强调：地图和
总结保存 gist + pointer，真实 spec、ADR、diff、测试结果仍是 primary artifact。这个原则可直接用于
Sprint/Handoff/Skill eval，避免同一事实多处复制后漂移；是否采用 throwaway branch 则需单独评估。

### 3.5 上游边界

上游不是自进化引擎：没有 observation→candidate→eval→promotion 自动闭环；固定树没有行为 eval
fixture；唯一 tracked workflow 是 `.github/workflows/release.yml`；跨 Skill 已形成实际依赖却没有 machine-readable dependency manifest；
README 与个别 Skill 仍有语义漂移。最新 YAML 修复还表明 metadata parser gate 缺失。因此应把它
作为高质量 authoring/lifecycle 样本，而不是替换 TP 的确定性数据和发布护栏。

上游代码使用 [MIT License](https://github.com/mattpocock/skills/blob/885e2ca4d842d139e9aef4e48d366c63cb1b8013/LICENSE)，
允许在保留版权和许可声明的前提下使用、修改与分发；本轮只借鉴机制，没有复制其代码或文本资产。

## 4. v2.2 的可执行性审查

### 4.1 有价值的目标能力

v2.2 的五层方向是合理的：原始 Git/对话证据 → 清洗切片 → 双轨蒸馏/TV → Skill Graph →
runtime 装配 → 历史/诱饵回测与棘轮。文档**明示**且对 TP 重要的是：

- PR review、commit、revert/hotfix、PR decision 的统一 Git evidence；
- Git-derived rule 记录 `git_sources` 并经过 TV（三维有效性）过滤；
- dependencies/conflicts 的逻辑 Skill Graph；
- historical positives 与近邻 distractors 分开评估；
- runtime correction 的增量、版本溯源和回滚方向；
- 以历史回测结果约束候选合入的棘轮方向。

为了让这些目标在 TP 中可验证，本文**新增**的 gate 是：正式 RuleCandidate 生命周期、结构化
provenance/counterexamples、DAG/schema validator、patch expiry、baseline/candidate/dataset/evaluator
identity、per-dimension floor、权限分离、shadow 和发布读回。
这些是本评估的工程补足，不是 v2.2 已经定义的能力。

### 4.2 不能把文档原句直接变成生产规则

| v2.2 主张 | 问题 | 必须补足的 gate |
|---|---|---|
| Git 是“绝对真理源” | Git 只证明发生过什么；review、merge、revert 都可能错误或受组织偶然影响 | final disposition、RCA、反证、适用 scope、事实/意见/推断分离 |
| Block/Request Changes 不经最终处置核验即可“直接提炼”为 Hard Rule | 评论未必被采纳，也未必跨任务成立 | before/after/final diff、owner、样本下限或人工确认 |
| commit 序列等于分解 SOP | squash/rebase/cherry-pick 会破坏真实认知顺序 | 原子性核验、任务成功、跨样本重放 |
| Revert 直接等于 Fatal Anti-Pattern | 可能是产品撤回、外部故障、误操作或短期止损 | confirmed RCA、复现测试、多因保留 |
| 综合评分单调增长即可发布 | 平均分可掩盖安全/诚实边界退化 | per-dimension floor、容差、重复运行、held-out |
| 同类问题被多次指责后自动生成增量补丁并同步团队 | 无授权、TTL、灰度、owner、回滚事务 | scope、base hash、approval、expiry、shadow、rollback readback |
| Hard Rule > SOP > Persona > Hotpatch | 最新任务纠正被固定压在最低，不能覆盖旧错误 | 安全等级、scope specificity、recency 分轴决议 |
| 内置职业矩阵 | 示例没有项目 Git provenance，阈值也不具普适性 | 只作为候选 corpus，逐项目蒸馏和负例验证 |
| Skill Graph / Runtime Controller 逻辑层 | v2.2 没有规定 DB、向量存储或常驻服务；若物理化成重型新服务会与 TP 原则冲突 | 先映射到 Markdown/JSONL/companion manifest/现有 CLI |

此外，v2.2 的 TV 在章节间用词不完全一致，没有阈值和失败处置；`RIA-TV++` 与模板字段未完整
对应；`dependencies/conflicts` 没有版本/循环/多命中决议；anti-pattern linter 没有 DSL、置信度、
误报申诉或反思上限；路线图按周列活动而非按证据退出；MIT/AGPL 并列却没有适用范围。
这些都意味着它还不能直接成为 implementation contract。

### 4.3 建议冻结的最小对象

以下是从 v2.2 目标反推、与 TP 现有 JSONL/Markdown 兼容的最小补足；不是文档已有 schema：

```yaml
EvidenceRef:
  source_type: commit | pr | review | revert | hotfix | trace | document
  repo: owner/name
  immutable_ref: commit-sha-or-content-digest
  uri: source-pointer
  final_disposition: merged | rejected | reverted | superseded | unknown
  captured_at: timestamp
  scope: project/team/personal
  redaction_status: passed | rejected

RuleCandidate:
  id: stable-id
  kind: hard-rule | sop | heuristic | anti-pattern | boundary
  statement: candidate-rule
  scope: explicit-scope
  evidence_refs: []
  counterexamples: []
  tv:
    reproducibility: score-with-rubric
    predictive_power: score-with-rubric
    uniqueness: score-with-rubric
  confidence: bounded-score
  owner: identity
  status: proposed | evaluated | promoted | rejected | deprecated

EvalRun:
  skill_hash: sha256
  baseline_hash: sha256
  dataset_revision: immutable-id
  evaluator_revision: model-and-rubric
  seed: recorded-value
  positive: metrics
  distractor: metrics
  dimensions: {task_success, false_activation, boundary, safety, context_cost}
  regressions: []
  decision: pass | block | needs-review

RuntimePatch:
  id: stable-id
  base_skill_hash: sha256
  scope: task/project/team
  precedence_reason: safety/specificity/recency
  author: identity
  evidence_refs: []
  created_at: timestamp
  expires_at: timestamp
  approval: identity-or-null
  rollback_hash: sha256
```

## 5. 当前 TP Skill 自进化的真实能力

### 5.1 已验证链路

| 环节 | 已实现事实 | 证据强度 |
|---|---|---|
| 调用信号 | library 可派生 per-skill JSONL；实际 writer 只接在 Claude legacy Stop evaluator；当前 Codex plugin 没有 PostToolUse/Stop，`$skill` 数据源声明与 wiring 不一致 | 脚本 wiring；该模块无 tracked test |
| 诊断 | `/skill` 明示为 LLM 协议，无完整 deterministic backing；只能确定性汇总调用次数 | 文档 + 脚本 |
| 失败 trace | LLM 从 observations 语义提取，人工确认后 append；敏感字段再次脱敏 | 文档 + 脚本 + 单测 |
| trace→case | 只允许 `provenance=trace`，强制 `source_trace` 快照，append-only | 脚本 + CLI 单测 |
| improve | 读取 diagnosis/instinct/trace 做根因反思并输出提案，不立即写入 | 协议文档 |
| eval | LLM 执行测试并手工记录 version/pass_rate/cases/source；协议要求 Skill 不可改 case，但 writer 没有 caller authority/identity enforcement | 协议 + 结果脚本 |
| guard | 比较 results.jsonl 最近两条标量通过率，可设置 tolerance；退化 exit 2 | 脚本 + 单测 |
| publish | 文档约定 backup/changelog/rollback；没有 deterministic publisher/rollback；即使 `--auto`，改源文件前也要求用户 `go` | 协议 + guard 单测 |
| projection | canonical command/独立 Skill 经构建脚本生成 Codex/plugin surfaces，并有投影测试 | 脚本 + 单测 |
| evolve | 3+ 同域 instincts 聚类；`--auto` 且置信度 ≥0.85 时可直接写 Skill/Command | 协议文档 |

### 5.2 关键差距

#### A. 当前 Codex Skill 信号采集链未接通

`README.md:495-502` 明确 Codex lightweight hooks 只有 SessionStart、精确写路径 guard 和生命周期
evidence，不注册 PostToolUse 或 Stop。`aggregateSkillSignals()` 的实际调用位于
`plugins/tech-persistence/hooks/evaluate-session.js:871-880`，属于 Claude legacy Stop 路径；Codex
registry 的 lifecycle evidence 也没有 Skill 名。与此同时，当前 `$skill` 在
`plugins/tech-persistence/codex-skills/skill/SKILL.md:38-44` 声称 signals 由 Stage A hook 自动派生且只
覆盖 Codex `tool:"Skill"`。这两者不能同时成立。

因此，对当前活跃 Codex plugin，`$skill diagnose` 默认没有已验证的自动信号 writer。信号目录为空
不能被解释为“30 天无调用”，还可能是采集未接线。必须先修复/重述数据源边界，才适合用使用率、
放弃率或纠正次数驱动进化。

#### B. 即使存在 Signals，也不足以支撑诊断声明

`skill-signals.js` 只有调用次数和来源，没有 completion、duration、step、skip、correction、outcome。
但 `skill-diagnose` 输出模板要求步骤热力图、跳过率、纠正模式、放弃率。除非另外读取 observations
并由 LLM 推断，否则这些指标不能从 signal 文件确定性得出；当前报告没有统一要求把此类值标记为
“推断/未知”。这会形成“输出格式比数据契约更成熟”的错觉。

此外，legacy Stop 每次读取整个 session observations 后追加本次聚合结果，summarizer 再把多行
`calls` 相加；同一 session 多次 Stop 可能重复累计。writer 还把来源固定为 `codex-observations`，
与实际 legacy wiring 不一致。namespaced Skill id 是否因当前短名正则被丢弃尚未知。

#### C. Trace provenance 约束不等于来源真实性

case writer 强制 `provenance=trace` 和 `source_trace` 为对象，并做嵌套脱敏；但它不核验该对象确实
存在于 `skill-traces/{name}.jsonl`，也没有 trace id/hash/session/project/批准人。任意对象仍可冒充
真实 trace。正确增强是 immutable evidence id/hash + readback，而不是放宽 provenance。

#### D. Results 的 `cases` 扩展没有脱敏或固定 schema

trace writer 只对限定顶层字符串字段再次脱敏，eval-case writer 才对嵌套 `source_trace` 递归脱敏；
但 `skill-eval-results` CLI 接受任意 `--cases <json>`，library 把该对象原样写入 results JSONL。
若调用者放入 case 输入、错误片段、路径或凭据，敏感内容会被持久化。
因此“双层脱敏”不能泛化到整个自进化链；results 需要固定 schema、递归脱敏和跨进程测试。

#### E. 评测棘轮只保护一个手工标量

`results.jsonl` 没有 skill hash、case/dataset revision、model/judge/rubric、seed、各维度结果和重复
运行信息。guard 只比较 append 顺序最后两条**可解析**记录，而不是确认同一冻结考卷上的
baseline/candidate。
因此“通过率未下降”不等于 Skill 没有回归。

#### F. trust-critical guard 会 fail-open，也会静默退回陈旧记录

无基线时明确放行；validator 内部异常也 exit 0 并输出 fail-open marker。更隐蔽的是，reader 会跳过
malformed 行，再取最近两条**可解析**记录：若 append 截断或候选尾行损坏，guard 可能比较陈旧候选，
甚至只剩一条有效记录后走 no-baseline 放行，且不会出现 fail-open marker。单测把“跳过 malformed”
固化为普通读取行为，却没有验证 publish 必须 block。这些行为不适合承担“质量只增不退”的承诺。
应拆成：

- existing promoted Skill：缺基线/损坏/身份不匹配默认 block；
- 首次 enrollment：进入 candidate/beta，不伪装成与旧版可比；
- 紧急 override：显式理由、owner、scope、expiry，并形成审计记录。
- publish 比较窗口发现 malformed/truncated/missing candidate：默认 block 或 needs-review，不能降级旧记录。

#### G. `/evolve --auto` 绕过主评测链

`/skill auto` 保留 publish 人工 gate，但 `/evolve --auto` 对高置信 Skill/Command 可自动落地，只对
全局 rules、AGENTS、agents 保留 gate。两条进化路径对“新资产是否需要 eval、candidate lifecycle、
projection validation”没有统一契约。这是当前最大的内部一致性缺口。

#### H. 没有可执行 evaluator、publisher 与 rollback

现有 library/CLI 不负责运行 case 或判 assertion；pass rate 由 LLM/人传给 `record`。Improve proposal
没有持久 artifact/schema/hash，guard 也未与随后真正写入的 SKILL.md 绑定。backup/apply/changelog/
`absorbed_into` 都是 LLM 协议步骤，仓库内没有 `/skill-rollback` 实现。于是当前确定性保证只是
“最近两条人工标量记录满足比较”，不是“指定候选在冻结考卷通过并被事务发布”。

#### I. 多 runtime parity 是文件投影 parity，不是行为 parity

当前构建/投影测试能证明 wrapper、内容和入口形状正确；它不能证明 Claude/Codex 在相同用例上的
触发、分支选择和完成条件一致。上游 sidecar 模型可提供 metadata adapter 思路，但需要 TP 自己的
cross-harness eval，而不是把复制成功当成行为成功。

#### J. 体积预算既是只读提示，也没有覆盖活跃 Codex plugin surface

本轮 `skill-size-budget` 报告扫描 123 个文件、665.0 KiB，13 heavy、13 warn、22 command-derived；
source-only 为 77 个文件、431.2 KiB。但脚本扫描 `.codex/skills` 和
`plugins/tech-persistence/skills`，没有扫描 manifest 实际使用的
`plugins/tech-persistence/codex-skills`。实测两者分别为 32 个/205,953 bytes 与
32 个/121,466 bytes。因此该报告能证明仓库存在 context 压力，不能代表活跃 plugin surface。
即使补齐路径，字节/行数也不能判断 trigger branch、认知负担或文本是否 no-op；应将 size budget
与 `writing-for-agents` 语义诊断组合，而不是用单一 `<100/200 lines` 代替质量判断。

#### K. Codex wrapper 的邻接引用和 CLI 路径尚未闭合

当前 `$skill` wrapper 引用 `./skill-diagnose.md` 等 4 个邻接文件，但实际目录只有 `SKILL.md`；
构建器包装 command 正文时未复制这些邻接资源。Skill 内的 `node scripts/...` 也依赖当前工作目录，
而打包脚本位于 plugin root；在任意业务仓库安装后能否执行未做 runtime 验证。这是 discovery 之外
还需要的 installed-plugin canary。

## 6. 借鉴裁决矩阵

### 6.1 可直接借鉴：低风险、与现架构同向

| 候选 | 来源 | 当前缺口 | 最小落点 | 验收 |
|---|---|---|---|---|
| Agent 文档 fitness 维度 | writing-for-agents | diagnose 主要看 description/行数/拆分 | 扩充现有 diagnose/eval rubric，不新增命令 | branch pointer、completion、no-op、cache/sediment 都有正/负 fixture |
| Lifecycle 状态 | 上游 in-progress/promoted/remove | evolve 产物可直接落地，缺 candidate | 给 evolved asset 增 proposed/evaluated/promoted/rejected/deprecated | candidate 不进入默认 manifest；promotion 有 eval + go |
| Frontmatter/discovery canary | 上游最新 YAML 故障 | projection 有测试，缺全安装路径 discovery parse | 在现有 pre-commit/build 增 schema+installer discovery test | 每个发布 Skill 被各目标 parser 发现且数量一致 |
| Installed wrapper canary | TP 当前断链 | 邻接引用缺失、CLI 依赖 cwd | 从任意 fixture repo 加载 Skill、解析引用、调用 plugin-root CLI | 不依赖 tech-persistence cwd；所有引用存在 |
| Router completeness invariant | 上游 help/router/lifecycle | add/rename/remove 可能留陈旧入口 | 校验 manifest/help/list/router/projection 集合 | rename/remove fixture 无 missing/stale entry |
| Primary artifact + pointer | writing/wayfinder/research | summary/plan 可能复制证据 | plan/map 只存 gist、hash、pointer | primary 被修改时缓存漂移可检出 |
| 更严格 bug feedback gate | diagnosing-bugs | TP 要求反馈环，但完成定义可更硬 | `/work` bug 分支 rubric | 有真实运行、捕获原症状、deterministic/fast/agent-runnable、已脱敏的 red command |

“直接”指机制可并入现有入口，仍需单独实现 Sprint；不表示本轮已修改代码。

### 6.2 需适配借鉴：高价值，但先冻结契约

| 候选 | 来源 | 为什么不能原样搬 | TP 适配方式 | 优先级 |
|---|---|---|---|---|
| Git EvidenceRef | CSE | Git 不是 truth oracle，且涉及权限/隐私 | 只读、授权 repo；immutable ref + final disposition + redaction + counterevidence | P0/P2 |
| RuleCandidate + TV | CSE | TV 无公式/阈值，术语漂移 | 三维 rubric、样本下限、反例、owner/status；失败留 proposed/rejected | P0/P1 |
| Positive + distractor eval | CSE | 综合分棘轮会掩盖关键退化 | 分维度 floor；false activation/refusal 独立；held-out + repeat | P1 |
| Fail-closed publish ratchet | CSE + TP guard | 当前 no-baseline/内部错误放行 | promoted 默认 block；candidate enrollment 与 audited override 分支 | P1 |
| Invocation graph | 上游 | TP 合法 user→phase skill 编排会被误杀 | `user/model/phase/reference` 多类节点 + 例外清单；先 report-only | P2/P3 |
| Dependency/conflict DAG | CSE + 上游实际依赖 | CSE 无 resolver，上游无 manifest | companion manifest、版本范围、cycle/conflict/trigger ambiguity validator | P1/P3 |
| Harness-native metadata | 上游 sidecar | 字段不可跨 runtime 原样复制 | canonical intent + Claude/Codex adapter sidecars + parity tests | P3 |
| Runtime correction | CSE | 自动团队 hotpatch 越权且优先级错误 | task/project scope、TTL、base hash、shadow、人工 publish；不默认持久化 | P3/P4 |
| Usage-based retirement | 上游人工删除 | TP signals 只覆盖部分 Codex 调用 | 先补 telemetry parity；低使用只生成候选，不自动删除 | P3 |
| Large-sprint decision map | wayfinder | 默认引入会加重普通 Sprint | 仅超长/多上下文任务启用 destination/frontier/decision ticket | P3 |

### 6.3 不建议引入

| 项目 | 拒绝理由 |
|---|---|
| “Git 是绝对真理” | 违反 evidence ≠ truth；会把历史错误和组织偏见固化 |
| Block/Request Changes 不经最终处置核验就“直接提炼”为 Hard Rule | 评论不等于跨任务真理，缺 final disposition、scope、反证和 owner gate |
| 同类问题多次出现就自动生成补丁并推全员 | 重复不等于正确，缺授权、TTL、灰度、owner 和回滚 gate |
| 单一综合评分单调即可自动发布 | 可掩盖安全、边界、误触发退化；LLM 评测还会波动 |
| Flat priority：Hotpatch 永远最低 | 无法让当前、窄 scope 的纠错覆盖旧的宽 scope 错误；安全和时效应分轴 |
| 把 v2.2 职业矩阵直接注入 | 表内规则是无项目 evidence 的示例，不能成为生产 Hard Rule |
| 把 CSE 逻辑层物理化为新常驻 Gateway、DB 或向量图谱 | v2.2 并未强制这种部署；当前增量无需重型服务，会扩大权限与运维面 |
| 完整复制上游 issue tracker / `ask-matt` 命令面 | 目标函数不同，且会重复 TP 现有 think/plan/sprint/work/review |
| 用上游 prompt-only 发布链替代 TP guard/projection | 上游缺行为 eval/schema CI；会降低当前确定性和回滚能力 |
| 现在就按使用率自动删 Skill | 遥测只覆盖 Codex `Skill` 调用，样本存在结构性偏差 |

## 7. 推荐目标架构

### 7.1 控制流

```text
                    ┌──────────────────────────────┐
observations ──────▶│ authorized evidence adapters │◀──── Git/PR/review/revert
                    └──────────────┬───────────────┘
                                   ▼
                    EvidenceRef + redaction + disposition
                                   │
                                   ▼
                 RuleCandidate + scope + counterexamples + TV
                                   │
                         TV / owner / schema gate
                                   ▼
                    candidate Skill / patch / manifest
                                   │
                                   ▼
               frozen EvalPlan + positive/distractor/safety/context
                                   │
                   ┌───────────────┴────────────────┐
                   ▼                                ▼
             current EvalRun                 candidate EvalRun
                   └───────────────┬────────────────┘
                                   ▼
              deterministic per-dimension non-regression guard
                                   │
                         human go / audited override
                                   ▼
             transactional publish → projections → discovery/readback
                                   │
                         rollback hash + changelog
```

### 7.2 不变量

1. Evidence 可被证伪；任何单一 Git 事件都不能直接成为 Hard Rule。
2. Candidate、exam、evaluator、publish authority 分离；候选不能改自己的考卷。
3. 对 promoted Skill，缺失或损坏的基线不是“通过”。
4. Safety、honesty boundary、false activation 不允许被总分平均。
5. 自动化最多完成 ingest、诊断、候选和 shadow eval；修改共享 runtime 仍要人工 go。
6. canonical intent 只有一份；各 harness 使用 adapter metadata，不复制业务语义。
7. 发布完成必须同时证明 source、manifest、router、projection 和 discovery/readback 一致。
8. Runtime patch 必须有 scope、TTL、base hash、provenance 和 rollback；默认不跨任务持久化。

### 7.3 与现有路径的最小融合

不新增第二套 `/cognitive-skill` 命令：

- 在 `/skill diagnose` 前增加可选的 EvidenceRef/RuleCandidate 输入；
- 在 `/skill improve` 输出上增加 candidate identity/hash/lifecycle；
- 扩展现有 `skill-evals/{name}`，而不是新建数据库；
- 将 `skill-eval-results` 从标量记录升级为 versioned EvalRun；
- 让 `/evolve` 的新资产也进入 candidate→eval→publish；
- 在现有 build/projection test 增 frontmatter/discovery/router/DAG canary；
- 保留 Compound 的显式授权，不自动写全局 memory、commit 或 push。

## 8. 分阶段路线图

路线图按 exit evidence，而不是按“第几周”判完成。

### P0：冻结契约，不改变 runtime

- 冻结 `EvidenceRef`、`RuleCandidate`、`EvalRun`、`RuntimePatch` schema。
- 定义 TV rubric/阈值、scope/priority resolver、publish authority、首次 enrollment 和 override。
- 明确 source-of-truth、adapter/projection 和 migration 边界。
- 冻结 Codex 信号的真实 writer/reader 契约；在接通前，空 signals 必须报告 `unknown` 而不是“无使用”。

Exit：schema fixtures、冲突表和 threat model 通过 review；无 runtime 行为变化。

### P1：先硬化现有闭环

- 给 evolved outputs 增 candidate lifecycle，关闭 `/evolve` 绕过路径。
- EvalRun 绑定 skill/baseline hash、dataset revision、evaluator、seed、分维度结果。
- candidate、exam、evaluator 和 publisher 建立可验证 authority/identity separation；case/evidence 绑定不可变 hash。
- positive/distractor/safety/context 分开报告；promoted guard fail-closed。
- results `cases` 使用固定 schema 和递归脱敏；malformed/truncated candidate 结果必须 block。
- 增 frontmatter/discovery、router completeness、manifest/projection 数量一致性 canary。
- 将 `writing-for-agents` rubric 纳入 diagnose/eval。
- 为当前 Codex 入口建立受测的 signal/evidence 输入，或明确取消自动 signals 声明；修复 session 去重、
  source 标识和 namespaced id 契约。
- 增 installed-plugin wrapper/reference/CLI-path canary，并为 active `codex-skills` 计算 size budget。

Exit：

- 100% published change 有 baseline/candidate/dataset hash；
- 缺失/损坏 promoted baseline 被 block；
- false activation 与 safety 任一维下降会 block；
- 六类 invalid frontmatter fixture 都能在 publish 前失败；
- candidate 未经 go 不进入默认 runtime。

### P2：只读 Git evidence pilot

- 只接一个明确授权仓库，先处理 merged/reverted PR 与 Request Changes。
- 采集不可变 ref、final disposition、digest、redaction 和 counterevidence。
- 只产出 RuleCandidate；不开 runtime hotpatch，不自动发布。

Exit：抽样 evidence slice 可完整回溯；误关联/拒绝率可见；所有 Git-derived rule 有最终处置和人工接受。

### P3：调用图、DAG 与多 runtime 行为 parity

- 引入 companion invocation/dependency manifest；先 report-only，再逐项收紧。
- canonical intent → harness adapters；建立 Claude/Codex 相同正负用例。
- 只有 telemetry parity 后才启用使用率退役候选。

Exit：拓扑排序、冲突决议、router、projection、双 harness fixture 全通过；合法 Sprint phase 编排不被误杀。

### P4：受控 runtime correction 与 anti-pattern shadow

- RuntimePatch 只在 shadow/task scope 启动，带 TTL、base hash、owner、reason、rollback。
- Anti-pattern matcher 先建立 TP/FP/FN fixture、severity、申诉和最大 retry。
- 团队分发另设授权 gate，不由重复次数自动触发。

Exit：shadow 误报率达标，rollback drill 和 projection readback 通过，权限/审计/过期均有测试。

## 9. 验收测试建议

| 类别 | 最小测试 |
|---|---|
| Evidence | immutable ref/digest、final disposition、redaction reject、counterevidence 保留、错误关联 fixture |
| TV | 单一 review 不晋升、跨样本复现、反例使候选降级、rubric revision 可追踪 |
| Trigger | positive、near-neighbor distractor、ambiguous trigger、false refusal/activation 分开 |
| Eval identity | skill/baseline/dataset/evaluator/seed 任一不匹配即不可比较；candidate 无权改 exam/evidence |
| Ratchet | task success 增但 safety 降仍 block；flaky 重复运行；首次 enrollment 不冒充 baseline；尾部 malformed/truncated candidate 必须 block |
| Lifecycle | candidate 不进默认 manifest；promote/deprecate/remove 有 replacement 和 router readback |
| Invocation/DAG | missing dependency、cycle、conflict、user/phase 例外、双 harness metadata 一致 |
| Publish | invalid YAML、partial projection、discovery count mismatch、results `cases` 递归脱敏、rollback 后 hash/readback 一致 |
| Patch | TTL、base mismatch、scope 泄漏、无授权团队分发、rollback drill |

## 10. 本轮验证记录

### 已通过

直接在 Node 进程中运行的 3 个 test file：

- `test-skill-traces.js`：7/7。
- `test-skill-eval-cases.js`：9/9。
- `test-skill-size-budget.js`：5/5。

需要子进程的 5 个 test file 在受限环境中先遇到 `spawnSync ... EPERM`；确认连
`spawnSync(process.execPath, ['--version'])` 都失败后，以获准的直接执行路径重跑，全部通过：

- `test-skill-traces-cli.js`：7/7。
- `test-skill-eval-cases-cli.js`：10/10。
- `test-skill-eval-results.js`：10/10。
- `test-skill-publish-guard.js`：10/10，包括当前设计的 no-baseline 与 fail-open 分支。
- `test-codex-native-skill-projection.js`：通过。
- `validate-codex-plugin.js`：inventory、字节投影与 require closure 全部通过。

### 这些测试能证明什么

它们证明当前 JSONL 记录、trace 限定字段/case 嵌套对象脱敏、provenance shape gate、CLI exit policy、
标量 guard 和投影契约按现有设计运行。它们不能证明 LLM 诊断准确、A/B pass rate 客观、生产调用
覆盖完整、跨 harness 行为一致，
也不能证明 Codex `$skill` signal 自动采集、trace 对象来源真实性、installed-plugin cwd 可移植性，
或 v2.2 的 Git ingestion/TV/DAG/多维棘轮已经存在。`skill-signals` 当前没有 tracked test file。

## 11. 未知项与残余风险

- 上游 marketplace 当前 pin 是否等于 `main` HEAD 未核验；不能把 main 修复视为所有用户已收到。
- 上游真实使用率、误触发率和完成率没有公开行为 eval，本文不作效果推断。
- 本地 Codex `$skill` 自动遥测当前没有 writer 证据；legacy Claude observation 的真实覆盖率也未知。
- v2.2 没有配套代码、schema、benchmark 或 evaluator；本文只能评估方法论契约，不能验证实现效果。
- 未来 Git evidence 涉及客户代码、secret、PII、作者身份和团队治理，必须另做授权与保留策略。
- 本轮没有修改业务 Skill，因此路线图与验收项是后续实施合同，不是已交付能力。

## 最终裁决

可以直接借鉴到当前架构的，不是另一套“认知引擎”，而是六个边界清晰的增强：

1. `writing-for-agents` 的 context/completion/no-op/cache 诊断维度；
2. candidate→promoted→deprecated 生命周期；
3. frontmatter/install discovery 和 router completeness canary；
4. primary artifact + pointer；
5. 更严格的 bug feedback completion gate；
6. 现有 source/projection/publish 集合一致性检查。

高价值但必须适配的是 Git EvidenceRef、RuleCandidate+TV、positive/distractor 多维 eval、fail-closed
ratchet、invocation/DAG、harness metadata 和有 TTL 的 runtime patch。明确拒绝 Git 绝对真理、自动团队
热修复、单分棘轮、固定最低 hotpatch 优先级、无证职业矩阵和重型常驻网关。

因此下一轮若进入实施，首个 Sprint 应是 **先修正 Codex signal/evidence 入口，再做 P0/P1 schema +
ratchet hardening + installed discovery canary**，而不是先抓取 Git 历史或建设 runtime gateway。先让
当前闭环能够可靠证明“证据从哪里来、候选是谁、考卷是哪版、哪些维度不能退化、发布到了哪里”，
再扩大证据输入，风险最低且收益最直接。

## Compound 摘要

### Problem

当前文档把 `/skill` 描述成完整进化闭环，但 Codex signals 入口、评测身份、发布绑定和 rollback
没有形成可验证端到端链；v2.2 又把目标能力、示例规则和自动化愿景混在一起，不能直接照搬。

### Root Cause

数据辅助库、LLM 协议和 runtime 投影分别演进，缺少统一的 evidence/candidate/eval/publish identity；
同时过去对外部仓库的理解已经漂移，且方法论文档没有补足权限、反例、schema 和失败恢复 gate。

### Solution

三方融合：用上游的 agent 文档 fitness/lifecycle，吸收 CSE 的 Git evidence/TV/distractor 目标，
保留 TP 的权限/投影骨架，并按本文 P0–P4 先修入口和 ratchet、后扩 Git、最后做 shadow runtime。

### Prevention

以后任何 Skill 自进化声明都必须分别证明 evidence writer、candidate hash、frozen dataset、
per-dimension result、authority、publish readback 和 rollback；文件投影一致不得冒充行为闭环。

### Related

- Sprint 计划：`docs/plans/2026-08-20-mattpocock-skills-self-evolution-analysis.md`。
- 方法论输入：`docs/Cognitive_Skill_Engine_Methodology_v2.2.md`（用户原始文件，本轮未修改）。
- 历史基线：`docs/plans/2026-05-15-mattpocock-skills-analysis.md`、
  `docs/plans/2026-05-18-mattpocock-skills-followup.md`。
