# 踩坑记录 & 调试经验

> 按严重程度排列。高置信度的调试本能 (/instinct-status domain:debugging) 毕业后写入此处。
> 由 /learn 和 /debug-journal 自动追加。

## CRITICAL — 必须知道

## HIGH — 容易踩到

- [2026-05-11] [claude-code, hooks, installer] **已有 `settings.json` 缺 hook 时不能只提示手动合并**。命令、rules、hook 脚本都复制成功但 settings 没有 `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop`，会形成“安装看似完成、学习层实际不跑”的静默失效。安装器必须用 JSON 结构化 merge 保留现有配置并补齐 hook；验证必须跑 `node scripts/validate-claude-install.js --user` 和 `--project`。
- [2026-05-11] [agent-loop, provider-errors] **`claude -p --output-format json` 的错误内容写在 stdout，不是 stderr**。401 / 429 / quota 等场景 claude CLI 写 `{is_error:true, api_error_status:401, result:"Failed to authenticate. API Error: 401 Invalid bearer token"}` 到 **stdout**，stderr 留空，进程 exit code = 1。当时 orchestrator 报错只指向 stderr（`see stderr.log`），用户打开看到空文件，会以为是代码 bug，根因被掩埋。修复：`runProcess` 在 status≠0 时先尝试解析 stdout 的 envelope（`is_error / api_error_status / result`）并把人类可读的 `result` 字段拼进错误消息；报错路径同时给出 stdout 和 stderr。预防：（1）新增 provider 类调用一律走 `runProcess`（中央化错误处理），不要直接 `spawnSync` 后自己抛 "see stderr"；（2）`doctor --probe` 用最小调用真打一次 claude / codex，提前暴露认证 / token 失效；（3）跨副本同步必须 `node plugins/tech-persistence/scripts/build-codex-plugin.js` + `node scripts/validate-codex-plugin.js`，agent-orchestrator.js 是 git tracked 派生文件。
- Hook 脚本一旦新增 `scripts/lib/*` 依赖，必须同步更新安装脚本和 Codex plugin 构建脚本；否则用户环境中的 hook 会因 `Cannot find module './lib/...'` 静默失效。验证时至少跑 `node plugins/tech-persistence/scripts/build-codex-plugin.js`、`node scripts/validate-codex-plugin.js` 和临时 `TECH_PERSISTENCE_HOME` smoke test。
- Memory v5 不能用 first-hit fallback 读取 `MEMORY.md`；Claude Code 和 Codex 默认目录都可能有 durable topic notes。SessionStart 应合并 `resolveCompatReadDirs()` 下的 topic entries，并用 `node scripts/smoke-memory-parity.js` 验证双向可见。
- [2026-05-09] [docs, dispatch] **CLI 用法 section 列出的子命令必须在执行规则 section 显式分派**。`/agent-loop doctor` 之前被吞进"不是 freeze/resume/status 时 → run --requirement"分支，AI 真把 `doctor` 当成需求字符串创建了新 run。预防：用法表的每行子命令在 dispatch section 都要有对应 case；fallback 条件必须列出全部已知子命令的反集。
- [2026-05-09] [orchestrator, state-migration] **持久化 state 新增字段必须在反序列化入口做 default**。`state.providerRuns.push(...)` 在 v6 → v7 时炸 — 旧 state.json 没有 `providerRuns` 字段，`undefined.push()` 直接 crash。修复：`loadRun()` 入口处统一 `if (!Array.isArray(state.providerRuns)) state.providerRuns = [];`，不要在每个调用点判。
- [2026-05-09] [hooks, observability] **`try { ... } catch {}` 是不可观察的失效**。`caveman-activate.js` 之前吞所有异常返回 0，hook 静默失效用户无感知。规则：hook 不能 crash 主会话，但 catch 块必须 `process.stderr.write('[hook] failed: ${msg}\n')` 至少留下一行日志。
- [2026-05-09] [multi-copy] **git tracked 派生文件必须靠 propagation 脚本同步，不能手工 Edit**。本项目 `.codex/commands/*.md` 是从 `user-level/commands/*.md` 经 `Claude Code → Codex` regex 派生的，被 git tracked。改一次源 → 4 个副本 → 9 个命令 = 36 个手工 Edit，错误率不可控。规则：发现 git tracked 派生文件 → 先找 install/build 脚本里的 transformation 规则 → 写 `scripts/propagate-*.js` 一次性同步。本次产物：`scripts/propagate-command-changes.js`。

- [2026-04-15] [powershell, encoding] **本项目生成的 .ps1 脚本必须带 UTF-8 BOM**
  - 现象：PS 脚本执行时中文变乱码（如 `测试` → `娴嬭瘯`），tokenizer 报 "ExpressionsMustBeFirstInPipeline"、"一元运算符 + 后面缺少表达式"、"语句块中缺少右 }" 等一连串语法错，看似脚本被整体破坏。
  - 根因：中文 Windows 系统 ACP = 936 (GBK)。PowerShell 5.1 对 **无 BOM** 的 .ps1 用系统 ANSI 码页解码。UTF-8 字节被当 GBK 解析后，中文字符变成非法标识符/运算符序列，tokenizer 级联崩塌。**与脚本逻辑无关**，纯编码问题。
  - 快速识别：错误行号集中在含中文的行、并且错误类型是"意外的标记"/"缺少表达式"而非运行时错误 → 99% 是 BOM 问题。
  - 修复：前置 3 字节 `EF BB BF`，PS 5.1 见 BOM 走 UTF-8 路径。bash 一行：`{ printf '\xef\xbb\xbf'; cat file.ps1; } > file.ps1.tmp && mv file.ps1.tmp file.ps1`。
  - 预防：本项目所有 .ps1（install / update / apply-*-delta 系列）生成时必须写 BOM。PowerShell 7+（pwsh）默认 UTF-8，但不能依赖用户已装 PS7——必须向下兼容 PS 5.1。
  - 历史：已踩 2 次。commit b6dc85f 修 `update.ps1`，2026-04-15 又在 `test-strategy-delta/apply-test-delta.ps1` 复现。第三次出现 = 工具链应自动化（脚本生成器强制写 BOM）。

## MEDIUM — 偶尔遇到

## LOW — 边缘情况
