# Claude Code 技术沉淀系统 v2 — 自学习增强版

> 融合 ECC Continuous Learning v2 的本能系统 + Claude-Mem 的语义观察压缩，
> 打造一套零手动干预、自动积累、智能进化的技术经验管理系统。

## 与 v1 的区别

| 能力 | v1 | v2 (本版本) |
|------|-----|-------------|
| 经验提取 | 手动 `/learn` | 自动 Hook 观察 + 手动 `/learn` |
| 观察可靠性 | 依赖 skill 触发 (~50-80%) | Hook 100% 确定性触发 |
| 知识粒度 | 整条经验 | 原子化"本能" (instinct) |
| 质量评估 | 人工判断 | 置信度评分 0.3-0.9 自动衰减 |
| 上下文注入 | 手动读 CLAUDE.md | SessionStart 自动注入近期上下文 |
| 知识进化 | 静态文件 | 本能 → 聚类 → 自动生成 skill/command/agent |
| 观察存储 | 纯 Markdown | JSONL 结构化 + Markdown 人类可读 |
| 项目隔离 | 手动区分 | 自动按 git remote hash 隔离 |

## 架构总览

```
┌──────────────────────────────────────────────────────┐
│               Claude Code 会话                        │
│  SessionStart → UserPromptSubmit → ToolUse → Stop    │
│       ↓              ↓               ↓        ↓      │
│   [注入上下文]   [记录提示]    [观察工具]  [评估会话] │
└──────────────────────────────────────────────────────┘
         ↓                              ↓
┌────────────────────┐  ┌─────────────────────────────┐
│  上下文注入层       │  │  观察 & 学习层               │
│                    │  │                             │
│  读取近期会话摘要   │  │  1. 捕获工具输入/输出        │
│  读取高置信本能     │  │  2. 压缩为结构化观察         │
│  读取 CLAUDE.md    │  │  3. 检测模式 (纠正/重复/错误) │
│  读取 rules/       │  │  4. 生成/更新原子本能         │
└────────────────────┘  └─────────────────────────────┘
                                    ↓
                        ┌───────────────────────┐
                        │  知识存储层            │
                        │                       │
                        │  observations.jsonl    │ ← 原始观察
                        │  instincts/personal/   │ ← 原子本能
                        │  instincts/inherited/  │ ← 导入的本能
                        │  .claude/rules/        │ ← 成熟经验
                        │  CLAUDE.md             │ ← 核心知识
                        └───────────────────────┘
                                    ↓
                        ┌───────────────────────┐
                        │  进化层                │
                        │                       │
                        │  本能聚类 → skill      │
                        │  本能聚类 → command    │
                        │  本能聚类 → agent      │
                        └───────────────────────┘
```

## 快速安装

```bash
# 解压后进入目录
cd tech-persistence-v2

# 安装用户级别 (全局，跨所有项目)
bash install.sh --user

# 在项目中安装项目级别
cd /path/to/your/project
bash /path/to/tech-persistence-v2/install.sh --project

# 同时安装
bash install.sh --all
```

## 核心命令

| 命令 | 作用 |
|------|------|
| `/learn` | 从当前会话提取经验 (手动触发) |
| `/session-summary` | 生成完整会话报告 + 自动提取 |
| `/debug-journal` | 记录调试全过程 |
| `/retrospective` | 阶段性回顾 + 裁剪过时内容 |
| `/review-learnings` | 搜索、统计、导出所有沉淀 |
| `/instinct-status` | 查看本能列表 + 置信度 |
| `/evolve` | 将高置信本能聚类进化为 skill/command |
| `/instinct-export` | 导出本能 (分享给团队) |
| `/instinct-import` | 导入他人的本能 |

## 自动化工作流 (无需手动操作)

1. **PreToolUse Hook** → 记录即将执行的工具调用
2. **PostToolUse Hook** → 捕获工具结果，压缩为结构化观察
3. **Stop Hook** → 会话结束时评估，提取本能，更新置信度
4. **SessionStart Hook** → 下次会话自动注入相关上下文

## 知识生命周期

```
原始观察 (observations.jsonl)
    ↓ 模式检测
原子本能 (instincts/ , 置信度 0.3)
    ↓ 反复验证，置信度上升
成熟本能 (置信度 0.7+)
    ↓ 聚类相关本能
进化产物 (evolved/ skills/commands/agents)
    ↓ 人工审核确认
写入 rules/ 或 CLAUDE.md (永久知识)
```
