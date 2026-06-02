---
title: "Obsidian 接入完整性审计与补全"
type: sprint
status: completed
created: "2026-06-01"
updated: "2026-06-01"
checkpoints: 0
tasks_total: 9
tasks_completed: 9
tags: [sprint, obsidian, integration, drift-fix]
aliases: ["Obsidian 接入审计", "obsidian-integration-completeness"]

# === 本 sprint 立的不变量 ===
invariants:
  - "init-obsidian-vault.js 安全校验保留：vault 路径必须在 home 目录内"
  - "init-obsidian-vault.js 不覆盖已有 .obsidian/ 配置"
  - "Dashboard.md 重生成前必须备份旧版（.bak.<ts>）"
  - "三处 source of truth（README 表 / graph.json colorGroups / Dashboard dataview）对每类产出的接入声称必须一致"
  - "Claude 与 Codex 安装器的 Obsidian 入口对等（ADR-011 双运行时 parity）"

invariant_tests:
  - scripts/test-init-obsidian-vault.js  # 待创建：三方一致性 + 安全校验 + 不覆盖

deferred: []
deadcode_until: []
---

# Obsidian 接入完整性审计与补全

## Phase 1: 审计结论（CEO/产品视角 — 已完成）

### 需求
检查当前架构对 Obsidian 的接入是否完整，保证所有功能都完整接入。

### 核心发现：三处 source of truth 互相矛盾

| 知识类 | README:528 claim | graph.json 配色 | Dashboard dataview | 实际产出 tag | 真实状态 |
|---|---|---|---|---|---|
| instinct | #instinct 紫 | ✅ | ✅ FROM #instinct | ✅ `[instinct,domain]` | **完整** |
| session | #session 绿 | ✅ | ✅ FROM #session | ✅ `[session,project]` | **完整** |
| solution | #solution 深绿 | ✅ | ✅ FROM #solution | ✅ `[solution,...]` | **完整** |
| sprint | #sprint 青 | ✅ | ✅ FROM #sprint | ✅ `[sprint,...]` | **完整** |
| handoff | #handoff 金 | ✅ | ✅ FROM #handoff | ✅ `[handoff,sprint]` | **完整** |
| **memory** | #memory 蓝 | ❌ **漏配色** | ❌ **无查询** | ✅ `[memory,topic]` | **半接入（P0-1）** |
| **rule** | #rule 橙 | ✅ 配了 | ❌ 无查询 | ❌ 无 frontmatter + 不在 vault | **假接入（P1-3）** |
| **architecture** | #architecture 红 | ✅ 配了 | ❌ 无查询 | ❌ 无 frontmatter + 不在 vault | **假接入（P1-3）** |

证据：
- 产出格式：`scripts/evaluate-session.js:376-405`（instinct）、`:489-506`（memory topic）、`:615-636`（session）、`:779-807`（handoff）；`scripts/lib/memory-v5.js:498-506`（MEMORY.md）
- graph 配色：`scripts/init-obsidian-vault.js:149-155`（7 色，无 #memory）
- Dashboard 查询：`scripts/init-obsidian-vault.js:325-362`（5 查询，无 memory/rule/architecture）
- README claim：`README.md:528-537`（8 类全声称接入）

### 其余缺口

- **P0-2 install-codex 无 `--obsidian` 入口（违反 ADR-011 parity）**：`install.sh:369-402` + `install.ps1:234-244` 有完整 `--obsidian`/`-Obsidian`；`install-codex.sh` / `install-codex.ps1` 只有 `--shared-homunculus`，无 vault 初始化入口。Codex-only 用户必须手动 `node scripts/init-obsidian-vault.js --codex`。
- **P1-4 persona.md（ADR-015 画像）零接入**：`inject-context.js:64` 只读不写；无自动写入器（`user-level/commands/` 无 persona.md 写入），无 tag、不在 Dashboard、graph 不染色。
- **P2-5 JSONL 知识被隐藏（设计合理，缺文档说明）**：`.obsidianignore` 排 `*.jsonl` → observations / skill-signals / skill-evals / recall-usage 在 Obsidian 不可浏览。机器格式排除合理，但 setup/usage 文档未说明用户为何看不到原始数据。

### 范围

- **做**：补齐 memory 接入；install-codex parity；rule/architecture 一致化；persona 接入约定；JSONL 文档说明；三处 source of truth 对齐 + 一致性测试固化。
- **不做**：重构两套 memory 系统；MCP server 行为变更；改 instinct/session/solution/sprint/handoff（已完整）。

## 关键假设验证（ADR-012）

| 假设 | 验证方式 | 实际发现 | 置信度 |
|---|---|---|---|
| Obsidian 接入缺口来自 README、graph.json、Dashboard 三处 source of truth 漂移 | Read `README.md` 接入表、`scripts/init-obsidian-vault.js` 的 `generateGraphConfig` / `generateDashboard`、实际产出 tag 代码 | README 声称 8 类；graph 有 rule/architecture 但缺 memory；Dashboard 缺 memory/session；实际 vault 稳定产出为 instinct/session/solution/sprint/handoff/memory 6 类 | 高 |
| `memory` 已有真实产出，只是 Obsidian 可视层漏接 | Read `scripts/lib/memory-v5.js` 与 `scripts/evaluate-session.js` memory topic 写入逻辑 | memory topic 文件已有 `[memory,topic]` tag；补 graph 配色与 Dashboard 查询即可完成图谱接入 | 高 |
| `rule` / `architecture` 不应为了“完整接入”新增同步机制 | Read `.claude/rules/` 现状、vault 产出路径、已有 Memory v5 / solution 可视知识路径 | rules/ADR 是 repo 注入层，不是 vault 图谱层；新增同步会引入双副本 drift，故采用诚实化方案 A | 高 |
| Codex 安装器与 Claude 安装器存在 Obsidian 入口 parity 缺口 | Read `install.sh` / `install.ps1` 与 `install-codex.sh` / `install-codex.ps1` 参数和 dispatch | Claude 安装器已有 `--obsidian` / `-Obsidian`；Codex 安装器缺入口，需补 `--obsidian` / `-Obsidian` 并调用 `init-obsidian-vault.js --codex` | 高 |
| init 脚本安全与不覆盖 invariant 可以原样保留 | Read `scripts/init-obsidian-vault.js` vault path 校验、不覆盖 `.obsidian/`、Dashboard backup 逻辑 | 本 sprint 只改生成内容和安装入口，不动 home 内路径校验、不覆盖已有 `.obsidian/`、Dashboard 备份逻辑；新增测试覆盖这些 invariant | 高 |

---

## Phase 2: 技术方案（架构师视角）

### 入场扫描 — Invariants 继承

| 子系统 | 既有 invariant | 本 sprint 如何保持 |
|--------|---------------|--------------------|
| init-obsidian-vault.js | vault 必须在 home 内（安全校验，:47-51） | 不动校验逻辑，仅改 generateGraphConfig / generateDashboard |
| init-obsidian-vault.js | 不覆盖已有 .obsidian/（:395-396） | 保持；新增配色仅在首次生成时写入 |
| init-obsidian-vault.js | Dashboard 重生成前备份（:446-451） | 保持备份逻辑 |
| 双运行时 parity（ADR-011） | Claude/Codex 安装器对等 | 给 install-codex.* 补 `--obsidian`，对齐 install.* |
| 派生文件同步（ADR-020） | plugin 副本机制 | init-obsidian-vault.js 不在 plugin（已验证 build-codex-plugin.js 无引用），无需 build |

### 入场扫描 — 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| install-codex --obsidian | 用户运行安装器 | install_obsidian → node init-obsidian-vault.js --codex | vault `.obsidian/` + Dashboard | ✅ Obsidian 打开可见 |
| memory graph 配色 | init 脚本运行 | generateGraphConfig | graph.json colorGroups | ✅ Graph View 蓝色 memory 节点 |
| memory Dashboard 查询 | init 脚本运行 | generateDashboard | Dashboard.md dataview | ✅ Dataview 表格列出 memory topic |

### 关键架构决策：rule / architecture 怎么"完整接入"（待 Phase 2 gate 决策）

**问题**：`.claude/rules/*.md`（含 architecture.md 的 ADR）无 frontmatter，且物理位置在 git repo / `~/.claude/rules/`，**不在 homunculus vault**（`~/.claude/homunculus/`）。README + graph.json 声称它们接入是纯 claim 无产出。

**两个方案**：

- **方案 A（诚实化，轻量优先 / ADR-011）**：承认 rule/architecture 是「注入层」不是「图谱层」。
  - README 表移除或标注 rule/architecture 行为「repo 内注入规则，非 vault graph 节点」。
  - graph.json 的 #rule/#architecture 配色重定向到 `evolved/rules/`（/evolve 产出，在 vault 内），或删除空转配色。
  - 成本：仅改文档 + graph.json 配色注释。零运行时改动。
- **方案 B（真接入，满足"所有功能完整接入"字面）**：让 ADR/rules 真进 vault。
  - 新增 Stop hook 或 /compound 步骤：把 `.claude/rules/architecture.md`、`debugging-gotchas.md` 等同步一份**带 frontmatter（tags:[rule]/[architecture]）**的副本到 vault `projects/{id}/rules/`。
  - Dashboard 加 `FROM #rule` / `FROM #architecture` 查询。
  - 成本：新增同步机制 + 双副本一致性维护（违反轻量优先，引入 drift 风险面）。

**推荐**：**方案 A**。理由：(1) rule/architecture 语义上是 Claude/Codex 注入用的 repo 规则，不是跨设备同步的图谱知识；(2) 真接入需新增同步机制 = 维护表面 + drift 风险，违反 [[ADR-011]] 轻量优先；(3) 高价值 ADR 知识其实已通过 Memory v5 topic 文件 + solution 文件在 vault 可见。诚实化消除 drift 即"完整"。

### 任务拆解

| # | 任务 | 风险 | 文件 |
|---|------|------|------|
| T1 | graph.json 加 #memory 蓝色配色（对齐 README） | L2 | init-obsidian-vault.js:139-169 |
| T2 | Dashboard 加 Memory dataview 查询块 | L2 | init-obsidian-vault.js:297-364 |
| T3 | install-codex.sh 加 `--obsidian` 入口 + install_obsidian 函数 | L2 | install-codex.sh |
| T4 | install-codex.ps1 加 `-Obsidian` 参数 + Install-Obsidian 函数 | L2 | install-codex.ps1 |
| T5 | rule/architecture 一致化（按 gate 决策；默认方案 A） | L2 | init-obsidian-vault.js + README.md |
| T6 | persona.md frontmatter 约定 + Dashboard 查询（条件接入） | L2 | init-obsidian-vault.js + obsidian-usage.md |
| T7 | JSONL 隐藏的文档说明 | L1 | docs/obsidian-usage.md |
| T8 | 文档同步：README 表修正 + obsidian-setup.md vault 树 + codex 段 | L1 | README.md + docs/obsidian-setup.md |
| T9 | 一致性测试：断言三处 source of truth 对齐 + 安全校验 + 不覆盖 | L2 | scripts/test-init-obsidian-vault.js（新建） |

### 验证策略

- T1/T2/T5/T6：跑 `node scripts/init-obsidian-vault.js --vault-path <临时目录>`，断言生成的 graph.json colorGroups 与 Dashboard dataview 与 README 表三方一致。
- T3/T4：临时目录跑 `install-codex.sh --obsidian` / `install-codex.ps1 -Obsidian`，断言调用 init 脚本且 vault 生成；help 文本含 obsidian。
- T9：新增 test 固化三方一致性（防回归），并验证安全校验（home 外路径拒绝）+ 不覆盖已有 .obsidian/。
- 全量：`node scripts/run-tests.js` + `node scripts/pre-commit-check.js`。

### Dogfood 自检（ADR-013 §B）

T9 一致性测试需枚举边界：(a) 全部 8 类对齐 → pass；(b) 故意删 #memory 配色 → fail（断言检测到 drift）；(c) Dashboard 缺一个查询 → fail。负样本验证 enforcement 真在拒。

---

## Phase 3: Work（变更日志）

2026-06-01：

- **T1+T5(graph)** `init-obsidian-vault.js:generateGraphConfig` — 删 `#rule`/`#architecture` 空转配色，加 `#memory` 蓝色（rgb 3899638）。colorGroups 收敛到 6 类 vault 产出。
- **T2** `init-obsidian-vault.js:generateDashboard` — 加 `FROM #memory`（Memory Topics）+ `FROM #session`（Recent Sessions）dataview 块。**审计漏点**：session 原本有配色+tag 但 Dashboard 从未查询，补齐后三方一致。
- **T3** `install-codex.sh` — 加 `--obsidian [path]` 入口 + `install_obsidian()` 函数 + help。实跑验证 vault 初始化成功。
- **T4** `install-codex.ps1` — 加 `-Obsidian`/`-VaultPath` 参数 + `Install-Obsidian` 函数 + dispatch + help。实跑验证成功。双运行时 parity 达成（ADR-011）。
- **T5** rule/architecture 诚实化（方案 A）：graph 配色移除 + 全文档标注「repo 注入层」。
- **T6** persona：Dashboard Quick Links 加 `[[persona|User Persona]]` + obsidian-usage.md 文档化 `tags:[persona]` 约定。不加专属配色（避免重蹈空转）。
- **T7** JSONL 隐藏：obsidian-usage.md 加「为什么看不到原始数据」段（列 observations/skill-signals/skill-evals/telemetry jsonl）。
- **T8** 文档同步：README 接入表（8→6 vault 类 + repo 注入层段）+ 安装段加 codex；obsidian-setup.md（codex 一键入口 + Graph 配色表）；obsidian-usage.md（核心表/配色/数据流/末尾映射表全部诚实化）；obsidian-sprint-usage.md 色表；obsidian-update.md 色表；2026-04-09 solution 加勘误。
- **T9** `scripts/test-init-obsidian-vault.js`（新建）— 三方一致性测试 + 2 个 dogfood 负样本（注入 #rule 空转 / 漏 #memory 查询必拒）。脚本底部加 `require.main` 守卫 + `module.exports`。run-tests.js 自动发现，6/6 pass。

## Phase 4: Review

- **第 6 视角（集成连续性）抓到 3 处审计漏掉的残留 drift**：`obsidian-sprint-usage.md:83-84`、`obsidian-update.md:28-30`、`2026-04-09-obsidian-integration.md:102-103` 仍有 `#rule`橙/`#architecture`红 色表 → 全部修复（活文档重写，历史 solution 加勘误）。
- 集成连续性：未破坏 init 脚本安全校验/不覆盖/备份 invariant；双安装器 Install-Obsidian 已接线并实跑验证（非 dead code）；无半下沉中间态。
- 验证：`test-init-obsidian-vault.js` 6/6、全量 22 suite pass、pre-commit exit 0。残留 `tag:#rule` 仅存于测试 dogfood 负样本（故意）。

## Phase 5: Compound

- **核心成果**：Obsidian 接入从「README 吹 8 类、真接入 5 类」诚实化为「6 类 vault 图谱节点三方一致 + 2 类 repo 注入层明示」。memory 真接入（graph 蓝色 + Dashboard 查询）；install-codex parity 补齐；session Dashboard 漏查补齐。
- **元经验**：drift-fix sprint 的初次审计（即便 3 个并行 agent）仍会漏掉同类 claim 的次要副本（sprint-usage/update 色表）与「配色有但 Dashboard 漏查」这类非对称 drift。**必须在 Review 阶段对所有 claim 关键词做一次全仓 grep 兜底**，否则修了主文档留了副本 = drift 没真消除。见 [[documented-claim-vs-code-reality-drift]]。
- **三方一致性测试固化**：`test-init-obsidian-vault.js` 把「graph 配色 == Dashboard 查询 == 期望 vault 类」变成确定性 gate，防止未来重新引入空转配色（[[ADR-013]] mechanism-over-discipline 在 Obsidian 接入维度的落点）。

## Follow-up（2026-06-01）：是否自动接入 → 「存在即刷新」策略

**问题**：用户问"是否需要自动接入 Obsidian"。厘清两层后定策略：
- **知识持久化层**（hook 写 memory/topic/solution/session markdown）—— 早已自动，不依赖 Obsidian。
- **vault 可视化脚手架**（graph.json/Dashboard）—— 此前仅 `--obsidian` opt-in；真实痛点是「系统加新 tag 类（如本 sprint 加 `#memory`）后，用户已有 vault 的配置静默过期」。

**决策（用户选）：存在即刷新**——安装时检测 homunculus dir 已有 `.obsidian/` 则自动刷新派生配置，无则不创建。非 Obsidian 用户零打扰（守 `轻量优先`），真用户配置始终与最新产出类型同步。

**关键勘察发现**：`init-obsidian-vault.js` 旧逻辑 `.obsidian/` 存在则**整体跳过**（line 415-416）→ graph.json colorGroups 永不刷新，无法承接"刷新"语义。

**改动**：
- `init-obsidian-vault.js`：(a) 新增 `mergeGraphColorGroups(existing)`——只替换系统管理的 colorGroups，保留用户布局偏好（scale/forces/未知字段）；(b) `.obsidian/` 存在时 graph.json 改为「解析→merge colorGroups→仅在有差异时写」，解析失败则备份重写；app.json/appearance.json 仅缺失时写（不覆盖用户偏好）；(c) Dashboard 幂等化——与 canonical 一致则跳过，避免重复安装堆 `.bak` 垃圾（[[feedback_ephemeral_artifact_three_piece_set]]）。
- 4 安装器（install.sh / install.ps1 / install-codex.sh / install-codex.ps1）：homunculus 初始化函数末尾加「`.obsidian/` 存在 → 静默调 init 刷新」，fail-open。双运行时 parity（[[ADR-011]]）。
- `test-init-obsidian-vault.js`：+2 测试（merge 保留布局偏好/替换 colorGroups；canonical 幂等）。真实 FS dogfood 验证：刷新修 drift（6 类、去 #rule）+ 保留 scale/repelStrength/app 偏好 + 二次运行零新 `.bak`。
- 验证：8/8 obsidian 测试、全量 22 suite、pre-commit exit 0、4 安装器语法解析全过。

**设计原则沉淀**：派生配置（colorGroups/Dashboard）= 系统管理，应随产出类型演化自动刷新；用户偏好（布局/app/appearance）= 保留不动。两者在同一文件（graph.json）共存时用**外科式字段合并 + 幂等写**区分，而非整体覆盖或整体跳过。
