---
description: "根据代码变更的风险等级自动决定测试深度并执行：L0免测→L4全面测试"
---

# /test — 风险自适应测试

评估当前变更的风险等级，自动决定测试深度，生成并执行测试。

## 用法
```
/test                 ← 分析当前 git diff，自动评估+测试
/test L3              ← 强制使用指定等级（覆盖自动评估）
/test --dry           ← 只输出评估结果和测试计划，不写测试
/test --coverage      ← 执行测试并输出覆盖率报告
```

## 执行流程

### 步骤 1: 变更扫描
读取 `git diff --staged`（或 `git diff`），提取：
- 变更文件列表和类型（.ts/.tsx/.css/.json/...）
- 每个文件的变更行数
- 变更涉及的模块/目录

### 步骤 2: 风险评估（假设驱动，不问问题）
对每个变更文件自动评估，直接输出结果：

```markdown
## 风险评估

| 文件 | 影响面 | 可逆性 | 类型 | 等级 |
|------|--------|--------|------|------|
| src/api/auth.ts | 高 | 高 | 修改 | L4 ⚡ |
| src/components/UserTable.tsx | 中 | 低 | 新增 | L2 |
| src/styles/table.css | 低 | 低 | 样式 | L0 |
| src/utils/format.ts | 中 | 低 | 修改 | L2 |

整体等级: L4 (取最高)
⚡ auth.ts 涉及认证逻辑，自动升级到 L4

评估有误？回复调整，如 "auth.ts 只改了日志，降到 L1"
```

### 步骤 3: 生成测试计划
基于等级生成具体测试计划：

```markdown
## 测试计划 (L4)

### auth.ts — 认证模块 (L4: 20+ 用例)
  正常路径:
    - 有效 token → 认证通过
    - 刷新 token → 返回新 token
  异常路径:
    - 无效 token → 401
    - 过期 token → 触发刷新流程
    - 刷新也失败 → 登出
  安全:
    - SQL 注入尝试 → 拒绝
    - token 篡改 → 拒绝
  幂等性:
    - 重复刷新请求 → 只执行一次

### UserTable.tsx — 用户表格 (L2: 6 用例)
  - 有数据渲染正确
  - 空数据显示空状态
  - 加载态显示 Skeleton
  - 点击行触发回调
  - 分页切换触发请求
  - 搜索输入触发查询

### format.ts — 格式化工具 (L2: 5 用例)
  - 正常手机号脱敏
  - 空值不崩溃
  - 非标格式处理
  - 特殊字符处理
  - 边界长度处理

### table.css — 免测 (L0)

要执行吗？回复 "go" 开始写测试。
```

### 步骤 4: 编写测试
按计划逐文件编写测试：

```markdown
✅ auth.test.ts — 22 用例 (L4)
✅ UserTable.test.tsx — 6 用例 (L2)
✅ format.test.ts — 5 用例 (L2)
⏭️ table.css — 免测 (L0)

总计: 33 用例，3 个测试文件
```

### 步骤 5: 运行测试
```
🧪 运行测试...

  auth.test.ts:        22 passed ✅
  UserTable.test.tsx:   5 passed, 1 failed ❌
  format.test.ts:       5 passed ✅

❌ 1 个失败:
  UserTable.test.tsx > 搜索输入触发查询
  Expected: debounce 300ms 后调用 onSearch
  Received: 立即调用 onSearch

  → 这是 bug 还是测试写错了？
```

### 步骤 6: 修复循环
如果测试失败：
- 判断是代码 bug 还是测试写错
- 代码 bug → 修复代码 → 重跑
- 测试错误 → 修正测试 → 重跑
- 最多 3 轮修复，仍失败则暂停报告

---

## 与 /work 的集成

当 `/work` 执行时，每完成一个 Task 后自动进行测试判断：

```
/work 执行 Task N
  ↓ Task 完成
  ↓ 自动评估 Task 涉及文件的风险
  ├── L0 → 跳过测试，继续下一个 Task
  ├── L1-L2 → 写冒烟/标准测试，运行通过后继续
  └── L3-L4 → 写严格/全面测试，运行通过后继续
       ↓ 失败 → 修复 → 重跑 → 通过后继续
```

这意味着 **/work 中的测试是增量的**——每个 Task 只测自己涉及的文件，不跑全量测试。

---

## 与 /review 的集成

`/review` 的"测试覆盖"视角现在基于风险等级检查：

```markdown
### 测试覆盖审查

| 文件 | 风险 | 应测等级 | 实际 | 结论 |
|------|------|---------|------|------|
| auth.ts | L4 | 20+ 用例 | 22 用例 | ✅ 充分 |
| UserTable.tsx | L2 | 5-10 用例 | 6 用例 | ✅ 充分 |
| format.ts | L2 | 5-10 用例 | 0 用例 | 🔴 缺失 |
| table.css | L0 | 免测 | 0 | ✅ 正确 |

问题:
  🔴 format.ts (L2) 没有测试 — 应补充 5 个用例
```

---

## 回归测试

Bug 修复时自动生成回归测试：

```
/debug-journal 记录了 bug
  ↓ 修复代码
  ↓ 自动生成回归测试:

  it('regression: 手机号空值不应崩溃 (#fix-2025-06-20)', () => {
    // 之前这里会 TypeError: Cannot read property 'slice' of undefined
    expect(formatPhone(null)).toBe('');
    expect(formatPhone(undefined)).toBe('');
    expect(formatPhone('')).toBe('');
  });
```

回归测试永远是 L3+，确保 bug 不复发。

---

## 测试知识积累

测试中的发现纳入本能系统：
- 反复出现的测试模式 → 本能（如 `always-test-null-input`）
- 项目特有的 mock 约定 → rules/testing-patterns.md
- 测试框架的坑 → rules/debugging-gotchas.md
- 所有回归测试 → 标记 `regression: true`，永不删除
