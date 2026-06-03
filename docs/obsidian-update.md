# Obsidian 配置增量更新

> 在已有的 Obsidian vault 中执行以下操作，添加新的 tag 颜色分组。

## 最简方式：重跑安装器（存在即刷新，推荐）

自 2026-06-01 起，**只要 homunculus dir 已是 vault（含 `.obsidian/`），重跑安装即自动刷新** graph.json colorGroups 与 Dashboard：

```bash
bash install.sh --user          # 或 install-codex.sh / -User
# 也可直接显式刷新：
node scripts/init-obsidian-vault.js --vault-path ~/.claude/homunculus
```

刷新是**外科式 + 幂等**：只替换系统管理的 colorGroups（随新增产出类型同步），保留你在图谱界面调的布局偏好（scale/forces 等）；无变化则不写、不产生 `.bak`。下面的手动编辑表仅作为「不重跑安装时」的参考。

## 需要更新的文件（手动 fallback）

### `.obsidian/graph.json`

在 `colorGroups` 数组中添加以下 2 个分组：

```json
{
  "query": "tag:#handoff",
  "color": { "a": 1, "rgb": 16761095 }
},
{
  "query": "tag:#sprint",
  "color": { "a": 1, "rgb": 2263842 }
}
```

完整的 colorGroups 应该是：

仅覆盖真正写入 vault 的 6 类产出（与 `scripts/init-obsidian-vault.js::generateGraphConfig` 一致）：

| Tag | 颜色 | RGB 值 | 含义 |
|-----|------|--------|------|
| `#instinct` | 紫色 | 5373645 | 本能节点 |
| `#memory` | 蓝色 | 3899638 | Memory v5 主题记忆 |
| `#session` | 绿色 | 2263842 | 会话摘要 |
| `#solution` | 深绿 | 65382 | 解决方案 |
| `#sprint` | 青色 | 29695 | Sprint 文档 |
| `#handoff` | 金色 | 16761095 | Sprint 交接点 |

> 规则 / 架构决策是 repo 注入层（`.claude/rules/`），文件不在 vault，不配色（早期 `#rule` 橙 / `#architecture` 红已于 2026-06-01 移除，因永不命中）。

### `_templates/handoff.md` (新建)

```markdown
---
type: sprint-handoff
sprint_doc: ""
checkpoint_number: 1
created: "<% tp.date.now("YYYY-MM-DDTHH:mm:ss") %>"
phase: "work"
tags: [handoff, sprint]
---

# Sprint Handoff #{{checkpoint_number}}

## Sprint 状态
- 文档: {{sprint_doc}}
- 当前阶段: {{phase}}
- Task 进度: /

## 已完成的 Task

## 未完成的 Task

## 关键决策

## 已修改的文件

## 当前测试状态

## 环境/阻塞

## 下一步

## Related
```

### `Dashboard.md` 追加

在 Dashboard 中添加一个新区域：

```markdown
## 活跃 Sprint

\```dataview
TABLE status, tasks_completed + "/" + tasks_total AS progress, updated
FROM #sprint
WHERE status != "completed"
SORT updated DESC
\```

## 最近的 Checkpoints

\```dataview
TABLE sprint_doc, phase, checkpoint_number
FROM #handoff
SORT created DESC
LIMIT 5
\```
```

### 同步排除文件追加（`.obsidianignore` / `.gitignore` / `.stignore`）

重跑安装会幂等刷新三个 ignore 文件（合并模式，只补缺失规则、不覆盖用户自定义）：`.obsidianignore`（Obsidian 视图）、`.gitignore`（git-based 跨设备同步）、`.stignore`（Syncthing）。三者由 `init-obsidian-vault.js` 的 `SYNC_EXCLUDES` 单一事实源派生。手动维护时参考：

```
# 已有的忽略规则保持不变，追加：
*.jsonl.bak
*.bak.*
```

> 跨设备同步排除的完整清单与原因见 `docs/obsidian-setup.md` 的「跨设备 / 跨终端同步」段。
