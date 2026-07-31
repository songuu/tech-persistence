# Tech Persistence 静态站部署手册

这份 runbook 只负责 `https://songuu.top/tech-persistence/` 的独立静态站。标准链路固定为：

```text
local gates -> site/build.js -> tgz/scp -> releases/<release-id> -> current 原子切换 -> remote loopback -> public HTTPS
```

脚本不会读取或打包其他项目的构建目录。默认构建输入固定为本仓库的 `site/dist`，并且会拒绝 `site/` 目录之外的 `-BuildOutput`。

## 1. 为什么直接放在当前仓库

站点展示的是本仓库的技能、命令、架构文档和版本状态，数据生成也依赖这些源文件。因此当前阶段采用“同仓库、独立 `site/` 边界”：

- 源数据变化与站点构建可以在同一次提交和 CI 中验证，减少跨仓库漂移。
- `site/build.js`、`site/dist` 和 `scripts/deploy-site.ps1` 与插件运行时代码隔离。
- 将来如果站点需要独立后端、账号体系或单独发布节奏，再把 `site/` 提取成新项目；静态发布契约不需要变化。

## 2. 默认生产配置

| 项目 | 默认值 |
|---|---|
| SSH 目标 | `root@47.253.230.197` |
| 域名 | `songuu.top` |
| base path | `/tech-persistence/` |
| 本地产物 | `site/dist` |
| 远端根目录 | `/opt/tech-persistence` |
| 不可变版本 | `/opt/tech-persistence/releases/<release-id>` |
| 当前版本 | `/opt/tech-persistence/current` 符号链接 |
| 前一版本 | `/opt/tech-persistence/previous` 符号链接 |
| 默认旧版本保留数 | `3` |

`BackupRetention` 表示保留多少个非当前版本；服务器通常会保留当前版本加最近 `BackupRetention` 个旧版本。

## 3. 一键入口与 DryRun

先做无副作用配置检查：

```powershell
pwsh -NoProfile -File scripts/deploy-site.ps1 -DryRun
```

`-DryRun` 只解析 provider、主机、路径、base、发布号和验证目标；不会运行 local gates、构建、打包、上传、SSH 写入或 HTTP 请求。

正式发布：

```powershell
pwsh -NoProfile -File scripts/deploy-site.ps1
```

自定义主机和路径：

```powershell
pwsh -NoProfile -File scripts/deploy-site.ps1 `
  -Provider custom `
  -DeployHost root@preview.example.com `
  -RemoteRoot /srv/tech-persistence `
  -Domain preview.example.com `
  -BasePath /tech-persistence/ `
  -PublicOrigin https://preview.example.com `
  -BackupRetention 5
```

provider 可选 `aliyun|volcengine|tencent|custom`。阿里云使用当前生产默认值；其余 provider 可通过参数或以下环境变量配置：

- `TECH_PERSISTENCE_VOLCENGINE_HOST`
- `TECH_PERSISTENCE_TENCENT_HOST`
- `TECH_PERSISTENCE_DEPLOY_HOST`
- 对应的 `*_REMOTE_ROOT`、`*_DOMAIN`、`*_BASE_PATH`、`*_PUBLIC_ORIGIN`

参数覆盖始终优先于环境变量和 profile 默认值。

## 4. 脚本执行合同

`scripts/deploy-site.ps1` 按以下顺序执行：

1. 解析参数并执行路径安全检查；本地产物必须在本仓库 `site/` 下。
2. local gates：用 Node test runner 运行 `site/tests/*.test.js`。
3. 调用 `node site/build.js --base /tech-persistence/ --output <site-dist>`。
4. 自检 `index.html`、base path 和构建文件数。
5. 只把 `site/dist` 内容打成 `tech-persistence-site-*.tgz` 并通过 `scp` 上传到远端 `/tmp`。
6. 在 `/opt/tech-persistence/releases/<release-id>` 创建不可变版本并验证 `index.html`。
7. 用临时符号链接加 GNU `mv -Tf` 原子切换 `current`，同时把旧目标记录为 `previous`。
8. 按修改时间裁剪旧 release，保留当前版本和最近 `BackupRetention` 个旧版本。
9. 远端使用 `127.0.0.1` 加 `Host: songuu.top` 执行 remote loopback 200 验证。
10. 本机对 `https://songuu.top/tech-persistence/` 等路径执行 public HTTPS HEAD 验证。
11. 任一切换后验证失败时，脚本尝试把 `current` 自动恢复到 `previous`，并以失败退出。

只有显式传入 `-SkipVerify` 才会跳过第 9、10、11 步。`-SkipTests`、`-SkipBuild` 和 `-SkipVerify` 都只用于已具备等价证据的受控恢复场景，不应作为日常发布参数。

## 5. Nginx 一次性配置

仓库提供 [location 片段](../deploy/nginx/tech-persistence.location.conf)。它只声明 `/tech-persistence` 和 `/tech-persistence/`，不会接管 `/`、`/agent-build/`、`/pipeline/` 或其他现有入口。

先复制到服务器：

```powershell
scp deploy/nginx/tech-persistence.location.conf root@47.253.230.197:/etc/nginx/snippets/tech-persistence.location.conf
```

然后在服务器现有的 `songuu.top` HTTPS `server { ... }` 中加入：

```nginx
include /etc/nginx/snippets/tech-persistence.location.conf;
```

首次发布前 `current` 可能尚不存在，这是正常的。加入 `include` 后应先执行 `nginx -t` 并重载；Nginx 不要求 alias 目标在配置检查时已经存在。随后运行一次部署脚本创建 `current`，脚本会完成正式的 loopback 和公网验证。

一次性配置检查与重载：

```bash
nginx -t
systemctl reload nginx
```

首个 release 发布后再验证：

```bash
curl -kI -H 'Host: songuu.top' https://127.0.0.1/tech-persistence/
```

如果线上 Nginx 配置由面板或模板管理，应把同一 `include` 写回其源模板，避免下一次面板发布覆盖手工改动。

## 6. 验证层次

发布结果必须分层记录：

1. local gates 是否通过。
2. `site/build.js` 是否生成正确 base 的 `site/dist`。
3. tgz/scp 与远端 release 创建是否成功。
4. `readlink -f /opt/tech-persistence/current` 是否指向本次 release。
5. remote loopback 是否带正确 Host 并返回 200。
6. public HTTPS 是否在公网返回 200。

前四层成功但公网验证失败，不能报告为“部署成功”；脚本会尝试自动 rollback。

手工只读核验：

```powershell
ssh root@47.253.230.197 'readlink -f /opt/tech-persistence/current; find /opt/tech-persistence/releases -mindepth 1 -maxdepth 1 -type d -printf "%TY-%Tm-%Td %TH:%TM %p\n" | sort -r'
curl.exe -I https://songuu.top/tech-persistence/
```

## 7. Rollback

优先使用 `previous`：

```powershell
ssh root@47.253.230.197 'set -eu; R=/opt/tech-persistence; T=$(readlink -f "$R/previous"); test -d "$T"; ln -s "$T" "$R/.current-rollback"; mv -Tf "$R/.current-rollback" "$R/current"; readlink -f "$R/current"'
```

也可以显式选择任一保留版本：

```powershell
ssh root@47.253.230.197 'set -eu; R=/opt/tech-persistence; T="$R/releases/<release-id>"; test -f "$T/index.html"; ln -s "$T" "$R/.current-rollback"; mv -Tf "$R/.current-rollback" "$R/current"; readlink -f "$R/current"'
```

回滚后必须重新执行 remote loopback 和 public HTTPS 验证。不要在确认回滚成功前删除故障 release，以便保留排错证据。

## 8. 更新同步策略

`site/build.js` 会通过 `collectProjectModel()` 直接读取仓库真实源文件并全量生成页面；`site/data/project-model.json` 只是可审阅快照，可用 `npm run site:data` 刷新，不是线上构建的第二事实源。不要手工维护能力数量、版本号或更新时间。后续项目架构更新时：

1. 在同一变更中更新真实源文件。
2. 运行 `npm run site:test`，让数据与路由合同先通过。
3. 运行 `npm run site:build` 全量生成静态站。
4. 使用本脚本生成新的不可变 release 并切换。

这种全量重建成本低、可追溯，且不会在旧 HTML 上做增量补丁；当源架构增加新分类或页面时，只需要演进生成器与合同测试。

## 9. songuu.top 根入口边界

`https://songuu.top/` 的源码所有者仍是 `agent-build/deploy/songuu-home/index.html`，生产文件是 `/opt/songuu-home/index.html`。它与本仓库站点是两个独立发布边界：

- 根入口只维护标题、描述和 `/tech-persistence/` 链接，不复制本仓库能力数据。
- 四入口布局与无 JavaScript 兜底由 `agent-build/deploy/songuu-home/index.test.mjs` 回归保护。
- 生产更新前先比较远端文件与 agent-build HEAD blob；一致时才备份并原子替换，避免覆盖线上漂移。

在 agent-build 仓库运行入口回归：

```powershell
node --test deploy/songuu-home/index.test.mjs
```

Tech Persistence 架构或能力数量更新只需重新构建并发布本仓库，不需要重复修改根入口；仅当入口 URL、名称或定位变化时才更新 gateway。
