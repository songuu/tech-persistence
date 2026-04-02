# v3 速查 — Compound + gstack + 自学习融合

## 命令总览（15 个）

### 工作流层（v3 新增，来自 gstack + Compound）
| 命令 | 角色 | 作用 |
|------|------|------|
| `/think` | CEO | 需求审视、范围锁定、验收条件 |
| `/plan` | 架构师 | 技术方案、任务拆解、风险评估 |
| `/work` | 工程师 | 按计划逐步实现、每步测试 |
| `/review` | 审查团队 | 5 视角审查：安全/性能/架构/质量/测试 |
| `/compound` | 知识管理 | 提取经验+本能+解决方案（/learn 超集）|
| `/sprint` | 指挥官 | 串联 think→plan→work→review→compound |

### 知识层（v2 保留）
| 命令 | 作用 |
|------|------|
| `/learn` | 轻量经验提取（/compound 的子集）|
| `/debug-journal` | 记录调试过程 |
| `/session-summary` | 会话总结报告 |
| `/instinct-status` | 本能面板 |
| `/evolve` | 本能聚类进化 |
| `/instinct-export` | 导出本能 |
| `/instinct-import` | 导入本能 |
| `/review-learnings` | 全量知识回顾 |
| `/retrospective` | 阶段性审查 |

## 日常使用速查

```
大功能开发:
  /sprint '实现用户导出功能'
  → 自动 think → plan(确认) → work → review(确认) → compound

中等任务:
  /plan '添加分页到列表接口'
  → 确认计划 → 开发 → /review → /compound

修 bug:
  直接修 → /debug-journal → /compound

小改动:
  直接改 → /compound (或 /learn)

探索调研:
  自由对话 → /learn
```

## 数据流

```
/think  → .claude/plans/think-*.md
           ↓ 读取
/plan   → .claude/plans/plan-*.md
           ↓ 读取
/work   → git diff (代码变更)
           ↓ 读取
/review → 审查报告 (P0/P1/P2)
           ↓ 读取
/compound → docs/solutions/*.md     (解决方案文档)
            .claude/rules/*.md       (成熟经验)
            homunculus/instincts/    (原子本能)
            CLAUDE.md 索引           (高频入口)
                     ↓
           下次 /plan 自动读取所有上述内容
           = 复利效应
```

## 80/20 原则

- 80% 时间花在 /think + /plan + /review + /compound
- 20% 时间花在 /work
- 写代码是最不重要的部分，规划和学习才是核心
