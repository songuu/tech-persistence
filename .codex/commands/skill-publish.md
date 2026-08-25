---
description: "[alias → /skill publish] 将已验证的 skill 改进提案发布为新版本，含备份、changelog、回滚能力"
---

# /skill-publish — Skill 版本发布

> **已合并到 `/skill publish <name>`**（行为完全一致，新代码请用 `/skill publish`）。本命令保留作 alias，向后兼容。

将 `/skill-improve` 的提案（经 `/skill-eval` 验证后）发布为新版本。

## Self-learning publish gate

publish 必须同时绑定并读回：

六个强制 identity 字段是 `candidate_id`、`candidate_hash`、`evaluation_id`、`evaluation_hash`、
`approval_receipt_id`、`approval_receipt_hash`；只展示名称、版本或总通过率不满足 gate。

```text
candidate_id: <stable-id>
candidate_hash: <current-candidate-hash>
evaluation_id: <stable-id>
evaluation_hash: <evaluation-content-hash>
approval_receipt_id: <stable-id>
approval_receipt_hash: <approval-content-hash>
```

- candidate 必须依次经历 proposed → evaluated → shadow → approved → promoted；这里 promoted 仅表示
  已获 reader/publish gate 资格（`runtime_written=false`），不表示 skill 文件已经发布，shadow 是必经状态。
- evaluation 必须绑定当前 candidate、exact `{key,source_path,source_hash}` target、skill artifact、baseline、
  server-derived case-set/results summary 和 evaluator identity/hash；MCP 不能自报 case results。
- approval receipt 必须引用绑定当前 `candidate_hash` 的显式 `user.approval` event，并记录 authority/
  publisher ref。命令行文字、candidate 自带字段或历史 approval 都不能替代它。
- 上述确定性 gate 全部通过后，仍必须展示最终 diff 并等待本次人工 `go`；approval receipt 不替代原有
  人工 `go` gate。
- `--auto`、`/skill auto`、Compound、learn、evolve 均不得调用 publish、`approve` 或 `promote`。

## 用法
- `/skill-publish prototype` — 发布已验证的提案
- `/skill-rollback prototype` — 回滚到上一版本

## 执行步骤
0. **确定性身份护栏（强制，不可跳过）**：先严格读取 candidate、evaluation、approval receipt 和
   baseline/case-set/case-results summary。若当前 promoted candidate 尚无 v3 result，先调用
   `tp_learning_govern(operation="result-record")`，只传 `candidate_id`、`name` 与展示 `version`；服务必须
   从 candidate exact target、evaluation 的 counts/pass_rate、active receipt 和 canonical artifact 派生
   全部其余字段。任一缺失、
   损坏、截断、陈旧或 hash/identity 不匹配即非零退出并中止。
1. **回归 + authoritative journal 护栏（强制，不可跳过）**：优先调用已投影、可从普通业务 cwd
   到达的 MCP `tp_learning_govern`，避免依赖仓库相对路径：
   ```json
   {
     "operation": "publish-guard",
     "input": { "name": "<skill-name>", "tolerance": 0 }
   }
   ```
   仅 `result.status="ok"` 且 `result.publish_authorized=true` 放行到步骤 2；MCP `isError`、blocked、
   仅回归比较得到的 `status="ok"`、缺 journal、伪 hash、stale、
   tombstoned 或非 promoted 一律中止。MCP 不接受 `base_dir`、`project_id`、`cwd` 或 artifact path；
   authority root 与项目身份只由 server 环境和可信 cwd 决定。repo/admin 场景才使用 CLI 等价入口：
   ```bash
   node scripts/skill-eval-results.js guard <skill-name>
   # exit 0 → 仅表示权威护栏通过，仍须完成步骤 2 的人工 go；非零 → 中止
   ```
   护栏严格读取 `skill-evals/{name}/results/results.jsonl` 与 hash-bound evaluation；没有可验证 baseline
   时返回 block/needs-review，malformed tail 不得跳过。它还会固定解析 baseline/current 的
   `candidates/<candidate_id>/artifact.md` 并实算 UTF-8 LF-normalized hash，同时将 `pass_rate` 和
   `case_results_hash/case_count/passed_count` 逐项回绑 CandidateEvaluation；不接受 caller 指定路径、
   hash、pass rate 或 case summary。artifact/source/case-result 文件均要求无 symlink/junction、普通 UTF-8、
   `nlink===1`，并通过 fd lstat/fstat/realpath/inode 前后复核。
2. **人工 `go`（强制）**：展示 candidate identity、evaluation、approval receipt、目标 canonical path、
   完整 diff、scope 与 rollback 计划，等待用户在当前发布动作中输入 `go`。其他回复均中止。
3. 重新计算 candidate/target/base hash，防止批准后内容漂移；baseline/current v3 target 的 key 与
   source_path 必须完全一致。当前 repo 源文件实算 hash 必须同时等于 previous `skill_hash`、candidate
   `target.source_hash` 与 current `baseline_hash`；skill↔command、路径或源内容漂移均中止并重新
   eval/approval。
4. 备份当前版本 → `{skill-name}.v{N}.bak.md`。
5. 应用修改 → 更新 canonical SKILL.md 或 command `.md`；不直接修改 generated/plugin projection。
6. 运行既有 builder/validator/test，并对 source、manifest、router、projection、discovery 做 hash/readback。
7. 记录 changelog 与 publish/readback receipt；不得把 gate 前的 promoted 误报为 runtime 已发布，只有
   步骤 4-6 全部成功且 readback 匹配才报告发布完成。
8. 最后标记源本能 `absorbed_into: "{skill} v{N+1}"`；marker 必须引用 publish receipt，失败时不得
   冒充发布完成。

## Changelog 格式
```markdown
### v{N+1} ({date})
- [变更1] (原因: 数据依据)
- [变更2] (原因: 数据依据)
- 吸收本能: [id1, id2]
- eval: v{N} {X}% → v{N+1} {Y}%
- candidate: {candidate_id}@{candidate_hash}
- evaluation: {evaluation_id}@{evaluation_hash}
- approval: {approval_receipt_id}@{approval_receipt_hash}
- publish/readback: {receipt-id}@{published-hash}
```

## 安全
- 必须有 hash-bound candidate/evaluation、显式 `user.approval` receipt、人工 `go` 和 readback 才能发布
- candidate、exam/evaluator、approval authority、publisher 必须是可审计的独立角色/artifact
- v1/v2 eval timeline 只读兼容、不可发布；无 baseline/journal、stale identity、tombstone、非 promoted、
  坏记录、部分 projection 或 readback mismatch 一律 fail closed
- publish guard 当前是写入前 preflight；人工 `go` 后到实际 source write 之间尚未合并为单一原子事务，
  该 guard→write TOCTOU 是 P1 residual。写前必须立即重复 source/hash readback，但不能宣称已消除竞态。
- 旧版本完整保留在备份中
- `/skill-rollback {name}` 按 receipt 回滚，并验证 source/projection hash/readback；回滚失败报告 partial
