---
title: "claude-mem follow-up 吸收：privacy tags + hook exit policy + local recall telemetry"
date: 2026-05-27
tags: [solution, security, hooks, memory-v5, claude-mem-followup, multi-runtime]
related_instincts:
  - sibling-eval-self-observation-recursive-capture
  - hook-lib-dependency-requires-plugin-build
  - memory-recall-telemetry-aggregate-only
related_solutions:
  - "[[2026-05-26-claude-mem-eval]]"
  - "[[2026-05-14-claude-md-index-via-prompt-recall]]"
  - "[[2026-05-12-pre-commit-defense]]"
aliases: ["edge-tag-stripping", "memory-recall-telemetry", "claude-mem-followups"]
status: completed
---

# claude-mem follow-up 吸收

## Problem

2026-05-26 claude-mem sibling-eval 得出 4 个 P1 follow-up：edge-tag-stripping、hook exit-code protocol、`SECURITY.md` transparency、grep/frontmatter recall telemetry。评估 sprint 已完成，但如果不下沉为代码和规则，会继续停留在"文档知道风险，hook 仍全文捕获"的半完成状态。

## Root Cause

TP 的核心优势是 lightweight + deterministic markdown，但这也让 hook 捕获路径更直接：

- `scripts/observe.js` 会把工具输入/输出摘要写入 `observations.jsonl`，此前没有 `<private>` tag 边界。
- Memory v5 一直假设 grep/frontmatter scaling 足够，但缺少 topic/entry/coverage 的本地指标证明。
- hook exit code 语义散落在脚本里，缺少 runtime hook 和 validator 的统一区别。
- plugin hook/MCP 副本是 git-tracked 派生产物，新增 `scripts/lib/*` 依赖如果不跑 build 会在用户环境静默失效。

## Solution

### 1. Privacy tag stripping before persistence

新增 `scripts/lib/redaction.js`，支持：

- `<private>...</private>`
- `<system-private>...</system-private>`
- `<claude-mem-context>...</claude-mem-context>`
- unclosed tag fallback：从 tag 起点到字符串末尾全部替换为 marker

`scripts/observe.js` 现在先对 raw hook payload 调 `stripPrivateTags(input)`，再走 `normalizeHookPayload`，最后用 `redactObservation()` 对 `input_summary` / `output_summary` / `command` / `input_paths` 做兜底。这样 private path 不会先被 `extractPaths` 捕获再进入 JSONL。

测试：`scripts/test-redaction.js` 覆盖 helper、multiline context、unclosed tag、observation field redaction、真实 `observe.js` spawn smoke。

### 2. Hook exit-code protocol

新增双 runtime rule：

- `.claude/rules/hook-exit-codes.md`
- `.codex/rules/hook-exit-codes.md`

语义：

- `0`: success / graceful fail-open
- `1`: non-blocking actionable error for manual CLI or diagnostics
- `2`: intentional blocking validator / usage error

Runtime hooks 默认 internal error exit 0，但必须写 stderr marker；blocking code 2 留给 pre-commit/security scan/usage error。

### 3. SECURITY.md transparency

新增根 `SECURITY.md`，明确：

- homunculus 默认存储位置与 `TECH_PERSISTENCE_HOME`
- 无 hosted Tech Persistence telemetry
- local telemetry 只能写 aggregate metric，不能写 prompt/memory/tool output/provider response
- provider caveat：Claude/Codex 自身 provider path 不由 TP 改变
- privacy tags 用法和 secret rotation 建议

### 4. Aggregate Memory v5 recall telemetry

`scripts/lib/memory-v5.js` 新增：

- `collectMemoryTopicStats()`
- `buildMemoryRecallMetric()`
- `writeMemoryRecallMetric()`
- `recordMemoryRecallMetric()`

`scripts/inject-context.js` 在 SessionStart 构建 Memory v5 index 时写入：

```text
<homunculus>/telemetry/memory-recall.jsonl
```

每行只包含 aggregate fields：`topic_count`, `topic_file_count`, `total_entries`, `indexed_entries`, `index_max_entries`, `total_bytes`, `hit_rate`, `prioritize_topics`。不包含 memory 正文。

测试：`scripts/test-memory-recall-telemetry.js` 覆盖 aggregate-only metric、JSONL append、`telemetryDir` no-op、真实 `inject-context.js` spawn smoke。

### 5. Plugin parity

运行 `node plugins/tech-persistence/scripts/build-codex-plugin.js` 后：

- `plugins/tech-persistence/hooks/observe.js`
- `plugins/tech-persistence/hooks/inject-context.js`
- `plugins/tech-persistence/hooks/lib/redaction.js`
- `plugins/tech-persistence/hooks/lib/memory-v5.js`
- `plugins/tech-persistence/mcp/lib/redaction.js`
- `plugins/tech-persistence/mcp/lib/memory-v5.js`

均由 source 同步。`node scripts/validate-codex-plugin.js` 验证 hook lib inventory 和 source match。

## Review

Risk: L3。Inline fallback review 视角：security / architecture / quality / test。

### Gap Detection Walkthrough

| workflow / invariant | existing coverage | uncovered gap | action |
|----------------------|-------------------|---------------|--------|
| private tag prompt -> observe hook -> observations.jsonl | `test-redaction.js` real hook smoke | none | covered |
| SessionStart -> memory index -> recall telemetry JSONL | `test-memory-recall-telemetry.js` real `inject-context.js` smoke | none | covered |
| source hooks -> plugin hooks/MCP copies | `build-codex-plugin.js` + `validate-codex-plugin.js` | none | covered |
| local telemetry must not contain memory content | aggregate-only tests assert body strings absent | metric name `hit_rate` may be interpreted as recall quality, but currently means index coverage | documented in solution; future metric can split `coverage_rate` if needed |

Findings: no P0/P1. P2: consider renaming `hit_rate` to `coverage_rate` if future telemetry grows beyond index coverage.

## Validation

- `node scripts/run-tests.js --grep redaction` — pass
- `node scripts/run-tests.js --grep "memory-recall|inject-context-cost-summary"` — pass after isolating HOME/USERPROFILE in the spawn test
- `node plugins/tech-persistence/scripts/build-codex-plugin.js` — pass
- `node scripts/validate-codex-plugin.js` — pass
- `node scripts/run-tests.js` — pass, 12 files
- `node scripts/secret-scan-on-demand.js --paths scripts docs SECURITY.md .claude .codex plugins\tech-persistence\hooks plugins\tech-persistence\mcp` — clean

## Prevention

- Any future hook persistence path must ask: "Does user-provided text cross a persistence boundary before redaction?"
- Any new `scripts/lib/*` hook dependency must be followed by plugin build + validation.
- Memory telemetry must stay aggregate-only unless a future sprint explicitly introduces a privacy-reviewed content sampling mechanism.
- SECURITY transparency and mechanism should evolve together: document privacy tags only when the hook actually strips them.

## Related

- [[2026-05-26-claude-mem-eval]] — source sibling-eval and P1 follow-up decision table
- [[2026-05-12-pre-commit-defense]] — projection/build validation discipline
- [[2026-05-14-claude-md-index-via-prompt-recall]] — Memory v5 deterministic recall background
