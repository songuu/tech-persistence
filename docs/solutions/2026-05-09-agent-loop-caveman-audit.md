---
title: "Agent-loop / Caveman 审计 + 全局 --auto 参数协议"
date: 2026-05-09
tags: [solution, architecture, agent-loop, caveman, auto-mode, multi-copy-sync]
related_instincts:
  - multi-copy-doc-drift
  - state-file-backward-compat
  - silent-error-swallow
  - cli-arg-dispatch-coverage
aliases: ["agent-loop 审计", "caveman 审计", "--auto 参数", "auto-mode 协议"]
---

# Agent-loop / Caveman 审计 + 全局 --auto 参数协议

## Problem

三个并行问题在一次会话中被发现并修复：

1. `/agent-loop` 与 `/caveman` 命令存在 5 个逻辑漏洞 — 涵盖文档、实现、向后兼容、错误处理。
2. orchestrator 多副本（user-level、plugin、.codex）漂移 — git tracked 派生文件未与源同步。
3. 缺少全局"是否需要用户审查"决策协议 — 每个命令都把人工 gate 行为硬编码，没法统一在某些场景下自动通过。

## Root Cause

### 1. `/agent-loop` 逻辑漏洞集中在三类：

- **文档与实现不对齐**：`doctor`/`self-test` 列在 usage section 但没在"执行规则" section 定义分派 → AI 把它们当成需求字符串。
- **向后兼容缺失**：`loadRun()` 直接 push 到 `state.providerRuns`，但旧版 state.json 可能没这字段 → 升级后旧 run resume 时 crash。
- **静默吞错**：`caveman-activate.js` 用 `try/catch {}` 把所有异常吞掉返回 0，hook 失效用户毫无察觉。

### 2. 多副本漂移源自 install 脚本机制：

- `install-codex.sh` 通过 `copy_codex_text` 把 `user-level/commands/*.md` 复制到 `.codex/commands/` 时，应用 `Claude Code → Codex` regex 替换。
- `.codex/` 目录被 git tracked，但没人定期重新生成。
- 改 user-level 源不改 .codex 副本 → git 状态显示陈旧的副本，造成困惑。

### 3. `--auto` 缺失 → 单一硬编码 gate：

- `/sprint` 在每个 phase 间硬要求 'go'，无视实际风险等级。
- 用户已经看清楚的低风险 step 还要手工 ack。
- 没有协议层面定义"什么时候必须问、什么时候可以自动"，导致每个命令各行其是。

## Solution

### 1. `/agent-loop` 文档 + 实现修复（5 个漏洞）

```text
[HIGH]   doctor/self-test 加入"执行规则"分派逻辑
[MEDIUM] plugin "Codex 的 /agent-loop" → "Claude Code 的 /agent-loop"
[LOW]    buildUntrackedDiff: 修正 \n 结尾文件的行计数；空文件单独处理；no-newline 文件追加 git 标记
[NEW]    loadRun 防御 state.providerRuns / state.files 缺字段
[NEW]    runResume 显式处理 completed / failed 状态
```

补充实现增强（非 bug 修，是改进）：

```text
validation 日志加时间戳（与 spec/impl/review 一致）
follow-up-task.md findings 从 JSON 字面输出改为 [P0] file:Lline: msg — fix:... 行式
runResume 增加 --no-review / --review-only / --implementation-only 拆分人工 gate
```

### 2. `/caveman` 文档对齐

`caveman/SKILL.md` 没有提 `wenyan` 别名、`off` 模式、`CAVEMAN_DEFAULT_MODE` 跨会话配置 — 这些都已在 `caveman-help/SKILL.md` 文档化但未交叉引用。

```diff
+ Default: full. Switch: /caveman lite|full|ultra|wenyan|wenyan-lite|wenyan-ultra
+ Bare wenyan is alias for wenyan-full.
+ Cross-session config: set env CAVEMAN_DEFAULT_MODE=<mode> (use 'off' to disable
+   auto-activation on session start) or ~/.config/caveman/config.json.
+ See /caveman-help for full reference.
```

### 3. 全局 `--auto` 协议（新增）

**单一规则文件作为决策中心**：`user-level/rules/auto-mode.md`，所有命令通过引用此规则获得一致的 gate 决策行为。

**三档决策矩阵**：

| 档位 | 行为 | 示例触发 |
|------|------|----------|
| 强制人工 | 无视 `--auto`，必问 | destructive、L4 风险、安全/认证、scope creep |
| 自动通过 | 静默继续，打印决策日志 | L0-L2 + 置信度 ≥ 0.8 + 范围在计划内 + 用户最近 ≥ 2 次 'go' |
| 灰区智能判断 | 视情况 | L3 任务、模型不确定、最近被纠正过 |

**双层 freeze 设计**（orchestrator）：

```javascript
// --auto-freeze: 永远跳过人工 freeze（旧行为，激进）
// --auto-evaluate: 通过 spec 自校验才自动 freeze（新增，保守）
function evaluateSpecForAutoFreeze(runDir) {
  // required 字段齐全 ∧ questions: [] ∧ 无 L4 task ∧ acceptance 非空
  // → canAutoFreeze: true
}
```

**多副本同步自动化**：

新增 `scripts/propagate-command-changes.js`，把 `user-level/commands/<cmd>.md` 改动按 `Claude Code → Codex` regex 同步到 4 个目标位置：

```text
plugins/tech-persistence/commands/<cmd>.md       (verbatim)
plugins/tech-persistence/skills/<cmd>/SKILL.md   (注入到"## Command Instructions"段)
.codex/commands/<cmd>.md                         (apply regex)
.codex/skills/<cmd>/SKILL.md                     (注入 + apply regex)
```

一次跑通 9 个命令 + 1 个 rule = 37 个文件，零手工 Edit。

## Prevention

### 文档完整性自检清单

改任何 CLI 参数 / 子命令时，必须同时检查：

```text
[ ] command file 用法（usage）段
[ ] command file 执行规则（dispatch）段 — 缺这个 = AI 行为偏差
[ ] command file 文件契约段（如果产物变更）
[ ] README 命令速查表
[ ] orchestrator/CLI usage() 输出
[ ] self-test 增加纯逻辑函数的回归用例
```

### 多副本派生关系

发现 git tracked 的派生文件 → 立刻：

1. 找到原始（grep install 脚本反查 source path）
2. 找到 transformation 规则（regex 替换列表）
3. 写 propagation 脚本，不要手工同步
4. 长期看应该把派生副本从 git 移除，改为 release-time 生成

### state 文件向后兼容

任何 `state.X.push(...)` / `state.X.field = ...` 之前，确保 `state.X` 已存在。在 `loadRun` / 反序列化入口处统一 default 新字段：

```javascript
function loadRun(...) {
  const state = readJson(statePath);
  if (!Array.isArray(state.providerRuns)) state.providerRuns = [];
  if (!state.files || typeof state.files !== 'object') state.files = {};
  return { runDir, statePath, state };
}
```

### Hook 脚本错误处理

Hook 不能崩溃影响主会话，但**必须可观察**：

```javascript
try { main(); } catch (error) {
  try { process.stderr.write(`[hook-name] failed: ${error.message}\n`); } catch {}
  process.exit(0);  // 不影响 session
}
```

绝不写 `try { ... } catch {}`（吞掉所有错误且无日志）。

### 强制人工 gate 的边界永远不让步

实现 `--auto` 时最大诱惑是"全自动"。但下列必须永远问用户：

- destructive 不可逆（rm -rf, DROP TABLE, force push, branch delete）
- 跨用户副作用（PR、Slack、付费 API）
- 安全相关（关闭检查、`--no-verify`）
- L4 风险任务
- 测试失败仍要继续

写这条边界比写自动逻辑更重要。

## Related

- [[2026-04-27-agent-orchestrator-v6]] — agent-loop v6 外部编排器原始架构
- [[multi-copy-doc-drift]] — 多副本文档漂移本能
- [[state-file-backward-compat]] — state 文件向后兼容本能
- [[silent-error-swallow]] — 静默吞错反模式本能
- [[cli-arg-dispatch-coverage]] — CLI 参数分派覆盖本能
- `~/.claude/rules/auto-mode.md` — auto-mode 决策协议
- `scripts/propagate-command-changes.js` — 多副本同步工具
