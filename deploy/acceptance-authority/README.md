# Acceptance authority Linux OS boundary

本目录把 P1-4 的运行时 UID/GID 机制落成可部署边界。它不会自动连接远端主机；必须在目标 Linux 宿主上由 root 显式执行，并保存最后的 JSON audit 作为部署证据。

## 边界

| 主体/资产 | owner 与 mode | 权限 |
|---|---|---|
| `tp-authority` | 独立 system user/group | 运行 orchestrator、读取 acceptance env、写 control root |
| `tp-provider` | 独立 system user/group | 只运行 provider、写 provider workspace |
| `provider-identity-launcher` | `root:tp-authority 0750` + `cap_setuid,cap_setgid,cap_kill=ep` | 编译时固化双方 UID/GID；authority 父进程监督并有界终止，provider 子进程清空全部能力 |
| authority home/control | `tp-authority:tp-authority 0700` | provider 不可读写 |
| `acceptance.env` | `tp-authority:tp-authority 0600` | provider 不可读 |
| provider home | `tp-provider:tp-provider 0700` | provider 私有 HOME |
| shared workdir | `tp-authority:tp-provider 0770` | authority 可编排/检查，provider 可实现；不放 authority runtime 或 secret |

两个账号都使用 `/usr/sbin/nologin`，且只允许自己的 primary group。所有表中路径及 launcher canonical
父目录链都拒绝 named/default extended ACL；mode 正确但 ACL 额外授权同样会失败。

authority orchestrator、plugin runtime、broker 和数据库 env 必须从 authority-owned、shared workdir 外路径加载。
shared workdir 只承载被 provider 修改的项目；不得从该目录执行 harness 本身，否则 provider 可在下一轮替换 authority 代码。

## 部署

只从已验证的 release checkout 执行 root installer；不要从 provider 可写的 workspace 运行它。

先检查固定变更，不会写宿主：

```sh
sh deploy/acceptance-authority/install-linux.sh plan
```

确认目标就是该 Linux 宿主后，以 root 使用 plan 输出的固定令牌执行。脚本幂等创建账号/目录，已有 `acceptance.env` 只收紧 owner/mode，绝不覆盖内容；已有账号若 primary group/home 不匹配会 fail closed。

```sh
sh deploy/acceptance-authority/install-linux.sh apply APPLY_TECH_PERSISTENCE_OS_BOUNDARY_V1
```

安装末尾自动以 `tp-authority` 身份运行 auditor。它会通过 capability launcher 真实降权，并验证：

- effective UID/GID 是 provider，supplementary groups 已清空；
- provider 不能读取 `acceptance.env`；
- provider 不能写 control root；
- provider 可以写 workspace；
- launcher、整条 canonical parent chain、账号、owner/mode 和 capabilities 全部符合合同。
- launcher 拒绝切换到 authority/root UID，也拒绝相对 command；安装错通用 `setpriv` 时 audit 会失败。

任何 `[FAIL]` 或非零退出码都不能作为 P1-4 部署证据。

## Orchestrator

从安装输出读取实际 UID/GID，并始终启用强制开关：

```text
--provider-uid <tp-provider uid>
--provider-gid <tp-provider gid>
--provider-home /var/lib/tech-persistence/provider
--provider-setpriv-path /usr/local/libexec/tech-persistence/provider-identity-launcher
--require-provider-os-isolation
```

PostgreSQL reader/writer URL 写入 authority-owned `acceptance.env`，不要放入 provider workspace。auditor 从不读取或输出文件内容。
