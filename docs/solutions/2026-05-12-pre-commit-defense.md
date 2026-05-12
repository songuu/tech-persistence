---
title: "Pre-commit 防御：把 propagate 纪律 + ADR-012 plan 勘察从文档协议变成 hook 拒绝"
date: 2026-05-12
tags: [solution, infrastructure, enforcement, hooks, pre-commit, dogfood]
related_instincts: []
aliases: ["pre-commit defense", "filename-as-grandfather", "dogfood boundary coverage"]
---

# Pre-commit 防御：mechanism over discipline

## Problem

[[2026-05-11-sprint-speed-layer1]] 完成时**实证**两个失败：

1. **D1 实证**: 我自己在 Compound 阶段漏跑 `build-codex-plugin`，validate 才暴露。
2. **D2 实证**: Plan 阶段两次基于错误假设（`CONTEXT_BUDGET_CHARS = 25KB` / `pipeline.js` 是 /sprint 代码），work 阶段才发现并重新设计，催生 [[ADR-012]]。

两次失败的共同根因：**关键规则只活在 .md 里**——propagate 纪律在 `debugging-gotchas.md`，plan 勘察规则在 ADR-012，靠模型每次读 context 时记得遵守。上下文压缩 / 压力下 / 重要时刻会被悄悄省略。

本 sprint 把这两条规则下沉成**工具拒绝**（pre-commit hook），从「靠模型记得」变成「靠 hook 阻塞」。

## Root Cause

文档协议级 enforcement 的 3 个失效模式：

1. **遗忘**: 上下文压缩后规则文档不在 active context，模型不再激活该规则
2. **省略**: 压力下（用户等响应、token 紧张）模型主动跳过 self-check
3. **漂移**: 多次修订后规则文档与实际期望微妙偏移，但没有客观信号验证

替代不是"写更多文档"或"加更多提醒"——而是**让违反规则的 commit 在工具层被拒**。

## Solution

新增 `scripts/pre-commit-check.js`（~250 行）作为单一检查入口，`scripts/install-git-hooks.js` 安装为 `.git/hooks/pre-commit`（sh 一行委托 node）。检查两路：

### 1. Propagate sync 检查

扫描 staged `user-level/commands/*.md` 和 `user-level/rules/*.md`，**复用 propagate / build-codex-plugin 的同一 transform 函数**（require 现有模块、不重写），对派生副本做 sha256 比对：

- `.codex/commands/<name>.md` ← `applyCodexRegex(source)`
- `plugins/tech-persistence/commands/<name>.md` ← `transform(source)` (build-codex-plugin)
- `plugins/tech-persistence/skills/<name>/SKILL.md` ← `commandToSkill(name, source)`
- `.codex/rules/<name>.md` ← `applyCodexRegex(source)`

任何不一致 → 拒绝 commit + **派生具体 fix 命令**：

```text
node scripts/propagate-command-changes.js <派生的具体 cmd 名> --rules <派生的具体 rule 名>
node plugins/tech-persistence/scripts/build-codex-plugin.js
node scripts/validate-codex-plugin.js
```

### 2. Plan scope lint

扫描 staged `docs/plans/YYYY-MM-DD-*.md`（排除 `-handoff-` / TEMPLATE），验证：

- 文件名日期 `< 2026-05-12` → grandfather 跳过 lint
- 否则必须含 anchor `^#{1,6}\s+\*{0,2}关键假设验证` 或 `^\*\*关键假设验证\*\*`
- 段后内容 ≥ 100 非空白字符（防止占位符）

### 3 层 fail-open 防御

| 层 | 触发 | 行为 |
|----|------|------|
| `--no-verify` | 用户主动加 flag | git 本身跳过，hook 不到该层 |
| 外层 `try/catch` | hook 内部异常 | stderr log，exit 0 放行 |
| sh wrapper | `command -v node` 失败 | stderr warn，exit 0 放行 |

新增 `MISSING_TRANSFORMERS` error code：当 `propagate-command-changes.js` 或 `build-codex-plugin.js` 被重命名 / 移动时，hook 给出**专用诊断**而不是通用 "hook 内部异常已忽略"——降低未来 silent degradation 的风险。

## Prevention（可复利的元经验）

### 1. Dogfood 必须枚举边界产物，不能只测自己刚写的

**事件**: Phase 4 review 时 correctness reviewer 发现 hook 装上**立刻**会拒绝 6+ 个本仓库**已有的**无 frontmatter 旧 plan（`2026-04-09-docs-plan-persistence.md` 等）。我的 dogfood 步骤只验证了：(a) 我刚写的新 plan 通过 + (b) 破坏一次再恢复——**没枚举本仓库已有的同类产物是否都满足新规则**。

如果合并，hook 上线第一天就会阻塞合法的旧 plan 修订，用户必须 `--no-verify` 绕过——这是 enforcement 机制的最差启动状态。

**规则**: 任何新 enforcement 机制（pre-commit / lint / CI / hook with reject）必须在合并前满足"dogfood 边界覆盖"：(a) 枚举本仓库与新规则同类的**已有产物**至少 3 个边界样本（最老 / 最新 / 格式异常）；(b) 离线模拟 enforcement 跑这些样本不被误拒；(c) 如有误拒，要么 grandfather 要么主动改造旧产物——而不是上线让用户 `--no-verify`。详见 [[ADR-013]]。

### 2. Filename 比 frontmatter 鲁棒——优先用 git-enforced metadata

**事件**: 初版 grandfather 用 frontmatter `created` 字段判定。Reviewer 发现 3 个独立的失效模式（CRLF 行尾 / 6+ 个无 FM 旧 plan / 不可解析日期 `2026-5-12`），全部由"frontmatter 是 author-discipline-enforced，可信度低"导致。

修复：filename 中的 `YYYY-MM-DD-` 前缀是 `PLAN_PATH_RE` 强制 captured 的——文件名不匹配该 pattern 根本不进 plan list。这是 git-enforced 信号。一次性解决 3 个 reviewer findings。

**规则**: 当 metadata 既存在于 filename 也存在于 frontmatter 时（plan / solution / changelog），**优先用 filename**。Frontmatter 适合可变状态（status / tags），不适合不变事实（created / type）。

### 3. Fail-open 系统必须有 negative assertion

**事件**: 初版 S2 测试 "user-level 改了且派生已同步 → exit 0"。Testing reviewer 发现 exit 0 既可能是 real pass 也可能是 silent fail-open（外层 try/catch 触发）。S2 通过的同时整个 hook 可能已经禁用。

修复：S2 加 `assert(!/hook 内部异常已忽略|fail-open 放行/.test(res.stderr))`。

**规则**: 任何 fail-open 系统（exit 0 同时承担"成功"和"已禁用"两个含义）的"成功"测试，必须额外断言 fail-open marker 不在输出中。否则测试套件随着代码退化一起退化。

### 4. Error 输出应是可执行命令，不是文档

**事件**: 初版 `formatPropagateError` 输出 `node scripts/propagate-command-changes.js <cmd>... [--rules <rule>...]`——这是 README 风格的占位符。Maintainability reviewer 指出每次 failure 用户都要：(a) 读 mismatch 行 → (b) 提取 basename → (c) 区分 cmd vs rule → (d) 拼装参数。

修复：新增 `deriveRepairCommand(mismatches)` 从 mismatch records 派生真实命令名，输出形如 `node scripts/propagate-command-changes.js sprint review --rules auto-mode`。

**规则**: error message 中的"修复方式"段必须是 **copy-paste runnable**。如果包含占位符 / 待用户填空，写成模板（plan-lint 段是模板，明示）；否则全部派生具体值。

### 5. Reviewer dispatch matrix（[[2026-05-11-sprint-speed-layer1]] T1 产物）已 self-validate 第二次

本 sprint 是 L3，dispatch 3 reviewer（correctness / maintainability / testing），跳过 security / architecture。

- correctness 抓到 5 P0（CRLF / no-FM / quotePath / anchor regex / parseFrontmatter end-marker）
- maintainability 抓到 1 P0（fix command UX）
- testing 抓到 2 P0（fail-open 未测 + S2 silent fail-open）

各 reviewer 的 finding 类型分布与 prompt 强相关，**确认 dispatch matrix 不是 cosmetic**——3 个 reviewer 每个都贡献了至少 1 个独立 P0，没冗余、没遗漏。

## Related

- [[ADR-012]] — Plan 阶段必须勘察被改文件（本 sprint 兑现）
- [[ADR-013]] — Dogfood 必须枚举边界产物（本 sprint 催生）
- [[2026-05-11-sprint-speed-layer1]] — Layer 1 加速 sprint（T1 reviewer dispatch matrix 在此 self-validate）
- [[2026-05-09-agent-loop-caveman-audit]] — propagate 纪律来源（debugging-gotchas HIGH 条目）
- [[2026-05-11-claude-settings-hook-merge]] — 同类"安装态静默失效"问题；本 sprint 把 hook 失效检测也下沉到 fail-open + 专用诊断
