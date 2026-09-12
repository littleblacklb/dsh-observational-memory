/**
 * The model-visible memory block and the worker status counters.
 *
 * The context contribution is what keeps the model's picture of earlier work
 * tracking the ledger between compactions, and its deduplication depends on the
 * text being a pure function of folded memory. The status counters exist to tell
 * "no worker has run yet" apart from "the worker keeps failing", which an empty
 * memory cannot express on its own.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { memoryId } from '../src/model.ts'
import type { Observation, Reflection } from '../src/vocabulary.ts'
import { publishStore } from './store-fixture.ts'
import {
  MEMORY_CONTEXT_NAME,
  MEMORY_CONTEXT_ORDER,
  registerMemoryContext,
  renderMemoryContext,
} from '../src/context.ts'
import { MemoryStatus, renderWorkerStatus } from '../src/status.ts'

function observation(content: string): Observation {
  return { id: memoryId(content), content, timestamp: '2026-01-15 14:30', relevance: 'high', sourceSeqs: [1] }
}

function reflection(content: string, support: string[]): Reflection {
  return { id: memoryId(content), content, supportingObservationIds: support }
}

/** Mount the prompt registry and a ledger store, with optional seeded memory. */
async function harness(record?: { observations: Observation[]; reflections: Reflection[] }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  const store = publishStore(ctx)
  const session = ctx.sessions.create(SessionId('context-caller'))
  if (record !== undefined) {
    store.recordObservations(session.id, record.observations, session.seq)
    if (record.reflections.length > 0) {
      store.recordReflections(session.id, record.reflections, session.seq)
    }
  }
  return { ctx, session, store, agent: { session } as unknown as Agent }
}

describe('memory context contribution', () => {
  it('renders nothing without an agent, and nothing when memory is empty', async () => {
    const { ctx, agent } = await harness()
    expect(renderMemoryContext(ctx, undefined)).toBe('')
    expect(renderMemoryContext(ctx, agent)).toBe('')
    await ctx.fiber.dispose()
  })

  it('renders the folded memory as a checkpoint would carry it', async () => {
    const record = observation('User switched to GraphQL.')
    const { ctx, agent } = await harness({
      observations: [record],
      reflections: [reflection('The API is GraphQL.', [record.id])],
    })
    const text = renderMemoryContext(ctx, agent)
    expect(text).toContain('## Reflections')
    expect(text).toContain('The API is GraphQL.')
    expect(text).toContain('## Observations')
    expect(text).toContain('User switched to GraphQL.')
    await ctx.fiber.dispose()
  })

  it('is byte-identical across calls while memory is unchanged', async () => {
    const { ctx, agent } = await harness({ observations: [observation('a fact')], reflections: [] })
    // Deduplication is by exact text, so an unchanged fold must not perturb it.
    expect(renderMemoryContext(ctx, agent)).toBe(renderMemoryContext(ctx, agent))
    await ctx.fiber.dispose()
  })

  it('changes once memory grows, so the model sees the new record', async () => {
    const { ctx, session, store, agent } = await harness({ observations: [observation('first fact')], reflections: [] })
    const before = renderMemoryContext(ctx, agent)
    // The watermark is what makes a pass new: recording again at the position
    // the harness already covered is a repeat, and repeats are deliberately
    // no-ops so a retried pass cannot double-apply.
    store.recordObservations(session.id, [observation('second fact')], session.seq + 1)
    const after = renderMemoryContext(ctx, agent)
    expect(after).not.toBe(before)
    expect(after).toContain('second fact')
    await ctx.fiber.dispose()
  })

  it('registers a named contribution the assembly includes', async () => {
    const { ctx, agent } = await harness({ observations: [observation('a fact')], reflections: [] })
    registerMemoryContext(ctx)
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent } as never)
    const sections = assembly.contexts.map(context => context.name)
    expect(sections).toContain(MEMORY_CONTEXT_NAME)
    expect(MEMORY_CONTEXT_ORDER).toBeGreaterThan(0)
    await ctx.fiber.dispose()
  })

  it('contributes nothing to an assembly when the session has no memory', async () => {
    const { ctx, agent } = await harness()
    registerMemoryContext(ctx)
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent } as never)
    const rendered = assembly.contexts.find(context => context.name === MEMORY_CONTEXT_NAME)
    // Registered but empty: the loop drops empty contexts rather than logging a
    // snapshot with nothing in it.
    expect(rendered?.text ?? '').toBe('')
    await ctx.fiber.dispose()
  })
})

describe('worker status', () => {
  it('starts every worker at zero', () => {
    const snapshot = new MemoryStatus().snapshot()
    expect(snapshot.observer).toEqual({ recorded: 0, empty: 0, failed: 0, rejected: 0 })
    expect(snapshot.lastRunMs).toBeUndefined()
  })

  it('separates a recording pass from a deliberately empty one', () => {
    const status = new MemoryStatus()
    status.record('observer', { recorded: 2, rejected: 0 })
    status.record('observer', { recorded: 0, rejected: 0 })
    expect(status.snapshot().observer).toMatchObject({ recorded: 1, empty: 1 })
  })

  it('counts rejected records alongside the pass that produced them', () => {
    const status = new MemoryStatus()
    status.record('reflector', { recorded: 1, rejected: 3 })
    expect(status.snapshot().reflector).toMatchObject({ recorded: 1, rejected: 3 })
  })

  it('keeps the last failure so an empty memory can be told from a broken worker', () => {
    const status = new MemoryStatus()
    status.record('dropper', { failed: 'provider down' })
    status.record('dropper', { recorded: 1, rejected: 0 })
    const snapshot = status.snapshot()
    expect(snapshot.dropper).toMatchObject({ failed: 1, recorded: 1, lastError: 'provider down' })
  })

  it('records the last consolidation duration', () => {
    const status = new MemoryStatus()
    status.finishRun(42)
    expect(status.snapshot().lastRunMs).toBe(42)
  })

  it('renders one line per worker, adding failures and the last run', () => {
    const status = new MemoryStatus()
    status.record('observer', { recorded: 1, rejected: 0 })
    status.record('reflector', { failed: 'rate limited' })
    status.finishRun(7)
    const lines = renderWorkerStatus(status.snapshot())
    expect(lines).toContain('  observer: 1 recorded, 0 empty')
    expect(lines.some(line => line.includes('reflector: 0 recorded, 0 empty, 1 failed'))).toBe(true)
    expect(lines).toContain('  last consolidation: 7ms')
    expect(lines).toContain('  reflector error: rate limited')
  })

  it('reports a rejection count without a failure', () => {
    const status = new MemoryStatus()
    status.record('observer', { recorded: 1, rejected: 2 })
    expect(renderWorkerStatus(status.snapshot())).toContain('  observer: 1 recorded, 0 empty, 2 rejected')
  })

  it('omits the rejection and failure suffixes when there are none', () => {
    const lines = renderWorkerStatus(new MemoryStatus().snapshot())
    expect(lines.every(line => !line.includes('rejected'))).toBe(true)
    expect(lines.every(line => !line.includes('failed'))).toBe(true)
    expect(lines.some(line => line.includes('last consolidation'))).toBe(false)
  })
})
