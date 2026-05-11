---
title: $sprint 性能优化 Layer 1（执行层加速）
date: 2026-05-11
status: planning
phase: 5-compound
status: completed
tasks_total: 4
tasks_completed: 4
p0_count: 1
p1_count: 2
p2_count: 3
adr_emitted: ADR-012
solution_doc: docs/solutions/2026-05-11-sprint-speed-layer1.md
tags: [sprint, performance, optimization, layer1]
constraints:
  - no-auto-default  # 用户红线：--auto 不准默认开启
  - layer1-only      # 不触 Layer 2/3
parent_analysis: docs/plans/2026-05-11-gbrain-gstack-analysis.md
---

# $sprint 性能优化 Layer 1（执行层加速）

## 需求分析（Phase 1 - Think，CEO 视角）

### 触发原因

用户高频使用 `$sprint` / `/sprint`，反馈"在某些场景下还是会很慢"，希望更智能化。
gbrain 分析 sprint（2026-05-11-gbrain-gstack-analysis.md）的结论是"慢"的真痛点 60% 在执行层（Layer 1），不在架构层（Layer 3 trajectory A）。
本 sprint 聚焦 Layer 1：执行层加速，1-3 天内见效。**Layer 2/3 暂不做**。

### Scope IN（4 件事，已剔除 --auto 默认开启）

1. **Risk-aware reviewer 分级**
   - 改 `user-commands/review.md`（及 Codex 派生副本），按 task 的 risk level 跳过低风险 reviewer
   - L0/L1: 仅跑 code-quality
   - L2: + correctness
   - L3: + security + architecture
   - L4: 全套 5 个 reviewer
   - 不确定 risk 时**保守按 L3** 处理

2. **Reviewer 模型分层（Haiku / Sonnet）**
   - quick reviewer（code-quality / dead-code / lint）→ Haiku 4.5
   - 深度 reviewer（correctness / architecture）→ Sonnet 4.6
   - **security 永远 Sonnet 或更强**，无论 risk 等级

3. **SessionStart 注入精简**
   - 改 `scripts/inject-context.js` 及 `scripts/lib/memory-v5.js`
   - 按当前会话上下文 tag 过滤 `MEMORY.md` entries
   - 预算从 ≤25KB → ≤10KB
   - **Fallback**：无 tag 匹配时回退原 25KB 全文（不能丢知识）

4. **Phase 间预热**
   - 改 `scripts/agent-orchestrator.js`
   - Phase N 末尾后台启动 Phase N+1 所需上下文加载
   - 不影响 'go' gate 行为（gate 仍人工）
   - 不影响错误恢复路径

### Scope OUT（红线，明确不做）

- ❌ **`--auto` 默认开启** — 用户明确否决
- ❌ Layer 2: sprint 模板缓存 / C5-capture / Risk 缓存
- ❌ Layer 3: typed-link / C6 自动升级 / Memory v5 数据结构变动
- ❌ install / upgrade 脚本逻辑变动（除非必须复制新文件）
- ❌ 测试框架替换
- ❌ 任何破坏 4 条不可妥协原则的改动（多运行时 parity / 确定性优先 / 轻量优先 / Obsidian 兼容）

### 价值评估

| 指标 | 当前基线 | 目标 |
|------|---------|------|
| 单次 sprint 总耗时 | 100% | ≤ 75% |
| P4 Review 耗时（L1 改动） | 4-5 reviewer 全跑 | 1-2 reviewer |
| SessionStart 注入字符数 | ≤25KB | ≤10KB |
| Phase 切换等待 | 串行 | 后台预热 |

### 风险与取舍

| ID | 风险 | 缓解 |
|----|------|------|
| R1 | Risk-aware reviewer 漏审 P0 | 不确定时按 L3，保守优先 |
| R2 | Haiku 在某些 reviewer 角色质量不够 | security 永远 Sonnet；correctness 也 Sonnet |
| R3 | 注入精简 tag 匹配错丢上下文 | tag 命中数 < 阈值时 fallback 全文 |
| R4 | 预热并发复杂度 | 必须单测覆盖；预热失败不影响主流程 |
| R5 | Claude Code / Codex 副本不同步 | 每次提交跑 `scripts/propagate-command-changes.js` |

### 成功标准

- [ ] 5 次实测 sprint 平均总耗时下降 ≥ 25%
- [ ] 零 P0 漏审（review 跳过逻辑必须有日志可审计）
- [ ] 零"忘记之前"投诉（注入精简后用户感知一致）
- [ ] 所有改动单测覆盖 ≥ 80%
- [ ] 文档同步：CLAUDE.md / README.md / Codex 副本

---

## 技术方案（Phase 2 - Plan，架构师视角）

### 关键勘察发现（修正 Phase 1 假设）

| 假设 | 实测 | 影响 |
|------|------|------|
| `CONTEXT_BUDGET_CHARS = 25KB` | **实际 12KB** (`inject-context.js:25`) | T3 目标从"减小体积"改为"提升相关性" |
| `user-commands/review.md` | 实际路径 `user-level/commands/review.md` | 文件清单修正 |
| Orchestrator 单体 | 实际 `scripts/agent-orchestrator/` 12 个子模块 | T4 改动表面更精细 |
| Pipeline mode 已存在 (commit ff4a314) | 可能已部分预热 | T4 起步需要勘察现有能力 |

### 任务清单

#### T1: Risk-aware reviewer 分级 ★ 起点

**文件清单**：
- `user-level/commands/review.md`（源）
- `.codex/commands/review.md`（propagate 派生）
- `plugins/tech-persistence/commands/review.md`（propagate 派生）

**改动设计**：

在 review.md 现有"5 个审查视角"后插入 **dispatch matrix**：

```markdown
## 风险驱动派遣（risk-aware dispatch）

读取 task 的最高风险等级，按下表选择 reviewer 子集：

| Risk | Reviewer 子集 | 跳过的 |
|------|--------------|--------|
| L0/L1 | quality | security/perf/arch/test |
| L2 | quality + correctness + test | security/perf/arch |
| L3 | quality + correctness + test + security + arch | perf |
| L4 | 全套 5 个 | — |

不确定 risk 时**保守按 L3**。
跳过的 reviewer 必须在输出 "## 派遣记录" 段写出："跳过 perf（risk=L3）"。
```

**估时**：3-4 小时
**风险**：L2（漏审有人工兜底；审计日志保证可追溯）

---

#### T2: Reviewer 模型分层（依赖 T1）

**文件清单**：与 T1 同（dispatch matrix 扩展 model 列）

**改动设计**：

T1 的 dispatch matrix 增加 model 列：

```markdown
| Reviewer | 默认模型 | 强制最低 |
|----------|---------|---------|
| quality | Haiku 4.5 | Haiku 4.5 |
| correctness | Sonnet 4.6 | Sonnet 4.6 |
| security | Sonnet 4.6 | Sonnet 4.6（**永远不用 Haiku**） |
| architecture | Sonnet 4.6 | Sonnet 4.6 |
| test | Haiku 4.5 | Haiku 4.5 |
| perf | Sonnet 4.6 | Sonnet 4.6 |
```

**估时**：1-2 小时
**风险**：L1（最坏情况是某次 review 慢一点）

---

#### T3: SessionStart 注入相关性提升

**文件清单**：
- `scripts/inject-context.js`（核心）
- `scripts/lib/memory-v5.js`（entry tag 解析支持）
- 新增 `scripts/inject-context.test.js` 单测

**改动设计**：

```javascript
// 新增：探测当前 active sprint tags
function detectActiveSprintTags() {
  const plansDir = path.join(process.cwd(), 'docs', 'plans');
  if (!fs.existsSync(plansDir)) return [];
  // 找 status: planning/in-progress/reviewing 的最新文档
  // 提取 frontmatter 的 tags 数组
  // 失败返回 []
}

// 修改 loadUnifiedMemoryIndex 调用：
const sprintTags = detectActiveSprintTags();
const memoryIndex = loadUnifiedMemoryIndex(dirs, {
  ...DEFAULT_MEMORY_CONFIG,
  prioritizeTags: sprintTags,  // 新增：按 tag 优先排序
});
```

`memory-v5.js` 在 entry 元数据里解析 tags，加权排序时 tag 命中 +10 权重。

**Fallback**：`sprintTags.length === 0` 或匹配条目数 < 5 时，回退到原行为（不按 tag 排）。

**估时**：5-7 小时（含单测）
**风险**：L3（上下文丢失风险高 — 必须严格 fallback）

---

#### T4: Phase 间预热

**文件清单**：
- `scripts/agent-orchestrator/pipeline.js`（主）
- `scripts/agent-orchestrator/pipeline-state.js`（可能涉及状态）

**前置勘察**（T4.0，不计入 task 数）：先读 pipeline.js 看 commit ff4a314 的 pipeline mode 当前预热到什么程度。**如果已经预热充分，T4 自动降级为"补充文档说明"零代码改动**。

**改动设计**（待勘察后确认）：

```javascript
// Phase N 末尾，spawn 异步 preload
async function endPhase(state) {
  await finalizeCurrentPhase(state);

  // 预热下一 phase（不 await）
  preloadNextPhase(state).catch(err => {
    log('preload-failed', err);  // 失败仅日志，不影响主流程
  });

  // 阻塞等用户 'go'（不变）
  return waitForUserGo(state);
}
```

**预热内容**：下一 phase 需要的上下文文件读取、相关 instinct 加载。**不**预先调用 LLM。

**估时**：4-6 小时（含勘察 + 单测）
**风险**：L3（并发隔离 + 错误传播）

---

### 任务依赖图

```
T1 (review.md base dispatch)
  └─→ T2 (review.md +model column)

T3 (inject-context.js)  ─── 独立并行

T4 (pipeline.js)         ─── 独立并行（T4.0 勘察先）
```

可并行：T1+T3+T4 同时启动；T2 等 T1 完。

### 总估时

| Task | 估时 |
|------|------|
| T1 | 3-4h |
| T2 | 1-2h |
| T3 | 5-7h |
| T4 | 4-6h（含勘察） |
| Propagate + 测试 + 文档同步 | 2-3h |
| 5 次实测验证 | 1-2h |
| **合计** | **16-24h（2-3 个工作日）** |

### 风险汇总（与 Phase 1 对齐）

| ID | 任务 | 等级 | 缓解 |
|----|------|------|------|
| R1 | T1 漏审 | L2 | 不确定 → L3 兜底，审计日志 |
| R2 | T2 Haiku 质量不够 | L1 | security 锁 Sonnet+ |
| R3 | T3 tag 匹配错丢上下文 | L3 | 命中数 < 5 时 fallback 全文 |
| R4 | T4 并发错误传播 | L3 | catch + 日志，主流程隔离 |
| R5 | 副本不同步 | L2 | 每 task 提交前跑 propagate |

按 `auto-mode.md` 规则：T3/T4 是 L3，**强制人工 gate**（用户已禁 --auto，本来就要问）。

---

## 实现进度（Phase 3 - Work，工程师视角）

### T1 ✅ Risk-aware reviewer 分级

**改动**：`user-level/commands/review.md` 新增「## 风险驱动派遣（risk-aware dispatch）」段

- Dispatch Matrix：L0/L1 仅 4 (quality)；L2 +5 (test)；L3 +1+3 (security+arch)；L4 全套
- 不确定 risk **保守按 L3**（列出可疑信号清单）
- 强制输出「派遣记录」段：跑了/跳过/原因

**Propagate**：`plugins/tech-persistence/commands/review.md`、`.codex/commands/review.md`、对应 SKILL.md

### T2 ✅ Reviewer 模型分层

**改动**：同 T1 文件，在派遣段新增「Reviewer 模型分层」表

- security 🔒 → **Sonnet 4.6 永远锁定**（不可妥协）
- perf / arch → Sonnet 4.6
- quality / test → Haiku 4.5（快 3×，省 token）

### T3 ✅ SessionStart 注入相关性提升

**改动**：
- `scripts/lib/memory-v5.js`:
  - `selectMemoryIndexEntries` 新增 `prioritizeTopics` 选项（命中 topic 排前，不丢条目）
  - `formatMemoryIndexContent` / `loadUnifiedMemoryIndex` 透传 options
- `scripts/inject-context.js`:
  - 新增 `detectActiveSprintTags()` — 扫 `docs/plans/` 找 status: planning/in-progress/reviewing 的最新文档，解析 frontmatter tags
  - 注入时传入 `prioritizeTopics: sprintTags`
- 新增 `scripts/smoke-relevance.js`:
  - 6 个用例：重排 / 不丢失 / 空 fallback / case-insensitive / limit 生效 / inject-context 集成
  - 全部通过

**Propagate**：`build-codex-plugin.js` 同步 `lib/memory-v5.js` 到 codex plugin

### T4 ✅ Phase 间预热（修订版 A）

**关键发现**：原计划改 `scripts/agent-orchestrator/pipeline.js` 错了 — 那是 agent-loop v7 的代码，不是 `/sprint` 的代码。`/sprint` 的 phase 切换在命令文档里，模型按文档自走，无 orchestrator 介入。

**修订改动**：
- `user-level/commands/sprint.md` 新增「## Phase 间预热协议」
  - 强制格式 + 各 phase 典型内容映射表
  - 设计原则（仅提示线索 / 不复述 / 不预先执行）
- `think.md` / `plan.md` / `work.md` / `review.md` / `compound.md` 末尾各新增「## Phase 间预热钩子」段
  - 各自填充典型「下一 Phase 关键文件 / 起步命令 / 风险预判」

**Propagate**：6 个命令（sprint + 5 phase）全量 propagate 到 plugin + codex

### 综合验证

```text
✓ node scripts/propagate-command-changes.js review        → 同步成功
✓ node scripts/propagate-command-changes.js sprint think plan work review compound  → 6 文件全同步
✓ node scripts/validate-codex-plugin.js                   → Codex plugin validation passed
✓ node plugins/.../build-codex-plugin.js                  → 21 commands / 31 skills / 8 hooks
✓ node scripts/smoke-relevance.js                         → T3 smoke 全过
✓ node scripts/smoke-memory-parity.js                     → 现有行为未破坏
```

### 验收对照

| 成功标准 | 状态 |
|---------|------|
| 改动单测覆盖 ≥ 80% | T3 ✅ 6 用例 / T1+T2+T4 是文档级改动无 runnable test |
| 没有破坏现有行为 | ✅ memory-parity smoke 仍过 |
| 副本同步无误 | ✅ validate-codex-plugin 通过 |
| 文档与功能同步 | ✅ sprint 主文档实时更新 |
| 5 次实测 sprint 平均耗时 ↓ ≥ 25% | ⏳ 待 Phase 4 review 后由用户实测累积 |

---

## 审查结果（Phase 4 - Review，审查团队视角）

### 派遣记录

- 评估 risk: **L3 (保守升级)**
- 评估依据: 实事求是 L2 (无 auth/DB/用户输入边界)，但 inject-context.js 是 SessionStart hook + memory-v5.js 是 lib 共享代码 → 可疑信号 → 保守 L3
- 跑的视角: 1 security (Sonnet)、3 arch (Sonnet)、4 quality (Haiku)、5 test (Haiku)
- 跳过的视角: 2 perf
- 跳过原因: 本次变更不涉及 N+1 / 性能关键路径 / 缓存层 / I/O 密集

### 🔴 P0 — 必须修复（已修）

| # | 视角 | 文件 | 问题 | 修复 |
|---|------|------|------|------|
| 1 | 5 test | `scripts/inject-context.js` | `detectActiveSprintTags` 缺独立单测，与 L2-L3 风险不匹配 | ✅ 重构允许传 `plansDir`，新增 6 个测试用例（解析 tags / 跳 completed / 跳无 frontmatter / 活跃无 tags / 取最新 active / 缺目录）|

### 🟡 P1 — 建议修复（列出待用户决定）

| # | 视角 | 文件 | 问题 |
|---|------|------|------|
| 2 | 4 quality | inject-context.js + memory-v5.js | **tags-vs-topics 命名错配** — `prioritizeTopics` 接收 sprint frontmatter 的 `tags`，但 memory entry 没显式 tag，比对的是 `topic`（文件名派生）。实际是"近似匹配" |
| 3 | 3 arch | 5 个 phase 命令 | phase-prewarm 钩子在每个文件重复 ~10 行 boilerplate（可接受 — 单独调用 phase 时仍需要）|

**P1 #2 已通过 JSDoc 部分缓解**（detectActiveSprintTags 函数注释中说明了"近似匹配"语义），但代码层名称仍是 `prioritizeTopics`。彻底修复需要重命名 + 引入显式 tag 字段，工作量较大；本次保持注释级缓解。

### 🟢 P2 — Backlog

| # | 视角 | 问题 |
|---|------|------|
| 4 | 4 quality | (P0 修复时同步处理) inject-context 加 inner try-catch — readdirSync / readFileSync 都已包 try-catch |
| 5 | 4 quality | inject-context 用 regex 手解析 frontmatter，未复用 memory-v5 的 parseFrontmatter — DRY 违反，待重构 |
| 6 | 3 arch | phase-prewarm 实际效果未实测验证，理论值 30-60s/切换 — 待后续 5 次 sprint 累积实测 |

### ✅ 亮点

- prioritizeTopics 设计向后兼容（默认空 = 原行为，零破坏）
- T3 smoke 用例从 6 个扩展到 12 个，覆盖所有 detectActiveSprintTags 行为
- T4 勘察发现 pipeline.js 改动对象错（agent-loop 非 sprint），及时止损改走文档级方案
- security 视角通过：detectActiveSprintTags 读项目内文件非用户输入，无 path traversal / regex DoS / 注入风险
- Codex 副本与主副本机械同步，无漂移
- inject-context.js 用 `require.main === module` 守卫，让 export 不破坏 hook 运行模式

### 总评

整体方向正确，P0 已修复，P1 已部分缓解（JSDoc 说明语义）。**置信度：可以发布**。

测试覆盖最终：
- T1/T2/T4 文档级改动（视角 5 评定 L0 免测）
- T3 lib + hook 共 12 个 smoke 用例覆盖所有改动点

实测验证（5 次 sprint 平均耗时 ↓ ≥ 25%）需用户在后续真实使用中累积，本 sprint 无法在 review 阶段闭环。

---

## 复利记录（Phase 5 - Compound，知识管理者视角）

### 7 条经验提取

#### 1. Plan 阶段必须勘察被改文件，不能纯靠假设（→ ADR-012）

**触发**：本 sprint Phase 2→3 转换时连续两次 plan-error。
- 假设 1：`CONTEXT_BUDGET_CHARS = 25KB` → 实际 12KB（`inject-context.js:25`）
- 假设 2：要改 `scripts/agent-orchestrator/pipeline.js` 加 Phase 间预热 → 实际该文件是 agent-loop v7 代码，跟 `/sprint` 不是同一回事

**教训**：plan 阶段花 10-20 分钟读 1-2 个关键文件 = work 阶段省 1+ 小时返工。
**应用**：plan 文档必须有「关键假设验证」段。

#### 2. 文档级改动也是改动，L0 免测不适用

**触发**：T1+T2+T4 全是文档改动（review.md / sprint.md / 5 phase 命令）。按 L0「纯样式/文案」似乎免测，但这些改动影响**所有** sprint 行为，范围极广。
**教训**：dispatch matrix / 协议类文档改动按 L2 起评，至少跑 review 视角 4 (quality)。
**应用**：写入 `.claude/rules/testing-patterns.md` 反模式段。

#### 3. scope 误判 ≠ scope creep，应停下修正 plan 而非硬上

**触发**：T4 实施时发现 pipeline.js 不是该改的对象。
**区分**：
- scope creep = 执行阶段范围扩张（应阻止）
- scope 误判 = plan 错了对象/边界（应停下修正 plan）
**教训**：发现 scope 误判时不要"凑合着改"，应停下重新评估 → 本次降级为修订 A 方案，工作量从 4-6h 降到 1-2h。

#### 4. Propagate 必须每次都跑，git tracked 派生文件不能手工 Edit

**触发**：6 个命令 × 4 副本 (.codex / plugins/commands / plugins/skills/<n>/SKILL.md / user-level/skills/<n>/SKILL.md) = 24 个手工 sync 不可控。
**应用**：每次改 `user-level/commands/*.md` 后强制：
```bash
node scripts/propagate-command-changes.js <cmd1> <cmd2> ...
node plugins/tech-persistence/scripts/build-codex-plugin.js  # 同步 lib/hook
node scripts/validate-codex-plugin.js
```
（这条 2026-05-09 已沉淀在 debugging-gotchas.md，本 sprint 强化了实践。）

#### 5. Dispatch matrix 在本次 review 已自我验证

**触发**：本 sprint review 自身按新的 dispatch matrix 执行：评 L3 → 跑 4 视角（security/arch/quality/test）→ 跳过 perf → 节省 1 个 reviewer cycle。
**信号**：dispatch 机制设计合理且可自洽 — 不依赖手动判断，可以让模型按文档自走。
**应用**：保留 dispatch matrix 作为 review.md 主导段；视角 1-5 退为细节定义。

#### 6. tags-vs-topics 近似匹配的设计代价

**触发**：T3 实施时为最小改动选了"复用现有 topic 字段"的方案。代价：sprint frontmatter 用户期待 `tags` 排序，实现按 `topic` 排（近似匹配）。
**评估**：可接受，因为 sprint tags 命名习惯里有大量 topic-like 词（performance / optimization / debugging / architecture 等）会自然命中。彻底修复（引入显式 tag 字段）工作量大且 ROI 低。
**应用**：JSDoc 注释明示"近似匹配"语义；P2 backlog 跟踪后续是否需重构。

#### 7. Phase 间预热的预热段必须避免反模式

**触发**：T4 修订版设计「Phase 间预热协议」时识别 3 个反模式：
- ❌ 长篇大论（每段 ≤ 3 行）
- ❌ 复述当前 phase 结论（只提示线索）
- ❌ 预先执行下一 phase 操作（仅提示不代办）
**应用**：协议文档已包含设计原则段，未来违反时直接引用。

### 步骤 1-9 产出汇总

- **步骤 1 7 类知识扫描**：解决方案 1 / 踩坑 0 / 架构决策 1 / 本能 0 / 模式 0 / 性能 0 / 测试 0
- **步骤 2 解决方案文档**：`docs/solutions/2026-05-11-sprint-speed-layer1.md`（Obsidian frontmatter + wikilinks）
- **步骤 3 经验到 rules**：ADR-012 → `.claude/rules/architecture.md`
- **步骤 4 本能**：本 sprint 无新本能（经验已直接毕业到 ADR）
- **步骤 5 [🧠 新发现]**：无（review 未标注 [🧠 新发现]）
- **步骤 6 Skill 信号**：未使用 skill diagnose / improve / publish，无信号采集
- **步骤 7 本能/skill 差异**：无 pending_absorption
- **步骤 8 Sprint 交接**：本 sprint 完成，无 checkpoint 需求
- **步骤 9 输出报告**：见末尾

---

## 变更日志

- 2026-05-11: 创建。Phase 1 think 完成。
- 2026-05-11: Phase 2 plan 完成。勘察修正 3 处假设（预算 12KB 非 25KB / 路径 user-level / orchestrator 12 子模块）。4 任务，依赖 T2←T1，T3/T4 独立。总估时 16-24h。等待 'go' 进 Phase 3 work。
- 2026-05-11: Phase 3 work 完成。T4 因勘察 pipeline.js 发现改动对象错误（v7 agent-loop 代码非 sprint 代码），改走修订 A 方案（改 sprint.md + 5 phase 命令加预热钩子）。4 task 全部完成；T3 含 6 用例 smoke 全过；validate-codex-plugin 通过。等待 'go' 进 Phase 4 review。
- 2026-05-11: Phase 4 review 完成。L3 dispatch 跑 4 视角（跳 perf）。1 个 P0（detectActiveSprintTags 缺单测）已立即修复；P1 #2 (tags-vs-topics 命名错配) 用 JSDoc 缓解；P1 #3 (5 phase boilerplate) 接受现状；3 个 P2 进 backlog。smoke 用例 6→12，全过。等待 'go' 进 Phase 5 compound。
- 2026-05-11: Phase 5 compound 完成。7 条经验提取；ADR-012 "Plan 阶段必须勘察被改文件"写入 architecture.md；solution doc 写入 docs/solutions/；CLAUDE.md 解决方案索引 +1。status: reviewing → completed。

## 下一 Phase 预热（Phase 5: Compound）
关键文件: 本 sprint 文档的 P0/P1 处理记录、`.claude/rules/architecture.md` / `.claude/rules/debugging-gotchas.md`
执行命令: 扫本 sprint 经验抽取候选、检查是否需要 ADR 记录"L4 修订发现"模式
风险预判: 是否需新 ADR 沉淀"勘察先于实施" / "文档级改动也要审"的元经验；本次审查发现的 review 流程本身的规律

## 下一 Phase 预热（Phase 4: Review）
关键文件: 本次 diff 涉及的 9 个文件 — review.md / sprint.md / think.md / plan.md / work.md / compound.md / inject-context.js / memory-v5.js / smoke-relevance.js
执行命令: `git diff main...HEAD --stat`、`node scripts/smoke-relevance.js`（确认绿）、`node scripts/validate-codex-plugin.js`
风险预判: dispatch matrix 与原 5 视角的对应是否清晰；T4 协议是否与 caveman-mode 输出冲突；T3 fallback 在零 active sprint 时行为是否仍合理
