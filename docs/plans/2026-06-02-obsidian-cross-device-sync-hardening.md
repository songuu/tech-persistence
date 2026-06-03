---
title: "Obsidian 跨设备同步加固：vault 自动生成同步工具原生 ignore"
type: sprint
status: completed
created: "2026-06-02"
updated: "2026-06-02"
tasks_total: 4
tasks_completed: 4
tags: [sprint, obsidian, cross-device, sync, install]
aliases: ["obsidian sync hardening", "vault gitignore stignore"]
invariants:
  - "同步排除规则单一事实源：obsidian/git/syncthing 三投影必须从 SYNC_EXCLUDES 派生，禁止各自硬编码"
  - ".obsidianignore 向后兼容：原有 5 条规则（*.jsonl/archive/node_modules/.git//*.bak.*）永远保留，merge 不破坏已有 vault"
  - "ignore 写入幂等：二次 init 对未变更文件不写、不产生 .bak，已存在则只补缺失规则不覆盖用户自定义"
  - ".gitignore 不含 .git/（git 语义无意义）；.stignore 含 .git/（Syncthing 文件级同步会损坏 refs）"
invariant_tests:
  - "node scripts/test-init-obsidian-vault.js"
deferred: []
---

# Obsidian 跨设备同步加固

> **Status:** `completed` · **Created:** 2026-06-02

## 需求分析

### 要做
- 把 `docs/solutions/2026-06-02-obsidian-cross-device.md` 分析出的 high-severity 缓解从「文档建议用户手动配置」落成「init 脚本自动生成机制」。
- 核心：`init-obsidian-vault.js` 自动在 vault 生成同步工具原生 ignore（`.gitignore` / `.stignore`），让 git/Syncthing 用户开箱排除会丢数据/损坏 vault 的文件。

### 不做
- 不改 Claude Code core auto-memory 的 cwd-key 路径（不受本项目控制，靠 persona.md 走 v5 dir 缓解，见 [[ADR-015]]）。
- 不为 Obsidian Sync/iCloud/Dropbox 自动配置排除（这些工具不读 vault 内 ignore 文件，只能文档化手动步骤）。
- 不引入「单一同步权威」的代码强制（无确定性触发点，保持文档铁律）。

### 成功标准
- [x] `scripts/init-obsidian-vault.js` 生成 vault .gitignore（排 *.jsonl / .agent-runs/ / workspace*.json，不含 .git/）。
- [x] `scripts/init-obsidian-vault.js` 生成 vault .stignore（含 .git/）。
- [x] 三投影由单一 `SYNC_EXCLUDES` 派生；`.obsidianignore` 向后兼容。
- [x] 幂等：二次 init 跳过已完整文件。
- [x] 单测覆盖 + 真实 smoke 通过。
- [x] 文档同步（obsidian-setup / obsidian-update / README / solution）。

## 技术方案

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| Obsidian 接入三方一致性 | graph colorGroups / Dashboard dataview / vault tags 必须一致（`test-init-obsidian-vault.js`） | 本 sprint 不动 colorGroups/dashboard，原 8 个测试继续通过 |
| `.obsidianignore` 安装行为 | 合并模式补缺失、不覆盖用户自定义 | `upsertIgnoreFile` 抽出同一逻辑，三文件复用；保留原 5 条规则 |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| vault `.gitignore`/`.stignore` | `install.* --obsidian` / `init-obsidian-vault.js` | `SYNC_EXCLUDES` → `excludesForTarget` → `upsertIgnoreFile` | ✅ vault 内文件 | ✅ 用户 git/Syncthing 读取生效 |

链路无 ❌：installer（Claude + Codex 都调同一脚本）→ init → vault 落 ignore → 外部同步工具排除。

### 方案

1. `SYNC_EXCLUDES`：单一事实源，每条 `{pattern, targets}` 标注进入哪些目标 ignore。
2. 三投影 `generateUserIgnores`（obsidian）/ `generateGitignore`（git）/ `generateStignore`（syncthing），全 `excludesForTarget(target)` 派生。
3. `upsertIgnoreFile(vaultPath, filename, content)`：幂等合并（注释行不计入缺失检测），三文件统一复用（抽自原 `.obsidianignore` 内联块，DRY）。
4. `.git/` 语义差异：obsidian+syncthing 投影含它，git 投影**不含**（`.gitignore` 列 `.git/` 无意义）。

### 任务拆解

- [x] **Task 1**: `SYNC_EXCLUDES` + 3 投影 + `upsertIgnoreFile` + 生成 `.gitignore`/`.stignore` + 导出 — `scripts/init-obsidian-vault.js` — L2
- [x] **Task 2**: TDD 测试（覆盖项 + 投影⊆canonical + 向后兼容 + 高危项断言） — `scripts/test-init-obsidian-vault.js` — L2
- [x] **Task 3**: 文档同步 — `docs/obsidian-setup.md` / `docs/obsidian-update.md` / `README.md` / solution Prevention — L1
- [x] **Task 4**: 验证（单测 13/13 + 临时 vault smoke 含幂等二跑 + pre-commit + git diff --check） — L1

### 测试策略
- L2（install-time 脚本，影响用户 vault）：单元测试三投影正确性 + 真实 smoke（init 临时 vault 断言文件内容 + 二次运行幂等）。
- 不变量回归：`test-init-obsidian-vault.js` 原 8 个三方一致性测试必须继续 pass（本 sprint 新增 5 个，共 13）。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 改 `generateUserIgnores` 破坏已有 vault 的 `.obsidianignore` merge | 低 | 中 | obsidian 投影保留原 5 条规则 + 向后兼容测试断言 |
| `.gitignore` 误列 `.git/` 导致用户困惑 | 低 | 低 | git 投影显式排除 `.git/`，测试断言不含 |
| 双运行时 parity | — | — | init 脚本非 plugin，两 installer 调同一脚本，天然 parity |

### 关键假设验证（ADR-012）

| 假设 | 验证方式 | 实际 |
|------|----------|------|
| installer 双运行时不会产生实现漂移 | Read `install.sh` / `install-codex.ps1` 的 `--obsidian` 路径，确认两边都调用 `scripts/init-obsidian-vault.js` | 成立；本 sprint 只改共享 init 脚本和测试，没有新增 Claude/Codex 专属分支 |
| `.obsidianignore` 旧行为不会被三投影抽象破坏 | `node scripts/test-init-obsidian-vault.js` 覆盖原 8 个 Obsidian 一致性测试 + 新增向后兼容断言 | 成立；测试结果 13 passed 0 failed，原有 5 条 ignore 规则继续保留 |
| git 与 Syncthing 的 `.git/` 语义差异已显式建模 | 检查 `SYNC_EXCLUDES` target 投影和测试断言 | 成立；`.gitignore` 不含 `.git/`，`.stignore` 含 `.git/`，避免同步工具损坏 refs |

### 涉及文件
- `scripts/init-obsidian-vault.js`
- `scripts/test-init-obsidian-vault.js`
- `docs/obsidian-setup.md` / `docs/obsidian-update.md` / `README.md`
- `docs/solutions/2026-06-02-obsidian-cross-device.md`

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-06-02 | T1 | `init-obsidian-vault.js`：引入 `SYNC_EXCLUDES` 单一事实源 + `excludesForTarget` + 三投影 + `upsertIgnoreFile` 幂等 helper；main 生成 `.gitignore`/`.stignore`；导出新函数 |
| 2026-06-02 | T2 | `test-init-obsidian-vault.js`：+5 测试（高危项覆盖 / git 投影 / stignore 含 .git/ / obsidian 向后兼容 / 投影⊆canonical）；13 passed 0 failed |
| 2026-06-02 | T3 | 文档同步：obsidian-setup 铁律2 改为"已自动生成"+ 内容树 + checklist + 重新初始化段；obsidian-update ignore 追加段；README Obsidian 集成段 + solution Prevention |
| 2026-06-02 | T4 | 验证：单测 13/13；临时 vault smoke（首跑生成三文件 + 二跑幂等跳过）；git diff --check 仅 CRLF 提示 |
| 2026-06-02 | review | 4 路对抗审查（correctness/parity/doc-drift/backward-compat）+ 修复：P1 `upsertIgnoreFile` 子串误匹配（`existing.includes` → 整行 Set 精确匹配，防 `*.jsonl` 被 `*.jsonl.bak` 吞没 / `.git/` 被注释命中）；P2 加 merge 行为测试 + per-target 高危项断言（替换恒真的"投影⊆canonical"测试，14/14）；P2 `.git/` 注释语义拆分 obsidian/syncthing；P1 plan 措辞去 inline-glob FP。parity lens=pass |

## 审查结果

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| — | — | — | 无 | — |

### P1 — 已修复
| # | 视角 | 位置 | 问题 | 修复 |
|---|------|------|------|------|
| 1 | correctness | `init-obsidian-vault.js` upsertIgnoreFile | `existing.includes(rule)` 子串匹配在 existing 含子串行/注释时静默漏补数据安全级规则 | 改整行 Set 精确匹配 + merge 行为测试固化 |
| 2 | doc-drift | 本 plan 成功标准 | inline-code `*.jsonl` 触发 checkPlanCompletion FP（ADR-013 §B 已知） | 措辞以真实文件起头、glob 去 backtick |

### P2 — 已处理
| # | 视角 | 位置 | 问题 | 处理 |
|---|------|------|------|------|
| 1 | backward-compat | `test-init-obsidian-vault.js` | "投影⊆canonical" 由构造恒真，零信号；高危项漏删检测不到 per-target drop | 替换为 per-target 高危项断言 + upsertIgnoreFile merge 测试 |
| 2 | parity | `init-obsidian-vault.js:SYNC_EXCLUDES` | `.git/` 行注释把 obsidian/syncthing 排除理由混为一谈 | 注释拆分两目标语义 |

### 第 6 视角 — 集成连续性
- 不破坏前 sprint invariant：三方一致性测试 8/8 仍 pass（未动 colorGroups/dashboard）。
- 无 dead code：`generateGitignore`/`generateStignore` 被 main 调用，`SYNC_EXCLUDES` 被三投影消费，测试全覆盖。
- 双运行时 parity：init 脚本非 plugin，两 installer 共用，无副本漂移。

## 复利记录

### 提取的经验
- 缓解措施分「文档建议用户手动做」与「机制自动做」两档；high-severity 数据安全项应尽量落为机制（生成原生 ignore），靠用户手动配置等于没做。
- 多目标排除规则用「单一事实源 + per-target 投影」（同 [[ADR-014]] hook-registry projection 模式），避免三份 ignore 各自硬编码漂移。
- 同类工具语义差异必须显式建模：`.gitignore` 列 `.git/` 无意义、`.stignore` 必须列 `.git/`——同一份 canonical 不能无脑复制到所有目标。

### 解决方案文档
- `docs/solutions/2026-06-02-obsidian-cross-device.md`（分析 + 本次机制落地）
