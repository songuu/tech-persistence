---
title: "Obsidian Vault 集成与 Hook Bash 兼容性修复"
date: 2026-04-09
tags: [solution, obsidian, hooks, windows, yaml, regression-tracked]
related_instincts: [windows-hook-bash, yaml-inline-arrays, obsidian-integration]
aliases:
  - "Obsidian 集成"
  - "Hook bash 兼容"
---

> [!warning] Errata 2026-05-12 — 此问题回归了
> 本文 2026-04-09 修复的 `install.ps1:63,75,87,99` cmd 语法，在后续重构（引入 `scripts/merge-claude-settings-hooks.js` + install.ps1 改写）时**再次回归**为 `2>nul || exit /b 0`，导致 Windows 上 hook 每次触发都在仓库 cwd 创建 `nul` 空文件。
> 第二次修复见 [[2026-05-12-nul-pollution-fix]]，预防经验已升级到 [[debugging-gotchas]] 「[hooks, shell-mismatch, windows]」条目并标注「已踩 2 次」。
> 教训：纯文档协议 enforcement（"以后记得用 POSIX 语法"）抵不住代码重构带来的回归；下一道防线应是**单元测试或 CI 检查**——任何安装产物生成的 hook command 必须断言不含 `2>nul` / `exit /b`。

# Obsidian Vault 集成与 Hook Bash 兼容性修复

## 问题

两个紧密耦合的问题：

1. **Hook 死循环**：tech-persistence 系统的 4 个 Hook 在 Windows 上报错形成死循环，阻塞整个 Claude Code 会话。
2. **知识孤岛**：系统产出的本能、会话摘要、解决方案散落在 `~/.claude/homunculus/` 各处，缺乏可视化浏览和关联查询能力。

## 根因

### 问题 1：Hook bash 语法错误

`install.ps1` 的 `Build-SettingsJson` 函数生成 hook command 时使用了 **Windows CMD 语法**：

```powershell
command = "node `"$hooksPath/observe.js`" pre 2>nul || exit /b 0"
```

但 Claude Code 的 hooks **在 Windows 上也通过 bash (Git Bash) 执行**，bash 不识别：
- `2>nul`（CMD 语法，bash 用 `2>/dev/null`）
- `exit /b 0`（CMD 内部命令，bash 用 `exit 0`）
- `%USERPROFILE%`（CMD 变量展开，bash 用 `$HOME`）

每次 hook 触发都报 `exit: /b: numeric argument required`，通过 Stop hook 反馈给 Claude，形成无限循环。

### 问题 2：知识管理缺失

现有系统是纯文件系统操作，没有统一的浏览入口、图谱视图或跨文件搜索能力。

## 解决方案

### Hook 修复（3 处替换）

```diff
- 2>nul → 2>/dev/null
- exit /b 0 → exit 0
- %USERPROFILE% → $HOME
```

修复位置：`install.ps1:63,75,87,99`（`Build-SettingsJson` 函数）

### Obsidian 集成架构

**选型决策**：MCPVault (bitbonsai/mcpvault) — 直接文件系统访问，不依赖 Obsidian 运行时，`npx` 零安装。

**核心组件**：

```
scripts/init-obsidian-vault.js  (新增)
  ├─ 生成 .obsidian/ 配置 (app.json, graph.json)
  ├─ 生成 _templates/ (instinct, session-summary, solution)
  ├─ 生成 Dashboard.md (Dataview 入口)
  ├─ 生成 _mcp-config-snippet.json
  └─ 安全校验: 必须在 home 目录下 (realpathSync 解决 Windows 短路径)
```

**Frontmatter 格式适配**（`scripts/evaluate-session.js`）：

```js
// 关键：使用内联 YAML 数组，而非 block 序列
tags: [instinct, debugging]          // ✅ 现有解析器兼容
// 不是：
// tags:
//   - instinct
//   - debugging                     // ❌ 解析器只会取到 meta.tags = ''
```

**YAML 注入防御**：

```js
function yamlEscape(str) {
  return '"' + str.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"') + '"';
}
// 观察数据（可能含冒号、引号、换行）必须经过转义才能进入 frontmatter
```

### Graph View 颜色分组

通过 `.obsidian/graph.json` 预配置：

| Tag | 颜色 | 含义 |
|-----|------|------|
| `#instinct` | 紫色 | 行为本能 |
| `#session` | 绿色 | 会话摘要 |
| `#solution` | 深绿 | 解决方案 |
| `#rule` | 橙色 | 规则文件 |
| `#architecture` | 红色 | 架构决策 |

> **勘误（2026-06-01）**：`#rule`/`#architecture` 配色实为空转——这两类文件在 git repo（`.claude/rules/`）而非 homunculus vault，配色永不命中。已移除，诚实化为「repo 注入层」。新增 `#memory` 蓝色。详见 `docs/plans/2026-06-01-obsidian-integration-completeness.md` 与 [[documented-claim-vs-code-reality-drift]]。

## 预防

1. **任何生成 settings.json hooks 的脚本** → command 字段必须用 bash 语法（Windows 上也是 bash）。建议在测试环境先跑一次，确保无 `exit /b` 报错。
2. **往现有 frontmatter 解析器写新字段** → 先检查解析器实现，手写解析器通常只支持内联数组。
3. **观察数据进入 YAML frontmatter** → 必须经过 `yamlEscape()` 过滤换行和引号，冒号要替换为空格（因为简易解析器用 `split(':')`）。
4. **路径参数的安全校验** → 使用 `path.resolve()` + `fs.realpathSync()` + home 目录前缀检查，防止路径遍历 + 正确处理 Windows 短路径名（`ADMINI~1`）。
5. **重大变更必须双视角审查** → 并行启动 security-reviewer + code-reviewer agent，避免单视角遗漏（本次审查发现 4 个 P0 问题，其中 2 个是 YAML 解析器盲点，单视角几乎肯定会漏）。

## Related

- [[feedback_windows_hook_bash]] — Windows Hook bash 兼容性本能
- [[feedback_yaml_inline_arrays]] — YAML 内联数组本能
- [[project_obsidian_integration]] — Obsidian 集成项目记录
- 提交记录：`c8a931a` (feat) + `46fe5ee` (docs)
