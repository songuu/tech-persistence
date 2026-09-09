---
name: think
description: Codex-native product framing for scope, user value, and observable success criteria.
---

# Think

在写代码或展开实现方案前，收敛“为什么做、做什么、不做什么、怎样算完成”。本 skill 只负责产品边界，不预加载 Plan、Work 或后续规则。

## Artifact 路由

先按设计复杂度选择路径；标签用于行为约束，不是要暴露的新命令：

- `probe-like`：目标只是回答可行性或消除一个未知。试验代码保持 throwaway，不写 spec/plan；若要保留或进入生产，必须重新分类。
- `bounded-like`：设计歧义低、消费者接口封闭、耦合与影响半径小且容易回滚。给出 chat 内短设计和成功标准后可直接交给 Work，不强制持久化。
- `architectural-like`：新系统/子系统、重组组件关系、改变消费者接口，或仍有开放设计决策。先收敛产品边界，再交给 Plan 在同一计划内建立 shadow design authority。

已有可读 flow 是 `bounded-like` 的强证据，但不是必要条件。判断同时考虑设计歧义、消费者接口、跨组件耦合、可逆性和影响半径。发现隐藏复杂度时只能升级路径，不能静默降级；`probe-like` 的 throwaway 产物只有重新分类后才能保留。

Artifact 路由与人工 gate 分开：只有开放产品决策、不可逆影响、外部副作用或权限边界需要停等；`architectural-like` 标签本身不强制批准。

活动 `/sprint` 保持 `think -> plan` 状态边：路由只缩放 Plan 深度和附加工件，不能跨 phase 直达 Work；只有独立调用 Think 时，`bounded-like` 才可直接交给 Work，`probe-like` 才可只返回答案。

- 输入边界、失败模式或空状态未定义：只询问会实质改变结果的关键问题；其余用显式、可撤销的假设继续。
- `--clarify`：系统化检查输入边界、失败模式和空状态。
- `--auto`：仅在没有上述人工 gate 时自动进入所选的 Work 或 Plan 路径。

## 输出

保持紧凑：

1. **要做 / 不做**
2. **可观察的成功标准**（通常 3–5 条；L3/L4 使用 `WHEN ... THE SYSTEM SHALL ...`）
3. **风险、假设与待确认项**
4. **路由与下一步**：route 必须原样使用 `probe-like`、`bounded-like`、`architectural-like` 之一；同时给出判定理由，以及答案、Work 或 Plan 下一步

`/sprint` bootstrap 优先：非 resume 的 missing-pointer 必须先建 plan、`init` 并读回，不能用本条跳过启动。除此以外，不要强制扫描历史计划、rules、memory 或 homunculus。`probe-like` 与 `bounded-like` 不因独立调用 Think 创建文档；只有用户要求、Sprint 已有活动计划、`architectural-like` 需要共享 design authority，或后续阶段确需共享工件时，才写入明确路径并报告。
