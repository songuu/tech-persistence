---
type: archive
archived_from: CLAUDE.md
archived_section: "解决方案索引"
archived_at: "2026-05-14"
archived_count: 11
tags: [archive, solutions-index]
---

# CLAUDE.md 解决方案索引归档（2026-05-14）

本文件存放 2026-05-14 由 `scripts/archive-claude-solutions-index.js` 从 `CLAUDE.md` 归档出的 10 条旧索引条目。

完整 solution 文档仍在 `docs/solutions/`，本文件仅留索引行作历史回溯。

## 归档条目

- [2026-05-12] [hooks/windows/shell-mismatch/regression] Windows 上 Claude Code hook command 用 cmd 风格 `2>nul || exit /b 0` 在实际 bash 执行环境中创建 cwd 下名为 `nul` 的空文件（每次 hook 触发都创建/覆盖）；**已踩 2 次** — 2026-04-09 修过 `install.ps1`，重构引入 `merge-claude-settings-hooks.js` 后回归；本次修 4 个污染入口（生成器 / 模板 / 当前态 / 旧 doc errata），永远改用 POSIX `2>/dev/null || true`；建议下道防线：CI 断言任何安装产物的 hook command 不含 `2>nul` / `exit /b` → `docs/solutions/2026-05-12-nul-hook-shell-mismatch.md`
- [2026-05-12] [audit/agent-loop/followup-closure] 对 `/agent-loop` 全量 follow-up 闭环度审计：15 项核验 → 4 closed / 3 partial / 6 still-open / 2 wont-fix-now；最大缺口（与 nul fix 同款风险模型）：(1) `scripts/agent-orchestrator*` 副本同步未纳入 pre-commit-check（commands/rules 已覆盖，scripts/ 裸奔，第二次回归路径） + (2) `loadRun` 入口仍无 defensive default（ADR-008 明示要做，本能写在 doc 但代码未落地） + (3) pipeline plan `status: implemented` 实为 broken example（review/compound 占位行未填，sprint 模板误导后人）；新建元本能「文档声称 vs 代码现实偏差」识别此类 doc-says-fixed-but-not-really → `docs/plans/2026-05-12-agent-loop-followup-audit.md`
- [2026-05-12] [agent-loop/fixes-landed/topN] 后续 sprint 落地 audit Top-3 P0 修复 + reviewer 11 个增强：(1) F1+F2 止血 pipeline plan `status: partial` + errata 块；(2) F7-4 `loadRun` 加 `applyStateDefaults()` defensive default + 13 self-test 覆盖（含 null/undefined/array/string throw + mutate-in-place 引用保持 + files=={} strict）；(3) F8/F9 `pre-commit-check.js` 新增 `checkOrchestratorSync()` + sha256 **LF-normalize** 比对（CORR-1 跨平台关键修） + 嵌套子目录检测（CORR-2 非递归 build 兜底） + `--diff-filter=ACMRD`（CORR-3 捕获源删除） + 措辞通用化；smoke 从一次性 bash 升级为 `scripts/smoke-pre-commit.js` 5 个可重放 scenario (S8-S12)（synced/tampered/CRLF-source/orphan/nested）。两轮 reviewer 反馈处理：correctness(5) + testing(7) = 11 fixed / 1 deferred (CORR-4 files 数组 silent drop 已 self-test 明示 desired)。新建 [[cross-platform-sha-needs-lf-normalize]] 本能，3 个本能升 confidence（state-file-backward-compat 0.75→0.9 closed、multi-copy-doc-drift 0.78→0.9 部分 closed、documented-claim-vs-code-reality-drift 0.7→0.85 反身性验证）。F7-5/F7-8 留作 P1 follow-up → `docs/solutions/2026-05-12-agent-loop-followup-fixes.md`
- [2026-05-12] [sprint/sibling-evaluation/reframe] gstack 分析 sprint 暴露 sibling-evaluation 易产 "framework-building 偏见"（用户问研究问题 → sprint 输出 9 候选 + 4 抽象层 + ADR 候选）；4 reviewer 中 3 个独立给 reframe 建议（scope-guardian + product-lens + adversarial），coherence 给具体 P0；path-2 reframe：删 ADR-014（N=2 + 一个 degenerate 不够）+ 推迟 C1 destructive hook（ROI 分子捏造，`grep "rm -rf|DROP TABLE|force-push|accident" debugging-gotchas.md` 零真实事故）+ 推迟 C2 phase warmup lint（dogfood 失败 — 本 sprint 自己也无预热段；分母错 — 20+ 大多是 handoff/research）+ C7 plan completion verify 从 🔴 升 🟡 scope 到 `type:sprint+status:done+has-code-tasks`（呼应 [[documented-claim-vs-code-reality-drift]]）；新增 Task 7 21 命令使用率审计（4 个 0 提及 + 5 个 1 提及 = 43% 证据不足，已建未用清单）+ Task 8 positioning 决策（gstack outbound shipping vs 本项目 inbound self-evolution，正交不竞争 → 不跟随）；observe.js 252 entries 全来自本 session（跨 session 聚合 0 = 结构性缺口）；6 条经验 L1-L6（framework-building 偏见 / ROI 分子需 grep 证据 / enforcement dogfood inline / sibling 必含 positioning / observation 跨 session 缺口 / reviewer 收敛是 reframe 信号）；新候选本能 [[sibling-evaluation-defaults-to-framework-building]] N=2 confidence 0.7 → `docs/solutions/2026-05-12-gstack-analysis-reframe-lessons.md`
- [2026-05-11] [agent-loop/provider-errors] `claude -p` 失败时错误内容只在 stdout（envelope `{is_error,api_error_status,result}`），原 `runProcess` 只指向空 stderr 误导用户；新增 envelope 提取 + `doctor --probe` 真打一次 CLI → `docs/plans/2026-05-09-agent-loop-pipeline.md` (changelog 2026-05-11)
- [2026-05-11] [analysis/architecture-fusion/gbrain] 12 个 gbrain 架构思想融入可行性研究：身份明示为 developer-toolchain self-evolution sibling（非 gstack/gbrain 替代）；ROI 按 5 年杠杆 / 维护表面 重排（C1→C3→C5-capture，C12 掉出 top-3 因痛是想象的）；推荐 **Trajectory A memory-as-graph**（C1 typed-link → C5-capture → C6 跨 session 自动升级）；显式拒绝 3 个（C8 thin/fat 反向哲学 / C10 always-on signal-detector parity 失衡 / C11 AGENTS.md 时机）；新增 ADR-011 identity-question-first 原则 → `docs/plans/2026-05-11-gbrain-gstack-analysis.md`
- [2026-05-11] [sprint/performance/layer1] `/sprint` `$sprint` 执行层加速 4 件事：T1 risk-aware reviewer dispatch matrix（L0/L1→1视角，L4→全套）+ T2 reviewer 模型分层（security 锁 Sonnet，quality/test 用 Haiku 4.5）+ T3 SessionStart 注入相关性（按 active sprint tags 重排 MEMORY.md，向后兼容）+ T4 修订 Phase 间预热（sprint.md 协议 + 5 phase 钩子，纠正"改 pipeline.js"的 plan 错误）；smoke 12 用例全过；新增 ADR-012 "Plan 阶段必须勘察被改文件" → `docs/solutions/2026-05-11-sprint-speed-layer1.md`
- [2026-05-11] [claude/hooks/installer] 已有 Claude Code settings 缺 hooks 会让学习层静默失效；新增结构化 hook merger + Claude 安装态 validator，项目态和用户态均复验通过 → `docs/solutions/2026-05-11-claude-settings-hook-merge.md`
- [2026-05-09] [audit/agent-loop/caveman/auto-mode] 修复 9 个 agent-loop / caveman 漏洞（CLI 分派缺、state 向后兼容、静默吞错、多副本漂移），新增全局 `--auto` 协议（单 rule + 三档决策矩阵 + orchestrator 双层 freeze），propagation 脚本机械同步 4 副本 × N 命令 → `docs/solutions/2026-05-09-agent-loop-caveman-audit.md`
- [2026-04-27] [architecture/agent-loop/v6] 外部 orchestrator 统一调 `claude -p` 和 `codex exec`，用冻结 spec + handoff + review loop 取代命令内互相模拟 → `docs/solutions/2026-04-27-agent-orchestrator-v6.md`

- [2026-05-12] [infrastructure/pre-commit/enforcement] propagate 纪律 + ADR-012 plan 勘察从文档协议下沉为 pre-commit hook 拒绝（mechanism over discipline）：`scripts/pre-commit-check.js` 复用 propagate / build transform 函数做 sha256 比对，plan lint 用 filename date 做 grandfather（独立于 frontmatter）；3 层 fail-open 防御 + MISSING_TRANSFORMERS 专用诊断；reviewer 抓出 7 P0 全修（含 6+ 无-FM 旧 plan dogfood blocker）；smoke 7 场景全过；新增 ADR-013 "dogfood 必须枚举边界产物" → `docs/solutions/2026-05-12-pre-commit-defense.md`
