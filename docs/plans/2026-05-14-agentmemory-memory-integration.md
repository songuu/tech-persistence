---
title: "agentmemory 与 Tech Persistence Memory 接入方案"
type: plan
status: completed
created: "2026-05-14"
updated: "2026-05-14"
source_repo: "https://github.com/rohitg00/agentmemory"
scope: "memory-retrieval, prompt-aware-recall, mcp-tools, optional-agentmemory-bridge"
priority_order: [prompt-aware-recall, native-mcp, agentmemory-bridge]
tags: [plan, memory, agentmemory, codex, claude-code, mcp, hooks]
aliases: ["agentmemory-integration", "memory-recall-upgrade"]
---

# agentmemory 与 Tech Persistence Memory 接入方案

> 目标：在不破坏当前 Codex / Claude Code 双运行时架构的前提下，吸收 agentmemory 中可直接复用的 memory 检索、MCP 工具面、prompt-aware recall 和可选 bridge 思路。

---

## 0. 项目身份界定（前置）

> 必须在任何 ROI / 矩阵评估之前回答。参见 ADR-011 identity-question-first。

**本项目是什么？**

Tech Persistence = **developer-toolchain self-evolution sibling**。不是 gstack 的替代，不是 gbrain 的替代，也不是 agentmemory 的替代。本评估中 agentmemory **仅作为参考来源**，不是合并目标。

**4 条不可妥协原则**

1. **多运行时 parity**：任何能力必须 Codex 与 Claude Code 同时可用，不接受 Codex-only。
2. **确定性优先**：检索与注入逻辑必须可复现、可 grep 验证，不引入 vector / 黑盒模型作为 P1 路径。
3. **轻量优先**：默认安装零外部进程、零数据库、零 Docker；可选 bridge 必须 opt-in。
4. **Obsidian 兼容**：Memory v5 markdown 仍是 source of truth，所有派生格式不能破坏 frontmatter / `[[link]]` 语义。

**agentmemory 在本项目中的定位**

| 维度 | agentmemory | 本项目对应 |
|---|---|---|
| 存储 | 自有数据库 + viewer | Memory v5 markdown（不替换） |
| 检索 | BM25 + vector + graph | 本地 deterministic search（参考其评分维度） |
| 工具面 | 大型 MCP tool surface（README/manifest 对数量有 50/51 表述差异） | 本项目自有 `tp_memory_*` 4-6 tools（参考其 MCP 暴露方式，不追求数量 parity） |
| Hook | 6 hooks | 本项目沿用现有 4 hooks，新增 1 `UserPromptSubmit`（参考触发时机） |

候选评级映射 4 条原则：

- 违反「多运行时 parity」→ 不接（Codex-only、Claude Code-only 一律拒）
- 违反「确定性优先」→ 推迟（vector / graph 进入 Phase 后期评估）
- 违反「轻量优先」→ 默认 opt-out（agentmemory full plugin 并装、Docker 依赖）
- 违反「Obsidian 兼容」→ 拒（任何要求把 markdown 迁移成私有格式后再读回的方案）

§4 矩阵的"建议"列即按此规则推导得出。

---

## 关键假设验证（ADR-012 强制）

（plan §0.5）

本 plan 的所有"路径 + 行号"引用必须有勘察记录，否则 Phase 1 实施会基于过期假设拍板。已勘察项给出实际状态、备注；待验证项给出触发 phase 与验证方式；新发现移入「已勘察」并修订 plan 对应段。

**已勘察 ✅**

| 引用 | 实际状态 | 备注 |
|---|---|---|
| `scripts/inject-context.js:254-265` 注入 Auto Memory v5 | ✅ 准确 | 但 `:252-253` 还有 `detectActiveSprintTags()` + `prioritizeTopics` 透传，§2.3 / §2.4 / §6.3 已据此修正 |
| `scripts/lib/memory-v5.js:507-539` `loadUnifiedMemoryIndex` | ✅ 准确 | 入参 `options.prioritizeTopics` 已透传给 `selectMemoryIndexEntries` |
| `scripts/lib/memory-v5.js:410-430` 选择 entry 逻辑 | ⚠️ 部分准确 | 已含 `prioritizeTopics` 重排（2026-05-11 sprint speed layer1 引入），不再是"纯 topic priority + recency"。原 plan §2.3 描述需修订（已处理） |
| `plugins/tech-persistence/.codex-plugin/plugin.json:21-22` 无 `mcpServers` | ✅ 准确 | 只有 `skills` + `hooks`，Phase 2 加 `mcpServers` 字段是正确方向 |
| agentmemory `plugin/.codex-plugin/plugin.json` | ✅ 准确 | raw manifest 当前为 `"mcpServers": "./.mcp.json"` + `"hooks": "./hooks/hooks.codex.json"`，可借鉴 manifest shape，但不代表其 MCP server 放在 plugin 内部 |
| agentmemory `plugin/hooks/hooks.codex.json` | ✅ 准确 | Codex 注册 6 hooks：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `PreCompact` / `Stop` |
| agentmemory `plugin/scripts/prompt-submit.mjs` | ✅ 关键修正 | `UserPromptSubmit` 脚本实际是把 prompt POST 到 `/agentmemory/observe`，**不**向 stdout 注入 recall context；其 statusMessage 写 "recalling" 不能当作实现证据 |
| agentmemory `plugin/scripts/session-start.mjs` | ✅ 准确 | `AGENTMEMORY_INJECT_CONTEXT=true` 时才向 stdout 输出 context；默认仅注册 session |
| agentmemory README Search / MCP tools | ⚠️ 部分准确 | README 确认 BM25 + vector + graph + RRF 与 CJK optional segmenters；但 tool count 在 README/manifest 中存在 50/51 表述差异，本文不追求 count parity |

**待验证 ⏳（实施前必跑）**

| 假设 | 触发 phase | 验证方式 |
|---|---|---|
| `UserPromptSubmit` 在 Codex 与 Claude Code 两端是否都支持 `hookSpecificOutput.additionalContext` | Phase 1 实施前 | 写最小 hook 输出 JSON，在两端验证上下文是否进入模型；若任一端不支持，则 Phase 1 降级为 SessionStart query cache / MCP recall，不直接上 UserPromptSubmit 注入 |
| UserPromptSubmit 召回与 SessionStart 注入的去重机制 | Phase 1 实施前 | v1 默认不做硬去重，靠 score threshold + 小预算降噪；若 dogfood 出现重复，再引入 ephemeral injected-id 文件。不要假设 `MEMORY.md` index 中有 marker |
| `${CLAUDE_PLUGIN_ROOT}` 占位符在 Codex 与 Claude Code 两端均可解析 | Phase 2 实施前 | 写一个最小 mcpServers 配置，分别在 Codex 和 Claude Code 启动 + 读 server log 确认 args 展开 |
| 现有 ~100 条 MEMORY entry 对常见 prompt 的召回质量（dogfood 边界 ADR-013 §B） | Phase 1 实施前 | 准备 5-7 个 fixture prompt（含中英混合 / 路径触发 / 概念触发 / 短 prompt 不召回），跑 `memory-search.js` 离线验证 precision/recall，避免上线噪音 |
| Codex 真把 plugin `commands/*.md` 不当 slash command 注册（影响 Phase 2 是否需 skill wrapper） | Phase 2 实施前 | 读 codex CLI plugin loader 源码或 `$skill list` 输出对比 |
| agentmemory MCP tool 具体实现和工具数量 | Phase 3 bridge 设计前 | 不依赖 README count；通过 package exports / MCP `tools/list` 实测，确认 bridge 只调用稳定 core tools |

**验证记录**

每完成一项，移到「已勘察」区，标 ✅ + 修订 plan 对应段。

**v0.4 实施起点（2026-05-14）**：
- ✅ build-codex-plugin `copyHooks()` 显式 hook 数组 + `validate-codex-plugin.js` `expectedHookScripts` 双端校验已勘察（line 330-337 / line 44-49），新增 prompt-submit.js 必须同步两处
- ✅ `scripts/lib/memory-v5.js` `collectMemoryEntries` 已 export（line 542），prompt-recall 可直接复用，无需新增 `collectUnifiedMemoryEntries`
- ✅ `detectActiveSprintTags` 已 export from `scripts/inject-context.js`（line 328），prompt-recall 可 require 复用，无需抽到 lib
- ⏳ UserPromptSubmit additionalContext 双端实证：实施 dogfood 期间自然验证；不支持时 §6.8 失败模式静默 exit 0 兜底（已实现）
- ⏳ `${CLAUDE_PLUGIN_ROOT}` MCP 占位符跨运行时：Phase 2 实施时 dogfood 验证

---

## 1. 结论先行

agentmemory **有值得接入的部分**，但不适合直接替换当前系统的 Memory v5。

推荐路线：

1. **先做本地 prompt-aware recall**：给当前 Memory v5 增加 query-aware 检索层，并通过 `UserPromptSubmit` 在用户每次输入后召回相关记忆。
2. **再做 Tech Persistence 自己的 memory MCP server**：暴露 `memory_search`、`memory_recent`、`memory_save`、`memory_file_history` 等工具，底层仍读写当前 `homunculus`。
3. **最后做 agentmemory 可选 bridge**：允许导出 / 同步到 agentmemory，用它的 viewer、hybrid search 或外部 MCP 生态，但不能让 agentmemory 接管当前 hook 主链路。

不推荐路线：

- 不直接并装完整 agentmemory plugin 和 Tech Persistence hooks。
- 不把 `~/.agentmemory` 或 agentmemory server 作为本项目 memory source of truth。
- 不把当前 Memory v5 topic files / instincts / sessions 迁移成 agentmemory 私有格式后再读回。

---

## 2. 当前系统真实边界

### 2.1 Source of truth

当前系统的 memory source of truth 是 Tech Persistence 自己的 `homunculus` 树，而不是 plugin 投影目录。

路径优先级：

1. `TECH_PERSISTENCE_HOME`
2. `TECH_PERSISTENCE_CONFIG` / `~/.tech-persistence/config.json`
3. runtime 默认目录：
   - Codex: `~/.codex/homunculus`
   - Claude Code: `~/.claude/homunculus`

本地证据：

- `scripts/lib/runtime-paths.js:62-75`：`resolveBaseDir()` 实现上述优先级。
- `scripts/lib/runtime-paths.js:88-95`：`resolveCompatReadDirs()` 会把当前 base dir、Claude homunculus、Codex homunculus 合并为兼容读目录。

这意味着接入方案必须保留“一个逻辑 memory、两个 runtime 都可读”的模型。

### 2.2 写入链路

当前写入链路是 hook-driven：

1. `PreToolUse` / `PostToolUse` 触发 `scripts/observe.js`
2. `observe.js` 写入 `projects/<project-id>/observations.jsonl`
3. `Stop` 触发 `scripts/evaluate-session.js`
4. `evaluate-session.js` 从 observations 里抽 pattern / instinct / memory notes
5. Memory v5 写入：
   - `projects/<project-id>/memory/MEMORY.md`
   - `projects/<project-id>/memory/<topic>.md`

本地证据：

- `scripts/observe.js:28-31`：观察写入 `projects/<id>/observations.jsonl`。
- `scripts/observe.js:55-73`：观察 schema 包含 tool、summary、paths、command、status、cwd 等。
- `scripts/evaluate-session.js:833-836`：Stop hook 阶段写 Memory v5 topic notes 和索引。
- `scripts/evaluate-session.js:556-563`：`writeMemoryIndex()` 生成 `MEMORY.md`。

### 2.3 读取 / 注入链路

当前读取链路主要发生在 `SessionStart`：

1. 检测 pending sprint / prototype。
2. 调用 `loadUnifiedMemoryIndex()` 合并兼容目录下的 Memory v5。
3. 注入一个简洁的 `MEMORY.md` index。
4. 再注入 recent sessions、project instincts、global instincts。

本地证据：

- `scripts/inject-context.js:252-265`：先调用 `detectActiveSprintTags()`，再以 `prioritizeTopics` 透传给 `loadUnifiedMemoryIndex()`，最终注入 `Auto Memory v5 (MEMORY.md concise index)`。
- `scripts/lib/memory-v5.js:507-539`：`loadUnifiedMemoryIndex()` 合并多个 runtime 目录的 topic entries，并支持 `options.prioritizeTopics` 重排。
- `scripts/lib/memory-v5.js:410-430`：`selectMemoryIndexEntries()` 已含 sprint-tag 重排（2026-05-11 sprint speed layer1 引入）— 命中 `prioritizeTopics` 的 entry 排前。**仍非 prompt-aware search**：tag 来自 sprint frontmatter，不是当轮 user prompt。

### 2.4 当前缺口

当前系统已经有“会话结束沉淀”和“会话开始注入”，但缺少三类能力：

| 缺口 | 当前状态 | 影响 |
|---|---|---|
| Prompt-aware recall | 只在 SessionStart 注入；现有 sprint-tag 重排（`prioritizeTopics`）只对齐 sprint 主题，不响应每轮 user prompt | 用户本轮问题和注入记忆相关性不稳定 |
| MCP 工具面 | plugin manifest 只有 `skills` / `hooks` | agent 不能主动查 memory，只能被动吃启动上下文 |
| Memory bridge / viewer | 当前是纯文件系统 | 可观察性和跨工具共享弱于 agentmemory |

本地证据：

- `plugins/tech-persistence/.codex-plugin/plugin.json:21-22`：当前只有 `skills` 和 `hooks`，没有 `mcpServers`。

---

## 3. agentmemory 当前态取证

取证时间：2026-05-14。

### 3.1 架构定位

agentmemory 自称是跨 agent 的 memory layer，支持 hooks、MCP 或 REST API；一个 server 可被多 agent 共享。README 还明确列出 Codex CLI 支持 `6 hooks + MCP + skills`。

证据：

- GitHub README: <https://github.com/rohitg00/agentmemory>
- README "Works with every agent"：跨 agent、MCP/REST/hook 共用同一 memory server。
- README "Codex CLI"：Codex plugin 注册 MCP、6 lifecycle hooks、4 skills。

### 3.2 Codex plugin manifest

agentmemory 的 Codex 插件 manifest 很小，但关键点是显式包含 MCP：

```json
{
  "name": "agentmemory",
  "version": "0.9.12",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "hooks": "./hooks/hooks.codex.json"
}
```

证据：

- <https://github.com/rohitg00/agentmemory/blob/main/plugin/.codex-plugin/plugin.json>

这对当前项目最直接的启发是：Tech Persistence 不应只把 workflow 暴露成 skills，也应该把 memory 暴露成 MCP tools。

### 3.3 Codex hooks

agentmemory 的 Codex hooks 包含：

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PreCompact`
- `Stop`

其中最值得借鉴的是 `UserPromptSubmit` **这个触发时机**：它在用户输入时执行 `prompt-submit.mjs`，状态消息是 `agentmemory: recalling relevant memories`。但 raw 源码显示，agentmemory 当前 `prompt-submit.mjs` 只是把 prompt 作为 observation POST 到 REST server，并不直接把 recall context 写回 stdout。

证据：

- <https://github.com/rohitg00/agentmemory/blob/main/plugin/hooks/hooks.codex.json>
- <https://github.com/rohitg00/agentmemory/blob/main/plugin/scripts/prompt-submit.mjs>

对当前系统的启发：Memory v5 不应只靠 SessionStart 注入固定索引；应该借用 `UserPromptSubmit` 时机，但由本项目自行实现 query-aware recall 与 stdout context 注入。不能把 agentmemory 的 `prompt-submit.mjs` 当成可直接复制的 recall 实现。

### 3.4 SessionStart 注入策略

agentmemory 的 `session-start.mjs` 默认只注册 session；只有 `AGENTMEMORY_INJECT_CONTEXT=true` 时才把 server 返回的 context 写到 stdout。

证据：

- <https://github.com/rohitg00/agentmemory/blob/main/plugin/scripts/session-start.mjs>
- README 配置段：`AGENTMEMORY_INJECT_CONTEXT=false` 默认关闭；PostToolUse 仍会捕获 observations。

对当前系统的启发：

- hook 注入必须有显式开关。
- 注入要有 timeout。
- 捕获和注入应解耦，避免为了 recall 改坏 observation 主链路。

### 3.5 检索能力

agentmemory 的检索是三路融合：

- BM25 keyword
- vector embedding
- graph traversal

并用 Reciprocal Rank Fusion 合并结果；README 还特别提到 CJK 需要可选 segmenter，否则会退化到整段 tokenization。

证据：

- README Search: <https://github.com/rohitg00/agentmemory>

对当前系统的启发：

- Phase 1 不需要马上引入 vector。
- 但本地 deterministic search 至少要支持 query tokens、path boost、topic boost、recency、confidence。
- 中文 memory 必须预留 CJK 分词策略，不能只按英文空格切词。

### 3.6 MCP 工具面

agentmemory 暴露了大量 memory tools，包括：

- `memory_recall`
- `memory_save`
- `memory_smart_search`
- `memory_file_history`
- `memory_sessions`
- `memory_timeline`
- `memory_profile`
- `memory_export`
- `memory_claude_bridge_sync`

证据：

- README MCP Server: <https://github.com/rohitg00/agentmemory>

对当前系统的启发：Tech Persistence 应先暴露小而稳定的核心工具，不要一口气复制 agentmemory 的大型工具面，也不要依赖 README 中的精确数量表述。

---

## 4. 可接入点矩阵

| 候选 | 是否可直接接 | 价值 | 耦合风险 | 建议 |
|---|---:|---|---|---|
| UserPromptSubmit prompt-aware recall | 是 | 高 | 中 | 第一优先级，实现成本低且直接补当前缺口 |
| 本地 deterministic memory search | 是 | 高 | 低 | 作为 prompt recall 和 MCP 的共同底座 |
| Tech Persistence 自有 MCP tools | 是 | 高 | 中 | 第二优先级，先做核心 4-6 tools |
| agentmemory export / import bridge | 是 | 中 | 中 | 第三优先级，作为可选生态桥 |
| agentmemory viewer | 部分 | 中 | 中 | 通过 bridge 使用，不进主链路 |
| agentmemory full plugin 并装 | 不建议 | 中 | 高 | 容易重复 hook、重复注入、重复写入 |
| agentmemory 作为主存储 | 不建议 | 低/中 | 高 | 会丢掉当前 instincts / sessions / sprint 语义 |
| vector / graph 全量引入 | 暂不建议 | 中 | 高 | 待本地 query search 稳定后再评估 |

---

## 5. 推荐目标架构

### 5.1 分层

```text
Codex / Claude Code
        |
        | hooks
        v
Tech Persistence Hook Layer
        |
        | observe / evaluate / inject / prompt recall
        v
Memory v5 Store
        |
        | topic notes + MEMORY.md + sessions + instincts
        v
Retrieval Adapter
        |
        +--> UserPromptSubmit context injection
        +--> Tech Persistence MCP tools
        +--> Optional agentmemory bridge/export
```

### 5.2 核心原则

1. **Memory v5 继续是主库**  
   `homunculus/projects/<id>/memory`、sessions、instincts 仍由 Tech Persistence 维护。

2. **检索层独立于 hook 层**  
   `memory-search` 是公共 library，供 prompt hook、MCP server、CLI、bridge 共用。

3. **Codex / Claude Code 都支持**  
   新 hook 和工具要沿用 `runtime-paths.js`，不能写成 Codex-only。

4. **agentmemory 只能作为可选外部系统**  
   bridge 是 opt-in；默认不启动 agentmemory server，不要求 Docker / iii-engine。

5. **注入有预算，捕获不阻塞**  
   prompt recall 和 SessionStart 注入都必须有字数预算和 timeout；观察写入继续保持 fire-and-forget。

---

## 6. Phase 1：本地 Memory Search + Prompt Recall

### 6.1 目标

让当前 Memory v5 支持“按用户问题召回相关记忆”，并通过 `UserPromptSubmit` 注入小段高相关上下文。

### 6.2 新增 / 修改文件

| 文件 | 动作 | 说明 |
|---|---|---|
| `scripts/lib/memory-search.js` | 新增 | 查询 Memory v5 topic notes / sessions / instincts 的公共检索库 |
| `scripts/prompt-submit.js` | 新增 | Hook entrypoint：读 stdin prompt，调用 memory-search，输出上下文 |
| `scripts/lib/memory-v5.js` | 可能修改 | 仅当需要新增 `collectUnifiedMemoryEntries()` / structured helper；不要把 `loadUnifiedMemoryIndex()` 当检索 API |
| `plugins/tech-persistence/hooks/prompt-submit.js` | 构建/分发生成 | plugin output，必须由 build / install 链路同步 |
| `plugins/tech-persistence/hooks/hooks.json` | 修改 | 增加 `UserPromptSubmit` hook |
| `plugins/tech-persistence/scripts/build-codex-plugin.js` | 修改 | hook copy 列表加入 `prompt-submit.js`，确保 plugin output 不漏文件 |
| `scripts/lib/runtime-paths.js` | 可能修改 | 如果需要增加 prompt payload runtime 识别，但尽量不动 |
| `scripts/validate-codex-plugin.js` | 修改 | `expectedHookScripts` / required hooks / require closure 校验新增 hook |
| `scripts/validate-claude-install.js` / `scripts/validate-codex-install.js` | 可能修改 | 确认安装后 hook 文件存在 |

### 6.3 检索算法 v1

先用 deterministic search，不引入外部依赖：

1. 输入：
   - user prompt
   - cwd / project identity
   - optional touched files
   - active sprint tags
2. 读取：
   - `projects/<id>/memory/*.md`
   - `projects/<id>/sessions/*.md`
   - `projects/<id>/instincts/*.md`
   - `instincts/personal/*.md`
3. 解析：
   - Memory v5 marker：`<!-- memory:v5:<id> -->`
   - topic
   - date
   - confidence
   - line body
4. 结构化入口：
   - `memory-search` 必须读取 structured entries（例如复用 `collectMemoryEntries()` + `resolveCompatReadDirs()`，或新增 `collectUnifiedMemoryEntries()`）
   - **不得**调用 `loadUnifiedMemoryIndex()` 后再解析字符串；它是 SessionStart index formatter，不是检索 API
5. 评分（与现有 `prioritizeTopics` 协同，**不重新造 index formatter**）：
   - keyword match（**新增**：prompt token 命中）
   - path match（**新增**：prompt 中提到的文件路径命中）
   - topic match
   - recency boost
   - confidence boost
   - active sprint tag boost（**复用信号**：可导入 / 抽取 `detectActiveSprintTags()`，但 scoring 发生在 structured entries 上）
6. 输出：
   - top 5 memory entries
   - top 2 session snippets
   - top 3 instincts
   - 总预算默认 3000 chars

**与 SessionStart 注入的去重**：

当前 `MEMORY.md` index 输出不会保留 `<!-- memory:v5:<id> -->` marker，因此不能假设 `UserPromptSubmit` 可以从已注入上下文中反查 entry ID。v1 采用低复杂度降噪：

- prompt recall 只输出高分 top-k。
- 总预算默认 3000 chars，可按 dogfood 降到 1200-2000 chars。
- 与 SessionStart 高重叠的 topic 降权，但不做硬排除。
- 如果 dogfood 发现重复明显，再新增 ephemeral session 文件（如 `.tech-persistence/session/<sid>/injected-ids.txt`）记录 selected IDs；这会要求同步更新 §6.2 文件清单和 Stop 清理策略。

这样 v1 不依赖不存在的 marker，也不会在 hook stdout 中加入模型可见的技术噪音。

### 6.4 中文分词策略

v1 采用轻量 tokenizer：

- ASCII / Latin：按非字母数字切分。
- CJK：生成 2-gram / 3-gram 窗口，避免中文整段无法匹配。
- 路径：按 `/`、`\`、`.`、`-`、`_` 切分，并保留完整 basename。

后续可选：

- `@node-rs/jieba`
- embedding provider
- agentmemory bridge search

### 6.5 Hook 输出格式

`UserPromptSubmit` 输出应该短、可追踪、低噪音：

```markdown
## Relevant Tech Persistence Memory

- [Architecture] 2026-05-13 [0.75] runtime-paths.js 是双运行时边界，不能 Codex-only。
- [Workflow] 2026-05-12 [0.70] 修改 hook-lib 要同步 source / plugin / installer / validation。

Source: Memory v5 prompt recall. Query budget: 3000 chars.
```

不输出时机：

- 无匹配。
- prompt 很短且没有项目词。
- 设置 `TECH_PERSISTENCE_DISABLE_PROMPT_RECALL=1`。
- 检索超时。

### 6.6 验收标准

- [ ] 给定包含 `runtime-paths` 的 prompt，能召回 runtime boundary 相关 memory。
- [ ] 给定中文 query，能召回中文 memory 条目。
- [ ] `UserPromptSubmit` hook 不影响 `SessionStart` 注入。
- [ ] 无 memory 文件时静默退出。
- [ ] 检索超时 / 解析失败时不阻塞主流程。
- [ ] Codex 和 Claude Code 安装产物都包含新增 hook。

### 6.7 验证命令

```bash
node scripts/validate-codex-plugin.js
node scripts/validate-codex-install.js --project
node scripts/validate-claude-install.js --project
node scripts/pre-commit-check.js
node scripts/smoke-pre-commit.js
```

### 6.8 失败模式

`prompt-submit.js` 必须和现有 hooks 一样“失败不打断主流程”：

- stdin 不是 JSON：静默退出 0。
- payload 没有 prompt：静默退出 0。
- 检索超时：静默退出 0，debug 模式才写 stderr。
- `UserPromptSubmit` 不支持 `hookSpecificOutput.additionalContext`：不输出普通 Markdown，避免污染用户可见终端；Phase 1 降级为 MCP / SessionStart 方案。
- 匹配结果低于阈值：不输出。
- 避免自指：prompt recall 输出不写回 observations，PostToolUse 若记录到 memory MCP 查询，必须通过 tool/filter 忽略。

---

## 7. Phase 2：Tech Persistence Memory MCP

### 7.1 目标

把 memory 从“只能 hook 被动注入”升级为“agent 可主动查询 / 保存 / 查看近期会话”的工具面。

### 7.2 不直接复制 agentmemory 大型工具面

agentmemory 的工具面很全，但当前项目应该保持小而稳定：

| Tool | 作用 | 底层 |
|---|---|---|
| `tp_memory_search` | 查询 Memory v5 topic notes | `scripts/lib/memory-search.js` |
| `tp_memory_recent` | 最近 sessions / notes | sessions + memory topic files |
| `tp_memory_save` | 手动写一条 durable note | Memory v5 topic file |
| `tp_memory_file_history` | 查某文件相关观察 / memory | observations + memory-search path boost |
| `tp_memory_project_profile` | 项目 memory profile | MEMORY.md + topics + instincts |
| `tp_memory_export` | 导出为 JSON / agentmemory-compatible markdown | bridge layer |

### 7.3 新增 / 修改文件

| 文件 | 动作 | 说明 |
|---|---|---|
| `scripts/memory-mcp-server.js` | 新增 | MCP stdio server source |
| `scripts/lib/memory-tools.js` | 新增 | tool handlers |
| `plugins/tech-persistence/mcp/memory-mcp-server.js` | 构建/分发生成 | MCP runtime script，不放在 `hooks/` |
| `plugins/tech-persistence/.codex-plugin/plugin.json` | 修改 | 增加 `mcpServers` |
| `plugins/tech-persistence/.codex-plugin/.mcp.json` | 新增 | 指向 plugin 内 MCP runtime script |
| `scripts/validate-codex-plugin.js` | 修改 | 校验 MCP manifest |
| `README.md` | 修改 | 增加 memory MCP 使用说明 |

### 7.4 MCP manifest 形状

参考 agentmemory 的 manifest 方式，但路径要沿用 Tech Persistence 自己的插件根：

```json
{
  "mcpServers": "./.mcp.json"
}
```

`.mcp.json` 示例：

```json
{
  "mcpServers": {
    "tech-persistence-memory": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/memory-mcp-server.js"]
    }
  }
}
```

注意：Codex 对 `${CLAUDE_PLUGIN_ROOT}` 有兼容注入，但本项目仍要验证 Claude Code 和 Codex 两边都能解析。

### 7.5 验收标准

- [ ] `codex plugin` 安装后能看到 MCP server 配置。
- [ ] MCP server 读取的是当前 `TECH_PERSISTENCE_HOME` / compat dirs。
- [ ] `tp_memory_search` 和 `UserPromptSubmit` 使用同一检索库，结果一致。
- [ ] MCP tool 不写入 observation，避免查询 memory 本身污染 memory。
- [ ] `tp_memory_save` 写入后 `MEMORY.md` index 可更新。

---

## 8. Phase 3：agentmemory Bridge

### 8.1 目标

允许用户选择把 Tech Persistence memory 同步到 agentmemory，用 agentmemory 的 viewer / hybrid search / broader MCP 生态，但不改变当前主存储。

### 8.2 Bridge 模式

| 模式 | 方向 | 用途 |
|---|---|---|
| export-on-demand | Tech Persistence -> agentmemory | 让 agentmemory viewer / search 能看现有 memory |
| import-on-demand | agentmemory -> Tech Persistence | 把 agentmemory 手动保存的 insight 拉回 Memory v5 |
| read-through | Tech Persistence query -> agentmemory MCP | 当本地 search 结果不足时做 fallback |

默认只实现 export-on-demand。

### 8.3 Export 形状

输入：

- `projects/<id>/memory/*.md`
- `projects/<id>/sessions/*.md`
- `projects/<id>/instincts/*.md`

输出：

- JSONL
- agentmemory-compatible markdown
- REST `/agentmemory/remember` payload

建议先做文件导出，不直接打 REST。

### 8.4 防重复策略

每条导出的 memory 必须携带稳定 id：

```text
tech-persistence:v5:<project-id>:<memory-id>
```

metadata：

```yaml
source_system: tech-persistence
source_version: memory-v5
source_project_id: <id>
source_memory_id: <id>
source_topic: architecture
```

这样 agentmemory 再导回时可以识别 provenance，避免重复生成。

### 8.5 不做

- 不默认启动 `npx @agentmemory/agentmemory`。
- 不自动运行 `agentmemory upgrade`。
- 不在 hook 中实时同步到 agentmemory。
- 不让 agentmemory 的 Stop hook 总结覆盖 Tech Persistence 的 `evaluate-session.js`。

---

## 9. 风险与缓解

| 风险 | 触发点 | 影响 | 缓解 |
|---|---|---|---|
| 双 hook 重复写入 | 并装完整 agentmemory plugin | observations / sessions 重复，context 重复注入 | 默认不并装；bridge opt-in；文档明确互斥 |
| Codex-only 退化 | 新 hook 只考虑 Codex payload | Claude Code 失效 | 沿用 `runtime-paths.js` 和 stdin JSON 容错 |
| Prompt recall 噪音 | 每轮都注入不相关 memory | 模型注意力污染 | query score 阈值 + 预算 + 空结果静默 |
| 中文召回弱 | 英文 tokenizer | 中文 memory 找不到 | CJK 2-gram / 3-gram v1 |
| MCP 查询污染 memory | MCP tool 触发 PostToolUse 被记录 | memory 查询制造自引用 | 对 memory MCP tools 增加 ignore marker 或 filter |
| Plugin 分发漏文件 | 只改 source scripts | 安装后 hooks 缺文件 | validate-codex-plugin 校验 hook-lib inventory / require closure |
| agentmemory 依赖重 | iii-engine / Docker / npm 网络 | 安装门槛高 | Phase 1/2 不依赖 agentmemory；Phase 3 optional |

---

## 10. 任务拆解

### Task A：本地检索库

| 子任务 | 风险 | 验证 |
|---|---|---|
| A1 新增 `scripts/lib/memory-search.js` | L2 | 单文件 fixture search |
| A2 解析 Memory v5 topic entries | L2 | 与 `parseMemoryEntriesFromTopic()` fixtures 一致 |
| A3 实现 tokenizer + scorer | L2 | 英文 / 中文 / path query 用例 |
| A4 加预算裁剪和格式化 | L1 | 输出不超过配置预算 |

### Task B：Prompt hook

| 子任务 | 风险 | 验证 |
|---|---|---|
| B1 新增 `scripts/prompt-submit.js` | L2 | stdin prompt smoke |
| B2 `hooks.json` 增加 `UserPromptSubmit` | L2 | validate plugin |
| B3 增加 env 开关 | L1 | `TECH_PERSISTENCE_DISABLE_PROMPT_RECALL=1` 静默 |
| B4 分发到 plugin hooks | L3 | build + install validation |

### Task C：Memory MCP

| 子任务 | 风险 | 验证 |
|---|---|---|
| C1 新增 MCP server skeleton | L3 | MCP initialize/list tools |
| C2 接 `tp_memory_search` / `tp_memory_recent` | L3 | tool result fixture |
| C3 plugin manifest 增加 `mcpServers` | L3 | Codex plugin validation |
| C4 docs + install validation | L2 | README grep + validator |

### Task D：agentmemory bridge

| 子任务 | 风险 | 验证 |
|---|---|---|
| D1 新增 export JSONL | L2 | stable id / metadata snapshot |
| D2 新增 agentmemory markdown export | L2 | frontmatter snapshot |
| D3 可选 REST push | L3 | 仅在 `AGENTMEMORY_URL` 设置时启用 |
| D4 import 防重复 | L3 | round-trip fixture |

---

## 11. 建议优先级

### P0：先做 Prompt Recall

理由：

- 当前缺口最明确。
- 不需要外部服务。
- 直接提升每轮上下文相关性。
- 对 Codex / Claude Code 都成立。

完成后，用户问“runtime-paths 怎么处理”这类问题时，系统应能自动召回此前关于双运行时边界的经验。

### P1：再做自有 MCP

理由：

- 让 agent 主动查询 memory。
- 为后续 `$memory` / `$review-learnings` / `$agent-loop` 都提供统一能力。
- 可复用 prompt recall 的检索库。

### P2：最后做 agentmemory bridge

理由：

- bridge 有价值，但不是当前缺口的最短路径。
- agentmemory 依赖面更重。
- viewer / vector / graph 属于增强，不应阻断本地基础能力。

---

## 12. 不做清单

- 不引入数据库。
- 不默认安装 `@agentmemory/agentmemory`。
- 不默认启动 localhost server。
- 不默认改用户全局 Codex / Claude 配置。
- 不删除现有 Memory v5 文件。
- 不把 `.codex` 投影当成唯一 source of truth。
- 不把 prompt recall 输出写回 observations。
- 不为追求 agentmemory parity 一次性复制大型 MCP 工具面。

---

## 13. 完成标准

文档阶段：

- [x] 明确当前 Memory v5 source of truth。
- [x] 明确 agentmemory 可借鉴能力。
- [x] 明确推荐路线和不推荐路线。
- [x] 给出分阶段任务拆解。
- [x] 给出验证命令和风险缓解。

实现阶段：

- [x] Phase 1 完成：本地 query-aware search + `UserPromptSubmit` recall。`scripts/lib/memory-search.js` + `scripts/prompt-submit.js` + hooks.json `UserPromptSubmit` + 21 自测全过。
- [x] Phase 2 完成：Tech Persistence memory MCP tools。`scripts/memory-mcp-server.js` + `scripts/lib/memory-tools.js` 暴露 5 tools (`tp_memory_search` / `tp_memory_recent` / `tp_memory_save` / `tp_memory_file_history` / `tp_memory_project_profile`)，plugin manifest 加 `mcpServers`。
- [x] Phase 3 完成：agentmemory optional bridge/export。`scripts/memory-export.js` 支持 JSONL / Markdown / 可选 REST push (env `AGENTMEMORY_URL`)，8 round-trip 自测全过。

---

## 14. 最小下一步

如果只做一件事：

> 新增 `scripts/lib/memory-search.js`，然后接一个 `scripts/prompt-submit.js`，通过 `UserPromptSubmit` 把 top-k Memory v5 结果注入当前轮。

这是最小、低耦合、同时补齐 agentmemory 最有价值部分的路径。

---

## 15. Changelog

### 2026-05-14（v0.2 — analysis pass）

补 3 个 P0 缺口：

- 新增 §0「项目身份界定」段（ADR-011 identity-question-first 强制）：显式陈述 4 条不可妥协原则 + agentmemory 在本项目中的定位，使 §4 矩阵的"建议"列有可追溯依据
- 新增 §0.5「关键假设验证」段（ADR-012 强制）：勘察 4 处路径行号引用 + 列 5 项待验证假设（含 agentmemory 源码 reality check / `${CLAUDE_PLUGIN_ROOT}` 跨运行时 / dogfood fixture / Codex command 注册行为 / UserPromptSubmit 去重机制）
- 修正 §2.3 / §2.4 / §6.3 关于「与现有 sprint-tag 重排层关系」的描述：原 plan 把 `selectMemoryIndexEntries` 当"非 query-aware"，实际已含 `prioritizeTopics`（2026-05-11 sprint speed layer1 引入）；prompt-recall 必须复用此信号、与 SessionStart 注入做去重，不重新造重排逻辑

Phase 4 review 修复（同 v0.2 pass 内）：

- R-P0-1：§0.5 "agentmemory README 7 处声称" → 改为 "6 处（§3.1-3.6 各一项）" + 列具体小节，并精化验证方式为 `raw.githubusercontent.com` / `gh api`
- R-P0-2：§6.3 去重段原引用凭空假设的 `injection-log.jsonl` — 改为 3 个候选方案 (hook stdout marker / ephemeral session 文件 / 评分阈值减权)，Phase 1 实施时选定并回写 §6.2，对应行已加入 §0.5 待验证表

v0.2 当时未处理的 P1（其中 UserPromptSubmit 失败模式已在 v0.3 处理）：

- CJK 2-gram 召回噪音的 score threshold 量化
- UserPromptSubmit hook 失败模式细化（timeout / parse / log 去向 / observation 自指）— ✅ v0.3 已补 §6.8
- MCP 工具 `tp_memory_*` 与 `tech-persistence:memory` skill 的边界
- Phase 2 `${CLAUDE_PLUGIN_ROOT}` 跨运行时支持验证（已列入 §0.5 待验证）
- Phase 1 dogfood fixture prompt 集合（已列入 §0.5 待验证）

### 2026-05-14（v0.4 — full implementation pass）

按 plan 完整实施 Phase 1+2+3：

**Phase 1 — Prompt-aware recall**：

- 新增 `scripts/lib/memory-search.js`：query-aware 检索库，复用 `collectMemoryEntries` / `parseFrontmatter` / `redactSensitive`；自带 ASCII + CJK 2-gram + 路径 tokenizer；6 维 scorer（keyword / path / topic / recency / confidence / sprint-tag）；default minScore=1.2 默认过滤低质量 tool_preference 噪音
- 新增 `scripts/prompt-submit.js`：UserPromptSubmit hook entrypoint，stdin JSON → 提取 prompt / touched_files → 召回 → `hookSpecificOutput.additionalContext` 注入；6 类失败模式（§6.8）全部 silent exit 0
- 新增 `scripts/test-memory-search.js`：21 个自测（tokenizer / scorer / searchMemory e2e / formatRecallContext 预算裁剪 / redact）全过
- `plugins/tech-persistence/hooks/hooks.json` 新增 `UserPromptSubmit` 段（async: false / timeout 1800）
- `plugins/tech-persistence/scripts/build-codex-plugin.js` `copyHooks()` 加 `prompt-submit.js` 到 hook 数组
- `scripts/validate-codex-plugin.js` `expectedHookScripts` 加 `prompt-submit.js`，`required hooks` 加 `UserPromptSubmit`

**Phase 2 — Memory MCP**：

- 新增 `scripts/memory-mcp-server.js`：最小 MCP 2024-11-05 stdio 实现（initialize / tools/list / tools/call / notifications/initialized 忽略）
- 新增 `scripts/lib/memory-tools.js`：5 tool handlers 拆分（search / recent / save / file_history / project_profile），共用 redact + topicTitle
- `plugins/tech-persistence/.codex-plugin/plugin.json` 加 `mcpServers: "./.codex-plugin/.mcp.json"`
- 新增 `plugins/tech-persistence/.codex-plugin/.mcp.json`：args 用 `${CLAUDE_PLUGIN_ROOT}/mcp/memory-mcp-server.js` 跨运行时占位符
- `build-codex-plugin.js` 新增 `copyMcpRuntime()`：复制 server + lib 到 plugin `mcp/` 子目录
- `validate-codex-plugin.js` 加 MCP manifest 校验（必含 `mcpServers` / `${CLAUDE_PLUGIN_ROOT}` / `/memory-mcp-server.js`）+ runtime 文件 parity + lib 闭包 + `validateLocalRequireClosure`
- smoke：plugin MCP runtime initialize 返 `protocolVersion:2024-11-05`，tools/list 返 5 tools

**Phase 3 — agentmemory bridge**：

- 新增 `scripts/memory-export.js`：CLI 支持 `--format=jsonl|markdown` + `--output=` + 可选 `--push=agentmemory` (env `AGENTMEMORY_URL`) + `--include-sessions`
- 稳定 id 格式：`tech-persistence:v5:<project-id>:<memory-id>`；每条带 provenance metadata（source_system / source_version / source_project_id / source_memory_id / source_topic）
- redact 防 secret 泄漏到导出
- 新增 `scripts/test-memory-export.js`：8 round-trip 自测（stable id 一致 / append 后 existing id 不变 / session frontmatter）全过

**关键修复（实施期间）**：

- §0.5 三个 `### subsection` 改为 `**bold**` 段落，避免被 `pre-commit-check.js` plan-lint regex `nextHeadingIdx` 截断（lint 要求 anchor 之后 ≥100 字符非空内容）
- `formatRecallLine` 双 confidence 前缀去重（entry.line 已含 `[0.X]`，输出再加一层会变 `[0.6] [0.6]`）

**dogfood smoke 全通过**：

- `node scripts/test-memory-search.js` → 21 passed
- `node scripts/test-memory-export.js` → 8 passed
- `node plugins/tech-persistence/scripts/build-codex-plugin.js` → 5 个 inventory 全 OK
- `node scripts/validate-codex-plugin.js` → 全 OK（含新 MCP 校验）
- `node scripts/pre-commit-check.js` → exit 0
- `node scripts/smoke-pre-commit.js` → 18 scenarios passed
- 真实 prompt smoke：相关 prompt 命中真实 memory，无相关 prompt 静默 exit 0

### 2026-05-14（v0.3 — document revision pass）

修复实现前阻塞假设：

- 修正 §3.3：agentmemory `UserPromptSubmit` raw 脚本只观察 prompt，不注入 recall context；本文改为“借鉴 hook 时机，本项目自行实现 prompt recall”。
- 修正 §6.3：`loadUnifiedMemoryIndex()` 是 index formatter，不是检索 API；Phase 1 改为 structured entries search，必要时新增 `collectUnifiedMemoryEntries()`。
- 修正 §6.3 去重：当前 `MEMORY.md` index 不保留 Memory v5 marker，不能按 marker 排除已注入条目；v1 改为高阈值 + 小预算降噪，ephemeral selected-id 文件作为 dogfood 后的升级项。
- 补 §6.2 构建/验证链路：`build-codex-plugin.js` hook copy 列表、`validate-codex-plugin.js` expected hook scripts / required hook list 必须同步。
- 补 §6.8 失败模式：JSON parse、timeout、unsupported additionalContext、低分结果、自指污染都必须静默或降级。
- 修正 §7.3 / §7.4 MCP server 放置位置：runtime script 放 `plugins/tech-persistence/mcp/`，不混入 hooks 目录。
- 更新 §0.5：把已 raw 验证的 agentmemory manifest / hooks / prompt-submit / session-start / README search 移入已勘察；保留 `additionalContext` 双运行时支持、`${CLAUDE_PLUGIN_ROOT}` MCP 展开、dogfood fixture、MCP tool 实测为实施前待验证项。
