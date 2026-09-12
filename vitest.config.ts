import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      // The same gate the harness applies to its own packages: every file at
      // 100%, or it does not merge. The package was written under this rule, and
      // keeping it here is what stops the standalone line from drifting.
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
