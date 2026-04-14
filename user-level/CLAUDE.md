# 个人开发偏好 & 自进化工程系统

## 关于我
- 主要语言：[填写你的技术栈]
- 沟通风格：直接、带代码示例、中文优先
- 开发理念：TDD、YAGNI、DRY

## 编码偏好
- 错误处理：显式 try-catch，携带有意义的错误消息和上下文
- 注释：解释 WHY 而非 WHAT，代码应自文档化
- 命名：变量名要有业务语义，不用缩写
- 提交信息用 Conventional Commits 格式

---

## 工程方法论：Plan → Work → Review → Compound

80% 规划+审查 / 20% 执行。核心流程：
```
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

节奏：大任务 `/sprint` | 中任务 `/plan→/review→/compound` | 小任务 直接做→`/compound` | 修 bug `/debug-journal→/compound`

---

## 需求输入路由

当用户上传了图片，**不要直接写代码**，先判断：
- 原型/设计截图 → 执行 `/prototype` 进入多轮需求收敛
- Bug 截图 → 正常调试流程
- 参考图/说明图 → 作为上下文理解

---

## 自学习规则

### 自动触发（不可跳过）
1. 解决了非平凡 bug（3+ 轮）→ `/debug-journal`
2. 用户纠正了 Claude → 立即记录为本能
3. 做出架构/技术决策 → 记录到 `rules/architecture.md`
4. 会话即将结束 → `/compound`

### 建议触发
5. 发现非直觉行为 / 性能发现 / 重复工具序列 → 提示 `/compound`

### 永远先 /compound 再 /compact

提示格式：
```
🧠 会话收尾：
  ✅ 已 compound：N 条经验 + M 个本能 + K 个 skill 信号
⚠️ 建议 /compact — [原因]
```

---

## 上下文管理规则

满足以下任一条件时提示 `/compact`：
1. 任务边界：完整功能任务刚完成
2. 高消耗累积：5+ 个包含 3 次以上工具调用的轮次
3. 退化信号：忘记约定、重复提问、工具参数出错
4. 探索型结束：大量文件浏览、上下文分析结束

---

## 系统说明

- 4 Hook 自动观察（SessionStart/PreToolUse/PostToolUse/Stop）
- 本能系统：观察→本能(0.3-0.9)→进化→永久知识
- Skill 自迭代：使用信号→诊断→改进提案→eval 验证→发布
- `/instinct-status` 查看本能 | `/evolve` 进化 | `/skill-diagnose` 诊断 skill

## 技术沉淀（通用经验）
<!-- 由 /compound 和自学习系统自动追加 -->

### 调试经验

### 性能经验

### 架构经验

### 工具链经验

### 解决方案索引
<!-- 由 /compound 写入 -->
