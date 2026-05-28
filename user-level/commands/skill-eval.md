---
description: "[alias → /skill eval] 用测试集验证 skill：A/B 对比当前版本和提案版本的通过率"
---

# /skill-eval — Skill 验证

> **已合并到 `/skill eval <name>`**（行为完全一致，新代码请用 `/skill eval`）。本命令保留作 alias，向后兼容。

用预定义的测试用例验证 skill 的质量。

## 用法
- `/skill-eval prototype` — 验证当前版本
- `/skill-eval prototype --diff` — A/B 对比：当前 vs 提案版本

## 测试集位置
`~/.claude/homunculus/skill-evals/{skill-name}/`

如果没有测试集，先提示创建：
```
未找到 /prototype 的 eval 测试集。
要基于当前 skill 自动生成测试集吗？(y/n)
```

自动生成 3-5 个测试用例 + 5-8 个断言（如"每轮问题 <= 5 个"）。

## 从真实 trace 沉淀 case（B2，护城河强化）

自动生成的用例与 skill **同源**（自己出题给自己考），信号弱。真实失败 trace（B1 沉淀在 `skill-traces/{name}.jsonl`）是**最有价值的测试**。半自动把 trace 转为结构化 eval case：

1. 预览 trace：`node scripts/skill-traces.js list <name>`，挑一条值得固化的失败/纠正。
2. **人工确认 gate** 后转 case（CLI 内部再过一道脱敏，纵深防御 + 强制带 trace 快照）：
   ```bash
   node scripts/skill-eval-cases.js add --name <skill> \
     --input "<触发输入>" --expectation "<期望行为/断言>" \
     --from-trace '<该条 trace 的 JSON 快照>'
   ```
   追加到 `~/.claude/homunculus/skill-evals/{name}/cases/cases.jsonl`（append-only）。
3. eval 跑测试前读 case 集：`node scripts/skill-eval-cases.js list <name>`。

> **护城河确定性强化**：每条 trace-case 强制带 `provenance=trace` + `source_trace` 快照（`add` 缺 `--from-trace` 直接 `exit 2` 拒绝）。eval case 来自真实使用 trace 而非 skill 自产，**比自动生成的同源用例更隔离**。

## 输出格式
```
Eval 结果: /{name}

| 测试用例 | v1 通过 | v2 通过 |
|---------|--------|--------|
| simple  | 5/5    | 5/5    |
| medium  | 3/5    | 5/5 ↑  |
| complex | 2/5    | 4/5 ↑  |
| 总计    | 67%    | 93% ↑  |

v2 >= v1 ? ✅ 建议发布 : ❌ 回滚
```

## 记录结构化结果（publish 护栏前置）

跑完通过率后**必须**记录结构化结果，供 `/skill publish` 的确定性护栏读取（否则护栏无基线可比对，会放行退化发布）：

```bash
node scripts/skill-eval-results.js record --name <skill> --version <N> --pass-rate <0..1>
# 例：node scripts/skill-eval-results.js record --name prototype --version 2 --pass-rate 0.93
```

- `--version` 为本次被评估的 skill 版本号（正整数）。
- `--pass-rate` 为总计通过率，取 0..1 浮点（93% → 0.93）。
- 追加写入 `~/.claude/homunculus/skill-evals/{name}/results/results.jsonl`（append-only 时间线）。

## 安全规则
- eval 文件与 `results/results.jsonl` 不可被 skill 修改（防止 "改考卷通过考试"）
- eval 结果归档到 `skill-evals/{name}/results/` 供历史对比与 publish 护栏读取
