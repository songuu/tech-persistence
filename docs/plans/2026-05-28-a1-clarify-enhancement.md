---
title: "A1 clarify 阶段强化：think 验收升级 EARS-lite + 可选 --clarify 子步"
type: sprint
status: completed
created: "2026-05-28"
updated: "2026-05-28"
checkpoints: 0
tasks_total: 4
tasks_completed: 4
tags: [sprint, coding-flow, clarify, think, ears]
aliases: ["A1 clarify 强化", "think-clarify-enhancement"]

# === Anti-Drift 扩展字段 ===
invariants:
  - "think.md 3 副本 sha256 一致（源 + codex propagate + plugin build，LF-normalize 后比对）"
  - "EARS-lite 仅 L3+ 强制，L0-L2 保持可选——不波及小任务流程"
  - "--clarify 是 think 内联子步，不新增独立命令（对标 spec-kit /clarify 但不加命令面）"
invariant_tests:
  - "node scripts/pre-commit-check.js"
  - "node scripts/validate-codex-plugin.js"
deferred: []
deadcode_until: []
---

# A1 clarify 阶段强化

> **来源**：[[2026-05-28-two-layer-architecture-enhancement]] §A1（编码流层，think 层）。
> **现状勘察**（[[ADR-012]]）：`think.md` 步骤 1「需求澄清」（答案不明显才问）+ 步骤 3「3-5 个可验证验收条件」已有验收意识；缺口是验收非结构化、澄清被动。

---

## Phase 1: 需求分析（Think）

### Scope
- think 产物验收条件升级 **EARS-lite** 格式：`WHEN <触发条件> THE SYSTEM SHALL <可观测行为>`（保留中文，仅借结构）。L3+ 强制，L0-L2 可选。
- 新增**可选** `/think --clarify` 子步：系统主动扫描并逐条列出未定义的 输入边界 / 失败模式 / 空状态，要求确认（对标 spec-kit `/clarify`，内联进 think 不新增命令）。

### Non-scope
- 不新增独立 clarify 命令（内联 think）。
- 不改 sprint Phase 1 流程结构（sprint.md 不动）。
- 不强制 L0-L2 小任务用 EARS（避免过重）。
- 不引入自动澄清 ruling 回路（A3 范畴）。

### Success（EARS-lite，dogfood 自证）
- WHEN think 处理 L3+ 需求，THE SYSTEM SHALL 用 EARS-lite 格式输出验收条件。
- WHEN 用户传 `/think --clarify`，THE SYSTEM SHALL 扫描并逐条列出未定义的 输入边界 / 失败模式 / 空状态 要求确认。
- WHEN think 处理 L0-L2 任务，THE SYSTEM SHALL 保持 EARS-lite 可选不强制。

### Risks
- EARS-lite 对小任务过重 → L3+ 限定缓解（L0-L2 沿用现有 3-5 验收条件）。
- think.md 3 副本同步 → propagate + build + validate + pre-commit 固化序列（[[debugging-gotchas]] propagate-needs-build-step）。
- codex regex 撞车（runtime label）→ A1 不引入 runtime-specific 标签，低风险，但 propagate 后 grep codex 副本验证。

---

## Phase 2: 技术方案（Plan）

（待 'go' 后填写）

### 关键假设验证（[[ADR-012]]）

| 假设 | 验证文件 | 实际 | 可信度 |
|------|---------|------|--------|
| think.md 是源，2 派生副本靠 propagate+build | Glob think.md + debugging-gotchas | 确认：`.codex/commands/think.md`（propagate）+ `plugins/.../commands/think.md`（build） | 已勘察 |
| think 现有步骤 3 是「3-5 可验证验收」非结构化 | Read think.md:56-58 | 确认：纯自然语言「列出 3-5 个具体的验收条件，每个可验证」 | 已勘察 |
| EARS-lite 在本项目可用 | 本会话 B1/B3 sprint 文档 | dogfood 证据：已用 `WHEN...THE SYSTEM SHALL` 写 Success | 已验证 |

### 入场扫描 - Invariants 继承

| 子系统 | 既有 invariant | 本 sprint 如何保持 |
|--------|---------------|--------------------|
| 多副本同步 | git tracked 派生靠 propagate + build | think.md 改源后跑固化序列 |
| codex regex | 跨 runtime 标签用 neutral idiom | A1 不引入 runtime-specific 标签 |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| EARS-lite 验收 | `/think` L3+ | think.md 步骤 3 | ✅ sprint 文档需求分析段 | ✅ plan 读 |
| --clarify 子步 | `/think --clarify` | think.md 新增可选段 | ✅ 对话 + 文档 | ✅ plan 读 |

无 ❌ 链路。

### 入场扫描 - 债务清单
来自 [[2026-05-28-two-layer-architecture-enhancement]]：剩余 A2/A3/B2 proposed，本 sprint 只做 A1，不阻塞其他。

### 任务拆解

| Task | 等级 | 内容 | 验证 |
|------|------|------|------|
| T1 | L1 | think.md 步骤 3 升级 EARS-lite（L3+ 强制 / L0-L2 可选，附中文示例） | grep 含 EARS 格式 |
| T2 | L1 | think.md 用法 + 新增可选 `--clarify` 子步段（扫描 输入边界/失败模式/空状态） | grep 含 --clarify |
| T3 | L2 | 双 runtime 同步：propagate think + build + validate + pre-commit；grep codex 副本不撞车 | validate pass + 3 副本 sha match |
| T4 | L1 | 文档同步：设计文档 A1 标 implemented + 变更日志、README（如需）、solution + index | pre-commit exit 0 |

### 验证策略
- 纯文档无测试脚本：验证靠 propagate sync（pre-commit checkPropagateSync sha256）+ validate-codex-plugin。
- T3 后 grep `.codex/commands/think.md` 确认无 runtime label 撞车。

---

## Phase 3: 实现记录（Work）

| Task | 状态 | 产物 | 验证 |
|------|------|------|------|
| T1 | ✅ | think.md 步骤 3 升级 EARS-lite（L3+ 强制 / L0-L2 可选 + 中文示例 `WHEN…THE SYSTEM SHALL…`）| grep 含 EARS-lite/THE SYSTEM SHALL |
| T2 | ✅ | think.md 用法 + 可选参数加 `--clarify`；新增执行步骤 1.5 需求澄清扫描（输入边界/失败模式/空状态三维表）| grep 含 --clarify（用法/参数/步骤 1.5）|
| T3 | ✅ | propagate think + build（22 commands / 32 skills）+ validate pass；grep codex 副本含 --clarify/EARS 且无 runtime label 撞车 | validate pass，4 副本同步 |
| T4 | ✅ | 设计文档 A1 标 implemented + 变更日志；solution + sync index（31 docs，CLAUDE/AGENTS solution block 刷新）| pre-commit exit 0 |

## Phase 4: 审查结果（Review）

风险等级：L1（纯文档命令增强，无代码路径 / 无 enforcement / 无数据捕获）。

**P0**：无。

**P1**：无。A1 是 think.md 文档增强，不引入新脚本、状态、持久化或安全面；EARS-lite 与 --clarify 都是对现有 think 流程的内联强化。

**第 6 视角（集成连续性）**：
1. 未破坏 invariant——think.md 4 副本经 validate sha 一致；EARS-lite 仅 L3+ 强制，步骤明确限定不波及 L0-L2 流程；`--clarify` 内联未新增命令（build 仍 `generated 22 commands`，命令清单不变）。
2. 无 dead code——think 是既有命令，EARS-lite/--clarify 非新 export，think→plan 验收读取链路已存在。
3. 集成闭环——验收（EARS-lite）→ sprint 文档需求分析段 → plan 读，链路本就闭合，本 sprint 仅升级格式。

## Phase 5: 复利记录（Compound）

- **新 ADR**：无。A1 遵循现有 propagate+build 多副本同步模式，未引入新架构决策（区别于 B1/B3 各产 1 ADR——它们涉及新数据捕获范式 / enforcement 入口选址）。
- **新 solution**：[[2026-05-28-a1-clarify-enhancement]]。
- **候选本能**：无新增。A1 强化现有 [[documented-claim-vs-code-reality-drift]]（本会话第 4 次勘察，A1 是唯一描述准确的）与 [[ADR-012]]（勘察 ROI 恒定，不因上次假设对错改变），但不产生新本能。
- **EARS-lite dogfood 三连**：本会话 B1/B3/A1 三个 sprint 文档 Success 段都已用 `WHEN…THE SYSTEM SHALL…`——A1 落地的格式经自身工作流验证过，非纸面引入。
- **剩余增强**：A2（grader-revise loop）/ A3（clarification channel）/ B2（trace→eval）仍 proposed；B2 数据源（skill-traces）已就位可优先。

## Related
- [[2026-05-28-two-layer-architecture-enhancement]] — A1 设计来源
- [[ADR-012]] — plan 必须勘察
- [[2026-05-28-skill-trace-aware-reflection]] — B1（同期，EARS-lite dogfood 来源）

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-05-28 | 初版 plan：think 验收升级 EARS-lite（L3+ 强制）+ 可选 --clarify 子步，纯文档零依赖。status: planning |
