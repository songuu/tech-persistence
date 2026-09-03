---
title: "Agent Harness authority 部署与 fail-closed Runtime 晋级"
date: 2026-09-01
tags: [solution, agent-harness, authority, postgresql, deployment]
related_instincts: []
aliases: ["Gate B-1 production closeout", "Provider authority isolation"]
---

# Agent Harness authority 部署与 fail-closed Runtime 晋级

## Problem

Harness 需要证明验收结果来自独立 authority，同时保持 Claude/Codex parity，并防止尚未就绪的外部 Runtime 获得写权限。

## Root Cause

同一 OS 身份、provider 可写目录中的 broker、summary-only review 或未绑定合同的确认都不能证明业务验收；外部服务仅有 `/health` 也不等于具备可晋级能力。

## Solution

在受控 Linux 宿主使用独立 `tp-authority`/`tp-provider` nologin 身份、固定 capability launcher 和反向 ACL 审计；Receipt 由 append-only PostgreSQL writer 写入并由独立 reader 精确回读。Claude 与 Codex 共用 exact-shape `confirm-acceptance` 协议。Gate B-1 用真实 harness cohort 量化为 5 passed / 2 failed / 3 unknown。外部 OpenAI-compatible Runtime 先以 checked-in descriptor 进入 shadow，只有 registry、observed capability、固定 canary、零副作用、环境 allowlist 和显式 promotion receipt 同时成立时才允许 read-only，writer 晋级还需后续独立门禁。

## Prevention

- 把 `/ready`、凭据 allowlist 和真实 transcript fixture 作为 live promotion 的证据，不用配置存在或 `/health` 代替。
- authority code、broker 和私密 env 必须位于 provider workspace 外。
- 合同语义变更必须生成新 hash、归档旧合同，并按 criterion 影响面重开；旧 Receipt 永远不能满足新合同。
- 全量测试需要同时报告新增 focused 结果与已知平台基线，不能把 Windows 8.3 路径失败归因给本轮功能。

## Related

- [[2026-08-27-agent-harness-requirement-alignment]]
- [[session-2026-09-01]]
