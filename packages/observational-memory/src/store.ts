/**
 * The memory ledger: where memory lives now that it no longer lives in the log.
 *
 * The port originally folded three `memory/*` session events into a projection.
 * That made the ledger part of the session log, which is what made the plugin
 * undistributable: `KNOWN_SESSION_EVENT_TYPES` is generated inside the harness
 * repository, `Session.append` offers no way to mark an event `ignorable`, and
 * the persistence read path refuses to interpret a log containing an event type
 * it does not know. A session written that way is readable only by the harness
 * that declares the types.
 *
 * So the ledger is a store this plugin owns, one JSON document per session. What
 * did not change is the part that matters: the three transitions below are the
 * same pure functions the projection folded with, so dedupe, tombstones,
 * coverage watermarks, and re-application idempotence behave exactly as they did
 * when the events carried them.
 *
 * Reads are synchronous and cached. They have to be: the model-visible memory
 * block is contributed through a synchronous prompt-context callback, and
 * compaction reads the ledger while the agent is between steps. One
 * `readFileSync` per session on first touch, then memory-resident, with every
 * mutation written through atomically.
 *
 * @module @deepseek-ai/dsh-observational-memory/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { observationalMemoryStateSchema } from './vocabulary.ts'
import type { Observation, ObservationalMemoryState, Reflection } from './vocabulary.ts'

/** Environment variable naming the harness home, as the harness itself reads it. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name of the default harness home. */
const DSH_HOME_DIR_NAME = '.dsh'

/** Directory this plugin owns inside the harness home. */
const STORE_DIR_NAME = 'observational-memory'

/** Schema version of one stored ledger document. */
const STORE_VERSION = 1

/** The empty ledger a session starts from. */
export function emptyMemoryState(): ObservationalMemoryState {
  return {
    observations: [],
    dropped: [],
    reflections: [],
    coverage: { observer: null, reflector: null, dropper: null },
  }
}

/** Deduplicate records by id, first occurrence winning so replay is stable. */
function dedupeById<T extends { readonly id: string }>(records: readonly T[]): T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const record of records) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    kept.push(record)
  }
  return kept
}

/**
 * Apply one observer pass.
 *
 * Records are appended in pass order and collapse by content-addressed id, so a
 * pass that runs twice, or two passes that observe the same thing, leave one
 * record. A tombstoned id is never resurrected.
 * @param state - the ledger covering all prior passes.
 * @param observations - the observations this pass recorded.
 * @param coversUpToSeq - the source seq the pass read to.
 * @returns the next ledger, or the same reference when the pass already landed.
 */
export function applyObservations(
  state: ObservationalMemoryState,
  observations: readonly Observation[],
  coversUpToSeq: number,
): ObservationalMemoryState {
  if (state.coverage.observer === coversUpToSeq) return state
  const tombstoned = new Set(state.dropped.map(record => record.id))
  const merged = dedupeById([...state.observations, ...observations])
    .filter(record => !tombstoned.has(record.id))
  return {
    ...state,
    observations: merged,
    coverage: { ...state.coverage, observer: coversUpToSeq },
  }
}

/**
 * Apply one reflector pass.
 *
 * A reflection is a durable fact distilled from the active observations, so a
 * repeat of the same text collapses to one record and nothing is tombstoned
 * here — a reflection stays even after the observations it cites are dropped,
 * which is what keeps the provenance chain intact.
 * @param state - the ledger covering all prior passes.
 * @param reflections - the reflections this pass distilled.
 * @param coversUpToSeq - the source seq the pass read to.
 * @returns the next ledger, or the same reference when the pass already landed.
 */
export function applyReflections(
  state: ObservationalMemoryState,
  reflections: readonly Reflection[],
  coversUpToSeq: number,
): ObservationalMemoryState {
  if (state.coverage.reflector === coversUpToSeq) return state
  return {
    ...state,
    reflections: dedupeById([...state.reflections, ...reflections]),
    coverage: { ...state.coverage, reflector: coversUpToSeq },
  }
}

/**
 * Apply one dropper pass.
 *
 * Dropping is a tombstone, never an erase: the record moves from the active
 * pool to `dropped`, where recall and the explorer still resolve it by id.
 * @param state - the ledger covering all prior passes.
 * @param observationIds - the observations this pass removed from the active pool.
 * @param coversUpToSeq - the source seq the pass read to.
 * @returns the next ledger, or the same reference when the pass already landed.
 */
export function applyDrops(
  state: ObservationalMemoryState,
  observationIds: readonly string[],
  coversUpToSeq: number,
): ObservationalMemoryState {
  if (state.coverage.dropper === coversUpToSeq) return state
  const tombstoned = new Set(observationIds)
  return {
    ...state,
    observations: state.observations.filter(record => !tombstoned.has(record.id)),
    dropped: [...state.dropped, ...state.observations.filter(record => tombstoned.has(record.id))],
    coverage: { ...state.coverage, dropper: coversUpToSeq },
  }
}

/**
 * Resolve the harness home the way the harness does.
 *
 * Reimplemented here rather than imported: the harness's home-path utility is
 * not published, and a plugin that installs from npm cannot depend on it.
 * @param env - the environment to read; defaults to the process environment.
 * @returns the absolute harness home.
 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env[DSH_HOME_ENV]
  if (configured !== undefined && configured.length > 0) return configured
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * The directory one ledger per session is written to.
 * @param storageDir - an explicit directory from configuration, when set.
 * @returns the absolute storage directory.
 */
export function resolveStorageDir(storageDir?: string): string {
  return storageDir !== undefined && storageDir.length > 0
    ? storageDir
    : join(resolveDshHome(), STORE_DIR_NAME)
}

/** Everything the store needs from its host. */
export interface MemoryStoreHost {
  /** Absolute directory holding one ledger file per session. */
  readonly storageDir: string
  /** Diagnostic sink for a ledger that exists but cannot be read back. */
  warn(message: string): void
}

/** One stored ledger document. */
interface StoredLedger {
  readonly version: number
  readonly state: ObservationalMemoryState
}

/**
 * The per-session memory ledger.
 *
 * State is cached per session and written through on every mutation, so a
 * reader never sees a partial pass and a resumed process re-reads exactly what
 * the last pass stored. The store is created per plugin instance and published
 * on the context, which is what keeps two applications in one process from
 * sharing a ledger — and what lets tests mount the plugin repeatedly without
 * leaking state between mounts.
 */
export class MemoryStore {
  private readonly cache = new Map<string, ObservationalMemoryState>()

  /**
   * @param host - where ledgers are stored and where read failures are reported.
   */
  constructor(private readonly host: MemoryStoreHost) {}

  /**
   * Read one session's ledger, loading it from disk on first touch.
   * @param sessionId - the session whose ledger to read.
   * @returns the ledger; an empty one when nothing has been stored yet.
   */
  state(sessionId: string): ObservationalMemoryState {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached
    const loaded = this.load(sessionId)
    this.cache.set(sessionId, loaded)
    return loaded
  }

  /**
   * Record one observer pass and persist the result.
   * @param sessionId - the session the pass belongs to.
   * @param observations - the observations the pass recorded.
   * @param coversUpToSeq - the source seq the pass read to.
   * @returns the ledger after the pass.
   */
  recordObservations(
    sessionId: string,
    observations: readonly Observation[],
    coversUpToSeq: number,
  ): ObservationalMemoryState {
    return this.commit(sessionId, state => applyObservations(state, observations, coversUpToSeq))
  }

  /**
   * Record one reflector pass and persist the result.
   * @param sessionId - the session the pass belongs to.
   * @param reflections - the reflections the pass distilled.
   * @param coversUpToSeq - the source seq the pass read to.
   * @returns the ledger after the pass.
   */
  recordReflections(
    sessionId: string,
    reflections: readonly Reflection[],
    coversUpToSeq: number,
  ): ObservationalMemoryState {
    return this.commit(sessionId, state => applyReflections(state, reflections, coversUpToSeq))
  }

  /**
   * Record one dropper pass and persist the result.
   * @param sessionId - the session the pass belongs to.
   * @param observationIds - the observations the pass tombstoned.
   * @param coversUpToSeq - the source seq the pass read to.
   * @returns the ledger after the pass.
   */
  recordDrops(
    sessionId: string,
    observationIds: readonly string[],
    coversUpToSeq: number,
  ): ObservationalMemoryState {
    return this.commit(sessionId, state => applyDrops(state, observationIds, coversUpToSeq))
  }

  /**
   * Forget one session's cached ledger.
   *
   * The file is left in place — this is a cache eviction, not a delete — so a
   * later read reloads exactly what was last stored.
   * @param sessionId - the session to evict.
   */
  forget(sessionId: string): void {
    this.cache.delete(sessionId)
  }

  /** Apply one transition and write the result through, skipping a no-op pass. */
  private commit(
    sessionId: string,
    transition: (state: ObservationalMemoryState) => ObservationalMemoryState,
  ): ObservationalMemoryState {
    const before = this.state(sessionId)
    const after = transition(before)
    if (after === before) return before
    this.cache.set(sessionId, after)
    this.persist(sessionId, after)
    return after
  }

  /** Absolute path of one session's ledger file. */
  private fileFor(sessionId: string): string {
    // The session id is an opaque identifier, so it is percent-encoded rather
    // than pattern-matched: a separator or a traversal segment in an id would
    // otherwise choose the file this store writes to.
    return join(this.host.storageDir, `${encodeURIComponent(sessionId)}.json`)
  }

  /** Read one ledger from disk, treating absent as empty and corrupt as warned. */
  private load(sessionId: string): ObservationalMemoryState {
    const file = this.fileFor(sessionId)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      // Absent is the normal first-run case. Anything else is worth saying out
      // loud, because it silently costs the session its memory.
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.host.warn(`observational-memory: cannot read ${file}: ${String(error)}`)
      }
      return emptyMemoryState()
    }
    try {
      const stored = JSON.parse(raw) as StoredLedger
      if (stored.version !== STORE_VERSION) {
        this.host.warn(
          `observational-memory: ${file} was written by store version ${String(stored.version)}; ignoring it`,
        )
        return emptyMemoryState()
      }
      return observationalMemoryStateSchema.parse(stored.state) as ObservationalMemoryState
    } catch (error) {
      this.host.warn(`observational-memory: ${file} is not a readable ledger: ${String(error)}`)
      return emptyMemoryState()
    }
  }

  /** Write one ledger through a temporary file so a reader never sees a partial document. */
  private persist(sessionId: string, state: ObservationalMemoryState): void {
    const file = this.fileFor(sessionId)
    const document: StoredLedger = { version: STORE_VERSION, state }
    try {
      mkdirSync(this.host.storageDir, { recursive: true })
      const temporary = `${file}.tmp`
      writeFileSync(temporary, `${JSON.stringify(document)}\n`, 'utf8')
      renameSync(temporary, file)
    } catch (error) {
      this.host.warn(`observational-memory: cannot write ${file}: ${String(error)}`)
    }
  }
}
