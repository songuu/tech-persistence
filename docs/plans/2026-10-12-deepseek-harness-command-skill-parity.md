---
type: sprint
status: completed
phase: compound
date: 2026-10-12
runtime: codex
mode: auto
tasks_total: 8
tasks_completed: 8
tags: [sprint, deepseek, harness, commands, skills, runtime]
---

# DeepSeek Harness 命令与 Skill 架构接入

## 用户目标

把 Tech Persistence 当前受管架构应用到现有 Harness 应用，使 DeepSeek 运行路径能够发现并调用项目提供的全部 commands 与 skills，并保持现有权限、状态、验证和双运行时权威边界。

## Think：要做 / 不做

要做：

- 以仓库现有 Harness web/task worker、agent orchestrator、OpenAI-compatible DeepSeek 路径和插件生成体系为真实落点。
- 为 DeepSeek Harness 建立受管 command/skill inventory、确定性解析、渐进加载、能力检查和安全执行边界。
- 复用 canonical `user-level/`、`codex-native/` 与现有生成/校验流程，避免复制出第三套手工维护规范。
- 提供安装或运行时装配入口、回归测试、故障上下文和可重复验收证据。

不做：

- 不把 DeepSeek 提升为新的 Sprint、Acceptance、Transcript 或 learning 状态 owner。
- 不把“全部可发现、可正确路由”夸大为第三方连接器、外部账号或缺失宿主能力均已可用；能力缺失必须显式失败。
- 不在仓库写入 API key、生产凭据或服务端私密配置。
- 不提交、推送或自动部署生产环境；生产发布需在本地资格证据通过后单独核对当前目标环境。

## 可观察成功标准

1. WHEN Harness 接收 `/command` 或显式 skill 调用，THE SYSTEM SHALL 从受管 inventory 确定性解析到唯一 canonical artifact，并拒绝未知、冲突、路径逃逸或生成漂移。
2. WHEN DeepSeek 执行需要仓库读写或命令能力的 skill，THE SYSTEM SHALL 通过现有受控 provider/tool 边界完成调用，保留任务、权限、副作用和验证证据；能力不足时失败闭合并给出具体缺口。
3. WHEN commands/skills 的权威源发生变化，THE SYSTEM SHALL 通过单一生成流程更新 DeepSeek Harness bundle，并由校验器证明 inventory 完整、无 extra/missing、内容 hash 一致。
4. WHEN Harness 运行普通任务、命令任务和 skill 任务，THE SYSTEM SHALL 保持现有 authority/provider OS 隔离、Acceptance/Transcript owner 和恢复语义，不允许模型响应直接伪造完成。
5. WHEN 执行验收，THE SYSTEM SHALL 通过 focused unit/integration、生成投影校验、负向权限/路径测试和受控 Harness E2E；没有真实 DeepSeek 凭据时只把 live provider 资格标为未验证。

## 风险、假设与待确认项

- 已验证：当前 DeepSeek 只经 `openai-compatible-chat` 进入 spec/review 只读路径；implementation writer 仍由 Codex 承担，外部 transport 明确没有 tools 或写权限。
- 已验证：Harness task worker 固定装配 `external-stages=spec,review` 与 `codexCommandPath`，现有实现没有 command/skill 调度层。
- 假设：用户所称“DeepSeek Harness 应用”指本仓库现有 Harness web/task runtime 及其 DeepSeek OpenAI-compatible provider，而不是另一个未提供源码的应用。
- 解释：“所有 commands/skills 正常使用”指全部受管条目可发现、可路由、可按声明能力运行；依赖外部 App、登录或专用 UI 的条目在缺能力时返回明确阻塞，不伪造成功。
- 高风险点：第三 provider 投影漂移、模型驱动工具调用越权、writer ownership 重复、生产配置兼容和 live 模型结构化输出稳定性。

## 关键假设验证（ADR-012）

| 假设 | 验证方式 | 实际发现 | 处置 |
|---|---|---|---|
| “DeepSeek Harness 应用”指仓库中的 Harness web/task worker | 初版按仓库代码定位；随后读取用户提供的桌面应用截图、运行中的 `DeepSeek Harness.exe`、`app.asar` 包清单和本机 DSH 配置 | **假设被用户纠正并推翻**；用户目标是 DeepSeek Harness 桌面应用的 `/` 技能目录。本计划已完成的 task-worker 接入保留为独立服务端能力，但不能冒充桌面应用交付 | 新增桌面原生投影路径，并在 README 明确区分两条链路 |
| 桌面应用需要修改 Electron UI 才能展示 TP 技能 | 读取已安装 `@deepseek-ai/dsh-skill-filesystem` 文档与配置，核对根目录、frontmatter、优先级和 watcher 行为 | 假设被推翻；应用原生扫描项目/用户 `.dsh/skills` 与 `.agents/skills`，有效 `<name>/SKILL.md` 可直接进入目录 | 使用 `~/.dsh/skills`，不修改 `app.asar` |
| 只复制 `SKILL.md` 就足以支持全部调用 | 检查 33 个 `plugins/tech-persistence/codex-skills` bundle 及 `sprint/runtime` 等相对资源 | 假设被推翻；必须投影完整 bundle，并验证 inventory、frontmatter 和整树 hash | `deepseek-harness-skill-projection.js` 事务性复制完整目录 |
| 安装后即可证明所有外部能力可用 | 对照 DSH skill loader 与 TP skill 中的 MCP、账号、网络、UI、hook 依赖 | 不成立；已验证的是 33 个技能可发现、可加载且投影 hash 一致，外部 capability 仍须由当前 Harness 工具和权限逐项满足 | 缺能力显式失败；模型负载/API 500 单独报告 |

## 路由与下一步

route: `architectural-like`。原因：新增 Harness 宿主投影与运行时 command/skill 调度，跨生成器、provider、worker、权限和测试边界。下一步进入 Plan，建立同一计划内的设计 authority、任务依赖和风险分级验证。

<!-- design-authority:start -->
## Design Authority（shadow）

- 问题与用户价值：现有 Harness 的 DeepSeek 模型由 Codex CLI agent runtime 托管，但隔离 provider home 没有安装 Tech Persistence plugin；外部 DeepSeek transport 又被有意限制为无 tools 的只读 spec/review。因此 DeepSeek 可以完成结构化模型调用，却不能在 Harness 任务中可靠发现和执行 TP commands/skills。用户需要在保留现有安全、状态和审计边界的前提下使用完整工作流。
- 范围 / 非目标：范围包括受管 inventory、离线 plugin bootstrap、`/command` 与 `$skill` 顶层解析、orchestrator 的精确 invocation 传递、worker/resume 装配、部署模板和回归证据。非目标包括新建 DeepSeek 原生工具循环、放宽外部只读 transport 为 writer、改变 Acceptance/Transcript authority、写入密钥或直接发布生产。
- 备选方案、选择与理由：
  - A. 为 OpenAI-compatible DeepSeek 新造 shell/file/tool loop：拒绝。它复制 Codex agent runtime，并扩大工具安全面、恢复状态和 transcript owner。
  - B. 只把 `SKILL.md` 复制到 provider home：拒绝。它缺 plugin scripts、MCP、hooks、相对资源与完整 inventory 校验，只能形成表面可发现。
  - C. 在现有 bwrap/provider identity 内，从 root-owned immutable release 离线安装完整 Codex plugin，并让 Codex CLI 继续作为工具宿主、DeepSeek 只作为 broker 后模型：采用。它复用现有工具、结构化输出、workspace-write、OS 隔离和任务证据边界。
- 组件、消费者接口、状态与错误路径：
  - `managed-plugin-inventory` 成为 commands/base skills/Codex skill union 的唯一 inventory owner；Claude/Codex plugin builder、validator 和 Harness parser 共同消费。
  - `harness-managed-invocation` 只解析首个非空输入的 `/command` 或 `$skill`，兼容显式 `tech-persistence:` 命名空间；`/` 仅接受 command inventory，`$` 接受完整 Codex skill inventory，并统一规范化为真实 `$tech-persistence:name` 入口。未知、歧义、控制字符与 managed 输入超限在 provider dispatch 前失败。
  - provider bootstrap 在每次新执行或 resume 前重建 task-local Codex 配置，从 `/runtime` 本地 marketplace 安装并启用 immutable plugin；不联网、不读宿主用户配置，验证实际安装 inventory 后才启动 Codex。
  - Codex CLI 保持 DeepSeek broker model、bwrap、provider UID/GID、workspace-only 写入和 `--ephemeral`。受信 bootstrap 生成的 task-local config 取代 `--ignore-user-config`；项目 rules 仍按现有 `--ignore-rules` 策略禁用。
  - orchestrator 仍拥有 run state；DeepSeek external spec/review 仍只读。命令/skill invocation 作为 authority 生成的结构化约束进入 spec 与 implementation prompt，原文和规范化形式均留在 run evidence，模型不得改名或吞掉参数。
  - skill 自身需要宿主不存在的 App、登录、网络或 UI 时，按 capability 缺失失败闭合；“可调用”不等于外部依赖已配置。
- Acceptance Criteria：
  - AC-1: WHEN Harness 接收 `/command` 或 `$skill` 顶层调用，THE SYSTEM SHALL 通过单一受管 inventory 解析唯一目标并保留参数；未知、冲突、路径逃逸、控制字符或 inventory 漂移必须在 provider dispatch 前拒绝。
  - AC-2: WHEN 隔离 provider 启动或恢复 DeepSeek-backed Codex 任务，THE SYSTEM SHALL 仅从 root-owned immutable runtime 离线装配完整 Tech Persistence plugin，并在 plugin inventory 读回一致后才允许模型运行。
  - AC-3: WHEN managed invocation 进入 agent orchestrator，THE SYSTEM SHALL 把规范化调用作为不可由 spec/review 改写的结构化约束传到 implementation provider，并把原始输入、目标和证据路径关联到同一 run。
  - AC-4: WHEN command/skill 执行请求文件、命令或写入能力，THE SYSTEM SHALL 复用现有 Codex tool host、bwrap、provider identity、workspace boundary、Acceptance 与 Transcript owner；缺失能力必须返回具体阻塞而非伪造成功。
  - AC-5: WHEN canonical command/skill inventory 变化，THE SYSTEM SHALL 使 Claude projection、Codex projection、Harness bootstrap 与 validator 由同一来源更新，并以 missing/extra/hash/重复名测试失败闭合。
  - AC-6: WHEN 本次实现交付，THE SYSTEM SHALL 通过 parser/bootstrap/prompt/worker focused tests、plugin projection validator、Harness recovery 回归和全量基线；真实 DeepSeek live qualification 未执行时必须单独标为未知。
<!-- design-authority:end -->

<!-- acceptance-contract:start -->
- [x] AC-1: WHEN Harness 接收 `/command` 或 `$skill` 顶层调用，THE SYSTEM SHALL 通过单一受管 inventory 解析唯一目标并保留参数；未知、冲突、路径逃逸、控制字符或 inventory 漂移必须在 provider dispatch 前拒绝。
- [x] AC-2: WHEN 隔离 provider 启动或恢复 DeepSeek-backed Codex 任务，THE SYSTEM SHALL 仅从 root-owned immutable runtime 离线装配完整 Tech Persistence plugin，并在 plugin inventory 读回一致后才允许模型运行。
- [x] AC-3: WHEN managed invocation 进入 agent orchestrator，THE SYSTEM SHALL 把规范化调用作为不可由 spec/review 改写的结构化约束传到 implementation provider，并把原始输入、目标和证据路径关联到同一 run。
- [x] AC-4: WHEN command/skill 执行请求文件、命令或写入能力，THE SYSTEM SHALL 复用现有 Codex tool host、bwrap、provider identity、workspace boundary、Acceptance 与 Transcript owner；缺失能力必须返回具体阻塞而非伪造成功。
- [x] AC-5: WHEN canonical command/skill inventory 变化，THE SYSTEM SHALL 使 Claude projection、Codex projection、Harness bootstrap 与 validator 由同一来源更新，并以 missing/extra/hash/重复名测试失败闭合。
- [x] AC-6: WHEN 本次实现交付，THE SYSTEM SHALL 通过 parser/bootstrap/prompt/worker focused tests、plugin projection validator、Harness recovery 回归和全量基线；真实 DeepSeek live qualification 未执行时必须单独标为未知。
<!-- acceptance-contract:end -->

## Before / After 契约

| 消费者 | Before | After | 一致性证据 |
|---|---|---|---|
| Claude plugin projection | builder 内部私有 commands/skills 数组 | 读取共享 inventory；产物语义不变 | 现有 projection boundary + inventory tests |
| Codex plugin projection | commands 包装为 skills，完整 bundle 已生成 | 同一产物，同时成为 Harness 的 immutable plugin source | plugin validator、hash/readback |
| Harness task API | requirement 为不透明文本 | API schema 不变；仅 worker 在 authority 边界识别顶层 managed invocation | task-service tests 保持兼容 |
| Harness task worker | 所有任务直接进入通用 orchestrator | 普通任务不变；合法 invocation 增加 authority-owned metadata，未知 invocation dispatch 前失败 | worker unit/recovery tests |
| Agent orchestrator | spec 可重述原始 requirement | invocation metadata 冻结目标和参数；spec/review 不能改名 | prompt/normalization tests |
| DeepSeek-backed Codex provider | 空 provider home、`--ignore-user-config`、无 TP plugin | 每次启动从 `/runtime` 离线安装受管 plugin，读取受控 task-local config | bootstrap fake CLI + bwrap contract tests |
| External DeepSeek spec/review | OpenAI-compatible、无 tools、只读 | 保持不变 | runtime routing regression |
| 部署模板 | 只验证 runtime/Codex/broker | 额外验证 plugin source、CLI plugin capability 与 bootstrap readback | deploy contract/static tests |

## 有序任务

| Task | 目标 / 文件集合 | 依赖 | 风险 | 完成证据 |
|---|---|---|---|---|
| T1 | 抽取共享 inventory owner；`scripts/lib/managed-plugin-inventory.js`、plugin builder、validator 与 projection tests | 无 | L2 | 现有 Claude/Codex bytes 不漂移；重复/missing/extra 负测 |
| T2 | TDD 实现 managed invocation parser；`scripts/harness-managed-invocation.js`、新测试 | T1 | L2 | `/command`、`$skill`、参数、多行、未知/控制字符/超限回归 |
| T3 | TDD 实现 task-local plugin bootstrap；新 bootstrap 模块、`codex-task-bwrap-entrypoint.sh`、manifest/readback 测试 | T1 | L3 | fake Codex plugin CLI、symlink/path/hash/非零退出/幂等与 resume 重建 |
| T4 | 把 invocation metadata 送入 frozen prompts/evidence；`agent-orchestrator.js` 及模块化 helper、focused tests | T2 | L3 | spec/implementation 精确目标、普通任务零变化、模型改写不覆盖 authority 值 |
| T5 | worker 新执行与 resume 接线；`harness-task-worker.js`、worker tests | T2,T3,T4 | L4 | dispatch 前拒绝、同一 task evidence、恢复路径、资源/取消/失败分类不回归 |
| T6 | 更新 bwrap/release/deploy 静态契约和运维说明；deploy scripts、相关 tests/docs | T3,T5 | L3 | immutable `/runtime`、plugin capability preflight、回滚到旧 release |
| T7 | 风险匹配验证与缺陷回修；focused suites、plugin validator、Harness/agent-orchestrator 基线、全量 `npm test` | T1–T6 | L3 | 命令、退出码、失败集合与环境阻塞分开记录 |
| T8 | 独立代码审查、安全/架构复核、文档终态与 Sprint closeout | T7 | L2 | findings 关闭、AC 全部核验、solution/索引按证据更新 |

任务共享 builder、worker 和 orchestrator 热点，全部串行；本计划不标 `[P]`。

## 测试策略

1. Red：先为 T1/T2/T3/T4/T5 分别写能证明当前缺口的失败测试。
2. Green：最小实现后运行对应单文件测试；不得用 mock 的“进程退出 0”替代 inventory/readback/evidence 断言。
3. Contract：运行 skill projection、plugin validator、provider adapter/runtime capability、Harness task worker/recovery、deploy contract。
4. Regression：运行 `npm test`；若存在已知基线失败，按失败文件集合与本次 focused 结果区分，不宣称全绿。
5. Live：仅在当前环境已提供受权 DeepSeek broker/模型和隔离 Linux runtime 时执行受控 E2E；否则保留 `liveQualification=unknown`，本地 mock/schema 通过不等于生产完成。

## 风险、回滚与 gate

- T5 涉及认证后任务执行与 provider 安全边界，按 L4 处理；`--auto` 可完成本地代码和测试，但不能自动切换生产 release 或消费真实模型费用。
- 回滚单位是 immutable Harness release：旧 worker config/current symlink 不改；新代码不改变数据库 schema。部署失败回到上一 release，并保留失败 task/run evidence。
- plugin bootstrap 禁止网络 marketplace、宿主用户配置和 provider workspace plugin source；只接受 release 内 canonical realpath。
- 官方 OpenAI 文档确认 plugin 以 manifest + skills/MCP 组成，local marketplace 与 installed cache 分离；实现必须使用受支持的本地 plugin CLI，不手写私有 cache 状态。
- 当前未知：生产固定 Codex 0.152.1 的 plugin CLI 与本机 0.162.1 是否完全一致；T3/T6 必须把 capability preflight 变成显式部署门。

## Plan inline 检查

- placeholder：无占位路径、假命令或待填字段。
- 内部一致性：单一 inventory owner、单一 run/Acceptance/Transcript owner；external DeepSeek 仍只读，writer 仍为 Codex tool host。
- scope：只修改 Harness/runtime/plugin projection；不扩展数据库 schema、登录、外部连接器或生产发布。
- 歧义：`/name` 定义为 command，`$name` 定义为完整 skill；两者都兼容显式 `tech-persistence:` 命名空间并规范化为 `$tech-persistence:name`；自然语言请求保持普通 requirement，不做模糊模型分类。

## 阶段记录

- 2026-10-12：从原始 Codex 会话记录恢复旧 completion 所需计划，SHA-256 与完成记录一致；状态回到 `completed-sprint`，未绕过 Sprint CLI。
- 2026-10-12：读取项目 standards manifest 及 base/agent/infrastructure 规则；核对当前 DeepSeek 路径、Harness worker、provider adapter 与历史资格边界。
- Think 验收：目标、非目标、五项可观察标准、能力缺失语义和 `architectural-like` 路由已收敛；没有需要暂停的开放产品决策。
- Plan 证据：官方 OpenAI plugin packaging 文档与本机 Codex CLI 0.162.1 均支持 local marketplace/plugin CLI；生产模板固定 0.152.1，故保留版本 capability gate，不假定线上兼容。
- Plan 验收：Design Authority、AC-1..AC-6、Before/After 契约、T1..T8 依赖、L4 风险与回滚 gate 已回读；无未解析 placeholder 或开放产品决策。Sprint pointer 已通过 CAS 推进到 `work`。
- Work T1-T6：已建立单一 managed inventory、`/command`/`$skill` 解析与 `$tech-persistence:name` 规范化、task-local plugin bootstrap、orchestrator/worker authority metadata、bwrap/deploy capability gate 和运维文档；普通超长自然语言保持原路径，managed 输入未知/非法/控制字符/超限均在 dispatch 前失败。
- Work 安全回修：独立检查发现无命名空间 canonical invocation、plugin list 字符串包含校验和 runtime 内部链接预检不足；均已增加负向测试并修复。真实 Codex 0.162.1 隔离安装/readback 通过，receipt 绑定 inventory SHA 与整树 SHA。
- Work T7 focused：parser/bootstrap/orchestrator/worker、plugin validator、Claude/Codex projection、原子构建 38/38、Harness recovery、runtime governance、provider registry/router 19/19、orchestrator native CLI 均通过；插件发布曾遇 Windows `EBUSY`，使用受管 `--recover` 恢复后重试成功，恢复证据目录已清空。
- Work 全量：`npm test` 实跑 147 个文件，132 pass / 15 fail。12 个短路径相关失败文件在规范 `C:\Users\Administrator\AppData\Local\Temp` 下复跑 12/12 通过；剩余为未配置 live broker、既有 self-learning concurrency 锁竞争及 model-canary 135 秒子进程超时。Claude surface 预期新增 1 个受管 inventory 投影，冻结基线已更新并单独验证通过。
- Work 环境边界：当前 Windows WSL `bash.exe` 启动返回 `E_ACCESSDENIED`，无法本机执行 `bash -n`；shell 静态 wiring 回归通过。生产 Codex 0.152.1 与真实 DeepSeek/Linux live qualification 未执行，部署脚本会在 plugin CLI 或 `--dangerously-bypass-hook-trust` 缺失时失败闭合。
- Review finding R1（high，已退回 Work 修复）：初版在模型 bwrap 内把 plugin 与 receipt 写入 provider 可写挂载，同一 provider 可篡改 hooks/MCP/skills 或事后 receipt。修复为独立 setup bwrap（无网络、无 workspace、stdin 断开）先安装，再由主 bwrap 对 plugin/config/internal receipt/public receipt 做只读子挂载；qualification 使用 `verify` 模式独立重算 installed inventory、source/install tree SHA 并核对 receipt。新增篡改 receipt、篡改 installed tree 与只读挂载契约测试。
- R1 回归证据：真实 Codex 0.162.1 bootstrap + public receipt + 独立 verify 通过；bootstrap unit、Harness wiring、worker 34 pass/3 skip、Harness recovery、external runtime governance、plugin validator 通过。resume setup 额外清除 direct skills/agents/AGENTS/hooks 等执行控制面残留并保留 sessions；Linux `bash -n` 因本机 WSL 缺少 `/bin/bash` 未执行，静态 shell 契约通过。
- Review 终态：R1 已关闭；第二轮 findings-first 审查未发现新的可操作问题。AC-1..AC-6 已按 focused、真实本机 plugin CLI、投影/恢复/路由回归及全量失败拆因核验；生产 Codex 0.152.1、Linux bwrap 与真实 DeepSeek live qualification 继续保持明确 unknown，不作为已验证事实。
- Compound：新增 `docs/solutions/2026-10-12-deepseek-harness-immutable-plugin-bootstrap.md`，只沉淀本次已验证的模型前 setup bwrap、模型期只读执行控制面、authority-owned invocation 与事后独立复验边界；未改动产品代码，未创建或晋级行为学习候选。
- Compound 验证：`node scripts/sync-solution-index.js --all` 索引 64 篇 solution；`node scripts/test-sync-solution-index.js` 22/22、`node scripts/test-memory-search.js` 28/28 通过；`AGENTS.md` 无差异。
- Solution index: updated 64 entries -> docs/solutions/index.jsonl; Claude projection: updated; AGENTS projection: disabled
- Learning candidates: proposed 0; needs-review 0; evaluated 0; shadow 0; approve/promote: not run
