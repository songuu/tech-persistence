---
title: "claude-mem follow-up native absorption"
type: sprint
status: completed
created: "2026-05-27"
updated: "2026-05-27"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
tags: [sprint, security, hooks, memory-v5, claude-mem-followup]
aliases: ["claude-mem-followups", "edge-tag-stripping"]

invariants:
  - "TP keeps deterministic markdown storage; no DB/daemon/vector dependency is introduced"
  - "Hook failures stay non-blocking but observable through stderr markers"
  - "Claude and Codex/plugin hook copies stay generated from the same source scripts"
  - "Privacy redaction must happen before observations.jsonl persistence"
  - "Memory recall telemetry must write only aggregate metrics, never memory content"

invariant_tests:
  - "node scripts/run-tests.js --grep \"redaction|memory-recall|inject-context-cost-summary|secret-scan\""
  - "node plugins/tech-persistence/scripts/build-codex-plugin.js"
  - "node scripts/validate-codex-plugin.js"
  - "node scripts/pre-commit-check.js"

deferred:
  - sprint: future
    item: "session-timeline-archaeology deterministic timeline tool"
    deadline: "2026-06-17"
    reason: "P2 backlog; current user signal N=0"
  - sprint: future
    item: "i18n-mode runtime output switching"
    deadline: "2026-06-17"
    reason: "P2 backlog; current user signal N=0"

deadcode_until: []
---

# claude-mem follow-up native absorption

> Source: `docs/plans/2026-05-26-claude-mem-eval.md` and `docs/solutions/2026-05-26-claude-mem-eval.md`.

## Phase 1: Think

### Scope

- Implement the four P1 follow-ups from the claude-mem evaluation:
  1. edge-tag-stripping for `<private>`, `<system-private>`, and `<claude-mem-context>` content before observation persistence
  2. intentional hook exit-code protocol
  3. root `SECURITY.md` telemetry/privacy transparency
  4. Memory v5 recall telemetry for deterministic grep/frontmatter scaling signals
- Keep TP's lightweight/deterministic/Obsidian-compatible architecture unchanged.
- Regenerate plugin hook/runtime copies and verify multi-runtime parity.

### Non-scope

- No SQLite/Chroma/Bun daemon/Redis/Postgres/React viewer import.
- No enforcement pre-commit gate for exit-code policy in this sprint.
- No session timeline UX or i18n mode implementation; both remain explicit P2 backlog.

### Success Criteria

- [x] Private/context tags are stripped before observation persistence via `scripts/observe.js` / `scripts/lib/redaction.js` and covered by `scripts/test-redaction.js`.
- [x] Hook exit-code semantics are documented in both runtime rule directories.
- [x] `SECURITY.md` explains local storage, local-only telemetry, provider caveat, and privacy tags.
- [x] SessionStart records aggregate recall metrics without memory content.
- [x] Plugin hook/MCP copies are regenerated from source and validation passes.
- [x] L3 targeted tests plus full regression run pass, or any failures are documented with cause.

### 风险和假设

- **R1**: Redaction 只处理 summary 后仍可能让 private path 被 `extractPaths` 捕获。缓解：先 strip raw hook input，再对 observation 字段兜底。
- **R2**: Recall telemetry 可能把 memory 正文写入本地指标。缓解：metric builder 只返回 aggregate counts/bytes/coverage，并用测试断言正文不出现。
- **R3**: 新增 hook lib 依赖漏同步到 plugin。缓解：跑 `build-codex-plugin.js` + `validate-codex-plugin.js`。

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| `observe.js` 是 privacy tag redaction 的唯一必要写入入口 | Read `scripts/observe.js` 和 `normalizeHookPayload` 调用链 | `observations.jsonl` 只由 `observe.js` append；在 raw input 和 observation field 双层 strip 足够覆盖本 sprint |
| SessionStart recall telemetry 可不引入内容泄露面 | Read `scripts/inject-context.js` / `scripts/lib/memory-v5.js`；新增 aggregate-only test | Metric 包含 topic/file/entry/byte/hit_rate，不包含 memory line/body |
| Plugin 副本由 build script 生成，不应手工编辑 | Read `plugins/tech-persistence/scripts/build-codex-plugin.js::copyHooks/copyHookLibs/copyMcpRuntime` | build 会复制 `scripts/*.js` 和 `scripts/lib/*.js` 到 hooks/MCP；新增 `redaction.js` 被 inventory 验证捕获 |

## Phase 2: Technical Plan

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| sibling-eval follow-up | 推荐优先级必须列实例计数 / detection signal | 只实施 4 个已列 P1；P2 backlog 显式 defer |
| privacy / observations | `observations.jsonl` 全文捕获是泄露面 | 在 observe hook 写入前引入 tag redaction |
| hook runtime | hook 不能 crash 主会话，但 catch 块必须 stderr marker | 保持 `process.exit(0)` fail-open；新增 exit-code rule 文档 |
| plugin parity | hook 脚本新增 `scripts/lib/*` 依赖必须同步插件构建 | 跑 build-codex-plugin + validate-codex-plugin |
| Memory v5 | grep/frontmatter deterministic 优先，scaling 假设需实测 | 只记录 aggregate metric，不引入 stochastic search |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| privacy tag stripping | PreToolUse/PostToolUse hook | `observe.js` -> `redaction.js` | `observations.jsonl` redacted fields | Yes, future observations stay redacted |
| recall telemetry | SessionStart hook | `inject-context.js` -> `memory-v5.js` metric builder | `homunculus/telemetry/memory-recall.jsonl` | Yes, next sessions append aggregate rows |
| exit-code protocol | developer reads rules | `.claude/rules` + `.codex/rules` | git-tracked markdown | Yes, runtime-specific instructions can load it |
| SECURITY.md | repository reader | root doc | git-tracked markdown | Yes, repo-level transparency doc |

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| 2026-05-26 claude-mem eval | session-timeline-archaeology | defer P2 | 2026-06-17 |
| 2026-05-26 claude-mem eval | i18n-mode | defer P2 | 2026-06-17 |

### Task Breakdown

- [x] Task 1: Redaction library + observe integration — Risk L3
- [x] Task 2: Redaction tests + observation smoke — Risk L2
- [x] Task 3: Exit-code protocol docs + SECURITY.md — Risk L1
- [x] Task 4: Memory recall metric builder/recorder + tests — Risk L3
- [x] Task 5: Plugin regeneration + validation — Risk L2
- [x] Task 6: Review, solution doc, compound/index refresh — Risk L1

### Test Strategy

- Targeted unit/smoke tests for redaction and recall telemetry.
- Existing invariant tests around context injection and secret scanning.
- Plugin build and Codex plugin validation because hook lib inventory changes.
- Full `node scripts/run-tests.js` if targeted tests pass.

## Phase 3: Work

### Change Log

| Date | Task | Change |
|------|------|--------|
| 2026-05-27 | Phase 1-2 | Scope and technical plan created from claude-mem evaluation P1 follow-ups |
| 2026-05-27 | T1-T2 | Added `scripts/lib/redaction.js`; `observe.js` strips `<private>`, `<system-private>`, and `<claude-mem-context>` before JSONL persistence; `test-redaction.js` covers helper + real hook smoke |
| 2026-05-27 | T3 | Added `.claude/rules/hook-exit-codes.md`, `.codex/rules/hook-exit-codes.md`, and root `SECURITY.md` |
| 2026-05-27 | T4 | Added aggregate Memory v5 recall metrics and SessionStart recording to `homunculus/telemetry/memory-recall.jsonl` |
| 2026-05-27 | T5 | Ran plugin build; generated hook/MCP copies including `redaction.js`; validation passed |
| 2026-05-27 | T6 | Added `docs/solutions/2026-05-27-claude-mem-followups.md`; synced solution index; completed review + compound |

### Validation

| Command | Result |
|---------|--------|
| `node scripts/run-tests.js --grep redaction` | pass: 1 file / 5 assertions |
| `node scripts/run-tests.js --grep "memory-recall\|inject-context-cost-summary"` | pass after test HOME/USERPROFILE isolation fix: 2 files / 11 assertions |
| `node plugins/tech-persistence/scripts/build-codex-plugin.js` | pass: generated 22 commands / 32 skills / 16 hook files / 9 MCP runtime files |
| `node scripts/validate-codex-plugin.js` | pass |
| `node scripts/run-tests.js --grep "redaction\|memory-recall\|inject-context-cost-summary\|secret-scan"` | pass: 4 files |
| `node scripts/run-tests.js` | pass: 12 files |
| `node scripts/secret-scan-on-demand.js --paths scripts docs SECURITY.md .claude .codex plugins\tech-persistence\hooks plugins\tech-persistence\mcp` | clean: 262 files scanned |
| `node scripts/sync-solution-index.js --all` | pass after elevated retry for Windows EPERM |
| `node scripts/pre-commit-check.js` | pass |

## Phase 4: Review

### Dispatch

- Risk: L3
- Mode: inline fallback
- Views: security, architecture, quality, test
- Skipped: perf (no hot path or benchmark-sensitive code)

### Gap Detection Walkthrough

| workflow / invariant | existing coverage | uncovered gap | action |
|----------------------|-------------------|---------------|--------|
| private tag prompt -> observe hook -> observations.jsonl | `test-redaction.js` real hook smoke | none | covered |
| SessionStart -> Memory v5 index -> recall telemetry JSONL | `test-memory-recall-telemetry.js` real `inject-context.js` smoke | none | covered |
| source hook/lib -> plugin hook/MCP copies | build + validate-codex-plugin | none | covered |
| local telemetry must not contain memory content | aggregate-only tests assert body strings absent | `hit_rate` currently means index coverage, not semantic recall | P2 noted in solution doc |

### Findings

- P0: none
- P1: none
- P2: consider renaming `hit_rate` to `coverage_rate` if future telemetry grows beyond index coverage.

### Result

DONE. Security: privacy tags stripped before persistence; telemetry aggregate-only. Architecture: no DB/daemon/vector dependency added. Quality/Test: L3 coverage met with targeted + full regression + plugin validation.

## Phase 5: Compound

### Outputs

- Solution: `docs/solutions/2026-05-27-claude-mem-followups.md`
- Rules: `.claude/rules/hook-exit-codes.md`, `.codex/rules/hook-exit-codes.md`
- Transparency: `SECURITY.md`
- Index: `docs/solutions/index.jsonl` + `CLAUDE.md` + `AGENTS.md` synced from solution docs

### Extracted Learnings

- Privacy boundary must sit before hook persistence, not only at downstream search/export.
- Memory scaling debates need aggregate telemetry before considering stochastic search.
- Any new hook lib dependency must be verified through plugin build and validation in the same sprint.

### Follow-up

- P2: `hit_rate` naming may become `coverage_rate` in a future telemetry refinement.
- Deferred items remain: session timeline archaeology and i18n mode, both with deadline 2026-06-17.
