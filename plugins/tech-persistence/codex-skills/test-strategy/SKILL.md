---
name: test-strategy
description: Codex opt-in testing strategy. 仅当用户显式调用 /test、test-strategy 或请求独立测试方案时使用；普通实现和审查不自动加载。
---

# Test Strategy

仅当用户显式调用 `/test`、`test-strategy` 或明确请求独立测试方案时加载。`work` 与 `review` 已内置风险分级和最小验证回路，不再叠加本 skill。

## 风险到深度

- L0：纯文案、注释、格式；视觉或 diff 检查即可。
- L1：低风险、可逆的小改动；1-3 个冒烟用例。
- L2：常规功能与共享工具修改；正常路径、主要边界和错误处理。
- L3：核心状态、API、数据处理和并发；覆盖正常、异常、边界、一致性与契约。
- L4：认证、支付、权限、迁移或不可逆写入；增加集成、幂等、回滚、安全与人工 gate。

优先读取仓库既有测试、脚本和 `.codex/rules/testing-patterns.md`。先跑最窄反馈环，再按风险扩大；明确区分代码失败和环境/工具阻塞。
