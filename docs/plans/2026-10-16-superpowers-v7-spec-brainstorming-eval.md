---
title: "Superpowers v7 Spec 与 Brainstorming 增量复评"
date: "2026-10-16"
updated: "2026-11-02"
status: completed
type: sibling-eval
scope: research-only
source_repo: "https://github.com/obra/superpowers"
source_release: "v7.0.0"
source_commit: "bb92a77741419a4ab5f06e711a283343f1ada0c3"
baseline:
  - "docs/plans/2026-09-09-superpowers-spec-brainstorming-eval.md"
  - "docs/reports/2026-10-09-superpowers-ecc-updates-report.md"
tasks_total: 5
tasks_completed: 5
tags: [sibling-eval, superpowers, v7, spec, brainstorming, think, plan]
---

# Superpowers v7 Spec 与 Brainstorming 增量复评

> 本轮只研究 2026-09-09 / 2026-10-09 基线之后的真实增量，不修改 Think、Plan 或运行时，不运行 Compound，不写学习，不提交或推送。

## 0. 结论先行

Superpowers v7.0.0 不是对三路 brainstorming 的小修，而是一次控制顺序重写：**先理解意图，再决定任务大小和工件深度**。这推翻了上一轮把 `probe-like / bounded-like / architectural-like` 当成 Think 第一动作的建议，但不要求删除 TP 已有三枚内部路由值。更合适的本土化是：

1. 先对欠定义任务做意图发现和早期复述；已清晰的小任务直接继续。
2. 意图足够清楚后，再以自然语言向用户说明任务规模；内部仍可映射到现有三枚枚举，保持测试、`auto-mode` 和 artifact scaling 稳定。
3. 将 provenance 拆成两个维度：对话中区分用户陈述与 agent 推断；设计中区分用户确认、agent 决定、留给 builder、仍需用户裁决。
4. 高歧义 architectural-like Plan 可在 authority draft 完成、task decomposition 开始前增加一次 planner-readiness 检查，但先做本地行为评测；不把每份文档的 fresh-subagent check 设为默认。

v6.4.1 的 Review Focus 与 v6.4.2 的 lean plan、接口/断言已于 2026-10-13 落到 TP，属于 **cross-ref**，不是本轮新实施项。SB6 lineage runtime 的正式 108-rep 评测仍未运行，v7 也没有提供足以替代它的证据。

## 关键假设验证

- 假设：v7 的收益可以归因于 route-after-intent 单项。核验：PR #2463 同时改变提问、playback、路由和 builder check，没有单变量 ablation；因此只支持调整工程建议，不能将整套收益归给后置路由，TP 双 runtime 效果仍需本地验证。
- 假设：上游的 Plan 更新都是 TP 的新缺口。核验：读取双方 Plan、任务契约 reference、模板和 2026-10-13 实施记录，接口/断言、Consumes/Produces 与 Review Focus 已落地；本轮归为 cross-ref，不重复建设。
- 假设：必须新增独立 spec 或 lineage runtime 才能承载决策来源。核验：现有 architectural shadow design-authority 已有同文件方案与理由，双 SoT 和受管投影均有真实落点；先用关键取舍旁的来源短注即可试点，SB6 仍受原本地证据门约束。

## 1. Identity Question First

Tech Persistence 仍是 **developer-toolchain self-evolution sibling**：服务 Claude/Codex 双原生工作流、可审计持久化与风险缩放，而不是一个强制所有开发都经过同一会话仪式的 brainstorming 产品。

| 维度 | Superpowers v7 | Tech Persistence 当前 | 本轮约束 |
|---|---|---|---|
| runtime | 同一 skill 面向多个 harness；v7 主行为证据以 Claude 为主，Codex 部分样本受审批超时干扰 | Claude/Codex 双原生 SoT + 受管投影 | 只借跨 runtime 可表达的语义；Codex 未证实效果不能写成事实 |
| persistence | quick/small 可停留 chat；project 写独立 design doc，再写 plan | 同一 Sprint/Plan 内 shadow design-authority；agent-loop 有 frozen JSON spec | 不因 v7 新增第二个默认 spec owner |
| determinism | 主要是 prompt 协议；builder check 仍为语义判断 | 路由枚举、投影、AcceptanceContract 等已有确定性边界 | 不把 LLM 对话纪律误写成确定性 gate |
| privacy | 可做 repo/web recon；另有可选视觉 companion | 本地优先；外部数据和写操作受授权边界约束 | 不引入视觉 server/telemetry；只读 scoped recon 保持正常自治 |
| surface | 首轮 opt-out、意图对话、written design、approval、auto-commit | Think→Plan→Work→Review，gate 由风险/权限决定 | 借 spine，不照搬固定话术、固定停等和自动 commit |
| scaling | 意图清楚后分 quick / small / project；spike 是 discovery 手段 | probe/bounded/architectural 控制工件深度 | 保留内部 post-intent artifact route，改变判定时机和用户表面 |
| business model | 通用开发方法与技能框架 | 持久工程记忆与受治理工作流 | 不扩成另一套产品发现/项目管理框架 |
| dependency surface | Markdown skills；视觉 companion 另带服务 | 现有 Node 脚本、Markdown 与可选基础设施 | 本轮不新增服务、依赖或 runtime parser |

四原则判断：MR **Partial**，因为 v7 的核心对话结果尚未在 Codex 得到同等质量证据；DET **Partial**，因为机制主要依赖 prompt；LT **Pass/Partial**，后置 sizing 减少误写文档，但固定对话轮次和 reviewer 会增加税；OBS **Pass**，前提是决策 provenance 留在现有 Markdown authority，而不是仅存在聊天历史。

## 2. Evidence Collection

### 2.1 固定版本与增量边界

- 2026-10-16 核验时，最新正式版为 v7.0.0，release/tag/main 均指向 `bb92a77741419a4ab5f06e711a283343f1ada0c3`；commit 时间为 `2026-10-10T00:28:04Z`，`v7.0.0..HEAD` 在聚焦路径上无差异。
- 上一轮固定的 v6.4.2 为 `8ca22dba9a94f28898bbce59f2537ff4d87c747d`。真正的 `v6.4.2..v7.0.0` brainstorming 核心增量（release notes、brainstorming skill/脚本/prompt 与 rebuild design，不含无关 Antigravity design）为 6 个文件、440 行新增、313 行删除；去掉 release notes 为 5 个文件、392 行新增、313 行删除。
- 仓库快照为 684 commits；GitHub API 快照约 300,194 stars / 26,811 forks。热度不参与采纳决策，只用于说明对象仍在高频演进。
- 10 月 13 日的 issue #2507 提议 project-sized 工作先做 mandatory recon，但尚未合并，不能写成 v7 能力；issue #2473 暴露 auto-commit 可能带入无关 staged 文件，反而加强 TP 对自动提交的既有拒绝。

来源：Superpowers [v7.0.0 release](https://github.com/obra/superpowers/releases/tag/v7.0.0)、[repository](https://github.com/obra/superpowers)、[mandatory recon discussion](https://github.com/obra/superpowers/issues/2507)、[auto-commit hazard](https://github.com/obra/superpowers/issues/2473)。

### 2.2 Brainstorming 的真正重写

v6.3 先把任务分成 spike / bounded / architectural，再按路由决定问法和工件。v7 明确拒绝这个顺序：在不知道用户真实意图时先分类，会让一次猜测同时控制提问和文档税。新的 spine 是：

1. 私下判断已知信息是否足够；清晰任务不强制进入问答。
2. 信息不足时先问一个开放、描述性问题；菜单只在用户卡住时使用。
3. 问真实时刻、边界和让用户“皱眉”的失败；同时收集 goals、non-goals、anti-goals 与 prior art。
4. 在数轮问题后分段复述当前理解，明确哪些是用户陈述、哪些是 agent 猜测或默认值，让纠偏早于完整设计。
5. 意图清楚后才描述为 quick clear task / small change / project with written design。spike 不再是顶层路线，而是 discovery 中的 throwaway learning technique。

“多个独立项目先约定顺序、一次只 brainstorm 一个”仍是合理规则，但 v6.3 已经存在；本轮只把它作为上一轮遗漏的 cross-ref/backfill，不冒充 v7 新增。

来源：[v7 brainstorming skill](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md)、[rebuild design](https://github.com/obra/superpowers/blob/main/docs/superpowers/specs/2026-10-05-brainstorming-rebuild-design.md)、[implementation PR #2463](https://github.com/obra/superpowers/pull/2463)。

### 2.3 Spec 从“完整性审查”转为“下游能否开工”

v7 删除通用 spec-document-reviewer，改成 fresh builder check：让一个不了解对话上下文的 builder 只报告“若不问就只能猜、且猜错会显著改变结果”的问题。父流程把问题归为：

- 已经回答：指回文档，不再问用户；
- minor：agent 自行决定，并标明这是 agent call；
- theirs：只有用户能决定且会改变所建内容，合并成一次按重要度排序的问题。

这与 TP 已有四项 inline preflight 并不互斥：placeholder / consistency / scope / ambiguity 检查文档自身，builder check 检查下游 planner 是否仍会在高影响点猜测。可借的是后者的 **planner-readiness spine**，不是“每份设计都默认派 fresh subagent”的 surface。

来源：[builder check prompt](https://github.com/obra/superpowers/blob/main/skills/brainstorming/builder-check-prompt.md)、[PR #2463](https://github.com/obra/superpowers/pull/2463)。

### 2.4 “How it gets made”补上决策所有权

10 月 9 日后的补丁要求区分：哪些平台、语言、库、媒介选择由用户掌握，哪些明确委托给 agent/builder，以及已有资产和技术栈是什么。技术用户可以共同讨论；明确委托或不关心的用户由 agent 选合理默认值并直说。已有项目优先沿用当前 stack。agent 的决定不能伪装成“用户同意”。

该机制需要按阶段适配：Think 仍不负责完整技术设计，只记录 **user-owned / delegated / unresolved** 的决策权边界；Plan 才在被委托区域作出技术决定，并记录 **user-confirmed / agent-call / builder-delegated / user-only unresolved**。这样不会把 Think 扩成第二个 Plan，却能避免“用户只说想要 iOS app，agent 最后按 web app 设计”的 provenance 丢失。

来源：[how-it-gets-made PR #2482](https://github.com/obra/superpowers/pull/2482)、[skip-path follow-up #2483](https://github.com/obra/superpowers/pull/2483)。

### 2.5 行为评测支持什么、不支持什么

PR #2463 报告 115 个首轮样本、58 个多轮模拟会话、6 名盲测者各比较新旧两次会话，以及两名对抗 reviewer。旧版到新版的已报告变化包括：process-jargon 开场 25/25→0/25、menu-first 20/20→0/20、一个明确小任务正确直达 0/5→5/5、盲测偏好新版 0/6→6/6；“被理解/愉快/值得/信任”均值分别从 6.3/6.3/7.3/6.7 变为 8.8/8.0/7.8/8.7。builder check 初版出现 2 轮、3–9 个问题，收缩为一次排序后 4/4 样本只问一轮。

这些实验同时改变 route ordering、开放式提问、menus、playback、decision ownership 和 review 方式，没有做 route-ordering ablation。它们足以让“route-first 是默认最稳首步”失去依据，并支持本轮翻转工程建议；**不能证明改善由 route-after-intent 单独造成**。该因果收益与 TP 适配效果仍需本地 A/B。

必须保留限制：中途主动提出 spike 未实测；#2463 的主要结果来自 Claude。后续 eval 环境增加 Codex，但“how it gets made”在 Codex 上多次被 approval timeout 干扰，结果不具结论性，且新旧 arm 都出现首轮直接生成 React/Vite 的样本。因此可把 v7 当成高质量候选和 Claude 侧证据，不能直接宣称 Claude/Codex 已共同验证。

来源：[PR #2463](https://github.com/obra/superpowers/pull/2463)、[eval environment PR #2464](https://github.com/obra/superpowers/pull/2464)、[how-it-gets-made eval #2482](https://github.com/obra/superpowers/pull/2482)、[matching eval repo PR #71](https://github.com/prime-radiant-inc/superpowers-evals/pull/71)。

### 2.6 v6.4.2 的计划更新已被 TP 吸收

v6.4.1 引入 Review Focus，将关键失败输入绑定到 owning task/test；v6.4.2 将 plan 定义为 decisions 而非 implementation transcript：记录确切签名、文件、spec 值、断言和验证输出，仅在算法无法由契约推导时写正文，step 以可验证动作计，不用固定分钟估算。

TP 在 2026-10-13 已把这些内容落入：

- `user-level/commands/plan.md`
- `codex-native/skills/plan/SKILL.md`
- `codex-native/skills/plan/references/task-contracts.md`
- `docs/plans/TEMPLATE.md`
- Claude/Codex Review 消费者

所以本轮不再提出第二套 Plan 模板或新 parser。来源：[v6.4.2 release](https://github.com/obra/superpowers/releases/tag/v6.4.2)、[writing-plans skill](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md)、本地 [[2026-10-13-plan-review-contracts]]。

### 2.7 Runtime Path Verification

本轮实际读取或 grep：

- `.codex/project-standards.json`
- `.codex/rules/architecture-{base,agent,infrastructure}.md`
- `codex-native/skills/think/SKILL.md`
- `user-level/commands/think.md`
- `codex-native/skills/plan/SKILL.md`
- `codex-native/skills/plan/references/task-contracts.md`
- `user-level/commands/plan.md`
- `docs/plans/TEMPLATE.md`
- `scripts/test-think-design-routing.js`
- `docs/plans/2026-09-09-superpowers-spec-brainstorming-eval.md`
- `docs/reports/2026-10-09-superpowers-ecc-updates-report.md`
- `docs/plans/2026-10-13-plan-review-contracts.md`

上游实际读取 `v6.3.0..v7.0.0` 的 tag diff、`skills/brainstorming/`、`skills/writing-plans/`、v7 rebuild design 与相关 PR/issue；没有只根据 release 文案推断行为。

## 3. Candidate Plan

评分为改写后的 TP 方案，顺序 MR / DET / LT / OBS；P=pass，p=partial，F=fail。

| ID | 候选与判断 | 四原则 | Surface / Spine | 已验证落点 | 决策 |
|---|---|---|---|---|---|
| V7-1 | 欠定义任务先理解意图，意图清楚后才决定 artifact route；现有三枚枚举改成 internal post-intent artifact route | P/p/P/P | Spine | 两端 Think SoT + 静态/行为 tests | **P1 flip**；替代 route-first，不删除枚举；因果收益待本地验证 |
| V7-2 | 开放描述问题优先；menus 只在用户卡住时用；问题绑定真实时刻和具体 tradeoff | P/p/P/P | Spine | Think 默认 ambiguous-task 分支 | **P1**；清晰任务不问；`--clarify` 仍保证系统扫描，若改交互节奏需单测 |
| V7-3 | 结果相关的歧义出现或进入多轮/architectural 深度时，做简短 playback；对话归因只区分 user-stated / agent-inference | P/p/P/P | Spine | Think 输出 | **P1**；不硬编码 200–300 字或固定第几轮，不给 bounded 小任务加仪式 |
| V7-4 | goals / non-goals 外增加 anti-goals | P/p/P/P | Spine | Think 契约和 design authority | **P1**；仅在相关时触发 |
| V7-5 | Think 记录决策权边界：user-owned / delegated / unresolved | P/p/P/P | Spine | Think→Plan handoff | **P1**；不在 Think 作技术默认 |
| V7-6 | Plan 对关键决定记录 user-confirmed / agent-call / builder-delegated / user-only unresolved | P/p/P/P | Spine | 两端 Plan SoT + 条件 reference + `docs/plans/TEMPLATE.md` + projections | **P1**；Codex Plan 已 3,987 bytes，详细语义必须放 reference 或先压缩入口，不新增 spec owner |
| V7-7 | 高歧义 architectural authority draft 做一次 planner-readiness，只上报高影响猜测 | p/p/p/P | Spine | Plan 内 `authority draft → readiness → task decomposition`，不是 post-implementation Review phase | **P2 conditional**；先做 Claude/Codex treatment eval，inline fallback 必须可用 |
| V7-8 | 精确对话节奏、复述长度和 builder-check 触发阈值 | p/p/p/P | Surface | behavior fixtures，不进 runtime | **P2 A/B**；以纠偏率、轮次和 token 成本决定，不照抄数字 |
| V7-9 | 多个独立项目先排序、逐个澄清 | P/p/P/P | Spine | Think 既有 scope 语义 | **Cross-ref/backfill**；v6.3 已存在，不算 v7 新增 |
| V7-10 | lean plan、接口/断言、Review Focus | P/p/P/P | Spine | 2026-10-13 Plan/Review 既有改动 | **Cross-ref**；已落地，不重复实施 |
| V7-11 | 每次首条消息固定提供“可跳过问题”话术 | P/p/p/p | Surface | 不落 | **Hard reject**；显式用户指令已优先，固定话术制造开场税 |
| V7-12 | 所有 small/project 设计都必须等用户批准 | p/p/F/P | Surface | 不落 | **Hard reject**；gate 继续由开放决策、权限、外部副作用与不可逆性决定 |
| V7-13 | scoped repo/web recon 前一律先征询许可 | p/p/F/p | Surface | 不落 | **Hard reject**；任务内只读勘察是正常自治，越出范围或涉及私人/受限数据才问 |
| V7-14 | 默认独立 spec 文件并自动 commit | p/p/F/P | Surface | 不落 | **Hard reject**；同文件 authority 已足够，commit 仍需用户授权 |
| V7-15 | visual companion server / telemetry | p/p/F/F | Surface | 不落 | **Hard reject**；继续复用现有视觉能力路由 |
| V7-16 | 每份 written design 默认 fresh-subagent builder check | p/p/F/P | Surface | 不落 | **Hard reject**；v7 当前已是一轮；V7-7 只保留高歧义、pre-decomposition 的 readiness spine |

互斥主决策：P1 6 + P2 2 + cross-ref 2 + hard reject 6 = 16。

## 4. Proposed Native Shape（非实施）

```text
clear request ───────────────────────────────────────────────┐
                                                             v
under-specified request -> intent discovery -> early playback -> size after intent
                              |                    |                 |
                              |                    |                 +-> internal route enum
                              |                    +-> user-stated / agent-inference
                              +-> goals / non-goals / anti-goals / ownership boundary

internal post-intent artifact route:
  probe-like         -> throwaway learning; if retained, reclassify
  bounded-like       -> short design; no extra artifact
  architectural-like -> Plan: authority draft -> inline preflight
                                                   |
                                                   +-> optional one-round readiness
                                                   |
                                                   +-> task decomposition
```

建议的 provenance 分为两个正交维度，不新增格式 owner：

```markdown
### Conversation attribution
- User-stated: ...
- Agent-inference: ...

### Decision ownership
- User-confirmed: ...
- Agent-call: ...
- Builder-delegated: ...
- User-only unresolved: ...
```

Think 的 handoff 只声明 `user-owned / delegated / unresolved` 边界；上面的技术决定由 Plan 记录。字段名和具体 Markdown 需在实施时由 fixture 校准。`user-confirmed` 只能来自用户明确表达；agent inference、既有项目约束、delegated boundary 和 agent-call 都不能改写为用户同意。`user-only unresolved` 只保留会改变所建结果且无法由 agent 合理默认的决定，并在 task decomposition 前触发现有开放产品决策 gate；minor/defaultable 项必须转成显式 `agent-call`，不能伪造阻塞。

### 本地 eval gate

V7-1～V7-6 可以先做 prompt-only pilot，但验证必须分层：静态契约/parity 扩展 `scripts/test-think-design-routing.js` 与现有 projection tests；行为 A/B 分别对 `user-level/commands/think.md` 和 `codex-native/skills/think/SKILL.md` 运行，不把关键词检查冒充对话效果。明确小任务不得被强制拉长；隐藏平台选择必须被识别；技术用户与明确委托用户都能保持 ownership；同一个输入在 Claude/Codex 上映射到同一内部 route 枚举。

V7-7 不应仅凭上游 Claude 证据实施为默认 subagent gate。最小 treatment 对比现有四项 inline preflight 与“inline + one-round readiness”，分别覆盖：遗漏用户专属决定、agent 可合理默认、文档已回答、纯措辞问题。预注册关注高影响漏问、误问率、额外轮次和 token；Codex 单端退化不能被 Claude 汇总掩盖。

SB6 的 108-rep lineage/freshness 评测与本轮 conversation/readiness eval 是两件事。v7 没有 hash、criterion coverage 或 stale recovery 的等价机制，不能据此绕过旧证据门。

## 5. Defensive Challenge

### Flip 1：route-first → intent-first, route-later

2026-09-09 的 SB1 把三路分类放在 Think 第一动作，并在同日实施为现有枚举。v7 的整套 rewrite 证据使“route-first 是默认最稳首步”失去依据；route ordering 的独立因果贡献仍未知。结论发生真实翻转：**三枚枚举保留为 internal post-intent artifact route，但不再是面向用户的第一步，也不应先于必要的意图发现。**

### 机制细化：generic review → pre-decomposition planner-readiness

上一轮 SB14 已经允许高风险/争议时做 P2 独立 Review，因此这不是第二个真实 flip。v7 的增量是把目标函数从泛化“文档完整吗”收窄成“task decomposition 前，下游是否会在高影响点猜测”。结论细化为：四项 inline 继续默认；architectural/high-ambiguity authority draft 可评测一次 pre-decomposition planner-readiness。**没有翻转成每份文档都派 subagent。**

### 未翻转

- design authority 与 implementation plan 的逻辑分层仍成立；物理双文件仍无充分证据。
- 自动 commit、固定人工 gate、视觉 server 仍拒绝。
- lineage runtime 仍受本地 SB6 证据门约束。

## 6. Review Gate

- [x] product-lens：PASS；收窄 route 因果口径，将 readiness 前移到 task decomposition 之前，并闭合 Think/Plan ownership 分层与轻量 playback 边界。
- [x] coherence：PASS；核对 tag/SHA/UTC、核心 diff `6/+440/-313`、16 项计数、v6.4.1/v6.4.2 时间线与 1 个真实 flip。
- [x] feasibility：PASS；核验双 SoT、投影、3,987/4,096-byte Plan 预算、`--clarify` 边界和静态/行为验证分层。
- [x] defensive challenge：已记录 1 个真实 flip（route-first → route-after-intent）和 1 个机制细化；另把“多项目逐个处理”从 P1 降为 v6.3 cross-ref/backfill。

## 7. Outputs 与边界

- Plan：本文件。
- Decision：`docs/solutions/2026-10-16-superpowers-v7-spec-brainstorming-eval.md`。
- Learning/instinct：0（未授权）。
- 产品代码/技能实现：0（本轮为研究）。
- 未知项：TP 本地新旧 brainstorming 的实际纠偏率、轮次、token 与返工收益；Codex 上游样本仍不具结论性；SB6 正式评测未运行。

## Sources

- https://github.com/obra/superpowers/releases/tag/v7.0.0
- https://github.com/obra/superpowers/releases/tag/v6.4.2
- https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md
- https://github.com/obra/superpowers/blob/main/skills/brainstorming/builder-check-prompt.md
- https://github.com/obra/superpowers/blob/main/docs/superpowers/specs/2026-10-05-brainstorming-rebuild-design.md
- https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md
- https://github.com/obra/superpowers/pull/2463
- https://github.com/obra/superpowers/pull/2464
- https://github.com/obra/superpowers/pull/2482
- https://github.com/obra/superpowers/pull/2483
- https://github.com/prime-radiant-inc/superpowers-evals/pull/71
- https://github.com/obra/superpowers/issues/2473
- https://github.com/obra/superpowers/issues/2507

