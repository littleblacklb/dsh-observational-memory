/**
 * Behavior of the memory-compaction engine.
 *
 * This is the substitution the whole plugin exists for, so these tests pin the
 * two properties that make it safe: a checkpoint is only rendered when folded
 * memory actually produces one that shrinks the region, and everything else
 * delegates to the shipped summarizer. Delegation is the conservative answer —
 * it costs a model call, while a checkpoint that does not shrink would be
 * rejected by the region transaction and lose the pass.
 */

import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import { memoryId } from '../src/events.ts'
import type { Observation, Reflection } from '../src/events.ts'
import type { ObservationalMemoryState } from '../src/vocabulary.ts'
import {
  MEMORY_MODEL,
  MEMORY_PROVIDER,
  readMemory,
  renderCheckpoint,
} from '../src/compaction-engine.ts'
import { renderMemory } from '../src/render.ts'

function observation(content: string): Observation {
  return { id: memoryId(content), content, timestamp: '2026-01-15 14:30', relevance: 'medium', sourceSeqs: [1] }
}

function reflection(content: string): Reflection {
  return { id: memoryId(content), content, supportingObservationIds: [memoryId('evidence')] }
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

/** One replayed user message of a given text length. */
function message(text: string): Message {
  return {
    id: 'm1' as Message['id'],
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as Message
}

describe('reading folded memory', () => {
  it('reads the session memory state through the projection registry', () => {
    const folded = state({ observations: [observation('a fact')] })
    const registry = { stateOf: () => folded }
    expect(readMemory(registry, {} as never)).toBe(folded)
  })

  it('reports no memory when the registry has none for the session', () => {
    const registry = { stateOf: () => undefined }
    expect(readMemory(registry, {} as never)).toBeUndefined()
  })
})

describe('rendering a checkpoint', () => {
  it('delegates when there is no folded memory', () => {
    expect(readMemory({ stateOf: () => undefined }, {} as never)).toBeUndefined()
    expect(renderCheckpoint(undefined, { messages: [message('x'.repeat(4000))] })).toBeUndefined()
  })

  it('delegates when memory exists but renders to nothing', () => {
    expect(renderCheckpoint(state(), { messages: [message('x'.repeat(4000))] })).toBeUndefined()
  })

  it('renders memory when it shrinks the region it replaces', () => {
    const folded = state({ reflections: [reflection('The project uses GraphQL.')] })
    const text = renderCheckpoint(folded, { messages: [message('y'.repeat(40_000))] })
    expect(text).toBe(renderMemory(folded.reflections, folded.observations))
    expect(text).toContain('## Reflections')
  })

  it('delegates when the render would not shrink the region', () => {
    // A long memory against a tiny region cannot reduce pressure, and the
    // region transaction would reject it, so the default summarizer runs.
    const folded = state({
      observations: Array.from({ length: 40 }, (_value, index) => observation(`observation number ${String(index)} with some length to it`)),
    })
    expect(renderCheckpoint(folded, { messages: [message('tiny')] })).toBeUndefined()
  })

  it('counts only text blocks when pricing the region', () => {
    const folded = state({ observations: [observation('a fact')] })
    // A region made of a non-text block prices at zero, so nothing can shrink it.
    const toolOnly = {
      messages: [{
        id: 'm2' as Message['id'],
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1' as never, name: 'read', arguments: '{}' }],
        source: { kind: 'assistant' },
      } as unknown as Message],
    }
    expect(renderCheckpoint(folded, toolOnly)).toBeUndefined()
  })

  it('is conservative at the boundary: an equal-sized render delegates', () => {
    const folded = state({ observations: [observation('a fact worth exactly nothing here')] })
    const rendered = renderMemory(folded.reflections, folded.observations)
    // A region sized so the replacement would exactly match it must not be
    // accepted, because the region requires a strict reduction.
    const region = {
      messages: [message('z'.repeat(Math.max(0, rendered.length - 200)))],
    }
    expect(renderCheckpoint(folded, region)).toBeUndefined()
  })
})

describe('engine identity', () => {
  it('marks a model-free checkpoint with a stable provider and model', () => {
    expect(MEMORY_PROVIDER).toBe('observational-memory')
    expect(MEMORY_MODEL).toBe('deterministic')
  })
})
