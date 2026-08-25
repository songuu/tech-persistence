---
name: project-standards
description: "初始化、读取或审计项目级 rules、skills、commands 时，依据 project-standards manifest 渐进路由架构规范并核验双运行时投影。"
---

# 项目规范路由

本 Skill 只负责读取 manifest、按任务路由规则和执行只读审计流程。具体架构约束以 manifest 列出的 rule
资产为准，不在这里复制规则正文。

## 受控初始化或更新

仅当用户明确要求初始化、更新或修复项目规范，并且可定位 Tech Persistence 权威源码中的
`scripts/project-standards.js` 时执行；否则停止并报告安装器不可用，不手工拼装任一 runtime 规范目录。

1. 只读检测：`node scripts/project-standards.js --project-root <target> --detect-only --json`。
2. 令 `<selection>` 初始为 `auto`，预览双端资产：
   `node scripts/project-standards.js --project-root <target> --dry-run --runtime both --profiles <selection> --json`。
3. 向用户报告 profiles、evidence、既有 manifest 与潜在冲突。若用户明确选择 profiles，将 `<selection>`
   替换为同一逗号分隔值，并用该值重新执行 dry-run；不要在预览与安装之间切回 `auto`。
   已有 manifest 为 `mode: explicit` 时，`auto` 会保留该选择；只有用户明确要求恢复自动检测，才追加
   `--refresh-auto` 重新预览并安装。
4. 执行受管投影：
   `node scripts/project-standards.js --project-root <target> --runtime both --profiles <selection>`；install exit 2
   表示冲突已保留，立即停止，不能宣称完成。
5. 使用相同 `<selection>` 独立复核：
   `node scripts/project-standards.js --project-root <target> --check --runtime both --profiles <selection>`；check
   exit 1 表示校验失败。

初始化只授权该 resolver 管理 catalog 声明的资产与根受管块，不授权修改业务源码、本机设置或外部状态。

## Manifest 入口

1. 从项目根读取 `.claude/project-standards.json`。
2. 校验 `schemaVersion`、`owner`、`runtime`、`mode`、`profiles`、`scopes`、`evidence`、`assets`、
   `conflicts`、`attributes` 和 `entrypoint`；不支持的 schema 或非空 conflicts 必须显式报告。
3. `assets` 中每项应有 `kind`、`profile`、`source`、`path`、`sha256`。只信 manifest 内声明且 hash
   可核验的普通文件。

## 渐进读取

1. 总是先读 `base` 的 rule；随后只读与当前任务直接相关、且出现在 `profiles` 中的 profile rule。
2. 修改 UI、服务端、数据、基础设施、库或 Agent 边界时，分别加载对应 profile；跨层变更再加载
   `fullstack`，跨包变更再加载 `monorepo`。
3. `unknown` 存在时先按其 discovery-first 流程收集证据，不猜测框架，不预加载所有规则。
4. 只为当前文件和决策读取必要资产；需要理解细节时再沿 `assets[].source/path` 读取，不扫描所有规则。
5. conflicts 中的资产视为不可信投影：保留用户文件，停止依赖该规则并报告冲突。

## 审计流程

- 需要完整审计时读取并执行项目级 `project-audit` 流程：核对 profile 证据、普通文件、SHA-256、entrypoint
  和双运行时 parity。若当前 runtime 不注册项目命令，将该文件作为只读兼容入口执行，不声称 slash command 可用。
- 审计只输出 PASS、FAIL、UNVERIFIED、证据与建议动作；不修改、不重装、不删除，也不接受“内容看起来一致”
  代替 hash 证据。
- 当前 runtime 与 sibling runtime 同时存在时，比较 profile 与逻辑资产集合，并分别验证各自字节 hash；
  运行时文本替换导致的 hash 差异不能直接判为漂移。

## Guardrails

- canonical source 只能通过受控安装流程投影到各 runtime；不要手改受管资产来消除 parity 差异。
- canonical 删除/重命名资产前先登记 hash-bound `retiredAssets`；入口或 LF block 升级前先登记旧
  `legacyMarkerHashes`，不能移除旧 identity 后再猜测所有权。
- 不创建或接受 symlink、空 Skill、`.env*`、凭据/私钥、`settings.local.*`、lock、VCS 元数据、依赖目录、
  缓存、session、PID 或其他本机/运行态资产作为项目规范。
- 缺 manifest、证据不足、hash 不匹配或路径越界时停止并报告；本 Skill 不直接修复。
