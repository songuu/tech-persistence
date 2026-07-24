---
name: think
description: Codex-native product framing for scope, user value, and observable success criteria.
---

# Think

在写代码或展开实现方案前，收敛“为什么做、做什么、不做什么、怎样算完成”。本 skill 只负责产品边界，不预加载 Plan、Work 或后续规则。

## 路由

- 需求已清楚且任务很小：给出简短范围与完成条件，可直接交给 Work。
- 常规需求：确认用户价值、范围、成功标准、风险与假设，然后交给 Plan。
- 输入边界、失败模式、空状态或不可逆影响未定义：只询问会实质改变结果的关键问题；其余用显式、可撤销的假设继续。
- `--clarify`：系统化检查输入边界、失败模式和空状态。
- `--auto`：仅在无开放产品决策且无不可逆外部影响时自动进入 Plan。

## 输出

保持紧凑：

1. **要做 / 不做**
2. **可观察的成功标准**（通常 3–5 条；L3/L4 使用 `WHEN ... THE SYSTEM SHALL ...`）
3. **风险、假设与待确认项**
4. **下一步**：Work 或 Plan

不要强制扫描历史计划、rules、memory 或 homunculus。只有当前问题确实依赖既有决策时才读取对应的最小文件。不要仅因调用 Think 就创建或修改文档；用户要求持久化、Sprint 已有活动计划，或后续阶段确需共享工件时，才写入明确路径并报告。
