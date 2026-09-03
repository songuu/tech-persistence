---
title: "外部 Runtime 真实 canary、只读晋级与 PostgreSQL 证据闭环"
date: 2026-09-01
tags: [solution, agent-harness, runtime, postgresql, deployment]
related_instincts: []
aliases: ["P3 live promotion", "llama.cpp read-only runtime"]
---

# 外部 Runtime 真实 canary、只读晋级与 PostgreSQL 证据闭环

## Problem

外部 OpenAI-compatible runtime 需要在受控 Linux 宿主真实运行，同时不能把健康探测、自报成功或可伪造的旧 canary 当作 writer 授权证据。

## Root Cause

协议兼容不等于能力和身份可信；若 repo-read 只由 harness 本地读取，或 promotion receipt 不绑定 canary receipt，同一个晋级结果可被不同样本复用。数据库写入若没有独立 reader 精确回读，也只能证明 writer 自报。

## Solution

- 固定 llama.cpp `b10621` 与 GGUF SHA-256，在宿主 ABI 上构建，systemd 服务仅监听 loopback，并限制内存和文件系统权限。
- 固定 9-case canary；repo-read 将输入内容 SHA-256 交给模型并要求精确回显，使模型响应与有界仓库内容绑定。
- promotion core 强制包含 `canaryReceiptHash`，任何 receipt 缺失、哈希格式错误、用例不全、identity/effect mismatch 都保持 shadow。
- 外部 runtime 只晋级 read-only，`writerEligible=false`；多 candidate 路由仍保证唯一 writer，出现 partial/committed effects 后不得切换。
- hash-only transcript 进入 durable outbox；PostgreSQL writer 事务提交后，由独立只读身份按 canonical payload/hash 精确读回。重复任务插入为零，数据库不可达时 outbox 不 ack。
- PostgreSQL 首次部分初始化不删除，移动到带时间戳 quarantine 后重新初始化，保留恢复与审计可能。

最终 canary receipt 为 `sha256:5bd608f61ab2642e44e4b050b4cce074fc5fb9ba57906f9f73178521ad42eee5`，绑定后的 read-only promotion receipt 为 `sha256:248d5ab08fb3d31780847b904b66f06bd71947fe03253394d6ff2d5d424b0dbf`。

## Prevention

- Schema 回归必须验证真实 `sha256:` receipt，而非只测对象字段。
- 任何新 runtime promotion 都必须生成新的、绑定 canary receipt 的不可覆盖文件。
- health/ready、结构化输出、内容读取、effect 与数据库 durability 分开验收。
- writer 晋级必须另立计划和证据门，不能从 read-only promotion 推导。

## Related

- [[2026-08-27-agent-harness-requirement-alignment]]
- [[session-2026-09-01]]
