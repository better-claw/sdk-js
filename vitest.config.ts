import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `e2e/` is Playwright's and needs a live stack — see playwright.config.ts.
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'demo/**'],
  },
});
