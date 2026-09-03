---
title: "持久任务授权必须固定策略行，并证明真实锁等待"
date: 2026-09-02
tags: [solution, postgres, authorization, concurrency, testing]
related_instincts: []
aliases: ["Task authorization row locks"]
---

# 任务授权的事务边界

## Problem

任务创建和入队即使使用 READ COMMITTED、全局 advisory lock 和数据库内身份校验，仍可能与不使用同一锁的管理员撤权产生竞争。成功路径测试通过不能证明撤权路径安全。

## Root Cause

项目/成员授权检查与任务写入是不同 SQL。中途成员删除会使第二次 SELECT INTO 返回空行，布尔变量成为 NULL；`IF NOT allowed` 在三值逻辑下不进入拒绝分支。advisory lock 只协调遵守该锁的调用方，不能固定未加锁的授权记录。

## Solution

创建及入队在全局任务锁后，以 `FOR SHARE OF p,m` 固定项目和成员行至事务提交；明确检查当前项目启用、FOUND 和 `IS DISTINCT FROM true`。先撤权则等待并重判新记录；先持有任务授权锁则撤权等待任务提交。auth session 保持另一个清晰边界：后续身份查询拒绝失效 session，不回溯取消已通过检查的在途操作，实际 dispatch 前仍需二次鉴权。

```sql
SELECT m.can_execute, p.execution_enabled INTO allowed, qualified
FROM harness_tasks.members m JOIN harness_tasks.projects p ON p.id = m.project_id
WHERE m.account_id = account AND m.project_id = existing.project_id AND p.enabled
FOR SHARE OF p, m;
IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0404'; END IF;
IF allowed IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE = 'P0403'; END IF;
```

真实测试先由独立连接修改授权但不提交，预取 task client/PID，确认 `pg_locks` 对应 transactionid 未授予，再提交撤权。到期测试同样确认 advisory lock 正在等待后才等待 TTL。既不注入测试版函数，也不只 sleep 后猜测竞态是否发生。已 queued 的幂等重放必须用原 execution key 单独测撤权，draft + 新键不能代替。

## Evidence

- 旧代码的并发撤权回归先失败，修后 7 类撤权竞争通过。
- 最终受控 PostgreSQL 37 组通过（A1 13 + A2 24），Linux 本地测试 95 项通过；临时对象已清理，生产 schema/路由未变。
- 公开投影另修复 primitive string 类型和 Unicode codepoint 计数，新增模块行覆盖率 100%，不泛化为全仓或 SQL 覆盖率。
- 实测版本/指纹/残留门：[[2026-09-02-harness-web-tasks-a2-verification]]。

## Prevention

审查每次变更的完整授权→副作用顺序，区分身份检查点、策略行锁、全局配额锁与真实执行授权。事务成功、队列持久化、Harness acceptance、Transcript ack 是不同证据，不相互替代。管理员入口也须约定锁顺序，生产上线独立核查有效 ACL、日志参数和容量。

## Learning governance

此文为可复现工程经验的候选沉淀，不是 native-host authority EvidenceRef；`policy-read-must-survive-until-mutation` 与 `lock-wait-tests-need-observed-pid` 保持 needs-review。不自动晋级本能或伪造完整 Harness 公网任务完成记录。

## Related

- [[2026-09-02-authenticated-harness-tasks]]
- [[2026-09-02-harness-web-tasks-a2-verification]]
- [[2026-09-02-auth-business-admission-and-shutdown]]
