---
name: work
description: Codex-native implementation workflow using TDD, risk-scaled verification, and shared-workspace collaboration.
---

# Work

按已确认的任务边界实施并验证。优先读取当前任务、相关源文件和现有测试；不重新做产品范围决策。

活动 Sprint 为 `acceptance_protocol=v1` 时，Work 开始前必须读回 `<plan>.acceptance.json` 并核对当前计划 acceptance marker 与 frozen Contract；不得自行改 criterion、Oracle、contract hash 或用 agent 自报替代 authority evidence。

## 单任务循环

1. 明确可观察完成条件、涉及文件和风险等级。
2. Bug 或核心行为先建立失败测试/最小反馈环，再改实现。
3. 做满足目标的最小改动，显式处理错误并保留上下文。
4. 先跑最窄定向测试；通过后按风险扩到类型检查、lint、构建或更广回归。
5. 检查 diff、证据、用户脏文件与范围漂移，再标记完成。

测试深度：L0 纯文案可免测；L1 冒烟；L2 标准单元/集成；L3 核心逻辑严格回归；L4 认证、支付或数据安全需全面验证与人工 gate。失败最多连续修复三轮；根因仍不明时保留证据并报告阻塞。

## Codex collaboration

- 先识别任务依赖，不要为探测而调用工具。**只有至少 2 个相互独立、文件集合不相交的任务，且 collaboration 工具可用时**，才调用 `collaboration.list_agents` 判断可用 slot；并行数取独立任务数、slot 与 3 的最小值，**最多 3 个 child**。
- 单任务、强依赖、写同一文件、工具不可用或没有空闲 slot 时留在当前 agent 串行处理；不得调用 `list_agents` / `spawn_agent` 增加往返。
- 仅对边界清晰的独立任务调用 `collaboration.spawn_agent`。所有 agent 使用**共享工作树**；为 child 指定唯一文件 owner，禁止提交或覆盖他人改动。
- 用 `send_message` 补充上下文、`wait_agent` 收集结果；主 agent 必须审查真实 diff、组合测试和冲突。child 报告只是输入，不是验证事实。

## 交付

输出完成项、修改文件、实际命令与结果；分开已验证事实、推断、未知项和环境阻塞。不要把进程启动、部分测试或 agent 自报成功折叠为整体完成。
