---
type: sprint
status: completed
phase: compound
date: 2026-10-09
runtime: codex
mode: auto
tags: [sprint, sibling-eval, muse-skills]
---

# obra/muse-skills 接入架构评估

## 用户请求

研究 https://github.com/obra/muse-skills 是否能接入 tech-persistence 当前架构。按 `/sprint --auto` 推进，交付基于源文件证据的兼容性结论、候选落点与后续建议。

## 范围与边界

本次执行研究评估和本地报告，不安装外部技能，不执行外部仓库脚本，不调用其服务，不提交或推送代码。实际架构与现有落点须读取当前仓库验证。

## 关键假设验证（ADR-012）

| 假设 | 验证方式 | 实际发现 | 可信度 |
|---|---|---|---|
| Muse Skills 是可直接接入 TP 的同类工作流控制面 | 固定上游提交 `f1f450e22de6f1881103b3b88986f14d1274e27e`，读取 README、manifest、代表性 `SKILL.md` 与依赖 | 假设被推翻；它是 Hatch 容器技能的非官方自动镜像，不拥有 TP 的 Sprint、记忆与学习状态 | 高 |
| `SKILL.md` 格式相似即可证明运行时兼容 | 对照 `plugins/tech-persistence/scripts/build-codex-plugin.js`、capability router、provider adapter 与上游运行时依赖 | 假设被推翻；格式只能证明静态入口相似，工具、授权、状态 owner 与 connector capability 仍需逐项适配 | 高 |
| 现有 TP 没有可承接候选方法的落点 | 对十一项候选逐项 `rg` 并读取报告列出的 17 个本地落点，运行投影边界与 capability router 既有测试 | 假设被推翻；三项只需 cross-ref，五项适合作为分级 follow-up，整包安装与重复产品运行时应拒绝 | 高 |
| 研究授权包含安装或运行上游代码 | 回读用户请求、范围段和 acceptance contract | 不成立；本轮仅允许固定版本研究、报告与本地决策归档，未安装技能、未调用服务、未改变远程状态 | 高 |

## 阶段验收

- [x] Think：核实双方身份、当前架构和研究成功标准。
- [x] Plan：完成候选、原则评分、现有落点与验证安排。
- [x] Work：收集上游固定版本证据，完成接入报告。
- [x] Review：产品价值、内部一致性、可行性三路独立审查并处理发现。
- [x] Compound：在当前授权范围完成决策归档，核实终态。

## Think 验收

- TP 身份：面向 Claude Code/Codex 的长期工程记忆与工作流层；现有 `user-level/`、`codex-native/`、插件生成器与受治理学习机制为实际架构证据。
- 上游身份：Hatch 容器技能的非官方自动镜像；不是 TP 同类的 Sprint/记忆控制面。固定评估提交为 `f1f450e22de6f1881103b3b88986f14d1274e27e`。
- 路由：`bounded-like`。本次消费者接口是研究报告，影响局限于文档；真实 adapter/安装实现须另立范围。
- 成功标准：固定版本并统计资产；至少八维身份对照；逐候选核验源码与 TP 落点；区分原样安装、方法借鉴、能力适配和未知项；完成三路独立审查与挑战。
- 原则校准：MR 为双宿主能力与边界一致，不要求接口字节相同；DET 限于授权、状态与落盘关键路径；LT 为默认核心保持轻量，允许已有可选基础设施；OBS 限于人类知识产物，不禁止现有 JSON/SQLite/Postgres 运行态。
- 证据：`package.json` 存在 `pg` 与 transcript/acceptance Postgres 命令；`.codex/rules/architecture-{base,agent,infrastructure}.md` 已读取。manifest 中 `rules/` 路径按 Codex runtime 根解析，仓库根没有同名目录。
- 假设：用户要求研究可行性，本次不将研究授权扩大为安装、联网业务调用或修改共享知识治理。

## Plan 验收

方案：固定上游提交，按“可复用方法 / 需宿主适配的能力 / 不接入的产品运行时”评估，不把 `SKILL.md` 格式兼容误当成运行时兼容。保持 TP 单一状态 owner 与现有双运行时投影。

<!-- acceptance-contract:start -->
- [x] 固定上游版本，核实技能与配置数量、主要依赖及来源局限。
- [x] 用至少八个维度对照双方身份，并按实际架构校准 MR、DET、LT、OBS。
- [x] 为十一项候选提供源码证据、原则评分、真实落点与决策。
- [x] 区分已验证事实、推断、未知和环境阻塞，给出最小接入顺序及回退边界。
- [x] 完成产品价值、一致性和可行性三路独立审查，记录双向挑战与真实判断修正。
- [x] 核实报告、文件变更和 Sprint 终态，不安装外部技能或改变远程业务状态。
<!-- acceptance-contract:end -->

### 有序任务

| Task | 目标 / 文件集合 | 依赖 | 风险 | 完成证据 |
|---|---|---|---|---|
| T1 | 固定源码与资产计数；临时 clone、本计划 | 无 | L0 | commit、GitHub API、`git ls-tree`、代表文件读取 |
| T2 | 十一候选和八维对照；`docs/reports/2026-10-09-muse-skills-eval.md` | T1 | L0 | 每个落点 `rg` + Read，source permalink |
| T3 | 核实投影 / capability 边界；已有测试与报告 | T2 | L0 | 最窄现有测试及一次性文档核验，无上游代码执行 |
| T4 | 三路只读独立审查及挑战；报告与本计划串行修订 | T3 | L0 | reviewer 实际检查文件清单、finding 与关闭记录 |
| T5 | 当前范围内决策归档与终态；本计划、状态 CLI | T4 | L0 | 验收 checklist、readback、complete |

### 候选初筛（详细评分和证据在报告）

| ID | 内容 | 初步决策 | 已核实 TP 落点 |
|---|---|---|---|
| C1 | self-awareness 依据实测能力回答 | cross-ref | `.codex/rules/architecture-agent.md`、`scripts/codex-runtime-doctor.js` |
| C2 | 技能短主文件与按需 references | cross-ref | 现有 phase skills、`scripts/skill-size-budget.js` |
| C3 | wide-research 固定 manager / worker 编排 | hard-reject（待挑战） | `scripts/agent-orchestrator/execution-envelopes.js`、`capability-router.js` |
| C4 | reviewed-read allowlist，未知 tool 失败闭合 | P1 设计 follow-up | `scripts/agent-orchestrator/provider-adapter-registry.js`；当前仅 provider 适配，不宣称已有通用 connector owner |
| C5 | capability-aware auth 状态、scope 与访问分开 | P2 条件 follow-up | `.codex/rules/architecture-agent.md`、`scripts/agent-orchestrator/runtime-capabilities.js` |
| C6 | artifact 渲染后读回 + 确定性质量门 | P2 条件 follow-up | `codex-native/skills/review/SKILL.md`、`site/tests/project-model.test.js` |
| C7 | 原样安装 connector 技能与 Hatch manifest | hard-reject | `plugins/tech-persistence/scripts/build-codex-plugin.js`、现有宿主 connector |
| C8 | 整包移植 Spaces Bun/worker/UI runtime | hard-reject（价值层待挑战） | `site/lib/project-model.js`、`site/tests/project-model.test.js` |
| C9 | 移植 Muse goals/forget/产品记忆控制面 | hard-reject | `scripts/lib/self-learning-service.js`、`codex-native/skills/memory/SKILL.md` |
| C10 | 有界只读诊断和敏感投影限制 | cross-ref | `scripts/lib/memory-tools.js`、`scripts/memory-mcp-server.js` |
| C11 | 按固定提交比较上游差异与来源记录 | backlog | `scripts/skill-eval-cases.js`、`scripts/skill-eval-results.js` |

验证策略：文档 L0；不新增模拟实现的测试，不运行全量 suite。运行已有 `test-claude-codex-skill-projection-boundary.js` 与 `test-runtime-capability-router.js` 核实被报告依赖的两个边界。报告不能把测试通过写成 Muse 业务适配已完成。

授权：本次允许本地研究与 Sprint 状态推进。新 adapter、安装、凭据连接、发布、共享本能 promotion 均留作后续明确任务。回退为撤回本次报告与计划；不改现有运行时。

## 执行记录

- 2026-10-09：状态工具返回 `missing-pointer`，本次创建新 Sprint；不恢复历史 handoff。
- 环境：沙箱内 Node 启动报告 `helper_unknown_error: setup refresh had errors`；只读状态命令通过沙箱外执行成功。
- 上游 API 与 clone 当前提交一致；网页缓存清单已过时，数量以固定提交 `git ls-tree` 为准。
- Work：报告已完成初稿；2,088 文件、90 SKILL、61 manifest、39 auth config、7 package。61/90 匹配运行时文本标记，仅作静态线索。
- T1/T2/T3 已完成。实际测试：`test-claude-codex-skill-projection-boundary.js` PASS；`test-runtime-capability-router.js` 19 PASS。没有生成正式插件投影或执行上游代码。
- Review 回修：E4 源码 anchor 从越界 L76 修正至 L63；18 个固定提交 source permalink 的文件与行号检查通过。
- Product challenge：C3 整体 hard-reject 修订为方法 backlog；固定 manager 拓扑仍拒绝。统一 schema / coverage / 一次有界重试可以落在现有 Work，不新增控制面。报告最终计数将为 5 借鉴 + 3 hard-reject + 3 cross-ref。
- T4 终审：product-lens / coherence / feasibility 均 PASS；分别提交实际检查文件清单。额外修订：C8 去除“待挑战”；61/90 说明 case-insensitive 与 `Muse.` 自然语言误命中；C10 精确区分 query 与 save/learning 参数拒绝边界。
- 终稿计数实测：11 = 5 借鉴（P1 1、P2 2、backlog 2）+ 3 hard-reject + 3 cross-ref；17 个本地落点全部存在。
- T5/Compound：目标 solution 去重无命中，新增 `docs/solutions/2026-10-09-muse-skills-eval.md` 决策摘要；全文源证据保留在研究报告。
- `node scripts/test-sync-solution-index.js`：22 PASS / 0 FAIL；`node scripts/sync-solution-index.js --all` 成功，canonical index 新增一条、CLAUDE 受管有界区块更新，AGENTS 未变；没有 Obsidian/外部同步。
- Solution index: updated 64 entries -> docs/solutions/index.jsonl; Claude projection: updated; AGENTS projection: disabled
- Learning candidates: proposed 0; needs-review 0; evaluated 0; shadow 0; approve/promote: not run
- 当前交付仅研究和本地决策文档；未安装、未改产品/运行时代码、未提交或推送。沙箱环境故障已绕开，不存在未解决的研究阻塞。
