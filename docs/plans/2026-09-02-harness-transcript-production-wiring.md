# Harness / Transcript 生产接线

Status: completed
Date: 2026-09-02
Risk: L4

## 冻结范围

用户要求按审计结论安全、完整接入 Harness 和 Transcript。保留 Claude/Codex 默认路由、Codex 唯一 writer、现有 Acceptance/Completion 状态机。外部 runtime 只读，不启用外部写权限或匿名公网调用。复用 sibling Agent 的 OpenAI-compatible 协议和现有 PostgreSQL 分权模式。

## 实施任务

- [x] H1：受保护配置/receipt/canary 读取、完整 hash 和 endpoint/model 绑定；真实 ProviderAdapter/profile/route。候选版本和回归通过，正式模型仍待验收。
- [x] H2：主 Harness dispatch 与标准 Result/Acceptance envelope；classic 和 pipeline 只读阶段可显式选择，resume 不允许静默换配置。Linux classic/slice/integration review CLI 实测通过。
- [x] T1：authority 调用边界生成语义化 hash-only 事件，自动 durable spool。请求落盘失败零 dispatch；terminal 落盘失败标记 capture-incomplete，保留请求，不重跑已执行任务。
- [x] T2：稳定 source identity、增长文件 cursor、批量 worker、公平重试/幂等/并发锁/独立 reader 精确读回；真实 PostgreSQL 已读回并 ack；独立 timer 已启用。
- [x] V1：主入口→真实 HTTP→Transcript→PG E2E，以及篡改、超时、重复、增长、失败保留和旧 Provider 回归。
- [x] D1：不可变 Linux v15 发布、receipt ACL、worker 与专用 Transcript timer、独立 authority 身份 live 验证和恢复脚本。
- [x] R1：代码/安全/数据库/架构审查、文档与投影同步，并按真实结果关闭任务。

## 验收规则

只有真实 Harness 入口生成 selected 外部 route、标准 accepted result、自动 Transcript job，并经独立 PostgreSQL reader 验证后 ack，才可宣称两条链接通。单独 canary、fixture 单测、HTTP 200 或只存在配置均不算完成。

## 安全不变量

- 外部 HTTP 无工具调用、无 writer、无任意网络目标，仅显式 loopback endpoint；响应大小/时延/输入有界。
- 运行态配置与 receipt 在 provider workspace 外，权限受保护；缺失/漂移 fail closed。
- Transcript 仅记录 IDs、类型、状态、时间、哈希和使用量，不保留 prompt/system/developer/reasoning/响应正文。
- worker 独立持有数据库 env，Provider 无 DB 凭据；采集失败有显式诊断，业务任务不重复执行。
- 不清理用户既有数据、数据库 quarantine 或审计日志。

## 2026-09-02 执行证据与未完成项

### 已验证

- 保留 Claude/Codex 默认路由及 Codex 唯一 writer；外部选项仅 `--external-stages spec,review`。配置绑定 endpoint/model/canary/promotion 与 resume hash。
- 外部 runtime 能力是 `bounded-context`，不是任意 `repo-read`。文件上下文只在 Linux 使用 fd 实际路径、inode 与有界读取；Windows 文件上下文 fail closed。
- 外部 review 在调用前读取当次完整 diff/handoff/validation；缺失、超限、二进制、overflow、实际省略内容拒绝调用。没有把文件路径误当已读证据。
- `test-harness-runtime-wiring.js`、`test-harness-runtime-cli.js`、`test-harness-runtime-recovery.js`、`test-harness-transcript-postgres.js` 本地及受控 Linux 通过；`test-harness-review-cli.js` 的 classic/slice/integration 实际 CLI 路径在 Linux 通过，在 Windows 明确跳过。
- 故障测试覆盖：0-dispatch 请求落盘失败、1-dispatch terminal 失败、半帧停止追加、原子 job/ack 发布、坏 job/ack 隔离、公平轮转、增长/历史篡改、冲突后新行回滚、独立 reader 正文哈希/偏移/长度/item_id/版本复验。
- 全量 `npm test` 实际为 **105 pass / 17 fail / 122 files**（随后新增 Linux review 文件）；17 个失败仍在既有 Windows 短路径/旧投影基线集合内，不宣称全量绿色。
- 安全、数据库/性能、架构、质量、测试独立审查的 P1 均已修复并复审。保留 P2：精确全历史回读随文件增长增加成本，单文件 64 MiB，单次 64 jobs，超时/异常保留并公平重试。

### 服务端状态

- 候选代码：`/var/lib/tech-persistence/authority/runtime-20260902-harness-wiring-v1`，`tp-authority` 持有，非 provider 可写。
- `runtime-current` **仍指向** `/var/lib/tech-persistence/authority/runtime-20260901-p3-live`；未把未合格模型设为当前默认。
- `tech-persistence-transcripts.timer` 已 enabled/active；service 固定候选代码目录，使用既有私有 PostgreSQL env。最近 `Result=success / ExecMainStatus=0`。
- spool：`/var/lib/tech-persistence/authority/transcripts`；job、ack、source 仅含身份/类型/时间/哈希，不存 prompt/模型正文。
- 真实 PG 聚合：`openai-compatible` **2 sessions / 4 events**，类型 `request=2 / error=2`；旧 `llama-cpp` 样本 `1 session / 2 unknown` 保留。两轮 worker 均 `attempted=2 / acknowledged=2 / failed=0`。
- 原 `tech-persistence-llama-runtime.service`（5190）保持运行；新建隔离候选 `tech-persistence-llama-harness.service`（5191，8192 context）已停止且未启用，配置保留便于复现。
- 未删除数据库、quarantine、审计日志或旧发布。禁用新增同步可执行 `systemctl disable --now tech-persistence-transcripts.timer`；停止当前同步可执行 `systemctl stop tech-persistence-transcripts.service`；无需数据库回滚。

### 历史 Live gate（已由 2026-09-03 v15 资格样本取代）

两次真实模型运行都未通过主 Harness acceptance，不能用数据库 ack 或 canary PASS 替代：

| 样本 | 固定 canary | 主 Harness | Transcript |
|---|---|---|---|
| `harness-wiring-20260902-v1` / 5190 | PASS | terminal 未正常完成，拒绝 | 2 events 独立读回并 ack |
| `harness-wiring-20260902-v2` / 5191 | PASS | 120 秒超时，拒绝 | 2 events 独立读回并 ack |

- v1 canary `sha256:5f6227db06e294dc846f566db63c23e41b5211ca9b8cb088de58905c604a812e`；promotion `sha256:d6ade261cf9bf2ec01dc973da67b024f3260b99bada4e55a1a2a8bbd9253c4d6`。
- v2 canary `sha256:ffdfcf8743ee4a460b6a537a690de040ad6b00e334d71f7563bbd42cbd511ccd`；promotion `sha256:d9a8025cf9f2a2b159792e316a0abf48b49297b61c56cfa2ffdaf416f357255b`。
- 证据：`/var/lib/tech-persistence/authority/evidence/harness-wiring-20260902-v{1,2}/live-proof.json`，保留全部失败，不改为成功、不自动重跑用户写入任务。
- 远端原始诊断导出曾被安全审查拒绝；随后只在服务器本地分类并返回固定布尔状态，未导出日志/模型正文。

### 下一步需要的明确选择

1. **模型已获授权**：用户批准复用 Agent 当前 `deepseek-ai/DeepSeek-V4-Pro` 配置及调用费用。小型 JSON 探针和完整 spec Schema 兼容性探针均通过，但后者不是主 Harness dispatch/Acceptance/Transcript E2E；仍需完成受控 broker 与完整 live gate 后才切换 Harness 发布链接，不把模型 Schema 通过等同于上线资格。
2. **已明确**：用户于 2026-09-02 授权 `songuu.top` 登录后创建、执行任务。实施分解见 [[2026-09-02-authenticated-harness-tasks]]；这不代表登录身份、任务隔离、模型资格或公网部署已通过验收，也不允许匿名公开 authority/model/数据库接口。
3. 终端事件因磁盘满/短写而无法记录时，需要按 `capture-incomplete` / incomplete-tail 进行人工协调；自动 worker 同步已持久化事件，不会猜造缺失响应。

## 技能与调试沉淀

使用 work/test-strategy 串行实施，review 触发独立审查与补测；compound/debug-journal 将反例及已验证修复记录到 [[2026-09-02-harness-wiring-evidence-boundaries]]。真实模型资格失败保持未解决，未生成“已解决”的学习结论。没有 native-host EvidenceRef 的自动学习不得晋级为 authority 事实/永久规则。

## 2026-09-03 v15 最终资格证据

- 不可变发布：`/opt/tech-persistence-harness/releases/20260903-harness-web-v15`；runtime receipt `sha256:ec37783c53f7e3aee4355a949adb02bd76f7c609f3c2a079a6fe9d2f73c7853d`，evidence `sha256:48e45ac8aca811d79e6e7949256c670d0ae9ccf89ddfe5bdd1e97616bbd99390`。
- 完整任务：`386bbf93-3e1b-4eab-8037-2c8f30d97de4`，`succeeded/completed`，`confirmationExercised=true`；Transcript `synced`、`eventCount=3`、`lastSyncedAt=2026-09-03T05:42:41.330Z`。
- 专用 `tech-persistence-harness-transcripts.timer` 每 15 秒消费 task runtime spool；首次清空 79 jobs，失败 0，之后生产任务由独立 reader 精确读回。标准安装和恢复脚本均包含该 unit，避免旧 Codex transcript timer 漏消费 task spool。
- 公网 `/tech-persistence/tasks/` TLS 成功；未认证任务 API 返回 401；浏览器页面和控制台通过。Web/worker/broker/Transcript timer active，PostgreSQL、模型和 Web 监听均限制为 loopback。
- Linux 原生沙箱验证 `authoritySecretVisible=false`、`crossTaskVisible=false`、`processTreeKilled=true`。worker Node 进程无 effective capability；固定 launcher 的能力与不可变 release/hash receipt 绑定。

上述真实样本关闭此前两次模型失败留下的 live gate；失败样本和历史 Receipt 仍 append-only 保留，没有改写为成功。

### 登录任务范围确认后的只读核查

- `https://songuu.top/login` 和 `/tech-persistence/` 实测 HTTP 200；登录及 `/auth/` 路由指向现有 `deploy-management` web（loopback 3000），不是本仓库的账户系统。
- 初次 sibling Agent runner `/api/config` 只读取摘要，返回 `provider=openai`、`model=deepseek-ai/DeepSeek-V4-Pro`、`hasKey=true`、`baseURL=custom`。随后用户明确批准复用及费用，在服务器内部使用该配置执行两次模型探针；密钥未导出到本地或会话，完整 Harness qualification 仍未通过。
- 服务器默认 PATH 上 `codex`、`claude` CLI 均不存在；这不排除其他私有安装，但目前没有已验证的可用原生 writer。外部只读模型不得据此晋级 writer。
- 线上登录源码第一次读取被 auto-review 拒绝后未绕过。用户专项授权后重新审批读取脱敏代码，并核对当前运行版本：共享密码返回固定 Cookie，登出只清浏览器 Cookie。其不满足独立主体与服务端会话撤销；新增 TP 独立账户方案随后已获批准。A1 候选通过 Linux 64 项和真实 PG 13 组检查，独立审查闭环，未修改其他站点登录或开放公网。证据见 [[2026-09-02-harness-web-auth-a1-verification]]。后续获批 A2 持久任务候选也已完成，Linux 共 95 项、真实 PG 37 组通过；见 [[2026-09-02-harness-web-tasks-a2-verification]]。A3–A6 仍未完成，生产身份/任务 schema 与新公网路由均未安装。
- `agent-api /ready` 仍为 503；既有 scanner gate 未绕过。磁盘仍约 2.0 GiB 可用、使用率 96%。本轮未修改服务器配置、账户或发布链接。
- `npm run site:test`：17/17 通过，只证明既有静态站点回归，不证明新增登录任务功能。
- DeepSeek 完整 spec 探针：HTTP 200、30929 ms、正常 text-only terminal、有效 JSON、当前 Schema 校验 0 错误、1 个任务；使用真实合成任务的 Harness prompt/schema，但明确 `fullHarnessAcceptance=false`。哈希和身份审阅证据见 [[2026-09-02-authenticated-harness-tasks]]。
