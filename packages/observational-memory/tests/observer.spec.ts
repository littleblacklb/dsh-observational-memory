/**
 * Behavior of the observer's chunk selection, cadence thresholds, and the
 * validation that turns model output into records it will actually publish.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_OBSERVE_AFTER_RATIO,
  DEFAULT_OBSERVE_AFTER_TOKENS,
  OBSERVER_CHUNK_CONTEXT_RATIO,
  OBSERVER_CHUNK_FALLBACK_TOKENS,
  OBSERVER_CHUNK_MIN_TOKENS,
  resolveConfig,
  resolveObserverChunkTokens,
  resolveThreshold,
} from '../src/config.ts'
import type { ObservationSourceEntry } from '../src/source.ts'
import {
  OBSERVER_TOOL_NAME,
  observerCoverage,
  renderObserverChunk,
  runObserver,
  selectObserverChunk,
  uncoveredTokens,
} from '../src/observer.ts'
import type { ObserverLlm } from '../src/observer.ts'

function entry(seq: number, tokens: number, role: 'user' | 'assistant' = 'user'): ObservationSourceEntry {
  return { seq, role, text: 'x'.repeat(tokens * 4), tokens }
}

/** An LLM stub that yields one assembled tool call, or a failure, deterministically. */
function stubLlm(
  outcome:
    | { kind: 'tool-call'; arguments: unknown }
    | { kind: 'no-tool-call' }
    | { kind: 'finish-error' }
    | { kind: 'throw' },
): ObserverLlm {
  return {
    stream() {
      return (async function* generate() {
        if (outcome.kind === 'throw') throw new Error('transport down')
        if (outcome.kind === 'finish-error') {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }
          return
        }
        if (outcome.kind === 'no-tool-call') {
          yield { type: 'text-delta', index: 0, text: 'nothing to record' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'nothing to record' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const args = JSON.stringify(outcome.arguments)
        yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: OBSERVER_TOOL_NAME, argumentsDelta: args }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: 'call-1', name: OBSERVER_TOOL_NAME, arguments: args },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
}

const NOW = Date.parse('2026-01-15T14:30:00Z')

describe('cadence configuration', () => {
  it('resolves window-proportional thresholds and falls back to absolute counts', () => {
    expect(resolveConfig().observeAfterRatio).toBe(DEFAULT_OBSERVE_AFTER_RATIO)
    expect(resolveThreshold(0.05, 10_000, 1_000_000)).toBe(50_000)
    expect(resolveThreshold(0.05, 10_000, 200_000)).toBe(10_000)
    // Unknown or unusable windows, and a disabled ratio, use the absolute count.
    expect(resolveThreshold(0.05, 10_000, undefined)).toBe(DEFAULT_OBSERVE_AFTER_TOKENS)
    expect(resolveThreshold(0.05, 10_000, 0)).toBe(10_000)
    expect(resolveThreshold(0, 10_000, 1_000_000)).toBe(10_000)
    expect(resolveThreshold(0.05, 10_000, Number.NaN)).toBe(10_000)
    // A window too small to yield a usable threshold still yields at least one token.
    expect(resolveThreshold(0.05, 10_000, 1)).toBe(1)
  })

  it('derives the observer chunk budget from the memory model window', () => {
    expect(resolveObserverChunkTokens(undefined, 1_000_000)).toBe(200_000)
    expect(resolveObserverChunkTokens(undefined, 1_000_000)).toBe(Math.floor(1_000_000 * OBSERVER_CHUNK_CONTEXT_RATIO))
    expect(resolveObserverChunkTokens(undefined, undefined)).toBe(OBSERVER_CHUNK_FALLBACK_TOKENS)
    expect(resolveObserverChunkTokens(undefined, 0)).toBe(OBSERVER_CHUNK_FALLBACK_TOKENS)
    expect(resolveObserverChunkTokens(500, 1_000_000)).toBe(500)
    // An explicit budget below the floor is raised to the floor.
    expect(resolveObserverChunkTokens(1, 1_000_000)).toBe(OBSERVER_CHUNK_MIN_TOKENS)
  })

  it('carries an explicit observer chunk budget through resolution', () => {
    expect(resolveConfig({ model: {}, observerChunkMaxTokens: 1234 }).observerChunkMaxTokens).toBe(1234)
    expect(resolveConfig().observerChunkMaxTokens).toBeUndefined()
    expect(resolveConfig({ model: {}, observerChunkMaxTokens: 1 }).observerChunkMaxTokens).toBe(OBSERVER_CHUNK_MIN_TOKENS)
  })

  it('defaults the dropper target to half the maximum', () => {
    const resolved = resolveConfig({ model: {}, observationsPoolMaxTokens: 20_000 })
    expect(resolved.observationsPoolTargetTokens).toBe(10_000)
  })

  it('rejects misconfiguration instead of degrading silently', () => {
    expect(() => resolveConfig({ model: {}, observeAfterTokens: 0 })).toThrow(/positive integer/)
    expect(() => resolveConfig({ model: {}, observeAfterTokens: 1.5 })).toThrow(/positive integer/)
    expect(() => resolveConfig({ model: {}, observeAfterTokens: 'many' as never })).toThrow(/positive integer/)
    expect(() => resolveConfig({ model: {}, observeAfterRatio: 1 })).toThrow(/\[0, 1\)/)
    expect(() => resolveConfig({ model: {}, observeAfterRatio: -0.1 })).toThrow(/\[0, 1\)/)
    expect(() => resolveConfig({ model: {}, observationsPoolMaxTokens: 100, observationsPoolTargetTokens: 100 })).toThrow(/must be below/)
    expect(() => resolveConfig({ model: {}, observationsPoolTargetTokens: 0 })).toThrow(/positive integer/)
    expect(() => resolveConfig({ model: {}, workerMaxTokens: 0 })).toThrow(/positive integer/)
  })

  it('carries an explicit model override through resolution', () => {
    const model = { provider: 'p', model: 'm', reasoningEffort: 'low' }
    expect(resolveConfig({ model }).model).toEqual(model)
  })
})

describe('chunk selection', () => {
  const entries = [entry(1, 10), entry(2, 10), entry(3, 10), entry(4, 10)]

  it('takes the oldest uncovered entries within budget', () => {
    const selected = selectObserverChunk(entries, null, 25)
    expect(selected.chunk.map(item => item.seq)).toEqual([1, 2])
    expect(selected.coversUpToSeq).toBe(2)
  })

  it('resumes after the coverage watermark', () => {
    const selected = selectObserverChunk(entries, SessionSeq(2), 25)
    expect(selected.chunk.map(item => item.seq)).toEqual([3, 4])
    expect(selected.coversUpToSeq).toBe(4)
  })

  it('always includes one oversized entry so coverage cannot stall', () => {
    const selected = selectObserverChunk([entry(1, 1000), entry(2, 1)], null, 5)
    expect(selected.chunk.map(item => item.seq)).toEqual([1])
  })

  it('reports nothing to do once every entry is covered', () => {
    expect(selectObserverChunk(entries, SessionSeq(4), 25)).toEqual({ chunk: [], coversUpToSeq: null })
  })

  it('counts only tokens after the watermark', () => {
    expect(uncoveredTokens(entries, null)).toBe(40)
    expect(uncoveredTokens(entries, SessionSeq(2))).toBe(20)
    expect(uncoveredTokens(entries, SessionSeq(4))).toBe(0)
  })

  it('renders entries with their citable numbers and roles', () => {
    const text = renderObserverChunk([entry(7, 1, 'user'), entry(8, 1, 'assistant')])
    expect(text).toContain('[7] User: ')
    expect(text).toContain('[8] Assistant: ')
  })
})

describe('observer pass', () => {
  const chunk = [entry(1, 10), entry(2, 10)]

  async function run(outcome: Parameters<typeof stubLlm>[0]) {
    return await runObserver({
      llm: stubLlm(outcome),
      provider: 'p',
      model: 'm',
      chunk,
      coversUpToSeq: 2,
      signal: new AbortController().signal,
      nowMs: NOW,
    })
  }

  it('accepts observations whose citations are inside the chunk', async () => {
    const result = await run({
      kind: 'tool-call',
      arguments: {
        observations: [{
          timestamp: '2026-01-15 14:30',
          content: 'User switched the API to GraphQL.',
          relevance: 'high',
          sourceSeqs: [2, 1],
        }],
      },
    })
    expect(result.failure).toBeUndefined()
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]!.sourceSeqs).toEqual([1, 2])
  })

  it('treats a clean finish with no tool call as a deliberate empty pass, not a failure', async () => {
    const result = await run({ kind: 'no-tool-call' })
    expect(result.observations).toEqual([])
    expect(result.rejections).toEqual([])
    expect(result.failure).toBeUndefined()
    expect(result.coversUpToSeq).toBe(2)
  })

  it('reports a preview failure as a failure rather than an empty pass', async () => {
    const result = await run({ kind: 'finish-error' })
    expect(result.observations).toEqual([])
    expect(result.failure).toBe('rate limited')
  })

  it('reports a thrown stream error as a failure', async () => {
    const result = await run({ kind: 'throw' })
    expect(result.failure).toBe('transport down')
  })

  it('stringifies a thrown non-Error value', async () => {
    const result = await runObserver({
      llm: {
        stream() {
          return (async function* generate() {
            throw 'plain failure'
            // Unreachable: the throw above is the point of this stub.
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
      provider: 'p',
      model: 'm',
      chunk,
      coversUpToSeq: 2,
      signal: new AbortController().signal,
      nowMs: NOW,
    })
    expect(result.failure).toBe('plain failure')
  })

  it('rejects a record citing an entry outside the chunk and keeps the valid ones', async () => {
    const result = await run({
      kind: 'tool-call',
      arguments: {
        observations: [
          { timestamp: '2026-01-15 14:30', content: 'valid fact', relevance: 'medium', sourceSeqs: [1] },
          { timestamp: '2026-01-15 14:31', content: 'invented fact', relevance: 'medium', sourceSeqs: [99] },
        ],
      },
    })
    expect(result.observations.map(observation => observation.content)).toEqual(['valid fact'])
    expect(result.rejections).toHaveLength(1)
  })

  it('treats an unparseable tool argument payload as a deliberate empty pass', async () => {
    const result = await runObserver({
      llm: {
        stream() {
          return (async function* generate() {
            yield {
              type: 'block-end',
              index: 0,
              block: { type: 'tool-call', id: 'c', name: OBSERVER_TOOL_NAME, arguments: '{not json' },
            }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          })()
        },
      },
      provider: 'p',
      model: 'm',
      chunk,
      coversUpToSeq: 2,
      signal: new AbortController().signal,
      nowMs: NOW,
    })
    expect(result.observations).toEqual([])
    expect(result.rejections).toEqual([])
    expect(result.failure).toBeUndefined()
  })

  it('ignores a tool call addressed to a different tool', async () => {
    const result = await runObserver({
      llm: {
        stream() {
          return (async function* generate() {
            const args = JSON.stringify({ observations: [] })
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c', name: 'other_tool', arguments: args } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          })()
        },
      },
      provider: 'p',
      model: 'm',
      chunk,
      coversUpToSeq: 2,
      signal: new AbortController().signal,
      nowMs: NOW,
    })
    expect(result.observations).toEqual([])
  })

  it('reports an aborted pass as a failure', async () => {
    const result = await runObserver({
      llm: {
        stream() {
          return (async function* generate() {
            yield { type: 'finish', reason: { kind: 'aborted' } }
          })()
        },
      },
      provider: 'p',
      model: 'm',
      chunk,
      coversUpToSeq: 2,
      signal: new AbortController().signal,
      nowMs: NOW,
    })
    expect(result.failure).toBe('aborted')
  })

  it('reports an error finish with no failure detail', async () => {
    const result = await runObserver({
      llm: {
        stream() {
          return (async function* generate() {
            yield { type: 'finish', reason: { kind: 'error' } }
          })()
        },
      },
      provider: 'p',
      model: 'm',
      chunk,
      coversUpToSeq: 2,
      signal: new AbortController().signal,
      nowMs: NOW,
    })
    expect(result.failure).toBe('stream error')
  })

  it('reports an error finish without failure detail as a stream error', async () => {
    const result = await runObserver({
      llm: {
        stream() {
          return (async function* generate() {
            yield { type: 'finish', reason: { kind: 'error' } }
          })()
        },
      },
      provider: 'p',
      model: 'm',
      chunk,
      coversUpToSeq: 2,
      signal: new AbortController().signal,
      nowMs: NOW,
    })
    expect(result.failure).toBe('stream error')
  })

  it('collapses observations that reduce to the same content-addressed id', async () => {
    const result = await run({
      kind: 'tool-call',
      arguments: {
        observations: [
          { timestamp: '2026-01-15 14:30', content: 'same fact', relevance: 'medium', sourceSeqs: [1] },
          { timestamp: '2026-01-15 14:31', content: 'same fact', relevance: 'low', sourceSeqs: [2] },
        ],
      },
    })
    expect(result.observations).toHaveLength(1)
  })

  it('passes a generation cap through when configured', async () => {
    let seen: { maxTokens?: number } | undefined
    await runObserver({
      llm: {
        stream(options) {
          seen = options as { maxTokens?: number }
          return (async function* generate() {
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
      provider: 'p',
      model: 'm',
      chunk,
      coversUpToSeq: 2,
      signal: new AbortController().signal,
      nowMs: NOW,
      maxTokens: 4096,
    })
    expect(seen?.maxTokens).toBe(4096)
  })
})

describe('observer coverage', () => {
  it('reads a watermark or reports no coverage', () => {
    expect(observerCoverage({ coverage: { observer: null } })).toBeNull()
    expect(observerCoverage({ coverage: { observer: 5 } })).toBe(5)
  })
})
