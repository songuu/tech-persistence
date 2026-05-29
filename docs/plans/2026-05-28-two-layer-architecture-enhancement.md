---
title: "编码流层 + 自进化层架构增强设计（基于 2026 市面 gap）"
type: design
status: implemented
created: "2026-05-28"
updated: "2026-05-28"
tags: [design, architecture, agent-orchestration, self-evolution, proposed]
aliases: ["两层架构增强", "coding-flow + self-evolution enhancement"]
---

# 编码流层 + 自进化层架构增强设计

> **来源**：[[2026-05-28-market-architecture-gap-analysis]] 的 6 个真差距（编码流 3 + 自进化 3）。
> **status: proposed** —— 仅设计提案，未实施、未 review。真正开工前按 `/sprint` 流程冻结。
> **现状均已勘察**（[[ADR-012]]）：`review.md` / `think.md` / `skill-improve.md` / `skill-eval.md` / `skill-publish.md` / [[ARCHITECTURE_ISSUES]]。

---

## 设计总原则（贯穿 6 个增强）

所有增强必须同时满足，否则降级或放弃：

1. **纯文件增强**：新增能力 = 新增 markdown/jsonl artifact 或扩展现有 schema，**不引入 server/DB/向量库/双向 runtime 通道**。
2. **复用现有基建**：优先扩展 `skill-signals` jsonl / `skill-evals` 目录 / `pre-commit-check.js` enforcement / orchestrator artifact / review spawn 协议，不造新子系统。
3. **强化而非削弱 identity**：每个增强对 4 不可妥协（parity / 确定性 / 轻量 / Obsidian）逐条校验；理想增强应**强化**某条原则（如基线护栏下沉强化确定性、trace-based eval 强化 eval 隔离护城河）。
4. **保留人工 gate**：自动化回路（grader-revise / clarification ruling）默认有人工 gate，仅 `--auto` 模式下按 [[ADR-009]] 风险矩阵自主放行。

核心论点（印证 gap 分析元结论 1）：**这 6 个差距都是「同一条路线未走完的格子」，不是「路线错了」——补齐全部用纯文件增量，零新依赖。**

---

## 关键假设验证（ADR-012）

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| A1 可以复用 `/think`，不需要新增独立 clarify 命令 | Read `user-level/commands/think.md` | 现有 think 已有「需求澄清」与「3-5 个可验证验收条件」；增强点应是结构化验收与可选 clarify 子步，不是新命令 |
| A2 是在现有 review 契约上叠加，而非替换 review 流程 | Read `user-level/commands/review.md` | 已有 reviewer status 契约、NEEDS_CONTEXT retry 硬限、BLOCKED 人工 gate、Gap Detection Walkthrough；缺口是 rubric fail 后的有限 revise loop |
| A3 应走纯文件 clarification artifact，不引入 runtime 双向通道 | Read `docs/architecture/ARCHITECTURE_ISSUES.md` | agent-loop 已有 contract revision/`accept-revision` 方向；保持 frozen spec + append-only ruling 更符合 TP 轻量、确定性、Obsidian 约束 |
| B1/B2/B3 都能复用现有 skill 自迭代链路 | Read `user-level/commands/skill-improve.md`、`user-level/commands/skill-eval.md`、`user-level/commands/skill-publish.md` | improve 已读诊断报告和信号文件，eval 已有测试集与结果归档，publish 已有 eval>=baseline 协议；新增 trace 字段、trace→eval、baseline enforcement 都是补齐链路，不是重建系统 |

---

## Part A：编码流层（/sprint + agent-loop）

### A1. clarify 阶段强化（think 层）

> **✅ 已实现（2026-05-28）**：见 [[2026-05-28-a1-clarify-enhancement]]。落地与设计一致（无假设推翻——勘察证设计现状描述准确）：think.md 步骤 3 升级 EARS-lite（L3+ 强制 / L0-L2 可选）+ 新增可选执行步骤 1.5「需求澄清扫描」（`--clarify` 触发，扫描 输入边界/失败模式/空状态）。纯文档零依赖，4 副本经 propagate+build 同步。

- **现状**（勘察 `think.md`）：步骤 1「需求澄清」（"答案不明显才问"）+ 步骤 3「3-5 个可验证验收条件」。已有验收意识。
- **差距**：澄清是轻量被动（不主动系统扫描欠定义点）；验收条件非结构化格式，欠定义会拖到 plan 才暴露（[[ADR-012]] 已记录同类 plan-error 教训）。
- **设计**：
  1. think 产物验收条件升级为 **EARS-lite** 格式：`WHEN <触发条件> THE SYSTEM SHALL <可观测行为>`（保留中文，仅借结构）。
  2. 新增**可选** `/think --clarify` 子步：系统扫描并列出所有未定义的 输入边界 / 失败模式 / 空状态，逐条要求确认（对标 spec-kit `/clarify`，但内联进 think，不新增命令）。
- **4 原则校验**：parity（think.md 双 runtime 同步）✓ / 确定性（验收可验证）✓ / 轻量（纯文档、零依赖）✓ / Obsidian（markdown）✓
- **复用**：`think.md` 现有步骤 2/3 + sprint Phase 1
- **风险**：EARS-lite 可能对小任务过重 → 限定 L3+ 任务强制，L0-L2 可选。

### A2. grader-revise 收敛闭环（review 层）

> **✅ 已实现（2026-05-28）**：见 [[2026-05-28-a2-grader-revise-loop]]。落地与设计一致（A1 后第二次无假设推翻——勘察证 review.md 现状描述准确）：review.md 新增「Rubric-gated revise loop」段（结构化 pass/fail-per-criterion + P0>0 触发 work 微循环 + 仅重 spawn 受影响视角 + N=2 硬限 + L3+/--auto 门控 + 非-auto P0 人工 gate + BLOCKED 不被吞）。纯文档零依赖，4 副本经 propagate+build 同步。设计文档 6 增强全部落地。

- **现状**（勘察 `review.md`）：成熟多视角 spawn（risk-aware dispatch + 4 status 契约 + Gap Detection Walkthrough + 模型分层）。已有 `NEEDS_CONTEXT` retry（≤1）+ `BLOCKED` escalation。
- **差距**：retry 只针对「context 不足」，**没有「质量分数 < 阈值 → 自动回 work 修 → 重审」的收敛回路**。review 是单遍。对标 Claude Agent SDK Outcomes（rubric + 独立 grader 打回重做）。
- **设计**：在现有 status 契约上叠加**可选 rubric-gated revise loop**：
  1. reviewer 输出已有 P0/P1/P2 + Gap Walkthrough → 扩展为结构化 `pass/fail-per-criterion`。
  2. 若 P0 数 > 0（或 rubric 关键项 fail）→ 自动触发一次 work 微循环修复 → **仅重 spawn 受影响视角** reviewer。
  3. **revise 轮数硬限 N=2**（类比 NEEDS_CONTEXT ≤1，防死循环）；收敛或达上限才进 compound。
- **4 原则校验**：parity（review spawn 协议双 runtime，inline fallback 串行）✓ / 确定性（轮数硬限 N）✓ / 轻量（复用 spawn + status 契约，零新组件）✓ / Obsidian ✓ / **人工 gate**：非 `--auto` 时 P0 仍问用户，revise loop 仅在 `--auto` 自动迭代 ✓
- **复用**：`review.md` spawn 协议 + `work.md` + sprint Phase 3↔4
- **风险**：revise loop × 重 spawn = token 成本上升 → 仅 L3+ 或 `--auto` 触发；L0-L2 保持单遍。

### A3. clarification channel（agent-loop 层）

> **✅ 已实现（2026-05-28）**：见 [[2026-05-28-clarification-channel]]（[[ADR-018]]）。落地推翻设计 1 假设：「复用现有 contract-revision」在 classic 模式不成立——contract-revision/accept-revision 只在 pipeline 模式；classic 的「修正 spec」等价回路是 review→needs-followup→resume re-implement。新 lib `scripts/lib/clarifications.js`（append-only `clarifications.md`）+ handoff/review schema 各加 1 可选字段 + orchestrator classic 路径 wiring；ruling=revise-spec 复用既有 needs-followup 回路，不碰 pipeline。

- **现状**（[[ARCHITECTURE_ISSUES]]）：agent-loop frozen spec 静态单向（Claude freeze → Codex 实现 → Claude review）。已有 contract-revision（问题 13 `accept-revision`）。
- **差距**：implementer 执行中遇 spec 歧义无法回问 spec-writer，只能整轮重跑（对标 Codex v2 结构化 inter-agent messaging，但那需 runtime 双向通道）。
- **设计**：frozen spec artifact 旁加 **`clarifications.md`（append-only）**：
  1. implementer（Codex）遇歧义 → 写一条 question entry（标记当前假设，**不阻塞**，继续实现）。
  2. 下一个 orchestrator gate（resume/review）→ spec-writer（Claude）读 clarifications.md，对每条追加 ruling（确认假设 / 修正 spec）。
  3. ruling 若修正 spec → 走现有 contract-revision 流程（问题 13 已部分实现）。
- **4 原则校验**：parity（orchestrator artifact 双 runtime）✓ / 确定性（append-only markdown）✓ / 轻量（纯文件，**刻意不引入双向 runtime 通道**——那会违反"非 runtime"定位 + 轻量）✓ / Obsidian ✓
- **复用**：orchestrator 现有 artifact 机制 + contract-revision
- **风险**：异步 ruling 比实时双向慢一拍，但符合 TP「批处理而非实时」哲学，可接受。

---

## Part B：自进化层（skill 自迭代 + 本能）

### B1. trace-aware 反思（skill-improve 层，GEPA 内核）

> **✅ 已实现（2026-05-28）**：见 [[2026-05-28-skill-trace-aware-reflection]]。按数据依赖在 B2 之前实施（ROI 排序倒置）。落地偏差：设计文档"扩展现有 steps_skipped/corrections/duration"建立在错误现状描述上——勘察证 signal jsonl 只有 calls 计数，那些字段是 doc drift。trace 改存独立 `skill-traces/{name}.jsonl`（不污染 calls 聚合），数据源用现成 observations.jsonl（双层脱敏），diagnose 半自动提取 + 人工 gate（[[ADR-017]]）。

- **现状**（勘察 `skill-improve.md`）：基于诊断报告（跳过率/使用率/纠正模式）生成 5 类提案（合并/降级/吸收本能/精简/拆分）。
- **差距**：信号是**聚合统计**，不含单次执行的完整失败 trace；improve 不读"为什么失败"做反思。对标 GEPA（读 trace 自然语言反思而非塌缩成标量分）。
- **设计**：
  1. 扩展 `skill-signals/{name}.jsonl` schema：现有 `steps_skipped/corrections/duration` + 新增 `failure_step / error_excerpt / correction_diff`。
  2. `skill-improve` prompt 增加「基于这段 trace 做根因反思」环节（GEPA reflective mutation 内核：读 trace → 自然语言诊断 → 定向改 prompt）。
- **4 原则校验**：parity（signal jsonl 双 runtime hook 都记）✓ / 确定性（jsonl 纯文件；反思产物是可 diff skill 文本）✓ / 轻量（扩展现有 schema，**刻意不引入 GEPA 的 Pareto 自动搜索**——保持人工 gate + 轻量）✓ / Obsidian（skill 是 markdown）✓
- **复用**：`skill-signals` jsonl + `skill-improve` + `skill-diagnose`
- **风险**：trace 可能含敏感信息 → 复用现有 observe.js 脱敏管线（PreToolUse 已脱敏）。

### B2. trace → eval 自动沉淀（skill-eval 层）

> **✅ 已实现（2026-05-28）**：见 [[2026-05-28-trace-to-eval]]（[[ADR-019]]）。落地推翻设计 2 假设：(1)「从 signal jsonl 里 corrections」——signal record 无 corrections 字段，真实数据源是 B1 的 `skill-traces/{name}.jsonl`；(2) eval case 此前无结构化格式（同 B3 前置缺口）。新建 `skill-evals/{name}/cases/cases.jsonl`（与 B3 results.jsonl 同构）+ `scripts/lib/skill-eval-cases.js` + CLI；护城河靠 `addCase` 的 provenance 写入即拒绝 gate（非 trace 来源 / 缺 source_trace / 缺 --from-trace → exit 2）+ 双层脱敏。traces/cases/results 构成 skill-evals 数据三角。

- **现状**（勘察 `skill-eval.md`）：eval 集手工写，或"基于当前 skill 自动生成 3-5 用例"。安全规则「eval 不可被 skill 修改」已存在（护城河）。
- **差距**：eval 集不从真实 use trace 沉淀（覆盖滞后）；自动生成的用例与 skill **同源**（自己出题给自己考）。
- **设计**：从 signal jsonl 里「corrections 发生的真实输入」半自动转 eval case（真实失败 = 最有价值测试），人工确认 gate。
- **4 原则校验**：parity ✓ / 确定性（eval case 文件 + 人工 gate）✓ / 轻量（复用 `skill-evals` 目录）✓ / Obsidian ✓ / **护城河强化**：eval case 来自真实使用 trace 而非 skill 自产，**比现状更隔离**——这是设计原则 3"强化 identity"的最佳样本。
- **复用**：`skill-signals` + `skill-evals/{name}/`
- **风险**：真实输入可能不可复现（依赖外部状态）→ 转 case 时快照必要上下文。

### B3. 基线护栏下沉 enforcement（skill-publish 层，[[ADR-013]] 活案例）

> **✅ 已实现（2026-05-28）**：见 [[2026-05-28-skill-publish-baseline-guard]]。落地与原设计两处偏差：(1) enforcement 入口不是 `pre-commit-check`（publish 改 runtime 目录不产生 git commit），改为 publish 流程内调用的独立 guard CLI；(2) 先补齐缺失的结构化 eval-result 格式（`scripts/lib/skill-eval-results.js`），guard 才有可比对基线。record + guard 合并为单 CLI `scripts/skill-eval-results.js`。

- **现状**（勘察 `skill-publish.md`）：协议**已要求** "eval 通过率≥当前版本才能发布"（步骤 1 + 安全段），但靠模型执行命令时遵守。
- **差距**：**停留文档协议层，未下沉为确定性 enforcement**——无脚本强制 block 退化发布。这正是 [[ADR-013]] mechanism-over-discipline 描述的 3 失效模式（遗忘/省略/漂移）的活靶子。
- **设计**：publish 路径加确定性检查（复用 `scripts/pre-commit-check.js` 模式）：
  1. 读 `skill-evals/{name}/results/` 最新两版通过率，新版 < 旧版 → `exit 2` 拒绝。
  2. 3 层 fail-open（用户 `--no-verify` / try-catch / node 缺失兜底，与现有 pre-commit-check 一致）。
  3. 配 smoke：pass / break-test（造退化必 fail）/ break-impl / fail-open marker 四类（[[ADR-013]]§B + [[feedback_negative_sample_3_archs]]）。
- **4 原则校验**：parity（脚本双 runtime 跑）✓ / 确定性（脚本强制，**强化原则 2**）✓ / 轻量（复用现成 enforcement 模式）✓ / Obsidian（结果 markdown/json）✓
- **复用**：`scripts/pre-commit-check.js` enforcement 模式 + [[ADR-013]] 框架
- **风险**：eval 通过率不稳定（flaky）会误拒 → 加 tolerance 阈值或多次取中位。

---

## 落地优先级（ROI，仅建议）

| # | 增强 | 层 | ROI 理由 | 风险 |
|---|------|----|---------|------|
| 1 | **B3 基线护栏下沉** | 自进化 | 协议已写、纯加 enforcement，复用现成模式，[[ADR-013]] 教科书案例 | 最低（flaky 可控） |
| 2 | **B2 trace→eval** | 自进化 | 强化护城河，复用现有目录 | 低（快照上下文） |
| 3 | **A3 clarification channel** | 编码流 | 纯文件解 agent-loop 整轮重跑痛点 | 中（与 contract-revision 集成） |
| 4 | **B1 trace 反思** | 自进化 | 提升 improve 质量，需扩 jsonl schema | 中（脱敏） |
| 5 | **A1 clarify 强化** | 编码流 | 减少 plan-error，纯文档 | 低 |
| 6 | **A2 grader-revise loop** | 编码流 | 价值高但 token 成本 + 复杂度最高 | 高（死循环防护、成本） |

建议先做 B3+B2（自进化层，ROI 高、风险低、强化护城河），观察后再评估编码流层。

---

## Related

- [[2026-05-28-market-architecture-gap-analysis]] — 本设计的差距来源
- [[2026-05-28-evolution-overview]] — 架构演进全景
- [[ADR-013]] — mechanism over discipline（B3 框架）
- [[ADR-009]] — --auto 决策矩阵（A2 人工 gate 边界）
- [[ADR-012]] — plan 必须勘察（本设计现状均已勘察）
- [[ARCHITECTURE_ISSUES]] — agent-loop 深层缺陷（A3 contract-revision 基础）

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-05-28 | 初版：6 个增强设计（编码流 3 + 自进化 3），均经现状勘察 + 4 原则校验。status: proposed |
| 2026-05-28 | B3 基线护栏下沉已实现（[[2026-05-28-skill-publish-baseline-guard]]）；勘察推翻原设计 2 假设（pre-commit 入口 + result 已有格式），修正为独立 guard CLI + 补结构化 eval-result。剩余 5 增强仍 proposed |
| 2026-05-28 | B1 trace-aware 反思已实现（[[2026-05-28-skill-trace-aware-reflection]]）；按数据依赖在 B2 之前做；勘察证 signal schema 是 doc drift（只有 calls），trace 存独立 skill-traces/ + observations 数据源 + 双层脱敏。B2 解除阻塞。剩余 4 增强（A1/A2/A3/B2）proposed |
| 2026-05-28 | A1 clarify 强化已实现（[[2026-05-28-a1-clarify-enhancement]]）；落地与设计一致无假设推翻；think.md 步骤 3 EARS-lite（L3+ 强制）+ 可选步骤 1.5 澄清扫描（`--clarify`）。剩余 3 增强（A2/A3/B2）proposed |
| 2026-05-28 | B2 trace→eval 自动沉淀已实现（[[2026-05-28-trace-to-eval]]，[[ADR-019]]）；勘察推翻 2 假设（数据源是 skill-traces 非 signal jsonl + eval case 无结构化格式）；新 `skill-evals/{name}/cases/cases.jsonl` + provenance 写入即拒绝 gate + 双层脱敏，构成 traces/cases/results 数据三角。剩余 A2/A3 proposed |
| 2026-05-28 | A3 clarification channel 已实现（[[2026-05-28-clarification-channel]]，[[ADR-018]]）；勘察推翻「复用 contract-revision」假设（那是 pipeline-only，classic 复用 needs-followup 回路）；新 `scripts/lib/clarifications.js`（append-only）+ handoff/review schema 各 1 可选字段 + orchestrator classic wiring。剩余 A2 proposed |
| 2026-05-28 | A2 grader-revise 收敛闭环已实现（[[2026-05-28-a2-grader-revise-loop]]）；落地与设计一致无假设推翻；review.md 新增「Rubric-gated revise loop」段（N=2 硬限 + L3+/--auto 门控 + 非-auto P0 人工 gate + BLOCKED 不被吞）。**设计文档 6 增强（A1/A2/A3/B1/B2/B3）全部落地**，status → implemented |
| 2026-05-29 | **审计修正（parity 断裂 P0/P1）**：实现完整性复查发现 A3/B1/B2/B3 的 `parity ✓` 不准确——Codex plugin 4 个 utility 脚本（含 A3 改动的既有 `agent-orchestrator.js`）运行时 `Cannot find module './lib/...'`。根因：`build-codex-plugin.js` 的 `copyHookLibs` 只填 `hooks/lib`+`mcp/lib`，从不填 plugin `scripts/lib`；而 utility 脚本的 `require('./lib/*')` 相对自身解析到 `scripts/lib`。A3 给 agent-orchestrator 引入**首个** `./lib` 依赖（此前零）是 P0 回归点。修复：(1) `copyUtilityScripts` 末尾 `copyHookLibs(scripts)` 填充 plugin `scripts/lib`；(2) `validate-codex-plugin.js` 对 utility 脚本加 `validateLocalRequireClosure` 护栏（ADR-013，含 break-impl 负样本验证）；(3) 勘误 ADR-016/017/018/019 的「lib 经 copyHookLibs glob 自动复制」假设 → 见 [[ADR-020]]。修复后 parity 真正满足。 |
| 2026-05-29 | **B3 guard 文案修复**：负样本实跑（造退化 eval → guard）暴露 `skill-eval-results.js` 的 PASS 行在「容差放行」场景硬编码 `≥ 旧版`，打印成 `60.0% ≥ 旧版 90.0%`（字面失真；exit code 行为正确，纯展示瑕疵）。修复：CLI `runGuard` 区分两种 PASS——`curr<prev`（容差吸收降幅）如实打印「降幅在容差 N% 内，放行」，仅 `curr≥prev` 才用 `≥ 旧版`。附 spawnSync 回归断言（容差场景断言 stdout 不含 `≥ 旧版` 且含「容差」）。build+validate+pre-commit+19 测试全绿。 |
