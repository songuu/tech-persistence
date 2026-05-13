---
title: "Sprint 完成度校验（C7 / Plan Completion Verify）"
type: sprint
status: completed
created: "2026-05-13"
updated: "2026-05-13"
parent: "docs/plans/2026-05-12-gstack-latest-analysis.md"
candidate: C7
tags: [sprint, enforcement, pre-commit, adr-013, anti-drift]
aliases: ["c7-plan-completion-verify", "plan-completion-verify"]
---

# Sprint 完成度校验（C7 / Plan Completion Verify）

> 吸收 gstack `/ship` "extracts actionable items from any associated plan file
> and verifies each is addressed in the diff" 的内核。
> 解决本项目最强活跃本能 [[documented-claim-vs-code-reality-drift]]。

---

## 需求分析

### 要做

- 当 sprint plan 被 stage 且 frontmatter `type: sprint` + `status: completed`，
  pre-commit hook 验证：plan 中**勾选完成（`- [x]`）的 task 行内提到的 inline-code 路径**，
  在 `git log --since=<plan.filename-date>` 的 diff name-only **或 staged changes** 中
  **至少有 1 个出现过**。
- 校验失败 → exit 1，提示具体 task + 缺失路径 + 修复建议。
- grandfather：filename date < `2026-05-12` 自动跳过（复用 ADR-012 同一阈值）。

### 不做

- 不校验**研究类 sprint**（无 inline-code 路径 → 跳过，不视为失败）
- 不校验**未勾选 task**（仅检查"声称完成"的）
- 不校验**绝对路径匹配**（只要 changedFiles 中某条 `endsWith(taskPath)` 或反之，即视为命中）
- 不引入新依赖（继续只用 node stdlib + `git` shell）
- 不动 `propagate-command-changes.js` / plugin 副本（C7 是新增 checker，不改 transform）

### 成功标准

- [x] `checkPlanCompletion()` 在 `scripts/pre-commit-check.js` 落地
- [x] smoke S13a-f 6 个场景全过
- [x] **dogfood**：用本项目现有所有 `status: completed` sprint plan 跑一次，无误拒
- [x] hook 内部异常 fail-open 保持
- [x] 本 plan 自身被本 checker 检查时 pass（递归 dogfood）

### 风险和假设

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证 | 结果 | 可信度 |
|---|---|---|---|
| TEMPLATE 任务格式是 `- [x] **Task N**: ... — 文件: \`path\`` | Read TEMPLATE.md:36-38 | ✅ 确认 | high |
| 实际 sprint 多用 markdown table `\| # \| 任务 \| ... \| 涉及文件 \|` | Read 2026-05-12-followups-plan.md:50-57 | ✅ 确认 | high |
| `parseFrontmatter()` 已存在并 strip 引号 | Read pre-commit-check.js:238-255 | ✅ 确认 | high |
| `GRANDFATHER_BEFORE=2026-05-12` + `PLAN_PATH_RE` 已存在 | Read pre-commit-check.js:35-36 | ✅ 确认 | high |
| sprint.md Phase 5 写 `status: completed` | Read sprint.md 工作流文档 | ✅ 确认（不是 `done`）| high |
| smoke harness 12 scenarios 已运行通过 | Read smoke-pre-commit.js | ✅ 确认 | high |
| `git log --since=<date> --name-only --pretty=format:` 兼容 Windows git | 项目历史上多次使用 | ✅ 确认 | high |
| `--name-only --pretty=format:` 输出含空行需 filter | Stack Overflow / 本项目 ad-hoc 验证 | ✅ 确认 | high |
| inline-code 路径 regex `\`[^`\s][^`]*\.(ext)\`` 覆盖 .js/.ts/.md/.sh/.ps1/.json/.jsonl/.yml/.yaml/.toml | 主观枚举 | ⚠️ 验证：grep 现有 sprint 看遗漏 | medium |
| status 字段除 `completed` 外可能有 `done`？ | Read sprint.md / TEMPLATE.md | ✅ 仅 `completed`（不接受 `done`，避免 false positive 触发） | high |

**关键边界**：

1. **staged + log 合并**：`git log --since` 不含 staged，必须 + `git diff --cached --name-only` 才覆盖"plan 与代码同 commit landing"场景。
2. **fuzzy match**：`changedFiles.has(p)` 严格相等会漏 `./scripts/foo.js` vs `scripts/foo.js`；用 `endsWith` 双向 fallback。
3. **inline-code 路径必须以已知扩展名结尾**：避免误匹配命令 `\`node scripts/foo\`` 中的 `node`。
4. **plan 文件自身排除**：plan 本身是 staged，但 task 通常 mention 其他文件；不特殊处理（plan 自身路径不在 task 行的 inline code 中，自然不参与匹配）。
5. **`since` 取 filename date 而非 frontmatter `created`**：filename 是 path-regex 强制（[[filename-vs-frontmatter-metadata]]），更鲁棒。

---

## 技术方案

### 方案概述

在 `scripts/pre-commit-check.js` 新增 `checkPlanCompletion(stagedFiles, repoRoot)` checker，
集成入 `main()`。在 `scripts/smoke-pre-commit.js` 追加 S13a-f 6 个 scenario。

### 任务拆解

- [x] **Task 1**: 实现 `checkPlanCompletion()` — 文件: `scripts/pre-commit-check.js`
- [x] **Task 2**: 集成入 `main()` failures 收集 + 新增 `formatPlanCompletionError()` — 文件: `scripts/pre-commit-check.js`
- [x] **Task 3**: 新增 smoke S13a-f 6 个场景 — 文件: `scripts/smoke-pre-commit.js`
- [x] **Task 4**: 跑 `node scripts/smoke-pre-commit.js` 全 18 场景过
- [x] **Task 5**: dogfood — 对仓库所有现有 `status: completed` sprint 跑一次模拟检查，确认无误拒
- [x] **Task 6**: 更新 `CLAUDE.md` 索引段追加本 sprint 入口
- [x] **Task 7**: 本 plan `status: completed` + 复利记录

### 测试策略

- **smoke 18 场景**：原 12 + 新 6
- **dogfood**：跑模拟脚本，对 `2026-05-{07,09,11,12,13}` 区间所有 plan 跑一次，预期 0 失败（绝大多数 status 不是 completed，已 grandfather 的更早；剩下 status: completed 的必须自然 pass）
- **递归 dogfood**：本 plan 设为 status: completed 后 stage，pre-commit-check 自身必须 pass

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 现有 status:completed sprint 被误拒（dogfood blocker）| 中 | 高 | Task 5 dogfood；如发现误拒 → 调整 inline-code 正则或新增 escape 字段 |
| `git log --since` 在 Windows git 行为差异 | 低 | 中 | 用 `-c core.quotePath=false` 沿用同套 flag；smoke 跑通 |
| markdown table 形式的 task 行 regex 不匹配 | 高 | 中 | regex 同时支持 `- [x]` checkbox **和** `\| ✅ \|`/`\| 完成 \|` table 行（保留为 Task 1 实施时的 sub-decision） |
| fail-open 静默失效 | 低 | 高 | smoke S13a 必须断言 stderr 不含 fail-open marker |

### 涉及文件

- `scripts/pre-commit-check.js` (主)
- `scripts/smoke-pre-commit.js` (smoke)
- `CLAUDE.md` (索引)
- 本 plan 文档自身

---

## Dogfood 自检（ADR-013 §B：enforcement 提案必须 inline 自检）

**本方案是 enforcement 提案吗？** ✅ 是 — 新 pre-commit checker。

**边界产物枚举**（防止"启动第一天误拒合法存量"）：

1. 已 grandfather 的 plan（filename date < 2026-05-12）→ Task 5 dogfood 覆盖
2. status 不是 completed 的 plan（draft / planning / in-progress / reviewing）→ S13e 覆盖
3. type 不是 sprint 的 plan（type: plan / type: audit）→ S13d 覆盖
4. 有 checked task 但 task 行**无**inline-code 路径的 plan（研究类）→ S13c 覆盖
5. CRLF source（Windows editor 保存）→ frontmatter 解析已 LF-normalize ✅ 复用现有
6. handoff-{N} 文件（已在 `if (f.includes('-handoff-')) continue` 排除）→ 无新风险
7. 本 plan 自身：递归 dogfood → 必须 pass

**fail-open marker**：保持 `[pre-commit] hook 内部异常已忽略`。smoke S13a 必须 `assert(!stderr.match(fail-open-marker))`。

**已踩坑预防**：
- [[cross-platform-sha-needs-lf-normalize]] — frontmatter 解析复用现有 LF 兼容
- [[hooks/windows/shell-mismatch]] — 本 checker 是 node 进程内，不涉 hook command shell

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-13 | — | 初稿 + ADR-012 假设验证 + ADR-013 dogfood 自检 |
| 2026-05-13 | T1+T2 | `checkPlanCompletion()` + `formatPlanCompletionError()` + main 集成 + module.exports 暴露；regex 演进 2 轮（v1 `[^\`]*` → v2 `[^\`\s]+` 拒空格，避免 `\`node scripts/foo.js\`` 命令形式误匹配；新增 absolute/`~/` 路径过滤） |
| 2026-05-13 | T3 | smoke S13a-f 6 场景；fixture helper `planWithFrontmatter()` 内嵌 ≥100 字符的假设段，避免触发 plan-scope lint 污染 stderr |
| 2026-05-13 | T4 | 全 18 smoke 场景 pass（含原 S1-S12 + 新 S13a-f） |
| 2026-05-13 | T5 | dogfood 12 个现有 `status:completed` plan → 0 误拒；2 次 false-positive 由 T1+T2 regex 迭代解决 |
| 2026-05-13 | T6 | CLAUDE.md 解决方案索引追加 2026-05-13 enforcement 条目 |
| 2026-05-13 | T7 | plan status → completed + 递归 dogfood pass |

---

## 审查结果

<!-- /review 阶段填写 -->

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| P0-1 | correctness | `scripts/pre-commit-check.js`（实施中） | 初版 PATH_EXT_RE `\`[^\`\s][^\`]*\.(ext)\`` 允许路径内空白 → `\`node scripts/foo.js\`` 命令形式被误匹配，dogfood 暴露 1 个 FP | ✅ 已修（regex 改 `[^\`\s]+`）|
| P0-2 | correctness | `scripts/pre-commit-check.js`（实施中） | 初版未过滤 `~/` 与绝对路径 → `\`~/.claude/settings.json\`` 被纳入校验但不在 repo 内必然 miss，dogfood 暴露 1 个 FP | ✅ 已修（post-match 过滤 `~/` / `/` / `[A-Z]:[\\/]`） |
| P0-3 | testing | `scripts/smoke-pre-commit.js`（实施中） | fixture 「关键假设验证」段仅 87 字符 → 被 plan-scope lint 拒（≥100），让 S13a/c/d/e 失败但根因不是 C7，跨 checker stderr 污染 | ✅ 已修（fixture 加大到 ≥127 字符） |

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| P1-1 | maintainability | `pre-commit-check.js` `checkPlanCompletion` | 扩展名清单硬编码在函数体，未来加新扩展需改两处（regex 字面 + 测试 fixture）| 🟡 接受 — 当前 14 个扩展名足够，提取常量延后 |

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| P2-1 | performance | `checkPlanCompletion` | 每个 plan 都跑一次 `git log` + `git diff --cached` → N plan = 2N shell（实际 N 通常 ≤ 1）| 🟢 wontfix（实际场景一次 commit 1 plan） |
| P2-2 | testing | smoke S13b | 仅断言 stderr 含 path/task，未断言**不含** fail-open marker | 🟡 follow-up — 加 `assert(!/hook 内部异常/.test(stderr))` 强化 |

### 总评

ADR-013 §B 第一次真用：plan 阶段假设验证表的 medium 项「inline-code regex 覆盖度」在 Task 1 实施时即触发 grep 取证 → 567 occurrences 验证扩展名清单足够；dogfood 阶段一次性暴露 2 个 FP（命令形式 + 绝对路径），均通过 regex 迭代解决而非降低 enforcement 强度，符合 [[mechanism-over-discipline]]。Plan 完成度校验从此是 mechanism 而非纪律，闭环 [[documented-claim-vs-code-reality-drift]] 主因 4/8 fixed-claims-grep-zero-hit 的活样本。

---

## 复利记录

### 提取的经验

1. **跨 checker stderr 污染（新经验）**：`pre-commit-check.js` 多个 checker 串联跑，任一失败都写 stderr 但 exit 1 不区分根因。smoke fixture 必须**先满足其他 checker 的最低要求**（如 plan-scope lint 的 ≥100 字符假设段），否则测的根本不是目标 checker。教训上升：未来给 fixture helper 加内嵌的"通用前置满足项"段。
2. **inline-code 不仅含路径，也常含命令调用**：`\`node scripts/foo.js\`` / `\`bash install.sh --user\`` 是高频写法。regex 提取路径必须拒空白字符，否则命令路径被整体匹配。
3. **dogfood 现存语料是必经一步**：智能猜测的 regex 在 12 个真实 plan 上立刻爆 2 个 FP（17%）。如果不跑 dogfood 上线，第一天就误拒合法 plan。ADR-013 §B 不只是"边界产物枚举"，还包含"对现存语料做真实跑一遍"。
4. **递归 dogfood 是 enforcement 最强的自验证**：本 plan 自身的 7 个 task 中只有 T1/T2/T3/T6 含合法的 inline-code 路径（其余因含空格自然 skip），且所有合法路径都将在 commit 中出现 → 自我满足要求。如果未来加新规则让自身不满足，递归 dogfood 立即报警。

### 创建/更新的本能

- [[documented-claim-vs-code-reality-drift]] confidence 0.85 → 0.90（C7 是它的第二次 mechanism 兑现，第一次是 ADR-012 plan 假设验证）
- 新候选本能 [[inline-code-path-regex-must-reject-whitespace]] N=1 confidence 0.6 — 任何从 markdown 提取文件路径的 regex 都必须拒空白（避免命令形式误匹配）
- 新候选本能 [[smoke-fixtures-must-satisfy-other-checkers]] N=1 confidence 0.6 — 多 checker 串联系统的 smoke fixture 必须满足其他 checker 最低要求

### 解决方案文档

- 本 plan 即为解决方案文档（无需单独 `docs/solutions/` 入口，PR 描述指向此处即可）
- 关联 ADR：ADR-012（plan 假设验证）+ ADR-013（dogfood 边界产物枚举）双重应用

---

## 关联

- 父 sprint: `docs/plans/2026-05-12-gstack-latest-analysis.md`（Phase 4 reviewer 把 C7 从 🔴 升 🟡）
- 父 followup: `docs/plans/2026-05-12-followups-plan.md`
- 相关 ADR：ADR-012（plan 假设验证）、ADR-013（dogfood 边界产物枚举）
- 相关本能：[[documented-claim-vs-code-reality-drift]]、[[filename-vs-frontmatter-metadata]]、[[mechanism-over-discipline]]
