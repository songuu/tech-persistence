# 自动审查模式（auto-mode）协议

> 所有工作流命令支持 `--auto` 可选参数。本规则定义模型在收到该参数后，如何在每一个本应人工 gate 的环节自主判断是否仍需用户确认。

## 触发方式

| 入口 | 写法 |
|------|------|
| Claude Code 命令 | `/sprint --auto <参数>` / `/work --auto` / `/review --auto` 等 |
| Codex skill | `$sprint --auto <参数>` / `$work --auto` 等 |
| Orchestrator CLI | `node scripts/agent-orchestrator.js run --requirement "..." --auto` |
| 用户口语触发 | "自动跑完"、"不用问我"、"yolo"、"auto mode"、"auto-confirm" |

任意一种触发后，本会话内当前命令的剩余阶段全部进入 auto-mode；不传染到下一条独立命令。除非用户说"continue auto"。

## 决策矩阵

每个 gate 的判定按以下顺序：

### 1. 强制人工（无视 --auto）

下列情况**永远必须问用户**：

- destructive 不可逆：`rm -rf`、`git reset --hard`、`git push --force`、`DROP TABLE`、`DELETE FROM` 不带 WHERE、迁移降级、删除分支、删除 worktree
- 跨用户副作用：发起 PR、合并 PR、推送远端、发送 Slack/邮件、调用付费 API、改 CI/CD、改基础设施
- 写入会话外的共享状态：覆盖他人项目、改全局 `~/.claude/settings.json`、改 `~/.codex/config`
- 安全相关：硬编码 secret、关闭安全检查、`--no-verify`、绕过签名
- 风险等级 L4（支付/认证/数据）
- 计划范围与原始请求明显不符（scope creep）
- 测试失败或验证未通过的情况下进入下一阶段

遇到上述任一项：**打印一行说明为何强制人工**，然后等待用户确认。

### 2. 自动通过（启用 --auto 后默认通过）

满足下列**全部**条件时，无需问用户，直接继续：

- 风险等级 L0/L1/L2
- 模型对当前步骤的正确性置信度 ≥ 0.8
- 改动范围 ≤ 计划列出的文件清单
- 当前会话内类似动作连续被用户 'go' 通过 ≥ 2 次（行为信号）
- 测试/验证已通过（或当前阶段无验证项）

### 3. 灰区智能判断（介于 1 和 2 之间）

若不在强制区也不全部满足自动区：

- 风险等级 L3：默认仍问用户，除非置信度 ≥ 0.9 且改动范围明显窄
- 用户最近一次显式纠正过模型 → 此次仍问用户
- 模型不确定 root cause → 必须问
- 涉及 CLAUDE.md / AGENTS.md / 全局规则修改 → 必须问

## 行为约定

进入 auto-mode 后：

1. **每跳过一个 gate 都打印一行**，格式：

   ```text
   ✓ auto: [阶段名] — [简要决策依据，例如 risk=L1, scope=2 files, prior gates auto-passed=2]
   ```

2. **每被强制保留一个 gate 都打印一行**，格式：

   ```text
   ⚠ manual gate kept: [阶段名] — [触发的强制条件]
   ```

3. **总结报告必须列出**：

   - 自动通过了几个 gate
   - 强制保留了几个 gate
   - 触发任何强制条件的具体原因

4. **遇到第一个强制 gate 后**：等待用户确认；用户回复 'go' 后**仅当前 gate** 通过，下一 gate 重新评估，不自动放行所有后续 gate。

5. **遇到错误/异常**：立即退出 auto-mode，恢复人工模式并报告错误。

## 与 caveman-mode 的关系

caveman 控制**输出风格**（压缩 token）。auto-mode 控制**决策行为**（跳过 gate）。两者正交，可同时启用：

```text
/sprint --auto --caveman <需求>
```

输出仍按 caveman 规则压缩，决策仍按 auto-mode 协议运行。

## 与各命令的具体集成

| 命令 | 主要 gate | --auto 行为 |
|------|-----------|-------------|
| `/sprint` | Phase 1-4 之间的 'go' | 按风险/置信度/scope 自动跳；P0 仍问 |
| `/agent-loop` | spec freeze | 仅当 spec 无 questions、无 assumptions 阻塞、所有 required 字段齐全时自动 freeze；否则强制人工 |
| `/work` | 每个 Task 完成的进入下一步 | L0-L2 自动；L3 视情况；L4 强制问 |
| `/plan` | 计划终审 | 任务数 ≤ 8 且无高风险 task 时自动；否则问 |
| `/review` | P0 修复确认 | obvious 修复（typo、缺 import、null check）自动；语义级修复问 |
| `/think` | 范围确认 | scope 明确时自动进入 plan；含开放问题时问 |
| `/test` | 测试范围 | L0-L2 自动；L3+ 当 diff 包含密码/迁移/认证时强制问 |
| `/prototype` | 假设确认 | 永远问。原型驱动需求收敛本身就要求人工纠偏 |
| `/compound` / `/learn` / `/debug-journal` | 几乎无 gate | --auto 是 no-op |
| `/checkpoint` | 写交接文件 | 永远自动 |
| `/instinct-*` / `/skill-*` / `/review-learnings` / `/session-summary` | 读为主 | --auto 是 no-op |
| `/evolve` | 本能聚类落地 | 高置信度自动；低置信度问 |

## 默认值

不传 `--auto` 时：保持当前的人工 gate 行为，零变化。
