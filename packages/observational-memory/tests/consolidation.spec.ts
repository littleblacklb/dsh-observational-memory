/**
 * Behavior of the reflector and dropper passes.
 *
 * Both passes turn model output into durable records, so these tests pin what
 * they refuse: a reflection citing an observation that is not active, and a
 * drop naming an id outside the eligible pool. They also pin the two
 * asymmetries that matter downstream — reflections are scarce, and the drop
 * budget is a ceiling rather than a target.
 */

import { describe, expect, it } from 'vitest'
import { memoryId } from '../src/events.ts'
import type { Observation, Reflection } from '../src/events.ts'
import { observationLine } from '../src/render.ts'
import {
  DROPPER_TOOL_NAME,
  dropperCoverage,
  renderDropperInput,
  runDropper,
} from '../src/dropper.ts'
import {
  REFLECTOR_TOOL_NAME,
  reflectorCoverage,
  reflectorInputs,
  renderReflectorInput,
  renderReflectorLine,
  runReflector,
} from '../src/reflector.ts'
import { poolMetrics } from '../src/pool.ts'
import type { WorkerLlm } from '../src/worker.ts'

/** An LLM stub that answers with one tool call, a clean empty finish, or a failure. */
function stubLlm(
  outcome:
    | { kind: 'tool-call'; tool: string; arguments: unknown }
    | { kind: 'no-tool-call' }
    | { kind: 'fail' }
    | { kind: 'throw' }
    | { kind: 'bad-json' },
): WorkerLlm {
  return {
    stream() {
      return (async function* generate() {
        if (outcome.kind === 'throw') throw new Error('transport down')
        if (outcome.kind === 'fail') {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider down' } } }
          return
        }
        if (outcome.kind === 'no-tool-call') {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const args = outcome.kind === 'bad-json' ? '{not json' : JSON.stringify(outcome.arguments)
        const tool = outcome.kind === 'bad-json' ? REFLECTOR_TOOL_NAME : outcome.tool
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: tool, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
}

const SIGNAL = new AbortController().signal

function observation(content: string, relevance: Observation['relevance'] = 'medium'): Observation {
  return { id: memoryId(content), content, timestamp: '2026-01-15 14:30', relevance, sourceSeqs: [1] }
}

function reflection(content: string, support: string[]): Reflection {
  return { id: memoryId(content), content, supportingObservationIds: support }
}

describe('reflector input rendering', () => {
  it('annotates every observation with its coverage tier', () => {
    const target = observation('a fact')
    const inputs = reflectorInputs([target], [])
    expect(inputs).toEqual([{ observation: target, coverage: 'none' }])
    expect(renderReflectorLine(inputs[0]!)).toBe(`${observationLine(target)} [coverage: none]`)
  })

  it('lists already-recorded reflections separately so they are not restated', () => {
    const target = observation('a fact')
    const existing = reflection('The project uses GraphQL.', [target.id])
    const text = renderReflectorInput(reflectorInputs([target], [existing]), [existing])
    expect(text).toContain('## Observations')
    expect(text).toContain('## Already recorded')
    expect(text).toContain(`[${existing.id}] ${existing.content}`)
  })

  it('omits the recorded section when there is nothing recorded yet', () => {
    const text = renderReflectorInput(reflectorInputs([observation('a fact')], []), [])
    expect(text).not.toContain('## Already recorded')
  })
})

describe('reflector pass', () => {
  const target = observation('the build must ship by January 22nd')

  async function run(outcome: Parameters<typeof stubLlm>[0], existing: Reflection[] = []) {
    return await runReflector({
      llm: stubLlm(outcome),
      provider: 'p',
      model: 'm',
      inputs: reflectorInputs([target], existing),
      existing,
      signal: SIGNAL,
    })
  }

  it('accepts a reflection citing active observations', async () => {
    const result = await run({
      kind: 'tool-call',
      tool: REFLECTOR_TOOL_NAME,
      arguments: { reflections: [{ content: 'There is a hard ship date.', supportingObservationIds: [target.id] }] },
    })
    expect(result.failure).toBeUndefined()
    expect(result.reflections).toEqual([{
      id: memoryId('There is a hard ship date.'),
      content: 'There is a hard ship date.',
      supportingObservationIds: [target.id],
    }])
  })

  it('rejects a reflection citing an observation that is not active', async () => {
    const result = await run({
      kind: 'tool-call',
      tool: REFLECTOR_TOOL_NAME,
      arguments: { reflections: [{ content: 'unsupported claim', supportingObservationIds: ['deadbeefdead'] }] },
    })
    expect(result.reflections).toEqual([])
    expect(result.rejections).toHaveLength(1)
  })

  it('drops a reflection that is already recorded rather than appending it twice', async () => {
    const content = 'The project has a hard ship date.'
    const existing = [reflection(content, [target.id])]
    const result = await run({
      kind: 'tool-call',
      tool: REFLECTOR_TOOL_NAME,
      arguments: { reflections: [{ content, supportingObservationIds: [target.id] }] },
    }, existing)
    expect(result.reflections).toEqual([])
    expect(result.rejections).toEqual([])
  })

  it('drops a reflection the same pass proposed twice', async () => {
    const proposal = { content: 'Repeated fact.', supportingObservationIds: [target.id] }
    const result = await run({
      kind: 'tool-call',
      tool: REFLECTOR_TOOL_NAME,
      arguments: { reflections: [proposal, proposal] },
    })
    expect(result.reflections).toHaveLength(1)
  })

  it('treats a clean finish with no tool call as a deliberate empty pass', async () => {
    const result = await run({ kind: 'no-tool-call' })
    expect(result.reflections).toEqual([])
    expect(result.failure).toBeUndefined()
  })

  it('treats an unparseable payload as a deliberate empty pass', async () => {
    const result = await run({ kind: 'bad-json' })
    expect(result.reflections).toEqual([])
    expect(result.failure).toBeUndefined()
  })

  it('reports a provider failure and a thrown stream error', async () => {
    expect((await run({ kind: 'fail' })).failure).toBe('provider down')
    expect((await run({ kind: 'throw' })).failure).toBe('transport down')
  })

  it('reads the reflector watermark', () => {
    expect(reflectorCoverage({ coverage: { reflector: null } })).toBeNull()
    expect(reflectorCoverage({ coverage: { reflector: 9 } })).toBe(9)
  })
})

describe('dropper input rendering', () => {
  it('states the pool measurement and the drop ceiling', () => {
    const records = [observation('one'), observation('two')]
    const metrics = poolMetrics(records, 1)
    const candidates = records.map(record => ({ observation: record, coverage: 'strong' }))
    const text = renderDropperInput(candidates, [], metrics)
    expect(text).toContain('holds ~')
    expect(text).toContain('You may drop at most')
    expect(text).toContain(`[coverage: strong]`)
  })

  it('includes the reflections when there are any', () => {
    const records = [observation('one')]
    const metrics = poolMetrics(records, 1)
    const reflections = [reflection('A durable fact.', [records[0]!.id])]
    const text = renderDropperInput(records.map(record => ({ observation: record, coverage: 'partial' })), reflections, metrics)
    expect(text).toContain('## Reflections already preserving them')
  })
})

describe('dropper pass', () => {
  const records = Array.from({ length: 6 }, (_value, index) => observation(`fact number ${index}`))

  /** The pool's full size, so any target below it is over budget. */
  function totalTokens(): number {
    return poolMetrics(records, 1).activeTokens
  }

  /** A target one token under the pool, so the excess is the smallest possible. */
  function overTarget(): number {
    return totalTokens() - 1
  }

  async function run(outcome: Parameters<typeof stubLlm>[0], observations = records) {
    return await runDropper({
      llm: stubLlm(outcome),
      provider: 'p',
      model: 'm',
      observations,
      reflections: [],
      targetTokens: overTarget(),
      signal: SIGNAL,
    })
  }

  it('does nothing while the pool is within budget', async () => {
    const result = await runDropper({
      llm: stubLlm({ kind: 'tool-call', tool: DROPPER_TOOL_NAME, arguments: { ids: records.map(record => record.id) } }),
      provider: 'p',
      model: 'm',
      observations: records,
      reflections: [],
      targetTokens: 1_000_000,
      signal: SIGNAL,
    })
    expect(result.droppedIds).toEqual([])
  })

  it('accepts a selection drawn from the eligible pool', async () => {
    const result = await run({
      kind: 'tool-call',
      tool: DROPPER_TOOL_NAME,
      arguments: { ids: [records[0]!.id, records[1]!.id] },
    })
    expect(result.failure).toBeUndefined()
    // One token over target clears with a single small observation.
    expect(result.droppedIds).toEqual([records[0]!.id])
  })

  it('bounds the selection by the drop ceiling rather than trusting the model', async () => {
    const result = await run({
      kind: 'tool-call',
      tool: DROPPER_TOOL_NAME,
      arguments: { ids: records.map(record => record.id) },
    })
    const ceiling = poolMetrics(records, overTarget()).maxDrops
    expect(ceiling).toBe(1)
    // The model proposed every id; the budget allows exactly one.
    expect(result.droppedIds).toHaveLength(ceiling)
    expect(result.droppedIds.length).toBeLessThan(records.length)
  })

  it('discards ids outside the eligible pool', async () => {
    const result = await run({
      kind: 'tool-call',
      tool: DROPPER_TOOL_NAME,
      arguments: { ids: ['deadbeefdead'] },
    })
    expect(result.droppedIds).toEqual([])
  })

  it('keeps everything when the model proposes nothing', async () => {
    const empty = await run({ kind: 'tool-call', tool: DROPPER_TOOL_NAME, arguments: { ids: [] } })
    expect(empty.droppedIds).toEqual([])
  })

  it('keeps everything on a clean finish with no tool call', async () => {
    expect((await run({ kind: 'no-tool-call' })).droppedIds).toEqual([])
  })

  it('reports a provider failure instead of an empty selection', async () => {
    expect((await run({ kind: 'fail' })).failure).toBe('provider down')
  })

  it('ignores a tool call addressed to a different tool', async () => {
    const result = await run({ kind: 'tool-call', tool: 'other_tool', arguments: { ids: [records[0]!.id] } })
    expect(result.droppedIds).toEqual([])
  })

  it('reads the dropper watermark', () => {
    expect(dropperCoverage({ coverage: { dropper: null } })).toBeNull()
    expect(dropperCoverage({ coverage: { dropper: 4 } })).toBe(4)
  })
})
