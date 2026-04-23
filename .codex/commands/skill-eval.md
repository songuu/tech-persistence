---
description: "用测试集验证 skill：A/B 对比当前版本和提案版本的通过率"
---

# /skill-eval — Skill 验证

用预定义的测试用例验证 skill 的质量。

## 用法
- `/skill-eval prototype` — 验证当前版本
- `/skill-eval prototype --diff` — A/B 对比：当前 vs 提案版本

## 测试集位置
`~/.codex/homunculus/skill-evals/{skill-name}/`

如果没有测试集，先提示创建：
```
未找到 /prototype 的 eval 测试集。
要基于当前 skill 自动生成测试集吗？(y/n)
```

自动生成 3-5 个测试用例 + 5-8 个断言（如"每轮问题 <= 5 个"）。

## 输出格式
```
Eval 结果: /{name}

| 测试用例 | v1 通过 | v2 通过 |
|---------|--------|--------|
| simple  | 5/5    | 5/5    |
| medium  | 3/5    | 5/5 ↑  |
| complex | 2/5    | 4/5 ↑  |
| 总计    | 67%    | 93% ↑  |

v2 >= v1 ? ✅ 建议发布 : ❌ 回滚
```

## 安全规则
- eval 文件不可被 skill 修改（防止 "改考卷通过考试"）
- eval 结果归档到 `skill-evals/{name}/results/` 供历史对比
