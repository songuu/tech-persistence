# 工作流命令文档持久化改造

> **Status:** `completed`
> **Created:** 2026-04-09
> **Updated:** 2026-04-09

---

## 需求分析

当前的 5 个工作流命令（think/plan/work/review/compound）的产出只停留在对话上下文或临时文件中，没有转化为项目级的正式文档。结果是：做过什么决策、为什么做，无处可查；计划执行到一半，文档和实际状态不一致；下一次会话无法快速了解当前进展。

### 要做

- 修改工作流命令（think/plan/work/review/compound/sprint），使其在执行过程中直接在项目 `docs/plans/` 下生成和更新正式文档
- 定义项目文档结构：每个功能/需求对应一个文档（**一个 feature 一个 doc**，不是每阶段一个文件），包含需求分析、技术方案、实现进度、审查结果、复利记录
- 文档同步机制：/work 更新进度、/review 追加审查结果、/compound 标记完成
- 参考 superpowers 的文件命名规范 `YYYY-MM-DD-<feature-slug>.md`

### 不做

- 不改 Hook 脚本（scripts/*.js）
- 不改本能系统的存储结构
- 不做文档自动归档
- 不维护 INDEX.md — 文件名本身就是索引

### 成功标准

- [x] 执行 /think 后，`docs/plans/` 下出现对应的项目文档
- [x] 执行 /plan 后，文档的「技术方案」章节被填充
- [x] 执行 /work 时，文档中的任务 checkbox 被同步勾选
- [x] 执行 /review 后，审查结果写入文档
- [x] 执行 /compound 后，文档状态更新为 completed
- [x] 文档始终反映最新状态，新会话能直接读文档了解进展

### 风险和假设

- 这些命令是 prompt 指令（user-commands/），不是可执行代码 — 只能通过 CRITICAL 级别的明确指令来确保 Claude 持久化文档
- 假设用户会按 think→plan→work→review→compound 顺序使用工作流
- 假设 `docs/plans/` 目录存在（首次运行时需要创建）

---

## 技术方案

### 方案概述

参考 superpowers 的 writing-plans skill 的做法：**每个功能对应一个文档**，而非每个阶段一个文件。文档在 Phase 1（/think）创建，后续阶段往同一文档的不同章节追加内容。文件名用 `YYYY-MM-DD-<slug>.md` 格式。

在 6 个命令文件中各加一节「持久化到项目文档」，标记为 CRITICAL，包含 MUST 级别的指令，明确说明：
1. 如何决定文档文件名
2. 需要更新哪些章节
3. 需要更新的 Status 和 Updated 日期

文档生命周期：

```text
/think   → 创建文档 + 填写「需求分析」    → status: draft
/plan    → 填写「技术方案」「任务拆解」    → status: planning
/work    → 勾选任务 + 追加变更日志        → status: in-progress
/review  → 填写「审查结果」              → status: reviewing
/compound → 填写「复利记录」             → status: completed
```

### 任务拆解

- [x] **Task 1**: 创建文档模板 — 文件: `docs/plans/TEMPLATE.md`
- [x] **Task 2**: 修改 `/think` 命令 — 文件: `user-commands/think.md`，增加第 4 步「持久化到项目文档」
- [x] **Task 3**: 修改 `/plan` 命令 — 文件: `user-commands/plan.md`，查找已有文档或创建新文档
- [x] **Task 4**: 修改 `/work` 命令 — 文件: `user-commands/work.md`，每个 Task 完成后同步更新文档
- [x] **Task 5**: 修改 `/review` 命令 — 文件: `user-commands/review.md`，审查结果写入文档
- [x] **Task 6**: 修改 `/compound` 命令 — 文件: `user-commands/compound.md`，新增第六步「更新项目文档」
- [x] **Task 7**: 修改 `/sprint` 命令 — 文件: `user-commands/sprint.md`，增加「项目文档贯穿全流程」节
- [x] **Task 8**: 更新 README.md 反映新工作流
- [x] **Task 9**: 在 CLAUDE.md 增加「功能变更必须同步更新文档」规则
- [x] **Task 10**: ~~新增 `upgrade-v3.2.ps1` / `upgrade-v3.2.sh` 升级脚本~~（已被 Task 12 通用化替代）
- [x] **Task 11**: 更新 README.md 安装章节，增加 v3.2 升级步骤说明
- [x] **Task 12**: 重构为通用 `update.sh` / `update.ps1` 脚本 — 默认升最新，支持 `v3.2`/`v3.1`/`v3`/`list`/`help` 参数，删除旧的 `upgrade-v3.ps1` 和 `upgrade-v3.2.*` 脚本
- [x] **Task 13**: 更新 README.md 安装章节，用 `update.sh` 替换所有 `upgrade-*` 脚本

### 测试策略

- **手动验证**: 在新会话中执行 `/sprint test-feature`，检查 `docs/plans/` 下是否生成文档，状态是否按阶段流转
- **模板完整性**: 对照 TEMPLATE.md 检查每个命令填写的章节是否完整
- **向后兼容**: 旧的 `.claude/plans/` 目录保留，不破坏现有使用习惯

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Claude 不严格执行 CRITICAL 指令 | 中 | 高 | 用 MUST/CRITICAL 强调，每个命令都有独立的持久化步骤 |
| 小任务使用 /compound 时没有对应文档 | 中 | 低 | /compound 第六步明确「如果没有对应文档，跳过此步」 |
| 文档模板过于僵化 | 低 | 中 | 模板各章节可留空，小任务可跳过非必要区块 |

### 涉及文件

- 新建：`docs/plans/TEMPLATE.md`, `docs/plans/2026-04-09-docs-plan-persistence.md`
- 新建：`update.ps1`, `update.sh`（通用升级脚本：默认最新，支持版本参数）
- 删除：`upgrade-v3.ps1`（被 `update.ps1` 的 v3 分支取代）
- 修改：6 个 user-commands（think/plan/work/review/compound/sprint）
- 修改：`README.md`（反映新工作流和产出文件路径、新增 update 升级说明）
- 修改：`CLAUDE.md`（新增文档同步规则）

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-04-09 | Task 1 | 创建 `docs/plans/TEMPLATE.md`，定义 5 大章节结构 |
| 2026-04-09 | Task 2 | `user-commands/think.md` 增加第 4 步「持久化到项目文档」(CRITICAL) |
| 2026-04-09 | Task 3 | `user-commands/plan.md` 增加第 4 步：查找已有文档或创建新文档，填写技术方案 |
| 2026-04-09 | Task 4 | `user-commands/work.md` 增加「同步更新项目文档」步骤：勾选 checkbox + 变更日志 |
| 2026-04-09 | Task 5 | `user-commands/review.md` 增加「写入项目文档」步骤：P0/P1/P2 表格 + 总评 |
| 2026-04-09 | Task 6 | `user-commands/compound.md` 增加第六步「更新项目文档」，标记 completed |
| 2026-04-09 | Task 7 | `user-commands/sprint.md` 顶部增加「项目文档贯穿全流程」节 |
| 2026-04-09 | Task 8 | 更新 `README.md`：修正产出文件流图、目录结构、命令速查表 |
| 2026-04-09 | Task 9 | 更新 `CLAUDE.md`：新增「功能变更必须同步更新文档」规则 |
| 2026-04-09 | Task 10 | 新增 `upgrade-v3.2.ps1` 和 `upgrade-v3.2.sh`：一键同步最新命令到 ~/.claude/commands/，初始化 docs/plans/ + 复制 TEMPLATE.md |
| 2026-04-09 | Task 11 | 更新 `README.md` 安装章节：增加 v3.2 升级命令和增量升级说明 |
| 2026-04-09 | Task 12 | 重构为通用 `update.sh` / `update.ps1`：默认升级到最新版，支持 `v3.2`/`v3.1`/`v3`/`list`/`help` 参数；每个版本对应独立升级函数，分发器负责路由；删除 `upgrade-v3.ps1`、`upgrade-v3.2.ps1`、`upgrade-v3.2.sh` |
| 2026-04-09 | Task 13 | 更新 `README.md` 安装章节：用 `update.sh` 替换所有 `upgrade-*` 脚本，增加 list/help/版本参数的用法示例 |

---

## 审查结果

### P0 — 必须修复

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| — | — | — | 无 | — |

### P1 — 建议修复

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| — | — | — | 无 | — |

### P2 — 可选优化

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | 质量 | user-commands/compound.md | Lint 警告：markdown 表格对齐 | 不修 — prompt 文件非生产代码 |

### 总评

变更一致性好：6 个命令文件都新增了「持久化到项目文档」CRITICAL 步骤，文档生命周期 `draft → planning → in-progress → reviewing → completed` 在各命令间严格串联。新增 `docs/plans/TEMPLATE.md` 作为标准模板。**可以发布**。

---

## 复利记录

### 提取的经验

- **文档持久化模式**：对于 prompt 驱动的工作流，只能通过 CRITICAL/MUST 级别的明确指令来强制持久化。每个命令的持久化步骤必须独立存在，不能依赖上下文推断
- **一文档一功能**：参考 superpowers 的做法，`YYYY-MM-DD-<slug>.md` 单文件多章节优于每阶段一文件，避免文件碎片化
- **文件名即索引**：按日期前缀排序后，文件列表本身就是清晰的时间线，无需维护单独的 INDEX.md
- **吃自己的狗粮**：本次改造的第一个使用者就是改造本身 — `docs/plans/2026-04-09-docs-plan-persistence.md` 就是新系统生成的第一个文档
- **通用升级脚本胜过版本化脚本**：用户期望 `update.sh` 的语义是"一个命令升到最新，带参数升到指定版本"，而非为每个版本新建一个 `upgrade-vX.Y.sh`。版本化脚本会让安装说明随版本爆炸，通用脚本只需维护 `LATEST_VERSION` 常量和一个分发器
- **升级函数分发器模式**：每个版本对应一个独立的升级函数（`upgrade_to_v3_2`），函数只负责该版本相对于前一版本的增量变更；主分发器通过 switch/case 路由参数；新增版本只需加一个函数 + 一行 case，不改动其他代码

### 创建/更新的本能

- 新增本能：`prompt-workflow-doc-persistence` — 在 prompt 驱动的工作流命令中，持久化指令必须独立、明确、带 CRITICAL 标记
- 新增本能：`feature-change-triggers-docs-update` — 任何功能层面的变更都必须同步更新 README 和相关文档
- 新增本能：`prefer-generic-cli-over-versioned-scripts` — 面向用户的升级/构建工具应该是一个通用命令 + 参数，而非为每个版本新建脚本。默认值对应最新版，`list` 查看所有版本

### 解决方案文档

- 本文档本身即是参考实现：`docs/plans/2026-04-09-docs-plan-persistence.md`
