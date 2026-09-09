---
title: "Superpowers v6.3 Spec 与 Brainstorming 聚焦复评"
date: "2026-09-09"
updated: "2026-09-09"
status: completed
type: sibling-eval
source_repo: "https://github.com/obra/superpowers"
source_release: "v6.3.0"
source_commit: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797"
supersedes_focus_of: "docs/solutions/2026-09-04-superpowers-v63-eval.md"
tasks_total: 5
tasks_completed: 5
tags: [sibling-eval, superpowers, spec, brainstorming, think, plan]
---

# Superpowers v6.3 Spec 与 Brainstorming 聚焦复评

> 本文最初用于修正 2026-09-04 评估对 Spec/brainstorming 的低估；后续用户授权的收缩实施记录见 §6，不改变 SB6 等证据门。

## 0. Identity Question First

Tech Persistence 是 **developer-toolchain self-evolution sibling**。本轮不是引入完整 SDD，也不是新增一套 `/brainstorm` 命令，而是判断 `think -> plan -> work -> review` 如何更可靠地保留产品意图和设计 authority。

| 原则 | 聚焦要求 | Superpowers v6.3 | 本轮判断 |
|---|---|---|---|
| MR | Claude Code + Codex 同语义 | shared skill，多 harness 做过行为 eval | spine 可双 runtime 落地；TP 现有 Think 恰有持久化分叉 |
| DET | authority 不只靠模型记忆 | `Spec:` 仍是 prose pointer | pointer 本身 Partial；path + hash + coverage 校验后可 Pass |
| LT | 小任务不背固定文档税 | spike/bounded 不写 spec/plan | Pass；这是本轮最强适配点之一 |
| OBS | durable 设计可被 Markdown/frontmatter 检索 | architectural spec 是 Markdown | Pass；只保留架构路径，不复制临时 server |

## 关键假设验证

- 假设：Superpowers 的收益来自 artifact scaling 与稳定设计 authority，而不是三标签或双文件表面。验证：PR #2063/#2086 的行为结果分别隔离了路由成本与 spec-in-context；物理载体仍保持 P2 A/B。
- 假设：TP manual Sprint 存在机制缺口，但尚不足以直接建设 runtime。验证：agent-loop 已有 frozen spec/criterionIds，manual Plan 没有 lineage enforcement；仓库内实际事故率与 ROI 未知，因此 SB6 继续受本地 current-vs-treatment 阈值约束。
- 假设：低风险 pilot 可在不改变状态机的情况下落地。验证：实现明确保持活动 Sprint 的 `think -> plan` 状态边，只对独立 Think/Plan 缩放 artifact，并用双 runtime projection tests 验证。

## 1. Evidence Collection

### 1.1 上游事实

- 截至 2026-09-09，最新正式版仍为 v6.3.0（2026-08-12）。
- `brainstorming` 从单一路径改为三路：
  - **Spike**：只回答可行性问题；无 spec/plan，试验产物保持 throwaway。
  - **Bounded**：只适用于仓库里已有可读 flow 的小改；chat 内短设计，批准后直接正常实现；无 spec/plan 文件。
  - **Architectural**：新项目、新子系统、重组组件关系或改变消费者接口；问题澄清 → 2–3 个方案 → 分段设计 → design spec → writing plan。
- 路由有单向棘轮：隐藏复杂度只能升级路径，不能在任务中途静默降级。
- architectural spec 写入后执行四项 inline self-review：placeholder、内部一致性、scope、歧义；然后由用户审阅书面 spec，再进入 writing-plans。
- writing-plans 新增 `Spec:` 指针；执行 setup 读取 spec，以 spec 作为 plan 发生冲突时的上位 authority。

### 1.2 上游实证，而非只有 prose

- PR #2063 报告 65 次跨 harness live reps + 75 次分类 micro；旧路径在 bounded/architectural 上都固定生成两份文档。新路由的 bounded 样本 3/3 不再生成 spec/plan，architectural 3/3 保留双文档。
- 同一 PR 暴露了一次有价值的失败：初版 bounded 路由有 2/3 样本在得到批准前就开始改代码；增加明确 STOP 后复测为 3/3 先设计、获批、再 patch。说明“artifact 变轻”与“authority gate”是两个独立维度。
- PR #2086 的 seeded-incoherence eval：执行者只有 plan 时只能正确裁决 0–1/5 个跨模块冲突；spec 在场并被命名时达到 4–5/5，且在 Claude、GPT、Kimi、GLM 多模型上复现。
- v5.0.6 曾把 spec/plan 的 subagent review loop 改为 inline self-review：上游报告约 25 分钟额外开销而质量无可测改善；inline 检查约 30 秒并能发现 3–5 个问题。该结论只支持“默认 inline、按风险独立 review”，不证明所有独立 review 都无价值。
- issue #2079 **已验证的是一个上游案例**：旧单路径在一个规则小改上产出 3,061 行、14 commits、约 10 小时。结合 PR #2063 的 census，本文**推断** TP 也应让 artifact 成本随设计复杂度缩放；TP 的最佳分界仍需本地 fixture 验证。

### 1.3 TP 当前路径核验

| 维度 | 当前事实 | 缺口 |
|---|---|---|
| Codex Think | `codex-native/skills/think/SKILL.md` 已允许“小任务给出范围后直达 Work”，常规任务到 Plan，且默认不写文档 | 有轻重路由，但没有 spike/bounded/architectural 的可判定边界和单向升级规则 |
| Claude Think | `user-level/commands/think.md` 同时写着“持久化不可跳过”和“小于 30 分钟跳过 think 直接 plan” | 与 Codex 语义分叉；小任务反而可能绕到 Plan，而不是轻量直达 Work |
| Brainstorming | Think 只负责用户价值、范围、成功标准；Plan 才做技术方案 | 已验证缺少稳定 design-lineage 机制；TP 本地因此出错的频率与成本仍未知 |
| Sprint artifact | `docs/plans/TEMPLATE.md` 把需求分析、技术方案、任务、进度、review、compound 放在一个持续变更文件 | 轻量、OBS 好；但设计 authority 与可变任务计划没有冻结的逻辑边界 |
| Manual Plan | task 要求目标、文件、依赖、风险、完成证据 | task 不要求 criterion IDs，也不证明 acceptance/spec 每项都有 owner |
| Agent-loop | `spec.json` 同时有 requirementSpec、technicalDesign、taskBreakdown；freeze 后实施；task `criterionIds` 完整覆盖 acceptance contract | 已有强 spine，应复用，不应另造第二套 agent-loop spec |
| Sprint acceptance | plan marker 可绑定 frozen AcceptanceContract/Receipt | 能证明“做到了哪些 criterion”，但不等于保留“为何选择这个设计”的上位 spec |
| Review | Work/Review 读取活动 plan 或 frozen contract | architectural manual Sprint 尚无 source-spec freshness/readback gate |

### 1.4 Identity Matrix

| 维度 | Superpowers | Tech Persistence | 结论 |
|---|---|---|---|
| runtime | shared skill 适配多 harness | 双 runtime SoT + projection | 只改双方 SoT，不扩 harness |
| persistence | architectural spec + plan；小路径无文档 | 单 Sprint 文档 + agent-loop run artifacts | 先接受架构路径的双层逻辑 authority；物理双 artifact 仅作 P2 A/B，小路径保持零/单 artifact |
| determinism | prose pointer/read instruction | 已有 hash/CAS/criterionIds/Receipt 组件 | 将 pointer 本土化为可验证 lineage |
| privacy | spec 留在 repo；visual companion 可开 server | Markdown 本地优先 | 不引入 server/telemetry |
| surface | 单 `brainstorming` skill 内三路 | 已有 Think/Plan phase | 扩展 Think 路由，不新增 phase/command |
| scaling | artifact 随任务规模缩放 | risk-scaled planning 已存在 | 用多维判据校准 artifact 阈值，并补 upgrade ratchet；已有 flow 只作强证据 |
| business model | 通用 SDLC 方法论 | 自演进工具链 | 只抽 intent/spec authority spine |
| dependency surface | 纯文档机制，视觉能力另带 server | Node scripts + Markdown | 复用现有 hash/path/readback 安全形状与测试方法；是否新增 lineage validator 由本地基线触发 |

## 1.5 Runtime Path Verification

已实际读取或 grep：

- `codex-native/skills/think/SKILL.md`
- `user-level/commands/think.md`
- `codex-native/skills/{plan,work,review,sprint}/SKILL.md`
- `user-level/commands/{plan,work,review}.md`
- `docs/plans/TEMPLATE.md`
- `schemas/agent-loop/requirement-spec.schema.json`
- `scripts/agent-orchestrator.js`
- `scripts/lib/codex-sprint-acceptance.js`
- `.codex/project-standards.json` 与三个 active architecture rules

## 2. Candidate Plan

| ID | 候选 | MR/DET/LT/OBS | Surface / Spine | Landing place | 决策 |
|---|---|---|---|---|---|
| SB1 | Think 按设计复杂度缩放 artifact；可使用 probe/bounded/architectural 三标签 | P/Partial/P/P | Spine（标签是 Surface） | Claude `user-level/commands/think.md` + Codex `codex-native/skills/think/SKILL.md` | **P1**；标签与阈值由 fixture 校准，不硬抄 |
| SB2 | “仓库内已有 flow”作为 bounded 的强证据 | P/Partial/P/P | Spine | 两端 Think SoT | **P2 判据实验**；与设计歧义、消费者接口、耦合、可逆性、影响半径共同判断，不作必要条件 |
| SB3 | 隐藏复杂度只能升级；probe 产物若要保留必须重新分类 | P/Partial/P/P | Spine | 两端 Think SoT + behavior eval | **P1**；防止临时试验偷偷变生产实现 |
| SB4 | 冻结的 design authority 与可变 implementation plan 逻辑分层 | P/Partial/P/P | Spine | architectural Think/Plan 契约 | **P1 flip**；把 2026-09-04 对普通 Plan `Spec:` 的 cross-ref 判断改为 architectural manual Sprint 的 P1 机制缺口；不预判物理载体 |
| SB5 | 独立 `docs/specs/*.md` 与同一 Sprint 文档内冻结 design block 两种载体 | P/Partial/P/P | Surface | `docs/specs/TEMPLATE.md` 或 `docs/plans/TEMPLATE.md` | **P2 A/B**；上游未证明必须独立物理文件 |
| SB6 | versioned spec-lineage + digest + plan→work/review freshness gate | P/P/P/P | Spine | 条件触发的新独立 lineage parser/validator；不要耦合进 Harness 专用 `codex-sprint-acceptance.js` | **P2 conditional**；先取得 TP current-vs-treatment 基线，达到预注册阈值才实现 runtime gate |
| SB7 | canonical spec AC ↔ plan projection ↔ task criterion ownership | P/P/P/P | Spine | manual Sprint Markdown 语义契约 + 本地 fixture；复用 agent-loop `criterionIds` 语义和测试形状 | **P1**；先冻结 canonical tuple、传输语法、兼容规则和失败基线，不预先承诺 parser |
| SB8 | design authority 四项 inline preflight：placeholder / consistency / scope / ambiguity | P/Partial/P/P | Spine | architectural Think reference + Plan handoff | **P1**；确定性 placeholder scan + 语义自审组合 |
| SB9 | written design 的人工 gate | P/Partial/P/P | Mixed | 现有 Think/Plan 风险语义 | **Cross-ref/conditional**；是否停等由开放产品决策、不可逆性、外部副作用和权限决定，不由 architectural 标签单独决定 |
| SB10 | 所有 creative task 都无条件 approval | P/Partial/Fail/P | Surface | 不落 | **Hard reject**；权限/不可逆性/开放产品决策决定 gate |
| SB11 | 新增 `/brainstorm` 命令或 Sprint phase | Partial/Partial/Fail/P | Surface | 不落；扩展 Think 并用按需 reference | **Hard reject**；避免命令和状态机膨胀 |
| SB12 | Visual Companion server/telemetry | Partial/Partial/Fail/Fail | Surface | 不落；继续使用现有 Figma/visualization 路由 | **Hard reject**；visual-question spine 已 cross-ref |
| SB13 | spec 写完自动 commit | Partial/P/Partial/P | Surface | 不落 | **Hard reject**；是否 commit 由用户授权和当前 git workflow 决定 |
| SB14 | spec/plan 默认再派独立 subagent 审文档 | Partial/Partial/Partial/P | Surface | 不落为默认；高风险任务复用现有 Review | **P2 conditional**；默认 inline，风险或争议触发独立 review |

互斥主决策：P1 5（SB1/SB3/SB4/SB7/SB8）+ P2 4（SB2/SB5/SB6/SB14）+ cross-ref 1（SB9）+ hard reject 4（SB10–SB13）= 14。SB12 的 visual-question spine 只 cross-ref 到已有能力，不把同一候选重复计数。

## 3. Proposed Native Shape（非实施）

```text
Think routes intent (labels are provisional, not the contract)
  probe-like         -> answer / throwaway evidence; no spec, no plan
  bounded-like       -> short in-chat design -> normal Work; no spec, no plan
  architectural-like -> frozen design authority -> implementation Plan -> Work -> Review

Architectural authority chain
  frozen design-authority block (same file OR docs/specs/<id>.md; P2 A/B decides)
          |
          | spec-lineage:v1 + locator + digest + criterion ids
          v
  docs/plans/<id>.md (tasks own all AC ids; no unknown ids)
          |
          v
  Work / Review (目标态；仅在 SB6 的本地证据达到阈值后启用 freshness gate)
```

### 3.1 Proposed Markdown contract（实现前仍需 fixture 冻结）

```markdown
<!-- design-authority:start -->
### AC ac-example
WHEN ... THE SYSTEM SHALL ...
<!-- design-authority:end -->

<!-- spec-lineage:start -->
version: spec-lineage-v1
source_ref: docs/specs/YYYY-MM-DD-topic.md#design-authority
source_sha256: sha256:<canonical-block-digest>
<!-- spec-lineage:end -->

<!-- acceptance-contract:start -->
<!-- criterion-id: ac-example -->
- [ ] WHEN ... THE SYSTEM SHALL ...
<!-- acceptance-contract:end -->

- [ ] **Task 1** ... — Criteria: `ac-example`
```

约束：canonical value 是 `(criterionId, statement)`。design authority heading、plan 的 `criterion-id` 注释和 checklist prefix 都只是 transport syntax；两端按现有 `acceptanceStatements()` v1 规则移除 transport 及其周边 `\s`，所得 ID 必须精确相等，statement body 的 Unicode code-point 序列必须精确相等，不再做大小写或 Unicode 归一化。现有 `acceptanceStatements()` 会忽略独立注释，并通过 `(.+?)\s*$` 裁掉 checklist body 的尾部空白；design-side extractor 必须采用同一 boundary-whitespace 规则。因此 Harness Contract 收到的是不带 ID 的 canonical statement，而不是 Markdown 原始字节；实现前必须用 spec → plan → Harness Contract round-trip fixture 证明这一点。task 只能引用已知 ID，所有 ID 至少有一个 owner。若 SB6 被触发，parser 必须拒绝重复 ID、未知 ID、未覆盖 criterion、statement 漂移、重复/缺失 marker、绝对/越界 path、symlink/junction、超限文件，以及大小写、分隔符或 `#fragment` 归一化后的缺失/歧义。

### 3.2 本地基线与 SB6 触发阈值

先对 Claude/Codex 两套 current SoT 与 treatment 契约运行同一组 fixture，覆盖 specless conflict、freeze 后 source 变化、criterion drift，并记录正确裁决与误停。运行前冻结 seed、severity 标签和 scorer；“高严重度”限定为会让实现违反已声明设计、接受 stale authority，或让 criterion 没有 accountable task 的冲突。每类至少 3 个独立 seed，每个 seed 在每个 runtime、每个 current/treatment arm 至少 3 reps，即每端每臂至少 27 reps。指标以单次 rep 为分母，在 Claude、Codex 上分别计算，不允许聚合掩盖单端退化。预注册门槛：两端 current 各自漏过至少 20% 的 seeded 高严重度冲突，且 treatment 在两端都达到至少 80% 正确率、相对 current 提升至少 30 个百分点、误停不高于 10%，并且任一类别正确率不低于 2/3，才把 SB6 升为 runtime implementation。未达到阈值时只保留 SB4/SB7 的设计语义，不建设新 parser/gate。

### 3.3 Authority 与 stale 语义

1. 当前用户指令、系统/项目规则和权限边界优先，不被 spec 静默覆盖。
2. design authority 约束 implementation plan 的设计意图；它不是对所有 authority 的无条件“最高真相”。
3. 一旦 AcceptanceContract freeze，Work/Review 仍以同一 contract hash 为验收 authority；若 SB6 达到阈值并实施，还必须同时验证 spec lineage fresh。
4. SB6 的目标 stale 语义是：architectural design authority 在 freeze/bind 后改变时，plan、binding、已有 Receipt 一并 stale；禁止静默刷新 digest。当前 Sprint 必须进入显式 revision/recovery，重新 plan、freeze、bind 后才能继续。
5. `spec-lineage-v1` 缺失的旧 plan 保持 legacy 行为；功能回滚时已有 spec 保留为普通 Markdown，不破坏旧 Sprint。

边界：agent-loop 继续使用已有 frozen `spec.json` + `criterionIds`，不强行改成 Markdown 双文件。本候选研究 manual Sprint/普通 Think→Plan；若 SB6 被触发，其 validator 应独立于 Harness control-store。两套 Work/Review SoT 对任何显式传入或从上下文解析出的 lineage plan 调用同一 validator；active Sprint 的 `plan→work` transition 与 Review readback只是附加的确定性门，不能成为唯一入口。

### 3.4 双 runtime landing inventory

- SoT：`user-level/commands/{think,plan,work,review}.md` 与 `codex-native/skills/{think,plan,work,review}/SKILL.md`。
- Artifact：`docs/plans/TEMPLATE.md`；若双文件 A/B 胜出，再新增 `docs/specs/TEMPLATE.md`。
- Experiment：两端 current-vs-treatment fixture、评分样例和预注册 SB6 触发阈值。
- Conditional runtime：只有 SB6 达到阈值时才新增 versioned spec-lineage parser/validator；两套 Work/Review SoT 覆盖显式/解析出的 plan，active Sprint transition/readback 只是附加门。不得假装现有 agent-loop JSON validator 可直接解析 Markdown。
- Projection：运行 `node scripts/propagate-command-changes.js think plan work review`，再构建/校验 plugin projections。
- Tests：route 反例、canonical tuple/transport round-trip、current-vs-treatment 基线、Claude/Codex projection parity；SB6 被触发后再加入 marker/parser、digest freshness、criterion duplicate/unknown/unowned、legacy plan、standalone Work/Review、active Sprint revision/recovery，以及 symlink/junction、bounded-file、绝对/越界 path、大小写/分隔符/fragment 归一化反例。

## 4. Review Gate

- [x] product-lens 首轮：FAIL；已将逻辑 authority 与物理文件拆分、修正 gate 与 bounded 判据。
- [x] coherence 首轮：FAIL；已闭合 authority/stale、历史措辞和 verified/inference。
- [x] feasibility 首轮：FAIL；第二轮指出 runtime gate 缺少本地 ROI、Markdown transport 与 standalone Work/Review 缺口；已改为证据门控并补齐契约。
- [x] defensive challenge：SB4 将 2026-09-04 对普通 Plan `Spec:` 的 scoped cross-ref 翻为 architectural manual Sprint 的 P1 design-lineage 机制缺口；物理双文件仍为 P2。
- [x] product-lens 终审：PASS；P1 语义/fixture 与 P2 runtime 的证据门、样本分母和分类下限已闭合。
- [x] coherence 终审：PASS；候选计数、authority 生命周期与 defensive flip 前后一致。
- [x] feasibility 终审：PASS；canonicalization、standalone/active 入口和条件 runtime 安全边界已闭合。

## 5. Outputs

- Plan：本文件。
- Decision：`docs/solutions/2026-09-09-superpowers-spec-brainstorming-eval.md`。
- Learning/instinct：0（未授权）。
- Solution index：已在 review pass 后同步。

## 6. 收缩实施记录

2026-09-09 用户授权直接开始实施，实际范围保持在此前工程建议的低风险 pilot：

- 实施记录：`docs/plans/2026-09-09-think-design-routing-shadow-pilot.md`。

- 已实施 SB1/SB3：Claude/Codex Think 统一 `probe-like` / `bounded-like` / `architectural-like` 路由、throwaway 重分类、单向升级，以及 artifact route 与人工 gate 解耦。
- 已实施 SB4/SB8 的 shadow 子集：仅 architectural 路径在同一 plan 内写约定冻结的 design-authority，并做 placeholder、内部一致性、scope、歧义四项 inline preflight。
- 已闭合 runtime 边界：独立 Think 可直达 Work/返回答案；活动 `/sprint` 继续遵守 `think -> plan` 状态边，路由只缩放 Plan 深度和附加工件。
- 已增加确定性契约测试 `scripts/test-think-design-routing.js`，并通过既有生成器传播 Claude/Codex 投影与 `auto-mode` rule。
- 未实施 SB5/SB6：没有独立 spec 文件、lineage parser、digest、Work/Review gate 或 stale recovery；正式 current-vs-treatment 行为评测尚未运行。

实际验证：新增测试先在旧 Think 上因缺少 `probe-like` 失败，修改后通过；最终扩展回归的 11 个测试文件全部通过，Codex plugin validation 与双 runtime project-standards check 通过。通用安装 preflight 仅因沙箱中的 `~/.claude` 不可写报告环境阻塞，不是本次 repo 投影失败。

后续收尾修复了 `docs/plans/TEMPLATE.md` 对 Harness 的无条件绑定残留、`install-all.ps1 -All` 的 README 描述，以及通用 Codex 文本安装器把双 runtime instruction 文件名转换为重复 `AGENTS.md` 的新安装缺陷；Claude plugin 递增至 1.0.4 后与 Codex plugin 一并完成 source/cache hash 读回。双运行时使用真实原生入口跑了五类无工具在线 smoke；结果支持继续保持当前 shadow pilot，但样本量不足，不能替代 §3.2 的正式 current-vs-treatment 评测，也不触发 SB5/SB6。

回滚边界：若 shadow pilot 使 bounded 任务误升级、增加无效文档或破坏 phase 路由，则移除两端 Think/Plan 的新增区块与 `auto-mode` 新行，重新运行 `node scripts/propagate-command-changes.js think plan --rules auto-mode`；已经生成的 design-authority 区块保留为普通 Markdown，不需要数据迁移。

## Sources

- https://github.com/obra/superpowers/releases/tag/v6.3.0
- https://github.com/obra/superpowers/pull/2063
- https://github.com/obra/superpowers/pull/2086
- https://github.com/obra/superpowers/issues/2079
- https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md
- https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md
