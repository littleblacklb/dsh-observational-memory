/**
 * Observational memory: keeps a long session coherent by recording what
 * happened while the work is still live, then rendering that memory
 * deterministically when compaction runs, so compaction never has to ask a
 * model to rewrite the past.
 *
 * @module @deepseek-ai/dsh-observational-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import { Config, resolveConfig, resolveObserverChunkTokens, resolveThreshold } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import type { Observation } from './vocabulary.ts'
import { observerCoverage, runObserver, selectObserverChunk, uncoveredTokens } from './observer.ts'
import { runDropper } from './dropper.ts'
import { reflectorCoverage, reflectorInputs, runReflector } from './reflector.ts'
import { MemoryStore, resolveStorageDir } from './store.ts'
import type { ObservationalMemoryState } from './vocabulary.ts'
import { createObservationSourceProjection } from './source.ts'
import { registerOmCommands } from './commands.ts'
import { registerMemoryContext } from './context.ts'
import { MemoryStatus } from './status.ts'
import type { ObservationSourceEntry } from './source.ts'

export { Config }
export type { Config as ObservationalMemoryConfig }

/**
 * The memory vocabulary and helpers a companion package needs.
 *
 * Re-exported here so a consumer imports the package root rather than a source
 * subpath: the tool package that implements `memory_recall` reads these without
 * reaching into this package's internals.
 */
export {
  MEMORY_ID_PATTERN,
  coverageOf,
  OBSERVATION_TIMESTAMP_PATTERN,
  RELEVANCE_ORDER,
} from './vocabulary.ts'
export type { CoverageTier, Observation, Reflection, Relevance } from './vocabulary.ts'
export { observationalMemoryStateSchema } from './vocabulary.ts'
export { formatObservationTimestamp, memoryId } from './model.ts'
export type { ObservationalMemoryState } from './vocabulary.ts'
export { citedSourceSeqs, resolveMemoryId } from './recall.ts'
export type { RecallResult, RecalledObservation } from './recall.ts'
export { renderMemory } from './render.ts'
export {
  applyDrops, applyObservations, applyReflections, emptyMemoryState,
  MemoryStore, resolveDshHome, resolveStorageDir,
} from './store.ts'
export type { MemoryStoreHost } from './store.ts'

/**
 * The ledger store one mounted plugin publishes for its sibling rows.
 *
 * The compaction engine is mounted as its own loader row by the same bundle
 * patch, so it cannot reach this plugin's closure. Publishing the store on the
 * context is what lets the engine read the same ledger — and what keeps two
 * applications in one process, or two mounts in one test file, from sharing one.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The observational-memory ledger, provided by this plugin. */
    observationalMemoryStore: MemoryStore
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'observational-memory'

/**
 * Services required for memory to be recorded.
 *
 * `llm` is deliberately absent: the ledger is useful without any model route, so
 * the plugin must not stay PENDING on a deployment that has no LLM service. Only
 * the observer waits for it, through its own injection. `sessionProjections`
 * stays because the observer's input surface and the context window are both
 * folds over events the harness itself owns.
 */
export const inject = ['sessions', 'sessionProjections']

/**
 * Read the session's context window from the token meter's durable projection.
 *
 * The value comes from the `request/context` event rather than an async model
 * resolution, so cadence can be computed synchronously during a turn boundary.
 * @param ctx - context carrying the projection registry.
 * @param session - the session to read.
 * @returns the window in tokens, or undefined when no route has advertised one.
 */
function contextWindowOf(ctx: Context, session: Session): number | undefined {
  const pressure = ctx.sessionProjections.stateOf(session, 'contextPressure') as
    | { contextWindow?: number }
    | undefined
  const window = pressure?.contextWindow
  return window !== undefined && Number.isFinite(window) && window > 0 ? window : undefined
}

/**
 * Read the observer's coverage watermark, which the later passes inherit.
 *
 * The reflector and dropper run only after an observation exists, and the
 * observer is the only writer of observations, so its watermark is always set
 * by the time either reads it.
 * @param state - the folded memory state.
 * @returns the observer's coverage watermark.
 */
function observerWatermark(state: ObservationalMemoryState): number {
  return state.coverage.observer as number
}

/**
 * Read the session's memory ledger.
 *
 * The store is published on the context by {@link apply}, so it is present for
 * as long as any of this code can run: the read is synchronous and cached, which
 * is what lets the model-visible context block and the compaction renderer read
 * memory without awaiting anything.
 * @param ctx - context carrying the published store.
 * @param session - the session to read.
 * @returns the ledger for that session.
 */
function memoryOf(ctx: Context, session: Session): ObservationalMemoryState {
  return ctx.observationalMemoryStore.state(session.id)
}

/**
 * Resolve one conversation seq as the observer saw it.
 *
 * The human `/om show` view reports sources from the observer's own fold rather
 * than re-reading the log, so a source is shown exactly as it was read when the
 * observation was recorded.
 * @param ctx - context carrying the projection registry.
 * @param session - the session whose surface to search.
 * @param seq - the cited source seq.
 * @returns the entry's role and text, or undefined when the fold does not hold it.
 */
export function sourceEntryAt(
  ctx: Context,
  session: Session,
  seq: number,
): { role: string; text: string } | undefined {
  const entry = sourceOf(ctx, session).find(candidate => candidate.seq === seq)
  return entry === undefined ? undefined : { role: entry.role, text: entry.text }
}

/**
 * Read the session's conversation surface.
 * @param ctx - context carrying the projection registry.
 * @param session - the session to read.
 * @returns the observer's input entries, in log order.
 */
function sourceOf(ctx: Context, session: Session): ObservationSourceEntry[] {
  return (ctx.sessionProjections.stateOf(session, 'observationSource') as { entries: ObservationSourceEntry[] }).entries
}

/** Resolve the model route a worker should use, falling back to the session's routed model. */
function workerTarget(
  config: ResolvedConfig,
  session: Session,
): { provider: string; model: string; reasoningEffort?: string } | undefined {
  // A configured override wins, but only when it actually names a route: the
  // The schema always materializes `model`, so a present object is not the
  // same as a populated one: only a complete route counts as an override.
  const { provider, model, reasoningEffort } = config.model
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
    return { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
  }
  const route = session.requestHeader()?.config
  if (route === undefined || route.provider.length === 0 || route.model.length === 0) return undefined
  return { provider: route.provider, model: route.model }
}

/**
 * Plugin body: register the memory folds and the background observer.
 *
 * Background work runs off the post-commit `session/event` feed, never on the
 * turn boundary itself, so a slow or failing memory pass can neither block nor
 * fail the conversation. Every registration and the in-flight bookkeeping are
 * effects of this plugin's fiber, so unloading the plugin aborts its work
 * cleanly.
 * @param ctx - context carrying sessions, projections, and the LLM service.
 * @param config - loader-validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)

  // The ledger is this plugin's own store, published on the context so the
  // compaction engine's separately-mounted row reads the same one. The
  // observation surface stays a projection: it folds conversation events the
  // harness itself declares, so it costs nothing and needs no storage.
  const store = new MemoryStore({
    storageDir: resolveStorageDir(resolved.storageDir),
    warn: message => { ctx.logger.warn(message) },
  })
  ctx.reflect.provide('observationalMemoryStore', store)
  ctx.sessionProjections.register(createObservationSourceProjection())

  // The human view is registered only where a command registry exists, so the
  // ledger and its fold stay usable in a headless assembly.
  ctx.inject(['commands'], (commandCtx) => {
    registerOmCommands(commandCtx, {
      memoryOf: agent => memoryOf(ctx, agent.session),
      sourceEntry: (agent, seq) => sourceEntryAt(ctx, agent.session, seq),
      targetTokens: resolved.observationsPoolTargetTokens,
      observeAfterTokens: resolved.observeAfterTokens,
      reflectAfterTokens: resolved.reflectAfterTokens,
      passive: resolved.passive,
      status,
    })
  })

  const lifetime = new AbortController()
  const inFlight = new Set<Promise<unknown>>()
  const consolidating = new Set<Session>()
  const warnedNoRoute = new Set<Session>()
  const status = new MemoryStatus()

  // Memory reaches the model between compactions through this contribution,
  // which the loop logs as a deduplicated snapshot: unchanged memory adds
  // nothing to the request. It activates only where a prompt registry exists,
  // so the ledger and its fold stay usable without one.
  // The inject fiber owns the contribution's lifetime, so the registration is
  // made directly: the registry's own effect disposes it when this plugin
  // unloads.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    registerMemoryContext(promptCtx)
  })

  ctx.effect(() => async () => {
    lifetime.abort(new Error('observational-memory disposed'))
    await Promise.allSettled([...inFlight])
  }, 'observational-memory: background work')

  // Only the workers need a model route, so they activate separately. A
  // deployment with no LLM service keeps the ledger and its fold (including
  // memory written by another process) instead of losing them.
  ctx.inject(['llm'], (llmCtx) => {
    /**
     * Resolve the route, warning once per session when nothing can record.
     * @param session - the session a pass would run for.
     * @returns the route to use, or undefined when none is available.
     */
    const routeFor = (session: Session): { provider: string; model: string } | undefined => {
      const target = workerTarget(resolved, session)
      if (target !== undefined) return target
      // Nothing records memory without a route, so say so once per session
      // rather than leaving the user to wonder why memory stays empty.
      if (!warnedNoRoute.has(session)) {
        warnedNoRoute.add(session)
        llmCtx.logger.warn(
          'observational-memory: no model route for memory work yet; configure `model` or send one request so the session records its route',
        )
      }
      return undefined
    }

    /**
     * Run one observer pass when its cadence is due.
     * @param session - the session to observe.
     * @param target - the resolved memory route.
     */
    const observeIfDue = async (session: Session, target: { provider: string; model: string }): Promise<void> => {
      const state = memoryOf(ctx, session)
      const entries = sourceOf(ctx, session)
      const window = contextWindowOf(ctx, session)
      const covered = observerCoverage(state)
      const threshold = resolveThreshold(resolved.observeAfterRatio, resolved.observeAfterTokens, window)
      if (uncoveredTokens(entries, covered) < threshold) return

      // The token check above already proved the uncovered range is non-empty
      // and the threshold is positive, so chunk selection always yields a
      // non-empty chunk with a watermark: there is no exhausted case to guard.
      const chunkTokens = resolveObserverChunkTokens(resolved.observerChunkMaxTokens, window)
      const { chunk, coversUpToSeq } = selectObserverChunk(entries, covered, chunkTokens)
      const run = await runObserver({
        llm: llmCtx.llm as never,
        provider: target.provider,
        model: target.model,
        chunk,
        coversUpToSeq: coversUpToSeq as number,
        signal: lifetime.signal,
        nowMs: Date.now(),
        ...resolved.workerMaxTokens === undefined ? {} : { maxTokens: resolved.workerMaxTokens },
      })
      reportRejections('observer', run.rejections)
      if (run.failure !== undefined) {
        status.record('observer', { failed: run.failure })
        llmCtx.logger.warn(`observational-memory: observer pass failed: ${run.failure}`)
        return
      }
      status.record('observer', { recorded: run.observations.length, rejected: run.rejections.length })
      if (run.observations.length === 0) return
      ctx.observationalMemoryStore.recordObservations(
        session.id,
        run.observations as Observation[],
        run.coversUpToSeq,
      )
    }

    /**
     * Run one reflector pass when its cadence is due.
     *
     * The pass is due on source tokens accumulated since the last reflection,
     * and it reviews every active observation rather than only new ones, because
     * a durable fact can become visible once later observations give it context.
     * @param session - the session to reflect on.
     * @param target - the resolved memory route.
     * @returns whether this pass recorded any reflection.
     */
    const reflectIfDue = async (session: Session, target: { provider: string; model: string }): Promise<boolean> => {
      const state = memoryOf(ctx, session)
      if (state.observations.length === 0) return false
      const window = contextWindowOf(ctx, session)
      const threshold = resolveThreshold(resolved.reflectAfterRatio, resolved.reflectAfterTokens, window)
      const entries = sourceOf(ctx, session)
      if (uncoveredTokens(entries, reflectorCoverage(state)) < threshold) return false

      const run = await runReflector({
        llm: llmCtx.llm as never,
        provider: target.provider,
        model: target.model,
        inputs: reflectorInputs(state.observations, state.reflections),
        existing: state.reflections,
        signal: lifetime.signal,
        ...resolved.workerMaxTokens === undefined ? {} : { maxTokens: resolved.workerMaxTokens },
      })
      reportRejections('reflector', run.rejections)
      if (run.failure !== undefined) {
        status.record('reflector', { failed: run.failure })
        llmCtx.logger.warn(`observational-memory: reflector pass failed: ${run.failure}`)
        return false
      }
      status.record('reflector', { recorded: run.reflections.length, rejected: run.rejections.length })
      if (run.reflections.length === 0) return false
      // The watermark is the observer's coverage as of this pass, not this
      // pass's own progress: it records which observations were reviewed. It is
      // read after the pass so it reflects any observation this consolidation
      // recorded before the reflector ran.
      const observerMark = observerWatermark(memoryOf(ctx, session))
      ctx.observationalMemoryStore.recordReflections(session.id, run.reflections, observerMark)
      return true
    }

    /**
     * Run one dropper pass when the active pool is over target.
     *
     * This runs only after a reflection pass recorded something in this same
     * consolidation, because fresh reflections are the evidence that makes a
     * removal safe.
     * @param session - the session to prune.
     * @param target - the resolved memory route.
     */
    const dropIfOverTarget = async (session: Session, target: { provider: string; model: string }): Promise<void> => {
      const state = memoryOf(ctx, session)
      const run = await runDropper({
        llm: llmCtx.llm as never,
        provider: target.provider,
        model: target.model,
        observations: state.observations,
        reflections: state.reflections,
        targetTokens: resolved.observationsPoolTargetTokens,
        signal: lifetime.signal,
        ...resolved.workerMaxTokens === undefined ? {} : { maxTokens: resolved.workerMaxTokens },
      })
      if (run.failure !== undefined) {
        status.record('dropper', { failed: run.failure })
        llmCtx.logger.warn(`observational-memory: dropper pass failed: ${run.failure}`)
        return
      }
      status.record('dropper', { recorded: run.droppedIds.length, rejected: 0 })
      if (run.droppedIds.length === 0) return
      const observerMark = observerWatermark(memoryOf(ctx, session))
      ctx.observationalMemoryStore.recordDrops(session.id, run.droppedIds, observerMark)
    }

    /**
     * Report records a pass proposed that validation rejected.
     * @param stage - the worker name, for the log line.
     * @param rejections - the rejections this pass produced.
     */
    const reportRejections = (stage: string, rejections: readonly { reason: string }[]): void => {
      if (rejections.length === 0) return
      llmCtx.logger.warn(
        `observational-memory: ${stage} rejected ${String(rejections.length)} record(s): ${rejections[0]!.reason}`,
      )
    }

    /**
     * Run one consolidation: observe, then reflect, then prune.
     *
     * The stages are sequential on purpose. An observer pass that appends
     * observations can make the reflector due in the same consolidation, and the
     * dropper must see the reflections the same consolidation just recorded.
     * @param session - the session to consolidate.
     */
    const consolidate = async (session: Session): Promise<void> => {
      const target = routeFor(session)
      if (target === undefined) return
      const started = Date.now()
      await observeIfDue(session, target)
      if (!await reflectIfDue(session, target)) return
      await dropIfOverTarget(session, target)
      status.finishRun(Date.now() - started)
    }

    llmCtx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      if (resolved.passive || consolidating.has(session) || lifetime.signal.aborted) return
      // A memory failure must never surface as an unhandled rejection, and it
      // must never escape silently either: this is a contained background pass,
      // so it reports and stops.
      const run = Promise.resolve()
        .then(() => {
          consolidating.add(session)
          return consolidate(session)
        })
        .catch((error: unknown) => {
          llmCtx.logger.warn(
            `observational-memory: memory pass threw: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        .finally(() => {
          consolidating.delete(session)
          inFlight.delete(run)
        })
      inFlight.add(run)
    })
  })
}