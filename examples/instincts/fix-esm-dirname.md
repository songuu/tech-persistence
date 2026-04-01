---
id: "fix-esm-dirname"
trigger: "在 ESM 模块中使用 __dirname 或 __filename 时"
confidence: 0.90
domain: "debugging"
type: "error_resolution"
source: "session-observation"
created: "2025-05-20"
last_seen: "2025-06-19"
scope: "global"
evolved_into: null
---

# ESM 模块中 __dirname 不可用

## Action
在 ESM (.mjs 或 package.json type=module) 中，__dirname 和 __filename 不存在。
使用以下替代方案：

```js
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

## Evidence
- 2025-05-20: 遇到 ReferenceError: __dirname is not defined，花费 15 分钟定位
- 2025-05-28: 新文件中再次犯同样错误，立即识别并修复
- 2025-06-05: 在 3 个新文件中正确使用了 import.meta.url 模式
- 2025-06-19: 自动应用，用户未纠正
