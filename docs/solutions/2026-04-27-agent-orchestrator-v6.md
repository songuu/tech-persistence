---
title: "Agent Orchestrator v6"
date: 2026-04-27
tags: [solution, architecture, agent-loop, codex, claude]
related:
  - ../plans/2026-04-27-agent-orchestrator-v6.md
---

# Agent Orchestrator v6

## 问题

直接用 claude 或 codex 的命令/skill 串联彼此，看起来流程简单，但主控制权仍在某个 Agent 的上下文里。两个运行时对彼此的命令、权限、输出协议和恢复语义支持都不强，遇到失败时很难稳定判断下一步应该重试、冻结、回滚还是交给人 review。

## 解决方案

采用外部 orchestrator 作为 v6 主路径：

- `scripts/agent-orchestrator.js` 管理 run/freeze/resume/status 状态机。
- `schemas/agent-loop/*.json` 定义 requirement spec、task breakdown、handoff、review result。
- `.agent-runs/<runId>/` 保存 requirement、spec、design、tasks、diff、validation、handoff、review 和 follow-up task。
- `/agent-loop` 与 `$agent-loop` 只是入口，实际控制权在 orchestrator。

默认 provider 分工：

- `claude -p`: 需求分析、技术设计、任务拆解、最终复审。
- `codex exec`: 只按冻结 spec 实现代码并产出 handoff。
- Human review: 在 implementation 前显式 freeze spec。

## 为什么有效

外部进程能统一收集 exit code、stdout/stderr、diff、validation 和文件产物；JSON Schema 把 Agent 输出变成可检查契约；freeze 点把“需求解释”和“代码实现”分离，避免实现阶段重新解释需求。

## 防回归

- 新命令必须从 `user-level/commands` 进入，再通过插件构建生成 `plugins/tech-persistence`。
- 新增 command 后同步 `scripts/preflight.js`、`scripts/validate-codex-plugin.js` 和 `.codex` 项目镜像。
- 运行态目录必须写入 `.agent-runs/`，并由 `.gitignore` 忽略。

## 相关文件

- [[2026-04-27-agent-orchestrator-v6]]
- `scripts/agent-orchestrator.js`
- `schemas/agent-loop/requirement-spec.schema.json`
- `user-level/commands/agent-loop.md`
- `.codex/rules/architecture.md`
