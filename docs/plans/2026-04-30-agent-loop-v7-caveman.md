---
title: "agent-loop v7 caveman integration"
type: sprint
status: completed
created: "2026-04-30"
updated: "2026-04-30"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
tags: [sprint, architecture, agent-loop, caveman, v7]
aliases: ["v7 caveman"]
---

# agent-loop v7 caveman integration

> **Status:** `in-progress`
> **Created:** 2026-04-30
> **Updated:** 2026-04-30

---

## 需求分析

### 要做
- 在当前 Tech Persistence / Agent Loop v6 架构上接入 `JuliusBrussee/caveman`，形成 v7。
- 功能和效果对齐上游 caveman：压缩输出、强度档位、commit/review 精简、memory 文件压缩、SessionStart 自动激活。
- 接入必须走当前项目的源头分发面：`user-level/skills`、`scripts/`、`plugins/tech-persistence/`、验证脚本和文档一起更新。
- v7 不能引入“中间层”调和上游和项目事实；项目 runtime/skill 行为仍是执行真相，上游 caveman 作为功能基线和素材来源。

### 不做
- 不把 tech-persistence 的 agent-loop v6 状态机替换成 caveman 或 cavekit。
- 不强制执行真实压缩 LLM 调用作为验证，因为这依赖外部 Claude/API 环境。
- 不删除现有 v6 orchestrator 的 provider adapter、normalizer、validation runner。

### 成功标准
- [ ] `$caveman` skill 可用，规则覆盖 lite/full/ultra/wenyan 系列，并保留风险场景自动恢复正常表达。
- [ ] `caveman-commit`、`caveman-review`、`caveman-help` skill 可用。
- [ ] `caveman-compress` 带完整 scripts，能按上游流程检测、压缩、验证和失败恢复。
- [ ] SessionStart hook 注入 caveman 规则，效果与上游 `.codex/hooks.json` 的自动激活一致，同时保留 tech-persistence memory 注入。
- [ ] 插件 build/validation/install 认识新增 skills 和 v7 hook 文件。
- [ ] 文档明确 v7 架构和上游对齐点。

### 风险和假设
- 上游 caveman 是 MIT；复制代码必须保留 license/attribution。
- Codex Windows hooks 当前可能不完全启用；v7 仍提供 `$caveman` 手动入口，hook 作为可用环境下的自动激活。
- 用户长期偏好中文优先，所以 v7 caveman 规则必须保留“沿用用户语言”的执行约束，避免上游英文示例覆盖本项目交互偏好。

---

## 技术方案

### 方案概述

v7 是 Tech Persistence 插件的“语言压缩能力层”，不是 agent-loop 的替代实现。实现上把 caveman 作为内置 skill family 和 SessionStart context 注入，跟现有 Memory v5、sprint、agent-loop v6 并列分发。`scripts/agent-orchestrator.js` 只升级版本号和命名，不改变已有 provider/state 责任边界。

上游 caveman 文件直接作为功能基线：主 skill 规则、commit/review/help skill、compress skill 与 Python scripts 进入 `user-level/skills` 源头；`plugins/tech-persistence/scripts/build-codex-plugin.js` 改为复制完整 skill 目录，确保 scripts/assets 不丢；验证脚本同步新增 skill 和 hook 文件。

### 任务拆解

- [x] **Task 1**: 源头调研和 sprint 文档 — 文件: `docs/plans/2026-04-30-agent-loop-v7-caveman.md`
- [x] **Task 2**: 增加 v7 架构文档和 caveman attribution — 文件: `docs/architecture/agent-loop-v7-caveman-architecture.md`, `docs/vendor/caveman/*`
- [x] **Task 3**: 接入 caveman skill family 与 compress scripts — 文件: `user-level/skills/*`
- [x] **Task 4**: 增加 SessionStart caveman hook，并同步插件 build 逻辑 — 文件: `scripts/caveman-activate.js`, `plugins/tech-persistence/hooks.json`, `plugins/tech-persistence/scripts/build-codex-plugin.js`
- [x] **Task 5**: 更新版本、验证脚本、README 和生成后的插件产物 — 文件: `scripts/agent-orchestrator.js`, `scripts/validate-codex-plugin.js`, `scripts/validate-codex-install.js`, `plugins/tech-persistence/**`
- [x] **Task 6**: 运行验证并做 review/compound 记录 — 命令: `node scripts/agent-orchestrator.js self-test`, `node scripts/validate-codex-plugin.js`

### 测试策略
- 单元/自检: `node scripts/agent-orchestrator.js self-test`
- 插件结构: `node scripts/validate-codex-plugin.js`
- 生成链路: `node plugins/tech-persistence/scripts/build-codex-plugin.js`
- 脚本语法: `python -m py_compile` 覆盖 caveman-compress scripts

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 自动 caveman 与中文优先冲突 | 中 | 中 | skill/hook 明确保留用户语言和安全场景正常表达 |
| build 只复制 SKILL.md 导致 compress scripts 丢失 | 高 | 高 | 改为递归复制 skill 目录 |
| 上游 license 丢失 | 中 | 高 | 增加 `docs/vendor/caveman/LICENSE` 和架构文档 attribution |
| hooks 在 Windows 不触发 | 中 | 中 | 保留 `$caveman` 手动入口并在 README 标明 |

### 涉及文件
- `user-level/skills/caveman/SKILL.md`
- `user-level/skills/caveman-commit/SKILL.md`
- `user-level/skills/caveman-review/SKILL.md`
- `user-level/skills/caveman-help/SKILL.md`
- `user-level/skills/caveman-compress/**`
- `scripts/caveman-activate.js`
- `plugins/tech-persistence/scripts/build-codex-plugin.js`
- `scripts/validate-codex-plugin.js`
- `scripts/validate-codex-install.js`
- `scripts/agent-orchestrator.js`
- `README.md`
- `plugins/tech-persistence/**`

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-04-30 | Task 1 | 对齐 v6 架构、caveman 上游功能面和 v7 接入范围 |
| 2026-04-30 | Task 2 | 增加 v7 架构文档和 MIT attribution |
| 2026-04-30 | Task 3 | 从上游接入 caveman/caveman-commit/caveman-review/caveman-help/caveman-compress，并补 Codex 触发说明 |
| 2026-04-30 | Task 4 | 增加 `caveman-activate.js` SessionStart hook；build 改为递归复制 skill 目录 |
| 2026-04-30 | Task 5 | 升级 orchestrator version 为 v7，更新 README、验证脚本和插件产物 |
| 2026-04-30 | Task 6 | 完成 self-test、plugin validate、project/user install validate、py_compile 和 diff check |

---

## 审查结果

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### 总评

v7 接入完成。Caveman 功能面已进入源头、插件产物、项目级 `.codex/skills` 和用户级安装面；验证脚本覆盖了 compress scripts 丢失风险。

---

## 复利记录

### 提取的经验
- 带脚本/资产的 skill 不能只复制 `SKILL.md`；插件 build 和 install 都必须递归复制整个 skill 目录。
- 上游跨运行时 skill 中的 Claude/Codex 字样不能一律文本替换，必须区分未转换残留和真实运行依赖。
- Windows 上重建目录时，保留目录并覆盖文件比删除整个目录后重建更稳定。

### 创建/更新的本能
- 架构决策已记录到 `.codex/rules/architecture.md` 的 ADR-007。

### 解决方案文档
- `docs/solutions/2026-04-30-agent-loop-v7-caveman.md`
