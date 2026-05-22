# Figma Code Connect Mapping Checklist

> 用途：把 Figma component 显式映射到项目真实组件，避免生成 raw `div/button/input`。

## Prioritization

先映射高复用、低变体复杂度组件：

| Priority | Component | Reason |
|---|---|---|
| P0 | Button | 高频、变体少、结构偏差常见 |
| P0 | Input / Textarea | 表单页常见 |
| P0 | Select / Dropdown | 交互结构容易错 |
| P1 | Modal / Dialog | overlay、focus、portal 容易错 |
| P1 | Card / Panel | layout shell 高频 |
| P1 | Tabs / Segmented control | active state 容易错 |
| P2 | Table / Data grid | 项目差异大，先做核心 props |
| P2 | Upload / DatePicker | 依赖第三方库，逐项目确认 |

## Backlog

| Priority | Figma component URL | Figma props | Code component | Source path | Mapping status | Notes |
|---|---|---|---|---|---|---|
| P0 |  |  |  |  | pending |  |

## React Mapping Skeleton

```tsx
import figma from '@figma/code-connect';
import { Button } from './Button';

figma.connect(Button, 'https://www.figma.com/design/<file>/<name>?node-id=<node>', {
  props: {
    children: figma.children('*'),
    variant: figma.enum('Variant', {
      Primary: 'primary',
      Secondary: 'secondary',
    }),
    disabled: figma.boolean('Disabled'),
  },
  example: ({ children, variant, disabled }) => (
    <Button variant={variant} disabled={disabled}>
      {children}
    </Button>
  ),
});
```

## Done Criteria

- `get_code_connect_map` returns the code component for the Figma node.
- Generated code imports the project component, not raw HTML recreation.
- Props map covers required variants and disabled/loading states.
- Mapping file lives next to the component or in a documented Code Connect folder.
- Mapping is published with `figma connect publish` and rechecked in Dev Mode.
