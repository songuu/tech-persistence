---
name: plan
description: Codex-native risk-scaled architecture and implementation planning with explicit dependencies and verification.
---

# Plan

把已确认的需求转换为可执行计划。先读取用户给出的需求、活动 Sprint 指针或明确计划文件；只研究影响方案的源码、测试和约定，不扫描全部历史、rules、memory 或 homunculus。

## 规划深度

- 可逆的小改动：文件边界、短任务清单、最窄验证。
- 常规开发：方案、依赖有序的任务、风险等级、测试策略。
- 数据迁移、认证、支付、删除、发布等不可逆或高风险动作：比较备选方案，给出回滚/恢复边界和显式 gate。

## 计划契约

每个任务写明：目标、文件集合、前置依赖、风险 L0–L4、完成证据。只有文件集合不相交、无未完成依赖且风险不高于 L2 时才标 `[P]`；共享工作树中的同文件修改必须串行。

涉及多 runtime projection、schema、生成器或 tracked 派生文件时，增加 before/after 契约表，并列出所有消费者和一致性测试。

活动 Sprint 为 `acceptance_protocol=v1` 时，成功标准必须写在唯一的 `<!-- acceptance-contract:start -->` / `<!-- acceptance-contract:end -->` checklist 区块。Plan 验收后先由 Agent Harness freeze 同一组 criterion，再运行 `bind-acceptance`；绑定或 authority readback 失败不得进入 Work。

## 输出

1. 方案概述与关键取舍。
2. 有序任务清单和依赖。
3. 测试策略：最窄反馈环到风险匹配的回归范围。
4. 风险、回滚/恢复方式、未知项。
5. 涉及文件与下一可执行动作。

不要强制预热下一 Phase，不要仅因调用 Plan 就持久化。用户要求、Sprint 已有活动计划或执行需要跨 agent/会话共享时，才更新明确的计划文件和活动指针；写入后进行读回验证。
