---
title: "Superpowers v6.1.1-v6.3 增量评估：借一项，验证六项，不融合整套方法论"
date: "2026-09-04"
status: completed
type: solution
tags: [solution, sibling-eval, superpowers, testing, multi-agent]
related_solutions:
  - "[[2026-07-01-superpowers-gstack-june-2026-eval]]"
source_plan: "[[2026-09-04-superpowers-v63-eval]]"
source_commit: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797"
---

# Superpowers v6.1.1-v6.3 增量评估

> Status: `completed`。三路独立 reviewer 在修订后均为 PASS。

## 结论

Superpowers 最近几版的主线不是“又多支持几个 agent”，而是把昂贵、易漂移的 SDD 流程变成更可见、更省 seat 的控制循环。对 Tech Persistence，现阶段只有一项具备足够本地用户价值证据，可进入 P1：

1. **测试可证伪门（P1）**：写测试时必须能指出哪个生产变更会令它失败；优先行为观察，拒绝只 grep 文本存在或常量 change-detector。

冲突预检、同形批处理、任务级 no-nesting、scoped fix loop、skill compression、spawn cost policy 共六项降为 P2/条件实验。没有 TP 本地失败样本、基线与晋级阈值前，不改双 runtime SoT。本结论不是立即实施授权。

13 个候选的互斥主决策为：P1 1 项、P2 6 项、cross-ref 4 项、hard reject 2 项。C10 的 blanket-pin surface 被拒，但主决策已翻为 P2，不重复计数。

## 最近更新到底是什么

最新正式版是 [v6.3.0](https://github.com/obra/superpowers/releases/tag/v6.3.0)（2026-08-12）；v6.2.0 发布于 2026-07-23。既有评估只覆盖到 v6.1.0，因此完整窗口 v6.1.0..v6.3.0 为 63 commits / 78 files；其中 v6.1.1..v6.3.0 为 53 commits / 76 files。2026-09-04 检查 `dev` 后，v6.3.0 之后没有新的功能 diff，只有 Code of Conduct 更新。

### v6.1.1

- 修复 Codex hook auto-discovery，并调整 portal packaging；这 10 commits / 15 files 属于旧基线之后的增量，不能从统计窗口漏掉。

### v6.2.0

- SDD workspace 从全局 scratch 改为 plan-scoped。
- review fix 改成 resume 原 implementer、scoped re-review、五轮 breaker。
- 大规模压缩 skill：删 recap/social proof，把真正影响行为的 rebuttal 放回触发点，并用微型行为测试守住效果。
- TDD 文档新增 falsifiability discipline，明确指出 string-presence 与 change-detector 两类伪测试。

### v6.3.0

- brainstorming 分成 spike / bounded / architectural，按任务厚度缩放 ceremony。
- plan conflict 不再无条件卡住：低风险冲突写 ruling 后继续；preflight 必须留下检查表。
- 同形小任务合批，review 对照文件清单防漏改。
- implementer/reviewer 禁止继续 spawn 子代理。
- Codex 改为事件等待、显式 model/effort、校正工具映射。
- worktree 清理遇未跟踪文件时列出实际文件并停下，不用 force。

visual companion/server 是早于本轮窗口的既有架构面；本文只把它用于判断当前整包是否适配，不把它列为 v6.2/v6.3 新增能力。

## 为什么不整包融合

Superpowers 是完整软件开发方法论；TP 是双运行时、可审计的 self-evolution/toolchain。整体对齐为 **partial**：MR partial/unknown，DET/LT partial，OBS fail。尤其是：

- Superpowers 的 SDD ledger 完成后删除，以 git 为最终记录；TP 的核心是 Markdown/frontmatter/Obsidian 与 authority evidence。
- Superpowers 的关键流程仍主要由 prompt 驱动；TP 已把 acceptance、contract hash、CAS、Receipt/readback 下沉到确定性 runtime。
- visual companion 是额外本地 server，并有可选远程版本 telemetry；TP 没有为它新增 daemon 的理由。

因此只抽 spine，不 mirror 命令、技能、harness 或目录结构。

## 已有能力，不重复造轮子

| Superpowers 机制 | TP 当前事实 | 决策 |
|---|---|---|
| ceremony scales | `think/plan/work` 已按可逆性与 L0-L4 缩放 | cross-ref；不接受“所有路径都必须停等批准” |
| plan `Spec:` pointer | v1 Sprint acceptance marker + frozen Contract；agent-loop 有 run/contract evidence | scoped cross-ref；普通 `/plan` 不声称同等 run 绑定 |
| non-catastrophic ruling | `clarifications.md` append-only channel，implementer 可带假设继续，review gate ruling | 已实现 |
| plan-scoped workspace | v1 Sprint 与 agent-loop 有 run-scoped identity，冲突时拒绝覆盖；普通 `/plan` 仍有绑定缺口 | 不复制 basename 方案，缺口另行设计 |
| event-driven wait | Codex `wait_agent` 已是事件订阅，当前 work/review 使用该工具 | 不重复平台文档 |
| skill size control | `scripts/skill-size-budget.js` + skill-eval | 复用现有基础设施 |
| untracked protection | orchestrator 用 `--untracked-files=all` 枚举并 fail closed；破坏性清理由项目级 policy gate 管理 | 不新增 cleanup skill |

## P2 / Backlog

### Conflict preflight、batching 与 no-nesting

三项目前只有上游收益论证，没有 TP 本地返工、seat 浪费或漏文件基线。C2 只在多任务共享接口且现有 Plan 证据不足时试验；C3 必须先定义 union ownership、逐子任务状态/测试、部分失败和 Claude worktree/Codex shared-tree 恢复语义；C4 需要 runtime/tool-denial 和 nested-dispatch 反例，不能靠 prose 宣称 DET Pass。晋级条件是成本下降且漏改率/完成率不退化。

### Scoped fix loop

“resume 原 implementer + scoped re-review + bounded breaker”是好 spine，但 TP 已有三轮 Work 修复上限、`needs-followup -> resume re-implement`、独立 review 与 frozen acceptance Receipt。先用真实 manual Work 失败样本证明现有回路浪费上下文或重复 review，再决定是否补充。不能把五轮这个数字当通用常量照搬。

### Skill compression campaign

现有 size report 证明其扫描范围内仍有重 skill surface，但不覆盖全部 Codex-native/plugin skill；`test-codex-native-skill-projection.js` 还暴露 `compound/SKILL.md` 超过 4096-byte 预算。下一步应先补齐测量口径，再挑一条高频 skill 做 A/B behavior eval。

### Spawn cost policy

Superpowers 的“每次显式 pin model+reasoning effort”解决了上层 session model 被所有 child 继承的成本问题，但 TP/Codex 的 `fork_turns`、模型可用性和准确性策略不同。先记录 inherited/explicit 决策与成本，再定义 policy；不在 prose 中硬编码某个模型档位。

这是唯一真实 defensive flip：初始 blanket-pin surface 被拒，但候选最终处置改为 P2 cost visibility/policy，而不是第三个 hard-reject candidate。

## Hard Reject 与 Defensive Flip

| Surface hard reject | 原因 | 保留的 spine / landing |
|---|---|---|
| `.superpowers/sdd/<plan-basename>` | 发布后已有同 basename 碰撞复现；完成即删除也不满足 OBS | v1 Sprint/agent-loop 采用 run-scoped identity，冲突时拒绝覆盖 |
| harness 扩张 + visual server/telemetry | 与 TP 定位无关，增加分发、daemon、隐私表面 | “视觉问题用视觉媒介”继续走已有 Figma/visualization 路由 |

C8/C12 仍是两个 hard-reject candidate，只把其中有效 spine cross-ref 到现有 landing；它们不计 flip。只有 C10 改变了初始处置，满足 defensive challenge 的至少一个真实 flip。因此互斥口径保持 `13 = 1 + 6 + 4 + 2`。

## 已知上游风险

- [#2045](https://github.com/obra/superpowers/issues/2045)：plan-scoped workspace 仍会在相同 basename 时碰撞，说明不能复制路径算法。
- [#2130](https://github.com/obra/superpowers/issues/2130)：v6.2+ 后部分 Claude skill tests 仍断言旧行为，说明 release notes 不等于完整回归绿。
- [#2157](https://github.com/obra/superpowers/issues/2157)：v6.3 Hermes tool mapping 有 stale name 问题，提醒 harness breadth 会放大 parity 维护成本。
- [#2197](https://github.com/obra/superpowers/issues/2197)：OpenCode 非交互会话没有 bootstrap 注入，说明“支持某 harness”要按运行形态拆开验证。

## 推荐顺序

| Rank | 动作 | 风险 | 验证 |
|---:|---|---|---|
| 1 | 给 Claude `test/work`、Codex `test-strategy/work` SoT 及两份 testing-patterns rule 加 falsifiability gate | L1 | 双 runtime 选现有 grep-style 测试做 mutation-style 反例 |
| 2 | 条件试验 conflict preflight | L1 | 只选共享接口 fixture；clean plan 不膨胀，返工率下降 |
| 3 | 对同形微任务 batching 做 A/B eval | L2 | dispatch/token 下降且漏文件率、完成率不退化 |
| 4 | 评估 task-scoped child no-nesting 的 runtime enforcement | L2 | planted nested-dispatch scenario，确认 controller 分解不受损 |
| 5 | 补齐 skill size 测量后做一次 compression A/B | L1 | 行为 eval 不退化、预算测试恢复绿色 |
| 6 | 只在真实失败样本出现后评估 scoped fix loop | backlog | 重复 review 次数与上下文成本 |
| 7 | 测量 inherited/explicit model+effort 的成本与质量 | backlog | 先得成本/成功率基线，再决定是否需要 spawn policy |

## Review 状态

- product-lens：PASS（首轮异议已修复）
- coherence：PASS（首轮 concerns 已修复）
- feasibility：PASS（首轮异议已修复）
- defensive challenge：1 个真实 flip（C10）
- secret self-capture：N/A，本轮未运行 secret regex scan

## 产物与边界

- Plan：[[2026-09-04-superpowers-v63-eval]]
- 本文只做研究决策；未实施 runtime/skill/rule 变更。
- 未写 learning/instinct，未 commit，未 push。
