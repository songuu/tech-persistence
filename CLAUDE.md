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

> 老条目（> 5 条）已归档至 `docs/archives/CLAUDE-solutions-index-*.md`

<!-- 由 /compound 写入，格式: [日期] [标签] 问题→方案 的一行摘要 + 详情链接 -->
- [2026-05-13] [architecture/skill-evolution/stage-abc] /skill-* 4 命令零调用根因 = 空架构（spec 完整无代码 — `skill-signals/` 永远是空目录，无任何代码写入）；3 层叠加修复：Stage A `scripts/lib/skill-signals.js` Stop hook 派生 skill-signals/*.jsonl（复用 usage-aggregator 同秒同 skill dedup） + Stage B `/skill <action>` 5 子动作单入口（含 list / auto 一键闭环；旧 4 命令保留 alias） + Stage C `/compound` 步骤 9.5 自动健康摘要（healthy/observe/recommend 三档阈值可配）；数据局限明示「仅 Codex 端 tool:Skill」(Claude Code SlashCommand 不进 PreToolUse hook，结构性无法捕获)；5 self-test + 5 cross-platform smoke 全过 → `docs/plans/2026-05-13-skill-evolution-architecture.md`
- [2026-05-14] [audit/plugin-migration/cascade-cleanup] 两天审计 sprint 处理 Claude Code 2.x plugin 化遗留 6 项风险：R1 CRITICAL hook 双触发（commit 89531f4 message 声称 "removed hooks field" 但 `diff settings.json bak-2026-05-13` 输出空 = backup 创建了但**原文件从未改** = [[documented-claim-vs-code-reality-drift]] N=3 复现，confidence 0.85→0.92）+ R2/R3 install.sh/.ps1 deprecation banner + 旧 plan errata 防 cmd 语法误用为 hook + R4/R5 22 commands + 5 个 TP 重复 skill 移出 `~/.claude/` 子树到 `~/.claude-backups/2026-05-14-deprecated/`（**Rename in-place 失败**：Claude Code skill scanner 把 `<name>.deprecated-2026-05-14` 当作合法 skill name 仍 listed → 新本能 [[claude-skills-name-suffix-regex-permissive]]，规则"deprecation 必须物理移出子树"）+ R6 install.sh/.ps1 `safe_copy` 加 retention=3（`INSTALL_BAK_RETENTION` env override）+ smoke 暴露 [[bash-pipefail-vs-ls-no-match]] N=1（`set -euo pipefail` + `ls $glob 2>/dev/null` 无匹配 exit=2 杀函数，`|| true` 兜底）+ R9 `install.ps1` 加 UTF-8 BOM（已踩 2 次 + 本次预防性发现 = N=3，[[ps1-needs-utf8-bom]] 首次落入 instinct 文件——本本能自身是上一本能受害者：wikilinks 引用 weeks 但文件不存在）；提议 R10 `checkPS1Bom` + R12 `checkBackupMatchesIntendedChange` pre-commit checker 下一 sprint 实施 → `docs/solutions/2026-05-14-plugin-migration-cascade-cleanup.md`
- [2026-05-14] [memory-search/claude-md-trim/bounded-context] CLAUDE.md 索引段每月线性增长 ~2.7k chars，1 年崩。复用 `agentmemory-memory-integration` 已建的 `memory-search.js` + `UserPromptSubmit` hook 基础设施，扩 `collectSolutionFiles()` 让 `docs/solutions/*.md` 进检索池（scoreSolution keyword 权重 2.0，fallback 处理 1/16 无 frontmatter 老 solution）+ `scripts/archive-claude-solutions-index.js` 把 CLAUDE.md 索引段 bounded 到最近 5 条（idempotent, sentinel-strict, 5 边界场景 dogfood）+ /compound step 2.5 协议（LLM 级，非 enforcement）。Phase 4 review 修 C2 mergeArchiveContent fallback 路径 archived_count 不同步 + 加 15 self-test（含 U7 C2 负样本回归保护）。新本能 [[linear-growing-always-on-must-be-bounded]] + [[reuse-existing-infra-before-building-new]]。指标：CLAUDE.md 11907→7005 chars (-41%)，always-on 注入 -1.2k tokens/session → `docs/solutions/2026-05-14-claude-md-index-trim-via-prompt-recall.md`
- [2026-05-14] [analysis/plan-revision/self-codebase-drift] agentmemory 接入 plan v0.2 修订 sprint 暴露 [[documented-claim-vs-code-reality-drift]] **镜像**——「自家文档（plan）声称 vs 自家代码现实」漂移：原 plan 把 `selectMemoryIndexEntries` 当"非 query-aware search"，实际 2026-05-11 sprint speed layer1 已加 `prioritizeTopics`（sprint-tag 重排）；漂移源 = 起草者凭 weeks 前记忆而非凭 grep。3 ADR 联合应用（ADR-011 身份界定 + ADR-012 关键假设验证 + ADR-013 §B dogfood 边界）补 §0「项目身份界定 + 4 条不可妥协原则 + agentmemory 定位表」/ §0.5「关键假设验证（4 已勘察 + 5 待验证）」/ §15 changelog + 修正 §2.3/§2.4/§6.3 与 sprint-tag 重排层的协同关系（prompt-recall 复用 `detectActiveSprintTags()` 信号 + 二次评分 + 与 SessionStart 注入去重 3 候选方案）；Phase 4 review 2 P0 一次直修（README "7 处" → "6 处" 数字虚 + 凭空 `injection-log.jsonl` → 3 候选方案）；新增本能 `feedback_grep_self_codebase_before_analysis.md`：写技术 plan / 分析外部方案前必须 `git log --since='3 months ago'` 近期变更，避免基于旧版认知评估新方案 → `docs/plans/2026-05-14-agentmemory-memory-integration.md`
- [2026-05-14] [sibling-evaluation/spec-kit/reviewer-loop-closure] spec-kit (98.8k stars SDD) 借鉴评估按 [[ADR-011]] 4 不可妥协原则筛 10 项 → 初判 1 借 9 拒；Phase 4 product-lens reviewer 发现漏判脊椎"契约边界要显式标注"（不是表面的 contracts/ 目录），AskUserQuestion 后用户选 B 扩 scope-2 同 sprint 实施 T6-T9 → 最终 **2 直接借鉴**（`[P]` 并行标记 + 契约接口条件性段）+ **1 思想吸收**（constitution gate 映射到现有 ADR/rules/pre-commit）+ **7 拒绝**（constitution.md 文件 / 多文件 artifact / feature 编号 / /implement / 30+ CLI / data-model.md / /clarify）。`[P]` 协议在本 sprint 内 dogfood **2 批同轮 3 Edit**（T1+T2+T3 / T6+T7+T8）证明 LLM 端可执行；plan.md §2.5 含 3 条判定（集合交集=∅ + 无未完成依赖 + 风险≤L2）+ 4 正反例 + agent-loop --pipeline 边界；work.md 含 4 步冲突检测算法 + 失败传播 + 4 禁止行为；TEMPLATE.md / plan.md §2.6 加契约接口段（4 类触发条件 OR 关系）。3 reviewer 并行评级：product-lens B / coherence ✅ / dogfood C→B(5 P0 修后)。新本能 [[sibling-evaluation-reviewer-loop-can-close-in-sprint]] + [[contract-boundary-explicit-annotation-before-multi-copy-change]]。指标：sprint scope 5→9 task / 12 文件 +1010 -23 / pre-commit 通过 3 轮 → `docs/solutions/2026-05-14-spec-kit-eval.md`
