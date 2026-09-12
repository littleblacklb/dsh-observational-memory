/**
 * The observational-memory projection: folds the three `memory/*` log events
 * into the memory state every consumer reads — the compaction renderer, the
 * `memory_recall` tool, the `/om` commands, and the browser strip.
 *
 * The fold is pure and synchronous, and returns the same state reference when
 * an event is unrelated, which is the registry's contract for skipping
 * downstream work.
 *
 * @module @deepseek-ai/dsh-observational-memory/projection
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { observationalMemoryStateSchema } from './vocabulary.ts'
import type { ObservationalMemoryState, Observation, Reflection } from './vocabulary.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Folded observational memory for one session. */
    observationalMemory: ObservationalMemoryState
  }
  interface SessionProjectionMap {
    /** Folded observational memory, exposed to the browser strip and explorer. */
    observationalMemory: ObservationalMemoryState
  }
}

/** The empty state a session starts from. */
function emptyState(): ObservationalMemoryState {
  return {
    observations: [],
    dropped: [],
    reflections: [],
    coverage: { observer: null, reflector: null, dropper: null },
  }
}

/** Deduplicate records by id, first occurrence winning so replay is stable. */
function dedupeById<T extends { readonly id: string }>(records: readonly T[]): T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const record of records) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    kept.push(record)
  }
  return kept
}

/**
 * Deduplicate observations by id while never resurrecting a tombstoned id.
 * @param records - candidate observations in append order.
 * @param dropped - tombstoned observations that must not rejoin active memory.
 * @returns the first occurrence of every id that is new and not tombstoned.
 */
function dedupeAgainst<T extends { readonly id: string }>(
  records: readonly T[],
  dropped: readonly T[],
): T[] {
  const tombstoned = new Set(dropped.map(record => record.id))
  return dedupeById(records).filter(record => !tombstoned.has(record.id))
}

/**
 * Fold one memory event into the running state.
 *
 * Records a pass introduces are appended in pass order. Duplicates are possible
 * because ids are content-addressed, so a repeat within one pass or across
 * passes collapses to its first occurrence.
 *
 * Drops are tombstones: a dropped id moves from `observations` to `dropped` and
 * is never erased, so recall can still resolve it.
 * @param state - the projection covering all prior events.
 * @param event - the event to apply.
 * @returns the next state, or the same reference when the event is unrelated.
 */
export function applyMemoryEvent(
  state: ObservationalMemoryState,
  event: { readonly type: string; readonly data?: unknown },
): ObservationalMemoryState {
  if (event.type === 'memory/observations-recorded') {
    const data = event.data as { observations: Observation[]; coversUpToSeq: SessionSeq }
    if (state.coverage.observer === data.coversUpToSeq) return state
    return {
      ...state,
      observations: dedupeAgainst([...state.observations, ...data.observations], state.dropped),
      coverage: { ...state.coverage, observer: data.coversUpToSeq },
    }
  }

  if (event.type === 'memory/reflections-recorded') {
    const data = event.data as { reflections: Reflection[]; coversUpToSeq: SessionSeq }
    if (state.coverage.reflector === data.coversUpToSeq) return state
    return {
      ...state,
      reflections: dedupeById([...state.reflections, ...data.reflections]),
      coverage: { ...state.coverage, reflector: data.coversUpToSeq },
    }
  }

  if (event.type === 'memory/observations-dropped') {
    const data = event.data as { observationIds: string[]; coversUpToSeq: SessionSeq }
    if (state.coverage.dropper === data.coversUpToSeq) return state
    const tombstoned = new Set(data.observationIds)
    return {
      ...state,
      observations: state.observations.filter(record => !tombstoned.has(record.id)),
      dropped: [...state.dropped, ...state.observations.filter(record => tombstoned.has(record.id))],
      coverage: { ...state.coverage, dropper: data.coversUpToSeq },
    }
  }

  return state
}

/**
 * The registry entry folding observational memory for every session.
 *
 * The folded state is already plain JSON, so the wire view is the state itself:
 * returning the same reference whenever the state reference is unchanged is
 * what lets the live drive suppress publication for internal-only changes.
 *
 * `stateVersion` must be bumped whenever serialized fields or fold semantics
 * change, because a persisted projection cell is reused across reloads.
 */
export const observationalMemoryProjectionDefinition = {
  key: 'observationalMemory' as const,
  stateVersion: 1,
  stateSchema: observationalMemoryStateSchema,
  init: emptyState,
  apply: applyMemoryEvent,
  wire: {
    viewSchema: observationalMemoryStateSchema,
    view: (state: ObservationalMemoryState): ObservationalMemoryState => state,
  },
}
