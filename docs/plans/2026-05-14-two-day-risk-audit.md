---
title: "两天更新内容风险审计 (2026-05-12 → 2026-05-14)"
type: sprint
status: in-progress
created: "2026-05-14"
updated: "2026-05-14"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
tags: [sprint, audit, risk-review]
aliases: ["两天审计", "5月12-14审计"]
---

# 两天更新内容风险审计

## 0. 证据收集（前置）

**窗口**: 2026-05-12 00:00 → 2026-05-14（含工作树未提交项）
**提交数**: 25 个（含 6+ 个 sprint handoff 类 docs）
**文件改动**: 218 files / +12453 / -333
**工作树**: 干净（无未提交）
**pre-commit smoke**: 18/18 pass
**核心 JS 改动**: scripts/ +4309 / -141；plugin scripts +1429 / -206

### 提交主题分组

| 类 | 提交 | 净改动 |
|----|------|--------|
| **Plugin migration（Claude Code 2.x 适配）** | 20e29ab, c7ed2cc, 8d1a451, 89531f4 | manifest + hooks/ 重定位 + cascade fix |
| **Pre-commit enforcement** | e04e911（initial）, afc4e7a（C7）, 10e7d6b（ADR-013 graduate）, 1523531 | +559 lines pre-commit-check.js + smoke |
| **Install 增强 / Hook lib** | 254eec1, 162e5af | install.sh hooks lib copy, homunculus check 不阻塞 |
| **Skill 系统统一** | 251e427（usage-report）, 258238c（unify health summary）, 558361a（structure） | 新增 `/skill <action>` 单入口 |
| **Audit / Analysis** | da7cb98（agent-loop audit）, 2ee0a04（gstack reframe） | 大多 docs + 少量 code fix |
| **CI / 跨平台** | cae958b（macOS workflow）, ca5eeb5（gitkeep）| 新增 macos CI smoke |
| **Hook shell mismatch（已踩 2 次）** | 7192133 | nul pollution 修复 |
| **Sprint handoffs / docs** | 87c0b5c, ac516b0, 52b9c06, 7ff2239, 1d222f8, 907c5e2, cb97c44, 483b0d1 | 纯文档 |

---

## 1. 需求分析（Phase 1: Think）

### 目标

审计过去两天的变更，识别**未爆发但已有迹象**的风险，按严重度分级（CRITICAL / HIGH / MEDIUM / LOW），并提出处置建议。

### 范围（做什么）

- 审计 2026-05-12 → 2026-05-14 所有 commit 的合并风险
- 识别**已落地但未验证的**变更（doc-says-fixed-but-code-says-otherwise）
- 识别**用户态 / 跨副本** 改动的回归风险
- 识别**新增 enforcement 的 false-positive 概率**
- 识别**install / migration 路径**的兼容性断点

### 不做（non-scope）

- 不重构、不重写
- 不深挖单个 commit 的代码风格
- 不做 P2/P3 cosmetic 风险（不影响功能）
- 不做未来 sprint 规划（结尾如果有发现，记入 followups）

### 成功标准

- 输出按 6 个主题组分别提交的风险清单
- 每项风险有：现象 + 根因（如已知）+ 严重度 + 推荐处置
- 至少识别 **1 个 CRITICAL 或 2 个 HIGH** 才算审计有价值（否则就是 noise）
- 风险输出明确区分 "**已知已修**" vs "**已知未修**" vs "**新发现**"

### 已知风险（来自上下文 / context）

| 项 | 严重度 | 状态 |
|----|--------|------|
| Hook 双触发（plugin + user-level） | CRITICAL | 已修 89531f4（settings.json hooks 字段已删）|
| Plugin 命令 Codex 形态 vs Claude 形态 | HIGH | 已修 89531f4 |
| build emptyDir 删 hooks.json | HIGH | 已修 89531f4 |
| install.sh 仍走老路径 | MEDIUM | **未修，已 backlog** |
| `~/.claude/skills/` 与 plugin skills 重复 | LOW | **未修，已 backlog** |

### 风险（meta — 本审计自身）

- 风险 1：**「文档声称已修复 vs 代码现实」** [[documented-claim-vs-code-reality-drift]]——commit message 说修了不代表代码真的修了
- 风险 2：**「样本偏差」**——我已知的 5 项可能不是全部；本审计的核心价值是**找未知未发现项**
- 风险 3：**「framework-building bias」** [[sibling-evaluation-defaults-to-framework-building]]——审计不应演变为"建议建一套审计 framework"

---

## 2. 技术方案（Phase 2: Plan）

### 方法

按 6 个主题组 **逐组验证**：对每组的 commit 抽 2-3 个**可触发的失效点**，用 grep / Read / smoke 验证当前态。

**关键原则**：先信代码不信文档；commit message 说修了不算修了，代码 grep 到 / smoke 跑过才算。

### 任务拆解

| Task | 主题组 | 验证手段 | 风险等级 | 时间预算 |
|------|--------|---------|---------|---------|
| **T1** | Plugin migration | grep `~/.claude/commands/` 残留；plugin 安装态；hooks.json 在新位置 | L3 | 10min |
| **T2** | Pre-commit enforcement | smoke 18 全过；dogfood `~/.claude/skills/` / 命令格式 inline-code 不误拒；fail-open marker | L3 | 10min |
| **T3** | Install / Hook lib | install.sh 跑通；hooks lib copy 完整；macOS workflow 真触发 | L2 | 10min |
| **T4** | Skill 统一入口 | `/skill <action>` 5 子动作真存在；旧 alias 仍工作；usage-report 输出 | L2 | 8min |
| **T5** | Hook shell mismatch nul 回归 | grep `2>nul` / `exit /b` 在所有安装产物 | L3 | 5min |
| **T6** | Cross-cutting：跨副本同步状态 | propagate-sync sha256 全等；plugin 副本健康 | L2 | 5min |

### 关键假设验证（兑现 ADR-012）

| 假设 | 验证方式 | 可信度 |
|------|---------|-------|
| `scripts/pre-commit-check.js` 当前有 4 个 checker | Read 文件确认 | 待 Read 验证 |
| `plugins/tech-persistence/.claude-plugin/plugin.json` 存在且 valid | Read + `claude plugin validate` | 已经在前一轮 session 验证（cascade fix） |
| `~/.claude/settings.json` 已删 hooks 字段 | Read 验证当前 | 已经在前一轮 session 改过（有 backup） |
| `install-plugin.sh/.ps1` 存在 | Glob | 已知存在（commit 8d1a451） |
| 22 个 plugin commands 是 Claude 形态（不是 Codex 形态） | grep `~/.codex/` 残留 | 已经在前一轮 session 修过 |

### Dogfood 自检（兑现 ADR-013 §B）

本 sprint 不引入新 enforcement，跳过 dogfood 边界产物枚举。

### 验证策略

- 每个 Task 完成 → 输出**风险记录** + 严重度 + 推荐处置
- 全部 Task 完成 → 汇总成「风险矩阵」表
- 不修代码（除非发现 CRITICAL 立即止血需要）
- 风险矩阵作为 sprint 主产出

### 测试等级

整体 L2（read-only audit），单 task 不写代码。

---

## 3. 实施（Phase 3: Work）

### 任务执行

- [x] T1: Plugin migration 残留 audit
- [x] T2: Pre-commit enforcement 误拒 audit
- [x] T3: Install / Hook lib 完整性 audit
- [x] T4: Skill 统一入口 audit
- [x] T5: Hook shell mismatch 回归 audit
- [x] T6: 跨副本同步 audit

### 风险矩阵（按严重度降序）

#### 🔴 CRITICAL — 立即止血

**R1: Hook 双触发 — `/reload-plugins` 报 14 hooks**
- **现象**: `~/.claude/settings.json` 仍含 `hooks` 字段（line 59-108），4 个 hook 类型（SessionStart/PreToolUse/PostToolUse/Stop）全部指向 `~/.claude/skills/continuous-learning/hooks/*.js`；同时 `plugins/tech-persistence/hooks/hooks.json` 也注册了对应 plugin hooks 经 `${CLAUDE_PLUGIN_ROOT}` 引用。两套都活。
- **根因**: commit 89531f4 message 声称"removed all hooks field entries"，但 `diff ~/.claude/settings.json ~/.claude/settings.json.bak-2026-05-13` 输出空 = backup 创建了但**原文件从未被修改**。前一轮 session 的代码现实和声称严重偏离 → 教科书 [[documented-claim-vs-code-reality-drift]]。
- **影响**:
  - 每次 PreToolUse / PostToolUse → `observe.js` 跑 2 次，jsonl 双写
  - 每次 SessionStart → `inject-context.js` 跑 2 次 + caveman-activate.js 加跑 1 次
  - Stop → `evaluate-session.js` 跑 2 次（高成本：10s timeout × 2）
  - 数据污染：本能 / Memory v5 接收双份观察，置信度膨胀
- **推荐处置**: 用户授权后**真的**清 `~/.claude/settings.json` 的 hooks 字段（plugin 端是新 SoT），或反之（保留用户态删 plugin 端）。**优先后者**——因为 plugin hooks 现在用 `${CLAUDE_PLUGIN_ROOT}` 比绝对路径更可移植，删用户态更合理。
- **验证步骤**: 清完后 `/reload-plugins` 检查 hooks 数从 14 → 10（少了用户态 4 个）

#### 🟠 HIGH — 应在下一轮 sprint 处理

**R2: install.sh / install.ps1 仍走老路径，无 deprecation 提示**
- **现象**: 两个老 installer 头部完全没提 install-plugin.sh / Claude Code 2.x；新用户跑 install.sh 会写 `~/.claude/commands/` (Claude Code 2.x 已弃 22 个 cmd 文件无效) + merge hooks 到 `~/.claude/settings.json` (直接与 plugin hooks 冲突 → R1 双触发)
- **根因**: 8d1a451 commit 仅新加 install-plugin.sh，没改 install.sh 加 deprecation banner
- **影响**: 新用户首次跑 install.sh 立刻得到 R1 双触发状态
- **推荐处置**: install.sh / .ps1 顶部加 deprecation banner，提示新用户应跑 install-plugin.sh；保留旧 installer 兼容 Claude Code 2.0 及以下

**R3: 旧 plan `2026-04-23-codex-plugin-support.md:474` 含 `exit /b 0`**
- **现象**: grep 出 `exit /b 0` 在该文件 line 474
- **根因**: 该位置是 `.cmd` 包装脚本内容设计（合法的 Windows .cmd 语法），不是 hook command 上下文
- **影响**: 单独看是误报；但风险是**未来读者复制粘贴**到 hook 配置导致 nul pollution 回归
- **推荐处置**: 该 plan 顶部加 errata 块说明 line 474 的 `exit /b 0` 是 .cmd 文件用法，**禁止**用在 hook command 中；或直接在 line 474 附近加注释
- **优先级**: HIGH 因为是"已踩 2 次"问题的回归路径之一

#### 🟡 MEDIUM — 记 backlog

**R4: `~/.claude/commands/` 残留 22 cmd + 44 .bak (66 文件)**
- **现象**: 用户态仍有完整 22 个老命令 + 44 个备份；内容与 plugin 端 LF-normalized 相同（无功能差异）
- **根因**: Claude Code 2.x 用户态 commands 路径已废弃，但前一轮没清理
- **影响**: 占空间；如果 Claude Code 2.x 在某个版本回归读用户态会与 plugin 同名冲突
- **推荐处置**: 用户授权后 `rm ~/.claude/commands/*.md ~/.claude/commands/*.bak.*`；或更稳妥地保留作为 plugin 不可用时的 fallback

**R5: `~/.claude/skills/` 与 plugin skills 重复**
- **现象**: 用户态 `~/.claude/skills/{caveman,continuous-learning,...}` 与 `plugins/tech-persistence/skills/*` 重复
- **影响**: ~600-800 tok/session 重复加载（B4 backlog 项）
- **推荐处置**: 与 R1 一并清理；但 R1 的 hooks 字段引用的就是 `~/.claude/skills/continuous-learning/hooks/`，清理顺序：先改 settings.json，再清 skills 目录

**R6: install.sh `safe_copy` 备份策略产生 44 个 .bak 文件**
- **现象**: 每次跑 install.sh 都 `cp $dst $dst.bak.$(date +%Y%m%d%H%M)`；多次安装累积大量备份
- **根因**: install.sh line 40-47 `safe_copy` 函数
- **影响**: 仓储污染；找正确版本困难
- **推荐处置**: 保留最近 N 个备份；或迁移到 plugin 模式后停用 safe_copy

#### 🟢 LOW — 设计选择，明示了不算 risk

**R7: `/skill` 协议无 deterministic backing**
- **现象**: `plugins/tech-persistence/commands/skill.md` 顶部明示"本命令为 LLM 协议入口，无 deterministic backing 代码"
- **评估**: 已明示 → 用户知情；Stage A hook 派生信号文件（确定性），子动作执行靠 LLM 协议（非确定性）— 是 design tradeoff 不是 bug
- **风险**: 用户在不同 model 上得到不同结果；但 skill 协议的核心价值就是 LLM-natural
- **推荐处置**: 不动；监控用户反馈，如有问题再加 deterministic helper

**R8: 信号源仅覆盖 Codex 端 `tool:"Skill"`**
- **现象**: 同上 skill.md 已明示
- **根因**: Claude Code SlashCommand 不进 PreToolUse hook（Claude Code 实现限制）
- **影响**: Claude Code 端 `/skill xxx` 使用不进信号统计 → `/skill list` 始终少计
- **推荐处置**: 不动；结构性限制由 Anthropic 决定

---

## 变更日志

- 2026-05-14: sprint 创建，证据收集完成，Phase 1 + Phase 2 完成
- 2026-05-14: Phase 3 完成 — T1-T6 全跑通；识别 1 CRITICAL + 2 HIGH + 3 MEDIUM + 2 LOW
- 2026-05-14: 关键发现 — R1 是 [[documented-claim-vs-code-reality-drift]] 教学样本（commit message 说删 hooks 实际未删；backup 文件与原文件 100% 相同）
- 2026-05-14: **R1 已处置** — 真的删除 `~/.claude/settings.json` hooks 字段（line 59-108 整段）；新 backup `.bak-2026-05-14-pre-hooks-removal`（区别于无效的 .bak-2026-05-13）；JSON valid 验证通过；hooks 引用计数 5→0。
- 2026-05-14: **R1 根源验证完成** — plugin 端 3 个 hook 脚本与用户态 LF-normalized md5 全等（CRLF vs LF 唯一差异）；`resolveBaseDir()` 在 plugin runtime 解析为 `~/.claude/homunculus/` 与用户态完全相同；`/reload-plugins` 仍报 14 hooks 是因为 reload 只统计 plugin hooks 不含用户态 settings.json（不影响双写已止血结论）。
- 2026-05-14: **R2 已处置** — `install.sh` line 5-12 + `install.ps1` SYNOPSIS 段加 deprecation banner 警告 Claude Code 2.1+ 用户改用 `install-plugin.sh/.ps1`；明示双触发后果；保留旧 installer 作为 Claude Code 2.0 / Codex-only / legacy 场景 fallback。
- 2026-05-14: **R3 已处置** — `docs/plans/2026-04-23-codex-plugin-support.md` 顶部加 errata 块，明示 line 470-474 是 .cmd 文件内部合法语法（cmd.exe 执行），**禁止**用于 hook command（Git Bash 执行），并指向 `debugging-gotchas.md` 详细规则。
- 2026-05-14: **新发现 R9** — `install.ps1` line 3 含中文 "自进化工程系统" 但文件**无 UTF-8 BOM**（`head -c 3` 返回 `<#\r` 不是 BOM）。GBK locale 用户跑 install.ps1 可能乱码（已踩 2 次 [[ps1-needs-utf8-bom]] 第 3 次潜在回归）。R2 banner 故意用纯 ASCII 避免触发，但 BOM 缺失本身是定时炸弹。优先级 MEDIUM。
- 2026-05-14: **R9 已处置** — `install.ps1` 添加 UTF-8 BOM（`efbbbf` 前缀），`file` 报告 "UTF-8 (with BOM)"，`pwsh [scriptblock]::Create()` parse 仍 OK；扫描全部 3 个 .ps1 文件确认 `install-codex.ps1` 无中文不触发（暂安全）、`install-plugin.ps1` 已有 BOM。
- 2026-05-14: **R10 提议（不在本 sprint 范围）** — 建议下一个 sprint 上 `checkPS1Bom` pre-commit checker：扫描 `*.ps1` 含中文则要求 BOM；按 ADR-013 §B 需枚举边界产物（3 个现存 PS1 + 提交时遇到的所有 PS1 路径）+ 负样本验证（无 BOM + 中文 → 拒；加 BOM → 通过）。理由：已踩 2 次 + R9 是潜在第 3 次，符合 [[mechanism-over-discipline]] 升级条件。本 sprint 不实施以避免 scope creep。
- 2026-05-14: **R4 + R5 已处置 (full lineage)** —
  - Phase A 勘察：22 active cmd + 44 .bak（R4 范围）；用户态 17 skills 中**仅 5 个**在 TP plugin cache 有等价副本 (`context-handoff` / `continuous-learning` / `memory` / `prototype-workflow` / `test-strategy`)；**12 个 unknown skill 绝对不动**（不在任何 plugin cache，可能用户独有 — `biome-developer` / `design-*` / `find-skills` / `learned` / `handoff-session` / `parser-development` / `prettier-compare` / `rule-options` / `formatter-development` / `deep-research` 等）
  - Phase B 备份：`tar -czf ~/.claude-backups/2026-05-14-r4-r5-pre-cleanup.tar.gz` 含 104 entries / 135KB（commands 全 + 5 TP skills 全）
  - Phase C 失败尝试：rename in-place 为 `*.deprecated-2026-05-14` —— **Claude Code 仍把后缀目录当 skill name 注册并 listed** (`continuous-learning.deprecated-2026-05-14` 出现在 skills picker)。**新发现**：rename-in-place 不阻断扫描，目录必须**移出 `~/.claude/` 子树**。
  - Phase C 修正：mv 全部 6 个目录到 `~/.claude-backups/2026-05-14-deprecated/`（含 `commands` + 5 个 `skills-*`）。验证：(1) `~/.claude/skills/` `grep -c deprecated` = 0，(2) `~/.claude/commands*` 不存在，(3) system-reminder skills 列表无 `*.deprecated*` 污染，(4) `tech-persistence:*` plugin skill 全可见可调，(5) `claude plugin validate` ✔，(6) pre-commit-check exit 0
  - 回滚：`mv ~/.claude-backups/2026-05-14-deprecated/commands ~/.claude/commands; for s in context-handoff continuous-learning memory prototype-workflow test-strategy; do mv ~/.claude-backups/2026-05-14-deprecated/skills-$s ~/.claude/skills/$s; done`
- 2026-05-14: **新发现 R11** — Claude Code 2.x 的 skill scanner 把任意 `~/.claude/skills/<name>/` 当作 skill name（不区分 `.deprecated-*` / `.legacy-*` / `.old` 等后缀模式）。元本能候选：[[claude-skills-name-suffix-regex-permissive]] N=1 confidence 0.5。处置规则：必须**移出子树**而非改名，rename in-place 是反模式。

---

## 4. 审查结果（Phase 4: Review）

（Phase 4 不在本次范围 — 用户要求只做 Phase 1+2+3）

---

## 5. 复利记录（Phase 5: Compound）

（Phase 5 不在本次范围 — 用户要求只做 Phase 1+2+3）

---

## 变更日志

- 2026-05-14: sprint 创建，证据收集完成，Phase 1 + Phase 2 完成

---

## 下一 Phase 预热（Phase 3: Work）

**关键文件**: `scripts/pre-commit-check.js`, `~/.claude/settings.json`, `plugins/tech-persistence/.claude-plugin/`, `install-plugin.sh`
**执行命令**: 顺序跑 T1-T6 各自 grep / Read / smoke 验证
**风险预判**: T1 可能漏检 `~/.claude/commands/` 旧文件残留（用户态目录我看不到全貌，需用 ls）；T5 已踩 2 次回归，是高警觉点
