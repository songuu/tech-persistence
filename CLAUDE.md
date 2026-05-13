# 个人开发偏好 & 自进化工程系统

## 关于我
- 沟通风格：直接、带代码示例、中文优先
- 开发理念：TDD、YAGNI、DRY

## 编码偏好
- 错误处理：显式 try-catch，携带有意义的错误消息和上下文
- 注释：解释 WHY 而非 WHAT，代码应自文档化
- 命名：变量名要有业务语义，不用缩写
- 提交信息用 Conventional Commits 格式

---

## 工程方法论：Plan → Work → Review → Compound

本系统融合三种方法论：
- **gstack** 的角色分工（同一个问题用不同角色的视角审视）
- **Compound Engineering** 的复利循环（每次工作让下次更容易）
- **本能系统** 的自动记忆（经验自动积累、进化、注入）

### 核心流程（80% 规划审查 / 20% 执行）

```
/think  → 用 CEO 视角审视需求，定义"做什么"和"不做什么"
   ↓
/plan   → 用工程师视角拆解实现方案，输出结构化计划
   ↓
/work   → 按计划逐步实现，每步有验证
   ↓
/review → 多角度并行审查（安全/性能/架构/代码质量）
   ↓
/compound → 提取本次所有经验，写入本能系统
   ↓
(回到 /think 开始下一个循环)
```

### 角色模式（来自 gstack）

在不同阶段，Claude 应切换思维模式：

| 命令 | 角色 | 关注点 | 不关注 |
|------|------|--------|--------|
| `/think` | CEO/产品 | 用户价值、范围、取舍 | 实现细节 |
| `/plan` | 架构师 | 技术方案、风险、依赖 | 产品决策 |
| `/work` | 工程师 | 代码质量、测试、可维护性 | 过度设计 |
| `/review` | 审查团队 | 安全/性能/架构/正确性 | 功能需求 |
| `/compound` | 知识管理者 | 经验提取、模式识别 | 当前实现 |

### 使用节奏

**小任务**（< 30 分钟）：
直接开发 → 结束时 `/learn` 或 `/compound`

**中等任务**（30 分钟 - 2 小时）：
`/plan` → 开发 → `/review` → `/compound`

**大任务**（> 2 小时）：
`/think` → `/plan` → `/work` → `/review` → `/compound`

**全流程冲刺**：
`/sprint <需求描述>` → 自动串联 think→plan→work→review→compound

---

## 自学习规则

### 自动触发（不可跳过）
1. **解决了非平凡 bug**（3+ 轮交互）→ 执行 `/debug-journal`
2. **用户纠正了 Claude** → 立即记录为本能
3. **做出了架构/技术决策** → 记录到 `rules/architecture.md`
4. **会话即将结束** → 执行 `/compound`（不是 /learn，/compound 更全面）

### 建议触发
5. 发现非直觉行为 → 提示：`💡 发现可学习模式，要 /compound 吗？`
6. 性能相关发现 → 同上
7. 重复工具序列出现 2+ 次 → 同上

### 学习优先级
**永远先 /compound 再 /compact。** Compound 步骤既提取经验又记录解决方案，信息量大于单纯 /learn。

提示格式：
```
🧠 会话收尾：
  ✅ 已 compound：N 条经验 + M 个本能更新
⚠️ 建议 /compact — [原因]
```

---

## 文档同步规则（CRITICAL — 本项目特有）

**本项目是一个自进化工程系统本身，任何功能层面的变更必须同步更新对应的项目文档。**

### 强制规则

1. **每次功能改造必须在 `docs/plans/` 生成或更新文档**
   - 文件名格式：`YYYY-MM-DD-<feature-slug>.md`
   - 参考模板：`docs/plans/TEMPLATE.md`
   - 即使是小改动，也应至少在文档的「变更日志」章节记录

2. **修改功能 = 修改文档**
   当修改了以下任何内容时，**MUST** 同步更新对应文档：
   - `user-commands/*.md`（工作流命令）→ 更新 README.md 的命令速查表和产出文件流图
   - `scripts/*.js`（Hook 脚本）→ 更新 README.md 的知识层说明
   - `install.sh` / `install.ps1` / `upgrade-v3.ps1` → 更新 README.md 的快速安装章节
   - `.claude/rules/*.md` 或模板 → 更新 README.md 的目录结构
   - 新增命令或删除命令 → 更新 README.md 的命令速查表和版本演进

3. **README.md 是用户入口，必须保持准确**
   - 产出文件路径必须与实际命令产出一致
   - 命令速查表必须反映当前所有命令
   - 目录结构必须匹配实际项目结构
   - 版本演进表在重大改造时追加新行

4. **文档滞后 = 失败**
   如果代码改了但文档没改，视为未完成。提交前必须确认文档已同步。

### 触发流程

```text
识别到功能层面的修改
  ↓
创建或更新 docs/plans/YYYY-MM-DD-<slug>.md
  ↓
检查 README.md 是否需要更新（命令表/目录结构/图表）
  ↓
检查 CLAUDE.md 是否需要更新（规则/方法论）
  ↓
检查其他相关文档（CHEATSHEET.md / QUICKREF.md / MIGRATION.md）
  ↓
一起提交
```

---

## 上下文管理规则

满足以下任一条件时，主动提示用户执行 `/compact`：
1. **任务边界**：一个完整功能任务刚完成
2. **高消耗轮次累积**：5+ 个包含 3 次以上工具调用的轮次
3. **退化信号**：开始忘记约定、重复提问、工具参数出错
4. **探索型会话结束**：大量文件浏览、上下文分析结束

---

## 自学习系统说明

- 4 Hook 自动观察（SessionStart/PreToolUse/PostToolUse/Stop）
- 本能系统：观察 → 本能(0.3-0.9) → 进化 → 永久知识
- `/instinct-status` 查看本能 | `/evolve` 进化 | `/compound` 复利循环

## 技术沉淀（通用经验）
<!-- 由 /compound 和自学习系统自动追加 -->

### 调试经验

### 性能经验

### 架构经验

### 工具链经验

### 解决方案索引
<!-- 由 /compound 写入，格式: [日期] [标签] 问题→方案 的一行摘要 + 详情链接 -->
- [2026-04-27] [architecture/agent-loop/v6] 外部 orchestrator 统一调 `claude -p` 和 `codex exec`，用冻结 spec + handoff + review loop 取代命令内互相模拟 → `docs/solutions/2026-04-27-agent-orchestrator-v6.md`
- [2026-05-09] [audit/agent-loop/caveman/auto-mode] 修复 9 个 agent-loop / caveman 漏洞（CLI 分派缺、state 向后兼容、静默吞错、多副本漂移），新增全局 `--auto` 协议（单 rule + 三档决策矩阵 + orchestrator 双层 freeze），propagation 脚本机械同步 4 副本 × N 命令 → `docs/solutions/2026-05-09-agent-loop-caveman-audit.md`
- [2026-05-11] [agent-loop/provider-errors] `claude -p` 失败时错误内容只在 stdout（envelope `{is_error,api_error_status,result}`），原 `runProcess` 只指向空 stderr 误导用户；新增 envelope 提取 + `doctor --probe` 真打一次 CLI → `docs/plans/2026-05-09-agent-loop-pipeline.md` (changelog 2026-05-11)
- [2026-05-11] [analysis/architecture-fusion/gbrain] 12 个 gbrain 架构思想融入可行性研究：身份明示为 developer-toolchain self-evolution sibling（非 gstack/gbrain 替代）；ROI 按 5 年杠杆 / 维护表面 重排（C1→C3→C5-capture，C12 掉出 top-3 因痛是想象的）；推荐 **Trajectory A memory-as-graph**（C1 typed-link → C5-capture → C6 跨 session 自动升级）；显式拒绝 3 个（C8 thin/fat 反向哲学 / C10 always-on signal-detector parity 失衡 / C11 AGENTS.md 时机）；新增 ADR-011 identity-question-first 原则 → `docs/plans/2026-05-11-gbrain-gstack-analysis.md`
- [2026-05-11] [sprint/performance/layer1] `/sprint` `$sprint` 执行层加速 4 件事：T1 risk-aware reviewer dispatch matrix（L0/L1→1视角，L4→全套）+ T2 reviewer 模型分层（security 锁 Sonnet，quality/test 用 Haiku 4.5）+ T3 SessionStart 注入相关性（按 active sprint tags 重排 MEMORY.md，向后兼容）+ T4 修订 Phase 间预热（sprint.md 协议 + 5 phase 钩子，纠正"改 pipeline.js"的 plan 错误）；smoke 12 用例全过；新增 ADR-012 "Plan 阶段必须勘察被改文件" → `docs/solutions/2026-05-11-sprint-speed-layer1.md`
- [2026-05-11] [claude/hooks/installer] 已有 Claude Code settings 缺 hooks 会让学习层静默失效；新增结构化 hook merger + Claude 安装态 validator，项目态和用户态均复验通过 → `docs/solutions/2026-05-11-claude-settings-hook-merge.md`
- [2026-05-12] [infrastructure/pre-commit/enforcement] propagate 纪律 + ADR-012 plan 勘察从文档协议下沉为 pre-commit hook 拒绝（mechanism over discipline）：`scripts/pre-commit-check.js` 复用 propagate / build transform 函数做 sha256 比对，plan lint 用 filename date 做 grandfather（独立于 frontmatter）；3 层 fail-open 防御 + MISSING_TRANSFORMERS 专用诊断；reviewer 抓出 7 P0 全修（含 6+ 无-FM 旧 plan dogfood blocker）；smoke 7 场景全过；新增 ADR-013 "dogfood 必须枚举边界产物" → `docs/solutions/2026-05-12-pre-commit-defense.md`
- [2026-05-12] [hooks/windows/shell-mismatch/regression] Windows 上 Claude Code hook command 用 cmd 风格 `2>nul || exit /b 0` 在实际 bash 执行环境中创建 cwd 下名为 `nul` 的空文件（每次 hook 触发都创建/覆盖）；**已踩 2 次** — 2026-04-09 修过 `install.ps1`，重构引入 `merge-claude-settings-hooks.js` 后回归；本次修 4 个污染入口（生成器 / 模板 / 当前态 / 旧 doc errata），永远改用 POSIX `2>/dev/null || true`；建议下道防线：CI 断言任何安装产物的 hook command 不含 `2>nul` / `exit /b` → `docs/solutions/2026-05-12-nul-hook-shell-mismatch.md`
- [2026-05-12] [audit/agent-loop/followup-closure] 对 `/agent-loop` 全量 follow-up 闭环度审计：15 项核验 → 4 closed / 3 partial / 6 still-open / 2 wont-fix-now；最大缺口（与 nul fix 同款风险模型）：(1) `scripts/agent-orchestrator*` 副本同步未纳入 pre-commit-check（commands/rules 已覆盖，scripts/ 裸奔，第二次回归路径） + (2) `loadRun` 入口仍无 defensive default（ADR-008 明示要做，本能写在 doc 但代码未落地） + (3) pipeline plan `status: implemented` 实为 broken example（review/compound 占位行未填，sprint 模板误导后人）；新建元本能「文档声称 vs 代码现实偏差」识别此类 doc-says-fixed-but-not-really → `docs/plans/2026-05-12-agent-loop-followup-audit.md`
- [2026-05-12] [agent-loop/fixes-landed/topN] 后续 sprint 落地 audit Top-3 P0 修复 + reviewer 11 个增强：(1) F1+F2 止血 pipeline plan `status: partial` + errata 块；(2) F7-4 `loadRun` 加 `applyStateDefaults()` defensive default + 13 self-test 覆盖（含 null/undefined/array/string throw + mutate-in-place 引用保持 + files=={} strict）；(3) F8/F9 `pre-commit-check.js` 新增 `checkOrchestratorSync()` + sha256 **LF-normalize** 比对（CORR-1 跨平台关键修） + 嵌套子目录检测（CORR-2 非递归 build 兜底） + `--diff-filter=ACMRD`（CORR-3 捕获源删除） + 措辞通用化；smoke 从一次性 bash 升级为 `scripts/smoke-pre-commit.js` 5 个可重放 scenario (S8-S12)（synced/tampered/CRLF-source/orphan/nested）。两轮 reviewer 反馈处理：correctness(5) + testing(7) = 11 fixed / 1 deferred (CORR-4 files 数组 silent drop 已 self-test 明示 desired)。新建 [[cross-platform-sha-needs-lf-normalize]] 本能，3 个本能升 confidence（state-file-backward-compat 0.75→0.9 closed、multi-copy-doc-drift 0.78→0.9 部分 closed、documented-claim-vs-code-reality-drift 0.7→0.85 反身性验证）。F7-5/F7-8 留作 P1 follow-up → `docs/solutions/2026-05-12-agent-loop-followup-fixes.md`
- [2026-05-13] [architecture/skill-evolution/stage-abc] /skill-* 4 命令零调用根因 = 空架构（spec 完整无代码 — `skill-signals/` 永远是空目录，无任何代码写入）；3 层叠加修复：Stage A `scripts/lib/skill-signals.js` Stop hook 派生 skill-signals/*.jsonl（复用 usage-aggregator 同秒同 skill dedup） + Stage B `/skill <action>` 5 子动作单入口（含 list / auto 一键闭环；旧 4 命令保留 alias） + Stage C `/compound` 步骤 9.5 自动健康摘要（healthy/observe/recommend 三档阈值可配）；数据局限明示「仅 Codex 端 tool:Skill」(Claude Code SlashCommand 不进 PreToolUse hook，结构性无法捕获)；5 self-test + 5 cross-platform smoke 全过 → `docs/plans/2026-05-13-skill-evolution-architecture.md`
- [2026-05-12] [sprint/sibling-evaluation/reframe] gstack 分析 sprint 暴露 sibling-evaluation 易产 "framework-building 偏见"（用户问研究问题 → sprint 输出 9 候选 + 4 抽象层 + ADR 候选）；4 reviewer 中 3 个独立给 reframe 建议（scope-guardian + product-lens + adversarial），coherence 给具体 P0；path-2 reframe：删 ADR-014（N=2 + 一个 degenerate 不够）+ 推迟 C1 destructive hook（ROI 分子捏造，`grep "rm -rf|DROP TABLE|force-push|accident" debugging-gotchas.md` 零真实事故）+ 推迟 C2 phase warmup lint（dogfood 失败 — 本 sprint 自己也无预热段；分母错 — 20+ 大多是 handoff/research）+ C7 plan completion verify 从 🔴 升 🟡 scope 到 `type:sprint+status:done+has-code-tasks`（呼应 [[documented-claim-vs-code-reality-drift]]）；新增 Task 7 21 命令使用率审计（4 个 0 提及 + 5 个 1 提及 = 43% 证据不足，已建未用清单）+ Task 8 positioning 决策（gstack outbound shipping vs 本项目 inbound self-evolution，正交不竞争 → 不跟随）；observe.js 252 entries 全来自本 session（跨 session 聚合 0 = 结构性缺口）；6 条经验 L1-L6（framework-building 偏见 / ROI 分子需 grep 证据 / enforcement dogfood inline / sibling 必含 positioning / observation 跨 session 缺口 / reviewer 收敛是 reframe 信号）；新候选本能 [[sibling-evaluation-defaults-to-framework-building]] N=2 confidence 0.7 → `docs/solutions/2026-05-12-gstack-analysis-reframe-lessons.md`
- [2026-05-13] [enforcement/plan-completion-verify/c7] 吸收 gstack `/ship` 「extracts actionable items from any associated plan file and verifies each is addressed in the diff」内核：`scripts/pre-commit-check.js` 新增 `checkPlanCompletion()`，对 `type:sprint + status:completed` plan 验证勾选 task 行内 inline-code 路径在 `git log --since=<filename-date>` ∪ `git diff --cached` 中至少 1 个命中；扩展名白名单（.js/.ts/.md/.sh/.ps1/.json/.jsonl/.yml/.yaml/.toml/.py/.rb/.css/.html）+ regex 拒空格（避免命令形式 `\`node scripts/foo.js\`` 误匹配，本次实施暴露的 FP）+ 跳过 `~/` 与绝对路径（仓库外路径不参与）+ endsWith 双向 fuzzy match；smoke S13a-f 6 场景 + 全 12 个现有 `status:completed` sprint dogfood 0 误拒；2 次 false-positive 修复（fixture 关键假设验证段太薄导致跨 checker stderr 污染；命令形式 inline-code 误匹配）→ `docs/plans/2026-05-13-plan-completion-verify.md`
