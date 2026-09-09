---
description: "架构师视角生成结构化实现计划，含任务拆解、风险评估、测试策略"
---

# /plan — 技术规划模式

切换到架构师/技术负责人视角。将需求转化为可执行的实现计划。

## 用法

```
/plan <需求或文件>      ← 生成计划，结尾询问是否进入 /work
/plan --auto <需求>     ← 自动审查：任务数 ≤ 8 且无 L3/L4 任务时自动给出可执行计划，无需终审 'go'
```

## 可选参数

- `--auto`：自动审查模式。计划终审 gate 由模型自主判断；任务数过多、含高风险任务、scope 与原始需求不一致时仍保留人工 gate。详见 `~/.claude/rules/auto-mode.md`。

## Sprint Acceptance 边界

`acceptance_protocol=v1` 本身不选择 Harness，也不授权把计划发送给外部 provider。只有用户为**当前 Sprint**显式选择 Harness Acceptance 时，才在 Plan 验收后 freeze Contract 并运行 `bind-acceptance`；`--auto`、需求中的领域词、已安装 adapter 或历史偏好都不算显式选择。未选择或尚未成功绑定时，由当前宿主继续 Plan → Work，不得要求外发授权或因非当前 provider 不可用而阻塞。显式绑定成功后保持失败闭合。

## Architectural shadow pilot

Think 明确路由为 `architectural-like`，或 Plan 研究发现同等 architectural 信号时，才启用 shadow design-authority；probe/bounded 路径不得为此增加文档税。在当前计划文件中写入一次：

```markdown
<!-- design-authority:start -->
## Design Authority（shadow）
- 问题与用户价值：...
- 范围 / 非目标：...
- 备选方案、选择与理由：...
- 组件、消费者接口、状态与错误路径：...
- Acceptance Criteria：
  - AC-1: WHEN ... THE SYSTEM SHALL ...
<!-- design-authority:end -->
```

该区块是 acceptance criterion 的唯一语义 owner；实施任务只引用 `AC-*`，不复制或改写 statement。计划确认后按约定冻结，修改时显式记录 revision 并重新检查任务，不静默改变设计。提交计划前 inline 检查四项：`placeholder`、内部一致性、`scope`、歧义。

若活动 Sprint 使用 `acceptance_protocol=v1`，acceptance checklist 只是 statement 的精确 transport projection，不成为第二语义 owner；shadow 阶段仍不自动校验 AC ID 映射。

这是可回滚的同文件 shadow pilot：不计算 design-authority digest/hash，也不接入 lineage runtime 或 Work/Review gate，不创建独立 spec 文件。当前用户指令、系统/项目规则和权限边界始终优先。

## 角色约束

你现在是架构师，不是产品经理也不是码农。

- ✅ 关注：技术方案、任务拆解、风险点、依赖关系、测试策略
- ❌ 不关注：产品定义（应在 /think 完成）、具体代码实现

## 规划深度自适应

计划的详尽度跟「任务可逆性 × 规模」走，不是所有任务都值得完整 80/20：
- 可逆 + 小（纯文案/样式/局部改名）→ 轻量计划：跳过完整风险表/多 phase，直接给任务清单
- 常规开发 → 标准计划（任务拆解 + 风险评估 + 测试策略，如下）
- 不可逆 或 高风险（支付/认证/数据/迁移/删除/对外发布）→ 完整 80/20 + 多方案对比 + 完整风险表

判定优先级 **可逆性 > 规模**：可逆性低即使规模小也升档（数据迁移、删分支/文件、对外发布、覆盖共享状态）。与全局「规划深度规则」一致。

## 输入来源（按优先级）

1. `$ARGUMENTS` 中直接描述的需求
2. `docs/plans/` 下最新的项目文档（由 /think 创建）
3. 对话上下文中的需求描述

## 执行步骤

### 1. 研究阶段

在制定方案前先研究：

- 读取项目 CLAUDE.md 了解架构约定
- 读取 `.claude/rules/` 了解已有经验和踩坑记录
- 读取相关源码文件了解现有实现模式
- 检查高置信度本能（`~/.claude/homunculus/`）了解项目偏好

### 2. 方案设计

输出结构化计划：

```markdown
## 技术方案

### 方案概述
[1-2 段描述整体方案]

### 任务拆解
按实现顺序排列，每个任务应在 1 次 agent 执行中可完成。
对每个 task 显式评估是否标 `[P]` 可并行（即使决定不标也是显式决策）。

- [ ] **Task 1 [P]**: [描述] — 文件: `path/a.md` — 风险: L?
- [ ] **Task 2 [P]**: [描述] — 文件: `path/b.md` — 风险: L?
- [ ] **Task 3**: [描述] — 依赖 Task 1+2 — 风险: L?

### 测试策略
- 单元测试: [覆盖什么]
- 集成测试: [覆盖什么]
- 手动验证: [需要检查什么]

### 风险评估
| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|

### 涉及文件
[列出会新建/修改的文件清单]
```

### 2.5 [P] 并行标记判定

对每个 task 评估是否标 `[P]`：

**满足全部 3 条 → 标 `[P]`**：
1. **不同文件**：本 task 涉及文件集合与其他 `[P]` task 涉及文件集合的**交集 = ∅**（单 task 改多文件时按集合比对，不是按"似乎相关"判断）
2. **无未完成依赖**：不依赖任何前置 task 的产物（如 T1 写 `lib/foo.js`，T2 写 `test/foo.test.js` 引用 T1 导出 → T2 不标 [P]）
3. **风险 ≤ L2**：L3/L4 task 即使无冲突也强制串行，便于人工逐 task 把关

**默认不标 `[P]`**：拿不准时不标，遵循"少标比误标好"。`[P]` 漏标只是损失连续处理优化机会；误标会让 work 阶段绕过质量门或产生文件冲突。

**与 `agent-loop --pipeline` 的边界**：`[P]` 是 LLM 协议层标注 + 连续处理提示，**不是**真实多 worker 调度。真正需要跨 agent 异步并发（spec → implementation → review 流水线）请用 `agent-loop --pipeline`，不要把 sprint `[P]` 升级成轻量 orchestrator。

**正反例参考**：

| 场景 | 标记 | 理由 |
|------|------|------|
| 3 个独立文档修改（不同文件、无依赖、全 L1） | 全部 [P] | 无冲突、无依赖、低风险 |
| T1 改 SoT command + T2 跑 propagate | T1 [P] / T2 串行 | T2 依赖 T1 产物 |
| T1 改 package.json + T2 改 package.json | 全部串行 | 同文件并发会后写覆盖 |
| T1 L4 (认证) + T2 L1 (文档) | 全部串行 | L4 强制串行 |

### 2.6 契约边界标注（条件性，触发即必填）

当 plan 涉及以下任一类型的变更时，技术方案段**必须**包含「契约接口」段（before/after 表）：

1. **多运行时 projection 契约**：`scripts/lib/hook-registry.js` 等定义 Claude/Codex 双副本事件、matcher、路径占位的逻辑 registry（[[ADR-014]] 单一语义源头）
2. **Spec-implementation-review 契约**：`scripts/agent-orchestrator/schemas/*.json` 等 orchestrator 状态机消费的 JSON Schema
3. **SoT-projection transform**：`scripts/propagate-*.js`、`build-codex-plugin.js` 等把源 SoT 转换为派生副本的脚本
4. **Git tracked 派生文件的 transform 规则**：任何被 `pre-commit-check.js` 强制 sha256 校验的派生关系

**契约接口段格式**：

```markdown
### 契约接口

| 契约名 | Before | After | 影响副本 / 消费者 |
|--------|--------|-------|------------------|
| <契约名> | <旧形态> | <新形态> | <受影响的副本/脚本/测试列表> |
```

**为什么必填**：本项目 4 不可妥协原则之一是"多运行时 parity"。变更上述契约 = 跨副本影响 = 必须前置显式列清楚 before/after + 受影响消费者，否则 work 阶段易漏改某副本（典型踩坑：[[plugin-migration-cascade-cleanup]]）。

**未触发场景**：纯文档修改、单 SoT 命令调整（如本 sprint 的 `[P]` 协议加入）、独立 feature 实现等，无需填写此段。

### 3. 置信度检查

对计划做自我评估：

- **高置信** (>80%): 方案明确，直接进入 /work
- **中置信** (50-80%): 有不确定点，标注出来请用户确认
- **低置信** (<50%): 需要用户提供更多信息或做原型验证

### 4. 条件性持久化

不要仅因调用 Plan 就持久化：

- `probe-like` / `bounded-like` 的独立、可逆任务可在 chat 内给出计划；用户明确要求、已有活动 Sprint 或需要跨 agent/会话共享时才写文档。
- `architectural-like` 必须把 shadow design-authority 与实施计划写在同一个 `docs/plans/YYYY-MM-DD-<需求简写>.md`；若已有 /think 或 Sprint 文档则更新该文件，不再创建第二份设计文件。
- 写入时更新 Status/Updated，填入技术方案、任务、测试、风险和涉及文件；完成后读回关键区块并告知用户路径。

## 注意

- 任务拆解粒度：每个 task 应该是 5-30 分钟的工作量
- 优先做最高风险的部分（fail fast）
- 如果发现需求不清楚，回退建议 `/think`，不要自己猜测需求

## Phase 间预热钩子

完整 sprint 内执行时（`/sprint` 调用），本命令报告末尾**可选**追加「下一 Phase 预热」段（2026-05-22 起改建议非强制）。协议见当前命令集合中 `sprint.md` 的「Phase 间预热协议」。

本命令的典型预热内容：

```text
## 下一 Phase 预热（Phase 3: Work）
关键文件: 任务清单中最高风险 task 涉及的文件
执行命令: 跑当前测试基线（确认绿）、读关键模块入口
风险预判: fail-fast 路径上的最高风险 task、依赖链中的脆弱点
```

单独使用本命令（不在 sprint 内）时，预热段建议但非必须。
