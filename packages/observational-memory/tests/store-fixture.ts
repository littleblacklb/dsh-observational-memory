/**
 * Test-side ledger setup.
 *
 * The plugin's own `apply` publishes a store pointed at the harness home, which
 * a test must never touch. Suites that mount the plugin pass a `storageDir`;
 * suites that exercise a module directly publish a store themselves with these
 * helpers, so every test gets its own directory and no two can read each other's
 * ledger.
 *
 * Not named `*.spec.ts`, so the runner does not collect it as a suite.
 *
 * @module tests/store-fixture
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryStore } from '../src/store.ts'

/** A fresh directory for one test's ledger. */
export function tempStoreDir(): string {
  return mkdtempSync(join(tmpdir(), 'om-store-'))
}

/**
 * Publish a ledger store on a test context.
 *
 * Mirrors what the plugin's own `apply` does, so a module that reads
 * `ctx.observationalMemoryStore` works the same way under test as it does when
 * mounted.
 * @param ctx - the test context to publish on.
 * @param storageDir - the directory this test's ledgers live in.
 * @returns the published store, for seeding.
 */
export function publishStore(ctx: Context, storageDir: string = tempStoreDir()): MemoryStore {
  const store = new MemoryStore({ storageDir, warn: () => {} })
  ctx.reflect.provide('observationalMemoryStore', store)
  return store
}
