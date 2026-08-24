---
description: "复利步骤：沉淀 solution，并将行为经验提交为可审计学习候选"
---

# /compound — 复利循环（核心步骤）

融合 Compound Engineering + 本能系统 + Skill 信号 + Obsidian 知识图谱。
**每次有意义的工作结束后都应执行。**

## Self-learning candidate gate

- `docs/solutions/` 文档及其 canonical index 仍可在 Compound 既有写权限内直接新增/更新；这是
  evidence-backed solution 沉淀，不是 runtime 行为发布。
- 规则、本能、workflow、boundary、anti-pattern 等行为学习输出统一为 `LearningCandidate`，通过
  canonical `scripts/self-learning.js` 执行 `propose`；证据完整时可 `evaluate`，随后只能 `shadow`。
- 自动流程最多执行 `propose`、`evaluate`、`shadow`；不得执行 `approve`、`promote`，不得直接写
  rules、instinct、skill、command、共享 runtime 或 absorption/evolution marker。
- 用户运行 Compound 不等于批准候选。`approve` 必须引用绑定当前 candidate hash 的显式
  `user.approval` 与 approval receipt；`promote` 是后续独立治理动作。

## 执行流程

### 步骤 1: 扫描会话，提取 7 类知识
| 类型 | 写入位置 |
|------|---------|
| 解决方案 | `docs/solutions/` + `docs/solutions/index.jsonl` + CLAUDE.md 有界投影（Codex 按需读取 canonical index） |
| 踩坑记录 | `LearningCandidate`，target 使用 exact `{key,source_path,source_hash}`，绑定 `rule:project/debugging-gotchas` 与 `.claude/rules/debugging-gotchas.md` 当前字节哈希 |
| 架构决策 | `LearningCandidate`，target 使用 exact `{key,source_path,source_hash}`，绑定 `rule:project/architecture` 与 `.claude/rules/architecture.md` 当前字节哈希 |
| 行为本能 | `LearningCandidate`，kind=`preference/strategy/workflow/boundary/anti_pattern` |
| 模式发现 | `LearningCandidate`，显式 scope/owner |
| 性能数据 | solution evidence 或 `LearningCandidate`，不得凭单样本固化规则 |
| 测试模式 | `LearningCandidate`，target 使用 exact `{key,source_path,source_hash}`，绑定 `rule:project/testing-patterns` 与 `.claude/rules/testing-patterns.md` 当前字节哈希 |

### 步骤 2: 生成解决方案文档（Obsidian 兼容）

文件：`docs/solutions/{YYYY-MM-DD}-{slug}.md`

**必须包含 Obsidian frontmatter + wikilinks：**

```yaml
---
title: "[问题简述]"
date: YYYY-MM-DD
tags: [solution, 领域tag]
related_instincts: [instinct-id-1]
aliases: ["问题的别名"]
---
```

```markdown
# [问题简述]

## Problem
[1-2 句]

## Root Cause
[为什么]

## Solution
[怎么解决，含代码]

## Prevention
[如何避免]

## Related
- [[instinct-id]] — 关联本能
- [[session-YYYY-MM-DD]] — 发现此问题的会话
```

`docs/solutions/*.md` 是唯一详情源；`docs/solutions/index.jsonl` 是唯一摘要索引缓存。CLAUDE.md 仅保留 Claude 的有界 runtime 投影；Codex 不再把解决方案索引静态写入 AGENTS.md，而是按需读取 canonical index。

### 步骤 2.5: 统一同步 solution index

写完 solution 文档后运行统一 renderer：

```bash
node scripts/sync-solution-index.js --all  # idempotent；同步 canonical index + Claude runtime projection；Codex 保持按需读取
```

效果：
- `docs/solutions/index.jsonl` 从 `docs/solutions/*.md` 重建（canonical summary cache）
- CLAUDE.md 的 `### 解决方案索引` managed block 始终保留**最近 5 条**；AGENTS.md 不再承载解决方案索引
- Claude always-on 注入保持有界，Codex solution index 的 always-on 注入为 0（设计参考 `docs/plans/2026-05-14-claude-md-index-via-prompt-recall.md`）
- Claude 的老条目仍可被 **prompt recall hook**（UserPromptSubmit）按当轮 prompt 召回；Codex 仅在相关任务中按需检索 `docs/solutions/index.jsonl` 或详情文档
- 两个 runtime 共享同一 canonical summary；只有 Claude 保留有界静态投影

报告中加一行 `Solution index: synced <N> entries → docs/solutions/index.jsonl + CLAUDE.md (Codex on-demand)`。

### 步骤 3: 提取经验为 candidate

项目特有经验提出 project-scope candidate；跨项目经验只有在有多个独立 Episode/EvidenceRef、完成
scope gate 和反例检查后，才可建议 personal/global scope。两者都不在本步骤直接写 rules 或
`CLAUDE.md`。

### 步骤 4: 创建/更新 LearningCandidate

对每个非平凡行为模式：

1. 从当前 diff、测试、用户反馈或 solution 建立脱敏、hash-bound EvidenceRef。
2. 搜索现有 candidate/rule/instinct/solution 去重；旧 instinct 仅作为 `legacy-unverified` 信号。
3. 通过 canonical writer 执行 `propose`，读回 `candidate_id` 与 `candidate_hash`。
4. 独立 evaluator 绑定 rubric/evidence/exam 后才可执行 `evaluate`；所有 candidate 必经 `shadow`。
5. 缺少最终处置、稳定 identity、counterexample review 或 owner 时留在 `needs-review`。

```text
candidate_id: <stable-id>
candidate_hash: <content-hash>
kind: <preference|environment_fact|strategy|workflow|boundary|anti_pattern>
scope: <task|project|personal|global|team>
owner: <identity>
status: proposed | needs-review | evaluated | shadow
evidence_refs: [...]
counterexample_refs: [...]
tv: <rubric-bound assessment or pending>
```

### 步骤 5: 整合 /review 中的 `[🧠 新发现]`

`[🧠 新发现]` 仍须经过相同 EvidenceRef/candidate gate；review finding 本身不是 truth oracle，不能直接
成为 rule 或 instinct。

### 步骤 6: 采集 Skill 使用信号
检查本次使用了哪些 skill，记录到 `skill-signals/{name}.jsonl`。
放弃率 > 30% 或纠正 3+ 次 → 提示 `/skill-diagnose`。

### 步骤 7: Candidate 与 skill 差异提示

candidate 可声明目标 skill 和 legacy `pending_absorption` 来源，但不修改源 instinct marker。满足样本、
TV 和 counterexample 条件时提示 `/skill improve <name>`；重复 5+ 次只构成诊断信号，不授权吸收或发布。

### 步骤 8: Sprint 交接检查
如果当前在 sprint 中且检测到上下文压力 → 建议 `/checkpoint`。

### 步骤 9: 输出报告

```
🔄 Compound 复利报告

📄 解决方案: N 个 → docs/solutions/ (Obsidian #solution)
📝 行为学习: proposed N | needs-review N | evaluated N | shadow N
🧠 Candidate: <candidate_id>@<candidate_hash>（未写 rules/instinct/runtime）
📊 Skill 信号: N 个 skill
⚡ Sprint: [进度/checkpoint 状态]

💡 Solution 文档按既有边界写入；行为学习仅写 self-learning journal/projection
   shadow 不自动注入，approve/promote 未执行
```

### 步骤 9.5: Skill 健康摘要

> **本段由 /compound 的 LLM 执行者在产出报告前手动派生**（读取 `skill-signals/*.jsonl` + 应用阈值），非自动 hook。Stage A 仅负责数据写入，本步骤是消费端。

读 `~/.claude/homunculus/skill-signals/*.jsonl`（Stage A hook 派生），按累计调用数 + 阈值输出健康度：

```
🎯 Skill 健康摘要

| Skill   | 累计 | 末次   | 健康度        |
|---------|-----|-------|--------------|
| sprint  | 18  | 05-13 | 🟢 healthy    |
| work    | 6   | 05-10 | 🟢 healthy    |
| evolve  | 22  | 04-22 | 🔴 recommend  |

🔴 1 个 skill 累计调用 ≥ 20 — 建议跑 /skill diagnose evolve
💡 详细诊断: /skill diagnose <name>
```

阈值（`~/.claude/homunculus/config.json` 可配置，未配置时取默认）：
- 🟢 healthy: 累计 ≥ 5
- 🟡 observe: 累计 < 5
- 🔴 recommend: 累计 ≥ 20

**信号为空时**（首次 compound 或无 Codex Skill 调用）：

```
🎯 Skill 健康摘要
  暂无信号（skill-signals/ 为空或仅含 0 调用）
  💡 Stage A hook 仅采集 Codex 端 tool:"Skill"；Claude Code SlashCommand 不在统计内
```

**实现指引**（不绑死 API 签名）：读 `scripts/lib/skill-signals` 模块派生健康度摘要数据；阈值优先从 `~/.claude/homunculus/config.json` 的 `skill_evolution_thresholds` 读，未配置时取默认 `{ healthy: 5, recommend_diagnose: 20 }`。

## Phase 间预热钩子

完整 sprint 内执行时（`/sprint` 调用），本命令报告末尾**可选**追加「收尾预热」段（无下一 phase，但有清场动作；2026-05-22 起改建议非强制）。协议见当前命令集合中 `sprint.md` 的「Phase 间预热协议」。

本命令的典型预热内容：

```text
## 收尾预热（无下一 Phase）
关键文件: sprint 文档 frontmatter
执行命令: 确认 status: completed、检查是否需 /compact
风险预判: 上下文压力、未处理的 P2 backlog、未关闭的 follow-up
```

单独使用本命令（不在 sprint 内）时，预热段建议但非必须。
