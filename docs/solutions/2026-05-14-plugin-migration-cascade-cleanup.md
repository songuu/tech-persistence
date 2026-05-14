---
title: "Claude Code 2.x plugin 迁移后的 cascade cleanup"
date: 2026-05-14
tags: [solution, plugin-migration, hook-double-fire, cleanup, doc-vs-code-drift]
related_instincts:
  - documented-claim-vs-code-reality-drift
  - claude-skills-name-suffix-regex-permissive
  - ps1-needs-utf8-bom
  - bash-pipefail-vs-ls-no-match
aliases: ["两天审计 R1-R6", "plugin 迁移 cascade", "用户态清理"]
---

# Claude Code 2.x plugin 迁移后的 cascade cleanup

## Problem

完成 Claude Code 2.x plugin 化（5 月 13 日）后，对最近 2 天提交做"看着像 done 实际未 done"审计：发现 **CRITICAL hook 双触发回归** + 多个用户态 `~/.claude/` 孤儿残留 + 一个 `set -e` 兼容性 bug。审计起点是简单的 git log 复盘，最有价值的发现是元层级的：commit message 声称已修但代码 / 文件实际没改的 drift 模式第三次复现。

## Root Cause

### 1. Hook 双触发（R1，CRITICAL）

- Commit 89531f4 message 声称 "removed all hooks field entries from ~/.claude/settings.json"
- 实际验证：`diff ~/.claude/settings.json ~/.claude/settings.json.bak-2026-05-13` 输出**空**
- 即 backup 文件创建了 → **但原文件从未被修改**
- 后果：用户态 4 个 hook + plugin 4 个 hook 同时活，每次 `PreToolUse` / `PostToolUse` 双跑 `observe.js` 写入双份 `observations.jsonl`，`Stop` 时 `evaluate-session.js` 跑两次（10s timeout × 2），Memory v5 数据双采集导致本能置信度膨胀

→ 教科书级 [[documented-claim-vs-code-reality-drift]] N=3 复现。

### 2. 用户态孤儿（R4 + R5，MEDIUM）

Claude Code 2.x 改用 plugin system 后：
- `~/.claude/commands/` 22 个老命令 + 44 个 `.bak.YYYYMMDDhhmm` 备份残留（plugin 端 LF-normalized 等价副本存在）
- `~/.claude/skills/` 17 个 skill 中有 5 个与 tech-persistence plugin 重复（`context-handoff` / `continuous-learning` / `memory` / `prototype-workflow` / `test-strategy`）
- 12 个 skill 是其他 plugin / 用户独有（**绝对不能误删**）

### 3. Rename in-place 反模式（R11，新发现）

第一次尝试用 `mv <name> <name>.deprecated-2026-05-14` 软删 5 个重复 skill。结果：Claude Code skill scanner **没有目录后缀过滤**，5 个 `.deprecated-*` 仍被注册为有效 skill name，污染 skill picker。

→ 必须**移出 `~/.claude/skills/` 子树**。新本能 [[claude-skills-name-suffix-regex-permissive]]。

### 4. Bash pipefail + ls 无匹配（R6 修复时暴露）

`install.sh::safe_copy` 加 .bak retention 时，`existing=$(ls -1t "$dst.bak."* 2>/dev/null | tail -n +4)` 在无匹配时被 pipefail 提升 ls 的 exit=2 杀死整个 install 脚本（首次安装无 .bak 时 100% 触发）。

→ 新本能 [[bash-pipefail-vs-ls-no-match]]。

### 5. PS1 BOM 缺失（R9，预防性发现）

`install.ps1:3` 含中文 "自进化工程系统" 但文件无 UTF-8 BOM。中文 Windows 上 PS 5.1 用 GBK 解码 UTF-8 字节 → tokenizer 崩塌。已踩 2 次（commit b6dc85f / 2026-04-15）+ 本次预防性发现 = N=3，升级 [[ps1-needs-utf8-bom]] 本能为 instinct 文件首次落地（之前仅 wikilink 引用但文件不存在 = 本本能自身就是 doc-vs-code-drift 受害者）。

## Solution

**6 个 commit 渐进式止血：**

| Commit | 范围 | 关键变更 |
|--------|------|---------|
| `R1`（手动）| `~/.claude/settings.json` | 真删 hooks 字段；diff 验证仅 line 59-108 改动；新建有效 backup `.bak-2026-05-14-pre-hooks-removal`（区别于无效的 `.bak-2026-05-13` 当时只 cp 但 commit 漏改原文件）|
| `dbfccb7` | install.sh + install.ps1 + 旧 plan | R2 deprecation banner + R3 errata 防止 cmd 语法误用为 hook |
| `ed2c638` | install.ps1 | R9 加 UTF-8 BOM（`printf '\xef\xbb\xbf' \| cat`）|
| `8de3f98` | sprint 文档 | R4+R5 移动 `~/.claude/commands` 和 5 个 TP-dup skill 到 `~/.claude-backups/2026-05-14-deprecated/`（**移出子树**，不是 rename）|
| `6a337f6` | install.sh + install.ps1 | R6 .bak retention=3 + `|| true` 修 pipefail bug |
| Sprint doc | docs/plans/2026-05-14-two-day-risk-audit.md | 完整审计过程、风险矩阵、回滚命令 |

### 核心修复代码

**R6: install.sh `safe_copy` retention（pipefail 兼容）**：
```bash
safe_copy() {
  local src="$1" dst="$2"
  if [[ -f "$dst" ]]; then
    cp "$dst" "${dst}.bak.$(date +%Y%m%d%H%M)"
    local retention="${INSTALL_BAK_RETENTION:-3}"
    local existing
    # `|| true` 兜底：无 .bak 时 ls exit=2 与 set -e + pipefail 不兼容
    existing=$(ls -1t "${dst}.bak."* 2>/dev/null | tail -n +$((retention + 1)) || true)
    if [[ -n "$existing" ]]; then
      echo "$existing" | xargs rm -f 2>/dev/null || true
    fi
  fi
  cp "$src" "$dst"
}
```

**R4+R5: 用户态目录 deprecate（移出子树）**：
```bash
mkdir -p ~/.claude-backups/2026-05-14-deprecated/
mv ~/.claude/commands ~/.claude-backups/2026-05-14-deprecated/commands
for s in context-handoff continuous-learning memory prototype-workflow test-strategy; do
  mv ~/.claude/skills/$s ~/.claude-backups/2026-05-14-deprecated/skills-$s
done
# 双层 backup：还做了 tar.gz pre-cleanup snapshot
tar -czf ~/.claude-backups/2026-05-14-r4-r5-pre-cleanup.tar.gz \
  -C ~/.claude commands skills/context-handoff skills/continuous-learning skills/memory skills/prototype-workflow skills/test-strategy
```

## Prevention

### 立即（已实施）

- R2 banner 警告新用户跑 `install.sh` 会立刻造成双触发
- R6 retention 防止 install.sh 多次跑积累 .bak
- 双层 backup（tar.gz + 子树外目录）保证完全可逆

### 短期（提议中）

- **R10**: pre-commit `checkPS1Bom` —— 扫描 `*.ps1` 含中文则要求 BOM。N=3 触发 [[mechanism-over-discipline]] 升级
- **R12 提议**: pre-commit `checkBackupMatchesIntendedChange` —— 当 commit message 含 `remove*/delete*/clean*` + 改用户态 settings 类敏感文件时，校验 diff 旧 backup vs 新文件**非空**；空 diff 必拒（这就是 R1 当时本可被拦下的 enforcement）

### 长期（系统层）

- **永远不 rename in-place** 依赖路径扫描的注册系统（Claude skill / VSCode extension / Vim plugin）。Deprecation 必须**移出 watched 路径**或**移到 ignore-listed 路径**
- 元规则：发现 doc 声称已修 → 立刻 grep / diff / read 当前代码验证；本仓库已有 `docs/solutions/2026-05-12-pre-commit-defense.md` 把这种 mechanism 落地为 pre-commit `checkPropagateSync` / `checkPlanScope` / `checkPlanCompletion`，但 hooks-field-removed 这类用户态改动**不在 pre-commit 覆盖范围内**（pre-commit 只看仓库内），需要单独的 wrapper

## Related

- [[documented-claim-vs-code-reality-drift]] — N=3 复现，confidence 0.85 → 0.92
- [[ps1-needs-utf8-bom]] — 首次落入 instinct 文件（本身就是上一本能的受害者）
- [[claude-skills-name-suffix-regex-permissive]] — N=1 新本能
- [[bash-pipefail-vs-ls-no-match]] — N=1 新本能
- [[mechanism-over-discipline]] — ADR-013 的应用：R10 / R12 提议都是它的实践
- [[ADR-013]] — dogfood 边界产物枚举（本 sprint 在 R4+R5 真正做到了：列 17 个用户态 skill + 追溯 plugin cache 归属，决定只删 5 个有等价副本的）
- [[2026-05-14-two-day-risk-audit]] — 本 solution 的 sprint 文档
