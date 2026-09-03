# A1 独立账户验证记录

Date: 2026-09-02
Scope: [[2026-09-02-authenticated-harness-tasks]] / A1 only
Disposition: verified-candidate; not-production-release

这是工程测试与审查记录，不是 Harness Acceptance Receipt、模型 promotion 或 authority Learning EvidenceRef。

## 派遣与审查

- 风险 L4。4 个独立只读 reviewer，覆盖安全、数据库/性能、架构、代码质量、测试五类视角；架构 reviewer 另以独立轮次做 JS 质量审查，测试 reviewer 使用 TypeScript/JavaScript 专项角色。
- 模型继承主任务；技能中 sonnet/haiku 名称不在可用模型中，没有擅自映射。无 UI 变更，不启用设计视角。
- 初审发现 4 类问题：匿名查询无界排队、事务默认隔离依赖、HTTP 接收期限扫描过慢、退出故障与成功路径缺测；另有计划身份方案旧措辞。全部对应实现/文档修正和回归。
- 4 个 reviewer 均完成定向复审，最终全部 `DONE`；总计 4 次修复复审（架构 reviewer 额外有 1 次质量视角委派），无 `BLOCKED`，没有绕过失败项继续部署。
- P2 留存：未来全历史 FK 维护索引；会话保留/归档与容量告警；限流饱和更新的 WAL 成本。见 `deploy/harness-web/README.md`，没有擅自增加删除操作。

## 实际测试

| 命令/检查 | Windows | 受控 Linux |
|---|---|---|
| `node scripts/test-harness-web-auth.js` | 30/30 | 30/30 |
| `node scripts/test-harness-web-storage.js` | 12/12 | 12/12 |
| `node scripts/test-harness-web-config.js` | 20 pass / 2 POSIX skip | 22/22 |
| `node scripts/test-harness-web-postgres.js --controlled-postgres` | 不适用，默认明确 SKIP | 13/13 组真实 PG 检查 |
| `npm run site:test` | 17/17 | 本轮未重复 |
| `npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org` | 0 vulnerabilities | 未重复 |
| scoped secret scan | 14 files / 0 findings | 未重复 |
| `git diff --check` | 通过，存在既有换行提示 | 不适用 |

本轮不是全仓库绿色声明。既有 Harness/Transcript 与平台基线结果见父计划；当前新增认证测试通过不能抹掉其他已有未完成项。

### 回归反例

1. 断开连接：慢数据库下 60 个匿名请求全部进入业务；修复后固定 16。独立 reviewer 的 200 请求复现从 196 个 pool waiter 降为 12，其余 184 个返回 429。finally 在业务结束而非 socket close 时释放。
2. 旧快照：真实 PG 连接默认 REPEATABLE READ、已有 7 个会话，两个事务等待同一 advisory lock；旧代码断言失败。显式 READ COMMITTED 后仅一个新增成功，不超过 8。
3. 慢 body：旧实现 8 秒后仍无响应，默认扫描 30 秒；250 ms 扫描后 Linux 约 5.01 秒关闭，未进入密码校验。
4. 关闭：pool.end 拒绝时旧代码泄漏错误；未完成 Promise 配合 unref deadline 旧代码退出 0。新增子进程测试均先失败，修复后拒绝脱敏、超时约 5 秒非零退出、正常 SIGTERM/INT 与重复信号只关闭一次。

### 真实 PostgreSQL 内容

PostgreSQL 17.10，Node 24.13.0，宿主 `47.253.230.197`。验证目录 `/var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t`，不是生产 runtime。

- 隔离创建账户和分权：运行角色不能改账户/删除会话/延长期限/创建表；管理角色不能读会话/删除账户/更名。
- 真正事务提交后的独立连接读回、只存 token hash、冲突回滚和故障事务新行消失。
- 20 路会话创建只允许 8 个；REPEATABLE READ 环境下的两个锁等待者反例修复。
- CSRF、撤销重放、数据库到期、停用、旧密码/旧版本失效、密码重置不重新启用。
- 并发账户限流 5、全局限流 60、桶数量有界及预算到期；连接失败不认证/签发。
- 测试数据库依次为 `tp_auth_test_8c3eb55182e583c0`（首轮 12 组通过）、`tp_auth_test_ecc0104336513046`（旧快照反例 RED）、`tp_auth_test_b0504c242ad5c716`（修后 13 组通过）。每轮均 `cleanupVerified=true / productionDatabaseTouched=false`；清理前核对随机名称、所有者和 marker，最后只读查询残留测试库数量为 0。

## 最终源码对应

以下 13 项 SHA-256 已逐项比对本地与 Linux 实测目录，完全相同：

| 文件 | SHA-256 |
|---|---|
| scripts/harness-web/account-admin.js | a5b31fd4ed17bf5e908f468690c5b8b14fd76d42b6ed09b10e2a18a0a51a45c5 |
| scripts/harness-web/auth-server.js | 9d805951954f2d144109a4ca351295efb5dff636ca10d6948409055a09fd017c |
| scripts/harness-web/auth-store.js | e5a9f7367d7de6dab3927f8e71b05ea3f6d0a737bfced69baa425519d5707456 |
| scripts/harness-web/auth.js | ed5e420fc45362737f75770e147c1398b2800807ac7e72d3133a823ca4bccdec |
| scripts/harness-web/config.js | aab4bb671c2ecfa2674c5a735c66d879b86a87c1782d573833fc2d8ccdcb0308 |
| scripts/harness-web/password.js | 103dd3bc5d5d84dd2d4682cba480747a09e4d45f2ce5793a1107a89804d752cb |
| scripts/harness-web-auth.js | 893b9503578a4f97bec4e8a391c80b3de63c0008e183be76a50d2a6c44cc5f4a |
| scripts/harness-web-account.js | 67d0adf57ec2b9c26ef1f24d56f9278821e01490ff87f24fcf947499a4681867 |
| scripts/test-harness-web-auth.js | defa690bd12d24ed1c4a1f51d9240d171eb8479635f955f1fe3f3077fe8677a2 |
| scripts/test-harness-web-storage.js | ff908b319a68ac1c0f9782273b6606f8b19d18cd1215e6b219b8597ae39261b9 |
| scripts/test-harness-web-config.js | 63c9c95b0b7f884bfd8d7198e692299a76855f7af5e83650fc92c151a6489d44 |
| scripts/test-harness-web-postgres.js | 7edffc0f9db13347124a3871dda19661469b778aaef0b23687eed536f8e47749 |
| deploy/harness-web/001-auth.sql | a0646e405f9d6e935f191cb20b2bde7e54a6d6794d50224603b1c9ec1b81271a |

## 生产状态与未完成项

只读复核：authority `runtime-current` 仍指向 `runtime-20260901-p3-live`；站点仍为 `20260901-agent-harness-p3-live-v2`；`tech-persistence-transcripts.timer` 仍 active。没有修改现有登录、nginx、生产账户或生产数据库，未开放新公网接口。

A2 持久任务/归属/幂等队列、A3 执行与沙箱/模型 broker/原生 writer、A4 网页、A5 真实全链验收、A6 部署尚未完成。磁盘约 2 GiB、writer 资格与其他同源应用风险需在对应门禁解决；本记录不能替代这些证明。

## Related

- [[2026-09-02-authenticated-harness-tasks]]
- [[2026-09-02-harness-transcript-production-wiring]]
- [[2026-09-02-auth-business-admission-and-shutdown]]
