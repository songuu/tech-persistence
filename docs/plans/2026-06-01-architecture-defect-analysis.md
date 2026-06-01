# 架构缺陷分析：agentic coding 趋势下的最大软肋 + 缺陷 A 缓解

> **Status:** `completed`
> **Created:** 2026-06-01
> **Updated:** 2026-06-01

---

## 需求分析

<!-- Phase 1 Think 产出（CEO/产品视角）。这是分析任务，非标准 feature sprint。 -->

### 要做

- 判断 tech-persistence 当前架构，在「vibe coding / agentic coding」趋势下**最大的缺陷**。
- 给出论证 + 次级缺陷对比 + 诚实区分「真缺陷」vs「4 不可妥协原则的固有代价」。
- 针对选定的最大缺陷（A）设计**克制、可证价值**的缓解方案（measure-before-enforce）。

### 不做

- 不推翻架构、不引入重型进程级编排（撞「轻量优先」[[ADR-011]]）。
- 不假装能用确定性机制测量「模型语义遵守」（[[ADR-017]] 边界）。
- 本 sprint 不下沉任何 enforcement——只做 measure 阶段（避免 [[feedback_unproven_protocol_rollback_before_enforcement]] / [[feedback_enforcement_dead_on_arrival_82pct]]）。

### 成功标准

- [x] thesis A 被认可有洞察，并通过 ADR-022 落为 A1/A2 分层。
- [x] 缺陷分层（A1 可测外围 / A2 不可消除内核）清晰，明确哪层可缓解、哪层接受。
- [x] 产出的 demand-side 信号已接入已有消费点：SessionStart cost summary + `/review-learnings --recall`。

### 风险和假设

- 假设「agentic coding 趋势 = 更长自主循环 / 更频繁上下文压缩 / 更多并行 subagent」。
- 假设 solo-toolchain 定位不变（[[ADR-011]]）——团队/规模化不是本系统目标。

---

## 最大缺陷（thesis A）

**整个系统的「纪律」和「记忆」都寄生在「模型自愿遵守」上。agentic coding 三个主趋势正在系统性侵蚀这条价值兑现链路。系统投入大量工程把经验沉淀成结构化文本，但「沉淀 → 被读 → 被遵守 → 改变行为」每一环都没有进程级强制，也（在最关键处）没有可观测信号。**

### 论证

**1. 核心载体是 model-driven markdown 协议，无宿主进程。**

`sprint / think / plan / work / review / compound` 全是 markdown。phase 重入、gate 通过、本能注入是否被读、review 是否真多视角——无一有进程级计数器或断路器。[[ADR-021]] 已承认 `/sprint` 无宿主进程，max-iter 天花板只能靠「协议 + 持久化 + 可见打印」，**模型必须自愿调用才生效**。

对比 [agent-orchestrator.js](../../scripts/agent-orchestrator.js) 的 `pipeline.js:472` 是真 Node `for` 循环、`maxIterations=32` 进程强制。**系统有能力做进程级强制，但价值最高的主力工作流（sprint）刻意停在协议层。** 缺陷不是「做不到」，而是「价值兑现链路被留在了最脆弱的载体上」。

**2. 价值兑现链路的实测信号已亮红灯——且系统连「退化」都测不到。**

本会话 SessionStart 注入统计：`context=11994/12000 chars; sections=4/6; truncated=近期会话, 项目本能, 全局本能`——6 个知识 section 只塞下 4 个。

更关键：现有 telemetry 的 `hit_rate` **不是「召回内容被用上的比率」**，而是 `indexed_entries / total_entries`（[test-memory-recall-telemetry.js:77](../../scripts/test-memory-recall-telemetry.js#L77)：total=3, indexed=1 → 0.3333）。即**供给侧覆盖率**（塞了多少进 12KB 索引），**完全没有衡量需求侧**（注入的知识有没有被实际引用/遵守）。

→ **系统对「沉淀的经验是否真的改变了行为」零可观测性。** 复利的前提是「上次经验这次被用上」，但这个「被用上」既无强制、也无信号。

**3. agentic 趋势精确打击这条链路。**

| agentic 趋势 | 对「靠模型自觉」链路的侵蚀 |
|---|---|
| 更长自主循环（`--goal --auto`、background agent） | 链路越长，模型「记得读协议并遵守」概率越低；[[ADR-021]] max-iter 只是协议天花板，自主链路更易被悄悄跳过 |
| 更频繁上下文压缩（/compact） | 压缩丢掉的正是注入的本能/约定；靠 frontmatter 重读兜底，但**重读本身也是无强制的协议要求** |
| 更多并行 subagent | 子 agent 不继承主循环 gate 纪律（[[feedback_workflow_agents_must_not_git_write]] 是活案例）；纪律不随 fan-out 传播 |

### 次级缺陷（对比维度，非「最大」）

| # | 缺陷 | 严重度 | 真缺陷 vs 设计代价 |
|---|---|---|---|
| B | **被动注入 vs 主动检索**：核心靠 SessionStart 推送（命中率仅供给侧）；虽有 MCP memory 5 工具 + prompt-recall，但 agent 主动按需检索非主路径 | 高 | 半缺陷——趋势是 agent 主动 RAG |
| C | **同源验证盲区**：review 5 视角是同一模型扮不同角色（Claude Code 下 spawn 独立 context subagent 缓解，但权重同源）；真 ground-truth 只有可选的 `--until` + 测试 | 中高 | 真缺陷——异构验证撞轻量 |
| D | **80/20 规划假设遇上「执行趋近免费」**：核心是 80% 规划审查；agentic 让并行试错成本→0，「重规划 1 方案」vs「并行跑 3 方案选优」ROI 在反转，两道人工 gate 在快试错场景成摩擦 | 中 | 哲学层——需重审，非 bug |
| E | **知识抗腐化机制弱**：[[documented-claim-vs-code-reality-drift]] 是高频回归源；除本能衰减外，缺乏对 rules/solutions/ADR 的「代码现实校验」回路 | 中 | 真缺陷 |

### 诚实标注：缺陷 A 是「4 不可妥协」的固有代价

A 很大程度是轻量 + 确定性 + parity + Obsidian（[[ADR-011]]）的代价。引入进程级强制会直接撞「轻量优先」。**「修」不一定对**——更可能是「显式接受代价 + 在最痛的少数环节选择性下沉可观测性」（延续 [[ADR-013]] 路线），而非推翻架构。「什么都不做」是合法选项。

---

## 技术方案

<!-- Phase 2 Plan 产出（架构师视角）。聚焦缺陷 A。 -->

### 入场扫描 — Invariants 继承

| 子系统 | 既有 invariant | 本 sprint 如何保持 |
|--------|----------------|--------------------|
| Memory v5 telemetry | recall metric 只记聚合计数、**不含 body 文本**（脱敏，[test:80-81](../../scripts/test-memory-recall-telemetry.js#L80)） | demand-side 字段同样只记计数 + topic 名，递归 `redactDeep` |
| hook 退出码 | runtime hook 内部错误 fail-open exit 0 + stderr marker（[[rules/hook-exit-codes]]） | 新增逻辑包 try-catch，沿用 `[evaluate]`/`[inject-context]` marker |
| 双 runtime parity | scripts/lib/* 经 build glob 进 plugin 副本（[[ADR-020]] 勘误后：按消费方目录分别填充） | 新 lib 进 `copyHookLibs` 路径；validator 闭包护栏覆盖 |

### 入场扫描 — 集成路径声明

| 改动点 | 触发动作 | 中间层 | 持久化 | 消费点（刷新后可见） |
|--------|----------|--------|--------|----------------------|
| injected manifest | SessionStart inject-context | 写 session-scoped sidecar | `telemetry/injected-<session>.json` | Stop hook 读取 |
| demand-side usage 信号 | Stop evaluate-session | 启发式匹配 observations vs manifest | `telemetry/recall-usage.jsonl`（独立于供给侧 `memory-recall.jsonl`） | cost summary + `/review-learnings --recall` |

> ✅ **集成已收口**：demand-side 信号接入 SessionStart 高频 cost summary + `/review-learnings --recall` 低频审计，避免只写 telemetry 无人消费（[[feedback_enforcement_dead_on_arrival_82pct]]）。

### 入场扫描 — 半完成债务清单

| 来源 | 议题 | 本 sprint 决策 |
|------|------|----------------|
| [[ADR-021]] | `sprint-goal.js` 确定性 helper | 仍 deferred（与本 sprint 无关，不激活） |
| 本 sprint | 基于 demand-side 信号的任何 enforcement | **明确推迟**：measure 阶段先攒数据证价值，enforcement 另开 sprint（deadline 见 frontmatter） |

### 关键假设验证（[[ADR-012]]）

| 假设 | 验证 | 可信度 |
|------|------|--------|
| 「hit_rate 测召回有用性」 | **证伪** → 实为 `indexed_entries/total_entries` 供给侧覆盖率（[memory-v5 / test:77](../../scripts/test-memory-recall-telemetry.js#L77)） | 已读代码，高 |
| telemetry 设施已存在可复用 | ✅ `buildMemoryRecallMetric/recordMemoryRecallMetric/writeMemoryRecallMetric` in [memory-v5.js](../../scripts/lib/memory-v5.js)，写 `telemetry/memory-recall.jsonl`，已脱敏 | 已读，高 |
| Stop hook 能拿本会话数据 | ✅ `readSessionObservations` 按 `session_id` 过滤（[evaluate-session.js:89](../../scripts/evaluate-session.js#L89)） | 已读，高 |
| observations 含「语义遵守」信号 | **证伪** → 只有工具调用（命令/文件/错误），无「引用了哪条 instinct」。demand-side 只能启发式近似（A2 内核） | 已读，高 |

### 方案概述

缺陷 A 分两层，分别处置：

- **A1（可测外围）**：知识「供给」有统计、「需求/使用」无统计。→ 用**启发式 demand-side telemetry** 缓解。measure-before-enforce：先让「注入的知识有没有被用」从零信号变成粗粒度可观测，足以检测「某 topic 注入几十次但从无匹配行为 = 沉睡知识」这类退化。
- **A2（不可消除内核）**：「模型是否语义遵守了注入纪律」是语义判断，无 exit code，hook 看不到（[[ADR-017]] 边界）。→ **显式接受**为 model-driven + 4 不可妥协的固有代价，写入 ADR，停止假装能修。

**本 sprint = 攻 A1 的最小动作 + 显式接受 A2。零 enforcement。**

### 候选动作排序

| 候选 | 描述 | ROI（5 年杠杆） | 选定 |
|------|------|----------------|------|
| 1 | demand-side usage telemetry（启发式）+ 接入消费点 | 高：一旦能测「知识是否有用」，未来所有「该不该保留这条经验」决策有据 | ✅ 主 |
| 2 | phase/checklist 执行结构化留痕 | 低：自报告仍靠模型自愿写（[[ADR-021]] voluntary-call gap），易 dead-on-arrival | ❌ |
| 3 | 只写 ADR 接受 A，不做任何测量 | 中：认知清晰但放弃 A1 可缓解部分 | ⭐ baseline |

### 任务拆解

> 标记 `[P]` 可并行。本 sprint 偏小（measure-only）。

- [x] **Task 1**: SessionStart 写 injected manifest（注入的 instinct domain 集合 + 计数，脱敏，总写 latest 兜底） — 文件: `scripts/inject-context.js` + 新 lib `scripts/lib/recall-usage.js` — 风险: L2
- [x] **Task 2**: Stop hook 读 manifest + 本会话 observations，宽松 `inferSessionDomains` 算 demand-side usage（独立 `recall-usage.jsonl`，不污染供给侧） — 文件: `scripts/evaluate-session.js` + `scripts/lib/recall-usage.js` — 风险: L3
- [x] **Task 3 [P]**: demand-side 信号接入消费点 — cost summary（prior-session 行）+ `/review-learnings --recall`（**实施中改 retrospective→review-learnings**：retrospective 是项目级模板无 propagate，review-learnings 走标准 propagate 零漂移） — 文件: `scripts/inject-context.js` + `user-level/commands/review-learnings.md` — 风险: L2
- [x] **Task 4 [P]**: 测试 `test-recall-usage.js` 21 单测（启发式/边界/脱敏/fail-open/MCP 主动检索，run-tests auto-discover）+ 双 runtime parity（build + validate + 闭包护栏） — 文件: `scripts/test-recall-usage.js` — 风险: L2
- [x] **Task 5**: 文档同步——ADR-022（A1/A2 分层 + measure-before-enforce）+ README 知识层（Hook 表 + 目录结构）+ 本 plan — 文件: `.claude/rules/architecture.md` + `README.md` — 风险: L1

### 测试策略

- 单元：启发式匹配函数（命中/未命中/大小写/路径切分）；脱敏断言（序列化不含 body）；fail-open（无 manifest / 损坏 jsonl）。
- 集成：真 repo 跑 inject→evaluate 闭环，断言 telemetry 写入且无 stderr marker。
- parity：`build-codex-plugin.js` + `validate-codex-plugin.js` + 闭包护栏（新 lib 进 plugin scripts/lib）。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 启发式假阴性（用了知识但无匹配命令） | 高 | demand-side 偏低估 | 明确定位为「粗粒度退化探测」，非精确度量；文档写清上限 |
| 信号无人消费 → dead-on-arrival | 中 | 白做 | Task 3 强制收口到已有消费点，否则不做 |
| 过早演化为 enforcement | 中 | 撞 [[ADR-021]]/[[feedback_enforcement_dead_on_arrival_82pct]] | 本 sprint 锁死 measure-only；enforcement 写入 deferred |
| telemetry 泄露 body | 低 | 隐私 | 沿用 recall metric 的脱敏不变量 + 递归 redactDeep |

### 涉及文件

- `scripts/inject-context.js`（写 manifest + 可选 cost summary 消费）
- `scripts/evaluate-session.js`（Stop 读 manifest + 匹配）
- `scripts/lib/recall-usage.js`（新，启发式匹配）+ 测试
- `user-level/commands/review-learnings.md`（`--recall` 消费点）
- `.claude/rules/architecture.md`（新 ADR：A1/A2 分层决策）
- `README.md`（知识层 telemetry 说明）

---

## 实现进度

<!-- Phase 3 Work 阶段更新 -->

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-06-01 | Task 1 | `inject-context.js` 写 injected manifest（注入 instinct domain + 计数 → `telemetry/injected-<sid>.json`，总写 `injected-latest.json` 兜底）；回归 4+7+13 测试全过 |
| 2026-06-01 | Task 2 | 新 lib `recall-usage.js`（宽松 `inferSessionDomains` + `computeDemandSideUsage` + 递归脱敏 metric）；`evaluate-session.js` Stop 读 manifest 算 usage 写 `recall-usage.jsonl`；端到端验证 `3/4 domain 75% 沉睡:security` |
| 2026-06-01 | Task 3 | 消费点：cost summary 加 prior-session demand-side 行；`review-learnings` 加 `--recall` 审计模式（改自 retrospective，避开项目级模板无 propagate 的漂移风险）；propagate+build+validate 全过 |
| 2026-06-01 | Task 4 | `test-recall-usage.js` 21 单测全过，run-tests auto-discover（21/21）；double-runtime parity build+validate+闭包护栏 ✓ |
| 2026-06-01 | Task 5 | ADR-022（A1/A2 分层）+ README（Hook 表 SessionStart/Stop + 目录结构 telemetry/）+ 本 plan 变更日志 |
| 2026-06-01 | 收尾 | 成功标准、持久化路径、测试数字、次级缺陷状态回写；全量验证通过 |

---

## 审查结果

### P0 — 必须修复
无。

### P1 — 建议修复
无。

### P2 — 可选优化
| # | 视角 | 位置 | 问题 | 状态 |
|---|------|------|------|------|
| 1 | 性能 | `recall-usage.jsonl` | append 无归档（同既有 `memory-recall.jsonl`，长期到 MB 级，`readLatestRecallUsage` 读全文 split） | follow-up（与 memory-recall.jsonl 一起纳入归档） |
| 2 | 测试 | `test-inject-context-cost-summary.js` | cost summary 的 demand-side line 无专项单测 | ✅ 已补 2 case（shown/not-leak） |

### 第 6 视角 — 集成连续性
- invariant 保持：脱敏（redactDeep）/ hook fail-open（exit 0 + marker）/ 双 runtime parity（recall-usage.js 进 hooks+mcp+scripts/lib，validate 闭包护栏过）/ 供给侧 `memory-recall.jsonl` 未动 ✓
- 无 dead code：recall-usage.js 全部 export 被 inject/evaluate 消费；mcp/scripts 的 lib 副本是 [[ADR-020]] 全量复制 parity（非 dead）✓
- 闭环完整：manifest 写 → Stop 算 usage → cost summary + `--recall` 消费，无半成品中间状态 ✓
- A2 显式接受、enforcement deferred，无"半下沉漂移" ✓

### 总评
measure-only A1 缓解，零 enforcement，闭环完整。无 P0/P1；2 个 P2 中 1 已补、1 follow-up（归档，与既有 telemetry 同步处理）。`test-recall-usage.js` 21 单测、全量 `run-tests` 21/21、端到端、双 runtime parity、plugin validate、pre-commit 全过。

### 次级缺陷收口状态

详见 [secondary-defects-roadmap](./2026-06-01-secondary-defects-roadmap.md)：B（MCP 主动检索 measure）/ D（规划深度 rule）/ E（知识 drift checker）已落地；C 拆为 C1/C2 后降级，C2 撞 ADR-021 天花板暂缓，C1 等 agent-loop 用量信号。

---

## 复利记录

### 提取的经验
1. **demand-side vs supply-side telemetry**：度量"注入了多少"（`indexed/total`）≠"被用了多少"。任何注入/RAG/memory 系统的有用性必须独立度量需求侧，否则供给侧覆盖率会被误读为"知识在起作用"。
2. **measure-before-enforce**：给未证机制先建度量、后决定是否下沉 enforcement——是 [[ADR-013]] mechanism-over-discipline 的**前提**（无数据的 enforcement 是盲下沉，撞 [[feedback_enforcement_dead_on_arrival_82pct]]）。
3. **plan 阶段消费点的文件路径/propagate 归属必须验证**（[[ADR-012]] 具体应用）：plan 假设 retrospective 是普通 command，实施才发现是项目级模板无 propagate → 改 review-learnings。consumer 文件的同步机制是 load-bearing 假设。
4. **model-driven 链路的确定性边界第三类**：能 hook 自动派生的是"工具调用 + 启发式 domain"；"模型有没有语义遵守"测不到（A2，[[ADR-017]] 延伸）。

### 创建/更新的本能
- ADR-022（A1/A2 缺陷分层 + measure-before-enforce）写入 `.claude/rules/architecture.md`
- 新 memory：`feedback_supply_vs_demand_telemetry`（measure-before-enforce 角度并入既有 [[feedback_unproven_protocol_rollback_before_enforcement]]，按 memory 去重规则不重复建）

### 解决方案文档
- `docs/solutions/2026-06-01-demand-side-recall-telemetry.md`
