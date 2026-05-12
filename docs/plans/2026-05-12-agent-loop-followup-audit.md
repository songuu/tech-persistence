---
title: "Agent Loop follow-up 闭环度审计"
type: audit
status: completed
created: "2026-05-12"
updated: "2026-05-12"
checkpoints: 0
tasks_total: 3
tasks_completed: 3
tags: [audit, agent-loop, agent-orchestrator, followup, read-only]
aliases: ["agent-loop audit", "agent-loop follow-up 核验"]
related_solutions:
  - "2026-04-27-agent-orchestrator-v6"
  - "2026-05-09-agent-loop-caveman-audit"
related_plans:
  - "2026-05-09-agent-loop-pipeline"
---

# Agent Loop follow-up 闭环度审计

> **Status:** `completed`
> **Created:** 2026-05-12
> **Read-only audit** — 不修代码、不动副本、不改 sprint plan 文档。

## 需求分析

### 要做

- 枚举 `/agent-loop` / `agent-orchestrator` 相关的全部 follow-up（5 个文档源 + CLAUDE.md 索引 3 条 + ADR-003/004/009 + debugging-gotchas）
- 在当前代码 / 文档 / 测试里核验每条的闭环度：closed / partial / still-open / wont-fix-now
- 输出可操作的建议（不直接修复）

### 不做

- 不修代码、不写新功能
- 不跑 `/agent-loop run` 实际 dogfood
- 不做 shell-mismatch / 跨副本飘移扫描（另一个角度）

### 成功标准

- [x] 每个 follow-up 标记状态 + ≥1 个 file:line 证据
- [x] still-open 项给出反证（不是「感觉还没做」）
- [x] 报告末尾给「下一 sprint 建议候选」≤3 条

### 风险和假设

- 部分 follow-up 是模糊建议（如「下道防线 CI test」），核验时易主观
- audit 边界发散到非 agent-loop 主题。对策：只追 ADR-003/004/009 + CLAUDE.md 3 条索引的直系 follow-up

---

## 关键假设验证

ADR-012 要求 plan 阶段勘察被改/被读的关键文件，逐条验证假设：

| 假设 | 验证手段 | 文件:行 | 结论 |
|------|----------|---------|------|
| `scripts/agent-orchestrator.js` 是源副本，plugins/ 是派生 | `git ls-files plugins/tech-persistence/scripts/` + Glob 双侧 | plugins/tech-persistence/scripts/agent-orchestrator.js git-tracked | ✓ 确认 |
| pipeline mode 模块在 `scripts/agent-orchestrator/` 子目录 | Glob 子目录 | 12 个 .js 文件存在 | ✓ 确认 |
| `extractProviderEnvelopeError` 已实现 | Grep | `scripts/agent-orchestrator.js:558` + self-test 1901-1906 | ✓ 确认 |
| `doctor` / `preflight` 子命令已实现 | Grep + Read | `scripts/agent-orchestrator.js:1683/1700/1730/1783/1813` | ✓ 确认 |
| `--auto-evaluate` + `--auto-freeze` 已实现 | Grep | `scripts/agent-orchestrator.js:2464-2465` | ✓ 确认 |
| `propagate-command-changes.js` 存在 | Glob | `scripts/propagate-command-changes.js` | ✓ 确认 |
| `pre-commit-check.js` 检查 commands/rules 同步 | Grep `kind: 'command'` / `kind: 'rule'` | `scripts/pre-commit-check.js:109,124,135` | ✓ 确认 |
| `pre-commit-check.js` **不**检查 scripts/agent-orchestrator 同步 | Grep `agent-orchestrator` 全文件 | 仅出现 1 次于 `scripts/pre-commit-check.js:222`（修复命令文本，非 kind 分支） | ✓ 缺口确认 |
| 当前根/plugin agent-orchestrator 副本一致 | sha256 全 12 子模块 + 主文件 | 13 个文件全部 EQUAL（hash 一致） | ✓ 当前态干净，但无 enforcement |

会拒绝哪些现有产物：本 sprint 仅新增 1 个 plan 文档，不修改任何 lint 规则、不调 reviewer 阈值；pre-commit-check 不变。

---

## 技术方案

本 sprint 是 read-only audit，无实现方案。流程：

1. 机械提取 follow-up 候选清单（已含在 plan 阶段，下方矩阵）
2. 逐条 grep / Read 当前态证据
3. 输出闭环度矩阵 + Top-N 建议

---

## 任务拆解

- [x] T1: 枚举 follow-up 候选（task #33）
- [x] T2: 逐条核验闭环度（task #34）
- [x] T3: 写本报告（task #35）

---

## 审查结果

### Follow-up 闭环度矩阵

| ID | 描述 | 状态 | 证据 |
|----|------|------|------|
| F1 | pipeline plan P0/P1 表「待实现后审查 \| open」 | **still-open** | `docs/plans/2026-05-09-agent-loop-pipeline.md:617-622` 全是占位行 |
| F2 | pipeline plan 复利记录「待实现后由 /compound 评估」 | **still-open** | `docs/plans/2026-05-09-agent-loop-pipeline.md:642-645` 仍为「待实现完成后...」 |
| F3 | 真实 `claude` / `codex` CLI e2e 冒烟 | **still-open** | `.github/workflows/` 不存在；`scripts/smoke-*` 仅覆盖 memory / pre-commit / relevance；`doctor --probe`（`scripts/agent-orchestrator.js:1813-1830`）作为起点已具备，需在有 CLI 的环境执行 |
| F4 | pipeline v2 多 worker + per-slice worktree + merge queue | **wont-fix-now** | `docs/plans/2026-05-09-agent-loop-pipeline.md:627` 显式 P2 deferred |
| F5 | 派生副本从 git 移除，改 release-time 生成 | **wont-fix-now** | `.gitignore` 未排除 plugins/；架构债，需另起 sprint 决策 |
| F6 | provider 错误 envelope 提取 + `doctor --probe` | **closed** | `scripts/agent-orchestrator.js:546-558` + self-test 1901-1906 + 1813-1830 doctor probe |
| F7-1 | doctor / self-test 在 dispatch 段显式分派 | **closed** | `user-level/commands/agent-loop.md:32,33,51,52,74,82,90` |
| F7-2 | plugin 文案 "Codex 的 /agent-loop" → "Claude Code 的 /agent-loop" | **closed** | Grep 全仓库已无 "Codex 的 /agent-loop"（仅在 audit doc 中作为修复记录引用） |
| F7-3 | `buildUntrackedDiff` 修正 \n 结尾 / 空文件 / no-newline 标记 | **partial** | `scripts/agent-orchestrator.js:1367-1387`：`\r?\n` split 修了 \n 结尾，但空文件仍输出 `@@ -0,0 +1,1 @@`（应为 0,0），无 `\ No newline at end of file` marker，**无 self-test** |
| F7-4 | `loadRun` 入口防御 `state.providerRuns` / `state.files` 缺字段 | **still-open** | `scripts/agent-orchestrator.js:257-262` 直接 `readJson` 返回，无 default；`newState`（line 1538）正确初始化，但 caveman-audit 之前的旧 `state.json` resume 仍会炸 — ADR-008 明确要求**入口处统一 default** |
| F7-5 | `runResume` 显式处理 `completed` / `failed` 状态 | **still-open** | `scripts/agent-orchestrator.js:1768-1796` 仅枚举 `dry-run` / `spec-ready` / `frozen` / `needs-followup` / `blocked` / `implemented`；`completed` 状态走到末尾打印 summary，**无显式拒绝/提示** |
| F7-6 | validation 日志加时间戳 | **partial** | `scripts/agent-orchestrator.js:1444-1445` 每条 result 有 `startedAt` / `finishedAt`，**顶层 `validation.json` 无 `generatedAt`**（对比 `preflight.json:1651` 顶层有 generatedAt） |
| F7-7 | `follow-up-task.md` findings 行式格式 `[P0] file:Lline: msg — fix:...` | **partial** | `scripts/agent-orchestrator.js:1077-1084` `arrayLines` 对字符串 OK，**对象 fallback 到 `JSON.stringify(item)`**；当 review provider 输出结构化 finding 对象时仍为 JSON 字面 |
| F7-8 | `runResume` 增加 `--no-review` / `--review-only` / `--implementation-only` 拆分人工 gate | **still-open** | Grep 全文件 0 匹配 |
| F7-9 | `propagate-command-changes.js` 自动化多副本同步 | **closed** | 脚本存在，pre-commit-check 检查 commands（kind:command）和 rules（kind:rule）同步 |
| F8/F9 | plugin `scripts/agent-orchestrator*` 副本同步 enforcement | **still-open** | `scripts/pre-commit-check.js` 仅检查 `kind:'command'`（line 109,116,124）和 `kind:'rule'`（line 135），**无 `kind:'orchestrator'` 或类似分支**；当前态 sha256 全 13 文件 EQUAL，但下次重构若忘跑 `build-codex-plugin.js`，commit 不会被拒 — 与已修的 nul 回归同款风险模型 |

**统计**：closed 4 / partial 3 / still-open 6 / wont-fix-now 2 = 总 15 项。

### 严重度排序（still-open 中）

按「重构后回归概率 × 用户感知度 × 修复成本」三维度排：

| 优先级 | ID | 理由 |
|--------|----|------|
| **P0** | F8/F9 | 与 2026-05-12 nul fix 同款风险模型（多副本飘移）；nul 本能 [[windows-hook-bash-portability]] 已声明「N≥2 = 工具链升级」；commands/rules 已升级到 pre-commit，唯独 scripts/ 还在裸奔。下次有人改 scripts/agent-orchestrator/*.js 忘跑 build 就回归。**视为单个原子修复**：pre-commit-check 加一个 `kind:'orchestrator'` 分支同时校验 `scripts/agent-orchestrator.js` 主文件 + `scripts/agent-orchestrator/*.js` 全部子模块的根/plugin sha256 一致 |
| **P0** | F7-4 | ADR-008 明示「loadRun 入口统一 default」，当前实现只在 newState 初始化 — 旧 state.json resume 必崩；修复 5 行代码 + 1 self-test。**注意：F7-4 是 F7-5 的前置条件** — `runResume` line 1785 写 `state.files.preflight = ...`，若 state.files undefined 直接 crash，先修 F7-4 再修 F7-5 |
| **P0** | F1+F2 | pipeline mode plan 13 task 已 implemented，但 P0/P1 表 + 复利记录全是占位行。**这不是单纯的流程债，而是 sprint 模板的 broken example** — 别人模仿这份 plan 会以为「implemented = completed」，让流程协议失去示范价值。**最小修复**：把 plan frontmatter `status: implemented` 改为 `status: partial`（明示 sprint 未走完）；如需完整闭环则另起 retrospective sprint |
| **P1** | F7-5, F7-8 | resume 状态机鲁棒性 + 拆分人工 gate — F7-5 已被 F7-4 阻塞列出；F7-8 `--review-only` / `--no-review` 对当前手工 workflow 影响小，可延后 |
| **P2** | F3 | e2e 真打 CLI — 需要用户在**仓库 CI 外**的有 token 环境跑，本质是"灰盒回归"，`doctor --probe` 已是起点但严格说不算端到端 e2e；自动化代价远高于人工偶发回归，wont-fix-now 合理 |
| **P3** | F7-3, F7-6, F7-7 | 边角细节，无人正向反馈缺这些功能 |

### P0 — 必须修复

本 audit sprint 无代码改动；P0 留给下个 sprint。

### P1 — 建议修复

本 audit sprint 无代码改动。

### P2 — 可选优化

本 audit sprint 无代码改动。

### 总评

`/agent-loop` 子系统已度过 v6 → caveman-audit → pipeline mode → provider-error-ux 4 轮迭代，主路径稳定，CLAUDE.md 索引中的 3 条沉淀都有实代码支撑。但 2026-05-09 caveman-audit 中的 8 条 fix 有 4 条声称已实施但 grep 不到（partial 或 still-open），属于"文档先行，代码滞后"的回归——这跟刚修的 nul fix 同款问题：纯文档协议抵不住时间推移和重构。

最显著的缺口是 **plugin 副本同步 enforcement**（F8/F9），它跟 nul fix 一致地需要升级到工具链层（pre-commit-check 加 `kind:'orchestrator'` 分支）。次显著的是 **`loadRun` defensive default** 未落地（F7-4）。

`pipeline mode` plan（2026-05-09-agent-loop-pipeline.md）值得一个轻量 retrospective sprint 把 review / compound 流程补完，否则它是这套自进化系统里的一个 broken example——别人模仿这份 plan 会以为"implemented 就是 completed"。

---

## 下一 sprint 建议候选（≤3）

1. **把 `scripts/agent-orchestrator*` 副本同步纳入 pre-commit-check**（P0，1-2 小时）
   - 在 `scripts/pre-commit-check.js` 加 `kind:'orchestrator'` 分支：sha256 比对 `scripts/agent-orchestrator.js` vs `plugins/tech-persistence/scripts/agent-orchestrator.js`，以及 `scripts/agent-orchestrator/*.js` vs 对应 plugin 副本
   - 失败提示给出 `node plugins/tech-persistence/scripts/build-codex-plugin.js && node scripts/validate-codex-plugin.js`（沿用现有 `deriveRepairCommand` 模式）
   - **必做 dogfood**（reviewer 重点提示）：当前 13 文件 sha256 全 EQUAL，新 enforcement 会 trivially pass，必须额外做「故意制造不同步」smoke：临时修改根侧某个子模块 → 重跑 pre-commit-check 必须拒 → 恢复一致 → 再跑必须通过
   - 关联 [[ADR-013]] dogfood 边界产物枚举：本 sprint 要枚举「会拒绝哪些既存副本」（理论上 0，因为当前态 EQUAL，正好需要主动制造负样本验证）

2. **`loadRun` 入口加 defensive default + self-test**（P0，30 分钟）
   - `scripts/agent-orchestrator.js:257-262` 加 `if (!Array.isArray(state.providerRuns)) state.providerRuns = []; if (!state.files || typeof state.files !== 'object') state.files = {};`
   - 加 self-test：`loadRun` 读旧格式 state.json（无 providerRuns/files）应不抛错
   - **必须先于 F7-5 完成**：F7-5 的 runResume line 1785 直接读写 `state.files`，若 F7-4 未修，旧 state.json 在跑到 line 1785 时就 crash
   - 跨副本同步（用 build-codex-plugin）+ 候选 1 的 enforcement 落地后这条同步会被自动验证

3. **Pipeline mode retrospective sprint**（P0，2-3 小时；**或最小修复 5 分钟**）
   - **5 分钟止血版**：把 `docs/plans/2026-05-09-agent-loop-pipeline.md` frontmatter `status: implemented` 改为 `status: partial`（明示 review/compound 未走完），避免成为 sprint 模板的 broken example
   - **完整版**：对 plan 补 review（多视角 lint pipeline 实现）+ 生成 `docs/solutions/2026-05-11-agent-loop-pipeline.md`（含 4 条经验：版本化冻结契约 / drift 三档分类 / lock 三态语义 / reconciliation depth 递归终止）
   - reviewer 反馈把这条从 P1 升到 P0：plan 文档本身就是流程协议的范例，"implemented" 状态会误导后人

---

## 复利记录

### 提取的经验

- **文档先行声称 vs 代码实际落地的偏差是高频回归源**：caveman-audit 中 8 条 fix 有 4 条「文档声称已修但 grep 不到」（partial/still-open）。再次印证 [[2026-05-12-nul-hook-shell-mismatch]] 的元经验「纯文档协议抵不住时间推移」。
- **多副本同步纪律必须 enforcement 化**：F8/F9 是 nul fix 同款风险模型的下一个目标 — commands/rules 已升级到 pre-commit，scripts/ 是最后一块裸奔区。
- **sprint 流程未闭环本身是 broken example**：`docs/plans/2026-05-09-agent-loop-pipeline.md` status=implemented 但 P0/P1/复利全是占位行，会让后人模仿这份 plan 时误以为「implemented 即可视为完结」。

### 创建/更新的本能

无新本能。强化已有：
- [[windows-hook-bash-portability]] 的元规则「N≥2 回归 = 升级工具链」适用于 F8/F9 plugin 同步缺口
- ADR-008 「state 文件向后兼容」需要在 F7-4 修复时再 dogfood 一次

### 解决方案文档

本 audit 不产出 solution doc（只识别缺口，不修复）。建议候选 1+2 修完后再写 solution。

---

## 涉及文件

### 读取

- `CLAUDE.md`（索引 line 166-168）
- `.claude/rules/architecture.md`（ADR-003/004/009/012）
- `.claude/rules/debugging-gotchas.md`（agent-loop/provider-errors 条目）
- `docs/plans/2026-05-09-agent-loop-pipeline.md`（plan + changelog + 审查结果）
- `docs/solutions/2026-04-27-agent-orchestrator-v6.md`
- `docs/solutions/2026-05-09-agent-loop-caveman-audit.md`
- `scripts/agent-orchestrator.js`（多段：loadRun / runResume / buildUntrackedDiff / writeValidation / writeFollowUpTask / arrayLines / doctor / extractProviderEnvelopeError / self-test）
- `scripts/agent-orchestrator/*.js`（Glob 列举）
- `scripts/pre-commit-check.js`（mismatch kind 分支）
- `user-level/commands/agent-loop.md`（dispatch section）
- `plugins/tech-persistence/scripts/agent-orchestrator*`（git ls-files + sha256）
- `.gitignore`

### 新增

- `docs/plans/2026-05-12-agent-loop-followup-audit.md`（本文件）

### 修改

无。

---

## 变更日志

| 日期 | 类型 | 内容 |
|------|------|------|
| 2026-05-12 | audit | 完成 follow-up 闭环度审计，共 15 项核验，6 still-open，3 partial，4 closed，2 wont-fix-now。Top-3 建议：F8/F9 plugin 同步 enforcement、F7-4 loadRun defensive default、F1+F2 pipeline retrospective sprint |
| 2026-05-12 | review-amend | ce-coherence-reviewer 反馈 7 个 finding，3 个 claim verified（F7-4/F7-5/F8/F9）、4 个建议 amend（F1+F2 升 P0 + 5 分钟止血版、F7-4 阻塞 F7-5 显式声明、F8/F9 必做负样本 smoke、F3 honest about CI 边界）。全部已并入候选清单和优先级表。 |
| 2026-05-12 | fixes-landed | 后续 sprint 落地 Top-3 P0 修复：(1) F1+F2 止血：`docs/plans/2026-05-09-agent-loop-pipeline.md` frontmatter `status: implemented` → `status: partial` + 加 errata 块；(2) F7-4：`scripts/agent-orchestrator.js` 抽 `applyStateDefaults()` 纯函数 + `loadRun` 入口调用 + 5 条 self-test 覆盖（缺 providerRuns / 缺 files / files 为数组 / providerRuns 为字符串 / 保留已有字段）；(3) F8/F9：`scripts/pre-commit-check.js` 新增 `checkOrchestratorSync()` + `ORCHESTRATOR_PATH_RE` + `kind:'orchestrator'` 分支 + sha256 比对 + 孤儿检测 + 措辞通用化（"多副本同步失败"），跑 build-codex-plugin 同步 13 个 plugin 副本。负样本 smoke 三步全过：当前态 EXIT=0、临时 tamper queue.js EXIT=1 + 文件名/reason/修复命令齐全、恢复后 EXIT=0。F7-5/F7-8（resume 状态机）未本次实施，仍 still-open。 |
| 2026-05-12 | review-amends-landed | ce-correctness-reviewer (5 findings) + ce-testing-reviewer (7 findings) 并行 review，11/12 已修：CORR-1 sha256 LF-normalize（修 Windows CRLF 死循环风险）+ CORR-2 nested subdir detection（build-codex-plugin 非递归的兜底）+ CORR-3 `--diff-filter=ACMRD`（捕获源删除 → orphan 报告）+ CORR-5 null/primitive state.json throw（loadRun 后置条件保证）+ T1 扩展 4 throw self-test（null/undefined/array/string）+ T2 引用保持 + mutate-in-place 2 self-test + T7 strengthen `files=={}` 而非仅 `!Array` + T3+T4+T5+T6 加 5 smoke scenarios (S8-S12)（synced / tampered / CRLF-source / src-deleted-orphan / nested-subdir）。Defer 1: CORR-4 files 数组 silent drop（self-test 已明示 desired behavior，acknowledged）。最终：self-test [OK] + smoke 12/12 + sha256 13/13 EQUAL + pre-commit EXIT=0。|

---

## Related

- [[2026-04-27-agent-orchestrator-v6]] — v6 原始架构
- [[2026-05-09-agent-loop-caveman-audit]] — 8 条 fix 来源（其中 4 条本 audit 标 partial/still-open）
- [[2026-05-09-agent-loop-pipeline]] — pipeline mode plan（F1/F2 流程债来源）
- [[2026-05-12-nul-hook-shell-mismatch]] — F8/F9 同款风险模型 + 元经验「N≥2 = 升级工具链」
- [[windows-hook-bash-portability]] — 升级触发器本能
- ADR-003 / ADR-004 / ADR-009 / ADR-013 — 关联架构决策
