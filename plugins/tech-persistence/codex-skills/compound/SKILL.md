---
name: compound
description: Codex-native evidence-gated knowledge compounding with bounded solution indexing and explicit write boundaries.
---

# Compound

把本次已完成工作的可复用知识沉淀下来。只读取当前目标、当前 diff、实际测试结果、review findings 和当前 Sprint 计划；不要扫描全部历史，也不要加载其他 Phase skill。

## 证据门槛

- 先分开列出**已验证事实、推断、未知项**。只有能指向代码、测试、日志、文档或用户确认的内容可以持久化。
- 只记录非平凡且可复用的根因、方案、预防措施、架构决策或测试模式。格式化、一次性操作和未验证猜测不沉淀。
- 先搜索既有 solution、rule 和 instinct；更新同一主题，避免创建近义重复项。没有新增价值时允许 no-op。

## 权限边界

- 继承当前任务的写权限；Compound 不扩大授权。仅写已在任务范围内的仓库知识文件和已配置的 Codex homunculus。
- 不修改产品代码，不提交、不推送，不调用外部同步，不覆盖用户自建资产。跨出授权路径或需要改变共享 runtime 行为时先停止并说明。
- 不改 Claude-owned command、skill 或 hook 来表达 Codex 专属策略；跨 runtime 决策必须由用户明确授权。

## Self-learning candidate gate

- `docs/solutions/` 与 index 可在现有 Compound 授权内直接新增/更新；solution 不等于 runtime 发布。
- 行为学习输出必须经 `scripts/self-learning.js` `propose`；独立 evaluator 可 `evaluate`，随后最多进入
  `shadow`，不得直接写 rule、instinct、skill、command、共享 runtime 或 marker。
- 自动流程不得 `approve`、`promote`。调用 Compound 不是 `user.approval`；approval receipt 必须独立并
  绑定当前 candidate hash，promotion/publish 是后续人工动作。

## 沉淀流程

1. **筛选**：从当前证据中提取候选知识，逐项说明为何可复用。
2. **解决方案**：需要时写 `docs/solutions/{YYYY-MM-DD}-{slug}.md`，包含 Obsidian frontmatter，以及 Problem、Root Cause、Solution、Prevention、Related。`docs/solutions/*.md` 是详情源。
3. **行为学习候选**：行为模式只提出 `LearningCandidate`。建立脱敏、hash-bound EvidenceRef，去重后
   `propose`；报告 identity、scope、owner、confidence、counterexamples、TV 缺口和状态。无真实信号
   不得伪造；旧 instinct 只能作为 `legacy-unverified` evidence。
4. **索引**：新增或更新 solution 后运行：

   ```bash
   node scripts/sync-solution-index.js --all
   ```

   该命令只重建 canonical `docs/solutions/index.jsonl`，并维护 Claude 所需的有界 `CLAUDE.md` projection。`AGENTS.md` 不嵌入 solution index；Codex 需要历史时按需读取 canonical index 或具体 solution。`--all` 仅为兼容既有自动化保留，不代表存在两个 runtime doc projection。
5. **验证**：检查目标文件 diff 和 candidate journal/readback，运行相关 schema/同步测试；同步或
   candidate writer 失败时报告 partial，不得声称 compound 完成，也不得回退到旧 direct-write 路径。

## 报告

报告新增、更新、no-op 的数量与真实路径，并附实际验证命令。Solution 行只允许写成：

```text
Solution index: <updated|unchanged|failed> <N> entries -> docs/solutions/index.jsonl; Claude projection: <updated|unchanged|failed>; AGENTS projection: disabled
```

行为学习行必须区分状态，示例：

```text
Learning candidates: proposed <N>; needs-review <N>; evaluated <N>; shadow <N>; approve/promote: not run
```

不要声称“两个 runtime docs 已同步”，也不要把本地文件写入等同于 Obsidian cloud/app 可见。若处于 Sprint，先把验证结果交回 Sprint；只有整个目标完成后才清除 active pointer。
