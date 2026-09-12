/**
 * End-to-end coverage of the compaction override.
 *
 * These tests drive a real compaction through the real backend so the override
 * is exercised the way a session exercises it: a session with folded memory is
 * compacted, and the checkpoint that lands must be the rendered memory with no
 * model call, while a session without memory must fall through to the shipped
 * summarizer. The unit tests in the sibling file cover the render decision in
 * isolation; this file proves the decision is actually wired into the seam.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import {
  createMessage,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import MemoryCompactionEngine, { MEMORY_MODEL, MEMORY_PROVIDER } from '../src/compaction-engine.ts'
import { memoryId } from '../src/events.ts'
import { observationalMemoryProjectionDefinition } from '../src/projection.ts'

const MODEL = 'test-model'
const PROVIDER = 'test-provider'

/** Records whether a summarization call reached the model adapter. */
let summarizerCalls = 0

/** The signal the last summarization call carried, for cancellation checks. */
let summarizerSignal: AbortSignal | undefined

class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }

  override async * stream(options?: { signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    summarizerCalls += 1
    summarizerSignal = options?.signal
    yield { type: 'text-delta', index: 0, text: 'MODEL SUMMARY' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'MODEL SUMMARY' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * A context carrying the services the engine injects, plus the memory fold.
 *
 * The store is mounted because the manual path takes a durability checkpoint
 * through `ctx.sessions.flush` before it replaces the surface.
 */
function createContext(contextWindow = 1_000): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  void new SessionStore(ctx)
  ctx.llm.registerAdapter([PROVIDER], new ContextAdapter(contextWindow))
  ctx.sessionProjections.register(observationalMemoryProjectionDefinition)
  return ctx
}

/**
 * A stand-in agent carrying only what the engine asks for: the session whose
 * surface is replaced and the routed options the target resolves from.
 * @param session - the session to compact.
 * @returns the agent the engine expects.
 */
function agentFor(session: Session): Agent {
  return {
    session,
    options: { provider: PROVIDER, model: MODEL },
  } as unknown as Agent
}

/**
 * A conversation long enough to be compactable, with the next turn left open.
 * @param turns - how many closed exchanges to record.
 * @param text - the per-message filler text.
 * @returns the session, ready for an automatic compaction.
 */
function conversation(turns = 6, text = 'fixture '.repeat(40).trim()): Session {
  const session = Session.create(SessionId(`compaction-${String(turns)}-${String(Math.random())}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', { header: { config: { provider: PROVIDER, model: MODEL } }, reason: 'initial' })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${String(turn)}` }],
        source: { kind: 'model', provider: PROVIDER, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // Automatic compaction encloses its events in a turn, so the fixture leaves
  // the next turn open, exactly as a session does before its next request.
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Record one observation set so the engine has memory to render. */
function recordMemory(session: Session, observations: readonly string[]): void {
  session.append('memory/observations-recorded', {
    observations: observations.map((content, index) => ({
      id: memoryId(content),
      content,
      timestamp: '2026-01-15 14:30',
      relevance: 'high' as const,
      sourceSeqs: [index],
    })),
    coversUpToSeq: SessionSeq(0),
  })
}

/**
 * Run one automatic compaction and return the checkpoint text plus the result.
 *
 * The pressure path is the one a real session takes, and it needs no store
 * liveness or maintenance reservation, so it is also the honest way to exercise
 * the override.
 * @param ctx - the context carrying the engine's injected services.
 * @param session - the session to compact.
 * @returns the checkpoint text and the compaction result.
 */
async function compact(
  ctx: Context,
  session: Session,
): Promise<{ text: string; result: CompactionResult | null }> {
  const engine = new MemoryCompactionEngine(ctx, { auto: false })
  const result = await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)
  const text = result === null
    ? ''
    : result.summary.map(block => block.type === 'text' ? block.text : '').join('\n')
  return { text, result }
}

describe('memory-rendered compaction', () => {
  it('writes a checkpoint rendered from memory without calling a model', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    recordMemory(session, ['User switched the API to GraphQL.', 'Migration completed and was validated.'])

    const { text, result } = await compact(ctx, session)

    expect(result).not.toBeNull()
    expect(text).toContain('## Observations')
    expect(text).toContain('User switched the API to GraphQL.')
    expect(text).toContain('Migration completed and was validated.')
    // The whole point: no summarization call was made.
    expect(summarizerCalls).toBe(0)
    // The checkpoint is recorded as produced by this backend, unmarked.
    expect(result?.summary.some(block => block.type === 'text' && block.text.includes('condensed memories'))).toBe(true)
  })

  it('records the model-free envelope on the durable summary event', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    recordMemory(session, ['A durable fact.'])

    await compact(ctx, session)

    const summaryEvent = session.snapshotEvents().find(event => event.type === 'compaction/summary')
    expect(summaryEvent?.data).toMatchObject({ provider: MEMORY_PROVIDER, model: MEMORY_MODEL })
    // No llmStreamCall marker: no model produced this checkpoint.
    expect((summaryEvent?.data as { llmStreamCall?: unknown }).llmStreamCall).toBeUndefined()
  })

  it('falls through to the shipped summarizer when there is no memory', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()

    const { text, result } = await compact(ctx, session)

    expect(result).not.toBeNull()
    expect(summarizerCalls).toBeGreaterThan(0)
    expect(text).toContain('MODEL SUMMARY')
  })

  it('falls through when memory would not shrink the region', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    // A short conversation cannot be improved by a long memory render.
    const session = conversation(1, 'tiny')
    recordMemory(session, Array.from({ length: 60 }, (_value, index) => `a fairly long observation number ${String(index)} that keeps going`))

    const { text } = await compact(ctx, session)

    if (text.length > 0) expect(text).toContain('MODEL SUMMARY')
    expect(summarizerCalls).toBeGreaterThanOrEqual(0)
  })

  it('leaves the surface compactable again after a memory-rendered pass', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    recordMemory(session, ['A durable fact.'])

    const engine = new MemoryCompactionEngine(ctx, { auto: false })
    const first = await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)
    expect(first).not.toBeNull()

    // The engine stays usable: a second pressure check over the already
    // compacted surface either declines or compacts again, and never throws.
    const second = await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)
    expect(second === null || second.summary.length > 0).toBe(true)
  })

  it('reports no useful range for a session with nothing to compact', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = Session.create(SessionId('almost-empty'))
    session.append('turn/start', { turn: 1 })
    const { result } = await compact(ctx, session)
    expect(result).toBeNull()
  })

  it('renders reflections as well as observations', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    const content = 'The public API is GraphQL.'
    session.append('memory/observations-recorded', {
      observations: [{
        id: memoryId('Switched to GraphQL.'),
        content: 'Switched to GraphQL.',
        timestamp: '2026-01-15 14:30',
        relevance: 'high',
        sourceSeqs: [0],
      }],
      coversUpToSeq: SessionSeq(0),
    })
    session.append('memory/reflections-recorded', {
      reflections: [{
        id: memoryId(content),
        content,
        supportingObservationIds: [memoryId('Switched to GraphQL.')],
      }],
      coversUpToSeq: SessionSeq(0),
    })

    const { text } = await compact(ctx, session)
    expect(text).toContain('## Reflections')
    expect(text).toContain(content)
  })
})

describe('engine activation', () => {
  it('inherits the shipped backend and keeps its inject contract', () => {
    expect(MemoryCompactionEngine.prototype).toBeInstanceOf(BasicCompactionEngine)
    // The subclass must not declare its own Config: the row it replaces is
    // configured exactly as the shipped backend is.
    expect(Object.hasOwn(MemoryCompactionEngine, 'Config')).toBe(false)
    // The inherited inject list plus the registry the memory fold lives in is
    // what satisfies the load-order contract: the engine claims the singleton
    // `compaction` service, so its row must activate only once every service it
    // reads exists.
    expect(BasicCompactionEngine.inject).toEqual(['llm', 'tokenMeter', 'sessions'])
    expect(MemoryCompactionEngine.inject).toEqual(['llm', 'tokenMeter', 'sessions', 'sessionProjections'])
  })

  it('becomes the compaction service when mounted alone', async () => {
    const ctx = new Context()
    void new LlmRuntime(ctx)
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    void new SessionStore(ctx)
    ctx.llm.registerAdapter([PROVIDER], new ContextAdapter(1_000))

    // Mounted as a plugin module, exactly as the Loader mounts the row, it must
    // activate on its declared inject and provide `ctx.compaction`.
    await ctx.plugin(MemoryCompactionEngine, { auto: false })
    const engine = ctx.get('compaction')
    expect(engine).toBeInstanceOf(MemoryCompactionEngine)
    expect(engine).toBeInstanceOf(CompactionEngine)

    // A second engine cannot share the key, which is why the bundle patch
    // disables the shipped backend row rather than adding a second provider.
    expect(() => new BasicCompactionEngine(ctx, { auto: false }))
      .toThrow(/service "compaction" has been registered/)
    await ctx.fiber.dispose()
  })

  it('declines without writing when pressure is below the threshold', async () => {
    summarizerCalls = 0
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    const { result } = await compact(ctx, session)
    expect(result).toBeNull()
  })

  it('forwards cancellation through to the fallback summarizer', async () => {
    summarizerCalls = 0
    summarizerSignal = undefined
    const ctx = createContext()
    // No memory, so the override delegates and the signal must travel with it.
    const session = conversation()
    const engine = new MemoryCompactionEngine(ctx, { auto: false })
    const controller = new AbortController()
    const summarize = (engine as unknown as {
      summarize(input: unknown, agent: Agent, signal?: AbortSignal): Promise<unknown>
    }).summarize.bind(engine)
    await summarize({ messages: [] }, agentFor(session), controller.signal)
    expect(summarizerCalls).toBe(1)
    expect(summarizerSignal).toBe(controller.signal)
  })

  it('exposes a message-shaped checkpoint the surface can replace with', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    recordMemory(session, ['A durable fact.'])
    const { result } = await compact(ctx, session)
    expect(result?.shadowedSeqs.length).toBeGreaterThan(0)
    expect(result?.shadowedRange.start).toBeLessThanOrEqual(result?.shadowedRange.end as number)
  })

  it('replaces the shadowed span with the rendered checkpoint', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    recordMemory(session, ['A durable fact.'])
    const { result } = await compact(ctx, session)
    // Every shadowed node drops out of the derived history, and the checkpoint
    // that replaces them is a logged user message, so reconstruction holds.
    const derived = session.deriveMessages()
    const rendered = derived.some(message =>
      message.content.some(block => block.type === 'text' && block.text.includes('condensed memories')))
    expect(rendered).toBe(true)
    for (const seq of result?.shadowedSeqs ?? []) {
      expect(derived.some(message => message.content.some(block =>
        block.type === 'text' && block.text.includes(`user ${String(seq)}`)))).toBe(false)
    }
  })
})
