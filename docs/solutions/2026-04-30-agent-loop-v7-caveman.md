# Agent Loop v7 Caveman Integration

日期：2026-04-30

## 问题

需要把 `JuliusBrussee/caveman` 接入当前 Tech Persistence 架构，形成 v7，并保持功能和效果一致。直接复制 prompt 不够，因为本仓库有三层分发面：

- 源头：`user-level/skills`、`scripts`
- 插件产物：`plugins/tech-persistence`
- 已安装运行面：`C:\Users\songyu\plugins\tech-persistence`、`~/.codex/skills`

## 方案

- 保留 v6 external orchestrator，只把版本标记升级到 v7。
- 新增 caveman skill family：
  - `caveman`
  - `caveman-commit`
  - `caveman-review`
  - `caveman-help`
  - `caveman-compress`
- 新增 `scripts/caveman-activate.js`，通过 SessionStart hook 注入 caveman 规则。
- `build-codex-plugin.js` 改为递归复制 skill 目录，且 caveman skill 不经过 Claude->Codex 文本替换。
- `install-codex.ps1` / `install-codex.sh` 改为递归复制 skill 目录，避免压缩脚本在用户级安装时丢失。
- 验证脚本增加 `caveman-compress/scripts/__main__.py` 检查。

## 关键坑

- 上游 `caveman-compress` 依赖 Claude API/CLI 做压缩；这些 Claude 字样是功能依赖，不是未转换残留。
- Windows 上重建 `plugins/tech-persistence/commands` 时，删除目录再创建可能让首批文件出现延迟删除；改为保留目录、覆盖文件、只删除 extra 文件。
- Python `py_compile` 会生成 `__pycache__`，验证后要清理，避免把临时产物纳入 untracked 目录。

## 验证

```powershell
node plugins\tech-persistence\scripts\build-codex-plugin.js
node scripts\agent-orchestrator.js self-test
node scripts\validate-codex-plugin.js
node scripts\validate-codex-install.js --project
node scripts\validate-codex-install.js --user
python -m py_compile user-level\skills\caveman-compress\scripts\*.py plugins\tech-persistence\skills\caveman-compress\scripts\*.py
git diff --check
```

## 使用

```text
$caveman
$caveman-commit
$caveman-review
$caveman-help
$caveman-compress <file>
```

自动激活可用：

```powershell
$env:CAVEMAN_DEFAULT_MODE = "off"
```

关闭自动激活但保留手动 `$caveman` 入口。

## Sprint 结合模式

`$sprint --caveman <需求>` 用于长任务低 token 运行：

- 对话输出走 caveman-lite/full，只报决策、风险、下一步。
- `docs/plans/*.md` 仍完整，不压缩主文档。
- checkpoint 同时写完整 handoff 和 `*-compact.md`。
- resume 先读 compact handoff，不足时再读完整 sprint 文档。
- review finding 一行一个；完整审查表仍写入 sprint 文档。

这个模式把 token 省在交互和恢复上下文上，不牺牲 sprint artifact 的准确性。
