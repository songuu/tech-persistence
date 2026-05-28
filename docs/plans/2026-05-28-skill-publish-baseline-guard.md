---
title: "B3 基线护栏下沉：skill publish 退化发布确定性拒绝"
type: sprint
status: completed
created: "2026-05-28"
updated: "2026-05-28"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
tags: [sprint, enforcement, self-evolution, skill-evolution]
aliases: ["B3 基线护栏", "skill-publish-guard"]

# === Anti-Drift 扩展字段 ===
invariants:
  - "guard fail-open 永不锁死 publish：(1) try-catch 内部异常 exit 0 + [skill-guard] fail-open: marker；(2) 用户可在 publish 协议层跳过；(3) node 缺失 → 无 enforcement 但也无阻塞（publish 不依赖 git commit，与 pre-commit 的 sh-wrapper 第 3 层语义不同）"
  - "无 result 文件或无前一版基线时 guard exit 0 放行（向后兼容当前全空的 skill-evals）"
  - "eval-result 数据文件不可被 skill 自身修改（沿用 skill-eval 护城河）"
  - "双 runtime 副本 sha256 一致（LF-normalize 后比对）"
invariant_tests:
  - scripts/smoke-skill-publish-guard.js
  - "node scripts/run-tests.js --grep skill"
deferred: []
deadcode_until: []
---

# B3 基线护栏下沉：skill publish 退化发布确定性拒绝

> **来源**：[[2026-05-28-two-layer-architecture-enhancement]] §B3。设计文档 status: proposed，本 sprint 落地。
> **[[ADR-013]] 活案例**：协议层"eval ≥ 当前版本才能发布"已存在（`skill-publish.md` 步骤 1 + 安全段），下沉为确定性 enforcement。

---

## Phase 1: 需求分析（Think）

### Scope
- skill publish 退化发布（新版 eval 通过率 < 旧版）从"靠 LLM 遵守协议"下沉为"脚本确定性 exit 2 拒绝"。
- 补齐前置缺口：eval result 当前无结构化格式（仅 LLM markdown 表格），先定义结构化存储。

### Non-scope
- 不改 skill 进化的 LLM 协议本质（diagnose/improve 仍 LLM 驱动）。
- 不引入 GEPA / Pareto 自动搜索（B1 范畴）。
- 不做 trace→eval 自动沉淀（B2 范畴）。
- 不引入 server/DB/向量库。

### Success（EARS-lite）
- WHEN 用户跑 `/skill publish <name>` 且新版 eval 通过率 < 旧版（超 tolerance），THE SYSTEM SHALL 通过 guard 脚本 exit 2 拒绝并打印具体退化数据 + 修复路径。
- WHEN skill 无 result 文件或仅有一版基线，THE SYSTEM SHALL exit 0 放行（无可比对基线不阻塞）。
- WHEN guard 脚本内部异常（数据损坏 / node 缺失），THE SYSTEM SHALL fail-open（exit 0 + stderr marker），不锁死 publish。

### Risks
- eval 通过率 flaky → 加 tolerance 阈值（默认允许新版 ≥ 旧版 - tolerance）。
- 给当前全空的 skill-evals 建 enforcement = 前瞻建设；靠"无基线放行"保证零误拒启动（[[ADR-013]]§B 边界产物：当前态全空必须放行）。
- skill 进化链首次引入 deterministic gate，需新 ADR 记录。

---

## Phase 2: 技术方案（Plan）

### 关键假设验证（[[ADR-012]]）

| 假设 | 验证文件 | 实际 | 可信度 |
|------|---------|------|--------|
| enforcement 入口是 pre-commit | `scripts/pre-commit-check.js`（git-staged 驱动） | **推翻**：publish 改 runtime 目录不产生 commit，须独立 guard | 已勘察 |
| eval result 已有可读通过率 | `skill-eval.md` / `skill.md` | **推翻**：无结构化格式，仅 LLM markdown 表格；`/skill` 明示"无 deterministic backing 代码" | 已勘察 |
| 协议已要求 eval ≥ 旧版 | `skill-publish.md` 步骤 1 + 安全段 | 成立 ✓ | 已勘察 |
| result 路径 | `skill-eval.md:42` | `~/.claude/homunculus/skill-evals/{name}/results/`（runtime，非 git） | 已勘察 |
| 新 lib 自动进双 runtime | `build-codex-plugin.js:191 copyHookLibs` | glob 复制全部 `scripts/lib/*.js` → 自动 ✓ | 已勘察 |
| guard CLI 需手动加 build 清单 | `build-codex-plugin.js:387 copyUtilityScripts` | 硬编码列表，须手动加 guard | 已勘察 |

### 入场扫描 - Invariants 继承

| 子系统 | 既有 invariant | 本 sprint 如何保持 |
|--------|---------------|--------------------|
| pre-commit enforcement | 3 层 fail-open + 派生具体 fix 命令 + LF-normalize sha256 | guard 复用同套模式 |
| hook exit codes | 0 fail-open / 1 非阻塞 / 2 阻塞 validator | guard 是 validator：退化 exit 2，内部错 exit 0 marker |
| 多副本同步 | git tracked 派生文件靠 propagate + build 同步 | 命令文档走 propagate；guard 走 copyUtilityScripts |
| skill eval 护城河 | eval 不可被 skill 修改 | result 数据文件沿用此约束 |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| eval 完成 | `/skill eval` LLM 调 record CLI | skill-eval-results.js | ✅ results.jsonl | ✅ guard 可读 |
| publish 前 | `/skill publish` LLM 调 guard | skill-publish-guard.js | — | ✅ exit code 决定是否继续 |

无 ❌ 链路。

### 入场扫描 - 债务清单
无上游 deferred 议题。

### 架构设计

```
/skill eval <name>  (LLM)
  └─ 跑完通过率 → node scripts/lib/skill-eval-results.js record \
                    --name <name> --version <N> --pass-rate <0..1>
                  → 追加 ~/.claude/homunculus/skill-evals/<name>/results/results.jsonl

/skill publish <name>  (LLM)
  └─ 执行步骤 1 前置 → node scripts/skill-publish-guard.js <name>
       ├─ readLatestTwo → checkRegression(tolerance)
       ├─ 退化(curr < prev - tol) → exit 2 + 退化数据 + fix 路径 → publish 中止
       ├─ 无 result / 仅一版 → exit 0 放行
       └─ 内部异常 → exit 0 + stderr "[skill-guard] fail-open: ..."
```

分层：核心逻辑在 `scripts/lib/skill-eval-results.js`（导出 `recordResult` / `readLatestTwo` / `checkRegression`，自动进双 runtime lib）；`scripts/skill-publish-guard.js` 为薄 CLI wrapper（argv + exit policy + fail-open）。

### 任务拆解

| Task | 等级 | 内容 | 验证 |
|------|------|------|------|
| T1 | L2 | `scripts/lib/skill-eval-results.js`：`recordResult` / `readLatestTwo` / `checkRegression(tolerance)`；results.jsonl 追加式；runtime 路径走 `runtime-paths.js` | `scripts/test-skill-eval-results.js` 单测 |
| T2 | L3 | `scripts/skill-publish-guard.js` CLI wrapper：退化 exit 2 + 派生具体 fix；无基线 exit 0；3 层 fail-open + stderr marker；CLI usage 错 exit 2 | 单测（覆盖 4 类退出路径） |
| T3 | L1 | 文档：`skill-eval.md`+`skill.md` 加 record 步骤；`skill-publish.md`+`skill.md`(publish/auto) 加 guard 前置；说明 exit 2 = 中止 | grep 校验文档含命令 |
| T4 | L2 | `scripts/smoke-skill-publish-guard.js` 四类（pass / break-test 退化必 fail / break-impl 无基线放行 / fail-open marker）+ `run-tests.js` 集成 | smoke 全绿 + 负样本验证 |
| T5 | L2 | 双 runtime 同步：`copyUtilityScripts` 加 guard、`install.sh`/`install.ps1` 分发 guard、propagate 命令文档、build+validate+pre-commit | validate-codex-plugin pass + pre-commit pass |
| T6 | L1 | 文档同步（CLAUDE.md 强制）：设计文档 B3 标 implemented + 变更日志、README 命令表/知识层、新 ADR（skill 链首个 deterministic gate）、solution doc + sync-solution-index | pre-commit checkSolutionIndexSync pass |

### 验证策略
- 每 Task 跑 `invariant_tests` 列表（smoke + run-tests grep skill）。
- T2/T4 必做负样本：造退化数据 → guard 必 exit 2；恢复 → exit 0（[[ADR-013]]§B）。
- T5 后全量：`node plugins/tech-persistence/scripts/build-codex-plugin.js && node scripts/validate-codex-plugin.js && node scripts/pre-commit-check.js`。

---

## Phase 3: 实现记录（Work）

| Task | 状态 | 产物 | 验证 |
|------|------|------|------|
| T1 | ✅ | `scripts/lib/skill-eval-results.js`（record/readLatestTwo/checkRegression）+ test | 9/9 pass |
| T2 | ✅ | `scripts/skill-eval-results.js` CLI（record+guard）+ test | 10/10 pass（含 fail-open marker + 退化 exit2 负样本）|
| T3 | ✅ | skill-eval.md / skill-publish.md / skill.md 加 record + guard 步骤 | grep 校验含命令 |
| T4 | ✅ | smoke 合并入端到端 test（[[ADR-013]]§B 四类齐）+ run-tests 集成 | run-tests --grep skill：2 文件 19/19 |
| T5 | ✅ | build copyUtilityScripts +CLI；propagate 3 命令；lib+CLI 双副本 | validate pass，CLI sha match，全量 14/14 |
| T6 | ✅ | 设计文档 B3 标 implemented、[[ADR-016]]、README、solution + index | sync indexed 29，pre-commit pass |

设计决策偏离（均经勘察验证）：
- enforcement 入口 pre-commit → 独立 guard CLI（publish 不产生 git commit）
- record + guard 合并单 CLI（YAGNI）
- smoke 合并入 test-skill-publish-guard.js（端到端已覆盖四类，独立 smoke 重复）

## Phase 4: 审查结果（Review）

风险等级：L2-L3（新增脚本 + 改协议文档，无认证/支付/数据）。risk-aware dispatch：correctness + security + 第 6 视角。

**P0**：无。

**P1（2，均为已知限制，非代码缺陷）**：
- P1-a：invariant "3 层 fail-open" 第 3 层（node 缺失兜底）继承自 pre-commit 的 sh-wrapper 模式，但 guard 是 `/skill publish` 内 LLM 跑的 bash，无 sh wrapper 层。实际语义为"node 缺失 → 无 enforcement 但也无阻塞"（publish 不依赖 commit）。**已修**：invariant 措辞精确化（见 frontmatter）。
- P1-b：enforcement 只下沉后半段（guard）；record 写入仍 LLM 协议——若 LLM 跑 `/skill eval` 不调 record，`results.jsonl` 空 → guard 永远 no-baseline 空转。属 LLM-only 子系统固有边界（eval 打分本质是语义判断，无法纯脚本化），已用文档强措辞"必须 record"缓解。记为已知限制（[[ADR-013]] 半下沉漂移的可接受案例）。

**第 6 视角（集成连续性）**：未破坏前 sprint invariant（纯新增，未动 hook/memory/orchestrator）；无 dead code（guard←skill-publish.md 步 0 / lib←CLI+test / recordResult←skill-eval.md record）；集成链闭环（eval-result 格式定义 → guard 消费）。

## Phase 5: 复利记录（Compound）

- **新 ADR**：[[ADR-016]] — enforcement 入口按"动作是否产生 git commit"选址；skill 进化链首个 deterministic gate。
- **新 solution**：[[2026-05-28-skill-publish-baseline-guard]]。
- **候选本能**：
  - `enforcement-entry-by-commit-boundary`（🟢 0.75）：下沉 enforcement 前先问"被守护动作的副作用落 git tree 还是 runtime dir"——后者必须挂动作流程内 guard，pre-commit 守不到。
  - `llm-only-subsystem-partial-enforcement`（🟡 0.6）：给 LLM-only 子系统加 deterministic gate 时，能下沉的是"可确定性判定的环节"（退化比对），语义判定环节（eval 打分）仍 LLM；接受半下沉 + 强文档措辞缓解。
- **复用验证**：[[ADR-012]] 勘察一次性挡住 2 个错误假设（pre-commit 入口 + result 格式），避免 work 阶段返工——勘察 ROI 再次为正。

## Related
- [[2026-05-28-two-layer-architecture-enhancement]] — B3 设计来源
- [[ADR-013]] — mechanism over discipline（本 sprint 框架）
- [[ADR-012]] — plan 必须勘察（已推翻原设计 2 假设）
- [[hook-exit-codes]] — guard exit policy

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-05-28 | 初版 plan：勘察推翻原设计 2 假设（enforcement 入口 + result 格式），scope 修正为完整自包含 6 task。status: planning |
