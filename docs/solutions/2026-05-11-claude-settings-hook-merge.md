---
title: "Claude Code settings hook merge"
type: solution
date: "2026-05-11"
tags: [solution, claude, hooks, installer, validation]
related:
  - "[[2026-05-11-codex-claude-defect-scan]]"
---

# Claude Code settings hook merge

## 问题

Claude Code 安装器在遇到已有 `~/.claude/settings.json` 或项目 `.claude/settings.json` 时，只提示“手动合并 hooks”。这会留下一个危险状态：命令、rules、hook 脚本都已复制，安装看似完成，但 settings 没有 `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop` hook，学习层不会运行。

本次实测：
- 用户级 Claude Code：`~/.claude/settings.json` 存在但缺 4 个 hook。
- 项目级 Claude Code：`.claude/settings.json` 也缺 4 个 hook。
- Codex 用户态和项目态校验通过。

## 方案

新增 `scripts/merge-claude-settings-hooks.js`，用 JSON 结构化合并而不是字符串替换：
- 保留现有 settings 字段和第三方 hook。
- 按 hook 命令中的脚本名检测是否已存在，避免重复插入。
- 支持 `--shell windows|posix`，分别生成 Windows 与 POSIX 的失败吞噬命令。

安装器改动：
- `install.ps1` 遇到已有 settings 时调用 merger。
- `install.sh` 遇到已有 settings 时调用 merger。
- 当前项目 `.claude/settings.json` 补齐 4 hook。

验证补强：
- 新增 `scripts/validate-claude-install.js --user|--project`。
- README 安装后验证命令增加 Claude Code 与 Codex 双入口。

## 验证

```powershell
node scripts\validate-claude-install.js --project
node scripts\validate-claude-install.js --user
node scripts\validate-codex-install.js --project
node scripts\validate-codex-install.js --user
node scripts\validate-codex-plugin.js
node scripts\smoke-relevance.js
node scripts\smoke-memory-parity.js
```

全部通过。`bash -n install.sh` 未执行成功，因为当前 Windows 环境没有可用 Bash/WSL；`install.sh` 的改动范围已人工审查。

## 规则

安装器不能把 hook 合并留给用户手动处理。只要系统承诺“安装完成后 hook 生效”，就必须提供结构化 merge 和安装态 validator；否则会出现“文件都在、功能不跑”的静默失效。
