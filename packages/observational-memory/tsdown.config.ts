import { defineConfig } from 'tsdown'

/**
 * Bundle the package's two loader entries from the JavaScript `tsc` emitted.
 *
 * The package is host-only: one entry mounts the ledger and its workers, the
 * other mounts the compaction engine the bundle patch swaps in. Both are
 * consumed by the profile loader as plain ESM modules, so they are bundled to
 * `lib/` with no client face and no module-table artifact.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/startup.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
