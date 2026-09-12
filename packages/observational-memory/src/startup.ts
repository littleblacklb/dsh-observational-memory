/**
 * The compaction-engine row this bundle installs.
 *
 * Compaction is a singleton service, so this is not an additional provider: the
 * bundle's patch disables the shipped `compaction-basic` row and inserts this
 * module under its own id. (A patch cannot re-point a row's module — `name` on an
 * id-targeted patch is a match assertion, not an assignment — and two providers
 * of one service fail the whole tree.) Exporting the engine as its own artifact
 * keeps that inserted row a module the Loader can import directly, exactly as a
 * surface bundle's startup row does.
 *
 * @module @deepseek-ai/dsh-observational-memory/startup
 */

export { default } from './compaction-engine.ts'
export { MEMORY_MODEL, MEMORY_PROVIDER, readMemory, renderCheckpoint } from './compaction-engine.ts'
