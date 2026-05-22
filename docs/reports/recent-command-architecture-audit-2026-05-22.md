# 近几天命令与架构优化审计报告

> 生成时间: 2026-05-22  
> 审查对象: `29c4750^..18b2847`  
> 范围: 仅已提交改动；当前未提交 diff 不进入 findings

## TL;DR

- 总体风险: L3。触及命令协议、hook、上下文注入、checkpoint/resume、审查协议、安全扫描与 Figma fidelity guard，属于跨 runtime / projection / state artifact 变更。
- P0: 0 个。
- P1: 3 个。最高风险是 Codex classic hooks 指向 `~/.claude` 路径并静默吞错、SessionStart handoff 检测仍读取旧顶层路径、recent commit 重新提交顶层 handoff 文件并包含本机绝对路径。
- P2: 4 个。主要是 Figma audit 可执行入口与覆盖信号不够硬、allow-file 逃逸过宽、`.agents/skills/source-command-*` 缺少验证链路、`/review` Codex projection 的 spawn/fallback 命名容易误导。
- 建议立刻修: P1-1 / P1-2 / P1-3。P2 可跟随下一轮 hardening。

## 审查范围

### 已包含提交

| commit | date | subject |
|---|---|---|
| `29c4750` | 2026-05-19 | `feat(sprint): enforce cross-sprint entry checklist and enhance task completion requirements` |
| `d70cae9` | 2026-05-21 | `feat(agents): add new skills for debugging, learning, and retrospective processes` |
| `13a89f1` | 2026-05-22 | `feat(sprint): implement new follow-up strategies and enhance documentation` |
| `18b2847` | 2026-05-22 | `feat: enhance Figma fidelity protocol and update command documentation` |

### 已包含文件面

- 命令/skill projection: `user-level/commands`, `.codex/commands`, `.codex/skills`, `plugins/tech-persistence/commands`, `plugins/tech-persistence/skills`。
- Hook/context: `.codex/hooks.json`, `scripts/inject-context.js`, `plugins/tech-persistence/hooks/inject-context.js`。
- 新增脚本: `scripts/secret-scan-on-demand.js`, `scripts/figma-fidelity-audit.js`, `scripts/validate-gsd-eval-docs.js`。
- 新增规则/模板/docs: `figma-fidelity.md`, `docs/templates/figma-*`, GSD/Figma/sprint plan 与 solution 文档。

### 已排除

当前工作区存在未提交变更，按用户选择不进入本报告 findings：

```text
M .claude/rules/debugging-gotchas.md
M AGENTS.md
M CLAUDE.md
M docs/plans/2026-04-23-homunculus-sharing-handoff-2.md
M docs/plans/2026-04-23-homunculus-sharing-handoff-3.md
M docs/solutions/index.jsonl
?? docs/plans/2026-04-23-homunculus-sharing-handoff-4.md
?? docs/solutions/2026-05-22-gstack-design-lens-double-track.md
?? docs/solutions/2026-05-22-phase-warmup-protocol-rollback.md
```

## Findings

| # | 文件:行 | 风险 | 问题 | 影响 | 修复建议 | 验证方式 |
|---|---|---|---|---|---|---|
| P1-1 | `.codex/hooks.json:9`, `:21`, `:33`, `:44` | P1 | Codex hook 配置直接执行 `node ~/.claude/skills/continuous-learning/hooks/... 2>/dev/null || true`。这是 `.codex` 文件，却固定依赖 Claude classic skill 路径，并且所有错误都静默吞掉。 | Codex classic hook 可能完全不注入 Memory v5、不记录观察、不执行 Stop 学习；如果 `~/.claude` 有旧副本，还会跑 stale runtime。`validate-codex-plugin.js` 只校验 plugin hook，不覆盖 `.codex/hooks.json`，因此该问题可长期潜伏。 | 明确 `.codex/hooks.json` 的定位：如果它是 Codex classic 配置，改为 `.codex`/plugin-safe runner 或删除并只保留 plugin hooks；如果仍需兼容 Claude classic，文件名/安装路径不能放在 `.codex` 下。把 `.codex/hooks.json` 纳入 `validate-codex-plugin.js` 或单独 hook validation。 | `rg -n "node ~/.claude" .codex/hooks.json` 应无命中；新增 validator 断言 `.codex/hooks.json` 不引用 `~/.claude`。 |
| P1-2 | `scripts/inject-context.js:206-218`, `:337`; `plugins/tech-persistence/hooks/inject-context.js:206-218`, `:337` | P1 | `detectPendingHandoff()` 仍只扫描 `docs/plans/` 顶层，并输出 `文件: docs/plans/${handoff.file}`；但 `/checkpoint` 和 `/sprint resume` 协议已经改为 `docs/plans/.handoff/`。 | 新 checkpoint 按新协议进入 `.handoff/` 后，SessionStart 的最高优先级恢复上下文会漏掉它。用户以为 checkpoint/resume 已治理，实际自动注入路径断裂。 | `detectPendingHandoff()` 同时支持 `docs/plans/.handoff/` 与 legacy 顶层路径，优先 `.handoff/`，caveman mode 优先 compact handoff；报告路径也应输出 `docs/plans/.handoff/<file>`。导出该函数并补测试。 | 创建临时 `.handoff/*-handoff-1.md` fixture 的单测；运行 `node scripts/run-tests.js --grep inject`。 |
| P1-3 | `docs/plans/2026-04-23-homunculus-sharing-handoff-2.md:2`, `:21-35`; `docs/plans/2026-04-23-homunculus-sharing-handoff-3.md:2`, `:21-35`; `.gitignore:4` | P1 | recent commits 重新提交了顶层 `docs/plans/*-handoff-*.md`，且文件内容包含 `c:\project\...` 与 `C:\Users\songyu\.claude\...` 绝对路径。与此同时 `.gitignore` 已声明 `docs/plans/.handoff/`。 | 违反 checkpoint handoff 治理目标：handoff 继续污染 git 历史，且 durable docs 暴露本机路径/用户目录结构。secret scan 不会捕获这类隐私路径。 | 从已提交范围移除这些 ephemeral handoff，必要时移入本地 `.handoff/` 不追踪；新增 pre-commit 规则阻止新增 `docs/plans/*-handoff-*.md` 顶层文件；handoff 生成时将本机绝对路径归一成 repo-relative 或 `[local-memory]`。 | `git ls-files docs/plans | rg "handoff"` 只应命中正式治理文档，不应命中 auto-checkpoint；`git check-ignore -v docs/plans/.handoff/test.md` 应命中 `.gitignore:4`。 |
| P2-1 | `package.json:11`; `scripts/figma-fidelity-audit.js:46-49` | P2 | `package.json` 新增 `figma:audit`，但脚本本身要求 `--paths`；裸跑 `npm run figma:audit` 会以 usage error 退出。 | 用户或 CI 看到 npm script 以为有默认审计入口，实际不能直接用；容易被误接入自动化后稳定失败。 | 改成可用入口，例如 `node scripts/figma-fidelity-audit.js --paths <changed-files>` 的 wrapper，或拆成 `figma:audit:changed` / `figma:audit:paths`。至少在 README 或 rule 中写明必须传 paths。 | 运行 `npm run figma:audit -- --paths docs/templates .codex/rules user-level/rules` 或新增 wrapper 测试。 |
| P2-2 | `scripts/figma-fidelity-audit.js:91-120`, `:240` | P2 | 当传入路径全部不可扫描或只有 Markdown/rule/template 文件时，CLI 输出 `clean (0 file(s) scanned)` 并 exit 0。本次计划验证命令就出现了这个状态。 | 自动化可能把“没有扫描任何 UI 文件”误读成“Figma fidelity 已通过”。这对 1:1 还原目标是 coverage gap，不是 clean signal。 | 非 JSON 输出里打印 skipped count；当用户显式传入 paths 但 `files.length === 0` 时默认 exit 2，除非传 `--allow-empty`。报告中也应区分 `clean` 与 `no scannable files`。 | `node scripts/figma-fidelity-audit.js --paths docs/templates .codex/rules user-level/rules` 应返回明确 no-op 状态，而不是 clean。 |
| P2-3 | `scripts/figma-fidelity-audit.js:41`, `:171`; `scripts/test-figma-fidelity-audit.js:94` | P2 | 任意文件包含 `figma-fidelity-audit: allow-file` 即整文件跳过，且不要求 reason、owner 或过期条件。 | 1:1 fidelity guard 可以被单行注释永久绕过；后续 review 很难判断是合理例外还是逃逸。 | 要求 `allow-file` 带 reason，例如 `figma-fidelity-audit: allow-file <ticket/reason>`；JSON 输出报告 allow-file 计数；对业务 UI 文件禁止 file-level allow，只允许 line-level allow。 | 新增测试：无 reason 的 allow-file 返回 finding 或 usage error；有 reason 时 JSON 包含 `allowlist` 元数据。 |
| P2-4 | `.agents/skills/source-command-debug-journal/SKILL.md:1-4`; `.agents/skills/source-command-learn/SKILL.md:1-4`; `.agents/skills/source-command-retrospective/SKILL.md:1-4` | P2 | 新增 `.agents/skills/source-command-*` 三个技能，但现有 `validate-codex-plugin.js`、`pre-commit-check.js`、`run-tests.js` 都不验证 `.agents/skills` frontmatter、trigger clarity 或与既有 `.codex/commands/{learn,debug-journal,retrospective}.md` 的关系。 | skill parser 或触发描述出问题时，现有验证全绿；同时同名语义存在两套入口，后续维护者可能不知道该改 source-command skill 还是 user-level command。 | 新增轻量 `validate-agent-skills`：校验 frontmatter、description trigger、命名约定、是否与现有命令冲突；在报告或 AGENTS 中说明 `.agents/skills/source-command-*` 是 project-source command wrapper，不是 user-level command 的替代。 | `node scripts/validate-agent-skills.js` 或并入 `node scripts/validate-codex-plugin.js`。 |
| P3-1 | `.codex/commands/review.md:112-115`, `:280-293`; `.codex/skills/review/SKILL.md:125-128`, `:293-306` | P3 | Codex projection 把 spawn-capable runtime 写成 `Codex`，fallback 又写成 `Codex CLI`。在真实 Codex surface 中，“是否有 Agent tool”取决于宿主能力，不等同于名字叫 Codex。 | 用户可能以为所有 Codex 环境都能按 Agent spawn 协议并行审查；无 spawn tool 的运行面仍需 inline fallback。 | 文案改成能力命名：`Agent-spawn-capable runtime` vs `inline-only runtime`；示例里避免把 `Codex` 当能力判断。 | grep review 文档，确保 capability gate 不再依赖 runtime name。 |

## Gap Detection Walkthrough

| workflow / invariant | existing coverage | uncovered gap | action |
|---|---|---|---|
| Codex/Claude hook runtime parity | `node scripts/validate-codex-plugin.js` 通过，plugin hook registry 通过 | `.codex/hooks.json` 不在 validator 覆盖面，且指向 `~/.claude` | P1-1 |
| checkpoint/resume handoff path | `checkpoint.md` / `sprint.md` 已文档化 `.handoff/`，`.gitignore` 命中 `.handoff/` | `inject-context.js` 仍只读顶层；recent commit 仍提交顶层 handoff | P1-2, P1-3 |
| command / skill projection sync | `validate-codex-plugin.js` 通过；plugin commands/skills inventory 与 source 匹配 | `.agents/skills` 不在 sync/validation 链中 | P2-4 |
| `/review` GSD gap detection | review 文档已有 Gap Detection Walkthrough、risk-aware dispatch、design lens 双轨 | runtime capability naming 仍可能误导；没有执行级测试，只是协议文档 | P3-1 |
| secret scan | `node scripts/secret-scan-on-demand.js --paths scripts .codex plugins user-level docs --include-untracked --json` clean，390 files scanned | 本机绝对路径/隐私路径不属于 secret pattern，仍可进 git | P1-3 |
| Figma fidelity guard | `node scripts/run-tests.js --grep "figma|inject|secret"` 通过；CLI 能检测 hardcoded hex/rgb/px | planned verification paths 扫描 0 文件仍 exit 0；`allow-file` 逃逸过宽；npm script裸跑不可用 | P2-1, P2-2, P2-3 |
| phase warmup rollback vs sprint protocol | `sprint.md` 已写 “Phase 间预热协议（建议，非强制）”，且 rollback solution 明确不 enforcement | 未发现和 cross-sprint checklist 的直接冲突；cross-sprint checklist 是另一套强制 anti-drift 协议 | no finding |

## 验证记录

| command | result |
|---|---|
| `git diff --name-status 29c4750^..18b2847` | exit 0；62 个文件触达。 |
| `git diff --check 29c4750^..18b2847` | exit 0；无 whitespace error。 |
| `node scripts/run-tests.js --grep "figma|inject|secret"` | 沙箱内首次失败：`spawnSync C:\nvm4w\nodejs\node.exe EPERM`；按权限规则沙箱外重跑通过，3/3 test files pass，18/18 assertions pass。 |
| `node scripts/validate-codex-plugin.js` | exit 0；plugin inventory、hook registry、require closure、generated parity 全部通过。 |
| `node scripts/pre-commit-check.js` | exit 0；无输出。注意：该命令只看 staged changes，本次工作区未 staged，因此只能证明 hook 自身未报错，不能证明 committed range 全面受检。 |
| `node scripts/secret-scan-on-demand.js --paths scripts .codex plugins user-level docs --include-untracked --json` | exit 0；`findings: []`，`scannedFiles: 390`，`skippedFiles: 0`。 |
| `node scripts/figma-fidelity-audit.js --paths docs/templates .codex/rules user-level/rules` | exit 0；输出 `clean (0 file(s) scanned)`。按本报告 P2-2，0 scanned 不应等价于 fidelity clean。 |
| `node scripts/validate-gsd-eval-docs.js` | exit 0；额外检查，GSD eval doc validation passed。 |
| `git check-ignore -v docs\plans\.handoff\test.md` | exit 0；命中 `.gitignore:4:docs/plans/.handoff/`。 |
| `git ls-files docs/plans \| rg "handoff"` | exit 0；仍命中两个 auto-checkpoint handoff 和一个治理 sprint 文档，支撑 P1-3。 |

## 结论

这轮新增机制方向正确：GSD 借鉴没有引入外部 runtime；Figma fidelity guard 保持零依赖；secret scan 是 on-demand 而非过度 pre-commit；`/review` 增加 Gap Detection Walkthrough 也贴合当前 anti-drift 需求。

主要漏洞不在单个脚本逻辑，而在分发/恢复链路的真实工作流断点：`.codex/hooks.json` 没进验证链、`.handoff/` 协议没有同步到 SessionStart 注入、handoff ephemeral artifact 又进入 git。优先修完 3 个 P1 后，再收紧 Figma audit 的 no-op/allowlist 信号和 `.agents/skills` 验证面。
