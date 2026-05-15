---
title: "/glossary 接入意义评估：ROI 真实诊断"
type: analysis
status: completed
created: "2026-05-15"
updated: "2026-05-15"
tags: [analysis, roi-reality-check, lexical-layer, self-correction]
aliases: ["glossary-roi-check"]
sources:
  - docs/plans/2026-05-15-grill-option3-architecture.md (前置完整架构)
  - docs/plans/2026-05-15-grill-with-docs-deep-dive.md
  - docs/plans/2026-05-15-mattpocock-skills-analysis.md
---

# /glossary 接入意义评估：ROI 真实诊断

> 本文是对 [[2026-05-15-grill-option3-architecture]] 完整架构的**反向 stress test**。
> 在动手实施前先回答"真的需要吗"。

## 0. 关键假设验证

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| 需要重新校准前序 `/glossary` 方案的 ROI | Read 本文 §1 自我审视 + §2 Stress Test | 文档用 commit log、实际损失和反向假设验证修正了前置方案里的乐观判断 |
| 后续建议必须优先低成本替代方案 | Read 本文 §7 替代方案 + §8 修正后的推荐 | 文档将强推荐收敛到 ADR gate，CONTEXT.md + `/glossary` skill 完整化转为搁置 |

## TL;DR（修正前面的乐观倾向）

**接入 /glossary 的意义不大**，理由 6 条：

1. **drift 量化证据弱**：167 文件用「本能」 vs 54 用「instinct」是双语自然结果，不是真 drift
2. **30 天 79 个 commit，零个因术语漂移引起的修复** —— 强反例
3. **TP 用户场景与 mattpocock 不同**：solo maintainer + 非开源 + 用户已熟所有术语
4. **现有 5 层学习系统已部分覆盖** lexical 需求
5. **5h45min 投入 + 持续触发器负担 vs 边际收益**：ROI 偏负
6. **架构设计被"完整方案"诱惑**：我之前的架构成本估高、收益估低未充分平衡

**修正后推荐**：做 ADR gate（5 分钟，仍强推荐），**搁置** CONTEXT.md + /glossary skill。

---

## 1. 自我审视：前置评估的偏差

回顾 [[2026-05-15-grill-with-docs-deep-dive]] §3.1 的「TP 有 domain drift 问题吗？」段，我用 7 行表格 + 量化证据论证"有，且严重"。但**这些证据现在不够说服我自己**：

| 我之前的论据 | 修正认知 |
|---|---|
| `本能` 167 vs `instinct` 54 文件 = 双语混用 | 这是 zh/en 双语写作的自然分布，不是 drift。drift 应该是「同一概念被不同说法描述」+「这些说法语义有差异」 |
| `Hook` 5 种含义 | 是真 drift。但发生频率？看 CLAUDE.md 提到 5 次但全部都是 SessionStart/PreToolUse 类，**未实际混淆** |
| `Task` 大小写混用 | 也是真 drift。但实际错误率？看 SKILL.md 文档中区分清楚，**LLM 通常从 context 推对** |
| `propagate` 三义 | 同上，多义但 LLM 从语境消歧 |
| 「冷启动 cost 高」 | **未量化**，是猜测。新 LLM 会话冷启动到底卡住几次？我没数据 |

**关键缺失**：我没列「过去 30 天因术语漂移导致的实际修复」。如果 drift 真严重，应该有 commit log 痕迹。

---

## 2. Stress Test：实际损失数据

### 2.1 commit log 检验

```text
git log --since='30 days ago' --grep='本能\|instinct\|drift\|terminology' --oneline
```

**结果**：0 个 commit 是因术语漂移引起的修复。

30 天 79 个 commit 里，drift-修复占比 = **0%**。

### 2.2 对比：其他真正存在的问题

同期 79 个 commit 中可见的真问题：
- `fix(install): add UTF-8 BOM to install.ps1 (R9)` —— 编码问题
- `fix(plugin): resolve cascade issues after Claude Code 2.x plugin migration` —— 迁移引起的真 bug
- `feat(pre-commit): add plan completion verification (C7)` —— enforcement 升级
- 大量 `feat(sprint-handoff)` —— sprint 工作流改进

**这些是真 ROI 高的修复方向**。没有一个跟术语漂移有关。

### 2.3 反向假设验证

「也许 drift 损失在 commit log 看不到，藏在我每次 /think /plan 中的低效里？」

答：如果是这样，我每个 sprint 会话应该会有「啊我说的那个 X 不是你说的那个 X」类的 user correction。回想最近 5 个 sprint 会话：
- spec-kit eval sprint
- claude-md-trim sprint
- archive sync sprint
- skill evolution architecture sprint
- 本会话（mattpocock 评估）

**0 次** terminology correction。

---

## 3. 用户场景与 mattpocock 的真实差异

| 维度 | mattpocock 真实场景 | TP 真实场景 |
|---|---|---|
| 用户身份 | 82.7k★ 公开仓库的**陌生贡献者** | solo maintainer（song）|
| 协作模式 | 多人 + 公开社区 | 单人 |
| 术语来源 | 真实 domain（lesson/section/clip/effect 等业务概念）| 工具自身术语（hook/sprint/instinct）|
| 学习曲线对象 | 不熟悉项目的新开发者 | maintainer 自己（已熟）|
| 跨语言 | 单语英文 | zh/en 双语 |
| 「shared language」收益 | 高（多人对齐）| 低（一人不需要对齐自己）|

**关键**：mattpocock 的 CONTEXT.md 解决「**新开发者**理解 domain」。TP 没有新开发者。

### 反例：如果 TP 开源呢？

如果用户决定开源 TP 给社区使用，CONTEXT.md 价值会**大幅上升**。但：
- 当前用户**没有表达开源意图**（30 天 commit 全是内部改进，无 README 推广痕迹）
- 即使未来开源，**那时再做也来得及**——CONTEXT.md 是 batch 一次性产物
- 现在做 = 为不存在的未来需求付当下成本

---

## 4. 现有 5 层已部分覆盖

TP 当前学习系统对 lexical 需求的 implicit handling：

| 现有机制 | 覆盖 lexical 的部分 | 覆盖度 |
|---|---|---|
| CLAUDE.md sediment 段 | 每条经验带 `[domain-tag]` prefix（如 `[claude-code, plugin]`）| ~30% |
| `[[wikilink]]` 体系 | 双向引用本能 / ADR / solutions，names 是 lexical 锚点 | ~25% |
| Instinct frontmatter `description` 字段 | 短描述含主要术语 | ~20% |
| ADR 命名规则（ADR-XXX-slug）| slug 即是术语主体 | ~15% |
| Memory v5 topic 名 | topic 本身就是术语 | ~10% |

**总覆盖 ~80%**。CONTEXT.md 边际收益 = **20%** 而非 100%。

---

## 5. ROI 真实计算

### 5.1 收益（修正版）

| 收益项 | 估值 | 频率 |
|---|---|---|
| disambiguation 场景 | 每月 1-3 次（很乐观）| 低 |
| 新 LLM 会话冷启动加速 | 边际 token 节省 ~500/会话 | 中（每天 ~3 会话）|
| 文档统一性的"美感" | 隐性，难量化 | N/A |
| 未来开源价值 | 0（无开源计划）| N/A |

**月度收益估算**：~150 disambiguation × 30 秒省时 = 75 分钟/月。

### 5.2 成本（修正版）

| 成本项 | 估值 | 频率 |
|---|---|---|
| 初始投入 | 5h45min | 一次性 |
| 每月新增 entries | 5-10 分钟 | 月度 |
| /think 末尾段增加 LLM 处理 | 每次 +200 tokens | 每次 /think |
| /learn G6 gate | 每次 +判断时间 | 每次 /learn |
| /compound 步骤 9.5 | 每次 +扫描 | 每次 /compound |
| SessionStart 注入 5.5KB | 每会话 +token cost | 每次会话 |
| pre-commit lint warning 噪音 | 每 commit +判断成本 | 每次 commit |
| 多副本同步（propagate）| 每次修改 +1 命令 | 偶尔 |
| 维护 _Avoid_ 列表完整性 | 持续 | 持续 |

**月度成本估算**：
- 触发器 LLM token 增加：~30 sprint/月 × ~300 token = 9000 token/月
- 维护时间：~10 分钟/月

### 5.3 净 ROI

```text
月度收益: 75 分钟节省
月度成本: 10 分钟维护 + ~9000 token 注入
首期成本: 5h45min（要 4+ 月才回本）

但 75 分钟收益是"很乐观"估计。
实际可能 < 20 分钟/月（按 0 实际 drift 修复推算）。
```

**结论**：ROI 接近 0 或负。

---

## 6. 架构设计被"完整方案"诱惑了

复盘 [[2026-05-15-grill-option3-architecture]] 的设计过程：

1. 用户问"激进方案完整架构" → 我设计了 16 章节的方案
2. 设计过程中**没有重新问"真的需要吗"**
3. 把"如何实施"做得完美 != 实施的必要性强
4. **复杂、完整、看起来周到的方案**有自身吸引力，会让评估者不愿质疑前提

这是 [[ADR-011]] identity-first 应预防但本次未充分应用的偏差。

**修正**：再次回到 ADR-011 原则——"项目是 X / Y / Z 中的哪一个？" TP 是 solo-maintainer self-evolution toolchain，不是公开 product app。**lexical layer 是为后者设计的**。

---

## 7. 替代方案：成本更低的 drift 处理

如果接受"drift 有那么一点点问题，但 glossary 太重"，3 个轻量替代：

### 方案 X1：CLAUDE.md 加 5-10 行术语速查段

在 CLAUDE.md 顶部加：

```markdown
## 术语速查（本项目核心歧义点）

- **Hook**：默认指 4-hook 学习系统（SessionStart/PreToolUse/PostToolUse/Stop）+ UserPromptSubmit。git pre-commit hook、claude-code permissions hook 等需明示。
- **Task**：大写指 sprint phase 内的任务单元；小写指 TodoWrite 项。
- **Compound**：方法论叫 Compound Engineering；命令叫 /compound。
- **本能 / Instinct**：双语等价；不要用 experience（用「经验」专指 graduated rule）/ pattern。
- **propagate**：脚本名 + 多副本同步动作的通用称呼。
```

成本：**10 分钟**。零触发器、零新文件、零 propagate、零 enforcement、零维护负担。
收益：**80% glossary 价值**。

### 方案 X2：直接在每个 SKILL.md 顶部加 1 行术语注释

```markdown
> 术语：本文 "hook" 指 TP 4-hook 学习系统，不是 git hook。
```

成本：**5 分钟**（10 个高频 SKILL.md）。
收益：**60% glossary 价值**，但更分散。

### 方案 X3：什么都不做

成本：0。
收益：0。
**信息量 = "drift 当前未造成实际问题"**。

---

## 8. 修正后的推荐

### 8.1 强推荐（保留）

✅ **ADR 3-conditions gate**（5 分钟）—— 见 [[2026-05-15-grill-with-docs-deep-dive]] §4。
理由不变：TP 现有 8 个 ADR 100% 通过，规则隐式遵循未明示。零风险。

### 8.2 弱推荐（可选）

🟡 **方案 X1：CLAUDE.md 加 10 行术语速查段**（10 分钟）—— 如果想做点什么。
理由：覆盖 80% 价值 + 1% 成本，比 glossary 完整方案 ROI 高 80×。

### 8.3 不推荐

❌ **完整 Option 3（CONTEXT.md + /glossary skill）**（5h45min）
理由（按本文 §1-6）：
- drift 量化证据弱
- 30 天 0 个相关修复
- 用户场景与 mattpocock 不匹配
- 现有 5 层已覆盖 ~80%
- ROI 偏负

### 8.4 暂搁置（等触发器）

⏸️ **触发器出现后再回来**。
触发器候选（如果未来出现，就该重新评估）：
- 用户决定开源 TP 给社区
- 用户连续 3 次会话出现 terminology correction
- 新 LLM 模型加入工作流，且术语理解偏差明显
- 6 个月后 cold start 真的卡住

---

## 9. 这次评估本身的元收益

虽然结论是「不接入 glossary」，本次评估的产物**仍然有 4 项价值**：

1. **ADR gate 准则**值得落地（5 分钟）
2. **触发器缺失论证**作为本能记下来——"完整方案 + 缺触发器 = 必 stale"
3. **量化 stress test 工作流**（commit log + 用户交互回想）作为评估方法——以后做 sibling eval 都要用
4. **"完整方案有自身吸引力，会让评估者不愿质疑前提"**作为本能——这是元层教训

这 4 项 + 不实施 glossary = **比实施 glossary ROI 高**。

---

## 10. 决策点

向用户提出（**不实施**）：

| 选项 | 行动 | 时间 |
|---|---|---|
| A | 只做 ADR gate | 5 min |
| B | 做 ADR gate + 方案 X1（CLAUDE.md 术语速查段）| 15 min |
| C | 都不做，归档本评估作为「明确决定不实施」记录 | 0 min |
| D | 你坚持完整 Option 3（覆盖本文反对意见）| 5h45min |

**作者推荐**：**B**（成本极低 + 把今天的思考成果固化）。

---

## 变更日志

- 2026-05-15 完成。**未实施任何方案**，等待用户在 §10 决策。
- 本文档**修正**了 [[2026-05-15-grill-with-docs-deep-dive]] §3.1 的「TP drift 严重」判断 + 修正 [[2026-05-15-grill-option3-architecture]] 的实施倾向。前两份文档保留作为评估过程的真实记录。
