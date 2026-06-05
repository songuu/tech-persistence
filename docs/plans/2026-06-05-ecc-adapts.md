---
title: "ECC-eval 两个 adapt 的实现计划"
type: plan
status: partial
created: "2026-06-05"
updated: "2026-06-05"
tasks_total: 9
tasks_completed: 4
tags: [plan, ecc, adapt, validator, instinct-mine, parity, p0d]
aliases: ["ECC adapts", "plugin-validator + instinct-mine"]
source_eval: "docs/solutions/2026-06-05-ecc-eval.md"
implementation_priority: ["adapt#1 done (2026-06-05)", "adapt#2 frozen — T5 spike no-go (2026-06-05, see ADR-025)"]

# 本计划立的不变量（后续 sprint 必须保持）
invariants:
  - ".claude-plugin/plugin.json 保持最小：不声明 commands/skills/agents/hooks/mcpServers（纯自动发现）"
  - "任意 MCP 工具的 Claude 全限定名 mcp__<server>__<tool> 必须 < 64 字符"
  - "挖掘/导入类 instinct 进场置信度必须折扣；repo-curation 初始置信度必须 <0.5，或由 source gate 明确排除 SessionStart 注入与 /evolve 聚类"
invariant_tests:
  - scripts/test-plugin-manifest-checks.js
deferred:
  - sprint: "后续"
    item: "单 VERSION 文件统一三处 manifest 版本（ECC-eval 候选 #10）"
    deadline: "切真版本发布时"
    reason: "当前三处均 1.0.0，新 checker trivially pass，未验证即上线（measure-before-enforce）"
---

# ECC-eval 两个 adapt 的实现计划

> 上游：`docs/solutions/2026-06-05-ecc-eval.md`（18 候选裁决 0 borrow / 2 adapt / 11 backlog / 5 reject）。本文把仅有的 2 个 adapt 深化为可执行设计。**status: partial**——adapt#1 已完成；adapt#2 经 T5 spike 自我否决并冻结（见 [[ADR-025]]），不再等待施工。

---

## 关键假设验证（[[ADR-012]] 强制段）

所有承重事实已经主循环 grep/read 自家代码核实，非凭记忆：

| 假设 | 可信度 | 如何验证 |
|---|---|---|
| 施工前 `validate-codex-plugin.js` 只验 `.codex-plugin/plugin.json`，对 `.claude-plugin` **零断言** | 高 | 初稿 grep `validate-codex-plugin.js`：仅 line 382 `path.join(pluginRoot,'.codex-plugin','plugin.json')`，无 `.claude-plugin` 命中；该 gap 已由 T1-T4 修复 |
| `.claude-plugin/plugin.json` 当前最小：**无** commands/skills/agents/hooks/mcpServers，version "1.0.0" | 高 | 实读全文件（21 行，仅 name/version/description/author/homepage/license/keywords） |
| `.codex-plugin/plugin.json` **持有** skills/hooks/mcpServers（与 Claude manifest 要求相反） | 高 | 实读全文件（line 21-23：`skills`/`hooks`/`mcpServers` 均在） |
| MCP 最长 Claude 全限定名 = `mcp__tech-persistence-memory__tp_memory_project_profile` = **55 字符**（<64，余量 9） | 高 | grep `scripts/lib/memory-tools.js` / `plugins/tech-persistence/mcp/lib/memory-tools.js`：5 工具 search/recent/save/file_history/project_profile；server 名 `tech-persistence-memory`（`scripts/lib/recall-usage.js`:189 注释佐证）；手算 5+23+2+25=55 |
| 两 manifest 均 git-tracked（在 `plugins/` 下）→ pre-commit / validate 在 commit 时**可见** | 高 | 路径在 git 仓库内，区别于 ADR-016 的 runtime-dir 盲区 |
| instinct-import 折扣先例 = 置信度 **×0.8** + `source:"imported"` | 高 | grep `user-level/commands/instinct-import.md`:16-17（"置信度乘以 0.8" + `source:"imported"`），示例 0.80→0.64 |
| **P0d 实测**：instinct 存储被 `repeated-workflow-*` / `tool-preference-*` 主导；当前 TP project id (`b68201be5c69`) 未见对应 project instinct dir；repo 约定沉淀主要仍在 rules/ADR/文档，不在 instinct 层 | 高 | `detectProjectIdentity()` 返回 `b68201be5c69`；glob `.claude` instinct 文件名前缀统计：repeated-workflow 6915、tool-preference 1206、other 33；`.codex` 当前只有 8331ab9c2853 有 9 条 instinct |
| 跨项目复现：不是"仅 1 个 project hash"；当前 `.claude/homunculus/projects` 至少 11 个 hash，其中 5 个有 instinct | 高 | glob `.claude/homunculus/projects`：01059013478f、0cd4920e1012、8331ab9c2853、84f95b41eeb1、abf0d88e85c1、d465b80103bc 等；候选 #3 是否永不触发需另做同 id 跨项目统计 |

---

## 优先级 0 测量结果（adapt#2 的闸门 / P0d 量化）

ECC-eval 要求"先零代码测量再决定 #2"。已执行（glob + 字段抽样）：

- **存储构成**：`.claude/homunculus` instinct 文件名前缀被 `repeated-workflow-*` 与 `tool-preference-*` 主导（spot-check：repeated-workflow 6915、tool-preference 1206、other 33）。这与 `scripts/evaluate-session.js::detectPatterns` 的产物结构一致：重复工具序列、错误恢复、热文件、重复命令，而非 repo 约定挖掘。
- **项目覆盖修正**：此前"仅 1 个 project hash + personal"不成立。当前 `.claude/homunculus/projects` 至少 11 个 project hash，其中 5 个有 instinct；`.codex/homunculus/projects` 目前 2 个 hash，其中 8331ab9c2853 有 9 条 instinct。
- **TP 当前项目锚点**：`node -e "const {detectProjectIdentity}=require('./scripts/lib/memory-v5'); console.log(detectProjectIdentity())"` 返回 `id: "b68201be5c69", name: "tech-persistence"`；该 id 在当前 `.claude/.codex homunculus/projects` spot-check 中未见对应 instinct dir。结论不是"全局只有外部项目有语义 instinct"，而是**当前 TP project id 没有稳定产出 repo-约定类 instinct**。
- **非 workflow 语义 instinct 存在，但不解决 TP P0d**：`8331ab9c2853` 下存在 `command-bloat` / `evidence-based-recalibration` / `reuse-existing-infra-before-building-new` 等语义条目；这些说明系统能产生语义 instinct，但当前 TP id 的 git/testing/parity/code-style 约定仍主要沉淀在 `rules/*.md` / ADR / solution 文档里，而不是 instinct 层。

**P0d 结论**：domain 多样性低 = **实测确认，但不是"只有单项目"问题**。真实问题更窄：当前自动 instinct 通道被 workflow/tool-preference 噪声主导，且 TP 当前 project id 没有稳定捕获 repo 约定。候选 #3（跨项目 promote）不能直接用"项目太少"否决；它需要另做同 instinct id 跨 project hash 的精确复现统计。

**adapt#2 推荐 = spike-first, proceed only if useful**：P0d 有真实靶子（TP 当前 project id 的约定未被 instinct 层捕获），但 ECC-eval 的冗余风险也真实（这些约定多已在 `rules/*.md`/CLAUDE.md 手述）。故 #2 不能直接全量施工；先做 T5 手跑一次，验证去重 gate 能挡住通用/手述条目，且产物真能填补沉睡 domain，再进入 T6-T9。

---

## Adapt #1：`.claude-plugin` manifest 确定性断言 + PLUGIN_SCHEMA_NOTES（P0a）

### 问题
施工前 `.claude-plugin/plugin.json` 已合规（最小、纯自动发现），但没有任何机制阻止未来回归：有人后续给它加 `agents`/`hooks` key（Claude validator 会判 "Invalid input"/"Duplicate hooks file" 静默坏安装），或新增一个长 MCP 工具名突破 64 字符 gateway 限制。这是 P0a（documented-claim-vs-code-reality drift）的纯粹形态：一个未文档化、版本相关的外部 validator 约束，靠"记得保持最小"维持。该问题已由 T1-T4 下沉为 deterministic validator。

### 方案
已在既有 `scripts/validate-codex-plugin.js` 中增设 `.claude-plugin/plugin.json` 的运行时专属断言（复用既有 manifest validator 入口，[[reuse-existing-infra-before-building-new]]）。**不可统一断言**：Codex manifest *要求* skills/hooks/mcpServers，Claude manifest *禁止* agents/hooks——按 TP 既有 runtime-projection 模式分别写。

断言内容（Claude manifest）：
1. **禁 `agents` / `hooks` key**：存在即 fail（Claude 自动发现，显式声明破坏安装）。
2. **`commands`/`skills` 若存在必须是数组**（防 Claude validator 形状拒绝）。
3. **MCP 全限定名守卫**：对所有 `mcp__<server>__<tool>` 断言 < 64 字符。当前最长 55（余量 9），属潜在非活跃——但 server 名或工具名增长会突破（如 `tp_memory_cross_project_recurrence` → 64 触顶）。

### 任务
| # | Task | 文件 | 风险 | 测试 |
|---|---|---|---|---|
| T1 | `validate-codex-plugin.js` 加 `validateClaudePluginManifest()`：读 `.claude-plugin/plugin.json`，断言禁 agents/hooks + commands/skills 数组 | scripts/validate-codex-plugin.js | L2 | 当前态跑 = pass |
| T2 | 加 MCP 全限定名 <64 守卫：从 manifest/mcp 注册派生所有 `mcp__server__tool`，超长 fail，错误含具体名+长度 | scripts/validate-codex-plugin.js | L2 | 注入一个 65 字符假名 → 必 fail |
| T3 | 写 `plugins/tech-persistence/.claude-plugin/PLUGIN_SCHEMA_NOTES.md`：记录"为何最小"+ 三条约束 + 历史（Obsidian frontmatter） | 新文件 | L0 | 无 |
| T4 | 负样本固化（[[ADR-013]] §B / [[feedback_negative_sample_3_archs]]）：测试断言 (a) 当前 pass；(b) 给 Claude manifest 加 `"hooks":{}` → 必 fail；(c) 注入 65 字符 MCP 名 → 必 fail | scripts/test-plugin-manifest-checks.js | L2 | 三档全绿 |

### break-impl 负样本（关键）
当前 manifest 已合规 → 新断言会 trivially pass，**必须主动制造负样本证明它真拒**（否则是 fail-open 上线）：
- **负样本 A**：临时给 `.claude-plugin/plugin.json` 加 `"hooks": "./hooks/hooks.json"` → 跑 validate **必须 exit≠0** 且错误指明 "Claude manifest 禁止显式 hooks"。
- **负样本 B**：临时把某 MCP 工具改名为 65 字符 → 跑 validate **必须 fail** 且打印该名+长度。
- 恢复后必须重新 pass。

### 不可妥协核验
- parity ✅（纯 node 校验，dev 时运行，两运行时无分歧）
- determinism ✅（确定性断言 + exit code）
- lightweight ✅（无新依赖，复用既有 validator）
- obsidian ✅（SCHEMA_NOTES 是 markdown）

### rollout gate（measure-before-enforce）
**已满足**：当前 Claude manifest 已合规、最长 MCP 名 55<64。本断言是防回归确定性护栏，不是修活跃 bug；已带 T4 负样本，避免"新 enforcement 在已合规态 trivially pass"。

### 施工状态（2026-06-05 已完成 ✅）

| Task | 状态 | 落点 |
|---|---|---|
| T1 | ✅ | `scripts/plugin-manifest-checks.js::checkClaudeManifest`（纯函数，repo-only）+ `validate-codex-plugin.js` 新增 `.claude-plugin` 校验块（禁 agents/hooks + commands/skills 数组） |
| T2 | ✅ | `findOverlongMcpNames`（拒 `>64`，不拒恰好 64 避免 FP）+ validator 从 `scripts/lib/memory-tools.js` 提工具名、从 `.mcp.json` 取 server 名派生全限定名校验 |
| T3 | ✅ | `plugins/tech-persistence/.claude-plugin/PLUGIN_SCHEMA_NOTES.md` |
| T4 | ✅ | `scripts/test-plugin-manifest-checks.js`（10 用例，含禁键/非数组/65 字符/边界 64 负样本）+ break-impl 集成验证（临时给真 manifest 加 hooks → validator exit≠0；65 字符 MCP 名 → exit≠0；try/finally 还原） |

**验证**：单测 10/10、全套件 24/24、`validate-codex-plugin.js` pass（新增两 [OK] 行）、`pre-commit-check.js` EXIT=0（仅 1 条非阻塞 warn：eval 文档里 ECC 外部文件 `install-manifests.js:139` 裸名引用，按 [[ADR-023]] 正确判 warn 不 block）。
**lib 放置决策**：`plugin-manifest-checks.js` 放 `scripts/`（非 `scripts/lib/`）——validator 本身不进 plugin 副本（不在 copyUtilityScripts 列表），其 require 的 repo-only lib 无 [[ADR-020]] parity 负担；若放 `scripts/lib/` 会被 `expectedHookLibs` inventory 纳入、强制 plugin hooks/lib 复制（无谓 P0c 表面）。
**MCP ≤64 边界**：Anthropic 工具名硬限制 `{1,64}` = 最多 64 含；守卫拒 `>64`（拒 `≥64` 会误杀合法 64 字符名 = P0e FP）。

---

## Adapt #2：lean `/instinct-mine` repo-约定采集通道（P0d）

### 问题
detectPatterns 单一文化（实测：存储几乎全是 `repeated-workflow-*`，TP 自家 git/testing/parity 约定从未进 instinct 层）。需要一个**与 session-observation 正交的第二采集通道**，一次性从 repo 约定生成 instinct，填充沉睡 domain。

### 方案（丢弃 ECC 全部机器）
ECC 的 repo-curation 靠 Python daemon + Haiku + 1826 行 instinct-cli.py + auto-promote——**全部违反 lightweight-first + parity，丢弃**。TP 版 = **model-driven markdown 命令**（类 `/learn`，零确定性 backing code，与既有命令同构）：

1. **输入**：读 `git log`（commit 前缀/主题长度约定）、配置文件（lint/test/tsconfig）、目录结构、CLAUDE.md/rules 现有规则。
2. **输出**：`source: "repo-curation"` 的 instinct，frontmatter 同既有 schema（id/trigger/confidence/domain/scope/source/body）。
3. **折扣进场**（守 instinct-import 先例 ×0.8，但更狠）：mined instinct **初始置信度 <0.5**，或由显式 `source: "repo-curation"` gate 排除 SessionStart 注入与 `/evolve` 聚类；**必须经 session 确认才升**。原因：`scripts/inject-context.js` 当前项目本能注入阈值是 `>=0.5`，`/evolve` 文档也读取 `>=0.5`；写 `≤0.5` 会让 `0.50` 误入。
4. **去重 gate**：生成前比对 `rules/*.md` + CLAUDE.md + 既有 instinct，**已手述的约定不再生成**（避免冗余通用 instinct 如"用 conventional commits"——这是 ECC-eval 标记的 #1 冗余风险）。
5. **recall-usage gate**：mined domain 是否真被触及，由既有 `recall-usage.jsonl`（demand-side telemetry）事后度量；连续 N 会话 dormant 的 mined instinct 自动降权/裁剪（复用既有 telemetry，不新建）。
6. **/evolve 污染防护**：仅靠 `<0.7` 不够，因为 `/evolve` 读取阈值是 `>=0.5`。必须二选一：(a) mined 初始置信度严格 `<0.5`；或 (b) 修改 `/evolve` 协议/实现，明确过滤 `source:"repo-curation"` 直到 session-confirmed。

### 任务
| # | Task | 文件 | 风险 | 测试 |
|---|---|---|---|---|
| T5 | 写 `user-level/commands/instinct-mine.md`：协议（读 git/config → 去重 → 折扣 `<0.5` mined instinct，或显式 source gate） | 新文件 | L2 | 手跑产出 `<0.5` + source:repo-curation；或证明 source gate 排除注入/evolve |
| T6 | propagate 到双运行时：`.codex/commands/instinct-mine.md` + plugin skill wrapper | propagate-command-changes.js 入参 | L1 | propagate + build + validate + pre-commit 全绿 |
| T7 | 去重 gate 协议：生成前比对 rules/CLAUDE.md/既有 instinct，命中则跳过 | instinct-mine.md | L2 | 喂已存在约定 → 不生成 |
| T8 | inject/evolve 护栏确认：mined `<0.5` 不进注入、不进 /evolve；若要允许 `>=0.5`，必须加 source 过滤 | scripts/inject-context.js, /evolve | L3 | mined instinct 不出现在 SessionStart 注入；不进入 /evolve 候选 |
| T9 | recall-usage gate 文档化：mined domain dormant 度量复用 recall-usage.jsonl | instinct-mine.md + 文档 | L1 | 无（度量已存在） |

### 不可妥协核验
- parity ✅（markdown 命令，propagate 到 Codex，与既有命令同构）
- determinism ⚠️（命令产出是 LLM 语义判断，无 exit code——与 /learn 同性质，靠 prompt 约束 + `<0.5`/source gate 缓解，非确定性 enforcement）
- lightweight ✅（零新脚本/依赖；丢弃 ECC daemon/Python）
- obsidian ✅（instinct 是既有 markdown frontmatter 格式）

### rollout gate（measure-before-enforce）
**低紧迫 + 条件触发**：优先级 0 测量确认 P0d 真实，但也修正了"只有单 project hash"的错误前提。施工前先做 T5 spike，确认 T7 去重 gate 能真挡住冗余，并确认 T8 注入/evolve 护栏不是靠误读阈值成立。**若首次手跑 `/instinct-mine` 产出的多是已在 rules 手述的通用条目，则本特性自我否决，落为"设计冻结、暂不并入"**。recall-usage gate（T9）是事后验证 mined instinct 是否真被用的闸——dormant 率高则证明该通道低价值，回滚。

### T5 Spike 结果（2026-06-05 自我否决 ❄️ → 设计冻结）

> 执行方式：4-phase 对抗 workflow（枚举 mineable 候选 → T7 去重 gate 干跑 → 对抗核验每个 net-new survivor → 综合裁决），23 agents。决策落 [[ADR-025]]。

| 指标 | 结果 |
|---|---|
| 枚举候选（mine 会从 git/config/dir/code 提取的约定） | 40 |
| T7 去重 gate 干跑 | `{total 39, redundant 22, net_new 17}`，**gate_works=true**（成文约定被正确剔除——gate 机制本身有效） |
| net-new 对抗核验 keep | **0/17**（9 metric-gaming / 6 dormant-prone / 2 marginal） |
| T8 护栏结论 | guard = **both**：`<0.5` confidence block 必要但**不充分**（`sub_0_5_blocks=true` 但 `source_gate_needed=true`，因 0.50 边界 + `/evolve` 升权），须叠加 `source:"repo-curation"` 字段过滤 |
| 裁决 | **self-veto-freeze**（confidence 0.86） |

**根因**：TP 是「文档即交付物」的自进化 meta-tooling repo——约定密集成文于**三层每会话注入的上下文**（全局 `CLAUDE.md`+`rules/`、项目 `CLAUDE.md`+`.claude/rules/` 含 23 ADR + ~25 gotchas、~30 `feedback_*`/`user_*` memory）。`inject-context.js` 虽不 surface rules/CLAUDE.md（`inject_surfaces_rules=false`），但 host runtime 已每会话注入——挖成 instinct 只是第二通道再注入一份拷贝，**零行为增量**。survivor 全是低价值工具琐事（run-tests.js dispatcher、`test-*.js` colocation、`.bak.<ts>` 命名、`use strict` 头注释、UPPER_SNAKE 常量），其中数条 `absent=true`（确未成文）但价值判 dormant-prone/metric-gaming，非真有用。

**关键区分（防过度泛化）**：`0-survivor` 是 **repo-specific** 结论（doc-saturated repo），**不是「机制无价值」的普适裁决**。`/instinct-mine` 在文档稀薄的普通 product repo 上可能有真价值——revival 前必须先在那类 repo 重做 spike（见 [[ADR-025]] 影响段）。

**附带 finding**：spike 暴露一个真实 doc gap——`.claude/rules/api-conventions.md` / `performance.md` / `testing-patterns.md` 是 header-only 空模板。gap 真实，但 `/instinct-mine` 没挖出可填的，故 gap 另行处理（不靠 mine）。

**决定**：T6-T9 **不推进**；adapt#2 设计冻结。任何未来 revival 须 (a) 先在 thin-doc repo 重 spike 证明 yield，(b) 上线带 both guard。

---

## 实施顺序与总 gate

```
优先级 0（已完成）：P0d 测量 → 确认 #2 只能 spike-first
   ↓
adapt#1（独立，可先做）：T1-T4，低紧迫但成本低，带负样本即可并入
   ↓
adapt#2（条件）：T5 先手跑一次验证去重 gate + <0.5/source gate
   ├── 产出多为冗余通用条目 → 自我否决，设计冻结
   └── 产出真填充沉睡 domain → T6-T9 并入，recall-usage 事后验证
```

两者**互不依赖**，可并行或仅做其一。均非立即承诺——本计划冻结设计 + 触发条件，等用户决定施工。

---

## 变更日志
- 2026-06-05：初稿。基于 ECC-eval 的 2 个 adapt 深化为实现计划。承重事实全部 grep 核实（[[ADR-012]]）。优先级 0 P0d 测量执行并初判（workflow-monoculture + TP 自身 0 语义 instinct）。adapt#1 = .claude-plugin validator 断言（低紧迫、防回归、带负样本）；adapt#2 = lean /instinct-mine（当时初判为 proceed-with-caveats，后续优化已收紧为 spike-first）。初始 status: draft。
- 2026-06-05：文档优化。修正上游路径、MCP/recall 文件路径、P0d 测量过度结论、当前 project id、跨项目 hash 数量；将 adapt#2 从 proceed-with-caveats 收紧为 spike-first，并把 mined instinct guard 从 `≤0.5/<0.7` 改为 `<0.5` 或显式 source gate。
- 2026-06-05：**adapt#1 施工完成**（T1-T4）。新增 `scripts/plugin-manifest-checks.js`（纯函数）+ `scripts/test-plugin-manifest-checks.js`（10 用例三档负样本）+ `.claude-plugin/PLUGIN_SCHEMA_NOTES.md`；`scripts/validate-codex-plugin.js` 接入 `.claude-plugin` manifest 校验 + MCP 全限定名 ≤64 守卫。单测 10/10、全套件 24/24、pre-commit EXIT=0、break-impl 双负样本真拒。tasks_completed 4/9。adapt#2 仍 spike-first 未施工。
- 2026-06-05：**adapt#2 T5 spike 执行 → self-veto-freeze**。4-phase 对抗 workflow（23 agents）：40 候选 → 去重 `{redundant 22, net_new 17}`（gate_works=true）→ 对抗核验 keep **0/17**（metric-gaming/dormant-prone/marginal）。根因 = doc-saturated meta-tooling repo，约定已三层每会话注入。决策落 [[ADR-025]]：冻结 T6-T9，revival 须先在 thin-doc repo 重 spike + 带 both guard（`<0.5` + source-gate）。adapt#2 部分 status 视为 frozen（不再 draft 等施工）。

## Related
- [[2026-06-05-ecc-eval]] 上游评估（本计划只深化其 2 个 adapt）
- [[ADR-012]] Plan 阶段必须勘察被改文件
- [[ADR-013]] mechanism-over-discipline + §B 负样本/dogfood 边界
- [[ADR-020]] require-closure / plugin 副本 parity
- [[ADR-022]] measure-before-enforce / demand-side telemetry（recall-usage gate 依据）
- [[documented-claim-vs-code-reality-drift]] P0a 元本能（adapt#1 针对）
- [[feedback_negative_sample_3_archs]] 三档负样本（T4 依据）
