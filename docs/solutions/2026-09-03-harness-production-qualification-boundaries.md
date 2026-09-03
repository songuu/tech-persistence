---
title: "Harness 生产资格中的 OS 能力与 Transcript 消费边界"
date: 2026-09-03
tags: [solution, harness, transcript, linux, systemd, postgresql]
related_instincts: []
aliases: ["Harness v15 qualification", "task transcript spool wiring"]
---

# Harness 生产资格中的 OS 能力与 Transcript 消费边界

## Problem

受控 Linux 上的任务可以入队，但 provider 启动或 Transcript 最终同步会停滞；单独的模型 canary、旧 Transcript timer 绿色和 HTTP 200 都不能证明登录任务全链路完成。

## Debug Journal

- [2026-09] [Linux capability] **systemd 进程约束阻断固定身份 launcher**
  - 现象：worker 能 claim，provider 在身份切换前失败；工作区权限测量与运行用户不一致。
  - 误导方向：最初集中检查模型响应和 provider 配置。
  - 排查路径：分别检查 worker `CapEff`、unit sandbox、launcher file capability、workspace owner/mode，并运行 authority secret/跨任务可见性负向测试。
  - 根因：`RestrictAddressFamilies` 隐式引入的 no-new-privileges 与固定 capability launcher 冲突；同时工作区创建前后的 umask/owner 不满足 provider 身份。
  - 解决：worker unit 显式 `NoNewPrivileges=no` 并移除该隐式冲突约束；Node worker 仍保持 `CapEff=0`，仅不可变、receipt/hash 绑定的 launcher 持有最小能力；authority 创建后、provider 运行前分别校正目录权限。
  - 预防：资格测试必须同时证明 worker 无能力、launcher hash 绑定、provider 看不到 authority secret/其他任务、进程树可终止。

- [2026-09] [Transcript/PostgreSQL] **旧同步 timer 不消费任务 runtime spool**
  - 现象：任务已 `succeeded/completed`，但页面 Transcript 长期不是 `synced`。
  - 误导方向：既有 `tech-persistence-transcripts.timer` active，容易误判所有 outbox 都被消费。
  - 排查路径：对比 unit 的 source root 与 worker 实际写入的 `task-runtime/transcript-spool`，检查 job/ack 计数和 PostgreSQL 独立读回。
  - 根因：旧 timer 只消费 authority Codex transcript 目录；Harness worker 使用独立 spool，缺少对应 consumer unit。
  - 解决：新增 `tech-persistence-harness-transcripts.service/timer`，固定 v15 runtime 和私有 PG env；首次消费 79 jobs、0 fail，真实资格任务读回 3 events 并 ack。标准安装/恢复脚本同步写入并启用该 unit。
  - 预防：每个 durable outbox producer 必须在发布清单中显式绑定唯一 consumer、source root、ack root 和独立 reader 验证，不能用“某个 timer active”作替代证据。

## Root Cause

两类问题都来自“组件存在”与“端到端边界相连”被混为一谈：systemd 表面硬化项改变了 capability 语义；通用 Transcript timer 与任务 spool 的路径契约并不相同。

## Solution

发布资格改为真实登录主体任务驱动：create/enqueue → authority claim → capability-bound provider → Acceptance/user-confirmation → hash-only spool → 独立 PostgreSQL writer/readback → ack。v15 样本 `386bbf93-3e1b-4eab-8037-2c8f30d97de4` 为 `succeeded/completed`，Transcript `eventCount=3`。

EvidenceRef：runtime receipt `sha256:ec37783c53f7e3aee4355a949adb02bd76f7c609f3c2a079a6fe9d2f73c7853d`；capability evidence `sha256:48e45ac8aca811d79e6e7949256c670d0ae9ccf89ddfe5bdd1e97616bbd99390`；scope 为 `47.253.230.197` 的 v15 Harness release，captured_at `2026-09-03`，disposition 为 production-qualified。历史失败样本仍保留，未改写。

受治理候选草案（needs-review，尚未获得 native-host EvidenceRef capture，未提交 canonical propose）：`systemd-hardening-must-preserve-required-capability-transition`（anti_pattern）与 `outbox-producer-consumer-path-must-be-release-qualified`（strategy）。反例是普通无特权服务不需要 capability transition，或同一 consumer 明确覆盖多个已声明 source；因此不自动发布为全局规则。

## Prevention

部署门必须验证不可变 release/hash、真实 OS identity、负向隔离、生产 API/TLS、Acceptance authority、spool/ack 以及独立数据库读回；恢复脚本必须与首次安装脚本包含同一 consumer inventory。

## Related

- [[2026-09-02-authenticated-harness-tasks]]
- [[2026-09-02-harness-transcript-production-wiring]]
- [[2026-09-02-harness-wiring-evidence-boundaries]]
- [[session-2026-09-03]]
