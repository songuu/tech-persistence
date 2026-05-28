---
name: review
description: Codex-compatible entry point for the former /review command. 多角度代码审查：安全/性能/架构/质量/测试覆盖(风险自适应) + design lens 条件触发
---

# Review

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/review` command.

## Invocation

Use `$review <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/review`, interpret that as this `$review` skill invocation while running in Codex.

## Command Instructions

# /review — 多视角审查模式

对当前变更进行多角度审查。

## 输入
- 无参数：审查 `git diff` 全部变更
- `$ARGUMENTS` 指定文件或目录：只审查指定范围
- `--auto`：自动审查 P0 修复（见下方"可选参数"）

## 可选参数

- `--auto`：自动审查模式。obvious P0（typo / 缺 import / null check / 类型不匹配 / 简单重命名）直接修复并继续；语义级 P0、destructive 改动相关 P0、auth/数据迁移相关 P0 仍保留人工 gate；P1 默认跳过确认。详见 `~/.codex/rules/auto-mode.md`。

## Spawn 协议（Codex 真并行）

**目的**：用 Codex Agent tool 真 spawn N 个独立 reviewer 子进程并行审查，达成 3 个核心目标 —— 分工明确（每 reviewer 单一视角）+ 减少总时间（5×T → 1×T）+ 提高效率（独立 context + 模型分层）。

> 以下仅对支持 Agent spawn 的 runtime 生效。Codex CLI 见下方「Multi-runtime fallback」段。

### 调用语法

按 Dispatch Matrix 选定的 reviewer 子集，**单条 message 内**发起多个 Agent tool 调用（重要：多调用必须在同一条 message 内才并发；分散到多条 message 会被串行化）：

```
Agent(subagent_type: "general-purpose", model: "<层级>", prompt: "<下方 Reviewer prompt template>")
Agent(subagent_type: "general-purpose", model: "<层级>", prompt: "...")
...（N 个 reviewer 并发）
```

### 4 status 返回契约

每个 reviewer 输出末尾必须含且仅含一行：

```
STATUS: <DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED>
```

状态定义：
- `DONE`：审查完成，无 P0/P1/P2 findings
- `DONE_WITH_CONCERNS`：审查完成，有至少 1 个 P1+ finding（含 P0）
- `NEEDS_CONTEXT`：reviewer 无法在当前 context 内完成审查，需主 LLM 补充上下文（必须说明缺什么）
- `BLOCKED`：结构性阻塞（如审查目标矛盾 / spec 不明确 / 测试基线失败），主 LLM 必须人工 escalation

**兜底规则**：reviewer 漏输出 STATUS 行 → 主 LLM 视为 `DONE_WITH_CONCERNS`（不报错，派遣记录的 status 分布字段会暴露漏判）。

### 模型分层（Agent tool `model` 参数可指定）

| 视角 | 模型层级 |
|------|---------|
| security 🔒 | `sonnet`（**永远不用 haiku**，安全锁死） |
| perf ⚡ | `sonnet` |
| arch 🏗️ | `sonnet` |
| quality 📝 | `haiku` |
| test 🧪 | `haiku` |
| design 🎨 (条件触发) | `sonnet` |

**为什么这么分**：security/perf/arch 需要深度推理（潜在漏洞 / 性能瓶颈 / 架构耦合），用 sonnet；quality/test 是模式化检查（命名 / 测试覆盖），haiku 足够且成本低。design lens 涉及视觉判断 + slop pattern 识别 + 设计语义对齐，需要 sonnet。

## Reviewer prompt template

每个 reviewer Agent 调用的 prompt 都遵循以下结构：

```
你是 <视角名> reviewer，本次审查仅聚焦 <视角> 维度。

变更范围：
<git diff 摘要 + 改动文件列表>

项目上下文：
<必要的 ADR / 本能 / 规则引用，最多 3 条>

审查任务：
按本视角检查上述变更，给出 P0/P1/P2 findings。

输出格式：
1. 派遣记录复述（视角名 + 评估 risk + 模型层级）
2. Findings table:
   | # | 文件:行 | severity | 问题 | 修复建议 |
   |---|---------|---------|------|---------|
3. 末尾必须一行: STATUS: <DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED>

约束：
- 仅关注 <视角> 维度；其他视角的问题不报
- NEEDS_CONTEXT 必须说明缺什么（"缺 X 文件" / "缺 Y 测试基线" 等）
- BLOCKED 必须说明结构性阻塞原因
```

视角维度（对照下方「5 个审查视角」段填空）。

### NEEDS_CONTEXT retry 流程（≤ 1 次硬限）

1. 主 LLM 收到某 reviewer `STATUS: NEEDS_CONTEXT` + 缺失项描述
2. 主 LLM 补充上下文（Read 缺失文件 / 跑 grep 等）
3. 重新 spawn 该 reviewer（同视角同模型 + augmented prompt）
4. **第 2 次仍 NEEDS_CONTEXT** → 视为 `DONE_WITH_CONCERNS` + 标 P1（避免死循环）

### BLOCKED escalation 流程

1. 主 LLM 收到某 reviewer `STATUS: BLOCKED` + 阻塞原因
2. 立刻打印 BLOCKED 报告（reviewer 视角 + 阻塞原因）
3. **强制人工 gate**：即使 `--auto` 模式也必须问用户（与 `~/.codex/rules/auto-mode.md` 强制人工边界一致：destructive / L4 / scope creep / **BLOCKED**）
4. 用户选择继续 / 修复阻塞 / 跳过该视角

### Rubric-gated revise loop（收敛闭环，可选）

**目的**：补齐 review 单遍缺口——质量未达标（P0 数 > 0 或 rubric 关键项 fail）时自动回 work 修复并重审，对标 grader + rubric 打回重做，而非单遍出报告即结束。

**触发门控**（两条件任一命中即触发，否则保持单遍）：

- risk 等级 L3 / L4，或
- `--auto` 模式

L0-L2 且非 `--auto`：跳过 revise loop，单遍 review（轻量 + token 成本门控，与 Dispatch Matrix 同源思路）。

**结构化 rubric**：reviewer findings 在 P0/P1/P2 之外，按视角关键项给出 pass/fail（rubric 关键项 fail 等价于该视角产出 P0）：

```markdown
## Rubric（每视角关键项 pass/fail）
| 视角 | 关键项 | pass/fail | 关联 finding |
|------|--------|-----------|-------------|
| security 🔒 | 无注入 / 无硬编码密钥 / 输入已验证 | fail | P0-1 |
| test 🧪 | 高风险文件测试深度匹配 | pass | — |
```

**收敛回路（N=2 硬限）**：

1. 汇总本轮 reviewer findings → 判定是否命中 revise 条件（P0 数 > 0 或 rubric 关键项 fail）。
2. 命中 → 触发一次 **work 微循环**：按 work 既有约定修复命中的 P0 / fail 项（不改 work 流程，revise loop 仅编排修复→重审的串接）。
3. 修复后**仅重 spawn 受影响视角** reviewer（不重审全套——例如仅 security fail 就只重 spawn security），重 spawn 用同视角同模型 + augmented prompt（含上轮 finding + 本轮修复 diff）。
4. 重审结果再判定：收敛（无 P0 且无 rubric 关键项 fail）→ 进 compound；未收敛 → 回步骤 2。
5. **轮数硬限 N=2**（类比 NEEDS_CONTEXT retry ≤1）：第 2 轮仍未收敛 → 停止迭代，未收敛项标记为遗留 P0/P1 写入 review 报告，进 compound（不无限循环）。

**人工 gate（不可被 loop 吞掉）**：

- 非 `--auto` 模式：命中 P0 时仍向用户呈现并等待确认——revise loop 仅在 `--auto` 下自动迭代 work 微循环；非 auto 下 loop 退化为「呈现 P0 → 用户确认修 → 重审」的人工驱动版。
- 任一 reviewer 报 `BLOCKED`：走上方 BLOCKED escalation（强制人工），即使 `--auto` 也不进 revise loop 自动迭代。
- destructive / L4 任务相关 P0：即使 `--auto` 仍保留人工 gate（与 `~/.codex/rules/auto-mode.md` 强制人工边界一致）。

**Multi-runtime 行为**（runtime gate 与 Spawn 协议一致）：

- spawn-capable runtime：重审走真并行 spawn（仅重 spawn 受影响视角子集）。
- inline-fallback runtime：无 Agent tool，revise loop 串行执行（主 LLM 单 context 内重新扮演受影响视角）；N=2 硬限与触发门控相同。

**派遣记录扩展**（revise loop 触发时追加，见下方「派遣记录」段）：

```markdown
- Revise loop: 触发（risk=L3）
- Revise 轮次: 2/2（轮1: security P0-1 → 修 → 重审; 轮2: 收敛）
- 收敛: 是 / 否（否则列遗留 P0/P1）
```

## Multi-runtime fallback

| runtime | spawn 机制 | 行为 |
|---------|----------|------|
| **Codex** | Agent tool + subagent_type + model + prompt | 上述真并行 spawn 协议生效 |
| **Codex CLI** | 不可用（无 Agent tool 等价物）| 主 LLM 在单 context 内 inline 扮演 N 视角（保留旧行为）|

**Codex 端 advisory**：上述 STATUS 契约对 Codex 端是建议而非强制。Codex 端主 LLM 仍可在 5 段审查文本末尾各加 STATUS 行以保持文档一致性，但缺失不视为协议违反。

## 风险驱动派遣（risk-aware dispatch）

**审查不是"5 视角全跑"，而是按 risk 选 reviewer 子集**，避免低风险变更被高成本审查拖慢。

### 流程

1. **评估风险**：先判定变更的最高 risk 等级（L0-L4，见 `~/.codex/AGENTS.md` 测试规则）。
2. **选择子集**：按下方 Dispatch Matrix 决定跑哪些视角。
3. **打印派遣记录**：审查报告开头必须列出跑了哪些、跳过哪些、为什么。
4. **执行 Gap Detection Walkthrough**：在 Findings 前检查"测试/规则已覆盖"与"真实工作流仍可能断裂"之间的缺口。

### Gap Detection Walkthrough

**目的**：吸收 GSD `verify-work` 的有效部分，但不新增 `/uat` 或 GSD 命令。审查不仅看 diff 是否局部正确，还要问：现有测试、hook、projection、invariant 是否真的覆盖了用户会触发的工作流。

审查报告在派遣记录后、Findings 前必须包含：

```markdown
## Gap Detection Walkthrough
| workflow / invariant | existing coverage | uncovered gap | action |
|----------------------|-------------------|---------------|--------|
| <用户路径或跨 sprint invariant> | <已有测试/脚本/人工验证> | <未覆盖缺口或 none> | <finding / follow-up / skip reason> |
```

触发规则：

| Risk | 要求 |
|------|------|
| L0 / L1 | 可跳过，但必须写跳过原因，例如"纯文案/样式，无跨 workflow invariant" |
| L2 | 至少检查测试覆盖与用户路径是否断裂；如改文档 SoT，检查 projection 是否同步 |
| L3 / L4 | 强制检查跨 runtime、projection、hook、state artifact、安全边界、回滚路径 |

若发现 "existing tests pass but workflow still broken" 风险，按 P1+ finding 处理。若发现跨 sprint invariant 破坏，按第 6 视角规则升级为 P0/P1。

### Dispatch Matrix

| Risk | 跑的视角 | Spawn 数 | 模型层级 | 跳过 |
|------|---------|---------|---------|------|
| L0 / L1 | 4 (quality) | 1 | haiku | 1 / 2 / 3 / 5 |
| L2 | 4 + 5 (quality + test) | 2 | haiku × 2 | 1 / 2 / 3 |
| L3 | 1 + 3 + 4 + 5 (security + arch + quality + test) | 4 | sonnet × 2 + haiku × 2 | 2 (perf) |
| L4 | 全套 5 个视角 | 5 | sonnet × 3 + haiku × 2 | — |

**不确定 risk 时**：**保守按 L3 处理**，不要默认 L1/L2。可疑信号包括但不限于：触及 auth / 鉴权 / 数据迁移 / 跨服务调用 / 公共 API / 用户输入边界 / 持久化层。

**Spawn 数与成本权衡**：L4 dispatch ≈ 5× Agent 调用（约 3 Sonnet + 2 Haiku）；如 token budget 紧张，可手动按 L3 跑（牺牲 perf 视角）。Codex 端无 spawn 成本概念（单 LLM context 内连续扮演 N 视角，总成本约等于 1× 主 LLM 调用 + 上下文膨胀）。

### Design lens 条件触发（在上述 5 视角之外额外 spawn）

design lens 不进固定 Dispatch Matrix（与「第 6 视角集成连续性」一样是条件叠加），按以下规则**额外** spawn：

**触发条件**（任一命中即触发）：

1. diff 含视觉相关文件扩展名：`*.tsx` / `*.jsx` / `*.vue` / `*.svelte` / `*.astro` / `*.css` / `*.scss` / `*.sass` / `*.less` / `*.styl`
2. diff 含 `figma.com/file` / `figma.com/design` URL 引用
3. commit message 或 sprint 文档含 `ui/` / `design:` / `style:` 前缀
4. sprint 文档 frontmatter `tags:` 含 `figma` / `design` / `ui` / `frontend`
5. PR 描述含 `design-review` 关键词

**跳过条件**：

- 仓库自身是纯 dev toolchain (无 UI 输出) 且 diff 全部是 backend / config / docs → 即使触发条件 1 命中也可跳过 (打印跳过原因)
- 触发条件 1 命中但变更仅是 `<style>` 内 token 替换 (例如 `padding: 12px` → `padding: var(--space-3)`) → 可降级为 P2 lens (haiku)

**Spawn 增量**：触发时在 Dispatch Matrix 选定子集基础上 +1 design reviewer (sonnet)，不替换其他视角。

**示例**：L3 + design 触发 = 5 reviewer (security/sonnet + arch/sonnet + quality/haiku + test/haiku + design/sonnet)。

### Reviewer 模型分层（与 Spawn 协议「模型分层」段一致，此处为视角中心视图）

| 视角 | 默认模型 | 强制最低 |
|------|---------|---------|
| 1. security 🔒 | sonnet | **永远不用 haiku** |
| 2. perf ⚡ | sonnet | sonnet |
| 3. arch 🏗️ | sonnet | sonnet |
| 4. quality 📝 | haiku | haiku |
| 5. test 🧪 | haiku | haiku |
| design 🎨 (条件触发) | sonnet | sonnet |

**security 锁死规则**：无论 risk 等级或速度需求，security 视角永远使用 sonnet 或更强模型。这是不可妥协的安全底线（即使主 LLM 跑 haiku 也不能让 security reviewer 跑 haiku）。

### 派遣记录（必须输出，放审查报告开头）

**Codex spawn 模式**（含 spawn 数 / status 分布 / retry / blocked 字段）：

```markdown
## 派遣记录
- 评估 risk: L3
- Spawn 数量: 4 reviewer (security/sonnet, arch/sonnet, quality/haiku, test/haiku)
- 跳过的视角: 2 perf
- 跳过原因: 本次变更不涉及性能关键路径
- Status 分布: 2 DONE_WITH_CONCERNS, 1 DONE, 1 NEEDS_CONTEXT (已 retry)
- Retry 计数: 1 (test reviewer NEEDS_CONTEXT → 补 test/ 目录 → retry → DONE)
- Blocked 计数: 0
```

**Codex inline fallback 模式**（不含 spawn 字段，保留旧格式）：

```markdown
## 派遣记录
- 评估 risk: L2
- 跑的视角: 4 quality, 5 test
- 跳过的视角: 1 security / 2 perf / 3 arch
- 跳过原因: 本次变更不涉及 auth / 跨服务调用 / 性能关键路径
```

若 risk 评估存疑而升级到 L3，必须额外打印（两种模式都适用）：

```markdown
- 升级路径: 不确定 → 保守按 L3
- 可疑信号: [具体描述，如"修改了 db 迁移脚本"]
```

若任何 reviewer 报 `STATUS: BLOCKED`，必须额外打印：

```markdown
- ⚠ BLOCKED 升级人工 gate: <视角名> 报告"<阻塞原因>"
- 等待用户决策（即使 --auto 模式也不跳过此 gate）
```

## 5 个审查视角（视角定义，按 dispatch 选用）

### 视角 1: 安全审查员 🔒
SQL 注入、XSS、CSRF、密钥硬编码、输入验证、权限检查

### 视角 2: 性能工程师 ⚡
N+1 查询、不必要全量加载、缺少索引、内存泄漏、可缓存未缓存

### 视角 3: 架构审查员 🏗️
是否遵循项目模式、分层边界、不必要耦合、DRY/YAGNI、与本能一致

### 视角 4: 代码质量 📝
命名语义、函数长度（>50行警告）、错误处理完整性、类型正确性、边缘情况

### 视角 5: 测试覆盖 🧪（风险自适应）

**不是简单检查"有没有测试"，而是检查"测试深度是否匹配风险等级"：**

对每个变更文件评估风险等级，然后检查实际测试：

```markdown
| 文件 | 风险 | 应测等级 | 实际用例 | 结论 |
|------|------|---------|---------|------|
| auth.ts | L4 | 20+ | 22 | ✅ 充分 |
| UserTable.tsx | L2 | 5-10 | 6 | ✅ 充分 |
| format.ts | L2 | 5-10 | 0 | 🔴 缺失 |
| table.css | L0 | 免测 | 0 | ✅ 正确 |
```

关键检查：
- 🔴 高风险文件(L3/L4) 测试不足 → P0 问题
- 🔴 Bug 修复无回归测试 → P0 问题
- 🟡 中风险文件(L2) 测试不足 → P1 问题
- ✅ 低风险文件(L0/L1) 无测试 → 正确（不浪费）

### 视角 design 🎨（条件触发）

**触发**：见上方「Design lens 条件触发」段。**双轨实现**：spawn-capable runtime 端调用用户级 `qa-design-review` skill；inline-fallback runtime 端内联精简 design audit prompt。两端均要求 reviewer 末尾输出 STATUS 行。

> **重要**：以下两段 prompt 模板的 runtime gate 由模板内部的"runtime gate"行明示，不依赖文档标题。codex regex 同步会保留 idiom-safe 标记，不会混淆两段。

#### Spawn-capable runtime prompt 模板（调用 gstack skill）

**Runtime gate**：仅 spawn-capable runtime (Codex / 等价 Agent tool 可用) 执行；inline-fallback runtime (Codex CLI) 读到此段跳过，使用下方 inline-fallback prompt 模板。

```
你是 design lens reviewer，本次审查仅聚焦视觉设计 / UX 维度。

变更范围：
<git diff 摘要 + 改动文件列表 + 任何关联的 figma URL>

项目上下文：
- 如仓库根有 DESIGN.md / design-system.md，优先以其为对齐基准
- 如 sprint 文档关联 figma 节点，对照 figma 设计稿

审查策略：
1. 优先调用用户级 skill `qa-design-review`（位于 ~/.codex/skills/design-review/SKILL.md；codex 副本中该路径被 regex 替换为 ~/.codex/skills/design-review/SKILL.md，但 codex runtime 不应到达本段——见 runtime gate）
2. 仅在 skill 不可用或仓库无可访问 URL 时，回退到下方 inline-fallback prompt 的内联 checklist
3. **如 skill 要求 clean working tree 但当前 diff 非空，跳过 fix-loop（Phase 7+），只跑 audit 段（Phase 1-6 + 10）**

输出：
1. 派遣记录复述 (视角: design 🎨, 模型: sonnet)
2. Findings table 按 P0/P1/P2 分级（参考 skill 的 high/medium/polish 映射：high→P0 if 影响用户首次印象 / 否则 P1, medium→P1, polish→P2）
3. 末尾必须一行: STATUS: <DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED>

约束：
- 仅关注设计 / 视觉 / UX；安全/性能/架构由其他 reviewer 负责
- 设计 token 偏差 (如 hardcoded color/spacing) → 升级 P0/P1 (与本仓库 Figma 1:1 还原 solution §3.B 对齐)
- AI slop pattern (purple gradient / 3-column feature grid / centered everything 等) → 至少 P1
- 不修改源代码（只 audit, 不 fix; fix 由用户 follow-up 决策）
- BLOCKED 场景: 无可访问 URL 且 diff 全是后端文件 → 视为误触发，输出 BLOCKED + 建议跳过
```

#### Inline-fallback runtime prompt 模板（内联精简 checklist）

**Runtime gate**：所有 runtime 通用，但优先级低于上方 spawn-capable 模板（仅在 skill 不可用或 inline-fallback runtime 下使用）。

```
你是 design lens reviewer，本次审查仅聚焦视觉设计 / UX 维度。

变更范围：
<git diff 摘要 + 改动文件列表 + 任何关联的 figma URL>

精简 audit checklist（参考 gstack qa-design-review skill, IP 浓缩版）：

A. 设计 token 对齐（与 Figma 1:1 还原 §3.B 同源）
   - hardcoded hex / px 出现在 token 应覆盖的位置 (color / spacing / font-size / border-radius)
   - 同一概念 spacing 多个不同值 (12/14/16 混用而非 4/8 倍数)

B. Typography
   - font 数量 > 3
   - 跳跃 heading 层级 (h1→h3 无 h2)
   - body 字号 < 16px

C. 颜色与对比度
   - 非灰唯一色 > 12
   - WCAG AA body 4.5:1 / 大字 3:1 未达

D. Spacing & Layout
   - 间距不在 4/8 基础 scale 上
   - 水平 scroll 出现在 mobile

E. 交互状态
   - 缺 focus-visible ring (outline: none 无替代)
   - 缺 hover / disabled / loading 状态
   - 触控目标 < 44px

F. AI Slop 反模式 (任一命中至少 P1)
   - 紫色 / 蓝紫渐变背景
   - 3 列 icon-in-circle + 粗标题 + 2 行描述 feature grid (典型 AI 模板)
   - 全居中文字 (text-align: center 普遍)
   - 统一大 border-radius (everything bubbly)
   - 装饰性 SVG blob / 浮动 circle / wavy divider
   - emoji 当装饰元素 (rockets in headings)
   - 卡片彩色左边框 (border-left: 3px solid accent)
   - 通用 hero 文案 ("Welcome to X" / "Unlock the power of" / "Your all-in-one solution")

G. Content & Microcopy
   - 占位 / lorem ipsum 残留
   - destructive 动作无 confirmation / undo
   - 按钮 label 不具体 ("Continue" / "Submit")

输出：
1. 派遣记录复述 (视角: design 🎨, 模型: sonnet, 端: codex inline)
2. Findings table:
   | # | 文件:行 或 截图位置 | severity | 问题 | 修复建议 |
3. 末尾必须一行: STATUS: <DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED>

约束：
- inline-fallback runtime 无浏览器 binary，仅基于源代码静态分析（不能跑 visual diff / screenshot），不强求 A-F 全覆盖
- 设计 token 偏差 → 升级 P0/P1
- AI slop 任一命中 → P1
- 不修改源代码
```

#### 双轨行为差异（必须文档化）

| 维度 | Spawn-capable runtime | Inline-fallback runtime |
|------|----------------------|------------------------|
| 实现 | 调 user-level `qa-design-review` skill | inline 精简 checklist |
| 工具依赖 | gstack browse binary (用户已装) | 无 |
| 输出能力 | screenshot diff / 实时 URL 抓取 / 性能 metrics | 静态源代码 audit only |
| Fix loop | skill 内置 (本 reviewer 跳过 Phase 7+) | 不支持 |
| 适用场景 | 已部署应用 / 本地 dev server | 任何 commit-time 静态审查 |

## 输出格式

```markdown
## 审查报告

### 🔴 P0 — 必须修复
| # | 视角 | 文件:行 | 问题 |
|---|------|---------|------|

### 🟡 P1 — 建议修复
| # | 视角 | 文件:行 | 问题 |
|---|------|---------|------|

### 🟢 P2 — 可选优化
| # | 视角 | 文件:行 | 问题 |
|---|------|---------|------|

### ✅ 亮点

### 总评
[1-2 句总结] 置信度: [可以发布/需要修复/需要重做]
```

## 审查后流程

> **L3+ 或 `--auto`**：P0 处理走上方「Rubric-gated revise loop」收敛回路（自动修 → 仅重 spawn 受影响视角 → N=2 硬限）。**L0-L2 且非 `--auto`**：单遍，按下列处理。

- P0：立即修复（L3+/--auto 进 revise loop 重审收敛；非 auto 仍人工确认后再修）
- P1：列出后等用户确认
- P2：记录 backlog
- 收敛或达 N=2 上限后 → `/compound`

## 与本能系统集成
- 审查时读取 rules/ 中的已知模式
- 发现新反模式 → 标注 `[🧠 新发现]`
- 新发现会在 /compound 中被提取为本能

## Phase 间预热钩子

完整 sprint 内执行时（`/sprint` 调用），本命令报告末尾**可选**追加「下一 Phase 预热」段（2026-05-22 起改建议非强制）。协议见当前命令集合中 `sprint.md` 的「Phase 间预热协议」。

本命令的典型预热内容：

```text
## 下一 Phase 预热（Phase 5: Compound）
关键文件: sprint 文档的 review 段、命中 P0 的关键源文件
执行命令: 读 P0/P1 处理记录、Grep .codex/rules/ 看是否需更新
风险预判: 未沉淀的非平凡经验、可从本能毕业到 rules 的高置信项、新发现的反模式
```

单独使用本命令（不在 sprint 内）时，预热段建议但非必须。

