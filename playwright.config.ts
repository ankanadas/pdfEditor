// Playwright Test config for the TypeScript E2E specs in tests/e2e/.
// Uses REAL Google Chrome (channel) — same engine the agentic .cjs suites default to.
// Prereq: the built app served on :9000 (python3 -m http.server 9000 --directory dist).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,          // suites drive one shared static server; keep runs deterministic
  workers: 1,
  reporter: [['line']],
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  },
});
