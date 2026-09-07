import { defineConfig, devices } from '@playwright/test';

/**
 * Browser e2e for the demos, run on demand with `pnpm test:e2e`.
 * The file and recovery suites mock the hub; demo.spec.ts needs a live API
 * and agent. All suites need a running demo — see docs/testing.md.
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
