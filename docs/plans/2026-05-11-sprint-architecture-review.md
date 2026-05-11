---
title: "Sprint 架构合理性分析"
type: sprint
status: completed
created: "2026-05-11"
updated: "2026-05-11"
checkpoints: 0
tasks_total: 4
tasks_completed: 4
tags: [sprint, architecture, review]
aliases: ["sprint 架构审查"]
---

# Sprint 架构合理性分析

## 需求分析

### 要做
- 分析当前 `$sprint` 架构是否合理，重点检查 Phase 流程、文档持久化、checkpoint/resume、auto-mode、caveman-mode、risk-aware review、Phase 间预热这些核心机制是否自洽。
- 结合最新完成的 `2026-05-11-sprint-speed-layer1.md` 和当前 skill 文档判断，而不是只看设计意图。
- 输出明确结论：合理、部分合理或不合理，并列出需要修正的结构性风险。

### 不做
- 本轮不修改 `$sprint`、`$work`、`$review` 等 skill 实现。
- 本轮不跑完整实现型 sprint，也不新增自动化测试。
- 本轮不评估 Layer 2/Layer 3 的缓存、typed-link、C6 自动升级等未来架构。

### 成功标准
- [ ] 给出一句话总评。
- [ ] 至少识别 3 个架构优点和 3 个架构风险。
- [ ] 区分“协议层合理”和“执行层仍脆弱”的边界。
- [ ] 给出后续是否需要进入 Plan/Work 的建议。

### 风险和假设
- 当前 `$sprint` 的核心执行方式是“命令/skill 文档驱动模型自走”，不是代码状态机；因此可靠性主要取决于协议清晰度和模型遵循度。
- 最近一次 Layer 1 加速已经把 Phase 间预热从 orchestrator 改为文档协议，这降低了实现复杂度，但也降低了可验证性。
- 本轮仓库已有未提交变更，分析不回滚、不覆盖用户已有改动。

### 初判
- 总体合理：作为 Layer 1 的轻量协议优化，当前架构方向正确，尤其是单 sprint 文档、risk-aware review、checkpoint/resume、auto-mode 强制人工边界这些设计是自洽的。
- 但还不是“强自动化状态机”：Phase 间预热、model 分层、gate 判断多数依赖文档约束和模型遵循，缺少可执行 enforcement。
- 已发现一个实际 P0 候选：`detectActiveSprintTags()` 会把已完成的 `2026-05-11-sprint-speed-layer1.md` 当作 active sprint，因为该文档 frontmatter 有重复 `status`，解析器命中第一个 `planning`。

---

## 技术方案

### 方案概述

当前 `$sprint` 架构不需要大改。优先修复执行层的确定性问题：先修 active sprint 探测误判，再补回归测试；然后把 phase 预热协议引用和 `/work` 输入来源统一到真实的 `docs/plans/` 主文档路径。最后通过现有 propagate/build/validate 链确认多副本一致。

原则：不引入新 orchestrator，不默认开启 `--auto`，不触碰 Layer 2/3 缓存或 typed-link 设计。

### 任务拆解

- [x] **Task 1: 修复 active sprint status 解析** — 文件: `scripts/inject-context.js`
  - `detectActiveSprintTags()` 当前用 regex 命中第一个 `status`，遇到重复 frontmatter 字段会误判。
  - 方案：复用 `scripts/lib/memory-v5.js` 已导出的 `parseFrontmatter()`，采用 last-write-wins 的 meta 结果；并对 status 做 trim / 去引号 / 小写规范化。
  - 验收：已完成 sprint 文档不再返回 tags；当前新增的 `status: planning` 分析文档应成为 active sprint。

- [x] **Task 2: 补 duplicate status 回归测试** — 文件: `scripts/smoke-relevance.js`
  - 新增用例：同一个 frontmatter 里先 `status: planning` 后 `status: completed`，应跳过。
  - 新增/调整用例：真实仓库集成探测不应被已 completed 的 Layer 1 文档污染。

- [x] **Task 3: 统一 phase 协议引用和 Work 输入来源** — 文件: `user-level/commands/{think,plan,work,review,compound}.md`
  - 把 phase 预热钩子的协议引用改成稳定描述：`sprint.md` 的「Phase 间预热协议」，避免在 skill 里出现不存在的 `.codex commands via ...` 伪路径。
  - 把 `/work` 的输入来源从 `.claude/.codex plans` 改为 `docs/plans/` 下最新 sprint/plan 文档，与 `$sprint` 主文档模型一致。

- [x] **Task 4: Propagate + 验证多副本一致性** — 文件: `.codex/commands/*`、`.codex/skills/*`、`plugins/tech-persistence/commands/*`、`plugins/tech-persistence/skills/*`
  - 运行 `node scripts/propagate-command-changes.js think plan work review compound`。
  - 若 hook/lib 变更需要插件副本，同步运行 `node plugins/tech-persistence/scripts/build-codex-plugin.js`。
  - 运行验证命令，确认 Codex/plugin 副本没有漂移。

### 测试策略

- 单元/冒烟测试：
  - `node scripts/smoke-relevance.js`
  - `node scripts/smoke-memory-parity.js`
- 插件/副本验证：
  - `node scripts/validate-codex-plugin.js`
  - `node scripts/propagate-command-changes.js think plan work review compound`
  - `node plugins/tech-persistence/scripts/build-codex-plugin.js`
- 手动验证：
  - `node -e "const {detectActiveSprintTags}=require('./scripts/inject-context'); console.log(detectActiveSprintTags())"` 应返回本 sprint 的 `["sprint","architecture","review"]`，而不是已完成 Layer 1 sprint 的 tags。
  - `rg -n "\\.codex commands via|\\.codex/plans|\\.claude/plans" .codex\\skills .codex\\commands plugins\\tech-persistence\\commands user-level\\commands` 不应再命中错误引用。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| `parseFrontmatter()` 只解析简单 YAML，不能解析复杂数组 | 中 | 中 | tags 仍保留现有数组 regex，只用 parseFrontmatter 取 status；不扩大解析范围 |
| Propagate 覆盖用户已有未提交 skill 改动 | 中 | 中 | 先检查 diff，确认现有改动只是协议路径同步；执行前后保留 git diff |
| plugin commands / skills 路径语义不同 | 中 | 低 | 用“同级 sprint.md 的协议段”描述替代硬编码物理路径 |
| 文档级改动看似 L0 但影响工作流 | 高 | 中 | 按 L2 处理，必须跑 validate + rg 手动检查 |

### 涉及文件

- `scripts/inject-context.js`
- `scripts/smoke-relevance.js`
- `user-level/commands/think.md`
- `user-level/commands/plan.md`
- `user-level/commands/work.md`
- `user-level/commands/review.md`
- `user-level/commands/compound.md`
- 派生副本：`.codex/commands/*`、`.codex/skills/*`、`plugins/tech-persistence/commands/*`、`plugins/tech-persistence/skills/*`

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-11 | Task 1 | `detectActiveSprintTags()` 改用 `parseFrontmatter()` 读取 `status`，重复字段按最后一次为准；真实仓库探测现在返回本 sprint tags。 |
| 2026-05-11 | Task 2 | `smoke-relevance.js` 新增 duplicate status 回归测试，覆盖 `planning` 后 `completed` 的误判场景。 |
| 2026-05-11 | Task 3 | 5 个 phase command 的预热协议引用改为“当前命令集合中 `sprint.md`”；`/work` 输入来源改为 `docs/plans/` 最新 sprint/plan 文档。 |
| 2026-05-11 | Task 4 | 运行 propagate 同步 `.codex` 与 plugin 派生副本；运行 build-codex-plugin 同步 hooks/skills/commands。 |

### 验证记录

| 命令 | 结果 |
|------|------|
| `node scripts/smoke-relevance.js` | pass |
| `node scripts/smoke-memory-parity.js` | pass |
| `node scripts/validate-codex-plugin.js` | pass |
| `node plugins/tech-persistence/scripts/build-codex-plugin.js` | pass |
| `node -e "const {detectActiveSprintTags}=require('./scripts/inject-context'); console.log(JSON.stringify(detectActiveSprintTags()))"` | `["sprint","architecture","review"]` |
| `node -e "const {detectActiveSprintTags}=require('./plugins/tech-persistence/hooks/inject-context'); console.log(JSON.stringify(detectActiveSprintTags()))"` | `["sprint","architecture","review"]` |
| `rg -n "\\.codex commands via|\\.codex/plans|\\.claude/plans|\\.claude/commands/sprint\\.md" ...` | no matches |

---

## 审查结果

### 派遣记录

- 评估 risk: **L2**
- 依据: 修改 SessionStart hook 的 active sprint 探测逻辑 + 多份 workflow 协议文档；无 auth / 数据迁移 / destructive / 跨用户副作用。
- 跑的视角: 4 quality、5 test
- 跳过的视角: 1 security、2 perf、3 arch
- 跳过原因: 本次不涉及用户输入边界、远端调用、性能关键路径或架构层重写。

### P0 — 必须修复

无。

### P1 — 建议修复

无。

### P2 — 可选优化

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | quality | `scripts/inject-context.js` | `parseInlineFrontmatterList()` 只支持 `[a, b]` inline list，不支持 YAML block list；当前 sprint 模板和现有文档都用 inline list，暂不影响。 | backlog |
| 2 | quality | `docs/plans/2026-05-11-sprint-speed-layer1.md` | 旧 sprint 文档 frontmatter 保留重复 `status` 字段；代码已兼容，但文档本身可后续清理。 | backlog |

### 验证复核

| 命令 | 结果 |
|------|------|
| `node scripts/smoke-relevance.js` | pass |
| `node scripts/smoke-memory-parity.js` | pass |
| `node scripts/validate-codex-plugin.js` | pass |
| `git diff --check` | pass（仅显示既有 CRLF warning） |
| 错误引用扫描 | pass，无 `.codex commands via` / `.codex/plans` / `.claude/plans` / `.claude/commands/sprint.md` 命中 |
| 源 hook 与 plugin hook 内容比较 | pass，完全一致 |

### 总评

可以进入 Compound。修复点与原计划一致，duplicate status 回归测试覆盖到位，源命令和派生副本已同步；剩余问题都是低优先级清理项。

---

## 复利记录

### 提取的经验

- Frontmatter 状态字段解析必须避免 first-match regex；重复字段在实际 sprint 文档中会出现，active/pending 探测应采用 last-write-wins 或共享 parser。
- 工作流协议类文档改动不是普通文案，影响所有后续 `/sprint` / `$sprint` 行为；至少按 L2 运行 validate 和错误引用扫描。
- Hook 改动必须同步验证源脚本和 plugin hook 副本一致，否则用户安装后的行为可能和仓库源码不同。

### 创建/更新的本能

- 无新本能。本次经验已直接写入项目规则和 solution 文档。

### 解决方案文档

- `docs/solutions/2026-05-11-active-sprint-frontmatter-status.md`

### 写入规则

- `.codex/rules/debugging-gotchas.md`：新增 duplicate `status` / frontmatter first-match regex gotcha。
- `AGENTS.md`：新增高频陷阱摘要和解决方案索引。

### Skill 信号

- 使用 `$sprint` 跑完整 Think → Plan → Work → Review → Compound；已记录 `.codex/skill-signals/sprint.jsonl`。
- 本次没有发现需要立即触发 `/skill-diagnose` 的放弃或纠正信号。
