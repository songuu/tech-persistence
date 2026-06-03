# Obsidian Vault 安装指南

> 将 tech-persistence 的知识产出接入 Obsidian，用图谱视图浏览本能、会话、解决方案之间的关联。

## 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 18 | 运行初始化脚本 |
| Obsidian | >= 1.4 | 桌面应用 |
| tech-persistence | 已安装 | Claude Code、Codex 或两者都可 |

## 三种知识库模式

| 模式 | 路径 | 适用场景 |
|------|------|----------|
| Claude 独立 | `~/.claude/homunculus` | 只使用 Claude Code |
| Codex 独立 | `~/.codex/homunculus` | 只使用 Codex |
| 共享推荐 | 自定义 Obsidian vault，例如 `~/Documents/TechPersistence` | 同时使用 Claude Code 和 Codex，需要知识持续同步 |

持续共享推荐使用第三种模式：把共享 homunculus 目录本身作为 Obsidian vault，再用 Obsidian Sync、iCloud、OneDrive、Dropbox 或 Syncthing 同步这个目录。`--import-claude` 只适合一次性迁移历史数据，不适合长期双向同步。

## 跨设备 / 跨终端同步

知识层是纯 markdown + frontmatter，天生适合跨设备同步，但有几条**不可违背**的铁律（违反会丢遥测数据或损坏 vault）：

### 铁律 1：一个 vault 只能有一个同步权威

绝不让同一 vault 被两套同步工具同时管理（如「共享 homunculus 目录已被 iCloud 同步」+ 再开 Obsidian Sync）。双权威是几乎所有 vault corruption / 重复 / 文件消失的共同根因。git / Obsidian Sync / 云盘 / Syncthing **三选一**。

### 铁律 2：排除运行态与 append-only 文件

`*.jsonl`（observations / memory-recall / recall-usage / skill-traces 等遥测）是**无锁追加**写入，文件级同步会把两设备的追加判为冲突并静默丢行；`.agent-runs/` 是运行态临时目录。两类都必须排除出同步。

`init-obsidian-vault.js` **已自动在 vault 生成同步工具原生的 ignore 文件**（单一事实源派生，幂等刷新，不覆盖用户自定义）：

| 文件 | 服务于 | 排除内容 |
|------|--------|----------|
| `.obsidianignore` | Obsidian 索引/视图 | `*.jsonl`、`.agent-runs/`、`archive/`、`node_modules/`、`*.bak.*`、`.git/` |
| `.gitignore` | git-based 同步（桌面推荐） | 上述 + `.obsidian/workspace.json`、`workspace-mobile.json`；**不含 `.git/`**（git 语义下无意义） |
| `.stignore` | Syncthing 同步 | 上述全部 + `.git/`（Syncthing 文件级同步 `.git/` 会损坏 refs） |

- **git / Syncthing 用户**：开箱即排除，无需手动配置。
- **Obsidian Sync / iCloud / Dropbox 用户**：这些工具**不读** vault 内的 ignore 文件，必须在各自 App 设置里手动排除同样的 `.agent-runs/`、`*.jsonl`、`archive/`、`*.bak.*`、`.obsidian/workspace*.json`（iCloud/Dropbox 另需排除 `.git/`）。
- 若必须跨设备聚合遥测：按设备分文件 `telemetry/<device-id>/*.jsonl` 再离线聚合，绝不双向同步同一文件。

### 铁律 3：portability 只在「克隆同一 git remote」时成立

Memory v5 用 git remote URL 的 hash 作项目身份 key，所以只有当多台设备**克隆的是同一 origin URL** 时，知识才落在同一项目目录、跨机器可见。无 remote 的本地仓库会退化为 git-root / cwd 路径 hash，换设备即漂移，不要依赖其跨设备 portability。

> ⚠️ Claude Code 自身的 auto-memory（`~/.claude/projects/<cwd-slug>/memory/`，存放手写的 `feedback_*` / `user_*`）用 **cwd 路径**作 key，跨设备 / Codex **不可见**，无法靠同步弥补。高价值的用户画像观察请沉到 v5 vault 的 `persona.md`。

### 各场景推荐

| 场景 | 推荐方案 | 理由 |
|------|----------|------|
| 单人多设备、桌面为主、知识只读 recall | **git-based 同步**（唯一权威）+ jsonl/`.agent-runs` gitignore | 几乎不触发并发写冲突，与现有 pre-commit/drift 工作流零摩擦、零成本，提交级可审计 |
| 多设备双写（多台都主动跑 sprint） | 仍 git 唯一权威：markdown 走 commit/merge（冲突显式暴露），jsonl 按设备分文件离线聚合，严禁叠云盘 | git 让 md 冲突可见、jsonl 可隔离；云盘会静默丢追加行 |
| 移动端查看（只读 / 随手记） | 官方 **Obsidian Sync** + Excluded folders 排除 `.agent-runs`/`*.jsonl`/`telemetry`/`workspace*.json`，或建只含 markdown 的裁剪子 vault | 移动端只有官方 Sync 一等支持且对 md 三方 merge；海量小 jsonl 会触发移动端重索引死循环 |
| 双运行时（Claude + Codex）+ 跨设备 | 先 `configure-shared-homunculus` 收敛 parity，再 git 同步该共享目录作唯一跨设备权威 | 共享目录解决「同机两运行时」，git 解决「跨设备」；两者正交，但同步权威仍须唯一 |

> 完整优缺点分析与代码依据见 `docs/solutions/2026-06-02-obsidian-cross-device.md`。

## 快速安装

### 推荐：Claude Code 与 Codex 共享同一个 Vault

Windows PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Obsidian -SharedHomunculus "C:\Users\you\Documents\TechPersistence"
powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -All -SharedHomunculus "C:\Users\you\Documents\TechPersistence"
```

macOS / Linux / Git Bash:
```bash
bash install.sh --obsidian --shared-homunculus ~/Documents/TechPersistence
bash install-codex.sh --all --shared-homunculus ~/Documents/TechPersistence
```

这会写入 `~/.tech-persistence/config.json`。之后 Claude Code 和 Codex 的 Hook 都会自动读取同一个 `homunculusHome`，无需在每次启动时设置环境变量。

### 只初始化 Claude 默认 Vault

```bash
bash install.sh --obsidian
```

```powershell
.\install.ps1 -Obsidian
```

默认路径为 `~/.claude/homunculus`。

### 只初始化 Codex 默认 Vault

```bash
bash install-codex.sh --obsidian
```

```powershell
.\install-codex.ps1 -Obsidian
```

默认路径为 `~/.codex/homunculus`。也可直接调用底层脚本：`node scripts/init-obsidian-vault.js --codex`。

### 临时覆盖路径

如果不想写全局共享配置，可以只在当前 shell 临时覆盖：

```powershell
$env:TECH_PERSISTENCE_HOME="C:\Users\you\Documents\TechPersistence"
node scripts\init-obsidian-vault.js
```

```bash
export TECH_PERSISTENCE_HOME=~/Documents/TechPersistence
node scripts/init-obsidian-vault.js
```

## Vault 内容

脚本会生成：

```
<homunculus-vault>/
├── .obsidian/               # Obsidian 配置（app.json, graph.json 等）
├── .obsidianignore          # Obsidian 视图排除（.jsonl, archive/ 等）
├── .gitignore               # git-based 跨设备同步排除（自动生成）
├── .stignore                # Syncthing 跨设备同步排除（自动生成）
├── _templates/              # Obsidian 模板
│   ├── instinct.md
│   ├── session-summary.md
│   ├── solution.md
│   └── handoff.md
├── _inbox/                  # 新笔记默认位置
├── _mcp-config-snippet.json # MCP Server 配置片段
├── Dashboard.md             # 知识仪表板入口
├── instincts/
├── evolved/
└── projects/
```

## 用 Obsidian 打开 Vault

1. 启动 Obsidian
2. 点击 **打开文件夹作为仓库**
3. 选择你的 `<homunculus-vault>` 目录
4. Obsidian 会自动加载 `.obsidian/` 配置

## 配置 MCP Server（可选）

将 `_mcp-config-snippet.json` 的内容合并到 Claude Code 或 Codex 的 MCP 配置：

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@bitbonsai/mcpvault@latest", "/path/to/homunculus-vault"]
    }
  }
}
```

配置后 agent 可以直接通过 MCP 协议读写 Vault。MCP 只是高级增强，不影响 Hook 自动写入知识文件。

## 推荐 Obsidian 插件

| 插件 | 用途 | 必要性 |
|------|------|--------|
| **Dataview** | Dashboard 中的动态表格（高置信本能列表、近期会话） | 强烈推荐 |
| **Templater** | 使用 `_templates/` 中的模板创建新笔记 | 推荐 |
| **Graph Analysis** | 增强图谱分析（聚类、中心度） | 可选 |
| **Tag Wrangler** | 批量管理 tags | 可选 |

## Graph View 配色方案

配色仅覆盖真正写入 vault 的 6 类产出（与 Dashboard dataview、README 接入表三方一致）：

| Tag | 颜色 | 含义 |
|-----|------|------|
| `#instinct` | 紫色 | 本能节点 |
| `#memory` | 蓝色 | Memory v5 主题记忆 |
| `#session` | 绿色 | 会话摘要 |
| `#solution` | 深绿 | 解决方案 |
| `#sprint` | 青色 | Sprint 文档 |
| `#handoff` | 金色 | Sprint 交接点 |

> 规则（`.claude/rules/`）与架构决策 ADR 是 repo 注入层，文件不在 vault，不配色（早期版本曾配 `#rule` 橙 / `#architecture` 红，因永不命中已于 2026-06-01 移除）。

## 验证安装

```
✅ Obsidian 打开 vault 无报错
✅ Dashboard.md 显示正常（如果安装了 Dataview 会显示表格）
✅ Graph View 显示颜色分组
✅ _templates/ 下有 4 个模板文件
✅ .obsidianignore 排除了 .jsonl 文件
✅ .gitignore / .stignore 已生成（跨设备同步开箱排除危险文件）
✅ 共享模式下 ~/.tech-persistence/config.json 指向同一个 homunculusHome
```

## 重新初始化

如需重新生成配置（不会覆盖已有 `.obsidian/`）：

```bash
node scripts/init-obsidian-vault.js --shared
node scripts/init-obsidian-vault.js --claude
node scripts/init-obsidian-vault.js --codex
node scripts/init-obsidian-vault.js --vault-path ~/Documents/TechPersistence
```

`.obsidianignore` / `.gitignore` / `.stignore` 都以合并模式更新，只补充缺失规则，不覆盖用户自定义内容。`Dashboard.md` 会备份旧版后重新生成。

## 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 脚本报 "安全限制" | vault 路径不在 home 目录下 | 使用 home 目录下的路径，或配置工具加 `--allow-outside-home` |
| Claude/Codex 没有写到同一个目录 | 共享配置未写入或环境变量覆盖 | 检查 `~/.tech-persistence/config.json` 和 `TECH_PERSISTENCE_HOME` |
| Obsidian 看不到 .jsonl 文件 | `.obsidianignore` 正常排除 | 这是预期行为 |
| Dashboard 表格显示代码块 | 未安装 Dataview 插件 | 安装 Dataview |
| Graph View 无颜色 | `.obsidian/graph.json` 未加载 | 关闭重新打开 vault |
| MCP Server 连接失败 | npx 未安装或路径错误 | 检查 Node.js 和 vault 路径 |
