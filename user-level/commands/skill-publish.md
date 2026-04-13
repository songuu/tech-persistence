---
description: "将已验证的 skill 改进提案发布为新版本，含备份、changelog、回滚能力"
---

# /skill-publish — Skill 版本发布

将 `/skill-improve` 的提案（经 `/skill-eval` 验证后）发布为新版本。

## 用法
- `/skill-publish prototype` — 发布已验证的提案
- `/skill-rollback prototype` — 回滚到上一版本

## 执行步骤
1. 检查是否有已验证且通过的提案（`/skill-eval` 通过率 >= 当前版本）
2. 备份当前版本 → `{skill-name}.v{N}.bak.md`
3. 应用修改 → 更新 SKILL.md 或 command .md
4. 记录 changelog → `~/.claude/homunculus/skill-changelog/{name}.md`
5. 标记源本能 `absorbed_into: "{skill} v{N+1}"`

## Changelog 格式
```markdown
### v{N+1} ({date})
- [变更1] (原因: 数据依据)
- [变更2] (原因: 数据依据)
- 吸收本能: [id1, id2]
- eval: v{N} {X}% → v{N+1} {Y}%
```

## 安全
- 必须有 eval 验证才能发布（eval 结果 >= 当前版本）
- 旧版本完整保留在备份中
- `/skill-rollback {name}` 随时回滚
