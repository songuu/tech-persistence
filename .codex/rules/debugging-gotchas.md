# 踩坑记录 & 调试经验

> 按严重程度排列。高置信度的调试本能 (/instinct-status domain:debugging) 毕业后写入此处。
> 由 /learn 和 /debug-journal 自动追加。

## CRITICAL — 必须知道

## HIGH — 容易踩到

- Hook 脚本一旦新增 `scripts/lib/*` 依赖，必须同步更新安装脚本和 Codex plugin 构建脚本；否则用户环境中的 hook 会因 `Cannot find module './lib/...'` 静默失效。验证时至少跑 `node plugins/tech-persistence/scripts/build-codex-plugin.js`、`node scripts/validate-codex-plugin.js` 和临时 `TECH_PERSISTENCE_HOME` smoke test。

## MEDIUM — 偶尔遇到

## LOW — 边缘情况
