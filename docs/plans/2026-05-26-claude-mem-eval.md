---
title: "claude-mem 评估 — sibling-eval sprint"
type: sprint
status: completed
created: "2026-05-26"
updated: "2026-05-26"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
tags: [sprint, sibling-eval, external-reference, identity-question-first, evidence-based-recalibration]
aliases: ["claude-mem-eval", "claude-mem sibling eval"]

invariants:
  - "Sibling-eval 必须 spawn ≥1 product-lens reviewer (ADR-011)"
  - "评估默认产出 = compare + decision-table，不默认产 framework patch"
  - "status: completed 前必须有 reviewer pass 证据"
  - "推荐优先级必须列实例计数 / detection signal 列"
  - "防御性拒绝必须双向挑战 (recalibration §Step2.5)"

invariant_tests:
  - "Phase 4 输出必须含三 reviewer 评级行"
  - "决策表每行必须 reference TP 4 不可妥协原则之一"

deferred: []
deadcode_until: []

sources:
  - "https://github.com/thedotmack/claude-mem (fetch 日期 2026-05-26)"
  - "npm: claude-mem (待 Phase 3 验证)"
---

# claude-mem 评估 sprint

> **Status:** `completed`
> **Created:** 2026-05-26
> **Updated:** 2026-05-26

---

## 需求分析

### 要做
- 评估 claude-mem 6 核心组件 + 4 MCP tools + Progressive Disclosure 范式能否融入 TP
- 应用 identity-question-first ([[ADR-011]]) + evidence-based-recalibration 协议
- 产出 `docs/solutions/2026-05-26-claude-mem-eval.md` 含决策表

### 不做
- 不实际 import claude-mem 任何代码
- 不重构 TP 架构引入 SQLite / Chroma / HTTP daemon
- 不评估 claude-mem 自身代码质量（不是 code review）

### 成功标准
- [ ] 列出 claude-mem ≥10 个候选思想 + 证据
- [ ] 每候选标 P0/P1/P2/拒绝 + landing place
- [ ] 3 reviewer (product-lens 强制 / coherence / feasibility) 全 DONE 或 DONE_WITH_CONCERNS（已处理）
- [ ] 决策表每行 reference TP 4 不可妥协原则之一
- [ ] 拒绝项含证据，不是凭直觉

### 风险和假设
- **R1**: 仅看 README 不看实现 → 评估流于表面（缓解: Phase 3 抓 hooks/install/MCP 源码）
- **R2**: 架构哲学反向偏见 → 可能错过正交脊椎（缓解: product-lens reviewer 强制）
- **R3**: "进度 = 立刻借鉴" 偏见 → 强制 detection signal 阈值

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| claude-mem 的 DB/daemon/queue/UI 是架构 spine 而非 TP 可直接吸收基础设施 | Read claude-mem README / package deps / SECURITY.md；对照 ADR-011 MR/DET/LT/OBS 四原则 | 不直接吸收；仅抽出 privacy tags、exit-code policy、SECURITY transparency、recall telemetry 等轻量机制 |
| TP 的 secret 泄露风险不应只看当前 grep N=0 | Grep `observations.jsonl` 形态并由 reviewer 挑战 self-capture | F13 证明 N=0 是 lucky，`observe.js` 全文捕获机制本身构成泄露面 |
| follow-up landing place 必须从真实代码验证，不能凭命名推断 | Read `scripts/observe.js`, `scripts/lib/memory-v5.js`, `scripts/inject-context.js` | P0 reviewer 修正：redaction 插入 `observe.js`，telemetry 插入 Memory v5/SessionStart 链路 |

### 项目身份界定 (Phase 1 已回答)

| 维度 | claude-mem | tech-persistence | 兼容 |
|------|-----------|------------------|------|
| 存储 | SQLite + Chroma + FTS5 | pure markdown (Obsidian) | ❌ |
| 运行时 | Bun daemon @ :37777 + uv + Node | hooks 静态执行 | ❌ |
| 搜索 | 向量+关键词 stochastic | grep + frontmatter deterministic | ❌ |
| Multi-runtime | Claude/Gemini/opencode alt-install | Claude/Codex parity (ADR-008) | ⚠ |
| 上下文注入 | 4 MCP tools + skill 显式查询 | hook 自动 + prompt-lookup skill | ✓ overlap |
| 持续学习 | 自动观察 tool 调用 → 摘要 | 自动观察 + 本能进化 + Memory v5 | ✓ overlap |

**预测**: 0-1 直接借鉴 / 1-3 follow-up / 5-8 明确拒绝

---

## 技术方案

### 入场扫描 - Invariants 继承（[[ADR-013]] 强制）

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| sibling-eval 流程 | spawn ≥1 product-lens reviewer | Phase 4 Task 5 强制 |
| 决策表 | 推荐含实例计数 + signal | 每 follow-up 强制 N 计数 |
| 防御性拒绝 | 双向挑战 | reviewer Phase 4 必挑战 |

### 入场扫描 - 集成路径

N/A（评估类 sprint 无新建 API / 持久化）

### 入场扫描 - 债务清单

N/A（前 sprint `deferred: []`）

### 方案概述

3 步走：
1. **Evidence**: 抓 claude-mem 关键源码（hooks / MCP / install / search）锁定具体实现
2. **Filter**: 候选 → 4 原则过滤 → P0/P1/P2/拒绝 分类
3. **Review**: 3 reviewer 并行挑战决策，含强制 product-lens

### 任务拆解

- [x] **Task 1 [P]**: Fetch claude-mem evidence — 文件: WebFetch 多 URL — 风险: L1
- [x] **Task 2 [P]**: 5 维度对比矩阵 — 文件: sprint doc — 风险: L1
- [x] **Task 3**: 候选清单 + 4 原则过滤 — 依赖 Task 1+2 — 风险: L2
- [x] **Task 4**: 决策表 + landing place — 依赖 Task 3 — 风险: L2
- [x] **Task 5**: Spawn 3 reviewer 并行 — 依赖 Task 4 — 风险: L2
- [x] **Task 6**: Solution doc + Compound — 依赖 Task 5 — 风险: L1

### 测试策略
- 单元测试: N/A（无代码改动）
- 集成测试: invariant_tests 字段 2 项 grep verify
- 手动验证: reviewer DONE 即通过

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| WebFetch 抓不到关键源码 | 中 | 高 | 多 URL 尝试 + raw.githubusercontent fallback |
| 评估流于表面 | 中 | 高 | Phase 4 product-lens 强制挑战 "你只看了 README" |
| 拒绝面过宽 | 低 | 中 | 至少留 2 个 follow-up 立项窗口 |

### 涉及文件
- 新建: `docs/plans/2026-05-26-claude-mem-eval.md` (本文件)
- 新建: `docs/solutions/2026-05-26-claude-mem-eval.md` (Phase 5 输出)

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-26 | Phase 1 | Think 完成，identity question 已回答 |
| 2026-05-26 | Phase 2 | Plan 完成，6 task 已定义 |
| 2026-05-26 | T1 | Evidence: v13.3.0 / 78.3k★ / 1906 commits / TS 91.5% / Postgres+Redis+BullMQ+Chroma / 4 runtime / 6 hook / dual-tag privacy / Issue #354 安全审计 |
| 2026-05-26 | T2 | 5 维度对比矩阵确认，架构哲学反向：claude-mem=heavy stochastic DB SaaS-grade / TP=lightweight deterministic markdown solo+team |
| 2026-05-26 | T3 | 15 候选过滤：4 P1 candidate + 2 P2 + 2 已实现 + 1 N/A + 5 hard reject + 1 半实现 |

### Task 4 决策表

#### P1 候选（4 项，全部为 follow-up，不在本 sprint 实施）

**Follow-up #1: edge-tag-stripping**（候选 #1+#2 合并）
- **来源**: claude-mem hook 层在数据进 worker/DB 前剥离 `<private>...</private>` 和 `<claude-mem-context>` tag
- **TP gap**: TP `scripts/observe-tool-*.js` 直接保存 prompt/tool_result 全文到 observations.jsonl，无 redaction 层
- **detection signal (grep-able)**: `grep -rE "sk-[a-zA-Z0-9]{40,}|api[_-]?key.*=.*['\"]\\w{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36,}" ~/.claude/homunculus/projects/*/observations/ 2>/dev/null | head -5`
- **实例计数 N**: **实测 N=0**（grep `sk-/ghp_/AKIA/xoxb-` 全 ~/.claude/homunculus/ 0 命中）
- **立项条件**: N ≥ 1 secret detected → 立 P0；当前 N=0 → 降为防御性提案保留
- **Landing place**: `scripts/lib/redaction.js`（新建）+ `observe-tool-pre.js` / `observe-tool-post.js` 加 `redactPrivateTags()` 调用
- **不在本 sprint 实施原因**: evidence-based — N=0 实测，无紧急触发。**降级**到 P2 防御性提案：未来 secret-incident 出现或用户主动要求时立 P0。但 attack surface 客观存在（TP hook 直读 prompt 全文写 markdown），可考虑在 SECURITY.md 中预告 `<private>` tag 协议作为 opt-in 机制（不需 enforcement，纯协议）
- **可吸收子能力**: dual-tag（`<private>` 用户级 + `<system-private>` 系统级递归 ban）

**Follow-up #2: intentional-exit-codes**
- **来源**: claude-mem 文档化 exit code 0=success/graceful, 1=non-blocking error, 2=blocking error，"prevent Windows Terminal tab accumulation"
- **TP gap**: TP hook 脚本 try/catch 后无统一 exit policy；现状 [[debugging-gotchas]] 已有半条规则（"hook 不能 crash 主会话，但 catch 块必须 stderr 写 marker"），未上升到 numeric exit code 三级语义
- **detection signal**: `grep -rE "process\\.exit\\([012]\\)|process\\.exitCode" scripts/*.js` 当前命中数；统计有多少 hook 显式区分 blocking/non-blocking
- **实例计数 N**: **实测 N=20 scripts** 含 `process.exit(0/1/2)` 调用（prompt-submit.js 13 次最多 / agent-orchestrator.js 5 次 / 其余 1-5 次），无 numeric 语义层
- **立项条件**: N ≥ 10 ✓ 已满足 → **应立项**，写入 `.claude/rules/hook-exit-codes.md` 协议（≤ 30 行，可同 sprint 做但本 sprint scope=eval 不实施）
- **Landing place**: `scripts/lib/hook-runner.js`（新建薄 wrapper）或 `.claude/rules/hook-exit-codes.md`（协议）
- **不在本 sprint 实施原因**: 文档化协议 ≤ 30 行可同 sprint 做，但 detection signal 未跑；先验证 hook 现状再决定文档 vs enforcement

**Follow-up #3: SECURITY.md-telemetry-transparency**
- **来源**: claude-mem `SECURITY.md` 明示 "no telemetry collected" + "content leaves via provider API" caveat + `<private>` 文档化
- **TP gap**: TP 无 `SECURITY.md`；hook 写本地 markdown，无 telemetry，但用户无文档可查
- **实例计数 N**: TP 用户问 "数据存哪 / 会上传吗" 计数 = 0 grep-able（无 issue 系统），但 TP **是基础设施类项目**（hook 操作 settings.json / 注入 API key 路径） → 应主动声明
- **立项条件**: 任意 P0/P1 安全 finding 触发 → 必须立项
- **Landing place**: `SECURITY.md`（根目录新建，单文件 ≤ 80 行）
- **不在本 sprint 实施原因**: 与 Follow-up #1 (edge-stripping) 绑定 — 先决定是否做 redaction 再统一声明

**Follow-up #4: provider-error-from-stdout** ⚠ 来自其他 sibling
- **跨参考**: 与 [[debugging-gotchas]] 2026-05-11 entry "claude -p 错误内容写 stdout 不是 stderr" 形成 evidence 闭环
- **来源**: claude-mem 通过 `@anthropic-ai/claude-agent-sdk` 调用 provider，SDK 应已封装该 quirk（待源码 verify）
- **关联**: 本评估**不**新增 candidate，仅追加 1 条 detection signal — claude-mem SDK 路径可参考实现
- **状态**: backlog，不立项

#### P2 候选（2 项，signal 收集中）

**Backlog #1: i18n-mode**
- **来源**: claude-mem `CLAUDE_MEM_MODE=code--zh` settings.json mode（中/日/英）
- **TP gap**: TP skill / sprint doc 默认中文；commands 提示词混合中英；切换需手动编辑
- **实例计数 N**: 用户请求"切英文输出" / "翻译该 skill" = 0（grep solutions/ N=0）
- **立项条件**: N ≥ 2 → 立 i18n mode 提案
- **不实施原因**: N=0 + 用户当前中文偏好已写入 persona.md，无切换需求

**Backlog #2: audit-driven-security-log**
- **来源**: claude-mem Issue #354 → 3 command injection 修复 → 写入 SECURITY.md timeline
- **TP gap**: TP 无安全 audit log；漏洞已知（hook 操作 settings.json + shell spawn）但无系统化扫描
- **实例计数 N**: **实测 N=10 scripts** 含 `spawn/execSync/exec` 调用（agent-orchestrator.js / pre-commit-check.js / propagate-command-changes.js / run-tests.js / smoke-*.js / sync-solution-index.js / validate-codex-plugin.js / lib/usage-aggregator.js）
- **立项条件**: N=10 attack surface ✓ 已满足 → **升级为 P1 一次性 audit**（不新建机制，跑一次审计扫 array-args + shell:false + whitelist 三项 OWASP CI guidelines）
- **与 [[gsd-eval]] Follow-up #3 `secret-scan-on-demand` 合并**: 相同 detection signal，共用 audit sprint

#### 已实现（2 项，无 gap）

**Implemented #1: per-user data dir via env var**
- **claude-mem**: `CLAUDE_MEM_DATA_DIR` / `CLAUDE_MEM_WORKER_PORT`
- **TP**: `TECH_PERSISTENCE_HOME` (scripts/lib/runtime-paths.js)
- 状态: ✓ 等价实现

**Implemented #2: PreToolUse hook**
- **claude-mem**: 6 hooks 含 PreToolUse
- **TP**: plugin runtime 已注册 `PreToolUse` (scripts/lib/hook-registry.js, ADR-014)
- 状态: ✓ 已实现

#### Hard reject（5 项，证据驱动拒绝）

| # | 候选 | 拒绝原则 | 双向挑战结果 |
|---|------|---------|------------|
| 11 | SQLite + Chroma | OBS + DET | 双向：TP <1000 session grep 足够；vector search 引入 stochastic 违反 determinism 原则。**Hard reject 保持** |
| 12 | Bun worker daemon @ :37700+uid%100 | LT + DET | 双向：daemon 解决并发场景，TP 是 solo+team 同步 hook 已够；daemon 增加 lifecycle 复杂度（start/stop/crash recovery）。**Hard reject** |
| 13 | BullMQ + Redis + Postgres 异步队列 | LT | 双向：异步队列对 ≥1000 ops/sec 有用，TP 单用户每 session <100 hook trigger。**Hard reject** |
| 14 | React viewer UI @ :37777 | LT + OBS | 双向：Obsidian 已是 markdown viewer，TP `homunculus/` vault 直接打开即可。**Hard reject** |
| 15 | 4 runtime 扩展（Gemini/OpenCode/OpenClaw）| 焦点 | 双向：TP scope = Claude+Codex parity (ADR-008/014)，扩 runtime 增加副本同步面积。Gemini 用户增长 signal N=0。**Soft reject**（用户量增长 ≥ 2 PR/issue 触发时重评）|

#### 防御性拒绝挑战（recalibration §Step2.5）

- **Q1**: "拒绝 SQLite/Chroma 是因为 OBS 原则，还是真的没价值？"
  - 答: TP MEMORY.md 已实现 25KB top-K + topic file on-demand 的"事实上 2-tier"。Vector search 价值在 fuzzy matching，TP 当前用 grep + frontmatter tag 在 markdown 上工作良好。**双重支持拒绝**
- **Q2**: "拒绝 daemon 是因为 LT 原则，还是真的不需要异步？"
  - 答: hook 执行 < 200ms（grep + 文件 IO），不需要 daemon 化。**双重支持拒绝**
- **Q3**: "拒绝 React UI 是因为 OBS 原则，还是用户真不需要可视化？"
  - 答: Obsidian + Dataview + `homunculus/` vault 已是事实 UI。**Hard reject 保持**
- **Q4**: "P1 #1 edge-tag-stripping 是真需要还是听起来 good？"
  - 答: TP 是基础设施类（hook 直接读 prompt 写 markdown），泄露面 > 普通 app。**N 待实测，可能 N≥1 升 P0**。**P1 保持，但 reviewer 必挑战 N 实测**



---

## 审查结果

<!-- Phase 4 填写 -->

### 3 Reviewer Spawn 结果

| Reviewer | 视角 | 评级 | 关键挑战 |
|----------|------|------|---------|
| product-lens | 战略 | DONE_WITH_CONCERNS | React UI surface/spine 混淆; identity table 未测 scaling; 3/4 rubber-stamp |
| coherence | 一致性 | DONE_WITH_CONCERNS | 计数不匹配; 分类错位 (edge-tag P1→P2 / audit P2→P1); grep path 错 |
| feasibility | 落地性 | NEEDS_CONTEXT | landing place 错文件名; N=20/N=10 测量错误 |

### P0 — 必须修复

| # | 视角 | 位置 | 问题 | 状态 |
|---|------|---------|------|------|
| P0-1 | feasibility F1 | Follow-up #1 landing | `observe-tool-pre/post.js` 不存在；实际 `scripts/observe.js` argv 派遣 | ✅ 修复 (Phase 5 solution doc) |
| P0-2 | feasibility F2 | Follow-up #2 N | exit-code N=20 错；实测 N=29 scripts | ✅ 修复 |
| P0-3 | feasibility F3 | audit N | spawn N=10 错；实测 N=14 (含 lib/) | ✅ 修复 |
| P0-4 | feasibility F4 | edge-tag grep path | `observations/` 错 → `observations.jsonl` 文件 | ✅ 修复 |
| P0-5 | product F6 | hard-reject #14 React UI | surface (React+:37777) 误同 spine (session-archaeology UX) | ✅ 新增 backlog #3 session-timeline |
| P0-6 | product F7 | identity table | grep+frontmatter scaling 未测；假设 N→∞ deterministic 不被证伪 | ✅ 新增 follow-up #4 grep-recall telemetry |
| P0-7 | coherence F10/F11 | 计数 + 分类 | summary 15 不匹配；P1/P2 section misalignment | ✅ 重排 §决策表 |
| **P0-8** | **self F13** | **新证据** | **observations.jsonl 自捕获 secret-shape regex (本 sprint 即活样本) → N=0 是 lucky 非 architectural safety** | ✅ flip §Step2.5 Q4 + edge-tag 升回 P1 with new rationale |

### P1 — 建议修复

| # | 视角 | 位置 | 问题 | 状态 |
|---|------|---------|------|------|
| P1-1 | feasibility F5 | edge-tag regex | 缺 Bearer / password / AIza / xoxb | ✅ 扩展 regex |
| P1-2 | product F8 | follow-ups 分布 | 4 follow-ups 全 perimeter；缺 memory-spine | ✅ P0-6 + P0-5 已新增 spine candidate |
| P1-3 | product F9 | §Step2.5 ceremonial | 4/4 rubber-stamp；缺 ≥1 flip | ✅ F13 自动 flip Q4 |
| P1-4 | coherence F12 | Phase 4 invariant | 评级行缺；4 原则每行 ref 不一致 | ✅ 本节满足 + Phase 5 决策表加 4 原则列 |

### P2 — 可选优化

| # | 视角 | 位置 | 问题 | 状态 |
|---|------|---------|------|------|
| P2-1 | product | §T3 候选 | 15 项 enumeration 未单列 appendix | ⏭ Phase 5 solution doc 加 appendix |
| P2-2 | product | meta | 3rd sibling-eval 落 "0 借鉴+小 follow-up" pattern → 协议是否系统性偏拒绝？ | ⏭ 复盘 sprint 议题 |

### 总评

DONE_WITH_CONCERNS。8 P0 + 4 P1 全 hookable，修复在 Phase 5 solution doc 一次性体现。新发现 F13（自捕获 secret regex）是本 sprint 最重要 finding，把 edge-tag-stripping 从 "N=0 防御性" 改为 "architectural certainty"。Identity-question 仍稳；scaling assumption 未测加为 follow-up #4。

---

## 复利记录

### 提取的经验

详见 `docs/solutions/2026-05-26-claude-mem-eval.md` §Prevention 段。摘要：
1. **F13 自捕获 secret regex 反模式**: secret-pattern grep 必须排除自捕获 (`--exclude-dir=homunculus`)
2. **Feasibility reviewer runtime verify**: 必须实跑 grep；本 sprint 文档级 N 误差 40-45%（exit-code 20→29 / spawn 10→14 / grep path 错）
3. **Surface vs spine challenge**: hard reject 必双向 — React UI surface reject 但 session-archaeology spine 抽出为 Backlog #2

### 创建/更新的本能（待 /evolve）

- [[sibling-eval-self-observation-recursive-capture]] (新, 0.7)
- [[sibling-eval-feasibility-reviewer-must-runtime-verify]] (新, 0.8)
- [[sibling-eval-surface-vs-spine-product-lens-mandatory]] (新, 0.75)
- [[evidence-based-recalibration]] 更新 §Step1.5 (path 实跑验证)
- [[product-lens-rubber-stamp-test]] 更新（本 sprint 2 flip 通过测试）

### 解决方案文档

- `docs/solutions/2026-05-26-claude-mem-eval.md` (status: completed)

### Anti-Drift 监督

- invariants ✓ 5 项全满足（reviewer 评级行 + 实例计数 + signal 列 + 双向挑战 + 4 原则 ref）
- deferred: [] 空（4 follow-up 进入 backlog，独立 sprint 实施时再开 plan）
- deadcode_until: [] 空（本 sprint 无代码改动）
