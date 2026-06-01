---
title: "demand-side 召回 telemetry：度量注入知识是否被用（measure-before-enforce）"
date: "2026-06-01"
tags: [solution, self-evolution, telemetry, observability, agentic, measure-before-enforce]
related:
  - "[[2026-06-01-architecture-defect-analysis]]"
  - "[[ADR-022]]"
  - "[[ADR-013]]"
  - "[[ADR-017]]"
  - "[[ADR-021]]"
---

# demand-side 召回 telemetry

## 问题

分析"tech-persistence 架构针对 vibe/agentic coding 最大缺陷"时，定位到缺陷 A：**纪律 + 记忆都寄生在"模型自愿遵守"上**。think→plan→work→review→compound 全是 model-driven markdown 协议（[[ADR-021]] 已证 `/sprint` 无宿主进程），知识层产出靠 SessionStart 被动注入 12KB，"沉淀→被读→被遵守→改变行为"每环无进程级强制。

铁证：现有 recall telemetry 的 `hit_rate = indexed_entries / total_entries`（`scripts/test-memory-recall-telemetry.js:77`）测的是**供给侧覆盖率**（塞了多少进索引），**完全没有需求侧信号**——注入的知识有没有被实际用上，系统零可观测性。复利的前提"上次经验这次被用上"既无强制、也无信号。

## 根因 / 洞察

缺陷 A 分两层：

- **A1 可测外围**：知识"供给"有统计、"需求/使用"无统计 → 可用启发式 demand-side telemetry 缓解。
- **A2 不可消除内核**：模型是否"语义遵守"了注入纪律，是语义判断、无 exit code、hook 看不到（[[ADR-017]] 边界）→ 只能显式接受为 model-driven + 4 不可妥协（[[ADR-011]]）的固有代价。

关键约束（[[ADR-012]] 勘察发现）：`commandDomain()` 只输出 `testing`/`toolchain`/`git` 三值，而 instinct domain 词表更宽（`workflow`/`debugging`/`architecture`...）。两词表不对齐 → 直接交集会系统性误报"沉睡"。

## 解法

**measure-before-enforce**：先建需求侧度量，零 enforcement，证明价值后再决定是否下沉裁剪。

1. **SessionStart**（`inject-context.js`）写 `injected manifest`（`telemetry/injected-<sid>.json` + 总写 `injected-latest.json` 兜底）：注入的 instinct domain 集合 + 计数。只存 domain 名（受控词表）+ hash + 计数，**无 body**。
2. **Stop**（`evaluate-session.js`）读 manifest + 本会话 observations，经**宽松** `inferSessionDomains`（对齐 `CONFIG.domains` 全词表，宁可多算碰到、少误报沉睡）推断触及 domain → 交集算 `usage_rate` + `dormant_domains`（注入了但没碰到 = 退化核心信号），append 独立 `recall-usage.jsonl`（不污染供给侧 `memory-recall.jsonl`）。
3. **消费点**（防 dead-on-arrival，[[feedback_enforcement_dead_on_arrival_82pct]]）：cost summary 高频（SessionStart 附 `prior-session demand-side recall` 行）+ `/review-learnings --recall` 低频全量审计。

新 lib `scripts/lib/recall-usage.js`（纯函数 + 读写），18 单测覆盖启发式/边界/脱敏/fail-open。

## 预防 / 规则

1. **度量注入系统时区分 supply-side（覆盖率）vs demand-side（使用率）**——`indexed/total` 不能当"知识在起作用"的证据。
2. **未证机制先 measure 后 enforce**——measure-before-enforce 是 [[ADR-013]] mechanism-over-discipline 的前提；无数据的 enforcement 是盲下沉。
3. **plan 阶段验证 consumer 文件的 propagate 归属**——retrospective 是项目级模板（无 propagate），实施才发现，改 review-learnings（标准 propagate）。consumer 文件的同步机制是 load-bearing 假设（[[ADR-012]]）。
4. **demand-side 启发式宽松**——假阳性方向应是"低估 dormant"（漏判被碰），不是"误报沉睡"。
5. **已知上限**：本仓库 15 个注入 instinct 去重后 domain 仅 `workflow`/`code-style`（`detectPatterns` 主产 workflow/debugging）——instinct domain 多样性低限制区分度，是 A1 真实上限。

## 关联

- 架构决策：[[ADR-022]]（A1/A2 分层）
- 缺陷分析全文 + 次级缺陷 B/C/D/E：[[2026-06-01-architecture-defect-analysis]]
- deferred：基于 dormant 信号的本能裁剪 enforcement（证价值后下沉）
