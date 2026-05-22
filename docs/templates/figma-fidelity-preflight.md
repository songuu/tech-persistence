# Figma Fidelity Preflight

> 用途：任何 Figma -> code 任务开始前填写。未完成本表，不声明 1:1。

## Input

| 项 | 值 |
|---|---|
| Figma URL / node |  |
| Target route / component |  |
| Target repo path |  |
| User P0 pain | color / typography / spacing / component structure / interaction / responsive |
| Required fidelity level | token / visual / interaction |

## MCP Evidence

| 项 | 工具 | 状态 | 证据 / 结果 | 失败处理 |
|---|---|---|---|---|
| Design context | `get_design_context` | pending |  | block |
| Screenshot | `get_screenshot` | pending |  | no visual 1:1 claim |
| Variables | `get_variable_defs` | pending |  | token fallback |
| Code Connect | `get_code_connect_map` | pending |  | raw UI label |
| Design system search | `get_libraries` / `search_design_system` | pending |  | no DS input |
| Node outline | `get_metadata` | optional |  | split node if needed |

## Token Mapping

| Figma variable/style | Raw value | Code token | Status |
|---|---|---|---|
|  |  |  | pending |

## Component Mapping

| Figma component | Code component | Source path | Status |
|---|---|---|---|
|  |  |  | raw / mapped / missing |

## Unsupported / Assumptions

| Item | Reason | User-visible impact | Follow-up |
|---|---|---|---|
|  |  |  |  |

## Verification Plan

| Level | Command / check | Required | Result |
|---|---|---|---|
| L1 token audit | `node scripts/figma-fidelity-audit.js --paths <changed-files>` | yes | pending |
| L2 build/type-check |  | page-level | pending |
| L3 visual screenshot | Playwright `toHaveScreenshot({ maxDiffPixelRatio: 0.03 })` | core page | pending |
| L4 interaction | hover/focus/disabled/responsive tests | complex UI | pending |
