---
title: "claude-mem 评估 — 0 直接借鉴 + 4 follow-up + 2 backlog + 5 hard reject + 1 自捕获新发现 (F13)"
date: 2026-05-26
tags: [solution, sibling-eval, external-reference, identity-question-first, evidence-based-recalibration, claude-mem]
related_instincts:
  - sibling-evaluation-defaults-to-framework-building
  - sibling-eval-completed-status-requires-review-pass
  - evidence-based-recalibration
  - reuse-existing-infra-before-building-new
  - mechanism-over-discipline
related_solutions:
  - "[[2026-05-21-gsd-eval]]"
  - "[[2026-05-18-sibling-eval-evidence-based-recalibration]]"
  - "[[2026-05-14-spec-kit-eval]]"
aliases: ["claude-mem-eval", "claude-mem sibling eval", "claude-mem-borrowing-decision"]
status: completed
sources:
  - "https://github.com/thedotmack/claude-mem (锚定 main 分支 fetch 日期 2026-05-26)"
  - "v13.3.0 (2026-05-21 release) — 78.3k★ / 6.7k fork / 1906+ commits / TS 91.5%"
  - "package.json deps: @anthropic-ai/claude-agent-sdk, @modelcontextprotocol/sdk, bullmq, express, ioredis, pg, react, zod"
  - "claude-mem CLAUDE.md (架构哲学)"
  - "claude-mem SECURITY.md (dual-tag 隐私模型 + Issue #354 安全审计)"
---

# claude-mem 评估 sprint — 0 直接借鉴 + 4 follow-up + 2 backlog + 5 hard reject

> **Status**: `completed`（Phase 4 三 reviewer 全 DONE_WITH_CONCERNS / NEEDS_CONTEXT，8 P0 + 4 P1 全修复；详见 `docs/plans/2026-05-26-claude-mem-eval.md` §Phase 4）

## Problem

用户请求："分析下 https://github.com/thedotmack/claude-mem"。

**claude-mem 是什么**：Claude Code 的 "persistent memory compression system"，v13.3.0，**78.3k★ / 1906+ commits / TS 91.5%**。架构含 SQLite + Chroma vector DB + FTS5 + Bun worker daemon (`37700 + uid%100`) + BullMQ/Redis 异步队列 + Postgres + React viewer UI @ :37777 + Claude Agent SDK。6 lifecycle hook + 3 MCP tools (search/timeline/get_observations) + mem-search skill + 4 runtime (Claude/Gemini/OpenCode/OpenClaw) + `<private>` dual-tag 隐私。

**TP 是什么**（[[ADR-011]] 4 不可妥协原则）：
- **MR**: multi-runtime parity Claude+Codex
- **DET**: determinism-first（grep + frontmatter，无 stochastic）
- **LT**: lightweight-first（无 daemon / 无 DB / 无队列）
- **OBS**: Obsidian-compat（pure markdown + frontmatter）

**Identity 矩阵（兼容性）**：

| 维度 | claude-mem | tech-persistence | 兼容 |
|------|-----------|------------------|------|
| 存储 | SQLite + Chroma + FTS5 + Postgres | pure markdown (Obsidian) | ❌ |
| 运行时 | Bun daemon @ :37700+uid%100 + uv + Node + Redis | hooks 静态执行 + scripts/lib | ❌ |
| 搜索 | 向量+关键词混合 stochastic | grep + frontmatter deterministic | ❌ (待 P0-6 scaling 验证) |
| Multi-runtime | Claude/Gemini/opencode/openclaw alt-install (heavy) | Claude/Codex parity (ADR-008/014 light) | ⚠ scope 不同 |
| 上下文注入 | 3 MCP tool 显式 query + skill | hook 自动 (Memory v5) + prompt-lookup skill | ✓ overlap |
| 持续学习 | 自动观察 tool 调用 → 摘要 → vector index | 自动观察 + 本能进化 + Memory v5 + topic file | ✓ overlap |
| 隐私 | `<private>` + `<claude-mem-context>` edge-strip at hook 层 | 无 redaction，observations.jsonl 全文捕获 | ❌ **F13 新发现** |
| 商业模式 | open-source core + headless Pro 扩展 | 单一开源（无 Pro 层） | N/A |

## Root Cause（评估外部 sibling project 的失效模式）

应用并实证 [[ADR-011]] identity-first + [[evidence-based-recalibration]] 协议（第 3 次 sibling-eval）：

1. **身份模糊**：不先回答"本项目是什么" → ROI 用错坐标
   - 缓解：§0 项目身份界定（TP=lightweight markdown solo+team / claude-mem=SaaS-grade DB-backed）
2. **脊椎/表面混淆**：把 claude-mem React UI 这类 surface 当作可拒整体
   - 实证打脸：P0-5 reviewer 指出 React UI 是 surface，其 spine = session-archaeology UX 被错杀
3. **拒绝面过宽**：N=0 secret 直接拒 edge-stripping
   - 实证 flip：F13 自发现，observations.jsonl 在本 sprint 即 capture 自己的 secret-shape regex，N=0 是 lucky 非 architectural safety
4. **测量错误**：grep path 错（`observations/` 目录 vs `observations.jsonl` 文件）、N 数错（exit-code 20→29 / spawn 10→14）
   - 缓解：Phase 4 feasibility reviewer 强制实跑 grep 验证

## Solution — 0 直接借鉴 + 4 Follow-up + 2 Backlog

### A) Identity-question-first ([[ADR-011]] 重申)

4 原则下过滤逻辑（对每候选评分 MR/DET/LT/OBS）：

- **MR**: 双 runtime parity，claude-mem 4 runtime alt-install 不在 TP scope
- **DET**: 优先 grep + frontmatter deterministic，vector search stochastic 违反
- **LT**: 单 sprint 文档 + Obsidian-friendly + 无 daemon，claude-mem Bun/Redis/Postgres/BullMQ 违反
- **OBS**: markdown + frontmatter + wiki-link，SQLite/Chroma 违反

### B) 候选清单与裁决（15 项）

#### Follow-up #1: edge-tag-stripping（升 P1，evidence-flipped 自 F13）

- **来源**: claude-mem `<private>...</private>` + `<claude-mem-context>` dual-tag，hook 层 edge-strip 后再进 worker/DB
- **TP gap**: `scripts/observe.js` 直接 `JSON.stringify(payload)` 写 `observations.jsonl`，无 redaction 层。所有 tool input/output/prompt 全文捕获
- **F13 自发现实证**：本 sprint 跑 `grep -rE "sk-..." ~/.claude/homunculus/` 后，**grep 命令本身（含 regex 字面值）被 observe.js 捕获到 observations.jsonl**，导致**后续 grep 同模式 N=21 hit 全是自捕获文本**——架构事实：任何 secret-shape 内容（无论 prompt / command / paste）都会永久 capture
- **detection signal**:
  - 初步: `grep -rE "sk-[a-zA-Z0-9]{40,}|ghp_[a-zA-Z0-9]{36,}|AIza[a-zA-Z0-9_-]{30,}|xoxb-|Bearer\s+[a-zA-Z0-9._-]{20,}|password\s*[:=]\s*['\"][^'\"]{6,}['\"]" ~/.claude/homunculus/projects/*/observations.jsonl`
  - 当前 N=0（actual secrets）— **但 N=∞ for "any future paste"**
- **立项条件**:
  - 任意用户 incident（误粘贴 API key 入 prompt）→ 立 P0
  - 或：实施 `<private>` opt-in 协议作为低成本预防（≤ 50 行 redaction.js + observe.js 1 处插入点）
- **Landing place** (P0-1 修正):
  - 新建 `scripts/lib/redaction.js`（`stripPrivateTags(text) → text` 纯函数）
  - 修改 `scripts/observe.js`（**单文件**，`main()` 内 `normalizeHookPayload` 之后插入 redaction，**不是 observe-tool-pre/post.js 两文件**）
- **不在本 sprint 实施原因**: evaluation sprint scope 不含实施；属下沉到下个 sprint 的 P1 follow-up
- **可吸收子能力**: dual-tag (`<private>` user-level + `<system-private>` recursive ban) — 协议 ≤ 20 行写 `.claude/rules/privacy-tags.md`

#### Follow-up #2: intentional-exit-codes（P1，N=29 signal 充分）

- **来源**: claude-mem 文档化 exit code 0=success/graceful, 1=non-blocking error, 2=blocking error，明示动机 "prevent Windows Terminal tab accumulation"
- **TP gap**: TP hook 脚本无统一 exit policy；[[debugging-gotchas]] 已有半条规则（"hook 不能 crash 主会话，catch 块必须 stderr 写 marker"）但未上升到 numeric exit code 三级语义
- **实例计数 N** (P0-2 修正): **N=29 scripts** 含 `process.exit(0/1/2)` 调用（`scripts/*.js` 非递归，含 prompt-submit.js 13 次最多 / agent-orchestrator.js 5 次 / archive-claude-solutions-index.js 5 次 / 其余 1-5 次），无 numeric 语义层。所有 exit() 变体 N=32 / 32 files。
- **立项条件**: N ≥ 10 ✓ 已满足
- **Landing place**:
  - 协议文档：`.claude/rules/hook-exit-codes.md`（≤ 40 行，参考 claude-mem CLAUDE.md 0/1/2 语义）
  - 后续 enforcement（可选）：`scripts/pre-commit-check.js` 加 `checkHookExitCodePolicy` 扫 hook 文件
- **不在本 sprint 实施原因**: 协议文档 ≤ 40 行可同 sprint 做，但 scope 是 evaluation；归 follow-up
- **dogfood 边界产物枚举** ([[ADR-013]] §B): 上线前必须列出 29 现有 scripts 中哪些已合规、哪些需改造、哪些 grandfather（test scripts vs production hook scripts 必分开）

#### Follow-up #3: SECURITY.md-telemetry-transparency（P1，与 #1 #4 绑定）

- **来源**: claude-mem `SECURITY.md` 明示 "no telemetry collected" + "content leaves via provider API" caveat + `<private>` 协议 + Issue #354 audit 时间线
- **TP gap**: TP 根无 `SECURITY.md`；hook 写本地 markdown 无 telemetry，但用户无文档可查证
- **立项条件**: Follow-up #1 (edge-stripping) 或 #4 (audit) 任一动手时必须同步写
- **Landing place**: `SECURITY.md`（根目录新建，单文件 ≤ 80 行）
  - 内容：数据存储位置（`~/.claude/homunculus/`）+ 不上传声明 + provider caveat + `<private>` 协议 + 漏洞披露流程
- **不在本 sprint 实施原因**: 与 Follow-up #1 绑定，单独写无 mechanism 支撑

#### Follow-up #4: grep-recall-telemetry（新增，回应 P0-6 product-lens "scaling assumption 未测"）

- **product-lens reviewer 挑战 (P0-6)**: TP pre-load 模型 (Memory v5 25KB) 假设 grep+frontmatter scaling 到 N→∞ topic files 仍 deterministic 足够，**未实测**；claude-mem 78.3k★ 是 "用户在纯 markdown 系统撞 recall wall" 的市场信号
- **TP gap**: Memory v5 当前 topic file 计数未追踪；grep miss-rate 无 telemetry → 任何 "vector search 不需要" 论断都是 faith-based
- **detection signal**: 加 `scripts/lib/memory-v5.js` 实测 hook（每次 SessionStart inject 时 log `{topic_count, total_bytes, hit_rate}` 到 `~/.claude/homunculus/telemetry/memory-recall.jsonl`）
- **立项条件**: topic_count > 100 且 inject 命中率 < 70% → 立项考虑 stochastic 二级层
- **Landing place**: `scripts/lib/memory-v5.js` 加 `recordRecallMetric()` 纯函数 + `scripts/inject-context.js` 调用
- **不在本 sprint 实施原因**: 需 ≥ 1 周 telemetry 收集才能决策；当前 topic_count 已知 < 50

### C) Backlog（P2，signal 收集中）

#### Backlog #1: i18n-mode（P2，N=0）

- **来源**: claude-mem `CLAUDE_MEM_MODE=code--zh` settings.json mode（中/日/英）
- **TP gap**: TP skill / sprint doc 默认中文混合英文术语
- **实例计数 N**: 用户请求"切英文输出" = 0（persona.md 已记录用户中文偏好）
- **立项条件**: N ≥ 2 → 立 i18n mode 提案
- **不实施原因**: N=0，无切换需求

#### Backlog #2: session-timeline-archaeology（新增，回应 P0-5 product-lens "surface vs spine"）

- **product-lens reviewer 挑战 (P0-5)**: 拒 React UI 时把 surface（React+:37777）与 spine（session-archaeology browsing："show me all sessions where I decided X"）一并拒；Obsidian 渲染单文件 ≠ 跨 session 因果浏览
- **TP gap**: `homunculus/projects/*/sessions/*.jsonl` 存在但无跨 session 时间线视图；`/review-learnings` 只列经验不可视化决策树
- **detection signal**: 用户问 "我上次什么时候做过 X" / "show me sessions about Y" 计数 → grep solution doc `grep -cE "上次|历史 session|跨 session" docs/solutions/`
- **当前 N**: 0 grep 命中
- **立项条件**: N ≥ 3 或 Obsidian Dataview query 性能问题出现
- **Landing place**: `scripts/memory-mcp-server.js` 加 `timeline` MCP tool（不是 React UI，是 deterministic markdown render → Obsidian 兼容）

### D) 已实现（2 项，无 gap）

| # | claude-mem | TP | 状态 |
|---|-----------|-----|------|
| Imp-1 | `CLAUDE_MEM_DATA_DIR` / `CLAUDE_MEM_WORKER_PORT` env 隔离 | `TECH_PERSISTENCE_HOME` (`scripts/lib/runtime-paths.js`) | ✓ 等价实现 |
| Imp-2 | 6 hook 含 PreToolUse | TP plugin runtime 注册 PreToolUse (`scripts/lib/hook-registry.js`, ADR-014) | ✓ 等价实现 |

### E) Hard reject（5 项，证据 + 双向挑战）

| # | 候选 | 拒绝原则 | 双向挑战结果 |
|---|------|---------|------------|
| HR-1 | SQLite + Chroma + FTS5 + Postgres | OBS + DET + LT | 双向：TP < 50 topic files grep 足够（待 Follow-up #4 实测验证）；vector 引入 stochastic 违反 DET。**Hard reject 保持**，但 Follow-up #4 telemetry 为未来 stochastic 二级层留窗 |
| HR-2 | Bun worker daemon @ :37700+uid%100 | LT + DET | 双向：daemon 解决 ≥ 100 ops/s 并发场景，TP solo+team 同步 hook < 200ms 已够；daemon 增加 start/stop/crash 生命周期。**Hard reject** |
| HR-3 | BullMQ + Redis + Postgres 异步队列 | LT | 双向：异步队列对 ≥ 1000 ops/sec 有用，TP 单用户每 session < 100 hook trigger。**Hard reject** |
| HR-4 | React viewer UI @ :37777 (surface) | LT + OBS | **P0-5 修正**：surface = React UI hard reject；spine = session-archaeology browsing → 抽出为 Backlog #2 |
| HR-5 | 4 runtime 扩展（Gemini/OpenCode/OpenClaw）| TP scope | 双向：TP scope = Claude+Codex parity (ADR-008/014)；扩 runtime 增加副本同步面积 ×N。Gemini/OpenCode 用户增长 signal = 0。**Soft reject**（重评条件：≥ 2 PR/issue 触发）|

### F) 防御性拒绝挑战（[[evidence-based-recalibration]] §Step2.5）

**Q1**: "拒绝 SQLite/Chroma 是 OBS 原则还是真的没价值？"
- 答 (修订 P0-6): **不再 trivially "双重支持拒绝"**。Follow-up #4 (grep-recall-telemetry) 承认 scaling 未测，留 stochastic 升级窗口。**当前拒绝保持但 epistemic humility 写入**

**Q2**: "拒绝 daemon 是 LT 原则还是真不需要异步？"
- 答: hook 执行 < 200ms（grep + 文件 IO）；daemon 增加 start/stop/crash recovery 复杂度。**双重支持拒绝**

**Q3**: "拒绝 React UI 是 OBS 原则还是用户真不需要可视化？"
- 答 (修订 P0-5): **flip — surface vs spine 区分**。React UI surface hard reject；session-archaeology spine 抽出为 Backlog #2

**Q4**: "edge-tag-stripping N=0 等于不需要？"
- 答 (修订 F13 自发现): **flip — N=0 是 lucky 不是 architectural safety**。observations.jsonl 全文捕获机制本身就是泄露面，本 sprint 即活样本（recursive secret-shape capture）

**Step2.5 统计**：4 challenges → **2 flips（Q3 + Q4）+ 2 双重支持**。对比 [[gsd-eval]] 2 防御性拒绝改正，本评估 2 flips → 协议非 ceremonial（[[product-lens-rubber-stamp-test]]）

## TL;DR — 决策表

| # | 候选 | 裁决 | landing | 立项条件 |
|---|------|------|---------|---------|
| 1 | edge-tag-stripping (`<private>` dual-tag) | **P1 Follow-up** | `scripts/observe.js` + `lib/redaction.js` | 任意 secret incident 或主动预防 |
| 2 | intentional exit-codes 0/1/2 | **P1 Follow-up** | `.claude/rules/hook-exit-codes.md` | N=29 已 ≥ 10 ✓ |
| 3 | SECURITY.md telemetry transparency | **P1 Follow-up** | `SECURITY.md` 根目录 | 与 #1 / #4 任一绑定 |
| 4 | grep-recall telemetry (新增 P0-6) | **P1 Follow-up** | `scripts/lib/memory-v5.js` + `inject-context.js` | topic_count > 100 且 hit_rate < 70% |
| 5 | per-user data dir env var | ✓ 已实现 | `TECH_PERSISTENCE_HOME` | — |
| 6 | PreToolUse hook | ✓ 已实现 | `hook-registry.js` ADR-014 | — |
| 7 | i18n mode (`code--zh`) | **P2 Backlog** | settings.json mode key | N ≥ 2 用户请求切换 |
| 8 | session-timeline archaeology (新增 P0-5) | **P2 Backlog** | `memory-mcp-server.js` 加 timeline tool | N ≥ 3 用户问 "上次何时做 X" |
| 9 | SQLite + Chroma | ❌ Hard reject (OBS+DET+LT) | — | — |
| 10 | Bun daemon | ❌ Hard reject (LT+DET) | — | — |
| 11 | BullMQ + Redis + Postgres queue | ❌ Hard reject (LT) | — | — |
| 12 | React UI viewer surface | ❌ Hard reject (LT+OBS) | spine 已抽出为 #8 | — |
| 13 | 4 runtime alt-install | ⚠ Soft reject (scope) | — | ≥ 2 Gemini/OpenCode PR/issue |
| 14 | provider-error-from-stdout (cross-ref) | backlog (无新增) | 与 [[debugging-gotchas]] 2026-05-11 entry 闭环 | — |
| 15 | audit-driven security log | **合并到 Follow-up #3** + [[gsd-eval]] FU#3 | `SECURITY.md` timeline | secret/injection scan 命中 ≥ 1 |

**汇总**: 0 直接借鉴 + 4 P1 Follow-up + 2 P2 Backlog + 2 已实现 + 5 Hard reject (1 含 spine 抽出) + 1 Soft reject + 1 cross-ref = **15 ✓**

## Prevention（自学习沉淀）

### 新本能信号（待 /evolve）

1. **[[sibling-eval-self-observation-recursive-capture]]**: 任何 sibling-eval 跑 secret-shape regex 时，TP 自己的 observations.jsonl 即捕获该 regex → grep result N=0 不等于 "无泄露面"。secret-pattern grep 必须从 path filter 排除自捕获 (e.g., `--exclude-dir=homunculus`) 或承认 N=0 是 lucky 非 architectural safety
2. **[[sibling-eval-feasibility-reviewer-must-runtime-verify]]**: Phase 4 feasibility reviewer 必跑实际 grep 验证 sprint doc 报告的 N 数；文档级 N 报错率历史: 本 sprint exit-code N=20 实际 N=29 (45% 误差) / spawn N=10 实际 N=14 (40% 误差) / grep path `observations/` 应为 `observations.jsonl`
3. **[[sibling-eval-surface-vs-spine-product-lens-mandatory]]**: hard-reject 必有 surface (实现) vs spine (用户价值) 双向 challenge；本 sprint #14 React UI 起初一并 reject，product-lens 抽出 spine = session-archaeology 升 Backlog #2

### 更新已有本能

- **[[evidence-based-recalibration]]**: 加 §Step1.5 "N 实测路径必须 file glob 实跑，不能凭直觉写 path"（本 sprint `observations/` vs `observations.jsonl` 教训）
- **[[product-lens-rubber-stamp-test]]**: defensive challenge 应有 ≥ 1 flip，否则视为 ceremonial（本 sprint Q3+Q4 双 flip 通过测试，对比 gsd-eval 2 flip / spec-kit-eval 0 flip）

### 跨 sibling 模式（meta finding，回应 P2-2）

3 次 sibling-eval（spec-kit / gsd / claude-mem）+ 1 次 mattpocock followup 累计：
- spec-kit: 2 借鉴 + reviewer 闭环
- mattpocock: 4 借鉴推荐（**全部错**，后被 recalibration 复评）
- gsd: 0 直接 + 5 follow-up + 11 reject + 2 防御性改正
- claude-mem (本): 0 直接 + 4 follow-up + 2 backlog + 5 hard reject + 1 cross-ref

**Pattern**: sibling-eval 结构性偏拒绝是 by design（4 不可妥协原则就是过滤器），不是 bug。但**应警惕 "拒绝 = 正确" 偏见**——本 sprint 2 P0 product-lens finding（surface/spine 混淆 + scaling 未测）即源于该偏见。

**Sprint backlog 议题**: 是否需 retrospective sprint 复盘 sibling-eval 协议是否系统性 reject-biased？或仅在 ≥ 5 次 eval 后再决策？

## References

- 评估目标: https://github.com/thedotmack/claude-mem (v13.3.0, 2026-05-26 fetch)
- 前序 sibling-eval: [[2026-05-21-gsd-eval]], [[2026-05-18-sibling-eval-evidence-based-recalibration]], [[2026-05-14-spec-kit-eval]]
- 相关 ADR: [[ADR-011]] (identity-first), [[ADR-013]] (mechanism-over-discipline), [[ADR-014]] (hook-registry parity), [[ADR-008]] (compat read dirs), [[ADR-015]] (persona top-level)
- Sprint 主文档: `docs/plans/2026-05-26-claude-mem-eval.md`
