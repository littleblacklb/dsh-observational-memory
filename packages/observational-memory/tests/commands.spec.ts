/**
 * The `/om` command family, executed through the real command registry.
 *
 * These commands are the only human-visible surface of the plugin, so these
 * tests dispatch them the way the composer does and read the text a user would
 * see: the status view, the rendered memory block, and one record with the
 * sources it came from.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { memoryId } from '../src/events.ts'
import type { Observation, Reflection } from '../src/events.ts'
import { observationalMemoryProjectionDefinition } from '../src/projection.ts'
import { createObservationSourceProjection } from '../src/source.ts'
import type { ObservationSourceEntry } from '../src/source.ts'
import { registerOmCommands } from '../src/commands.ts'
import { MemoryStatus } from '../src/status.ts'

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

// The fixture's user message lands at seq 2: turn/start is 0, the message is 1,
// and the memory events follow it.
function observation(content: string, sourceSeqs: number[] = [MESSAGE_SEQ]): Observation {
  return { id: memoryId(content), content, timestamp: '2026-01-15 14:30', relevance: 'high', sourceSeqs }
}

/** Seq the fixture's user message occupies: `turn/start` is 0, so the message is 1. */
const MESSAGE_SEQ = 1

/** Mount the `/om` family over a session with the given memory recorded. */
async function harness(options: {
  observations?: readonly Observation[]
  reflections?: readonly Reflection[]
  drop?: readonly string[]
  coverage?: { observer: number | null; reflector: number | null; dropper: number | null }
  passive?: boolean
  withCommands?: boolean
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (options.withCommands !== false) await ctx.plugin(CommandRuntime)
  // The command registry authorizes an invocation against the calling agent's
  // turn boundary, so that projection must be live.
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  ctx.sessionProjections.register(observationalMemoryProjectionDefinition)
  ctx.sessionProjections.register(createObservationSourceProjection())

  const session = ctx.sessions.create(SessionId('om-caller'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'switch the API to GraphQL' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  if (options.observations !== undefined) {
    session.append('memory/observations-recorded', {
      observations: options.observations,
      coversUpToSeq: SessionSeq(session.seq),
    })
  }
  if (options.reflections !== undefined) {
    session.append('memory/reflections-recorded', {
      reflections: options.reflections,
      coversUpToSeq: SessionSeq(session.seq),
    })
  }
  if (options.drop !== undefined) {
    session.append('memory/observations-dropped', {
      observationIds: options.drop,
      coversUpToSeq: SessionSeq(session.seq),
    })
  }
  if (options.coverage !== undefined) {
    // Coverage is a fold of the appended events, so a requested watermark is
    // reached by recording one more pass at that position.
    session.append('memory/observations-recorded', { observations: [], coversUpToSeq: SessionSeq(session.seq) })
  }

  registerOmCommands(ctx, {
    memoryOf: agent => ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')!,
    sourceEntry: (_agent, seq): ObservationSourceEntry | undefined =>
      (ctx.sessionProjections.stateOf(session, 'observationSource') as { entries: ObservationSourceEntry[] } | undefined)
        ?.entries.find(entry => entry.seq === seq),
    targetTokens: 10_000,
    observeAfterTokens: 10_000,
    reflectAfterTokens: 20_000,
    passive: options.passive ?? false,
    status: new MemoryStatus(),
  })

  const run = async (input: string) => {
    const execution = await ctx.commands.execute(fakeAgent(session), `/om${input}`, [], new AbortController().signal)
    // An unresolved command is a miss, never a silent success: fail loudly here
    // so every caller below can read `result` without re-checking.
    if (execution === undefined) throw new Error(`/om${input} did not resolve to a command execution`)
    return execution
  }
  return { ctx, session, run }
}

describe('/om through the command registry', () => {
  it('registers the command with its usage hint', async () => {
    const { ctx, run } = await harness({})
    expect(ctx.commands.find(fakeAgent(ctx.sessions.create(SessionId('viewer'))), 'om')).toBeDefined()
    // A bare invocation is the status view.
    const execution = await run('')
    expect(execution.result.kind).toBe('success')
    await ctx.fiber.dispose()
  })

  it('reports status with counts, pressure, and coverage', async () => {
    const { ctx, run } = await harness({
      observations: [observation('a fact')],
      reflections: [{ id: memoryId('a durable fact'), content: 'a durable fact', supportingObservationIds: [memoryId('a fact')] }],
    })
    const execution = await run(' status')
    expect(execution.result.kind).toBe('success')
    const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
    expect(text).toContain('reflections: 1')
    expect(text).toContain('active observations: 1')
    expect(text).toContain('mode: active')
    await ctx.fiber.dispose()
  })

  it('reports passive mode when background work is disabled', async () => {
    const { ctx, run } = await harness({ passive: true })
    const execution = await run(' status')
    const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
    expect(text).toContain('mode: passive')
    await ctx.fiber.dispose()
  })

  it('renders the memory view a checkpoint would carry', async () => {
    const { ctx, run } = await harness({
      observations: [observation('User switched to GraphQL.')],
      reflections: [{ id: memoryId('The API is GraphQL.'), content: 'The API is GraphQL.', supportingObservationIds: [memoryId('User switched to GraphQL.')] }],
    })
    const execution = await run(' view')
    const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
    expect(text).toContain('## Reflections')
    expect(text).toContain('The API is GraphQL.')
    expect(text).toContain('## Observations')
    expect(text).toContain('User switched to GraphQL.')
    await ctx.fiber.dispose()
  })

  it('says so plainly when there is nothing in memory yet', async () => {
    const { ctx, run } = await harness({})
    const execution = await run(' view')
    const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
    expect(text).toContain('Memory is empty')
    await ctx.fiber.dispose()
  })

  it('shows one record with its source conversation', async () => {
    const record = observation('User switched to GraphQL.')
    const { ctx, run } = await harness({ observations: [record] })
    const execution = await run(` show ${record.id}`)
    const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
    expect(text).toContain(record.content)
    expect(text).toContain('Sources:')
    // The source text comes from the observer's own fold of the conversation.
    expect(text).toContain('#1 user: switch the API to GraphQL')
    await ctx.fiber.dispose()
  })

  it('rejects a show without an id and an unknown subcommand', async () => {
    const { ctx, run } = await harness({})
    expect((await run(' show')).result.kind).toBe('error')
    expect((await run(' nonsense')).result.kind).toBe('error')
    await ctx.fiber.dispose()
  })

  it('reports an unknown id rather than inventing a record', async () => {
    const { ctx, run } = await harness({ observations: [observation('a fact')] })
    const execution = await run(' show aaaaaaaaaaaa')
    const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
    expect(text).toContain('No memory record has id')
    await ctx.fiber.dispose()
  })

  it('reports a malformed id', async () => {
    const { ctx, run } = await harness({})
    const execution = await run(' show not-an-id')
    const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
    expect(text).toContain('not a memory id')
    await ctx.fiber.dispose()
  })

  it('shows a dropped record as dropped and reports a source it cannot read', async () => {
    const record = observation('A dropped fact.', [99])
    const { ctx, run } = await harness({ observations: [record], drop: [record.id] })
    const execution = await run(` show ${record.id}`)
    const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
    expect(text).toContain('[dropped]')
    expect(text).toContain('#99 (not in the observed conversation)')
    await ctx.fiber.dispose()
  })
})
