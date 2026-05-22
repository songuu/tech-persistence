# Figma Fidelity Protocol

> 目标：把 Figma -> code 从“看图猜实现”升级为可审计的 1:1 还原流程。触发条件：用户给出 Figma URL / node、上传设计截图并要求按图实现、或明确要求 design-to-code / 1:1 / fidelity。

## 1. Preflight 必收集上下文

开始写代码前先输出一张 preflight 表，至少包含：

| 项 | 必需 | 获取方式 | 失败时处理 |
|---|---|---|---|
| 设计上下文 | 是 | `get_design_context` | 无法开始实现 |
| 视觉截图 | 是 | `get_screenshot` | 只能声明结构还原，不能声明视觉 1:1 |
| 变量/样式 | 是 | `get_variable_defs` | 进入 token fallback，不得直接声称 token fidelity |
| 组件映射 | 条件必需 | `get_code_connect_map` | 无映射时标记 raw UI，不能声称复用组件库 |
| 设计系统库 | 条件必需 | `get_libraries` / `search_design_system` | 没有库时记录为无 DS 输入 |
| 节点大纲 | 条件使用 | `get_metadata` | 仅用于大节点拆分，不作为样式主来源 |

优先级：`get_design_context` + `get_screenshot` 是主入口；`get_metadata` 只在节点过大、需要分块或需要先找子节点 ID 时使用。

## 2. 硬门禁

- 没拿到 screenshot：不能说“视觉 1:1 已完成”。
- `get_variable_defs` 为空：必须说明设计稿缺 Variables/Styles，选择 token fallback；不能把 hex/px 当作最终实现。
- `get_code_connect_map` 为空：必须说明没有 Code Connect；生成代码只能标记为 raw implementation。
- 只有单一 Figma frame：必须写明响应式断点是假设，不能默认覆盖 mobile/desktop。
- Figma 原型未提供 hover/focus/disabled：必须把交互态列为未覆盖项。

## 3. 代码输出约束

实现结果必须附带 4 张表：

1. Token mapping：Figma variable/style -> code token/CSS var/Tailwind token。
2. Component mapping：Figma component -> project component；没有映射写 `raw`。
3. Unsupported features：未覆盖的断点、动效、交互态、字体渲染差异。
4. Verification：实际跑过的审计、构建、截图、交互验证。

默认禁止在业务 UI 中新增硬编码 `#hex`、`rgb()`、`hsl()`、设计相关 `px`。例外仅限：

- token 源文件本身，如 `tokens.css` / `theme.css`。
- `0`、`1px` hairline、第三方库覆写、明确 allowlist。
- Figma 未提供 token 且用户接受 fallback 时，必须在表中登记。

## 4. 验证阶梯

按风险从低到高执行：

| 等级 | 场景 | 必跑 |
|---|---|---|
| L1 | 单文件/低风险 UI | `node scripts/figma-fidelity-audit.js --paths <changed-files>` |
| L2 | 常规页面改造 | L1 + 项目 type-check/build |
| L3 | 核心页面 / 客户交付 | L2 + Playwright `toHaveScreenshot` |
| L4 | 多断点/复杂交互 | L3 + hover/focus/disabled/响应式交互测试 |

截图 diff 阈值默认 `maxDiffPixelRatio: 0.03`。跨 OS 字体渲染不可消除，像素 100% 不是工程验收标准。

## 5. Token fallback

当设计侧未建 Variables/Styles：

1. 从 `get_design_context` 聚类 color / typography / spacing / radius，生成 `suggested-token-map`。
2. 开发确认后写入项目 token 源，而不是散落在组件样式里。
3. 后续实现必须引用确认后的 token。

当设计侧只有 Styles 没有 Variables：

1. 优先用 Figma Styles / REST API / Dev Mode 信息拉取 style 值。
2. 生成代码侧 token map。
3. 再跑 token audit，避免 hardcode 回流。

## 6. 完成定义

可以声明 Figma 1:1 完成，必须同时满足：

- Preflight 表完整，无未解释的缺项。
- Token mapping 和 Component mapping 已列明。
- 业务 UI 无未登记 hardcoded visual values。
- 至少通过 L1；核心页面至少通过 L3。
- 未覆盖项明确写出，不把假设当事实。
