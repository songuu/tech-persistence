---
title: "Phase 间预热协议从'必须'撤回为'可选'——避免 cargo-cult enforcement"
date: 2026-05-22
tags: [solution, sprint-protocol, rollback, enforcement, cargo-cult, mechanism-over-discipline]
related_instincts: [unproven-protocol-rollback-before-enforcement, enforcement-dead-on-arrival-when-82pct-skip]
aliases: ["phase-warmup-rollback", "C2-reject-rollback"]
---

# Phase 间预热协议从'必须'撤回为'可选'

## Problem

2026-05-22 会话评估是否接入 2026-05-12 gstack-latest-analysis.md C2 = **Phase 间预热段 lint enforcement**（pre-commit-check 强制 sprint phase 报告含「下一 Phase 预热」段）。当时 Phase 4 定级 🟢 待接入，反方理由 "(b) 预热段价值未量化，可能 cargo-cult" 反驳为 "通过 6 个月后比较返工率量化"。

6 个月已过 — 量化未做。实际落地率数据：

| 指标 | 2026-05-12 | 2026-05-22 (今) | Delta |
|------|-----------|----------------|-------|
| docs/plans/ 文件总数 | ~20 | 49 | +29 |
| 含「下一 Phase 预热」字符串 | 2 | 9 | +7 |
| 落地率 | ~10% | **18%** | +8pp |

82% sprint 不写预热段也跑通了 → 弱信号:协议本身可能是 cargo-cult，不是纪律问题。

## Root Cause

[[ADR-013]] mechanism-over-discipline 原则的**隐含前提**：协议必须先证明有价值，才值得 mechanism 化。把"协议落地率低" → "协议失败需要 enforcement" 是误用——也可能是"协议本身就无价值，落地率反映真实需求"。

两个推论分歧：

| 信号解读 | 行动 |
|---------|------|
| 协议有价值但人懒 → 接 enforcement | ❌ 风险：硬接后 82% 用户被拒 → 高频 `--no-verify` → enforcement 死亡（[[ADR-013§B]] 已警告） |
| 协议无价值，82% 用脚投票 → 撤回协议 | ✅ 消除 82% 隐性违规感，恢复 sprint 流自然性 |

本案选**撤回**，因为：

1. 价值证据缺失（6 个月未量化返工率）
2. enforcement 死亡风险高（82% 不写仍跑通 = 用户不觉得缺失有痛感）
3. C1+C4 刚加 design lens 复杂度，本周再加 commit-time lint 会复合摩擦
4. 不符合 4 不可妥协·轻量原则（~80 行实现给 18% 价值未证场景）

## Solution

### 撤回范围

| 文件 | 改动 |
|------|------|
| `user-level/commands/sprint.md` | 主协议段 "必须" / "强制" → "可选" / "建议"；加撤回历史注释（含 18% 数据 + 决策依据）；跳过合法化（"什么都不输出也合法"）|
| `user-level/commands/think.md` 钩子 | "必须追加" → "可选追加" + `2026-05-22 起改建议非强制` 注 |
| `user-level/commands/plan.md` 钩子 | 同上 |
| `user-level/commands/work.md` 钩子 | 同上 |
| `user-level/commands/review.md` 钩子 | 同上 |
| `user-level/commands/compound.md` 钩子 | 同上（"收尾预热"段同步处理）|

6 commands × 4 副本 = 24 文件，propagate 脚本同步：

```bash
node scripts/propagate-command-changes.js sprint think plan work review compound
node plugins/tech-persistence/scripts/build-codex-plugin.js
node scripts/validate-codex-plugin.js
node scripts/pre-commit-check.js  # EXIT=0
```

### 保留段（不撤回）

- 「预热段格式」段（仍存在，作为可选时的格式参考）
- 「各 Phase 预热典型内容」表（仍存在，作为可选时的内容提示）
- 「设计原则」段（仍存在，作为写预热段时的约束）

意图：协议从"必须"降为"建议"，但**不删除**——用户/模型如觉得有价值仍可用。

## Prevention

### 元规则：未证协议优于硬接 enforcement

写入 [[unproven-protocol-rollback-before-enforcement]]。任何"协议落地率低"情境，**默认问"协议是否真有价值"** 而不是默认 "如何 enforce"。判定矩阵：

| 落地率 | 价值证据 | 决策 |
|--------|---------|------|
| 低 (<30%) | 有量化证据 | 接 enforcement（[[ADR-013]] mechanism） |
| 低 (<30%) | 无量化证据 | **撤回协议**（本案）；不允许"靠 enforcement 强推" |
| 中 (30-70%) | 任意 | 维持现状 + 量化 |
| 高 (>70%) | 任意 | 无需 enforcement |

价值证据 = 可对比的指标（返工率 / 错误率 / phase 切换时间 / 用户主动写率），不是"我觉得有用"。

### 元规则：enforcement 上线前看 82% 信号

写入 [[enforcement-dead-on-arrival-when-82pct-skip]]。如果协议**不依赖 enforcement 时**已经 80%+ 用户/模型自然跳过，硬接 enforcement 会触发 [[ADR-013§B]] 反模式：用户养成 `--no-verify` 习惯 → enforcement 死亡。**先量化价值 → 再决定是否 enforce**。

预先信号 checklist：

- [ ] 协议存在多久？（< 6 个月数据不足）
- [ ] 当前自然落地率？（grep 协议关键标识符 in 历史产物）
- [ ] 落地与不落地的对比指标？（如无，先做量化 sprint）
- [ ] 撤回的成本？（如低，撤回 > 硬接）

## Validation

- 6 commands 4 副本 sync：✅ pre-commit-check EXIT=0
- validate-codex-plugin：✅ 通过
- sprint.md 主协议含撤回历史注释（含 18% 数据 + [[ADR-013]] 反应用引用）
- 5 钩子段统一加 `2026-05-22 起改建议非强制` 日期注，便于未来 git blame / grep 追溯

## Related

- [[2026-05-12-gstack-latest-analysis]] — C2 原候选定义
- [[ADR-013]] — mechanism over discipline，本案是其隐含前提的反向应用
- [[ADR-013§B]] — enforcement 边界产物枚举，本案推论"82% 不写 = 边界产物冲突"
- [[mechanism-over-discipline]] — 原本能（已毕业为 ADR-013），本案补充隐含前提
- [[unproven-protocol-rollback-before-enforcement]] — 本案沉淀的新本能
- [[enforcement-dead-on-arrival-when-82pct-skip]] — 本案沉淀的新本能
