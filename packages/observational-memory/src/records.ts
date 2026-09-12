/**
 * Builders and validators for memory records.
 *
 * Everything a worker model returns crosses a model-JSON boundary here, so
 * this module is where untrusted output becomes a valid record: ids and
 * timestamps are computed in code rather than taken from the model, and every
 * cited source or support id is checked against an allowlist. A record whose
 * citations do not survive validation is rejected whole, because a partially
 * trusted citation set would corrupt provenance for recall and the dropper.
 *
 * @module @deepseek-ai/dsh-observational-memory/records
 */

import {
  OBSERVATION_TIMESTAMP_PATTERN,
  RELEVANCE_ORDER,
} from './vocabulary.ts'
import { formatObservationTimestamp, memoryId } from './events.ts'
import type { Observation, Reflection, Relevance } from './vocabulary.ts'

/** Longest single-line content accepted from a worker, matching the record cap. */
export const MAX_RECORD_CONTENT_CHARS = 10_000

/** Why one candidate record was rejected. */
export interface Rejection {
  /** Which record kind was rejected. */
  readonly kind: 'observation' | 'reflection'
  /** Human-readable reason, safe to log and to feed back to the model. */
  readonly reason: string
}

/** Normalize content exactly as the reference does: trim, collapse to one line, cap length. */
function normalizeContent(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const collapsed = raw.replace(/\s*\r?\n\s*/g, ' ').trim()
  if (collapsed.length === 0) return undefined
  if (collapsed.length <= MAX_RECORD_CONTENT_CHARS) return collapsed
  const truncated = collapsed.slice(0, MAX_RECORD_CONTENT_CHARS)
  return `${truncated} … [truncated ${collapsed.length - MAX_RECORD_CONTENT_CHARS} chars]`
}

/**
 * Check that a recorded timestamp is well-formed.
 *
 * A malformed stamp is replaced rather than rejected: the observation's meaning
 * does not depend on the stamp, and the pass already knows the wall clock.
 * @param raw - the model-supplied timestamp.
 * @param fallbackEpochMs - observation time to use when the stamp is unusable.
 * @returns a `YYYY-MM-DD HH:MM` stamp.
 */
export function resolveTimestamp(raw: unknown, fallbackEpochMs: number): string {
  if (typeof raw === 'string' && OBSERVATION_TIMESTAMP_PATTERN.test(raw)) return raw
  return formatObservationTimestamp(fallbackEpochMs)
}

/** Normalize a relevance tier, defaulting to `medium` for an unrecognized value. */
function resolveRelevance(raw: unknown): Relevance {
  return RELEVANCE_ORDER.includes(raw as Relevance) ? raw as Relevance : 'medium'
}

/**
 * Normalize a model-supplied source-id list against the chunk that was sent.
 *
 * Returns `undefined` when any cited id is outside the allowlist: the observer
 * is instructed never to invent ids, so an out-of-range citation is a
 * contract violation rather than something to silently repair.
 * @param raw - the model-supplied ids.
 * @param allowed - seqs present in the observer's chunk, in chunk order.
 * @returns the allowed ids in chunk order, or `undefined` when any id is foreign.
 */
export function normalizeSourceSeqs(
  raw: unknown,
  allowed: readonly number[],
): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const permitted = new Set<number>(allowed)
  const cited = new Set<number>()
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
    if (!permitted.has(value)) return undefined
    cited.add(value)
  }
  // Chunk order, not model order, keeps provenance deterministic across replays.
  return allowed.filter(seq => cited.has(seq))
}

/** One observation candidate as it arrives from the model, before validation. */
export interface ObservationCandidate {
  readonly content?: unknown
  readonly timestamp?: unknown
  readonly relevance?: unknown
  readonly sourceSeqs?: unknown
}

/**
 * Validate and build one observation.
 * @param candidate - the raw model-supplied record.
 * @param allowed - source seqs present in the observer's chunk.
 * @param fallbackEpochMs - observation time used when the stamp is unusable.
 * @returns the record, or the reason it was rejected.
 */
export function buildObservation(
  candidate: ObservationCandidate,
  allowed: readonly number[],
  fallbackEpochMs: number,
): { observation: Observation } | { rejection: Rejection } {
  const content = normalizeContent(candidate.content)
  if (content === undefined) {
    return { rejection: { kind: 'observation', reason: 'content was empty after normalization' } }
  }
  const sourceSeqs = normalizeSourceSeqs(candidate.sourceSeqs, allowed)
  if (sourceSeqs === undefined) {
    return {
      rejection: {
        kind: 'observation',
        reason: 'sourceSeqs were missing, empty, or named an entry outside the chunk',
      },
    }
  }
  return {
    observation: {
      id: memoryId(content),
      content,
      timestamp: resolveTimestamp(candidate.timestamp, fallbackEpochMs),
      relevance: resolveRelevance(candidate.relevance),
      sourceSeqs,
    },
  }
}

/** One reflection candidate as it arrives from the model, before validation. */
export interface ReflectionCandidate {
  readonly content?: unknown
  readonly supportingObservationIds?: unknown
}

/**
 * Validate and build one reflection.
 * @param candidate - the raw model-supplied record.
 * @param activeObservationIds - ids of every active observation, the allowlist.
 * @returns the record, or the reason it was rejected.
 */
export function buildReflection(
  candidate: ReflectionCandidate,
  activeObservationIds: readonly string[],
): { reflection: Reflection } | { rejection: Rejection } {
  const content = normalizeContent(candidate.content)
  if (content === undefined) {
    return { rejection: { kind: 'reflection', reason: 'content was empty after normalization' } }
  }
  const raw = candidate.supportingObservationIds
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      rejection: {
        kind: 'reflection',
        reason: 'supportingObservationIds were missing or empty; every reflection must cite evidence',
      },
    }
  }
  const permitted = new Set(activeObservationIds)
  const support: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string' || !permitted.has(value)) {
      return {
        rejection: {
          kind: 'reflection',
          reason: 'supportingObservationIds named an observation that is not active',
        },
      }
    }
    if (seen.has(value)) continue
    seen.add(value)
    support.push(value)
  }
  return { reflection: { id: memoryId(content), content, supportingObservationIds: support } }
}

/**
 * Normalize a model-supplied drop list against the active observation ids.
 *
 * Unknown ids are dropped rather than failing the pass: a dropper that names a
 * stale id has still expressed a usable intent about the ids that do exist.
 * @param raw - the model-supplied ids.
 * @param activeObservationIds - ids eligible for dropping.
 * @returns the acceptable ids, in model order, deduplicated.
 */
export function normalizeDropIds(
  raw: unknown,
  activeObservationIds: readonly string[],
): string[] {
  if (!Array.isArray(raw)) return []
  const permitted = new Set(activeObservationIds)
  const seen = new Set<string>()
  const kept: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !permitted.has(value) || seen.has(value)) continue
    seen.add(value)
    kept.push(value)
  }
  return kept
}
