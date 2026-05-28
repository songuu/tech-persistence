---
title: "架构演进全景：V1→V7 与加固期（2026-04 ~ 05）"
type: architecture
status: completed
created: "2026-05-28"
updated: "2026-05-28"
tags: [architecture, evolution, overview, retrospective]
aliases: ["架构演进总结", "evolution overview", "V1-V7 全景"]
---

# 架构演进全景：V1→V7 与加固期

> 本文是 V1→V7 的**贯穿式**总结，回答「为什么演化成今天这样」，而非罗列功能。
> 功能清单 / 命令表 / 目录结构见 [README](../../README.md)；本文只补 README 没有的三件事：
> **① 每版的触发痛点 → ② ADR 因果链 → ③ 在迭代中沉淀出的元方法论与当前张力。**
>
> 数据底座（勘察自 git + architecture.md，非凭记忆）：8 周（2026-04-01 → 05-27）· 111 commits · 0 tag · 40 plans · 28 solutions · ADR-002~015 实存 11 条。

---

## TL;DR

整条演进史有一个被 README 版本图掩盖的**相变**：

| 阶段 | 时间 | commits | 主题 | 标志 |
|------|------|---------|------|------|
| **功能扩张期** | 2026-04（约 30 天） | 48 | V1→V7 七个大版本一口气铺完 | 每周一个新能力层 |
| **质量加固期** | 2026-05（至 05-27） | 63 | **零新版本号**，全是防漂移 / parity / enforcement 下沉 | ADR-008~015 + 6 次 sibling-eval |

也就是说：**版本号在第 30 天（04-30）就停在 V7 了，但过半 commit（63/111 ≈ 57%）发生在那之后的 5 月。** 项目真正的成熟不在「加了多少功能」，而在加固期沉淀的那套**元方法论**——它才是这个自进化系统区别于一个普通命令集合的脊椎。

一句话定位（[[ADR-011]] 确立）：**tech-persistence = developer-toolchain 自进化 sibling，4 条不可妥协原则 = 多运行时 parity / 确定性优先 / 轻量优先 / Obsidian 兼容。**

---

## 1. 版本时间线：痛点 → 能力

每一版都是为了解决上一版**暴露出来的**具体痛点，不是功能堆叠。

| 版本 | 时间 | 触发痛点（上一版的痛） | 核心能力 | 关键 ADR / 证据 |
|------|------|----------------------|----------|----------------|
| **V1 Manual** | 项目初期 | 经验只在脑子里，换会话就丢 | `/learn` + `rules/` + 手动 `/compact` | first commit 雏形 |
| **V2 Auto-learning** | 早期 | 手动 `/learn` 靠自觉，会漏 | 4 Hook 自动观察 + 本能置信度(0.3-0.9)/衰减 + 项目隔离 | commit `a624dd3` |
| **V3 Workflow** | 早期 | 有记忆但无章法，每次从零规划 | 角色切换（CEO→架构师→工程师→审查）+ compound 复利环 + `/sprint` + `/prototype` | commit `441d8af` |
| **V4 Self-iteration** | 04-09 → 04-13 | skill 写好就是死的，命令逻辑永远停在安装时 | skill 信号闭环（信号→诊断→提案→eval→发布）+ 风险自适应测试(L0-L4) + checkpoint/resume + Obsidian | [[2026-04-13-skill-self-iteration-loop]] |
| **V5 Codex Memory** | 04-24 | 只支持 Claude；SessionStart 在「全量摘要」和「无记忆」间摇摆 | 轻量索引 `MEMORY.md` + topic 文件 + payload 规范化 + 置信度门控写入 + **Codex 运行时** | [[ADR-002]] |
| **V6 Agent Loop** | 04-27 → 04-28 | 让 claude/codex 在各自上下文里互相模拟，上下文丢失、协议不稳 | **外部 orchestrator** 串联多 Agent + frozen spec 契约 + Provider 适配层内建 | [[ADR-003]] [[ADR-004]] |
| **V7 Compression** | 04-30 | 双运行时输出冗长 + memory 文件膨胀 | caveman 输出压缩 + memory 文件压缩 + Claude/Codex parity 加固 | `docs/plans/2026-04-30-agent-loop-v7-caveman.md` |
| *(加固期)* | 05-07 → 05-27 | **V6 实战暴露 16 个深层缺陷**（状态机、provenance 漂移、parity 违反） | 无新版本号；见 §4 元方法论 + §6 张力 | [[ADR-008]]~[[ADR-015]] |

**演进逻辑的两个拐点：**

- **V4 → V5 是从「单运行时」到「多运行时」的相变。** V5 引入 Codex 不是加个适配器，而是从此所有设计都要回答「两个运行时都成立吗」——这条约束后来固化为 [[ADR-011]] 4 不可妥协原则之首。
- **V7 → 加固期是从「加能力」到「固质量」的相变。** V6 的 [[ARCHITECTURE_ISSUES]] 列出 16 个深层缺陷（spec 多轮输出、blocked 死锁、review normalize bug、Codex projection 语义漂移……），让团队意识到：**再加版本不如把已有的做对。** 加固期由此诞生。

---

## 2. ADR 因果链

ADR 不是孤立决策，它们形成一条**因果链**，且**链条本身是演进的产物**——注意编号断点。

```
ADR-002 (Memory v5 轻量索引)              ← V5 起点：多运行时记忆
   │
ADR-003 (外部 orchestrator)               ← V6：不让 Agent 互相模拟
   └─ ADR-004 (Provider 适配层内建)        ← V6 推论：差异收敛在 orchestrator
   │
ADR-008 (启动注入合并兼容运行时)           ← 加固：parity 不能靠用户手配共享目录
   │
ADR-009 (--auto 决策协议单一 rule)        ← 加固：21 个命令的 gate 行为不能各自分叉
   │
ADR-011 (identity-question-first) ★       ← 加固：评估外部方案先问「我是什么物种」
   └─ ADR-012 (Plan 必须勘察被改文件)      ← 同期：plan 不能凭记忆/文件名猜
   │
ADR-013 (mechanism over discipline) ★★    ← 加固核心：规则从文档下沉为工具拒绝
   └─ ADR-013§B (enforcement 必须 dogfood 边界) ← 推论：上线前枚举现有产物 + 负样本
   │
ADR-014 (Hook 架构统一语义源头)            ← 加固：3 运行时 hook 配置按 registry 派生
   │
ADR-015 (Persona 顶层维度 + 双 memory 显式区分) ← 加固：发现两套 memory 并存盲点
```

**断点说明（诚实记录）：缺 ADR-001 / 005 / 006 / 007 / 010。**

这不是疏漏，而是一条元信息：**ADR 制度本身是 V5 时期（04-24）才建立的，项目最初 30 天的架构决策（V1-V4 的角色分工、4 Hook、置信度衰减、skill 闭环）从未被追溯补记 ADR。** 005/007/010 的间断则反映加固期决策密度太高，部分决策直接落在 solution 文档而没升格 ADR。

→ **可改进点**：V1-V4 的奠基决策应补记 ADR-001（自学习系统总架构）与 ADR-005~007（角色工作流 / 风险自适应测试 / skill 闭环），否则新读者无法从 ADR 链还原前半段历史。

---

## 3. 设计哲学的七次转向

每一版的本质是一次**默认假设的翻转**：

| # | 从 | 到 | 翻转的假设 |
|---|-----|-----|-----------|
| 1 | 经验靠人记 | 经验靠系统记 | 「我会记得」→「我不会记得，所以让 Hook 记」 |
| 2 | 记下就够 | 记下要有生命周期 | 静态知识 →「本能有置信度，会成长也会衰减」 |
| 3 | 一个 Claude 干所有 | 同一模型切换角色 | 「全能视角」→「CEO/架构师/工程师/审查各看各的」 |
| 4 | 命令是死的 | 命令自我迭代 | 「skill 装好就定型」→「skill 用了会产生信号，信号驱动改写」 |
| 5 | 服务单一运行时 | parity 是第一约束 | 「为 Claude 写」→「任何设计两个运行时都要成立」 |
| 6 | Agent 内部串联 | 外部编排器做契约 | 「让它们互相模拟」→「用进程边界 + frozen spec 管控」 |
| 7 | 表达越详细越好 | 表达按预算压缩 | 「写全」→「主文档写全、对话压缩、二者正交」 |

**贯穿七次转向的一条主线：把「靠自觉/靠记得/靠详细」的软约束，逐步替换为「靠机制/靠契约/靠预算」的硬约束。** 这条主线在加固期被命名为 [[mechanism-over-discipline]]（见 §4.1），是整个项目最重要的自我认知。

---

## 4. 元方法论：加固期的真正产物

README 完全没有这一层——但它才是这个系统区别于「一堆 prompt 模板」的关键。以下 5 条都是**被真实事故催生**的，不是设计时想出来的。

### 4.1 mechanism over discipline（[[ADR-013]]）★ 最高价值

**规则**：高频违反、影响多副本一致性、或涉及 dogfood 边界的纪律，必须从「靠模型记得」的文档协议**下沉为「工具层拒绝」**（pre-commit / lint / CI reject）。

**催生事故**：
- `2>nul` hook 语法在 Windows 上**踩了 2 次**（04-09 修过，重构后回归，05-12 二修）——纯文档协议「以后记得用 POSIX 语法」抵不住重构。见 [[2026-04-09-obsidian-integration]] 的 Errata + [[2026-05-12-nul-hook-shell-mismatch]]。
- propagate 多副本 sha256 漂移——「记得跑 build」靠不住。

**落地**：`scripts/pre-commit-check.js` 接管 propagate sync 检查、plan 假设验证段 lint、plan 完成度验证。3 层 fail-open 防御保证用户永远有逃生通道。

**文档协议的 3 个结构性失效模式**（写再多文档也解决不了）：遗忘（上下文压缩后规则不在 active context）/ 省略（压力下主动跳过 self-check）/ 漂移（多次修订后文档与期望偏移）。

### 4.2 identity-question-first（[[ADR-011]]）

**规则**：评估外部架构思想前，先回答「**本项目是 X / Y / Z 中的哪一个**」。身份明示后，多数候选 trivially decidable。

**催生事故**：评估 `gbrain` 时直接进入「按 ROI 排序选 top-3」，product-lens reviewer 才指出真问题是「本项目还是 gstack-aligned 吗」。身份不明时，研究会**「导入表面、拒绝脊椎」**，且 ROI 偏 speed-wins（但 solo 维护者的成本曲线与团队反向）。见 [[2026-05-11-gbrain-gstack-analysis]]。

### 4.3 sibling-eval 方法论（命中率 13-20% 是常态）

**规则**：「看看可借鉴的」默认是**对比评估**请求，不是实施承诺；默认输出是「对比 + 优缺点」，不是落地决策表。

**实战节奏**：加固期评估了 6+ 个外部项目——gbrain / gstack / mattpocock-skills / spec-kit / TDAI(腾讯云) / claude-mem。**直接借鉴命中率稳定在 13-20%，常态是 0 直接借鉴 + 若干 follow-up。** 这不是失败，而是「先问目标用户是否同类、再问是否对齐 4 不可妥协」过滤掉了大量 cargo-cult。

**自我纠偏**：[[2026-05-18-sibling-eval-evidence-based-recalibration]] 发现自己的 sibling-eval 文档标了 `completed` 却没经独立 reviewer，优先级凭直觉而非证据计数——于是把「证据归类 + product-lens reviewer + 双向挑战 absorb/reject」固化为流程。**防御性拒绝是最隐蔽的 cargo-cult。**

### 4.4 cross-sprint anti-drift（防漂移协议）

**规则**：Sprint 拆分降低单次风险，但**放大长期漂移**。多 sprint 任务必须显式建模「跨 sprint 状态」：invariant 继承 / 集成路径声明 / 半完成债务清单（Phase 2 强制三问）+ Review 第 6 视角（集成连续性）。

**催生认知**：单 sprint review 只看本 sprint diff，看不到「上 sprint 立的 useMemo 在新 sprint 同类代码处缺失」「API 建好但 UI 不调用 = dead code」「shared 下沉到一半无限延期」这三类反模式。

### 4.5 dogfood 边界枚举（[[ADR-013]]§B）

**规则**：新 enforcement 上线前必须 (a) 枚举本仓库 ≥3 个同类**现有产物**验证不被误拒；(b) 当前态全合规时**主动制造负样本**（改 1 字符→必须 fail，恢复→必须 pass）。

**催生事故**：pre-commit hook 装上**立刻**会拒绝 6+ 个本仓库已有的无 frontmatter 旧 plan——enforcement 最差启动状态（用户被迫 `--no-verify`，习惯一旦养成不可逆）。

> **一条贯穿元方法论的自指洞察**：[[ARCHITECTURE_ISSUES]] 本身就是 [[documented-claim-vs-code-reality-drift]] 的活样本——文档里大量「建议修复」与「已落地」混排，部分标「已修」的项 grep 不到对应代码。**这个项目一边在记录「文档声称 vs 代码现实」会漂移，一边自己正在漂移。** 这正是 4.1 要把纪律下沉为机制的根本原因。

---

## 5. 当前架构快照

> 详尽版见 [README](../../README.md)；此处只给骨架，供下文 §6 张力定位。

- **3 个运行时**：Claude Code classic（`~/.claude/`）/ Claude Code plugin（`plugins/tech-persistence/`）/ Codex plugin（`~/.codex/`）。源在 `user-level/`，其余靠 propagate + build 派生（[[ADR-014]]）。
- **5 层知识存储**：observations（Tier0）→ Memory v5 索引 → instincts（Tier1, 0.3-0.9）→ evolved（Tier2）→ rules+solutions（Tier3）→ CLAUDE.md/AGENTS.md（Tier4）。
- **执行层**：`/sprint` 串联 think→plan→work→review→compound 6 phase；`/agent-loop` 外部编排（可选 `--pipeline` 分片）。
- **观察层**：4 Hook（SessionStart/PreToolUse/PostToolUse/Stop）+ UserPromptSubmit recall = 4+1。
- **记忆访问**：Memory v5（被动注入）+ Memory MCP 5 工具（主动调用）。
- **正交开关**：`--caveman`（输出压缩）⊥ `--auto`（gate 决策）。
- **24 命令 / 10 按需 skill**。

---

## 6. 张力与未来方向

诚实列出**当前架构未闭合的张力**（README 不暴露这些）：

| # | 张力 | 现状 | 来源 |
|---|------|------|------|
| T1 | **双 memory 系统并存** | Claude auto-memory dir（路径键=cwd）vs v5 dir（路径键=git hash），所有 `feedback_*`/`user_*` 在 Codex 端**不可见** = 既存的 parity 违反 | [[ADR-015]] / [[2026-05-15-persona-top-level-dimension]]（P1 backlog） |
| T2 | **parity 维护成本随运行时数线性增长** | 3 运行时多副本 sha256 同步，改 1 源 → propagate → build → validate 链；漏一步 pre-commit 报 mismatch | [[ADR-014]] / debugging-gotchas propagate 条目 |
| T3 | **enforcement 死亡风险** | 自然 82% skip 的协议若硬接 enforcement → 用户学会 `--no-verify` → 永久失效。Phase 间预热协议已因落地率 18% 从「必须」撤回为「建议」 | feedback: enforcement-dead-on-arrival |
| T4 | **Codex projection 语义漂移** | propagate 全局词替换把「Claude 生成 spec」误投影成「Codex 生成」，provenance（origin vs projection）被抹平 | [[ARCHITECTURE_ISSUES]] 问题 14 |
| T5 | **plans source of truth 分裂** | `docs/plans` vs `.codex/plans` vs `.claude/plans` 三处，resume 可能拿到旧/runtime-local 计划 | [[ARCHITECTURE_ISSUES]] 问题 16 |
| T6 | **pipeline 状态机无唯一写入口** | provider 层会直接写 `slice-*` 事件，状态图更像「文档化期望」而非硬门禁 | [[ARCHITECTURE_ISSUES]] 问题 10 / [[2026-05-12-pipeline-hardening-roadmap]] |
| T7 | **ADR 链前半段缺失** | 缺 001/005/006/007/010，V1-V4 奠基决策无法从 ADR 还原 | 本文 §2 |

**方向研判（按 4 不可妥协原则排序，非按「酷」排序）：**

1. **T1 + T4 + T5 同属一个根问题：多运行时 provenance 与 source-of-truth 没有单一权威。** 这是 parity 原则下最该优先收口的，建议合并为一个「双运行时数据边界」sprint。
2. **T2 + T3 是 enforcement 哲学的张力**：mechanism over discipline 要下沉规则，但下沉太多会触发 enforcement 死亡。平衡点 = 只下沉「高频违反 + 跨副本一致性 + dogfood 边界」三类，其余保持「建议」。这条平衡本身应写成显式准则。
3. **T6 是 pipeline 的债**，但 pipeline 是 opt-in，优先级可后置。
4. **T7 是低成本高回报的文档债**，补 5 条奠基 ADR 即可。

---

## 7. 关联

- 决策正文：[[ADR-002]] · [[ADR-003]] · [[ADR-004]] · [[ADR-008]] · [[ADR-009]] · [[ADR-011]] · [[ADR-012]] · [[ADR-013]] · [[ADR-014]] · [[ADR-015]]（均在 `.claude/rules/architecture.md`）
- 元方法论本能：[[mechanism-over-discipline]] · [[documented-claim-vs-code-reality-drift]] · [[cross-platform-sha-needs-lf-normalize]]
- 关键 solution：[[2026-04-09-obsidian-integration]] · [[2026-05-12-pre-commit-defense]] · [[2026-05-12-nul-hook-shell-mismatch]] · [[2026-05-18-sibling-eval-evidence-based-recalibration]] · [[2026-05-15-persona-top-level-dimension]]
- 深层缺陷台账：[[ARCHITECTURE_ISSUES]] · [[2026-05-12-pipeline-hardening-roadmap]]
- 用户入口：[README](../../README.md)

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-05-28 | 初版：V1→V7 + 加固期全景，§4 元方法论 5 条 + §6 张力 7 项（`/sprint` 产出） |
