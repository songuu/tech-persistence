---
description: "回顾所有技术沉淀：经验 + 本能 + 观察，支持搜索、统计、裁剪"
---

# /review-learnings — 全量知识回顾

回顾、搜索和管理所有层次的知识积累。

## 数据来源（按层次）

| 层次 | 位置 | 内容 |
|------|------|------|
| 核心知识 | `AGENTS.md` | 项目/个人核心信息 |
| 分类经验 | `.codex/rules/*.md` | 按领域分类的成熟经验 |
| 项目本能 | `~/.codex/homunculus/projects/{id}/instincts/` | 项目级学习的行为 |
| 全局本能 | `~/.codex/homunculus/instincts/personal/` | 跨项目通用行为 |
| 进化产物 | `~/.codex/homunculus/evolved/` | 聚类生成的 skill/command |
| 原始观察 | `~/.codex/homunculus/projects/{id}/observations.jsonl` | 未处理的原始数据 |
| 会话摘要 | `~/.codex/homunculus/projects/{id}/sessions/` | 历史会话总结 |

## 操作模式

**无参数 — 总览**：
```
📊 知识库统计 — 项目: {name}

经验层:
  AGENTS.md: N 行 | rules/: N 个文件, N 条经验

本能层:
  项目本能: N 个 (🔵N 🟢N 🟡N 🟠N 🔴N)
  全局本能: N 个
  导入本能: N 个

进化层:
  Skills: N | Commands: N | Agents: N

观察层:
  本月观察: N 条 | 会话摘要: N 份

最近更新: YYYY-MM-DD
```

**`search {keyword}` — 搜索**：
跨所有层次搜索匹配关键词的内容。

**`prune` — 裁剪**：
1. 检测重复（rules 和 instincts 之间）
2. 检测矛盾
3. 检测过时（涉及已废弃依赖）
4. 检测衰减本能（置信度 < 0.2）
5. 列出建议删除项，等待确认

**`export` — 导出**：
合并所有沉淀为一份结构化文档。

**`timeline` — 时间线**：
按时间倒序展示知识积累过程。

## 健康检查（每次自动执行）
- ⚠️ AGENTS.md > 200 行
- ⚠️ 单个 rules 文件 > 100 行
- ⚠️ 本能 > 50 个未聚类
- ⚠️ 观察日志 > 5MB 未归档
- ⚠️ 30+ 天未更新的 rules 文件
- ⚠️ 衰减本能 > 10 个未清理
