---
title: "Active sprint 探测被重复 status 污染"
date: 2026-05-11
tags: [solution, sprint, hooks, frontmatter]
related_instincts: []
aliases: ["duplicate sprint status", "active sprint status misdetection"]
---

# Active sprint 探测被重复 status 污染

## Problem

SessionStart 的 `detectActiveSprintTags()` 会扫描 `docs/plans/` 找 active sprint tags，用于 memory relevance 排序。旧 sprint 文档出现重复 `status` 字段时，regex 命中了第一个 `status: planning`，导致已完成 sprint 被误判为 active。

## Root Cause

原实现直接用 regex 取第一个 `status`：

```javascript
const statusMatch = fm.match(/^status:\s*"?([^"\n]+)"?/m);
```

但实际文档可能在 sprint 流程中留下重复字段：

```yaml
status: planning
phase: 5-compound
status: completed
```

YAML/frontmatter 语义上后写字段应覆盖前写字段；first-match regex 与这个语义相反。

## Solution

`scripts/inject-context.js` 改为复用 `scripts/lib/memory-v5.js` 已导出的 `parseFrontmatter()`，用 parser 的 last-write-wins 结果读取 `status`，并补充规范化：

```javascript
const { meta } = parseFrontmatter(content);
const status = normalizeFrontmatterScalar(meta.status);
if (!status || !activeStatuses.has(status)) continue;
```

同时新增回归测试：同一个 frontmatter 中先 `planning` 后 `completed` 时，`detectActiveSprintTags()` 必须返回 `[]`。

## Prevention

- 读取 frontmatter 单值字段时不要用 first-match regex；复用共享 parser，或显式定义 duplicate key 语义。
- active/pending 状态探测必须有“已完成文档不再命中”的回归测试。
- Hook 脚本改动后必须同步 plugin hook 副本并验证：`node plugins/tech-persistence/scripts/build-codex-plugin.js` + `node scripts/validate-codex-plugin.js`。

## Related

- [[2026-05-11-sprint-architecture-review]] — 本次修复 sprint
- [[2026-05-11-sprint-speed-layer1]] — 暴露重复 status 的旧 sprint 文档，也是 SessionStart relevance 的来源方案
