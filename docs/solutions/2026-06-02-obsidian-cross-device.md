---
title: "Obsidian 跨终端/跨设备同步对 tech-persistence 架构的优缺点与方案"
date: 2026-06-02
tags: [solution, obsidian, cross-device, sync, parity, memory-v5]
related_instincts:
  - obsidian-sync-single-authority-only
  - append-only-jsonl-breaks-file-level-sync
  - git-remote-hash-key-portable-cwd-key-not
  - documented-claim-vs-code-reality-drift
related_solutions:
  - "[[2026-04-09-obsidian-integration]]"
  - "[[2026-05-15-persona-top-level-dimension]]"
aliases: ["Obsidian 跨设备同步", "cross-device obsidian sync", "vault multi-device"]
status: completed
---

# Obsidian 跨终端/跨设备同步对 tech-persistence 架构的优缺点与方案

## Problem

用户问：不同终端 / 不同设备之间用 Obsidian 同步本项目的知识 vault，优缺点是什么，尤其针对当前这种架构。结论是知识层天生贴合 Obsidian 跨设备同步（4 不可妥协原则里 3 条正向加分），但「多设备双写」撞两个结构性硬伤：append-only jsonl 文件级同步会丢行、Claude auto-memory 用 cwd-key 路径根本不 portable。因此桌面多设备首选 git-based 同步（与现有 pre-commit/git-tracked 零摩擦、零成本），移动端只读用官方 Obsidian Sync；任何方案都必须把 `.agent-runs/` + `*.jsonl` 排除出同步，且严禁两套同步权威叠加。

本结论由 dynamic workflow（3 路读代码 understand + 2 路 web research + 综合 + 对抗核验）产出，12 项架构 claim 经对抗核验 11 confirmed / 1 refuted（见下方 §核验勘误）。

## Root Cause

跨设备能不能用 Obsidian，取决于「知识落在哪个路径、那个路径跨机器是否稳定、文件并发写有没有冲突保护」。本项目的 load-bearing 代码事实（均 Read 核实）：

- **项目身份 key 是 git-remote-hash**：`detectProjectIdentity()`（`scripts/lib/memory-v5.js:117-147`）优先级 `git remote get-url origin` → `git-root` → `cwd`。Memory v5 homunculus 路径 `~/.claude/homunculus/projects/<id>/memory/` 的 `<id>` 仅在 `source==='git-remote'` 时跨机器稳定（克隆同一 origin → id 一致 → portable）。退化到 `git-root`（有本地 git 无 remote）或 `cwd`（非 git）时，id 含绝对路径 hash，换设备/换 checkout 路径就漂移。
- **Claude Code core auto-memory 是 cwd-key**：`~/.claude/projects/<cwd-slug>/memory/`，`cwd-slug` 由 `usage-aggregator.js:42-52` `cwdToSlug` 把绝对 cwd 小写 + 替换分隔符得到（机器特定，不 portable）。用户手写的 `feedback_*` / `user_*` 落在这；`inject-context.js` 只从 `resolveCompatReadDirs()`（v5 + compat dir）读，**不读** auto-memory → 它在 Codex 与换设备时双重不可见（既存 ADR-011 parity 违反，见 [[ADR-015]]）。
- **遥测全是 append-only 无锁**：`observations.jsonl`(`observe.js:78`) / `memory-recall.jsonl`(`memory-v5.js:601`) / `recall-usage.jsonl`(`recall-usage.js:268`) / `skill-traces` / `skill-signals` / `skill-eval-*` / `clarifications` 全 `appendFileSync`，无 flock。文件级同步工具不懂 append-only，两设备各追加尾部 → 判双向修改 → 产生 conflict copy，落败一侧的行静默丢失。SessionStart/Stop 启动即写，撞冲突概率最高。
- **配置纯文件无 DB**：`configure-shared-homunculus.js` 全 `fs.mkdirSync/copyFileSync/writeFileSync`，写 `~/.tech-persistence/config.json` 的 `homunculusHome`。`runtime-paths.js:62-76` `resolveBaseDir` 三级优先：`TECH_PERSISTENCE_HOME` env > `config.homunculusHome` > 运行时默认。任意通用同步工具可直接接管目录，无需特殊协议。
- **.obsidian 配置 repo 内 canonical 派生且幂等**：`init-obsidian-vault.js:140-179`，6 色 colorGroups + `mergeGraphColorGroups` 只覆盖 colorGroups 保留用户布局。新设备重跑 init 即重建，无需同步 `.obsidian/`。
- **`.agent-runs/` 锚定被操作项目 workdir，不在 homunculus 树内**：`agent-orchestrator.js:220-221` `resolveRunsDir = path.resolve(workdir, '.agent-runs')`，与 homunculus（`resolveBaseDir`）正交；已 gitignored（`.gitignore:2`）。

## Solution

### 优点（映射 4 不可妥协原则）

| 优点 | 原则 | 依据 |
|------|------|------|
| 知识产出 100% markdown+frontmatter，是唯一能被 Obsidian Sync 做三方 merge 的格式（并发改同笔记丢失风险最低） | ④Obsidian 兼容 | `init-obsidian-vault.js:182-304` |
| 纯文件无 DB，git/Sync/云盘/Syncthing 即插即用 | ③轻量 | `configure-shared-homunculus.js` |
| git-remote-hash key 使克隆同 origin 的多设备天然 portable | ②确定性 | `memory-v5.js:117-147` |
| git-based 同步与现有 pre-commit/drift-checker/三方一致性测试复用同一个 git | ②确定性 | `test-init-obsidian-vault.js` |
| 双运行时共享目录把 parity 收敛成「同步一个目录」 | ①parity | `runtime-paths.js:62-76` |
| `.obsidian/` 配置 repo 内幂等派生，新设备重跑 init 重建 | ②确定性 | `init-obsidian-vault.js:140-179` |

### 缺点（含核验修正）

| # | 缺点 | 严重度 | 缓解 |
|---|------|--------|------|
| 1 | append-only jsonl 文件级同步丢行 + 堆冲突副本，无 merge 可救 | high | jsonl 加 `.gitignore`，或按设备分文件 `telemetry/<device-id>/*.jsonl` 离线聚合；绝不双向同步同一 append 文件 |
| 2 | Claude auto-memory 用 cwd-key 不 portable，换设备 + Codex 双重不可见 | high | 同步范围只锁 v5 homunculus dir；高价值观察沉到 v5 的 `persona.md`（[[ADR-015]]）；跨设备前验证 `source==='git-remote'` |
| 3 | 两套同步权威叠加（共享目录 + 云盘/Sync）= corruption 共同根因 | high | 铁律：一个 vault 只能有一个同步权威，三选一 |
| 4 | `.git` 被 iCloud/Dropbox 逐文件同步 → refs 改名 → repo corruption | medium | git 自己做权威（push/pull），`.git` 不进云盘 |
| 5 | 移动端是非官方方案共同短板，海量小 jsonl 触发重索引死循环（obsidian-git/Syncthing iOS 不稳/无支持） | medium | 移动端只读 + 官方 Sync，排除 jsonl/.agent-runs |
| 6 | `.obsidian/workspace.json` 双向同步永久冲突循环 | low | 不同步整个 `.obsidian/`，各设备本地重建 |
| 7 | `projects.json` 注册表无 lock，并发写竞态 | low | 单一活跃写权威；git merge 暴露冲突 |
| 8 | ~~`.agent-runs/` 在 homunculus 树内会被一并同步~~ → **核验推翻**：`.agent-runs/` 锚定被操作项目 workdir，与 homunculus 正交；仅当用户把 vault 本身当同步根且在其中跑 agent-loop 才会被同步，常规分离布局下不存在 | low-conditional | git 同步因 `.gitignore` 天然豁免；云盘/Syncthing 仍在其自身 ignore 排除 `.agent-runs/` |

### 推荐方案（按场景）

1. **单人多设备、知识只读 recall**：git-based 同步作唯一权威 + jsonl/`.agent-runs` gitignore + 新设备克隆同 origin 后重跑 `init-obsidian-vault.js`。契合度最高、风险最低。
2. **多设备双写**：仍 git 唯一权威；markdown 走正常 commit/merge（冲突显式暴露不静默丢），所有 `*.jsonl` 加 `.gitignore` 或按设备分文件离线聚合，`projects.json` 靠 git merge 暴露冲突，严禁叠云盘/Sync。
3. **移动端查看**：官方 Obsidian Sync 作移动端权威，Excluded folders 排除 `.agent-runs`/`*.jsonl`/`telemetry`/`archive`/`workspace*.json`；或给移动端建只含 markdown 的裁剪子 vault。桌面那条链与移动那条链不要在同一目录叠加。
4. **双运行时 + 跨设备**：先 `configure-shared-homunculus --path <共享目录>` 在每台设备收敛 parity，再 git 同步该目录作唯一跨设备权威；auto-memory（cwd-key）那半放弃同步，靠 `persona.md` 走 v5 dir 获跨设备 + Codex 可见。

### 核验勘误（doc-vs-code drift guard）

对抗核验阶段对综合分析的「当前架构」事实性 claim 逐条对代码复核，发现 1 处 drift：综合稿原把「`.agent-runs/` 位于 homunculus 路径树内」当 medium con，核验用 `agent-orchestrator.js:220-221` 推翻（锚定 workdir），降级为 low-conditional 并改写前提。其余 11 项（git-remote-hash key、cwd-key auto-memory、append-only 无锁、`configure-shared-homunculus` 行为、三级 `resolveBaseDir`、`resolveCompatReadDirs` 不读 auto-memory、hit_rate 供给侧语义、6 色 colorGroups、`projects.json` 无 lock 等）confirmed。这是 [[documented-claim-vs-code-reality-drift]] 在「分析 claim」维度的又一次成功拦截：分析外部/自身架构得出的事实断言，必须对代码核实再落盘。

## Prevention

- 任何「跨设备/跨运行时同步本项目知识」的方案，先问三件事：(1) 落在 git-remote-hash key 还是 cwd-key 路径？(2) 涉及的文件是 markdown（可 merge）还是 append-only jsonl（会丢行）？(3) 同步权威是不是唯一？
- 跨设备同步范围默认只锁 v5 homunculus dir 的 markdown；`*.jsonl` / `.agent-runs/` / `.obsidian/workspace*.json` 一律排除。
- 给用户的同步指引必须显式写「单一同步权威」铁律——本项目共享目录机制无意中抬高了「共享目录 + 再叠云盘」的双权威 corruption 风险。

### 已落地机制（2026-06-02）

high-severity 缓解已从「文档建议手动配置」升级为「init 自动生成」：`init-obsidian-vault.js` 引入 `SYNC_EXCLUDES` 单一事实源 + 三投影（`.obsidianignore` / `.gitignore` / `.stignore`），git/Syncthing 用户开箱排除 `*.jsonl`、`.agent-runs/`、`.obsidian/workspace*.json`（`.stignore` 另含 `.git/`）。Obsidian Sync/iCloud/Dropbox 不读 vault 内 ignore，仍需 App 内手动排除。实现见 `docs/plans/2026-06-02-obsidian-cross-device-sync-hardening.md`。
