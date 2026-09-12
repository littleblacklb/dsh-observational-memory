/**
 * Direct unit coverage of the observational-memory fold.
 *
 * The fold is a pure function, so these tests exercise its branches — including
 * the idempotence guards and the client wire view — without standing up a
 * session, which keeps the integration test focused on durability.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { memoryId } from '../src/events.ts'
import type { Observation, Reflection } from '../src/events.ts'
import { applyMemoryEvent, observationalMemoryProjectionDefinition } from '../src/projection.ts'
import type { ObservationalMemoryState } from '../src/vocabulary.ts'
import { observationalMemoryStateSchema } from '../src/vocabulary.ts'

function observation(content: string): Observation {
  return {
    id: memoryId(content),
    content,
    timestamp: '2026-01-15 14:30',
    relevance: 'medium',
    sourceSeqs: [SessionSeq(0)],
  }
}

function empty(): ObservationalMemoryState {
  return observationalMemoryProjectionDefinition.init()
}

describe('memory fold', () => {
  it('starts empty', () => {
    expect(empty()).toEqual({
      observations: [],
      dropped: [],
      reflections: [],
      coverage: { observer: null, reflector: null, dropper: null },
    })
  })

  it('leaves an unrelated event as the same state reference', () => {
    const state = empty()
    expect(applyMemoryEvent(state, { type: 'turn/end' })).toBe(state)
  })

  it('records reflections and advances the reflector watermark', () => {
    const record: Reflection = { id: memoryId('fact'), content: 'fact', supportingObservationIds: ['aaaa11112222'] }
    const next = applyMemoryEvent(empty(), {
      type: 'memory/reflections-recorded',
      data: { reflections: [record], coversUpToSeq: SessionSeq(7) },
    })
    expect(next.reflections).toEqual([record])
    expect(next.coverage.reflector).toBe(7)
  })

  it('collapses duplicate reflections within one pass', () => {
    const record: Reflection = { id: memoryId('fact'), content: 'fact', supportingObservationIds: ['aaaa11112222'] }
    const next = applyMemoryEvent(empty(), {
      type: 'memory/reflections-recorded',
      data: { reflections: [record, record], coversUpToSeq: SessionSeq(1) },
    })
    expect(next.reflections).toHaveLength(1)
  })

  it('is idempotent for a reflection event whose watermark it already applied', () => {
    const state = applyMemoryEvent(empty(), {
      type: 'memory/reflections-recorded',
      data: { reflections: [{ id: memoryId('fact'), content: 'fact', supportingObservationIds: ['aaaa11112222'] }], coversUpToSeq: SessionSeq(3) },
    })
    expect(applyMemoryEvent(state, {
      type: 'memory/reflections-recorded',
      data: { reflections: [], coversUpToSeq: SessionSeq(3) },
    })).toBe(state)
  })

  it('splits active observations from tombstones and advances the dropper watermark', () => {
    const kept = observation('kept')
    const removed = observation('removed')
    const recorded = applyMemoryEvent(empty(), {
      type: 'memory/observations-recorded',
      data: { observations: [kept, removed], coversUpToSeq: SessionSeq(0) },
    })
    const next = applyMemoryEvent(recorded, {
      type: 'memory/observations-dropped',
      data: { observationIds: [removed.id, 'ffffffffffff'], coversUpToSeq: SessionSeq(2) },
    })
    expect(next.observations).toEqual([kept])
    expect(next.dropped).toEqual([removed])
    expect(next.coverage.dropper).toBe(2)
  })

  it('is idempotent for a drop event whose watermark it already applied', () => {
    const state = applyMemoryEvent(empty(), {
      type: 'memory/observations-dropped',
      data: { observationIds: [], coversUpToSeq: SessionSeq(4) },
    })
    expect(applyMemoryEvent(state, {
      type: 'memory/observations-dropped',
      data: { observationIds: ['aaaa11112222'], coversUpToSeq: SessionSeq(4) },
    })).toBe(state)
  })
})

describe('memory projection registration', () => {
  it('exposes a wire view that is the folded state itself', () => {
    const state = empty()
    expect(observationalMemoryProjectionDefinition.wire.view(state)).toBe(state)
    expect(observationalMemoryProjectionDefinition.wire.viewSchema.parse(state)).toEqual(state)
    expect(observationalMemoryProjectionDefinition.stateSchema.parse(state)).toEqual(state)
  })

  it('declares a key, a version, and a pure apply', () => {
    expect(observationalMemoryProjectionDefinition.key).toBe('observationalMemory')
    expect(observationalMemoryProjectionDefinition.stateVersion).toBe(1)
    expect(observationalMemoryProjectionDefinition.apply).toBe(applyMemoryEvent)
  })

  it('rejects a state that does not match the schema', () => {
    expect(() => observationalMemoryStateSchema.parse({ observations: 'nope' })).toThrow()
  })
})
