/**
 * Integration coverage of the observational-memory wiring: cadence gating, the
 * background observer pass, its in-flight guard, and the plugin's teardown.
 *
 * These tests drive the real plugin against a real Session and a stub LLM
 * service, so they exercise the parts the unit tests legitimately cannot: when
 * a pass is eligible, what it appends, and that nothing blocks the caller.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import type { Session } from '@deepseek-ai/dsh-session'
import * as ObservationalMemory from '../src/index.ts'
import { sourceEntryAt } from '../src/index.ts'
import { memoryId } from '../src/events.ts'
import { OBSERVER_TOOL_NAME } from '../src/observer.ts'
import { REFLECTOR_TOOL_NAME } from '../src/reflector.ts'
import { DROPPER_TOOL_NAME } from '../src/dropper.ts'
import type { ObservationalMemoryState } from '../src/vocabulary.ts'

const contexts = new Set<Context>()

/** One recorded LLM call, so tests can assert what the observer sent. */
interface Call {
  readonly provider: string
  readonly model: string
  readonly tools: readonly string[]
  readonly system?: string
  readonly signal?: AbortSignal
}

/**
 * A stub LLM service. Each call is answered according to the tool it was
 * offered, so one session can exercise observation, reflection, and dropping in
 * sequence; `script` overrides that default per tool name.
 */
function stubLlm(options: {
  calls: Call[]
  outcome: 'tool-call' | 'no-tool-call' | 'fail' | 'hang'
  observations?: unknown[]
  reflections?: unknown[]
  dropIds?: string[]
  script?: readonly string[]
}): { llm: unknown } {
  let index = 0
  const llm = {
    stream(request: { provider: string; model: string; tools?: readonly { name: string }[]; system?: string; signal?: AbortSignal }) {
      const offered = (request.tools ?? []).map(tool => tool.name)
      options.calls.push({
        provider: request.provider,
        model: request.model,
        tools: offered,
        // `exactOptionalPropertyTypes` forbids an explicit `undefined` here, and
        // an absent route field means "not sent", so omit it instead.
        ...request.system === undefined ? {} : { system: request.system },
        ...request.signal === undefined ? {} : { signal: request.signal },
      })
      const outcome = options.script?.[index++] ?? options.outcome
      const tool = offered[0] ?? OBSERVER_TOOL_NAME
      return (async function* generate() {
        if (outcome === 'hang' || outcome === 'hang-observation') {
          // Block until the caller aborts, so teardown always releases the pass.
          await new Promise<void>(resolve => request.signal?.addEventListener('abort', () => { resolve() }, { once: true }))
          yield { type: 'finish', reason: { kind: 'aborted' } }
          return
        }
        if (outcome === 'fail' || outcome === 'fail-reflection' || outcome === 'fail-drop') {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: `provider down in ${tool}` } } }
          return
        }
        if (outcome === 'no-tool-call' || outcome === 'empty-reflection') {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const payload = tool === REFLECTOR_TOOL_NAME
          ? { reflections: options.reflections ?? [] }
          : tool === DROPPER_TOOL_NAME
            ? { ids: options.dropIds ?? [] }
            : { observations: options.observations ?? [] }
        const args = JSON.stringify(payload)
        yield { type: 'tool-call-delta', index: 0, id: 'c1', name: tool, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: tool, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  return { llm }
}

/** Mount the store, projections, the stub LLM, and the plugin under test. */
async function mount(options: {
  calls: Call[]
  outcome?: 'tool-call' | 'no-tool-call' | 'fail' | 'hang'
  observations?: unknown[]
  reflections?: unknown[]
  dropIds?: string[]
  script?: readonly string[]
  window?: number
  config?: Parameters<typeof ObservationalMemory.apply>[1]
}): Promise<Context> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  // The command registry is mounted so the plugin's `/om` family activates,
  // which is the only part of the plugin that needs it.
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(CommandRuntime)
  // The prompt registry is where the memory context contribution lives, so the
  // plugin's context wiring activates here too.
  await ctx.plugin(SystemPrompt)
  // A stub service under the `llm` key: the plugin only ever calls `stream`.
  ctx.reflect.provide('llm', stubLlm({
    calls: options.calls,
    outcome: options.outcome ?? 'tool-call',
    ...options.observations === undefined ? {} : { observations: options.observations },
    ...options.reflections === undefined ? {} : { reflections: options.reflections },
    ...options.dropIds === undefined ? {} : { dropIds: options.dropIds },
    ...options.script === undefined ? {} : { script: options.script },
  }).llm)
  if (options.window !== undefined) {
    ctx.sessionProjections.register({
      key: 'contextPressure',
      stateVersion: 1,
      stateSchema: { parse: (value: unknown) => value },
      init: () => ({ contextWindow: options.window }),
      apply: (state: unknown) => state,
    } as never)
  }
  // `model` is required on `Config`; spreading a possibly-absent config would
  // otherwise drop it, so carry the route (or an empty one) explicitly.
  await ctx.plugin(ObservationalMemory, {
    ...options.config,
    model: options.config?.model ?? {},
    passive: options.config?.passive ?? false,
  })
  return ctx
}

/**
 * Declare the session's model route, which is where the observer reads it from
 * when no `model` override is configured.
 * @param session - the session to route.
 * @param provider - registered provider route.
 * @param model - provider-owned model id.
 */
function route(session: Session, provider = 'session-provider', model = 'session-model'): void {
  session.append('request/header', {
    header: { config: { provider, model } },
    reason: 'initial',
  } as never)
}

/**
 * Append one user turn's worth of conversation and close the turn.
 * @param session - the session to append to.
 * @param text - the user's message text.
 * @param turn - the turn number.
 * @returns the seq the user message was recorded at, which observers may cite.
 */
function conversation(session: Session, text: string, turn: number): number {
  session.append('turn/start', { turn })
  const message = session.append('user/message', {
    id: `m${String(turn)}` as never,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as never, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return message.seq as number
}

/** Let queued microtasks and the post-commit observer task settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

function memoryOf(ctx: Context, session: Session): ObservationalMemoryState {
  return ctx.sessionProjections.stateOf(session, 'observationalMemory') as ObservationalMemoryState
}

afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const ctx of [...contexts].reverse()) {
    try {
      await ctx.fiber.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  contexts.clear()
  if (failures.length > 0) throw new AggregateError(failures, 'observational-memory wiring cleanup failed')
})

describe('observer wiring', () => {
  it('records observations after a turn once the cadence threshold is met', async () => {
    const calls: Call[] = []
    const observed = 'User switched the API to GraphQL.'
    // The citation must name a seq that exists, so it is filled in once the
    // session has recorded the turn.
    const quote = { seq: 0 }
    const ctx = await mount({
      calls,
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: observed,
        relevance: 'high',
        get sourceSeqs() { return [quote.seq] },
      }],
      config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 },
    })
    const session = ctx.sessions.create(SessionId('observer-records'))
    route(session)
    quote.seq = conversation(session, 'We should switch the API to GraphQL.', 1)
    await settle()

    const state = memoryOf(ctx, session)
    expect(state.observations.map(observation => observation.id)).toEqual([memoryId(observed)])
    expect(state.coverage.observer).toBe(quote.seq)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.tools).toEqual([OBSERVER_TOOL_NAME])
    expect(calls[0]?.system).toContain('observation recorder')
    // The observer uses the session's routed model when no override is configured.
    expect(calls[0]).toMatchObject({ provider: 'session-provider', model: 'session-model' })
  })

  it('does not run before the cadence threshold is reached', async () => {
    const calls: Call[] = []
    const ctx = await mount({
      calls,
      config: { model: {}, observeAfterTokens: 100_000, observeAfterRatio: 0 },
    })
    const session = ctx.sessions.create(SessionId('observer-below-threshold'))
    route(session)
    conversation(session, 'a short turn', 1)
    await settle()
    expect(calls).toHaveLength(0)
    expect(memoryOf(ctx, session).observations).toEqual([])
  })

  it('writes nothing on a deliberately empty pass and stays eligible next turn', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, outcome: 'no-tool-call', config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const session = ctx.sessions.create(SessionId('observer-empty'))
    route(session)
    conversation(session, 'nothing worth keeping here', 1)
    await settle()
    expect(memoryOf(ctx, session).observations).toEqual([])
    // Coverage did not advance, so a later turn observes the same range again.
    expect(memoryOf(ctx, session).coverage.observer).toBeNull()

    conversation(session, 'a much more interesting turn', 2)
    await settle()
    expect(calls).toHaveLength(2)
  })

  it('logs a warning and records nothing when the observer call fails', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, outcome: 'fail', config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('observer-fails'))
    route(session)
    conversation(session, 'a turn whose observer call fails', 1)
    await settle()
    expect(memoryOf(ctx, session).observations).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('observer pass failed'))
  })

  it('uses the configured model override and window-proportional cadence', async () => {
    const calls: Call[] = []
    const ctx = await mount({
      calls,
      window: 1000,
      observations: [{ timestamp: '2026-01-15 14:30', content: 'fact', relevance: 'medium', sourceSeqs: [1] }],
      config: { observeAfterRatio: 0.5, observeAfterTokens: 1_000_000, model: { provider: 'cheap', model: 'small' } },
    })
    const session = ctx.sessions.create(SessionId('observer-window'))
    route(session)
    // 0.5 * 1000 = 500 tokens of window-scaled threshold; a short turn is under it.
    conversation(session, 'too small to trigger', 1)
    await settle()
    expect(calls).toHaveLength(0)

    conversation(session, 'x'.repeat(4000), 2)
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'cheap', model: 'small' })
  })

  it('runs nothing in passive mode', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, passive: true } as never)
    const session = ctx.sessions.create(SessionId('observer-passive'))
    route(session)
    conversation(session, 'passive mode records nothing', 1)
    await settle()
    expect(calls).toHaveLength(0)
  })

  it('never runs two consolidations for one session at the same time', async () => {
    let active = 0
    let peak = 0
    const ctx = await mount({ calls: [], config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const session = ctx.sessions.create(SessionId('observer-overlap'))
    route(session)
    // Instrument the session's own append feed: every consolidation writes
    // through the same session, so overlapping passes would interleave here.
    const original = session.append.bind(session)
    vi.spyOn(session, 'append').mockImplementation(((type: never, data: never, ...rest: never[]) => {
      if (type === 'memory/observations-recorded') {
        active += 1
        peak = Math.max(peak, active)
        active -= 1
      }
      return (original as (t: never, d: never, ...r: never[]) => unknown)(type, data, ...rest)
    }) as typeof session.append)
    conversation(session, 'first turn', 1)
    conversation(session, 'second turn', 2)
    conversation(session, 'third turn', 3)
    await settle()
    expect(peak).toBeLessThanOrEqual(1)
  })

  it('treats a turn closed while a consolidation is running as already covered', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, outcome: 'hang', config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const session = ctx.sessions.create(SessionId('observer-single-flight'))
    route(session)
    conversation(session, 'first turn', 1)
    await settle()
    // The first consolidation is still parked inside its model call.
    expect(calls).toHaveLength(1)
    // Closing another turn must not start a second pass while one is running:
    // the event handler sees the running consolidation and returns immediately.
    session.append('turn/start', { turn: 2 })
    session.append('user/message', {
      id: 'm2', role: 'user', content: [{ type: 'text', text: 'second turn' }], source: { kind: 'user' },
    } as never, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('warns once and records nothing while a session has no routed model', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('observer-no-route'))
    conversation(session, 'a turn with no request header yet', 1)
    await settle()
    expect(calls).toHaveLength(0)
    expect(memoryOf(ctx, session).observations).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no model route'))

    // A later turn does not repeat the warning for the same session.
    conversation(session, 'another turn still without a route', 2)
    await settle()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('warns about rejected records and records only the valid ones', async () => {
    const calls: Call[] = []
    const ctx = await mount({
      calls,
      observations: [
        { timestamp: '2026-01-15 14:30', content: 'invented fact', relevance: 'medium', sourceSeqs: [999] },
      ],
      config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 },
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('observer-rejects'))
    route(session)
    conversation(session, 'a turn whose observation cites a foreign seq', 1)
    await settle()

    expect(memoryOf(ctx, session).observations).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rejected 1 record'))
  })

  it('contains a failure thrown inside the pass instead of leaking it', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('observer-throws'))
    route(session)
    conversation(session, 'a turn', 1)
    // A route lookup that fails stands in for any unexpected error inside the
    // pass: the background task must report it and keep the plugin usable.
    vi.spyOn(session, 'requestHeader').mockImplementation(() => { throw new Error('route lookup exploded') })
    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('memory pass threw: route lookup exploded'))
    expect(calls).toHaveLength(0)
  })

  it('falls back to absolute cadence when the window projection is unusable', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const ctx = await mount({
      calls,
      window: 0,
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: 'fact',
        relevance: 'medium',
        get sourceSeqs() { return [quote.seq] },
      }],
      config: { model: {}, observeAfterRatio: 0.5, observeAfterTokens: 1 },
    })
    const session = ctx.sessions.create(SessionId('observer-bad-window'))
    route(session)
    quote.seq = conversation(session, 'a turn', 1)
    await settle()
    // A zero window is treated as unknown, so the absolute threshold applies.
    expect(memoryOf(ctx, session).observations).toHaveLength(1)
  })

  it('passes the configured generation cap to the worker', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0, workerMaxTokens: 2048 } })
    const session = ctx.sessions.create(SessionId('observer-cap'))
    route(session)
    conversation(session, 'a turn', 1)
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('reports a non-Error throw from the pass', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('observer-throws-nonerror'))
    route(session)
    conversation(session, 'a turn', 1)
    vi.spyOn(session, 'requestHeader').mockImplementation(() => { throw 'plain string failure' })
    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plain string failure'))
  })

  it('ignores an incomplete model override and uses the session route', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const ctx = await mount({
      calls,
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: 'fact',
        relevance: 'medium',
        get sourceSeqs() { return [quote.seq] },
      }],
      // An empty override is not a route.
      config: { observeAfterTokens: 1, observeAfterRatio: 0, model: { provider: '', model: '' } },
    })
    const session = ctx.sessions.create(SessionId('observer-partial-override'))
    route(session)
    quote.seq = conversation(session, 'a turn', 1)
    await settle()
    expect(memoryOf(ctx, session).observations).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'session-provider', model: 'session-model' })
  })

  it('records nothing when the model returns an empty observation list', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, observations: [], config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const session = ctx.sessions.create(SessionId('observer-empty-list'))
    route(session)
    conversation(session, 'a turn with nothing worth recording', 1)
    await settle()
    expect(memoryOf(ctx, session).observations).toEqual([])
    expect(memoryOf(ctx, session).coverage.observer).toBeNull()
  })

  it('passes the reasoning effort through a full model override', async () => {
    const calls: Call[] = []
    const ctx = await mount({
      calls,
      observations: [{ timestamp: '2026-01-15 14:30', content: 'fact', relevance: 'medium', sourceSeqs: [1] }],
      config: { observeAfterTokens: 1, observeAfterRatio: 0, model: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
    })
    const session = ctx.sessions.create(SessionId('observer-effort'))
    route(session)
    conversation(session, 'a turn', 1)
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('selects nothing when coverage already reaches the last source entry', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const session = ctx.sessions.create(SessionId('observer-all-covered'))
    route(session)
    const cited = conversation(session, 'a turn', 1)
    // Coverage reaching the last source entry leaves a range that is due by
    // token count but empty to select, so the pass exits without a model call.
    session.append('memory/observations-recorded', {
      observations: [{
        id: memoryId('already recorded'),
        content: 'already recorded',
        timestamp: '2026-01-15 14:30',
        relevance: 'medium',
        sourceSeqs: [SessionSeq(cited)],
      }],
      coversUpToSeq: SessionSeq(cited),
    })
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await settle()
    expect(memoryOf(ctx, session).coverage.observer).toBe(cited)
    expect(calls).toHaveLength(0)
  })

  it('records a reflection after the reflector becomes due', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const observed = 'The build must ship by January 22nd.'
    const reflected = 'There is a hard ship date.'
    const ctx = await mount({
      calls,
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: observed,
        relevance: 'critical',
        get sourceSeqs() { return [quote.seq] },
      }],
      reflections: [{ content: reflected, supportingObservationIds: [memoryId(observed)] }],
      config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0, reflectAfterTokens: 1, reflectAfterRatio: 0 },
    })
    const session = ctx.sessions.create(SessionId('reflector-records'))
    route(session)
    quote.seq = conversation(session, 'We have a hard deadline.', 1)
    await settle()

    const state = memoryOf(ctx, session)
    expect(state.observations.map(observation => observation.id)).toEqual([memoryId(observed)])
    expect(state.reflections.map(reflection => reflection.id)).toEqual([memoryId(reflected)])
    expect(calls.map(call => call.tools[0])).toEqual([OBSERVER_TOOL_NAME, REFLECTOR_TOOL_NAME])
  })

  it('tombstones observations once the reflector has recorded something', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const observed = 'A routine progress note.'
    const ctx = await mount({
      calls,
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: observed,
        relevance: 'low',
        get sourceSeqs() { return [quote.seq] },
      }],
      reflections: [{ content: 'The work is progressing.', supportingObservationIds: [memoryId(observed)] }],
      dropIds: [memoryId(observed)],
      config: {
        model: {},
        observeAfterTokens: 1,
        observeAfterRatio: 0,
        reflectAfterTokens: 1,
        reflectAfterRatio: 0,
        // A one-token target puts any active observation over budget.
        observationsPoolMaxTokens: 2,
        observationsPoolTargetTokens: 1,
      },
    })
    const session = ctx.sessions.create(SessionId('dropper-tombstones'))
    route(session)
    quote.seq = conversation(session, 'Some progress was made.', 1)
    await settle()

    const state = memoryOf(ctx, session)
    expect(state.observations).toEqual([])
    expect(state.dropped.map(record => record.id)).toEqual([memoryId(observed)])
    // The drop never erases history: the reflection still cites the record.
    expect(state.reflections.map(reflection => reflection.id)).toEqual([memoryId('The work is progressing.')])
    expect(calls.map(call => call.tools[0])).toEqual([OBSERVER_TOOL_NAME, REFLECTOR_TOOL_NAME, DROPPER_TOOL_NAME])
  })

  it('skips the dropper when the reflector records nothing', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const observed = 'A fact nothing reflects on.'
    const ctx = await mount({
      calls,
      script: ['tool-call', 'empty-reflection'],
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: observed,
        relevance: 'low',
        get sourceSeqs() { return [quote.seq] },
      }],
      dropIds: [memoryId(observed)],
      config: {
        model: {},
        observeAfterTokens: 1,
        observeAfterRatio: 0,
        reflectAfterTokens: 1,
        reflectAfterRatio: 0,
        observationsPoolMaxTokens: 2,
        observationsPoolTargetTokens: 1,
      },
    })
    const session = ctx.sessions.create(SessionId('dropper-after-empty-reflection'))
    route(session)
    quote.seq = conversation(session, 'A turn.', 1)
    await settle()

    // No fresh reflection means no new evidence, so nothing may be dropped.
    expect(memoryOf(ctx, session).observations.map(record => record.id)).toEqual([memoryId(observed)])
    expect(calls.map(call => call.tools[0])).toEqual([OBSERVER_TOOL_NAME, REFLECTOR_TOOL_NAME])
  })

  it('warns and keeps memory when the reflector or dropper call fails', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const observed = 'A fact whose reflection pass fails.'
    const ctx = await mount({
      calls,
      script: ['tool-call', 'fail-reflection'],
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: observed,
        relevance: 'low',
        get sourceSeqs() { return [quote.seq] },
      }],
      config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0, reflectAfterTokens: 1, reflectAfterRatio: 0 },
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('reflector-fails'))
    route(session)
    quote.seq = conversation(session, 'A turn.', 1)
    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reflector pass failed'))
    expect(memoryOf(ctx, session).reflections).toEqual([])
  })

  it('warns when the dropper call fails and keeps the pool intact', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const observed = 'A fact the dropper could not judge.'
    const ctx = await mount({
      calls,
      script: ['tool-call', 'tool-call', 'fail-drop'],
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: observed,
        relevance: 'low',
        get sourceSeqs() { return [quote.seq] },
      }],
      reflections: [{ content: 'The work is progressing.', supportingObservationIds: [memoryId(observed)] }],
      config: {
        model: {},
        observeAfterTokens: 1,
        observeAfterRatio: 0,
        reflectAfterTokens: 1,
        reflectAfterRatio: 0,
        observationsPoolMaxTokens: 2,
        observationsPoolTargetTokens: 1,
      },
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('dropper-fails'))
    route(session)
    quote.seq = conversation(session, 'A turn.', 1)
    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropper pass failed'))
    // A failed drop leaves active memory exactly as it was.
    expect(memoryOf(ctx, session).observations.map(record => record.id)).toEqual([memoryId(observed)])
  })

  it('writes nothing when the dropper chooses to keep everything', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const observed = 'A fact worth keeping.'
    const ctx = await mount({
      calls,
      script: ['tool-call', 'tool-call', 'tool-call'],
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: observed,
        relevance: 'critical',
        get sourceSeqs() { return [quote.seq] },
      }],
      reflections: [{ content: 'The work is progressing.', supportingObservationIds: [memoryId(observed)] }],
      // An empty selection is a valid answer, not a no-op failure.
      dropIds: [],
      config: {
        model: {},
        observeAfterTokens: 1,
        observeAfterRatio: 0,
        reflectAfterTokens: 1,
        reflectAfterRatio: 0,
        observationsPoolMaxTokens: 2,
        observationsPoolTargetTokens: 1,
      },
    })
    const session = ctx.sessions.create(SessionId('dropper-keeps-all'))
    route(session)
    quote.seq = conversation(session, 'A turn.', 1)
    await settle()
    expect(calls.map(call => call.tools[0])).toEqual([OBSERVER_TOOL_NAME, REFLECTOR_TOOL_NAME, DROPPER_TOOL_NAME])
    const state = memoryOf(ctx, session)
    expect(state.observations.map(record => record.id)).toEqual([memoryId(observed)])
    expect(state.dropped).toEqual([])
  })

  it('passes the generation cap to every worker when one is configured', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const observed = 'A fact.'
    const ctx = await mount({
      calls,
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: observed,
        relevance: 'medium',
        get sourceSeqs() { return [quote.seq] },
      }],
      reflections: [{ content: 'A durable fact.', supportingObservationIds: [memoryId(observed)] }],
      config: {
        model: {},
        observeAfterTokens: 1,
        observeAfterRatio: 0,
        reflectAfterTokens: 1,
        reflectAfterRatio: 0,
        workerMaxTokens: 512,
      },
    })
    const session = ctx.sessions.create(SessionId('worker-cap'))
    route(session)
    quote.seq = conversation(session, 'A turn.', 1)
    await settle()
    expect(calls.map(call => call.tools[0])).toEqual([OBSERVER_TOOL_NAME, REFLECTOR_TOOL_NAME])
  })

  it('passes the generation cap to the dropper as well', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const observed = 'A fact to prune.'
    const ctx = await mount({
      calls,
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: observed,
        relevance: 'low',
        get sourceSeqs() { return [quote.seq] },
      }],
      reflections: [{ content: 'A durable fact.', supportingObservationIds: [memoryId(observed)] }],
      dropIds: [memoryId(observed)],
      config: {
        model: {},
        observeAfterTokens: 1,
        observeAfterRatio: 0,
        reflectAfterTokens: 1,
        reflectAfterRatio: 0,
        observationsPoolMaxTokens: 2,
        observationsPoolTargetTokens: 1,
        workerMaxTokens: 512,
      },
    })
    const session = ctx.sessions.create(SessionId('dropper-cap'))
    route(session)
    quote.seq = conversation(session, 'A turn.', 1)
    await settle()
    expect(calls.map(call => call.tools[0])).toEqual([OBSERVER_TOOL_NAME, REFLECTOR_TOOL_NAME, DROPPER_TOOL_NAME])
  })

  it('does not reflect before any observation exists', async () => {
    const calls: Call[] = []
    const ctx = await mount({
      calls,
      // The harness answers `no-tool-call` with a clean finish and no tool call,
      // which the observer records as a deliberate empty pass: no observations.
      outcome: 'no-tool-call',
      config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0, reflectAfterTokens: 1, reflectAfterRatio: 0 },
    })
    const session = ctx.sessions.create(SessionId('reflector-without-observations'))
    route(session)
    conversation(session, 'A turn worth nothing.', 1)
    await settle()
    // Only the observer ran; with no active observation there is nothing to reflect on.
    expect(calls.map(call => call.tools[0])).toEqual([OBSERVER_TOOL_NAME])
  })

  it('registers the /om family and answers status through it', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const ctx = await mount({
      calls,
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: 'A recorded fact.',
        relevance: 'high',
        get sourceSeqs() { return [quote.seq] },
      }],
      config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 },
    })
    const session = ctx.sessions.create(SessionId('om-wired'))
    route(session)
    quote.seq = conversation(session, 'A turn.', 1)
    await settle()

    const execution = await ctx.commands.execute(
      { id: session.id, session } as never,
      '/om status',
      [],
      new AbortController().signal,
    )
    // `/om` is registered, so a `undefined` here would be a registration miss.
    expect(execution).toBeDefined()
    expect(execution!.result.kind).toBe('success')
    const text = execution!.result.kind === 'success' ? execution!.result.text ?? '' : ''
    expect(text).toContain('active observations: 1')
    expect(text).toContain('observer coverage')
  })

  it('resolves a cited source from the observer fold, and nothing for an unknown seq', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const session = ctx.sessions.create(SessionId('source-entry'))
    route(session)
    const cited = conversation(session, 'the exact wording', 1)
    await settle()
    expect(sourceEntryAt(ctx, session, cited)).toEqual({ role: 'user', text: 'the exact wording' })
    // A seq the fold does not hold reports nothing rather than a blank entry.
    expect(sourceEntryAt(ctx, session, 9999)).toBeUndefined()
  })

  it('serves /om show through the plugin, including its source lines', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const ctx = await mount({
      calls,
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: 'A recorded fact.',
        relevance: 'high',
        get sourceSeqs() { return [quote.seq] },
      }],
      config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 },
    })
    const session = ctx.sessions.create(SessionId('om-show'))
    route(session)
    quote.seq = conversation(session, 'the exact wording', 1)
    await settle()

    const execution = await ctx.commands.execute(
      { id: session.id, session } as never,
      `/om show ${memoryId('A recorded fact.')}`,
      [],
      new AbortController().signal,
    )
    // The command is registered by the plugin, so resolving must not miss.
    expect(execution).toBeDefined()
    const text = execution!.result.kind === 'success' ? execution!.result.text ?? '' : ''
    expect(text).toContain('A recorded fact.')
    expect(text).toContain('Sources:')
    expect(text).toContain(`#${String(quote.seq)} user: the exact wording`)
  })

  it('offers the recorded memory to the next request through the prompt assembly', async () => {
    const calls: Call[] = []
    const quote = { seq: 0 }
    const ctx = await mount({
      calls,
      observations: [{
        timestamp: '2026-01-15 14:30',
        content: 'User switched the API to GraphQL.',
        relevance: 'high',
        get sourceSeqs() { return [quote.seq] },
      }],
      config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 },
    })
    const session = ctx.sessions.create(SessionId('context-wired'))
    route(session)
    quote.seq = conversation(session, 'We should move to GraphQL.', 1)
    await settle()

    // This is the whole point of the contribution: what the model reads about
    // earlier work now tracks the ledger, not only the last compaction.
    // Give the injected fiber a turn to activate before assembling.
    await new Promise(resolve => setTimeout(resolve, 0))
    const assembly = await ctx.systemPrompt.assemble({ agent: { session } } as never)
    const names = assembly.contexts.map(context => context.name)
    expect(names).toContain('observational-memory')
    const memory = assembly.contexts.find(context => context.name === 'observational-memory')
    expect(memory?.text).toContain('User switched the API to GraphQL.')
    expect(memory?.text).toContain('## Observations')
  })

  it('aborts in-flight work when the plugin unloads', async () => {
    const calls: Call[] = []
    const ctx = await mount({ calls, outcome: 'hang', config: { model: {}, observeAfterTokens: 1, observeAfterRatio: 0 } })
    const session = ctx.sessions.create(SessionId('observer-teardown'))
    route(session)
    conversation(session, 'a turn that hangs the observer', 1)
    await settle()
    const signal = calls[0]?.signal
    expect(signal?.aborted).toBe(false)
    await ctx.fiber.dispose()
    contexts.delete(ctx)
    expect(signal?.aborted).toBe(true)
  })
})
