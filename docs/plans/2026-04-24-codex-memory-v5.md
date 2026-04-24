# Codex Memory v5

> **Status:** `completed`
> **Created:** 2026-04-24
> **Updated:** 2026-04-24

---

## 需求分析

### 要做
- 参考 Claude Code auto memory 的 `MEMORY.md` 启动索引 + topic 文件结构，为 Codex hook 管线实现 Memory v5。
- 增强 Codex payload 规范化、敏感信息脱敏、命令状态识别、文件路径抽取。
- Stop hook 写入 `projects/{hash}/memory/MEMORY.md` 和 `memory/{topic}.md`，SessionStart 只注入轻量索引。
- 保留现有 instincts、sessions、Obsidian 兼容格式和 shared homunculus 支持。

### 不做
- 不引入外部数据库或向量检索。
- 不让 hook 调用模型做在线总结，保持确定性和低延迟。
- 不改变用户手动 `/compound` 的深度知识沉淀职责。

### 成功标准
- [x] `observe.js` 输出 v5 schema，兼容 Claude/Codex payload 差异。
- [x] `evaluate-session.js` 创建/更新 Memory v5 topic notes 和 `MEMORY.md`。
- [x] `inject-context.js` 按 200 行 / 25KB 预算注入 `MEMORY.md`。
- [x] Codex plugin 构建能复制新增 hook lib。
- [x] 验证脚本通过。

### 风险和假设
- Codex hook payload 字段可能继续变化，因此规范化逻辑采用多字段 fallback。
- 自动记忆容易写入噪声，所以 Memory v5 只接受达到置信度门槛的模式。

---

## 技术方案

### 方案概述

Memory v5 在原有 observations → instincts 管线中插入一个轻量自动记忆层：`MEMORY.md` 是启动索引，topic 文件保存细节。这个结构对齐 Claude Code auto memory 的做法：启动时只加载有限索引，详细主题按需读取，避免把所有历史细节都塞进上下文。

### 任务拆解

- [x] **Task 1**: 新增 `scripts/lib/memory-v5.js` — payload 规范化、脱敏、签名、topic 映射。
- [x] **Task 2**: 更新 hook 脚本 — `observe.js`、`inject-context.js`、`evaluate-session.js`。
- [x] **Task 3**: 更新安装/构建/验证 — 复制新增 hook lib，并校验 Codex plugin。
- [x] **Task 4**: 更新文档 — README、skills、默认 config。
- [x] **Task 5**: 运行 build、validate 和 smoke test。

### 测试策略
- 单元测试: `node --check` 覆盖新增/修改脚本语法。
- 集成测试: 构建 Codex plugin 后运行 `scripts/validate-codex-plugin.js`。
- 手动验证: 使用临时 `TECH_PERSISTENCE_HOME` 跑一组 observe/evaluate/inject smoke test。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Hook 找不到新增 lib | 中 | 高 | 更新 Claude 安装脚本和 Codex plugin 构建脚本 |
| Memory 写入噪声 | 中 | 中 | 置信度门控 + 去重 signature + `MEMORY.md` 预算 |
| Payload 字段变化 | 中 | 中 | 多字段 fallback + 保留旧字段兼容 |

### 涉及文件
- `scripts/lib/memory-v5.js`
- `scripts/observe.js`
- `scripts/inject-context.js`
- `scripts/evaluate-session.js`
- `plugins/tech-persistence/scripts/build-codex-plugin.js`
- `scripts/validate-codex-plugin.js`
- `install.sh`
- `install.ps1`
- `README.md`
- `.codex/rules/architecture.md`
- `.claude/rules/architecture.md`
- `user-level/skills/*`
- `.codex/skills/*`
- `user-level/homunculus/config.json`

---

## 实现进度

### 变更日志

| 日期 | Task | 变更说明 |
|------|------|---------|
| 2026-04-24 | Task 1 | 新增 Memory v5 工具库，统一脱敏、payload 规范化、signature 和 topic 映射 |
| 2026-04-24 | Task 2 | observe 记录 v5 schema；evaluate 写入 memory topic 和索引；inject 注入 `MEMORY.md` |
| 2026-04-24 | Task 3 | 构建脚本和安装脚本复制 `scripts/lib`；验证脚本检查 `memory-v5.js` |
| 2026-04-24 | Task 4 | README、skills、默认 config 同步 Memory v5 设计 |
| 2026-04-24 | Task 4 | `.codex/.claude` 架构规则补充 Memory v5 ADR |
| 2026-04-24 | Task 5 | 运行语法检查、Codex plugin validate、Memory v5 smoke test；收紧 auto checkpoint 阈值避免短会话副作用 |

---

## 审查结果

### P0 — 必须修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### P1 — 建议修复
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### P2 — 可选优化
| # | 视角 | 文件:行 | 问题 | 状态 |
|---|------|---------|------|------|

### 总评
已完成 v5 闭环验证：临时 homunculus 中成功生成 observations、instincts、`memory/MEMORY.md`、topic 文件和 sessions，SessionStart 注入能读取 Memory v5。

---

## 复利记录

### 提取的经验
- Hook 一旦新增 `lib/` 依赖，安装脚本和 plugin 构建脚本必须同时更新，否则用户环境会运行失败。
- Memory v5 这类 hook 管线改造需要用临时 `TECH_PERSISTENCE_HOME` 做端到端 smoke test，并检查不会写入真实 sprint handoff。

### 创建/更新的本能
- 0 个。本次沉淀更适合作为项目规则和解决方案文档，而不是用户行为本能。

### 解决方案文档
- `docs/solutions/2026-04-24-codex-memory-v5.md`
