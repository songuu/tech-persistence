---
title: "Memory v5 Claude/Codex parity"
type: sprint
status: completed
created: "2026-05-07"
updated: "2026-05-07"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, memory, parity]
aliases: ["memory parity", "Claude Codex memory consistency"]
---

# Memory v5 Claude/Codex parity

> **Status:** `completed`
> **Created:** 2026-05-07
> **Updated:** 2026-05-07

---

## 需求分析

### 要做
- 优化当前 Memory v5 体系的真实缺点：Claude Code 与 Codex 默认写入不同 homunculus 时，启动注入只读取第一个可用 memory index，容易互相遮蔽。
- 统一 memory pipeline 中的项目身份识别，避免 `observe` / `inject` / `evaluate` 三处复制实现后漂移。
- 加入可重复验证，证明 Claude 默认 memory 与 Codex 默认 memory 能在两个运行时中得到同一份启动上下文。

### 不做
- 不引入新的“中间层”或独立同步服务；项目当前 runtime/helper 继续是执行真相。
- 不改写 Obsidian 同步模型；共享 vault 仍然是推荐的持续同步模式。
- 不迁移或删除用户已有 homunculus 数据。

### 成功标准
- [x] Claude Code 与 Codex 在未配置共享 vault 时，也能从两个默认 homunculus 目录合并读取 Memory v5 index。
- [x] 项目 ID 由单一 helper 生成，三个 hook 脚本不再各自实现一份。
- [x] 插件构建产物包含同样的 helper 与 hook 行为。
- [x] 新增 smoke test 能验证双向 memory 注入一致。
- [x] 现有 Codex 插件验证、语法检查和 diff 检查通过。

### 风险和假设
- 风险：合并多个 memory index 时重复注入旧条目。缓解：按 `memory:v5:<id>` 去重，并按置信度/日期排序。
- 风险：测试读取真实用户 home 下的记忆。缓解：smoke test 使用临时 HOME/USERPROFILE。
- 假设：默认分离目录仍要保留；共享 `TECH_PERSISTENCE_HOME` / `~/.tech-persistence/config.json` 仍是更强的一致性模式。

---

## 技术方案

### 方案概述

把 Memory v5 的跨运行时一致性放回现有 helper 层：`scripts/lib/memory-v5.js` 负责项目身份、topic entry 解析、index 合并和预算裁剪；`inject-context.js` 只消费合并后的统一 index；`evaluate-session.js` 继续写当前 runtime 的 durable topic/index 文件，但 index 格式和解析规则由同一个 helper 提供。

### 任务拆解

- [x] **Task 1**: 集中项目身份识别和 Memory v5 index helper — 文件: `scripts/lib/memory-v5.js`
- [x] **Task 2**: 改造 root hooks 使用统一 helper 和合并读取 — 文件: `scripts/observe.js`, `scripts/inject-context.js`, `scripts/evaluate-session.js`
- [x] **Task 3**: 增加 Claude/Codex parity smoke — 文件: `scripts/smoke-memory-parity.js`
- [x] **Task 4**: 同步 Codex plugin 构建产物与验证规则 — 文件: `plugins/tech-persistence/**`, `scripts/validate-codex-plugin.js`
- [x] **Task 5**: 运行验证、审查并沉淀记录 — 文件: `docs/plans/2026-05-07-memory-parity.md`, `docs/solutions/2026-05-07-memory-parity.md`

### 测试策略
- 风险等级：L3。核心 hook/runtime 行为，影响 Claude/Codex 启动上下文。
- 语法检查：root hooks、plugin hooks、new smoke script。
- 回归验证：`node scripts/smoke-memory-parity.js` 验证两个默认 memory store 双向可见。
- 分发验证：`node plugins/tech-persistence/scripts/build-codex-plugin.js` 后跑 `node scripts/validate-codex-plugin.js`。
- 文件检查：`git diff --check`。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 合并 index 超预算 | 中 | 启动上下文过长 | 使用现有 200 行 / 25KB budget |
| topic entry 解析不兼容旧格式 | 低 | 旧 memory 不注入 | 没有 topic entry 时回退读取旧 `MEMORY.md` body |
| 插件副本漂移 | 中 | Codex 实际运行旧逻辑 | 通过 build 脚本再生成并校验 plugin hook |

### 涉及文件
- `scripts/lib/memory-v5.js`
- `scripts/observe.js`
- `scripts/inject-context.js`
- `scripts/evaluate-session.js`
- `scripts/smoke-memory-parity.js`
- `scripts/validate-codex-plugin.js`
- `plugins/tech-persistence/hooks/**`
- `docs/solutions/2026-05-07-memory-parity.md`
- `docs/plans/2026-05-07-memory-parity.md`

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-07 | Task 1 | 在 `memory-v5.js` 中新增 `detectProjectIdentity()`、topic entry 解析、dedupe/sort、统一 index formatting 和 `loadUnifiedMemoryIndex()`。 |
| 2026-05-07 | Task 2 | `observe` / `inject` / `evaluate` 改为使用共享 helper；`inject-context` 从 first-hit fallback 改为合并 compatible runtime stores。 |
| 2026-05-07 | Task 3 | 新增 `scripts/smoke-memory-parity.js`，用临时 HOME 验证 Claude/Codex 默认 memory store 双向注入。 |
| 2026-05-07 | Task 4 | 重新生成 `plugins/tech-persistence/hooks/**`，并让 `validate-codex-plugin.js` 检查 unified memory helper。 |
| 2026-05-07 | Task 4 | 同步用户级 fallback `C:\Users\songyu\plugins\tech-persistence` 和 Codex plugin cache `C:\Users\songyu\.codex\plugins\cache\local-plugins\tech-persistence\1.0.0` 的 memory hooks。 |
| 2026-05-07 | Task 5 | 更新 README、plugin README、ADR、debugging gotcha 和 solution doc。 |

---

## 审查结果

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| - | - | - | 未发现 P0 | closed |

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| - | - | - | 未发现 P1 | closed |

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | docs | README/plugin README | 可继续补一张 Claude/Codex 默认目录 vs shared vault 的拓扑图 | deferred |

### 总评

本次改动把一致性问题收敛到 helper 层，没有新增独立同步服务，也没有改变 shared vault 的推荐地位。新增 smoke 覆盖了核心风险：两个默认 memory store 都存在时，Claude/Codex 启动上下文一致。

---

## 复利记录

### 提取的经验
- Memory v5 的“读一致性”应由 `loadUnifiedMemoryIndex()` 保障；共享 vault 是更强的“写一致性”模式，但不能作为默认安装可用性的前置条件。
- hook helper 一旦承载运行时语义，必须同步 root scripts、plugin hooks、validation 和 smoke test。

### 创建/更新的本能
- 未创建本能；本次沉淀为 ADR、gotcha 和 solution doc。

### 解决方案文档
- `docs/solutions/2026-05-07-memory-parity.md`
