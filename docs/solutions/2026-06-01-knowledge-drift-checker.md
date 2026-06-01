---
title: "知识层 drift checker：enforcement 判定域由 dogfood FP 反推（40→0 FP）"
date: "2026-06-01"
tags: [solution, enforcement, self-evolution, drift, measure-before-enforce]
related:
  - "[[2026-06-01-secondary-defects-roadmap]]"
  - "[[2026-06-01-knowledge-drift-checker]]"
  - "[[ADR-023]]"
  - "[[ADR-013]]"
  - "[[ADR-012]]"
  - "[[documented-claim-vs-code-reality-drift]]"
---

# 知识层 drift checker（缺陷 E）

## 问题

`.claude/rules/*.md`、`docs/solutions/*.md`、ADR 是 append-only、零校验。"文档声称的代码位置 vs 代码现实漂移"是本仓库 #1 回归源（[[documented-claim-vs-code-reality-drift]]：ADR-016~019 全写错"copyHookLibs glob 自动复制"假设，[[ADR-020]] 才勘误）。本能层有 `decayInstincts` 衰减，成熟知识层却无任何校验回路。

缺陷 E（[[2026-06-01-secondary-defects-roadmap]] P1）要把它从 append-only 下沉为 pre-commit enforcement（[[ADR-013]] mechanism-over-discipline 延续）。

## 根因 / 洞察

初稿假设"校验文档里路径引用所指文件是否存在"。**[[ADR-013]] §B dogfood 探针在 plan 阶段推翻 naive 方案**：扫现有 42 个 rules/solutions/ADR，naive「带目录路径存在性」would-block **40/42**。三类合法引用被误判：

1. **正则截断**：`js` 在 `json` 前匹配，`settings.json`→`settings.js`（alternation 顺序 bug）
2. **假设/未来文件**：`scripts/sprint-goal.js`（[[ADR-021]] deferred）、`scripts/agent-orchestrator/providers/claude.js`（"如果有人加"假设例）
3. **运行时路径**：`.claude/persona.md`、`.claude/settings.json`（安装位置，repo 内在 `user-level/`）

核心洞察：**文档里的路径引用天然有大量非 repo-source 的合法形态，"存在性"对它们不是确定性可判信号**。

## 解决方案

**判定域由 dogfood FP 反推**——收窄到确定性可判子集，重 dogfood 验证 0 FP：

| 引用形态 | 判定 | 命中 |
|---------|------|------|
| 带行号(`:NN`) + 源码前缀(scripts/docs/plugins/user-level) + 文件不存在 | **block** (exit 1) | 作者对 repo 现状的确定性断言 |
| 带行号 + 裸文件名，glob basename 0 匹配 | **warn**（不阻塞，exit 0） | ≥1 匹配=ok，不要求唯一（pipeline.js 有 plugin 副本） |
| 行号**值** | 不校验 | 必随编辑漂移 |
| `...` 简写 / `*` / 运行时前缀 / **无行号路径** | skip | 确定性不可判，宁可 FN 不可 FP |
| inline-code 符号 | deferred | grep FP 高（匹配注释/通用词） |

探针 v2 验证：收窄后现有 42 文件 **block = 0**，**无需 grandfather**。

实现：
- `scripts/lib/knowledge-drift.js`：纯函数（parseCodeReferences 长扩展名在前 + classifyReference 6 档 + analyzeKnowledgeDrift + buildKnownIndex），不碰 fs/git 便于单测
- `scripts/pre-commit-check.js`：第 7 个 checker `checkKnowledgeDrift`，IO 在此（`git ls-files` 建 known 索引）；main 中 **warn 总打印 + block 计入 exit 1**（pre-commit 首个非阻塞档）
- `scripts/test-knowledge-drift.js`：16 单测 + 固化 dogfood gate（断言现有 block=0 防回归）
- `scripts/smoke-pre-commit.js`：S16a-e（pass/block/warn/skip/fail-open）+ makeRepo copy 列表加 lib

## 关键决策

- **FN-over-FP**（[[ADR-013]] §B）：漏检比误拒安全——误拒催生 `--no-verify` 习惯 → enforcement 死亡（[[feedback_enforcement_dead_on_arrival_82pct]]）
- **不进 plugin**：pre-commit 是开发期 git hook，不在 `copyUtilityScripts`，无 [[ADR-020]] parity 负担
- 同 commit 新增源码文件在 `git ls-files`(index) → 引用它不误 block（S16a 验证）

## 预防 / 复用

- 新增 enforcement 前：plan 阶段先跑 dogfood 探针扫现有全部同类产物 → 看 FP 成因 → 收窄判定域到确定性可判子集 → 重 dogfood 验证 0 FP（[[ADR-013]] §B 第三次成功应用）
- 这是 [[ADR-016]]/[[ADR-017]]/[[ADR-021]]「确定性边界」系列在知识层的落点

## 关联

- Plan: [[2026-06-01-knowledge-drift-checker]] ｜ Roadmap: [[2026-06-01-secondary-defects-roadmap]]（B/C/D 仍 planned）
- ADR: [[ADR-023]]
