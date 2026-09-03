# Sprint Runtime Evidence

`/sprint evidence`（Codex 同义 `$sprint evidence`）是只读核证入口，用统一摘要回答：当前/指定 Sprint 是否实际使用 Harness、是否捕获 Transcript、是否已同步 PostgreSQL，以及 Transcript 是否与该 Sprint 绑定。它不是新的完成 Gate，也不修改 pointer、plan、run、outbox、ack 或数据库。

## 执行

定位 `sprint-evidence.js` 时只接受非链接普通文件，依次尝试：

1. plugin 安装：`<skill-dir>/../../scripts/sprint-evidence.js`；
2. source/project fallback：`<workspace>/scripts/sprint-evidence.js`。

默认运行人类可读摘要；需要机器判定时加 `--json`：

```text
node <evidence-cli>
node <evidence-cli> --json
node <evidence-cli> --plan docs/plans/<completed-or-historical-sprint>.md --json
```

若 helper 不存在或验证失败，明确报告 `evidence unavailable`，不得用对话记忆或 provider 自报补齐。`missing-pointer` 在这里表示没有 active Sprint，**不得**按普通 `/sprint` bootstrap。

## 判读

- `harness.status=external-execution`：存在带完整 envelope hash 且被 runtime 接受的 provider run；`acceptance-bound` 只证明绑定，不能宣称已用 Harness 执行。
- `transcript.status=synced`：Harness transcript ack 已全部验证，或当前宿主 transcript 经只读 PostgreSQL 身份做了 exact readback。
- `unbound-local` / `unbound-synced`：宿主会话存在，但没有 active Sprint；不能归到某个 Sprint。
- `queued` / `partial` / `postgres-pending` / `postgres-unavailable`：均不得宣称 Transcript 已完整同步。
- 最终以 `verdict.harnessUsed`、`transcriptCaptured`、`transcriptSynced`、`sprintTranscriptBound` 四个布尔值逐项回答，禁止把其中一个替代另一个。

PostgreSQL 检查只在本机 transcript sync 配置显式启用时发生；必须使用 reader URL，并验证 `transaction_read_only=true`。输出不得包含密码、token 或带口令的 URL。
