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

## Architectural shadow pilot

Think 明确路由为 `architectural-like`，或 Plan 研究发现同等 architectural 信号时，才启用 shadow design-authority；probe/bounded 路径不得为此增加文档税。在当前计划文件中写入一次：

```markdown
<!-- design-authority:start -->
## Design Authority（shadow）
- 问题与用户价值：...
- 范围 / 非目标：...
- 备选方案、选择与理由：...
- 组件、消费者接口、状态与错误路径：...
- Acceptance Criteria：
  - AC-1: WHEN ... THE SYSTEM SHALL ...
<!-- design-authority:end -->
```

该区块是 acceptance criterion 的唯一语义 owner；实施任务只引用 `AC-*`，不复制或改写 statement。计划确认后按约定冻结，修改时显式记录 revision 并重新检查任务，不静默改变设计。提交计划前 inline 检查四项：`placeholder`、内部一致性、`scope`、歧义。

若活动 Sprint 使用 `acceptance_protocol=v1`，acceptance checklist 只是 statement 的精确 transport projection，不成为第二语义 owner；shadow 阶段仍不自动校验 AC ID 映射。

这是可回滚的同文件 shadow pilot：不计算 design-authority digest/hash，也不接入 lineage runtime 或 Work/Review gate，不创建独立 spec 文件。当前用户指令、系统/项目规则和权限边界始终优先。

活动 Sprint 为 `acceptance_protocol=v1` 时，成功标准必须写在唯一的 `<!-- acceptance-contract:start -->` / `<!-- acceptance-contract:end -->` checklist 区块；该协议字段本身不选择 Harness，也不授权把计划发送给外部 provider。

只有用户为**当前 Sprint**显式选择 Harness Acceptance 时，才在 Plan 验收后让 Harness freeze 同一组 criterion，再运行 `bind-acceptance`；`--auto`、需求中的 Harness/Transcript/provider 品牌词、已安装 adapter 或历史偏好都不算显式选择。未选择或尚未成功绑定时，由当前宿主按计划验收并直接进入 Work，不得启动 Harness、要求外发授权或因 Claude/Codex/其他 provider 不可用而阻塞。显式绑定成功后保持失败闭合，绑定或 authority readback 失败不得进入 Work。

## 输出

1. 方案概述与关键取舍。
2. 有序任务清单和依赖。
3. 测试策略：最窄反馈环到风险匹配的回归范围。
4. 风险、回滚/恢复方式、未知项。
5. 涉及文件与下一可执行动作。

不要强制预热下一 Phase，不要仅因调用 Plan 就持久化。用户要求、Sprint 已有活动计划、`architectural-like` 需要 shadow authority，或执行需要跨 agent/会话共享时，才更新明确的计划文件和活动指针；写入后进行读回验证。
