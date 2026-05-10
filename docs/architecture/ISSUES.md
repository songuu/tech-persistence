# agent-loop 问题总结

## 执行概况

- **runId**: `20260429085918-使用-turborepo-构建-next-js-最新结构的-monorepo-项目-n-使用-p`
- **目标**: 使用 Turborepo + pnpm 构建 Next.js 15 monorepo
- **最终状态**: `completed` ✓

---

## 问题列表

### 问题 1: 非 Git 仓库导致 preflight 失败

**错误信息**
```
[FAIL] Preflight failed: gitRepository: not a git repository
```

**原因**
项目目录不是 git 仓库，orchestrator 的 `gitRepository` 检查不通过。

**解决**
```bash
git init && git config user.email "demo@example.com" && git config user.name "Demo"
```

**建议**
- orchestrator 接受 `--skip-git-repo-check` flag，但该 flag 未正确阻止检查
- 预检逻辑应允许 codex 的 `--skip-git-repo-check` 覆盖 git 检查要求

---

### 问题 2: Claude Code Windows 缺少 git-bash 配置

**错误信息**
```
Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win).
If installed but not in PATH, set environment variable:
CLAUDE_CODE_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe
```

**原因**
Claude Code 在 Windows 上执行 git 操作需要 bash.exe，但 PATH 中检测不到。

**解决**
```bash
CLAUDE_CODE_GIT_BASH_PATH="C:\Apps\Git\usr\bin\bash.exe" node scripts/agent-orchestrator.js run ...
```

**建议**
- 持久化方案：在 `~/.bashrc` 或系统环境变量中添加 `CLAUDE_CODE_GIT_BASH_PATH`
- 长期：orchestrator 应自动检测 Git Bash 路径，无需用户手动设置

---

### 问题 3: spec provider 输出格式与 schema 不匹配（核心问题）

**现象**
- `spec.raw.json` 中有完整的结构化数据（6 tasks、fileIndex、reviewCriteria）
- 但 `spec.json` 中所有字段为空：`summary: ""`, `taskBreakdown: [{}]`

**原因**
spec provider（Claude）输出了自定义格式 `agent-loop-v6-spec`：

```json
{
  "format": "agent-loop-v6-spec",
  "taskBreakdown": { "tasks": [...] }   // ❌ 嵌套层级错误
}
```

而 orchestrator 的 normalizer 期望：

```json
{
  "taskBreakdown": [...]                // ✅ 扁平数组
}
```

**根因分析**
1. orchestrator prompt 未明确强调必须输出扁平 schema
2. normalizer 的别名链 `raw.taskBreakdown || raw.tasks || raw.implementationTasks` 无法覆盖嵌套的 `taskBreakdown.tasks`
3. 自定义格式使用 `taskBreakdown.tasks` 而标准格式期望 `taskBreakdown` 直接是数组

**解决**
手动从 `spec.raw.json` 提取内容，修复 `spec.json`、`task-breakdown.json`、`requirement-spec.md`：

```javascript
// spec.json 中 taskBreakdown 修复
{
  "taskBreakdown": spec.raw.taskBreakdown.tasks.map((t, i) => ({
    id: t.id || `T${i+1}`,
    title: t.title,
    description: t.description,
    dependencies: t.dependencies || [],
    risk: t.risk || "L2",
    doneCriteria: t.doneCriteria || [],
    suggestedValidation: t.suggestedValidation || []
  }))
}
```

**建议**
- **短期**：spec provider prompt 中增加 `"必须输出扁平 JSON，taskBreakdown 必须是 Task[] 数组"`
- **中期**：normalizer 增加对 `taskBreakdown.tasks` 嵌套格式的兼容
- **长期**：统一使用严格 schema validation + 清晰的格式规范文档

---

### 问题 4: 第一轮实现为空操作（no-op）

**原因**
问题 3 导致 `spec.json` 为空，codex 收到的 implement prompt 中 frozen spec 内容为空，执行了最小安全操作（no-op）。

**现象**
- `diff.patch` 为空
- `review.json`: `{ decision: "changes_requested", compliant: false }`

**解决**
修复 `spec.json` 后重新 `resume`，第二轮 codex 正确实现全部 43 个文件。

---

### 问题 5: background task 超时但状态实际推进

**现象**
`resume` 以 background 方式运行，超时后 `TaskOutput` 返回 timeout，但状态实际已推进到 `implemented`。

**原因**
codex 实现耗时较长（~18 分钟），远超默认 timeout。

**建议**
- 增加 `--timeout` 参数支持
- 或在 status 输出中明确 "running in background, check status later"

---

## 根本原因：schema 契约不清晰

| 维度 | 预期 | 实际 |
|------|------|------|
| spec provider 输出 | 匹配 `requirement-spec.schema.json` 的扁平结构 | 自定义嵌套格式 `agent-loop-v6-spec` |
| taskBreakdown 格式 | `Task[]` 数组 | `{ tasks: Task[] }` 对象 |
| schema 约束 | 强制校验 | `additionalProperties: true` 放行 |

**修复优先级**

1. **P0**: spec provider prompt 增加格式约束（必须扁平 JSON）
2. **P1**: normalizer 增加嵌套格式兼容（`taskBreakdown.tasks` → `taskBreakdown`）
3. **P1**: Windows 环境变量自动检测（git-bash path）
4. **P2**: background task 超时处理改进

---

## 完整解决方案

### 目标状态

这批问题的核心不是“某一次 run 出错”，而是 agent-loop 的外部编排器还缺少几类运行时容错：

- preflight 必须区分硬失败、可显式跳过、以及 warning。
- Claude/Codex 的 Windows 运行依赖必须由 provider adapter 自动补齐。
- Spec normalizer 必须兼容 provider 的常见嵌套输出，但 canonical artifact 仍保持扁平。
- 长耗时 provider run 必须有可配置 timeout 和可追溯日志。

目标是让用户只需要决定业务需求和 freeze 点，不再手动修 `spec.json`、手动导出 Git Bash 环境变量、手动初始化 Git 才能越过 preflight。

### P0：Spec 契约收敛

#### 方案

Spec provider prompt 明确要求：

```text
Return one top-level JSON object only.
taskBreakdown must be a top-level Task[] array, not { "tasks": [...] }.
```

同时 `normalizeSpec()` 增加兼容层：

```text
taskBreakdown
tasks
implementationTasks
plan.taskBreakdown
plan.tasks
plan.implementationTasks
taskBreakdown.tasks
taskBreakdown.items
```

注意：兼容层只在 normalizer 中存在，写出的 `spec.json` 和 `task-breakdown.json` 仍必须是 canonical 扁平结构。

#### 代码落点

- `scripts/agent-orchestrator.js`
- `plugins/tech-persistence/scripts/agent-orchestrator.js`

#### 验收

- `node scripts/agent-orchestrator.js self-test` 覆盖 `taskBreakdown.tasks`。
- `spec.raw.json` 即使是 `agent-loop-v6-spec` 嵌套格式，`spec.json.taskBreakdown` 也必须是数组。
- Codex implementation prompt 不再拿到空 spec。

### P1：Preflight Git 策略

#### 方案

Git repo 仍然是默认强约束，因为 diff、dirty check、review context 都依赖 Git。但 `--skip-git-repo-check` 必须真正影响 preflight：

```text
默认：非 Git repo -> preflight failed
显式 --skip-git-repo-check：非 Git repo -> preflight passed，但 diff.patch 写入 no-diff marker
```

这比自动跳过更安全：普通用户仍会被提醒初始化 Git；明确知道自己要跑 no-diff 流程时，可以用 flag 放行。

#### 代码落点

- `buildPreflightReport()`：`gitRepository` check 尊重 `--skip-git-repo-check`。
- `runImplementationProvider()`：继续向 Codex 传 `--skip-git-repo-check`。
- `writeGitDiff()`：非 Git repo 时写 `Not a git repository; diff unavailable.`

#### 验收

```bash
node scripts/agent-orchestrator.js doctor --workdir <non-git>
# 应失败

node scripts/agent-orchestrator.js doctor --workdir <non-git> --skip-git-repo-check
# 应通过，并在 preflight.json 中标记 skipped
```

### P1：Windows Claude Git Bash 自动检测

#### 方案

新增 `resolveClaudeGitBash()`：

1. 优先使用已有 `CLAUDE_CODE_GIT_BASH_PATH`。
2. 检查常见安装路径：
   - `C:\Apps\Git\usr\bin\bash.exe`
   - `C:\Apps\Git\bin\bash.exe`
   - `C:\Program Files\Git\usr\bin\bash.exe`
   - `C:\Program Files\Git\bin\bash.exe`
3. 兜底从 PATH 里找 `bash.exe`，只接受 Git 目录下的 bash。

`runSpecProvider()` 和 `runReviewProvider()` 调 Claude 时自动注入 env override：

```text
CLAUDE_CODE_GIT_BASH_PATH=<detected bash.exe>
```

如果检测不到，doctor 明确失败并提示安装 Git 或设置环境变量。

#### 代码落点

- `resolveClaudeGitBash()`
- `claudeProviderEnv()`
- `buildPreflightReport()`
- `runSpecProvider()`
- `runReviewProvider()`

#### 验收

- Windows 下 `doctor` 输出 `claudeGitBash` 检查项。
- 本机 Git Bash 在 `C:\Apps\Git\usr\bin\bash.exe` 时无需手动设置环境变量。
- provider run 记录 `envOverrides`，可追溯实际注入值。

### P2：长耗时 Provider Run

#### 方案

新增 provider timeout 参数：

```bash
--provider-timeout-minutes <n>
--provider-timeout-ms <n>
```

默认仍是 30 分钟。超时时错误信息必须包含：

- provider label
- timeout 毫秒数
- stdout/stderr 日志路径

这不能完全解决外层终端/TaskOutput 的等待超时，但能解决 orchestrator 自己对子进程的硬超时不可配置问题。若外层 UI 超时，用户可以继续用：

```bash
node scripts/agent-orchestrator.js status --run <runId>
```

查看状态是否已经推进。

#### 代码落点

- `providerTimeoutMs()`
- `runProcess()`
- `runSpecProvider()`
- `runImplementationProvider()`
- `runReviewProvider()`

#### 验收

- `self-test` 覆盖 timeout minutes 解析。
- `--provider-timeout-minutes 45` 会写入 `providerRuns[].timeoutMs = 2700000`。

### 本轮已落地

已同步到项目脚本与插件副本：

- Spec prompt 明确 `taskBreakdown` 必须是顶层数组。
- `normalizeSpec()` 支持 `taskBreakdown.tasks` / `taskBreakdown.items` 等嵌套格式。
- `buildPreflightReport()` 尊重 `--skip-git-repo-check`。
- Windows 下自动检测并注入 `CLAUDE_CODE_GIT_BASH_PATH`。
- `doctor` 增加 `claudeGitBash` 检查项。
- Provider timeout 支持 `--provider-timeout-minutes` / `--provider-timeout-ms`。
- `providerRuns[]` 记录 `timeoutMs` 和 `envOverrides`。
- `self-test` 增加 `taskBreakdown.tasks` 与 timeout 解析覆盖。

### 仍需后续增强

- `status --verbose`：展示 providerRuns、validation、review decision、follow-up 路径。
- `retry`：作为 `resume` 的语义化别名，降低 blocked/provider failure 后的恢复心智负担。
- `repair-spec`：对历史 run 的 `spec.raw.json` 重新执行 normalizer，自动重写 `spec.json` / `task-breakdown.json`。
- schema compatibility test：区分 canonical schema 和 provider-output schema，避免 Claude 输出自定义格式却被宽松 schema 放行。

---

## 附录：正常运行命令模板

```bash
# 前置条件
git init  # 推荐。若明确允许 no-diff run，可传 --skip-git-repo-check
# Windows 下 orchestrator 会自动检测 Git Bash；检测失败时再手动设置：
# export CLAUDE_CODE_GIT_BASH_PATH="C:\Apps\Git\usr\bin\bash.exe"

# 运行 agent-loop
node scripts/agent-orchestrator.js run --requirement "你的需求"

# freeze 后实现
node scripts/agent-orchestrator.js freeze --run <runId>
node scripts/agent-orchestrator.js resume --run <runId>

# 检查状态
node scripts/agent-orchestrator.js status --run <runId|latest>

# 长任务可调大 provider timeout
node scripts/agent-orchestrator.js resume --run <runId> --provider-timeout-minutes 45
```
