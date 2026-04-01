# 速查手册 v2 — 自学习增强版

## 命令速查

| 命令 | 作用 | 何时使用 |
|------|------|---------|
| `/learn` | 提取经验 + 创建本能 | 会话有收获时 |
| `/session-summary` | 完整会话报告 + 自动 /learn | 结束长会话前 |
| `/debug-journal` | 记录调试过程 + 调试本能 | 解决棘手 bug 后 |
| `/retrospective` | 全层回顾 + 本能审计 | 每个迭代结束 |
| `/review-learnings` | 跨层搜索统计 | 每周一次 |
| `/instinct-status` | 本能面板（置信度/域） | 随时查看 |
| `/evolve` | 本能聚类 → skill/command | 本能积累到 50+ 时 |
| `/instinct-export` | 导出本能给团队 | 分享经验时 |
| `/instinct-import` | 导入他人本能 | 接收经验时 |

## 自动化工作流（零手动操作）

```
SessionStart Hook
  ↓ 注入近期会话摘要 + 高置信本能
  
正常开发……

PreToolUse Hook ←→ PostToolUse Hook
  ↓ 每次工具调用自动记录到 observations.jsonl

Stop Hook
  ↓ 读取本次观察 → 检测模式 → 创建/更新本能
  ↓ 生成会话摘要 → 置信度衰减 → 健康检查
  ↓ 输出学习报告
```

## 知识层次

```
┌─ 核心层 ──── CLAUDE.md (< 200行, 最高频)
├─ 经验层 ──── .claude/rules/*.md (按领域分类, 成熟知识)
├─ 本能层 ──── homunculus/instincts/ (原子化, 有置信度, 会衰减)
├─ 进化层 ──── homunculus/evolved/ (本能聚类生成的 skill/command)
└─ 观察层 ──── observations.jsonl (原始数据, 定期归档)
```

## 本能置信度参考

| 置信度 | 图标 | 含义 | 系统行为 |
|--------|------|------|---------|
| 0.9+   | 🔵  | 核心 | 自动应用，视为规则 |
| 0.7+   | 🟢  | 强   | SessionStart 自动注入 |
| 0.5+   | 🟡  | 中等 | 相关时建议 |
| 0.3+   | 🟠  | 初步 | 被问到时提及 |
| <0.3   | 🔴  | 衰减 | 候选删除 |

## 知识生命周期

```
观察 → 本能(0.3) → 反复验证 → 本能(0.7+) → 聚类 → 进化产物 → 确认 → rules/
  ↑                                                                      ↓
  └──────────────── 衰减 ← 14天未见 ← 置信度-0.05 ────────────────────────┘
                                                              (矛盾时旧知识衰减)
```

## 目录结构

```
~/.claude/                              ← 用户级 (跟着你走)
├── CLAUDE.md                           ← 个人偏好
├── settings.json                       ← Hook 配置 (4 hooks)
├── commands/                           ← 全局命令 (9 个)
├── rules/general-standards.md          ← 通用标准
├── skills/
│   ├── memory/SKILL.md                 ← 记忆管理
│   └── continuous-learning/
│       ├── SKILL.md                    ← 自学习系统定义
│       └── hooks/                      ← Hook 脚本
│           ├── observe.js              ← Pre/Post ToolUse
│           ├── evaluate-session.js     ← Stop
│           └── inject-context.js       ← SessionStart
└── homunculus/                         ← 知识存储
    ├── config.json                     ← 系统配置
    ├── projects.json                   ← 项目注册表
    ├── instincts/personal/             ← 全局本能
    ├── instincts/inherited/            ← 导入的本能
    ├── evolved/{skills,commands,agents} ← 全局进化产物
    └── projects/{hash}/               ← 按项目隔离
        ├── observations.jsonl          ← 观察日志
        ├── instincts/                  ← 项目本能
        ├── sessions/                   ← 会话摘要
        └── evolved/                    ← 项目进化产物

your-project/                           ← 项目级 (提交到 Git)
├── CLAUDE.md                           ← 项目核心知识
└── .claude/
    ├── settings.json                   ← Hook 配置
    ├── commands/                       ← 项目命令
    │   ├── learn.md
    │   ├── retrospective.md
    │   └── debug-journal.md
    └── rules/                          ← 项目经验
        ├── architecture.md
        ├── debugging-gotchas.md
        ├── performance.md
        ├── testing-patterns.md
        └── api-conventions.md
```

## 常见操作

```bash
# 安装
bash install.sh --all

# 查看学习成果
# 在 Claude Code 中:
/instinct-status                # 本能面板
/review-learnings               # 全量知识统计
/review-learnings search 性能   # 搜索

# 手动提取
/learn                          # 当前会话
/debug-journal                  # 调试记录

# 维护
/retrospective                  # 全面回顾
/evolve                         # 本能进化

# 团队协作
/instinct-export                # 导出
/instinct-import file.md        # 导入

# 查看原始数据
cat ~/.claude/homunculus/projects.json            # 项目列表
ls ~/.claude/homunculus/projects/*/instincts/     # 项目本能
tail -20 ~/.claude/homunculus/projects/*/observations.jsonl  # 最近观察
```
