# TP 独立账户、Harness 任务与 Transcript 生产部署

本目录包含独立账户/可撤销会话、[持久任务与执行契约](tasks.md)、不可变发布脚本、worker 和专用 Transcript 同步 unit。生产入口为 `https://songuu.top/tech-persistence/tasks/`；部署状态与真实资格证据以 [A1–A6 关闭记录](../../docs/plans/2026-09-02-authenticated-harness-tasks.md) 为准。

## 身份与接口

不接受既有 `dm_session`、转发用户 ID 或网页提交的角色作为身份。默认没有账户，没有注册接口。账户管理员通过服务器 CLI 创建/停用/重置密码。随机 session 的 SHA-256 存在 PostgreSQL，Cookie 本身不入库。

所有接口位于 `https://songuu.top/tech-persistence/api/v1/auth/`：

| 方法/接口 | 输入与防护 | 成功结果 |
|---|---|---|
| POST `login` | JSON `{username,password}`；固定 Host、Origin 和 `X-TP-Client: 1` | 新 Cookie，JSON 仅 `{user:{id,username},expiresAt,csrfToken}` |
| GET `session` | 独立 session Cookie；每次查数据库 | 同上公开字段，不重签/延长会话 |
| POST `logout` | JSON `{}`、Cookie、同源头、当前会话对应的 `X-TP-CSRF` | 数据库撤销后 204，再清 Cookie |

- Cookie：`__Host-tp_session`，Secure、HttpOnly、SameSite=Strict、Path=/、无 Domain，绝对期限 1 小时；每账户最多 8 个有效会话。
- 密码：15–128 个 Unicode codepoint、最多 512 UTF-8 字节；scrypt 固定 N=131072/r=8/p=1，随机 16-byte 盐。用户名转小写，为 3–64 位 ASCII 字母/数字/`_`/`-`，首位为字母或数字。
- 401：身份无效、过期、撤销、停用或凭据错误；403：Origin/CSRF/Host 不合格；429：限流/繁忙；503：认证存储不可用。错误不返回数据库细节。
- 达到 8 会话上限后不会签发第 9 个会话；当前返回通用登录拒绝。用户可退出一个现有会话或等待绝对到期，管理员可通过重置密码撤销旧版本。
- 停用及密码重置递增账户版本，使之前会话的后续认证查询失效；重置不会附带重新启用。已在执行的其他业务需要 A2/A3 的二次授权与协调机制，不能假设仅撤销 Cookie 就取消进程。
- 同一域名下其他应用共享浏览器 origin。Cookie 路径不构成同源应用/XSS 隔离；上线前应审阅整个域的同源信任面。

## 配置与权限

1. 安装前以只读方式确认 `harness_web`、`tp_web_auth`、`tp_web_account_admin` 均不存在，并确认 PostgreSQL 的 PUBLIC 数据库/public schema 权限已撤销。`001-auth.sql` 是首次安装事务，任何名称冲突即失败，不能用 `IF NOT EXISTS` 接管未知对象。
2. 管理员执行迁移后，两角色仍是 NOLOGIN。用安全的服务端凭据渠道分别设置强随机密码并只为所需专用角色启用 LOGIN；不要把口令放进 shell 历史、argv、仓库或工具输出。不得授予 SUPERUSER、BYPASSRLS、其他业务角色或表所有权。
3. 认证进程使用独立 nologin OS 用户 `tp-web`；不加入 authority/provider/数据库宿主组。代码由发布管理员只读提供；web UID 不得修改代码、配置祖先目录或 Harness 工作区。
4. 运行与账户管理使用**不同的**仓库外 JSON 文件。运行配置仅含 `version: "harness-web-auth-config-v1"`、`publicOrigin: "https://songuu.top"`、`port: 5183`、`databaseUrl`。连接 URL 必须显式指定 `127.0.0.1:55433/tech_persistence` 和 `tp_web_auth`；管理配置使用 `tp_web_account_admin`。不接受其他数据库、远程主机、query 参数或角色。
5. Linux 配置文件 0600，由读取者或 root 所有，全部祖先目录禁止 group/other 写、禁止符号链接。管理配置仅管理员可读；运行配置仅对应服务可读。没有默认生产口令示例。

服务命令为 `node scripts/harness-web-auth.js --config <protected-absolute-file>`，始终绑定 `127.0.0.1`。管理命令为 `node scripts/harness-web-account.js --config <admin-protected-file> --action create|disable|reset-password`：create/reset-password 的 stdin 接受 `{username,password}`，disable 接受 `{username}`；在安全终端或秘密渠道提供 stdin，不使用含真实密码的 shell 一行命令。

管理面输出只有账户 id/username/disabled，不返回 hash；失败输出固定错误。服务启动数据库探测失败时不监听。SIGTERM/INT 停止接入、关闭连接池，5 秒内无法完成则非零退出。

## 单实例资源预算

- A6 初次只允许一个实例；密码校验至多 2 个，所有认证 HTTP 请求共享 16 个业务名额。名额在异步业务结束时释放，客户端断开不释放未完成数据库工作。禁止无上限重试或扩大实例数来绕过预算。
- HTTP 最大 64 个 socket、每 socket 100 个请求；header 8 KiB、JSON body 32 KiB；headers/body 接收和 socket 空闲预算 5 秒，接收期限每 250 ms 检查，调度存在少量误差。
- PG 池 4 个连接，获取 2 秒、statement 5 秒、lock 2 秒、idle transaction 5 秒。事务固定 READ COMMITTED；advisory lock 排序后的语句必须观察前一持有者提交。
- PG 限流：每账户 5 次/10 分钟，全局 60 次/分钟。用户名限流桶仅存 hash；清理仅限过期的短期限流桶。饱和请求仍可能产生计数行更新，拒绝量/WAL 成本需要上线压测。
- service unit 至少设置 `MemoryMax=512M`、`MemorySwapMax=0`、`TasksMax=32`、`LimitNOFILE=256`、`CPUQuota=50%`；V8 heap 可限制 128 MiB。与两个 scrypt 工作集一起实测峰值 RSS/延迟，不能只看 heap。必须使用 `NoNewPrivileges`、只读代码/系统、私有 tmp、无新增 capability 的运行约束。该预算是发布前容量验证输入，不是未经验证的容量承诺。
- Nginx 只精确代理批准的三个 auth 路由，不更改 `/auth/`、`/login` 或其他站点；固定上游 Host，保留 Origin/安全头，禁缓存和响应/请求正文日志。配置实际变更留到 A6 审批与验收。

## 保留、运维与回滚

- 本版本不删除账户或 session 历史，不自动压缩/轮换业务数据。监控磁盘剩余、表/index 增长、429/503、PG 等待和 RSS；服务器约 2 GiB 可用容量不代表可无限累积。生产 admission 开放前必须约定容量阈值、保留/归档与告警；任何删除另行审批。
- 当前部分 session 索引服务有效会话查询，不覆盖所有已撤销记录的 FK 维护。若以后引入账户删除/全历史维护，应评估完整 account_id 索引，不在 A1 增加删除接口。
- 数据库不可用不签发会话、不报告撤销成功；不得回退固定 Cookie、内存账户或无状态 session。收敛故障时先停新 admission，保留数据库/审计证据。
- 回滚只回退 TP 专属新路由/服务候选，保留新 schema/账户数据，不能 DROP 生产表或影响原站登录。A2/A3 的执行任务需另外协调，不盲重放。

## 验证

```text
node scripts/test-harness-web-auth.js
node scripts/test-harness-web-storage.js
node scripts/test-harness-web-config.js
node scripts/test-harness-web-postgres.js --controlled-postgres
```

前三个为本地测试（POSIX 权限用例只在 Linux 执行）。最后一个只能在获准 Linux/Docker 宿主运行，默认无参数只 SKIP：通过既有容器的 Unix socket 创建随机 `tp_auth_test_*` 数据库/专用角色，真实 SQL/并发/权限检查后，读回 owner 和唯一 marker 才删除**自己创建的临时库**及角色，绝不迁移生产库。测试密码随机、仅内存、输出只有固定检查名和临时库元数据。

focused 测试用于回归；生产完成判定还必须包含登录任务 E2E、真实 Acceptance、`user-confirmation` 和独立 Transcript PostgreSQL 读回。2026-09-03 的 v15 证据已满足这些门，详见主计划。
