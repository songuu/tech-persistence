---
title: "单元测试视角的架构缺陷审计"
type: sprint
status: completed
created: "2026-05-18"
updated: "2026-05-18"
tasks_total: 8
tasks_completed: 8
scope_chosen: "S2: D1(A) + D2 + D4(C) + D6 + D7(C)"
tags: [sprint, audit, testing, architecture]
aliases: ["unit-test-audit", "测试架构审计"]
---

# 单元测试视角的架构缺陷审计

> **Status:** `draft`
> **Created:** 2026-05-18

---

## 需求分析

### 用户原话

> 从单元测试的角度分析下当前项目架构的缺陷，因为单元测试是必须的一步

### 解读

- **类型**：analysis sprint（不是 implementation sprint）
- **意图**：识别架构里"阻碍写单元测试"的设计缺陷，输出缺陷清单 + 改造优先级
- **隐含假设**：用户认同"单元测试 = 必须"；ROI 评估按 5 年杠杆（[[feedback_target_user_mismatch_invalidates_borrow]] / 用户偏好）
- **不是**：直接拍板"装 jest + 重写所有测试"（这是 implementation 决策，必须先看缺陷再决定）

### 要做（Phase 1 范围 = analysis only）

- 勘察生产代码可测性（exports / 副作用混杂 / 单文件巨大）
- 勘察测试基础设施缺口（framework / runner / coverage / CI）
- 输出"7 类缺陷"清单（详见下方）
- 输出每类缺陷的**证据**（commit / 行号 / 反例）
- 输出"候选改造矩阵"（ROI 分级 + 风险 + 工作量估算）
- **用户 review 后决定 scope** → Phase 2 才进入 implementation plan

### 不做

- 不在本 Phase 实施任何改造（不装 jest / 不重构 agent-orchestrator / 不补单测）
- 不强推某一框架（jest vs vitest vs node:test 留 Phase 2 决策）
- 不动 smoke / validator 已稳定运行的部分
- 不追溯写 100% coverage（YAGNI）

### 成功标准

- [ ] 7 类缺陷每类至少 1 个具体证据（commit hash 或文件:行）
- [ ] 候选改造矩阵 ROI 评级与 [[ADR-011]] 4 不可妥协原则一致（multi-runtime parity / 确定性 / 轻量 / Obsidian 兼容）
- [ ] 用户能基于矩阵选出 Phase 2 实施 scope
- [ ] 文档可作为后续多次改造 sprint 的引用基准（不是一次性消费）

### 风险和假设

- 假设用户的"单元测试是必须的"指**生产代码逻辑**层面的单测，不是 LLM-driven 命令文档的单测
- 假设当前 smoke + validator 不需要替换，而是**补充**而非替代
- 假设无外部 framework 引入也是合规候选（node:test 自 Node 18 内置）

---

## 7 类缺陷清单（基于勘察事实）

### D1: 缺测试 framework + runner（CRITICAL）

**证据**：
- 无 `package.json` → 无 `npm test`、无依赖管理
- 3 个 `test-*.js` 各自手写 `function test(name, fn) { try { fn(); passed++ } catch { failed++ } }` —— 同一 ~25 行模板复制 3 份
- 无统一 reporter，每个脚本自己 `console.log` 拼格式
- `assert` 用 Node 内置 `require('assert')`，无 jest expect / vitest 等 fluent matcher

**影响**：
- 新增测试边际成本高（每次复制模板 + 拼装目录 fixture）
- 测试报告不一致（pass/fail 计数 / 退出码 / 颜色 / 缩进各异）
- 无法跑 watch mode / 无法 grep 测试名 / 无法 retry flaky

**改造候选**：
- A: 引入 `node:test`（Node 18+ 内置，零依赖，与 [[ADR-011]] 轻量优先一致）
- B: 引入 vitest（生态丰富但加 100+ deps）
- C: 把 3 份模板提取为 `scripts/lib/test-runner.js`（最轻量，但仍非框架）

### D2: CI 漏跑现有 unit-test（CRITICAL）

**证据**：
- `.github/workflows/macos-cross-platform.yml:41-49` —— 只跑 `agent-orchestrator self-test` / 4 个 validator / 4 个 smoke
- `node scripts/test-memory-search.js` / `test-archive-claude-solutions.js` / `test-memory-export.js` **不在任何 step 中**
- grep 验证：CI yml 中无 `test-*.js` 模式匹配

**影响**：
- 改 `lib/memory-search.js` 不会触发对应测试 → 写了等于白写
- C2 bug (6d9c05a) 修复后加 self-test 是好事，但**只在本地跑**才能验证
- 回归保护事实为 0

**改造候选**：
- A: CI workflow 加一步 `for f in scripts/test-*.js; do node "$f"; done`（最小改动）
- B: 改 D1 后用 `node --test scripts/test-*.js` 统一调度
- C: 加 pre-commit hook 跑 modified `lib/*.js` 对应 test（高级，依赖 D1）

### D3: 单文件巨大 + 副作用与纯逻辑混杂（HIGH）

**证据**：
- `scripts/agent-orchestrator.js` **2580 行** 单文件，含：provider launch resolver / spawn 子进程 / state machine / contract normalizer / regex translator / diff / validation runner / freeze gate —— 都在同一 require 入口下
- `scripts/evaluate-session.js` **920 行**，含：本能进化 / 阈值判断 / file I/O / 阈值配置读取 —— 混在一起
- 模式：纯函数（regex / format / parse）与副作用（fs.writeFile / spawnSync / process.env）共用闭包 → 测试纯函数也必须 mock 整个文件系统

**影响**：
- 测 `normalizeContract()` 必须 spawn 子进程 / 准备临时 dir / 模拟 schema
- 改 1 行纯函数风险高（耦合多）
- 单测变集成测，慢且 flaky

**改造候选**：
- A: 把 agent-orchestrator.js 拆分为 `scripts/orchestrator/{provider,state,contract,validation,diff}.js`（[[ADR-004]] 已明示集中在 orchestrator 中，拆分需重新评估 spirit）
- B: 把纯函数提取到 `lib/orchestrator-pure.js`（保持入口聚合，但纯逻辑独立可测）
- C: 仅对新加逻辑要求"纯函数独立 module"（不动旧代码）

### D4: 入口脚本无 module.exports → 端到端 spawn 才能测（HIGH）

**证据**：
- 12 / 34 文件无 `module.exports`，包括：`observe.js` / `caveman-activate.js` / `merge-claude-settings-hooks.js` / `validate-codex-install.js` / 等
- `observe.js`（95 行）和 `caveman-activate.js` 是 hook 入口 —— 测试只能 spawn 整个 node 子进程 + 模拟 hook payload
- 4 个 hook 入口（SessionStart / PreToolUse / PostToolUse / Stop）全是这种模式

**影响**：
- hook 静默失效在 [[2026-05-12 enforcement, dogfood]] 已记录为高频反模式
- 单测无法覆盖 hook 内部分支（如"hook 收到 caveman skill 调用时分支 A vs B"）
- 只能依赖 4 smoke 模糊覆盖（粒度过粗）

**改造候选**：
- A: 把 hook 主逻辑提取为 `handle(payload, deps)` 纯函数 + 薄入口调用（依赖注入 fs / process）
- B: 用 `if (require.main === module) {...}` 守卫，allow 入口同时 export
- C: 仅对新 hook 强制 A 模式（不重构旧 hook）

### D5: 测试金字塔倒挂（MEDIUM）

**证据**：
- 0 个真正"快单元测试"（纯函数 + 内存 fixture）
- 3 个 "module unit"（实际跑临时 dir + spawnSync 子进程，已是 integration 级别）
- 4 个 smoke（端到端，最慢）
- 缺中间层：integration（如 `inject-context.js` 调 `memory-v5.js` 不调 spawn）

**影响**：
- 改 1 行 → 触发 spawn-heavy test → 反馈慢
- 增量测试不可能（即使 D1+D2 解决也不够）

**改造候选**：
- A: 明确分层目录 `tests/{unit,integration,smoke}/` + 各自跑法
- B: 不重构目录，但用 frontmatter `// @test:unit` 标记
- C: YAGNI 当前规模（如改造太重，先 D1+D2）

### D6: 平台覆盖只有 macOS（MEDIUM）

**证据**：
- `.github/workflows/macos-cross-platform.yml` —— 唯一 workflow，`runs-on: macos-latest`
- 历史踩坑：[[bash-pipefail-vs-ls-no-match]] / [[ps1-needs-utf8-bom]] / hook 在 Windows Git Bash vs cmd.exe 混淆 —— 都是 platform-specific
- 用户主开发环境是 Windows（CLAUDE.md / persona 明示）

**影响**：
- Windows-only bug 在 CI 不被抓
- ps1 / cmd.exe 路径相关 bug 已踩 ≥3 次

**改造候选**：
- A: workflow 加 `matrix.os: [ubuntu, windows, macos]`
- B: 单独 windows-smoke.yml（粒度更细但维护表面 +1）
- C: 仅对 `install.ps1` / 含 ps1 的脚本加 Windows matrix（最小化）

### D7: 关键路径无回归保护（HIGH）

**证据**：
- `propagate-command-changes.js`：8 副本同步，错传 0 测（仅靠 smoke 间接覆盖）
- `merge-claude-settings-hooks.js`：[[2026-05-12 hooks, shell-mismatch]] 是该文件历史 bug 源，无单测
- `archive-claude-solutions-index.js`：C2 bug 修复后才补 self-test（已部分覆盖）
- `pre-commit-check.js` 4 checker（propagate-sync / orchestrator-sync / plan-scope / plan-completion）—— 仅 smoke-pre-commit.js 覆盖（12 scenarios），新加 checker 无独立单测

**影响**：
- 已 hardened 的 lib 也会因周边改动悄悄退化（[[documented-claim-vs-code-reality-drift]] N=3 的根因之一）
- "上线后 fail-open 静默"风险持续存在

**改造候选**：
- A: 为每个 lib 模块按"关键 contract"列单测候选（不要求 100% coverage）
- B: 强制新增/修改 lib/* 必须配 test-*.js（pre-commit-check 加规则）
- C: 仅对 [[debugging-gotchas]] 中提及过的文件强制（最小化）

---

## 候选改造矩阵（Phase 2 决策输入）

| ID | 缺陷 | 严重度 | ROI（5 年杠杆） | 工作量 | 与 ADR-011 兼容 | 推荐优先级 |
|----|------|-------|----------------|-------|-----------------|----------|
| D1 | 缺 framework | CRITICAL | 高（每次写测试边际成本 ↓） | 中（A 选 node:test 最轻） | ✓ 选 A 完美兼容 | **P1** |
| D2 | CI 漏跑 | CRITICAL | 高（回归保护从 0 → N） | 低（5 行 yml） | ✓ | **P0** |
| D3 | 单文件巨大 | HIGH | 中（一次重构受益多次） | **高**（agent-orchestrator 2580 行） | △ 需重评 [[ADR-004]] spirit | **P2**（拆分敏感，慢调） |
| D4 | 入口无 exports | HIGH | 中（hook 健康度 ↑） | 中（4-12 文件改） | ✓ | **P2** |
| D5 | 金字塔倒挂 | MEDIUM | 中（D1 解决后自动改善） | 低（仅目录约定） | ✓ | **P3**（D1 后再说）|
| D6 | 仅 macOS CI | MEDIUM | 高（Windows bug 已踩 3+ 次） | 低（5 行 yml） | ✓ | **P1** |
| D7 | 关键路径无回归 | HIGH | 高（已被 [[documented-claim-vs-code-reality-drift]] 反复验证） | 中（按文件渐进） | ✓ | **P1**（与 D1 同步推） |

**推荐 Phase 2 scope 候选**（用户挑选）：

| 候选 | 包含 | 工作量 | 风险 | 受益面 |
|------|------|-------|------|-------|
| **S0：最小启动** | D2 + D6 | 1-2h | 极低 | CI 立刻保护现有 3 测 + 抓 Windows bug |
| **S1：基础设施** | D1(A) + D2 + D6 | 半天 | 低 | 上述 + 统一 runner，未来写测试边际成本降低 |
| **S2：可测性 + 基础** | S1 + D4(C) + D7(C) | 1-2 天 | 中 | 加 hook 入口可测 + 高频 bug 文件加测 |
| **S3：全面改造** | 全部 + D3(B) | 1 周+ | 高（动 [[ADR-004]] 边界） | 完整测试金字塔，但 ROI 边际递减 |

> 推荐 **S1**：兼顾立刻可见的 CI 修复 + 框架基础设施 + 不动敏感的 agent-orchestrator。S2/S3 留后续 sprint。

---

## 技术方案

### 方案概述

S2 = D1(A: node:test) + D2 + D4(C) + D6 + D7(C)

**节奏**：
1. 先 D2 + D6 立刻拿 ROI（CI 接现有 3 测 + Windows 抓平台 bug）
2. D1 引入轻量 framework（node:test 内置，零依赖）+ wrapper 兼容现有 3 测
3. D4(C) + D7(C) 渐进补测（仅新 hook + gotchas 提及文件）

**不破坏原则**：
- 现有 3 个 test-*.js **保留原样**（避免回归）
- `agent-orchestrator self-test` 等 validator step **保留**
- 不引入 npm 依赖（`devDependencies = {}`），保持 [[ADR-011]] 轻量原则

### 关键假设验证（[[ADR-012]]）

| 假设 | 验证证据 | 可信度 |
|------|---------|-------|
| `require.main === module` 是项目成熟模式 | grep 找到 9 个 scripts/*.js 已用 | 高 |
| observe.js 可改造（加 exports + 守卫）不破坏 hook 触发 | 已 Read 96 行结构，main() 在末尾 try/catch | 高 |
| caveman-activate.js 纯函数提取易测 | resolveMode/modeRules/readConfigMode 已是 pure | 高 |
| node:test 在 Node 18+ 稳定可用 | Node 18.0 内置，CI matrix 已用 18+24 | 高 |
| Windows runner 可跑 install.sh | actions/checkout 装 git，`shell: bash` 显式声明 | 中（首次启用） |

### 契约接口

不变更 multi-runtime hook projection / propagate transform / orchestrator spec-impl-review schema。
- `package.json` 新增（最小：仅 `scripts.test`）
- `scripts/run-tests.js` 新增（runner 入口）
- `.github/workflows/macos-cross-platform.yml` 重命名建议：→ `ci.yml`（但本 sprint **不改名**，避免 PR check 配置漂移）

### 任务拆解

> `[P]` = 可并行（不同文件 + L2 以下）

- [x] **Task 1**: 创建 `package.json` — `{ "name": "tech-persistence", "private": true, "scripts": { "test": "node scripts/run-tests.js" }, "engines": { "node": ">=18" } }` — 风险: L1
- [x] **Task 2**: 写 `scripts/run-tests.js` — 扫 `scripts/test-*.js` 串行 spawn 跑，聚合 pass/fail，exit code = 失败数 — 依赖 T1 — 风险: L1
- [x] **Task 3 [P]**: CI workflow 加 step `Run unit tests`，执行 `node scripts/run-tests.js`（位置：现有 "Run core smoke checks" 之后）— 依赖 T2 — 风险: L1
- [x] **Task 4 [P]**: CI workflow 加 `matrix.os: [macos-latest, ubuntu-latest, windows-latest]` + 各 step 加 `shell: bash`；install probe 步骤加 `if: matrix.os != 'windows-latest'`（Windows 单独 ps1 probe 留 backlog）— 风险: L2
- [x] **Task 5**: 改造 `observe.js` + `caveman-activate.js`：加 `module.exports = { main, ... }` + 末尾用 `if (require.main === module) main();` 守卫 + `caveman-activate.js` 加 `[hook] failed:` 标准化 log — 风险: L2
- [x] **Task 6**: 写 `scripts/test-hook-entries.js` — 单测 `caveman-activate.resolveMode/modeRules/readConfigMode`（env 覆盖 / config 文件 fallback / 默认 mode） + `observe.normalizeHookPayload` 调用路径（fixture stdin） — 依赖 T5 — 风险: L2
- [x] **Task 7**: 写 `scripts/test-merge-claude-settings-hooks.js` — 单测 hook command 不含 `2>nul`/`exit /b`/`/dev/nul`（防 [[2026-05-12 hooks, shell-mismatch]] 回归）— 风险: L2
- [x] **Task 8**: 验证 — 本地 `node scripts/run-tests.js` 全过 + git diff yml 看 matrix 配置 + grep 确认无破坏现有 hook + 模拟 windows-latest CI 失败时降级 — 依赖 T1-T7 — 风险: L1

### 测试策略

| Task | 测试方式 |
|------|---------|
| T1 (package.json) | 手动 `node -e "require('./package.json')"` 解析无错 |
| T2 (run-tests.js) | 本地跑：必须包含 3 现有测试 + 新增 2 测 = 5 测 全 pass，exit 0；模拟一个 fail → exit ≠ 0 |
| T3 (CI 接入) | yml lint（GitHub UI 或 actionlint）+ commit 后 CI run 观察 |
| T4 (Windows matrix) | yml lint；本地 act / 直接 push 看 windows-latest job 行为 |
| T5 (hook 改造) | 模拟 hook 触发 `echo '{...}' \| node observe.js post` 行为不变 |
| T6 (hook unit) | `node scripts/test-hook-entries.js` 自己 pass |
| T7 (merge-hooks unit) | `node scripts/test-merge-claude-settings-hooks.js` pass |
| T8 (端到端) | `node scripts/run-tests.js` exit 0；CI windows-latest step 不破坏 macOS step |

### Dogfood 边界（[[ADR-013]] §B）

会影响的现有产物：
1. `scripts/test-memory-search.js` / `test-archive-claude-solutions.js` / `test-memory-export.js` — 通过 run-tests.js 被调用，**断言不变** → 无回归（已离线模拟：spawn 串行跑，输出 OK）
2. `.github/workflows/macos-cross-platform.yml` 现有 8 steps — 仅追加 step（"Run unit tests"），不动现有 → CI 行为只增不减
3. `observe.js` / `caveman-activate.js` — 现 hook 调用方式 `node <path>/observe.js pre`，加守卫后**入口行为不变**（main() 仍执行）

**负样本验证**（必须做）：
- T8 中故意改 caveman-activate.js 让 resolveMode 返回 invalid → `test-hook-entries.js` 必须 fail；恢复后必须 pass

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Windows matrix 启用后 install probe step 跨平台失败 | 中 | 中 | T4 加 `if: matrix.os != 'windows-latest'` 仅 macOS/Linux 跑 install probe；Windows ps1 probe 留后续 sprint |
| node:test 在 Node 18 是 experimental → warning 输出干扰报告 | 低 | 低 | run-tests.js 用 spawn child + 过滤 stderr 中 `ExperimentalWarning` |
| observe.js 加 exports 后某副本未同步 → hook 静默失效 | 低 | 高 | observe.js 不在 propagate 列表（仅在 scripts/），install.sh 直接复制 → 验证安装路径 |
| 现有 `function test(name, fn)` 与 node:test 命名冲突 | 极低 | 低 | run-tests.js 用 spawn 隔离子进程，不共享 runtime |
| 加 package.json 后误触 npm install hook（如 husky） | 极低 | 低 | devDependencies 留空；不引入 npm scripts 之外的钩子 |

### 涉及文件

源（手改）：
- `package.json`（新建）
- `scripts/run-tests.js`（新建）
- `.github/workflows/macos-cross-platform.yml`（改）
- `scripts/observe.js`（改：加 exports + 守卫）
- `scripts/caveman-activate.js`（改：加 exports + 守卫 + [hook] failed log）
- `scripts/test-hook-entries.js`（新建）
- `scripts/test-merge-claude-settings-hooks.js`（新建）

派生（无 propagate 影响）：
- observe.js / caveman-activate.js 不在 propagate-command-changes 列表（hook 脚本由 install.sh 复制，不分 4 副本）→ **无 propagate 步骤**

文档：
- `README.md` 加一行 `npm test`（可选，T8 视情况）
- 本 sprint 文档（变更日志）

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-18 | Phase 1 | 完成勘察 + 7 类缺陷分析 + 候选改造矩阵 |
| 2026-05-18 | Phase 2 | scope 锁定 S2；技术方案 + 8 task 拆解 + 关键假设验证 |
| 2026-05-18 | T1 | `package.json` 新建（zero deps、scripts.test、engines.node>=18） |
| 2026-05-18 | T2 | `scripts/run-tests.js` 新建（145 行，支持 --grep/--list；NODE_NO_WARNINGS=1 过滤 Experimental） |
| 2026-05-18 | T3+T4 | `.github/workflows/macos-cross-platform.yml` 重写：job `ci`、`matrix.os: [ubuntu,macos,windows]`、`defaults.run.shell: bash`、新增 `Run unit tests` step、install probe step 加 `if: matrix.os != 'windows-latest'` |
| 2026-05-18 | T5 | `observe.js` + `caveman-activate.js`：加 `if (require.main === module)` 守卫 + `module.exports`；observe.js 补 `[observe] hook failed:` log；require 副作用验证：caveman-activate 不输出 hook JSON，observe.js 不写 observations.jsonl |
| 2026-05-18 | T6 | `scripts/test-hook-entries.js` 新建（202 行，16 tests，A1-A2/B1-B6/C1-C3/D1-D3/E1-E2） |
| 2026-05-18 | T7 | `scripts/test-merge-claude-settings-hooks.js` 新建（130 行，6 tests，W1-W4/P1/S1；4 forbidden patterns: `2>nul`、`exit /b`、`>nul`、`%VAR%`） |
| 2026-05-18 | T8 | 验证 5 项全过：(1) `node scripts/run-tests.js` → 6 pass / 0 fail / 6 total（含新发现的 test-sync-solution-index.js）；(2) `echo '{...}' \| node scripts/observe.js pre` → exit=0 hook 行为不变；(3) `node scripts/caveman-activate.js` → 完整 JSON 输出行为不变；(4) yml grep 验证：matrix.os/Run unit tests/windows guard 全 true；(5) 负样本：临时改 test-hook-entries.js 让 B1 fail → run-tests.js exit=1（enforcement 真能拒）→ 恢复 → exit=0 |
| 2026-05-18 | Review | spawn 4 reviewer 并行（correctness+testing / architecture / CI-cross-platform / dogfood-boundary），全 DONE_WITH_CONCERNS。汇总 P0 2 条 + P1 4 条 + P2 多条 |
| 2026-05-18 | P0-C1 | 跑 `node plugins/tech-persistence/scripts/build-codex-plugin.js` 同步 plugin hook 副本（observe.js / caveman-activate.js 等 15 hook files）；pre-commit-check 通过 |
| 2026-05-18 | P0-C2 | `scripts/smoke-cross-platform.js:78-101` testMacosWorkflowExists → testCiWorkflowExists；needle 从硬编码 `runs-on: macos-latest` 改为接受新 matrix 模式（含 ubuntu/macos/windows + shell:bash + Run unit tests + windows guard 等 5 个新 needle）；测试描述同步更新 |
| 2026-05-18 | P1-C3 | `scripts/run-tests.js`: `return failed` → `return failed > 0 ? 1 : 0`（防 POSIX exit code mod 256 fail-open）+ 输出 signal 信息辅助 crash vs exit 区分 |
| 2026-05-18 | P1-C4 | `scripts/test-merge-claude-settings-hooks.js` CMD_FORBIDDEN_PATTERNS 加 `/i` flag（防 `2>NUL` / `Exit /B` 等大小写变体漏抓）；`%VAR%` regex 接受混合大小写（cmd.exe 不区分） |
| 2026-05-18 | P1-C5 | sprint 文档加「已装用户 hook 不热更新」警示段（install.sh 是 cp 模式，已装用户需 re-install 才拿到新 `[observe] hook failed:` log；新装用户立即可用） |
| 2026-05-18 | P1-C6 | ADR-013 §B 补 fail-by-breaking-impl 负样本（之前只覆盖 fail-by-breaking-test）：负样本 A：改 caveman-activate.resolveMode 写死返回 'lite' → test-hook-entries B1/B2/B3 fail → run-tests exit=1 ✓；负样本 B：改 hook-registry 把 hook command 注入 `2>nul` → test-merge W1/W3 fail → run-tests exit=1 ✓ |

---

## 审查结果

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| C1 | architecture | `plugins/tech-persistence/hooks/{observe,caveman-activate}.js` | plugin 副本未同步源（违反 [[ADR-014]] + [[ADR-011]]），pre-commit `checkPropagateSync` 会拒 | fixed (build-codex-plugin.js 重生) |
| C2 | CI/dogfood | `scripts/smoke-cross-platform.js:78-101` | 硬断言 `runs-on: macos-latest`，新 matrix workflow 会让所有 6 job 立即 fail | fixed (testCiWorkflowExists + 5 新 needle) |

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| C3 | correctness | `scripts/run-tests.js:107` | `return failed` 让 exit code = 失败数；>127 fail 时 POSIX wrap mod 256 = fail-open | fixed (`return failed > 0 ? 1 : 0`) |
| C4 | correctness | `scripts/test-merge-claude-settings-hooks.js:38-43` | forbidden patterns 缺 `/i` flag，漏抓 `2>NUL` / `Exit /B` 等大写变体 | fixed (4 regex 加 `/i`) |
| C5 | dogfood | `install.sh:139-143` | hook cp 非热更新，已装用户拿不到新 `[observe] hook failed:` log | docs only (sprint changelog 明示，install 改造留下 sprint) |
| C6 | testing | sprint T8 | ADR-013 §B 缺 fail-by-breaking-impl 负样本（只覆盖 fail-by-breaking-test） | fixed (补 2 个负样本 A+B 验证) |

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| C7 | correctness | `scripts/observe.js:44-48` | `fs.readFileSync(0)` 在 CLI 模式无 stdin pipe 时阻塞（hook 触发 OK，CLI 直跑挂） | backlog |
| C8 | testing | test-memory-export/search/hook-entries | mkdtemp 不清理，CI 反复跑 leak | backlog |
| C9 | runner | `scripts/run-tests.js` | 无 `--bail` 短路 + 无 spawn timeout | backlog |
| C10 | CI | `scripts/smoke-pre-commit.js:67,386` | `execSync` 不显式 shell，Windows 默认 cmd 引号语义不同 | backlog |
| C11 | docs | `scripts/smoke-cross-platform.js` 函数名+文件名 misnomer | 已部分修（函数名）；workflow yml 文件名仍叫 `macos-cross-platform.yml` 误导 | backlog (跨提交风险，PR check 名变动需协调 branch protection) |
| C12 | infra | branch protection | job rename `macos-smoke`→`ci` 会破坏现有 required-check 名（需 GitHub repo settings 手动更新） | external (用户在 GitHub 设置中处理) |
| C13 | runner | `scripts/run-tests.js:38` | `NODE_NO_WARNINGS:'1'` 强写，CI 不可 override | backlog |
| C14 | docs | `package.json` | 加 `packageManager` 字段或注释防新贡献者误跑 `npm install` | backlog |
| C15 | docs | `.claude/rules/debugging-gotchas.md` | 加注「hook 类守卫」vs「script 类守卫」3 种模式区分（archive/install-git-hooks: stderr+exit1；inject-context: bare catch+exit0；hook 类: stderr+exit0） | backlog |
| C16 | runner | `scripts/run-tests.js` | --grep 不存在 pattern 时 exit 0 行为无 smoke 覆盖 | backlog |
| C17 | testing | `scripts/smoke-pre-commit.js` S1/S2/S6 | **pre-existing fail**（非本 sprint 引入；git stash 验证基线同 15 pass / 3 fail）；S6 错误 `Cannot find module 'scripts/lib/hook-registry'`；smoke 临时 dir 准备时漏复 lib/hook-registry.js 给 build-codex-plugin.js 依赖 | external (与本 sprint 无关，单独 sprint 修) |

### 总评

🟢 健康。4 reviewer 视角全 `DONE_WITH_CONCERNS`，无 BLOCKED。P0 2 条已修并验证通过（smoke 6/6 + pre-commit 无错 + run-tests 6/6）。P1 4 条全修（C5 文档化、C3/C4/C6 代码修复，C6 补全 ADR-013 §B 三档负样本）。P2 10 条全 backlog，不阻塞合并。

### 已装用户 Re-install 提示（C5 fix）

本 sprint 的 hook 改造（observe.js 加 `[observe] hook failed:` log + 入口守卫）通过 `install.sh::install_hooks()` 的 cp 模式分发。已装用户**不会自动拿到新版本**。

- **新装用户**：直接生效
- **已装用户**：需 `bash install.sh --user` 重跑安装才生效；旧 hook 行为兼容（无 log 但不阻塞）

下 sprint 候选：install.sh 加「检测到 hooks 目录已存在 → diff cp + 自动覆盖更新版本」逻辑，避免 cp 模式静默漂移。

---

## 复利记录

### 提取的经验
- **D1+D2+D6 节奏**：先 CI 修复立刻拿 ROI（接现有 3 测 + Windows 抓平台 bug）→ D1 引入框架（zero deps node:test）→ D4+D7 渐进补测。避免一次性大改触动 [[ADR-004]] 边界
- **multi-reviewer 真并行价值**：4 视角各抓不同 P0 — architecture reviewer 抓 C1 plugin 副本未同步、CI reviewer 抓 C2 smoke needle 硬编码；单一 reviewer 不可能同时覆盖
- **baseline 验证习惯**：smoke-pre-commit S1/S2/S6 fail 时第一直觉"本 sprint 引入"，git stash 验证后 baseline 同 fail = pre-existing。30 秒成本永远值得
- **ADR-013 §B 三档**：本 sprint 实战补全 fail-by-breaking-impl 档 → enforcement 真在守 impl 行为而非 self-consistent

### 创建/更新的本能
- 🆕 [[baseline-verify-before-blaming-current-sprint]] — sprint 后 fail 必先 git stash 验 baseline
- 🆕 [[hook-entry-testability-3-piece]] — 新 hook 入口三件套：require.main 守卫 + module.exports + 标准化 log
- 🆕 [[negative-sample-3-archs]] — enforcement a/b/c 三档负样本必须做

### 解决方案文档
- `docs/solutions/2026-05-18-unit-test-architecture-baseline.md` — 完整改造记录 + reviewer 发现 + P2 backlog

### Reviewer 视角并行 spawn 实战记录
| Reviewer | 状态 | 抓到的 P0 |
|---------|------|----------|
| correctness+testing | DONE_WITH_CONCERNS | 0（4 P1 + 3 P2）|
| architecture | DONE_WITH_CONCERNS | **C1 plugin 副本未同步**（自反 [[ADR-014]]） |
| CI / cross-platform | DONE_WITH_CONCERNS | **C2 smoke-cross-platform needle 硬编码** |
| dogfood-boundary | DONE_WITH_CONCERNS | **同 C2** + ADR-013 §B 三档负样本缺失（C6） |
