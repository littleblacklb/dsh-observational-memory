/**
 * Behavior of the active-observation pool metric, drop-candidate ordering, and
 * the deterministic memory renderer.
 *
 * The pool tests pin the asymmetry the design depends on: only observations are
 * priced, and observations are always active, because the pool metric decides
 * when compaction and dropping trigger.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { memoryId } from '../src/events.ts'
import type { Observation, Reflection } from '../src/events.ts'
import { dropCandidates, observationLineTokens, poolMetrics } from '../src/pool.ts'
import { observationLine, reflectionLine, renderMemory, MEMORY_USAGE_INSTRUCTIONS } from '../src/render.ts'

function observation(
  content: string,
  overrides: Partial<Observation> = {},
): Observation {
  return {
    id: memoryId(content),
    content,
    timestamp: '2026-01-15 14:30',
    relevance: 'medium',
    sourceSeqs: [SessionSeq(1)],
    ...overrides,
  }
}

function reflection(content: string, support: string[]): Reflection {
  return { id: memoryId(content), content, supportingObservationIds: support }
}

describe('pool metrics', () => {
  it('reports under-target pools as permitting no drops', () => {
    const metrics = poolMetrics([observation('small fact')], 10_000)
    expect(metrics.overTarget).toBe(false)
    expect(metrics.maxDrops).toBe(0)
    expect(metrics.activeTokens).toBeGreaterThan(0)
  })

  it('prices the rendered line, not the raw content', () => {
    const record = observation('fact')
    expect(observationLineTokens(record)).toBe(Math.ceil(observationLine(record).length / 4) + 4)
  })

  it('converts the token excess into a drop bound once over target', () => {
    const records = Array.from({ length: 5 }, (_value, index) => observation(`fact number ${index}`))
    const perLine = observationLineTokens(records[0]!)
    const target = perLine * 3
    const metrics = poolMetrics(records, target)
    expect(metrics.overTarget).toBe(true)
    expect(metrics.activeTokens).toBe(perLine * 5)
    // Two lines' worth of excess, so the bound is at least two.
    expect(metrics.maxDrops).toBeGreaterThanOrEqual(2)
    expect(metrics.maxDrops).toBeLessThanOrEqual(records.length)
  })

  it('bounds drops by whole observations rather than overshooting the target', () => {
    const records = Array.from({ length: 4 }, (_value, index) => observation(`fact number ${index}`))
    const perLine = observationLineTokens(records[0]!)
    // One token over target: removing any single line clears it.
    const metrics = poolMetrics(records, perLine * 4 - 1)
    expect(metrics.maxDrops).toBe(1)
  })
})

describe('drop candidates', () => {
  it('orders by coverage, then relevance, then age', () => {
    const uncovered = observation('uncovered critical', { relevance: 'critical', timestamp: '2026-01-15 10:00' })
    const partial = observation('partial low', { relevance: 'low', timestamp: '2026-01-15 11:00' })
    const strongNewer = observation('strong newer', { relevance: 'high', timestamp: '2026-01-16 12:00' })
    const strongOlder = observation('strong older', { relevance: 'low', timestamp: '2026-01-14 09:00' })
    const reflections = [
      reflection('a', [partial.id, strongNewer.id, strongOlder.id]),
      reflection('b', [strongNewer.id, strongOlder.id]),
    ]
    const ordered = dropCandidates([uncovered, partial, strongNewer, strongOlder], reflections)
      .map(candidate => candidate.observation.content)
    // Strong coverage leaves first, oldest within the tier, then partial, then none
    // however critical the uncovered observation is.
    expect(ordered).toEqual(['strong older', 'strong newer', 'partial low', 'uncovered critical'])
  })

  it('reports the coverage tier alongside each candidate', () => {
    const only = observation('only')
    const candidates = dropCandidates([only], [reflection('a', [only.id])])
    expect(candidates).toEqual([{ observation: only, coverage: 'partial' }])
  })

  it('falls back to pool order when coverage, relevance, and age all tie', () => {
    const first = observation('identical', { timestamp: '2026-01-15 14:30' })
    const second = observation('identical', { timestamp: '2026-01-15 14:30' })
    const ordered = dropCandidates([first, second], [])
    expect(ordered.map(candidate => candidate.observation.id)).toEqual([first.id, second.id])
  })
})

describe('memory rendering', () => {
  it('renders nothing when there is no memory to carry', () => {
    expect(renderMemory([], [])).toBe('')
  })

  it('renders both sections with the usage instructions first', () => {
    const text = renderMemory([reflection('The API is GraphQL.', ['aaaa11112222'])], [observation('Switched to GraphQL.')])
    expect(text.startsWith(MEMORY_USAGE_INSTRUCTIONS)).toBe(true)
    expect(text).toContain('## Reflections')
    expect(text).toContain(`[${memoryId('The API is GraphQL.')}] The API is GraphQL.`)
    expect(text).toContain('## Observations')
    expect(text).toContain('[medium] Switched to GraphQL.')
  })

  it('omits a section that has no records', () => {
    const onlyObservations = renderMemory([], [observation('fact')])
    expect(onlyObservations).not.toContain('## Reflections')
    const onlyReflections = renderMemory([reflection('fact', ['aaaa11112222'])], [])
    expect(onlyReflections).not.toContain('## Observations')
  })

  it('renders records verbatim, without paraphrase', () => {
    const record = observation('Exact wording: "ship by January 22nd".')
    expect(renderMemory([], [record])).toContain(record.content)
    expect(observationLine(record)).toBe(`[${record.id}] 2026-01-15 14:30 [medium] ${record.content}`)
    expect(reflectionLine(reflection('Durable fact.', ['aaaa11112222']))).toBe(`[${memoryId('Durable fact.')}] Durable fact.`)
  })
})
