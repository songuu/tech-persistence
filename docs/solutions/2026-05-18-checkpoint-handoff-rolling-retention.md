---
title: "Checkpoint Handoff 文件治理：ephemeral artifact 三件套"
date: 2026-05-18
tags: [solution, checkpoint, handoff, docs-hygiene, three-piece-set]
related_instincts: [ephemeral-artifact-three-piece-set, reuse-existing-infra-before-building-new]
aliases: ["handoff-rolling-retention", "三件套模式", "ephemeral artifact 治理"]
---

# Checkpoint Handoff 文件治理：ephemeral artifact 三件套

## Problem

`/checkpoint` 每次执行写 `docs/plans/{name}-handoff-{N}.md`，N 单调递增无上限。长 sprint（如 `2026-04-23-homunculus-sharing`）跑出 **123+ handoff 文件**，全部 commit 进 git 历史，污染 `docs/plans/` 顶层（与 sprint 主文档混在一起）。commit 11ddfae 一次性 `git rm` 清理 123 个文件，但**机制没改**——下次长 sprint 必复发。

## Root Cause

Handoff 是 **ephemeral context bridge**（仅供 `/compact` 后 resume 使用），但被当作 **durable artifact** 写入：
- 文件名递增累积，无滚动逻辑
- 写在与 sprint 主文档同一目录（`docs/plans/`）
- `.gitignore` 未覆盖 → 进 git 历史
- LLM 协议级清理不存在（早期设计未预期长 sprint）

设计漂移：[[ADR-013]] §B 说 "新 enforcement 必须枚举边界产物"——但 `/checkpoint` 早期没人想到边界产物是"100+ 个 handoff"。

## Solution

**ephemeral artifact 三件套**（与已验证的 `INSTALL_BAK_RETENTION` 模式同源，由 [[bash-pipefail-vs-ls-no-match]] 配套 sprint 验证过）：

### 1. 专用子目录

写到 `docs/plans/.handoff/`（前缀 `.` → Obsidian 多数 vault 默认隐藏）。`/checkpoint` 首次写入时 `mkdir -p` 创建。主目录只剩 sprint 主文档。

### 2. .gitignore 覆盖

```gitignore
docs/plans/.handoff/
```

ephemeral artifact 不进 git history。`/sprint resume` 读 mtime 排序 + 文件名 `-handoff-{N}` 模式即可定位最近 handoff。

### 3. 滚动保留（env 覆盖）

写新 handoff 后：
- list `docs/plans/.handoff/{name}-handoff-*.md`
- 按 mtime 倒序排序
- 删除超出保留数的最早项（默认 3，env `TECH_PERSISTENCE_CHECKPOINT_RETENTION` 覆盖）
- 完整 handoff 与 compact handoff 视为同一组（一对 `-N.md` + `-N-compact.md` 算 1 个）
- 删除前打印 `[checkpoint] retention: removed <name>-handoff-X.md` 便于审计

## Prevention

**通用规则**：任何"重复生成的 ephemeral 产物"必须套三件套。已识别符合此模式的产物：

| 产物 | 当前状态 | 三件套套用 |
|------|---------|-----------|
| `.handoff/*-handoff-*.md` | ✓ 本 sprint 落地 | ✓ |
| `*.bak.*`（install 备份） | ✓ 已部分实现（`INSTALL_BAK_RETENTION`） | 部分（无子目录，但有 gitignore + retention） |
| `.agent-runs/<runId>/` | ✓ 已 gitignore | gitignore + 子目录，无 retention（可能未来需要） |
| `~/.codex/homunculus/skill-signals/*.jsonl` | ❓ 待审查 | 待审查 |

设计 checklist（任何新增产物）：
1. 这是 ephemeral（重新生成无损）还是 durable（丢失=数据损失）？
2. 如果 ephemeral：是否单文件覆盖？如否，是否套三件套？
3. 是否进入 sprint/项目主目录？如是，是否单独子目录？
4. retention 默认值是否合理？env 覆盖是否文档化？

**反模式**：把 ephemeral artifact 当 durable 写入主目录 + 未 gitignore + 无 retention = 必然累积成噪声。本次教训：123 个文件 commit 进 git，git rm 但不改机制 = 必复发。

## Related

- [[ephemeral-artifact-three-piece-set]] — 三件套通用本能
- [[reuse-existing-infra-before-building-new]] — `INSTALL_BAK_RETENTION` 模式复用
- [[ADR-013]] §B — 新 enforcement 必须枚举边界产物（早期 `/checkpoint` 设计违反）
- [[bash-pipefail-vs-ls-no-match]] — INSTALL_BAK_RETENTION sprint 中发现的配套 gotcha
- `docs/plans/2026-05-18-checkpoint-handoff-cleanup.md` — 本 sprint 实施
- commit 11ddfae（2026-05-15）— 一次性清理 123 个历史 handoff 文件
- commit 7b484f8（2026-04-23）— 原 sprint `homunculus-sharing` 起源

## 后续 ADR-013 候选

若 N=3 复发 LLM 漏执行滚动保留（写入新 handoff 但未删旧），考虑下沉为 `scripts/checkpoint-rotate.js` + `/checkpoint` 调用，去除 LLM 协议依赖。当前 N=0 不足触发。
