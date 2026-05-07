# Claude Code / Codex 自进化工程系统

> 融合 gstack 角色分工 + Compound Engineering 复利循环 + ECC/Claude-Mem 自学习本能 + Skill 自迭代 + 风险自适应测试 + 上下文交接 + Obsidian 知识图谱。
> 21 个用户命令 · 3 个项目命令 · 10 个按需技能 · 4 个 Hook · Memory v5 · Caveman 压缩层 · 5 层知识存储。
> 支持 Claude Code 原生目录和 Codex 原生插件两种运行时；每一次工作都让下一次更容易。

---

## 设计哲学

| 问题 | 来源 | 解法 |
|------|------|------|
| 如何分工 | gstack | 同一模型不同阶段切换角色（CEO→架构师→工程师→审查团队） |
| 如何复利 | Compound Engineering | 每次工作的经验沉淀为文档，供下次规划自动读取 |
| 如何记忆 | ECC + Claude-Mem + Memory v5 | 4 Hook 自动观察，生成 `MEMORY.md` 启动索引、topic 记忆和带置信度的本能 |
| 如何适应 | Skill 自迭代 | 使用信号 → 诊断 → 改进提案 → eval 验证 → 发布新版 |
| 如何测试 | 风险自适应 | 评估变更风险等级(L0-L4)，自动匹配测试深度 |
| 如何持续 | 上下文交接 | 长任务 checkpoint + 交接文件 + 自动恢复 |
| 如何跨 Agent 协作 | Agent Loop v7 | v6 external orchestrator 继续负责冻结 spec / 实现 / 复审；v7 增加 caveman 输出与 memory 压缩能力 |
| 如何可视化 | Obsidian | 所有产出 Obsidian 兼容，Graph View 展示知识关联 |

---

## 架构总览

```mermaid
flowchart TD
    subgraph EXEC["Execution layer: /sprint chains 6 phases"]
        direction LR
        PROTOTYPE["/prototype<br/>Converge"]
        THINK["/think<br/>CEO"]
        PLAN["/plan<br/>Architect"]
        WORK["/work + /test<br/>Engineer"]
        REVIEW["/review<br/>5 views"]
        COMPOUND["/compound<br/>Money step"]
    end

    subgraph KNOW["Knowledge layer: hooks, Memory v5, instincts, skills"]
        direction LR
        SESSION_START["SessionStart<br/>inject + handoff"]
        TOOL_HOOKS["PreToolUse + PostToolUse<br/>observe"]
        STOP_HOOK["Stop<br/>evaluate"]
        SKILL_SIGNALS["skill-signals<br/>diagnose to improve to eval"]
    end

    subgraph STORE["Storage layer: 5 tiers + Obsidian"]
        direction LR
        TIER_0["Tier 0<br/>observations"]
        TIER_1["Tier 1<br/>instincts"]
        TIER_2["Tier 2<br/>evolved"]
        TIER_3["Tier 3<br/>rules + solutions"]
        TIER_4["Tier 4<br/>CLAUDE.md + AGENTS.md"]
        OBSIDIAN["Obsidian<br/>Graph View"]
    end

    EXEC --> KNOW
    KNOW --> STORE
    STORE -->|"SessionStart injects Memory v5, Tier 1-4, handoff"| EXEC

    style EXEC fill:#EEEDFE,stroke:#534AB7,color:#26215C
    style KNOW fill:#E1F5EE,stroke:#0F6E56,color:#04342C
    style STORE fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A
    style COMPOUND fill:#EAF3DE,stroke:#3B6D11,color:#173404
    style SKILL_SIGNALS fill:#FAECE7,stroke:#993C1D,color:#4A1B0C
    style OBSIDIAN fill:#E6F1FB,stroke:#185FA5,color:#042C53
```

---

## 执行流程

```mermaid
flowchart TD
    START(["/sprint requirement"])
    START --> PROTO

    PROTO{"Prototype screenshots?"}
    PROTO -->|"yes"| PROTOTYPE["/prototype<br/>Assumption-driven convergence<br/>User corrects wrong assumptions"]
    PROTO -->|"no"| THINK

    PROTOTYPE -->|"converged"| THINK
    THINK["/think: CEO<br/>Scope, criteria, risks"] --> C1{"Confirm?"}
    C1 --> PLAN["/plan: Architect<br/>Tasks, tests, risks<br/>Reads rules, solutions, instincts"]
    PLAN --> C2{"Confirm?"}
    C2 --> WORK["/work + /test: Engineer<br/>Implement, assess risk, test by level"]

    WORK --> CPCHECK{"Context pressure?"}
    CPCHECK -->|"degraded or 5+ tasks"| CHECKPOINT["/checkpoint<br/>Save handoff, compact, resume"]
    CHECKPOINT --> WORK
    CPCHECK -->|"ok"| REVIEW

    REVIEW["/review: 5 perspectives<br/>Security, performance, architecture, quality, tests"]
    REVIEW --> C3{"P0 or P1 fixes?"}
    C3 --> COMPOUND["/compound: Money step<br/>rules, solutions, instincts<br/>skill signals, Obsidian output"]
    COMPOUND -->|"compound loop"| PLAN

    style PROTOTYPE fill:#FAEEDA,stroke:#854F0B,color:#412402
    style COMPOUND fill:#EAF3DE,stroke:#3B6D11,color:#173404
    style CHECKPOINT fill:#FAECE7,stroke:#993C1D,color:#4A1B0C
```

---

## 知识生命周期

```mermaid
flowchart TD
    T0["Tier 0: observations.jsonl<br/>Hook auto-capture"]
    M0["Memory v5: memory/MEMORY.md<br/>Concise index + topic files"]
    T1["Tier 1: instincts/*.md<br/>Confidence 0.3 to 0.9, auto decay"]
    T2["Tier 2: evolved/<br/>/evolve clusters 3+ instincts"]
    T3["Tier 3: rules/ + solutions/<br/>Mature experience"]
    T4["Tier 4: CLAUDE.md + AGENTS.md<br/>Core under 200 lines"]
    OBS["Obsidian Graph View<br/>All Markdown files visualized"]

    T0 -->|"quality gate"| M0
    M0 -->|"pattern detect"| T1
    T1 -->|"repeated validation"| T2
    T2 -->|"human confirm"| T3
    T3 -->|"highest freq"| T4
    T4 -.->|"SessionStart injects"| T0
    T1 --> OBS
    T3 --> OBS

    style OBS fill:#E6F1FB,stroke:#185FA5,color:#042C53
```

---

## Skill 自迭代

```mermaid
flowchart TD
    USE["Skill used (/prototype /review ...)"]
    SIG["Signal collection<br/>steps skipped, corrections, duration"]
    DIAG["/skill-diagnose<br/>Heatmap + correction patterns"]
    IMP["/skill-improve<br/>Merge steps, absorb instincts"]
    EVAL["/skill-eval<br/>A/B pass rate"]
    PUB["/skill-publish<br/>Backup, deploy, changelog"]

    USE -->|"every use"| SIG
    SIG -->|"threshold"| DIAG
    DIAG --> IMP
    IMP --> EVAL
    EVAL -->|"pass rate ok"| PUB
    EVAL -->|"regression"| ROLL["Rollback"]
    PUB --> USE

    style SIG fill:#FAEEDA,stroke:#854F0B,color:#412402
    style EVAL fill:#E1F5EE,stroke:#0F6E56,color:#04342C
```

---

## 测试策略

```mermaid
flowchart LR
    DIFF["git diff"] --> ASSESS["Risk assess<br/>3 dimensions"]
    ASSESS --> L0["L0 no tests<br/>copy, comments, style"]
    ASSESS --> L1["L1 smoke<br/>1-3 cases"]
    ASSESS --> L2["L2 standard<br/>5-10 cases"]
    ASSESS --> L3["L3 strict<br/>10-20 cases"]
    ASSESS --> L4["L4 comprehensive<br/>20+ cases<br/>plus integration"]

    style L0 fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A
    style L4 fill:#FCEBEB,stroke:#A32D2D,color:#501313
```

---

## 安装

### 环境要求
Node.js >= 18 · Git · Claude Code CLI 或 Codex CLI

### Claude Code

Windows:
```powershell
node scripts\preflight.js
powershell -ExecutionPolicy Bypass -File .\install.ps1 -All
```

macOS/Linux:
```bash
node scripts/preflight.js && bash install.sh --all
```

### Codex

Codex 使用原生插件包 `plugins/tech-persistence/`，用户级安装会复制到 `~/plugins/tech-persistence` 并更新 `~/.agents/plugins/marketplace.json`。Codex 知识库默认写入 `~/.codex/homunculus`，可用 `TECH_PERSISTENCE_HOME` 临时覆盖，也可用 `~/.tech-persistence/config.json` 配置持续共享目录。

当前 Codex CLI 的 TUI slash commands 只注册内置命令；插件工作流通过 skills 调用。Claude Code 中仍使用 `/sprint`、`/prototype`，Codex 中使用 `$sprint <需求>`、`$prototype <需求>`、`$plan <需求>`、`$caveman`，也可以用 `@` picker 选择同名 skill。

Windows:
```powershell
node scripts\preflight.js --codex
powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -All
```

macOS/Linux:
```bash
node scripts/preflight.js --codex
bash install-codex.sh --all
```

迁移 Claude 历史知识库（可选）：
```powershell
powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -All -ImportClaude
```

```bash
bash install-codex.sh --all --import-claude
```

### Claude Code 与 Codex 共享知识库（推荐）

如果你同时使用 Claude Code 和 Codex，推荐把同一个 homunculus 目录作为 Obsidian vault：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Obsidian -SharedHomunculus "C:\Users\you\Documents\TechPersistence"
powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -All -SharedHomunculus "C:\Users\you\Documents\TechPersistence"
```

```bash
bash install.sh --obsidian --shared-homunculus ~/Documents/TechPersistence
bash install-codex.sh --all --shared-homunculus ~/Documents/TechPersistence
```

这会写入 `~/.tech-persistence/config.json`，两边 Hook 会自动解析同一个 `homunculusHome`。`--import-claude` 是一次性复制历史数据；`--shared-homunculus` 才是持续同步模式。

未配置共享目录时，Claude Code 默认写 `~/.claude/homunculus`，Codex 默认写 `~/.codex/homunculus`。SessionStart 会合并两个默认目录中的 Memory v5 topic notes 后再注入，避免某一边的 `MEMORY.md` 遮蔽另一边；但文件级写入仍各自保留在默认目录里。

插件构建与验证：
```powershell
node plugins/tech-persistence/scripts/build-codex-plugin.js
node scripts/validate-codex-plugin.js
```

### Agent Loop v7（跨 Agent 编排 + Caveman 压缩）

当任务需要“需求分析/设计”和“实现/验收”分离时，继续使用 v6 外部 orchestrator，而不是让两个 Agent 在各自上下文里互相模拟。v7 在此基础上增加 caveman 输出压缩和 memory 文件压缩 skill：

```powershell
node scripts\agent-orchestrator.js run --requirement "原始需求"
node scripts\agent-orchestrator.js freeze --run <runId>
node scripts\agent-orchestrator.js resume --run <runId> --validation-command "npm test"
```

命令入口：

```text
/agent-loop <原始需求>     # Claude Code
$agent-loop <原始需求>     # Codex
```

运行产物写入 `.agent-runs/<runId>/`，包含冻结 spec、技术设计、任务拆解、diff、validation、handoff、review 和 follow-up task。`.agent-runs/` 是运行态目录，不进入 Git。

Caveman 入口：

```text
$caveman                    # 启用精简表达模式
$caveman-commit             # 生成 Conventional Commit 消息
$caveman-review             # 生成一行式 review comment
$caveman-compress <file>    # 压缩自然语言 memory 文件
```

SessionStart hook 会注入 caveman 规则；如需关闭自动激活，设置 `CAVEMAN_DEFAULT_MODE=off`。

### Obsidian 集成（可选）
```powershell
.\install.ps1 -Obsidian     # 初始化 Obsidian vault
```
参考 `docs/obsidian-setup.md` 完成 Claude 独立、Codex 独立或共享 vault 配置。

---

## 命令速查（24 个）

表中保留 Claude Code 的 `/command` 写法。Codex 中把前缀换成 `$`，例如 `/sprint` → `$sprint`、`/prototype` → `$prototype`。

### 工作流（8 个）
| 命令 | 角色 | 作用 |
|------|------|------|
| `/think` | CEO | 需求审视、范围锁定 |
| `/plan` | 架构师 | 任务拆解、风险评估 |
| `/work` | 工程师 | 按计划实现 + 按风险等级测试 |
| `/test` | 测试工程师 | 独立风险评估 + 分级测试 |
| `/review` | 审查团队 | 5 视角审查（含测试覆盖 vs 风险匹配） |
| `/compound` | 知识管理 | 经验+本能+方案+skill 信号+Obsidian 输出 |
| `/sprint` | 指挥官 | 全链路编排 + 自动 checkpoint + resume |
| `/agent-loop` | 外部编排器 | v7 跨 Agent：冻结 spec → codex 实现 → spec review；caveman 压缩输出 |

### 需求收敛（1 个）
| 命令 | 作用 |
|------|------|
| `/prototype` | 假设驱动：输出完整方案，用户只纠偏不对的部分 |

### 上下文管理（1 个）
| 命令 | 作用 |
|------|------|
| `/checkpoint` | 保存 sprint 状态到交接文件，为上下文重置做准备 |

### 知识管理（5 个）
| 命令 | 作用 |
|------|------|
| `/learn` | 轻量经验提取（/compound 子集） |
| `/debug-journal` | 调试全过程 + 自动回归测试 |
| `/session-summary` | 会话总结报告 |
| `/retrospective` | 全面回顾 + skill 诊断 |
| `/review-learnings` | 跨层搜索统计 |

### 本能系统（4 个）
| 命令 | 作用 |
|------|------|
| `/instinct-status` | 本能面板 |
| `/evolve` | 本能聚类进化 |
| `/instinct-export` | 导出本能 |
| `/instinct-import` | 导入本能 |

### Skill 自迭代（4 个）
| 命令 | 作用 |
|------|------|
| `/skill-diagnose` | 诊断 skill 健康 |
| `/skill-improve` | 生成改进提案 |
| `/skill-eval` | A/B 验证 |
| `/skill-publish` | 发布新版 + changelog |

### 项目级（3 个）
| 命令 | 作用 |
|------|------|
| `/learn` (项目级) | 项目特有经验提取 |
| `/debug-journal` | 项目调试日志 |
| `/retrospective` | 项目回顾 + skill 诊断 |

---

## 使用节奏

Codex 中使用同名 `$skill` 入口；例如下面的 `/sprint` 在 Codex 中输入 `$sprint`。

```
大功能 (>2h):     /sprint '需求' → auto checkpoint if needed
跨 Agent 实现:     /agent-loop '需求' → freeze spec → resume implementation/review
原型驱动:         /prototype → 纠偏 → /plan → /work → /prototype compare
中等任务:         /plan → /work → /review → /compound
修 Bug:           修 → /debug-journal → /compound
小改动:           改 → /compound
探索:             对话 → /learn
月度维护:         /retrospective (含 skill 诊断)
Skill 优化:       /skill-diagnose → /skill-improve → /skill-eval → /skill-publish
长任务中断:       /checkpoint → /compact → 下次 /sprint resume
```

---

## 自动化 Hook

| Hook | 脚本 | 作用 |
|------|------|------|
| SessionStart | inject-context.js | 注入 Memory v5 索引、本能、会话摘要 + 检测 handoff/prototype 状态 |
| PreToolUse | observe.js pre | 规范化并脱敏工具输入 |
| PostToolUse | observe.js post | 捕获工具结果、命令状态、文件路径 |
| Stop | evaluate-session.js | 模式检测 + Memory v5 写入 + 本能提取 + 衰减 |

---

## 按需加载技能（5 个）

| 技能 | 触发条件 | 加载内容 |
|------|---------|---------|
| memory | 涉及记忆管理 | 增强记忆方法论 |
| continuous-learning | 系统说明需要时 | 自学习系统定义 |
| prototype-workflow | 上传原型截图 | 假设驱动收敛方法论 |
| test-strategy | 代码变更/测试 | 风险评估矩阵 + 五级测试深度 |
| context-handoff | sprint 中上下文压力 | checkpoint + 交接文件方法论 |

不触发时不加载，零上下文占用。

---

## 测试策略

| 等级 | 适用 | 用例数 | 耗时占比 |
|------|------|--------|---------|
| L0 免测 | 样式/文案/注释 | 0 | 0% |
| L1 冒烟 | 低风险新增 | 1-3 | 10% |
| L2 标准 | 常规开发 | 5-10 | 20-30% |
| L3 严格 | 核心逻辑/API | 10-20 | 40-50% |
| L4 全面 | 支付/认证/数据迁移 | 20+ | 60%+ |

风险评估自动完成（影响面 × 可逆性 × 变更类型），用户只在不对时纠偏。

---

## Obsidian 集成

所有知识产出统一使用 Obsidian 兼容格式（frontmatter + wikilinks + tags）。共享模式下，Claude Code 和 Codex 会写入同一个 homunculus vault，再由 Obsidian Sync、iCloud、OneDrive、Dropbox 或 Syncthing 做跨设备同步。

| 产出 | Tag | Graph 颜色 | 产生方式 |
|------|-----|-----------|---------|
| 本能 | `#instinct` | 紫色 | Hook + /compound |
| Memory | `#memory` | 蓝色 | Stop Hook |
| 会话 | `#session` | 绿色 | Stop Hook |
| 解决方案 | `#solution` | 深绿 | /compound |
| 规则 | `#rule` | 橙色 | /compound /learn |
| 架构 | `#architecture` | 红色 | /compound |
| Sprint | `#sprint` | 青色 | /sprint |
| 交接点 | `#handoff` | 金色 | /checkpoint |

详细配置见 `docs/obsidian-setup.md`，使用方法见 `docs/obsidian-usage.md` 和 `docs/obsidian-sprint-usage.md`。

---

## 本能置信度

| 分数 | 行为 | 提升 | 衰减 |
|------|------|------|------|
| 0.9+ | 自动应用 | +0.1/验证 | -0.05/14天 |
| 0.7+ | SessionStart 注入 | | |
| 0.5+ | 相关时建议 | | |
| 0.3+ | 被问到时提及 | | |
| <0.3 | 候选删除 | | |

---

## 目录结构

```
~/.claude/                              ← 用户级 (跟着你走)
├── CLAUDE.md                           ← 核心偏好 + 路由规则 (< 200行)
├── settings.json                       ← 4 Hook 配置
├── commands/ (21 个)                   ← 全部用户命令
├── rules/general-standards.md
├── skills/                             ← 5 个按需加载技能
│   ├── memory/
│   ├── continuous-learning/{SKILL.md, hooks/}
│   ├── prototype-workflow/
│   ├── test-strategy/
│   └── context-handoff/
└── homunculus/                         ← 知识存储
    ├── instincts/{personal/, inherited/}
    ├── evolved/{skills/, commands/, agents/}
    ├── skill-signals/                  ← 使用信号
    ├── skill-evals/                    ← 测试集
    ├── skill-changelog/                ← 变更记录
    └── projects/{hash}/
        ├── memory/MEMORY.md             ← Memory v5 启动索引 (<200 行 / 25KB)
        ├── memory/{topic}.md            ← 调试/测试/工具链等细节
        ├── instincts/
        └── sessions/

your-project/                           ← 项目级 (提交 Git)
├── CLAUDE.md
├── .claude/{commands/, rules/, plans/}
└── docs/
    ├── solutions/                      ← /compound 产出
    └── plans/                          ← /sprint + /checkpoint 产出

plugins/tech-persistence/               ← Codex 原生插件包
├── .codex-plugin/plugin.json
├── commands/                            ← 21 个兼容命令源文件
├── skills/                              ← 5 个按需技能 + 21 个 command skill wrappers
├── hooks.json                           ← 4 Hook 配置
├── hooks/                               ← Codex runtime hook scripts
├── scripts/                             ← build/import utilities
└── codex-homunculus-template/

Codex 调用方式：
`$sprint <需求>`、`$agent-loop <需求>`、`$prototype <需求>`、`$plan <需求>`，或用 `@` 选择同名 skill。
当前 Codex CLI 会把 `/sprint` 和 `/tech-persistence:sprint` 当作未知 TUI slash command。

~/.codex/                              ← Codex 用户级 (与 ~/.claude 对齐)
├── AGENTS.md                           ← 核心偏好 + 路由规则
├── commands/ (21 个)                   ← 兼容命令源文件
├── rules/general-standards.md
├── skills/                             ← 5 个按需技能 + 21 个 command skill wrappers
│   ├── memory/
│   ├── continuous-learning/{SKILL.md, hooks/}
│   ├── prototype-workflow/
│   ├── test-strategy/
│   ├── context-handoff/
│   └── sprint/, prototype/, plan/, work/, review/, ...
└── homunculus/                         ← Codex 用户级知识存储
    └── projects/{hash}/
        ├── memory/MEMORY.md             ← Memory v5 启动索引 (<200 行 / 25KB)
        ├── memory/{topic}.md            ← 调试/测试/工具链等细节
        ├── instincts/
        └── sessions/

your-project/                           ← Codex 项目级 (提交 Git)
├── AGENTS.md
├── .codex/{commands/, rules/, plans/, skills/}
└── docs/solutions/
```

---

## 健康指标

| 指标 | 阈值 | 动作 |
|------|------|------|
| CLAUDE.md | > 200 行 | 迁移到 rules/ |
| MEMORY.md | > 200 行或 > 25KB | 裁剪索引，细节保留在 topic 文件 |
| rules 文件 | > 100 行 | 拆分 |
| 本能数量 | > 50 | /evolve |
| 观察日志 | > 10 MB | 归档 |
| Skill 放弃率 | > 30% | /skill-diagnose |
| Skill 纠正 | 3+ 次 | /skill-diagnose |
| Sprint 中 Task > 5 | — | 建议 /checkpoint |
| 会话轮次 > 30 | — | 建议 /checkpoint |

---

## 核心原则

1. **分层存储**：高频→CLAUDE.md/AGENTS.md · 分类→rules/ · 原子→instincts/ · 方案→solutions/
2. **分层加载**：CLAUDE.md/AGENTS.md 路由 · Memory v5 启动索引 · skill 按需 · rules 路径匹配
3. **轻量记忆**：`MEMORY.md` 只放高价值索引，细节进入 topic 文件，避免污染上下文
4. **假设驱动**：输出方案让用户纠偏，不做冗长问答
5. **风险自适应**：测试深度跟着变更风险走，不多不少
6. **自动优先**：Hook 100% 捕获 · 手动命令做深度提取
7. **复利导向**：/compound 产出 → 下次 /plan 自动读取
8. **Skill 进化**：使用信号 → 诊断 → 验证 → 发布
9. **上下文安全**：长任务自动 checkpoint，不怕上下文溢出
10. **Obsidian 原生**：所有产出 frontmatter + wikilinks，Graph View 可视化
11. **80/20 分配**：80% 规划审查 · 20% 执行
12. **先学后压**：永远先 /compound 再 /compact

---

## 版本演进

```mermaid
flowchart LR
    V1["v1 Manual<br/>/learn + rules<br/>/compact management"]
    V2["v2 Auto-learning<br/>4 hooks<br/>instinct confidence and decay<br/>project isolation"]
    V3["v3 Workflow<br/>role switching<br/>compound loop<br/>/sprint + /prototype"]
    V4["v4 Self-iteration<br/>skill signals<br/>risk-adaptive testing<br/>checkpoint + resume<br/>Obsidian integration"]
    V5["v5 Codex Memory<br/>payload normalization<br/>MEMORY.md compact index<br/>topic files<br/>confidence-gated writes"]
    V6["v6 Agent Loop<br/>external orchestrator<br/>frozen spec contract<br/>Codex handoff<br/>Claude review loop"]
    V7["v7 Compression Layer<br/>caveman output mode<br/>memory file compression<br/>Claude and Codex parity hardening"]

    V1 --> V2 --> V3 --> V4 --> V5 --> V6 --> V7

    style V1 fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A
    style V4 fill:#E1F5EE,stroke:#0F6E56,color:#04342C
    style V5 fill:#E6F1FB,stroke:#185FA5,color:#042C53
    style V6 fill:#EEEDFE,stroke:#534AB7,color:#26215C
    style V7 fill:#FAEEDA,stroke:#854F0B,color:#412402
```

v7 保留 v6 的外部 orchestrator 边界：冻结 spec、Codex 实现、Claude 复审仍由同一条编排链路完成。新增能力集中在压缩层，包括 `$caveman` 精简输出模式、`$caveman-compress` 压缩自然语言 memory 文件，以及围绕 Claude Code / Codex 双运行时的一致性加固。
