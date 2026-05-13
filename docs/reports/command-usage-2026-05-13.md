# 命令使用频率报告 (2026-05-13)

> 生成时间: 2026-05-13T02:52:48.145Z
> 工作目录: `C:\project\my\tech-persistence`
> 滚动窗口: 30 天（cutoff = 2026-04-13）

## 数据源

- Claude Code transcript: `C:\Users\songyu\.claude\projects\c--project-my-tech-persistence`
  - 15 个 session 文件
- Codex observations: 1 个项目目录
  - `8331ab9c2853`: `C:\Users\songyu\.claude\homunculus\projects\8331ab9c2853\observations.jsonl`

## 主表（22 个命令）

| 命令 | 30d CC | 30d Codex | 30d 合计 | 累计 CC | 累计 Codex | 累计合计 | 首次 | 末次 |
|---|---|---|---|---|---|---|---|---|
| /sprint | 6 | 1 | **7** | 6 | 1 | **7** | 2026-05-09 | 2026-05-13 |
| /compound | 2 | 0 | **2** | 2 | 0 | **2** | 2026-05-09 | 2026-05-12 |
| /agent-loop | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /checkpoint | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /evolve | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /instinct-export | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /instinct-import | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /instinct-status | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /learn | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /plan | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /prototype | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /review | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /review-learnings | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /session-summary | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /skill | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /skill-diagnose | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /skill-eval | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /skill-improve | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /skill-publish | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /test | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /think | 0 | 0 | **0** | 0 | 0 | **0** | — | — |
| /work | 0 | 0 | **0** | 0 | 0 | **0** | — | — |

## 分类摘要

### ✅ 30 天活跃（2）
/compound(2), /sprint(7)

### 🟡 累计极低（≤2 次，1）
/compound(2)

### 🔴 累计零调用（20）
/agent-loop, /checkpoint, /evolve, /instinct-export, /instinct-import, /instinct-status, /learn, /plan, /prototype, /review, /review-learnings, /session-summary, /skill, /skill-diagnose, /skill-eval, /skill-improve, /skill-publish, /test, /think, /work

## 数据局限

- **transcript 仅覆盖当前 cwd 对应的 Claude Code session**。其他 cwd（如另一项目目录或 subagent）触发的本项目命令不计入。
- **Codex observations 覆盖度受 hook 安装时间限制**。早于 hook 安装的调用不计入。
- **Codex 数据已去重**（同秒同 skill 视为 hook 双触发，记 1 次）。
- transcript 中 `<command-name>` 标签出现在 tool_result（message.content 为数组）中视为噪音，**仅 message.content 为字符串时计数**。

## 如何复跑

```bash
# 默认：写到 docs/reports/command-usage-YYYY-MM-DD.md
node scripts/usage-report.js

# 自定义窗口 60 天
node scripts/usage-report.js --window 60

# 实时查看（不写文件）
node scripts/usage-report.js --inline
```
