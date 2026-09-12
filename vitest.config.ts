import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Resolve the sibling package to its source rather than to `lib/`.
 *
 * The tool package imports the domain package by name, and its published entry
 * points at built output that does not exist until `pnpm build` has run. Tests
 * resolve the source instead, so `pnpm test` never depends on build order.
 */
const domainSource = (subpath: string): string =>
  fileURLToPath(new URL(`./packages/observational-memory/src/${subpath}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: '@deepseek-ai/dsh-observational-memory/startup', replacement: domainSource('startup.ts') },
      { find: '@deepseek-ai/dsh-observational-memory', replacement: domainSource('index.ts') },
    ],
  },
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
