/**
 * `memory_recall` through the real tool pipeline.
 *
 * The tool is what makes memory traceable for the model, so these tests run it
 * the way the loop does — registered on a context, discovered by name, executed
 * against an agent-bound caller — and check the rendered text a model would
 * actually read. The resolver's own cases live in the domain package; here the
 * subject is the wiring, the query seam, and the refusal paths.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { memoryId, MemoryStore } from '@deepseek-ai/dsh-observational-memory'
import * as ToolMemoryRecall from '../src/index.ts'

/** A caller carrying only what a tool run reads. */
function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

/** One traced source read, as the query seam records it. */
interface SourceRead {
  readonly seq: number
  readonly type: string
  readonly data: unknown
  /** Present when this source was shadowed by a later checkpoint. */
  readonly replacedBy?: number
}

/**
 * A stand-in query seam that returns the scripted sources and treats every
 * other seq as absent, which is how the tool learns a citation is a gap.
 * @param reads - the sources this seam can resolve.
 * @param traced - seqs the seam should report as shadowed.
 */
function querySeam(reads: readonly SourceRead[], traced: readonly number[] = []) {
  return {
    async readEvent(request: { seq: number }) {
      const found = reads.find(read => read.seq === request.seq)
      if (found === undefined) throw new Error(`no event at ${String(request.seq)}`)
      return { target: { type: found.type, seq: found.seq, time: 1, data: found.data } }
    },
    async traceEvent(request: { seq: number }) {
      const replacedBy = traced.includes(request.seq) ? 99 : undefined
      return {
        target: { seq: request.seq },
        replacementChain: replacedBy === undefined ? [] : [99],
        replacedEventSeqs: [],
        sourceEventSeqs: [],
        derivedEventSeqs: [],
        ...replacedBy === undefined ? {} : { replacedBy },
      }
    },
  }
}

/** Mount the tool over a session whose memory holds the given records. */
async function harness(options: {
  observations?: readonly { content: string; sourceSeqs: number[] }[]
  reflections?: readonly { content: string; supportingObservationIds: string[] }[]
  dropped?: readonly { content: string; sourceSeqs: number[] }[]
  reads?: readonly SourceRead[]
  traced?: readonly number[]
  withSeam?: boolean
  /** Skip the ledger store so the tool sees no memory for the session. */
  withProjection?: boolean
}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.withSeam !== false) ctx.reflect.provide('sessionQuery', querySeam(options.reads ?? [], options.traced ?? []))
  // The ledger is a store the domain plugin publishes; a test that wants the
  // tool to see no memory simply does not publish one.
  const store = new MemoryStore({ storageDir: mkdtempSync(join(tmpdir(), 'om-recall-')), warn: () => {} })
  if (options.withProjection !== false) ctx.reflect.provide('observationalMemoryStore', store)
  await ctx.plugin(ToolMemoryRecall)

  const session = ctx.sessions.create(SessionId('recall-caller'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'switch the API to GraphQL' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  if (options.observations !== undefined) {
    store.recordObservations(session.id, options.observations.map(record => ({
      id: memoryId(record.content),
      content: record.content,
      timestamp: '2026-01-15 14:30',
      relevance: 'high' as const,
      sourceSeqs: record.sourceSeqs,
    })), session.seq)
  }
  if (options.reflections !== undefined) {
    store.recordReflections(session.id, options.reflections.map(record => ({
      id: memoryId(record.content),
      content: record.content,
      supportingObservationIds: record.supportingObservationIds,
    })), session.seq)
  }
  if (options.dropped !== undefined) {
    store.recordDrops(session.id, options.dropped.map(record => memoryId(record.content)), session.seq)
  }

  let call = 0
  const execute = (args: unknown, bound = true) => ctx.tools.execute({
    name: 'memory_recall',
    arguments: args,
    callId: ToolCallId(`recall-${String(++call)}`),
    signal: new AbortController().signal,
    ...bound ? { agent: fakeAgent(session) } : {},
  })
  return { ctx, session, execute }
}

/** The rendered text of one tool result. */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')
}

const SOURCE: SourceRead[] = [{
  seq: 3,
  type: 'user/message',
  data: createUserMessage({ content: [{ type: 'text', text: 'switch the API to GraphQL' }], source: { kind: 'user' } }),
}]

describe('memory_recall', () => {
  it('registers under its model-facing name without a bound caller needing extra services', async () => {
    const { ctx } = await harness({ observations: [{ content: 'a fact', sourceSeqs: [3] }], reads: SOURCE })
    const schemas = ctx.tools.schemas()
    expect(schemas.map(schema => schema.name)).toContain('memory_recall')
    await ctx.fiber.dispose()
  })

  it('resolves an observation and renders its source conversation', async () => {
    const { ctx, execute } = await harness({
      observations: [{ content: 'User switched to GraphQL.', sourceSeqs: [3] }],
      reads: SOURCE,
    })
    const result = await execute({ id: memoryId('User switched to GraphQL.') })
    expect(result.isError).toBe(false)
    const text = textOf(result)
    expect(text).toContain('Resolved a memory record')
    expect(text).toContain('(active)')
    expect(text).toContain('Sources:')
    expect(text).toContain('#3 user: switch the API to GraphQL')
    await ctx.fiber.dispose()
  })

  it('resolves a reflection through the observations it preserves', async () => {
    const observation = 'User switched to GraphQL.'
    const durable = 'The public API is GraphQL.'
    const { ctx, execute } = await harness({
      observations: [{ content: observation, sourceSeqs: [3] }],
      reflections: [{ content: durable, supportingObservationIds: [memoryId(observation)] }],
      reads: SOURCE,
    })
    const text = textOf(await execute({ id: memoryId(durable) }))
    expect(text).toContain('Resolved a reflection through the observations it preserves')
    expect(text).toContain(durable)
    expect(text).toContain(observation)
    expect(text).toContain('#3 user: switch the API to GraphQL')
    await ctx.fiber.dispose()
  })

  it('marks a shadowed source with the checkpoint that replaced it', async () => {
    const { ctx, execute } = await harness({
      observations: [{ content: 'a fact', sourceSeqs: [3] }],
      reads: SOURCE,
      traced: [3],
    })
    const text = textOf(await execute({ id: memoryId('a fact') }))
    expect(text).toContain('a later checkpoint, #99, replaced it')
    await ctx.fiber.dispose()
  })

  it('reports a dropped record as dropped while still resolving it', async () => {
    const content = 'A routine note.'
    const { ctx, execute } = await harness({
      observations: [{ content, sourceSeqs: [3] }],
      dropped: [{ content, sourceSeqs: [3] }],
      reads: SOURCE,
    })
    const text = textOf(await execute({ id: memoryId(content) }))
    expect(text).toContain('(dropped)')
    await ctx.fiber.dispose()
  })

  it('rejects a malformed id without touching the seam', async () => {
    const { ctx, execute } = await harness({ observations: [{ content: 'a fact', sourceSeqs: [3] }], reads: SOURCE })
    const text = textOf(await execute({ id: 'not-an-id' }))
    expect(text).toContain('is not a memory id')
    await ctx.fiber.dispose()
  })

  it('reports an unknown id', async () => {
    const { ctx, execute } = await harness({ observations: [{ content: 'a fact', sourceSeqs: [3] }], reads: SOURCE })
    const text = textOf(await execute({ id: 'aaaaaaaaaaaa' }))
    expect(text).toContain('No memory record has this id')
    await ctx.fiber.dispose()
  })

  it('reports no memory when the ledger is empty', async () => {
    const { ctx, execute } = await harness({})
    // An empty fold and an unknown id are the same answer to the model: there
    // is nothing under that id.
    const text = textOf(await execute({ id: 'aaaaaaaaaaaa' }))
    expect(text).toContain('No memory record has this id')
    await ctx.fiber.dispose()
  })

  it('reports a citation the log does not hold as a provenance gap', async () => {
    const { ctx, execute } = await harness({
      observations: [{ content: 'a fact', sourceSeqs: [42] }],
      reads: SOURCE,
    })
    const text = textOf(await execute({ id: memoryId('a fact') }))
    expect(text).toContain('Unresolved:')
    expect(text).toContain('source entries absent from the log: 42')
    await ctx.fiber.dispose()
  })

  it('reports a supporting observation that is no longer in the ledger', async () => {
    const durable = 'A durable fact.'
    const { ctx, execute } = await harness({
      reflections: [{ content: durable, supportingObservationIds: ['deadbeefdead'] }],
    })
    const text = textOf(await execute({ id: memoryId(durable) }))
    expect(text).toContain('supporting observations no longer in the ledger: deadbeefdead')
    await ctx.fiber.dispose()
  })

  it('reports a cited entry that is not conversation', async () => {
    const { ctx, execute } = await harness({
      observations: [{ content: 'a fact', sourceSeqs: [3] }],
      reads: [{ seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }],
    })
    const text = textOf(await execute({ id: memoryId('a fact') }))
    expect(text).toContain('cited entries that are not conversation: 3')
    await ctx.fiber.dispose()
  })

  it('reads an assistant source and reports a citation with no text', async () => {
    const { ctx, execute } = await harness({
      observations: [
        { content: 'From the assistant.', sourceSeqs: [3] },
        { content: 'From an empty entry.', sourceSeqs: [4] },
      ],
      reads: [
        {
          seq: 3,
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'the assistant said this' }] } },
        },
        // A message whose blocks carry no text is not citable evidence.
        { seq: 4, type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: '' }], source: { kind: 'user' } }) },
      ],
    })
    const assistant = textOf(await execute({ id: memoryId('From the assistant.') }))
    expect(assistant).toContain('#3 assistant: the assistant said this')
    const empty = textOf(await execute({ id: memoryId('From an empty entry.') }))
    expect(empty).toContain('cited entries that are not conversation: 4')
    await ctx.fiber.dispose()
  })

  it('treats source content that is not a block array as no text at all', async () => {
    const { ctx, execute } = await harness({
      observations: [{ content: 'A malformed source.', sourceSeqs: [3] }],
      // Content of the wrong shape carries no readable text, so the citation is
      // reported rather than rendered as an empty source.
      reads: [{ seq: 3, type: 'user/message', data: { content: 'not-an-array' } }],
    })
    const text = textOf(await execute({ id: memoryId('A malformed source.') }))
    expect(text).toContain('cited entries that are not conversation: 3')
    await ctx.fiber.dispose()
  })

  it('skips a block that is not a text block', async () => {
    const { ctx, execute } = await harness({
      observations: [{ content: 'A mixed source.', sourceSeqs: [3] }],
      reads: [{
        seq: 3,
        type: 'user/message',
        data: { content: [null, 'stray', { type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }, { type: 'text', text: 'the only prose' }] },
      }],
    })
    const text = textOf(await execute({ id: memoryId('A mixed source.') }))
    expect(text).toContain('#3 user: the only prose')
    await ctx.fiber.dispose()
  })

  it('reports an assistant source whose message carries no text', async () => {
    const { ctx, execute } = await harness({
      observations: [{ content: 'An empty assistant turn.', sourceSeqs: [3] }],
      reads: [{ seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '' }] } } }],
    })
    const text = textOf(await execute({ id: memoryId('An empty assistant turn.') }))
    expect(text).toContain('cited entries that are not conversation: 3')
    await ctx.fiber.dispose()
  })

  it('does not register at all when the ledger plugin is absent', async () => {
    // The tool declares the ledger store in its inject list, so a deployment
    // without the ledger plugin gets no `memory_recall` rather than a tool that
    // can only ever answer "no memory". The model never sees a dead tool.
    const { ctx, execute } = await harness({
      observations: [{ content: 'a fact', sourceSeqs: [3] }],
      reads: SOURCE,
      withProjection: false,
    })
    // The runtime reports an unregistered tool as a failed result rather than a
    // rejection, so this asserts on the outcome the model would receive.
    expect(textOf(await execute({ id: memoryId('a fact') })))
      .toContain('unknown tool "memory_recall"')
    await ctx.fiber.dispose()
  })

  it('clamps a long source and says how much it dropped', async () => {
    const { ctx, execute } = await harness({
      observations: [{ content: 'A long source.', sourceSeqs: [3] }],
      reads: [{
        seq: 3,
        type: 'user/message',
        data: createUserMessage({ content: [{ type: 'text', text: 'z'.repeat(2_500) }], source: { kind: 'user' } }),
      }],
    })
    const text = textOf(await execute({ id: memoryId('A long source.') }))
    expect(text).toContain('… [truncated 500 chars]')
    await ctx.fiber.dispose()
  })

  it('names a collision when one id matches both record kinds', async () => {
    const shared = 'The same sentence.'
    const { ctx, execute } = await harness({
      observations: [{ content: shared, sourceSeqs: [3] }],
      reflections: [{ content: shared, supportingObservationIds: [memoryId(shared)] }],
      reads: SOURCE,
    })
    const text = textOf(await execute({ id: memoryId(shared) }))
    expect(text).toContain('matches both an observation and a reflection')
    await ctx.fiber.dispose()
  })

  it('declares itself concurrency-safe and tolerates surrounding whitespace in the id', async () => {
    const { ctx, execute } = await harness({
      observations: [{ content: 'a fact', sourceSeqs: [3] }],
      reads: SOURCE,
    })
    expect(ctx.tools.get('memory_recall')?.isConcurrencySafe?.({ id: 'x' })).toBe(true)
    const text = textOf(await execute({ id: `  ${memoryId('a fact')}  ` }))
    expect(text).toContain('Resolved a memory record')
    await ctx.fiber.dispose()
  })

  it('refuses an unbound caller rather than guessing a session', async () => {
    const { ctx, execute } = await harness({ observations: [{ content: 'a fact', sourceSeqs: [3] }], reads: SOURCE })
    // The registry reports a tool-body failure as an error result, so the
    // refusal surfaces there rather than as a rejection.
    const result = await execute({ id: memoryId('a fact') }, false)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('agent-bound caller')
    await ctx.fiber.dispose()
  })

  it('leaves its prompt guidance registered beside the session-query tools', async () => {
    const { ctx } = await harness({})
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === 'tool:memory-recall')).toBe(true)
    await ctx.fiber.dispose()
  })
})
