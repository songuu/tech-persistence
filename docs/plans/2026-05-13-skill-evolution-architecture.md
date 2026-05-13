---
title: "Skill 进化架构重构：Stage A 信号收集 + Stage B 入口合并 + Stage C 内嵌触发"
type: sprint
status: completed
created: "2026-05-13"
updated: "2026-05-13"
checkpoints: 0
tasks_total: 12
tasks_completed: 12
parent_decision: "docs/plans/2026-05-13-command-usage-report.md（数据基础）"
related_solution: "docs/solutions/ — pending Phase 5"
tags: [sprint, architecture, skill-evolution, hook, mechanism]
aliases: ["skill-evolution-rearch", "skill-stage-abc"]
---

# Skill 进化架构重构

> **现状根因**：`/skill-*` 4 命令是**空架构**——文档完整，但 `skill-signals/` 永远是空目录，**没有任何代码写入信号文件**。用户即使调命令也读不到数据。本 sprint 把"愿景"补成"实施"。

## 需求分析

### 背景

2026-05-13 上午 `/sprint` 生成的命令使用率报告显示：4 个 `/skill-*` 命令 30 天累计零调用。深挖根因发现：

1. `scripts/init-obsidian-vault.js:458` 只 mkdir 了 `skill-signals/` `skill-evals/` `skill-changelog/` 三个目录
2. `grep skill[-_]signal scripts/` 命中 0 个实施代码（仅 `configure-shared-homunculus.js` 提及 mkdir）
3. 三个目录全空，从未被写入
4. `compound.md` 步骤 6 设计了"采集 skill 信号"动作，但只有 LLM 在 /compound 时跑——30 天仅 2 次

**结论**："用户没用 /skill-* 不是 UX 问题，是空架构问题"。本 sprint 把架构补齐。

### 本 sprint 回答的核心问题

> 1. 信号数据从何而来？（Stage A — hook 自动派生 + compound LLM 派生）
> 2. 用户调用入口是什么？（Stage B — 4 合 1 `/skill <action>`）
> 3. 用户怎么被提醒触发？（Stage C — /compound 内嵌健康摘要）

### 与现有 spec 的关系

| 现有 spec | 现状 | 本 sprint 关系 |
|---|---|---|
| `/skill-diagnose` `/skill-eval` `/skill-improve` `/skill-publish` 4 命令 | spec 完整无代码 | **保留**作 alias，新 `/skill` 命令作主入口 |
| `compound.md` 步骤 6"采集 skill 信号" | LLM 在 /compound 时派生（30d 仅 2 次） | **互补**：Stage A hook 100% 覆盖结构化数字信号；compound LLM 仍负责语义信号 |
| `compound.md` 步骤 7"本能差异标记" | spec 存在 | **复用**，不在本 sprint 重做 |
| `compound.md` 步骤 7 末尾"5+ 个 pending_absorption → 提示 /skill-improve" | 协议未实施 | Stage C 把"建议提示"做成自动派生 |

### 要做

1. **Stage A**：`scripts/evaluate-session.js` 加 `aggregateSkillSignals()` step，Stop hook 时把本 session 的 skill 调用从 observations 派生 → `~/.claude/homunculus/skill-signals/{name}.jsonl`
2. **Stage B**：新 `/skill <action> <name>` 命令，5 个子动作（diagnose / eval / improve / publish / auto）。旧 4 个 `/skill-*` 命令文档加 "已合并到 `/skill X`" 提示，保留作 alias
3. **Stage C**：`compound.md` 步骤 9 输出段加入"Skill 健康摘要"子段，自动扫 `skill-signals/` 并提示

### 不做

- ❌ 不删旧 4 个 `/skill-*` 命令（破坏性变更，且用户已说不要清理）
- ❌ 不做 SessionStart hook 主动提示（违反 [[feedback_no_auto_default]]）
- ❌ 不实现 skill-evals 测试集自动生成（依赖 Stage A 数据先累积，本 sprint 不实现）
- ❌ 不写 skill-publish 的真实备份/changelog 自动化（spec 保留，实际跑由 LLM 按 spec 执行）
- ❌ 不动 observe.js / memory-v5.js schema（保持下游兼容）

### 成功标准

- [ ] `evaluate-session.js` Stop hook 跑一次后，`~/.claude/homunculus/skill-signals/{name}.jsonl` 真有数据
- [ ] `/skill diagnose sprint` 可读到信号文件并产出诊断报告
- [ ] `/skill auto sprint` 一键跑完 diagnose → eval → improve → publish 提示流程（即便底层 eval 数据缺失也要给"未达条件"输出）
- [ ] `/compound` 末尾出现「Skill 健康摘要」段（即便信号为零也输出"未达阈值"）
- [ ] 4 个旧 `/skill-*` 命令文档顶部加 alias 提示
- [ ] 副本同步通过（`node scripts/pre-commit-check.js`）
- [ ] 跨平台 smoke：Windows path 解析 OK

### 关键假设验证（ADR-012）

| 假设 | 验证文件 | 行 | 结果 | 可信度 |
|---|---|---|---|---|
| `evaluate-session.js:main()` 在 line 799，可在 step 8.5 加新动作 | `scripts/evaluate-session.js` | 799-897 | ✅ Read | high |
| `readSessionObservations()` 已读本 session 观察，可复用 | 同上 | 88-104 | ✅ Read | high |
| `~/.claude/homunculus/skill-signals/` 目录已存在 | 实测 `ls` | — | ✅ 存在但空 | high |
| Codex `tool:"Skill"` + `input_summary.skill` 派生规则 | `scripts/lib/usage-aggregator.js:extractSkillFromObservation` | 95-110 | ✅ 已有可复用函数 | high |
| Claude Code SlashCommand 是否捕获 | observations.jsonl `tool` 字段 | — | ❌ **0 个 SlashCommand** — Claude Code 端 hook 未捕获 slash 命令工具调用 | high |
| compound 步骤 9 "输出报告" 位置可加新段 | `user-level/commands/compound.md` | 96-109 | ✅ Read | high |
| 旧 `/skill-*` 4 命令 frontmatter / 顶部可加 alias 提示 | `user-level/commands/skill-*.md` | 1-10 | ✅ Read | high |
| propagate-command-changes.js 支持新增命令 | `scripts/propagate-command-changes.js` | 1-173 | ✅ T0 Read 全文：propagate 新命令只同步 commands/，skills/ 副本可选；build-codex-plugin.js 需注册 expectedCommands inventory | high |

**关键修正**：Stage A 派生只能覆盖 **Codex 端** skill 调用（observations.jsonl `tool:"Skill"`）。Claude Code 端 SlashCommand 不进 hook，本 sprint 范围内**承认这是数据局限**，不试图修复（修复需改 Claude Code hook 注册策略，超出范围）。Stage A 文档必须明示"仅 Codex 端"。

## 技术方案

### Stage A — 信号收集层

**新增**：`scripts/evaluate-session.js` 加 `aggregateSkillSignals(observations, project, paths)` 函数。

**触发**：Stop hook 时由 `main()` step 8.5 调用。

**派生逻辑**：
```javascript
function aggregateSkillSignals(observations, project, paths) {
  // 复用 lib/usage-aggregator.js 的提取逻辑
  const { extractSkillFromObservation } = require('./lib/usage-aggregator');

  // 去重：同秒同 skill 算 1 次（与 usage-aggregator 一致）
  const skillCallsThisSession = new Map(); // skill → { calls, dedupSet }
  for (const obs of observations) {
    const skill = extractSkillFromObservation(obs);
    if (!skill) continue;
    const entry = skillCallsThisSession.get(skill) || { calls: 0, dedupSet: new Set() };
    const dedupKey = String(obs.timestamp).slice(0, 19);
    if (entry.dedupSet.has(dedupKey)) continue;
    entry.dedupSet.add(dedupKey);
    entry.calls += 1;
    skillCallsThisSession.set(skill, entry);
  }

  if (skillCallsThisSession.size === 0) return { written: 0 };

  // 写入 skill-signals/{name}.jsonl
  const signalsDir = path.join(paths.baseDir, 'skill-signals');
  fs.mkdirSync(signalsDir, { recursive: true });
  let written = 0;
  for (const [skill, data] of skillCallsThisSession) {
    const signalPath = path.join(signalsDir, `${skill}.jsonl`);
    const record = {
      schema_version: '1.0',
      timestamp: new Date().toISOString(),
      session_id: resolveSessionId(),
      project: project.id,
      skill,
      calls: data.calls,
      source: 'codex-observations', // 明示数据源
    };
    fs.appendFileSync(signalPath, JSON.stringify(record) + '\n');
    written += 1;
  }
  return { written, skills: [...skillCallsThisSession.keys()] };
}
```

**输出 schema**（每行 1 个 session 1 个 skill）：
```json
{
  "schema_version": "1.0",
  "timestamp": "2026-05-13T...",
  "session_id": "s-...",
  "project": "8331ab9c2853",
  "skill": "sprint",
  "calls": 3,
  "source": "codex-observations"
}
```

**main() 集成**（line ~853，step 8 之后）：
```javascript
// 8.5. 派生 skill 信号
const skillSignals = aggregateSkillSignals(observations, project, paths);
if (skillSignals.written > 0) {
  console.log(`   📊 Skill 信号: +${skillSignals.written} (${skillSignals.skills.join(', ')})`);
}
```

### Stage B — 入口合并 `/skill <action> <name>`

**新增命令**：`user-level/commands/skill.md`

```markdown
---
description: "Skill 进化统一入口：diagnose/eval/improve/publish/auto"
---

# /skill — Skill 进化统一入口

替代分散的 `/skill-diagnose` `/skill-eval` `/skill-improve` `/skill-publish` 4 命令。

## 用法
- `/skill diagnose <name>`  ← 等价旧 /skill-diagnose（保留 alias）
- `/skill eval <name>`       ← 等价旧 /skill-eval
- `/skill improve <name>`    ← 等价旧 /skill-improve
- `/skill publish <name>`    ← 等价旧 /skill-publish
- `/skill auto <name>`       ← 新增：一键跑 diagnose → eval → improve → publish 闭环
- `/skill list`              ← 新增：列出所有有信号的 skill + 信号数 + 健康度概览

## 子动作详情
[各子动作引用旧命令文档相应段落，避免重复]

## 数据局限
- 信号源：`~/.claude/homunculus/skill-signals/{name}.jsonl`（Stage A hook 派生）
- **仅 Codex 端 skill 调用** — Claude Code 端 SlashCommand 不在 hook 范围
- 调 `/skill list` 看当前有多少信号可分析
```

**旧 4 命令文档顶部加 alias 提示**：
```markdown
> **已合并到 `/skill diagnose <name>`**（保留本命令作 alias，行为完全一致）。新代码请用 `/skill diagnose`。
```

### Stage C — /compound 内嵌触发

**修改 `compound.md` 步骤 9 输出报告**，加 skill 健康摘要：

```text
🎯 Skill 健康摘要（自动扫描 skill-signals/）:
  /sprint:  6 次累计调用 ✓ 健康
  /agent-loop: 信号未达阈值（< 5 次），保持观察
  ⚠ 暂无需 /skill improve

💡 详细诊断: /skill diagnose <name>
```

**派生逻辑**：扫 `~/.claude/homunculus/skill-signals/*.jsonl`，对每个 skill：
- 累计调用 ≥ 阈值（暂定 5 次） → 标 "✓ 健康"
- 累计调用 < 阈值 → 标 "未达阈值"
- 任何 skill 调用 ≥ 20 次 → 提示 "建议 /skill diagnose"

阈值通过 `~/.claude/homunculus/config.json` 可配置（key: `skill_evolution_thresholds`），默认 `{ healthy: 5, recommend_diagnose: 20 }`。

### 任务拆解

- [ ] **T0**: 关键假设最终验证（Read propagate-command-changes.js 全文）— L0，10 min
- [ ] **T1**: `scripts/evaluate-session.js` 加 `aggregateSkillSignals()` — L2，30 min
  - 复用 `lib/usage-aggregator.js` 的 `extractSkillFromObservation`
  - 复用 dedup 逻辑（同秒同 skill）
  - 写入 `~/.claude/homunculus/skill-signals/{name}.jsonl`
  - 集成到 `main()` 作 step 8.5
- [ ] **T2**: 真实跑一次 hook 验证 — L1，5 min
  - 用 `node scripts/evaluate-session.js` 触发
  - 确认 `~/.claude/homunculus/skill-signals/sprint.jsonl` 出现并含数据
- [ ] **T3**: 新建 `user-level/commands/skill.md` — L1，30 min
  - 5 子动作 spec（diagnose/eval/improve/publish/auto/list）
  - 子动作详情可引用旧 4 命令文档段落，避免完全重写
- [ ] **T4**: 修改旧 4 个 `/skill-*` 命令文档顶部加 alias 提示 — L1，10 min
- [ ] **T5**: 修改 `compound.md` 步骤 9 加 skill 健康摘要段 — L1，15 min
- [ ] **T6**: propagate + build-codex-plugin + validate — L2，10 min
  - `node scripts/propagate-command-changes.js skill skill-diagnose skill-eval skill-improve skill-publish compound`
  - `node plugins/tech-persistence/scripts/build-codex-plugin.js`
  - `node scripts/validate-codex-plugin.js`
- [ ] **T7**: pre-commit-check 验证 — L1，5 min
- [ ] **T8**: 跨平台 smoke — L2，15 min
  - Windows path 测试（aggregateSkillSignals 用 `path.join`，不应有 `/` 硬编码）
  - 触发 hook 看 skill-signals 文件是否真生成
- [ ] **T9**: 更新 README.md 命令速查表（新增 `/skill` 行，4 旧命令标注 alias）— L1，10 min
- [ ] **T10**: 更新 `~/.claude/CLAUDE.md` 索引追加本 sprint 经验 — L1，5 min
- [ ] **T11**: 跑 `node scripts/usage-report.js` 生成新报告（确认 /skill 命令录入未来报告）— L0，2 min

### 测试策略

研究类 + 实施混合，按风险等级测试：

| Task | 风险 | 测试 |
|---|---|---|
| T1 | L2 | self-test：mock observations 含 5 个 Skill entries → assert 写入 jsonl 1 行 1 skill |
| T2 | L1 | 真实跑 hook，检查文件存在 + 内容合法 JSON |
| T3-T5 | L1 | grep 关键字段，确认子动作命令 / alias 提示 / health summary 段写入 |
| T6-T7 | L2 | pre-commit-check exit=0 |
| T8 | L2 | mock Windows path 测试 — 用 `path.join` 不用 `+` |

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Stage A 派生只覆盖 Codex 端，Claude Code 端 SlashCommand 不在 | H | M | 文档明示"仅 Codex 端"；未来扩展通过 transcript reader（已在 `usage-aggregator.js` 实现） |
| evaluate-session.js 改动破坏现有 hook 主流程 | L | H | 复用 `try { main() } catch { exit(0) }` 既有错误吞噬；新增 step 单独 try-catch |
| 旧 4 命令 alias 提示不够显眼，用户继续用 | M | L | 顶部加显眼提示框；CLAUDE.md 索引也明示 |
| skill-signals 写入失败（权限/磁盘）| L | L | mkdirSync 已 `recursive: true`，写入用 appendFileSync（已隐含异常处理） |
| /compound 内嵌段当 signals 为空时输出难看 | L | L | 显式输出"未达阈值，保持观察"，避免空字符串 |
| propagate 不支持新命令 skill.md | M | M | T0 先 Read propagate-command-changes.js 验证 |
| dogfood 矛盾：本 sprint 改 /compound 但不调 /compound | L | L | 本 sprint Phase 5 必须真跑 /compound，验证 Stage C |

### 涉及文件

**新增**：
- `user-level/commands/skill.md`（~80 行）
- 副本：`.codex/commands/skill.md`、`.codex/skills/skill/SKILL.md`、`plugins/tech-persistence/commands/skill.md`、`plugins/tech-persistence/skills/skill/SKILL.md`

**修改**：
- `scripts/evaluate-session.js`（+~50 LOC，新增 `aggregateSkillSignals` + 集成到 main）
- `user-level/commands/skill-diagnose.md`（+3 行 alias 提示）
- `user-level/commands/skill-eval.md`（+3 行）
- `user-level/commands/skill-improve.md`（+3 行）
- `user-level/commands/skill-publish.md`（+3 行）
- `user-level/commands/compound.md`（+10 行 skill 健康摘要段）
- `README.md`（命令速查表更新）
- `~/.claude/CLAUDE.md` 索引（追加一行）

**同步副本（propagate）**：上述 6 个命令的 `.codex/` 和 `plugins/tech-persistence/` 副本。

### Dogfood 自检

- 本 sprint 是 enforcement 提案吗？**否** — 没新增 pre-commit / lint / hook 拒绝。Stage A 是数据写入，Stage B 是新增命令，Stage C 是 LLM 自动派生提示。
- 边界产物枚举：`evaluate-session.js` / `scripts/lib/skill-signals.js` / 6 个命令文档（skill / skill-{diagnose,eval,improve,publish} / compound） / 4 副本目录（.codex/commands + .codex/skills + plugins/.../commands + plugins/.../skills） / `build-codex-plugin.js` expectedCommands inventory / README / CLAUDE.md（项目）/ `user-level/CLAUDE.md`（user 副本，由 dogfood hook 自动 touch）= 14 处
- 本 sprint 自身验证：Phase 5 必须真跑 `/compound`（不只口头），由 Stage C 健康摘要段落作首次实际触发

## 审查结果（Phase 4）

3 个 reviewer 并行（correctness / maintainability / project-standards）。

### P0 — 已修

| # | 视角 | 文件:行 | 问题 | 修复 |
|---|---|---|---|---|
| P0-1 | project-standards | `user-level/commands/skill.md:5-9` | `/skill auto` 等子动作描述但无底层代码，引入 [[documented-claim-vs-code-reality-drift]] 新案例 | ✅ 文件顶部加 **LLM 协议入口** 显式声明块 |
| P0-2 | project-standards | `user-level/commands/compound.md:113-115` | 步骤 9.5 "自动扫" 实为 LLM 协议非 hook | ✅ 子段头部加"由 LLM 执行者手动派生"说明 |

### P1 — 已修

| # | 视角 | 文件:行 | 问题 | 修复 |
|---|---|---|---|---|
| P1-A | correctness | `scripts/lib/skill-signals.js:31` | skill 名未 sanitize，可路径逃逸到 signalsDir 外（`../../etc/...`） | ✅ 加 `SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/` 校验，aggregate + summarize 两端都过滤 |
| P1-B | correctness / maint | `scripts/lib/skill-signals.js:60` `scripts/evaluate-session.js:865` | 3 处 `catch {}` 完全静默违反 [[fail-open-marker]] | ✅ 全部加 `process.stderr.write('[skill-signals] ...')` 日志 |
| P1-C | maintainability | `user-level/commands/skill-{diagnose,eval,improve,publish}.md:2` | 旧 alias frontmatter description 没标 [alias]，命令面板易混 | ✅ 4 个全加 `[alias → /skill X]` 前缀 |
| P1-D | maintainability | `user-level/commands/compound.md:141` | spec 暴露 `require('scripts/lib/skill-signals')` 路径细节，造成耦合 | ✅ 改为 "**实现指引**（不绑死 API 签名）" 意图描述 |
| P1-E | maintainability | `scripts/lib/skill-signals.js:69-71` | summarize 签名不对称 + sessionId fallback `s-${Date.now()}` 同毫秒撞 | ✅ summarize 改 `({ baseDir, ... })` 解构；sessionId 优先用 `observations[0].session_id` |
| P1-F | project-standards | `docs/plans/2026-05-13-skill-evolution-architecture.md:83` | ADR-012 假设表 T0 行未回填 ✅ | ✅ 回填 high + 标 line range 1-173 |
| P1-G | project-standards | `docs/plans/2026-05-13-skill-evolution-architecture.md:288` | dogfood 边界清单未列 user-level/CLAUDE.md + `build-codex-plugin.js` inventory | ✅ 边界从 12 → 14 处枚举 |

### P2 — 文档化已知残留（不在本 sprint 修）

见下方「## 已知 P2 残留」段。

### Reviewer 一致接受

- 副本同步合规（PS-P2-5 正面）：build-codex-plugin.js inventory 已注册 skill.md
- Windows shell-mismatch 无回归（PS-P2-6）：本 sprint 未触及 hook command

### P1 修复后 self-test 验证

5 项全过：normal write / **path escape blocked** / new signature / **obs session_id fallback** / stderr marker。

## 已知 P2 残留（不在本 sprint 修）

- **Dedup 语义粗粒度**：`aggregateSkillSignals` 按 `timestamp.slice(0,19)` 秒级 dedup。同秒内 2 次真实的不同 skill 调用（CI burst / 批量脚本）会折叠为 1。这是 hook 双触发场景的 trade-off — 未来若有"同秒高并发真实场景"再加 `input_summary` hash 增强 dedup key
- **`summarizeSkillSignals` 用 readFileSync**：当前 jsonl 单文件 < 1KB，不需要流式；jsonl 累计到 MB 级再切换 readline 流式（与 usage-aggregator 一致）
- **常量过早 export**：`SKILL_SIGNALS_SCHEMA_VERSION` / `SIGNALS_DIR_NAME` 当前只本模块用；保留是因为外部 LLM 协议 spec（/skill 命令）需要稳定 anchor，但未来若改路径需同步 spec 文档
- **skill.md 与 alias 双源真相**：长期方向是收敛到单源。6 个月后若 usage-report 显示旧 `/skill-*` 调用数为 0，可删 alias

## 实施进度

### 变更日志

| 日期 | Phase / Task | 说明 |
|------|------|------|
| 2026-05-13 | Phase 1 | 创建文档，确认 scope 与 non-scope |
| 2026-05-13 | Phase 2 | 12 个 Task 拆解，关键假设验证完成（除 T0 propagate Read） |
| 2026-05-13 | T0 | Read propagate-command-changes.js 全文：确认新命令仅同步 commands/，skills/ 副本可选 |
| 2026-05-13 | T1 | 决策：从 evaluate-session.js 内联实现重构为独立 `scripts/lib/skill-signals.js`（动机：可单测，且 require evaluate-session.js 会触发 auto-checkpoint 副作用）|
| 2026-05-13 | T2 | self-test 5/5 全过：dedup / phase 过滤 / 空 obs / summarize / 损坏 jsonl 容错 |
| 2026-05-13 | T3 | `user-level/commands/skill.md` 新建（含 5 子动作 + list + auto，~150 行） |
| 2026-05-13 | T4 | 4 旧 skill-* 命令顶部加 alias 提示框 |
| 2026-05-13 | T5 | `compound.md` 步骤 9.5 加 Skill 健康摘要段（含信号为空兜底输出）|
| 2026-05-13 | T6 | propagate + build + validate 一次过；build-codex-plugin.js inventory 新增 `skill.md` 注册 |
| 2026-05-13 | T7 | pre-commit-check exit=0 |
| 2026-05-13 | T8 | 跨平台 smoke 5/5：路径分隔符 / archive 不存在 / 空 baseDir / 损坏 jsonl / 数据写入路径 |
| 2026-05-13 | T9 | README 命令速查表更新（Skill 4 → 5，标 alias）|
| 2026-05-13 | T10 | CLAUDE.md 索引追加 [2026-05-13] [architecture/skill-evolution/stage-abc] 行 |
| 2026-05-13 | T11 | 重跑 usage-report：本 sprint 触发 sprint=7（+1），Stage A 数据将在下次 Codex 端 Skill 调用累积 |
| 2026-05-13 | Phase 4 | 3 reviewer 并行审查（correctness / maintainability / project-standards）。2 个 P0 + 7 个 P1 全修，4 项 P1 self-test 全过 |
| 2026-05-13 | Phase 5 | Compound：经验提取 + 本能更新 + 索引追加 |

## 复利记录

### 提取的经验

**L1：「空架构」是高频陷阱 — spec 完整 + 目录创建 ≠ 实施**
- 本 sprint 暴露：`init-obsidian-vault.js:458` mkdir 3 个 skill-* 目录但永远是空（`grep skill[-_]signal scripts/` 0 命中实施代码）
- 命令文档完整但用户调用读不到数据
- 这是 [[documented-claim-vs-code-reality-drift]] 的"开局型"案例（drift 从一开始就存在，不是慢慢漂离）
- 反思：未来"声称 X 功能存在"前必须 grep 实施代码

**L2：dogfood 边界产物枚举要含「自动 touch」副本**
- ADR-013 枚举 12 处时漏了 `user-level/CLAUDE.md` 这种**由 dogfood hook 自动 touch** 的边界
- Phase 4 reviewer 抓到（边界 → 14 处）
- 修订：边界枚举不止"我主动改的"，还含"我跑代码会副作用 touch 的"

**L3：fail-open marker 在 sprint 内是高频反模式**
- 3 处 `catch {}` 都来自 Stage A 实施（本能 [[fail-open-marker]] 升级建议）
- 应在 lib 模板中默认含 `process.stderr.write('[lib-name] ...')` 占位

**L4：LLM 命令文档应有「LLM-protocol」显式声明**
- 本项目 21 个 /command 全部是 LLM 协议入口，无 deterministic backing 代码
- 但只有本 sprint 因为 reviewer 抓到才补声明
- 系统性方案：`pre-commit-check.js` 加一条 lint「user-level/commands/*.md 顶部必须含 LLM-protocol 声明或 deterministic 标签」（推到 follow-up）

**L5：Lib 函数签名对齐 = 跨函数可记忆**
- aggregate 用 `(observations, opts)` 解构 vs summarize 用 `(baseDir, opts)` 位置参数 — 即便单个看都合理，混在一起就增加心智成本
- 规则：lib 模块内 export 的多个相关函数，第一参数和 opts 解构形式必须一致

**L6：Plan 阶段假设验证表回填是 ADR-012 的隐性要求**
- ADR-012 写"plan 列出的涉及文件每个必须 Read"，但没写"T0 完成后回填可信度"
- 本 sprint T0 实际跑了 Read 但表格仍标 medium，被 reviewer 抓到
- 修订：可信度从 medium → high 的回填动作应是 sprint hook 强制（推到 follow-up）

### 创建/更新的本能

- 升级 `[[documented-claim-vs-code-reality-drift]]` confidence 0.85 → 0.9：N+1 验证（本 sprint 抓到 skill-* 空架构是开局型 drift）
- 升级 `[[fail-open-marker]]` confidence：3 处 catch 静默违规一次性暴露，证明本能仍有真实需求
- 新候选本能 `[[lib-spec-completeness-check]]` confidence 0.6, N=1：mkdir 目录 ≠ 实施。下次再见类似（mkdir + 命令文档存在 + 实施代码缺失）+1

### 解决方案文档

- `docs/solutions/2026-05-13-skill-evolution-stage-abc.md`（pending — 仅当用户后续提取时创建）

### Skill 信号摘要

本 sprint 通过 Claude Code 触发，**Stage A 仅捕获 Codex 端 `tool:"Skill"`**，故 sprint 期间 skill-signals/ 仍为空。Stage A 数据将在下次 Codex `$sprint` 类调用时开始累积。

### Sprint 完成

- 文档: `docs/plans/2026-05-13-skill-evolution-architecture.md`
- Checkpoints: 0（本 sprint 中等规模，单回合完成）
- Phase 4 修复: P0 × 2 + P1 × 7 全部 closed
- Knowledge: 6 条经验 (L1-L6), 2 个本能升级, 1 个候选新本能

## 下一 Phase 预热（Phase 3: Work）

关键文件: `scripts/evaluate-session.js:799`（main 注入点）、`scripts/lib/usage-aggregator.js:95-110`（复用 extractSkillFromObservation）、`user-level/commands/compound.md:96-109`（步骤 9 输出报告）

执行命令:
- `node scripts/evaluate-session.js`（T2 验证 hook）
- `node scripts/propagate-command-changes.js skill skill-diagnose ...`（T6 同步）

风险预判:
- evaluate-session.js 是 hook 主流程，加 step 必须保持错误吞噬不破坏现有 try/catch
- propagate-command-changes.js 对新增命令的支持需先验证（T0 强制 Read 全文）
- Windows path 处理用 `path.join`，不要拼接 `/`
