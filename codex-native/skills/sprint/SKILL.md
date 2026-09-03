---
name: sprint
description: Codex-native sprint state machine with phase-local loading and transactional recovery.
---

# Sprint

按 `think -> plan -> work -> review -> compound` 推进；本文件只管状态机，Phase 细节由同名 skill 提供。

## 渐进加载硬约束

- **只加载当前 Phase** 的 skill、计划片段和证据；plugin 与 direct fallback 不得重复加载。
- 不得预读、预热、启动或 spawn 未来 Phase；当前 Phase 验收并成功更新 pointer 后，才能加载下一 Phase。
- 仅 active/recovery/resume 读 `references/resume.md`；非 resume 的 `missing-pointer` 必读 `references/bootstrap.md`；仅 goal/Figma 输入读 `references/goal-loop.md`/`references/figma.md`。

## 状态工具硬约束

唯一权威 active pointer 是 `docs/plans/.handoff/active-sprint.json`；CLI 另维护有界 transaction/completed recovery record。全部**禁止裸写、patch、重定向或手工删除**，mutation 只调用 `codex-active-sprint-state.js`：

1. 从实际加载的 `sprint/SKILL.md` 定位 CLI，优先 `<skill-dir>/runtime/codex-active-sprint-state.js`；plugin-root 与 workspace script 仅为兼容/开发 fallback，不假定业务仓库自带 helper。
2. 先运行 `node <cli> status`。mutation 只用以下命令：

```text
node <cli> init --plan <plan> [--restore-phase <phase>] --next <action>
node <cli> bind-acceptance --run-dir <v1-run-dir> --control-root <authority-root>
node <cli> advance --expected <current> --to <adjacent> --next <action> [--control-root <authority-root>]
node <cli> block --expected <current> --reason <reason> --next <action>
node <cli> complete --expected compound
```

CLI 用持久 transaction、move-verify claim、exclusive-link、token/inode 锁实现 CAS；仅此协议受支持，裸写（含预开 FD）属外部破坏。协议内及可观察 path successor 不覆盖/删除。迁移仅 `think->plan->work->review->compound` 与 `review->work`；冲突停下重读。`SPRINT_STATE_LOCKED` 不按年龄删除，核验 owner 后仅用户/运维清 orphan。

新建 pointer 使用 `acceptance_protocol=v1`：`plan->work` 前必须把计划的 canonical acceptance marker 区块绑定到同内容的 frozen Agent Harness Contract；`review->compound` 前必须从外部 authority 读回同一 Contract 的 `passed` Receipt。旧 pointer 没有该字段时只按 `legacy` 打开，不隐式升级。Receipt 已写而 pointer transition 中断时，原 `advance` 可幂等重试，不能手改成完成。

## 启动与恢复

- `reason === "sprint-recovery-required"` 优先于 canonical pointer：停止 Phase；原 mutation 可安全重试，completion 只用 `complete --expected compound` 闭环，不手工清记录。
- `active === true`：普通 `/sprint` 与显式 `resume` 都恢复 pointer 当前 Phase，不扫描 handoff或重跑已完成 Phase。
- `reason === "missing-pointer"`（非 `resume`）：不是诊断终点；按 `references/bootstrap.md` 建新 sprint。仅 `resume` 查 compact handoff。
- `reason === "completed-sprint"`：上一轮已终结；新 sprint 可 `init`，CLI 在新 pointer 发布后消费 record，不恢复旧 Phase。
- `reason === "completed-plan"`：仅 phase=`compound` 且证据核对后运行 `complete`；其他 phase 阻塞校正。
- pointer/recovery 损坏、版本或路径非法均阻塞，不当作缺失或覆盖。新 plan 位于 `docs/plans/`；仅显式 resume 的唯一已验证 handoff 可用 `init --restore-phase`。

## 参数兼容

- `--caveman`：仅本次显式加载 frontmatter name 为 `caveman` 的 skill。
- `--auto`：验收满足后可自动进入下一 Phase，但不跳过测试、review、权限边界或 CAS。
- `--goal` / `--max-iter` / `--until`：读取 `references/goal-loop.md`；`--goal` 不隐含 `--auto`。

## 执行循环

1. **路由**：运行 `status`，按上述唯一规则判断新建/恢复；只读命中的 reference。
2. **Think / Plan / Work / Review / Compound**：每次只加载当前同名 skill。Review 有 finding 时用 `advance --expected review --to work` 回修；Phase 阻塞时用 `block` 保持当前 phase。
3. 每个 Phase 先验收，再用 `advance --expected ...` 更新 pointer；命令失败即停，不得口头假定已切换。
4. 目标、测试、未知项与遗留风险核对后，才用 `complete --expected compound` 原子终结并写 completed record；单命令、agent 返回或部分测试通过不算完成。
