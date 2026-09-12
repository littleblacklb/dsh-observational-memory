/**
 * Behavior of the memory record builders and validators.
 *
 * These tests pin the provenance guarantees recall and the dropper depend on:
 * ids and timestamps are computed in code, and a record citing anything outside
 * its allowlist is rejected rather than partially trusted.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { coverageOf, formatObservationTimestamp, memoryId, MEMORY_ID_PATTERN } from '../src/events.ts'
import type { Observation, Reflection } from '../src/events.ts'
import {
  buildObservation,
  buildReflection,
  MAX_RECORD_CONTENT_CHARS,
  normalizeDropIds,
  normalizeSourceSeqs,
  resolveTimestamp,
} from '../src/records.ts'

const EPOCH = Date.parse('2026-01-15T14:30:00Z')
const ALLOWED = [SessionSeq(4), SessionSeq(5), SessionSeq(6)]

function observation(content: string): Observation {
  return { id: memoryId(content), content, timestamp: '2026-01-15 14:30', relevance: 'medium', sourceSeqs: [SessionSeq(4)] }
}

function reflection(content: string, support: string[]): Reflection {
  return { id: memoryId(content), content, supportingObservationIds: support }
}

describe('memory ids', () => {
  it('derives a stable twelve-character hex id from content alone', () => {
    const id = memoryId('the build must ship by January 22nd')
    expect(id).toMatch(MEMORY_ID_PATTERN)
    expect(id).toHaveLength(12)
    expect(memoryId('the build must ship by January 22nd')).toBe(id)
    expect(memoryId('a different fact')).not.toBe(id)
  })
})

describe('timestamps', () => {
  it('formats an epoch as the recorded shape and keeps a well-formed stamp', () => {
    expect(formatObservationTimestamp(EPOCH)).toBe('2026-01-15 14:30')
    expect(resolveTimestamp('2026-02-01 09:05', EPOCH)).toBe('2026-02-01 09:05')
  })

  it('falls back to the pass clock for a malformed stamp', () => {
    expect(resolveTimestamp('yesterday', EPOCH)).toBe('2026-01-15 14:30')
    expect(resolveTimestamp(undefined, EPOCH)).toBe('2026-01-15 14:30')
  })
})

describe('observation building', () => {
  it('computes the id, keeps allowed sources in chunk order, and normalizes relevance', () => {
    const result = buildObservation(
      { content: '  User decided to switch\n to GraphQL.  ', timestamp: '2026-01-15 14:30', relevance: 'high', sourceSeqs: [6, 4] },
      ALLOWED,
      EPOCH,
    )
    if (!('observation' in result)) throw new Error(`expected acceptance, got ${result.rejection.reason}`)
    expect(result.observation).toEqual({
      id: memoryId('User decided to switch to GraphQL.'),
      content: 'User decided to switch to GraphQL.',
      timestamp: '2026-01-15 14:30',
      relevance: 'high',
      sourceSeqs: [4, 6],
    })
  })

  it('defaults an unrecognized relevance to medium', () => {
    const result = buildObservation({ content: 'fact', sourceSeqs: [4], relevance: 'urgent' }, ALLOWED, EPOCH)
    if (!('observation' in result)) throw new Error('expected acceptance')
    expect(result.observation.relevance).toBe('medium')
  })

  it('rejects a citation outside the chunk instead of partially trusting it', () => {
    const result = buildObservation({ content: 'fact', sourceSeqs: [4, 99] }, ALLOWED, EPOCH)
    expect('rejection' in result && result.rejection.kind).toBe('observation')
  })

  it('rejects empty, non-array, and non-integer citations', () => {
    for (const sourceSeqs of [[], 'four', [1.5], [null], undefined]) {
      expect('rejection' in buildObservation({ content: 'fact', sourceSeqs }, ALLOWED, EPOCH)).toBe(true)
    }
  })

  it('rejects content that is empty after normalization', () => {
    expect('rejection' in buildObservation({ content: '   \n  ', sourceSeqs: [4] }, ALLOWED, EPOCH)).toBe(true)
    expect('rejection' in buildObservation({ content: 42, sourceSeqs: [4] }, ALLOWED, EPOCH)).toBe(true)
  })

  it('caps over-long content and records how much was dropped', () => {
    const result = buildObservation({ content: 'x'.repeat(MAX_RECORD_CONTENT_CHARS + 500), sourceSeqs: [4] }, ALLOWED, EPOCH)
    if (!('observation' in result)) throw new Error('expected acceptance')
    expect(result.observation.content).toContain('… [truncated 500 chars]')
  })

  it('deduplicates repeated citations', () => {
    const result = buildObservation({ content: 'fact', sourceSeqs: [4, 4, 5] }, ALLOWED, EPOCH)
    if (!('observation' in result)) throw new Error('expected acceptance')
    expect(result.observation.sourceSeqs).toEqual([4, 5])
  })
})

describe('reflection building', () => {
  const active = [memoryId('one'), memoryId('two')]

  it('keeps support ids that are active, deduplicated and in model order', () => {
    const result = buildReflection({ content: 'The project uses GraphQL.', supportingObservationIds: [active[1]!, active[0]!, active[1]!] }, active)
    if (!('reflection' in result)) throw new Error(`expected acceptance, got ${result.rejection.reason}`)
    expect(result.reflection).toEqual({
      id: memoryId('The project uses GraphQL.'),
      content: 'The project uses GraphQL.',
      supportingObservationIds: [active[1], active[0]],
    })
  })

  it('rejects support naming an observation that is not active', () => {
    const result = buildReflection({ content: 'fact', supportingObservationIds: ['deadbeefdead'] }, active)
    expect('rejection' in result && result.rejection.kind).toBe('reflection')
  })

  it('rejects missing or empty support, and non-string members', () => {
    for (const supportingObservationIds of [undefined, [], 'x', [7]]) {
      expect('rejection' in buildReflection({ content: 'fact', supportingObservationIds }, active)).toBe(true)
    }
  })

  it('rejects content that is empty after normalization', () => {
    expect('rejection' in buildReflection({ content: '\n\n', supportingObservationIds: active }, active)).toBe(true)
  })
})

describe('drop normalization', () => {
  const active = ['aaaa11112222', 'bbbb33334444']

  it('keeps only active ids, in model order, deduplicated', () => {
    expect(normalizeDropIds(['bbbb33334444', 'zzzz', 'aaaa11112222', 'bbbb33334444', 7], active))
      .toEqual(['bbbb33334444', 'aaaa11112222'])
  })

  it('returns nothing for a non-array proposal', () => {
    expect(normalizeDropIds(undefined, active)).toEqual([])
  })
})

describe('source seq normalization', () => {
  it('returns chunk order regardless of the order the model cited', () => {
    expect(normalizeSourceSeqs([5, 4], ALLOWED)).toEqual([4, 5])
  })
})

describe('reflection coverage', () => {
  it('classifies none, partial, and strong by citation count', () => {
    const target = memoryId('target')
    expect(coverageOf(target, [])).toBe('none')
    expect(coverageOf(target, [reflection('a', [target])])).toBe('partial')
    expect(coverageOf(target, [reflection('a', [target]), reflection('b', [target])])).toBe('strong')
    expect(coverageOf(target, [reflection('a', ['other'])])).toBe('none')
  })

  it('classifies a shared observation by its own citations only', () => {
    const target = memoryId('target')
    const reflections = [reflection('a', [target, 'other']), reflection('b', ['other']), reflection('c', [target])]
    expect(coverageOf(target, reflections)).toBe('strong')
  })

  it('agrees with a constructed observation record', () => {
    const record = observation('fact')
    expect(coverageOf(record.id, [reflection('a', [record.id])])).toBe('partial')
  })
})
