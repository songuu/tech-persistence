# agent-loop 架构问题诊断报告

> 基于 `实现 monorepo+Next 最新结构` 完整执行流程总结

## 环境信息

- **OS**: Windows 11 Home China 10.0.26200
- **Node**: v24.13.0
- **Codex**: codex-cli 0.125.0
- **Orchestrator**: `~/plugins/tech-persistence/scripts/agent-orchestrator.js`
- **工作目录**: `c:\project\my\demo2\` (空 git 仓库)

---

## 问题 1：Spec Provider 多轮对话而非单轮 JSON 输出

**现象**：Spec provider 输出了多轮 Markdown 格式的计划内容，而非符合 schema 的单轮 JSON。

**根因**：
- `claude -p` 在接收到包含 `--json-schema` 参数时，默认行为变成了多轮对话
- 模型没有遵循 schema 约束，而是输出了 Markdown 格式的 `plan` 对象
- `taskBreakdown` 被嵌套在 `plan.tasks` 中，而非顶层 `taskBreakdown` 数组

**影响**：Orchestrator 的 `normalizeSpec()` 无法解析出 `taskBreakdown`，报 `taskBreakdown must be a non-empty array`

**建议修复**：
1. Spec prompt 中明确要求模型**单轮输出 JSON**，不加任何 Markdown 包裹
2. 在 prompt 中提供 JSON 输出示例，确保输出是纯 JSON
3. 或者在 orchestrator 层面增加对 Markdown 包裹 JSON 的解析兼容

---

## 问题 2：`blocked` 状态不触发 Resume 重试

**现象**：Codex 因 sandbox 限制失败后，状态为 `blocked`。执行 `resume` 时，orchestrator 跳过 implementation provider，不重新执行。

**根因**：`runResume()` 函数的逻辑只处理 `frozen` 和 `needs-followup` 两种状态：

```javascript
// agent-orchestrator.js:1495
if (state.status === 'frozen' || state.status === 'needs-followup') {
  runImplementationProvider(state, statePath, runDir, options);
}
if (state.status === 'implemented') {
  runReviewProvider(state, statePath, runDir, options);
}
```

`blocked` 状态既不触发 implementation 也不触发 review，形成死锁。

**临时解法**：手动将 `state.json` 中的 `"status": "blocked"` 改为 `"status": "frozen"`

**建议修复**：
1. `blocked` 状态应该可以 resume 并重新执行 implementation
2. 或者在 `runResume()` 中增加对 `blocked` 状态的处理
3. 考虑增加 `--resume-from-blocked` 显式参数

---

## 问题 3：Review Prompt 超长导致 "Prompt is too long"

**现象**：Review provider 返回 `Prompt is too long` 错误，`stop_reason: blocking_limit`

**根因**：
- Spec 内容过于详细，包含大量实现细节
- Review prompt 将整个 spec、technical-design、task-breakdown 全部注入
- 单次输入 token 超出模型上下文限制

**临时解法**：精简 spec 内容，移除实现细节，只保留验收标准

**建议修复**：
1. 实现 `review-context.md` 的智能截断逻辑，只保留与实现相关的上下文
2. 对超长 prompt 进行分块处理或摘要压缩
3. 在 prompt 中明确告诉 model "如果超长，只关注关键验收点"

---

## 问题 4：Codex Windows Sandbox 写权限问题

**现象**：
1. 初始报错 `CreateProcessAsUserW failed: 1920` — elevated sandbox 无法创建进程
2. 修改 `sandbox = "off"` 后报错 `unknown variant off`
3. 修改 `sandbox = "unelevated"` 后，Codex 仍报告 "filesystem sandbox is read-only"
4. 文件写入操作被 policy 阻止

**根因**：
- Codex 在 Windows 上的 elevated sandbox 有系统级 bug
- `sandbox = "unelevated"` 虽然避免了 elevated 问题，但仍受 approval policy 限制
- `trust_level = "trusted"` 不足以覆盖 write 操作，需要显式 `sandbox_permissions`

**解决方案发现**：Codex CLI 支持 `-s workspace-write` 参数绕过 sandbox 限制

**关键发现**：
```bash
# -s workspace-write 模式可以成功执行写操作
codex exec -C C:/project/my/demo2 -s workspace-write -- "Write-Output test"
```

**Orchestrator 支持**：`--codex-sandbox workspace-write` 参数已在代码中实现（line 1047）

```javascript
if (optionValue(options, 'codex-sandbox')) args.push('--sandbox', optionValue(options, 'codex-sandbox'));
```

**问题**：这个参数没有在 doctor/self-test 中验证，也没有文档说明默认值。

**建议修复**：
1. 在 doctor 中检查 Windows 环境下是否需要 `--codex-sandbox workspace-write`
2. 为 Windows 环境自动注入 `--codex-sandbox workspace-write` 默认值
3. 在 doctor 输出中明确提示 Windows 用户可能需要的 sandbox 配置

---

## 问题 5：Review Normalize 逻辑 bug — `summary: "APPROVED"` 未被识别

**现象**：Codex implementation 成功，raw review 输出 `summary: "APPROVED"`（非标准格式），但 `normalizeReview()` 将其映射为 `decision: "changes_requested"` 而非 `decision: "approved"`。

**根因**：`normalizeReview()` 的决策逻辑：

```javascript
// 只检查 raw.decision 或 explicitDecision，不检查 raw.summary
if (raw.compliant === true || explicitDecision === 'approved') {
  decision = 'approved';
} else if (explicitDecision === 'blocked' || status === 'blocked' || hasBlockingFinding) {
  decision = 'blocked';
}
```

`summary: "APPROVED"` 不是 `decision` 字段，不在判断条件中。

**临时解法**：手动将 `state.json` 中的 `"status": "needs-followup"` 改为 `"status": "completed"`

**建议修复**：
1. `normalizeReview()` 增加对 `raw.summary` 的兼容（如包含 "APPROVED"、"approved"、"pass" 等关键词时映射为 `approved`）
2. 或者要求 implementation/review provider 严格输出标准 schema

---

## 问题 6：`--allow-dirty` 未自动传递导致 worktree 检查失败

**现象**：Codex 实现成功后（有 untracked 文件），再次 resume 时报错 `Implementation requires a clean git worktree`。

**根因**：Codex 写入了 `.next` 构建目录等 untracked 文件，orchestrator 的 worktree clean 检查失败。

**临时解法**：使用 `--allow-dirty` 参数

**建议修复**：
1. 检测到状态为 `implemented` 且 worktree dirty 时，自动使用 `--allow-dirty`
2. 或者在 `runResume()` 中检查 if implementation 已有 output（handoff/diff 存在），则跳过 clean check

---

## 问题 7：doctor 不检查 Codex Sandbox 配置

**现象**：doctor 输出 `gitRepository: not a git repository`（已修复）和 `codexHandoffSchemaStrict: [OK]`，但没有检查 Codex 的 sandbox 模式是否与 Windows 环境兼容。

**建议修复**：在 doctor 中增加：
1. 检测 Windows 环境
2. 检查 `~/.codex/config.toml` 中 `[windows] sandbox` 配置
3. 如果是 `elevated` 且不是 trusted 项目，提示可能需要 `unelevated` 或 `workspace-write`

---

## 问题 8：Provider Run 日志文件时间戳覆盖

**现象**：同一个 run 多次执行 implementation/review 时，logs 目录下的 `implementation.stdout.log` 和 `implementation.last-message.json` 被覆盖，无法追溯历史执行记录。

**建议修复**：
1. 每次 provider run 使用带时间戳的日志文件名
2. 或者在 `providerRuns` 数组中记录每次的 stdout/stderr 文件路径

---

## 问题 9：状态机流转不清晰

**现象**：执行过程中状态流转 `draft → frozen → blocked → needs-followup → completed`，但某些转换需要手动干预（修改 state.json）。

**建议修复**：
1. 增加 `orchestrator status --verbose` 显示完整状态机历史
2. 增加 `orchestrator retry --run <id>` 专门用于从 blocked/失败状态重试
3. 文档中明确说明哪些状态可以 resume，哪些需要手动干预

---

## 总结：优先级排序

| 优先级 | 问题 | 影响 |
|--------|------|------|
| P0 | `blocked` 状态不重试 | 阻塞完整流程 |
| P0 | Review normalize 不识别 `summary: "APPROVED"` | review 通过但状态错误 |
| P1 | Windows Codex sandbox 需要 `workspace-write` | Windows 用户无法执行 |
| P1 | Review prompt 超长 | 无法完成 review |
| P2 | `--allow-dirty` 未自动处理 | 重复执行失败 |
| P2 | Spec provider 多轮输出非 JSON | 需要手动修复 spec |
| P3 | doctor 不检查 sandbox 配置 | 用户不知需要配置 |
| P3 | 日志文件覆盖 | 调试困难 |

---

## 完整解决方案

### 目标

这批问题不要继续靠手动修改 `state.json`、手动精简 prompt、手动追加 `--allow-dirty` 来绕过。目标是把 `agent-loop` 做成一个可恢复、可诊断、跨 Windows/Codex/Claude 差异稳定运行的编排器：

1. Provider 原始输出永远先进入 `StructuredOutputCodec` 和 `ContractNormalizer`，状态机只消费 canonical model。
2. 状态流转必须可恢复：`blocked`、`needs-followup`、`implemented` 都有明确 resume 行为。
3. Windows 下 Codex sandbox 使用安全默认值，用户不需要记住隐藏参数。
4. Review 上下文有大小预算，不把完整大 diff 或 lockfile 塞进 prompt。
5. 每次 provider run 都有独立日志，`state.providerRuns[]` 能追溯历史。

### P0 修复包：先消除手动干预

#### 1. Spec 输出兼容层

**方案**：增强 `normalizeSpec()`，支持以下常见输出形态：

```text
taskBreakdown
tasks
implementationTasks
plan.taskBreakdown
plan.tasks
plan.implementationTasks
```

`requirementSpec`、`technicalDesign` 也要同样支持 `plan.requirements`、`plan.design` 等 alias。这样即使 Spec provider 输出了带 Markdown/JSON wrapper 的 `plan` 对象，也能归一化为 canonical spec。

**落地文件**：
- `scripts/agent-orchestrator.js`
- `plugins/tech-persistence/scripts/agent-orchestrator.js`

**验收**：
- `self-test` 覆盖 `plan.tasks`。
- 遇到 `plan.tasks` 不再报 `taskBreakdown must be a non-empty array`。

#### 2. `blocked` 可恢复

**方案**：`runResume()` 的 implementation 入口状态从：

```text
frozen | needs-followup
```

扩展为：

```text
frozen | needs-followup | blocked
```

含义：
- `frozen`：第一次实现，要求 clean worktree。
- `needs-followup`：review 要求修改，允许在已有实现 diff 上继续。
- `blocked`：上一次执行被 review P0 或运行环境阻断，允许重新进入 implementation，不再死锁。

**验收**：
- `state.status = "blocked"` 时执行 `resume` 会重新调用 implementation provider。
- 不再需要手动把 `blocked` 改成 `frozen`。

#### 3. Review 通过信号归一化

**方案**：`normalizeReview()` 的 approved 判定支持：

```text
decision: "approved"
compliant: true
status: "passed" | "pass" | "approved"
canMerge: true 且 issues 为空
summary: "APPROVED" | "PASS" | "PASSED" 且 issues 为空
```

同时 `blocked` / P0 finding 优先级最高，避免 provider 同时输出矛盾信号时误放行。

**验收**：
- `summary: "APPROVED"` 映射为 `decision: "approved"`。
- `statusFromReview()` 返回 `completed`。
- review 真通过但状态为 `needs-followup` 的问题消失。

### P1 修复包：让 Windows 和长 prompt 默认可用

#### 4. Windows Codex sandbox 默认值

**方案**：新增 `codexSandboxMode()`：

```text
显式 --codex-sandbox <mode> -> 使用用户指定值
Windows 且未显式指定 -> workspace-write
非 Windows 且未显式指定 -> 不传 sandbox 参数
```

doctor 输出新增 `codexSandbox` 检查，告诉用户当前生效模式和默认原因。

**验收**：
- Windows 下 implementation provider 自动带 `--sandbox workspace-write`。
- `doctor` 能显示 sandbox 生效策略。
- 用户仍可通过 `--codex-sandbox default` 回到 Codex 默认行为。

#### 5. Review context 预算化

**方案**：保留 `changed-files.json`、`diff.patch`、`review-context.md` 三层 artifact：

- `changed-files.json`：完整变更清单。
- `diff.patch`：过滤 `.agent-runs`、`node_modules`、`.next`、lockfile 等 generated/oversized 文件。
- `review-context.md`：只内联有预算上限的 diff，超限时提示 reviewer 直接 inspect repository files。

下一步还要给 `spec.json` 和 `technical-design.md` 做 review 注入预算，避免 spec 本身过长导致 `Prompt is too long`。

**验收**：
- lockfile 不进入 review inline diff。
- `review-context.md` 超限时明确写入截断说明。
- review prompt 不再因 Windows argv 长度失败；provider prompt 走 stdin。

### P2 修复包：提升可观测性和重复执行体验

#### 6. Dirty worktree 处理策略

**方案**：

- 第一次从 `frozen` 进入 implementation 时仍要求 clean worktree，避免把用户未提交改动混入 agent diff。
- 从 `needs-followup` 或 `blocked` 继续实现时，允许已有 dirty worktree，因为这些变更就是上一轮实现上下文。
- managed artifacts 永远排除：`.agent-runs/`、`node_modules/`、`.next/`、`dist/`、`build/`、`coverage/`。

**验收**：
- review 后继续修复不会因为上一轮实现文件 dirty 而失败。
- 第一次实现前仍能拦住无关 dirty worktree。

#### 7. Provider run 日志不覆盖

**方案**：provider 日志文件名加时间戳：

```text
logs/spec.<timestamp>.stdout.log
logs/spec.<timestamp>.stderr.log
logs/implementation.<timestamp>.stdout.log
logs/implementation.<timestamp>.stderr.log
logs/implementation.<timestamp>.last-message.json
logs/review.<timestamp>.stdout.log
logs/review.<timestamp>.stderr.log
```

`state.providerRuns[]` 记录每次 run 的 stdout/stderr/last-message 路径、resolved command、cwd、exit code、stdin bytes。

**验收**：
- 同一个 run 多次 resume 不覆盖旧日志。
- 可以按 `providerRuns[]` 还原每次 provider 调用。

#### 8. 状态可视化与 retry 命令

**方案**：下一步补两个非破坏性 CLI：

```bash
node scripts/agent-orchestrator.js status --run <runId> --verbose
node scripts/agent-orchestrator.js retry --run <runId>
```

`status --verbose` 展示 `providerRuns[]`、最近 review decision、validation 状态、follow-up task 路径。`retry` 是 `resume` 的语义化别名，专门用于 `blocked` / provider failure 后重跑。

**验收**：
- 用户不用打开 `state.json` 就能知道下一步该 `freeze`、`resume`、`retry` 还是看日志。

### 推荐落地顺序

1. **先合入 P0/P1 核心修复**：`plan.tasks`、`blocked resume`、`summary: APPROVED`、Windows `workspace-write` 默认值、provider 日志时间戳。
2. **补自测覆盖**：`node scripts/agent-orchestrator.js self-test` 必须覆盖 normalizer、codec、schema strictness。
3. **跑 doctor**：`node scripts/agent-orchestrator.js doctor`，确认 provider、schema、sandbox、runDir 写权限。
4. **做一次最小真实回归**：用小需求跑 `run -> freeze -> resume -> review`，确认状态能到 `completed`。
5. **再补体验增强**：`status --verbose`、`retry`、review spec 摘要预算、schema compatibility test。

### 本轮已落地

已在项目脚本和插件副本中同步：

- `normalizeSpec()` 支持 `plan.tasks` / `plan.design` / `plan.requirements`。
- `normalizeReview()` 支持 `summary: "APPROVED"`，且 P0/blocked 优先级高于 approved。
- `runResume()` 支持从 `blocked` 重新进入 implementation。
- follow-up / blocked continuation 不再强制 clean worktree。
- Windows 下 Codex 默认注入 `--sandbox workspace-write`，可用 `--codex-sandbox default` 覆盖。
- `doctor` 输出 `codexSandbox` 检查项。
- provider stdout/stderr/last-message 日志使用时间戳，避免覆盖。
- `self-test` 增加 `plan.tasks` 与 `summary: APPROVED` 回归覆盖。

### 仍需后续补齐

- `status --verbose` 和 `retry` 命令。
- review prompt 中 `spec.json` / `technical-design.md` 的摘要预算。
- 独立单元测试文件，替代目前集中在 `self-test` 的轻量回归。
- 安装/发布流程中的 schema compatibility test。
- 全局用户已安装插件需要重新安装或发布后，才能拿到 `plugins/tech-persistence` 副本之外的修复。

---

## 附录：Windows 环境配置检查清单

```toml
# ~/.codex/config.toml
[windows]
sandbox = "unelevated"  # 不使用 elevated（elevated 有 bug）

[projects.'c:\project\my\demo2']
trust_level = "trusted"
sandbox_permissions = ["disk-full-read-access", "disk-full-write-access", "allow-all-runner-commands"]
```

Resume 命令：
```bash
node scripts/agent-orchestrator.js resume --run <runId> --codex-sandbox workspace-write --allow-dirty
```
