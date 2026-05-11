---
title: "Codex and Claude Code Defect Scan"
type: sprint
status: completed
created: "2026-05-11"
updated: "2026-05-11"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, codex, claude, validation]
aliases: ["Codex/Claude defect scan"]
---

# Codex and Claude Code Defect Scan

## 需求分析

### 要做
- 继续检查上一轮 sprint 架构和分发链路是否还有缺陷。
- 同时覆盖 Codex 与 Claude Code 两个运行时：命令/skill 分发、hook 配置、项目级安装态。
- 修复能本地确定的缺陷，并补自动验证，避免后续只靠人工扫配置。

### 不做
- 不执行完整用户级安装到 `~/.claude`、`~/.codex` 或 `~/plugins`；仅在用户批准后修复 `~/.claude/settings.json` 缺失 hooks。
- 不调用真实 `claude` / `codex` provider 做联网或认证相关探测。
- 不重构 agent-loop、Memory v5 或 skill 协议。

### 成功标准
- [x] Claude Code 项目级安装态能被脚本验证。
- [x] 当前项目 `.claude/settings.json` 与项目模板的 4 hook 预期一致。
- [x] 用户级 Claude Code settings 缺 hook 的实际安装态已修复并复验通过。
- [x] Codex plugin / user / project 校验继续通过。
- [x] 本次发现和修复写入 sprint / solution / rules，便于后续复用。

### 风险和假设
- 当前 repo 中 `.claude/settings.json` 是项目级安装态样本；如果缺 hook，会导致 Claude Code 在该项目内无法自动注入记忆和观察。
- Codex 的 TUI slash command 限制已在上一轮确认，本轮只校验 `$skill` 和 plugin 分发链路。

---

## 技术方案

### 方案概述

Codex 已有 `validate-codex-plugin.js` 和 `validate-codex-install.js`，Claude Code 缺少对称的安装态验证。因此补一个 `scripts/validate-claude-install.js`，用同一套 inventory 规则验证用户级/项目级命令、rules、hook 脚本、settings hook 配置和共享 homunculus 配置。再把当前 `.claude/settings.json` 修正为包含 4 hook 的项目态配置。

### 任务拆解

- [x] **Task 1**: 增加 Claude Code 安装态验证脚本 — 文件: `scripts/validate-claude-install.js`
- [x] **Task 2**: 修复当前项目 Claude Code settings 缺 hook — 文件: `.claude/settings.json`
- [x] **Task 3**: 修复安装器遇到已有 settings 时只警告不合并 hooks 的缺陷 — 文件: `scripts/merge-claude-settings-hooks.js`, `install.ps1`, `install.sh`
- [x] **Task 4**: 扩展文档/命令提示，让 Claude 与 Codex 校验入口对称 — 文件: `README.md`
- [x] **Task 5**: 运行 Claude/Codex 双运行时校验并审查 diff

### 测试策略
- 单元/脚本测试: `node scripts\validate-claude-install.js --project`
- Codex 回归: `node scripts\validate-codex-plugin.js`; `node scripts\validate-codex-install.js --project`
- 现有 smoke: `node scripts\smoke-relevance.js`; `node scripts\smoke-memory-parity.js`

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 校验脚本过严，误报用户本地已有自定义配置 | 中 | 中 | 支持 `--user` / `--project` 分开跑；用户级仅在显式执行时检查 |
| `.claude/settings.json` 权限字段被覆盖 | 低 | 中 | 以模板 hook 为基础保留现有 permissions |
| Codex 派生文件再次不同步 | 低 | 中 | 本轮不手改派生命令内容；只运行现有 build/validate |

### 涉及文件
- `scripts/validate-claude-install.js`
- `scripts/merge-claude-settings-hooks.js`
- `.claude/settings.json`
- `install.ps1`
- `install.sh`
- `README.md`
- `docs/plans/2026-05-11-codex-claude-defect-scan.md`

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-11 | Task 1 | 新增 `scripts/validate-claude-install.js`，支持 `--user` / `--project`，校验命令、rules、skills、hook 脚本和 settings hooks。 |
| 2026-05-11 | Task 2 | 给当前 `.claude/settings.json` 补齐 SessionStart / PreToolUse / PostToolUse / Stop 四个 hook，同时保留现有 permissions。 |
| 2026-05-11 | Task 3 | 新增 `scripts/merge-claude-settings-hooks.js`；`install.ps1` / `install.sh` 遇到已有 settings 时改为自动 JSON 合并 hooks。 |
| 2026-05-11 | Task 4 | README 增加 Claude Code 和 Codex 安装后验证命令。 |
| 2026-05-11 | Task 5 | 用户级 Claude Code settings 已用 merger 修复；Claude/Codex 用户态和项目态校验通过。 |

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
| 1 | 测试 | `install.sh` | 当前 Windows 环境没有可用 Bash/WSL，`bash -n install.sh` 无法作为机器校验；本次只做 diff 人工审查。 | accepted |

### 总评
修复方向正确：Claude Code 和 Codex 都有可执行的安装态 validator，且安装器不再把 hook 合并留给用户手工处理。未发现 P0/P1。

---

## 复利记录

### 提取的经验
- 安装脚本如果声明“安装完成后 hook 生效”，遇到已有 settings 时必须结构化合并 hook；只提示手动合并会产生静默失效。
- 双运行时项目要同时校验 user-level 和 project-level，不然只能证明 repo 模板正确，不能证明实际入口可用。

### 创建/更新的本能
- 更新 `.claude/rules/debugging-gotchas.md` 和 `.codex/rules/debugging-gotchas.md`：已有 settings 缺 hook 不能只警告，必须 merge + validate。
- 追加 `.codex/skill-signals/sprint.jsonl` 一条 sprint 使用信号。

### 解决方案文档
- `docs/solutions/2026-05-11-claude-settings-hook-merge.md`

### 验证记录
- `node scripts\validate-claude-install.js --project` -> pass
- `node scripts\validate-claude-install.js --user` -> pass
- `node scripts\validate-codex-install.js --project` -> pass
- `node scripts\validate-codex-install.js --user` -> pass
- `node scripts\validate-codex-plugin.js` -> pass
- `node scripts\smoke-relevance.js` -> pass
- `node scripts\smoke-memory-parity.js` -> pass
- `node plugins\tech-persistence\scripts\build-codex-plugin.js` -> pass
- `node --check scripts\validate-claude-install.js` -> pass
- `node --check scripts\merge-claude-settings-hooks.js` -> pass
- PowerShell AST parse for `install.ps1` -> pass
- `git diff --check` -> pass, with existing CRLF normalization warnings
- `bash -n install.sh` -> not run: current Windows environment lacks Bash/WSL
