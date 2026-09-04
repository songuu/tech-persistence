---
name: sprint
description: Codex-native sprint state machine with phase-local loading and transactional recovery.
---

# Sprint

按 `think -> plan -> work -> review -> compound` 推进；本文件只管状态机，Phase 细节由同名 skill 提供。

## 渐进加载

- **只加载当前 Phase** 的 skill、计划片段和证据；plugin 与 direct fallback 不得重复加载。
- 不得预读或预热未来 Phase；当前 Phase 验收并成功更新 pointer 后才能加载下一 Phase。
- 仅 active/recovery/resume 读 `references/resume.md`；非 resume 的 `missing-pointer` 必读 `references/bootstrap.md`。
- 仅 goal 输入读 `references/goal-loop.md`；仅 Figma 输入读 `references/figma.md`。
- Provider/runtime 路由必须读 `references/runtime-portability.md`。
- 仅 `evidence` 子命令读 `references/evidence.md`；它只汇总证据，不启动或推进 Sprint。

## 状态工具

唯一权威 pointer 是 `docs/plans/.handoff/active-sprint.json`。状态 mutation **禁止裸写**、patch、重定向或手工删除，只调用 `codex-active-sprint-state.js`：

1. 从实际加载的 `sprint/SKILL.md` 定位 CLI，优先 `<skill-dir>/runtime/codex-active-sprint-state.js`；plugin-root/workspace script 仅为兼容 fallback。
2. 先运行 `node <cli> status`，mutation 只用：

```text
node <cli> init --plan <plan> [--restore-phase <phase>] --next <action>
node <cli> bind-acceptance --run-dir <v1-run-dir> --control-root <authority-root>
node <cli> advance --expected <current> --to <adjacent> --next <action> [--control-root <authority-root>]
node <cli> block --expected <current> --reason <reason> --next <action>
node <cli> complete --expected compound
```

CLI 以持久 transaction、move-verify claim、exclusive-link 和 token/inode 锁实现 CAS；裸写（含预开 FD）属外部破坏。只允许 `think->plan->work->review->compound` 与 `review->work`；冲突停下重读。`SPRINT_STATE_LOCKED` 不按年龄删除，核验 owner 后仅用户/运维清 orphan。

新 pointer 使用 `acceptance_protocol=v1`；Harness 是显式可选增强，未绑定时由当前宿主推进。只有用户显式 `bind-acceptance` 后才启用 Contract/Receipt 外部门，绑定存在则失败闭合。详见 `runtime-portability.md`。旧 pointer 按 `legacy` 打开。

## 启动与恢复

- `reason === "sprint-recovery-required"`：停止 Phase，重试原 mutation；completion 只用 `complete --expected compound`。
- `active === true`：普通 `/sprint` 与 `resume` 都恢复 pointer 当前 Phase，不扫描 handoff 或重跑已完成 Phase。
- `reason === "missing-pointer"`（非 resume）：不是诊断终点；按 `references/bootstrap.md` 建新 sprint。
- `reason === "completed-sprint"`：新 sprint 可 `init`；CLI 发布新 pointer 后消费旧 record。
- `reason === "completed-plan"`：仅 phase=`compound` 且证据核对后运行 `complete`。
- pointer/recovery 损坏、版本或路径非法均阻塞；仅显式 resume 的已验证 handoff 可 `init --restore-phase`。

## 参数兼容

- `--caveman`：仅本次显式加载 frontmatter name 为 `caveman` 的 skill。
- `--auto`：验收满足后可自动进入下一 Phase，但不跳过测试、review、权限边界或 CAS。
- `--goal` / `--max-iter` / `--until`：读 `references/goal-loop.md`；`--goal` 不隐含 `--auto`。

## 执行循环

1. 运行 `status` 并按唯一规则新建/恢复；只读命中的 reference。
2. 每次只加载当前 Phase skill。Review finding 用 `advance --expected review --to work` 回修；阻塞用 `block`。
3. 每个 Phase 先验收，再 `advance --expected ...`；命令失败即停，不口头假定切换成功。
4. 目标、测试、未知项与风险核对后，才 `complete --expected compound`；单命令、agent 返回或部分测试通过不算完成。
