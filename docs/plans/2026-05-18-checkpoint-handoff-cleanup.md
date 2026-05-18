---
title: "Checkpoint Handoff 文件治理（移子目录 + gitignore + 滚动保留 3）"
type: sprint
status: reviewing
created: "2026-05-18"
updated: "2026-05-18"
tasks_total: 5
tasks_completed: 5
tags: [sprint, chore, checkpoint, handoff, docs-hygiene]
aliases: ["checkpoint-handoff-cleanup", "handoff 治理"]
---

# Checkpoint Handoff 文件治理

> **Status:** `planning`
> **Created:** 2026-05-18
> **Updated:** 2026-05-18

---

## 需求分析

### 要做
- `/checkpoint` 生成的 handoff 文件移到 `docs/plans/.handoff/` 子目录
- `.gitignore` 覆盖该目录，不再污染 git 历史
- 自动滚动保留最近 N 个（默认 3，可通过 env `TECH_PERSISTENCE_CHECKPOINT_RETENTION` 覆盖）
- 同步 `/sprint resume` 协议中关于 handoff 路径的说明
- 通过 propagate 脚本同步 4 副本

### 不做
- 不追溯已 commit 的历史 handoff（11ddfae 已一次性清理 123 个）
- 不改 sprint 主文档协议
- 不动 `2026-04-23-homunculus-sharing.md` 原 sprint 主文档
- 不实现"自动清理已废弃 sprint 的所有 handoff"功能（YAGNI）

### 成功标准
- [ ] 新 sprint 跑 100 次 checkpoint → `docs/plans/` 顶层不出现 handoff 文件
- [ ] `git status` 对 `docs/plans/.handoff/*.md` 显示忽略
- [ ] `/sprint resume` 仍能找到最近 handoff（路径变了文档已同步）
- [ ] 4 副本（plugin + codex × commands + skills）通过 propagate 同步且一致
- [ ] Obsidian 中 `.handoff/` 目录默认隐藏（仅外观验证，不阻塞）

### 风险和假设
- 假设当前无活跃 sprint 处于中间 checkpoint 状态（git status 已确认 clean ✓）
- 假设 `.gitignore` 当前 3 行无 handoff 规则（Read 已确认 ✓）
- 假设 propagate 脚本通用支持 checkpoint + sprint（Read `propagate-command-changes.js` 已确认 `propagateCommand(name)` 通用 ✓）
- 假设 `.codex/commands/checkpoint.md` 已存在（Read 已确认 ✓）
- 假设 sprint.md 中有 handoff 路径示例需同步（system reminder 多处引用 `*-handoff-N.md` ✓）

---

## 技术方案

### 方案概述

3 层组合（方案 E）：
1. **路径**：`docs/plans/{name}-handoff-{N}.md` → `docs/plans/.handoff/{name}-handoff-{N}.md`
2. **gitignore**：加 `docs/plans/.handoff/`
3. **滚动保留**：写 handoff 前列目录，超过 N 个删除最早（按 mtime 排）

### 契约接口

> 本 sprint 不变更 multi-runtime hook projection / spec-impl-review schema / propagate transform 函数 → 无契约改动。

`/checkpoint` 命令的"步骤 3"段落是 user-facing 协议（非 schema），改动通过文档同步即可。

### 任务拆解

> `[P]` = 可并行（不同文件 + L2 以下）

- [x] **Task 1**: 改 `user-level/commands/checkpoint.md` — 路径 `.handoff/` + 滚动保留 3 + 输出段更新 — 文件: `user-level/commands/checkpoint.md` — 风险: L2
- [x] **Task 2 [P]**: 改 `.gitignore` 加 `docs/plans/.handoff/` — 文件: `.gitignore` — 风险: L1
- [x] **Task 3 [P]**: 改 `user-level/commands/sprint.md` 中 handoff 路径示例 + resume 段说明 — 文件: `user-level/commands/sprint.md` — 风险: L1
- [x] **Task 4**: 跑 propagate-command-changes 同步 4 副本 × 2 命令 — 命令: `node scripts/propagate-command-changes.js checkpoint sprint` — 依赖 Task 1+3 — 风险: L1
- [x] **Task 5**: 验证 — gitignore 生效（造 dummy） + grep 无遗留旧路径 + propagate diff 看 codex regex 翻译正确 — 风险: L2

### 测试策略

- 单元: N/A（纯文档+配置）
- 集成: `git check-ignore docs/plans/.handoff/test.md` 应输出路径名（命中规则）；`grep -r "docs/plans/{name}-handoff" user-level/` 在 Task 1+3 后应只命中新路径
- 手动: 创建 `docs/plans/.handoff/dummy-handoff-1.md` → `git status` 不显示 → 删除

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 现有活跃 sprint 中途切换路径 → resume 找不到旧 handoff | 极低 | 中 | git status clean，无活跃 checkpoint；如未来发现历史 handoff 仍想 resume，手动 `mv` 即可 |
| `.handoff/` 在 Obsidian 中是否隐藏取决于用户 vault 设置 | 中 | 低 | 大多数 Obsidian 默认忽略 `.` 开头目录；用户可自定义 |
| 滚动删除误删用户想保留的 handoff | 低 | 低 | env `TECH_PERSISTENCE_CHECKPOINT_RETENTION` 可覆盖；删除前打印将删的文件 |
| 4 副本 propagate 出错 | 极低 | 低 | propagate 脚本已稳定服役多次 |
| Codex regex 把 `.handoff` 误转成 `.codex.handoff` 之类 | 低 | 中 | regex 是 `/\.claude\b/g` 词边界，不会匹配 `.handoff`；Task 5 加 grep 验证 |

### 涉及文件

源（手改）：
- `user-level/commands/checkpoint.md`
- `user-level/commands/sprint.md`
- `.gitignore`

派生（propagate 生成，git tracked）：
- `plugins/tech-persistence/commands/checkpoint.md`
- `plugins/tech-persistence/commands/sprint.md`
- `plugins/tech-persistence/skills/checkpoint/SKILL.md`（若存在）
- `plugins/tech-persistence/skills/sprint/SKILL.md`
- `.codex/commands/checkpoint.md`
- `.codex/commands/sprint.md`
- `.codex/skills/checkpoint/SKILL.md`（若存在）
- `.codex/skills/sprint/SKILL.md`

运行时产物（首次自动创建）：
- `docs/plans/.handoff/`（gitignored）

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-18 | T1 | checkpoint.md：执行步骤 3 路径改 `.handoff/`，新增步骤 5（滚动保留 N=3，env 覆盖），输出段加 "保留: N 个最近 handoff" 行，"不在 sprint 中时" 段加 `session-{时间戳}-handoff.md` 命名规则 + 滚动保留协议 |
| 2026-05-18 | T2 | `.gitignore` 加 `docs/plans/.handoff/` |
| 2026-05-18 | T3 | sprint.md 3 处改动：caveman handoff 路径示例（L84-86）、resume 示例（L192）、resume 协议加 "在 `docs/plans/.handoff/` 下查找" 首步（L201-205） |
| 2026-05-18 | T4 | propagate 同步 8 副本（plugin + codex × commands + skills），diff stat 各 25/14 一致 |
| 2026-05-18 | T5 | 验证 5 项全过：`git check-ignore` 命中 / source 0 残留 / codex regex 无误转 / codex+plugin 各 28 命中对称 |

---

## 审查结果

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| - | - | - | 无 | - |

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| - | - | - | 无 | - |

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| P2-1 | architecture | `user-level/commands/checkpoint.md:5` | 滚动保留是文字协议，依赖 LLM 执行；ADR-013 候选（若 N=3 漏执行升级为脚本） | backlog |
| P2-2 | docs | README.md / docs | `TECH_PERSISTENCE_CHECKPOINT_RETENTION` env 未在 README 说明 | backlog |
| P2-3 | UX | `user-level/commands/checkpoint.md` 输出段 | 首次用户可能困惑"git 看不见 .handoff/"；可在输出加 "(已 gitignore，本地保留)" 一行 | optional |

### 总评

🟢 健康。三层组合（子目录 + gitignore + 滚动保留）是已验证的 `INSTALL_BAK_RETENTION` 模式平移，无 P0/P1 阻塞。3 个 P2 全部记 backlog 不阻塞合并。

---

## 复利记录

### 提取的经验
### 创建/更新的本能
### 解决方案文档
