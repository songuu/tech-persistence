# Resume protocol

仅在 `active === true`、`reason === "sprint-recovery-required"` 或用户显式 `resume` 时读取。

1. 先运行状态 CLI 的 `status`；禁止自行改写 pointer、transaction 或 completed record。
2. `sprint-recovery-required`：它优先于 canonical pointer。停止 Phase；重试原 mutation 让 CLI 恢复，completion 仅重试 `complete --expected compound`。损坏记录需用户/运维处理，不降级扫描 handoff。
3. `active === true`：普通 `/sprint` 与显式 `resume` 都恢复 pointer 当前 Phase。只读计划、当前 Phase 片段和 `next` 证据；用 git/status/runtime 校验，不重跑已完成工作。
4. `missing-pointer`：普通 `/sprint` 新建，禁止扫描历史 unfinished plan；仅显式 `resume` 查 `docs/plans/.handoff/` 的 compact handoff。
5. `completed-sprint`：上一轮已终结，不恢复旧 Phase；新 sprint 的 `init` 会在新 pointer 安全发布后消费 record。
6. pointer/recovery JSON 损坏、版本、phase/plan、schema 或目标非法时阻塞，不覆盖或当作缺失。
7. 显式 resume 的 handoff fallback：
   - 0 个：请用户给计划路径或开始新 sprint。
   - 1 个：校验计划在 `docs/plans/`、存在、phase 合法且工作树事实一致，再运行 `init --plan <plan> --restore-phase <phase> --next <action>`。
   - 多个：列出计划、时间和 phase，请用户消歧，不自行选“最新”。
8. 重建或恢复后只用 `advance`、`block`、`complete`；禁止裸写任何状态记录。
