/**
 * Durable-vocabulary gate for the `memory/*` events.
 *
 * These tests exist to prove the single fact the whole memory design rests on:
 * a `memory/*` event appended to a session survives a persistence round trip
 * and is read back by a fresh harness context. Because `Session.append` cannot
 * mark an event ignorable, the persistence read path refuses any event type
 * outside the repository-generated vocabulary — so if the declarations in
 * `src/events.ts` ever stop reaching `KNOWN_SESSION_EVENT_TYPES`, the session
 * becomes unreadable and these tests fail loudly instead of silently losing
 * memory on the next resume.
 */

import { rm } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as ObservationalMemory from '../src/index.ts'
import { memoryId } from '../src/events.ts'

const roots: string[] = []
const contexts = new Set<Context>()

function root(): string {
  const created = mkdtempSync(join(tmpdir(), 'dsh-observational-memory-'))
  roots.push(created)
  return created
}

/** Mount the session store, projection registry, persistence backend, and the plugin under test. */
async function mount(store: string): Promise<Context> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: store, compression: 'none' })
  await ctx.plugin(ObservationalMemory)
  return ctx
}

/**
 * Create one durable session the way the agent loop does: the header is
 * materialized into storage first, then the live session is constructed from
 * the same header and entered. Persistence routes live writes only for ids
 * holding an open write handle, so a session created without one never
 * reaches storage.
 * @param ctx - context carrying the store and persistence backend.
 * @param id - session id to persist and create.
 * @returns the live session plus its write handle.
 */
async function owned(ctx: Context, id: SessionId) {
  const prepared = ctx.sessions.prepare(id)
  const handle = await ctx.sessionPersistence.create(prepared.header)
  ctx.sessions.enter(prepared)
  ctx.sessions.announce(prepared)
  return { session: prepared, handle }
}

/** Read one stored session's events through a short-lived read handle. */
async function storedEvents(ctx: Context, id: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of [...contexts].reverse()) {
    try {
      await ctx.fiber.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  contexts.clear()
  for (const store of roots.splice(0)) {
    try {
      await rm(store, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'observational-memory cleanup failed')
})

describe('memory event vocabulary', () => {
  it('round-trips every memory event type through persistence and a fresh context', async () => {
    const store = root()
    const id = SessionId('memory-roundtrip')

    const first = await mount(store)
    const { session, handle } = await owned(first, id)
    const content = 'User decided to switch from REST to GraphQL for the public API.'
    session.append('memory/observations-recorded', {
      observations: [{
        id: memoryId(content),
        content,
        timestamp: '2026-01-15 14:30',
        relevance: 'high',
        sourceSeqs: [SessionSeq(0)],
      }],
      coversUpToSeq: SessionSeq(0),
    })
    session.append('memory/reflections-recorded', {
      reflections: [{
        id: memoryId('The public API is GraphQL.'),
        content: 'The public API is GraphQL.',
        supportingObservationIds: [memoryId(content)],
      }],
      coversUpToSeq: SessionSeq(0),
    })
    session.append('memory/observations-dropped', {
      observationIds: [memoryId(content)],
      coversUpToSeq: SessionSeq(0),
    })
    await first.sessions.flush(session)
    await handle.close()
    await first.fiber.dispose()
    contexts.delete(first)

    // A fresh context over the same store stands in for a restart, resume, or
    // reload — the case where an undeclared event type would refuse the log.
    const second = await mount(store)
    const events = await storedEvents(second, id)
    const memoryEvents = events.filter(event => event.type.startsWith('memory/'))
    expect(memoryEvents.map(event => event.type)).toEqual([
      'memory/observations-recorded',
      'memory/reflections-recorded',
      'memory/observations-dropped',
    ])
    expect(memoryEvents[0]?.data).toMatchObject({
      coversUpToSeq: 0,
      observations: [{ id: memoryId(content), relevance: 'high' }],
    })
    expect(memoryEvents[2]?.data).toMatchObject({ observationIds: [memoryId(content)] })
  })

  it('folds every memory event type when a fresh context replays the stored log', async () => {    const store = root()
    const id = SessionId('memory-replay')
    const content = 'Hard constraint: ship by January 22nd.'
    const reflectionContent = 'The project has a hard ship date.'

    const first = await mount(store)
    const { session, handle } = await owned(first, id)
    session.append('memory/observations-recorded', {
      observations: [{
        id: memoryId(content),
        content,
        timestamp: '2026-01-15 14:30',
        relevance: 'critical',
        sourceSeqs: [SessionSeq(0)],
      }],
      coversUpToSeq: SessionSeq(0),
    })
    session.append('memory/reflections-recorded', {
      reflections: [{
        id: memoryId(reflectionContent),
        content: reflectionContent,
        supportingObservationIds: [memoryId(content)],
      }],
      coversUpToSeq: SessionSeq(0),
    })
    await first.sessions.flush(session)
    await handle.close()
    await first.fiber.dispose()
    contexts.delete(first)

    // A fresh context over the same store is the restart case: the durable read
    // must hand back both memory events with their payloads intact, which is
    // what lets a resumed session continue observing from where it left off.
    const second = await mount(store)
    const reopened = await second.sessionPersistence.open(id, 'read')
    const read = await reopened.read()
    await reopened.close()
    const memoryEvents = read.events.filter(event => event.type.startsWith('memory/'))
    expect(memoryEvents.map(event => event.type)).toEqual([
      'memory/observations-recorded',
      'memory/reflections-recorded',
    ])
    expect(memoryEvents[0]?.data).toMatchObject({
      coversUpToSeq: 0,
      observations: [{ id: memoryId(content), content, relevance: 'critical' }],
    })
    expect(memoryEvents[1]?.data).toMatchObject({
      reflections: [{ id: memoryId(reflectionContent), supportingObservationIds: [memoryId(content)] }],
    })

    // Resuming for further work re-opens the same log for writing.
    const writeBack = await second.sessionPersistence.open(id, 'write')
    await writeBack.close()
  })

  it('folds appended memory into the projection a fresh context reads', async () => {
    const store = root()
    const id = SessionId('memory-projection')
    const ctx = await mount(store)
    const session = ctx.sessions.create(id)
    const kept = 'Build must ship by January 22nd.'
    const removed = 'Routine status update.'
    session.append('memory/observations-recorded', {
      observations: [
        { id: memoryId(kept), content: kept, timestamp: '2026-01-15 14:30', relevance: 'critical', sourceSeqs: [SessionSeq(0)] },
        { id: memoryId(removed), content: removed, timestamp: '2026-01-15 14:31', relevance: 'low', sourceSeqs: [SessionSeq(0)] },
      ],
      coversUpToSeq: SessionSeq(0),
    })

    const recorded = ctx.sessionProjections.stateOf(session, 'observationalMemory')
    expect(recorded?.observations.map(record => record.id)).toEqual([memoryId(kept), memoryId(removed)])
    expect(recorded?.coverage.observer).toBe(0)

    session.append('memory/observations-dropped', {
      observationIds: [memoryId(removed)],
      coversUpToSeq: SessionSeq(0),
    })

    const afterDrop = ctx.sessionProjections.stateOf(session, 'observationalMemory')
    expect(afterDrop?.observations.map(record => record.id)).toEqual([memoryId(kept)])
    // A tombstone never erases history: recall still resolves dropped records.
    expect(afterDrop?.dropped.map(record => record.id)).toEqual([memoryId(removed)])
  })

  it('collapses content-addressed duplicates and never resurrects a tombstone', async () => {
    const store = root()
    const id = SessionId('memory-duplicates')
    const ctx = await mount(store)
    const session = ctx.sessions.create(id)
    const repeated = 'The project uses GraphQL.'
    const record = {
      id: memoryId(repeated),
      content: repeated,
      timestamp: '2026-01-15 14:30',
      relevance: 'medium' as const,
      sourceSeqs: [SessionSeq(0)],
    }

    // The same content twice in one pass collapses to one record.
    session.append('memory/observations-recorded', { observations: [record, record], coversUpToSeq: SessionSeq(0) })
    expect(ctx.sessionProjections.stateOf(session, 'observationalMemory')?.observations).toHaveLength(1)

    session.append('memory/observations-dropped', { observationIds: [record.id], coversUpToSeq: SessionSeq(1) })
    expect(ctx.sessionProjections.stateOf(session, 'observationalMemory')?.observations).toHaveLength(0)

    // A later pass re-recording the same content must not revive the tombstone.
    session.append('memory/observations-recorded', { observations: [record], coversUpToSeq: SessionSeq(2) })
    const state = ctx.sessionProjections.stateOf(session, 'observationalMemory')
    expect(state?.observations).toHaveLength(0)
    expect(state?.dropped.map(entry => entry.id)).toEqual([record.id])
  })

  it('ignores an event whose coverage the fold already applied', async () => {
    const store = root()
    const id = SessionId('memory-idempotent')
    const ctx = await mount(store)
    const session = ctx.sessions.create(id)
    const repeated = 'Idempotent fact.'
    const payload = {
      observations: [{
        id: memoryId(repeated),
        content: repeated,
        timestamp: '2026-01-15 14:30',
        relevance: 'low' as const,
        sourceSeqs: [SessionSeq(0)],
      }],
      coversUpToSeq: SessionSeq(0),
    }

    session.append('memory/observations-recorded', payload)
    const first = ctx.sessionProjections.stateOf(session, 'observationalMemory')
    // Re-appending the same watermark is a no-op: the state reference is reused.
    session.append('memory/observations-recorded', payload)
    expect(ctx.sessionProjections.stateOf(session, 'observationalMemory')).toBe(first)
  })
})
