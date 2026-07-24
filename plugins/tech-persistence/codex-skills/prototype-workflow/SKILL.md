---
name: prototype-workflow
description: Codex opt-in prototype convergence. 仅当用户显式调用 /prototype 或请求原型需求收敛时使用；参考截图、Figma 链接和设计实现不自动触发。
---

# Prototype Workflow

仅当用户显式调用 `/prototype` 或明确请求“原型需求收敛”时加载。单张截图、普通 Figma URL、视觉 bug 或设计到代码任务不是自动触发条件；这些输入由调用方按当前意图与视觉能力门禁处理。

## 收敛流程

1. 标记已验证事实、合理假设和未知项，不把截图推断写成确定需求。
2. 只询问会改变用户流程、数据契约或验收标准的阻塞问题；其余采用可逆假设并显式记录。
3. 输出用户价值、范围内/外、关键状态、失败路径和可观察完成定义。
4. 需要设计证据时，先确认当前模型/工具能结构化读取；不能读取则阻塞或路由视觉模型。
5. 收敛结果交给 `plan`，本 skill 不预加载实现、review 或 Figma skill 链。
