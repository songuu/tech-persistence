# agent-loop v6 根因复盘与架构调整文档

日期：2026-04-28

适用范围：

- Codex 入口：`$agent-loop <args>`
- 原插件根实现：`C:\Users\songyu\plugins\tech-persistence\scripts\agent-orchestrator.js`
- 项目临时兼容副本：`C:\project\my\demo\scripts\agent-orchestrator.js`
- Schema 根目录：`schemas/agent-loop/*`

## 1. 本次运行中真实暴露的问题

### 1.1 Provider 命令无法启动

现象：

- `spawnSync claude ENOENT`
- `spawnSync codex ENOENT`

直接原因：

- orchestrator 使用 `spawnSync(command, args, { shell: false })`。
- Windows 下 `claude`、`codex` 优先解析到 npm shim：
  - `C:\Users\songyu\AppData\Roaming\npm\claude.cmd`
  - `C:\Users\songyu\AppData\Roaming\npm\codex.cmd`
- `.cmd` shim 不是 `shell: false` 下稳定可执行的 provider 二进制。

根因：

- 编排器把“provider 名称”和“进程启动方式”混在一起。
- 缺少 provider command discovery / launch adapter。
- 没有记录实际使用的 provider executable，恢复运行时不可复现。

### 1.2 Codex 执行前置环境不满足

现象：

- `Not inside a trusted directory and --skip-git-repo-check was not specified.`

直接原因：

- 工作目录最初不是 Git 仓库。
- `codex exec` 没有预检 Git/trust 条件，也没有明确 fallback 策略。

根因：

- orchestrator 没有 `preflight` 阶段。
- provider 运行条件散落在 provider 自己的错误里，用户只能从失败日志里反推。

### 1.3 `.agent-runs` 污染 clean worktree 判断

现象：

- agent-loop 自己生成 `.agent-runs/*` 后，`git status --short` 变 dirty。
- resume 实现阶段要求 clean worktree，导致编排器被自己的产物阻塞。

直接原因：

- run artifacts 存在 repo 内。
- clean check 没有排除 orchestrator-managed artifacts。

根因：

- artifact manager 与 worktree guard 没有边界。
- `.agent-runs/`、本地兼容脚本、schema copy 没有被编排器自动识别为 managed files。

### 1.4 Codex structured output schema 被拒绝

现象：

- `invalid_json_schema`
- Codex 要求 structured output schema 的 object 使用 `additionalProperties: false`。

直接原因：

- `agent-handoff.schema.json` 原始版本顶层是 `"additionalProperties": true`。

根因：

- schema 没有区分 canonical contract 与 provider-specific schema。
- Claude 能接受的宽松 schema 被直接拿给 Codex structured output 使用。

### 1.5 Claude 输出结构与编排器预期不一致

现象：

- spec provider 输出了可用设计，但字段不完全符合编排器硬编码预期。
- review provider 返回 `status: "passed"`、`canMerge: true`、`issues: []`，但状态机只识别 `decision: "approved"` 或 `compliant: true`。
- 最终 review 实际通过，却被状态机判成 `needs-followup`。

直接原因：

- `validateSpec()` 和 `runReviewProvider()` 只认单一字段形态。
- 没有 canonicalization/normalization 层。

根因：

- provider output contract 没有版本化。
- 编排器状态转移直接依赖 provider 原始输出，而不是 normalized domain model。

### 1.6 Claude JSON 包装输出解析不完整

现象：

- `claude -p --output-format json` 外层是 CLI result JSON。
- 真正的业务 JSON 可能在 `result` 字符串里，并且可能被 ```json fence 包起来。

直接原因：

- 原 `unwrapAgentJson()` 只尝试 parse wrapper 字段本身。
- 没有继续从 wrapper string 中提取 fenced JSON 或 balanced JSON。

根因：

- JSON parsing 是 ad hoc 逻辑，不是 provider adapter 的职责。
- 缺少统一 `StructuredOutputCodec`。

### 1.7 Windows argv 过长

现象：

- review prompt 包含完整 `diff.patch`。
- `pnpm-lock.yaml` 等大文件进入 prompt 后触发 Windows `ENAMETOOLONG`。

直接原因：

- prompt 作为命令行参数传给 provider。
- diff 无差别 inline。

根因：

- prompt transport 依赖 argv。
- review context 没有大小预算、文件类型策略和 generated artifact 策略。

### 1.8 Validation 职责不清

现象：

- implementation provider 声称 shell validation 无法执行。
- 后续由外层手工执行 `pnpm install`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter web build` 才确认质量。

直接原因：

- validation 既出现在 Codex handoff，又由 orchestrator 可选执行。

根因：

- validation 应属于 orchestrator 的确定性职责。
- provider handoff 只能描述“它尝试了什么”，不能作为最终验收事实。

### 1.9 项目级实现错误由 review 才暴露

现象：

- `apps/web/tsconfig.json` extends 路径错误。
- `packages/ui/tsconfig.json` extends 路径错误。
- `packages/ui/package.json` 缺少 `files` 字段。

直接原因：

- 首轮实现没有成功执行 validation。

根因：

- 缺少按 spec/task 自动派生 validation command 的机制。
- resume 不应该在 validation skipped 时直接进入“可 review”的强信号状态。

## 2. 根本架构结论

`agent-loop v6` 的核心设计方向是正确的：

1. Claude 负责 spec/design/tasks。
2. 人类 freeze。
3. Codex 按 frozen spec 实现。
4. Claude 按 frozen spec review。
5. 不通过再生成 follow-up。

真正的问题不在这条业务流程，而在编排器缺少 6 个基础层：

1. Provider Adapter：负责不同 CLI 的启动、stdin/argv、输出包装。
2. Structured Output Codec：负责从 provider 输出中稳定提取 JSON。
3. Contract Normalizer：把 provider 原始输出转成 canonical domain model。
4. Artifact Manager：负责 run artifacts、diff、review context、managed files。
5. Validation Runner：负责确定性执行测试命令并写入验收事实。
6. State Machine：只基于 normalized model 和 validation fact 做状态转移。

## 3. 调整后的目标架构

### 3.1 模块边界

建议把当前单文件 orchestrator 的职责拆成以下内部模块。可以先保持单文件实现，但代码结构必须按这些边界组织。

```text
agent-orchestrator.js
  CLI parser
  Orchestrator state machine
  ProviderRegistry
    ClaudePrintAdapter
    CodexExecAdapter
  ProviderLaunchResolver
  StructuredOutputCodec
  ContractNormalizer
  SchemaManager
  ArtifactManager
  DiffManager
  ValidationRunner
  Preflight
```

### 3.2 ProviderLaunchResolver

职责：

- 解析 provider 命令。
- Windows 下把 npm shim 转成真实 executable 或 node script launch。
- 记录 resolved command 到 `state.providerRuns[]` 和 `commands.json`。

解析顺序：

1. CLI 显式参数：
   - `--claude-command`
   - `--codex-command`
   - `--spec-command`
   - `--implementation-command`
   - `--review-command`
2. 环境变量：
   - `AGENT_LOOP_CLAUDE_COMMAND`
   - `AGENT_LOOP_CODEX_COMMAND`
3. PATH/where：
   - Windows：`where.exe claude|codex`
   - 非 Windows：直接执行 command
4. Windows shim 解析：
   - `.exe`：直接执行
   - `.cmd` 指向 `.exe`：执行真实 `.exe`
   - `.cmd` 指向 `.js`：执行 `node <script.js>`
   - 兜底：`shell: true`，但必须在日志标记为 fallback

本次对应源头修改：

- 新增 `resolveProviderLaunch()`
- 新增 `resolveWindowsShim()`
- 新增 `normalizeLaunch()`
- 修改 `runProcess()` 接受 `{ command, argsPrefix, shell }`

### 3.3 ProviderAdapter

Provider 不应该只是一串命令名，而应该是 adapter：

```text
ClaudePrintAdapter
  buildSpecInvocation(promptFile, schema)
  buildReviewInvocation(promptFile, schema)
  parseOutput(stdout)

CodexExecAdapter
  buildImplementationInvocation(promptFile, schema, lastMessageFile)
  parseOutput(lastMessageFile, stdout)
```

ProviderAdapter 的统一返回：

```json
{
  "raw": {},
  "normalized": {},
  "logs": {
    "stdoutFile": "...",
    "stderrFile": "..."
  },
  "launch": {
    "command": "...",
    "args": []
  }
}
```

### 3.4 Prompt Transport

原则：

- 大 prompt 不进入 argv。
- provider 支持 stdin 时使用 stdin。
- 不支持 stdin 时，使用最小 argv，并把大上下文写入 artifact 文件。

Codex：

- `codex exec ... -`
- prompt 从 stdin 传入。
- 这是已由 `codex exec --help` 确认的能力。

Claude：

- `claude -p --input-format text ...`
- prompt 应优先通过 stdin 传入。
- 如当前 Claude 版本 stdin 行为不稳定，adapter 必须做 feature probe，并 fallback 到短 argv + artifact 引用。

本次对应源头修改：

- `runProcess()` 增加 `stdin`。
- implementation provider 改为 `args.push('-')` 并通过 stdin 传 prompt。
- spec/review provider 也应迁移到 stdin 或 prompt artifact，不再把完整 prompt 放 argv。

### 3.5 StructuredOutputCodec

职责：

从 provider 输出中提取业务 JSON，屏蔽 CLI 包装差异。

解析顺序：

1. 直接 `JSON.parse(stdout)`。
2. 如果是 wrapper object，检查：
   - `result`
   - `content`
   - `message.content`
   - `output`
3. wrapper 字段是 string 时：
   - 先直接 parse。
   - 再提取 fenced JSON。
   - 再提取第一个 balanced JSON object/array。
4. wrapper 字段是 array 时：
   - 拼接 `item.text` 或 string。
   - 重复第 3 步。
5. 失败时：
   - 不手工伪造成功。
   - 写 `parse-error.json`。
   - 状态进入 `failed` 或 `needs-manual-recovery`。

本次对应源头修改：

- 加强 `unwrapAgentJson()`。
- 保留 `findFirstJson()`，但把它视为 codec 内部实现。

### 3.6 ContractNormalizer

Provider 输出必须转成 canonical model 后再进入状态机。

#### Spec normalizer

接受 provider alias：

```text
requirements -> requirementSpec
acceptance -> acceptanceCriteria
tasks -> taskBreakdown
design -> technicalDesign
```

输出 canonical spec：

```json
{
  "requirementSpec": {
    "summary": "",
    "userValue": "",
    "scope": [],
    "acceptanceCriteria": []
  },
  "technicalDesign": {
    "approach": "",
    "files": [],
    "interfaces": [],
    "dataAndState": "",
    "risks": [],
    "testStrategy": ""
  },
  "taskBreakdown": [],
  "assumptions": [],
  "outOfScope": [],
  "questions": [],
  "humanReviewChecklist": []
}
```

#### Handoff normalizer

接受 provider alias：

```text
files -> changedFiles
followUpTasks -> followUp
result -> summary
```

输出 canonical handoff：

```json
{
  "summary": "",
  "changedFiles": [],
  "validation": [],
  "risks": [],
  "followUp": []
}
```

#### Review normalizer

接受两类 review 输出。

Canonical 形式：

```json
{
  "decision": "approved",
  "compliant": true,
  "summary": "",
  "findings": [],
  "followUpTasks": []
}
```

Claude 常见形式：

```json
{
  "status": "passed",
  "reviewSummary": "",
  "issues": [],
  "warnings": [],
  "canMerge": true
}
```

归一化规则：

```text
if compliant === true -> approved
if decision === "approved" -> approved
if status in ["passed", "pass", "approved"] and canMerge !== false and issues empty -> approved
if canMerge === true and issues empty -> approved
else if blocked/P0 exists -> blocked
else -> changes_requested
```

本次对应源头修改：

- 已开始增加 `normalizeSpec()`、`normalizeHandoff()`。
- 还必须补上 `normalizeReview()`，并让 `runReviewProvider()` 只使用 normalized review 做状态转移。

### 3.7 SchemaManager

必须区分两类 schema：

1. Canonical contract schema：存档和状态机使用。
2. Provider structured-output schema：传给具体 CLI。

Codex schema 规则：

- 所有 object 必须显式 `"additionalProperties": false`。
- schema 应尽量小，只约束 handoff 最终响应。

Claude schema 规则：

- 可以保持稍宽松，但仍要求关键字段。
- 即便 Claude 输出满足另一种同义结构，也必须经过 normalizer。

本次对应源头修改：

- `agent-handoff.schema.json` 顶层从 `true` 改为 `false`。

后续必须补齐：

- schema compatibility test。
- `node scripts/agent-orchestrator.js doctor` 或 `preflight` 检查 schema 是否可被 provider 接受。

### 3.8 ArtifactManager

职责：

- 管理 `.agent-runs/<runId>/`。
- 记录哪些文件是 orchestrator 自己生成的。
- clean worktree check 必须排除 managed artifacts。

Managed artifacts：

```text
.agent-runs/**
scripts/agent-orchestrator.js       # 仅当是项目临时兼容副本时
schemas/agent-loop/**               # 仅当是项目临时兼容副本时
node_modules/**
.next/**
dist/**
build/**
coverage/**
```

推荐策略：

- 全局插件修好后，不再需要项目临时 copy。
- 项目内 run artifacts 可以继续放 `.agent-runs/`，但必须自动排除在 clean check 之外。
- 可选：首次运行时提示把 `.agent-runs/` 写入 `.git/info/exclude`，但不要强制改用户仓库文件。

本次对应源头修改：

- `ensureCleanWorktree(workdir, options, runDir)` 排除当前 runDir。
- `writeGitDiff()` 忽略 `.agent-runs`、`node_modules`、`.next` 等路径。

### 3.9 DiffManager 与 ReviewContext

目标：

- review provider 看到足够上下文。
- 不把巨大文件和二进制文件塞进 prompt。
- 不因为 Windows argv 限制失败。

输出文件：

```text
changed-files.json
diff.patch
review-context.md
```

`changed-files.json`：

```json
[
  { "status": "??", "path": "apps/web/package.json" },
  { "status": "M", "path": "packages/ui/package.json" }
]
```

`diff.patch` 策略：

- tracked diff：
  - `git diff --no-ext-diff --binary -- . :(exclude)pnpm-lock.yaml ...`
- untracked text files：
  - 生成 synthetic new-file diff。
- generated lockfile：
  - 只记录 omitted marker。
- binary/oversized file：
  - 只记录 omitted marker。

`review-context.md` 策略：

- 包含 changed files JSON。
- 包含有大小上限的 patch context。
- 超限时明确写：
  - diff 已截断。
  - review provider 应直接 inspect repository files。

本次对应源头修改：

- 新增 `REVIEW_CONTEXT_MAX_BYTES`。
- 新增 `INLINE_FILE_DIFF_MAX_BYTES`。
- 新增 `DEFAULT_DIFF_EXCLUDES`。
- 新增 `writeReviewContext()` / `buildReviewContext()`。
- `buildReviewPrompt()` 从直接 inline `diff.patch` 改为引用 `review-context.md`。

### 3.10 ValidationRunner

原则：

- validation fact 只能由 orchestrator 写。
- provider handoff 里的 validation 只是说明，不作为最终验收。
- `validation.json` 是 review provider 的主要依据之一。

行为：

1. 如果用户传了 `--validation-command`，执行它。
2. 如果 spec/task 提供 `suggestedValidation`，可以生成建议，但不自动执行危险命令。
3. 如果没有 validation，状态允许 `implemented`，但 review prompt 必须标记 validation skipped。
4. 对 L2 及以上任务，validation skipped 应成为 review warning。

推荐 `validation.json`：

```json
{
  "status": "passed",
  "commands": [
    {
      "command": "pnpm typecheck",
      "exitCode": 0,
      "stdoutFile": "logs/typecheck.stdout.log",
      "stderrFile": "logs/typecheck.stderr.log"
    }
  ]
}
```

本次对应源头修改：

- 保留 `writeValidation()`。
- 后续应从单命令扩展成多命令数组。

### 3.11 StateMachine

状态必须从 provider 原始输出中解耦。

建议状态：

```text
draft
spec-ready
frozen
implementing
implemented
reviewing
completed
needs-followup
blocked
failed
```

状态转移：

```text
run:
  draft -> spec-ready

freeze:
  spec-ready -> frozen

resume:
  frozen | needs-followup -> implementing -> implemented
  implemented -> reviewing -> completed | needs-followup | blocked
```

review 结果转移只看 normalized review：

```text
approved + compliant true -> completed
blocked or P0 -> blocked
changes_requested -> needs-followup
parse/provider failure -> failed
```

本次对应源头修改：

- 当前旧逻辑：
  - `review.compliant === true || decision === 'approved'`
- 必须改为：
  - `const review = normalizeReview(rawReview)`
  - `state.status = statusFromReview(review)`

### 3.12 Preflight

新增 `preflight` 是避免这次失败链的关键。

检查项：

```text
node 可用
git 可用
workdir 是否 Git repo
provider command 是否可启动
provider schema 是否可接受
Codex 是否需要 --skip-git-repo-check
Windows argv 风险
runDir 是否可写
clean worktree 是否只有 managed artifacts
```

CLI：

```bash
node scripts/agent-orchestrator.js doctor
node scripts/agent-orchestrator.js run --requirement "..." --preflight-only
```

## 4. 需要修改的源头文件清单

### 4.1 必须改：全局插件 orchestrator

路径：

```text
C:\Users\songyu\plugins\tech-persistence\scripts\agent-orchestrator.js
```

原因：

- `$agent-loop` 在没有项目本地脚本时会 fallback 到这里。
- 只改项目内 `scripts/agent-orchestrator.js`，下个仓库仍会复现。

必须落地的修改：

```text
ProviderLaunchResolver
ProviderAdapter
stdin/file prompt transport
StructuredOutputCodec
ContractNormalizer
ArtifactManager
DiffManager
ValidationRunner 多命令结构
StateMachine normalized transition
Preflight/doctor
```

### 4.2 必须改：全局 schema

路径：

```text
C:\Users\songyu\plugins\tech-persistence\schemas\agent-loop\agent-handoff.schema.json
C:\Users\songyu\plugins\tech-persistence\schemas\agent-loop\review-result.schema.json
C:\Users\songyu\plugins\tech-persistence\schemas\agent-loop\requirement-spec.schema.json
```

必须落地：

- Codex 使用的 handoff schema：`additionalProperties: false`。
- review/spec schema 保持 canonical，但 normalizer 接受 provider alias。
- 增加 schema compatibility test。

### 4.3 建议改：agent-loop skill 文档

路径：

```text
C:\Users\songyu\.codex\skills\agent-loop\SKILL.md
```

建议补充：

- Windows 下不要求用户手动传真实 `.exe`。
- orchestrator 会自动解析 provider command。
- 如果 provider preflight 失败，先运行 `doctor`。
- resume 支持多 validation command。

### 4.4 项目临时副本的定位

路径：

```text
C:\project\my\demo\scripts\agent-orchestrator.js
C:\project\my\demo\schemas\agent-loop\*
```

定位：

- 这是为了当前项目继续跑通的兼容副本。
- 不应该作为长期架构源头。
- 全局插件修好后，应删除项目临时副本，或者只在需要 project override 时保留。

## 5. 当前项目中已经开始触碰的改动

当前我已经对项目本地 `scripts/agent-orchestrator.js` 做了部分架构草稿改动，但尚未完成全部验证。

已开始改动：

- 新增 review/diff 大小预算常量：
  - `REVIEW_CONTEXT_MAX_BYTES`
  - `INLINE_FILE_DIFF_MAX_BYTES`
  - `DEFAULT_DIFF_EXCLUDES`
  - `DEFAULT_STATUS_EXCLUDE_PREFIXES`
- 新增 Windows/provider launch helpers：
  - `isWindows()`
  - `resolveProviderLaunch()`
  - `resolveWindowsShim()`
  - `normalizeLaunch()`
- 修改 `runProcess()`：
  - 支持 provider launch object。
  - 支持 stdin。
  - 记录 resolved command。
- 新增输出归一化草稿：
  - `normalizeSpec()`
  - `normalizeHandoff()`
- 修改 implementation provider：
  - `codex exec` 使用 `-` 从 stdin 读 prompt。
- 新增 clean worktree managed runDir 排除。
- 新增 diff/review context 草稿：
  - `listChangedFiles()`
  - `buildUntrackedDiff()`
  - `writeReviewContext()`
  - `buildReviewContext()`

尚未完成的关键项：

- `normalizeReview()` 还未落地。
- `runReviewProvider()` 还未完全迁移到 stdin/provider adapter。
- `writeReviewContext()` 还未在 implementation 完成后稳定调用。
- `writeGitDiff()` 的 untracked/synthetic diff 还未跑完整回归。
- 全局插件根目录还未同步这些修改。

## 6. 建议落地顺序

### 阶段 1：停止手工补丁，先修全局插件根实现

改：

```text
C:\Users\songyu\plugins\tech-persistence\scripts\agent-orchestrator.js
C:\Users\songyu\plugins\tech-persistence\schemas\agent-loop\*.json
```

目标：

- `$agent-loop` 在任何新仓库都能自动处理 Windows provider shim。
- 不再要求手动传 `--claude-command` / `--codex-command`。

### 阶段 2：补 provider/output/state 三条主线测试

最小测试集：

```text
解析 claude.cmd -> claude.exe
解析 codex.cmd -> node codex.js 或真实 codex.exe
Claude wrapper result string 中提取 fenced JSON
review status=passed/canMerge=true -> completed
Codex handoff schema 被 CLI 接受
大 pnpm-lock.yaml 不进入 review argv
.agent-runs 不污染 clean worktree
```

### 阶段 3：再回到项目内清理临时副本

如果全局插件修复并验证通过：

- 删除或废弃项目内 `scripts/agent-orchestrator.js`。
- 删除或废弃项目内 `schemas/agent-loop/*`。
- 保留 `.agent-runs` 作为历史运行记录即可。

## 7. 验收标准

一次新的 `$agent-loop 简化版本的 monorepo + next` 应满足：

1. `run` 阶段：
   - 自动找到 Claude provider。
   - 产出 canonical `spec.json`。
   - 状态为 `spec-ready`。
2. `freeze` 阶段：
   - 不进入实现，除非用户明确 freeze。
3. `resume` 阶段：
   - 自动找到 Codex provider。
   - 不被 `.agent-runs` dirty 状态阻塞。
   - prompt 不因 Windows argv 过长失败。
   - 产出 `handoff.json`、`diff.patch`、`changed-files.json`、`review-context.md`、`validation.json`。
4. `review` 阶段：
   - Claude wrapper/fenced JSON 可解析。
   - `status: passed` / `canMerge: true` 可归一化为 completed。
   - review 不通过时生成可执行 follow-up task。
5. 状态：
   - review 真通过时必须是 `completed`。
   - 不允许再出现“review passed 但 state 是 needs-followup”的情况。

## 8. 核心判断

这次 `$agent-loop` 的问题不是“Next monorepo 需求复杂”，而是 orchestrator 把 provider CLI、结构化输出、状态机、diff 上下文、validation 事实揉在一个单文件流程里。

根源修复不是继续给某次 run 手动 patch artifact，而是把外部 agent 编排器变成明确的分层系统：

```text
CLI command
  -> preflight
  -> provider adapter
  -> structured output codec
  -> contract normalizer
  -> artifact manager
  -> validation runner
  -> normalized state machine
```

完成这次架构调整后，`$agent-loop` 才能稳定承担“Claude 规划、Codex 实现、Claude 复审”的 v6 职责。

## 9. 2026-04-28 落地状态更新

本轮已把文档中的关键基础层落到 `scripts/agent-orchestrator.js`，并机械同步到 `plugins/tech-persistence/scripts/agent-orchestrator.js`，避免项目入口与插件入口行为分叉。

已落地：

- ProviderLaunchResolver：自动解析 Windows npm shim，`claude.cmd` 可落到真实 `claude.exe`，`codex.cmd` 可落到 `node <codex.js>`。
- Prompt transport：spec/review 使用 `claude -p --input-format text` 从 stdin 读 prompt；implementation 使用 `codex exec -` 从 stdin 读 prompt。
- StructuredOutputCodec：支持 CLI wrapper、`result` 字符串、content array、fenced JSON、balanced JSON 提取。
- ContractNormalizer：spec / handoff / review 都先归一化再进入状态机。
- StateMachine：review 通过判定只看 normalized review，`status: passed` / `canMerge: true` / `issues: []` 会进入 `completed`。
- ArtifactManager / DiffManager：clean worktree 排除 managed artifacts；产出 `changed-files.json`、截断安全的 `review-context.md`。
- ValidationRunner：`--validation-command` 支持重复传入，`validation.json` 记录 commands 数组。
- Preflight：新增 `doctor` 与 `--preflight-only`，记录 `preflight.json`。
- Self-test：新增 `self-test` 覆盖 JSON wrapper、review alias、handoff alias 与 handoff schema strictness。
- Schema：Codex handoff schema 顶层 `additionalProperties` 已改为 `false`。

仍需后续增强：

- 增加独立单元测试文件覆盖 codec / normalizer / shim resolver，目前先由 `self-test` 做最小回归。
- 在安装或构建插件流程中增加 schema compatibility check。
- 全局用户目录已安装插件需要重新发布/安装后才会拿到本仓库插件副本中的修复。
