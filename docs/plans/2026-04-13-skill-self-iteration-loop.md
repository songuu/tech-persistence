# Skill 自迭代闭环 (v4 集成)

> **Status:** `completed`
> **Created:** 2026-04-13
> **Updated:** 2026-04-13

---

## 需求分析

### 问题陈述

当前系统的知识进化路径是单向的：

```text
观察 → 本能 → /evolve → skill（静态）
```

Skill 一旦写好就是死的——`/prototype`、`/review`、`/compound` 这些命令的逻辑永远是安装时的样子。真正的自进化系统需要 **skill 本身也有生命周期**：每次使用产生信号 → 信号积累到阈值后触发自我修改 → 用 eval 验证是否真的变好。

### 要做

- 在 `/compound` 中嵌入第七步「skill 使用信号采集」和第八步「本能-skill 差异标记」
- 新增 4 个 skill 生命周期命令：`/skill-diagnose`、`/skill-improve`、`/skill-eval`、`/skill-publish`（及配套的 `/skill-rollback`）
- 新增 `/prototype` 工作流命令 + `prototype-workflow` skill（多轮需求收敛）
- 为 skill 自迭代准备存储：`~/.claude/homunculus/skill-signals/ skill-evals/ skill-changelog/`
- 安装/升级脚本能部署以上所有内容
- README / CLAUDE.md 同步更新

### 不做

- 不在本轮做 `/compound` 自动执行 `/skill-diagnose` 的联动（等真实数据积累后再定阈值）
- 不实现 eval 测试集的自动生成逻辑（在第一次 `/skill-eval` 被用到时再做）
- 不改动 4 个 Hook 脚本（信号采集完全走 `/compound` 这条路径，不需要新 Hook）

### 成功标准

- [x] 全部 v4 命令文件落位到 `user-level/commands/` 和 `user-commands/`
- [x] `prototype-workflow` skill 落位到 `user-level/skills/`
- [x] 三个 `skill-*` 子目录落位到 `user-level/homunculus/`
- [x] `install.sh` / `install.ps1` 能部署新命令和目录
- [x] `update.sh` / `update.ps1` 含 `upgrade_to_v4` 函数，`LATEST_VERSION=v4`
- [x] `user-commands/compound.md` 含第七/八步
- [x] `user-level/commands/learn.md` 更新为轻量版
- [x] `README.md` 的命令速查表和目录结构同步
- [x] 本计划文档归档到 `docs/plans/`

### 风险和假设

- **假设**：Claude 在执行 `/compound` 时能够从会话上下文中可靠地识别出「本次使用了哪些 skill」。如果不能，需要未来给 skill 调用打埋点。
- **风险**：eval 测试集的编写成本可能比预期高。缓解：P0 不强制 eval，`/skill-improve` 产出提案后允许不跑 eval 直接手动确认（但 `/skill-publish` 仍建议先跑 eval）。
- **风险**：`pending_absorption` 标记可能让本能文件变乱。缓解：frontmatter 一行字段，`/skill-improve --absorb` 发布后立即清理。

---

## 技术方案

### 方案概述

不改变现有架构，在两个接口上插入：

1. **`/compound`**：新增步骤 7「采集 skill 使用信号 → `skill-signals/{name}.jsonl`」、步骤 8「本能-skill 差异标记 → 在本能 frontmatter 加 `pending_absorption: "{skill}"`」。
2. **4 个新命令**：`skill-diagnose` → `skill-improve` → `skill-eval` → `skill-publish` 组成独立的闭环，按需触发，不与 Hook 交叉。

这五层共同构成反馈回路：

```text
使用 → 信号(L1) → 诊断(L2) → 提案(L3) → 验证(L4) → 发布(L5) → 使用
```

**核心安全规则**：eval 测试集文件不可被 skill 修改，防止「改考卷通过考试」。

### 任务拆解

- [x] **Task 1**：分析 v4 vs 当前目录差异 — 文件：`c:/Users/songyu/Downloads/tech-persistence-v4/` vs `c:/project/my/tech-persistence/`
- [x] **Task 2**：拷贝 4 个 skill 生命周期命令 — `user-level/commands/skill-{diagnose,improve,eval,publish}.md`
- [x] **Task 3**：拷贝 `/prototype` 命令和 `prototype-workflow` skill — `user-commands/prototype.md` + `user-level/skills/prototype-workflow/SKILL.md`
- [x] **Task 4**：创建 3 个 homunculus 子目录 — `user-level/homunculus/skill-{signals,evals,changelog}/.gitkeep`
- [x] **Task 5**：改造 `user-commands/compound.md` 加第七/八步 — 保持原有的项目文档更新步骤不变
- [x] **Task 6**：替换 `user-level/commands/learn.md` 为轻量版（依赖 Task 5 的 compound 完整版本）
- [x] **Task 7**：更新 `user-level/CLAUDE.md` 模板加入 skill 自迭代说明
- [x] **Task 8**：更新 `install.sh` / `install.ps1` 的命令列表、skills、homunculus 子目录
- [x] **Task 9**：在 `update.sh` / `update.ps1` 追加 `upgrade_to_v4` 函数并把 `LATEST_VERSION` 设为 `v4`
- [x] **Task 10**：更新 `README.md`：命令速查表 15→20、目录结构、版本演进表和时间线
- [x] **Task 11**：创建本计划文档

### 测试策略

- 手动验证：`ls` 每个新增文件落位
- 静态验证：`bash -n install.sh && bash -n update.sh` 确认无语法错误（PS1 同理用 `powershell -NoProfile -Command "& { Get-Command ...}"`）
- 运行时验证：下一个真实会话执行 `/compound`，观察是否能落地 skill-signals 记录（P0 阶段 Claude 手动执行即可）

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| `/compound` 步骤太多导致执行不完整 | 中 | 中 | 步骤独立可跳过，第七/八步不阻塞原有步骤 |
| `pending_absorption` 字段污染本能文件 | 低 | 低 | `/skill-publish` 发布后清理该字段 |
| eval 测试集缺失导致 `/skill-publish` 卡住 | 中 | 中 | 允许手动跳过 eval（显式确认后） |
| CRLF 行尾被 cp 改写 | 低 | 低 | 已确认两边脚本内容除 CRLF 外无差异 |

### 涉及文件

**新增**：

- `user-level/commands/skill-diagnose.md`
- `user-level/commands/skill-improve.md`
- `user-level/commands/skill-eval.md`
- `user-level/commands/skill-publish.md`
- `user-commands/prototype.md`
- `user-level/skills/prototype-workflow/SKILL.md`
- `user-level/homunculus/skill-signals/.gitkeep`
- `user-level/homunculus/skill-evals/.gitkeep`
- `user-level/homunculus/skill-changelog/.gitkeep`
- `docs/plans/2026-04-13-skill-self-iteration-loop.md` (本文件)

**修改**：

- `user-commands/compound.md` — 新增步骤 7、8，并调整输出报告
- `user-level/commands/learn.md` — 替换为轻量版
- `user-level/CLAUDE.md` — 模板加入工程方法论 + skill 自迭代说明
- `install.sh` / `install.ps1` — 命令列表 + 目录 + skills
- `update.sh` / `update.ps1` — 新增 `upgrade_to_v4`，`LATEST_VERSION=v4`
- `README.md` — 命令速查 15→20、目录结构、版本演进、v4 升级说明

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-04-13 | Task 1 | 用 diff 对比 v4 目录和当前目录，确认只有 `learn.md` / `CLAUDE.md` 有实质内容差异，其他 scripts/commands 仅是 CRLF 换行差异 |
| 2026-04-13 | Task 2 | `cp` 四个 skill 生命周期命令到 `user-level/commands/` |
| 2026-04-13 | Task 3 | `cp prototype.md` 到 `user-commands/`（作为工作流命令），`cp SKILL.md` 到 `user-level/skills/prototype-workflow/` |
| 2026-04-13 | Task 4 | `mkdir` + `cp .gitkeep` 创建三个 homunculus 子目录 |
| 2026-04-13 | Task 5 | 在 `compound.md` 的第五步和第六步之间插入 v4 步骤 7/8，原第七步输出报告改为第九步并增强 |
| 2026-04-13 | Task 6 | 直接覆盖 `user-level/commands/learn.md` 为 v4 的 21 行轻量版 |
| 2026-04-13 | Task 7 | 重写 `user-level/CLAUDE.md` 模板：补齐工程方法论角色表、需求输入路由、自学习规则、skill 自迭代说明 |
| 2026-04-13 | Task 8 | `install.sh` / `install.ps1` 的命令列表新增 4 个 skill 命令和 7 个工作流命令；homunculus 目录新增三个 skill-* 子目录；skills 新增 prototype-workflow |
| 2026-04-13 | Task 9 | `update.sh` / `update.ps1` 新增 `upgrade_to_v4`（5 步），`LATEST_VERSION=v4`，完成提示含 5 层架构说明 |
| 2026-04-13 | Task 10 | `README.md` 命令速查 15→20 并新增「Skill 自迭代闭环」表格；目录结构补齐新文件；版本演进表追加 v4 行；安装章节从 v3.2 切到 v4 说明 |
| 2026-04-13 | Task 11 | 本计划文档落盘 |

---

## 审查结果

### 总评

五层架构完整落地。当前阶段只跑到 P0（L1 信号采集 + 基础命令骨架），L2-L5 的诊断/提案/验证/发布命令均已有结构化 prompt，等待 1-2 个月真实使用信号后再迭代细节。

未来需要关注的：

1. Claude 在 `/compound` 执行时能否稳定识别「本次使用的 skill」——如果漏采会导致 `/skill-diagnose` 数据不足
2. `/skill-improve` 生成的提案质量——需要几轮真实迭代才能判断
3. eval 测试集的编写 ROI——如果写 eval 比改 skill 还贵就本末倒置

---

## 复利记录

### 提取的经验

- **反馈回路架构的关键是"信号不可由被评估对象自己产生"**：这是 `/skill-eval` 测试集不可被 skill 修改的设计来源。任何能改自己考卷的系统都是无效的。
- **P0 先采集再优化**：没有数据的优化是盲猜。先投 1.5 小时加信号采集，等 1-2 个月数据积累后再做诊断/提案/发布。这比一开始就设计完整闭环风险低得多。
- **在现有接口上插入 > 新建 Hook**：v4 没有新增 Hook 脚本，而是把 skill 信号采集嵌入 `/compound` 的第七步。这符合"在现有系统的两个接口上插入"的扩展原则。

### 创建/更新的本能

待后续会话中由 `/compound` 自动提取。本次集成是纯文件操作，没有被纠正的行为模式。

### 解决方案文档

- 本文件即整个集成任务的落地记录，不另外生成 `docs/solutions/` 条目（属于方法论/架构类，不是具体 bug 的解决）
