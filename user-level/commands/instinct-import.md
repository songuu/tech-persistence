---
description: "导入他人分享的本能文件"
---

# /instinct-import — 导入本能

从导出文件中导入本能到 `~/.claude/homunculus/instincts/inherited/` 目录。

## 使用方式
`/instinct-import path/to/instincts-export.md`

## 执行步骤

1. 读取导入文件，解析其中的本能列表
2. 对每个本能：
   - 置信度乘以 0.8（他人经验的折扣）
   - 标记 `source: "imported"` 和 `imported_from: "原始来源"`
   - 检查与现有本能的冲突
3. 展示导入预览，等待确认：

```
📥 本能导入预览

| # | 本能 | 域 | 原始置信度 | 导入置信度 | 状态 |
|---|------|-----|----------|----------|------|
| 1 | prefer-xxx | code-style | 0.70 | 0.56 | 🆕 新增 |
| 2 | use-xxx | testing | 0.80 | 0.64 | ⚠️ 与现有冲突 |
| 3 | always-xxx | git | 0.90 | 0.72 | 🆕 新增 |

确认导入? (y/n，或输入编号选择性导入)
```

4. 确认后写入 `~/.claude/homunculus/instincts/inherited/`
5. 冲突的本能放入独立子目录 `inherited/pending-review/`

## 注意
- 导入的本能需要在后续会话中被验证后才会提升置信度
- 你可以随时删除 `inherited/` 中的本能
