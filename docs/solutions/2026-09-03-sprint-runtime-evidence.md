---
title: "Sprint 中 Harness 与 Transcript 的使用必须分层核证"
date: 2026-09-03
tags: [solution, sprint, harness, transcript, postgresql, evidence]
related_instincts: []
aliases: ["Sprint evidence", "Harness Transcript 接入核验"]
---

# Sprint 中 Harness 与 Transcript 的使用必须分层核证

## Problem

用户无法从普通 `/sprint` 输出判断某次执行是否真实经过 Harness，也无法区分 Transcript 只是存在于宿主本地、已进入 outbox、获得 ack、已写入 PostgreSQL，还是确实与该 Sprint 绑定。

## Root Cause

执行、捕获、持久化和关联是四个不同事实。provider 自报、terminal success、本地 JSONL 存在或数据库中存在某条 transcript，单独都不能证明完整接入；若折叠为一个 `integrated` 状态，会把部分完成误报为完整完成。

## Solution

新增只读 `/sprint evidence`，以 active pointer 或显式 `--plan` 为关联锚点。helper 分别读取并验证：

- Sprint Acceptance binding、provider envelope hash 和外部 Receipt；
- Harness runtime transcript job 与不可变 ack；
- 当前 Codex session 的原始 JSONL；
- 显式启用 transcript sync 时，由 PostgreSQL reader 身份做 exact readback，并确认 `transaction_read_only=true`。

输出保持四个独立 verdict：`harnessUsed`、`transcriptCaptured`、`transcriptSynced`、`sprintTranscriptBound`。没有 active Sprint 时，即使当前宿主 JSONL 存在或已经同步，也只能标为 `unbound-local` / `unbound-synced`。`queued`、`partial`、`postgres-pending` 和 `postgres-unavailable` 都不能宣称同步完成。

实现不修改 pointer、plan、run、outbox、ack 或数据库；只接受受限计划路径和有界普通 evidence 文件。人类摘要与 `--json` 均不返回密码、token 或带口令 URL。命令源、Codex-native 按需 reference、Claude skill、项目 fallback、plugin utility 和 validator 已同步。

## Prevention

- 任何“已接入 Harness/Transcript”结论都逐项报告执行、捕获、同步和 Sprint 绑定。
- Acceptance binding 不等于 provider execution；本地 Transcript 不等于 PostgreSQL 持久化。
- PostgreSQL 核证只使用 reader role；连接失败或 readback 不一致保持失败闭合。
- evidence helper 不得隐式 bootstrap/advance Sprint，也不得消费待同步作业来制造成功结果。

## Related

- [[2026-08-27-agent-harness-requirement-alignment]]
- [[2026-09-02-harness-transcript-production-wiring]]
- [[2026-09-03-sprint-runtime-portability]]
