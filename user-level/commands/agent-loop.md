---
description: "v6 外部编排器：claude 产出冻结 spec，codex 按 spec 执行，claude 复审"
---

# /agent-loop — v6 外部 Agent 编排

v6 的主路径不是让两个 Agent 在各自命令里理解彼此，而是由外部 orchestrator 调用 provider：

1. `claude -p` 只负责需求分析、技术设计、任务拆解。
2. 人类 review 后 freeze spec。
3. `codex exec` 只按冻结 spec 实现，并产出 diff、validation、handoff。
4. `claude -p` 只按冻结 spec 做验收复审。
5. 若复审不通过，orchestrator 把 review notes 转成 follow-up task，再交给 `codex exec`。

## 用法

```bash
/agent-loop <原始需求>
/agent-loop --auto <原始需求>
/agent-loop freeze <runId>
/agent-loop resume <runId>
/agent-loop resume --auto <runId>
/agent-loop status [runId|latest]
/agent-loop doctor
/agent-loop self-test
```

Codex 中使用同名 skill：

```bash
$agent-loop <原始需求>
$agent-loop --auto <原始需求>
$agent-loop freeze <runId>
$agent-loop resume <runId>
$agent-loop status [runId|latest]
$agent-loop doctor
$agent-loop self-test
```

## 可选参数

- `--auto`：自动审查模式。orchestrator 在 spec 通过自校验（required 字段齐全、`questions: []` 为空、`assumptions` 不阻塞、acceptance 与 scope 不冲突）时自动 `freeze` 并继续 implementation + review；否则保留人工 freeze gate。review 通过即 `completed`；review 不通过仍按 follow-up 流程，不会绕过 P0。详见 `~/.claude/rules/auto-mode.md`。

## 一致性保障

- Claude Code 的 `/agent-loop` 与 Codex 的 `$agent-loop` 必须调用同一个 orchestrator。
- orchestrator 会自动解析 Windows npm shim，例如 `claude.cmd` 和 `codex.cmd`，不要求用户手动传真实 `.exe`。
- spec、implementation、review prompt 都通过 stdin 或 artifact 文件传输，避免 Windows argv 过长。
- provider 原始输出必须先归一化为 canonical spec / handoff / review，再驱动状态机。
- 如果 provider 或 schema 预检失败，先运行 `doctor`，不要手工绕过状态机。
- 修改 orchestrator 后运行 `self-test`，它不调用外部 provider，只验证 codec / normalizer / schema 基础契约。

## 执行规则

### Doctor

当参数为 `doctor` 时运行：

```bash
node scripts/agent-orchestrator.js doctor
```

### Self-Test

当参数为 `self-test` 时运行：

```bash
node scripts/agent-orchestrator.js self-test
```

### 新需求

当参数不是 `freeze`、`resume`、`status`、`doctor`、`self-test` 时：

1. 优先使用当前项目的 `scripts/agent-orchestrator.js`。
2. 如果当前项目没有该脚本，查找 `~/plugins/tech-persistence/scripts/agent-orchestrator.js`。
3. 运行：

```bash
node scripts/agent-orchestrator.js run --requirement "$ARGUMENTS"
```

不要默认传 `--auto-freeze`。spec 必须先给用户 review。

若用户传了 `--auto`，模型先把 `<原始需求>` 中的 `--auto` 移除，然后追加 `--auto-evaluate`：

```bash
node scripts/agent-orchestrator.js run --requirement "<去掉 --auto 的需求>" --auto-evaluate
```

`--auto-evaluate` 让 orchestrator 在 spec 通过自校验时自动 freeze + resume；不通过则停在 `spec-ready` 等待人工 freeze。模型在追加该 flag 前必须确认本会话当前不属于 destructive / 高风险场景。

如果只想检查本机环境而不调用 provider，运行：

```bash
node scripts/agent-orchestrator.js doctor
```

### Freeze

当参数形如 `freeze <runId>` 时运行：

```bash
node scripts/agent-orchestrator.js freeze --run <runId>
```

只在用户明确认可 spec 后执行。

### Resume

当参数形如 `resume <runId>` 时运行：

```bash
node scripts/agent-orchestrator.js resume --run <runId>
```

如果用户给了验证命令，追加：

```bash
--validation-command "<command>"
```

验证命令可以重复传入多次。validation 由 orchestrator 执行并写入 `validation.json`，provider handoff 里的 validation 只作为说明。

可选拆分人工 gate 的开关：

- `--no-review`（同义 `--implementation-only`）：只跑实现，停在 `implemented`，让用户手动检查后再次 `resume`。
- `--review-only`：跳过实现 provider，只对当前 handoff 跑复审。常用于已有 `implemented` 状态、想重跑复审的场景。

恢复时若状态为 `completed`/`failed`/`dry-run`，orchestrator 会打印状态并直接返回；不要重复触发 provider。

### Status

当参数形如 `status` 或 `status <runId>` 时运行：

```bash
node scripts/agent-orchestrator.js status --run <runId|latest>
```

## 文件契约

每次运行写入 `.agent-runs/<runId>/`：

- `state.json`: orchestrator 状态机（`status`、`specFrozenAt`、`providerRuns[]`、`files`）。
- `requirement.md`: 用户原始需求。
- `commands.json`: 本次 run 解析出的 provider 启动命令快照。
- `spec.json`: 冻结前的结构化需求契约（normalized）。
- `spec.raw.json`: spec provider 原始未归一化输出，用于排查归一化差异。
- `requirement-spec.md`: 给人 review 的 spec。
- `technical-design.md`: 技术设计。
- `task-breakdown.json`: 实现任务。
- `changed-files.json`: 过滤 managed artifacts 后的变更清单。
- `diff.patch`: codex 实现后的 diff（含 untracked synthetic diff）。
- `review-context.md`: review provider 使用的截断安全上下文。
- `validation.json`: 验证结果（`status`/`commands[]`，包含每条命令 stdoutFile/stderrFile）。
- `handoff.md`: 实现交接（人类可读）。
- `handoff.json`: canonical 实现交接（normalized）。
- `handoff.parse-error.json`: handoff JSON 解析失败时记录原始 stdout/last-message 文件位置。
- `review.json`: 验收复审（normalized）。
- `review.raw.json`: provider 原始 review 输出。
- `review.parse-error.json`: review JSON 解析失败时记录原始 stdout/stderr 文件位置。
- `preflight.json`: 本机 provider/schema/workdir 预检。
- `follow-up-task.md`: 复审不通过时生成（含 findings 行式格式：`[severity] file:Lline: message — fix: ...`）。
- `prompts/{spec,implement,review}.md`: 发给各 provider 的最终 prompt 文本。
- `logs/{spec,implementation,review,validation-N}.<timestamp>.{stdout,stderr}.log`: 带时间戳的 provider 与 validation 日志，多次 resume 不互相覆盖。

## 核心原则

- 分析 provider 不写代码。
- 实现 provider 不重新解释需求。
- freeze 前不进入实现。
- review provider 只对照冻结 spec，不新增产品范围。
- orchestrator 负责状态、日志、重试、恢复、diff 和 validation。
- `.agent-runs/`、`node_modules/`、构建产物等 managed artifacts 不参与 clean worktree 阻塞。
- review 真通过时状态必须是 `completed`；`status: passed` / `canMerge: true` 等同义输出必须被归一化。
