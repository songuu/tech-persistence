---
title: "mattpocock/skills 后续评估：去掉 grill 后还剩什么值得吸收"
type: analysis
status: completed
created: "2026-05-18"
updated: "2026-05-18"
tags: [analysis, sibling-eval, mattpocock-skills, skill-design, testing, debugging]
aliases: ["mattpocock-skills-followup"]
sources:
  - https://github.com/mattpocock/skills
  - docs/plans/2026-05-15-mattpocock-skills-analysis.md
  - docs/plans/2026-05-13-command-usage-report.md
  - plugins/tech-persistence/commands/test.md
  - plugins/tech-persistence/commands/review.md
  - plugins/tech-persistence/commands/prototype.md
  - plugins/tech-persistence/commands/skill.md
---

# mattpocock/skills 后续评估

> 背景：`grill` / `glossary` 相关计划文件已删除。本文件继续回答：除 grill/glossary 外，mattpocock/skills 还有没有值得接入当前 TP 架构的东西？

## 关键假设验证

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| 上游 mattpocock/skills 当前技能清单仍是同一类结构 | Read GitHub README（2026-05-18） | 当前 README 显示 78 commits，Reference 仍按 Engineering / Productivity / Misc 分组列出 18 个 skill；核心设计未变 |
| 当前 TP 命令面不适合继续膨胀 | Read `docs/plans/2026-05-13-command-usage-report.md` | 5 月以来显式命令使用集中在 `/sprint`、`/compound`；多数命令靠对话式触发，不应因 sibling eval 再加新命令 |
| TP 已有与 tdd/review/prototype/skill 对应的本地架构 | Read `plugins/tech-persistence/commands/test.md`、`review.md`、`prototype.md`、`skill.md` | 已有风险自适应测试、多视角 review、截图原型收敛、skill 进化统一入口；更适合吸收原则而不是复制 skill |
| grill/glossary 不再作为候选 | Read 当前 `docs/plans` + git 状态 | `grill` / `glossary` 专题计划文件已删除，本轮只评估剩余机制 |

## 更新后的总判断

**不新增 mattpocock 命令。**

但值得从上游吸收 4 类“微机制”，全部以**嵌入现有命令/规则**的方式落地：

| 优先级 | 借鉴点 | 当前落点 | 形式 |
|--------|--------|----------|------|
| P1 | TDD 的 vertical tracer bullet + public-interface tests | `/test` 或 `test-strategy` | 补测试哲学，不新增 `/tdd` |
| P1 | Diagnose 的 “先建立可运行反馈环” | `.claude/rules/debugging-gotchas.md` 或未来 debug 流程 | 补调试规则，不新增 `/diagnose` |
| P1 | Architecture 的 deletion test / deep module 词汇 | `/review` architecture 视角 | 增加一个审查问题，不引入完整 `improve-codebase-architecture` |
| P2 | write-a-skill 的 progressive disclosure 约束 | `/skill diagnose` | 加一个诊断维度：SKILL 是否过长、是否该拆 reference |

明确不吸收：

| 不吸收项 | 理由 |
|----------|------|
| `to-prd` / `to-issues` / `triage` / `setup-matt-pocock-skills` | issue tracker workflow，会把 TP 从 self-evolution toolchain 拉向产品团队工单系统 |
| `setup-pre-commit` | TP 已有 `scripts/pre-commit-check.js` + dogfood 规则；Husky/lint-staged 是通用 app repo 方案 |
| `git-guardrails-claude-code` | 只覆盖 Claude Code，违反 multi-runtime parity；当前环境已有 sandbox/审批/非破坏性规则 |
| `handoff` | TP 的 checkpoint/context-handoff 更完整，且绑定 sprint 状态 |
| `prototype` 整体 | TP 的 `/prototype` 是截图需求收敛；mattpocock 是 throwaway runnable prototype，语义不同 |
| `zoom-out` 独立 skill | 可作为 `/review` 或 `/think` 的一句提示，不值得成为命令 |

## 二次评审与优先级校准（2026-05-18 增订）

> 原 §「更新后的总判断」P1/P1/P1/P2 排序基于直觉，未对照过去 3 个月 `debugging-gotchas.md` 实例，也未跑独立 reviewer。本节用 grep'd 实例数据 + 1 次 product-lens reviewer pass 校准，部分推荐被翻转。

### 1. Landing place 错配（reviewer 发现 2 处）

| 借鉴点 | 原文落地 | 校准后落地 | 理由 |
|--------|---------|-----------|------|
| Vertical tracer bullet + public-interface tests | `/test` 或 `test-strategy`（未择一） | **`test-strategy` skill** | `/test` 的单一职责是「测多深」（L0-L4 range），tracer bullet 是「怎么写」（style）；叠到 `/test` 让其规则集合从「深度判定」混入「编写风格」，破坏单职。`test-strategy` 是「怎么测」的 skill，是正确的层。 |
| Diagnose 的「先建反馈环」 | `.claude/rules/debugging-gotchas.md` | **`/work` bug 修复分支**（或新增 `work.md` 段） | gotchas.md 是 *lessons archive*（dated tactical entries），是注入时被读到，不是 bug 修复开始时被读到。「先建反馈环」是 *entry protocol*，必须在 bug 修复入口生效。Read 验证当前 `/work` 完全无此 guidance。 |

### 2. 优先级翻转（基于 `debugging-gotchas.md` 过去 3 个月实例）

| 借鉴点 | 原文 | 校准后 | 实例数 | 理由 |
|--------|------|--------|--------|------|
| 反馈环优先（→ `/work`） | P1 | **P1** | 多（fail-open testing / smoke 负样本 / skill scanner 验证 / ls glob 负样本）| 现状是 tactical 已分散落地，但缺总纲。Detection signal 已存在（3+ 轮调试触发 `/debug-journal`）。补一个 entry rule 把分散经验前置化，价值清晰。 |
| skill diagnose progressive disclosure | P2 | **P1**（↑） | 2 直接 | [[claude-skills-name-suffix-regex-permissive]] + [[reuse-existing-infra-before-building-new]]。skill 误诊 → 触发失败 → 自学习失效，影响半径**最深**（影响整个 evolution loop）。 |
| Vertical tracer bullet（→ `test-strategy`） | P1 | **P3**（↓） | 0 | 过去 3 个月无 batch-test 反模式案例。TP 主要工作是 evolution toolchain bug fix，不是 greenfield feature dev，触发场景少。等实际踩到再加。 |
| Deletion test（→ `/review` arch） | P1 | **P3**（↓） | 0 | 无浅抽象后悔实例。[[ADR-011]] / [[ADR-013]] 已在源头约束（identity-first + mechanism-over-discipline）。`/review` 架构视角已含分层/耦合/DRY/YAGNI，再叠 deletion test 稀释 reviewer 注意力。 |

### 3. 错误拒绝待复核

| 拒绝项 | 原拒绝理由 | reviewer 反驳 |
|--------|-----------|--------------|
| `handoff` | "TP 的 checkpoint/context-handoff 更完整" | TP `plugins/.../commands/checkpoint.md` 仅 80 行 = *snapshot writer*；mattpocock `handoff` 是 *resume-in-fresh-context 协议*。二者解决问题的两半，不是替代关系。「更完整」是防御性回应。**最小动作**：单独评估 mattpocock 的 resume-side prompt 结构（不在本 sprint 范围，记入 backlog）。 |

### 4. 修正后的执行顺序

如果后续要落地，按下列顺序：

1. **P1**：`/work` bug 修复分支增加「反馈环优先」entry rule（mattpocock #2）
2. **P1**：`/skill diagnose` 增加 progressive disclosure 维度（mattpocock #4）
3. **P3 / 不实施**：`test-strategy` skill 加 vertical tracer bullet（等实际踩到 batch-test 反模式再加）
4. **P3 / 不实施**：`/review` 加 deletion test（等实际踩到浅抽象后悔再加）

另：单独排期 `handoff` resume-side 评估（不在本 sprint）。

### 5. 元层学到的（本次评审本身）

- **status: completed 不代表已 review**：原文档跳过 `/review` 多视角 pass 就标完成，导致 2 处 landing 错配和 1 处错误拒绝在落地前才被抓到。这违反了 [[ADR-011]] sibling-eval 流程「必须 spawn ≥1 个 product-lens reviewer」。
- **优先级凭直觉 = 失准**：原文档 P1/P1/P1/P2 排序与实证数据不符（2 处升、2 处降）。结论：未来 sibling-eval 文档的优先级必须基于「过去 3 个月实例计数 + detection signal 是否已存在」打分，不能凭"听起来重要"判断。
- **拒绝清单同样要 review**：本次发现 1 个错误拒绝。reviewer 应同时挑战「为什么吸收」和「为什么拒绝」两侧，因为防御性拒绝（"我们已有的更完整"）是最隐蔽的 cargo-cult。

## 分项分析

### 1. `/tdd`：不复制命令，但吸收测试切片原则

上游有两个真正有价值的点：

- 测试公共接口和用户可观察行为，不测实现细节。
- 不要 “先写一堆测试，再写一堆实现”；应做 vertical tracer bullet：一个行为测试 → 一个最小实现 → 循环。

TP 当前 `/test` 的强项是 L0-L4 风险分级和测试深度匹配；弱项是没有明确约束 “horizontal slice” 风险。最小吸收方式是在 `/test` 或 `test-strategy` 里加两条规则：

```markdown
- 测试优先验证 public interface / observable behavior，不绑定私有实现。
- L2+ 新行为优先按 vertical tracer bullet 写测：一条行为测试通过后再写下一条，不批量生成想象中的测试矩阵。
```

这比新增 `/tdd` 更适合 TP，因为 TP 已经把测试嵌进 `/work` 和 `/review` 里。

### 2. `/diagnose`：吸收“反馈环第一”，不新建调试命令

上游 `/diagnose` 最强的一句是：没有快速、确定、agent 可运行的 pass/fail signal，就不要开始猜根因。

TP 当前已有很多 debugging-gotchas，但缺一个通用的 bug 调试入口规则。建议把它沉淀为规则：

```markdown
修非平凡 bug 前，先建立最小反馈环：测试、curl、CLI fixture、浏览器脚本、trace replay、throwaway harness、bisect 或 differential loop。没有反馈环时，必须显式报告尝试过什么，不能直接进入单假设修复。
```

这与 TP 的 “从源头看 / 先真实复现边界” 用户偏好一致。

### 3. `improve-codebase-architecture`：只拿 deletion test

完整上游 skill 绑定 `CONTEXT.md`、ADR、grill loop，不适合当前 TP；但其中 deletion test 很轻：

> 删除这个模块后，复杂度是消失了，还是重新散落到 N 个调用方？

这可以放进 `/review` 的 architecture reviewer。当前 `/review` 已看分层边界、不必要耦合、DRY/YAGNI；补一条 deletion test 可让 “浅模块 / pass-through abstraction” 更容易被发现。

建议落点：

```markdown
架构审查额外检查：对新增抽象做 deletion test。若删掉该模块后复杂度只是回到调用方，说明它可能是有价值的 deep module；若复杂度直接消失或接口几乎等同实现，说明它可能是浅抽象。
```

### 4. `write-a-skill`：吸收到 `/skill diagnose`

上游最值得吸收的是 skill 写作约束：

- `description` 是 agent 判断是否加载 skill 的唯一入口信号。
- `SKILL.md` 超过 100 行时应考虑拆 `REFERENCE.md` / `EXAMPLES.md` / `scripts/`。
- 确定性、重复性操作应下沉到 scripts。

TP 已经有 `/skill diagnose/eval/improve/publish`，不需要 `write-a-skill`。但 `/skill diagnose` 可以增加一个维度：

| 检查项 | 触发 |
|--------|------|
| description 是否包含清晰 trigger | 模糊描述导致误触发/漏触发 |
| SKILL.md 是否过长 | >100 行且含多个领域 |
| 是否应拆 reference | 长协议、低频高级用法挤占主入口 |
| 是否应脚本化 | 同一 deterministic 操作反复由 LLM 生成 |

这项是本轮最稳的 skill-system 收益。

### 5. `prototype`：保留差异，不合并

上游 prototype 是 “throwaway code answers a question”：逻辑问题做 terminal app，UI 问题做多变体 route。

TP `/prototype` 是 “截图 → 假设驱动需求收敛”。二者名字相同但用途不同。强行合并会让 TP 的原型截图工作流变浑。

可以只吸收一句通用规则：

```markdown
如果确实写 throwaway prototype，必须从文件名/路由名标明 prototype，用完删除或把结论吸收到正式代码/ADR/notes。
```

不建议现在改 `/prototype`。

## 推荐执行顺序

> ⚠ 本节为**初版推荐**；优先级与 landing place 已在「二次评审与优先级校准」§修订。本节保留作为审计轨迹，不再代表当前结论。

如果后续要落地，建议只做 3 个小 patch：

1. `/test` 或 `test-strategy` 增加 public-interface tests + vertical tracer bullet。
2. `/review` architecture 视角增加 deletion test。
3. `/skill diagnose` 增加 progressive disclosure / description trigger 诊断维度。

可选第 4 个：

4. `.claude/rules/debugging-gotchas.md` 增加 “反馈环第一” 调试规则。

这些改动都不新增命令，不触碰 install/build/projection 新表面，符合当前 TP 的 lightweight + parity 约束。

## 与 2026-05-15 文档的关系

`docs/plans/2026-05-15-mattpocock-skills-analysis.md` 保留为第一次全量对照。本文覆盖其后续修正：

- grill/glossary 已明确不进入架构提供。
- “mini-sprint 评估 CONTEXT.md” 后续已取消。
- 剩余可吸收价值从 “命令级导入” 收敛为 “现有命令里的微机制增强”。

## 实施记录（2026-05-18 第三次）

> 二次评审校准后的 2 个 P1 patch 已落地。本节记录具体 diff、验证结果、与原推荐的偏差。

### 已实施

| Patch | 源文件 | diff 摘要 |
|-------|-------|----------|
| **P1 反馈环优先** | `user-level/commands/work.md` (+5 副本) | 新增 H2「非平凡 bug 调试入口规则（反馈环优先）」段，位于「偏差处理」与「进度报告」之间。含触发条件（task 测试连续失败 ≥ 2 轮 / 行为偏差但根因不明 / sprint 外临时调试）+ 5 种反馈环形式（失败测试 / curl / 浏览器脚本 / harness / bisect）+ 禁止单假设修复约束 + 适用/不适用边界 + "为什么是 entry rule 而非 tactical lesson" 的理由。+27 行 × 3 源/plugin/codex |
| **P1 progressive disclosure** | `user-level/commands/skill-diagnose.md` (+5 副本) | 在「## 输出格式」code block 内、本能差异与诊断结论之间新增 4 维度：description trigger 清晰度 / SKILL.md 行数（<100 健康 / 100-200 警告 / >200 拆分阈值）/ 应否拆 REFERENCE/EXAMPLES / 应否脚本化。frontmatter `description` 追加 "progressive disclosure"。+10 行 × 3 源/plugin/codex |

### 验证

- ✅ `node scripts/propagate-command-changes.js work skill-diagnose` — 8 个目标全部 ok（command × 2 runtime + skill wrapper × 2 runtime + user-level skill × 1）
- ✅ `node plugins/tech-persistence/scripts/build-codex-plugin.js` — 22 commands / 32 skills / 15 hooks 全部生成
- ✅ `node scripts/pre-commit-check.js` — exit 0（多副本 sha consistency 通过）
- ⚠ `node scripts/validate-codex-plugin.js` — 1 个**预存在**失败 `[FAIL] skills/compound/SKILL.md contains Claude-only text`，与本 sprint diff 无交集（diff 不含 compound 任何文件），记入 backlog 单独排查

### 与原推荐的偏差

- 原文档 §「推荐执行顺序」列 3+1 个 patch；本次按二次评审校准后**只实施 2 个 P1**。
- vertical tracer bullet（原 P1）→ 降 P3 / 不实施。理由：0 batch-test 反模式实例。
- deletion test（原 P1）→ 降 P3 / 不实施。理由：0 浅抽象后悔实例 + ADR-011/013 已在源头约束。
- feedback loop 落地从 `debugging-gotchas.md`（原文档建议）改到 `/work` bug 修复分支（reviewer 发现的 layer 错配）。
- handoff resume-side 单独评估推迟到独立 sprint（不在本范围）。

### 待观察的 detection signal

- **反馈环 entry rule 是否真在 bug 修复时被触发**：观察未来 `/work` 内 task 失败 ≥ 2 轮的会话，是否出现"先建反馈环 → 再修"的行为模式。若未出现 = entry rule 未起作用，需考虑下沉为工具层 enforcement（mechanism over discipline，[[ADR-013]]）。
- **progressive disclosure 维度是否抓出问题**：下次跑 `/skill diagnose` 时观察是否报告 SKILL.md >100 行 / description 模糊等具体 finding。

## 变更日志

- 2026-05-18：完成 follow-up。未修改命令实现；只给出后续可落地的最小 patch 列表。
- 2026-05-18（二次）：补 review pass + 优先级校准。证据源：grep `debugging-gotchas.md` 过去 3 个月实例 + Read 3 个目标命令文件验证 capacity + 1 product-lens reviewer pass。结论：反馈环 + skill diagnose 维持/上调 P1（多实例 / 影响系统核心）；vertical tracer + deletion test 降 P3（0 实例 + 源头已约束）；landing place 修正 2 处（`/test` → `test-strategy`；`debugging-gotchas.md` → `/work` bug 分支）；`handoff` 拒绝判断为防御性回应，记入 backlog 单独评估。本次本身落地 [[ADR-011]] "sibling-eval 必须 ≥1 product-lens reviewer" 协议。
- 2026-05-18（三次）：实施 2 个 P1 patch。`/work` 加「非平凡 bug 调试入口规则（反馈环优先）」H2 段；`/skill diagnose` 加 progressive disclosure 4 维度（含 description trigger / 行数阈值 / 拆分判断 / 脚本化判断）。详见 §实施记录。validate-codex-plugin 报 1 个预存在 compound/SKILL.md issue 记入 backlog。
