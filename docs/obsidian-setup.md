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
node scripts/init-obsidian-vault.js --codex
```

默认路径为 `~/.codex/homunculus`。

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
├── .obsidianignore          # 排除 .jsonl, archive/ 等
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

| Tag | 颜色 | 含义 |
|-----|------|------|
| `#instinct` | 紫色 | 本能节点 |
| `#session` | 绿色 | 会话摘要 |
| `#rule` | 橙色 | 规则文件 |
| `#solution` | 深绿 | 解决方案 |
| `#architecture` | 红色 | 架构决策 |
| `#sprint` | 青色 | Sprint 文档 |
| `#handoff` | 金色 | Sprint 交接点 |

## 验证安装

```
✅ Obsidian 打开 vault 无报错
✅ Dashboard.md 显示正常（如果安装了 Dataview 会显示表格）
✅ Graph View 显示颜色分组
✅ _templates/ 下有 4 个模板文件
✅ .obsidianignore 排除了 .jsonl 文件
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

`.obsidianignore` 会以合并模式更新，只补充缺失规则，不覆盖用户自定义内容。`Dashboard.md` 会备份旧版后重新生成。

## 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 脚本报 "安全限制" | vault 路径不在 home 目录下 | 使用 home 目录下的路径，或配置工具加 `--allow-outside-home` |
| Claude/Codex 没有写到同一个目录 | 共享配置未写入或环境变量覆盖 | 检查 `~/.tech-persistence/config.json` 和 `TECH_PERSISTENCE_HOME` |
| Obsidian 看不到 .jsonl 文件 | `.obsidianignore` 正常排除 | 这是预期行为 |
| Dashboard 表格显示代码块 | 未安装 Dataview 插件 | 安装 Dataview |
| Graph View 无颜色 | `.obsidian/graph.json` 未加载 | 关闭重新打开 vault |
| MCP Server 连接失败 | npx 未安装或路径错误 | 检查 Node.js 和 vault 路径 |
