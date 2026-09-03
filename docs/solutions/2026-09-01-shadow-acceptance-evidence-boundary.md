---
title: "Shadow 验收不能把自报 assessment 升级为 verified evidence"
date: "2026-09-01"
tags: [solution, agent-harness, acceptance, evidence, shadow, security]
related_instincts: []
aliases: ["system-owned acceptance receipt", "shadow acceptance trust boundary"]
status: in-progress
sources:
  - "docs/plans/2026-08-27-agent-harness-requirement-alignment.md"
---

# Shadow 验收不能把自报 assessment 升级为 verified evidence

## Problem

Acceptance Contract/Receipt 的 canonical hash、exact coverage 和 Oracle 绑定都正确时，provider 仍可在
assessment JSON 中自报 `exitCode=0`、`withinRoot=true` 或伪造独立 identity，制造看似 verified 的 Receipt。
这不会在 shadow 阶段直接改变完成态，却会污染 measure-before-enforce 的 Gate B-1 分布。

## Root Cause

Hash 只能证明 payload 自洽，不能证明 evidence 的来源权威。把 evidence 的 locator、观测事实和最终判定
放在同一份 provider-writable JSON 中，相当于让被验收者同时担任证据生产者与裁判。另一个易漏点是：
best-effort shadow 写盘若在权威 state transition 前抛错，也会反向改变 legacy 状态机的可达终态。

## Solution

- Contract/Receipt 原语机械强制 exact coverage、`subjectRef === subject.ref`、Oracle hash 绑定，以及
  `passed => 至少一个类型匹配的 verified evidence`。
- Receipt 路径同时包含 contract 与 subject identity；projection 原子替换，静态拒绝 run root 内的
  symlink/junction，所有 shadow 异常在调用边界降级为非权威诊断。
- freeze 已由 orchestrator 生成 Contract；classic/slice/integration 在具备权威 command validation 或 artifact
  readback 时可写 verified pass/fail Receipt，其余尚无 adapter 的 Oracle 保持 unknown。assessment、
  provider 可写的 validation/log，以及公开 API 注入的 runtimeEvidence 都只能是 claim。失败重跑先使旧
  success projection 失效，统计器按 Contract/subject/Receipt 去重并对重复样本 fail-closed。
- command validation 会在 reviewer 启动前把 attempt、artifact/log hashes 与 contract 封存到
  provider workspace 之外、由 harness 管理的 external control store；seal 同时绑定验证时的 worktree/diff
  snapshot。首次显式 `--validation-command` 保持 operator-command 兼容语义；reviewer 返回后的额外复验才会
  对整批命令做 policy preflight，并以 argv + `shell:false` 重新执行 policy-approved command，封存独立的 post-review
  validation，因此 tracked、ignored 或依赖目录变化都不能沿用 pre-review 结果。seal 首次用于 Receipt 时再单次
  绑定 subject，跨 subject 重放被拒绝。该 authority 边界仍依赖宿主 sandbox/权限配置，不宣称仅凭路径隔离
  即可阻止同 OS 用户的恶意 provider 直接写 external store；未建立机械隔离前 P1-4 不得标完成。
  artifact Oracle 仅识别 `artifact:<workdir-relative-path>`。freeze 在 external store 封存 missing/present 基线；
  reviewer 后从 canonical workdir 做最大 16 MiB 的有界读回，拒绝路径逃逸、symlink/junction、非普通文件和
  读期间变化。reviewer 启动前，harness 捕获 changed-files effect scope hash 并写入 accepted review subject；
  Receipt 阶段 scope 被改写、目标不在 scope 内或 reviewer 前后 workspace snapshot 漂移时保持 unknown。新建或 digest 变化为 passed，当前缺失为 failed，
  未变化/不安全/不可读为 unknown；seal 将 baseline/current/effect scope 与 contract+subject 绑定，Receipt/report
  会复算 seal、Oracle、scope hash 和 evidence digest。
  freeze 同时在 external store 写 expected-sample marker，报告按 marker/ledger 枚举 cohort；缺 Contract、缺
  Receipt 目录或空 Receipt 目录均显式报错，不能通过删除 workspace artifact 退出样本集。明确放弃或评估前
  被替代的样本只能由仓库外固定 lifecycle broker 授权 immutable tombstone；它绑定 stable run locator、Contract、
  expected marker、受限 reason 和 operator event，且只能在没有任何 Receipt authority 时创建。report 复算全部
  binding/hash 后才排除，tombstone+Receipt、篡改、缺 marker/Contract 或竞态一律 fail closed。实际 tombstone 会改变
  Gate B-1 分母，仍是显式治理动作；本轮没有排除现有真实 run。
  Receipt authority ledger 同样外置，离线报告不扫描 workdir projection。readback、independent-review 与
  user-confirmation 已分别通过固定仓库外 broker 落地。harness 只发送稳定 run locator 和冻结的
  contract/subject/criterion/Oracle binding，要求 exact-shape 回包、不同的 reader/reviewer 与 writer identity，以及
  matched 或逐 criterion decision 和 result digest；broker 执行前后字节摘要或文件 identity 变化即拒绝。两类 broker
  子进程只继承有界的最小系统环境，不继承任意 API token、用户目录或数据库 URL。结果写入 external system-owned seal，
  Receipt 与离线报告分别复算 seal、coverage、binding、verdict 和 evidence digest。provider assessment、同身份自读/自审、
  错误 run locator、binding 漂移和 broker 失败仍为 unknown；既有 summary-only `review.json` 不具备 authority。
  PostgreSQL authority 参考 sibling Agent 的独立 reader/writer、TLS、最小授权和 transaction→commit→independent
  readback 模式，使用 append-only ledger。公开 broker 只允许 Receipt/canary，不能写 criterion seal；canary 也不能
  满足 criterion Oracle。user-confirmation 额外要求既有 Codex native control envelope 中的 canonical
  `confirm-acceptance` action，精确绑定 contract/subject/criterion/Oracle hash 与 accepted/rejected decision；普通语言、
  非 canonical JSON 与 provider 自报不能生成 verified evidence。用户看到 subject 后才提交的确认通过 append-only
  Receipt successor chain 收敛：保留 unknown genesis，新增 sequence/predecessor authority record，且只允许
  user-confirmation unknown→passed/failed；claim 漂移、终态反转、fork/gap 或 predecessor 篡改全部 fail closed，report
  验证整链后只统计唯一 head。
  Claude parity、OS 服务账户边界和真实样本完成前，
  P1-4 与 Gate B-1 保持 blocked，不能用手工 fixture 假装真实分布。

## 调试证据日志

- [2026-09] [agent-loop/pipeline] **仅剩 running slice 时 advance loop 停滞**
  - 现象：真实 pipeline E2E 在 slice implementation 后不进入 slice review/integration。
  - 误导方向：最初表现像 provider 输出或 completion gate 未满足。
  - 排查路径：读取 queue/state 持久化产物，确认 slice 已在 `queue.running`；再沿 advance loop 的选取表达式建立单 slice 最小回归。
  - 根因：`hasActiveWork()` 把 `running` 视为活动工作，但调度选择只读取 `ready/pending`，状态判断与消费集合不一致。
  - 解决：选择顺序补入 `q.running[0]`，让已实现、待 review 的 slice 可恢复推进。
  - 预防：队列活性谓词与调度候选必须覆盖同一状态集合；真实 CLI E2E 保留单 slice 从 implementation 到 review 的回归。
  - 证据：`scripts/agent-orchestrator/pipeline.js` (`sha256:2c315aa41701d7303e820fe8f05051a90744861a2f3d9a463906d6412ecc0f4e`)；`scripts/test-agent-orchestrator-native-cli.js` (`sha256:d2e564a893299ed215b0ad2b8feed41c34c6aba32c7424b50b7762e3175781b6`)；`node scripts/test-agent-orchestrator-native-cli.js` 通过。
  - 治理状态：本轮没有可用的 native-host EvidenceRef capture，未伪造 authority，也未自动创建/晋级 LearningCandidate；保留为 `needs-review` 候选。

## Prevention

审查任何 “system-owned receipt” 时，至少做四条反例：只有自报成功但没有真实 artifact 时应为 unknown；
shadow 目录不可写或被 symlink 替换时权威终态不变；从真实 CLI/provider 链路启动且不预置 Contract 时，
应能证明 producer 是否真的存在；readback 的 binding、reader/writer identity 或 broker bytes 任一漂移时不能 verified。
source 与所有 plugin runtime 投影还必须做字节或行为 parity 校验。

## Related

- [[2026-08-27-agent-harness-requirement-alignment]]
- [[2026-08-21-user-behavior-self-learning-p0]]
- [[session-2026-09-01]]
