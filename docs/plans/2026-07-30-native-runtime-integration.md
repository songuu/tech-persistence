---
title: "Codex × Claude Code 双原生执行面实施计划"
type: architecture-implementation-plan
status: completed
created: "2026-07-30"
updated: "2026-07-30"
tasks_total: 6
tasks_completed: 6
tags: [agent-loop, codex, claude-code, native-runtime, orchestration]
aliases: ["双原生执行面", "native runtime integration"]
---

# Codex × Claude Code 双原生执行面实施计划

> **Status:** `completed`
> **Source of truth:** 本文件记录人类可审阅的实施范围；运行证据仍由 `.agent-runs` 负责。

## 目标

保留 Tech Persistence 的契约、冻结、风险、锁、Memory 和证据能力，同时让 Codex 与 Claude Code 分别拥有其原生 Goal、Subagent、Worktree、Hook、Session/Thread 和结构化输出生命周期。

## 不变量

1. 一次运行只有一个调度 owner：`tp`、`codex-host`、`claude-host` 三选一。
2. 一个 task/slice 同时只有一个 writer。
3. `docs/plans` 与 `.agent-runs` 分别承担计划真源和运行证据真源；宿主 ID 只作 opaque ref。
4. 权限不跨 runtime 继承，接收方重新执行本地 policy。
5. 跨 runtime 只交换 hash-bound contract、commit/patch、diff、测试证据和 result envelope。
6. 产生副作用或已被宿主接受的 attempt 禁止静默切换 provider 重跑。

## 非目标

- 不把 Codex 或 Claude Code 包装成对方的 MCP 子代理。
- 不复制宿主 transcript、task list、mailbox 或 worktree 生命周期数据库。
- 不默认启用 Claude Agent Teams、Agent View、Remote Control 或 Codex App Server。
- 不让 hooks 自动写 durable Memory、推进业务状态或放宽权限。
- 不触碰当前工作树中部署站点相关的用户改动。

### 风险和假设

- 风险 L3：本次同时改变 command/skill 投影、provider lifecycle、结构化输出、跨 runtime handoff、外部锁与 Goal lease；任何 fail-open 都可能造成双 writer、错误接受或静默重跑。
- 假设 Codex 与 Claude Code 的原生 session/thread、agent、hook 和 worktree 生命周期继续由宿主拥有；Tech Persistence 只保存 opaque ref 与 hash-bound evidence。
- 假设 `shadow` 是安全默认；没有带时间和 probe/preflight 来源的 runtime observation 时，`enforce` 必须拒绝而不是从静态 profile 推断支持。

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| Claude command 与 Claude skill 可以继续同名投影 | Read `plugins/tech-persistence/scripts/build-codex-plugin.js`，运行 `test-claude-codex-skill-projection-boundary.js` | 假设不成立；Claude plugin `skills/` 仅保留 10 个真实 skill，22 个 command wrapper 只进入 Codex `codex-skills/`，overlap 为 0 |
| Codex 与 Claude 的成功退出码足以作为业务验收 | Read `runtime-adapters.js`、Codex 官方 JSONL 样例与负例测试 | 假设不成立；Claude 还需顶层 `result/success` 与 session id；Codex 需 `turn.completed` 与 thread id，官方不保证 turn id，因此它只作可选证据；业务 payload 不能伪造恢复 ref |
| runDir 内锁可以保护单 owner | Read `control-store.js` / `run-lock.js`，运行 lifecycle junction/deletion/forgery/alias 用例 | 假设不成立；权威 dispatch lock 与 Goal lease 必须位于 provider workspace 外；lexical locator 不可变绑定 canonical identity，同一 canonical run 的 aliases 原子复用唯一 authority；外部存储不可用时 fail-closed |
| CLI structured-output flag 可作为唯一 schema gate | 运行 `test-provider-structured-output.js` 与 `--skip-cli-schema` 负例 | 假设不成立；classic/pipeline 均在本地无依赖 strict validator 复验，slice planner 使用 `{slices:[...]}` batch schema |
| provider 成功后任意 post-process 失败可直接重跑 | 运行 native CLI / artifact lifecycle 负例 | 假设不成立；accepted 后失败写独立 failure artifact 并强制 reconcile，canonical accepted/rejected result 不得覆盖；partial effects 仅允许同 provider/stage 原生恢复 |
| Goal 在 dispatch 期间不会变化 | Read acceptance 路径并运行 Goal lease 测试 | 假设不成立；prepare 固定 lease revision，acceptance 前重读并校验 revision、run、objective 与 owner，冲突结果拒绝 |
| raw Git diff 足以绑定所有 handoff 内容 | 运行 lockfile、overflow、rename、managed-boundary、literal-pathspec 与 symlink 负例 | 假设不成立；非零 fail-closed，overflow 使用显式 marker；所有 tracked/staged path 绑定 HEAD/index/worktree，rename source、跨 managed 边界与 raw link payload 均进入摘要 |

## Task 1：修复 Claude command/skill 投影冲突

**风险：L3**

- Claude plugin `skills/` 只投影真实 Claude Skills。
- 兼容 commands 保留在 `commands/`。
- Codex command wrappers 直接生成到 `codex-skills/`。
- command/skill 同名 overlap 必须为 0。

## Task 2：控制权、能力快照与 envelope

**风险：L3；依赖 Task 1 的投影边界**

- 增加 `orchestrationOwner`。
- 能力快照区分 documented、runtime observed 和 policy allowed。
- 增加 task/result/provider-handoff/route-decision schema。
- idempotency key、single-writer、partial-effects/no-fallback 进入确定性契约。
- 旧 profile API 与历史 run 保持兼容读取。

## Task 3：双宿主原生角色与 hooks

**风险：L3；可与 Task 2 独立实现**

- 两端只提供 explorer、implementer、reviewer 三类原生角色。
- Subagent、Worktree、Hook 生命周期由宿主拥有。
- 首批 Codex lifecycle hooks 仅追加有界 evidence：
  `SubagentStart`、`SubagentStop`、`PostCompact`、`SessionEnd`。
- 无关联 run 时安全 no-op；不得自动学习、修改权限或推进状态机。

## Task 4：Headless adapters

**风险：L3；依赖 Task 2**

- Claude：安全默认使用 `-p` 并显式传 schema/settings；`--bare -p` 仅在调用方明确选择，或 enforce policy 已验证所需上下文均显式注入时启用。
- Codex：默认保留 `exec`；App Server 只提供 opt-in 接口与 capability gate。
- adapter 只负责 prepare/execute/normalize，不直接推进状态。
- classic 与 pipeline 共用同一参数和结果归一化路径。

## Task 5：Goal lease 与跨 runtime handoff

**风险：L3；依赖 Task 2–4**

- 同一 run 最多一个 active native Goal lease。
- 保存 objective hash、owner runtime 和 opaque host ref，不复制宿主状态。
- handoff 校验 contract hash、base/head SHA、diff/test evidence。
- 已 accepted 或存在 partial effects 时只能 resume/reconcile，禁止自动 fallback。

## Task 6：Canary、投影与完整验证

**风险：L3**

- 固定覆盖 single-host、cross-runtime read-only review、worktree handoff、resume、partial-effects 和 duplicate-result。
- 重建生成插件并验证源/投影 parity。
- 最终命令：

```text
node scripts/agent-orchestrator.js self-test
node scripts/run-tests.js
node plugins/tech-persistence/scripts/build-codex-plugin.js
node scripts/validate-codex-plugin.js
node scripts/pre-commit-check.js
git diff --check
git status --short --branch
```

## 完成记录（2026-07-30）

- Task 1：Claude plugin `skills/` 收敛为 10 个真实 skill；22 个 command wrapper 只投影到 Codex `codex-skills/`，同名 overlap 为 0。
- Task 2：capability snapshot/router、task/result/handoff/route envelopes、persisted execution policy 与 hash-bound acceptance 已落地；`unknown` 不授权，`shadow` 保持默认。
- Task 3：Claude/Codex 各有 explorer、implementer、reviewer 原生角色；Codex 首批四类 lifecycle hooks 仅追加 allowlisted、bounded、idempotent evidence。
- Task 4：Claude print/bare 与 Codex exec/App Server prepare-only adapter 共用 normalize/acceptance；provider schema flag 之后仍进行本地 strict validation；Codex 官方 JSONL 无 turn id 样例可验收。
- Task 5：外部 control store、canonical alias authority、dispatch lock、Goal revision CAS、native resume/reconcile、artifact realpath 与 immutable accepted artifacts 已落地；handoff 内容绑定覆盖 overflow、lockfile、rename、managed boundary、literal pathspec 与 symlink/junction payload。
- Task 6：离线 artifact-derived 六场景 canary、双宿主投影、插件全量重建和最终回归完成。

### 验证证据

- `node scripts/run-tests.js`：`53 pass / 0 fail / 53 total`。
- 核心定向：git diff integrity 33、runtime adapters 43、artifact lifecycle 26、provider lifecycle controls 13、Goal lease 29、structured output 12、native execution control 9、capability router 18、native canary 16、native hooks 9；native CLI integration 与 orchestrator self-test 通过。
- `node plugins/tech-persistence/scripts/build-codex-plugin.js`：22 commands、10 Claude skills、32 Codex skills、3+3 agents、23/22 hooks、26 utilities、16 schemas。
- `node scripts/validate-codex-plugin.js`、`node scripts/pre-commit-check.js`、`node scripts/smoke-pre-commit.js`（28/28）与 `git diff --check` 通过。
- 本机验证版本：Codex CLI `0.145.0`；Claude Code `2.1.220`；Codex `goals/hooks/multi_agent/plugins` stable+enabled，`multi_agent_v2` disabled。
- 验证边界：canary 与 provider 调用均为本地 fixture/offline evidence；未调用真实付费 Codex/Claude provider，App Server 仍是 opt-in prepare-only。

## 推广与回滚

- 所有新选择器先 `shadow`，`claude-print → codex-exec → claude-print` 的安全默认不变；非默认 adapter/policy 必须随 freeze 持久化，并在 resume 时继承或拒绝冲突覆盖。
- Codex App Server、Claude Dynamic Workflow 和 native Goal binding 均保持 opt-in。
- 仅在已证明 `effectsState=none` 且没有 accepted result 时允许显式回退；partial/unknown/accepted attempt 只能由同一 provider resume 或进入人工 reconcile。
- 生成副本不得手改；回滚 canonical source 后重新 build/validate。
