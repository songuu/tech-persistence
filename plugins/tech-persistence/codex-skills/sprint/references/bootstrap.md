# New sprint bootstrap

仅适用于普通 `/sprint` 且 `status.reason === "missing-pointer"`。这是创建新 sprint 的命令，不是“只读诊断”信号。

`/sprint` 仅授权写入启动工件：一个 `docs/plans/` 计划和 active pointer；它**不**授权 PM2 操作、上传、远程写入或数据库写入。用户任务本身仍按原有读写边界执行。

在加载 `think` 或任何业务诊断前，必须完成：

1. 不扫描历史 unfinished plan，也不以“没有 active pointer”为最终答复。
2. 用用户剩余文本生成一个日期加短 slug 的 `docs/plans/YYYY-MM-DD-<slug>.md`；内容说明请求，frontmatter 至少为 `type: sprint` 和 `status: in-progress`。
3. 运行 `node <cli> init --plan <plan> --next <think action>`。
4. 再运行 `node <cli> status`；只有 `active === true` 且 `phase === "think"` 才可加载 Think 并开始分析。

用户未提供任何任务文本时，只问一个用于确定任务范围的问题；不要把空输入误说成状态诊断。计划创建或 `init` 失败时，报告该 bootstrap 失败及原始错误，停下等待处理。
