# DeepSeek Harness 受管命令与 Skill

Harness 任务的首个非空内容可使用两种确定性入口：

- `/command [arguments]` 或 `/tech-persistence:command [arguments]`：只接受 Tech Persistence 的 canonical command inventory。
- `$skill [arguments]` 或 `$tech-persistence:skill [arguments]`：接受完整 Codex skill inventory，包括 command wrapper。

所有合法形式都会规范化为 Codex 插件的真实入口 `$tech-persistence:name [arguments]`，避免无命名空间调用被其他 skill 抢占或无法解析。

例如：

```text
/sprint --auto
把当前架构接入目标应用
```

```text
$memory find provider qualification evidence
```

普通自然语言 requirement 保持原行为。以 `/` 或 `$` 开头的显式调用如果名称未知、格式非法、含不安全控制字符或超过输入上限，会在 provider dispatch 前失败；Harness 不会让模型猜测最接近的名称。

## 运行时边界

DeepSeek 仍通过现有 OpenAI-compatible 路径承担只读 spec/review，Codex CLI 仍是唯一 implementation tool host。worker 会把显式调用规范化为 authority-owned metadata，并将原始 requirement、canonical invocation、inventory hash 与 run evidence 绑定。spec/review 不得改名、替换或吞掉参数。

每次新执行或 resume 启动 implementation provider 时，一个无网络、无 workspace、stdin 断开的 setup bwrap 会重建 task-local `CODEX_HOME`，清除 direct skills/agents/global instructions 等可覆盖执行控制面的残留，只保留 session 与非执行型 task 数据，再从只读 `/runtime` local marketplace 安装 `tech-persistence@tech-persistence-local` 并读取 plugin list 和已安装 `codex-skills` inventory。主模型 bwrap 只读挂载 plugin cache、`config.toml` 和两份 bootstrap receipt，不能在执行或 resume 间篡改受管 skill/hook/MCP；qualification 还会在运行后独立重算 inventory 与整树 SHA。bootstrap 不访问网络，也不读取宿主用户配置。插件自身若依赖未配置的外部 App、登录、网络或 UI，仍会以具体 capability 缺口失败，不能据此宣称外部依赖已可用。

## 发布与回滚

生产候选必须同时包含 marketplace manifest、plugin manifest、bootstrap 脚本和共享 inventory，并且固定 Codex runtime 必须支持 `plugin marketplace add`、`plugin add` 与 `plugin list`。任一 preflight 或 bootstrap readback 失败都不得启动 provider。

发布仍使用 immutable Harness release。失败时停止新 admission，保留 task/run evidence，并把服务指回上一合格 release；不修改数据库 schema，也不手工修补 Codex 私有 plugin cache。
