---
id: "use-vitest-not-jest"
trigger: "编写或运行测试时"
confidence: 0.85
domain: "testing"
type: "tool_preference"
source: "session-observation"
created: "2025-06-01"
last_seen: "2025-06-20"
scope: "project"
project_id: "a1b2c3d4e5f6"
project_name: "my-vite-app"
---

# 本项目使用 Vitest 而非 Jest

## Action
- 测试文件使用 `.test.ts` 后缀
- 导入 `describe, it, expect` 从 `vitest`
- 运行测试命令: `pnpm vitest` 或 `pnpm test`
- Mock 使用 `vi.fn()` 和 `vi.mock()` 而非 `jest.fn()`

## Evidence
- 2025-06-01: 用户纠正：不要用 jest.fn()，本项目用 vitest
- 2025-06-08: 正确使用 vi.mock，用户未纠正
- 2025-06-15: 正确使用 vi.spyOn，用户确认
- 2025-06-20: 生成 5 个测试文件，全部正确使用 vitest API
