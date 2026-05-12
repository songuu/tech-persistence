# 踩坑记录 & 调试经验

> 按严重程度排列。高置信度的调试本能 (/instinct-status domain:debugging) 毕业后写入此处。
> 由 /learn 和 /debug-journal 自动追加。

## CRITICAL — 必须知道

## HIGH — 容易踩到

- [2026-05-12] [hooks, shell-mismatch, windows] **Claude Code 在 Windows 上通过 Git Bash 执行 hook command，不是 cmd.exe**（**已踩 2 次** — 2026-04-09 初次发现并修，后重构回归，2026-05-12 二次修复）。`~/.claude/settings.json` 里的 hook command 若写 cmd 风格 `2>nul || exit /b 0`，在 bash 里 `2>nul` 会被解释为「stderr 重定向到当前目录下名为 `nul` 的真实文件」（每次 hook 触发都创建/覆盖 0 字节文件），`exit /b 0` 是无效语法但因 `||` 短路从未执行所以不可见。证据：(1) `nul` 是 Windows 保留设备名，cmd.exe 永远无法在文件系统创建同名文件；能在仓库根目录看到 `?? nul` 就反证执行环境是 bash；(2) 同 settings 的 statusLine 也是 `bash -c '...'`。规则：hook command 永远用 POSIX 语法 `2>/dev/null || true`——bash 直接生效，cmd 路径下 `/dev/null` 虽是字面但 `|| true` 短路兜底。回归预防：纯文档协议 enforcement 已证明抵不住重构；下一道防线应该是 **CI/test 检查**，对所有安装产物（`install.ps1` 生成的 settings、`merge-claude-settings-hooks.js` 输出）断言 hook command 不含 `2>nul` / `exit /b`。本项目污染源（2026-05-12 修复）：`install.ps1:60-63` 模板 + `scripts/merge-claude-settings-hooks.js:61` windows 分支 + 旧 solution `docs/solutions/2026-04-09-obsidian-integration.md` 把错误经验记录在案（已加 errata）。
- [2026-05-12] [enforcement, dogfood] **新 enforcement（pre-commit / lint / CI reject）合并前必须枚举 ≥3 个已有同类产物验证不被误拒**。本仓库刚加 pre-commit hook 时，dogfood 只测了"我刚写的 plan 通过"+"破坏一次再恢复"，**没枚举本仓库 6+ 个无 frontmatter 旧 plan**。Phase 4 reviewer 才发现：hook 上线第一天就阻塞合法的旧 plan 修订，用户必须 `--no-verify` 绕过——enforcement 最差启动状态。修复：grandfather signal 改用 filename date（`PLAN_PATH_RE` 强制 capture，独立于 frontmatter），一次性解决无-FM / CRLF / 不可解析 created 三个失效。规则上升为 [[ADR-013]]：plan 阶段「关键假设验证」段必须含「会拒绝哪些现有产物」枚举。
- [2026-05-12] [metadata, signal-source] **filename 比 frontmatter 鲁棒——优先用 git-enforced metadata**。当 metadata 既在 filename 也在 frontmatter（plan / solution / changelog），filename 是 path-regex 强制（不匹配 pattern 根本不进 list），frontmatter 是 author-discipline-enforced。Grandfather / 类型判定 / 时间窗口类决策应优先 filename。Frontmatter 只适合可变状态（status / tags / aliases），不适合不变事实（created / type / date）。
- [2026-05-12] [tests, fail-open] **fail-open 系统的"成功"测试必须额外断言 fail-open marker 不在输出中**。任何 hook / lint / CI 用 exit 0 同时承担"通过"和"已禁用"两个语义时，单测 `assert(exit === 0)` 不区分这两种情况——hook 整体失效时所有"通过"测试还会绿。规则：在所有 pass 类 scenario 末尾加 `assert(!/<fail-open-marker>/.test(stderr))`。本项目 fail-open marker 例子：`hook 内部异常已忽略` / `fail-open 放行` / `[hook] failed:`。
- [2026-05-12] [error-message, ux] **error 输出中的"修复方式"必须 copy-paste runnable，不能含未替换占位符**。`<cmd>...`、`[--flags <value>]` 风格的占位符让用户每次 failure 都做"读 mismatch → 提取 basename → 区分类型 → 拼参数"4 步翻译。规则：error formatter 从 finding records 派生具体值（cmd 名 / rule 名 / 文件路径）；唯一例外是"模板让用户填空"（如 plan-lint 给的「关键假设验证」段模板），此时模板格式要清晰、有 `<占位>` 标记。
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
