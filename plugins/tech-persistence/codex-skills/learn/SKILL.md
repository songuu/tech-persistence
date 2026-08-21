---
name: learn
description: Codex-compatible entry point for the former /learn command. 从当前会话提取技术经验并提交可审计学习候选（/compound 的轻量版）
---

# Learn

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin `commands/*.md` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former `/learn` command.

## Invocation

Use `$learn <arguments>` or select this skill through Codex's `@` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention `/learn`, interpret that as this `$learn` skill invocation while running in Codex.

## Command Instructions

# /learn — 轻量经验提取

分析当前会话，提取有价值的技术经验和行为模式。
是 `/compound` 的子集——不生成解决方案文档、不采集 skill 信号。适合小改动和探索性会话。

## Self-learning candidate gate

- 行为学习输出统一为 `LearningCandidate`，通过 canonical `scripts/self-learning.js` 执行 `propose`；
  可在证据完整时执行独立 `evaluate`，随后只能进入 `shadow`。
- 自动流程最多执行 `propose`、`evaluate`、`shadow`；不得执行 `approve`、`promote`，不得直接写
  `AGENTS.md`、rules、instinct、skill、command 或任何 runtime marker。
- 用户选择候选、通过 G1-G5 或重复观察都不是 promotion approval。`approve` 必须引用绑定当前
  candidate hash 的显式 `user.approval` 与 approval receipt；`promote` 是后续独立治理动作。
- confidence 是输入信号，不是 TV、事实状态或发布授权；缺少 provenance、最终处置或反例检查时
  保持 `proposed`/`needs-review`。

## 执行步骤

1. 读取 AGENTS.md、`.codex/rules/`、已有本能，了解现有知识
2. 扫描会话，识别：踩坑、调试经验、架构决策、性能发现、工具技巧
3. 识别行为本能：用户纠正、工具偏好、重复模式、错误解决
4. 质量筛选：有场景、有根因、有方案、不重复
5. **scope 判定**（见下方 Gate 规则），默认提出 project scope；严格 Gate 仅决定候选是否可建议更宽 scope
6. 为每条通过质量筛选的模式生成 EvidenceRef，并 `propose` candidate；不直接写行为资产
7. 输出 `candidate_id`、`candidate_hash`、scope、owner、confidence、TV/反例缺口及每条 Gate 判定

## Scope 建议：严格 Gate（personal/global 候选 vs project 候选）

**默认**：所有经验只提出 project-scope candidate；不直接写 `<project>/AGENTS.md` 或 rules。

**例外**：只有同时满足下列 **全部 5 条** 时，才允许把 candidate 的建议 scope 提升为
personal/global；这仍不授权写入 `~/.codex/AGENTS.md`：

- **G1 · 无项目痕迹** — 不含任何项目名、产品名、文件路径、接口名、数据库表名、业务术语
- **G2 · 无技术栈绑定** — 不绑定特定库/框架/版本（排除 "mermaid v11"、"React 18 hydration"、"FastGPT SSE" 这类）
- **G3 · 方法论而非修复** — 是原则或方法（"如何验证 X"、"如何设计 Y"），不是"某个 bug 的具体解决方案"
- **G4 · 多项目验证** — 至少在 **2 个不同项目** 中独立观察到过同一现象（能在本能记录、solutions 索引或会话历史里找到证据；单次观察一律不通过）
- **G5 · 单句普适** — 能用一句话表述成跨技术栈、跨语言都成立的通用规则

**判定原则**：

- 任何一条不满足 → candidate scope 必须是 project，禁止建议更宽 scope
- 存疑 → project scope 或 `needs-review`
- `propose` 前必须在输出报告中逐条列出 Gate 判定（✅/❌ + 理由），让用户能 review 并否决
- 带案例/引用的条目（"案例：xxx 项目"）天然不通过 G1，只能提出 project-scope candidate
- 即使 5/5 通过，也只改变 scope 建议；后续 `approve`/`promote` 仍需独立人工 gate

**建议 personal/global scope 时的输出示例**：

```text
📤 LearningCandidate scope 建议：personal/global — <规则一句话>
   G1 无项目痕迹:   ✅ 不含项目名/路径
   G2 无栈绑定:     ✅ 与具体框架无关
   G3 方法论:       ✅ "如何验证"型原则
   G4 多项目验证:   ✅ ai-brain-web + xxx 均观察到
   G5 单句普适:     ✅ 可跨栈表述
   → 通过 5/5，仅允许建议更宽 scope；未批准、未发布、未写 runtime
```

## 输出合同

每条候选至少报告：

```text
candidate_id: <stable-id>
candidate_hash: <content-hash>
status: proposed | needs-review | evaluated | shadow
scope: <project|personal|global>
owner: <identity>
confidence: <signal only>
evidence_refs: [...]
counterexample_refs: [...]
```

若 canonical writer、schema、redaction 或 readback 失败，报告 partial/failed 并停止；不得回退到旧的
Markdown instinct/rule 直接写路径。

## 何时用 /learn vs /compound

- `/learn`：小改动、探索调研、快速提取
- `/compound`：完整功能开发后、需要生成解决方案文档、需要采集 skill 信号
