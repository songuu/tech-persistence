---
description: "基于 Hook 的持续自学习系统：观察会话 → 检测模式 → 生成本能 → 进化为知识"
version: "2.0"
---

# 持续自学习技能

融合 ECC Continuous Learning v2 的本能架构 + Codex-Mem 的语义观察压缩。

## 系统架构

```
会话活动
  ↓ PreToolUse / PostToolUse Hook (100% 触发)
观察日志 (observations.jsonl)
  ↓ Stop Hook 模式检测
本能 (instincts/*.md, 置信度 0.3-0.9)
  ↓ 验证/衰减/聚类
进化产物 (evolved/ skills/commands/agents)
  ↓ 人工确认
永久知识 (rules/ + CLAUDE.md)
```

## Hook 配置

系统使用 4 个 Hook 实现 100% 可靠的观察：

| Hook | 脚本 | 作用 |
|------|------|------|
| SessionStart | inject-context.js | 注入近期摘要 + 高置信本能 |
| PreToolUse | observe.js pre | 记录即将执行的工具 |
| PostToolUse | observe.js post | 捕获工具结果 |
| Stop | evaluate-session.js | 模式检测 + 本能创建 + 摘要 |

## 本能 (Instinct) 生命周期

### 1. 创建
当检测到以下模式时自动创建，初始置信度 0.3：
- 用户纠正了 Codex 的行为
- 解决了一个错误（特别是花时间的）
- 某个工具/工作流被反复使用
- 做出了明确的技术偏好选择

### 2. 增强
本能被再次观察到时，置信度 +0.1（上限 0.95）

### 3. 衰减
14 天未被观察到的本能，置信度 -0.05/14天

### 4. 应用
| 置信度 | 行为 |
|--------|------|
| >= 0.7 | SessionStart 时自动注入，无需手动触发 |
| 0.5-0.69 | 相关场景出现时建议 |
| 0.3-0.49 | 仅在被问到时提及 |
| < 0.3 | 候选删除 |

### 5. 进化
3+ 个同域本能 → 可通过 /evolve 聚类为 skill/command/agent

### 6. 毕业
进化产物经人工审核后 → 写入 .codex/rules/ 成为永久知识

## 项目隔离

系统自动检测项目身份（优先级）：
1. `CLAUDE_PROJECT_DIR` 环境变量
2. `git remote get-url origin` → SHA256 hash 前 12 位
3. `git rev-parse --show-toplevel` → 路径 hash
4. 当前工作目录 hash（兜底）

同一 git 仓库在不同机器上会得到相同的项目 ID（使用 remote URL hash）。

## 目录结构

```
~/.codex/homunculus/
├── projects.json                  # 项目注册表
├── instincts/
│   ├── personal/                  # 全局本能
│   │   └── always-validate-input.md
│   └── inherited/                 # 导入的本能
│       └── team-coding-standards.md
├── evolved/                       # 全局进化产物
│   ├── skills/
│   ├── commands/
│   └── agents/
└── projects/
    └── {project-hash}/
        ├── observations.jsonl     # 原始观察日志
        ├── observations.archive/  # 归档的旧观察
        ├── instincts/             # 项目本能
        │   └── prefer-vitest.md
        ├── sessions/              # 会话摘要
        │   └── 2025-06-15-xxx.md
        └── evolved/               # 项目进化产物
            ├── skills/
            ├── commands/
            └── agents/
```

## 配置项

在 `~/.codex/homunculus/config.json` 中可调整：

```json
{
  "observation": {
    "enabled": true,
    "max_file_size_mb": 10,
    "archive_after_days": 7
  },
  "instincts": {
    "min_confidence": 0.3,
    "auto_approve_threshold": 0.7,
    "confidence_decay_rate": 0.05,
    "confidence_boost": 0.1
  },
  "context_injection": {
    "max_sessions": 3,
    "max_instincts_project": 10,
    "max_instincts_global": 5,
    "min_confidence_inject": 0.5
  },
  "evolution": {
    "cluster_threshold": 3
  }
}
```
