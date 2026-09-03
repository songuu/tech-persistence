# 登录后的 Harness 任务创建与执行

Status: completed
Created: 2026-09-02
Updated: 2026-09-03
Risk: L4 / Planning: P4
Parent: [[2026-09-02-harness-transcript-production-wiring]]

## 需求与授权

用户已明确允许在 `songuu.top` 登录后创建、执行任务，并要求参考 `E:/project/ai/agent`。本计划补齐公网交互层，不取代已有 Harness、Acceptance、Transcript authority。

### 要做

- 受认证的任务创建、显式执行、状态/结果查看，以及受权限控制的 Transcript 元数据查看。
- 采用已批准的 TP 独立账户和可撤销短期会话；任务和工作区按主体授权，网页不持有 provider/DB/authority 凭据。
- 沿用 Harness 的 spec/freeze/implementation/review/acceptance 流程，保留唯一 writer、确认门和真实业务完成判断。

### 不做

- 不开放匿名执行、自助公开注册、任意服务器路径、shell 命令、环境变量、网络地址或 provider 配置输入。
- 不更改其他站点账户、注销逻辑或公共路由；现有登录若不提供稳定主体，须先审批身份方案，不复制共享 Cookie 当作用户 ID。
- 不以退出码、演示 runner、canary 或 Transcript ack 代替完整功能验收，不绕过 scanner 或失败验收。

### 输入、失败与空状态约定（拟定）

- 输入只接受需求文本及服务端批准的 project ID；需求上限 16 KiB、HTTP JSON 上限 32 KiB。项目映射、工作目录、命令和模型由服务器控制。
- 第一版全局至多一个执行任务，每主体至多一个运行中任务、五个排队任务；入口另设频率与总量限制。参数在上线前通过容量测试固定。
- 模型、身份验证或存储不可用时明确拒绝执行；已产生副作用后不自动重放。异常中断进入需协调状态，不猜测完成。
- 无任务显示创建入口；无授权项目、无合格 provider 时显示具体阻塞，不能显示“可运行”。不得伪造示例为真实记录。

### 验收条件

- WHEN 未登录、会话过期或撤销后调用创建/执行接口，THE SYSTEM SHALL 返回 401/403，且不入队、不 dispatch。
- WHEN 已登录主体请求其他主体的任务、工作区或 Transcript，THE SYSTEM SHALL 拒绝，且不泄漏其存在、正文、路径或凭据。
- WHEN 有权限的用户在批准的项目中创建并显式执行任务，THE SYSTEM SHALL 产生可关联的 Harness run；重复提交同一幂等键不重复创建或执行。
- WHEN 模型失败、超时、进程中断或 terminal capture 不完整，THE SYSTEM SHALL 显示真实失败/需协调状态，不重复写入、不生成假的 passed Receipt。
- WHEN 完整真实任务达到验收条件，THE SYSTEM SHALL 展示与 authority Receipt 一致的结果，并在独立 PostgreSQL reader 验证后标记 Transcript 同步完成。

## 已核实的现状

| 证据 | 结论与限制 |
|---|---|
| `site/templates/render-site.js`、`site/build.js`、`deploy/nginx/tech-persistence.location.conf` | 当前为静态站点，没有登录任务 API。 |
| sibling `scripts/demo-runner/server.mts`、`runner.mts` | 有 Host/Origin gate、白名单 demo、single-flight、超时与子进程 env allowlist；没有按用户归属的持久任务服务，不能直接改为通用公网 Harness。 |
| sibling `deploy/nginx/songuu-host.container.conf.example` | 示例使用 `dm_session` Cookie map，仅能说明存在前置访问门；不能证明唯一用户、会话撤销或多用户隔离。 |
| 线上路由与 HTTP 探针 | `/login`、`/auth/` 由现有 deploy-management 承担，登录页与 TP 静态站均 200；未读取会话值。 |
| runner `/api/config` 白名单摘要 | `openai` / `deepseek-ai/DeepSeek-V4-Pro`，`hasKey=true`、custom endpoint。不是有效密钥或模型资格证明；未发起收费调用。 |
| CLI 存在性与服务状态 | 默认 PATH 没有 Claude/Codex；agent-api `/ready` 为 503；Transcript timer 和旧本地模型服务仍 active。 |

初次登录源码读取被安全审查拒绝后停止。用户随后明确授权只读审阅登录实现，以及复用 Agent 模型配置进行验收和任务调用（可能产生 API 费用）；重新经审批读取时只输出去除字符串字面值的代码结构，未输出口令、Token 或模型凭据。

### 获授权后的身份审阅

- 源码：服务器 `/opt/deploy-management/app/apps/web/app/auth/login/route.ts` 第 9–30 行，将输入密码与 `CONSOLE_LOGIN_PASSWORD` 比较，成功后直接把 `CONSOLE_SESSION_SECRET` 写入 `dm_session` Cookie。设置 HttpOnly/Secure 与 30 天浏览器 maxAge，但没有为每次登录签发独立随机 session ID。
- 登出：同目录 `auth/logout/route.ts` 只清除浏览器 Cookie，没有在服务端撤销对应会话。不能据此保证已复制的 Cookie 在登出后失效。
- 已核对运行版本：PM2 `dm-web` 使用 `/opt/deploy-management/releases/postgres-only-20260728103152/scripts/runtime/run-web.sh`，优先启动 standalone。对应 server chunk `[root-of-the-server]__10s1gdg._.js` 的 SHA-256 为 `17bff6ef076e48d790e45e5518bc9f5f0b54c85f6e5a0d22cee385f4cb406426`，包含同样的共享密码、固定 secret 与 Cookie 赋值逻辑；不只凭旧源码作结论。
- 结论：现有登录是共享访问门，不满足本计划的独立主体、按用户任务归属及可撤销会话要求。未修改现有登录，也未用固定 Cookie 伪装多用户身份。
- 已向用户提出新的具体方案审批：仅为 TP 增加独立账户和可撤销短期会话，默认关闭公开注册，保持其他站点登录不变。该账户系统变更不从“只读审阅”授权中推导。

## 技术方案（A1 独立身份方案已获批准）

### 多方案比较

| 方案 | 取舍 |
|---|---|
| 复用现有登录的可验证主体 + TP 独立任务网关 | 审阅后不满足前提：当前登录没有独立主体或会话撤销，不能直接采用。 |
| TP 自建独立账户/会话系统 | 用户已明确批准。默认关闭公开注册，不修改现有站点登录；服务端管理账户、短期随机会话、服务端撤销与 CSRF 防护。 |
| 直接代理 agent 演示 runner 或共用静态 Cookie | 不采用；缺少任务归属、隔离与完整 Harness 验收，不满足本次需求。 |

### 边界

1. 浏览器仅访问同源 `/tech-persistence/app/` 与 `/tech-persistence/api/v1/`；保持公开文档及其他站点路由不变。
2. 独立低权限 web gateway 验证会话、主体、Origin/CSRF、请求 schema 与幂等键。来自客户端的用户、租户、角色和转发身份头不得作为可信身份。
3. PostgreSQL 使用独立任务 schema/角色与参数化查询，继承 sibling 的连接池/分权模式。任务提交和 authority claim 分权；用户不能写 Receipt 或 accepted 状态。
4. authority worker 二次验证主体/project 映射、固定 runtime 配置与任务状态，只构造白名单 CLI 参数。durable claim 在 dispatch 前完成，跨进程唯一执行，启动恢复不自动重放副作用未知的任务。
5. 执行沙箱必须隔离不同主体的工作区。仅共用 `tp-provider` UID 或顺序执行不能证明跨用户隔离；需验证每次执行的文件系统/网络边界、进程树取消及资源上限。
6. 外部 OpenAI-compatible provider 仍仅 spec/review，原生 Codex 仍为唯一 writer。现有模型是远端 custom endpoint，而当前适配只允许 loopback：若获准复用，须通过独立 provider broker 持有凭据、固定目标与模型；不得简单放宽 authority transport 任意 URL 或把密钥交给网页。
7. API 仅返回白名单业务字段；禁止原始 stdout/stderr、authority 文件或 reasoning 展示。Transcript 使用现有 hash-only 采集/worker/独立 reader，不造第二套写入链。

### 契约接口

| 契约 | Before | After | 消费者 |
|---|---|---|---|
| 任务来源 | 受控 CLI 输入 | 新增经鉴权与项目授权的 durable task request，由 worker 构造 CLI 调用 | 新 web gateway、task store、authority worker |
| Harness / Acceptance | 唯一 writer、既有确认和 Receipt | 语义不变；网页仅投影、转交受认证的显式操作，不可覆盖门控 | 原 CLI、状态投影、新网页 |
| 模型连接 | 固定 loopback、无 authority 凭据 | 获批准时新增独立 provider broker；authority loopback 边界不变 | broker、canary/promotion、原 transport |
| Transcript | 自动 hash-only spool → worker → PG reader → ack | 主链不变，增加按任务归属授权的元数据读取 | 新查询 API；原同步服务 |

### 任务拆解

全部串行，不标 `[P]`：认证、执行和数据均为 L4，后续工作依赖前项契约。

- [x] A0：核实代码、现有登录路由、模型摘要与服务状态；记录授权缺口。只读，不宣称能力已就绪。
- [x] A1：独立账户/会话 API、服务端管理 CLI、独立 PG schema/角色已实现；过期、撤销、CSRF、并发/故障与生命周期测试通过，独立五视角审查已闭环。仅候选完成，未部署公网。证据见 [[2026-09-02-harness-web-auth-a1-verification]]。
- [x] A2：持久任务、归属授权、幂等与有限队列候选完成；应用 schema 不修改既有 Transcript/Receipt 数据。Linux 95 项与真实 PG 37 组通过，五视角审查的 A2 P0/P1 已闭环；未部署公网。证据见 [[2026-09-02-harness-web-tasks-a2-verification]]。
- [x] A3：authority claim/执行适配、每任务沙箱、取消恢复、模型 broker 与真实 qualification。
- [x] A4：登录态任务页面、创建/执行/确认交互、真实状态/结果及 Transcript 同步状态，错误/空状态/越权均可观察。
- [x] A5：安全、数据库、架构与代码审查，L4 focused/生产回归、真实完整任务和投影检查。
- [x] A6：不可变 v15 发布、nginx 精确路由、loopback + HTTPS 验收及可恢复发布脚本；旧发布和生产证据保留。

### 测试策略

- 先测试后实现，至少 20 个边界用例，覆盖无会话/失效/撤销、伪造身份头、重复 Cookie/头、跨 Origin、缺 CSRF、越权 ID、超限 JSON、未知字段、任意路径/命令/模型拒绝。
- 真实 PostgreSQL：主体隔离、幂等键冲突、事务回滚、双 worker claim、重启协调、同任务不重复执行、数据库不可用零 dispatch。
- 受控 Linux：跨工作区读写拒绝、provider 不可读 authority/DB/broker 凭据、进程树终止、资源上限、磁盘不足、半帧与 capture-incomplete。
- 浏览器：登录后创建/执行/查看完整任务；登出后禁止重用；别的主体无法访问任务；结果与 Receipt 一致。测试凭据由安全渠道提供，不记录进仓库。
- 验证测试模型和真实模型分开记账，必须通过真实主 Harness 路径及独立 PG reader，不能用 mock 或单点 canary 关闭 A5/A6。

### 风险与发布门

| 风险 | 概率 / 影响 | 缓解 |
|---|---|---|
| 现有登录只有共享访问 Cookie，无主体 | 已证实 / 高 | 实施已批准的 TP 独立账户方案，不把共享 Cookie 映射成不同用户。 |
| 无合格 writer 或模型协议不满足 Harness | 当前未验证 / 高 | 独立资格测试；不放宽 Receipt、不升级外部 writer。 |
| 并发/恢复导致重复副作用 | 中 / 高 | durable claim、唯一执行、明确需协调状态，副作用后禁止盲重试。 |
| 跨用户文件/Transcript 泄漏 | 中 / 高 | 每任务沙箱、最小身份、查询授权、负向测试。 |
| 生产磁盘约 96%，还有不健康依赖 | 已观察 / 高 | 上线前资源 gate，不新增大模型下载，不删他人数据/日志解决容量。 |
| 凭据泄漏或模型调用超预算 | 中 / 高 | 用户已授权复用和费用；仅在服务器进程内部读取使用，单次调用限制输出 token、超时和响应体积，生产接入仍经独立 broker 固定目标。 |

回滚：先停新任务 admission，再协调已有执行，不盲杀重放；回退 TP 专属 nginx snippet 与 web/worker 发布，原 Harness 发布、Transcript timer 和数据保留。任何账户系统变更、破坏性迁移及公共路由扩展另行门控。

## 最终关闭点（2026-09-03）

生产 v15 已在 `47.253.230.197` 激活，公网入口为 `https://songuu.top/tech-persistence/tasks/`。完整任务 `386bbf93-3e1b-4eab-8037-2c8f30d97de4` 达到 `succeeded/completed`，真实 `user-confirmation` 被行使，Transcript 独立同步为 `synced`（3 events）。Web、worker、broker 与专用 Harness Transcript timer 均 active；5183/5190/55433 仅 loopback 监听。未认证 API 返回 401，TLS 校验成功；浏览器登录页及控制台通过烟测。

Linux 原生隔离回归证明 provider 无 authority secret、跨任务不可见、进程树可终止；worker 本身 `CapEff=0`，只有 hash 绑定的固定 launcher 持有最小能力。v15 capability receipt 为 `sha256:ec37783c53f7e3aee4355a949adb02bd76f7c609f3c2a079a6fe9d2f73c7853d`，evidence hash 为 `sha256:48e45ac8aca811d79e6e7949256c670d0ae9ccf89ddfe5bdd1e97616bbd99390`。

## 历史暂停点

登录只读审阅、Agent 模型调用、TP 独立账户/可撤销短期会话、私有候选上传及计划内生产部署均已获得明确授权，**不再重复询问这些范围**。A1/A2 候选实现、实库测试和独立审查已完成；A3 的 claim/恢复、worker 隔离和 capability supervisor 已通过真实 PG 与 Linux E2E，supervisor 已带回滚副本原子部署，但 broker、主 Harness/native writer qualification、worker systemd 与生产 schema 仍未完成。不把底座通过视为公网部署或完整功能完成。正式公网写操作仍须在 writer、真实验收和独立安全审查全部通过后开放，不改造其他项目登录。

A2 审查交接门：A3 扩展出队/终态后，补测独立可达的 enqueue 速率与每主体保留 100 上限，不能丢失历史限额；A4 必须安全渲染需求及项目名并验证真实 HTTP/浏览器链；A6 提供最小权限、可审计且遵守锁顺序的离线项目/成员管理机制，核验实际 Receipt/Transcript 有效 ACL、PG bind/扩展审计日志不含 session hash，并完成 EXPLAIN、容量与回滚测试。当前服务器只读核查可用约 1.7 GiB（96% 使用），不以删除他人数据解决容量。

### A1 冻结实现契约

- 源码范围：`scripts/harness-web/{password,auth,auth-store,auth-server,config,account-admin}.js`；服务入口 `scripts/harness-web-auth.js`、管理入口 `scripts/harness-web-account.js`；`deploy/harness-web/001-auth.sql`、运行说明及 `scripts/test-harness-web-*.js`。
- 独立 `harness_web` schema；`tp_web_auth` 仅登录查询、会话与限流访问；`tp_web_account_admin` 才可创建/停用/重置账户。SQL 首次部署冲突即失败，不覆盖既有 schema/角色。无默认生产账户或密码。
- 密码采用 Node 内置 scrypt（N=131072、r=8、p=1、随机盐）；密码 15–128 字符且最多 512 UTF-8 字节。参考 [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)，不新增密码学依赖。
- 每次登录新建 256-bit 随机会话，PG 仅存 SHA-256；绝对有效期 1 小时、最多 8 个有效会话。账户版本变更/停用或单会话撤销后，后续认证查询立即拒绝。客户端 Cookie 为 `__Host-tp_session`，Secure/HttpOnly/SameSite=Strict，不设置 Domain。
- 登录/退出要求固定 Host、同源 Origin 与专用客户端头；退出额外校验绑定当前会话的 CSRF。拒绝重复安全头/会话 Cookie、非 JSON 与超限 body；不相信客户端主体/角色或转发身份头。
- 跨进程 PG 登录限流（单账户 5 次/10 分钟、全局 60 次/分钟）；事务显式固定 READ COMMITTED，不能继承旧快照设置。每实例至多两个并行密码校验、16 个处理中的认证 HTTP 请求；断开不能提前释放仍在等待数据库的名额。数据库失败不签发会话。初次部署仅允许一个服务实例并声明内存/连接/超时上限。
- 管理命令只从 stdin 读取密码，不通过命令行参数、日志或响应返回；配置在受保护的仓库外文件中。认证服务只监听 loopback，不新增注册接口，不包含任务执行器、provider 或 Transcript 凭据。
- 同一 `songuu.top` 下其他应用属于浏览器同源信任边界；Cookie 路径不能隔离同源 XSS。上线前需检查其他应用风险，不能声称此 API 实现消除了整个域的 XSS 风险。

### A2 冻结实现契约

- 范围：`scripts/harness-web/{task-service,task-store}.js`、`deploy/harness-web/002-tasks.sql`、部署说明及任务单元/真实 PG 测试；复用 A1 的隔离 PG 测试宿主，不增加 HTTP 路由或运行入口。A3 才实现 claim/运行/恢复，A4 才接页面/API。
- 新 `harness_tasks` schema；`tp_task_owner` 为 NOLOGIN 的表/受限函数 owner，`tp_web_tasks` 仅获批准函数 EXECUTE，无直接表读写、ownership 或角色继承。固定 SECURITY DEFINER search_path 并撤销 PUBLIC execute；函数 owner 仅可读 A1 所需身份列，不可修改账户/会话/Receipt/Transcript。
- 采用受限函数而非给网页角色直接 DML：前者在数据库边界统一执行归属、状态、幂等和配额约束；后者只靠调用方 WHERE/事务约定，容易遗漏。该变化只作用新任务 schema，不重构原 Harness authority。
- 函数从服务端计算的 session hash 重新获得账户，检查停用/版本/到期/撤销；不接受主体、角色或租户参数。hash 参数仍为敏感认证材料，不记录 SQL 参数。服务层复用 A1 token/CSRF 校验，全部请求共享至多 8 个进行中操作。
- 项目表仅含 ID/显示名/启用与执行资格开关，不含工作目录、命令、模型 URL；成员映射由服务端管理员维护，无公开管理接口。默认没有项目和成员授权，执行资格默认 false，只有 A3 实际 qualification 后才能开启。
- 创建精确输入 `{projectId, requirement, idempotencyKey}`；需求原样保存，非空、有效 UTF-8、无 NUL、最多 16 KiB；project ID 为有界 ASCII 标识，幂等键为规范 UUID v4。未知字段（含 owner/path/env/provider/command）一律拒绝；需求正文只是数据，不升级为执行配置。
- 创建为 `draft`，明确请求执行才原子变为 `queued`；执行函数仍复核会话、项目启用、成员执行权限及项目执行资格。A2 无运行状态写入接口，更没有 accepted/Receipt 写权限。
- `(owner, creationKey)` 唯一；同键同 project/需求返回原任务，不新增，不重复计费/占配额；同键不同内容 409。执行键在主体内唯一，同任务同键重放只读回，同键不同任务或已排队任务的新键 409。幂等重放仍须通过当前授权，不能借旧键绕过撤销。
- 有界初始预算：每主体至多 10 草稿、5 排队、100 保留任务；全局 20 排队、1000 保留任务；创建/入队各限制每主体成功变更 5 次/分钟、全局 20 次/分钟。资格/权限不足不得占配额或排队；重试不重复占额。上线前仍需容量验证，A3 保持全局一个执行任务的原约束。
- 所有变更使用显式 READ COMMITTED + 数据库全局短事务锁；在锁后重新鉴权/查幂等/判配额，避免并发超限和旧快照。项目/成员授权行以 FOR SHARE 保持至提交，缺失行/NULL 明确拒绝；撤权在前则重判新权限，任务先锁定授权行则撤权等待提交。函数在非 READ COMMITTED 下拒绝；不得仅依赖进程锁。身份检查不锁 A1 账户/session，不回溯取消已通过检查的在途操作，A3 dispatch 前仍需重验。失败事务不留下任务/执行标记。
- 查询仅返回当前授权项目中自己的任务，越权与不存在统一 404；列表不含需求正文，默认 20、最多 50，按 `(created_at,id)` 倒序游标分页，游标必须属于当前可见任务。分页不承诺跨请求快照，刷新可见新任务。详情不含原始日志、凭据、路径、owner ID 或幂等键。
- 验证：20+ 本地输入/服务/SQL 绑定/失败关闭测试，真实 PG 分权、双主体越权、撤销/停用、同键并发、配额并发、执行资格、失败回滚及分页；不以 mock、默认 SKIP 或队列记录当作真实执行证据。迁移只在随机临时数据库中应用，生产迁移与路由仍留待 A6。

### A3 冻结实现契约（进行中，未晋级）

- `003-execution.sql` 新增独立 NOLOGIN authority 角色与函数边界；网页角色只能申请取消，不能 claim、写终态或直接读表。claim 在数据库全局锁内重新检查账户、项目、成员和执行资格，全局最多一个 active claim，并以随机 claim token fencing。
- 状态边界固定为 `draft → queued → claimed → running/cancel_requested → terminal`。dispatch 前的过期 claim 才能重新排队；已标记 dispatch 的过期任务只能进入 `needs_coordination`，不得自动重放未知副作用。worker 必须在启动子进程前持久化 `dispatch_started`，心跳同时返回取消信号；取消态不得被成功终态覆盖。
- 浏览器提交的 requirement 只写入独立只读文件，不进入 shell、命令或参数；project ID 只能选择受保护配置中的固定 source/runtime/identity/timeout。authority 从固定 Git source 生成仅含当前分支 HEAD 的 shallow 独立副本（不带未跟踪文件或旧提交），沙箱只绑定当前 attempt input/output、固定 runtime 和该副本，不挂载 source/其他任务目录，不继承环境，并默认隔离网络。
- 外部 OpenAI-compatible 仍只允许 spec/review。独立 broker 已固定上游/模型/预算并通过真实文本、工具及 structured-output 调用；固定 `@openai/codex@0.152.1` 已在 provider UID 986、断网 bwrap、Unix socket broker 下完成真实文件写入，native writer qualification 已通过。固定 external canary 9 case 与只读 promotion 也已通过；主 Harness spec→implementation→review、自动 Transcript/PG 和生产服务仍未完成，不得用这些单点资格证据替代完整 Acceptance。
- 当前真实 PG13 随机隔离库验证 51/51 组通过（含 A3 14 组），`cleanupVerified=true`、`productionDatabaseTouched=false`；本地 worker 30 项为 28 pass + 2 个 POSIX-only skip，Linux 30/30。真实 E2E 已证明固定浅克隆不带未跟踪文件/旧提交、root 管理精确 Git allowlist、provider UID/GID/空补充组、authority secret/跨任务不可见、固定资源限制与 provider 身份容量测量、顽固父子进程树终止，最终状态仍为 `needs_coordination`。capability supervisor 已原子部署为 `root:tp-authority 0750`、`cap_kill,cap_setgid,cap_setuid=ep`，边界审计全通过，旧二进制保留在 authority 私有回滚路径。broker、真 Harness/native writer qualification、worker systemd、生产 schema/服务/公网路由仍未完成；A3 checkbox 保持未完成。

### 模型兼容性验证（与账户变更独立）

- 使用当前 `agent-build-runner` 的 runtime 配置：`/opt/agent-build/worker-runtimes/demo-runner-01123133`；密钥没有导出到会话或本地文件。
- DeepSeek-V4-Pro 的合成 JSON Schema 探针：HTTP 200，耗时 2821 ms，`finish_reason=stop`，JSON 对象符合 `{ok:true}`；上限 128 输出 token、30 秒。此次调用已实际执行，不是 `hasKey` 静态推断。
- 小探针仅证明当前接口与该请求可用；完整 spec Schema 兼容性、真实主 Harness acceptance、自动 Transcript/PG 链及 writer 分别验证，不相互替代。
- 完整 spec 兼容性探针：复用前次合成只读任务的实际 `prompts/spec.md`、当前完整 `requirement-spec.schema.json` 与无工具约束；HTTP 200，30929 ms，`completed=true`、`textOnly=true`、`validJson=true`、`schemaErrorCount=0`、`taskCount=1`。上限 4096 输出 token、120 秒、512 KiB 响应；未输出模型正文。
- 该探针通过同一 `structured-output.validateValue` 校验器，但不是主 CLI dispatch/Acceptance/Transcript E2E，明确记录 `fullHarnessAcceptance=false`。未因为 Schema 通过就切换生产 Harness 或晋级 writer。
- 证据时间 `2026-09-02T04:56:29.076Z`；request SHA-256 `a1069c6671204f7add359c7317c005d2857c9d4b2a725d3da3f9acbd1a739494`；response SHA-256 `8afe5f970a7cfbda4f8924e86754f3db681482fe9d29f83bc46c3bd88b67e12c`；schema SHA-256 `7a23d64d46b0e76bc1200b2fdab00eb9146d2a511e7381d82025df10ed73164b`。

## 本轮验证与沉淀

- A3：随机隔离 PostgreSQL 51/51（A1 13 + A2 24 + A3 14），Linux worker 30/30，真实 supervisor/bwrap E2E 全通过；生产仅升级 shared launcher，未应用任务 schema、worker 或公网路由。详情见 [[2026-09-02-harness-task-runtime-a3-verification]]。
- A2：Windows 31/31 任务测试；Linux auth/storage/config/tasks 共 95/95；真实隔离 PG 37/37 组（A1 13 + A2 24）。修复授权行锁/NULL 竞态、投影类型/Unicode 计数及测试清理，补 queued 同键撤权和真实锁等待证据。源码哈希与远端实测一致，全部临时库/角色清理成功，生产新 schema 为 0。详情见 [[2026-09-02-harness-web-tasks-a2-verification]]，compound 见 [[2026-09-02-task-authorization-row-locks]]。
- A1：Windows 认证 30/30、存储 12/12、配置/CLI 20 pass + 2 POSIX skip；Linux 对应 30/30、12/12、22/22，真实隔离 PostgreSQL 13/13 组通过。无生产账户/数据库/路由变更，测试数据库已清理。
- 安全/数据库性能/架构/质量/测试独立审查发现已修复：断开后的数据库排队、旧快照会话竞争、慢 body 期限、关闭拒绝与超时，以及身份计划遗留措辞。最终 P0/P1 为 0；保留/容量/FK 维护为 A6 前 runbook 跟进。
- 当前依赖审计 0 vulnerabilities；14 个 scoped 文件秘密扫描 0 findings；本地/远端 13 个源码文件 SHA-256 相同。完整结果见 [[2026-09-02-harness-web-auth-a1-verification]]。
- compound：[[2026-09-02-auth-business-admission-and-shutdown]] 与 ADR-040；未创建未经 authority 验证的学习记录。原 Harness、站点发布链接和 Transcript timer 保持不变。
- `npm run site:test`：17/17 通过，为静态站点基线，不是新增功能验收。
- 只读线上核查保留旧 Harness symlink、Transcript timer、现有登录和站点配置；未创建/执行生产业务任务。
- `compound` 记录：登录页 200、模型 `hasKey=true`、demo runner 可运行均不能作为用户身份隔离或 Harness 生产资格证据。候选状态 needs-review，不创建未经 authority 验证的学习记录。

## Related

- [[2026-09-02-harness-transcript-production-wiring]]
- [[2026-09-02-harness-wiring-evidence-boundaries]]
- [[2026-08-27-agent-harness-requirement-alignment]]
