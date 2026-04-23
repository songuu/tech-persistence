# Codex 原生插件支持设计

> **Status:** `in-progress`
> **Created:** 2026-04-23
> **Updated:** 2026-04-23

---

## 需求分析

### 要做
- 新增 Codex 原生插件包 `plugins/tech-persistence/`，让当前系统可以在 Codex 中直接安装和使用。
- 保留 Claude Code 现有目录和安装方式不变，Codex 支持以新增适配层方式实现。
- Codex 侧必须完整覆盖 Claude Code 侧能力：命令、技能、Hook 自学习、本能系统、Skill 自迭代、风险自适应测试、上下文交接、Obsidian 兼容输出。
- 新增 Codex 安装脚本、预检脚本和验证脚本，保证一键安装后可被 Codex 发现。
- 文档同步更新 README 和计划文档，确保用户入口准确。

### 不做
- 不重构现有 Claude Code 运行时为通用 core，以避免破坏稳定功能。
- 不删除或迁移现有 `.claude`、`user-level`、`project-level` 结构。
- 不依赖 Codex 读取 `~/.claude` 作为主运行路径，只提供可选导入/兼容。
- 不引入外部依赖或网络安装流程，插件内容全部来自本仓库。

### 成功标准
- [ ] `plugins/tech-persistence/.codex-plugin/plugin.json` 符合 Codex manifest 结构。
- [ ] Codex 插件包含所有当前用户级命令、项目级命令和按需技能。
- [ ] Codex `hooks.json` 能注册 `SessionStart`、`PreToolUse`、`PostToolUse`、`Stop` 四类 Hook。
- [ ] Hook 脚本使用 Codex 主存储路径：`TECH_PERSISTENCE_HOME`、`CODEX_HOME/homunculus` 或 `~/.codex/homunculus`。
- [ ] 安装脚本能创建/更新 repo-local 或 home-local marketplace 配置。
- [ ] 验证脚本能检查 manifest、commands、skills、hooks、scripts 和路径引用。
- [ ] README 说明 Claude Code 与 Codex 双运行时安装和目录结构。

### 风险和假设
- Codex 插件保留 `commands/` Markdown 文件作为兼容源资产；当前 Codex CLI 的可调用入口由同名 skill wrapper 提供。
- Codex Hook 环境变量与 Claude Code Hook 环境变量可能存在差异，因此 Hook 脚本必须容错，不允许中断主流程。
- Windows Hook 需要 `.cmd` 包装器或直接使用 `node` 命令，避免 shell 差异导致 Hook 失效。
- 当前部分命令文档使用 Claude 命名和路径，需要在 Codex 插件中做文本级适配。

---

## 技术方案

### 方案概述

采用已确认的 **1A：Codex 原生插件包 + 兼容适配层**。新增 `plugins/tech-persistence/` 作为 Codex 插件根目录，包含 `.codex-plugin/plugin.json`、`commands/`、`skills/`、`hooks.json`、`hooks/`、`scripts/`、`assets/` 和 README。现有 Claude Code 分发目录继续作为源资产，Codex 插件通过转换/复制脚本生成运行时内容。

Codex 侧不直接把 `~/.claude` 当主数据目录。自学习数据写入 `~/.codex/homunculus`，并支持 `TECH_PERSISTENCE_HOME` 覆盖。为了保留历史积累，新增可选导入步骤，将 `~/.claude/homunculus` 复制到 Codex 数据目录，但导入不是运行时必需条件。

### 插件目录

```text
plugins/tech-persistence/
├── .codex-plugin/
│   └── plugin.json
├── README.md
├── commands/
├── skills/
├── hooks.json
├── hooks/
│   ├── run-hook.js
│   ├── run-hook.cmd
│   ├── inject-context.js
│   ├── observe.js
│   ├── lib/runtime-paths.js
│   └── evaluate-session.js
├── scripts/
│   ├── build-codex-plugin.js
│   └── import-claude-homunculus.js
├── codex-homunculus-template/
│   └── config.json
└── assets/
```

### 功能映射

| Claude Code 功能 | Codex 插件实现 |
|------|------|
| `~/.claude/commands/*.md` | `plugins/tech-persistence/commands/*.md` |
| `.claude/commands/*.md` 项目命令 | `commands/project-*.md` 或命令内容中的项目级说明 |
| `~/.claude/skills/*/SKILL.md` | `plugins/tech-persistence/skills/*/SKILL.md` |
| `~/.claude/settings.json` hooks | `plugins/tech-persistence/hooks.json` |
| `~/.claude/homunculus` | `~/.codex/homunculus` 或 `TECH_PERSISTENCE_HOME` |
| `install.ps1` / `install.sh` | `install-codex.ps1` / `install-codex.sh` |
| `scripts/preflight.js` | 扩展为 Claude/Codex 双运行时检测 |
| Obsidian 输出 | 路径切换后继续使用 frontmatter、wikilinks、tags |

### 命令适配

Codex 插件保留所有用户级命令：

```text
checkpoint
compound
evolve
instinct-export
instinct-import
instinct-status
learn
plan
prototype
review
review-learnings
session-summary
skill-diagnose
skill-eval
skill-improve
skill-publish
sprint
test
think
work
```

命令文件需要做以下适配：
- 将 `Claude`、`Claude Code` 运行时表述替换为 `Codex` 或中性 `agent`，除非是在解释迁移来源。
- 将 `~/.claude` 主路径替换为 Codex 存储路径。
- 将 `.claude/rules` 项目路径保留为兼容输入，但新增 `.codex/rules` 作为 Codex 项目级推荐路径。
- 保留 slash command Markdown 格式作为源资产，并生成同名 Codex skill wrapper；当前 Codex CLI 通过 `$skill` / `@` 入口调用这些工作流。

### 技能适配

Codex 插件保留 5 个按需技能：

```text
memory
continuous-learning
prototype-workflow
test-strategy
context-handoff
```

每个技能必须满足：
- `SKILL.md` frontmatter 只保留 Codex 必需的 `name` 和 `description`，避免 Claude 专属字段干扰。
- 可选新增 `agents/openai.yaml`，提升 Codex UI 中的技能展示质量。
- 技能正文中引用的脚本和路径改为 Codex 插件内相对路径或 Codex 数据目录。

### Hook 适配

Codex `hooks.json` 注册四类 Hook：

```json
{
  "hooks": {
    "SessionStart": [],
    "PreToolUse": [],
    "PostToolUse": [],
    "Stop": []
  }
}
```

Hook 脚本复用现有逻辑，但抽出路径解析：

```text
resolveHome()
  1. TECH_PERSISTENCE_HOME
  2. CODEX_HOME/homunculus
  3. ~/.codex/homunculus
  4. 兼容读取 ~/.claude/homunculus
```

Hook 输出必须保持容错：
- 读取 stdin 失败时静默退出。
- 未识别 Codex payload 时记录原始摘要，不阻断。
- SessionStart 同时输出 `hookSpecificOutput.additionalContext`，并尽量兼容 `additional_context`。
- Windows 路径通过 `run-hook.cmd` 或直接 Node 脚本包装，避免 Git Bash 依赖成为硬前提。

### 安装与 marketplace

新增安装入口：

```powershell
.\install-codex.ps1 -All
.\install-codex.ps1 -User
.\install-codex.ps1 -Project
.\install-codex.ps1 -ImportClaude
```

```bash
bash install-codex.sh --all
bash install-codex.sh --user
bash install-codex.sh --project
bash install-codex.sh --import-claude
```

安装内容：
- 将插件复制或链接到 Codex 可发现的插件目录。
- 创建/更新 `.agents/plugins/marketplace.json`，追加 `tech-persistence` entry。
- 创建 `~/.codex/homunculus` 目录结构和默认配置。
- 项目级安装创建 `.codex/commands/`、`.codex/rules/`、`.codex/plans/`、`AGENTS.md` 和 `docs/solutions/`。
- 可选导入 `~/.claude/homunculus` 历史数据。

### 验证策略

新增 `scripts/validate-codex-plugin.js`：
- 检查 `.codex-plugin/plugin.json` 必填字段和相对路径。
- 检查 commands 数量和文件名。
- 检查 skills 数量、`SKILL.md` frontmatter 和可选 `agents/openai.yaml`。
- 检查 `hooks.json` 四类 Hook 是否存在。
- 检查 Hook 脚本是否引用 `.claude` 主路径。
- 检查 README 是否包含 Codex 安装入口。

手动验证：
- 安装后重启 Codex，确认插件和技能可被发现。
- 运行一次短会话，确认 `~/.codex/homunculus/projects/{id}/observations.jsonl` 写入。
- 触发 Stop Hook，确认 session summary 和 instinct 文件生成。
- 调用 `/tech-persistence:review-learnings` 或等价命令，确认能读取 Codex 数据目录。

---

## 设计决策

### 保留 Claude Code 支持

现有 Claude Code 功能已经稳定，Codex 支持以新增插件包落地。这样可以避免两个运行时互相污染，并允许用户在 Claude Code 和 Codex 之间并行迁移。

### Codex 数据目录独立

Codex 主数据目录使用 `~/.codex/homunculus`，不是 `~/.claude/homunculus`。这样可以保证 Codex 是完整独立运行时，而不是依赖 Claude 安装结果。历史数据通过导入脚本迁移。

### 构建脚本生成插件内容

为了避免双写，`plugins/tech-persistence/scripts/build-codex-plugin.js` 从 `user-level/`、`project-level/` 和 `scripts/` 生成 Codex 插件内容。后续修改 Claude 源资产后，可以重新构建 Codex 插件。

### 文档优先

本项目规则要求功能改造必须同步文档。本设计文档是本次改造的主计划入口，后续实现计划和变更日志都应引用它。

---

## 后续实施

下一步使用 `superpowers:writing-plans` 生成实施计划，按 TDD/小步提交拆解以下任务：
- Codex 插件骨架。
- 命令和技能转换。
- Hook 路径适配。
- Codex 安装脚本。
- 验证脚本。
- README 和文档同步。
