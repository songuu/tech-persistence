# 踩坑记录 & 调试经验

> 按严重程度排列。高置信度的调试本能 (/instinct-status domain:debugging) 毕业后写入此处。
> 由 /learn 和 /debug-journal 自动追加。

## CRITICAL — 必须知道

## HIGH — 容易踩到

- 已有 Claude Code `settings.json` 缺 hook 时不能只提示手动合并；否则命令、rules、hook 脚本都在但 `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop` 不运行，学习层静默失效。安装器必须用 JSON 结构化 merge 补齐 hooks，并用 `node scripts/validate-claude-install.js --user` / `--project` 验证。
- 读取 sprint / memory frontmatter 的状态字段时不能用 first-match regex；重复 `status` 会让已完成文档被误判为 active。复用共享 `parseFrontmatter()` 或显式实现 last-write-wins，并为 duplicate status 写回归测试。
- Hook 脚本一旦新增 `scripts/lib/*` 依赖，必须同步更新安装脚本和 Codex plugin 构建脚本；否则用户环境中的 hook 会因 `Cannot find module './lib/...'` 静默失效。验证时至少跑 `node plugins/tech-persistence/scripts/build-codex-plugin.js`、`node scripts/validate-codex-plugin.js` 和临时 `TECH_PERSISTENCE_HOME` smoke test。
- Memory v5 不能用 first-hit fallback 读取 `MEMORY.md`；Claude Code 和 Codex 默认目录都可能有 durable topic notes。SessionStart 应合并 `resolveCompatReadDirs()` 下的 topic entries，并用 `node scripts/smoke-memory-parity.js` 验证双向可见。

## MEDIUM — 偶尔遇到

## LOW — 边缘情况
