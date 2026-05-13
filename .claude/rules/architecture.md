# 架构决策记录 (ADR)

> 记录关键架构决策。由 /learn 自动追加，也可手动编辑。
> 当同类决策的本能置信度达到 0.9 时，会从本能"毕业"写入此处。

## 格式
<!--
### ADR-NNN: [标题] (YYYY-MM-DD)
- **状态**：已采纳 / 已废弃
- **上下文**：为什么需要做这个决策
- **决策**：选择了什么
- **原因**：为什么
- **备选**：未采纳的方案
- **影响**：约束或后果
- **来源本能**：[如果从本能毕业，记录原始 instinct ID]
-->

## 决策列表

### ADR-013: 关键规则必须从文档协议下沉为工具拒绝（mechanism over discipline） (2026-05-12)
- **状态**：已采纳
- **上下文**：`docs/plans/2026-05-11-sprint-speed-layer1.md` Compound 阶段实证两次失败：(1) 我自己漏跑 `build-codex-plugin`，validate 才暴露；(2) Plan 阶段两次基于错误假设（`CONTEXT_BUDGET_CHARS=25KB`、`pipeline.js` 是 /sprint 代码），work 阶段才发现，催生 ADR-012。两次失败的共同根因：**关键规则只活在 .md 里**——propagate 纪律在 `debugging-gotchas.md`，plan 勘察规则在 ADR-012，靠模型每次读 context 时记得遵守。上下文压缩 / 压力下 / 重要时刻会被悄悄省略。文档协议级 enforcement 有 3 个失效模式：(a) **遗忘**——上下文压缩后规则不在 active context；(b) **省略**——压力下模型主动跳过 self-check；(c) **漂移**——多次修订后文档与实际期望偏移，但没有客观信号验证。
- **决策**：高频违反、影响其他副本一致性、或涉及 dogfood 边界的规则，必须从"靠模型记得"的文档协议下沉为"工具层拒绝"。第一批落地：`scripts/pre-commit-check.js` 接管 propagate sync 检查（多副本 sha256 比对，LF-normalize）和 plan 假设验证段 lint（filename-date 做 grandfather，独立于 frontmatter 的鲁棒标识）。后续新增 enforcement 必须沿用同套模式：(a) 复用现有 transform 函数做 sha256 比对而非重写；(b) 3 层 fail-open 防御（用户 `--no-verify` / hook try-catch / sh wrapper node 缺失）；(c) 派生具体修复命令包含**真实参数**而非占位符；(d) 跨平台 LF-normalize 必须先于 hash 比对（[[cross-platform-sha-needs-lf-normalize]]）。
- **原因**：(1) 文档协议 3 个失效模式都是结构性的，写更多文档解决不了；(2) hook 拒绝是确定性信号，每次 commit 都跑，不依赖模型 context 状态；(3) fail-open 保证用户永远有逃生通道，不会被自己写的工具锁死；(4) "派生具体 fix 命令"把错误信息变成可 copy-paste 的修复路径，错误成本接近零。
- **备选**：(a) 继续靠文档协议 + reviewer agent 提醒——已实证失效 2 次；(b) 改用 server-side CI 拒绝——延迟反馈，本地 commit 仍可携带 broken state；(c) 在 LLM 主循环加 self-check prompt——增加 token + 不可靠。
- **影响**：所有"高频违反 / 跨副本一致性 / dogfood 边界"类规则必须问"能不能 pre-commit 拒掉"。第一批落地的 checker：`checkPropagateSync` / `checkOrchestratorSync` / `checkPlanScope`（ADR-012）/ `checkPlanCompletion`（C7）。新增 checker 必须配 smoke scenarios（`scripts/smoke-pre-commit.js`），覆盖 pass/fail/grandfather/fail-open 4 类至少各 1 个。
- **来源**：`docs/solutions/2026-05-12-pre-commit-defense.md`、Phase 4 review 暴露 7 P0 中 6+ 个无-FM 旧 plan dogfood blocker。

### ADR-013 §B: Enforcement 提案必须 inline dogfood 边界产物枚举 (2026-05-12)
- **状态**：已采纳
- **上下文**：ADR-013 主决策落地时 Phase 4 reviewer 发现 hook 装上**立刻**会拒绝 6+ 个本仓库**已有的**无 frontmatter 旧 plan。原 dogfood 步骤只验证：(a) 我刚写的新 plan 通过 + (b) 破坏一次再恢复——**没枚举本仓库已有的同类产物是否都满足新规则**。如合并，hook 上线第一天就阻塞合法旧产物，用户必须 `--no-verify` 绕过——enforcement 最差启动状态。修复方式是 grandfather signal 改用 filename date（path-regex 强制，独立于 frontmatter），一次性解决无-FM / CRLF / 不可解析 created 三个失效。
- **决策**：任何新 enforcement 机制（pre-commit / lint / CI / hook with reject）合并前必须满足"dogfood 边界覆盖"：(a) 枚举本仓库与新规则同类的**已有产物**至少 3 个边界样本（最老 / 最新 / 格式异常 / 跨平台 line-ending / 中文文件名 / 已 grandfather）；(b) 离线模拟 enforcement 跑这些样本不被误拒；(c) 如有误拒，要么 grandfather 要么主动改造旧产物——而不是上线让用户 `--no-verify`；(d) plan 阶段「关键假设验证」段必须含一条"会拒绝哪些现有产物"枚举。**额外要求**：当前态全部合规时必须主动制造负样本验证（改一个文件 1 字符 → 跑必须 fail；恢复 → 跑必须 pass），少了这步 = enforcement 上线但实际从未被验证过（fail-open 风险）。
- **原因**：(1) 智能猜测的 enforcement 规则在真实语料上 FP 率惊人（C7 实施时 12 个现有 plan 立刻爆 2 个 FP = 17%）；(2) 上线后被 `--no-verify` 绕过 = enforcement 死亡，因为用户养成"反正先 --no-verify"习惯后不可逆；(3) "当前态合规"是 trivial pass 状态，单测不能证明 hook 真在拒（fail-open 静默失效在 `[hook] failed:` marker 不存在时无法检测）；(4) 边界产物枚举是低成本步骤（10 分钟跑一次），节省的是上线后用户绕过 hook 几周的隐性成本。
- **备选**：(a) 不枚举边界产物，上线后修复 FP——已实证 ADR-013 主决策第一次就踩；(b) 把所有现存产物 grandfather——会让规则永远无法约束历史；(c) 强制用户改造所有旧产物——用户成本太高，会拒绝合并 enforcement。
- **影响**：plan 阶段「关键假设验证」段必须含"会拒绝哪些现有产物"枚举；plan 阶段必须有「Dogfood 自检」H2 或 H3 段（含边界产物列表 + 负样本验证步骤）；smoke 必须覆盖 pass / fail / skip-grandfather / fail-open 4 类。本条款已在 C7 (`docs/plans/2026-05-13-plan-completion-verify.md`) 第二次成功应用：dogfood 12 个现有 status:completed plan → 立刻爆 2 个 FP（命令形式 inline-code 误匹配 / 仓库外路径），均通过 regex 迭代修复而非降低 enforcement 强度。
- **来源**：`docs/solutions/2026-05-12-pre-commit-defense.md` Prevention §1；`docs/plans/2026-05-13-plan-completion-verify.md` Phase 5 复利（第二次应用验证）；本能 [[mechanism-over-discipline]]。

### ADR-012: Plan 阶段必须勘察被改文件，不能纯靠假设 (2026-05-11)
- **状态**：已采纳
- **上下文**：`docs/plans/2026-05-11-sprint-speed-layer1.md` Phase 2 plan 阶段连续两次基于错误假设拍 plan，到 Phase 3 work 阶段才发现：(1) 假设 `CONTEXT_BUDGET_CHARS = 25KB`，实际 `inject-context.js:25` 是 12KB — T3 价值定位需重写为"提升相关性"而非"减小体积"；(2) 假设要改 `scripts/agent-orchestrator/pipeline.js` 实现 Phase 间预热，实际该文件是 agent-loop v7 pipeline mode 的代码，跟 `/sprint` 完全不是同一回事，T4 改动对象错了 → 必须停下来重新设计为修订版 A 方案（改 sprint.md 协议 + 5 phase 钩子）。两次错误都导致 work 阶段停顿、重新与用户对齐、调整 plan。
- **决策**：Plan 阶段必须读取被改文件的关键代码段验证关键假设（"我以为这文件是干嘛的"、"我以为这个常量是多少"、"我以为这个目录在哪"）。具体规则：(a) plan 列出的"涉及文件"清单中每个文件至少有一次 Read（哪怕只读 frontmatter / module.exports / 关键常量）；(b) plan 中所有"假设 X"必须标记可信度 — 不能纯凭模型记忆下决定。Plan 阶段比 work 阶段慢 10-20 分钟换 work 阶段不返工，性价比正。
- **原因**：(1) work 阶段才发现 plan 错 = 需要停下来重新设计，浪费已实施的部分；(2) 用户会感知到"为什么你 plan 说要改 A 现在又改 B" — 信任成本；(3) plan 错的根因是"模型基于过往记忆 / 文件名猜测内容"，而记忆和文件名都会过期 / 误导；(4) 本 sprint 两次 plan-error 都是 30 分钟内能避免的（读 25 行 + 读 1 个 module.exports）。
- **备选**：(a) plan 阶段不勘察，work 阶段发现再返工 — 已踩坑，本 sprint 复发两次；(b) plan 之前先全文 explore — 太重，1 个文件就够；(c) 只在 L3+ task 勘察 — 本 sprint T3/T4 都是 L3 但仍踩坑，证明 L2 也需要勘察。
- **影响**：sprint plan 阶段输出必须包含「关键假设验证」短段（哪些假设、验证了哪些文件、可信度）；planner agent / `/plan` 命令文档应加入此要求；review 阶段对 plan 文档审查"假设是否被验证"作为审查点。
- **来源**：`docs/plans/2026-05-11-sprint-speed-layer1.md` Phase 2→3 转换时的两次 plan 修正。

### ADR-011: 评估外部架构思想时遵循 identity-question-first 原则 (2026-05-11)
- **状态**：已采纳
- **上下文**：评估 `garrytan/gbrain`（同作者 Garry Tan 同生态、公开质量极高的项目）的 12 个架构思想是否融入本项目时，Phase 1-3 直接进入"按 ROI 排序选 top-3"。Phase 4 product-lens reviewer 指出真问题不是"挑哪几个"而是"本项目还是 gstack-aligned 吗，还是已演化为不同物种"。Identity question 没回答时，研究会**"导入表面 / 拒绝脊椎"**（例如 C8 thin/fat 反向哲学是 positioning signal 不是 candidate）。同时 ROI 在身份不明时偏 speed-wins，但 solo-maintainer 的成本曲线与团队反向（speed wins 在 solo 场景累积负利息）。
- **决策**：评估外部架构思想（gbrain / 未来其他 sibling 项目 / 大幅 refactor 提议）必须先回答 identity question："本项目是 X / Y / Z 中的哪一个？" 答案明示后，多数候选变 trivially decidable。具体到本项目：**tech-persistence = developer-toolchain self-evolution sibling**（不是 gstack / gbrain 替代）；4 条不可妥协原则 — 多运行时 parity / 确定性优先 / 轻量优先 / Obsidian 兼容。ROI 评估默认按 "5 年杠杆 / 维护表面增量" 而非 "人天 / 速胜"。
- **原因**：(1) Cherry-picking 思想会 import surface / reject spine，结果不连贯（C8 反向哲学 = positioning signal 不是候选）；(2) ROI top-3 在身份不明时容易偏 speed-wins，但 solo 用户的成本曲线与团队反向；(3) reviewer 反馈系统证明这是 **product-lens 才能抓到的问题**，coherence + feasibility 抓不到 — 多视角并行 review 在研究文档上不可省略。
- **备选**：(a) 不写 ADR，靠下次评估时凭感觉 — 会忘；(b) 把身份陈述放 CLAUDE.md 顶部"关于我"段 — 把身份和个人偏好混淆，未来其他评估 sprint 不会读到。
- **影响**：未来任何"是否融入外部思想 / 大幅 refactor"的 sprint 必须有 Phase 0 / 前置「项目身份界定」段，明示 4 条不可妥协原则与候选评级的对应关系；ROI 评估默认按"5 年杠杆 / 维护表面增量"；评估流程**必须 spawn 至少 1 个 product-lens reviewer**（不能只 coherence + feasibility）。
- **来源**：`docs/plans/2026-05-11-gbrain-gstack-analysis.md` Phase 4 product-lens reviewer 反馈。

### ADR-009: 全局 `--auto` 决策协议放在单一 rule 文件，命令通过引用获得行为 (2026-05-09)
- **状态**：已采纳
- **上下文**：每个工作流命令都有自己的人工 gate（`/sprint` phase 间 'go'、`/agent-loop` freeze、`/work` task 完成确认、`/review` P0 修复确认），各自硬编码"必问"。新增 `--auto` 参数若每个命令各自实现行为定义，会立刻分叉；同时缺少跨命令一致的"什么时候必须问、什么时候可以自动"边界。
- **决策**：建立 `~/.claude/rules/auto-mode.md` 作为单一决策协议中心。三档矩阵（强制人工 / 自动通过 / 灰区智能判断）+ 各命令的具体集成表都在这一份规则里。每个命令文件只在"可选参数"段引用 `详见 ~/.claude/rules/auto-mode.md`，不复制规则正文。orchestrator 增加 `--auto-evaluate`（条件 freeze）与原有 `--auto-freeze`（永远 freeze）形成两档。
- **原因**：单 source of truth 防止规则分叉。命令文件只声明"接受 --auto"，行为定义集中在规则。强制人工边界（destructive、L4、scope creep、安全相关、测试失败）在规则里写清楚一次胜过 21 个命令各自重复。Orchestrator 双层 freeze 区分"全自动"（已存在用法）和"智能审查"（新增），不破坏旧行为。
- **备选**：每个命令各自定义 `--auto` 行为；只在 `/sprint` 实现 `--auto`；用 hook 拦截。前者会立刻分叉，第二个不通用，第三个让 hook 介入业务决策不合适。
- **影响**：新增工作流命令只需在"可选参数"段加一行引用即可获得 `--auto` 支持；规则更新一次所有命令一致。要求 install 脚本同步复制 `auto-mode.md`（已加入 install.sh / install.ps1）。

### ADR-008: Memory v5 启动注入必须合并兼容运行时索引 (2026-05-07)
- **状态**：已采纳
- **上下文**：Claude Code 默认写 `~/.claude/homunculus`，Codex 默认写 `~/.codex/homunculus`。即使推荐共享 `homunculusHome`，未配置共享目录时两个运行时仍可能各自产生 durable Memory v5 topic notes；旧的 SessionStart first-hit fallback 会让一个 `MEMORY.md` 遮蔽另一个。
- **决策**：项目身份识别、Memory v5 topic entry 解析、去重、排序和 index 格式化统一放入 `scripts/lib/memory-v5.js`；`inject-context.js` 对 `resolveCompatReadDirs()` 返回的所有兼容 memory 目录做合并注入，不再第一个命中就停止。
- **原因**：一致性应该由当前 runtime helper 保证，而不是靠用户记住每次都配置共享目录；同一个 helper 还能避免 observe/inject/evaluate 三个 hook 的 project id 漂移。
- **备选**：强制所有用户配置共享 vault；把 Codex memory 复制进 Claude memory；继续 first-hit fallback。前者破坏默认安装可用性，复制会制造写入副作用，first-hit fallback 已证明会造成上下文漂移。
- **影响**：共享 vault 仍是文件级持续同步的推荐方案；默认分离目录下，启动上下文读取保持一致，但各 runtime 的 topic 文件写入位置仍保持独立。新增 memory helper 时必须同步 root hooks、Codex plugin hooks 和 parity smoke。

### ADR-004: Agent Loop v6 Provider 适配层必须内建在 Orchestrator 中 (2026-04-28)
- **状态**：已采纳
- **上下文**：Windows 上 `claude` / `codex` 常解析到 npm shim，且 Claude Code 与 Codex 对 stdin、structured output、JSON wrapper、schema 严格度的行为不同；把这些差异交给用户手动传参会导致 `/agent-loop` 与 `$agent-loop` 行为分叉。
- **决策**：provider launch resolver、stdin prompt transport、structured output codec、contract normalizer、managed artifact diff、validation runner 和 normalized review state transition 都放入 `agent-orchestrator.js`，Claude Code command 与 Codex skill 只负责调用同一个脚本。
- **原因**：入口文档和运行时越薄，跨 Agent 差异越少；状态机只消费 canonical model，才能避免“review passed 但状态为 needs-followup”这类错误。
- **备选**：要求用户传 `--claude-command` / `--codex-command`；在 Claude/Codex 两边各写一份适配逻辑。前者不可移植，后者会让 bug 修复分叉。
- **影响**：orchestrator 新增 `doctor` / `preflight`、重复 `--validation-command`、`changed-files.json`、`review-context.md`、`review.raw.json` 等 artifacts；插件副本和项目副本必须机械同步。

### ADR-003: Agent Loop v6 使用外部编排器串联多 Agent (2026-04-27)
- **状态**：已采纳
- **上下文**：直接在 claude 或 codex 的命令/skill 内部串联彼此，会依赖两个运行时对对方的支持能力；当前这种支持薄弱，容易出现上下文丢失、输出协议不稳定、错误无法统一恢复的问题。
- **决策**：v6 将跨 Agent 流程提升到外部 orchestrator：由 `scripts/agent-orchestrator.js` 维护状态机、运行目录、JSON Schema、freeze 点、diff、validation、handoff 和 review loop。默认 spec/review provider 为 `claude -p`，implementation provider 为 `codex exec`。
- **原因**：外部进程能统一管理 exit code、stdout/stderr、文件产物、重试、恢复和 human freeze；两个 Agent 只承担单一职责，不需要理解彼此的内部命令系统。
- **备选**：只做 `/claude-codex` 这类命令内协议；只共享 homunculus 知识库；把其中一个 Agent 包装成另一个的 MCP 工具。命令内协议可作为人工 fallback，但不是稳定主路径；共享知识库不能提供执行控制；MCP 包装增加部署复杂度且仍要解决状态契约。
- **影响**：运行产物进入 `.agent-runs/<runId>/` 并被 Git 忽略；插件构建必须复制 orchestrator 与 schemas；新增 `/agent-loop` / `$agent-loop` 作为 v6 入口。

### ADR-002: Codex Memory v5 使用轻量索引 + Topic 文件 (2026-04-24)
- **状态**：已采纳
- **上下文**：v4 已有 observations、instincts 和 sessions，但 SessionStart 注入缺少类似 Claude Code auto memory 的轻量启动索引，容易在“全量会话摘要/本能列表”和“无记忆”之间摇摆。
- **决策**：在 `projects/{hash}/memory/` 下新增 `MEMORY.md` 和 `memory/{topic}.md`。`MEMORY.md` 只保存通过置信度门控的高价值索引，目标 `<200 行 / 25KB`；调试、测试、工具链等细节进入 topic 文件。
- **原因**：轻量索引能稳定注入未来最可能复用的信息；topic 文件保留细节但默认不进入上下文；结构与 Claude Code auto memory 的实践一致，便于用户理解和审计。
- **备选**：只继续写 instincts；把完整 sessions 注入；引入数据库/向量检索。前者缺少可读启动索引，第二个上下文成本高，第三个超出当前纯文件/Obsidian 模型。
- **影响**：Hook 必须规范化 Codex payload、脱敏、去重并维护 `MEMORY.md` 预算；安装脚本和 Codex plugin 构建必须复制 `scripts/lib/`。
