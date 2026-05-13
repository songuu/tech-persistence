---
title: "22 个 tech-persistence 命令精准使用率统计"
type: sprint
status: completed
created: "2026-05-13"
updated: "2026-05-13"
tasks_total: 8
tasks_completed: 8
parent_decision: "docs/plans/2026-05-12-gstack-latest-analysis.md (Phase 4 reframe Task 7)"
tags: [sprint, observability, usage-stats, command-audit]
aliases: ["command-usage-report", "usage-stats"]
---

# 22 个 tech-persistence 命令精准使用率统计

> 解决 `2026-05-12-gstack-latest-analysis.md` 的 Task 7 用「docs 提及次数」作 proxy 的问题，改用**精准信号源**（Claude Code transcript + Codex observations）。

## 需求分析

### 背景

`2026-05-12-gstack-latest-analysis.md` Task 7 用「docs/plans/ + docs/solutions/ 提及次数」作为命令使用率 proxy，得出 43% 命令证据不足、4 个 0 提及。基于此推断"清理 9 个低频命令到 experimental/"。

**用户在 2026-05-13 明确否决"清理"路径**：当时的 21 个命令都需要保留。随后新增 `/skill` 统一入口，当前统计口径为 **22 个命令**。本 sprint 需要一份**精准统计文档**反映真实使用频率，用于未来决策（不是清理决策，是观察 + 复盘的依据）。

### 已勘察的数据源

| 源 | 路径 | 覆盖 | 精度 |
|---|---|---|---|
| Claude Code transcript | `~/.claude/projects/c--project-my-tech-persistence/*.jsonl` | 2026-04-13 → now（15 sessions） | ✅ 100% |
| Codex observations | `~/.claude/homunculus/projects/8331ab9c2853/observations.jsonl` + `archive/` | hook 安装后 | ✅ 100% |
| ~~observations command_family~~ | 同上 | 仅 Bash 命令家族 | ❌ 不适用 slash 命令 |

### 关键假设验证（ADR-012）

| 假设 | 验证文件 | 结果 | 可信度 |
|---|---|---|---|
| Claude Code transcript 含 `<command-name>` 标签 | `~/.claude/projects/c--project-my-tech-persistence/*.jsonl` | ✅ 命中（user message content 字符串中）| high |
| `<command-name>` 在 message.content 为字符串时 = 真实触发；为 array 时 = tool_result 噪音 | 抽样比对两类 entry | ✅ 验证 | high |
| Codex `tool:"Skill"` + `input_summary.skill` 是 slash 命令精准信号 | `observations.jsonl` 4 个 Skill 命中 | ✅ skill=sprint | high |
| Codex hook 双触发产生重复（同秒同 skill）| 4 entries = 2 pre + 2 post，间隔 34/41ms | ✅ 需去重（按秒级 timestamp + skill）| high |
| cwd → transcript slug 派生规则 = lowercase + `:`/`\`/`/`→`-` | `C:\project\my\tech-persistence` → `c--project-my-tech-persistence` | ✅ 实测匹配 | high |
| 22 命令白名单 | `ls user-level/commands/*.md` | ✅ 22 文件 | high |

### 要做

1. 写 `scripts/lib/usage-aggregator.js` — 双源聚合引擎（去重 + 时间分桶）
2. 写 `scripts/usage-report.js` — CLI 入口（markdown 写文件 / inline / json）
3. `/review-learnings --usage` 集成
4. 跨副本同步（.codex + plugin）
5. 生成首份报告 `docs/reports/command-usage-2026-05-13.md`

### 不做

- ❌ 不动 observe.js / memory-v5.js schema（保持下游兼容）
- ❌ 不写数据库/SQL（纯文件聚合，符合"轻量"原则）
- ❌ 不实时计算（按需 CLI，不进 hook）
- ❌ 不去重 CC 和 Codex 同名命令（分别统计，合计列）
- ❌ 不清理任何命令（用户已否决）
- ❌ 不解析对话式触发（"实现 X" 类）— 数据局限明示

### 成功标准

- [x] 22 命令白名单与 `user-level/commands/` 一致
- [x] Claude Code transcript 字符串 content 精准捕获（排除 tool_result 噪音）
- [x] Codex observations 同秒同 skill 去重
- [x] 输出含 30 天 + 累计双视图 + 首末时间戳
- [x] CLI 三模式可用：默认写文件 / `--inline` / `--json`
- [x] `/review-learnings --usage` 集成
- [x] 跨副本同步通过 `node scripts/pre-commit-check.js`
- [x] 首份报告生成

## 技术方案

### 任务拆解

| # | Task | 风险 | 涉及文件 | 状态 |
|---|---|---|---|---|
| T0 | 探针：transcript slug 派生 + 字段路径 | L1 | 读 jsonl 抽样 | ✅ |
| T1 | `scripts/usage-report.js` 主脚本 | L2 | 新文件 +147 LOC | ✅ |
| T2 | `scripts/lib/usage-aggregator.js` 聚合引擎 | L2 | 新文件 +192 LOC | ✅ |
| T3 | Transcript reader（T2 内函数）| L2 | 同 T2 | ✅ |
| T4 | Observations reader（T2 内函数，含去重 + archive 兼容）| L2 | 同 T2 | ✅ |
| T5 | Markdown formatter（主表 + 摘要 + 数据局限段）| L1 | T1 内函数 | ✅ |
| T6 | `/review-learnings --usage` 集成 | L1 | `user-level/commands/review-learnings.md` | ✅ |
| T7 | 跨副本同步（propagate + pre-commit-check）| L2 | .codex + plugins | ✅ |
| T8 | 生成首份报告 + 落 plan 文档 | L1 | `docs/reports/command-usage-2026-05-13.md` + 本文件 | ✅ |

### 关键设计

**Transcript 精准过滤**：
```javascript
// 唯一精准条件
entry.type === 'user'
&& typeof entry.message.content === 'string'   // 排除 tool_result（array）
&& entry.message.content.includes('<command-name>')
```

**Codex 去重**：
```javascript
// 同秒同 skill = hook 重复触发
const dedupKey = `${skill}@${ts.slice(0, 19)}`; // YYYY-MM-DDTHH:MM:SS
```

**slug 派生**：
```javascript
cwd.toLowerCase().replace(/[\\/:]/g, '-').replace(/^-+/, '')
// C:\project\my\tech-persistence → c--project-my-tech-persistence
```

## 实施进度

### 变更日志

| 日期 | Task | 说明 |
|------|------|------|
| 2026-05-13 | T0 | 探针完成：确认 transcript content string vs array 区分、Codex Skill 字段路径、slug 派生 |
| 2026-05-13 | T2 | 聚合引擎首版（cwdToSlug 派生 bug → 修正：lowercase + `[\\/:]→-`）|
| 2026-05-13 | T4 | 发现 Codex hook 双触发噪音，加同秒同 skill 去重 |
| 2026-05-13 | T1+T5 | 主脚本三模式 + Markdown formatter |
| 2026-05-13 | T6 | review-learnings 加 `--usage` flag 文档 |
| 2026-05-13 | T7 | propagate 4 副本（命令 + skill 各 2）+ pre-commit-check 通过 |
| 2026-05-13 | T8 | 首份报告生成：30d 活跃 2/21（/sprint=6, /compound=2），累计零调用 19 |

### 首份报告关键发现

- **/sprint = 6 次**（CC 5 + Codex 1，去重后）— 5 月以来主力命令
- **/compound = 2 次**（仅 CC）— 5 月以来唯一其他主动调用
- **19/21 累计零调用** — 不是没用过，而是**用户大多通过对话式触发**（"实现 X"）而非显式命令式触发（`/sprint 实现 X`）
- 这一发现修正了 `2026-05-12-gstack-latest-analysis.md` Task 7 的隐含假设（"低 docs 提及 = 应清理"），证实"docs proxy 与真实使用脱钩"

## 涉及文件

新增：
- `scripts/lib/usage-aggregator.js` 192 LOC
- `scripts/usage-report.js` 147 LOC
- `docs/reports/command-usage-2026-05-13.md`（首份报告）
- `docs/plans/2026-05-13-command-usage-report.md`（本文件）

修改：
- `user-level/commands/review-learnings.md`（+11 行 --usage 段）

副本同步（propagate）：
- `.codex/commands/review-learnings.md`
- `.codex/skills/review-learnings/SKILL.md`
- `plugins/tech-persistence/commands/review-learnings.md`
- `plugins/tech-persistence/skills/review-learnings/SKILL.md`

## 数据局限（必读）

报告本身明示 4 条限制，复制于此供决策时回顾：

1. transcript 仅覆盖当前 cwd 对应 session；subagent 内调用不计
2. Codex observations 覆盖度受 hook 安装时间限制
3. Codex 同秒同 skill 已去重
4. **仅捕获用户显式输入 `/xxx`，对话式触发（"实现 X"）不计** ← 解释 19/21 零调用

## 后续

- **每月生成一份报告**（手动 `node scripts/usage-report.js`），文件名带日期不覆盖，可作 delta 对比基线
- 未来若用户希望也统计**对话式触发**，需另写 NLP-light 分析器（不在本 sprint 范围）
- 30 天后（2026-06-13）跑一次对比，看哪些命令在那个窗口新增使用
