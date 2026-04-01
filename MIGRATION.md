# 迁移指南

## 从 v1 迁移到 v2

如果你已经安装了 v1（上一轮创建的 tech-persistence），v2 完全向后兼容。

### 迁移步骤

```bash
# 1. 环境检查
node scripts/preflight.js

# 2. 安装 v2（会自动备份 v1 文件）
bash install.sh --all

# 3. 你的 v1 数据完全保留：
#    - CLAUDE.md 不会被覆盖
#    - .claude/rules/ 已有文件不会被覆盖
#    - v1 的 /learn 命令会被升级为 v2 版本（旧版自动备份为 .bak）
```

### v2 新增了什么

| 组件 | v1 | v2 |
|------|-----|-----|
| `scripts/observe.js` | 无 | 🆕 PreToolUse/PostToolUse 观察 |
| `scripts/evaluate-session.js` | 简单健康检查 | 🔄 完整模式检测 + 本能提取 |
| `scripts/inject-context.js` | 无 | 🆕 SessionStart 上下文注入 |
| `~/.claude/homunculus/` | 无 | 🆕 本能存储 + 项目隔离 |
| `/instinct-status` | 无 | 🆕 本能面板 |
| `/evolve` | 无 | 🆕 本能进化 |
| `/instinct-export` | 无 | 🆕 导出分享 |
| `/instinct-import` | 无 | 🆕 导入本能 |
| settings.json hooks | 1 (Stop) | 4 (SessionStart/Pre/Post/Stop) |

### 你的 v1 数据会怎样

- `CLAUDE.md` → 保留不动，v2 系统继续读取
- `.claude/rules/` → 保留不动，v2 系统继续读写
- `.claude/commands/learn.md` → 升级为 v2 版（旧版备份为 `.bak`）
- `.claude/commands/review-learnings.md` → 升级
- `.claude/commands/session-summary.md` → 升级
- `.claude/commands/retrospective.md` → 升级
- `.claude/commands/debug-journal.md` → 升级

---

## 从 ECC (Everything Claude Code) 迁移

本系统的自学习部分直接借鉴了 ECC 的 continuous-learning-v2，但做了简化和独立化。

### 共存方案（推荐）

两者可以共存，但需要避免 Hook 重复触发：

```bash
# 检查 ECC 是否安装了 Hook
cat ~/.claude/settings.json | grep -E "observe|continuous-learning"
```

**如果 ECC 的 continuous-learning Hook 已启用**：
- 方案 A：禁用 ECC 的观察 Hook，使用本系统的（本系统更轻量）
- 方案 B：只安装本系统的命令和规则，不安装 Hook（`bash install.sh --user` 后手动删除 hooks 相关脚本）

**如果 ECC 只安装了 skills/rules（没有 Hook）**：
- 直接安装本系统，完全兼容

### 完全替换方案

```bash
# 1. 备份 ECC 配置
cp -r ~/.claude/skills/continuous-learning ~/.claude/skills/continuous-learning.ecc-backup

# 2. 如果用了 ECC 插件，卸载
# 在 Claude Code 中: /plugin uninstall everything-claude-code

# 3. 安装本系统
bash install.sh --all
```

### 数据迁移

ECC 的 homunculus 目录结构与本系统兼容：
- `~/.claude/homunculus/instincts/personal/` → 直接复用
- `~/.claude/homunculus/observations.jsonl` → 本系统按项目分目录存储，旧文件可保留

---

## 从 Claude-Mem 迁移

Claude-Mem 和本系统功能互补，**推荐共存**。

### 共存方案（推荐）

- **Claude-Mem** 负责：细粒度工具观察、语义压缩、向量搜索、Web 可视化
- **本系统** 负责：本能提取、置信度评分、知识进化、结构化 rules 管理

两者的 Hook 不冲突：
- Claude-Mem 用 `PostToolUse` 发送到 Worker Service (HTTP)
- 本系统用 `PostToolUse` 追加到本地 JSONL

settings.json 中两者的 Hook 可以并列：
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/save-hook.js" },
          { "type": "command", "command": "node ~/.claude/skills/continuous-learning/hooks/observe.js post 2>/dev/null || true" }
        ]
      }
    ]
  }
}
```

### 完全替换方案

如果你觉得 Claude-Mem 太重（Worker Service、SQLite、ChromaDB），本系统是一个纯文件的轻量替代：

```bash
# 1. 停止 Claude-Mem Worker
npm run worker:stop

# 2. 卸载 Claude-Mem 插件
# 在 Claude Code 中: /plugin uninstall claude-mem

# 3. 安装本系统
bash install.sh --all

# Claude-Mem 的历史数据保留在 ~/.claude-mem/ 不受影响
```

---

## 从 Superpowers 迁移

Superpowers 和本系统**完全兼容，推荐共存**。

- **Superpowers** 负责：brainstorming、planning、TDD 工作流、code review
- **本系统** 负责：技术沉淀、经验积累、本能学习

两者在不同层面工作，不冲突。Superpowers 的 skills 通过插件系统加载，本系统通过 `.claude/` 目录加载。
