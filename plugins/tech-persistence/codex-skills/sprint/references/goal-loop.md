# Goal loop

仅当用户明确要求创建/继续 Codex goal 或要求持续推进到终态时读取。

- 先用 `get_goal` 检查现有状态。只有用户明确要求新 goal 时才用 `create_goal`；仅在用户明确给出 token budget 时传预算。
- 每轮从 active pointer 的当前 Phase 与 `next` 继续，不预热未来 Phase，也不扩大原任务授权范围。
- 遇到失败先尝试安全、任务内的替代路径并记录证据。只有达到平台规定的重复阻塞门槛时才用 `update_goal(status: "blocked")`。
- 目标和所有必需验证真正完成后才标记 `complete`；预算接近耗尽不是完成条件。
