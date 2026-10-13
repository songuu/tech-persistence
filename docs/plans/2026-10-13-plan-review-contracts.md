---
type: implementation-plan
status: completed
created: 2026-10-13
updated: 2026-10-13
risk: L2
tags: [workflow, plan, review, superpowers]
---

# Plan / Review 任务契约补强

本轮实施 [[2026-10-09-superpowers-ecc-updates-report]] 的 C1/C2：将关键接口和断言交接、隐含失败输入、未判断项处置纳入现有双原生工作流。用户已授权直接实施；不改变其他活动 Sprint 指针。

## 契约接口

| 契约 | Before | After | 消费者 |
|------|--------|-------|--------|
| Plan task | 文件/依赖/风险/完成证据 | 条件性补确切接口、需求值、断言与命令；跨任务引用 Consumes/Produces | 共享 Plan command、Codex Plan skill、计划模板 |
| 风险输入交接 | Review 泛化边界检查 | L2+ 或错误/输入边界：最多五项风险绑定测试 owner；planned 不等于 verified | Plan、Review、模板 |
| 未判断项 | 未跑验证/视角跳过汇总 | 行为未判断与未跑验证分开；主代理逐项处置，已知缺陷仍分级 | 共享 reviewer prompt/输出、Codex Review、模板 |
| 授权/验收 | 当前 scope、冻结 criterion、Receipt owner | 保持；风险发现不授权 scope 扩张/合同改写/只读修复 | 所有上述消费者 |
| 投影 | 共享 command + native override 由既有生成器投影 | 生成机制不变；Plan reference 随 native 目录生成并按需读 | Claude skills、Codex skills；thin commands 不变 |

## 任务

- [x] 读取实际入口、生成器、投影测试和规范；工作树基线无修改。
- [x] 更新共享 Plan/Review、Codex 原生入口与计划模板；Native Plan 维持 4 KiB 以内，详细契约放条件 reference。
- [x] 传播受管投影，运行定向验证。
- [x] 独立检查协议行为与源/投影一致性，关闭发现后读回交付。

## 验证

基线已通过 `test-claude-codex-skill-projection-boundary.js`、`test-codex-native-skill-projection.js`。纯 prompt/Markdown 契约不新增只匹配措辞的测试；使用现有 projection/plugin/size checks，并独立检查多任务接口、隐含失败输入、低风险任务与冻结合同反例。独立检查不使用 governed learning/eval journal，不伪造 A/B 效率数据。

## 关键假设验证

- 假设：新增交接可以复用现有投影而不建立另一 owner。证据：`propagate-command-changes.js plan review`、两项投影测试及插件校验通过；新 Plan reference 与生成物内容一致，thin command 保持不变。结论：源码与受管投影能够承载本次契约。
- 假设：按需 reference 能维持入口预算且保留低风险路径。证据：Native Plan LF UTF-8 为 3957 bytes，低于现有 4096 上限；独立 agent 对 L0 拼写修正只给单任务和局部核对。结论：此样本没有引入强制接口/风险表。
- 假设：契约能帮助交接和审查而不扩大冻结合同。证据：独立合成 L2 配置导入计划明确 validate/import 的接口与测试 owner；只读审查识别非法字段异常，保留缺证 unknown，不改冻结 AC、不启动 Harness。结论：三个样本符合目标，但不证明长期返工率、Token 成本或真实宿主表现提升。

源文件：`user-level/commands/plan.md`、`review.md`；`codex-native/skills/plan/SKILL.md`、`plan/references/task-contracts.md`、`review/SKILL.md`；`docs/plans/TEMPLATE.md`。生成物通过 `node scripts/propagate-command-changes.js plan review` 更新，不直接修改。

## 结果与限制

已完成共享源、Codex 原生入口、条件 reference、计划模板和两套插件投影。新增 Review 输出同时覆盖通用 reviewer 与两套 design 专用模板。

实际通过：

- `node scripts/test-codex-native-skill-projection.js`：通过，含入口预算/目录投影/validator 契约。
- `node scripts/test-claude-codex-skill-projection-boundary.js`：通过；修正 design 模板后再次通过。
- `node scripts/test-think-design-routing.js`：通过，原有路由与 shadow authority 边界保持。
- `node scripts/validate-codex-plugin.js`：通过；最终投影再次校验通过。
- `node scripts/project-standards.js --project-root . --check --runtime both --profiles auto --json`：Claude/Codex valid。
- 两项 skill-creator `quick_validate.py`：以 Python `-X utf8` 运行通过；初次因 Windows 默认 GBK 读取 UTF-8 失败，属于工具编码问题，已用调用参数解决。
- 只读 `checkPlanScope` / `checkPropagateSync`：均返回空问题数组；`git diff --check` 通过。
- Native Plan / Review LF UTF-8 分别为 3957 / 3401 bytes；Plan 新 reference 与生成物一致。

独立检查结果：

| 场景 / 审查 | 观察结果 | 边界 |
|-------------|----------|------|
| L0 README 拼写修正 | 单任务、局部核对，无强制接口/风险表 | 仅计划输出，未修改合成 README |
| L2 配置导入计划 | validate/import 同步接口通过 Consumes/Produces 交接；非法 JSON、null/基本类型、缺失/非字符串/空白 label 分配测试 owner | 验证均标 planned，未运行合成项目测试 |
| 只读审查坏实现 | 检出 `config.label.trim()` 的非法字段异常，AC-2 failed；缺执行证据的 AC-1 unknown；persist 内部列未判断项，不改冻结合同、不启动 Harness | 静态语义检查，不是实际宿主/模型 A/B |
| 独立 source/投影审查 | PASS；修复并读回两项发现：design 专用模板遗漏输出契约、计划缺关键假设验证段 | 未执行真实 provider/cost canary |

收益、真实 Claude/Codex 执行表现与返工率仍待本地使用测量。本轮为工作流契约实现，不新增自动语义 gate。安装保护、分发包生命周期、会话诊断属于后续建议；未运行 Compound、写本能、提交/推送或刷新机器已安装插件缓存。

## 回滚

撤回本轮源/模板及 reference 改动，再运行相同投影命令；不涉及状态迁移、用户数据或新的 runtime gate。
