# 测试模式 & 反模式

> 由 /learn 自动追加。测试域本能毕业后写入此处。

## 测试环境配置
<!-- 框架、数据库、Mock 策略 -->

## 有效的测试模式

- Agent Harness 跨平台变更同时跑新增 focused suites、受控 Linux 身份下的 smoke、plugin projection validator 和全量基线。全量失败要按失败文件集合与已知基线对比；Windows 8.3 短路径失败不能掩盖 focused 回归结果，也不能被错误宣称为全绿。
- 外部 runtime 晋级测试必须同时验证：固定 canary 用例集合、模型对输入内容哈希的精确回显、promotion 对 canary receipt 的链式绑定、零 effect/identity mismatch、Schema 真实格式、唯一 writer 与 partial/committed effect 后禁止切换。PostgreSQL durability 必须由独立 reader 精确回读，并覆盖重复消费和不可达时不 ack。

## 测试反模式（踩过的坑）
