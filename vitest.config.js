import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      // Everything that ships is measured: the pure logic in src/lib AND the
      // browser glue (popup, options, background, theme boot), which is driven
      // through jsdom against a fake chrome API — see tests/helpers/extension.js.
      include: ['src/**/*.js'],
      thresholds: {
        // Floor for the whole extension.
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        // The framework-free core holds the logic that can silently lose a
        // user's app list, so it is held to a higher bar. (Glob groups are
        // matched against POSIX-style relative paths, so this stricter gate is
        // the Linux CI run's; the floor above applies everywhere.)
        'src/lib/**': {
          statements: 95,
          branches: 85,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
