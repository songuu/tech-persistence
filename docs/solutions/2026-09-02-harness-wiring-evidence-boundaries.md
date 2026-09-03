---
title: "Harness 接线不能用 canary、路径或数据库计数替代真实工作流证据"
date: 2026-09-02
tags: [solution, harness, transcript, security, testing]
related_instincts: []
aliases: ["Harness production wiring evidence"]
---

# Harness 工作流证据边界

## Problem

独立外部 runtime canary、手工 transcript 导入成功，曾被扩大解释为 Harness/Transcript 已完整接入。实际主 dispatch、自动采集、增长 cursor 和 worker 均存在缺口。

## Root Cause

协议适配、单点样本与真实工作流是不同证据层。文件路径不代表模型已读文件；表头 hash/count 不代表事件内容正确；真实模型小 canary 通过不代表完整 spec 能在资源预算内完成。

## Solution

- 在主 registry/profile/route/dispatch/result 接入外部只读 runtime，保留原 writer 和状态所有权。
- authority 配置与 endpoint/model/canary/promotion hash 绑定；实际文件上下文通过 Linux fd 路径和 inode 检查，有界读取，拒绝不完整 diff。
- 请求先落盘；job/ack 原子发布；worker 公平轮转、隔离坏项、事务内锁定 cursor、逐条独立 reader 精确比较。
- 用真实 CLI 覆盖 classic spec/review、pipeline slice/integration review；注入请求/terminal 落盘失败、半帧、坏 ack、历史篡改和下一位置冲突后的新行回滚。

## Debug journal

- [2026-09] [权限] **路径检查后再 readFileSync 存在并发替换窗口**
  - 误导方向：已有 lstat 和大小检查就认为安全。
  - 根因：检查的路径不绑定实际打开 inode，且读取本身无硬上限。
  - 修复：O_NOFOLLOW/O_NONBLOCK、Linux fd 实际路径、inode/类型/前后 stat、有界读取。
  - 证据：`scripts/test-harness-runtime-recovery.js` 在受控 Linux 的文件交换回归通过；安全复审关闭 P1。
- [2026-09] [持久化] **失败任务与半写文件不能阻断整个 outbox**
  - 根因：最终文件名在 fsync 前公开；固定 hash 排序使前批坏任务永久占据重试预算。
  - 修复：临时文件 fsync 后原子发布、每项错误隔离、持久化轮转 cursor；半帧保留并停止追加。
  - 证据：recovery suite 坏 job/ack、公平重试、原子发布中断和短写用例通过。
- [2026-09] [数据库] **回滚测试必须真的插入新行**
  - 误导方向：在 cursor 已追平后篡改历史，只看到 ROLLBACK 就认为新行回滚已测。
  - 修复：预置下一位置冲突、插入后续行、断言后续行消失且 cursor 不推进，修复冲突后仅插入 2 行。
  - 证据：`scripts/test-harness-transcript-postgres.js` 通过；真实 PostgreSQL 另验证 2 次失败模型会话的 4 条语义事件和独立读回。

## Prevention

每个完成声明注明证据层及限制。当前只读接线测试通过，但真实 135M 模型主 spec 的两次运行分别 terminal 拒绝/超时，live qualification **未通过**。不要放宽 acceptance、伪造 terminal 或把失败事件 ack 称为功能验收成功。

## Learning governance

以上为可审计工程记录；未创建 native-host authority EvidenceRef，未自动晋级 LearningCandidate、旧 instinct 或永久学习规则。候选反模式：`canary-pass-as-workflow-complete`；候选策略：`real-entrypoint-and-failure-replay-first`，状态 needs-review。

## 登录任务范围的补充核查

2026-09-02 用户明确允许登录后创建、执行任务。核查发现 sibling Agent 是白名单 demo runner，前置登录由站点现有服务承担；登录页 200 不能证明稳定用户主体与任务归属隔离。runner 摘要显示配置了 DeepSeek-V4-Pro，`hasKey=true` 也不能证明密钥有效、获得费用授权或满足 Harness schema/acceptance。

线上登录源码读取遭安全审查拒绝后停止，未变换工具或编码绕过。先完成公开协议/状态核查、将任务和安全门记录进计划，再申请特定源码审阅与模型复用授权。候选反模式 `login-or-config-presence-as-execution-readiness` 保持 needs-review；没有宣称公网功能已完成。

后续用户明确批准后，重新审阅登录结构并核对当前 standalone 编译产物：共享密码登录返回固定 secret Cookie，登出只清客户端 Cookie。此访问门不能提供独立用户归属或服务端会话撤销，因此需要新的 TP 账户方案审批。Agent 的 DeepSeek-V4-Pro 小型 Schema 探针实际 HTTP 200/stop/有效 JSON，仍不等于完整 Harness 任务验收。两项检查只记录各自能够证明的边界，未静默创建账户、修改登录或开放公网执行。

随后完整 spec prompt/Schema 探针也得到 HTTP 200、正常 text-only terminal 和 0 个 Schema 错误（30929 ms，1 个任务）。这进一步证明模型契约兼容性，但没有经过主 Harness dispatch/Acceptance/Transcript；证据显式 `fullHarnessAcceptance=false`，不关闭生产 live gate。

## Related

- [[2026-09-02-harness-transcript-production-wiring]]
- [[2026-09-02-authenticated-harness-tasks]]
- [[2026-08-27-agent-harness-requirement-alignment]]
