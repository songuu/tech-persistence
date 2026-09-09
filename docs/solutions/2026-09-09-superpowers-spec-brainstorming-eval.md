---
title: "Superpowers Spec/Brainstorming 复评：架构任务需要稳定、可追踪的 design authority"
date: "2026-09-09"
status: completed
type: solution
tags: [solution, sibling-eval, superpowers, spec, brainstorming]
related_solutions:
  - "[[2026-09-04-superpowers-v63-eval]]"
  - "[[2026-05-14-spec-kit-eval]]"
source_plan: "[[2026-09-09-superpowers-spec-brainstorming-eval]]"
source_commit: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797"
---

# Superpowers Spec/Brainstorming 聚焦复评

> Status: `completed`。这份结论专门修正旧评估对 Spec 与 brainstorming 的低估；product-lens、coherence、feasibility 三路终审均 PASS。

## 修正后的结论

这两项不是旁支，而是 v6.3 对 TP 最值得借鉴的主线：

1. **Brainstorming 不是固定仪式，而是 artifact 路由。** feasibility 输出只产答案，局部任务只需 chat 内短设计，高设计复杂度任务才需要冻结的 design authority 和 implementation plan。三标签可借来做 fixture，但不是必须照搬的产品表面。
2. **冻结的 design authority 应与可变 implementation plan 逻辑分层。** 计划能告诉执行者“做什么”，但无法仅靠自身裁决内部矛盾；P1 先冻结 lineage/criterion 语义并跑 TP 本地基线，只有达到预注册收益阈值才在 P2 实现 Plan/Work/Review 的 fail-closed gate。Spec 只是 plan 的设计意图 authority，不凌驾当前用户指令、项目规则、权限边界或 authority-owned AcceptanceContract。

因此应修正 2026-09-04 的判断：`Spec:` 不只是已有能力的 cross-ref。已验证的是 Agent-loop 已覆盖，而 manual Sprint/普通 Think→Plan 缺少 lineage enforcement；它在 TP 中导致错误的实际频率和 ROI 仍未知。

14 个候选的互斥主决策：P1 5 项、P2 4 项、cross-ref 1 项、hard reject 4 项。

## 最重要的证据

- Superpowers 旧 brainstorming 对 bounded/architectural 都固定写 spec + plan；PR #2063 的新路由让 bounded 3/3 零文档，同时保留 architectural 3/3 双文档。
- 初版轻量路由曾让 2/3 bounded agent 跳过批准直接 patch；补明确 STOP 后 3/3 恢复“短设计 → 批准 → 实现”。所以应借“artifact 随复杂度缩放”，不能照搬“所有任务都停等批准”。
- PR #2086 的种子冲突实验中，specless plan 只有 0–1/5 正确裁决；spec 在场时达到 4–5/5，并跨 Claude/GPT/Kimi/GLM 复现。这个结果支持把 architectural design-lineage 从 cross-ref 升为机制缺口；它只证明稳定设计 authority 在场的价值，不证明必须拆成多个物理文件。
- issue #2079 已验证一个小规则改动产生 3,061 行、14 commits、约 10 小时；结合 PR #2063 的 live eval，本文推断 TP 应让 artifact 成本随设计复杂度缩放。最佳阈值需用 TP fixture 验证。

## 建议的 TP 形状

### 1. 扩展 Think，不新增 Brainstorm 命令

| 路径 | 判定 | 工件 | 下一步 |
|---|---|---|---|
| probe-like | 输出是可行性答案，不保留代码 | 无 spec/plan；试验明确 throwaway | 报告建议；若要保留则重新分类 |
| bounded-like | 设计歧义低、接口封闭、耦合和影响半径小；已有 flow 只是强证据之一 | chat 内短设计 | 正常 Work |
| architectural-like | 新子系统、重构组件关系、改变消费者接口或存在开放设计决策 | 冻结 design authority | Plan |

隐藏复杂度只能升级路径。判定同时考虑设计歧义、消费者接口、跨组件耦合、可逆性和影响半径；不能因为 agent 熟悉领域而降级，也不能让一个小而封闭的 greenfield 工具仅因没有旧 flow 就被迫写双文档。

### 2. Architectural path 恢复两层逻辑 authority

- design-authority block：问题、用户价值、范围、备选方案、选择理由、组件/接口/状态/错误路径、带 ID 的 acceptance criteria。
- implementation plan：只负责实施顺序、文件、依赖、风险、测试和 criterion ownership。
- 两层可以是同一 Sprint 文档中的冻结区块，也可以是独立 `docs/specs/*.md` + `docs/plans/*.md`；物理形态先做 P2 A/B，不预判独立文件胜出。
- P1 先定义 plan lineage 的 version、source locator、canonical block digest 与 task criterion IDs，并用 fixture 检验重复、未知、未覆盖和 statement drift；不把新 parser/runtime 当作无条件前置建设。
- 若本地证据触发 P2 gate，Work/Review 才 fail closed 地读回 fresh design authority。freeze/bind 后 design authority 改动时，plan、binding、Receipt 一并 stale；禁止静默刷新 digest，必须显式 revision/recovery 并重新 plan/freeze/bind。

Acceptance criterion 只有一个 canonical owner：design authority。canonical value 是 `(criterionId, statement)`；design heading、plan 的独立 `criterion-id` 注释和 checklist prefix 只是 transport syntax。两端按现有 `acceptanceStatements()` v1 规则移除 transport 周边 `\s`，再要求 ID 与 statement body 精确相等，不做大小写或 Unicode 归一化。这样现有 parser 的 `(.+?)\s*$` 行为可继续向 Harness Contract 传递不带 ID 的 canonical statement；必须先用 spec → plan → Harness Contract round-trip fixture 验证。当前用户指令、项目规则与权限边界始终更高，Spec 不会静默覆盖它们。

这不是照搬 Superpowers 的裸 `Spec:` 文本行。先复用 TP 已有 hash、path/readback、criterionIds 和 fail-closed 测试形状做 treatment fixture。运行前冻结 seed、severity 和 scorer；specless conflict、stale source、criterion drift 每类至少 3 个独立 seed，每 seed 在 Claude/Codex 的 current/treatment 各跑至少 3 reps，因此每端每臂至少 27 reps。指标以 rep 为分母并在两端独立计算。只有两端 current 各自漏过至少 20% seeded 高严重度冲突，且 treatment 两端均达到至少 80% 正确率、提升至少 30 个百分点、误停不高于 10%、任一类别正确率不低于 2/3，才新建独立、versioned 的 Markdown lineage parser/validator。它不能塞入只服务显式 Harness binding 的 `codex-sprint-acceptance.js`；两套 Work/Review SoT 对任何显式或解析出的 lineage plan 调用同一 validator，active Sprint transition 只是附加门。

### 3. Spec gate 保持轻量

默认 inline 检查四项：placeholder、内部一致性、scope、歧义。能机械检查的先脚本化；只有高风险、存在争议或用户要求时才使用独立 Review。是否停等人工由开放产品决策、不可逆性、外部副作用与权限决定，不由 architectural 标签单独决定。

## 与 TP 当前能力的边界

- **已有且更强：** agent-loop 的 frozen `spec.json`、AcceptanceContract、task `criterionIds`、Review 对 frozen spec。
- **部分已有：** Codex Think 的小任务直达 Work、Plan 的 risk scaling、Sprint acceptance binding。
- **已验证的机制缺口：** Claude/Codex Think 路由不一致；manual Sprint 没有冻结的 design-lineage、freshness gate 和 task-to-criterion coverage。**未知：** TP 本地事故率与收益幅度；因此 runtime gate 受本地基线门控。
- **不建议：** 新增 `/brainstorm` 命令、新增 Sprint phase、所有 creative task 强制批准、spec 自动 commit、visual companion server。

## Defensive Flip

2026-09-04 的 Superpowers 评估把普通 Plan 的 `Spec:` 判为 scoped cross-ref。新证据使该结论发生一次真实翻转：

> architectural manual Sprint 的 design-lineage 现在是 P1 机制缺口，不再只是 cross-ref。翻转只发生在逻辑 authority 层；是否拆成两个物理文件仍为 P2 A/B，未翻转 2026-05 对默认多 artifact surface 的拒绝。

## 初步优先级

1. P1：统一 Claude/Codex Think 的 artifact-scaling 语义、throwaway/reclassification 与单向升级规则；三标签和阈值由 route fixtures 校准。
2. P1：定义 design-authority / spec-lineage / acceptance projection / task criterion 的 canonical tuple 与 transport 语法，跑双 runtime current-vs-treatment fixture。
3. P2 conditional：达到预注册阈值后，才实现独立 lineage validator，覆盖 standalone Work/Review 和 active Sprint；stale 必须有 revision/recovery 路径。
4. P2：A/B 同文件冻结 block 与独立 `docs/specs/*.md`，再决定物理 artifact。
5. P2：高风险/争议 spec 才触发独立 document review；默认 inline preflight。

P1 双 runtime 最小落点包括双方 `think/plan` SoT、`docs/plans/TEMPLATE.md`、本地 baseline/round-trip fixtures，以及 `propagate-command-changes.js think plan` 后的 plugin projection/parity 校验。SB6 达到阈值后，P2 才扩到双方 `work/review` SoT 与新的 lineage runtime/tests，并传播 `work review`。若双文件 A/B 胜出，才新增 `docs/specs/TEMPLATE.md`。

## Review 状态

- product-lens：终审 PASS；P1/P2 证据门、实验分母与 route/gate 边界已闭合
- coherence：终审 PASS；候选计数、authority 生命周期与历史翻转口径一致
- feasibility：终审 PASS；canonicalization、standalone/active 入口与 conditional runtime 安全面已闭合
- defensive challenge：1 个真实 flip（普通 Plan `Spec:` scoped cross-ref → architectural manual Sprint 的 P1 design-lineage 机制缺口；物理双文件仍 P2）

## 边界

后续已按用户授权实施收缩 pilot：统一两端 Think 路由与 `auto-mode`，加入单向升级、throwaway 重分类和人工 gate 分离；architectural Plan 使用同文件 shadow design-authority 与四项 inline preflight。活动 Sprint 保持既有 `think -> plan` 状态边。

实施证据与回滚边界记录在 `docs/plans/2026-09-09-think-design-routing-shadow-pilot.md`。

实现没有越过原证据门：未增加独立 spec 文件、lineage parser、digest、Work/Review gate 或 stale recovery；正式 current-vs-treatment 行为评测仍未运行。未写 learning/instinct，未 commit、未 push。

收尾审查另修复了计划模板仍无条件绑定 Harness、统一安装说明与 legacy opt-in 不一致，以及 Codex 文本安装器把双 runtime instruction 文件名转成重复 `AGENTS.md` 三处残留。Codex/Claude plugin 已部署并完成 source/cache hash 读回；五类无工具在线 smoke 在真实原生入口下通过，期间发现并修复 route 标签未强制使用规范枚举的问题。最终扩展回归 11/11 test files 通过；该 smoke 只证明基本契约可执行，不提供 SB6 所需的统计证据。
