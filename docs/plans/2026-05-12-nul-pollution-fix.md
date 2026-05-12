---
title: "修复 Claude Code hook 在 Windows 仓库根目录留下 `nul` 空文件"
type: sprint
status: completed
created: "2026-05-12"
updated: "2026-05-12"
tasks_total: 4
tasks_completed: 4
tags: [sprint, bugfix, hooks, windows, installer]
aliases: ["nul pollution", "hook shell mismatch"]
---

# 需求分析

## 现象

`git status` 在每次 Claude Code 会话期间反复看到 `?? nul`。文件 0 字节，标准 `ls`/`cat` 无法直接访问（Windows 把 `nul` 视为保留设备名），需要 `\\?\` extended path 才能读到 metadata。本次会话期间 `nul` 文件最后修改时间随 hook 触发节奏变化（10:26:21 创建、10:29:01 修改），与 sprint 期间 SessionStart / PreToolUse / PostToolUse / Stop hook 高频触发吻合。

## 根因

用户态 `~/.claude/settings.json` 的 4 个 hook command 形如：

```text
node "<path>/inject-context.js" 2>nul || exit /b 0
```

这是 **cmd.exe 风格**（`2>nul` 在 cmd 里表示重定向到 NUL 设备，`exit /b 0` 是 cmd 退出语法）。但 Claude Code 在 Windows 上**通过 Git Bash 执行 hook command**（同一 settings 的 statusLine 也用 `bash -c '...'`，且 cmd.exe 因 `nul` 是保留设备根本无法创建同名文件——能在仓库根目录出现 `nul` 文件本身就反证了执行环境不是 cmd）。

在 Git Bash 里：
- `2>nul` → 把 stderr 重定向到当前目录下名为 `nul` 的**真实文件**（每次 hook 触发都创建/覆盖空文件）
- `exit /b 0` → 因 `||` 短路，node 成功就不执行；即使执行也只会报 `command not found`，被 hook 自身的 silent fail-open 吃掉

对比项目态 `.claude/settings.json` 同样的 4 个 hook，用的是 `2>/dev/null || true`（POSIX 语法），所以不创建污染文件。

## 关键假设验证

| 假设 | 验证方式 | 可信度 | 结论 |
|------|---------|--------|------|
| Claude Code 在 Windows 上用 git-bash 执行 hook command，不是 cmd.exe | (1) `nul` 文件能在 cwd 创建——cmd.exe 因保留设备名根本无法做到；(2) `~/.claude/settings.json` 同一 settings 的 statusLine 用 `bash -c '...'` | 高 | 假设成立 |
| `~/.claude/settings.json` 4 个 hook 用 cmd 语法 | Read `C:/Users/songyu/.claude/settings.json` line 128/140/152/164，确认 `2>nul \|\| exit /b 0` | 高 | 已确认 |
| `merge-claude-settings-hooks.js` 是污染源之一 | Read `scripts/merge-claude-settings-hooks.js:60-62`，确认 windows 分支输出 cmd 语法 | 高 | 已确认 |
| `install.ps1` 是污染源之二 | Read `install.ps1:60-63`，确认 hardcoded cmd 语法 | 高 | 已确认 |
| 项目态 `.claude/settings.json` 不需要改 | Read `C:/project/my/tech-persistence/.claude/settings.json` line 18/30/42/54，已是 `2>/dev/null \|\| true` | 高 | 不动 |
| `2>/dev/null \|\| true` 在 git-bash 行为正确 | POSIX 标准语义；git-bash 即 MSYS2 bash | 高 | 跨平台安全 |

会拒绝哪些现有产物：本次 lint 规则未变，pre-commit hook 自身不会因为本次修改拒绝任何文件；仅 `plan-scope-lint` 会校验本文件存在「关键假设验证」段（已包含）。

## 范围

**做**：
1. 修 `scripts/merge-claude-settings-hooks.js:61` — windows 分支也输出 POSIX 语法
2. 修 `install.ps1:60-63` — 4 行 hook 模板从 `2>nul || exit /b 0` → `2>/dev/null || true`
3. 修当前用户态 `~/.claude/settings.json` 4 个 hook command — 立即止血
4. 删除 `C:/project/my/tech-persistence/nul` 残留文件（Windows extended path）
5. 加 `debugging-gotchas.md` 一条 HIGH（shell mismatch 类）
6. 旧 solution `docs/solutions/2026-04-09-obsidian-integration.md` 加 errata 标注（错误经验勘误）

**不做**：
- 不改项目态 `.claude/settings.json`（已经是正确语法）
- 不引入「真实 cmd.exe 执行路径」分支——目前 Claude Code 在 Windows 永远走 bash，无需 split
- 不重写整个 hook command 生成逻辑——只修语法

## 风险

- 用户态 settings.json 是会话外共享状态（auto-mode.md 强制人工 gate）——本次用户已显式确认修复
- 修改 settings.json 必须保留所有其他字段不动（用 Edit replace，不重写整个文件）
- 删 `nul` 文件需要 `\\?\` extended path（普通 Remove-Item 会失败）

---

# 技术方案

修复入口分两层：

| 层 | 文件 | 修改内容 |
|----|------|---------|
| 生成器 | `scripts/merge-claude-settings-hooks.js` | hookCommand windows 分支去除 cmd 语法 |
| 模板 | `install.ps1` | 4 行 hardcoded hook 命令 |
| 当前态 | `~/.claude/settings.json` | 4 个 hook command（用户态） |
| 残留 | `C:/project/my/tech-persistence/nul` | 删除 |
| 知识 | `.claude/rules/debugging-gotchas.md` | +1 HIGH 条目 |
| 勘误 | `docs/solutions/2026-04-09-obsidian-integration.md` | 加 errata 块 |

---

# 任务拆解

- [x] T1 修 `scripts/merge-claude-settings-hooks.js`（windows 分支 → POSIX 语法 + 加注释说明原因）
- [x] T2 修 `install.ps1:60-63`（4 行 hook 命令）
- [x] T3 修 `~/.claude/settings.json` 4 个 hook command（保留其他字段）
- [x] T4 删 `nul` 文件 + 加 debugging-gotchas + 加 solution errata

---

# 变更日志

- 2026-05-12: 全部 4 任务完成，nul 残留文件已删除，未来安装将不再产生污染。

---

# 复利记录

参见 [[debugging-gotchas]] 新增条目 "[hooks, shell-mismatch] hook command 在 Windows 上仍走 git-bash"。
