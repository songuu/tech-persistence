---
name: review
description: Codex-native findings-first review with evidence, risk-based testing, and bounded parallel reviewers.
---

# Review

审查当前 diff/提交是否正确、安全、可维护且测试充分。默认只读：用户只要求 review 时不得顺手修复、提交或推送。

活动 Sprint 为 `acceptance_protocol=v1` 时，Review 必须让 Agent Harness 按冻结 Contract 生成 system-owned Receipt。任何 owned criterion 为 `failed/unknown`、Receipt stale/tampered，或 authority readback 不完整时只能回 Work/blocked；只有同一 contract hash 的 `passed` Receipt 才允许 `review → compound`。

## Review loop

1. 读取完成定义、基线、`git status` 与完整 diff，识别用户既有修改。
2. 按 correctness、security、data integrity、tests、maintainability 检查真实执行路径和边界。
3. 运行与风险匹配的定向测试；把代码失败与环境/工具失败分开。
4. findings 按严重度排序，给出文件、紧凑行号、触发条件、影响和修复方向。
5. 没有 finding 时明确说“未发现可操作问题”，同时列出剩余风险或未运行验证。

## Codex collaboration

- 先划分审查面，不要为探测而调用工具。**只有至少 2 个相互独立的审查面，且 collaboration 工具可用时**，才调用 `collaboration.list_agents` 计算可用 slot；并行数不超过独立审查面、slot 和 3，**最多 3 个 child**。
- 单一审查面、互相依赖、工具不可用或没有空闲 slot 时由当前 agent 串行审查；不得调用 `list_agents` / `spawn_agent` 增加往返。
- 仅对独立审查面调用 `collaboration.spawn_agent`，prompt 明确只读范围、风险焦点和证据格式。reviewer 位于**共享工作树**，禁止写文件或假设隔离副本。
- 用 `send_message` 澄清、`wait_agent` 汇总；工作树变化后重读 diff，主 agent 复核并去重每条 finding。

## Finding 标准

只报告会影响行为、数据、安全、性能或长期维护的具体问题。描述必须可复现；不要把风格偏好、无关旧问题或无证据猜测列为 finding。最终摘要简短，findings 优先于测试概览。
