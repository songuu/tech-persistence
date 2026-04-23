# 通用开发标准

## Git 工作流
- Conventional Commits: `type(scope): description`
- 每个提交只做一件事
- 功能分支从 main 创建，合并前 rebase

## 代码质量
- 新功能必须有测试
- 修 bug 先写复现测试
- 函数不超过 50 行，文件不超过 300 行

## 安全意识
- 不硬编码密钥/token/密码
- 用户输入必须验证
- 敏感操作必须有日志
