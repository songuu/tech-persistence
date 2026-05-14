# [功能标题]

> **Status:** `draft` | `planning` | `in-progress` | `reviewing` | `completed`
> **Created:** YYYY-MM-DD
> **Updated:** YYYY-MM-DD

---

## 需求分析

<!-- /think 阶段填写。未执行 /think 时由 /plan 简要填写。 -->

### 要做
- ...

### 不做
- ...

### 成功标准
- [ ] ...

### 风险和假设
- ...

---

## 技术方案

<!-- /plan 阶段填写 -->

### 方案概述
<!-- 1-2 段描述整体技术方案 -->

### 契约接口（条件性 — 触发条件见下）

> **触发条件**（任一即必填）：
> - 变更 `scripts/lib/hook-registry.js` 等 multi-runtime hook projection 契约
> - 变更 `scripts/agent-orchestrator/schemas/*.json` 等 spec-implementation-review 契约
> - 变更 `scripts/propagate-*.js` 或类似 SoT-projection transform 函数
> - 变更任何 git tracked 派生文件的 transform 规则
>
> 未触发时本段可省略。

| 契约名 | Before | After | 影响副本 / 消费者 |
|--------|--------|-------|------------------|
| (例) hook-registry projection | `{claude: [SessionStart, Stop], codex: [..]}` | `{claude: [SessionStart, UserPromptSubmit, Stop], codex: [..]}` | `install.ps1`, `install.sh`, `build-codex-plugin.js`, `validate-claude-install.js` |

### 任务拆解

> 标记 `[P]` 表示可并行：(a) 不与其他 [P] task 改相同文件 (b) 无未完成依赖 (c) 风险 ≤ L2。
> `/work` 阶段可优先连续处理同一批 [P] task；每个 task 仍单独完成风险评估、测试和勾选。其他 task 顺序处理。
> 真正多进程并发请用 `agent-loop --pipeline`，不要把 `[P]` 升级成轻量 orchestrator。

- [ ] **Task 1 [P]**: [描述] — 文件: `path/a.md` — 风险: L?
- [ ] **Task 2 [P]**: [描述] — 文件: `path/b.md` — 风险: L?
- [ ] **Task 3**: [描述] — 依赖 Task 1+2 — 风险: L?

### 测试策略
- 单元测试: ...
- 集成测试: ...
- 手动验证: ...

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|

### 涉及文件
<!-- 列出会新建/修改的文件清单 -->

---

## 实现进度

<!-- /work 阶段更新。每完成一个 Task 勾选上方任务拆解中的 checkbox，并在此追加变更日志。 -->

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|

---

## 审查结果

<!-- /review 阶段填写 -->

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### 总评
<!-- 1-2 句总结 -->

---

## 复利记录

<!-- /compound 阶段填写 -->

### 提取的经验
- ...

### 创建/更新的本能
- ...

### 解决方案文档
- ...
