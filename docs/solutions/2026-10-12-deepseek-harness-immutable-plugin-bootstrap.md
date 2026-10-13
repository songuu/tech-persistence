---
title: "DeepSeek Harness 的不可变 Codex 插件引导边界"
date: 2026-10-12
tags: [solution, harness, deepseek, codex, plugin, security, bwrap]
related_instincts: []
aliases: ["Harness immutable plugin bootstrap", "DeepSeek managed command skill runtime"]
---

# DeepSeek Harness 的不可变 Codex 插件引导边界

## Problem

DeepSeek 作为 Harness 的模型后端时，真正持有文件和命令能力的仍是 Codex CLI tool host。隔离的 task-local provider home 默认没有 Tech Persistence plugin，因此 `/command` 与 `$skill` 即使能被模型理解，也不能被可靠发现和执行。若在模型所在的 sandbox 内临时安装 plugin，模型又能改写 hooks、MCP、skills、配置或验收 receipt，形成同一主体自装、自验的闭环。

## Root Cause

最初设计把“模型启动前建立可信执行环境”和“模型运行时使用该环境”放进了同一个可写边界，并把安装前的 source hash、安装成功退出码或事后 receipt 当成充分证明。它们都不能证明模型运行期间 installed tree 与执行控制面保持不变。

另一个边界问题是 command/skill 只作为自然语言进入 spec/review：只要外部模型能够改名、吞掉参数或选择另一个 skill，authority 就没有真正拥有调用目标。

## Solution

1. 建立单一 managed inventory owner，分别声明 command、base skill 和 Codex skill union，并生成稳定 SHA。Claude/Codex projection、Harness parser、bootstrap 和 validator 共同消费该来源，拒绝 missing、extra、重名和 hash 漂移。
2. 仅解析第一个有效顶层 `/command` 或 `$skill`，兼容显式 `tech-persistence:` 命名空间，并统一规范化为 `$tech-persistence:<name> <args>`。未知名称、路径逃逸、控制字符和 managed 输入超限在 provider dispatch 前失败；普通自然语言保持原路径。
3. 在模型启动前运行独立 setup bwrap：无网络、无 workspace、stdin 断开，从 root-owned immutable `/runtime` 通过真实 Codex plugin CLI 安装本地 marketplace/plugin，并以结构化 `plugin list --json` 核对唯一 owner 和完整 inventory。
4. bootstrap receipt 同时绑定 source tree SHA、installed tree SHA、inventory SHA 和相对 installed root。主模型 bwrap 对 plugin tree、`config.toml`、内部 receipt 和公开 receipt 做只读子挂载；resume 前清除 direct `skills`、`agents`、`AGENTS.md`、`hooks.json` 等执行控制面残留，但保留 session 数据。
5. worker 在 dispatch 前生成只读 managed-invocation metadata；orchestrator 重新核验 metadata 与当前 inventory，并把精确 canonical invocation 冻结进 spec、implementation prompt 和 run evidence。外部 DeepSeek spec/review 仍然只读，Codex 继续作为唯一 writer/tool host。
6. qualification 在模型退出后使用独立 `verify` 模式重新计算 installed inventory、source/install tree SHA 并核对 receipt；部署入口还必须对目标 Codex 版本的 plugin 子命令和必需 exec flag 做 capability preflight，缺失时失败闭合。

## Debug Journal

- [2026-10] [security] **模型 sandbox 内安装 plugin 不能构成可信 bootstrap**
  - 现象：初版可以安装并读回完整 plugin，但 plugin、配置和 receipt 都位于模型可写的 provider home。
  - 风险：同一 provider 可在执行期间篡改 hooks/MCP/skills，或在结束前重写 receipt，使预检和事后证据失去独立性；resume 还可能复用 direct skill 注入残留。
  - 修复：把安装移到独立 setup bwrap；主 bwrap 使用只读子挂载；qualification 独立重算；resume 重置全部直接执行控制面。
  - 证据：篡改 receipt、篡改 installed tree、只读挂载契约和 resume 清理负向测试通过；真实本地 Codex 0.162.1 完成 bootstrap、公开 receipt 与独立 verify。

## Prevention

- 安装成功、文件存在或预检 hash 只证明一个时点；模型可接触的执行控制面必须在运行期只读，并在运行后由独立主体复验。
- plugin 的 source、installed tree、owner/readback 和 inventory 必须绑定同一 receipt，不能使用字符串包含或手写私有 cache 代替真实 CLI 读回。
- managed invocation 的目标和参数属于 authority metadata，不允许只靠 prompt 让模型自行解释。
- resume 必须同时处理 session 连续性和执行控制面清洁度；保留 session 不等于保留可执行配置。
- 本地 Codex 0.162.1 通过不代表生产固定 Codex 0.152.1、Linux bwrap 或真实 DeepSeek 已通过；这些必须由部署 capability gate 与 live qualification 单独证明。

## Related

- [[2026-09-01-provider-os-identity-boundary]]
- [[2026-09-02-harness-wiring-evidence-boundaries]]
- [[2026-09-03-harness-production-qualification-boundaries]]
- [[2026-09-03-windows-plugin-installer-cli-parity]]
- [[2026-10-12-deepseek-harness-command-skill-parity]]
