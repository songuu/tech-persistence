---
title: "prototype skill 加「随附文字需求」证据源（墨刀 PRD 解析场景）"
type: plan
status: completed
created: "2026-06-09"
updated: "2026-06-09"
tags: [plan, prototype, prd, modao, sibling-eval-followup]
related_solutions:
  - "[[2026-06-09-pm-skills-eval]]"
---

# prototype skill 加「随附文字需求」证据源

> sibling-eval（[[2026-06-09-pm-skills-eval]]）的场景化落地。pm-skills 本身 0 借鉴（只生成不解析）；本改动是用户场景澄清后，对**自家 prototype skill** 的最小扩展。

## 背景

用户澄清两个 PM/PRD 场景：
1. （后续）自己当 PM 画 PRD — 生产侧，未落地。
2. （当下痛点）解析产品给的**基于墨刀(modao)的 PRD** — 消费侧。

场景 2 的最近自家能力 = `prototype` skill（假设驱动收敛）。缺口：prototype 此前**只吃视觉截图**（证据源 = 项目规范 > 本能 > 截图推断 > 行业惯例），墨刀 PRD 里的**文字需求说明**（批注/说明页/图文混排）是更强证据源，但完全没被用——本该是事实的需求被当成 `⚡假设`，徒增纠偏轮次。

## 改动（最小，0 新命令）

canonical 源 `user-level/commands/prototype.md` 两处：

1. **执行策略第一步**：加一句"如有随附文字需求，先逐条读完文字再看截图"。
2. **假设置信度来源**：新增 `### 0. 随附文字需求（最高优先 — 需求事实，不是假设）`，置于原「1. 项目已有规范」之前；规范那条括号从「(最高优先)」改为「(实现映射最高优先)」避免维度打架（来源 0 管"做什么"=需求事实，来源 1 管"怎么实现"=组件映射）。
   - 规则要点：文字明示 → `✅确认 (PRD 明示)`，绝不降级为假设；文字与截图冲突 → 以文字为准 + 冲突点单列让用户裁决；文字空白处才回落 1-4 档推断。

## 风险 / 测试

- 风险等级 **L1**（纯 prompt 协议精修，无代码逻辑、无 enforcement、可逆）。规划深度 P1。
- 无单测（prompt 协议）。验证 = parity 链路全绿 + 真实墨刀样本试跑（待用户提供样本验证文字证据源吃得动）。

### 关键假设验证（兑现 ADR-012）

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| canonical 源是 `user-level/commands/prototype.md` 而非 plugin 副本 | Read 源 + grep propagate 脚本 | ✅ 确认；plugin/codex 均为派生副本 |
| prototype 在 propagate-command-changes 支持列表内 | grep `scripts/propagate-command-changes.js` | ✅ 第 15 行列表含 `prototype` |
| 源用「Claude」作 actor（propagate 转 Codex 不撞 runtime-label） | Read 源「假设置信度来源」段 + grep codex 副本 | ✅ 源用「Claude 从以下来源」；codex 副本正确转「Codex 按以下优先级」，无 [[codex-regex-sync-needs-runtime-neutral-idiom]] 撞车，墨刀/PRD 文本保留 |
| 「项目已有规范」与新「文字需求」维度不冲突可并列 | Read 该段 | ✅ 规范=实现映射、文字=需求事实，各自最高优先；改括号区分 |

## Parity 链路（双 runtime MR 不可妥协）

```
propagate-command-changes.js prototype → build-codex-plugin.js → validate-codex-plugin.js → pre-commit-check.js
```

结果：4 副本同步（plugin command / codex command / plugin skill / codex skill），Codex 转换正确（Claude→Codex 未撞车，墨刀/PRD 文本保留），pre-commit exit 0。

## 未做（YAGNI / 守 LT）

- 场景 1（自己画 PRD，`think --prd` 精简档）— 用户标「后续」，等真当 PM 再落，不提前建。
- 墨刀专属 `modao-conventions` 规则 — 等真实样本暴露稳定标注惯例再考虑，现在建是猜测。

## 变更日志

- 2026-06-09：prototype skill 加来源 0（随附文字需求）。场景 2 落地。status: completed。
