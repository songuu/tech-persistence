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

> **本命令为 LLM 协议入口，无 deterministic backing 代码。**
> Stage A hook（`scripts/lib/skill-signals.js`）仅负责派生 `skill-signals/{name}.jsonl` 数据文件；本文档的 list / diagnose / eval / improve / publish / auto 子动作均由 LLM 读取信号文件后按本文档规范产出结果。若你需要 deterministic 数据查询，调 `node -e "console.log(require('scripts/lib/skill-signals').summarizeSkillSignals(...))"`。

替代分散的 `/skill-diagnose` `/skill-eval` `/skill-improve` `/skill-publish` 4 命令。**4 个旧命令保留作 alias**，行为完全一致。

## 用法

```text
/skill list                ← 列出有信号的 skill 及健康度概览
/skill diagnose <name>     ← 等价 /skill-diagnose
/skill eval <name>         ← 等价 /skill-eval
/skill improve <name>      ← 等价 /skill-improve
/skill publish <name>      ← 等价 /skill-publish
/skill auto <name>         ← 一键跑闭环 diagnose → eval → improve → publish
```

Codex 同义：`$skill <action> <name>`

## 数据源

所有子动作读 `~/.codex/homunculus/skill-signals/{name}.jsonl`（Stage A hook 自动派生）。

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

读取 `~/.codex/homunculus/skill-signals/{name}.jsonl`，分析使用情况。详细规范见 [skill-diagnose.md](./skill-diagnose.md)（保留 alias）。

### `/skill eval <name>`

用预定义测试集验证 skill 质量。详细规范见 [skill-eval.md](./skill-eval.md)。

### `/skill improve <name>`

基于 diagnose 报告 + 相关本能生成结构化修改提案。详细规范见 [skill-improve.md](./skill-improve.md)。

### `/skill publish <name>`

发布已 eval 验证的提案为新版本，含 backup + changelog + rollback。详细规范见 [skill-publish.md](./skill-publish.md)。

### `/skill auto <name>`

**新增**。一键跑完整闭环：

```text
Phase 1/4: diagnose <name>
  → 信号 0 → 中止，输出 "需要 ≥ 5 次 Codex Skill 调用才能诊断"
  → 信号充足 → 输出诊断报告，进 Phase 2

Phase 2/4: eval <name>
  → 测试集不存在 → 提示是否自动生成（y/n）
  → 测试集存在 → 跑 v_current 通过率，进 Phase 3

Phase 3/4: improve <name>
  → 基于 diagnose 输出生成 N 个提案
  → 输出 diff 预览，等待人工 'go' 确认

Phase 4/4: publish <name>
  → 仅在 eval 新版本通过率 ≥ 旧版本时执行
  → 备份 + changelog + 标记 absorbed_into
```

**强制人工 gate**（即使会话启用 `--auto` 也保留）：
- Phase 1 → 2：信号不足时不进
- Phase 3 → 4：publish 改 skill 源文件，必须用户 'go' 确认

## 子动作 vs Stage A 关系

| 子动作 | 数据依赖 | 当前可用性 |
|--------|---------|-----------|
| list | skill-signals/*.jsonl | ✅ 立即可用（hook 已派生）|
| diagnose | 同上 + 历史 sessions | ✅ 立即可用（信号 ≥ 5 触发） |
| eval | skill-evals/{name}/ 测试集 | ⚠ 需先创建测试集（auto 模式提示创建） |
| improve | diagnose + 待吸收本能 | ✅ 立即可用 |
| publish | improve 提案 + eval 通过 | ⚠ 需 eval 数据 |
| auto | 上述全部 | ✅ 各阶段失败时给明确提示 |

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

