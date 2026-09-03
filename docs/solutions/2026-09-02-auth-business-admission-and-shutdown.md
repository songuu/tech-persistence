---
title: "认证请求必须限制未完成业务，而非只限制连接"
date: 2026-09-02
tags: [solution, authentication, postgres, security, testing]
related_instincts: []
aliases: ["Authentication admission and shutdown"]
---

# 认证资源与退出边界

## Problem

连接数限制不能约束客户端断开后仍在等待 PostgreSQL 的业务请求。认证服务还需要验证事务快照、接收期限和关闭失败，而不仅是登录成功/失败。

## Root Cause

- `maxConnections` 只约束存活 socket，`pg.Pool.max` 只约束连接，不约束队列。攻击者可反复断开释放 socket 并继续排队。
- 默认 REPEATABLE READ 时，等待 advisory lock 之前取得的快照不会在获锁后更新，按会话计数的上限判断可能重复放行。
- Node 的 requestTimeout 检查周期默认远大于设置的期限；空闲超时不能阻止持续 trickle body。
- 关闭 Promise 不处理拒绝会泄漏错误；未完成 Promise 不保持 event loop，unref 的关闭期限可导致错误的退出 0。

## Solution

- 全部认证请求共用 16 个业务名额，finally 等到异步操作结束才释放；不使用 socket close 作为业务完成依据。密码校验另限 2 并发。
- PG 短事务显式 `BEGIN ISOLATION LEVEL READ COMMITTED`，持锁后的计数查询看见前一持有者提交；真实测试以两个默认 REPEATABLE READ 客户端构造竞争。
- HTTP 接收期限 5 秒、检查周期 250 ms；真实 trickle 请求检查未进入密码校验且在期限附近被关闭。
- 服务关闭显式 catch、固定脱敏日志、失败非零，保留 referenced 5 秒 deadline。子进程测试覆盖正常/重复信号、关闭拒绝和永不完成。

## Evidence

- HTTP 断开反例：修前 60 次全部准入，修后 16。独立 200 请求复测：184 个 429，仅 16 个进行中业务、12 个 pool waiter。
- 真实 PostgreSQL：旧快照反例先 RED，修后 13 组通过；仅独立临时数据库，清理前 owner/marker 校验。
- Linux：认证 30/30、存储 12/12、配置/CLI 22/22；Windows 仅两项 POSIX 测试跳过。源码哈希与实测目录一致。
- 完整记录：[[2026-09-02-harness-web-auth-a1-verification]]。

## Prevention

将请求、数据库工作和进程生命周期分开建模。任何完成声明必须对应真实业务 Promise、数据库状态和退出码，不以 socket 消失或未报错为替代。

## Learning governance

这是已验证工程经验的候选沉淀，不是 native-host authority EvidenceRef；不自动创建或晋级本能/永久学习规则。候选 `socket-limit-is-not-business-admission` 和 `shutdown-promise-needs-explicit-outcome` 保持 needs-review。当前只完成 A1 身份底座，不能推导 Harness 公网任务已完整验收。

## Related

- [[2026-09-02-authenticated-harness-tasks]]
- [[2026-09-02-harness-web-auth-a1-verification]]
- [[2026-09-02-harness-wiring-evidence-boundaries]]
