---
description: "多角度代码审查：安全/性能/架构/质量/测试覆盖(风险自适应)"
---

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

> 以下仅对 Codex runtime 生效。Codex CLI 见下方「Multi-runtime fallback」段。

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

**为什么这么分**：security/perf/arch 需要深度推理（潜在漏洞 / 性能瓶颈 / 架构耦合），用 sonnet；quality/test 是模式化检查（命名 / 测试覆盖），haiku 足够且成本低。

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

### Dispatch Matrix

| Risk | 跑的视角 | Spawn 数 | 模型层级 | 跳过 |
|------|---------|---------|---------|------|
| L0 / L1 | 4 (quality) | 1 | haiku | 1 / 2 / 3 / 5 |
| L2 | 4 + 5 (quality + test) | 2 | haiku × 2 | 1 / 2 / 3 |
| L3 | 1 + 3 + 4 + 5 (security + arch + quality + test) | 4 | sonnet × 2 + haiku × 2 | 2 (perf) |
| L4 | 全套 5 个视角 | 5 | sonnet × 3 + haiku × 2 | — |

**不确定 risk 时**：**保守按 L3 处理**，不要默认 L1/L2。可疑信号包括但不限于：触及 auth / 鉴权 / 数据迁移 / 跨服务调用 / 公共 API / 用户输入边界 / 持久化层。

**Spawn 数与成本权衡**：L4 dispatch ≈ 5× Agent 调用（约 3 Sonnet + 2 Haiku）；如 token budget 紧张，可手动按 L3 跑（牺牲 perf 视角）。Codex 端无 spawn 成本概念（单 LLM context 内连续扮演 N 视角，总成本约等于 1× 主 LLM 调用 + 上下文膨胀）。

### Reviewer 模型分层（与 Spawn 协议「模型分层」段一致，此处为视角中心视图）

| 视角 | 默认模型 | 强制最低 |
|------|---------|---------|
| 1. security 🔒 | sonnet | **永远不用 haiku** |
| 2. perf ⚡ | sonnet | sonnet |
| 3. arch 🏗️ | sonnet | sonnet |
| 4. quality 📝 | haiku | haiku |
| 5. test 🧪 | haiku | haiku |

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
- P0：立即修复
- P1：列出后等用户确认
- P2：记录 backlog
- 全部处理后 → `/compound`

## 与本能系统集成
- 审查时读取 rules/ 中的已知模式
- 发现新反模式 → 标注 `[🧠 新发现]`
- 新发现会在 /compound 中被提取为本能

## Phase 间预热钩子

完整 sprint 内执行时（`/sprint` 调用），本命令报告末尾**必须**追加「下一 Phase 预热」段。协议见当前命令集合中 `sprint.md` 的「Phase 间预热协议」。

本命令的典型预热内容：

```text
## 下一 Phase 预热（Phase 5: Compound）
关键文件: sprint 文档的 review 段、命中 P0 的关键源文件
执行命令: 读 P0/P1 处理记录、Grep .codex/rules/ 看是否需更新
风险预判: 未沉淀的非平凡经验、可从本能毕业到 rules 的高置信项、新发现的反模式
```

单独使用本命令（不在 sprint 内）时，预热段建议但非必须。
