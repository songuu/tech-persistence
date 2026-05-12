---
title: "Windows hook command 用 cmd 语法回归，每次会话在 cwd 留下 `nul` 空文件"
date: 2026-05-12
tags: [solution, hooks, windows, shell-mismatch, regression, installer]
related_instincts: [windows-hook-bash-portability]
aliases:
  - "nul pollution"
  - "hook shell mismatch regression"
  - "2>nul 文件创建"
---

# Windows hook command shell mismatch (regression)

## Problem

Claude Code 每次会话在仓库根目录留下 0 字节 `nul` 空文件，`git status` 反复看到 `?? nul`。文件无法用普通路径访问（Windows 把 `nul` 视为保留设备名），需要 `\\?\` extended path 才能读到 metadata。

## Root Cause

用户态 `~/.claude/settings.json` 的 4 个 hook command（SessionStart / PreToolUse / PostToolUse / Stop）形如：

```text
node "<path>/inject-context.js" 2>nul || exit /b 0
```

这是 cmd.exe 风格——`2>nul` 意为重定向到 NUL 设备，`exit /b 0` 是 cmd 退出语法。但 **Claude Code 在 Windows 上通过 Git Bash 执行 hook command，不是 cmd.exe**：

- 同 settings 的 `statusLine` 也是 `bash -c '...'`
- cmd.exe 因 `nul` 是保留设备根本无法在文件系统创建同名文件——能在仓库 cwd 看到 `?? nul` 就**反证执行环境必是 bash**
- 在 bash 里 `2>nul` 解析为「stderr 重定向到当前目录下名为 `nul` 的真实文件」，每次 hook 触发都创建/覆盖一次
- `exit /b 0` 在 bash 里是无效语法，但因 `||` 短路（node 成功就不执行），所以错误被掩盖

**关键发现：这是第二次回归**。`docs/solutions/2026-04-09-obsidian-integration.md` 已经修过一次 `install.ps1:63,75,87,99`，但后续重构（引入 `scripts/merge-claude-settings-hooks.js` + install.ps1 改写）让 cmd 语法又回到了 4 个污染源。纯文档级的 "以后记得用 POSIX 语法" 抵不住代码重构带来的回归。

## Solution

修了 4 个污染入口 + 1 个文档勘误：

1. **生成器** `scripts/merge-claude-settings-hooks.js:61` — windows 分支去除 cmd 语法，永远输出 `2>/dev/null || true`，加注释解释为什么 shell 选项保留但不分支
2. **模板** `install.ps1:60-63` — 4 行 hardcoded hook 模板 `2>nul || exit /b 0` → `2>/dev/null || true`
3. **当前态** `~/.claude/settings.json` — 4 个 hook command 立即止血（Edit replace_all）
4. **残留** `C:/project/my/tech-persistence/nul` — 用 `\\?\` extended path 删除
5. **勘误** `docs/solutions/2026-04-09-obsidian-integration.md` — 加 errata 块标注 2026-05-12 回归 + 链到本文档

## Prevention（可复利的元经验）

### 1. 同一 bug 第二次出现 = 工具链应有自动化护栏

2026-04-09 已经识别并修了 cmd-vs-bash 语法问题。重构时回归，因为 enforcement 只活在 solution doc 里。**回归 N≥2 是把约定从「文档协议」升级到「自动化检查」的强信号**——本次升级 path：debugging-gotchas 标注「已踩 2 次」 + 建议下一道防线是 CI/test 断言（任何安装产物的 hook command 不得含 `2>nul` / `exit /b`）。

参照前例：[[debugging-gotchas]] PowerShell BOM 那条（"已踩 2 次。第三次出现 = 工具链应自动化"），属于同一类升级触发器。

### 2. 旧 solution doc 加 errata，不删

发现 regression 时不要删旧 solution doc，加 errata block 在 frontmatter 下方：

```markdown
> [!warning] Errata YYYY-MM-DD — 此问题回归了
> [...回归路径和修复链接...]
```

并把 `tags:` 加 `regression-tracked` 标签，便于未来检索本仓库所有曾回归过的修复。`related_instincts` 不动（保留原本能 ID 作为图谱节点）。新 solution doc 通过 `aliases` 和 `wikilink` 引用旧文档，形成图谱串联而非替代。

### 3. 用 reserved-device 文件做执行环境检测

Windows 上「能在文件系统创建 `nul` / `con` / `aux` / `prn` 等保留设备名文件」是 bash-like shell 环境的强反证（cmd.exe 永远无法做到）。未来调查任何「hook / 脚本 / CI 步骤在 Windows 上行为异常」时，扫一眼 cwd 有没有这几个文件，可以零成本判定执行 shell。

### 4. 污染源枚举要覆盖 3 层：生成器 / 模板 / 当前态

修复 settings-like 文件类 bug 时，永远要找全 3 层入口：

- **生成器**（写入逻辑的代码：merge-claude-settings-hooks.js）
- **模板**（hardcoded 的源样本：install.ps1 hook 模板）
- **当前态**（已经写到磁盘的文件：~/.claude/settings.json）

只修生成器，旧的当前态会继续污染；只修当前态，下次安装/合并又回归。**3 层不齐 = 没修干净**。

## Related

- [[debugging-gotchas]] — 新增 HIGH 条目 `[hooks, shell-mismatch, windows]` 标「已踩 2 次」
- [[2026-04-09-obsidian-integration]] — 首次发现并修复此 bug（已加 errata 标记 regression-tracked）
- [[2026-05-12-nul-pollution-fix]] — 本次修复 sprint plan，含「关键假设验证」段
- [[2026-05-11-claude-settings-hook-merge]] — 引入 `merge-claude-settings-hooks.js` 时埋下了回归路径
- [[windows-hook-bash-portability]] — 本次升级的本能（confidence 0.85+，已踩 2 次）
