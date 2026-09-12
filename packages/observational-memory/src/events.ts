/**
 * The observational-memory vocabulary: the memory record shapes written into
 * the session log, and the three `memory/*` event types that carry them.
 *
 * Memory state is reconstructed by folding these log-only events, so the
 * declarations here are the single home of the memory data model.
 *
 * @module @deepseek-ai/dsh-observational-memory/events
 */

import { createHash } from 'node:crypto'
import { MEMORY_ID_LENGTH } from './vocabulary.ts'
import type { Observation, Reflection } from './vocabulary.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One observer pass over newly appended source entries: the timestamped
     * observations extracted from them, plus the coverage watermark the pass
     * reached. Whole-value per pass — passes accumulate rather than replace.
     */
    'memory/observations-recorded': {
      observations: readonly Observation[]
      coversUpToSeq: SessionSeq
    }
    /**
     * One reflector pass: durable orientation facts distilled from the active
     * observations, each citing the observation ids whose meaning it preserves.
     */
    'memory/reflections-recorded': {
      reflections: readonly Reflection[]
      coversUpToSeq: SessionSeq
    }
    /**
     * Tombstones for observations that should leave active memory. Dropping
     * removes ids from the active projection but never deletes ledger history,
     * so a dropped observation stays resolvable by recall.
     */
    'memory/observations-dropped': {
      observationIds: readonly string[]
      coversUpToSeq: SessionSeq
    }
  }
}

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

