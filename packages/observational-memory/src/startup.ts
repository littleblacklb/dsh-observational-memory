/**
 * The compaction-engine row this bundle installs.
 *
 * Compaction is a singleton service, so this is not an additional provider:
 * the bundle's patch re-points the shipped `compaction-basic` row at this
 * module. Exporting the engine as its own artifact keeps that row a module the
 * Loader can import directly, exactly as a surface bundle's startup row does.
 *
 * @module @deepseek-ai/dsh-observational-memory/startup
 */

export { default } from './compaction-engine.ts'
export { MEMORY_MODEL, MEMORY_PROVIDER, readMemory, renderCheckpoint } from './compaction-engine.ts'
