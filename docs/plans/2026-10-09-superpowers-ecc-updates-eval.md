---
type: evaluation-plan
status: completed
created: 2026-10-09
updated: 2026-10-09
scope: research-only
tags: [evaluation, superpowers, ecc, architecture]
---

# Superpowers / ECC 近期更新增量评估

用户问题：在目前 Tech Persistence 架构下，Superpowers 和 ECC 最近哪些更新值得借鉴？

这是上一轮外部项目研究的延续。本轮不启动新的 Sprint 状态机，不修改未完成的其他计划或活动指针。仅研究、保存可复核报告；不安装上游、不修改产品代码、不运行 Compound、不写本能或晋级学习、不提交或推送。

## 基线与完成条件

- TP 身份：Claude Code / Codex 的持久工程记忆与工作流层；可选运行时与验收基础设施以当前源码为准。
- Superpowers 基线：[[2026-09-04-superpowers-v63-eval]] 与 [[2026-09-09-superpowers-spec-brainstorming-eval]]；固定历史提交 `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`。
- ECC 基线：[[2026-06-05-ecc-eval]] 的 2026-07-30 补充。该补充没有固定上游 SHA，本轮不声称获得精确逐提交历史差分。
- 完成标准：固定当前发布/源码；核查真正增量及真实落点；给出优先级、已有覆盖、拒绝项和验证限制；产品价值、一致性、可行性三项只读复核完成。

## 关键假设验证（ADR-012）

| 假设 | 验证方式 | 实际发现 | 可信度 |
|---|---|---|---|
| 最近发布说明足以代表真实增量 | 固定 Superpowers `8ca22dba9a94f28898bbce59f2537ff4d87c747d` 与 ECC `c05b2d6614f62f6db0047669aa4eefb223d478f9`，读取 tag、Git diff、技能正文、安装与发布源码 | 假设被推翻；README、CHANGELOG、manifest 和技能正文存在口径差异，采纳判断必须以固定源码为准 | 高 |
| 上游新增机制在 TP 中均是能力缺口 | 对照 `user-level/commands/`、`codex-native/skills/`、安装事务、plugin builder、transcript 与 learning owner | 假设被推翻；11 项中只有 2 项 P1、3 项 P2，另有 2 backlog、2 cross-ref、2 hard-reject，不能把更新列表直接变成实施清单 | 高 |
| ECC 的安装保护可以原样替换 TP 安装器 | 读取 ECC ownership/revalidation 实现并对照 TP Codex 事务安装与 legacy `install.sh` | 假设被推翻；TP 已有更强的部分边界，真正增量是针对 legacy 同名文件、半失败和实际分发产物的窄回归样本 | 高 |
| 只读研究结论等于行为收益已验证 | 核对本轮执行记录和报告限制 | 不成立；本轮未运行上游脚本、CI、账号或成本 canary，成本、漏测率和返工率仍需后续本地 A/B 证明 | 高 |

## 研究任务

- [x] 核对 GitHub 发布和固定 Git 提交；区分发布日期、commit 日期、CHANGELOG 标签日期。
- [x] 读取历史评估、架构 manifest 与当前有效规范。
- [x] 读取上游技能、安装、归档、发布源码，对照当前 TP 原生与共享源。
- [x] 给出候选评分、真实落点及双向挑战。
- [x] 三项独立复核；关闭报告中的可操作问题。
- [x] 读回报告、验证本地路径及来源锚点、核对工作树范围。

## 产物

- [[2026-10-09-superpowers-ecc-updates-report]]：证据、候选、取舍与最终建议。
- 研究文档是评估产物，不代表候选已经实施、通过行为评测或获得发布授权。
