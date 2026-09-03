# 持久 Harness 任务、执行与 Transcript 契约

`002-tasks.sql` 提供任务底座，`003-execution.sql` 与 `004-confirm-resume.sql` 扩展 authority claim、执行、确认和恢复；HTTP/worker 只通过批准函数访问 PostgreSQL。`queued` 仍只表示请求已持久化；只有 authority 写入终态、Acceptance 完成且独立 Transcript worker 确认后，页面才显示相应结果。生产证据见 [主计划](../../docs/plans/2026-09-02-authenticated-harness-tasks.md)。

## 信任边界

- `task-service` 复用 A1 token/CSRF；参数化 `task-store` 仅调用五个批准函数，每次独立 READ COMMITTED 事务。全部服务操作共享 8 个进行中名额，必须复用单实例，不得按请求创建 service 来绕过预算。
- `tp_web_tasks` 仅有 `harness_tasks` schema USAGE 和批准函数 EXECUTE，不可直接访问任务表、成员表、session、口令或私有 helper。`tp_task_owner` 是 NOLOGIN owner，仅能读取 A1 所需身份列，无账户/会话修改权限。
- 数据库函数从 session hash 解析主体并检查当前账户版本、停用、撤销和绝对期限；不接受 owner/user/tenant/role 参数。hash 是敏感认证材料，不记录 SQL bind 参数、Cookie、请求/响应正文或原始 PG 错误。
- 仅能查询当前授权且启用的项目中属于自己的任务；未知与越权任务统一 404。项目默认禁用、无成员、执行资格 false，只有 A3 真实 qualification 后才能开启执行资格。现有模型配置、站点 200 和 canary 不能作为资格证明。
- 需求按不可信文本原样保存，不作为 shell、HTML、路径或模型配置解释。A4 必须使用安全文本渲染；A3 必须重新鉴权并把 project ID 映射到受控配置及隔离工作区。

## 服务契约

| 方法 | 输入 | 结果/约束 |
|---|---|---|
| `create(token, csrf, input)` | 精确 `{projectId, requirement, idempotencyKey}` | 返回 draft；同主体同键同内容重放返回原任务，不重复占额；变更内容/项目 409 |
| `enqueue(token, csrf, taskId, input)` | 精确 `{idempotencyKey}` | 成员执行权限及项目执行资格均有效才入队；同任务同键重放无新副作用，换键或挪用键 409 |
| `get(token, taskId)` | 规范 UUID v4 | 自己当前可见的任务详情 |
| `list(token, input)` | 可选 `{after, limit}` | 默认 20，最多 50；按 `(created_at,id)` 倒序，游标为自己当前可见的任务 UUID |
| `projects(token)` | 无身份筛选参数 | 授权项目的 ID、显示名、canCreate/canExecute；最多 100，超限明确拒绝 |

project ID 为 3–64 位小写 ASCII 字母/数字/`_`/`-`，首位字母或数字。需求非空、无 NUL、有效 UTF-8，最多 16384 字节；幂等键为小写规范 UUID v4。未知字段全部拒绝。列表没有需求正文；详情仅包含 id/projectId/state/createdAt/queuedAt/requirement，变更另含 replayed。没有 owner、幂等键、服务器路径、日志或凭据。

分页不承诺跨 HTTP 请求快照；新任务在刷新后可见，游标对应项目被撤权后返回 404，不悄悄切换为未授权分页。401 身份无效，403 无执行权限/CSRF，404 不可见，409 幂等冲突，429 限额/繁忙，503 资格或存储不可用；错误不包含原始数据库消息。

## 原子性与预算

所有变更先取得数据库全局事务 advisory lock，再鉴权、查幂等、判断配额并写入；函数拒绝非 READ COMMITTED。项目/成员授权行以 FOR SHARE 锁定至提交；先开始的撤权提交后重新判断，任务先持有授权行锁时撤权等待任务提交。缺失授权行、NULL 或禁用状态明确拒绝。锁只覆盖有界数据库工作，不能跨 provider 调用或网络执行持有。幂等重放也需要通过当前权限与资格，失败不能留下 task 或 execution key。身份在全局锁后检查，但不持有 A1 账户/session 行锁：撤销使后续身份查询失效，不回溯取消已通过检查的在途操作；A3 dispatch 前仍需二次验证并协调运行中任务。

| 预算 | 每主体 | 全局 |
|---|---:|---:|
| 草稿 | 10 | 受总保留量约束 |
| 排队 | 5 | 20 |
| 保留任务 | 100 | 1000 |
| 每分钟成功创建 | 5 | 20 |
| 每分钟成功入队 | 5 | 20 |

只统计成功变更，重放不重复计数。A2 只有 draft/queued，故保留总量和入队速率有部分更严格的状态上限同时约束；A3 扩展终态时必须保留完整历史计数和限流语义并补回归。当前没有删除、自动淘汰或保留期；达到配额直接拒绝，不能清空任务恢复容量。

## 安装与回滚（A6 才执行）

1. 只读确认 A1 已安装、`harness_tasks`/`tp_task_owner`/`tp_web_tasks` 均不存在，并确认 PUBLIC 数据库及 public schema 权限已撤销。`002-tasks.sql` 一次事务安装，冲突失败，不采用或覆盖未知对象。
2. 两角色初始 NOLOGIN；仅通过安全服务端渠道给专用 web task 角色设置强随机凭据并开启 LOGIN。owner 始终 NOLOGIN，不授予 web 角色 membership、DML、CREATE、BYPASSRLS、SUPERUSER 或其他业务角色。不得把 A1 管理角色用作 task 连接。
3. A4 配置入口尚未实现，不要把 task URL 塞入 A1 仅接受 `tp_web_auth` 的认证配置。未来 task 池最多 4 连接，获取/lock 2 秒、statement/idle transaction 5 秒，与业务 8 并发共同限制；A6 必须测量 CPU/RSS、连接等待、磁盘/WAL，而非照搬测试延迟作 SLA。
4. 项目/成员仅管理员经受控数据变更管理；本阶段没有公开管理接口、默认生产授权、工作目录映射或 provider 配置。qualification 开关必须由真实验收支撑，不可为了让页面可点击而设 true。
5. 运维授权/配置变更也须遵守任务锁顺序并协调在途请求；数据库角色只保护网页边界，不把超级用户或 owner 当作不可信客户端。认证变更后后续查询拒绝，不声称撤销会回溯取消已获授权的操作。
6. 回滚先停止新 admission，再回退新服务/路由，保留 schema、任务、成员与幂等键；不得 DROP 生产对象。后续已 dispatch 任务须由 A3 协调，不自动重放。

发布门还包括实际数据库的有效 ACL 检查：task owner/web role 不能读写 Receipt/Transcript 或继承其角色；临时身份/任务库不包含生产 Receipt/Transcript 表，不能把其缺失误算为权限拒绝证明。禁用 bind 参数日志须同时核查 `log_parameter_max_length`、`log_parameter_max_length_on_error` 和扩展审计设置；不能只凭应用未调用 console.log 推断数据库也未记录认证 hash。

## 验证

```text
node scripts/test-harness-web-tasks.js
node scripts/test-harness-web-tasks-postgres.js --controlled-postgres
```

第二条只在获准 Linux 宿主执行，默认无参数 SKIP。复用 A1 宿主创建唯一 `tp_auth_test_*` 库和专用角色；任务测试独立校验库名/当前用户/marker 后才写合成 fixture，结束读回 owner/marker 才清理自己创建的临时库/角色。不安装生产 schema，不创建生产账户/任务，不使用 provider。具体实测与审查记录见 [A2 验证报告](../../docs/plans/2026-09-02-harness-web-tasks-a2-verification.md)；不能以单元测试或入队记录代替整个网站的端到端完成。
