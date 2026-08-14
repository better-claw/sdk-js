import { defineConfig, devices } from '@playwright/test';

/**
 * Browser e2e for the demos. Deliberately NOT wired into CI: these need a
 * running hub API and an agent that actually answers, so they run on demand
 * with `pnpm test:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  // A cold agent can take minutes; failing fast here would only produce flakes.
  timeout: 360_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});
