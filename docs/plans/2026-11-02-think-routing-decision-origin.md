---
type: implementation-plan
status: review
created: 2026-11-02
updated: 2026-11-02
risk: L2
tags: [think, plan, multi-runtime, decision-origin]
---

# Think 路由后置与关键决策来源

用户授权按 [[2026-10-16-superpowers-v7-spec-brainstorming-eval]] 的收缩方案实施。只调整最终路由确定时机、Think→Plan 关键选择交接及方案来源短注；不新增固定分类表、独立 reviewer、lineage runtime 或活动 Sprint 状态边。

## 契约接口

| 契约 | Before | After | 消费者 |
|---|---|---|---|
| Think 最终路由 | 提示先分型，所有输出要求 route | 先澄清会改变结果的关键未知；可暂不定 route；信息充分后使用现有枚举 | 两端 Think、Plan/Work handoff |
| 单向升级 | 初始猜测可能过早触发棘轮 | 最终路由确定并开始执行后适用单向升级；风险/权限提前检查 | 两端 Think；既有 Sprint 状态机 |
| 决策来源 | 范围与方案理由未区分来源 | Think 传递保留/委托/未决选择；Plan 在关键理由旁标注用户要求/项目约束/agent 选择 | 两端 Plan、条件 reference、计划模板 |
| 投影与预算 | 双 SoT 与受管生成 inventory | 沿用生成器；Codex Plan 入口仍 <4096 LF UTF-8 bytes | Claude/Codex plugins、projection tests |

## 关键假设验证

- 假设：现有双 SoT 与生成器足以承载路由后置和来源短注。证据：路由、双端投影、插件校验与 project-standards 检查通过，Codex Think/Plan 为 3441/3994 LF UTF-8 bytes。结论：无需新 parser 或控制面即可实施。
- 假设：后置最终路由能修正提前分型，同时保留清晰任务快速路径。证据：Codex 六类新旧对比中，missing/reserved 的候选先澄清、不定 route；clear 仍为 bounded-like → Work。结论：单轮样本支持本轮契约，不能外推统计效率。
- 假设：认证状态存在就能完成双端原生验证。证据：Claude 的 loggedIn=true 后，实际调用仍返回 OAuth 过期且无法刷新。结论：该假设不成立，Claude 行为复验保持待完成，不以静态验证替代。

## 任务

- [x] 检查规范、当前源与生成器；保存变更前双端 Think/Plan 快照。
- [x] 修改双方 Think/Plan、条件 reference 和模板；保持明确任务快速路径与既有 gate。
- [x] 传播投影并运行路由、parity、插件与入口预算验证。
- [x] Codex 原生新旧对比与独立行为复核；源码审查通过。
- [ ] Claude 原生新旧对比：OAuth 已过期且无法刷新，需重新登录后补跑；双端静态验证已完成。

## 验证设计

静态检查沿用现有测试，不新增仅匹配新措辞的测试。行为验证使用隔离目录、固定输入和变更前快照，对比清晰小改、隐藏关键选择、用户保留选择、明确委托、既有项目约束及高影响未决项。每例只取下一条正常回复，不把预期答案传给被测模型。原生宿主结果与静态/语义检查分开报告；超时/认证失败保留 unknown，不记为行为通过。

本轮合成样本用于退化筛查，不写入 self-learning/promotion journal，不证明统计 ROI。回滚只需撤回本轮源/模板修改并运行 `node scripts/propagate-command-changes.js think plan`；已有计划与用户决策记录保留。

## 验证结果

- 基线：现有 `test-think-design-routing.js` 通过；Codex Think/Plan 的 LF UTF-8 大小为 2878/3957 bytes。
- 最终大小：Codex Think/Plan 为 3441/3994 bytes，均满足 `<4096`。
- 已通过：`test-think-design-routing.js`、`test-claude-codex-skill-projection-boundary.js`、`test-codex-native-skill-projection.js`、`validate-codex-plugin.js`、Think/Plan 的 `quick_validate.py`、双 runtime `project-standards --check`、只读 `checkPropagateSync` 与 `git diff --check`。
- 提交前修正：原 `checkPlanScope` 调用只传入 skill/command 路径，未覆盖两份新增计划，漏报 ADR-012 必需的“关键假设验证”段。本次补齐后改用整个暂存文件列表检查，并运行完整 `pre-commit-check.js` 复验。
- 独立源码审查 PASS；曾发现并修复 Codex Plan 条件 reference 的“常规开发”触发遗漏，保留 10 月任务契约覆盖。修复后重新传播并验证投影。

### Codex 原生行为证据

环境：Codex CLI 0.166.0，沿用 CLI 默认模型选择（本轮 JSON 事件未给出可验证的具体 model ID，不推测）；`--ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox read-only`，关闭 hooks/plugins/shell_tool/apps/multi_agent。在临时空目录中将冻结的 workflow 文本提供给原生 CLI。Codex Plan 条件 reference 手动附入输入，因此不把本结果称为 reference 自动加载或已安装插件发现验证。

基线来自变更前快照，与仓库 HEAD `fbb47dc` 的相关源一致。12/12 原生调用均有 `turn.completed` 与有效 `agent_message`，无 error/turn.failed 或工具执行事件。独立复核认为候选 6/6 满足本轮目标边界：

| 场景 | 基线观察 | 候选观察 |
|---|---|---|
| clear：README 单处替换 | bounded-like → Work，无追问/新文档 | 同样保留快速路径 |
| missing：稿件来源/入口/权限未定 | 提问但提前锁定 architectural-like | 先问关键问题，未锁定 route |
| reserved：用户保留原生/网页选择 | 保留用户选择，但提前锁定 architectural-like | 保留用户选择，澄清前不定 route |
| delegated：离线 CSV，技术细节已委托 | 给出合理默认值 | 明说“实现选择由我决定”，不反复询问委托项 |
| existing：Flask 项目增加标签过滤 | 沿用既有 stack，来源仅隐含 | 分别标明用户需求、项目约束及 agent 的提交按钮选择 |
| unresolved：数据部署由用户保留且未选 | 先问用户，不先拆实施任务 | 同样先澄清，颜色/命名继续由 agent 决定 |

delegated 样本没有给所有既定事实逐一重标来源；它支持“agent 默认不冒充用户意见”，不能证明所有来源完整性。missing/reserved 各只有一次新旧对照，是可读的回归证据，不是统计准确率。

六例合计的实际 usage：baseline input/output 为 119133/2328 tokens，treatment 为 120051/1920 tokens；两臂串行耗时合计分别为 178210/174982 ms。treatment 有 17408 cached input tokens、baseline 无缓存，且样本很小，不能据此宣称成本、延迟或长期 ROI 改善。

### Claude 环境阻塞

Claude Code 2.1.316，认证状态查询曾为 `loggedIn=true`；实际调用并不成功。最初 safe-mode 样本 120 秒超时；改用 restricted 最小 READY 请求，沙箱内 65 秒超时，沙箱外明确返回 `authentication_failed`：`OAuth session expired and could not be refreshed`。诊断记录的默认模型为 `claude-opus-5-5`，但未取得有效模型回答。

最终结果事件虽为 `subtype=success`，同时为 `is_error=true`，进程 exit 1；按错误处理。后续十二个 Claude 行为调用已停止，**Claude 有效行为样本为 0/12**。当前完成的是 Claude/Codex 源码、投影和静态契约检查；Claude 原生行为复验仍待重新登录。重新登录后用新的结果目录运行同样六类 baseline/treatment，避免覆盖既有失败证据。

### 复核与产物

独立源码审查与独立 Codex 行为复核均 PASS。原始输入、冻结快照、每例响应、usage 和认证诊断保存在 `C:/Users/Administrator/AppData/Local/Temp/tp-think-origin-21e594c6165a447b9fb3c2de2719594b/`；`validate-native.cjs` 为一次性 smoke runner，不新增仓库运行时。

候选实际注入文本的 SHA-256：Codex Think 为 `c2d78f2d7ed68e41389c148452ace200a8488645e52df089d703ee720711210c`；Codex Plan（含手动附入的 reference）为 `0616776606d81b4d57bbf2f4aec47085d56eefb97f0d0141227e5e6b7199d9ce`。已读回与最终源码一致。

只改仓库源、模板和受管插件投影，未刷新机器已安装插件缓存；未提交、推送或写入 learning/Compound。先前已有的 10 月评估文档及其索引修改保留。
