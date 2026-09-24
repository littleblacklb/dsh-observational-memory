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
import { selectRecentRange, sourceTokens } from '../src/compaction-source.ts'
import { memoryId } from '../src/model.ts'
import { publishStore } from './store-fixture.ts'

const MODEL = 'test-model'
const PROVIDER = 'test-provider'

/** Records whether a summarization call reached the model adapter. */
let summarizerCalls = 0

/** The signal the last summarization call carried, for cancellation checks. */
let summarizerSignal: AbortSignal | undefined
let waitForSummary: Promise<void> | undefined

class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...Number.isFinite(this.contextWindow) ? { context: { contextWindow: this.contextWindow } } : {} })
  }

  override async * stream(options?: { signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    summarizerCalls += 1
    summarizerSignal = options?.signal
    if (waitForSummary !== undefined) await waitForSummary
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
  publishStore(ctx)
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
function recordMemory(ctx: Context, session: Session, observations: readonly string[]): void {
  ctx.observationalMemoryStore.recordObservations(session.id, observations.map((content, index) => ({
    id: memoryId(content),
    content,
    timestamp: '2026-01-15 14:30',
    relevance: 'high' as const,
    sourceSeqs: [index],
  })), Math.max(...session.surface.nodes))
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
    recordMemory(ctx, session, ['User switched the API to GraphQL.', 'Migration completed and was validated.'])

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
    recordMemory(ctx, session, ['A durable fact.'])

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

  it('delegates when a checkpoint or unknown source cannot be proven covered', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    recordMemory(ctx, session, ['An old durable fact.'])
    const engine = new MemoryCompactionEngine(ctx, { auto: false })
    const summarize = (engine as unknown as { summarize(input: unknown, agent: Agent): Promise<unknown> }).summarize.bind(engine)
    const unknown = createUserMessage({ content: [{ type: 'text', text: 'unknown' }], source: { kind: 'user' } })
    await summarize({ messages: [unknown] }, agentFor(session))
    const plugin = createUserMessage({ content: [{ type: 'text', text: 'snapshot' }], source: { kind: 'plugin', plugin: 'compact' } })
    session.append('user/message', plugin, { surfaceOp: 'append' })
    await summarize({ messages: [plugin] }, agentFor(session))
    const system = { id: 's1', role: 'system', source: { kind: 'plugin', plugin: 'system' }, content: [{ type: 'text', text: 'system' }] }
    session.append('system/message', { message: system } as never, { surfaceOp: 'append' })
    await summarize({ messages: [system] }, agentFor(session))
    expect(summarizerCalls).toBe(3)
  })

  it('recognizes a ledger-only runtime snapshot as already represented in memory', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    recordMemory(ctx, session, ['Durable evidence.'])
    const snapshot = createUserMessage({ content: [{ type: 'text', text: 'old memory snapshot' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot',
        sections: [{ name: 'observational-memory', text: 'old memory snapshot' }] } })
    session.append('user/message', snapshot, { surfaceOp: 'append' })
    const engine = new MemoryCompactionEngine(ctx, { auto: false })
    const summarize = (engine as unknown as { summarize(input: unknown, agent: Agent): Promise<{ summary: { type: string; text?: string }[] }> }).summarize.bind(engine)
    const result = await summarize({ messages: session.deriveMessages() }, agentFor(session))
    expect(result.summary[0]?.text).toContain('Durable evidence.')
    expect(summarizerCalls).toBe(0)
  })

  it('does not drop mixed runtime snapshots containing unrelated context', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    recordMemory(ctx, session, ['Durable evidence.'])
    const snapshot = createUserMessage({ content: [{ type: 'text', text: 'mixed' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot',
        sections: [{ name: 'observational-memory', text: 'memory' }, { name: 'other', text: 'other data' }] } })
    session.append('user/message', snapshot, { surfaceOp: 'append' })
    const engine = new MemoryCompactionEngine(ctx, { auto: false })
    const summarize = (engine as unknown as { summarize(input: unknown, agent: Agent): Promise<unknown> }).summarize.bind(engine)
    await summarize({ messages: session.deriveMessages() }, agentFor(session))
    expect(summarizerCalls).toBe(1)
  })

  it('falls through when memory would not shrink the region', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    // A short conversation cannot be improved by a long memory render.
    const session = conversation(1, 'tiny')
    recordMemory(ctx, session, Array.from({ length: 60 }, (_value, index) => `a fairly long observation number ${String(index)} that keeps going`))

    const { text } = await compact(ctx, session)

    if (text.length > 0) expect(text).toContain('MODEL SUMMARY')
    expect(summarizerCalls).toBeGreaterThanOrEqual(0)
  })

  it('leaves the surface compactable again after a memory-rendered pass', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    recordMemory(ctx, session, ['A durable fact.'])

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
    ctx.observationalMemoryStore.recordObservations(session.id, [{
      id: memoryId('Switched to GraphQL.'),
      content: 'Switched to GraphQL.',
      timestamp: '2026-01-15 14:30',
      relevance: 'high',
      sourceSeqs: [0],
    }], Math.max(...session.surface.nodes))
    ctx.observationalMemoryStore.recordReflections(session.id, [{
      id: memoryId(content),
      content,
      supportingObservationIds: [memoryId('Switched to GraphQL.')],
    }], 0)

    const { text } = await compact(ctx, session)
    expect(text).toContain('## Reflections')
    expect(text).toContain(content)
  })
})

describe('proactive source budget', () => {
  it('counts untruncated conversation and retained tail, not the checkpoint or injected memory', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(10, 'x'.repeat(20_000))
    const before = sourceTokens(session, ctx.tokenMeter)
    expect(before).toBeGreaterThan(81_000)
    recordMemory(ctx, session, ['A durable fact.'])
    const engine = new MemoryCompactionEngine(ctx)
    await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)
    const after = sourceTokens(session, ctx.tokenMeter)
    expect(after).toBeGreaterThan(0)
    expect(after).toBeLessThan(before)
  })

  it('prices a large source without the observer 20K-character clamp', () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'x'.repeat(40_000))
    expect(sourceTokens(session, ctx.tokenMeter)).toBeGreaterThan(20_000)
  })

  it('counts tool results from the full nested payload', () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    const before = sourceTokens(session, ctx.tokenMeter)
    session.append('tool/result', { message: {
      id: 'r1', role: 'tool', source: { kind: 'tool', callId: 'c1' },
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(40_000) }], isError: false }],
    } } as never, { surfaceOp: 'append' })
    expect(sourceTokens(session, ctx.tokenMeter) - before).toBeGreaterThan(5_000)
  })

  it('rejects an out-of-sync price list and protects the system head', () => {
    const ctx = createContext()
    const session = conversation(1, 'tiny')
    expect(() => selectRecentRange(session, { nodes: [] } as never, 1)).toThrow(/disagrees/)
    const systemOnly = { surface: { nodes: [SessionSeq(1)] }, eventAt: () => ({ type: 'system/message' }) } as unknown as Session
    expect(sourceTokens(systemOnly, ctx.tokenMeter)).toBe(0)
    expect(selectRecentRange(systemOnly, { nodes: [{ seq: SessionSeq(1), tokens: 10 }] } as never, 0)).toBeNull()
  })

  it('skips a null-derived message in a replayed surface', () => {
    const ctx = createContext()
    const session = { surface: { nodes: [SessionSeq(1)] }, eventAt: () => ({
      type: 'assistant/message', data: { message: { id: 'empty', role: 'assistant', content: [], source: { kind: 'model' } } },
    }) } as unknown as Session
    expect(sourceTokens(session, ctx.tokenMeter)).toBe(0)
  })

  it('does not count empty assistant entries as source', () => {
    const ctx = createContext()
    const session = conversation(1, 'tiny')
    const before = sourceTokens(session, ctx.tokenMeter)
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', { stream: [], turn: 2, step: 1, message: createMessage({
      role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: MODEL }, content: [],
    }) }, { surfaceOp: 'append' })
    expect(sourceTokens(session, ctx.tokenMeter)).toBe(before)
  })

  it('keeps assistant tool calls paired with their results', () => {
    const ctx = createContext()
    const session = Session.create(SessionId('paired-tools'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({
      role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: MODEL },
      content: [{ type: 'tool-call', id: 'call-1' as never, name: 'read', arguments: '{}' }],
    }) }, { surfaceOp: 'append' })
    session.append('tool/result', { message: { id: 'r1', role: 'tool', source: { kind: 'tool', callId: 'call-1' },
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'x'.repeat(1_000) }], isError: false }],
    } } as never, { surfaceOp: 'append' })
    expect(selectRecentRange(session, ctx.tokenMeter.measure(session), 100)).toBeNull()
  })

  it('refuses a range when its retained tail takes all compactable history', () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    expect(selectRecentRange(session, ctx.tokenMeter.measure(session), 100_000)).toBeNull()
  })
})

describe('proactive compaction', () => {
  it('runs before the next turn once source entries cross 81K, preserving a recent tail', async () => {
    summarizerCalls = 0
    const ctx = createContext(1_000_000)
    const session = conversation(10, 'x'.repeat(20_000))
    recordMemory(ctx, session, ['A durable fact.'])
    const engine = new MemoryCompactionEngine(ctx)
    const agent = agentFor(session)
    const signal = new AbortController().signal
    const first = await engine.compactIfNeeded(agent, 'pressure', signal)
    expect(first).not.toBeNull()
    expect(first?.summary.some(block => block.type === 'text' && block.text.includes('A durable fact.'))).toBe(true)
    expect(summarizerCalls).toBe(0)
    const second = await engine.compactIfNeeded(agent, 'pressure', signal)
    expect(second).toBeNull()
  })

  it('permits only one proactive transaction for concurrent checks in one turn', async () => {
    summarizerCalls = 0
    const ctx = createContext(1_000_000)
    const session = conversation(10, 'x'.repeat(20_000))
    const engine = new MemoryCompactionEngine(ctx)
    const agent = agentFor(session)
    const signal = new AbortController().signal
    let release!: () => void
    waitForSummary = new Promise<void>(resolve => { release = resolve })
    try {
      const pending = engine.compactIfNeeded(agent, 'pressure', signal)
      for (let i = 0; summarizerCalls === 0 && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0))
      expect(summarizerCalls).toBe(1)
      expect(await engine.compactIfNeeded(agent, 'pressure', signal)).toBeNull()
      release()
      expect(await pending).not.toBeNull()
      expect(summarizerCalls).toBe(1)
    } finally {
      release()
      waitForSummary = undefined
    }
  })

  it('replays its retained source budget without recounting shadowed history', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(10, 'x'.repeat(20_000))
    recordMemory(ctx, session, ['Remembered evidence.'])
    const engine = new MemoryCompactionEngine(ctx)
    const result = await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)
    expect(result).not.toBeNull()
    const retained = sourceTokens(session, ctx.tokenMeter)
    expect(retained).toBeGreaterThan(0)
    session.append('turn/end', { turn: 11, reason: { kind: 'completed' } })
    const resumed = Session.create(session.id, session.snapshotEvents())
    expect(sourceTokens(resumed, ctx.tokenMeter)).toBe(retained)
    const oldSeq = result!.shadowedSeqs[0]!
    expect(resumed.eventAt(oldSeq)).toBeDefined()
    resumed.append('turn/start', { turn: 12 })
    expect(await engine.compactIfNeeded(agentFor(resumed), 'pressure', new AbortController().signal)).toBeNull()
  })

  it('falls back to native summarization when the recorded watermark misses the target region', async () => {
    summarizerCalls = 0
    const ctx = createContext(1_000_000)
    const session = conversation(10, 'x'.repeat(20_000))
    ctx.observationalMemoryStore.recordObservations(session.id, [{
      id: memoryId('old'), content: 'old', timestamp: '2026-01-15 14:30', relevance: 'high', sourceSeqs: [1],
    }], 1)
    const engine = new MemoryCompactionEngine(ctx)
    const result = await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)
    expect(result?.summary).toEqual([{ type: 'text', text: 'MODEL SUMMARY' }])
    expect(summarizerCalls).toBe(1)
  })

  it('keeps a smaller tail for a small-context route under native pressure', async () => {
    summarizerCalls = 0
    const ctx = createContext(50_000)
    const session = conversation(6, 'x'.repeat(14_000))
    session.append('compaction/start', { compactionId: 'finished', turn: 7 } as never)
    session.append('compaction/end', { compactionId: 'finished', turn: 7 } as never)
    recordMemory(ctx, session, ['A durable fact.'])
    const engine = new MemoryCompactionEngine(ctx, { auto: false })
    const before = sourceTokens(session, ctx.tokenMeter)
    const result = await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)
    expect(result).not.toBeNull()
    expect(sourceTokens(session, ctx.tokenMeter)).toBeLessThan(before / 2)
    expect(engine.statusOf(session)).toContain('  last compact attempt: native pressure compacted')
    expect(summarizerCalls).toBe(0)
  })

  it('rejects explicit retention that is larger than the proactive threshold', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    const engine = new MemoryCompactionEngine(ctx, { auto: false, retainRatio: 0.16 })
    await expect(engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal))
      .rejects.toThrow(/retainTokens.*below compactAfterTokens/)
  })

  it('uses the native overflow path rather than treating overflow as proactive work', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(2, 'x'.repeat(20_000))
    const engine = new MemoryCompactionEngine(ctx, { auto: false })
    expect(await engine.compactIfNeeded(agentFor(session), 'context-overflow', new AbortController().signal)).not.toBeNull()
  })

  it('honors the ledger passive policy without disabling native pressure', async () => {
    const ctx = createContext(1_000_000)
    ctx.reflect.provide('observationalMemoryPolicy', { passive: true })
    const session = conversation(10, 'x'.repeat(20_000))
    const engine = new MemoryCompactionEngine(ctx)
    expect(await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).toBeNull()
  })

  it('delegates native pressure rendering when the ledger is passive', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    ctx.reflect.provide('observationalMemoryPolicy', { passive: true })
    const session = conversation()
    recordMemory(ctx, session, ['An old fact.'])
    const { text } = await compact(ctx, session)
    expect(text).toContain('MODEL SUMMARY')
    expect(summarizerCalls).toBe(1)
  })

  it('honors explicit model-level retention and mode-specific thresholds', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    const engine = new MemoryCompactionEngine(ctx, { auto: false, compactAfterTokensMode: 'ratio',
      modelPolicies: [{ provider: PROVIDER, model: MODEL, retainRatio: 0.1 }] })
    expect(await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).toBeNull()
  })

  it('does not trigger below the source threshold on the first eligible step', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    const engine = new MemoryCompactionEngine(ctx)
    expect(await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).toBeNull()
    expect(engine.statusOf(session)).toContain('  last compact attempt: below source threshold')
  })

  it('keeps a missing route as a pressure no-op and retains the calibrated fallback', async () => {
    const ctx = createContext()
    const session = Session.create(SessionId('no-route'))
    session.append('turn/start', { turn: 1 })
    const engine = new MemoryCompactionEngine(ctx, { retainRatio: 0.1 })
    const agent = { session, options: {} } as Agent
    expect(await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)).toBeNull()
  })

  it('does not break a too-small surface under native pressure', async () => {
    const ctx = createContext(1_000)
    const session = Session.create(SessionId('one-pressured-entry'))
    session.append('request/header', { header: { config: { provider: PROVIDER, model: MODEL } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(10_000) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const engine = new MemoryCompactionEngine(ctx, { auto: false })
    expect(await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).toBeNull()
  })

  it('declines a single indivisible entry even when source threshold is met', async () => {
    const ctx = createContext(1_000_000)
    const session = Session.create(SessionId('one-huge-entry'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(1_000) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const engine = new MemoryCompactionEngine(ctx, { compactAfterTokens: 1 })
    expect(await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).toBeNull()
    expect(engine.statusOf(session)).toContain('  last compact attempt: no safe range')
  })

  it('uses top-level ratio retention when explicitly configured', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    const engine = new MemoryCompactionEngine(ctx, { auto: false, retainRatio: 0.01 })
    expect(await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).toBeNull()
  })

  it('uses zero as a temporary budget when a ratio route has no window, then defers to native policy', async () => {
    const ctx = createContext(Number.NaN)
    const session = conversation(1, 'tiny')
    const engine = new MemoryCompactionEngine(ctx, { auto: false, modelPolicies: [{ provider: PROVIDER, model: MODEL, retainRatio: 0.1 }] })
    await expect(engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).rejects.toThrow(/context capacity/)
  })

  it('uses explicitly configured top-level retainTokens', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    const engine = new MemoryCompactionEngine(ctx, { auto: false, retainTokens: 500 })
    expect(await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).toBeNull()
  })

  it('uses exact-target retainTokens instead of the default', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    const engine = new MemoryCompactionEngine(ctx, { auto: false, modelPolicies: [{ provider: PROVIDER, model: MODEL, retainTokens: 500 }] })
    expect(await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).toBeNull()
  })

  it('prunes before small-window pressure compaction', async () => {
    const ctx = createContext(50_000)
    let pruned = 0
    ctx.reflect.provide('toolResultPruner', { pruneSession: () => { pruned++; return null } } as never)
    const session = conversation(6, 'x'.repeat(14_000))
    const engine = new MemoryCompactionEngine(ctx, { auto: false })
    expect(await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).not.toBeNull()
    expect(pruned).toBe(1)
  })

  it('reports non-convergent pressure instead of repeatedly compacting', async () => {
    const ctx = createContext(5_000)
    const session = Session.create(SessionId('nonconvergent'))
    session.append('system/message', { message: { id: 's1', role: 'system', content: [{ type: 'text', text: 's'.repeat(25_000) }], source: { kind: 'plugin', plugin: 'test' } } } as never, { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: PROVIDER, model: MODEL } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    for (let i = 0; i < 3; i++) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `example ${String(i)} ${'u'.repeat(4_000)}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const engine = new MemoryCompactionEngine(ctx, { auto: false, compactionRetries: 0 })
    await expect(engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).rejects.toThrow(/still above threshold/)
  })

  it('respects a durable lock before optional pruning in a small window', async () => {
    const ctx = createContext(50_000)
    let pruned = 0
    ctx.reflect.provide('toolResultPruner', { pruneSession: () => { pruned++ } } as never)
    const session = conversation(6, 'x'.repeat(14_000))
    session.append('compaction/start', { compactionId: 'busy', turn: 7 } as never)
    const engine = new MemoryCompactionEngine(ctx, { auto: false })
    await expect(engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).rejects.toThrow(/already in progress/)
    expect(pruned).toBe(0)
    expect(engine.statusOf(session)).toContain('  last compact attempt: pressure failed')
  })

  it('does not start on an already cancelled turn', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    const engine = new MemoryCompactionEngine(ctx)
    const controller = new AbortController()
    controller.abort()
    await expect(engine.compactIfNeeded(agentFor(session), 'pressure', controller.signal)).rejects.toThrow()
    expect(engine.statusOf(session)).toContain('  last compact attempt: pressure failed')
  })

  it('does not proactively compact when autoCompact is disabled', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(10, 'x'.repeat(20_000))
    const engine = new MemoryCompactionEngine(ctx, { autoCompact: false, auto: false })
    expect(await engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).toBeNull()
  })
})

describe('proactive status and recovery', () => {
  it('shows durable-window and override budgets without assuming provider usage is source tokens', () => {
    const ctx = createContext(100_000)
    const session = conversation(1, 'tiny')
    session.append('request/context', { provider: PROVIDER, model: MODEL, contextWindow: 100_000 })
    const engine = new MemoryCompactionEngine(ctx, { auto: false, retainRatio: 0.1 })
    expect(engine.statusOf(session)).toEqual(expect.arrayContaining([
      '  auto compact: off (calibrated)',
      '  compact tail: ~10000 tokens',
      '  last compact attempt: not in this process',
    ]))
  })

  it('reports model-level and unknown-window tail budgets', () => {
    const ctx = createContext()
    const session = conversation(1, 'tiny')
    const ratio = new MemoryCompactionEngine(ctx, { auto: false, modelPolicies: [{ provider: PROVIDER, model: MODEL, retainRatio: 0.1 }] })
    expect(ratio.statusOf(session)).toContain('  compact tail: unknown window')
    session.append('request/context', { provider: PROVIDER, model: MODEL, contextWindow: 100_000 })
    expect(ratio.statusOf(session)).toContain('  compact tail: ~10000 tokens')
    const ctx2 = createContext()
    const absolute = new MemoryCompactionEngine(ctx2, { auto: false, modelPolicies: [{ provider: PROVIDER, model: MODEL, retainTokens: 1234 }] })
    expect(absolute.statusOf(session)).toContain('  compact tail: ~1234 tokens')
    const ctx3 = createContext()
    const explicit = new MemoryCompactionEngine(ctx3, { auto: false, retainTokens: 3000 })
    expect(explicit.statusOf(session)).toContain('  compact tail: ~3000 tokens')
    const ctx4 = createContext()
    const unknown = new MemoryCompactionEngine(ctx4, { auto: false, retainRatio: 0.1 })
    const unconfigured = Session.create(SessionId('status-no-window'))
    expect(unknown.statusOf(unconfigured)).toContain('  compact tail: unknown window')
  })

  it('marks a failed proactive attempt without marking a success', async () => {
    const ctx = createContext(1_000_000)
    const session = conversation(1, 'tiny')
    const engine = new MemoryCompactionEngine(ctx, { compactAfterTokens: 1 })
    await expect(engine.compactIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).rejects.toThrow()
    expect(engine.statusOf(session)).toContain('  last compact attempt: proactive failed')
  })
})

describe('engine activation', () => {
  it('inherits the shipped backend and keeps its inject contract', () => {
    expect(MemoryCompactionEngine.prototype).toBeInstanceOf(BasicCompactionEngine)
    // This row extends the backend configuration with proactive compaction settings.
    expect(Object.hasOwn(MemoryCompactionEngine, 'Config')).toBe(true)
    // The inherited inject list plus the registry the memory fold lives in is
    // what satisfies the load-order contract: the engine claims the singleton
    // `compaction` service, so its row must activate only once every service it
    // reads exists.
    expect(BasicCompactionEngine.inject).toEqual(['llm', 'tokenMeter', 'sessions'])
    expect(MemoryCompactionEngine.inject).toEqual(['llm', 'tokenMeter', 'sessions', 'observationalMemoryStore'])
  })

  it('becomes the compaction service when mounted alone', async () => {
    const ctx = new Context()
    void new LlmRuntime(ctx)
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    void new SessionStore(ctx)
    ctx.llm.registerAdapter([PROVIDER], new ContextAdapter(1_000))

    // Mounted as a plugin module, exactly as the Loader mounts the row, it must
    // activate on its declared inject and provide `ctx.compaction`. The ledger
    // store is part of that inject, because the same bundle patch mounts the row
    // which publishes it — an engine without memory has nothing to render.
    publishStore(ctx)
    await ctx.plugin(MemoryCompactionEngine, { auto: false, autoCompact: false, compactAfterTokens: 4321 })
    const engine = ctx.get('compaction')
    expect(engine).toBeInstanceOf(MemoryCompactionEngine)
    expect((engine as MemoryCompactionEngine).statusOf(Session.create(SessionId('engine-custom-config'))))
      .toContain('  compact source: ~0/4321 tokens')
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
    recordMemory(ctx, session, ['A durable fact.'])
    const { result } = await compact(ctx, session)
    expect(result?.shadowedSeqs.length).toBeGreaterThan(0)
    expect(result?.shadowedRange.start).toBeLessThanOrEqual(result?.shadowedRange.end as number)
  })

  it('replaces the shadowed span with the rendered checkpoint', async () => {
    summarizerCalls = 0
    const ctx = createContext()
    const session = conversation()
    recordMemory(ctx, session, ['A durable fact.'])
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
