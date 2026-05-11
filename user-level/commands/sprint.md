---
description: "全流程冲刺：think→plan→work→review→compound，含上下文 checkpoint 和恢复"
---

# /sprint — 全流程冲刺

一个命令驱动完整的 Plan→Work→Review→Compound 循环。
**支持上下文 checkpoint：长任务不怕上下文溢出。**

## 用法
```
/sprint <需求描述>       ← 新 sprint
/sprint --caveman <需求> ← 新 sprint，启用 token 压缩模式
/sprint --auto <需求>    ← 新 sprint，启用自动审查模式
/sprint resume           ← 从最近的 checkpoint 恢复
/sprint resume --caveman ← 从 compact handoff 优先恢复
/sprint resume --auto    ← 恢复并启用自动审查
```

`--caveman` 与 `--auto` 可组合：`/sprint --caveman --auto <需求>`。

Codex 中同义：

```text
$sprint <需求描述>
$sprint --caveman <需求描述>
$sprint --auto <需求描述>
$sprint resume --caveman
$sprint resume --auto
```

## 可选参数

- `--caveman`：输出 token 压缩，详见下方 Caveman Token Budget Mode。
- `--auto`：自动审查模式。Phase 1-4 间的 'go' gate 由模型按风险等级 / 用户行为 / 置信度自主判断；强制人工的边界（destructive、L4、scope creep、P0 不平凡修复）仍保留。详见 `~/.claude/rules/auto-mode.md`。

## 项目文档贯穿全流程

整个 sprint 共用一个文档。路径：`docs/plans/YYYY-MM-DD-<需求简写>.md`

```
Phase 1 → 创建文档，填写「需求分析」     → status: draft
Phase 2 → 填写「技术方案」「任务拆解」    → status: planning
Phase 3 → 逐步勾选任务，追加变更日志      → status: in-progress
  ⚡ checkpoint → 生成 handoff 文件       → status: checkpoint-N
  恢复 → 继续 work                       → status: in-progress
Phase 4 → 填写「审查结果」               → status: reviewing
Phase 5 → 填写「复利记录」               → status: completed
```

## Caveman Token Budget Mode

触发方式：
- 用户显式写 `$sprint --caveman ...`
- 用户在 sprint 请求中说“压缩 token / less tokens / caveman / 简短”
- 当前会话已启用 `$caveman`，且用户没有要求完整展开

核心原则：

| 层 | 策略 |
|---|---|
| 对话输出 | `caveman-lite` 或 `caveman-full`，只报决策、风险、下一步 |
| sprint 主文档 | `artifactMode=complete`，完整保留 scope、验收、任务、测试、审查 |
| checkpoint | 同时生成完整 handoff 和 compact handoff |
| resume | `compact-first`：先读 compact handoff，不足时再读完整 sprint 文档 |
| review | findings 用一行式格式：`文件:行: severity: 问题。修复。` |
| compound | 对话只报数量和路径，完整经验写入 rules/solutions |

禁止压缩：
- `docs/plans/*.md` 主 sprint 文档
- 架构决策、验收标准、测试策略、P0/P1 审查依据
- 安全警告、不可逆操作确认、复杂迁移步骤
- 代码块、命令、文件路径、错误原文

允许压缩：
- 阶段汇报
- 中间状态
- checkpoint/resume 摘要
- review finding 展示
- compound 收尾报告

compact handoff 文件：

```text
docs/plans/YYYY-MM-DD-xxx-handoff-N.md          # 完整交接
docs/plans/YYYY-MM-DD-xxx-handoff-N-compact.md  # 压缩恢复摘要
```

compact handoff 必须包含：

```markdown
# Compact Handoff

Sprint: <名称>
Progress: <完成数>/<总数>
Next: <下一步>
Changed: <文件列表>
Decisions: <关键决策，最多 5 条>
Validation: <命令 + 结果>
Risks: <未关闭风险>
Need full doc if: <何时必须回读完整 sprint 文档>
```

阶段输出预算：

```text
Think: scope / non-scope / success / risks，各 1-3 条
Plan: 任务表 + 验证策略，不展开实现细节
Work: 只报 Task delta、测试结果、阻塞项
Review: 只报 P0/P1；P2 写入文档，不默认展开
Compound: 只报沉淀数量、路径、是否建议 compact
```

如果用户要求“完整版本 / 完整架构 / 从源头看”，临时退出 caveman 输出压缩；完整说明后再恢复 compact mode。

## 执行流程

### Phase 1: Think (暂停确认)
```
Phase 1/5: Think
[执行 /think，输出范围定义]
[创建 docs/plans/YYYY-MM-DD-xxx.md，填写需求分析]
→ 'go' 进入 Plan | 修改意见调整 | 'skip' 跳过
```

Auto mode：scope 明确、无开放问题且与原始需求无 scope creep 时直接进入 Plan，并打印 `✓ auto: phase 1 → 2`；否则保留人工 gate。

Caveman mode 输出：

```text
Scope: ...
Non-scope: ...
Success: ...
Risks: ...
Next: go -> Plan
```

### Phase 2: Plan (暂停确认)
```
Phase 2/5: Plan
[执行 /plan，输出实现计划]
[填写文档的技术方案、任务拆解]
[如果 Task > 5 个，预告：将在 Task 5 后自动 checkpoint]
→ 'go' 进入 Work | 修改意见调整
```

Auto mode：任务数 ≤ 8 且无 L3/L4 task、无明显 scope 不一致时直接进入 Work；否则保留人工 gate。打印 `✓ auto: phase 2 → 3` 或 `⚠ manual gate kept: phase 2 — <原因>`。

Caveman mode 输出只展示任务表和验证策略；完整方案写入 sprint 文档，不在对话中重复。

### Phase 3: Work (含自动 checkpoint)
```
Phase 3/5: Work
[执行 /work，按计划逐步实现]
[每个 Task：实现 → 风险评估 → 按等级测试 → 勾选文档 checkbox]

⚡ 每 5 个 Task 自动检查是否需要 checkpoint:
  ├── 无退化信号 → 继续
  └── 有退化信号 或 已完成 5 个 Task → 建议 checkpoint:
      "⚡ 建议 checkpoint — 已完成 5/8 Task，上下文压力较大
       执行 /checkpoint 保存状态，然后 /compact
       下次 /sprint resume 恢复"

退化信号检测：
  - 工具调用参数出错增多
  - 忘记了 Phase 1/2 中确认的约定
  - 回答变得笼统
  - 会话轮次 > 30
```

Caveman mode 中，每个 Task 完成只输出：

```text
Done: Task N
Changed: <files>
Risk: Lx
Test: <command> -> pass/fail/skipped
Next: Task N+1
```

达到 checkpoint 条件时必须生成 compact handoff，并提示先 `/compound` 再 `/compact`。

### Phase 3 恢复（从 checkpoint）
```
/sprint resume

📋 检测到 Checkpoint:
  Sprint: 用户导出功能
  文件: docs/plans/2026-06-20-user-export-handoff-1.md
  进度: 5/8 Task
  下一步: Task 6 — 异步大文件导出

  3 个关键决策已加载。继续？
→ 'go' 继续 Task 6
```

恢复时做的事：
1. 如果是 caveman mode，先读取最新 `*-handoff-*-compact.md`
2. compact 信息不足时，读取完整 handoff 和 sprint 主文档
3. 读取相关测试文件 → 确认测试状态
4. 从下一个未完成 Task 继续

### Phase 4: Review (暂停确认)
```
Phase 4/5: Review
[执行 /review，多视角审查]
[审查报告写入文档]
→ P0 自动修复 → P1 确认 → 'go' 进入 Compound
```

Auto mode：obvious P0（typo / 缺 import / null check）自动修复并继续；语义级 P0、destructive 改动、L4 任务相关 P0 仍保留人工 gate。P1 默认跳过确认进入 Compound；P0 强制项必须问。

Caveman mode review 展示：

```text
P0:
- path:line: bug/risk: problem. fix.
P1:
- path:line: risk/nit: problem. fix.
```

完整审查表仍写入 sprint 文档。

### Phase 5: Compound (自动执行)
```
Phase 5/5: Compound
[执行 /compound]
[填写文档复利记录，status → completed]
[sprint 文档的 frontmatter 添加 Obsidian tags]

🏁 Sprint 完成！
  文档: docs/plans/2026-06-20-xxx.md
  Checkpoints: N 次
  知识: M 条经验, K 个本能, J 个 skill 信号
  Auto mode: A gates 自动通过 / M gates 强制人工（仅当启用 --auto 时显示）
```

Caveman mode 收尾：

```text
Done: sprint completed
Doc: <path>
Knowledge: <N rules>, <M instincts>, <K signals>
Compact: yes/no + reason
```

## Phase 间预热协议

每个 Phase 报告末尾**必须**追加「下一 Phase 预热」段，让用户 'go' 时模型上下文已就绪，节省 N→N+1 切换的探索往返。

### 预热段格式（强制）

```text
## 下一 Phase 预热（Phase N+1: <名称>）
关键文件: <1-3 个 N+1 必读路径>
执行命令: <1-2 个 N+1 起步探索命令>
风险预判: <1-3 行 N+1 潜在风险或注意点>
```

### 各 Phase 预热典型内容

| 当前 Phase | 下一 Phase | 典型关键文件 | 典型起步命令 |
|-----------|-----------|------------|------------|
| Think → Plan | Plan | `docs/plans/TEMPLATE.md`、相关 `rules/*.md` | `Grep` 相关 ADR、`Glob` 待改文件 |
| Plan → Work | Work | 计划列出的最高优先级文件 | 跑当前测试基线、读关键模块 |
| Work → Review | Review | `git diff` 输出、新增测试文件 | `git diff <base>...HEAD`、检查测试通过 |
| Review → Compound | Compound | sprint 文档的 review 段 | 读 P0/P1 处理记录、扫 rules/ 是否需更新 |
| Compound → 收尾 | （无下一 phase）| sprint 文档 frontmatter | 检查 status: completed、是否需 /compact |

### 设计原则

- ✅ 仅提示线索，不预先执行下一 phase 的操作
- ✅ 每段 ≤ 3 行，信息密度优先
- ✅ Caveman mode 也保留（密度高不浪费 token）
- ❌ 不复述当前 phase 的结论
- ❌ 不预先调用 LLM 生成下一 phase 的产物
- ❌ 不修改任何文件，纯文本提示

预热段失败（如无法确定下一 phase 关键文件）时，输出 `预热: 跳过 — <原因>` 即可，不阻塞流程。

## Sprint 文档 frontmatter（Obsidian 兼容）

```yaml
---
title: "用户导出功能"
type: sprint
status: completed
created: "2026-06-20"
updated: "2026-06-21"
checkpoints: 1
tasks_total: 8
tasks_completed: 8
tags: [sprint, feature]
aliases: ["用户导出"]
---
```

## 适用场景
- 中到大型功能开发
- 需要完整规划-实现-审查-学习流程
- 长任务（8+ Task）自动 checkpoint 保证不丢失进度

## 不适用
- 小 bug → 直接修 → /compound
- 探索调研 → 自由对话 → /learn
