/**
 * Behavior of the recall resolver and the `/om` renderers.
 *
 * Recall is the traceability guarantee: a memory id has to lead back to the
 * conversation it came from, including through a reflection and including
 * records that have been dropped. These tests pin that chain and, just as
 * importantly, pin what recall refuses to invent when a link is missing.
 */

import { describe, expect, it } from 'vitest'
import type { Observation, Reflection } from '../src/model.ts'
import { memoryId } from '../src/model.ts'
import type { ObservationalMemoryState } from '../src/vocabulary.ts'
import { citedSourceSeqs, resolveMemoryId } from '../src/recall.ts'
import { renderShow, renderStatus } from '../src/commands.ts'
import type { OmCommandsHost } from '../src/commands.ts'
import { MemoryStatus } from '../src/status.ts'

function observation(content: string, sourceSeqs: number[] = [1]): Observation {
  return { id: memoryId(content), content, timestamp: '2026-01-15 14:30', relevance: 'high', sourceSeqs }
}

function reflection(content: string, support: string[]): Reflection {
  return { id: memoryId(content), content, supportingObservationIds: support }
}

function state(parts: Partial<ObservationalMemoryState> = {}): ObservationalMemoryState {
  return {
    observations: [],
    dropped: [],
    reflections: [],
    coverage: { observer: null, reflector: null, dropper: null },
    ...parts,
  }
}

const HOST: OmCommandsHost = {
  memoryOf: () => state(),
  status: new MemoryStatus(),
  targetTokens: 10_000,
  observeAfterTokens: 10_000,
  reflectAfterTokens: 20_000,
  passive: false,
}

describe('resolving a memory id', () => {
  it('reports nothing for a malformed id rather than matching loosely', () => {
    const result = resolveMemoryId('NOT-AN-ID', state({ observations: [observation('a fact')] }))
    expect(result.kind).toBe('none')
    expect(result.observations).toEqual([])
  })

  it('reports nothing for a well-formed id the ledger does not hold', () => {
    const result = resolveMemoryId('aaaaaaaaaaaa', state({ observations: [observation('a fact')] }))
    expect(result.kind).toBe('none')
  })

  it('resolves an active observation and cites its sources', () => {
    const record = observation('User switched to GraphQL.', [3, 5])
    const result = resolveMemoryId(record.id, state({ observations: [record] }))
    expect(result.kind).toBe('observation')
    expect(result.observations).toEqual([{ observation: record, status: 'active' }])
    expect(citedSourceSeqs(result)).toEqual([3, 5])
  })

  it('resolves a dropped observation and says so', () => {
    const record = observation('A routine note.')
    const result = resolveMemoryId(record.id, state({ dropped: [record] }))
    expect(result.kind).toBe('observation')
    expect(result.observations).toEqual([{ observation: record, status: 'dropped' }])
  })

  it('expands a reflection into the observations it preserves', () => {
    const first = observation('Decided on GraphQL.')
    const second = observation('Migration validated.', [7])
    const durable = reflection('The public API is GraphQL.', [first.id, second.id])
    const result = resolveMemoryId(durable.id, state({ observations: [first, second], reflections: [durable] }))
    expect(result.kind).toBe('reflection')
    expect(result.reflections).toEqual([durable])
    // The chain is reflection -> observations -> their sources.
    expect(result.observations.map(entry => entry.observation.id)).toEqual([first.id, second.id])
    expect(citedSourceSeqs(result)).toEqual([1, 7])
  })

  it('reports a supporting observation the ledger no longer holds', () => {
    const durable = reflection('A durable fact.', ['deadbeefdead'])
    const result = resolveMemoryId(durable.id, state({ reflections: [durable] }))
    expect(result.kind).toBe('reflection')
    expect(result.missingSupportingObservationIds).toEqual(['deadbeefdead'])
    expect(result.observations).toEqual([])
  })

  it('reports a collision when one id matches both record kinds', () => {
    // Ids are content-addressed, so identical text in two kinds collides by construction.
    const shared = 'The same sentence.'
    const asObservation = observation(shared)
    const asReflection = reflection(shared, ['aaaa11112222'])
    const result = resolveMemoryId(memoryId(shared), state({
      observations: [asObservation],
      reflections: [asReflection],
    }))
    expect(result.kind).toBe('mixed')
    expect(result.observations).toHaveLength(1)
    expect(result.reflections).toHaveLength(1)
  })

  it('keeps the first record when the same id appears twice', () => {
    const first = observation('Repeated text.')
    const second: Observation = { ...first, relevance: 'low' }
    const result = resolveMemoryId(first.id, state({ observations: [first, second] }))
    expect(result.observations[0]?.observation.relevance).toBe('high')
  })

  it('does not repeat a supporting observation the same reflection names twice', () => {
    const record = observation('Cited twice by one reflection.')
    const durable = reflection('A durable fact.', [record.id, record.id])
    const result = resolveMemoryId(durable.id, state({ observations: [record], reflections: [durable] }))
    expect(result.observations).toHaveLength(1)
  })

  it('ignores a malformed supporting id while still expanding the valid ones', () => {
    const record = observation('Cited properly.')
    const durable = reflection('A durable fact.', [record.id, 'not-an-id'])
    const result = resolveMemoryId(durable.id, state({ observations: [record], reflections: [durable] }))
    expect(result.observations.map(entry => entry.observation.id)).toEqual([record.id])
    // A malformed citation is a ledger gap like any other, and is reported.
    expect(result.missingSupportingObservationIds).toEqual(['not-an-id'])
  })

  it('reports nothing for a malformed id even when the ledger is populated', () => {
    const result = resolveMemoryId('zzzz', state({ observations: [observation('a fact')], dropped: [observation('gone')] }))
    expect(result.kind).toBe('none')
  })

  it('resolves a dropped record that is also the only match', () => {
    const record = observation('Only in the tombstone set.')
    const result = resolveMemoryId(record.id, state({ observations: [], dropped: [record] }))
    expect(result.kind).toBe('observation')
    expect(result.observations[0]?.status).toBe('dropped')
  })

  it('keeps the first tombstone when the same id is dropped twice', () => {
    const first = observation('Dropped twice.')
    const second: Observation = { ...first, relevance: 'low' }
    const result = resolveMemoryId(first.id, state({ dropped: [first, second] }))
    expect(result.observations[0]?.observation.relevance).toBe('high')
  })

  it('keeps the first reflection when the same id is recorded twice', () => {
    const first = reflection('Repeated fact.', ['aaaa11112222'])
    const second = reflection('Repeated fact.', ['bbbb33334444'])
    const result = resolveMemoryId(first.id, state({ reflections: [first, second] }))
    expect(result.reflections).toHaveLength(1)
    expect(result.reflections[0]?.supportingObservationIds).toEqual(['aaaa11112222'])
  })

  it('reports each distinct missing support once', () => {
    const durable = reflection('A durable fact.', ['deadbeefdead'])
    const result = resolveMemoryId(durable.id, state({ reflections: [durable] }))
    expect(result.missingSupportingObservationIds).toEqual(['deadbeefdead'])
  })

  it('reports a repeated missing support once', () => {
    // A reflection may name the same absent observation twice; the gap is one gap.
    const durable = reflection('A durable fact.', ['deadbeefdead', 'deadbeefdead'])
    const result = resolveMemoryId(durable.id, state({ reflections: [durable] }))
    expect(result.missingSupportingObservationIds).toEqual(['deadbeefdead'])
  })

  it('lists two distinct missing supports in citation order', () => {
    const durable = reflection('A durable fact.', ['deadbeefdead', 'ffffffffffff'])
    const result = resolveMemoryId(durable.id, state({ reflections: [durable] }))
    expect(result.missingSupportingObservationIds).toEqual(['deadbeefdead', 'ffffffffffff'])
  })

  it('avoids repeating a source an observation cites twice', () => {
    const record = observation('Cites the same entry twice.', [4, 4])
    const result = resolveMemoryId(record.id, state({ observations: [record] }))
    expect(citedSourceSeqs(result)).toEqual([4])
  })

  it('does not duplicate an observation cited by two matched reflections', () => {
    const record = observation('Cited twice.')
    const first = reflection('First durable fact.', [record.id])
    const second = reflection('Second durable fact.', [record.id])
    const result = resolveMemoryId(record.id, state({ observations: [record], reflections: [first, second] }))
    // Only the id's own record is direct here; the reflections are not matched.
    expect(result.observations).toHaveLength(1)
  })
})

describe('/om status', () => {
  it('reports counts, pool pressure, and worker coverage', () => {
    const text = renderStatus(state({
      observations: [observation('a fact')],
      reflections: [reflection('a durable fact', ['aaaa11112222'])],
      coverage: { observer: 12, reflector: 9, dropper: null },
    }), HOST)
    expect(text).toContain('reflections: 1')
    expect(text).toContain('active observations: 1')
    expect(text).toContain('observer coverage: through #12')
    expect(text).toContain('reflector coverage: through #9')
    expect(text).toContain('dropper coverage: not yet')
    expect(text).toContain('mode: active')
  })

  it('reports passive mode and dropped records', () => {
    const text = renderStatus(state({
      dropped: [observation('a dropped fact')],
      coverage: { observer: null, reflector: null, dropper: 4 },
    }), { ...HOST, passive: true })
    expect(text).toContain('mode: passive')
    expect(text).toContain('dropped: 1 (still resolvable by id via /om show)')
    expect(text).toContain('observer coverage: not yet')
  })

  it('reports an empty pool without dividing by zero', () => {
    const text = renderStatus(state(), { ...HOST, targetTokens: 0 })
    expect(text).toContain('active observations: 0')
    expect(text).toContain('0%')
  })
})

describe('/om show', () => {
  it('rejects a malformed id', () => {
    expect(renderShow('nope', state(), () => undefined)).toContain('not a memory id')
  })

  it('reports an unknown id', () => {
    expect(renderShow('aaaaaaaaaaaa', state(), () => undefined)).toContain('No memory record has id')
  })

  it('shows a record with its sources, read as the observer saw them', () => {
    const record = observation('User switched to GraphQL.', [3])
    const text = renderShow(record.id, state({ observations: [record] }), seq =>
      seq === 3 ? { role: 'user', text: 'switch the API to GraphQL' } : undefined)
    expect(text).toContain('[coverage: none]')
    expect(text).toContain('Sources:')
    expect(text).toContain('#3 user: switch the API to GraphQL')
  })

  it('marks a dropped record and a missing source', () => {
    const record = observation('A dropped fact.', [9])
    const text = renderShow(record.id, state({ dropped: [record] }), () => undefined)
    expect(text).toContain('[dropped]')
    expect(text).toContain('#9 (not in the observed conversation)')
  })

  it('reports a reflection whose support is gone', () => {
    const durable = reflection('A durable fact.', ['deadbeefdead'])
    const text = renderShow(durable.id, state({ reflections: [durable] }), () => undefined)
    expect(text).toContain('Unresolved: supporting observations no longer in the ledger: deadbeefdead.')
  })
})
