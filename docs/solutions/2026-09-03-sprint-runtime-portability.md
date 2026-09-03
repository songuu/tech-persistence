---
title: "Sprint 运行时不能绑定固定 Provider"
date: 2026-09-03
tags: [solution, sprint, runtime, provider, harness, architecture]
related_instincts: []
aliases: ["Sprint runtime portability", "current-host Sprint"]
---

# Sprint 运行时不能绑定固定 Provider

## Problem

`/sprint` 在当前宿主本可继续执行时，因为另一个可选 provider（例如 Claude Code）的安装、登录或 OAuth 状态异常而停在 Plan，并要求用户登录该固定品牌。实际环境可能只有 Codex、只有 Claude Code、两者都没有但存在其他可执行框架，或根本没有可用执行宿主。

## Debug Journal

- [2026-09] [Sprint/Runtime] **可选 provider 的前置条件错误阻断当前宿主工作流**
  - 现象：Sprint 已完成 Plan，但非当前执行宿主的 Claude OAuth 过期后，整个 Sprint 被暂停并要求重新登录 Claude Code。
  - 误导方向：把 Harness、Transcript 或 provider 品牌名出现在需求中，理解为必须切换到 `/agent-loop`，并进一步把默认 Spec、Work、Review 角色绑定到 Claude/Codex 组合。
  - 排查路径：对照 `/sprint` 的默认 `--runtime current`、`/agent-loop` 的显式入口、provider profile 与 native execution 的 effect/fallback 约束，检查命令源、Codex 原生 skill、插件投影及 README 是否表达同一运行时契约。
  - 根因：方法层 `/sprint` 与可选执行后端 `/agent-loop` 的边界没有被明确写入契约；provider 品牌被误当成阶段能力，导致非当前 provider 的安装或认证状态成为全局前置条件。
  - 解决：明确 `/sprint --runtime current` 始终由当前有能力的宿主执行；`both` 仅保留为兼容入口并在没有显式编排请求时回退到 current；只有用户显式选择 `/agent-loop` 时才检查其 provider；无可用宿主时仅按缺失能力阻断当前阶段。任何 fallback 只能发生在副作用前，已产生部分或已提交副作用后不得切换写入者。
  - 预防：新增运行时矩阵回归测试，并以 ADR-041 固化“能力而非品牌”原则；canonical skill、reference、项目 fallback 与插件投影必须同步验证。

## Root Cause

运行时选择同时混入了方法、能力和品牌三个层次：Sprint 是宿主无关的方法状态机，`agent-loop` 是显式选择的可选后端，而 Claude/Codex 只是具体 provider。旧表达没有区分这三层，因此一个无关 provider 的 OAuth 状态能够错误地阻塞当前宿主。

## Solution

新的契约以当前宿主能力为默认事实来源：只有 Codex 时由 Codex 继续，只有 Claude Code 时由 Claude Code 继续，两者都没有但当前框架具备所需能力时仍继续；仅当当前阶段没有任何可执行能力时，才报告通用的能力缺口。需求中提及 Harness、Transcript 或 provider 名称不会自动选择 `/agent-loop`。

`/agent-loop` 保持为显式的专用执行后端。它可以拥有自己的 provider preflight，但该 preflight 的失败不再污染默认 Sprint。为避免双写或责任漂移，provider fallback 继续受 effect boundary 约束：副作用前可选择其他合格候选，部分或已提交副作用后只能由原写入者恢复或对账。

本地可读证据覆盖命令源、生成投影和回归测试，但没有伪造 native-host authority EvidenceRef。受治理候选草案仅保留为 `needs-review`：`workflow-host-must-not-inherit-optional-provider-preconditions`（anti_pattern）和 `provider-brand-is-not-stage-capability`（strategy）。反例包括用户显式调用 `/agent-loop` 时其配置 provider 可以合法成为前置条件，以及缺少独立审查身份时 Review Oracle 仍可能保持 unknown；因此本次不提交 canonical propose。

## Prevention

- 运行时错误必须描述缺失的能力，不得默认要求登录某个固定品牌。
- 方法层不得因需求文本提到 Harness、Transcript 或 provider 名称而隐式切换执行后端。
- canonical skill 的热路径保持精简，详细决策矩阵放入按需 reference，并由投影边界测试覆盖。
- 所有写入者切换继续服从副作用边界；运行时可移植性不降低恢复和对账安全性。

## Related

- [[2026-08-27-agent-harness-requirement-alignment]]
- [[2026-04-28-agent-loop-v6-provider-adapter]]
- [[2026-09-03-harness-production-qualification-boundaries]]
