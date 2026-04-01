---
description: "由 3 个 code-style 域本能自动聚类生成的编码风格技能"
evolved_from:
  - "prefer-const-over-let"
  - "use-arrow-functions"
  - "destructure-params"
evolved_date: "2025-06-20"
average_confidence: 0.78
---

# 函数式编码风格

> 本技能由 /evolve 命令从 3 个高置信度本能自动生成。

## 何时触发
编写新函数、变量声明、参数处理时自动应用。

## 行为规范

### 变量声明 (来源: prefer-const-over-let, 置信度 0.75)
- 默认使用 `const`，仅在需要重新赋值时用 `let`
- 永远不使用 `var`

### 函数定义 (来源: use-arrow-functions, 置信度 0.80)
- 回调和短函数使用箭头函数
- 需要 `this` 绑定或作为方法时使用 function 声明
- 单表达式箭头函数省略大括号和 return

### 参数处理 (来源: destructure-params, 置信度 0.70)
- 函数参数超过 2 个时使用对象解构
- 提供默认值避免 undefined 检查
- 在解构中重命名不清晰的属性

## 来源证据
- 3 个本能，跨 15 次会话验证
- 用户纠正 8 次，确认 22 次
- 平均置信度 0.78
