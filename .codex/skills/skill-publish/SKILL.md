---
name: skill-publish
description: Codex-compatible entry point for the former /skill-publish command. [alias → /skill publish] 将已验证的 skill 改进提案发布为新版本，含备份、changelog、回滚能力
---

# Skill Publish

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/skill-publish` command.

## Invocation

Use `$skill-publish <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/skill-publish`, interpret that as this `$skill-publish` skill invocation while running in Codex.

## Command Instructions

# /skill-publish — Skill 版本发布

> **已合并到 `/skill publish <name>`**（行为完全一致，新代码请用 `/skill publish`）。本命令保留作 alias，向后兼容。

将 `/skill-improve` 的提案（经 `/skill-eval` 验证后）发布为新版本。

## 用法
- `/skill-publish prototype` — 发布已验证的提案
- `/skill-rollback prototype` — 回滚到上一版本

## 执行步骤
0. **确定性护栏（强制，不可跳过）**：发布前先跑护栏脚本，新版通过率 < 旧版（超容差）时脚本 `exit 2` 拒绝，本次发布必须中止：
   ```bash
   node scripts/skill-eval-results.js guard <skill-name>
   # exit 0 → 继续步骤 1；exit 2 → 中止，按脚本提示改进提案后重跑 /skill eval
   ```
   护栏读 `skill-evals/{name}/results/results.jsonl` 最新两版比对。无前一版基线时放行（exit 0）。这是 [[ADR-013]] mechanism-over-discipline 的落地：把"eval ≥ 当前版本"从协议下沉为脚本强制。
1. 检查是否有已验证且通过的提案（`/skill-eval` 通过率 >= 当前版本）
2. 备份当前版本 → `{skill-name}.v{N}.bak.md`
3. 应用修改 → 更新 SKILL.md 或 command .md
4. 记录 changelog → `~/.codex/homunculus/skill-changelog/{name}.md`
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
- 必须有 eval 验证才能发布（eval 结果 >= 当前版本），由步骤 0 护栏脚本 `exit 2` 确定性强制
- 旧版本完整保留在备份中
- `/skill-rollback {name}` 随时回滚

