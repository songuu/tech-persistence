---
title: "Codex 与 Claude Code Homunculus 共享"
type: sprint
status: in-progress
created: "2026-04-23"
updated: "2026-04-23"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, architecture, obsidian, homunculus]
aliases: ["homunculus-sharing", "Codex Claude knowledge sync"]
---

# Codex 与 Claude Code Homunculus 共享

> **Status:** `in-progress`
> **Created:** 2026-04-23
> **Updated:** 2026-04-23

---

## 需求分析

### 要做
- 为 Codex 与 Claude Code 的知识系统定义统一共享策略，解决两边 homunculus 数据割裂的问题。
- 提供一个推荐的共享入口：同一个 Obsidian vault 作为知识可视化与同步载体。
- 在不破坏现有 `~/.claude/homunculus` 与 `~/.codex/homunculus` 独立运行能力的前提下，补齐可配置的共享路径模式。
- 让安装、文档、运行时路径解析和验证脚本都能清楚表达三种模式：独立、导入、共享。
- 给用户明确操作路径：什么时候使用一次性导入，什么时候使用 `TECH_PERSISTENCE_HOME`/共享 vault，什么时候用 Obsidian Sync/云盘同步。

### 不做
- 不默认把 Codex 强制写入 `~/.claude/homunculus`，避免破坏上一轮“Codex 独立运行时”的架构决策。
- 不实现复杂的双向文件合并算法或冲突解决器，本次优先采用单共享目录/Obsidian vault 规避冲突。
- 不绑定某个商业同步服务，Obsidian Sync、iCloud、OneDrive、Dropbox、Syncthing 等只作为文档化选项。
- 不引入数据库或守护进程，保持当前文件系统知识库模型。

### 成功标准
- [ ] 文档清楚说明 Codex/Claude Code 共享 homunculus 的推荐拓扑与取舍。
- [ ] Codex 与 Claude Code 都能通过同一个 `TECH_PERSISTENCE_HOME` 指向共享 vault。
- [ ] Obsidian 初始化文档支持 Claude、Codex、共享 vault 三类路径，不再只假设 `~/.claude/homunculus`。
- [ ] 安装/验证脚本能提示或校验共享模式的关键环境变量与目录结构。
- [ ] 现有一次性 `--import-claude` 路径仍然可用，且与共享模式的差异被讲清楚。

### 风险和假设
- 假设 Hook 与命令脚本都通过 `scripts/lib/runtime-paths.js` 或插件内等价逻辑解析 homunculus 路径；如果仍有硬编码 `~/.claude`，需要在计划阶段列入清理任务。
- 共享同一个目录可以最大化知识复用，但两个 agent 并发写入同一个 `.jsonl` 或 Markdown 文件时仍可能产生冲突；本次用追加写、文件命名唯一化、文档警示来降低风险。
- Obsidian 负责可视化和跨设备同步，不应成为 Hook 写入的运行时依赖；CLI 在没有 Obsidian 的机器上仍应可运行。
- Windows 用户的路径与环境变量配置需要单独给 PowerShell 示例。

---

## 技术方案

### 方案概述

采用“独立默认 + 显式共享”的架构：Claude Code 继续默认写 `~/.claude/homunculus`，Codex 继续默认写 `~/.codex/homunculus`；当用户要打通知识系统时，通过一个共享配置把两边的 `resolveBaseDir()` 指向同一个 homunculus 目录。推荐共享目录本身就是 Obsidian vault，例如 `~/Documents/Obsidian/TechPersistence`，再用 Obsidian Sync、iCloud、OneDrive、Dropbox 或 Syncthing 做跨设备同步。

共享路径优先级为：`TECH_PERSISTENCE_HOME` 环境变量 > `TECH_PERSISTENCE_CONFIG` 指向的配置文件 > 默认全局配置 `~/.tech-persistence/config.json` > 各运行时默认目录。这样不会破坏已有安装，但安装脚本可以写入共享配置，Hook 脚本和命令脚本不用分别硬编码 Claude/Codex 路径。一次性 `--import-claude` 保留为迁移工具，共享模式则作为持续同步方案。

### 任务拆解

- [x] **Task 1**: 扩展运行时路径解析，支持共享配置文件和 Claude/Codex 双默认兼容读取 — 文件: `scripts/lib/runtime-paths.js`, `plugins/tech-persistence/hooks/lib/runtime-paths.js`
- [x] **Task 2**: 新增共享 homunculus 配置工具，初始化目录结构、写入 `~/.tech-persistence/config.json`，并提供 dry-run — 文件: `scripts/configure-shared-homunculus.js`
- [x] **Task 3**: 打通安装入口，给 Claude/Codex 的 PowerShell 与 Bash 安装脚本加入共享路径参数，并复用配置工具 — 文件: `install.ps1`, `install.sh`, `install-codex.ps1`, `install-codex.sh`
- [x] **Task 4**: 更新 Obsidian 初始化与使用文档，讲清独立、导入、共享三种模式和推荐同步拓扑 — 文件: `scripts/init-obsidian-vault.js`, `docs/obsidian-setup.md`, `docs/obsidian-usage.md`, `README.md`, `plugins/tech-persistence/README.md`
- [x] **Task 5**: 补充预检/验证与架构记录，确保共享配置可被发现且 Codex 插件生成后不漂移 — 文件: `scripts/preflight.js`, `scripts/validate-codex-plugin.js`, `scripts/validate-codex-install.js`, `.codex/rules/architecture.md`, `docs/plans/2026-04-23-homunculus-sharing.md`

### 测试策略
- 单元/静态测试: 对新增 Node 脚本执行 `node --check`；用环境变量矩阵验证 `runtime-paths.js` 的路径优先级和 `~` 展开。
- 集成测试: 执行 `node plugins/tech-persistence/scripts/build-codex-plugin.js` 后运行 `node scripts/validate-codex-plugin.js`，确认插件内 hook runtime resolver 与源文件一致。
- 安装验证: 使用新增配置工具的 `--dry-run` 验证共享路径，不直接改用户真实 home；必要时只在 home 下临时测试目录初始化 Obsidian vault。
- 手动验证: 文档示例覆盖 Windows PowerShell、macOS/Linux Bash、Codex `$skill` 与 Claude `/command` 两套入口。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 两个 agent 并发写同一知识库造成冲突 | 中 | 中 | 优先追加写和唯一文件名；文档提示避免同一文件手工并发编辑；不做自动 merge |
| 共享配置误伤已有独立知识库 | 低 | 高 | 默认不启用共享；必须显式传入共享路径；保留 `TECH_PERSISTENCE_HOME` 最高优先级用于临时覆盖 |
| Claude 与 Codex 安装脚本行为不一致 | 中 | 中 | 两套 PowerShell/Bash 都调用同一个 Node 配置工具；验证脚本检查关键文件 |
| Obsidian 被误认为运行时依赖 | 低 | 中 | 文档明确 Obsidian 只是可视化/同步层；Hook 只依赖文件系统 |
| Codex 插件生成覆盖手改文件 | 中 | 中 | 源文件优先，修改源 `scripts/lib/runtime-paths.js` 后通过 build 生成插件副本 |

### 涉及文件
- `scripts/lib/runtime-paths.js`
- `plugins/tech-persistence/hooks/lib/runtime-paths.js`
- `scripts/configure-shared-homunculus.js`
- `scripts/init-obsidian-vault.js`
- `scripts/preflight.js`
- `scripts/validate-codex-plugin.js`
- `scripts/validate-codex-install.js`
- `install.ps1`
- `install.sh`
- `install-codex.ps1`
- `install-codex.sh`
- `docs/obsidian-setup.md`
- `docs/obsidian-usage.md`
- `README.md`
- `plugins/tech-persistence/README.md`
- `.codex/rules/architecture.md`
- `docs/plans/2026-04-23-homunculus-sharing.md`

### 置信度检查
- **置信度：高（约 85%）**。当前 Hook 已经集中走 `resolveBaseDir()`，所以共享模式主要是补配置层、安装入口和文档，而不是重写知识系统。
- **主要不确定点**：Codex 插件 hooks 是否支持持久注入环境变量。计划用全局配置文件规避这个不确定性，只把 `TECH_PERSISTENCE_HOME` 保留为临时覆盖入口。

---

## 实现进度

<!-- /work 阶段更新。每完成一个 Task 勾选上方任务拆解中的 checkbox，并在此追加变更日志。 -->

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-04-23 | Task 1 | `runtime-paths.js` 支持 `TECH_PERSISTENCE_HOME`、`TECH_PERSISTENCE_CONFIG`、`~/.tech-persistence/config.json`，并把 Claude/Codex 默认目录都纳入兼容读取。 |
| 2026-04-23 | Task 2 | 新增 `scripts/configure-shared-homunculus.js`，支持 `--path`、`--dry-run`、`--force`、`--allow-outside-home`，可初始化共享 homunculus 目录结构并写入全局配置。 |
| 2026-04-23 | Task 3 | `install.ps1`、`install.sh`、`install-codex.ps1`、`install-codex.sh` 新增共享 homunculus 参数，统一调用配置工具；`install.sh` 规范为 LF 行尾以保证 Bash 可运行。 |
| 2026-04-23 | Task 4 | Obsidian 初始化脚本支持 `--claude`、`--codex`、`--shared` 和共享配置默认路径；README 与 Obsidian 文档补充独立、导入、共享三种模式。 |
| 2026-04-23 | Task 5 | 预检和验证脚本加入共享配置检查；Codex 插件构建会带上共享配置工具；新增 ADR-001 记录双运行时共享架构决策。 |

### 测试记录
- L2 标准：`node --check` 覆盖 `runtime-paths.js`、`configure-shared-homunculus.js`、`init-obsidian-vault.js`、`preflight.js`、`validate-codex-plugin.js`、`validate-codex-install.js`。
- L2 标准：`bash -n install.sh`、`bash -n install-codex.sh` 通过。
- L2 标准：PowerShell `scriptblock` 解析 `install.ps1`、`install-codex.ps1` 通过。
- L2 标准：`node plugins/tech-persistence/scripts/build-codex-plugin.js` 通过。
- L2 标准：`node scripts/validate-codex-plugin.js` 通过。
- L2 标准：`node scripts/configure-shared-homunculus.js --path "$HOME\TechPersistenceDryRun" --dry-run --force` 通过，未写入真实数据。
- L2 标准：`TECH_PERSISTENCE_HOME` 优先级与 `~` 展开验证通过。
- L2 标准：`node scripts/preflight.js` 与 `node scripts/preflight.js --codex` 通过，存在环境相关 warning 但无阻断。
- L2 标准：`node scripts/validate-codex-install.js` 通过。
- L2 标准：`git diff --check` 通过；仅有 Git 行尾转换提示。

---

## 审查结果

<!-- /review 阶段填写 -->

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### 总评

---

## 复利记录

<!-- /compound 阶段填写 -->

### 提取的经验
- ...

### 创建/更新的本能
- ...

### 解决方案文档
- ...
