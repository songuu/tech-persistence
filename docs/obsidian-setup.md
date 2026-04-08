# Obsidian Vault 安装指南

> 将 tech-persistence 的知识产出接入 Obsidian，用图谱视图浏览本能、会话、解决方案之间的关联。

## 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 18 | 运行初始化脚本 |
| Obsidian | >= 1.4 | 桌面应用 |
| tech-persistence v2 | 已安装 | `~/.claude/homunculus/` 目录已存在 |

## 快速安装（3 步）

### 第 1 步：初始化 Vault

```bash
# macOS / Linux / Git Bash (Windows)
bash install.sh --obsidian

# Windows PowerShell
.\install.ps1 -Obsidian
```

默认 vault 路径为 `~/.claude/homunculus/`。如需自定义：

```bash
bash install.sh --obsidian /path/to/your/vault

# PowerShell
.\install.ps1 -Obsidian -VaultPath "C:\Users\you\Documents\MyVault"
```

> **安全限制**：vault 路径必须在用户 home 目录下。

脚本会生成：

```
~/.claude/homunculus/
├── .obsidian/              # Obsidian 配置（app.json, graph.json 等）
├── .obsidianignore         # 排除 .jsonl, archive/ 等
├── _templates/             # 3 个 Obsidian 模板
│   ├── instinct.md
│   ├── session-summary.md
│   └── solution.md
├── _inbox/                 # 新笔记默认位置
├── _mcp-config-snippet.json # MCP Server 配置片段
└── Dashboard.md            # 知识仪表板入口
```

### 第 2 步：用 Obsidian 打开 Vault

1. 启动 Obsidian
2. 点击 **打开文件夹作为仓库**
3. 选择 `~/.claude/homunculus/`
4. Obsidian 会自动加载 `.obsidian/` 配置

### 第 3 步：配置 MCP Server（可选）

将 `_mcp-config-snippet.json` 的内容合并到 Claude Code 配置：

```json
// 添加到 ~/.claude/settings.json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@bitbonsai/mcpvault@latest", "/path/to/.claude/homunculus"]
    }
  }
}
```

配置后 Claude Code 可以直接通过 MCP 协议读写 Vault。

---

## 推荐 Obsidian 插件

| 插件 | 用途 | 必要性 |
|------|------|--------|
| **Dataview** | Dashboard 中的动态表格（高置信本能列表、近期会话） | 强烈推荐 |
| **Templater** | 使用 `_templates/` 中的模板创建新笔记 | 推荐 |
| **Graph Analysis** | 增强图谱分析（聚类、中心度） | 可选 |
| **Tag Wrangler** | 批量管理 tags | 可选 |

### Dataview 安装

1. 设置 → 第三方插件 → 关闭安全模式
2. 浏览 → 搜索 "Dataview" → 安装 → 启用
3. Dashboard.md 中的 dataview 代码块会自动生效

---

## Graph View 配色方案

初始化脚本已预配置颜色分组：

| Tag | 颜色 | 含义 |
|-----|------|------|
| `#instinct` | 紫色 | 本能节点 |
| `#session` | 绿色 | 会话摘要 |
| `#rule` | 橙色 | 规则文件 |
| `#solution` | 深绿 | 解决方案 |
| `#architecture` | 红色 | 架构决策 |

在 Graph View 中可以清晰看到不同类型知识节点的分布和关联。

---

## 验证安装

安装后检查以下内容：

```
✅ Obsidian 打开 vault 无报错
✅ Dashboard.md 显示正常（如果安装了 Dataview 会显示表格）
✅ Graph View 显示颜色分组
✅ _templates/ 下有 3 个模板文件
✅ .obsidianignore 排除了 .jsonl 文件
```

如果已有本能文件，它们会立即出现在 Graph View 中（`#instinct` 紫色节点）。

---

## 重新初始化

如需重新生成配置（不会覆盖已有 `.obsidian/` 和 `Dashboard.md`）：

```bash
node scripts/init-obsidian-vault.js --vault-path ~/.claude/homunculus
```

`.obsidianignore` 会以合并模式更新（只补充缺失规则，不覆盖用户自定义内容）。

---

## 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 脚本报 "安全限制" | vault 路径不在 home 目录下 | 使用 home 目录下的路径 |
| Obsidian 看不到 .jsonl 文件 | `.obsidianignore` 正常排除 | 这是预期行为 |
| Dashboard 表格显示代码块 | 未安装 Dataview 插件 | 安装 Dataview |
| Graph View 无颜色 | `.obsidian/graph.json` 未加载 | 关闭重新打开 vault |
| MCP Server 连接失败 | npx 未安装或路径错误 | 检查 Node.js 和 vault 路径 |
