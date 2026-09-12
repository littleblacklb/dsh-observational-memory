import { defineConfig } from 'tsdown'

/**
 * Bundle the tool package's single loader entry from the JavaScript `tsc` emitted.
 *
 * The tool registers one name and one schema with the host tool registry, so it
 * ships one host-only ESM entry and no client face.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
