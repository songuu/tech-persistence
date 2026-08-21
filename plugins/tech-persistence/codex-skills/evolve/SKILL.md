---
name: evolve
description: Codex-compatible entry point for the former /evolve command. 将本能聚类为可审计的 skill、command、agent 或 rule 学习候选
---

# Evolve

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/evolve` command.

## Invocation

Use `$evolve <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/evolve`, interpret that as this `$evolve` skill invocation while running in Codex.

## Command Instructions

# /evolve — 本能进化

分析已有本能与证据，找出可以聚类的相关模式，并将其提交为可审计的
`LearningCandidate`。本命令只负责发现、提案、评估与 shadow，不直接创建运行资产。

## Self-learning candidate gate

- 所有行为学习输出必须通过 canonical `scripts/self-learning.js` 进入 `propose`；通过评估后才可
  `evaluate`，且所有候选必须先进入 `shadow`。
- `--auto` 最多自动执行 `propose`、`evaluate` 和 `shadow`；不得执行 `approve`、`promote`，不得写
  skill / command / rule、agent、runtime manifest 或源本能 marker。
- `approve` 必须引用绑定当前 `candidate_hash` 的显式 `user.approval` 与 approval receipt；
  `promote` 仍是独立的人工治理动作。P0 的 promoted 只允许后续 resolver 读取，不等于安装或发布。
- confidence、聚类数量和重复次数只作为信号；不能替代 counterexample、TV、evaluation 或人工批准。

## 可选参数

- `--auto`：自动候选模式。允许聚类、`propose`、`evaluate`、`shadow`；禁止 `approve`、`promote`、
  publish、安装和任何 skill / command / rule 或 marker 写入。

## 执行步骤

### 1. 加载候选证据

从以下位置读取置信度 >= 0.5 的 legacy 本能作为待核验信号：
- `~/.codex/homunculus/projects/{project}/instincts/`
- `~/.codex/homunculus/instincts/personal/`

读取不表示信任或晋升。记录源文件 digest/provenance；缺少稳定来源、最终处置或反例检查时，
candidate 必须留在 `proposed` 或 `needs-review`。

### 2. 按域聚类

将本能按 `domain` 标签分组，找出同域内 3+ 个相关本能的组：

```
code-style 域 (5 个本能):
  - prefer-functional-style (0.75)
  - use-const-over-let (0.80)
  - avoid-class-components (0.65)
  - prefer-arrow-functions (0.55)
  - destructure-props (0.70)
→ 🎯 可聚类为 "代码风格规范" skill
```

### 3. 建议进化方案

对每个可聚类的组，分析最适合的进化形态：

| 候选形态 | 适合场景 | `target`（仅描述，不写入） |
|---------|---------|---------|
| **Skill** | 一组相关的行为规范/工作流 | `skill:<name>` |
| **Command** | 可以用 slash 命令触发的流程 | `command:<name>` |
| **Agent** | 需要专门子代理处理的复杂任务 | `agent:<name>` |
| **Rule** | 可能成熟为长期规则的经验 | `rule:<scope>/<name>` |

### 4. 生成候选内容

候选内容可以带以下 asset preview，但 preview 不是运行文件：

**Skill preview**:
```markdown
---
description: "自动生成的技能：[描述]"
evolved_from: ["instinct-id-1", "instinct-id-2", ...]
evolved_date: "YYYY-MM-DD"
---

# [技能名称]

## 何时触发
[综合所有源本能的触发条件]

## 行为规范
[综合所有源本能的行为指导]

## 来源证据
[列出各本能的关键证据]
```

**Command preview**:
```markdown
---
description: "[命令描述]"
evolved_from: ["instinct-id-1", "instinct-id-2", ...]
---

# /[命令名] — [描述]

[综合工作流步骤]
```

随后通过 canonical writer 执行 `propose`，返回并读回：

```text
candidate_id: <stable-id>
candidate_hash: <content-hash>
status: proposed
scope: <task|project|personal|global|team>
owner: <identity>
evidence_refs: [...]
counterexample_refs: [...]
```

候选通过独立 exam 后记录 hash-bound evaluation，再进入 `shadow`。候选内容不能自带 exam、
evaluation 结论或 approval receipt。

### 5. 输出报告

```
🧬 本能进化分析

发现 {n} 个可进化的聚类:

聚类 1: "代码风格规范" (5 个本能, 平均置信度 0.69)
  来源: prefer-functional-style, use-const-over-let, ...
  建议: → Skill candidate
  target: skill:coding-style-conventions（未写入）

聚类 2: "测试前置检查" (3 个本能, 平均置信度 0.72)
  来源: lint-before-test, typecheck-first, ...
  建议: → Rule candidate (target rule:project/testing-patterns，未写入)

是否为所选聚类创建 candidate proposal? (输入编号，或 'all')
```

### 6. 执行后

- 输出每个 `candidate_id`、`candidate_hash`、scope、owner、TV/反例缺口和 lifecycle 状态。
- `proposed`、`evaluated`、`shadow` candidate 不进入默认 runtime，不生成 asset 文件。
- 不写 `evolved_into`。只有独立 publish 在 hash-bound evaluation、显式 approval receipt、人工 `go`
  和发布 readback 全部成功后，才可把发布 receipt 对应路径写入源本能 marker。
- 若任一 evidence/candidate/evaluation 记录缺失、损坏或 identity/hash 不匹配，返回 `needs-review`
  并停止，不降级成直接写入。
