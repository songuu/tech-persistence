# Sprint 运行时可移植性契约

`/sprint` 是方法论编排，默认只依赖**当前可执行宿主**，不把 Codex、Claude Code 或 `/agent-loop` 当作全局前置条件。

| 环境 | 行为 |
|------|------|
| 只有 Codex | Codex 完成全流程；缺 Claude 只降低跨 provider 独立复审 assurance |
| 只有 Claude Code | Claude Code 完成全流程；缺 Codex 不阻塞 Work |
| 两者都可用 | 默认仍由当前宿主闭环；只有用户显式选择且 preflight 通过才委托外部 backend |
| 两者都不可用，但当前是其他框架 | 当前宿主按实际 capability 执行，不把品牌名当 capability |
| 仅 detached runner 且无候选 | 只阻塞缺候选的阶段，报告缺失 capability/adapter；不得虚构执行或要求登录固定厂商 |

- 非当前 provider 缺失、OAuth 过期或 CLI 未安装，不得阻塞 Sprint。Harness、Transcript 或 provider 品牌名只是任务域词，不触发隐式 backend 切换。
- 有原生 spawn 就分派；否则 inline/串行执行并报告独立性降级。
- 外部 backend 只在用户显式选择时 preflight；失败回退当前宿主。
- provider 在副作用前失败可换到满足能力和策略的候选；存在 partial effects 后禁止切换 writer，只能恢复同一 provider 或进入 reconciliation。
