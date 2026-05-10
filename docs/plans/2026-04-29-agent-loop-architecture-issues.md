# Agent Loop 架构问题完整解决方案

> **Status:** `in-progress`
> **Created:** 2026-04-29
> **Updated:** 2026-04-29

---

## 需求分析

### 要做
- 基于 `docs/architecture/ARCHITECTURE_ISSUES.md` 中真实使用问题，形成可落地的完整解决方案。
- 基于 `docs/architecture/ISSUES.md` 中第二轮真实运行问题，补齐 Git preflight、Claude Git Bash、嵌套 spec、长耗时 provider run 的方案与实现。
- 先消除需要手动改 `state.json` 的 P0 问题。
- 让 Windows + Codex 的 sandbox、provider output、review prompt、日志追踪默认可用。

### 不做
- 不重写整个 orchestrator。
- 不把 provider 职责重新塞回 Claude/Codex 命令或 skill。
- 不引入新的 npm 依赖。

### 成功标准
- [ ] `blocked` / `needs-followup` 可恢复，不需要手动改状态文件。
- [ ] Spec provider 输出 `plan.tasks` 时可归一化。
- [ ] Review provider 输出 `summary: "APPROVED"` 时可进入 `completed`。
- [ ] Windows 下 Codex 默认使用可写 sandbox。
- [ ] Windows 下 Claude Git Bash 自动检测并注入。
- [ ] 非 Git 仓库在显式 `--skip-git-repo-check` 时可通过 preflight。
- [ ] Spec provider 输出 `taskBreakdown.tasks` 时可归一化。
- [ ] Provider timeout 可通过 CLI 参数调整。
- [ ] Provider 多次运行日志不互相覆盖。
- [ ] 架构问题文档包含优先级、代码落点、验收标准和后续补齐项。

### 风险和假设
- 假设 v6 继续保持“外部 orchestrator 串 provider”的架构方向。
- Provider 输出仍可能变化，所以修复重点放在 codec/normalizer/state machine，而不是 prompt 文案。

---

## 技术方案

### 方案概述

把九个问题归并成五条主线：输出协议、状态机恢复、Windows sandbox、review context、可观测性。短期在现有单文件 orchestrator 中补齐 P0/P1 修复，保持 `scripts/agent-orchestrator.js` 与 `plugins/tech-persistence/scripts/agent-orchestrator.js` 同步；中期再把 `status --verbose`、`retry` 和更细的测试拆出来。

状态机只消费 normalized spec/handoff/review，不直接相信 provider 原始字段。第一次实现仍要求 clean worktree；后续 `needs-followup` / `blocked` 作为同一次 run 的 continuation，允许在已有实现 diff 上继续。

### 任务拆解

- [x] **Task 1**: 增强 spec/review normalizer，兼容 `plan.tasks` 与 `summary: "APPROVED"` — 文件: `scripts/agent-orchestrator.js`, `plugins/tech-persistence/scripts/agent-orchestrator.js`
- [x] **Task 2**: 修复 resume 状态入口，允许 `blocked` 重新进入 implementation — 文件: `scripts/agent-orchestrator.js`, `plugins/tech-persistence/scripts/agent-orchestrator.js`
- [x] **Task 3**: Windows 下默认注入 Codex `workspace-write` sandbox，并在 doctor 中显示 — 文件: `scripts/agent-orchestrator.js`, `plugins/tech-persistence/scripts/agent-orchestrator.js`
- [x] **Task 4**: provider 日志文件名加时间戳，避免多次 resume 覆盖 — 文件: `scripts/agent-orchestrator.js`, `plugins/tech-persistence/scripts/agent-orchestrator.js`
- [x] **Task 5**: 将完整解决方案写入架构问题文档 — 文件: `docs/architecture/ARCHITECTURE_ISSUES.md`
- [ ] **Task 6**: 增加 `status --verbose` 与 `retry` 语义化入口 — 文件: `scripts/agent-orchestrator.js`, `plugins/tech-persistence/scripts/agent-orchestrator.js`
- [ ] **Task 7**: 对 review prompt 的 spec/design 注入增加大小预算 — 文件: `scripts/agent-orchestrator.js`, `plugins/tech-persistence/scripts/agent-orchestrator.js`
- [ ] **Task 8**: 把 `self-test` 拆成更独立的 codec/normalizer/state 测试 — 文件: `scripts/agent-orchestrator.js` 或 `tests/`
- [x] **Task 9**: 兼容 `taskBreakdown.tasks` 嵌套 spec 输出，并强化 spec prompt — 文件: `scripts/agent-orchestrator.js`, `plugins/tech-persistence/scripts/agent-orchestrator.js`
- [x] **Task 10**: 让 preflight 的 Git 检查尊重 `--skip-git-repo-check` — 文件: `scripts/agent-orchestrator.js`, `plugins/tech-persistence/scripts/agent-orchestrator.js`
- [x] **Task 11**: Windows 下自动检测并注入 Claude Git Bash 路径 — 文件: `scripts/agent-orchestrator.js`, `plugins/tech-persistence/scripts/agent-orchestrator.js`
- [x] **Task 12**: 支持 provider timeout CLI 参数并写入 providerRuns — 文件: `scripts/agent-orchestrator.js`, `plugins/tech-persistence/scripts/agent-orchestrator.js`
- [x] **Task 13**: 将第二轮完整解决方案写入 `ISSUES.md` — 文件: `docs/architecture/ISSUES.md`

### 测试策略
- 单元测试: 当前用 `node scripts/agent-orchestrator.js self-test` 覆盖 JSON unwrap、handoff alias、review alias、schema strictness、`plan.tasks`。
- 单元测试补充: `self-test` 覆盖 `taskBreakdown.tasks` 和 provider timeout 解析。
- 集成测试: `node scripts/agent-orchestrator.js doctor` 检查 provider 解析、schema、runDir、sandbox、Claude Git Bash 策略。
- 手动验证: 用一个小需求跑 `run -> freeze -> resume`，确认 Windows 下 Codex 可写、review 通过后状态为 `completed`。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| `blocked` continuation 混入无关 dirty 文件 | 中 | diff 不纯 | 第一次 `frozen` 实现仍要求 clean；后续只作为同 run continuation |
| `summary: APPROVED` 误判 | 低 | 错误放行 | P0/blocked finding 优先；只有 issues 为空才接受 summary approved |
| Windows `workspace-write` 与用户配置冲突 | 低 | 行为不符合预期 | 支持 `--codex-sandbox default` 或显式 mode 覆盖 |
| 时间戳日志路径影响旧脚本读取 | 低 | 调试脚本需适配 | `state.providerRuns[]` 是权威索引 |
| 非 Git 仓库 no-diff run 降低 review 质量 | 中 | review 上下文不足 | 默认仍失败；只有显式 `--skip-git-repo-check` 才放行 |
| 自动 Git Bash 路径误选 | 低 | Claude provider 启动失败 | doctor 显示路径来源，用户可用环境变量覆盖 |

### 涉及文件
- `scripts/agent-orchestrator.js`
- `plugins/tech-persistence/scripts/agent-orchestrator.js`
- `docs/architecture/ARCHITECTURE_ISSUES.md`
- `docs/architecture/ISSUES.md`
- `.codex/rules/architecture.md`
- `docs/solutions/2026-04-29-agent-loop-recovery-flow.md`
- `AGENTS.md`
- `docs/plans/2026-04-29-agent-loop-architecture-issues.md`

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-04-29 | Task 1-5 | 补齐 P0/P1 核心修复，并把完整解决方案写入架构问题文档。 |
| 2026-04-29 | ADR | 记录 Agent Loop 恢复流、normalizer、Windows sandbox 和 provider 日志策略。 |
| 2026-04-29 | Compound | 新增 Obsidian 解决方案文档，并更新 `AGENTS.md` 解决方案索引。 |
| 2026-04-29 | Task 9-13 | 补齐 `ISSUES.md` 暴露的 Git preflight、Claude Git Bash、嵌套 spec 和 provider timeout 问题。 |

---

## 审查结果

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
待 `/review` 补充。

---

## 复利记录

### 提取的经验
- Provider 编排器的状态机不应直接依赖 provider 原始字段，必须通过 normalizer。

### 创建/更新的本能
- 待 `/compound` 补充。

### 解决方案文档
- `docs/architecture/ARCHITECTURE_ISSUES.md`
- `docs/architecture/ISSUES.md`
- `docs/solutions/2026-04-29-agent-loop-recovery-flow.md`
