// Playwright Test config for the TypeScript E2E specs in tests/e2e/.
// Uses REAL Google Chrome (channel) — same engine the agentic .cjs suites default to.
// Prereq: the built app served on :9000 (python3 -m http.server 9000 --directory dist).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: {
    timeout: 10_000,
    // Baseline pixel-diff (visual.spec.ts): allow a tiny fraction of anti-aliasing drift so the
    // tests catch real layout regressions (a shifted/overlapping box changes far more than this)
    // without flaking on sub-pixel font rendering. Baselines are per-machine and live under the
    // gitignored /tests/ tree, so personal-data snapshots never leave the device.
    toHaveScreenshot: { maxDiffPixelRatio: 0.012, animations: 'disabled', caret: 'hide' },
  },
  fullyParallel: false,          // suites drive one shared static server; keep runs deterministic
  workers: 1,
  reporter: [['line']],
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 2,        // crisp, consistent raster for the visual baselines
    acceptDownloads: true,
  },
});
