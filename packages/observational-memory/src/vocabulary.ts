import { z as zod } from 'zod'

/**
 * The memory vocabulary both faces share: record shapes, id and timestamp
 * shapes, relevance tiers, and the coverage rule.
 *
 * This module exists as its own unit because the browser half needs exactly these
 * and must not reach the host logging vocabulary, whose id minting imports
 * `node:crypto`. Nothing here touches Node or the session log.
 *
 * @module @deepseek-ai/dsh-observational-memory/vocabulary
 */

/** How strongly an observation resists being dropped from active memory. */
export type Relevance = 'low' | 'medium' | 'high' | 'critical'

/** Relevance tiers in ascending resistance order, for deterministic tie-breaks. */
export const RELEVANCE_ORDER: readonly Relevance[] = ['low', 'medium', 'high', 'critical']

/** Length of a content-addressed memory id in hex characters. */
export const MEMORY_ID_LENGTH = 12

/** Matches one content-addressed memory id. */
export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/

/** `YYYY-MM-DD HH:MM` in UTC, the shape observation timestamps are recorded in. */
export const OBSERVATION_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

/**
 * One timestamped event recorded from the conversation.
 *
 * `sourceSeqs` is provenance, not a watermark: it names the exact source
 * entries this observation was drawn from, and is what makes recall able to
 * return evidence for a memory id.
 */
export interface Observation {
  /** Content-addressed id derived from the record's content. */
  readonly id: string
  /** Single-line plain prose, never markdown or JSON. */
  readonly content: string
  /** `YYYY-MM-DD HH:MM` observation time. */
  readonly timestamp: string
  /** How strongly this observation resists dropping. */
  readonly relevance: Relevance
  /**
   * Source entries that support this observation, in chunk order.
   *
   * Plain seq numbers, not branded ones: a record round-trips through the
   * session log as JSON, where a brand cannot survive, so the stored shape is
   * the un-branded number and callers narrow at the point of use.
   */
  readonly sourceSeqs: number[]
}

/**
 * One durable orientation fact distilled from active observations.
 *
 * `supportingObservationIds` is coverage evidence for the dropper: it should
 * name all and only the observations whose durable meaning this reflection
 * preserves, because an inflated set makes later pruning look safer than it is.
 */
export interface Reflection {
  /** Content-addressed id derived from the record's content. */
  readonly id: string
  /** Single-line plain prose, never markdown or JSON. */
  readonly content: string
  /** Active observations whose meaning this reflection preserves. */
  readonly supportingObservationIds: string[]
}

/** How much of an observation's durable meaning current reflections preserve. */
export type CoverageTier = 'none' | 'partial' | 'strong'

/**
 * Derive an observation's reflection coverage from the reflections citing it.
 *
 * Coverage is review context for the reflector and dropper, never an automatic
 * drop rule: it is computed at read time and never persisted.
 * @param observationId - the observation to classify.
 * @param reflections - the current active reflections.
 * @returns `none` for no citations, `partial` for exactly one, `strong` for two or more.
 */
export function coverageOf(
  observationId: string,
  reflections: readonly Reflection[],
): CoverageTier {
  let count = 0
  for (const reflection of reflections) {
    if (reflection.supportingObservationIds.includes(observationId)) count += 1
    if (count >= 2) return 'strong'
  }
  return count === 1 ? 'partial' : 'none'
}

/** Wire and fold schema of {@link ObservationalMemoryState}. */
export const observationalMemoryStateSchema = zod.object({
  /** Active observations, in the order their passes recorded them. */
  observations: zod.array(zod.object({
    id: zod.string(),
    content: zod.string(),
    timestamp: zod.string(),
    relevance: zod.enum(['low', 'medium', 'high', 'critical']),
    sourceSeqs: zod.array(zod.number().int().nonnegative()),
  })),
  /** Tombstoned observations, retained so recall and the browser explorer still resolve them. */
  dropped: zod.array(zod.object({
    id: zod.string(),
    content: zod.string(),
    timestamp: zod.string(),
    relevance: zod.enum(['low', 'medium', 'high', 'critical']),
    sourceSeqs: zod.array(zod.number().int().nonnegative()),
  })),
  /** Active reflections. */
  reflections: zod.array(zod.object({
    id: zod.string(),
    content: zod.string(),
    supportingObservationIds: zod.array(zod.string()),
  })),
  /** Per-worker progress watermarks, the seq each worker's coverage reached. */
  coverage: zod.object({
    observer: zod.number().int().nullable(),
    reflector: zod.number().int().nullable(),
    dropper: zod.number().int().nullable(),
  }),
})

/**
 * Folded observational memory for one session.
 *
 * Declared here rather than beside the fold so the browser half can depend on
 * the shape without importing the host projection module.
 */
export type ObservationalMemoryState = zod.infer<typeof observationalMemoryStateSchema>
