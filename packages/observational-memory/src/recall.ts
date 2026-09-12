/**
 * Resolving a memory id back to the conversation it came from.
 *
 * Recall exists because memory is compressed: an observation states what
 * happened, and the exact wording, numbers, or error strings behind it live in
 * the source entries it cites. Given one id, this module walks the provenance
 * chain — a reflection to the observations it preserves, an observation to its
 * source entries — and reports what could not be resolved rather than filling
 * gaps with inference.
 *
 * @module @deepseek-ai/dsh-observational-memory/recall
 */

import { MEMORY_ID_PATTERN } from './vocabulary.ts'
import type { Observation, Reflection } from './vocabulary.ts'
import type { ObservationalMemoryState } from './vocabulary.ts'

/** One memory record as the ledger holds it, with where it currently stands. */
export interface RecalledObservation {
  readonly observation: Observation
  /** `dropped` records left active memory but stay resolvable from history. */
  readonly status: 'active' | 'dropped'
}

/** The resolved evidence for one id. */
export interface RecallResult {
  readonly id: string
  /** Directly matched observations, including tombstoned ones. */
  readonly observations: RecalledObservation[]
  /** Directly matched reflections. */
  readonly reflections: Reflection[]
  /**
   * Whether the id resolved to an observation, a reflection, or both. Both is
   * possible because ids are content-addressed: identical content in two record
   * kinds collides by construction.
   */
  readonly kind: 'observation' | 'reflection' | 'mixed' | 'none'
  /** Supporting observations named by a matched reflection that are not in the ledger. */
  readonly missingSupportingObservationIds: string[]
  /** Source seqs cited by matched observations that are absent from the session log. */
  readonly missingSourceSeqs: number[]
  /** Cited seqs that exist but are not conversation entries an observation may cite. */
  readonly nonSourceSeqs: number[]
}

/** One source entry resolved for display. */
export interface RecallEvidence {
  /** Log position of the entry. */
  readonly seq: number
  /** Role of the entry in the conversation. */
  readonly role: string
  /** The entry's text, as the observer read it. */
  readonly text: string
}

/** Index one folded memory state by record id. */
function index(state: ObservationalMemoryState): {
  observations: Map<string, RecalledObservation>
  reflections: Map<string, Reflection>
} {
  const observations = new Map<string, RecalledObservation>()
  // First record wins, matching the fold: replaying the same pass must not
  // change which copy recall reports.
  for (const observation of state.observations) {
    if (!observations.has(observation.id)) observations.set(observation.id, { observation, status: 'active' })
  }
  for (const observation of state.dropped) {
    if (!observations.has(observation.id)) observations.set(observation.id, { observation, status: 'dropped' })
  }
  const reflections = new Map<string, Reflection>()
  for (const reflection of state.reflections) {
    if (!reflections.has(reflection.id)) reflections.set(reflection.id, reflection)
  }
  return { observations, reflections }
}

/**
 * Resolve one memory id against the folded ledger.
 *
 * Only a well-formed id is looked up, so a malformed one reports `none` rather
 * than silently matching nothing. A matched reflection is expanded into the
 * supporting observations it names, and every observation named there is
 * reported missing when the ledger does not hold it: an unresolvable chain is
 * the honest answer, not a shortened one.
 * @param id - the memory id to resolve.
 * @param state - the folded memory state to resolve against.
 * @returns the matched records and the provenance gaps, if any.
 */
export function resolveMemoryId(
  id: string,
  state: ObservationalMemoryState,
): RecallResult {
  const empty: RecallResult = {
    id,
    observations: [],
    reflections: [],
    kind: 'none',
    missingSupportingObservationIds: [],
    missingSourceSeqs: [],
    nonSourceSeqs: [],
  }
  if (!MEMORY_ID_PATTERN.test(id)) return empty

  const { observations, reflections } = index(state)
  const matchedReflections = reflections.has(id) ? [reflections.get(id)!] : []
  const direct = observations.has(id) ? [observations.get(id)!] : []

  // A reflection's evidence is the observations it preserves, so recall
  // expands it into those records rather than reporting the reflection alone.
  const expanded: RecalledObservation[] = [...direct]
  const missingSupport: string[] = []
  for (const reflection of matchedReflections) {
    for (const supportingId of reflection.supportingObservationIds) {
      const record = observations.get(supportingId)
      if (record === undefined) {
        if (!missingSupport.includes(supportingId)) missingSupport.push(supportingId)
        continue
      }
      if (!expanded.some(candidate => candidate.observation.id === supportingId)) expanded.push(record)
    }
  }

  const kind = direct.length > 0 && matchedReflections.length > 0
    ? 'mixed'
    : direct.length > 0
      ? 'observation'
      : matchedReflections.length > 0 ? 'reflection' : 'none'

  return {
    id,
    observations: expanded,
    reflections: matchedReflections,
    kind,
    missingSupportingObservationIds: missingSupport,
    missingSourceSeqs: [],
    nonSourceSeqs: [],
  }
}

/**
 * Collect every source seq a recall result cites, in resolution order.
 * @param result - a resolved memory id.
 * @returns the cited seqs, deduplicated and ordered by first citation.
 */
export function citedSourceSeqs(result: RecallResult): number[] {
  const seen = new Set<number>()
  const ordered: number[] = []
  for (const record of result.observations) {
    for (const seq of record.observation.sourceSeqs) {
      if (seen.has(seq)) continue
      seen.add(seq)
      ordered.push(seq)
    }
  }
  return ordered
}
