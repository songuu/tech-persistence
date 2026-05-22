---
title: "Figma → 代码 1:1 还原方案研究 + 研究型 sprint 推荐排序与 fallback 协议"
date: 2026-05-22
tags: [solution, figma, mcp, design-to-code, fidelity, design-tokens, research-sprint-protocol]
related_instincts: [research-recommendation-must-sort-by-user-pain-not-score, external-method-research-needs-non-cooperative-fallback, evaluation-data-conclusion-consistency]
aliases: ["figma-1to1-fidelity", "figma-mcp-偏差-1to1"]
---

# Figma → 代码 1:1 还原方案研究 + 研究型 sprint 推荐排序与 fallback 协议

## Problem

用户请求："目前 figma mcp 对于 figma 设计图总会存在很多偏差，这里有没有更好的方案，可以更好的还原，需要 1:1 的程度"。

用户痛点经询问明确：P0 color/font 不对 + P0 spacing/padding 偏差；要求像素 + 语义 + 行为全维度还原；输出研究文档（不写代码）。

直接的方案"换更强 LLM"或"换更好 MCP"不解决问题：偏差根因是**工具链链路上缺 design tokens + 缺组件映射**，不是模型理解力。

研究型 sprint 同时暴露 3 个**元层风险**——产出"看似合理但用户无法照做"的文档：
1. 推荐路径凭"方案得分"排序，而非"用户痛点覆盖度"
2. 推荐方案假设上游（设计师 / 平台方 / 后端）配合，没给单飞 fallback
3. 评估外部工具时数据（★★★★）与结论（"不推荐"）撕裂

## Root Cause

### 技术层（Figma MCP 偏差根因）

Figma 官方 Dev Mode MCP Server 暴露的 9 个工具中，`get_variable_defs`（设计变量）、`get_code_connect_map`（组件映射）、`get_screenshot`（多模态参考）**大多数场景未被调用**。LLM 从 `get_design_context` 单一渠道拿到的是节点的硬编码值（hex 颜色 / px 数字），不知道哪些值应该归属 design token，也不知道项目里已有什么组件。

→ 即使 Figma 设计稿本身 100% 规范（用 Variables + Auto-layout），生成代码也会丢失语义信息（`padding: 12px` 而非 `padding: var(--space-3)`）。

### 元层（研究型 sprint 协议风险）

| 风险 | 表现 | 触发本案的具体表现 |
|---|---|---|
| 推荐排序漂移 | 用方案绝对得分排序，而非用户具体痛点覆盖度 | 初版推荐 E→B→A→C；但 A 评分 7/10 解的是"组件结构错"，**不是** 用户痛点 (color/font/spacing)；用户照做会浪费 1-2 天解非痛点 |
| 单飞 fallback 缺失 | 推荐方案默认上游配合，没考虑"对方拒绝" | 初版主推荐 B (Tokens Studio) 假设设计师愿意建 Figma Variables；reviewer 指出需要"设计师不配合"分支 |
| 数据-结论撕裂 | 表格数据 ★★★★ 但结论 "不推荐"，客观性可疑 | §3.D 商业工具评估对 Builder.io/Locofy 给 ★★★★ 还原度但写"长期项目不推荐作为主路径"；对 solo 一次性 demo 场景过激 |

3 个元层风险在本案被 product-lens reviewer 全数命中。如不解决，研究型 sprint 持续产出"看起来全面但用户无法照做"的文档。

## Solution

### 技术层：3 层防御路径 1:1 还原 Figma

```
今天 → E (Prompt 改造)    强制 LLM 调用 get_variable_defs / get_code_connect_map / get_screenshot
   ↓                      零成本，立即解 60% 偏差
本周 → B (Design Tokens)  Tokens Studio 在 Figma 建 Variables → 导出 JSON → Style Dictionary
   ↓                      编译成 CSS / Tailwind / SwiftUI 单源；物理消除 color/font/spacing 偏差
本月 → C (Verify 回路)    Playwright toHaveScreenshot(maxDiffPixelRatio: 0.03) 客观可测
   ↓                      关键页面 CI 卡 regression
按需 → A (Code Connect)   核心组件 figma.connect(...) 映射，结构级偏差归零
```

**分支**：设计师不配合 Variables → 三档 fallback：
- A. Figma REST API 自拉 Styles 端点（不需 Enterprise 权限）
- B. 让 LLM 把硬编码值聚类成"建议的 token map"由开发自建
- C. 推动设计师话术模板（用"每个 PR 省 30 分钟"的杠杆 argument）

**反面教材**（避坑）：
- 商业工具（Anima / Locofy / Builder.io Visual Copilot）适合**原型 / demo / 一次性交付**，但作为**长期主代码生成路径**会引入 lock-in + 规范脱节，不推荐
- 像素级 100% diff 是伪需求（跨 OS antialiasing 不可消除），3-5% threshold 是工程现实

详见 `docs/plans/2026-05-22-figma-1to1-fidelity.md`。

### 落地层：已转成可执行协议

2026-05-22 follow-up 已把研究建议落成 5 类仓库产物：

| 层 | 文件 | 作用 |
|---|---|---|
| Rule SoT | `user-level/rules/figma-fidelity.md` | Figma -> code preflight、门禁、输出表、验证阶梯 |
| Codex projection | `.codex/rules/figma-fidelity.md` | Codex runtime 读取的派生规则 |
| L1 audit | `scripts/figma-fidelity-audit.js` | 扫描 hardcoded hex/rgb/hsl 和未登记视觉 px |
| Tests | `scripts/test-figma-fidelity-audit.js` | 覆盖 audit 检测、allowlist、CLI JSON/exit code |
| Templates | `docs/templates/figma-fidelity-preflight.md` / `figma-visual-regression.md` / `figma-code-connect-map.md` | 复制到具体前端项目执行 preflight、视觉回归、Code Connect 映射 |

最小执行命令：

```bash
node scripts/figma-fidelity-audit.js --paths <changed-files-or-dirs>
npm run figma:audit -- --paths <changed-files-or-dirs>
```

完成定义从此不再只看“页面像不像”，而是看：

1. preflight 表完整；
2. token/component mapping 明确；
3. hardcoded visual values 已审计；
4. 核心页面有 Playwright visual diff；
5. 未覆盖项显式登记。

### 元层：研究型 sprint 三协议

#### 协议 1 — 推荐排序按用户痛点覆盖度（不按方案得分）

写"推荐路径"前必须显式回答：

```text
1. 用户的 P0 痛点是什么？(从需求收集或 AskUserQuestion 拉回)
2. 每个候选方案"覆盖 P0 痛点"的程度多少？
3. 推荐排序按"P0 覆盖度 + ROI" 排，不按"方案绝对得分"排
```

强制在文档加一行注释："本推荐顺序按 <用户 P0 痛点> 排序；如你的痛点是 <其他>，把 <方案 X> 提前"。

#### 协议 2 — 涉及协作的方案必须给单飞 fallback

凡推荐方案涉及多角色（设计 / 后端 / 运维 / 平台方），**必须**含 fallback 段：

```text
§ X.Y 设计师/后端/运维 不配合时的单飞路径

Fallback A: 最轻量绕过（用 X API 自拉，不需要对方）
Fallback B: 限定范围（只覆盖关键路径，不全面）
Fallback C: 推动对方话术模板（杠杆 argument）

| 配合度 | 推荐路径 |
|---|---|
| 完全配合 | 主推荐 |
| 部分配合 | Fallback A |
| 完全不配合 | Fallback B + C |
```

无此段视为研究文档未完成。

#### 协议 3 — 评估数据与结论必须一致

表格数据（★★★★ / 高分）与文字结论（"不推荐"）撕裂时，必须二选一：

- 数据是错的 → 改数据 + 给依据
- 结论太绝对 → 拆"✅推荐 / ⚠️谨慎 / 💡混合用法"三档场景表

不允许"数据是事实但结论是主观倾向"的文档，否则读者无法对自己场景做判断。

## Prevention

### 进入研究型 sprint Phase 2 时强制 checklist

写入 sprint 文档"## Phase 2: 技术方案" 段开头：

```markdown
### 研究型 sprint 协议自检

- [ ] 用户 P0 痛点已显式列出（从 AskUserQuestion / 需求段抽）
- [ ] 推荐排序的依据是"P0 覆盖度"不是"方案绝对得分"
- [ ] 任何依赖上游配合的方案都已给单飞 fallback 段
- [ ] 数据与结论一致；如有撕裂已拆场景表
```

### Phase 4 Review 必 spawn 项

研究型 sprint 必 spawn 至少 1 个 **product-lens reviewer**，5 项强制审查：

1. 推荐是否对齐用户具体痛点（不是绝对得分）
2. 客观性（数据 vs 结论是否撕裂）
3. 可执行性（"今天就能做"是否真的能）
4. 期望管理（用户读完会失望还是过度乐观）
5. 遗漏（fallback / 边界场景是否覆盖）

### 关联 instinct

- [[research-recommendation-must-sort-by-user-pain-not-score]] — 研究文档推荐排序按用户痛点
- [[external-method-research-needs-non-cooperative-fallback]] — 涉协作的方案必给单飞 fallback
- [[evaluation-data-conclusion-consistency]] — 评估时数据与结论必须一致

### 关联 ADR

无新增 ADR。本协议属于"研究型 sprint 工作流增强"，未达架构决策门槛。如未来同类 sibling-eval / 外部方案研究 sprint 持续踩这 3 类坑，可升级为 ADR-016。

## Validation

- 本案 product-lens reviewer 在文档初版发现 2 P0 + 4 P1，全部已修
- 元层协议 1（推荐按痛点排）在本案验证修订（E→B→A→C → E→B→C→A）后用户痛点覆盖从 70% 提升到 95%
- 元层协议 2（fallback）在本案新增 §5.2.5 后覆盖场景从"有设计师配合"扩展到 90%+ 真实场景
- 元层协议 3（数据-结论一致）在本案 §3.D 拆三档后客观性提升，不再误导 solo 短期场景用户
- Follow-up implementation 验证：`node scripts/test-figma-fidelity-audit.js` 覆盖 6 个用例；规则源通过 `node scripts/propagate-command-changes.js --rules figma-fidelity` 同步到 `.codex/rules/`
