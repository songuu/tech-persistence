# 踩坑记录 & 调试经验

> 按严重程度排列。高置信度的调试本能 (/instinct-status domain:debugging) 毕业后写入此处。
> 由 /learn 和 /debug-journal 自动追加。

## CRITICAL — 必须知道

## HIGH — 容易踩到

- [2026-04-15] [powershell, encoding] **本项目生成的 .ps1 脚本必须带 UTF-8 BOM**
  - 现象：PS 脚本执行时中文变乱码（如 `测试` → `娴嬭瘯`），tokenizer 报 "ExpressionsMustBeFirstInPipeline"、"一元运算符 + 后面缺少表达式"、"语句块中缺少右 }" 等一连串语法错，看似脚本被整体破坏。
  - 根因：中文 Windows 系统 ACP = 936 (GBK)。PowerShell 5.1 对 **无 BOM** 的 .ps1 用系统 ANSI 码页解码。UTF-8 字节被当 GBK 解析后，中文字符变成非法标识符/运算符序列，tokenizer 级联崩塌。**与脚本逻辑无关**，纯编码问题。
  - 快速识别：错误行号集中在含中文的行、并且错误类型是"意外的标记"/"缺少表达式"而非运行时错误 → 99% 是 BOM 问题。
  - 修复：前置 3 字节 `EF BB BF`，PS 5.1 见 BOM 走 UTF-8 路径。bash 一行：`{ printf '\xef\xbb\xbf'; cat file.ps1; } > file.ps1.tmp && mv file.ps1.tmp file.ps1`。
  - 预防：本项目所有 .ps1（install / update / apply-*-delta 系列）生成时必须写 BOM。PowerShell 7+（pwsh）默认 UTF-8，但不能依赖用户已装 PS7——必须向下兼容 PS 5.1。
  - 历史：已踩 2 次。commit b6dc85f 修 `update.ps1`，2026-04-15 又在 `test-strategy-delta/apply-test-delta.ps1` 复现。第三次出现 = 工具链应自动化（脚本生成器强制写 BOM）。

## MEDIUM — 偶尔遇到

## LOW — 边缘情况
