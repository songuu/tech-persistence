---
description: "当 /sprint 执行中上下文压力过大，或任务拆分超过 5 个 Task 时加载。提供上下文重置和交接文件方法论。"
---

# 上下文交接技能

## 问题

长时间 `/sprint` 会遇到上下文窗口耗尽：
- Claude 开始忘记早期约定
- 工具调用参数出错增多
- 回答变得笼统、丢失细节
- 出现"context anxiety"——急于收工，跳过步骤

**Compaction 不够**——它压缩了历史但没有给 agent 一个"干净的大脑"。

## 解决方案：Checkpoint + 上下文重置

在 Task 之间插入 checkpoint：保存当前所有状态到一个交接文件，然后用户执行 `/compact`（或开新会话），下次 Claude 从交接文件冷启动。

```
Task 1 → Task 2 → Task 3 → ⚡ CHECKPOINT
                               ↓ 生成 handoff.md
                               ↓ 用户 /compact 或新会话
                               ↓ SessionStart 读取 handoff.md
Task 4 → Task 5 → ... → ⚡ CHECKPOINT（如果需要）
```

## Checkpoint 触发条件

### 自动触发（Claude 主动建议）
1. **Task 完成数 ≥ 5** — 每 5 个 Task 建议一次 checkpoint
2. **退化信号** — 工具参数出错、忘记约定、重复提问
3. **会话轮次 > 30** — 即使没有明显退化也预防性 checkpoint
4. **长上下文操作后** — 大量文件读取、代码生成后

### 手动触发
- 用户随时可以说 `checkpoint` 或执行 `/checkpoint`

## 交接文件格式

路径：`docs/plans/{sprint-doc-name}-handoff-{N}.md`

```yaml
---
type: sprint-handoff
sprint_doc: "docs/plans/2026-06-20-user-export.md"
checkpoint_number: 1
created: "2026-06-20T14:30:00"
phase: "work"
tags: [handoff, sprint]
---
```

```markdown
# Sprint Handoff #1: 用户导出功能

## Sprint 状态
- 文档: docs/plans/2026-06-20-user-export.md
- 当前阶段: Phase 3 (Work)
- Task 进度: 5/8 完成

## 已完成的 Task
- [x] Task 1: 创建 ExportService 类 — src/services/export.ts
- [x] Task 2: CSV 格式化工具 — src/utils/csv-formatter.ts
- [x] Task 3: 导出 API 端点 — src/api/export.ts (L3 测试通过)
- [x] Task 4: 权限中间件 — src/middleware/export-auth.ts
- [x] Task 5: 前端导出按钮 — src/components/ExportButton.tsx

## 未完成的 Task
- [ ] Task 6: 异步大文件导出（队列方案）
- [ ] Task 7: 导出进度条 WebSocket
- [ ] Task 8: 导出历史记录页面

## 关键决策（下次必须知道）
1. CSV 用 stream 方式生成，不是一次性 buffer（Task 2 决定）
2. 超过 10000 行走异步队列（Task 3 决定）
3. 权限：只有 admin 和 manager 角色可导出（Task 4 决定）

## 已修改的文件
- src/services/export.ts (新建)
- src/utils/csv-formatter.ts (新建)
- src/api/export.ts (新建)
- src/middleware/export-auth.ts (新建)
- src/components/ExportButton.tsx (新建)
- src/api/index.ts (修改：添加路由)

## 当前测试状态
- export.test.ts: 15 用例全部通过 (L3)
- csv-formatter.test.ts: 8 用例全部通过 (L2)
- export-auth.test.ts: 6 用例全部通过 (L2)

## 环境/阻塞
- 无阻塞项
- 注意：WebSocket 需要配置 CORS（Task 7 会用到）

## 下一步
继续 Task 6: 异步大文件导出。方案已在 sprint 文档中确定，用 Bull 队列。

## Related
- [[2026-06-20-user-export]] — Sprint 主文档
```

## 恢复流程

新会话开始时，SessionStart Hook 自动检测最新的 handoff 文件。
或者用户说 "继续 sprint" 时：

1. 读取最新 handoff 文件
2. 读取 sprint 主文档
3. 确认当前状态：
```
📋 从 Checkpoint #1 恢复

Sprint: 用户导出功能
进度: 5/8 Task 完成
下一步: Task 6 — 异步大文件导出（Bull 队列）

3 个关键决策已加载。继续？
```
4. 用户确认 → 继续 Task 6

## 与 Obsidian 集成

交接文件用标准 frontmatter + wikilinks：
- `tags: [handoff, sprint]` → Obsidian 中黄色节点
- `[[sprint-doc-name]]` → 链接到 sprint 主文档
- Graph View 中可以看到 sprint → handoff 的链路
