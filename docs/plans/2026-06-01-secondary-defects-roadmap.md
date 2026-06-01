---
title: "次级缺陷 B/C/D/E 缓解 roadmap"
type: roadmap
status: completed
created: "2026-06-01"
updated: "2026-06-01"
tags: [roadmap, architecture, self-evolution, agentic]
aliases: ["次级缺陷 roadmap", "BCDE roadmap"]
parent: "docs/plans/2026-06-01-architecture-defect-analysis.md"
related:
  - "[[2026-06-01-architecture-defect-analysis]]"
  - "[[2026-06-01-demand-side-recall-telemetry]]"
defects:
  - id: E
    name: "知识抗腐化 drift checker"
    priority: P1
    status: done
  - id: B
    name: "主动检索 MCP measure"
    priority: P2
    status: done
  - id: C
    name: "同源验证异构 P0 复核"
    priority: P3
    status: deferred
  - id: D
    name: "80/20 规划深度 rule"
    priority: P4
    status: done
---

# 次级缺陷 B/C/D/E 缓解 roadmap

> 承接 [[2026-06-01-architecture-defect-analysis]]（缺陷 A 已落地 demand-side telemetry，见 [[ADR-022]] / [[2026-06-01-demand-side-recall-telemetry]]）。
> 本文档是**规划沉淀**，非执行 sprint。B/D/E 已落地；C 经二次勘察降级暂缓。
> 每个缺陷附「开 execution plan 前置勘察清单」，落地时直接照做（守 [[ADR-012]]：plan 前勘察被改文件）。

---

## 统一视角：B/C/E 是缺陷 A 的三个侧面投影

缺陷 A = 纪律/记忆寄生于「模型自愿遵守」（model-driven 协议无进程级强制）。B/C/E 不是独立缺陷，而是 A 在数据流三个侧面的投影——这解释了为何只有 E 能确定性化：

| 缺陷 | 是 A 的哪个侧面 | 寄生于什么 | 能否确定性化 | 优先级 |
|------|----------------|-----------|------------|--------|
| **E** 知识抗腐化 | **存储侧**——知识写入后无校验 | 「写的时候对」 | ✅ 符号存在性可 grep | **P1** |
| **B** 主动检索 | **输入侧**——检索靠模型自愿调 MCP | 模型自愿调用 | ⚠️ 只能 measure | P2 |
| **C** 同源验证 | **输出侧**——同模型自审无独立 oracle | 同模型不出同样的错 | ❌ 异构是新 seam | P3 |
| **D** 80/20 假设 | 非寄生——方法论假设过时 | pre-agentic 成本结构 | ❌ 哲学层 | P4 |

**E 最该先做**：唯一能下沉为确定性 enforcement 的次级缺陷（[[ADR-013]] mechanism-over-discipline 延续），且直击本仓库 #1 回归源 [[documented-claim-vs-code-reality-drift]]。

---

## 关键假设验证（[[ADR-012]]）

本 roadmap 的排序与档位依赖代码现实勘察——Phase 1 一行描述经勘察修正（不基于旧记忆）：

| 缺陷 | Phase 1 假设 | 勘察 | 修正后现实 |
|------|------------|------|-----------|
| B | 纯被动注入 | Read `scripts/prompt-submit.js` | 已有每轮 query-aware recall + MCP 5 工具；真缺口=主动检索靠模型自愿（同 A 根因）→ 降级 measure-first |
| C | review 同模型自审 | Grep `scripts/agent-orchestrator.js` PROVIDERS | 已有 codex 异构 provider（仅 implementation 用）；review 默认 claude → seam 部分在 |
| D | 80/20 假设过时 | sprint/work skill | 已有 `[P]`+worktree 并行执行；真缺口=规划阶段无多方案探索（哲学层）→ 倾向不写代码 |
| E | 知识层无校验 | Read `scripts/pre-commit-check.js` | 已有 6 个成熟 checker 模式，drift 可作第 7 个（确定性可判）→ P1 先做 |

---

## 深化勘察发现（2026-06-01 二次勘察，开 plan 前）

> 本节固化「开 execution plan 前置勘察」的二次勘察结果（[[ADR-012]]）。上方「关键假设验证」表是 Phase-1 一行勘察；本节是读完关键代码段后的修正，**直接影响 B 的 filter 正确性与 C 的可行性边界**，避免开 plan 时重新踩。

### 发现 ① B 的 filter 会静默失效（drift 活样本）

roadmap task 骨架原写「`tool` 匹配 `mcp__*memory*`」。勘察 `scripts/lib/memory-v5.js:180` `normalizeToolName`：

```js
return toolName.replace(/^functions\./, '').replace(/^mcp__/, '').slice(0, 80);
```

**`mcp__` 前缀被剥掉**。MCP 调用 `mcp__tech-persistence-memory__tp_memory_search` 进 observations 后记录为 `tech-persistence-memory__tp_memory_search`。故 `mcp__*` 匹配 **0 条** → B 会静默测到「永远 0」（fail-open 到假信号）。

- **修正**：filter 匹配工具名后缀 `/tp_memory_/`（不依赖 server 前缀；`memory-mcp-server.js` 5 工具均 `tp_memory_*` 命名，`scripts/lib/memory-tools.js:213` 起确认）。
- **正向确认**：observe.js matcher `*`（`scripts/observe.js:16`）确实捕获 MCP 调用；`tp_memory_` 子串在 normalize 后存活 → B **修正后可行**。
- **讽刺点**：这正是缺陷 E（文档声称 vs 代码现实漂移）的活例，落在 roadmap 自己的 task 骨架上——印证 [[documented-claim-vs-code-reality-drift]] 是 #1 回归源。

### 发现 ② C 裂成 C1/C2，C2 撞 [[ADR-021]] 天花板

勘察 `scripts/agent-orchestrator.js:26` `PROVIDERS = {spec:'claude', implementation:'codex', review:'claude'}`。codex 异构 provider 确实在，但 review 有**两条不同路径**，roadmap 把它们合并了：

| | 路径 | 宿主进程 | 确定性强制异构 P0 |
|--|------|---------|------------------|
| **C1** | `/agent-loop` orchestrator（`PROVIDERS.review` seam） | ✅ Node 进程 | ✅ 指 codex 即真强制 |
| **C2** | `/sprint` 的 `/review`（`review.md` in-context Task spawn，全 claude） | ❌ 无 | ❌ 只能写「P0 spawn codex」协议，模型须自愿调 = 缺陷 A 同根因 |

- **C2 撞天花板**：`/sprint` review 无宿主进程，确定性上限 = 协议 + 持久化 + 可见打印（[[ADR-021]] 第三轴、[[feedback_model_driven_loop_determinism_ceiling]]）。硬接异构协议会 dead-on-arrival（[[feedback_enforcement_dead_on_arrival_82pct]]）。
- **persona 关键**：高频 `/sprint` 用户（非 agent-loop）→ C1 的确定性赢**够不到主路径**，C2（主路径）被封顶。C 对当前用户真实 ROI **中→低**。

### 重排序（结合 persona + measure-before-enforce）

| 缺陷 | 成本 | 价值 | 判断 |
|------|------|------|------|
| **D** 规划深度 rule | 零代码（仿 `CLAUDE.md:108` L0-L4） | 认知层高 | ✅ 可顺手 |
| **B** MCP measure | 低（修 filter + 1 counter，复用 A telemetry） | 有界（预期确认主动检索≈0，本身是 finding） | ✅ 廉价确认 |
| **C1** agent-loop 异构 P0 | 中（`PROVIDERS.review` seam + fallback） | 高但只惠及 agent-loop 用户 | ⏸ 等 agent-loop 用量信号 |
| **C2** sprint 异构 P0 | 协议层 | 撞天花板 | ❌ 暂缓 |

**修正建议**：D（零代码）+ B（修 filter 后 measure）小批；C 整体降级——C2 暂缓、C1 等用量信号。「do nothing on C」对当前 persona 合理。

---

## 缺陷 E：知识抗腐化 drift checker（P1）

**根因**：`.claude/rules/*.md`、`docs/solutions/*.md`、ADR 是 append-only，写入即假设永远正确。本能层有 `decayInstincts`（[evaluate-session.js](../../scripts/evaluate-session.js) 衰减），但成熟知识层**零校验**。

**高频痛点铁证**：
- [[documented-claim-vs-code-reality-drift]] 反复出现：ADR-016~019 全写错「copyHookLibs glob 自动复制」假设，[[ADR-020]] 才勘误。
- 本 sprint（A）自身：差点基于「retrospective 是普通 command」错误前提硬做，勘察才发现它是项目级模板无 propagate。
- 这是本仓库 **#1 回归源**。

**agentic 影响**：知识库越大，agent 越信任注入知识 → 基于过时前提行动；自主链路越长，错误前提传播越远。

**代码现实（已勘察）**：[pre-commit-check.js](../../scripts/pre-commit-check.js) 已有 6 个成熟 checker（`checkPropagateSync:95` … `checkSolutionIndexSync:413`），统一 `checks.push` + findings + git staged 驱动模式。E 作**第 7 个 checker** 天然契合。

**缓解方案**：`checkKnowledgeDrift` — 扫 staged 的 `rules/solutions/ADR` md，校验其中代码引用是否还存在。分档控假阳性（关键）：

| 引用类型 | 校验 | 命中处理 |
|---------|------|---------|
| `path/to/file.js`（文件路径） | 文件是否存在 | 不存在 = **block**（确定 drift） |
| 行号 `:NN` | **不校验**（行号必随编辑漂移） | — |
| inline-code 符号 `` `funcName` `` / 常量名 | grep 符号是否在代码库存在 | 不存在 = **warn**（可能改名，不 block） |

**task 骨架**：
1. drift lib（`scripts/lib/knowledge-drift.js`）：解析 md 代码引用（文件路径 + inline-code 符号）→ 验证存在性
2. `checkKnowledgeDrift` 接入 pre-commit（仅 staged rules/solutions/ADR，避免全量慢）
3. **[[ADR-013]] §B dogfood（强制前置）**：先扫现有全部 rules/solutions/ADR 边界产物，FP 率压到 0 再合并（现有大量 `inject-context.js:25` 式引用，必须验证不误拒）
4. 三档负样本（[[feedback_negative_sample_3_archs]]）：pass / 引用删除的文件→block / 引用改名符号→warn
5. smoke scenarios（[[ADR-013]]：pass/fail/skip/fail-open 4 类）
6. 文档同步（新 ADR + README + 本 roadmap 状态更新）

**成功标准**：
- [x] 现有 rules/solutions/ADR 全部通过（0 FP，dogfood 验证）
- [x] 删除被引用文件 → checker block；改名被引用符号 → checker warn
- [x] pre-commit fail-open 保留（`--no-verify` 逃生 + try-catch marker）

**ROI**：高（5 年杠杆——知识库持续增长，drift 检测越老越值钱）。**张力**：假阳性（[[ADR-013]] §B dogfood 边界枚举强制压制，该协议已两次成功应用）；行号漂移（用文件/符号存在性而非行号缓解）。

**开 execution plan 前置勘察清单**：
- `scripts/pre-commit-check.js`：读 `checkSolutionIndexSync` 完整实现（最近的同类 checker，仿其结构）+ `module.exports` checker 注册方式
- `scripts/smoke-pre-commit.js`：现有 smoke scenario 结构（新 checker 必须配 smoke）
- 抽样 3-5 个 `docs/solutions/*.md` + `.claude/rules/debugging-gotchas.md`：实际代码引用格式（`file.js:NN` vs `` `func` `` vs `path/`），决定解析正则
- 确认引用解析的边界：中文文件名、相对路径、仓库外路径（[[ADR-013]] §B 已记录 checkPlanCompletion 踩过「仓库外路径 / inline-code 误匹配」FP）

---

## 缺陷 B：主动检索 MCP measure（P2）

> ✅ **done（2026-06-01）**：`active_retrieval_count` 加入 demand-side metric（`recall-usage.jsonl`），复用 A 管道零新 jsonl。filter 用 `/tp_memory_/`（采纳二次勘察发现 ①：`mcp__` 被 `normalizeToolName` 剥）。贯通 review-learnings `--recall` + SessionStart/Stop cost summary。无新 ADR（[[ADR-022]] 覆盖）。execution plan [[2026-06-01-mcp-retrieval-measure]]、solution [[2026-06-01-mcp-retrieval-measure]]。

**根因**：检索能力已存在，但 agent 主动检索靠自愿调用（**同缺陷 A 根因**）。

**代码现实修正（已勘察）**：B 不是「纯被动注入」——
- [prompt-submit.js:151](../../scripts/prompt-submit.js)：每轮 prompt 自动 `searchMemory`（query-aware，3000 chars budget，含 touchedFiles + sprintTags）。这是**半主动** recall。
- MCP 5 工具（`tp_memory_search` 等）：agent **可**主动调，但无调用纪律/telemetry。

真缺口 = 主动检索工具（MCP）无使用信号，且「让 agent 主动检索」撞 A 自愿根因。

**agentic 影响**：长会话里 SessionStart 注入很快过时，agent 不主动重查；prompt-recall 缓解但仍是 hook append 而非 agent 决策。

**缓解方案**（克制，measure-before-enforce）：
- ✅ measure MCP 工具调用率 + prompt-recall 注入是否被后续行为命中 → 用数据回答「agent 到底主动检索了没」
- ❌ 不强推「让 agent 主动检索」（撞 A 自愿根因，堆 enforcement 会 dead-on-arrival [[feedback_enforcement_dead_on_arrival_82pct]]）

**task 骨架**：
1. 扩展 [recall-usage.js](../../scripts/lib/recall-usage.js)：统计 observations 里 MCP memory 工具调用（`tool` 匹配 **`/tp_memory_/`**，**不是** `mcp__*`——`normalizeToolName` 剥前缀，详见上文「深化勘察发现 ①」）
2. 并入 `/review-learnings --recall` 审计 + 可选 cost summary 行
3. 测试 + parity

**成功标准**：
- [x] `--recall` 报告含「本周期 MCP 主动检索次数 / prompt-recall 注入被用率」
- [x] 复用现有 demand-side telemetry 管道，零新 jsonl

**ROI**：中（复用缺陷 A 设施，成本极低）。**张力**：小。**定位**：缺陷 A 的自然延伸——A 测「注入知识被用率」，B 测「主动检索发生率」，同一 telemetry 家族。

**开 execution plan 前置勘察清单**：
- `scripts/memory-mcp-server.js`：MCP 工具调用是否/如何进 observations（决定能否从 observations 统计）
- `scripts/observe.js`：MCP 工具调用的 observation 是否带 `tool` 字段 + 命名格式（`mcp__tech-persistence-memory__tp_memory_search`?）
- `scripts/lib/recall-usage.js`：复用 `buildRecallUsageMetric` 还是加独立字段

---

## 缺陷 C：同源验证异构 P0 复核（P3）

**根因**：sprint review 是同模型多视角（[review.md](../../user-level/commands/review.md) Spawn 协议，line 18，全 Claude 系，sonnet/haiku 分层但权重同源）。同模型有系统性盲区——同样的知识缺口导致同样漏判。

**代码现实（已勘察）**：[agent-orchestrator.js:26](../../scripts/agent-orchestrator.js) `PROVIDERS` 已有 codex 异构 provider，**但只用于 implementation**；review provider 默认 claude。异构基础设施**部分**在。

> **二次勘察修正**：C 实际裂成 **C1**（`/agent-loop` orchestrator，有宿主进程 → 可确定性强制异构 P0）/ **C2**（`/sprint` 的 `/review`，in-context spawn 无宿主进程 → 撞 [[ADR-021]] 天花板）——详见上文「深化勘察发现 ②」。当前 persona（高频 `/sprint`）下 C1 够不到主路径、C2 被封顶，**C 整体降级**。下方原始方案是合并视角，落地时按 C1/C2 拆分。

**agentic 影响**：agent 自主性越高，自审漏的 bug 越无人 catch。独立验证（异构模型 / 真实运行 / 形式化）是 agentic 安全刚需。

**缓解方案**（最小动作 + 强制 fallback）：
- review 的 **P0 finding** 经 codex 异构第二意见交叉验证（不是全异构 review——成本太高）
- **fallback（[[feedback_external_research_needs_fallback]] 强制）**：无 codex 时退化为「同模型 + 强制 ground-truth 实跑」（测试 / `--until`），不阻塞

**task 骨架**：
1. `review.md` 加「P0 异构复核」协议段（spawn-capable runtime + codex 可用时触发）
2. 复用 `PROVIDERS.review` 指向 codex 做 P0 复核 seam（或 review 阶段额外 spawn codex provider）
3. fallback 档：无 codex → P0 强制实跑测试验证后才放行
4. 双 runtime parity（propagate review + build + validate）

**若未来启用 C1，成功标准**：
- 有 codex：review P0 finding 经 codex 复核，分歧显式呈现给用户
- 无 codex：P0 退化为强制 ground-truth 实跑，不静默跳过
- BLOCKED escalation 与现有 `review.md` 强制人工 gate 一致

**ROI**：中高（catch 同源盲区 bug 价值高）。**张力**：codex 依赖（非所有用户装）+ 调用成本 + 轻量优先——故只复核 P0、必给 fallback。

**开 execution plan 前置勘察清单**：
- `scripts/agent-orchestrator.js`：`PROVIDERS` 完整结构（line 26）+ review provider 调用路径（`runProcess` 错误处理，见 [[debugging-gotchas]] claude -p stdout 错误）
- `user-level/commands/review.md`：Spawn 协议 + BLOCKED escalation 完整段（异构复核要复用 status 契约）
- `scripts/propagate-command-changes.js`：review 在 propagate 列表（改 review.md 后同步副本）
- 确认 codex 可用性探测机制（`agent-orchestrator.js doctor`）→ fallback 触发条件

---

## 缺陷 D：80/20 规划深度 rule（P4 — 补 rule，不写代码）

> ✅ **done（2026-06-01）**：规则落 `user-level/CLAUDE.md`（`## 规划深度规则` 完整矩阵）+ `user-level/commands/plan.md`（`## 规划深度自适应` 精简版，propagate → Codex parity）。parity 落点决策见 [[ADR-024]]；execution plan [[2026-06-01-planning-depth-rule]]、solution [[2026-06-01-planning-depth-rule]]。下方为原始规划，落地时勘察修正了落点（CLAUDE.md-only → 须落 propagate 命令，详见 [[ADR-024]]）。

**根因**：80/20（80% 规划审查）是 pre-agentic 假设（执行贵 → 重规划防返工）。

**代码现实（已勘察）**：sprint 已有 `[P]` task + worktree 并行执行（`work.md` Worker spawn 协议 + Agent `isolation:"worktree"`）。「执行并行」已支持。真缺口 = 规划阶段无「多方案并行探索」。

**诚实判断**：
- ❌ **不加 `--explore N`**（并行 N 方案选优）——撞「确定性优先」（N 方案选优引入不确定）+ 重 + 未证需求 + worktree 已能手动做。看着酷，实际 YAGNI。
- ✅ 只补 1 条轻量 rule：**任务类型 → 规划深度**映射（类比已有「测试深度跟风险走」L0-L4）。可逆/小任务允许快试错跳过重规划；不可逆/L4 保留 80/20。

**task 骨架**：在 `user-level/CLAUDE.md` 或 `rules/` 加「规划深度自适应」段（零代码）。

**成功标准**：
- [x] 一段 rule 定义「任务可逆性 × 规模 → 规划深度档位」，与现有测试深度 L0-L4 同构

**ROI**：代码层低、认知层高（想清楚 80/20 边界 > 写探索代码）。**这是「想清楚比写代码重要」的缺陷。**

**开 execution plan 前置勘察清单**：
- `user-level/CLAUDE.md` 测试规则段（仿其「深度跟风险走」结构写「规划深度」）
- 确认是否需 propagate（CLAUDE.md → AGENTS.md）

---

## 执行顺序 + 依赖

```text
已完成:
  E (drift checker) ──────── ✅ done（确定性化 + 直击 #1 回归源，[[ADR-023]]）

批次 1（低成本，可立即）:
  D (规划深度 rule) ───────── ✅ done（[[ADR-024]]：落 CLAUDE.md 摘要 + /plan 详版 Codex parity）
  B (MCP measure) ────────── ✅ done（active_retrieval_count 复用 A 管道，filter=tp_memory_）

批次 2（等用量信号）:
  C1 (agent-loop 异构 P0) ── 宿主进程在，可确定性强制；但只惠及 agent-loop 用户
  C2 (sprint 异构 P0) ────── 撞 [[ADR-021]] 天花板，暂缓
```

**建议（二次勘察后修正）**：E 已落地。下一步 **D + B 小批**（零代码 + 廉价 measure）。**C 整体降级**——C2 撞天花板、C1 等 agent-loop 用量信号；「do nothing on C」对当前高频 `/sprint` persona 合理。

---

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-06-01 | 创建 roadmap。承接缺陷 A（已落地）；B/C/D/E 详细计划 + 统一视角（B/C/E 是 A 的投影）+ 排序 + 每缺陷前置勘察清单。状态：planning，待逐个开 execution plan。 |
| 2026-06-01 | E 落地（[[ADR-023]]，status done）。二次勘察固化（开 plan 前 [[ADR-012]]）：① 发现 B filter `mcp__*` 会静默失效（`normalizeToolName` 剥前缀）→ 修正为 `tp_memory_`；② C 裂 C1（可确定性强制）/C2（撞 [[ADR-021]] 天花板）；③ 结合 persona 重排序 D+B 小批、C 降级。 |
| 2026-06-01 | D 落地（[[ADR-024]]，status done）。勘察修正落点：CLAUDE.md-only 有 Codex parity 缺口（Codex 不读 `~/.claude/CLAUDE.md`）→ 规则落 `/plan`（propagate）+ CLAUDE.md 摘要。剩 B（待开）、C（降级）。 |
| 2026-06-01 | B 落地（status done，无新 ADR——复用 [[ADR-022]] 设施）。`active_retrieval_count` 入 demand-side metric，filter `/tp_memory_/`（采纳二次勘察发现 ①）。剩 **C 降级**（C2 撞 [[ADR-021]] 天花板、C1 等 agent-loop 用量）。BCDE 中 B/D/E 已落、C 暂缓——roadmap 主体完成。 |
| 2026-06-01 | 收尾：roadmap 状态改 completed；B/D/E 成功标准回填完成；C 改 deferred，不伪装落地。 |
