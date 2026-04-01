---
id: "prefer-const-over-let"
trigger: "声明变量时"
confidence: 0.75
domain: "code-style"
type: "user_correction"
source: "session-observation"
created: "2025-06-10"
last_seen: "2025-06-18"
scope: "global"
---

# 优先使用 const 而非 let

## Action
声明变量时默认使用 const，只有在需要重新赋值时才用 let。永远不用 var。

## Evidence
- 2025-06-10: 用户纠正了 3 处 let 声明 → const
- 2025-06-14: 用户在 code review 中再次强调 const-first
- 2025-06-18: 本次会话中 12 处变量声明，用户未纠正任何 const 用法
