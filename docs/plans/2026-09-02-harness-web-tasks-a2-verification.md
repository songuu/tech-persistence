# A2 持久任务底座验证

Date: 2026-09-02
Status: completed-candidate / not-deployed
Risk: L4
Parent: [[2026-09-02-authenticated-harness-tasks]]

## 完成范围与证据边界

新增 `task-service` / `task-store`、`002-tasks.sql` 及本地/真实 PostgreSQL 测试。身份从 A1 session hash 恢复；归属、项目权限、幂等、配额、draft → queued 与查询投影在受限函数和显式 READ COMMITTED 事务内执行。参考 sibling Agent 的参数化 PG 与独立角色模式，没有复制其宽权限 writer。

没有新增 HTTP 路由、运行入口、claim、dispatch、sandbox、Receipt/Transcript 写权限或 accepted 状态。没有迁移生产库、创建生产账户/任务或切换公网发布。A2 候选完成不等于 Harness + Transcript 完整功能或 `songuu.top` 可执行任务；A3–A6 仍未完成。

## 实测

| 验证 | 结果 | 限制 |
|---|---|---|
| Windows `test-harness-web-tasks.js` | 31/31 | 仅服务/存储边界与测试清理，不是实际 PG |
| Windows `run-tests.js --grep harness-web` | 6 文件退出 0 | 2 个 POSIX 用例跳过，2 个 PG 入口默认 SKIP；不计为实库验收 |
| Windows Node coverage，31 项 | service/store 均 100% 行/函数；分支 91.40% / 90% | 此为新增两模块覆盖，不是整个仓库或 SQL 覆盖率 |
| Linux auth/storage/config/tasks | 95/95，0 skip | 30 + 12 + 22 + 31；包含真实 HTTP/CLI 生命周期 |
| Linux PG 17，最终隔离实库 | 37/37 组 | A1 13 + A2 24，合成 fixture；无 provider 调用 |
| 11 文件 scoped secret scan | 0 findings | 仅明确列出的 A2 文件及关联计划/运行说明/证据/沉淀 |
| `git diff --check` | 通过 | 既有 CRLF/LF 提示不是 whitespace error；保留无关工作树改动 |

未重新宣称全仓 `npm test` 全绿：父计划记载的 Windows 既有失败集合仍未在 A2 范围处理。无新增依赖，沿用 A1 当日依赖审计 0 vulnerabilities，不把旧审计说成本轮重新执行。没有 PR/CI 合并就绪元数据；新文件仍由用户工作树保留，未 stage/commit。

## 修复与 RED/GREEN

1. **授权撤销竞态（P1）**：READ COMMITTED 下先读取授权、后变更任务，成员在中间删除会使第二次查询返回 NULL；旧 `IF NOT allowed` 不拒绝 NULL。create 同样没有固定策略行。先加真实并发回归，旧代码在等待断言失败；修复使用 `FOR SHARE OF p,m` 保持至事务提交，当前 `p.enabled`、`FOUND` 和 `IS DISTINCT FROM true` 明确拒绝。
2. **7 类真实撤权竞争**：create 的成员删除/can_create=false/项目禁用；enqueue 的成员删除/can_execute=false/项目禁用/qualification=false。测试先以独立连接修改授权但不提交，确认 task backend 的 transactionid 锁未授予，再提交撤权，断言拒绝且没有新任务/排队。不注入测试版函数或用 sleep 猜测执行位置。
3. **时间戳投影（P2）**：`task_view` 从 IMMUTABLE 改 STABLE，并检查 `pg_proc.provolatile`。JSON 时间戳输出可能依赖 TimeZone；见 [PostgreSQL 函数 volatility 文档](https://www.postgresql.org/docs/current/xfunc-volatility.html)。锁等待后的条件重判与 [PostgreSQL 17 READ COMMITTED 文档](https://www.postgresql.org/docs/17/transaction-iso.html) 一致，另有本轮实测。
4. **输出类型/字符计数（P2）**：数组 ID 被正则隐式转字符串、128 个 astral 字符被 UTF-16 长度误拒，均先产生失败回归；现 ID 必须 primitive string，项目名使用 codepoint 数。PG 同组验证 128 个 astral 字符可读、129 违反约束。
5. **夹具稳定性**：随机 UUID 的 `replace('-4', '-1')` 可能改到其他分组，导致本应非法的键仍合法；改为确定性键及固定 version 位替换。初次修后连续 5 轮 27/27。
6. **测试审查补证**：已 queued 任务用原 execution key 重放，在成员删除/项目禁用/执行权限或资格关闭后分别拒绝且完整持久行不变；恢复授权后仍只重放原任务。session 到期测试预取 client/PID，观察未授予的 advisory lock 后才等待 TTL，不把连接调度延迟当作锁后重验。最后两项只增强测试，不改变业务代码。
7. **测试资源清理（P2）**：连接分步获取并立刻纳入 try/finally；RESET ROLE/ROLLBACK 失败也销毁 fixture client，嵌套 finally 保证另一 client 始终释放，避免故障时阻塞 pool.end 和临时库清理。新增 2 项本地故障/成功回归，质量复审已关闭该项。

## 真实 PG 范围与清理

覆盖 web 角色无表/私有函数访问、task owner 无身份修改/口令读取/业务角色继承、双主体隔离、撤销/停用/版本/过期、成员及项目撤权、同键并发创建与入队、冲突、主体和全局速率/队列/保留上限、回滚、跨池持久读回、带时间戳并列的分页、非安全隔离拒绝，以及 session 在全局锁等待期间到期。

测试宿主 `/var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t` 不是 active runtime。每轮随机库仅在核对名称、owner、marker 后删除；错误轮也清理成功：

| 临时数据库后缀 | 结果 |
|---|---|
| `8f4908ab92e500aa` | 首轮 33 组通过 |
| `8ee29a46c769c609` | 撤权反例 RED，按预期失败 |
| `bc28428915a0deb3` | 修后 35 组通过 |
| `e33c2982e423ab48` | Unicode 修复后 35 组通过；Linux 93 项通过 |
| `4a10887b246edbc1` | 新增 owner 权限负向组后 36 组通过 |
| `4a726288db2a8823` | 新增 queued 同键重放撤权后 37 组通过 |
| `d1e8768170722a9f` | 锁等待到期夹具增强后 37 组通过 |
| `2655bbb80a0d4f7b` | 资源清理修复后最终 37 组通过；Linux 95 项通过 |

各轮 `cleanupVerified=true / productionDatabaseTouched=false`。最终独立只读查询：`remaining_test_databases=0`、`remaining_test_roles=0`。仅测试合成数据已删除，不存在需恢复的生产数据删除。

最终 20 并发不同键创建，仅 5 个成功，其余明确受配额拒绝；本轮观测 110 ms。此数字不含完整 HTTP/模型负载，也不是性能 SLA。A6 仍需 EXPLAIN/容量实测。

## 独立审查派遣

使用 `review` 技能的真实子代理机制；五个视角只读，受 4 个总并发槽限制分批执行，均继承当前模型，不擅自映射不可用的 sonnet/haiku 别名。设计视角跳过：无 UI 变更。

| 视角 | 最终状态 | 结论 |
|---|---|---|
| security | DONE | 撤权 P1 与 owner 权限补测已关闭；生产 ACL/参数日志与 A4 编码保留发布门 |
| database/performance | DONE_WITH_CONCERNS | P1/P2 修复；P3 EXPLAIN 与上线容量门保留 |
| architecture | DONE_WITH_CONCERNS | A2 边界一致；P2 最小权限、可审计离线项目授权入口留 A6 |
| quality | DONE | primitive string / Unicode 修复已核验，无剩余 P0/P1/P2 |
| tests | DONE | queued 同键重放、实锁等待与最新实库证据缺口已闭环；A3 状态扩展后的独立速率/历史分支留跟进 |

### Gap Detection / 文档与代码核对

| 工作流/不变量 | 已有证据 | 剩余缺口与处置 |
|---|---|---|
| 登录主体 → 持久化/查询自己的任务 | token/CSRF 单测 + 真实 PG 双主体/撤权/过期 | 无 A2 缺口；A4 仍需真实浏览器与 HTTP 集成 |
| 重复请求 → 唯一任务/一次入队 | 双池 20 并发、key 冲突、事务回滚 | A3 必须另证 durable claim 与副作用未知时不重放 |
| 授权更新 → 任务变更 | 7 种真锁等待、显式 NULL 拒绝 | A6 管理入口遵守全局锁/行锁顺序；身份检查点不回溯取消在途事务 |
| 队列 → Harness/Receipt/Transcript | A2 没有 dispatch 或相应写权限 | A3–A5 未完成，不作整链完成声明 |
| 跨 runtime 与生产 state | Windows/Linux 及同文件哈希；旧发布不变 | 原 Harness/Transcript hook 和发布未重构，不生成新投影或伪造 Receipt |
| 权限/回滚 | 临时对象 owner/marker 清理、web/owner 负向测试 | 生产 Receipt/Transcript 不在临时库；A6 必须独立查有效 ACL、日志、容量和回退新路由 |

## 实测源码指纹

六项本地与受控 Linux 实测文件 SHA-256 完全一致（后续测试增量如有，应重新核对）：

| 文件 | SHA-256 |
|---|---|
| `scripts/harness-web/task-service.js` | `1895899a5ad69df2c19daae063ac7cd153f9fe0aed9dee15db49e8a5f30dfed1` |
| `scripts/harness-web/task-store.js` | `1f43157d7ae87f3b6e002cf92f94f077b26e829a02c2c35ef9069f7ba786ab55` |
| `scripts/test-harness-web-tasks.js` | `b41602b2efa537695fff8f777f7cb5fecd47c562f95adf2708c62c34c4962d57` |
| `scripts/test-harness-web-tasks-postgres.js` | `4a8c839b3e05734a4e47a1e27a97b8c31dc1cdd7f0205570c77a4ad0b56ca015` |
| `scripts/test-harness-web-postgres.js` | `2aeb9bbb6854de92f745ece08ce29138a18e3113229b08101e3e0b1d71aa0913` |
| `deploy/harness-web/002-tasks.sql` | `e5678cffa5af5e7e9ab8aeafa421e204ad32162533af27c228fe2542041c6ff6` |

## 生产边界核验

只读核验时 authority `runtime-current` 仍为 `runtime-20260901-p3-live`，站点仍为 `20260901-agent-harness-p3-live-v2`，Transcript timer active；生产 `harness_web`/`harness_tasks` schema 数量为 0。磁盘 40 GiB、使用 96%、可用约 1.7 GiB；不通过删除他人日志/数据解决容量。未修改既有登录、nginx 或生产授权配置。

## Related

- Compound：1 个解决方案、ADR-040 的 A2 边界、5 个项目 skill 使用信号；未创建/晋级本能。Solution index: synced 57 entries → docs/solutions/index.jsonl + runtime instruction docs（实际只更新 CLAUDE.md 托管投影，AGENTS.md 不变）。全局 Stage A 暂无对应信号，项目五个 skill 各 2 calls、observe；不据此制造健康诊断。
- [[2026-09-02-authenticated-harness-tasks]]
- [[2026-09-02-harness-web-auth-a1-verification]]
- [[2026-09-02-harness-transcript-production-wiring]]
