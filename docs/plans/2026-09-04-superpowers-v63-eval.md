---
title: "obra/superpowers v6.1.1-v6.3 增量评估"
date: "2026-09-04"
updated: "2026-09-04"
status: completed
type: sibling-eval
source_baseline: "docs/solutions/2026-07-01-superpowers-gstack-june-2026-eval.md"
source_repo: "https://github.com/obra/superpowers"
source_release: "v6.3.0"
source_commit: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797"
tasks_total: 5
tasks_completed: 5
tags: [sibling-eval, superpowers, codex, multi-agent, testing]
---

# obra/superpowers v6.1.1-v6.3 增量评估

> 本文只评估 2026-07-01 基线之后的增量，不实施代码。product-lens、coherence、feasibility 三路 reviewer 已在修订后通过。

## 0. Identity Question First

Tech Persistence 是 **developer-toolchain self-evolution sibling**：核心价值是 Claude Code / Codex 双运行时下，可审计、可恢复、可持续积累的工程上下文和验收证据。它不是完整 SDLC 方法论的替代品，也不以覆盖尽可能多的 coding harness 为目标。

四条评估原则：

| 原则 | TP 要求 | Superpowers 整体评分 | 证据与解释 |
|---|---|---|---|
| MR | Claude Code + Codex parity | PARTIAL / UNKNOWN | 多 harness 不等于 Claude Code/Codex 行为等价；公开 issue 也显示 adapter/test/bootstrap 漂移。 |
| DET | trust-critical path 不依赖 LLM 自律 | PARTIAL | 有 shell/JS/Python helper 与行为 eval，但 task routing、review、ruling 主要由 prompt 驱动。 |
| LT | 默认轻量，不要求 daemon/server/external DB | PARTIAL | 核心 `package.json` 无 runtime dependency，但 visual companion 是本地 server，并带可选远程 logo/version telemetry。 |
| OBS | durable knowledge 是 Markdown/frontmatter/可 grep | FAIL | SDD ledger 是临时 scratch，完成后删除并以 git 为记录；不是 Obsidian 知识层。 |

因此结论不是整包融合，而是只抽取不破坏四原则的 spine。

## 1. Evidence Collection

### 1.1 时间窗口与仓库状态

- 基线：[[2026-07-01-superpowers-gstack-june-2026-eval]]，覆盖到 Superpowers v6.1.0。
- 本轮窗口：2026-07-02 至 2026-09-04。
- 最新正式版：v6.3.0，2026-08-12，commit `b36e082`。
- v6.2.0：2026-07-23，commit `3dcbd5c`。
- `main`：681 commits；GitHub 页面在 2026-09-04 显示约 281.3k stars / 25.2k forks。
- `dev`：本轮只读 clone 的 tip 为 `fd02874`（2026-08-12）；相对 v6.3.0 的净功能 diff 为 0，只有 `CODE_OF_CONDUCT.md` 更新。因此 v6.3.0 仍代表最新功能状态。
- v6.1.0..v6.3.0：63 commits、78 files changed。其中 v6.1.0..v6.1.1 为 10 commits、15 files，包含 Codex hook auto-discovery 修复与 portal packaging；v6.1.1..v6.3.0 为 53 commits、76 files。

本地只读证据目录：`.tmp-superpowers/`（main）与 `.tmp-superpowers-dev/`（dev）。

### 1.2 语言与依赖面

按 tracked source bytes 统计（排除 Markdown、图片、配置，并纳入 4 个 extensionless Shell 入口）：Shell 54.1%、JavaScript family 36.5%、Python 5.1%、TypeScript 2.3%、HTML 2.0%。根 `package.json` 没有 dependencies；跨平台代价主要来自 shell、Git Bash、各 harness manifest 与测试矩阵，而不是 npm dependency tree。

### 1.3 v6.1.1-v6.3 的相关变化

| 版本 | 变化 | 本地证据 |
|---|---|---|
| v6.1.1 | Codex hook auto-discovery 修复；portal packaging 调整 | `.tmp-superpowers-dev/RELEASE-NOTES.md` 与 `v6.1.0..v6.1.1` diff |
| v6.2 | plan-scoped SDD workspace；resume implementer + scoped re-review + five-round breaker | `.tmp-superpowers-dev/RELEASE-NOTES.md:48-49` |
| v6.2 | skill 压缩、rationalization 放到触发点、每项裁剪做 micro-test | `.tmp-superpowers-dev/RELEASE-NOTES.md:53` |
| v6.2 | 测试可证伪：说清哪个生产变更会让测试失败；拒绝 string-presence/change-detector trap | `.tmp-superpowers-dev/RELEASE-NOTES.md:55` |
| v6.3 | spike/bounded/architectural 三路路由，流程厚度缩放但 approval 不缩放 | `.tmp-superpowers-dev/RELEASE-NOTES.md:13` |
| v6.3 | plan conflict 记录 ruling；preflight 产出 ledger 表 | `.tmp-superpowers-dev/RELEASE-NOTES.md:17-18` |
| v6.3 | small same-shape tasks 合批；review 按 brief 文件清单逐一核对 | `.tmp-superpowers-dev/RELEASE-NOTES.md:19` |
| v6.3 | implementer/reviewer 禁止继续 dispatch subagents | `.tmp-superpowers-dev/RELEASE-NOTES.md:20` |
| v6.3 | event-driven wait、显式 model+effort、Codex tool mapping 修正 | `.tmp-superpowers-dev/RELEASE-NOTES.md:26` |
| v6.3 | 清理 worktree 遇 untracked 时列出实际文件并停下询问 | `.tmp-superpowers-dev/RELEASE-NOTES.md:30` |

### 1.4 Identity Matrix

| 维度 | Superpowers v6.3 | Tech Persistence 当前事实 | 结论 |
|---|---|---|---|
| runtime | 多 harness、每个 harness 有 manifest/bootstrap 适配 | Claude Code + Codex parity，projection/validator 管同步 | 可借跨 runtime 测法，不扩 harness 清单 |
| persistence | plan 文档 + 临时 `.superpowers/sdd/<plan>` ledger，完成后删 | Markdown/frontmatter；v1 Sprint 有 acceptance pointer，agent-loop 有 `.agent-runs/<runId>` 与 authority evidence | 已覆盖范围内更强；普通 `/plan` 无同等 run 绑定，拒绝 basename scratch 实现 |
| determinism | prompt workflow + helper scripts + live eval | schema/CAS/hash/readback/Receipt 把关键状态下沉到确定性 runtime | 只借 artifact 形状，不把关键 gate 上移给 prompt |
| privacy | local-first；visual companion 可加载远程 logo/version | durable redaction、secret scan、默认本地；外部 PG 功能显式配置 | 不引入默认 telemetry/server |
| surface | 完整 SDLC methodology，14 个技能 | self-evolution + sprint/agent harness，按需 skill | 不 mirror 命令/技能面 |
| scaling | 每 task agent/review；v6.3 用 batching/model/wait 降成本 | 最多 3 child；pipeline slice + acceptance gate | 可借 batch/no-nesting，保留 TP owner 模型 |
| business model | MIT + commercial support/services | private package/toolchain，无相同商业目标 | 商业/marketplace 扩张不构成需求 |
| dependency surface | root 无 npm deps，但 shell/harness/可选 server 面广 | Node >=18；核心可本地运行，另有显式 PG/harness 子系统 | 新机制必须复用现有 runtime，不加 server |

## 1.5 Runtime Path Verification

以下 landing path 已实际 `Resolve-Path`/`Test-Path`：

- `codex-native/skills/plan/SKILL.md`
- `codex-native/skills/work/SKILL.md`
- `codex-native/skills/review/SKILL.md`
- `codex-native/skills/test-strategy/SKILL.md`
- `user-level/commands/{plan,work,review,test,skill-eval}.md`
- `.claude/rules/testing-patterns.md` 与 `.codex/rules/testing-patterns.md`
- `scripts/skill-size-budget.js`
- `codex-native/agents/{implementer,reviewer}.toml`
- `user-level/agents/claude-{implementer,reviewer}.md`
- `scripts/agent-orchestrator.js`
- `scripts/lib/clarifications.js`

关键对照也已 grep 验证：

- risk-scaled Plan：`codex-native/skills/plan/SKILL.md:10-18`
- frozen acceptance：`codex-native/skills/plan/SKILL.md:22`、`work/SKILL.md:10`、`review/SKILL.md:10`
- child 上限与共享工作树：`codex-native/skills/work/SKILL.md:24-27`
- async clarification/ruling：`plugins/tech-persistence/codex-skills/agent-loop/SKILL.md:265,286`
- run identity：agent-loop 使用 `.agent-runs/<runId>`，同名时 fail closed；v1 Sprint acceptance binding（`<plan>.acceptance.json`）的 `runLocator` 绑定 run。普通 `/plan` 不作同等能力声明。
- contract hash：以 `scripts/agent-orchestrator/global-contract.js` 为准；agent-loop 文档关于 hash 字段的描述已漂移，需另行修复。
- untracked 全量捕获：`scripts/agent-orchestrator.js:2721`

## 2. Candidate Plan

| ID | 候选 | MR/DET/LT/OBS | Surface / Spine | Landing place | 决策 |
|---|---|---|---|---|---|
| C1 | 测试可证伪门 + positive catalog | P/Partial/P/P | Mixed | Claude `test/work`、Codex `test-strategy/work` SoT；两份 testing-patterns rule | **P1 借鉴**；行为 eval 后再发布 prose |
| C2 | pre-dispatch conflict scan 产出共享边界证据与 ruling | P/Partial/P/P | Mixed | Claude `plan/work` 与 Codex `plan/work` SoT | **P2 条件实验**；仅多任务共享接口且现有 Plan 证据不足时触发 |
| C3 | small same-shape tasks 合成一个 child；按 assigned file list 核对遗漏 | Partial/Partial/P/Partial | Mixed | Claude/Codex `work`，需要时再含双方 `review` | **P2 eval hypothesis**；先定义 union ownership、逐子任务证据、部分失败与双 runtime 恢复语义 |
| C4 | task-scoped implementer/reviewer 默认禁止再委派 | Partial/Partial/P/P | Mixed | 双方 `work/review` controller 与 implementer/reviewer role 配置 | **P2 eval hypothesis**；runtime/tool-denial + 反例通过后才可把 DET 升为 Pass |
| C5 | resume original implementer + scoped re-review + bounded breaker | Partial/Partial/P/P | Mixed | 先对照 `agent-loop` follow-up/Receipt；若补 manual Work，落 `work`/`review` | **P2 backlog**，上下文保留是 spine，具体 agent/轮数是 surface |
| C6 | 非灾难性歧义记录 ruling 后继续 | P/P/P/P | Spine | 已有 `clarifications.md` append-only channel | **Cross-ref：已实现** |
| C7 | plan 内 `Spec:` pointer | P/P/P/P | Surface | v1 Sprint acceptance marker + frozen Contract；agent-loop contract/run evidence | **Scoped cross-ref**；普通 `/plan` 不声称同等绑定 |
| C8 | `.superpowers/sdd/<plan-basename>` workspace | P/P/P/Fail | Surface | 不落；v1 Sprint/agent-loop 继续用 run-scoped、冲突拒绝覆盖的 identity | **Hard reject surface**；普通 `/plan` 的绑定缺口另记 |
| C9 | skill 压缩时只删 recap/social proof，load-bearing rebuttal 移到触发点并 micro-test | P/Partial/P/P | Mixed | `scripts/skill-size-budget.js` + `user-level/commands/skill-eval.md` SoT | **P2 借鉴方法**，先补齐扫描口径，不新建 carve framework |
| C10 | 每次 spawn 强制 pin model+reasoning effort | Partial/Partial/P/P | Surface → Spine | 当前 collaboration schema / model-canary / usage telemetry | **P2 cost-policy/telemetry**；真实 flip：拒 blanket pin，保留成本可见性 |
| C11 | event-driven bounded wait | P/P/P/P | Surface | 当前平台 `wait_agent` 契约 + `work/review` 已使用 | **Cross-ref**；保留低空转且能发现失联 child 的 spine |
| C12 | 更多 harness + visual companion server/telemetry | Partial/Partial/Fail/Fail | Surface | 不落；视觉问题继续走 Figma/visualization 能力 | **Hard reject surface**；visual-question spine 已有落点 |
| C13 | “approval never scales” | P/Partial/P/P | Mixed | TP `think/plan` 风险 gate | **Cross-ref**：ceremony 随复杂度缩放；approval 由权限、范围扩张、可逆性与外部副作用决定 |

注：`P` 表示 pass。任何含 FAIL 的候选不直接进入实现；只能抽取不含该失败面的 spine。

互斥主决策计数：P1 1（C1）+ P2 6（C2/C3/C4/C5/C9/C10）+ cross-ref 4（C6/C7/C11/C13）+ hard reject 2（C8/C12）= 13。C10 的 blanket-pin surface 被拒，但候选主决策已真实翻为 P2，不重复计入 hard reject。C12 的 visual companion 早于本轮增量窗口，只用于约束当前整包架构，不视为 v6.2/v6.3 新增项。

## 3. Work

本轮是 research-only sibling eval，Phase 3 跳过。不修改 runtime、skill、rule、learning/instinct，不 commit、不 push。

## 4. Review Gate

- [x] product-lens reviewer 首轮：FAIL；已按本地价值证据收紧 C2-C4，并修正 MR/flip。
- [x] coherence reviewer 首轮：PASS_WITH_CONCERNS；已补 v6.1.1 增量与精确 landing path。
- [x] feasibility reviewer 首轮：FAIL；已修正 SoT、适用范围、DET 与实现引用。
- [x] defensive challenge：C10 产生 1 个真实 flip。
- [x] 三路 reviewer 复审修订稿：product-lens PASS、coherence PASS、feasibility PASS。

## 4.5 Defensive Challenge

| 初始拒绝 | 双向挑战 | flip |
|---|---|---|
| C10 blanket model pin | 拒的是每次 hardcode model，不是成本可见性 | spine flip 到 P2 cost policy/telemetry |

只计算 C10 为 flip。C8 与 C12 只是正确区分 surface/spine 后的 cross-ref，没有改变初始处置，不计 flip。

## 5. Outputs

- Plan：本文件。
- Decision：`docs/solutions/2026-09-04-superpowers-v63-eval.md`。
- Learning/instinct：0（任务未授权学习写入）。
- Solution index：review pass 后同步。

## Sources

- https://github.com/obra/superpowers
- https://github.com/obra/superpowers/releases/tag/v6.2.0
- https://github.com/obra/superpowers/releases/tag/v6.1.1
- https://github.com/obra/superpowers/releases/tag/v6.3.0
- https://github.com/obra/superpowers/compare/v6.1.0...v6.3.0
- https://github.com/obra/superpowers/compare/v6.1.1...v6.3.0
- https://github.com/obra/superpowers/issues/2045
- https://github.com/obra/superpowers/issues/2130
- https://github.com/obra/superpowers/issues/2157
- https://github.com/obra/superpowers/issues/2197
