# Resume protocol

仅在 `active === true`、`reason === "sprint-recovery-required"` 或用户显式 `resume` 时读取。

1. 先运行状态 CLI 的 `status`；禁止自行改写 pointer、transaction 或 completed record。
2. `sprint-recovery-required`：它优先于 canonical pointer。停止 Phase；重试原 mutation 让 CLI 恢复，completion 仅重试 `complete --expected compound`，supersession 仅用完全相同的 hash/evidence 参数重试 `supersede`。损坏记录需用户/运维处理，不降级扫描 handoff。
3. `active === true`：普通 `/sprint` 与显式 `resume` 都恢复 pointer 当前 Phase。只读计划、当前 Phase 片段和 `next` 证据；用 git/status/runtime 校验，不重跑已完成工作。
4. `missing-pointer`：普通 `/sprint` 新建，禁止扫描历史 unfinished plan；仅显式 `resume` 查 `docs/plans/.handoff/` 的 compact handoff。
5. `completed-sprint`：上一轮已终结，不恢复旧 Phase；新 sprint 的 `init` 先验证并 claim 旧 record，再发布新 pointer，最后退休旧证据。发布失败时保留或恢复旧 record。
6. pointer/recovery JSON 损坏、版本、phase/plan、schema 或目标非法时阻塞，不覆盖或当作缺失。
7. 显式 resume 的 handoff fallback：
   - 0 个：请用户给计划路径或开始新 sprint。
   - 1 个：校验计划在 `docs/plans/`、存在、phase 合法且工作树事实一致，再运行 `init --plan <plan> --restore-phase <phase> --next <action>`。
   - 多个：列出计划、时间和 phase，请用户消歧，不自行选“最新”。
8. 重建或恢复后只用 `advance`、`block`、`complete`；只有 owner 明确批准且 `compound/blocked` 计划仍含开放任务时才用受限 `supersede`，禁止裸写任何状态记录。

## Supersede（仅显式 owner 批准）

这里的 approval JSON 只提供本地主机范围内、可重放校验的审计元数据；runtime
只验证字段自洽及其与 pointer、计划、task-map、next 的绑定，不读取或认证真实聊天消息。
任何有同一 workspace 写权限的进程都不在此 CLI 的安全边界内，因此可信宿主或调用方
必须先从真实 owner 消息取得授权，再创建该文件。不得把它当作密码学身份、权限提升
控制或生产变更授权。

```text
node <cli> prepare-supersede-proposal --expected compound --expected-pointer-sha256 <sha256> --old-plan-sha256 <sha256> --plan <successor-plan> --new-plan-sha256 <sha256> --task-map <handoff-json> --task-map-sha256 <sha256> --approval-receipt <handoff-json> --approval-sha256 <sha256> --next <action>
node <cli> supersede --expected compound --expected-pointer-sha256 <sha256> --old-plan-sha256 <sha256> --plan <successor-plan> --new-plan-sha256 <sha256> --task-map <handoff-json> --task-map-sha256 <sha256> --approval-receipt <handoff-json> --approval-sha256 <sha256> --migration-receipt <handoff/active-sprint.migration-receipt-<sha256>.json> --migration-receipt-sha256 <sha256> --next <action>
```

命令只允许 `compound/blocked -> think/active/v1`。新旧计划 frontmatter 必须用 canonical JSON 数组声明 `task_ids` 与 `open_task_ids`；runtime 从已 hash 的计划字段逐 ID 校验任务映射，不能只校验数量。`message_locator.locator` 必须精确等于 `thread:<thread_id>#message-sha256:<message_sha256>`。

先运行零写入的 `prepare-supersede-proposal`。成功输出 `receipt.{path,sha256,raw,value}`；调用方必须把 `raw` **逐字节**以 UTF-8、单个结尾 LF 安装到 `path`，并把同一 `path/sha256` 传给 `supersede`。禁止重排 JSON、pretty-print、改时间或改名。proposal 本身不是提交，只有 pointer CAS 引用该 digest 才表示 supersede 已发生。

v2 `value` exact schema：顶层为 `schema_version/kind/source/target/task_map/approval/previous_migration_receipt_sha256/prepared_at/goal_preserved`；`source` 绑定旧 pointer raw/hash/object、计划 hash、计数及开放 ID；`target` 绑定新计划 hash、`think/active/v1`、计数与 `next`；`task_map`、`approval` 均内嵌 `{path,sha256,value}`。编码固定为 `JSON.stringify(value) + "\n"`，文件名固定为 `active-sprint.migration-receipt-<sha256(raw)>.json`。

runtime 对 proposal 永远只读，不创建、覆盖或删除；两条入口共享计划、任务映射、approval 与 previous-lineage 验证，且按真实 CLI 时钟重验 approval TTL。`prepared_at` 必须处于可信校验偏差内。恢复只接受完全相同的 hash/evidence/receipt/next；其他 mutation 保留 WAL 并失败闭合。旧计划保持未完成，`advance`/`block` 保留 lineage。`host-observed` 只是本地主机审计证据，不是密码学签名或生产授权。

## Completion 终态与旧 WAL

若计划声明任一任务元数据，则 `tasks_completed/tasks_total` 必须同时存在、为 canonical 非负整数且相等；若声明 `task_ids/open_task_ids`，二者必须同时存在、与总数一致且开放集合为空。新 completion WAL/record 绑定计划 SHA-256 并在 claim、publish、cleanup 与 status 复验；未知字段、非 canonical record、计划漂移均失败闭合。升级前未提交的 v1-v4 completion WAL 不得按新门禁推断完成；只有已发布且与旧 WAL 全字段匹配的历史 v1 record 可继续收敛，否则保留证据交由运维处理。

### Legacy v4 operator repair

旧 v4 WAL 的 receipt 已完整存在时，按原 supersede 全参数重试。若 receipt 缺失或半写，runtime 不从 WAL 自动写回：先运行 `node <cli> inspect-v4-supersede-recovery`，它只对已完整解析的 v4 `mode=prepare` WAL 输出精确 `{path, sha256, raw}` 且零状态 mutation。运维需独立确认 WAL owner/来源，将冲突的半文件隔离，再把 `raw` 原样安装到输出的内容寻址路径；随后用完全相同的 supersede 参数重试。错误 bytes、错误文件名、symlink、损坏或非 v4 WAL 一律保留并失败闭合。
