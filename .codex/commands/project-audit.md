---
description: "只读审计项目规范 manifest、架构证据、受管文件、SHA-256 与双运行时 parity"
---

# project-audit — 项目规范审计

审计当前项目的规范投影，只报告证据和差异，不直接修复。

## Guardrails

- 全程只读：不安装、覆盖、删除、移动、格式化或更新 manifest 与受管资产。
- 不跟随 symlink，不读取项目根外路径，不把目录、空文件或运行态资产当作有效规范。
- 不创建或认可 `.env*`、凭据/私钥、`settings.local.*`、lock、VCS 元数据、依赖目录、缓存、session、PID、
  备份或临时文件为规范资产。
- PASS 必须有 manifest 字段、文件属性、hash 或仓库证据；无法核验标 `UNVERIFIED`，不能推断为通过。

## Steps

1. 定位项目根，读取 `.codex/project-standards.json`；确认 JSON 可解析、schema 受支持，`owner`、`runtime`、
   `mode`、`profiles`、`scopes`、`evidence`、`assets`、`conflicts`、`attributes`、`entrypoint` 类型正确。
2. 核对 profile：必须包含 `base`；每个具体 profile 都应有仓库源码、依赖、入口或配置证据。不要把
   任一代理规范目录或其根入口文档当作架构证据；显式选择也要标明来源。
3. 核对每项 asset 均含 `kind/profile/source/path/sha256`；架构 profile 必须已启用，`shared` 只允许来自
   catalog 的共享 commands/skills，或由 hash-bound `retiredAssets` tombstone 证明且正等待退休的旧资产。
   source 属于 active/tombstone canonical 集合，path 留在对应 runtime 根内，目标是非空普通文件且不是 symlink。
4. 对目标文件按原始字节计算 SHA-256，与 `assets[].sha256` 比较；缺失、算法不明或不匹配均为 FAIL。
5. 核对 `attributes` 指向项目根 `.gitattributes` 的 LF 受管块完整、唯一且位于文件末尾；再核对 `entrypoint`
   指向的 `AGENTS.md` 受管块完整、唯一且引用当前 manifest。`conflicts` 非空时逐项报告，不覆盖冲突文件。
6. 若 sibling runtime 的 `.claude/project-standards.json` 存在，使用 `CLAUDE.md`
   重复步骤 1–5，并比较两端 `schemaVersion`、owner、
   mode、profiles 与逻辑资产集合 `kind/profile/source/path`。两端 hash 分别校验；只允许安装器定义的确定性
   runtime 文本替换差异。
7. 检查受管集合没有 symlink、空 Skill、`.env*`、凭据/私钥、`settings.local.*`、lock、VCS 元数据、
   依赖目录、缓存、session、PID 或未声明资产；输出汇总表：
   `check | status | evidence | action`，末尾列出实际读取范围和未验证项。

## 停止条件

- manifest 缺失、无法解析、schema 不受支持，或路径逃逸项目/runtime 根：立即停止后续文件读取并 FAIL。
- 发现 symlink、hash 不匹配、伪造/循环架构证据、非空 conflicts 或 entrypoint 受管块异常：停止给出 PASS，
  保留现场并报告精确路径与证据。
- 双运行时 profile/逻辑资产集合不一致或差异无法由确定性投影解释：标记 parity FAIL，建议运行受控安装/验证
  流程；本命令不得自行执行修复。
