# Agent Orchestrator v6

> **Status:** `in-progress`
> **Created:** 2026-04-27
> **Updated:** 2026-04-27

---

## 需求分析

### 要做
- 将双 Agent 串联方案升级为 v6：以外部 orchestrator 为主控制器，而不是依赖 claude/codex 在各自命令系统里理解彼此。
- 新增一个可调用命令，负责引导用户使用 v6 外部编排模式。
- 新增文件/JSON Schema 契约，明确 spec、design、tasks、handoff、review 的边界。
- 保持现有项目结构不破坏：继续以 `user-level/commands` 为命令源，生成 `plugins/tech-persistence` 和 `.codex` 镜像。

### 不做
- 不把 claude 与 codex 强绑定进 Hook 生命周期。
- 不要求当前会话实际调用两个外部 Agent 完成一次真实实现。
- 不引入 npm 依赖或数据库。
- 不删除/重排已有命令、技能、Hook 或知识目录。

### 成功标准
- [ ] v6 有独立 orchestrator 脚本，支持 run/freeze/resume/status/dry-run。
- [ ] v6 有结构化 Schema 契约，并被 orchestrator 引用。
- [ ] 新命令能在 Claude Code 和 Codex 两种入口下安装/生成。
- [ ] 插件构建、插件校验、项目 Codex 安装校验通过。
- [ ] README 和 ADR 明确 v6 是主路径，旧的命令内串联只作为人工协议。

### 风险和假设
- 假设本机可用 `claude -p` 和 `codex exec`，但 v6 必须允许 `--dry-run` 在未调用外部 Agent 时验证结构。
- 外部 CLI 输出格式可能变化，所以 orchestrator 需要用文件契约、原始日志和宽容 JSON 提取兜底。
- Codex 插件命令仍通过 skill wrapper 暴露，不能假设 TUI 支持自定义 slash command。

---

## 技术方案

### 方案概述

v6 采用中立外部 orchestrator：`scripts/agent-orchestrator.js` 负责状态机、目录、Schema、日志、冻结点、diff、validation 和 review loop。Agent 只作为 Provider 被调用：默认 spec/review provider 是 `claude -p`，implementation provider 是 `codex exec`。两个 Agent 不直接相互调用，也不依赖彼此的命令/skill 支持。

运行产物统一进入 `.agent-runs/<runId>/`，包含 `state.json`、`requirement.md`、`spec.json`、`technical-design.md`、`task-breakdown.json`、`diff.patch`、`validation.json`、`handoff.md`、`review.json` 和 prompts/logs。该目录是运行态产物，不进入 Git。

### 任务拆解

- [x] **Task 1**: 新增 v6 orchestrator 脚本与 Schema 契约 — 文件: `scripts/agent-orchestrator.js`, `schemas/agent-loop/*.json`
- [x] **Task 2**: 新增 `/agent-loop` 命令并同步 Codex command skill 镜像 — 文件: `user-level/commands/agent-loop.md`, `.codex/commands/agent-loop.md`, `.codex/skills/agent-loop/SKILL.md`
- [x] **Task 3**: 更新插件构建与校验，复制 v6 脚本/Schema 并检查清单 — 文件: `plugins/tech-persistence/scripts/build-codex-plugin.js`, `scripts/validate-codex-plugin.js`
- [x] **Task 4**: 更新安装/预检/项目校验与运行产物忽略 — 文件: `.gitignore`, `scripts/preflight.js`, `scripts/validate-codex-install.js`
- [x] **Task 5**: 更新 README、插件 README、ADR 和 solution 文档 — 文件: `README.md`, `plugins/tech-persistence/README.md`, `.codex/rules/architecture.md`, `.claude/rules/architecture.md`, `docs/solutions/2026-04-27-agent-orchestrator-v6.md`
- [ ] **Task 6**: 运行构建和验证，回填 sprint 文档 — 文件: `docs/plans/2026-04-27-agent-orchestrator-v6.md`

### 测试策略
- 单元测试: 由于仓库无测试框架，使用 `node --check` 覆盖新增/修改 JS 语法。
- 集成测试: 使用 `node scripts/agent-orchestrator.js run --dry-run` 验证 v6 状态机和文件输出；运行 Codex plugin build/validate。
- 手动验证: 检查新增命令在 plugin 和 `.codex` 镜像中存在，README 计数与脚本清单一致。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 外部 CLI 输出不是纯 JSON | 中 | review loop 中断 | 保留 raw logs，宽容提取 JSON，失败时写 diagnostic |
| 命令计数漏同步 | 中 | 安装/插件校验失败 | 清单集中更新并跑 build/validate |
| 运行态文件污染 Git | 中 | 仓库变脏 | `.agent-runs/` 写入 `.gitignore` |
| Codex 插件不能访问 repo 脚本 | 中 | 命令不可用 | 构建插件时复制 orchestrator 和 schemas |

### 涉及文件
- `.gitignore`
- `scripts/agent-orchestrator.js`
- `schemas/agent-loop/requirement-spec.schema.json`
- `schemas/agent-loop/task-breakdown.schema.json`
- `schemas/agent-loop/agent-handoff.schema.json`
- `schemas/agent-loop/review-result.schema.json`
- `user-level/commands/agent-loop.md`
- `.codex/commands/agent-loop.md`
- `.codex/skills/agent-loop/SKILL.md`
- `plugins/tech-persistence/scripts/build-codex-plugin.js`
- `scripts/validate-codex-plugin.js`
- `scripts/validate-codex-install.js`
- `scripts/preflight.js`
- `README.md`
- `plugins/tech-persistence/README.md`
- `.codex/rules/architecture.md`
- `.claude/rules/architecture.md`
- `docs/solutions/2026-04-27-agent-orchestrator-v6.md`

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-04-27 | Task 1 | 新增 `scripts/agent-orchestrator.js`，提供 run/freeze/resume/status/dry-run 状态机；新增 requirement spec、task breakdown、handoff、review result 四个 JSON Schema。 |
| 2026-04-27 | Task 2 | 新增 `/agent-loop` / `$agent-loop` 入口，明确 v6 主路径由外部 orchestrator 调 provider，不在 Agent 内部互相模拟。 |
| 2026-04-27 | Task 3 | 插件构建清单增加 `agent-loop.md`，构建产物同步 21 个 commands、26 个 skills，并复制 orchestrator 与 schemas。 |
| 2026-04-27 | Task 4 | `.agent-runs/` 加入忽略；预检更新为 21 个用户命令/26 个 Codex skills；项目安装校验支持 `--user`/`--project` 并检查 v6 资产。 |
| 2026-04-27 | Task 5 | README 增加 Agent Loop v6 主路径、命令计数和目录结构；插件 README、ADR、solution index 同步外部 orchestrator 决策。 |

---

## 审查结果

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### 总评
<!-- /review 阶段填写 -->

---

## 复利记录

### 提取的经验
<!-- /compound 阶段填写 -->

### 创建/更新的本能
<!-- /compound 阶段填写 -->

### 解决方案文档
<!-- /compound 阶段填写 -->
