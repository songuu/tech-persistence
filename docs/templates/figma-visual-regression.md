# Figma Visual Regression Template

> 用途：关键页面 / 客户交付 / 严格 1:1 场景。先保留本模板，再复制到目标前端仓库。

## Dependencies

```bash
npm install --save-dev @playwright/test
npx playwright install --with-deps chromium
```

## Playwright Config

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

## Test

```ts
// tests/visual/<page>.spec.ts
import { expect, test } from '@playwright/test';

test('<page> matches Figma baseline', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000/<route>');
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot('<page>.png', {
    fullPage: true,
    maxDiffPixelRatio: 0.03,
  });
});
```

## Baseline Flow

1. 用 Figma MCP `get_screenshot` 导出目标 node PNG。
2. 固定 viewport、font、deviceScaleFactor。
3. 首次生成 baseline：

```bash
npx playwright test --update-snapshots
```

4. 后续 PR：

```bash
npx playwright test
```

## CI Notes

```yaml
name: visual-regression
on: [pull_request]
jobs:
  visual:
    runs-on: ubuntu-latest
    container: mcr.microsoft.com/playwright:latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
      - run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: visual-diff
          path: test-results/
```

## Acceptance

- `maxDiffPixelRatio <= 0.03` for key desktop frame.
- Mobile/tablet frames each need separate Figma baseline.
- If screenshot diff fails because of real design drift, update baseline only after human review.
- If font rendering differs by OS, run in Playwright container before adjusting threshold.
