---
title: "Provider 进程的可验证 OS 身份边界"
date: 2026-09-01
tags: [solution, security, agent-harness, linux]
related_instincts: []
aliases: ["provider UID isolation", "setpriv authority boundary"]
---

# Provider 进程的可验证 OS 身份边界

## Problem

外部 control store 与 PostgreSQL role 隔离仍不足以抵抗同一 OS 用户：provider 可读取 authority 私密配置，甚至替换未受保护的 broker/launcher。

## Root Cause

路径位于 workspace 外只说明目录布局，不授予 provenance。若 harness 与 provider 共享 UID、HOME、supplementary groups 和进程环境，文件权限与数据库秘密仍处于同一主体控制下。

## Solution

Linux dispatch 显式接收独立 provider UID/GID 与 provider-owned home，并通过受约束的 launcher 执行既有 `setpriv` 形状的 argv：

```text
provider-identity-launcher --reuid <fixed-provider-uid> --regid <fixed-provider-gid> --clear-groups -- /absolute/provider <args>
```

不能给通用 `setpriv` 二进制附 `cap_setuid,cap_setgid`：authority 随后可请求任意 UID，等价于获得 root 身份切换能力。部署脚本改为编译 C launcher，在编译期固化 authority/provider UID/GID，只接受上述 exact argv，校验 caller UID，依次清空 supplementary groups、切换 GID/UID、清空 capabilities、启用 `no_new_privs`，再以 `execv` 执行绝对 command。

启动前拒绝同 authority UID、相对路径、link、非 root owner、group/other 可写 launcher，以及 canonical launcher 整条可替换父目录链；provider home 必须为对应 UID 拥有的非链接目录。子进程环境改写 HOME/XDG，剥离 authority 用户、SSH/GPG/sudo 与私密 PostgreSQL URL。执行后再次检查 launcher 权限和 SHA-256；漂移以专用 failure kind fail closed。生产配置使用 `--require-provider-os-isolation` 防止静默退化。

Linux deployment contract 固定两个 nologin、无 supplementary groups 的 system account。launcher 为 `root:tp-authority 0750`、单硬链接且只有 `cap_setuid,cap_setgid=ep`；authority/provider 私有目录分别为 0700，secret env 为 0600。shared workdir 使用 `tp-authority:tp-provider 0770`，让 authority 能编排 provider 的修改，但 harness、plugin、broker 与 env 必须位于 workdir 外的 authority-owned 路径。installer 清除 named/default ACL；read-only auditor 既检查 owner/mode/capability/ACL，也真实反向探测 provider 无法读 secret、无法读写 control、无法执行 launcher或切到 root/authority，同时仍可写 shared workdir。

## Prevention

- 不把路径隔离、环境变量隐藏或 PostgreSQL role 分离表述为 OS authority。
- provider launcher 的文件和父目录链必须一起验证，并在执行后复验。
- 不给通用身份切换工具配置 file capabilities；最小 capability 必须落在只允许一个编译期目标身份的受约束 launcher 上。
- root installer 只从已验证且 provider 不可写的 release checkout 执行。
- mode 检查必须同时覆盖 hardlink 与 extended ACL；否则 0600/0700 仍可能存在旁路授权。
- 仓库内机制通过不等于宿主部署完成；账号、capability、ACL 和 provider 反向访问测试必须另有审计证据。
- Windows 不模拟 Linux UID 隔离，配置后直接 fail closed。

## Related

- [[2026-08-27-agent-harness-requirement-alignment]]
- [[2026-09-01-shadow-acceptance-evidence-boundary]]
- [[session-2026-09-01]]
