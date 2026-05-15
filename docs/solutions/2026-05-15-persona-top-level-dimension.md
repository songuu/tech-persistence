---
title: "Memory v5 Persona 顶层独立维度实施 + 发现 TP 双 memory 系统盲点"
date: 2026-05-15
tags: [solution, memory-v5, persona, architecture, debugging]
related_instincts: [reuse-existing-infra-before-building-new, documented-claim-vs-code-reality-drift]
aliases: ["persona-top-level", "memory-v5-persona", "tp-dual-memory-discovery"]
sources:
  - docs/plans/2026-05-15-tencentdb-agent-memory-analysis.md
related:
  - "[[ADR-008]]"
  - "[[ADR-011]]"
  - "[[ADR-012]]"
---

# Memory v5 Persona 顶层独立维度实施

## Problem

TDAI sibling eval（[[2026-05-15-tencentdb-agent-memory-analysis]]）§4 借鉴点 1 提议在 TP 加 persona.md 单文件聚合用户画像，避免散落在多个 `feedback_*`/`user_*` 中靠模型每次现场聚合。用户在评估完成后改主意"直接按计划实现"，跳过原推荐的 1-2 周观察期。

实施中发现一个**未被任何文档明示的架构事实**：TP 同时跑两套 memory 系统，路径完全不同，写入侧 vs 读取侧默认分离。

## Root Cause

### 实施层面

§4 spec 写「`memory/` 下加 persona.md」+「`scripts/inject-context.js` 注入预算单独留 ~500 字节」。**"memory/" 是哪个 memory dir 没明示**。第一直觉写到 `C:\Users\songyu\.claude\projects\C--project-my-tech-persistence\memory\`（CLAUDE.md "auto memory" 段所指的 Claude Code 系统目录，所有现有 `feedback_*`/`user_*` 都在这），跑 inject-context.js dogfood 发现 Persona 段缺失。

调试发现 `inject-context.js` 实际读 `compatReadDirs.map(d => path.join(d, 'projects', project.id, 'memory'))`，其中 `compatReadDirs = ['~/.claude/homunculus', '~/.codex/homunculus']`，`project.id` 是 git remote 的 12 字符 hash（如 `8331ab9c2853`）—— 完全独立的另一条路径。

### 架构层面

TP 同时有 **两套** memory 系统并存：

| 系统 | 写入路径 | 注入机制 | 路径键 | 读取方 |
|------|---------|---------|--------|--------|
| **Claude Code auto memory** | `~/.claude/projects/C--<cwdpath>/memory/` | Claude Code core SessionStart（系统级，非 hook） | cwd 路径 escape | Claude Code only |
| **Tech-persistence v5 memory** | `~/.claude/homunculus/projects/<gitRemoteHash>/memory/` + `~/.codex/homunculus/...` | `inject-context.js` SessionStart hook（项目级） | git remote URL hash | Claude Code + Codex（[[ADR-008]] compat dirs）|

两者路径键、注入机制、扫描范围**完全不重叠**。用户的 `feedback_*`/`user_*` 历史一直写在 auto-memory dir（因为 CLAUDE.md "auto memory" 段教如此操作），但 tech-persistence 的 `inject-context.js` 从未读过那个目录。

**这意味着**：迄今所有 `feedback_*`/`user_*` 在 Codex 端**完全不可见**（Codex 无 Claude Code core 的 auto-memory 注入机制，只能通过 v5 dir）。这违反 [[ADR-011]] 4 不可妥协原则之 multi-runtime parity，但此前无人发现。

## Solution

### 实施清单

1. **持久化**：`~/.claude/homunculus/projects/8331ab9c2853/memory/persona.md` 创建，5 固定字段：
   - Role / Preferences / Non-negotiables / Communication style / Known context
   - Body 实际 ~875 chars

2. **注入逻辑**：`scripts/inject-context.js` 加 `loadPersonaBody(memoryDirs)` first-hit 函数 + section 0c（位于 Memory v5 index 之前，900 chars 预算）。源 + Codex plugin 副本经 `build-codex-plugin.js` 同步。

3. **位置决策**：persona.md **只写入 v5 dir**，不写 auto-memory dir。原因：
   - 双运行时 parity（Codex 不读 auto-memory dir）
   - 避免 Claude Code core 与 tech-persistence hook 双重注入

4. **不实施**：§4 提到的"symlink 到 global `~/.claude/persona.md`"。YAGNI，留待跨项目使用场景出现。

### Dogfood 验证

```bash
node scripts/inject-context.js | jq -r '.hookSpecificOutput.additionalContext' | grep -A 30 'Persona'
# → Persona block 881 chars，5 字段全在，末尾完整不截断
node scripts/pre-commit-check.js
# → exit 0，plugin 副本 sha256 一致
```

### 预算调校

§4 spec 写"~500 字节"，但 5 字段中文 persona 实际 ~875 chars（含 wikilinks）。逐步调：500（截断 communication style）→ 700（截断 known context 末尾 wikilink）→ 900（完整无截断）。

**规则**：spec 中的字节预算 hint 与实际内容尺寸校准前先量化（写完文件 → `wc -c` → 加 10% margin）。不要凭 spec 暗示的数字直接拍板。

## Prevention

### P1 — `inject-context.js` 增强（建议未实施）

考虑让 `inject-context.js` 也合并读取 `~/.claude/projects/C--<cwdpath>/memory/` 内容，让 Codex 也能看到用户在 auto-memory dir 的历史 `feedback_*`/`user_*`。但这会重复 Claude Code core 的注入逻辑（双重注入），且需要解决 cwd 路径 escape 算法兼容性。决定**暂不实施**，等真正出现 "Codex 端找不到用户偏好" 的具体痛点再做。

### P2 — 项目文档明示双 memory 系统

`.claude/rules/architecture.md` 加 ADR-015 显式记录双 memory 系统设计。今后涉及"memory/" 的设计文档**必须**指明是 `auto-memory` 还是 `v5`，否则歧义。

### P3 — `/compound` 双写约定（待考虑）

`/compound` 现在写 `feedback_*` / `user_*` 是否应该自动双写（v5 dir + auto-memory dir）？这需要 spec 决策，本次先记录为 backlog。

## Related

- [[ADR-008]] — Memory v5 启动注入必须合并兼容运行时索引（compatReadDirs 来源）
- [[ADR-011]] — 4 不可妥协原则（multi-runtime parity 是本次位置决策的核心依据）
- [[ADR-012]] — Plan 阶段必须勘察被改文件（本次未严格遵守 → 第一次写错位置）
- [[reuse-existing-infra-before-building-new]] — 复用 `compatReadDirs` + `detectProjectIdentity` + `parseFrontmatter`，零新基础设施
- [[documented-claim-vs-code-reality-drift]] — §4 spec "memory/" vs 实际 inject-context.js 读取路径
- [[2026-05-15-tencentdb-agent-memory-analysis]] — 本实施的源 sprint
