# 实际使用演示

> 以下展示安装后的完整使用体验，从零到知识积累的全过程。

## 第 1 天：安装

```bash
$ cd ~/projects/my-app
$ node /path/to/tech-persistence-v2/scripts/preflight.js

🔍 技术沉淀系统 v2 — 环境检查

运行环境:
  ✅ Node.js >= 18
  ✅ Git 可用
  ✅ Claude Code CLI 可用

目录权限:
  ✅ ~/.claude 目录可写

现有配置:
  ✅ ~/.claude/CLAUDE.md — 不存在 — 将新建
  ✅ ~/.claude/settings.json — 不存在 — 将新建

──────────────────────────────────────────────
✅ 环境检查通过，可以安装: bash install.sh --all

$ bash /path/to/tech-persistence-v2/install.sh --all

━━━ 安装用户级别配置 → ~/.claude/ ━━━
✅ ~/.claude/CLAUDE.md
✅ 命令 /learn
✅ 命令 /review-learnings
✅ 命令 /session-summary
✅ 命令 /instinct-status
✅ 命令 /evolve
✅ 命令 /instinct-export
✅ 命令 /instinct-import
✅ 技能 memory + continuous-learning
✅ observe.js → PreToolUse/PostToolUse 观察捕获
✅ evaluate-session.js → Stop 会话评估 + 本能提取
✅ inject-context.js → SessionStart 上下文注入
✅ Homunculus 目录结构就绪
✅ settings.json (含 4 Hook 配置)

✅ 用户级别安装完成！

━━━ 安装项目级别配置 → .claude/ ━━━
✅ 检测到 Git 仓库
✅ CLAUDE.md
✅ .claude/settings.json (含 4 Hook 配置)
✅ 命令 /learn
✅ 命令 /retrospective
✅ 命令 /debug-journal
✅ 规则模板 (5 个领域)

✅ 项目级别安装完成！
```

## 第 1 天：编辑 CLAUDE.md

```
$ claude

> 帮我初始化 CLAUDE.md，这是一个 Next.js 14 + Prisma + PostgreSQL 的电商项目
```

Claude 会分析项目结构并填充 CLAUDE.md。

## 第 2 天：正常开发

你正常使用 Claude Code 开发功能。后台自动发生：

```
[SessionStart Hook] 注入上下文:
  (暂无历史数据，首次使用)

[PreToolUse Hook] 记录: Read src/app/api/products/route.ts
[PostToolUse Hook] 捕获: 读取了 products API 路由代码
[PreToolUse Hook] 记录: Edit src/app/api/products/route.ts
[PostToolUse Hook] 捕获: 修改了 products API
[PreToolUse Hook] 记录: Bash pnpm test
[PostToolUse Hook] 捕获: 3 tests passed
... (每次工具调用都在记录)

[Stop Hook] 会话结束：
📊 会话自学习报告 [my-app]
   观察: 47 | 模式: 2 | 本能: +2 ↑0
   本能变更:
     🆕 repeated-workflow-1pq3r (置信度 0.3)
     🆕 error-resolution-2ab4s (置信度 0.3)

   💡 运行 /learn 手动提取深度经验 | /instinct-status 查看所有本能
```

## 第 2 天：手动提取深度经验

```
> /learn

📝 本次会话提取完成

经验提取：
| # | 经验摘要 | 级别 | 写入位置 |
|---|---------|------|---------|
| 1 | Prisma 的 include 嵌套超 3 层会 N+1 | HIGH | .claude/rules/performance.md |
| 2 | Next.js 14 的 route handler 不支持 middleware | MEDIUM | .claude/rules/debugging-gotchas.md |

本能更新：
| # | 本能 ID | 域 | 置信度 | 状态 |
|---|---------|-----|--------|------|
| 1 | prefer-select-over-include | performance | 0.5 | 🆕 新建 |
| 2 | check-prisma-query-count | debugging | 0.5 | 🆕 新建 |

✅ 经验: 写入 2 条, 跳过 0 条重复
🧠 本能: 新建 2 个, 更新 0 个
```

## 第 5 天：调试了一个棘手 bug

```
> /debug-journal

🐛 调试日志已记录

经验: → .claude/rules/debugging-gotchas.md (HIGH)
  [2025-06] [Prisma] 事务中使用 $queryRaw 不会回滚
  - 现象：事务失败但部分数据已写入
  - 误导方向：以为是并发问题
  - 根因：$queryRaw 绕过了 Prisma 的事务管理
  - 解决：改用 $executeRaw 或在事务外处理

本能: 🆕 fix-prisma-raw-in-transaction (debugging, 0.7)
      (CRITICAL bug，初始置信度直接 0.7)

陷阱: → CLAUDE.md (已追加到"已知陷阱")
```

## 第 10 天：新会话自动注入上下文

```
[SessionStart Hook] 注入:

<learned-context project="my-app">

## 近期会话 (my-app)
## 会话 2025-06-18 14:30
- 观察数: 52
- 主要工具: Edit(18), Read(15), Bash(12)
- 检测模式: 3 个
---
## 会话 2025-06-16 10:15
- 观察数: 38
...

## 项目本能 (已学习的行为模式)
- 🟢 [0.7] [debugging] 事务中不要用 $queryRaw
- 🟡 [0.6] [performance] 优先用 select 而非 include
- 🟡 [0.5] [testing] 测试前先跑 prisma migrate
- 🟠 [0.4] [code-style] API 响应统一用 NextResponse.json

## 全局本能 (跨项目通用)
- 🟢 [0.8] [git] 提交前先 diff 确认变更范围

</learned-context>
```

Claude 现在自动知道你的项目经验！

## 第 15 天：查看本能状态

```
> /instinct-status

🧠 本能状态面板 — 项目: my-app

📂 项目本能 (8 个)
| # | 图标 | 置信度 | 域 | 触发条件 | 最后见到 |
|----|------|--------|-----|---------|---------|
| 1  | 🟢  | 0.80  | debugging | 事务中不用 $queryRaw | 1 天前 |
| 2  | 🟢  | 0.70  | performance | 优先 select 不用 include | 3 天前 |
| 3  | 🟡  | 0.60  | testing | 测试前 prisma migrate | 2 天前 |
| 4  | 🟡  | 0.55  | code-style | NextResponse.json 统一格式 | 5 天前 |
| 5  | 🟡  | 0.50  | api-design | 分页用 cursor 不用 offset | 4 天前 |
| 6  | 🟠  | 0.40  | workflow | 改 schema 后先 generate 再测试 | 7 天前 |
| 7  | 🟠  | 0.35  | code-style | 错误信息包含 field 名 | 8 天前 |
| 8  | 🟠  | 0.30  | toolchain | 用 --force-empty 解决 seed 冲突 | 12 天前 |

🌍 全局本能 (3 个)
| # | 图标 | 置信度 | 域 | 触发条件 |
|----|------|--------|-----|---------|
| 1  | 🟢  | 0.85  | git | 提交前 diff 确认 |
| 2  | 🟢  | 0.75  | code-style | const 优先于 let |
| 3  | 🟡  | 0.60  | debugging | ESM 中用 import.meta.url |

📊 统计
  总计: 11 个本能
  核心(0.9+): 0 | 强(0.7+): 3 | 中等(0.5+): 4 | 初步(<0.5): 4
  💡 3 个 debugging 域本能可聚类，建议 /evolve
```

## 第 20 天：进化本能

```
> /evolve

🧬 本能进化分析

发现 1 个可进化的聚类:

聚类 1: "Prisma 调试经验" (3 个本能, 平均置信度 0.70)
  来源:
    - fix-prisma-raw-in-transaction (0.80)
    - prefer-select-over-include (0.70)
    - check-prisma-query-count (0.60)
  建议: → 进化为 Rule (写入 .claude/rules/debugging-gotchas.md)

是否执行进化? 输入 '1' 确认

> 1

✅ 已将 3 个 Prisma 调试本能合并写入 .claude/rules/debugging-gotchas.md
   源本能已标记 evolved_into

💡 运行 git diff .claude/rules/debugging-gotchas.md 查看变更
```

## 第 30 天：阶段性回顾

```
> /retrospective

📋 沉淀健康报告

文件统计:
  CLAUDE.md: 85 行 ✅
  .claude/rules/architecture.md: 35 行 / 2 条
  .claude/rules/debugging-gotchas.md: 68 行 / 8 条
  .claude/rules/performance.md: 42 行 / 3 条
  .claude/rules/testing-patterns.md: 28 行 / 2 条
  .claude/rules/api-conventions.md: 22 行 / 1 条

🧠 本能审计
  总计: 11 个本能
  🔴 衰减(<0.2): 1 个 — toolchain/force-empty (30天未见)
  ⚠️ 3 个本能已进化写入 rules，可清理源本能

📌 建议行动:
  HIGH:
  - [ ] 清理 1 个衰减本能
  MEDIUM:
  - [ ] 清理 3 个已进化的源本能
  - [ ] 归档旧观察日志 (4.2MB)
  LOW:
  - [ ] 补充 security 领域经验

执行哪些? (输入 'all-high')
```

## 持续效果

经过 30 天使用后：
- **新会话启动**：Claude 自动带着你过去 30 天的经验
- **踩过的坑**：写在 rules 里，不会再踩第二次
- **编码习惯**：本能系统记住了你的偏好，自动遵守
- **团队共享**：`.claude/rules/` 提交到 Git，新成员立即受益
- **知识进化**：零散的本能自动聚合为系统化的技能
