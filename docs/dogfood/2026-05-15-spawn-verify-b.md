---
title: "Spawn 验证 B - dogfood worker B"
type: dogfood
created: "2026-05-15"
worker: B
---

# Spawn 验证 — Worker B

本文件由 Worker B subagent 在 isolation: worktree 模式下创建，与 Worker A 并行执行，验证 [P] 真并行 worker spawn。

验证内容:
- 真并行（与 Worker A 在同一 message 内同时 spawn）
- isolation: worktree（独立于 Worker A 的 worktree）
- 4 status 返回契约（本 sprint 协议契约）
- 冲突检测（与 Worker A 改不同文件 = 集合 size 等于 task 数 = 通过）
