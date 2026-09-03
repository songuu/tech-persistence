---
type: verification
date: "2026-09-02"
phase: A3-runtime-foundation
status: passed-with-followups
tags: [harness, tasks, authority, linux, postgres, security]
---

# Harness task runtime A3 验证

## 结论

A3 的 durable claim/恢复状态机、authority worker 隔离、provider capability supervisor、独立模型 broker 和 native Codex writer 已通过真实 PostgreSQL 与受控 Linux 验证。shared launcher 已原子升级且保留回滚副本；任务生产 schema、broker/worker 服务和公网路由尚未部署，因此 A3 总任务仍未完成。

## 可复验证据

- 随机隔离 PostgreSQL：51/51 组通过，其中 A3 14 组；数据库 `tp_auth_test_913f2149c1db45bc` 已清理，`productionDatabaseTouched=false`。
- worker：Windows 30 项中 28 pass、2 个 POSIX-only skip；Linux 30/30。
- broker：本地与 Linux 11/11；真实上游文本、强制工具调用和 structured-output Chat 均通过，只输出布尔结果与响应哈希。
- native writer：固定 `@openai/codex@0.152.1` 在 provider UID 986、断网 bwrap、Unix socket broker 下实际写入唯一固定文件；workspace hash `518b2183280b4283df39bc6b952d5b17b390525cf6b96ab8c29eba178c19a067`，成功 transcript hash `968b917d3e6026f6ee2bed75a119b6eca3400032a70d24a8fd3e80af872b2b44`。
- external canary：固定 9 case 全通过并生成只读 promotion；canary 文件 hash `52c70503f4a43ff26847fcaa3b34f8814f30fe9654e531da7ed300cf1b9aac0e`，promotion 文件 hash `a08a60544ebfd31243584a5159d17e866283cf07f5ec410cc22fbccceccc7820`。
- Linux E2E：`controlledLinuxSandbox=true`、`providerGid=986`、`stagedTrackedOnly=true`、`authoritySecretVisible=false`、`crossTaskVisible=false`、`processTreeKilled=true`、`outcome=needs_coordination`。
- supervisor 边界审计：调用者/身份/GID/补充组、secret/control/workspace ACL、父目录、单硬链接和 capabilities 全部通过。
- 生产 launcher：SHA-256 `8b829ecd4fadab3e4dcc6c602f1868c827357df409485dd492d30f8a90efb80b`；`root:tp-authority 0750`；`cap_kill,cap_setgid,cap_setuid=ep`。

## 安全属性

- requirement 只进入独立只读文件，不进入 shell 或 argv。
- sourceRoot 来自受保护项目注册表；clone 使用 root 管理、逐字匹配且无通配符的 Git system allowlist，只复制当前 HEAD 的 shallow 工作副本。
- bwrap 仅绑定当前 attempt 的 input/output、固定 runtime 与 workspace，默认隔离网络；launcher 子进程清空能力和补充组并设置 no-new-privileges。
- C supervisor 固定 CPU、地址空间、进程数、单文件、FD 与 core dump 限制；worker 保留磁盘余量，并通过 provider 身份的固定 `du -sb -- <workspace>` 在 clone 后和心跳期约束总工作区体积。
- dispatch 前停机只释放当前 fencing token 的 claim；dispatch 后未知副作用不自动重放，进入需协调路径。
- stdout/stderr 位于 provider 不可写的 authority evidence 目录，resultRef 同时绑定 task ID 与 claim token。

## 生产变更与回滚

- 已变更：`/usr/local/libexec/tech-persistence/provider-identity-launcher`。
- 回滚副本：`/var/lib/tech-persistence/authority/provider-identity-launcher.pre-a3-20260902`。
- 未变更：生产 PostgreSQL task schema、worker systemd、nginx、站点 release、业务任务和账户数据。

## 后续门

1. 用已合格 broker/native writer 执行主 Harness spec→implementation→review 完整任务，并验证自动 Transcript/PG 链。
2. 生成 root 管理 Git allowlist、broker/worker 配置与 systemd unit，完成失败自动回滚演练。
3. 完成 A4 页面/API、Transcript ACL/同步状态与浏览器 E2E。
4. A5/A6 做全链路验收、容量/EXPLAIN、生产迁移、灰度与公网开放。

## Related

- [[2026-09-02-authenticated-harness-tasks]]
- [[2026-09-02-harness-web-tasks-a2-verification]]
- [[2026-08-27-agent-harness-requirement-alignment]]
