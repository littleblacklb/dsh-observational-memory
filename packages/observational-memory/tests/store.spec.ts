/**
 * The memory ledger store: its three transitions and its durability.
 *
 * The transitions are pure, so they are exercised directly — dedupe, tombstones,
 * watermarks, and the idempotence guards — without standing up a session. The
 * store around them is then tested for the things a file-backed ledger has to get
 * right: a pass that lands survives a reload, a document that cannot be read
 * costs a warning rather than silence, and one session's ledger is never another's.
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { memoryId } from '../src/model.ts'
import type { Observation, Reflection } from '../src/model.ts'
import {
  applyDrops, applyObservations, applyReflections, emptyMemoryState,
  MemoryStore, resolveDshHome, resolveStorageDir,
} from '../src/store.ts'
import type { ObservationalMemoryState } from '../src/vocabulary.ts'
import { observationalMemoryStateSchema } from '../src/vocabulary.ts'

function observation(content: string): Observation {
  return {
    id: memoryId(content),
    content,
    timestamp: '2026-01-15 14:30',
    relevance: 'medium',
    sourceSeqs: [0],
  }
}

function reflection(content: string, supporting: string[] = ['aaaa11112222']): Reflection {
  return { id: memoryId(content), content, supportingObservationIds: supporting }
}

/** A store writing into its own fresh directory, with warnings captured. */
function bench(): { store: MemoryStore; dir: string; warn: ReturnType<typeof vi.fn> } {
  const dir = mkdtempSync(join(tmpdir(), 'om-store-'))
  const warn = vi.fn()
  return { store: new MemoryStore({ storageDir: dir, warn }), dir, warn }
}

describe('memory transitions', () => {
  it('starts empty', () => {
    expect(emptyMemoryState()).toEqual({
      observations: [],
      dropped: [],
      reflections: [],
      coverage: { observer: null, reflector: null, dropper: null },
    })
  })

  it('records observations and advances the observer watermark', () => {
    const next = applyObservations(emptyMemoryState(), [observation('a fact')], 7)
    expect(next.observations).toHaveLength(1)
    expect(next.coverage.observer).toBe(7)
  })

  it('collapses duplicate observations within one pass', () => {
    const record = observation('a fact')
    expect(applyObservations(emptyMemoryState(), [record, record], 1).observations).toHaveLength(1)
  })

  it('is idempotent for an observer pass whose watermark it already applied', () => {
    const state = applyObservations(emptyMemoryState(), [observation('a fact')], 3)
    expect(applyObservations(state, [], 3)).toBe(state)
  })

  it('never resurrects a tombstoned observation', () => {
    const record = observation('a fact')
    const dropped = applyDrops(
      applyObservations(emptyMemoryState(), [record], 1),
      [record.id],
      1,
    )
    expect(applyObservations(dropped, [record], 2).observations).toEqual([])
  })

  it('records reflections and advances the reflector watermark', () => {
    const record = reflection('fact')
    const next = applyReflections(emptyMemoryState(), [record], 7)
    expect(next.reflections).toEqual([record])
    expect(next.coverage.reflector).toBe(7)
  })

  it('collapses duplicate reflections within one pass', () => {
    const record = reflection('fact')
    expect(applyReflections(emptyMemoryState(), [record, record], 1).reflections).toHaveLength(1)
  })

  it('is idempotent for a reflector pass whose watermark it already applied', () => {
    const state = applyReflections(emptyMemoryState(), [reflection('fact')], 3)
    expect(applyReflections(state, [], 3)).toBe(state)
  })

  it('splits active observations from tombstones and advances the dropper watermark', () => {
    const kept = observation('kept')
    const removed = observation('removed')
    const recorded = applyObservations(emptyMemoryState(), [kept, removed], 0)
    const next = applyDrops(recorded, [removed.id, 'ffffffffffff'], 2)
    expect(next.observations).toEqual([kept])
    expect(next.dropped).toEqual([removed])
    expect(next.coverage.dropper).toBe(2)
  })

  it('is idempotent for a dropper pass whose watermark it already applied', () => {
    const state = applyDrops(emptyMemoryState(), [], 4)
    expect(applyDrops(state, ['aaaa11112222'], 4)).toBe(state)
  })

  it('leaves a reflection in place after the observations it cites are dropped', () => {
    // A reflection outlives its evidence: that is what keeps the provenance
    // chain resolvable for recall after pruning.
    const record = observation('a fact')
    const recorded = applyObservations(emptyMemoryState(), [record], 1)
    const reflected = applyReflections(recorded, [reflection('fact', [record.id])], 1)
    const dropped = applyDrops(reflected, [record.id], 1)
    expect(dropped.reflections).toEqual([reflection('fact', [record.id])])
    expect(dropped.dropped).toEqual([record])
  })

  it('produces a state the vocabulary schema accepts', () => {
    const state = applyReflections(
      applyObservations(emptyMemoryState(), [observation('a fact')], 1),
      [reflection('fact')],
      1,
    )
    expect(observationalMemoryStateSchema.parse(state)).toEqual(state)
  })

  it('rejects a state that does not match the schema', () => {
    expect(() => observationalMemoryStateSchema.parse({ observations: 'nope' })).toThrow()
  })
})

describe('memory store durability', () => {
  it('persists a pass and reads it back through a fresh store', () => {
    const { store, dir } = bench()
    store.recordObservations('session-1', [observation('a fact')], 4)

    const reopened = new MemoryStore({ storageDir: dir, warn: vi.fn() })
    const state = reopened.state('session-1')
    expect(state.observations.map(record => record.content)).toEqual(['a fact'])
    expect(state.coverage.observer).toBe(4)
  })

  it('answers with empty memory for a session nothing was ever stored for', () => {
    const { store, warn } = bench()
    expect(store.state('never-seen')).toEqual(emptyMemoryState())
    // An absent ledger is the normal first-run case, not a diagnostic.
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves no temporary file behind after a write', () => {
    const { store, dir } = bench()
    store.recordObservations('session-1', [observation('a fact')], 1)
    expect(readdirSync(dir)).toEqual(['session-1.json'])
  })

  it('keeps one session isolated from another', () => {
    const { store } = bench()
    store.recordObservations('session-a', [observation('a fact')], 1)
    expect(store.state('session-b').observations).toEqual([])
  })

  it('reloads from disk after the cached ledger is forgotten', () => {
    const { store } = bench()
    store.recordObservations('session-1', [observation('a fact')], 1)
    store.forget('session-1')
    expect(store.state('session-1').observations).toHaveLength(1)
  })

  it('encodes a session id rather than letting it choose the file path', () => {
    // A separator in an id must not escape the storage directory.
    const { store, dir } = bench()
    store.recordObservations('../escape', [observation('a fact')], 1)
    expect(readdirSync(dir)).toEqual(['..%2Fescape.json'])
  })

  it('warns and starts empty when a stored document is not JSON', () => {
    const { store, dir, warn } = bench()
    writeFileSync(join(dir, 'session-1.json'), 'not json at all')
    expect(store.state('session-1')).toEqual(emptyMemoryState())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a readable ledger'))
  })

  it('warns and starts empty when a stored document is from another store version', () => {
    const { store, dir, warn } = bench()
    writeFileSync(join(dir, 'session-1.json'), JSON.stringify({ version: 99, state: emptyMemoryState() }))
    expect(store.state('session-1')).toEqual(emptyMemoryState())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('store version 99'))
  })

  it('warns and starts empty when a stored document fails the state schema', () => {
    const { store, dir, warn } = bench()
    writeFileSync(join(dir, 'session-1.json'), JSON.stringify({ version: 1, state: { observations: 'nope' } }))
    expect(store.state('session-1')).toEqual(emptyMemoryState())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a readable ledger'))
  })

  it('warns when a ledger exists but cannot be read at all', () => {
    // A path component that is a file rather than a directory reports ENOTDIR,
    // which is not the absent case and must not pass silently.
    const dir = mkdtempSync(join(tmpdir(), 'om-store-'))
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, '')
    const warn = vi.fn()
    const store = new MemoryStore({ storageDir: join(blocker, 'nested'), warn })
    expect(store.state('session-1')).toEqual(emptyMemoryState())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot read'))
  })

  it('warns rather than throwing when the ledger cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'om-store-'))
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, '')
    const warn = vi.fn()
    const store = new MemoryStore({ storageDir: join(blocker, 'nested'), warn })
    store.recordObservations('session-1', [observation('a fact')], 1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot write'))
    // The pass is still live in memory, so the session keeps its memory for as
    // long as the process runs.
    expect(store.state('session-1').observations).toHaveLength(1)
  })

  it('skips the write entirely for a pass that changes nothing', () => {
    const { store, dir } = bench()
    store.recordObservations('session-1', [observation('a fact')], 1)
    const before = readFileSync(join(dir, 'session-1.json'), 'utf8')
    store.recordObservations('session-1', [], 1)
    expect(readFileSync(join(dir, 'session-1.json'), 'utf8')).toBe(before)
  })

  it('records reflections and drops through the store', () => {
    const { store, dir } = bench()
    const record = observation('a fact')
    store.recordObservations('session-1', [record], 1)
    store.recordReflections('session-1', [reflection('fact')], 1)
    store.recordDrops('session-1', [record.id], 1)

    const state = new MemoryStore({ storageDir: dir, warn: vi.fn() }).state('session-1')
    expect(state.reflections).toHaveLength(1)
    expect(state.observations).toEqual([])
    expect(state.dropped).toEqual([record])
  })
})

describe('storage location', () => {
  it('prefers an explicitly configured harness home', () => {
    expect(resolveDshHome({ DSH_HOME: '/tmp/custom-home' })).toBe('/tmp/custom-home')
  })

  it('falls back to the harness home directory name in the user home', () => {
    expect(resolveDshHome({})).toBe(join(homedir(), '.dsh'))
  })

  it('treats an empty harness home as unset rather than as the filesystem root', () => {
    expect(resolveDshHome({ DSH_HOME: '' })).toBe(join(homedir(), '.dsh'))
  })

  it('uses the configured directory when one is set', () => {
    expect(resolveStorageDir('/tmp/ledgers')).toBe('/tmp/ledgers')
  })

  it('defaults to a plugin-owned directory inside the harness home', () => {
    expect(resolveStorageDir()).toBe(join(resolveDshHome(), 'observational-memory'))
    expect(resolveStorageDir('')).toBe(join(resolveDshHome(), 'observational-memory'))
  })
})

describe('state shape', () => {
  it('is the shape the schema declares', () => {
    const state: ObservationalMemoryState = emptyMemoryState()
    expect(observationalMemoryStateSchema.parse(state)).toEqual(state)
  })
})
