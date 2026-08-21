---
name: skill
description: Codex-compatible entry point for the former /skill command. Skill 进化统一入口：diagnose/eval/improve/publish/auto/list
---

# Skill

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/skill` command.

## Invocation

Use `$skill <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/skill`, interpret that as this `$skill` skill invocation while running in Codex.

## Command Instructions

# /skill — Skill 进化统一入口

> 本命令仍由 LLM 编排 diagnose/improve/eval/publish，但 candidate lifecycle 必须调用 canonical
> `scripts/self-learning.js`；LLM 文本、内存中的 proposal 或标量 pass rate 都不是发布授权。
> Stage A hook（`scripts/lib/skill-signals.js`）只派生使用信号，不能创建 approval 或 promotion。

## Self-learning candidate gate

- `/skill improve` 必须 `propose` `LearningCandidate` 并返回 `candidate_id`、`candidate_hash`；target 必须是
  exact `{key,source_path,source_hash}`：key 仅为 `skill:<name>`/`command:<name>`，source_path 仅允许
  `codex-native/skills/<name>/SKILL.md`、`user-level/skills/<name>/SKILL.md` 或对应
  `user-level/commands/<name>.md`，source_hash 绑定提案所基于的当前源文件。
- `/skill eval` 必须由独立 evaluator `evaluate`，绑定 candidate/skill/baseline/case-set/evaluator hash、
  `case_results_hash/case_count/passed_count/pass_rate`，并返回 `evaluation_id`、`evaluation_hash`；通过后
  也只能进入 `shadow`，其中 pass rate 必须由 counts 派生。
- `approve` 必须引用绑定当前 candidate hash 的显式 `user.approval` 和独立
  `approval_receipt_id`、`approval_receipt_hash`；`promote` 只能由 publish gate 调用。
- 自动化最多执行 diagnose、`propose`、`evaluate`、`shadow`；不得执行 `approve`、`promote`、publish，
  不得写 skill、command、rules、runtime projection 或 `absorbed_into`/`evolved_into` marker。
- `/skill publish` 即使已有有效 approval receipt，仍保留当前动作的人工 `go` gate。
- `/skill publish` 的机器门禁优先通过 MCP `tp_learning_govern(operation="publish-guard")` 读取
  authoritative journal；不要假设业务仓库 cwd 下存在 `scripts/skill-eval-results.js`。CLI 仅作为
  Tech Persistence repo/admin 入口。
- eval 前调用 MCP `tp_learning_govern(operation="artifact-stage")`，只传 name、candidate_id 和 bounded
  content，由固定 authority 以原子 no-clobber/CAS 写入 canonical
  `skill-evals/<name>/candidates/<candidate_id>/artifact.md`；evaluation 的 `subject_artifact_hash` 与
  publish guard 对 baseline/current 的实际文件读回必须一致。promote 后的 v3 timeline 必须调用
  `operation="result-record"` 从 authority 派生，caller 只能提供 name、candidate_id 与展示 version。
- case 结果不能通过 MCP 自报或 stage。独立 evaluator 在同一可信本地进程调用
  `stageEvaluationArtifactAuthority(...,{baseDir,projectId,cwd})`，显式 project identity 并 exact 覆盖
  不可变 `cases.jsonl` 的全部唯一 case id；每次 stage/read 均重验 active journal refs。MCP
  `evaluate` 只提交 `evaluation_artifact_ref:{name}`，服务从固定路径读回并签发当前进程 brand，所有
  case hash/count/pass rate 均由服务端派生。

替代分散的 `/skill-diagnose` `/skill-eval` `/skill-improve` `/skill-publish` 4 命令。**4 个旧命令保留作 alias**，行为完全一致。

## 用法

```text
/skill list                ← 列出有信号的 skill 及健康度概览
/skill diagnose <name>     ← 等价 /skill-diagnose
/skill eval <name>         ← 等价 /skill-eval
/skill improve <name>      ← 等价 /skill-improve
/skill publish <name>      ← 等价 /skill-publish
/skill auto <name>         ← 自动跑 diagnose → improve/propose → eval → shadow（不发布）
```

Codex 同义：`$skill <action> <name>`

## 数据源

diagnose 读 `~/.codex/homunculus/skill-signals/{name}.jsonl`；improve/eval/publish 还必须读取 canonical
self-learning candidate/evaluation/approval receipt。skill-signals 仅证明 usage，不能证明质量或授权。

**数据局限**（必读）：
- 信号源**仅覆盖 Codex 端 `tool:"Skill"` 调用**。Codex 端 SlashCommand 不进 PreToolUse hook，结构性无法捕获
- 跑 `/skill list` 看当前有多少 skill 有信号可分析；如为空说明 30 天内无 Codex 端 Skill 调用

## 子动作详情

### `/skill list`

**新增**。列出 `skill-signals/` 中所有 skill：

```text
📊 Skill 信号概览（来源: skill-signals/）

| Skill   | 累计调用 | 末次   | 健康度       |
|---------|---------|-------|-------------|
| sprint  | 18      | 05-13 | 🟢 healthy   |
| work    | 6       | 05-10 | 🟢 healthy   |
| evolve  | 2       | 04-22 | 🟡 observe   |
| ...     |         |       |             |

健康度阈值（可在 ~/.codex/homunculus/config.json 配置）:
- 🟢 healthy:   累计调用 ≥ 5
- 🟡 observe:   累计 < 5（保持观察，未达分析阈值）
- 🔴 recommend: 累计 ≥ 20（建议跑 /skill diagnose <name>）

💡 仅显示 Codex 端调用；non-Codex slash command 不在统计内
```

### `/skill diagnose <name>`

读取 `~/.codex/homunculus/skill-signals/{name}.jsonl`，分析使用情况。诊断时可半自动从 observations 提取失败 trace（`node scripts/skill-traces.js record ...`，人工确认 gate）供 improve 反思。详细规范见 [skill-diagnose.md](./skill-diagnose.md)（保留 alias）。

### `/skill eval <name>`

用独立、不可变测试集验证指定 candidate。promotion case 只能引用当前项目 canonical journal 中仍 active 的
trusted native user `UserPromptSubmit` BehaviorEvent；caller trace snapshot 和同源自动 case 只能 exploratory。
evaluation 必须绑定 exact target、`candidate_id`、`candidate_hash`、`skill_hash`、
`baseline_hash`、server-derived `case_set_hash`、`evaluator_id`，并产出 `evaluation_id`、
`evaluation_hash`。详细规范见
[skill-eval.md](./skill-eval.md)。

### `/skill improve <name>`

基于 diagnose 报告 + 相关本能 + 失败 trace（`skill-traces/`）生成结构化修改 proposal；对每条 trace
做根因反思（GEPA 内核），随后通过 canonical writer `propose`，不修改 skill。详细规范见
[skill-improve.md](./skill-improve.md)。

### `/skill publish <name>`

发布已验证 candidate，含 backup、changelog、readback、rollback。发布前必须严格验证 candidate、
evaluation 和显式 user approval receipt 的 identity/hash，再跑确定性回归护栏；缺失、损坏、陈旧或
不匹配、tombstoned 或当前状态非 promoted 全部 fail closed。最后仍需人工 `go`。详细规范见
[skill-publish.md](./skill-publish.md)。

### `/skill auto <name>`

一键跑到 shadow 为止；`/skill auto` 不得调用 publish 或 `promote`：

```text
Phase 1/4: diagnose <name>
  → 信号 0 → 中止，输出 "需要 ≥ 5 次 Codex Skill 调用才能诊断"
  → 信号充足 → 输出诊断报告，进 Phase 2

Phase 2/4: improve/propose <name>
  → 基于 diagnose 生成 proposal preview
  → 写入 canonical candidate，读回 candidate_id + candidate_hash

Phase 3/4: eval <name> --candidate <candidate_id>
  → 测试集/基线不存在或 identity 不完整 → needs-review 并中止
  → 独立 eval，读回 evaluation_id + evaluation_hash

Phase 4/4: shadow <candidate_id>
  → eval pass 且 hash 一致 → shadow
  → 输出建议与缺口；不 approve、不 promote、不 publish、不写 marker
```

**强制 gate**（即使会话启用 `--auto` 也保留）：

- Phase 1 → 2：信号不足时不进；调用次数只表示 usage。
- Phase 2 → 3：必须有读回成功的 candidate identity/hash。
- Phase 3 → 4：必须有独立 evaluation identity/hash，任一 malformed/stale 立即中止。
- auto 在 shadow 结束，不能询问或推断 approval。后续 `/skill publish` 需显式 `user.approval` receipt，
  并在实际改源文件前再次等待人工 `go`。

## 子动作 vs Stage A 关系

| 子动作 | 数据依赖 | 当前可用性 |
|--------|---------|-----------|
| list | skill-signals/*.jsonl | ✅ 立即可用（hook 已派生）|
| diagnose | 同上 + 历史 sessions | ✅ 立即可用（信号 ≥ 5 触发） |
| eval | skill-evals/{name}/ 测试集 | ⚠ 需先创建测试集（auto 模式提示创建） |
| improve | diagnose + evidence/trace | ✅ 只生成 candidate |
| publish | candidate + eval + approval receipt + 人工 go | ⚠ 严格 gate |
| auto | diagnose → candidate → eval → shadow | ✅ 不发布 |

## /compound 集成（自动提示）

`/compound` 结尾会扫 `skill-signals/`，对累计 ≥ recommend 阈值的 skill 自动输出：

```text
🎯 Skill 健康摘要（自动检测）
  /sprint: 累计 18 次（健康）
  /agent-loop: 累计 22 次 🔴 建议 /skill diagnose agent-loop

💡 详细诊断: /skill diagnose <name>
```

详见 `compound.md` 步骤 9。

## 阈值配置

`~/.codex/homunculus/config.json`：

```json
{
  "skill_evolution_thresholds": {
    "healthy": 5,
    "recommend_diagnose": 20
  }
}
```

未配置时使用上述默认值。
