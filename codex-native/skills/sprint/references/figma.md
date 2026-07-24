# Figma routing

仅在输入含 Figma 链接、设计稿或原型截图时读取。

## 能力门禁

1. 先判断当前模型与可调用工具能否读取所需视觉证据。对 text-only / 纯文本模型（包括 Spark）不得假定能看懂截图像素。
2. 若有 Figma URL/node 且已授权的 Figma 工具可用，可先读取结构化 node、token、组件和交互状态；只选择一个与当前工具匹配的 Figma provider，不重复加载同名 skill。
3. 若任务依赖截图/画布，而当前模型无法看图且工具也无法结构化读取，立即明确阻塞：说明缺失的证据，并路由到支持图像输入的模型，或请用户提供可结构化的 Figma URL/node/设计 token。不得凭 OCR 猜测、不得进入像素级实现。

## 意图路由

- 先区分原型需求收敛、设计到代码、视觉 bug、普通参考图；只加载命中意图所需的 skill。
- 仅有截图而无 Figma URL/node 时，默认作为参考证据；除非用户明确请求原型需求收敛，否则不加载 `prototype-workflow`，也不调用 Figma。token、组件和交互状态保持未知。
- Work 阶段建立同 viewport 的实现截图和可重复 visual diff，再逐类修 color、font、spacing、layout、asset。
- 未通过能力门禁、未获得设计证据或未跑视觉回路时，不宣称 1:1 / 像素级完成。
