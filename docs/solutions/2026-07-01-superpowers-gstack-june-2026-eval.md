---
title: "obra/superpowers + garrytan/gstack 2026-06 更新评估 — 可借鉴项收敛到 token、安全、决策可见性、eval 隔离"
date: "2026-07-01"
tags: [solution, sibling-eval, external-reference, superpowers, gstack, architecture]
related_instincts:
  - sibling-eval-default-compare-not-borrow
  - target-user-mismatch-invalidates-borrow
  - sibling-evaluation-defaults-to-framework-building
  - documented-claim-vs-code-reality-drift
related_solutions:
  - "[[2026-05-12-gstack-analysis-reframe-lessons]]"
  - "[[2026-05-22-gstack-design-lens-double-track]]"
  - "[[2026-06-17-native-goal-sibling-eval]]"
  - "[[2026-06-05-ecc-eval]]"
aliases: ["superpowers-gstack-june-2026", "superpowers gstack latest eval", "2026-06 sibling eval"]
status: draft
sources:
  - "https://github.com/obra/superpowers (git clone/read on 2026-07-01)"
  - "https://github.com/garrytan/gstack (git clone/read on 2026-07-01)"
  - "superpowers RELEASE-NOTES.md at f268f7c / v6.1.0"
  - "gstack CHANGELOG.md at 11de390 / v1.58.5.0"
---

# obra/superpowers + garrytan/gstack 2026-06 更新评估

> Status: `draft`。本文件是研究落盘，尚未跑独立 `/review` 二次审查；借鉴结论按当前证据可用，但不等于已排期实施。

## Problem

用户请求：研究 [obra/superpowers](https://github.com/obra/superpowers) 和 [garrytan/gstack](https://github.com/garrytan/gstack) 最近一个月更新了哪些内容，以及哪些值得直接借鉴到当前 `tech-persistence` 架构里。

时间窗口按本会话当前日期固定为：

```text
2026-06-01 00:00:00 <= commit/release <= 2026-07-01 23:59:59
```

本评估延续 [[2026-05-12-gstack-analysis-reframe-lessons]] 的约束：外部 sibling-eval 默认是 compare + pros/cons，不是实施承诺；每个候选先过 TP 的 4 条不可妥协原则：

| 原则 | 约束 |
|---|---|
| multi-runtime parity | Claude/Codex 双运行时不能变成二等路径 |
| 确定性优先 | trust-critical 逻辑优先脚本/测试/文件 artifact，不靠模型记得 |
| 轻量优先 | 不引入 DB、后台 daemon、重型依赖、无证命令扩张 |
| Obsidian 兼容 | durable 知识优先 markdown/frontmatter/可 grep |

## Evidence

### 外部仓库取证

本轮使用公开 GitHub 只读克隆 + git log/release 文件核验：

```powershell
git clone --filter=blob:none --no-checkout --depth=300 https://github.com/obra/superpowers.git C:\tmp\tp-superpowers-20260701
git clone --filter=blob:none --no-checkout --depth=300 https://github.com/garrytan/gstack.git C:\tmp\tp-gstack-20260701

git -C C:\tmp\tp-superpowers-20260701 rev-list --count --since="2026-06-01 00:00:00" --until="2026-07-01 23:59:59" HEAD
# 177

git -C C:\tmp\tp-gstack-20260701 rev-list --count --since="2026-06-01 00:00:00" --until="2026-07-01 23:59:59" HEAD
# 18
```

注意：`superpowers` 在 2026-06-16 左右有大量 author-date 较早、commit-date 集中进入主线的提交，因此按 `RELEASE-NOTES.md` 聚合版本比逐条 commit 更可靠。

### TP 当前架构对照

已核实本仓库已有同构能力：

| 能力 | TP 证据 | 结论 |
|---|---|---|
| Codex marketplace/local plugin manifest | `.agents/plugins/marketplace.json`、`plugins/tech-persistence/.codex-plugin/plugin.json` | superpowers 的 Codex marketplace manifest 不是新增借鉴点 |
| runtime scratch/work artifacts | `.agent-runs/`、`agent-loop` 的 `diff.patch` / `validation.json` / `handoff.json` | superpowers `.superpowers/sdd` 是同构形状，TP 已有 |
| usage-report / 命令使用率 | `scripts/usage-report.js`、`/review-learnings --usage` | gstack 5 月 "先计量命令面" 已被 TP 吸收 |
| design lens | [[2026-05-22-gstack-design-lens-double-track]]、`review.md` design lens | gstack design-review IP 已部分吸收 |
| demand-side recall telemetry | `scripts/lib/recall-usage.js`、`/review-learnings --recall` | gstack generic retro/delta 思路已有 TP 原生落点 |

## What Changed Upstream

### superpowers: v6.0.0 -> v6.1.0

| 日期 | 版本/commit | 主题 | 与 TP 相关度 |
|---|---|---|---|
| 2026-06-30 | v6.1.0 `f268f7c` | 降低 per-session bootstrap token cost；Codex marketplace install；移除 Gemini；Codex 不再 ship SessionStart hook | 高 |
| 2026-06-18 | v6.0.3 `896224c` | SDD scratch 从 `.git/sdd` 移到工作区 `.superpowers/sdd`，self-ignoring per-worktree | 中，TP 已有 `.agent-runs/` |
| 2026-06-16 | v6.0.2 `b62616f` | 不再发布 evals submodule | 低 |
| 2026-06-16 | v6.0.1 `a21956e` | Codex packaged plugin version fallback；Codex sync 排除 repo metadata | 中 |
| 2026-06-16 | v6.0.0 `c5a9651` | SDD review 重写：单 reviewer、file handoff、pre-flight plan read、显式 model、read-only reviewer、progress ledger、Global Constraints、per-task Interfaces | 高 |

关键抽象不是 "superpowers 更大"，而是这些机制：

1. **every-session payload 要压缩**：bootstrap/skill skeleton 是高频成本面。
2. **review artifact 通过文件传递**：task brief、diff、review package、progress ledger 不塞长上下文。
3. **controller 不能 pre-judge reviewer**：reviewer 要读 diff、只读、怀疑 implementer rationale。
4. **计划要携带 Global Constraints + per-task Interfaces**：下游 task 不该重新推导全局约束/邻接契约。
5. **Codex hook 要谨慎**：如果 runtime 已能原生触发 skills，额外 bootstrap hook 可能制造重复/恶化 UX。

### gstack: v1.55.1.0 -> v1.58.5.0

| 日期 | 版本/commit | 主题 | 与 TP 相关度 |
|---|---|---|---|
| 2026-06-25 | v1.58.5.0 `11de390` | first-run activation scaffold + root `gstack` router front door | 中 |
| 2026-06-21 | v1.58.4.0 `9fd03fa` | community bug wave；redaction 新增 secret shapes；PTY plan-mode smoke gate | 高 |
| 2026-06-18 | v1.58.3.0 `a861c00` | browser stealth Layer C | 低，scope 外 |
| 2026-06-14 | v1.58.1.0 `c7ae632` | hermetic local E2E；Conductor prose AskUserQuestion fallback；gstack-detach | 高 |
| 2026-06-12 | v1.58.0.0 `14fc086` | diagram + multi-format document engine | 低，scope 外 |
| 2026-06-10 | v1.57.10.0 `a5833c4` | Codex review default-on across review/ship/plan/docs | 中，TP 已有不同 review 策略 |
| 2026-06-09 | v1.57.9.0 `8241949` | source-clean gbrain render, `--out-dir`, machine-wide refresh | 中 |
| 2026-06-09 | v1.57.8.0 `421460f` | browse js/eval `--out` render-to-file | 低，browser scope 外 |
| 2026-06-08 | v1.57.7.0 `1626d48` | review report always declares unresolved decisions | 高 |
| 2026-06-08 | v1.57.6.0 `9cc41b7` | security guards fail-open fixes；OpenAI key/redaction improvements | 高 |
| 2026-06-08 | v1.57.5.0 `45cc95d` | cross-session decision memory + gbrain call graph | 中 |
| 2026-06-07 | v1.57.2.0 `4dfdb7c` | AskUserQuestion prose fallback when tool fails | 中 |
| 2026-06-07 | v1.57.0.0 `e722c5b` | carve-guard system + carved skills | 高 |
| 2026-06-04 | v1.56.0.0 `cab774c` | token-reduction Phase B + AUQ safety net | 高 |
| 2026-06-02 | v1.55.1.0 `c43c850` | telemetry consent accuracy + slug cache sanitization | 中 |

gstack 的方向仍是 "solo founder shipping like a team"。TP 不应追 browser/deploy/ship 扩张，但可以借几种机制形状。

## Decision

### P1 可直接借鉴

#### 1. Codex SessionStart resume 去重 / 降噪

**来源**：superpowers 先修 "Codex bootstrap re-firing on resume"，v6.1.0 又移除 Codex SessionStart hook。

**TP 现状**：`plugins/tech-persistence/hooks/hooks.json` 的 `SessionStart` matcher 是：

```json
"matcher": "startup|resume|clear|compact"
```

本轮会话已实际看到 `<learned-context>` 与 caveman 注入重复出现。不是功能错，但会造成 context 成本和认知噪音。

**建议**：先只处理 `inject-context.js` / `caveman-activate.js` 的重复注入，不移除 observation/Stop hook。

候选实现：

| 方案 | 动作 | 取舍 |
|---|---|---|
| A | `SessionStart` 去掉 `resume` | 最轻；可能失去 resume 时补最新 memory 的机会 |
| B | 保留 `resume`，hook 输出带 session-level dedupe marker | 更准；需知道 hook payload 里是否有 stable session id |
| C | `inject-context` 在 resume 时只输出短 cost/changed-context summary | 折中；代码稍多 |

**推荐**：A 或 C，先 measure context 重复再决定。不要直接照搬 "移除 Codex hooks"，TP 的 hooks 还承载 observation/memory/recall，不是纯 bootstrap。

#### 2. Always-loaded token budget + carved skill guard

**来源**：
- superpowers v6.1.0 压缩 every-session `using-superpowers` bootstrap。
- gstack v1.56.0/v1.57.0 把重 skill 切成 always-loaded skeleton + on-demand sections，并加 carve guard。

**TP 现状**：`$sprint` / `$review` 等 command-derived skills 是完整命令全文包装。优点是 Obsidian/grep/双 runtime 简单；缺点是 always-loaded 或技能选择器看到的文档越来越重。

**建议**：先建 measurement，不急着 carve。

最小落点：

```text
scripts/skill-size-budget.js
  - 扫 user-level/commands/*.md
  - 扫 .codex/skills/*/SKILL.md
  - 输出 top N by bytes/lines
  - 标记 always-loaded / command-derived / manually-authored
```

再决定是否把 `review` / `sprint` 的低频深段落移入 `references/` 或 `sections/`。

**为什么不是直接拆**：TP 的双 runtime propagate 是核心资产；直接拆 section 会增加 projection 复杂度。先量化，符合 [[ADR-022]] measure-before-enforce。

#### 3. Secret/redaction pattern 扩展

**来源**：gstack v1.58.4/v1.57.6 扩充 redaction：GitLab、HuggingFace、npm、DigitalOcean、Bearer、GCP service account 等。

**TP 现状**：
- `scripts/secret-scan-on-demand.js` 覆盖 private key / AWS / OpenAI / generic api/token assignment。
- `scripts/lib/memory-v5.js` 有 generic `Bearer` 与 base64 redaction。
- `scripts/lib/redaction.js` 的 observation redaction 主要是 private tags，不是全 secret pattern。

**建议**：扩展 on-demand scanner + durable memory redaction，不直接加 pre-commit 强门。

候选新增 pattern：

| Pattern | 建议落点 |
|---|---|
| GitLab `glpat-...` | `secret-scan-on-demand.js` + tests |
| HuggingFace `hf_...` | `secret-scan-on-demand.js` + tests |
| npm `npm_...` | `secret-scan-on-demand.js` + tests |
| DigitalOcean `dop_v1_...` | `secret-scan-on-demand.js` + tests |
| GCP service-account JSON private key/client_email combo | scanner + memory redaction |
| Bearer entropy-gated token | scanner; memory-v5 已有 broad pattern，测试补齐 |

**边界**：scanner 继续 on-demand。只有真实命中或低 FP 充分 dogfood 后，才评估 `pre-commit-check` enforcement。

#### 4. Review/plan artifact 必须声明 unresolved decisions

**来源**：gstack v1.57.7 "GSTACK REVIEW REPORT always declares unresolved decisions"。

**TP 现状**：`/review` 有 P0/P1/P2 findings、doc↔code walkthrough、review status，但不强制输出 "未决决策"。

**建议**：轻量加入 review/sprint 文档模板：

```markdown
### Unresolved decisions

| Decision | Owner | Blocking? | Next step |
|---|---|---:|---|
| none | - | no | - |
```

**价值**：防止 `status: completed` 掩盖 "语义上还没定"。这与 TP 的 documented-claim-vs-code-reality-drift 高发问题一致。

### P2 借鉴但先 backlog

#### 5. Hermetic eval/agent child env canary

**来源**：gstack v1.58.1 hermetic local E2E。

**TP 现状**：`agent-loop` 会 spawn provider，且已经有 `.agent-runs` artifact；但没有 "operator ~/.claude / MCP / env 污染 canary"。

**建议**：先加测试级 canary，不改生产 provider launch。

落点：

```text
scripts/test-agent-orchestrator-hermetic.js
  - 构造 poisoned env / fake config sentinel
  - 验证 child prompt/artifact 不读取 operator-only config
```

如果后续发现真实污染，再把 env allowlist 下沉到 provider launch。

#### 6. Goal Loop 独立 sub-judge 复用 superpowers/gstack review 形状

**来源**：superpowers SDD 的 "controller 不能 pre-judge reviewer" 与 TP 已有 [[2026-06-17-native-goal-sibling-eval]]。

**TP 现状**：Goal Loop 完成判定仍是主模型 advisory 自评。已有结论：唯一真借鉴是 judge != worker，但因 `--goal` 使用证据不足，暂不下沉。

**建议**：保持 backlog，不因本轮 superpowers SDD 再次出现就提前做。触发条件：`/sprint --goal --auto` 出现高频真实使用或一次 goal-met proxy gaming 事故。

### 不建议借鉴

| 上游变化 | 拒绝/暂不借原因 |
|---|---|
| gstack browser stealth / browse render / QA browser stack | outbound shipping/browser 产品线，scope 外 |
| gstack deploy / ship / canary / land-and-deploy | TP 不做 deployment toolkit；跟随会破轻量与定位 |
| gstack diagram + DOCX/PDF engine | 文档出版工具，非 TP 自进化核心 |
| gstack first-run router 全套 | TP 已有技能路由和 usage-report；可借 "root command pure router" 思想，但不新增命令 |
| gstack cross-session decision memory 全套 | TP 已有 Memory v5 / rules / solutions / Obsidian；最多借 `supersede/redact` 事件形状 |
| superpowers 新 harness 扩张（Kimi/Pi/Antigravity） | 当前无用户需求；新增分发矩阵是永久维护表面 |
| superpowers Codex marketplace manifest | TP 已有 `.agents/plugins/marketplace.json` 和 `.codex-plugin/plugin.json` |
| superpowers `.superpowers/sdd` scratch workspace | TP 已有 `.agent-runs/`，同构已吸收 |

## Recommended Order

| Rank | 候选 | ROI | 维护表面 | 建议 |
|---:|---|---|---|---|
| 1 | Codex SessionStart resume 去重/降噪 | 高：立即降 context 噪音 | 低 | 下一小任务可做 |
| 2 | skill-size-budget / carve measurement | 高：控制长期膨胀 | 低-中 | 先报告，不直接拆 |
| 3 | secret pattern 扩展 | 高：安全纵深 | 低 | 可直接做 L2 |
| 4 | unresolved decisions 表 | 中高：防 completed 撒谎 | 低 | 文档协议改动 |
| 5 | hermetic eval canary | 中：主要护 agent-loop | 中 | backlog，等 agent-loop 频率上来 |
| 6 | Goal Loop sub-judge | 中：理论正确，使用低 | 中 | 保持 deferred |

## Implementation Status

2026-07-01 已先落实 Rank 1 + Rank 2 + Rank 3：

| Item | Status | Evidence |
|---|---|---|
| Codex SessionStart resume 去重/降噪 | done | `scripts/lib/hook-registry.js` 将 plugin runtime matcher 收敛为 `startup|clear|compact`；`plugins/tech-persistence/hooks/hooks.json` 由 build 生成同步 |
| skill-size-budget / carve measurement | done | 新增只读脚本 `scripts/skill-size-budget.js`；先报告 heavy skills，不拆文档结构 |
| Secret/redaction pattern 扩展 | done | `scripts/secret-scan-on-demand.js` 增 GitLab/HF/npm/DigitalOcean/Bearer/GCP service-account；`scripts/lib/redaction.js` 成为 durable redaction 共享入口，`memory-v5` 复用 |

验证：

```bash
node scripts/test-hook-entries.js
node scripts/test-skill-size-budget.js
node scripts/test-secret-scan-on-demand.js
node scripts/test-redaction.js
node scripts/test-memory-search.js
node scripts/secret-scan-on-demand.js --paths scripts docs user-level plugins .codex
node scripts/validate-codex-plugin.js
node scripts/pre-commit-check.js
```
## Follow-up Backlog

1. **SessionStart 去重 spike**：测当前 `resume` 下 `inject-context` / `caveman-activate` 是否重复注入同内容，选 A/C 方案。
2. **skill size report**：新增只读脚本，输出 top heavy skills，不改文档结构。
3. **review unresolved decisions**：改 `user-level/commands/review.md`，propagate + build + validate。
4. **hermetic canary**：先落测试，不改 provider launch。

## Lessons

- "外部项目最近很活跃"不等于要跟随功能面。gstack 的 6 月核心仍是 outbound shipping 扩张；TP 的可借鉴项应筛到可迁移的机制形状。
- 对 TP 最有价值的不是新命令，而是减少已有系统长期漂移的微机制：token budget、未决决策显式化、redaction 覆盖、hook 去重。
- superpowers/gstack 都在压缩 always-loaded 内容，反向提醒 TP：command-derived skill 全文包装虽然简单，但需要预算可见性，否则会在半年后变成隐性税。
- 本轮多个候选被核验为 TP 已有同构能力（marketplace、`.agent-runs`、usage-report、design lens）。sibling-eval 必须先查自家代码，否则会重复造轮子。
