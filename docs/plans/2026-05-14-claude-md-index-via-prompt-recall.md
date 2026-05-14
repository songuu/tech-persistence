---
title: "CLAUDE.md 解决方案索引膨胀治理 — 复用 prompt recall + 归档"
type: sprint
status: planning
created: "2026-05-14"
updated: "2026-05-14"
checkpoints: 0
tasks_total: 10
tasks_completed: 0
tags: [sprint, memory, prompt-recall, claude-md, scope-trimming]
aliases: ["claude-md-index-trim", "prompt-recall-solutions"]
---

# CLAUDE.md 解决方案索引膨胀治理

复用 `agentmemory-memory-integration` 完成的 prompt-aware recall 基础设施，把 `docs/solutions/` 纳入检索池；同步把 CLAUDE.md 索引段从 always-on 全量改为「近 5 条 + archive」。

---

## 0. 项目身份界定

本项目是 **developer-toolchain self-evolution sibling**（ADR-011）。本 sprint 是**写入侧重定向 + 检索侧扩源**的复合改动，不引入新框架。

### 4 条不可妥协原则验证

| 原则 | 本 sprint 是否触碰 |
|------|------|
| 多 runtime parity（Claude + Codex）| ✅ 仅扩 source path，不改 runtime；plugin 副本通过 build 同步 |
| 确定性优先 | ✅ 检索仍是 deterministic（keyword + path + recency），不引入 embedding |
| 轻量优先 | ✅ 新加 < 100 行 source（collectSolutionFiles + scoreSolution）|
| Obsidian 兼容 | ✅ archive 文件是 markdown frontmatter；CLAUDE.md 仍是 markdown |

---

## 1. 需求分析（Phase 1 已完成）

### 范围（做什么）

1. 扩 `scripts/lib/memory-search.js` 增加 `collectSolutionFiles()` + `scoreSolution()`，把 `docs/solutions/*.md` 纳入检索池
2. `searchMemory()` 接受 `cwd` 参数（或 `solutionsDir`），自动定位 `<cwd>/docs/solutions/`
3. `scripts/prompt-submit.js` 传 `cwd: process.cwd()` 让检索看到 solutions
4. 同步 propagate 到 plugin 副本（hooks/lib + mcp/lib）
5. 创建一次性归档脚本 `scripts/archive-claude-solutions-index.js` 把当前 16 条中除最近 5 条外的 11 条归档到 `docs/archives/CLAUDE-solutions-index-2026-05-14.md`
6. 修订 `/compound` skill + command：写新条目时同步限制索引段 ≤ 5 条（老的自动移到归档）
7. 扩 `scripts/test-memory-search.js` 加 5 个 solution-recall self-test
8. 端到端 smoke：用 R1-R6 sprint 涉及关键词（"auto-mode 双触发"、"plugin migration"、"ps1-bom"）验证 recall 命中

### 不做（non-scope）

1. **不删** `docs/solutions/` 任何文件（仅扩 source path）
2. **不动** Memory v5 SessionStart 注入路径（`MEMORY.md` index 行为不变）
3. **不动** MCP server（Phase 2 已完成，独立 scope）
4. **不引入新 enforcement**（pre-commit checker）—— /compound 仍是 LLM 协议入口
5. **不强制** docs/solutions/ frontmatter 格式 —— 兼容当前混合格式（有 / 无 frontmatter 都读）
6. **不动** CLAUDE.md 其他段（如方法论 / 自学习规则 / 文档同步规则）

### 成功标准

- `node scripts/test-memory-search.js` 21 → 26 self-test 全过（含 5 新增 solution recall scenarios）
- CLAUDE.md 解决方案索引段 ≤ 5 条 / ≤ 2k chars（当前 15 条 / 11.7k chars → 减 70% 体积）
- 端到端：含 "auto-mode hooks 双触发" 关键词的 prompt → UserPromptSubmit hook 召回 `2026-05-14-plugin-migration-cascade-cleanup.md`
- 归档脚本 idempotent（反复跑结果一致 / 不重复归档）
- always-on 注入 14368 → ~12300 tokens（减 ~2k tokens/session）

---

## 2. 关键假设验证（兑现 ADR-012）

**关键假设验证**（兑现 ADR-012）：

| 假设 | 验证方式 | 实际 |
|------|---------|------|
| `memory-search.js` 通过 `baseDirs` 参数定位 homunculus 源 | Read `scripts/lib/memory-search.js:287-320` `searchMemory(options)` | ✅ 已验证 `for (baseDir of baseDirs) {...}` loop，扩 source 应类比此模式增加 `solutionsDirs` 入参 |
| `collectMemoryEntries(memoryDir)` 返回的 entry shape 含 `topic/date/confidence/line/note` | Read `scripts/lib/memory-v5.js` 对应函数 + memory-search.js 用法（scoreEntry 引用字段）| ⚠️ memory-search.js scoreEntry 使用 `entry.line / entry.topic / entry.date` —— **新 collectSolutionFiles 必须输出兼容字段**（topic="solution"，date 从 filename 或 frontmatter，line=h1 摘要） |
| build-codex-plugin.js 通过 `copyHookLibs()` 同步 `scripts/lib/*.js` 到 plugin hooks/lib | grep `plugins/tech-persistence/scripts/build-codex-plugin.js:167` | ✅ `copyHookLibs` 存在；改 `scripts/lib/memory-search.js` 后跑 build 即可同步 plugin 副本 |
| `plugins/tech-persistence/mcp/lib/memory-search.js` 也是 build 派生 | grep "mcp/lib" build script | ⚠️ 仅显式见 hookLibs；mcp 副本同步路径需 task T5 中确认；最坏情况 propagate 多一步 |
| `scripts/test-memory-search.js` 自包含（无 framework）| Read line 1-30 | ✅ 用 `node:assert`，extend 直接加新 `it("...", () => {...})` 风格 |
| CLAUDE.md 索引段在 line 164-179 | Read CLAUDE.md | ✅ 当前 15 条；line 164 = `### 解决方案索引` |
| `docs/solutions/` 含 16 个 .md 文件 | `ls docs/solutions/*.md \| wc -l` | ✅ 16 (含本 sprint 关注的 `2026-05-14-plugin-migration-cascade-cleanup.md`) |
| `docs/archives/` 目录不存在 | `ls docs/archives/` | ✅ 不存在，task T6 创建 |
| prompt-submit.js 不传 `cwd` | Read `scripts/prompt-submit.js:149-158` | ✅ 当前只传 `baseDirs/touchedFiles/sprintTags`；task T4 加 `cwd` |
| `docs/solutions/*.md` frontmatter 一致性 | head 几个 solution 文件 | ⚠️ 混合（有 frontmatter / 无 frontmatter）；collectSolutionFiles 必须**容错**：缺 frontmatter 时 fallback 到 filename + h1 |

### 仍待 Phase 3 实际验证

- mcp/lib/memory-search.js 副本如何同步（最坏 task T5 加 propagate-mcp-lib.js）
- docs/solutions/ 全部 16 文件 frontmatter 抽样 — 看是否有破坏性差异
- prompt-recall 在含 16 entries 的 docs/solutions/ 池下的检索预算占用（budget 3000 chars 够吗）

---

## 3. 技术方案

### 3.1 source 扩展（memory-search.js）

新增 `collectSolutionFiles(solutionsDir)`：

```javascript
// 输出 shape 与 memoryEntries 兼容（topic="solution" + date + line + note）
function collectSolutionFiles(solutionsDir) {
  if (!solutionsDir || !fs.existsSync(solutionsDir)) return [];
  try {
    return fs.readdirSync(solutionsDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => {
        const file = path.join(solutionsDir, name);
        const content = fs.readFileSync(file, 'utf-8');
        const { meta, body } = parseFrontmatter(content);
        // date 优先级：frontmatter date → filename YYYY-MM-DD → mtime
        const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
        const date = String(meta.date || '').slice(0, 10)
          || (dateMatch ? dateMatch[1] : '');
        // h1 提取（首个 # 行）作为 line
        const h1Match = body.match(/^#\s+(.+)$/m);
        const title = String(meta.title || h1Match?.[1] || name.replace(/\.md$/, ''));
        // 摘要：tags + title + body 前 500 chars
        const summary = String(body || '').slice(0, 800);
        return {
          file,
          topic: 'solution',
          date,
          confidence: 0.7,  // solution 默认置信度（手写文档 = 高质）
          line: `[Solution] ${date} ${title}`,
          note: summary,
          tags: meta.tags || '',
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
```

新增 `scoreSolution(entry, query)` —— 与 `scoreSession` 类似但权重略调（solution 是高密度精炼内容，keyword 权重更高）：

```javascript
function scoreSolution(entry, query) {
  const text = `${entry.line || ''} ${entry.note || ''} ${entry.tags || ''}`;
  const ascii = tokenizeAscii(text);
  const cjk = tokenizeCjk(text);
  const paths = extractPathTokens(text);
  const asciiHits = countMatches(ascii, query.ascii);
  const cjkHits = countMatches(cjk, query.cjk);
  const pathHits = countMatches(paths, query.paths);

  const keyword = (asciiHits / (query.ascii.size || 1)) * 0.6
                + (cjkHits / (query.cjk.size || 1)) * 0.4;
  const pathScore = pathHits / (query.paths.size || 1);
  const recency = recencyBoost(entry.date);

  return {
    total: keyword * 2.0 + pathScore * 1.5 + recency * 0.5 + 0.6 * 0.4,  // confidence 固定 0.7
    components: { keyword, path: pathScore, recency, confidence: 0.7 },
  };
}
```

修改 `searchMemory(options)` 接受 `cwd` + 内置 `solutionsDir = path.join(cwd, 'docs/solutions')`，并在主 loop 加：

```javascript
const solutionFiles = collectSolutionFiles(solutionsDir);
const scoredSolutions = solutionFiles.map((s) => ({...s, score: scoreSolution(s, query)}))
  .filter((s) => s.score.total >= finalLimits.minScore)
  .sort((a, b) => b.score.total - a.score.total)
  .slice(0, finalLimits.solutionTop || 3);
```

返回 shape 扩展：

```javascript
return { memory: [...], sessions: [...], instincts: [...], solutions: [...], query, limits };
```

`DEFAULT_LIMITS.solutionTop = 3`，`budgetChars` 不变 3000（solution 摘要会挤占其他池，但 solution 信息密度高）。

### 3.2 prompt-submit.js 接入

```javascript
result = searchMemory({
  prompt, projectId: project.id, baseDirs,
  cwd: process.cwd(),              // ← 新增
  touchedFiles, sprintTags,
  limits: { budgetChars: DEFAULT_BUDGET_CHARS },
});
```

`formatRecallContext()` 加 solutions 段：

```markdown
## Relevant Tech Persistence Memory

- [Memory] ...
- [Session] ...
- [Instinct] ...
- [Solution] 2026-05-14 [0.7] Claude Code 2.x plugin 迁移后的 cascade cleanup — docs/solutions/2026-05-14-plugin-migration-cascade-cleanup.md
```

### 3.3 一次性归档脚本

`scripts/archive-claude-solutions-index.js`：

```text
1. Read CLAUDE.md
2. 定位 "### 解决方案索引" 段（end = next "###" 或 EOF）
3. 解析所有 "- [YYYY-MM-DD] ..." 条目，按日期降序
4. 保留前 5 条（最近）
5. 老条目（6+）写入 docs/archives/CLAUDE-solutions-index-<TODAY>.md：
   - 创建 docs/archives/ 目录（不存在时）
   - 文件 frontmatter: type=archive, archived_from=CLAUDE.md, archived_at=<DATE>, archived_count=N
   - 内容：原 markdown 列表 + 顶部说明
6. 在 CLAUDE.md 索引段顶部加 archive pointer：
   "> 老条目（> 5 条）已归档至 docs/archives/CLAUDE-solutions-index-*.md"
7. idempotent：再跑一次 → 5 条仍是 5 条，archive 文件不重写（基于 archived_at 日期判断）
```

**关键 idempotent 设计**：脚本扫 `docs/archives/CLAUDE-solutions-index-*.md` 的 frontmatter `archived_at` —— 已存在今日归档则**追加合并**而非覆盖；CLAUDE.md 已剩 ≤ 5 条则直接 noop。

### 3.4 /compound skill 修订

`plugins/tech-persistence/skills/compound/SKILL.md` + `plugins/tech-persistence/commands/compound.md`：

步骤 3（"提取经验到 rules"）后增加：

```text
### 步骤 3.5: CLAUDE.md 索引段尺寸维护

写完新条目后：
- 索引段 ≤ 5 条 → 不动
- 索引段 > 5 条 → 跑 `node scripts/archive-claude-solutions-index.js`，归档老条目
- 报告中加 `Archive: N 条 → docs/archives/...`
```

不在 deterministic 代码中强制 —— /compound 是 LLM 协议，依赖模型读 SKILL.md 时遵守。

### 3.5 测试扩展

`scripts/test-memory-search.js` 新增 5 个 self-test：

```javascript
// S22: collectSolutionFiles 读取 fixture solutions/
// S23: 缺 frontmatter 的 solution 也能被读（fallback to filename + h1）
// S24: searchMemory 含 cwd 时返回 solutions 数组
// S25: scoreSolution keyword 权重正确
// S26: solution 与 memory entry 在 top-k 合并排序
```

### 3.6 端到端 smoke（手动）

```bash
echo '{"prompt":"auto-mode 双触发是 plugin migration 的什么风险"}' | \
  node scripts/prompt-submit.js
# 预期 stdout 含 JSON：additionalContext 含 "2026-05-14-plugin-migration-cascade-cleanup.md"
```

---

## 4. 任务拆解

| Task | 描述 | 文件 | 风险 | 时间 |
|------|------|------|------|------|
| **T1** | 加 `collectSolutionFiles()` + `scoreSolution()` | `scripts/lib/memory-search.js` (+~80 lines) | L2 | 20 min |
| **T2** | `searchMemory()` 接受 `cwd` + 调 `collectSolutionFiles` | 同上 (+~20 lines) | L2 | 10 min |
| **T3** | `formatRecallContext()` 加 solution 段输出 | 同上 (+~15 lines) | L1 | 5 min |
| **T4** | `prompt-submit.js` 传 `cwd: process.cwd()` | `scripts/prompt-submit.js` (+1 line) | L1 | 2 min |
| **T5** | 跑 build 同步 plugin 副本 + 确认 mcp/lib | `node plugins/tech-persistence/scripts/build-codex-plugin.js` + Read plugin/mcp/lib/memory-search.js diff | L3 | 10 min |
| **T6** | 新增归档脚本 + dogfood 跑一次 | `scripts/archive-claude-solutions-index.js` (~120 lines) + 跑后 diff `CLAUDE.md` + 新建 `docs/archives/...md` | L3 | 30 min |
| **T7** | 修订 /compound skill + command | `plugins/tech-persistence/skills/compound/SKILL.md` + `plugins/tech-persistence/commands/compound.md` + `user-level/commands/compound.md`（propagate-command-changes.js 同步）| L2 | 15 min |
| **T8** | 扩展 `test-memory-search.js` 加 5 self-test | `scripts/test-memory-search.js` (+~120 lines) | L2 | 25 min |
| **T9** | 端到端 smoke：3 个真实关键词触发 prompt recall | 手动 stdin pipe → prompt-submit.js → 验证 stdout 含 solution | L2 | 10 min |
| **T10** | 验证 pre-commit-check 通过 + propagate-command-changes 通过 | `node scripts/pre-commit-check.js` + propagate 跑一次 | L1 | 5 min |

**总计**：~2.3h（保守估算 1.5h-2h）

**checkpoint 预告**：10 个 task ≥ 5 → 在 T5 完成（build 同步副本）后**自动 checkpoint**。

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 16 个 solution 全文加入检索池 → budget 3000 chars 不够 | recall 输出截断、信息丢失 | 用 `slice(0, 800)` cap 单 solution body；DEFAULT_LIMITS.solutionTop=3 限制 |
| mcp/lib/memory-search.js 副本是另一条 propagation 链 | plugin Codex MCP 调用读旧版 | T5 确认；如果是 ad-hoc 复制改 build 加 copyMcpLibs |
| 归档脚本破坏 CLAUDE.md 格式（kill 索引段标题 / 误删其他段）| 静默丢内容 | 严格 sentinel match（`### 解决方案索引` line + 下一 `### ` 或 EOF）；先 backup `CLAUDE.md.bak.<date>` 再改；T6 dogfood 比对 wc -l |
| /compound LLM 协议 改了但模型不遵守 | 索引段仍可能增长 | 这是 [[mechanism-over-discipline]] 已知风险；本 sprint 不上 enforcement（避免 scope creep）；接受"靠 skill doc 记得"现实，触发点超 10 条再考虑 enforcement |
| 缺 frontmatter 的 solution 解析失败 | 该 solution 召不回 | collectSolutionFiles fallback：filename 提取 date + body h1 提取 title；T8 S23 专测此场景 |
| 跨副本同步漏 | pre-commit checkPropagateSync 拒 commit | 按本仓库已有 enforcement，T5 + T10 真跑 |
| docs/solutions/ 新增 frontmatter 字段冲突 Obsidian | Obsidian Graph 显示异常 | 仅在 archive 文件加 `type: archive`（已存在 Obsidian 模板字段）；不动 solution 自身 frontmatter |

---

## 6. 测试策略

**整体 L3**（涉及检索 + 归档 + 跨副本）。各 task：

| 类 | 测试 | 工具 |
|----|------|------|
| T1-T3 单测 | scoreSolution 权重 / collectSolutionFiles fallback | node:assert |
| T1-T3 集成 | searchMemory 返回 shape | test-memory-search.js |
| T4 集成 | prompt-submit pipe-in JSON → stdout | bash one-liner |
| T5 同步 | LF-normalized sha256 全等（pre-commit-check）| `node scripts/pre-commit-check.js` |
| T6 dogfood | 跑前后 CLAUDE.md `wc -l` 差异 = 老条目数；archive 文件存在 + 内容包含老条目 | wc + grep |
| T6 idempotent | 同日跑 2 次：archive 文件不重复增长 | diff before/after |
| T7 propagate | propagate-command-changes 跑后 3 副本 sha256 全等 | `node scripts/propagate-command-changes.js` |
| T8 self-test | 26 个 self-test 全过 | `node scripts/test-memory-search.js` |
| T9 端到端 | 3 个真实关键词 → recall 命中 | manual stdin pipe |
| T10 最终 | pre-commit-check exit 0 + propagate --check exit 0 | bash one-liner |

---

## 7. Dogfood 边界产物枚举（兑现 ADR-013 §B）

本 sprint **不引入 pre-commit enforcement**，但归档脚本是新工具，仍需 dogfood：

| 边界产物 | 当前数 | 期望脚本行为 |
|---------|--------|------------|
| CLAUDE.md 现有 15 条索引 | 15 | 跑后剩 5 条；老 10 条进 archive；不破坏其他段 |
| 第二次跑（idempotent）| 5 条 + 已 archive | noop（不增加 archive、不动 CLAUDE.md）|
| 索引段已 ≤ 5 条 | 假设 3 条 fixture | noop 退出 0 |
| 缺索引段 sentinel 完全（极端）| 假设无 `### 解决方案索引` | 报错 exit 1（防误删其他段）|
| Archive 文件已存在但今日 archived_at 不同 | 历史归档 | 创建新 archive 文件而非覆盖（基于 archived_at 日期）|

5 个边界场景 + dogfood 当前 CLAUDE.md 实操（T6 子步骤）。

---

## 8. 任务执行（Phase 3 待 'go'）

- [ ] T1: 加 `collectSolutionFiles()` + `scoreSolution()`
- [ ] T2: `searchMemory()` 接受 `cwd` + 调 `collectSolutionFiles`
- [ ] T3: `formatRecallContext()` 加 solution 段输出
- [ ] T4: `prompt-submit.js` 传 `cwd: process.cwd()`
- [ ] T5: 跑 build 同步 plugin 副本 + 确认 mcp/lib
- [ ] T6: 新增归档脚本 + dogfood
- [ ] T7: 修订 /compound skill + command（含 propagate）
- [ ] T8: 扩展 test-memory-search.js 加 5 self-test
- [ ] T9: 端到端 smoke
- [ ] T10: 最终 pre-commit + propagate 验证

---

## 9. 完成标准

- [ ] 26/26 self-test 全过
- [ ] CLAUDE.md 索引段 5 条 ≤ 2k chars
- [ ] `docs/archives/CLAUDE-solutions-index-2026-05-14.md` 存在且含 11 老条目
- [ ] 端到端：3 个 prompt 关键词 → recall 命中相关 solution
- [ ] pre-commit-check exit 0
- [ ] propagate-command-changes --check exit 0
- [ ] build-codex-plugin 跑后 plugin 副本 sha256 与源 LF-normalized 相同
- [ ] CLAUDE.md frontmatter 不变（除索引段外其他段未动）

---

## 10. 变更日志

- 2026-05-14: Phase 1 评估完成（"是否还有必要"判断 = 需要但 scope 修订）
- 2026-05-14: Phase 2 plan 完成，10 任务拆解，关键假设 10 项验证（7 ✅ 3 ⚠️ Phase 3 复核）

---

## 下一 Phase 预热（Phase 3: Work）

**关键文件**：
- `scripts/lib/memory-search.js` (441 lines) - 主修改对象
- `scripts/prompt-submit.js` (203 lines) - 1 行扩参
- `scripts/test-memory-search.js` (427 lines) - +120 lines 测试
- `plugins/tech-persistence/scripts/build-codex-plugin.js:167` - 副本同步入口

**执行命令**：
- `node scripts/test-memory-search.js`（建立基线 21/21 pass）
- `head -30 docs/solutions/2026-05-13-skill-evolution-architecture.md`（看 frontmatter 标准）
- `node scripts/pre-commit-check.js`（基线 exit 0）

**风险预判**：
- T6 归档脚本是 destructive on CLAUDE.md —— 必须先 backup，T6 dogfood 前 commit current state
- T5 mcp/lib 副本可能需要额外 propagation 步骤，比预估多 5-10 min
- /compound skill 改完后**不会立刻生效**（需要下次 /compound 调用），无法在本 sprint 端到端验证 LLM 协议
