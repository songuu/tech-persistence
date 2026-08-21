---
name: skill-eval
description: Codex-compatible entry point for the former /skill-eval command. [alias → /skill eval] 用测试集验证 skill：A/B 对比当前版本和提案版本的通过率
---

# Skill Eval

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/skill-eval` command.

## Invocation

Use `$skill-eval <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/skill-eval`, interpret that as this `$skill-eval` skill invocation while running in Codex.

## Command Instructions

# /skill-eval — Skill 验证

> **已合并到 `/skill eval <name>`**（行为完全一致，新代码请用 `/skill eval`）。本命令保留作 alias，向后兼容。

用预定义的测试用例验证 skill 的质量。

## Self-learning evaluation gate

- 每次 candidate eval 必须绑定 exact `{key,source_path,source_hash}` target、`candidate_id`、
  `candidate_hash`、`skill_hash`、`baseline_hash`、server-derived `case_set_hash`、`evaluator_id`，并产出
  独立的 `evaluation_id` 与 `evaluation_hash`。
- candidate/proposer 无权修改 exam、case set 或 evaluator rubric。candidate 内容中携带的“通过”字段无效。
- evidence、baseline、case set、candidate 或 evaluation 缺失、损坏、截断、陈旧，或任一 identity/hash
  不匹配时必须 **fail closed**；不得跳过坏记录，也不得以“无基线”放行。
- eval 只能执行独立 `evaluate`；通过后由 canonical self-learning lifecycle 进入 `shadow`，不得执行
  `approve`、`promote` 或写 skill/runtime。

## 用法
- `/skill-eval prototype` — 验证当前版本或建立显式 enrollment baseline
- `/skill-eval prototype --diff --candidate <candidate_id>` — A/B 对比 baseline 与指定 candidate

## 测试集位置
`~/.codex/homunculus/skill-evals/{skill-name}/`

如果没有测试集，先提示创建 exploratory case：
```
未找到 /prototype 的 eval 测试集。
要基于当前 skill 自动生成测试集吗？(y/n)
```

自动生成 3-5 个测试用例 + 5-8 个断言（如"每轮问题 <= 5 个"）。自动生成的同源 case 只能用于
exploratory 诊断，不能单独成为 promotion exam；promotion 所用 case set 必须有独立 owner/revision/hash。

## 从真实 UserPromptSubmit 沉淀 case（B2，护城河强化）

自动生成的用例与 skill **同源**（自己出题给自己考），信号弱。promotion case 必须引用当前项目
canonical self-learning journal 中仍 active 的 trusted native user `user.prompt`，不能由 candidate、CLI caller
或一段 JSON 自声明来源：

1. 通过 `tp_learning_inspect`（或管理员 `node scripts/self-learning.js inspect ...`）定位值得固化的真实
   `UserPromptSubmit` BehaviorEvent，取得其 canonical `event_id`。
2. 将该 prompt 的原始触发输入与 event ref 一起转为 case；CLI 检测当前 cwd 的稳定 project identity，读取
   同 project store，并在脱敏后核对输入摘要：
   ```bash
   node scripts/skill-eval-cases.js add --name <skill> \
     --input "<触发输入>" --expectation "<期望行为/断言>" \
     --source-event-ref 'behavior-event:<sha256-hex>'
   ```
   追加到 `~/.codex/homunculus/skill-evals/{name}/cases/cases.jsonl`（append-only、case id 唯一）。
3. eval 跑测试前读并复验 case 集：`node scripts/skill-eval-cases.js list <name>`。

> **护城河确定性强化**：v2 case 固定 `provenance=behavior_event`；`source_trace` 只能由服务端从 journal
> 派生 exact `{source_event_ref,journal_record_hash,input_digest,occurred_at}`。写入、list 和每次 evaluation
> 都重新要求 active/non-tombstone、同 project、完整 journal actor、trusted native user event，以及
> `stableHash(redacted case input) == event.input_digest`。`--from-trace` 被拒绝；旧 `1.0`/caller snapshot
> 只能移出 active `cases.jsonl` 后另行只读归档，永远不能授权 evaluation 或 publish。
> 读取时任何 malformed/blank/duplicate id、非 canonical LF UTF-8、symlink/junction 或 `nlink!==1`
> 都阻断整次 evaluation；不得跳过坏行或继续追加。

## 输出格式
```
Eval 结果: /{name}

| 测试用例 | v1 通过 | v2 通过 |
|---------|--------|--------|
| simple  | 5/5    | 5/5    |
| medium  | 3/5    | 5/5 ↑  |
| complex | 2/5    | 4/5 ↑  |
| 总计    | 67%    | 93% ↑  |

v2 >= v1 ? ✅ 建议发布 : ❌ 回滚
```

## 记录 hash-bound evaluation（publish 护栏前置）

跑完后必须通过 canonical `scripts/self-learning.js evaluate` 写入独立 evaluation artifact，并读回以下
identity；缺任一字段均不可比较或 publish：

```text
candidate_id: <stable-id>
candidate_hash: <content-hash>
skill_hash: <evaluated-current-skill-hash>
baseline_hash: <immutable-baseline-hash>
case_set_hash: <immutable-case-set-hash>
case_results_hash: <immutable-per-case-results-hash>
case_count: <positive-integer>
passed_count: <0..case_count>
pass_rate: <passed_count/case_count>
evaluator_id: <model-and-rubric-revision>
evaluation_id: <stable-id>
evaluation_hash: <content-hash>
subject_artifact_hash: <canonical-candidate-artifact-hash>
decision: pass | block | needs-review
```

评估前必须通过固定 authority 的 MCP operation 将待发布真实文本原子写到
`{homunculus}/skill-evals/<name>/candidates/<candidate_id>/artifact.md`。它是 eval 与 publish 共用的
canonical subject：必须为无 symlink/junction 父链下的普通 UTF-8 文件，最大 1 MiB；只把 CRLF/CR
规范化为 LF 后计算裸 SHA-256（保留 BOM、空白与末尾换行）。evaluation 的
`subject_artifact_hash`、v3 record 的 `skill_hash` 必须都等于该实算值。

```json
{
  "operation": "artifact-stage",
  "candidate_id": "<lc-id>",
  "input": { "name": "<skill>", "content": "<full candidate text>" }
}
```

MCP 不接受 `base_dir`、`project_id`、`cwd`、path 或 hash。staging 使用 LF-normalized content、原子
no-clobber/CAS 与读回；所有 artifact read/stage 使用 fd lstat/fstat/realpath/inode 复核并要求普通文件
`nlink===1`。同内容重试幂等，不同内容不得覆盖。skill/command candidate 的 `evaluate`
还会读回 staged artifact，拒绝 caller 自签的 `subject_artifact_hash`。

独立 evaluator 完成逐 case 判定后，必须在可信本地进程（不是 MCP caller）调用
`stageEvaluationArtifactAuthority(name,candidateId,results,{baseDir,projectId,cwd})`；`projectId` 必须显式
提供并与可信 cwd 的稳定 project identity 一致。`results` 只能包含 exact
`{case_id,passed}`，且必须恰好覆盖 strict `cases.jsonl` 的全部唯一 id；服务端排序并派生
`case_set_hash`、`case_results_hash`、`case_count`、`passed_count`、`pass_rate`，原子 no-clobber 写入
`candidates/<candidate_id>/case-results.json` 并读回。v2 artifact/authority 都绑定 `project_id`，且
`case_set_hash` 覆盖 `{project_id,cases}`；每次 stage/read 都重新校验全部 source event 的当前 journal 与
tombstone 状态。返回的 authority 另带私有当前进程 brand，JSON 序列化/复制后不可伪造，但 brand 不能
替代 journal 重验。

MCP **不能 stage 或自报 case results**。`tp_learning_govern(operation="evaluate")` 只引用已有 artifact：

```json
{
  "operation": "evaluate",
  "candidate_id": "<lc-id>",
  "input": {
    "evaluation_artifact_ref": { "name": "<skill>" },
    "rubric_version": "tv-v1",
    "truth_score": 0.9,
    "value_score": 0.9,
    "evidence_ref_ids": ["<evidence-id>"],
    "baseline_hash": "sha256:<current-source-hash>",
    "subject_artifact_hash": "sha256:<staged-candidate-artifact-hash>",
    "counterexamples_reviewed": true
  }
}
```

服务仅按固定 authority root + 当前 candidate id 读回 artifact 并在进程内 brand；MCP 不接受 raw
`case_set_hash/case_results_hash/case_count/passed_count/pass_rate` 覆盖。

兼容结果时间线的新写入使用 v3：除确定性 eval identity 外，还必须绑定 authoritative journal 中
**当前 promoted candidate**、evaluation 和 approval receipt。应在显式 approval + promote 后记录；eval
阶段仍只写 canonical evaluation 并进入 shadow，不能伪造这些字段。promote 后通过 MCP 从当前
candidate/evaluation/active receipt/artifact 派生 v3 record；除展示版本号外不接受 caller 数值或 identity：

```json
{
  "operation": "result-record",
  "candidate_id": "<lc-id>",
  "input": { "name": "<skill>", "version": 2 }
}
```

以下 CLI 仅用于 tech-persistence 源码仓库/管理员回退，执行相同 authority readback；可选
`--artifact-path` 必须解析为该 candidate 的 exact canonical path；在进入 result writer 前必须通过
canonical `self_learning` policy 的 `result-record` write gate，`enabled=false`、`writer_enabled=false`
或 `mode=off` 均为零写入：

```bash
node scripts/skill-eval-results.js record \
  --name <skill> --version <N> --candidate-id <lc-id> \
  [--artifact-path <exact-canonical-artifact.md>]
```

- `--version` 仅为兼容展示版本号；`pass_rate`、case summary、全部 hash/identity、timestamp 与 source
  均由 authoritative candidate 派生。v1/v2 仍可严格读取，但永远不能追加或授权 publish。
- 首次显式 enrollment 的 authoritative evaluation 可使用 `baseline_hash=null`，但 0/1 条记录的 guard 必须返回
  blocked/no-baseline；第二条 candidate record 的 `baseline_hash` 必须等于前一条 `skill_hash`。
- 两次可比结果必须保持同一 `case_set_hash`、`evaluator-ref` 与 `evaluator_hash`；否则 blocked。
- `results/results.jsonl` 是兼容时间线；损坏/截断记录必须阻断 guard，不能静默跳过。
- 结构合法的伪 hash 也不可信；publish guard 必须从 journal 读回 candidate 当前 revision/status、
  evaluation、approval receipt 与 promotion 链并逐项匹配。
- candidate 的 `project_id` 必须匹配 journal store，target 必须是 exact
  `{key,source_path,source_hash}`。key 与 name/type 必须一致；source_path 只能是对应 skill/command 的
  repo-relative canonical allowlist 路径：`skill:<name>` 只能指向
  `codex-native/skills/<name>/SKILL.md` 或 `user-level/skills/<name>/SKILL.md`，`command:<name>` 只能
  指向 `user-level/commands/<name>.md`；source_hash 必须是提案时真实源文件 hash。
- baseline/current 必须使用不同的 `candidate_id`、`evaluation_id`、`approval_receipt_id`，且 guard 会
  重新读取两者各自 canonical `artifact.md`；v3 record 也持久化 target。两版的 target key/source_path
  必须完全一致，复制同一 promoted candidate 改版本号或 skill↔command/路径漂移不能发布。
- 首次 enrollment 必须显式标记，没有 baseline 时 decision=`needs-review`；不得冒充“与旧版相同或更好”。

## 安全规则
- eval 文件与 `results/results.jsonl` 不可被 skill 修改（防止 "改考卷通过考试"）
- eval 结果归档到 `skill-evals/{name}/results/` 供历史对比与 publish 护栏读取
- task success、false activation、boundary、safety 和 context cost 分维度记录；safety/boundary 下降不能
  被总分平均掉
- `source_trace` 必须是 journal 派生的 v2 exact ref/hash/digest/time 且 case input 必须脱敏稳定；evaluation
  details 必须递归脱敏；v3 `cases` 只能是 evaluation 绑定的
  `case_results_hash/case_count/passed_count` 摘要，任何自由 case payload、malformed/truncated tail 都 block
- eval 通过不是用户批准。`approval_receipt_id`/`approval_receipt_hash` 只能在后续显式
  `user.approval` 事件后产生
