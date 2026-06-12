import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      // Only the pure, framework-free logic carries a coverage gate. UI glue
      // (popup/options/background) is exercised by hand and by load-unpacked
      // smoke testing — see docs/architecture.md.
      include: ['src/lib/**/*.js'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
