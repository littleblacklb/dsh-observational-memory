/**
 * The memory data model: record identity, timestamp shape, and the vocabulary
 * this package publishes to its consumers.
 *
 * Ids are content-addressed, so a record's id is a function of its text:
 * identical text collapses to one record, which makes replay and concurrent
 * passes idempotent. Consumers must treat a repeated id as the same record
 * rather than a new one.
 *
 * A companion package (`@deepseek-ai/dsh-tool-observational-memory`) imports the
 * vocabulary from the package root rather than reaching into a source subpath,
 * which is why the re-exports below are part of the public surface.
 *
 * @module @deepseek-ai/dsh-observational-memory/model
 */

import { createHash } from 'node:crypto'
import { MEMORY_ID_LENGTH } from './vocabulary.ts'

export {
  coverageOf,
  MEMORY_ID_LENGTH,
  MEMORY_ID_PATTERN,
  OBSERVATION_TIMESTAMP_PATTERN,
  RELEVANCE_ORDER,
} from './vocabulary.ts'
export type { CoverageTier, Observation, Reflection, Relevance } from './vocabulary.ts'

/**
 * Derive the content-addressed id for one memory record.
 *
 * Identical content therefore yields an identical id, which makes replay and
 * concurrent passes idempotent; callers must treat a repeated id as the same
 * record rather than a new one.
 * @param content - the record's single-line prose.
 * @returns the 12-character lowercase hex id.
 */
export function memoryId(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, MEMORY_ID_LENGTH)
}

/**
 * Format one log timestamp as the `YYYY-MM-DD HH:MM` observation stamp.
 * @param epochMs - milliseconds since the Unix epoch.
 * @returns the UTC timestamp string in the recorded shape.
 */
export function formatObservationTimestamp(epochMs: number): string {
  const iso = new Date(epochMs).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}
