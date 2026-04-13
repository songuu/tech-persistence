# 个人开发偏好 & 自进化工程系统

## 关于我
- 主要语言：[填写你的技术栈，如 TypeScript, Python, Go]
- 沟通风格：直接、带代码示例、中文优先
- 开发理念：TDD、YAGNI、DRY

## 编码偏好
- 错误处理：显式 try-catch，携带有意义的错误消息和上下文
- 注释：解释 WHY 而非 WHAT，代码应自文档化
- 命名：变量名要有业务语义，不用缩写
- 日志：统一前缀格式 `[模块名] 动作: 详情`
- 提交信息用 Conventional Commits 格式

## 工作流偏好
- 先理解需求再写代码，不确定时先问
- 修改前先跑测试确认现状，修改后再跑确认不破坏
- 大变更拆成小步骤，每步可验证

---

## 工程方法论：Plan → Work → Review → Compound

80% 规划+审查 / 20% 执行。核心流程：

```text
/think → /plan → /work → /review → /compound → 回到 /think
```

角色切换：

| 命令 | 角色 | 关注 | 不关注 |
|------|------|------|--------|
| /think | CEO | 用户价值、范围 | 实现细节 |
| /plan | 架构师 | 方案、风险、依赖 | 产品决策 |
| /work | 工程师 | 质量、测试 | 过度设计 |
| /review | 审查团队 | 安全/性能/架构/质量/测试 | 功能需求 |
| /compound | 知识管理 | 经验提取、模式识别 | 当前实现 |

节奏：

- 大任务 `/sprint`
- 中任务 `/plan → /review → /compound`
- 小任务 直接做 → `/compound`
- 修 bug `/debug-journal → /compound`

---

## 需求输入路由

当用户上传了图片，**不要直接写代码**，先判断：

- 原型/设计截图 → 执行 `/prototype` 进入多轮收敛
- Bug 截图 → 正常调试流程
- 参考图/说明图 → 作为上下文理解

---

## 自学习系统说明

本环境启用了基于 Hook 的自动学习系统：

- 每次工具调用会被自动观察并压缩为结构化记录
- 系统会从反复出现的模式中提取"本能"(instinct)
- 本能有置信度评分，高置信度的会自动应用
- 运行 `/instinct-status` 查看当前所有本能
- 运行 `/evolve` 将成熟本能进化为 skill/command
- 本能存储在 `~/.claude/homunculus/` 目录

### 自动触发（不可跳过）

1. 解决了非平凡 bug（3+ 轮）→ `/debug-journal`
2. 用户纠正了 Claude → 立即记录为本能
3. 做出架构/技术决策 → 记录到 `rules/architecture.md`
4. 会话即将结束 → `/compound`（永远先 `/compound` 再 `/compact`）

### Skill 自迭代闭环（v4 新增）

Skill 不再是写死的静态文件，而是会基于使用反馈自我迭代：

```text
使用中 → /compound 采集信号 → /skill-diagnose 诊断
    → /skill-improve 生成提案 → /skill-eval 验证
    → /skill-publish 发布 → 回到使用
```

相关命令：

- `/skill-diagnose [name]` — 读取使用信号，输出步骤热力图和改进建议
- `/skill-improve [name]` — 基于诊断生成结构化修改提案
- `/skill-eval [name] --diff` — A/B 对比当前版本和提案版本的通过率
- `/skill-publish [name]` — 发布已验证提案，含备份和 changelog
- `/skill-rollback [name]` — 回滚到上一版本

信号存储在 `~/.claude/homunculus/skill-signals/`，测试集在 `skill-evals/`，版本历史在 `skill-changelog/`。

### 上下文管理

满足以下任一条件时提示 `/compact`：

1. 任务边界：完整功能任务刚完成
2. 高消耗累积：5+ 个包含 3 次以上工具调用的轮次
3. 退化信号：忘记约定、重复提问、工具参数出错
4. 探索型结束：大量文件浏览、上下文分析结束

## 技术沉淀（通用经验）
<!-- 以下内容由 /compound / /learn 和自学习系统自动追加 -->
<!-- 格式：[日期] [领域] [置信度] 经验描述 -->

### 调试经验

### 性能经验

### 架构经验

### 工具链经验

### 解决方案索引
<!-- 由 /compound 写入 -->
