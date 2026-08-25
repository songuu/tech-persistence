---
description: "生成当前会话的完整技术总结，并通过 /learn 提交学习候选"
---

# /session-summary — 会话总结（自学习增强版）

## Self-learning candidate gate

- 会话总结文件只是报告产物，不是自动召回 authority；从总结提取的行为知识必须作为 `LearningCandidate` 经
  canonical `scripts/self-learning.js` 执行 `propose`，证据完整时才可 `evaluate`，随后只能 `shadow`。
- 自动流程最多执行 `propose`、`evaluate`、`shadow`；不得执行 `approve`、`promote`，不得直接写
  rules、instinct、skill、command、architecture marker 或共享 runtime。
- `/learn` 只授权生成 EvidenceRef/candidate proposal，不等于显式 `user.approval`。批准和发布必须由
  后续独立 gate 绑定 candidate hash 与 approval receipt。

## 报告模板

```markdown
# 会话总结 — [YYYY-MM-DD HH:MM]

## 概要
- 持续时长: ~N 分钟
- 工具调用: N 次 (主要: Read, Edit, Bash)
- authority Event/Evidence: N 条（legacy observation 另列，可能被开关禁用）

## 完成的工作
- [ ] 任务1
- [ ] 任务2

## 关键技术决策
| 决策 | 选择 | 原因 | 备选 |
|------|------|------|------|

## 踩坑 & 解决
### 问题1: [标题]
- **现象**:
- **根因**:
- **解决**:

## 待办 & 后续
- [ ] ...

## 自学习产出
### 学习候选
| candidate_id | kind | scope | evidence | status |

### 未形成候选的观察
| 观察 | 缺失证据/反例/最终处置 | 状态 |
```

## 执行步骤
1. 回顾整个会话历史
2. 按模板生成报告
3. 从稳定 session/task identity、验证结果与用户反馈建立 EvidenceRef，再用 canonical writer
   `propose` LearningCandidate；不得从总结文本直接写 rules/instinct/Memory
4. 将报告保存到 `~/.codex/homunculus/projects/{project}/sessions/`；它只供人工审阅或 legacy
   reader 兼容读取，不自动成为 Candidate evidence
5. 输出报告

## 额外行为
- 如果观察日志中有 error/Error → 按 `/debug-journal` 的 EvidenceRef→Candidate 协议提案；不自动写
  debugging rules/instinct
- 如果有架构决策 → 建立 EvidenceRef 并提出 project-scope candidate；不自动追加到
  `.codex/rules/architecture.md`
- 如果 candidate/evidence 写入、schema、hash 或 readback 失败 → 报告 partial/failed，不回退到旧
  Markdown 直接写路径
