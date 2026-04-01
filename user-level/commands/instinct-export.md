---
description: "导出本能供团队成员或其他项目使用"
---

# /instinct-export — 导出本能

将指定范围的本能打包导出为可分享的文件。

## 参数
- 无参数: 导出当前项目的所有高置信度 (>=0.5) 本能
- `all`: 导出所有本能（含全局）
- `domain:testing`: 只导出指定域
- `global`: 只导出全局本能

## 执行步骤

1. 按参数筛选本能文件
2. 移除敏感信息（文件路径中的用户名等）
3. 打包为单个 Markdown 文件，格式：

```markdown
# 本能导出 — {project_name}
# 导出日期: YYYY-MM-DD
# 数量: N 个本能

---

[所有本能文件内容，以 --- 分隔]
```

4. 保存到 `./instincts-export-YYYYMMDD.md`

## 注意
- 默认排除 `source: "user_correction"` 类型（含个人纠正）
- 导入方的置信度会降低 20%（非本人验证的经验）
