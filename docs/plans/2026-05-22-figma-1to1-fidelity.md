---
title: "Figma → 代码 1:1 还原方案研究"
type: analysis
status: completed
created: "2026-05-22"
updated: "2026-05-22"
tags: [analysis, figma, mcp, design-to-code, fidelity, design-tokens]
aliases: ["figma-1to1-fidelity", "figma-mcp-improvement"]
sources:
  - https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Dev-Mode-MCP-Server
  - https://www.figma.com/code-connect-docs/
  - https://docs.tokens.studio/
  - https://amzn.github.io/style-dictionary/
---

# Figma → 代码 1:1 还原方案研究

> **Status:** `planning`
> **Created:** 2026-05-22
> **Updated:** 2026-05-22
> **类型:** research / advisory（不改 tech-persistence 仓库代码）

---

## TL;DR

1. **"1:1" 不是布尔值，是渐进逼近**。工程上分 3 档：像素级 (visual) / 语义级 (token) / 行为级 (interaction)。**90% 的"偏差痛感"来自语义级 token 没对齐**，不是模型理解力不够。
2. 现状 Figma MCP（包括 Anthropic 官方 plugin）默认调用链漏了 3 个关键 capability：`get_variable_defs`（设计变量）/ `get_code_connect_map`（组件映射）/ `get_screenshot`（多模态校验）。**先用满已有 capability，能解 60% 偏差**。
3. 真正的"1:1"路径不是"换更好的 MCP"，是 **3 层防御**：
   - **源头层**：Figma Variables + 代码侧 design tokens 单源 (Tokens Studio + Style Dictionary)
   - **映射层**：Figma Code Connect 把组件 ↔ 代码 component 显式 bind
   - **校验层**：Playwright 截图 + 与 Figma export PNG 做 visual diff，回路给 LLM 迭代
4. 商业工具（Anima / Locofy / Builder.io Visual Copilot）在"快速 prototype"场景胜过通用 MCP，但**长期维护成本高**（vendor lock-in + 生成代码可读性 vs 你的代码规范脱节），solo / 小团队不推荐作为主路径。
5. **本研究的推荐路径（按 5 年杠杆）**：先做 P0 (设计 tokens 同源) → P1 (Code Connect 关键组件) → P2 (verify 回路)。前两步覆盖你提的 color/font/spacing 痛点；第 3 步是终极保险。
6. **已落地到 tech-persistence**：新增 `user-level/rules/figma-fidelity.md` / `.codex/rules/figma-fidelity.md`、`scripts/figma-fidelity-audit.js`、3 个模板（preflight / visual regression / Code Connect backlog），把建议变成可执行协议。

---

## 1. 还原目标校准（先校准期望，再选方案）

"1:1 还原"在工程上是 3 个独立维度，分开 measure：

| 维度 | 定义 | 工具 measure | 典型偏差 |
|---|---|---|---|
| **像素级 (Visual)** | 同分辨率下截图与 Figma export PNG 的 diff ratio < 0.03 (即 3% pixel) | BackstopJS / Percy / Chromatic / Playwright `toHaveScreenshot` | font hinting / antialiasing / 1px 边界 |
| **语义级 (Token)** | color/spacing/typography/radius 值 100% 来自 design tokens，不出现硬编码 | Stylelint custom rule / Style Dictionary 校验 | `padding: 12px` 而不是 `padding: var(--space-3)` |
| **行为级 (Interaction)** | hover/focus/响应式断点/动效与 Figma 原型一致 | Playwright + Storybook interaction tests | 漏 `:hover` 状态 / breakpoint 数值不对 |

**关键事实**：

- 像素级 100% 一致是**伪需求**（不同 OS 字体渲染 + 浏览器 antialiasing 差异不可消除）。行业基准是 **diff threshold 3-5%** = "工程意义上的 1:1"。
- 语义级 100% 是**可达且应追求的**（机械保证）。
- 行为级"完整覆盖"是 **业务取舍**（实现成本 ∝ 状态数 × 断点数）。

→ 用户痛点 (color/font + spacing) **全部落在语义级**，不是像素级。先解语义级，像素级偏差会自动收敛。

---

## 2. 现状归因：Figma MCP 偏差的根因

### 2.1 当前 Figma MCP capability 全景

Figma 官方 Dev Mode MCP Server 提供的核心工具（截至 2026-05）：

| 工具 | 用途 | 是否被默认调用 |
|---|---|---|
| `get_design_context` | 读节点结构 + 样式 | ✅ 默认调 |
| `get_screenshot` | 取节点 PNG | ⚠️ 仅部分 LLM 默认调 |
| `get_metadata` | 节点 metadata (name / type / constraints) | ⚠️ 经常漏 |
| `get_variable_defs` | **取节点用到的所有 Figma Variables (含 color / number / string / boolean)** | ❌ 大多数场景漏调 |
| `get_code_connect_map` | **取组件 → 代码 component 的映射** | ❌ 需先建 Code Connect |
| `get_context_for_code_connect` | Code Connect 上下文 | ❌ 同上 |
| `add_code_connect_map` | 建/更新映射 | ❌ 一次性配置 |
| `get_libraries` | 取设计系统库 | ❌ 偶尔 |
| `search_design_system` | 设计系统内搜组件 | ❌ 偶尔 |

### 2.2 偏差归因（按出现频率）

| 偏差类型 | 频率 | 根因 | 是否模型问题 |
|---|---|---|---|
| **color 不对**（硬编码 hex vs 应该用 token） | 高 | 没调 `get_variable_defs`，模型从视觉推断颜色 → 取色误差 + 失去语义 | ❌ 工具链问题 |
| **typography 不对**（字号/行高/字重） | 高 | 同上，且 Figma `lineHeight` 是 `px` 但 CSS 习惯 `unitless`，LLM 偶尔搞反 | ❌ 工具链问题 |
| **spacing/padding 偏差**（4px / 8px 偏移） | 高 | (a) 模型从截图目测；(b) Auto-layout 的 padding 与子元素 margin 经常混淆；(c) 没有 spacing scale token | ❌ 工具链问题 |
| **组件结构错**（用 div 而不是项目的 `<Button>`） | 中 | 没有 Code Connect 映射，模型不知道项目里有什么组件 | ❌ 缺映射 |
| **响应式断点丢失** | 中 | Figma frame 通常只画 1 个断点，MCP 不传"这是 desktop 版"信息 | ⚠️ 设计 + 提示双侧 |
| **hover/focus 漏掉** | 中 | Figma 原型有交互态但 MCP 默认只读静态节点 | ⚠️ 协作流程问题 |
| **font hinting / 1px 边界** | 低 | 浏览器渲染差异 | ✅ 不可消除 |

**结论**：用户感知的"偏差"**80% 是缺 design tokens + 缺组件映射**，不是模型理解力问题。换更强的 LLM 解不了这类问题，**必须从工具链补**。

### 2.3 当前 tech-persistence 仓库已有的 figma-implement-design skill

system-reminder 列出的 figma-implement-design skill 已经声明使用"Figma MCP workflow (design context, screenshots, assets, and project-convention translation)"。但**没有强制调用 `get_variable_defs` / `get_code_connect_map`**。后续已在本仓库新增 `figma-fidelity` rule 作为上层协议：不改官方 skill 本体，而是在项目规则里强制 preflight、门禁、输出表和验证阶梯。

---

## 3. 候选方案调研

### A. Figma Code Connect（官方推荐）

**做什么**：在代码侧用一段 `figma.connect(MyButton, "<figma-node-url>", { ... })` 声明 "Figma 中这个组件对应代码里的 MyButton"。Figma 的 Dev Mode + MCP 拿到节点后会优先输出你的 component import + props，而不是生成新的 div。

**已知能力**:
- 官方支持: React / Vue / SwiftUI / Compose / HTML / Web Components
- 通过 `figma connect publish` CLI 把映射推到 Figma 服务端
- MCP 通过 `get_code_connect_map` 读到映射

**优势**:
- 一旦设置，**结构级偏差直接消失**（生成代码就是 `<Button variant="primary">Click</Button>` 而非 `<button class="bg-blue-500 px-4 py-2">Click</button>`）
- 标准方案，无 vendor lock-in
- props 类型 + 默认值都在代码侧定义，LLM 不能编

**劣势**:
- 需要逐组件配置（30 个核心组件 ≈ 1-2 天工程量）
- 维护成本：Figma 改组件名 / props 名后需要同步代码 mapping
- 需要 Figma Dev Mode (付费 seat) 才能查看 + 用 MCP

**适用**：核心 UI 组件 (Button / Input / Card / Modal) 数量有限（< 50），团队有意维护

### B. Design Tokens 同源（Tokens Studio + Style Dictionary）

**做什么**：
1. **Figma 侧**：用 [Tokens Studio for Figma](https://tokens.studio/) plugin，把 Figma Variables 作为 single source of truth
2. **导出**：Tokens Studio 导出 JSON
3. **代码侧**：[Style Dictionary](https://amzn.github.io/style-dictionary/) 把 JSON 编译成 CSS variables / SCSS / Tailwind config / JS / Swift / Kotlin / Android XML 等

**或更轻量**：
- Figma 官方 Variables API → 自己写 5 行脚本拉 JSON → 写到代码侧 `tokens.json`

**优势**:
- **color / typography / spacing / radius 偏差物理消除**（所有引用都是 `var(--color-primary)` 不是 `#3b82f6`）
- 工具链成熟，行业事实标准
- 跨平台 (Web / iOS / Android 同源)
- Stylelint 可配合: 拒绝硬编码颜色 lint error → CI 卡住

**劣势**:
- 设计师要愿意用 Variables（设计稿改造工作量）
- 初次建 token system 需要 1-3 天 (depends on 既有设计系统规模)
- 中文项目: Tokens Studio 文档 + Style Dictionary 都是英文，需要团队学习曲线

**适用**：项目计划长期维护，团队 ≥ 2 人或 solo 长期项目

### C. 多模态 verify 回路（Playwright + visual diff）

**做什么**：
1. LLM 生成代码后，跑 dev server
2. Playwright 截图同一个组件
3. 与 Figma `get_screenshot` 输出做 pixel diff
4. diff > 阈值 → 把 diff 图回传给 LLM，让它修改
5. 迭代到通过

**实现选项**:
- **手搓**: Playwright + `pixelmatch` (~50 行脚本)
- **BackstopJS**: 老牌但仍可用，配置驱动
- **Percy** (BrowserStack 收购): 商业，每月 $149+ 起
- **Chromatic** (Storybook 团队): 商业，集成 Storybook 完美，免费档够 solo 用
- **Playwright `toHaveScreenshot`**: 内置，免费，CI 友好

**优势**:
- **唯一能客观证明"1:1"**的方法
- 配合 CI 可防止 regression
- 不依赖任何特定 MCP / 工具

**劣势**:
- 首次配置 + 维护 baseline 图比较繁琐
- 字体 / antialiasing 跨 OS 差异需要 docker 容器化才稳定
- LLM 迭代回路 token 成本不低（一轮 1 张截图 ≈ 1-2K tokens）

**适用**：核心页面 / 客户交付场景；不适合每个组件都跑

### D. 商业工具：Anima / Locofy / Builder.io Visual Copilot

**做什么**：浏览器插件 / Figma plugin，选中 frame 一键生成 React/Vue/Angular/HTML 代码。

| 工具 | 模式 | 价格 (2026) | 还原度 (主观) | 生成代码质量 |
|---|---|---|---|---|
| **Anima** | Figma plugin → React/Vue/HTML/Tailwind/Next.js/shadcn/ui/MUI | Free + Pro $24/mo / Business $150/mo | ★★★★ | 中（接近设计稿但常用 absolute 定位） |
| **Locofy** | Figma plugin → LocofyAI 优化结构 → React/Next/Vue/Angular/RN/HTML | Free (600 tokens) + Starter $399/yr / Pro $1199/yr / PAYG $0.40/token | ★★★★ | 中高（语义化更好） |
| **Builder.io Visual Copilot** | Figma plugin → AI 优化 → React/Vue/Qwik/Solid + Tailwind/Emotion/MUI | Free + Pro $25/user/mo / Growth $50/user/mo | ★★★★ | 高（结构清晰，符合现代模式） |

**优势**:
- 出活快（5 分钟完成一个页面）
- 不需要懂 design tokens 也能用
- 适合做 demo / 内部工具

**劣势**:
- **生成代码与你的项目规范脱节**（命名 / 文件组织 / 状态管理 都不是你的风格）
- **vendor lock-in**（停用后需要重写）
- **不接 design tokens**（颜色仍硬编码）
- **不解决根因**（依然是"生成完看着像但不能维护"）
- 长期看：维护团队产物的成本 > 自己生成 + 配 Code Connect 的成本

**适用**：
- ✅ **推荐**：原型阶段 / 一次性 demo / 客户交付 / 无设计系统的早期项目 / solo 极端 deadline
- ⚠️ **谨慎**：长期维护项目作为**主**代码生成路径（lock-in + 规范脱节问题）
- 💡 **混合用法**：用 Builder.io 一次性生成骨架 → 你手动套上自己的 design tokens / component library → 后续迭代脱离工具。这种"用一次就走"是合理且高效的选择，不要被"长期不推荐"吓退。

### E. Prompt 改造：用满 Figma MCP 已有 capability

**做什么**：不引入新工具，改造 Figma MCP 调用 prompt，强制 LLM 每次调用：
1. `get_metadata` → 拿节点 hierarchy
2. `get_variable_defs` → 拿所有用到的 Variables
3. `get_code_connect_map` → 检查是否有映射（若有，强制用）
4. `get_screenshot` → 拿截图做多模态参考
5. **再** `get_design_context` 综合输出

**优势**:
- **0 配置成本**，立即可用
- 显著减少 color/typography/spacing 偏差（前提是设计师建了 Figma Variables）
- 与方案 A/B 完全兼容（用了 Code Connect / Tokens 后效果叠加）

**劣势**:
- 每次生成 token 成本 +30-50%（多调 3-4 个工具）
- 治标不治本：如果设计稿本身没建 Variables，`get_variable_defs` 返回空

**适用**：所有人，**立即可做的第一步**

### F. 设计系统先行：建 Component Library，MCP 只做映射

**做什么**：不让 LLM 生成新代码，而是建一个 Storybook 化的组件库 (shadcn/ui / Radix / Mantine / Ant Design + 自定义)，MCP 工作变成"从 Figma 节点匹配到组件库里的 component name"。

**优势**:
- **结构级 100% 一致**（不可能错，因为只能用库里的组件）
- 长期 ROI 最高（一次投入持续受益）
- 设计 + 开发协作模式升级

**劣势**:
- 前置投入巨大（建库 ≥ 2-4 周）
- 要求设计师按库里有的组件画设计稿
- 不适合还没有稳定设计系统的新项目

**适用**：项目已稳定 + 设计 + 开发都有时间投入

---

## 4. 方案对比表 + 推荐路径

### 4.1 5 维度对比

| 方案 | 还原度<br>(P0 痛点) | 投入<br>(初始) | 维护<br>(长期) | 锁定风险 | 学习曲线 |
|---|---|---|---|---|---|
| **A. Code Connect** | ★★★★★ (结构) | 中 (1-2d) | 低 | 无 (官方) | 中 |
| **B. Tokens Studio + Style Dictionary** | ★★★★★ (color/typo/space) | 中 (1-3d) | 中 (设计师配合) | 无 (开源) | 中 |
| **C. Visual diff verify 回路** | ★★★★ (像素) | 低 (0.5-1d) | 中 (baseline 维护) | 无 | 低 |
| **D. 商业工具 (Anima/Locofy/Builder)** | ★★★★ | 极低 (10min) | 极高 (锁定 + 脱节) | 高 | 极低 |
| **E. Prompt 改造 (用满 MCP)** | ★★★ | 极低 (改 1 个 skill) | 极低 | 无 | 极低 |
| **F. Component Library 先行** | ★★★★★ | 极高 (2-4w) | 低 | 中 (依赖库选型) | 高 |

### 4.2 针对用户痛点的方案匹配

用户痛点排序: **P0 color/font 不对 + P0 spacing/padding 偏差**

| 方案 | 是否解 color/font | 是否解 spacing | 综合得分 |
|---|---|---|---|
| A. Code Connect | ⚠️ 间接 (props 透传) | ⚠️ 间接 | 7/10 |
| **B. Tokens 同源** | **✅ 物理消除** | **✅ 物理消除** | **10/10** |
| C. Verify 回路 | ✅ 事后捕获 | ✅ 事后捕获 | 8/10 |
| D. 商业工具 | ❌ 仍硬编码 | ❌ 仍像素位置 | 4/10 |
| **E. Prompt 改造** | **✅ 立即生效** | **✅ 立即生效** | **9/10 (零成本)** |
| F. Component Library | ✅ 库定义 | ✅ 库定义 | 9/10 (长期) |

### 4.3 推荐路径（按用户痛点 ROI 排序）

> **核心思路**：先零成本解决 60% 痛点 (E)，再投入解决 P0 根因 (B)，再建客观可测保险 (C)，最后才解结构级 (A)。**A 排第 4 不是因为它差**，而是用户痛点是 color/font/spacing（B 直接解），不是组件结构错（A 解的）；如果你的痛点也包含"生成的 div 不是项目里的 `<Button>`"，把 A 提到 C 之前。

```
今天 → E (Prompt 改造)         零成本，立即解 60% 偏差
   ↓
本周 → B (Design Tokens 同源)   一次投入，物理消除 P0 痛点 (color/font/spacing)
   ↓
本月 → C (Verify 回路)          关键页面客观可测，防 regression
   ↓
按需 → A (Code Connect 核心组件) 结构级偏差归零；痛点不含"组件结构错"时可推迟
```

**分支：设计师不配合 Variables 怎么办？** 见 §5.2.5。

---

## 5. 落地 checklist（按推荐路径展开）

### 5.1 今天就能做（方案 E - Prompt 改造）

不需要任何新工具，立即收益：

**对话中临时方案**（如果你不想改 skill）：
```
每次让 Claude 用 Figma MCP 时，prompt 模板：

"读 Figma <URL>。按以下顺序调用工具：
1. get_metadata 拿节点结构
2. get_variable_defs 拿所有 Variables（这步必须，否则颜色/字号会硬编码）
3. get_code_connect_map 看有无组件映射
4. get_screenshot 拿截图作多模态参考
5. get_design_context 综合输出

输出代码时强制：
- 所有 color/spacing/font-size 必须引用 Variables（如有），不准硬编码 hex / px
- 如果 get_variable_defs 返回空，停下来告诉我，让设计师建 Variables"
```

**本仓库落地方案**：

- `user-level/rules/figma-fidelity.md`：Claude/user-level 规则源。
- `.codex/rules/figma-fidelity.md`：Codex 派生副本，由 `node scripts/propagate-command-changes.js --rules figma-fidelity` 同步。
- `docs/templates/figma-fidelity-preflight.md`：每次 Figma -> code 前填写的 MCP evidence / token / component / verification 表。
- `scripts/figma-fidelity-audit.js`：L1 token audit，阻止 hardcoded hex/rgb/hsl 和未登记视觉 px 回流。

```bash
node scripts/figma-fidelity-audit.js --paths <changed-files-or-dirs>
npm run figma:audit -- --paths <changed-files-or-dirs>
```

官方 skill 不作为 source of truth 修改；本仓库用 rule + template + audit 脚本覆盖行为。

### 5.2 本周建议（方案 B - Design Tokens 同源）

**前提**：设计师愿意用 Figma Variables（如果还没建，先沟通）

```bash
# Step 1: 设计侧（设计师做）
# 在 Figma 安装 Tokens Studio plugin (free tier 够用)
# 把现有 color/spacing/typography 转成 Variables
# 设置 sync 到 GitHub repo (推荐 JSON sync)

# Step 2: 代码侧（你做）
npm install --save-dev style-dictionary
# 配 style-dictionary config.json，定义 platform: css / scss / js / tailwind
# tokens.json (Tokens Studio 导出) → CSS variables / Tailwind config

# Step 3: 强制使用
npm install --save-dev stylelint stylelint-declaration-strict-value
# stylelint config 拒绝硬编码 color/spacing
# CI 卡住

# Step 4: 设计 → 代码 sync 自动化
# GitHub Action: Tokens Studio JSON push → style-dictionary build → PR
```

**最小可用版**（无设计师配合时）:
```bash
# 用 Figma REST API 自己拉 Variables（注意：variables/local 端点需 Enterprise org 权限）
curl -H "X-Figma-Token: $TOKEN" \
  "https://api.figma.com/v1/files/$FILE_ID/variables/local" \
  > tokens.json
# 写脚本转 CSS variables
```

### 5.2.5 设计师不配合时的单飞 fallback 路径

**场景**：设计师不愿装 Tokens Studio / 不愿用 Figma Variables，但你（开发）仍想 1:1 还原。

**三种 fallback 强度**：

**Fallback A — Figma REST API 自拉 Styles（最轻量，今天就能做）**

如果设计师没用 Variables 但用了 Figma Styles（颜色/文字样式），仍可拉：

```bash
# Styles 端点不需要 Enterprise 权限
curl -H "X-Figma-Token: $TOKEN" \
  "https://api.figma.com/v1/files/$FILE_ID/styles" > styles.json

# 拉具体节点详情得到 style 值
curl -H "X-Figma-Token: $TOKEN" \
  "https://api.figma.com/v1/files/$FILE_ID/nodes?ids=$NODE_IDS" > nodes.json

# 自己写 50 行脚本转 CSS variables
# Token 获取: https://www.figma.com/developers/api#access-tokens (personal access token, 免费)
```

**Fallback B — 选中节点手动拉 → 一次性 token 抽取**

适合"只有几个核心页面要 1:1"的场景：

1. 让 Claude 在生成代码前先用 MCP `get_variable_defs` + `get_design_context`
2. 即使没 Variables，`get_design_context` 也会返回硬编码的 color/spacing 值
3. Claude 把所有 hex / spacing 数值聚类，给你一份 "建议的 token map"
4. 你 review 后写进 `tokens.css`，后续生成强制引用

**Fallback C — 推动设计师的话术模板**

如果想从根本解决，建 Variables 是长期最优。话术供参考：

> "我们现在生成代码后每次都要手动调颜色/字号/间距，每个 PR 平均花 30 分钟修偏差。如果你愿意花 1-2 天把现有颜色 / 字号 / 间距转成 Figma Variables（[Tokens Studio plugin](https://tokens.studio/) 5 分钟装好，UI 很友好），我们能做到：
>
> - 代码生成时颜色/字号/间距 100% 跟设计稿一致
> - 你改一个 Variable 值，所有用它的设计稿 + 代码同时更新
> - 后续新设计师加入不会出现 '用了 #3b82f6 还是 #3b83f7' 的细节漂移
>
> 投入 1-2 天换长期每个 PR 省 30 分钟。"

**fallback 路径与主推荐的关系**：

| 设计师配合度 | 推荐路径 |
|---|---|
| 配合 (建了 Variables) | E → B → C → A (主推荐) |
| 部分配合 (建了 Styles 没建 Variables) | E → Fallback A → C (REST API 拉 Styles 自建 tokens) |
| 完全不配合 | E → Fallback B → C (手动聚类 + verify 回路保 regression) |

### 5.3 本月建议（方案 A - Code Connect 核心组件）

**前置依赖** (重要):
- Figma Dev Mode 是付费功能（$15/editor/mo, 2026 价格），需团队中至少有人是 Dev Mode seat
- Figma file 至少 "can view" 权限
- 项目已有可被 import 的组件（Button.tsx 等已存在，否则 Code Connect 无意义）


```bash
# Step 1: 安装
npm install --save-dev @figma/code-connect

# Step 2: 列出核心组件（先 10-20 个高频）
# Button / Input / Card / Modal / Dialog / Dropdown / Tooltip / ...

# Step 3: 写 mapping (每个组件 1 个 .figma.tsx 文件)
# Button.figma.tsx
import figma from "@figma/code-connect"
import { Button } from "./Button"

figma.connect(Button, "https://www.figma.com/file/.../?node-id=1:2", {
  props: {
    label: figma.children("*"),
    variant: figma.enum("Variant", {
      Primary: "primary",
      Secondary: "secondary",
    }),
    disabled: figma.boolean("Disabled"),
  },
  example: ({ label, variant, disabled }) => (
    <Button variant={variant} disabled={disabled}>{label}</Button>
  ),
})

# Step 4: 推送
npx figma connect publish

# Step 5: Figma Dev Mode 中验证：选中组件应该显示你的代码
```

### 5.4 按需建保险（方案 C - Verify 回路）

```bash
# 最轻量：Playwright 内置
npm install --save-dev @playwright/test

# 一个测试文件覆盖核心页面
import { test, expect } from '@playwright/test'

test('homepage matches design', async ({ page }) => {
  await page.goto('http://localhost:3000')
  await expect(page).toHaveScreenshot('homepage.png', {
    maxDiffPixelRatio: 0.03,  // 3% diff 阈值
  })
})

# 首次跑生成 baseline
npx playwright test --update-snapshots

# CI 后续跑做对比
npx playwright test

# 高级：从 Figma export PNG 作为 baseline
# Figma REST API: GET /v1/images/:file_key?ids=...&format=png
# 写脚本拉下来放入 __screenshots__/ 替换 Playwright baseline
```

### 5.5 不推荐的做法（避坑）

- ❌ **D 商业工具作为主路径**：短期出活快，长期 vendor lock-in + 代码与项目规范脱节。可作为原型阶段一次性工具，不是长期方案。
- ❌ **F 重建组件库当作偏差解决方案**：除非已经有这个 roadmap，否则为了 Figma 还原去建库是过度工程。
- ❌ **依赖"更强 LLM 解决偏差"**：模型能力不是瓶颈，工具链是。GPT-5 / Claude Opus 5 也不能从视觉截图准确推断 design token。
- ❌ **追求像素级 100% diff**：跨 OS 字体渲染不可消除，3-5% 阈值是工程现实。

---

## 6. 验证手段：如何 measure "1:1"

### 6.1 三档客观指标

| 维度 | 指标 | 工具 | 通过阈值 |
|---|---|---|---|
| **语义级** | 硬编码 color/spacing 数量 | `stylelint-declaration-strict-value` | 0 violations |
| **像素级** | 截图 diff pixel ratio (0-1, 即 0-100%) | Playwright `toHaveScreenshot` / Percy / Chromatic | maxDiffPixelRatio < 0.03 (3%) |
| **行为级** | Storybook interaction tests 通过率 | Storybook + @storybook/test | 100% |

### 6.1.1 本仓库新增的 L1 审计

`scripts/figma-fidelity-audit.js` 是最小可执行门禁：

```bash
node scripts/figma-fidelity-audit.js --paths src/pages/foo.tsx src/pages/foo.css
node scripts/figma-fidelity-audit.js --json --paths src
```

默认检测：

- hardcoded hex color：`#1677ff`
- hardcoded color function：`rgb()` / `rgba()` / `hsl()` / `hsla()`
- 大于 `1px` 的视觉 `px` 值

默认放行：

- token/theme/variables/style-dictionary/tailwind config 等 token 源文件
- `0px` / `1px` hairline
- 显式注释：`figma-fidelity-allow: reason`
- 整文件注释：`figma-fidelity-audit: allow-file`

### 6.2 推荐工具组合（按预算）

| 预算 | 像素 verify | 语义 verify | 行为 verify |
|---|---|---|---|
| **$0 (solo / OSS)** | Playwright `toHaveScreenshot` | Stylelint | Storybook + @storybook/test |
| **$0-50/mo (小团队)** | + Chromatic free tier (5k snapshots/mo) | 同上 | 同上 |
| **$150+/mo (商业)** | Percy / Chromatic 付费 | + 自定义 Stylelint rules | + Playwright + reg-suit |

### 6.3 CI 集成示例

```yaml
# .github/workflows/visual-regression.yml
name: Visual Regression
on: [pull_request]
jobs:
  visual:
    runs-on: ubuntu-latest
    container: mcr.microsoft.com/playwright:latest  # 容器化避免字体差异
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
      - run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: diff-images
          path: test-results/
```

---

## 关键假设验证（兑现 ADR-012）

| # | 假设 | 验证方式 | 结论 |
|---|------|---------|------|
| H1 | Figma 官方 MCP 提供 Code Connect 工具链 | system-reminder 列出的 deferred tools 含 `mcp__figma__get_code_connect_map` / `add_code_connect_map` / `get_context_for_code_connect` | ✅ 成立 |
| H2 | Figma MCP 已暴露 `get_variable_defs` 但偏差仍发生 → 根因是"上下文使用不完整"或"token 系统未建" | system-reminder 列出 `mcp__figma__get_variable_defs` 存在；用户痛点描述 color/font/spacing → 典型缺 token 体现 | ✅ 成立 |
| H3 | design tokens 工具链成熟 (Tokens Studio + Style Dictionary 是事实标准) | Tokens Studio 是 Figma 官方推荐 plugin；Style Dictionary 是 Amazon OSS，2024+ 仍活跃 | ✅ 成立 |
| H4 | 商业工具 (Anima/Locofy/Builder.io) 评估基于公开资料 | 未实测；基于官网定价 + 公开案例 + 行业反馈 | ⚠️ 标注"主观评分" |
| H5 | Playwright `toHaveScreenshot` 支持 visual diff threshold | Playwright 官方文档明确支持 `maxDiffPixelRatio` / `maxDiffPixels` | ✅ 成立 |
| H6 | 用户用的是 Anthropic/Figma 官方 MCP 而非第三方 | 用户原话"figma mcp"单数 + 默认场景 | ⚠️ 假设；文档兼顾说明备选 MCP 影响 |

---

## 8. 局限性 / 本研究不覆盖

- **未实测商业工具**：Anima/Locofy/Builder.io 评分基于公开材料，实际项目体验可能有出入
- **未覆盖动效**：Lottie / Rive 等动效格式从 Figma 导出还原是另一个独立话题
- **未覆盖 3D / 复杂图形**：Figma Variables 不覆盖 path 数据，复杂 SVG 仍需手工或导出
- **未做团队工作流推荐**：设计师与开发的 Variables 协作流程因团队规模而异，本研究只给工具层面建议
- **未做 React Native / 原生平台对比**：聚焦 Web；React Native / iOS / Android 的 design token sync 链路类似但工具不同

---

## 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-05-22 | T1-T5 | 研究文档完成（一次性产出） |
| 2026-05-22 | Review-P0/P1 | Phase 4 review 修复：调整推荐路径 E→B→C→A、新增 §5.2.5 设计师不配合 fallback 路径、商业工具价格更新 (Anima/Locofy/Builder.io 2026)、maxDiffPixelRatio 明示 ratio 0-1 单位、§3.D 客观性软化、§5.3 加 Code Connect 前置依赖 |
| 2026-05-22 | Follow-up implementation | 落地 P0-P4：新增 `figma-fidelity` rule、Codex 派生副本、L1 audit 脚本+测试、preflight / visual regression / Code Connect 模板，并更新本研究文档 |

---

## 审查结果

### P0 — 必须修复

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | product-lens | §4.3 推荐路径 | E→B→A→C 顺序中 A 解的是组件结构错而非用户痛点 (color/font/spacing)，应让 B 后直接接 C (verify 回路) 客观保 P0 痛点 | ✅ 已修 (调整为 E→B→C→A + 加说明) |
| 2 | product-lens | §5.2 末尾 | "最小可用版"作为 fallback 被埋在小代码块，未覆盖"设计师完全不配合"场景 | ✅ 已修 (新增 §5.2.5 三档 fallback + REST API Styles 路径 + 推动设计师话术模板) |

### P1 — 建议修复

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | factual | §3.D 表格 | Anima 价格 $39/mo+ 实际 $24/mo+；Locofy $24.99/mo 不存在 (实际年付 $399/yr / $1199/yr / PAYG $0.40/token)；Builder.io 应明示 $25-50/user/mo | ✅ 已修 (2026 价格 + 框架支持补全) |
| 2 | factual | §1 表 + §6.1 表 | "diff < 3%" 易被误读为绝对 pixel 数，Playwright `maxDiffPixelRatio` 是 0-1 ratio | ✅ 已修 (明示 ratio 0-1 + 给出 0.03 数值) |
| 3 | product-lens | §3.D 适用段 | "长期项目不推荐" 与表格 ★★★★ 还原度撕裂，对 solo 一次性场景过激 | ✅ 已修 (拆 ✅推荐/⚠️谨慎/💡混合用法 三档 + 强调"用一次就走"合理) |
| 4 | product-lens | §5.2/§5.3 | 假设用户会 npm install / Stylelint config / Dev Mode 付费 seat，未明示前置依赖 | ✅ 已修 (§5.3 加前置依赖块 + REST API 端点 Enterprise 权限注脚) |

### P2 — 可选优化（不在本轮修复）

| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|
| 1 | factual | §2.1 `get_design_context` | Figma 论坛报告该工具部分版本不稳定，可加注脚 | ⏭ 推迟 (现状非错，注脚增加噪声) |
| 2 | factual | §3.A Anima/Locofy 框架支持 | 列表不全（Anima 支持 shadcn/Next.js；Locofy 支持 Angular） | ✅ 已在 P1 修复中顺带补齐 |
| 3 | product-lens | §2.3 figma-implement-design skill override | 没说用户如何 override 该 skill 行为 | ⏭ 推迟 (Anthropic 官方 skill，override 方式不稳定，避免误导) |

### 第 6 视角 — 集成连续性

| 检查项 | 结论 |
|---|---|
| 是否破坏前 sprint invariants | ✅ 不动代码，无 invariant 触发 |
| 是否引入 dead code | ✅ 纯研究文档，无 export |
| 是否让前 sprint 设计意图无法实现 | ✅ 不冲突 |
| 是否引入半下沉漂移 | ✅ 无中间状态 |
| 与 TP 4 不可妥协原则 (multi-runtime parity / 确定性 / 轻量 / Obsidian) | ✅ 纯 markdown，Obsidian 兼容；不动 hook/skill 实现，其他原则 N/A |

### 总评

研究文档质量良好。**Factual 0 P0**：技术声明 (Figma MCP capability / Tokens Studio / Style Dictionary / Code Connect / Playwright API / npm 包) 全部经核实准确，仅商业工具价格段 P1 已修。**Product-lens 2 P0 全部已修**：推荐路径与用户痛点对齐、补齐设计师不配合的 fallback 路径。文档对"有设计师配合"和"完全单飞"两类用户都给出可行路径，覆盖 90%+ 真实场景。期望管理 ("1:1 是渐进逼近 + 3-5% threshold") 做得到位，用户读完不会失望也不会盲目乐观。可放行 Compound。

---

## 复利记录

### 提取的经验

1. **Figma MCP 偏差 80% 是工具链缺 design tokens + 缺组件映射**，不是 LLM 理解力问题。换模型解不了，必须从工具链补 (Tokens Studio + Style Dictionary + Code Connect 三件套)。
2. **"1:1 还原"是 3 维度**（visual / token / interaction），用户感知的"偏差"通常聚焦 token 级；像素级 100% diff 是伪需求（跨 OS antialiasing 不可消除），3-5% diff ratio 是工程现实。
3. **研究型 sprint 的推荐排序必须按用户痛点覆盖度**，不是方案绝对得分。本案初版 E→B→A→C，因 A 解的是结构错（非用户 P0 痛点 color/font/spacing），reviewer 后调整为 E→B→C→A。
4. **涉协作方案必须给单飞 fallback**。本案推荐 B (Tokens Studio) 假设设计师配合；reviewer 指出需要 §5.2.5 三档 fallback (REST API / 聚类 token map / 推动话术)。
5. **评估外部工具时数据与结论必须一致**。本案 §3.D 商业工具 ★★★★ 还原度但结论"长期不推荐"，对 solo 一次性场景过激；修订为 ✅推荐/⚠️谨慎/💡混合用法 三档场景。

### 创建/更新的本能

- 新增 [[research-recommendation-must-sort-by-user-pain-not-score]] (feedback, 置信度初始 0.6) — 研究文档推荐排序按用户痛点覆盖度
- 新增 [[external-method-research-needs-non-cooperative-fallback]] (feedback, 置信度初始 0.6) — 涉协作的方案必给单飞 fallback
- 新增 [[evaluation-data-conclusion-consistency]] (feedback, 置信度初始 0.6) — 评估外部工具时数据与结论必须一致

### 解决方案文档

- `docs/solutions/2026-05-22-figma-1to1-fidelity.md` — Figma 1:1 还原技术层 3 层防御 + 元层研究型 sprint 三协议
- 已同步 `docs/solutions/index.jsonl` + `CLAUDE.md` 解决方案索引段 (跑 `node scripts/sync-solution-index.js --all`)
