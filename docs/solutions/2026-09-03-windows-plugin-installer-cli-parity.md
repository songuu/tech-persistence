---
title: "Windows 插件安装器的 CLI 能力对齐与事务恢复"
date: 2026-09-03
tags: [solution, windows, codex, claude, installer, transaction]
related_instincts: []
aliases: ["install-all.ps1 unknown option", "Codex plugin CLI parity"]
---

# Windows 插件安装器的 CLI 能力对齐与事务恢复

## Problem

Windows 执行 `powershell -ExecutionPolicy Bypass -File .\install-all.ps1 -All` 时，Claude 插件安装报 `unknown option '--yes'`，Codex 安装则因 PATH 中的旧 CLI 缺少 `plugin add/list` 命令而失败。失败后的安装事务还会停在 `rollback-failed`。

## Debug Journal

- [2026-09] [Windows/Claude] **安装器携带已移除的确认参数**
  - 现象：`claude plugin update/install` 连续报告 `unknown option '--yes'`。
  - 误导方向：最初可能被统一安装器的三个失败摘要误导为权限或 PowerShell 执行策略问题。
  - 排查路径：分别读取 `claude --version` 与 plugin 子命令 help，再单独执行子安装器。
  - 根因：Claude Code 2.1.202 的 plugin update/install 已不接受 `--yes`。
  - 解决：移除两个过期参数，并保留 update 失败后 install 的显式退出码处理。
  - 预防：安装器只传当前 help 明确支持的参数；为被移除参数增加源码级回归断言。

- [2026-09] [Windows/Codex] **PATH CLI 与 Desktop 插件 CLI 的能力面不同**
  - 现象：PATH 中 Codex 0.130 只有 marketplace 子命令，事务 probe 和 cache refresh 需要的 `plugin list/add --json` 不存在。
  - 误导方向：只检查 `codex --version` 会认为 Codex 已安装，无法证明该二进制支持插件事务协议。
  - 排查路径：分别读取 PATH CLI 与 `~/.codex/plugins/.plugin-appserver/codex.exe` 的版本和子命令 help，并用真实 list JSON 读回。
  - 根因：安装写入、事务验证和 runtime doctor 没有绑定到同一个具备完整插件能力的 CLI。
  - 解决：新增共享 `codex-plugin-cli.js` 解析器；Windows 优先 Desktop plugin-appserver CLI，保留 npm 与 PATH fallback；PowerShell 安装器、事务和 doctor 使用同一选择规则。
  - 预防：测试 CLI 的能力契约和解析优先级，而不是只测试命令名可解析。

- [2026-09] [Transaction] **原子恢复 marketplace 文件时派生控制面短暂消失**
  - 现象：历史事务已完成 plugin target 恢复，却停在 marketplace file 的 `claimed` 状态；此时 owner 与 registration 都暂时不可见。
  - 误导方向：将 `actual=null` 一律视为外部并发漂移，会使经过持久化的安全恢复无法续跑。
  - 排查路径：核对 manifest 中 operation status、target/stage/preserved 三份工件和 Codex 实时 list 结果，并构造 claim 后中断的回归样本。
  - 根因：marketplace/owner 是 `marketplace.json` 的派生状态；原子 claim 到 publish 之间目标文件按设计短暂缺失。
  - 解决：仅当 durable operation 为 `claimed`、工件状态满足 canonical claimed、registration 为 null，且消失的 owner 只属于目标 marketplace 时允许该短暂 gap；其他差异继续 fail-closed。
  - 预防：原子恢复测试必须覆盖 claim 后进程中断、前序 operation 已 complete、重启后 reconcile 三个条件。

## Root Cause

安装器把“命令存在”误当成“命令能力一致”，并把由被恢复文件派生的控制面当成独立不变量。Claude 与 Codex CLI 升级后，这两个假设同时失效。

## Solution

统一安装器的 `-All` 现在只运行现代 Codex 与 Claude plugin 安装；已废弃的 Claude legacy 投影改为显式 `-Legacy`。Claude 调用移除 `--yes`。Codex 的注册、cache refresh、事务 probe 和 runtime doctor 绑定到同一个插件 CLI。历史 `rollback-failed` manifest 通过受约束 reconcile 恢复为 `rolled-back`，随后新事务成功 committed。

真实验收结果：原始 `install-all.ps1 -All` 命令退出 0；Codex owner 为 `tech-persistence@local-plugins` 1.0.8、`ownerCount=1`、source/cache integrity valid；安装缓存包含 `codex-skills/sprint/SKILL.md`；Claude plugin `tech-persistence@tech-persistence-local` 1.0.1 enabled。

本记录引用可读回的本地事务 manifest、测试输出和插件 list 结果，但没有伪造 native-host authority EvidenceRef。候选 `plugin-installer-must-resolve-capability-compatible-cli`（strategy）与 `derived-control-plane-gap-during-atomic-restore`（anti_pattern）保持 needs-review，未提交 canonical propose。反例：没有 Desktop appserver 的 CLI-only 环境应走 npm/PATH fallback；不由目标文件派生的 owner/registration 漂移不得使用 claimed gap 豁免。

## Prevention

版本兼容测试应同时验证 help/能力、真实 JSON probe、原子恢复中断与最终安装态；安装成功必须以原始用户入口退出码、唯一 owner、source/cache hash 一致和目标 skill 可读回共同证明。

## Related

- [[2026-09-03-harness-production-qualification-boundaries]]
- [[session-2026-09-03]]
