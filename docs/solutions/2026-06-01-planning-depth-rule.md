---
title: "规划深度自适应 rule（缺陷 D）：methodology 规则的 Codex parity 落点"
date: "2026-06-01"
tags: [solution, methodology, planning-depth, parity, self-evolution]
related:
  - "[[2026-06-01-planning-depth-rule]]"
  - "[[2026-06-01-secondary-defects-roadmap]]"
  - "[[ADR-024]]"
  - "[[ADR-011]]"
  - "[[ADR-012]]"
---

# 规划深度自适应 rule（缺陷 D）

## 问题

80/20（80% 规划审查）是 **pre-agentic 假设**——执行贵 → 重规划防返工。agentic coding 下执行成本趋近免费，「所有任务都重规划」对可逆/小任务是浪费。缺陷 D（[[2026-06-01-secondary-defects-roadmap]] P4）要把规划深度按任务可逆性细化。

## 根因 / 洞察

诚实判断（[[user_workflow_preferences]] 挑战看着酷的方案）：

- ❌ **不加 `--explore N`**（并行 N 方案选优）——撞「确定性优先」+ 重 + 未证需求 + worktree 已能手动做。YAGNI。
- ✅ 只补 1 条轻量元规则：规划深度跟「可逆性 × 规模」走，与「测试深度跟风险走」L0-L4 正交同构。

**[[ADR-012]] 勘察推翻 roadmap 初稿的落点假设**（核心洞察）：初稿写"放 user-level/CLAUDE.md 或 rules/ 一段即可"。但 `install.ps1` / `install.sh` 只把 user-level/CLAUDE.md 装到 `~/.claude/CLAUDE.md`（Claude 全局），**Codex 不读它**；user-level/rules/ 同理。根 `AGENTS.md` 是项目模板（`[项目名称]` 占位）非方法论镜像。→ 只放 CLAUDE.md 会留 **Codex parity 缺口**（违反 [[ADR-011]]）。

佐证：现有 `测试规则` 的 Codex parity 不是靠 CLAUDE.md，是靠 `.codex/skills/test-strategy`（skill 携带同等内容）。

## 解决方案

规则**内容**落 propagate 到 Codex 的 command，CLAUDE.md 只放 Claude 侧摘要——同 `测试规则` 模型：

| 落点 | 内容 | parity |
|------|------|--------|
| `user-level/CLAUDE.md` `## 规划深度规则` | P0-P4 完整矩阵（紧邻 `## 测试规则`） | Claude 全局方法论摘要 |
| `user-level/commands/plan.md` `## 规划深度自适应` | 自包含 3 档精简版 | propagate → `.codex/commands/plan.md` + plugin skill = **Codex 可读** |

档位（可逆性 > 规模 优先级）：

| 档 | 触发 | 规划深度 |
|----|------|---------|
| P0 直接做 | 可逆 + 小 | 跳过 think/plan |
| P1 轻规划 | 可逆 + 中 | 单段计划，省 think |
| P2 标准 | 常规开发 | plan→work→review |
| P3 重规划 | 不可逆 或 大 | think→plan→work→review，保留 80/20 |
| P4 全程 | 不可逆 + 高风险（支付/认证/数据/迁移/删除/对外发布） | 完整 5 phase + 多方案对比 |

## 关键决策

- **parity 落点原则（[[ADR-024]]）**：全局 methodology/preference 规则要双运行时 parity，内容必须落 propagate 的 command/skill；user-level/CLAUDE.md 只是 Claude 侧摘要（Codex 不读）。
- **零代码**：纯 markdown，无 CLI/hook/lib。L1 风险，靠 propagate sha 一致性 + validate + pre-commit 覆盖。
- **受控重复**：CLAUDE.md 摘要 vs plan.md 详版分工（非逐字复制），稳定规则 drift 风险低。

## 预防 / 复用

- 加全局开发偏好/方法论规则前先问「**Codex 读得到吗**」——只放 user-level/CLAUDE.md 或 rules/ 必留 parity 缺口（[[ADR-024]]）。
- 固定序列：改 command 源 → `propagate-command-changes.js <cmd>` → `build-codex-plugin.js` → `validate-codex-plugin.js` → `pre-commit-check.js`（[[feedback_propagate_needs_build_step]]）。

## 关联

- Plan: [[2026-06-01-planning-depth-rule]] ｜ Roadmap: [[2026-06-01-secondary-defects-roadmap]]（B 待开，C 降级）
- ADR: [[ADR-024]]（parity 落点）、[[ADR-011]]（multi-runtime parity）、[[ADR-012]]（plan 前勘察）
